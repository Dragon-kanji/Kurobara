import assert from "node:assert/strict";
import test from "node:test";

import {
  attemptId,
  eventId,
  runId,
  stepRunId,
  workspaceId,
} from "@kurobara/kernel";

import {
  HATCHET_METADATA_KEYS,
  HATCHET_WORKFLOW_NAME,
  parseHatchetRunInput,
} from "../src/boundary.ts";
import {
  HATCHET_LEAF_METADATA_KEYS,
  HATCHET_LEAF_TASK_NAME,
  parseHatchetLeafInput,
} from "../src/leaf-boundary.ts";
import {
  createHatchetAdapterRuntime,
  type HatchetRuntimeDependencies,
  type HatchetWorkerHandle,
  type RemoteRunSummary,
} from "../src/runtime.ts";

const HATCHET_LATE_EXIT = /Hatchet worker exited unexpectedly/u;
const HATCHET_SHUTDOWN_FAILURE = /Hatchet worker failed during shutdown/u;

const request = {
  eventId: eventId("event-test"),
  runId: runId("run-test"),
  startKey: "start-test",
  workspaceId: workspaceId("workspace-test"),
};
const matchingRemoteRun: RemoteRunSummary = {
  input: request,
  metadata: {
    [HATCHET_METADATA_KEYS.eventId]: "event-test",
    [HATCHET_METADATA_KEYS.runId]: "run-test",
    [HATCHET_METADATA_KEYS.startKey]: "start-test",
    [HATCHET_METADATA_KEYS.workspaceId]: "workspace-test",
  },
  orchestrationRunId: "hatchet-existing",
};
const leafRequest = {
  attemptId: attemptId("attempt-test"),
  eventId: eventId("event-leaf-test"),
  runId: runId("run-test"),
  startKey: "start-leaf-test",
  stepRunId: stepRunId("step-test"),
  workspaceId: workspaceId("workspace-test"),
};
const matchingRemoteLeaf: RemoteRunSummary = {
  input: leafRequest,
  metadata: {
    [HATCHET_LEAF_METADATA_KEYS.attemptId]: "attempt-test",
    [HATCHET_LEAF_METADATA_KEYS.eventId]: "event-leaf-test",
    [HATCHET_LEAF_METADATA_KEYS.runId]: "run-test",
    [HATCHET_LEAF_METADATA_KEYS.startKey]: "start-leaf-test",
    [HATCHET_LEAF_METADATA_KEYS.stepRunId]: "step-test",
    [HATCHET_LEAF_METADATA_KEYS.workspaceId]: "workspace-test",
  },
  orchestrationRunId: "hatchet-leaf-existing",
};

class Collision extends Error {
  readonly orchestrationRunId: string;

  constructor(orchestrationRunId: string) {
    super("collision");
    this.orchestrationRunId = orchestrationRunId;
  }
}

const makeDependencies = (
  overrides: Partial<HatchetRuntimeDependencies> = {}
): HatchetRuntimeDependencies => ({
  classifyCollision: (error) =>
    error instanceof Collision ? error.orchestrationRunId : undefined,
  createWorker: () => Promise.reject(new Error("worker not configured")),
  findRuns: async () => [],
  startLeafRemote: async () => "hatchet-leaf-test",
  startRemote: async () => "hatchet-run-test",
  ...overrides,
});

const makeRuntime = (dependencies: HatchetRuntimeDependencies) =>
  createHatchetAdapterRuntime(dependencies, {
    readinessTimeoutMilliseconds: 5000,
  });

test("starts the versioned task with exact correlation metadata", async () => {
  let observed:
    | Readonly<{
        additionalMetadata: Readonly<Record<string, string>>;
        request: Readonly<Record<string, string>>;
      }>
    | undefined;
  const runtime = makeRuntime(
    makeDependencies({
      startRemote: (input) => {
        observed = input;
        return Promise.resolve("hatchet-run-test");
      },
    })
  );

  assert.deepEqual(await runtime.port.startRun(request), {
    orchestrationRunId: "hatchet-run-test",
    status: "accepted",
  });
  assert.deepEqual(observed, {
    additionalMetadata: {
      [HATCHET_METADATA_KEYS.eventId]: "event-test",
      [HATCHET_METADATA_KEYS.runId]: "run-test",
      [HATCHET_METADATA_KEYS.startKey]: "start-test",
      [HATCHET_METADATA_KEYS.workspaceId]: "workspace-test",
    },
    request,
  });
});

test("maps a collision to the existing orchestration run", async () => {
  const runtime = makeRuntime(
    makeDependencies({
      findRuns: () => Promise.resolve([matchingRemoteRun]),
      startRemote: () => Promise.reject(new Collision("hatchet-existing")),
    })
  );

  assert.deepEqual(await runtime.port.startRun(request), {
    orchestrationRunId: "hatchet-existing",
    status: "already-started",
  });
});

test("does not trust a collision without an exact identity match", async () => {
  const runtime = makeRuntime(
    makeDependencies({
      findRuns: () =>
        Promise.resolve([
          {
            ...matchingRemoteRun,
            input: { ...request, runId: "run-other" },
          },
        ]),
      startRemote: () => Promise.reject(new Collision("hatchet-existing")),
    })
  );

  assert.deepEqual(await runtime.port.startRun(request), {
    reason: "hatchet-start-outcome-unknown",
    status: "outcome-unknown",
  });
});

test("redacts unknown start failures", async () => {
  const runtime = makeRuntime(
    makeDependencies({
      startRemote: () =>
        Promise.reject(new Error("secret-host.example token=private")),
    })
  );

  assert.deepEqual(await runtime.port.startRun(request), {
    reason: "hatchet-start-outcome-unknown",
    status: "outcome-unknown",
  });
});

test("rejects hostile input before contacting Hatchet", async () => {
  let called = false;
  const runtime = makeRuntime(
    makeDependencies({
      startRemote: () => {
        called = true;
        return Promise.resolve("unexpected");
      },
    })
  );

  assert.deepEqual(
    await runtime.port.startRun({ ...request, startKey: " bad-key" }),
    {
      reason: "invalid-orchestration-request",
      retryable: false,
      status: "definitely-rejected",
    }
  );
  assert.equal(called, false);
  assert.throws(() => parseHatchetRunInput({ ...request, extra: true }));
  assert.throws(() =>
    parseHatchetRunInput({ ...request, startKey: "bad\u0000key" })
  );
});

test("looks up one exact run across the full history", async () => {
  let observed:
    | Readonly<{
        additionalMetadata: Readonly<Record<string, string>>;
        limit: number;
        since: Date;
        workflowName: string;
      }>
    | undefined;
  const row: RemoteRunSummary = {
    input: request,
    metadata: {
      [HATCHET_METADATA_KEYS.eventId]: "event-test",
      [HATCHET_METADATA_KEYS.runId]: "run-test",
      [HATCHET_METADATA_KEYS.startKey]: "start-test",
      [HATCHET_METADATA_KEYS.workspaceId]: "workspace-test",
    },
    orchestrationRunId: "hatchet-found",
  };
  const runtime = makeRuntime(
    makeDependencies({
      findRuns: (input) => {
        observed = input;
        return Promise.resolve([row]);
      },
    })
  );

  assert.deepEqual(await runtime.port.findRunByStartKey(request), {
    orchestrationRunId: "hatchet-found",
    status: "found",
  });
  assert.equal(observed?.workflowName, HATCHET_WORKFLOW_NAME);
  assert.equal(observed?.limit, 2);
  assert.equal(observed?.since.getTime(), 0);
});

test("does not accept broad or duplicate lookup results", async () => {
  const matching: RemoteRunSummary = {
    input: request,
    metadata: {
      [HATCHET_METADATA_KEYS.eventId]: "event-test",
      [HATCHET_METADATA_KEYS.runId]: "run-test",
      [HATCHET_METADATA_KEYS.startKey]: "start-test",
      [HATCHET_METADATA_KEYS.workspaceId]: "workspace-test",
    },
    orchestrationRunId: "hatchet-found",
  };
  const broad = makeRuntime(
    makeDependencies({
      findRuns: async () => [
        { ...matching, input: { ...request, eventId: "event-other" } },
      ],
    })
  );
  assert.deepEqual(await broad.port.findRunByStartKey(request), {
    reason: "hatchet-lookup-filter-mismatch",
    status: "outcome-unknown",
  });

  const duplicate = makeRuntime(
    makeDependencies({ findRuns: async () => [matching, matching] })
  );
  assert.deepEqual(await duplicate.port.findRunByStartKey(request), {
    reason: "hatchet-lookup-cardinality-violation",
    status: "outcome-unknown",
  });
});

test("starts the strict leaf task with exact attempt metadata", async () => {
  let observed:
    | Readonly<{
        additionalMetadata: Readonly<Record<string, string>>;
        request: Readonly<Record<string, string>>;
      }>
    | undefined;
  const runtime = makeRuntime(
    makeDependencies({
      startLeafRemote: (input) => {
        observed = input;
        return Promise.resolve("hatchet-leaf-test");
      },
    })
  );

  assert.deepEqual(await runtime.leafPort.startAttempt(leafRequest), {
    externalExecutionId: "hatchet-leaf-test",
    status: "accepted",
  });
  assert.deepEqual(observed, {
    additionalMetadata: matchingRemoteLeaf.metadata,
    request: leafRequest,
  });
});

test("maps an exact leaf collision to already-started", async () => {
  const runtime = makeRuntime(
    makeDependencies({
      findRuns: () => Promise.resolve([matchingRemoteLeaf]),
      startLeafRemote: () =>
        Promise.reject(new Collision("hatchet-leaf-existing")),
    })
  );

  assert.deepEqual(await runtime.leafPort.startAttempt(leafRequest), {
    externalExecutionId: "hatchet-leaf-existing",
    status: "already-started",
  });
});

test("does not trust a leaf collision with a different attempt identity", async () => {
  const runtime = makeRuntime(
    makeDependencies({
      findRuns: () =>
        Promise.resolve([
          {
            ...matchingRemoteLeaf,
            input: { ...leafRequest, attemptId: "attempt-other" },
          },
        ]),
      startLeafRemote: () =>
        Promise.reject(new Collision("hatchet-leaf-existing")),
    })
  );

  assert.deepEqual(await runtime.leafPort.startAttempt(leafRequest), {
    reason: "hatchet-leaf-start-outcome-unknown",
    status: "outcome-unknown",
  });
});

test("rejects hostile leaf input before contacting Hatchet", async () => {
  let called = false;
  const runtime = makeRuntime(
    makeDependencies({
      startLeafRemote: () => {
        called = true;
        return Promise.resolve("unexpected");
      },
    })
  );

  assert.deepEqual(
    await runtime.leafPort.startAttempt({
      ...leafRequest,
      startKey: " bad-leaf-key",
    }),
    {
      reason: "invalid-leaf-orchestration-request",
      retryable: false,
      status: "definitely-rejected",
    }
  );
  assert.equal(called, false);
  assert.throws(() => parseHatchetLeafInput({ ...leafRequest, extra: true }));
  assert.throws(() =>
    parseHatchetLeafInput({ ...leafRequest, attemptId: "bad\u0000attempt" })
  );
});

test("looks up one exact leaf task without treating absence as proof", async () => {
  const observations: string[] = [];
  const found = makeRuntime(
    makeDependencies({
      findRuns: (input) => {
        observations.push(input.workflowName);
        return Promise.resolve([matchingRemoteLeaf]);
      },
    })
  );

  assert.deepEqual(await found.leafPort.findAttemptByStartKey(leafRequest), {
    externalExecutionId: "hatchet-leaf-existing",
    status: "found",
  });
  assert.deepEqual(observations, [HATCHET_LEAF_TASK_NAME]);

  const absent = makeRuntime(makeDependencies());
  assert.deepEqual(await absent.leafPort.findAttemptByStartKey(leafRequest), {
    reason: "hatchet-leaf-start-not-visible",
    status: "outcome-unknown",
  });
});

test("returns unknown for failed or non-exact leaf lookups", async () => {
  const failed = makeRuntime(
    makeDependencies({
      findRuns: () => Promise.reject(new Error("provider unavailable")),
    })
  );
  assert.deepEqual(await failed.leafPort.findAttemptByStartKey(leafRequest), {
    reason: "hatchet-leaf-lookup-outcome-unknown",
    status: "outcome-unknown",
  });

  const mismatch = makeRuntime(
    makeDependencies({
      findRuns: () =>
        Promise.resolve([
          {
            ...matchingRemoteLeaf,
            metadata: {
              [HATCHET_LEAF_METADATA_KEYS.attemptId]: "attempt-test",
              [HATCHET_LEAF_METADATA_KEYS.eventId]: "event-leaf-test",
              [HATCHET_LEAF_METADATA_KEYS.runId]: "run-test",
              [HATCHET_LEAF_METADATA_KEYS.startKey]: "start-leaf-test",
              [HATCHET_LEAF_METADATA_KEYS.stepRunId]: "step-other",
              [HATCHET_LEAF_METADATA_KEYS.workspaceId]: "workspace-test",
            },
          },
        ]),
    })
  );
  assert.deepEqual(await mismatch.leafPort.findAttemptByStartKey(leafRequest), {
    reason: "hatchet-leaf-lookup-filter-mismatch",
    status: "outcome-unknown",
  });
});

test("owns a single worker lifecycle", async () => {
  const calls: string[] = [];
  let resolveStart: (() => void) | undefined;
  const handle: HatchetWorkerHandle = {
    start: () =>
      new Promise<void>((resolve) => {
        calls.push("start");
        resolveStart = resolve;
      }),
    stop: () => {
      calls.push("stop");
      resolveStart?.();
      return Promise.resolve();
    },
    waitUntilReady: (timeout) => {
      calls.push(`ready:${timeout}`);
      return Promise.resolve();
    },
  };
  let workers = 0;
  const runtime = makeRuntime(
    makeDependencies({
      createWorker: () => {
        workers += 1;
        return Promise.resolve(handle);
      },
    })
  );

  await runtime.worker.start();
  await runtime.worker.stop();

  assert.equal(workers, 1);
  assert.deepEqual(calls, ["start", "ready:5000", "stop"]);
});

test("reports a worker rejection that happens after readiness", async () => {
  const calls: string[] = [];
  let rejectStart: (error: unknown) => void = () => undefined;
  const handle: HatchetWorkerHandle = {
    start: () =>
      new Promise<void>((_resolve, reject) => {
        calls.push("start");
        rejectStart = reject;
      }),
    stop: () => {
      calls.push("stop");
      return Promise.resolve();
    },
    waitUntilReady: () => Promise.resolve(),
  };
  const runtime = makeRuntime(
    makeDependencies({ createWorker: async () => handle })
  );

  await runtime.worker.start();
  const failure = runtime.worker.waitForFailure();
  rejectStart(new Error("provider transport failed"));

  await assert.rejects(failure, HATCHET_LATE_EXIT);
  await assert.rejects(runtime.worker.stop(), HATCHET_SHUTDOWN_FAILURE);
  assert.deepEqual(calls, ["start", "stop"]);
});
