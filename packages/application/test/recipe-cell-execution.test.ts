import assert from "node:assert/strict";
import test from "node:test";

import {
  actorId,
  capabilityId,
  cellResultId,
  contentHash,
  correlationId,
  datasetId,
  enrichmentRecipeId,
  eventId,
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
  ExactRecipeCellInput,
  ExactRecipeProjectionRow,
  OutboxMessage,
  RecipeApplication,
  RecipeCellCacheSnapshot,
  RecipeCellRunCreationUnitOfWork,
  RecipePersistencePort,
  RunCreationRecord,
  StoredRunPlan,
  VerifiedApiKey,
  WorkspaceScope,
} from "@kurobara/ports";

import {
  makeCreateRecipeCellRun,
  makePrepareRecipeCell,
  prepareRunPlan,
} from "../src/index.ts";

const hash = (marker: string) =>
  contentHash(`sha256:${marker.repeat(64).slice(0, 64)}`);
const workspace = workspaceId("workspace-recipe-cell");
const dataset = datasetId("dataset-recipe-cell");
const record = recordId("record-recipe-cell");
const sourceField = fieldId("field-domain");
const targetField = fieldId("field-website");
const recipe = enrichmentRecipeId("recipe-website");
const workflow = workflowSpecId("workflow-website");
const planId = runPlanId("plan-recipe-cell");
const actor: VerifiedApiKey = {
  actorId: actorId("actor-recipe-cell"),
  authenticationMode: "api-key",
  credentialId: "credential-recipe-cell",
  permissions: ["recipes:apply"],
  workspaceId: workspace,
};
const application: RecipeApplication = {
  createdAt: instant(1000),
  datasetId: dataset,
  graph: { recordIds: [record] },
  graphHash: hash("a"),
  intentHash: hash("b"),
  maxCells: 10,
  recipeApplicationId: "application-recipe-cell",
  recipeId: recipe,
  recipeRevision: "1.0.0",
  targetFieldId: targetField,
  workspaceId: workspace,
};
const input: ExactRecipeCellInput = {
  cacheKey: hash("c"),
  datasetId: dataset,
  inputHash: hash("d"),
  inputValues: [
    { fieldId: sourceField, present: true, value: "synthetic.invalid" },
  ],
  normalizedInput: {
    datasetId: dataset,
    inputValues: [
      { fieldId: sourceField, present: true, value: "synthetic.invalid" },
    ],
    recipeId: recipe,
    recipeRevision: "1.0.0",
    recordContentHash: hash("e"),
    recordId: record,
    targetFieldId: targetField,
    workflowContentHash: hash("f"),
    workflowRevision: "1.0.0",
    workflowSpecId: workflow,
    workspaceId: workspace,
  },
  recipeApplicationId: application.recipeApplicationId,
  recipeId: recipe,
  recipeRevision: "1.0.0",
  recordContentHash: hash("e"),
  recordId: record,
  targetFieldId: targetField,
  workflowContentHash: hash("f"),
  workflowRevision: "1.0.0",
  workflowSpecId: workflow,
  workspaceId: workspace,
};

const plan = () => {
  const capability = {
    capabilityId: capabilityId("organizations.website.resolve"),
    capabilityVersion: "1.0.0",
  };
  const contract = {
    catalogFingerprint: hash("1"),
    catalogVersion: "local-development-only",
    schemaFingerprint: hash("2"),
    schemaId: "https://schemas.kurobara.invalid/local/recipe-input/1.0.0",
    schemaVersion: "1.0.0",
  };
  const prepared = prepareRunPlan({
    actorPermissions: actor.permissions,
    allowedCapabilities: [capability.capabilityId],
    authority: {
      authorityEnvelopeId: "authority-recipe-cell",
      budgetLimit: { limit: 10, reserved: 0, spent: 0, unit: "credits" },
      capabilities: [capability],
      deadline: instant(20_000),
      permissions: actor.permissions,
      subjectActorId: actor.actorId,
      version: "1.0.0",
      workspaceId: workspace,
    },
    budget: { limit: 5, reserved: 0, spent: 0, unit: "credits" },
    catalogFingerprint: hash("1"),
    catalogVersion: "local-development-only",
    compilationLimits: { maxDepth: 1, maxFanOut: 1, maxNodes: 1 },
    compilerVersion: "1.0.0",
    deadline: instant(15_000),
    inputContract: contract,
    normalizedInputHash: input.inputHash,
    now: instant(1000),
    outputContract: {
      ...contract,
      schemaId:
        "https://schemas.kurobara.invalid/local/cell-result-output/1.0.0",
    },
    planHash: hash("3"),
    policy: {
      factsHash: hash("4"),
      requiredPermission: "recipes:apply",
      version: "1.0.0",
    },
    quote: {
      expiresAt: instant(10_000),
      guarantee: "hard",
      pricingVersion: "1.0.0",
      quoteId: "quote-recipe-cell",
      unit: "credits",
      upperBound: 5,
    },
    retryPolicy: { maxAttemptsPerStep: 2 },
    runPlanId: planId,
    workflow: {
      contentHash: input.workflowContentHash,
      nodes: [{ capability, dependsOn: [], key: "resolve-website" }],
      revision: input.workflowRevision,
      workflowSpecId: input.workflowSpecId,
    },
    workspaceId: workspace,
  });
  if (!prepared.ok) {
    throw new Error(`Recipe-cell plan fixture failed: ${prepared.error.code}`);
  }
  return prepared.value;
};

class FakeRecipePersistence {
  activePins: string[] = [];
  applicationCell?: ExactRecipeProjectionRow;
  cache?: RecipeCellCacheSnapshot;
  creations = new Map<string, RunCreationRecord>();
  outbox: OutboxMessage[] = [];
  pendingBindings: Parameters<
    RecipeCellRunCreationUnitOfWork["runCreation"]["bindPending"]
  >[1][] = [];
  pinAccepted = true;
  pins: string[] = [];
  plans = new Map<string, StoredRunPlan>([[planId, { plan: plan() }]]);

  private unitOfWork(): RecipeCellRunCreationUnitOfWork {
    return {
      applicationCells: {
        get: async () => this.applicationCell,
      },
      applications: {
        get: async () => application,
        register: async () => undefined,
      },
      cache: {
        getForUpdate: async () => this.cache,
      },
      cachedBindings: {
        pinActive: (_scope, _input, requestedCellResultId) => {
          this.activePins.push(requestedCellResultId);
          return Promise.resolve();
        },
        pinCached: (_scope, _input, requestedCellResultId) => {
          this.pins.push(requestedCellResultId);
          return Promise.resolve(this.pinAccepted);
        },
      },
      cellResults: { getByRun: async () => undefined },
      inputs: { resolveExact: async () => input },
      outbox: {
        append: (_scope, message) => {
          this.outbox.push(message);
          return Promise.resolve();
        },
      },
      recipes: {
        get: async () => undefined,
        register: async () => undefined,
      },
      runCreation: {
        bindPending: (_scope, binding) => {
          this.pendingBindings.push(binding);
          this.cache = {
            activeCellResultId: binding.cellResult.cellResultId,
            cacheIdentity: {
              datasetId: binding.input.datasetId,
              inputHash: binding.input.inputHash,
              recipeId: binding.input.recipeId,
              recipeRevision: binding.input.recipeRevision,
              recordContentHash: binding.input.recordContentHash,
              recordId: binding.input.recordId,
              targetFieldId: binding.input.targetFieldId,
              workflowContentHash: binding.input.workflowContentHash,
              workflowRevision: binding.input.workflowRevision,
              workflowSpecId: binding.input.workflowSpecId,
              workspaceId: binding.input.workspaceId,
            },
            cacheKey: binding.input.cacheKey,
            revision: 1,
          };
          return Promise.resolve();
        },
      },
      runEvents: { append: async () => undefined },
      runPlans: {
        get: async (_scope, requestedPlanId) => this.plans.get(requestedPlanId),
        insert: (_scope, runPlan) => {
          this.plans.set(runPlan.runPlanId, { plan: runPlan });
          return Promise.resolve();
        },
        markConsumed: (_scope, requestedPlanId, creation) => {
          const stored = this.plans.get(requestedPlanId);
          if (stored === undefined) {
            return Promise.reject(new Error("Missing synthetic plan."));
          }
          this.plans.set(requestedPlanId, { ...stored, consumedBy: creation });
          this.creations.set(creation.idempotencyKey, creation);
          return Promise.resolve();
        },
      },
      runs: {
        findByIdempotencyKey: async (_scope, key) => this.creations.get(key),
        insert: async () => undefined,
        lockIdempotencyKey: async () => undefined,
      },
    };
  }

  recipePort(): RecipePersistencePort {
    return {
      async *streamExactProjection() {
        // The preparation use case does not enumerate an application.
      },
      transaction: async <Value>(
        _scope: WorkspaceScope,
        work: (
          unitOfWork: ReturnType<FakeRecipePersistence["unitOfWork"]>
        ) => Promise<Value>
      ) => work(this.unitOfWork()),
    };
  }

  transaction<Value>(
    _scope: WorkspaceScope,
    work: (unitOfWork: RecipeCellRunCreationUnitOfWork) => Promise<Value>
  ): Promise<Value> {
    return work(this.unitOfWork());
  }
}

const preparation = (persistence: FakeRecipePersistence) =>
  makePrepareRecipeCell({
    persistence: persistence.recipePort(),
    requiredPermission: "recipes:apply",
  });

test("prepares an exact cell as ready, active, cached, or already bound", async () => {
  const persistence = new FakeRecipePersistence();
  const execute = preparation(persistence);
  const request = {
    actor,
    recipeApplicationId: application.recipeApplicationId,
    recordId: record,
  } as const;

  assert.equal((await execute(request)).ok, true);
  const activeId = cellResultId("cell-active");
  persistence.cache = {
    activeCellResultId: activeId,
    cacheIdentity: {
      datasetId: input.datasetId,
      inputHash: input.inputHash,
      recipeId: input.recipeId,
      recipeRevision: input.recipeRevision,
      recordContentHash: input.recordContentHash,
      recordId: input.recordId,
      targetFieldId: input.targetFieldId,
      workflowContentHash: input.workflowContentHash,
      workflowRevision: input.workflowRevision,
      workflowSpecId: input.workflowSpecId,
      workspaceId: input.workspaceId,
    },
    cacheKey: input.cacheKey,
    revision: 1,
  };
  const active = await execute(request);
  assert.equal(active.ok && active.value.status, "active");
  assert.deepEqual(persistence.activePins, [activeId]);

  const cachedId = cellResultId("cell-cached");
  persistence.cache = {
    ...persistence.cache,
    activeCellResultId: undefined,
    revision: 2,
    validCellResultId: cachedId,
    validUntil: instant(2000),
  };
  const cached = await execute(request);
  assert.equal(cached.ok && cached.value.status, "cached");
  assert.deepEqual(persistence.pins, [cachedId]);

  persistence.pinAccepted = false;
  const expiredAtDatabaseLock = await execute(request);
  assert.equal(
    expiredAtDatabaseLock.ok && expiredAtDatabaseLock.value.status,
    "ready"
  );
  persistence.cache = {
    ...persistence.cache,
    activeCellResultId: activeId,
  };
  const activeAfterStaleCandidate = await execute(request);
  assert.equal(
    activeAfterStaleCandidate.ok && activeAfterStaleCandidate.value.status,
    "active"
  );
  assert.deepEqual(persistence.activePins, [activeId, activeId]);

  persistence.applicationCell = {
    application,
    binding: "cached",
    cellResult: {
      cellResultId: cachedId,
      datasetId: dataset,
      enrichmentRecipeId: recipe,
      fieldId: targetField,
      recipeRevision: "1.0.0",
      recordId: record,
      runId: runId("run-cached"),
      status: "succeeded",
      value: null,
      workspaceId: workspace,
    },
    record: {
      datasetId: dataset,
      recordId: record,
      values: [],
      workspaceId: workspace,
    },
    recordContentHash: input.recordContentHash,
  };
  const bound = await execute(request);
  assert.equal(bound.ok && bound.value.status, "bound");
});

test("rejects conflicting exact evidence before replaying an application binding", async () => {
  const persistence = new FakeRecipePersistence();
  persistence.applicationCell = {
    application,
    binding: "executed",
    cellResult: {
      cellResultId: cellResultId("cell-bound"),
      datasetId: dataset,
      enrichmentRecipeId: recipe,
      fieldId: targetField,
      recipeRevision: "1.0.0",
      recordId: record,
      runId: runId("run-bound"),
      status: "pending",
      workspaceId: workspace,
    },
    record: {
      datasetId: dataset,
      recordId: record,
      values: [],
      workspaceId: workspace,
    },
    recordContentHash: input.recordContentHash,
  };
  const execute = makeCreateRecipeCellRun({
    clock: { now: async () => instant(1000) },
    identifiers: {
      nextEventId: async () => eventId("event-bound-conflict"),
      nextOutboxMessageId: async () => outboxMessageId("outbox-bound-conflict"),
      nextRunId: async () => runId("run-bound-conflict"),
    },
    persistence,
    requiredPermission: "recipes:apply",
  });

  const result = await execute({
    actor,
    correlationId: correlationId("correlation-bound-conflict"),
    input: { ...input, cacheKey: hash("7") },
    inputId: "input-recipe-cell",
    planHash: plan().planHash,
    runPlanId: planId,
  });

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, "recipe-cell-input-not-found");
  }
  assert.equal(persistence.outbox.length, 0);
});

test("creates fresh work when DB time expires a cache candidate after locking", async () => {
  const persistence = new FakeRecipePersistence();
  persistence.pinAccepted = false;
  const expiredCandidate: RecipeCellCacheSnapshot = {
    activeCellResultId: cellResultId("cell-active-after-expiry"),
    cacheIdentity: {
      datasetId: input.datasetId,
      inputHash: input.inputHash,
      recipeId: input.recipeId,
      recipeRevision: input.recipeRevision,
      recordContentHash: input.recordContentHash,
      recordId: input.recordId,
      targetFieldId: input.targetFieldId,
      workflowContentHash: input.workflowContentHash,
      workflowRevision: input.workflowRevision,
      workflowSpecId: input.workflowSpecId,
      workspaceId: input.workspaceId,
    },
    cacheKey: input.cacheKey,
    revision: 2,
    validCellResultId: cellResultId("cell-expired-after-lock"),
    validUntil: instant(2000),
  };
  persistence.cache = expiredCandidate;
  const execute = makeCreateRecipeCellRun({
    clock: { now: async () => instant(1000) },
    identifiers: {
      nextEventId: async () => eventId("event-recipe-cell-expired"),
      nextOutboxMessageId: async () =>
        outboxMessageId("outbox-recipe-cell-expired"),
      nextRunId: async () => runId("run-recipe-cell-expired"),
    },
    persistence,
    requiredPermission: "recipes:apply",
  });

  const request = {
    actor,
    correlationId: correlationId("correlation-recipe-cell-expired"),
    input,
    inputId: "input-recipe-cell",
    planHash: plan().planHash,
    runPlanId: planId,
  } as const;

  const active = await execute(request);
  assert.equal(active.ok && active.value.status, "active");
  assert.equal(persistence.pendingBindings.length, 0);
  assert.equal(persistence.outbox.length, 0);

  persistence.cache = {
    ...expiredCandidate,
    activeCellResultId: undefined,
  };
  const result = await execute(request);

  assert.equal(result.ok && result.value.status, "created");
  assert.equal(persistence.pendingBindings.length, 1);
  assert.equal(persistence.outbox.length, 1);
});

test("creates and binds one canonical recipe-cell Run with an active cache slot", async () => {
  const persistence = new FakeRecipePersistence();
  const execute = makeCreateRecipeCellRun({
    clock: { now: async () => instant(1000) },
    identifiers: {
      nextEventId: async () => eventId("event-recipe-cell"),
      nextOutboxMessageId: async () => outboxMessageId("outbox-recipe-cell"),
      nextRunId: async () => runId("run-recipe-cell"),
    },
    persistence,
    requiredPermission: "recipes:apply",
  });

  const result = await execute({
    actor,
    correlationId: correlationId("correlation-recipe-cell"),
    input,
    inputId: "input-recipe-cell",
    planHash: plan().planHash,
    runPlanId: planId,
  });

  assert.equal(result.ok && result.value.status, "created");
  assert.equal(persistence.pendingBindings.length, 1);
  assert.equal(persistence.pendingBindings[0]?.cellResult.status, "pending");
  assert.equal(
    persistence.cache?.activeCellResultId,
    persistence.pendingBindings[0]?.cellResult.cellResultId
  );
  assert.equal(persistence.outbox.length, 1);
  assert.equal(persistence.plans.get(planId)?.consumedBy?.run.state, "queued");
});

test("rejects plan binding drift before replaying a prior recipe-cell Run", async () => {
  const persistence = new FakeRecipePersistence();
  const execute = makeCreateRecipeCellRun({
    clock: { now: async () => instant(1000) },
    identifiers: {
      nextEventId: async () => eventId("event-recipe-cell-replay"),
      nextOutboxMessageId: async () =>
        outboxMessageId("outbox-recipe-cell-replay"),
      nextRunId: async () => runId("run-recipe-cell-replay"),
    },
    persistence,
    requiredPermission: "recipes:apply",
  });
  const request = {
    actor,
    correlationId: correlationId("correlation-recipe-cell-replay"),
    input,
    inputId: "input-recipe-cell",
    planHash: plan().planHash,
    runPlanId: planId,
  } as const;

  const created = await execute(request);
  assert.equal(created.ok && created.value.status, "created");

  persistence.cache = undefined;
  const stored = persistence.plans.get(planId);
  assert.notEqual(stored, undefined);
  if (stored === undefined) {
    return;
  }
  persistence.plans.set(planId, {
    ...stored,
    plan: { ...stored.plan, normalizedInputHash: hash("9") },
  });

  const replay = await execute(request);
  assert.equal(replay.ok, false);
  if (!replay.ok) {
    assert.equal(replay.error.code, "run-plan-input-mismatch");
  }
  assert.equal(persistence.pendingBindings.length, 1);
  assert.equal(persistence.outbox.length, 1);
});

test("coalesces active work, pins valid cache, and rejects plan evidence drift", async () => {
  const persistence = new FakeRecipePersistence();
  const execute = makeCreateRecipeCellRun({
    clock: { now: async () => instant(1000) },
    identifiers: {
      nextEventId: async () => eventId("event-recipe-cell"),
      nextOutboxMessageId: async () => outboxMessageId("outbox-recipe-cell"),
      nextRunId: async () => runId("run-recipe-cell"),
    },
    persistence,
    requiredPermission: "recipes:apply",
  });
  const request = {
    actor,
    correlationId: correlationId("correlation-recipe-cell"),
    input,
    inputId: "input-recipe-cell",
    planHash: plan().planHash,
    runPlanId: planId,
  } as const;
  const activeId = cellResultId("cell-active");
  persistence.cache = {
    activeCellResultId: activeId,
    cacheIdentity: {
      datasetId: input.datasetId,
      inputHash: input.inputHash,
      recipeId: input.recipeId,
      recipeRevision: input.recipeRevision,
      recordContentHash: input.recordContentHash,
      recordId: input.recordId,
      targetFieldId: input.targetFieldId,
      workflowContentHash: input.workflowContentHash,
      workflowRevision: input.workflowRevision,
      workflowSpecId: input.workflowSpecId,
      workspaceId: input.workspaceId,
    },
    cacheKey: input.cacheKey,
    revision: 1,
  };
  const active = await execute(request);
  assert.equal(active.ok && active.value.status, "active");
  assert.deepEqual(persistence.activePins, [activeId]);
  assert.equal(persistence.outbox.length, 0);

  const validId = cellResultId("cell-valid");
  persistence.cache = {
    ...persistence.cache,
    activeCellResultId: undefined,
    revision: 2,
    validCellResultId: validId,
    validUntil: instant(2000),
  };
  const cached = await execute(request);
  assert.equal(cached.ok && cached.value.status, "cached");
  assert.deepEqual(persistence.pins, [validId]);

  persistence.cache = undefined;
  const source = plan();
  persistence.plans.set(planId, {
    plan: { ...source, normalizedInputHash: hash("9") },
  });
  const drift = await execute(request);
  assert.equal(drift.ok, false);
  if (!drift.ok) {
    assert.equal(drift.error.code, "run-plan-input-mismatch");
  }
  assert.equal(persistence.outbox.length, 0);
});
