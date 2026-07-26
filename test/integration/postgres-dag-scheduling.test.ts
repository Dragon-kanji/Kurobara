import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { after, before, test } from "node:test";

import {
  createPostgresRuntime,
  type PostgresRuntime,
} from "@kurobara/adapter-postgres";
import {
  makeMaterializeNextDagRun,
  prepareRunPlan,
} from "@kurobara/application";
import {
  actorId,
  capabilityId,
  contentHash,
  eventId,
  idempotencyKey,
  instant,
  type Run,
  type RunPlan,
  runId,
  runPlanId,
  type StepRunState,
  type WorkflowNode,
  type WorkspaceId,
  workflowSpecId,
  workspaceId,
} from "@kurobara/kernel";
import postgres from "postgres";

const SYNTHETIC_EVENT_ID_FAILURE = /synthetic-event-id-failure/u;
const DAG_STEP_DRIFT = /relational keys or immutable plan/u;
const DAG_ATTEMPT_DRIFT = /attempt does not match/u;
const RESULT_MANIFEST_IMMUTABLE = /result manifests are immutable/u;
const OUTPUT_ARTIFACT_IMMUTABLE = /output artifacts are immutable/u;

const adminUrl = process.env.KUROBARA_TEST_POSTGRES_URL;
if (adminUrl === undefined || adminUrl.trim().length === 0) {
  throw new Error(
    "KUROBARA_TEST_POSTGRES_URL must target a disposable-capable PostgreSQL admin database."
  );
}

const databaseName = `kurobara_dag_${process.pid}_${Date.now()}`;
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

const capability = {
  capabilityId: capabilityId("documents.summarize"),
  capabilityVersion: "1.0.0",
};

const planFor = (
  workspace: WorkspaceId,
  marker: string,
  nodes: readonly Omit<WorkflowNode, "capability">[]
): RunPlan => {
  const contract = {
    catalogFingerprint: hash("catalog"),
    catalogVersion: "1.0.0",
    schemaFingerprint: hash("schema"),
    schemaId: "https://schemas.kurobara.invalid/dag/1.0.0",
    schemaVersion: "1.0.0",
  };
  const prepared = prepareRunPlan({
    actorPermissions: ["runs:create"],
    allowedCapabilities: [capability.capabilityId],
    authority: {
      authorityEnvelopeId: `authority-${marker}`,
      budgetLimit: { limit: 10, reserved: 0, spent: 0, unit: "credits" },
      capabilities: [capability],
      deadline: instant(100_000),
      permissions: ["runs:create", "steps:execute"],
      subjectActorId: actorId("actor-dag-test"),
      version: "1.0.0",
      workspaceId: workspace,
    },
    budget: { limit: 10, reserved: 0, spent: 0, unit: "credits" },
    catalogFingerprint: hash("catalog"),
    catalogVersion: "1.0.0",
    compilationLimits: { maxDepth: 10, maxFanOut: 10, maxNodes: 10 },
    compilerVersion: "1.0.0",
    deadline: instant(90_000),
    inputContract: contract,
    normalizedInputHash: hash(`input-${marker}`),
    now: instant(1000),
    outputContract: contract,
    planHash: hash(`plan-${marker}`),
    policy: {
      factsHash: hash(`policy-${marker}`),
      requiredPermission: "runs:create",
      version: "1.0.0",
    },
    quote: {
      expiresAt: instant(80_000),
      guarantee: "hard",
      pricingVersion: "1.0.0",
      quoteId: `quote-${marker}`,
      unit: "credits",
      upperBound: 10,
    },
    retryPolicy: { maxAttemptsPerStep: 2 },
    runPlanId: runPlanId(`plan-${marker}`),
    workflow: {
      contentHash: hash(`workflow-${marker}`),
      nodes: nodes.map((node) => ({ ...node, capability })),
      revision: "1.0.0",
      workflowSpecId: workflowSpecId(`workflow-${marker}`),
    },
    workspaceId: workspace,
  });
  if (!prepared.ok) {
    throw new Error(`DAG plan preparation failed: ${prepared.error.code}`);
  }
  return prepared.value;
};

const createRunningRun = async (
  marker: string,
  nodes: readonly Omit<WorkflowNode, "capability">[],
  requestedWorkspace = workspaceId(`workspace-${marker}`),
  requestSchedule = true
): Promise<Readonly<{ plan: RunPlan; run: Run }>> => {
  const plan = planFor(requestedWorkspace, marker, nodes);
  const run: Run = {
    aggregateVersion: 2,
    createdAt: instant(1000),
    eventSequence: 2,
    idempotencyKey: idempotencyKey(`create-${marker}`),
    intentionHash: hash(`intention-${marker}`),
    resultCompleteness: "none",
    runId: runId(`run-${marker}`),
    runPlanId: plan.runPlanId,
    state: "running",
    workspaceId: requestedWorkspace,
  };
  await sql`
    INSERT INTO kurobara_core.workspaces (workspace_id)
    VALUES (${requestedWorkspace})
    ON CONFLICT DO NOTHING
  `;
  await sql`
    INSERT INTO kurobara_core.run_plans (workspace_id, run_plan_id, plan)
    VALUES (${requestedWorkspace}, ${plan.runPlanId}, ${sql.json(plan)})
  `;
  await sql`
    INSERT INTO kurobara_core.runs (
      workspace_id,
      run_id,
      run_plan_id,
      idempotency_key,
      intention_hash,
      cost,
      run
    ) VALUES (
      ${requestedWorkspace},
      ${run.runId},
      ${run.runPlanId},
      ${run.idempotencyKey},
      ${run.intentionHash},
      ${sql.json({ reserved: 0, spent: 0, unit: "credits" })},
      ${sql.json(run)}
    )
  `;
  if (requestSchedule) {
    const scope = { workspaceId: requestedWorkspace } as const;
    await runtime.runExecution.transaction(scope, (unitOfWork) =>
      unitOfWork.dagSchedule.request(scope, run.runId)
    );
  }
  return { plan, run };
};

let nextEvent = 0;
const materialize = () =>
  makeMaterializeNextDagRun({
    clock: { now: async () => instant(2000) },
    identifiers: {
      nextEventId: async () => eventId(`dag-ready-${++nextEvent}`),
    },
    persistence: runtime.dagScheduling,
  })();

const requestSchedule = async (run: Run): Promise<void> => {
  const scope = { workspaceId: run.workspaceId } as const;
  await runtime.runExecution.transaction(scope, (unitOfWork) =>
    unitOfWork.dagSchedule.request(scope, run.runId)
  );
};

const setStepState = async (
  run: Run,
  nodeKey: string,
  state: StepRunState
): Promise<void> => {
  await sql`
    UPDATE kurobara_core.step_runs
    SET
      state = ${state},
      step_run = jsonb_set(step_run, '{state}', to_jsonb(${state}::text))
    WHERE workspace_id = ${run.workspaceId}
      AND run_id = ${run.runId}
      AND node_key = ${nodeKey}
  `;
};

const setStepTerminalWithEvidence = async (
  run: Run,
  nodeKey: string,
  state: "failed" | "succeeded",
  outputContract?: RunPlan["outputContract"]
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
    const attemptState =
      state === "succeeded" ? "succeeded" : "failed_terminal";
    const normalizedPayload = { nodeKey, status: "succeeded" } as const;
    const canonicalPayload = JSON.stringify(normalizedPayload);
    const outputContentHash = hash(canonicalPayload);
    const artifactIdentifier = `artifact_${outputContentHash.slice("sha256:".length)}`;
    const validatedOutput =
      state === "succeeded" && outputContract !== undefined
        ? {
            artifact: {
              artifactId: artifactIdentifier,
              contentHash: outputContentHash,
            },
            contract: outputContract,
            validatedAt: 2000,
            validatorVersion: "json-schema-2020-12:test",
          }
        : undefined;
    const attempt = {
      attemptId: attemptIdentifier,
      attemptNumber: 1,
      authorityEnvelopeId: "authority-synthetic-success",
      claimedAt: 2000,
      costReservationId: reservationIdentifier,
      effectAdapterKey: "deterministic-local",
      effectStartedAt: 2000,
      finishedAt: 2000,
      operationKey: operationIdentifier,
      preparedAt: 2000,
      reason: "initial",
      reservationUnit: "credits",
      reservedAmount: 0,
      routeKey: "deterministic-local",
      routeSnapshotHash: snapshotHash,
      routingDecisionId: routingIdentifier,
      state: attemptState,
      stepRunId: row.step_run_id,
      ...(validatedOutput === undefined ? {} : { output: validatedOutput }),
    };
    const reservation = {
      amount: 0,
      attemptId: attemptIdentifier,
      createdAt: 2000,
      operationKey: operationIdentifier,
      releasedAmount: 0,
      reservationId: reservationIdentifier,
      runId: run.runId,
      settledAmount: 0,
      settledAt: 2000,
      state: "settled",
      stepRunId: row.step_run_id,
      unit: "credits",
      usageEntryId: usageIdentifier,
      workspaceId: run.workspaceId,
    };
    const usage = {
      amount: 0,
      attemptId: attemptIdentifier,
      operationKey: operationIdentifier,
      recordedAt: 2000,
      reservationId: reservationIdentifier,
      runId: run.runId,
      unit: "credits",
      usageEntryId: usageIdentifier,
      workspaceId: run.workspaceId,
    };
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
        0, 'settled', ${transaction.json(reservation)}, to_timestamp(2)
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
        ${snapshotHash}, ${attemptState}, ${transaction.json(attempt)},
        to_timestamp(2)
      )
    `;
    if (validatedOutput !== undefined && outputContract !== undefined) {
      const artifact = {
        artifactId: artifactIdentifier,
        attemptId: attemptIdentifier,
        classification: "internal",
        contentHash: outputContentHash,
        contract: outputContract,
        finalizedAt: 2000,
        kind: "normalized-output",
        mediaType: "application/json",
        operationKey: operationIdentifier,
        retentionPolicy: "run",
        runId: run.runId,
        sizeBytes: Buffer.byteLength(canonicalPayload, "utf8"),
        state: "finalized",
        stepRunId: row.step_run_id,
        validatedAt: 2000,
        validatorVersion: "json-schema-2020-12:test",
        workspaceId: run.workspaceId,
      } as const;
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
          ${artifact.sizeBytes}, ${artifact.state},
          ${artifact.validatorVersion}, to_timestamp(2),
          ${transaction.json(artifact)}, to_timestamp(2)
        )
      `;
    }
    await transaction`
      INSERT INTO kurobara_core.usage_ledger_entries (
        workspace_id, usage_entry_id, run_id, attempt_id, reservation_id,
        operation_key, unit, amount, entry, recorded_at
      ) VALUES (
        ${run.workspaceId}, ${usageIdentifier}, ${run.runId},
        ${attemptIdentifier}, ${reservationIdentifier}, ${operationIdentifier},
        'credits', 0, ${transaction.json(usage)}, to_timestamp(2)
      )
    `;
    await transaction`
      UPDATE kurobara_core.step_runs
      SET
        state = ${state},
        aggregate_version = aggregate_version + 1,
        event_sequence = event_sequence + 1,
        step_run = ${transaction.json({
          ...row.step_run,
          aggregateVersion: Number(row.step_run.aggregateVersion ?? 0) + 1,
          attempts: [attempt],
          eventSequence: Number(row.step_run.eventSequence ?? 0) + 1,
          state,
        })}
      WHERE workspace_id = ${run.workspaceId}
        AND run_id = ${run.runId}
        AND step_run_id = ${row.step_run_id}
    `;
  });
};

const setStepSucceededWithEvidence = (
  run: Run,
  nodeKey: string
): Promise<void> => setStepTerminalWithEvidence(run, nodeKey, "succeeded");

const setStepSucceededWithOutputEvidence = (
  run: Run,
  plan: RunPlan,
  nodeKey: string
): Promise<void> =>
  setStepTerminalWithEvidence(run, nodeKey, "succeeded", plan.outputContract);

const setStepFailedWithEvidence = (run: Run, nodeKey: string): Promise<void> =>
  setStepTerminalWithEvidence(run, nodeKey, "failed");

test("0015 and 0016 roll forward through 0022 and materialize a root atomically", async () => {
  const fixture = await createRunningRun(
    "backfill",
    [{ dependsOn: [], key: "root" }],
    workspaceId("workspace-backfill"),
    false
  );
  await sql`
    DELETE FROM kurobara_core.run_dag_schedule_jobs
    WHERE workspace_id = ${fixture.run.workspaceId}
      AND run_id = ${fixture.run.runId}
  `;
  await sql`DROP TABLE kurobara_core.recipe_application_cells`;
  await sql`DROP TABLE kurobara_core.recipe_cell_cache`;
  await sql`DROP TABLE kurobara_core.cell_results`;
  await sql`DROP TABLE kurobara_core.recipe_applications`;
  await sql`DROP TABLE kurobara_core.enrichment_recipe_inputs`;
  await sql`DROP TABLE kurobara_core.enrichment_recipes`;
  await sql`
    DROP TRIGGER recipe_run_cell_alignment_after_run
    ON kurobara_core.runs
  `;
  await sql`DROP FUNCTION kurobara_core.assert_recipe_run_cell_alignment()`;
  await sql`DROP FUNCTION kurobara_core.guard_recipe_cache_change()`;
  await sql`DROP FUNCTION kurobara_core.guard_cell_result_change()`;
  await sql`DROP FUNCTION kurobara_core.reject_immutable_recipe_record_change()`;
  await sql`
    ALTER TABLE kurobara_core.dataset_records
      DROP CONSTRAINT dataset_records_exact_content_key
  `;
  await sql`
    ALTER TABLE kurobara_core.runs
      DROP CONSTRAINT runs_exact_plan_key
  `;
  await sql`
    ALTER TABLE kurobara_core.run_plan_sources
      DROP CONSTRAINT run_plan_sources_exact_workflow_key
  `;
  await sql`
    ALTER TABLE kurobara_core.runs
      DROP CONSTRAINT runs_result_manifest_fkey,
      DROP CONSTRAINT runs_result_manifest_ref_consistent,
      DROP COLUMN result_manifest_id,
      DROP COLUMN result_manifest_hash
  `;
  await sql`DROP TABLE kurobara_core.run_result_manifests CASCADE`;
  await sql`DROP FUNCTION kurobara_core.reject_immutable_result_manifest_change()`;
  await sql`DROP TABLE kurobara_core.run_output_artifacts CASCADE`;
  await sql`DROP FUNCTION kurobara_core.reject_immutable_output_artifact_change()`;
  await sql`
    ALTER TABLE kurobara_core.step_attempts
      DROP CONSTRAINT step_attempts_output_identity_key CASCADE
  `;
  await sql`
    ALTER TABLE kurobara_core.run_dag_schedule_jobs
      DROP CONSTRAINT run_dag_schedule_jobs_last_outcome_valid,
      DROP CONSTRAINT run_dag_schedule_jobs_blocked_reason_valid,
      DROP CONSTRAINT run_dag_schedule_jobs_evaluation_consistent,
      DROP COLUMN last_outcome,
      DROP COLUMN blocked_reason,
      DROP COLUMN evaluated_at
  `;
  await sql`
    DELETE FROM kurobara_core.schema_migrations
    WHERE migration_name IN (
      '0015_run_convergence.sql',
      '0016_output_artifacts.sql',
      '0019_enrichment_recipe_storage.sql'
    )
  `;

  await runtime.migrate();
  await sql`
    ALTER TABLE kurobara_core.dataset_generation_pages
      ADD CONSTRAINT dataset_generation_pages_result_manifest_fk
        FOREIGN KEY (
          workspace_id,
          run_id,
          result_manifest_id,
          result_manifest_hash
        ) REFERENCES kurobara_core.run_result_manifests (
          workspace_id,
          run_id,
          result_manifest_id,
          manifest_hash
        ) DEFERRABLE INITIALLY DEFERRED,
      ADD CONSTRAINT dataset_generation_pages_artifact_fk
        FOREIGN KEY (
          workspace_id,
          run_id,
          artifact_id,
          artifact_content_hash
        ) REFERENCES kurobara_core.run_output_artifacts (
          workspace_id,
          run_id,
          artifact_id,
          content_hash
        ) DEFERRABLE INITIALLY DEFERRED,
      ADD CONSTRAINT dataset_generation_pages_attempt_fk
        FOREIGN KEY (
          workspace_id,
          step_run_id,
          attempt_id,
          operation_key
        ) REFERENCES kurobara_core.step_attempts (
          workspace_id,
          step_run_id,
          attempt_id,
          operation_key
        ) DEFERRABLE INITIALLY DEFERRED
  `;
  await sql`
    ALTER TABLE kurobara_core.dataset_generation_record_lineage
      ADD CONSTRAINT dataset_generation_lineage_result_manifest_fk
        FOREIGN KEY (workspace_id, result_manifest_id)
        REFERENCES kurobara_core.run_result_manifests (
          workspace_id,
          result_manifest_id
        ) DEFERRABLE INITIALLY DEFERRED,
      ADD CONSTRAINT dataset_generation_lineage_artifact_fk
        FOREIGN KEY (workspace_id, artifact_id)
        REFERENCES kurobara_core.run_output_artifacts (
          workspace_id,
          artifact_id
        ) DEFERRABLE INITIALLY DEFERRED,
      ADD CONSTRAINT dataset_generation_lineage_attempt_fk
        FOREIGN KEY (
          workspace_id,
          step_run_id,
          attempt_id,
          operation_key
        ) REFERENCES kurobara_core.step_attempts (
          workspace_id,
          step_run_id,
          attempt_id,
          operation_key
        ) DEFERRABLE INITIALLY DEFERRED
  `;
  await runtime.verifyMigrations();
  const jobs = await sql<readonly { pending: boolean }[]>`
    SELECT pending
    FROM kurobara_core.run_dag_schedule_jobs
    WHERE workspace_id = ${fixture.run.workspaceId}
      AND run_id = ${fixture.run.runId}
  `;
  assert.equal(jobs[0]?.pending, true);

  const result = await materialize();
  assert.equal(result.status, "processed");
  if (result.status === "processed") {
    assert.deepEqual(
      result.created.map((step) => step.nodeKey),
      ["root"]
    );
  }
  const rows = await sql<
    readonly {
      events: string;
      last_outcome: string;
      pending: boolean;
      processed: boolean;
      steps: string;
    }[]
  >`
    SELECT
      job.pending,
      job.last_outcome,
      job.processed_at IS NOT NULL AS processed,
      (SELECT count(*)::text FROM kurobara_core.step_runs AS step
        WHERE step.workspace_id = job.workspace_id
          AND step.run_id = job.run_id) AS steps,
      (SELECT count(*)::text FROM kurobara_core.step_events AS event
        JOIN kurobara_core.step_runs AS step
          ON step.workspace_id = event.workspace_id
          AND step.step_run_id = event.step_run_id
        WHERE step.workspace_id = job.workspace_id
          AND step.run_id = job.run_id) AS events
    FROM kurobara_core.run_dag_schedule_jobs AS job
    WHERE job.workspace_id = ${fixture.run.workspaceId}
      AND job.run_id = ${fixture.run.runId}
  `;
  assert.deepEqual(rows[0], {
    events: "1",
    last_outcome: "steps-materialized",
    pending: false,
    processed: true,
    steps: "1",
  });
});

test("materializes fan-out and waits for every fan-in dependency", async () => {
  const fixture = await createRunningRun("fan", [
    { dependsOn: [], key: "left" },
    { dependsOn: [], key: "right" },
    { dependsOn: ["left", "right"], key: "join" },
  ]);
  const roots = await materialize();
  assert.equal(roots.status, "processed");
  if (roots.status === "processed") {
    assert.deepEqual(
      roots.created.map((step) => step.nodeKey),
      ["left", "right"]
    );
  }

  await setStepState(fixture.run, "left", "succeeded");
  await requestSchedule(fixture.run);
  const firstDependency = await materialize();
  assert.equal(firstDependency.status, "processed");
  if (firstDependency.status === "processed") {
    assert.deepEqual(firstDependency.created, []);
  }

  await setStepState(fixture.run, "right", "succeeded");
  await requestSchedule(fixture.run);
  const joined = await materialize();
  assert.equal(joined.status, "processed");
  if (joined.status === "processed") {
    assert.deepEqual(
      joined.created.map((step) => step.nodeKey),
      ["join"]
    );
  }
});

test("persists result-proof-missing without terminalizing an all-success run", async () => {
  const fixture = await createRunningRun("proof-missing", [
    { dependsOn: [], key: "root" },
  ]);
  await materialize();
  await setStepSucceededWithEvidence(fixture.run, "root");
  await requestSchedule(fixture.run);

  const result = await materialize();
  assert.equal(result.status, "processed");
  if (result.status === "processed") {
    assert.deepEqual(result.outcome, {
      reason: "result-proof-missing",
      status: "blocked",
    });
    assert.equal(result.finalized, undefined);
  }
  const rows = await sql<
    readonly {
      blocked_reason: string;
      last_outcome: string;
      manifests: string;
      run_state: string;
      terminal_events: string;
    }[]
  >`
    SELECT
      job.last_outcome,
      job.blocked_reason,
      stored_run.run ->> 'state' AS run_state,
      (SELECT count(*)::text
        FROM kurobara_core.run_result_manifests AS manifest
        WHERE manifest.workspace_id = job.workspace_id
          AND manifest.run_id = job.run_id) AS manifests,
      (SELECT count(*)::text
        FROM kurobara_core.run_events AS event
        WHERE event.workspace_id = job.workspace_id
          AND event.run_id = job.run_id
          AND event.event ->> 'eventType' IN ('RunFailed', 'RunCompleted'))
        AS terminal_events
    FROM kurobara_core.run_dag_schedule_jobs AS job
    JOIN kurobara_core.runs AS stored_run
      ON stored_run.workspace_id = job.workspace_id
      AND stored_run.run_id = job.run_id
    WHERE job.workspace_id = ${fixture.run.workspaceId}
      AND job.run_id = ${fixture.run.runId}
  `;
  assert.deepEqual(rows[0], {
    blocked_reason: "result-proof-missing",
    last_outcome: "blocked",
    manifests: "0",
    run_state: "running",
    terminal_events: "0",
  });
});

test("persists an explicit blocker when multiple DAG sinks make output binding ambiguous", async () => {
  const fixture = await createRunningRun("output-ambiguous", [
    { dependsOn: [], key: "left" },
    { dependsOn: [], key: "right" },
  ]);
  await materialize();
  await setStepSucceededWithEvidence(fixture.run, "left");
  await setStepSucceededWithEvidence(fixture.run, "right");
  await requestSchedule(fixture.run);

  const result = await materialize();
  assert.equal(result.status, "processed");
  if (result.status === "processed") {
    assert.deepEqual(result.outcome, {
      reason: "output-binding-ambiguous",
      status: "blocked",
    });
    assert.equal(result.finalized, undefined);
  }
  const rows = await sql<
    readonly {
      blocked_reason: string;
      last_outcome: string;
      manifests: string;
      run_state: string;
    }[]
  >`
    SELECT
      job.last_outcome,
      job.blocked_reason,
      stored_run.run ->> 'state' AS run_state,
      (SELECT count(*)::text
        FROM kurobara_core.run_result_manifests AS manifest
        WHERE manifest.workspace_id = job.workspace_id
          AND manifest.run_id = job.run_id) AS manifests
    FROM kurobara_core.run_dag_schedule_jobs AS job
    JOIN kurobara_core.runs AS stored_run
      ON stored_run.workspace_id = job.workspace_id
      AND stored_run.run_id = job.run_id
    WHERE job.workspace_id = ${fixture.run.workspaceId}
      AND job.run_id = ${fixture.run.runId}
  `;
  assert.deepEqual(rows[0], {
    blocked_reason: "output-binding-ambiguous",
    last_outcome: "blocked",
    manifests: "0",
    run_state: "running",
  });
});

test("atomically finalizes a single-output successful run and replays its late wake", async () => {
  const fixture = await createRunningRun("output-success", [
    { dependsOn: [], key: "root" },
  ]);
  await materialize();
  await setStepSucceededWithOutputEvidence(fixture.run, fixture.plan, "root");
  await requestSchedule(fixture.run);

  const result = await materialize();
  assert.equal(result.status, "processed");
  if (result.status === "processed") {
    assert.deepEqual(result.outcome, { status: "success-finalized" });
    assert.equal(result.finalized?.run.state, "completed");
    assert.equal(result.finalized?.manifest.conclusion, "completed");
    assert.equal(result.finalized?.manifest.output.status, "accepted");
  }
  const evidence = await sql<
    readonly {
      artifacts: string;
      commands: string;
      events: string;
      last_outcome: string;
      manifests: string;
      run_state: string;
    }[]
  >`
    SELECT
      job.last_outcome,
      stored_run.run ->> 'state' AS run_state,
      (SELECT count(*)::text
        FROM kurobara_core.run_output_artifacts AS artifact
        WHERE artifact.workspace_id = job.workspace_id
          AND artifact.run_id = job.run_id) AS artifacts,
      (SELECT count(*)::text
        FROM kurobara_core.run_result_manifests AS manifest
        WHERE manifest.workspace_id = job.workspace_id
          AND manifest.run_id = job.run_id
          AND manifest.conclusion = 'completed') AS manifests,
      (SELECT count(*)::text
        FROM kurobara_core.run_events AS event
        WHERE event.workspace_id = job.workspace_id
          AND event.run_id = job.run_id
          AND event.event ->> 'eventType' IN (
            'RunResultManifestRecorded', 'RunCompleted'
          )) AS events,
      (SELECT count(*)::text
        FROM kurobara_core.run_command_journal AS command
        WHERE command.workspace_id = job.workspace_id
          AND command.run_id = job.run_id
          AND command.command_type = 'CompleteRun') AS commands
    FROM kurobara_core.run_dag_schedule_jobs AS job
    JOIN kurobara_core.runs AS stored_run
      ON stored_run.workspace_id = job.workspace_id
      AND stored_run.run_id = job.run_id
    WHERE job.workspace_id = ${fixture.run.workspaceId}
      AND job.run_id = ${fixture.run.runId}
  `;
  assert.deepEqual(evidence[0], {
    artifacts: "1",
    commands: "1",
    events: "2",
    last_outcome: "success-finalized",
    manifests: "1",
    run_state: "completed",
  });
  await assert.rejects(
    sql`
      UPDATE kurobara_core.run_output_artifacts
      SET size_bytes = size_bytes
      WHERE workspace_id = ${fixture.run.workspaceId}
        AND run_id = ${fixture.run.runId}
    `,
    OUTPUT_ARTIFACT_IMMUTABLE
  );

  await requestSchedule(fixture.run);
  const stale = await materialize();
  assert.equal(stale.status, "processed");
  if (stale.status === "processed") {
    assert.deepEqual(stale.outcome, { status: "stale-terminal" });
  }
  const replay = await sql<
    readonly {
      commands: string;
      events: string;
      last_outcome: string;
      manifests: string;
    }[]
  >`
    SELECT
      job.last_outcome,
      (SELECT count(*)::text FROM kurobara_core.run_result_manifests
        WHERE workspace_id = job.workspace_id
          AND run_id = job.run_id) AS manifests,
      (SELECT count(*)::text FROM kurobara_core.run_events
        WHERE workspace_id = job.workspace_id
          AND run_id = job.run_id
          AND event ->> 'eventType' IN (
            'RunResultManifestRecorded', 'RunCompleted'
          )) AS events,
      (SELECT count(*)::text FROM kurobara_core.run_command_journal
        WHERE workspace_id = job.workspace_id
          AND run_id = job.run_id
          AND command_type = 'CompleteRun') AS commands
    FROM kurobara_core.run_dag_schedule_jobs AS job
    WHERE job.workspace_id = ${fixture.run.workspaceId}
      AND job.run_id = ${fixture.run.runId}
  `;
  assert.deepEqual(replay[0], {
    commands: "1",
    events: "2",
    last_outcome: "stale-terminal",
    manifests: "1",
  });
});

test("fails closed on relational attempt drift", async () => {
  const fixture = await createRunningRun("attempt-drift", [
    { dependsOn: [], key: "root" },
  ]);
  await materialize();
  await setStepSucceededWithEvidence(fixture.run, "root");
  await sql`
    UPDATE kurobara_core.step_attempts
    SET state = 'failed_terminal'
    WHERE workspace_id = ${fixture.run.workspaceId}
      AND step_run_id IN (
        SELECT step_run_id
        FROM kurobara_core.step_runs
        WHERE workspace_id = ${fixture.run.workspaceId}
          AND run_id = ${fixture.run.runId}
      )
  `;
  await requestSchedule(fixture.run);
  await assert.rejects(materialize(), DAG_ATTEMPT_DRIFT);
  const jobs = await sql<readonly { pending: boolean }[]>`
    SELECT pending
    FROM kurobara_core.run_dag_schedule_jobs
    WHERE workspace_id = ${fixture.run.workspaceId}
      AND run_id = ${fixture.run.runId}
  `;
  assert.equal(jobs[0]?.pending, true);
  await sql`
    DELETE FROM kurobara_core.run_dag_schedule_jobs
    WHERE workspace_id = ${fixture.run.workspaceId}
      AND run_id = ${fixture.run.runId}
  `;
});

test("rolls back a partial fan-out and retries from the pending job", async () => {
  const fixture = await createRunningRun("rollback", [
    { dependsOn: [], key: "root" },
    { dependsOn: ["root"], key: "child-a" },
    { dependsOn: ["root"], key: "child-b" },
  ]);
  await materialize();
  await setStepState(fixture.run, "root", "succeeded");
  await requestSchedule(fixture.run);

  let calls = 0;
  const failingMaterialize = makeMaterializeNextDagRun({
    clock: { now: async () => instant(2000) },
    identifiers: {
      nextEventId: () => {
        calls += 1;
        if (calls === 2) {
          return Promise.reject(new Error("synthetic-event-id-failure"));
        }
        return Promise.resolve(eventId("dag-ready-rollback-first"));
      },
    },
    persistence: runtime.dagScheduling,
  });
  await assert.rejects(failingMaterialize(), SYNTHETIC_EVENT_ID_FAILURE);

  const rolledBack = await sql<
    readonly { children: string; pending: boolean }[]
  >`
    SELECT
      job.pending,
      (SELECT count(*)::text FROM kurobara_core.step_runs AS step
        WHERE step.workspace_id = job.workspace_id
          AND step.run_id = job.run_id
          AND step.node_key LIKE 'child-%') AS children
    FROM kurobara_core.run_dag_schedule_jobs AS job
    WHERE job.workspace_id = ${fixture.run.workspaceId}
      AND job.run_id = ${fixture.run.runId}
  `;
  assert.deepEqual(rolledBack[0], { children: "0", pending: true });

  const retried = await materialize();
  assert.equal(retried.status, "processed");
  if (retried.status === "processed") {
    assert.deepEqual(
      retried.created.map((step) => step.nodeKey),
      ["child-a", "child-b"]
    );
  }
});

test("serializes duplicate concurrent cycles without duplicate steps", async () => {
  const fixture = await createRunningRun("concurrent", [
    { dependsOn: [], key: "root" },
  ]);
  await requestSchedule(fixture.run);
  const results = await Promise.all([materialize(), materialize()]);
  assert.equal(
    results.filter((result) => result.status === "processed").length,
    1
  );
  assert.equal(results.filter((result) => result.status === "idle").length, 1);

  await requestSchedule(fixture.run);
  const replay = await materialize();
  assert.equal(replay.status, "processed");
  if (replay.status === "processed") {
    assert.deepEqual(replay.created, []);
  }
  const counts = await sql<readonly { events: string; steps: string }[]>`
    SELECT
      (SELECT count(*)::text FROM kurobara_core.step_runs
        WHERE workspace_id = ${fixture.run.workspaceId}
          AND run_id = ${fixture.run.runId}) AS steps,
      (SELECT count(*)::text FROM kurobara_core.step_events AS event
        JOIN kurobara_core.step_runs AS step
          ON step.workspace_id = event.workspace_id
          AND step.step_run_id = event.step_run_id
        WHERE step.workspace_id = ${fixture.run.workspaceId}
          AND step.run_id = ${fixture.run.runId}) AS events
  `;
  assert.deepEqual(counts[0], { events: "1", steps: "1" });
});

test("preserves a schedule request that arrives behind an active cycle", async () => {
  const fixture = await createRunningRun("wake", [
    { dependsOn: [], key: "root" },
  ]);
  let releaseCycle: (() => void) | undefined;
  let reportClaimed: (() => void) | undefined;
  const cycleGate = new Promise<void>((resolve) => {
    releaseCycle = resolve;
  });
  const claimed = new Promise<void>((resolve) => {
    reportClaimed = resolve;
  });
  const activeCycle = runtime.dagScheduling.transactionForSystem(
    async (unitOfWork) => {
      const context = await unitOfWork.jobs.claimNextForUpdate();
      assert.equal(context?.run.runId, fixture.run.runId);
      reportClaimed?.();
      await cycleGate;
      await unitOfWork.jobs.complete(
        { workspaceId: fixture.run.workspaceId },
        fixture.run.runId,
        { status: "waiting" }
      );
    }
  );
  await claimed;
  const lateRequest = requestSchedule(fixture.run);
  releaseCycle?.();
  await Promise.all([activeCycle, lateRequest]);

  const jobs = await sql<
    readonly { pending: boolean; processed_at: Date | null }[]
  >`
    SELECT pending, processed_at
    FROM kurobara_core.run_dag_schedule_jobs
    WHERE workspace_id = ${fixture.run.workspaceId}
      AND run_id = ${fixture.run.runId}
  `;
  assert.deepEqual(jobs[0], { pending: true, processed_at: null });
  await materialize();
});

test("keeps identical run and node keys isolated by workspace", async () => {
  const left = await createRunningRun(
    "shared",
    [{ dependsOn: [], key: "root" }],
    workspaceId("workspace-isolation-left")
  );
  const right = await createRunningRun(
    "shared",
    [{ dependsOn: [], key: "root" }],
    workspaceId("workspace-isolation-right")
  );
  await materialize();
  await materialize();

  const rows = await sql<readonly { steps: string; workspace_id: string }[]>`
    SELECT workspace_id, count(*)::text AS steps
    FROM kurobara_core.step_runs
    WHERE run_id = ${left.run.runId}
      AND workspace_id IN (${left.run.workspaceId}, ${right.run.workspaceId})
    GROUP BY workspace_id
    ORDER BY workspace_id
  `;
  assert.deepEqual(
    [...rows],
    [
      { steps: "1", workspace_id: "workspace-isolation-left" },
      { steps: "1", workspace_id: "workspace-isolation-right" },
    ]
  );
});

test("skips blocked descendants and atomically finalizes a failed run", async () => {
  const fixture = await createRunningRun("terminal", [
    { dependsOn: [], key: "root" },
    { dependsOn: ["root"], key: "child" },
  ]);
  await materialize();
  await setStepState(fixture.run, "root", "failed");
  await requestSchedule(fixture.run);
  const result = await materialize();
  assert.equal(result.status, "processed");
  if (result.status === "processed") {
    assert.deepEqual(result.created, []);
    assert.deepEqual(
      result.skipped.map((step) => [step.nodeKey, step.state]),
      [["child", "skipped"]]
    );
    assert.equal(result.outcome.status, "failure-finalized");
    assert.equal(result.finalized?.run.state, "failed");
  }
  const evidence = await sql<
    readonly {
      commands: string;
      events: string;
      last_outcome: string;
      manifests: string;
      result_manifest_id: string | null;
      run_state: string;
      skipped: string;
    }[]
  >`
    SELECT
      job.last_outcome,
      stored_run.run ->> 'state' AS run_state,
      stored_run.run #>> '{resultManifest,resultManifestId}'
        AS result_manifest_id,
      (SELECT count(*)::text
        FROM kurobara_core.step_runs AS step
        WHERE step.workspace_id = job.workspace_id
          AND step.run_id = job.run_id
          AND step.state = 'skipped') AS skipped,
      (SELECT count(*)::text
        FROM kurobara_core.run_result_manifests AS manifest
        WHERE manifest.workspace_id = job.workspace_id
          AND manifest.run_id = job.run_id) AS manifests,
      (SELECT count(*)::text
        FROM kurobara_core.run_events AS event
        WHERE event.workspace_id = job.workspace_id
          AND event.run_id = job.run_id
          AND event.event ->> 'eventType' IN (
            'RunResultManifestRecorded', 'RunFailed'
          )) AS events,
      (SELECT count(*)::text
        FROM kurobara_core.run_command_journal AS command
        WHERE command.workspace_id = job.workspace_id
          AND command.run_id = job.run_id
          AND command.command_type = 'FailRun') AS commands
    FROM kurobara_core.run_dag_schedule_jobs AS job
    JOIN kurobara_core.runs AS stored_run
      ON stored_run.workspace_id = job.workspace_id
      AND stored_run.run_id = job.run_id
    WHERE job.workspace_id = ${fixture.run.workspaceId}
      AND job.run_id = ${fixture.run.runId}
  `;
  assert.deepEqual(evidence[0], {
    commands: "1",
    events: "2",
    last_outcome: "failure-finalized",
    manifests: "1",
    result_manifest_id:
      result.status === "processed"
        ? result.finalized?.manifest.resultManifestId
        : null,
    run_state: "failed",
    skipped: "1",
  });
  await assert.rejects(
    sql`
      UPDATE kurobara_core.run_result_manifests
      SET cost_spent = cost_spent
      WHERE workspace_id = ${fixture.run.workspaceId}
        AND run_id = ${fixture.run.runId}
    `,
    RESULT_MANIFEST_IMMUTABLE
  );
  await requestSchedule(fixture.run);
  const stale = await materialize();
  assert.equal(stale.status, "processed");
  if (stale.status === "processed") {
    assert.equal(stale.outcome.status, "stale-terminal");
  }
  const staleReadback = await sql<
    readonly {
      commands: string;
      events: string;
      last_outcome: string;
      manifests: string;
    }[]
  >`
    SELECT
      job.last_outcome,
      (SELECT count(*)::text FROM kurobara_core.run_result_manifests AS manifest
        WHERE manifest.workspace_id = job.workspace_id
          AND manifest.run_id = job.run_id) AS manifests,
      (SELECT count(*)::text FROM kurobara_core.run_events AS event
        WHERE event.workspace_id = job.workspace_id
          AND event.run_id = job.run_id
          AND event.event ->> 'eventType' IN (
            'RunResultManifestRecorded', 'RunFailed'
          )) AS events,
      (SELECT count(*)::text FROM kurobara_core.run_command_journal AS command
        WHERE command.workspace_id = job.workspace_id
          AND command.run_id = job.run_id
          AND command.command_type = 'FailRun') AS commands
    FROM kurobara_core.run_dag_schedule_jobs AS job
    WHERE job.workspace_id = ${fixture.run.workspaceId}
      AND job.run_id = ${fixture.run.runId}
  `;
  assert.deepEqual(staleReadback[0], {
    commands: "1",
    events: "2",
    last_outcome: "stale-terminal",
    manifests: "1",
  });
});

test("converges a settled failure after both execution deadlines", async () => {
  const fixture = await createRunningRun("failure-after-deadline", [
    { dependsOn: [], key: "root" },
    { dependsOn: ["root"], key: "child" },
  ]);
  await materialize();
  await setStepFailedWithEvidence(fixture.run, "root");
  await requestSchedule(fixture.run);
  const convergeAfterDeadline = makeMaterializeNextDagRun({
    clock: { now: async () => instant(100_000) },
    identifiers: {
      nextEventId: async () => eventId(`failure-after-deadline-${++nextEvent}`),
    },
    persistence: runtime.dagScheduling,
  });

  const result = await convergeAfterDeadline();

  assert.equal(result.status, "processed");
  if (result.status === "processed") {
    assert.deepEqual(result.created, []);
    assert.deepEqual(
      result.skipped.map((step) => step.nodeKey),
      ["child"]
    );
    assert.equal(result.outcome.status, "failure-finalized");
    assert.equal(result.finalized?.run.state, "failed");
  }
  const rows = await sql<
    readonly { last_outcome: string; manifests: string; run_state: string }[]
  >`
    SELECT
      job.last_outcome,
      stored_run.run ->> 'state' AS run_state,
      (SELECT count(*)::text
        FROM kurobara_core.run_result_manifests AS manifest
        WHERE manifest.workspace_id = job.workspace_id
          AND manifest.run_id = job.run_id) AS manifests
    FROM kurobara_core.run_dag_schedule_jobs AS job
    JOIN kurobara_core.runs AS stored_run
      ON stored_run.workspace_id = job.workspace_id
      AND stored_run.run_id = job.run_id
    WHERE job.workspace_id = ${fixture.run.workspaceId}
      AND job.run_id = ${fixture.run.runId}
  `;
  assert.deepEqual(rows[0], {
    last_outcome: "failure-finalized",
    manifests: "1",
    run_state: "failed",
  });
});

test("serializes concurrent failed-run convergence into one bundle", async () => {
  const fixture = await createRunningRun("failure-concurrent", [
    { dependsOn: [], key: "root" },
    { dependsOn: ["root"], key: "child" },
  ]);
  await materialize();
  await setStepState(fixture.run, "root", "failed");
  await requestSchedule(fixture.run);

  const results = await Promise.all([materialize(), materialize()]);
  assert.equal(
    results.filter((result) => result.status === "processed").length,
    1
  );
  assert.equal(results.filter((result) => result.status === "idle").length, 1);
  const processed = results.find((result) => result.status === "processed");
  assert.equal(processed?.outcome.status, "failure-finalized");
  const counts = await sql<
    readonly { commands: string; events: string; manifests: string }[]
  >`
    SELECT
      (SELECT count(*)::text FROM kurobara_core.run_result_manifests
        WHERE workspace_id = ${fixture.run.workspaceId}
          AND run_id = ${fixture.run.runId}) AS manifests,
      (SELECT count(*)::text FROM kurobara_core.run_events
        WHERE workspace_id = ${fixture.run.workspaceId}
          AND run_id = ${fixture.run.runId}
          AND event ->> 'eventType' IN (
            'RunResultManifestRecorded', 'RunFailed'
          )) AS events,
      (SELECT count(*)::text FROM kurobara_core.run_command_journal
        WHERE workspace_id = ${fixture.run.workspaceId}
          AND run_id = ${fixture.run.runId}
          AND command_type = 'FailRun') AS commands
  `;
  assert.deepEqual(counts[0], {
    commands: "1",
    events: "2",
    manifests: "1",
  });
});

test("rolls back the complete failure bundle before commit", async () => {
  const fixture = await createRunningRun("failure-rollback", [
    { dependsOn: [], key: "root" },
    { dependsOn: ["root"], key: "child" },
  ]);
  await materialize();
  await setStepState(fixture.run, "root", "failed");
  await requestSchedule(fixture.run);
  let calls = 0;
  const failingMaterialize = makeMaterializeNextDagRun({
    clock: { now: async () => instant(2000) },
    identifiers: {
      nextEventId: () => {
        calls += 1;
        return calls === 3
          ? Promise.reject(new Error("synthetic-event-id-failure"))
          : Promise.resolve(eventId(`failure-rollback-${calls}`));
      },
    },
    persistence: runtime.dagScheduling,
  });
  await assert.rejects(failingMaterialize(), SYNTHETIC_EVENT_ID_FAILURE);

  const rows = await sql<
    readonly {
      commands: string;
      events: string;
      manifests: string;
      pending: boolean;
      run_state: string;
      skipped: string;
    }[]
  >`
    SELECT
      job.pending,
      stored_run.run ->> 'state' AS run_state,
      (SELECT count(*)::text FROM kurobara_core.step_runs AS step
        WHERE step.workspace_id = job.workspace_id
          AND step.run_id = job.run_id
          AND step.state = 'skipped') AS skipped,
      (SELECT count(*)::text FROM kurobara_core.run_result_manifests AS manifest
        WHERE manifest.workspace_id = job.workspace_id
          AND manifest.run_id = job.run_id) AS manifests,
      (SELECT count(*)::text FROM kurobara_core.run_events AS event
        WHERE event.workspace_id = job.workspace_id
          AND event.run_id = job.run_id
          AND event.event ->> 'eventType' IN (
            'RunResultManifestRecorded', 'RunFailed'
          )) AS events,
      (SELECT count(*)::text FROM kurobara_core.run_command_journal AS command
        WHERE command.workspace_id = job.workspace_id
          AND command.run_id = job.run_id
          AND command.command_type = 'FailRun') AS commands
    FROM kurobara_core.run_dag_schedule_jobs AS job
    JOIN kurobara_core.runs AS stored_run
      ON stored_run.workspace_id = job.workspace_id
      AND stored_run.run_id = job.run_id
    WHERE job.workspace_id = ${fixture.run.workspaceId}
      AND job.run_id = ${fixture.run.runId}
  `;
  assert.deepEqual(rows[0], {
    commands: "0",
    events: "0",
    manifests: "0",
    pending: true,
    run_state: "running",
    skipped: "0",
  });
  const retried = await materialize();
  assert.equal(retried.status, "processed");
  if (retried.status === "processed") {
    assert.equal(retried.outcome.status, "failure-finalized");
  }
});

test("fails closed on relational and aggregate step drift", async () => {
  const fixture = await createRunningRun("drift", [
    { dependsOn: [], key: "root" },
  ]);
  await materialize();
  await sql`
    UPDATE kurobara_core.step_runs
    SET state = 'succeeded'
    WHERE workspace_id = ${fixture.run.workspaceId}
      AND run_id = ${fixture.run.runId}
      AND node_key = 'root'
  `;
  await requestSchedule(fixture.run);

  await assert.rejects(materialize(), DAG_STEP_DRIFT);
  const jobs = await sql<readonly { pending: boolean }[]>`
    SELECT pending
    FROM kurobara_core.run_dag_schedule_jobs
    WHERE workspace_id = ${fixture.run.workspaceId}
      AND run_id = ${fixture.run.runId}
  `;
  assert.equal(jobs[0]?.pending, true);
});
