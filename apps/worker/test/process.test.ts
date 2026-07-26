import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import type { WorkerProcessService } from "../src/lifecycle.ts";
import { startWorkerProcess } from "../src/process.ts";
import { createWorkerService } from "../src/service.ts";

const STARTUP_FAILED = /startup failed/u;

const deferredFailure = () => {
  let reject: (error: unknown) => void = () => undefined;
  const promise = new Promise<never>((_resolve, rejectPromise) => {
    reject = rejectPromise;
  });
  promise.catch(() => undefined);
  return { promise, reject };
};

const environment = (): Record<string, string> => ({
  HATCHET_CLIENT_API_URL: "http://127.0.0.1:8080",
  HATCHET_CLIENT_HOST_PORT: "127.0.0.1:7070",
  HATCHET_CLIENT_NAMESPACE: "kurobara-test",
  HATCHET_CLIENT_TLS_STRATEGY: "none",
  HATCHET_CLIENT_TOKEN: "synthetic-token",
  KUROBARA_DATABASE_URL: "postgres://local@127.0.0.1:5432/kurobara",
  KUROBARA_DISPATCHER_ID: "dispatcher-test",
  KUROBARA_LEAF_DISPATCHER_ID: "leaf-dispatcher-test",
  KUROBARA_LEAF_EFFECT_ADAPTER: "deterministic-local",
  KUROBARA_LEAF_EFFECT_RECONCILER_ID: "effect-reconciler-test",
  KUROBARA_RECONCILER_ID: "reconciler-test",
  KUROBARA_ROUTE_SCHEDULER_ID: "route-scheduler-test",
  KUROBARA_WORKER_ID: "worker-test",
  NODE_ENV: "test",
});

test("starts an injected service, reports readiness, and stops once", async () => {
  const signalHost = new EventEmitter();
  let starts = 0;
  let stops = 0;
  let stopReason = "";
  const running = await startWorkerProcess({
    environment: environment(),
    service: {
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
    signalHost,
  });

  assert.equal(starts, 1);
  assert.deepEqual(running.lifecycle.health(), {
    phase: "ready",
    status: "healthy",
  });
  assert.equal(running.lifecycle.readiness().status, "ready");

  signalHost.emit("SIGINT", "SIGINT");
  signalHost.emit("SIGTERM", "SIGTERM");
  assert.deepEqual(await running.shutdown, {
    signal: "SIGINT",
    status: "stopped",
  });
  assert.equal(stops, 1);
  assert.equal(stopReason, "SIGINT");
  assert.equal(running.lifecycle.readiness().status, "not-ready");
});

test("fails before installing signal handlers when service startup fails", async () => {
  const signalHost = new EventEmitter();
  await assert.rejects(
    startWorkerProcess({
      environment: environment(),
      service: {
        start: () => Promise.reject(new Error("startup failed")),
        stop: () => Promise.resolve(),
      },
      signalHost,
    }),
    STARTUP_FAILED
  );
  assert.equal(signalHost.listenerCount("SIGINT"), 0);
  assert.equal(signalHost.listenerCount("SIGTERM"), 0);
});

for (const failedComponent of [
  "dispatcher",
  "dag-scheduler",
  "dataset-generation-scheduler",
  "effect-reconciler",
  "executor",
  "leaf-dispatcher",
  "reconciler",
  "route-scheduler",
] as const) {
  test(`fails and cleans up after a late ${failedComponent} rejection`, async () => {
    const calls: string[] = [];
    const dispatcherFailure = deferredFailure();
    const dagSchedulerFailure = deferredFailure();
    const datasetGenerationSchedulerFailure = deferredFailure();
    const effectReconcilerFailure = deferredFailure();
    const executorFailure = deferredFailure();
    const leafDispatcherFailure = deferredFailure();
    const reconcilerFailure = deferredFailure();
    const routeSchedulerFailure = deferredFailure();
    const component = (
      name:
        | "dispatcher"
        | "dag-scheduler"
        | "dataset-generation-scheduler"
        | "effect-reconciler"
        | "executor"
        | "leaf-dispatcher"
        | "reconciler"
        | "route-scheduler",
      failure: ReturnType<typeof deferredFailure>
    ): WorkerProcessService => ({
      start: () => {
        calls.push(`${name}:start`);
        return Promise.resolve();
      },
      stop: (reason) => {
        calls.push(`${name}:stop:${reason}`);
        return Promise.resolve();
      },
      waitForFailure: () => failure.promise,
    });
    const signalHost = new EventEmitter() as EventEmitter & {
      exitCode?: number | string;
    };
    const service = createWorkerService(async () => ({
      close: () => {
        calls.push("database:close");
        return Promise.resolve();
      },
      dagScheduler: component("dag-scheduler", dagSchedulerFailure),
      datasetGenerationScheduler: component(
        "dataset-generation-scheduler",
        datasetGenerationSchedulerFailure
      ),
      dispatcher: component("dispatcher", dispatcherFailure),
      effectReconciler: component("effect-reconciler", effectReconcilerFailure),
      executor: component("executor", executorFailure),
      leafDispatcher: component("leaf-dispatcher", leafDispatcherFailure),
      reconciler: component("reconciler", reconcilerFailure),
      routeScheduler: component("route-scheduler", routeSchedulerFailure),
    }));
    const running = await startWorkerProcess({
      environment: environment(),
      service,
      signalHost,
    });
    const failure = new Error(`${failedComponent} failed late`);

    if (failedComponent === "dispatcher") {
      dispatcherFailure.reject(failure);
    } else if (failedComponent === "dag-scheduler") {
      dagSchedulerFailure.reject(failure);
    } else if (failedComponent === "dataset-generation-scheduler") {
      datasetGenerationSchedulerFailure.reject(failure);
    } else if (failedComponent === "effect-reconciler") {
      effectReconcilerFailure.reject(failure);
    } else if (failedComponent === "executor") {
      executorFailure.reject(failure);
    } else if (failedComponent === "leaf-dispatcher") {
      leafDispatcherFailure.reject(failure);
    } else if (failedComponent === "reconciler") {
      reconcilerFailure.reject(failure);
    } else {
      routeSchedulerFailure.reject(failure);
    }

    const outcome = await running.shutdown;
    assert.equal(outcome.status, "failed");
    assert.equal(outcome.error, failure);
    assert.equal(signalHost.exitCode, 1);
    assert.deepEqual(running.lifecycle.health(), {
      phase: "failed",
      status: "unhealthy",
    });
    assert.equal(running.lifecycle.readiness().status, "not-ready");
    assert.deepEqual(calls, [
      "executor:start",
      "reconciler:start",
      "effect-reconciler:start",
      "leaf-dispatcher:start",
      "route-scheduler:start",
      "dag-scheduler:start",
      "dispatcher:start",
      "dataset-generation-scheduler:start",
      "dataset-generation-scheduler:stop:runtime-failure",
      "dispatcher:stop:runtime-failure",
      "dag-scheduler:stop:runtime-failure",
      "route-scheduler:stop:runtime-failure",
      "leaf-dispatcher:stop:runtime-failure",
      "effect-reconciler:stop:runtime-failure",
      "reconciler:stop:runtime-failure",
      "executor:stop:runtime-failure",
      "database:close",
    ]);
  });
}
