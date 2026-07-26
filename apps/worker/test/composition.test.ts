import assert from "node:assert/strict";
import test from "node:test";

import {
  composeWorker,
  type HatchetRuntimeFactory,
  type WorkerComposition,
  type WorkerCompositionDependencies,
  WorkerEffectAdapterRegistryError,
} from "../src/main.ts";

const fixtureValue = <Value>(value: unknown): Value =>
  value as unknown as Value;

type TestDependencies = WorkerCompositionDependencies &
  Readonly<{
    executeWasInjected: () => boolean;
    materializations: () => number;
    routedAdapterKeys: () => readonly string[];
    routings: () => number;
    leafExecuteWasInjected: () => boolean;
    lookups: () => number;
    recoveryClaimAdapterKeys: () => readonly string[];
    recoveryReapAdapterKeys: () => readonly string[];
    leafOrchestration: WorkerComposition["leafOrchestration"];
    orchestration: WorkerComposition["orchestration"];
  }>;

const dependencies = (): TestDependencies => {
  let executeWasInjected = false;
  let leafExecuteWasInjected = false;
  let lookupCount = 0;
  let materializationCount = 0;
  let pendingReconciliation = true;
  const recoveryClaimAdapterKeys: string[] = [];
  const recoveryReapAdapterKeys: string[] = [];
  let routedAdapterKeys: readonly string[] = [];
  let routingCount = 0;
  const orchestration = {
    adapterKey: "orchestration-test",
    findRunByStartKey: () => {
      lookupCount += 1;
      return Promise.resolve({ status: "not-found" as const });
    },
    startRun: async () => ({
      orchestrationRunId: "orchestration-test",
      status: "accepted" as const,
    }),
  };
  const leafOrchestration = {
    adapterKey: "orchestration-test",
    findAttemptByStartKey: async () => ({
      proofId: "leaf-not-found-test",
      status: "not-found" as const,
    }),
    startAttempt: async () => ({
      externalExecutionId: "leaf-execution-test",
      status: "accepted" as const,
    }),
  };
  const createHatchetRuntime: HatchetRuntimeFactory = (
    _config,
    execute,
    executeAttempt
  ) => {
    executeWasInjected = typeof execute === "function";
    leafExecuteWasInjected = typeof executeAttempt === "function";
    return {
      leafPort: leafOrchestration,
      port: orchestration,
      worker: {
        start: async () => undefined,
        stop: async () => undefined,
      },
    };
  };
  return {
    claimRun: {
      clock: { now: async () => fixtureValue(1000) },
      identifiers: {
        nextEventId: async () => fixtureValue("event-test"),
        nextOutboxMessageId: async () => fixtureValue("outbox-test"),
        nextRunId: async () => fixtureValue("run-test"),
      },
      persistence: {
        transaction: <Value>(): Promise<Value> =>
          Promise.reject(new Error("not used by composition test")),
      },
    },
    createHatchetRuntime,
    dagSchedule: {
      clock: { now: async () => fixtureValue(1000) },
      identifiers: {
        nextEventId: async () => fixtureValue("dag-event-test"),
      },
      persistence: {
        transactionForSystem: (work) => {
          materializationCount += 1;
          return work({
            commandJournal: {
              insert: async () => undefined,
            },
            jobs: {
              claimNextForUpdate: async () => undefined,
              complete: async () => undefined,
            },
            manifests: {
              findByRun: async () => undefined,
              insert: async () => undefined,
            },
            routing: {
              request: async () => undefined,
            },
            runEvents: {
              append: async () => undefined,
            },
            runs: {
              update: async () => undefined,
            },
            steps: {
              insertReady: async () => undefined,
              insertSkipped: async () => undefined,
            },
          });
        },
      },
    },
    dagSchedulerPollIntervalMs: 60_000,
    dispatch: {
      claimLeaseMilliseconds: 30_000,
      maxAttempts: 3,
      outbox: {
        claimNext: async () => undefined,
        markDeadLetter: async () => undefined,
        markDispatched: async () => undefined,
        markReconciliationRequired: async () => undefined,
        markRetry: async () => undefined,
        markStarting: async () => undefined,
        recordStarted: async () => undefined,
        resetPending: async () => undefined,
      },
      retryDelayMilliseconds: 5000,
      workerId: "dispatcher-test",
    },
    effectAdapters: [
      {
        adapterKey: "effect-test-v1",
        execute: async () => ({
          reason: "unused",
          status: "outcome-unknown" as const,
        }),
        lookup: async () => ({
          reason: "unused",
          status: "outcome-unknown" as const,
        }),
      },
    ],
    executeWasInjected: () => executeWasInjected,
    hatchetConfig: {
      apiUrl: "http://127.0.0.1:8080",
      hostPort: "127.0.0.1:7070",
      idempotencyTtlMilliseconds: 86_400_000,
      namespace: "kurobara-test",
      slots: 1,
      tlsStrategy: "none" as const,
      token: "synthetic-token",
      workerId: "worker-test",
    },
    leafDispatch: {
      claimLeaseMilliseconds: 30_000,
      effectRecoveryDelayMilliseconds: 60_000,
      effectRecoveryMaxAttempts: 3,
      maxAttempts: 3,
      outbox: {
        claimNext: async () => undefined,
        markCancelled: async () => ({ status: "applied" as const }),
        markDeadLetter: async () => ({ status: "applied" as const }),
        markReconciliationRequired: async () => ({
          status: "applied" as const,
        }),
        markStarting: async () => ({ status: "applied" as const }),
        recordRejected: async () => ({ status: "applied" as const }),
        recordStarted: async () => ({ status: "applied" as const }),
        resetPending: async () => ({ status: "applied" as const }),
      },
      retryDelayMilliseconds: 5000,
      workerId: "leaf-dispatcher-test",
    },
    leafExecuteWasInjected: () => leafExecuteWasInjected,
    leafExecution: {
      clock: { now: async () => fixtureValue(1000) },
      identifiers: {
        nextEventId: async () => fixtureValue("leaf-event-test"),
      },
      outputValidator: {
        validate: async () => ({
          status: "accepted" as const,
          validatorVersion: "validator-test-v1",
        }),
      },
      persistence: {
        transaction: <Value>(): Promise<Value> =>
          Promise.reject(new Error("not used by composition test")),
      },
      queries: {
        getContextByStepId: async () => undefined,
        getLeafExecutionIdentity: async () => undefined,
      },
      requiredPermission: "steps:execute",
    },
    leafOrchestration,
    leafPollIntervalMs: 1000,
    leafRecovery: {
      batchSize: 1,
      claimLeaseMilliseconds: 30_000,
      operationTimeoutMilliseconds: 10_000,
      operatorId: "effect-reconciler-test",
      recovery: {
        claimNextForSystem: (input) => {
          recoveryClaimAdapterKeys.push(input.effectAdapterKey);
          return Promise.resolve(undefined);
        },
        complete: async () => ({ status: "settled" as const }),
        reapForSystem: (input) => {
          recoveryReapAdapterKeys.push(input.effectAdapterKey);
          return Promise.resolve({ completed: 0, exhausted: 0 });
        },
        release: async () => ({ status: "settled" as const }),
      },
      retryDelayMilliseconds: 5000,
    },
    leafRecoveryPollIntervalMs: 60_000,
    lookups: () => lookupCount,
    materializations: () => materializationCount,
    orchestration,
    pollIntervalMs: 1000,
    reconcile: {
      batchSize: 1,
      claimLeaseMilliseconds: 30_000,
      lookupTimeoutMilliseconds: 10_000,
      maxAttempts: 3,
      operatorId: "reconciler-test",
      reconciliation: {
        claimNextForSystem: () => {
          if (!pendingReconciliation) {
            return Promise.resolve(undefined);
          }
          pendingReconciliation = false;
          return Promise.resolve({
            adapterKey: "orchestration-test",
            claimedBy: "reconciler-test",
            claimToken: "claim-test",
            eventId: fixtureValue("event-test"),
            messageId: fixtureValue("outbox-test"),
            runId: fixtureValue("run-test"),
            startKey: "start-test",
            workspaceId: fixtureValue("workspace-test"),
          });
        },
        confirm: () => Promise.resolve({ status: "settled" as const }),
        reapExhaustedForSystem: () => Promise.resolve(0),
        release: () => Promise.resolve({ status: "settled" as const }),
      },
      retryDelayMilliseconds: 5000,
    },
    reconciliationPollIntervalMs: 60_000,
    recoveryClaimAdapterKeys: () => recoveryClaimAdapterKeys,
    recoveryReapAdapterKeys: () => recoveryReapAdapterKeys,
    routedAdapterKeys: () => routedAdapterKeys,
    routeSchedule: {
      clock: { now: async () => fixtureValue(1000) },
      persistence: {
        transactionForSystem: (work) => {
          routingCount += 1;
          return work(
            fixtureValue({
              routingJobs: {
                claimNextForUpdate: (available: readonly string[]) => {
                  routedAdapterKeys = [...available];
                  return Promise.resolve(undefined);
                },
              },
            })
          );
        },
      },
      requiredPermission: "steps:execute",
      retryDelayMilliseconds: 5000,
    },
    routeSchedulerId: "route-scheduler-test",
    routeSchedulerPollIntervalMs: 60_000,
    routings: () => routingCount,
  };
};

test("injects the durable claim callback and orchestration port", () => {
  const input = dependencies();
  const composition = composeWorker(input);

  assert.equal(input.executeWasInjected(), true);
  assert.equal(input.leafExecuteWasInjected(), true);
  assert.equal(composition.leafOrchestration, input.leafOrchestration);
  assert.equal(composition.orchestration, input.orchestration);
  assert.equal(typeof composition.executeLeafAttempt, "function");
  assert.equal(typeof composition.executeRun, "function");
});

test("uses the adapter-owned short-start executor lifecycle", async () => {
  const composition = composeWorker(dependencies());

  await composition.executor.start();
  await composition.executor.stop("test-complete");
});

test("uses the same orchestration port for periodic reconciliation", async () => {
  const input = dependencies();
  const composition = composeWorker(input);

  await composition.reconciler.start();
  await composition.reconciler.stop("test-complete");

  assert.equal(input.lookups(), 1);
});

test("polls the durable DAG materializer through the worker composition", async () => {
  const input = dependencies();
  const composition = composeWorker(input);

  await composition.dagScheduler.start();
  await new Promise<void>((resolve) => setImmediate(resolve));
  await composition.dagScheduler.stop("test-complete");

  assert.equal(input.materializations(), 1);
});

test("polls routing with only the actually composed effect adapter keys", async () => {
  const input = dependencies();
  const secondAdapter = {
    adapterKey: "effect-test-v2",
    execute: async () => ({
      reason: "unused",
      status: "outcome-unknown" as const,
    }),
    lookup: async () => ({
      reason: "unused",
      status: "outcome-unknown" as const,
    }),
  };
  const composition = composeWorker({
    ...input,
    effectAdapters: [...input.effectAdapters, secondAdapter],
  });

  await composition.routeScheduler.start();
  await new Promise<void>((resolve) => setImmediate(resolve));
  await composition.routeScheduler.stop("test-complete");

  assert.equal(input.routings(), 1);
  assert.deepEqual(input.routedAdapterKeys(), [
    "effect-test-v1",
    "effect-test-v2",
  ]);
});

test("polls and stops recovery for every composed effect adapter", async () => {
  const input = dependencies();
  const composition = composeWorker({
    ...input,
    effectAdapters: [
      ...input.effectAdapters,
      {
        adapterKey: "effect-test-v2",
        execute: async () => ({
          reason: "unused",
          status: "outcome-unknown" as const,
        }),
        lookup: async () => ({
          reason: "unused",
          status: "outcome-unknown" as const,
        }),
      },
    ],
  });

  await composition.effectReconciler.start();
  await new Promise<void>((resolve) => setImmediate(resolve));
  await composition.effectReconciler.stop("test-complete");

  assert.equal(composition.effectReconciler.running(), false);
  assert.deepEqual(input.recoveryReapAdapterKeys(), [
    "effect-test-v1",
    "effect-test-v2",
  ]);
  assert.deepEqual(input.recoveryClaimAdapterKeys(), [
    "effect-test-v1",
    "effect-test-v2",
  ]);
});

test("rejects empty, duplicate, or padded effect adapter registries", () => {
  const input = dependencies();
  assert.throws(
    () => composeWorker({ ...input, effectAdapters: [] }),
    WorkerEffectAdapterRegistryError
  );
  assert.throws(
    () =>
      composeWorker({
        ...input,
        effectAdapters: [
          input.effectAdapters[0] as NonNullable<
            (typeof input.effectAdapters)[number]
          >,
          input.effectAdapters[0] as NonNullable<
            (typeof input.effectAdapters)[number]
          >,
        ],
      }),
    WorkerEffectAdapterRegistryError
  );
  assert.throws(
    () =>
      composeWorker({
        ...input,
        effectAdapters: [
          {
            adapterKey: " effect-test-v1",
            execute: async () => ({
              reason: "unused",
              status: "outcome-unknown" as const,
            }),
            lookup: async () => ({
              reason: "unused",
              status: "outcome-unknown" as const,
            }),
          },
        ],
      }),
    WorkerEffectAdapterRegistryError
  );
});
