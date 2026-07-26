import {
  createDataset,
  createField,
  createRecord,
  type Dataset,
  type Record as DatasetRecord,
  datasetId,
  type Field,
  fieldId,
  recordId,
  type ScalarValue,
  validateDatasetFields,
  workspaceId,
} from "@kurobara/kernel";
import type {
  DatasetImportIssue,
  DatasetImportProgress,
  DatasetImportState,
} from "@kurobara/ports";

import { DatabasePayloadError } from "./errors.ts";

type JsonRecord = Readonly<Record<string, unknown>>;

const DATASET_ISSUE_CODES: ReadonlySet<string> = new Set([
  "column-count-mismatch",
  "configuration-invalid",
  "csv-syntax-invalid",
  "field-set-invalid",
  "header-invalid",
  "invalid-json",
  "invalid-record-shape",
  "invalid-utf8",
  "record-domain-invalid",
  "record-id-conflict",
  "record-id-invalid",
  "record-too-large",
  "scope-mismatch",
  "value-type-mismatch",
]);

const codePointLength = (value: string): number => [...value].length;

export const isDatasetImportIssueCode = (
  value: string
): value is DatasetImportIssue["code"] => DATASET_ISSUE_CODES.has(value);

export type DatasetProgressRow = Readonly<{
  batch_count: number;
  dataset_id: string;
  error_count: string;
  import_id: string;
  item_count: string;
  record_count: string;
  state: string;
  workspace_id: string;
}>;

export type DatasetIssueRow = Readonly<{
  field_key: string | null;
  issue_code: string;
  issue_scope: string;
  line_end: string | null;
  line_start: string | null;
  message: string;
  record_id: string | null;
  record_number: string | null;
  recoverable: boolean;
}>;

const asRecord = (value: unknown, path: string): JsonRecord => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new DatabasePayloadError(`${path} must be an object.`);
  }
  return value as JsonRecord;
};

const asString = (value: unknown, path: string): string => {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new DatabasePayloadError(`${path} must be a non-empty string.`);
  }
  return value;
};

const asBoundedString = (
  value: unknown,
  path: string,
  maximum: number
): string => {
  const parsed = asString(value, path);
  if (codePointLength(parsed) > maximum) {
    throw new DatabasePayloadError(`${path} exceeds its maximum length.`);
  }
  return parsed;
};

const asOptionalBoundedString = (
  value: string | null,
  path: string,
  maximum: number
): string | undefined =>
  value === null ? undefined : asBoundedString(value, path, maximum);

const asSafeCount = (value: string | number, path: string): number => {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new DatabasePayloadError(
      `${path} must be a non-negative safe integer.`
    );
  }
  return parsed;
};

const asOptionalPositive = (
  value: string | null,
  path: string
): number | undefined => {
  if (value === null) {
    return;
  }
  const parsed = asSafeCount(value, path);
  if (parsed === 0) {
    throw new DatabasePayloadError(`${path} must be positive.`);
  }
  return parsed;
};

const isScalar = (value: unknown): value is ScalarValue =>
  value === null ||
  typeof value === "boolean" ||
  typeof value === "number" ||
  typeof value === "string";

export const parseDatasetPayload = (
  value: unknown,
  expectedWorkspaceId: string,
  expectedDatasetId: string
): Dataset => {
  const payload = asRecord(value, "dataset");
  const created = createDataset({
    datasetId: datasetId(asString(payload.datasetId, "dataset.datasetId")),
    name: asString(payload.name, "dataset.name"),
    workspaceId: workspaceId(
      asString(payload.workspaceId, "dataset.workspaceId")
    ),
  });
  if (!created.ok) {
    throw new DatabasePayloadError(
      "The stored dataset violates product invariants."
    );
  }
  if (
    created.value.workspaceId !== expectedWorkspaceId ||
    created.value.datasetId !== expectedDatasetId
  ) {
    throw new DatabasePayloadError(
      "The stored dataset identity does not match its database key."
    );
  }
  return created.value;
};

export const parseFieldPayload = (
  value: unknown,
  dataset: Dataset,
  expectedFieldId: string
): Field => {
  const payload = asRecord(value, "field");
  const valueType = asString(payload.valueType, "field.valueType");
  if (
    valueType !== "boolean" &&
    valueType !== "number" &&
    valueType !== "string"
  ) {
    throw new DatabasePayloadError("field.valueType is invalid.");
  }
  const created = createField(dataset, {
    datasetId: datasetId(asString(payload.datasetId, "field.datasetId")),
    fieldId: fieldId(asString(payload.fieldId, "field.fieldId")),
    key: asString(payload.key, "field.key"),
    label: asString(payload.label, "field.label"),
    valueType,
    workspaceId: workspaceId(
      asString(payload.workspaceId, "field.workspaceId")
    ),
  });
  if (!created.ok) {
    throw new DatabasePayloadError(
      "The stored field violates product invariants."
    );
  }
  if (created.value.fieldId !== expectedFieldId) {
    throw new DatabasePayloadError(
      "The stored field identity does not match its database key."
    );
  }
  return created.value;
};

export const validateStoredFields = (
  dataset: Dataset,
  fields: readonly Field[]
): readonly Field[] => {
  const validated = validateDatasetFields(dataset, fields);
  if (!validated.ok) {
    throw new DatabasePayloadError(
      "The stored dataset field collection violates product invariants."
    );
  }
  return validated.value;
};

export const parseRecordPayload = (
  value: unknown,
  dataset: Dataset,
  fields: readonly Field[],
  expectedRecordId: string
): DatasetRecord => {
  const payload = asRecord(value, "record");
  if (!Array.isArray(payload.values)) {
    throw new DatabasePayloadError("record.values must be an array.");
  }
  const values = payload.values.map((entry, index) => {
    const item = asRecord(entry, `record.values[${index}]`);
    if (!isScalar(item.value)) {
      throw new DatabasePayloadError(
        `record.values[${index}].value must be scalar or null.`
      );
    }
    return {
      fieldId: fieldId(
        asString(item.fieldId, `record.values[${index}].fieldId`)
      ),
      value: item.value,
    };
  });
  const created = createRecord(dataset, fields, {
    datasetId: datasetId(asString(payload.datasetId, "record.datasetId")),
    recordId: recordId(asString(payload.recordId, "record.recordId")),
    values,
    workspaceId: workspaceId(
      asString(payload.workspaceId, "record.workspaceId")
    ),
  });
  if (!created.ok) {
    throw new DatabasePayloadError(
      "The stored record violates product invariants."
    );
  }
  if (created.value.recordId !== expectedRecordId) {
    throw new DatabasePayloadError(
      "The stored record identity does not match its database key."
    );
  }
  return created.value;
};

export const parseDatasetProgress = (
  row: DatasetProgressRow
): DatasetImportProgress => {
  if (
    row.state !== "running" &&
    row.state !== "completed" &&
    row.state !== "failed"
  ) {
    throw new DatabasePayloadError(
      "The stored dataset import state is invalid."
    );
  }
  const progress = {
    batchCount: asSafeCount(row.batch_count, "datasetImport.batchCount"),
    datasetId: datasetId(row.dataset_id),
    errorCount: asSafeCount(row.error_count, "datasetImport.errorCount"),
    importId: asString(row.import_id, "datasetImport.importId"),
    itemCount: asSafeCount(row.item_count, "datasetImport.itemCount"),
    recordCount: asSafeCount(row.record_count, "datasetImport.recordCount"),
    state: row.state as DatasetImportState,
    workspaceId: workspaceId(row.workspace_id),
  };
  if (progress.itemCount !== progress.recordCount + progress.errorCount) {
    throw new DatabasePayloadError("The stored dataset import counts diverge.");
  }
  return progress;
};

export const parseDatasetIssue = (row: DatasetIssueRow): DatasetImportIssue => {
  if (row.issue_scope !== "document" && row.issue_scope !== "record") {
    throw new DatabasePayloadError(
      "The stored dataset issue scope is invalid."
    );
  }
  const lineEnd = asOptionalPositive(row.line_end, "datasetIssue.lineEnd");
  const lineStart = asOptionalPositive(
    row.line_start,
    "datasetIssue.lineStart"
  );
  const recordNumber = asOptionalPositive(
    row.record_number,
    "datasetIssue.recordNumber"
  );
  const issueCode = asBoundedString(row.issue_code, "datasetIssue.code", 128);
  if (!isDatasetImportIssueCode(issueCode)) {
    throw new DatabasePayloadError("The stored dataset issue code is invalid.");
  }
  if (typeof row.recoverable !== "boolean") {
    throw new DatabasePayloadError(
      "The stored dataset issue recoverability is invalid."
    );
  }
  if (lineEnd !== undefined && lineStart !== undefined && lineEnd < lineStart) {
    throw new DatabasePayloadError(
      "The stored dataset issue line range is invalid."
    );
  }
  const fieldKey = asOptionalBoundedString(
    row.field_key,
    "datasetIssue.fieldKey",
    128
  );
  const recordIdentifier = asOptionalBoundedString(
    row.record_id,
    "datasetIssue.recordId",
    255
  );
  return {
    code: issueCode,
    message: asBoundedString(row.message, "datasetIssue.message", 2048),
    recoverable: row.recoverable,
    scope: row.issue_scope,
    ...(fieldKey === undefined ? {} : { fieldKey }),
    ...(lineEnd === undefined ? {} : { lineEnd }),
    ...(lineStart === undefined ? {} : { lineStart }),
    ...(recordIdentifier === undefined ? {} : { recordId: recordIdentifier }),
    ...(recordNumber === undefined ? {} : { recordNumber }),
  };
};
