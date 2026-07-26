import assert from "node:assert/strict";
import test from "node:test";

import { createDagSchedulerService } from "../src/dag-scheduler-service.ts";

const LATE_MATERIALIZATION_FAILURE = /materialization failed late/u;
type MaterializationStatus = Readonly<{ status: "idle" | "processed" }>;

const deferred = <Value>() => {
  let reject: (error: unknown) => void = () => undefined;
  let resolve: (value: Value) => void = () => undefined;
  const promise = new Promise<Value>((resolvePromise, rejectPromise) => {
    reject = rejectPromise;
    resolve = resolvePromise;
  });
  return { promise, reject, resolve };
};

test("loops immediately after processing and waits after idle", async () => {
  let calls = 0;
  const service = createDagSchedulerService({
    materializeNext: () => {
      calls += 1;
      return Promise.resolve({
        status: calls === 1 ? "processed" : "idle",
      });
    },
    pollIntervalMs: 60_000,
  });

  await service.start();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(calls, 2);
  await service.stop("test-complete");
});

test("does not overlap materialization and drains a cycle on stop", async () => {
  const first = deferred<MaterializationStatus>();
  let active = 0;
  let maximumActive = 0;
  const service = createDagSchedulerService({
    materializeNext: async () => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      const result = await first.promise;
      active -= 1;
      return result;
    },
    pollIntervalMs: 60_000,
  });

  await service.start();
  const stopping = service.stop("SIGTERM");
  first.resolve({ status: "idle" });
  await stopping;
  assert.equal(maximumActive, 1);
  assert.equal(service.running(), false);
});

test("reports a materialization rejection after startup", async () => {
  const lateMaterialization = deferred<MaterializationStatus>();
  const service = createDagSchedulerService({
    materializeNext: () => lateMaterialization.promise,
    pollIntervalMs: 60_000,
  });

  await service.start();
  const failure = service.waitForFailure();
  lateMaterialization.reject(new Error("materialization failed late"));

  await assert.rejects(failure, LATE_MATERIALIZATION_FAILURE);
  assert.equal(service.running(), false);
  await assert.rejects(
    service.stop("runtime-failure"),
    LATE_MATERIALIZATION_FAILURE
  );
});
