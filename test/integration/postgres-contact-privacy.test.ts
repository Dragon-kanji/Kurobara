import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";

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
const PRE_PRIVACY_MIGRATION_PATTERN =
  /^00(?:0[1-9]|1[0-9]|2[0-3])_[a-z0-9_]+\.sql$/u;
const APPEND_ONLY = /contact privacy records are append-only/u;
const EXPORT_APPEND_ONLY = /export delivery records are append-only/u;
const now = instant(1_800_000_000_000);
const workspaceA = workspaceId("workspace-privacy-a");
const workspaceB = workspaceId("workspace-privacy-b");
const owner = actorId("owner-contact-export-privacy");
const subject = { kind: "email", value: "synthetic@example.invalid" } as const;
const subjectKeys = createHmacContactPrivacySubjectKeyDeriver([
  {
    current: false,
    keyMaterial: new Uint8Array(32).fill(8),
    version: "privacy-key-integration-v0",
  },
  {
    current: true,
    keyMaterial: new Uint8Array(32).fill(9),
    version: "privacy-key-integration-v1",
  },
]);

const policy = {
  expiresAt: instant(now + 86_400_000),
  purposeRefs: ["synthetic-research"],
  rules: {
    "professional-email": {
      allowedActions: ["enrich"] as const,
      maxRetentionMilliseconds: 3_600_000,
    },
  },
  territories: ["ES"],
  version: "contact-privacy-v1",
} as const;
const facts = {
  action: "enrich" as const,
  activeRestrictions: [],
  explicitlyEnabledDataClasses: [],
  purposeRef: "synthetic-research",
  requestedData: [{ dataClass: "professional-email" as const }],
  territory: "ES",
};

const hash = (marker: string) =>
  contentHash(`sha256:${marker.repeat(64).slice(0, 64)}`);

const generatedDeliveryInput = async (
  requestedWorkspace: typeof workspaceA | typeof workspaceB,
  marker: string
) => {
  const intentHash = hash(marker);
  return {
    delivery: {
      deliveryId: `export-delivery-${intentHash.slice("sha256:".length)}`,
      intentHash,
      manifest: {
        applicationId: null,
        contentHash: hash(marker === "a" ? "c" : "d"),
        contentLength: 42,
        dataClasses: ["professional-email"] as const,
        datasetId: datasetId(`dataset-contact-export-${marker}`),
        fieldIds: [fieldId("field-work-email")],
        format: "csv" as const,
        manifestVersion: "2.0.0" as const,
        observedExpiries: [
          {
            dataClass: "professional-email" as const,
            expiresAt: instant(now + 3_600_000),
            observedAt: instant(now - 1000),
          },
        ],
        ownerActorId: owner,
        policyPurpose: {
          policyExpiresAt: instant(now + 7_200_000),
          policyVersion: "contact-privacy-v1",
          purposeRef: "synthetic-research",
          territory: "ES",
        },
        providerRights: {
          expiresAt: instant(now + 5_400_000),
          mode: "synthetic-fixture" as const,
          version: "fixture-rights-v1",
        },
        recipeId: null,
        recipeRevision: null,
        source: {
          capabilityId: "contacts.work-email.resolve",
          capabilityVersion: "1.0.0",
          generationId: `generation-contact-export-${marker}`,
          generationPlanId: `generation-plan-contact-export-${marker}`,
          kind: "generated-dataset" as const,
          planHash: hash(marker === "a" ? "e" : "f"),
        },
        workspaceId: requestedWorkspace,
      },
      preparedAt: now,
    },
    idempotencyKey: idempotencyKey(`prepare-contact-export-delivery-${marker}`),
    subjectKeys: (await subjectKeys.derive(subject)).all,
  };
};

test("rolls forward, isolates, replays, and reloads privacy tombstones", async () => {
  const databaseName = `kurobara_contact_privacy_${process.pid}_${Date.now()}`;
  const databaseUrl = new URL(adminUrl);
  databaseUrl.pathname = `/${databaseName}`;
  const admin = postgres(adminUrl, { max: 1 });
  let sql: ReturnType<typeof postgres> | undefined;
  let runtime: ReturnType<typeof createPostgresRuntime> | undefined;

  try {
    await admin`CREATE DATABASE ${admin(databaseName)}`;
    sql = postgres(databaseUrl.toString(), { max: 4 });
    await sql`CREATE SCHEMA IF NOT EXISTS kurobara_core`;
    await sql`
      CREATE TABLE kurobara_core.schema_migrations (
        migration_name text PRIMARY KEY,
        checksum text NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT clock_timestamp()
      )
    `;

    const migrationNames = (await readdir(migrationsUrl))
      .filter((name) => PRE_PRIVACY_MIGRATION_PATTERN.test(name))
      .sort();
    assert.equal(
      migrationNames.at(-1),
      "0023_dataset_generation_multi_page.sql"
    );
    assert.equal(migrationNames.length, 23);
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
      VALUES (${workspaceA}), (${workspaceB})
    `;

    runtime = createPostgresRuntime(databaseUrl.toString());
    await runtime.migrate();
    await runtime.verifyMigrations();
    const deliveryAInput = await generatedDeliveryInput(workspaceA, "a");
    const deliveryBInput = await generatedDeliveryInput(workspaceB, "b");
    const preparedA = await runtime.exportDeliveries.prepare(
      { workspaceId: workspaceA },
      deliveryAInput
    );
    const preparedB = await runtime.exportDeliveries.prepare(
      { workspaceId: workspaceB },
      deliveryBInput
    );
    assert.equal(preparedA.status, "prepared");
    assert.equal(preparedB.status, "prepared");
    if (preparedA.status !== "prepared" || preparedB.status !== "prepared") {
      throw new Error("Synthetic Contact export delivery preparation failed.");
    }
    assert.equal(
      (
        await runtime.exportDeliveries.complete(
          { workspaceId: workspaceA },
          {
            contentHash: deliveryAInput.delivery.manifest.contentHash,
            contentLength: deliveryAInput.delivery.manifest.contentLength,
            deliveredAt: instant(now + 1000),
            deliveryId: deliveryAInput.delivery.deliveryId,
            ownerActorId: owner,
          }
        )
      ).status,
      "delivered"
    );
    assert.equal(
      (
        await runtime.exportDeliveries.complete(
          { workspaceId: workspaceB },
          {
            contentHash: deliveryBInput.delivery.manifest.contentHash,
            contentLength: deliveryBInput.delivery.manifest.contentLength,
            deliveredAt: instant(now + 1000),
            deliveryId: deliveryBInput.delivery.deliveryId,
            ownerActorId: owner,
          }
        )
      ).status,
      "delivered"
    );
    const dependencies = {
      clock: { now: () => Promise.resolve(instant(now + 2000)) },
      persistence: runtime.contactPrivacy,
      subjectKeys,
    };
    const register = makeRegisterContactPrivacyTombstone(dependencies);
    const request = {
      idempotencyKey: idempotencyKey("privacy-integration-register"),
      reason: "provider-opt-out" as const,
      subject,
      workspaceId: workspaceA,
    };

    const concurrent = await Promise.all(
      Array.from({ length: 8 }, () => register(request))
    );
    assert.equal(
      concurrent.every((result) => result.ok),
      true
    );
    const proofs = concurrent.flatMap((result) =>
      result.ok ? [result.value.proof] : []
    );
    assert.equal(new Set(proofs.map((proof) => proof.tombstoneId)).size, 1);
    assert.equal(
      concurrent.filter((result) => result.ok && !result.value.replayed).length,
      1
    );
    assert.equal(
      concurrent.every(
        (result) => result.ok && result.value.affectedDeliveryCount === 1
      ),
      true
    );
    assert.equal(
      concurrent.reduce(
        (count, result) =>
          count +
          (result.ok ? (result.value.newlyRevokedDeliveryCount ?? 0) : 0),
        0
      ),
      1
    );
    assert.equal(
      (
        await runtime.exportDeliveries.getOwned(
          { workspaceId: workspaceA },
          deliveryAInput.delivery.deliveryId,
          owner
        )
      )?.state,
      "revoked"
    );
    assert.equal(
      (
        await runtime.exportDeliveries.getOwned(
          { workspaceId: workspaceB },
          deliveryBInput.delivery.deliveryId,
          owner
        )
      )?.state,
      "delivered"
    );
    const sameIntentNewKey = await register({
      ...request,
      idempotencyKey: idempotencyKey("privacy-integration-register-replay"),
    });
    const idempotencyCollision = await register({
      ...request,
      reason: "provider-deletion",
    });
    assert.equal(sameIntentNewKey.ok, true);
    assert.equal(idempotencyCollision.ok, false);
    if (sameIntentNewKey.ok) {
      assert.equal(sameIntentNewKey.value.replayed, true);
      assert.equal(sameIntentNewKey.value.affectedDeliveryCount, 1);
      assert.equal(sameIntentNewKey.value.newlyRevokedDeliveryCount, 0);
      assert.equal(
        sameIntentNewKey.value.proof.tombstoneId,
        proofs[0]?.tombstoneId
      );
    }

    const authorize = makeAuthorizeContactEffect(dependencies);
    const denied = await authorize({
      facts,
      policy,
      subject,
      workspaceId: workspaceA,
    });
    const otherWorkspace = await authorize({
      facts,
      policy,
      subject,
      workspaceId: workspaceB,
    });
    assert.equal(denied.ok, true);
    assert.equal(otherWorkspace.ok, true);
    if (denied.ok && otherWorkspace.ok) {
      assert.deepEqual(denied.value.decision.reasonCodes, ["provider-opt-out"]);
      assert.deepEqual(otherWorkspace.value.decision.reasonCodes, ["allowed"]);
    }

    await runtime.close();
    runtime = createPostgresRuntime(databaseUrl.toString());
    const afterRestart = await makeAuthorizeContactEffect({
      ...dependencies,
      persistence: runtime.contactPrivacy,
    })({ facts, policy, subject, workspaceId: workspaceA });
    assert.equal(afterRestart.ok, true);
    if (afterRestart.ok) {
      assert.deepEqual(afterRestart.value.decision.reasonCodes, [
        "provider-opt-out",
      ]);
    }
    assert.equal(
      (
        await runtime.exportDeliveries.getOwned(
          { workspaceId: workspaceA },
          deliveryAInput.delivery.deliveryId,
          owner
        )
      )?.state,
      "revoked"
    );

    const readback = await sql<
      readonly {
        delivery_revocation_count: string;
        migration_count: string;
        migration_name: string;
        registration_count: string;
        revocation_manifest: string;
        serialized: string;
        subject_alias_count: string;
        tombstone_count: string;
      }[]
    >`
      SELECT
        (
          SELECT count(*)::text
          FROM kurobara_core.export_delivery_revocation_proofs
          WHERE workspace_id = ${workspaceA}
        ) AS delivery_revocation_count,
        (SELECT count(*)::text FROM kurobara_core.schema_migrations)
          AS migration_count,
        (
          SELECT migration_name
          FROM kurobara_core.schema_migrations
          ORDER BY migration_name DESC
          LIMIT 1
        ) AS migration_name,
        (
          SELECT count(*)::text
          FROM kurobara_core.contact_privacy_registration_requests
          WHERE workspace_id = ${workspaceA}
        ) AS registration_count,
        (
          SELECT manifest::text
          FROM kurobara_core.export_delivery_revocation_proofs
          WHERE workspace_id = ${workspaceA}
          LIMIT 1
        ) AS revocation_manifest,
        row_to_json(tombstone)::text AS serialized,
        (
          SELECT count(*)::text
          FROM kurobara_core.contact_privacy_tombstone_subject_keys
          WHERE workspace_id = ${workspaceA}
        ) AS subject_alias_count,
        count(*) OVER ()::text AS tombstone_count
      FROM kurobara_core.contact_privacy_tombstones AS tombstone
      WHERE workspace_id = ${workspaceA}
    `;
    assert.equal(readback[0]?.delivery_revocation_count, "1");
    assert.equal(readback[0]?.migration_count, "30");
    assert.equal(
      readback[0]?.migration_name,
      "0030_contact_export_delivery_lifecycle.sql"
    );
    assert.equal(readback[0]?.registration_count, "2");
    assert.equal(readback[0]?.subject_alias_count, "2");
    assert.equal(readback[0]?.tombstone_count, "1");
    assert.equal(readback[0]?.serialized.includes(subject.value), false);
    assert.equal(
      readback[0]?.revocation_manifest.includes(subject.value),
      false
    );

    await assert.rejects(
      sql`
        UPDATE kurobara_core.contact_privacy_tombstones
        SET reason_code = 'provider-deletion'
        WHERE workspace_id = ${workspaceA}
      `,
      APPEND_ONLY
    );
    await assert.rejects(
      sql`
        DELETE FROM kurobara_core.contact_privacy_registration_requests
        WHERE workspace_id = ${workspaceA}
      `,
      APPEND_ONLY
    );
    await assert.rejects(
      sql`
        DELETE FROM kurobara_core.contact_privacy_tombstone_subject_keys
        WHERE workspace_id = ${workspaceA}
      `,
      APPEND_ONLY
    );
    await assert.rejects(
      sql`
        DELETE FROM kurobara_core.export_delivery_revocation_proofs
        WHERE workspace_id = ${workspaceA}
      `,
      EXPORT_APPEND_ONLY
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
