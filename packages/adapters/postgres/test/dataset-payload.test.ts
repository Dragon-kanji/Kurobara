import assert from "node:assert/strict";
import test from "node:test";

import {
  createDataset,
  createField,
  datasetId,
  fieldId,
  workspaceId,
} from "@kurobara/kernel";
import {
  parseDatasetIssue,
  parseDatasetPayload,
  parseDatasetProgress,
  parseFieldPayload,
  parseRecordPayload,
  validateStoredFields,
} from "../src/dataset-payload.ts";
import { DatabasePayloadError } from "../src/errors.ts";

const workspace = workspaceId("workspace-dataset-payload");
const datasetIdentifier = datasetId("dataset-payload");
const datasetResult = createDataset({
  datasetId: datasetIdentifier,
  name: "Synthetic dataset",
  workspaceId: workspace,
});
if (!datasetResult.ok) {
  throw new Error("Dataset fixture is invalid.");
}
const dataset = datasetResult.value;
const fieldResult = createField(dataset, {
  datasetId: datasetIdentifier,
  fieldId: fieldId("field-name"),
  key: "name",
  label: "Name",
  valueType: "string",
  workspaceId: workspace,
});
if (!fieldResult.ok) {
  throw new Error("Field fixture is invalid.");
}
const fields = [fieldResult.value];

test("parses dataset storage payloads through the product invariants", () => {
  const parsedDataset = parseDatasetPayload(
    dataset,
    workspace,
    datasetIdentifier
  );
  const parsedFields = validateStoredFields(parsedDataset, [
    parseFieldPayload(fields[0], parsedDataset, fields[0].fieldId),
  ]);
  const parsedRecord = parseRecordPayload(
    {
      datasetId: datasetIdentifier,
      recordId: "record-payload",
      values: [{ fieldId: "field-name", value: null }],
      workspaceId: workspace,
    },
    parsedDataset,
    parsedFields,
    "record-payload"
  );

  assert.deepEqual(parsedDataset, dataset);
  assert.deepEqual(parsedFields, fields);
  assert.deepEqual(parsedRecord.values, [
    { fieldId: fieldId("field-name"), value: null },
  ]);
});

test("rejects stored identities and values that disagree with database keys", () => {
  assert.throws(
    () => parseDatasetPayload(dataset, workspace, "dataset-other"),
    DatabasePayloadError
  );
  assert.throws(
    () =>
      parseRecordPayload(
        {
          datasetId: datasetIdentifier,
          recordId: "record-payload",
          values: [{ fieldId: "field-name", value: { private: true } }],
          workspaceId: workspace,
        },
        dataset,
        fields,
        "record-payload"
      ),
    DatabasePayloadError
  );
});

test("parses bounded progress and redacted issues without inventing optionals", () => {
  assert.deepEqual(
    parseDatasetProgress({
      batch_count: 2,
      dataset_id: datasetIdentifier,
      error_count: "1",
      import_id: "import-payload",
      item_count: "3",
      record_count: "2",
      state: "completed",
      workspace_id: workspace,
    }),
    {
      batchCount: 2,
      datasetId: datasetIdentifier,
      errorCount: 1,
      importId: "import-payload",
      itemCount: 3,
      recordCount: 2,
      state: "completed",
      workspaceId: workspace,
    }
  );
  assert.deepEqual(
    parseDatasetIssue({
      field_key: null,
      issue_code: "invalid-json",
      issue_scope: "record",
      line_end: "2",
      line_start: "2",
      message: "The row is invalid.",
      record_id: null,
      record_number: "2",
      recoverable: true,
    }),
    {
      code: "invalid-json",
      lineEnd: 2,
      lineStart: 2,
      message: "The row is invalid.",
      recordNumber: 2,
      recoverable: true,
      scope: "record",
    }
  );
});

test("rejects unknown issue codes and malformed optional evidence", () => {
  const issueRow = {
    field_key: null,
    issue_code: "invalid-json",
    issue_scope: "record",
    line_end: "4",
    line_start: "2",
    message: "The row is invalid.",
    record_id: null,
    record_number: "2",
    recoverable: true,
  } as const;

  assert.throws(
    () => parseDatasetIssue({ ...issueRow, issue_code: "provider-secret" }),
    DatabasePayloadError
  );
  assert.throws(
    () => parseDatasetIssue({ ...issueRow, line_end: "1" }),
    DatabasePayloadError
  );
  assert.throws(
    () => parseDatasetIssue({ ...issueRow, field_key: "" }),
    DatabasePayloadError
  );
});
