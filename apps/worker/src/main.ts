import {
  makeClaimRunExecution,
  makeDispatchNextLeafOutbox,
  makeDispatchNextOutbox,
  makeExecuteLeafAttemptRegistry,
  makeMaterializeNextDagRun,
  makeReconcileLeafEffects,
  makeReconcileRunOrchestrations,
  makeRecordLeafAttemptNotStarted,
  makeRouteAndClaimNextReadyStep,
} from "@kurobara/application";

import type { HatchetWorkerConfig } from "./config.ts";
import {
  createDagSchedulerService,
  type DagSchedulerService,
} from "./dag-scheduler-service.ts";
import {
  createOutboxDispatcherService,
  type OutboxDispatcherService,
} from "./dispatcher-service.ts";
import type { WorkerProcessService } from "./lifecycle.ts";
import {
  createLeafEffectReconcilerService,
  createRunOrchestrationReconcilerService,
  type LeafEffectReconcilerService,
  type RunOrchestrationReconcilerService,
} from "./reconciler-service.ts";
import {
  createRouteSchedulerService,
  type RouteSchedulerService,
} from "./route-scheduler-service.ts";

type ClaimRunDependencies = Parameters<typeof makeClaimRunExecution>[0];
type ClaimRunExecution = ReturnType<typeof makeClaimRunExecution>;
type ClaimRunRequest = Parameters<ClaimRunExecution>[0];
type DispatchDependencies = Parameters<typeof makeDispatchNextOutbox>[0];
type OrchestrationDependency = DispatchDependencies["orchestration"];
type ExecuteLeafRegistryDependencies = Parameters<
  typeof makeExecuteLeafAttemptRegistry
>[0];
type ExecuteLeafAttempt = ReturnType<typeof makeExecuteLeafAttemptRegistry>;
type ExecuteLeafRequest = Parameters<ExecuteLeafAttempt>[0];
type LeafDispatchDependencies = Parameters<
  typeof makeDispatchNextLeafOutbox
>[0];
type LeafOrchestrationDependency =
  LeafDispatchDependencies["leafOrchestration"];
type MaterializeDagDependencies = Parameters<
  typeof makeMaterializeNextDagRun
>[0];
type ReconcileDependencies = Parameters<
  typeof makeReconcileRunOrchestrations
>[0];
type ReconcileLeafEffectsDependencies = Parameters<
  typeof makeReconcileLeafEffects
>[0];
type RouteScheduleDependencies = Parameters<
  typeof makeRouteAndClaimNextReadyStep
>[0];
type LeafEffectDependency = ExecuteLeafRegistryDependencies["effects"][number];

export type HatchetRuntime = Readonly<{
  leafPort: LeafOrchestrationDependency;
  port: OrchestrationDependency;
  worker: WorkerProcessService;
}>;

export type HatchetRuntimeFactory = (
  config: HatchetWorkerConfig,
  executeRun: (request: ClaimRunRequest) => Promise<void>,
  executeAttempt: (request: ExecuteLeafRequest) => Promise<void>
) => HatchetRuntime;

export class WorkerExecutionRejectedError extends Error {
  readonly name = "WorkerExecutionRejectedError";

  constructor() {
    super("The durable worker execution was rejected.");
  }
}

export class WorkerEffectAdapterRegistryError extends Error {
  readonly name = "WorkerEffectAdapterRegistryError";
}

export type WorkerComposition = Readonly<{
  dagScheduler: DagSchedulerService;
  dispatcher: OutboxDispatcherService;
  effectReconciler: LeafEffectReconcilerService;
  executeLeafAttempt: ExecuteLeafAttempt;
  executeRun: ClaimRunExecution;
  executor: WorkerProcessService;
  leafDispatcher: OutboxDispatcherService;
  leafOrchestration: LeafOrchestrationDependency;
  orchestration: OrchestrationDependency;
  reconciler: RunOrchestrationReconcilerService;
  routeScheduler: RouteSchedulerService;
}>;

export type WorkerCompositionDependencies = Readonly<{
  claimRun: ClaimRunDependencies;
  createHatchetRuntime: HatchetRuntimeFactory;
  dagSchedule: MaterializeDagDependencies;
  dagSchedulerPollIntervalMs: number;
  dispatch: Omit<DispatchDependencies, "orchestration">;
  effectAdapters: readonly LeafEffectDependency[];
  hatchetConfig: HatchetWorkerConfig;
  leafDispatch: Omit<
    LeafDispatchDependencies,
    "availableEffectAdapterKeys" | "leafOrchestration" | "recordNotStarted"
  >;
  leafExecution: Omit<ExecuteLeafRegistryDependencies, "effects">;
  leafPollIntervalMs: number;
  leafRecovery: Omit<
    ReconcileLeafEffectsDependencies,
    "effectAdapterKey" | "executeLeafAttempt"
  >;
  leafRecoveryPollIntervalMs: number;
  pollIntervalMs: number;
  reconcile: Omit<ReconcileDependencies, "orchestration">;
  reconciliationPollIntervalMs: number;
  routeSchedule: Omit<RouteScheduleDependencies, "availableEffectAdapterKeys">;
  routeSchedulerId: string;
  routeSchedulerPollIntervalMs: number;
}>;

const createEffectAdapterRegistry = (
  adapters: readonly LeafEffectDependency[]
): ReadonlyMap<string, LeafEffectDependency> => {
  const registry = new Map<string, LeafEffectDependency>();
  for (const adapter of adapters) {
    const key = adapter.adapterKey.trim();
    if (key.length === 0 || key !== adapter.adapterKey || registry.has(key)) {
      throw new WorkerEffectAdapterRegistryError(
        "Effect adapter keys must be unique, non-empty, and free of outer whitespace."
      );
    }
    registry.set(key, adapter);
  }
  if (registry.size === 0) {
    throw new WorkerEffectAdapterRegistryError(
      "The worker executor requires at least one composed effect adapter."
    );
  }
  return registry;
};

export const composeWorker = (
  dependencies: WorkerCompositionDependencies
): WorkerComposition => {
  const effectAdapters = createEffectAdapterRegistry(
    dependencies.effectAdapters
  );
  const availableEffectAdapterKeys = [...effectAdapters.keys()];
  const executeRun = makeClaimRunExecution(dependencies.claimRun);
  const executeLeafAttempt = makeExecuteLeafAttemptRegistry({
    ...dependencies.leafExecution,
    effects: [...effectAdapters.values()],
  });
  const materializeNextDagRun = makeMaterializeNextDagRun(
    dependencies.dagSchedule
  );
  const hatchet = dependencies.createHatchetRuntime(
    dependencies.hatchetConfig,
    async (request) => {
      const result = await executeRun(request);
      if (!result.ok) {
        throw new WorkerExecutionRejectedError();
      }
    },
    async (request) => {
      const result = await executeLeafAttempt(request);
      if (!result.ok) {
        throw new WorkerExecutionRejectedError();
      }
    }
  );
  const dispatchNext = makeDispatchNextOutbox({
    ...dependencies.dispatch,
    orchestration: hatchet.port,
  });
  const dispatcher = createOutboxDispatcherService({
    dispatchNext,
    pollIntervalMs: dependencies.pollIntervalMs,
  });
  const recordNotStarted = makeRecordLeafAttemptNotStarted({
    clock: dependencies.leafExecution.clock,
    identifiers: dependencies.leafExecution.identifiers,
    persistence: dependencies.leafExecution.persistence,
    queries: dependencies.leafExecution.queries,
    requiredPermission: dependencies.leafExecution.requiredPermission,
  });
  const dispatchNextLeaf = makeDispatchNextLeafOutbox({
    ...dependencies.leafDispatch,
    availableEffectAdapterKeys,
    leafOrchestration: hatchet.leafPort,
    recordNotStarted,
  });
  const leafDispatcher = createOutboxDispatcherService({
    dispatchNext: dispatchNextLeaf,
    pollIntervalMs: dependencies.leafPollIntervalMs,
  });
  const dagScheduler = createDagSchedulerService({
    materializeNext: materializeNextDagRun,
    pollIntervalMs: dependencies.dagSchedulerPollIntervalMs,
  });
  const reconcileLeafEffects = availableEffectAdapterKeys.map((adapterKey) =>
    makeReconcileLeafEffects({
      ...dependencies.leafRecovery,
      effectAdapterKey: adapterKey,
      executeLeafAttempt,
    })
  );
  const effectReconciler = createLeafEffectReconcilerService({
    pollIntervalMs: dependencies.leafRecoveryPollIntervalMs,
    reconcile: async () => {
      let claimed = 0;
      for (const reconcile of reconcileLeafEffects) {
        claimed += (await reconcile()).claimed;
      }
      return { claimed };
    },
  });
  const reconcileRuns = makeReconcileRunOrchestrations({
    ...dependencies.reconcile,
    orchestration: hatchet.port,
  });
  const reconciler = createRunOrchestrationReconcilerService({
    pollIntervalMs: dependencies.reconciliationPollIntervalMs,
    reconcile: reconcileRuns,
  });
  const routeAndClaimNext = makeRouteAndClaimNextReadyStep({
    ...dependencies.routeSchedule,
    availableEffectAdapterKeys,
  });
  const routeScheduler = createRouteSchedulerService({
    pollIntervalMs: dependencies.routeSchedulerPollIntervalMs,
    routeAndClaimNext,
    schedulerId: dependencies.routeSchedulerId,
  });

  return {
    dagScheduler,
    dispatcher,
    effectReconciler,
    executeLeafAttempt,
    executeRun,
    executor: hatchet.worker,
    leafDispatcher,
    leafOrchestration: hatchet.leafPort,
    orchestration: hatchet.port,
    reconciler,
    routeScheduler,
  };
};
