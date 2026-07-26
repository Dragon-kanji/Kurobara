import assert from "node:assert/strict";
import test from "node:test";

import { workspaceId } from "@kurobara/kernel";
import type {
  DatasetDecodeEvent,
  DatasetEncodeEvent,
  DatasetFieldCodecSpec,
  DatasetRecord,
} from "@kurobara/ports";

import { createCsvDatasetCodec } from "../src/index.ts";

const WORKSPACE_ID = workspaceId("workspace-synthetic");
const fields = [
  { fieldId: "field-name", key: "name", valueType: "string" },
  { fieldId: "field-note", key: "note", valueType: "string" },
  { fieldId: "field-score", key: "score", valueType: "number" },
  { fieldId: "field-active", key: "active", valueType: "boolean" },
] as const satisfies readonly DatasetFieldCodecSpec[];

async function* bytesOf(value: string, chunkSize = value.length || 1) {
  await Promise.resolve();
  const bytes = new TextEncoder().encode(value);
  for (let offset = 0; offset < bytes.byteLength; offset += chunkSize) {
    yield bytes.slice(offset, offset + chunkSize);
  }
}

async function* recordsOf(records: readonly DatasetRecord[]) {
  await Promise.resolve();
  for (const record of records) {
    yield record;
  }
}

const collectDecode = async (
  source: AsyncIterable<Uint8Array>,
  configuredFields: readonly DatasetFieldCodecSpec[] = fields,
  maxRecordBytes = 4096
): Promise<readonly DatasetDecodeEvent[]> => {
  const events: DatasetDecodeEvent[] = [];
  for await (const event of createCsvDatasetCodec().decode({
    bytes: source,
    datasetId: "dataset-synthetic",
    fields: configuredFields,
    maxRecordBytes,
    workspaceId: WORKSPACE_ID,
  })) {
    events.push(event);
  }
  return events;
};

const collectEncode = async (
  records: readonly DatasetRecord[]
): Promise<
  Readonly<{ events: readonly DatasetEncodeEvent[]; text: string }>
> => {
  const events: DatasetEncodeEvent[] = [];
  const chunks: Uint8Array[] = [];
  for await (const event of createCsvDatasetCodec().encode({
    datasetId: "dataset-synthetic",
    fields,
    maxRecordBytes: 4096,
    records: recordsOf(records),
    workspaceId: WORKSPACE_ID,
  })) {
    events.push(event);
    if (event.type === "chunk") {
      chunks.push(event.bytes);
    }
  }
  const text = chunks.map((chunk) => new TextDecoder().decode(chunk)).join("");
  return { events, text };
};

test("preserves null, quoted empty strings, quotes, commas, and embedded CRLF", async () => {
  const csv = [
    "record_id,name,note,score,active",
    'record-1,,"",1.5,true',
    'record-2,"A, ""quoted"" name","line 1\r\nline 2",-2,false',
    "",
  ].join("\r\n");
  const events = await collectDecode(bytesOf(csv, 1));

  assert.equal(events.length, 2);
  assert.deepEqual(events[0], {
    record: {
      datasetId: "dataset-synthetic",
      recordId: "record-1",
      values: [
        { fieldId: "field-name", value: null },
        { fieldId: "field-note", value: "" },
        { fieldId: "field-score", value: 1.5 },
        { fieldId: "field-active", value: true },
      ],
      workspaceId: WORKSPACE_ID,
    },
    recordNumber: 1,
    type: "record",
  });
  assert.equal(events[1]?.type, "record");
  if (events[1]?.type === "record") {
    assert.equal(events[1].record.recordId, "record-2");
    assert.deepEqual(events[1].record.values, [
      { fieldId: "field-name", value: 'A, "quoted" name' },
      { fieldId: "field-note", value: "line 1\r\nline 2" },
      { fieldId: "field-score", value: -2 },
      { fieldId: "field-active", value: false },
    ]);
  }
});

test("encodes deterministically with the strict CSV null profile and CRLF", async () => {
  const records: readonly DatasetRecord[] = [
    {
      datasetId: "dataset-synthetic",
      recordId: "record-1",
      values: [
        { fieldId: "field-active", value: true },
        { fieldId: "field-name", value: null },
        { fieldId: "field-note", value: "" },
        { fieldId: "field-score", value: 1.5 },
      ],
      workspaceId: WORKSPACE_ID,
    },
    {
      datasetId: "dataset-synthetic",
      recordId: "record-2",
      values: [
        { fieldId: "field-name", value: 'A, "quoted" name' },
        { fieldId: "field-note", value: "line 1\r\nline 2" },
        { fieldId: "field-score", value: -2 },
        { fieldId: "field-active", value: false },
      ],
      workspaceId: WORKSPACE_ID,
    },
  ];
  const first = await collectEncode(records);
  const second = await collectEncode(records);
  const decoded = await collectDecode(bytesOf(first.text, 1));

  assert.equal(
    first.text,
    'record_id,name,note,score,active\r\nrecord-1,,"",1.5,true\r\nrecord-2,"A, ""quoted"" name","line 1\r\nline 2",-2,false\r\n'
  );
  assert.equal(first.text, second.text);
  assert.equal(
    first.events.every((event) => event.type === "chunk"),
    true
  );
  assert.deepEqual(
    decoded
      .filter((event) => event.type === "record")
      .map((event) => event.record),
    records.map((record) => ({
      ...record,
      values: fields.map((field) =>
        record.values.find((entry) => entry.fieldId === field.fieldId)
      ),
    }))
  );
});

test("round-trips bare CR and LF inside quoted scalar values", async () => {
  const source = {
    datasetId: "dataset-synthetic",
    recordId: "record-line-breaks",
    values: [
      { fieldId: "field-name", value: "line 1\nline 2" },
      { fieldId: "field-note", value: "left\rright" },
      { fieldId: "field-score", value: 1 },
      { fieldId: "field-active", value: true },
    ],
    workspaceId: WORKSPACE_ID,
  } satisfies DatasetRecord;
  const encoded = await collectEncode([source]);
  const decoded = await collectDecode(bytesOf(encoded.text, 1));

  assert.equal(decoded[0]?.type, "record");
  if (decoded[0]?.type === "record") {
    assert.deepEqual(decoded[0].record, source);
  }
});

test("rejects sparse records instead of silently converting omission to null", async () => {
  const sparse = {
    datasetId: "dataset-synthetic",
    recordId: "record-sparse",
    values: [{ fieldId: "field-name", value: "present" }],
    workspaceId: WORKSPACE_ID,
  } satisfies DatasetRecord;
  const encoded = await collectEncode([sparse]);

  assert.deepEqual(
    encoded.events.map((event) =>
      event.type === "chunk" ? "chunk" : event.error.code
    ),
    ["chunk", "field-set-invalid"]
  );
  assert.equal(encoded.text, "record_id,name,note,score,active\r\n");
});

test("rejects a mixed export scope before dropping CSV-only metadata", async () => {
  const encoded = await collectEncode([
    {
      datasetId: "dataset-other",
      recordId: "record-other-scope",
      values: [
        { fieldId: "field-name", value: "safe" },
        { fieldId: "field-note", value: "safe" },
        { fieldId: "field-score", value: 1 },
        { fieldId: "field-active", value: true },
      ],
      workspaceId: WORKSPACE_ID,
    },
  ]);

  assert.deepEqual(
    encoded.events.map((event) =>
      event.type === "chunk" ? "chunk" : event.error.code
    ),
    ["chunk", "scope-mismatch"]
  );
});

test("stops parsing after the configured CSV column count", async () => {
  const csv = `record_id,name,note,score,active\r\nrecord-many,${"x,".repeat(5000)}x\r\n`;
  const events = await collectDecode(bytesOf(csv, 17), fields, 16_384);

  assert.equal(events.length, 1);
  assert.equal(events[0]?.type, "error");
  if (events[0]?.type === "error") {
    assert.equal(events[0].error.code, "column-count-mismatch");
  }
});

test("continues after safe per-record type and column errors", async () => {
  const csv = [
    "record_id,name,note,score,active",
    "record-1,ok,note,1,true",
    "record-2,ok,note,not-a-number,true",
    "record-3,missing,columns",
    "record-4,ok,note,2,false",
    "",
  ].join("\r\n");
  const events = await collectDecode(bytesOf(csv, 3));

  assert.deepEqual(
    events.map((event) =>
      event.type === "record" ? event.record.recordId : event.error.code
    ),
    ["record-1", "value-type-mismatch", "column-count-mismatch", "record-4"]
  );
});

test("treats unsafe quote corruption as a terminal document error", async () => {
  const csv =
    'record_id,name,note,score,active\r\nrecord-1,bad"quote,note,1,true\r\nrecord-2,ok,note,2,false\r\n';
  const events = await collectDecode(bytesOf(csv, 2));

  assert.equal(events.length, 1);
  assert.equal(events[0]?.type, "error");
  if (events[0]?.type === "error") {
    assert.equal(events[0].error.code, "csv-syntax-invalid");
    assert.equal(events[0].error.scope, "document");
    assert.equal(events[0].error.recoverable, false);
  }
});

test("discards an oversized record and resumes at its safe CRLF boundary", async () => {
  const smallFields = [
    { fieldId: "field-name", key: "name", valueType: "string" },
  ] as const satisfies readonly DatasetFieldCodecSpec[];
  const csv = `record_id,name\r\nrecord-large,${"x".repeat(40)}\r\nrecord-ok,ok\r\n`;
  const events = await collectDecode(bytesOf(csv, 4), smallFields, 24);

  assert.deepEqual(
    events.map((event) =>
      event.type === "record" ? event.record.recordId : event.error.code
    ),
    ["record-too-large", "record-ok"]
  );
});
