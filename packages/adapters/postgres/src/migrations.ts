import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type postgres from "postgres";

import { PostgresAdapterError } from "./errors.ts";

const migrationsDirectory = join(
  dirname(fileURLToPath(import.meta.url)),
  "../migrations"
);
const MIGRATION_FILE_PATTERN = /^\d{4}_[a-z0-9_]+\.sql$/u;

const checksum = (content: string): string =>
  createHash("sha256").update(content).digest("hex");

type MigrationSource = Readonly<{
  checksum: string;
  content: string;
  name: string;
}>;

type RecordedMigration = Readonly<{
  checksum: string;
  migration_name: string;
}>;

const loadMigrationSources = async (): Promise<readonly MigrationSource[]> => {
  const names = (await readdir(migrationsDirectory))
    .filter((name) => MIGRATION_FILE_PATTERN.test(name))
    .sort();
  return Promise.all(
    names.map(async (name) => {
      const content = await readFile(join(migrationsDirectory, name), "utf8");
      return { checksum: checksum(content), content, name };
    })
  );
};

const validateRecordedMigrations = (
  recorded: readonly RecordedMigration[],
  migrations: readonly MigrationSource[],
  requireComplete: boolean
): Map<string, RecordedMigration> => {
  const migrationNames = new Set(migrations.map((migration) => migration.name));
  const missingSource = recorded.find(
    (migration) => !migrationNames.has(migration.migration_name)
  );
  if (missingSource !== undefined) {
    throw new PostgresAdapterError(
      "migration-source-missing",
      `Applied migration ${missingSource.migration_name} has no source file in this build.`
    );
  }
  const recordedByName = new Map(
    recorded.map((migration) => [migration.migration_name, migration])
  );
  for (const migration of migrations) {
    const applied = recordedByName.get(migration.name);
    if (applied === undefined) {
      if (requireComplete) {
        throw new PostgresAdapterError(
          "migration-pending",
          `Required migration ${migration.name} has not been applied.`
        );
      }
      continue;
    }
    if (applied.checksum !== migration.checksum) {
      throw new PostgresAdapterError(
        "migration-checksum-mismatch",
        `Applied migration ${migration.name} no longer matches its recorded checksum.`
      );
    }
  }
  return recordedByName;
};

export const applyPostgresMigrations = async (
  sql: postgres.Sql
): Promise<void> => {
  const migrations = await loadMigrationSources();

  await sql.begin(async (transaction) => {
    // postgres-js' TransactionSql type omits its runtime tag-call signature.
    const transactionSql = transaction as unknown as postgres.Sql;
    await transactionSql`SELECT pg_advisory_xact_lock(hashtext('kurobara_core_migrations'))`;
    await transactionSql`CREATE SCHEMA IF NOT EXISTS kurobara_core`;
    await transactionSql`
      CREATE TABLE IF NOT EXISTS kurobara_core.schema_migrations (
        migration_name text PRIMARY KEY,
        checksum text NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT clock_timestamp()
      )
    `;

    const recorded = await transactionSql<readonly RecordedMigration[]>`
      SELECT migration_name, checksum
      FROM kurobara_core.schema_migrations
      ORDER BY migration_name
    `;
    const recordedByName = validateRecordedMigrations(
      recorded,
      migrations,
      false
    );

    for (const migration of migrations) {
      const applied = recordedByName.get(migration.name);
      if (applied !== undefined) {
        continue;
      }

      await transactionSql.unsafe(migration.content);
      await transactionSql`
        INSERT INTO kurobara_core.schema_migrations (migration_name, checksum)
        VALUES (${migration.name}, ${migration.checksum})
      `;
    }
  });
};

export const verifyPostgresMigrations = async (
  sql: postgres.Sql
): Promise<void> => {
  const migrations = await loadMigrationSources();
  const tables = await sql<readonly { migration_table: string | null }[]>`
    SELECT to_regclass('kurobara_core.schema_migrations')::text AS migration_table
  `;
  if (tables[0]?.migration_table === null) {
    throw new PostgresAdapterError(
      "migration-table-missing",
      "The PostgreSQL schema has not been initialized."
    );
  }
  const recorded = await sql<readonly RecordedMigration[]>`
    SELECT migration_name, checksum
    FROM kurobara_core.schema_migrations
    ORDER BY migration_name
  `;
  validateRecordedMigrations(recorded, migrations, true);
};
