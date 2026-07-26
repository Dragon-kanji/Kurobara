import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  createCsvDatasetCodec,
  createJsonlDatasetCodec,
} from "@kurobara/adapter-dataset-codec";
import {
  createHttpApp,
  type HttpAdapterDependencies,
} from "@kurobara/adapter-http";
import { createPostgresRuntime } from "@kurobara/adapter-postgres";
import {
  createContactExportPolicyResolver,
  createContactPrivacyTombstoneGuard,
  createHmacContactPrivacySubjectKeyDeriver,
  makeAuthorizeContactEffect,
  makeExportDataset,
  makeGetExportDelivery,
  makePrepareExportDelivery,
  makeRestrictContactPrivacy,
  makeRevokeExportDelivery,
} from "@kurobara/application";
import {
  actorId,
  contentHash,
  createDataset,
  createDatasetMaterialization,
  createField,
  createRecord,
  datasetGenerationId,
  datasetId,
  datasetMaterializationId,
  fieldId,
  instant,
  recordId,
  workspaceId,
} from "@kurobara/kernel";
import { createKurobaraClient, KurobaraProblemError } from "@kurobara/sdk";
import postgres from "postgres";

const adminUrl = process.env.KUROBARA_TEST_POSTGRES_URL;
const now = instant(1_900_000_000_000);
const workspace = workspaceId("workspace-http-sdk-contact-export");
const owner = actorId("actor-http-sdk-contact-export");
const datasetIdentifier = datasetId("dataset-http-sdk-contact-export");
const generationIdentifier = datasetGenerationId(
  "generation-http-sdk-contact-export"
);
const generationPlanIdentifier = "generation-plan-http-sdk-contact-export";
const providerKey = "synthetic-contact-provider";
const providerSubject = "provider-subject-http-sdk-contact-export";
const emailSubject = "contact-export@example.invalid";

const hash = (value: string) =>
  contentHash(`sha256:${createHash("sha256").update(value).digest("hex")}`);

const datasetResult = createDataset({
  datasetId: datasetIdentifier,
  name: "Synthetic generated Contact export",
  workspaceId: workspace,
});
if (!datasetResult.ok) {
  throw new Error(datasetResult.error.message);
}
const contactDataset = datasetResult.value;

const contactFieldInputs = [
  ["department", "Department", "string"],
  ["display_name", "Display name", "string"],
  ["first_name", "First name", "string"],
  ["identity_completeness", "Identity completeness", "string"],
  ["identity_observed_at_ms", "Identity observed at", "number"],
  ["identity_status", "Identity status", "string"],
  ["job_title", "Job title", "string"],
  ["last_name", "Last name", "string"],
  ["observed_at_ms", "Employment observed at", "number"],
  ["organization_domain", "Organization domain", "string"],
  ["organization_id", "Organization ID", "string"],
  ["organization_name", "Organization name", "string"],
  ["person_country_code", "Person country", "string"],
  ["profile_url", "Profile URL", "string"],
  ["seniority", "Seniority", "string"],
  ["work_email", "Work email", "string"],
  ["work_email_confidence", "Work email confidence", "number"],
  ["work_email_observed_at_ms", "Work email observed at", "number"],
  ["work_email_source", "Work email source", "string"],
  ["work_email_status", "Work email status", "string"],
  ["work_email_verification", "Work email verification", "string"],
] as const;

const contactFields = contactFieldInputs.map(([key, label, valueType]) => {
  const result = createField(contactDataset, {
    datasetId: datasetIdentifier,
    fieldId: fieldId(`contact-${key}`),
    key,
    label,
    valueType,
    workspaceId: workspace,
  });
  if (!result.ok) {
    throw new Error(result.error.message);
  }
  return result.value;
});

const values = {
  department: "Executive",
  display_name: "Synthetic Contact",
  first_name: "Synthetic",
  identity_completeness: "full",
  identity_observed_at_ms: now - 9000,
  identity_status: "found",
  job_title: "Founder",
  last_name: "Contact",
  observed_at_ms: now - 10_000,
  organization_domain: "example.invalid",
  organization_id: "organization-http-sdk-contact-export",
  organization_name: "Synthetic Organization",
  person_country_code: "ES",
  profile_url: "https://example.invalid/contact/synthetic",
  seniority: "owner",
  work_email: emailSubject,
  work_email_confidence: 0.99,
  work_email_observed_at_ms: now - 8000,
  work_email_source: "provider_unspecified",
  work_email_status: "found",
  work_email_verification: "valid",
} as const;

const recordResult = createRecord(contactDataset, contactFields, {
  datasetId: datasetIdentifier,
  recordId: recordId("record-http-sdk-contact-export"),
  values: contactFields.map((field) => ({
    fieldId: field.fieldId,
    value: values[field.key as keyof typeof values],
  })),
  workspaceId: workspace,
});
if (!recordResult.ok) {
  throw new Error(recordResult.error.message);
}
const contactRecord = recordResult.value;
const schemaHash = hash("http-sdk-contact-export-schema");
const materializationHash = hash("http-sdk-contact-export-materialization");
const recordHash = hash("http-sdk-contact-export-record");
const planHash = hash("http-sdk-contact-export-plan");
const queryHash = hash("http-sdk-contact-export-query");
const requestIntentHash = hash("http-sdk-contact-export-intent");

const materializationResult = createDatasetMaterialization({
  completedAt: instant(now - 1000),
  completionReason: "source-completed",
  contentHash: materializationHash,
  coverage: {
    basis: "locked_provider_route",
    status: "complete_for_declared_source",
  },
  createdAt: instant(now - 20_000),
  datasetId: datasetIdentifier,
  materializationId: datasetMaterializationId(datasetIdentifier),
  origin: {
    generationId: generationIdentifier,
    kind: "generation",
  },
  recordCount: 1,
  rejectedCount: 0,
  revision: 3,
  schemaHash,
  state: "ready",
  workspaceId: workspace,
});
if (!materializationResult.ok) {
  throw new Error(materializationResult.error.message);
}
const contactMaterialization = materializationResult.value;

const generation = {
  aggregateVersion: 4,
  capability: {
    capabilityId: "contacts.work-email.resolve",
    capabilityVersion: "1.0.0",
  },
  cost: { reserved: 0, spent: 1, unit: "credits" },
  counters: {
    accepted: 1,
    calls: 1,
    duplicates: 0,
    pages: 1,
    rejected: 0,
    returned: 1,
  },
  createdAt: now - 20_000,
  datasetId: datasetIdentifier,
  generationId: generationIdentifier,
  generationPlanId: generationPlanIdentifier,
  lastPageSequence: 1,
  lockedProvider: providerKey,
  materializationId: datasetIdentifier,
  planHash,
  queryHash,
  requestIntentHash,
  schemaHash,
  state: "completed",
  workspaceId: workspace,
} as const;

const subjectKeys = createHmacContactPrivacySubjectKeyDeriver([
  {
    current: false,
    keyMaterial: new Uint8Array(32).fill(17),
    version: "privacy-hmac-v1",
  },
  {
    current: true,
    keyMaterial: new Uint8Array(32).fill(34),
    version: "privacy-hmac-v2",
  },
]);

const contactPolicy = createContactExportPolicyResolver({
  maxRetentionMilliseconds: {
    "contact-identity": 3_600_000,
    employment: 3_600_000,
    "professional-email": 3_600_000,
    "professional-social-profile": 3_600_000,
  },
  policyTtlMilliseconds: 7_200_000,
  policyVersion: "contact-export-policy-v1",
  providerRights: {
    [providerKey]: {
      mode: "synthetic-fixture",
      ttlMilliseconds: 5_400_000,
      version: "synthetic-provider-rights-v1",
    },
  },
  purposeRef: "synthetic-http-sdk-export",
  territory: "ES",
});

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

const seedGeneratedContact = async (
  sql: ReturnType<typeof postgres>
): Promise<void> => {
  await sql.begin(async (transaction) => {
    const scoped = transaction as unknown as ReturnType<typeof postgres>;
    await scoped`SET LOCAL session_replication_role = replica`;
    await scoped`
      INSERT INTO kurobara_core.workspaces (workspace_id)
      VALUES (${workspace})
    `;
    await scoped`
      INSERT INTO kurobara_core.datasets (
        workspace_id,
        dataset_id,
        name,
        schema_hash,
        dataset,
        created_at
      ) VALUES (
        ${workspace},
        ${datasetIdentifier},
        ${contactDataset.name},
        ${schemaHash},
        ${scoped.json(contactDataset)},
        ${new Date(now - 20_000)}
      )
    `;
    for (const [ordinal, field] of contactFields.entries()) {
      await scoped`
        INSERT INTO kurobara_core.dataset_fields (
          workspace_id,
          dataset_id,
          field_id,
          ordinal,
          field_key,
          label,
          value_type,
          field,
          created_at
        ) VALUES (
          ${workspace},
          ${datasetIdentifier},
          ${field.fieldId},
          ${ordinal},
          ${field.key},
          ${field.label},
          ${field.valueType},
          ${scoped.json(field)},
          ${new Date(now - 20_000)}
        )
      `;
    }
    await scoped`
      INSERT INTO kurobara_core.dataset_generations (
        workspace_id,
        generation_id,
        generation_plan_id,
        dataset_id,
        materialization_id,
        plan_hash,
        query_hash,
        schema_hash,
        request_intent_hash,
        capability_id,
        capability_version,
        state,
        aggregate_version,
        accepted_count,
        call_count,
        duplicate_count,
        page_count,
        rejected_count,
        returned_count,
        cost_reserved,
        cost_spent,
        cost_unit,
        payload,
        created_at,
        locked_provider,
        last_committed_page_sequence
      ) VALUES (
        ${workspace},
        ${generationIdentifier},
        ${generationPlanIdentifier},
        ${datasetIdentifier},
        ${datasetIdentifier},
        ${planHash},
        ${queryHash},
        ${schemaHash},
        ${requestIntentHash},
        ${generation.capability.capabilityId},
        ${generation.capability.capabilityVersion},
        ${generation.state},
        ${generation.aggregateVersion},
        ${generation.counters.accepted},
        ${generation.counters.calls},
        ${generation.counters.duplicates},
        ${generation.counters.pages},
        ${generation.counters.rejected},
        ${generation.counters.returned},
        ${generation.cost.reserved},
        ${generation.cost.spent},
        ${generation.cost.unit},
        ${scoped.json(generation)},
        ${new Date(generation.createdAt)},
        ${providerKey},
        1
      )
    `;
    await scoped`
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
        completed_at,
        completion_reason,
        content_hash,
        coverage_basis,
        coverage_status,
        payload,
        created_at
      ) VALUES (
        ${workspace},
        ${datasetIdentifier},
        ${datasetIdentifier},
        ${schemaHash},
        'generation',
        ${generationIdentifier},
        'ready',
        ${contactMaterialization.revision},
        ${contactMaterialization.recordCount},
        ${contactMaterialization.rejectedCount},
        ${new Date(contactMaterialization.completedAt)},
        ${contactMaterialization.completionReason},
        ${materializationHash},
        ${contactMaterialization.coverage.basis},
        ${contactMaterialization.coverage.status},
        ${scoped.json(contactMaterialization)},
        ${new Date(contactMaterialization.createdAt)}
      )
    `;
    await scoped`
      INSERT INTO kurobara_core.dataset_records (
        workspace_id,
        dataset_id,
        record_id,
        import_id,
        batch_sequence,
        item_number,
        record_number,
        content_hash,
        record,
        materialization_id,
        record_ordinal,
        generation_id,
        page_sequence,
        candidate_position
      ) VALUES (
        ${workspace},
        ${datasetIdentifier},
        ${contactRecord.recordId},
        NULL,
        NULL,
        NULL,
        NULL,
        ${recordHash},
        ${scoped.json(contactRecord)},
        ${datasetIdentifier},
        1,
        ${generationIdentifier},
        1,
        1
      )
    `;
    await scoped`
      INSERT INTO kurobara_core.dataset_generation_record_lineage (
        workspace_id,
        dataset_id,
        record_id,
        generation_id,
        page_sequence,
        candidate_position,
        run_id,
        step_run_id,
        attempt_id,
        operation_key,
        routing_decision_id,
        reservation_id,
        artifact_id,
        result_manifest_id,
        usage_entry_id,
        provider_key,
        provider_subject_id,
        source_dataset_id,
        source_record_id
      ) VALUES (
        ${workspace},
        ${datasetIdentifier},
        ${contactRecord.recordId},
        ${generationIdentifier},
        1,
        1,
        'run-http-sdk-contact-export',
        'step-http-sdk-contact-export',
        'attempt-http-sdk-contact-export',
        'operation-http-sdk-contact-export',
        'route-http-sdk-contact-export',
        'reservation-http-sdk-contact-export',
        'artifact-http-sdk-contact-export',
        'manifest-http-sdk-contact-export',
        'usage-http-sdk-contact-export',
        ${providerKey},
        ${providerSubject},
        NULL,
        NULL
      )
    `;
  });
};

const unexpected = (): never => {
  throw new Error("Unexpected HTTP dependency call.");
};

// biome-ignore lint/style/noDoneCallback: Node supplies a TestContext here, not a completion callback.
test("tracks and revokes one generated Contact export through PostgreSQL, HTTP, and the SDK", async (context) => {
  if (adminUrl === undefined || adminUrl.trim().length === 0) {
    context.skip("KUROBARA_TEST_POSTGRES_URL is not configured.");
    return;
  }
  const databaseName = `kurobara_http_sdk_contact_export_${process.pid}_${Date.now()}`;
  const exactDatabaseUrl = databaseUrl(adminUrl, databaseName);
  const admin = postgres(adminUrl, { max: 1 });
  let runtime: ReturnType<typeof createPostgresRuntime> | undefined;
  let sql: ReturnType<typeof postgres> | undefined;
  let primaryError: unknown;
  let cleanupError: unknown;

  try {
    await admin`CREATE DATABASE ${admin(databaseName)}`;
    runtime = createPostgresRuntime(exactDatabaseUrl);
    await runtime.migrate();
    await runtime.verifyMigrations();
    sql = postgres(exactDatabaseUrl, { max: 2 });
    await seedGeneratedContact(sql);

    const clock = { now: () => Promise.resolve(now) };
    const privacyGuard = createContactPrivacyTombstoneGuard({
      persistence: runtime.contactPrivacy,
      subjectKeys,
    });
    const authorizeContactEffect = makeAuthorizeContactEffect({
      clock,
      persistence: runtime.contactPrivacy,
      subjectKeys,
    });
    const exportDeliveryDependencies = {
      authorizeContactEffect,
      clock,
      persistence: runtime.exportDeliveries,
      requiredPermission: "contacts:export",
      subjectKeys,
    };
    const exportDataset = makeExportDataset({
      codecs: {
        csv: createCsvDatasetCodec(),
        jsonl: createJsonlDatasetCodec(),
      },
      contactPrivacy: {
        clock,
        guard: privacyGuard,
        policy: contactPolicy,
        prepareDelivery: makePrepareExportDelivery(exportDeliveryDependencies),
        requiredPermission: "contacts:export",
        subjects: runtime.contactDatasetExportPrivacy,
      },
      datasets: runtime.datasets,
      maxExportBytes: 1024 * 1024,
      requiredPermission: "datasets:export",
    });
    const actor = {
      actorId: owner,
      authenticationMode: "api-key" as const,
      credentialId: "credential-http-sdk-contact-export",
      permissions: ["contacts:export", "contacts:privacy", "datasets:export"],
      workspaceId: workspace,
    };
    const dependencies = {
      applyRecipe: unexpected,
      authenticateApiKey: () => Promise.resolve({ ok: true, value: actor }),
      cancelRun: unexpected,
      createRun: unexpected,
      exportDataset,
      exportRecipeApplication: unexpected,
      getExportDelivery: makeGetExportDelivery(exportDeliveryDependencies),
      getRecipeApplicationStatus: unexpected,
      getRun: unexpected,
      importDataset: unexpected,
      listCapabilities: unexpected,
      listCompanyCandidates: unexpected,
      quoteRunPlan: unexpected,
      readiness: () => true,
      restrictContactPrivacy: makeRestrictContactPrivacy({
        clock,
        persistence: runtime.contactPrivacy,
        requiredPermission: "contacts:privacy",
        subjectKeys,
      }),
      revokeExportDelivery: makeRevokeExportDelivery(
        exportDeliveryDependencies
      ),
    } as unknown as HttpAdapterDependencies;
    const app = createHttpApp(dependencies);
    let exportHeaders:
      | Readonly<{
          deliveryId: string | null;
          expiresAt: string | null;
          state: string | null;
        }>
      | undefined;
    const client = createKurobaraClient({
      apiKey: "synthetic-api-key",
      baseUrl: "http://kurobara.invalid",
      fetch: async (input, init) => {
        const request = new Request(input, init);
        const path = new URL(request.url).pathname;
        const response = await app.request(request);
        if (path === "/v1/dataset-exports" && response.status === 200) {
          exportHeaders = {
            deliveryId: response.headers.get("x-kurobara-delivery-id"),
            expiresAt: response.headers.get(
              "x-kurobara-delivery-expires-at-ms"
            ),
            state: response.headers.get("x-kurobara-delivery-state"),
          };
        }
        return response;
      },
    });

    const exported = await client.datasets.export({
      dataset_id: datasetIdentifier,
      format: "jsonl",
    });
    assert.ok(exported.delivery);
    assert.deepEqual(exportHeaders, {
      deliveryId: exported.delivery.deliveryId,
      expiresAt: String(exported.delivery.expiresAtMs),
      state: "prepared",
    });
    assert.equal(exported.delivery.stateAtResponse, "prepared");
    const prepared = await client.exportDeliveries.get({
      delivery_id: exported.delivery.deliveryId,
    });
    assert.equal(prepared.state, "prepared");

    const chunks: Uint8Array[] = [];
    for await (const chunk of exported.bytes) {
      chunks.push(chunk);
    }
    const exportedText = new TextDecoder().decode(Buffer.concat(chunks));
    assert.equal(exportedText.includes(emailSubject), true);
    assert.equal(exportedText.includes(providerSubject), false);
    const delivered = await client.exportDeliveries.get({
      delivery_id: exported.delivery.deliveryId,
    });
    assert.equal(delivered.state, "delivered");
    assert.equal(delivered.delivered_at_ms, now);

    const restrictionRequest = {
      idempotency_key: "restrict-http-sdk-contact-export",
      reason: "operator-subject-request" as const,
      subject: { kind: "email" as const, value: emailSubject },
    };
    const restricted = await client.contactPrivacy.restrict(restrictionRequest);
    assert.equal(restricted.replayed, false);
    assert.equal(restricted.affected_delivery_count, 1);
    assert.equal(restricted.newly_revoked_delivery_count, 1);
    const revoked = await client.exportDeliveries.get({
      delivery_id: exported.delivery.deliveryId,
    });
    assert.equal(revoked.state, "revoked");
    assert.equal(revoked.revoked_at_ms, now);

    const replayed = await client.contactPrivacy.restrict(restrictionRequest);
    assert.equal(replayed.replayed, true);
    assert.equal(replayed.affected_delivery_count, 1);
    assert.equal(replayed.newly_revoked_delivery_count, 0);
    await assert.rejects(
      client.datasets.export({
        dataset_id: datasetIdentifier,
        format: "jsonl",
      }),
      (error: unknown) =>
        error instanceof KurobaraProblemError &&
        error.status === 403 &&
        error.problem.code === "authority-permission-missing"
    );

    const proofRows = await sql<
      readonly {
        delivery_alias_count: string;
        registration_count: string;
        revocation_event_count: string;
        revocation_proof_count: string;
        serialized_proofs: string;
        tombstone_alias_count: string;
        tombstone_count: string;
      }[]
    >`
      SELECT
        (
          SELECT count(*)::text
          FROM kurobara_core.export_delivery_subject_keys
          WHERE workspace_id = ${workspace}
            AND delivery_id = ${exported.delivery.deliveryId}
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
            AND delivery_id = ${exported.delivery.deliveryId}
            AND event_type = 'revoked'
        ) AS revocation_event_count,
        (
          SELECT count(*)::text
          FROM kurobara_core.export_delivery_revocation_proofs
          WHERE workspace_id = ${workspace}
            AND delivery_id = ${exported.delivery.deliveryId}
        ) AS revocation_proof_count,
        concat(
          coalesce((
            SELECT string_agg(row_to_json(request)::text, '')
            FROM kurobara_core.contact_privacy_registration_requests
              AS request
            WHERE request.workspace_id = ${workspace}
          ), ''),
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
    assert.deepEqual(proofRows[0], {
      delivery_alias_count: "4",
      registration_count: "1",
      revocation_event_count: "1",
      revocation_proof_count: "1",
      serialized_proofs: proofRows[0]?.serialized_proofs,
      tombstone_alias_count: "2",
      tombstone_count: "1",
    });
    const publicReceipts = JSON.stringify([
      exported.delivery,
      prepared,
      delivered,
      restricted,
      revoked,
      replayed,
    ]);
    assert.equal(publicReceipts.includes(emailSubject), false);
    assert.equal(publicReceipts.includes(providerSubject), false);
    assert.equal(proofRows[0]?.serialized_proofs.includes(emailSubject), false);
    assert.equal(
      proofRows[0]?.serialized_proofs.includes(providerSubject),
      false
    );
  } catch (error) {
    primaryError = error;
  } finally {
    const closeResults = await Promise.allSettled([
      runtime?.close(),
      sql?.end({ timeout: 5 }),
    ]);
    const dropResults = await Promise.allSettled([
      admin`DROP DATABASE IF EXISTS ${admin(databaseName)} WITH (FORCE)`,
    ]);
    const finalResults = await Promise.allSettled([admin.end({ timeout: 5 })]);
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
