import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";

import {
  actorId,
  contentHash,
  datasetId,
  enrichmentRecipeId,
  fieldId,
  idempotencyKey,
  instant,
  workspaceId,
} from "@kurobara/kernel";
import type {
  ExportDeliveryManifest,
  PrepareExportDeliveryInput,
} from "@kurobara/ports";
import postgres from "postgres";

import { createPostgresExportDeliveryPersistence } from "../src/export-delivery.ts";
import { applyPostgresMigrations } from "../src/migrations.ts";

const migrationsUrl = new URL("../migrations/", import.meta.url);

const adminUrl = process.env.KUROBARA_TEST_POSTGRES_URL;
const APPEND_ONLY = /export delivery records are append-only/u;
const AUTHORIZATION_EXPIRED = /after authorization expiry/u;
const EVENT_PREDATES_PREPARATION = /cannot predate preparation/u;
const EXPORT_DELIVERY_INPUT_INVALID = /export delivery does not match/u;
const MANIFEST_IDENTITIES_INVALID = /unique aligned identities/u;
const MANIFEST_SCALAR_INVALID = /invalid scalar or observation/u;
const MIGRATION_FILE_PATTERN = /^\d{4}_[a-z0-9_]+\.sql$/u;
const PROOF_MISMATCH = /proof must match its manifest/u;
const workspace = workspaceId("workspace-export-delivery-database");
const otherWorkspace = workspaceId("workspace-export-delivery-other");
const owner = actorId("owner-export-delivery-database");
const otherOwner = actorId("owner-export-delivery-other");
const scope = { workspaceId: workspace } as const;
const hash = (marker: string) =>
  contentHash(`sha256:${marker.repeat(64).slice(0, 64)}`);

const manifest: ExportDeliveryManifest = {
  applicationId: "application-export-delivery-database",
  contentHash: hash("a"),
  contentLength: 37,
  dataClasses: ["contact-identity", "professional-email"],
  datasetId: datasetId("dataset-export-delivery-database"),
  fieldIds: [fieldId("field-contact-name"), fieldId("field-work-email")],
  format: "csv",
  observedExpiries: [
    {
      dataClass: "contact-identity",
      expiresAt: instant(5000),
      observedAt: instant(1000),
    },
    {
      dataClass: "professional-email",
      expiresAt: instant(5000),
      observedAt: instant(1000),
    },
  ],
  ownerActorId: owner,
  policyPurpose: {
    policyExpiresAt: instant(6000),
    policyVersion: "privacy-v1",
    purposeRef: "synthetic-evaluation",
    territory: "ES",
  },
  providerRights: {
    expiresAt: instant(5500),
    mode: "synthetic-fixture",
    version: "fixture-rights-v1",
  },
  recipeId: enrichmentRecipeId("recipe-export-delivery-database"),
  recipeRevision: "recipe-v1",
  workspaceId: workspace,
};
const intentHash = hash("b");
const deliveryId = `export-delivery-${intentHash.slice("sha256:".length)}`;
const prepareInput: PrepareExportDeliveryInput = {
  delivery: {
    deliveryId,
    intentHash,
    manifest,
    preparedAt: instant(2000),
  },
  idempotencyKey: idempotencyKey("prepare-export-delivery-database"),
};

test("persists owner-scoped immutable delivery proofs, replay, completion, and revocation", {
  skip: adminUrl === undefined,
}, async () => {
  if (adminUrl === undefined) {
    return;
  }
  const databaseName = `kurobara_export_delivery_${process.pid}_${Date.now()}`;
  const databaseUrl = new URL(adminUrl);
  databaseUrl.pathname = `/${databaseName}`;
  const admin = postgres(adminUrl, { max: 1 });
  let sql: ReturnType<typeof postgres> | undefined;
  try {
    await admin`CREATE DATABASE ${admin(databaseName)}`;
    sql = postgres(databaseUrl.toString(), { max: 8 });
    await applyPostgresMigrations(sql);
    await sql`
        INSERT INTO kurobara_core.workspaces (workspace_id)
        VALUES (${workspace}), (${otherWorkspace})
      `;
    const persistence = createPostgresExportDeliveryPersistence(sql);
    const concurrent = await Promise.all(
      Array.from({ length: 8 }, () => persistence.prepare(scope, prepareInput))
    );
    assert.equal(
      concurrent.every((result) => result.status === "prepared"),
      true
    );
    assert.equal(
      concurrent.filter(
        (result) => result.status === "prepared" && !result.replayed
      ).length,
      1
    );

    const replay = await persistence.prepare(scope, {
      ...prepareInput,
      idempotencyKey: idempotencyKey("prepare-export-delivery-replay"),
    });
    assert.equal(replay.status, "prepared");
    if (replay.status === "prepared") {
      assert.equal(replay.replayed, true);
      assert.equal(replay.delivery.deliveryId, deliveryId);
    }
    const collisionIntent = hash("c");
    const collision = await persistence.prepare(scope, {
      delivery: {
        ...prepareInput.delivery,
        deliveryId: `export-delivery-${collisionIntent.slice("sha256:".length)}`,
        intentHash: collisionIntent,
        manifest: { ...manifest, format: "jsonl" },
      },
      idempotencyKey: prepareInput.idempotencyKey,
    });
    assert.equal(collision.status, "idempotency-conflict");

    assert.equal(
      await persistence.getOwned(scope, deliveryId, otherOwner),
      undefined
    );
    assert.equal(
      await persistence.getOwned(
        { workspaceId: otherWorkspace },
        deliveryId,
        owner
      ),
      undefined
    );
    assert.equal(
      (
        await persistence.complete(scope, {
          contentHash: manifest.contentHash,
          contentLength: manifest.contentLength,
          deliveredAt: instant(2500),
          deliveryId,
          ownerActorId: otherOwner,
        })
      ).status,
      "not-found-or-owner-mismatch"
    );
    assert.equal(
      (
        await persistence.complete(scope, {
          contentHash: hash("d"),
          contentLength: manifest.contentLength,
          deliveredAt: instant(2500),
          deliveryId,
          ownerActorId: owner,
        })
      ).status,
      "proof-conflict"
    );

    const completed = await persistence.complete(scope, {
      contentHash: manifest.contentHash,
      contentLength: manifest.contentLength,
      deliveredAt: instant(2500),
      deliveryId,
      ownerActorId: owner,
    });
    assert.equal(completed.status, "delivered");
    if (completed.status === "delivered") {
      assert.equal(completed.replayed, false);
      assert.equal(completed.delivery.state, "delivered");
    }
    const completedReplay = await persistence.complete(scope, {
      contentHash: manifest.contentHash,
      contentLength: manifest.contentLength,
      deliveredAt: instant(2600),
      deliveryId,
      ownerActorId: owner,
    });
    assert.equal(completedReplay.status, "delivered");
    if (completedReplay.status === "delivered") {
      assert.equal(completedReplay.replayed, true);
      assert.equal(completedReplay.delivery.deliveredAt, instant(2500));
    }

    const revoked = await persistence.revoke(scope, {
      deliveryId,
      ownerActorId: owner,
      revokedAt: instant(3000),
    });
    assert.equal(revoked.status, "revoked");
    if (revoked.status === "revoked") {
      assert.equal(revoked.replayed, false);
      assert.equal(revoked.delivery.state, "revoked");
      assert.equal(revoked.delivery.deliveredAt, instant(2500));
    }
    assert.equal(
      (
        await persistence.complete(scope, {
          contentHash: manifest.contentHash,
          contentLength: manifest.contentLength,
          deliveredAt: instant(3500),
          deliveryId,
          ownerActorId: owner,
        })
      ).status,
      "revoked"
    );
    const revokedReplay = await persistence.prepare(scope, {
      ...prepareInput,
      idempotencyKey: idempotencyKey("prepare-export-delivery-after-revoke"),
    });
    assert.equal(revokedReplay.status, "revoked");

    const invalidManifestIntent = hash("e");
    await assert.rejects(
      persistence.prepare(scope, {
        delivery: {
          ...prepareInput.delivery,
          deliveryId: `export-delivery-${invalidManifestIntent.slice("sha256:".length)}`,
          intentHash: invalidManifestIntent,
          manifest: {
            ...manifest,
            fieldIds: [
              fieldId("field-contact-name"),
              fieldId("field-contact-name"),
            ],
          },
        },
        idempotencyKey: idempotencyKey("prepare-export-delivery-invalid"),
      }),
      MANIFEST_IDENTITIES_INVALID
    );
    const invalidLengthIntent = hash("3");
    await assert.rejects(
      persistence.prepare(scope, {
        delivery: {
          ...prepareInput.delivery,
          deliveryId: `export-delivery-${invalidLengthIntent.slice("sha256:".length)}`,
          intentHash: invalidLengthIntent,
          manifest: {
            ...manifest,
            contentLength: Number.MAX_SAFE_INTEGER + 1,
          },
        },
        idempotencyKey: idempotencyKey(
          "prepare-export-delivery-invalid-length"
        ),
      }),
      MANIFEST_SCALAR_INVALID
    );

    const transitionIntent = hash("f");
    const transitionManifest: ExportDeliveryManifest = {
      ...manifest,
      applicationId: "application-export-delivery-transition",
      contentHash: hash("1"),
    };
    const transitionDeliveryId = `export-delivery-${transitionIntent.slice("sha256:".length)}`;
    const transitionPrepared = await persistence.prepare(scope, {
      delivery: {
        deliveryId: transitionDeliveryId,
        intentHash: transitionIntent,
        manifest: transitionManifest,
        preparedAt: instant(2000),
      },
      idempotencyKey: idempotencyKey("prepare-export-delivery-transition"),
    });
    assert.equal(transitionPrepared.status, "prepared");

    await assert.rejects(
      sql`
        INSERT INTO kurobara_core.export_delivery_events (
          workspace_id,
          delivery_id,
          event_type,
          recorded_at,
          content_hash,
          content_length
        ) VALUES (
          ${workspace},
          ${transitionDeliveryId},
          'delivered',
          ${new Date(1500)},
          ${transitionManifest.contentHash},
          ${transitionManifest.contentLength}
        )
      `,
      EVENT_PREDATES_PREPARATION
    );
    await assert.rejects(
      sql`
        INSERT INTO kurobara_core.export_delivery_events (
          workspace_id,
          delivery_id,
          event_type,
          recorded_at,
          content_hash,
          content_length
        ) VALUES (
          ${workspace},
          ${transitionDeliveryId},
          'delivered',
          ${new Date(2500)},
          ${hash("2")},
          ${transitionManifest.contentLength}
        )
      `,
      PROOF_MISMATCH
    );
    await assert.rejects(
      sql`
        INSERT INTO kurobara_core.export_delivery_events (
          workspace_id,
          delivery_id,
          event_type,
          recorded_at,
          content_hash,
          content_length
        ) VALUES (
          ${workspace},
          ${transitionDeliveryId},
          'delivered',
          ${new Date(5000)},
          ${transitionManifest.contentHash},
          ${transitionManifest.contentLength}
        )
      `,
      AUTHORIZATION_EXPIRED
    );

    const [completionRace, revocationRace] = await Promise.all([
      persistence.complete(scope, {
        contentHash: transitionManifest.contentHash,
        contentLength: transitionManifest.contentLength,
        deliveredAt: instant(2500),
        deliveryId: transitionDeliveryId,
        ownerActorId: owner,
      }),
      persistence.revoke(scope, {
        deliveryId: transitionDeliveryId,
        ownerActorId: owner,
        revokedAt: instant(2500),
      }),
    ]);
    assert.equal(
      completionRace.status === "delivered" ||
        completionRace.status === "revoked",
      true
    );
    assert.equal(revocationRace.status, "revoked");
    assert.equal(
      (await persistence.getOwned(scope, transitionDeliveryId, owner))?.state,
      "revoked"
    );

    const readback = await sql<
      readonly {
        delivery_count: string;
        event_count: string;
        latest_migration: string;
        manifest_text: string;
        request_count: string;
      }[]
    >`
        SELECT
          (SELECT count(*)::text FROM kurobara_core.export_deliveries)
            AS delivery_count,
          (SELECT count(*)::text FROM kurobara_core.export_delivery_events)
            AS event_count,
          (
            SELECT migration_name
            FROM kurobara_core.schema_migrations
            ORDER BY migration_name DESC
            LIMIT 1
          ) AS latest_migration,
          delivery.manifest::text AS manifest_text,
          (SELECT count(*)::text FROM kurobara_core.export_delivery_requests)
            AS request_count
        FROM kurobara_core.export_deliveries AS delivery
        WHERE delivery.workspace_id = ${workspace}
          AND delivery.delivery_id = ${deliveryId}
      `;
    assert.equal(readback[0]?.delivery_count, "2");
    assert.equal(
      Number(readback[0]?.event_count) >= 3 &&
        Number(readback[0]?.event_count) <= 4,
      true
    );
    assert.equal(
      readback[0]?.latest_migration,
      "0031_gtm_context_play_workbook.sql"
    );
    assert.equal(readback[0]?.request_count, "4");
    assert.equal(readback[0]?.manifest_text.includes("subject-one"), false);
    assert.equal(readback[0]?.manifest_text.includes("providerKey"), false);
    assert.equal(readback[0]?.manifest_text.includes("providerId"), false);

    const generatedIntent = hash("4");
    const generatedDeliveryId = `export-delivery-${generatedIntent.slice("sha256:".length)}`;
    const generatedManifest: ExportDeliveryManifest = {
      ...manifest,
      applicationId: null,
      manifestVersion: "2.0.0",
      recipeId: null,
      recipeRevision: null,
      source: {
        capabilityId: "contacts.work-email.resolve",
        capabilityVersion: "1.0.0",
        generationId: "generation-export-delivery-database",
        generationPlanId: "generation-plan-export-delivery-database",
        kind: "generated-dataset",
        planHash: hash("5"),
      },
    };
    const generatedInput: PrepareExportDeliveryInput = {
      delivery: {
        deliveryId: generatedDeliveryId,
        intentHash: generatedIntent,
        manifest: generatedManifest,
        preparedAt: instant(2000),
      },
      idempotencyKey: idempotencyKey(
        "prepare-generated-export-delivery-database"
      ),
      subjectKeys: [
        {
          algorithm: "hmac-sha-256",
          digest: "6".repeat(64),
          formatVersion: "1.0.0",
          identityKind: "provider-subject",
          providerKey: "prospeo-person-search",
          secretVersion: "privacy-v1",
        },
        {
          algorithm: "hmac-sha-256",
          digest: "6".repeat(64),
          formatVersion: "1.0.0",
          identityKind: "provider-subject",
          providerKey: "prospeo-person-search",
          secretVersion: "privacy-v1",
        },
      ],
    };
    await assert.rejects(
      persistence.prepare(scope, {
        ...generatedInput,
        idempotencyKey: idempotencyKey(
          "prepare-generated-export-delivery-without-subject"
        ),
        subjectKeys: [],
      }),
      EXPORT_DELIVERY_INPUT_INVALID
    );
    const generatedPrepared = await persistence.prepare(scope, generatedInput);
    assert.equal(generatedPrepared.status, "prepared");
    if (generatedPrepared.status === "prepared") {
      assert.equal(
        generatedPrepared.delivery.effectiveExpiresAt,
        instant(5000)
      );
      assert.equal(
        "manifestVersion" in generatedPrepared.delivery.manifest
          ? generatedPrepared.delivery.manifest.manifestVersion
          : undefined,
        "2.0.0"
      );
    }
    const generatedReadback = await sql<
      readonly {
        capability_id: string;
        effective_expires_at: Date;
        manifest_version: string;
        source_kind: string;
        subject_count: string;
      }[]
    >`
      SELECT
        delivery.capability_id,
        delivery.effective_expires_at,
        delivery.manifest_version,
        delivery.source_kind,
        (
          SELECT count(*)::text
          FROM kurobara_core.export_delivery_subject_keys AS subject_key
          WHERE subject_key.workspace_id = delivery.workspace_id
            AND subject_key.delivery_id = delivery.delivery_id
        ) AS subject_count
      FROM kurobara_core.export_deliveries AS delivery
      WHERE delivery.workspace_id = ${workspace}
        AND delivery.delivery_id = ${generatedDeliveryId}
    `;
    assert.deepEqual(generatedReadback[0], {
      capability_id: "contacts.work-email.resolve",
      effective_expires_at: new Date(5000),
      manifest_version: "2.0.0",
      source_kind: "generated-dataset",
      subject_count: "1",
    });

    await assert.rejects(
      sql`
          UPDATE kurobara_core.export_deliveries
          SET format = 'jsonl'
          WHERE workspace_id = ${workspace}
            AND delivery_id = ${deliveryId}
        `,
      APPEND_ONLY
    );
    await assert.rejects(
      sql`
        DELETE FROM kurobara_core.export_delivery_subject_keys
        WHERE workspace_id = ${workspace}
          AND delivery_id = ${generatedDeliveryId}
      `,
      APPEND_ONLY
    );
    await assert.rejects(
      sql`
          DELETE FROM kurobara_core.export_delivery_events
          WHERE workspace_id = ${workspace}
            AND delivery_id = ${deliveryId}
        `,
      APPEND_ONLY
    );
  } finally {
    if (sql !== undefined) {
      await sql.end({ timeout: 5 });
    }
    await admin`DROP DATABASE IF EXISTS ${admin(databaseName)} WITH (FORCE)`;
    await admin.end({ timeout: 5 });
  }
});

test("rolls an existing v1 delivery forward without rewriting its immutable manifest", {
  skip: adminUrl === undefined,
}, async () => {
  if (adminUrl === undefined) {
    return;
  }
  const databaseName = `kurobara_export_delivery_roll_forward_${process.pid}_${Date.now()}`;
  const databaseUrl = new URL(adminUrl);
  databaseUrl.pathname = `/${databaseName}`;
  const admin = postgres(adminUrl, { max: 1 });
  let sql: ReturnType<typeof postgres> | undefined;
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
      .filter(
        (name) =>
          MIGRATION_FILE_PATTERN.test(name) &&
          name < "0030_contact_export_delivery_lifecycle.sql"
      )
      .sort();
    assert.equal(
      migrationNames.at(-1),
      "0029_contact_derived_dataset_lineage.sql"
    );
    for (const migrationName of migrationNames) {
      const source = await readFile(
        new URL(migrationName, migrationsUrl),
        "utf8"
      );
      await sql.unsafe(source);
      await sql`
          INSERT INTO kurobara_core.schema_migrations (
            migration_name,
            checksum
          ) VALUES (
            ${migrationName},
            ${createHash("sha256").update(source).digest("hex")}
          )
        `;
    }
    await sql`
        INSERT INTO kurobara_core.workspaces (workspace_id)
        VALUES (${workspace})
      `;
    await sql`
        INSERT INTO kurobara_core.export_deliveries (
          workspace_id,
          delivery_id,
          owner_actor_id,
          intent_hash,
          application_id,
          dataset_id,
          recipe_id,
          recipe_revision,
          format,
          content_hash,
          content_length,
          manifest,
          prepared_at
        ) VALUES (
          ${workspace},
          ${deliveryId},
          ${owner},
          ${intentHash},
          ${manifest.applicationId},
          ${manifest.datasetId},
          ${manifest.recipeId},
          ${manifest.recipeRevision},
          ${manifest.format},
          ${manifest.contentHash},
          ${manifest.contentLength},
          ${sql.json(manifest)},
          ${new Date(2000)}
        )
      `;
    const serializedBefore = (
      await sql<readonly { manifest_text: string }[]>`
          SELECT manifest::text AS manifest_text
          FROM kurobara_core.export_deliveries
          WHERE workspace_id = ${workspace}
            AND delivery_id = ${deliveryId}
        `
    )[0]?.manifest_text;

    await applyPostgresMigrations(sql);

    const rolledForward = await createPostgresExportDeliveryPersistence(
      sql
    ).getOwned(scope, deliveryId, owner);
    assert.equal(rolledForward?.effectiveExpiresAt, instant(5000));
    assert.equal(rolledForward?.state, "prepared");
    const readback = await sql<
      readonly {
        effective_expires_at: Date;
        latest_migration: string;
        manifest_text: string;
        manifest_version: string;
        source_kind: string;
      }[]
    >`
        SELECT
          delivery.effective_expires_at,
          (
            SELECT migration_name
            FROM kurobara_core.schema_migrations
            ORDER BY migration_name DESC
            LIMIT 1
          ) AS latest_migration,
          delivery.manifest::text AS manifest_text,
          delivery.manifest_version,
          delivery.source_kind
        FROM kurobara_core.export_deliveries AS delivery
        WHERE delivery.workspace_id = ${workspace}
          AND delivery.delivery_id = ${deliveryId}
      `;
    assert.deepEqual(readback[0], {
      effective_expires_at: new Date(5000),
      latest_migration: "0031_gtm_context_play_workbook.sql",
      manifest_text: serializedBefore,
      manifest_version: "1.0.0",
      source_kind: "recipe-application",
    });
  } finally {
    if (sql !== undefined) {
      await sql.end({ timeout: 5 });
    }
    await admin`DROP DATABASE IF EXISTS ${admin(databaseName)} WITH (FORCE)`;
    await admin.end({ timeout: 5 });
  }
});
