import type {
  DatasetGenerationCreation,
  DatasetGenerationId,
  DatasetGenerationPlanId,
  DatasetId,
} from "@kurobara/kernel";

import type {
  DatasetGenerationPlanRepository,
  StoredDatasetGenerationPlan,
} from "./dataset-generation-planning.ts";
import type { WorkspaceScope } from "./run-persistence.ts";

export type StoredDatasetGeneration = DatasetGenerationCreation;

export interface DatasetGenerationRepository {
  findByPlan(
    scope: WorkspaceScope,
    generationPlanId: DatasetGenerationPlanId
  ): Promise<StoredDatasetGeneration | undefined>;
  get(
    scope: WorkspaceScope,
    generationId: DatasetGenerationId
  ): Promise<StoredDatasetGeneration | undefined>;
  insert(
    scope: WorkspaceScope,
    record: StoredDatasetGeneration,
    plan: StoredDatasetGenerationPlan
  ): Promise<void>;
  lockPlan(
    scope: WorkspaceScope,
    generationPlanId: DatasetGenerationPlanId
  ): Promise<void>;
  lockTargetDataset(scope: WorkspaceScope, datasetId: DatasetId): Promise<void>;
  targetDatasetExists(
    scope: WorkspaceScope,
    datasetId: DatasetId
  ): Promise<boolean>;
}

export type DatasetGenerationUnitOfWork = Readonly<{
  generationPlans: DatasetGenerationPlanRepository;
  generations: DatasetGenerationRepository;
}>;

export interface DatasetGenerationPersistencePort {
  get(
    scope: WorkspaceScope,
    generationId: DatasetGenerationId
  ): Promise<StoredDatasetGeneration | undefined>;
  transaction<Value>(
    scope: WorkspaceScope,
    work: (unitOfWork: DatasetGenerationUnitOfWork) => Promise<Value>
  ): Promise<Value>;
}

export interface DatasetGenerationIdentifierPort {
  nextDatasetGenerationId(): Promise<DatasetGenerationId>;
}
