import assert from "node:assert/strict";
import test from "node:test";

import {
  actorId,
  datasetId,
  datasetMaterializationId,
  workspaceId,
} from "@kurobara/kernel";
import type {
  GtmPersistencePort,
  GtmPlayRunClaim,
  GtmPlayRunUpdate,
  GtmPlayRunUpdateResult,
  StoredGtmPlayRun,
} from "@kurobara/ports";

import { makeAdvanceNextGtmPlayRun } from "../src/index.ts";

const makeRun = (): StoredGtmPlayRun => ({
  compilation: {
    assumptions: [],
    authority: {
      humanGates: ["provider_spend"],
      permissions: ["plays:execute"],
    },
    budget: {
      limit: 2,
      quotedUpperBound: 2,
      unit: "requests",
    },
    deadlineMs: 10_000,
    exportMode: "no_send",
    intentionHash:
      "sha256:1111111111111111111111111111111111111111111111111111111111111111",
    stages: [
      {
        capability: "contacts.discover",
        inputFingerprint:
          "sha256:2222222222222222222222222222222222222222222222222222222222222222",
        operationId: "contacts.discover",
        ordinal: 1,
      },
      {
        inputFingerprint:
          "sha256:3333333333333333333333333333333333333333333333333333333333333333",
        operationId: "workbooks.project",
        ordinal: 2,
      },
    ],
  },
  createdAtMs: 1,
  definition: {
    approvals: {
      export: true,
      providerSpend: true,
      reveal: false,
    },
    authorityEnvelopeId: "authority-test",
    audience: {
      companyCountries: ["FR"],
      departments: [],
      personCountries: [],
      seniorities: [],
      titles: [],
    },
    broadening: "forbidden",
    budget: { limit: 2, unit: "requests" },
    capabilities: ["contacts.discover"],
    contextRef: {
      contextId: "context-test",
      fingerprint:
        "sha256:0000000000000000000000000000000000000000000000000000000000000000",
      revision: 1,
    },
    deadlineMs: 10_000,
    delivery: { mode: "no_send", privateExport: true },
    exclusions: [],
    objective: {
      metric: "contacts",
      target: 1,
      text: "Find one contact",
    },
    playId: "play-test",
    preview: {
      maxCompanies: 1,
      maxContactsPerCompany: 1,
      maxContactsTotal: 1,
      maxProviderCalls: 1,
      sampleSize: 1,
    },
    selection: { minimumScore: 0, requiredSignals: [] },
    source: {
      datasetId: datasetId("dataset-source"),
      defaultCountryCode: "FR",
      fieldMapping: { domain: "domain" },
      kind: "imported_dataset",
      materializationId: datasetMaterializationId("materialization-source"),
    },
    stopConditions: ["budget_exhausted"],
  },
  execution: {
    cost: { reserved: 0, spent: 0, unit: "requests" },
    providerCalls: 0,
    provenance: [],
    selectedRecordIds: [],
    selectionReasons: [],
    stages: [
      {
        cost: { reserved: 0, spent: 0, unit: "requests" },
        operationId: "contacts.discover",
        ordinal: 1,
        providerCalls: 0,
        state: "pending",
      },
      {
        cost: { reserved: 0, spent: 0, unit: "requests" },
        operationId: "workbooks.project",
        ordinal: 2,
        providerCalls: 0,
        state: "pending",
      },
    ],
  },
  executionActor: {
    actorId: actorId("actor-test"),
    authenticationMode: "api-key",
    permissions: ["plays:execute"],
  },
  idempotencyKey: "play-start-test",
  playId: "play-test",
  playRevision: 1,
  revision: 1,
  runId: "play-run-test",
  state: "queued",
  updatedAtMs: 1,
  workspaceId: workspaceId("workspace-test"),
});

const memoryPersistence = (initial: StoredGtmPlayRun) => {
  let current = initial;
  const persistence = {
    claimNextPlayRun: (
      workerId: string,
      claimToken: string,
      nowMs: number,
      leaseMs: number
    ): Promise<GtmPlayRunClaim | undefined> =>
      Promise.resolve(
        current.state === "queued" || current.state === "running"
          ? {
              claimExpiresAtMs: nowMs + leaseMs,
              claimToken,
              run: current,
              workerId,
            }
          : undefined
      ),
    updatePlayRun: (
      _scope: unknown,
      input: GtmPlayRunUpdate
    ): Promise<GtmPlayRunUpdateResult> => {
      if (input.expectedRevision !== current.revision) {
        return Promise.resolve({ status: "conflict" });
      }
      current = {
        ...current,
        execution: input.execution,
        revision: current.revision + 1,
        state: input.state,
        updatedAtMs: input.updatedAtMs,
      };
      return Promise.resolve({ run: current, status: "updated" });
    },
  } as Pick<GtmPersistencePort, "claimNextPlayRun" | "updatePlayRun">;
  return {
    current: () => current,
    persistence: persistence as GtmPersistencePort,
  };
};

test("resumes a Play from durable child generation to terminal Workbook", async () => {
  const memory = memoryPersistence(makeRun());
  let inspectionCount = 0;
  const dependencies = {
    claimLeaseMs: 1000,
    clock: { now: () => Promise.resolve(100) },
    inspectGeneration: () => {
      inspectionCount += 1;
      return Promise.resolve({
        cost: { reserved: 0, spent: 1, unit: "requests" },
        datasetId: datasetId("dataset-result"),
        generationId: "generation-test",
        materializationId: datasetMaterializationId("materialization-result"),
        provenance: ["provider:fixture"],
        providerCalls: 1,
        recordCount: 1,
        state: "completed" as const,
      });
    },
    nextClaimToken: () => "claim-test",
    persistence: memory.persistence,
    projectWorkbook: () =>
      Promise.resolve({
        provenance: ["workbook:durable-projection"],
        result: {
          datasetId: datasetId("dataset-result"),
          exportReady: true,
          materializationId: datasetMaterializationId("materialization-result"),
          recordCount: 1,
          workbookId: "workbook-test",
        },
      }),
    startStage: () =>
      Promise.resolve({
        cost: { reserved: 1, spent: 0, unit: "requests" },
        datasetId: datasetId("dataset-result"),
        generationId: "generation-test",
        materializationId: datasetMaterializationId("materialization-result"),
        provenance: ["provider:fixture"],
        providerCalls: 0,
        recordCount: 0,
        state: "running" as const,
      }),
    workerId: "gtm-worker-test",
  };

  const firstWorker = makeAdvanceNextGtmPlayRun(dependencies);
  assert.equal((await firstWorker()).status, "updated");
  assert.equal(memory.current().execution.stages[0]?.state, "running");

  const resumedWorker = makeAdvanceNextGtmPlayRun(dependencies);
  assert.equal((await resumedWorker()).status, "updated");
  assert.equal(inspectionCount, 1);
  assert.equal(memory.current().execution.stages[0]?.state, "completed");

  assert.equal((await resumedWorker()).status, "updated");
  assert.equal(memory.current().state, "completed");
  assert.equal(memory.current().execution.result?.workbookId, "workbook-test");
  assert.equal(memory.current().execution.result?.exportReady, true);
});

test("fails closed when a child receipt exceeds the provider-call cap", async () => {
  const memory = memoryPersistence(makeRun());
  const cycle = makeAdvanceNextGtmPlayRun({
    claimLeaseMs: 1000,
    clock: { now: () => Promise.resolve(100) },
    inspectGeneration: () => Promise.reject(new Error("not reached")),
    nextClaimToken: () => "claim-test",
    persistence: memory.persistence,
    projectWorkbook: () => Promise.reject(new Error("not reached")),
    startStage: () =>
      Promise.resolve({
        cost: { reserved: 2, spent: 0, unit: "requests" },
        generationId: "generation-test",
        provenance: [],
        providerCalls: 2,
        state: "running" as const,
      }),
    workerId: "gtm-worker-test",
  });

  await cycle();
  assert.equal(memory.current().state, "failed");
  assert.equal(
    memory.current().execution.error?.code,
    "play-budget-cap-exceeded"
  );
});
