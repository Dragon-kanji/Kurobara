import assert from "node:assert/strict";
import test from "node:test";

import {
  actorId,
  correlationId,
  eventId,
  instant,
  outboxMessageId,
  runId,
  runPlanId,
  workspaceId,
} from "@kurobara/kernel";
import type {
  MarkOutboxDeadLetterInput,
  MarkOutboxRetryInput,
  MarkRunOrchestrationStartingInput,
  OrchestrationPort,
  OutboxClaim,
  OutboxDispatchPort,
  OutboxMessage,
  RecordRunOrchestrationStartedInput,
  SettleOutboxInput,
  StartRunOutcome,
} from "@kurobara/ports";

import { makeDispatchNextOutbox } from "../src/index.ts";

const SETTLEMENT_UNAVAILABLE = /settlement unavailable/u;

const message: OutboxMessage = {
  aggregateId: runId("run-test"),
  aggregateVersion: 1,
  availableAt: instant(1000),
  destination: "orchestration.run.queued",
  event: {
    actorId: actorId("actor-test"),
    correlationId: correlationId("correlation-test"),
    eventId: eventId("event-test"),
    eventType: "RunQueued",
    eventVersion: 1,
    occurredAt: instant(1000),
    runId: runId("run-test"),
    runPlanId: runPlanId("plan-test"),
    sequence: 1,
    workspaceId: workspaceId("workspace-test"),
  },
  eventId: eventId("event-test"),
  messageId: outboxMessageId("outbox-test"),
  workspaceId: workspaceId("workspace-test"),
};

class FakeOutbox implements OutboxDispatchPort {
  attempt = 0;
  binding: OutboxClaim["binding"] = {
    startKey: "start-test",
    state: "pending",
  };
  deadLettered = false;
  dispatched = false;
  failDispatchedSettlement = false;
  lastReason: string | undefined;
  retried = false;

  claimNext(): Promise<OutboxClaim | undefined> {
    this.attempt += 1;
    return Promise.resolve({
      attempt: this.attempt,
      binding: this.binding,
      claimedBy: "worker-test",
      claimToken: `claim-${this.attempt}`,
      message,
    });
  }

  markDeadLetter(input: MarkOutboxDeadLetterInput): Promise<void> {
    this.deadLettered = true;
    this.lastReason = input.reason;
    return Promise.resolve();
  }

  markDispatched(_input: SettleOutboxInput): Promise<void> {
    if (this.failDispatchedSettlement) {
      this.failDispatchedSettlement = false;
      return Promise.reject(new Error("settlement unavailable"));
    }
    this.dispatched = true;
    return Promise.resolve();
  }

  markReconciliationRequired(_input: SettleOutboxInput): Promise<void> {
    this.binding = { ...this.binding, state: "reconciliation_required" };
    return Promise.resolve();
  }

  markRetry(input: MarkOutboxRetryInput): Promise<void> {
    this.retried = true;
    this.lastReason = input.reason;
    return Promise.resolve();
  }

  markStarting(input: MarkRunOrchestrationStartingInput): Promise<void> {
    this.binding = {
      adapterKey: input.adapterKey,
      startKey: this.binding.startKey,
      state: "starting",
    };
    return Promise.resolve();
  }

  recordStarted(input: RecordRunOrchestrationStartedInput): Promise<void> {
    this.binding = {
      adapterKey: input.adapterKey,
      orchestrationRunId: input.orchestrationRunId,
      startKey: this.binding.startKey,
      state: "started",
    };
    return Promise.resolve();
  }

  resetPending(_input: SettleOutboxInput): Promise<void> {
    this.binding = { startKey: this.binding.startKey, state: "pending" };
    return Promise.resolve();
  }
}

const orchestrator = (
  startRun: OrchestrationPort["startRun"],
  findRunByStartKey: OrchestrationPort["findRunByStartKey"] = async () => ({
    status: "not-found",
  })
): OrchestrationPort => ({
  adapterKey: "fake-v1",
  findRunByStartKey,
  startRun,
});

const makeSubject = (outbox: FakeOutbox, orchestration: OrchestrationPort) =>
  makeDispatchNextOutbox({
    claimLeaseMilliseconds: 1000,
    maxAttempts: 3,
    orchestration,
    outbox,
    retryDelayMilliseconds: 5000,
    workerId: "worker-test",
  });

test("records and settles an accepted start", async () => {
  const outbox = new FakeOutbox();
  const dispatch = makeSubject(
    outbox,
    orchestrator(async () => ({
      orchestrationRunId: "orchestration-test",
      status: "accepted",
    }))
  );

  assert.equal((await dispatch()).status, "dispatched");
  assert.equal(outbox.binding.state, "started");
  assert.equal(outbox.dispatched, true);
});

test("replays a recorded start without a second orchestration call after settlement failure", async () => {
  const outbox = new FakeOutbox();
  outbox.failDispatchedSettlement = true;
  let starts = 0;
  const dispatch = makeSubject(
    outbox,
    orchestrator(() => {
      starts += 1;
      return Promise.resolve({
        orchestrationRunId: "orchestration-test",
        status: "accepted" as const,
      });
    })
  );

  await assert.rejects(() => dispatch(), SETTLEMENT_UNAVAILABLE);
  assert.equal(outbox.binding.state, "started");
  assert.equal((await dispatch()).status, "dispatched");
  assert.equal(starts, 1);
});

test("turns an unknown start outcome into reconciliation and never starts blindly", async () => {
  const outbox = new FakeOutbox();
  let starts = 0;
  let lookups = 0;
  const orchestration = orchestrator(
    (): Promise<StartRunOutcome> => {
      starts += 1;
      return Promise.resolve({ reason: "timeout", status: "outcome-unknown" });
    },
    () => {
      lookups += 1;
      return Promise.resolve({ status: "not-found" as const });
    }
  );
  const dispatch = makeSubject(outbox, orchestration);

  assert.equal((await dispatch()).status, "retry-scheduled");
  assert.equal(outbox.binding.state, "reconciliation_required");
  assert.equal((await dispatch()).status, "retry-scheduled");
  assert.equal(starts, 1);
  assert.equal(lookups, 1);
});

test("redacts a thrown orchestration failure before persistence", async () => {
  const outbox = new FakeOutbox();
  const dispatch = makeSubject(
    outbox,
    orchestrator(() =>
      Promise.reject(new Error("token=private host=secret.example"))
    )
  );

  assert.equal((await dispatch()).status, "retry-scheduled");
  assert.equal(outbox.lastReason, "orchestration-operation-failed");
});

test("retries only a definitely rejected retryable start", async () => {
  const outbox = new FakeOutbox();
  const dispatch = makeSubject(
    outbox,
    orchestrator(async () => ({
      reason: "capacity",
      retryable: true,
      status: "definitely-rejected",
    }))
  );

  assert.equal((await dispatch()).status, "retry-scheduled");
  assert.equal(outbox.binding.state, "pending");
  assert.equal(outbox.retried, true);
});
