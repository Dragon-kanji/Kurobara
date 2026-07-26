import assert from "node:assert/strict";
import test from "node:test";

import {
  actorId,
  artifactId,
  attemptId,
  authorizeDatasetGenerationPageEffect,
  cancelDatasetGenerationAfterStop,
  capabilityId,
  checkpointDatasetGenerationPageProgress,
  commitDatasetGenerationPage,
  contentHash,
  costReservationId,
  createDatasetGeneration,
  createDatasetGenerationPlan,
  createDatasetMaterialization,
  type DatasetGenerationPlan,
  type DatasetGenerationQueryValue,
  datasetGenerationAcceptedRecordLimit,
  datasetGenerationId,
  datasetGenerationPlanId,
  datasetId,
  datasetMaterializationId,
  fieldId,
  idempotencyKey,
  instant,
  markDatasetGenerationAmbiguous,
  operationKey,
  requestDatasetGenerationStop,
  resultManifestId,
  routingDecisionId,
  runId,
  runPlanId,
  snapshotDatasetGenerationQuery,
  startDatasetGenerationPage,
  stepRunId,
  usageEntryId,
  validateDatasetGenerationRequestIntent,
  workspaceId,
} from "../src/index.ts";

const hash = (character: string) =>
  contentHash(`sha256:${character.repeat(64).slice(0, 64)}`);
const workspace = workspaceId("workspace-generation");
const actor = actorId("actor-generation");
const capability = {
  capabilityId: capabilityId("organizations.discover"),
  capabilityVersion: "1.0.0",
} as const;
const deadline = instant(1_800_000_060_000);

const plan = (): DatasetGenerationPlan => {
  const targetDataset = {
    datasetId: datasetId("dataset-companies"),
    name: "Synthetic companies",
    workspaceId: workspace,
  };
  const fields = [
    {
      datasetId: targetDataset.datasetId,
      fieldId: fieldId("field-name"),
      key: "company_name",
      label: "Company name",
      valueType: "string",
      workspaceId: workspace,
    },
  ] as const;
  const budget = { limit: 10, reserved: 0, spent: 0, unit: "credits" };
  return {
    authority: {
      authorityEnvelopeId: "authority-generation",
      budgetLimit: budget,
      capabilities: [capability],
      deadline,
      permissions: ["datasets:generate", "steps:execute"],
      subjectActorId: actor,
      version: "1.0.0",
      workspaceId: workspace,
    },
    budget,
    deadline,
    generationPlanId: datasetGenerationPlanId("generation-plan-1"),
    hardExecutionCap: 2,
    idempotencyKey: idempotencyKey("generation-create-1"),
    limits: {
      maxCalls: 2,
      maxCompanies: 10,
      maxContactsPerCompany: 0,
      maxContactsTotal: 0,
      maxEnrichments: 0,
      maxPages: 2,
      maxPhones: 0,
      maxResults: 10,
    },
    normalizedQuery: { country: "ES" },
    normalizerVersion: "normalizer-1",
    planHash: hash("f"),
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
    queryHash: hash("d"),
    quote: {
      expiresAt: instant(deadline + 60_000),
      guarantee: "hard",
      pricingVersion: "pricing-1",
      quoteId: "quote-1",
      unit: "credits",
      upperBound: 2,
    },
    requestIntent: {
      actorId: actor,
      authorityEnvelopeId: "authority-generation",
      capability,
      fields,
      limits: {
        maxCalls: 2,
        maxCompanies: 10,
        maxContactsPerCompany: 0,
        maxContactsTotal: 0,
        maxEnrichments: 0,
        maxPages: 2,
        maxPhones: 0,
        maxResults: 10,
      },
      requestedBudget: { limit: 10, unit: "credits" },
      requestedDeadline: deadline,
      requestedQuery: { country: "es" },
      targetDataset,
      unknownCostPolicy: { mode: "deny" },
      workspaceId: workspace,
    },
    requestIntentHash: hash("e"),
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
    schemaHash: hash("8"),
    workspaceId: workspace,
  };
};

test("accepts a complete provider-neutral generation plan", () => {
  const result = createDatasetGenerationPlan(plan());
  assert.equal(result.ok, true);
});

test("selects accepted record caps by generation capability", () => {
  const organizationPlan = plan();
  assert.equal(datasetGenerationAcceptedRecordLimit(organizationPlan), 10);

  const contactCapability = {
    capabilityId: capabilityId("contacts.discover"),
    capabilityVersion: "1.0.0",
  } as const;
  const contactPlan: DatasetGenerationPlan = {
    ...organizationPlan,
    limits: {
      ...organizationPlan.limits,
      maxCompanies: 1,
      maxContactsTotal: 6,
      maxResults: 12,
    },
    requestIntent: {
      ...organizationPlan.requestIntent,
      capability: contactCapability,
    },
  };
  assert.equal(datasetGenerationAcceptedRecordLimit(contactPlan), 6);

  const genericPlan: DatasetGenerationPlan = {
    ...organizationPlan,
    limits: { ...organizationPlan.limits, maxCompanies: 1, maxResults: 7 },
    requestIntent: {
      ...organizationPlan.requestIntent,
      capability: {
        capabilityId: capabilityId("datasets.synthetic"),
        capabilityVersion: "1.0.0",
      },
    },
  };
  assert.equal(datasetGenerationAcceptedRecordLimit(genericPlan), 7);
});

test("creates a zero-progress planned generation with deterministic materialization identity", () => {
  const candidate = plan();
  const result = createDatasetGeneration({
    createdAt: instant(1_800_000_000_000),
    generationId: datasetGenerationId("generation-1"),
    plan: candidate,
  });

  assert.equal(result.ok, true);
  if (!result.ok) {
    return;
  }
  assert.deepEqual(result.value.generation.counters, {
    accepted: 0,
    calls: 0,
    duplicates: 0,
    pages: 0,
    rejected: 0,
    returned: 0,
  });
  assert.deepEqual(result.value.generation.cost, {
    reserved: 0,
    spent: 0,
    unit: candidate.budget.unit,
  });
  assert.equal(result.value.generation.state, "planned");
  assert.equal(
    result.value.materialization.materializationId,
    datasetMaterializationId(
      String(candidate.requestIntent.targetDataset.datasetId)
    )
  );
  assert.deepEqual(result.value.materialization.origin, {
    generationId: datasetGenerationId("generation-1"),
    kind: "generation",
  });
  assert.equal(result.value.materialization.state, "building");
});

test("authorizes and checkpoints the first generation page monotonically", () => {
  const candidate = plan();
  const created = createDatasetGeneration({
    createdAt: instant(1_800_000_000_000),
    generationId: datasetGenerationId("generation-progress"),
    plan: candidate,
  });
  assert.equal(created.ok, true);
  if (!created.ok) {
    return;
  }

  const authorized = authorizeDatasetGenerationPageEffect(
    created.value,
    candidate,
    {
      now: instant(1_800_000_010_000),
      pageSequence: 1,
      reservedAmount: 2,
      unit: "credits",
    }
  );
  assert.equal(authorized.ok, true);
  if (!authorized.ok) {
    return;
  }
  assert.equal(authorized.value.generation.state, "running");
  assert.deepEqual(authorized.value.generation.counters, {
    accepted: 0,
    calls: 1,
    duplicates: 0,
    pages: 1,
    rejected: 0,
    returned: 0,
  });
  assert.equal(authorized.value.generation.cost.reserved, 2);

  const checkpointed = checkpointDatasetGenerationPageProgress(
    authorized.value,
    candidate,
    {
      accepted: 2,
      costAmount: 1.5,
      costUnit: "credits",
      duplicates: 1,
      pageSequence: 1,
      providerKey: "synthetic-organizations",
      rejected: 1,
      returned: 4,
    }
  );
  assert.equal(checkpointed.ok, true);
  if (!checkpointed.ok) {
    return;
  }
  assert.equal(checkpointed.value.generation.cost.reserved, 0);
  assert.equal(checkpointed.value.generation.cost.spent, 1.5);
  assert.equal(
    checkpointed.value.generation.lockedProvider,
    "synthetic-organizations"
  );
  assert.equal(checkpointed.value.generation.lastPageSequence, 1);
  assert.equal(checkpointed.value.materialization.recordCount, 2);
  assert.equal(checkpointed.value.materialization.revision, 2);
});

test("blocks stale page authorization and preserves ambiguous reservations", () => {
  const candidate = plan();
  const created = createDatasetGeneration({
    createdAt: instant(1_800_000_000_000),
    generationId: datasetGenerationId("generation-ambiguous"),
    plan: candidate,
  });
  assert.equal(created.ok, true);
  if (!created.ok) {
    return;
  }
  const stale = authorizeDatasetGenerationPageEffect(created.value, candidate, {
    now: candidate.deadline,
    pageSequence: 1,
    reservedAmount: 2,
    unit: "credits",
  });
  assert.equal(stale.ok, false);

  const authorized = authorizeDatasetGenerationPageEffect(
    created.value,
    candidate,
    {
      now: instant(1_800_000_010_000),
      pageSequence: 1,
      reservedAmount: 2,
      unit: "credits",
    }
  );
  assert.equal(authorized.ok, true);
  if (!authorized.ok) {
    return;
  }
  const ambiguous = markDatasetGenerationAmbiguous(authorized.value, candidate);
  assert.equal(ambiguous.ok, true);
  if (ambiguous.ok) {
    assert.equal(ambiguous.value.generation.state, "ambiguous");
    assert.equal(ambiguous.value.generation.cost.reserved, 2);
    assert.equal(ambiguous.value.materialization.state, "ambiguous");
  }
});

test("stops before effect immediately and waits for a certain in-flight issue", () => {
  const candidate = plan();
  const created = createDatasetGeneration({
    createdAt: instant(1_800_000_000_000),
    generationId: datasetGenerationId("generation-stop"),
    plan: candidate,
  });
  assert.equal(created.ok, true);
  if (!created.ok) {
    return;
  }
  const stoppedBeforeEffect = requestDatasetGenerationStop(
    created.value,
    candidate,
    { reason: "requested", requestedAt: instant(1_800_000_001_000) }
  );
  assert.equal(stoppedBeforeEffect.ok, true);
  if (stoppedBeforeEffect.ok) {
    assert.equal(stoppedBeforeEffect.value.generation.state, "cancelled");
    assert.equal(stoppedBeforeEffect.value.materialization.state, "cancelled");
    assert.deepEqual(stoppedBeforeEffect.value.generation.stop, {
      reason: "requested",
      requestedAt: instant(1_800_000_001_000),
    });
  }

  const authorized = authorizeDatasetGenerationPageEffect(
    created.value,
    candidate,
    {
      now: instant(1_800_000_010_000),
      pageSequence: 1,
      reservedAmount: 2,
      unit: "credits",
    }
  );
  assert.equal(authorized.ok, true);
  if (!authorized.ok) {
    return;
  }
  const stopping = requestDatasetGenerationStop(authorized.value, candidate, {
    reason: "requested",
    requestedAt: instant(1_800_000_011_000),
  });
  assert.equal(stopping.ok, true);
  if (!stopping.ok) {
    return;
  }
  assert.equal(stopping.value.generation.state, "stopping");
  assert.equal(stopping.value.generation.cost.reserved, 2);
  assert.equal(stopping.value.materialization.state, "building");

  const ambiguous = markDatasetGenerationAmbiguous(stopping.value, candidate);
  assert.equal(ambiguous.ok, true);
  if (ambiguous.ok) {
    assert.equal(ambiguous.value.generation.state, "ambiguous");
    assert.equal(ambiguous.value.generation.cost.reserved, 2);
    assert.equal(ambiguous.value.materialization.state, "ambiguous");
  }

  const cancelled = cancelDatasetGenerationAfterStop(
    stopping.value,
    candidate,
    instant(1_800_000_012_000)
  );
  assert.equal(cancelled.ok, true);
  if (cancelled.ok) {
    assert.equal(cancelled.value.generation.state, "cancelled");
    assert.equal(cancelled.value.generation.cost.reserved, 0);
    assert.equal(cancelled.value.materialization.state, "cancelled");
  }
});

test("binds page effect and checkpoint evidence through guarded states", () => {
  const candidate = plan();
  const page = {
    aggregateVersion: 1,
    createdAt: instant(1_800_000_000_000),
    generationId: datasetGenerationId("generation-page-state"),
    inputContentHash: hash("1"),
    inputCursor: null,
    inputId: "input-page-state",
    pageSequence: 1,
    runId: runId("run-page-state"),
    runPlanId: runPlanId("run-plan-page-state"),
    state: "run_created",
    workspaceId: candidate.workspaceId,
  } as const;
  const started = startDatasetGenerationPage(page, {
    attemptId: attemptId("attempt-page-state"),
    costUnit: "credits",
    operationKey: operationKey("operation-page-state"),
    providerKey: "synthetic-organizations",
    reservationId: costReservationId("reservation-page-state"),
    reservedAmount: 2,
    routeKey: "synthetic-primary",
    routeSnapshotHash: hash("2"),
    routingDecisionId: routingDecisionId("routing-page-state"),
    stepRunId: stepRunId("step-page-state"),
  });
  assert.equal(started.ok, true);
  if (!started.ok) {
    return;
  }
  const committed = commitDatasetGenerationPage(started.value, {
    acceptedCount: 1,
    artifactContentHash: hash("3"),
    artifactId: artifactId("artifact-page-state"),
    checkpointHash: hash("4"),
    committedAt: instant(1_800_000_020_000),
    costAmount: 1,
    duplicateCount: 0,
    hasMore: false,
    nextCursor: null,
    rejectedCount: 0,
    resultManifestHash: hash("5"),
    resultManifestId: resultManifestId("manifest-page-state"),
    returnedCount: 1,
    sourcePartitionCompleted: true,
    usageEntryId: usageEntryId("usage-page-state"),
  });
  assert.equal(committed.ok, true);
  if (committed.ok) {
    assert.equal(committed.value.state, "committed");
    assert.equal(committed.value.aggregateVersion, 3);
    assert.equal(committed.value.checkpointHash, hash("4"));
  }

  const incompleteTerminalPage = commitDatasetGenerationPage(started.value, {
    acceptedCount: 1,
    artifactContentHash: hash("3"),
    artifactId: artifactId("artifact-page-state"),
    checkpointHash: hash("4"),
    committedAt: instant(1_800_000_020_000),
    costAmount: 1,
    duplicateCount: 0,
    hasMore: false,
    nextCursor: null,
    rejectedCount: 0,
    resultManifestHash: hash("5"),
    resultManifestId: resultManifestId("manifest-page-state"),
    returnedCount: 1,
    sourcePartitionCompleted: false,
    usageEntryId: usageEntryId("usage-page-state"),
  });
  assert.equal(incompleteTerminalPage.ok, false);
});

test("preserves bounded product and planning text inherited by a generation", () => {
  const candidate = plan();
  const compatibleCapability = {
    capabilityId: capabilityId(" organizations.discover "),
    capabilityVersion: " 1.0.0 ",
  } as const;
  const compatibleUnit = " credits ";
  const compatibleDataset = {
    ...candidate.requestIntent.targetDataset,
    datasetId: datasetId(" dataset-companies "),
  };
  const compatiblePlan: DatasetGenerationPlan = {
    ...candidate,
    authority: {
      ...candidate.authority,
      budgetLimit: {
        ...candidate.authority.budgetLimit,
        unit: compatibleUnit,
      },
      capabilities: [compatibleCapability],
    },
    budget: { ...candidate.budget, unit: compatibleUnit },
    quote: { ...candidate.quote, unit: compatibleUnit },
    requestIntent: {
      ...candidate.requestIntent,
      capability: compatibleCapability,
      fields: candidate.requestIntent.fields.map((field) => ({
        ...field,
        datasetId: compatibleDataset.datasetId,
      })),
      requestedBudget: {
        ...candidate.requestIntent.requestedBudget,
        unit: compatibleUnit,
      },
      targetDataset: compatibleDataset,
    },
    routeSnapshots: candidate.routeSnapshots.map((route) => ({
      ...route,
      capability: compatibleCapability,
      reservationUnit: compatibleUnit,
    })),
  };

  const result = createDatasetGeneration({
    createdAt: instant(1_800_000_000_000),
    generationId: datasetGenerationId("generation-compatible"),
    plan: compatiblePlan,
  });

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.value.generation.cost.unit, compatibleUnit);
    assert.equal(
      result.value.materialization.datasetId,
      compatibleDataset.datasetId
    );
  }
});

test("accepts import materialization identities valid before 001B", () => {
  const result = createDatasetMaterialization({
    createdAt: instant(1_800_000_000_000),
    datasetId: datasetId(" dataset-imported "),
    materializationId: datasetMaterializationId(" dataset-imported "),
    origin: { importId: " import-existing ", kind: "import" },
    recordCount: 0,
    rejectedCount: 0,
    revision: 1,
    schemaHash: hash("7"),
    state: "building",
    workspaceId: workspaceId(" workspace-existing "),
  });

  assert.equal(result.ok, true);
});

test("rejects a malformed ready materialization without exact terminal proofs", () => {
  const candidate = plan();
  const result = createDatasetMaterialization({
    completedAt: instant(1_800_000_000_001),
    completionReason: "source-exhausted",
    createdAt: instant(1_800_000_000_000),
    datasetId: candidate.requestIntent.targetDataset.datasetId,
    materializationId: datasetMaterializationId(
      String(candidate.requestIntent.targetDataset.datasetId)
    ),
    origin: {
      generationId: datasetGenerationId("generation-1"),
      kind: "generation",
    },
    recordCount: 1,
    rejectedCount: 0,
    revision: 2,
    schemaHash: candidate.schemaHash,
    state: "ready",
    workspaceId: candidate.workspaceId,
  });

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, "terminal-proof-invalid");
  }
});

test("rejects a generation plan whose target dataset crosses workspace scope", () => {
  const candidate = plan();
  const result = createDatasetGeneration({
    createdAt: instant(1_800_000_000_000),
    generationId: datasetGenerationId("generation-1"),
    plan: {
      ...candidate,
      requestIntent: {
        ...candidate.requestIntent,
        targetDataset: {
          ...candidate.requestIntent.targetDataset,
          workspaceId: workspaceId("workspace-other"),
        },
      },
    },
  });

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, "plan-invalid");
  }
});

test("rejects authority and route escalation", () => {
  const candidate = plan();
  const missingExecutionPermission = createDatasetGenerationPlan({
    ...candidate,
    authority: {
      ...candidate.authority,
      permissions: ["datasets:generate"],
    },
  });
  assert.equal(missingExecutionPermission.ok, false);
  if (!missingExecutionPermission.ok) {
    assert.equal(missingExecutionPermission.error.code, "authority-invalid");
  }

  const wrongScope = createDatasetGenerationPlan({
    ...candidate,
    workspaceId: workspaceId("workspace-other"),
  });
  assert.equal(wrongScope.ok, false);
  if (!wrongScope.ok) {
    assert.equal(wrongScope.error.code, "scope-mismatch");
  }

  const wrongUnit = createDatasetGenerationPlan({
    ...candidate,
    routeSnapshots: [
      { ...candidate.routeSnapshots[0], reservationUnit: "requests" },
    ],
  });
  assert.equal(wrongUnit.ok, false);
  if (!wrongUnit.ok) {
    assert.equal(wrongUnit.error.code, "route-invalid");
  }

  const wrongFacts = createDatasetGenerationPlan({
    ...candidate,
    routeSnapshots: [{ ...candidate.routeSnapshots[0], factsHash: hash("9") }],
  });
  assert.equal(wrongFacts.ok, false);
  if (!wrongFacts.ok) {
    assert.equal(wrongFacts.error.code, "route-invalid");
  }

  const overCap = createDatasetGenerationPlan({
    ...candidate,
    routeSnapshots: [
      { ...candidate.routeSnapshots[0], reservableUpperBound: 3 },
    ],
  });
  assert.equal(overCap.ok, false);
  if (!overCap.ok) {
    assert.equal(overCap.error.code, "route-invalid");
  }

  const duplicateRoute = candidate.routeSnapshots[0];
  const duplicateRoutes = createDatasetGenerationPlan({
    ...candidate,
    routeSnapshots: [duplicateRoute, duplicateRoute],
  });
  assert.equal(duplicateRoutes.ok, false);
  if (!duplicateRoutes.ok) {
    assert.equal(duplicateRoutes.error.code, "route-invalid");
  }

  const { upperBound: _upperBound, ...quoteWithoutBound } = candidate.quote;
  const unauthorizedUnknownCost = createDatasetGenerationPlan({
    ...candidate,
    quote: { ...quoteWithoutBound, guarantee: "unknown" },
  });
  assert.equal(unauthorizedUnknownCost.ok, false);
  if (!unauthorizedUnknownCost.ok) {
    assert.equal(unauthorizedUnknownCost.error.code, "budget-invalid");
  }
});

test("accepts fractional monetary caps and rejects omitted requested caps", () => {
  const candidate = plan();
  const fractional = createDatasetGenerationPlan({
    ...candidate,
    hardExecutionCap: 0.25,
    quote: { ...candidate.quote, upperBound: 0.25 },
    routeSnapshots: [
      { ...candidate.routeSnapshots[0], reservableUpperBound: 0.25 },
    ],
  });
  assert.equal(fractional.ok, true);

  const { maxCalls: _maxCalls, ...limitsWithoutCalls } =
    candidate.requestIntent.limits;
  const omitted = createDatasetGenerationPlan({
    ...candidate,
    requestIntent: {
      ...candidate.requestIntent,
      limits: limitsWithoutCalls,
    },
  });
  assert.equal(omitted.ok, false);
  if (!omitted.ok) {
    assert.equal(omitted.error.code, "budget-invalid");
  }
});

test("rejects an unbounded request query before planning", () => {
  const candidate = plan();
  let query: DatasetGenerationQueryValue = "leaf";
  for (let depth = 0; depth < 34; depth += 1) {
    query = [query];
  }
  const result = validateDatasetGenerationRequestIntent({
    ...candidate.requestIntent,
    requestedQuery: query,
  });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, "query-invalid");
  }
});

test("snapshots inert query JSON and fails closed on hostile or expanded shapes", () => {
  const accepted = snapshotDatasetGenerationQuery({
    country: "ES",
    filters: ["software", true, null],
  });
  assert.equal(accepted.ok, true);

  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  let tooDeep: unknown = "leaf";
  for (let depth = 0; depth < 34; depth += 1) {
    tooDeep = [tooDeep];
  }
  const tooManyNodes = Array.from({ length: 1000 }, () =>
    Array.from({ length: 10 }, () => null)
  );
  const tooManyBytes = Object.fromEntries(
    Array.from({ length: 65 }, (_, index) => [
      `filter_${index}`,
      "x".repeat(16_384),
    ])
  );
  const unsafeKey: Record<string, unknown> = Object.create(null);
  Object.defineProperty(unsafeKey, "__proto__", {
    enumerable: true,
    value: "not-a-query-key",
  });

  for (const invalid of [
    cyclic,
    tooDeep,
    tooManyNodes,
    tooManyBytes,
    unsafeKey,
    undefined,
  ]) {
    const result = snapshotDatasetGenerationQuery(invalid);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error.code, "query-invalid");
    }
  }
});
