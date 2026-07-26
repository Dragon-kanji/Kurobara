import assert from "node:assert/strict";
import test from "node:test";

import {
  createContactCandidate,
  createContactIdentityOperation,
  createContactIdentityResolution,
  createContactProviderIdentity,
  createContactWorkEmailOperation,
  datasetId,
  instant,
  recordId,
  revealContactCandidateIdentity,
  workspaceId,
} from "../src/index.ts";

test("accepts a professional candidate without contact details", () => {
  const result = createContactCandidate({
    contactId: recordId("contact-1"),
    department: "sales",
    displayName: "Synthetic Contact",
    identityCompleteness: "full",
    jobTitle: "Director",
    observedAt: instant(1000),
    organizationDomain: "synthetic.example",
    organizationId: "company-1",
    organizationName: "Synthetic Company",
    personCountryCode: "ES",
    profileUrl: null,
    seniority: "director",
  });
  assert.equal(result.ok, true);
});

test("rejects hostile candidate keys instead of copying contact details", () => {
  const result = createContactCandidate({
    contactId: recordId("contact-hostile"),
    department: "sales",
    displayName: "Synthetic Contact",
    email: "forbidden-contact-detail",
    identityCompleteness: "full",
    jobTitle: "Director",
    observedAt: instant(1000),
    organizationDomain: "synthetic.example",
    organizationId: "company-1",
    organizationName: "Synthetic Company",
    personCountryCode: "ES",
    phone: "forbidden-contact-detail",
    profileUrl: null,
    seniority: "director",
  } as unknown as Parameters<typeof createContactCandidate>[0]);

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, "contact-candidate-invalid");
  }
});

test("rejects invalid seniority values received across an untyped boundary", () => {
  const result = createContactCandidate({
    contactId: recordId("contact-invalid-seniority"),
    department: "sales",
    displayName: "Synthetic Contact",
    identityCompleteness: "full",
    jobTitle: "Director",
    observedAt: instant(1000),
    organizationDomain: "synthetic.example",
    organizationId: "company-1",
    organizationName: "Synthetic Company",
    personCountryCode: "ES",
    profileUrl: null,
    seniority: "executive-overlord",
  } as unknown as Parameters<typeof createContactCandidate>[0]);

  assert.equal(result.ok, false);
});

test("accepts obfuscated identities and rejects undeclared completeness", () => {
  const candidate = {
    contactId: recordId("contact-obfuscated"),
    department: "sales",
    displayName: "S. Contact",
    identityCompleteness: "obfuscated",
    jobTitle: "Director",
    observedAt: instant(1000),
    organizationDomain: "synthetic.example",
    organizationId: "company-1",
    organizationName: "Synthetic Company",
    personCountryCode: "ES",
    profileUrl: null,
    seniority: "director",
  } as const;

  assert.equal(createContactCandidate(candidate).ok, true);
  assert.equal(
    createContactCandidate({
      ...candidate,
      identityCompleteness: "partial",
    } as unknown as Parameters<typeof createContactCandidate>[0]).ok,
    false
  );
});

test("rejects the retired fullName alias", () => {
  const result = createContactCandidate({
    contactId: recordId("contact-retired-alias"),
    department: "sales",
    displayName: "Synthetic Contact",
    fullName: "Synthetic Contact",
    identityCompleteness: "full",
    jobTitle: "Director",
    observedAt: instant(1000),
    organizationDomain: "synthetic.example",
    organizationId: "company-1",
    organizationName: "Synthetic Company",
    personCountryCode: "ES",
    profileUrl: null,
    seniority: "director",
  } as unknown as Parameters<typeof createContactCandidate>[0]);

  assert.equal(result.ok, false);
});

test("projects a strict internal provider identity and rejects hostile keys", () => {
  const accepted = createContactProviderIdentity({
    providerKey: "synthetic-provider",
    providerSubjectId: "subject-1",
  });
  assert.deepEqual(accepted, {
    ok: true,
    value: {
      providerKey: "synthetic-provider",
      providerSubjectId: "subject-1",
    },
  });

  const rejected = createContactProviderIdentity({
    providerKey: "synthetic-provider",
    providerPayload: { email: "forbidden-contact-detail" },
    providerSubjectId: "subject-1",
  } as Parameters<typeof createContactProviderIdentity>[0]);
  assert.equal(rejected.ok, false);
  if (!rejected.ok) {
    assert.equal(rejected.error.code, "contact-provider-identity-invalid");
  }
});

test("rejects more than three selected work-email records", () => {
  const result = createContactWorkEmailOperation({
    budget: { limit: 4, unit: "credits" },
    contactDatasetId: datasetId("contacts"),
    contactRecordIds: ["a", "b", "c", "d"].map(recordId),
    deadline: instant(2000),
    kind: "resolve",
    operationId: "resolve-1",
    state: "planned",
    workspaceId: workspaceId("workspace"),
  });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, "contact-selection-invalid");
  }
});

test("accepts a strict full identity and rejects incidental coordinates", () => {
  const identity = {
    displayName: "Synthetic Person",
    firstName: "Synthetic",
    identityCompleteness: "full",
    lastName: "Person",
    observedAt: instant(1100),
    profileUrl: "https://www.linkedin.com/in/synthetic-person",
  } as const;

  assert.deepEqual(createContactIdentityResolution(identity), {
    ok: true,
    value: identity,
  });
  for (const extra of [
    { email: "forbidden@example.invalid" },
    { phone: "synthetic-phone.invalid" },
  ]) {
    const result = createContactIdentityResolution({
      ...identity,
      ...extra,
    } as unknown as Parameters<typeof createContactIdentityResolution>[0]);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error.code, "contact-identity-invalid");
    }
  }
  for (const profileUrl of [
    "https://user:secret@example.com/profile",
    "https://example.com:8443/profile",
    "https://",
  ]) {
    assert.equal(
      createContactIdentityResolution({ ...identity, profileUrl }).ok,
      false
    );
  }
  assert.equal(createContactIdentityResolution(null as never).ok, false);
});

test("reveals only identity fields while preserving employment evidence", () => {
  const contact = {
    candidate: {
      contactId: recordId("contact-selected"),
      department: "sales",
      displayName: "Synthetic P.",
      identityCompleteness: "obfuscated" as const,
      jobTitle: "Director",
      observedAt: instant(1000),
      organizationDomain: "synthetic.example",
      organizationId: "company-1",
      organizationName: "Synthetic Company",
      personCountryCode: "ES",
      profileUrl: null,
      seniority: "director" as const,
    },
    providerIdentity: {
      providerKey: "apollo-people-search",
      providerSubjectId: "subject-1",
    },
  };
  const result = revealContactCandidateIdentity(contact, {
    displayName: "Synthetic Person",
    firstName: "Synthetic",
    identityCompleteness: "full",
    lastName: "Person",
    observedAt: instant(1100),
    profileUrl: "https://www.linkedin.com/in/synthetic-person",
  });

  if (!result.ok) {
    assert.fail(result.error.message);
  }
  assert.equal(result.ok, true);
  assert.deepEqual(result.value.candidate, {
    ...contact.candidate,
    displayName: "Synthetic Person",
    identityCompleteness: "full",
    profileUrl: "https://www.linkedin.com/in/synthetic-person",
  });
  assert.equal(result.value.candidate.observedAt, instant(1000));
  assert.equal(result.value.identity.observedAt, instant(1100));

  const replay = revealContactCandidateIdentity(
    { ...contact, candidate: result.value.candidate },
    result.value.identity
  );
  assert.equal(replay.ok, false);
  if (!replay.ok) {
    assert.equal(replay.error.code, "contact-identity-state-invalid");
  }
  assert.equal(
    revealContactCandidateIdentity(null as never, result.value.identity).ok,
    false
  );
});

test("plans at most three strict identity selections", () => {
  const accepted = createContactIdentityOperation({
    authorityEnvelopeId: "authority",
    budget: { limit: 3, unit: "requests" },
    contactDatasetId: datasetId("contacts"),
    contactRecordIds: [recordId("a"), recordId("b"), recordId("c")],
    deadline: instant(2000),
    kind: "reveal",
    operationId: "identity-1",
    state: "planned",
    workspaceId: workspaceId("workspace"),
  });
  assert.equal(accepted.ok, true);

  const rejected = createContactIdentityOperation({
    authorityEnvelopeId: "authority",
    budget: { limit: 4, unit: "requests" },
    contactDatasetId: datasetId("contacts"),
    contactRecordIds: ["a", "b", "c", "d"].map(recordId),
    deadline: instant(2000),
    kind: "reveal",
    operationId: "identity-2",
    state: "planned",
    workspaceId: workspaceId("workspace"),
  });
  assert.equal(rejected.ok, false);
});
