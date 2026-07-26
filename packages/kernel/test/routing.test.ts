import assert from "node:assert/strict";
import test from "node:test";

import {
  capabilityId,
  contentHash,
  createRoutingDecision,
  instant,
  routingDecisionId,
  runId,
  stepRunId,
  validateRunPlanRouteSnapshots,
  workflowSpecId,
  workspaceId,
} from "../src/index.ts";

const hash = (character: string) =>
  contentHash(`sha256:${character.repeat(64)}`);
const capability = {
  capabilityId: capabilityId("documents.summarize"),
  capabilityVersion: "1.0.0",
};
const candidate = {
  capability,
  effectAdapterKey: "deterministic-local",
  factsHash: hash("a"),
  nodeKey: "summarize",
  pricingVersion: "1.0.0",
  reservableUpperBound: 0.25,
  reservationUnit: "credits",
  routeKey: "local-primary",
} as const;

test("records an immutable exact-capability routing decision", () => {
  const result = createRoutingDecision({
    candidate,
    decidedAt: instant(2000),
    expectedCapability: capability,
    expectedNodeKey: "summarize",
    expectedPricingVersion: "1.0.0",
    policyFactsHash: hash("a"),
    policyVersion: "1.0.0",
    routeSnapshotHash: hash("c"),
    routingDecisionId: routingDecisionId("routing-test"),
    runId: runId("run-routing"),
    stepRunId: stepRunId("step-routing"),
    workspaceId: workspaceId("workspace-routing"),
  });

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.value.routeKey, "local-primary");
    assert.equal(result.value.effectAdapterKey, "deterministic-local");
    assert.equal(result.value.reservedAmount, 0.25);
  }
});

test("rejects routes outside their node, capability, unit or provenance", () => {
  const workflow = {
    compilerVersion: "1.0.0",
    fingerprint: "routing-workflow",
    nodes: [{ capability, dependsOn: [], depth: 0, key: "summarize" }],
    workflowContentHash: hash("d"),
    workflowRevision: "1.0.0",
    workflowSpecId: workflowSpecId("workflow-routing"),
  };
  const wrongNode = validateRunPlanRouteSnapshots(
    [{ ...candidate, nodeKey: "other" }],
    workflow,
    { limit: 1, unit: "credits" },
    {
      guarantee: "hard",
      pricingVersion: "1.0.0",
      unit: "credits",
      upperBound: 1,
    },
    { maxAttemptsPerStep: 1 },
    hash("a")
  );
  const wrongUnit = validateRunPlanRouteSnapshots(
    [{ ...candidate, reservationUnit: "usd" }],
    workflow,
    { limit: 1, unit: "credits" },
    {
      guarantee: "hard",
      pricingVersion: "1.0.0",
      unit: "credits",
      upperBound: 1,
    },
    { maxAttemptsPerStep: 1 },
    hash("a")
  );
  const wrongProvenance = validateRunPlanRouteSnapshots(
    [{ ...candidate, factsHash: hash("f"), pricingVersion: "2.0.0" }],
    workflow,
    { limit: 1, unit: "credits" },
    {
      guarantee: "hard",
      pricingVersion: "1.0.0",
      unit: "credits",
      upperBound: 1,
    },
    { maxAttemptsPerStep: 1 },
    hash("a")
  );

  assert.equal(wrongNode.ok, false);
  assert.equal(wrongUnit.ok, false);
  assert.equal(wrongProvenance.ok, false);
  if (!(wrongNode.ok || wrongUnit.ok || wrongProvenance.ok)) {
    assert.equal(wrongNode.error.code, "node-mismatch");
    assert.equal(wrongUnit.error.code, "invalid-route-snapshot");
    assert.equal(wrongProvenance.error.code, "invalid-route-snapshot");
  }
});

test("rejects a route reservation above the immutable budget or quote", () => {
  const workflow = {
    compilerVersion: "1.0.0",
    fingerprint: "routing-workflow",
    nodes: [{ capability, dependsOn: [], depth: 0, key: "summarize" }],
    workflowContentHash: hash("d"),
    workflowRevision: "1.0.0",
    workflowSpecId: workflowSpecId("workflow-routing"),
  };

  const aboveBudget = validateRunPlanRouteSnapshots(
    [{ ...candidate, reservableUpperBound: 2 }],
    workflow,
    { limit: 1, unit: "credits" },
    {
      guarantee: "hard",
      pricingVersion: "1.0.0",
      unit: "credits",
      upperBound: 1,
    },
    { maxAttemptsPerStep: 1 },
    hash("a")
  );
  const aboveQuote = validateRunPlanRouteSnapshots(
    [{ ...candidate, reservableUpperBound: 0.75 }],
    workflow,
    { limit: 1, unit: "credits" },
    {
      guarantee: "hard",
      pricingVersion: "1.0.0",
      unit: "credits",
      upperBound: 0.5,
    },
    { maxAttemptsPerStep: 1 },
    hash("a")
  );

  assert.equal(aboveBudget.ok, false);
  assert.equal(aboveQuote.ok, false);
});

test("bounds a hard quote by the worst fallback for every node and retry", () => {
  const translateCapability = {
    capabilityId: capabilityId("documents.translate"),
    capabilityVersion: "1.0.0",
  };
  const workflow = {
    compilerVersion: "1.0.0",
    fingerprint: "routing-workflow",
    nodes: [
      { capability, dependsOn: [], depth: 0, key: "summarize" },
      {
        capability: translateCapability,
        dependsOn: ["summarize"],
        depth: 1,
        key: "translate",
      },
    ],
    workflowContentHash: hash("d"),
    workflowRevision: "1.0.0",
    workflowSpecId: workflowSpecId("workflow-routing"),
  };
  const routes = [
    candidate,
    { ...candidate, reservableUpperBound: 1, routeKey: "local-fallback" },
    {
      ...candidate,
      capability: translateCapability,
      nodeKey: "translate",
      reservableUpperBound: 0.5,
      routeKey: "translation-primary",
    },
  ] as const;

  const rejected = validateRunPlanRouteSnapshots(
    routes,
    workflow,
    { limit: 3, unit: "credits" },
    {
      guarantee: "hard",
      pricingVersion: "1.0.0",
      unit: "credits",
      upperBound: 2.99,
    },
    { maxAttemptsPerStep: 2 },
    hash("a")
  );
  const accepted = validateRunPlanRouteSnapshots(
    routes,
    workflow,
    { limit: 3, unit: "credits" },
    {
      guarantee: "hard",
      pricingVersion: "1.0.0",
      unit: "credits",
      upperBound: 3,
    },
    { maxAttemptsPerStep: 2 },
    hash("a")
  );

  assert.equal(rejected.ok, false);
  assert.equal(accepted.ok, true);
});

test("does not treat estimated or unknown bounds as hard execution caps", () => {
  const workflow = {
    compilerVersion: "1.0.0",
    fingerprint: "routing-workflow",
    nodes: [{ capability, dependsOn: [], depth: 0, key: "summarize" }],
    workflowContentHash: hash("d"),
    workflowRevision: "1.0.0",
    workflowSpecId: workflowSpecId("workflow-routing"),
  };

  for (const guarantee of ["estimated", "unknown"] as const) {
    const result = validateRunPlanRouteSnapshots(
      [{ ...candidate, reservableUpperBound: 0.75 }],
      workflow,
      { limit: 3, unit: "credits" },
      {
        guarantee,
        pricingVersion: "1.0.0",
        unit: "credits",
        upperBound: 0.5,
      },
      { maxAttemptsPerStep: 3 },
      hash("a")
    );

    assert.equal(result.ok, true);
  }
});

test("rejects an unbounded hard quote or invalid retry policy", () => {
  const workflow = {
    compilerVersion: "1.0.0",
    fingerprint: "routing-workflow",
    nodes: [{ capability, dependsOn: [], depth: 0, key: "summarize" }],
    workflowContentHash: hash("d"),
    workflowRevision: "1.0.0",
    workflowSpecId: workflowSpecId("workflow-routing"),
  };
  const quote = {
    guarantee: "hard",
    pricingVersion: "1.0.0",
    unit: "credits",
  } as const;

  const unbounded = validateRunPlanRouteSnapshots(
    [candidate],
    workflow,
    { limit: 1, unit: "credits" },
    quote,
    { maxAttemptsPerStep: 1 },
    hash("a")
  );
  const invalidRetry = validateRunPlanRouteSnapshots(
    [candidate],
    workflow,
    { limit: 1, unit: "credits" },
    { ...quote, upperBound: 1 },
    { maxAttemptsPerStep: 0 },
    hash("a")
  );

  assert.equal(unbounded.ok, false);
  assert.equal(invalidRetry.ok, false);
});

test("accepts a hard bound equal to a compensated fractional sum", () => {
  const secondCapability = {
    capabilityId: capabilityId("documents.classify"),
    capabilityVersion: "1.0.0",
  };
  const workflow = {
    compilerVersion: "1.0.0",
    fingerprint: "routing-workflow",
    nodes: [
      { capability, dependsOn: [], depth: 0, key: "summarize" },
      {
        capability: secondCapability,
        dependsOn: [],
        depth: 0,
        key: "classify",
      },
    ],
    workflowContentHash: hash("d"),
    workflowRevision: "1.0.0",
    workflowSpecId: workflowSpecId("workflow-routing"),
  };

  const result = validateRunPlanRouteSnapshots(
    [
      { ...candidate, reservableUpperBound: 0.1 },
      {
        ...candidate,
        capability: secondCapability,
        nodeKey: "classify",
        reservableUpperBound: 0.2,
        routeKey: "classification-primary",
      },
    ],
    workflow,
    { limit: 0.3, unit: "credits" },
    {
      guarantee: "hard",
      pricingVersion: "1.0.0",
      unit: "credits",
      upperBound: 0.3,
    },
    { maxAttemptsPerStep: 1 },
    hash("a")
  );

  assert.equal(result.ok, true);
});
