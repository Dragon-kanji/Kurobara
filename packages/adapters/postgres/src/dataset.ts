import { createHash } from "node:crypto";

import {
  createDatasetMaterialization,
  type DatasetId,
  type Record as DatasetRecord,
  datasetMaterializationId,
  instant,
} from "@kurobara/kernel";
import type {
  DatasetImportBatch,
  DatasetImportCompletion,
  DatasetImportDefinition,
  DatasetImportIssue,
  DatasetImportMutationResult,
  DatasetImportProgress,
  DatasetPersistencePort,
  StoredDataset,
  WorkspaceScope,
} from "@kurobara/ports";
import type postgres from "postgres";

import {
  type DatasetMaterializationRowIdentity,
  parseDatasetMaterializationPayload,
} from "./dataset-generation-payload.ts";
import {
  type DatasetIssueRow,
  type DatasetProgressRow,
  isDatasetImportIssueCode,
  parseDatasetIssue,
  parseDatasetPayload,
  parseDatasetProgress,
  parseFieldPayload,
  parseRecordPayload,
  validateStoredFields,
} from "./dataset-payload.ts";
import { PostgresAdapterError } from "./errors.ts";
import { toJsonValue } from "./json.ts";

const CONTENT_HASH = /^sha256:[0-9a-f]{64}$/u;
const ISSUE_CURSOR_BATCH_SIZE = 100;
const RECORD_CURSOR_BATCH_SIZE = 1;
const MAX_BATCH_BYTES = 67_108_864;
const MAX_BATCH_ITEMS = 1000;
const MAX_RECORD_BYTES = 16_777_216;
const MIN_BATCH_BYTES = 1024;
const IMPORT_MATERIALIZATION_STATES = {
  completed: "ready",
  failed: "failed",
  running: "building",
} as const;

type ImportIdentityRow = DatasetProgressRow &
  Readonly<{
    intent_hash: string;
    schema_hash: string;
    source_content_hash: string;
  }>;

type AppendImportRow = DatasetProgressRow &
  Readonly<{
    max_batch_bytes: number;
    max_batch_items: number;
  }>;
type BatchRow = Readonly<{ content_hash: string; item_count: number }>;
type ResetImportRow = DatasetProgressRow &
  Readonly<{ source_content_hash: string }>;
type DatasetRow = Readonly<{
  batch_count: number | null;
  dataset: unknown;
  dataset_id: string;
  error_count: string | null;
  import_id: string | null;
  item_count: string | null;
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
  record_count: string | null;
  state: string | null;
  workspace_id: string;
}>;
type FieldRow = Readonly<{
  field: unknown;
  field_id: string;
  ordinal: number;
}>;
type RecordRow = Readonly<{ record: unknown; record_id: string }>;

const conflict = (
  conflictCode: Extract<
    DatasetImportMutationResult,
    { status: "conflict" }
  >["conflict"]
): DatasetImportMutationResult => ({
  conflict: conflictCode,
  status: "conflict",
});

const success = (
  progress: DatasetImportProgress,
  status: "applied" | "unchanged"
): DatasetImportMutationResult => ({ progress, status });

const existingImportResult = (
  existing: readonly ImportIdentityRow[],
  definition: DatasetImportDefinition
): DatasetImportMutationResult => {
  const exact = existing.find(
    (row) =>
      row.dataset_id === definition.dataset.datasetId &&
      row.import_id === definition.importId
  );
  if (exact === undefined || existing.length !== 1) {
    return conflict("dataset-already-imported");
  }
  return exact.schema_hash === definition.schemaHash &&
    exact.intent_hash === definition.intentHash &&
    exact.source_content_hash === definition.sourceContentHash
    ? success(parseDatasetProgress(exact), "unchanged")
    : conflict("definition-mismatch");
};

const validCompletionCounts = (completion: DatasetImportCompletion): boolean =>
  Number.isSafeInteger(completion.batchCount) &&
  completion.batchCount >= 0 &&
  Number.isSafeInteger(completion.itemCount) &&
  completion.itemCount >= 0;

const terminalCompletionResult = (
  current: DatasetImportProgress,
  completion: DatasetImportCompletion
): DatasetImportMutationResult =>
  current.state === completion.state &&
  current.batchCount === completion.batchCount &&
  current.itemCount === completion.itemCount
    ? success(current, "unchanged")
    : conflict("import-completion-mismatch");

const assertScope = (
  scope: WorkspaceScope,
  workspaceId: string,
  datasetId?: string,
  expectedDatasetId?: string
): boolean =>
  scope.workspaceId === workspaceId &&
  (datasetId === undefined || datasetId === expectedDatasetId);

const validPositiveInteger = (value: number): boolean =>
  Number.isSafeInteger(value) && value > 0;

const codePointLength = (value: string): number => [...value].length;

const compareKeys = (left: string, right: string): number => {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
};

// This intentionally mirrors the application canonicalization contract. The
// adapter verifies the payload it is asked to make durable instead of trusting
// a hash-shaped string supplied by another layer.
const serializeCanonical = (value: unknown): string => {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "string"
  ) {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError("Canonical content contains a non-finite number.");
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(serializeCanonical).join(",")}]`;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value)
      .filter((entry) => entry[1] !== undefined)
      .sort(([left], [right]) => compareKeys(left, right));
    return `{${entries
      .map(
        ([key, entryValue]) =>
          `${JSON.stringify(key)}:${serializeCanonical(entryValue)}`
      )
      .join(",")}}`;
  }
  throw new TypeError(`Canonical content cannot contain ${typeof value}.`);
};

const canonicalHash = (value: unknown): string =>
  `sha256:${createHash("sha256")
    .update(serializeCanonical(value), "utf8")
    .digest("hex")}`;

const canonicalByteSize = (value: unknown): number =>
  Buffer.byteLength(serializeCanonical(value), "utf8");

const hashableItem = (item: DatasetImportBatch["items"][number]): unknown =>
  item.kind === "record"
    ? {
        itemNumber: item.itemNumber,
        kind: item.kind,
        record: item.record,
        recordNumber: item.recordNumber,
      }
    : {
        issue: item.issue,
        itemNumber: item.itemNumber,
        kind: item.kind,
      };

const validIssue = (issue: DatasetImportIssue): boolean =>
  isDatasetImportIssueCode(issue.code) &&
  issue.code.trim().length > 0 &&
  codePointLength(issue.code) <= 128 &&
  issue.message.trim().length > 0 &&
  codePointLength(issue.message) <= 2048 &&
  (issue.scope === "document" || issue.scope === "record") &&
  typeof issue.recoverable === "boolean" &&
  (issue.fieldKey === undefined ||
    (codePointLength(issue.fieldKey) >= 1 &&
      codePointLength(issue.fieldKey) <= 128)) &&
  (issue.recordId === undefined ||
    (codePointLength(issue.recordId) >= 1 &&
      codePointLength(issue.recordId) <= 255)) &&
  (issue.lineStart === undefined || validPositiveInteger(issue.lineStart)) &&
  (issue.lineEnd === undefined || validPositiveInteger(issue.lineEnd)) &&
  (issue.recordNumber === undefined ||
    validPositiveInteger(issue.recordNumber)) &&
  (issue.lineStart === undefined ||
    issue.lineEnd === undefined ||
    issue.lineEnd >= issue.lineStart);

const validDefinitionScope = (
  scope: WorkspaceScope,
  definition: DatasetImportDefinition
): boolean => {
  if (
    definition.dataset.workspaceId !== scope.workspaceId ||
    definition.importId.trim().length === 0 ||
    codePointLength(definition.importId) > 255 ||
    definition.codecVersion !== "1.0.0" ||
    (definition.format !== "csv" && definition.format !== "jsonl") ||
    definition.fields.length > 256 ||
    !definition.fields.every(
      (field) =>
        field.workspaceId === scope.workspaceId &&
        field.datasetId === definition.dataset.datasetId
    ) ||
    !validPositiveInteger(definition.maxRecordBytes) ||
    definition.maxRecordBytes > MAX_RECORD_BYTES ||
    !validPositiveInteger(definition.batchLimits.maxItems) ||
    definition.batchLimits.maxItems > MAX_BATCH_ITEMS ||
    !Number.isSafeInteger(definition.batchLimits.maxBytes) ||
    definition.batchLimits.maxBytes <
      Math.max(definition.maxRecordBytes, MIN_BATCH_BYTES) ||
    definition.batchLimits.maxBytes > MAX_BATCH_BYTES ||
    !CONTENT_HASH.test(definition.schemaHash) ||
    !CONTENT_HASH.test(definition.intentHash) ||
    !CONTENT_HASH.test(definition.sourceContentHash)
  ) {
    return false;
  }
  try {
    const validatedDataset = parseDatasetPayload(
      definition.dataset,
      scope.workspaceId,
      definition.dataset.datasetId
    );
    validateStoredFields(
      validatedDataset,
      definition.fields.map((field) =>
        parseFieldPayload(field, validatedDataset, field.fieldId)
      )
    );
    const expectedSchemaHash = canonicalHash({
      dataset: definition.dataset,
      fields: definition.fields,
    });
    return (
      definition.schemaHash === expectedSchemaHash &&
      definition.intentHash ===
        canonicalHash({
          batchLimits: definition.batchLimits,
          codecVersion: definition.codecVersion,
          format: definition.format,
          importId: definition.importId,
          maxRecordBytes: definition.maxRecordBytes,
          schemaHash: expectedSchemaHash,
          sourceContentHash: definition.sourceContentHash,
        })
    );
  } catch {
    return false;
  }
};

const materializationIdentityFromDatasetRow = (
  row: DatasetRow
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

const createImportMaterialization = (
  definition: DatasetImportDefinition,
  createdAtMilliseconds: number
) => {
  const created = createDatasetMaterialization({
    createdAt: instant(createdAtMilliseconds),
    datasetId: definition.dataset.datasetId,
    materializationId: datasetMaterializationId(
      String(definition.dataset.datasetId)
    ),
    origin: { importId: definition.importId, kind: "import" },
    recordCount: 0,
    rejectedCount: 0,
    revision: 1,
    schemaHash: definition.schemaHash,
    state: "building",
    workspaceId: definition.dataset.workspaceId,
  });
  if (!created.ok) {
    throw new PostgresAdapterError(
      "dataset-materialization-invalid",
      created.error.message
    );
  }
  return created.value;
};

const loadDataset = async (
  sql: postgres.Sql,
  scope: WorkspaceScope,
  requestedDatasetId: DatasetId
): Promise<StoredDataset | undefined> => {
  const rows = await sql<readonly DatasetRow[]>`
    SELECT
      dataset.dataset,
      dataset.workspace_id,
      dataset.dataset_id,
      dataset_import.import_id,
      dataset_import.state,
      dataset_import.batch_count,
      dataset_import.item_count::text AS item_count,
      dataset_import.record_count::text AS record_count,
      dataset_import.error_count::text AS error_count,
      materialization.materialization_id,
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
      materialization.created_at AS materialization_created_at
    FROM kurobara_core.datasets AS dataset
    JOIN kurobara_core.dataset_materializations AS materialization
      ON materialization.workspace_id = dataset.workspace_id
      AND materialization.dataset_id = dataset.dataset_id
      AND materialization.materialization_id = dataset.dataset_id
    LEFT JOIN kurobara_core.dataset_imports AS dataset_import
      ON materialization.origin_kind = 'import'
      AND dataset_import.workspace_id = materialization.workspace_id
      AND dataset_import.dataset_id = materialization.dataset_id
      AND dataset_import.import_id = materialization.origin_id
    WHERE dataset.workspace_id = ${scope.workspaceId}
      AND dataset.dataset_id = ${requestedDatasetId}
  `;
  const row = rows[0];
  if (row === undefined) {
    return;
  }
  const dataset = parseDatasetPayload(
    row.dataset,
    scope.workspaceId,
    requestedDatasetId
  );
  const fieldRows = await sql<readonly FieldRow[]>`
    SELECT field_id, ordinal, field
    FROM kurobara_core.dataset_fields
    WHERE workspace_id = ${scope.workspaceId}
      AND dataset_id = ${requestedDatasetId}
    ORDER BY ordinal
  `;
  const fields = validateStoredFields(
    dataset,
    fieldRows.map((fieldRow, index) => {
      if (fieldRow.ordinal !== index) {
        throw new PostgresAdapterError(
          "database-payload-invalid",
          "The stored dataset field order is not contiguous."
        );
      }
      return parseFieldPayload(fieldRow.field, dataset, fieldRow.field_id);
    })
  );
  const materialization = parseDatasetMaterializationPayload(
    row.materialization_payload,
    materializationIdentityFromDatasetRow(row)
  );
  if (materialization.origin.kind === "generation") {
    if (
      row.import_id !== null ||
      row.state !== null ||
      row.batch_count !== null ||
      row.item_count !== null ||
      row.record_count !== null ||
      row.error_count !== null
    ) {
      throw new PostgresAdapterError(
        "database-payload-invalid",
        "A generated dataset cannot carry fake import progress."
      );
    }
    return { dataset, fields, materialization };
  }
  if (
    row.import_id === null ||
    row.state === null ||
    row.batch_count === null ||
    row.item_count === null ||
    row.record_count === null ||
    row.error_count === null
  ) {
    throw new PostgresAdapterError(
      "database-payload-invalid",
      "An imported dataset is missing its exact import progress."
    );
  }
  const importProgress = parseDatasetProgress({
    batch_count: row.batch_count,
    dataset_id: row.dataset_id,
    error_count: row.error_count,
    import_id: row.import_id,
    item_count: row.item_count,
    record_count: row.record_count,
    state: row.state,
    workspace_id: row.workspace_id,
  });
  const expectedMaterializationState =
    IMPORT_MATERIALIZATION_STATES[importProgress.state];
  if (
    materialization.workspaceId !== importProgress.workspaceId ||
    materialization.datasetId !== importProgress.datasetId ||
    materialization.origin.importId !== importProgress.importId ||
    materialization.recordCount !== importProgress.recordCount ||
    materialization.rejectedCount !== importProgress.errorCount ||
    materialization.state !== expectedMaterializationState
  ) {
    throw new PostgresAdapterError(
      "database-payload-invalid",
      "The import and its materialization have diverged."
    );
  }
  return {
    dataset,
    fields,
    import: importProgress,
    materialization,
  };
};

const insertIssue = async (
  sql: postgres.Sql,
  input: Readonly<{
    batchSequence: number;
    contentHash: string;
    datasetId: string;
    importId: string;
    issue: DatasetImportIssue;
    itemNumber: number;
    workspaceId: string;
  }>
): Promise<void> => {
  await sql`
    INSERT INTO kurobara_core.dataset_import_issues (
      workspace_id,
      import_id,
      dataset_id,
      batch_sequence,
      item_number,
      source_content_hash,
      issue_code,
      message,
      recoverable,
      issue_scope,
      field_key,
      line_end,
      line_start,
      record_id,
      record_number
    ) VALUES (
      ${input.workspaceId},
      ${input.importId},
      ${input.datasetId},
      ${input.batchSequence},
      ${input.itemNumber},
      ${input.contentHash},
      ${input.issue.code},
      ${input.issue.message},
      ${input.issue.recoverable},
      ${input.issue.scope},
      ${input.issue.fieldKey ?? null},
      ${input.issue.lineEnd ?? null},
      ${input.issue.lineStart ?? null},
      ${input.issue.recordId ?? null},
      ${input.issue.recordNumber ?? null}
    )
  `;
};

const duplicateRecordIssue = (
  record: DatasetRecord,
  recordNumber: number
): DatasetImportIssue => ({
  code: "record-id-conflict",
  message: "A record with this identity already exists in the dataset.",
  recordId: record.recordId,
  recordNumber,
  recoverable: true,
  scope: "record",
});

const validRecordItem = (
  scope: WorkspaceScope,
  dataset: StoredDataset,
  item: Extract<DatasetImportBatch["items"][number], { kind: "record" }>
): boolean => {
  if (
    !(
      assertScope(
        scope,
        item.record.workspaceId,
        item.record.datasetId,
        dataset.dataset.datasetId
      ) && validPositiveInteger(item.recordNumber)
    )
  ) {
    return false;
  }
  parseRecordPayload(
    item.record,
    dataset.dataset,
    dataset.fields,
    item.record.recordId
  );
  return true;
};

const validatedItemByteSize = (
  scope: WorkspaceScope,
  dataset: StoredDataset,
  item: DatasetImportBatch["items"][number],
  expectedItemNumber: number
): number | undefined => {
  if (item.itemNumber !== expectedItemNumber) {
    return;
  }
  const content = item.kind === "record" ? item.record : item.issue;
  if (item.contentHash !== canonicalHash(content)) {
    return;
  }
  const semanticContentIsValid =
    item.kind === "record"
      ? validRecordItem(scope, dataset, item)
      : validIssue(item.issue);
  return semanticContentIsValid
    ? canonicalByteSize(hashableItem(item))
    : undefined;
};

const validBatchContent = (
  scope: WorkspaceScope,
  dataset: StoredDataset,
  batch: DatasetImportBatch,
  maxBatchBytes: number
): boolean => {
  const firstItemNumber = batch.items[0]?.itemNumber;
  if (firstItemNumber === undefined || !validPositiveInteger(firstItemNumber)) {
    return false;
  }
  let normalizedBatchBytes = 0;
  try {
    for (let index = 0; index < batch.items.length; index += 1) {
      const item = batch.items[index];
      if (item === undefined) {
        return false;
      }
      const itemBytes = validatedItemByteSize(
        scope,
        dataset,
        item,
        firstItemNumber + index
      );
      if (itemBytes === undefined) {
        return false;
      }
      normalizedBatchBytes += itemBytes;
      if (normalizedBatchBytes > maxBatchBytes) {
        return false;
      }
    }
    return (
      CONTENT_HASH.test(batch.contentHash) &&
      batch.contentHash === canonicalHash(batch.items.map(hashableItem))
    );
  } catch (error) {
    if (error instanceof TypeError || error instanceof PostgresAdapterError) {
      return false;
    }
    throw error;
  }
};

const appendBatch = async (
  sql: postgres.Sql,
  scope: WorkspaceScope,
  importId: string,
  batch: DatasetImportBatch
): Promise<DatasetImportMutationResult> => {
  const importRows = await sql<readonly AppendImportRow[]>`
    SELECT
      dataset_import.workspace_id,
      dataset_import.dataset_id,
      dataset_import.import_id,
      dataset_import.state,
      dataset_import.batch_count,
      dataset_import.item_count::text AS item_count,
      dataset_import.record_count::text AS record_count,
      dataset_import.error_count::text AS error_count,
      dataset_import.max_batch_bytes,
      dataset_import.max_batch_items
    FROM kurobara_core.dataset_imports AS dataset_import
    WHERE dataset_import.workspace_id = ${scope.workspaceId}
      AND dataset_import.import_id = ${importId}
    FOR UPDATE
  `;
  const importRow = importRows[0];
  if (importRow === undefined) {
    return conflict("import-state-conflict");
  }
  const current = parseDatasetProgress(importRow);
  if (
    !validPositiveInteger(batch.sequence) ||
    batch.items.length === 0 ||
    batch.items.length > importRow.max_batch_items
  ) {
    return conflict("batch-sequence-invalid");
  }

  const storedDataset = await loadDataset(sql, scope, current.datasetId);
  if (storedDataset === undefined) {
    throw new PostgresAdapterError(
      "dataset-import-dataset-missing",
      "The locked dataset import has no durable dataset definition."
    );
  }
  const firstItemNumber = batch.items[0]?.itemNumber;
  if (
    !validBatchContent(scope, storedDataset, batch, importRow.max_batch_bytes)
  ) {
    return conflict("batch-content-mismatch");
  }

  // maxRecordBytes bounds the raw source record and is enforced by the codec,
  // because raw bytes are intentionally absent from this persistence contract.
  // This adapter independently bounds the normalized canonical batch above,
  // and PostgreSQL additionally caps every stored JSON record.
  const batchRows = await sql<readonly BatchRow[]>`
    SELECT content_hash, item_count
    FROM kurobara_core.dataset_import_batches
    WHERE workspace_id = ${scope.workspaceId}
      AND import_id = ${importId}
      AND sequence = ${batch.sequence}
  `;
  const storedBatch = batchRows[0];
  if (storedBatch !== undefined) {
    return storedBatch.content_hash === batch.contentHash &&
      storedBatch.item_count === batch.items.length
      ? success(current, "unchanged")
      : conflict("batch-content-mismatch");
  }
  if (current.state !== "running") {
    return conflict("import-state-conflict");
  }
  if (
    batch.sequence !== current.batchCount + 1 ||
    firstItemNumber !== current.itemCount + 1
  ) {
    return conflict("batch-sequence-invalid");
  }

  await sql`
    INSERT INTO kurobara_core.dataset_import_batches (
      workspace_id,
      import_id,
      sequence,
      content_hash,
      item_count
    ) VALUES (
      ${scope.workspaceId},
      ${importId},
      ${batch.sequence},
      ${batch.contentHash},
      ${batch.items.length}
    )
  `;

  let accepted = 0;
  let rejected = 0;
  for (const item of batch.items) {
    if (item.kind === "issue") {
      await insertIssue(sql, {
        batchSequence: batch.sequence,
        contentHash: item.contentHash,
        datasetId: current.datasetId,
        importId,
        issue: item.issue,
        itemNumber: item.itemNumber,
        workspaceId: scope.workspaceId,
      });
      rejected += 1;
      continue;
    }
    const inserted = await sql<readonly { record_id: string }[]>`
      INSERT INTO kurobara_core.dataset_records (
        workspace_id,
        dataset_id,
        record_id,
        materialization_id,
        record_ordinal,
        import_id,
        batch_sequence,
        item_number,
        record_number,
        content_hash,
        record
      ) VALUES (
        ${scope.workspaceId},
        ${current.datasetId},
        ${item.record.recordId},
        ${current.datasetId},
        ${current.recordCount + accepted + 1},
        ${importId},
        ${batch.sequence},
        ${item.itemNumber},
        ${item.recordNumber},
        ${item.contentHash},
        ${sql.json(toJsonValue(item.record))}
      )
      ON CONFLICT (workspace_id, dataset_id, record_id) DO NOTHING
      RETURNING record_id
    `;
    if (inserted.length === 1) {
      accepted += 1;
    } else {
      await insertIssue(sql, {
        batchSequence: batch.sequence,
        contentHash: item.contentHash,
        datasetId: current.datasetId,
        importId,
        issue: duplicateRecordIssue(item.record, item.recordNumber),
        itemNumber: item.itemNumber,
        workspaceId: scope.workspaceId,
      });
      rejected += 1;
    }
  }

  const updated = await sql<readonly DatasetProgressRow[]>`
    UPDATE kurobara_core.dataset_imports AS dataset_import
    SET
      batch_count = batch_count + 1,
      item_count = item_count + ${batch.items.length},
      record_count = record_count + ${accepted},
      error_count = error_count + ${rejected}
    WHERE dataset_import.workspace_id = ${scope.workspaceId}
      AND dataset_import.import_id = ${importId}
      AND dataset_import.state = 'running'
    RETURNING
      dataset_import.workspace_id,
      dataset_import.dataset_id,
      dataset_import.import_id,
      dataset_import.state,
      dataset_import.batch_count,
      dataset_import.item_count::text AS item_count,
      dataset_import.record_count::text AS record_count,
      dataset_import.error_count::text AS error_count
  `;
  const progress = updated[0];
  if (progress === undefined) {
    throw new PostgresAdapterError(
      "dataset-import-state-conflict",
      "The dataset import changed state while appending a locked batch."
    );
  }
  const materializationRows = await sql<
    readonly { materialization_id: string }[]
  >`
    UPDATE kurobara_core.dataset_materializations AS materialization
    SET
      record_count = record_count + ${accepted},
      rejected_count = rejected_count + ${rejected},
      revision = revision + 1,
      payload = jsonb_set(
        jsonb_set(
          jsonb_set(
            payload,
            '{recordCount}',
            to_jsonb(record_count + ${accepted})
          ),
          '{rejectedCount}',
          to_jsonb(rejected_count + ${rejected})
        ),
        '{revision}',
        to_jsonb(revision + 1)
      )
    WHERE materialization.workspace_id = ${scope.workspaceId}
      AND materialization.dataset_id = ${current.datasetId}
      AND materialization.materialization_id = ${current.datasetId}
      AND materialization.origin_kind = 'import'
      AND materialization.origin_id = ${importId}
      AND materialization.state = 'building'
    RETURNING materialization_id
  `;
  if (materializationRows[0] === undefined) {
    throw new PostgresAdapterError(
      "dataset-materialization-state-conflict",
      "The import materialization could not advance with its batch."
    );
  }
  return success(parseDatasetProgress(progress), "applied");
};

const resetDatasetImport = async (
  sql: postgres.Sql,
  scope: WorkspaceScope,
  importId: string,
  sourceContentHash: string
): Promise<DatasetImportMutationResult> => {
  if (!CONTENT_HASH.test(sourceContentHash)) {
    return conflict("definition-mismatch");
  }
  const rows = await sql<readonly ResetImportRow[]>`
    SELECT
      dataset_import.workspace_id,
      dataset_import.dataset_id,
      dataset_import.import_id,
      dataset_import.state,
      dataset_import.batch_count,
      dataset_import.item_count::text AS item_count,
      dataset_import.record_count::text AS record_count,
      dataset_import.error_count::text AS error_count,
      dataset_import.source_content_hash
    FROM kurobara_core.dataset_imports AS dataset_import
    WHERE dataset_import.workspace_id = ${scope.workspaceId}
      AND dataset_import.import_id = ${importId}
    FOR UPDATE
  `;
  const row = rows[0];
  if (row === undefined || row.state !== "running") {
    return conflict("import-state-conflict");
  }
  if (row.source_content_hash !== sourceContentHash) {
    return conflict("definition-mismatch");
  }
  const current = parseDatasetProgress(row);
  const childRows = await sql<readonly { has_children: boolean }[]>`
    SELECT
      EXISTS (
        SELECT 1
        FROM kurobara_core.dataset_import_batches
        WHERE workspace_id = ${scope.workspaceId}
          AND import_id = ${importId}
      ) AS has_children
  `;
  const hasProgress =
    current.batchCount > 0 ||
    current.itemCount > 0 ||
    current.recordCount > 0 ||
    current.errorCount > 0;
  if (!(hasProgress || childRows[0]?.has_children)) {
    return success(current, "unchanged");
  }

  await sql`
    DELETE FROM kurobara_core.dataset_import_issues
    WHERE workspace_id = ${scope.workspaceId}
      AND import_id = ${importId}
  `;
  await sql`
    DELETE FROM kurobara_core.dataset_records
    WHERE workspace_id = ${scope.workspaceId}
      AND import_id = ${importId}
  `;
  await sql`
    DELETE FROM kurobara_core.dataset_import_batches
    WHERE workspace_id = ${scope.workspaceId}
      AND import_id = ${importId}
  `;
  const resetRows = await sql<readonly DatasetProgressRow[]>`
    UPDATE kurobara_core.dataset_imports AS dataset_import
    SET
      batch_count = 0,
      item_count = 0,
      record_count = 0,
      error_count = 0
    WHERE dataset_import.workspace_id = ${scope.workspaceId}
      AND dataset_import.import_id = ${importId}
      AND dataset_import.state = 'running'
    RETURNING
      dataset_import.workspace_id,
      dataset_import.dataset_id,
      dataset_import.import_id,
      dataset_import.state,
      dataset_import.batch_count,
      dataset_import.item_count::text AS item_count,
      dataset_import.record_count::text AS record_count,
      dataset_import.error_count::text AS error_count
  `;
  const reset = resetRows[0];
  if (reset === undefined) {
    throw new PostgresAdapterError(
      "dataset-import-state-conflict",
      "The locked dataset import could not be reset."
    );
  }
  const materializationRows = await sql<
    readonly { materialization_id: string }[]
  >`
    UPDATE kurobara_core.dataset_materializations AS materialization
    SET
      record_count = 0,
      rejected_count = 0,
      revision = revision + 1,
      payload = jsonb_set(
        jsonb_set(
          jsonb_set(payload, '{recordCount}', '0'::jsonb),
          '{rejectedCount}',
          '0'::jsonb
        ),
        '{revision}',
        to_jsonb(revision + 1)
      )
    WHERE materialization.workspace_id = ${scope.workspaceId}
      AND materialization.dataset_id = ${current.datasetId}
      AND materialization.materialization_id = ${current.datasetId}
      AND materialization.origin_kind = 'import'
      AND materialization.origin_id = ${importId}
      AND materialization.state = 'building'
    RETURNING materialization_id
  `;
  if (materializationRows[0] === undefined) {
    throw new PostgresAdapterError(
      "dataset-materialization-state-conflict",
      "The import materialization could not reset with its import."
    );
  }
  return success(parseDatasetProgress(reset), "applied");
};

const finishImportMaterialization = async (
  sql: postgres.Sql,
  scope: WorkspaceScope,
  progress: DatasetImportProgress,
  importId: string,
  state: "completed" | "failed",
  completedAt: Date,
  completedAtMilliseconds: number
): Promise<void> => {
  const materializationRows =
    state === "completed"
      ? await sql<readonly { materialization_id: string }[]>`
          UPDATE kurobara_core.dataset_materializations AS materialization
          SET
            state = 'ready',
            revision = revision + 1,
            completed_at = ${completedAt},
            completion_reason = 'source-exhausted',
            content_hash =
              kurobara_core.dataset_materialization_content_hash(
                materialization.workspace_id,
                materialization.dataset_id
              ),
            coverage_basis = 'imported_source',
            coverage_status = 'complete_for_declared_source',
            payload = payload || jsonb_build_object(
              'completedAt', ${completedAtMilliseconds}::bigint,
              'completionReason', 'source-exhausted',
              'contentHash',
                kurobara_core.dataset_materialization_content_hash(
                  materialization.workspace_id,
                  materialization.dataset_id
                ),
              'coverage', jsonb_build_object(
                'basis', 'imported_source',
                'status', 'complete_for_declared_source'
              ),
              'revision', revision + 1,
              'state', 'ready'
            )
          WHERE materialization.workspace_id = ${scope.workspaceId}
            AND materialization.dataset_id = ${progress.datasetId}
            AND materialization.materialization_id = ${progress.datasetId}
            AND materialization.origin_kind = 'import'
            AND materialization.origin_id = ${importId}
            AND materialization.state = 'building'
          RETURNING materialization_id
        `
      : await sql<readonly { materialization_id: string }[]>`
          UPDATE kurobara_core.dataset_materializations AS materialization
          SET
            state = 'failed',
            revision = revision + 1,
            completed_at = ${completedAt},
            completion_reason = 'dataset-import-failed',
            content_hash = NULL,
            coverage_basis = NULL,
            coverage_status = NULL,
            payload = (payload - ARRAY[
              'contentHash', 'coverage'
            ]) || jsonb_build_object(
              'completedAt', ${completedAtMilliseconds}::bigint,
              'completionReason', 'dataset-import-failed',
              'revision', revision + 1,
              'state', 'failed'
            )
          WHERE materialization.workspace_id = ${scope.workspaceId}
            AND materialization.dataset_id = ${progress.datasetId}
            AND materialization.materialization_id = ${progress.datasetId}
            AND materialization.origin_kind = 'import'
            AND materialization.origin_id = ${importId}
            AND materialization.state = 'building'
          RETURNING materialization_id
        `;
  if (materializationRows[0] === undefined) {
    throw new PostgresAdapterError(
      "dataset-materialization-state-conflict",
      "The import materialization could not complete with its import."
    );
  }
};

export const createPostgresDatasetPersistence = (
  sql: postgres.Sql
): DatasetPersistencePort => ({
  appendImportBatch: async (scope, importId, batch) => {
    const result = await sql.begin((transaction) =>
      appendBatch(
        transaction as unknown as postgres.Sql,
        scope,
        importId,
        batch
      )
    );
    return result as unknown as DatasetImportMutationResult;
  },
  beginImport: async (scope, definition) => {
    if (!validDefinitionScope(scope, definition)) {
      return conflict("definition-mismatch");
    }
    const result = await sql.begin(async (transaction) => {
      const transactionSql = transaction as unknown as postgres.Sql;
      await transactionSql`
        SELECT pg_advisory_xact_lock(
          hashtextextended(
            ${JSON.stringify([
              "dataset",
              scope.workspaceId,
              definition.dataset.datasetId,
            ])},
            0
          )
        )
      `;
      await transactionSql`
        SELECT pg_advisory_xact_lock(
          hashtextextended(
            ${JSON.stringify([
              "import",
              scope.workspaceId,
              definition.importId,
            ])},
            0
          )
        )
      `;
      const existing = await transactionSql<readonly ImportIdentityRow[]>`
        SELECT
          dataset_import.workspace_id,
          dataset_import.dataset_id,
          dataset_import.import_id,
          dataset_import.state,
          dataset_import.batch_count,
          dataset_import.item_count::text AS item_count,
          dataset_import.record_count::text AS record_count,
          dataset_import.error_count::text AS error_count,
          dataset_import.schema_hash,
          dataset_import.intent_hash,
          dataset_import.source_content_hash
        FROM kurobara_core.dataset_imports AS dataset_import
        WHERE dataset_import.workspace_id = ${scope.workspaceId}
          AND (
            dataset_import.dataset_id = ${definition.dataset.datasetId}
            OR dataset_import.import_id = ${definition.importId}
          )
        FOR UPDATE
      `;
      if (existing.length > 0) {
        return existingImportResult(existing, definition);
      }

      const datasetRows = await transactionSql<readonly { exists: boolean }[]>`
        SELECT EXISTS (
          SELECT 1
          FROM kurobara_core.datasets
          WHERE workspace_id = ${scope.workspaceId}
            AND dataset_id = ${definition.dataset.datasetId}
        ) AS exists
      `;
      if (datasetRows[0]?.exists) {
        return conflict("dataset-already-imported");
      }

      const createdAtMilliseconds = Date.now();
      const createdAt = new Date(createdAtMilliseconds);
      const materialization = createImportMaterialization(
        definition,
        createdAtMilliseconds
      );

      await transactionSql`
        INSERT INTO kurobara_core.datasets (
          workspace_id,
          dataset_id,
          name,
          schema_hash,
          dataset,
          created_at
        ) VALUES (
          ${scope.workspaceId},
          ${definition.dataset.datasetId},
          ${definition.dataset.name},
          ${definition.schemaHash},
          ${transactionSql.json(toJsonValue(definition.dataset))},
          ${createdAt}
        )
      `;
      for (let ordinal = 0; ordinal < definition.fields.length; ordinal += 1) {
        const field = definition.fields[ordinal];
        if (field === undefined) {
          throw new PostgresAdapterError(
            "dataset-field-missing",
            "The validated dataset field collection contains a gap."
          );
        }
        await transactionSql`
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
            ${definition.dataset.datasetId},
            ${field.fieldId},
            ${ordinal},
            ${field.key},
            ${field.label},
            ${field.valueType},
            ${transactionSql.json(toJsonValue(field))},
            ${createdAt}
          )
        `;
      }
      const inserted = await transactionSql<readonly DatasetProgressRow[]>`
        INSERT INTO kurobara_core.dataset_imports (
          workspace_id,
          import_id,
          dataset_id,
          schema_hash,
          intent_hash,
          source_content_hash,
          format,
          codec_version,
          max_record_bytes,
          max_batch_items,
          max_batch_bytes,
          created_at
        ) VALUES (
          ${scope.workspaceId},
          ${definition.importId},
          ${definition.dataset.datasetId},
          ${definition.schemaHash},
          ${definition.intentHash},
          ${definition.sourceContentHash},
          ${definition.format},
          ${definition.codecVersion},
          ${definition.maxRecordBytes},
          ${definition.batchLimits.maxItems},
          ${definition.batchLimits.maxBytes},
          ${createdAt}
        )
        RETURNING
          dataset_imports.workspace_id,
          dataset_imports.dataset_id,
          dataset_imports.import_id,
          dataset_imports.state,
          dataset_imports.batch_count,
          dataset_imports.item_count::text AS item_count,
          dataset_imports.record_count::text AS record_count,
          dataset_imports.error_count::text AS error_count
      `;
      const progress = inserted[0];
      if (progress === undefined) {
        throw new PostgresAdapterError(
          "dataset-import-insert-failed",
          "The dataset import was not persisted."
        );
      }
      if (materialization.origin.kind !== "import") {
        throw new PostgresAdapterError(
          "dataset-materialization-origin-invalid",
          "An import requires an import materialization origin."
        );
      }
      await transactionSql`
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
          payload,
          created_at
        ) VALUES (
          ${materialization.workspaceId},
          ${materialization.materializationId},
          ${materialization.datasetId},
          ${materialization.schemaHash},
          ${materialization.origin.kind},
          ${materialization.origin.importId},
          ${materialization.state},
          ${materialization.revision},
          ${materialization.recordCount},
          ${materialization.rejectedCount},
          ${transactionSql.json(toJsonValue(materialization))},
          ${createdAt}
        )
      `;
      return success(parseDatasetProgress(progress), "applied");
    });
    return result as unknown as DatasetImportMutationResult;
  },
  finishImport: async (scope, importId, completion) => {
    const result = await sql.begin(async (transaction) => {
      const transactionSql = transaction as unknown as postgres.Sql;
      const rows = await transactionSql<readonly DatasetProgressRow[]>`
        SELECT
          dataset_import.workspace_id,
          dataset_import.dataset_id,
          dataset_import.import_id,
          dataset_import.state,
          dataset_import.batch_count,
          dataset_import.item_count::text AS item_count,
          dataset_import.record_count::text AS record_count,
          dataset_import.error_count::text AS error_count
        FROM kurobara_core.dataset_imports AS dataset_import
        WHERE dataset_import.workspace_id = ${scope.workspaceId}
          AND dataset_import.import_id = ${importId}
        FOR UPDATE
      `;
      const row = rows[0];
      if (row === undefined) {
        return conflict("import-state-conflict");
      }
      const current = parseDatasetProgress(row);
      if (!validCompletionCounts(completion)) {
        return conflict("import-completion-mismatch");
      }
      if (current.state !== "running") {
        return terminalCompletionResult(current, completion);
      }
      if (
        current.batchCount !== completion.batchCount ||
        current.itemCount !== completion.itemCount
      ) {
        return conflict("import-completion-mismatch");
      }
      const completedAtMilliseconds = Date.now();
      const completedAt = new Date(completedAtMilliseconds);
      const updated = await transactionSql<readonly DatasetProgressRow[]>`
        UPDATE kurobara_core.dataset_imports AS dataset_import
        SET
          state = ${completion.state},
          completed_at = ${completedAt}
        WHERE dataset_import.workspace_id = ${scope.workspaceId}
          AND dataset_import.import_id = ${importId}
          AND dataset_import.state = 'running'
        RETURNING
          dataset_import.workspace_id,
          dataset_import.dataset_id,
          dataset_import.import_id,
          dataset_import.state,
          dataset_import.batch_count,
          dataset_import.item_count::text AS item_count,
          dataset_import.record_count::text AS record_count,
          dataset_import.error_count::text AS error_count
      `;
      const progress = updated[0];
      if (progress === undefined) {
        throw new PostgresAdapterError(
          "dataset-import-state-conflict",
          "The locked dataset import could not be completed."
        );
      }
      await finishImportMaterialization(
        transactionSql,
        scope,
        current,
        importId,
        completion.state,
        completedAt,
        completedAtMilliseconds
      );
      return success(parseDatasetProgress(progress), "applied");
    });
    return result as unknown as DatasetImportMutationResult;
  },
  getDataset: (scope, requestedDatasetId) =>
    loadDataset(sql, scope, requestedDatasetId),
  isFieldSetComplete: async (scope, requestedDatasetId, fieldIds) => {
    if (new Set(fieldIds).size !== fieldIds.length) {
      return false;
    }
    const rows = await sql<readonly { complete: boolean }[]>`
      SELECT
        EXISTS (
          SELECT 1
          FROM kurobara_core.dataset_materializations AS materialization
          WHERE materialization.workspace_id = ${scope.workspaceId}
            AND materialization.dataset_id = ${requestedDatasetId}
            AND materialization.materialization_id = ${requestedDatasetId}
            AND materialization.state = 'ready'
        )
        AND (
          SELECT count(*)::integer
          FROM kurobara_core.dataset_fields AS field
          WHERE field.workspace_id = ${scope.workspaceId}
            AND field.dataset_id = ${requestedDatasetId}
            AND field.field_id = ANY(${fieldIds}::text[])
        ) = ${fieldIds.length}
        AND NOT EXISTS (
          SELECT 1
          FROM kurobara_core.dataset_records AS record
          JOIN kurobara_core.dataset_materializations AS materialization
            ON materialization.workspace_id = record.workspace_id
            AND materialization.materialization_id = record.materialization_id
            AND materialization.dataset_id = record.dataset_id
          WHERE record.workspace_id = ${scope.workspaceId}
            AND record.dataset_id = ${requestedDatasetId}
            AND materialization.state = 'ready'
            AND (
              SELECT count(DISTINCT value ->> 'fieldId')
              FROM jsonb_array_elements(record.record -> 'values') AS value
              WHERE value ->> 'fieldId' = ANY(${fieldIds}::text[])
            ) <> ${fieldIds.length}
        ) AS complete
    `;
    return rows[0]?.complete ?? false;
  },
  resetImport: async (scope, importId, sourceContentHash) => {
    const result = await sql.begin((transaction) =>
      resetDatasetImport(
        transaction as unknown as postgres.Sql,
        scope,
        importId,
        sourceContentHash
      )
    );
    return result as unknown as DatasetImportMutationResult;
  },
  streamImportIssues: (scope, requestedDatasetId) => ({
    async *[Symbol.asyncIterator]() {
      const query = sql<readonly DatasetIssueRow[]>`
        SELECT
          issue_code,
          message,
          recoverable,
          issue_scope,
          field_key,
          line_end::text AS line_end,
          line_start::text AS line_start,
          record_id,
          record_number::text AS record_number
        FROM kurobara_core.dataset_import_issues AS issue
        JOIN kurobara_core.dataset_imports AS dataset_import
          ON dataset_import.workspace_id = issue.workspace_id
          AND dataset_import.import_id = issue.import_id
          AND dataset_import.dataset_id = issue.dataset_id
        WHERE issue.workspace_id = ${scope.workspaceId}
          AND issue.dataset_id = ${requestedDatasetId}
        ORDER BY issue.item_number
      `;
      for await (const rows of query.cursor(ISSUE_CURSOR_BATCH_SIZE)) {
        for (const row of rows) {
          yield parseDatasetIssue(row);
        }
      }
    },
  }),
  streamRecords: (scope, requestedDatasetId) => ({
    async *[Symbol.asyncIterator]() {
      const stored = await loadDataset(sql, scope, requestedDatasetId);
      if (stored === undefined || stored.materialization.state !== "ready") {
        return;
      }
      const query = sql<readonly RecordRow[]>`
        SELECT record.record_id, record.record
        FROM kurobara_core.dataset_records AS record
        JOIN kurobara_core.dataset_materializations AS materialization
          ON materialization.workspace_id = record.workspace_id
          AND materialization.materialization_id = record.materialization_id
          AND materialization.dataset_id = record.dataset_id
        WHERE record.workspace_id = ${scope.workspaceId}
          AND record.dataset_id = ${requestedDatasetId}
          AND materialization.state = 'ready'
        ORDER BY record.record_ordinal
      `;
      for await (const rows of query.cursor(RECORD_CURSOR_BATCH_SIZE)) {
        for (const row of rows) {
          yield parseRecordPayload(
            row.record,
            stored.dataset,
            stored.fields,
            row.record_id
          );
        }
      }
    },
  }),
});
