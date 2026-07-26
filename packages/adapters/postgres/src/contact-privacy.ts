import { createHash } from "node:crypto";

import {
  type ContactPrivacySubjectKey,
  type ContactPrivacyTombstone,
  type ContactPrivacyTombstoneReason,
  contactPrivacySubjectKeysEqual,
  contentHash,
  createContactPrivacyTombstone,
  instant,
  workspaceId,
} from "@kurobara/kernel";
import type {
  ContactPrivacyPersistencePort,
  RegisterContactPrivacyTombstoneInput,
  WorkspaceScope,
} from "@kurobara/ports";
import type postgres from "postgres";

import { PostgresAdapterError } from "./errors.ts";
import { toJsonValue } from "./json.ts";

type ContactPrivacyTombstoneRow = Readonly<{
  intent_hash: string;
  reason_code: string;
  registered_at: Date;
  subject_identity_kind: string;
  subject_key_algorithm: string;
  subject_key_digest: string;
  subject_key_format_version: string;
  subject_key_secret_version: string;
  subject_provider_key: string;
  tombstone_id: string;
  workspace_id: string;
}>;

const isTombstoneReason = (
  value: string
): value is ContactPrivacyTombstoneReason =>
  value === "provider-opt-out" ||
  value === "provider-deletion" ||
  value === "provider-claimed-email" ||
  value === "operator-subject-request";

const parseSubjectKey = (
  row: ContactPrivacyTombstoneRow
): ContactPrivacySubjectKey => {
  if (
    row.subject_key_algorithm !== "hmac-sha-256" ||
    row.subject_key_format_version !== "1.0.0" ||
    (row.subject_identity_kind !== "email" &&
      row.subject_identity_kind !== "provider-subject")
  ) {
    throw new PostgresAdapterError(
      "database-payload-invalid",
      "The stored contact privacy subject key is malformed."
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

const parseTombstone = (
  row: ContactPrivacyTombstoneRow
): ContactPrivacyTombstone => {
  if (!isTombstoneReason(row.reason_code)) {
    throw new PostgresAdapterError(
      "database-payload-invalid",
      "The stored contact privacy reason is malformed."
    );
  }
  const created = createContactPrivacyTombstone({
    intentHash: contentHash(row.intent_hash),
    reason: row.reason_code,
    registeredAt: instant(row.registered_at.getTime()),
    subjectKey: parseSubjectKey(row),
    workspaceId: workspaceId(row.workspace_id),
  });
  if (!created.ok || created.value.tombstoneId !== row.tombstone_id) {
    throw new PostgresAdapterError(
      "database-payload-invalid",
      "The stored contact privacy tombstone is malformed."
    );
  }
  return created.value;
};

const selectTombstone = (sql: postgres.Sql) => sql`
  tombstone.workspace_id,
  tombstone.tombstone_id,
  tombstone.subject_key_algorithm,
  tombstone.subject_key_format_version,
  tombstone.subject_key_secret_version,
  tombstone.subject_identity_kind,
  tombstone.subject_provider_key,
  tombstone.subject_key_digest,
  tombstone.reason_code,
  tombstone.intent_hash,
  tombstone.registered_at
`;

const findBySubjectKeys = async (
  sql: postgres.Sql,
  scope: WorkspaceScope,
  subjectKeys: readonly ContactPrivacySubjectKey[],
  lockForUpdate = false
): Promise<readonly ContactPrivacyTombstone[]> => {
  if (subjectKeys.length === 0) {
    return [];
  }
  const digests = [...new Set(subjectKeys.map((key) => key.digest))];
  const rows = await sql<readonly ContactPrivacyTombstoneRow[]>`
    SELECT ${selectTombstone(sql)}
    FROM kurobara_core.contact_privacy_tombstones AS tombstone
    WHERE tombstone.workspace_id = ${scope.workspaceId}
      AND tombstone.subject_key_digest = ANY(${digests})
    ORDER BY tombstone.registered_at, tombstone.tombstone_id
    ${lockForUpdate ? sql`FOR UPDATE OF tombstone` : sql``}
  `;
  return rows
    .map(parseTombstone)
    .filter((tombstone) =>
      subjectKeys.some((key) =>
        contactPrivacySubjectKeysEqual(key, tombstone.subjectKey)
      )
    );
};

const findByIdempotencyKey = async (
  sql: postgres.Sql,
  scope: WorkspaceScope,
  idempotencyKey: string
): Promise<ContactPrivacyTombstone | undefined> => {
  const rows = await sql<readonly ContactPrivacyTombstoneRow[]>`
    SELECT ${selectTombstone(sql)}
    FROM kurobara_core.contact_privacy_registration_requests AS request
    JOIN kurobara_core.contact_privacy_tombstones AS tombstone
      ON tombstone.workspace_id = request.workspace_id
      AND tombstone.tombstone_id = request.tombstone_id
      AND tombstone.intent_hash = request.intent_hash
    WHERE request.workspace_id = ${scope.workspaceId}
      AND request.idempotency_key = ${idempotencyKey}
    FOR UPDATE OF request, tombstone
  `;
  const [row] = rows;
  return row === undefined ? undefined : parseTombstone(row);
};

const lockRegistrationIdentities = async (
  sql: postgres.Sql,
  scope: WorkspaceScope,
  input: RegisterContactPrivacyTombstoneInput
): Promise<void> => {
  const lockKeys = [
    ["contact-privacy-request", scope.workspaceId, input.idempotencyKey].join(
      "\u001f"
    ),
    ...input.subjectKeys.all.map((key) =>
      [
        "contact-privacy-subject",
        scope.workspaceId,
        key.algorithm,
        key.formatVersion,
        key.secretVersion,
        key.identityKind,
        key.providerKey ?? "",
        key.digest,
        input.reason,
      ].join("\u001f")
    ),
    ...input.subjectKeys.all.map((key) =>
      [
        "contact-export-subject",
        scope.workspaceId,
        key.algorithm,
        key.formatVersion,
        key.secretVersion,
        key.identityKind,
        key.providerKey ?? "",
        key.digest,
      ].join("\u001f")
    ),
  ];
  for (const lockKey of [...new Set(lockKeys)].sort()) {
    await sql`
      SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0::bigint))
    `;
  }
};

const matchesRegistration = (
  proof: ContactPrivacyTombstone,
  input: RegisterContactPrivacyTombstoneInput
): boolean =>
  proof.reason === input.reason &&
  input.subjectKeys.all.some((key) =>
    contactPrivacySubjectKeysEqual(key, proof.subjectKey)
  );

const insertRegistrationRequest = async (
  sql: postgres.Sql,
  scope: WorkspaceScope,
  input: RegisterContactPrivacyTombstoneInput,
  proof: ContactPrivacyTombstone
): Promise<void> => {
  await sql`
    INSERT INTO kurobara_core.contact_privacy_registration_requests (
      workspace_id,
      idempotency_key,
      tombstone_id,
      intent_hash,
      requested_at
    ) VALUES (
      ${scope.workspaceId},
      ${input.idempotencyKey},
      ${proof.tombstoneId},
      ${proof.intentHash},
      ${new Date(input.registeredAt)}
    )
  `;
};

const insertTombstone = async (
  sql: postgres.Sql,
  proof: ContactPrivacyTombstone
): Promise<void> => {
  await sql`
    INSERT INTO kurobara_core.contact_privacy_tombstones (
      workspace_id,
      tombstone_id,
      subject_key_algorithm,
      subject_key_format_version,
      subject_key_secret_version,
      subject_identity_kind,
      subject_provider_key,
      subject_key_digest,
      reason_code,
      intent_hash,
      registered_at
    ) VALUES (
      ${proof.workspaceId},
      ${proof.tombstoneId},
      ${proof.subjectKey.algorithm},
      ${proof.subjectKey.formatVersion},
      ${proof.subjectKey.secretVersion},
      ${proof.subjectKey.identityKind},
      ${proof.subjectKey.providerKey ?? ""},
      ${proof.subjectKey.digest},
      ${proof.reason},
      ${proof.intentHash},
      ${new Date(proof.registeredAt)}
    )
  `;
};

const subjectKeyIdentity = (key: ContactPrivacySubjectKey): string =>
  [
    key.algorithm,
    key.formatVersion,
    key.secretVersion,
    key.identityKind,
    key.providerKey ?? "",
    key.digest,
  ].join("\u001f");

const uniqueSubjectKeys = (
  keys: readonly ContactPrivacySubjectKey[]
): readonly ContactPrivacySubjectKey[] => {
  const unique = new Map<string, ContactPrivacySubjectKey>();
  for (const key of keys) {
    unique.set(subjectKeyIdentity(key), key);
  }
  return [...unique.values()].sort((left, right) =>
    subjectKeyIdentity(left).localeCompare(subjectKeyIdentity(right))
  );
};

const insertTombstoneSubjectKeys = async (
  sql: postgres.Sql,
  proof: ContactPrivacyTombstone,
  subjectKeys: readonly ContactPrivacySubjectKey[]
): Promise<void> => {
  for (const key of uniqueSubjectKeys(subjectKeys)) {
    await sql`
      INSERT INTO kurobara_core.contact_privacy_tombstone_subject_keys (
        workspace_id,
        tombstone_id,
        subject_key_algorithm,
        subject_key_format_version,
        subject_key_secret_version,
        subject_identity_kind,
        subject_provider_key,
        subject_key_digest,
        linked_at
      ) VALUES (
        ${proof.workspaceId},
        ${proof.tombstoneId},
        ${key.algorithm},
        ${key.formatVersion},
        ${key.secretVersion},
        ${key.identityKind},
        ${key.providerKey ?? ""},
        ${key.digest},
        ${new Date(proof.registeredAt)}
      )
      ON CONFLICT DO NOTHING
    `;
  }
};

type DeliveryRevocationRow = Readonly<{
  delivered_at: Date | null;
  delivery_id: string;
  prepared_at: Date;
}>;

const revocationId = (
  proof: ContactPrivacyTombstone,
  deliveryId: string
): string =>
  `export-revocation-${createHash("sha256")
    .update(
      JSON.stringify([
        "kurobara-export-delivery-revocation",
        "1.0.0",
        proof.workspaceId,
        proof.tombstoneId,
        deliveryId,
      ])
    )
    .digest("hex")}`;

type PropagatedExportRevocations = Readonly<{
  affectedDeliveryCount: number;
  newlyRevokedDeliveryCount: number;
}>;

const propagateTombstoneToExportDeliveries = async (
  sql: postgres.Sql,
  proof: ContactPrivacyTombstone
): Promise<PropagatedExportRevocations> => {
  const matching = await sql<readonly { delivery_id: string }[]>`
    SELECT DISTINCT delivery_subject.delivery_id
    FROM kurobara_core.export_delivery_subject_keys AS delivery_subject
    JOIN kurobara_core.contact_privacy_tombstone_subject_keys
      AS tombstone_subject
      ON tombstone_subject.workspace_id = delivery_subject.workspace_id
      AND tombstone_subject.subject_key_algorithm =
        delivery_subject.subject_key_algorithm
      AND tombstone_subject.subject_key_format_version =
        delivery_subject.subject_key_format_version
      AND tombstone_subject.subject_key_secret_version =
        delivery_subject.subject_key_secret_version
      AND tombstone_subject.subject_identity_kind =
        delivery_subject.subject_identity_kind
      AND tombstone_subject.subject_provider_key =
        delivery_subject.subject_provider_key
      AND tombstone_subject.subject_key_digest =
        delivery_subject.subject_key_digest
    WHERE tombstone_subject.workspace_id = ${proof.workspaceId}
      AND tombstone_subject.tombstone_id = ${proof.tombstoneId}
    ORDER BY delivery_subject.delivery_id
  `;
  let newlyRevokedDeliveryCount = 0;
  for (const match of matching) {
    const rows = await sql<readonly DeliveryRevocationRow[]>`
      SELECT
        delivery.delivery_id,
        delivery.prepared_at,
        delivered.recorded_at AS delivered_at
      FROM kurobara_core.export_deliveries AS delivery
      LEFT JOIN kurobara_core.export_delivery_events AS delivered
        ON delivered.workspace_id = delivery.workspace_id
        AND delivered.delivery_id = delivery.delivery_id
        AND delivered.event_type = 'delivered'
      WHERE delivery.workspace_id = ${proof.workspaceId}
        AND delivery.delivery_id = ${match.delivery_id}
      FOR UPDATE OF delivery
    `;
    const delivery = rows[0];
    if (delivery === undefined) {
      throw new PostgresAdapterError(
        "contact-export-revocation-invalid",
        "A matched export delivery disappeared during revocation."
      );
    }
    const recordedAt = new Date(
      Math.max(
        proof.registeredAt,
        delivery.prepared_at.getTime(),
        delivery.delivered_at?.getTime() ?? 0
      )
    );
    const identifier = revocationId(proof, delivery.delivery_id);
    const insertedEvents = await sql<readonly { delivery_id: string }[]>`
      INSERT INTO kurobara_core.export_delivery_events (
        workspace_id,
        delivery_id,
        event_type,
        recorded_at,
        content_hash,
        content_length
      ) VALUES (
        ${proof.workspaceId},
        ${delivery.delivery_id},
        'revoked',
        ${recordedAt},
        NULL,
        NULL
      )
      ON CONFLICT (workspace_id, delivery_id, event_type) DO NOTHING
      RETURNING delivery_id
    `;
    newlyRevokedDeliveryCount += insertedEvents.length;
    const manifest = {
      deliveryId: delivery.delivery_id,
      reasonCode: proof.reason,
      revocationId: identifier,
      revokedAt: recordedAt.getTime(),
      tombstoneId: proof.tombstoneId,
      workspaceId: proof.workspaceId,
    };
    await sql`
      INSERT INTO kurobara_core.export_delivery_revocation_proofs (
        workspace_id,
        tombstone_id,
        delivery_id,
        revocation_id,
        reason_code,
        manifest,
        recorded_at
      ) VALUES (
        ${proof.workspaceId},
        ${proof.tombstoneId},
        ${delivery.delivery_id},
        ${identifier},
        ${proof.reason},
        ${sql.json(toJsonValue(manifest))},
        ${recordedAt}
      )
      ON CONFLICT (workspace_id, tombstone_id, delivery_id) DO NOTHING
    `;
  }
  return {
    affectedDeliveryCount: matching.length,
    newlyRevokedDeliveryCount,
  };
};

const completeRegistration = async (
  sql: postgres.Sql,
  input: RegisterContactPrivacyTombstoneInput,
  proof: ContactPrivacyTombstone,
  replayed: boolean
) => {
  await insertTombstoneSubjectKeys(sql, proof, input.subjectKeys.all);
  const revocations = await propagateTombstoneToExportDeliveries(sql, proof);
  return {
    ...revocations,
    proof,
    replayed,
    status: "registered" as const,
  };
};

export const createPostgresContactPrivacyPersistence = (
  sql: postgres.Sql
): ContactPrivacyPersistencePort => ({
  findBySubjectKeys: (scope, subjectKeys) =>
    findBySubjectKeys(sql, scope, subjectKeys),
  register: async (scope, input) => {
    const result = await sql.begin(async (transactionSql) => {
      const transaction = transactionSql as unknown as postgres.Sql;
      await lockRegistrationIdentities(transaction, scope, input);

      const byIdempotency = await findByIdempotencyKey(
        transaction,
        scope,
        input.idempotencyKey
      );
      if (byIdempotency !== undefined) {
        return matchesRegistration(byIdempotency, input)
          ? completeRegistration(transaction, input, byIdempotency, true)
          : { status: "idempotency-conflict" as const };
      }

      const matching = (
        await findBySubjectKeys(transaction, scope, input.subjectKeys.all, true)
      ).find((proof) => proof.reason === input.reason);
      if (matching !== undefined) {
        await insertRegistrationRequest(transaction, scope, input, matching);
        return completeRegistration(transaction, input, matching, true);
      }

      const created = createContactPrivacyTombstone({
        intentHash: input.intentHash,
        reason: input.reason,
        registeredAt: input.registeredAt,
        subjectKey: input.subjectKeys.current,
        workspaceId: scope.workspaceId,
      });
      if (!created.ok) {
        throw new PostgresAdapterError(
          "contact-privacy-registration-invalid",
          created.error.message
        );
      }
      await insertTombstone(transaction, created.value);
      await insertRegistrationRequest(transaction, scope, input, created.value);
      return completeRegistration(transaction, input, created.value, false);
    });
    return result as Awaited<
      ReturnType<ContactPrivacyPersistencePort["register"]>
    >;
  },
});
