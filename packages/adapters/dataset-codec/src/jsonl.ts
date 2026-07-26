import type {
  DatasetCodecError,
  DatasetCodecPort,
  DatasetDecodeInput,
  DatasetEncodeInput,
  DatasetRecord,
  DatasetScalarValue,
} from "@kurobara/ports";

import {
  codecError,
  configurationError,
  DATASET_CODEC_VERSION,
  decodeUtf8,
  encodeUtf8,
  normalizeRecord,
  validationError,
} from "./record.ts";
import { parseJsonWithUniqueObjectKeys } from "./strict-json.ts";

const CR = 13;
const LF = 10;
type JsonObject = Record<string, unknown>;

const isObject = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const hasKeys = (value: JsonObject, expected: readonly string[]): boolean => {
  const keys = Object.keys(value);
  return (
    keys.length === expected.length &&
    keys.every((key) => expected.includes(key))
  );
};

const isScalar = (value: unknown): value is DatasetScalarValue =>
  value === null ||
  typeof value === "boolean" ||
  typeof value === "number" ||
  typeof value === "string";

const shapeError = (recordNumber: number): DatasetCodecError =>
  codecError(
    "invalid-record-shape",
    "The JSONL row does not match the exact dataset Record shape.",
    "record",
    true,
    { lineEnd: recordNumber, lineStart: recordNumber, recordNumber }
  );

const parseWireRecord = (
  value: unknown,
  input: DatasetDecodeInput,
  recordNumber: number
):
  | Readonly<{ error: DatasetCodecError; ok: false }>
  | Readonly<{ ok: true; record: DatasetRecord }> => {
  if (
    !(
      isObject(value) &&
      hasKeys(value, ["dataset_id", "record_id", "values", "workspace_id"])
    ) ||
    typeof value.dataset_id !== "string" ||
    typeof value.record_id !== "string" ||
    typeof value.workspace_id !== "string" ||
    !Array.isArray(value.values)
  ) {
    return { error: shapeError(recordNumber), ok: false };
  }
  const values: DatasetRecord["values"][number][] = [];
  for (const entry of value.values) {
    if (
      !(isObject(entry) && hasKeys(entry, ["field_id", "value"])) ||
      typeof entry.field_id !== "string" ||
      !isScalar(entry.value)
    ) {
      return { error: shapeError(recordNumber), ok: false };
    }
    values.push({ fieldId: entry.field_id, value: entry.value });
  }
  const candidate: DatasetRecord = {
    datasetId: value.dataset_id,
    recordId: value.record_id,
    values,
    workspaceId: input.workspaceId,
  };
  if (value.workspace_id !== input.workspaceId) {
    return {
      error: codecError(
        "scope-mismatch",
        "The record does not belong to the requested dataset scope.",
        "record",
        true,
        {
          lineEnd: recordNumber,
          lineStart: recordNumber,
          recordId: candidate.recordId,
          recordNumber,
        }
      ),
      ok: false,
    };
  }
  const normalized = normalizeRecord(candidate, input.fields, input);
  return normalized.ok
    ? normalized
    : {
        error: validationError(normalized.error, {
          lineEnd: recordNumber,
          lineStart: recordNumber,
          recordId: candidate.recordId,
          recordNumber,
        }),
        ok: false,
      };
};

const decodeLine = (
  bytes: Uint8Array,
  input: DatasetDecodeInput,
  recordNumber: number
) => {
  const text = decodeUtf8(bytes);
  if (text === undefined) {
    return {
      error: codecError(
        "invalid-utf8",
        "The JSONL row is not valid UTF-8.",
        "record",
        true,
        { lineEnd: recordNumber, lineStart: recordNumber, recordNumber }
      ),
      type: "error" as const,
    };
  }
  const parsedJson = parseJsonWithUniqueObjectKeys(text);
  if (!parsedJson.ok) {
    return {
      error: codecError(
        "invalid-json",
        "The JSONL row is not valid JSON.",
        "record",
        true,
        { lineEnd: recordNumber, lineStart: recordNumber, recordNumber }
      ),
      type: "error" as const,
    };
  }
  const parsed = parseWireRecord(parsedJson.value, input, recordNumber);
  return parsed.ok
    ? { record: parsed.record, recordNumber, type: "record" as const }
    : { error: parsed.error, type: "error" as const };
};

type RawLine = Readonly<{
  bytes?: Uint8Array;
  lineNumber: number;
  oversized: boolean;
}>;

const rawLine = (
  buffer: Uint8Array,
  length: number,
  lineNumber: number,
  limit: number
): RawLine => {
  const contentLength =
    length <= buffer.byteLength && length > 0 && buffer[length - 1] === CR
      ? length - 1
      : length;
  const oversized = contentLength > limit;
  return {
    ...(oversized ? {} : { bytes: buffer.subarray(0, contentLength) }),
    lineNumber,
    oversized,
  };
};

async function* lines(
  source: AsyncIterable<Uint8Array>,
  limit: number
): AsyncIterable<RawLine> {
  const buffer = new Uint8Array(limit + 1);
  let length = 0;
  let lineNumber = 1;
  for await (const chunk of source) {
    for (const byte of chunk) {
      if (byte === LF) {
        yield rawLine(buffer, length, lineNumber, limit);
        length = 0;
        lineNumber += 1;
      } else {
        if (length < buffer.byteLength) {
          buffer[length] = byte;
        }
        length += 1;
      }
    }
  }
  if (length > 0) {
    yield rawLine(buffer, length, lineNumber, limit);
  }
}

async function* decodeJsonl(input: DatasetDecodeInput) {
  const invalid = configurationError(
    input.fields,
    input.maxRecordBytes,
    input.datasetId,
    input.workspaceId
  );
  if (invalid !== undefined) {
    yield { error: invalid, type: "error" } as const;
    return;
  }
  let recordNumber = 0;
  for await (const line of lines(input.bytes, input.maxRecordBytes)) {
    recordNumber += 1;
    if (line.oversized || line.bytes === undefined) {
      yield {
        error: codecError(
          "record-too-large",
          "The JSONL row exceeds the configured byte limit.",
          "record",
          true,
          {
            lineEnd: line.lineNumber,
            lineStart: line.lineNumber,
            recordNumber,
          }
        ),
        type: "error",
      } as const;
    } else {
      yield decodeLine(line.bytes, input, recordNumber);
    }
  }
}

const wireRecord = (record: DatasetRecord) => ({
  dataset_id: record.datasetId,
  record_id: record.recordId,
  values: record.values.map(({ fieldId, value }) => ({
    field_id: fieldId,
    value,
  })),
  workspace_id: record.workspaceId,
});

async function* encodeJsonl(input: DatasetEncodeInput) {
  const invalid = configurationError(
    input.fields,
    input.maxRecordBytes,
    input.datasetId,
    input.workspaceId
  );
  if (invalid !== undefined) {
    yield { error: invalid, type: "error" } as const;
    return;
  }
  let recordNumber = 0;
  for await (const candidate of input.records) {
    recordNumber += 1;
    const normalized = normalizeRecord(candidate, input.fields, input);
    if (!normalized.ok) {
      yield {
        error: {
          ...validationError(normalized.error, {
            recordId: candidate.recordId,
            recordNumber,
          }),
          recoverable: false,
        },
        type: "error",
      } as const;
      return;
    }
    const text = JSON.stringify(wireRecord(normalized.record));
    if (encodeUtf8(text).byteLength > input.maxRecordBytes) {
      yield {
        error: codecError(
          "record-too-large",
          "The JSONL row exceeds the configured byte limit.",
          "record",
          false,
          { recordId: candidate.recordId, recordNumber }
        ),
        type: "error",
      } as const;
      return;
    }
    yield {
      bytes: encodeUtf8(`${text}\n`),
      recordNumber,
      type: "chunk",
    } as const;
  }
}

export const createJsonlDatasetCodec = (): DatasetCodecPort =>
  Object.freeze({
    codecVersion: DATASET_CODEC_VERSION,
    decode: decodeJsonl,
    encode: encodeJsonl,
    format: "jsonl" as const,
  });
