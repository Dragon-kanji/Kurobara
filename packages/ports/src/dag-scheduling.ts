import type {
  ActorId,
  Artifact,
  ArtifactId,
  CellResult,
  ContentHash,
  CorrelationId,
  CostReservation,
  Dataset,
  Record as DatasetRecord,
  EnrichmentRecipe,
  Field,
  ResultManifest,
  ResultManifestCost,
  ResultManifestId,
  Run,
  RunCommandReplayProof,
  RunConvergenceBlocker,
  RunId,
  RunLifecycleEvent,
  RunPlan,
  StepLifecycleEvent,
  StepRun,
  WorkspaceId,
} from "@kurobara/kernel";
import type { NormalizedJsonValue } from "./normalized-json.ts";
import type { StepRoutingRequestRepository } from "./step-routing-request.ts";

type DagWorkspaceScope = Readonly<{ workspaceId: WorkspaceId }>;

export type DagSchedulingContext = Readonly<{
  artifacts: readonly Artifact[];
  artifactPayloads?: readonly Readonly<{
    artifactId: ArtifactId;
    contentHash: ContentHash;
    value: NormalizedJsonValue;
  }>[];
  cost: ResultManifestCost;
  plan: RunPlan;
  recipeCell?: Readonly<{
    current: CellResult;
    dataset: Dataset;
    fields: readonly Field[];
    recipe: EnrichmentRecipe;
    record: DatasetRecord;
  }>;
  reservations: readonly CostReservation[];
  run: Run;
  stepRuns: readonly StepRun[];
}>;

export type DagCellResultFinalization = Readonly<{
  artifact?: Readonly<{
    artifactId: ArtifactId;
    contentHash: ContentHash;
  }>;
  cellResult: CellResult &
    Readonly<{ status: "failed" | "skipped" | "succeeded" }>;
  manifest?: Readonly<{
    manifestHash: ContentHash;
    resultManifestId: ResultManifestId;
  }>;
  sourceRunAggregateVersion: number;
}>;

export interface DagScheduleRequestRepository {
  request(scope: DagWorkspaceScope, runId: RunId): Promise<void>;
}

export interface DagSchedulingJobRepository {
  claimNextForUpdate(): Promise<DagSchedulingContext | undefined>;
  complete(
    scope: DagWorkspaceScope,
    runId: RunId,
    outcome: DagSchedulingJobOutcome
  ): Promise<void>;
}

export type DagSchedulingJobOutcome =
  | Readonly<{
      status:
        | "failure-finalized"
        | "success-finalized"
        | "stale-terminal"
        | "steps-materialized"
        | "waiting";
    }>
  | Readonly<{
      reason: RunConvergenceBlocker;
      status: "blocked";
    }>;

export interface DagSchedulingStepRepository {
  insertReady(
    scope: DagWorkspaceScope,
    stepRun: StepRun,
    event: Extract<
      StepLifecycleEvent,
      {
        eventType: "StepReady";
      }
    >
  ): Promise<void>;
  insertSkipped(
    scope: DagWorkspaceScope,
    stepRun: StepRun,
    event: Extract<
      StepLifecycleEvent,
      {
        eventType: "StepSkipped";
      }
    >
  ): Promise<void>;
}

export interface ResultManifestRepository {
  findByRun(
    scope: DagWorkspaceScope,
    runId: RunId
  ): Promise<ResultManifest | undefined>;
  insert(scope: DagWorkspaceScope, manifest: ResultManifest): Promise<void>;
}

export interface DagSchedulingRunRepository {
  update(
    scope: DagWorkspaceScope,
    expectedAggregateVersion: number,
    run: Run
  ): Promise<void>;
}

export interface DagSchedulingRunEventRepository {
  append(scope: DagWorkspaceScope, event: RunLifecycleEvent): Promise<void>;
}

export interface DagSchedulingRunCommandJournalRepository {
  insert(
    scope: DagWorkspaceScope,
    proof: RunCommandReplayProof,
    actorId: ActorId,
    correlationId: CorrelationId
  ): Promise<void>;
}

export interface DagSchedulingCellResultRepository {
  finalize(
    scope: DagWorkspaceScope,
    finalization: DagCellResultFinalization
  ): Promise<void>;
}

export type DagSchedulingUnitOfWork = Readonly<{
  cellResults?: DagSchedulingCellResultRepository;
  commandJournal: DagSchedulingRunCommandJournalRepository;
  jobs: DagSchedulingJobRepository;
  manifests: ResultManifestRepository;
  routing: StepRoutingRequestRepository;
  runEvents: DagSchedulingRunEventRepository;
  runs: DagSchedulingRunRepository;
  steps: DagSchedulingStepRepository;
}>;

export interface DagSchedulingPersistencePort {
  transactionForSystem<Value>(
    work: (unitOfWork: DagSchedulingUnitOfWork) => Promise<Value>
  ): Promise<Value>;
}
