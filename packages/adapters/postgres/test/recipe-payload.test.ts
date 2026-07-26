import assert from "node:assert/strict";
import test from "node:test";

import {
  cellResultId,
  contentHash,
  createDataset,
  createEnrichmentRecipe,
  createField,
  createRecord,
  datasetId,
  enrichmentRecipeId,
  fieldId,
  instant,
  recordId,
  runId,
  workflowSpecId,
  workspaceId,
} from "@kurobara/kernel";

import { DatabasePayloadError } from "../src/errors.ts";
import {
  parseCellResultPayload,
  parseRecipeApplicationPayload,
  parseRecipeCellCacheIdentity,
  parseRecipePayload,
  recipeApplicationGraphHash,
  recipeApplicationIntentHash,
  recipeCanonicalHash,
  resolveExactRecipeCellInput,
} from "../src/recipe-payload.ts";

const workspace = workspaceId("workspace-recipe-payload");
const createdDataset = createDataset({
  datasetId: datasetId("dataset-recipe-payload"),
  name: "Synthetic recipe dataset",
  workspaceId: workspace,
});
if (!createdDataset.ok) {
  throw new Error("Dataset fixture is invalid.");
}
const dataset = createdDataset.value;

const createFixtureField = (
  id: string,
  key: string,
  valueType: "boolean" | "number" | "string"
) => {
  const created = createField(dataset, {
    datasetId: dataset.datasetId,
    fieldId: fieldId(id),
    key,
    label: key,
    valueType,
    workspaceId: workspace,
  });
  if (!created.ok) {
    throw new Error("Field fixture is invalid.");
  }
  return created.value;
};

const domainField = createFixtureField("field-domain", "domain", "string");
const categoryField = createFixtureField(
  "field-category",
  "category",
  "string"
);
const fields = [domainField, categoryField] as const;

const presentNullRecordResult = createRecord(dataset, fields, {
  datasetId: dataset.datasetId,
  recordId: recordId("record-present-null"),
  values: [{ fieldId: domainField.fieldId, value: null }],
  workspaceId: workspace,
});
const missingRecordResult = createRecord(dataset, fields, {
  datasetId: dataset.datasetId,
  recordId: recordId("record-missing"),
  values: [],
  workspaceId: workspace,
});
const missingSameIdentityResult = createRecord(dataset, fields, {
  datasetId: dataset.datasetId,
  recordId: recordId("record-present-null"),
  values: [],
  workspaceId: workspace,
});
if (
  !(
    presentNullRecordResult.ok &&
    missingRecordResult.ok &&
    missingSameIdentityResult.ok
  )
) {
  throw new Error("Record fixtures are invalid.");
}
const presentNullRecord = presentNullRecordResult.value;
const missingRecord = missingRecordResult.value;
const missingSameIdentity = missingSameIdentityResult.value;

const recipeResult = createEnrichmentRecipe(dataset, fields, {
  datasetId: dataset.datasetId,
  enrichmentRecipeId: enrichmentRecipeId("recipe-category"),
  inputFieldIds: [domainField.fieldId],
  name: "Resolve category",
  recipeRevision: "1.0.0",
  targetFieldId: categoryField.fieldId,
  workflowContentHash: contentHash(
    "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  ),
  workflowRevision: "1",
  workflowSpecId: workflowSpecId("workflow-category"),
  workspaceId: workspace,
});
if (!recipeResult.ok) {
  throw new Error("Recipe fixture is invalid.");
}
const recipe = recipeResult.value;

const graph = {
  recordIds: [presentNullRecord.recordId, missingRecord.recordId],
};
const graphHash = recipeApplicationGraphHash(graph);
const applicationWithoutIntent = {
  createdAt: instant(1000),
  datasetId: dataset.datasetId,
  graph,
  graphHash,
  maxCells: 2,
  recipeApplicationId: "application-category",
  recipeId: recipe.enrichmentRecipeId,
  recipeRevision: recipe.recipeRevision,
  targetFieldId: recipe.targetFieldId,
  workspaceId: workspace,
};
const application = {
  ...applicationWithoutIntent,
  intentHash: recipeApplicationIntentHash(applicationWithoutIntent),
};

const recipeIdentity = {
  datasetId: dataset.datasetId,
  enrichmentRecipeId: recipe.enrichmentRecipeId,
  inputFieldIds: recipe.inputFieldIds,
  recipeRevision: recipe.recipeRevision,
  targetFieldId: recipe.targetFieldId,
  workflowContentHash: recipe.workflowContentHash,
  workflowRevision: recipe.workflowRevision,
  workflowSpecId: recipe.workflowSpecId,
  workspaceId: recipe.workspaceId,
};

const applicationIdentity = {
  datasetId: application.datasetId,
  graphHash: application.graphHash,
  intentHash: application.intentHash,
  recipeApplicationId: application.recipeApplicationId,
  recipeId: application.recipeId,
  recipeRevision: application.recipeRevision,
  targetFieldId: application.targetFieldId,
  workspaceId: application.workspaceId,
};

test("parses exact recipe and immutable application payload identities", () => {
  assert.deepEqual(
    parseRecipePayload(recipe, dataset, fields, recipeIdentity),
    recipe
  );
  assert.deepEqual(
    parseRecipeApplicationPayload(application, applicationIdentity),
    application
  );
});

test("parses and hashes an immutable aggregate recipe budget", () => {
  const budgetedWithoutIntent = {
    ...applicationWithoutIntent,
    aggregateBudget: { limit: 2, unit: "credits" },
  } as const;
  const budgeted = {
    ...budgetedWithoutIntent,
    intentHash: recipeApplicationIntentHash(budgetedWithoutIntent),
  };

  assert.deepEqual(
    parseRecipeApplicationPayload(budgeted, {
      ...applicationIdentity,
      intentHash: budgeted.intentHash,
    }),
    budgeted
  );
  assert.notEqual(budgeted.intentHash, application.intentHash);
});

test("rejects relational identity drift and recomputes application hashes", () => {
  assert.throws(
    () =>
      parseRecipePayload(recipe, dataset, fields, {
        ...recipeIdentity,
        workflowRevision: "2",
      }),
    DatabasePayloadError
  );
  assert.throws(
    () =>
      parseRecipeApplicationPayload(
        { ...application, graphHash: recipe.workflowContentHash },
        applicationIdentity
      ),
    DatabasePayloadError
  );
  assert.throws(
    () =>
      parseRecipeApplicationPayload(
        {
          ...application,
          graph: {
            recordIds: [presentNullRecord.recordId, presentNullRecord.recordId],
          },
        },
        applicationIdentity
      ),
    DatabasePayloadError
  );
});

test("distinguishes a missing input from an explicit null in exact hashes", () => {
  const explicitNull = resolveExactRecipeCellInput(
    application,
    dataset,
    recipe,
    presentNullRecord,
    "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
  );
  const missing = resolveExactRecipeCellInput(
    application,
    dataset,
    recipe,
    missingSameIdentity,
    "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
  );

  assert.deepEqual(explicitNull.inputValues, [
    { fieldId: domainField.fieldId, present: true, value: null },
  ]);
  assert.deepEqual(missing.inputValues, [
    { fieldId: domainField.fieldId, present: false },
  ]);
  assert.notEqual(explicitNull.inputHash, missing.inputHash);
  assert.notEqual(explicitNull.cacheKey, missing.cacheKey);
  assert.equal(
    recipeCanonicalHash(explicitNull.normalizedInput),
    explicitNull.inputHash
  );
  assert.equal(recipeCanonicalHash(missing.normalizedInput), missing.inputHash);
  assert.deepEqual(
    parseRecipeCellCacheIdentity(
      {
        datasetId: explicitNull.datasetId,
        inputHash: explicitNull.inputHash,
        recipeId: explicitNull.recipeId,
        recipeRevision: explicitNull.recipeRevision,
        recordContentHash: explicitNull.recordContentHash,
        recordId: explicitNull.recordId,
        targetFieldId: explicitNull.targetFieldId,
        workflowContentHash: explicitNull.workflowContentHash,
        workflowRevision: explicitNull.workflowRevision,
        workflowSpecId: explicitNull.workflowSpecId,
        workspaceId: explicitNull.workspaceId,
      },
      explicitNull.cacheKey
    ),
    {
      datasetId: explicitNull.datasetId,
      inputHash: explicitNull.inputHash,
      recipeId: explicitNull.recipeId,
      recipeRevision: explicitNull.recipeRevision,
      recordContentHash: explicitNull.recordContentHash,
      recordId: explicitNull.recordId,
      targetFieldId: explicitNull.targetFieldId,
      workflowContentHash: explicitNull.workflowContentHash,
      workflowRevision: explicitNull.workflowRevision,
      workflowSpecId: explicitNull.workflowSpecId,
      workspaceId: explicitNull.workspaceId,
    }
  );
});

test("parses cell results through status and exact relational evidence", () => {
  const cell = {
    cellResultId: cellResultId("cell-category"),
    datasetId: dataset.datasetId,
    enrichmentRecipeId: recipe.enrichmentRecipeId,
    fieldId: recipe.targetFieldId,
    recipeRevision: recipe.recipeRevision,
    recordId: presentNullRecord.recordId,
    runId: runId("run-category"),
    status: "succeeded" as const,
    value: null,
    workspaceId: workspace,
  };
  const identity = {
    cellResultId: cell.cellResultId,
    datasetId: cell.datasetId,
    enrichmentRecipeId: cell.enrichmentRecipeId,
    fieldId: cell.fieldId,
    recipeRevision: cell.recipeRevision,
    recordId: cell.recordId,
    runId: cell.runId,
    status: cell.status,
    workspaceId: cell.workspaceId,
  };
  assert.deepEqual(
    parseCellResultPayload(
      cell,
      dataset,
      fields,
      presentNullRecord,
      recipe,
      identity
    ),
    cell
  );
  assert.throws(
    () =>
      parseCellResultPayload(cell, dataset, fields, presentNullRecord, recipe, {
        ...identity,
        runId: "run-other",
      }),
    DatabasePayloadError
  );
  const { value: _value, ...withoutValue } = cell;
  assert.throws(
    () =>
      parseCellResultPayload(
        withoutValue,
        dataset,
        fields,
        presentNullRecord,
        recipe,
        identity
      ),
    DatabasePayloadError
  );
});
