import type {
  Artifact,
  Attempt,
  ContactProviderIdentity,
  ContentHash,
  DatasetGenerationCreation,
  DatasetGenerationId,
  DatasetGenerationPage,
  Record as DatasetRecord,
  ResultManifest,
  RoutingDecision,
  Run,
  RunPlan,
  StepRun,
  UsageEntry,
} from "@kurobara/kernel";

import type { DatasetGenerationPlanRepository } from "./dataset-generation-planning.ts";
import type { NormalizedJsonValue } from "./normalized-json.ts";
import type {
  RunCreationUnitOfWork,
  WorkspaceScope,
} from "./run-persistence.ts";
import type { ValidatedRunInput } from "./run-plan-input.ts";

export type DatasetGenerationPageRecordWrite = Readonly<{
  candidatePosition: number;
  contentHash: ContentHash;
  generationId: DatasetGenerationId;
  pageSequence: number;
  record: DatasetRecord;
  recordOrdinal: number;
}>;

export type DatasetGenerationPageLineageWrite = Readonly<{
  artifactId: Artifact["artifactId"];
  attemptId: Attempt["attemptId"];
  candidatePosition: number;
  generationId: DatasetGenerationId;
  operationKey: Attempt["operationKey"];
  pageSequence: number;
  providerIdentity?: ContactProviderIdentity;
  recordId: DatasetRecord["recordId"];
  recordOrdinal: number;
  reservationId: UsageEntry["reservationId"];
  resultManifestId: ResultManifest["resultManifestId"];
  routingDecisionId: RoutingDecision["routingDecisionId"];
  runId: Run["runId"];
  stepRunId: StepRun["stepRunId"];
  usageEntryId: UsageEntry["usageEntryId"];
  source?: Readonly<{
    datasetId: DatasetRecord["datasetId"];
    recordId: DatasetRecord["recordId"];
  }>;
}>;

/**
 * PostgreSQL-derived proof of the canonical Run which owns a generation page.
 * Callers never provide provider output or settlement facts to the checkpoint.
 */
export type DatasetGenerationPageRunProof =
  | Readonly<{ status: "pending" }>
  | Readonly<{ reason: string; status: "failed" }>
  | Readonly<{
      attemptId?: Attempt["attemptId"];
      status: "ambiguous";
      stepRunId?: StepRun["stepRunId"];
    }>
  | Readonly<{
      artifact: Artifact;
      artifactValue: NormalizedJsonValue;
      attempt: Attempt;
      manifest: ResultManifest;
      routingDecision: RoutingDecision;
      run: Run;
      runPlan: RunPlan;
      status: "succeeded";
      stepRun: StepRun;
      usage: UsageEntry;
    }>;

export interface DatasetGenerationPageRepository {
  appendRecordsAndLineage(
    scope: WorkspaceScope,
    input: Readonly<{
      lineage: readonly DatasetGenerationPageLineageWrite[];
      records: readonly DatasetGenerationPageRecordWrite[];
    }>
  ): Promise<void>;
  computeMaterializationContentHash(
    scope: WorkspaceScope,
    generationId: DatasetGenerationId
  ): Promise<ContentHash>;
  findExistingContentHashes(
    scope: WorkspaceScope,
    generationId: DatasetGenerationId,
    contentHashes: readonly ContentHash[]
  ): Promise<readonly ContentHash[]>;
  getGenerationForUpdate(
    scope: WorkspaceScope,
    generationId: DatasetGenerationId
  ): Promise<DatasetGenerationCreation | undefined>;
  getPageForUpdate(
    scope: WorkspaceScope,
    generationId: DatasetGenerationId,
    pageSequence: number
  ): Promise<DatasetGenerationPage | undefined>;
  insertPage(scope: WorkspaceScope, page: DatasetGenerationPage): Promise<void>;
  readRunProof(
    scope: WorkspaceScope,
    page: DatasetGenerationPage
  ): Promise<DatasetGenerationPageRunProof>;
  updateGeneration(
    scope: WorkspaceScope,
    input: Readonly<{
      expectedGenerationVersion: number;
      expectedMaterializationRevision: number;
      value: DatasetGenerationCreation;
    }>
  ): Promise<void>;
  updatePage(
    scope: WorkspaceScope,
    expectedAggregateVersion: number,
    page: DatasetGenerationPage
  ): Promise<void>;
}

/** Stores the exact internal input beside its immutable RunPlan. */
export interface DatasetGenerationRunInputRepository {
  insert(
    scope: WorkspaceScope,
    runPlan: RunPlan,
    input: ValidatedRunInput
  ): Promise<void>;
}

export type DatasetGenerationPageUnitOfWork = RunCreationUnitOfWork &
  Readonly<{
    generationPages: DatasetGenerationPageRepository;
    generationPlans: DatasetGenerationPlanRepository;
    runInputs: DatasetGenerationRunInputRepository;
  }>;

export interface DatasetGenerationPagePersistencePort {
  transaction<Value>(
    scope: WorkspaceScope,
    work: (unitOfWork: DatasetGenerationPageUnitOfWork) => Promise<Value>
  ): Promise<Value>;
}

/** @deprecated Compatibility alias for the 001C first-page surface. */
export type DatasetGenerationFirstPageUnitOfWork =
  DatasetGenerationPageUnitOfWork;
/** @deprecated Compatibility alias for the 001C first-page surface. */
export type DatasetGenerationFirstPagePersistencePort =
  DatasetGenerationPagePersistencePort;
