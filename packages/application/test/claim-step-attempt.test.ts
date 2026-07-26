import assert from "node:assert/strict";
import test from "node:test";

import {
  actorId,
  attemptId,
  capabilityId,
  contentHash,
  correlationId,
  costReservationId,
  eventId,
  idempotencyKey,
  instant,
  operationKey,
  outboxMessageId,
  type Run,
  type RunPlan,
  runId,
  runPlanId,
  stepRunId,
  workflowSpecId,
  workspaceId,
} from "@kurobara/kernel";
import type {
  CostReservationResult,
  LeafOutboxMessage,
  StepExecutionPersistencePort,
  StepExecutionUnitOfWork,
  WorkspaceScope,
} from "@kurobara/ports";

import {
  type ClaimStepAttemptInput,
  makeClaimStepAttempt,
} from "../src/index.ts";

const hash = (character: string) =>
  contentHash(`sha256:${character.repeat(64)}`);
const workspace = workspaceId("workspace-step");
const run = (state: Run["state"] = "running"): Run => ({
  aggregateVersion: 2,
  createdAt: instant(1000),
  eventSequence: 2,
  idempotencyKey: idempotencyKey("create-step-run"),
  intentionHash: hash("a"),
  resultCompleteness: "none",
  runId: runId("run-step"),
  runPlanId: runPlanId("plan-step"),
  state,
  workspaceId: workspace,
});
const capability = {
  capabilityId: capabilityId("documents.summarize"),
  capabilityVersion: "1.0.0",
};
const plan = (
  dependsOn: readonly string[] = [],
  reservableUpperBound = 2
): RunPlan => ({
  authority: {
    authorityEnvelopeId: "authority-step",
    budgetLimit: { limit: 10, reserved: 0, spent: 0, unit: "credits" },
    capabilities: [capability],
    deadline: instant(10_000),
    permissions: ["steps:execute"],
    subjectActorId: actorId("agent-step"),
    version: "1.0.0",
    workspaceId: workspace,
  },
  budget: { limit: 5, reserved: 0, spent: 0, unit: "credits" },
  catalogFingerprint: hash("b"),
  catalogVersion: "1.0.0",
  compiledWorkflow: {
    compilerVersion: "1.0.0",
    fingerprint: "workflow-fingerprint",
    nodes: [
      {
        capability,
        dependsOn,
        depth: dependsOn.length,
        key: "summarize",
      },
    ],
    workflowContentHash: hash("c"),
    workflowRevision: "1.0.0",
    workflowSpecId: workflowSpecId("workflow-step"),
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
    quoteId: "quote-step",
    unit: "credits",
    upperBound: 5,
  },
  retryPolicy: { maxAttemptsPerStep: 3 },
  routeSnapshots: [
    {
      capability,
      effectAdapterKey: "deterministic-local",
      factsHash: hash("2"),
      nodeKey: "summarize",
      pricingVersion: "1.0.0",
      reservableUpperBound,
      reservationUnit: "credits",
      routeKey: "route-local",
    },
  ],
  runPlanId: runPlanId("plan-step"),
  workspaceId: workspace,
});

class FakeStepExecutionPersistence implements StepExecutionPersistencePort {
  attempts: import("@kurobara/kernel").Attempt[] = [];
  events: import("@kurobara/kernel").StepLifecycleEvent[] = [];
  leafOutbox: LeafOutboxMessage[] = [];
  plan: RunPlan = plan();
  proof: import("@kurobara/kernel").StepCommandReplayProof | undefined;
  reservation: import("@kurobara/kernel").CostReservation | undefined;
  routingDecisions: import("@kurobara/kernel").RoutingDecision[] = [];
  run: Run = run();
  stepRun: import("@kurobara/kernel").StepRun | undefined;
  succeededNodeKeys: readonly string[] = [];

  transaction<Value>(
    _scope: WorkspaceScope,
    work: (unitOfWork: StepExecutionUnitOfWork) => Promise<Value>
  ): Promise<Value> {
    const unitOfWork: StepExecutionUnitOfWork = {
      artifacts: {
        insert: () => Promise.resolve(),
      },
      attempts: {
        insert: (_scope, attempt) => {
          this.attempts.push(attempt);
          return Promise.resolve();
        },
        update: (_scope, expectedState, attempt) => {
          const index = this.attempts.findIndex(
            (candidate) => candidate.attemptId === attempt.attemptId
          );
          if (index < 0 || this.attempts[index]?.state !== expectedState) {
            return Promise.reject(new Error("Unexpected attempt state."));
          }
          this.attempts[index] = attempt;
          return Promise.resolve();
        },
      },
      commandJournal: {
        find: async (_scope, _stepRunId, commandKey) =>
          this.proof?.identity.idempotencyKey === commandKey
            ? this.proof
            : undefined,
        insert: (_scope, proof) => {
          this.proof = proof;
          return Promise.resolve();
        },
      },
      dagSchedule: {
        request: () =>
          Promise.reject(new Error("DAG scheduling is not expected on claim.")),
      },
      leafOutbox: {
        append: (_scope, message) => {
          this.leafOutbox.push(message);
          return Promise.resolve();
        },
      },
      reservations: {
        release: (_scope, release) => {
          const reservation = this.reservation;
          if (
            reservation === undefined ||
            reservation.reservationId !== release.reservationId ||
            reservation.state === "settled"
          ) {
            return Promise.resolve({ status: "conflict" as const });
          }
          if (reservation.state === "released") {
            return Promise.resolve({
              reservation,
              status: "existing" as const,
            });
          }
          const released = {
            ...reservation,
            releasedAt: release.releasedAt,
            state: "released" as const,
          };
          this.reservation = released;
          return Promise.resolve({
            reservation: released,
            status: "released" as const,
          });
        },
        reserve: (_scope, reservation) => {
          let result: CostReservationResult;
          if (this.reservation !== undefined) {
            result =
              this.reservation.reservationId === reservation.reservationId &&
              this.reservation.operationKey === reservation.operationKey &&
              this.reservation.amount === reservation.amount &&
              this.reservation.unit === reservation.unit
                ? { reservation: this.reservation, status: "existing" }
                : { status: "conflict" };
          } else if (reservation.amount > this.plan.budget.limit) {
            result = { status: "budget-exceeded" };
          } else {
            this.reservation = reservation;
            result = { reservation, status: "created" };
          }
          return Promise.resolve(result);
        },
        settle: (_scope, usage) => {
          const reservation = this.reservation;
          if (
            reservation === undefined ||
            reservation.reservationId !== usage.reservationId ||
            reservation.state !== "reserved"
          ) {
            return Promise.resolve({ status: "conflict" as const });
          }
          if (usage.amount > reservation.amount) {
            return Promise.resolve({ status: "amount-exceeded" as const });
          }
          const settled = {
            ...reservation,
            releasedAmount: reservation.amount - usage.amount,
            settledAmount: usage.amount,
            settledAt: usage.recordedAt,
            state: "settled" as const,
            usageEntryId: usage.usageEntryId,
          };
          this.reservation = settled;
          return Promise.resolve({
            reservation: settled,
            status: "settled" as const,
            usage,
          });
        },
      },
      routingDecisions: {
        insert: (_scope, decision) => {
          this.routingDecisions.push(decision);
          return Promise.resolve();
        },
      },
      stepEvents: {
        append: (_scope, event) => {
          this.events.push(event);
          return Promise.resolve();
        },
      },
      stepRouting: {
        request: () => Promise.resolve(),
      },
      steps: {
        getContextByStepIdForUpdate: async () => ({
          plan: this.plan,
          run: this.run,
          ...(this.stepRun === undefined ? {} : { stepRun: this.stepRun }),
          succeededNodeKeys: this.succeededNodeKeys,
        }),
        getContextForUpdate: async () => ({
          plan: this.plan,
          run: this.run,
          ...(this.stepRun === undefined ? {} : { stepRun: this.stepRun }),
          succeededNodeKeys: this.succeededNodeKeys,
        }),
        insert: (_scope, stepRun) => {
          this.stepRun = stepRun;
          return Promise.resolve();
        },
        update: (_scope, expectedVersion, stepRun) => {
          if (this.stepRun?.aggregateVersion !== expectedVersion) {
            return Promise.reject(new Error("Unexpected step version."));
          }
          this.stepRun = stepRun;
          return Promise.resolve();
        },
      },
    };
    return work(unitOfWork);
  }
}

const input = (overrides: Partial<ClaimStepAttemptInput> = {}) => ({
  actorId: actorId("agent-step"),
  attemptId: attemptId("attempt-step"),
  commandIdempotencyKey: idempotencyKey("claim-step"),
  correlationId: correlationId("correlation-step"),
  costReservationId: costReservationId("reservation-step"),
  expectedAggregateVersion: "absent" as const,
  nodeKey: "summarize",
  operationKey: operationKey("operation-step"),
  reason: "initial" as const,
  routeKey: "route-local",
  runId: runId("run-step"),
  stepRunId: stepRunId("step-run"),
  workspaceId: workspace,
  ...overrides,
});

const makeClaim = (persistence: FakeStepExecutionPersistence) => {
  let nextEvent = 0;
  let nextOutbox = 0;
  return makeClaimStepAttempt({
    clock: { now: async () => instant(2000) },
    identifiers: {
      nextEventId: async () => eventId(`step-event-${++nextEvent}`),
      nextOutboxMessageId: async () =>
        outboxMessageId(`step-outbox-${++nextOutbox}`),
    },
    persistence,
    requiredPermission: "steps:execute",
  });
};

test("schedules, reserves and claims one durable attempt before replaying", async () => {
  const persistence = new FakeStepExecutionPersistence();
  const claim = makeClaim(persistence);

  const first = await claim(input());
  const replay = await claim(input());

  assert.equal(first.ok, true);
  assert.equal(replay.ok, true);
  if (first.ok && replay.ok) {
    assert.equal(first.value.replayed, false);
    assert.equal(first.value.reservationStatus, "created");
    assert.equal(first.value.stepRun.state, "active");
    assert.equal(replay.value.replayed, true);
    assert.equal(replay.value.reservationStatus, "existing");
  }
  assert.equal(persistence.attempts.length, 1);
  assert.equal(persistence.events.length, 4);
  assert.equal(persistence.leafOutbox.length, 1);
  assert.equal(persistence.leafOutbox[0]?.messageId, "step-outbox-1");
  assert.equal(persistence.leafOutbox[0]?.eventId, "step-event-4");
  assert.equal(
    persistence.leafOutbox[0]?.effectAdapterKey,
    "deterministic-local"
  );
  assert.equal(
    persistence.leafOutbox[0]?.destination,
    "orchestration.step.attempt.claimed"
  );
  assert.equal(persistence.leafOutbox[0]?.aggregateVersion, 2);
  assert.equal(persistence.reservation?.amount, 2);
  assert.equal(persistence.routingDecisions.length, 1);
});

test("rejects budget exhaustion without creating step state", async () => {
  const persistence = new FakeStepExecutionPersistence();
  persistence.plan = plan([], 6);
  const result = await makeClaim(persistence)(input());

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, "budget-exceeded");
  }
  assert.equal(persistence.stepRun, undefined);
  assert.equal(persistence.attempts.length, 0);
  assert.equal(persistence.events.length, 0);
});

test("rejects a dependent node until every predecessor succeeded", async () => {
  const persistence = new FakeStepExecutionPersistence();
  persistence.plan = plan(["extract"]);
  const result = await makeClaim(persistence)(input());

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.domainCode, "dependencies-unsatisfied");
  }
  assert.equal(persistence.reservation, undefined);
});

test("detects changed claim content under an accepted idempotency key", async () => {
  const persistence = new FakeStepExecutionPersistence();
  const claim = makeClaim(persistence);
  assert.equal((await claim(input())).ok, true);
  const changed = await claim(input({ routeKey: "route-other" }));

  assert.equal(changed.ok, false);
  if (!changed.ok) {
    assert.equal(changed.error.domainCode, "idempotency-key-reused");
  }
  assert.equal(persistence.attempts.length, 1);
});

test("refuses a new attempt once the run stops", async () => {
  const persistence = new FakeStepExecutionPersistence();
  persistence.run = run("cancelling");
  const result = await makeClaim(persistence)(input());

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, "run-not-running");
  }
  assert.equal(persistence.reservation, undefined);
});

test("binds a fresh claim to the authority subject and supported version", async () => {
  const wrongActor = new FakeStepExecutionPersistence();
  const actorResult = await makeClaim(wrongActor)(
    input({ actorId: actorId("agent-other") })
  );
  assert.equal(actorResult.ok, false);
  if (!actorResult.ok) {
    assert.equal(actorResult.error.code, "authority-subject-mismatch");
  }

  const wrongVersion = new FakeStepExecutionPersistence();
  wrongVersion.plan = {
    ...wrongVersion.plan,
    authority: { ...wrongVersion.plan.authority, version: "2.0.0" },
  };
  const versionResult = await makeClaim(wrongVersion)(input());
  assert.equal(versionResult.ok, false);
  if (!versionResult.ok) {
    assert.equal(versionResult.error.code, "authority-version-unsupported");
  }
});

test("requires a caller-owned aggregate fence for a fresh claim", async () => {
  const persistence = new FakeStepExecutionPersistence();
  const claim = makeClaim(persistence);
  assert.equal((await claim(input())).ok, true);

  const stale = await claim(
    input({
      attemptId: attemptId("attempt-step-stale"),
      commandIdempotencyKey: idempotencyKey("claim-step-stale"),
      costReservationId: costReservationId("reservation-step-stale"),
    })
  );
  assert.equal(stale.ok, false);
  if (!stale.ok) {
    assert.equal(stale.error.code, "step-version-conflict");
  }
});

test("accepts finite fractional reservations", async () => {
  const persistence = new FakeStepExecutionPersistence();
  persistence.plan = plan([], 0.11);
  const result = await makeClaim(persistence)(input());

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.value.reservationStatus, "created");
  }
  assert.equal(persistence.reservation?.amount, 0.11);
});
