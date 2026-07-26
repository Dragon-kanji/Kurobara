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
import type { OrchestrationPort, OutboxMessage } from "@kurobara/ports";

import { makeDispatchRunQueued } from "../src/index.ts";

const workspace = workspaceId("workspace-test");
const queuedEvent = {
  actorId: actorId("actor-test"),
  correlationId: correlationId("correlation-test"),
  eventId: eventId("event-test"),
  eventType: "RunQueued" as const,
  eventVersion: 1 as const,
  occurredAt: instant(1000),
  runId: runId("run-test"),
  runPlanId: runPlanId("plan-test"),
  sequence: 1 as const,
  workspaceId: workspace,
};
const message: OutboxMessage = {
  aggregateId: queuedEvent.runId,
  aggregateVersion: 1,
  availableAt: instant(1000),
  destination: "orchestration.run.queued",
  event: queuedEvent,
  eventId: queuedEvent.eventId,
  messageId: outboxMessageId("outbox-test"),
  workspaceId: workspace,
};

const orchestration = (called: unknown[]): OrchestrationPort => ({
  adapterKey: "fake-v1",
  findRunByStartKey: async () => ({ status: "not-found" }),
  startRun: (request) => {
    called.push(request);
    return Promise.resolve({
      orchestrationRunId: "orchestration-test",
      status: "accepted" as const,
    });
  },
});

test("dispatches a consistent message with its stable start key", async () => {
  const requests: unknown[] = [];
  const result = await makeDispatchRunQueued({
    orchestration: orchestration(requests),
  })(message, "start-test");

  assert.equal(result.ok, true);
  assert.equal(requests.length, 1);
  assert.equal((requests[0] as { startKey: string }).startKey, "start-test");
});

test("refuses an inconsistent message or empty start key", async () => {
  const requests: unknown[] = [];
  const dispatch = makeDispatchRunQueued({
    orchestration: orchestration(requests),
  });

  assert.equal((await dispatch(message, " ")).ok, false);
  assert.equal(
    (await dispatch({ ...message, aggregateId: runId("another-run") }, "key"))
      .ok,
    false
  );
  assert.equal(requests.length, 0);
});
