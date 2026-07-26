import assert from "node:assert/strict";
import test from "node:test";

import {
  contentHash,
  datasetId,
  datasetMaterializationId,
  instant,
  workspaceId,
} from "@kurobara/kernel";

import { parseDatasetMaterializationPayload } from "../src/dataset-generation-payload.ts";
import { DatabasePayloadError } from "../src/errors.ts";

const hash = (character: string) =>
  contentHash(`sha256:${character.repeat(64).slice(0, 64)}`);

const building = {
  createdAt: instant(1_800_000_000_000),
  datasetId: datasetId("dataset-generation"),
  materializationId: datasetMaterializationId("dataset-generation"),
  origin: { generationId: "generation-1", kind: "generation" as const },
  recordCount: 0,
  rejectedCount: 0,
  revision: 1,
  schemaHash: hash("a"),
  state: "building" as const,
  workspaceId: workspaceId("workspace-generation"),
};

test("strictly parses the exact no-effect materialization payload", () => {
  assert.deepEqual(parseDatasetMaterializationPayload(building), building);
});

test("preserves bounded import identities accepted by the existing dataset store", () => {
  const compatible = {
    ...building,
    datasetId: datasetId(" dataset-existing "),
    materializationId: datasetMaterializationId(" dataset-existing "),
    origin: { importId: " import-existing ", kind: "import" as const },
    workspaceId: workspaceId(" workspace-existing "),
  };

  assert.deepEqual(parseDatasetMaterializationPayload(compatible), compatible);
});

test("rejects hostile or non-canonical materialization JSON", () => {
  const hostilePayloads = [
    { ...building, unexpected: true },
    { ...building, origin: { kind: "generation" } },
    {
      ...building,
      origin: {
        generationId: "generation-1",
        importId: "fake-import",
        kind: "generation",
      },
    },
    { ...building, recordCount: Number.MAX_SAFE_INTEGER + 1 },
    {
      ...building,
      completedAt: instant(building.createdAt + 1),
      completionReason: "not-terminal",
    },
    Object.assign(Object.create({ inherited: true }), building),
  ];

  for (const payload of hostilePayloads) {
    assert.throws(
      () => parseDatasetMaterializationPayload(payload),
      DatabasePayloadError
    );
  }
});

test("rejects ready coverage that does not match the exact origin", () => {
  assert.throws(
    () =>
      parseDatasetMaterializationPayload({
        ...building,
        completedAt: instant(building.createdAt + 1),
        completionReason: "source-exhausted",
        contentHash: hash("b"),
        coverage: {
          basis: "imported_source",
          status: "complete_for_declared_source",
        },
        state: "ready",
      }),
    DatabasePayloadError
  );
});
