import assert from "node:assert/strict";
import test from "node:test";

import {
  contentHash,
  createDataset,
  createDatasetMaterialization,
  createField,
  createRecord,
  datasetGenerationId,
  datasetId,
  datasetMaterializationId,
  fieldId,
  instant,
  recordId,
  workspaceId,
} from "@kurobara/kernel";
import type { DatasetPersistencePort } from "@kurobara/ports";
import type postgres from "postgres";

import { createPostgresContactDatasetExportPrivacySource } from "../src/contact-source.ts";
import { DatabasePayloadError } from "../src/errors.ts";

const workspace = workspaceId("workspace-contact-export-privacy");
const identifier = datasetId("contact-work-email-derived");
const datasetResult = createDataset({
  datasetId: identifier,
  name: "Synthetic selected contact email",
  workspaceId: workspace,
});
if (!datasetResult.ok) {
  throw new Error("Dataset fixture is invalid.");
}
const dataset = datasetResult.value;
const fieldInputs = [
  { key: "department", valueType: "string" },
  { key: "display_name", valueType: "string" },
  { key: "first_name", valueType: "string" },
  { key: "identity_completeness", valueType: "string" },
  { key: "identity_observed_at_ms", valueType: "number" },
  {
    key: "identity_status",
    valueType: "string",
  },
  { key: "job_title", valueType: "string" },
  { key: "last_name", valueType: "string" },
  { key: "observed_at_ms", valueType: "number" },
  { key: "organization_domain", valueType: "string" },
  { key: "organization_id", valueType: "string" },
  { key: "organization_name", valueType: "string" },
  { key: "person_country_code", valueType: "string" },
  { key: "profile_url", valueType: "string" },
  { key: "seniority", valueType: "string" },
  {
    key: "work_email",
    valueType: "string",
  },
  { key: "work_email_confidence", valueType: "number" },
  { key: "work_email_observed_at_ms", valueType: "number" },
  { key: "work_email_source", valueType: "string" },
  {
    key: "work_email_status",
    valueType: "string",
  },
  { key: "work_email_verification", valueType: "string" },
] as const;
const fields = fieldInputs.map((input) => {
  const result = createField(dataset, {
    datasetId: identifier,
    fieldId: fieldId(`field-${input.key}`),
    key: input.key,
    label: input.key,
    valueType: input.valueType,
    workspaceId: workspace,
  });
  if (!result.ok) {
    throw new Error("Field fixture is invalid.");
  }
  return result.value;
});
const selectedField = (key: string) => {
  const selected = fields.find((field) => field.key === key);
  if (selected === undefined) {
    throw new Error(`Field fixture ${key} is absent.`);
  }
  return selected;
};
const recordResult = createRecord(dataset, fields, {
  datasetId: identifier,
  recordId: recordId("contact-record-synthetic"),
  values: [
    {
      fieldId: selectedField("observed_at_ms").fieldId,
      value: 1000,
    },
    {
      fieldId: selectedField("identity_observed_at_ms").fieldId,
      value: 1100,
    },
    { fieldId: selectedField("identity_status").fieldId, value: "found" },
    {
      fieldId: selectedField("profile_url").fieldId,
      value: "https://example.invalid/profile/synthetic",
    },
    {
      fieldId: selectedField("work_email").fieldId,
      value: "person@example.invalid",
    },
    {
      fieldId: selectedField("work_email_observed_at_ms").fieldId,
      value: 1200,
    },
    { fieldId: selectedField("work_email_status").fieldId, value: "found" },
  ],
  workspaceId: workspace,
});
if (!recordResult.ok) {
  throw new Error("Record fixture is invalid.");
}
const record = recordResult.value;
const materializationResult = createDatasetMaterialization({
  completedAt: instant(2),
  completionReason: "source-exhausted",
  contentHash: contentHash(`sha256:${"a".repeat(64)}`),
  coverage: {
    basis: "locked_provider_route",
    status: "complete_for_declared_source",
  },
  createdAt: instant(1),
  datasetId: identifier,
  materializationId: datasetMaterializationId(identifier),
  origin: {
    generationId: datasetGenerationId("generation-contact-email"),
    kind: "generation",
  },
  recordCount: 1,
  rejectedCount: 0,
  revision: 2,
  schemaHash: contentHash(`sha256:${"b".repeat(64)}`),
  state: "ready",
  workspaceId: workspace,
});
if (!materializationResult.ok) {
  throw new Error("Materialization fixture is invalid.");
}
const stored = {
  dataset,
  fields,
  materialization: materializationResult.value,
};
const datasets = {
  getDataset: async () => stored,
} as unknown as DatasetPersistencePort;
const scope = { workspaceId: workspace };

const generationRow = {
  capability_id: "contacts.work-email.resolve",
  capability_version: "1.0.0",
  generation_id: "generation-contact-email",
  generation_plan_id: "generation-plan-contact-email",
  plan_hash: `sha256:${"c".repeat(64)}`,
};

const sqlSequence = (
  ...responses: readonly (readonly unknown[])[]
): postgres.Sql => {
  let index = 0;
  return (() => {
    const response = responses[index];
    index += 1;
    return Promise.resolve(response ?? []);
  }) as unknown as postgres.Sql;
};

test("loads exact authorization lineage, observations, and grouped subjects", async () => {
  const source = createPostgresContactDatasetExportPrivacySource(
    sqlSequence(
      [generationRow],
      [
        {
          provider_key: "apollo-people-search",
          provider_subject_id: "person-synthetic",
          record,
          record_id: record.recordId,
        },
      ]
    ),
    datasets
  );

  const authorization = await source.loadAuthorization(scope, identifier);

  assert.deepEqual(authorization, {
    providerKeys: ["apollo-people-search"],
    records: [
      {
        observations: {
          "contact-identity": 1100,
          employment: 1000,
          "professional-email": 1200,
          "professional-social-profile": 1100,
        },
        recordId: "contact-record-synthetic",
        subjects: [
          {
            kind: "provider-subject",
            providerKey: "apollo-people-search",
            value: "person-synthetic",
          },
          { kind: "email", value: "person@example.invalid" },
        ],
      },
    ],
    source: {
      capability: {
        capabilityId: "contacts.work-email.resolve",
        capabilityVersion: "1.0.0",
      },
      generationId: "generation-contact-email",
      generationPlanId: "generation-plan-contact-email",
      kind: "generated-dataset",
      planHash: `sha256:${"c".repeat(64)}`,
    },
  });
});

test("allows a ready generated Contact dataset with exactly zero records", async () => {
  const emptyStored = {
    ...stored,
    materialization: { ...stored.materialization, recordCount: 0 },
  };
  const emptyDatasets = {
    getDataset: async () => emptyStored,
  } as unknown as DatasetPersistencePort;
  const source = createPostgresContactDatasetExportPrivacySource(
    sqlSequence([generationRow], []),
    emptyDatasets
  );

  assert.deepEqual(await source.loadAuthorization(scope, identifier), {
    providerKeys: [],
    records: [],
    source: {
      capability: {
        capabilityId: "contacts.work-email.resolve",
        capabilityVersion: "1.0.0",
      },
      generationId: "generation-contact-email",
      generationPlanId: "generation-plan-contact-email",
      kind: "generated-dataset",
      planHash: `sha256:${"c".repeat(64)}`,
    },
  });
});

test("fails closed when the materialization count exceeds stored records", async () => {
  const source = createPostgresContactDatasetExportPrivacySource(
    sqlSequence([generationRow], []),
    datasets
  );

  await assert.rejects(
    source.loadAuthorization(scope, identifier),
    DatabasePayloadError
  );
});

test("fails closed when a generated Contact dataset has lost its lineage", async () => {
  const source = createPostgresContactDatasetExportPrivacySource(
    sqlSequence(
      [generationRow],
      [
        {
          provider_key: null,
          provider_subject_id: null,
          record,
          record_id: record.recordId,
        },
      ]
    ),
    datasets
  );

  await assert.rejects(
    source.loadAuthorization(scope, identifier),
    DatabasePayloadError
  );
});

test("does not classify a generic dataset without Contact lineage", async () => {
  const genericStored = {
    ...stored,
    fields: fields.filter((field) => field.key === "work_email"),
    materialization: {
      ...stored.materialization,
      origin: { importId: "import-synthetic", kind: "import" } as const,
    },
  };
  const genericDatasets = {
    getDataset: async () => genericStored,
  } as unknown as DatasetPersistencePort;
  let sqlCalls = 0;
  const sql = (() => {
    sqlCalls += 1;
    return Promise.resolve([]);
  }) as unknown as postgres.Sql;
  const source = createPostgresContactDatasetExportPrivacySource(
    sql,
    genericDatasets
  );

  assert.equal(await source.loadAuthorization(scope, identifier), undefined);
  assert.equal(sqlCalls, 0);
});

test("admits each exact generated Contact schema", async () => {
  const exactSchemas = [
    {
      keys: fieldInputs
        .filter(
          (field) =>
            ![
              "first_name",
              "identity_observed_at_ms",
              "identity_status",
              "last_name",
              "work_email",
              "work_email_confidence",
              "work_email_observed_at_ms",
              "work_email_source",
              "work_email_status",
              "work_email_verification",
            ].includes(field.key)
        )
        .map((field) => field.key),
      name: "shortlist",
    },
    {
      keys: fieldInputs
        .filter((field) => !field.key.startsWith("work_email"))
        .map((field) => field.key),
      name: "identity",
    },
    {
      keys: fieldInputs.map((field) => field.key),
      name: "work-email",
    },
  ] as const;

  for (const exactSchema of exactSchemas) {
    const schemaKeys: readonly string[] = exactSchema.keys;
    const exactStored = {
      ...stored,
      fields: fields.filter((field) => schemaKeys.includes(field.key)),
      materialization: { ...stored.materialization, recordCount: 0 },
    };
    const exactDatasets = {
      getDataset: async () => exactStored,
    } as unknown as DatasetPersistencePort;
    const source = createPostgresContactDatasetExportPrivacySource(
      sqlSequence([generationRow], []),
      exactDatasets
    );

    const authorization = await source.loadAuthorization(scope, identifier);

    assert.ok(authorization, `${exactSchema.name} schema was not admitted`);
    assert.deepEqual(authorization.records, []);
  }
});

test("fails before record I/O for incomplete or mixed generated Contact schemas", async () => {
  const genericFieldResult = createField(dataset, {
    datasetId: identifier,
    fieldId: fieldId("field-generic-score"),
    key: "generic_score",
    label: "generic_score",
    valueType: "number",
    workspaceId: workspace,
  });
  if (!genericFieldResult.ok) {
    throw new Error("Generic field fixture is invalid.");
  }
  const hostileSchemas = [
    [selectedField("work_email")],
    [selectedField("organization_name"), genericFieldResult.value],
    [selectedField("work_email_status")],
  ] as const;

  for (const hostileFields of hostileSchemas) {
    const malformedStored = {
      ...stored,
      fields: hostileFields,
    };
    const malformedDatasets = {
      getDataset: async () => malformedStored,
    } as unknown as DatasetPersistencePort;
    let sqlCalls = 0;
    const sql = (() => {
      sqlCalls += 1;
      return Promise.resolve([]);
    }) as unknown as postgres.Sql;
    const source = createPostgresContactDatasetExportPrivacySource(
      sql,
      malformedDatasets
    );

    await assert.rejects(
      source.loadAuthorization(scope, identifier),
      DatabasePayloadError
    );
    assert.equal(sqlCalls, 0);
  }
});

test("does not classify a truly generic generated dataset", async () => {
  const genericFieldResult = createField(dataset, {
    datasetId: identifier,
    fieldId: fieldId("field-generic-company-score"),
    key: "company_score",
    label: "company_score",
    valueType: "number",
    workspaceId: workspace,
  });
  if (!genericFieldResult.ok) {
    throw new Error("Generic field fixture is invalid.");
  }
  const malformedStored = {
    ...stored,
    fields: [genericFieldResult.value],
  };
  const malformedDatasets = {
    getDataset: async () => malformedStored,
  } as unknown as DatasetPersistencePort;
  let sqlCalls = 0;
  const sql = (() => {
    sqlCalls += 1;
    return Promise.resolve([]);
  }) as unknown as postgres.Sql;
  const source = createPostgresContactDatasetExportPrivacySource(
    sql,
    malformedDatasets
  );

  assert.equal(await source.loadAuthorization(scope, identifier), undefined);
  assert.equal(sqlCalls, 0);
});
