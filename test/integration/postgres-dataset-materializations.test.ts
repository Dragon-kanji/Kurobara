import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";

import { createPostgresRuntime } from "@kurobara/adapter-postgres";
import { datasetId, workspaceId } from "@kurobara/kernel";
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
const THROUGH_GENERATION_PLAN_MIGRATION =
  /^(?:000[1-9]|001[0-9]|0020)_[a-z0-9_]+\.sql$/u;
const CHECK_CONSTRAINT_VIOLATION = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  error.code === "23514";
const hash = (character: string) =>
  `sha256:${character.repeat(64).slice(0, 64)}`;
const emptyContentHash = `sha256:${createHash("sha256").digest("hex")}`;

const materializationContentHash = (
  pairs: readonly Readonly<{ contentHash: string; recordId: string }>[]
): string => {
  const encoded = pairs
    .map(
      ({ contentHash, recordId }) =>
        `${Buffer.byteLength(recordId, "utf8")}:${recordId}${Buffer.byteLength(
          contentHash,
          "utf8"
        )}:${contentHash}`
    )
    .join("");
  return `sha256:${createHash("sha256").update(encoded, "utf8").digest("hex")}`;
};

const applyThrough0020 = async (
  sql: ReturnType<typeof postgres>
): Promise<void> => {
  await sql`CREATE SCHEMA IF NOT EXISTS kurobara_core`;
  await sql`
    CREATE TABLE kurobara_core.schema_migrations (
      migration_name text PRIMARY KEY,
      checksum text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT clock_timestamp()
    )
  `;
  const migrationNames = (await readdir(migrationsUrl))
    .filter((name) => THROUGH_GENERATION_PLAN_MIGRATION.test(name))
    .sort();
  if (
    migrationNames.at(-1) !== "0020_dataset_generation_plans.sql" ||
    migrationNames.length !== 20
  ) {
    throw new Error("The exact 0020 migration prefix is unavailable.");
  }
  for (const migrationName of migrationNames) {
    const content = await readFile(
      new URL(migrationName, migrationsUrl),
      "utf8"
    );
    const checksum = createHash("sha256").update(content).digest("hex");
    await sql.unsafe(content);
    await sql`
      INSERT INTO kurobara_core.schema_migrations (migration_name, checksum)
      VALUES (${migrationName}, ${checksum})
    `;
  }
};

const insertDatasetAndImport = async (
  sql: ReturnType<typeof postgres>,
  input: Readonly<{
    datasetId: string;
    importId: string;
    state: "completed" | "failed" | "running";
  }>
): Promise<void> => {
  const schemaHash = hash("a");
  const createdAt = new Date(1_700_000_000_000);
  await sql`
    INSERT INTO kurobara_core.datasets (
      workspace_id,
      dataset_id,
      name,
      schema_hash,
      dataset,
      created_at
    ) VALUES (
      'workspace-materialization',
      ${input.datasetId},
      ${`Dataset ${input.datasetId}`},
      ${schemaHash},
      ${sql.json({
        datasetId: input.datasetId,
        name: `Dataset ${input.datasetId}`,
        workspaceId: "workspace-materialization",
      })},
      ${createdAt}
    )
  `;
  await sql`
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
      state,
      completed_at,
      created_at
    ) VALUES (
      'workspace-materialization',
      ${input.importId},
      ${input.datasetId},
      ${schemaHash},
      ${hash("e")},
      ${hash("f")},
      'jsonl',
      '1.0.0',
      1024,
      10,
      16384,
      ${input.state},
      ${input.state === "running" ? null : new Date(createdAt.getTime() + 1000)},
      ${createdAt}
    )
  `;
};

test("rejects a 0020 dataset that has no import origin to materialize", async () => {
  const databaseName = `kurobara_materialization_orphan_${process.pid}_${Date.now()}`;
  const databaseUrl = new URL(adminUrl);
  databaseUrl.pathname = `/${databaseName}`;
  const admin = postgres(adminUrl, { max: 1 });
  let sql: ReturnType<typeof postgres> | undefined;
  let runtime: ReturnType<typeof createPostgresRuntime> | undefined;
  try {
    await admin`CREATE DATABASE ${admin(databaseName)}`;
    sql = postgres(databaseUrl.toString(), { max: 1 });
    await applyThrough0020(sql);
    await sql`
      INSERT INTO kurobara_core.workspaces (workspace_id)
      VALUES ('workspace-materialization')
    `;
    await sql`
      INSERT INTO kurobara_core.datasets (
        workspace_id,
        dataset_id,
        name,
        schema_hash,
        dataset
      ) VALUES (
        'workspace-materialization',
        'dataset-orphan',
        'Orphan dataset',
        ${hash("a")},
        ${sql.json({
          datasetId: "dataset-orphan",
          name: "Orphan dataset",
          workspaceId: "workspace-materialization",
        })}
      )
    `;
    runtime = createPostgresRuntime(databaseUrl.toString());
    await assert.rejects(runtime.migrate(), CHECK_CONSTRAINT_VIOLATION);
    const applied = await sql<readonly { applied: boolean }[]>`
      SELECT EXISTS (
        SELECT 1
        FROM kurobara_core.schema_migrations
        WHERE migration_name = '0021_dataset_generation_materializations.sql'
      ) AS applied
    `;
    assert.equal(applied[0]?.applied, false);
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

test("backfills exact import materializations and deterministic record order", async () => {
  const databaseName = `kurobara_materialization_backfill_${process.pid}_${Date.now()}`;
  const databaseUrl = new URL(adminUrl);
  databaseUrl.pathname = `/${databaseName}`;
  const admin = postgres(adminUrl, { max: 1 });
  let sql: ReturnType<typeof postgres> | undefined;
  let runtime: ReturnType<typeof createPostgresRuntime> | undefined;
  try {
    await admin`CREATE DATABASE ${admin(databaseName)}`;
    sql = postgres(databaseUrl.toString(), { max: 1 });
    await applyThrough0020(sql);
    await sql`
      INSERT INTO kurobara_core.workspaces (workspace_id)
      VALUES ('workspace-materialization')
    `;
    await insertDatasetAndImport(sql, {
      datasetId: "dataset-running-r",
      importId: "import-running",
      state: "running",
    });
    await insertDatasetAndImport(sql, {
      datasetId: "dataset-completed-c",
      importId: "import-completed",
      state: "running",
    });
    await insertDatasetAndImport(sql, {
      datasetId: "dataset-empty-z",
      importId: "import-empty",
      state: "completed",
    });
    await insertDatasetAndImport(sql, {
      datasetId: "dataset-failed-f",
      importId: "import-failed",
      state: "failed",
    });
    await insertDatasetAndImport(sql, {
      datasetId: "dataset-padded-p ",
      importId: "import-padded ",
      state: "completed",
    });

    const firstRecordHash = hash("1");
    const secondRecordHash = hash("2");
    await sql`
      INSERT INTO kurobara_core.dataset_import_batches (
        workspace_id,
        import_id,
        sequence,
        content_hash,
        item_count
      ) VALUES (
        'workspace-materialization',
        'import-completed',
        1,
        ${hash("3")},
        3
      )
    `;
    const firstRecord = {
      datasetId: "dataset-completed-c",
      recordId: "é-record-1",
      values: [],
      workspaceId: "workspace-materialization",
    };
    const secondRecord = {
      datasetId: "dataset-completed-c",
      recordId: "record-2",
      values: [],
      workspaceId: "workspace-materialization",
    };
    await sql`
      INSERT INTO kurobara_core.dataset_records (
        workspace_id,
        dataset_id,
        record_id,
        import_id,
        batch_sequence,
        item_number,
        record_number,
        content_hash,
        record
      ) VALUES
      (
        'workspace-materialization',
        'dataset-completed-c',
        'é-record-1',
        'import-completed',
        1,
        1,
        1,
        ${firstRecordHash},
        ${sql.json(firstRecord)}
      ),
      (
        'workspace-materialization',
        'dataset-completed-c',
        'record-2',
        'import-completed',
        1,
        3,
        2,
        ${secondRecordHash},
        ${sql.json(secondRecord)}
      )
    `;
    await sql`
      INSERT INTO kurobara_core.dataset_import_issues (
        workspace_id,
        import_id,
        dataset_id,
        batch_sequence,
        item_number,
        source_content_hash,
        issue_code,
        message,
        recoverable,
        issue_scope
      ) VALUES (
        'workspace-materialization',
        'import-completed',
        'dataset-completed-c',
        1,
        2,
        ${hash("4")},
        'invalid-json',
        'Synthetic rejected record.',
        true,
        'record'
      )
    `;
    await sql`
      UPDATE kurobara_core.dataset_imports
      SET
        state = 'completed',
        batch_count = 1,
        item_count = 3,
        record_count = 2,
        error_count = 1,
        completed_at = to_timestamp(1700000001)
      WHERE workspace_id = 'workspace-materialization'
        AND import_id = 'import-completed'
    `;
    const beforeRecords = await sql<
      readonly {
        record_bytes: string;
        record_id: string;
        record_text: string;
      }[]
    >`
      SELECT
        record_id,
        record::text AS record_text,
        encode(convert_to(record::text, 'UTF8'), 'hex') AS record_bytes
      FROM kurobara_core.dataset_records
      ORDER BY item_number
    `;

    runtime = createPostgresRuntime(databaseUrl.toString());
    await runtime.migrate();
    await runtime.verifyMigrations();

    const materializations = await sql<
      readonly {
        content_hash: string | null;
        coverage_basis: string | null;
        coverage_status: string | null;
        dataset_id: string;
        materialization_id: string;
        origin_kind: string;
        record_count: string;
        rejected_count: string;
        state: string;
      }[]
    >`
      SELECT
        dataset_id,
        materialization_id,
        origin_kind,
        state,
        record_count::text AS record_count,
        rejected_count::text AS rejected_count,
        content_hash,
        coverage_basis,
        coverage_status
      FROM kurobara_core.dataset_materializations
      ORDER BY dataset_id
    `;
    const expectedNonEmptyHash = materializationContentHash([
      { contentHash: firstRecordHash, recordId: "é-record-1" },
      { contentHash: secondRecordHash, recordId: "record-2" },
    ]);
    assert.deepEqual(
      [...materializations],
      [
        {
          content_hash: expectedNonEmptyHash,
          coverage_basis: "imported_source",
          coverage_status: "complete_for_declared_source",
          dataset_id: "dataset-completed-c",
          materialization_id: "dataset-completed-c",
          origin_kind: "import",
          record_count: "2",
          rejected_count: "1",
          state: "ready",
        },
        {
          content_hash: emptyContentHash,
          coverage_basis: "imported_source",
          coverage_status: "complete_for_declared_source",
          dataset_id: "dataset-empty-z",
          materialization_id: "dataset-empty-z",
          origin_kind: "import",
          record_count: "0",
          rejected_count: "0",
          state: "ready",
        },
        {
          content_hash: null,
          coverage_basis: null,
          coverage_status: null,
          dataset_id: "dataset-failed-f",
          materialization_id: "dataset-failed-f",
          origin_kind: "import",
          record_count: "0",
          rejected_count: "0",
          state: "failed",
        },
        {
          content_hash: emptyContentHash,
          coverage_basis: "imported_source",
          coverage_status: "complete_for_declared_source",
          dataset_id: "dataset-padded-p ",
          materialization_id: "dataset-padded-p ",
          origin_kind: "import",
          record_count: "0",
          rejected_count: "0",
          state: "ready",
        },
        {
          content_hash: null,
          coverage_basis: null,
          coverage_status: null,
          dataset_id: "dataset-running-r",
          materialization_id: "dataset-running-r",
          origin_kind: "import",
          record_count: "0",
          rejected_count: "0",
          state: "building",
        },
      ]
    );
    const afterRecords = await sql<
      readonly {
        materialization_id: string;
        record_bytes: string;
        record_id: string;
        record_ordinal: string;
        record_text: string;
      }[]
    >`
      SELECT
        record_id,
        materialization_id,
        record_ordinal::text AS record_ordinal,
        record::text AS record_text,
        encode(convert_to(record::text, 'UTF8'), 'hex') AS record_bytes
      FROM kurobara_core.dataset_records
      ORDER BY record_ordinal
    `;
    assert.deepEqual(
      afterRecords.map(({ record_bytes, record_id, record_text }) => ({
        record_bytes,
        record_id,
        record_text,
      })),
      [...beforeRecords]
    );
    assert.deepEqual(
      afterRecords.map(({ materialization_id, record_ordinal }) => ({
        materialization_id,
        record_ordinal,
      })),
      [
        {
          materialization_id: "dataset-completed-c",
          record_ordinal: "1",
        },
        {
          materialization_id: "dataset-completed-c",
          record_ordinal: "2",
        },
      ]
    );
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
            'workspace-materialization',
            'dataset-hostile',
            'Hostile payload dataset',
            ${hash("a")},
            ${transaction.json({
              datasetId: "dataset-hostile",
              name: "Hostile payload dataset",
              workspaceId: "workspace-materialization",
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
            'workspace-materialization',
            'import-hostile',
            'dataset-hostile',
            ${hash("a")},
            ${hash("b")},
            ${hash("c")},
            'jsonl',
            '1.0.0',
            1024,
            1,
            1024
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
            'workspace-materialization',
            'dataset-hostile',
            'dataset-hostile',
            ${hash("a")},
            'import',
            'import-hostile',
            'building',
            1,
            0,
            0,
            '{}'::jsonb,
            clock_timestamp()
          )
        `;
      }),
      CHECK_CONSTRAINT_VIOLATION
    );
    assert.deepEqual(
      await runtime.datasets.finishImport(
        { workspaceId: workspaceId("workspace-materialization") },
        "import-running",
        { batchCount: 0, itemCount: 0, state: "completed" }
      ),
      {
        progress: {
          batchCount: 0,
          datasetId: datasetId("dataset-running-r"),
          errorCount: 0,
          importId: "import-running",
          itemCount: 0,
          recordCount: 0,
          state: "completed",
          workspaceId: workspaceId("workspace-materialization"),
        },
        status: "applied",
      }
    );
    const resumed = await runtime.datasets.getDataset(
      { workspaceId: workspaceId("workspace-materialization") },
      datasetId("dataset-running-r")
    );
    assert.equal(resumed?.materialization.state, "ready");
    assert.equal(resumed?.materialization.contentHash, emptyContentHash);
    assert.equal(resumed?.materialization.revision, 2);
    const compatible = await runtime.datasets.getDataset(
      { workspaceId: workspaceId("workspace-materialization") },
      datasetId("dataset-padded-p ")
    );
    assert.equal(
      compatible?.materialization.materializationId,
      "dataset-padded-p "
    );
    assert.deepEqual(compatible?.materialization.origin, {
      importId: "import-padded ",
      kind: "import",
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
