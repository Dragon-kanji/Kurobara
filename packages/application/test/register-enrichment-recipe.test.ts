import assert from "node:assert/strict";
import test from "node:test";

import {
  actorId,
  contentHash,
  type Dataset,
  datasetId,
  datasetMaterializationId,
  type EnrichmentRecipe,
  enrichmentRecipeId,
  type Field,
  fieldId,
  instant,
  workflowSpecId,
  workspaceId,
} from "@kurobara/kernel";
import type {
  DatasetPersistencePort,
  RecipePersistencePort,
  RecipePersistenceUnitOfWork,
  StoredDataset,
  VerifiedApiKey,
  WorkspaceScope,
} from "@kurobara/ports";
import {
  makeRegisterEnrichmentRecipe,
  type RegisterEnrichmentRecipeRequest,
} from "../src/register-enrichment-recipe.ts";

const workspace = workspaceId("workspace-recipe-registration");
const dataset: Dataset = {
  datasetId: datasetId("dataset-recipe-registration"),
  name: "Synthetic organizations",
  workspaceId: workspace,
};
const inputField: Field = {
  datasetId: dataset.datasetId,
  fieldId: fieldId("field-domain"),
  key: "domain",
  label: "Domain",
  valueType: "string",
  workspaceId: workspace,
};
const targetField: Field = {
  datasetId: dataset.datasetId,
  fieldId: fieldId("field-website"),
  key: "website",
  label: "Website",
  valueType: "string",
  workspaceId: workspace,
};
const fields = [inputField, targetField] as const;
const recipe: EnrichmentRecipe = {
  datasetId: dataset.datasetId,
  enrichmentRecipeId: enrichmentRecipeId("recipe-website"),
  inputFieldIds: [inputField.fieldId],
  name: "Find official website",
  recipeRevision: "recipe-r1",
  targetFieldId: targetField.fieldId,
  workflowContentHash: contentHash(`sha256:${"a".repeat(64)}`),
  workflowRevision: "workflow-r1",
  workflowSpecId: workflowSpecId("workflow-website"),
  workspaceId: workspace,
};
const actor: VerifiedApiKey = {
  actorId: actorId("actor-recipe-registration"),
  authenticationMode: "api-key",
  credentialId: "credential-recipe-registration",
  permissions: ["recipes:register"],
  workspaceId: workspace,
};

const storedDataset = (
  overrides: Partial<StoredDataset> = {}
): StoredDataset => ({
  dataset,
  fields,
  import: {
    batchCount: 1,
    datasetId: dataset.datasetId,
    errorCount: 0,
    importId: "import-recipe-registration",
    itemCount: 1,
    recordCount: 1,
    state: "completed",
    workspaceId: workspace,
  },
  materialization: {
    completedAt: instant(2),
    completionReason: "source-exhausted",
    contentHash: contentHash(`sha256:${"b".repeat(64)}`),
    coverage: {
      basis: "imported_source",
      status: "complete_for_declared_source",
    },
    createdAt: instant(1),
    datasetId: dataset.datasetId,
    materializationId: datasetMaterializationId(dataset.datasetId),
    origin: { importId: "import-recipe-registration", kind: "import" },
    recordCount: 1,
    rejectedCount: 0,
    revision: 2,
    schemaHash: contentHash(`sha256:${"c".repeat(64)}`),
    state: "ready",
    workspaceId: workspace,
  },
  ...overrides,
});

const emptyAsyncIterable = (): AsyncIterable<never> => ({
  [Symbol.asyncIterator]: () => ({
    next: () => Promise.resolve({ done: true, value: undefined }),
  }),
});

class FakeDatasets implements DatasetPersistencePort {
  getCalls = 0;
  readonly stored: StoredDataset | undefined;

  constructor(stored: StoredDataset | undefined) {
    this.stored = stored;
  }

  getDataset(): Promise<StoredDataset | undefined> {
    this.getCalls += 1;
    return Promise.resolve(this.stored);
  }

  appendImportBatch(): never {
    throw new Error("not used");
  }

  beginImport(): never {
    throw new Error("not used");
  }

  finishImport(): never {
    throw new Error("not used");
  }

  isFieldSetComplete(): never {
    throw new Error("not used");
  }

  resetImport(): never {
    throw new Error("not used");
  }

  streamImportIssues(): AsyncIterable<never> {
    return emptyAsyncIterable();
  }

  streamRecords(): AsyncIterable<never> {
    return emptyAsyncIterable();
  }
}

class FakeRecipePersistence implements RecipePersistencePort {
  readonly existing: EnrichmentRecipe | undefined;
  readonly registrations: EnrichmentRecipe[] = [];
  readonly recipeGets: Readonly<{
    datasetId: string;
    recipeId: string;
    revision: string;
  }>[] = [];
  transactionCalls = 0;

  constructor(existing?: EnrichmentRecipe) {
    this.existing = existing;
  }

  streamExactProjection(): AsyncIterable<never> {
    return emptyAsyncIterable();
  }

  transaction<Value>(
    _scope: WorkspaceScope,
    work: (unitOfWork: RecipePersistenceUnitOfWork) => Promise<Value>
  ): Promise<Value> {
    this.transactionCalls += 1;
    const unitOfWork: RecipePersistenceUnitOfWork = {
      applicationCells: { get: () => Promise.resolve(undefined) },
      applications: {
        get: () => Promise.resolve(undefined),
        register: () => Promise.resolve(),
      },
      cache: {
        getForUpdate: () => Promise.resolve(undefined),
      },
      cachedBindings: {
        pinActive: () => Promise.resolve(),
        pinCached: () => Promise.resolve(true),
      },
      cellResults: { getByRun: () => Promise.resolve(undefined) },
      inputs: { resolveExact: () => Promise.resolve(undefined) },
      recipes: {
        get: (_getScope, requestedDatasetId, recipeId, revision) => {
          this.recipeGets.push({
            datasetId: requestedDatasetId,
            recipeId,
            revision,
          });
          return Promise.resolve(this.existing);
        },
        register: (_registerScope, registered) => {
          this.registrations.push(registered);
          return Promise.resolve();
        },
      },
    };
    return work(unitOfWork);
  }
}

const request = (
  overrides: Partial<RegisterEnrichmentRecipeRequest> = {}
): RegisterEnrichmentRecipeRequest => ({
  actor,
  datasetId: dataset.datasetId,
  recipe,
  ...overrides,
});

const makeUseCase = (
  stored: StoredDataset | null = storedDataset(),
  existing?: EnrichmentRecipe
) => {
  const datasets = new FakeDatasets(stored ?? undefined);
  const persistence = new FakeRecipePersistence(existing);
  return {
    datasets,
    persistence,
    useCase: makeRegisterEnrichmentRecipe({
      datasets,
      persistence,
      requiredPermission: "recipes:register",
    }),
  };
};

test("rejects a missing permission before dataset or recipe persistence", async () => {
  const harness = makeUseCase();
  const result = await harness.useCase(
    request({ actor: { ...actor, permissions: [] } })
  );

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, "authority-permission-missing");
  }
  assert.equal(harness.datasets.getCalls, 0);
  assert.equal(harness.persistence.transactionCalls, 0);
});

test("fails closed for missing, cross-workspace, and incomplete datasets", async () => {
  const otherWorkspace = workspaceId("workspace-other");
  const cases = [
    {
      code: "dataset-not-found",
      name: "missing",
      stored: null,
    },
    {
      code: "dataset-not-found",
      name: "cross-workspace",
      stored: storedDataset({
        dataset: { ...dataset, workspaceId: otherWorkspace },
      }),
    },
    {
      code: "dataset-not-ready",
      name: "incomplete",
      stored: storedDataset({
        materialization: {
          ...storedDataset().materialization,
          state: "building",
        },
      }),
    },
  ] as const;

  for (const entry of cases) {
    const harness = makeUseCase(entry.stored);
    const result = await harness.useCase(request());
    assert.equal(result.ok, false, entry.name);
    if (!result.ok) {
      assert.equal(result.error.code, entry.code, entry.name);
    }
    assert.equal(harness.persistence.transactionCalls, 0, entry.name);
  }
});

test("surfaces recipe domain rejection without opening a transaction", async () => {
  const harness = makeUseCase();
  const result = await harness.useCase(
    request({ recipe: { ...recipe, inputFieldIds: [] } })
  );

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, "recipe-domain-rejected");
    assert.equal(result.error.domainCode, "recipe-input-required");
  }
  assert.equal(harness.persistence.transactionCalls, 0);
});

test("registers the validated immutable recipe under its exact revision", async () => {
  const harness = makeUseCase();
  const result = await harness.useCase(request());

  assert.equal(result.ok, true);
  if (!result.ok) {
    return;
  }
  assert.equal(result.value.replayed, false);
  assert.deepEqual(result.value.recipe, recipe);
  assert.deepEqual(harness.persistence.recipeGets, [
    {
      datasetId: dataset.datasetId,
      recipeId: recipe.enrichmentRecipeId,
      revision: recipe.recipeRevision,
    },
  ]);
  assert.deepEqual(harness.persistence.registrations, [recipe]);
  assert.notEqual(
    harness.persistence.registrations[0]?.inputFieldIds,
    recipe.inputFieldIds
  );
});

test("returns an exact replay without registering again", async () => {
  const harness = makeUseCase(storedDataset(), recipe);
  const result = await harness.useCase(request());

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.value.replayed, true);
    assert.deepEqual(result.value.recipe, recipe);
  }
  assert.deepEqual(harness.persistence.registrations, []);
});

test("rejects content or revision drift returned for the immutable key", async () => {
  for (const existing of [
    { ...recipe, name: "Changed recipe" },
    { ...recipe, recipeRevision: "recipe-r2" },
  ]) {
    const harness = makeUseCase(storedDataset(), existing);
    const result = await harness.useCase(request());
    assert.equal(result.ok, false, existing.recipeRevision);
    if (!result.ok) {
      assert.equal(result.error.code, "recipe-revision-conflict");
    }
    assert.deepEqual(harness.persistence.registrations, []);
  }
});
