import assert from "node:assert/strict";
import test from "node:test";

import {
  actorId,
  applyStepCommand,
  attemptId,
  contentHash,
  correlationId,
  costReservationId,
  eventId,
  idempotencyKey,
  instant,
  operationKey,
  routingDecisionId,
  runId,
  type StepCommand,
  type StepCommandContext,
  type StepCommandIdentity,
  type StepCommandReplayProof,
  type StepRun,
  scheduleStep,
  skipStep,
  stepRunId,
  usageEntryId,
  workspaceId,
} from "../src/index.ts";

const identity = (key: string, hashCharacter = "a"): StepCommandIdentity => ({
  commandHash: contentHash(`sha256:${hashCharacter.repeat(64)}`),
  idempotencyKey: idempotencyKey(key),
});

const readyStep = (
  satisfiedDependencies: readonly string[] = ["source"]
): StepRun => {
  const result = scheduleStep({
    actorId: actorId("system:orchestration"),
    correlationId: correlationId("correlation-step"),
    createdAt: instant(1000),
    dependsOn: ["source"],
    eventId: eventId("step-ready"),
    nodeKey: "summarize",
    runId: runId("run-step"),
    runState: "running",
    satisfiedDependencies,
    stepRunId: stepRunId("step-run"),
    workspaceId: workspaceId("workspace-step"),
  });
  if (!result.ok) {
    throw new Error(result.error.message);
  }
  return result.value.stepRun;
};

const context = (
  stepRun: StepRun,
  eventCount: number,
  commandIdentity: StepCommandIdentity = identity(
    `command-${stepRun.aggregateVersion}`
  ),
  replayProof?: StepCommandReplayProof
): StepCommandContext => ({
  actorId: actorId("system:orchestration"),
  commandIdentity,
  correlationId: correlationId("correlation-step"),
  eventIds: Array.from({ length: eventCount }, (_, index) =>
    eventId(`step-event-${stepRun.eventSequence + index + 1}`)
  ),
  expectedAggregateVersion: stepRun.aggregateVersion,
  occurredAt: instant(2000 + stepRun.aggregateVersion),
  ...(replayProof === undefined ? {} : { replayProof }),
});

const preparation = (
  suffix: string,
  reason: "initial" | "retry" | "fallback" = "initial",
  requestedOperationKey = "operation-step"
) => ({
  attemptId: attemptId(`attempt-${suffix}`),
  authorityEnvelopeId: "authority-step",
  costReservationId: costReservationId("reservation-step"),
  effectAdapterKey: "deterministic-local",
  operationKey: operationKey(requestedOperationKey),
  reason,
  reservationUnit: "credits",
  reservedAmount: 2,
  routeKey: "route-local",
  routeSnapshotHash: contentHash(`sha256:${"b".repeat(64)}`),
  routingDecisionId: routingDecisionId(`route-${suffix}`),
});

const settled = (suffix: string, amount = 2) => ({
  attemptId: attemptId(`attempt-${suffix}`),
  disposition: "settled" as const,
  operationKey: operationKey("operation-step"),
  releasedAmount: 2 - amount,
  reservationId: costReservationId("reservation-step"),
  settledAmount: amount,
  unit: "credits",
  usageEntryId: usageEntryId(`usage-${suffix}`),
});

const released = (suffix: string) => ({
  attemptId: attemptId(`attempt-${suffix}`),
  disposition: "released" as const,
  operationKey: operationKey("operation-step"),
  releasedAmount: 2,
  reservationId: costReservationId("reservation-step"),
  unit: "credits",
});

const apply = (
  stepRun: StepRun,
  command: StepCommand,
  eventCount: number
): StepRun => {
  const result = applyStepCommand(
    stepRun,
    command,
    context(stepRun, eventCount)
  );
  if (!result.ok) {
    throw new Error(result.error.message);
  }
  return result.value.stepRun;
};

test("preserves attempts while a retry advances monotonically", () => {
  const ready = readyStep();
  const firstClaim = apply(
    ready,
    { preparation: preparation("one"), type: "ClaimStepAttempt" },
    3
  );
  const firstInFlight = apply(
    firstClaim,
    { attemptId: attemptId("attempt-one"), type: "StartAttemptEffect" },
    1
  );
  const unsettled = applyStepCommand(
    firstInFlight,
    {
      attemptId: attemptId("attempt-one"),
      retryAuthorized: true,
      retryable: true,
      settlement: { ...settled("one"), releasedAmount: 1 },
      type: "RecordAttemptFailure",
    },
    context(firstInFlight, 2)
  );
  const authorized = applyStepCommand(
    firstInFlight,
    {
      attemptId: attemptId("attempt-one"),
      retryAuthorized: true,
      retryable: true,
      settlement: settled("one"),
      type: "RecordAttemptFailure",
    },
    context(firstInFlight, 2)
  );
  if (!authorized.ok) {
    throw new Error(authorized.error.message);
  }
  const retried = authorized.value.stepRun;
  const exhaustedResult = applyStepCommand(
    firstInFlight,
    {
      attemptId: attemptId("attempt-one"),
      retryAuthorized: false,
      retryable: true,
      settlement: settled("one"),
      type: "RecordAttemptFailure",
    },
    context(firstInFlight, 2)
  );
  if (!exhaustedResult.ok) {
    throw new Error(exhaustedResult.error.message);
  }
  const exhausted = exhaustedResult.value.stepRun;
  const secondClaim = apply(
    retried,
    {
      preparation: preparation("two", "retry"),
      type: "ClaimStepAttempt",
    },
    3
  );
  const secondInFlight = apply(
    secondClaim,
    { attemptId: attemptId("attempt-two"), type: "StartAttemptEffect" },
    1
  );
  const succeeded = apply(
    secondInFlight,
    {
      attemptId: attemptId("attempt-two"),
      settlement: settled("two"),
      type: "RecordAttemptSucceeded",
    },
    1
  );

  assert.equal(unsettled.ok, false);
  if (!unsettled.ok) {
    assert.equal(unsettled.error.code, "settlement-precondition-failed");
  }
  assert.equal(succeeded.state, "succeeded");
  assert.equal(succeeded.aggregateVersion, 7);
  assert.equal(succeeded.eventSequence, 12);
  assert.equal(succeeded.activeAttemptId, undefined);
  assert.deepEqual(
    succeeded.attempts.map((attempt) => ({
      number: attempt.attemptNumber,
      operationKey: attempt.operationKey,
      reason: attempt.reason,
      state: attempt.state,
    })),
    [
      {
        number: 1,
        operationKey: "operation-step",
        reason: "initial",
        state: "failed_retryable",
      },
      {
        number: 2,
        operationKey: "operation-step",
        reason: "retry",
        state: "succeeded",
      },
    ]
  );
  assert.equal(exhausted.state, "failed");
  assert.equal(exhausted.attempts[0]?.state, "failed_terminal");
  assert.deepEqual(
    authorized.value.events.map(({ eventType }) => eventType),
    ["AttemptFailed", "StepRetryAuthorized"]
  );
  assert.deepEqual(
    exhaustedResult.value.events.map(({ eventType }) => eventType),
    ["AttemptFailed", "StepRetryExhausted"]
  );
});

test("accepts finite fractional reservation amounts", () => {
  const result = applyStepCommand(
    readyStep(),
    {
      preparation: { ...preparation("fractional"), reservedAmount: 0.11 },
      type: "ClaimStepAttempt",
    },
    context(readyStep(), 3)
  );

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.value.stepRun.attempts[0]?.reservedAmount, 0.11);
  }
});

test("replays a durable claim after the attempt has moved in flight", () => {
  const ready = readyStep();
  const claimIdentity = identity("claim-step", "c");
  const claimCommand = {
    preparation: preparation("one"),
    type: "ClaimStepAttempt",
  } as const;
  const claimed = applyStepCommand(
    ready,
    claimCommand,
    context(ready, 3, claimIdentity)
  );
  assert.equal(claimed.ok, true);
  if (!claimed.ok) {
    return;
  }
  const inFlight = apply(
    claimed.value.stepRun,
    { attemptId: attemptId("attempt-one"), type: "StartAttemptEffect" },
    1
  );
  const proof: StepCommandReplayProof = {
    actorId: actorId("system:orchestration"),
    commandType: "ClaimStepAttempt",
    identity: claimIdentity,
    stepRunId: ready.stepRunId,
    workspaceId: ready.workspaceId,
  };
  const replay = applyStepCommand(
    inFlight,
    claimCommand,
    context(inFlight, 0, claimIdentity, proof)
  );

  assert.equal(replay.ok, true);
  if (replay.ok) {
    assert.equal(replay.value.replayed, true);
    assert.strictEqual(replay.value.stepRun, inFlight);
    assert.deepEqual(replay.value.events, []);
  }
});

test("rejects idempotency reuse with a different command hash", () => {
  const ready = readyStep();
  const acceptedIdentity = identity("claim-step", "d");
  const proof: StepCommandReplayProof = {
    actorId: actorId("system:orchestration"),
    commandType: "ClaimStepAttempt",
    identity: acceptedIdentity,
    stepRunId: ready.stepRunId,
    workspaceId: ready.workspaceId,
  };
  const result = applyStepCommand(
    ready,
    { preparation: preparation("one"), type: "ClaimStepAttempt" },
    context(ready, 0, identity("claim-step", "e"), proof)
  );

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, "idempotency-key-reused");
  }
});

test("fences delayed callbacks to the exact attempt identity", () => {
  const claimed = apply(
    readyStep(),
    { preparation: preparation("one"), type: "ClaimStepAttempt" },
    3
  );
  const staleStart = applyStepCommand(
    claimed,
    { attemptId: attemptId("attempt-stale"), type: "StartAttemptEffect" },
    context(claimed, 1)
  );
  const inFlight = apply(
    claimed,
    { attemptId: attemptId("attempt-one"), type: "StartAttemptEffect" },
    1
  );
  const staleSettlement = applyStepCommand(
    inFlight,
    {
      attemptId: attemptId("attempt-stale"),
      settlement: settled("one"),
      type: "RecordAttemptSucceeded",
    },
    context(inFlight, 1)
  );

  assert.equal(staleStart.ok, false);
  assert.equal(staleSettlement.ok, false);
  if (!(staleStart.ok || staleSettlement.ok)) {
    assert.equal(staleStart.error.code, "invalid-transition");
    assert.equal(staleSettlement.error.code, "invalid-transition");
  }
  assert.equal(claimed.aggregateVersion, 2);
  assert.equal(inFlight.aggregateVersion, 3);
});

test("cancels before effect only with an exact release receipt", () => {
  const claimed = apply(
    readyStep(),
    { preparation: preparation("one"), type: "ClaimStepAttempt" },
    3
  );
  const cancelled = apply(
    claimed,
    {
      attemptId: attemptId("attempt-one"),
      settlement: {
        attemptId: attemptId("attempt-one"),
        disposition: "released",
        operationKey: operationKey("operation-step"),
        releasedAmount: 2,
        reservationId: costReservationId("reservation-step"),
        unit: "credits",
      },
      type: "CancelAttemptBeforeEffect",
    },
    1
  );

  assert.equal(cancelled.state, "cancelled");
  assert.equal(cancelled.attempts[0]?.state, "cancelled_before_effect");
});

test("records a claimed attempt that never started as retryable or terminal", () => {
  const claimed = apply(
    readyStep(),
    { preparation: preparation("one"), type: "ClaimStepAttempt" },
    3
  );
  const retryable = applyStepCommand(
    claimed,
    {
      attemptId: attemptId("attempt-one"),
      retryAuthorized: true,
      retryable: true,
      settlement: released("one"),
      type: "RecordAttemptNotStarted",
    },
    context(claimed, 2)
  );
  const terminal = applyStepCommand(
    claimed,
    {
      attemptId: attemptId("attempt-one"),
      retryAuthorized: false,
      retryable: false,
      settlement: released("one"),
      type: "RecordAttemptNotStarted",
    },
    context(claimed, 1)
  );
  const invalidReceipt = applyStepCommand(
    claimed,
    {
      attemptId: attemptId("attempt-one"),
      retryAuthorized: true,
      retryable: true,
      settlement: { ...released("one"), releasedAmount: 1 },
      type: "RecordAttemptNotStarted",
    },
    context(claimed, 2)
  );

  assert.equal(retryable.ok, true);
  assert.equal(terminal.ok, true);
  assert.equal(invalidReceipt.ok, false);
  if (!invalidReceipt.ok) {
    assert.equal(invalidReceipt.error.code, "settlement-precondition-failed");
  }
  if (retryable.ok && terminal.ok) {
    assert.equal(retryable.value.stepRun.state, "ready");
    assert.equal(
      retryable.value.stepRun.attempts[0]?.state,
      "failed_retryable"
    );
    assert.equal(
      retryable.value.stepRun.attempts[0]?.effectStartedAt,
      undefined
    );
    assert.equal(retryable.value.events[0]?.eventType, "AttemptFailed");
    assert.equal(retryable.value.events[1]?.eventType, "StepRetryAuthorized");
    assert.equal(terminal.value.stepRun.state, "failed");
    assert.equal(terminal.value.stepRun.attempts[0]?.state, "failed_terminal");
  }
});

test("rejects not-started conclusions after the effect threshold or terminality", () => {
  const claimed = apply(
    readyStep(),
    { preparation: preparation("one"), type: "ClaimStepAttempt" },
    3
  );
  const inFlight = apply(
    claimed,
    { attemptId: attemptId("attempt-one"), type: "StartAttemptEffect" },
    1
  );
  const terminal = apply(
    claimed,
    {
      attemptId: attemptId("attempt-one"),
      retryAuthorized: false,
      retryable: false,
      settlement: released("one"),
      type: "RecordAttemptNotStarted",
    },
    1
  );
  const afterEffect = applyStepCommand(
    inFlight,
    {
      attemptId: attemptId("attempt-one"),
      retryAuthorized: true,
      retryable: true,
      settlement: released("one"),
      type: "RecordAttemptNotStarted",
    },
    context(inFlight, 2)
  );
  const afterTerminal = applyStepCommand(
    terminal,
    {
      attemptId: attemptId("attempt-one"),
      retryAuthorized: true,
      retryable: true,
      settlement: released("one"),
      type: "RecordAttemptNotStarted",
    },
    context(terminal, 2)
  );

  assert.equal(afterEffect.ok, false);
  assert.equal(afterTerminal.ok, false);
  if (!(afterEffect.ok || afterTerminal.ok)) {
    assert.equal(afterEffect.error.code, "invalid-transition");
    assert.equal(afterTerminal.error.code, "invalid-transition");
  }
});

test("does not retry an ambiguous attempt before reconciliation", () => {
  const claimed = apply(
    readyStep(),
    { preparation: preparation("one"), type: "ClaimStepAttempt" },
    3
  );
  const inFlight = apply(
    claimed,
    { attemptId: attemptId("attempt-one"), type: "StartAttemptEffect" },
    1
  );
  const ambiguous = apply(
    inFlight,
    { attemptId: attemptId("attempt-one"), type: "MarkAttemptAmbiguous" },
    1
  );
  const retry = applyStepCommand(
    ambiguous,
    {
      attemptId: attemptId("attempt-one"),
      retryAuthorized: true,
      type: "AuthorizeRetry",
    },
    context(ambiguous, 1)
  );
  const noProof = applyStepCommand(
    ambiguous,
    {
      attemptId: attemptId("attempt-one"),
      outcome: "succeeded",
      proofId: " ",
      retryAuthorized: false,
      settlement: settled("one"),
      type: "ResolveAttemptAmbiguity",
    },
    context(ambiguous, 1)
  );
  const resolved = apply(
    ambiguous,
    {
      attemptId: attemptId("attempt-one"),
      outcome: "succeeded",
      proofId: "provider-receipt-1",
      retryAuthorized: false,
      settlement: settled("one"),
      type: "ResolveAttemptAmbiguity",
    },
    1
  );

  assert.equal(retry.ok, false);
  assert.equal(noProof.ok, false);
  assert.equal(resolved.state, "succeeded");
  if (!(retry.ok || noProof.ok)) {
    assert.equal(retry.error.code, "invalid-transition");
    assert.equal(noProof.error.code, "reconciliation-proof-required");
  }
});

test("requires a running run and satisfied dependencies before readiness", () => {
  const stopped = scheduleStep({
    actorId: actorId("system:orchestration"),
    correlationId: correlationId("correlation-step"),
    createdAt: instant(1000),
    dependsOn: [],
    eventId: eventId("step-ready-stopped"),
    nodeKey: "summarize",
    runId: runId("run-stopped"),
    runState: "cancelling",
    satisfiedDependencies: [],
    stepRunId: stepRunId("step-stopped"),
    workspaceId: workspaceId("workspace-step"),
  });
  const missingDependency = scheduleStep({
    actorId: actorId("system:orchestration"),
    correlationId: correlationId("correlation-step"),
    createdAt: instant(1000),
    dependsOn: ["source"],
    eventId: eventId("step-ready-missing"),
    nodeKey: "summarize",
    runId: runId("run-missing"),
    runState: "running",
    satisfiedDependencies: [],
    stepRunId: stepRunId("step-missing"),
    workspaceId: workspaceId("workspace-step"),
  });

  assert.equal(stopped.ok, false);
  assert.equal(missingDependency.ok, false);
  if (!(stopped.ok || missingDependency.ok)) {
    assert.equal(stopped.error.code, "run-not-running");
    assert.equal(missingDependency.error.code, "dependencies-unsatisfied");
  }
});

test("skips a blocked step with sorted direct dependency evidence", () => {
  const skipped = skipStep({
    actorId: actorId("system:orchestration"),
    blockedByNodeKeys: ["source-b", "source-a"],
    correlationId: correlationId("correlation-skip"),
    createdAt: instant(1000),
    dependsOn: ["source-a", "source-b"],
    eventId: eventId("step-skipped"),
    nodeKey: "summarize",
    runId: runId("run-skip"),
    runState: "running",
    stepRunId: stepRunId("step-skip"),
    workspaceId: workspaceId("workspace-step"),
  });

  assert.equal(skipped.ok, true);
  if (skipped.ok) {
    assert.equal(skipped.value.stepRun.state, "skipped");
    assert.deepEqual(skipped.value.stepRun.attempts, []);
    assert.deepEqual(skipped.value.event, {
      actorId: actorId("system:orchestration"),
      blockedByNodeKeys: ["source-a", "source-b"],
      correlationId: correlationId("correlation-skip"),
      eventId: eventId("step-skipped"),
      eventType: "StepSkipped",
      eventVersion: 1,
      occurredAt: instant(1000),
      reason: "blocked-by-dependency",
      runId: runId("run-skip"),
      sequence: 1,
      stepRunId: stepRunId("step-skip"),
      workspaceId: workspaceId("workspace-step"),
    });
  }
});

test("refuses skip evidence that is empty, duplicated, indirect or non-running", () => {
  const base = {
    actorId: actorId("system:orchestration"),
    blockedByNodeKeys: ["source"],
    correlationId: correlationId("correlation-skip"),
    createdAt: instant(1000),
    dependsOn: ["source"],
    eventId: eventId("step-skipped-invalid"),
    nodeKey: "summarize",
    runId: runId("run-skip"),
    runState: "running" as const,
    stepRunId: stepRunId("step-skip-invalid"),
    workspaceId: workspaceId("workspace-step"),
  };

  const empty = skipStep({ ...base, blockedByNodeKeys: [] });
  const duplicate = skipStep({
    ...base,
    blockedByNodeKeys: ["source", "source"],
  });
  const indirect = skipStep({
    ...base,
    blockedByNodeKeys: ["not-a-direct-dependency"],
  });
  const stopped = skipStep({ ...base, runState: "failed" });

  assert.equal(empty.ok, false);
  assert.equal(duplicate.ok, false);
  assert.equal(indirect.ok, false);
  assert.equal(stopped.ok, false);
  if (!(empty.ok || duplicate.ok || indirect.ok || stopped.ok)) {
    assert.equal(empty.error.code, "blocked-dependency-required");
    assert.equal(duplicate.error.code, "blocked-dependency-invalid");
    assert.equal(indirect.error.code, "blocked-dependency-unknown");
    assert.equal(stopped.error.code, "run-not-running");
  }
});

test("rejects a ready step durably when its immutable plan has no route", () => {
  const ready = readyStep();
  const rejected = applyStepCommand(
    ready,
    { reason: "no-route-available", type: "RejectStepRouting" },
    context(ready, 1)
  );

  assert.equal(rejected.ok, true);
  if (rejected.ok) {
    assert.equal(rejected.value.stepRun.state, "failed");
    assert.deepEqual(
      rejected.value.events.map((event) => event.eventType),
      ["StepRoutingRejected"]
    );
  }
});
