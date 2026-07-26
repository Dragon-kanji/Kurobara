import assert from "node:assert/strict";
import test from "node:test";

import {
  actorId,
  correlationId,
  datasetId,
  fail,
  idempotencyKey,
  instant,
  type RevealedInternalContactCandidate,
  recordId,
  workspaceId,
} from "@kurobara/kernel";
import type {
  ContactPrivacyGuardPort,
  SelectedContactEnrichmentSourcePort,
  SelectedContactWorkEmailSource,
} from "@kurobara/ports";

import {
  type DeriveSelectedContactWorkEmailsDependencies,
  type DeriveSelectedContactWorkEmailsRequest,
  makeDeriveSelectedContactWorkEmails,
} from "../src/derive-selected-contact-work-emails.ts";
import type { PlanDatasetGenerationRequest } from "../src/plan-dataset-generation.ts";

const workspace = workspaceId("workspace-contact-work-email");
const sourceDataset = datasetId("contact-identity-dataset");
const observedAt = instant(1_900_000_000_000);
const TARGET_DATASET_PATTERN = /^contact_work_email_[a-f0-9]{40}$/u;
const FIELD_KEYS = [
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
  "work_email",
  "work_email_confidence",
  "work_email_observed_at_ms",
  "work_email_source",
  "work_email_status",
  "work_email_verification",
] as const;

const revealedContact = (
  index: number,
  providerKey = "apollo-people-search"
): RevealedInternalContactCandidate => {
  const displayName = `Contact ${index}`;
  const profileUrl = `https://network.example/contact-${index}`;
  return {
    candidate: {
      contactId: recordId(`contact-${index}`),
      department: "sales",
      displayName,
      identityCompleteness: "full",
      jobTitle: "Sales Director",
      observedAt: instant(observedAt + index),
      organizationDomain: `company-${index}.example`,
      organizationId: `company-${index}`,
      organizationName: `Company ${index}`,
      personCountryCode: "ES",
      profileUrl,
      seniority: "director",
    },
    identity: {
      displayName,
      firstName: "Contact",
      identityCompleteness: "full",
      lastName: String(index),
      observedAt: instant(observedAt + 100 + index),
      profileUrl,
    },
    providerIdentity: {
      providerKey,
      providerSubjectId: `apollo-person-${index}`,
    },
  };
};

const selectedWorkEmail = (
  contact: RevealedInternalContactCandidate,
  index: number
): SelectedContactWorkEmailSource => ({
  contact,
  workEmail: {
    confidence: 0.9,
    email: `contact-${index}@company-${index}.example`,
    observedAt: instant(observedAt + 200 + index),
    source: "provider_unspecified",
    verification: "unknown",
  },
});

const request = (
  kind: DeriveSelectedContactWorkEmailsRequest["kind"],
  contactRecordIds: DeriveSelectedContactWorkEmailsRequest["contactRecordIds"],
  overrides: Partial<DeriveSelectedContactWorkEmailsRequest> = {}
): DeriveSelectedContactWorkEmailsRequest => ({
  actor: {
    actorId: actorId("actor-contact-work-email"),
    authenticationMode: "api-key",
    credentialId: "credential-contact-work-email",
    permissions: ["contacts:enrich", "steps:execute"],
    workspaceId: workspace,
  },
  authorityEnvelopeId: "authority-contact-work-email",
  budget: { limit: 3, unit: "credits" },
  contactDatasetId: sourceDataset,
  contactRecordIds,
  correlationId: correlationId("correlation-contact-work-email"),
  deadline: instant(observedAt + 60_000),
  kind,
  operationId: idempotencyKey(`work-email-${kind}`),
  ...overrides,
});

const sourceFor = (
  contacts: readonly RevealedInternalContactCandidate[],
  workEmails: readonly SelectedContactWorkEmailSource[],
  loads: string[] = []
): SelectedContactEnrichmentSourcePort => {
  const identitiesById = new Map(
    contacts.map((contact) => [contact.candidate.contactId, contact] as const)
  );
  const emailsById = new Map(
    workEmails.map(
      (entry) => [entry.contact.candidate.contactId, entry] as const
    )
  );
  return {
    loadIdentity: (scope, dataset, record) => {
      loads.push(`identity:${scope.workspaceId}:${dataset}:${record}`);
      return Promise.resolve(identitiesById.get(record));
    },
    loadWorkEmail: (scope, dataset, record) => {
      loads.push(`work-email:${scope.workspaceId}:${dataset}:${record}`);
      return Promise.resolve(emailsById.get(record));
    },
  };
};

const dependencies = (
  source: SelectedContactEnrichmentSourcePort,
  plannedRequests: PlanDatasetGenerationRequest[] = [],
  privacy: ContactPrivacyGuardPort = { allows: () => Promise.resolve(true) }
): DeriveSelectedContactWorkEmailsDependencies => ({
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
  privacy,
  source,
});

const expectedContact = (
  contact: RevealedInternalContactCandidate,
  workEmail?: SelectedContactWorkEmailSource["workEmail"]
) => ({
  candidate: {
    department: contact.candidate.department,
    display_name: contact.candidate.displayName,
    identity_completeness: contact.candidate.identityCompleteness,
    job_title: contact.candidate.jobTitle,
    observed_at_ms: contact.candidate.observedAt,
    organization_domain: contact.candidate.organizationDomain,
    organization_id: contact.candidate.organizationId,
    organization_name: contact.candidate.organizationName,
    person_country_code: contact.candidate.personCountryCode,
    profile_url: contact.candidate.profileUrl,
    seniority: contact.candidate.seniority,
  },
  identity: {
    display_name: contact.identity.displayName,
    first_name: contact.identity.firstName,
    last_name: contact.identity.lastName,
    observed_at_ms: contact.identity.observedAt,
    profile_url: contact.identity.profileUrl,
  },
  provider_identity: {
    provider_key: contact.providerIdentity.providerKey,
    provider_subject_id: contact.providerIdentity.providerSubjectId,
  },
  source_record_id: contact.candidate.contactId,
  ...(workEmail === undefined
    ? {}
    : {
        work_email: {
          confidence: workEmail.confidence,
          email: workEmail.email,
          observed_at_ms: workEmail.observedAt,
          source: workEmail.source,
          verification: workEmail.verification,
        },
      }),
});

test("plans exact deterministic resolve and verify queries for one through three contacts", async () => {
  for (const kind of ["resolve", "verify"] as const) {
    for (const count of [1, 2, 3]) {
      const contacts = Array.from({ length: count }, (_, index) =>
        revealedContact(index + 1)
      );
      const emailEntries = contacts.map((contact, index) =>
        selectedWorkEmail(contact, index + 1)
      );
      const loads: string[] = [];
      const privacyInputs: Parameters<ContactPrivacyGuardPort["allows"]>[] = [];
      const plannedRequests: PlanDatasetGenerationRequest[] = [];
      const privacy: ContactPrivacyGuardPort = {
        allows: (scope, subjects) => {
          privacyInputs.push(structuredClone([scope, subjects]));
          return Promise.resolve(true);
        },
      };
      const input = request(
        kind,
        contacts.map((contact) => contact.candidate.contactId)
      );
      const derive = makeDeriveSelectedContactWorkEmails(
        dependencies(
          sourceFor(contacts, emailEntries, loads),
          plannedRequests,
          privacy
        )
      );

      const result = await derive(input);

      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.equal(result.error.stage, "planning");
      }
      assert.equal(plannedRequests.length, 1);
      const planned = plannedRequests[0];
      assert.ok(planned);
      assert.deepEqual(planned.capability, {
        capabilityId: `contacts.work-email.${kind}`,
        capabilityVersion: "1.0.0",
      });
      assert.equal(planned.providerIdentityNamespace, "apollo-people-search");
      assert.deepEqual(planned.query, {
        operation_kind: kind,
        result_kind: "contact_work_email",
        selected_contacts: contacts.map((contact, index) =>
          expectedContact(
            contact,
            kind === "verify" ? emailEntries[index]?.workEmail : undefined
          )
        ),
        source_dataset_id: sourceDataset,
      });
      assert.deepEqual(
        planned.fields.map((field) => field.key),
        FIELD_KEYS
      );
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
      assert.match(planned.targetDataset.datasetId, TARGET_DATASET_PATTERN);
      assert.deepEqual(
        loads,
        contacts.map(
          (contact) =>
            `${kind === "resolve" ? "identity" : "work-email"}:${workspace}:${sourceDataset}:${contact.candidate.contactId}`
        )
      );
      assert.equal(privacyInputs.length, 1);
      assert.deepEqual(privacyInputs[0]?.[0], { workspaceId: workspace });
      assert.deepEqual(
        privacyInputs[0]?.[1],
        contacts.flatMap((contact, index) => [
          {
            kind: "provider-subject",
            providerKey: contact.providerIdentity.providerKey,
            value: contact.providerIdentity.providerSubjectId,
          },
          ...(kind === "verify"
            ? [
                {
                  kind: "email" as const,
                  value: emailEntries[index]?.workEmail.email,
                },
              ]
            : []),
        ])
      );

      await derive(input);
      assert.equal(plannedRequests.length, 2);
      assert.deepEqual(plannedRequests[0], plannedRequests[1]);
    }
  }
});

test("carries the Prospeo lineage namespace into work-email planning", async () => {
  const selected = revealedContact(1, "prospeo-person-search");
  const plannedRequests: PlanDatasetGenerationRequest[] = [];

  await makeDeriveSelectedContactWorkEmails(
    dependencies(sourceFor([selected], []), plannedRequests)
  )(request("resolve", [selected.candidate.contactId]));

  assert.equal(
    plannedRequests[0]?.providerIdentityNamespace,
    "prospeo-person-search"
  );
});

test("requires a complete identity, a verify email, and one provider namespace", async () => {
  const first = revealedContact(1);
  const second = revealedContact(2);
  const selectedIds = [first.candidate.contactId, second.candidate.contactId];
  const cases: readonly Readonly<{
    input: DeriveSelectedContactWorkEmailsRequest;
    source: SelectedContactEnrichmentSourcePort;
  }>[] = [
    {
      input: request("resolve", selectedIds),
      source: sourceFor([first], []),
    },
    {
      input: request("verify", selectedIds),
      source: sourceFor([first, second], [selectedWorkEmail(first, 1)]),
    },
    {
      input: request("resolve", selectedIds),
      source: sourceFor([first, revealedContact(2, "another-provider")], []),
    },
  ];

  for (const scenario of cases) {
    let privacyCalls = 0;
    let planCalls = 0;
    const result = await makeDeriveSelectedContactWorkEmails({
      ...dependencies(scenario.source),
      planGeneration: () => {
        planCalls += 1;
        return Promise.resolve(
          fail({ code: "snapshot-unavailable" as const, message: "unused" })
        );
      },
      privacy: {
        allows: () => {
          privacyCalls += 1;
          return Promise.resolve(true);
        },
      },
    })(scenario.input);

    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error.code, "contact-selection-invalid");
      assert.equal(result.error.stage, "selection");
    }
    assert.equal(privacyCalls, 0);
    assert.equal(planCalls, 0);
  }
});

test("denies the derivation before planning when privacy preflight blocks", async () => {
  const contact = revealedContact(1);
  const plannedRequests: PlanDatasetGenerationRequest[] = [];
  const result = await makeDeriveSelectedContactWorkEmails(
    dependencies(sourceFor([contact], []), plannedRequests, {
      allows: () => Promise.resolve(false),
    })
  )(request("resolve", [contact.candidate.contactId]));

  assert.deepEqual(result, {
    error: {
      code: "contact-privacy-restricted",
      message: "Contact privacy restrictions block the work-email effect.",
      stage: "privacy",
    },
    ok: false,
  });
  assert.equal(plannedRequests.length, 0);
});
