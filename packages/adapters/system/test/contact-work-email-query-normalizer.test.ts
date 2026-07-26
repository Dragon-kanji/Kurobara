import assert from "node:assert/strict";
import test from "node:test";

import {
  capabilityId,
  type DatasetGenerationQueryValue,
} from "@kurobara/kernel";

import {
  contactWorkEmailResolveCapability,
  contactWorkEmailVerifyCapability,
  createContactWorkEmailQueryNormalizer,
} from "../src/index.ts";

const CONTRACT_ERROR_PATTERN = /exact canonical execution-query contract/u;
const SCHEMA_ID =
  "https://schemas.kurobara.invalid/schemas/contacts/work-email-execution-query/1.0.0";
const CONTRACT = Object.freeze({
  catalogFingerprint: `sha256:${"1".repeat(64)}`,
  catalogVersion: "test",
  schemaFingerprint: `sha256:${"2".repeat(64)}`,
  schemaId: SCHEMA_ID,
  schemaVersion: "1.0.0",
});

const selectedContact = (
  index: number,
  includeWorkEmail: boolean,
  providerKey = "apollo-people-search"
) => ({
  candidate: {
    department: "sales",
    display_name: `Contact ${index}`,
    identity_completeness: "full",
    job_title: "Sales Director",
    observed_at_ms: 1_900_000_000_000 + index,
    organization_domain: `company-${index}.example`,
    organization_id: `company-${index}`,
    organization_name: `Company ${index}`,
    person_country_code: "ES",
    profile_url: `https://network.example/contact-${index}`,
    seniority: "director",
  },
  identity: {
    display_name: `Contact ${index}`,
    first_name: "Contact",
    last_name: String(index),
    observed_at_ms: 1_900_000_000_100 + index,
    profile_url: `https://network.example/contact-${index}`,
  },
  provider_identity: {
    provider_key: providerKey,
    provider_subject_id: `provider-person-${index}`,
  },
  source_record_id: `contact-${index}`,
  ...(includeWorkEmail
    ? {
        work_email: {
          confidence: 0.9,
          email: `contact-${index}@company-${index}.example`,
          observed_at_ms: 1_900_000_000_200 + index,
          source: "provider_unspecified",
          verification: "unknown",
        },
      }
    : {}),
});

const query = (
  kind: "resolve" | "verify",
  count = 3,
  providerKey = "apollo-people-search"
): DatasetGenerationQueryValue => ({
  operation_kind: kind,
  result_kind: "contact_work_email",
  selected_contacts: Array.from({ length: count }, (_, index) =>
    selectedContact(index + 1, kind === "verify", providerKey)
  ),
  source_dataset_id: "contact-identity-dataset",
});

const normalizer = createContactWorkEmailQueryNormalizer({
  contract: CONTRACT,
});

const normalize = (
  kind: "resolve" | "verify",
  value: DatasetGenerationQueryValue
) =>
  normalizer.normalize({
    capability:
      kind === "resolve"
        ? contactWorkEmailResolveCapability
        : contactWorkEmailVerifyCapability,
    query: value,
  });

test("normalizes exact resolve and verify queries for one through three contacts", () => {
  for (const kind of ["resolve", "verify"] as const) {
    for (const count of [1, 2, 3]) {
      const input = query(kind, count);
      const result = normalize(kind, input);

      assert.equal(result.status, "accepted");
      if (result.status === "accepted") {
        assert.deepEqual(
          result.capability,
          kind === "resolve"
            ? contactWorkEmailResolveCapability
            : contactWorkEmailVerifyCapability
        );
        assert.deepEqual(result.contract, CONTRACT);
        assert.equal(
          result.normalizerVersion,
          "kurobara-v1-contact-work-email-1"
        );
        assert.deepEqual(result.value, input);
        assert.equal(Object.isFrozen(result.value), true);
        const normalized = result.value as Readonly<
          Record<string, DatasetGenerationQueryValue>
        >;
        assert.equal(Object.isFrozen(normalized.selected_contacts), true);
      }
    }
  }
});

test("normalizes exact Prospeo resolve and verify queries", () => {
  for (const kind of ["resolve", "verify"] as const) {
    const input = query(kind, 3, "prospeo-person-search");
    const result = normalize(kind, input);

    assert.equal(result.status, "accepted");
    if (result.status === "accepted") {
      assert.deepEqual(result.value, input);
    }
  }
});

test("requires the capability to match the exact operation kind", () => {
  assert.equal(normalize("resolve", query("verify")).status, "rejected");
  assert.equal(normalize("verify", query("resolve")).status, "rejected");
  assert.equal(
    normalizer.normalize({
      capability: {
        capabilityId: capabilityId("contacts.work-email.resolve"),
        capabilityVersion: "2.0.0",
      },
      query: query("resolve"),
    }).status,
    "rejected"
  );
});

test("rejects hostile source, provider, identity, and email values", () => {
  const invalidQueries: Record<string, unknown>[] = [];

  const blankSource = structuredClone(query("resolve")) as Record<
    string,
    unknown
  >;
  blankSource.source_dataset_id = " ";
  invalidQueries.push(blankSource);

  const foreignProvider = structuredClone(query("resolve")) as Record<
    string,
    unknown
  >;
  const foreignSelection = foreignProvider.selected_contacts as Record<
    string,
    unknown
  >[];
  const foreignIdentity = foreignSelection[0]?.provider_identity as Record<
    string,
    unknown
  >;
  foreignIdentity.provider_key = "hostile-provider";
  invalidQueries.push(foreignProvider);

  const mixedProviders = structuredClone(query("resolve", 2)) as Record<
    string,
    unknown
  >;
  const mixedSelection = mixedProviders.selected_contacts as Record<
    string,
    unknown
  >[];
  const mixedIdentity = mixedSelection[1]?.provider_identity as Record<
    string,
    unknown
  >;
  mixedIdentity.provider_key = "prospeo-person-search";
  invalidQueries.push(mixedProviders);

  const duplicateProviderSubject = structuredClone(query("resolve")) as Record<
    string,
    unknown
  >;
  const duplicateSelection =
    duplicateProviderSubject.selected_contacts as Record<string, unknown>[];
  const firstProvider = duplicateSelection[0]?.provider_identity as Record<
    string,
    unknown
  >;
  const secondProvider = duplicateSelection[1]?.provider_identity as Record<
    string,
    unknown
  >;
  secondProvider.provider_subject_id = firstProvider.provider_subject_id;
  invalidQueries.push(duplicateProviderSubject);

  const obfuscated = structuredClone(query("resolve")) as Record<
    string,
    unknown
  >;
  const obfuscatedSelection = obfuscated.selected_contacts as Record<
    string,
    unknown
  >[];
  const obfuscatedCandidate = obfuscatedSelection[0]?.candidate as Record<
    string,
    unknown
  >;
  obfuscatedCandidate.identity_completeness = "obfuscated";
  invalidQueries.push(obfuscated);

  const mismatchedIdentity = structuredClone(query("resolve")) as Record<
    string,
    unknown
  >;
  const mismatchedSelection = mismatchedIdentity.selected_contacts as Record<
    string,
    unknown
  >[];
  const identity = mismatchedSelection[0]?.identity as Record<string, unknown>;
  identity.display_name = "Another Person";
  invalidQueries.push(mismatchedIdentity);

  const hostileEmail = structuredClone(query("verify")) as Record<
    string,
    unknown
  >;
  const hostileSelection = hostileEmail.selected_contacts as Record<
    string,
    unknown
  >[];
  const email = hostileSelection[0]?.work_email as Record<string, unknown>;
  email.email = "recipient@@company.example";
  invalidQueries.push(hostileEmail);

  const hostileEmailSource = structuredClone(query("verify")) as Record<
    string,
    unknown
  >;
  const hostileEmailSourceSelection =
    hostileEmailSource.selected_contacts as Record<string, unknown>[];
  const emailEvidence = hostileEmailSourceSelection[0]?.work_email as Record<
    string,
    unknown
  >;
  emailEvidence.source = "public";
  invalidQueries.push(hostileEmailSource);

  for (const input of invalidQueries) {
    const kind = input.operation_kind as "resolve" | "verify";
    assert.equal(
      normalize(kind, input as DatasetGenerationQueryValue).status,
      "rejected"
    );
  }
});

test("rejects a missing verify email, resolve email leakage, and non-exact shapes", () => {
  const missingVerifyEmail = structuredClone(query("verify")) as Record<
    string,
    unknown
  >;
  const verifySelection = missingVerifyEmail.selected_contacts as Record<
    string,
    unknown
  >[];
  const firstVerify = verifySelection[0];
  assert.ok(firstVerify);
  Reflect.deleteProperty(firstVerify, "work_email");

  const resolveLeak = structuredClone(query("resolve")) as Record<
    string,
    unknown
  >;
  const resolveSelection = resolveLeak.selected_contacts as Record<
    string,
    unknown
  >[];
  const firstResolve = resolveSelection[0];
  assert.ok(firstResolve);
  firstResolve.work_email = selectedContact(1, true).work_email;

  const extraTopLevel = structuredClone(query("resolve")) as Record<
    string,
    unknown
  >;
  extraTopLevel.unexpected = true;

  const duplicateSource = structuredClone(query("resolve")) as Record<
    string,
    unknown
  >;
  const duplicateSourceSelection = duplicateSource.selected_contacts as Record<
    string,
    unknown
  >[];
  const firstSource = duplicateSourceSelection[0]?.source_record_id;
  const secondSource = duplicateSourceSelection[1];
  assert.ok(secondSource);
  secondSource.source_record_id = firstSource;

  for (const [kind, input] of [
    ["verify", missingVerifyEmail],
    ["resolve", resolveLeak],
    ["resolve", extraTopLevel],
    ["resolve", duplicateSource],
  ] as const) {
    assert.equal(
      normalize(kind, input as DatasetGenerationQueryValue).status,
      "rejected"
    );
  }
});

test("requires the exact canonical work-email contract", () => {
  assert.throws(
    () =>
      createContactWorkEmailQueryNormalizer({
        contract: { ...CONTRACT, schemaId: "wrong" },
      }),
    CONTRACT_ERROR_PATTERN
  );
  assert.throws(
    () =>
      createContactWorkEmailQueryNormalizer({
        contract: { ...CONTRACT, catalogVersion: " " },
      }),
    CONTRACT_ERROR_PATTERN
  );
});
