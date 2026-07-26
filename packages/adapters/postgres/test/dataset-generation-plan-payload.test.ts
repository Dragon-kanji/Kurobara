import assert from "node:assert/strict";
import test from "node:test";

import {
  actorId,
  capabilityId,
  contentHash,
  type DatasetGenerationPlanDraft,
  type DatasetGenerationRequestIntent,
  datasetGenerationPlanHashContent,
  datasetGenerationPlanId,
  datasetGenerationRequestIntentHashContent,
  datasetGenerationSchemaHashContent,
  datasetId,
  fieldId,
  idempotencyKey,
  instant,
  workspaceId,
} from "@kurobara/kernel";
import type { StoredDatasetGenerationPlan } from "@kurobara/ports";

import {
  normalizedJsonEvidence,
  parseNormalizedJsonValue,
} from "../src/artifact-payload.ts";
import {
  datasetGenerationPlanRecordIdentity,
  parseDatasetGenerationPlanRecord,
} from "../src/dataset-generation-plan-payload.ts";
import { DatabasePayloadError } from "../src/errors.ts";

const canonicalHash = (value: unknown) =>
  contentHash(
    normalizedJsonEvidence(parseNormalizedJsonValue(value)).contentHash
  );

const hash = (character: string) =>
  contentHash(`sha256:${character.repeat(64).slice(0, 64)}`);

const generationRecord = (
  workspace = workspaceId("workspace-generation")
): StoredDatasetGenerationPlan => {
  const capability = {
    capabilityId: capabilityId("organizations.discover"),
    capabilityVersion: "1.0.0",
  } as const;
  const deadline = instant(1_800_000_060_000);
  const targetDataset = {
    datasetId: datasetId("dataset-companies"),
    name: "Synthetic companies",
    workspaceId: workspace,
  };
  const fields = [
    {
      datasetId: targetDataset.datasetId,
      fieldId: fieldId("field-company-name"),
      key: "company_name",
      label: "Company name",
      valueType: "string",
      workspaceId: workspace,
    },
  ] as const;
  const limits = {
    maxCalls: 2,
    maxCompanies: 10,
    maxContactsPerCompany: 0,
    maxContactsTotal: 0,
    maxEnrichments: 0,
    maxPages: 2,
    maxPhones: 0,
    maxResults: 10,
  } as const;
  const requestIntent: DatasetGenerationRequestIntent = {
    actorId: actorId("actor-generation"),
    authorityEnvelopeId: "authority-generation",
    capability,
    fields,
    limits,
    requestedBudget: { limit: 10, unit: "credits" },
    requestedDeadline: deadline,
    requestedQuery: { country: "es", industry: "software" },
    targetDataset,
    unknownCostPolicy: { mode: "deny" },
    workspaceId: workspace,
  };
  const requestIntentHash = canonicalHash(
    datasetGenerationRequestIntentHashContent(requestIntent)
  );
  const normalizedQuery = { country: "ES", industry: "software" } as const;
  const budget = { limit: 10, reserved: 0, spent: 0, unit: "credits" };
  const key = idempotencyKey("generation-create-1");
  const draft: DatasetGenerationPlanDraft = {
    authority: {
      authorityEnvelopeId: requestIntent.authorityEnvelopeId,
      budgetLimit: budget,
      capabilities: [capability],
      deadline,
      permissions: ["datasets:generate", "steps:execute"],
      subjectActorId: requestIntent.actorId,
      version: "1.0.0",
      workspaceId: workspace,
    },
    budget,
    deadline,
    generationPlanId: datasetGenerationPlanId("generation-plan-1"),
    hardExecutionCap: 2,
    idempotencyKey: key,
    limits,
    normalizedQuery,
    normalizerVersion: "normalizer-1",
    policy: {
      factsHash: hash("c"),
      requiredPermission: "datasets:generate",
      version: "policy-1",
    },
    queryContract: {
      catalogFingerprint: hash("a"),
      catalogVersion: "catalog-1",
      schemaFingerprint: hash("b"),
      schemaId: "organizations.discover.query",
      schemaVersion: "1.0.0",
    },
    queryHash: canonicalHash(normalizedQuery),
    quote: {
      expiresAt: instant(deadline + 60_000),
      guarantee: "hard",
      pricingVersion: "pricing-1",
      quoteId: "quote-1",
      unit: "credits",
      upperBound: 2,
    },
    requestIntent,
    requestIntentHash,
    routeSnapshots: [
      {
        capability,
        effectAdapterKey: "synthetic-organizations",
        factsHash: hash("c"),
        pricingVersion: "pricing-1",
        reservableUpperBound: 2,
        reservationUnit: "credits",
        routeKey: "synthetic-primary",
      },
    ],
    schemaHash: canonicalHash(
      datasetGenerationSchemaHashContent(requestIntent)
    ),
    workspaceId: workspace,
  };
  return {
    idempotencyKey: key,
    plan: {
      ...draft,
      planHash: canonicalHash(datasetGenerationPlanHashContent(draft)),
    },
    requestIntentHash,
  };
};

test("accepts an exact canonical generation plan and relational identity", () => {
  const record = generationRecord();
  assert.deepEqual(
    parseDatasetGenerationPlanRecord(
      structuredClone(record),
      datasetGenerationPlanRecordIdentity(record)
    ),
    record
  );
});

test("accepts fractional provider-native monetary caps", () => {
  const record = generationRecord();
  const { planHash: _planHash, ...draft } = record.plan;
  const fractionalDraft: DatasetGenerationPlanDraft = {
    ...draft,
    hardExecutionCap: 0.25,
    quote: { ...draft.quote, upperBound: 0.25 },
    routeSnapshots: [
      { ...draft.routeSnapshots[0], reservableUpperBound: 0.25 },
    ],
  };
  const fractional: StoredDatasetGenerationPlan = {
    ...record,
    plan: {
      ...fractionalDraft,
      planHash: canonicalHash(
        datasetGenerationPlanHashContent(fractionalDraft)
      ),
    },
  };

  assert.deepEqual(
    parseDatasetGenerationPlanRecord(structuredClone(fractional)),
    fractional
  );
});

test("rejects query, request, and full-plan hash drift", () => {
  const record = generationRecord();
  assert.throws(
    () =>
      parseDatasetGenerationPlanRecord({
        ...record,
        plan: { ...record.plan, queryHash: hash("0") },
      }),
    DatabasePayloadError
  );
  assert.throws(
    () =>
      parseDatasetGenerationPlanRecord({
        ...record,
        plan: { ...record.plan, requestIntentHash: hash("1") },
        requestIntentHash: hash("1"),
      }),
    DatabasePayloadError
  );
  assert.throws(
    () =>
      parseDatasetGenerationPlanRecord({
        ...record,
        plan: { ...record.plan, planHash: hash("2") },
      }),
    DatabasePayloadError
  );
});

test("rejects payload extras and relational identity drift", () => {
  const record = generationRecord();
  assert.throws(
    () => parseDatasetGenerationPlanRecord({ ...record, unexpected: "field" }),
    DatabasePayloadError
  );
  assert.throws(
    () =>
      parseDatasetGenerationPlanRecord(structuredClone(record), {
        ...datasetGenerationPlanRecordIdentity(record),
        targetDatasetId: "dataset-other",
      }),
    DatabasePayloadError
  );
});

test("rejects an unbounded query before canonical hashing", () => {
  const record = generationRecord();
  let requestedQuery: unknown = "leaf";
  for (let depth = 0; depth < 34; depth += 1) {
    requestedQuery = [requestedQuery];
  }
  assert.throws(
    () =>
      parseDatasetGenerationPlanRecord({
        ...record,
        plan: {
          ...record.plan,
          requestIntent: { ...record.plan.requestIntent, requestedQuery },
        },
      }),
    DatabasePayloadError
  );
});
