import {
  type ContactPrivacySubject,
  type ContactPrivacySubjectKey,
  type ContactPrivacyTombstoneProof,
  type ContactPrivacyTombstoneReason,
  contactPrivacyTombstoneProof,
  contentHash,
  type DomainResult,
  fail,
  type IdempotencyKey,
  succeed,
  type WorkspaceId,
} from "@kurobara/kernel";
import {
  type ContactPrivacyDecision,
  type ContactPrivacyFacts,
  type ContactPrivacyPolicySnapshot,
  evaluateContactPrivacy,
} from "@kurobara/policy-engine";
import type {
  ClockPort,
  ContactPrivacyGuardPort,
  ContactPrivacyPersistencePort,
  ContactPrivacySubjectKeyDerivationPort,
  ContactPrivacySubjectKeySet,
  VerifiedApiKey,
} from "@kurobara/ports";

export type ContactPrivacyTombstoneGuardDependencies = Readonly<{
  persistence: ContactPrivacyPersistencePort;
  subjectKeys: ContactPrivacySubjectKeyDerivationPort;
}>;

/** Fail-closed exact-subject tombstone guard for planning and JIT effects. */
export const createContactPrivacyTombstoneGuard = (
  dependencies: ContactPrivacyTombstoneGuardDependencies
): ContactPrivacyGuardPort => ({
  allows: async (scope, subjects) => {
    if (subjects.length === 0) {
      return false;
    }
    try {
      const derived = await Promise.all(
        subjects.map((subject) => dependencies.subjectKeys.derive(subject))
      );
      const keys = derived.flatMap((entry) => entry.all);
      const tombstones = await dependencies.persistence.findBySubjectKeys(
        scope,
        keys
      );
      return tombstones.length === 0;
    } catch {
      return false;
    }
  },
});

export type ContactPrivacyHmacSecret = Readonly<{
  current: boolean;
  keyMaterial: Uint8Array;
  version: string;
}>;

export type RegisterContactPrivacyTombstoneRequest = Readonly<{
  idempotencyKey: IdempotencyKey;
  reason: ContactPrivacyTombstoneReason;
  subject: ContactPrivacySubject;
  workspaceId: WorkspaceId;
}>;

export type RegisterContactPrivacyTombstoneFailureCode =
  | "idempotency-conflict"
  | "subject-invalid";

export type RegisterContactPrivacyTombstoneFailure = Readonly<{
  code: RegisterContactPrivacyTombstoneFailureCode;
  message: string;
}>;

export type RegisterContactPrivacyTombstoneSuccess = Readonly<{
  affectedDeliveryCount: number;
  newlyRevokedDeliveryCount: number;
  proof: ContactPrivacyTombstoneProof;
  replayed: boolean;
}>;

export type RegisterContactPrivacyTombstoneResult = DomainResult<
  RegisterContactPrivacyTombstoneSuccess,
  RegisterContactPrivacyTombstoneFailure
>;

export type RegisterContactPrivacyTombstoneDependencies = Readonly<{
  clock: ClockPort;
  persistence: ContactPrivacyPersistencePort;
  subjectKeys: ContactPrivacySubjectKeyDerivationPort;
}>;

export type AuthorizeContactEffectRequest = Readonly<{
  facts: Omit<ContactPrivacyFacts, "now">;
  policy: ContactPrivacyPolicySnapshot;
  subject: ContactPrivacySubject;
  workspaceId: WorkspaceId;
}>;

export type AuthorizeContactEffectFailure = Readonly<{
  code: "subject-invalid";
  message: string;
}>;

export type AuthorizeContactEffectSuccess = Readonly<{
  decision: ContactPrivacyDecision;
  matchedTombstoneIds: readonly string[];
}>;

export type AuthorizeContactEffectResult = DomainResult<
  AuthorizeContactEffectSuccess,
  AuthorizeContactEffectFailure
>;

export type AuthorizeContactEffectDependencies = Readonly<{
  clock: ClockPort;
  persistence: ContactPrivacyPersistencePort;
  subjectKeys: ContactPrivacySubjectKeyDerivationPort;
}>;

const VERSION_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/u;
const PROVIDER_KEY_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/u;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+$/u;
const MINIMUM_HMAC_SECRET_BYTES = 32;

class ContactPrivacySubjectInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ContactPrivacySubjectInputError";
  }
}

const bytesToHex = (bytes: ArrayBuffer): string =>
  [...new Uint8Array(bytes)]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");

const normalizeSubject = (
  subject: ContactPrivacySubject
): Readonly<{
  identityKind: ContactPrivacySubject["kind"];
  providerKey?: string;
  value: string;
}> => {
  const value = subject.value.trim().normalize("NFC");
  if (subject.kind === "email") {
    const canonicalEmail = value.toLowerCase();
    if (
      canonicalEmail.length > 320 ||
      !EMAIL_PATTERN.test(canonicalEmail) ||
      canonicalEmail.split("@").length !== 2
    ) {
      throw new ContactPrivacySubjectInputError(
        "The contact privacy email identity is invalid."
      );
    }
    return { identityKind: "email", value: canonicalEmail };
  }
  if (
    !PROVIDER_KEY_PATTERN.test(subject.providerKey) ||
    value.length === 0 ||
    value.length > 1024
  ) {
    throw new ContactPrivacySubjectInputError(
      "The contact privacy provider identity is invalid."
    );
  }
  return {
    identityKind: "provider-subject",
    providerKey: subject.providerKey,
    value,
  };
};

const encodeUtf8 = (value: string): ArrayBuffer => {
  const encoded = new TextEncoder().encode(value);
  const buffer = new ArrayBuffer(encoded.byteLength);
  new Uint8Array(buffer).set(encoded);
  return buffer;
};

const subjectMessage = (
  normalized: ReturnType<typeof normalizeSubject>
): ArrayBuffer =>
  encodeUtf8(
    JSON.stringify([
      "kurobara-contact-privacy-subject",
      "1.0.0",
      normalized.identityKind,
      normalized.providerKey ?? "",
      normalized.value,
    ])
  );

export const createHmacContactPrivacySubjectKeyDeriver = (
  configuredSecrets: readonly ContactPrivacyHmacSecret[]
): ContactPrivacySubjectKeyDerivationPort => {
  if (
    configuredSecrets.length === 0 ||
    configuredSecrets.filter((secret) => secret.current).length !== 1 ||
    new Set(configuredSecrets.map((secret) => secret.version)).size !==
      configuredSecrets.length ||
    configuredSecrets.some(
      (secret) =>
        !VERSION_PATTERN.test(secret.version) ||
        secret.keyMaterial.byteLength < MINIMUM_HMAC_SECRET_BYTES
    )
  ) {
    throw new Error(
      "Contact privacy HMAC secrets require unique versions, one current key, and at least 256 bits per key."
    );
  }

  const secrets = configuredSecrets
    .map((secret) => ({
      current: secret.current,
      keyMaterial: Uint8Array.from(secret.keyMaterial),
      version: secret.version,
    }))
    .sort((left, right) => left.version.localeCompare(right.version));
  const importedKeys = new Map<string, Promise<CryptoKey>>();

  const importSecret = (
    secret: (typeof secrets)[number]
  ): Promise<CryptoKey> => {
    const existing = importedKeys.get(secret.version);
    if (existing !== undefined) {
      return existing;
    }
    const imported = crypto.subtle.importKey(
      "raw",
      secret.keyMaterial,
      { hash: "SHA-256", name: "HMAC" },
      false,
      ["sign"]
    );
    importedKeys.set(secret.version, imported);
    return imported;
  };

  return {
    derive: async (subject): Promise<ContactPrivacySubjectKeySet> => {
      const normalized = normalizeSubject(subject);
      const message = subjectMessage(normalized);
      const keys = await Promise.all(
        secrets.map(
          async (secret): Promise<ContactPrivacySubjectKey> => ({
            algorithm: "hmac-sha-256",
            digest: bytesToHex(
              await crypto.subtle.sign(
                "HMAC",
                await importSecret(secret),
                message
              )
            ),
            formatVersion: "1.0.0",
            identityKind: normalized.identityKind,
            ...(normalized.providerKey === undefined
              ? {}
              : { providerKey: normalized.providerKey }),
            secretVersion: secret.version,
          })
        )
      );
      const currentIndex = secrets.findIndex((secret) => secret.current);
      const current = keys[currentIndex];
      if (current === undefined) {
        throw new Error("The current contact privacy HMAC key is unavailable.");
      }
      return { all: keys, current };
    },
  };
};

const registrationIntentHash = async (
  subjectKey: ContactPrivacySubjectKey,
  reason: ContactPrivacyTombstoneReason
) => {
  const content = encodeUtf8(
    JSON.stringify([
      "kurobara-contact-privacy-tombstone",
      "1.0.0",
      subjectKey.algorithm,
      subjectKey.formatVersion,
      subjectKey.secretVersion,
      subjectKey.identityKind,
      subjectKey.providerKey ?? "",
      subjectKey.digest,
      reason,
    ])
  );
  const digest = bytesToHex(await crypto.subtle.digest("SHA-256", content));
  return contentHash(`sha256:${digest}`);
};

const subjectFailure = (): Readonly<{
  code: "subject-invalid";
  message: string;
}> => ({
  code: "subject-invalid",
  message: "The contact privacy subject identity is invalid.",
});

export const makeRegisterContactPrivacyTombstone =
  (dependencies: RegisterContactPrivacyTombstoneDependencies) =>
  async (
    request: RegisterContactPrivacyTombstoneRequest
  ): Promise<RegisterContactPrivacyTombstoneResult> => {
    let subjectKeys: ContactPrivacySubjectKeySet;
    try {
      subjectKeys = await dependencies.subjectKeys.derive(request.subject);
    } catch (error) {
      if (error instanceof ContactPrivacySubjectInputError) {
        return fail(subjectFailure());
      }
      throw error;
    }
    const [registeredAt, intentHash] = await Promise.all([
      dependencies.clock.now(),
      registrationIntentHash(subjectKeys.current, request.reason),
    ]);
    const result = await dependencies.persistence.register(
      { workspaceId: request.workspaceId },
      {
        idempotencyKey: request.idempotencyKey,
        intentHash,
        reason: request.reason,
        registeredAt,
        subjectKeys,
      }
    );
    if (result.status === "idempotency-conflict") {
      return fail({
        code: "idempotency-conflict",
        message:
          "The contact privacy registration key is already bound to another intention.",
      });
    }
    return succeed({
      affectedDeliveryCount: result.affectedDeliveryCount ?? 0,
      newlyRevokedDeliveryCount: result.newlyRevokedDeliveryCount ?? 0,
      proof: contactPrivacyTombstoneProof(result.proof),
      replayed: result.replayed,
    });
  };

export type RestrictContactPrivacyRequest = Readonly<{
  actor: VerifiedApiKey;
  idempotencyKey: IdempotencyKey;
  reason: ContactPrivacyTombstoneReason;
  subject: ContactPrivacySubject;
}>;

export type RestrictContactPrivacyFailure =
  | RegisterContactPrivacyTombstoneFailure
  | Readonly<{
      code: "authority-permission-missing";
      message: string;
    }>;

export type RestrictContactPrivacyResult = DomainResult<
  RegisterContactPrivacyTombstoneSuccess,
  RestrictContactPrivacyFailure
>;

export const makeRestrictContactPrivacy =
  (
    dependencies: RegisterContactPrivacyTombstoneDependencies &
      Readonly<{ requiredPermission: string }>
  ) =>
  async (
    request: RestrictContactPrivacyRequest
  ): Promise<RestrictContactPrivacyResult> => {
    if (!request.actor.permissions.includes(dependencies.requiredPermission)) {
      return fail({
        code: "authority-permission-missing",
        message:
          "The authenticated actor lacks permission to register Contact privacy restrictions.",
      });
    }
    const registration = await makeRegisterContactPrivacyTombstone(
      dependencies
    )({
      idempotencyKey: request.idempotencyKey,
      reason: request.reason,
      subject: request.subject,
      workspaceId: request.actor.workspaceId,
    });
    return registration;
  };

export const makeAuthorizeContactEffect =
  (dependencies: AuthorizeContactEffectDependencies) =>
  async (
    request: AuthorizeContactEffectRequest
  ): Promise<AuthorizeContactEffectResult> => {
    let subjectKeys: ContactPrivacySubjectKeySet;
    try {
      subjectKeys = await dependencies.subjectKeys.derive(request.subject);
    } catch (error) {
      if (error instanceof ContactPrivacySubjectInputError) {
        return fail(subjectFailure());
      }
      throw error;
    }
    const [now, tombstones] = await Promise.all([
      dependencies.clock.now(),
      dependencies.persistence.findBySubjectKeys(
        { workspaceId: request.workspaceId },
        subjectKeys.all
      ),
    ]);
    const activeRestrictions = [
      ...request.facts.activeRestrictions,
      ...tombstones.map((tombstone) => tombstone.reason),
    ].filter((reason, index, reasons) => reasons.indexOf(reason) === index);
    const decision = evaluateContactPrivacy(request.policy, {
      ...request.facts,
      activeRestrictions,
      now,
    });
    return succeed({
      decision,
      matchedTombstoneIds: tombstones.map((tombstone) => tombstone.tombstoneId),
    });
  };
