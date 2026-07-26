import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  actorId,
  contentHash,
  datasetId,
  enrichmentRecipeId,
  type Field,
  fieldId,
  idempotencyKey,
  instant,
  recordId,
  succeed,
  workflowSpecId,
  workspaceId,
} from "@kurobara/kernel";
import type {
  CompleteExportDeliveryResult,
  DatasetEncodeEvent,
  ExportDelivery,
  ExportDeliveryPersistencePort,
  PrepareExportDeliveryResult as PersistencePrepareResult,
  RevokeExportDeliveryResult as PersistenceRevokeResult,
  RecipeApplication,
  VerifiedApiKey,
  WorkspaceScope,
} from "@kurobara/ports";

import {
  ExportDeliveryInvariantError,
  makeGetExportDelivery,
  makePrepareExportDelivery,
  makeRevokeExportDelivery,
  type PrepareExportDeliveryDependencies,
} from "../src/export-delivery.ts";
import type { RecipeApplicationExport } from "../src/export-recipe-application.ts";

const workspace = workspaceId("workspace-export-delivery");
const actor: VerifiedApiKey = {
  actorId: actorId("actor-export-delivery"),
  authenticationMode: "api-key",
  credentialId: "credential-export-delivery",
  permissions: ["contacts:export", "recipes:export"],
  workspaceId: workspace,
};
const datasetIdentity = datasetId("dataset-export-delivery");
const nameField: Field = {
  datasetId: datasetIdentity,
  fieldId: fieldId("field-contact-name"),
  key: "contact_name",
  label: "Contact name",
  valueType: "string",
  workspaceId: workspace,
};
const emailField: Field = {
  datasetId: datasetIdentity,
  fieldId: fieldId("field-work-email"),
  key: "work_email",
  label: "Work email",
  valueType: "string",
  workspaceId: workspace,
};
const recipeIdentity = enrichmentRecipeId("recipe-work-email");
const application: RecipeApplication = {
  createdAt: instant(500),
  datasetId: datasetIdentity,
  graph: { recordIds: [recordId("contact-1"), recordId("contact-2")] },
  graphHash: contentHash(`sha256:${"a".repeat(64)}`),
  intentHash: contentHash(`sha256:${"b".repeat(64)}`),
  maxCells: 2,
  recipeApplicationId: "application-work-email",
  recipeId: recipeIdentity,
  recipeRevision: "recipe-v1",
  targetFieldId: emailField.fieldId,
  workspaceId: workspace,
};
const chunks = [
  new TextEncoder().encode("contact_name,work_email\nSynthetic One,"),
  new TextEncoder().encode(
    "one@example.invalid\nSynthetic Two,two@example.invalid\n"
  ),
] as const;
const bytes = Buffer.concat(chunks);
const exported = (): RecipeApplicationExport => ({
  application,
  contentHash: contentHash(
    `sha256:${createHash("sha256").update(bytes).digest("hex")}`
  ),
  contentLength: bytes.byteLength,
  dataset: {
    datasetId: datasetIdentity,
    name: "Synthetic contacts",
    workspaceId: workspace,
  },
  events: {
    async *[Symbol.asyncIterator](): AsyncIterator<DatasetEncodeEvent> {
      await Promise.resolve();
      for (const chunk of chunks) {
        yield { bytes: chunk, type: "chunk" };
      }
    },
  },
  fields: [nameField, emailField],
  format: "csv",
  recipe: {
    datasetId: datasetIdentity,
    enrichmentRecipeId: recipeIdentity,
    inputFieldIds: [nameField.fieldId],
    name: "Resolve selected work email",
    recipeRevision: "recipe-v1",
    targetFieldId: emailField.fieldId,
    workflowContentHash: contentHash(`sha256:${"c".repeat(64)}`),
    workflowRevision: "workflow-v1",
    workflowSpecId: workflowSpecId("workflow-work-email"),
    workspaceId: workspace,
  },
});

const generatedExported = () => {
  const base = exported();
  return {
    contentHash: base.contentHash,
    contentLength: base.contentLength,
    dataset: base.dataset,
    events: base.events,
    fields: base.fields,
    format: base.format,
    recordCount: 2,
    source: {
      capabilityId: "contacts.discover",
      capabilityVersion: "1.0.0",
      generationId: "generation-export-delivery",
      generationPlanId: "generation-plan-export-delivery",
      kind: "generated-dataset" as const,
      planHash: contentHash(`sha256:${"d".repeat(64)}`),
    },
  };
};

class MemoryExportDeliveries implements ExportDeliveryPersistencePort {
  completeCalls = 0;
  deliveries = new Map<string, ExportDelivery>();
  preparedInputs: Parameters<ExportDeliveryPersistencePort["prepare"]>[1][] =
    [];
  requests = new Map<string, string>();
  subjectRestricted = false;

  complete(
    scope: WorkspaceScope,
    input: Parameters<ExportDeliveryPersistencePort["complete"]>[1]
  ): Promise<CompleteExportDeliveryResult> {
    this.completeCalls += 1;
    const delivery = this.deliveries.get(input.deliveryId);
    if (
      delivery === undefined ||
      delivery.manifest.workspaceId !== scope.workspaceId ||
      delivery.manifest.ownerActorId !== input.ownerActorId
    ) {
      return Promise.resolve({ status: "not-found-or-owner-mismatch" });
    }
    if (delivery.state === "revoked") {
      return Promise.resolve({ delivery, status: "revoked" });
    }
    if (
      delivery.manifest.contentHash !== input.contentHash ||
      delivery.manifest.contentLength !== input.contentLength
    ) {
      return Promise.resolve({ status: "proof-conflict" });
    }
    const completed: ExportDelivery = {
      ...delivery,
      deliveredAt: input.deliveredAt,
      state: "delivered",
    };
    this.deliveries.set(input.deliveryId, completed);
    return Promise.resolve({
      delivery: completed,
      replayed: delivery.state === "delivered",
      status: "delivered",
    });
  }

  getOwned(
    scope: WorkspaceScope,
    deliveryId: string,
    ownerActorId: typeof actor.actorId
  ): Promise<ExportDelivery | undefined> {
    const delivery = this.deliveries.get(deliveryId);
    return Promise.resolve(
      delivery?.manifest.workspaceId === scope.workspaceId &&
        delivery.manifest.ownerActorId === ownerActorId
        ? delivery
        : undefined
    );
  }

  prepare(
    scope: WorkspaceScope,
    input: Parameters<ExportDeliveryPersistencePort["prepare"]>[1]
  ): Promise<PersistencePrepareResult> {
    this.preparedInputs.push(input);
    if (this.subjectRestricted) {
      return Promise.resolve({ status: "subject-restricted" });
    }
    const existingIntent = this.requests.get(input.idempotencyKey);
    if (
      existingIntent !== undefined &&
      existingIntent !== input.delivery.intentHash
    ) {
      return Promise.resolve({ status: "idempotency-conflict" });
    }
    this.requests.set(input.idempotencyKey, input.delivery.intentHash);
    const existing = this.deliveries.get(input.delivery.deliveryId);
    if (existing !== undefined) {
      return Promise.resolve(
        existing.state === "revoked"
          ? { delivery: existing, status: "revoked" }
          : { delivery: existing, replayed: true, status: "prepared" }
      );
    }
    if (input.delivery.manifest.workspaceId !== scope.workspaceId) {
      throw new Error(
        "The prepared delivery must belong to the active workspace."
      );
    }
    const delivery: ExportDelivery = {
      ...input.delivery,
      state: "prepared",
    };
    this.deliveries.set(delivery.deliveryId, delivery);
    return Promise.resolve({ delivery, replayed: false, status: "prepared" });
  }

  revoke(
    scope: WorkspaceScope,
    input: Parameters<ExportDeliveryPersistencePort["revoke"]>[1]
  ): Promise<PersistenceRevokeResult> {
    const delivery = this.deliveries.get(input.deliveryId);
    if (
      delivery === undefined ||
      delivery.manifest.workspaceId !== scope.workspaceId ||
      delivery.manifest.ownerActorId !== input.ownerActorId
    ) {
      return Promise.resolve({ status: "not-found-or-owner-mismatch" });
    }
    const revoked: ExportDelivery = {
      ...delivery,
      revokedAt: delivery.revokedAt ?? input.revokedAt,
      state: "revoked",
    };
    this.deliveries.set(input.deliveryId, revoked);
    return Promise.resolve({
      delivery: revoked,
      replayed: delivery.state === "revoked",
      status: "revoked",
    });
  }
}

const makeHarness = () => {
  const persistence = new MemoryExportDeliveries();
  let tombstoned = false;
  let now = instant(1000);
  const authorizeContactEffect: PrepareExportDeliveryDependencies["authorizeContactEffect"] =
    () =>
      Promise.resolve(
        succeed({
          decision: {
            allowed: !tombstoned,
            deniedDataClasses: tombstoned
              ? (["professional-email"] as const)
              : [],
            policyVersion: "privacy-v1",
            reasonCodes: tombstoned
              ? (["privacy-tombstone"] as const)
              : (["allowed"] as const),
            retentionLimits: [
              {
                dataClass: "contact-identity" as const,
                expiresAt: instant(3000),
                maxRetentionMilliseconds: 2500,
              },
              {
                dataClass: "professional-email" as const,
                expiresAt: instant(3000),
                maxRetentionMilliseconds: 2500,
              },
            ],
            stopExternalEffects: tombstoned,
            stopFallback: tombstoned,
          },
          matchedTombstoneIds: tombstoned ? ["privacy-ts-synthetic"] : [],
        })
      );
  const dependencies = {
    authorizeContactEffect,
    clock: { now: () => Promise.resolve(now) },
    persistence,
  };
  const request = {
    actor,
    exported: exported(),
    idempotencyKey: idempotencyKey("export-delivery-request"),
    privacy: {
      facts: {
        activeRestrictions: [],
        explicitlyEnabledDataClasses: [],
        purposeRef: "synthetic-evaluation",
        requestedData: [
          { dataClass: "contact-identity" as const, observedAt: instant(500) },
          {
            dataClass: "professional-email" as const,
            observedAt: instant(500),
          },
        ],
        territory: "ES",
      },
      policy: {
        expiresAt: instant(4000),
        purposeRefs: ["synthetic-evaluation"],
        rules: {
          "contact-identity": {
            allowedActions: ["export"] as const,
            maxRetentionMilliseconds: 2500,
          },
          "professional-email": {
            allowedActions: ["export"] as const,
            maxRetentionMilliseconds: 2500,
          },
        },
        territories: ["ES"],
        version: "privacy-v1",
      },
      subjects: [
        {
          kind: "provider-subject" as const,
          providerKey: "synthetic-fixture",
          value: "subject-one",
        },
        {
          kind: "provider-subject" as const,
          providerKey: "synthetic-fixture",
          value: "subject-two",
        },
      ],
    },
    providerRights: {
      authorized: true,
      expiresAt: instant(3500),
      mode: "synthetic-fixture" as const,
      version: "fixture-rights-v1",
    },
  };
  return {
    dependencies,
    persistence,
    request,
    setNow: (value: number) => {
      now = instant(value);
    },
    tombstone: () => {
      tombstoned = true;
    },
  };
};

test("records an audit-safe manifest and marks delivery only after complete verified consumption", async () => {
  const harness = makeHarness();
  const prepare = makePrepareExportDelivery(harness.dependencies);
  const result = await prepare(harness.request);
  assert.equal(result.ok, true);
  if (!result.ok) {
    return;
  }
  assert.equal(result.value.delivery.state, "prepared");
  assert.equal(harness.persistence.completeCalls, 0);
  const serialized = JSON.stringify(result.value.delivery.manifest);
  assert.equal(serialized.includes("subject-one"), false);
  assert.equal(serialized.includes("subject-two"), false);
  assert.equal(serialized.includes("synthetic@example.invalid"), false);

  const delivered: Uint8Array[] = [];
  for await (const event of result.value.events) {
    assert.equal(event.type, "chunk");
    if (event.type === "chunk") {
      delivered.push(event.bytes);
    }
  }
  assert.equal(Buffer.concat(delivered).equals(bytes), true);
  assert.equal(harness.persistence.completeCalls, 1);
  assert.equal(
    harness.persistence.deliveries.get(result.value.delivery.deliveryId)?.state,
    "delivered"
  );
});

test("does not mark a delivery when the consumer stops before the verified EOF", async () => {
  const harness = makeHarness();
  const result = await makePrepareExportDelivery(harness.dependencies)(
    harness.request
  );
  assert.equal(result.ok, true);
  if (!result.ok) {
    return;
  }
  const iterator = result.value.events[Symbol.asyncIterator]();
  const first = await iterator.next();
  assert.equal(first.done, false);
  assert.equal(harness.persistence.completeCalls, 0);
  await iterator.return?.();
  assert.equal(harness.persistence.completeCalls, 0);
});

test("records delivery only after the consumer requests EOF after the final byte", async () => {
  const harness = makeHarness();
  const result = await makePrepareExportDelivery(harness.dependencies)(
    harness.request
  );
  assert.equal(result.ok, true);
  if (!result.ok) {
    return;
  }
  const iterator = result.value.events[Symbol.asyncIterator]();
  assert.equal((await iterator.next()).done, false);
  assert.equal((await iterator.next()).done, false);
  assert.equal(harness.persistence.completeCalls, 0);
  assert.equal((await iterator.next()).done, true);
  assert.equal(harness.persistence.completeCalls, 1);
});

test("a durable tombstone denies an idempotent replay before persistence", async () => {
  const harness = makeHarness();
  const prepare = makePrepareExportDelivery(harness.dependencies);
  const first = await prepare(harness.request);
  assert.equal(first.ok, true);
  const requestCount = harness.persistence.requests.size;
  harness.tombstone();
  const replay = await prepare({ ...harness.request, exported: exported() });
  assert.equal(replay.ok, false);
  if (!replay.ok) {
    assert.equal(replay.error.code, "privacy-authorization-denied");
  }
  assert.equal(harness.persistence.requests.size, requestCount);
});

test("maps a restriction that wins the persistence race to a safe denial", async () => {
  const harness = makeHarness();
  harness.persistence.subjectRestricted = true;

  const result = await makePrepareExportDelivery(harness.dependencies)(
    harness.request
  );

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, "privacy-authorization-denied");
  }
  assert.equal(harness.persistence.deliveries.size, 0);
});

test("revocation blocks a future delivery without claiming deletion of prior copies", async () => {
  const harness = makeHarness();
  const prepared = await makePrepareExportDelivery(harness.dependencies)(
    harness.request
  );
  assert.equal(prepared.ok, true);
  if (!prepared.ok) {
    return;
  }
  const revoked = await makeRevokeExportDelivery(harness.dependencies)({
    actor,
    deliveryId: prepared.value.delivery.deliveryId,
  });
  assert.equal(revoked.ok, true);
  await assert.rejects(async () => {
    for await (const _event of prepared.value.events) {
      // Consume only to assert the registry guard rejects before bytes.
    }
  }, ExportDeliveryInvariantError);
  assert.equal(harness.persistence.completeCalls, 0);
});

test("expired provider rights fail closed before manifest persistence", async () => {
  const harness = makeHarness();
  const result = await makePrepareExportDelivery(harness.dependencies)({
    ...harness.request,
    providerRights: {
      ...harness.request.providerRights,
      expiresAt: instant(1000),
    },
  });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, "provider-rights-denied");
  }
  assert.equal(harness.persistence.deliveries.size, 0);
});

test("does not record delivery when authorization expires after the final byte but before EOF", async () => {
  const harness = makeHarness();
  const result = await makePrepareExportDelivery(harness.dependencies)(
    harness.request
  );
  assert.equal(result.ok, true);
  if (!result.ok) {
    return;
  }
  const iterator = result.value.events[Symbol.asyncIterator]();
  assert.equal((await iterator.next()).done, false);
  assert.equal((await iterator.next()).done, false);
  harness.setNow(3500);
  await assert.rejects(iterator.next(), ExportDeliveryInvariantError);
  assert.equal(harness.persistence.completeCalls, 0);
  assert.equal(
    harness.persistence.deliveries.get(result.value.delivery.deliveryId)?.state,
    "prepared"
  );
});

test("rejects an unsafe content length and duplicate field proof before persistence", async () => {
  const harness = makeHarness();
  const unsafeLength = await makePrepareExportDelivery(harness.dependencies)({
    ...harness.request,
    exported: {
      ...exported(),
      contentLength: Number.MAX_SAFE_INTEGER + 1,
    },
  });
  assert.equal(unsafeLength.ok, false);
  if (!unsafeLength.ok) {
    assert.equal(unsafeLength.error.code, "export-scope-invalid");
  }

  const duplicateField = await makePrepareExportDelivery(harness.dependencies)({
    ...harness.request,
    exported: {
      ...exported(),
      fields: [nameField, nameField],
    },
  });
  assert.equal(duplicateField.ok, false);
  if (!duplicateField.ok) {
    assert.equal(duplicateField.error.code, "export-scope-invalid");
  }
  assert.equal(harness.persistence.deliveries.size, 0);
});

test("revocation after the final byte wins before the EOF completion transition", async () => {
  const harness = makeHarness();
  const prepared = await makePrepareExportDelivery(harness.dependencies)(
    harness.request
  );
  assert.equal(prepared.ok, true);
  if (!prepared.ok) {
    return;
  }
  const iterator = prepared.value.events[Symbol.asyncIterator]();
  assert.equal((await iterator.next()).done, false);
  assert.equal((await iterator.next()).done, false);
  const revoked = await makeRevokeExportDelivery(harness.dependencies)({
    actor,
    deliveryId: prepared.value.delivery.deliveryId,
  });
  assert.equal(revoked.ok, true);
  await assert.rejects(iterator.next(), ExportDeliveryInvariantError);
  assert.equal(harness.persistence.completeCalls, 1);
  assert.equal(
    harness.persistence.deliveries.get(prepared.value.delivery.deliveryId)
      ?.state,
    "revoked"
  );
});

test("binds a generated Contact delivery to its lineage and restricted subject keys", async () => {
  const harness = makeHarness();
  const result = await makePrepareExportDelivery({
    ...harness.dependencies,
    subjectKeys: {
      derive: (subject) =>
        Promise.resolve({
          all: [
            {
              algorithm: "hmac-sha-256",
              digest:
                subject.value === "subject-one"
                  ? "1".repeat(64)
                  : "2".repeat(64),
              formatVersion: "1.0.0",
              identityKind: subject.kind,
              ...(subject.kind === "provider-subject"
                ? { providerKey: subject.providerKey }
                : {}),
              secretVersion: "v2",
            },
          ],
          current: {
            algorithm: "hmac-sha-256",
            digest:
              subject.value === "subject-one" ? "1".repeat(64) : "2".repeat(64),
            formatVersion: "1.0.0",
            identityKind: subject.kind,
            ...(subject.kind === "provider-subject"
              ? { providerKey: subject.providerKey }
              : {}),
            secretVersion: "v2",
          },
        }),
    },
  })({
    ...harness.request,
    exported: generatedExported(),
  });

  assert.equal(result.ok, true);
  if (!result.ok) {
    return;
  }
  assert.equal("source" in result.value.delivery.manifest, true);
  if ("source" in result.value.delivery.manifest) {
    assert.equal(result.value.delivery.manifest.manifestVersion, "2.0.0");
    assert.equal(
      result.value.delivery.manifest.source.generationId,
      "generation-export-delivery"
    );
  }
  assert.equal(harness.persistence.preparedInputs[0]?.subjectKeys?.length, 2);
  const serialized = JSON.stringify(result.value.delivery);
  assert.equal(serialized.includes("subject-one"), false);
  assert.equal(serialized.includes("subject-two"), false);
});

test("reports an expired delivery without deleting its durable audit proof", async () => {
  const harness = makeHarness();
  const prepared = await makePrepareExportDelivery(harness.dependencies)(
    harness.request
  );
  assert.equal(prepared.ok, true);
  if (!prepared.ok) {
    return;
  }
  harness.setNow(3000);
  const result = await makeGetExportDelivery({
    clock: harness.dependencies.clock,
    persistence: harness.persistence,
    requiredPermission: "contacts:export",
  })({
    actor,
    deliveryId: prepared.value.delivery.deliveryId,
  });

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.value.state, "expired");
    assert.equal(result.value.delivery.state, "prepared");
  }
});
