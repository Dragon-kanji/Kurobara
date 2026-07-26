import type {
  DatasetCodecError,
  DatasetCodecErrorCode,
  DatasetFieldCodecSpec,
  DatasetRecord,
  DatasetScalarValue,
} from "@kurobara/ports";

export const DATASET_CODEC_VERSION = "1.0.0" as const;

const FIELD_KEY = /^[a-z][a-z0-9_]*$/u;
const MAX_RECORD_BYTES = 16_777_216;
const MAX_NUMBER = 1_000_000_000_000_000;
const encoder = new TextEncoder();

export type CodecLocation = Readonly<{
  lineEnd?: number;
  lineStart?: number;
  recordId?: string;
  recordNumber?: number;
}>;

type RecordFailure = Readonly<{
  code:
    | "field-set-invalid"
    | "record-id-invalid"
    | "scope-mismatch"
    | "value-type-mismatch";
  message: string;
  fieldKey?: string;
}>;

const codePointLength = (value: string): number => {
  let length = 0;
  for (const _character of value) {
    length += 1;
  }
  return length;
};

const validId = (value: string): boolean =>
  value.trim().length > 0 && codePointLength(value) <= 255;

export const codecError = (
  code: DatasetCodecErrorCode,
  message: string,
  scope: "document" | "record",
  recoverable: boolean,
  location: CodecLocation = {},
  fieldKey?: string
): DatasetCodecError => ({
  code,
  message,
  recoverable,
  scope,
  ...(fieldKey === undefined ? {} : { fieldKey }),
  ...(location.lineEnd === undefined ? {} : { lineEnd: location.lineEnd }),
  ...(location.lineStart === undefined
    ? {}
    : { lineStart: location.lineStart }),
  ...(location.recordId === undefined || !validId(location.recordId)
    ? {}
    : { recordId: location.recordId }),
  ...(location.recordNumber === undefined
    ? {}
    : { recordNumber: location.recordNumber }),
});

export const configurationError = (
  fields: readonly DatasetFieldCodecSpec[],
  maxRecordBytes: number,
  datasetId?: string,
  workspaceId?: DatasetRecord["workspaceId"]
): DatasetCodecError | undefined => {
  const invalidLimit =
    !Number.isSafeInteger(maxRecordBytes) ||
    maxRecordBytes < 1 ||
    maxRecordBytes > MAX_RECORD_BYTES;
  if (invalidLimit) {
    return codecError(
      "configuration-invalid",
      "The record byte limit must be between 1 byte and 16 MiB.",
      "document",
      false
    );
  }
  if (
    fields.length > 256 ||
    (datasetId !== undefined && !validId(datasetId)) ||
    (workspaceId !== undefined && !validId(workspaceId))
  ) {
    return codecError(
      "configuration-invalid",
      "The dataset codec scope or field count is invalid.",
      "document",
      false
    );
  }
  const ids = new Set<string>();
  const keys = new Set<string>();
  const invalidField = fields.some((field) => {
    const invalid =
      !validId(field.fieldId) ||
      field.key.length > 128 ||
      !FIELD_KEY.test(field.key) ||
      !(["boolean", "number", "string"] as const).includes(field.valueType) ||
      ids.has(field.fieldId) ||
      keys.has(field.key);
    ids.add(field.fieldId);
    keys.add(field.key);
    return invalid;
  });
  return invalidField
    ? codecError(
        "configuration-invalid",
        "Dataset field identifiers and keys must be bounded and unique.",
        "document",
        false
      )
    : undefined;
};

export const decodeUtf8 = (bytes: Uint8Array): string | undefined => {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    // Fatal decoding deliberately maps malformed bytes to no value.
  }
};

export const encodeUtf8 = (value: string): Uint8Array => encoder.encode(value);

export const scalarMatchesField = (
  value: DatasetScalarValue,
  field: DatasetFieldCodecSpec
): boolean => {
  if (value === null) {
    return true;
  }
  if (field.valueType === "string") {
    return typeof value === "string" && codePointLength(value) <= 16_384;
  }
  if (field.valueType === "boolean") {
    return typeof value === "boolean";
  }
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    Math.abs(value) <= MAX_NUMBER
  );
};

export const normalizeRecord = (
  record: DatasetRecord,
  fields: readonly DatasetFieldCodecSpec[],
  expectedScope?: Readonly<{
    datasetId: string;
    workspaceId: DatasetRecord["workspaceId"];
  }>,
  requireCompleteFieldSet = false
):
  | Readonly<{ error: RecordFailure; ok: false }>
  | Readonly<{ ok: true; record: DatasetRecord }> => {
  if (!validId(record.recordId)) {
    return {
      error: {
        code: "record-id-invalid",
        message: "A record requires a bounded non-empty record identifier.",
      },
      ok: false,
    };
  }
  if (
    !(validId(record.datasetId) && validId(record.workspaceId)) ||
    (expectedScope !== undefined &&
      (record.datasetId !== expectedScope.datasetId ||
        record.workspaceId !== expectedScope.workspaceId))
  ) {
    return {
      error: {
        code: "scope-mismatch",
        message: "The record does not belong to the requested dataset scope.",
      },
      ok: false,
    };
  }
  const values = new Map<string, DatasetScalarValue>();
  for (const entry of record.values) {
    if (values.has(entry.fieldId)) {
      return {
        error: {
          code: "field-set-invalid",
          message: "Record field identities must be exact and unique.",
        },
        ok: false,
      };
    }
    values.set(entry.fieldId, entry.value);
  }
  if (
    (requireCompleteFieldSet && values.size !== fields.length) ||
    [...values.keys()].some(
      (id) => !fields.some((field) => field.fieldId === id)
    )
  ) {
    return {
      error: {
        code: "field-set-invalid",
        message: requireCompleteFieldSet
          ? "This format requires every configured field exactly once."
          : "Record field identities must belong to the configured dataset.",
      },
      ok: false,
    };
  }
  const ordered: DatasetRecord["values"][number][] = [];
  for (const field of fields) {
    if (!values.has(field.fieldId)) {
      continue;
    }
    const value = values.get(field.fieldId);
    if (value === undefined || !scalarMatchesField(value, field)) {
      return {
        error: {
          code: "value-type-mismatch",
          fieldKey: field.key,
          message: "A record value does not match its configured scalar type.",
        },
        ok: false,
      };
    }
    ordered.push({ fieldId: field.fieldId, value });
  }
  return { ok: true, record: { ...record, values: ordered } };
};

export const validationError = (
  failure: RecordFailure,
  location: CodecLocation,
  recoverable = true
): DatasetCodecError =>
  codecError(
    failure.code,
    failure.message,
    "record",
    recoverable,
    location,
    failure.fieldKey
  );
