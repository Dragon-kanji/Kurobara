import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import { ApiConfigError } from "../src/config.ts";
import { startApiProcess } from "../src/process.ts";

const ONE_MILLISECOND_SHUTDOWN_TIMEOUT = /Shutdown exceeded 1ms/u;
const FIXTURE_MODE_CONFIG_ERROR = /KUROBARA_FIXTURE_MODE/u;

test("fails fast when the durable database configuration is absent", async () => {
  await assert.rejects(
    startApiProcess({ environment: { NODE_ENV: "test" } }),
    ApiConfigError
  );
});

test("fails startup on invalid provider configuration without exposing credentials", async () => {
  const secret = "synthetic-provider-secret";
  await assert.rejects(
    startApiProcess({
      environment: {
        KUROBARA_PROVIDER_ORDER: "tavily,unknown",
        NODE_ENV: "test",
        TAVILY_API_KEY: secret,
      },
      transport: {
        start: () => Promise.resolve(),
        stop: () => Promise.resolve(),
      },
    }),
    (error: unknown) => {
      assert.equal(String(error).includes("KUROBARA_PROVIDER_ORDER"), true);
      assert.equal(String(error).includes(secret), false);
      return true;
    }
  );
});

test("fails startup on ambiguous deterministic fixture mode", async () => {
  await assert.rejects(
    startApiProcess({
      environment: {
        KUROBARA_FIXTURE_MODE: "true",
        NODE_ENV: "test",
      },
      transport: {
        start: () => Promise.resolve(),
        stop: () => Promise.resolve(),
      },
    }),
    (error: unknown) => {
      assert.match(String(error), FIXTURE_MODE_CONFIG_ERROR);
      return true;
    }
  );
});

test("starts, reports readiness, and stops once on SIGTERM", async () => {
  const signalHost = new EventEmitter();
  let starts = 0;
  let stops = 0;
  let stopReason = "";
  const running = await startApiProcess({
    environment: { NODE_ENV: "test" },
    signalHost,
    transport: {
      start: () => {
        starts += 1;
        return Promise.resolve();
      },
      stop: (reason) => {
        stops += 1;
        stopReason = reason;
        return Promise.resolve();
      },
    },
  });

  assert.equal(starts, 1);
  assert.deepEqual(running.lifecycle.readiness(), {
    phase: "ready",
    status: "ready",
  });

  signalHost.emit("SIGTERM", "SIGTERM");
  signalHost.emit("SIGINT", "SIGINT");
  assert.deepEqual(await running.shutdown, {
    signal: "SIGTERM",
    status: "stopped",
  });
  assert.equal(stops, 1);
  assert.equal(stopReason, "SIGTERM");
  assert.equal(running.lifecycle.readiness().status, "not-ready");
});

test("forces resource cleanup when graceful shutdown exceeds its deadline", async () => {
  const signalHost = new EventEmitter();
  let releaseGracefulStop: (() => void) | undefined;
  let forceStops = 0;
  const gracefulStop = new Promise<void>((resolve) => {
    releaseGracefulStop = resolve;
  });
  const running = await startApiProcess({
    environment: {
      KUROBARA_SHUTDOWN_TIMEOUT_MS: "1",
      NODE_ENV: "test",
    },
    signalHost,
    transport: {
      forceStop: () => {
        forceStops += 1;
        releaseGracefulStop?.();
        return Promise.resolve();
      },
      start: () => Promise.resolve(),
      stop: () => gracefulStop,
    },
  });

  signalHost.emit("SIGTERM", "SIGTERM");
  const outcome = await running.shutdown;

  assert.equal(outcome.status, "failed");
  assert.equal(outcome.signal, "SIGTERM");
  assert.match(String(outcome.error), ONE_MILLISECOND_SHUTDOWN_TIMEOUT);
  assert.equal(forceStops, 1);
  assert.equal(Reflect.get(signalHost, "exitCode"), 1);
  assert.equal(running.lifecycle.health().status, "unhealthy");
});
