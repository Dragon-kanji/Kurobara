import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { after, before, test } from "node:test";
import {
  createCsvDatasetCodec,
  createJsonlDatasetCodec,
} from "@kurobara/adapter-dataset-codec";
import {
  createPostgresRuntime,
  type PostgresRuntime,
} from "@kurobara/adapter-postgres";
import { makeExportDataset, makeImportDataset } from "@kurobara/application";
import {
  actorId,
  contentHash,
  createDataset,
  createField,
  createRecord,
  datasetId,
  type Field,
  fieldId,
  recordId,
  type WorkspaceId,
  workspaceId,
} from "@kurobara/kernel";
import type {
  DatasetEncodeEvent,
  DatasetImportIssue,
  VerifiedApiKey,
} from "@kurobara/ports";
import postgres from "postgres";

const adminUrl = process.env.KUROBARA_TEST_POSTGRES_URL;
if (adminUrl === undefined || adminUrl.trim().length === 0) {
  throw new Error(
    "KUROBARA_TEST_POSTGRES_URL must target a disposable-capable PostgreSQL admin database."
  );
}

const databaseName = `kurobara_dataset_${process.pid}_${Date.now()}`;
const SOURCE_INTERRUPTION = /synthetic-source-interruption/u;
const TERMINAL_CHILD_CHANGE_REJECTED =
  /terminal dataset import child rows are immutable/u;
const databaseUrl = new URL(adminUrl);
databaseUrl.pathname = `/${databaseName}`;
const admin = postgres(adminUrl, { max: 1 });
let runtime: PostgresRuntime;
let databaseSql: ReturnType<typeof postgres>;

before(async () => {
  await admin`CREATE DATABASE ${admin(databaseName)}`;
  runtime = createPostgresRuntime(databaseUrl.toString());
  await runtime.migrate();
  await runtime.verifyMigrations();
  databaseSql = postgres(databaseUrl.toString(), { max: 1 });
});

after(async () => {
  if (databaseSql !== undefined) {
    await databaseSql.end({ timeout: 5 });
  }
  if (runtime !== undefined) {
    await runtime.close();
  }
  await admin`DROP DATABASE IF EXISTS ${admin(databaseName)} WITH (FORCE)`;
  await admin.end({ timeout: 5 });
});

const codecs = {
  csv: createCsvDatasetCodec(),
  jsonl: createJsonlDatasetCodec(),
} as const;

const bytesOf = (value: string): AsyncIterable<Uint8Array> => ({
  async *[Symbol.asyncIterator]() {
    await Promise.resolve();
    const bytes = new TextEncoder().encode(value);
    for (let offset = 0; offset < bytes.byteLength; offset += 7) {
      yield bytes.slice(offset, offset + 7);
    }
  },
});

const interruptedBytesOf = (value: string): AsyncIterable<Uint8Array> => ({
  async *[Symbol.asyncIterator]() {
    await Promise.resolve();
    yield new TextEncoder().encode(value);
    throw new Error("synthetic-source-interruption");
  },
});

const testContentHash = (value: unknown) =>
  contentHash(
    `sha256:${createHash("sha256")
      .update(JSON.stringify(value), "utf8")
      .digest("hex")}`
  );

const sourceContentHash = (value: string) =>
  contentHash(
    `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`
  );

const definition = (workspace: WorkspaceId) => {
  const createdDataset = createDataset({
    datasetId: datasetId("dataset-shared"),
    name: "Synthetic organizations",
    workspaceId: workspace,
  });
  if (!createdDataset.ok) {
    throw new Error("Dataset integration fixture is invalid.");
  }
  const makeField = (
    id: string,
    key: string,
    valueType: Field["valueType"]
  ): Field => {
    const created = createField(createdDataset.value, {
      datasetId: createdDataset.value.datasetId,
      fieldId: fieldId(id),
      key,
      label: key,
      valueType,
      workspaceId: workspace,
    });
    if (!created.ok) {
      throw new Error("Field integration fixture is invalid.");
    }
    return created.value;
  };
  return {
    dataset: createdDataset.value,
    fields: [
      makeField("field-name", "name", "string"),
      makeField("field-score", "score", "number"),
    ] as const,
  };
};

const recordLine = (
  workspace: WorkspaceId,
  recordIdentifier: string,
  values: readonly Readonly<{ field_id: string; value: unknown }>[]
): string =>
  JSON.stringify({
    dataset_id: "dataset-shared",
    record_id: recordIdentifier,
    values,
    workspace_id: workspace,
  });

const source = (workspace: WorkspaceId, secondName = "two"): string =>
  [
    recordLine(workspace, "record-1", [
      { field_id: "field-name", value: null },
      { field_id: "field-score", value: 1 },
    ]),
    "{private payload",
    recordLine(workspace, "record-2", [
      { field_id: "field-name", value: secondName },
    ]),
    recordLine(workspace, "record-1", [
      { field_id: "field-name", value: "duplicate-private-value" },
      { field_id: "field-score", value: 2 },
    ]),
  ].join("\n");

const bootstrapWorkspace = async (workspace: WorkspaceId): Promise<void> => {
  await runtime.bootstrapApiKey({
    actorId: actorId(`actor-${workspace}`),
    label: "Dataset integration",
    permissions: ["datasets:import", "datasets:export"],
    workspaceId: workspace,
  });
};

const actorFor = (workspace: WorkspaceId): VerifiedApiKey => ({
  actorId: actorId(`actor-${workspace}`),
  authenticationMode: "api-key",
  credentialId: `credential-${workspace}`,
  permissions: ["datasets:import", "datasets:export"],
  workspaceId: workspace,
});

const importDatasetFromBytes = (
  workspace: WorkspaceId,
  bytes: AsyncIterable<Uint8Array>,
  expectedSourceContentHash: ReturnType<typeof sourceContentHash>
) => {
  const product = definition(workspace);
  return makeImportDataset({
    codecs,
    datasets: runtime.datasets,
    requiredPermission: "datasets:import",
  })({
    actor: actorFor(workspace),
    batchLimits: { maxBytes: 16_384, maxItems: 2 },
    bytes,
    dataset: product.dataset,
    fields: product.fields,
    format: "jsonl",
    importId: "import-shared",
    maxRecordBytes: 4096,
    sourceContentHash: expectedSourceContentHash,
  });
};

const importDataset = (workspace: WorkspaceId, input: string) =>
  importDatasetFromBytes(workspace, bytesOf(input), sourceContentHash(input));

const collect = async <Value>(
  values: AsyncIterable<Value>
): Promise<readonly Value[]> => {
  const result: Value[] = [];
  for await (const value of values) {
    result.push(value);
  }
  return result;
};

const encodedText = async (
  events: AsyncIterable<DatasetEncodeEvent>
): Promise<string> => {
  const chunks: Uint8Array[] = [];
  for await (const event of events) {
    if (event.type !== "chunk") {
      throw new Error(`Unexpected export issue: ${event.error.code}`);
    }
    chunks.push(event.bytes);
  }
  const size = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
  const joined = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(joined);
};

test("persists, replays and exports a tenant-scoped dataset import", async () => {
  const workspaceA = workspaceId("workspace-dataset-a");
  const workspaceB = workspaceId("workspace-dataset-b");
  const isolatedWorkspace = workspaceId("workspace-dataset-isolated");
  await bootstrapWorkspace(workspaceA);
  await bootstrapWorkspace(workspaceB);

  const interruptedPrefix = `${source(workspaceA)
    .split("\n")
    .slice(0, 3)
    .join("\n")}\n`;
  await assert.rejects(
    importDatasetFromBytes(
      workspaceA,
      interruptedBytesOf(interruptedPrefix),
      sourceContentHash(source(workspaceA))
    ),
    SOURCE_INTERRUPTION
  );
  const interrupted = await runtime.datasets.getDataset(
    { workspaceId: workspaceA },
    datasetId("dataset-shared")
  );
  assert.deepEqual(interrupted?.import, {
    batchCount: 1,
    datasetId: datasetId("dataset-shared"),
    errorCount: 1,
    importId: "import-shared",
    itemCount: 2,
    recordCount: 1,
    state: "running",
    workspaceId: workspaceA,
  });

  const product = definition(workspaceA);
  const oversizedRecord = createRecord(product.dataset, product.fields, {
    datasetId: product.dataset.datasetId,
    recordId: recordId("record-oversized-normalized"),
    values: [{ fieldId: fieldId("field-name"), value: "x".repeat(16_384) }],
    workspaceId: workspaceA,
  });
  if (!oversizedRecord.ok) {
    throw new Error(oversizedRecord.error.message);
  }
  const oversizedHashable = {
    itemNumber: 3,
    kind: "record" as const,
    record: oversizedRecord.value,
    recordNumber: 3,
  };
  const oversizedAppend = await runtime.datasets.appendImportBatch(
    { workspaceId: workspaceA },
    "import-shared",
    {
      contentHash: testContentHash([oversizedHashable]),
      items: [
        {
          contentHash: testContentHash(oversizedRecord.value),
          ...oversizedHashable,
        },
      ],
      sequence: 2,
    }
  );
  assert.deepEqual(oversizedAppend, {
    conflict: "batch-content-mismatch",
    status: "conflict",
  });

  const firstBatchOnly = `${source(workspaceA)
    .split("\n")
    .slice(0, 2)
    .join("\n")}\n`;
  const truncatedRetry = await importDatasetFromBytes(
    workspaceA,
    bytesOf(firstBatchOnly),
    sourceContentHash(source(workspaceA))
  );
  if (truncatedRetry.ok) {
    throw new Error("The truncated source retry unexpectedly completed.");
  }
  assert.equal(truncatedRetry.error.code, "dataset-source-mismatch");
  const resetDataset = await runtime.datasets.getDataset(
    { workspaceId: workspaceA },
    datasetId("dataset-shared")
  );
  assert.deepEqual(resetDataset?.import, {
    batchCount: 0,
    datasetId: datasetId("dataset-shared"),
    errorCount: 0,
    importId: "import-shared",
    itemCount: 0,
    recordCount: 0,
    state: "running",
    workspaceId: workspaceA,
  });
  const provisionalRows = await databaseSql<
    readonly {
      batch_count: string;
      issue_count: string;
      record_count: string;
    }[]
  >`
    SELECT
      (
        SELECT count(*)::text
        FROM kurobara_core.dataset_import_batches
        WHERE workspace_id = ${workspaceA}
          AND import_id = 'import-shared'
      ) AS batch_count,
      (
        SELECT count(*)::text
        FROM kurobara_core.dataset_import_issues
        WHERE workspace_id = ${workspaceA}
          AND import_id = 'import-shared'
      ) AS issue_count,
      (
        SELECT count(*)::text
        FROM kurobara_core.dataset_records
        WHERE workspace_id = ${workspaceA}
          AND import_id = 'import-shared'
      ) AS record_count
  `;
  assert.deepEqual(provisionalRows[0], {
    batch_count: "0",
    issue_count: "0",
    record_count: "0",
  });

  const first = await importDataset(workspaceA, source(workspaceA));
  if (!first.ok) {
    throw new Error(first.error.message);
  }
  assert.deepEqual(first.value.progress, {
    batchCount: 2,
    datasetId: datasetId("dataset-shared"),
    errorCount: 2,
    importId: "import-shared",
    itemCount: 4,
    recordCount: 2,
    state: "completed",
    workspaceId: workspaceA,
  });
  assert.equal(first.value.replayed, true);

  assert.deepEqual(
    await runtime.datasets.resetImport(
      { workspaceId: workspaceA },
      "import-shared",
      sourceContentHash(source(workspaceA))
    ),
    { conflict: "import-state-conflict", status: "conflict" }
  );
  await assert.rejects(
    databaseSql`
      DELETE FROM kurobara_core.dataset_records
      WHERE workspace_id = ${workspaceA}
        AND dataset_id = 'dataset-shared'
        AND record_id = 'record-1'
    `,
    TERMINAL_CHILD_CHANGE_REJECTED
  );
  await assert.rejects(
    databaseSql`
      INSERT INTO kurobara_core.dataset_import_batches (
        workspace_id,
        import_id,
        sequence,
        content_hash,
        item_count
      ) VALUES (
        ${workspaceA},
        'import-shared',
        3,
        ${`sha256:${"c".repeat(64)}`},
        1
      )
    `,
    TERMINAL_CHILD_CHANGE_REJECTED
  );
  await assert.rejects(
    databaseSql`
      INSERT INTO kurobara_core.dataset_records (
        workspace_id,
        dataset_id,
        record_id,
        import_id,
        batch_sequence,
        item_number,
        record_number,
        content_hash,
        record
      ) VALUES (
        ${workspaceA},
        'dataset-shared',
        'record-terminal-insert',
        'import-shared',
        2,
        5,
        5,
        ${`sha256:${"d".repeat(64)}`},
        ${databaseSql.json({
          datasetId: "dataset-shared",
          recordId: "record-terminal-insert",
          values: [],
          workspaceId: workspaceA,
        })}
      )
    `,
    TERMINAL_CHILD_CHANGE_REJECTED
  );
  await assert.rejects(
    databaseSql`
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
        issue_scope
      ) VALUES (
        ${workspaceA},
        'import-shared',
        'dataset-shared',
        2,
        5,
        ${`sha256:${"e".repeat(64)}`},
        'invalid-json',
        'Synthetic terminal insert.',
        true,
        'record'
      )
    `,
    TERMINAL_CHILD_CHANGE_REJECTED
  );

  const issues = await collect<DatasetImportIssue>(
    runtime.datasets.streamImportIssues(
      { workspaceId: workspaceA },
      datasetId("dataset-shared")
    )
  );
  assert.deepEqual(
    issues.map((issue) => issue.code),
    ["invalid-json", "record-id-conflict"]
  );
  assert.equal(JSON.stringify(issues).includes("private payload"), false);
  assert.equal(
    JSON.stringify(issues).includes("duplicate-private-value"),
    false
  );

  const records = await collect(
    runtime.datasets.streamRecords(
      { workspaceId: workspaceA },
      datasetId("dataset-shared")
    )
  );
  assert.deepEqual(
    records.map((record) => ({ id: record.recordId, values: record.values })),
    [
      {
        id: "record-1",
        values: [
          { fieldId: fieldId("field-name"), value: null },
          { fieldId: fieldId("field-score"), value: 1 },
        ],
      },
      {
        id: "record-2",
        values: [{ fieldId: fieldId("field-name"), value: "two" }],
      },
    ]
  );

  const replay = await importDataset(workspaceA, source(workspaceA));
  assert.equal(replay.ok, true);
  if (replay.ok) {
    assert.equal(replay.value.replayed, true);
    assert.deepEqual(replay.value.progress, first.value.progress);
  }
  assert.equal(
    (
      await collect(
        runtime.datasets.streamRecords(
          { workspaceId: workspaceA },
          datasetId("dataset-shared")
        )
      )
    ).length,
    2
  );

  const modifiedReplay = await importDataset(
    workspaceA,
    source(workspaceA, "changed")
  );
  assert.equal(modifiedReplay.ok, false);
  if (!modifiedReplay.ok) {
    assert.equal(modifiedReplay.error.code, "dataset-import-conflict");
  }
  assert.equal(
    (
      await runtime.datasets.getDataset(
        { workspaceId: workspaceA },
        datasetId("dataset-shared")
      )
    )?.import.itemCount,
    4
  );

  const otherTenant = await importDataset(workspaceB, source(workspaceB));
  assert.equal(otherTenant.ok, true);
  assert.equal(
    (
      await collect(
        runtime.datasets.streamRecords(
          { workspaceId: workspaceB },
          datasetId("dataset-shared")
        )
      )
    ).length,
    2
  );
  assert.equal(
    await runtime.datasets.getDataset(
      { workspaceId: isolatedWorkspace },
      datasetId("dataset-shared")
    ),
    undefined
  );
  assert.deepEqual(
    await collect(
      runtime.datasets.streamRecords(
        { workspaceId: isolatedWorkspace },
        datasetId("dataset-shared")
      )
    ),
    []
  );

  const exporter = makeExportDataset({
    codecs,
    contactPrivacy: {
      guard: {
        allows: () =>
          Promise.reject(
            new Error(
              "An imported non-Contact dataset must not invoke the Contact privacy guard."
            )
          ),
      },
      requiredPermission: "contacts:export",
      subjects: runtime.contactDatasetExportPrivacy,
    },
    datasets: runtime.datasets,
    requiredPermission: "datasets:export",
  });
  const jsonl = await exporter({
    actor: actorFor(workspaceA),
    datasetId: datasetId("dataset-shared"),
    format: "jsonl",
    maxRecordBytes: 4096,
  });
  if (!jsonl.ok) {
    throw new Error(jsonl.error.message);
  }
  const firstJsonl = await encodedText(jsonl.value.events);
  const secondJsonlResult = await exporter({
    actor: actorFor(workspaceA),
    datasetId: datasetId("dataset-shared"),
    format: "jsonl",
    maxRecordBytes: 4096,
  });
  if (!secondJsonlResult.ok) {
    throw new Error(secondJsonlResult.error.message);
  }
  assert.equal(await encodedText(secondJsonlResult.value.events), firstJsonl);
  assert.equal(
    firstJsonl.includes('"field_id":"field-score","value":null'),
    false
  );
  assert.equal(
    firstJsonl.includes('"field_id":"field-name","value":null'),
    true
  );

  const sparseCsv = await exporter({
    actor: actorFor(workspaceA),
    datasetId: datasetId("dataset-shared"),
    format: "csv",
    maxRecordBytes: 4096,
  });
  assert.equal(sparseCsv.ok, false);
  if (!sparseCsv.ok) {
    assert.equal(sparseCsv.error.code, "sparse-csv-unsupported");
  }

  const selectedCsv = await exporter({
    actor: actorFor(workspaceA),
    datasetId: datasetId("dataset-shared"),
    fieldIds: [fieldId("field-name")],
    format: "csv",
    maxRecordBytes: 4096,
  });
  if (!selectedCsv.ok) {
    throw new Error(selectedCsv.error.message);
  }
  assert.equal(
    await encodedText(selectedCsv.value.events),
    "record_id,name\r\nrecord-1,\r\nrecord-2,two\r\n"
  );
});
