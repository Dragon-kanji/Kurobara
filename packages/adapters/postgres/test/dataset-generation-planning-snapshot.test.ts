import assert from "node:assert/strict";
import test from "node:test";

import {
  actorId,
  capabilityId,
  contentHash,
  instant,
  workspaceId,
} from "@kurobara/kernel";
import type {
  PlanningPersistencePort,
  PlanningSnapshotRepository,
} from "@kurobara/ports";

import { createPostgresDatasetGenerationPlanningSnapshotResolver } from "../src/dataset-generation-planning-snapshot.ts";

const WORKSPACE_ID = workspaceId("workspace-generation-snapshot");
const ACTOR_ID = actorId("actor-generation-snapshot");
const CAPABILITY = {
  capabilityId: capabilityId("organizations.discover"),
  capabilityVersion: "1.0.0",
};
const FACTS_HASH = contentHash(`sha256:${"a".repeat(64)}`);

const authority = {
  authorityEnvelopeId: "authority-generation-snapshot",
  budgetLimit: {
    limit: 10,
    reserved: 1,
    spent: 3,
    unit: "requests",
  },
  capabilities: [CAPABILITY],
  deadline: instant(5000),
  permissions: ["plans:quote", "steps:execute"],
  subjectActorId: ACTOR_ID,
  version: "1.0.0",
  workspaceId: WORKSPACE_ID,
} as const;

const snapshots = (
  options: Readonly<{ defaults?: boolean }> = {}
): PlanningSnapshotRepository => ({
  getAuthority: async () => authority,
  getDefaults: async () =>
    options.defaults === false
      ? undefined
      : {
          policySnapshotId: "policy-generation-snapshot",
          pricingSnapshotId: "pricing-generation-snapshot",
          workspaceId: WORKSPACE_ID,
        },
  getPolicy: async () => ({
    policy: {
      factsHash: FACTS_HASH,
      maxAttemptsPerStep: 1,
      requiredPermission: "plans:quote",
      version: "policy-v1",
    },
    snapshotId: "policy-generation-snapshot",
    workspaceId: WORKSPACE_ID,
  }),
  getPricing: async () => ({
    guarantee: "hard",
    snapshotId: "pricing-generation-snapshot",
    ttlMilliseconds: 1000,
    unit: "requests",
    upperBound: 2,
    version: "pricing-v1",
    workspaceId: WORKSPACE_ID,
  }),
  getWorkflow: async () => undefined,
});

const persistence = (
  snapshotRepository: PlanningSnapshotRepository
): PlanningPersistencePort => ({
  transaction: async (_scope, work) =>
    work({
      runPlans: {
        insert: async () => undefined,
      },
      snapshots: snapshotRepository,
    }),
});

const request = {
  actorId: ACTOR_ID,
  authorityEnvelopeId: authority.authorityEnvelopeId,
  capability: CAPABILITY,
  requestedBudget: { limit: 5, unit: "requests" },
  requestedDeadline: instant(4000),
  requestedUnknownCostPolicy: { mode: "deny" as const },
  workspaceId: WORKSPACE_ID,
};

test("resolves a conservative snapshot from durable defaults and exact admitted routes", async () => {
  const resolver = createPostgresDatasetGenerationPlanningSnapshotResolver({
    clock: { now: async () => instant(1000) },
    identifiers: { nextQuoteId: async () => "quote-generation-snapshot" },
    persistence: persistence(snapshots()),
    routes: {
      listAvailable: () => [
        {
          capability: CAPABILITY,
          effectAdapterKey: "hunter-discover",
          reservableUpperBound: 1,
          reservationUnit: "requests",
          routeKey: "hunter-discover",
        },
        {
          capability: {
            capabilityId: capabilityId("organizations.website.resolve"),
            capabilityVersion: "1.0.0",
          },
          effectAdapterKey: "exa-search",
          reservableUpperBound: 1,
          reservationUnit: "requests",
          routeKey: "exa-search",
        },
      ],
    },
  });

  const resolved = await resolver.resolve(request);

  assert.ok(resolved);
  assert.equal(resolved.budget.limit, 5);
  assert.equal(resolved.budget.spent, 0);
  assert.equal(resolved.deadline, 4000);
  assert.equal(resolved.quote.expiresAt, 2000);
  assert.equal(resolved.quote.upperBound, 2);
  assert.deepEqual(resolved.routeSnapshots, [
    {
      capability: CAPABILITY,
      effectAdapterKey: "hunter-discover",
      factsHash: FACTS_HASH,
      pricingVersion: "pricing-v1",
      reservableUpperBound: 1,
      reservationUnit: "requests",
      routeKey: "hunter-discover",
    },
  ]);
});

test("fails closed before persistence when no exact provider route is admitted", async () => {
  let transactionCalled = false;
  const resolver = createPostgresDatasetGenerationPlanningSnapshotResolver({
    clock: { now: async () => instant(1000) },
    identifiers: { nextQuoteId: async () => "not-used" },
    persistence: {
      transaction: () => {
        transactionCalled = true;
        return Promise.reject(new Error("not expected"));
      },
    },
    routes: { listAvailable: () => [] },
  });

  assert.equal(await resolver.resolve(request), undefined);
  assert.equal(transactionCalled, false);
});

test("fails closed when durable planning defaults are absent", async () => {
  let quoteAllocated = false;
  const resolver = createPostgresDatasetGenerationPlanningSnapshotResolver({
    clock: { now: async () => instant(1000) },
    identifiers: {
      nextQuoteId: () => {
        quoteAllocated = true;
        return Promise.resolve("not-used");
      },
    },
    persistence: persistence(snapshots({ defaults: false })),
    routes: {
      listAvailable: () => [
        {
          capability: CAPABILITY,
          effectAdapterKey: "hunter-discover",
          reservableUpperBound: 1,
          reservationUnit: "requests",
          routeKey: "hunter-discover",
        },
      ],
    },
  });

  assert.equal(await resolver.resolve(request), undefined);
  assert.equal(quoteAllocated, false);
});
