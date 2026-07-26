import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";

import { actorId, instant, workspaceId } from "@kurobara/kernel";
import type { ApiKeyAuthenticationPort, VerifiedApiKey } from "@kurobara/ports";
import type postgres from "postgres";

import { PostgresAdapterError } from "./errors.ts";

const API_KEY_PATTERN = /^kbr_([A-Za-z0-9_-]{12,64})\.([A-Za-z0-9_-]{43})$/u;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/u;
const PERMISSION_PATTERN = /^[a-z][a-z0-9-]*:[a-z][a-z0-9-]*$/u;

type ApiKeyRow = Readonly<{
  actor_id: string;
  api_key_id: string;
  credential_digest: string;
  permissions: string[];
  workspace_id: string;
}>;

export type BootstrapApiKeyInput = Readonly<{
  actorId: string;
  expiresAt?: number;
  label: string;
  permissions: readonly string[];
  workspaceId: string;
}>;

export type BootstrappedApiKey = Readonly<{
  credentialId: string;
  presentedKey: string;
}>;

const digestCredential = (presentedKey: string): string =>
  createHash("sha256").update(presentedKey, "utf8").digest("hex");

const parsePresentedKey = (
  presentedKey: string
): Readonly<{ credentialId: string; digest: string }> | undefined => {
  const match = API_KEY_PATTERN.exec(presentedKey);
  const credentialId = match?.[1];
  if (credentialId === undefined) {
    return;
  }
  return { credentialId, digest: digestCredential(presentedKey) };
};

const equalDigest = (left: string, right: string): boolean => {
  if (!(DIGEST_PATTERN.test(left) && DIGEST_PATTERN.test(right))) {
    return false;
  }
  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
};

const normalizePermissions = (permissions: readonly string[]): string[] => {
  const normalized = [...new Set(permissions)].sort();
  if (
    normalized.length === 0 ||
    normalized.some((permission) => !PERMISSION_PATTERN.test(permission))
  ) {
    throw new PostgresAdapterError(
      "api-key-permissions-invalid",
      "API key permissions must be non-empty canonical action identifiers."
    );
  }
  return normalized;
};

const parseVerifiedKey = (row: ApiKeyRow): VerifiedApiKey => {
  if (
    !(
      API_KEY_PATTERN.test(`kbr_${row.api_key_id}.${"a".repeat(43)}`) &&
      DIGEST_PATTERN.test(row.credential_digest) &&
      Array.isArray(row.permissions)
    )
  ) {
    throw new PostgresAdapterError(
      "database-payload-invalid",
      "The stored API key record is malformed."
    );
  }
  return {
    actorId: actorId(row.actor_id),
    authenticationMode: "api-key",
    credentialId: row.api_key_id,
    permissions: normalizePermissions(row.permissions),
    workspaceId: workspaceId(row.workspace_id),
  };
};

export const createPostgresApiKeyAuthentication = (
  sql: postgres.Sql
): ApiKeyAuthenticationPort => ({
  authenticate: async ({ now, presentedKey }) => {
    const parsed = parsePresentedKey(presentedKey);
    if (parsed === undefined) {
      return;
    }
    const rows = await sql<readonly ApiKeyRow[]>`
      SELECT
        stored_key.api_key_id,
        stored_key.workspace_id,
        stored_key.actor_id,
        stored_key.credential_digest,
        stored_key.permissions
      FROM kurobara_core.api_keys AS stored_key
      INNER JOIN kurobara_core.workspaces AS workspace
        ON workspace.workspace_id = stored_key.workspace_id
      WHERE stored_key.api_key_id = ${parsed.credentialId}
        AND stored_key.revoked_at IS NULL
        AND (
          stored_key.expires_at IS NULL
          OR stored_key.expires_at > ${new Date(now)}
        )
        AND workspace.status = 'active'
      LIMIT 1
    `;
    const row = rows[0];
    if (
      row === undefined ||
      !equalDigest(row.credential_digest, parsed.digest)
    ) {
      return;
    }
    return parseVerifiedKey(row);
  },
});

export const bootstrapPostgresApiKey = async (
  sql: postgres.Sql,
  input: BootstrapApiKeyInput
): Promise<BootstrappedApiKey> => {
  const label = input.label.trim();
  if (label.length === 0 || label.length > 100) {
    throw new PostgresAdapterError(
      "api-key-label-invalid",
      "API key labels must contain between 1 and 100 characters."
    );
  }
  const permissions = normalizePermissions(input.permissions);
  const normalizedActorId = actorId(input.actorId);
  const normalizedWorkspaceId = workspaceId(input.workspaceId);
  const normalizedExpiry =
    input.expiresAt === undefined ? undefined : instant(input.expiresAt);
  const credentialId = randomUUID().replaceAll("-", "");
  const secret = randomBytes(32).toString("base64url");
  const presentedKey = `kbr_${credentialId}.${secret}`;
  const digest = digestCredential(presentedKey);

  await sql.begin(async (transactionSql) => {
    const transaction = transactionSql as unknown as postgres.Sql;
    await transaction`
      INSERT INTO kurobara_core.workspaces (workspace_id)
      VALUES (${normalizedWorkspaceId})
      ON CONFLICT (workspace_id) DO NOTHING
    `;
    await transaction`
      INSERT INTO kurobara_core.api_keys (
        api_key_id,
        workspace_id,
        actor_id,
        credential_digest,
        label,
        permissions,
        expires_at
      ) VALUES (
        ${credentialId},
        ${normalizedWorkspaceId},
        ${normalizedActorId},
        ${digest},
        ${label},
        ${permissions},
        ${normalizedExpiry === undefined ? null : new Date(normalizedExpiry)}
      )
    `;
  });

  return { credentialId, presentedKey };
};
