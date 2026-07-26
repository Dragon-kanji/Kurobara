import {
  createDatasetGeneration,
  type DatasetGenerationCreation,
  type DatasetGenerationPlanId,
  type DomainResult,
  fail,
  succeed,
  validateDatasetGenerationSnapshot,
  type WorkspaceId,
} from "@kurobara/kernel";
import type {
  ClockPort,
  DatasetGenerationIdentifierPort,
  DatasetGenerationPersistencePort,
  StoredDatasetGeneration,
} from "@kurobara/ports";

export type CreateDatasetGenerationRequest = Readonly<{
  generationPlanId: DatasetGenerationPlanId;
  workspaceId: WorkspaceId;
}>;

export type CreateDatasetGenerationFailureCode =
  | "domain-rejected"
  | "generation-plan-not-found"
  | "generation-plan-scope-mismatch"
  | "stored-generation-conflict"
  | "target-dataset-conflict";

export type CreateDatasetGenerationFailure = Readonly<{
  code: CreateDatasetGenerationFailureCode;
  domainCode?: string;
  message: string;
}>;

export type CreateDatasetGenerationSuccess = Readonly<{
  creation: DatasetGenerationCreation;
  replayed: boolean;
}>;

export type CreateDatasetGenerationResult = DomainResult<
  CreateDatasetGenerationSuccess,
  CreateDatasetGenerationFailure
>;

export type CreateDatasetGenerationDependencies = Readonly<{
  clock: ClockPort;
  identifiers: DatasetGenerationIdentifierPort;
  persistence: DatasetGenerationPersistencePort;
}>;

const clone = <Value>(value: Value): Value => structuredClone(value);

const reject = (
  code: CreateDatasetGenerationFailureCode,
  message: string,
  domainCode?: string
): CreateDatasetGenerationResult =>
  fail({ code, message, ...(domainCode === undefined ? {} : { domainCode }) });

const replay = (
  stored: StoredDatasetGeneration,
  plan: Parameters<typeof validateDatasetGenerationSnapshot>[1]
): CreateDatasetGenerationResult => {
  const valid = validateDatasetGenerationSnapshot(stored, plan);
  return valid.ok
    ? succeed({ creation: clone(valid.value), replayed: true })
    : reject(
        "stored-generation-conflict",
        "The stored generation does not match its immutable plan.",
        valid.error.code
      );
};

export const makeCreateDatasetGeneration =
  (dependencies: CreateDatasetGenerationDependencies) =>
  (
    request: CreateDatasetGenerationRequest
  ): Promise<CreateDatasetGenerationResult> => {
    const scope = { workspaceId: request.workspaceId } as const;
    return dependencies.persistence.transaction(scope, async (unitOfWork) => {
      await unitOfWork.generations.lockPlan(scope, request.generationPlanId);
      const storedPlan = await unitOfWork.generationPlans.get(
        scope,
        request.generationPlanId
      );
      if (storedPlan === undefined) {
        return reject(
          "generation-plan-not-found",
          "The dataset generation plan does not exist in this workspace."
        );
      }
      if (storedPlan.plan.workspaceId !== request.workspaceId) {
        return reject(
          "generation-plan-scope-mismatch",
          "The dataset generation plan belongs to another workspace."
        );
      }

      await unitOfWork.generations.lockTargetDataset(
        scope,
        storedPlan.plan.requestIntent.targetDataset.datasetId
      );
      const existing = await unitOfWork.generations.findByPlan(
        scope,
        request.generationPlanId
      );
      if (existing !== undefined) {
        return replay(existing, storedPlan.plan);
      }
      const targetDatasetExists =
        await unitOfWork.generations.targetDatasetExists(
          scope,
          storedPlan.plan.requestIntent.targetDataset.datasetId
        );
      if (targetDatasetExists) {
        return reject(
          "target-dataset-conflict",
          "The target dataset is already bound to another generation."
        );
      }

      const [generationId, createdAt] = await Promise.all([
        dependencies.identifiers.nextDatasetGenerationId(),
        dependencies.clock.now(),
      ]);
      const created = createDatasetGeneration({
        createdAt,
        generationId,
        plan: storedPlan.plan,
      });
      if (!created.ok) {
        return reject(
          "domain-rejected",
          created.error.message,
          created.error.code
        );
      }
      const record = clone(created.value);
      await unitOfWork.generations.insert(scope, record, storedPlan);
      return succeed({ creation: clone(record), replayed: false });
    });
  };
