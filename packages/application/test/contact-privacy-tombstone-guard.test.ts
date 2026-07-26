import assert from "node:assert/strict";
import test from "node:test";

import {
  type ContactPrivacySubjectKey,
  contentHash,
  createContactPrivacyTombstone,
  instant,
  workspaceId,
} from "@kurobara/kernel";
import type {
  ContactPrivacyPersistencePort,
  ContactPrivacySubjectKeyDerivationPort,
} from "@kurobara/ports";

import {
  createContactPrivacyTombstoneGuard,
  createHmacContactPrivacySubjectKeyDeriver,
} from "../src/contact-privacy.ts";

const HMAC_CONFIGURATION_PATTERN = /one current key/u;
const workspace = workspaceId("workspace-privacy-guard");
const emailSubject = {
  kind: "email",
  value: "contact@example.invalid",
} as const;
const providerSubject = {
  kind: "provider-subject",
  providerKey: "apollo-people-search",
  value: "apollo-person-1",
} as const;
const emailKey: ContactPrivacySubjectKey = {
  algorithm: "hmac-sha-256",
  digest: "1".repeat(64),
  formatVersion: "1.0.0",
  identityKind: "email",
  secretVersion: "privacy-key-v1",
};
const providerKey: ContactPrivacySubjectKey = {
  algorithm: "hmac-sha-256",
  digest: "2".repeat(64),
  formatVersion: "1.0.0",
  identityKind: "provider-subject",
  providerKey: "apollo-people-search",
  secretVersion: "privacy-key-v1",
};

const keyDeriver: ContactPrivacySubjectKeyDerivationPort = {
  derive: (subject) =>
    Promise.resolve({
      all: [subject.kind === "email" ? emailKey : providerKey],
      current: subject.kind === "email" ? emailKey : providerKey,
    }),
};

const unusedRegister: ContactPrivacyPersistencePort["register"] = () =>
  Promise.reject(new Error("registration is outside the guard"));

test("fails closed for an empty subject set without persistence access", async () => {
  let derivations = 0;
  let lookups = 0;
  const guard = createContactPrivacyTombstoneGuard({
    persistence: {
      findBySubjectKeys: () => {
        lookups += 1;
        return Promise.resolve([]);
      },
      register: unusedRegister,
    },
    subjectKeys: {
      derive: () => {
        derivations += 1;
        return Promise.resolve({ all: [emailKey], current: emailKey });
      },
    },
  });

  assert.equal(await guard.allows({ workspaceId: workspace }, []), false);
  assert.equal(derivations, 0);
  assert.equal(lookups, 0);
});

test("allows only an exact tombstone-free subject lookup", async () => {
  const lookups: Parameters<
    ContactPrivacyPersistencePort["findBySubjectKeys"]
  >[] = [];
  const guard = createContactPrivacyTombstoneGuard({
    persistence: {
      findBySubjectKeys: (scope, keys) => {
        lookups.push(structuredClone([scope, keys]));
        return Promise.resolve([]);
      },
      register: unusedRegister,
    },
    subjectKeys: keyDeriver,
  });

  assert.equal(
    await guard.allows({ workspaceId: workspace }, [
      providerSubject,
      emailSubject,
    ]),
    true
  );
  assert.deepEqual(lookups, [
    [{ workspaceId: workspace }, [providerKey, emailKey]],
  ]);
});

test("denies an exact tombstone match", async () => {
  const created = createContactPrivacyTombstone({
    intentHash: contentHash(`sha256:${"3".repeat(64)}`),
    reason: "operator-subject-request",
    registeredAt: instant(1_900_000_000_000),
    subjectKey: providerKey,
    workspaceId: workspace,
  });
  assert.equal(created.ok, true);
  if (!created.ok) {
    return;
  }
  const guard = createContactPrivacyTombstoneGuard({
    persistence: {
      findBySubjectKeys: () => Promise.resolve([created.value]),
      register: unusedRegister,
    },
    subjectKeys: keyDeriver,
  });

  assert.equal(
    await guard.allows({ workspaceId: workspace }, [providerSubject]),
    false
  );
});

test("fails closed when key derivation or persistence is unavailable", async () => {
  let lookupCalls = 0;
  const invalidKeyGuard = createContactPrivacyTombstoneGuard({
    persistence: {
      findBySubjectKeys: () => {
        lookupCalls += 1;
        return Promise.resolve([]);
      },
      register: unusedRegister,
    },
    subjectKeys: {
      derive: () => Promise.reject(new Error("invalid privacy key")),
    },
  });
  const unavailablePersistenceGuard = createContactPrivacyTombstoneGuard({
    persistence: {
      findBySubjectKeys: () =>
        Promise.reject(new Error("database unavailable")),
      register: unusedRegister,
    },
    subjectKeys: keyDeriver,
  });

  assert.equal(
    await invalidKeyGuard.allows({ workspaceId: workspace }, [emailSubject]),
    false
  );
  assert.equal(lookupCalls, 0);
  assert.equal(
    await unavailablePersistenceGuard.allows({ workspaceId: workspace }, [
      emailSubject,
    ]),
    false
  );
});

test("rejects invalid HMAC key rings and hostile subject identities", async () => {
  assert.throws(
    () => createHmacContactPrivacySubjectKeyDeriver([]),
    HMAC_CONFIGURATION_PATTERN
  );
  assert.throws(
    () =>
      createHmacContactPrivacySubjectKeyDeriver([
        {
          current: true,
          keyMaterial: new Uint8Array(31),
          version: "privacy-key-v1",
        },
      ]),
    HMAC_CONFIGURATION_PATTERN
  );
  const deriver = createHmacContactPrivacySubjectKeyDeriver([
    {
      current: true,
      keyMaterial: new Uint8Array(32).fill(7),
      version: "privacy-key-v1",
    },
  ]);

  await assert.rejects(
    deriver.derive({ kind: "email", value: "recipient@@example.invalid" })
  );
  await assert.rejects(
    deriver.derive({
      kind: "provider-subject",
      providerKey: "INVALID PROVIDER",
      value: "subject",
    })
  );
});
