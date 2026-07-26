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
  DatasetGenerationPersistencePort,
  DatasetGenerationUnitOfWork,
  DatasetRecordPage,
  DatasetRecordPageQueryPort,
  VerifiedApiKey,
  WorkspaceScope,
} from "@kurobara/ports";

import { makeListCompanyCandidates } from "../src/list-company-candidates.ts";
import { makeLoadReadyCompanyCandidates } from "../src/load-ready-company-candidates.ts";

const workspace = workspaceId("workspace-company-candidates");
const targetDatasetId = datasetId("dataset-company-candidates");
const generationIdentity = datasetGenerationId("generation-company-candidates");
const materializationIdentity = datasetMaterializationId(
  "materialization-company-candidates"
);
const hash = contentHash(`sha256:${"a".repeat(64)}`);
const completedAt = instant(1_900_000_000_000);

const actor: VerifiedApiKey = {
  actorId: actorId("actor-company-candidates"),
  authenticationMode: "api-key",
  credentialId: "credential-company-candidates",
  permissions: ["datasets:read"],
  workspaceId: workspace,
};

const creation: DatasetGenerationCreation = {
  generation: {
    aggregateVersion: 3,
    capability: {
      capabilityId: capabilityId("organizations.discover"),
      capabilityVersion: "1.0.0",
    },
    cost: { reserved: 1, spent: 1, unit: "requests" },
    counters: {
      accepted: 2,
      calls: 1,
      duplicates: 0,
      pages: 1,
      rejected: 0,
      returned: 2,
    },
    createdAt: instant(completedAt - 1000),
    datasetId: targetDatasetId,
    generationId: generationIdentity,
    generationPlanId: datasetGenerationPlanId("plan-company-candidates"),
    lastPageSequence: 1,
    lockedProvider: "private-provider-route",
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
    recordCount: 2,
    rejectedCount: 0,
    revision: 1,
    schemaHash: hash,
    state: "ready",
    workspaceId: workspace,
  },
};

const fields = [
  ["company-name", "name", "Company name", "string"],
  ["company-domain", "domain", "Domain", "string"],
  ["company-country", "country_code", "Country", "string"],
  ["company-industry", "industry_code", "Industry", "string"],
  ["company-employees", "employee_count", "Employees", "number"],
  ["company-observed", "observed_at_ms", "Observed at", "number"],
] as const;

const datasetFields = fields.map(([id, key, label, valueType]) => ({
  datasetId: targetDatasetId,
  fieldId: fieldId(id),
  key,
  label,
  valueType,
  workspaceId: workspace,
}));

const record = (
  id: string,
  values: readonly (boolean | null | number | string)[]
) => ({
  datasetId: targetDatasetId,
  recordId: recordId(id),
  values: datasetFields.map((field, index) => ({
    fieldId: field.fieldId,
    value: values[index] ?? null,
  })),
  workspaceId: workspace,
});

const basePage: DatasetRecordPage = {
  dataset: {
    datasetId: targetDatasetId,
    name: "Generated companies",
    workspaceId: workspace,
  },
  fields: datasetFields,
  hasMore: true,
  items: [
    {
      ordinal: 1,
      record: record("company-1", [
        " Synthetic One ",
        "one.example",
        "FR",
        null,
        42,
        completedAt,
      ]),
    },
  ],
  materialization: creation.materialization,
};

class GenerationStore implements DatasetGenerationPersistencePort {
  calls = 0;
  value: DatasetGenerationCreation | undefined = creation;

  get(
    _scope: WorkspaceScope,
    _generationId: typeof generationIdentity
  ): Promise<DatasetGenerationCreation | undefined> {
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

test("lists a provider-neutral page from one immutable ready materialization", async () => {
  const generations = new GenerationStore();
  const pages = new RecordPages();
  const result = await makeListCompanyCandidates({
    generations,
    records: pages,
  })({
    actor,
    afterOrdinal: 0,
    generationId: generationIdentity,
    limit: 1,
  });

  assert.equal(result.ok, true);
  if (!result.ok) {
    return;
  }
  assert.deepEqual(result.value.items, [
    {
      candidate: {
        companyId: "company-1",
        countryCode: "FR",
        domain: "one.example",
        employeeCount: 42,
        industryCode: null,
        name: "Synthetic One",
        observedAtMs: completedAt,
      },
      ordinal: 1,
    },
  ]);
  assert.deepEqual(result.value.page, {
    afterOrdinal: 0,
    hasMore: true,
    limit: 1,
    nextAfterOrdinal: 1,
  });
  assert.equal(generations.calls, 1);
  assert.equal(pages.calls, 1);
});

test("loads a bounded ready parent company page without public actor coupling", async () => {
  const generations = new GenerationStore();
  const pages = new RecordPages();
  const load = makeLoadReadyCompanyCandidates({ generations, records: pages });

  const loaded = await load({
    afterOrdinal: 0,
    generationId: generationIdentity,
    limit: 1,
    workspaceId: workspace,
  });
  assert.equal(loaded.ok, true);
  if (loaded.ok) {
    assert.equal(loaded.value.items[0]?.candidate.companyId, "company-1");
  }

  const oversized = await load({
    afterOrdinal: 0,
    generationId: generationIdentity,
    limit: 11,
    workspaceId: workspace,
  });
  assert.equal(oversized.ok, false);
  if (!oversized.ok) {
    assert.equal(oversized.error.code, "request-invalid");
  }
  assert.equal(generations.calls, 1);
  assert.equal(pages.calls, 1);
});

test("parent loader rejects cross-workspace and non-organization generations", async () => {
  const otherWorkspace = workspaceId("workspace-other-parent");
  const wrongCapability: DatasetGenerationCreation = {
    ...creation,
    generation: {
      ...creation.generation,
      capability: {
        capabilityId: capabilityId("contacts.discover"),
        capabilityVersion: "1.0.0",
      },
    },
  };
  for (const scenario of [
    { creation: wrongCapability, workspaceId: workspace },
    { creation, workspaceId: otherWorkspace },
  ] as const) {
    const generations = new GenerationStore();
    const pages = new RecordPages();
    generations.value = scenario.creation;
    const result = await makeLoadReadyCompanyCandidates({
      generations,
      records: pages,
    })({
      afterOrdinal: 0,
      generationId: generationIdentity,
      limit: 1,
      workspaceId: scenario.workspaceId,
    });

    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error.code, "dataset-generation-not-ready");
    }
    assert.equal(pages.calls, 0);
  }
});

test("rejects missing permission and malformed pages before any persistence read", async () => {
  for (const request of [
    { actor: { ...actor, permissions: [] }, afterOrdinal: 0, limit: 1 },
    { actor, afterOrdinal: -1, limit: 1 },
    { actor, afterOrdinal: 0, limit: 101 },
  ] as const) {
    const generations = new GenerationStore();
    const pages = new RecordPages();
    const result = await makeListCompanyCandidates({
      generations,
      records: pages,
    })({ ...request, generationId: generationIdentity });

    assert.equal(result.ok, false);
    assert.equal(generations.calls, 0);
    assert.equal(pages.calls, 0);
  }
});

test("fails closed when generation, schema, or persisted records drift", async () => {
  const cases: readonly Readonly<{
    expected: string;
    mutate: (generations: GenerationStore, pages: RecordPages) => void;
  }>[] = [
    {
      expected: "dataset-generation-not-ready",
      mutate: (generations) => {
        generations.value = {
          ...creation,
          generation: { ...creation.generation, state: "running" },
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
          items: [{ ...basePage.items[0], ordinal: 0 }],
        };
      },
    },
    {
      expected: "dataset-generation-not-ready",
      mutate: (_generations, pages) => {
        pages.value = { ...basePage, hasMore: false };
      },
    },
    {
      expected: "dataset-generation-not-ready",
      mutate: (_generations, pages) => {
        pages.value = { ...basePage, items: [] };
      },
    },
    {
      expected: "dataset-record-invalid",
      mutate: (_generations, pages) => {
        pages.value = {
          ...basePage,
          items: [{ ...basePage.items[0], ordinal: 2 }],
        };
      },
    },
  ];

  for (const scenario of cases) {
    const generations = new GenerationStore();
    const pages = new RecordPages();
    scenario.mutate(generations, pages);
    const result = await makeListCompanyCandidates({
      generations,
      records: pages,
    })({
      actor,
      afterOrdinal: 0,
      generationId: generationIdentity,
      limit: 1,
    });

    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error.code, scenario.expected);
    }
  }
});
