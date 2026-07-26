import assert from "node:assert/strict";
import test from "node:test";

import { workspaceId } from "@kurobara/kernel";
import type {
  DatasetDecodeEvent,
  DatasetEncodeEvent,
  DatasetFieldCodecSpec,
  DatasetRecord,
} from "@kurobara/ports";

import { createJsonlDatasetCodec } from "../src/index.ts";

const WORKSPACE_ID = workspaceId("workspace-synthetic");
const fields = [
  { fieldId: "field-name", key: "name", valueType: "string" },
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
  maxRecordBytes = 4096
): Promise<readonly DatasetDecodeEvent[]> => {
  const events: DatasetDecodeEvent[] = [];
  for await (const event of createJsonlDatasetCodec().decode({
    bytes: source,
    datasetId: "dataset-synthetic",
    fields,
    maxRecordBytes,
    workspaceId: WORKSPACE_ID,
  })) {
    events.push(event);
  }
  return events;
};

const collectEncodedText = async (
  records: readonly DatasetRecord[]
): Promise<
  Readonly<{ events: readonly DatasetEncodeEvent[]; text: string }>
> => {
  const events: DatasetEncodeEvent[] = [];
  const chunks: Uint8Array[] = [];
  for await (const event of createJsonlDatasetCodec().encode({
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
  const size = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
  const joined = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { events, text: new TextDecoder().decode(joined) };
};

const record: DatasetRecord = {
  datasetId: "dataset-synthetic",
  recordId: "record-stable",
  values: [
    { fieldId: "field-name", value: "Café 🌸" },
    { fieldId: "field-score", value: null },
    { fieldId: "field-active", value: true },
  ],
  workspaceId: WORKSPACE_ID,
};

test("round-trips the exact Product Record shape across one-byte UTF-8 chunks", async () => {
  const encoded = await collectEncodedText([record]);
  const decoded = await collectDecode(bytesOf(encoded.text, 1));

  assert.equal(encoded.events.length, 1);
  assert.equal(
    encoded.text,
    '{"dataset_id":"dataset-synthetic","record_id":"record-stable","values":[{"field_id":"field-name","value":"Café 🌸"},{"field_id":"field-score","value":null},{"field_id":"field-active","value":true}],"workspace_id":"workspace-synthetic"}\n'
  );
  assert.deepEqual(decoded, [{ record, recordNumber: 1, type: "record" }]);
});

test("preserves omitted fields instead of turning them into null", async () => {
  const sparse = {
    ...record,
    recordId: "record-sparse",
    values: [{ fieldId: "field-name", value: "present" }],
  } satisfies DatasetRecord;
  const encoded = await collectEncodedText([sparse]);
  const decoded = await collectDecode(bytesOf(encoded.text, 1));

  assert.deepEqual(decoded, [
    { record: sparse, recordNumber: 1, type: "record" },
  ]);
  assert.equal(encoded.text.includes("field-score"), false);
});

test("rejects records outside the requested export scope", async () => {
  const encoded = await collectEncodedText([
    { ...record, datasetId: "dataset-other" },
  ]);

  assert.equal(encoded.text, "");
  assert.equal(encoded.events[0]?.type, "error");
  if (encoded.events[0]?.type === "error") {
    assert.equal(encoded.events[0].error.code, "scope-mismatch");
  }
});

test("counts Unicode code points for bounded record identities", async () => {
  const unicodeRecord = { ...record, recordId: "🌸".repeat(128) };
  const encoded = await collectEncodedText([unicodeRecord]);
  const decoded = await collectDecode(bytesOf(encoded.text, 1));

  assert.equal(decoded[0]?.type, "record");
  if (decoded[0]?.type === "record") {
    assert.equal(decoded[0].record.recordId, unicodeRecord.recordId);
  }
});

test("does not echo an invalid record identity in errors", async () => {
  const invalid = JSON.stringify({
    dataset_id: "dataset-synthetic",
    record_id: " ",
    values: [{ field_id: "field-name", value: "safe" }],
    workspace_id: "workspace-synthetic",
  });
  const events = await collectDecode(bytesOf(`${invalid}\n`));

  assert.equal(events[0]?.type, "error");
  if (events[0]?.type === "error") {
    assert.equal(events[0].error.code, "record-id-invalid");
    assert.equal(events[0].error.recordId, undefined);
  }
});

test("rejects duplicate object keys before JSON parsing can overwrite them", async () => {
  const duplicateRows = [
    '{"dataset_id":"dataset-synthetic","record_id":"record-first","record_id":"record-second","values":[],"workspace_id":"workspace-synthetic"}',
    '{"dataset_id":"dataset-synthetic","record_id":"record-nested","values":[{"field_id":"field-name","value":"first","value":"second"}],"workspace_id":"workspace-synthetic"}',
    '{"dataset_id":"dataset-synthetic","record_id":"record-escaped","values":[],"workspace_id":"workspace-synthetic","workspace_\\u0069d":"workspace-shadow"}',
    '{"outer":{"middle":{"duplicate":1,"duplicate":2}}}',
    '{"🌸":1,"\\ud83c\\udf38":2}',
  ];

  for (const row of duplicateRows) {
    const events = await collectDecode(bytesOf(`${row}\n`, 1));

    assert.deepEqual(events, [
      {
        error: {
          code: "invalid-json",
          lineEnd: 1,
          lineStart: 1,
          message: "The JSONL row is not valid JSON.",
          recordNumber: 1,
          recoverable: true,
          scope: "record",
        },
        type: "error",
      },
    ]);
    assert.equal(JSON.stringify(events).includes("record-second"), false);
  }
});

test("allows the same key in distinct sibling objects", async () => {
  const row =
    '{"dataset_id":"dataset-synthetic","record_id":"record-siblings","values":[{"field_id":"field-name","value":"safe"},{"field_id":"field-score","value":1}],"workspace_id":"workspace-synthetic"}';
  const events = await collectDecode(bytesOf(`${row}\n`, 2));

  assert.equal(events[0]?.type, "record");
  if (events[0]?.type === "record") {
    assert.equal(events[0].record.recordId, "record-siblings");
  }
});

test("rejects malformed JSON through the strict key scanner", async () => {
  const malformedRows = [
    '{"dataset_id":"dataset-synthetic",}',
    '{"dataset_id" "dataset-synthetic"}',
    '{"dataset_id":"bad\\xescape"}',
    "[true,]",
  ];

  for (const row of malformedRows) {
    const events = await collectDecode(bytesOf(`${row}\n`));

    assert.equal(events[0]?.type, "error");
    if (events[0]?.type === "error") {
      assert.equal(events[0].error.code, "invalid-json");
    }
  }
});

test("bounds JSON nesting and keys before allocating an unbounded parse shape", async () => {
  const deeplyNested = `${"[".repeat(65)}0${"]".repeat(65)}`;
  const tooManyKeys = `{${Array.from(
    { length: 513 },
    (_value, index) => `"key_${index}":${index}`
  ).join(",")}}`;

  for (const row of [deeplyNested, tooManyKeys]) {
    const events = await collectDecode(bytesOf(`${row}\n`, 17), 16_384);

    assert.equal(events[0]?.type, "error");
    if (events[0]?.type === "error") {
      assert.equal(events[0].error.code, "invalid-json");
    }
  }
});

test("emits redacted row errors and resumes at the next JSONL boundary", async () => {
  const valid = (recordId: string) =>
    JSON.stringify({
      dataset_id: "dataset-synthetic",
      record_id: recordId,
      values: [
        { field_id: "field-name", value: "safe" },
        { field_id: "field-score", value: 1 },
        { field_id: "field-active", value: false },
      ],
      workspace_id: "workspace-synthetic",
    });
  const events = await collectDecode(
    bytesOf(`${valid("record-1")}\n{private payload\n${valid("record-2")}`)
  );

  assert.equal(events.length, 3);
  assert.equal(events[0]?.type, "record");
  assert.deepEqual(events[1], {
    error: {
      code: "invalid-json",
      lineEnd: 2,
      lineStart: 2,
      message: "The JSONL row is not valid JSON.",
      recordNumber: 2,
      recoverable: true,
      scope: "record",
    },
    type: "error",
  });
  assert.equal(events[2]?.type, "record");
  if (events[2]?.type === "record") {
    assert.equal(events[2].record.recordId, "record-2");
  }
  assert.equal(JSON.stringify(events).includes("private payload"), false);
});

test("bounds an oversized line without losing the following record", async () => {
  const oversized = `{"padding":"${"x".repeat(1000)}"}`;
  const valid = JSON.stringify({
    dataset_id: "dataset-synthetic",
    record_id: "record-after-large",
    values: [
      { field_id: "field-name", value: "ok" },
      { field_id: "field-score", value: 1 },
      { field_id: "field-active", value: true },
    ],
    workspace_id: "workspace-synthetic",
  });
  const events = await collectDecode(
    bytesOf(`${oversized}\n${valid}\n`, 7),
    512
  );

  assert.equal(events.length, 2);
  assert.equal(events[0]?.type, "error");
  if (events[0]?.type === "error") {
    assert.equal(events[0].error.code, "record-too-large");
  }
  assert.equal(events[1]?.type, "record");
});

test("produces byte-identical output for the same ordered record stream", async () => {
  const first = await collectEncodedText([record]);
  const second = await collectEncodedText([record]);

  assert.equal(first.text, second.text);
});
