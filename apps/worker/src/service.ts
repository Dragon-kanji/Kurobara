import {
  createPostgresRuntime,
  type PostgresRuntime,
} from "@kurobara/adapter-postgres";
import {
  createRandomIdentifiers,
  createSystemClock,
} from "@kurobara/adapter-system";
import {
  makeAuthorizeDatasetGenerationPage,
  makeCheckpointDatasetGenerationPage,
} from "@kurobara/application";
import type { WorkerProcessConfig } from "./config.ts";
import { createDatasetGenerationSchedulerService } from "./dataset-generation-scheduler-service.ts";
import { createConfiguredGtmPlayExecutor } from "./gtm-play-executor.ts";
import { createGtmPlaySchedulerService } from "./gtm-play-scheduler-service.ts";
import type { WorkerProcessService } from "./lifecycle.ts";
import { composeWorker } from "./main.ts";
import { createConfiguredLeafEffectRuntime } from "./provider-effects.ts";

export type WorkerServiceTopology = Readonly<{
  close: () => Promise<void>;
  dagScheduler: WorkerProcessService;
  datasetGenerationScheduler: WorkerProcessService;
  dispatcher: WorkerProcessService;
  effectReconciler: WorkerProcessService;
  executor: WorkerProcessService;
  gtmPlayScheduler?: WorkerProcessService;
  leafDispatcher: WorkerProcessService;
  reconciler: WorkerProcessService;
  routeScheduler: WorkerProcessService;
}>;

export type WorkerServiceFactory = () => Promise<WorkerServiceTopology>;

const closeAfterStartupFailure = async (
  runtime: PostgresRuntime,
  error: unknown
): Promise<never> => {
  try {
    await runtime.close();
  } catch (closeError) {
    throw new AggregateError(
      [error, closeError],
      "Worker topology startup and database cleanup failed."
    );
  }
  throw error;
};

export const createConfiguredWorkerTopology = async (
  config: WorkerProcessConfig,
  environment: Readonly<Record<string, string | undefined>> = {}
): Promise<WorkerServiceTopology> => {
  const runtime = createPostgresRuntime(config.databaseUrl);
  try {
    const { createHatchetOrchestration } = await import(
      "@kurobara/adapter-orchestration-hatchet"
    );
    if (config.migrationMode === "apply") {
      await runtime.migrate();
    } else {
      await runtime.verifyMigrations();
    }
    await runtime.health();

    const identifiers = createRandomIdentifiers();
    const generationClock = createSystemClock();
    const leafEffects = await createConfiguredLeafEffectRuntime({
      adapterMode: config.leafEffectAdapter,
      contactPrivacy: runtime.contactPrivacy,
      environment,
    });

    const composition = composeWorker({
      claimRun: {
        clock: createSystemClock(),
        identifiers,
        persistence: runtime.runExecution,
      },
      createHatchetRuntime: (hatchetConfig, executeRun, executeAttempt) =>
        createHatchetOrchestration(
          {
            apiUrl: hatchetConfig.apiUrl,
            hostPort: hatchetConfig.hostPort,
            idempotencyTtlMilliseconds:
              hatchetConfig.idempotencyTtlMilliseconds,
            namespace: hatchetConfig.namespace,
            readinessTimeoutMilliseconds: config.readinessTimeoutMs,
            requestTimeoutMilliseconds: Math.max(
              1,
              Math.floor(config.reconciler.lookupTimeoutMs / 2)
            ),
            slots: hatchetConfig.slots,
            tlsStrategy: hatchetConfig.tlsStrategy,
            token: hatchetConfig.token,
            workerName: hatchetConfig.workerId,
          },
          executeRun,
          executeAttempt
        ),
      dagSchedule: {
        clock: createSystemClock(),
        identifiers,
        persistence: runtime.dagScheduling,
      },
      dagSchedulerPollIntervalMs: config.dagScheduler.pollIntervalMs,
      dispatch: {
        claimLeaseMilliseconds: config.dispatcher.claimLeaseMs,
        maxAttempts: config.dispatcher.maxAttempts,
        outbox: runtime.outbox,
        retryDelayMilliseconds: config.dispatcher.retryDelayMs,
        workerId: config.dispatcher.dispatcherId,
      },
      effectAdapters: leafEffects.effects,
      hatchetConfig: config.hatchet,
      leafDispatch: {
        claimLeaseMilliseconds: config.leafDispatcher.claimLeaseMs,
        effectRecoveryDelayMilliseconds:
          config.leafEffectReconciler.initialDelayMs,
        effectRecoveryMaxAttempts: config.leafEffectReconciler.maxAttempts,
        maxAttempts: config.leafDispatcher.maxAttempts,
        outbox: runtime.leafOutbox,
        retryDelayMilliseconds: config.leafDispatcher.retryDelayMs,
        workerId: config.leafDispatcher.dispatcherId,
      },
      leafExecution: {
        clock: createSystemClock(),
        identifiers,
        outputValidator: leafEffects.outputValidator,
        persistence: runtime.stepExecution,
        queries: runtime.stepQueries,
        requiredPermission: "steps:execute",
      },
      leafPollIntervalMs: config.leafDispatcher.pollIntervalMs,
      leafRecovery: {
        batchSize: config.leafEffectReconciler.batchSize,
        claimLeaseMilliseconds: config.leafEffectReconciler.claimLeaseMs,
        operationTimeoutMilliseconds:
          config.leafEffectReconciler.operationTimeoutMs,
        operatorId: config.leafEffectReconciler.operatorId,
        recovery: runtime.leafEffectRecovery,
        retryDelayMilliseconds: config.leafEffectReconciler.retryDelayMs,
      },
      leafRecoveryPollIntervalMs: config.leafEffectReconciler.pollIntervalMs,
      pollIntervalMs: config.dispatcher.pollIntervalMs,
      reconcile: {
        batchSize: config.reconciler.batchSize,
        claimLeaseMilliseconds: config.reconciler.claimLeaseMs,
        lookupTimeoutMilliseconds: config.reconciler.lookupTimeoutMs,
        maxAttempts: config.reconciler.maxAttempts,
        operatorId: config.reconciler.operatorId,
        reconciliation: runtime.orchestrationReconciliation,
        retryDelayMilliseconds: config.reconciler.retryDelayMs,
      },
      reconciliationPollIntervalMs: config.reconciler.pollIntervalMs,
      routeSchedule: {
        clock: createSystemClock(),
        persistence: runtime.stepRouting,
        requiredPermission: "steps:execute",
        retryDelayMilliseconds: config.routeScheduler.retryDelayMs,
      },
      routeSchedulerId: config.routeScheduler.schedulerId,
      routeSchedulerPollIntervalMs: config.routeScheduler.pollIntervalMs,
    });
    const datasetGenerationScheduler = createDatasetGenerationSchedulerService({
      authorize: makeAuthorizeDatasetGenerationPage({
        clock: generationClock,
        identifiers,
        persistence: runtime.datasetGenerationFirstPage,
      }),
      checkpoint: makeCheckpointDatasetGenerationPage({
        clock: generationClock,
        persistence: runtime.datasetGenerationFirstPage,
      }),
      claimLeaseMilliseconds: config.datasetGenerationScheduler.claimLeaseMs,
      clock: generationClock,
      pollIntervalMs: config.datasetGenerationScheduler.pollIntervalMs,
      schedulerId: config.datasetGenerationScheduler.schedulerId,
      work: runtime.datasetGenerationWork,
    });
    const gtmPlayExecutor = createConfiguredGtmPlayExecutor(
      runtime,
      environment
    );
    const gtmPlayScheduler = createGtmPlaySchedulerService({
      claimLeaseMs: config.datasetGenerationScheduler.claimLeaseMs,
      clock: generationClock,
      inspectGeneration: gtmPlayExecutor.inspectGeneration,
      persistence: runtime.gtm,
      pollIntervalMs: config.datasetGenerationScheduler.pollIntervalMs,
      projectWorkbook: gtmPlayExecutor.projectWorkbook,
      startStage: gtmPlayExecutor.startStage,
      workerId: `${config.datasetGenerationScheduler.schedulerId}-gtm-play`,
    });

    return {
      close: runtime.close,
      dagScheduler: composition.dagScheduler,
      datasetGenerationScheduler,
      dispatcher: composition.dispatcher,
      effectReconciler: composition.effectReconciler,
      executor: composition.executor,
      gtmPlayScheduler,
      leafDispatcher: composition.leafDispatcher,
      reconciler: composition.reconciler,
      routeScheduler: composition.routeScheduler,
    };
  } catch (error) {
    return closeAfterStartupFailure(runtime, error);
  }
};

export const createConfiguredWorkerService = (
  config: WorkerProcessConfig,
  environment: Readonly<Record<string, string | undefined>> = {}
): WorkerProcessService =>
  createWorkerService(
    () => createConfiguredWorkerTopology(config, environment),
    config.shutdownTimeoutMs
  );

class WorkerCleanupTimeoutError extends Error {
  readonly name = "WorkerCleanupTimeoutError";
}

const runCleanupOperation = (
  operation: () => Promise<void>,
  timeoutMs: number
): Promise<void> =>
  new Promise((resolve, reject) => {
    let settled = false;
    const settle = (error?: unknown): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      if (error === undefined) {
        resolve();
      } else {
        reject(error);
      }
    };
    const timeout = setTimeout(() => {
      settle(new WorkerCleanupTimeoutError("Worker cleanup step timed out."));
    }, timeoutMs);
    Promise.resolve()
      .then(operation)
      .then(
        () => settle(),
        (error: unknown) => settle(error)
      );
  });

const runCleanup = async (
  operations: readonly (() => Promise<void>)[],
  message: string,
  timeoutBudgetMs: number
): Promise<void> => {
  const failures: unknown[] = [];
  const operationTimeoutMs = Math.max(
    1,
    Math.floor(timeoutBudgetMs / (operations.length + 1))
  );
  for (const operation of operations) {
    try {
      await runCleanupOperation(operation, operationTimeoutMs);
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, message);
  }
};

export const createWorkerService = (
  createTopology: WorkerServiceFactory,
  cleanupTimeoutMs = 10_000
): WorkerProcessService => {
  if (!(Number.isSafeInteger(cleanupTimeoutMs) && cleanupTimeoutMs > 0)) {
    throw new RangeError("cleanupTimeoutMs must be a positive safe integer.");
  }
  let topology: WorkerServiceTopology | undefined;
  let rejectFailure: (error: unknown) => void = () => undefined;
  let stopPromise: Promise<void> | undefined;
  const failurePromise = new Promise<never>((_resolve, reject) => {
    rejectFailure = reject;
  });
  failurePromise.catch(() => undefined);

  const supervise = (service: WorkerProcessService): void => {
    service.waitForFailure?.().catch((error: unknown) => {
      rejectFailure(error);
    });
  };

  const start = async (): Promise<void> => {
    if (topology !== undefined) {
      return;
    }

    const candidate = await createTopology();
    const attemptedServices: WorkerProcessService[] = [];
    const startService = async (service: WorkerProcessService) => {
      attemptedServices.push(service);
      await service.start();
    };
    try {
      await startService(candidate.executor);
      await startService(candidate.reconciler);
      await startService(candidate.effectReconciler);
      await startService(candidate.leafDispatcher);
      await startService(candidate.routeScheduler);
      await startService(candidate.dagScheduler);
      await startService(candidate.dispatcher);
      await startService(candidate.datasetGenerationScheduler);
      if (candidate.gtmPlayScheduler !== undefined) {
        await startService(candidate.gtmPlayScheduler);
      }
      supervise(candidate.executor);
      supervise(candidate.reconciler);
      supervise(candidate.effectReconciler);
      supervise(candidate.leafDispatcher);
      supervise(candidate.routeScheduler);
      supervise(candidate.dagScheduler);
      supervise(candidate.dispatcher);
      supervise(candidate.datasetGenerationScheduler);
      if (candidate.gtmPlayScheduler !== undefined) {
        supervise(candidate.gtmPlayScheduler);
      }
      topology = candidate;
    } catch (error) {
      const cleanupOperations = [...attemptedServices]
        .reverse()
        .map((service) => () => service.stop("startup-rollback"));
      cleanupOperations.push(candidate.close);
      try {
        await runCleanup(
          cleanupOperations,
          "Worker startup rollback failed.",
          cleanupTimeoutMs
        );
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          "Worker startup and rollback failed."
        );
      }
      throw error;
    }
  };

  const stop = (reason: string): Promise<void> => {
    if (stopPromise !== undefined) {
      return stopPromise;
    }
    const current = topology;
    if (current === undefined) {
      return Promise.resolve();
    }
    topology = undefined;
    stopPromise = runCleanup(
      [
        ...(current.gtmPlayScheduler === undefined
          ? []
          : [
              () => current.gtmPlayScheduler?.stop(reason) ?? Promise.resolve(),
            ]),
        () => current.datasetGenerationScheduler.stop(reason),
        () => current.dispatcher.stop(reason),
        () => current.dagScheduler.stop(reason),
        () => current.routeScheduler.stop(reason),
        () => current.leafDispatcher.stop(reason),
        () => current.effectReconciler.stop(reason),
        () => current.reconciler.stop(reason),
        () => current.executor.stop(reason),
        current.close,
      ],
      "Worker resource shutdown failed.",
      cleanupTimeoutMs
    );
    return stopPromise;
  };

  return { start, stop, waitForFailure: () => failurePromise };
};
