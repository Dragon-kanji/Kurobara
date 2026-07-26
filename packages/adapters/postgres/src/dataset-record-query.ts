import type {
  DatasetPersistencePort,
  DatasetRecordPage,
  DatasetRecordPageQuery,
  DatasetRecordPageQueryPort,
  WorkspaceScope,
} from "@kurobara/ports";
import type postgres from "postgres";

import { parseRecordPayload } from "./dataset-payload.ts";
import { DatabasePayloadError, PostgresAdapterError } from "./errors.ts";

type DatasetRecordPageRow = Readonly<{
  record: unknown;
  record_id: string;
  record_ordinal: string;
}>;

const parseRecordOrdinal = (value: string): number => {
  const ordinal = Number(value);
  if (!(Number.isSafeInteger(ordinal) && ordinal > 0)) {
    throw new DatabasePayloadError(
      "The stored dataset record ordinal must be a positive safe integer."
    );
  }
  return ordinal;
};

const assertPageQuery = (query: DatasetRecordPageQuery): void => {
  if (
    !(
      Number.isSafeInteger(query.afterOrdinal) &&
      query.afterOrdinal >= 0 &&
      Number.isSafeInteger(query.limit) &&
      query.limit > 0
    )
  ) {
    throw new PostgresAdapterError(
      "dataset-record-page-query-invalid",
      "Dataset record pagination requires a non-negative cursor and a positive safe limit."
    );
  }
};

const listReadyMaterializationPage = async (
  sql: postgres.Sql,
  scope: WorkspaceScope,
  query: DatasetRecordPageQuery,
  datasets: DatasetPersistencePort
): Promise<DatasetRecordPage | undefined> => {
  assertPageQuery(query);
  const stored = await datasets.getDataset(scope, query.datasetId);
  if (
    stored === undefined ||
    stored.materialization.state !== "ready" ||
    stored.materialization.materializationId !== query.materializationId
  ) {
    return;
  }

  const rows = await sql<readonly DatasetRecordPageRow[]>`
    SELECT
      record.record_id,
      record.record_ordinal::text AS record_ordinal,
      record.record
    FROM kurobara_core.dataset_records AS record
    JOIN kurobara_core.dataset_materializations AS materialization
      ON materialization.workspace_id = record.workspace_id
      AND materialization.dataset_id = record.dataset_id
      AND materialization.materialization_id = record.materialization_id
    WHERE record.workspace_id = ${scope.workspaceId}
      AND record.dataset_id = ${query.datasetId}
      AND record.materialization_id = ${query.materializationId}
      AND materialization.state = 'ready'
      AND record.record_ordinal > ${query.afterOrdinal}
    ORDER BY record.record_ordinal ASC
    LIMIT ${query.limit + 1}
  `;
  const hasMore = rows.length > query.limit;
  return {
    dataset: stored.dataset,
    fields: stored.fields,
    hasMore,
    items: rows.slice(0, query.limit).map((row) => ({
      ordinal: parseRecordOrdinal(row.record_ordinal),
      record: parseRecordPayload(
        row.record,
        stored.dataset,
        stored.fields,
        row.record_id
      ),
    })),
    materialization: stored.materialization,
  };
};

export const createPostgresDatasetRecordPageQuery = (
  sql: postgres.Sql,
  datasets: DatasetPersistencePort
): DatasetRecordPageQueryPort => ({
  listPage: (scope, query) =>
    listReadyMaterializationPage(sql, scope, query, datasets),
});
