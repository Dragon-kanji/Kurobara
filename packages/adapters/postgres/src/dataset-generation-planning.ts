import type { DatasetGenerationPlanId, IdempotencyKey } from "@kurobara/kernel";
import type {
  DatasetGenerationPlanningPersistencePort,
  DatasetGenerationPlanningUnitOfWork,
  StoredDatasetGenerationPlan,
  WorkspaceScope,
} from "@kurobara/ports";
import type postgres from "postgres";

import {
  parseNormalizedJsonValue,
  serializeCanonicalJson,
} from "./artifact-payload.ts";
import {
  type DatasetGenerationPlanRowIdentity,
  datasetGenerationPlanRecordIdentity,
  parseDatasetGenerationPlanRecord,
} from "./dataset-generation-plan-payload.ts";
import {
  ImmutableRecordConflictError,
  PostgresAdapterError,
} from "./errors.ts";
import { toJsonValue } from "./json.ts";

type DatasetGenerationPlanRow = Readonly<{
  generation_plan_id: string;
  idempotency_key: string;
  payload: unknown;
  plan_hash: string;
  query_hash: string;
  request_intent_hash: string;
  schema_hash: string;
  target_dataset_id: string;
  workspace_id: string;
}>;

const assertScope = (
  transactionScope: WorkspaceScope,
  operationScope: WorkspaceScope
): void => {
  if (transactionScope.workspaceId !== operationScope.workspaceId) {
    throw new PostgresAdapterError(
      "workspace-scope-mismatch",
      "A dataset generation planning transaction cannot cross workspaces."
    );
  }
};

const identityFromRow = (
  row: DatasetGenerationPlanRow
): DatasetGenerationPlanRowIdentity => ({
  generationPlanId: row.generation_plan_id,
  idempotencyKey: row.idempotency_key,
  planHash: row.plan_hash,
  queryHash: row.query_hash,
  requestIntentHash: row.request_intent_hash,
  schemaHash: row.schema_hash,
  targetDatasetId: row.target_dataset_id,
  workspaceId: row.workspace_id,
});

const parseRow = (row: DatasetGenerationPlanRow): StoredDatasetGenerationPlan =>
  parseDatasetGenerationPlanRecord(row.payload, identityFromRow(row));

const planSelect = (sql: postgres.Sql) => sql`
  workspace_id,
  generation_plan_id,
  idempotency_key,
  target_dataset_id,
  query_hash,
  schema_hash,
  request_intent_hash,
  plan_hash,
  payload
`;

const loadById = async (
  sql: postgres.Sql,
  scope: WorkspaceScope,
  requestedGenerationPlanId: DatasetGenerationPlanId
): Promise<StoredDatasetGenerationPlan | undefined> => {
  const rows = await sql<readonly DatasetGenerationPlanRow[]>`
    SELECT ${planSelect(sql)}
    FROM kurobara_core.dataset_generation_plans
    WHERE workspace_id = ${scope.workspaceId}
      AND generation_plan_id = ${requestedGenerationPlanId}
  `;
  return rows[0] === undefined ? undefined : parseRow(rows[0]);
};

const loadByIdempotencyKey = async (
  sql: postgres.Sql,
  scope: WorkspaceScope,
  requestedIdempotencyKey: IdempotencyKey
): Promise<StoredDatasetGenerationPlan | undefined> => {
  const rows = await sql<readonly DatasetGenerationPlanRow[]>`
    SELECT ${planSelect(sql)}
    FROM kurobara_core.dataset_generation_plans
    WHERE workspace_id = ${scope.workspaceId}
      AND idempotency_key = ${requestedIdempotencyKey}
  `;
  return rows[0] === undefined ? undefined : parseRow(rows[0]);
};

const loadIdentityConflicts = async (
  sql: postgres.Sql,
  identity: DatasetGenerationPlanRowIdentity
): Promise<readonly StoredDatasetGenerationPlan[]> => {
  const rows = await sql<readonly DatasetGenerationPlanRow[]>`
    SELECT ${planSelect(sql)}
    FROM kurobara_core.dataset_generation_plans
    WHERE workspace_id = ${identity.workspaceId}
      AND (
        generation_plan_id = ${identity.generationPlanId}
        OR idempotency_key = ${identity.idempotencyKey}
        OR target_dataset_id = ${identity.targetDatasetId}
      )
  `;
  return rows.map(parseRow);
};

const canonicalRecord = (record: StoredDatasetGenerationPlan): string =>
  serializeCanonicalJson(parseNormalizedJsonValue(toJsonValue(record)));

const validateInputRecord = (
  scope: WorkspaceScope,
  record: StoredDatasetGenerationPlan
): StoredDatasetGenerationPlan => {
  const parsed = parseDatasetGenerationPlanRecord(toJsonValue(record));
  if (parsed.plan.workspaceId !== scope.workspaceId) {
    throw new PostgresAdapterError(
      "workspace-scope-mismatch",
      "The dataset generation plan belongs to another workspace."
    );
  }
  return parsed;
};

const insertPlan = async (
  sql: postgres.Sql,
  scope: WorkspaceScope,
  record: StoredDatasetGenerationPlan
): Promise<void> => {
  const parsed = validateInputRecord(scope, record);
  const identity = datasetGenerationPlanRecordIdentity(parsed);
  const inserted = await sql<readonly { generation_plan_id: string }[]>`
    INSERT INTO kurobara_core.dataset_generation_plans (
      workspace_id,
      generation_plan_id,
      idempotency_key,
      target_dataset_id,
      query_hash,
      schema_hash,
      request_intent_hash,
      plan_hash,
      payload
    ) VALUES (
      ${identity.workspaceId},
      ${identity.generationPlanId},
      ${identity.idempotencyKey},
      ${identity.targetDatasetId},
      ${identity.queryHash},
      ${identity.schemaHash},
      ${identity.requestIntentHash},
      ${identity.planHash},
      ${sql.json(toJsonValue(parsed))}
    )
    ON CONFLICT DO NOTHING
    RETURNING generation_plan_id
  `;
  if (inserted[0] !== undefined) {
    return;
  }
  const conflicts = await loadIdentityConflicts(sql, identity);
  const conflict = conflicts[0];
  if (
    conflict === undefined ||
    conflicts.length !== 1 ||
    canonicalRecord(conflict) !== canonicalRecord(parsed)
  ) {
    throw new ImmutableRecordConflictError("dataset generation plan");
  }
};

export const createPostgresDatasetGenerationPlanningUnitOfWork = (
  sql: postgres.Sql,
  transactionScope: WorkspaceScope
): DatasetGenerationPlanningUnitOfWork => ({
  generationPlans: {
    findByIdempotencyKey: (scope, requestedIdempotencyKey) => {
      assertScope(transactionScope, scope);
      return loadByIdempotencyKey(sql, scope, requestedIdempotencyKey);
    },
    get: (scope, requestedGenerationPlanId) => {
      assertScope(transactionScope, scope);
      return loadById(sql, scope, requestedGenerationPlanId);
    },
    insert: async (scope, record) => {
      assertScope(transactionScope, scope);
      await insertPlan(sql, scope, record);
    },
    lockIdempotencyKey: async (scope, requestedIdempotencyKey) => {
      assertScope(transactionScope, scope);
      const lockIdentity = JSON.stringify([
        "dataset-generation-plan",
        scope.workspaceId,
        requestedIdempotencyKey,
      ]);
      await sql`
        SELECT pg_advisory_xact_lock(
          hashtextextended(${lockIdentity}, 0::bigint)
        )
      `;
    },
  },
});

export const createPostgresDatasetGenerationPlanningPersistence = (
  sql: postgres.Sql
): DatasetGenerationPlanningPersistencePort => ({
  findByIdempotencyKey: (scope, requestedIdempotencyKey) =>
    loadByIdempotencyKey(sql, scope, requestedIdempotencyKey),
  get: (scope, requestedGenerationPlanId) =>
    loadById(sql, scope, requestedGenerationPlanId),
  transaction: async <Value>(
    scope: WorkspaceScope,
    work: (unitOfWork: DatasetGenerationPlanningUnitOfWork) => Promise<Value>
  ): Promise<Value> => {
    const result = await sql.begin((transaction) =>
      work(
        createPostgresDatasetGenerationPlanningUnitOfWork(
          transaction as unknown as postgres.Sql,
          scope
        )
      )
    );
    return result as unknown as Value;
  },
});
