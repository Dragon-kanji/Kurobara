import assert from "node:assert/strict";
import test from "node:test";

import { actorId, capabilityId, instant, workspaceId } from "@kurobara/kernel";
import type {
  AuthoritySnapshot,
  CapabilityCatalogPort,
  PlanningPersistencePort,
  PlanningUnitOfWork,
  VerifiedApiKey,
  WorkspaceScope,
} from "@kurobara/ports";

import { makeListCapabilities } from "../src/index.ts";

const workspace = workspaceId("workspace-test");
const actor: VerifiedApiKey = {
  actorId: actorId("actor-test"),
  authenticationMode: "api-key",
  credentialId: "credential-test",
  permissions: ["capabilities:list"],
  workspaceId: workspace,
};

const capability = (id: string, version = "1.0.0") => ({
  capabilityId: capabilityId(id),
  capabilityVersion: version,
});

const authority = (
  overrides: Partial<AuthoritySnapshot> = {}
): AuthoritySnapshot => ({
  authorityEnvelopeId: "authority-test",
  budgetLimit: { limit: 10, reserved: 0, spent: 0, unit: "credits" },
  capabilities: [
    capability("documents.translate", "2.0.0"),
    capability("documents.summarize"),
  ],
  deadline: instant(2000),
  permissions: ["capabilities:list"],
  subjectActorId: actor.actorId,
  version: "1.0.0",
  workspaceId: workspace,
  ...overrides,
});

class FakePlanningPersistence implements PlanningPersistencePort {
  readonly authority: AuthoritySnapshot | undefined;
  transactionCalls = 0;

  constructor(authoritySnapshot: AuthoritySnapshot | undefined) {
    this.authority = authoritySnapshot;
  }

  transaction<Value>(
    _scope: WorkspaceScope,
    work: (unitOfWork: PlanningUnitOfWork) => Promise<Value>
  ): Promise<Value> {
    this.transactionCalls += 1;
    return work({
      runPlans: { insert: () => Promise.resolve() },
      snapshots: {
        getAuthority: () => Promise.resolve(this.authority),
        getDefaults: () => Promise.resolve(undefined),
        getPolicy: () => Promise.resolve(undefined),
        getPricing: () => Promise.resolve(undefined),
        getWorkflow: () => Promise.resolve(undefined),
      },
    });
  }
}

const makeUseCase = (
  authoritySnapshot: AuthoritySnapshot | undefined,
  available = [
    capability("documents.summarize"),
    capability("documents.ungranted"),
    capability("documents.translate", "2.0.0"),
    capability("documents.summarize"),
  ]
) => {
  const persistence = new FakePlanningPersistence(authoritySnapshot);
  let catalogCalls = 0;
  const catalog: CapabilityCatalogPort = {
    listAvailable: () => {
      catalogCalls += 1;
      return Promise.resolve(available);
    },
  };
  return {
    catalogCalls: () => catalogCalls,
    persistence,
    useCase: makeListCapabilities({
      catalog,
      clock: { now: () => Promise.resolve(instant(1000)) },
      persistence,
      requiredPermission: "capabilities:list",
    }),
  };
};

test("returns a stable intersection of runtime availability and exact authority", async () => {
  const harness = makeUseCase(authority());
  const result = await harness.useCase({
    actor,
    authorityEnvelopeId: "authority-test",
  });

  assert.deepEqual(result, {
    ok: true,
    value: {
      authorityEnvelopeId: "authority-test",
      capabilities: [
        capability("documents.summarize"),
        capability("documents.translate", "2.0.0"),
      ],
      workspaceId: workspace,
    },
  });
  assert.equal(harness.catalogCalls(), 1);
});

test("rejects a missing actor permission before clock, persistence, or catalog I/O", async () => {
  const persistence = new FakePlanningPersistence(authority());
  let clockCalls = 0;
  let catalogCalls = 0;
  const useCase = makeListCapabilities({
    catalog: {
      listAvailable: () => {
        catalogCalls += 1;
        return Promise.resolve([]);
      },
    },
    clock: {
      now: () => {
        clockCalls += 1;
        return Promise.resolve(instant(1000));
      },
    },
    persistence,
    requiredPermission: "capabilities:list",
  });

  const result = await useCase({
    actor: { ...actor, permissions: [] },
    authorityEnvelopeId: "authority-test",
  });

  assert.equal(result.ok, false);
  assert.equal(
    result.ok ? undefined : result.error.code,
    "authority-permission-missing"
  );
  assert.equal(clockCalls, 0);
  assert.equal(persistence.transactionCalls, 0);
  assert.equal(catalogCalls, 0);
});

test("uses the same non-revealing failure for missing and foreign authorities", async () => {
  const missing = await makeUseCase(undefined).useCase({
    actor,
    authorityEnvelopeId: "authority-test",
  });
  const foreign = await makeUseCase(
    authority({ subjectActorId: actorId("actor-other") })
  ).useCase({ actor, authorityEnvelopeId: "authority-test" });

  assert.deepEqual(missing, foreign);
  assert.equal(
    missing.ok ? undefined : missing.error.code,
    "authority-subject-mismatch"
  );
});

test("requires the discovery permission in the authority envelope", async () => {
  const harness = makeUseCase(authority({ permissions: ["plans:quote"] }));
  const result = await harness.useCase({
    actor,
    authorityEnvelopeId: "authority-test",
  });

  assert.equal(result.ok, false);
  assert.equal(
    result.ok ? undefined : result.error.code,
    "authority-permission-missing"
  );
  assert.equal(harness.catalogCalls(), 0);
});

test("fails closed on an unsupported authority envelope version", async () => {
  const harness = makeUseCase(authority({ permissions: [], version: "2.0.0" }));
  const result = await harness.useCase({
    actor,
    authorityEnvelopeId: "authority-test",
  });

  assert.equal(result.ok, false);
  assert.equal(
    result.ok ? undefined : result.error.code,
    "service-unavailable"
  );
  assert.equal(harness.catalogCalls(), 0);
});

test("rejects an expired authority before consulting runtime availability", async () => {
  const harness = makeUseCase(authority({ deadline: instant(1000) }));
  const result = await harness.useCase({
    actor,
    authorityEnvelopeId: "authority-test",
  });

  assert.equal(result.ok, false);
  assert.equal(result.ok ? undefined : result.error.code, "deadline-elapsed");
  assert.equal(harness.catalogCalls(), 0);
});

test("rechecks authority expiry after reading runtime availability", async () => {
  const persistence = new FakePlanningPersistence(authority());
  let clockCalls = 0;
  const useCase = makeListCapabilities({
    catalog: { listAvailable: () => Promise.resolve([]) },
    clock: {
      now: () => {
        clockCalls += 1;
        return Promise.resolve(instant(clockCalls === 1 ? 1000 : 2000));
      },
    },
    persistence,
    requiredPermission: "capabilities:list",
  });

  const result = await useCase({
    actor,
    authorityEnvelopeId: "authority-test",
  });

  assert.equal(result.ok, false);
  assert.equal(result.ok ? undefined : result.error.code, "deadline-elapsed");
  assert.equal(clockCalls, 2);
});

test("fails closed when the runtime registry exposes an invalid revision", async () => {
  const harness = makeUseCase(authority(), [
    capability("documents.summarize", "latest"),
  ]);
  const result = await harness.useCase({
    actor,
    authorityEnvelopeId: "authority-test",
  });

  assert.equal(result.ok, false);
  assert.equal(
    result.ok ? undefined : result.error.code,
    "service-unavailable"
  );
});

test("fails closed instead of truncating an oversized discovery result", async () => {
  const available = Array.from({ length: 257 }, (_, index) =>
    capability(`capability.${String(index).padStart(3, "0")}`)
  );
  const harness = makeUseCase(
    authority({ capabilities: available }),
    available
  );
  const result = await harness.useCase({
    actor,
    authorityEnvelopeId: "authority-test",
  });

  assert.equal(result.ok, false);
  assert.equal(
    result.ok ? undefined : result.error.code,
    "service-unavailable"
  );
});
