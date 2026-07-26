import assert from "node:assert/strict";
import test from "node:test";

import {
  type ActorId,
  type AttemptId,
  actorId,
  applyStepCommand,
  attemptId,
  capabilityId,
  contentHash,
  correlationId,
  costReservationId,
  eventId,
  type IdempotencyKey,
  idempotencyKey,
  instant,
  operationKey,
  type Run,
  type RunPlan,
  routingDecisionId,
  runId,
  runPlanId,
  scheduleStep,
  stepRunId,
  usageEntryId,
  workflowSpecId,
  workspaceId,
} from "@kurobara/kernel";
import type {
  StepExecutionPersistencePort,
  StepExecutionUnitOfWork,
  ValidatedRunInput,
  WorkspaceScope,
} from "@kurobara/ports";

import {
  makeExecuteLeafAttempt,
  makeExecuteLeafAttemptRegistry,
  makeRecordLeafAttemptNotStarted,
  makeTransitionStepAttempt,
  type TransitionStepAttemptInput,
} from "../src/index.ts";

const hash = (character: string) =>
  contentHash(`sha256:${character.repeat(64)}`);
const workspace = workspaceId("workspace-transition-step");
const actor = actorId("agent-transition-step");
const attempt = attemptId("attempt-transition-step");
const step = stepRunId("step-transition-step");
const FORCED_STEP_UPDATE_FAILURE = /forced step update failure/u;

const run: Run = {
  aggregateVersion: 2,
  createdAt: instant(1000),
  eventSequence: 2,
  idempotencyKey: idempotencyKey("create-transition-run"),
  intentionHash: hash("a"),
  resultCompleteness: "none",
  runId: runId("run-transition-step"),
  runPlanId: runPlanId("plan-transition-step"),
  state: "running",
  workspaceId: workspace,
};
const capability = {
  capabilityId: capabilityId("documents.summarize"),
  capabilityVersion: "1.0.0",
};
const plan: RunPlan = {
  authority: {
    authorityEnvelopeId: "authority-transition-step",
    budgetLimit: { limit: 10, reserved: 0, spent: 0, unit: "credits" },
    capabilities: [capability],
    deadline: instant(10_000),
    permissions: ["steps:execute"],
    subjectActorId: actor,
    version: "1.0.0",
    workspaceId: workspace,
  },
  budget: { limit: 5, reserved: 0, spent: 0, unit: "credits" },
  catalogFingerprint: hash("b"),
  catalogVersion: "1.0.0",
  compiledWorkflow: {
    compilerVersion: "1.0.0",
    fingerprint: "transition-workflow-fingerprint",
    nodes: [{ capability, dependsOn: [], depth: 0, key: "summarize" }],
    workflowContentHash: hash("c"),
    workflowRevision: "1.0.0",
    workflowSpecId: workflowSpecId("workflow-transition-step"),
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
    quoteId: "quote-transition-step",
    unit: "credits",
    upperBound: 5,
  },
  retryPolicy: { maxAttemptsPerStep: 3 },
  runPlanId: runPlanId("plan-transition-step"),
  workspaceId: workspace,
};

const validatedRunInput = (): ValidatedRunInput => ({
  classification: "internal",
  contentHash: plan.normalizedInputHash,
  contract: plan.inputContract,
  finalizedAt: instant(1000),
  inputId: "run_input_transition_step",
  mediaType: "application/json",
  sizeBytes: 24,
  validatedAt: instant(1000),
  validatorVersion: "validator-input-test-v1",
  value: { document: "synthetic" },
});

const claimedStep = () => {
  const scheduled = scheduleStep({
    actorId: actor,
    correlationId: correlationId("correlation-transition-step"),
    createdAt: instant(1000),
    dependsOn: [],
    eventId: eventId("event-transition-ready"),
    nodeKey: "summarize",
    runId: run.runId,
    runState: "running",
    satisfiedDependencies: [],
    stepRunId: step,
    workspaceId: workspace,
  });
  if (!scheduled.ok) {
    throw new Error(scheduled.error.message);
  }
  const claimed = applyStepCommand(
    scheduled.value.stepRun,
    {
      preparation: {
        attemptId: attempt,
        authorityEnvelopeId: "authority-transition-step",
        costReservationId: costReservationId("reservation-transition-step"),
        effectAdapterKey: "deterministic-local",
        operationKey: operationKey("operation-transition-step"),
        reason: "initial",
        reservationUnit: "credits",
        reservedAmount: 2,
        routeKey: "route-local",
        routeSnapshotHash: hash("3"),
        routingDecisionId: routingDecisionId("route-transition-step"),
      },
      type: "ClaimStepAttempt",
    },
    {
      actorId: actor,
      commandIdentity: {
        commandHash: hash("4"),
        idempotencyKey: idempotencyKey("claim-transition-step"),
      },
      correlationId: correlationId("correlation-transition-step"),
      eventIds: [
        eventId("event-transition-routed"),
        eventId("event-transition-created"),
        eventId("event-transition-claimed"),
      ],
      expectedAggregateVersion: 1,
      occurredAt: instant(1100),
    }
  );
  if (!claimed.ok) {
    throw new Error(claimed.error.message);
  }
  return claimed.value.stepRun;
};

class FakeTransitionPersistence implements StepExecutionPersistencePort {
  artifacts: import("@kurobara/kernel").Artifact[] = [];
  attempts = (() => {
    const claimed = claimedStep().attempts[0];
    if (claimed === undefined) {
      throw new Error("The fixture must contain its claimed attempt.");
    }
    return [claimed];
  })();
  events: import("@kurobara/kernel").StepLifecycleEvent[] = [];
  proofs = new Map<string, import("@kurobara/kernel").StepCommandReplayProof>();
  reservation: import("@kurobara/kernel").CostReservation = {
    amount: 2,
    attemptId: attempt,
    createdAt: instant(1100),
    operationKey: operationKey("operation-transition-step"),
    reservationId: costReservationId("reservation-transition-step"),
    runId: run.runId,
    state: "reserved",
    stepRunId: step,
    unit: "credits",
    workspaceId: workspace,
  };
  stepRun = claimedStep();
  usage: import("@kurobara/kernel").UsageEntry | undefined;
  corruptSettlementReceipt = false;
  failStepUpdate = false;
  parentAuthorizations = 0;
  parentDenial: Readonly<{ code: string; message: string }> | undefined;
  parentAmbiguities = 0;
  plan = plan;
  routingFailuresRemaining = 0;
  run = run;
  runInput: ValidatedRunInput | undefined = undefined;
  routedSteps: import("@kurobara/kernel").StepRunId[] = [];
  scheduledRuns: import("@kurobara/kernel").RunId[] = [];
  useParentEffects = false;

  transaction<Value>(
    _scope: WorkspaceScope,
    work: (unitOfWork: StepExecutionUnitOfWork) => Promise<Value>
  ): Promise<Value> {
    const snapshot = {
      artifacts: [...this.artifacts],
      attempts: [...this.attempts],
      events: [...this.events],
      parentAmbiguities: this.parentAmbiguities,
      parentAuthorizations: this.parentAuthorizations,
      proofs: new Map(this.proofs),
      reservation: this.reservation,
      routedSteps: [...this.routedSteps],
      scheduledRuns: [...this.scheduledRuns],
      stepRun: this.stepRun,
      usage: this.usage,
    };
    return work({
      artifacts: {
        insert: (_scope, artifact) => {
          this.artifacts.push(artifact);
          return Promise.resolve();
        },
      },
      attempts: {
        insert: () => Promise.reject(new Error("insert not expected")),
        update: (_scope, expectedState, nextAttempt) => {
          const index = this.attempts.findIndex(
            (candidate) => candidate.attemptId === nextAttempt.attemptId
          );
          if (index < 0 || this.attempts[index]?.state !== expectedState) {
            return Promise.reject(new Error("attempt conflict"));
          }
          this.attempts[index] = nextAttempt;
          return Promise.resolve();
        },
      },
      commandJournal: {
        find: async (_scope, _stepRunId, key) => this.proofs.get(key),
        insert: (_scope, proof) => {
          this.proofs.set(proof.identity.idempotencyKey, proof);
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
        append: () => Promise.reject(new Error("outbox append not expected")),
      },
      ...(this.useParentEffects
        ? {
            parentEffects: {
              authorize: () => {
                this.parentAuthorizations += 1;
                return Promise.resolve(
                  this.parentDenial === undefined
                    ? ({ status: "authorized" } as const)
                    : ({
                        ...this.parentDenial,
                        status: "denied",
                      } as const)
                );
              },
              markAmbiguous: () => {
                this.parentAmbiguities += 1;
                return Promise.resolve({ status: "authorized" as const });
              },
            },
          }
        : {}),
      reservations: {
        release: (_scope, release) => {
          if (
            this.reservation.state === "settled" ||
            this.reservation.attemptId !== release.attemptId
          ) {
            return Promise.resolve({ status: "conflict" as const });
          }
          if (this.reservation.state === "released") {
            return Promise.resolve({
              reservation: this.reservation,
              status: "existing" as const,
            });
          }
          this.reservation = {
            ...this.reservation,
            releasedAt: release.releasedAt,
            state: "released",
          };
          return Promise.resolve({
            reservation: this.reservation,
            status: "released" as const,
          });
        },
        reserve: () => Promise.reject(new Error("reserve not expected")),
        settle: (_scope, usage) => {
          if (this.reservation.state === "released") {
            return Promise.resolve({ status: "conflict" as const });
          }
          if (usage.amount > this.reservation.amount) {
            return Promise.resolve({ status: "amount-exceeded" as const });
          }
          if (this.reservation.state === "settled") {
            return this.usage?.usageEntryId === usage.usageEntryId
              ? Promise.resolve({
                  reservation: this.reservation,
                  status: "existing" as const,
                  usage: this.usage,
                })
              : Promise.resolve({ status: "conflict" as const });
          }
          if (this.corruptSettlementReceipt) {
            return Promise.resolve({
              reservation: {
                ...this.reservation,
                releasedAmount: 0,
                settledAmount: usage.amount,
                settledAt: usage.recordedAt,
                state: "settled" as const,
                usageEntryId: usage.usageEntryId,
              },
              status: "settled" as const,
              usage,
            });
          }
          this.usage = usage;
          this.reservation = {
            ...this.reservation,
            releasedAmount: this.reservation.amount - usage.amount,
            settledAmount: usage.amount,
            settledAt: usage.recordedAt,
            state: "settled",
            usageEntryId: usage.usageEntryId,
          };
          return Promise.resolve({
            reservation: this.reservation,
            status: "settled" as const,
            usage,
          });
        },
      },
      routingDecisions: {
        insert: () => Promise.reject(new Error("insert not expected")),
      },
      stepEvents: {
        append: (_scope, event) => {
          this.events.push(event);
          return Promise.resolve();
        },
      },
      stepRouting: {
        request: (_scope, requestedStepRunId) => {
          if (this.routingFailuresRemaining > 0) {
            this.routingFailuresRemaining -= 1;
            return Promise.reject(new Error("routing request unavailable"));
          }
          this.routedSteps.push(requestedStepRunId);
          return Promise.resolve();
        },
      },
      steps: {
        getContextByStepIdForUpdate: async () => ({
          plan: this.plan,
          run: this.run,
          stepRun: this.stepRun,
          succeededNodeKeys: [],
        }),
        getContextForUpdate: () =>
          Promise.reject(new Error("run lookup not expected")),
        insert: () => Promise.reject(new Error("insert not expected")),
        update: (_scope, expectedVersion, nextStep) => {
          if (this.stepRun.aggregateVersion !== expectedVersion) {
            return Promise.reject(new Error("step conflict"));
          }
          if (this.failStepUpdate) {
            return Promise.reject(new Error("forced step update failure"));
          }
          this.stepRun = nextStep;
          return Promise.resolve();
        },
      },
    }).catch((error: unknown) => {
      this.artifacts = snapshot.artifacts;
      this.attempts = snapshot.attempts;
      this.events = snapshot.events;
      this.proofs = snapshot.proofs;
      this.parentAmbiguities = snapshot.parentAmbiguities;
      this.parentAuthorizations = snapshot.parentAuthorizations;
      this.reservation = snapshot.reservation;
      this.routedSteps = snapshot.routedSteps;
      this.scheduledRuns = snapshot.scheduledRuns;
      this.stepRun = snapshot.stepRun;
      this.usage = snapshot.usage;
      throw error;
    });
  }
}

type TransitionOverrides = Partial<{
  actorId: ActorId;
  attemptId: AttemptId;
  commandIdempotencyKey: IdempotencyKey;
  expectedAggregateVersion: number;
  outcome: "succeeded" | "failed_retryable" | "failed_terminal";
  proofId: string;
  retryable: boolean;
  settlement: import("../src/index.ts").StepCostSettlement;
  type: TransitionStepAttemptInput["type"];
}>;

const input = (
  overrides: TransitionOverrides = {}
): TransitionStepAttemptInput =>
  ({
    actorId: actor,
    attemptId: attempt,
    commandIdempotencyKey: idempotencyKey("start-transition-step"),
    correlationId: correlationId("correlation-transition-step"),
    expectedAggregateVersion: 2,
    stepRunId: step,
    type: "StartAttemptEffect",
    workspaceId: workspace,
    ...overrides,
  }) as TransitionStepAttemptInput;

const makeTransition = (persistence: FakeTransitionPersistence) => {
  let nextEvent = 0;
  return makeTransitionStepAttempt({
    clock: { now: async () => instant(2000 + nextEvent) },
    identifiers: {
      nextEventId: async () => eventId(`event-transition-${++nextEvent}`),
    },
    persistence,
    requiredPermission: "steps:execute",
  });
};

test("grants the effect threshold once and returns replay-only afterwards", async () => {
  const persistence = new FakeTransitionPersistence();
  const transition = makeTransition(persistence);

  const first = await transition(input());
  const replay = await transition(input());

  assert.equal(first.ok, true);
  assert.equal(replay.ok, true);
  if (first.ok && replay.ok) {
    assert.equal(first.value.effectPermission, "granted");
    assert.equal(replay.value.effectPermission, "replay-only");
    assert.equal(replay.value.stepRun.aggregateVersion, 3);
  }
  assert.equal(persistence.events.length, 1);
  assert.equal(persistence.attempts[0]?.state, "in_flight");
  assert.deepEqual(persistence.scheduledRuns, []);
});

test("authorizes a parent aggregate in the same threshold transaction", async () => {
  const persistence = new FakeTransitionPersistence();
  persistence.useParentEffects = true;
  const transition = makeTransition(persistence);

  const first = await transition(input());
  const replay = await transition(input());

  assert.equal(first.ok, true);
  assert.equal(replay.ok, true);
  assert.equal(persistence.parentAuthorizations, 1);
  assert.equal(persistence.stepRun.attempts[0]?.state, "in_flight");
});

test("rolls back the effect threshold when its parent denies authorization", async () => {
  const persistence = new FakeTransitionPersistence();
  persistence.useParentEffects = true;
  persistence.parentDenial = {
    code: "dataset-generation-budget-exhausted",
    message: "The generation budget cannot authorize this page.",
  };
  const transition = makeTransition(persistence);

  const result = await transition(input());

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, "transition-rejected");
    assert.equal(
      result.error.domainCode,
      "dataset-generation-budget-exhausted"
    );
  }
  assert.equal(persistence.parentAuthorizations, 1);
  assert.equal(persistence.stepRun.attempts[0]?.state, "claimed");
  assert.equal(persistence.proofs.size, 0);
});

test("settles usage and the step atomically before replaying without a second movement", async () => {
  const persistence = new FakeTransitionPersistence();
  const transition = makeTransition(persistence);
  assert.equal((await transition(input())).ok, true);
  const settleInput = input({
    commandIdempotencyKey: idempotencyKey("settle-transition-step"),
    expectedAggregateVersion: 3,
    settlement: {
      amount: 1,
      kind: "settle",
      unit: "credits",
      usageEntryId: usageEntryId("usage-transition-step"),
    },
    type: "RecordAttemptSucceeded",
  });

  const settled = await transition(settleInput);
  const replay = await transition(settleInput);

  assert.equal(settled.ok, true);
  assert.equal(replay.ok, true);
  if (settled.ok && replay.ok) {
    assert.equal(settled.value.settlementStatus, "settled");
    assert.equal(settled.value.stepRun.state, "succeeded");
    assert.equal(replay.value.replayed, true);
  }
  assert.equal(persistence.reservation.state, "settled");
  assert.equal(persistence.usage?.amount, 1);
  assert.equal(persistence.events.length, 2);
  assert.deepEqual(persistence.scheduledRuns, [run.runId, run.runId]);
});

test("rejects a stale attempt and aggregate fence without moving the ledger", async () => {
  const persistence = new FakeTransitionPersistence();
  const transition = makeTransition(persistence);
  const wrongAttempt = await transition(
    input({ attemptId: attemptId("attempt-stale") })
  );
  const wrongVersion = await transition(input({ expectedAggregateVersion: 1 }));

  assert.equal(wrongAttempt.ok, false);
  assert.equal(wrongVersion.ok, false);
  if (!(wrongAttempt.ok || wrongVersion.ok)) {
    assert.equal(wrongAttempt.error.domainCode, "attempt-id-mismatch");
    assert.equal(wrongVersion.error.domainCode, "aggregate-version-conflict");
  }
  assert.equal(persistence.reservation.state, "reserved");
  assert.equal(persistence.events.length, 0);
});

test("keeps an unknown effect reserved until proof resolves and routes its retry", async () => {
  const persistence = new FakeTransitionPersistence();
  const transition = makeTransition(persistence);
  assert.equal((await transition(input())).ok, true);
  const ambiguous = await transition(
    input({
      commandIdempotencyKey: idempotencyKey("ambiguous-transition-step"),
      expectedAggregateVersion: 3,
      type: "MarkAttemptAmbiguous",
    })
  );
  assert.equal(ambiguous.ok, true);
  assert.equal(persistence.reservation.state, "reserved");

  const resolved = await transition(
    input({
      commandIdempotencyKey: idempotencyKey("resolve-transition-step"),
      expectedAggregateVersion: 4,
      outcome: "failed_retryable",
      proofId: "effect-absent-proof",
      settlement: { kind: "release" },
      type: "ResolveAttemptAmbiguity",
    })
  );
  assert.equal(resolved.ok, true);
  if (resolved.ok) {
    assert.equal(resolved.value.stepRun.state, "ready");
    assert.equal(resolved.value.settlementStatus, "released");
  }
  assert.deepEqual(persistence.routedSteps, [step]);
  assert.deepEqual(
    persistence.events.slice(-2).map(({ eventType }) => eventType),
    ["AttemptAmbiguityResolved", "StepRetryAuthorized"]
  );
});

test("binds command replay to the actor that accepted it", async () => {
  const persistence = new FakeTransitionPersistence();
  const transition = makeTransition(persistence);
  assert.equal((await transition(input())).ok, true);

  const replay = await transition(input({ actorId: actorId("agent-other") }));

  assert.equal(replay.ok, false);
  if (!replay.ok) {
    assert.equal(replay.error.domainCode, "replay-proof-mismatch");
  }
});

test("rejects a fresh command from an actor outside the authority", async () => {
  const persistence = new FakeTransitionPersistence();
  const result = await makeTransition(persistence)(
    input({
      actorId: actorId("agent-other"),
      commandIdempotencyKey: idempotencyKey("fresh-other-actor"),
    })
  );

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, "authority-subject-mismatch");
  }
  assert.equal(persistence.events.length, 0);
  assert.equal(persistence.reservation.state, "reserved");
});

test("rejects an inconsistent ledger receipt before persisting the transition", async () => {
  const persistence = new FakeTransitionPersistence();
  const transition = makeTransition(persistence);
  assert.equal((await transition(input())).ok, true);
  persistence.corruptSettlementReceipt = true;

  await assert.rejects(
    transition(
      input({
        commandIdempotencyKey: idempotencyKey("corrupt-receipt"),
        expectedAggregateVersion: 3,
        settlement: {
          amount: 1,
          kind: "settle",
          unit: "credits",
          usageEntryId: usageEntryId("usage-corrupt-receipt"),
        },
        type: "RecordAttemptSucceeded",
      })
    ),
    { name: "StepSettlementReceiptMismatchError" }
  );
  assert.equal(persistence.stepRun.state, "active");
  assert.equal(persistence.reservation.state, "reserved");
  assert.equal(persistence.events.length, 1);
});

test("settles fractional usage without relying on exact IEEE addition", async () => {
  const persistence = new FakeTransitionPersistence();
  persistence.reservation = { ...persistence.reservation, amount: 0.11 };
  persistence.stepRun = {
    ...persistence.stepRun,
    attempts: persistence.stepRun.attempts.map((candidate) => ({
      ...candidate,
      reservedAmount: 0.11,
    })),
  };
  persistence.attempts = [...persistence.stepRun.attempts];
  const transition = makeTransition(persistence);
  assert.equal((await transition(input())).ok, true);

  const result = await transition(
    input({
      commandIdempotencyKey: idempotencyKey("fractional-usage"),
      expectedAggregateVersion: 3,
      settlement: {
        amount: 0.04,
        kind: "settle",
        unit: "credits",
        usageEntryId: usageEntryId("usage-fractional"),
      },
      type: "RecordAttemptSucceeded",
    })
  );
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.value.stepRun.state, "succeeded");
  }
  assert.equal(persistence.reservation.state, "settled");
  if (persistence.reservation.state === "settled") {
    assert.equal(persistence.reservation.settledAmount, 0.04);
    assert.ok(Math.abs(persistence.reservation.releasedAmount - 0.07) < 1e-12);
  }
});

test("rejects cancellation while running and releases only once the run is cancelling", async () => {
  const persistence = new FakeTransitionPersistence();
  const transition = makeTransition(persistence);
  const rejected = await transition(
    input({
      commandIdempotencyKey: idempotencyKey("cancel-transition-step"),
      type: "CancelAttemptBeforeEffect",
    })
  );
  assert.equal(rejected.ok, false);
  if (!rejected.ok) {
    assert.equal(rejected.error.code, "run-not-cancelling");
  }
  assert.equal(persistence.reservation.state, "reserved");

  persistence.run = { ...persistence.run, state: "cancelling" };
  const cancelled = await transition(
    input({
      commandIdempotencyKey: idempotencyKey("cancel-transition-step-stopping"),
      type: "CancelAttemptBeforeEffect",
    })
  );
  assert.equal(cancelled.ok, true);
  if (cancelled.ok) {
    assert.equal(cancelled.value.settlementStatus, "released");
    assert.equal(cancelled.value.stepRun.state, "cancelled");
  }
  assert.equal(persistence.reservation.state, "released");
});

test("records a not-started attempt as retryable and replays only for its actor", async () => {
  const persistence = new FakeTransitionPersistence();
  const transition = makeTransition(persistence);
  const notStartedInput: Extract<
    TransitionStepAttemptInput,
    { type: "RecordAttemptNotStarted" }
  > = {
    actorId: actor,
    attemptId: attempt,
    commandIdempotencyKey: idempotencyKey("not-started-retryable"),
    correlationId: correlationId("correlation-transition-step"),
    expectedAggregateVersion: 2,
    retryable: true,
    settlement: { kind: "release" },
    stepRunId: step,
    type: "RecordAttemptNotStarted",
    workspaceId: workspace,
  };

  const failed = await transition(notStartedInput);
  const replayed = await transition(notStartedInput);
  const foreignReplay = await transition({
    ...notStartedInput,
    actorId: actorId("agent-other"),
  });
  const changedReplay = await transition({
    ...notStartedInput,
    retryable: false,
  });

  assert.equal(failed.ok, true);
  assert.equal(replayed.ok, true);
  assert.equal(foreignReplay.ok, false);
  assert.equal(changedReplay.ok, false);
  if (failed.ok && replayed.ok && !foreignReplay.ok && !changedReplay.ok) {
    assert.equal(failed.value.stepRun.state, "ready");
    assert.equal(failed.value.stepRun.attempts[0]?.state, "failed_retryable");
    assert.equal(failed.value.stepRun.attempts[0]?.effectStartedAt, undefined);
    assert.equal(failed.value.settlementStatus, "released");
    assert.equal(replayed.value.replayed, true);
    assert.equal(foreignReplay.error.domainCode, "replay-proof-mismatch");
    assert.equal(changedReplay.error.domainCode, "idempotency-key-reused");
  }
  assert.deepEqual(
    persistence.events.map(({ eventType }) => eventType),
    ["AttemptFailed", "StepRetryAuthorized"]
  );
  assert.deepEqual(persistence.routedSteps, [step, step]);
  assert.equal(persistence.reservation.state, "released");
});

test("records a not-started attempt as terminal when retry is refused", async () => {
  const persistence = new FakeTransitionPersistence();
  const result = await makeTransition(persistence)(
    input({
      commandIdempotencyKey: idempotencyKey("not-started-terminal"),
      retryable: false,
      settlement: { kind: "release" },
      type: "RecordAttemptNotStarted",
    })
  );

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.value.stepRun.state, "failed");
    assert.equal(result.value.stepRun.attempts[0]?.state, "failed_terminal");
  }
  assert.equal(persistence.reservation.state, "released");
});

test("normalizes a not-started retry to terminal after its deadline", async () => {
  const persistence = new FakeTransitionPersistence();
  persistence.plan = {
    ...persistence.plan,
    authority: { ...persistence.plan.authority, deadline: instant(2000) },
    deadline: instant(2000),
    retryPolicy: { maxAttemptsPerStep: 2 },
  };
  const result = await makeTransition(persistence)(
    input({
      commandIdempotencyKey: idempotencyKey("not-started-after-deadline"),
      retryable: true,
      settlement: { kind: "release" },
      type: "RecordAttemptNotStarted",
    })
  );

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.value.stepRun.state, "failed");
    assert.equal(result.value.stepRun.attempts[0]?.state, "failed_terminal");
  }
});

test("rejects a not-started conclusion after effect start or terminality", async () => {
  const inFlightPersistence = new FakeTransitionPersistence();
  const inFlightTransition = makeTransition(inFlightPersistence);
  assert.equal((await inFlightTransition(input())).ok, true);
  const afterEffect = await inFlightTransition(
    input({
      commandIdempotencyKey: idempotencyKey("not-started-after-effect"),
      expectedAggregateVersion: 3,
      retryable: true,
      settlement: { kind: "release" },
      type: "RecordAttemptNotStarted",
    })
  );

  const terminalPersistence = new FakeTransitionPersistence();
  const terminalTransition = makeTransition(terminalPersistence);
  assert.equal(
    (
      await terminalTransition(
        input({
          commandIdempotencyKey: idempotencyKey("not-started-first-terminal"),
          retryable: false,
          settlement: { kind: "release" },
          type: "RecordAttemptNotStarted",
        })
      )
    ).ok,
    true
  );
  const afterTerminal = await terminalTransition(
    input({
      commandIdempotencyKey: idempotencyKey("not-started-after-terminal"),
      expectedAggregateVersion: 3,
      retryable: true,
      settlement: { kind: "release" },
      type: "RecordAttemptNotStarted",
    })
  );

  assert.equal(afterEffect.ok, false);
  assert.equal(afterTerminal.ok, false);
  if (!(afterEffect.ok || afterTerminal.ok)) {
    assert.equal(afterEffect.error.domainCode, "invalid-transition");
    assert.equal(afterTerminal.error.domainCode, "invalid-transition");
  }
  assert.equal(inFlightPersistence.reservation.state, "reserved");
});

test("rolls back a not-started release when step persistence fails", async () => {
  const persistence = new FakeTransitionPersistence();
  persistence.failStepUpdate = true;

  await assert.rejects(
    makeTransition(persistence)(
      input({
        commandIdempotencyKey: idempotencyKey("not-started-rollback"),
        retryable: true,
        settlement: { kind: "release" },
        type: "RecordAttemptNotStarted",
      })
    ),
    FORCED_STEP_UPDATE_FAILURE
  );

  assert.equal(persistence.stepRun.state, "active");
  assert.equal(persistence.attempts[0]?.state, "claimed");
  assert.equal(persistence.reservation.state, "reserved");
  assert.equal(persistence.events.length, 0);
  assert.equal(persistence.proofs.size, 0);
});

test("terminalizes the last retryable failure at the immutable attempt limit", async () => {
  const persistence = new FakeTransitionPersistence();
  persistence.plan = {
    ...persistence.plan,
    retryPolicy: { maxAttemptsPerStep: 1 },
  };
  const transition = makeTransition(persistence);
  assert.equal((await transition(input())).ok, true);
  const failed = await transition(
    input({
      commandIdempotencyKey: idempotencyKey("failure-before-retry-limit"),
      expectedAggregateVersion: 3,
      retryable: true,
      settlement: { kind: "release" },
      type: "RecordAttemptFailure",
    })
  );
  assert.equal(failed.ok, true);
  if (failed.ok) {
    assert.equal(failed.value.stepRun.state, "failed");
    assert.equal(failed.value.stepRun.attempts[0]?.state, "failed_terminal");
  }
  const replayedFailure = await transition(
    input({
      commandIdempotencyKey: idempotencyKey("failure-before-retry-limit"),
      expectedAggregateVersion: 3,
      retryable: true,
      settlement: { kind: "release" },
      type: "RecordAttemptFailure",
    })
  );
  assert.equal(replayedFailure.ok, true);
  if (replayedFailure.ok) {
    assert.equal(replayedFailure.value.replayed, true);
  }
});

test("terminalizes a retryable failure once the execution deadline has elapsed", async () => {
  const persistence = new FakeTransitionPersistence();
  persistence.plan = {
    ...persistence.plan,
    authority: { ...persistence.plan.authority, deadline: instant(2001) },
    deadline: instant(2001),
    retryPolicy: { maxAttemptsPerStep: 2 },
  };
  const transition = makeTransition(persistence);
  assert.equal((await transition(input())).ok, true);
  const failureInput = input({
    commandIdempotencyKey: idempotencyKey("failure-after-deadline"),
    expectedAggregateVersion: 3,
    retryable: true,
    settlement: { kind: "release" },
    type: "RecordAttemptFailure",
  });
  const failed = await transition(failureInput);
  const replayed = await transition(failureInput);

  assert.equal(failed.ok, true);
  assert.equal(replayed.ok, true);
  if (failed.ok && replayed.ok) {
    assert.equal(failed.value.stepRun.state, "failed");
    assert.equal(failed.value.stepRun.attempts[0]?.state, "failed_terminal");
    assert.equal(replayed.value.replayed, true);
  }
});

test("terminalizes a retryable provider outcome when cancellation wins the race", async () => {
  const persistence = new FakeTransitionPersistence();
  persistence.plan = {
    ...persistence.plan,
    retryPolicy: { maxAttemptsPerStep: 2 },
  };
  const transition = makeTransition(persistence);
  assert.equal((await transition(input())).ok, true);
  persistence.run = { ...persistence.run, state: "cancelling" };
  const failed = await transition(
    input({
      commandIdempotencyKey: idempotencyKey("failure-before-run-waits"),
      expectedAggregateVersion: 3,
      retryable: true,
      settlement: { kind: "release" },
      type: "RecordAttemptFailure",
    })
  );
  assert.equal(failed.ok, true);
  if (failed.ok) {
    assert.equal(failed.value.stepRun.state, "failed");
    assert.equal(failed.value.stepRun.attempts[0]?.state, "failed_terminal");
  }
  assert.deepEqual(persistence.routedSteps, []);
  assert.deepEqual(persistence.scheduledRuns, [run.runId]);
  assert.deepEqual(
    persistence.events.slice(-2).map(({ eventType }) => eventType),
    ["AttemptFailed", "StepRetryExhausted"]
  );
});

test("terminalizes not-started and reconciled retry outcomes during cancellation", async () => {
  const notStartedPersistence = new FakeTransitionPersistence();
  notStartedPersistence.run = {
    ...notStartedPersistence.run,
    state: "cancelling",
  };
  const notStarted = await makeTransition(notStartedPersistence)(
    input({
      commandIdempotencyKey: idempotencyKey("not-started-cancellation-race"),
      retryable: true,
      settlement: { kind: "release" },
      type: "RecordAttemptNotStarted",
    })
  );

  assert.equal(notStarted.ok, true);
  if (notStarted.ok) {
    assert.equal(notStarted.value.stepRun.state, "failed");
    assert.equal(
      notStarted.value.stepRun.attempts[0]?.state,
      "failed_terminal"
    );
  }
  assert.deepEqual(notStartedPersistence.scheduledRuns, [run.runId]);
  assert.deepEqual(
    notStartedPersistence.events.map(({ eventType }) => eventType),
    ["AttemptFailed", "StepRetryExhausted"]
  );

  const ambiguityPersistence = new FakeTransitionPersistence();
  const resolve = makeTransition(ambiguityPersistence);
  assert.equal((await resolve(input())).ok, true);
  assert.equal(
    (
      await resolve(
        input({
          commandIdempotencyKey: idempotencyKey("ambiguity-cancellation-race"),
          expectedAggregateVersion: 3,
          type: "MarkAttemptAmbiguous",
        })
      )
    ).ok,
    true
  );
  ambiguityPersistence.run = {
    ...ambiguityPersistence.run,
    state: "cancelling",
  };
  const resolved = await resolve(
    input({
      commandIdempotencyKey: idempotencyKey("resolve-cancellation-race"),
      expectedAggregateVersion: 4,
      outcome: "failed_retryable",
      proofId: "provider-absent-during-cancellation",
      settlement: { kind: "release" },
      type: "ResolveAttemptAmbiguity",
    })
  );

  assert.equal(resolved.ok, true);
  if (resolved.ok) {
    assert.equal(resolved.value.stepRun.state, "failed");
    assert.equal(resolved.value.stepRun.attempts[0]?.state, "failed_terminal");
  }
  assert.deepEqual(ambiguityPersistence.scheduledRuns, [run.runId]);
  assert.deepEqual(
    ambiguityPersistence.events.slice(-2).map(({ eventType }) => eventType),
    ["AttemptAmbiguityResolved", "StepRetryExhausted"]
  );
});

test("terminalizes a legacy retryable step when authorization is exhausted", async () => {
  const persistence = new FakeTransitionPersistence();
  const legacyAttempt = persistence.stepRun.attempts[0];
  if (legacyAttempt === undefined) {
    throw new Error("The fixture must contain its claimed attempt.");
  }
  persistence.stepRun = {
    ...persistence.stepRun,
    activeAttemptId: undefined,
    aggregateVersion: 3,
    attempts: [
      {
        ...legacyAttempt,
        finishedAt: instant(1900),
        state: "failed_retryable",
      },
    ],
    state: "retryable",
  };
  persistence.attempts = [...persistence.stepRun.attempts];
  persistence.reservation = {
    ...persistence.reservation,
    releasedAt: instant(1900),
    state: "released",
  };
  persistence.plan = {
    ...persistence.plan,
    authority: { ...persistence.plan.authority, deadline: instant(1500) },
    deadline: instant(1500),
    retryPolicy: { maxAttemptsPerStep: 1 },
  };
  const exhausted = await makeTransition(persistence)(
    input({
      commandIdempotencyKey: idempotencyKey("legacy-retry-exhausted"),
      expectedAggregateVersion: 3,
      type: "AuthorizeRetry",
    })
  );
  assert.equal(exhausted.ok, true);
  if (exhausted.ok) {
    assert.equal(exhausted.value.stepRun.state, "failed");
  }
});

const leafRequest = (startKey: string) => ({
  attemptId: attempt,
  eventId: eventId("event-leaf-execution"),
  runId: run.runId,
  startKey,
  stepRunId: step,
  workspaceId: workspace,
});

const makeLeafExecution = (
  persistence: FakeTransitionPersistence,
  effect: Parameters<typeof makeExecuteLeafAttempt>[0]["effect"],
  startKey: string,
  outputValidator: Parameters<
    typeof makeExecuteLeafAttempt
  >[0]["outputValidator"] = {
    validate: () =>
      Promise.resolve({
        status: "accepted" as const,
        validatorVersion: "validator-test-v1",
      }),
  }
) => {
  let nextEvent = 0;
  return makeExecuteLeafAttempt({
    clock: { now: async () => instant(2000 + nextEvent) },
    effect,
    identifiers: {
      nextEventId: async () => eventId(`event-leaf-${++nextEvent}`),
    },
    outputValidator,
    persistence,
    queries: {
      getContextByStepId: () =>
        Promise.resolve({
          plan: persistence.plan,
          run: persistence.run,
          ...(persistence.runInput === undefined
            ? {}
            : { runInput: persistence.runInput }),
          stepRun: persistence.stepRun,
          succeededNodeKeys: [],
        }),
      getLeafExecutionIdentity: () =>
        Promise.resolve({
          attemptId: attempt,
          effectAdapterKey: "effect-test-v1",
          eventId: eventId("event-leaf-execution"),
          runId: run.runId,
          startKey,
          stepRunId: step,
          workspaceId: workspace,
        }),
    },
    requiredPermission: "steps:execute",
  });
};

test("executes and settles a fresh leaf effect exactly once", async () => {
  const persistence = new FakeTransitionPersistence();
  persistence.runInput = validatedRunInput();
  const startKey = "leaf-start-fresh";
  let executions = 0;
  let lookups = 0;
  let observedInput: ValidatedRunInput | undefined;
  const executeLeaf = makeLeafExecution(
    persistence,
    {
      adapterKey: "effect-test-v1",
      execute: (request) => {
        executions += 1;
        observedInput = request.runInput;
        return Promise.resolve({
          output: { summary: "synthetic" },
          settlement: {
            amount: 1,
            kind: "settle",
            unit: "credits",
            usageEntryId: usageEntryId("usage-leaf-fresh"),
          },
          status: "succeeded" as const,
        });
      },
      lookup: () => {
        lookups += 1;
        return Promise.resolve({
          reason: "unexpected",
          status: "outcome-unknown" as const,
        });
      },
    },
    startKey
  );

  const executed = await executeLeaf(leafRequest(startKey));
  const replayed = await executeLeaf(leafRequest(startKey));

  assert.equal(executed.ok, true);
  assert.equal(replayed.ok, true);
  if (executed.ok && replayed.ok) {
    assert.equal(executed.value.status, "succeeded");
    assert.equal(replayed.value.replayed, true);
  }
  assert.equal(executions, 1);
  assert.equal(lookups, 0);
  assert.deepEqual(observedInput, persistence.runInput);
  assert.equal(persistence.reservation.state, "settled");
  assert.equal(persistence.artifacts.length, 1);
  assert.equal(
    persistence.stepRun.attempts[0]?.output?.artifact.artifactId,
    persistence.artifacts[0]?.artifactId
  );
});

test("terminalizes a sink whose normalized output violates its exact contract", async () => {
  const persistence = new FakeTransitionPersistence();
  const startKey = "leaf-output-rejected";
  const executeLeaf = makeLeafExecution(
    persistence,
    {
      adapterKey: "effect-test-v1",
      execute: () =>
        Promise.resolve({
          output: { summary: "invalid" },
          settlement: {
            amount: 1,
            kind: "settle" as const,
            unit: "credits",
            usageEntryId: usageEntryId("usage-output-rejected"),
          },
          status: "succeeded" as const,
        }),
      lookup: () =>
        Promise.resolve({ reason: "unused", status: "outcome-unknown" }),
    },
    startKey,
    {
      validate: () =>
        Promise.resolve({
          reason: "fixture-contract-violation",
          status: "rejected" as const,
        }),
    }
  );

  const result = await executeLeaf(leafRequest(startKey));

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.value.status, "failed");
  }
  assert.equal(persistence.reservation.state, "settled");
  assert.equal(persistence.artifacts.length, 0);
  assert.equal(persistence.stepRun.attempts[0]?.state, "failed_terminal");
});

test("authorizes and schedules a retryable leaf failure", async () => {
  const persistence = new FakeTransitionPersistence();
  const startKey = "leaf-retryable-failure";
  const executeLeaf = makeLeafExecution(
    persistence,
    {
      adapterKey: "effect-test-v1",
      execute: () =>
        Promise.resolve({
          reason: "provider-unavailable",
          retryable: true,
          settlement: {
            amount: 1,
            kind: "settle" as const,
            unit: "credits",
            usageEntryId: usageEntryId("usage-retryable-failure"),
          },
          status: "failed" as const,
        }),
      lookup: () =>
        Promise.resolve({ reason: "unused", status: "outcome-unknown" }),
    },
    startKey
  );

  const result = await executeLeaf(leafRequest(startKey));

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.value.status, "failed");
    assert.equal(result.value.stepRun.state, "ready");
  }
  assert.equal(persistence.stepRun.attempts[0]?.state, "failed_retryable");
  assert.deepEqual(persistence.routedSteps, [step]);
  assert.equal(persistence.reservation.state, "settled");
  assert.deepEqual(
    persistence.events.map(({ eventType }) => eventType),
    ["AttemptEffectStarted", "AttemptFailed", "StepRetryAuthorized"]
  );
});

test("rolls back settlement and retry authorization when routing enqueue fails", async () => {
  const persistence = new FakeTransitionPersistence();
  const transition = makeTransition(persistence);
  assert.equal((await transition(input())).ok, true);
  persistence.routingFailuresRemaining = 1;
  const failureInput = input({
    commandIdempotencyKey: idempotencyKey("atomic-retry-routing"),
    expectedAggregateVersion: 3,
    retryable: true,
    settlement: {
      amount: 1,
      kind: "settle",
      unit: "credits",
      usageEntryId: usageEntryId("usage-atomic-retry-routing"),
    },
    type: "RecordAttemptFailure",
  });

  await assert.rejects(transition(failureInput), {
    message: "routing request unavailable",
  });
  assert.equal(persistence.stepRun.state, "active");
  assert.equal(persistence.stepRun.attempts[0]?.state, "in_flight");
  assert.equal(persistence.reservation.state, "reserved");
  assert.deepEqual(
    persistence.events.map(({ eventType }) => eventType),
    ["AttemptEffectStarted"]
  );

  const recovered = await transition(failureInput);

  assert.equal(recovered.ok, true);
  if (recovered.ok) {
    assert.equal(recovered.value.replayed, false);
    assert.equal(recovered.value.stepRun.state, "ready");
  }
  assert.deepEqual(persistence.routedSteps, [step]);
  assert.deepEqual(
    persistence.events.map(({ eventType }) => eventType),
    ["AttemptEffectStarted", "AttemptFailed", "StepRetryAuthorized"]
  );
});

test("authorizes and schedules a retryable attempt that never started", async () => {
  const persistence = new FakeTransitionPersistence();
  const startKey = "leaf-retryable-not-started";
  let nextEvent = 0;
  const recordNotStarted = makeRecordLeafAttemptNotStarted({
    clock: { now: async () => instant(2000 + nextEvent) },
    identifiers: {
      nextEventId: async () => eventId(`event-not-started-${++nextEvent}`),
    },
    persistence,
    queries: {
      getContextByStepId: () =>
        Promise.resolve({
          plan: persistence.plan,
          run: persistence.run,
          stepRun: persistence.stepRun,
          succeededNodeKeys: [],
        }),
      getLeafExecutionIdentity: () => Promise.resolve(undefined),
    },
    requiredPermission: "steps:execute",
  });

  const first = await recordNotStarted(leafRequest(startKey), true);
  const replay = await recordNotStarted(leafRequest(startKey), true);

  assert.equal(first.ok, true);
  assert.equal(replay.ok, true);
  if (first.ok && replay.ok) {
    assert.equal(first.value.stepRun.state, "ready");
    assert.equal(replay.value.replayed, true);
  }
  assert.equal(persistence.stepRun.attempts[0]?.state, "failed_retryable");
  assert.deepEqual(persistence.routedSteps, [step]);
  assert.equal(persistence.reservation.state, "released");
  assert.deepEqual(
    persistence.events.map(({ eventType }) => eventType),
    ["AttemptFailed", "StepRetryAuthorized"]
  );
});

test("keeps a proven effect ambiguous when output validation is unavailable", async () => {
  const persistence = new FakeTransitionPersistence();
  const startKey = "leaf-output-validator-unavailable";
  let executions = 0;
  const executeLeaf = makeLeafExecution(
    persistence,
    {
      adapterKey: "effect-test-v1",
      execute: () => {
        executions += 1;
        return Promise.resolve({
          output: { summary: "synthetic" },
          settlement: {
            amount: 1,
            kind: "settle" as const,
            unit: "credits",
            usageEntryId: usageEntryId("usage-validator-unavailable"),
          },
          status: "succeeded" as const,
        });
      },
      lookup: () =>
        Promise.resolve({
          reason: "still-unavailable",
          status: "outcome-unknown",
        }),
    },
    startKey,
    { validate: () => Promise.reject(new Error("validator unavailable")) }
  );

  const first = await executeLeaf(leafRequest(startKey));
  const replay = await executeLeaf(leafRequest(startKey));

  assert.equal(first.ok, true);
  assert.equal(replay.ok, true);
  if (first.ok && replay.ok) {
    assert.equal(first.value.status, "ambiguous");
    assert.equal(replay.value.status, "ambiguous");
  }
  assert.equal(executions, 1);
  assert.equal(persistence.reservation.state, "reserved");
  assert.equal(persistence.artifacts.length, 0);
});

test("recovers a crash after the effect threshold through lookup only", async () => {
  const persistence = new FakeTransitionPersistence();
  const startKey = "leaf-start-recovery";
  const started = await makeTransition(persistence)(
    input({
      commandIdempotencyKey: idempotencyKey(`leaf:${startKey}:start-effect`),
    })
  );
  assert.equal(started.ok, true);
  let executions = 0;
  let lookups = 0;
  const executeLeaf = makeLeafExecution(
    persistence,
    {
      adapterKey: "effect-test-v1",
      execute: () => {
        executions += 1;
        return Promise.resolve({
          reason: "forbidden",
          status: "outcome-unknown" as const,
        });
      },
      lookup: () => {
        lookups += 1;
        return Promise.resolve({
          outcome: {
            output: { summary: "synthetic" },
            settlement: {
              amount: 0,
              kind: "settle",
              unit: "credits",
              usageEntryId: usageEntryId("usage-leaf-recovered"),
            },
            status: "succeeded" as const,
          },
          proofId: "leaf-recovery-proof",
          status: "found" as const,
        });
      },
    },
    startKey
  );

  const recovered = await executeLeaf(leafRequest(startKey));

  assert.equal(recovered.ok, true);
  if (recovered.ok) {
    assert.equal(recovered.value.status, "succeeded");
    assert.equal(recovered.value.replayed, true);
  }
  assert.equal(executions, 0);
  assert.equal(lookups, 1);
  assert.equal(persistence.stepRun.attempts[0]?.state, "succeeded");
  assert.equal(persistence.artifacts.length, 1);
});

test("keeps a post-threshold not-found observation ambiguous until found", async () => {
  const persistence = new FakeTransitionPersistence();
  const startKey = "leaf-start-late-effect";
  const started = await makeTransition(persistence)(
    input({
      commandIdempotencyKey: idempotencyKey(`leaf:${startKey}:start-effect`),
    })
  );
  assert.equal(started.ok, true);
  let executions = 0;
  let lookups = 0;
  const executeLeaf = makeLeafExecution(
    persistence,
    {
      adapterKey: "effect-test-v1",
      execute: () => {
        executions += 1;
        return Promise.resolve({
          reason: "must-not-execute-after-threshold",
          status: "outcome-unknown" as const,
        });
      },
      lookup: () => {
        lookups += 1;
        return lookups === 1
          ? Promise.resolve({
              proofId: "leaf-observation-not-found",
              status: "not-found" as const,
            })
          : Promise.resolve({
              outcome: {
                output: { summary: "synthetic" },
                settlement: {
                  amount: 0,
                  kind: "settle" as const,
                  unit: "credits",
                  usageEntryId: usageEntryId("usage-leaf-late-found"),
                },
                status: "succeeded" as const,
              },
              proofId: "leaf-observation-found",
              status: "found" as const,
            });
      },
    },
    startKey
  );

  const absentNow = await executeLeaf(leafRequest(startKey));
  assert.equal(absentNow.ok, true);
  if (absentNow.ok) {
    assert.equal(absentNow.value.status, "ambiguous");
  }
  assert.equal(persistence.stepRun.attempts[0]?.state, "ambiguous");
  assert.equal(persistence.reservation.state, "reserved");

  const foundLater = await executeLeaf(leafRequest(startKey));
  assert.equal(foundLater.ok, true);
  if (foundLater.ok) {
    assert.equal(foundLater.value.status, "succeeded");
  }
  assert.equal(executions, 0);
  assert.equal(lookups, 2);
  assert.equal(persistence.reservation.state, "settled");
});

test("rejects a callback that does not match the durable leaf binding", async () => {
  const persistence = new FakeTransitionPersistence();
  let executions = 0;
  const executeLeaf = makeLeafExecution(
    persistence,
    {
      adapterKey: "effect-test-v1",
      execute: () => {
        executions += 1;
        return Promise.resolve({
          reason: "must-not-run",
          status: "outcome-unknown" as const,
        });
      },
      lookup: () =>
        Promise.resolve({
          reason: "must-not-run",
          status: "outcome-unknown" as const,
        }),
    },
    "leaf-start-bound"
  );

  const result = await executeLeaf(leafRequest("leaf-start-tampered"));

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, "leaf-binding-mismatch");
  }
  assert.equal(executions, 0);
  assert.equal(persistence.stepRun.attempts[0]?.state, "claimed");
});

test("rejects a callback whose effect adapter differs from durable provenance", async () => {
  const persistence = new FakeTransitionPersistence();
  let executions = 0;
  let lookups = 0;
  const executeLeaf = makeLeafExecution(
    persistence,
    {
      adapterKey: "effect-other-v1",
      execute: () => {
        executions += 1;
        return Promise.resolve({
          reason: "must-not-run",
          status: "outcome-unknown" as const,
        });
      },
      lookup: () => {
        lookups += 1;
        return Promise.resolve({
          reason: "must-not-run",
          status: "outcome-unknown" as const,
        });
      },
    },
    "leaf-start-adapter-provenance"
  );

  const result = await executeLeaf(
    leafRequest("leaf-start-adapter-provenance")
  );

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, "leaf-binding-mismatch");
  }
  assert.equal(executions, 0);
  assert.equal(lookups, 0);
  assert.equal(persistence.stepRun.attempts[0]?.state, "claimed");
});

test("keeps ambiguous recovery bound to the exact durable adapter", async () => {
  const persistence = new FakeTransitionPersistence();
  const startKey = "leaf-start-registry-ambiguous";
  let adapterAExecutions = 0;
  let adapterALookups = 0;
  let adapterBExecutions = 0;
  let adapterBLookups = 0;
  let nextEvent = 0;
  const executeLeaf = makeExecuteLeafAttemptRegistry({
    clock: { now: async () => instant(2000 + nextEvent) },
    effects: [
      {
        adapterKey: "effect-test-v1",
        execute: () => {
          adapterAExecutions += 1;
          return Promise.resolve({
            reason: "provider-timeout",
            status: "outcome-unknown" as const,
          });
        },
        lookup: () => {
          adapterALookups += 1;
          return Promise.resolve({
            reason: "provider-still-unknown",
            status: "outcome-unknown" as const,
          });
        },
      },
      {
        adapterKey: "effect-other-v1",
        execute: () => {
          adapterBExecutions += 1;
          return Promise.resolve({
            reason: "must-not-run",
            status: "outcome-unknown" as const,
          });
        },
        lookup: () => {
          adapterBLookups += 1;
          return Promise.resolve({
            reason: "must-not-run",
            status: "outcome-unknown" as const,
          });
        },
      },
    ],
    identifiers: {
      nextEventId: async () => eventId(`event-leaf-${++nextEvent}`),
    },
    outputValidator: {
      validate: async () => ({
        status: "accepted" as const,
        validatorVersion: "validator-test-v1",
      }),
    },
    persistence,
    queries: {
      getContextByStepId: async () => ({
        plan: persistence.plan,
        run: persistence.run,
        stepRun: persistence.stepRun,
        succeededNodeKeys: [],
      }),
      getLeafExecutionIdentity: async () => ({
        attemptId: attempt,
        effectAdapterKey: "effect-test-v1",
        eventId: eventId("event-leaf-execution"),
        runId: run.runId,
        startKey,
        stepRunId: step,
        workspaceId: workspace,
      }),
    },
    requiredPermission: "steps:execute",
  });

  const first = await executeLeaf(leafRequest(startKey));
  const recovery = await executeLeaf(leafRequest(startKey));

  assert.equal(first.ok, true);
  assert.equal(recovery.ok, true);
  assert.equal(adapterAExecutions, 1);
  assert.equal(adapterALookups, 1);
  assert.equal(adapterBExecutions, 0);
  assert.equal(adapterBLookups, 0);
});
