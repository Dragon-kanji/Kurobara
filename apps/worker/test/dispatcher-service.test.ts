import assert from "node:assert/strict";
import test from "node:test";

import { createOutboxDispatcherService } from "../src/dispatcher-service.ts";

const LATE_DISPATCH_FAILURE = /dispatch failed late/u;

const deferred = <Value>() => {
  let reject: (error: unknown) => void = () => undefined;
  let resolve: (value: Value) => void = () => undefined;
  const promise = new Promise<Value>((resolvePromise, rejectPromise) => {
    reject = rejectPromise;
    resolve = resolvePromise;
  });
  return { promise, reject, resolve };
};

test("never overlaps outbox dispatch calls", async () => {
  const first = deferred<Readonly<{ status: string }>>();
  let calls = 0;
  let active = 0;
  let maximumActive = 0;
  const service = createOutboxDispatcherService({
    dispatchNext: async () => {
      calls += 1;
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      const result = calls === 1 ? await first.promise : { status: "idle" };
      active -= 1;
      return result;
    },
    pollIntervalMs: 60_000,
  });

  const started = service.start();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(calls, 1);
  first.resolve({ status: "dispatched" });
  await started;
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(maximumActive, 1);
  await service.stop("test-complete");
});

test("does not gate startup on the first in-flight polling cycle", async () => {
  const first = deferred<Readonly<{ status: string }>>();
  const service = createOutboxDispatcherService({
    dispatchNext: () => first.promise,
    pollIntervalMs: 60_000,
  });

  await service.start();
  assert.equal(service.running(), true);
  const stopping = service.stop("test-complete");
  first.resolve({ status: "idle" });
  await stopping;
});

test("aborts idle polling and drains an in-flight dispatch before stopping", async () => {
  const inFlight = deferred<Readonly<{ status: string }>>();
  let calls = 0;
  const service = createOutboxDispatcherService({
    dispatchNext: () => {
      calls += 1;
      if (calls === 1) {
        return Promise.resolve({ status: "dispatched" });
      }
      return inFlight.promise;
    },
    pollIntervalMs: 60_000,
  });

  await service.start();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(calls, 2);

  let stopped = false;
  const stopping = service.stop("SIGTERM").then(() => {
    stopped = true;
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(stopped, false);
  inFlight.resolve({ status: "idle" });
  await stopping;
  assert.equal(stopped, true);
  assert.equal(service.running(), false);
});

test("waits after an idle result instead of busy-looping", async () => {
  let calls = 0;
  const service = createOutboxDispatcherService({
    dispatchNext: () => {
      calls += 1;
      return Promise.resolve({ status: "idle" });
    },
    pollIntervalMs: 60_000,
  });

  await service.start();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(calls, 1);
  await service.stop("test-complete");
});

test("reports a dispatch rejection that happens after startup", async () => {
  const lateDispatch = deferred<Readonly<{ status: string }>>();
  let calls = 0;
  const service = createOutboxDispatcherService({
    dispatchNext: () => {
      calls += 1;
      return calls === 1
        ? Promise.resolve({ status: "dispatched" })
        : lateDispatch.promise;
    },
    pollIntervalMs: 60_000,
  });

  await service.start();
  await new Promise<void>((resolve) => setImmediate(resolve));
  const failure = service.waitForFailure();
  lateDispatch.reject(new Error("dispatch failed late"));

  await assert.rejects(failure, LATE_DISPATCH_FAILURE);
  assert.equal(service.running(), false);
  await assert.rejects(service.stop("runtime-failure"), LATE_DISPATCH_FAILURE);
});
