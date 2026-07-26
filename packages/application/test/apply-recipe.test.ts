import assert from "node:assert/strict";
import test from "node:test";

import {
  actorId,
  capabilityId,
  contentHash,
  correlationId,
  type Dataset,
  type Record as DatasetRecord,
  datasetId,
  datasetMaterializationId,
  type EnrichmentRecipe,
  enrichmentRecipeId,
  eventId,
  type Field,
  fieldId,
  instant,
  outboxMessageId,
  recordId,
  runId,
  runPlanId,
  workflowSpecId,
  workspaceId,
} from "@kurobara/kernel";
import type {
  DatasetPersistencePort,
  ExactRecipeCellInput,
  ExactRecipeProjectionRow,
  PersistRunPlanInput,
  RecipeApplication,
  RecipeApplyPersistencePort,
  RecipeApplyUnitOfWork,
  RecipePersistencePort,
  RecipePersistenceUnitOfWork,
  RunCreationRecord,
  StoredDataset,
  StoredRunPlan,
  VerifiedApiKey,
  WorkspaceScope,
} from "@kurobara/ports";

import { makeApplyRecipe } from "../src/apply-recipe.ts";
import { canonicalContentHash } from "../src/canonical-content-hash.ts";

const hash = (marker: string) =>
  contentHash(`sha256:${marker.repeat(64).slice(0, 64)}`);
const workspace = workspaceId("workspace-apply-recipe");
const dataset: Dataset = {
  datasetId: datasetId("dataset-apply-recipe"),
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
const record: DatasetRecord = {
  datasetId: dataset.datasetId,
  recordId: recordId("record-apply-recipe"),
  values: [{ fieldId: inputField.fieldId, value: "synthetic.invalid" }],
  workspaceId: workspace,
};
const secondRecord: DatasetRecord = {
  datasetId: dataset.datasetId,
  recordId: recordId("record-apply-recipe-second"),
  values: [{ fieldId: inputField.fieldId, value: "second.invalid" }],
  workspaceId: workspace,
};
const capability = {
  capabilityId: capabilityId("organizations.website.resolve"),
  capabilityVersion: "1.0.0",
};
const contract = {
  catalogFingerprint: hash("a"),
  catalogVersion: "1.0.0",
  schemaFingerprint: hash("b"),
  schemaId: "https://schemas.kurobara.invalid/recipe-input/1.0.0",
  schemaVersion: "1.0.0",
};
const recipe: EnrichmentRecipe = {
  datasetId: dataset.datasetId,
  enrichmentRecipeId: enrichmentRecipeId("recipe-website"),
  inputFieldIds: [inputField.fieldId],
  name: "Find official website",
  recipeRevision: "recipe-r1",
  targetFieldId: targetField.fieldId,
  workflowContentHash: hash("c"),
  workflowRevision: "workflow-r1",
  workflowSpecId: workflowSpecId("workflow-website"),
  workspaceId: workspace,
};
const actor: VerifiedApiKey = {
  actorId: actorId("actor-apply-recipe"),
  authenticationMode: "api-key",
  credentialId: "credential-apply-recipe",
  permissions: ["recipes:register", "recipes:apply", "plans:quote"],
  workspaceId: workspace,
};
const applicationId = "application-apply-recipe";
const normalizedInput = {
  datasetId: dataset.datasetId,
  inputValues: [
    { fieldId: inputField.fieldId, present: true, value: "synthetic.invalid" },
  ],
  recipeId: recipe.enrichmentRecipeId,
  recipeRevision: recipe.recipeRevision,
  recordContentHash: hash("d"),
  recordId: record.recordId,
  targetFieldId: targetField.fieldId,
  workflowContentHash: recipe.workflowContentHash,
  workflowRevision: recipe.workflowRevision,
  workflowSpecId: recipe.workflowSpecId,
  workspaceId: workspace,
} as const;
const exactInput: ExactRecipeCellInput = {
  cacheKey: hash("e"),
  datasetId: dataset.datasetId,
  inputHash: canonicalContentHash(normalizedInput),
  inputValues: normalizedInput.inputValues,
  normalizedInput,
  recipeApplicationId: applicationId,
  recipeId: recipe.enrichmentRecipeId,
  recipeRevision: recipe.recipeRevision,
  recordContentHash: normalizedInput.recordContentHash,
  recordId: record.recordId,
  targetFieldId: recipe.targetFieldId,
  workflowContentHash: recipe.workflowContentHash,
  workflowRevision: recipe.workflowRevision,
  workflowSpecId: recipe.workflowSpecId,
  workspaceId: workspace,
};
const exactInputFor = (
  requestedRecord: DatasetRecord
): ExactRecipeCellInput => {
  if (requestedRecord.recordId === record.recordId) {
    return exactInput;
  }
  const value = requestedRecord.values[0]?.value;
  const input = {
    ...normalizedInput,
    inputValues: [
      { fieldId: inputField.fieldId, present: true, value: value ?? null },
    ],
    recordContentHash: hash("8"),
    recordId: requestedRecord.recordId,
  } as const;
  return {
    ...exactInput,
    cacheKey: hash("9"),
    inputHash: canonicalContentHash(input),
    inputValues: input.inputValues,
    normalizedInput: input,
    recordContentHash: input.recordContentHash,
    recordId: input.recordId,
  };
};
const storedImport = {
  batchCount: 1,
  datasetId: dataset.datasetId,
  errorCount: 0,
  importId: "import-apply-recipe",
  itemCount: 1,
  recordCount: 1,
  state: "completed",
  workspaceId: workspace,
} as const;
const storedDataset: StoredDataset = {
  dataset,
  fields: [inputField, targetField],
  import: storedImport,
  materialization: {
    completedAt: instant(2),
    completionReason: "source-exhausted",
    contentHash: hash("f"),
    coverage: {
      basis: "imported_source",
      status: "complete_for_declared_source",
    },
    createdAt: instant(1),
    datasetId: dataset.datasetId,
    materializationId: datasetMaterializationId(dataset.datasetId),
    origin: { importId: "import-apply-recipe", kind: "import" },
    recordCount: 1,
    rejectedCount: 0,
    revision: 2,
    schemaHash: hash("7"),
    state: "ready",
    workspaceId: workspace,
  },
};

const emptyAsyncIterable = (): AsyncIterable<never> => ({
  [Symbol.asyncIterator]: () => ({
    next: () => Promise.resolve({ done: true, value: undefined }),
  }),
});

class FakeDatasets implements DatasetPersistencePort {
  getCalls = 0;
  readonly records: readonly DatasetRecord[];

  constructor(records: readonly DatasetRecord[] = [record]) {
    this.records = records;
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

  getDataset(): Promise<StoredDataset> {
    this.getCalls += 1;
    return Promise.resolve({
      ...storedDataset,
      import: {
        ...storedImport,
        itemCount: this.records.length,
        recordCount: this.records.length,
      },
      materialization: {
        ...storedDataset.materialization,
        recordCount: this.records.length,
      },
    });
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

class FakeRecipes implements RecipePersistencePort {
  application: RecipeApplication | undefined;
  storedRecipe: EnrichmentRecipe | undefined;

  streamExactProjection(): AsyncIterable<never> {
    return emptyAsyncIterable();
  }

  transaction<Value>(
    _scope: WorkspaceScope,
    work: (unitOfWork: RecipePersistenceUnitOfWork) => Promise<Value>
  ): Promise<Value> {
    return work({
      applicationCells: { get: () => Promise.resolve(undefined) },
      applications: {
        get: () => Promise.resolve(this.application),
        register: (_registerScope, application) => {
          this.application = application;
          return Promise.resolve();
        },
      },
      cache: { getForUpdate: () => Promise.resolve(undefined) },
      cachedBindings: {
        pinActive: () => Promise.resolve(),
        pinCached: () => Promise.resolve(false),
      },
      cellResults: { getByRun: () => Promise.resolve(undefined) },
      inputs: { resolveExact: () => Promise.resolve(undefined) },
      recipes: {
        get: () => Promise.resolve(this.storedRecipe),
        register: (_registerScope, registered) => {
          this.storedRecipe = registered;
          return Promise.resolve();
        },
      },
    });
  }
}

class FakeApplyPersistence implements RecipeApplyPersistencePort {
  attemptedPlans = 0;
  readonly bindings = new Map<
    string,
    Readonly<{
      cellResult: ExactRecipeProjectionRow["cellResult"];
      input: ExactRecipeCellInput;
    }>
  >();
  boundRuns = 0;
  readonly committedPlans: PersistRunPlanInput[] = [];
  committedRuns = 0;
  readonly rejectCreation: boolean;
  readonly rejectRecordIdOnce: string | undefined;
  readonly records: readonly DatasetRecord[];
  readonly recipes: FakeRecipes;
  readonly rejectedRecordIds = new Set<string>();
  rollbacks = 0;

  constructor(
    recipes: FakeRecipes,
    options: Readonly<{
      records?: readonly DatasetRecord[];
      rejectCreation?: boolean;
      rejectRecordIdOnce?: string;
    }> = {}
  ) {
    this.recipes = recipes;
    this.records = options.records ?? [record];
    this.rejectCreation = options.rejectCreation ?? false;
    this.rejectRecordIdOnce = options.rejectRecordIdOnce;
  }

  async transaction<Value>(
    _scope: WorkspaceScope,
    work: (unitOfWork: RecipeApplyUnitOfWork) => Promise<Value>
  ): Promise<Value> {
    const stagedPlans: PersistRunPlanInput[] = [];
    let consumed: RunCreationRecord | undefined;
    let inputResolutions = 0;
    let resolvedInput: ExactRecipeCellInput | undefined;
    const stagedBindings: Readonly<{
      cellResult: ExactRecipeProjectionRow["cellResult"];
      input: ExactRecipeCellInput;
    }>[] = [];
    let stagedBoundRuns = 0;
    let stagedRuns = 0;
    const unitOfWork: RecipeApplyUnitOfWork = {
      applicationCells: {
        get: (_getScope, _applicationId, requestedRecordId) => {
          const binding = this.bindings.get(requestedRecordId);
          const application = this.recipes.application;
          const storedRecord = this.records.find(
            (candidate) => candidate.recordId === requestedRecordId
          );
          if (
            binding === undefined ||
            application === undefined ||
            storedRecord === undefined
          ) {
            return Promise.resolve(undefined);
          }
          return Promise.resolve({
            application,
            binding: "executed",
            cellResult: binding.cellResult,
            record: storedRecord,
            recordContentHash: binding.input.recordContentHash,
          });
        },
      },
      applications: {
        get: () => Promise.resolve(undefined),
        register: () => Promise.resolve(),
      },
      cache: { getForUpdate: () => Promise.resolve(undefined) },
      cachedBindings: {
        pinActive: () => Promise.resolve(),
        pinCached: () => Promise.resolve(false),
      },
      cellResults: { getByRun: () => Promise.resolve(undefined) },
      inputs: {
        resolveExact: (_resolveScope, _applicationId, requestedRecordId) => {
          inputResolutions += 1;
          const storedRecord = this.records.find(
            (candidate) => candidate.recordId === requestedRecordId
          );
          if (storedRecord === undefined) {
            return Promise.resolve(undefined);
          }
          resolvedInput = exactInputFor(storedRecord);
          const rejectOnce =
            requestedRecordId === this.rejectRecordIdOnce &&
            !this.rejectedRecordIds.has(requestedRecordId);
          if ((this.rejectCreation || rejectOnce) && inputResolutions > 1) {
            this.rejectedRecordIds.add(requestedRecordId);
            return Promise.resolve({ ...resolvedInput, inputHash: hash("f") });
          }
          return Promise.resolve(resolvedInput);
        },
      },
      outbox: { append: () => Promise.resolve() },
      planning: {
        runPlans: {
          insert: (_insertScope, input) => {
            this.attemptedPlans += 1;
            stagedPlans.push(input);
            return Promise.resolve();
          },
        },
        snapshots: {
          getAuthority: () =>
            Promise.resolve({
              authorityEnvelopeId: "authority-apply-recipe",
              budgetLimit: {
                limit: 100,
                reserved: 0,
                spent: 0,
                unit: "credits",
              },
              capabilities: [capability],
              deadline: instant(20_000),
              permissions: actor.permissions,
              subjectActorId: actor.actorId,
              version: "1.0.0",
              workspaceId: workspace,
            }),
          getDefaults: () =>
            Promise.resolve({
              policySnapshotId: "policy-apply-recipe",
              pricingSnapshotId: "pricing-apply-recipe",
              workspaceId: workspace,
            }),
          getPolicy: () =>
            Promise.resolve({
              policy: {
                factsHash: hash("7"),
                maxAttemptsPerStep: 1,
                requiredPermission: "plans:quote",
                version: "1.0.0",
              },
              snapshotId: "policy-apply-recipe",
              workspaceId: workspace,
            }),
          getPricing: () =>
            Promise.resolve({
              guarantee: "hard",
              snapshotId: "pricing-apply-recipe",
              ttlMilliseconds: 5000,
              unit: "credits",
              upperBound: 1,
              version: "1.0.0",
              workspaceId: workspace,
            }),
          getWorkflow: () =>
            Promise.resolve({
              allowedCapabilities: [capability.capabilityId],
              catalogFingerprint: contract.catalogFingerprint,
              catalogVersion: contract.catalogVersion,
              compilationLimits: { maxDepth: 1, maxFanOut: 1, maxNodes: 1 },
              compilerVersion: "1.0.0",
              inputContract: contract,
              outputContract: {
                ...contract,
                schemaId:
                  "https://schemas.kurobara.invalid/recipe-output/1.0.0",
              },
              workflow: {
                contentHash: recipe.workflowContentHash,
                nodes: [{ capability, dependsOn: [], key: "resolve" }],
                revision: recipe.workflowRevision,
                workflowSpecId: recipe.workflowSpecId,
              },
              workspaceId: workspace,
            }),
        },
      },
      recipes: {
        get: () => Promise.resolve(recipe),
        register: () => Promise.resolve(),
      },
      runCreation: {
        bindPending: (_bindScope, binding) => {
          stagedBoundRuns += 1;
          stagedBindings.push({
            cellResult: binding.cellResult,
            input: binding.input,
          });
          return Promise.resolve();
        },
      },
      runEvents: { append: () => Promise.resolve() },
      runPlans: {
        get: (_getScope, requestedPlanId) => {
          const stored = stagedPlans.find(
            ({ plan }) => plan.runPlanId === requestedPlanId
          );
          const result: StoredRunPlan | undefined =
            stored === undefined
              ? undefined
              : {
                  plan: stored.plan,
                  ...(consumed === undefined ? {} : { consumedBy: consumed }),
                };
          return Promise.resolve(result);
        },
        insert: () => Promise.resolve(),
        markConsumed: (_markScope, _planId, creation) => {
          consumed = creation;
          return Promise.resolve();
        },
      },
      runs: {
        findByIdempotencyKey: () => Promise.resolve(undefined),
        insert: () => {
          stagedRuns += 1;
          return Promise.resolve();
        },
        lockIdempotencyKey: () => Promise.resolve(),
      },
    };
    try {
      const result = await work(unitOfWork);
      this.committedPlans.push(...stagedPlans);
      this.boundRuns += stagedBoundRuns;
      this.committedRuns += stagedRuns;
      for (const binding of stagedBindings) {
        this.bindings.set(binding.input.recordId, binding);
      }
      return result;
    } catch (error) {
      this.rollbacks += 1;
      throw error;
    }
  }
}

const makeFixture = (
  options:
    | boolean
    | Readonly<{
        records?: readonly DatasetRecord[];
        rejectCreation?: boolean;
        rejectRecordIdOnce?: string;
      }> = {}
) => {
  const normalizedOptions =
    typeof options === "boolean" ? { rejectCreation: options } : options;
  const records = normalizedOptions.records ?? [record];
  const datasets = new FakeDatasets(records);
  const recipes = new FakeRecipes();
  const persistence = new FakeApplyPersistence(recipes, {
    ...normalizedOptions,
    records,
  });
  let identitySequence = 0;
  const execute = makeApplyRecipe({
    applicationIdentifiers: {
      nextRecipeApplicationId: () =>
        Promise.resolve("unexpected-generated-application-id"),
    },
    clock: { now: () => Promise.resolve(instant(1000)) },
    datasets,
    identifiers: {
      nextEventId: () =>
        Promise.resolve(eventId(`event-apply-recipe-${++identitySequence}`)),
      nextOutboxMessageId: () =>
        Promise.resolve(
          outboxMessageId(`outbox-apply-recipe-${++identitySequence}`)
        ),
      nextRunId: () =>
        Promise.resolve(runId(`run-apply-recipe-${++identitySequence}`)),
    },
    inputValidator: {
      validate: () =>
        Promise.resolve({
          status: "accepted",
          validatorVersion: "validator-apply-recipe-v1",
        }),
    },
    persistence,
    planningIdentifiers: {
      nextQuoteId: () =>
        Promise.resolve(`quote-apply-recipe-${++identitySequence}`),
      nextRunPlanId: () =>
        Promise.resolve(runPlanId(`plan-apply-recipe-${++identitySequence}`)),
    },
    recipes,
    routes: {
      listAvailable: () => [
        {
          capability,
          effectAdapterKey: "provider-test",
          reservableUpperBound: 1,
          reservationUnit: "credits",
          routeKey: "primary",
        },
      ],
    },
  });
  return { datasets, execute, persistence, recipes };
};

const request = () => ({
  actor,
  applicationId,
  authorityEnvelopeId: "authority-apply-recipe",
  cellBudget: { limit: 5, unit: "credits" },
  correlationId: correlationId("correlation-apply-recipe"),
  deadlineMs: 15_000,
  maxCells: 10,
  recipe,
});

test("registers, groups, quotes, and creates one canonical Run per cell", async () => {
  const fixture = makeFixture();

  const result = await fixture.execute(request());

  assert.equal(result.ok, true);
  if (!result.ok) {
    return;
  }
  assert.equal(result.value.application.recipeApplicationId, applicationId);
  assert.equal(result.value.applicationReplayed, false);
  assert.equal(result.value.recipeReplayed, false);
  assert.deepEqual(result.value.counts, {
    active: 0,
    bound: 0,
    cached: 0,
    createdRun: 1,
    total: 1,
  });
  assert.equal(fixture.persistence.committedPlans.length, 1);
  assert.deepEqual(fixture.persistence.committedPlans[0]?.plan.routeSnapshots, [
    {
      capability,
      effectAdapterKey: "provider-test",
      factsHash: hash("7"),
      nodeKey: "resolve",
      pricingVersion: "1.0.0",
      reservableUpperBound: 1,
      reservationUnit: "credits",
      routeKey: "primary",
    },
  ]);
  assert.equal(
    fixture.persistence.committedPlans[0]?.input?.inputId.startsWith(
      "run_input_"
    ),
    true
  );
  assert.equal(fixture.persistence.committedRuns, 1);
  assert.equal(fixture.persistence.boundRuns, 1);
  assert.equal(fixture.persistence.rollbacks, 0);
});

test("creates Runs only for the exact selected record identities", async () => {
  const fixture = makeFixture({ records: [record, secondRecord] });

  const result = await fixture.execute({
    ...request(),
    aggregateBudget: { limit: 5, unit: "credits" },
    recordIds: [secondRecord.recordId],
  });

  assert.equal(result.ok, true);
  if (!result.ok) {
    return;
  }
  assert.deepEqual(result.value.application.graph.recordIds, [
    secondRecord.recordId,
  ]);
  assert.deepEqual(result.value.counts, {
    active: 0,
    bound: 0,
    cached: 0,
    createdRun: 1,
    total: 1,
  });
  assert.equal(fixture.persistence.committedPlans.length, 1);
  assert.equal(fixture.persistence.committedRuns, 1);
  assert.deepEqual(
    fixture.persistence.committedPlans[0]?.input?.value,
    exactInputFor(secondRecord).normalizedInput
  );
});

test("rejects an exact selection whose worst-case cell costs exceed its aggregate budget", async () => {
  const fixture = makeFixture({ records: [record, secondRecord] });

  const result = await fixture.execute({
    ...request(),
    aggregateBudget: { limit: 9, unit: "credits" },
    recordIds: [record.recordId, secondRecord.recordId],
  });

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, "aggregate-budget-exceeded");
  }
  assert.equal(fixture.datasets.getCalls, 0);
  assert.equal(fixture.persistence.committedPlans.length, 0);
  assert.equal(fixture.persistence.committedRuns, 0);
});

test("rolls back the persisted plan and input when Run creation is rejected", async () => {
  const fixture = makeFixture(true);

  const result = await fixture.execute(request());

  assert.equal(result.ok, false);
  if (result.ok) {
    return;
  }
  assert.equal(result.error.code, "recipe-cell-run-rejected");
  assert.equal(result.error.domainCode, "recipe-cell-input-not-found");
  assert.equal(result.error.recordId, record.recordId);
  assert.equal(fixture.persistence.attemptedPlans, 1);
  assert.equal(fixture.persistence.committedPlans.length, 0);
  assert.equal(fixture.persistence.committedRuns, 0);
  assert.equal(fixture.persistence.boundRuns, 0);
  assert.equal(fixture.persistence.rollbacks, 1);
});

test("replays a partially applied graph without recreating committed cells", async () => {
  const fixture = makeFixture({
    records: [record, secondRecord],
    rejectRecordIdOnce: secondRecord.recordId,
  });

  const first = await fixture.execute(request());

  assert.equal(first.ok, false);
  if (!first.ok) {
    assert.equal(first.error.code, "recipe-cell-run-rejected");
    assert.equal(first.error.recordId, secondRecord.recordId);
  }
  assert.equal(fixture.persistence.committedRuns, 1);
  assert.equal(fixture.persistence.boundRuns, 1);
  assert.equal(fixture.persistence.committedPlans.length, 1);
  assert.equal(fixture.persistence.rollbacks, 1);

  const replay = await fixture.execute(request());

  assert.equal(replay.ok, true);
  if (!replay.ok) {
    return;
  }
  assert.equal(replay.value.applicationReplayed, true);
  assert.equal(replay.value.recipeReplayed, true);
  assert.deepEqual(replay.value.counts, {
    active: 0,
    bound: 1,
    cached: 0,
    createdRun: 1,
    total: 2,
  });
  assert.equal(fixture.persistence.committedRuns, 2);
  assert.equal(fixture.persistence.boundRuns, 2);
  assert.equal(fixture.persistence.committedPlans.length, 2);
  assert.equal(fixture.persistence.rollbacks, 1);
});

test("rejects missing aggregate permissions before reading the dataset", async () => {
  const fixture = makeFixture();

  const result = await fixture.execute({
    ...request(),
    actor: { ...actor, permissions: ["recipes:register", "recipes:apply"] },
  });

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, "authority-permission-missing");
    assert.equal(result.error.domainCode, "plans:quote");
  }
  assert.equal(fixture.datasets.getCalls, 0);
  assert.equal(fixture.persistence.attemptedPlans, 0);
});
