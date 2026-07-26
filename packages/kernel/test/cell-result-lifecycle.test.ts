import assert from "node:assert/strict";
import test from "node:test";

import {
  type CellResult,
  cellResultId,
  contentHash,
  createCellResult,
  createDataset,
  createEnrichmentRecipe,
  createField,
  createRecord,
  type DomainResult,
  datasetId,
  enrichmentRecipeId,
  fieldId,
  instant,
  type ProductFailure,
  recordId,
  runId,
  transitionCellResult,
  workflowSpecId,
  workspaceId,
} from "../src/index.ts";

const unwrap = <Value>(result: DomainResult<Value, ProductFailure>): Value => {
  if (!result.ok) {
    throw new Error(`${result.error.code}: ${result.error.message}`);
  }
  return result.value;
};

const workspace = workspaceId("workspace-cell-lifecycle");
const dataset = unwrap(
  createDataset({
    datasetId: datasetId("dataset-cell-lifecycle"),
    name: "Cell lifecycle fixtures",
    workspaceId: workspace,
  })
);
const sourceField = unwrap(
  createField(dataset, {
    datasetId: dataset.datasetId,
    fieldId: fieldId("field-source"),
    key: "source",
    label: "Source",
    valueType: "string",
    workspaceId: workspace,
  })
);
const targetField = unwrap(
  createField(dataset, {
    datasetId: dataset.datasetId,
    fieldId: fieldId("field-target"),
    key: "target",
    label: "Target",
    valueType: "string",
    workspaceId: workspace,
  })
);
const fields = [sourceField, targetField] as const;
const record = unwrap(
  createRecord(dataset, fields, {
    datasetId: dataset.datasetId,
    recordId: recordId("record-cell-lifecycle"),
    values: [{ fieldId: sourceField.fieldId, value: "example.invalid" }],
    workspaceId: workspace,
  })
);
const recipe = unwrap(
  createEnrichmentRecipe(dataset, fields, {
    datasetId: dataset.datasetId,
    enrichmentRecipeId: enrichmentRecipeId("recipe-cell-lifecycle"),
    inputFieldIds: [sourceField.fieldId],
    name: "Resolve target",
    recipeRevision: "1.0.0",
    targetFieldId: targetField.fieldId,
    workflowContentHash: contentHash(`sha256:${"a".repeat(64)}`),
    workflowRevision: "1.0.0",
    workflowSpecId: workflowSpecId("workflow-cell-lifecycle"),
    workspaceId: workspace,
  })
);

const cell = (
  input: Omit<CellResult, "status"> & { status: CellResult["status"] }
) => unwrap(createCellResult(dataset, fields, record, recipe, input));

const pending = cell({
  cellResultId: cellResultId("cell-result-lifecycle"),
  datasetId: dataset.datasetId,
  enrichmentRecipeId: recipe.enrichmentRecipeId,
  fieldId: targetField.fieldId,
  recipeRevision: recipe.recipeRevision,
  recordId: record.recordId,
  runId: runId("run-cell-lifecycle"),
  status: "pending",
  workspaceId: workspace,
});
const running = cell({ ...pending, status: "running" });
const succeeded = cell({
  ...pending,
  confidence: 0.9,
  cost: { amount: 1, basis: "exact", unit: "credits" },
  freshness: { observedAt: instant(1000) },
  provenance: { references: ["artifact:synthetic"] },
  status: "succeeded",
  value: "resolved",
});
const failed = cell({
  ...pending,
  reason: {
    code: "provider-unavailable",
    message: "The configured capability is unavailable.",
    retryable: true,
  },
  status: "failed",
});
const skipped = cell({
  ...pending,
  reason: {
    code: "dependency-blocked",
    message: "A required dependency did not produce a value.",
    retryable: false,
  },
  status: "skipped",
});

test("moves pending to running and exact replays do not advance it", () => {
  const started = transitionCellResult(pending, running);
  assert.equal(started.ok, true);
  if (!started.ok) {
    return;
  }
  assert.equal(started.value.replayed, false);
  assert.equal(started.value.cellResult.status, "running");

  const replay = transitionCellResult(started.value.cellResult, running);
  assert.equal(replay.ok, true);
  if (replay.ok) {
    assert.equal(replay.value.replayed, true);
  }
});

test("allows pending and running cells to reach every terminal availability", () => {
  for (const terminal of [succeeded, failed, skipped]) {
    const direct = transitionCellResult(pending, terminal);
    const afterStart = transitionCellResult(running, terminal);
    assert.equal(direct.ok, true, terminal.status);
    assert.equal(afterStart.ok, true, terminal.status);
    if (afterStart.ok) {
      assert.equal(afterStart.value.cellResult.status, terminal.status);
      assert.equal(afterStart.value.replayed, false);
    }
  }
});

test("requires exact equality across every durable identity field", () => {
  const mismatches: CellResult[] = [
    { ...running, cellResultId: cellResultId("cell-result-other") },
    { ...running, datasetId: datasetId("dataset-other") },
    { ...running, enrichmentRecipeId: enrichmentRecipeId("recipe-other") },
    { ...running, fieldId: fieldId("field-other") },
    { ...running, recipeRevision: "2.0.0" },
    { ...running, recordId: recordId("record-other") },
    { ...running, runId: runId("run-other") },
    { ...running, workspaceId: workspaceId("workspace-other") },
  ];

  for (const mismatch of mismatches) {
    const result = transitionCellResult(pending, mismatch);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error.code, "cell-result-identity-mismatch");
    }
  }
});

test("rejects backward and same-state mutations that are not exact replays", () => {
  const backward = transitionCellResult(running, pending);
  const changedPending = transitionCellResult(pending, {
    ...pending,
    confidence: 0.5,
  });

  for (const result of [backward, changedPending]) {
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error.code, "cell-result-transition-invalid");
    }
  }
});

test("keeps terminal snapshots immutable while accepting exact deep replay", () => {
  const exactCopy: CellResult = {
    ...succeeded,
    cost: succeeded.cost === undefined ? undefined : { ...succeeded.cost },
    freshness:
      succeeded.freshness === undefined
        ? undefined
        : { ...succeeded.freshness },
    provenance:
      succeeded.provenance === undefined
        ? undefined
        : { references: [...succeeded.provenance.references] },
  };
  const replay = transitionCellResult(succeeded, exactCopy);
  assert.equal(replay.ok, true);
  if (replay.ok) {
    assert.equal(replay.value.replayed, true);
    assert.notStrictEqual(
      replay.value.cellResult.provenance,
      exactCopy.provenance
    );
  }

  for (const changed of [
    { ...succeeded, confidence: 0.8 },
    { ...succeeded, status: "failed" as const, value: undefined },
  ]) {
    const result = transitionCellResult(succeeded, changed);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error.code, "cell-result-terminal-immutable");
    }
  }
});
