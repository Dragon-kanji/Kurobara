import type {
  ArtifactId,
  CellResult,
  CellResultId,
  ContentHash,
  DatasetId,
  Record as DatasetRecord,
  EnrichmentRecipe,
  EnrichmentRecipeId,
  FieldId,
  Instant,
  RecordId,
  ResultManifestId,
  RunId,
  RunPlanId,
  ScalarValue,
  WorkflowSpecId,
  WorkspaceId,
} from "@kurobara/kernel";
import type { NormalizedJsonValue } from "./normalized-json.ts";
import type { PlanningUnitOfWork } from "./planning-persistence.ts";
import type {
  RunCreationUnitOfWork,
  WorkspaceScope,
} from "./run-persistence.ts";

export type RecipeApplicationId = string;

export type RecipeApplicationGraph = Readonly<{
  recordIds: readonly RecordId[];
}>;

export type RecipeApplicationAggregateBudget = Readonly<{
  limit: number;
  unit: string;
}>;

/**
 * Immutable grouping and intent for applying one exact recipe revision.
 * This is deliberately not a second executable lifecycle: canonical Runs own
 * execution state, retry, cancellation, ambiguity, and terminal outcomes.
 */
export type RecipeApplication = Readonly<{
  aggregateBudget?: RecipeApplicationAggregateBudget;
  createdAt: Instant;
  datasetId: DatasetId;
  graph: RecipeApplicationGraph;
  graphHash: ContentHash;
  intentHash: ContentHash;
  maxCells: number;
  recipeApplicationId: RecipeApplicationId;
  recipeId: EnrichmentRecipeId;
  recipeRevision: string;
  targetFieldId: FieldId;
  workspaceId: WorkspaceId;
}>;

export type RecipeApplicationWatchCounts = Readonly<{
  bound: number;
  failed: number;
  pending: number;
  running: number;
  skipped: number;
  succeeded: number;
  total: number;
  unbound: number;
}>;

export type RecipeApplicationWatchSnapshot = Readonly<{
  application: RecipeApplication;
  counts: RecipeApplicationWatchCounts;
}>;

export type RecipeCellInputValue =
  | Readonly<{ fieldId: FieldId; present: false }>
  | Readonly<{ fieldId: FieldId; present: true; value: ScalarValue }>;

export type ExactRecipeCellInput = Readonly<{
  cacheKey: ContentHash;
  datasetId: DatasetId;
  inputHash: ContentHash;
  inputValues: readonly RecipeCellInputValue[];
  normalizedInput: NormalizedJsonValue;
  recipeApplicationId: RecipeApplicationId;
  recipeId: EnrichmentRecipeId;
  recipeRevision: string;
  recordContentHash: ContentHash;
  recordId: RecordId;
  targetFieldId: FieldId;
  workflowContentHash: ContentHash;
  workflowRevision: string;
  workflowSpecId: WorkflowSpecId;
  workspaceId: WorkspaceId;
}>;

export type RecipeCellCacheIdentity = Readonly<{
  datasetId: DatasetId;
  inputHash: ContentHash;
  recipeId: EnrichmentRecipeId;
  recipeRevision: string;
  recordContentHash: ContentHash;
  recordId: RecordId;
  targetFieldId: FieldId;
  workflowContentHash: ContentHash;
  workflowRevision: string;
  workflowSpecId: WorkflowSpecId;
  workspaceId: WorkspaceId;
}>;

export type RecipeCellCacheSnapshot = Readonly<{
  activeCellResultId?: CellResultId;
  cacheIdentity: RecipeCellCacheIdentity;
  cacheKey: ContentHash;
  revision: number;
  validCellResultId?: CellResultId;
  validUntil?: Instant;
}>;

export type CellResultWithStatus<Status extends CellResult["status"]> =
  Readonly<Omit<CellResult, "status"> & { status: Status }>;

export type RecipeCellRunBinding = Readonly<{
  applicationBinding: "executed";
  cellResult: CellResultWithStatus<"pending">;
  input: ExactRecipeCellInput;
  inputId: string;
  runPlanId: RunPlanId;
}>;

export type RecipeCellFinalization = Readonly<{
  artifact?: Readonly<{
    artifactId: ArtifactId;
    contentHash: ContentHash;
  }>;
  cellResult: CellResultWithStatus<"failed" | "skipped" | "succeeded">;
  manifest?: Readonly<{
    manifestHash: ContentHash;
    resultManifestId: ResultManifestId;
  }>;
  sourceRunAggregateVersion: number;
}>;

export type ExactRecipeProjectionRow = Readonly<{
  application: RecipeApplication;
  binding: "cached" | "executed";
  cellResult: CellResult;
  record: DatasetRecord;
  recordContentHash: ContentHash;
}>;

export interface EnrichmentRecipeRepository {
  get(
    scope: WorkspaceScope,
    datasetId: DatasetId,
    recipeId: EnrichmentRecipeId,
    recipeRevision: string
  ): Promise<EnrichmentRecipe | undefined>;
  register(scope: WorkspaceScope, recipe: EnrichmentRecipe): Promise<void>;
}

export interface RecipeApplicationRepository {
  get(
    scope: WorkspaceScope,
    recipeApplicationId: RecipeApplicationId
  ): Promise<RecipeApplication | undefined>;
  register(
    scope: WorkspaceScope,
    application: RecipeApplication
  ): Promise<void>;
}

export interface RecipeApplicationCellRepository {
  get(
    scope: WorkspaceScope,
    recipeApplicationId: RecipeApplicationId,
    recordId: RecordId
  ): Promise<ExactRecipeProjectionRow | undefined>;
}

export interface RecipeCellInputRepository {
  resolveExact(
    scope: WorkspaceScope,
    recipeApplicationId: RecipeApplicationId,
    recordId: RecordId
  ): Promise<ExactRecipeCellInput | undefined>;
}

export interface RecipeCellCacheRepository {
  /**
   * Serializes the exact cache identity for the transaction, including when
   * the durable slot does not exist yet.
   */
  getForUpdate(
    scope: WorkspaceScope,
    cacheKey: ContentHash
  ): Promise<RecipeCellCacheSnapshot | undefined>;
}

/** DB-validated binding of a fresh cached result to an exact application cell. */
export interface RecipeCachedBindingRepository {
  pinActive(
    scope: WorkspaceScope,
    input: ExactRecipeCellInput,
    cellResultId: CellResultId
  ): Promise<void>;
  pinCached(
    scope: WorkspaceScope,
    input: ExactRecipeCellInput,
    cellResultId: CellResultId
  ): Promise<boolean>;
}

export interface RecipeApplicationWatchQueryPort {
  get(
    scope: WorkspaceScope,
    recipeApplicationId: RecipeApplicationId
  ): Promise<RecipeApplicationWatchSnapshot | undefined>;
}

/** Internal repository composed with canonical run creation. */
export interface RecipeRunCreationRepository {
  bindPending(
    scope: WorkspaceScope,
    binding: RecipeCellRunBinding
  ): Promise<void>;
}

/** Repository added to the canonical run-execution unit of work. */
export interface RecipeRunExecutionRepository {
  markRunning(
    scope: WorkspaceScope,
    runId: RunId,
    cellResult: CellResultWithStatus<"running">
  ): Promise<void>;
}

/** Repository added to the canonical DAG-convergence unit of work. */
export interface RecipeDagConvergenceRepository {
  finalize(
    scope: WorkspaceScope,
    finalization: RecipeCellFinalization
  ): Promise<void>;
}

export interface RecipeCellResultQueryRepository {
  getByRun(
    scope: WorkspaceScope,
    runId: RunId
  ): Promise<CellResult | undefined>;
}

export type RecipePersistenceUnitOfWork = Readonly<{
  applicationCells: RecipeApplicationCellRepository;
  applications: RecipeApplicationRepository;
  cache: RecipeCellCacheRepository;
  cachedBindings: RecipeCachedBindingRepository;
  cellResults: RecipeCellResultQueryRepository;
  inputs: RecipeCellInputRepository;
  recipes: EnrichmentRecipeRepository;
}>;

export interface RecipePersistencePort {
  streamExactProjection(
    scope: WorkspaceScope,
    recipeApplicationId: RecipeApplicationId
  ): AsyncIterable<ExactRecipeProjectionRow>;
  transaction<Value>(
    scope: WorkspaceScope,
    work: (unitOfWork: RecipePersistenceUnitOfWork) => Promise<Value>
  ): Promise<Value>;
}

export type RecipeCellRunCreationUnitOfWork = RunCreationUnitOfWork &
  RecipePersistenceUnitOfWork &
  Readonly<{ runCreation: RecipeRunCreationRepository }>;

export interface RecipeCellRunCreationPersistencePort {
  transaction<Value>(
    scope: WorkspaceScope,
    work: (unitOfWork: RecipeCellRunCreationUnitOfWork) => Promise<Value>
  ): Promise<Value>;
}

export type RecipeApplyUnitOfWork = RecipeCellRunCreationUnitOfWork &
  Readonly<{ planning: PlanningUnitOfWork }>;

/**
 * Persists one recipe-cell plan, canonical Run, and application binding in a
 * single workspace-scoped transaction. The aggregate apply use case opens one
 * such transaction per cell so the dataset-wide fan-out stays bounded.
 */
export interface RecipeApplyPersistencePort {
  transaction<Value>(
    scope: WorkspaceScope,
    work: (unitOfWork: RecipeApplyUnitOfWork) => Promise<Value>
  ): Promise<Value>;
}

export type RecipeRunExecutionUnitOfWork = Readonly<{
  cellResults: RecipeCellResultQueryRepository;
  runExecution: RecipeRunExecutionRepository;
}>;

export type RecipeDagConvergenceUnitOfWork = Readonly<{
  dagConvergence: RecipeDagConvergenceRepository;
}>;
