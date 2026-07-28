import assert from "node:assert/strict";
import test from "node:test";

import {
  contentHash,
  type Record as DatasetRecord,
  datasetId,
  datasetMaterializationId,
  fieldId,
  instant,
  recordId,
  workspaceId,
} from "@kurobara/kernel";
import type { DatasetPersistencePort } from "@kurobara/ports";

import {
  makeLoadImportedCompanyCandidates,
  normalizeOrganizationDomain,
} from "../src/load-imported-company-candidates.ts";

const workspace = workspaceId("workspace-imported-organizations");
const importedDatasetId = datasetId("dataset-imported-organizations");
const domainFieldId = fieldId("field-domain");
const nameFieldId = fieldId("field-name");
const countryFieldId = fieldId("field-country");
const hash = contentHash(`sha256:${"d".repeat(64)}`);

const record = (
  identity: string,
  domain: string,
  name: string,
  country: string
): DatasetRecord => ({
  datasetId: importedDatasetId,
  recordId: recordId(identity),
  values: [
    { fieldId: domainFieldId, value: domain },
    { fieldId: nameFieldId, value: name },
    { fieldId: countryFieldId, value: country },
  ],
  workspaceId: workspace,
});

const persistence = (
  records: readonly DatasetRecord[]
): DatasetPersistencePort => {
  const notUsed = (): Promise<never> =>
    Promise.reject(new Error("not used by imported company projection"));
  return {
    appendImportBatch: notUsed,
    beginImport: notUsed,
    finishImport: notUsed,
    getDataset: () =>
      Promise.resolve({
        dataset: {
          datasetId: importedDatasetId,
          name: "Imported organizations",
          workspaceId: workspace,
        },
        fields: [
          {
            datasetId: importedDatasetId,
            fieldId: domainFieldId,
            key: "website",
            label: "Website",
            valueType: "string",
            workspaceId: workspace,
          },
          {
            datasetId: importedDatasetId,
            fieldId: nameFieldId,
            key: "company_name",
            label: "Company",
            valueType: "string",
            workspaceId: workspace,
          },
          {
            datasetId: importedDatasetId,
            fieldId: countryFieldId,
            key: "country",
            label: "Country",
            valueType: "string",
            workspaceId: workspace,
          },
        ],
        materialization: {
          completedAt: instant(2000),
          contentHash: hash,
          coverage: {
            basis: "imported_source",
            status: "complete_for_declared_source",
          },
          createdAt: instant(1000),
          datasetId: importedDatasetId,
          materializationId: datasetMaterializationId(
            "materialization-imported-organizations"
          ),
          origin: { importId: "import-organizations", kind: "import" },
          recordCount: records.length,
          rejectedCount: 0,
          revision: 1,
          schemaHash: hash,
          state: "ready",
          workspaceId: workspace,
        },
      }),
    isFieldSetComplete: notUsed,
    resetImport: notUsed,
    streamImportIssues: () => ({
      [Symbol.asyncIterator]: () => ({
        next: () => Promise.resolve({ done: true as const, value: undefined }),
      }),
    }),
    streamRecords: () => ({
      async *[Symbol.asyncIterator]() {
        yield* records;
      },
    }),
  };
};

test("normalizes public hostnames without DNS or subdomain collapse", () => {
  assert.equal(
    normalizeOrganizationDomain(" HTTPS://BÜCHER.example:8443/path?q=1 "),
    "xn--bcher-kva.example"
  );
  assert.equal(
    normalizeOrganizationDomain("sales.eu.Example.COM."),
    "sales.eu.example.com"
  );
  for (const value of [
    "https://user:secret@example.com",
    "127.0.0.1",
    "localhost",
    "http://bad_label.example",
    "mailto:ops@example.com",
  ]) {
    assert.equal(normalizeOrganizationDomain(value), undefined);
  }
});

test("projects arbitrary imported rows with explicit lineage and diagnostics", async () => {
  const result = await makeLoadImportedCompanyCandidates({
    datasets: persistence([
      record("company-1", "https://One.Example/path", "Company One", "fr"),
      record("company-duplicate", "one.example", "Duplicate", "FR"),
      record("company-invalid", "localhost", "Invalid", "FR"),
      record("company-2", "two.example", "", "de"),
    ]),
  })({
    limit: 2,
    source: {
      datasetId: importedDatasetId,
      fieldMapping: {
        countryCode: "country",
        domain: "website",
        name: "company_name",
      },
      kind: "dataset",
    },
    workspaceId: workspace,
  });

  if (!result.ok) {
    assert.fail(result.error.message);
  }
  assert.deepEqual(result.value.organizations, [
    {
      company_id: "company-1",
      country_code: "FR",
      domain: "one.example",
      name: "Company One",
    },
    {
      company_id: "company-2",
      country_code: "DE",
      domain: "two.example",
      name: "two.example",
    },
  ]);
  assert.deepEqual(result.value.lineage, {
    accepted: 2,
    contentHash: hash,
    datasetId: importedDatasetId,
    duplicates: 1,
    fieldMapping: {
      countryCode: "country",
      domain: "website",
      name: "company_name",
    },
    inspected: 4,
    kind: "dataset",
    materializationId: "materialization-imported-organizations",
    rejected: 1,
    sourceRecordCount: 4,
    truncated: false,
  });
});
