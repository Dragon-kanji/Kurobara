import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import type { Record as DatasetRecord } from "@kurobara/kernel";
import {
  attemptId,
  capabilityId,
  contentHash,
  datasetGenerationId,
  datasetGenerationPlanId,
  datasetId,
  fieldId,
  instant,
  operationKey,
  recordId,
  routingDecisionId,
  runId,
  stepRunId,
  workspaceId,
} from "@kurobara/kernel";
import type {
  LeafEffectRequest,
  NormalizedJsonValue,
  ValidatedRunInput,
} from "@kurobara/ports";

import {
  createDeterministicDatasetGenerationPageEffect,
  type DeterministicDatasetGenerationPageInput,
} from "../src/index.ts";

const serializeCanonical = (value: unknown): string => {
  if (value === null || typeof value !== "object") {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) {
      throw new TypeError("Expected JSON content.");
    }
    return encoded;
  }
  if (Array.isArray(value)) {
    return `[${value.map(serializeCanonical).join(",")}]`;
  }
  const record = value as Readonly<Record<string, unknown>>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${serializeCanonical(record[key])}`)
    .join(",")}}`;
};

const hash = (value: unknown) =>
  contentHash(
    `sha256:${createHash("sha256").update(serializeCanonical(value), "utf8").digest("hex")}`
  );

const workspaceIdentifier = workspaceId("workspace-generation-page");
const datasetIdentifier = datasetId("dataset-generation-page");
const generationIdentifier = datasetGenerationId("generation-page");
const generationPlanIdentifier = datasetGenerationPlanId(
  "generation-plan-page"
);
const companyNameFieldId = fieldId("company-name");

const expectedInput: DeterministicDatasetGenerationPageInput = {
  capability: {
    capabilityId: capabilityId("companies-search"),
    capabilityVersion: "1.0.0",
  },
  datasetId: datasetIdentifier,
  fields: [
    {
      datasetId: datasetIdentifier,
      fieldId: companyNameFieldId,
      key: "company_name",
      label: "Company name",
      valueType: "string",
      workspaceId: workspaceIdentifier,
    },
  ],
  generationId: generationIdentifier,
  generationPlanId: generationPlanIdentifier,
  inputCursor: null,
  kind: "dataset-generation-page-input",
  limits: {
    maxCalls: 1,
    maxCompanies: 10,
    maxContactsPerCompany: 0,
    maxContactsTotal: 0,
    maxEnrichments: 0,
    maxPages: 1,
    maxPhones: 0,
    maxResults: 10,
  },
  normalizedQuery: { country: "FR", sector: "software" },
  pageSequence: 1,
  planHash: contentHash(`sha256:${"a".repeat(64)}`),
  queryHash: contentHash(`sha256:${"b".repeat(64)}`),
  schemaHash: contentHash(`sha256:${"c".repeat(64)}`),
  version: "1.0.0",
  workspaceId: workspaceIdentifier,
};

const makeRunInput = (value: NormalizedJsonValue): ValidatedRunInput => {
  const canonical = serializeCanonical(value);
  return {
    classification: "internal",
    contentHash: hash(value),
    contract: {
      catalogFingerprint: contentHash(`sha256:${"d".repeat(64)}`),
      catalogVersion: "test",
      schemaFingerprint: contentHash(`sha256:${"e".repeat(64)}`),
      schemaId: "dataset-generation-page-input",
      schemaVersion: "1.0.0",
    },
    finalizedAt: instant(1000),
    inputId: "input-generation-page",
    mediaType: "application/json",
    sizeBytes: Buffer.byteLength(canonical, "utf8"),
    validatedAt: instant(1000),
    validatorVersion: "deterministic-test",
    value,
  };
};

const request: LeafEffectRequest = {
  attemptId: attemptId("attempt-generation-page"),
  operationKey: operationKey("operation-generation-page"),
  reservationUnit: "credits",
  reservedAmount: 2,
  routeSnapshotHash: contentHash(`sha256:${"f".repeat(64)}`),
  routingDecisionId: routingDecisionId("route-generation-page"),
  runId: runId("run-generation-page"),
  runInput: makeRunInput(expectedInput),
  stepRunId: stepRunId("step-generation-page"),
  workspaceId: workspaceIdentifier,
};

const record: DatasetRecord = {
  datasetId: datasetIdentifier,
  recordId: recordId("synthetic-company-1"),
  values: [{ fieldId: companyNameFieldId, value: "Synthetic Company" }],
  workspaceId: workspaceIdentifier,
};

test("returns a configured stable page and its durable lookup receipt", async () => {
  const effect = createDeterministicDatasetGenerationPageEffect({
    expectedInput,
    page: {
      hasMore: false,
      kind: "records",
      nextCursor: null,
      records: [record],
      sourcePartitionCompleted: true,
    },
    settlementAmount: 1,
  });

  const absent = await effect.port.lookup(request);
  const executed = await effect.port.execute(request);
  const lookedUp = await effect.port.lookup(request);

  assert.deepEqual(absent, {
    proofId: "deterministic-dataset-generation-page:attempt-generation-page",
    status: "not-found",
  });
  assert.deepEqual(executed, {
    output: {
      hasMore: false,
      items: [{ contentHash: hash(record), record }],
      nextCursor: null,
      sourcePartitionCompleted: true,
      version: "1.0.0",
    },
    settlement: {
      amount: 1,
      kind: "settle",
      unit: "credits",
      usageEntryId:
        "usage:deterministic-dataset-generation-page:attempt-generation-page",
    },
    status: "succeeded",
  });
  assert.equal(lookedUp.status, "found");
  if (lookedUp.status === "found") {
    assert.deepEqual(lookedUp.outcome, executed);
  }
  assert.equal(effect.history().executions.length, 1);
  assert.equal(effect.history().lookups.length, 2);
  assert.equal(effect.port.adapterKey, "deterministic-dataset-generation-page");
});

test("returns the exact certain-empty page contract", async () => {
  const effect = createDeterministicDatasetGenerationPageEffect({
    expectedInput,
    page: { kind: "empty-certain" },
  });

  const executed = await effect.port.execute(request);

  assert.equal(executed.status, "succeeded");
  if (executed.status === "succeeded") {
    assert.deepEqual(executed.output, {
      hasMore: false,
      items: [],
      nextCursor: null,
      sourcePartitionCompleted: true,
      version: "1.0.0",
    });
    assert.deepEqual(executed.settlement, {
      amount: 0,
      kind: "settle",
      unit: "credits",
      usageEntryId:
        "usage:deterministic-dataset-generation-page:attempt-generation-page",
    });
  }
});

test("fails closed when the run input is absent or has divergent limits", async () => {
  const effect = createDeterministicDatasetGenerationPageEffect({
    expectedInput,
    page: { kind: "empty-certain" },
  });
  const { runInput: _runInput, ...withoutRunInput } = request;
  const divergentValue = {
    ...expectedInput,
    limits: { ...expectedInput.limits, maxCalls: 2 },
  };

  await assert.rejects(() => effect.port.execute(withoutRunInput), RangeError);
  await assert.rejects(
    () =>
      effect.port.execute({
        ...request,
        runInput: makeRunInput(divergentValue),
      }),
    RangeError
  );
  assert.equal(effect.history().executions.length, 0);
});

test("rejects divergent replay identities and invalid record configuration", async () => {
  const effect = createDeterministicDatasetGenerationPageEffect({
    expectedInput,
    page: {
      hasMore: false,
      kind: "records",
      nextCursor: null,
      records: [record],
      sourcePartitionCompleted: true,
    },
  });
  await effect.port.execute(request);

  await assert.rejects(
    () =>
      effect.port.lookup({
        ...request,
        runId: runId("run-generation-page-divergent"),
      }),
    RangeError
  );
  assert.throws(
    () =>
      createDeterministicDatasetGenerationPageEffect({
        expectedInput,
        page: {
          hasMore: false,
          kind: "records",
          nextCursor: null,
          records: [
            {
              ...record,
              workspaceId: workspaceId("wrong-workspace"),
            },
          ],
          sourcePartitionCompleted: true,
        },
      }),
    RangeError
  );
  assert.throws(
    () =>
      createDeterministicDatasetGenerationPageEffect({
        expectedInput,
        page: {
          hasMore: false,
          kind: "records",
          nextCursor: null,
          records: [record],
          sourcePartitionCompleted: false,
        },
      }),
    RangeError
  );
});
