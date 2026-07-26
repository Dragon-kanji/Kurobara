import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { createPostgresRuntime } from "@kurobara/adapter-postgres";
import {
  createHmacContactPrivacySubjectKeyDeriver,
  makeAuthorizeContactEffect,
  makeRegisterContactPrivacyTombstone,
} from "@kurobara/application";
import {
  actorId,
  contentHash,
  datasetId,
  fieldId,
  idempotencyKey,
  instant,
  workspaceId,
} from "@kurobara/kernel";
import type { PrepareExportDeliveryInput } from "@kurobara/ports";
import postgres from "postgres";

const execFileAsync = promisify(execFile);
const POSTGRES_VERSION_PATTERN = /\(PostgreSQL\)\s+(\d+)/u;
const adminUrl = process.env.KUROBARA_TEST_POSTGRES_URL;
const now = instant(1_900_000_000_000);
const workspace = workspaceId("workspace-contact-export-restore");
const owner = actorId("owner-contact-export-restore");
const subject = {
  kind: "email",
  value: "restore-subject@example.invalid",
} as const;
const subjectKeys = createHmacContactPrivacySubjectKeyDeriver([
  {
    current: false,
    keyMaterial: new Uint8Array(32).fill(17),
    version: "v1",
  },
  {
    current: true,
    keyMaterial: new Uint8Array(32).fill(34),
    version: "v2",
  },
]);

const hash = (marker: string) =>
  contentHash(`sha256:${marker.repeat(64).slice(0, 64)}`);

const deliveryIntentHash = hash("a");
const deliveryId = `export-delivery-${deliveryIntentHash.slice("sha256:".length)}`;

const makeDeliveryInput = async (): Promise<PrepareExportDeliveryInput> => ({
  delivery: {
    deliveryId,
    intentHash: deliveryIntentHash,
    manifest: {
      applicationId: null,
      contentHash: hash("b"),
      contentLength: 83,
      dataClasses: ["professional-email"],
      datasetId: datasetId("dataset-contact-export-restore"),
      fieldIds: [fieldId("field-work-email")],
      format: "csv",
      manifestVersion: "2.0.0",
      observedExpiries: [
        {
          dataClass: "professional-email",
          expiresAt: instant(now + 3_600_000),
          observedAt: instant(now - 1000),
        },
      ],
      ownerActorId: owner,
      policyPurpose: {
        policyExpiresAt: instant(now + 7_200_000),
        policyVersion: "contact-export-restore-policy-v1",
        purposeRef: "synthetic-restore-proof",
        territory: "ES",
      },
      providerRights: {
        expiresAt: instant(now + 5_400_000),
        mode: "synthetic-fixture",
        version: "synthetic-provider-rights-v1",
      },
      recipeId: null,
      recipeRevision: null,
      source: {
        capabilityId: "contacts.work-email.resolve",
        capabilityVersion: "1.0.0",
        generationId: "generation-contact-export-restore",
        generationPlanId: "generation-plan-contact-export-restore",
        kind: "generated-dataset",
        planHash: hash("c"),
      },
      workspaceId: workspace,
    },
    preparedAt: now,
  },
  idempotencyKey: idempotencyKey("prepare-contact-export-restore"),
  subjectKeys: (await subjectKeys.derive(subject)).all,
});

const policy = {
  expiresAt: instant(now + 86_400_000),
  purposeRefs: ["synthetic-restore-proof"],
  rules: {
    "professional-email": {
      allowedActions: ["export"] as const,
      maxRetentionMilliseconds: 3_600_000,
    },
  },
  territories: ["ES"],
  version: "contact-export-restore-policy-v1",
} as const;

const facts = {
  action: "export" as const,
  activeRestrictions: [],
  explicitlyEnabledDataClasses: [],
  purposeRef: "synthetic-restore-proof",
  requestedData: [
    {
      dataClass: "professional-email" as const,
      observedAt: instant(now - 1000),
    },
  ],
  territory: "ES",
};

type RegistrySnapshot = Readonly<{
  delivery_alias_count: string;
  registration_count: string;
  revocation_event_count: string;
  revocation_proof_count: string;
  serialized_proofs: string;
  tombstone_alias_count: string;
  tombstone_count: string;
}>;

const readRegistrySnapshot = async (
  sql: ReturnType<typeof postgres>
): Promise<RegistrySnapshot> => {
  const rows = await sql<readonly RegistrySnapshot[]>`
    SELECT
      (
        SELECT count(*)::text
        FROM kurobara_core.export_delivery_subject_keys
        WHERE workspace_id = ${workspace}
          AND delivery_id = ${deliveryId}
      ) AS delivery_alias_count,
      (
        SELECT count(*)::text
        FROM kurobara_core.contact_privacy_registration_requests
        WHERE workspace_id = ${workspace}
      ) AS registration_count,
      (
        SELECT count(*)::text
        FROM kurobara_core.export_delivery_events
        WHERE workspace_id = ${workspace}
          AND delivery_id = ${deliveryId}
          AND event_type = 'revoked'
      ) AS revocation_event_count,
      (
        SELECT count(*)::text
        FROM kurobara_core.export_delivery_revocation_proofs
        WHERE workspace_id = ${workspace}
          AND delivery_id = ${deliveryId}
      ) AS revocation_proof_count,
      concat(
        coalesce((
          SELECT string_agg(row_to_json(tombstone)::text, '')
          FROM kurobara_core.contact_privacy_tombstones AS tombstone
          WHERE tombstone.workspace_id = ${workspace}
        ), ''),
        coalesce((
          SELECT string_agg(row_to_json(alias)::text, '')
          FROM kurobara_core.contact_privacy_tombstone_subject_keys AS alias
          WHERE alias.workspace_id = ${workspace}
        ), ''),
        coalesce((
          SELECT string_agg(proof.manifest::text, '')
          FROM kurobara_core.export_delivery_revocation_proofs AS proof
          WHERE proof.workspace_id = ${workspace}
        ), '')
      ) AS serialized_proofs,
      (
        SELECT count(*)::text
        FROM kurobara_core.contact_privacy_tombstone_subject_keys
        WHERE workspace_id = ${workspace}
      ) AS tombstone_alias_count,
      (
        SELECT count(*)::text
        FROM kurobara_core.contact_privacy_tombstones
        WHERE workspace_id = ${workspace}
      ) AS tombstone_count
  `;
  const snapshot = rows[0];
  if (snapshot === undefined) {
    throw new Error("The restored Contact export registry could not be read.");
  }
  return snapshot;
};

const commandVersion = async (
  command: "pg_dump" | "pg_restore"
): Promise<string | undefined> => {
  try {
    const result = await execFileAsync(command, ["--version"], {
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
    });
    return String(result.stdout).trim();
  } catch (error) {
    const code =
      error instanceof Error && "code" in error
        ? (error as Error & { code?: unknown }).code
        : undefined;
    if (code === "ENOENT") {
      return;
    }
    throw error;
  }
};

const postgresMajor = (version: string): number => {
  const match = POSTGRES_VERSION_PATTERN.exec(version);
  const major = Number(match?.[1]);
  if (!Number.isSafeInteger(major) || major <= 0) {
    throw new Error(`Unsupported PostgreSQL client version: ${version}`);
  }
  return major;
};

const databaseUrl = (base: string, databaseName: string): string => {
  const url = new URL(base);
  url.pathname = `/${databaseName}`;
  return url.toString();
};

const cleanupFailure = (
  results: readonly PromiseSettledResult<unknown>[]
): unknown =>
  results.find(
    (result): result is PromiseRejectedResult => result.status === "rejected"
  )?.reason;

// biome-ignore lint/style/noDoneCallback: Node supplies a TestContext here, not a completion callback.
test("restores revoked Contact export deliveries without losing historical HMAC aliases", async (context) => {
  if (adminUrl === undefined || adminUrl.trim().length === 0) {
    context.skip("KUROBARA_TEST_POSTGRES_URL is not configured.");
    return;
  }
  const [pgDumpVersion, pgRestoreVersion] = await Promise.all([
    commandVersion("pg_dump"),
    commandVersion("pg_restore"),
  ]);
  if (pgDumpVersion === undefined || pgRestoreVersion === undefined) {
    context.skip("pg_dump and pg_restore are required for the restore drill.");
    return;
  }

  const suffix = `${process.pid}_${Date.now()}`;
  const sourceDatabaseName = `kurobara_ce_restore_src_${suffix}`;
  const targetDatabaseName = `kurobara_ce_restore_dst_${suffix}`;
  const sourceDatabaseUrl = databaseUrl(adminUrl, sourceDatabaseName);
  const targetDatabaseUrl = databaseUrl(adminUrl, targetDatabaseName);
  const admin = postgres(adminUrl, { max: 1 });
  let sourceRuntime: ReturnType<typeof createPostgresRuntime> | undefined;
  let targetRuntime: ReturnType<typeof createPostgresRuntime> | undefined;
  let sourceSql: ReturnType<typeof postgres> | undefined;
  let targetSql: ReturnType<typeof postgres> | undefined;
  let temporaryDirectory: string | undefined;
  let primaryError: unknown;
  let cleanupError: unknown;

  try {
    const serverVersionRows = await admin<
      readonly { server_version_num: string }[]
    >`SHOW server_version_num`;
    const serverVersion = Number(serverVersionRows[0]?.server_version_num);
    const serverMajor = Math.floor(serverVersion / 10_000);
    const pgDumpMajor = postgresMajor(pgDumpVersion);
    const pgRestoreMajor = postgresMajor(pgRestoreVersion);
    if (
      !Number.isSafeInteger(serverMajor) ||
      serverMajor <= 0 ||
      pgDumpMajor !== serverMajor ||
      pgRestoreMajor !== serverMajor
    ) {
      context.skip(
        "Compatible pg_dump and pg_restore binaries are unavailable."
      );
      return;
    }

    temporaryDirectory = await mkdtemp(
      join(tmpdir(), "kurobara-contact-export-restore.")
    );
    const dumpPath = join(temporaryDirectory, "contact-export.dump");

    await admin`CREATE DATABASE ${admin(sourceDatabaseName)}`;
    sourceRuntime = createPostgresRuntime(sourceDatabaseUrl);
    await sourceRuntime.migrate();
    await sourceRuntime.verifyMigrations();
    sourceSql = postgres(sourceDatabaseUrl, { max: 2 });
    await sourceSql`
      INSERT INTO kurobara_core.workspaces (workspace_id)
      VALUES (${workspace})
    `;

    const deliveryInput = await makeDeliveryInput();
    const prepared = await sourceRuntime.exportDeliveries.prepare(
      { workspaceId: workspace },
      deliveryInput
    );
    assert.equal(prepared.status, "prepared");
    const completed = await sourceRuntime.exportDeliveries.complete(
      { workspaceId: workspace },
      {
        contentHash: deliveryInput.delivery.manifest.contentHash,
        contentLength: deliveryInput.delivery.manifest.contentLength,
        deliveredAt: instant(now + 1000),
        deliveryId,
        ownerActorId: owner,
      }
    );
    assert.equal(completed.status, "delivered");

    const register = makeRegisterContactPrivacyTombstone({
      clock: { now: () => Promise.resolve(instant(now + 2000)) },
      persistence: sourceRuntime.contactPrivacy,
      subjectKeys,
    });
    const restrictionRequest = {
      idempotencyKey: idempotencyKey("restrict-contact-export-restore"),
      reason: "provider-opt-out" as const,
      subject,
      workspaceId: workspace,
    };
    const restricted = await register(restrictionRequest);
    assert.equal(restricted.ok, true);
    if (restricted.ok) {
      assert.equal(restricted.value.affectedDeliveryCount, 1);
      assert.equal(restricted.value.newlyRevokedDeliveryCount, 1);
    }
    assert.equal(
      (
        await sourceRuntime.exportDeliveries.getOwned(
          { workspaceId: workspace },
          deliveryId,
          owner
        )
      )?.state,
      "revoked"
    );

    await sourceRuntime.close();
    sourceRuntime = undefined;
    await sourceSql.end({ timeout: 5 });
    sourceSql = undefined;

    await execFileAsync(
      "pg_dump",
      ["--format=custom", "--file", dumpPath, "--dbname", sourceDatabaseUrl],
      { encoding: "utf8", maxBuffer: 1024 * 1024 }
    );

    await admin`CREATE DATABASE ${admin(targetDatabaseName)}`;
    await execFileAsync(
      "pg_restore",
      [
        "--exit-on-error",
        "--no-owner",
        "--no-privileges",
        "--dbname",
        targetDatabaseUrl,
        dumpPath,
      ],
      { encoding: "utf8", maxBuffer: 4 * 1024 * 1024 }
    );

    targetRuntime = createPostgresRuntime(targetDatabaseUrl);
    await targetRuntime.verifyMigrations();
    targetSql = postgres(targetDatabaseUrl, { max: 2 });

    assert.equal(
      (
        await targetRuntime.exportDeliveries.getOwned(
          { workspaceId: workspace },
          deliveryId,
          owner
        )
      )?.state,
      "revoked"
    );
    const authorization = await makeAuthorizeContactEffect({
      clock: { now: () => Promise.resolve(instant(now + 3000)) },
      persistence: targetRuntime.contactPrivacy,
      subjectKeys,
    })({
      facts,
      policy,
      subject,
      workspaceId: workspace,
    });
    assert.equal(authorization.ok, true);
    if (authorization.ok) {
      assert.deepEqual(authorization.value.decision.reasonCodes, [
        "provider-opt-out",
      ]);
      assert.equal(authorization.value.matchedTombstoneIds.length, 1);
    }

    const beforeReplay = await readRegistrySnapshot(targetSql);
    assert.deepEqual(
      {
        deliveryAliasCount: beforeReplay.delivery_alias_count,
        registrationCount: beforeReplay.registration_count,
        revocationEventCount: beforeReplay.revocation_event_count,
        revocationProofCount: beforeReplay.revocation_proof_count,
        tombstoneAliasCount: beforeReplay.tombstone_alias_count,
        tombstoneCount: beforeReplay.tombstone_count,
      },
      {
        deliveryAliasCount: "2",
        registrationCount: "1",
        revocationEventCount: "1",
        revocationProofCount: "1",
        tombstoneAliasCount: "2",
        tombstoneCount: "1",
      }
    );
    assert.equal(beforeReplay.serialized_proofs.includes(subject.value), false);

    const replayed = await makeRegisterContactPrivacyTombstone({
      clock: { now: () => Promise.resolve(instant(now + 4000)) },
      persistence: targetRuntime.contactPrivacy,
      subjectKeys,
    })(restrictionRequest);
    assert.equal(replayed.ok, true);
    if (replayed.ok) {
      assert.equal(replayed.value.replayed, true);
      assert.equal(replayed.value.affectedDeliveryCount, 1);
      assert.equal(replayed.value.newlyRevokedDeliveryCount, 0);
    }

    const afterReplay = await readRegistrySnapshot(targetSql);
    assert.deepEqual(afterReplay, beforeReplay);
    assert.equal(afterReplay.serialized_proofs.includes(subject.value), false);
  } catch (error) {
    primaryError = error;
  } finally {
    const closeResults = await Promise.allSettled([
      sourceRuntime?.close(),
      targetRuntime?.close(),
      sourceSql?.end({ timeout: 5 }),
      targetSql?.end({ timeout: 5 }),
    ]);
    const dropResults = await Promise.allSettled([
      admin`DROP DATABASE IF EXISTS ${admin(sourceDatabaseName)} WITH (FORCE)`,
      admin`DROP DATABASE IF EXISTS ${admin(targetDatabaseName)} WITH (FORCE)`,
    ]);
    const finalResults = await Promise.allSettled([
      admin.end({ timeout: 5 }),
      temporaryDirectory === undefined
        ? Promise.resolve()
        : rm(temporaryDirectory, { force: true, recursive: true }),
    ]);
    cleanupError =
      cleanupFailure(closeResults) ??
      cleanupFailure(dropResults) ??
      cleanupFailure(finalResults);
  }
  if (primaryError !== undefined) {
    throw primaryError;
  }
  if (cleanupError !== undefined) {
    throw cleanupError;
  }
});
