import type {
  ContentHash,
  IdempotencyKey,
  Instant,
  WorkspaceId,
} from "./value-objects.ts";

export const CONTACT_PRIVACY_TOMBSTONE_REASONS = [
  "provider-opt-out",
  "provider-deletion",
  "provider-claimed-email",
  "operator-subject-request",
] as const;

export type ContactPrivacyTombstoneReason =
  (typeof CONTACT_PRIVACY_TOMBSTONE_REASONS)[number];

export type ContactPrivacySubject =
  | Readonly<{ kind: "email"; value: string }>
  | Readonly<{
      kind: "provider-subject";
      providerKey: string;
      value: string;
    }>;

export type ContactPrivacySubjectKey = Readonly<{
  algorithm: "hmac-sha-256";
  digest: string;
  formatVersion: "1.0.0";
  identityKind: ContactPrivacySubject["kind"];
  providerKey?: string;
  secretVersion: string;
}>;

export type ContactPrivacyTombstoneId = string & {
  readonly __brand: "ContactPrivacyTombstoneId";
};

export type ContactPrivacyTombstone = Readonly<{
  intentHash: ContentHash;
  reason: ContactPrivacyTombstoneReason;
  registeredAt: Instant;
  subjectKey: ContactPrivacySubjectKey;
  tombstoneId: ContactPrivacyTombstoneId;
  workspaceId: WorkspaceId;
}>;

export type ContactPrivacyTombstoneProof = Readonly<{
  reason: ContactPrivacyTombstoneReason;
  registeredAt: Instant;
  subjectKeyVersion: Readonly<{
    algorithm: ContactPrivacySubjectKey["algorithm"];
    formatVersion: ContactPrivacySubjectKey["formatVersion"];
    identityKind: ContactPrivacySubjectKey["identityKind"];
    providerKey?: string;
    secretVersion: string;
  }>;
  tombstoneId: ContactPrivacyTombstoneId;
  workspaceId: WorkspaceId;
}>;

export type ContactPrivacyRegistration = Readonly<{
  idempotencyKey: IdempotencyKey;
  requestedAt: Instant;
  tombstoneId: ContactPrivacyTombstoneId;
  workspaceId: WorkspaceId;
}>;

export type CreateContactPrivacyTombstoneInput = Readonly<{
  intentHash: ContentHash;
  reason: ContactPrivacyTombstoneReason;
  registeredAt: Instant;
  subjectKey: ContactPrivacySubjectKey;
  workspaceId: WorkspaceId;
}>;

export type ContactPrivacyModelFailureCode =
  | "subject-key-invalid"
  | "tombstone-reason-invalid";

export type ContactPrivacyModelFailure = Readonly<{
  code: ContactPrivacyModelFailureCode;
  message: string;
}>;

export type ContactPrivacyModelResult<Value> =
  | Readonly<{ ok: true; value: Value }>
  | Readonly<{ error: ContactPrivacyModelFailure; ok: false }>;

const DIGEST_PATTERN = /^[0-9a-f]{64}$/u;
const VERSION_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/u;
const PROVIDER_KEY_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/u;

const reject = (
  code: ContactPrivacyModelFailureCode,
  message: string
): ContactPrivacyModelResult<never> => ({
  error: { code, message },
  ok: false,
});

export const contactPrivacySubjectKeysEqual = (
  left: ContactPrivacySubjectKey,
  right: ContactPrivacySubjectKey
): boolean =>
  left.algorithm === right.algorithm &&
  left.digest === right.digest &&
  left.formatVersion === right.formatVersion &&
  left.identityKind === right.identityKind &&
  left.providerKey === right.providerKey &&
  left.secretVersion === right.secretVersion;

export const validateContactPrivacySubjectKey = (
  candidate: ContactPrivacySubjectKey
): ContactPrivacyModelResult<ContactPrivacySubjectKey> => {
  if (
    candidate.algorithm !== "hmac-sha-256" ||
    candidate.formatVersion !== "1.0.0" ||
    !DIGEST_PATTERN.test(candidate.digest) ||
    !VERSION_PATTERN.test(candidate.secretVersion)
  ) {
    return reject(
      "subject-key-invalid",
      "The contact privacy subject key is not a supported versioned HMAC digest."
    );
  }
  if (
    (candidate.identityKind === "email" &&
      candidate.providerKey !== undefined) ||
    (candidate.identityKind === "provider-subject" &&
      (candidate.providerKey === undefined ||
        !PROVIDER_KEY_PATTERN.test(candidate.providerKey)))
  ) {
    return reject(
      "subject-key-invalid",
      "The contact privacy subject key namespace is invalid."
    );
  }
  return { ok: true, value: structuredClone(candidate) };
};

export const createContactPrivacyTombstone = (
  input: CreateContactPrivacyTombstoneInput
): ContactPrivacyModelResult<ContactPrivacyTombstone> => {
  const key = validateContactPrivacySubjectKey(input.subjectKey);
  if (!key.ok) {
    return key;
  }
  if (!CONTACT_PRIVACY_TOMBSTONE_REASONS.includes(input.reason)) {
    return reject(
      "tombstone-reason-invalid",
      "The contact privacy tombstone reason is not supported."
    );
  }
  return {
    ok: true,
    value: {
      intentHash: input.intentHash,
      reason: input.reason,
      registeredAt: input.registeredAt,
      subjectKey: key.value,
      tombstoneId:
        `privacy-ts-${input.intentHash.slice("sha256:".length)}` as ContactPrivacyTombstoneId,
      workspaceId: input.workspaceId,
    },
  };
};

export const contactPrivacyTombstoneProof = (
  tombstone: ContactPrivacyTombstone
): ContactPrivacyTombstoneProof => ({
  reason: tombstone.reason,
  registeredAt: tombstone.registeredAt,
  subjectKeyVersion: {
    algorithm: tombstone.subjectKey.algorithm,
    formatVersion: tombstone.subjectKey.formatVersion,
    identityKind: tombstone.subjectKey.identityKind,
    ...(tombstone.subjectKey.providerKey === undefined
      ? {}
      : { providerKey: tombstone.subjectKey.providerKey }),
    secretVersion: tombstone.subjectKey.secretVersion,
  },
  tombstoneId: tombstone.tombstoneId,
  workspaceId: tombstone.workspaceId,
});
