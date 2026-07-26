import assert from "node:assert/strict";
import test from "node:test";

import {
  actorId,
  capabilityId,
  contentHash,
  correlationId,
  eventId,
  idempotencyKey,
  instant,
  outboxMessageId,
  type RunPlan,
  runId,
  runPlanId,
  workflowSpecId,
  workspaceId,
} from "@kurobara/kernel";
import type {
  ClockPort,
  IdentifierPort,
  OutboxMessage,
  PersistencePort,
  RunCreationRecord,
  RunCreationUnitOfWork,
  StoredRunPlan,
  WorkspaceScope,
} from "@kurobara/ports";

import { makeCreateRunFromPlan, prepareRunPlan } from "../src/index.ts";

const hash = (value: string) =>
  contentHash(`sha256:${value.repeat(64).slice(0, 64)}`);
const workspace = workspaceId("workspace-test");
const capability = {
  capabilityId: capabilityId("documents.summarize"),
  capabilityVersion: "1.0.0",
};
const SYNTHETIC_OUTBOX_FAILURE = /synthetic outbox failure/u;

const preparedPlan = (): RunPlan => {
  const contract = {
    catalogFingerprint: hash("a"),
    catalogVersion: "1.0.0",
    schemaFingerprint: hash("b"),
    schemaId: "https://schemas.kurobara.dev/schemas/inputs/document/1.0.0",
    schemaVersion: "1.0.0",
  };
  const result = prepareRunPlan({
    actorPermissions: ["runs:create"],
    allowedCapabilities: [capability.capabilityId],
    authority: {
      authorityEnvelopeId: "authority-test",
      budgetLimit: { limit: 10, reserved: 0, spent: 0, unit: "credits" },
      capabilities: [capability],
      deadline: instant(20_000),
      permissions: ["runs:create"],
      subjectActorId: actorId("actor-test"),
      version: "1.0.0",
      workspaceId: workspace,
    },
    budget: { limit: 5, reserved: 0, spent: 0, unit: "credits" },
    catalogFingerprint: hash("a"),
    catalogVersion: "1.0.0",
    compilationLimits: { maxDepth: 2, maxFanOut: 2, maxNodes: 2 },
    compilerVersion: "1.0.0",
    deadline: instant(15_000),
    inputContract: contract,
    normalizedInputHash: hash("c"),
    now: instant(1000),
    outputContract: {
      ...contract,
      schemaId: "https://schemas.kurobara.dev/schemas/outputs/summary/1.0.0",
    },
    planHash: hash("d"),
    policy: {
      factsHash: hash("e"),
      requiredPermission: "runs:create",
      version: "1.0.0",
    },
    quote: {
      expiresAt: instant(10_000),
      guarantee: "hard",
      pricingVersion: "1.0.0",
      quoteId: "quote-test",
      unit: "credits",
      upperBound: 5,
    },
    retryPolicy: { maxAttemptsPerStep: 3 },
    runPlanId: runPlanId("plan-test"),
    workflow: {
      contentHash: hash("f"),
      nodes: [{ capability, dependsOn: [], key: "summarize" }],
      revision: "1.0.0",
      workflowSpecId: workflowSpecId("workflow-test"),
    },
    workspaceId: workspace,
  });
  if (!result.ok) {
    throw new Error(`Test plan preparation failed: ${result.error.code}`);
  }
  return result.value;
};

class FakePersistence implements PersistencePort {
  plans = new Map<string, StoredRunPlan>();
  creations = new Map<string, RunCreationRecord>();
  events: import("@kurobara/kernel").RunQueued[] = [];
  outbox: OutboxMessage[] = [];
  failOnOutbox = false;

  async transaction<Value>(
    _scope: WorkspaceScope,
    work: (unitOfWork: RunCreationUnitOfWork) => Promise<Value>
  ): Promise<Value> {
    const snapshot = {
      creations: new Map(this.creations),
      events: [...this.events],
      outbox: [...this.outbox],
      plans: new Map(this.plans),
    };
    const unitOfWork: RunCreationUnitOfWork = {
      outbox: {
        append: (_scope, message) => {
          if (this.failOnOutbox) {
            return Promise.reject(new Error("synthetic outbox failure"));
          }
          this.outbox.push(message);
          return Promise.resolve();
        },
      },
      runEvents: {
        append: (_scope, event) => {
          this.events.push(event);
          return Promise.resolve();
        },
      },
      runPlans: {
        get: (_scope, planId) => Promise.resolve(this.plans.get(planId)),
        insert: (_scope, plan) => {
          this.plans.set(plan.runPlanId, { plan });
          return Promise.resolve();
        },
        markConsumed: (_scope, planId, creation) => {
          const stored = this.plans.get(planId);
          if (stored === undefined || stored.consumedBy !== undefined) {
            return Promise.reject(new Error("run plan consumption conflict"));
          }
          this.plans.set(planId, { ...stored, consumedBy: creation });
          this.creations.set(creation.idempotencyKey, creation);
          return Promise.resolve();
        },
      },
      runs: {
        findByIdempotencyKey: (_scope, key) =>
          Promise.resolve(this.creations.get(key)),
        insert: () => Promise.resolve(),
        lockIdempotencyKey: () => Promise.resolve(),
      },
    };
    try {
      return await work(unitOfWork);
    } catch (error) {
      this.creations = snapshot.creations;
      this.events = snapshot.events;
      this.outbox = snapshot.outbox;
      this.plans = snapshot.plans;
      throw error;
    }
  }
}

const identifiers: IdentifierPort = {
  nextEventId: async () => eventId("event-test"),
  nextOutboxMessageId: async () => outboxMessageId("outbox-test"),
  nextRunId: async () => runId("run-test"),
};
const clock: ClockPort = { now: async () => instant(1000) };
const command = (intention = hash("d")) => ({
  actorId: actorId("actor-test"),
  actorPermissions: ["runs:create"],
  authenticationMode: "api-key",
  correlationId: correlationId("correlation-test"),
  idempotencyKey: idempotencyKey("idempotency-test"),
  intentionHash: intention,
  runPlanId: runPlanId("plan-test"),
  workspaceId: workspace,
});

test("persists run, event, plan consumption and outbox atomically", async () => {
  const persistence = new FakePersistence();
  persistence.plans.set("plan-test", { plan: preparedPlan() });
  const execute = makeCreateRunFromPlan({
    clock,
    identifiers,
    persistence,
    requiredPermission: "runs:create",
  });

  const result = await execute(command());

  assert.equal(result.ok, true);
  assert.equal(persistence.events.length, 1);
  assert.equal(persistence.outbox.length, 1);
  assert.equal(
    persistence.plans.get("plan-test")?.consumedBy?.run.state,
    "queued"
  );
});

test("rejects an authenticated actor without run creation permission", async () => {
  const persistence = new FakePersistence();
  persistence.plans.set("plan-test", { plan: preparedPlan() });
  const execute = makeCreateRunFromPlan({
    clock,
    identifiers,
    persistence,
    requiredPermission: "runs:create",
  });

  const result = await execute({
    ...command(),
    actorPermissions: ["runs:read"],
  });

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, "authority-permission-missing");
  }
  assert.equal(persistence.events.length, 0);
  assert.equal(persistence.outbox.length, 0);
});

test("rejects an authenticated actor outside the plan authority", async () => {
  const persistence = new FakePersistence();
  const source = preparedPlan();
  persistence.plans.set("plan-test", {
    plan: {
      ...source,
      authority: {
        ...source.authority,
        subjectActorId: actorId("actor-other"),
      },
    },
  });
  const execute = makeCreateRunFromPlan({
    clock,
    identifiers,
    persistence,
    requiredPermission: "runs:create",
  });

  const result = await execute(command());

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, "domain-rejected");
    assert.equal(result.error.domainCode, "authority-subject-mismatch");
  }
  assert.equal(persistence.events.length, 0);
  assert.equal(persistence.outbox.length, 0);
});

test("returns the original run for the same idempotent intention", async () => {
  const persistence = new FakePersistence();
  persistence.plans.set("plan-test", { plan: preparedPlan() });
  const execute = makeCreateRunFromPlan({
    clock,
    identifiers,
    persistence,
    requiredPermission: "runs:create",
  });

  const first = await execute(command());
  const second = await execute(command());

  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  if (second.ok) {
    assert.equal(second.value.replayed, true);
  }
  assert.equal(persistence.events.length, 1);
  assert.equal(persistence.outbox.length, 1);
});

test("rolls back every staged write when the outbox append fails", async () => {
  const persistence = new FakePersistence();
  persistence.plans.set("plan-test", { plan: preparedPlan() });
  persistence.failOnOutbox = true;
  const execute = makeCreateRunFromPlan({
    clock,
    identifiers,
    persistence,
    requiredPermission: "runs:create",
  });

  await assert.rejects(() => execute(command()), SYNTHETIC_OUTBOX_FAILURE);
  assert.equal(persistence.events.length, 0);
  assert.equal(persistence.outbox.length, 0);
  assert.equal(persistence.plans.get("plan-test")?.consumedBy, undefined);
});

test("rejects reuse of an idempotency key for another intention", async () => {
  const persistence = new FakePersistence();
  persistence.plans.set("plan-test", { plan: preparedPlan() });
  const execute = makeCreateRunFromPlan({
    clock,
    identifiers,
    persistence,
    requiredPermission: "runs:create",
  });
  await execute(command());

  const result = await execute(command(hash("9")));

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, "idempotency-key-reused");
  }
});

test("rejects a client intention hash that is not bound to the plan", async () => {
  const persistence = new FakePersistence();
  persistence.plans.set("plan-test", { plan: preparedPlan() });
  const execute = makeCreateRunFromPlan({
    clock,
    identifiers,
    persistence,
    requiredPermission: "runs:create",
  });

  const result = await execute(command(hash("9")));

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, "intention-hash-mismatch");
  }
  assert.equal(persistence.events.length, 0);
  assert.equal(persistence.outbox.length, 0);
});
