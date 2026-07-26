import assert from "node:assert/strict";
import test from "node:test";

import {
  CONTACT_PRIVACY_TOMBSTONE_REASONS,
  type ContactPrivacyTombstone,
  contactPrivacySubjectKeysEqual,
  createContactPrivacyTombstone,
  idempotencyKey,
  instant,
  type WorkspaceId,
  workspaceId,
} from "@kurobara/kernel";
import type {
  ContactPrivacyPersistencePort,
  RegisterContactPrivacyTombstoneInput,
  WorkspaceScope,
} from "@kurobara/ports";

import {
  createHmacContactPrivacySubjectKeyDeriver,
  makeAuthorizeContactEffect,
  makeRegisterContactPrivacyTombstone,
} from "../src/contact-privacy.ts";

const now = instant(1_800_000_000_000);
const hour = 60 * 60 * 1000;
const workspaceA = workspaceId("workspace-privacy-a");
const workspaceB = workspaceId("workspace-privacy-b");
const subject = { kind: "email", value: "synthetic@example.invalid" } as const;
const HMAC_DIGEST_PATTERN = /^[0-9a-f]{64}$/u;

const policy = {
  expiresAt: instant(now + 48 * hour),
  purposeRefs: ["synthetic-research"],
  rules: {
    "professional-email": {
      allowedActions: ["enrich"] as const,
      maxRetentionMilliseconds: 24 * hour,
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

class MemoryContactPrivacyPersistence implements ContactPrivacyPersistencePort {
  readonly requests = new Map<string, string>();
  readonly proofs = new Map<string, ContactPrivacyTombstone>();

  private keyOfProof(proof: { tombstoneId: string; workspaceId: WorkspaceId }) {
    return `${proof.workspaceId}\0${proof.tombstoneId}`;
  }

  private createProof(
    scope: WorkspaceScope,
    input: RegisterContactPrivacyTombstoneInput
  ) {
    const created = createContactPrivacyTombstone({
      intentHash: input.intentHash,
      reason: input.reason,
      registeredAt: input.registeredAt,
      subjectKey: input.subjectKeys.current,
      workspaceId: scope.workspaceId,
    });
    return created.ok ? created.value : undefined;
  }

  findBySubjectKeys(
    scope: WorkspaceScope,
    candidateKeys: RegisterContactPrivacyTombstoneInput["subjectKeys"]["all"]
  ) {
    return Promise.resolve(
      [...this.proofs.values()].filter(
        (proof) =>
          proof.workspaceId === scope.workspaceId &&
          candidateKeys.some((key) =>
            contactPrivacySubjectKeysEqual(key, proof.subjectKey)
          )
      )
    );
  }

  register(scope: WorkspaceScope, input: RegisterContactPrivacyTombstoneInput) {
    const requestKey = `${scope.workspaceId}\0${input.idempotencyKey}`;
    const requestTombstoneId = this.requests.get(requestKey);
    if (requestTombstoneId !== undefined) {
      const proof = this.proofs.get(
        `${scope.workspaceId}\0${requestTombstoneId}`
      );
      if (
        proof === undefined ||
        proof.reason !== input.reason ||
        !input.subjectKeys.all.some((key) =>
          contactPrivacySubjectKeysEqual(key, proof.subjectKey)
        )
      ) {
        return Promise.resolve({ status: "idempotency-conflict" as const });
      }
      return Promise.resolve({
        proof: structuredClone(proof),
        replayed: true,
        status: "registered" as const,
      });
    }
    const existing = [...this.proofs.values()].find(
      (candidateProof) =>
        candidateProof.workspaceId === scope.workspaceId &&
        candidateProof.reason === input.reason &&
        input.subjectKeys.all.some((key) =>
          contactPrivacySubjectKeysEqual(key, candidateProof.subjectKey)
        )
    );
    const proof = existing ?? this.createProof(scope, input);
    if (proof === undefined) {
      throw new Error("invalid test tombstone");
    }
    this.proofs.set(this.keyOfProof(proof), structuredClone(proof));
    this.requests.set(requestKey, proof.tombstoneId);
    return Promise.resolve({
      proof: structuredClone(proof),
      replayed: existing !== undefined,
      status: "registered" as const,
    });
  }
}

const subjectKeys = createHmacContactPrivacySubjectKeyDeriver([
  {
    current: true,
    keyMaterial: new Uint8Array(32).fill(7),
    version: "privacy-key-v1",
  },
]);

const setup = () => {
  const persistence = new MemoryContactPrivacyPersistence();
  const dependencies = {
    clock: { now: () => Promise.resolve(now) },
    persistence,
    subjectKeys,
  };
  return {
    authorize: makeAuthorizeContactEffect(dependencies),
    persistence,
    register: makeRegisterContactPrivacyTombstone(dependencies),
  };
};

test("derives stable versioned HMAC keys without returning the raw identity", async () => {
  const first = await subjectKeys.derive(subject);
  const second = await subjectKeys.derive({
    kind: "email",
    value: " SYNTHETIC@example.invalid ",
  });

  assert.deepEqual(first, second);
  assert.match(first.current.digest, HMAC_DIGEST_PATTERN);
  assert.equal(JSON.stringify(first).includes(subject.value), false);
});

test("replays one proof and rejects an idempotency collision", async () => {
  const { register } = setup();
  const request = {
    idempotencyKey: idempotencyKey("privacy-register-1"),
    reason: "operator-subject-request" as const,
    subject,
    workspaceId: workspaceA,
  };

  const first = await register(request);
  const replay = await register(request);
  const sameIntentNewKey = await register({
    ...request,
    idempotencyKey: idempotencyKey("privacy-register-2"),
  });
  const collision = await register({
    ...request,
    reason: "provider-deletion",
  });

  assert.equal(first.ok, true);
  assert.equal(replay.ok, true);
  assert.equal(sameIntentNewKey.ok, true);
  assert.equal(collision.ok, false);
  if (!(first.ok && replay.ok && sameIntentNewKey.ok)) {
    return;
  }
  assert.equal(first.value.replayed, false);
  assert.equal(replay.value.replayed, true);
  assert.equal(sameIntentNewKey.value.replayed, true);
  assert.deepEqual(replay.value.proof, first.value.proof);
  assert.deepEqual(sameIntentNewKey.value.proof, first.value.proof);
  assert.equal("digest" in first.value.proof.subjectKeyVersion, false);
});

for (const reason of CONTACT_PRIVACY_TOMBSTONE_REASONS) {
  test(`blocks the external effect and fallback with ${reason}`, async () => {
    const { authorize, register } = setup();
    const registered = await register({
      idempotencyKey: idempotencyKey(`privacy-${reason}`),
      reason,
      subject,
      workspaceId: workspaceA,
    });
    assert.equal(registered.ok, true);

    const authorization = await authorize({
      facts,
      policy,
      subject,
      workspaceId: workspaceA,
    });

    assert.equal(authorization.ok, true);
    if (!authorization.ok) {
      return;
    }
    assert.deepEqual(authorization.value.decision.reasonCodes, [reason]);
    assert.equal(authorization.value.decision.stopExternalEffects, true);
    assert.equal(authorization.value.decision.stopFallback, true);
    assert.equal(authorization.value.matchedTombstoneIds.length, 1);
  });
}

test("keeps tombstones tenant-scoped and still applies TTL without one", async () => {
  const { authorize, register } = setup();
  await register({
    idempotencyKey: idempotencyKey("privacy-tenant-a"),
    reason: "provider-opt-out",
    subject,
    workspaceId: workspaceA,
  });

  const otherTenant = await authorize({
    facts: {
      ...facts,
      requestedData: [
        {
          dataClass: "professional-email",
          observedAt: instant(now - 24 * hour),
        },
      ],
    },
    policy,
    subject,
    workspaceId: workspaceB,
  });

  assert.equal(otherTenant.ok, true);
  if (!otherTenant.ok) {
    return;
  }
  assert.deepEqual(otherTenant.value.decision.reasonCodes, ["ttl-expired"]);
  assert.deepEqual(otherTenant.value.matchedTombstoneIds, []);
});

test("retains historical keys during rotation so old tombstones still block", async () => {
  const persistence = new MemoryContactPrivacyPersistence();
  const oldKeys = createHmacContactPrivacySubjectKeyDeriver([
    {
      current: true,
      keyMaterial: new Uint8Array(32).fill(1),
      version: "privacy-key-old",
    },
  ]);
  const register = makeRegisterContactPrivacyTombstone({
    clock: { now: () => Promise.resolve(now) },
    persistence,
    subjectKeys: oldKeys,
  });
  await register({
    idempotencyKey: idempotencyKey("privacy-before-rotation"),
    reason: "provider-deletion",
    subject,
    workspaceId: workspaceA,
  });

  const rotatedKeys = createHmacContactPrivacySubjectKeyDeriver([
    {
      current: false,
      keyMaterial: new Uint8Array(32).fill(1),
      version: "privacy-key-old",
    },
    {
      current: true,
      keyMaterial: new Uint8Array(32).fill(2),
      version: "privacy-key-current",
    },
  ]);
  const authorize = makeAuthorizeContactEffect({
    clock: { now: () => Promise.resolve(now) },
    persistence,
    subjectKeys: rotatedKeys,
  });
  const registerAfterRotation = makeRegisterContactPrivacyTombstone({
    clock: { now: () => Promise.resolve(instant(now + hour)) },
    persistence,
    subjectKeys: rotatedKeys,
  });
  const replayAfterRotation = await registerAfterRotation({
    idempotencyKey: idempotencyKey("privacy-after-rotation"),
    reason: "provider-deletion",
    subject,
    workspaceId: workspaceA,
  });
  const decision = await authorize({
    facts,
    policy,
    subject,
    workspaceId: workspaceA,
  });

  assert.equal(decision.ok, true);
  assert.equal(replayAfterRotation.ok, true);
  if (decision.ok && replayAfterRotation.ok) {
    assert.deepEqual(decision.value.decision.reasonCodes, [
      "provider-deletion",
    ]);
    assert.equal(replayAfterRotation.value.replayed, true);
    assert.equal(persistence.proofs.size, 1);
  }
});
