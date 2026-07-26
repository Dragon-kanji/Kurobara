import assert from "node:assert/strict";
import test from "node:test";

import { HatchetClient } from "@hatchet-dev/typescript-sdk/v1/index.js";
import {
  attemptId,
  eventId,
  runId,
  stepRunId,
  workspaceId,
} from "@kurobara/kernel";

import {
  createHatchetLeafTaskHandler,
  createHatchetOrchestration,
  HatchetAdapterConfigurationError,
} from "../src/index.ts";

const base64Url = (value: Readonly<Record<string, string>>): string =>
  Buffer.from(JSON.stringify(value)).toString("base64url");

const syntheticToken = [
  base64Url({ alg: "none", typ: "JWT" }),
  base64Url({
    grpc_broadcast_address: "127.0.0.1:1",
    server_url: "http://127.0.0.1:1",
    sub: "tenant-test",
  }),
  "synthetic-signature",
].join(".");

const validConfig = {
  apiUrl: "http://127.0.0.1:1",
  hostPort: "127.0.0.1:1",
  idempotencyTtlMilliseconds: 60_000,
  namespace: "kurobara-test",
  readinessTimeoutMilliseconds: 5000,
  requestTimeoutMilliseconds: 2500,
  slots: 1,
  tlsStrategy: "none" as const,
  token: syntheticToken,
  workerName: "worker-test",
};

test("constructs the adapter with the executable Hatchet SDK V1 API", () => {
  const orchestration = createHatchetOrchestration(
    validConfig,
    async () => undefined
  );

  assert.equal(orchestration.port.adapterKey, "orchestration-hatchet");
  assert.equal(orchestration.leafPort.adapterKey, "orchestration-hatchet");
});

test("injects a strictly validated leaf callback", async () => {
  const observed: unknown[] = [];
  const handler = createHatchetLeafTaskHandler((request) => {
    observed.push(request);
    return Promise.resolve();
  });
  const input = {
    attemptId: "attempt-callback",
    eventId: "event-callback",
    runId: "run-callback",
    startKey: "leaf-callback",
    stepRunId: "step-callback",
    workspaceId: "workspace-callback",
  };

  assert.deepEqual(await handler(input), { status: "completed" });
  assert.deepEqual(observed, [
    {
      attemptId: attemptId("attempt-callback"),
      eventId: eventId("event-callback"),
      runId: runId("run-callback"),
      startKey: "leaf-callback",
      stepRunId: stepRunId("step-callback"),
      workspaceId: workspaceId("workspace-callback"),
    },
  ]);

  await assert.rejects(handler({ ...input, extra: true }));
  assert.equal(observed.length, 1);
});

test("redacts Hatchet SDK configuration failures", () => {
  assert.throws(
    () =>
      createHatchetOrchestration(
        {
          ...validConfig,
          token: "malformed-secret-token",
        },
        async () => undefined
      ),
    (error: unknown) => {
      assert.ok(error instanceof HatchetAdapterConfigurationError);
      assert.equal(error.message, "Hatchet adapter configuration is invalid.");
      assert.equal(error.message.includes("malformed-secret-token"), false);
      return true;
    }
  );
});

test("times out a blackholed Hatchet REST transport", async () => {
  const originalInit = HatchetClient.init;
  let observedAborts = 0;
  const observedTimeouts: number[] = [];
  HatchetClient.init = (config, options, axiosConfig) =>
    originalInit(config, options, {
      ...axiosConfig,
      adapter: (request) => {
        const timeout = request.timeout;
        if (typeof timeout !== "number") {
          throw new Error("Hatchet did not configure a transport timeout.");
        }
        observedTimeouts.push(timeout);
        const transportAbort = AbortSignal.timeout(timeout);
        return new Promise((_resolve, reject) => {
          transportAbort.addEventListener(
            "abort",
            () => {
              observedAborts += 1;
              reject(transportAbort.reason);
            },
            { once: true }
          );
        });
      },
    });

  try {
    const orchestration = createHatchetOrchestration(
      {
        ...validConfig,
        requestTimeoutMilliseconds: 50,
      },
      async () => undefined
    );
    const startedAt = Date.now();
    const outcome = await orchestration.port.findRunByStartKey({
      eventId: eventId("event-transport-timeout"),
      runId: runId("run-transport-timeout"),
      startKey: "start-transport-timeout",
      workspaceId: workspaceId("workspace-transport-timeout"),
    });

    assert.deepEqual(outcome, {
      reason: "hatchet-lookup-outcome-unknown",
      status: "outcome-unknown",
    });
    assert.ok(Date.now() - startedAt < 1000);
    assert.ok(observedAborts >= 1);
    assert.ok(observedTimeouts.length >= 1);
    assert.equal(
      observedTimeouts.every((timeout) => timeout === 50),
      true
    );
  } finally {
    HatchetClient.init = originalInit;
  }
});
