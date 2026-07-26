import assert from "node:assert/strict";
import test from "node:test";

import { createRunOrchestrationReconcilerService } from "../src/reconciler-service.ts";

const deferred = <Value>() => {
  let resolve: (value: Value) => void = () => undefined;
  const promise = new Promise<Value>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
};

test("waits between completed reconciliation batches", async () => {
  let calls = 0;
  const service = createRunOrchestrationReconcilerService({
    pollIntervalMs: 60_000,
    reconcile: () => {
      calls += 1;
      return Promise.resolve({ claimed: 1 });
    },
  });

  await service.start();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(calls, 1);
  await service.stop("test-complete");
});

test("starts before the first reconciliation settles and drains it on stop", async () => {
  const first = deferred<Readonly<{ claimed: number }>>();
  const service = createRunOrchestrationReconcilerService({
    pollIntervalMs: 60_000,
    reconcile: () => first.promise,
  });

  await service.start();
  assert.equal(service.running(), true);
  const stopping = service.stop("test-complete");
  first.resolve({ claimed: 0 });
  await stopping;
});
