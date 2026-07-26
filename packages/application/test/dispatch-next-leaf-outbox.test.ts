import assert from "node:assert/strict";
import test from "node:test";

import {
  actorId,
  attemptId,
  correlationId,
  eventId,
  fail,
  instant,
  operationKey,
  outboxMessageId,
  runId,
  stepRunId,
  succeed,
  workspaceId,
} from "@kurobara/kernel";
import type {
  DelayLeafOutboxInput,
  LeafOrchestrationPort,
  LeafOutboxClaim,
  LeafOutboxDispatchPort,
  MarkLeafStartingInput,
  RecordLeafStartedInput,
  RecordLeafTerminalInput,
  StartLeafAttemptRequest,
} from "@kurobara/ports";

import { makeDispatchNextLeafOutbox } from "../src/index.ts";

const workspace = workspaceId("workspace-leaf-dispatch");
const message: LeafOutboxClaim["message"] = {
  aggregateVersion: 2,
  attemptId: attemptId("attempt-leaf-dispatch"),
  availableAt: instant(1000),
  destination: "orchestration.step.attempt.claimed",
  effectAdapterKey: "effect-test-v1",
  event: {
    actorId: actorId("actor-leaf-dispatch"),
    attemptId: attemptId("attempt-leaf-dispatch"),
    attemptNumber: 1,
    correlationId: correlationId("correlation-leaf-dispatch"),
    eventId: eventId("event-leaf-dispatch"),
    eventType: "AttemptClaimed",
    eventVersion: 1,
    occurredAt: instant(1000),
    runId: runId("run-leaf-dispatch"),
    sequence: 3,
    stepRunId: stepRunId("step-leaf-dispatch"),
    workspaceId: workspace,
  },
  eventId: eventId("event-leaf-dispatch"),
  messageId: outboxMessageId("outbox-leaf-dispatch"),
  operationKey: operationKey("operation-leaf-dispatch"),
  runId: runId("run-leaf-dispatch"),
  stepRunId: stepRunId("step-leaf-dispatch"),
  workspaceId: workspace,
};

class FakeLeafOutbox implements LeafOutboxDispatchPort {
  attempt = 1;
  binding: LeafOutboxClaim["binding"] = {
    startKey: "leaf-start-test",
    state: "pending",
  };
  lastReason: string | undefined;
  lastStartedInput: RecordLeafStartedInput | undefined;
  mutationStatus: "applied" | "stale" = "applied";
  message: LeafOutboxClaim["message"] = message;
  terminalState: "dead-lettered" | "rejected" | undefined;

  claimNext(): Promise<LeafOutboxClaim> {
    return Promise.resolve({
      attempt: this.attempt,
      binding: this.binding,
      claimedBy: "leaf-worker-test",
      claimToken: "leaf-claim-test",
      message: this.message,
    });
  }

  markCancelled() {
    this.binding = { ...this.binding, state: "cancelled" };
    return Promise.resolve({ status: this.mutationStatus });
  }

  markDeadLetter(input: RecordLeafTerminalInput) {
    this.lastReason = input.reason;
    this.terminalState = "dead-lettered";
    return Promise.resolve({ status: this.mutationStatus });
  }

  markReconciliationRequired(input: DelayLeafOutboxInput) {
    this.lastReason = input.reason;
    this.binding = { ...this.binding, state: "reconciliation_required" };
    return Promise.resolve({ status: this.mutationStatus });
  }

  markStarting(input: MarkLeafStartingInput) {
    this.binding = {
      adapterKey: input.adapterKey,
      startKey: this.binding.startKey,
      state: "starting",
    };
    return Promise.resolve({ status: this.mutationStatus });
  }

  recordRejected(input: RecordLeafTerminalInput) {
    this.lastReason = input.reason;
    this.terminalState = "rejected";
    return Promise.resolve({ status: this.mutationStatus });
  }

  recordStarted(input: RecordLeafStartedInput) {
    this.lastStartedInput = input;
    this.binding = {
      adapterKey: input.adapterKey,
      externalExecutionId: input.externalExecutionId,
      startKey: this.binding.startKey,
      state: "started",
    };
    return Promise.resolve({ status: this.mutationStatus });
  }

  resetPending(input: DelayLeafOutboxInput) {
    this.lastReason = input.reason;
    this.binding = { startKey: this.binding.startKey, state: "pending" };
    return Promise.resolve({ status: this.mutationStatus });
  }
}

const orchestration = (
  startAttempt: LeafOrchestrationPort["startAttempt"],
  findAttemptByStartKey: LeafOrchestrationPort["findAttemptByStartKey"] = async () => ({
    proofId: "leaf-not-found",
    status: "not-found",
  })
): LeafOrchestrationPort => ({
  adapterKey: "leaf-fake-v1",
  findAttemptByStartKey,
  startAttempt,
});

const makeSubject = (
  outbox: FakeLeafOutbox,
  leafOrchestration: LeafOrchestrationPort,
  recordNotStarted: Parameters<
    typeof makeDispatchNextLeafOutbox
  >[0]["recordNotStarted"] = async () =>
    succeed({ replayed: false, stepRun: {} as never })
) =>
  makeDispatchNextLeafOutbox({
    availableEffectAdapterKeys: ["effect-test-v1"],
    claimLeaseMilliseconds: 1000,
    effectRecoveryDelayMilliseconds: 60_000,
    effectRecoveryMaxAttempts: 3,
    leafOrchestration,
    maxAttempts: 3,
    outbox,
    recordNotStarted,
    retryDelayMilliseconds: 5000,
    workerId: "leaf-worker-test",
  });

test("records an accepted leaf start with its attempt-specific binding", async () => {
  const outbox = new FakeLeafOutbox();
  const dispatch = makeSubject(
    outbox,
    orchestration(async () => ({
      externalExecutionId: "leaf-execution-test",
      status: "accepted",
    }))
  );

  const result = await dispatch();

  assert.equal(result.status, "dispatched");
  assert.deepEqual(outbox.binding, {
    adapterKey: "leaf-fake-v1",
    externalExecutionId: "leaf-execution-test",
    startKey: "leaf-start-test",
    state: "started",
  });
  assert.equal(outbox.lastStartedInput?.effectAdapterKey, "effect-test-v1");
  assert.equal(outbox.lastStartedInput?.recoveryDelayMilliseconds, 60_000);
  assert.equal(outbox.lastStartedInput?.recoveryMaxAttempts, 3);
});

test("releases a pending attempt before closing a message whose durable effect adapter is unavailable", async () => {
  const outbox = new FakeLeafOutbox();
  outbox.message = { ...message, effectAdapterKey: "effect-other-v1" };
  let starts = 0;
  let recorded:
    | Readonly<{ request: StartLeafAttemptRequest; retryable: boolean }>
    | undefined;
  const dispatch = makeSubject(
    outbox,
    orchestration(() => {
      starts += 1;
      return Promise.resolve({
        externalExecutionId: "must-not-start",
        status: "accepted" as const,
      });
    }),
    (request, retryable) => {
      recorded = { request, retryable };
      return Promise.resolve(
        succeed({ replayed: false, stepRun: {} as never })
      );
    }
  );

  const result = await dispatch();

  assert.deepEqual(result, {
    messageId: message.messageId,
    reason: "leaf-effect-adapter-unavailable",
    status: "dead-lettered",
  });
  assert.equal(starts, 0);
  assert.deepEqual(recorded, {
    request: {
      attemptId: message.attemptId,
      eventId: message.eventId,
      runId: message.runId,
      startKey: "leaf-start-test",
      stepRunId: message.stepRunId,
      workspaceId: message.workspaceId,
    },
    retryable: true,
  });
  assert.equal(outbox.lastReason, "leaf-effect-adapter-unavailable");
});

test("keeps an unavailable-adapter message recoverable when releasing its pending attempt fails", async () => {
  const outbox = new FakeLeafOutbox();
  outbox.message = { ...message, effectAdapterKey: "effect-other-v1" };
  const dispatch = makeSubject(
    outbox,
    orchestration(async () => ({
      externalExecutionId: "must-not-start",
      status: "accepted",
    })),
    async () =>
      fail({
        code: "transition-rejected",
        message: "Synthetic transition conflict.",
      })
  );

  const result = await dispatch();

  assert.deepEqual(result, {
    messageId: message.messageId,
    reason: "transition-rejected",
    status: "reconciliation-scheduled",
  });
  assert.equal(outbox.binding.state, "reconciliation_required");
  assert.equal(outbox.terminalState, undefined);
});

test("does not release an unavailable-adapter attempt after its start became ambiguous", async () => {
  const outbox = new FakeLeafOutbox();
  outbox.message = { ...message, effectAdapterKey: "effect-other-v1" };
  outbox.binding = {
    adapterKey: "leaf-fake-v1",
    startKey: "leaf-start-test",
    state: "reconciliation_required",
  };
  let releases = 0;
  let lookups = 0;
  const dispatch = makeSubject(
    outbox,
    orchestration(
      async () => ({ reason: "unused", status: "outcome-unknown" }),
      () => {
        lookups += 1;
        return Promise.resolve({
          reason: "still-ambiguous",
          status: "outcome-unknown" as const,
        });
      }
    ),
    () => {
      releases += 1;
      return Promise.resolve(
        succeed({ replayed: false, stepRun: {} as never })
      );
    }
  );

  const result = await dispatch();

  assert.deepEqual(result, {
    messageId: message.messageId,
    reason: "still-ambiguous",
    status: "reconciliation-scheduled",
  });
  assert.equal(lookups, 1);
  assert.equal(releases, 0);
  assert.equal(outbox.terminalState, undefined);
});

test("reconciles an unknown start and never submits it again blindly", async () => {
  const outbox = new FakeLeafOutbox();
  let starts = 0;
  let lookups = 0;
  const dispatch = makeSubject(
    outbox,
    orchestration(
      () => {
        starts += 1;
        return Promise.resolve({
          reason: "timeout",
          status: "outcome-unknown" as const,
        });
      },
      () => {
        lookups += 1;
        return Promise.resolve({
          externalExecutionId: "leaf-execution-recovered",
          status: "found" as const,
        });
      }
    )
  );

  assert.equal((await dispatch()).status, "reconciliation-scheduled");
  assert.equal((await dispatch()).status, "dispatched");
  assert.equal(starts, 1);
  assert.equal(lookups, 1);
  assert.equal(outbox.binding.externalExecutionId, "leaf-execution-recovered");
});

test("resets a proven absent start until the bounded attempt limit", async () => {
  const outbox = new FakeLeafOutbox();
  outbox.binding = {
    adapterKey: "leaf-fake-v1",
    startKey: "leaf-start-test",
    state: "reconciliation_required",
  };
  const dispatch = makeSubject(
    outbox,
    orchestration(
      async () => ({ reason: "unused", status: "outcome-unknown" }),
      async () => ({ proofId: "leaf-absence-proof", status: "not-found" })
    )
  );

  const result = await dispatch();

  assert.equal(result.status, "retry-scheduled");
  assert.equal(outbox.binding.state, "pending");
  assert.equal(outbox.lastReason, "leaf-absence-proof");
});

test("closes a definitely rejected leaf before terminalizing its binding", async () => {
  const outbox = new FakeLeafOutbox();
  let closed = 0;
  const dispatch = makeSubject(
    outbox,
    orchestration(async () => ({
      reason: "request-invalid",
      retryable: false,
      status: "definitely-rejected",
    })),
    () => {
      closed += 1;
      return Promise.resolve(
        succeed({ replayed: false, stepRun: {} as never })
      );
    }
  );

  const result = await dispatch();

  assert.equal(result.status, "rejected");
  assert.equal(closed, 1);
  assert.equal(outbox.terminalState, "rejected");
  assert.equal(outbox.lastReason, "request-invalid");
});

test("treats a lost leaf claim as a fenced no-op", async () => {
  const outbox = new FakeLeafOutbox();
  outbox.mutationStatus = "stale";
  let starts = 0;
  const dispatch = makeSubject(
    outbox,
    orchestration(() => {
      starts += 1;
      return Promise.resolve({
        externalExecutionId: "must-not-start",
        status: "accepted" as const,
      });
    })
  );

  const result = await dispatch();

  assert.equal(result.status, "claim-lost");
  assert.equal(starts, 0);
});
