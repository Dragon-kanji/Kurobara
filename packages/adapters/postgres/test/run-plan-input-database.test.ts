import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";

import { createPostgresRuntime } from "@kurobara/adapter-postgres";
import postgres from "postgres";

const adminUrl = process.env.KUROBARA_TEST_POSTGRES_URL;
const migrationsUrl = new URL("../migrations/", import.meta.url);
const PRE_INPUT_MIGRATION_PATTERN = /^00(?:0[1-9]|1[0-6])_[a-z0-9_]+\.sql$/u;

const digest = (value: string): string =>
  `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;

const isPostgresCode = (error: unknown, code: string): boolean =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  error.code === code;

test("rolls legacy plans forward and fences immutable tenant-scoped run inputs", {
  skip: adminUrl === undefined,
}, async () => {
  if (adminUrl === undefined) {
    return;
  }
  const databaseName = `kurobara_run_input_${process.pid}_${Date.now()}`;
  const databaseUrl = new URL(adminUrl);
  databaseUrl.pathname = `/${databaseName}`;
  const admin = postgres(adminUrl, { max: 1 });
  let runtime: ReturnType<typeof createPostgresRuntime> | undefined;
  let sql: ReturnType<typeof postgres> | undefined;

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
      .filter((name) => PRE_INPUT_MIGRATION_PATTERN.test(name))
      .sort();
    assert.equal(migrationNames.at(-1), "0016_output_artifacts.sql");
    for (const migrationName of migrationNames) {
      const migration = await readFile(
        new URL(migrationName, migrationsUrl),
        "utf8"
      );
      await sql.unsafe(migration);
      await sql`
          INSERT INTO kurobara_core.schema_migrations (
            migration_name,
            checksum
          ) VALUES (
            ${migrationName},
            ${createHash("sha256").update(migration).digest("hex")}
          )
        `;
    }

    const payload = { prompt: "synthetic" };
    const canonicalPayload = '{"prompt":"synthetic"}';
    const contentHash = digest(canonicalPayload);
    const oversizedPayload = "x".repeat(65_535);
    const oversizedHash = digest(JSON.stringify(oversizedPayload));
    const edgePayload = Object.fromEntries(
      Array.from({ length: 2300 }, (_, index) => [
        `k${String(index).padStart(4, "0")}`,
        "x".repeat(16),
      ])
    );
    const edgeCanonicalPayload = JSON.stringify(edgePayload);
    const edgeSizeBytes = Buffer.byteLength(edgeCanonicalPayload, "utf8");
    const edgeHash = digest(edgeCanonicalPayload);
    const numericExpansionPayload = Array.from({ length: 4095 }, () => 1e308);
    const numericExpansionCanonicalPayload = JSON.stringify(
      numericExpansionPayload
    );
    const numericExpansionSizeBytes = Buffer.byteLength(
      numericExpansionCanonicalPayload,
      "utf8"
    );
    const numericExpansionHash = digest(numericExpansionCanonicalPayload);
    assert.ok(edgeSizeBytes <= 65_536);
    assert.ok(numericExpansionSizeBytes <= 65_536);
    await sql`
        INSERT INTO kurobara_core.workspaces (workspace_id)
        VALUES ('workspace-input-a'), ('workspace-input-b')
      `;
    await sql`
        INSERT INTO kurobara_core.run_plans (
          workspace_id,
          run_plan_id,
          plan
        ) VALUES
          ('workspace-input-a', 'plan-legacy', ${sql.json({})}),
          (
            'workspace-input-a',
            'plan-input',
            ${sql.json({ normalizedInputHash: contentHash })}
          ),
          (
            'workspace-input-b',
            'plan-input',
            ${sql.json({ normalizedInputHash: contentHash })}
          ),
          (
            'workspace-input-a',
            'plan-contract-invalid',
            ${sql.json({ normalizedInputHash: contentHash })}
          ),
          (
            'workspace-input-a',
            'plan-input-oversized',
            ${sql.json({ normalizedInputHash: oversizedHash })}
          ),
          (
            'workspace-input-a',
            'plan-input-edge',
            ${sql.json({ normalizedInputHash: edgeHash })}
          ),
          (
            'workspace-input-a',
            'plan-input-numeric-expansion',
            ${sql.json({ normalizedInputHash: numericExpansionHash })}
          )
      `;

    runtime = createPostgresRuntime(databaseUrl.toString());
    await runtime.migrate();
    await runtime.verifyMigrations();

    const rolledForward = await sql<
      readonly {
        input_count: string;
        legacy_hash: string | null;
        plan_hash: string | null;
      }[]
    >`
        SELECT
          (
            SELECT count(*)::text
            FROM kurobara_core.run_plan_inputs
          ) AS input_count,
          (
            SELECT normalized_input_hash
            FROM kurobara_core.run_plans
            WHERE workspace_id = 'workspace-input-a'
              AND run_plan_id = 'plan-legacy'
          ) AS legacy_hash,
          (
            SELECT normalized_input_hash
            FROM kurobara_core.run_plans
            WHERE workspace_id = 'workspace-input-a'
              AND run_plan_id = 'plan-input'
          ) AS plan_hash
      `;
    assert.deepEqual(rolledForward[0], {
      input_count: "0",
      legacy_hash: null,
      plan_hash: contentHash,
    });

    const contract = {
      catalogFingerprint: digest("catalog"),
      catalogVersion: "1.0.0",
      schemaFingerprint: digest("schema"),
      schemaId: "https://schemas.kurobara.invalid/input/1.0.0",
      schemaVersion: "1.0.0",
    };
    const insertInput = async (
      workspaceId: string,
      inputId: string
    ): Promise<void> => {
      if (sql === undefined) {
        throw new Error("PostgreSQL test client is unavailable.");
      }
      await sql`
          INSERT INTO kurobara_core.run_plan_inputs (
            workspace_id,
            run_plan_id,
            input_id,
            content_hash,
            contract,
            normalized_payload,
            classification,
            media_type,
            size_bytes,
            validator_version,
            validated_at,
            finalized_at
          ) VALUES (
            ${workspaceId},
            'plan-input',
            ${inputId},
            ${contentHash},
            ${sql.json(contract)},
            ${sql.json(payload)},
            'internal',
            'application/json',
            ${Buffer.byteLength(canonicalPayload, "utf8")},
            'json-schema-2020-12:test',
            to_timestamp(1),
            to_timestamp(2)
          )
        `;
    };
    await insertInput("workspace-input-a", "input-shared");
    await insertInput("workspace-input-b", "input-shared");
    const isolated = await sql<
      readonly { input_id: string; workspace_id: string }[]
    >`
        SELECT workspace_id, input_id
        FROM kurobara_core.run_plan_inputs
        WHERE input_id = 'input-shared'
        ORDER BY workspace_id
      `;
    assert.deepEqual(
      [...isolated],
      [
        { input_id: "input-shared", workspace_id: "workspace-input-a" },
        { input_id: "input-shared", workspace_id: "workspace-input-b" },
      ]
    );

    await assert.rejects(
      sql`
          UPDATE kurobara_core.run_plan_inputs
          SET validator_version = 'tampered'
          WHERE workspace_id = 'workspace-input-a'
            AND input_id = 'input-shared'
        `,
      (error) => isPostgresCode(error, "55000")
    );
    await assert.rejects(
      sql`
          DELETE FROM kurobara_core.run_plan_inputs
          WHERE workspace_id = 'workspace-input-a'
            AND input_id = 'input-shared'
        `,
      (error) => isPostgresCode(error, "55000")
    );
    await assert.rejects(
      sql`
          INSERT INTO kurobara_core.run_plan_inputs (
            workspace_id,
            run_plan_id,
            input_id,
            content_hash,
            contract,
            normalized_payload,
            classification,
            media_type,
            size_bytes,
            validator_version,
            validated_at,
            finalized_at
          ) VALUES (
            'workspace-input-a',
            'plan-legacy',
            'input-tampered',
            ${digest("mismatch")},
            ${sql.json(contract)},
            ${sql.json(payload)},
            'internal',
            'application/json',
            22,
            'json-schema-2020-12:test',
            to_timestamp(1),
            to_timestamp(2)
          )
        `,
      (error) => isPostgresCode(error, "23503")
    );
    await assert.rejects(
      sql`
          INSERT INTO kurobara_core.run_plan_inputs (
            workspace_id,
            run_plan_id,
            input_id,
            content_hash,
            contract,
            normalized_payload,
            classification,
            media_type,
            size_bytes,
            validator_version,
            validated_at,
            finalized_at
          ) VALUES (
            'workspace-input-a',
            'plan-contract-invalid',
            'input-contract-invalid',
            ${contentHash},
            ${sql.json({ ...contract, unexpected: true })},
            ${sql.json(payload)},
            'internal',
            'application/json',
            ${Buffer.byteLength(canonicalPayload, "utf8")},
            'json-schema-2020-12:test',
            to_timestamp(1),
            to_timestamp(2)
          )
        `,
      (error) => isPostgresCode(error, "23514")
    );
    await sql`
        INSERT INTO kurobara_core.run_plan_inputs (
          workspace_id,
          run_plan_id,
          input_id,
          content_hash,
          contract,
          normalized_payload,
          classification,
          media_type,
          size_bytes,
          validator_version,
          validated_at,
          finalized_at
        ) VALUES (
          'workspace-input-a',
          'plan-input-edge',
          'input-edge',
          ${edgeHash},
          ${sql.json(contract)},
          ${sql.json(edgePayload)},
          'internal',
          'application/json',
          ${edgeSizeBytes},
          'json-schema-2020-12:test',
          to_timestamp(1),
          to_timestamp(2)
        )
      `;
    const edgeRows = await sql<
      readonly { canonical_size: string; stored_text_size: number }[]
    >`
        SELECT
          size_bytes::text AS canonical_size,
          octet_length(normalized_payload::text) AS stored_text_size
        FROM kurobara_core.run_plan_inputs
        WHERE workspace_id = 'workspace-input-a'
          AND input_id = 'input-edge'
      `;
    assert.equal(edgeRows[0]?.canonical_size, String(edgeSizeBytes));
    assert.ok((edgeRows[0]?.stored_text_size ?? 0) > 65_536);
    await sql`
        INSERT INTO kurobara_core.run_plan_inputs (
          workspace_id,
          run_plan_id,
          input_id,
          content_hash,
          contract,
          normalized_payload,
          classification,
          media_type,
          size_bytes,
          validator_version,
          validated_at,
          finalized_at
        ) VALUES (
          'workspace-input-a',
          'plan-input-numeric-expansion',
          'input-numeric-expansion',
          ${numericExpansionHash},
          ${sql.json(contract)},
          ${sql.json(numericExpansionPayload)},
          'internal',
          'application/json',
          ${numericExpansionSizeBytes},
          'json-schema-2020-12:test',
          to_timestamp(1),
          to_timestamp(2)
        )
      `;
    const numericExpansionRows = await sql<
      readonly { canonical_size: string; stored_text_size: number }[]
    >`
        SELECT
          size_bytes::text AS canonical_size,
          octet_length(normalized_payload::text) AS stored_text_size
        FROM kurobara_core.run_plan_inputs
        WHERE workspace_id = 'workspace-input-a'
          AND input_id = 'input-numeric-expansion'
      `;
    assert.equal(
      numericExpansionRows[0]?.canonical_size,
      String(numericExpansionSizeBytes)
    );
    assert.ok((numericExpansionRows[0]?.stored_text_size ?? 0) > 131_072);
    await assert.rejects(
      sql`
          INSERT INTO kurobara_core.run_plan_inputs (
            workspace_id,
            run_plan_id,
            input_id,
            content_hash,
            contract,
            normalized_payload,
            classification,
            media_type,
            size_bytes,
            validator_version,
            validated_at,
            finalized_at
          ) VALUES (
            'workspace-input-a',
            'plan-input-oversized',
            'input-oversized',
            ${oversizedHash},
            ${sql.json(contract)},
            ${sql.json(oversizedPayload)},
            'internal',
            'application/json',
            65537,
            'json-schema-2020-12:test',
            to_timestamp(1),
            to_timestamp(2)
          )
        `,
      (error) => isPostgresCode(error, "23514")
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
