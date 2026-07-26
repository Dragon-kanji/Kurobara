import assert from "node:assert/strict";
import test from "node:test";

import {
  actorId,
  attemptId,
  capabilityId,
  contentHash,
  costReservationId,
  idempotencyKey,
  instant,
  operationKey,
  type Run,
  type RunPlan,
  type RunPlanRouteSnapshot,
  routingDecisionId,
  runId,
  runPlanId,
  type StepRun,
  stepRunId,
  workflowSpecId,
  workspaceId,
} from "@kurobara/kernel";
import type {
  StepRoutingContext,
  StepRoutingPersistencePort,
  StepRoutingUnitOfWork,
} from "@kurobara/ports";

import { makeRouteAndClaimNextReadyStep } from "../src/index.ts";

const hash = (character: string) =>
  contentHash(`sha256:${character.repeat(64)}`);
const workspace = workspaceId("workspace-auto-route");
const capability = {
  capabilityId: capabilityId("documents.summarize"),
  capabilityVersion: "1.0.0",
};
const route = (
  routeKey: string,
  effectAdapterKey: string,
  upperBound = 1
): RunPlanRouteSnapshot => ({
  capability,
  effectAdapterKey,
  factsHash: hash("2"),
  nodeKey: "summarize",
  pricingVersion: "1.0.0",
  reservableUpperBound: upperBound,
  reservationUnit: "credits",
  routeKey,
});
const run: Run = {
  aggregateVersion: 2,
  createdAt: instant(1000),
  eventSequence: 2,
  idempotencyKey: idempotencyKey("create-auto-route"),
  intentionHash: hash("1"),
  resultCompleteness: "none",
  runId: runId("run-auto-route"),
  runPlanId: runPlanId("plan-auto-route"),
  state: "running",
  workspaceId: workspace,
};
const plan = (routes: readonly RunPlanRouteSnapshot[]): RunPlan => ({
  authority: {
    authorityEnvelopeId: "authority-auto-route",
    budgetLimit: { limit: 10, reserved: 0, spent: 0, unit: "credits" },
    capabilities: [capability],
    deadline: instant(10_000),
    permissions: ["steps:execute"],
    subjectActorId: actorId("agent-auto-route"),
    version: "1.0.0",
    workspaceId: workspace,
  },
  budget: { limit: 10, reserved: 0, spent: 0, unit: "credits" },
  catalogFingerprint: hash("b"),
  catalogVersion: "1.0.0",
  compiledWorkflow: {
    compilerVersion: "1.0.0",
    fingerprint: "auto-route-workflow",
    nodes: [{ capability, dependsOn: [], depth: 0, key: "summarize" }],
    workflowContentHash: hash("c"),
    workflowRevision: "1.0.0",
    workflowSpecId: workflowSpecId("workflow-auto-route"),
  },
  deadline: instant(9000),
  inputContract: {
    catalogFingerprint: hash("b"),
    catalogVersion: "1.0.0",
    schemaFingerprint: hash("d"),
    schemaId: "https://schemas.kurobara.invalid/input/1.0.0",
    schemaVersion: "1.0.0",
  },
  normalizedInputHash: hash("e"),
  outputContract: {
    catalogFingerprint: hash("b"),
    catalogVersion: "1.0.0",
    schemaFingerprint: hash("f"),
    schemaId: "https://schemas.kurobara.invalid/output/1.0.0",
    schemaVersion: "1.0.0",
  },
  planHash: hash("1"),
  policyFactsHash: hash("2"),
  policyVersion: "1.0.0",
  quote: {
    expiresAt: instant(8000),
    guarantee: "hard",
    pricingVersion: "1.0.0",
    quoteId: "quote-auto-route",
    unit: "credits",
    upperBound: 10,
  },
  retryPolicy: { maxAttemptsPerStep: 3 },
  routeSnapshots: routes,
  runPlanId: run.runPlanId,
  workspaceId: workspace,
});
const readyStep = (): StepRun => ({
  aggregateVersion: 1,
  attempts: [],
  createdAt: instant(1500),
  dependsOn: [],
  eventSequence: 1,
  nodeKey: "summarize",
  runId: run.runId,
  state: "ready",
  stepRunId: stepRunId("step-auto-route"),
  workspaceId: workspace,
});

class FakeRoutingPersistence implements StepRoutingPersistencePort {
  attempts: import("@kurobara/kernel").Attempt[] = [];
  budgetExceeded = false;
  completed: StepRun["stepRunId"][] = [];
  context: StepRoutingContext | undefined;
  decisions: import("@kurobara/kernel").RoutingDecision[] = [];
  deferred: Array<{ reason: string; retryDelayMilliseconds: number }> = [];
  events: import("@kurobara/kernel").StepLifecycleEvent[] = [];
  leafOutbox: import("@kurobara/ports").LeafOutboxMessage[] = [];
  proof: import("@kurobara/kernel").StepCommandReplayProof | undefined;
  reservation: import("@kurobara/kernel").CostReservation | undefined;
  scheduledRuns: Run["runId"][] = [];

  constructor(routes: readonly RunPlanRouteSnapshot[]) {
    this.context = { plan: plan(routes), run, stepRun: readyStep() };
  }

  transactionForSystem<Value>(
    work: (unitOfWork: StepRoutingUnitOfWork) => Promise<Value>
  ): Promise<Value> {
    const current = () => this.context;
    return work({
      artifacts: {
        insert: () => Promise.resolve(),
      },
      attempts: {
        insert: (_scope, attempt) => {
          this.attempts.push(attempt);
          return Promise.resolve();
        },
        update: () => Promise.reject(new Error("update not expected")),
      },
      commandJournal: {
        find: async () => this.proof,
        insert: (_scope, proof) => {
          this.proof = proof;
          return Promise.resolve();
        },
      },
      dagSchedule: {
        request: (_scope, requestedRunId) => {
          this.scheduledRuns.push(requestedRunId);
          return Promise.resolve();
        },
      },
      leafOutbox: {
        append: (_scope, message) => {
          this.leafOutbox.push(message);
          return Promise.resolve();
        },
      },
      reservations: {
        release: () => Promise.reject(new Error("release not expected")),
        reserve: (_scope, reservation) => {
          if (this.budgetExceeded) {
            return Promise.resolve({ status: "budget-exceeded" } as const);
          }
          this.reservation = reservation;
          return Promise.resolve({ reservation, status: "created" } as const);
        },
        settle: () => Promise.reject(new Error("settle not expected")),
      },
      routingDecisions: {
        insert: (_scope, decision) => {
          this.decisions.push(decision);
          return Promise.resolve();
        },
      },
      routingJobs: {
        claimNextForUpdate: async () => current(),
        complete: (_scope, requestedStepRunId) => {
          this.completed.push(requestedStepRunId);
          this.context = undefined;
          return Promise.resolve();
        },
        defer: (_scope, _stepRunId, reason, retryDelayMilliseconds) => {
          this.deferred.push({ reason, retryDelayMilliseconds });
          return Promise.resolve();
        },
      },
      stepEvents: {
        append: (_scope, event) => {
          this.events.push(event);
          return Promise.resolve();
        },
      },
      stepRouting: { request: () => Promise.resolve() },
      steps: {
        getContextByStepIdForUpdate: () => {
          const context = current();
          return Promise.resolve(
            context === undefined
              ? undefined
              : {
                  plan: context.plan,
                  run: context.run,
                  stepRun: context.stepRun,
                  succeededNodeKeys: [],
                }
          );
        },
        getContextForUpdate: () => {
          const context = current();
          return Promise.resolve(
            context === undefined
              ? undefined
              : {
                  plan: context.plan,
                  run: context.run,
                  stepRun: context.stepRun,
                  succeededNodeKeys: [],
                }
          );
        },
        insert: () => Promise.reject(new Error("insert not expected")),
        update: (_scope, expectedVersion, stepRun) => {
          const context = current();
          if (context?.stepRun.aggregateVersion !== expectedVersion) {
            return Promise.reject(new Error("unexpected step version"));
          }
          this.context = { ...context, stepRun };
          return Promise.resolve();
        },
      },
    });
  }
}

const router = (
  persistence: FakeRoutingPersistence,
  availableEffectAdapterKeys: readonly string[]
) =>
  makeRouteAndClaimNextReadyStep({
    availableEffectAdapterKeys,
    clock: { now: async () => instant(2000) },
    persistence,
    requiredPermission: "steps:execute",
    retryDelayMilliseconds: 1000,
  });

test("selects the first composed plan route and atomically claims it as the system actor", async () => {
  const persistence = new FakeRoutingPersistence([
    route("unavailable", "missing-adapter"),
    route("local", "deterministic-local", 0.25),
  ]);
  const result = await router(persistence, ["deterministic-local"])();

  assert.equal(result.status, "claimed");
  assert.equal(persistence.completed.length, 1);
  assert.equal(persistence.decisions[0]?.routeKey, "local");
  assert.equal(persistence.reservation?.amount, 0.25);
  assert.equal(
    persistence.leafOutbox[0]?.effectAdapterKey,
    "deterministic-local"
  );
  assert.deepEqual(
    persistence.events.map((event) => event.eventType),
    ["RoutingDecisionRecorded", "AttemptCreated", "AttemptClaimed"]
  );
  assert.equal(persistence.events[0]?.actorId, "system:step-router");
  assert.equal(persistence.proof?.actorId, "system:step-router");
});

test("rejects only a node whose immutable plan contains no route", async () => {
  const persistence = new FakeRoutingPersistence([]);
  const result = await router(persistence, ["deterministic-local"])();

  assert.equal(result.status, "rejected");
  assert.equal(persistence.context, undefined);
  assert.deepEqual(
    persistence.events.map((event) => event.eventType),
    ["StepRoutingRejected"]
  );
  assert.deepEqual(persistence.scheduledRuns, [run.runId]);
  assert.deepEqual(persistence.deferred, []);
});

test("defers a planned route while its adapter is unavailable", async () => {
  const persistence = new FakeRoutingPersistence([
    route("planned", "temporarily-missing"),
  ]);
  const result = await router(persistence, ["deterministic-local"])();

  assert.equal(result.status, "deferred");
  assert.equal(persistence.context?.stepRun.state, "ready");
  assert.deepEqual(persistence.completed, []);
  assert.deepEqual(persistence.deferred, [
    { reason: "effect-adapter-unavailable", retryDelayMilliseconds: 1000 },
  ]);
  assert.deepEqual(persistence.events, []);
});

test("keeps budget exhaustion distinct and deferred without corrupting routing", async () => {
  const persistence = new FakeRoutingPersistence([
    route("local", "deterministic-local"),
  ]);
  persistence.budgetExceeded = true;
  const result = await router(persistence, ["deterministic-local"])();

  assert.equal(result.status, "deferred");
  assert.deepEqual(persistence.deferred, [
    { reason: "budget-exceeded", retryDelayMilliseconds: 1000 },
  ]);
  assert.equal(persistence.context?.stepRun.state, "ready");
  assert.deepEqual(persistence.events, []);
  assert.deepEqual(persistence.decisions, []);
});

test("derives stable attempt, reservation and operation identities", async () => {
  const first = new FakeRoutingPersistence([
    route("local", "deterministic-local"),
  ]);
  const second = new FakeRoutingPersistence([
    route("local", "deterministic-local"),
  ]);
  await router(first, ["deterministic-local"])();
  await router(second, ["deterministic-local"])();

  assert.equal(first.attempts[0]?.attemptId, second.attempts[0]?.attemptId);
  assert.equal(
    first.reservation?.reservationId,
    second.reservation?.reservationId
  );
  assert.equal(
    first.reservation?.operationKey,
    second.reservation?.operationKey
  );
  assert.equal(
    first.decisions[0]?.routingDecisionId,
    second.decisions[0]?.routingDecisionId
  );
});

test("falls back to the next untried route while preserving the logical operation", async () => {
  const routes = [
    route("primary", "provider-primary"),
    route("secondary", "provider-secondary"),
  ];
  const persistence = new FakeRoutingPersistence(routes);
  await router(persistence, ["provider-primary", "provider-secondary"])();

  const firstAttempt = persistence.attempts[0];
  assert.ok(firstAttempt);
  persistence.context = {
    plan: plan(routes),
    run,
    stepRun: {
      ...readyStep(),
      aggregateVersion: 4,
      attempts: [
        {
          ...firstAttempt,
          finishedAt: instant(1900),
          state: "failed_retryable",
        },
      ],
    },
  };
  persistence.proof = undefined;

  const result = await router(persistence, [
    "provider-primary",
    "provider-secondary",
  ])();

  assert.equal(result.status, "claimed");
  assert.equal(persistence.attempts[1]?.routeKey, "secondary");
  assert.equal(persistence.attempts[1]?.reason, "fallback");
  assert.equal(
    persistence.attempts[1]?.operationKey,
    firstAttempt.operationKey
  );
  assert.equal(
    persistence.decisions[1]?.effectAdapterKey,
    "provider-secondary"
  );
});

test("cycles to the first route only after every fallback was attempted", async () => {
  const routes = [
    route("primary", "provider-primary"),
    route("secondary", "provider-secondary"),
  ];
  const persistence = new FakeRoutingPersistence(routes);
  const firstAttempt = {
    attemptId: attemptId("attempt-primary"),
    attemptNumber: 1,
    authorityEnvelopeId: "authority-auto-route",
    claimedAt: instant(1600),
    costReservationId: costReservationId("reservation-primary"),
    effectAdapterKey: "provider-primary",
    finishedAt: instant(1700),
    operationKey: operationKey("operation-shared"),
    preparedAt: instant(1600),
    reason: "initial",
    reservationUnit: "credits",
    reservedAmount: 1,
    routeKey: "primary",
    routeSnapshotHash: hash("3"),
    routingDecisionId: routingDecisionId("routing-primary"),
    state: "failed_retryable",
    stepRunId: stepRunId("step-auto-route"),
  } as const;
  const secondAttempt = {
    ...firstAttempt,
    attemptId: attemptId("attempt-secondary"),
    attemptNumber: 2,
    costReservationId: costReservationId("reservation-secondary"),
    effectAdapterKey: "provider-secondary",
    finishedAt: instant(1900),
    reason: "fallback",
    routeKey: "secondary",
    routingDecisionId: routingDecisionId("routing-secondary"),
  } as const;
  persistence.context = {
    plan: plan(routes),
    run,
    stepRun: {
      ...readyStep(),
      aggregateVersion: 6,
      attempts: [firstAttempt, secondAttempt],
    },
  };

  const result = await router(persistence, [
    "provider-primary",
    "provider-secondary",
  ])();

  assert.equal(result.status, "claimed");
  assert.equal(persistence.attempts[0]?.routeKey, "primary");
  assert.equal(persistence.attempts[0]?.reason, "fallback");
  assert.equal(
    persistence.attempts[0]?.operationKey,
    operationKey("operation-shared")
  );
});
