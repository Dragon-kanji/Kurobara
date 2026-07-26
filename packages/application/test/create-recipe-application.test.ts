import assert from "node:assert/strict";
import test from "node:test";

import {
  actorId,
  contentHash,
  type Dataset,
  type Record as DatasetRecord,
  datasetId,
  datasetMaterializationId,
  type EnrichmentRecipe,
  enrichmentRecipeId,
  type Field,
  fieldId,
  instant,
  recordId,
  workflowSpecId,
  workspaceId,
} from "@kurobara/kernel";
import type {
  DatasetPersistencePort,
  RecipeApplication,
  RecipePersistencePort,
  RecipePersistenceUnitOfWork,
  StoredDataset,
  VerifiedApiKey,
  WorkspaceScope,
} from "@kurobara/ports";
import { canonicalContentHash } from "../src/canonical-content-hash.ts";
import {
  type CreateRecipeApplicationRequest,
  makeCreateRecipeApplication,
} from "../src/create-recipe-application.ts";

const workspace = workspaceId("workspace-recipe-application");
const dataset: Dataset = {
  datasetId: datasetId("dataset-recipe-application"),
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
  workflowContentHash: contentHash(`sha256:${"b".repeat(64)}`),
  workflowRevision: "workflow-r1",
  workflowSpecId: workflowSpecId("workflow-website"),
  workspaceId: workspace,
};
const actor: VerifiedApiKey = {
  actorId: actorId("actor-recipe-application"),
  authenticationMode: "api-key",
  credentialId: "credential-recipe-application",
  permissions: ["recipes:apply"],
  workspaceId: workspace,
};

const record = (
  identity: string,
  overrides: Partial<DatasetRecord> = {}
): DatasetRecord => ({
  datasetId: dataset.datasetId,
  recordId: recordId(identity),
  values: [{ fieldId: inputField.fieldId, value: `${identity}.invalid` }],
  workspaceId: workspace,
  ...overrides,
});

const storedDataset = (
  overrides: Partial<StoredDataset> = {}
): StoredDataset => ({
  dataset,
  fields,
  import: {
    batchCount: 1,
    datasetId: dataset.datasetId,
    errorCount: 0,
    importId: "import-recipe-application",
    itemCount: 2,
    recordCount: 2,
    state: "completed",
    workspaceId: workspace,
  },
  materialization: {
    completedAt: instant(2),
    completionReason: "source-exhausted",
    contentHash: contentHash(`sha256:${"d".repeat(64)}`),
    coverage: {
      basis: "imported_source",
      status: "complete_for_declared_source",
    },
    createdAt: instant(1),
    datasetId: dataset.datasetId,
    materializationId: datasetMaterializationId(dataset.datasetId),
    origin: { importId: "import-recipe-application", kind: "import" },
    recordCount: 2,
    rejectedCount: 0,
    revision: 2,
    schemaHash: contentHash(`sha256:${"e".repeat(64)}`),
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
  readonly records: readonly DatasetRecord[];
  readonly stored: StoredDataset | undefined;

  constructor(
    stored: StoredDataset | undefined,
    records: readonly DatasetRecord[]
  ) {
    this.stored = stored;
    this.records = records;
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

  streamRecords(): AsyncIterable<DatasetRecord> {
    const records = this.records;
    return {
      [Symbol.asyncIterator]: () => {
        const iterator = records[Symbol.iterator]();
        return { next: () => Promise.resolve(iterator.next()) };
      },
    };
  }
}

class FakeRecipePersistence implements RecipePersistencePort {
  readonly existingApplication: RecipeApplication | undefined;
  readonly registrations: RecipeApplication[] = [];
  readonly storedRecipe: EnrichmentRecipe | undefined;
  transactionCalls = 0;

  constructor(
    storedRecipe: EnrichmentRecipe | undefined,
    existingApplication?: RecipeApplication
  ) {
    this.existingApplication = existingApplication;
    this.storedRecipe = storedRecipe;
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
        get: () => Promise.resolve(this.existingApplication),
        register: (_registerScope, application) => {
          this.registrations.push(application);
          return Promise.resolve();
        },
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
        get: () => Promise.resolve(this.storedRecipe),
        register: () => Promise.resolve(),
      },
    };
    return work(unitOfWork);
  }
}

const request = (
  overrides: Partial<CreateRecipeApplicationRequest> = {}
): CreateRecipeApplicationRequest => ({
  actor,
  datasetId: dataset.datasetId,
  maxCells: 100,
  recipeId: recipe.enrichmentRecipeId,
  recipeRevision: recipe.recipeRevision,
  ...overrides,
});

const makeUseCase = (
  options: {
    applicationId?: string;
    existingApplication?: RecipeApplication;
    now?: number;
    records?: readonly DatasetRecord[];
    stored?: StoredDataset;
    storedRecipe?: EnrichmentRecipe;
  } = {}
) => {
  const datasets = new FakeDatasets(
    Object.hasOwn(options, "stored") ? options.stored : storedDataset(),
    options.records ?? [record("record-b"), record("record-a")]
  );
  const persistence = new FakeRecipePersistence(
    Object.hasOwn(options, "storedRecipe") ? options.storedRecipe : recipe,
    options.existingApplication
  );
  let clockCalls = 0;
  let identifierCalls = 0;
  const useCase = makeCreateRecipeApplication({
    clock: {
      now: () => {
        clockCalls += 1;
        return Promise.resolve(instant(options.now ?? 1234));
      },
    },
    datasets,
    identifiers: {
      nextRecipeApplicationId: () => {
        identifierCalls += 1;
        return Promise.resolve(options.applicationId ?? "application-test");
      },
    },
    persistence,
    requiredPermission: "recipes:apply",
  });
  return {
    get clockCalls() {
      return clockCalls;
    },
    datasets,
    get identifierCalls() {
      return identifierCalls;
    },
    persistence,
    useCase,
  };
};

test("rejects authorization and invalid hard bounds before any I/O", async () => {
  const unauthorized = makeUseCase();
  const unauthorizedResult = await unauthorized.useCase(
    request({ actor: { ...actor, permissions: [] } })
  );
  assert.equal(unauthorizedResult.ok, false);
  if (!unauthorizedResult.ok) {
    assert.equal(unauthorizedResult.error.code, "authority-permission-missing");
  }
  assert.equal(unauthorized.datasets.getCalls, 0);

  for (const maxCells of [0, 10_001, 1.5]) {
    const harness = makeUseCase();
    const result = await harness.useCase(request({ maxCells }));
    assert.equal(result.ok, false, `maxCells ${maxCells}`);
    if (!result.ok) {
      assert.equal(result.error.code, "recipe-application-limit-invalid");
    }
    assert.equal(harness.datasets.getCalls, 0);
    assert.equal(harness.persistence.transactionCalls, 0);
  }
});

test("rejects malformed exact selections before dataset I/O", async () => {
  const cases = [
    { code: "record-selection-invalid", recordIds: [] },
    {
      code: "record-selection-duplicate",
      recordIds: [recordId("record-a"), recordId("record-a")],
    },
    {
      code: "record-selection-invalid",
      maxCells: 1,
      recordIds: [recordId("record-a"), recordId("record-b")],
    },
  ] as const;

  for (const entry of cases) {
    const harness = makeUseCase();
    const result = await harness.useCase(
      request({
        maxCells: "maxCells" in entry ? entry.maxCells : 100,
        recordIds: entry.recordIds,
      })
    );
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error.code, entry.code);
    }
    assert.equal(harness.datasets.getCalls, 0);
    assert.equal(harness.persistence.transactionCalls, 0);
  }
});

test("fails closed for missing, cross-workspace, and incomplete datasets", async () => {
  const otherWorkspace = workspaceId("workspace-other");
  const cases = [
    { code: "dataset-not-found", name: "missing", stored: undefined },
    {
      code: "dataset-not-found",
      name: "cross-workspace",
      stored: storedDataset({
        materialization: {
          ...storedDataset().materialization,
          workspaceId: otherWorkspace,
        },
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
    const harness = makeUseCase({ stored: entry.stored });
    const result = await harness.useCase(request());
    assert.equal(result.ok, false, entry.name);
    if (!result.ok) {
      assert.equal(result.error.code, entry.code, entry.name);
    }
    assert.equal(harness.persistence.transactionCalls, 0, entry.name);
  }
});

test("preflights empty, duplicate, cross-scope, and overflowing record streams before recipe persistence", async () => {
  const otherWorkspace = workspaceId("workspace-other-record");
  const cases = [
    { code: "recipe-application-empty", name: "empty", records: [] },
    {
      code: "record-duplicate",
      name: "duplicate",
      records: [record("record-a"), record("record-a")],
    },
    {
      code: "record-scope-mismatch",
      name: "cross-scope",
      records: [
        record("record-a", {
          workspaceId: otherWorkspace,
        }),
      ],
    },
    {
      code: "recipe-application-limit-exceeded",
      maxCells: 1,
      name: "overflow",
      records: [record("record-a"), record("record-b")],
    },
  ] as const;

  for (const entry of cases) {
    const harness = makeUseCase({ records: entry.records });
    const result = await harness.useCase(
      request({ maxCells: "maxCells" in entry ? entry.maxCells : 100 })
    );
    assert.equal(result.ok, false, entry.name);
    if (!result.ok) {
      assert.equal(result.error.code, entry.code, entry.name);
    }
    assert.equal(harness.clockCalls, 0, entry.name);
    assert.equal(harness.identifierCalls, 0, entry.name);
    assert.equal(harness.persistence.transactionCalls, 0, entry.name);
    assert.deepEqual(harness.persistence.registrations, [], entry.name);
  }
});

test("requires the exact recipe revision after record preflight", async () => {
  const harness = makeUseCase({ storedRecipe: undefined });
  const result = await harness.useCase(request());

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, "recipe-not-found");
  }
  assert.equal(harness.persistence.transactionCalls, 1);
  assert.deepEqual(harness.persistence.registrations, []);
});

test("rejects an exact selection containing a record outside the dataset", async () => {
  const harness = makeUseCase({ records: [record("record-a")] });
  const result = await harness.useCase(
    request({
      recordIds: [recordId("record-a"), recordId("record-missing")],
    })
  );

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, "record-not-found");
    assert.equal(result.error.recordId, recordId("record-missing"));
  }
  assert.equal(harness.clockCalls, 0);
  assert.equal(harness.identifierCalls, 0);
  assert.equal(harness.persistence.transactionCalls, 0);
});

test("registers only the exact selected records in caller order", async () => {
  const records = [record("record-a"), record("record-b"), record("record-c")];
  const harness = makeUseCase({ records });
  const result = await harness.useCase(
    request({
      aggregateBudget: { limit: 2, unit: "credits" },
      maxCells: 2,
      recordIds: [recordId("record-c"), recordId("record-a")],
    })
  );

  assert.equal(result.ok, true);
  if (!result.ok) {
    return;
  }
  assert.deepEqual(result.value.application.graph.recordIds, [
    recordId("record-c"),
    recordId("record-a"),
  ]);
  assert.deepEqual(result.value.application.aggregateBudget, {
    limit: 2,
    unit: "credits",
  });
  assert.equal(result.value.application.maxCells, 2);
});

test("registers one immutable application with ordered IDs and canonical hashes", async () => {
  const records = [record("record-b"), record("record-a")];
  const harness = makeUseCase({ records });
  const result = await harness.useCase(request({ maxCells: 2 }));

  assert.equal(result.ok, true);
  if (!result.ok) {
    return;
  }
  const graph = { recordIds: records.map((entry) => entry.recordId) };
  const graphHash = canonicalContentHash(graph);
  const intentEvidence = {
    datasetId: dataset.datasetId,
    graphHash,
    maxCells: 2,
    recipeId: recipe.enrichmentRecipeId,
    recipeRevision: recipe.recipeRevision,
    targetFieldId: recipe.targetFieldId,
    workspaceId: workspace,
  } as const;

  assert.equal(result.value.replayed, false);
  assert.deepEqual(result.value.application, {
    createdAt: instant(1234),
    datasetId: dataset.datasetId,
    graph,
    graphHash,
    intentHash: canonicalContentHash(intentEvidence),
    maxCells: 2,
    recipeApplicationId: "application-test",
    recipeId: recipe.enrichmentRecipeId,
    recipeRevision: recipe.recipeRevision,
    targetFieldId: recipe.targetFieldId,
    workspaceId: workspace,
  });
  assert.deepEqual(harness.persistence.registrations, [
    result.value.application,
  ]);
  assert.deepEqual(result.value.application.graph.recordIds, [
    recordId("record-b"),
    recordId("record-a"),
  ]);
  assert.equal(Object.hasOwn(result.value.application.graph, "records"), false);
  assert.notEqual(
    harness.persistence.registrations[0]?.graph.recordIds,
    result.value.application.graph.recordIds
  );
});

test("replays the exact application ID independent of a later clock value", async () => {
  const initial = makeUseCase();
  const created = await initial.useCase(request());
  assert.equal(created.ok, true);
  if (!created.ok) {
    return;
  }

  const replay = makeUseCase({
    existingApplication: created.value.application,
    now: 9999,
  });
  const result = await replay.useCase(request());

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.value.replayed, true);
    assert.deepEqual(result.value.application, created.value.application);
    assert.equal(result.value.application.createdAt, instant(1234));
  }
  assert.deepEqual(replay.persistence.registrations, []);
});

test("rejects reuse of an application ID with different exact intent", async () => {
  const initial = makeUseCase();
  const created = await initial.useCase(request());
  assert.equal(created.ok, true);
  if (!created.ok) {
    return;
  }
  const existing = {
    ...created.value.application,
    maxCells: created.value.application.maxCells + 1,
  };
  const conflict = makeUseCase({ existingApplication: existing });
  const result = await conflict.useCase(request());

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, "recipe-application-conflict");
  }
  assert.deepEqual(conflict.persistence.registrations, []);
});
