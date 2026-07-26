import { createHash } from "node:crypto";

import {
  type ContentHash,
  contentHash,
  createDataset,
  createRecord,
  type Dataset,
  type Record as DomainRecord,
  type DomainResult,
  type Field,
  fail,
  fieldId,
  InvalidValueObjectError,
  recordId,
  succeed,
  validateDatasetFields,
} from "@kurobara/kernel";
import type {
  DatasetCodecError,
  DatasetCodecPort,
  DatasetDecodeEvent,
  DatasetImportBatch,
  DatasetImportBatchLimits,
  DatasetImportFormat,
  DatasetImportIssue,
  DatasetImportItem,
  DatasetImportProgress,
  DatasetPersistencePort,
  DatasetRecord,
  VerifiedApiKey,
  WorkspaceScope,
} from "@kurobara/ports";

import {
  canonicalContentByteSize,
  canonicalContentHash,
} from "./canonical-content-hash.ts";

const MAX_BATCH_BYTES = 67_108_864;
const MAX_BATCH_ITEMS = 1000;
const MAX_IMPORT_ID_LENGTH = 255;
const MAX_RECORD_BYTES = 16_777_216;
const MIN_BATCH_BYTES = 1024;

export type ImportDatasetRequest = Readonly<{
  actor: VerifiedApiKey;
  batchLimits: DatasetImportBatchLimits;
  bytes: AsyncIterable<Uint8Array>;
  dataset: Dataset;
  fields: readonly Field[];
  format: DatasetImportFormat;
  importId: string;
  maxRecordBytes: number;
  sourceContentHash: string;
}>;

export type ImportDatasetFailureCode =
  | "authority-permission-missing"
  | "authority-subject-mismatch"
  | "dataset-import-conflict"
  | "dataset-import-failed"
  | "dataset-source-mismatch"
  | "request-invalid";

export type ImportDatasetFailure = Readonly<{
  code: ImportDatasetFailureCode;
  message: string;
  progress?: DatasetImportProgress;
}>;

export type ImportDatasetSuccess = Readonly<{
  progress: DatasetImportProgress;
  replayed: boolean;
}>;

export type ImportDatasetDependencies = Readonly<{
  codecs: Readonly<Record<DatasetImportFormat, DatasetCodecPort>>;
  datasets: DatasetPersistencePort;
  requiredPermission: string;
}>;

const codePointLength = (value: string): number => [...value].length;

const validLimits = (
  maxRecordBytes: number,
  limits: DatasetImportBatchLimits
): boolean =>
  Number.isSafeInteger(maxRecordBytes) &&
  maxRecordBytes >= 1 &&
  maxRecordBytes <= MAX_RECORD_BYTES &&
  Number.isSafeInteger(limits.maxItems) &&
  limits.maxItems >= 1 &&
  limits.maxItems <= MAX_BATCH_ITEMS &&
  Number.isSafeInteger(limits.maxBytes) &&
  limits.maxBytes >= Math.max(maxRecordBytes, MIN_BATCH_BYTES) &&
  limits.maxBytes <= MAX_BATCH_BYTES;

const importIssue = (error: DatasetCodecError): DatasetImportIssue => ({
  code: error.code,
  message: error.message,
  recoverable: error.recoverable,
  scope: error.scope,
  ...(error.fieldKey === undefined ? {} : { fieldKey: error.fieldKey }),
  ...(error.lineEnd === undefined ? {} : { lineEnd: error.lineEnd }),
  ...(error.lineStart === undefined ? {} : { lineStart: error.lineStart }),
  ...(error.recordId === undefined ? {} : { recordId: error.recordId }),
  ...(error.recordNumber === undefined
    ? {}
    : { recordNumber: error.recordNumber }),
});

const invalidDomainRecordIssue = (): DatasetImportIssue => ({
  code: "record-domain-invalid",
  message: "The decoded record violates the canonical dataset invariants.",
  recoverable: false,
  scope: "record",
});

const oversizedBatchItemIssue = (): DatasetImportIssue => ({
  code: "record-domain-invalid",
  message: "The normalized record exceeds the configured import batch limit.",
  recoverable: false,
  scope: "record",
});

const domainRecord = (
  dataset: Dataset,
  fields: readonly Field[],
  candidate: DatasetRecord
): DomainResult<DomainRecord, DatasetImportIssue> => {
  try {
    const created = createRecord(dataset, fields, {
      datasetId: dataset.datasetId,
      recordId: recordId(candidate.recordId),
      values: candidate.values.map((entry) => ({
        fieldId: fieldId(entry.fieldId),
        value: entry.value,
      })),
      workspaceId: dataset.workspaceId,
    });
    return created.ok ? created : fail(invalidDomainRecordIssue());
  } catch (error) {
    if (error instanceof InvalidValueObjectError) {
      return fail(invalidDomainRecordIssue());
    }
    throw error;
  }
};

const hashableItem = (item: DatasetImportItem): unknown =>
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

type PreparedImport = Readonly<{
  codec: DatasetCodecPort;
  dataset: Dataset;
  fields: readonly Field[];
  intentHash: ReturnType<typeof canonicalContentHash>;
  schemaHash: ReturnType<typeof canonicalContentHash>;
  scope: WorkspaceScope;
  sourceContentHash: ContentHash;
}>;

const invalidRequest = (message: string): ImportDatasetFailure => ({
  code: "request-invalid",
  message,
});

const prepareImport = (
  dependencies: ImportDatasetDependencies,
  request: ImportDatasetRequest
): DomainResult<PreparedImport, ImportDatasetFailure> => {
  if (
    request.importId.trim().length === 0 ||
    codePointLength(request.importId) > MAX_IMPORT_ID_LENGTH ||
    !validLimits(request.maxRecordBytes, request.batchLimits)
  ) {
    return fail(
      invalidRequest(
        "The dataset import request contains invalid bounded limits or identity."
      )
    );
  }
  let sourceContentHash: ContentHash;
  try {
    sourceContentHash = contentHash(request.sourceContentHash);
  } catch (error) {
    if (error instanceof InvalidValueObjectError) {
      return fail(
        invalidRequest(
          "The dataset import request contains an invalid source content hash."
        )
      );
    }
    throw error;
  }
  const createdDataset = createDataset(request.dataset);
  if (!createdDataset.ok) {
    return fail(
      invalidRequest("The dataset import request contains an invalid dataset.")
    );
  }
  if (createdDataset.value.workspaceId !== request.actor.workspaceId) {
    return fail({
      code: "authority-subject-mismatch",
      message:
        "The authenticated actor cannot import a dataset in another workspace.",
    });
  }
  const validatedFields = validateDatasetFields(
    createdDataset.value,
    request.fields
  );
  if (!validatedFields.ok) {
    return fail(
      invalidRequest(
        "The dataset import request contains an invalid field collection."
      )
    );
  }
  const codec = dependencies.codecs[request.format];
  if (codec.format !== request.format) {
    return fail(
      invalidRequest(
        "The selected dataset codec does not match the requested format."
      )
    );
  }
  const schemaHash = canonicalContentHash({
    dataset: createdDataset.value,
    fields: validatedFields.value,
  });
  return succeed({
    codec,
    dataset: createdDataset.value,
    fields: validatedFields.value,
    intentHash: canonicalContentHash({
      batchLimits: request.batchLimits,
      codecVersion: codec.codecVersion,
      format: codec.format,
      importId: request.importId,
      maxRecordBytes: request.maxRecordBytes,
      schemaHash,
      sourceContentHash,
    }),
    schemaHash,
    scope: { workspaceId: request.actor.workspaceId },
    sourceContentHash,
  });
};

const eventItem = (
  event: DatasetDecodeEvent,
  itemNumber: number,
  dataset: Dataset,
  fields: readonly Field[]
): DatasetImportItem => {
  if (event.type === "error") {
    const issue = importIssue(event.error);
    return {
      contentHash: canonicalContentHash(issue),
      issue,
      itemNumber,
      kind: "issue",
    };
  }
  const created = domainRecord(dataset, fields, event.record);
  if (!created.ok) {
    return {
      contentHash: canonicalContentHash(created.error),
      issue: created.error,
      itemNumber,
      kind: "issue",
    };
  }
  return {
    contentHash: canonicalContentHash(created.value),
    itemNumber,
    kind: "record",
    record: created.value,
    recordNumber: event.recordNumber,
  };
};

const boundedItem = (
  item: DatasetImportItem,
  maxBytes: number
): Readonly<{ bytes: number; item: DatasetImportItem }> => {
  const bytes = canonicalContentByteSize(hashableItem(item));
  if (bytes <= maxBytes) {
    return { bytes, item };
  }
  const issue = oversizedBatchItemIssue();
  const replacement: DatasetImportItem = {
    contentHash: canonicalContentHash(issue),
    issue,
    itemNumber: item.itemNumber,
    kind: "issue",
  };
  return {
    bytes: canonicalContentByteSize(hashableItem(replacement)),
    item: replacement,
  };
};

type BatchWriter = Readonly<{
  add(item: DatasetImportItem): Promise<boolean>;
  flush(): Promise<boolean>;
  progress(): DatasetImportProgress;
  replayed(): boolean;
  sequence(): number;
}>;

const makeBatchWriter = (
  datasets: DatasetPersistencePort,
  scope: WorkspaceScope,
  importId: string,
  limits: DatasetImportBatchLimits,
  initialProgress: DatasetImportProgress,
  initiallyReplayed: boolean
): BatchWriter => {
  let batchBytes = 0;
  let batchItems: DatasetImportItem[] = [];
  let batchSequence = 0;
  let currentProgress = initialProgress;
  let wasReplayed = initiallyReplayed;

  const flush = async (): Promise<boolean> => {
    if (batchItems.length === 0) {
      return true;
    }
    batchSequence += 1;
    const batch: DatasetImportBatch = {
      contentHash: canonicalContentHash(
        batchItems.map((item) => hashableItem(item))
      ),
      items: batchItems,
      sequence: batchSequence,
    };
    const appended = await datasets.appendImportBatch(scope, importId, batch);
    batchItems = [];
    batchBytes = 0;
    if (appended.status === "conflict") {
      return false;
    }
    wasReplayed ||= appended.status === "unchanged";
    currentProgress = appended.progress;
    return true;
  };

  return {
    add: async (candidate) => {
      const bytes = canonicalContentByteSize(hashableItem(candidate));
      const full =
        batchItems.length > 0 &&
        (batchItems.length >= limits.maxItems ||
          batchBytes + bytes > limits.maxBytes);
      if (full && !(await flush())) {
        return false;
      }
      batchItems.push(candidate);
      batchBytes += bytes;
      return true;
    },
    flush,
    progress: () => currentProgress,
    replayed: () => wasReplayed,
    sequence: () => batchSequence,
  };
};

type ConsumedImport = Readonly<{
  itemCount: number;
  terminalIssue: boolean;
}>;

type ObservedSource = Readonly<{
  bytes: AsyncIterable<Uint8Array>;
  cancel(): Promise<void>;
  contentHash(): ContentHash | undefined;
  drain(): Promise<void>;
}>;

const observeSource = (source: AsyncIterable<Uint8Array>): ObservedSource => {
  const digest = createHash("sha256");
  const sourceIterator = source[Symbol.asyncIterator]();
  let bytesClaimed = false;
  let cancelled = false;
  let completed = false;
  let finalized: ContentHash | undefined;
  const next = async (): Promise<IteratorResult<Uint8Array>> => {
    if (cancelled || completed) {
      return { done: true, value: undefined };
    }
    const result = await sourceIterator.next();
    if (result.done) {
      completed = true;
      return { done: true, value: undefined };
    }
    digest.update(result.value);
    return { done: false, value: result.value };
  };
  return {
    bytes: {
      [Symbol.asyncIterator]() {
        if (bytesClaimed) {
          throw new Error("The observed dataset source can only be read once.");
        }
        bytesClaimed = true;
        let released = false;
        return {
          next: () =>
            released
              ? Promise.resolve({ done: true, value: undefined })
              : next(),
          return: () => {
            released = true;
            return Promise.resolve({ done: true, value: undefined });
          },
        };
      },
    },
    cancel: async () => {
      if (cancelled || completed) {
        return;
      }
      cancelled = true;
      await sourceIterator.return?.();
    },
    contentHash: () => {
      if (!completed) {
        return;
      }
      finalized ??= contentHash(`sha256:${digest.digest("hex")}`);
      return finalized;
    },
    drain: async () => {
      while (!(await next()).done) {
        // Hash the remaining source without retaining its bytes.
      }
    },
  };
};

const consumeImportEvents = async (
  request: ImportDatasetRequest,
  prepared: PreparedImport,
  writer: BatchWriter,
  bytes: AsyncIterable<Uint8Array>
): Promise<DomainResult<ConsumedImport, ImportDatasetFailure>> => {
  const fields = prepared.fields.map((field) => ({
    fieldId: field.fieldId,
    key: field.key,
    valueType: field.valueType,
  }));
  let itemNumber = 0;
  let terminalIssue = false;
  for await (const event of prepared.codec.decode({
    bytes,
    datasetId: prepared.dataset.datasetId,
    fields,
    maxRecordBytes: request.maxRecordBytes,
    workspaceId: prepared.dataset.workspaceId,
  })) {
    itemNumber += 1;
    const item = boundedItem(
      eventItem(event, itemNumber, prepared.dataset, prepared.fields),
      request.batchLimits.maxBytes
    ).item;
    if (!(await writer.add(item))) {
      return fail({
        code: "dataset-import-conflict",
        message: "The replayed dataset import diverges from durable input.",
        progress: writer.progress(),
      });
    }
    terminalIssue = item.kind === "issue" && !item.issue.recoverable;
    if (terminalIssue) {
      if (!(await writer.flush())) {
        return fail({
          code: "dataset-import-conflict",
          message: "The replayed dataset import diverges from durable input.",
          progress: writer.progress(),
        });
      }
      break;
    }
  }
  return succeed({ itemCount: itemNumber, terminalIssue });
};

const finishConsumedImport = async (
  dependencies: ImportDatasetDependencies,
  request: ImportDatasetRequest,
  prepared: PreparedImport,
  writer: BatchWriter,
  observedSource: ObservedSource,
  consumed: ConsumedImport
): Promise<DomainResult<ImportDatasetSuccess, ImportDatasetFailure>> => {
  if (consumed.terminalIssue) {
    await observedSource.drain();
  }
  if (observedSource.contentHash() !== prepared.sourceContentHash) {
    const reset = await dependencies.datasets.resetImport(
      prepared.scope,
      request.importId,
      prepared.sourceContentHash
    );
    if (reset.status === "conflict") {
      return fail({
        code: "dataset-import-conflict",
        message: "The divergent dataset import could not be reset safely.",
        progress: writer.progress(),
      });
    }
    return fail({
      code: "dataset-source-mismatch",
      message: "The dataset source does not match its immutable content hash.",
      progress: reset.progress,
    });
  }
  if (!(consumed.terminalIssue || (await writer.flush()))) {
    return fail({
      code: "dataset-import-conflict",
      message: "The replayed dataset import diverges from durable input.",
      progress: writer.progress(),
    });
  }

  const finished = await dependencies.datasets.finishImport(
    prepared.scope,
    request.importId,
    {
      batchCount: writer.sequence(),
      itemCount: consumed.itemCount,
      state: consumed.terminalIssue ? "failed" : "completed",
    }
  );
  if (finished.status === "conflict") {
    return fail({
      code: "dataset-import-conflict",
      message: "The replayed dataset completion diverges from durable input.",
      progress: writer.progress(),
    });
  }
  const replayed = writer.replayed() || finished.status === "unchanged";
  return consumed.terminalIssue
    ? fail({
        code: "dataset-import-failed",
        message:
          "The dataset import stopped on an unrecoverable document error.",
        progress: finished.progress,
      })
    : succeed({ progress: finished.progress, replayed });
};

export const makeImportDataset = (dependencies: ImportDatasetDependencies) =>
  async function importDataset(
    request: ImportDatasetRequest
  ): Promise<DomainResult<ImportDatasetSuccess, ImportDatasetFailure>> {
    if (!request.actor.permissions.includes(dependencies.requiredPermission)) {
      return fail({
        code: "authority-permission-missing",
        message: "The authenticated actor lacks permission to import datasets.",
      });
    }
    const prepared = prepareImport(dependencies, request);
    if (!prepared.ok) {
      return prepared;
    }
    const begun = await dependencies.datasets.beginImport(
      prepared.value.scope,
      {
        batchLimits: request.batchLimits,
        codecVersion: prepared.value.codec.codecVersion,
        dataset: prepared.value.dataset,
        fields: prepared.value.fields,
        format: prepared.value.codec.format,
        importId: request.importId,
        intentHash: prepared.value.intentHash,
        maxRecordBytes: request.maxRecordBytes,
        schemaHash: prepared.value.schemaHash,
        sourceContentHash: prepared.value.sourceContentHash,
      }
    );
    if (begun.status === "conflict") {
      return fail({
        code: "dataset-import-conflict",
        message: "The import identity conflicts with existing dataset input.",
      });
    }

    const writer = makeBatchWriter(
      dependencies.datasets,
      prepared.value.scope,
      request.importId,
      request.batchLimits,
      begun.progress,
      begun.status === "unchanged"
    );
    const observedSource = observeSource(request.bytes);
    try {
      const consumed = await consumeImportEvents(
        request,
        prepared.value,
        writer,
        observedSource.bytes
      );
      if (!consumed.ok) {
        await observedSource.cancel();
        return consumed;
      }
      return await finishConsumedImport(
        dependencies,
        request,
        prepared.value,
        writer,
        observedSource,
        consumed.value
      );
    } catch (error) {
      await observedSource.cancel();
      throw error;
    }
  };
