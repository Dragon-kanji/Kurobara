import assert from "node:assert/strict";
import test from "node:test";

import {
  actorId,
  artifactId,
  attemptId,
  authorizeDatasetGenerationPageEffect,
  capabilityId,
  correlationId,
  costReservationId,
  createDatasetGeneration,
  type DatasetGenerationCreation,
  type DatasetGenerationPage,
  type DatasetGenerationPlan,
  datasetGenerationId,
  datasetGenerationPlanId,
  datasetId,
  eventId,
  fieldId,
  idempotencyKey,
  instant,
  operationKey,
  outboxMessageId,
  type ResultManifest,
  type RunPlan,
  recordId,
  resultManifestId,
  routingDecisionId,
  runId,
  startDatasetGenerationPage,
  stepRunId,
  usageEntryId,
  workspaceId,
} from "@kurobara/kernel";
import type {
  DatasetGenerationFirstPagePersistencePort,
  DatasetGenerationFirstPageUnitOfWork,
  DatasetGenerationPageLineageWrite,
  DatasetGenerationPageRecordWrite,
  DatasetGenerationPageRunProof,
  RunCreationRecord,
  StoredDatasetGenerationPlan,
  ValidatedRunInput,
  WorkspaceScope,
} from "@kurobara/ports";

import {
  type AuthorizeFirstDatasetGenerationPageRequest,
  makeAuthorizeFirstDatasetGenerationPage,
} from "../src/authorize-first-dataset-generation-page.ts";
import { canonicalContentHash } from "../src/canonical-content-hash.ts";
import { makeCheckpointFirstDatasetGenerationPage } from "../src/checkpoint-first-dataset-generation-page.ts";

const workspace = workspaceId("workspace-generation-page");
const actor = actorId("actor-generation-page");
const generationIdentity = datasetGenerationId("generation-page-1");
const now = instant(1_900_000_000_000);
const capability = {
  capabilityId: capabilityId("organizations.discover"),
  capabilityVersion: "1.0.0",
} as const;

const makePlan = (
  overrides: Readonly<{
    authorityPermissions?: readonly string[];
    deadline?: ReturnType<typeof instant>;
    hardExecutionCap?: number;
    maxCalls?: number;
    maxCompanies?: number;
    maxPages?: number;
    maxResults?: number;
    routeUpperBounds?: readonly [number, number];
  }> = {}
): DatasetGenerationPlan => {
  const targetDataset = {
    datasetId: datasetId("dataset-generated-companies"),
    name: "Generated companies",
    workspaceId: workspace,
  };
  const fields = [
    {
      datasetId: targetDataset.datasetId,
      fieldId: fieldId("field-company-name"),
      key: "company_name",
      label: "Company name",
      valueType: "string" as const,
      workspaceId: workspace,
    },
  ];
  const deadline = overrides.deadline ?? instant(now + 60_000);
  const limits = {
    maxCalls: overrides.maxCalls ?? 2,
    maxCompanies: overrides.maxCompanies ?? 10,
    maxContactsPerCompany: 0,
    maxContactsTotal: 0,
    maxEnrichments: 0,
    maxPages: overrides.maxPages ?? 2,
    maxPhones: 0,
    maxResults: overrides.maxResults ?? 10,
  };
  const budget = { limit: 10, reserved: 0, spent: 0, unit: "credits" };
  return {
    authority: {
      authorityEnvelopeId: "authority-generation-page",
      budgetLimit: budget,
      capabilities: [capability],
      deadline,
      permissions: overrides.authorityPermissions ?? [
        "datasets:generate",
        "steps:execute",
      ],
      subjectActorId: actor,
      version: "1.0.0",
      workspaceId: workspace,
    },
    budget,
    deadline,
    generationPlanId: datasetGenerationPlanId("generation-plan-page-1"),
    hardExecutionCap: overrides.hardExecutionCap ?? 2,
    idempotencyKey: idempotencyKey("generation-plan-page-create-1"),
    limits,
    normalizedQuery: { country: "ES", industry: "software" },
    normalizerVersion: "normalizer-1",
    planHash: canonicalContentHash("generation-plan"),
    policy: {
      factsHash: canonicalContentHash("policy-facts"),
      requiredPermission: "datasets:generate",
      version: "policy-1",
    },
    queryContract: {
      catalogFingerprint: canonicalContentHash("catalog"),
      catalogVersion: "catalog-1",
      schemaFingerprint: canonicalContentHash("generation-query-schema"),
      schemaId: "organizations.discover.query",
      schemaVersion: "1.0.0",
    },
    queryHash: canonicalContentHash("normalized-query"),
    quote: {
      expiresAt: instant(deadline + 60_000),
      guarantee: "hard",
      pricingVersion: "pricing-1",
      quoteId: "quote-generation-page",
      unit: "credits",
      upperBound: overrides.hardExecutionCap ?? 2,
    },
    requestIntent: {
      actorId: actor,
      authorityEnvelopeId: "authority-generation-page",
      capability,
      fields,
      limits,
      requestedBudget: { limit: 10, unit: "credits" },
      requestedDeadline: deadline,
      requestedQuery: { country: "es", industry: "software" },
      targetDataset,
      unknownCostPolicy: { mode: "deny" },
      workspaceId: workspace,
    },
    requestIntentHash: canonicalContentHash("generation-intent"),
    routeSnapshots: [
      {
        capability,
        effectAdapterKey: "synthetic-organizations-primary",
        factsHash: canonicalContentHash("policy-facts"),
        pricingVersion: "pricing-1",
        reservableUpperBound: overrides.routeUpperBounds?.[0] ?? 2,
        reservationUnit: "credits",
        routeKey: "route-primary",
      },
      {
        capability,
        effectAdapterKey: "synthetic-organizations-secondary",
        factsHash: canonicalContentHash("policy-facts"),
        pricingVersion: "pricing-1",
        reservableUpperBound: overrides.routeUpperBounds?.[1] ?? 1,
        reservationUnit: "credits",
        routeKey: "route-secondary",
      },
    ],
    schemaHash: canonicalContentHash("dataset-schema"),
    workspaceId: workspace,
  };
};

const makeContactPlan = (): DatasetGenerationPlan => {
  const base = makePlan({ maxCompanies: 1, maxResults: 10 });
  const contactCapability = {
    capabilityId: capabilityId("contacts.discover"),
    capabilityVersion: "1.0.0",
  } as const;
  const limits = {
    ...base.limits,
    maxContactsPerCompany: 2,
    maxContactsTotal: 2,
  };
  return {
    ...base,
    authority: {
      ...base.authority,
      capabilities: [contactCapability],
    },
    limits,
    requestIntent: {
      ...base.requestIntent,
      capability: contactCapability,
      limits,
    },
    routeSnapshots: base.routeSnapshots.map((route) => ({
      ...route,
      capability: contactCapability,
    })),
  };
};

class MemoryFirstPagePersistence
  implements DatasetGenerationFirstPagePersistencePort
{
  readonly lineage: DatasetGenerationPageLineageWrite[] = [];
  readonly records: DatasetGenerationPageRecordWrite[] = [];
  readonly runInputs: ValidatedRunInput[] = [];
  readonly runPlans = new Map<string, RunPlan>();
  readonly plan: DatasetGenerationPlan;
  generation: DatasetGenerationCreation;
  readonly pages = new Map<number, DatasetGenerationPage>();
  proof: DatasetGenerationPageRunProof = { status: "pending" };
  runCreation: RunCreationRecord | undefined = undefined;
  readonly storedPlan: StoredDatasetGenerationPlan;

  get page(): DatasetGenerationPage | undefined {
    return [...this.pages.values()].sort(
      (left, right) => right.pageSequence - left.pageSequence
    )[0];
  }

  set page(value: DatasetGenerationPage | undefined) {
    if (value !== undefined) {
      this.pages.set(value.pageSequence, value);
    }
  }

  constructor(plan: DatasetGenerationPlan) {
    this.plan = plan;
    const created = createDatasetGeneration({
      createdAt: now,
      generationId: generationIdentity,
      plan,
    });
    if (!created.ok) {
      throw new Error(created.error.message);
    }
    this.generation = structuredClone(created.value);
    this.storedPlan = {
      idempotencyKey: plan.idempotencyKey,
      plan: structuredClone(plan),
      requestIntentHash: plan.requestIntentHash,
    };
  }

  transaction<Value>(
    _scope: WorkspaceScope,
    work: (unitOfWork: DatasetGenerationFirstPageUnitOfWork) => Promise<Value>
  ): Promise<Value> {
    const unitOfWork: DatasetGenerationFirstPageUnitOfWork = {
      generationPages: {
        appendRecordsAndLineage: (_appendScope, input) => {
          this.records.push(...structuredClone(input.records));
          this.lineage.push(...structuredClone(input.lineage));
          return Promise.resolve();
        },
        computeMaterializationContentHash: () =>
          Promise.resolve(canonicalContentHash(this.records)),
        findExistingContentHashes: (_scope, _generationId, hashes) =>
          Promise.resolve(
            hashes.filter((hash) =>
              this.records.some((record) => record.contentHash === hash)
            )
          ),
        getGenerationForUpdate: (_generationScope, generationId) =>
          Promise.resolve(
            generationId === this.generation.generation.generationId
              ? structuredClone(this.generation)
              : undefined
          ),
        getPageForUpdate: (_pageScope, generationId, pageSequence) =>
          Promise.resolve(
            this.pages.get(pageSequence)?.generationId === generationId
              ? structuredClone(this.pages.get(pageSequence))
              : undefined
          ),
        insertPage: (_pageScope, page) => {
          this.page = structuredClone(page);
          return Promise.resolve();
        },
        readRunProof: () => Promise.resolve(structuredClone(this.proof)),
        updateGeneration: (_generationScope, input) => {
          if (
            this.generation.generation.aggregateVersion !==
              input.expectedGenerationVersion ||
            this.generation.materialization.revision !==
              input.expectedMaterializationRevision
          ) {
            throw new Error("stale generation fence");
          }
          this.generation = structuredClone(input.value);
          return Promise.resolve();
        },
        updatePage: (_pageScope, expectedAggregateVersion, page) => {
          if (
            this.pages.get(page.pageSequence)?.aggregateVersion !==
            expectedAggregateVersion
          ) {
            throw new Error("stale page fence");
          }
          this.page = structuredClone(page);
          return Promise.resolve();
        },
      },
      generationPlans: {
        findByIdempotencyKey: () => Promise.resolve(this.storedPlan),
        get: (_planScope, generationPlanId) =>
          Promise.resolve(
            generationPlanId === this.plan.generationPlanId
              ? this.storedPlan
              : undefined
          ),
        insert: () => Promise.reject(new Error("outside test scope")),
        lockIdempotencyKey: () => Promise.resolve(),
      },
      outbox: { append: () => Promise.resolve() },
      runEvents: { append: () => Promise.resolve() },
      runInputs: {
        insert: (_inputScope, _runPlan, input) => {
          this.runInputs.push(structuredClone(input));
          return Promise.resolve();
        },
      },
      runPlans: {
        get: (_runPlanScope, runPlanIdentity) => {
          const found = this.runPlans.get(runPlanIdentity);
          return Promise.resolve(
            found === undefined
              ? undefined
              : {
                  plan: structuredClone(found),
                  ...(this.runCreation?.run.runPlanId === runPlanIdentity
                    ? { consumedBy: structuredClone(this.runCreation) }
                    : {}),
                }
          );
        },
        insert: (_runPlanScope, runPlan) => {
          this.runPlans.set(runPlan.runPlanId, structuredClone(runPlan));
          return Promise.resolve();
        },
        markConsumed: (_runPlanScope, _runPlanIdentity, creation) => {
          this.runCreation = structuredClone(creation);
          return Promise.resolve();
        },
      },
      runs: {
        findByIdempotencyKey: (_runScope, key) =>
          Promise.resolve(
            this.runCreation?.idempotencyKey === key
              ? structuredClone(this.runCreation)
              : undefined
          ),
        insert: () => Promise.resolve(),
        lockIdempotencyKey: () => Promise.resolve(),
      },
    };
    return work(unitOfWork);
  }
}

let identifierSequence = 0;
const identifiers = {
  nextEventId: () =>
    Promise.resolve(eventId(`event-page-${++identifierSequence}`)),
  nextOutboxMessageId: () =>
    Promise.resolve(outboxMessageId(`outbox-page-${identifierSequence}`)),
  nextRunId: () => Promise.resolve(runId(`run-page-${identifierSequence}`)),
};

const authorizeRequest = (
  overrides: Partial<AuthorizeFirstDatasetGenerationPageRequest> = {}
): AuthorizeFirstDatasetGenerationPageRequest => ({
  actorId: actor,
  actorPermissions: ["steps:execute"],
  authenticationMode: "api-key",
  correlationId: correlationId("correlation-generation-page"),
  generationId: generationIdentity,
  workspaceId: workspace,
  ...overrides,
});

const authorize = (
  persistence: MemoryFirstPagePersistence,
  request = authorizeRequest()
) =>
  makeAuthorizeFirstDatasetGenerationPage({
    clock: { now: () => Promise.resolve(now) },
    identifiers,
    persistence,
  })(request);

const makeSucceededProof = (
  persistence: MemoryFirstPagePersistence,
  items: readonly Readonly<{
    contentHash: ReturnType<typeof canonicalContentHash>;
    providerIdentity?: Readonly<{
      providerKey: string;
      providerSubjectId: string;
    }>;
    record: Readonly<{
      datasetId: ReturnType<typeof datasetId>;
      recordId: ReturnType<typeof recordId>;
      values: readonly Readonly<{
        fieldId: ReturnType<typeof fieldId>;
        value: string;
      }>[];
      workspaceId: ReturnType<typeof workspaceId>;
    }>;
  }>[],
  amounts: Readonly<{
    hasMore?: boolean;
    nextCursor?: string;
    releasedAmount?: number;
    usageAmount?: number;
  }> = {}
): Extract<DatasetGenerationPageRunProof, { status: "succeeded" }> => {
  if (!(persistence.page && persistence.runCreation)) {
    throw new Error("authorize the page before building its Run proof");
  }
  const page = persistence.page;
  const runPlan = persistence.runPlans.get(page.runPlanId);
  const route = runPlan?.routeSnapshots?.[0];
  if (!(runPlan && route)) {
    throw new Error("the canonical RunPlan route is missing");
  }
  const stepIdentity = stepRunId("step-generation-page");
  const attemptIdentity = attemptId("attempt-generation-page");
  const reservationIdentity = costReservationId("reservation-generation-page");
  const operationIdentity = operationKey("operation-generation-page");
  const routingIdentity = routingDecisionId("routing-generation-page");
  const usageIdentity = usageEntryId("usage-generation-page");
  const output = {
    hasMore: amounts.hasMore ?? false,
    items,
    nextCursor: amounts.hasMore ? (amounts.nextCursor ?? "cursor-next") : null,
    sourcePartitionCompleted: !(amounts.hasMore ?? false),
    version: "1.0.0",
  } as const;
  const artifactContentHash = canonicalContentHash(output);
  const artifactIdentity = artifactId("artifact-generation-page");
  const outputRef = {
    artifact: {
      artifactId: artifactIdentity,
      contentHash: artifactContentHash,
    },
    contract: runPlan.outputContract,
    validatedAt: instant(now + 20),
    validatorVersion: "dataset-generation-page-output/1.0.0",
  };
  const routingDecision = {
    capability: route.capability,
    decidedAt: instant(now + 5),
    effectAdapterKey: route.effectAdapterKey,
    policyFactsHash: runPlan.policyFactsHash,
    policyVersion: runPlan.policyVersion,
    pricingVersion: route.pricingVersion,
    reservationUnit: route.reservationUnit,
    reservedAmount: route.reservableUpperBound,
    routeKey: route.routeKey,
    routeSnapshotHash: canonicalContentHash(route),
    routingDecisionId: routingIdentity,
    runId: page.runId,
    stepRunId: stepIdentity,
    workspaceId: workspace,
  } as const;
  const attempt = {
    attemptId: attemptIdentity,
    attemptNumber: 1,
    authorityEnvelopeId: runPlan.authority.authorityEnvelopeId,
    claimedAt: instant(now + 10),
    costReservationId: reservationIdentity,
    effectAdapterKey: route.effectAdapterKey,
    effectStartedAt: instant(now + 11),
    finishedAt: instant(now + 20),
    operationKey: operationIdentity,
    output: outputRef,
    preparedAt: instant(now + 5),
    reason: "initial",
    reservationUnit: route.reservationUnit,
    reservedAmount: route.reservableUpperBound,
    routeKey: route.routeKey,
    routeSnapshotHash: routingDecision.routeSnapshotHash,
    routingDecisionId: routingIdentity,
    state: "succeeded",
    stepRunId: stepIdentity,
  } as const;
  const stepRun = {
    aggregateVersion: 4,
    attempts: [attempt],
    createdAt: now,
    dependsOn: [],
    eventSequence: 4,
    nodeKey: "page",
    runId: page.runId,
    state: "succeeded",
    stepRunId: stepIdentity,
    workspaceId: workspace,
  } as const;
  const usage = {
    amount: amounts.usageAmount ?? 1,
    attemptId: attemptIdentity,
    operationKey: operationIdentity,
    recordedAt: instant(now + 20),
    reservationId: reservationIdentity,
    runId: page.runId,
    unit: route.reservationUnit,
    usageEntryId: usageIdentity,
    workspaceId: workspace,
  } as const;
  const artifact = {
    artifactId: artifactIdentity,
    attemptId: attemptIdentity,
    classification: "internal",
    contentHash: artifactContentHash,
    contract: runPlan.outputContract,
    finalizedAt: instant(now + 20),
    kind: "normalized-output",
    mediaType: "application/json",
    operationKey: operationIdentity,
    retentionPolicy: "run",
    runId: page.runId,
    sizeBytes: Buffer.byteLength(JSON.stringify(output), "utf8"),
    state: "finalized",
    stepRunId: stepIdentity,
    validatedAt: instant(now + 20),
    validatorVersion: "dataset-generation-page-output/1.0.0",
    workspaceId: workspace,
  } as const;
  const baseRun = persistence.runCreation.run;
  const manifestBody = {
    attemptSettlements: [
      {
        attemptId: attemptIdentity,
        disposition: "settled",
        operationKey: operationIdentity,
        releasedAmount:
          amounts.releasedAmount ?? route.reservableUpperBound - usage.amount,
        reservationId: reservationIdentity,
        settledAmount: usage.amount,
        unit: usage.unit,
        usageEntryId: usageIdentity,
      },
    ],
    compiledWorkflowFingerprint: runPlan.compiledWorkflow.fingerprint,
    conclusion: "completed",
    cost: { reserved: 0, spent: usage.amount, unit: usage.unit },
    coverage: "complete",
    createdAt: instant(now + 30),
    entries: [
      {
        nodeKey: "page",
        result: { ...outputRef, status: "accepted" },
        state: "succeeded",
        stepAggregateVersion: stepRun.aggregateVersion,
        stepEventSequence: stepRun.eventSequence,
        stepRunId: stepIdentity,
        terminalAttemptId: attemptIdentity,
      },
    ],
    manifestVersion: 1,
    output: { ...outputRef, status: "accepted" },
    outputContract: runPlan.outputContract,
    planHash: runPlan.planHash,
    resultCompleteness: "complete",
    runId: page.runId,
    runPlanId: page.runPlanId,
    sourceRunAggregateVersion: 3,
    workspaceId: workspace,
  } as const;
  const manifest: ResultManifest = {
    ...manifestBody,
    manifestHash: canonicalContentHash(manifestBody),
    resultManifestId: resultManifestId("manifest-generation-page"),
  };
  const run = {
    ...baseRun,
    aggregateVersion: 3,
    resultCompleteness: "complete",
    resultManifest: {
      manifestHash: manifest.manifestHash,
      resultManifestId: manifest.resultManifestId,
    },
    state: "completed",
  } as const;
  const authorized = authorizeDatasetGenerationPageEffect(
    persistence.generation,
    persistence.plan,
    {
      now: instant(now + 11),
      pageSequence: page.pageSequence,
      reservedAmount: route.reservableUpperBound,
      unit: route.reservationUnit,
    }
  );
  if (!authorized.ok) {
    throw new Error(authorized.error.message);
  }
  persistence.generation = structuredClone(authorized.value);
  const startedPage = startDatasetGenerationPage(page, {
    attemptId: attemptIdentity,
    costUnit: route.reservationUnit,
    operationKey: operationIdentity,
    providerKey: route.effectAdapterKey,
    reservationId: reservationIdentity,
    reservedAmount: route.reservableUpperBound,
    routeKey: route.routeKey,
    routeSnapshotHash: routingDecision.routeSnapshotHash,
    routingDecisionId: routingIdentity,
    stepRunId: stepIdentity,
  });
  if (!startedPage.ok) {
    throw new Error(startedPage.error.message);
  }
  persistence.page = structuredClone(startedPage.value);
  return {
    artifact,
    artifactValue: output,
    attempt,
    manifest,
    routingDecision,
    run,
    runPlan,
    status: "succeeded",
    stepRun,
    usage,
  };
};

test("authorizes one canonical Run atomically and replays the same page", async () => {
  const persistence = new MemoryFirstPagePersistence(makePlan());
  const first = await authorize(persistence);
  assert.equal(first.ok, true);
  if (!first.ok) {
    return;
  }
  assert.equal(first.value.replayed, false);
  assert.equal(first.value.page.providerKey, undefined);
  assert.equal(persistence.runPlans.size, 1);
  assert.equal(persistence.runInputs.length, 1);
  const runPlan = [...persistence.runPlans.values()][0];
  assert.deepEqual(
    runPlan?.routeSnapshots?.map((route) => route.routeKey),
    ["route-primary", "route-secondary"]
  );
  assert.deepEqual(
    runPlan?.routeSnapshots?.map((route) => route.effectAdapterKey),
    ["synthetic-organizations-primary", "synthetic-organizations-secondary"]
  );
  assert.ok(
    persistence.runInputs[0]?.value !== null &&
      typeof persistence.runInputs[0]?.value === "object" &&
      "kind" in persistence.runInputs[0].value &&
      persistence.runInputs[0].value.kind === "dataset-generation-page-input"
  );

  const replay = await authorize(persistence);
  assert.equal(replay.ok, true);
  if (replay.ok) {
    assert.equal(replay.value.replayed, true);
    assert.equal(replay.value.page.runId, first.value.page.runId);
  }
  assert.equal(persistence.runPlans.size, 1);
  assert.equal(persistence.runInputs.length, 1);

  const unauthorizedReplay = await authorize(
    persistence,
    authorizeRequest({ actorPermissions: [] })
  );
  assert.equal(unauthorizedReplay.ok, false);
  if (!unauthorizedReplay.ok) {
    assert.equal(unauthorizedReplay.error.code, "authority-permission-missing");
  }
});

test("refuses exhausted caps, deadline, and missing Run authority", async () => {
  const scenarios = [
    ["maxPages", makePlan({ maxPages: 0 }), "limit-exhausted"],
    ["maxCalls", makePlan({ maxCalls: 0 }), "limit-exhausted"],
    ["maxResults", makePlan({ maxResults: 0 }), "limit-exhausted"],
    ["deadline", makePlan({ deadline: now }), "deadline-elapsed"],
  ] as const;
  for (const [_name, plan, expectedCode] of scenarios) {
    const result = await authorize(new MemoryFirstPagePersistence(plan));
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error.code, expectedCode);
    }
  }
  const persistence = new MemoryFirstPagePersistence(makePlan());
  const result = await authorize(
    persistence,
    authorizeRequest({ actorPermissions: [] })
  );
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, "authority-permission-missing");
  }
});

test("checkpoints durable records and lineage, replays unchanged, and rejects divergence", async () => {
  const persistence = new MemoryFirstPagePersistence(makePlan());
  const authorized = await authorize(persistence);
  assert.equal(authorized.ok, true);
  const record = {
    datasetId: persistence.plan.requestIntent.targetDataset.datasetId,
    recordId: recordId("record-acme"),
    values: [
      {
        fieldId: persistence.plan.requestIntent.fields[0]
          ?.fieldId as ReturnType<typeof fieldId>,
        value: "Acme Synthetic",
      },
    ],
    workspaceId: workspace,
  } as const;
  const proof = makeSucceededProof(persistence, [
    { contentHash: canonicalContentHash(record), record },
  ]);
  persistence.proof = proof;
  const checkpoint = makeCheckpointFirstDatasetGenerationPage({
    clock: { now: () => Promise.resolve(instant(now + 40)) },
    persistence,
  });
  const first = await checkpoint({
    generationId: generationIdentity,
    workspaceId: workspace,
  });
  assert.equal(first.ok, true);
  if (!first.ok) {
    return;
  }
  assert.equal(first.value.status, "checkpointed");
  assert.equal(persistence.records.length, 1);
  assert.equal(persistence.lineage.length, 1);
  assert.equal(
    persistence.generation.generation.lockedProvider,
    proof.routingDecision.effectAdapterKey
  );

  const replay = await checkpoint({
    generationId: generationIdentity,
    workspaceId: workspace,
  });
  assert.equal(replay.ok, true);
  if (replay.ok) {
    assert.equal(replay.value.status, "unchanged");
  }
  assert.equal(persistence.records.length, 1);

  persistence.proof = {
    ...proof,
    usage: { ...proof.usage, amount: 0.5 },
  };
  const conflict = await checkpoint({
    generationId: generationIdentity,
    workspaceId: workspace,
  });
  assert.equal(conflict.ok, false);
  if (!conflict.ok) {
    assert.equal(conflict.error.code, "checkpoint-conflict");
  }
});

test("commits a certain empty page and locks its provider", async () => {
  const persistence = new MemoryFirstPagePersistence(makePlan());
  assert.equal((await authorize(persistence)).ok, true);
  const proof = makeSucceededProof(persistence, []);
  persistence.proof = proof;
  const result = await makeCheckpointFirstDatasetGenerationPage({
    clock: { now: () => Promise.resolve(instant(now + 40)) },
    persistence,
  })({ generationId: generationIdentity, workspaceId: workspace });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.value.status, "checkpointed");
    assert.equal(result.value.page.returnedCount, 0);
    assert.equal(result.value.page.sourcePartitionCompleted, true);
  }
  assert.equal(persistence.records.length, 0);
  assert.equal(
    persistence.generation.generation.lockedProvider,
    proof.routingDecision.effectAdapterKey
  );
});

test("publishes bounded coverage when the record cap truncates a complete provider page", async () => {
  const persistence = new MemoryFirstPagePersistence(
    makePlan({ maxCompanies: 1, maxResults: 1 })
  );
  assert.equal((await authorize(persistence)).ok, true);
  const record = {
    datasetId: persistence.plan.requestIntent.targetDataset.datasetId,
    recordId: recordId("record-bounded-company"),
    values: [
      {
        fieldId: persistence.plan.requestIntent.fields[0]
          ?.fieldId as ReturnType<typeof fieldId>,
        value: "Bounded Company",
      },
    ],
    workspaceId: workspace,
  } as const;
  persistence.proof = makeSucceededProof(persistence, [
    { contentHash: canonicalContentHash(record), record },
  ]);

  const result = await makeCheckpointFirstDatasetGenerationPage({
    clock: { now: () => Promise.resolve(instant(now + 40)) },
    persistence,
  })({ generationId: generationIdentity, workspaceId: workspace });

  assert.equal(result.ok, true);
  assert.equal(persistence.generation.generation.state, "completed");
  assert.equal(persistence.generation.materialization.state, "ready");
  assert.equal(
    persistence.generation.materialization.completionReason,
    "caps-reached"
  );
  assert.deepEqual(persistence.generation.materialization.coverage, {
    basis: "locked_provider_route",
    status: "bounded",
  });
});

test("uses the contact total instead of the company cap for accepted records", async () => {
  const persistence = new MemoryFirstPagePersistence(makeContactPlan());
  assert.equal((await authorize(persistence)).ok, true);
  const fieldIdentity = persistence.plan.requestIntent.fields[0]
    ?.fieldId as ReturnType<typeof fieldId>;
  const first = {
    datasetId: persistence.plan.requestIntent.targetDataset.datasetId,
    recordId: recordId("record-contact-one"),
    values: [{ fieldId: fieldIdentity, value: "Synthetic Contact One" }],
    workspaceId: workspace,
  } as const;
  const second = {
    ...first,
    recordId: recordId("record-contact-two"),
    values: [{ fieldId: fieldIdentity, value: "Synthetic Contact Two" }],
  } as const;
  persistence.proof = makeSucceededProof(
    persistence,
    [
      {
        contentHash: canonicalContentHash(first),
        providerIdentity: {
          providerKey: "synthetic-organizations-primary",
          providerSubjectId: "provider-contact-one",
        },
        record: first,
      },
      {
        contentHash: canonicalContentHash(second),
        providerIdentity: {
          providerKey: "synthetic-organizations-primary",
          providerSubjectId: "provider-contact-two",
        },
        record: second,
      },
    ],
    { hasMore: true }
  );

  const result = await makeCheckpointFirstDatasetGenerationPage({
    clock: { now: () => Promise.resolve(instant(now + 40)) },
    persistence,
  })({ generationId: generationIdentity, workspaceId: workspace });

  assert.equal(result.ok, true);
  assert.equal(persistence.generation.generation.counters.accepted, 2);
  assert.equal(persistence.generation.generation.state, "completed");
  assert.equal(
    persistence.generation.materialization.completionReason,
    "caps-reached"
  );
});

test("rejects a contact artifact without restricted provider identity", async () => {
  const persistence = new MemoryFirstPagePersistence(makeContactPlan());
  assert.equal((await authorize(persistence)).ok, true);
  const fieldIdentity = persistence.plan.requestIntent.fields[0]
    ?.fieldId as ReturnType<typeof fieldId>;
  const contact = {
    datasetId: persistence.plan.requestIntent.targetDataset.datasetId,
    recordId: recordId("record-contact-missing-provider-lineage"),
    values: [{ fieldId: fieldIdentity, value: "Synthetic Contact" }],
    workspaceId: workspace,
  } as const;
  persistence.proof = makeSucceededProof(persistence, [
    { contentHash: canonicalContentHash(contact), record: contact },
  ]);

  const result = await makeCheckpointFirstDatasetGenerationPage({
    clock: { now: () => Promise.resolve(instant(now + 40)) },
    persistence,
  })({ generationId: generationIdentity, workspaceId: workspace });

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, "artifact-invalid");
  }
  assert.equal(persistence.lineage.length, 0);
  assert.equal(persistence.records.length, 0);
});

test("persists restricted contact provider identity only in internal lineage", async () => {
  const persistence = new MemoryFirstPagePersistence(makeContactPlan());
  assert.equal((await authorize(persistence)).ok, true);
  const fieldIdentity = persistence.plan.requestIntent.fields[0]
    ?.fieldId as ReturnType<typeof fieldId>;
  const contact = {
    datasetId: persistence.plan.requestIntent.targetDataset.datasetId,
    recordId: recordId("record-contact-provider-lineage"),
    values: [{ fieldId: fieldIdentity, value: "Synthetic Contact" }],
    workspaceId: workspace,
  } as const;
  const providerIdentity = {
    providerKey: "synthetic-organizations-primary",
    providerSubjectId: "provider-person-123",
  } as const;
  persistence.proof = makeSucceededProof(persistence, [
    {
      contentHash: canonicalContentHash(contact),
      providerIdentity,
      record: contact,
    },
  ]);

  const result = await makeCheckpointFirstDatasetGenerationPage({
    clock: { now: () => Promise.resolve(instant(now + 40)) },
    persistence,
  })({ generationId: generationIdentity, workspaceId: workspace });

  assert.equal(result.ok, true);
  assert.deepEqual(persistence.lineage[0]?.providerIdentity, providerIdentity);
  assert.equal(
    Object.hasOwn(persistence.records[0]?.record ?? {}, "providerIdentity"),
    false
  );
});

test("rejects contact provider identity which diverges from the effective route", async () => {
  const persistence = new MemoryFirstPagePersistence(makeContactPlan());
  assert.equal((await authorize(persistence)).ok, true);
  const fieldIdentity = persistence.plan.requestIntent.fields[0]
    ?.fieldId as ReturnType<typeof fieldId>;
  const contact = {
    datasetId: persistence.plan.requestIntent.targetDataset.datasetId,
    recordId: recordId("record-contact-provider-mismatch"),
    values: [{ fieldId: fieldIdentity, value: "Synthetic Contact" }],
    workspaceId: workspace,
  } as const;
  persistence.proof = makeSucceededProof(persistence, [
    {
      contentHash: canonicalContentHash(contact),
      providerIdentity: {
        providerKey: "different-provider",
        providerSubjectId: "provider-person-456",
      },
      record: contact,
    },
  ]);

  const result = await makeCheckpointFirstDatasetGenerationPage({
    clock: { now: () => Promise.resolve(instant(now + 40)) },
    persistence,
  })({ generationId: generationIdentity, workspaceId: workspace });

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, "run-proof-invalid");
  }
  assert.equal(persistence.lineage.length, 0);
  assert.equal(persistence.records.length, 0);
});

test("rejects provider identity on an organization discovery artifact", async () => {
  const persistence = new MemoryFirstPagePersistence(makePlan());
  assert.equal((await authorize(persistence)).ok, true);
  const fieldIdentity = persistence.plan.requestIntent.fields[0]
    ?.fieldId as ReturnType<typeof fieldId>;
  const organization = {
    datasetId: persistence.plan.requestIntent.targetDataset.datasetId,
    recordId: recordId("record-organization-provider-lineage"),
    values: [{ fieldId: fieldIdentity, value: "Synthetic Organization" }],
    workspaceId: workspace,
  } as const;
  persistence.proof = makeSucceededProof(persistence, [
    {
      contentHash: canonicalContentHash(organization),
      providerIdentity: {
        providerKey: "synthetic-organizations-primary",
        providerSubjectId: "provider-company-123",
      },
      record: organization,
    },
  ]);

  const result = await makeCheckpointFirstDatasetGenerationPage({
    clock: { now: () => Promise.resolve(instant(now + 40)) },
    persistence,
  })({ generationId: generationIdentity, workspaceId: workspace });

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, "artifact-invalid");
  }
  assert.equal(persistence.lineage.length, 0);
});

test("accepts a certain empty intermediate page with a continuation cursor", async () => {
  const persistence = new MemoryFirstPagePersistence(makePlan());
  assert.equal((await authorize(persistence)).ok, true);
  persistence.proof = makeSucceededProof(persistence, [], {
    hasMore: true,
    nextCursor: "cursor-after-empty-company",
  });
  const checkpoint = await makeCheckpointFirstDatasetGenerationPage({
    clock: { now: () => Promise.resolve(instant(now + 40)) },
    persistence,
  })({ generationId: generationIdentity, workspaceId: workspace });

  assert.equal(checkpoint.ok, true);
  assert.equal(persistence.generation.generation.state, "running");
  assert.equal(persistence.generation.generation.counters.returned, 0);
  const next = await authorize(persistence);
  assert.equal(next.ok, true);
  if (next.ok) {
    assert.equal(next.value.page.pageSequence, 2);
    assert.equal(next.value.page.inputCursor, "cursor-after-empty-company");
  }
});

test("accepts a compensated fractional settlement proof", async () => {
  const persistence = new MemoryFirstPagePersistence(
    makePlan({
      hardExecutionCap: 0.3,
      routeUpperBounds: [0.3, 0.2],
    })
  );
  assert.equal((await authorize(persistence)).ok, true);
  persistence.proof = makeSucceededProof(persistence, [], {
    releasedAmount: 0.1,
    usageAmount: 0.2,
  });

  const result = await makeCheckpointFirstDatasetGenerationPage({
    clock: { now: () => Promise.resolve(instant(now + 40)) },
    persistence,
  })({ generationId: generationIdentity, workspaceId: workspace });

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.value.status, "checkpointed");
    assert.equal(result.value.page.costAmount, 0.2);
  }
});

test("rejects a terminal page without source-partition completion", async () => {
  const persistence = new MemoryFirstPagePersistence(makePlan());
  assert.equal((await authorize(persistence)).ok, true);
  const proof = makeSucceededProof(persistence, []);
  persistence.proof = {
    ...proof,
    artifactValue: {
      hasMore: false,
      items: [],
      nextCursor: null,
      sourcePartitionCompleted: false,
      version: "1.0.0",
    },
  };

  const result = await makeCheckpointFirstDatasetGenerationPage({
    clock: { now: () => Promise.resolve(instant(now + 40)) },
    persistence,
  })({ generationId: generationIdentity, workspaceId: workspace });

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, "artifact-invalid");
  }
});

test("projects an ambiguous Run proof and never appends records", async () => {
  const persistence = new MemoryFirstPagePersistence(makePlan());
  assert.equal((await authorize(persistence)).ok, true);
  const proof = makeSucceededProof(persistence, []);
  persistence.proof = {
    attemptId: proof.attempt.attemptId,
    status: "ambiguous",
    stepRunId: proof.stepRun.stepRunId,
  };
  const result = await makeCheckpointFirstDatasetGenerationPage({
    clock: { now: () => Promise.resolve(instant(now + 40)) },
    persistence,
  })({ generationId: generationIdentity, workspaceId: workspace });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.value.status, "ambiguous");
    assert.equal(result.value.page.state, "ambiguous");
  }
  assert.equal(persistence.generation.generation.state, "ambiguous");
  assert.equal(persistence.records.length, 0);
});

test("continues with the predecessor cursor, deduplicates, and publishes ready", async () => {
  const persistence = new MemoryFirstPagePersistence(makePlan());
  assert.equal((await authorize(persistence)).ok, true);
  const fieldIdentity = persistence.plan.requestIntent.fields[0]
    ?.fieldId as ReturnType<typeof fieldId>;
  const acme = {
    datasetId: persistence.plan.requestIntent.targetDataset.datasetId,
    recordId: recordId("record-acme-multipage"),
    values: [{ fieldId: fieldIdentity, value: "Acme" }],
    workspaceId: workspace,
  } as const;
  persistence.proof = makeSucceededProof(
    persistence,
    [{ contentHash: canonicalContentHash(acme), record: acme }],
    { hasMore: true, nextCursor: "cursor-page-2" }
  );
  const checkpoint = makeCheckpointFirstDatasetGenerationPage({
    clock: { now: () => Promise.resolve(instant(now + 40)) },
    persistence,
  });
  assert.equal(
    (
      await checkpoint({
        generationId: generationIdentity,
        workspaceId: workspace,
      })
    ).ok,
    true
  );

  const pageTwo = await authorize(persistence);
  assert.equal(pageTwo.ok, true);
  if (!pageTwo.ok) {
    return;
  }
  assert.equal(pageTwo.value.page.pageSequence, 2);
  assert.equal(pageTwo.value.page.inputCursor, "cursor-page-2");
  const pageTwoInput = persistence.runInputs.at(-1)?.value as Readonly<{
    limits: Readonly<{ maxResults: number }>;
  }>;
  assert.equal(pageTwoInput.limits.maxResults, 9);
  const beta = {
    ...acme,
    recordId: recordId("record-beta-multipage"),
    values: [{ fieldId: fieldIdentity, value: "Beta" }],
  } as const;
  persistence.proof = makeSucceededProof(persistence, [
    { contentHash: canonicalContentHash(acme), record: acme },
    { contentHash: canonicalContentHash(beta), record: beta },
  ]);
  const final = await checkpoint({
    generationId: generationIdentity,
    workspaceId: workspace,
  });
  assert.equal(final.ok, true);
  assert.equal(persistence.generation.generation.state, "completed");
  assert.equal(persistence.generation.materialization.state, "ready");
  assert.equal(persistence.generation.generation.counters.pages, 2);
  assert.equal(persistence.generation.generation.counters.accepted, 2);
  assert.equal(persistence.generation.generation.counters.duplicates, 1);
  assert.equal(persistence.records.length, 2);
});
