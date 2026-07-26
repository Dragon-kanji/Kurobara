import assert from "node:assert/strict";
import test from "node:test";

import {
  actorId,
  capabilityId,
  contentHash,
  instant,
  runPlanId,
  workflowSpecId,
  workspaceId,
} from "@kurobara/kernel";
import type {
  AuthoritySnapshot,
  CapabilityRouteCatalogPort,
  InputContractValidatorPort,
  PersistRunPlanInput,
  PlanningDefaults,
  PlanningIdentifierPort,
  PlanningPersistencePort,
  PlanningUnitOfWork,
  PolicyPlanningSnapshot,
  PricingSnapshot,
  VerifiedApiKey,
  WorkflowSnapshot,
  WorkflowSnapshotIdentity,
  WorkspaceScope,
} from "@kurobara/ports";

import { canonicalContentHash } from "../src/canonical-content-hash.ts";
import { makeQuoteRunPlan, type QuoteRunPlanRequest } from "../src/index.ts";

const hash = (value: string) =>
  contentHash(`sha256:${value.repeat(64).slice(0, 64)}`);
const workspace = workspaceId("workspace-test");
const otherWorkspace = workspaceId("workspace-other");
const capability = {
  capabilityId: capabilityId("documents.summarize"),
  capabilityVersion: "1.0.0",
};
const contract = {
  catalogFingerprint: hash("a"),
  catalogVersion: "1.0.0",
  schemaFingerprint: hash("b"),
  schemaId: "https://schemas.kurobara.dev/schemas/document/1.0.0",
  schemaVersion: "1.0.0",
};

const actor: VerifiedApiKey = {
  actorId: actorId("actor-test"),
  authenticationMode: "api-key",
  credentialId: "credential-test",
  permissions: ["plans:quote"],
  workspaceId: workspace,
};

const authority = (
  overrides: Partial<AuthoritySnapshot> = {}
): AuthoritySnapshot => ({
  authorityEnvelopeId: "authority-test",
  budgetLimit: { limit: 20, reserved: 2, spent: 3, unit: "credits" },
  capabilities: [capability],
  deadline: instant(20_000),
  permissions: ["plans:quote"],
  subjectActorId: actor.actorId,
  version: "1.0.0",
  workspaceId: workspace,
  ...overrides,
});

const workflow = (
  overrides: Partial<WorkflowSnapshot> = {}
): WorkflowSnapshot => ({
  allowedCapabilities: [capability.capabilityId],
  catalogFingerprint: contract.catalogFingerprint,
  catalogVersion: contract.catalogVersion,
  compilationLimits: { maxDepth: 2, maxFanOut: 2, maxNodes: 2 },
  compilerVersion: "1.0.0",
  inputContract: contract,
  outputContract: {
    ...contract,
    schemaId: "https://schemas.kurobara.dev/schemas/summary/1.0.0",
  },
  workflow: {
    contentHash: hash("c"),
    nodes: [{ capability, dependsOn: [], key: "summarize" }],
    revision: "1.0.0",
    workflowSpecId: workflowSpecId("workflow-test"),
  },
  workspaceId: workspace,
  ...overrides,
});

const policy = (
  overrides: Partial<PolicyPlanningSnapshot> = {}
): PolicyPlanningSnapshot => ({
  policy: {
    factsHash: hash("d"),
    maxAttemptsPerStep: 3,
    requiredPermission: "plans:quote",
    version: "1.0.0",
  },
  snapshotId: "policy-test",
  workspaceId: workspace,
  ...overrides,
});

const pricing = (
  overrides: Partial<PricingSnapshot> = {}
): PricingSnapshot => ({
  guarantee: "hard",
  snapshotId: "pricing-test",
  ttlMilliseconds: 5000,
  unit: "credits",
  upperBound: 5,
  version: "1.0.0",
  workspaceId: workspace,
  ...overrides,
});

const defaults: PlanningDefaults = {
  policySnapshotId: "policy-test",
  pricingSnapshotId: "pricing-test",
  workspaceId: workspace,
};

type FakePlanningOptions = Readonly<{
  authority?: AuthoritySnapshot | null;
  defaults?: PlanningDefaults | null;
  policy?: PolicyPlanningSnapshot | null;
  pricing?: PricingSnapshot | null;
  workflow?: WorkflowSnapshot | null;
}>;

class FakePlanningPersistence implements PlanningPersistencePort {
  readonly lookupOrder: string[] = [];
  readonly inserted: PersistRunPlanInput[] = [];
  readonly options: FakePlanningOptions;
  transactionCalls = 0;
  workflowIdentity: WorkflowSnapshotIdentity | undefined;

  constructor(options: FakePlanningOptions = {}) {
    this.options = options;
  }

  transaction<Value>(
    _scope: WorkspaceScope,
    work: (unitOfWork: PlanningUnitOfWork) => Promise<Value>
  ): Promise<Value> {
    this.transactionCalls += 1;
    return work({
      runPlans: {
        insert: (_insertScope, input) => {
          this.inserted.push(input);
          return Promise.resolve();
        },
      },
      snapshots: {
        getAuthority: () => {
          this.lookupOrder.push("authority");
          return Promise.resolve(
            this.options.authority === null
              ? undefined
              : (this.options.authority ?? authority())
          );
        },
        getDefaults: () => {
          this.lookupOrder.push("defaults");
          return Promise.resolve(
            this.options.defaults === null
              ? undefined
              : (this.options.defaults ?? defaults)
          );
        },
        getPolicy: () => {
          this.lookupOrder.push("policy");
          return Promise.resolve(
            this.options.policy === null
              ? undefined
              : (this.options.policy ?? policy())
          );
        },
        getPricing: () => {
          this.lookupOrder.push("pricing");
          return Promise.resolve(
            this.options.pricing === null
              ? undefined
              : (this.options.pricing ?? pricing())
          );
        },
        getWorkflow: (_workflowScope, identity) => {
          this.lookupOrder.push("workflow");
          this.workflowIdentity = identity;
          return Promise.resolve(
            this.options.workflow === null
              ? undefined
              : (this.options.workflow ?? workflow())
          );
        },
      },
    });
  }
}

class FakePlanningIdentifiers implements PlanningIdentifierPort {
  quoteCalls = 0;
  runPlanCalls = 0;

  nextQuoteId(): Promise<string> {
    this.quoteCalls += 1;
    return Promise.resolve("quote-server");
  }

  nextRunPlanId() {
    this.runPlanCalls += 1;
    return Promise.resolve(runPlanId("plan-server"));
  }
}

const request = (
  overrides: Partial<QuoteRunPlanRequest> = {}
): QuoteRunPlanRequest => ({
  actor,
  authorityEnvelopeId: "authority-test",
  budget: { limit: 10, unit: "credits" },
  deadlineMs: 15_000,
  normalizedInputHash: hash("e"),
  workflowContentHash: hash("c"),
  workflowRevision: "1.0.0",
  workflowSpecId: "workflow-test",
  workspaceId: workspace,
  ...overrides,
});

const makeFixture = (
  options: FakePlanningOptions = {},
  clockValues: readonly number[] = [1000],
  inputValidator?: InputContractValidatorPort,
  routes: CapabilityRouteCatalogPort = {
    listAvailable: () => [
      {
        capability,
        effectAdapterKey: "provider-test",
        reservableUpperBound: 1,
        reservationUnit: "credits",
        routeKey: "primary",
      },
    ],
  }
) => {
  const persistence = new FakePlanningPersistence(options);
  const identifiers = new FakePlanningIdentifiers();
  let clockIndex = 0;
  const execute = makeQuoteRunPlan({
    clock: {
      now: () => {
        const value =
          clockValues[Math.min(clockIndex, clockValues.length - 1)] ?? 1000;
        clockIndex += 1;
        return Promise.resolve(instant(value));
      },
    },
    identifiers,
    ...(inputValidator === undefined ? {} : { inputValidator }),
    persistence,
    routes,
  });
  return { execute, identifiers, persistence };
};

test("rejects missing plans:quote permission before persistence", async () => {
  const fixture = makeFixture();
  const result = await fixture.execute(
    request({ actor: { ...actor, permissions: ["runs:create"] } })
  );

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, "authority-permission-missing");
  }
  assert.equal(fixture.persistence.transactionCalls, 0);
  assert.equal(fixture.identifiers.runPlanCalls, 0);
});

test("rejects request workspace mismatch before persistence", async () => {
  const fixture = makeFixture();
  const result = await fixture.execute(
    request({ workspaceId: otherWorkspace })
  );

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, "workspace-mismatch");
  }
  assert.equal(fixture.persistence.transactionCalls, 0);
  assert.equal(fixture.identifiers.runPlanCalls, 0);
});

test("binds the authority subject before loading other snapshots", async () => {
  const fixture = makeFixture({
    authority: authority({ subjectActorId: actorId("actor-other") }),
  });

  const result = await fixture.execute(request());

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, "authority-subject-mismatch");
  }
  assert.deepEqual(fixture.persistence.lookupOrder, ["authority"]);
  assert.equal(fixture.persistence.inserted.length, 0);
  assert.equal(fixture.identifiers.runPlanCalls, 0);
});

test("does not reveal whether an authority exists", async () => {
  const missing = makeFixture({ authority: null });
  const otherSubject = makeFixture({
    authority: authority({ subjectActorId: actorId("actor-other") }),
  });

  const [missingResult, otherSubjectResult] = await Promise.all([
    missing.execute(request()),
    otherSubject.execute(request()),
  ]);

  assert.equal(missingResult.ok, false);
  assert.equal(otherSubjectResult.ok, false);
  if (!(missingResult.ok || otherSubjectResult.ok)) {
    assert.equal(missingResult.error.code, "authority-subject-mismatch");
    assert.equal(otherSubjectResult.error.code, "authority-subject-mismatch");
    assert.equal(missingResult.error.message, otherSubjectResult.error.message);
  }
  assert.deepEqual(missing.persistence.lookupOrder, ["authority"]);
  assert.deepEqual(otherSubject.persistence.lookupOrder, ["authority"]);
});

test("rejects an unsupported authority version before loading other snapshots", async () => {
  const fixture = makeFixture({
    authority: authority({ permissions: [], version: "2.0.0" }),
  });

  const result = await fixture.execute(request());

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, "domain-rejected");
    assert.equal(result.error.domainCode, "authority-version-unsupported");
  }
  assert.deepEqual(fixture.persistence.lookupOrder, ["authority"]);
  assert.equal(fixture.identifiers.runPlanCalls, 0);
});

test("rejects stored workflow provenance from an unsupported compiler", async () => {
  const fixture = makeFixture({
    workflow: workflow({ compilerVersion: "999.0.0" }),
  });

  const result = await fixture.execute(request());

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, "domain-rejected");
    assert.equal(result.error.domainCode, "compiler-version-unsupported");
  }
  assert.equal(fixture.persistence.inserted.length, 0);
});

test("fails closed when planning defaults are unavailable", async () => {
  const fixture = makeFixture({ defaults: null });

  const result = await fixture.execute(request());

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, "service-unavailable");
  }
  assert.deepEqual(fixture.persistence.lookupOrder, [
    "authority",
    "workflow",
    "defaults",
  ]);
  assert.equal(fixture.identifiers.runPlanCalls, 0);
});

test("fails closed when policy or pricing snapshots are unavailable", async () => {
  for (const options of [{ policy: null }, { pricing: null }] as const) {
    const fixture = makeFixture(options);
    const result = await fixture.execute(request());

    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error.code, "service-unavailable");
    }
    assert.equal(fixture.persistence.inserted.length, 0);
    assert.equal(fixture.identifiers.runPlanCalls, 0);
  }
});

test("canonical hashing is stable and the final hash excludes planHash", async () => {
  assert.equal(
    canonicalContentHash({ a: 1, b: [{ x: "x", y: true }] }),
    canonicalContentHash({ a: 1, b: [{ x: "x", y: true }] })
  );

  const fixture = makeFixture();
  const result = await fixture.execute(request());
  assert.equal(result.ok, true);
  if (!result.ok) {
    return;
  }
  const { planHash, ...hashablePlan } = result.value.plan;
  assert.equal(planHash, canonicalContentHash(hashablePlan));
});

test("persists an exact validated input atomically with its plan", async () => {
  const normalizedInput = { document: "synthetic" } as const;
  const fixture = makeFixture({}, [1000], {
    validate: ({ contract: validatedContract, value }) => {
      assert.deepEqual(validatedContract, contract);
      assert.deepEqual(value, normalizedInput);
      return Promise.resolve({
        status: "accepted",
        validatorVersion: "input-validator-test-v1",
      });
    },
  });

  const result = await fixture.execute(
    request({
      normalizedInput,
      normalizedInputHash: canonicalContentHash(normalizedInput),
    })
  );

  assert.equal(result.ok, true);
  assert.equal(fixture.persistence.inserted.length, 1);
  const stored = fixture.persistence.inserted[0];
  assert.equal(
    stored?.input?.contentHash,
    canonicalContentHash(normalizedInput)
  );
  assert.equal(stored?.input?.validatorVersion, "input-validator-test-v1");
  assert.deepEqual(stored?.input?.value, normalizedInput);
});

test("rejects a hard local quote without an upper bound", async () => {
  const fixture = makeFixture({
    pricing: pricing({ upperBound: undefined }),
  });

  const result = await fixture.execute(request());

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, "invalid-budget");
  }
  assert.equal(fixture.persistence.inserted.length, 0);
  assert.equal(fixture.identifiers.quoteCalls, 0);
});

test("keeps the requested budget within available authority", async () => {
  const fixture = makeFixture();
  const result = await fixture.execute(
    request({ budget: { limit: 16, unit: "credits" } })
  );

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, "invalid-budget");
  }
  assert.equal(fixture.persistence.inserted.length, 0);
});

test("requires matching pricing and budget units", async () => {
  const fixture = makeFixture({ pricing: pricing({ unit: "tokens" }) });
  const result = await fixture.execute(request());

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, "quote-unit-mismatch");
  }
  assert.equal(fixture.persistence.inserted.length, 0);
});

test("rejects an elapsed deadline before persistence", async () => {
  const fixture = makeFixture();
  const result = await fixture.execute(request({ deadlineMs: 1000 }));

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, "deadline-elapsed");
  }
  assert.equal(fixture.persistence.transactionCalls, 0);
});

test("rechecks the deadline immediately before allocating quote identities", async () => {
  const fixture = makeFixture({}, [1000, 15_000]);

  const result = await fixture.execute(request());

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, "deadline-elapsed");
  }
  assert.equal(fixture.persistence.inserted.length, 0);
  assert.equal(fixture.identifiers.quoteCalls, 0);
  assert.equal(fixture.identifiers.runPlanCalls, 0);
});

test("caps an oversized pricing TTL without overflowing the plan deadline", async () => {
  const fixture = makeFixture({
    pricing: pricing({ ttlMilliseconds: Number.MAX_SAFE_INTEGER }),
  });

  const result = await fixture.execute(request());

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.value.plan.quote.expiresAt, 15_000);
  }
});

test("loads exact snapshots and persists only plan plus provenance", async () => {
  const fixture = makeFixture();

  const result = await fixture.execute(request());

  assert.equal(result.ok, true);
  if (!result.ok) {
    return;
  }
  assert.deepEqual(fixture.persistence.lookupOrder, [
    "authority",
    "workflow",
    "defaults",
    "policy",
    "pricing",
  ]);
  assert.deepEqual(fixture.persistence.workflowIdentity, {
    workflowContentHash: hash("c"),
    workflowRevision: "1.0.0",
    workflowSpecId: workflowSpecId("workflow-test"),
  });
  assert.equal(fixture.persistence.inserted.length, 1);
  assert.equal(fixture.identifiers.runPlanCalls, 1);
  assert.equal(fixture.identifiers.quoteCalls, 1);
  assert.equal(result.value.plan.runPlanId, "plan-server");
  assert.equal(result.value.plan.quote.quoteId, "quote-server");
  assert.equal(result.value.plan.quote.expiresAt, 6000);
  assert.equal(result.value.plan.deadline, 15_000);
  assert.deepEqual(result.value.plan.budget, {
    limit: 10,
    reserved: 0,
    spent: 0,
    unit: "credits",
  });
  assert.deepEqual(result.value.plan.routeSnapshots, [
    {
      capability,
      effectAdapterKey: "provider-test",
      factsHash: hash("d"),
      nodeKey: "summarize",
      pricingVersion: "1.0.0",
      reservableUpperBound: 1,
      reservationUnit: "credits",
      routeKey: "primary",
    },
  ]);
  assert.deepEqual(fixture.persistence.inserted[0]?.sources, {
    authorityEnvelopeId: "authority-test",
    policySnapshotId: "policy-test",
    pricingSnapshotId: "pricing-test",
    workflowContentHash: hash("c"),
    workflowRevision: "1.0.0",
    workflowSpecId: workflowSpecId("workflow-test"),
  });
});

test("fails closed before persistence when no admitted route covers the workflow", async () => {
  const fixture = makeFixture({}, [1000], undefined, {
    listAvailable: () => [],
  });

  const result = await fixture.execute(request());

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, "service-unavailable");
  }
  assert.equal(fixture.persistence.inserted.length, 0);
  assert.equal(fixture.identifiers.quoteCalls, 0);
  assert.equal(fixture.identifiers.runPlanCalls, 0);
});

test("fails closed when the composed route catalog is unavailable", async () => {
  const fixture = makeFixture({}, [1000], undefined, {
    listAvailable: () => {
      throw new Error("provider details must stay private");
    },
  });

  const result = await fixture.execute(request());

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, "service-unavailable");
    assert.equal(result.error.message.includes("provider details"), false);
  }
  assert.equal(fixture.persistence.inserted.length, 0);
  assert.equal(fixture.identifiers.quoteCalls, 0);
  assert.equal(fixture.identifiers.runPlanCalls, 0);
});

test("preserves configured fallback order and exact capability revisions", async () => {
  const fixture = makeFixture({}, [1000], undefined, {
    listAvailable: () => [
      {
        capability,
        effectAdapterKey: "provider-secondary",
        reservableUpperBound: 1,
        reservationUnit: "credits",
        routeKey: "secondary",
      },
      {
        capability: { ...capability, capabilityVersion: "2.0.0" },
        effectAdapterKey: "provider-wrong-revision",
        reservableUpperBound: 1,
        reservationUnit: "credits",
        routeKey: "wrong-revision",
      },
      {
        capability,
        effectAdapterKey: "provider-primary",
        reservableUpperBound: 1,
        reservationUnit: "credits",
        routeKey: "primary",
      },
    ],
  });

  const result = await fixture.execute(request());

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.deepEqual(
      result.value.plan.routeSnapshots?.map((route) => route.routeKey),
      ["secondary", "primary"]
    );
  }
});

test("rejects a composed route that does not match the immutable quote unit", async () => {
  const fixture = makeFixture({}, [1000], undefined, {
    listAvailable: () => [
      {
        capability,
        effectAdapterKey: "provider-test",
        reservableUpperBound: 1,
        reservationUnit: "requests",
        routeKey: "primary",
      },
    ],
  });

  const result = await fixture.execute(request());

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, "service-unavailable");
    assert.equal(result.error.domainCode, "routing-snapshot-invalid");
  }
  assert.equal(fixture.persistence.inserted.length, 0);
});
