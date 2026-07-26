import {
  type ActorId,
  type DatasetGenerationCreation,
  type DatasetGenerationId,
  type DomainResult,
  fail,
  succeed,
  type WorkspaceId,
} from "@kurobara/kernel";
import type { DatasetGenerationPersistencePort } from "@kurobara/ports";

export type GetDatasetGenerationStatusRequest = Readonly<{
  actorId: ActorId;
  actorPermissions: readonly string[];
  generationId: DatasetGenerationId;
  workspaceId: WorkspaceId;
}>;

export type GetDatasetGenerationStatusResult = DomainResult<
  DatasetGenerationCreation,
  Readonly<{
    code: "dataset-generation-not-found" | "permission-missing";
    message: string;
  }>
>;

export const makeGetDatasetGenerationStatus = (dependencies: {
  persistence: DatasetGenerationPersistencePort;
  requiredPermission?: string;
}) => {
  const requiredPermission = dependencies.requiredPermission ?? "datasets:read";
  return async (
    request: GetDatasetGenerationStatusRequest
  ): Promise<GetDatasetGenerationStatusResult> => {
    if (!request.actorPermissions.includes(requiredPermission)) {
      return fail({
        code: "permission-missing",
        message: `Dataset generation status requires ${requiredPermission}.`,
      });
    }
    const stored = await dependencies.persistence.get(
      { workspaceId: request.workspaceId },
      request.generationId
    );
    return stored === undefined
      ? fail({
          code: "dataset-generation-not-found",
          message: "The dataset generation does not exist in this workspace.",
        })
      : succeed(structuredClone(stored));
  };
};
