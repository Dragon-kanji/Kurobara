import { createHash } from "node:crypto";

import {
  type ContactPrivacySubject,
  type ContactPrivacySubjectKey,
  contentHash,
  type Dataset,
  type DomainResult,
  type Field,
  fail,
  type IdempotencyKey,
  type Instant,
  instant,
  succeed,
  type WorkspaceId,
} from "@kurobara/kernel";
import {
  CONTACT_DATA_CLASSES,
  type ContactPrivacyFacts,
  type ContactPrivacyPolicySnapshot,
} from "@kurobara/policy-engine";
import type {
  ClockPort,
  ContactPrivacySubjectKeyDerivationPort,
  DatasetEncodeEvent,
  DatasetImportFormat,
  ExportDelivery,
  ExportDeliveryManifest,
  ExportDeliveryPersistencePort,
  ExportDeliveryProviderRightsSnapshot,
  GeneratedDatasetExportDeliverySource,
  VerifiedApiKey,
} from "@kurobara/ports";

import { canonicalContentHash } from "./canonical-content-hash.ts";
import type {
  AuthorizeContactEffectRequest,
  AuthorizeContactEffectResult,
} from "./contact-privacy.ts";
import type { RecipeApplicationExport } from "./export-recipe-application.ts";

export type ExportDeliveryProviderRightsAuthorization = Readonly<
  ExportDeliveryProviderRightsSnapshot & { authorized: boolean }
>;

export type ExportDeliveryPrivacyRequest = Readonly<{
  facts: Omit<ContactPrivacyFacts, "action" | "now">;
  policy: ContactPrivacyPolicySnapshot;
  subjectGroups?: readonly (readonly ContactPrivacySubject[])[];
  subjects: readonly ContactPrivacySubject[];
}>;

export type GeneratedDatasetDeliveryExport = Readonly<{
  contentHash: ReturnType<typeof contentHash>;
  contentLength: number;
  dataset: Dataset;
  events: AsyncIterable<DatasetEncodeEvent>;
  fields: readonly Field[];
  format: DatasetImportFormat;
  recordCount: number;
  source: GeneratedDatasetExportDeliverySource;
}>;

export type PrepareExportDeliveryRequest = Readonly<{
  actor: VerifiedApiKey;
  exported: GeneratedDatasetDeliveryExport | RecipeApplicationExport;
  idempotencyKey: IdempotencyKey;
  privacy: ExportDeliveryPrivacyRequest;
  providerRights: ExportDeliveryProviderRightsAuthorization;
}>;

export type PrepareExportDeliveryFailureCode =
  | "delivery-idempotency-conflict"
  | "delivery-revoked"
  | "export-scope-invalid"
  | "privacy-authorization-denied"
  | "privacy-subjects-invalid"
  | "provider-rights-denied"
  | "retention-expired";

export type PrepareExportDeliveryFailure = Readonly<{
  code: PrepareExportDeliveryFailureCode;
  message: string;
}>;

export type PreparedExportDelivery = Readonly<{
  delivery: ExportDelivery;
  events: AsyncIterable<DatasetEncodeEvent>;
}>;

export type PrepareExportDeliveryResult = DomainResult<
  PreparedExportDelivery,
  PrepareExportDeliveryFailure
>;

export type PrepareExportDeliveryDependencies = Readonly<{
  authorizeContactEffect: (
    request: AuthorizeContactEffectRequest
  ) => Promise<AuthorizeContactEffectResult>;
  clock: ClockPort;
  persistence: ExportDeliveryPersistencePort;
  subjectKeys?: ContactPrivacySubjectKeyDerivationPort;
}>;

export type RevokeExportDeliveryRequest = Readonly<{
  actor: VerifiedApiKey;
  deliveryId: string;
}>;

export type RevokeExportDeliveryFailure = Readonly<{
  code: "authority-permission-missing" | "delivery-not-found";
  message: string;
}>;

export type RevokeExportDeliveryResult = DomainResult<
  ExportDelivery,
  RevokeExportDeliveryFailure
>;

export type ExportDeliveryPublicState = ExportDelivery["state"] | "expired";

export type GetExportDeliveryRequest = Readonly<{
  actor: VerifiedApiKey;
  deliveryId: string;
}>;

export type GetExportDeliveryFailure = Readonly<{
  code: "authority-permission-missing" | "delivery-not-found";
  message: string;
}>;

export type ExportDeliveryReadback = Readonly<{
  delivery: ExportDelivery;
  effectiveExpiresAt: Instant;
  state: ExportDeliveryPublicState;
}>;

export type GetExportDeliveryResult = DomainResult<
  ExportDeliveryReadback,
  GetExportDeliveryFailure
>;

const rejected = (
  code: PrepareExportDeliveryFailureCode,
  message: string
): DomainResult<never, PrepareExportDeliveryFailure> => fail({ code, message });

const canonicalRequestedData = (facts: ExportDeliveryPrivacyRequest["facts"]) =>
  CONTACT_DATA_CLASSES.flatMap((dataClass) => {
    const requested = facts.requestedData.find(
      (candidate) => candidate.dataClass === dataClass
    );
    return requested === undefined ? [] : [requested];
  });

type PrivacyAuthorization = Readonly<{
  observedExpiries: ExportDeliveryManifest["observedExpiries"];
}>;

const exportedRecordCount = (
  exported: PrepareExportDeliveryRequest["exported"]
): number =>
  "source" in exported
    ? exported.recordCount
    : exported.application.graph.recordIds.length;

const privacySubjectGroups = (
  privacy: ExportDeliveryPrivacyRequest
): readonly (readonly ContactPrivacySubject[])[] =>
  privacy.subjectGroups ??
  privacy.subjects.map((subject) => [subject] as const);

const authorizePrivacy = async (
  dependencies: PrepareExportDeliveryDependencies,
  privacy: ExportDeliveryPrivacyRequest,
  expectedSubjectCount: number,
  workspaceId: WorkspaceId
): Promise<
  DomainResult<PrivacyAuthorization, PrepareExportDeliveryFailure>
> => {
  const subjectGroups = privacySubjectGroups(privacy);
  if (
    subjectGroups.length === 0 ||
    subjectGroups.length !== expectedSubjectCount ||
    subjectGroups.some((subjects) => subjects.length === 0) ||
    privacy.facts.requestedData.length === 0 ||
    new Set(privacy.facts.requestedData.map((requested) => requested.dataClass))
      .size !== privacy.facts.requestedData.length
  ) {
    return rejected(
      "privacy-subjects-invalid",
      "Contact exports require one exact privacy subject per exported record and a unique data-class request."
    );
  }
  const { purposeRef, territory } = privacy.facts;
  if (
    purposeRef === null ||
    purposeRef.trim().length === 0 ||
    territory === null ||
    territory.trim().length === 0
  ) {
    return rejected(
      "privacy-authorization-denied",
      "Contact exports require an explicit purpose and territory."
    );
  }

  const results = await Promise.all(
    subjectGroups.flat().map((subject) =>
      dependencies.authorizeContactEffect({
        facts: { ...privacy.facts, action: "export" },
        policy: privacy.policy,
        subject,
        workspaceId,
      })
    )
  );
  if (
    results.some(
      (result) =>
        !(result.ok && result.value.decision.allowed) ||
        result.value.matchedTombstoneIds.length > 0
    )
  ) {
    return rejected(
      "privacy-authorization-denied",
      "The contact privacy policy or a durable subject restriction denies this export."
    );
  }
  const [first] = results;
  if (first === undefined || !first.ok) {
    return rejected(
      "privacy-authorization-denied",
      "The contact privacy policy did not authorize this export."
    );
  }
  const now = await dependencies.clock.now();
  const observedExpiries = canonicalRequestedData(privacy.facts).flatMap(
    (requested) => {
      const limit = first.value.decision.retentionLimits.find(
        (candidate) => candidate.dataClass === requested.dataClass
      );
      return requested.observedAt === undefined ||
        limit?.expiresAt === undefined
        ? []
        : [
            {
              dataClass: requested.dataClass,
              expiresAt: limit.expiresAt,
              observedAt: requested.observedAt,
            },
          ];
    }
  );
  if (
    observedExpiries.length !== privacy.facts.requestedData.length ||
    observedExpiries.some((observation) => now >= observation.expiresAt)
  ) {
    return rejected(
      "retention-expired",
      "Every exported contact data class must have a current observed-at and retention expiry."
    );
  }
  return succeed({ observedExpiries });
};

const validateScopeAndRights = async (
  dependencies: PrepareExportDeliveryDependencies,
  request: PrepareExportDeliveryRequest
): Promise<DomainResult<undefined, PrepareExportDeliveryFailure>> => {
  const { actor, exported, providerRights } = request;
  const generatedExport =
    "source" in exported && exported.source.kind === "generated-dataset"
      ? exported
      : undefined;
  const generatedSource = generatedExport?.source;
  const recipeExport =
    "application" in exported && "recipe" in exported ? exported : undefined;
  if (
    exported.dataset.workspaceId !== actor.workspaceId ||
    (generatedSource === undefined && recipeExport === undefined) ||
    (generatedSource !== undefined &&
      (generatedExport === undefined ||
        !Number.isSafeInteger(generatedExport.recordCount) ||
        generatedExport.recordCount <= 0 ||
        generatedSource.capabilityId.trim().length === 0 ||
        generatedSource.capabilityVersion.trim().length === 0 ||
        generatedSource.generationId.trim().length === 0 ||
        generatedSource.generationPlanId.trim().length === 0)) ||
    (recipeExport !== undefined &&
      (recipeExport.application.workspaceId !== actor.workspaceId ||
        recipeExport.recipe.workspaceId !== actor.workspaceId ||
        recipeExport.application.datasetId !== exported.dataset.datasetId ||
        recipeExport.recipe.datasetId !== exported.dataset.datasetId ||
        recipeExport.application.recipeId !==
          recipeExport.recipe.enrichmentRecipeId)) ||
    exported.fields.length === 0 ||
    new Set(exported.fields.map((field) => field.fieldId)).size !==
      exported.fields.length ||
    !Number.isSafeInteger(exported.contentLength) ||
    exported.contentLength < 0
  ) {
    return rejected(
      "export-scope-invalid",
      "The export proof does not belong to the authenticated workspace and exact recipe application."
    );
  }
  const now = await dependencies.clock.now();
  if (
    !providerRights.authorized ||
    providerRights.version.trim().length === 0 ||
    now >= providerRights.expiresAt
  ) {
    return rejected(
      "provider-rights-denied",
      "A current operator-controlled provider-rights snapshot is required before contact export."
    );
  }
  return succeed(undefined);
};

const intentForManifest = (manifest: ExportDeliveryManifest) =>
  canonicalContentHash({
    kind: "export-delivery",
    manifest,
    version: "manifestVersion" in manifest ? manifest.manifestVersion : "1.0.0",
  });

const deliveryIdFromIntent = (
  intentHash: ReturnType<typeof intentForManifest>
) => `export-delivery-${intentHash.slice("sha256:".length)}`;

const manifestIsCurrentAt = (
  manifest: ExportDeliveryManifest,
  now: Instant
): boolean => {
  const uniqueDataClasses = new Set(manifest.dataClasses);
  const uniqueObservedDataClasses = new Set(
    manifest.observedExpiries.map((observation) => observation.dataClass)
  );
  return (
    Number.isSafeInteger(manifest.contentLength) &&
    manifest.contentLength >= 0 &&
    manifest.fieldIds.length > 0 &&
    new Set(manifest.fieldIds).size === manifest.fieldIds.length &&
    uniqueDataClasses.size === manifest.dataClasses.length &&
    uniqueObservedDataClasses.size === manifest.observedExpiries.length &&
    now < manifest.policyPurpose.policyExpiresAt &&
    now < manifest.providerRights.expiresAt &&
    manifest.observedExpiries.length === manifest.dataClasses.length &&
    manifest.observedExpiries.every(
      (observation, index) =>
        observation.dataClass === manifest.dataClasses[index] &&
        observation.observedAt < observation.expiresAt &&
        observation.observedAt <= now &&
        now < observation.expiresAt
    )
  );
};

export const exportDeliveryEffectiveExpiresAt = (
  delivery: Pick<ExportDelivery, "effectiveExpiresAt" | "manifest">
): Instant => {
  const manifestExpiry = Math.min(
    delivery.manifest.policyPurpose.policyExpiresAt,
    delivery.manifest.providerRights.expiresAt,
    ...delivery.manifest.observedExpiries.map(
      (observation) => observation.expiresAt
    )
  );
  return delivery.effectiveExpiresAt === undefined
    ? instant(manifestExpiry)
    : delivery.effectiveExpiresAt;
};

export const exportDeliveryPublicStateAt = (
  delivery: ExportDelivery,
  now: Instant
): ExportDeliveryPublicState => {
  if (delivery.state === "revoked") {
    return "revoked";
  }
  return now >= exportDeliveryEffectiveExpiresAt(delivery)
    ? "expired"
    : delivery.state;
};

export class ExportDeliveryInvariantError extends Error {
  readonly code = "export-delivery-invariant";

  constructor() {
    super("The prepared export delivery could not be completed safely.");
    this.name = "ExportDeliveryInvariantError";
  }
}

type ChunkEvent = Extract<DatasetEncodeEvent, Readonly<{ type: "chunk" }>>;

interface DeliveryContentAccumulator {
  contentLength: number;
  digest: ReturnType<typeof createHash>;
}

const accumulateDeliveryEvent = (
  event: DatasetEncodeEvent,
  accumulator: DeliveryContentAccumulator
): ChunkEvent | undefined => {
  if (event.type !== "chunk" || !(event.bytes instanceof Uint8Array)) {
    throw new ExportDeliveryInvariantError();
  }
  const bytes = event.bytes.slice();
  accumulator.contentLength += bytes.byteLength;
  accumulator.digest.update(bytes);
  return bytes.byteLength === 0 ? undefined : { ...event, bytes };
};

const assertContentProof = (
  delivery: ExportDelivery,
  accumulator: DeliveryContentAccumulator
) => {
  const observedHash = contentHash(
    `sha256:${accumulator.digest.digest("hex")}`
  );
  if (
    observedHash !== delivery.manifest.contentHash ||
    accumulator.contentLength !== delivery.manifest.contentLength
  ) {
    throw new ExportDeliveryInvariantError();
  }
  return observedHash;
};

const privacyIsCurrent = async (
  dependencies: PrepareExportDeliveryDependencies,
  request: PrepareExportDeliveryRequest,
  manifest: ExportDeliveryManifest
): Promise<boolean> => {
  const authorization = await authorizePrivacy(
    dependencies,
    request.privacy,
    exportedRecordCount(request.exported),
    request.actor.workspaceId
  );
  return (
    authorization.ok &&
    manifestIsCurrentAt(manifest, await dependencies.clock.now())
  );
};

const completionTimeIfAuthorized = async (
  dependencies: PrepareExportDeliveryDependencies,
  request: PrepareExportDeliveryRequest,
  manifest: ExportDeliveryManifest
): Promise<Instant | undefined> => {
  const authorization = await authorizePrivacy(
    dependencies,
    request.privacy,
    exportedRecordCount(request.exported),
    request.actor.workspaceId
  );
  if (!authorization.ok) {
    return;
  }
  const completedAt = await dependencies.clock.now();
  return manifestIsCurrentAt(manifest, completedAt) ? completedAt : undefined;
};

const assertDeliveryReadable = async (
  dependencies: PrepareExportDeliveryDependencies,
  request: PrepareExportDeliveryRequest,
  delivery: ExportDelivery
): Promise<void> => {
  const current = await dependencies.persistence.getOwned(
    { workspaceId: request.actor.workspaceId },
    delivery.deliveryId,
    request.actor.actorId
  );
  if (
    current === undefined ||
    current.state === "revoked" ||
    current.intentHash !== delivery.intentHash ||
    !(await privacyIsCurrent(dependencies, request, current.manifest))
  ) {
    throw new ExportDeliveryInvariantError();
  }
};

const verifiedDeliveryEvents = (
  dependencies: PrepareExportDeliveryDependencies,
  request: PrepareExportDeliveryRequest,
  delivery: ExportDelivery
): AsyncIterable<DatasetEncodeEvent> => ({
  async *[Symbol.asyncIterator]() {
    const scope = { workspaceId: request.actor.workspaceId } as const;
    await assertDeliveryReadable(dependencies, request, delivery);
    const accumulator: DeliveryContentAccumulator = {
      contentLength: 0,
      digest: createHash("sha256"),
    };
    let pending: ChunkEvent | undefined;
    for await (const event of request.exported.events) {
      const chunk = accumulateDeliveryEvent(event, accumulator);
      if (pending !== undefined) {
        yield pending;
      }
      pending = chunk;
    }
    const observedHash = assertContentProof(delivery, accumulator);
    if (!(await privacyIsCurrent(dependencies, request, delivery.manifest))) {
      throw new ExportDeliveryInvariantError();
    }
    if (pending !== undefined) {
      yield pending;
    }
    const deliveredAt = await completionTimeIfAuthorized(
      dependencies,
      request,
      delivery.manifest
    );
    if (deliveredAt === undefined) {
      throw new ExportDeliveryInvariantError();
    }
    const completed = await dependencies.persistence.complete(scope, {
      contentHash: observedHash,
      contentLength: accumulator.contentLength,
      deliveredAt,
      deliveryId: delivery.deliveryId,
      ownerActorId: request.actor.actorId,
    });
    if (completed.status !== "delivered") {
      throw new ExportDeliveryInvariantError();
    }
  },
});

const buildDeliveryManifest = (
  request: PrepareExportDeliveryRequest,
  authorization: PrivacyAuthorization
): DomainResult<ExportDeliveryManifest, PrepareExportDeliveryFailure> => {
  const { purposeRef, territory } = request.privacy.facts;
  if (purposeRef === null || territory === null) {
    return rejected(
      "privacy-authorization-denied",
      "The contact privacy purpose and territory are unresolved."
    );
  }
  const common = {
    contentHash: request.exported.contentHash,
    contentLength: request.exported.contentLength,
    dataClasses: authorization.observedExpiries.map(
      (observation) => observation.dataClass
    ),
    datasetId: request.exported.dataset.datasetId,
    fieldIds: request.exported.fields.map((field) => field.fieldId),
    format: request.exported.format,
    observedExpiries: authorization.observedExpiries,
    ownerActorId: request.actor.actorId,
    policyPurpose: {
      policyExpiresAt: request.privacy.policy.expiresAt,
      policyVersion: request.privacy.policy.version,
      purposeRef,
      territory,
    },
    providerRights: {
      expiresAt: request.providerRights.expiresAt,
      mode: request.providerRights.mode,
      version: request.providerRights.version,
    },
    workspaceId: request.actor.workspaceId,
  };
  return succeed(
    "source" in request.exported
      ? {
          ...common,
          applicationId: null,
          manifestVersion: "2.0.0",
          recipeId: null,
          recipeRevision: null,
          source: request.exported.source,
        }
      : {
          ...common,
          applicationId: request.exported.application.recipeApplicationId,
          recipeId: request.exported.recipe.enrichmentRecipeId,
          recipeRevision: request.exported.recipe.recipeRevision,
        }
  );
};

const sameSubjectKey = (
  left: ContactPrivacySubjectKey,
  right: ContactPrivacySubjectKey
): boolean =>
  left.algorithm === right.algorithm &&
  left.digest === right.digest &&
  left.formatVersion === right.formatVersion &&
  left.identityKind === right.identityKind &&
  left.providerKey === right.providerKey &&
  left.secretVersion === right.secretVersion;

const deriveDeliverySubjectKeys = async (
  dependencies: PrepareExportDeliveryDependencies,
  request: PrepareExportDeliveryRequest
): Promise<ContactPrivacySubjectKey[] | undefined> => {
  const subjectKeyDeriver = dependencies.subjectKeys;
  if (subjectKeyDeriver === undefined) {
    return;
  }
  const derived = await Promise.all(
    privacySubjectGroups(request.privacy)
      .flat()
      .map((subject) => subjectKeyDeriver.derive(subject))
  );
  return derived
    .flatMap((entry) => entry.all)
    .filter(
      (candidate, index, candidates) =>
        candidates.findIndex((other) => sameSubjectKey(other, candidate)) ===
        index
    );
};

const persistPreparedDelivery = async (
  dependencies: PrepareExportDeliveryDependencies,
  request: PrepareExportDeliveryRequest,
  delivery: Omit<
    ExportDelivery,
    "deliveredAt" | "effectiveExpiresAt" | "revokedAt" | "state"
  >,
  subjectKeys: readonly ContactPrivacySubjectKey[] | undefined
): Promise<PrepareExportDeliveryResult> => {
  const persisted = await dependencies.persistence.prepare(
    { workspaceId: request.actor.workspaceId },
    {
      delivery,
      idempotencyKey: request.idempotencyKey,
      ...(subjectKeys === undefined ? {} : { subjectKeys }),
    }
  );
  if (persisted.status === "idempotency-conflict") {
    return rejected(
      "delivery-idempotency-conflict",
      "The export delivery idempotency key is already bound to another immutable manifest."
    );
  }
  if (persisted.status === "subject-restricted") {
    return rejected(
      "privacy-authorization-denied",
      "A durable contact restriction blocks this export delivery."
    );
  }
  if (persisted.status === "revoked") {
    return rejected(
      "delivery-revoked",
      "The immutable export delivery has been revoked and cannot be replayed."
    );
  }
  return succeed({
    delivery: persisted.delivery,
    events: verifiedDeliveryEvents(dependencies, request, persisted.delivery),
  });
};

export const makePrepareExportDelivery =
  (dependencies: PrepareExportDeliveryDependencies) =>
  async (
    request: PrepareExportDeliveryRequest
  ): Promise<PrepareExportDeliveryResult> => {
    const scopeAndRights = await validateScopeAndRights(dependencies, request);
    if (!scopeAndRights.ok) {
      return scopeAndRights;
    }
    const privacy = await authorizePrivacy(
      dependencies,
      request.privacy,
      exportedRecordCount(request.exported),
      request.actor.workspaceId
    );
    if (!privacy.ok) {
      return privacy;
    }
    const manifest = buildDeliveryManifest(request, privacy.value);
    if (!manifest.ok) {
      return manifest;
    }
    const preparedAt = await dependencies.clock.now();
    if (!manifestIsCurrentAt(manifest.value, preparedAt)) {
      return rejected(
        preparedAt >= manifest.value.providerRights.expiresAt
          ? "provider-rights-denied"
          : "retention-expired",
        "The export privacy, provider-rights, or retention snapshot expired before durable preparation."
      );
    }
    const intentHash = intentForManifest(manifest.value);
    const subjectKeys = await deriveDeliverySubjectKeys(dependencies, request);
    if (
      "source" in request.exported &&
      (subjectKeys === undefined || subjectKeys.length === 0)
    ) {
      return rejected(
        "privacy-subjects-invalid",
        "Generated Contact deliveries require restricted subject bindings."
      );
    }
    return persistPreparedDelivery(
      dependencies,
      request,
      {
        deliveryId: deliveryIdFromIntent(intentHash),
        intentHash,
        manifest: manifest.value,
        preparedAt,
      },
      subjectKeys
    );
  };

export const makeRevokeExportDelivery =
  (
    dependencies: Pick<
      PrepareExportDeliveryDependencies,
      "clock" | "persistence"
    > &
      Readonly<{ requiredPermission?: string }>
  ) =>
  async (
    request: RevokeExportDeliveryRequest
  ): Promise<RevokeExportDeliveryResult> => {
    if (
      dependencies.requiredPermission !== undefined &&
      !request.actor.permissions.includes(dependencies.requiredPermission)
    ) {
      return fail({
        code: "authority-permission-missing",
        message:
          "The authenticated actor lacks permission to revoke Contact export deliveries.",
      });
    }
    const revoked = await dependencies.persistence.revoke(
      { workspaceId: request.actor.workspaceId },
      {
        deliveryId: request.deliveryId,
        ownerActorId: request.actor.actorId,
        revokedAt: await dependencies.clock.now(),
      }
    );
    return revoked.status === "revoked"
      ? succeed(revoked.delivery)
      : fail({
          code: "delivery-not-found",
          message: "The export delivery does not exist for this owner.",
        });
  };

export const makeGetExportDelivery =
  (
    dependencies: Pick<
      PrepareExportDeliveryDependencies,
      "clock" | "persistence"
    > &
      Readonly<{ requiredPermission: string }>
  ) =>
  async (
    request: GetExportDeliveryRequest
  ): Promise<GetExportDeliveryResult> => {
    if (!request.actor.permissions.includes(dependencies.requiredPermission)) {
      return fail({
        code: "authority-permission-missing",
        message:
          "The authenticated actor lacks permission to read Contact export deliveries.",
      });
    }
    const delivery = await dependencies.persistence.getOwned(
      { workspaceId: request.actor.workspaceId },
      request.deliveryId,
      request.actor.actorId
    );
    if (delivery === undefined) {
      return fail({
        code: "delivery-not-found",
        message: "The export delivery does not exist for this owner.",
      });
    }
    const now = await dependencies.clock.now();
    return succeed({
      delivery,
      effectiveExpiresAt: exportDeliveryEffectiveExpiresAt(delivery),
      state: exportDeliveryPublicStateAt(delivery, now),
    });
  };
