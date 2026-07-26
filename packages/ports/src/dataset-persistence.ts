import type {
  ContentHash,
  Dataset,
  DatasetId,
  DatasetMaterialization,
  Record as DatasetRecord,
  Field,
  FieldId,
  WorkspaceId,
} from "@kurobara/kernel";

import type { DatasetCodecErrorCode } from "./dataset-codec.ts";
import type { WorkspaceScope } from "./run-persistence.ts";

export type DatasetImportFormat = "csv" | "jsonl";
export type DatasetImportState = "completed" | "failed" | "running";

export type DatasetImportBatchLimits = Readonly<{
  maxBytes: number;
  maxItems: number;
}>;

export type DatasetImportIssueCode =
  | DatasetCodecErrorCode
  | "record-domain-invalid"
  | "record-id-conflict";

export type DatasetImportIssue = Readonly<{
  code: DatasetImportIssueCode;
  message: string;
  recoverable: boolean;
  scope: "document" | "record";
  fieldKey?: string;
  lineEnd?: number;
  lineStart?: number;
  recordId?: string;
  recordNumber?: number;
}>;

export type DatasetImportDefinition = Readonly<{
  batchLimits: DatasetImportBatchLimits;
  codecVersion: "1.0.0";
  dataset: Dataset;
  fields: readonly Field[];
  format: DatasetImportFormat;
  importId: string;
  intentHash: ContentHash;
  maxRecordBytes: number;
  schemaHash: ContentHash;
  sourceContentHash: ContentHash;
}>;

export type DatasetImportItem =
  | Readonly<{
      contentHash: ContentHash;
      itemNumber: number;
      kind: "record";
      record: DatasetRecord;
      recordNumber: number;
    }>
  | Readonly<{
      contentHash: ContentHash;
      issue: DatasetImportIssue;
      itemNumber: number;
      kind: "issue";
    }>;

export type DatasetImportBatch = Readonly<{
  contentHash: ContentHash;
  items: readonly DatasetImportItem[];
  sequence: number;
}>;

export type DatasetImportProgress = Readonly<{
  batchCount: number;
  datasetId: DatasetId;
  errorCount: number;
  importId: string;
  itemCount: number;
  recordCount: number;
  state: DatasetImportState;
  workspaceId: WorkspaceId;
}>;

export type DatasetImportConflictCode =
  | "batch-content-mismatch"
  | "batch-sequence-invalid"
  | "dataset-already-imported"
  | "definition-mismatch"
  | "import-completion-mismatch"
  | "import-state-conflict";

export type DatasetImportMutationResult =
  | Readonly<{
      progress: DatasetImportProgress;
      status: "applied" | "unchanged";
    }>
  | Readonly<{
      conflict: DatasetImportConflictCode;
      status: "conflict";
    }>;

export type DatasetImportCompletion = Readonly<{
  batchCount: number;
  itemCount: number;
  state: "completed" | "failed";
}>;

export type StoredDataset = Readonly<{
  dataset: Dataset;
  fields: readonly Field[];
  import?: DatasetImportProgress;
  materialization: DatasetMaterialization;
}>;

export interface DatasetPersistencePort {
  appendImportBatch(
    scope: WorkspaceScope,
    importId: string,
    batch: DatasetImportBatch
  ): Promise<DatasetImportMutationResult>;
  beginImport(
    scope: WorkspaceScope,
    definition: DatasetImportDefinition
  ): Promise<DatasetImportMutationResult>;
  finishImport(
    scope: WorkspaceScope,
    importId: string,
    completion: DatasetImportCompletion
  ): Promise<DatasetImportMutationResult>;
  getDataset(
    scope: WorkspaceScope,
    datasetId: DatasetId
  ): Promise<StoredDataset | undefined>;
  isFieldSetComplete(
    scope: WorkspaceScope,
    datasetId: DatasetId,
    fieldIds: readonly FieldId[]
  ): Promise<boolean>;
  resetImport(
    scope: WorkspaceScope,
    importId: string,
    sourceContentHash: ContentHash
  ): Promise<DatasetImportMutationResult>;
  streamImportIssues(
    scope: WorkspaceScope,
    datasetId: DatasetId
  ): AsyncIterable<DatasetImportIssue>;
  streamRecords(
    scope: WorkspaceScope,
    datasetId: DatasetId
  ): AsyncIterable<DatasetRecord>;
}
