import {
  actorId,
  type ContactPrivacySubjectKey,
  contentHash,
  datasetId,
  enrichmentRecipeId,
  fieldId,
  type Instant,
  instant,
  workspaceId,
} from "@kurobara/kernel";
import type {
  CompleteExportDeliveryInput,
  ExportContactDataClass,
  ExportDelivery,
  ExportDeliveryManifest,
  ExportDeliveryPersistencePort,
  ExportProviderRightsMode,
  PrepareExportDeliveryInput,
  PrepareExportDeliveryResult,
  WorkspaceScope,
} from "@kurobara/ports";
import type postgres from "postgres";

import { DatabasePayloadError, PostgresAdapterError } from "./errors.ts";
import { toJsonValue } from "./json.ts";

type JsonRecord = Readonly<Record<string, unknown>>;
const UNSIGNED_INTEGER = /^(0|[1-9][0-9]*)$/u;

type ExportDeliveryRow = Readonly<{
  application_id: string | null;
  capability_id: string | null;
  capability_version: string | null;
  content_hash: string;
  content_length: string;
  delivered_at: Date | null;
  delivered_content_hash: string | null;
  delivered_content_length: string | null;
  delivery_id: string;
  effective_expires_at: Date;
  format: string;
  generation_id: string | null;
  generation_plan_id: string | null;
  intent_hash: string;
  manifest: unknown;
  manifest_version: string;
  owner_actor_id: string;
  plan_hash: string | null;
  prepared_at: Date;
  recipe_id: string | null;
  recipe_revision: string | null;
  revoked_at: Date | null;
  source_kind: string;
  workspace_id: string;
  dataset_id: string;
}>;

const DATA_CLASS_ORDER: readonly ExportContactDataClass[] = [
  "contact-identity",
  "employment",
  "professional-social-profile",
  "professional-email",
  "personal-email",
  "phone",
];
const DATA_CLASSES = new Set(DATA_CLASS_ORDER);
const RIGHTS_MODES = new Set<ExportProviderRightsMode>([
  "operator-authorized-byok",
  "synthetic-fixture",
]);

const asRecord = (value: unknown, path: string): JsonRecord => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new DatabasePayloadError(`${path} must be an object.`);
  }
  return value as JsonRecord;
};

const exactKeys = (
  value: JsonRecord,
  path: string,
  required: readonly string[]
): void => {
  if (
    Object.keys(value).length !== required.length ||
    required.some((key) => !Object.hasOwn(value, key))
  ) {
    throw new DatabasePayloadError(
      `${path} does not have its exact audit-safe field set.`
    );
  }
};

const boundedString = (value: unknown, path: string, maximum = 255): string => {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.trim() !== value ||
    [...value].length > maximum
  ) {
    throw new DatabasePayloadError(`${path} must be a bounded string.`);
  }
  return value;
};

const nonNegativeInteger = (value: unknown, path: string): number => {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new DatabasePayloadError(
      `${path} must be a non-negative safe integer.`
    );
  }
  return value as number;
};

const databaseInteger = (value: string, path: string): number => {
  if (!UNSIGNED_INTEGER.test(value)) {
    throw new DatabasePayloadError(`${path} must be an unsigned integer.`);
  }
  return nonNegativeInteger(Number(value), path);
};

const stringArray = (
  value: unknown,
  path: string,
  parse: (candidate: string) => string
): readonly string[] => {
  if (!Array.isArray(value) || value.length === 0) {
    throw new DatabasePayloadError(`${path} must be a non-empty array.`);
  }
  const parsed = value.map((candidate, index) =>
    parse(boundedString(candidate, `${path}[${index}]`))
  );
  if (new Set(parsed).size !== parsed.length) {
    throw new DatabasePayloadError(`${path} must contain unique values.`);
  }
  return parsed;
};

const parseDataClass = (value: string): ExportContactDataClass => {
  if (!DATA_CLASSES.has(value as ExportContactDataClass)) {
    throw new DatabasePayloadError(
      "export delivery data class is not recognized."
    );
  }
  return value as ExportContactDataClass;
};

const parseInstant = (value: unknown, path: string) =>
  instant(nonNegativeInteger(value, path));

const assertManifestShape = (manifest: JsonRecord, version: string): void => {
  if (version === "1.0.0") {
    exactKeys(manifest, "export delivery manifest", [
      "applicationId",
      "contentHash",
      "contentLength",
      "dataClasses",
      "datasetId",
      "fieldIds",
      "format",
      "observedExpiries",
      "ownerActorId",
      "policyPurpose",
      "providerRights",
      "recipeId",
      "recipeRevision",
      "workspaceId",
    ]);
    return;
  }
  if (version !== "2.0.0") {
    throw new DatabasePayloadError(
      "export delivery manifest version is not recognized."
    );
  }
  exactKeys(manifest, "export delivery manifest", [
    "applicationId",
    "contentHash",
    "contentLength",
    "dataClasses",
    "datasetId",
    "fieldIds",
    "format",
    "manifestVersion",
    "observedExpiries",
    "ownerActorId",
    "policyPurpose",
    "providerRights",
    "recipeId",
    "recipeRevision",
    "source",
    "workspaceId",
  ]);
  if (
    manifest.manifestVersion !== "2.0.0" ||
    manifest.applicationId !== null ||
    manifest.recipeId !== null ||
    manifest.recipeRevision !== null
  ) {
    throw new DatabasePayloadError(
      "export delivery manifest version conflicts with its relational identity."
    );
  }
};

const parseGeneratedSource = (value: unknown) => {
  const source = asRecord(value, "export delivery manifest.source");
  exactKeys(source, "export delivery manifest.source", [
    "capabilityId",
    "capabilityVersion",
    "generationId",
    "generationPlanId",
    "kind",
    "planHash",
  ]);
  if (source.kind !== "generated-dataset") {
    throw new DatabasePayloadError(
      "export delivery generated-dataset source kind is invalid."
    );
  }
  return {
    capabilityId: boundedString(
      source.capabilityId,
      "export delivery manifest.source.capabilityId"
    ),
    capabilityVersion: boundedString(
      source.capabilityVersion,
      "export delivery manifest.source.capabilityVersion"
    ),
    generationId: boundedString(
      source.generationId,
      "export delivery manifest.source.generationId"
    ),
    generationPlanId: boundedString(
      source.generationPlanId,
      "export delivery manifest.source.generationPlanId"
    ),
    kind: "generated-dataset" as const,
    planHash: contentHash(
      boundedString(source.planHash, "export delivery manifest.source.planHash")
    ),
  };
};

const manifestSourceMatchesRow = (
  manifest: ExportDeliveryManifest,
  row: ExportDeliveryRow
): boolean => {
  if ("manifestVersion" in manifest) {
    return (
      row.source_kind === "generated-dataset" &&
      row.application_id === null &&
      row.recipe_id === null &&
      row.recipe_revision === null &&
      manifest.source.generationId === row.generation_id &&
      manifest.source.generationPlanId === row.generation_plan_id &&
      manifest.source.planHash === row.plan_hash &&
      manifest.source.capabilityId === row.capability_id &&
      manifest.source.capabilityVersion === row.capability_version
    );
  }
  return (
    row.source_kind === "recipe-application" &&
    manifest.applicationId === row.application_id &&
    manifest.recipeId === row.recipe_id &&
    manifest.recipeRevision === row.recipe_revision &&
    row.generation_id === null &&
    row.generation_plan_id === null &&
    row.plan_hash === null &&
    row.capability_id === null &&
    row.capability_version === null
  );
};

const parseManifest = (
  value: unknown,
  row: ExportDeliveryRow
): ExportDeliveryManifest => {
  const manifest = asRecord(value, "export delivery manifest");
  assertManifestShape(manifest, row.manifest_version);

  const dataClasses = stringArray(
    manifest.dataClasses,
    "export delivery manifest.dataClasses",
    parseDataClass
  ) as readonly ExportContactDataClass[];
  const canonicalDataClasses = DATA_CLASS_ORDER.filter((dataClass) =>
    dataClasses.includes(dataClass)
  );
  if (
    canonicalDataClasses.some(
      (dataClass, index) => dataClass !== dataClasses[index]
    )
  ) {
    throw new DatabasePayloadError(
      "export delivery data classes are not in canonical order."
    );
  }
  const fieldIds = stringArray(
    manifest.fieldIds,
    "export delivery manifest.fieldIds",
    (candidate) => fieldId(candidate)
  ) as ExportDeliveryManifest["fieldIds"];
  const policyPurpose = asRecord(
    manifest.policyPurpose,
    "export delivery manifest.policyPurpose"
  );
  exactKeys(policyPurpose, "export delivery manifest.policyPurpose", [
    "policyExpiresAt",
    "policyVersion",
    "purposeRef",
    "territory",
  ]);
  const providerRights = asRecord(
    manifest.providerRights,
    "export delivery manifest.providerRights"
  );
  exactKeys(providerRights, "export delivery manifest.providerRights", [
    "expiresAt",
    "mode",
    "version",
  ]);
  const rightsMode = boundedString(
    providerRights.mode,
    "export delivery manifest.providerRights.mode"
  );
  if (!RIGHTS_MODES.has(rightsMode as ExportProviderRightsMode)) {
    throw new DatabasePayloadError(
      "export delivery provider rights mode is not recognized."
    );
  }
  if (!Array.isArray(manifest.observedExpiries)) {
    throw new DatabasePayloadError(
      "export delivery manifest.observedExpiries must be an array."
    );
  }
  const observedExpiries = manifest.observedExpiries.map(
    (observedValue, index) => {
      const item = asRecord(
        observedValue,
        `export delivery manifest.observedExpiries[${index}]`
      );
      exactKeys(item, `export delivery manifest.observedExpiries[${index}]`, [
        "dataClass",
        "expiresAt",
        "observedAt",
      ]);
      return {
        dataClass: parseDataClass(
          boundedString(
            item.dataClass,
            `export delivery manifest.observedExpiries[${index}].dataClass`
          )
        ),
        expiresAt: parseInstant(
          item.expiresAt,
          `export delivery manifest.observedExpiries[${index}].expiresAt`
        ),
        observedAt: parseInstant(
          item.observedAt,
          `export delivery manifest.observedExpiries[${index}].observedAt`
        ),
      };
    }
  );
  if (
    observedExpiries.length !== dataClasses.length ||
    observedExpiries.some(
      (observation, index) =>
        observation.dataClass !== dataClasses[index] ||
        observation.observedAt >= observation.expiresAt
    )
  ) {
    throw new DatabasePayloadError(
      "export delivery observed expiries must match its ordered data classes."
    );
  }
  const format = boundedString(
    manifest.format,
    "export delivery manifest.format"
  );
  if (format !== "csv" && format !== "jsonl") {
    throw new DatabasePayloadError(
      "export delivery manifest format is invalid."
    );
  }
  const exportFormat = format === "csv" ? "csv" : "jsonl";
  const common = {
    contentHash: contentHash(
      boundedString(
        manifest.contentHash,
        "export delivery manifest.contentHash"
      )
    ),
    contentLength: nonNegativeInteger(
      manifest.contentLength,
      "export delivery manifest.contentLength"
    ),
    dataClasses,
    datasetId: datasetId(
      boundedString(manifest.datasetId, "export delivery manifest.datasetId")
    ),
    fieldIds,
    format: exportFormat,
    observedExpiries,
    ownerActorId: actorId(
      boundedString(
        manifest.ownerActorId,
        "export delivery manifest.ownerActorId"
      )
    ),
    policyPurpose: {
      policyExpiresAt: parseInstant(
        policyPurpose.policyExpiresAt,
        "export delivery manifest.policyPurpose.policyExpiresAt"
      ),
      policyVersion: boundedString(
        policyPurpose.policyVersion,
        "export delivery manifest.policyPurpose.policyVersion"
      ),
      purposeRef: boundedString(
        policyPurpose.purposeRef,
        "export delivery manifest.policyPurpose.purposeRef"
      ),
      territory: boundedString(
        policyPurpose.territory,
        "export delivery manifest.policyPurpose.territory"
      ),
    },
    providerRights: {
      expiresAt: parseInstant(
        providerRights.expiresAt,
        "export delivery manifest.providerRights.expiresAt"
      ),
      mode: rightsMode as ExportProviderRightsMode,
      version: boundedString(
        providerRights.version,
        "export delivery manifest.providerRights.version"
      ),
    },
    workspaceId: workspaceId(
      boundedString(
        manifest.workspaceId,
        "export delivery manifest.workspaceId"
      )
    ),
  } as const;
  let parsed: ExportDeliveryManifest;
  if (row.manifest_version === "1.0.0") {
    parsed = {
      ...common,
      applicationId: boundedString(
        manifest.applicationId,
        "export delivery manifest.applicationId"
      ),
      recipeId: enrichmentRecipeId(
        boundedString(manifest.recipeId, "export delivery manifest.recipeId")
      ),
      recipeRevision: boundedString(
        manifest.recipeRevision,
        "export delivery manifest.recipeRevision"
      ),
    };
  } else {
    parsed = {
      ...common,
      applicationId: null,
      manifestVersion: "2.0.0",
      recipeId: null,
      recipeRevision: null,
      source: parseGeneratedSource(manifest.source),
    };
  }
  if (
    parsed.workspaceId !== row.workspace_id ||
    parsed.ownerActorId !== row.owner_actor_id ||
    parsed.datasetId !== row.dataset_id ||
    parsed.format !== row.format ||
    parsed.contentHash !== row.content_hash ||
    parsed.contentLength !==
      databaseInteger(row.content_length, "content length")
  ) {
    throw new DatabasePayloadError(
      "export delivery manifest conflicts with its relational identity."
    );
  }
  if (!manifestSourceMatchesRow(parsed, row)) {
    throw new DatabasePayloadError(
      "export delivery source conflicts with its relational identity."
    );
  }
  return parsed;
};

const parseDelivery = (row: ExportDeliveryRow): ExportDelivery => {
  const manifest = parseManifest(row.manifest, row);
  const intentHash = contentHash(row.intent_hash);
  const deliveryId = boundedString(row.delivery_id, "export delivery id", 80);
  const preparedAt = instant(row.prepared_at.getTime());
  const effectiveExpiresAt = instant(row.effective_expires_at.getTime());
  const deliveredAt =
    row.delivered_at === null ? undefined : instant(row.delivered_at.getTime());
  const revokedAt =
    row.revoked_at === null ? undefined : instant(row.revoked_at.getTime());
  if (deliveryId !== `export-delivery-${intentHash.slice("sha256:".length)}`) {
    throw new DatabasePayloadError(
      "export delivery id does not match its immutable intention."
    );
  }
  let state: ExportDelivery["state"] = "prepared";
  if (row.delivered_at !== null) {
    state = "delivered";
  }
  if (row.revoked_at !== null) {
    state = "revoked";
  }
  if (
    row.delivered_at !== null &&
    (row.delivered_content_hash !== manifest.contentHash ||
      row.delivered_content_length === null ||
      databaseInteger(
        row.delivered_content_length,
        "delivered content length"
      ) !== manifest.contentLength)
  ) {
    throw new DatabasePayloadError(
      "export delivery completion proof conflicts with its manifest."
    );
  }
  if (
    effectiveExpiresAt !==
      instant(
        Math.min(
          manifest.policyPurpose.policyExpiresAt,
          manifest.providerRights.expiresAt,
          ...manifest.observedExpiries.map(
            (observation) => observation.expiresAt
          )
        )
      ) ||
    preparedAt >= manifest.policyPurpose.policyExpiresAt ||
    preparedAt >= manifest.providerRights.expiresAt ||
    manifest.observedExpiries.some(
      (observation) =>
        observation.observedAt > preparedAt ||
        preparedAt >= observation.expiresAt
    ) ||
    (deliveredAt !== undefined &&
      (deliveredAt < preparedAt ||
        deliveredAt >= manifest.policyPurpose.policyExpiresAt ||
        deliveredAt >= manifest.providerRights.expiresAt ||
        manifest.observedExpiries.some(
          (observation) => deliveredAt >= observation.expiresAt
        ))) ||
    (revokedAt !== undefined && revokedAt < preparedAt) ||
    (deliveredAt !== undefined &&
      revokedAt !== undefined &&
      revokedAt < deliveredAt)
  ) {
    throw new DatabasePayloadError(
      "export delivery lifecycle timestamps conflict with its immutable authorization windows."
    );
  }
  return {
    deliveryId,
    effectiveExpiresAt,
    intentHash,
    manifest,
    preparedAt,
    state,
    ...(deliveredAt === undefined ? {} : { deliveredAt }),
    ...(revokedAt === undefined ? {} : { revokedAt }),
  };
};

const selectDelivery = (sql: postgres.Sql) => sql`
  delivery.workspace_id,
  delivery.delivery_id,
  delivery.owner_actor_id,
  delivery.intent_hash,
  delivery.application_id,
  delivery.capability_id,
  delivery.capability_version,
  delivery.dataset_id,
  delivery.effective_expires_at,
  delivery.generation_id,
  delivery.generation_plan_id,
  delivery.manifest_version,
  delivery.plan_hash,
  delivery.recipe_id,
  delivery.recipe_revision,
  delivery.source_kind,
  delivery.format,
  delivery.content_hash,
  delivery.content_length::text,
  delivery.manifest,
  delivery.prepared_at,
  delivered.recorded_at AS delivered_at,
  delivered.content_hash AS delivered_content_hash,
  delivered.content_length::text AS delivered_content_length,
  revoked.recorded_at AS revoked_at
`;

const deliveryJoins = (sql: postgres.Sql) => sql`
  LEFT JOIN kurobara_core.export_delivery_events AS delivered
    ON delivered.workspace_id = delivery.workspace_id
    AND delivered.delivery_id = delivery.delivery_id
    AND delivered.event_type = 'delivered'
  LEFT JOIN kurobara_core.export_delivery_events AS revoked
    ON revoked.workspace_id = delivery.workspace_id
    AND revoked.delivery_id = delivery.delivery_id
    AND revoked.event_type = 'revoked'
`;

const getDelivery = async (
  sql: postgres.Sql,
  scope: WorkspaceScope,
  deliveryId: string,
  ownerActorId?: string,
  lockForUpdate = false
): Promise<ExportDelivery | undefined> => {
  if (lockForUpdate) {
    const locked = await sql<readonly { delivery_id: string }[]>`
      SELECT delivery_id
      FROM kurobara_core.export_deliveries
      WHERE workspace_id = ${scope.workspaceId}
        AND delivery_id = ${deliveryId}
        ${
          ownerActorId === undefined
            ? sql``
            : sql`AND owner_actor_id = ${ownerActorId}`
        }
      FOR UPDATE
    `;
    if (locked[0] === undefined) {
      return;
    }
  }
  const rows = await sql<readonly ExportDeliveryRow[]>`
    SELECT ${selectDelivery(sql)}
    FROM kurobara_core.export_deliveries AS delivery
    ${deliveryJoins(sql)}
    WHERE delivery.workspace_id = ${scope.workspaceId}
      AND delivery.delivery_id = ${deliveryId}
      ${
        ownerActorId === undefined
          ? sql``
          : sql`AND delivery.owner_actor_id = ${ownerActorId}`
      }
  `;
  const [row] = rows;
  return row === undefined ? undefined : parseDelivery(row);
};

const getByIntent = async (
  sql: postgres.Sql,
  scope: WorkspaceScope,
  intentHash: string
): Promise<ExportDelivery | undefined> => {
  const rows = await sql<readonly { delivery_id: string }[]>`
    SELECT delivery_id
    FROM kurobara_core.export_deliveries
    WHERE workspace_id = ${scope.workspaceId}
      AND intent_hash = ${intentHash}
    FOR UPDATE
  `;
  const [row] = rows;
  return row === undefined
    ? undefined
    : getDelivery(sql, scope, row.delivery_id);
};

const getByRequest = async (
  sql: postgres.Sql,
  scope: WorkspaceScope,
  idempotencyKey: string
): Promise<ExportDelivery | undefined> => {
  const rows = await sql<readonly { delivery_id: string }[]>`
    SELECT delivery.delivery_id
    FROM kurobara_core.export_delivery_requests AS request
    JOIN kurobara_core.export_deliveries AS delivery
      ON delivery.workspace_id = request.workspace_id
      AND delivery.delivery_id = request.delivery_id
      AND delivery.intent_hash = request.intent_hash
    WHERE request.workspace_id = ${scope.workspaceId}
      AND request.idempotency_key = ${idempotencyKey}
    FOR UPDATE OF request, delivery
  `;
  const [row] = rows;
  return row === undefined
    ? undefined
    : getDelivery(sql, scope, row.delivery_id);
};

const lockPrepare = async (
  sql: postgres.Sql,
  scope: WorkspaceScope,
  input: PrepareExportDeliveryInput,
  subjectKeys: readonly ContactPrivacySubjectKey[]
): Promise<void> => {
  const lockKeys = [
    `export-delivery-intent\u001f${scope.workspaceId}\u001f${input.delivery.intentHash}`,
    `export-delivery-request\u001f${scope.workspaceId}\u001f${input.idempotencyKey}`,
    ...subjectKeys.map(
      (key) =>
        `contact-export-subject\u001f${scope.workspaceId}\u001f${subjectKeyIdentity(key)}`
    ),
  ].sort();
  for (const lockKey of lockKeys) {
    await sql`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0::bigint))`;
  }
};

const subjectKeysAreRestricted = async (
  sql: postgres.Sql,
  scope: WorkspaceScope,
  subjectKeys: readonly ContactPrivacySubjectKey[]
): Promise<boolean> => {
  for (const key of subjectKeys) {
    const rows = await sql<readonly { restricted: boolean }[]>`
      SELECT EXISTS (
        SELECT 1
        FROM kurobara_core.contact_privacy_tombstone_subject_keys
        WHERE workspace_id = ${scope.workspaceId}
          AND subject_key_algorithm = ${key.algorithm}
          AND subject_key_format_version = ${key.formatVersion}
          AND subject_key_secret_version = ${key.secretVersion}
          AND subject_identity_kind = ${key.identityKind}
          AND subject_provider_key = ${key.providerKey ?? ""}
          AND subject_key_digest = ${key.digest}
      ) AS restricted
    `;
    if (rows[0]?.restricted === true) {
      return true;
    }
  }
  return false;
};

const normalizedJson = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map(normalizedJson);
  }
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, child]) => child !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, normalizedJson(child)])
    );
  }
  return value;
};

const sameManifest = (
  left: ExportDeliveryManifest,
  right: ExportDeliveryManifest
): boolean =>
  JSON.stringify(normalizedJson(left)) ===
  JSON.stringify(normalizedJson(right));

const generatedDatasetManifest = (
  manifest: ExportDeliveryManifest
): manifest is Extract<
  ExportDeliveryManifest,
  Readonly<{ manifestVersion: "2.0.0" }>
> => "manifestVersion" in manifest;

const effectiveExpiry = (manifest: ExportDeliveryManifest): Instant =>
  instant(
    Math.min(
      manifest.policyPurpose.policyExpiresAt,
      manifest.providerRights.expiresAt,
      ...manifest.observedExpiries.map((observation) => observation.expiresAt)
    )
  );

const subjectKeyIdentity = (key: ContactPrivacySubjectKey): string =>
  [
    key.algorithm,
    key.formatVersion,
    key.secretVersion,
    key.identityKind,
    key.providerKey ?? "",
    key.digest,
  ].join("\u001f");

const canonicalSubjectKeys = (
  keys: readonly ContactPrivacySubjectKey[] | undefined
): readonly ContactPrivacySubjectKey[] => {
  const unique = new Map<string, ContactPrivacySubjectKey>();
  for (const key of keys ?? []) {
    unique.set(subjectKeyIdentity(key), key);
  }
  return [...unique.values()].sort((left, right) =>
    subjectKeyIdentity(left).localeCompare(subjectKeyIdentity(right))
  );
};

type ExportDeliverySubjectKeyRow = Readonly<{
  subject_identity_kind: string;
  subject_key_algorithm: string;
  subject_key_digest: string;
  subject_key_format_version: string;
  subject_key_secret_version: string;
  subject_provider_key: string;
}>;

const parseSubjectKey = (
  row: ExportDeliverySubjectKeyRow
): ContactPrivacySubjectKey => {
  if (
    row.subject_key_algorithm !== "hmac-sha-256" ||
    row.subject_key_format_version !== "1.0.0" ||
    (row.subject_identity_kind !== "email" &&
      row.subject_identity_kind !== "provider-subject")
  ) {
    throw new DatabasePayloadError(
      "export delivery restricted subject key is malformed."
    );
  }
  return {
    algorithm: row.subject_key_algorithm,
    digest: row.subject_key_digest,
    formatVersion: row.subject_key_format_version,
    identityKind: row.subject_identity_kind,
    ...(row.subject_provider_key.length === 0
      ? {}
      : { providerKey: row.subject_provider_key }),
    secretVersion: row.subject_key_secret_version,
  };
};

const getSubjectKeys = async (
  sql: postgres.Sql,
  scope: WorkspaceScope,
  deliveryId: string
): Promise<readonly ContactPrivacySubjectKey[]> => {
  const rows = await sql<readonly ExportDeliverySubjectKeyRow[]>`
    SELECT
      subject_key_algorithm,
      subject_key_format_version,
      subject_key_secret_version,
      subject_identity_kind,
      subject_provider_key,
      subject_key_digest
    FROM kurobara_core.export_delivery_subject_keys
    WHERE workspace_id = ${scope.workspaceId}
      AND delivery_id = ${deliveryId}
    ORDER BY
      subject_key_algorithm,
      subject_key_format_version,
      subject_key_secret_version,
      subject_identity_kind,
      subject_provider_key,
      subject_key_digest
  `;
  return rows.map(parseSubjectKey);
};

const sameSubjectKeys = (
  left: readonly ContactPrivacySubjectKey[],
  right: readonly ContactPrivacySubjectKey[]
): boolean =>
  left.length === right.length &&
  left.every((key, index) => {
    const candidate = right[index];
    return (
      candidate !== undefined &&
      subjectKeyIdentity(key) === subjectKeyIdentity(candidate)
    );
  });

const insertSubjectKeys = async (
  sql: postgres.Sql,
  scope: WorkspaceScope,
  deliveryId: string,
  linkedAt: number,
  subjectKeys: readonly ContactPrivacySubjectKey[]
): Promise<void> => {
  for (const key of subjectKeys) {
    await sql`
      INSERT INTO kurobara_core.export_delivery_subject_keys (
        workspace_id,
        delivery_id,
        subject_key_algorithm,
        subject_key_format_version,
        subject_key_secret_version,
        subject_identity_kind,
        subject_provider_key,
        subject_key_digest,
        linked_at
      ) VALUES (
        ${scope.workspaceId},
        ${deliveryId},
        ${key.algorithm},
        ${key.formatVersion},
        ${key.secretVersion},
        ${key.identityKind},
        ${key.providerKey ?? ""},
        ${key.digest},
        ${new Date(linkedAt)}
      )
    `;
  }
};

const insertRequest = (
  sql: postgres.Sql,
  scope: WorkspaceScope,
  input: PrepareExportDeliveryInput,
  delivery: ExportDelivery
) => sql`
  INSERT INTO kurobara_core.export_delivery_requests (
    workspace_id,
    idempotency_key,
    delivery_id,
    intent_hash,
    requested_at
  ) VALUES (
    ${scope.workspaceId},
    ${input.idempotencyKey},
    ${delivery.deliveryId},
    ${delivery.intentHash},
    ${new Date(input.delivery.preparedAt)}
  )
`;

const preparedResult = (delivery: ExportDelivery, replayed: boolean) =>
  delivery.state === "revoked"
    ? ({ delivery, status: "revoked" } as const)
    : ({ delivery, replayed, status: "prepared" } as const);

const validatePrepareInput = (
  scope: WorkspaceScope,
  input: PrepareExportDeliveryInput,
  subjectKeys: readonly ContactPrivacySubjectKey[]
): void => {
  if (
    input.delivery.manifest.workspaceId !== scope.workspaceId ||
    input.delivery.deliveryId !==
      `export-delivery-${input.delivery.intentHash.slice("sha256:".length)}` ||
    (generatedDatasetManifest(input.delivery.manifest) &&
      subjectKeys.length === 0)
  ) {
    throw new PostgresAdapterError(
      "export-delivery-input-invalid",
      "The export delivery does not match its workspace or immutable intention."
    );
  }
};

const replayByRequest = async (
  sql: postgres.Sql,
  scope: WorkspaceScope,
  input: PrepareExportDeliveryInput,
  subjectKeys: readonly ContactPrivacySubjectKey[]
): Promise<PrepareExportDeliveryResult | undefined> => {
  const stored = await getByRequest(sql, scope, input.idempotencyKey);
  if (stored === undefined) {
    return;
  }
  const storedSubjectKeys = await getSubjectKeys(sql, scope, stored.deliveryId);
  return stored.intentHash === input.delivery.intentHash &&
    sameManifest(stored.manifest, input.delivery.manifest) &&
    sameSubjectKeys(storedSubjectKeys, subjectKeys)
    ? preparedResult(stored, true)
    : { status: "idempotency-conflict" };
};

const replayByIntent = async (
  sql: postgres.Sql,
  scope: WorkspaceScope,
  input: PrepareExportDeliveryInput,
  subjectKeys: readonly ContactPrivacySubjectKey[]
): Promise<PrepareExportDeliveryResult | undefined> => {
  const stored = await getByIntent(sql, scope, input.delivery.intentHash);
  if (stored === undefined) {
    return;
  }
  const storedSubjectKeys = await getSubjectKeys(sql, scope, stored.deliveryId);
  if (
    stored.deliveryId !== input.delivery.deliveryId ||
    !sameManifest(stored.manifest, input.delivery.manifest) ||
    !sameSubjectKeys(storedSubjectKeys, subjectKeys)
  ) {
    throw new PostgresAdapterError(
      "export-delivery-intent-collision",
      "The export delivery intent hash conflicts with another immutable manifest."
    );
  }
  await insertRequest(sql, scope, input, stored);
  return preparedResult(stored, true);
};

type ExportDeliveryStorageSource = Readonly<{
  applicationId: string | null;
  capabilityId: string | null;
  capabilityVersion: string | null;
  generationId: string | null;
  generationPlanId: string | null;
  manifestVersion: "1.0.0" | "2.0.0";
  planHash: string | null;
  recipeId: string | null;
  recipeRevision: string | null;
  sourceKind: "generated-dataset" | "recipe-application";
}>;

const storageSource = (
  manifest: ExportDeliveryManifest
): ExportDeliveryStorageSource => {
  if (generatedDatasetManifest(manifest)) {
    return {
      applicationId: null,
      capabilityId: manifest.source.capabilityId,
      capabilityVersion: manifest.source.capabilityVersion,
      generationId: manifest.source.generationId,
      generationPlanId: manifest.source.generationPlanId,
      manifestVersion: "2.0.0",
      planHash: manifest.source.planHash,
      recipeId: null,
      recipeRevision: null,
      sourceKind: "generated-dataset",
    };
  }
  return {
    applicationId: manifest.applicationId,
    capabilityId: null,
    capabilityVersion: null,
    generationId: null,
    generationPlanId: null,
    manifestVersion: "1.0.0",
    planHash: null,
    recipeId: manifest.recipeId,
    recipeRevision: manifest.recipeRevision,
    sourceKind: "recipe-application",
  };
};

const insertPreparedDelivery = async (
  sql: postgres.Sql,
  scope: WorkspaceScope,
  input: PrepareExportDeliveryInput,
  subjectKeys: readonly ContactPrivacySubjectKey[]
): Promise<PrepareExportDeliveryResult> => {
  const source = storageSource(input.delivery.manifest);
  const effectiveExpiresAt = effectiveExpiry(input.delivery.manifest);
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
      prepared_at,
      manifest_version,
      source_kind,
      generation_id,
      generation_plan_id,
      plan_hash,
      capability_id,
      capability_version,
      effective_expires_at
    ) VALUES (
      ${scope.workspaceId},
      ${input.delivery.deliveryId},
      ${input.delivery.manifest.ownerActorId},
      ${input.delivery.intentHash},
      ${source.applicationId},
      ${input.delivery.manifest.datasetId},
      ${source.recipeId},
      ${source.recipeRevision},
      ${input.delivery.manifest.format},
      ${input.delivery.manifest.contentHash},
      ${input.delivery.manifest.contentLength},
      ${sql.json(toJsonValue(input.delivery.manifest))},
      ${new Date(input.delivery.preparedAt)},
      ${source.manifestVersion},
      ${source.sourceKind},
      ${source.generationId},
      ${source.generationPlanId},
      ${source.planHash},
      ${source.capabilityId},
      ${source.capabilityVersion},
      ${new Date(effectiveExpiresAt)}
    )
  `;
  const created: ExportDelivery = {
    ...input.delivery,
    effectiveExpiresAt,
    state: "prepared",
  };
  await insertSubjectKeys(
    sql,
    scope,
    created.deliveryId,
    created.preparedAt,
    subjectKeys
  );
  await insertRequest(sql, scope, input, created);
  return preparedResult(created, false);
};

const prepareExportDelivery = (
  sql: postgres.Sql,
  scope: WorkspaceScope,
  input: PrepareExportDeliveryInput
): Promise<PrepareExportDeliveryResult> =>
  sql.begin(async (transactionSql) => {
    const transaction = transactionSql as unknown as postgres.Sql;
    const subjectKeys = canonicalSubjectKeys(input.subjectKeys);
    validatePrepareInput(scope, input, subjectKeys);
    await lockPrepare(transaction, scope, input, subjectKeys);
    if (await subjectKeysAreRestricted(transaction, scope, subjectKeys)) {
      return { status: "subject-restricted" as const };
    }
    const requestReplay = await replayByRequest(
      transaction,
      scope,
      input,
      subjectKeys
    );
    if (requestReplay !== undefined) {
      return requestReplay;
    }
    const intentReplay = await replayByIntent(
      transaction,
      scope,
      input,
      subjectKeys
    );
    return (
      intentReplay ??
      insertPreparedDelivery(transaction, scope, input, subjectKeys)
    );
  }) as Promise<PrepareExportDeliveryResult>;

export const createPostgresExportDeliveryPersistence = (
  sql: postgres.Sql
): ExportDeliveryPersistencePort => ({
  complete: async (scope, input: CompleteExportDeliveryInput) =>
    sql.begin(async (transactionSql) => {
      const transaction = transactionSql as unknown as postgres.Sql;
      const delivery = await getDelivery(
        transaction,
        scope,
        input.deliveryId,
        input.ownerActorId,
        true
      );
      if (delivery === undefined) {
        return { status: "not-found-or-owner-mismatch" as const };
      }
      if (delivery.state === "revoked") {
        return { delivery, status: "revoked" as const };
      }
      if (
        input.contentHash !== delivery.manifest.contentHash ||
        input.contentLength !== delivery.manifest.contentLength
      ) {
        return { status: "proof-conflict" as const };
      }
      if (delivery.state === "delivered") {
        return {
          delivery,
          replayed: true,
          status: "delivered" as const,
        };
      }
      await transaction`
        INSERT INTO kurobara_core.export_delivery_events (
          workspace_id,
          delivery_id,
          event_type,
          recorded_at,
          content_hash,
          content_length
        ) VALUES (
          ${scope.workspaceId},
          ${delivery.deliveryId},
          'delivered',
          ${new Date(input.deliveredAt)},
          ${input.contentHash},
          ${input.contentLength}
        )
      `;
      const completed = await getDelivery(
        transaction,
        scope,
        input.deliveryId,
        input.ownerActorId
      );
      if (completed === undefined || completed.state !== "delivered") {
        throw new PostgresAdapterError(
          "export-delivery-completion-invalid",
          "The durable export delivery completion could not be read back."
        );
      }
      return {
        delivery: completed,
        replayed: false,
        status: "delivered" as const,
      };
    }),
  getOwned: (scope, deliveryId, ownerActorId) =>
    getDelivery(sql, scope, deliveryId, ownerActorId),
  prepare: (scope, input) => prepareExportDelivery(sql, scope, input),
  revoke: async (scope, input) =>
    sql.begin(async (transactionSql) => {
      const transaction = transactionSql as unknown as postgres.Sql;
      const delivery = await getDelivery(
        transaction,
        scope,
        input.deliveryId,
        input.ownerActorId,
        true
      );
      if (delivery === undefined) {
        return { status: "not-found-or-owner-mismatch" as const };
      }
      if (delivery.state === "revoked") {
        return { delivery, replayed: true, status: "revoked" as const };
      }
      await transaction`
        INSERT INTO kurobara_core.export_delivery_events (
          workspace_id,
          delivery_id,
          event_type,
          recorded_at,
          content_hash,
          content_length
        ) VALUES (
          ${scope.workspaceId},
          ${delivery.deliveryId},
          'revoked',
          ${new Date(input.revokedAt)},
          NULL,
          NULL
        )
      `;
      const revoked = await getDelivery(
        transaction,
        scope,
        input.deliveryId,
        input.ownerActorId
      );
      if (revoked === undefined || revoked.state !== "revoked") {
        throw new PostgresAdapterError(
          "export-delivery-revocation-invalid",
          "The durable export delivery revocation could not be read back."
        );
      }
      return { delivery: revoked, replayed: false, status: "revoked" as const };
    }),
});
