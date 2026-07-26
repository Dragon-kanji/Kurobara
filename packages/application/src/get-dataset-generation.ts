import {
  type DatasetGenerationCreation,
  type DatasetGenerationId,
  type DomainResult,
  fail,
  succeed,
  type WorkspaceId,
} from "@kurobara/kernel";
import type { DatasetGenerationPersistencePort } from "@kurobara/ports";

export type GetDatasetGenerationRequest = Readonly<{
  generationId: DatasetGenerationId;
  workspaceId: WorkspaceId;
}>;

export type GetDatasetGenerationResult = DomainResult<
  DatasetGenerationCreation,
  Readonly<{ code: "dataset-generation-not-found"; message: string }>
>;

export const makeGetDatasetGeneration =
  (persistence: DatasetGenerationPersistencePort) =>
  async (
    request: GetDatasetGenerationRequest
  ): Promise<GetDatasetGenerationResult> => {
    const stored = await persistence.get(
      { workspaceId: request.workspaceId },
      request.generationId
    );
    if (
      stored === undefined ||
      stored.generation.workspaceId !== request.workspaceId ||
      stored.materialization.workspaceId !== request.workspaceId ||
      stored.generation.generationId !== request.generationId
    ) {
      return fail({
        code: "dataset-generation-not-found",
        message: "The dataset generation does not exist in this workspace.",
      });
    }
    return succeed(structuredClone(stored));
  };
