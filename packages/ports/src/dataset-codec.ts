import type { WorkspaceId } from "@kurobara/kernel";

export type DatasetScalarValue = boolean | null | number | string;

export type DatasetFieldCodecSpec = Readonly<{
  fieldId: string;
  key: string;
  valueType: "boolean" | "number" | "string";
}>;

export type DatasetRecordValue = Readonly<{
  fieldId: string;
  value: DatasetScalarValue;
}>;

export type DatasetRecord = Readonly<{
  datasetId: string;
  recordId: string;
  values: readonly DatasetRecordValue[];
  workspaceId: WorkspaceId;
}>;

export type DatasetCodecErrorCode =
  | "column-count-mismatch"
  | "configuration-invalid"
  | "csv-syntax-invalid"
  | "field-set-invalid"
  | "header-invalid"
  | "invalid-json"
  | "invalid-record-shape"
  | "invalid-utf8"
  | "record-id-invalid"
  | "record-too-large"
  | "scope-mismatch"
  | "value-type-mismatch";

export type DatasetCodecError = Readonly<{
  code: DatasetCodecErrorCode;
  message: string;
  recoverable: boolean;
  scope: "document" | "record";
  fieldKey?: string;
  lineEnd?: number;
  lineStart?: number;
  recordId?: string;
  recordNumber?: number;
}>;

export type DatasetDecodeEvent =
  | Readonly<{
      record: DatasetRecord;
      recordNumber: number;
      type: "record";
    }>
  | Readonly<{ error: DatasetCodecError; type: "error" }>;

export type DatasetEncodeEvent =
  | Readonly<{
      bytes: Uint8Array;
      recordNumber?: number;
      type: "chunk";
    }>
  | Readonly<{ error: DatasetCodecError; type: "error" }>;

export type DatasetDecodeInput = Readonly<{
  bytes: AsyncIterable<Uint8Array>;
  datasetId: string;
  fields: readonly DatasetFieldCodecSpec[];
  maxRecordBytes: number;
  workspaceId: WorkspaceId;
}>;

export type DatasetEncodeInput = Readonly<{
  datasetId: string;
  fields: readonly DatasetFieldCodecSpec[];
  maxRecordBytes: number;
  records: AsyncIterable<DatasetRecord>;
  workspaceId: WorkspaceId;
}>;

export interface DatasetCodecPort {
  readonly codecVersion: "1.0.0";
  decode(input: DatasetDecodeInput): AsyncIterable<DatasetDecodeEvent>;
  encode(input: DatasetEncodeInput): AsyncIterable<DatasetEncodeEvent>;
  readonly format: "csv" | "jsonl";
}
