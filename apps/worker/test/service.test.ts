import assert from "node:assert/strict";
import test from "node:test";

import type { WorkerProcessService } from "../src/lifecycle.ts";
import { createWorkerService } from "../src/service.ts";

const DISPATCHER_UNAVAILABLE = /dispatcher unavailable/u;
const DAG_SCHEDULER_UNAVAILABLE = /dag-scheduler unavailable/u;
const RECONCILER_UNAVAILABLE = /reconciler unavailable/u;
const ROUTE_SCHEDULER_UNAVAILABLE = /route-scheduler unavailable/u;

const recordingService = (
  name: string,
  calls: string[],
  failStart = false
): WorkerProcessService => ({
  start: () => {
    calls.push(`${name}:start`);
    return failStart
      ? Promise.reject(new Error(`${name} unavailable`))
      : Promise.resolve();
  },
  stop: (reason) => {
    calls.push(`${name}:stop:${reason}`);
    return Promise.resolve();
  },
});

test("starts executor before producers and stops in reverse safety order", async () => {
  const calls: string[] = [];
  const service = createWorkerService(async () => ({
    close: () => {
      calls.push("database:close");
      return Promise.resolve();
    },
    dagScheduler: recordingService("dag-scheduler", calls),
    datasetGenerationScheduler: recordingService(
      "dataset-generation-scheduler",
      calls
    ),
    dispatcher: recordingService("dispatcher", calls),
    effectReconciler: recordingService("effect-reconciler", calls),
    executor: recordingService("executor", calls),
    leafDispatcher: recordingService("leaf-dispatcher", calls),
    reconciler: recordingService("reconciler", calls),
    routeScheduler: recordingService("route-scheduler", calls),
  }));

  await service.start();
  await service.stop("SIGTERM");

  assert.deepEqual(calls, [
    "executor:start",
    "reconciler:start",
    "effect-reconciler:start",
    "leaf-dispatcher:start",
    "route-scheduler:start",
    "dag-scheduler:start",
    "dispatcher:start",
    "dataset-generation-scheduler:start",
    "dataset-generation-scheduler:stop:SIGTERM",
    "dispatcher:stop:SIGTERM",
    "dag-scheduler:stop:SIGTERM",
    "route-scheduler:stop:SIGTERM",
    "leaf-dispatcher:stop:SIGTERM",
    "effect-reconciler:stop:SIGTERM",
    "reconciler:stop:SIGTERM",
    "executor:stop:SIGTERM",
    "database:close",
  ]);
});

test("rolls back executor and database when dispatcher startup fails", async () => {
  const calls: string[] = [];
  const service = createWorkerService(async () => ({
    close: () => {
      calls.push("database:close");
      return Promise.resolve();
    },
    dagScheduler: recordingService("dag-scheduler", calls),
    datasetGenerationScheduler: recordingService(
      "dataset-generation-scheduler",
      calls
    ),
    dispatcher: recordingService("dispatcher", calls, true),
    effectReconciler: recordingService("effect-reconciler", calls),
    executor: recordingService("executor", calls),
    leafDispatcher: recordingService("leaf-dispatcher", calls),
    reconciler: recordingService("reconciler", calls),
    routeScheduler: recordingService("route-scheduler", calls),
  }));

  await assert.rejects(() => service.start(), DISPATCHER_UNAVAILABLE);
  assert.deepEqual(calls, [
    "executor:start",
    "reconciler:start",
    "effect-reconciler:start",
    "leaf-dispatcher:start",
    "route-scheduler:start",
    "dag-scheduler:start",
    "dispatcher:start",
    "dispatcher:stop:startup-rollback",
    "dag-scheduler:stop:startup-rollback",
    "route-scheduler:stop:startup-rollback",
    "leaf-dispatcher:stop:startup-rollback",
    "effect-reconciler:stop:startup-rollback",
    "reconciler:stop:startup-rollback",
    "executor:stop:startup-rollback",
    "database:close",
  ]);
});

test("rolls back consumers when DAG scheduler startup fails", async () => {
  const calls: string[] = [];
  const service = createWorkerService(async () => ({
    close: () => {
      calls.push("database:close");
      return Promise.resolve();
    },
    dagScheduler: recordingService("dag-scheduler", calls, true),
    datasetGenerationScheduler: recordingService(
      "dataset-generation-scheduler",
      calls
    ),
    dispatcher: recordingService("dispatcher", calls),
    effectReconciler: recordingService("effect-reconciler", calls),
    executor: recordingService("executor", calls),
    leafDispatcher: recordingService("leaf-dispatcher", calls),
    reconciler: recordingService("reconciler", calls),
    routeScheduler: recordingService("route-scheduler", calls),
  }));

  await assert.rejects(() => service.start(), DAG_SCHEDULER_UNAVAILABLE);
  assert.deepEqual(calls, [
    "executor:start",
    "reconciler:start",
    "effect-reconciler:start",
    "leaf-dispatcher:start",
    "route-scheduler:start",
    "dag-scheduler:start",
    "dag-scheduler:stop:startup-rollback",
    "route-scheduler:stop:startup-rollback",
    "leaf-dispatcher:stop:startup-rollback",
    "effect-reconciler:stop:startup-rollback",
    "reconciler:stop:startup-rollback",
    "executor:stop:startup-rollback",
    "database:close",
  ]);
});

test("rolls back consumers when route scheduler startup fails", async () => {
  const calls: string[] = [];
  const service = createWorkerService(async () => ({
    close: () => {
      calls.push("database:close");
      return Promise.resolve();
    },
    dagScheduler: recordingService("dag-scheduler", calls),
    datasetGenerationScheduler: recordingService(
      "dataset-generation-scheduler",
      calls
    ),
    dispatcher: recordingService("dispatcher", calls),
    effectReconciler: recordingService("effect-reconciler", calls),
    executor: recordingService("executor", calls),
    leafDispatcher: recordingService("leaf-dispatcher", calls),
    reconciler: recordingService("reconciler", calls),
    routeScheduler: recordingService("route-scheduler", calls, true),
  }));

  await assert.rejects(() => service.start(), ROUTE_SCHEDULER_UNAVAILABLE);
  assert.deepEqual(calls, [
    "executor:start",
    "reconciler:start",
    "effect-reconciler:start",
    "leaf-dispatcher:start",
    "route-scheduler:start",
    "route-scheduler:stop:startup-rollback",
    "leaf-dispatcher:stop:startup-rollback",
    "effect-reconciler:stop:startup-rollback",
    "reconciler:stop:startup-rollback",
    "executor:stop:startup-rollback",
    "database:close",
  ]);
});

test("rolls back executor when reconciler startup fails", async () => {
  const calls: string[] = [];
  const service = createWorkerService(async () => ({
    close: () => {
      calls.push("database:close");
      return Promise.resolve();
    },
    dagScheduler: recordingService("dag-scheduler", calls),
    datasetGenerationScheduler: recordingService(
      "dataset-generation-scheduler",
      calls
    ),
    dispatcher: recordingService("dispatcher", calls),
    effectReconciler: recordingService("effect-reconciler", calls),
    executor: recordingService("executor", calls),
    leafDispatcher: recordingService("leaf-dispatcher", calls),
    reconciler: recordingService("reconciler", calls, true),
    routeScheduler: recordingService("route-scheduler", calls),
  }));

  await assert.rejects(() => service.start(), RECONCILER_UNAVAILABLE);
  assert.deepEqual(calls, [
    "executor:start",
    "reconciler:start",
    "reconciler:stop:startup-rollback",
    "executor:stop:startup-rollback",
    "database:close",
  ]);
});

test("continues cleanup after a stop failure", async () => {
  const calls: string[] = [];
  const service = createWorkerService(async () => ({
    close: () => {
      calls.push("database:close");
      return Promise.resolve();
    },
    dagScheduler: recordingService("dag-scheduler", calls),
    datasetGenerationScheduler: recordingService(
      "dataset-generation-scheduler",
      calls
    ),
    dispatcher: {
      start: () => Promise.resolve(),
      stop: () => Promise.reject(new Error("dispatcher stop failed")),
    },
    effectReconciler: recordingService("effect-reconciler", calls),
    executor: recordingService("executor", calls),
    leafDispatcher: recordingService("leaf-dispatcher", calls),
    reconciler: recordingService("reconciler", calls),
    routeScheduler: recordingService("route-scheduler", calls),
  }));

  await service.start();
  await assert.rejects(() => service.stop("SIGINT"), AggregateError);
  assert.deepEqual(calls, [
    "executor:start",
    "reconciler:start",
    "effect-reconciler:start",
    "leaf-dispatcher:start",
    "route-scheduler:start",
    "dag-scheduler:start",
    "dataset-generation-scheduler:start",
    "dataset-generation-scheduler:stop:SIGINT",
    "dag-scheduler:stop:SIGINT",
    "route-scheduler:stop:SIGINT",
    "leaf-dispatcher:stop:SIGINT",
    "effect-reconciler:stop:SIGINT",
    "reconciler:stop:SIGINT",
    "executor:stop:SIGINT",
    "database:close",
  ]);
});

test("continues cleanup after a stop step never settles", async () => {
  const calls: string[] = [];
  const service = createWorkerService(
    async () => ({
      close: () => {
        calls.push("database:close");
        return Promise.resolve();
      },
      dagScheduler: recordingService("dag-scheduler", calls),
      datasetGenerationScheduler: recordingService(
        "dataset-generation-scheduler",
        calls
      ),
      dispatcher: {
        start: () => Promise.resolve(),
        stop: () => {
          calls.push("dispatcher:stop");
          return new Promise<void>(() => undefined);
        },
      },
      effectReconciler: recordingService("effect-reconciler", calls),
      executor: recordingService("executor", calls),
      leafDispatcher: recordingService("leaf-dispatcher", calls),
      reconciler: recordingService("reconciler", calls),
      routeScheduler: recordingService("route-scheduler", calls),
    }),
    50
  );

  await service.start();
  await assert.rejects(() => service.stop("SIGINT"), AggregateError);
  assert.deepEqual(calls, [
    "executor:start",
    "reconciler:start",
    "effect-reconciler:start",
    "leaf-dispatcher:start",
    "route-scheduler:start",
    "dag-scheduler:start",
    "dataset-generation-scheduler:start",
    "dataset-generation-scheduler:stop:SIGINT",
    "dispatcher:stop",
    "dag-scheduler:stop:SIGINT",
    "route-scheduler:stop:SIGINT",
    "leaf-dispatcher:stop:SIGINT",
    "effect-reconciler:stop:SIGINT",
    "reconciler:stop:SIGINT",
    "executor:stop:SIGINT",
    "database:close",
  ]);
});
