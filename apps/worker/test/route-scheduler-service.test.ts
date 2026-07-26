import assert from "node:assert/strict";
import test from "node:test";

import {
  createRouteSchedulerService,
  type RouteSchedulingStatus,
} from "../src/route-scheduler-service.ts";

const LATE_ROUTING_FAILURE = /routing failed late/u;

const deferred = <Value>() => {
  let reject: (error: unknown) => void = () => undefined;
  let resolve: (value: Value) => void = () => undefined;
  const promise = new Promise<Value>((resolvePromise, rejectPromise) => {
    reject = rejectPromise;
    resolve = resolvePromise;
  });
  return { promise, reject, resolve };
};

test("redrains immediately after a claim and waits after idle", async () => {
  let calls = 0;
  const service = createRouteSchedulerService({
    pollIntervalMs: 60_000,
    routeAndClaimNext: () => {
      calls += 1;
      return Promise.resolve({ status: calls === 1 ? "claimed" : "idle" });
    },
    schedulerId: "route-scheduler-test",
  });

  await service.start();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(calls, 2);
  assert.equal(service.schedulerId, "route-scheduler-test");
  await service.stop("test-complete");
});

for (const status of ["deferred", "rejected", "stale"] as const) {
  test(`waits after a ${status} result instead of busy-looping`, async () => {
    let calls = 0;
    const service = createRouteSchedulerService({
      pollIntervalMs: 60_000,
      routeAndClaimNext: () => {
        calls += 1;
        return Promise.resolve({ status });
      },
      schedulerId: "route-scheduler-test",
    });

    await service.start();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(calls, 1);
    await service.stop("test-complete");
  });
}

test("does not overlap routing and drains an in-flight cycle on stop", async () => {
  const first = deferred<RouteSchedulingStatus>();
  let active = 0;
  let maximumActive = 0;
  const service = createRouteSchedulerService({
    pollIntervalMs: 60_000,
    routeAndClaimNext: async () => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      const result = await first.promise;
      active -= 1;
      return result;
    },
    schedulerId: "route-scheduler-test",
  });

  await service.start();
  const stopping = service.stop("SIGTERM");
  first.resolve({ status: "idle" });
  await stopping;
  assert.equal(maximumActive, 1);
  assert.equal(service.running(), false);
});

test("reports a routing rejection after startup", async () => {
  const lateRouting = deferred<RouteSchedulingStatus>();
  const service = createRouteSchedulerService({
    pollIntervalMs: 60_000,
    routeAndClaimNext: () => lateRouting.promise,
    schedulerId: "route-scheduler-test",
  });

  await service.start();
  const failure = service.waitForFailure();
  lateRouting.reject(new Error("routing failed late"));

  await assert.rejects(failure, LATE_ROUTING_FAILURE);
  assert.equal(service.running(), false);
  await assert.rejects(service.stop("runtime-failure"), LATE_ROUTING_FAILURE);
});

test("rejects an invalid scheduler identity", () => {
  assert.throws(
    () =>
      createRouteSchedulerService({
        pollIntervalMs: 1000,
        routeAndClaimNext: async () => ({ status: "idle" }),
        schedulerId: " route-scheduler-test",
      }),
    RangeError
  );
});
