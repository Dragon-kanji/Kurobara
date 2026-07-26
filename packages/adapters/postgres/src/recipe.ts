import type {
  CellResult,
  ContentHash,
  Dataset,
  DatasetId,
  Record as DatasetRecord,
  EnrichmentRecipe,
  EnrichmentRecipeId,
  Field,
  Run,
  RunId,
} from "@kurobara/kernel";
import { cellResultId, contentHash, instant } from "@kurobara/kernel";
import type {
  CellResultWithStatus,
  EnrichmentRecipeRepository,
  ExactRecipeCellInput,
  ExactRecipeProjectionRow,
  PlanningUnitOfWork,
  RecipeApplication,
  RecipeApplicationCellRepository,
  RecipeApplicationId,
  RecipeApplicationRepository,
  RecipeApplicationWatchQueryPort,
  RecipeApplyPersistencePort,
  RecipeApplyUnitOfWork,
  RecipeCachedBindingRepository,
  RecipeCellCacheIdentity,
  RecipeCellCacheRepository,
  RecipeCellCacheSnapshot,
  RecipeCellFinalization,
  RecipeCellInputRepository,
  RecipeCellResultQueryRepository,
  RecipeCellRunCreationPersistencePort,
  RecipeCellRunCreationUnitOfWork,
  RecipeDagConvergenceRepository,
  RecipeDagConvergenceUnitOfWork,
  RecipePersistencePort,
  RecipePersistenceUnitOfWork,
  RecipeRunCreationRepository,
  RecipeRunExecutionRepository,
  RecipeRunExecutionUnitOfWork,
  RunCreationUnitOfWork,
  WorkspaceScope,
} from "@kurobara/ports";
import type postgres from "postgres";

import {
  parseDatasetPayload,
  parseFieldPayload,
  parseRecordPayload,
  validateStoredFields,
} from "./dataset-payload.ts";
import {
  ImmutableRecordConflictError,
  PostgresAdapterError,
} from "./errors.ts";
import { toJsonValue } from "./json.ts";
import { parseRun } from "./payload.ts";
import {
  parseCellResultPayload,
  parseRecipeApplicationPayload,
  parseRecipeCellCacheIdentity,
  parseRecipePayload,
  recipeCanonicalHash,
  recipeCellCacheKey,
  resolveExactRecipeCellInput,
} from "./recipe-payload.ts";

type DatasetRow = Readonly<{ dataset: unknown }>;
type FieldRow = Readonly<{ field: unknown; field_id: string }>;
type RecordRow = Readonly<{
  content_hash: string;
  record: unknown;
  record_id: string;
}>;
type RecipeRow = Readonly<{
  dataset_id: string;
  enrichment_recipe_id: string;
  recipe: unknown;
  recipe_revision: string;
  target_field_id: string;
  workflow_content_hash: string;
  workflow_revision: string;
  workflow_spec_id: string;
  workspace_id: string;
}>;
type RecipeInputRow = Readonly<{ input_field_id: string; ordinal: number }>;
type ApplicationRow = Readonly<{
  application: unknown;
  dataset_id: string;
  graph_hash: string;
  intent_hash: string;
  recipe_application_id: string;
  enrichment_recipe_id: string;
  recipe_revision: string;
  target_field_id: string;
  workspace_id: string;
}>;
type ApplicationWatchRow = ApplicationRow &
  Readonly<{
    bound: number;
    failed: number;
    pending: number;
    record_count: number;
    running: number;
    skipped: number;
    succeeded: number;
  }>;
type CellRow = Readonly<{
  artifact_content_hash: string | null;
  artifact_id: string | null;
  cache_key: string;
  cell_result: unknown;
  cell_result_id: string;
  dataset_id: string;
  enrichment_recipe_id: string;
  field_id: string;
  input_hash: string;
  input_id: string;
  manifest_hash: string | null;
  recipe_application_id: string;
  recipe_revision: string;
  record_content_hash: string;
  record_id: string;
  result_manifest_id: string | null;
  run_id: string;
  run_plan_id: string;
  source_run_aggregate_version: number | null;
  status: string;
  workflow_content_hash: string;
  workflow_revision: string;
  workflow_spec_id: string;
  workspace_id: string;
}>;
type CacheRow = Readonly<{
  active_cell_result_id: string | null;
  cache_identity: unknown;
  cache_key: string;
  dataset_id: string;
  enrichment_recipe_id: string;
  field_id: string;
  input_hash: string;
  recipe_revision: string;
  record_content_hash: string;
  record_id: string;
  revision: number;
  valid_cell_result_id: string | null;
  valid_until_ms: string | null;
  workflow_content_hash: string;
  workflow_revision: string;
  workflow_spec_id: string;
  workspace_id: string;
}>;
type RunRow = Readonly<{ run: unknown }>;
type ProjectionRow = CellRow &
  Readonly<{
    application: unknown;
    binding: string;
    graph_hash: string;
    intent_hash: string;
    ordinal: number;
    projection_application_id: string;
    projection_dataset_id: string;
    projection_recipe_id: string;
    projection_recipe_revision: string;
    projection_target_field_id: string;
    projection_workspace_id: string;
    record: unknown;
  }>;

type DatasetContext = Readonly<{
  dataset: Dataset;
  fields: readonly Field[];
}>;

const assertScope = (
  transactionScope: WorkspaceScope,
  operationScope: WorkspaceScope
): void => {
  if (transactionScope.workspaceId !== operationScope.workspaceId) {
    throw new PostgresAdapterError(
      "workspace-scope-mismatch",
      "A recipe transaction cannot access another workspace."
    );
  }
};

const assertWorkspace = (scope: WorkspaceScope, workspace: string): void => {
  if (scope.workspaceId !== workspace) {
    throw new PostgresAdapterError(
      "workspace-scope-mismatch",
      "The recipe record belongs to another workspace."
    );
  }
};

const parseEpochMilliseconds = (value: string, path: string): number => {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new PostgresAdapterError(
      "database-payload-invalid",
      `${path} must be a non-negative safe integer.`
    );
  }
  return parsed;
};

const jsonMatches = (left: unknown, right: unknown): boolean =>
  recipeCanonicalHash(left) === recipeCanonicalHash(right);

const loadDatasetContext = async (
  sql: postgres.Sql,
  scope: WorkspaceScope,
  requestedDatasetId: DatasetId | string
): Promise<DatasetContext | undefined> => {
  const datasets = await sql<readonly DatasetRow[]>`
    SELECT dataset
    FROM kurobara_core.datasets
    WHERE workspace_id = ${scope.workspaceId}
      AND dataset_id = ${requestedDatasetId}
  `;
  if (datasets[0] === undefined) {
    return;
  }
  const dataset = parseDatasetPayload(
    datasets[0].dataset,
    scope.workspaceId,
    requestedDatasetId
  );
  const rows = await sql<readonly FieldRow[]>`
    SELECT field_id, field
    FROM kurobara_core.dataset_fields
    WHERE workspace_id = ${scope.workspaceId}
      AND dataset_id = ${requestedDatasetId}
    ORDER BY ordinal
  `;
  const fields = validateStoredFields(
    dataset,
    rows.map((row) => parseFieldPayload(row.field, dataset, row.field_id))
  );
  return { dataset, fields };
};

const loadRecipe = async (
  sql: postgres.Sql,
  scope: WorkspaceScope,
  requestedDatasetId: DatasetId | string,
  requestedRecipeId: EnrichmentRecipeId | string,
  requestedRevision: string
): Promise<EnrichmentRecipe | undefined> => {
  const rows = await sql<readonly RecipeRow[]>`
    SELECT
      workspace_id,
      dataset_id,
      enrichment_recipe_id,
      recipe_revision,
      target_field_id,
      workflow_spec_id,
      workflow_revision,
      workflow_content_hash,
      recipe
    FROM kurobara_core.enrichment_recipes
    WHERE workspace_id = ${scope.workspaceId}
      AND dataset_id = ${requestedDatasetId}
      AND enrichment_recipe_id = ${requestedRecipeId}
      AND recipe_revision = ${requestedRevision}
  `;
  const row = rows[0];
  if (row === undefined) {
    return;
  }
  const context = await loadDatasetContext(sql, scope, row.dataset_id);
  if (context === undefined) {
    throw new PostgresAdapterError(
      "database-identity-mismatch",
      "The stored recipe references a missing dataset."
    );
  }
  const inputRows = await sql<readonly RecipeInputRow[]>`
    SELECT ordinal, input_field_id
    FROM kurobara_core.enrichment_recipe_inputs
    WHERE workspace_id = ${row.workspace_id}
      AND dataset_id = ${row.dataset_id}
      AND enrichment_recipe_id = ${row.enrichment_recipe_id}
      AND recipe_revision = ${row.recipe_revision}
    ORDER BY ordinal
  `;
  if (inputRows.some((input, index) => input.ordinal !== index)) {
    throw new PostgresAdapterError(
      "database-payload-invalid",
      "The stored recipe input order contains a gap."
    );
  }
  return parseRecipePayload(row.recipe, context.dataset, context.fields, {
    datasetId: row.dataset_id,
    enrichmentRecipeId: row.enrichment_recipe_id,
    inputFieldIds: inputRows.map((input) => input.input_field_id),
    recipeRevision: row.recipe_revision,
    targetFieldId: row.target_field_id,
    workflowContentHash: row.workflow_content_hash,
    workflowRevision: row.workflow_revision,
    workflowSpecId: row.workflow_spec_id,
    workspaceId: row.workspace_id,
  });
};

const parseApplicationRow = (row: ApplicationRow): RecipeApplication =>
  parseRecipeApplicationPayload(row.application, {
    datasetId: row.dataset_id,
    graphHash: row.graph_hash,
    intentHash: row.intent_hash,
    recipeApplicationId: row.recipe_application_id,
    recipeId: row.enrichment_recipe_id,
    recipeRevision: row.recipe_revision,
    targetFieldId: row.target_field_id,
    workspaceId: row.workspace_id,
  });

const loadApplication = async (
  sql: postgres.Sql,
  scope: WorkspaceScope,
  applicationId: RecipeApplicationId
): Promise<RecipeApplication | undefined> => {
  const rows = await sql<readonly ApplicationRow[]>`
    SELECT
      workspace_id,
      recipe_application_id,
      dataset_id,
      enrichment_recipe_id,
      recipe_revision,
      target_field_id,
      graph_hash,
      intent_hash,
      application
    FROM kurobara_core.recipe_applications
    WHERE workspace_id = ${scope.workspaceId}
      AND recipe_application_id = ${applicationId}
  `;
  return rows[0] === undefined ? undefined : parseApplicationRow(rows[0]);
};

const loadRecord = async (
  sql: postgres.Sql,
  scope: WorkspaceScope,
  context: DatasetContext,
  requestedRecordId: string
): Promise<
  Readonly<{ contentHash: ContentHash; record: DatasetRecord }> | undefined
> => {
  const rows = await sql<readonly RecordRow[]>`
    SELECT record_id, content_hash, record
    FROM kurobara_core.dataset_records
    WHERE workspace_id = ${scope.workspaceId}
      AND dataset_id = ${context.dataset.datasetId}
      AND record_id = ${requestedRecordId}
  `;
  const row = rows[0];
  return row === undefined
    ? undefined
    : {
        contentHash: contentHash(row.content_hash),
        record: parseRecordPayload(
          row.record,
          context.dataset,
          context.fields,
          row.record_id
        ),
      };
};

const resolveExactInput = async (
  sql: postgres.Sql,
  scope: WorkspaceScope,
  applicationId: RecipeApplicationId,
  requestedRecordId: string
): Promise<ExactRecipeCellInput | undefined> => {
  const application = await loadApplication(sql, scope, applicationId);
  if (
    application === undefined ||
    !application.graph.recordIds.some(
      (graphRecordId) => graphRecordId === requestedRecordId
    )
  ) {
    return;
  }
  const context = await loadDatasetContext(sql, scope, application.datasetId);
  if (context === undefined) {
    throw new PostgresAdapterError(
      "database-identity-mismatch",
      "The recipe application references a missing dataset."
    );
  }
  const recipe = await loadRecipe(
    sql,
    scope,
    application.datasetId,
    application.recipeId,
    application.recipeRevision
  );
  const storedRecord = await loadRecord(sql, scope, context, requestedRecordId);
  if (recipe === undefined || storedRecord === undefined) {
    throw new PostgresAdapterError(
      "database-identity-mismatch",
      "The recipe application references missing immutable evidence."
    );
  }
  return resolveExactRecipeCellInput(
    application,
    context.dataset,
    recipe,
    storedRecord.record,
    storedRecord.contentHash
  );
};

const parseCellRow = async (
  sql: postgres.Sql,
  scope: WorkspaceScope,
  row: CellRow
): Promise<CellResult> => {
  const context = await loadDatasetContext(sql, scope, row.dataset_id);
  if (context === undefined) {
    throw new PostgresAdapterError(
      "database-identity-mismatch",
      "The cell result references a missing dataset."
    );
  }
  const recipe = await loadRecipe(
    sql,
    scope,
    row.dataset_id,
    row.enrichment_recipe_id,
    row.recipe_revision
  );
  const storedRecord = await loadRecord(sql, scope, context, row.record_id);
  if (
    recipe === undefined ||
    storedRecord === undefined ||
    storedRecord.contentHash !== row.record_content_hash ||
    recipe.targetFieldId !== row.field_id ||
    recipe.workflowSpecId !== row.workflow_spec_id ||
    recipe.workflowRevision !== row.workflow_revision ||
    recipe.workflowContentHash !== row.workflow_content_hash
  ) {
    throw new PostgresAdapterError(
      "database-identity-mismatch",
      "The cell result does not match its immutable recipe evidence."
    );
  }
  return parseCellResultPayload(
    row.cell_result,
    context.dataset,
    context.fields,
    storedRecord.record,
    recipe,
    {
      cellResultId: row.cell_result_id,
      datasetId: row.dataset_id,
      enrichmentRecipeId: row.enrichment_recipe_id,
      fieldId: row.field_id,
      recipeRevision: row.recipe_revision,
      recordId: row.record_id,
      runId: row.run_id,
      status: row.status,
      workspaceId: row.workspace_id,
    }
  );
};

const cellSelect = (sql: postgres.Sql) => sql`
  SELECT
    workspace_id,
    cell_result_id,
    recipe_application_id,
    dataset_id,
    record_id,
    record_content_hash,
    field_id,
    enrichment_recipe_id,
    recipe_revision,
    workflow_spec_id,
    workflow_revision,
    workflow_content_hash,
    cache_key,
    input_id,
    input_hash,
    run_plan_id,
    run_id,
    status,
    result_manifest_id,
    manifest_hash,
    artifact_id,
    artifact_content_hash,
    source_run_aggregate_version,
    cell_result
  FROM kurobara_core.cell_results
`;

const loadCellById = async (
  sql: postgres.Sql,
  scope: WorkspaceScope,
  requestedCellResultId: string
): Promise<Readonly<{ cellResult: CellResult; row: CellRow }> | undefined> => {
  const rows = await sql<readonly CellRow[]>`
    ${cellSelect(sql)}
    WHERE workspace_id = ${scope.workspaceId}
      AND cell_result_id = ${requestedCellResultId}
  `;
  const row = rows[0];
  return row === undefined
    ? undefined
    : { cellResult: await parseCellRow(sql, scope, row), row };
};

const loadCellByRun = async (
  sql: postgres.Sql,
  scope: WorkspaceScope,
  requestedRunId: string
): Promise<Readonly<{ cellResult: CellResult; row: CellRow }> | undefined> => {
  const rows = await sql<readonly CellRow[]>`
    ${cellSelect(sql)}
    WHERE workspace_id = ${scope.workspaceId}
      AND run_id = ${requestedRunId}
  `;
  const row = rows[0];
  return row === undefined
    ? undefined
    : { cellResult: await parseCellRow(sql, scope, row), row };
};

const exactInputMatches = (
  expected: ExactRecipeCellInput,
  actual: ExactRecipeCellInput
): boolean => jsonMatches(expected, actual);

const lockImmutableRecipeIdentity = async (
  sql: postgres.Sql,
  identity: readonly string[]
): Promise<void> => {
  await sql`
    SELECT pg_advisory_xact_lock(
      hashtextextended(${JSON.stringify(identity)}, 0::bigint)
    )
  `;
};

const registerRecipe = async (
  sql: postgres.Sql,
  scope: WorkspaceScope,
  recipe: EnrichmentRecipe
): Promise<void> => {
  assertWorkspace(scope, recipe.workspaceId);
  const context = await loadDatasetContext(sql, scope, recipe.datasetId);
  if (context === undefined) {
    throw new PostgresAdapterError(
      "recipe-dataset-missing",
      "A recipe requires an existing dataset."
    );
  }
  const validated = parseRecipePayload(
    toJsonValue(recipe),
    context.dataset,
    context.fields,
    {
      datasetId: recipe.datasetId,
      enrichmentRecipeId: recipe.enrichmentRecipeId,
      inputFieldIds: recipe.inputFieldIds,
      recipeRevision: recipe.recipeRevision,
      targetFieldId: recipe.targetFieldId,
      workflowContentHash: recipe.workflowContentHash,
      workflowRevision: recipe.workflowRevision,
      workflowSpecId: recipe.workflowSpecId,
      workspaceId: recipe.workspaceId,
    }
  );
  await sql`
    INSERT INTO kurobara_core.enrichment_recipes (
      workspace_id,
      dataset_id,
      enrichment_recipe_id,
      recipe_revision,
      name,
      target_field_id,
      workflow_spec_id,
      workflow_revision,
      workflow_content_hash,
      input_count,
      recipe
    ) VALUES (
      ${validated.workspaceId},
      ${validated.datasetId},
      ${validated.enrichmentRecipeId},
      ${validated.recipeRevision},
      ${validated.name},
      ${validated.targetFieldId},
      ${validated.workflowSpecId},
      ${validated.workflowRevision},
      ${validated.workflowContentHash},
      ${validated.inputFieldIds.length},
      ${sql.json(toJsonValue(validated))}
    )
    ON CONFLICT DO NOTHING
  `;
  for (
    let ordinal = 0;
    ordinal < validated.inputFieldIds.length;
    ordinal += 1
  ) {
    const inputFieldId = validated.inputFieldIds[ordinal];
    if (inputFieldId === undefined) {
      throw new PostgresAdapterError(
        "recipe-input-invalid",
        "The validated recipe input collection contains a gap."
      );
    }
    await sql`
      INSERT INTO kurobara_core.enrichment_recipe_inputs (
        workspace_id,
        dataset_id,
        enrichment_recipe_id,
        recipe_revision,
        ordinal,
        input_field_id
      ) VALUES (
        ${validated.workspaceId},
        ${validated.datasetId},
        ${validated.enrichmentRecipeId},
        ${validated.recipeRevision},
        ${ordinal},
        ${inputFieldId}
      )
      ON CONFLICT DO NOTHING
    `;
  }
  const stored = await loadRecipe(
    sql,
    scope,
    validated.datasetId,
    validated.enrichmentRecipeId,
    validated.recipeRevision
  );
  if (stored === undefined || !jsonMatches(stored, validated)) {
    throw new ImmutableRecordConflictError("enrichment recipe");
  }
};

const registerApplication = async (
  sql: postgres.Sql,
  scope: WorkspaceScope,
  application: RecipeApplication
): Promise<void> => {
  assertWorkspace(scope, application.workspaceId);
  const validated = parseRecipeApplicationPayload(toJsonValue(application), {
    datasetId: application.datasetId,
    graphHash: application.graphHash,
    intentHash: application.intentHash,
    recipeApplicationId: application.recipeApplicationId,
    recipeId: application.recipeId,
    recipeRevision: application.recipeRevision,
    targetFieldId: application.targetFieldId,
    workspaceId: application.workspaceId,
  });
  const recipe = await loadRecipe(
    sql,
    scope,
    validated.datasetId,
    validated.recipeId,
    validated.recipeRevision
  );
  if (
    recipe === undefined ||
    recipe.targetFieldId !== validated.targetFieldId
  ) {
    throw new PostgresAdapterError(
      "recipe-application-recipe-missing",
      "A recipe application requires the exact registered recipe revision."
    );
  }
  const records = await sql<readonly { record_id: string }[]>`
    SELECT record.record_id
    FROM kurobara_core.dataset_records AS record
    JOIN kurobara_core.dataset_materializations AS materialization
      ON materialization.workspace_id = record.workspace_id
      AND materialization.materialization_id = record.materialization_id
      AND materialization.dataset_id = record.dataset_id
    WHERE record.workspace_id = ${scope.workspaceId}
      AND record.dataset_id = ${validated.datasetId}
      AND record.record_id = ANY(${validated.graph.recordIds}::text[])
      AND materialization.state = 'ready'
  `;
  if (records.length !== validated.graph.recordIds.length) {
    throw new PostgresAdapterError(
      "recipe-application-record-missing",
      "A recipe application graph must reference records from a ready immutable materialization."
    );
  }
  await sql`
    INSERT INTO kurobara_core.recipe_applications (
      workspace_id,
      recipe_application_id,
      dataset_id,
      enrichment_recipe_id,
      recipe_revision,
      target_field_id,
      graph_hash,
      intent_hash,
      max_cells,
      record_count,
      application,
      created_at
    ) VALUES (
      ${validated.workspaceId},
      ${validated.recipeApplicationId},
      ${validated.datasetId},
      ${validated.recipeId},
      ${validated.recipeRevision},
      ${validated.targetFieldId},
      ${validated.graphHash},
      ${validated.intentHash},
      ${validated.maxCells},
      ${validated.graph.recordIds.length},
      ${sql.json(toJsonValue(validated))},
      ${new Date(validated.createdAt)}
    )
    ON CONFLICT DO NOTHING
  `;
  const stored = await loadApplication(
    sql,
    scope,
    validated.recipeApplicationId
  );
  if (stored === undefined || !jsonMatches(stored, validated)) {
    throw new ImmutableRecordConflictError("recipe application");
  }
};

const cacheSnapshotFromRow = (row: CacheRow): RecipeCellCacheSnapshot => {
  const identity = parseRecipeCellCacheIdentity(
    row.cache_identity,
    row.cache_key
  );
  if (
    identity.workspaceId !== row.workspace_id ||
    identity.datasetId !== row.dataset_id ||
    identity.recordId !== row.record_id ||
    identity.recordContentHash !== row.record_content_hash ||
    identity.targetFieldId !== row.field_id ||
    identity.recipeId !== row.enrichment_recipe_id ||
    identity.recipeRevision !== row.recipe_revision ||
    identity.workflowSpecId !== row.workflow_spec_id ||
    identity.workflowRevision !== row.workflow_revision ||
    identity.workflowContentHash !== row.workflow_content_hash ||
    identity.inputHash !== row.input_hash
  ) {
    throw new PostgresAdapterError(
      "database-identity-mismatch",
      "The recipe cache row does not match its canonical identity."
    );
  }
  return {
    ...(row.active_cell_result_id === null
      ? {}
      : { activeCellResultId: cellResultId(row.active_cell_result_id) }),
    cacheIdentity: identity,
    cacheKey: contentHash(row.cache_key),
    revision: row.revision,
    ...(row.valid_cell_result_id === null
      ? {}
      : { validCellResultId: cellResultId(row.valid_cell_result_id) }),
    ...(row.valid_until_ms === null
      ? {}
      : {
          validUntil: instant(
            parseEpochMilliseconds(row.valid_until_ms, "cache.validUntil")
          ),
        }),
  };
};

const loadCache = async (
  sql: postgres.Sql,
  scope: WorkspaceScope,
  cacheKey: ContentHash,
  lock: boolean
): Promise<RecipeCellCacheSnapshot | undefined> => {
  if (lock) {
    const lockIdentity = JSON.stringify([
      "recipe-cell-cache",
      scope.workspaceId,
      cacheKey,
    ]);
    await sql`
      SELECT pg_advisory_xact_lock(
        hashtextextended(${lockIdentity}, 0::bigint)
      )
    `;
  }
  const rows = await sql<readonly CacheRow[]>`
    SELECT
      workspace_id,
      cache_key,
      dataset_id,
      record_id,
      record_content_hash,
      field_id,
      enrichment_recipe_id,
      recipe_revision,
      workflow_spec_id,
      workflow_revision,
      workflow_content_hash,
      input_hash,
      active_cell_result_id,
      valid_cell_result_id,
      CASE
        WHEN valid_until IS NULL THEN NULL
        ELSE floor(extract(epoch FROM valid_until) * 1000)::bigint::text
      END AS valid_until_ms,
      revision,
      cache_identity
    FROM kurobara_core.recipe_cell_cache
    WHERE workspace_id = ${scope.workspaceId}
      AND cache_key = ${cacheKey}
    ${lock ? sql`FOR UPDATE` : sql``}
  `;
  return rows[0] === undefined ? undefined : cacheSnapshotFromRow(rows[0]);
};

const validateCacheSnapshot = (
  scope: WorkspaceScope,
  snapshot: RecipeCellCacheSnapshot
): void => {
  if (
    snapshot.cacheIdentity.workspaceId !== scope.workspaceId ||
    recipeCellCacheKey(snapshot.cacheIdentity) !== snapshot.cacheKey ||
    !Number.isSafeInteger(snapshot.revision) ||
    snapshot.revision < 1 ||
    (snapshot.validCellResultId === undefined) !==
      (snapshot.validUntil === undefined) ||
    (snapshot.activeCellResultId !== undefined &&
      snapshot.validCellResultId !== undefined &&
      snapshot.activeCellResultId === snapshot.validCellResultId)
  ) {
    throw new PostgresAdapterError(
      "recipe-cache-invalid",
      "The recipe cache snapshot violates its identity or lifecycle contract."
    );
  }
};

const cacheIdentityFromInput = (
  input: ExactRecipeCellInput
): RecipeCellCacheIdentity => ({
  datasetId: input.datasetId,
  inputHash: input.inputHash,
  recipeId: input.recipeId,
  recipeRevision: input.recipeRevision,
  recordContentHash: input.recordContentHash,
  recordId: input.recordId,
  targetFieldId: input.targetFieldId,
  workflowContentHash: input.workflowContentHash,
  workflowRevision: input.workflowRevision,
  workflowSpecId: input.workflowSpecId,
  workspaceId: input.workspaceId,
});

const saveCache = async (
  sql: postgres.Sql,
  scope: WorkspaceScope,
  expectedRevision: number | null,
  snapshot: RecipeCellCacheSnapshot
): Promise<void> => {
  validateCacheSnapshot(scope, snapshot);
  const identity = snapshot.cacheIdentity;
  let changed = 0;
  if (expectedRevision === null) {
    if (snapshot.revision !== 1) {
      throw new PostgresAdapterError(
        "recipe-cache-conflict",
        "A new recipe cache slot must start at revision 1."
      );
    }
    const rows = await sql<readonly { changed: number }[]>`
      INSERT INTO kurobara_core.recipe_cell_cache (
        workspace_id,
        cache_key,
        dataset_id,
        record_id,
        record_content_hash,
        field_id,
        enrichment_recipe_id,
        recipe_revision,
        workflow_spec_id,
        workflow_revision,
        workflow_content_hash,
        input_hash,
        active_cell_result_id,
        valid_cell_result_id,
        valid_until,
        revision,
        cache_identity
      ) VALUES (
        ${identity.workspaceId},
        ${snapshot.cacheKey},
        ${identity.datasetId},
        ${identity.recordId},
        ${identity.recordContentHash},
        ${identity.targetFieldId},
        ${identity.recipeId},
        ${identity.recipeRevision},
        ${identity.workflowSpecId},
        ${identity.workflowRevision},
        ${identity.workflowContentHash},
        ${identity.inputHash},
        ${snapshot.activeCellResultId ?? null},
        ${snapshot.validCellResultId ?? null},
        ${snapshot.validUntil === undefined ? null : new Date(snapshot.validUntil)},
        ${snapshot.revision},
        ${sql.json(toJsonValue(identity))}
      )
      ON CONFLICT DO NOTHING
      RETURNING 1 AS changed
    `;
    changed = rows.length;
  } else {
    if (snapshot.revision !== expectedRevision + 1) {
      throw new PostgresAdapterError(
        "recipe-cache-conflict",
        "A recipe cache update must advance its revision by one."
      );
    }
    const rows = await sql<readonly { changed: number }[]>`
      UPDATE kurobara_core.recipe_cell_cache
      SET
        active_cell_result_id = ${snapshot.activeCellResultId ?? null},
        valid_cell_result_id = ${snapshot.validCellResultId ?? null},
        valid_until = ${snapshot.validUntil === undefined ? null : new Date(snapshot.validUntil)},
        revision = ${snapshot.revision},
        updated_at = clock_timestamp()
      WHERE workspace_id = ${scope.workspaceId}
        AND cache_key = ${snapshot.cacheKey}
        AND revision = ${expectedRevision}
      RETURNING 1 AS changed
    `;
    changed = rows.length;
  }
  if (changed !== 1) {
    throw new PostgresAdapterError(
      "recipe-cache-conflict",
      "The recipe cache slot no longer has the expected revision."
    );
  }
  const stored = await loadCache(sql, scope, snapshot.cacheKey, false);
  if (stored === undefined || !jsonMatches(stored, snapshot)) {
    throw new PostgresAdapterError(
      "recipe-cache-readback-mismatch",
      "The recipe cache write did not preserve its exact snapshot."
    );
  }
};

const claimCacheForPendingCell = async (
  sql: postgres.Sql,
  scope: WorkspaceScope,
  input: ExactRecipeCellInput,
  pendingCellResultId: CellResult["cellResultId"]
): Promise<void> => {
  const current = await loadCache(sql, scope, input.cacheKey, true);
  const identity = cacheIdentityFromInput(input);
  if (current === undefined) {
    await saveCache(sql, scope, null, {
      activeCellResultId: pendingCellResultId,
      cacheIdentity: identity,
      cacheKey: input.cacheKey,
      revision: 1,
    });
    return;
  }
  if (
    !jsonMatches(current.cacheIdentity, identity) ||
    current.cacheKey !== input.cacheKey
  ) {
    throw new PostgresAdapterError(
      "recipe-cache-identity-conflict",
      "The locked recipe cache slot has another exact input identity."
    );
  }
  if (current.activeCellResultId === pendingCellResultId) {
    return;
  }
  if (current.activeCellResultId !== undefined) {
    throw new PostgresAdapterError(
      "recipe-cache-active-conflict",
      "Another canonical run is already active for this exact recipe input."
    );
  }
  if (current.validUntil !== undefined) {
    const rows = await sql<readonly { now_ms: string }[]>`
      SELECT floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint::text
        AS now_ms
    `;
    const now = rows[0];
    if (
      now === undefined ||
      current.validUntil > parseEpochMilliseconds(now.now_ms, "database.now")
    ) {
      throw new PostgresAdapterError(
        "recipe-cache-valid-conflict",
        "A fresh canonical result already exists for this exact recipe input."
      );
    }
  }
  await saveCache(sql, scope, current.revision, {
    ...current,
    activeCellResultId: pendingCellResultId,
    revision: current.revision + 1,
  });
};

const terminalCacheValidity = (
  current: RecipeCellCacheSnapshot,
  cellResult: CellResult
): Pick<RecipeCellCacheSnapshot, "validCellResultId" | "validUntil"> => {
  if (cellResult.status === "succeeded") {
    const expiresAt = cellResult.freshness?.expiresAt;
    return expiresAt === undefined
      ? {}
      : { validCellResultId: cellResult.cellResultId, validUntil: expiresAt };
  }
  return {
    ...(current.validCellResultId === undefined
      ? {}
      : { validCellResultId: current.validCellResultId }),
    ...(current.validUntil === undefined
      ? {}
      : { validUntil: current.validUntil }),
  };
};

const settleCacheForTerminalCell = async (
  sql: postgres.Sql,
  scope: WorkspaceScope,
  row: CellRow,
  cellResult: CellResult
): Promise<void> => {
  const current = await loadCache(sql, scope, contentHash(row.cache_key), true);
  if (current?.activeCellResultId !== cellResult.cellResultId) {
    throw new PostgresAdapterError(
      "recipe-cache-active-conflict",
      "The terminal cell result no longer owns its exact recipe cache slot."
    );
  }
  await saveCache(sql, scope, current.revision, {
    cacheIdentity: current.cacheIdentity,
    cacheKey: current.cacheKey,
    revision: current.revision + 1,
    ...terminalCacheValidity(current, cellResult),
  });
};

const insertApplicationCell = async (
  sql: postgres.Sql,
  input: ExactRecipeCellInput,
  cellResultIdValue: string,
  binding: "cached" | "executed"
): Promise<void> => {
  const application = await loadApplication(
    sql,
    { workspaceId: input.workspaceId },
    input.recipeApplicationId
  );
  const ordinal = application?.graph.recordIds.indexOf(input.recordId) ?? -1;
  if (ordinal < 0) {
    throw new PostgresAdapterError(
      "recipe-application-cell-invalid",
      "The record is not present in the immutable application graph."
    );
  }
  await sql`
    INSERT INTO kurobara_core.recipe_application_cells (
      workspace_id,
      recipe_application_id,
      dataset_id,
      record_id,
      record_content_hash,
      ordinal,
      field_id,
      enrichment_recipe_id,
      recipe_revision,
      input_hash,
      cache_key,
      cell_result_id,
      binding
    ) VALUES (
      ${input.workspaceId},
      ${input.recipeApplicationId},
      ${input.datasetId},
      ${input.recordId},
      ${input.recordContentHash},
      ${ordinal},
      ${input.targetFieldId},
      ${input.recipeId},
      ${input.recipeRevision},
      ${input.inputHash},
      ${input.cacheKey},
      ${cellResultIdValue},
      ${binding}
    )
    ON CONFLICT DO NOTHING
  `;
  const rows = await sql<readonly { matches: boolean }[]>`
    SELECT (
      dataset_id = ${input.datasetId}
      AND record_content_hash = ${input.recordContentHash}
      AND ordinal = ${ordinal}
      AND field_id = ${input.targetFieldId}
      AND enrichment_recipe_id = ${input.recipeId}
      AND recipe_revision = ${input.recipeRevision}
      AND input_hash = ${input.inputHash}
      AND cache_key = ${input.cacheKey}
      AND cell_result_id = ${cellResultIdValue}
      AND binding = ${binding}
    ) AS matches
    FROM kurobara_core.recipe_application_cells
    WHERE workspace_id = ${input.workspaceId}
      AND recipe_application_id = ${input.recipeApplicationId}
      AND record_id = ${input.recordId}
  `;
  if (rows[0]?.matches !== true) {
    throw new ImmutableRecordConflictError("recipe application cell");
  }
};

const bindPending = async (
  sql: postgres.Sql,
  scope: WorkspaceScope,
  binding: Parameters<RecipeRunCreationRepository["bindPending"]>[1]
): Promise<void> => {
  if (binding.applicationBinding !== "executed") {
    throw new PostgresAdapterError(
      "recipe-application-binding-invalid",
      "A new cell result must be bound as executed."
    );
  }
  const input = binding.input;
  assertWorkspace(scope, input.workspaceId);
  const resolved = await resolveExactInput(
    sql,
    scope,
    input.recipeApplicationId,
    input.recordId
  );
  if (resolved === undefined || !exactInputMatches(input, resolved)) {
    throw new PostgresAdapterError(
      "recipe-input-mismatch",
      "The requested cell does not match the exact stored recipe input."
    );
  }
  const context = await loadDatasetContext(sql, scope, input.datasetId);
  const recipe = await loadRecipe(
    sql,
    scope,
    input.datasetId,
    input.recipeId,
    input.recipeRevision
  );
  const storedRecord =
    context === undefined
      ? undefined
      : await loadRecord(sql, scope, context, input.recordId);
  if (
    context === undefined ||
    recipe === undefined ||
    storedRecord === undefined
  ) {
    throw new PostgresAdapterError(
      "recipe-input-missing",
      "The requested cell input evidence is no longer available."
    );
  }
  const cellResult = parseCellResultPayload(
    toJsonValue(binding.cellResult),
    context.dataset,
    context.fields,
    storedRecord.record,
    recipe,
    {
      cellResultId: binding.cellResult.cellResultId,
      datasetId: input.datasetId,
      enrichmentRecipeId: input.recipeId,
      fieldId: input.targetFieldId,
      recipeRevision: input.recipeRevision,
      recordId: input.recordId,
      runId: binding.cellResult.runId,
      status: "pending",
      workspaceId: input.workspaceId,
    }
  );
  await sql`
    INSERT INTO kurobara_core.cell_results (
      workspace_id,
      cell_result_id,
      recipe_application_id,
      dataset_id,
      record_id,
      record_content_hash,
      field_id,
      enrichment_recipe_id,
      recipe_revision,
      workflow_spec_id,
      workflow_revision,
      workflow_content_hash,
      cache_key,
      input_id,
      input_hash,
      run_plan_id,
      run_id,
      status,
      cell_result
    ) VALUES (
      ${input.workspaceId},
      ${cellResult.cellResultId},
      ${input.recipeApplicationId},
      ${input.datasetId},
      ${input.recordId},
      ${input.recordContentHash},
      ${input.targetFieldId},
      ${input.recipeId},
      ${input.recipeRevision},
      ${input.workflowSpecId},
      ${input.workflowRevision},
      ${input.workflowContentHash},
      ${input.cacheKey},
      ${binding.inputId},
      ${input.inputHash},
      ${binding.runPlanId},
      ${cellResult.runId},
      'pending',
      ${sql.json(toJsonValue(cellResult))}
    )
    ON CONFLICT DO NOTHING
  `;
  const stored = await loadCellById(sql, scope, cellResult.cellResultId);
  if (
    stored === undefined ||
    stored.row.cache_key !== input.cacheKey ||
    stored.row.input_hash !== input.inputHash ||
    stored.row.input_id !== binding.inputId ||
    stored.row.run_plan_id !== binding.runPlanId ||
    !jsonMatches(stored.cellResult, cellResult)
  ) {
    throw new ImmutableRecordConflictError("pending cell result");
  }
  await claimCacheForPendingCell(sql, scope, input, cellResult.cellResultId);
  await insertApplicationCell(sql, input, cellResult.cellResultId, "executed");
};

const pinCached = async (
  sql: postgres.Sql,
  scope: WorkspaceScope,
  input: ExactRecipeCellInput,
  requestedCellResultId: string
): Promise<boolean> => {
  assertWorkspace(scope, input.workspaceId);
  const resolved = await resolveExactInput(
    sql,
    scope,
    input.recipeApplicationId,
    input.recordId
  );
  const cache = await loadCache(sql, scope, input.cacheKey, true);
  const nowRows = await sql<readonly { now_ms: string }[]>`
    SELECT floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint::text
      AS now_ms
  `;
  const now = nowRows[0];
  const stored = await loadCellById(sql, scope, requestedCellResultId);
  if (
    resolved === undefined ||
    !exactInputMatches(input, resolved) ||
    cache === undefined ||
    cache.validCellResultId !== requestedCellResultId ||
    cache.validUntil === undefined ||
    now === undefined ||
    !jsonMatches(cache.cacheIdentity, cacheIdentityFromInput(input)) ||
    stored === undefined ||
    stored.cellResult.status !== "succeeded" ||
    stored.row.cache_key !== input.cacheKey ||
    stored.row.input_hash !== input.inputHash ||
    stored.row.dataset_id !== input.datasetId ||
    stored.row.record_id !== input.recordId ||
    stored.row.record_content_hash !== input.recordContentHash ||
    stored.row.field_id !== input.targetFieldId ||
    stored.row.enrichment_recipe_id !== input.recipeId ||
    stored.row.recipe_revision !== input.recipeRevision
  ) {
    throw new PostgresAdapterError(
      "recipe-cache-binding-invalid",
      "A cached application cell must pin one exact succeeded cell result."
    );
  }
  if (cache.validUntil <= parseEpochMilliseconds(now.now_ms, "database.now")) {
    return false;
  }
  await insertApplicationCell(sql, input, requestedCellResultId, "cached");
  return true;
};

const pinActive = async (
  sql: postgres.Sql,
  scope: WorkspaceScope,
  input: ExactRecipeCellInput,
  requestedCellResultId: string
): Promise<void> => {
  assertWorkspace(scope, input.workspaceId);
  const resolved = await resolveExactInput(
    sql,
    scope,
    input.recipeApplicationId,
    input.recordId
  );
  const cache = await loadCache(sql, scope, input.cacheKey, true);
  const stored = await loadCellById(sql, scope, requestedCellResultId);
  if (
    resolved === undefined ||
    !exactInputMatches(input, resolved) ||
    cache === undefined ||
    cache.activeCellResultId !== requestedCellResultId ||
    !jsonMatches(cache.cacheIdentity, cacheIdentityFromInput(input)) ||
    stored === undefined ||
    (stored.cellResult.status !== "pending" &&
      stored.cellResult.status !== "running") ||
    stored.row.cache_key !== input.cacheKey ||
    stored.row.input_hash !== input.inputHash ||
    stored.row.dataset_id !== input.datasetId ||
    stored.row.record_id !== input.recordId ||
    stored.row.record_content_hash !== input.recordContentHash ||
    stored.row.field_id !== input.targetFieldId ||
    stored.row.enrichment_recipe_id !== input.recipeId ||
    stored.row.recipe_revision !== input.recipeRevision
  ) {
    throw new PostgresAdapterError(
      "recipe-active-binding-invalid",
      "An active application cell must pin the exact in-flight cell result."
    );
  }
  await insertApplicationCell(sql, input, requestedCellResultId, "executed");
};

const cellTransitionMatches = (
  stored: Readonly<{ cellResult: CellResult; row: CellRow }>,
  proposed: CellResult,
  evidence?: RecipeCellFinalization
): boolean =>
  jsonMatches(stored.cellResult, proposed) &&
  (evidence === undefined ||
    (stored.row.result_manifest_id ===
      (evidence.manifest?.resultManifestId ?? null) &&
      stored.row.manifest_hash === (evidence.manifest?.manifestHash ?? null) &&
      stored.row.artifact_id === (evidence.artifact?.artifactId ?? null) &&
      stored.row.artifact_content_hash ===
        (evidence.artifact?.contentHash ?? null) &&
      stored.row.source_run_aggregate_version ===
        (evidence.sourceRunAggregateVersion ?? null)));

const loadCellPayloadContext = async (
  sql: postgres.Sql,
  scope: WorkspaceScope,
  row: CellRow
): Promise<
  Readonly<{
    context: DatasetContext;
    recipe: EnrichmentRecipe;
    record: DatasetRecord;
  }>
> => {
  const context = await loadDatasetContext(sql, scope, row.dataset_id);
  const recipe = await loadRecipe(
    sql,
    scope,
    row.dataset_id,
    row.enrichment_recipe_id,
    row.recipe_revision
  );
  const storedRecord =
    context === undefined
      ? undefined
      : await loadRecord(sql, scope, context, row.record_id);
  if (
    context === undefined ||
    recipe === undefined ||
    storedRecord === undefined
  ) {
    throw new PostgresAdapterError(
      "cell-result-evidence-missing",
      "The cell result immutable evidence is unavailable."
    );
  }
  return { context, recipe, record: storedRecord.record };
};

export type PostgresRecipeCellConvergenceContext = Readonly<{
  current: CellResult;
  dataset: Dataset;
  fields: readonly Field[];
  recipe: EnrichmentRecipe;
  record: DatasetRecord;
}>;

export const loadPostgresRecipeCellConvergenceContext = async (
  sql: postgres.Sql,
  scope: WorkspaceScope,
  requestedRunId: RunId
): Promise<PostgresRecipeCellConvergenceContext | undefined> => {
  const stored = await loadCellByRun(sql, scope, requestedRunId);
  if (stored === undefined) {
    return;
  }
  const { context, recipe, record } = await loadCellPayloadContext(
    sql,
    scope,
    stored.row
  );
  return {
    current: stored.cellResult,
    dataset: context.dataset,
    fields: context.fields,
    recipe,
    record,
  };
};

const isTerminalCellResult = (cellResult: CellResult): boolean =>
  cellResult.status === "succeeded" ||
  cellResult.status === "failed" ||
  cellResult.status === "skipped";

const finalizationEvidenceIsValid = (
  finalization: RecipeCellFinalization
): boolean => {
  const hasCanonicalRunVersion =
    finalization.sourceRunAggregateVersion !== undefined &&
    Number.isSafeInteger(finalization.sourceRunAggregateVersion) &&
    finalization.sourceRunAggregateVersion >= 1;
  if (finalization.cellResult.status === "succeeded") {
    return (
      hasCanonicalRunVersion &&
      finalization.manifest !== undefined &&
      finalization.artifact !== undefined
    );
  }
  if (finalization.cellResult.status === "failed") {
    return (
      hasCanonicalRunVersion &&
      finalization.manifest !== undefined &&
      finalization.artifact === undefined
    );
  }
  return (
    hasCanonicalRunVersion &&
    finalization.manifest === undefined &&
    finalization.artifact === undefined
  );
};

const runSupportsFinalization = (
  run: Run,
  finalization: RecipeCellFinalization
): boolean => {
  const { cellResult, manifest, sourceRunAggregateVersion } = finalization;
  if (
    run.workspaceId !== cellResult.workspaceId ||
    run.runId !== cellResult.runId ||
    run.aggregateVersion !== sourceRunAggregateVersion
  ) {
    return false;
  }
  if (cellResult.status === "skipped") {
    return (
      run.state === "cancelled" &&
      run.resultManifest === undefined &&
      manifest === undefined
    );
  }
  const expectedRunState =
    cellResult.status === "succeeded" ? "completed" : "failed";
  return (
    run.state === expectedRunState &&
    manifest !== undefined &&
    run.resultManifest?.resultManifestId === manifest.resultManifestId &&
    run.resultManifest.manifestHash === manifest.manifestHash
  );
};

const assertCanonicalRunFinalization = async (
  sql: postgres.Sql,
  scope: WorkspaceScope,
  finalization: RecipeCellFinalization
): Promise<void> => {
  const rows = await sql<readonly RunRow[]>`
    SELECT run
    FROM kurobara_core.runs
    WHERE workspace_id = ${scope.workspaceId}
      AND run_id = ${finalization.cellResult.runId}
    FOR UPDATE
  `;
  const row = rows[0];
  if (
    rows.length !== 1 ||
    row === undefined ||
    !runSupportsFinalization(parseRun(row.run), finalization)
  ) {
    throw new PostgresAdapterError(
      "cell-result-evidence-invalid",
      "The terminal cell result does not match its locked canonical Run."
    );
  }
};

const markRunning = async (
  sql: postgres.Sql,
  scope: WorkspaceScope,
  requestedRunId: string,
  proposed: CellResultWithStatus<"running">
): Promise<void> => {
  const stored = await loadCellByRun(sql, scope, requestedRunId);
  if (stored === undefined) {
    throw new PostgresAdapterError(
      "cell-result-missing",
      "The canonical run has no bound cell result."
    );
  }
  const row = stored.row;
  const { context, recipe, record } = await loadCellPayloadContext(
    sql,
    scope,
    row
  );
  const cellResult = parseCellResultPayload(
    toJsonValue(proposed),
    context.dataset,
    context.fields,
    record,
    recipe,
    {
      cellResultId: row.cell_result_id,
      datasetId: row.dataset_id,
      enrichmentRecipeId: row.enrichment_recipe_id,
      fieldId: row.field_id,
      recipeRevision: row.recipe_revision,
      recordId: row.record_id,
      runId: row.run_id,
      status: "running",
      workspaceId: row.workspace_id,
    }
  );
  if (stored.cellResult.status === "running") {
    if (cellTransitionMatches(stored, cellResult)) {
      return;
    }
    throw new ImmutableRecordConflictError("running cell result");
  }
  const rows = await sql<readonly { changed: number }[]>`
    UPDATE kurobara_core.cell_results
    SET
      status = 'running',
      confidence = ${cellResult.confidence ?? null},
      cost = ${cellResult.cost === undefined ? null : sql.json(toJsonValue(cellResult.cost))},
      freshness = ${cellResult.freshness === undefined ? null : sql.json(toJsonValue(cellResult.freshness))},
      provenance = ${cellResult.provenance === undefined ? null : sql.json(toJsonValue(cellResult.provenance))},
      cell_result = ${sql.json(toJsonValue(cellResult))},
      updated_at = clock_timestamp()
    WHERE workspace_id = ${scope.workspaceId}
      AND run_id = ${requestedRunId}
      AND status = 'pending'
    RETURNING 1 AS changed
  `;
  if (rows.length !== 1) {
    throw new PostgresAdapterError(
      "cell-result-transition-conflict",
      "The cell result could not transition from pending to running."
    );
  }
};

const finalizeCell = async (
  sql: postgres.Sql,
  scope: WorkspaceScope,
  finalization: RecipeCellFinalization
): Promise<void> => {
  const proposed = finalization.cellResult;
  const stored = await loadCellById(sql, scope, proposed.cellResultId);
  if (stored === undefined) {
    throw new PostgresAdapterError(
      "cell-result-missing",
      "The terminal cell result has no pending canonical row."
    );
  }
  const row = stored.row;
  const { context, recipe, record } = await loadCellPayloadContext(
    sql,
    scope,
    row
  );
  const cellResult = parseCellResultPayload(
    toJsonValue(proposed),
    context.dataset,
    context.fields,
    record,
    recipe,
    {
      cellResultId: row.cell_result_id,
      datasetId: row.dataset_id,
      enrichmentRecipeId: row.enrichment_recipe_id,
      fieldId: row.field_id,
      recipeRevision: row.recipe_revision,
      recordId: row.record_id,
      runId: row.run_id,
      status: proposed.status,
      workspaceId: row.workspace_id,
    }
  );
  if (!finalizationEvidenceIsValid(finalization)) {
    throw new PostgresAdapterError(
      "cell-result-evidence-invalid",
      "A terminal cell result requires exact canonical run evidence."
    );
  }
  await assertCanonicalRunFinalization(sql, scope, finalization);
  if (isTerminalCellResult(stored.cellResult)) {
    if (cellTransitionMatches(stored, cellResult, finalization)) {
      return;
    }
    throw new ImmutableRecordConflictError("terminal cell result");
  }
  const hasValue = Object.hasOwn(cellResult, "value");
  const rows = await sql<readonly { changed: number }[]>`
    UPDATE kurobara_core.cell_results
    SET
      status = ${cellResult.status},
      value = CASE
        WHEN ${hasValue} THEN COALESCE(
          ${hasValue ? sql.json(toJsonValue(cellResult.value)) : null},
          'null'::jsonb
        )
        ELSE NULL
      END,
      confidence = ${cellResult.confidence ?? null},
      cost = ${cellResult.cost === undefined ? null : sql.json(toJsonValue(cellResult.cost))},
      freshness = ${cellResult.freshness === undefined ? null : sql.json(toJsonValue(cellResult.freshness))},
      provenance = ${cellResult.provenance === undefined ? null : sql.json(toJsonValue(cellResult.provenance))},
      reason = ${cellResult.reason === undefined ? null : sql.json(toJsonValue(cellResult.reason))},
      freshness_expires_at = ${cellResult.freshness?.expiresAt === undefined ? null : new Date(cellResult.freshness.expiresAt)},
      result_manifest_id = ${finalization.manifest?.resultManifestId ?? null},
      manifest_hash = ${finalization.manifest?.manifestHash ?? null},
      artifact_id = ${finalization.artifact?.artifactId ?? null},
      artifact_content_hash = ${finalization.artifact?.contentHash ?? null},
      source_run_aggregate_version = ${finalization.sourceRunAggregateVersion ?? null},
      cell_result = ${sql.json(toJsonValue(cellResult))},
      updated_at = clock_timestamp()
    WHERE workspace_id = ${scope.workspaceId}
      AND cell_result_id = ${cellResult.cellResultId}
      AND status = ${stored.cellResult.status}
    RETURNING 1 AS changed
  `;
  if (rows.length !== 1) {
    throw new PostgresAdapterError(
      "cell-result-transition-conflict",
      "The cell result could not converge to its terminal state."
    );
  }
  await settleCacheForTerminalCell(sql, scope, row, cellResult);
};

type PostgresRecipeInternalUnitOfWork = RecipePersistenceUnitOfWork &
  RecipeRunExecutionUnitOfWork &
  RecipeDagConvergenceUnitOfWork &
  Readonly<{ runCreation: RecipeRunCreationRepository }>;

export const createPostgresRecipeUnitOfWork = (
  sql: postgres.Sql,
  transactionScope: WorkspaceScope
): PostgresRecipeInternalUnitOfWork => {
  const recipes: EnrichmentRecipeRepository = {
    get: async (scope, requestedDatasetId, recipeId, revision) => {
      assertScope(transactionScope, scope);
      await lockImmutableRecipeIdentity(sql, [
        "enrichment-recipe",
        scope.workspaceId,
        requestedDatasetId,
        recipeId,
        revision,
      ]);
      return loadRecipe(sql, scope, requestedDatasetId, recipeId, revision);
    },
    register: (scope, recipe) => {
      assertScope(transactionScope, scope);
      return registerRecipe(sql, scope, recipe);
    },
  };
  const applications: RecipeApplicationRepository = {
    get: async (scope, applicationId) => {
      assertScope(transactionScope, scope);
      await lockImmutableRecipeIdentity(sql, [
        "recipe-application",
        scope.workspaceId,
        applicationId,
      ]);
      return loadApplication(sql, scope, applicationId);
    },
    register: (scope, application) => {
      assertScope(transactionScope, scope);
      return registerApplication(sql, scope, application);
    },
  };
  const applicationCells: RecipeApplicationCellRepository = {
    get: async (scope, applicationId, recordIdValue) => {
      assertScope(transactionScope, scope);
      for await (const projection of streamProjection(
        sql,
        scope,
        applicationId,
        recordIdValue
      )) {
        return projection;
      }
    },
  };
  const inputs: RecipeCellInputRepository = {
    resolveExact: (scope, applicationId, recordIdValue) => {
      assertScope(transactionScope, scope);
      return resolveExactInput(sql, scope, applicationId, recordIdValue);
    },
  };
  const cache: RecipeCellCacheRepository = {
    getForUpdate: (scope, cacheKey) => {
      assertScope(transactionScope, scope);
      return loadCache(sql, scope, cacheKey, true);
    },
  };
  const cachedBindings: RecipeCachedBindingRepository = {
    pinActive: (scope, input, requestedCellResultId) => {
      assertScope(transactionScope, scope);
      return pinActive(sql, scope, input, requestedCellResultId);
    },
    pinCached: (scope, input, requestedCellResultId) => {
      assertScope(transactionScope, scope);
      return pinCached(sql, scope, input, requestedCellResultId);
    },
  };
  const runCreation: RecipeRunCreationRepository = {
    bindPending: (scope, binding) => {
      assertScope(transactionScope, scope);
      return bindPending(sql, scope, binding);
    },
  };
  const runExecution: RecipeRunExecutionRepository = {
    markRunning: (scope, requestedRunId, cellResult) => {
      assertScope(transactionScope, scope);
      return markRunning(sql, scope, requestedRunId, cellResult);
    },
  };
  const dagConvergence: RecipeDagConvergenceRepository = {
    finalize: (scope, finalization) => {
      assertScope(transactionScope, scope);
      return finalizeCell(sql, scope, finalization);
    },
  };
  const cellResults: RecipeCellResultQueryRepository = {
    getByRun: async (scope, requestedRunId) => {
      assertScope(transactionScope, scope);
      return (await loadCellByRun(sql, scope, requestedRunId))?.cellResult;
    },
  };
  return {
    applicationCells,
    applications,
    cache,
    cachedBindings,
    cellResults,
    dagConvergence,
    inputs,
    recipes,
    runCreation,
    runExecution,
  };
};

const streamProjection = async function* (
  sql: postgres.Sql,
  scope: WorkspaceScope,
  applicationId: RecipeApplicationId,
  requestedRecordId?: string
): AsyncIterable<ExactRecipeProjectionRow> {
  const application = await loadApplication(sql, scope, applicationId);
  if (application === undefined) {
    return;
  }
  const context = await loadDatasetContext(sql, scope, application.datasetId);
  const recipe = await loadRecipe(
    sql,
    scope,
    application.datasetId,
    application.recipeId,
    application.recipeRevision
  );
  if (context === undefined || recipe === undefined) {
    throw new PostgresAdapterError(
      "database-identity-mismatch",
      "The projection application references missing recipe evidence."
    );
  }
  const query = sql<readonly ProjectionRow[]>`
    SELECT
      cell.workspace_id,
      cell.cell_result_id,
      cell.recipe_application_id,
      cell.dataset_id,
      cell.record_id,
      cell.record_content_hash,
      cell.field_id,
      cell.enrichment_recipe_id,
      cell.recipe_revision,
      cell.workflow_spec_id,
      cell.workflow_revision,
      cell.workflow_content_hash,
      cell.cache_key,
      cell.input_id,
      cell.input_hash,
      cell.run_plan_id,
      cell.run_id,
      cell.status,
      cell.result_manifest_id,
      cell.manifest_hash,
      cell.artifact_id,
      cell.artifact_content_hash,
      cell.source_run_aggregate_version,
      cell.cell_result,
      application.workspace_id AS projection_workspace_id,
      application.recipe_application_id AS projection_application_id,
      application.dataset_id AS projection_dataset_id,
      application.enrichment_recipe_id AS projection_recipe_id,
      application.recipe_revision AS projection_recipe_revision,
      application.target_field_id AS projection_target_field_id,
      application.graph_hash,
      application.intent_hash,
      application.application,
      application_cell.binding,
      application_cell.ordinal,
      record.record
    FROM kurobara_core.recipe_application_cells AS application_cell
    JOIN kurobara_core.recipe_applications AS application
      ON application.workspace_id = application_cell.workspace_id
      AND application.recipe_application_id = application_cell.recipe_application_id
    JOIN kurobara_core.cell_results AS cell
      ON cell.workspace_id = application_cell.workspace_id
      AND cell.cell_result_id = application_cell.cell_result_id
    JOIN kurobara_core.dataset_records AS record
      ON record.workspace_id = application_cell.workspace_id
      AND record.dataset_id = application_cell.dataset_id
      AND record.record_id = application_cell.record_id
      AND record.content_hash = application_cell.record_content_hash
    WHERE application_cell.workspace_id = ${scope.workspaceId}
      AND application_cell.recipe_application_id = ${applicationId}
      AND (
        ${requestedRecordId ?? null}::text IS NULL
        OR application_cell.record_id = ${requestedRecordId ?? null}
      )
    ORDER BY application_cell.ordinal
  `;
  for await (const rows of query.cursor(1)) {
    const row = rows[0];
    if (row === undefined) {
      continue;
    }
    if (row.binding !== "cached" && row.binding !== "executed") {
      throw new PostgresAdapterError(
        "database-payload-invalid",
        "The application cell binding is invalid."
      );
    }
    const storedApplication = parseApplicationRow({
      application: row.application,
      dataset_id: row.projection_dataset_id,
      enrichment_recipe_id: row.projection_recipe_id,
      graph_hash: row.graph_hash,
      intent_hash: row.intent_hash,
      recipe_application_id: row.projection_application_id,
      recipe_revision: row.projection_recipe_revision,
      target_field_id: row.projection_target_field_id,
      workspace_id: row.projection_workspace_id,
    });
    if (
      !jsonMatches(application, storedApplication) ||
      row.workspace_id !== scope.workspaceId ||
      row.dataset_id !== application.datasetId ||
      row.enrichment_recipe_id !== application.recipeId ||
      row.recipe_revision !== application.recipeRevision ||
      row.field_id !== application.targetFieldId ||
      row.workflow_spec_id !== recipe.workflowSpecId ||
      row.workflow_revision !== recipe.workflowRevision ||
      row.workflow_content_hash !== recipe.workflowContentHash
    ) {
      throw new PostgresAdapterError(
        "database-identity-mismatch",
        "A projection row does not match its exact application evidence."
      );
    }
    const record = parseRecordPayload(
      row.record,
      context.dataset,
      context.fields,
      row.record_id
    );
    yield {
      application,
      binding: row.binding,
      cellResult: parseCellResultPayload(
        row.cell_result,
        context.dataset,
        context.fields,
        record,
        recipe,
        {
          cellResultId: row.cell_result_id,
          datasetId: row.dataset_id,
          enrichmentRecipeId: row.enrichment_recipe_id,
          fieldId: row.field_id,
          recipeRevision: row.recipe_revision,
          recordId: row.record_id,
          runId: row.run_id,
          status: row.status,
          workspaceId: row.workspace_id,
        }
      ),
      record,
      recordContentHash: contentHash(row.record_content_hash),
    };
  }
};

const publicRecipeUnitOfWork = (
  composed: PostgresRecipeInternalUnitOfWork
): RecipePersistenceUnitOfWork => ({
  applicationCells: composed.applicationCells,
  applications: composed.applications,
  cache: composed.cache,
  cachedBindings: composed.cachedBindings,
  cellResults: composed.cellResults,
  inputs: composed.inputs,
  recipes: composed.recipes,
});

export const createPostgresRecipePersistence = (
  sql: postgres.Sql
): RecipePersistencePort => ({
  streamExactProjection: (scope, applicationId) =>
    streamProjection(sql, scope, applicationId),
  transaction: async <Value>(
    scope: WorkspaceScope,
    work: (unitOfWork: RecipePersistenceUnitOfWork) => Promise<Value>
  ) => {
    const result = await sql.begin((transaction) => {
      const composed = createPostgresRecipeUnitOfWork(
        transaction as unknown as postgres.Sql,
        scope
      );
      return work(publicRecipeUnitOfWork(composed));
    });
    return result as unknown as Value;
  },
});

const parseWatchCount = (value: number, subject: string): number => {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new PostgresAdapterError(
      "recipe-application-watch-invalid",
      `The ${subject} count is not a non-negative safe integer.`
    );
  }
  return value;
};

const parseApplicationWatchRow = (row: ApplicationWatchRow) => {
  const application = parseApplicationRow(row);
  const counts = {
    bound: parseWatchCount(row.bound, "bound"),
    failed: parseWatchCount(row.failed, "failed"),
    pending: parseWatchCount(row.pending, "pending"),
    running: parseWatchCount(row.running, "running"),
    skipped: parseWatchCount(row.skipped, "skipped"),
    succeeded: parseWatchCount(row.succeeded, "succeeded"),
    total: parseWatchCount(row.record_count, "total"),
    unbound: parseWatchCount(row.record_count - row.bound, "unbound"),
  };
  if (
    application.graph.recordIds.length !== counts.total ||
    counts.bound + counts.unbound !== counts.total ||
    counts.pending +
      counts.running +
      counts.succeeded +
      counts.failed +
      counts.skipped !==
      counts.bound
  ) {
    throw new PostgresAdapterError(
      "recipe-application-watch-invalid",
      "The recipe application watch counters do not match its durable graph and bindings."
    );
  }
  return { application, counts };
};

export const createPostgresRecipeApplicationWatchQueries = (
  sql: postgres.Sql
): RecipeApplicationWatchQueryPort => ({
  get: async (scope, applicationId) => {
    const rows = await sql<readonly ApplicationWatchRow[]>`
      SELECT
        application.workspace_id,
        application.recipe_application_id,
        application.dataset_id,
        application.enrichment_recipe_id,
        application.recipe_revision,
        application.target_field_id,
        application.graph_hash,
        application.intent_hash,
        application.record_count,
        application.application,
        watch.bound,
        watch.pending,
        watch.running,
        watch.succeeded,
        watch.failed,
        watch.skipped
      FROM kurobara_core.recipe_applications AS application
      CROSS JOIN LATERAL (
        SELECT
          count(*)::integer AS bound,
          count(*) FILTER (WHERE cell.status = 'pending')::integer AS pending,
          count(*) FILTER (WHERE cell.status = 'running')::integer AS running,
          count(*) FILTER (WHERE cell.status = 'succeeded')::integer AS succeeded,
          count(*) FILTER (WHERE cell.status = 'failed')::integer AS failed,
          count(*) FILTER (WHERE cell.status = 'skipped')::integer AS skipped
        FROM kurobara_core.recipe_application_cells AS application_cell
        JOIN kurobara_core.cell_results AS cell
          ON cell.workspace_id = application_cell.workspace_id
          AND cell.cell_result_id = application_cell.cell_result_id
        WHERE application_cell.workspace_id = application.workspace_id
          AND application_cell.recipe_application_id =
            application.recipe_application_id
      ) AS watch
      WHERE application.workspace_id = ${scope.workspaceId}
        AND application.recipe_application_id = ${applicationId}
      LIMIT 1
    `;
    return rows[0] === undefined
      ? undefined
      : parseApplicationWatchRow(rows[0]);
  },
});

export type PostgresRunCreationUnitOfWorkFactory = (
  sql: postgres.Sql,
  scope: WorkspaceScope
) => RunCreationUnitOfWork;

export type PostgresPlanningUnitOfWorkFactory = (
  sql: postgres.Sql,
  scope: WorkspaceScope
) => PlanningUnitOfWork;

/**
 * Composes canonical run creation and recipe-cell binding over one SQL
 * transaction. Runtime code supplies its existing run repository factory;
 * this adapter adds only the recipe repositories owned by this slice.
 */
export const createPostgresRecipeCellRunCreationPersistence = (
  sql: postgres.Sql,
  createRunUnitOfWork: PostgresRunCreationUnitOfWorkFactory
): RecipeCellRunCreationPersistencePort => ({
  transaction: async <Value>(
    scope: WorkspaceScope,
    work: (unitOfWork: RecipeCellRunCreationUnitOfWork) => Promise<Value>
  ) => {
    const result = await sql.begin((transaction) => {
      const transactionSql = transaction as unknown as postgres.Sql;
      const recipe = createPostgresRecipeUnitOfWork(transactionSql, scope);
      return work({
        ...createRunUnitOfWork(transactionSql, scope),
        ...publicRecipeUnitOfWork(recipe),
        runCreation: recipe.runCreation,
      });
    });
    return result as unknown as Value;
  },
});

/** Composes quote, canonical Run creation, and recipe binding over one SQL transaction. */
export const createPostgresRecipeApplyPersistence = (
  sql: postgres.Sql,
  createRunUnitOfWork: PostgresRunCreationUnitOfWorkFactory,
  createPlanningUnitOfWork: PostgresPlanningUnitOfWorkFactory
): RecipeApplyPersistencePort => ({
  transaction: async <Value>(
    scope: WorkspaceScope,
    work: (unitOfWork: RecipeApplyUnitOfWork) => Promise<Value>
  ): Promise<Value> => {
    const result = await sql.begin((transaction) => {
      const transactionSql = transaction as unknown as postgres.Sql;
      const recipe = createPostgresRecipeUnitOfWork(transactionSql, scope);
      return work({
        ...createRunUnitOfWork(transactionSql, scope),
        ...publicRecipeUnitOfWork(recipe),
        planning: createPlanningUnitOfWork(transactionSql, scope),
        runCreation: recipe.runCreation,
      });
    });
    return result as unknown as Value;
  },
});
