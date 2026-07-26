import type {
  DatasetGenerationCreation,
  DatasetGenerationId,
  DatasetGenerationPlanId,
} from "@kurobara/kernel";
import type {
  DatasetGenerationPersistencePort,
  DatasetGenerationUnitOfWork,
  StoredDatasetGeneration,
  StoredDatasetGenerationPlan,
  WorkspaceScope,
} from "@kurobara/ports";
import type postgres from "postgres";

import {
  type DatasetGenerationRowIdentity,
  type DatasetMaterializationRowIdentity,
  parseDatasetGenerationCreation,
} from "./dataset-generation-payload.ts";
import { parseDatasetGenerationPlanRecord } from "./dataset-generation-plan-payload.ts";
import { createPostgresDatasetGenerationPlanningUnitOfWork } from "./dataset-generation-planning.ts";
import {
  ImmutableRecordConflictError,
  PostgresAdapterError,
} from "./errors.ts";
import { toJsonValue } from "./json.ts";

type GenerationRow = Readonly<{
  accepted_count: string;
  aggregate_version: string;
  call_count: string;
  capability_id: string;
  capability_version: string;
  cost_reserved: string;
  cost_spent: string;
  cost_unit: string;
  created_at: Date;
  dataset_id: string;
  duplicate_count: string;
  generation_id: string;
  generation_payload: unknown;
  generation_plan_id: string;
  last_committed_page_sequence: string | null;
  locked_provider: string | null;
  materialization_completed_at: Date | null;
  materialization_completion_reason: string | null;
  materialization_content_hash: string | null;
  materialization_coverage_basis: string | null;
  materialization_coverage_status: string | null;
  materialization_created_at: Date;
  materialization_id: string;
  materialization_origin_id: string;
  materialization_origin_kind: string;
  materialization_payload: unknown;
  materialization_record_count: string;
  materialization_rejected_count: string;
  materialization_revision: string;
  materialization_schema_hash: string;
  materialization_state: string;
  page_count: string;
  plan_hash: string;
  plan_payload: unknown;
  query_hash: string;
  rejected_count: string;
  request_intent_hash: string;
  returned_count: string;
  schema_hash: string;
  state: string;
  stop_reason: string | null;
  stop_requested_at: Date | null;
  workspace_id: string;
}>;

const assertScope = (
  transactionScope: WorkspaceScope,
  operationScope: WorkspaceScope
): void => {
  if (transactionScope.workspaceId !== operationScope.workspaceId) {
    throw new PostgresAdapterError(
      "workspace-scope-mismatch",
      "A dataset generation transaction cannot cross workspaces."
    );
  }
};

const generationIdentity = (
  row: GenerationRow
): DatasetGenerationRowIdentity => ({
  acceptedCount: row.accepted_count,
  aggregateVersion: row.aggregate_version,
  callCount: row.call_count,
  capabilityId: row.capability_id,
  capabilityVersion: row.capability_version,
  costReserved: row.cost_reserved,
  costSpent: row.cost_spent,
  costUnit: row.cost_unit,
  createdAt: row.created_at,
  datasetId: row.dataset_id,
  duplicateCount: row.duplicate_count,
  generationId: row.generation_id,
  generationPlanId: row.generation_plan_id,
  lastPageSequence: row.last_committed_page_sequence,
  lockedProvider: row.locked_provider,
  materializationId: row.materialization_id,
  pageCount: row.page_count,
  planHash: row.plan_hash,
  queryHash: row.query_hash,
  rejectedCount: row.rejected_count,
  requestIntentHash: row.request_intent_hash,
  returnedCount: row.returned_count,
  schemaHash: row.schema_hash,
  state: row.state,
  stopReason: row.stop_reason,
  stopRequestedAt: row.stop_requested_at,
  workspaceId: row.workspace_id,
});

const materializationIdentity = (
  row: GenerationRow
): DatasetMaterializationRowIdentity => ({
  completedAt: row.materialization_completed_at,
  completionReason: row.materialization_completion_reason,
  contentHash: row.materialization_content_hash,
  coverageBasis: row.materialization_coverage_basis,
  coverageStatus: row.materialization_coverage_status,
  createdAt: row.materialization_created_at,
  datasetId: row.dataset_id,
  materializationId: row.materialization_id,
  originId: row.materialization_origin_id,
  originKind: row.materialization_origin_kind,
  recordCount: row.materialization_record_count,
  rejectedCount: row.materialization_rejected_count,
  revision: row.materialization_revision,
  schemaHash: row.materialization_schema_hash,
  state: row.materialization_state,
  workspaceId: row.workspace_id,
});

const generationSelect = (sql: postgres.Sql) => sql`
  generation.workspace_id,
  generation.generation_id,
  generation.generation_plan_id,
  generation.last_committed_page_sequence::text AS last_committed_page_sequence,
  generation.locked_provider,
  generation.dataset_id,
  generation.materialization_id,
  generation.plan_hash,
  generation.query_hash,
  generation.schema_hash,
  generation.request_intent_hash,
  generation.capability_id,
  generation.capability_version,
  generation.state,
  generation.stop_reason,
  generation.stop_requested_at,
  generation.aggregate_version::text AS aggregate_version,
  generation.accepted_count::text AS accepted_count,
  generation.call_count::text AS call_count,
  generation.duplicate_count::text AS duplicate_count,
  generation.page_count::text AS page_count,
  generation.rejected_count::text AS rejected_count,
  generation.returned_count::text AS returned_count,
  generation.cost_reserved::text AS cost_reserved,
  generation.cost_spent::text AS cost_spent,
  generation.cost_unit,
  generation.payload AS generation_payload,
  generation.created_at,
  materialization.schema_hash AS materialization_schema_hash,
  materialization.origin_kind AS materialization_origin_kind,
  materialization.origin_id AS materialization_origin_id,
  materialization.state AS materialization_state,
  materialization.revision::text AS materialization_revision,
  materialization.record_count::text AS materialization_record_count,
  materialization.rejected_count::text AS materialization_rejected_count,
  materialization.completed_at AS materialization_completed_at,
  materialization.completion_reason AS materialization_completion_reason,
  materialization.content_hash AS materialization_content_hash,
  materialization.coverage_basis AS materialization_coverage_basis,
  materialization.coverage_status AS materialization_coverage_status,
  materialization.payload AS materialization_payload,
  materialization.created_at AS materialization_created_at,
  generation_plan.payload AS plan_payload
`;

const parseRow = (row: GenerationRow): StoredDatasetGeneration => {
  const storedPlan = parseDatasetGenerationPlanRecord(row.plan_payload);
  return parseDatasetGenerationCreation(
    row.generation_payload,
    row.materialization_payload,
    storedPlan.plan,
    generationIdentity(row),
    materializationIdentity(row)
  );
};

const loadByGenerationId = async (
  sql: postgres.Sql,
  scope: WorkspaceScope,
  requestedGenerationId: DatasetGenerationId,
  lockForUpdate = false
): Promise<StoredDatasetGeneration | undefined> => {
  const rows = await sql<readonly GenerationRow[]>`
    SELECT ${generationSelect(sql)}
    FROM kurobara_core.dataset_generations AS generation
    JOIN kurobara_core.dataset_materializations AS materialization
      ON materialization.workspace_id = generation.workspace_id
      AND materialization.materialization_id = generation.materialization_id
      AND materialization.dataset_id = generation.dataset_id
      AND materialization.origin_kind = 'generation'
      AND materialization.origin_id = generation.generation_id
    JOIN kurobara_core.dataset_generation_plans AS generation_plan
      ON generation_plan.workspace_id = generation.workspace_id
      AND generation_plan.generation_plan_id = generation.generation_plan_id
      AND generation_plan.target_dataset_id = generation.dataset_id
      AND generation_plan.plan_hash = generation.plan_hash
      AND generation_plan.query_hash = generation.query_hash
      AND generation_plan.schema_hash = generation.schema_hash
      AND generation_plan.request_intent_hash = generation.request_intent_hash
    WHERE generation.workspace_id = ${scope.workspaceId}
      AND generation.generation_id = ${requestedGenerationId}
    ${lockForUpdate ? sql`FOR UPDATE OF generation, materialization` : sql``}
  `;
  return rows[0] === undefined ? undefined : parseRow(rows[0]);
};

export const loadPostgresDatasetGenerationForUpdate = (
  sql: postgres.Sql,
  scope: WorkspaceScope,
  requestedGenerationId: DatasetGenerationId
): Promise<StoredDatasetGeneration | undefined> =>
  loadByGenerationId(sql, scope, requestedGenerationId, true);

export const updatePostgresDatasetGenerationSnapshot = async (
  sql: postgres.Sql,
  scope: WorkspaceScope,
  input: Readonly<{
    expectedGenerationVersion: number;
    expectedMaterializationRevision: number;
    value: DatasetGenerationCreation;
  }>
): Promise<void> => {
  const { generation, materialization } = input.value;
  if (
    generation.workspaceId !== scope.workspaceId ||
    materialization.workspaceId !== scope.workspaceId
  ) {
    throw new PostgresAdapterError(
      "workspace-scope-mismatch",
      "The updated dataset generation belongs to another workspace."
    );
  }
  const generationRows = await sql<readonly { generation_id: string }[]>`
    UPDATE kurobara_core.dataset_generations
    SET
      state = ${generation.state},
      aggregate_version = ${generation.aggregateVersion},
      accepted_count = ${generation.counters.accepted},
      call_count = ${generation.counters.calls},
      duplicate_count = ${generation.counters.duplicates},
      page_count = ${generation.counters.pages},
      rejected_count = ${generation.counters.rejected},
      returned_count = ${generation.counters.returned},
      cost_reserved = ${generation.cost.reserved},
      cost_spent = ${generation.cost.spent},
      locked_provider = ${generation.lockedProvider ?? null},
      last_committed_page_sequence = ${generation.lastPageSequence ?? null},
      stop_reason = ${generation.stop?.reason ?? null},
      stop_requested_at = ${generation.stop === undefined ? null : new Date(generation.stop.requestedAt)},
      payload = ${sql.json(toJsonValue(generation))}
    WHERE workspace_id = ${scope.workspaceId}
      AND generation_id = ${generation.generationId}
      AND aggregate_version = ${input.expectedGenerationVersion}
    RETURNING generation_id
  `;
  if (generationRows.length !== 1) {
    throw new PostgresAdapterError(
      "dataset-generation-conflict",
      "The dataset generation no longer has the expected aggregate version."
    );
  }
  if (materialization.revision === input.expectedMaterializationRevision) {
    return;
  }
  const materializationRows = await sql<
    readonly { materialization_id: string }[]
  >`
    UPDATE kurobara_core.dataset_materializations
    SET
      state = ${materialization.state},
      revision = ${materialization.revision},
      record_count = ${materialization.recordCount},
      rejected_count = ${materialization.rejectedCount},
      completed_at = ${materialization.completedAt === undefined ? null : new Date(materialization.completedAt)},
      completion_reason = ${materialization.completionReason ?? null},
      content_hash = ${materialization.contentHash ?? null},
      coverage_basis = ${materialization.coverage?.basis ?? null},
      coverage_status = ${materialization.coverage?.status ?? null},
      payload = ${sql.json(toJsonValue(materialization))}
    WHERE workspace_id = ${scope.workspaceId}
      AND materialization_id = ${materialization.materializationId}
      AND revision = ${input.expectedMaterializationRevision}
    RETURNING materialization_id
  `;
  if (materializationRows.length !== 1) {
    throw new PostgresAdapterError(
      "dataset-materialization-conflict",
      "The dataset materialization no longer has the expected revision."
    );
  }
};

const loadByPlanId = async (
  sql: postgres.Sql,
  scope: WorkspaceScope,
  requestedGenerationPlanId: DatasetGenerationPlanId
): Promise<StoredDatasetGeneration | undefined> => {
  const rows = await sql<readonly GenerationRow[]>`
    SELECT ${generationSelect(sql)}
    FROM kurobara_core.dataset_generations AS generation
    JOIN kurobara_core.dataset_materializations AS materialization
      ON materialization.workspace_id = generation.workspace_id
      AND materialization.materialization_id = generation.materialization_id
      AND materialization.dataset_id = generation.dataset_id
      AND materialization.origin_kind = 'generation'
      AND materialization.origin_id = generation.generation_id
    JOIN kurobara_core.dataset_generation_plans AS generation_plan
      ON generation_plan.workspace_id = generation.workspace_id
      AND generation_plan.generation_plan_id = generation.generation_plan_id
      AND generation_plan.target_dataset_id = generation.dataset_id
      AND generation_plan.plan_hash = generation.plan_hash
      AND generation_plan.query_hash = generation.query_hash
      AND generation_plan.schema_hash = generation.schema_hash
      AND generation_plan.request_intent_hash = generation.request_intent_hash
    WHERE generation.workspace_id = ${scope.workspaceId}
      AND generation.generation_plan_id = ${requestedGenerationPlanId}
  `;
  return rows[0] === undefined ? undefined : parseRow(rows[0]);
};

const insertGeneration = async (
  sql: postgres.Sql,
  scope: WorkspaceScope,
  record: StoredDatasetGeneration,
  storedPlan: StoredDatasetGenerationPlan
): Promise<void> => {
  const validatedPlan = parseDatasetGenerationPlanRecord(storedPlan);
  const validated = parseDatasetGenerationCreation(
    record.generation,
    record.materialization,
    validatedPlan.plan
  );
  if (validated.generation.workspaceId !== scope.workspaceId) {
    throw new PostgresAdapterError(
      "workspace-scope-mismatch",
      "The dataset generation belongs to another workspace."
    );
  }
  const { generation, materialization } = validated;
  const { fields, targetDataset } = validatedPlan.plan.requestIntent;
  const insertedDataset = await sql<readonly { dataset_id: string }[]>`
    INSERT INTO kurobara_core.datasets (
      workspace_id,
      dataset_id,
      name,
      schema_hash,
      dataset,
      created_at
    ) VALUES (
      ${scope.workspaceId},
      ${targetDataset.datasetId},
      ${targetDataset.name},
      ${generation.schemaHash},
      ${sql.json(toJsonValue(targetDataset))},
      ${new Date(generation.createdAt)}
    )
    ON CONFLICT DO NOTHING
    RETURNING dataset_id
  `;
  if (insertedDataset[0] === undefined) {
    throw new ImmutableRecordConflictError("dataset generation target");
  }
  for (let ordinal = 0; ordinal < fields.length; ordinal += 1) {
    const field = fields[ordinal];
    if (field === undefined) {
      throw new PostgresAdapterError(
        "dataset-field-missing",
        "The validated generation field collection contains a gap."
      );
    }
    await sql`
      INSERT INTO kurobara_core.dataset_fields (
        workspace_id,
        dataset_id,
        field_id,
        ordinal,
        field_key,
        label,
        value_type,
        field,
        created_at
      ) VALUES (
        ${scope.workspaceId},
        ${targetDataset.datasetId},
        ${field.fieldId},
        ${ordinal},
        ${field.key},
        ${field.label},
        ${field.valueType},
        ${sql.json(toJsonValue(field))},
        ${new Date(generation.createdAt)}
      )
    `;
  }
  await sql`
    INSERT INTO kurobara_core.dataset_generations (
      workspace_id,
      generation_id,
      generation_plan_id,
      dataset_id,
      materialization_id,
      plan_hash,
      query_hash,
      schema_hash,
      request_intent_hash,
      capability_id,
      capability_version,
      state,
      aggregate_version,
      accepted_count,
      call_count,
      duplicate_count,
      page_count,
      rejected_count,
      returned_count,
      cost_reserved,
      cost_spent,
      cost_unit,
      payload,
      created_at
    ) VALUES (
      ${generation.workspaceId},
      ${generation.generationId},
      ${generation.generationPlanId},
      ${generation.datasetId},
      ${generation.materializationId},
      ${generation.planHash},
      ${generation.queryHash},
      ${generation.schemaHash},
      ${generation.requestIntentHash},
      ${generation.capability.capabilityId},
      ${generation.capability.capabilityVersion},
      ${generation.state},
      ${generation.aggregateVersion},
      ${generation.counters.accepted},
      ${generation.counters.calls},
      ${generation.counters.duplicates},
      ${generation.counters.pages},
      ${generation.counters.rejected},
      ${generation.counters.returned},
      ${generation.cost.reserved},
      ${generation.cost.spent},
      ${generation.cost.unit},
      ${sql.json(toJsonValue(generation))},
      ${new Date(generation.createdAt)}
    )
  `;
  await sql`
    INSERT INTO kurobara_core.dataset_materializations (
      workspace_id,
      materialization_id,
      dataset_id,
      schema_hash,
      origin_kind,
      origin_id,
      state,
      revision,
      record_count,
      rejected_count,
      completed_at,
      completion_reason,
      content_hash,
      coverage_basis,
      coverage_status,
      payload,
      created_at
    ) VALUES (
      ${materialization.workspaceId},
      ${materialization.materializationId},
      ${materialization.datasetId},
      ${materialization.schemaHash},
      ${materialization.origin.kind},
      ${materialization.origin.kind === "generation" ? materialization.origin.generationId : materialization.origin.importId},
      ${materialization.state},
      ${materialization.revision},
      ${materialization.recordCount},
      ${materialization.rejectedCount},
      ${materialization.completedAt === undefined ? null : new Date(materialization.completedAt)},
      ${materialization.completionReason ?? null},
      ${materialization.contentHash ?? null},
      ${materialization.coverage?.basis ?? null},
      ${materialization.coverage?.status ?? null},
      ${sql.json(toJsonValue(materialization))},
      ${new Date(materialization.createdAt)}
    )
  `;
};

export const createPostgresDatasetGenerationUnitOfWork = (
  sql: postgres.Sql,
  transactionScope: WorkspaceScope
): DatasetGenerationUnitOfWork => ({
  generationPlans: createPostgresDatasetGenerationPlanningUnitOfWork(
    sql,
    transactionScope
  ).generationPlans,
  generations: {
    findByPlan: (scope, requestedGenerationPlanId) => {
      assertScope(transactionScope, scope);
      return loadByPlanId(sql, scope, requestedGenerationPlanId);
    },
    get: (scope, requestedGenerationId) => {
      assertScope(transactionScope, scope);
      return loadByGenerationId(sql, scope, requestedGenerationId);
    },
    insert: async (scope, record, plan) => {
      assertScope(transactionScope, scope);
      await insertGeneration(sql, scope, record, plan);
    },
    lockPlan: async (scope, requestedGenerationPlanId) => {
      assertScope(transactionScope, scope);
      await sql`
        SELECT pg_advisory_xact_lock(
          hashtextextended(
            ${JSON.stringify([
              "dataset-generation-plan",
              scope.workspaceId,
              requestedGenerationPlanId,
            ])},
            0::bigint
          )
        )
      `;
    },
    lockTargetDataset: async (scope, requestedDatasetId) => {
      assertScope(transactionScope, scope);
      await sql`
        SELECT pg_advisory_xact_lock(
          hashtextextended(
            ${JSON.stringify([
              "dataset",
              scope.workspaceId,
              requestedDatasetId,
            ])},
            0::bigint
          )
        )
      `;
    },
    targetDatasetExists: async (scope, requestedDatasetId) => {
      assertScope(transactionScope, scope);
      const rows = await sql<readonly { exists: boolean }[]>`
        SELECT EXISTS (
          SELECT 1
          FROM kurobara_core.datasets
          WHERE workspace_id = ${scope.workspaceId}
            AND dataset_id = ${requestedDatasetId}
        ) AS exists
      `;
      return rows[0]?.exists ?? false;
    },
  },
});

export const createPostgresDatasetGenerationPersistence = (
  sql: postgres.Sql
): DatasetGenerationPersistencePort => ({
  get: (scope, requestedGenerationId) =>
    loadByGenerationId(sql, scope, requestedGenerationId),
  transaction: async <Value>(
    scope: WorkspaceScope,
    work: (unitOfWork: DatasetGenerationUnitOfWork) => Promise<Value>
  ): Promise<Value> => {
    const result = await sql.begin((transaction) =>
      work(
        createPostgresDatasetGenerationUnitOfWork(
          transaction as unknown as postgres.Sql,
          scope
        )
      )
    );
    return result as unknown as Value;
  },
});
