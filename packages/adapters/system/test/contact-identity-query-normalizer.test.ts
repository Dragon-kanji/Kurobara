import assert from "node:assert/strict";
import test from "node:test";

import {
  capabilityId,
  type DatasetGenerationQueryValue,
} from "@kurobara/kernel";

import {
  contactIdentityRevealCapability,
  createContactIdentityQueryNormalizer,
} from "../src/index.ts";

const IDENTITY_QUERY_SCHEMA_ID =
  "https://schemas.kurobara.invalid/schemas/contacts/identity-execution-query/1.0.0";
const EXACT_CONTRACT_PATTERN = /exact canonical execution-query contract/u;
const CONTRACT = Object.freeze({
  catalogFingerprint: `sha256:${"e".repeat(64)}`,
  catalogVersion: "test",
  schemaFingerprint: `sha256:${"f".repeat(64)}`,
  schemaId: IDENTITY_QUERY_SCHEMA_ID,
  schemaVersion: "1.0.0",
});

const selectedContact = (
  index: number,
  providerKey = "apollo-people-search"
) => ({
  candidate: {
    department: "sales",
    display_name: `Contact ${index}`,
    identity_completeness: "obfuscated",
    job_title: "Sales Director",
    observed_at_ms: 1_900_000_000_000 + index,
    organization_domain: `company-${index}.example`,
    organization_id: `company-${index}`,
    organization_name: `Company ${index}`,
    person_country_code: "ES",
    profile_url: null,
    seniority: "director",
  },
  provider_identity: {
    provider_key: providerKey,
    provider_subject_id: `provider-person-${index}`,
  },
  source_record_id: `contact-${index}`,
});

const validQuery = (
  count = 3,
  providerKey = "apollo-people-search"
): DatasetGenerationQueryValue => ({
  result_kind: "contact_identity",
  selected_contacts: Array.from({ length: count }, (_, index) =>
    selectedContact(index + 1, providerKey)
  ),
  source_dataset_id: "contact-source-dataset",
});

const normalize = (query: DatasetGenerationQueryValue) =>
  createContactIdentityQueryNormalizer({ contract: CONTRACT }).normalize({
    capability: contactIdentityRevealCapability,
    query,
  });

test("normalizes the exact bounded Apollo contact identity query", () => {
  for (const count of [1, 2, 3]) {
    const query = validQuery(count);
    const result = normalize(query);

    assert.equal(result.status, "accepted");
    if (result.status === "accepted") {
      assert.deepEqual(result.capability, {
        capabilityId: "contacts.identity.reveal",
        capabilityVersion: "1.0.0",
      });
      assert.deepEqual(result.contract, CONTRACT);
      assert.equal(result.normalizerVersion, "kurobara-v1-contact-identity-1");
      assert.deepEqual(result.value, query);
      assert.equal(Object.isFrozen(result.value), true);
      const normalized = result.value as Readonly<
        Record<string, DatasetGenerationQueryValue>
      >;
      const selected = normalized.selected_contacts;
      assert.equal(Array.isArray(selected), true);
      assert.equal(Object.isFrozen(selected), true);
    }
  }
});

test("normalizes the exact bounded Prospeo contact identity query", () => {
  const query = validQuery(3, "prospeo-person-search");
  const result = normalize(query);

  assert.equal(result.status, "accepted");
  if (result.status === "accepted") {
    assert.deepEqual(result.value, query);
  }
});

test("detaches accepted contact identity queries from caller mutations", () => {
  const query = structuredClone(validQuery()) as Record<string, unknown>;
  const result = normalize(query as DatasetGenerationQueryValue);
  assert.equal(result.status, "accepted");
  if (result.status !== "accepted") {
    return;
  }

  const selected = query.selected_contacts as Record<string, unknown>[];
  const first = selected[0];
  assert.ok(first);
  const candidate = first.candidate as Record<string, unknown>;
  candidate.display_name = "Mutated after normalization";
  selected.reverse();

  assert.deepEqual(result.value, validQuery());
});

test("rejects unsupported contact identity capabilities and contracts", () => {
  const normalizer = createContactIdentityQueryNormalizer({
    contract: CONTRACT,
  });
  const wrongCapability = normalizer.normalize({
    capability: {
      capabilityId: capabilityId("contacts.discover"),
      capabilityVersion: "1.0.0",
    },
    query: validQuery(),
  });
  const wrongVersion = normalizer.normalize({
    capability: {
      capabilityId: capabilityId("contacts.identity.reveal"),
      capabilityVersion: "2.0.0",
    },
    query: validQuery(),
  });

  assert.equal(wrongCapability.status, "rejected");
  assert.equal(wrongVersion.status, "rejected");
  assert.throws(
    () =>
      createContactIdentityQueryNormalizer({
        contract: { ...CONTRACT, schemaVersion: "2.0.0" },
      }),
    EXACT_CONTRACT_PATTERN
  );
  assert.throws(
    () =>
      createContactIdentityQueryNormalizer({
        contract: { ...CONTRACT, catalogVersion: " " },
      }),
    EXACT_CONTRACT_PATTERN
  );
});

test("rejects out-of-bounds, duplicate, mixed, and unknown-provider identity selections", () => {
  const invalidQueries: Record<string, unknown>[] = [];

  const empty = structuredClone(validQuery()) as Record<string, unknown>;
  empty.selected_contacts = [];
  invalidQueries.push(empty);

  invalidQueries.push(
    structuredClone(validQuery(4)) as Record<string, unknown>
  );

  const duplicate = structuredClone(validQuery(2)) as Record<string, unknown>;
  const duplicateSelected = duplicate.selected_contacts as Record<
    string,
    unknown
  >[];
  duplicateSelected[1] = structuredClone(duplicateSelected[0]);
  invalidQueries.push(duplicate);

  const foreignProvider = structuredClone(validQuery()) as Record<
    string,
    unknown
  >;
  const foreignSelected = foreignProvider.selected_contacts as Record<
    string,
    unknown
  >[];
  const foreignIdentity = foreignSelected[0]?.provider_identity as Record<
    string,
    unknown
  >;
  foreignIdentity.provider_key = "another-provider";
  invalidQueries.push(foreignProvider);

  const mixedProviders = structuredClone(validQuery(2)) as Record<
    string,
    unknown
  >;
  const mixedSelected = mixedProviders.selected_contacts as Record<
    string,
    unknown
  >[];
  const mixedIdentity = mixedSelected[1]?.provider_identity as Record<
    string,
    unknown
  >;
  mixedIdentity.provider_key = "prospeo-person-search";
  invalidQueries.push(mixedProviders);

  for (const query of invalidQueries) {
    const result = normalize(query as DatasetGenerationQueryValue);
    assert.equal(result.status, "rejected");
  }
});

test("rejects non-exact contact identity query shapes and values", () => {
  const invalidQueries: Record<string, unknown>[] = [];

  const wrongKind = structuredClone(validQuery()) as Record<string, unknown>;
  wrongKind.result_kind = "contact";
  invalidQueries.push(wrongKind);

  const blankDataset = structuredClone(validQuery()) as Record<string, unknown>;
  blankDataset.source_dataset_id = " ";
  invalidQueries.push(blankDataset);

  const extraTopLevel = structuredClone(validQuery()) as Record<
    string,
    unknown
  >;
  extraTopLevel.unexpected = true;
  invalidQueries.push(extraTopLevel);

  const invalidDomain = structuredClone(validQuery()) as Record<
    string,
    unknown
  >;
  const invalidDomainSelected = invalidDomain.selected_contacts as Record<
    string,
    unknown
  >[];
  const invalidDomainCandidate = invalidDomainSelected[0]?.candidate as Record<
    string,
    unknown
  >;
  invalidDomainCandidate.organization_domain = "https://company.example";
  invalidQueries.push(invalidDomain);

  const revealed = structuredClone(validQuery()) as Record<string, unknown>;
  const revealedSelected = revealed.selected_contacts as Record<
    string,
    unknown
  >[];
  const revealedCandidate = revealedSelected[0]?.candidate as Record<
    string,
    unknown
  >;
  revealedCandidate.identity_completeness = "full";
  invalidQueries.push(revealed);

  const invalidCountry = structuredClone(validQuery()) as Record<
    string,
    unknown
  >;
  const invalidCountrySelected = invalidCountry.selected_contacts as Record<
    string,
    unknown
  >[];
  const invalidCountryCandidate = invalidCountrySelected[0]
    ?.candidate as Record<string, unknown>;
  invalidCountryCandidate.person_country_code = "ZZ";
  invalidQueries.push(invalidCountry);

  const extraCandidateField = structuredClone(validQuery()) as Record<
    string,
    unknown
  >;
  const extraCandidateSelected =
    extraCandidateField.selected_contacts as Record<string, unknown>[];
  const candidate = extraCandidateSelected[0]?.candidate as Record<
    string,
    unknown
  >;
  candidate.first_name = "must-not-be-supplied";
  invalidQueries.push(extraCandidateField);

  const extraProviderField = structuredClone(validQuery()) as Record<
    string,
    unknown
  >;
  const extraProviderSelected = extraProviderField.selected_contacts as Record<
    string,
    unknown
  >[];
  const provider = extraProviderSelected[0]?.provider_identity as Record<
    string,
    unknown
  >;
  provider.unexpected = true;
  invalidQueries.push(extraProviderField);

  const extraSelectionField = structuredClone(validQuery()) as Record<
    string,
    unknown
  >;
  const extraSelection = extraSelectionField.selected_contacts as Record<
    string,
    unknown
  >[];
  const firstSelection = extraSelection[0];
  assert.ok(firstSelection);
  firstSelection.unexpected = true;
  invalidQueries.push(extraSelectionField);

  for (const query of invalidQueries) {
    const result = normalize(query as DatasetGenerationQueryValue);
    assert.equal(result.status, "rejected");
  }
});
