import {
  type DatasetGenerationPlan,
  type DatasetGenerationPlanId,
  type DomainResult,
  fail,
  succeed,
  type WorkspaceId,
} from "@kurobara/kernel";
import type { DatasetGenerationPlanningPersistencePort } from "@kurobara/ports";

export type GetDatasetGenerationPlanRequest = Readonly<{
  generationPlanId: DatasetGenerationPlanId;
  workspaceId: WorkspaceId;
}>;

export type GetDatasetGenerationPlanResult = DomainResult<
  DatasetGenerationPlan,
  Readonly<{ code: "generation-plan-not-found"; message: string }>
>;

export const makeGetDatasetGenerationPlan =
  (persistence: DatasetGenerationPlanningPersistencePort) =>
  async (
    request: GetDatasetGenerationPlanRequest
  ): Promise<GetDatasetGenerationPlanResult> => {
    const stored = await persistence.get(
      { workspaceId: request.workspaceId },
      request.generationPlanId
    );
    return stored === undefined
      ? fail({
          code: "generation-plan-not-found",
          message: "The generation plan does not exist in this workspace.",
        })
      : succeed(structuredClone(stored.plan));
  };
