import type {
  ContentHash,
  DatasetGenerationId,
  IdempotencyKey,
  Instant,
} from "@kurobara/kernel";

import type { DatasetGenerationPageRepository } from "./dataset-generation-page.ts";
import type { DatasetGenerationPlanRepository } from "./dataset-generation-planning.ts";
import type {
  RunExecutionUnitOfWork,
  WorkspaceScope,
} from "./run-persistence.ts";

export type DatasetGenerationCancellationJournalEntry = Readonly<{
  commandHash: ContentHash;
  generationId: DatasetGenerationId;
  idempotencyKey: IdempotencyKey;
  requestedAt: Instant;
}>;

export interface DatasetGenerationCancellationJournalRepository {
  find(
    scope: WorkspaceScope,
    idempotencyKey: IdempotencyKey
  ): Promise<DatasetGenerationCancellationJournalEntry | undefined>;
  insert(
    scope: WorkspaceScope,
    entry: DatasetGenerationCancellationJournalEntry
  ): Promise<void>;
}

export type DatasetGenerationCancellationUnitOfWork = RunExecutionUnitOfWork &
  Readonly<{
    generationCancellationJournal: DatasetGenerationCancellationJournalRepository;
    generationPages: DatasetGenerationPageRepository;
    generationPlans: DatasetGenerationPlanRepository;
  }>;

export interface DatasetGenerationCancellationPersistencePort {
  transaction<Value>(
    scope: WorkspaceScope,
    work: (
      unitOfWork: DatasetGenerationCancellationUnitOfWork
    ) => Promise<Value>
  ): Promise<Value>;
}
