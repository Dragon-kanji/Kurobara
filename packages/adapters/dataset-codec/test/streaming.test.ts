import assert from "node:assert/strict";
import test from "node:test";

import { workspaceId } from "@kurobara/kernel";
import type {
  DatasetDecodeEvent,
  DatasetFieldCodecSpec,
  DatasetRecord,
} from "@kurobara/ports";

import {
  createCsvDatasetCodec,
  createJsonlDatasetCodec,
} from "../src/index.ts";

const WORKSPACE_ID = workspaceId("workspace-synthetic");
const fields = [
  { fieldId: "field-name", key: "name", valueType: "string" },
] as const satisfies readonly DatasetFieldCodecSpec[];

const wireRecord = (recordId: string) =>
  `${JSON.stringify({
    dataset_id: "dataset-synthetic",
    record_id: recordId,
    values: [{ field_id: "field-name", value: "safe" }],
    workspace_id: "workspace-synthetic",
  })}\n`;

test("decoder backpressure does not pull the whole input stream", async () => {
  let chunksPulled = 0;
  async function* source() {
    await Promise.resolve();
    chunksPulled += 1;
    yield new TextEncoder().encode(wireRecord("record-1"));
    chunksPulled += 1;
    yield new TextEncoder().encode(wireRecord("record-2"));
  }

  for await (const event of createJsonlDatasetCodec().decode({
    bytes: source(),
    datasetId: "dataset-synthetic",
    fields,
    maxRecordBytes: 4096,
    workspaceId: WORKSPACE_ID,
  })) {
    assert.equal(event.type, "record");
    break;
  }

  assert.equal(chunksPulled, 1);
});

test("encoder backpressure reads only the record needed for the next chunk", async () => {
  let recordsPulled = 0;
  const record = (recordId: string): DatasetRecord => ({
    datasetId: "dataset-synthetic",
    recordId,
    values: [{ fieldId: "field-name", value: "safe" }],
    workspaceId: WORKSPACE_ID,
  });
  async function* source() {
    await Promise.resolve();
    recordsPulled += 1;
    yield record("record-1");
    recordsPulled += 1;
    yield record("record-2");
  }

  for await (const event of createJsonlDatasetCodec().encode({
    datasetId: "dataset-synthetic",
    fields,
    maxRecordBytes: 4096,
    records: source(),
    workspaceId: WORKSPACE_ID,
  })) {
    assert.equal(event.type, "chunk");
    break;
  }

  assert.equal(recordsPulled, 1);
});

test("rejects invalid field types and whitespace-only scope configuration", async () => {
  const invalidFields = [
    { fieldId: "field-name", key: "name", valueType: "bogus" },
  ] as unknown as readonly DatasetFieldCodecSpec[];
  async function* emptySource() {
    await Promise.resolve();
    yield new Uint8Array();
  }

  for (const configuration of [
    { datasetId: "dataset-synthetic", fields: invalidFields },
    { datasetId: " ", fields },
  ]) {
    const events: DatasetDecodeEvent[] = [];
    for await (const event of createJsonlDatasetCodec().decode({
      bytes: emptySource(),
      datasetId: configuration.datasetId,
      fields: configuration.fields,
      maxRecordBytes: 4096,
      workspaceId: WORKSPACE_ID,
    })) {
      events.push(event);
    }
    assert.equal(events[0]?.type, "error");
    if (events[0]?.type === "error") {
      assert.equal(events[0].error.code, "configuration-invalid");
    }
  }
});

test("CSV decoding reports invalid UTF-8 per record and safely continues", async () => {
  async function* source() {
    await Promise.resolve();
    yield new TextEncoder().encode("record_id,name\r\nrecord-1,");
    yield Uint8Array.from([0xff]);
    yield new TextEncoder().encode("\r\nrecord-2,ok\r\n");
  }
  const events: DatasetDecodeEvent[] = [];
  for await (const event of createCsvDatasetCodec().decode({
    bytes: source(),
    datasetId: "dataset-synthetic",
    fields,
    maxRecordBytes: 4096,
    workspaceId: WORKSPACE_ID,
  })) {
    events.push(event);
  }

  assert.deepEqual(
    events.map((event) =>
      event.type === "record" ? event.record.recordId : event.error.code
    ),
    ["invalid-utf8", "record-2"]
  );
});
