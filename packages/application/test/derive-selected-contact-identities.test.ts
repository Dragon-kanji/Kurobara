import assert from "node:assert/strict";
import test from "node:test";

import {
  actorId,
  correlationId,
  datasetId,
  fail,
  type InternalContactCandidate,
  idempotencyKey,
  instant,
  recordId,
  workspaceId,
} from "@kurobara/kernel";
import type { ContactIdentitySourcePort } from "@kurobara/ports";

import {
  type DeriveSelectedContactIdentitiesDependencies,
  type DeriveSelectedContactIdentitiesRequest,
  makeDeriveSelectedContactIdentities,
} from "../src/derive-selected-contact-identities.ts";
import type { PlanDatasetGenerationRequest } from "../src/plan-dataset-generation.ts";

const workspace = workspaceId("workspace-contact-identity");
const contactDataset = datasetId("contact-source-dataset");
const observedAt = instant(1_900_000_000_000);
const TARGET_DATASET_ID_PATTERN = /^contact_identity_[a-f0-9]{40}$/u;

const contact = (
  index: number,
  overrides: Partial<InternalContactCandidate["candidate"]> = {},
  providerKey = "apollo-people-search"
): InternalContactCandidate => ({
  candidate: {
    contactId: recordId(`contact-${index}`),
    department: "sales",
    displayName: `Contact ${index}`,
    identityCompleteness: "obfuscated",
    jobTitle: "Sales Director",
    observedAt: instant(observedAt + index),
    organizationDomain: `company-${index}.example`,
    organizationId: `company-${index}`,
    organizationName: `Company ${index}`,
    personCountryCode: "ES",
    profileUrl: null,
    seniority: "director",
    ...overrides,
  },
  providerIdentity: {
    providerKey,
    providerSubjectId: `apollo-person-${index}`,
  },
});

const request = (
  contactRecordIds: DeriveSelectedContactIdentitiesRequest["contactRecordIds"],
  overrides: Partial<DeriveSelectedContactIdentitiesRequest> = {}
): DeriveSelectedContactIdentitiesRequest => ({
  actor: {
    actorId: actorId("actor-contact-identity"),
    authenticationMode: "api-key",
    credentialId: "credential-contact-identity",
    permissions: ["contacts:enrich", "steps:execute"],
    workspaceId: workspace,
  },
  authorityEnvelopeId: "authority-contact-identity",
  budget: { limit: 3, unit: "credits" },
  contactDatasetId: contactDataset,
  contactRecordIds,
  correlationId: correlationId("correlation-contact-identity"),
  deadline: instant(observedAt + 60_000),
  operationId: idempotencyKey("identity-operation"),
  ...overrides,
});

const sourceFor = (
  contacts: readonly InternalContactCandidate[],
  loads: string[] = []
): ContactIdentitySourcePort => {
  const byId = new Map(
    contacts.map((item) => [item.candidate.contactId, item] as const)
  );
  return {
    load: (scope, sourceDatasetId, sourceRecordId) => {
      loads.push(`${scope.workspaceId}:${sourceDatasetId}:${sourceRecordId}`);
      return Promise.resolve(byId.get(sourceRecordId));
    },
  };
};

const dependencies = (
  source: ContactIdentitySourcePort,
  plannedRequests: PlanDatasetGenerationRequest[] = []
): DeriveSelectedContactIdentitiesDependencies => ({
  authorizePage: () =>
    Promise.reject(
      new Error("authorization must not run after synthetic stop")
    ),
  createGeneration: () =>
    Promise.reject(new Error("creation must not run after synthetic stop")),
  planGeneration: (input) => {
    plannedRequests.push(structuredClone(input));
    return Promise.resolve(
      fail({
        code: "snapshot-unavailable" as const,
        message: "Synthetic stop after observing the planning request.",
      })
    );
  },
  privacy: { allows: async () => true },
  source,
});

const expectedSelectedContact = (item: InternalContactCandidate) => ({
  candidate: {
    department: item.candidate.department,
    display_name: item.candidate.displayName,
    identity_completeness: item.candidate.identityCompleteness,
    job_title: item.candidate.jobTitle,
    observed_at_ms: item.candidate.observedAt,
    organization_domain: item.candidate.organizationDomain,
    organization_id: item.candidate.organizationId,
    organization_name: item.candidate.organizationName,
    person_country_code: item.candidate.personCountryCode,
    profile_url: item.candidate.profileUrl,
    seniority: item.candidate.seniority,
  },
  provider_identity: {
    provider_key: item.providerIdentity.providerKey,
    provider_subject_id: item.providerIdentity.providerSubjectId,
  },
  source_record_id: item.candidate.contactId,
});

test("plans exact selected-contact identity queries for one through three contacts", async () => {
  for (const count of [1, 2, 3]) {
    const contacts = Array.from({ length: count }, (_, index) =>
      contact(index + 1)
    );
    const loads: string[] = [];
    const plannedRequests: PlanDatasetGenerationRequest[] = [];
    const result = await makeDeriveSelectedContactIdentities(
      dependencies(sourceFor(contacts, loads), plannedRequests)
    )(request(contacts.map((item) => item.candidate.contactId)));

    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error.stage, "planning");
    }
    assert.equal(plannedRequests.length, 1);
    const planned = plannedRequests[0];
    assert.ok(planned);
    assert.deepEqual(planned.capability, {
      capabilityId: "contacts.identity.reveal",
      capabilityVersion: "1.0.0",
    });
    assert.equal(planned.providerIdentityNamespace, "apollo-people-search");
    assert.deepEqual(planned.query, {
      result_kind: "contact_identity",
      selected_contacts: contacts.map(expectedSelectedContact),
      source_dataset_id: contactDataset,
    });
    assert.deepEqual(planned.limits, {
      maxCalls: count,
      maxCompanies: 0,
      maxContactsPerCompany: 0,
      maxContactsTotal: count,
      maxEnrichments: count,
      maxPages: count,
      maxPhones: 0,
      maxResults: count,
    });
    assert.equal(planned.fields.length, 15);
    assert.deepEqual(
      planned.fields.map((field) => field.key),
      [
        "department",
        "display_name",
        "first_name",
        "identity_completeness",
        "identity_observed_at_ms",
        "identity_status",
        "job_title",
        "last_name",
        "observed_at_ms",
        "organization_domain",
        "organization_id",
        "organization_name",
        "person_country_code",
        "profile_url",
        "seniority",
      ]
    );
    assert.deepEqual(
      loads,
      contacts.map(
        (item) => `${workspace}:${contactDataset}:${item.candidate.contactId}`
      )
    );
  }
});

test("carries the Prospeo lineage namespace into identity planning", async () => {
  const selected = contact(1, {}, "prospeo-person-search");
  const plannedRequests: PlanDatasetGenerationRequest[] = [];

  await makeDeriveSelectedContactIdentities(
    dependencies(sourceFor([selected]), plannedRequests)
  )(request([selected.candidate.contactId]));

  assert.equal(
    plannedRequests[0]?.providerIdentityNamespace,
    "prospeo-person-search"
  );
});

test("derives a deterministic target and internal query from the same operation", async () => {
  const contacts = [contact(1), contact(2), contact(3)];
  const plannedRequests: PlanDatasetGenerationRequest[] = [];
  const derive = makeDeriveSelectedContactIdentities(
    dependencies(sourceFor(contacts), plannedRequests)
  );
  const input = request(contacts.map((item) => item.candidate.contactId));

  await derive(input);
  await derive(input);

  assert.equal(plannedRequests.length, 2);
  assert.deepEqual(plannedRequests[0]?.query, plannedRequests[1]?.query);
  assert.equal(
    plannedRequests[0]?.targetDataset.datasetId,
    plannedRequests[1]?.targetDataset.datasetId
  );
  assert.match(
    plannedRequests[0]?.targetDataset.datasetId ?? "",
    TARGET_DATASET_ID_PATTERN
  );

  const changedOperationRequests: PlanDatasetGenerationRequest[] = [];
  await makeDeriveSelectedContactIdentities(
    dependencies(sourceFor(contacts), changedOperationRequests)
  )(
    request(
      contacts.map((item) => item.candidate.contactId),
      {
        operationId: idempotencyKey("another-identity-operation"),
      }
    )
  );
  assert.notEqual(
    plannedRequests[0]?.targetDataset.datasetId,
    changedOperationRequests[0]?.targetDataset.datasetId
  );
});

test("rejects unbounded, duplicate, or forbidden selections before loading", async () => {
  const selected = [contact(1), contact(2), contact(3), contact(4)];
  const invalidRequests: DeriveSelectedContactIdentitiesRequest[] = [
    request([]),
    request(selected.map((item) => item.candidate.contactId)),
    request([selected[0].candidate.contactId, selected[0].candidate.contactId]),
    request([selected[0].candidate.contactId], {
      actor: {
        ...request([]).actor,
        permissions: ["steps:execute"],
      },
    }),
    request([selected[0].candidate.contactId], {
      actor: {
        ...request([]).actor,
        permissions: ["contacts:enrich"],
      },
    }),
  ];

  for (const input of invalidRequests) {
    let loadCount = 0;
    let planCount = 0;
    const result = await makeDeriveSelectedContactIdentities({
      ...dependencies({
        load: () => {
          loadCount += 1;
          return Promise.resolve(selected[0]);
        },
      }),
      planGeneration: () => {
        planCount += 1;
        return Promise.resolve(
          fail({ code: "snapshot-unavailable" as const, message: "unused" })
        );
      },
    })(input);

    assert.deepEqual(result, {
      error: {
        code: "contact-selection-invalid",
        message:
          "Identity reveal requires contacts:enrich, steps:execute, and one to three unique records.",
        stage: "selection",
      },
      ok: false,
    });
    assert.equal(loadCount, 0);
    assert.equal(planCount, 0);
  }
});

test("rejects missing, mismatched, revealed, or mixed-provider source contacts", async () => {
  const first = contact(1);
  const second = contact(2);
  const selectedIds = [first.candidate.contactId, second.candidate.contactId];
  const cases: readonly ReadonlyMap<string, InternalContactCandidate>[] = [
    new Map([[first.candidate.contactId, first]]),
    new Map([
      [first.candidate.contactId, contact(99)],
      [second.candidate.contactId, second],
    ]),
    new Map([
      [first.candidate.contactId, contact(1, { identityCompleteness: "full" })],
      [second.candidate.contactId, second],
    ]),
    new Map([
      [first.candidate.contactId, first],
      [second.candidate.contactId, contact(2, {}, "another-provider")],
    ]),
  ];

  for (const byId of cases) {
    let planCount = 0;
    const result = await makeDeriveSelectedContactIdentities({
      ...dependencies({
        load: async (_scope, _dataset, sourceRecordId) =>
          byId.get(sourceRecordId),
      }),
      planGeneration: () => {
        planCount += 1;
        return Promise.resolve(
          fail({ code: "snapshot-unavailable" as const, message: "unused" })
        );
      },
    })(request(selectedIds));

    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error.code, "contact-selection-invalid");
      assert.equal(result.error.stage, "selection");
    }
    assert.equal(planCount, 0);
  }
});
