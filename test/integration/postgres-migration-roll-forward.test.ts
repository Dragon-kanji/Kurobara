import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";

import { createPostgresRuntime } from "@kurobara/adapter-postgres";
import postgres from "postgres";

const adminUrl = process.env.KUROBARA_TEST_POSTGRES_URL;
if (adminUrl === undefined || adminUrl.trim().length === 0) {
  throw new Error(
    "KUROBARA_TEST_POSTGRES_URL must target a disposable-capable PostgreSQL admin database."
  );
}

const migrationsUrl = new URL(
  "../../packages/adapters/postgres/migrations/",
  import.meta.url
);
const LEGACY_MIGRATION_PATTERN = /^000[1-9]_[a-z0-9_]+\.sql$/u;
const PRE_OUTPUT_MIGRATION_PATTERN = /^00(?:0[1-9]|1[0-5])_[a-z0-9_]+\.sql$/u;
const PRE_DATA_MIGRATION_PATTERN = /^00(?:0[1-9]|1[0-7])_[a-z0-9_]+\.sql$/u;
const RESULT_MANIFEST_IMMUTABLE = /result manifests are immutable/u;
const CHECK_CONSTRAINT_VIOLATION = /violates check constraint/u;
const DATASET_IMPORT_DELETE_REJECTED = /dataset imports cannot be deleted/u;

test("migrates a populated 0009 reservation into the exact 0010 model", async () => {
  const databaseName = `kurobara_roll_forward_${process.pid}_${Date.now()}`;
  const databaseUrl = new URL(adminUrl);
  databaseUrl.pathname = `/${databaseName}`;
  const admin = postgres(adminUrl, { max: 1 });
  let sql: ReturnType<typeof postgres> | undefined;
  let runtime: ReturnType<typeof createPostgresRuntime> | undefined;

  try {
    await admin`CREATE DATABASE ${admin(databaseName)}`;
    sql = postgres(databaseUrl.toString(), { max: 1 });
    await sql`CREATE SCHEMA IF NOT EXISTS kurobara_core`;
    await sql`
      CREATE TABLE kurobara_core.schema_migrations (
        migration_name text PRIMARY KEY,
        checksum text NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT clock_timestamp()
      )
    `;

    const migrationNames = (await readdir(migrationsUrl))
      .filter((name) => LEGACY_MIGRATION_PATTERN.test(name))
      .sort();
    for (const migrationName of migrationNames) {
      const content = await readFile(
        new URL(migrationName, migrationsUrl),
        "utf8"
      );
      const checksum = createHash("sha256").update(content).digest("hex");
      await sql.unsafe(content);
      await sql`
        INSERT INTO kurobara_core.schema_migrations (
          migration_name,
          checksum
        ) VALUES (${migrationName}, ${checksum})
      `;
    }

    await sql`
      INSERT INTO kurobara_core.workspaces (workspace_id)
      VALUES ('workspace-upgrade')
    `;
    await sql`
      INSERT INTO kurobara_core.policy_snapshots (
        workspace_id,
        snapshot_id,
        snapshot
      ) VALUES (
        'workspace-upgrade',
        'policy-upgrade',
        ${sql.json({
          policy: {
            factsHash: `sha256:${"b".repeat(64)}`,
            version: "legacy",
          },
          snapshotId: "policy-upgrade",
          workspaceId: "workspace-upgrade",
        })}
      )
    `;
    await sql`
      INSERT INTO kurobara_core.run_plans (
        workspace_id,
        run_plan_id,
        plan
      ) VALUES ('workspace-upgrade', 'plan-upgrade', ${sql.json({})})
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
        'workspace-upgrade',
        'run-upgrade',
        'plan-upgrade',
        'create-upgrade',
        ${`sha256:${"a".repeat(64)}`},
        ${sql.json({ reserved: 0.11, spent: 0, unit: "credits" })},
        ${sql.json({})}
      )
    `;
    await sql`
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
        'workspace-upgrade',
        'step-upgrade',
        'run-upgrade',
        'summarize',
        'active',
        2,
        3,
        ${sql.json({})},
        clock_timestamp()
      )
    `;
    await sql`
      INSERT INTO kurobara_core.cost_reservations (
        workspace_id,
        reservation_id,
        run_id,
        operation_key,
        unit,
        amount,
        state,
        reservation,
        created_at
      ) VALUES (
        'workspace-upgrade',
        'reservation-upgrade',
        'run-upgrade',
        'operation-upgrade',
        'credits',
        0.11,
        'reserved',
        ${sql.json({
          amount: 0.11,
          createdAt: 1000,
          operationKey: "operation-upgrade",
          reservationId: "reservation-upgrade",
          runId: "run-upgrade",
          state: "reserved",
          unit: "credits",
          workspaceId: "workspace-upgrade",
        })},
        clock_timestamp()
      )
    `;
    await sql`
      INSERT INTO kurobara_core.step_attempts (
        workspace_id,
        attempt_id,
        step_run_id,
        attempt_number,
        operation_key,
        reservation_id,
        state,
        attempt,
        created_at
      ) VALUES (
        'workspace-upgrade',
        'attempt-upgrade',
        'step-upgrade',
        1,
        'operation-upgrade',
        'reservation-upgrade',
        'claimed',
        ${sql.json({})},
        clock_timestamp()
      )
    `;

    runtime = createPostgresRuntime(databaseUrl.toString());
    await runtime.migrate();
    await runtime.verifyMigrations();
    assert.equal(typeof runtime.exportDeliveries.prepare, "function");

    const rows = await sql<
      readonly {
        attempt_id: string;
        bound_step_run_id: string;
        json_attempt_id: string;
        json_step_run_id: string;
        step_run_id: string;
      }[]
    >`
      SELECT
        reservation.attempt_id,
        reservation.step_run_id,
        reservation.reservation ->> 'attemptId' AS json_attempt_id,
        reservation.reservation ->> 'stepRunId' AS json_step_run_id,
        binding.step_run_id AS bound_step_run_id
      FROM kurobara_core.cost_reservations AS reservation
      JOIN kurobara_core.step_operation_bindings AS binding
        ON binding.workspace_id = reservation.workspace_id
        AND binding.run_id = reservation.run_id
        AND binding.operation_key = reservation.operation_key
      WHERE reservation.workspace_id = 'workspace-upgrade'
        AND reservation.reservation_id = 'reservation-upgrade'
    `;
    assert.deepEqual(rows[0], {
      attempt_id: "attempt-upgrade",
      bound_step_run_id: "step-upgrade",
      json_attempt_id: "attempt-upgrade",
      json_step_run_id: "step-upgrade",
      step_run_id: "step-upgrade",
    });
    const immutableLegacyIdentities = await sql<
      readonly { plan_changed: boolean; policy_changed: boolean }[]
    >`
      SELECT
        plan.plan ? 'retryPolicy' AS plan_changed,
        policy.snapshot -> 'policy' ? 'maxAttemptsPerStep' AS policy_changed
      FROM kurobara_core.run_plans AS plan
      JOIN kurobara_core.policy_snapshots AS policy
        ON policy.workspace_id = plan.workspace_id
        AND policy.snapshot_id = 'policy-upgrade'
      WHERE plan.workspace_id = 'workspace-upgrade'
        AND plan.run_plan_id = 'plan-upgrade'
    `;
    assert.deepEqual(immutableLegacyIdentities[0], {
      plan_changed: false,
      policy_changed: false,
    });
  } finally {
    if (runtime !== undefined) {
      await runtime.close();
    }
    if (sql !== undefined) {
      await sql.end({ timeout: 5 });
    }
    await admin`DROP DATABASE IF EXISTS ${admin(databaseName)} WITH (FORCE)`;
    await admin.end({ timeout: 5 });
  }
});

test("rolls 0015 failure manifests through 0022 without inventing input, recipe, generation, or page state", async () => {
  const databaseName = `kurobara_output_roll_forward_${process.pid}_${Date.now()}`;
  const databaseUrl = new URL(adminUrl);
  databaseUrl.pathname = `/${databaseName}`;
  const admin = postgres(adminUrl, { max: 1 });
  let sql: ReturnType<typeof postgres> | undefined;
  let runtime: ReturnType<typeof createPostgresRuntime> | undefined;

  try {
    await admin`CREATE DATABASE ${admin(databaseName)}`;
    sql = postgres(databaseUrl.toString(), { max: 1 });
    await sql`CREATE SCHEMA IF NOT EXISTS kurobara_core`;
    await sql`
      CREATE TABLE kurobara_core.schema_migrations (
        migration_name text PRIMARY KEY,
        checksum text NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT clock_timestamp()
      )
    `;

    const migrationNames = (await readdir(migrationsUrl))
      .filter((name) => PRE_OUTPUT_MIGRATION_PATTERN.test(name))
      .sort();
    assert.equal(migrationNames.at(-1), "0015_run_convergence.sql");
    for (const migrationName of migrationNames) {
      const content = await readFile(
        new URL(migrationName, migrationsUrl),
        "utf8"
      );
      const checksum = createHash("sha256").update(content).digest("hex");
      await sql.unsafe(content);
      await sql`
        INSERT INTO kurobara_core.schema_migrations (
          migration_name,
          checksum
        ) VALUES (${migrationName}, ${checksum})
      `;
    }

    const digest = `sha256:${"a".repeat(64)}`;
    const manifestHash = `sha256:${"b".repeat(64)}`;
    const contract = {
      catalogFingerprint: digest,
      catalogVersion: "1.0.0",
      schemaFingerprint: digest,
      schemaId: "https://schemas.kurobara.invalid/output/1.0.0",
      schemaVersion: "1.0.0",
    };
    const manifest = {
      attemptSettlements: [],
      compiledWorkflowFingerprint: "workflow-output-upgrade",
      conclusion: "failed",
      cost: { reserved: 0, spent: 0, unit: "credits" },
      coverage: "complete",
      createdAt: 2000,
      entries: [
        {
          nodeKey: "root",
          result: { reason: "step-failed", status: "missing" },
          state: "failed",
          stepAggregateVersion: 2,
          stepEventSequence: 2,
          stepRunId: "step-output-upgrade",
        },
      ],
      manifestHash,
      manifestVersion: 1,
      output: { reason: "run-failed", status: "missing" },
      outputContract: contract,
      planHash: digest,
      resultCompleteness: "none",
      resultManifestId: "manifest-output-upgrade",
      runId: "run-output-upgrade",
      runPlanId: "plan-output-upgrade",
      sourceRunAggregateVersion: 2,
      workspaceId: "workspace-output-upgrade",
    } as const;
    const run = {
      aggregateVersion: 3,
      createdAt: 1000,
      eventSequence: 4,
      idempotencyKey: "create-output-upgrade",
      intentionHash: digest,
      resultCompleteness: "none",
      resultManifest: {
        manifestHash,
        resultManifestId: "manifest-output-upgrade",
      },
      runId: "run-output-upgrade",
      runPlanId: "plan-output-upgrade",
      state: "failed",
      workspaceId: "workspace-output-upgrade",
    } as const;

    await sql.begin(async (transaction) => {
      await transaction`
        INSERT INTO kurobara_core.workspaces (workspace_id)
        VALUES ('workspace-output-upgrade')
      `;
      await transaction`
        INSERT INTO kurobara_core.run_plans (
          workspace_id,
          run_plan_id,
          plan
        ) VALUES (
          'workspace-output-upgrade',
          'plan-output-upgrade',
          ${transaction.json({})}
        )
      `;
      await transaction`
        INSERT INTO kurobara_core.runs (
          workspace_id,
          run_id,
          run_plan_id,
          idempotency_key,
          intention_hash,
          cost,
          run
        ) VALUES (
          'workspace-output-upgrade',
          'run-output-upgrade',
          'plan-output-upgrade',
          'create-output-upgrade',
          ${digest},
          ${transaction.json({ reserved: 0, spent: 0, unit: "credits" })},
          ${transaction.json(run)}
        )
      `;
      await transaction`
        INSERT INTO kurobara_core.run_result_manifests (
          workspace_id,
          run_id,
          run_plan_id,
          result_manifest_id,
          manifest_hash,
          plan_hash,
          conclusion,
          result_completeness,
          source_run_aggregate_version,
          cost_unit,
          cost_spent,
          manifest,
          created_at
        ) VALUES (
          'workspace-output-upgrade',
          'run-output-upgrade',
          'plan-output-upgrade',
          'manifest-output-upgrade',
          ${manifestHash},
          ${digest},
          'failed',
          'none',
          2,
          'credits',
          0,
          ${transaction.json(manifest)},
          to_timestamp(2)
        )
      `;
    });

    runtime = createPostgresRuntime(databaseUrl.toString());
    await runtime.migrate();
    await runtime.verifyMigrations();

    const rows = await sql<
      readonly {
        conclusion: string;
        manifest: unknown;
        output_artifact_id: string | null;
        output_content_hash: string | null;
        result_completeness: string;
      }[]
    >`
      SELECT
        conclusion,
        result_completeness,
        output_artifact_id,
        output_content_hash,
        manifest
      FROM kurobara_core.run_result_manifests
      WHERE workspace_id = 'workspace-output-upgrade'
        AND run_id = 'run-output-upgrade'
    `;
    assert.deepEqual(rows[0], {
      conclusion: "failed",
      manifest,
      output_artifact_id: null,
      output_content_hash: null,
      result_completeness: "none",
    });
    const migrations = await sql<readonly { migration_name: string }[]>`
      SELECT migration_name
      FROM kurobara_core.schema_migrations
      ORDER BY migration_name
    `;
    assert.equal(
      migrations.at(-1)?.migration_name,
      "0030_contact_export_delivery_lifecycle.sql"
    );
    assert.equal(migrations.length, 30);
    const inputState = await sql<
      readonly { input_count: string; normalized_input_hash: string | null }[]
    >`
      SELECT
        (
          SELECT count(*)::text
          FROM kurobara_core.run_plan_inputs
        ) AS input_count,
        normalized_input_hash
      FROM kurobara_core.run_plans
      WHERE workspace_id = 'workspace-output-upgrade'
        AND run_plan_id = 'plan-output-upgrade'
    `;
    assert.deepEqual(inputState[0], {
      input_count: "0",
      normalized_input_hash: null,
    });
    await assert.rejects(
      sql`
        UPDATE kurobara_core.run_result_manifests
        SET cost_spent = cost_spent
        WHERE workspace_id = 'workspace-output-upgrade'
          AND run_id = 'run-output-upgrade'
      `,
      RESULT_MANIFEST_IMMUTABLE
    );
  } finally {
    if (runtime !== undefined) {
      await runtime.close();
    }
    if (sql !== undefined) {
      await sql.end({ timeout: 5 });
    }
    await admin`DROP DATABASE IF EXISTS ${admin(databaseName)} WITH (FORCE)`;
    await admin.end({ timeout: 5 });
  }
});

test("rolls the exact 0017 schema into bounded dataset and recipe storage", async () => {
  const databaseName = `kurobara_dataset_roll_forward_${process.pid}_${Date.now()}`;
  const databaseUrl = new URL(adminUrl);
  databaseUrl.pathname = `/${databaseName}`;
  const admin = postgres(adminUrl, { max: 1 });
  let sql: ReturnType<typeof postgres> | undefined;
  let runtime: ReturnType<typeof createPostgresRuntime> | undefined;

  try {
    await admin`CREATE DATABASE ${admin(databaseName)}`;
    sql = postgres(databaseUrl.toString(), { max: 1 });
    await sql`CREATE SCHEMA IF NOT EXISTS kurobara_core`;
    await sql`
      CREATE TABLE kurobara_core.schema_migrations (
        migration_name text PRIMARY KEY,
        checksum text NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT clock_timestamp()
      )
    `;

    const migrationNames = (await readdir(migrationsUrl))
      .filter((name) => PRE_DATA_MIGRATION_PATTERN.test(name))
      .sort();
    assert.equal(migrationNames.at(-1), "0017_run_plan_inputs.sql");
    assert.equal(migrationNames.length, 17);
    for (const migrationName of migrationNames) {
      const content = await readFile(
        new URL(migrationName, migrationsUrl),
        "utf8"
      );
      const checksum = createHash("sha256").update(content).digest("hex");
      await sql.unsafe(content);
      await sql`
        INSERT INTO kurobara_core.schema_migrations (
          migration_name,
          checksum
        ) VALUES (${migrationName}, ${checksum})
      `;
    }
    await sql`
      INSERT INTO kurobara_core.workspaces (workspace_id)
      VALUES ('workspace-data-upgrade')
    `;

    runtime = createPostgresRuntime(databaseUrl.toString());
    await runtime.migrate();
    await runtime.verifyMigrations();

    const migrationState = await sql<
      readonly { migration_count: string; migration_name: string }[]
    >`
      SELECT
        count(*) OVER ()::text AS migration_count,
        migration_name
      FROM kurobara_core.schema_migrations
      ORDER BY migration_name DESC
      LIMIT 1
    `;
    assert.deepEqual(migrationState[0], {
      migration_count: "30",
      migration_name: "0030_contact_export_delivery_lifecycle.sql",
    });
    const preservedState = await sql<
      readonly {
        dataset_count: string;
        import_count: string;
        workspace_count: string;
      }[]
    >`
      SELECT
        (SELECT count(*)::text FROM kurobara_core.datasets) AS dataset_count,
        (
          SELECT count(*)::text
          FROM kurobara_core.dataset_imports
        ) AS import_count,
        (
          SELECT count(*)::text
          FROM kurobara_core.workspaces
          WHERE workspace_id = 'workspace-data-upgrade'
        ) AS workspace_count
    `;
    assert.deepEqual(preservedState[0], {
      dataset_count: "0",
      import_count: "0",
      workspace_count: "1",
    });

    const schemaHash = `sha256:${"a".repeat(64)}`;
    const intentHash = `sha256:${"b".repeat(64)}`;
    await assert.rejects(
      sql.begin(async (transaction) => {
        await transaction`
          INSERT INTO kurobara_core.datasets (
            workspace_id,
            dataset_id,
            name,
            schema_hash,
            dataset
          ) VALUES (
            'workspace-data-upgrade',
            'dataset-upgrade',
            'Upgrade dataset',
            ${schemaHash},
            ${transaction.json({
              datasetId: "dataset-upgrade",
              name: "Upgrade dataset",
              workspaceId: "workspace-data-upgrade",
            })}
          )
        `;
        await transaction`
          INSERT INTO kurobara_core.dataset_imports (
            workspace_id,
            import_id,
            dataset_id,
            schema_hash,
            intent_hash,
            source_content_hash,
            format,
            codec_version,
            max_record_bytes,
            max_batch_items,
            max_batch_bytes
          ) VALUES (
            'workspace-data-upgrade',
            'import-too-small',
            'dataset-upgrade',
            ${schemaHash},
            ${intentHash},
            ${schemaHash},
            'jsonl',
            '1.0.0',
            512,
            1,
            513
          )
        `;
      }),
      CHECK_CONSTRAINT_VIOLATION
    );
    const createdAt = new Date(1_800_000_000_000);
    await sql.begin(async (transaction) => {
      await transaction`
        INSERT INTO kurobara_core.datasets (
          workspace_id,
          dataset_id,
          name,
          schema_hash,
          dataset,
          created_at
        ) VALUES (
          'workspace-data-upgrade',
          'dataset-upgrade',
          'Upgrade dataset',
          ${schemaHash},
          ${transaction.json({
            datasetId: "dataset-upgrade",
            name: "Upgrade dataset",
            workspaceId: "workspace-data-upgrade",
          })},
          ${createdAt}
        )
      `;
      await transaction`
        INSERT INTO kurobara_core.dataset_imports (
          workspace_id,
          import_id,
          dataset_id,
          schema_hash,
          intent_hash,
          source_content_hash,
          format,
          codec_version,
          max_record_bytes,
          max_batch_items,
          max_batch_bytes,
          created_at
        ) VALUES (
          'workspace-data-upgrade',
          'import-upgrade',
          'dataset-upgrade',
          ${schemaHash},
          ${intentHash},
          ${schemaHash},
          'jsonl',
          '1.0.0',
          512,
          1,
          1024,
          ${createdAt}
        )
      `;
      await transaction`
        INSERT INTO kurobara_core.dataset_materializations (
          workspace_id,
          materialization_id,
          dataset_id,
          schema_hash,
          origin_kind,
          origin_id,
          state,
          revision,
          record_count,
          rejected_count,
          payload,
          created_at
        ) VALUES (
          'workspace-data-upgrade',
          'dataset-upgrade',
          'dataset-upgrade',
          ${schemaHash},
          'import',
          'import-upgrade',
          'building',
          1,
          0,
          0,
          ${transaction.json({
            createdAt: createdAt.getTime(),
            datasetId: "dataset-upgrade",
            materializationId: "dataset-upgrade",
            origin: { importId: "import-upgrade", kind: "import" },
            recordCount: 0,
            rejectedCount: 0,
            revision: 1,
            schemaHash,
            state: "building",
            workspaceId: "workspace-data-upgrade",
          })},
          ${createdAt}
        )
      `;
    });
    await assert.rejects(
      sql`
        DELETE FROM kurobara_core.dataset_imports
        WHERE workspace_id = 'workspace-data-upgrade'
          AND import_id = 'import-upgrade'
      `,
      DATASET_IMPORT_DELETE_REJECTED
    );
  } finally {
    if (runtime !== undefined) {
      await runtime.close();
    }
    if (sql !== undefined) {
      await sql.end({ timeout: 5 });
    }
    await admin`DROP DATABASE IF EXISTS ${admin(databaseName)} WITH (FORCE)`;
    await admin.end({ timeout: 5 });
  }
});
