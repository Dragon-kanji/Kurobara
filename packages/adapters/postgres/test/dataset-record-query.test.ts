import assert from "node:assert/strict";
import test from "node:test";

import {
  contentHash,
  createDataset,
  createDatasetMaterialization,
  createField,
  createRecord,
  datasetGenerationId,
  datasetId,
  datasetMaterializationId,
  fieldId,
  instant,
  recordId,
  workspaceId,
} from "@kurobara/kernel";
import type { DatasetPersistencePort } from "@kurobara/ports";
import type postgres from "postgres";

import { createPostgresDatasetRecordPageQuery } from "../src/dataset-record-query.ts";
import { DatabasePayloadError } from "../src/errors.ts";

const workspace = workspaceId("workspace-record-page");
const identifier = datasetId("dataset-record-page");
const materializationIdentifier = datasetMaterializationId(
  "dataset-record-page"
);
const createdDataset = createDataset({
  datasetId: identifier,
  name: "Synthetic company candidates",
  workspaceId: workspace,
});
if (!createdDataset.ok) {
  throw new Error("Dataset fixture is invalid.");
}
const dataset = createdDataset.value;
const createdField = createField(dataset, {
  datasetId: identifier,
  fieldId: fieldId("field-company-name"),
  key: "company_name",
  label: "Company name",
  valueType: "string",
  workspaceId: workspace,
});
if (!createdField.ok) {
  throw new Error("Field fixture is invalid.");
}
const fields = [createdField.value] as const;
const createdRecord = createRecord(dataset, fields, {
  datasetId: identifier,
  recordId: recordId("record-company-one"),
  values: [{ fieldId: fields[0].fieldId, value: "Example Company" }],
  workspaceId: workspace,
});
if (!createdRecord.ok) {
  throw new Error("Record fixture is invalid.");
}
const record = createdRecord.value;
const createdMaterialization = createDatasetMaterialization({
  completedAt: instant(1_800_000_000_001),
  completionReason: "source-exhausted",
  contentHash: contentHash(
    "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  ),
  coverage: {
    basis: "locked_provider_route",
    status: "complete_for_declared_source",
  },
  createdAt: instant(1_800_000_000_000),
  datasetId: identifier,
  materializationId: materializationIdentifier,
  origin: {
    generationId: datasetGenerationId("generation-record-page"),
    kind: "generation",
  },
  recordCount: 2,
  rejectedCount: 0,
  revision: 2,
  schemaHash: contentHash(
    "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
  ),
  state: "ready",
  workspaceId: workspace,
});
if (!createdMaterialization.ok) {
  throw new Error("Materialization fixture is invalid.");
}
const materialization = createdMaterialization.value;
const stored = { dataset, fields, materialization };
const scope = { workspaceId: workspace };

const makeDatasets = (
  value: typeof stored | undefined
): DatasetPersistencePort =>
  ({ getDataset: async () => value }) as unknown as DatasetPersistencePort;

test("reads a stable keyset page and keeps only the requested limit", async () => {
  let interpolations: readonly unknown[] = [];
  const sql = ((
    _strings: TemplateStringsArray,
    ...values: readonly unknown[]
  ) => {
    interpolations = values;
    return Promise.resolve([
      {
        record,
        record_id: record.recordId,
        record_ordinal: "7",
      },
      {
        record: { ...record, recordId: "record-company-two" },
        record_id: "record-company-two",
        record_ordinal: "8",
      },
    ]);
  }) as unknown as postgres.Sql;
  const query = createPostgresDatasetRecordPageQuery(sql, makeDatasets(stored));

  const page = await query.listPage(scope, {
    afterOrdinal: 6,
    datasetId: identifier,
    limit: 1,
    materializationId: materializationIdentifier,
  });

  assert.equal(page?.hasMore, true);
  assert.deepEqual(page?.items, [{ ordinal: 7, record }]);
  assert.equal(page?.dataset, dataset);
  assert.equal(page?.fields, fields);
  assert.equal(page?.materialization, materialization);
  assert.deepEqual(interpolations, [
    workspace,
    identifier,
    materializationIdentifier,
    6,
    2,
  ]);
});

test("fails closed before record I/O when the requested ready snapshot is absent", async () => {
  let calls = 0;
  const sql = (() => {
    calls += 1;
    return Promise.resolve([]);
  }) as unknown as postgres.Sql;
  const query = createPostgresDatasetRecordPageQuery(sql, makeDatasets(stored));

  const page = await query.listPage(scope, {
    afterOrdinal: 0,
    datasetId: identifier,
    limit: 10,
    materializationId: datasetMaterializationId("different-materialization"),
  });

  assert.equal(page, undefined);
  assert.equal(calls, 0);
});

test("rejects a stored ordinal that cannot be represented safely", async () => {
  const sql = (() =>
    Promise.resolve([
      {
        record,
        record_id: record.recordId,
        record_ordinal: String(Number.MAX_SAFE_INTEGER + 1),
      },
    ])) as unknown as postgres.Sql;
  const query = createPostgresDatasetRecordPageQuery(sql, makeDatasets(stored));

  await assert.rejects(
    query.listPage(scope, {
      afterOrdinal: 0,
      datasetId: identifier,
      limit: 10,
      materializationId: materializationIdentifier,
    }),
    DatabasePayloadError
  );
});
