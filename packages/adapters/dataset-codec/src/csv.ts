import type {
  DatasetCodecError,
  DatasetCodecPort,
  DatasetDecodeInput,
  DatasetEncodeInput,
  DatasetFieldCodecSpec,
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
  scalarMatchesField,
  validationError,
} from "./record.ts";

const CR = 13;
const LF = 10;
const COMMA = 44;
const QUOTE = 34;
const NUMBER = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/u;
const REQUIRES_QUOTES = /[",\r\n]/u;
type CsvState = "after-quote" | "field-start" | "quoted" | "unquoted";

type RawRecord = Readonly<{
  bytes?: Uint8Array;
  lineEnd: number;
  lineStart: number;
  oversized: boolean;
}>;

type RawEvent =
  | Readonly<{ error: DatasetCodecError; type: "error" }>
  | Readonly<{ record: RawRecord; type: "record" }>;

const syntaxError = (
  message: string,
  lineStart: number,
  lineEnd: number
): RawEvent => ({
  error: codecError("csv-syntax-invalid", message, "document", false, {
    lineEnd,
    lineStart,
  }),
  type: "error",
});

class CsvFramer {
  private readonly buffer: Uint8Array;
  private readonly limit: number;
  private length = 0;
  private line = 1;
  private lineStart = 1;
  private pendingCr: "quoted" | "record" | undefined;
  private started = false;
  private state: CsvState = "field-start";

  constructor(limit: number) {
    this.buffer = new Uint8Array(limit);
    this.limit = limit;
  }

  consume(byte: number): RawEvent | undefined {
    if (this.pendingCr !== undefined) {
      return this.consumeAfterCr(byte);
    }
    if (byte === CR) {
      this.started = true;
      if (this.state === "quoted") {
        this.append(byte);
        this.pendingCr = "quoted";
        this.line += 1;
      } else {
        this.pendingCr = "record";
      }
      return;
    }
    if (byte === LF) {
      if (this.state === "quoted") {
        this.started = true;
        this.append(byte);
        this.line += 1;
        return;
      }
      return this.error("A CSV line break must use CRLF.");
    }
    this.started = true;
    return this.consumeData(byte);
  }

  finish(): RawEvent | undefined {
    if (this.pendingCr !== undefined || this.state === "quoted") {
      return this.error("The CSV document ends inside an incomplete sequence.");
    }
    return this.started ? this.takeRecord() : undefined;
  }

  private append(byte: number): void {
    if (this.length < this.limit) {
      this.buffer[this.length] = byte;
    }
    this.length += 1;
  }

  private consumeData(byte: number): RawEvent | undefined {
    switch (this.state) {
      case "field-start":
        this.append(byte);
        if (byte === QUOTE) {
          this.state = "quoted";
        } else if (byte !== COMMA) {
          this.state = "unquoted";
        }
        return;
      case "unquoted":
        if (byte === QUOTE) {
          return this.error("A quote cannot occur inside an unquoted field.");
        }
        this.append(byte);
        if (byte === COMMA) {
          this.state = "field-start";
        }
        return;
      case "quoted":
        this.append(byte);
        if (byte === QUOTE) {
          this.state = "after-quote";
        }
        return;
      case "after-quote":
        if (byte !== QUOTE && byte !== COMMA) {
          return this.error("Only a comma or CRLF may follow a closing quote.");
        }
        this.append(byte);
        this.state = byte === QUOTE ? "quoted" : "field-start";
        return;
      default:
        return this.error("The CSV parser reached an unsupported state.");
    }
  }

  private consumeAfterCr(byte: number): RawEvent | undefined {
    if (this.pendingCr === "quoted") {
      this.pendingCr = undefined;
      if (byte === LF) {
        this.append(byte);
        return;
      }
      return this.consume(byte);
    }
    if (byte !== LF) {
      return this.error("A CSV line break must use CRLF.");
    }
    this.pendingCr = undefined;
    const event = this.takeRecord();
    this.line += 1;
    this.lineStart = this.line;
    return event;
  }

  private error(message: string): RawEvent {
    return syntaxError(message, this.lineStart, this.line);
  }

  private takeRecord(): RawEvent {
    const oversized = this.length > this.limit;
    const record: RawRecord = {
      ...(oversized ? {} : { bytes: this.buffer.subarray(0, this.length) }),
      lineEnd: this.line,
      lineStart: this.lineStart,
      oversized,
    };
    this.length = 0;
    this.started = false;
    this.state = "field-start";
    return { record, type: "record" };
  }
}

async function* records(
  source: AsyncIterable<Uint8Array>,
  limit: number
): AsyncIterable<RawEvent> {
  const framer = new CsvFramer(limit);
  for await (const chunk of source) {
    for (const byte of chunk) {
      const event = framer.consume(byte);
      if (event !== undefined) {
        yield event;
        if (event.type === "error") {
          return;
        }
      }
    }
  }
  const final = framer.finish();
  if (final !== undefined) {
    yield final;
  }
}

type CsvField = Readonly<{ quoted: boolean; text: string }>;

const readQuotedField = (
  source: string,
  start: number
): Readonly<{ field: CsvField; nextIndex: number }> => {
  let index = start + 1;
  let text = "";
  while (index < source.length) {
    const character = source[index];
    if (character !== '"') {
      text += character;
      index += 1;
    } else if (source[index + 1] === '"') {
      text += '"';
      index += 2;
    } else {
      index += 1;
      break;
    }
  }
  return { field: { quoted: true, text }, nextIndex: index };
};

const readUnquotedField = (
  source: string,
  start: number
): Readonly<{ field: CsvField; nextIndex: number }> => {
  let index = start;
  let text = "";
  while (index < source.length && source[index] !== ",") {
    text += source[index];
    index += 1;
  }
  return { field: { quoted: false, text }, nextIndex: index };
};

const parseCsvText = (
  source: string,
  maximumFields: number
): readonly CsvField[] | undefined => {
  const fields: CsvField[] = [];
  let index = 0;
  while (index <= source.length) {
    if (fields.length >= maximumFields) {
      return;
    }
    const parsed =
      source[index] === '"'
        ? readQuotedField(source, index)
        : readUnquotedField(source, index);
    fields.push(parsed.field);
    index = parsed.nextIndex;
    if (index >= source.length) {
      break;
    }
    index += 1;
  }
  return fields;
};

const parseFields = (
  bytes: Uint8Array,
  maximumFields: number
): readonly CsvField[] | null | undefined => {
  const source = decodeUtf8(bytes);
  if (source === undefined) {
    return;
  }
  return parseCsvText(source, maximumFields) ?? null;
};

const expectedHeader = (fields: readonly DatasetFieldCodecSpec[]) => [
  "record_id",
  ...fields.map(({ key }) => key),
];

const decodeCell = (
  field: CsvField,
  spec: DatasetFieldCodecSpec
): DatasetScalarValue | undefined => {
  if (!field.quoted && field.text.length === 0) {
    return null;
  }
  if (spec.valueType === "string") {
    return field.text;
  }
  if (spec.valueType === "boolean") {
    if (field.text === "true") {
      return true;
    }
    return field.text === "false" ? false : undefined;
  }
  if (!NUMBER.test(field.text)) {
    return;
  }
  const value = Number(field.text);
  return scalarMatchesField(value, spec) ? value : undefined;
};

const recordError = (
  code: "column-count-mismatch" | "invalid-utf8" | "record-too-large",
  message: string,
  raw: RawRecord,
  recordNumber: number
) => ({
  error: codecError(code, message, "record", true, {
    lineEnd: raw.lineEnd,
    lineStart: raw.lineStart,
    recordNumber,
  }),
  type: "error" as const,
});

const decodeRecord = (
  raw: RawRecord,
  input: DatasetDecodeInput,
  recordNumber: number
) => {
  if (raw.oversized || raw.bytes === undefined) {
    return recordError(
      "record-too-large",
      "The CSV record exceeds the configured byte limit.",
      raw,
      recordNumber
    );
  }
  const cells = parseFields(raw.bytes, input.fields.length + 1);
  if (cells === undefined) {
    return recordError(
      "invalid-utf8",
      "The CSV record is not valid UTF-8.",
      raw,
      recordNumber
    );
  }
  if (cells === null || cells.length !== input.fields.length + 1) {
    return recordError(
      "column-count-mismatch",
      "The CSV record does not contain the configured number of fields.",
      raw,
      recordNumber
    );
  }
  const recordId = cells[0]?.text ?? "";
  const values: DatasetRecord["values"][number][] = [];
  for (let index = 0; index < input.fields.length; index += 1) {
    const spec = input.fields[index];
    const cell = cells[index + 1];
    if (spec === undefined || cell === undefined) {
      return recordError(
        "column-count-mismatch",
        "The CSV record does not contain the configured number of fields.",
        raw,
        recordNumber
      );
    }
    const value = decodeCell(cell, spec);
    if (value === undefined) {
      return {
        error: codecError(
          "value-type-mismatch",
          "A CSV value does not match its configured scalar field type.",
          "record",
          true,
          {
            lineEnd: raw.lineEnd,
            lineStart: raw.lineStart,
            recordId,
            recordNumber,
          },
          spec.key
        ),
        type: "error" as const,
      };
    }
    values.push({ fieldId: spec.fieldId, value });
  }
  const normalized = normalizeRecord(
    {
      datasetId: input.datasetId,
      recordId,
      values,
      workspaceId: input.workspaceId,
    },
    input.fields,
    input
  );
  return normalized.ok
    ? { record: normalized.record, recordNumber, type: "record" as const }
    : {
        error: validationError(normalized.error, {
          lineEnd: raw.lineEnd,
          lineStart: raw.lineStart,
          recordId,
          recordNumber,
        }),
        type: "error" as const,
      };
};

async function* decodeCsv(input: DatasetDecodeInput) {
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
  let headerSeen = false;
  let recordNumber = 0;
  for await (const event of records(input.bytes, input.maxRecordBytes)) {
    if (event.type === "error") {
      yield event;
      return;
    }
    if (headerSeen) {
      recordNumber += 1;
      yield decodeRecord(event.record, input, recordNumber);
    } else {
      headerSeen = true;
      const expected = expectedHeader(input.fields);
      const header =
        event.record.bytes === undefined
          ? undefined
          : parseFields(event.record.bytes, expected.length);
      if (
        header === undefined ||
        header === null ||
        header.length !== expected.length ||
        !header.every((field, index) => field.text === expected[index])
      ) {
        yield {
          error: codecError(
            "header-invalid",
            "The CSV header must exactly match record_id and the ordered field keys.",
            "document",
            false,
            {
              lineEnd: event.record.lineEnd,
              lineStart: event.record.lineStart,
            }
          ),
          type: "error",
        } as const;
        return;
      }
    }
  }
  if (!headerSeen) {
    yield {
      error: codecError(
        "header-invalid",
        "The CSV document requires an exact header record.",
        "document",
        false,
        { lineEnd: 1, lineStart: 1 }
      ),
      type: "error",
    } as const;
  }
}

const encodeField = (value: string): string =>
  value.length === 0 || REQUIRES_QUOTES.test(value)
    ? `"${value.replaceAll('"', '""')}"`
    : value;

const encodeScalar = (value: DatasetScalarValue): string => {
  if (value === null) {
    return "";
  }
  return typeof value === "string" ? encodeField(value) : String(value);
};

async function* encodeCsv(input: DatasetEncodeInput) {
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
  const headerText = expectedHeader(input.fields).map(encodeField).join(",");
  if (encodeUtf8(headerText).byteLength > input.maxRecordBytes) {
    yield {
      error: codecError(
        "record-too-large",
        "The CSV header exceeds the configured byte limit.",
        "document",
        false
      ),
      type: "error",
    } as const;
    return;
  }
  yield { bytes: encodeUtf8(`${headerText}\r\n`), type: "chunk" } as const;

  let recordNumber = 0;
  for await (const candidate of input.records) {
    recordNumber += 1;
    const normalized = normalizeRecord(candidate, input.fields, input, true);
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
    const row = [
      encodeField(candidate.recordId),
      ...normalized.record.values.map(({ value }) => encodeScalar(value)),
    ].join(",");
    if (encodeUtf8(row).byteLength > input.maxRecordBytes) {
      yield {
        error: codecError(
          "record-too-large",
          "The CSV record exceeds the configured byte limit.",
          "record",
          false,
          { recordId: candidate.recordId, recordNumber }
        ),
        type: "error",
      } as const;
      return;
    }
    yield {
      bytes: encodeUtf8(`${row}\r\n`),
      recordNumber,
      type: "chunk",
    } as const;
  }
}

export const createCsvDatasetCodec = (): DatasetCodecPort =>
  Object.freeze({
    codecVersion: DATASET_CODEC_VERSION,
    decode: decodeCsv,
    encode: encodeCsv,
    format: "csv" as const,
  });
