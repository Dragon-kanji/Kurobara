import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { after, before, test } from "node:test";

import {
  createPostgresRuntime,
  type PostgresRuntime,
} from "@kurobara/adapter-postgres";
import { makeRouteAndClaimNextReadyStep } from "@kurobara/application";
import {
  actorId,
  capabilityId,
  contentHash,
  correlationId,
  eventId,
  idempotencyKey,
  instant,
  type Run,
  type RunPlan,
  type RunPlanRouteSnapshot,
  runId,
  runPlanId,
  type StepLifecycleEvent,
  type StepRun,
  stepRunId,
  workflowSpecId,
  workspaceId,
} from "@kurobara/kernel";
import postgres from "postgres";

const adminUrl = process.env.KUROBARA_TEST_POSTGRES_URL;
if (adminUrl === undefined || adminUrl.trim().length === 0) {
  throw new Error(
    "KUROBARA_TEST_POSTGRES_URL must target a disposable-capable PostgreSQL admin database."
  );
}

const FORCED_ROUTING_COMPLETION_FAILURE = /forced routing completion failure/u;
const THROUGH_0013_MIGRATION = /^(?:000[1-9]|001[0-3])_[a-z0-9_]+\.sql$/u;

const databaseName = `kurobara_step_routing_${process.pid}_${Date.now()}`;
const databaseUrl = new URL(adminUrl);
databaseUrl.pathname = `/${databaseName}`;
const admin = postgres(adminUrl, { max: 1 });
const sql = postgres(databaseUrl.toString(), { max: 6 });
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

const fixtureFor = (
  marker: string,
  effectAdapterKeys: readonly string[],
  includeRouteSnapshots = true
): Readonly<{
  plan: RunPlan;
  readyEvent: Extract<StepLifecycleEvent, { eventType: "StepReady" }>;
  run: Run;
  step: StepRun;
}> => {
  const workspace = workspaceId(`workspace-routing-${marker}`);
  const policyFactsHash = hash(`policy-${marker}`);
  const routeSnapshots: readonly RunPlanRouteSnapshot[] = effectAdapterKeys.map(
    (effectAdapterKey, index) => ({
      capability,
      effectAdapterKey,
      factsHash: policyFactsHash,
      nodeKey: "summarize",
      pricingVersion: "1.0.0",
      reservableUpperBound: 0.25 + index / 100,
      reservationUnit: "credits",
      routeKey: `route-${marker}-${index}`,
    })
  );
  const requestedRunPlanId = runPlanId(`plan-routing-${marker}`);
  const plan: RunPlan = {
    authority: {
      authorityEnvelopeId: `authority-routing-${marker}`,
      budgetLimit: { limit: 10, reserved: 0, spent: 0, unit: "credits" },
      capabilities: [capability],
      deadline: instant(100_000),
      permissions: ["steps:execute"],
      subjectActorId: actorId("agent-routing-integration"),
      version: "1.0.0",
      workspaceId: workspace,
    },
    budget: { limit: 10, reserved: 0, spent: 0, unit: "credits" },
    catalogFingerprint: hash(`catalog-${marker}`),
    catalogVersion: "1.0.0",
    compiledWorkflow: {
      compilerVersion: "1.0.0",
      fingerprint: `workflow-fingerprint-${marker}`,
      nodes: [
        {
          capability,
          dependsOn: [],
          depth: 0,
          key: "summarize",
        },
      ],
      workflowContentHash: hash(`workflow-${marker}`),
      workflowRevision: "1.0.0",
      workflowSpecId: workflowSpecId(`workflow-routing-${marker}`),
    },
    deadline: instant(90_000),
    inputContract: {
      catalogFingerprint: hash(`catalog-${marker}`),
      catalogVersion: "1.0.0",
      schemaFingerprint: hash(`input-${marker}`),
      schemaId: "https://schemas.kurobara.invalid/routing/input/1.0.0",
      schemaVersion: "1.0.0",
    },
    normalizedInputHash: hash(`normalized-input-${marker}`),
    outputContract: {
      catalogFingerprint: hash(`catalog-${marker}`),
      catalogVersion: "1.0.0",
      schemaFingerprint: hash(`output-${marker}`),
      schemaId: "https://schemas.kurobara.invalid/routing/output/1.0.0",
      schemaVersion: "1.0.0",
    },
    planHash: hash(`plan-${marker}`),
    policyFactsHash,
    policyVersion: "1.0.0",
    quote: {
      expiresAt: instant(80_000),
      guarantee: "hard",
      pricingVersion: "1.0.0",
      quoteId: `quote-routing-${marker}`,
      unit: "credits",
      upperBound: 10,
    },
    retryPolicy: { maxAttemptsPerStep: 3 },
    ...(includeRouteSnapshots ? { routeSnapshots } : {}),
    runPlanId: requestedRunPlanId,
    workspaceId: workspace,
  };
  const run: Run = {
    aggregateVersion: 2,
    createdAt: instant(1000),
    eventSequence: 2,
    idempotencyKey: idempotencyKey(`create-routing-${marker}`),
    intentionHash: hash(`intention-${marker}`),
    resultCompleteness: "none",
    runId: runId(`run-routing-${marker}`),
    runPlanId: requestedRunPlanId,
    state: "running",
    workspaceId: workspace,
  };
  const step: StepRun = {
    aggregateVersion: 1,
    attempts: [],
    createdAt: instant(1500),
    dependsOn: [],
    eventSequence: 1,
    nodeKey: "summarize",
    runId: run.runId,
    state: "ready",
    stepRunId: stepRunId(`step-routing-${marker}`),
    workspaceId: workspace,
  };
  const readyEvent: Extract<StepLifecycleEvent, { eventType: "StepReady" }> = {
    actorId: actorId("system:dag-scheduler"),
    correlationId: correlationId(`dag:${run.runId}`),
    eventId: eventId(`event-ready-routing-${marker}`),
    eventType: "StepReady",
    eventVersion: 1,
    nodeKey: step.nodeKey,
    occurredAt: step.createdAt,
    runId: run.runId,
    sequence: 1,
    stepRunId: step.stepRunId,
    workspaceId: workspace,
  };
  return { plan, readyEvent, run, step };
};

const seedReady = async (
  target: ReturnType<typeof postgres>,
  fixture: ReturnType<typeof fixtureFor>,
  enqueueRouting = true
): Promise<void> => {
  await target`
    INSERT INTO kurobara_core.workspaces (workspace_id)
    VALUES (${fixture.run.workspaceId})
  `;
  await target`
    INSERT INTO kurobara_core.run_plans (workspace_id, run_plan_id, plan)
    VALUES (
      ${fixture.plan.workspaceId},
      ${fixture.plan.runPlanId},
      ${target.json(fixture.plan)}
    )
  `;
  await target`
    INSERT INTO kurobara_core.runs (
      workspace_id,
      run_id,
      run_plan_id,
      idempotency_key,
      intention_hash,
      cost,
      run
    ) VALUES (
      ${fixture.run.workspaceId},
      ${fixture.run.runId},
      ${fixture.run.runPlanId},
      ${fixture.run.idempotencyKey},
      ${fixture.run.intentionHash},
      ${target.json({ reserved: 0, spent: 0, unit: "credits" })},
      ${target.json(fixture.run)}
    )
  `;
  await target`
    INSERT INTO kurobara_core.step_runs (
      workspace_id,
      step_run_id,
      run_id,
      node_key,
      state,
      aggregate_version,
      event_sequence,
      step_run,
      created_at
    ) VALUES (
      ${fixture.step.workspaceId},
      ${fixture.step.stepRunId},
      ${fixture.step.runId},
      ${fixture.step.nodeKey},
      ${fixture.step.state},
      ${fixture.step.aggregateVersion},
      ${fixture.step.eventSequence},
      ${target.json(fixture.step)},
      ${new Date(fixture.step.createdAt)}
    )
  `;
  await target`
    INSERT INTO kurobara_core.step_events (
      workspace_id,
      step_run_id,
      sequence,
      event_id,
      event,
      occurred_at
    ) VALUES (
      ${fixture.readyEvent.workspaceId},
      ${fixture.readyEvent.stepRunId},
      ${fixture.readyEvent.sequence},
      ${fixture.readyEvent.eventId},
      ${target.json(fixture.readyEvent)},
      ${new Date(fixture.readyEvent.occurredAt)}
    )
  `;
  if (enqueueRouting) {
    await target`
      INSERT INTO kurobara_core.step_routing_jobs (
        workspace_id,
        run_id,
        step_run_id
      ) VALUES (
        ${fixture.step.workspaceId},
        ${fixture.step.runId},
        ${fixture.step.stepRunId}
      )
    `;
  }
};

const router = (
  targetRuntime: PostgresRuntime,
  adapterKeys: readonly string[]
) =>
  makeRouteAndClaimNextReadyStep({
    availableEffectAdapterKeys: adapterKeys,
    clock: { now: async () => instant(2000) },
    persistence: targetRuntime.stepRouting,
    requiredPermission: "steps:execute",
    retryDelayMilliseconds: 1000,
  });

test("rolls back the complete routing bundle and admits it only once under concurrency", async () => {
  const fixture = fixtureFor("atomic-concurrent", ["deterministic-local"]);
  await seedReady(sql, fixture);
  await sql.unsafe(`
    CREATE FUNCTION kurobara_core.fail_atomic_routing_completion()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    BEGIN
      IF NEW.step_run_id = 'step-routing-atomic-concurrent'
        AND OLD.pending
        AND NOT NEW.pending THEN
        RAISE EXCEPTION 'forced routing completion failure';
      END IF;
      RETURN NEW;
    END;
    $$;

    CREATE TRIGGER fail_atomic_routing_completion
      BEFORE UPDATE ON kurobara_core.step_routing_jobs
      FOR EACH ROW EXECUTE FUNCTION
        kurobara_core.fail_atomic_routing_completion();
  `);

  await assert.rejects(
    router(runtime, ["deterministic-local"])(),
    FORCED_ROUTING_COMPLETION_FAILURE
  );
  const rolledBack = await sql<
    readonly {
      attempts: number;
      decisions: number;
      outbox: number;
      reservations: number;
      state: string;
    }[]
  >`
    SELECT
      step.state,
      (
        SELECT count(*)::integer
        FROM kurobara_core.step_attempts AS attempt
        WHERE attempt.workspace_id = step.workspace_id
          AND attempt.step_run_id = step.step_run_id
      ) AS attempts,
      (
        SELECT count(*)::integer
        FROM kurobara_core.routing_decisions AS decision
        WHERE decision.workspace_id = step.workspace_id
          AND decision.step_run_id = step.step_run_id
      ) AS decisions,
      (
        SELECT count(*)::integer
        FROM kurobara_core.cost_reservations AS reservation
        WHERE reservation.workspace_id = step.workspace_id
          AND reservation.step_run_id = step.step_run_id
      ) AS reservations,
      (
        SELECT count(*)::integer
        FROM kurobara_core.outbox_messages AS message
        WHERE message.workspace_id = step.workspace_id
          AND message.aggregate_id = step.run_id
          AND message.destination = 'orchestration.step.attempt.claimed'
      ) AS outbox
    FROM kurobara_core.step_runs AS step
    WHERE step.workspace_id = ${fixture.step.workspaceId}
      AND step.step_run_id = ${fixture.step.stepRunId}
  `;
  assert.deepEqual(rolledBack[0], {
    attempts: 0,
    decisions: 0,
    outbox: 0,
    reservations: 0,
    state: "ready",
  });

  await sql.unsafe(`
    DROP TRIGGER fail_atomic_routing_completion
      ON kurobara_core.step_routing_jobs;
    DROP FUNCTION kurobara_core.fail_atomic_routing_completion();
  `);
  const concurrent = await Promise.all([
    router(runtime, ["deterministic-local"])(),
    router(runtime, ["deterministic-local"])(),
  ]);
  assert.deepEqual(concurrent.map((result) => result.status).sort(), [
    "claimed",
    "idle",
  ]);

  const durable = await sql<
    readonly {
      attempts: number;
      binding_effect_adapter_key: string;
      decisions: number;
      outbox: number;
      reservations: number;
    }[]
  >`
    SELECT
      count(DISTINCT attempt.attempt_id)::integer AS attempts,
      count(DISTINCT decision.routing_decision_id)::integer AS decisions,
      count(DISTINCT reservation.reservation_id)::integer AS reservations,
      count(DISTINCT message.message_id)::integer AS outbox,
      min(binding.effect_adapter_key) AS binding_effect_adapter_key
    FROM kurobara_core.step_attempts AS attempt
    JOIN kurobara_core.routing_decisions AS decision
      ON decision.workspace_id = attempt.workspace_id
      AND decision.routing_decision_id = attempt.routing_decision_id
      AND decision.effect_adapter_key = attempt.effect_adapter_key
    JOIN kurobara_core.cost_reservations AS reservation
      ON reservation.workspace_id = attempt.workspace_id
      AND reservation.attempt_id = attempt.attempt_id
    JOIN kurobara_core.step_leaf_execution_bindings AS binding
      ON binding.workspace_id = attempt.workspace_id
      AND binding.attempt_id = attempt.attempt_id
      AND binding.effect_adapter_key = attempt.effect_adapter_key
    JOIN kurobara_core.outbox_messages AS message
      ON message.workspace_id = binding.workspace_id
      AND message.message_id = binding.outbox_message_id
    WHERE attempt.workspace_id = ${fixture.step.workspaceId}
      AND attempt.step_run_id = ${fixture.step.stepRunId}
  `;
  assert.deepEqual(durable[0], {
    attempts: 1,
    binding_effect_adapter_key: "deterministic-local",
    decisions: 1,
    outbox: 1,
    reservations: 1,
  });
});

test("backs off an unavailable adapter without starving an explicit no-route rejection", async () => {
  const unavailable = fixtureFor("unavailable", ["temporarily-missing"]);
  const noRoute = fixtureFor("no-route", []);
  await seedReady(sql, unavailable);
  await seedReady(sql, noRoute);
  await sql`
    UPDATE kurobara_core.step_routing_jobs
    SET requested_at = CASE
      WHEN step_run_id = ${unavailable.step.stepRunId}
        THEN clock_timestamp() - interval '2 minutes'
      ELSE clock_timestamp() - interval '1 minute'
    END
    WHERE workspace_id IN (
      ${unavailable.step.workspaceId},
      ${noRoute.step.workspaceId}
    )
  `;

  const result = await router(runtime, ["deterministic-local"])();
  assert.equal(result.status, "rejected");
  const jobs = await sql<
    readonly {
      attempts: number;
      last_error: string | null;
      pending: boolean;
      state: string;
      step_run_id: string;
    }[]
  >`
    SELECT
      job.step_run_id,
      job.pending,
      job.attempts::integer,
      job.last_error,
      step.state
    FROM kurobara_core.step_routing_jobs AS job
    JOIN kurobara_core.step_runs AS step
      ON step.workspace_id = job.workspace_id
      AND step.step_run_id = job.step_run_id
    WHERE job.workspace_id IN (
      ${unavailable.step.workspaceId},
      ${noRoute.step.workspaceId}
    )
    ORDER BY job.step_run_id
  `;
  assert.deepEqual(
    [...jobs],
    [
      {
        attempts: 0,
        last_error: null,
        pending: false,
        state: "failed",
        step_run_id: noRoute.step.stepRunId,
      },
      {
        attempts: 1,
        last_error: "effect-adapter-unavailable",
        pending: true,
        state: "ready",
        step_run_id: unavailable.step.stepRunId,
      },
    ]
  );
  const effects = await sql<readonly { count: number }[]>`
    SELECT count(*)::integer AS count
    FROM kurobara_core.step_attempts
    WHERE workspace_id IN (
      ${unavailable.step.workspaceId},
      ${noRoute.step.workspaceId}
    )
  `;
  assert.equal(effects[0]?.count, 0);
});

test("rolls a running legacy plan forward into explicit routing and DAG jobs", async () => {
  const legacyDatabaseName = `kurobara_routing_roll_${process.pid}_${Date.now()}`;
  const legacyDatabaseUrl = new URL(adminUrl);
  legacyDatabaseUrl.pathname = `/${legacyDatabaseName}`;
  let legacySql: ReturnType<typeof postgres> | undefined;
  let legacyRuntime: PostgresRuntime | undefined;
  try {
    await admin`CREATE DATABASE ${admin(legacyDatabaseName)}`;
    legacySql = postgres(legacyDatabaseUrl.toString(), { max: 2 });
    await legacySql`CREATE SCHEMA IF NOT EXISTS kurobara_core`;
    await legacySql`
      CREATE TABLE kurobara_core.schema_migrations (
        migration_name text PRIMARY KEY,
        checksum text NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT clock_timestamp()
      )
    `;
    const migrationsUrl = new URL(
      "../../packages/adapters/postgres/migrations/",
      import.meta.url
    );
    const migrationNames = (await readdir(migrationsUrl))
      .filter((name) => THROUGH_0013_MIGRATION.test(name))
      .sort();
    for (const migrationName of migrationNames) {
      const content = await readFile(
        new URL(migrationName, migrationsUrl),
        "utf8"
      );
      const checksum = createHash("sha256").update(content).digest("hex");
      await legacySql.unsafe(content);
      await legacySql`
        INSERT INTO kurobara_core.schema_migrations (
          migration_name,
          checksum
        ) VALUES (${migrationName}, ${checksum})
      `;
    }
    const legacy = fixtureFor("legacy", [], false);
    await seedReady(legacySql, legacy, false);

    legacyRuntime = createPostgresRuntime(legacyDatabaseUrl.toString());
    await legacyRuntime.migrate();
    await legacyRuntime.verifyMigrations();
    const jobs = await legacySql<
      readonly { dag_pending: boolean; routing_pending: boolean }[]
    >`
      SELECT
        dag.pending AS dag_pending,
        routing.pending AS routing_pending
      FROM kurobara_core.step_routing_jobs AS routing
      JOIN kurobara_core.run_dag_schedule_jobs AS dag
        ON dag.workspace_id = routing.workspace_id
        AND dag.run_id = routing.run_id
      WHERE routing.workspace_id = ${legacy.run.workspaceId}
        AND routing.step_run_id = ${legacy.step.stepRunId}
    `;
    assert.deepEqual(jobs[0], {
      dag_pending: true,
      routing_pending: true,
    });

    const result = await router(legacyRuntime, ["deterministic-local"])();
    assert.equal(result.status, "rejected");
    const readback = await legacySql<
      readonly { attempts: number; decisions: number; state: string }[]
    >`
      SELECT
        step.state,
        (
          SELECT count(*)::integer
          FROM kurobara_core.step_attempts AS attempt
          WHERE attempt.workspace_id = step.workspace_id
            AND attempt.step_run_id = step.step_run_id
        ) AS attempts,
        (
          SELECT count(*)::integer
          FROM kurobara_core.routing_decisions AS decision
          WHERE decision.workspace_id = step.workspace_id
            AND decision.step_run_id = step.step_run_id
        ) AS decisions
      FROM kurobara_core.step_runs AS step
      WHERE step.workspace_id = ${legacy.step.workspaceId}
        AND step.step_run_id = ${legacy.step.stepRunId}
    `;
    assert.deepEqual(readback[0], {
      attempts: 0,
      decisions: 0,
      state: "failed",
    });
  } finally {
    if (legacyRuntime !== undefined) {
      await legacyRuntime.close();
    }
    if (legacySql !== undefined) {
      await legacySql.end({ timeout: 5 });
    }
    await admin`DROP DATABASE IF EXISTS ${admin(legacyDatabaseName)} WITH (FORCE)`;
  }
});
