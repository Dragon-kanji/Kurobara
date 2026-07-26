import assert from "node:assert/strict";
import test from "node:test";

import {
  actorId,
  capabilityId,
  contentHash,
  type DatasetGenerationCreation,
  datasetGenerationId,
  datasetGenerationPlanId,
  datasetId,
  datasetMaterializationId,
  fieldId,
  instant,
  recordId,
  workspaceId,
} from "@kurobara/kernel";
import type {
  ContactDatasetExportAuthorization,
  ContactDatasetExportPrivacySourcePort,
  ContactPrivacyGuardPort,
  DatasetGenerationPersistencePort,
  DatasetGenerationUnitOfWork,
  DatasetRecordPage,
  DatasetRecordPageQueryPort,
  VerifiedApiKey,
  WorkspaceScope,
} from "@kurobara/ports";

import { makeListContactCandidates } from "../src/list-contact-candidates.ts";

const workspace = workspaceId("workspace-contact-candidates");
const targetDatasetId = datasetId("dataset-contact-candidates");
const generationIdentity = datasetGenerationId("generation-contact-candidates");
const materializationIdentity = datasetMaterializationId(
  "materialization-contact-candidates"
);
const hash = contentHash(`sha256:${"b".repeat(64)}`);
const completedAt = instant(1_900_000_000_000);

const actor: VerifiedApiKey = {
  actorId: actorId("actor-contact-candidates"),
  authenticationMode: "api-key",
  credentialId: "credential-contact-candidates",
  permissions: ["datasets:read"],
  workspaceId: workspace,
};

const creation: DatasetGenerationCreation = {
  generation: {
    aggregateVersion: 3,
    capability: {
      capabilityId: capabilityId("contacts.discover"),
      capabilityVersion: "1.0.0",
    },
    cost: { reserved: 0, spent: 1, unit: "requests" },
    counters: {
      accepted: 1,
      calls: 1,
      duplicates: 0,
      pages: 1,
      rejected: 0,
      returned: 1,
    },
    createdAt: instant(completedAt - 1000),
    datasetId: targetDatasetId,
    generationId: generationIdentity,
    generationPlanId: datasetGenerationPlanId("plan-contact-candidates"),
    lastPageSequence: 1,
    lockedProvider: "private-contact-provider",
    materializationId: materializationIdentity,
    planHash: hash,
    queryHash: hash,
    requestIntentHash: hash,
    schemaHash: hash,
    state: "completed",
    workspaceId: workspace,
  },
  materialization: {
    completedAt,
    completionReason: "source-completed",
    contentHash: hash,
    coverage: {
      basis: "locked_provider_route",
      status: "complete_for_declared_source",
    },
    createdAt: instant(completedAt - 1000),
    datasetId: targetDatasetId,
    materializationId: materializationIdentity,
    origin: { generationId: generationIdentity, kind: "generation" },
    recordCount: 1,
    rejectedCount: 0,
    revision: 1,
    schemaHash: hash,
    state: "ready",
    workspaceId: workspace,
  },
};

const fields = [
  ["contact-department", "department", "Department", "string"],
  ["contact-name", "display_name", "Display name", "string"],
  [
    "contact-identity-completeness",
    "identity_completeness",
    "Identity completeness",
    "string",
  ],
  ["contact-title", "job_title", "Job title", "string"],
  ["contact-observed", "observed_at_ms", "Observed", "number"],
  ["contact-domain", "organization_domain", "Domain", "string"],
  ["contact-organization", "organization_id", "Company ID", "string"],
  ["contact-company-name", "organization_name", "Company", "string"],
  ["contact-country", "person_country_code", "Country", "string"],
  ["contact-profile", "profile_url", "Profile", "string"],
  ["contact-seniority", "seniority", "Seniority", "string"],
] as const;

const datasetFields = fields.map(([id, key, label, valueType]) => ({
  datasetId: targetDatasetId,
  fieldId: fieldId(id),
  key,
  label,
  valueType,
  workspaceId: workspace,
}));

const candidateRecord = {
  datasetId: targetDatasetId,
  recordId: recordId("contact-1"),
  values: datasetFields.map((field) => {
    const values = {
      department: "sales",
      display_name: "Synthetic Contact",
      identity_completeness: "full",
      job_title: "Director",
      observed_at_ms: completedAt,
      organization_domain: "synthetic.example",
      organization_id: "company-1",
      organization_name: "Synthetic Company",
      person_country_code: "ES",
      profile_url: "https://professional.example/contact-1",
      seniority: "director",
    } as const;
    return { fieldId: field.fieldId, value: values[field.key] };
  }),
  workspaceId: workspace,
};

const basePage: DatasetRecordPage = {
  dataset: {
    datasetId: targetDatasetId,
    name: "Generated contacts",
    workspaceId: workspace,
  },
  fields: datasetFields,
  hasMore: false,
  items: [{ ordinal: 1, record: candidateRecord }],
  materialization: creation.materialization,
};

class GenerationStore implements DatasetGenerationPersistencePort {
  calls = 0;
  value: DatasetGenerationCreation | undefined = creation;

  get(): Promise<DatasetGenerationCreation | undefined> {
    this.calls += 1;
    return Promise.resolve(this.value);
  }

  transaction<Value>(
    _scope: WorkspaceScope,
    _work: (unitOfWork: DatasetGenerationUnitOfWork) => Promise<Value>
  ): Promise<Value> {
    throw new Error("not used by this read model");
  }
}

class RecordPages implements DatasetRecordPageQueryPort {
  calls = 0;
  value: DatasetRecordPage | undefined = basePage;

  listPage(): Promise<DatasetRecordPage | undefined> {
    this.calls += 1;
    return Promise.resolve(this.value);
  }
}

class PrivacySubjects implements ContactDatasetExportPrivacySourcePort {
  calls = 0;
  value: ContactDatasetExportAuthorization | undefined = {
    providerKeys: ["private-contact-provider"],
    records: [
      {
        observations: { "contact-identity": completedAt },
        recordId: candidateRecord.recordId,
        subjects: [
          {
            kind: "provider-subject",
            providerKey: "private-contact-provider",
            value: "synthetic-contact-1",
          },
        ],
      },
    ],
    source: {
      capability: creation.generation.capability,
      generationId: creation.generation.generationId,
      generationPlanId: creation.generation.generationPlanId,
      kind: "generated-dataset",
      planHash: creation.generation.planHash,
    },
  };

  loadAuthorization(): Promise<ContactDatasetExportAuthorization | undefined> {
    this.calls += 1;
    return Promise.resolve(this.value);
  }
}

class PrivacyGuard implements ContactPrivacyGuardPort {
  allowed = true;
  calls = 0;
  error: Error | undefined;

  allows(): Promise<boolean> {
    this.calls += 1;
    if (this.error !== undefined) {
      return Promise.reject(this.error);
    }
    return Promise.resolve(this.allowed);
  }
}

const candidateDependencies = (
  generations: GenerationStore,
  records: RecordPages,
  subjects = new PrivacySubjects(),
  guard = new PrivacyGuard()
) => ({
  generations,
  privacy: { guard, subjects },
  records,
});

test("lists an exact privacy-safe contact projection from a ready generation", async () => {
  const generations = new GenerationStore();
  const pages = new RecordPages();
  const result = await makeListContactCandidates(
    candidateDependencies(generations, pages)
  )({ actor, afterOrdinal: 0, generationId: generationIdentity, limit: 1 });

  assert.equal(result.ok, true);
  if (!result.ok) {
    return;
  }
  assert.deepEqual(result.value.items, [
    {
      candidate: {
        contactId: "contact-1",
        department: "sales",
        displayName: "Synthetic Contact",
        identityCompleteness: "full",
        jobTitle: "Director",
        observedAt: completedAt,
        organizationDomain: "synthetic.example",
        organizationId: "company-1",
        organizationName: "Synthetic Company",
        personCountryCode: "ES",
        profileUrl: "https://professional.example/contact-1",
        seniority: "director",
      },
      ordinal: 1,
    },
  ]);
  const publicKeys = Object.keys(result.value.items[0]?.candidate ?? {}).sort();
  assert.deepEqual(publicKeys, [
    "contactId",
    "department",
    "displayName",
    "identityCompleteness",
    "jobTitle",
    "observedAt",
    "organizationDomain",
    "organizationId",
    "organizationName",
    "personCountryCode",
    "profileUrl",
    "seniority",
  ]);
  assert.deepEqual(result.value.page, {
    afterOrdinal: 0,
    hasMore: false,
    limit: 1,
    nextAfterOrdinal: null,
  });
});

test("rejects permission and page bounds before reading persistence", async () => {
  for (const request of [
    { actor: { ...actor, permissions: [] }, afterOrdinal: 0, limit: 1 },
    { actor, afterOrdinal: -1, limit: 1 },
    { actor, afterOrdinal: 0, limit: 101 },
  ] as const) {
    const generations = new GenerationStore();
    const pages = new RecordPages();
    const result = await makeListContactCandidates(
      candidateDependencies(generations, pages)
    )({ ...request, generationId: generationIdentity });

    assert.equal(result.ok, false);
    assert.equal(generations.calls, 0);
    assert.equal(pages.calls, 0);
  }
});

test("fails closed on capability, schema, and record drift", async () => {
  const scenarios: readonly Readonly<{
    expected: string;
    mutate: (generations: GenerationStore, pages: RecordPages) => void;
  }>[] = [
    {
      expected: "dataset-generation-not-ready",
      mutate: (generations) => {
        generations.value = {
          ...creation,
          generation: {
            ...creation.generation,
            capability: {
              capabilityId: capabilityId("organizations.discover"),
              capabilityVersion: "1.0.0",
            },
          },
        };
      },
    },
    {
      expected: "dataset-schema-invalid",
      mutate: (_generations, pages) => {
        pages.value = { ...basePage, fields: datasetFields.slice(1) };
      },
    },
    {
      expected: "dataset-record-invalid",
      mutate: (_generations, pages) => {
        pages.value = {
          ...basePage,
          items: [
            {
              ordinal: 1,
              record: {
                ...candidateRecord,
                values: candidateRecord.values.map((value, index) =>
                  index === 1 ? { ...value, value: null } : value
                ),
              },
            },
          ],
        };
      },
    },
  ];

  for (const scenario of scenarios) {
    const generations = new GenerationStore();
    const pages = new RecordPages();
    scenario.mutate(generations, pages);
    const result = await makeListContactCandidates(
      candidateDependencies(generations, pages)
    )({ actor, afterOrdinal: 0, generationId: generationIdentity, limit: 1 });

    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error.code, scenario.expected);
    }
  }
});

test("fails closed when a materialized Contact becomes restricted", async () => {
  const generations = new GenerationStore();
  const pages = new RecordPages();
  const subjects = new PrivacySubjects();
  const guard = new PrivacyGuard();
  guard.allowed = false;

  const result = await makeListContactCandidates(
    candidateDependencies(generations, pages, subjects, guard)
  )({ actor, afterOrdinal: 0, generationId: generationIdentity, limit: 1 });

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, "contact-privacy-restricted");
  }
  assert.equal(subjects.calls, 1);
  assert.equal(guard.calls, 1);
});

test("fails closed when materialized Contact privacy lineage is missing", async () => {
  const generations = new GenerationStore();
  const pages = new RecordPages();
  const subjects = new PrivacySubjects();
  const guard = new PrivacyGuard();
  subjects.value = undefined;

  const result = await makeListContactCandidates(
    candidateDependencies(generations, pages, subjects, guard)
  )({ actor, afterOrdinal: 0, generationId: generationIdentity, limit: 1 });

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, "contact-privacy-check-failed");
  }
  assert.equal(subjects.calls, 1);
  assert.equal(guard.calls, 0);
});

test("fails closed on incomplete lineage or an unavailable privacy guard", async () => {
  const scenarios = [
    {
      configure: (subjects: PrivacySubjects, _guard: PrivacyGuard) => {
        const authorization = subjects.value;
        assert.ok(authorization);
        subjects.value = {
          ...authorization,
          records: authorization.records.map((record) => ({
            ...record,
            subjects: [],
          })),
        };
      },
    },
    {
      configure: (_subjects: PrivacySubjects, guard: PrivacyGuard) => {
        guard.error = new Error("privacy persistence unavailable");
      },
    },
  ] as const;

  for (const scenario of scenarios) {
    const subjects = new PrivacySubjects();
    const guard = new PrivacyGuard();
    scenario.configure(subjects, guard);

    const result = await makeListContactCandidates(
      candidateDependencies(
        new GenerationStore(),
        new RecordPages(),
        subjects,
        guard
      )
    )({ actor, afterOrdinal: 0, generationId: generationIdentity, limit: 1 });

    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error.code, "contact-privacy-check-failed");
    }
  }
});
