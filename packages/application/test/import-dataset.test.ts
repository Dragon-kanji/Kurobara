import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  actorId,
  contentHash,
  type Record as DomainRecord,
  datasetId,
  type Field,
  fieldId,
  recordId,
  workspaceId,
} from "@kurobara/kernel";
import type {
  DatasetCodecPort,
  DatasetDecodeEvent,
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

import { makeImportDataset } from "../src/index.ts";

const workspace = workspaceId("workspace-dataset-import");
const actor = {
  actorId: actorId("actor-dataset-import"),
  authenticationMode: "api-key",
  credentialId: "credential-dataset-import",
  permissions: ["datasets:import"],
  workspaceId: workspace,
} as const;
const emptySourceContentHash = contentHash(
  "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
);
const SYNTHETIC_DRAIN_FAILURE = /synthetic-drain-failure/u;
const dataset = {
  datasetId: datasetId("dataset-import"),
  name: "Synthetic organizations",
  workspaceId: workspace,
} as const;
const fields = [
  {
    datasetId: dataset.datasetId,
    fieldId: fieldId("field-domain"),
    key: "domain",
    label: "Domain",
    valueType: "string",
    workspaceId: workspace,
  },
  {
    datasetId: dataset.datasetId,
    fieldId: fieldId("field-score"),
    key: "score",
    label: "Score",
    valueType: "number",
    workspaceId: workspace,
  },
] as const satisfies readonly Field[];

const progress = (
  overrides: Partial<DatasetImportProgress> = {}
): DatasetImportProgress => ({
  batchCount: 0,
  datasetId: dataset.datasetId,
  errorCount: 0,
  importId: "import-synthetic",
  itemCount: 0,
  recordCount: 0,
  state: "running",
  workspaceId: workspace,
  ...overrides,
});

const emptyAsyncIterable = <Value>(): AsyncIterable<Value> => ({
  [Symbol.asyncIterator]: () => ({
    next: () => Promise.resolve({ done: true, value: undefined }),
  }),
});

class FakeDatasetPersistence implements DatasetPersistencePort {
  readonly batches: DatasetImportBatch[] = [];
  beginCalls = 0;
  completion: DatasetImportCompletion | undefined;
  conflictSequence: number | undefined;
  current = progress();
  resetBatchCount = 0;
  resetCalls = 0;

  appendImportBatch(
    _scope: WorkspaceScope,
    _importId: string,
    batch: DatasetImportBatch
  ): Promise<DatasetImportMutationResult> {
    if (batch.sequence === this.conflictSequence) {
      return Promise.resolve({
        conflict: "batch-content-mismatch",
        status: "conflict",
      });
    }
    this.batches.push(batch);
    const recordCount = batch.items.filter(
      (item) => item.kind === "record"
    ).length;
    const errorCount = batch.items.length - recordCount;
    this.current = progress({
      batchCount: batch.sequence,
      errorCount: this.current.errorCount + errorCount,
      itemCount: this.current.itemCount + batch.items.length,
      recordCount: this.current.recordCount + recordCount,
    });
    return Promise.resolve({ progress: this.current, status: "applied" });
  }

  beginImport(
    _scope: WorkspaceScope,
    _definition: DatasetImportDefinition
  ): Promise<DatasetImportMutationResult> {
    this.beginCalls += 1;
    return Promise.resolve({ progress: this.current, status: "applied" });
  }

  finishImport(
    _scope: WorkspaceScope,
    _importId: string,
    completion: DatasetImportCompletion
  ): Promise<DatasetImportMutationResult> {
    this.completion = completion;
    this.current = progress({ ...this.current, state: completion.state });
    return Promise.resolve({ progress: this.current, status: "applied" });
  }

  getDataset(
    _scope: WorkspaceScope,
    _datasetId: typeof dataset.datasetId
  ): Promise<StoredDataset | undefined> {
    return Promise.resolve(undefined);
  }

  isFieldSetComplete(): Promise<boolean> {
    return Promise.resolve(true);
  }

  resetImport(): Promise<DatasetImportMutationResult> {
    this.resetCalls += 1;
    this.resetBatchCount = this.batches.length;
    this.batches.length = 0;
    this.current = progress();
    return Promise.resolve({ progress: this.current, status: "applied" });
  }

  streamImportIssues(): AsyncIterable<DatasetImportIssue> {
    return emptyAsyncIterable<DatasetImportIssue>();
  }

  streamRecords(): AsyncIterable<DomainRecord> {
    return emptyAsyncIterable<DomainRecord>();
  }
}

const recordEvent = (id: string, score: number | null): DatasetDecodeEvent => ({
  record: {
    datasetId: dataset.datasetId,
    recordId: recordId(id),
    values: [
      { fieldId: fields[0].fieldId, value: `${id}.invalid` },
      { fieldId: fields[1].fieldId, value: score },
    ],
    workspaceId: workspace,
  },
  recordNumber: Number(id.slice(id.lastIndexOf("-") + 1)),
  type: "record",
});

const recordEventWithDomain = (
  id: string,
  domain: string
): DatasetDecodeEvent => ({
  record: {
    datasetId: dataset.datasetId,
    recordId: recordId(id),
    values: [{ fieldId: fields[0].fieldId, value: domain }],
    workspaceId: workspace,
  },
  recordNumber: Number(id.slice(id.lastIndexOf("-") + 1)),
  type: "record",
});

const issueEvent = (recoverable: boolean): DatasetDecodeEvent => ({
  error: {
    code: "invalid-json",
    message: "The JSONL row is not valid JSON.",
    recoverable,
    scope: recoverable ? "record" : "document",
  },
  type: "error",
});

const fakeCodec = (
  events: readonly DatasetDecodeEvent[],
  onPull: () => void = () => undefined
): DatasetCodecPort => ({
  codecVersion: "1.0.0",
  async *decode(input) {
    for await (const _chunk of input.bytes) {
      // The fake consumes the source so source-integrity behavior stays real.
    }
    for (const event of events) {
      await Promise.resolve();
      onPull();
      yield event;
    }
  },
  encode: () => emptyAsyncIterable(),
  format: "jsonl",
});

async function* emptyBytes() {
  await Promise.resolve();
  yield new Uint8Array();
}

async function* sourceBytes(value: string) {
  await Promise.resolve();
  const bytes = new TextEncoder().encode(value);
  for (let offset = 0; offset < bytes.byteLength; offset += 3) {
    yield bytes.slice(offset, offset + 3);
  }
}

const sourceHash = (value: string) =>
  contentHash(
    `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`
  );

const request = () => ({
  actor,
  batchLimits: { maxBytes: 4096, maxItems: 2 },
  bytes: emptyBytes(),
  dataset,
  fields,
  format: "jsonl" as const,
  importId: "import-synthetic",
  maxRecordBytes: 1024,
  sourceContentHash: emptySourceContentHash,
});

test("commits bounded batches and keeps recoverable row issues durable", async () => {
  const persistence = new FakeDatasetPersistence();
  const events = [
    recordEvent("record-1", 1),
    recordEvent("record-2", null),
    issueEvent(true),
    recordEvent("record-4", 4),
    recordEvent("record-5", 5),
  ];
  const importDataset = makeImportDataset({
    codecs: {
      csv: { ...fakeCodec([]), format: "csv" },
      jsonl: fakeCodec(events),
    },
    datasets: persistence,
    requiredPermission: "datasets:import",
  });

  const result = await importDataset(request());

  assert.equal(result.ok, true);
  assert.deepEqual(
    persistence.batches.map((batch) => batch.items.length),
    [2, 2, 1]
  );
  assert.deepEqual(persistence.completion, {
    batchCount: 3,
    itemCount: 5,
    state: "completed",
  });
  assert.deepEqual(
    result.ok ? result.value.progress : undefined,
    progress({
      batchCount: 3,
      errorCount: 1,
      itemCount: 5,
      recordCount: 4,
      state: "completed",
    })
  );
});

test("flushes before the canonical byte bound and replaces an oversized item", async () => {
  const byteBounded = new FakeDatasetPersistence();
  const importByteBounded = makeImportDataset({
    codecs: {
      csv: { ...fakeCodec([]), format: "csv" },
      jsonl: fakeCodec([
        recordEventWithDomain("record-1", "x".repeat(400)),
        recordEventWithDomain("record-2", "y".repeat(400)),
      ]),
    },
    datasets: byteBounded,
    requiredPermission: "datasets:import",
  });
  const byteResult = await importByteBounded({
    ...request(),
    batchLimits: { maxBytes: 1024, maxItems: 100 },
    maxRecordBytes: 1,
  });

  assert.equal(byteResult.ok, true);
  assert.deepEqual(
    byteBounded.batches.map((batch) => batch.items.length),
    [1, 1]
  );

  const oversized = new FakeDatasetPersistence();
  const importOversized = makeImportDataset({
    codecs: {
      csv: { ...fakeCodec([]), format: "csv" },
      jsonl: fakeCodec([
        recordEventWithDomain("record-1", "private".repeat(200)),
        recordEvent("record-2", 2),
      ]),
    },
    datasets: oversized,
    requiredPermission: "datasets:import",
  });
  const oversizedResult = await importOversized({
    ...request(),
    batchLimits: { maxBytes: 1024, maxItems: 100 },
    maxRecordBytes: 1,
  });

  assert.equal(oversizedResult.ok, false);
  assert.equal(
    oversizedResult.ok ? undefined : oversizedResult.error.code,
    "dataset-import-failed"
  );
  const oversizedItem = oversized.batches[0]?.items[0];
  assert.equal(oversizedItem?.kind, "issue");
  if (oversizedItem?.kind === "issue") {
    assert.equal(
      oversizedItem.issue.message,
      "The normalized record exceeds the configured import batch limit."
    );
  }
  assert.equal(JSON.stringify(oversized.batches).includes("private"), false);
  assert.deepEqual(oversized.completion, {
    batchCount: 1,
    itemCount: 1,
    state: "failed",
  });
});

test("stops after an unrecoverable codec issue and marks the import failed", async () => {
  const persistence = new FakeDatasetPersistence();
  let pulls = 0;
  const importDataset = makeImportDataset({
    codecs: {
      csv: { ...fakeCodec([]), format: "csv" },
      jsonl: fakeCodec([issueEvent(false), recordEvent("record-2", 2)], () => {
        pulls += 1;
      }),
    },
    datasets: persistence,
    requiredPermission: "datasets:import",
  });

  const result = await importDataset(request());

  assert.equal(result.ok, false);
  assert.equal(
    result.ok ? undefined : result.error.code,
    "dataset-import-failed"
  );
  assert.equal(pulls, 1);
  assert.deepEqual(persistence.completion, {
    batchCount: 1,
    itemCount: 1,
    state: "failed",
  });
});

test("drains a terminal source before binding its immutable content hash", async () => {
  const terminalCodec: DatasetCodecPort = {
    ...fakeCodec([]),
    async *decode() {
      await Promise.resolve();
      yield issueEvent(false);
    },
  };
  const source = "terminal row with trailing private bytes";
  const matchedPersistence = new FakeDatasetPersistence();
  const matchedImport = makeImportDataset({
    codecs: {
      csv: { ...fakeCodec([]), format: "csv" },
      jsonl: terminalCodec,
    },
    datasets: matchedPersistence,
    requiredPermission: "datasets:import",
  });
  const matched = await matchedImport({
    ...request(),
    bytes: sourceBytes(source),
    sourceContentHash: sourceHash(source),
  });

  assert.equal(matched.ok, false);
  assert.equal(
    matched.ok ? undefined : matched.error.code,
    "dataset-import-failed"
  );
  assert.deepEqual(matchedPersistence.completion, {
    batchCount: 1,
    itemCount: 1,
    state: "failed",
  });

  const mismatchedPersistence = new FakeDatasetPersistence();
  const mismatchedImport = makeImportDataset({
    codecs: {
      csv: { ...fakeCodec([]), format: "csv" },
      jsonl: terminalCodec,
    },
    datasets: mismatchedPersistence,
    requiredPermission: "datasets:import",
  });
  const mismatched = await mismatchedImport({
    ...request(),
    bytes: sourceBytes(source),
    sourceContentHash: sourceHash("another source"),
  });

  assert.equal(mismatched.ok, false);
  assert.equal(
    mismatched.ok ? undefined : mismatched.error.code,
    "dataset-source-mismatch"
  );
  assert.equal(mismatchedPersistence.resetBatchCount, 1);
  assert.equal(mismatchedPersistence.completion, undefined);
});

test("cancels a terminal source when draining its remainder fails", async () => {
  const persistence = new FakeDatasetPersistence();
  let returnCalls = 0;
  const importDataset = makeImportDataset({
    codecs: {
      csv: { ...fakeCodec([]), format: "csv" },
      jsonl: {
        ...fakeCodec([]),
        async *decode() {
          await Promise.resolve();
          yield issueEvent(false);
        },
      },
    },
    datasets: persistence,
    requiredPermission: "datasets:import",
  });
  const failingSource: AsyncIterable<Uint8Array> = {
    [Symbol.asyncIterator]() {
      return {
        next: () => Promise.reject(new Error("synthetic-drain-failure")),
        return: () => {
          returnCalls += 1;
          return Promise.resolve({ done: true, value: undefined });
        },
      };
    },
  };

  await assert.rejects(
    importDataset({ ...request(), bytes: failingSource }),
    SYNTHETIC_DRAIN_FAILURE
  );
  assert.equal(returnCalls, 1);
  assert.equal(persistence.completion, undefined);
});

test("fails closed when a replayed batch diverges", async () => {
  const persistence = new FakeDatasetPersistence();
  persistence.conflictSequence = 1;
  const importDataset = makeImportDataset({
    codecs: {
      csv: { ...fakeCodec([]), format: "csv" },
      jsonl: fakeCodec([
        recordEvent("record-1", 1),
        recordEvent("record-2", 2),
        recordEvent("record-3", 3),
      ]),
    },
    datasets: persistence,
    requiredPermission: "datasets:import",
  });

  const result = await importDataset(request());

  assert.equal(result.ok, false);
  assert.equal(
    result.ok ? undefined : result.error.code,
    "dataset-import-conflict"
  );
  assert.equal(persistence.completion, undefined);
});

test("cancels an unread source when a replayed batch diverges", async () => {
  const persistence = new FakeDatasetPersistence();
  persistence.conflictSequence = 1;
  let returnCalls = 0;
  const importDataset = makeImportDataset({
    codecs: {
      csv: { ...fakeCodec([]), format: "csv" },
      jsonl: {
        ...fakeCodec([]),
        async *decode() {
          await Promise.resolve();
          yield recordEvent("record-1", 1);
          yield recordEvent("record-2", 2);
          yield recordEvent("record-3", 3);
        },
      },
    },
    datasets: persistence,
    requiredPermission: "datasets:import",
  });
  const unreadSource: AsyncIterable<Uint8Array> = {
    [Symbol.asyncIterator]() {
      return {
        next: () =>
          Promise.resolve({ done: false, value: new Uint8Array([1]) }),
        return: () => {
          returnCalls += 1;
          return Promise.resolve({ done: true, value: undefined });
        },
      };
    },
  };

  const result = await importDataset({ ...request(), bytes: unreadSource });

  assert.equal(result.ok, false);
  assert.equal(
    result.ok ? undefined : result.error.code,
    "dataset-import-conflict"
  );
  assert.equal(returnCalls, 1);
});

test("does not complete a cleanly truncated source with another declared hash", async () => {
  const persistence = new FakeDatasetPersistence();
  const importDataset = makeImportDataset({
    codecs: {
      csv: { ...fakeCodec([]), format: "csv" },
      jsonl: fakeCodec([
        recordEvent("record-1", 1),
        recordEvent("record-2", 2),
        recordEvent("record-3", 3),
      ]),
    },
    datasets: persistence,
    requiredPermission: "datasets:import",
  });

  const result = await importDataset({
    ...request(),
    sourceContentHash: contentHash(`sha256:${"a".repeat(64)}`),
  });

  assert.equal(result.ok, false);
  assert.equal(
    result.ok ? undefined : result.error.code,
    "dataset-source-mismatch"
  );
  assert.equal(persistence.batches.length, 0);
  assert.equal(persistence.resetBatchCount, 1);
  assert.equal(persistence.resetCalls, 1);
  assert.equal(persistence.completion, undefined);
});

test("rejects authority and duplicate fields before persistence", async () => {
  const persistence = new FakeDatasetPersistence();
  const importDataset = makeImportDataset({
    codecs: { csv: { ...fakeCodec([]), format: "csv" }, jsonl: fakeCodec([]) },
    datasets: persistence,
    requiredPermission: "datasets:import",
  });
  const denied = await importDataset({
    ...request(),
    actor: { ...actor, permissions: [] },
  });
  const foreignWorkspace = await importDataset({
    ...request(),
    dataset: {
      ...dataset,
      workspaceId: workspaceId("workspace-dataset-import-other"),
    },
  });
  const duplicated = await importDataset({
    ...request(),
    fields: [fields[0], { ...fields[0], fieldId: fieldId("field-other") }],
  });
  const undersizedBatch = await importDataset({
    ...request(),
    batchLimits: { maxBytes: 512, maxItems: 2 },
    maxRecordBytes: 1,
  });
  const oversizedFields = await importDataset({
    ...request(),
    fields: Array.from({ length: 257 }, (_value, index) => ({
      ...fields[0],
      fieldId: fieldId(`field-${index}`),
      key: `field_${index}`,
    })),
  });

  assert.equal(
    denied.ok ? undefined : denied.error.code,
    "authority-permission-missing"
  );
  assert.equal(
    foreignWorkspace.ok ? undefined : foreignWorkspace.error.code,
    "authority-subject-mismatch"
  );
  assert.equal(
    duplicated.ok ? undefined : duplicated.error.code,
    "request-invalid"
  );
  assert.equal(
    undersizedBatch.ok ? undefined : undersizedBatch.error.code,
    "request-invalid"
  );
  assert.equal(
    oversizedFields.ok ? undefined : oversizedFields.error.code,
    "request-invalid"
  );
  assert.equal(persistence.beginCalls, 0);
});
