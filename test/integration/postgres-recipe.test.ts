import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { after, before, test } from "node:test";

import {
  createCsvDatasetCodec,
  createJsonlDatasetCodec,
} from "@kurobara/adapter-dataset-codec";
import {
  createPostgresRuntime,
  type PostgresRuntime,
} from "@kurobara/adapter-postgres";
import {
  makeClaimRunExecution,
  makeCreateRecipeApplication,
  makeCreateRecipeCellRun,
  makeExportRecipeApplication,
  makeImportDataset,
  makeMaterializeNextDagRun,
  makeRegisterEnrichmentRecipe,
  prepareRunPlan,
} from "@kurobara/application";
import {
  actorId,
  capabilityId,
  contentHash,
  correlationId,
  createDataset,
  createField,
  datasetId,
  type EnrichmentRecipe,
  enrichmentRecipeId,
  eventId,
  type Field,
  fieldId,
  instant,
  outboxMessageId,
  type Run,
  type RunPlan,
  recordId,
  runId,
  runPlanId,
  type WorkspaceId,
  workflowSpecId,
  workspaceId,
} from "@kurobara/kernel";
import type {
  BootstrapPlanningInput,
  RunPlanSources,
  ValidatedRunInput,
  VerifiedApiKey,
} from "@kurobara/ports";
import postgres from "postgres";

const adminUrl = process.env.KUROBARA_TEST_POSTGRES_URL;
if (adminUrl === undefined || adminUrl.trim().length === 0) {
  throw new Error(
    "KUROBARA_TEST_POSTGRES_URL must target a disposable-capable PostgreSQL admin database."
  );
}

const databaseName = `kurobara_recipe_${process.pid}_${Date.now()}`;
const databaseUrl = new URL(adminUrl);
databaseUrl.pathname = `/${databaseName}`;
const admin = postgres(adminUrl, { max: 1 });
const sql = postgres(databaseUrl.toString(), { max: 4 });
let runtime: PostgresRuntime;

before(async () => {
  await admin`CREATE DATABASE ${admin(databaseName)}`;
  runtime = createPostgresRuntime(databaseUrl.toString());
  await runtime.migrate();
  await runtime.verifyMigrations();
});

after(async () => {
  if (runtime !== undefined) {
    await runtime.close();
  }
  await sql.end({ timeout: 5 });
  await admin`DROP DATABASE IF EXISTS ${admin(databaseName)} WITH (FORCE)`;
  await admin.end({ timeout: 5 });
});

const hash = (value: string) =>
  contentHash(`sha256:${createHash("sha256").update(value).digest("hex")}`);

const canonicalSerialize = (value: unknown): string => {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "string"
  ) {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError("Canonical JSON cannot contain non-finite numbers.");
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalSerialize).join(",")}]`;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value)
      .filter((entry) => entry[1] !== undefined)
      .sort(([left], [right]) => left.localeCompare(right));
    return `{${entries
      .map(
        ([key, entryValue]) =>
          `${JSON.stringify(key)}:${canonicalSerialize(entryValue)}`
      )
      .join(",")}}`;
  }
  throw new TypeError(`Canonical JSON cannot contain ${typeof value}.`);
};

const canonicalHash = (value: unknown) => hash(canonicalSerialize(value));

const bytesOf = (value: string): AsyncIterable<Uint8Array> => ({
  async *[Symbol.asyncIterator]() {
    await Promise.resolve();
    const bytes = new TextEncoder().encode(value);
    for (let offset = 0; offset < bytes.byteLength; offset += 11) {
      yield bytes.slice(offset, offset + 11);
    }
  },
});

const collect = async <Value>(
  values: AsyncIterable<Value>
): Promise<readonly Value[]> => {
  const collected: Value[] = [];
  for await (const value of values) {
    collected.push(value);
  }
  return collected;
};

const productFor = (workspace: WorkspaceId) => {
  const createdDataset = createDataset({
    datasetId: datasetId("dataset-organizations"),
    name: "Synthetic organizations",
    workspaceId: workspace,
  });
  if (!createdDataset.ok) {
    throw new Error(createdDataset.error.message);
  }
  const makeField = (identity: string, key: string): Field => {
    const created = createField(createdDataset.value, {
      datasetId: createdDataset.value.datasetId,
      fieldId: fieldId(identity),
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
  return {
    dataset: createdDataset.value,
    sourceField: makeField("field-domain", "domain"),
    targetField: makeField("field-category", "category"),
  };
};

const setStepSucceededWithOutputEvidence = async (
  run: Run,
  nodeKey: string,
  outputContract: RunPlan["outputContract"],
  normalizedPayload: unknown
): Promise<void> => {
  await sql.begin(async (transaction) => {
    const rows = await transaction<
      readonly {
        step_run: Readonly<Record<string, unknown>>;
        step_run_id: string;
      }[]
    >`
      SELECT step_run_id, step_run
      FROM kurobara_core.step_runs
      WHERE workspace_id = ${run.workspaceId}
        AND run_id = ${run.runId}
        AND node_key = ${nodeKey}
      FOR UPDATE
    `;
    const row = rows[0];
    if (row === undefined) {
      throw new Error(`Missing synthetic step ${nodeKey}.`);
    }

    const attemptIdentifier = `attempt-${run.runId}-${nodeKey}`;
    const reservationIdentifier = `reservation-${run.runId}-${nodeKey}`;
    const operationIdentifier = `operation-${run.runId}-${nodeKey}`;
    const usageIdentifier = `usage-${run.runId}-${nodeKey}`;
    const routingIdentifier = `routing-${run.runId}-${nodeKey}`;
    const snapshotHash = hash(`route-${run.runId}-${nodeKey}`);
    const canonicalPayload = canonicalSerialize(normalizedPayload);
    const outputContentHash = hash(canonicalPayload);
    const artifactIdentifier = `artifact_${outputContentHash.slice(
      "sha256:".length
    )}`;
    const validatedOutput = {
      artifact: {
        artifactId: artifactIdentifier,
        contentHash: outputContentHash,
      },
      contract: outputContract,
      validatedAt: 5000,
      validatorVersion: "json-schema-2020-12:recipe-integration",
    } as const;
    const attempt = {
      attemptId: attemptIdentifier,
      attemptNumber: 1,
      authorityEnvelopeId: "authority-recipe",
      claimedAt: 5000,
      costReservationId: reservationIdentifier,
      effectAdapterKey: "deterministic-local",
      effectStartedAt: 5000,
      finishedAt: 5000,
      operationKey: operationIdentifier,
      output: validatedOutput,
      preparedAt: 5000,
      reason: "initial",
      reservationUnit: "credits",
      reservedAmount: 0,
      routeKey: "deterministic-local",
      routeSnapshotHash: snapshotHash,
      routingDecisionId: routingIdentifier,
      state: "succeeded",
      stepRunId: row.step_run_id,
    } as const;
    const reservation = {
      amount: 0,
      attemptId: attemptIdentifier,
      createdAt: 5000,
      operationKey: operationIdentifier,
      releasedAmount: 0,
      reservationId: reservationIdentifier,
      runId: run.runId,
      settledAmount: 0,
      settledAt: 5000,
      state: "settled",
      stepRunId: row.step_run_id,
      unit: "credits",
      usageEntryId: usageIdentifier,
      workspaceId: run.workspaceId,
    } as const;
    const usage = {
      amount: 0,
      attemptId: attemptIdentifier,
      operationKey: operationIdentifier,
      recordedAt: 5000,
      reservationId: reservationIdentifier,
      runId: run.runId,
      unit: "credits",
      usageEntryId: usageIdentifier,
      workspaceId: run.workspaceId,
    } as const;
    const artifact = {
      artifactId: artifactIdentifier,
      attemptId: attemptIdentifier,
      classification: "internal",
      contentHash: outputContentHash,
      contract: outputContract,
      finalizedAt: 5000,
      kind: "normalized-output",
      mediaType: "application/json",
      operationKey: operationIdentifier,
      retentionPolicy: "run",
      runId: run.runId,
      sizeBytes: Buffer.byteLength(canonicalPayload, "utf8"),
      state: "finalized",
      stepRunId: row.step_run_id,
      validatedAt: 5000,
      validatorVersion: "json-schema-2020-12:recipe-integration",
      workspaceId: run.workspaceId,
    } as const;

    await transaction`
      INSERT INTO kurobara_core.step_operation_bindings (
        workspace_id, run_id, operation_key, step_run_id
      ) VALUES (
        ${run.workspaceId}, ${run.runId}, ${operationIdentifier},
        ${row.step_run_id}
      )
    `;
    await transaction`
      INSERT INTO kurobara_core.cost_reservations (
        workspace_id, reservation_id, attempt_id, step_run_id, run_id,
        operation_key, unit, amount, state, reservation, created_at
      ) VALUES (
        ${run.workspaceId}, ${reservationIdentifier}, ${attemptIdentifier},
        ${row.step_run_id}, ${run.runId}, ${operationIdentifier}, 'credits',
        0, 'settled', ${transaction.json(reservation)}, to_timestamp(5)
      )
    `;
    await transaction`
      INSERT INTO kurobara_core.step_attempts (
        workspace_id, attempt_id, step_run_id, attempt_number,
        operation_key, reservation_id, route_key, effect_adapter_key,
        routing_decision_id, route_snapshot_hash, state, attempt, created_at
      ) VALUES (
        ${run.workspaceId}, ${attemptIdentifier}, ${row.step_run_id}, 1,
        ${operationIdentifier}, ${reservationIdentifier},
        'deterministic-local', 'deterministic-local', ${routingIdentifier},
        ${snapshotHash}, 'succeeded', ${transaction.json(attempt)},
        to_timestamp(5)
      )
    `;
    await transaction`
      INSERT INTO kurobara_core.run_output_artifacts (
        workspace_id, artifact_id, run_id, step_run_id, attempt_id,
        operation_key, content_hash, contract, normalized_payload,
        classification, kind, media_type, retention_policy, size_bytes,
        state, validator_version, validated_at, artifact, finalized_at
      ) VALUES (
        ${run.workspaceId}, ${artifact.artifactId}, ${run.runId},
        ${row.step_run_id}, ${attemptIdentifier}, ${operationIdentifier},
        ${outputContentHash}, ${transaction.json(outputContract)},
        ${transaction.json(normalizedPayload)}, ${artifact.classification},
        ${artifact.kind}, ${artifact.mediaType}, ${artifact.retentionPolicy},
        ${artifact.sizeBytes}, ${artifact.state}, ${artifact.validatorVersion},
        to_timestamp(5), ${transaction.json(artifact)}, to_timestamp(5)
      )
    `;
    await transaction`
      INSERT INTO kurobara_core.usage_ledger_entries (
        workspace_id, usage_entry_id, run_id, attempt_id, reservation_id,
        operation_key, unit, amount, entry, recorded_at
      ) VALUES (
        ${run.workspaceId}, ${usageIdentifier}, ${run.runId},
        ${attemptIdentifier}, ${reservationIdentifier}, ${operationIdentifier},
        'credits', 0, ${transaction.json(usage)}, to_timestamp(5)
      )
    `;
    await transaction`
      UPDATE kurobara_core.step_runs
      SET
        state = 'succeeded',
        aggregate_version = aggregate_version + 1,
        event_sequence = event_sequence + 1,
        step_run = ${transaction.json({
          ...row.step_run,
          aggregateVersion: Number(row.step_run.aggregateVersion ?? 0) + 1,
          attempts: [attempt],
          eventSequence: Number(row.step_run.eventSequence ?? 0) + 1,
          state: "succeeded",
        })}
      WHERE workspace_id = ${run.workspaceId}
        AND run_id = ${run.runId}
        AND step_run_id = ${row.step_run_id}
    `;
  });
};

test("executes and caches one exact PostgreSQL recipe cell end to end", async () => {
  const migrations = await sql<readonly { migration_name: string }[]>`
    SELECT migration_name
    FROM kurobara_core.schema_migrations
    ORDER BY migration_name
  `;
  assert.equal(migrations.length, 32);
  assert.equal(
    migrations.at(-1)?.migration_name,
    "0032_gtm_play_execution.sql"
  );

  const workspace = workspaceId("workspace-recipe-integration");
  const isolatedWorkspace = workspaceId("workspace-recipe-isolated");
  const scope = { workspaceId: workspace } as const;
  const product = productFor(workspace);
  const capability = {
    capabilityId: capabilityId("organizations.category.resolve"),
    capabilityVersion: "1.0.0",
  } as const;
  const workflowIdentity = {
    workflowContentHash: hash("recipe-workflow-content"),
    workflowRevision: "workflow-r1",
    workflowSpecId: workflowSpecId("workflow-category"),
  } as const;
  const contract = {
    catalogFingerprint: hash("recipe-catalog"),
    catalogVersion: "1.0.0",
    schemaFingerprint: hash("recipe-input-schema"),
    schemaId: "https://schemas.kurobara.invalid/recipe/input/1.0.0",
    schemaVersion: "1.0.0",
  } as const;
  const outputContract = {
    ...contract,
    schemaFingerprint: hash("recipe-output-schema"),
    schemaId: "https://schemas.kurobara.invalid/recipe/cell-result/1.0.0",
  } as const;
  const actor: VerifiedApiKey = {
    actorId: actorId("actor-recipe-integration"),
    authenticationMode: "api-key",
    credentialId: "credential-recipe-integration",
    permissions: ["datasets:import", "recipes:register", "recipes:apply"],
    workspaceId: workspace,
  };
  const planning: BootstrapPlanningInput = {
    authorities: [
      {
        authorityEnvelopeId: "authority-recipe",
        budgetLimit: { limit: 5, reserved: 0, spent: 0, unit: "credits" },
        capabilities: [capability],
        deadline: instant(4_102_444_800_000),
        permissions: actor.permissions,
        subjectActorId: actor.actorId,
        version: "1.0.0",
        workspaceId: workspace,
      },
    ],
    defaults: {
      policySnapshotId: "policy-recipe",
      pricingSnapshotId: "pricing-recipe",
      workspaceId: workspace,
    },
    expectedDefaultsRevision: null,
    policies: [
      {
        policy: {
          factsHash: hash("recipe-policy"),
          maxAttemptsPerStep: 2,
          requiredPermission: "recipes:apply",
          version: "1.0.0",
        },
        snapshotId: "policy-recipe",
        workspaceId: workspace,
      },
    ],
    pricing: [
      {
        guarantee: "hard",
        snapshotId: "pricing-recipe",
        ttlMilliseconds: 60_000,
        unit: "credits",
        upperBound: 5,
        version: "1.0.0",
        workspaceId: workspace,
      },
    ],
    workflows: [
      {
        allowedCapabilities: [capability.capabilityId],
        catalogFingerprint: contract.catalogFingerprint,
        catalogVersion: contract.catalogVersion,
        compilationLimits: { maxDepth: 1, maxFanOut: 1, maxNodes: 1 },
        compilerVersion: "1.0.0",
        inputContract: contract,
        outputContract,
        workflow: {
          contentHash: workflowIdentity.workflowContentHash,
          nodes: [
            {
              capability,
              dependsOn: [],
              key: "resolve-category",
            },
          ],
          revision: workflowIdentity.workflowRevision,
          workflowSpecId: workflowIdentity.workflowSpecId,
        },
        workspaceId: workspace,
      },
    ],
    workspaceId: workspace,
  };
  const planningApply = await runtime.bootstrapPlanning(planning);
  assert.equal(planningApply.status, "applied");
  await runtime.planning.transaction(scope, async ({ snapshots }) => {
    assert.deepEqual(
      await snapshots.getWorkflow(scope, workflowIdentity),
      planning.workflows[0]
    );
  });

  const record = recordId("record-synthetic-organization");
  const source = JSON.stringify({
    dataset_id: product.dataset.datasetId,
    record_id: record,
    values: [
      {
        field_id: product.sourceField.fieldId,
        value: "synthetic.invalid",
      },
    ],
    workspace_id: workspace,
  });
  const importDataset = makeImportDataset({
    codecs: {
      csv: createCsvDatasetCodec(),
      jsonl: createJsonlDatasetCodec(),
    },
    datasets: runtime.datasets,
    requiredPermission: "datasets:import",
  });
  const imported = await importDataset({
    actor,
    batchLimits: { maxBytes: 4096, maxItems: 10 },
    bytes: bytesOf(source),
    dataset: product.dataset,
    fields: [product.sourceField, product.targetField],
    format: "jsonl",
    importId: "import-recipe-integration",
    maxRecordBytes: 2048,
    sourceContentHash: hash(source),
  });
  assert.equal(imported.ok, true);
  if (!imported.ok) {
    throw new Error(imported.error.message);
  }
  assert.deepEqual(imported.value.progress, {
    batchCount: 1,
    datasetId: product.dataset.datasetId,
    errorCount: 0,
    importId: "import-recipe-integration",
    itemCount: 1,
    recordCount: 1,
    state: "completed",
    workspaceId: workspace,
  });

  await assert.rejects(
    () => sql`
      INSERT INTO kurobara_core.enrichment_recipes (
        workspace_id,
        dataset_id,
        enrichment_recipe_id,
        recipe_revision,
        name,
        target_field_id,
        workflow_spec_id,
        workflow_revision,
        workflow_content_hash,
        input_count,
        recipe
      ) VALUES (
        ${workspace},
        ${product.dataset.datasetId},
        'recipe-missing-json-keys',
        'recipe-r1',
        'Invalid JSON mirror fixture',
        ${product.targetField.fieldId},
        ${workflowIdentity.workflowSpecId},
        ${workflowIdentity.workflowRevision},
        ${workflowIdentity.workflowContentHash},
        1,
        '{}'::jsonb
      )
    `,
    (error: unknown) =>
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "23514"
  );

  const recipe: EnrichmentRecipe = {
    datasetId: product.dataset.datasetId,
    enrichmentRecipeId: enrichmentRecipeId("recipe-category"),
    inputFieldIds: [product.sourceField.fieldId],
    name: "Resolve organization category",
    recipeRevision: "recipe-r1",
    targetFieldId: product.targetField.fieldId,
    ...workflowIdentity,
    workspaceId: workspace,
  };
  const registerRecipe = makeRegisterEnrichmentRecipe({
    datasets: runtime.datasets,
    persistence: runtime.recipes,
    requiredPermission: "recipes:register",
  });
  const firstRegistration = await registerRecipe({
    actor,
    datasetId: product.dataset.datasetId,
    recipe,
  });
  const replayedRegistration = await registerRecipe({
    actor,
    datasetId: product.dataset.datasetId,
    recipe,
  });
  assert.equal(firstRegistration.ok && firstRegistration.value.replayed, false);
  assert.equal(
    replayedRegistration.ok && replayedRegistration.value.replayed,
    true
  );

  const createApplication = (recipeApplicationId: string, now: number) =>
    makeCreateRecipeApplication({
      clock: { now: async () => instant(now) },
      datasets: runtime.datasets,
      identifiers: {
        nextRecipeApplicationId: async () => recipeApplicationId,
      },
      persistence: runtime.recipes,
      requiredPermission: "recipes:apply",
    });
  const firstApplicationId = "application-recipe-executed";
  const createFirstApplication = createApplication(firstApplicationId, 2000);
  const firstApplication = await createFirstApplication({
    actor,
    datasetId: product.dataset.datasetId,
    maxCells: 1,
    recipeId: recipe.enrichmentRecipeId,
    recipeRevision: recipe.recipeRevision,
  });
  const firstApplicationReplay = await createFirstApplication({
    actor,
    datasetId: product.dataset.datasetId,
    maxCells: 1,
    recipeId: recipe.enrichmentRecipeId,
    recipeRevision: recipe.recipeRevision,
  });
  assert.equal(firstApplication.ok && firstApplication.value.replayed, false);
  assert.equal(
    firstApplicationReplay.ok && firstApplicationReplay.value.replayed,
    true
  );

  const exactInput = await runtime.recipes.transaction(scope, ({ inputs }) =>
    inputs.resolveExact(scope, firstApplicationId, record)
  );
  if (exactInput === undefined) {
    throw new Error("The exact recipe input was not resolved.");
  }
  assert.deepEqual(exactInput.inputValues, [
    {
      fieldId: product.sourceField.fieldId,
      present: true,
      value: "synthetic.invalid",
    },
  ]);
  assert.deepEqual(exactInput.normalizedInput, {
    datasetId: product.dataset.datasetId,
    inputValues: exactInput.inputValues,
    recipeId: recipe.enrichmentRecipeId,
    recipeRevision: recipe.recipeRevision,
    recordContentHash: exactInput.recordContentHash,
    recordId: record,
    targetFieldId: product.targetField.fieldId,
    workflowContentHash: workflowIdentity.workflowContentHash,
    workflowRevision: workflowIdentity.workflowRevision,
    workflowSpecId: workflowIdentity.workflowSpecId,
    workspaceId: workspace,
  });
  assert.equal(canonicalHash(exactInput.normalizedInput), exactInput.inputHash);

  const authority = planning.authorities[0];
  const policy = planning.policies[0];
  if (authority === undefined || policy === undefined) {
    throw new Error("The planning fixture is incomplete.");
  }
  const preparedPlan = prepareRunPlan({
    actorPermissions: actor.permissions,
    allowedCapabilities: [capability.capabilityId],
    authority,
    budget: { limit: 5, reserved: 0, spent: 0, unit: "credits" },
    catalogFingerprint: contract.catalogFingerprint,
    catalogVersion: contract.catalogVersion,
    compilationLimits: { maxDepth: 1, maxFanOut: 1, maxNodes: 1 },
    compilerVersion: "1.0.0",
    deadline: instant(4_102_444_700_000),
    inputContract: contract,
    normalizedInputHash: exactInput.inputHash,
    now: instant(2500),
    outputContract,
    planHash: hash("recipe-run-plan"),
    policy: policy.policy,
    quote: {
      expiresAt: instant(4_102_444_600_000),
      guarantee: "hard",
      pricingVersion: "1.0.0",
      quoteId: "quote-recipe",
      unit: "credits",
      upperBound: 5,
    },
    retryPolicy: { maxAttemptsPerStep: 2 },
    runPlanId: runPlanId("plan-recipe-cell"),
    workflow: planning.workflows[0]?.workflow ?? {
      contentHash: workflowIdentity.workflowContentHash,
      nodes: [],
      revision: workflowIdentity.workflowRevision,
      workflowSpecId: workflowIdentity.workflowSpecId,
    },
    workspaceId: workspace,
  });
  if (!preparedPlan.ok) {
    throw new Error(`Recipe run plan failed: ${preparedPlan.error.code}`);
  }
  const plan = preparedPlan.value;
  const inputId = "input-recipe-cell";
  const validatedInput: ValidatedRunInput = {
    classification: "internal",
    contentHash: exactInput.inputHash,
    contract,
    finalizedAt: instant(2600),
    inputId,
    mediaType: "application/json",
    sizeBytes: Buffer.byteLength(
      canonicalSerialize(exactInput.normalizedInput),
      "utf8"
    ),
    validatedAt: instant(2600),
    validatorVersion: "recipe-input-validator-v1",
    value: exactInput.normalizedInput,
  };
  const sources: RunPlanSources = {
    authorityEnvelopeId: authority.authorityEnvelopeId,
    policySnapshotId: "policy-recipe",
    pricingSnapshotId: "pricing-recipe",
    ...workflowIdentity,
  };
  await runtime.planning.transaction(scope, ({ runPlans }) =>
    runPlans.insert(scope, { input: validatedInput, plan, sources })
  );
  const planEvidence = await sql<
    readonly {
      authority_envelope_id: string;
      consumed: boolean;
      content_hash: string;
      input_id: string;
      normalized_payload: unknown;
      plan_hash: string;
      policy_snapshot_id: string;
      pricing_snapshot_id: string;
      workflow_content_hash: string;
      workflow_revision: string;
      workflow_spec_id: string;
    }[]
  >`
    SELECT
      source.authority_envelope_id,
      stored_plan.consumed_by IS NOT NULL AS consumed,
      input.content_hash,
      input.input_id,
      input.normalized_payload,
      stored_plan.plan ->> 'planHash' AS plan_hash,
      source.policy_snapshot_id,
      source.pricing_snapshot_id,
      source.workflow_content_hash,
      source.workflow_revision,
      source.workflow_spec_id
    FROM kurobara_core.run_plans AS stored_plan
    JOIN kurobara_core.run_plan_sources AS source
      USING (workspace_id, run_plan_id)
    JOIN kurobara_core.run_plan_inputs AS input
      USING (workspace_id, run_plan_id)
    WHERE stored_plan.workspace_id = ${workspace}
      AND stored_plan.run_plan_id = ${plan.runPlanId}
  `;
  assert.deepEqual(planEvidence[0], {
    authority_envelope_id: sources.authorityEnvelopeId,
    consumed: false,
    content_hash: exactInput.inputHash,
    input_id: inputId,
    normalized_payload: exactInput.normalizedInput,
    plan_hash: plan.planHash,
    policy_snapshot_id: sources.policySnapshotId,
    pricing_snapshot_id: sources.pricingSnapshotId,
    workflow_content_hash: sources.workflowContentHash,
    workflow_revision: sources.workflowRevision,
    workflow_spec_id: sources.workflowSpecId,
  });

  const createCellRun = makeCreateRecipeCellRun({
    clock: { now: async () => instant(3000) },
    identifiers: {
      nextEventId: async () => eventId("event-recipe-run-queued"),
      nextOutboxMessageId: async () =>
        outboxMessageId("outbox-recipe-run-queued"),
      nextRunId: async () => runId("run-recipe-cell"),
    },
    persistence: runtime.recipeCellRuns,
    requiredPermission: "recipes:apply",
  });
  const createRequest = {
    actor,
    correlationId: correlationId("correlation-recipe-cell"),
    input: exactInput,
    inputId,
    planHash: plan.planHash,
    runPlanId: plan.runPlanId,
  } as const;
  await assert.rejects(
    () => createCellRun({ ...createRequest, inputId: "input-missing" }),
    (error: unknown) =>
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "23503"
  );
  const rollbackReadback = await sql<
    readonly {
      application_cells: string;
      cache_slots: string;
      cell_results: string;
      consumed: boolean;
      outbox_messages: string;
      run_events: string;
      runs: string;
    }[]
  >`
    SELECT
      (SELECT count(*)::text FROM kurobara_core.recipe_application_cells
        WHERE workspace_id = ${workspace}) AS application_cells,
      (SELECT count(*)::text FROM kurobara_core.recipe_cell_cache
        WHERE workspace_id = ${workspace}) AS cache_slots,
      (SELECT count(*)::text FROM kurobara_core.cell_results
        WHERE workspace_id = ${workspace}) AS cell_results,
      (SELECT consumed_by IS NOT NULL FROM kurobara_core.run_plans
        WHERE workspace_id = ${workspace}
          AND run_plan_id = ${plan.runPlanId}) AS consumed,
      (SELECT count(*)::text FROM kurobara_core.outbox_messages
        WHERE workspace_id = ${workspace}) AS outbox_messages,
      (SELECT count(*)::text FROM kurobara_core.run_events
        WHERE workspace_id = ${workspace}) AS run_events,
      (SELECT count(*)::text FROM kurobara_core.runs
        WHERE workspace_id = ${workspace}) AS runs
  `;
  assert.deepEqual(rollbackReadback[0], {
    application_cells: "0",
    cache_slots: "0",
    cell_results: "0",
    consumed: false,
    outbox_messages: "0",
    run_events: "0",
    runs: "0",
  });

  const created = await createCellRun(createRequest);
  assert.equal(created.ok && created.value.status, "created");
  if (!(created.ok && created.value.status === "created")) {
    throw new Error("The recipe cell Run was not created.");
  }
  assert.equal(created.value.run.state, "queued");
  const boundReplay = await createCellRun(createRequest);
  assert.equal(boundReplay.ok && boundReplay.value.status, "bound");
  const queuedWatch = await runtime.recipeApplicationWatches.get(
    scope,
    firstApplicationId
  );
  assert.deepEqual(queuedWatch, {
    application: firstApplication.ok
      ? firstApplication.value.application
      : undefined,
    counts: {
      bound: 1,
      failed: 0,
      pending: 1,
      running: 0,
      skipped: 0,
      succeeded: 0,
      total: 1,
      unbound: 0,
    },
  });
  assert.equal(
    await runtime.recipeApplicationWatches.get(
      { workspaceId: isolatedWorkspace },
      firstApplicationId
    ),
    undefined
  );

  const claim = makeClaimRunExecution({
    clock: { now: async () => instant(4000) },
    identifiers: {
      nextEventId: async () => eventId("event-recipe-run-started"),
      nextOutboxMessageId: async () => outboxMessageId("unused-recipe-outbox"),
      nextRunId: async () => runId("unused-recipe-run"),
    },
    persistence: runtime.runExecution,
  });
  const claimed = await claim({
    eventId: eventId("orchestration-recipe-run"),
    runId: created.value.run.runId,
    startKey: "start-recipe-run",
    workspaceId: workspace,
  });
  assert.equal(claimed.ok, true);
  if (!claimed.ok) {
    throw new Error(claimed.error.message);
  }
  assert.equal(claimed.value.run.state, "running");
  const runningCell = await runtime.recipes.transaction(
    scope,
    ({ cellResults }) => cellResults.getByRun(scope, created.value.run.runId)
  );
  assert.equal(runningCell?.status, "running");
  assert.equal(runningCell?.cellResultId, created.value.cellResultId);

  let dagEventSequence = 0;
  const materialize = makeMaterializeNextDagRun({
    clock: { now: async () => instant(6000) },
    identifiers: {
      nextEventId: async () => eventId(`recipe-dag-${++dagEventSequence}`),
    },
    persistence: runtime.dagScheduling,
  });
  const roots = await materialize();
  assert.equal(roots.status, "processed");
  if (roots.status === "processed") {
    assert.deepEqual(
      roots.created.map((step) => step.nodeKey),
      ["resolve-category"]
    );
  }
  const expiresAt = instant(4_102_444_800_000);
  const sink = {
    confidence: 0.93,
    freshness: { expiresAt, observedAt: instant(5000) },
    provenance: { references: ["source:synthetic-fixture"] },
    value: null,
  } as const;
  await setStepSucceededWithOutputEvidence(
    claimed.value.run,
    "resolve-category",
    plan.outputContract,
    sink
  );
  await runtime.runExecution.transaction(scope, ({ dagSchedule }) =>
    dagSchedule.request(scope, created.value.run.runId)
  );
  const convergence = await materialize();
  assert.equal(convergence.status, "processed");
  if (convergence.status !== "processed") {
    throw new Error("The recipe run did not converge.");
  }
  assert.deepEqual(convergence.outcome, { status: "success-finalized" });
  assert.equal(convergence.finalized?.run.state, "completed");
  const manifest = convergence.finalized?.manifest;
  if (manifest === undefined || manifest.output.status !== "accepted") {
    throw new Error("The completed recipe run has no accepted manifest.");
  }
  assert.equal(manifest.output.artifact.contentHash, canonicalHash(sink));

  const projection = await collect(
    runtime.recipes.streamExactProjection(scope, firstApplicationId)
  );
  assert.equal(projection.length, 1);
  const projected = projection[0];
  if (projected === undefined) {
    throw new Error("The executed recipe projection is missing.");
  }
  assert.equal(projected.binding, "executed");
  assert.equal(projected.application.recipeApplicationId, firstApplicationId);
  assert.deepEqual(projected.record, {
    datasetId: product.dataset.datasetId,
    recordId: record,
    values: [
      {
        fieldId: product.sourceField.fieldId,
        value: "synthetic.invalid",
      },
    ],
    workspaceId: workspace,
  });
  assert.equal(projected.recordContentHash, exactInput.recordContentHash);
  assert.deepEqual(projected.cellResult, {
    cellResultId: created.value.cellResultId,
    confidence: sink.confidence,
    cost: { amount: 0, basis: "exact", unit: "credits" },
    datasetId: product.dataset.datasetId,
    enrichmentRecipeId: recipe.enrichmentRecipeId,
    fieldId: product.targetField.fieldId,
    freshness: sink.freshness,
    provenance: sink.provenance,
    recipeRevision: recipe.recipeRevision,
    recordId: record,
    runId: created.value.run.runId,
    status: "succeeded",
    value: sink.value,
    workspaceId: workspace,
  });

  const terminalEvidence = await sql<
    readonly {
      artifact_content_hash: string;
      artifact_id: string;
      manifest_hash: string;
      normalized_payload: unknown;
      result_manifest_id: string;
      source_run_aggregate_version: number;
      status: string;
      value_is_sql_null: boolean;
      value_type: string;
    }[]
  >`
    SELECT
      cell.artifact_content_hash,
      cell.artifact_id,
      cell.manifest_hash,
      artifact.normalized_payload,
      cell.result_manifest_id,
      cell.source_run_aggregate_version,
      cell.status,
      cell.value IS NULL AS value_is_sql_null,
      jsonb_typeof(cell.value) AS value_type
    FROM kurobara_core.cell_results AS cell
    JOIN kurobara_core.run_output_artifacts AS artifact
      ON artifact.workspace_id = cell.workspace_id
      AND artifact.run_id = cell.run_id
      AND artifact.artifact_id = cell.artifact_id
      AND artifact.content_hash = cell.artifact_content_hash
    WHERE cell.workspace_id = ${workspace}
      AND cell.cell_result_id = ${created.value.cellResultId}
  `;
  assert.deepEqual(terminalEvidence[0], {
    artifact_content_hash: manifest.output.artifact.contentHash,
    artifact_id: manifest.output.artifact.artifactId,
    manifest_hash: manifest.manifestHash,
    normalized_payload: sink,
    result_manifest_id: manifest.resultManifestId,
    source_run_aggregate_version: convergence.finalized?.run.aggregateVersion,
    status: "succeeded",
    value_is_sql_null: false,
    value_type: "null",
  });

  const cache = await runtime.recipes.transaction(scope, ({ cache }) =>
    cache.getForUpdate(scope, exactInput.cacheKey)
  );
  assert.equal(cache?.activeCellResultId, undefined);
  assert.equal(cache?.validCellResultId, created.value.cellResultId);
  assert.equal(cache?.validUntil, expiresAt);
  assert.equal(cache?.revision, 2);

  const cachedApplicationId = "application-recipe-cached";
  const cachedApplication = await createApplication(
    cachedApplicationId,
    7000
  )({
    actor,
    datasetId: product.dataset.datasetId,
    maxCells: 1,
    recipeId: recipe.enrichmentRecipeId,
    recipeRevision: recipe.recipeRevision,
  });
  assert.equal(cachedApplication.ok, true);
  const cachedInput = await runtime.recipes.transaction(scope, ({ inputs }) =>
    inputs.resolveExact(scope, cachedApplicationId, record)
  );
  if (cachedInput === undefined) {
    throw new Error("The cached application input was not resolved.");
  }
  assert.equal(cachedInput.cacheKey, exactInput.cacheKey);
  assert.equal(cachedInput.inputHash, exactInput.inputHash);
  const cachedPin = await createCellRun({
    ...createRequest,
    correlationId: correlationId("correlation-recipe-cache"),
    input: cachedInput,
  });
  assert.equal(cachedPin.ok && cachedPin.value.status, "cached");
  assert.equal(
    cachedPin.ok && cachedPin.value.cellResultId,
    created.value.cellResultId
  );
  const cachedReplay = await createCellRun({
    ...createRequest,
    correlationId: correlationId("correlation-recipe-cache"),
    input: cachedInput,
  });
  assert.equal(cachedReplay.ok && cachedReplay.value.status, "bound");
  const cachedProjection = await collect(
    runtime.recipes.streamExactProjection(scope, cachedApplicationId)
  );
  assert.equal(cachedProjection.length, 1);
  assert.equal(cachedProjection[0]?.binding, "cached");
  assert.deepEqual(cachedProjection[0]?.cellResult, projected.cellResult);

  const isolatedScope = { workspaceId: isolatedWorkspace } as const;
  const isolated = await runtime.recipes.transaction(
    isolatedScope,
    async ({ applications, cache, cellResults, inputs }) => ({
      application: await applications.get(isolatedScope, firstApplicationId),
      cache: await cache.getForUpdate(isolatedScope, exactInput.cacheKey),
      cell: await cellResults.getByRun(isolatedScope, created.value.run.runId),
      input: await inputs.resolveExact(
        isolatedScope,
        firstApplicationId,
        record
      ),
    })
  );
  assert.deepEqual(isolated, {
    application: undefined,
    cache: undefined,
    cell: undefined,
    input: undefined,
  });
  assert.deepEqual(
    await collect(
      runtime.recipes.streamExactProjection(isolatedScope, firstApplicationId)
    ),
    []
  );
  assert.equal(
    await runtime.runQueries.get(isolatedScope, created.value.run.runId),
    undefined
  );

  const finalCounts = await sql<
    readonly {
      application_cells: string;
      cache_slots: string;
      cached_bindings: string;
      cell_results: string;
      executed_bindings: string;
      runs: string;
    }[]
  >`
    SELECT
      count(*)::text AS application_cells,
      (SELECT count(*)::text FROM kurobara_core.recipe_cell_cache
        WHERE workspace_id = ${workspace}) AS cache_slots,
      count(*) FILTER (WHERE binding = 'cached')::text AS cached_bindings,
      (SELECT count(*)::text FROM kurobara_core.cell_results
        WHERE workspace_id = ${workspace}) AS cell_results,
      count(*) FILTER (WHERE binding = 'executed')::text AS executed_bindings,
      (SELECT count(*)::text FROM kurobara_core.runs
        WHERE workspace_id = ${workspace}) AS runs
    FROM kurobara_core.recipe_application_cells
    WHERE workspace_id = ${workspace}
  `;
  assert.deepEqual(finalCounts[0], {
    application_cells: "2",
    cache_slots: "1",
    cached_bindings: "1",
    cell_results: "1",
    executed_bindings: "1",
    runs: "1",
  });

  const concurrentRecipe: EnrichmentRecipe = {
    ...recipe,
    enrichmentRecipeId: enrichmentRecipeId("recipe-category-concurrent"),
  };
  const concurrentRegistration = await registerRecipe({
    actor,
    datasetId: product.dataset.datasetId,
    recipe: concurrentRecipe,
  });
  assert.equal(concurrentRegistration.ok, true);

  const concurrentApplicationIds = [
    "application-recipe-concurrent-a",
    "application-recipe-concurrent-b",
  ] as const;
  for (const [
    index,
    recipeApplicationId,
  ] of concurrentApplicationIds.entries()) {
    const applicationResult = await createApplication(
      recipeApplicationId,
      8000 + index
    )({
      actor,
      datasetId: product.dataset.datasetId,
      maxCells: 1,
      recipeId: concurrentRecipe.enrichmentRecipeId,
      recipeRevision: concurrentRecipe.recipeRevision,
    });
    assert.equal(applicationResult.ok, true);
  }
  const concurrentInputs = await Promise.all(
    concurrentApplicationIds.map((recipeApplicationId) =>
      runtime.recipes.transaction(scope, ({ inputs }) =>
        inputs.resolveExact(scope, recipeApplicationId, record)
      )
    )
  );
  const [concurrentInputA, concurrentInputB] = concurrentInputs;
  if (concurrentInputA === undefined || concurrentInputB === undefined) {
    throw new Error("The concurrent exact recipe inputs were not resolved.");
  }
  assert.equal(concurrentInputA.cacheKey, concurrentInputB.cacheKey);
  assert.equal(concurrentInputA.inputHash, concurrentInputB.inputHash);

  const prepareConcurrentPlan = (identity: "a" | "b") => {
    const prepared = prepareRunPlan({
      actorPermissions: actor.permissions,
      allowedCapabilities: [capability.capabilityId],
      authority,
      budget: { limit: 5, reserved: 0, spent: 0, unit: "credits" },
      catalogFingerprint: contract.catalogFingerprint,
      catalogVersion: contract.catalogVersion,
      compilationLimits: { maxDepth: 1, maxFanOut: 1, maxNodes: 1 },
      compilerVersion: "1.0.0",
      deadline: instant(4_102_444_700_000),
      inputContract: contract,
      normalizedInputHash: concurrentInputA.inputHash,
      now: instant(8500),
      outputContract,
      planHash: hash(`recipe-concurrent-plan-${identity}`),
      policy: policy.policy,
      quote: {
        expiresAt: instant(4_102_444_600_000),
        guarantee: "hard",
        pricingVersion: "1.0.0",
        quoteId: `quote-recipe-concurrent-${identity}`,
        unit: "credits",
        upperBound: 5,
      },
      retryPolicy: { maxAttemptsPerStep: 2 },
      runPlanId: runPlanId(`plan-recipe-concurrent-${identity}`),
      workflow: planning.workflows[0]?.workflow ?? {
        contentHash: workflowIdentity.workflowContentHash,
        nodes: [],
        revision: workflowIdentity.workflowRevision,
        workflowSpecId: workflowIdentity.workflowSpecId,
      },
      workspaceId: workspace,
    });
    if (!prepared.ok) {
      throw new Error(`Concurrent recipe plan failed: ${prepared.error.code}`);
    }
    return prepared.value;
  };
  const concurrentPlans = [
    prepareConcurrentPlan("a"),
    prepareConcurrentPlan("b"),
  ] as const;
  const concurrentInputIds = [
    "input-recipe-concurrent-a",
    "input-recipe-concurrent-b",
  ] as const;
  await Promise.all(
    concurrentPlans.map((concurrentPlan, index) => {
      const concurrentInput = concurrentInputs[index];
      const concurrentInputId = concurrentInputIds[index];
      if (concurrentInput === undefined || concurrentInputId === undefined) {
        throw new Error("The concurrent plan fixture is incomplete.");
      }
      const persistedInput: ValidatedRunInput = {
        classification: "internal",
        contentHash: concurrentInput.inputHash,
        contract,
        finalizedAt: instant(8600 + index),
        inputId: concurrentInputId,
        mediaType: "application/json",
        sizeBytes: Buffer.byteLength(
          canonicalSerialize(concurrentInput.normalizedInput),
          "utf8"
        ),
        validatedAt: instant(8600 + index),
        validatorVersion: "recipe-input-validator-v1",
        value: concurrentInput.normalizedInput,
      };
      return runtime.planning.transaction(scope, ({ runPlans }) =>
        runPlans.insert(scope, {
          input: persistedInput,
          plan: concurrentPlan,
          sources,
        })
      );
    })
  );

  const concurrentCreators = concurrentPlans.map((_, index) =>
    makeCreateRecipeCellRun({
      clock: { now: async () => instant(9000) },
      identifiers: {
        nextEventId: async () => eventId(`event-recipe-concurrent-${index}`),
        nextOutboxMessageId: async () =>
          outboxMessageId(`outbox-recipe-concurrent-${index}`),
        nextRunId: async () => runId(`run-recipe-concurrent-${index}`),
      },
      persistence: runtime.recipeCellRuns,
      requiredPermission: "recipes:apply",
    })
  );
  const concurrentResults = await Promise.all(
    concurrentCreators.map((createConcurrentCellRun, index) => {
      const concurrentInput = concurrentInputs[index];
      const concurrentInputId = concurrentInputIds[index];
      const concurrentPlan = concurrentPlans[index];
      if (
        concurrentInput === undefined ||
        concurrentInputId === undefined ||
        concurrentPlan === undefined
      ) {
        throw new Error("The concurrent creation fixture is incomplete.");
      }
      return createConcurrentCellRun({
        actor,
        correlationId: correlationId(`correlation-recipe-${index}`),
        input: concurrentInput,
        inputId: concurrentInputId,
        planHash: concurrentPlan.planHash,
        runPlanId: concurrentPlan.runPlanId,
      });
    })
  );
  assert.deepEqual(
    concurrentResults
      .map((result) => (result.ok ? result.value.status : result.error.code))
      .sort(),
    ["active", "created"]
  );
  const concurrentCreated = concurrentResults.find(
    (result) => result.ok && result.value.status === "created"
  );
  if (
    concurrentCreated === undefined ||
    !concurrentCreated.ok ||
    concurrentCreated.value.status !== "created"
  ) {
    throw new Error("The concurrent cache winner is missing.");
  }
  const concurrentWatches = await Promise.all(
    concurrentApplicationIds.map((applicationId) =>
      runtime.recipeApplicationWatches.get(scope, applicationId)
    )
  );
  for (const watch of concurrentWatches) {
    assert.deepEqual(watch?.counts, {
      bound: 1,
      failed: 0,
      pending: 1,
      running: 0,
      skipped: 0,
      succeeded: 0,
      total: 1,
      unbound: 0,
    });
  }
  const activeIndex = concurrentResults.findIndex(
    (result) => result.ok && result.value.status === "active"
  );
  const activeCreator = concurrentCreators[activeIndex];
  const activeInput = concurrentInputs[activeIndex];
  const activeInputId = concurrentInputIds[activeIndex];
  const activePlan = concurrentPlans[activeIndex];
  if (
    activeIndex < 0 ||
    activeCreator === undefined ||
    activeInput === undefined ||
    activeInputId === undefined ||
    activePlan === undefined
  ) {
    throw new Error("The active shared recipe fixture is incomplete.");
  }
  const activeReplay = await activeCreator({
    actor,
    correlationId: correlationId(`correlation-recipe-${activeIndex}`),
    input: activeInput,
    inputId: activeInputId,
    planHash: activePlan.planHash,
    runPlanId: activePlan.runPlanId,
  });
  assert.equal(activeReplay.ok && activeReplay.value.status, "bound");
  const concurrentReadback = await sql<
    readonly {
      active_cell_result_id: string | null;
      application_cells: string;
      cell_results: string;
      runs: string;
    }[]
  >`
    SELECT
      cache.active_cell_result_id,
      (SELECT count(*)::text
       FROM kurobara_core.recipe_application_cells AS binding
       WHERE binding.workspace_id = ${workspace}
         AND binding.recipe_application_id = ANY(${concurrentApplicationIds}::text[])
      ) AS application_cells,
      (SELECT count(*)::text
       FROM kurobara_core.cell_results AS cell
       WHERE cell.workspace_id = ${workspace}
         AND cell.enrichment_recipe_id = ${concurrentRecipe.enrichmentRecipeId}
      ) AS cell_results,
      (SELECT count(*)::text
       FROM kurobara_core.runs AS stored_run
       JOIN kurobara_core.cell_results AS cell
         ON cell.workspace_id = stored_run.workspace_id
         AND cell.run_id = stored_run.run_id
       WHERE cell.workspace_id = ${workspace}
         AND cell.enrichment_recipe_id = ${concurrentRecipe.enrichmentRecipeId}
      ) AS runs
    FROM kurobara_core.recipe_cell_cache AS cache
    WHERE cache.workspace_id = ${workspace}
      AND cache.cache_key = ${concurrentInputA.cacheKey}
  `;
  assert.deepEqual(concurrentReadback[0], {
    active_cell_result_id: concurrentCreated.value.cellResultId,
    application_cells: "2",
    cell_results: "1",
    runs: "1",
  });

  const claimConcurrentRun = makeClaimRunExecution({
    clock: { now: async () => instant(10_000) },
    identifiers: {
      nextEventId: async () => eventId("event-recipe-concurrent-started"),
      nextOutboxMessageId: async () =>
        outboxMessageId("unused-recipe-concurrent-outbox"),
      nextRunId: async () => runId("unused-recipe-concurrent-run"),
    },
    persistence: runtime.runExecution,
  });
  const claimedConcurrent = await claimConcurrentRun({
    eventId: eventId("orchestration-recipe-concurrent"),
    runId: concurrentCreated.value.run.runId,
    startKey: "start-recipe-concurrent",
    workspaceId: workspace,
  });
  assert.equal(claimedConcurrent.ok, true);
  if (!claimedConcurrent.ok) {
    throw new Error(claimedConcurrent.error.message);
  }
  let concurrentDagEventSequence = 0;
  const materializeConcurrent = makeMaterializeNextDagRun({
    clock: { now: async () => instant(11_000) },
    identifiers: {
      nextEventId: async () =>
        eventId(`recipe-concurrent-dag-${++concurrentDagEventSequence}`),
    },
    persistence: runtime.dagScheduling,
  });
  const concurrentRoots = await materializeConcurrent();
  assert.equal(concurrentRoots.status, "processed");
  await setStepSucceededWithOutputEvidence(
    claimedConcurrent.value.run,
    "resolve-category",
    outputContract,
    {
      confidence: 0.88,
      freshness: {
        expiresAt: instant(4_102_444_800_000),
        observedAt: instant(11_000),
      },
      provenance: { references: ["source:synthetic-concurrent"] },
      value: "shared-software",
    }
  );
  await runtime.runExecution.transaction(scope, ({ dagSchedule }) =>
    dagSchedule.request(scope, claimedConcurrent.value.run.runId)
  );
  const concurrentConvergence = await materializeConcurrent();
  assert.equal(concurrentConvergence.status, "processed");
  if (concurrentConvergence.status !== "processed") {
    throw new Error("The shared recipe run did not converge.");
  }
  assert.deepEqual(concurrentConvergence.outcome, {
    status: "success-finalized",
  });
  const terminalSharedWatches = await Promise.all(
    concurrentApplicationIds.map((applicationId) =>
      runtime.recipeApplicationWatches.get(scope, applicationId)
    )
  );
  for (const watch of terminalSharedWatches) {
    assert.deepEqual(watch?.counts, {
      bound: 1,
      failed: 0,
      pending: 0,
      running: 0,
      skipped: 0,
      succeeded: 1,
      total: 1,
      unbound: 0,
    });
  }

  await assert.rejects(
    () =>
      sql.begin(async (transaction) => {
        await transaction`
          UPDATE kurobara_core.runs
          SET run = jsonb_set(
            jsonb_set(run, '{state}', '"cancelled"'::jsonb),
            '{aggregateVersion}',
            to_jsonb((run ->> 'aggregateVersion')::integer + 1)
          )
          WHERE workspace_id = ${workspace}
            AND run_id = ${concurrentCreated.value.run.runId}
        `;
      }),
    (error: unknown) =>
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "23514"
  );
  const alignedAfterRejectedCancellation = await sql<
    readonly { cell_status: string; run_state: string }[]
  >`
    SELECT
      cell.status AS cell_status,
      stored_run.run ->> 'state' AS run_state
    FROM kurobara_core.runs AS stored_run
    JOIN kurobara_core.cell_results AS cell
      USING (workspace_id, run_id)
    WHERE stored_run.workspace_id = ${workspace}
      AND stored_run.run_id = ${concurrentCreated.value.run.runId}
  `;
  assert.deepEqual(alignedAfterRejectedCancellation[0], {
    cell_status: "succeeded",
    run_state: "completed",
  });
});

const holdRecipeIdentityLock = async (
  identity: readonly string[]
): Promise<() => Promise<void>> => {
  let markAcquired: (() => void) | undefined;
  let release: (() => void) | undefined;
  const acquired = new Promise<void>((resolve) => {
    markAcquired = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const holding = sql.begin(async (transaction) => {
    await transaction`
      SELECT pg_advisory_xact_lock(
        hashtextextended(${JSON.stringify(identity)}, 0::bigint)
      )
    `;
    markAcquired?.();
    await gate;
  });
  await acquired;
  return async () => {
    release?.();
    await holding;
  };
};

const waitForAdvisoryWaiters = async (minimum: number): Promise<void> => {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const rows = await sql<readonly { waiting: string }[]>`
      SELECT count(*)::text AS waiting
      FROM pg_locks
      WHERE locktype = 'advisory'
        AND database = (
          SELECT oid
          FROM pg_database
          WHERE datname = current_database()
        )
        AND NOT granted
    `;
    if (Number(rows[0]?.waiting ?? 0) >= minimum) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Concurrent requests did not reach the advisory lock.");
};

test("serializes concurrent recipe and application identities into replay or canonical conflict", async () => {
  const workspace = workspaceId("workspace-recipe-identity-race");
  const product = productFor(workspace);
  const actor: VerifiedApiKey = {
    actorId: actorId("actor-recipe-identity-race"),
    authenticationMode: "api-key",
    credentialId: "credential-recipe-identity-race",
    permissions: [
      "datasets:import",
      "recipes:export",
      "recipes:register",
      "recipes:apply",
    ],
    workspaceId: workspace,
  };
  await runtime.bootstrapApiKey({
    actorId: actor.actorId,
    label: "Recipe identity race",
    permissions: actor.permissions,
    workspaceId: workspace,
  });
  const source = JSON.stringify({
    dataset_id: product.dataset.datasetId,
    record_id: "record-recipe-identity-race",
    values: [
      {
        field_id: product.sourceField.fieldId,
        value: "race.invalid",
      },
    ],
    workspace_id: workspace,
  });
  const imported = await makeImportDataset({
    codecs: {
      csv: createCsvDatasetCodec(),
      jsonl: createJsonlDatasetCodec(),
    },
    datasets: runtime.datasets,
    requiredPermission: "datasets:import",
  })({
    actor,
    batchLimits: { maxBytes: 4096, maxItems: 10 },
    bytes: bytesOf(source),
    dataset: product.dataset,
    fields: [product.sourceField, product.targetField],
    format: "jsonl",
    importId: "import-recipe-identity-race",
    maxRecordBytes: 2048,
    sourceContentHash: hash(source),
  });
  assert.equal(imported.ok, true);

  const workflowIdentity = {
    workflowContentHash: hash("recipe-identity-race-workflow"),
    workflowRevision: "workflow-r1",
    workflowSpecId: workflowSpecId("workflow-identity-race"),
  } as const;
  const inputContract = {
    catalogFingerprint: hash("recipe-identity-race-catalog"),
    catalogVersion: "1.0.0",
    schemaFingerprint: hash("recipe-identity-race-input"),
    schemaId: "https://schemas.kurobara.invalid/recipe/race-input/1.0.0",
    schemaVersion: "1.0.0",
  } as const;
  const raceCapability = {
    capabilityId: capabilityId("organizations.category.race-resolve"),
    capabilityVersion: "1.0.0",
  } as const;
  const planningResult = await runtime.bootstrapPlanning({
    authorities: [
      {
        authorityEnvelopeId: "authority-recipe-identity-race",
        budgetLimit: { limit: 5, reserved: 0, spent: 0, unit: "credits" },
        capabilities: [raceCapability],
        deadline: instant(4_102_444_800_000),
        permissions: actor.permissions,
        subjectActorId: actor.actorId,
        version: "1.0.0",
        workspaceId: workspace,
      },
    ],
    defaults: {
      policySnapshotId: "policy-recipe-identity-race",
      pricingSnapshotId: "pricing-recipe-identity-race",
      workspaceId: workspace,
    },
    expectedDefaultsRevision: null,
    policies: [
      {
        policy: {
          factsHash: hash("recipe-identity-race-policy"),
          maxAttemptsPerStep: 1,
          requiredPermission: "recipes:apply",
          version: "1.0.0",
        },
        snapshotId: "policy-recipe-identity-race",
        workspaceId: workspace,
      },
    ],
    pricing: [
      {
        guarantee: "hard",
        snapshotId: "pricing-recipe-identity-race",
        ttlMilliseconds: 60_000,
        unit: "credits",
        upperBound: 1,
        version: "1.0.0",
        workspaceId: workspace,
      },
    ],
    workflows: [
      {
        allowedCapabilities: [raceCapability.capabilityId],
        catalogFingerprint: inputContract.catalogFingerprint,
        catalogVersion: inputContract.catalogVersion,
        compilationLimits: { maxDepth: 1, maxFanOut: 1, maxNodes: 1 },
        compilerVersion: "1.0.0",
        inputContract,
        outputContract: {
          ...inputContract,
          schemaFingerprint: hash("recipe-identity-race-output"),
          schemaId: "https://schemas.kurobara.invalid/recipe/race-output/1.0.0",
        },
        workflow: {
          contentHash: workflowIdentity.workflowContentHash,
          nodes: [
            { capability: raceCapability, dependsOn: [], key: "resolve" },
          ],
          revision: workflowIdentity.workflowRevision,
          workflowSpecId: workflowIdentity.workflowSpecId,
        },
        workspaceId: workspace,
      },
    ],
    workspaceId: workspace,
  });
  assert.equal(planningResult.status, "applied");

  const recipe: EnrichmentRecipe = {
    datasetId: product.dataset.datasetId,
    enrichmentRecipeId: enrichmentRecipeId("recipe-identity-race"),
    inputFieldIds: [product.sourceField.fieldId],
    name: "Resolve a synthetic category",
    recipeRevision: "recipe-r1",
    targetFieldId: product.targetField.fieldId,
    workflowContentHash: workflowIdentity.workflowContentHash,
    workflowRevision: workflowIdentity.workflowRevision,
    workflowSpecId: workflowIdentity.workflowSpecId,
    workspaceId: workspace,
  };
  const registerRecipe = makeRegisterEnrichmentRecipe({
    datasets: runtime.datasets,
    persistence: runtime.recipes,
    requiredPermission: "recipes:register",
  });

  const releaseRecipeReplay = await holdRecipeIdentityLock([
    "enrichment-recipe",
    workspace,
    recipe.datasetId,
    recipe.enrichmentRecipeId,
    recipe.recipeRevision,
  ]);
  const recipeReplayRequests = Promise.all([
    registerRecipe({ actor, datasetId: recipe.datasetId, recipe }),
    registerRecipe({ actor, datasetId: recipe.datasetId, recipe }),
  ]);
  try {
    await waitForAdvisoryWaiters(2);
  } finally {
    await releaseRecipeReplay();
  }
  const recipeReplayResults = await recipeReplayRequests;
  assert.deepEqual(
    recipeReplayResults
      .map((result) => (result.ok ? result.value.replayed : result.error.code))
      .sort(),
    [false, true]
  );

  const divergentRecipe = {
    ...recipe,
    enrichmentRecipeId: enrichmentRecipeId("recipe-identity-conflict"),
  };
  const divergentRecipeContent = {
    ...divergentRecipe,
    name: "Conflicting synthetic category resolver",
  };
  const releaseRecipeConflict = await holdRecipeIdentityLock([
    "enrichment-recipe",
    workspace,
    divergentRecipe.datasetId,
    divergentRecipe.enrichmentRecipeId,
    divergentRecipe.recipeRevision,
  ]);
  const recipeConflictRequests = Promise.all([
    registerRecipe({
      actor,
      datasetId: divergentRecipe.datasetId,
      recipe: divergentRecipe,
    }),
    registerRecipe({
      actor,
      datasetId: divergentRecipeContent.datasetId,
      recipe: divergentRecipeContent,
    }),
  ]);
  try {
    await waitForAdvisoryWaiters(2);
  } finally {
    await releaseRecipeConflict();
  }
  const recipeConflictResults = await recipeConflictRequests;
  assert.deepEqual(
    recipeConflictResults
      .map((result) => (result.ok ? "registered" : result.error.code))
      .sort(),
    ["recipe-revision-conflict", "registered"]
  );

  const makeApplicationUseCase = (createdAt: number) =>
    makeCreateRecipeApplication({
      clock: { now: () => Promise.resolve(instant(createdAt)) },
      datasets: runtime.datasets,
      identifiers: {
        nextRecipeApplicationId: () =>
          Promise.resolve("unexpected-generated-application-id"),
      },
      persistence: runtime.recipes,
      requiredPermission: "recipes:apply",
    });
  const applicationRequest = {
    actor,
    datasetId: recipe.datasetId,
    maxCells: 1,
    recipeApplicationId: "application-identity-race",
    recipeId: recipe.enrichmentRecipeId,
    recipeRevision: recipe.recipeRevision,
  } as const;
  const releaseApplicationReplay = await holdRecipeIdentityLock([
    "recipe-application",
    workspace,
    applicationRequest.recipeApplicationId,
  ]);
  const applicationReplayRequests = Promise.all([
    makeApplicationUseCase(1000)(applicationRequest),
    makeApplicationUseCase(2000)(applicationRequest),
  ]);
  try {
    await waitForAdvisoryWaiters(2);
  } finally {
    await releaseApplicationReplay();
  }
  const applicationReplayResults = await applicationReplayRequests;
  assert.equal(
    applicationReplayResults.every((result) => result.ok),
    true
  );
  if (!applicationReplayResults.every((result) => result.ok)) {
    throw new Error("Concurrent application replay unexpectedly failed.");
  }
  assert.deepEqual(
    applicationReplayResults.map((result) => result.value.replayed).sort(),
    [false, true]
  );
  assert.deepEqual(
    applicationReplayResults[0]?.value.application,
    applicationReplayResults[1]?.value.application
  );

  const exportApplication = makeExportRecipeApplication({
    codecs: {
      csv: createCsvDatasetCodec(),
      jsonl: createJsonlDatasetCodec(),
    },
    datasets: runtime.datasets,
    maxExportBytes: 1_048_576,
    maxRecordBytes: 2048,
    persistence: runtime.recipes,
    requiredPermission: "recipes:export",
  });
  const releaseCreateExport = await holdRecipeIdentityLock([
    "recipe-application",
    workspace,
    applicationRequest.recipeApplicationId,
  ]);
  const exportRequest = exportApplication({
    actor,
    format: "jsonl",
    recipeApplicationId: applicationRequest.recipeApplicationId,
  });
  await waitForAdvisoryWaiters(1);
  const createReplayRequest = makeApplicationUseCase(5000)(applicationRequest);
  try {
    await waitForAdvisoryWaiters(2);
  } finally {
    await releaseCreateExport();
  }
  const [exported, createReplay] = await Promise.all([
    exportRequest,
    createReplayRequest,
  ]);
  assert.equal(createReplay.ok && createReplay.value.replayed, true);
  assert.equal(exported.ok, false);
  if (!exported.ok) {
    assert.equal(exported.error.code, "recipe-projection-count-mismatch");
  }

  const conflictingApplicationId = "application-identity-conflict";
  const releaseApplicationConflict = await holdRecipeIdentityLock([
    "recipe-application",
    workspace,
    conflictingApplicationId,
  ]);
  const applicationConflictRequests = Promise.all([
    makeApplicationUseCase(3000)({
      ...applicationRequest,
      recipeApplicationId: conflictingApplicationId,
    }),
    makeApplicationUseCase(4000)({
      ...applicationRequest,
      recipeApplicationId: conflictingApplicationId,
      recipeId: divergentRecipe.enrichmentRecipeId,
    }),
  ]);
  try {
    await waitForAdvisoryWaiters(2);
  } finally {
    await releaseApplicationConflict();
  }
  const applicationConflictResults = await applicationConflictRequests;
  assert.deepEqual(
    applicationConflictResults
      .map((result) => (result.ok ? "registered" : result.error.code))
      .sort(),
    ["recipe-application-conflict", "registered"]
  );
});
