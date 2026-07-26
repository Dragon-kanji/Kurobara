import assert from "node:assert/strict";
import test from "node:test";

import {
  attemptId,
  eventId,
  runId,
  stepRunId,
  workspaceId,
} from "@kurobara/kernel";

import { createFakeOrchestration } from "../src/index.ts";

const request = {
  eventId: eventId("event-test"),
  runId: runId("run-test"),
  startKey: "start-test",
  workspaceId: workspaceId("workspace-test"),
};
const leafRequest = {
  attemptId: attemptId("attempt-test"),
  eventId: eventId("event-leaf-test"),
  runId: runId("run-test"),
  startKey: "start-leaf-test",
  stepRunId: stepRunId("step-test"),
  workspaceId: workspaceId("workspace-test"),
};

const emptyLeafHistory = {
  leafExecutions: [],
  leafLookups: [],
  leafStarts: [],
};

test("accepts once and deterministically reports the collision", async () => {
  const fake = createFakeOrchestration();

  assert.deepEqual(await fake.port.startRun(request), {
    orchestrationRunId: "fake:start-test",
    status: "accepted",
  });
  assert.deepEqual(await fake.port.startRun(request), {
    orchestrationRunId: "fake:start-test",
    status: "already-started",
  });
  assert.deepEqual(await fake.port.findRunByStartKey(request), {
    orchestrationRunId: "fake:start-test",
    status: "found",
  });
  assert.deepEqual(fake.history(), {
    ...emptyLeafHistory,
    lookups: [request],
    starts: [request, request],
  });
});

test("supports deterministic unknown and lookup scenarios", async () => {
  const fake = createFakeOrchestration({
    lookupScenarios: {
      "start-test": {
        reason: "fake-lookup-unavailable",
        status: "outcome-unknown",
      },
    },
    startScenarios: {
      "start-test": {
        reason: "fake-start-unavailable",
        status: "outcome-unknown",
      },
    },
  });

  assert.deepEqual(await fake.port.startRun(request), {
    reason: "fake-start-unavailable",
    status: "outcome-unknown",
  });
  assert.deepEqual(await fake.port.findRunByStartKey(request), {
    reason: "fake-lookup-unavailable",
    status: "outcome-unknown",
  });
});

test("rejects reuse of a start key for another intent", async () => {
  const fake = createFakeOrchestration();
  await fake.port.startRun(request);

  assert.deepEqual(
    await fake.port.startRun({ ...request, eventId: eventId("event-other") }),
    {
      reason: "start-key-conflict",
      retryable: false,
      status: "definitely-rejected",
    }
  );
});

test("returns frozen history snapshots detached from internal history", async () => {
  const fake = createFakeOrchestration();
  await fake.port.startRun(request);

  const first = fake.history();
  assert.equal(Object.isFrozen(first), true);
  assert.equal(Object.isFrozen(first.starts), true);
  assert.equal(Object.isFrozen(first.starts[0]), true);

  await fake.port.findRunByStartKey(request);
  assert.equal(first.lookups.length, 0);
  assert.equal(fake.history().lookups.length, 1);
});

test("executes one leaf callback per exact start key", async () => {
  const callbacks: (typeof leafRequest)[] = [];
  const fake = createFakeOrchestration({
    executeAttempt: (attempt) => {
      callbacks.push(attempt);
      return Promise.resolve();
    },
  });

  assert.deepEqual(
    await Promise.all([
      fake.leafPort.startAttempt(leafRequest),
      fake.leafPort.startAttempt(leafRequest),
    ]),
    [
      {
        externalExecutionId: "fake-leaf:start-leaf-test",
        status: "accepted",
      },
      {
        externalExecutionId: "fake-leaf:start-leaf-test",
        status: "already-started",
      },
    ]
  );
  assert.deepEqual(await fake.leafPort.findAttemptByStartKey(leafRequest), {
    externalExecutionId: "fake-leaf:start-leaf-test",
    status: "found",
  });
  assert.deepEqual(callbacks, [leafRequest]);
  assert.deepEqual(fake.history(), {
    leafExecutions: [leafRequest],
    leafLookups: [leafRequest],
    leafStarts: [leafRequest, leafRequest],
    lookups: [],
    starts: [],
  });
});

test("rejects a leaf start-key collision across attempt identities", async () => {
  const fake = createFakeOrchestration();
  await fake.leafPort.startAttempt(leafRequest);

  const conflictingRequest = {
    ...leafRequest,
    attemptId: attemptId("attempt-other"),
  };

  assert.deepEqual(await fake.leafPort.startAttempt(conflictingRequest), {
    reason: "start-key-conflict",
    retryable: false,
    status: "definitely-rejected",
  });
  assert.deepEqual(
    await fake.leafPort.findAttemptByStartKey(conflictingRequest),
    {
      reason: "start-key-conflict",
      status: "outcome-unknown",
    }
  );
  assert.equal(fake.history().leafExecutions.length, 1);
});

test("supports deterministic leaf not-found and unknown scenarios", async () => {
  const absent = createFakeOrchestration();
  assert.deepEqual(await absent.leafPort.findAttemptByStartKey(leafRequest), {
    proofId: "fake-leaf:not-found:start-leaf-test",
    status: "not-found",
  });

  const unknown = createFakeOrchestration({
    leafLookupScenarios: {
      "start-leaf-test": {
        reason: "fake-leaf-lookup-unavailable",
        status: "outcome-unknown",
      },
    },
    leafStartScenarios: {
      "start-leaf-test": {
        reason: "fake-leaf-start-unavailable",
        status: "outcome-unknown",
      },
    },
  });
  assert.deepEqual(await unknown.leafPort.startAttempt(leafRequest), {
    reason: "fake-leaf-start-unavailable",
    status: "outcome-unknown",
  });
  assert.deepEqual(await unknown.leafPort.findAttemptByStartKey(leafRequest), {
    reason: "fake-leaf-lookup-unavailable",
    status: "outcome-unknown",
  });
});

test("does not execute the leaf callback twice after an ambiguous callback", async () => {
  let calls = 0;
  const fake = createFakeOrchestration({
    executeAttempt: () => {
      calls += 1;
      return Promise.reject(new Error("lost callback response"));
    },
  });

  assert.deepEqual(await fake.leafPort.startAttempt(leafRequest), {
    reason: "fake-leaf-callback-outcome-unknown",
    status: "outcome-unknown",
  });
  assert.deepEqual(await fake.leafPort.startAttempt(leafRequest), {
    externalExecutionId: "fake-leaf:start-leaf-test",
    status: "already-started",
  });
  assert.equal(calls, 1);
  assert.equal(fake.history().leafExecutions.length, 1);
});
