import assert from "node:assert/strict";
import test from "node:test";

import {
  contentHash,
  createDataset,
  createEnrichmentRecipe,
  createField,
  type Dataset,
  datasetId,
  enrichmentRecipeId,
  type Field,
  fieldId,
  workflowSpecId,
  workspaceId,
} from "@kurobara/kernel";

import {
  compileRecipeFieldGraph,
  type RecipeFieldGraphCompilationFailureCode,
} from "../src/index.ts";

const workspace = workspaceId("workspace-recipe-graph");
const dataset = createDataset({
  datasetId: datasetId("dataset-recipe-graph"),
  name: "Recipe graph fixtures",
  workspaceId: workspace,
});
if (!dataset.ok) {
  throw new Error(dataset.error.message);
}

const field = (id: string, key: string): Field => {
  const created = createField(dataset.value, {
    datasetId: dataset.value.datasetId,
    fieldId: fieldId(id),
    key,
    label: key,
    valueType: "string",
    workspaceId: workspace,
  });
  if (!created.ok) {
    throw new Error(created.error.message);
  }
  return created.value;
};

const source = field("field-source", "source");
const normalized = field("field-normalized", "normalized");
const website = field("field-website", "website");
const category = field("field-category", "category");
const score = field("field-score", "score");
const fields = [source, normalized, website, category, score] as const;

const recipe = (
  id: string,
  inputs: readonly Field["fieldId"][],
  target: Field,
  revision = "1.0.0"
) => {
  const created = createEnrichmentRecipe(dataset.value, fields, {
    datasetId: dataset.value.datasetId,
    enrichmentRecipeId: enrichmentRecipeId(id),
    inputFieldIds: inputs,
    name: id,
    recipeRevision: revision,
    targetFieldId: target.fieldId,
    workflowContentHash: contentHash(
      `sha256:${id.charCodeAt(0).toString(16).padStart(2, "0").repeat(32)}`
    ),
    workflowRevision: revision,
    workflowSpecId: workflowSpecId(`workflow-${id}`),
    workspaceId: workspace,
  });
  if (!created.ok) {
    throw new Error(created.error.message);
  }
  return created.value;
};

const normalize = recipe("recipe-normalize", [source.fieldId], normalized);
const resolveWebsite = recipe("recipe-website", [normalized.fieldId], website);
const resolveCategory = recipe(
  "recipe-category",
  [normalized.fieldId],
  category
);
const scoreWebsite = recipe("recipe-score", [website.fieldId], score);

const compile = (
  recipes: readonly ReturnType<typeof recipe>[],
  limits = { maxDepth: 4, maxFanOut: 3, maxNodes: 8 },
  selectedFields: readonly Field[] = fields,
  selectedDataset: Dataset = dataset.value
) =>
  compileRecipeFieldGraph({
    dataset: selectedDataset,
    fields: selectedFields,
    limits,
    recipes,
  });

const failureCode = (
  result: ReturnType<typeof compile>
): RecipeFieldGraphCompilationFailureCode => {
  if (result.ok) {
    throw new Error("Expected recipe field graph compilation to fail.");
  }
  return result.error.code;
};

test("compiles a stable field DAG and keeps unproduced fields as source inputs", () => {
  const first = compile([
    scoreWebsite,
    resolveCategory,
    resolveWebsite,
    normalize,
  ]);
  const second = compile([
    normalize,
    resolveWebsite,
    scoreWebsite,
    resolveCategory,
  ]);

  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  if (!(first.ok && second.ok)) {
    return;
  }
  assert.deepEqual(first.value, second.value);
  assert.deepEqual(first.value.sourceFieldIds, [source.fieldId]);
  assert.deepEqual(
    first.value.nodes.map((node) => [node.targetFieldId, node.depth]),
    [
      [normalized.fieldId, 0],
      [category.fieldId, 1],
      [website.fieldId, 1],
      [score.fieldId, 2],
    ]
  );
  assert.deepEqual(first.value.nodes[0]?.dependsOn, []);
  assert.deepEqual(first.value.nodes[1]?.dependsOn, [normalized.fieldId]);
  assert.equal(first.value.fingerprint, second.value.fingerprint);
});

test("rejects cross-scope recipes and invalid dataset field collections", () => {
  assert.equal(
    failureCode(
      compile([
        {
          ...normalize,
          workspaceId: workspaceId("workspace-other"),
        },
      ])
    ),
    "recipe-scope-mismatch"
  );
  assert.equal(
    failureCode(
      compile([normalize], undefined, [
        { ...source, datasetId: datasetId("dataset-other") },
      ])
    ),
    "field-collection-invalid"
  );
});

test("rejects duplicate recipe identities, targets and input fields", () => {
  assert.equal(
    failureCode(
      compile([
        normalize,
        {
          ...resolveWebsite,
          enrichmentRecipeId: normalize.enrichmentRecipeId,
        },
      ])
    ),
    "duplicate-recipe-identity"
  );
  assert.equal(
    failureCode(
      compile([
        normalize,
        {
          ...resolveWebsite,
          targetFieldId: normalize.targetFieldId,
        },
      ])
    ),
    "duplicate-target-field"
  );
  assert.equal(
    failureCode(
      compile([
        {
          ...normalize,
          inputFieldIds: [source.fieldId, source.fieldId],
        },
      ])
    ),
    "duplicate-input-field"
  );
});

test("rejects self dependencies and fields outside the dataset", () => {
  assert.equal(
    failureCode(
      compile([{ ...normalize, inputFieldIds: [normalize.targetFieldId] }])
    ),
    "self-dependency"
  );
  assert.equal(
    failureCode(
      compile([{ ...normalize, inputFieldIds: [fieldId("field-unknown")] }])
    ),
    "unknown-input-field"
  );
  assert.equal(
    failureCode(
      compile([{ ...normalize, targetFieldId: fieldId("field-unknown") }])
    ),
    "unknown-target-field"
  );
});

test("detects indirect cycles independently of recipe source order", () => {
  const cyclicNormalize = {
    ...normalize,
    inputFieldIds: [website.fieldId],
  };
  assert.equal(
    failureCode(compile([resolveWebsite, cyclicNormalize])),
    "cycle-detected"
  );
  assert.equal(
    failureCode(compile([cyclicNormalize, resolveWebsite])),
    "cycle-detected"
  );
});

test("enforces bounded node count, depth, fan-out and limit definitions", () => {
  assert.equal(
    failureCode(
      compile([normalize, resolveWebsite], {
        maxDepth: 2,
        maxFanOut: 2,
        maxNodes: 1,
      })
    ),
    "node-limit-exceeded"
  );
  assert.equal(
    failureCode(
      compile([normalize, resolveWebsite, scoreWebsite], {
        maxDepth: 1,
        maxFanOut: 2,
        maxNodes: 3,
      })
    ),
    "depth-limit-exceeded"
  );
  assert.equal(
    failureCode(
      compile([normalize, resolveWebsite, resolveCategory], {
        maxDepth: 2,
        maxFanOut: 1,
        maxNodes: 3,
      })
    ),
    "fan-out-limit-exceeded"
  );
  assert.equal(
    failureCode(
      compile([normalize], { maxDepth: -1, maxFanOut: 1, maxNodes: 1 })
    ),
    "invalid-limits"
  );
});

test("counts source-field consumers toward the fan-out limit", () => {
  const categorizeSource = recipe(
    "recipe-source-category",
    [source.fieldId],
    category
  );
  const result = compile([normalize, categorizeSource], {
    maxDepth: 0,
    maxFanOut: 1,
    maxNodes: 2,
  });

  assert.equal(failureCode(result), "fan-out-limit-exceeded");
  if (result.ok) {
    return;
  }
  assert.equal(result.error.targetFieldId, source.fieldId);
});
