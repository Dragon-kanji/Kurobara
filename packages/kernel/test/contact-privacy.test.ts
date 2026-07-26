import assert from "node:assert/strict";
import test from "node:test";

import {
  contactPrivacyTombstoneProof,
  contentHash,
  createContactPrivacyTombstone,
  instant,
  validateContactPrivacySubjectKey,
  workspaceId,
} from "../src/index.ts";

const subjectKey = {
  algorithm: "hmac-sha-256",
  digest: "a".repeat(64),
  formatVersion: "1.0.0",
  identityKind: "email",
  secretVersion: "v1",
} as const;

test("creates a PII-free deterministic tombstone proof", () => {
  const created = createContactPrivacyTombstone({
    intentHash: contentHash(`sha256:${"b".repeat(64)}`),
    reason: "provider-opt-out",
    registeredAt: instant(1_800_000_000_000),
    subjectKey,
    workspaceId: workspaceId("workspace-privacy"),
  });

  assert.equal(created.ok, true);
  if (!created.ok) {
    return;
  }
  assert.equal(created.value.tombstoneId, `privacy-ts-${"b".repeat(64)}`);
  assert.equal(JSON.stringify(created.value).includes("person@"), false);
  const proof = contactPrivacyTombstoneProof(created.value);
  assert.equal(JSON.stringify(proof).includes(subjectKey.digest), false);
});

test("rejects malformed HMAC digests and provider namespaces", () => {
  assert.equal(
    validateContactPrivacySubjectKey({ ...subjectKey, digest: "not-a-digest" })
      .ok,
    false
  );
  assert.equal(
    validateContactPrivacySubjectKey({
      ...subjectKey,
      identityKind: "provider-subject",
    }).ok,
    false
  );
  assert.equal(
    validateContactPrivacySubjectKey({
      ...subjectKey,
      identityKind: "provider-subject",
      providerKey: "hunter",
    }).ok,
    true
  );
});
