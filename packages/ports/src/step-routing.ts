import type { Run, RunPlan, StepRun, StepRunId } from "@kurobara/kernel";

import type { WorkspaceScope } from "./run-persistence.ts";
import type { StepExecutionUnitOfWork } from "./step-execution.ts";

export type StepRoutingContext = Readonly<{
  plan: RunPlan;
  run: Run;
  stepRun: StepRun;
}>;

export interface StepRoutingJobRepository {
  /**
   * Claims only a route-empty job or a job whose immutable plan routes
   * intersect the composed registry. This prevents blocked jobs from starving
   * executable work; application-level defer remains a defensive race path.
   */
  claimNextForUpdate(
    availableEffectAdapterKeys: readonly string[]
  ): Promise<StepRoutingContext | undefined>;
  complete(scope: WorkspaceScope, stepRunId: StepRunId): Promise<void>;
  defer(
    scope: WorkspaceScope,
    stepRunId: StepRunId,
    reason: string,
    retryDelayMilliseconds: number
  ): Promise<void>;
}

export type StepRoutingUnitOfWork = StepExecutionUnitOfWork &
  Readonly<{ routingJobs: StepRoutingJobRepository }>;

export interface StepRoutingPersistencePort {
  transactionForSystem<Value>(
    work: (unitOfWork: StepRoutingUnitOfWork) => Promise<Value>
  ): Promise<Value>;
}
