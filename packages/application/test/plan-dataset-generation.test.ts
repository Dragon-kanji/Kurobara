import assert from "node:assert/strict";
import test from "node:test";

import {
  actorId,
  type CapabilityRef,
  capabilityId,
  contentHash,
  type DatasetGenerationPlanId,
  type DatasetGenerationRouteSnapshot,
  datasetGenerationPlanId,
  datasetId,
  fieldId,
  type IdempotencyKey,
  idempotencyKey,
  instant,
  type WorkspaceId,
  workspaceId,
} from "@kurobara/kernel";
import type {
  DatasetGenerationPlanningPersistencePort,
  DatasetGenerationPlanningUnitOfWork,
  StoredDatasetGenerationPlan,
  WorkspaceScope,
} from "@kurobara/ports";

import { canonicalContentHash } from "../src/canonical-content-hash.ts";
import { makeGetDatasetGenerationPlan } from "../src/get-dataset-generation-plan.ts";
import {
  makePlanDatasetGeneration,
  type PlanDatasetGenerationDependencies,
  type PlanDatasetGenerationRequest,
} from "../src/plan-dataset-generation.ts";

const workspace = workspaceId("workspace-generation");
const capability = {
  capabilityId: capabilityId("organizations.discover"),
  capabilityVersion: "1.0.0",
} as const;
const now = instant(1_800_000_000_000);
const deadline = instant(now + 60_000);
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

const request = (
  overrides: Partial<PlanDatasetGenerationRequest> = {}
): PlanDatasetGenerationRequest => ({
  actorId: actorId("actor-generation"),
  authorityEnvelopeId: "authority-generation",
  capability,
  fields: [
    {
      datasetId: datasetId("dataset-companies"),
      fieldId: fieldId("field-company-name"),
      key: "company_name",
      label: "Company name",
      valueType: "string",
      workspaceId: workspace,
    },
  ],
  idempotencyKey: idempotencyKey("generation-create-1"),
  limits,
  query: { country: "es", industry: "software" },
  requestedBudget: { limit: 10, unit: "credits" },
  requestedDeadline: deadline,
  targetDataset: {
    datasetId: datasetId("dataset-companies"),
    name: "Synthetic companies",
    workspaceId: workspace,
  },
  unknownCostPolicy: { mode: "deny" },
  workspaceId: workspace,
  ...overrides,
});

class MemoryPlanningPersistence
  implements DatasetGenerationPlanningPersistencePort
{
  readonly records = new Map<string, StoredDatasetGenerationPlan>();
  insertCount = 0;
  transactionCount = 0;
  #tail: Promise<void> = Promise.resolve();

  #idempotencyKey(scope: WorkspaceScope, key: IdempotencyKey): string {
    return `${scope.workspaceId}\u0000${key}`;
  }

  findByIdempotencyKey(
    scope: WorkspaceScope,
    key: IdempotencyKey
  ): Promise<StoredDatasetGenerationPlan | undefined> {
    return Promise.resolve(this.records.get(this.#idempotencyKey(scope, key)));
  }

  get(
    scope: WorkspaceScope,
    planId: DatasetGenerationPlanId
  ): Promise<StoredDatasetGenerationPlan | undefined> {
    return Promise.resolve(
      [...this.records.values()].find(
        (record) =>
          record.plan.workspaceId === scope.workspaceId &&
          record.plan.generationPlanId === planId
      )
    );
  }

  async transaction<Value>(
    _scope: WorkspaceScope,
    work: (unitOfWork: DatasetGenerationPlanningUnitOfWork) => Promise<Value>
  ): Promise<Value> {
    this.transactionCount += 1;
    let release = (): void => undefined;
    const previous = this.#tail;
    this.#tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    const generationPlans = {
      findByIdempotencyKey: this.findByIdempotencyKey.bind(this),
      get: this.get.bind(this),
      insert: (
        scope: WorkspaceScope,
        record: StoredDatasetGenerationPlan
      ): Promise<void> => {
        const key = this.#idempotencyKey(scope, record.idempotencyKey);
        if (this.records.has(key)) {
          throw new Error("duplicate generation plan");
        }
        this.records.set(key, structuredClone(record));
        this.insertCount += 1;
        return Promise.resolve();
      },
      lockIdempotencyKey: (): Promise<void> => Promise.resolve(),
    };
    try {
      return await work({ generationPlans });
    } finally {
      release();
    }
  }
}

const dependencies = (
  options: Readonly<{
    capability?: CapabilityRef;
    normalizedQuery?: PlanDatasetGenerationRequest["query"];
    routeSnapshots?: readonly DatasetGenerationRouteSnapshot[];
  }> = {}
): Readonly<{
  calls: {
    clock: number;
    identifiers: number;
    normalizer: number;
    snapshots: number;
  };
  dependencies: PlanDatasetGenerationDependencies;
  persistence: MemoryPlanningPersistence;
}> => {
  const persistence = new MemoryPlanningPersistence();
  const resolvedCapability = options.capability ?? capability;
  const calls = { clock: 0, identifiers: 0, normalizer: 0, snapshots: 0 };
  const planIds = ["generation-plan-1", "generation-plan-2"];
  return {
    calls,
    dependencies: {
      clock: {
        now: () => {
          calls.clock += 1;
          return Promise.resolve(now);
        },
      },
      identifiers: {
        nextDatasetGenerationPlanId: () => {
          const value = planIds[calls.identifiers] ?? "generation-plan-extra";
          calls.identifiers += 1;
          return Promise.resolve(datasetGenerationPlanId(value));
        },
      },
      normalizer: {
        normalize: (input) => {
          calls.normalizer += 1;
          return {
            capability: input.capability,
            contract: {
              catalogFingerprint: contentHash(`sha256:${"a".repeat(64)}`),
              catalogVersion: "catalog-1",
              schemaFingerprint: contentHash(`sha256:${"b".repeat(64)}`),
              schemaId: "organizations.discover.query",
              schemaVersion: "1.0.0",
            },
            normalizerVersion: "normalizer-1",
            status: "accepted",
            value: options.normalizedQuery ?? {
              country: "ES",
              industry: "software",
            },
          };
        },
      },
      persistence,
      snapshots: {
        resolve: (input) => {
          calls.snapshots += 1;
          return Promise.resolve({
            authority: {
              authorityEnvelopeId: input.authorityEnvelopeId,
              budgetLimit: {
                limit: 10,
                reserved: 0,
                spent: 0,
                unit: "credits",
              },
              capabilities: [resolvedCapability],
              deadline,
              permissions: ["datasets:generate", "steps:execute"],
              subjectActorId: input.actorId,
              version: "1.0.0",
              workspaceId: input.workspaceId,
            },
            budget: {
              limit: 10,
              reserved: 0,
              spent: 0,
              unit: "credits",
            },
            deadline,
            policy: {
              factsHash: contentHash(`sha256:${"c".repeat(64)}`),
              requiredPermission: "datasets:generate",
              version: "policy-1",
            },
            quote: {
              expiresAt: instant(deadline + 60_000),
              guarantee: "hard",
              pricingVersion: "pricing-1",
              quoteId: "quote-1",
              unit: "credits",
              upperBound: 2,
            },
            routeSnapshots: options.routeSnapshots ?? [
              {
                capability: resolvedCapability,
                effectAdapterKey: "synthetic-organizations",
                factsHash: contentHash(`sha256:${"c".repeat(64)}`),
                pricingVersion: "pricing-1",
                reservableUpperBound: 2,
                reservationUnit: "credits",
                routeKey: "synthetic-primary",
              },
            ],
            unknownCostPolicy: input.requestedUnknownCostPolicy,
          });
        },
      },
    },
    persistence,
  };
};

test("persists a bounded immutable generation plan without provider effects", async () => {
  const fixture = dependencies();
  const result = await makePlanDatasetGeneration(fixture.dependencies)(
    request()
  );

  assert.equal(result.ok, true);
  if (!result.ok) {
    return;
  }
  assert.equal(result.value.replayed, false);
  assert.deepEqual(result.value.plan.normalizedQuery, {
    country: "ES",
    industry: "software",
  });
  assert.equal(result.value.plan.limits.maxCompanies, 10);
  assert.equal(result.value.plan.hardExecutionCap, 2);
  assert.equal(fixture.persistence.insertCount, 1);
  assert.deepEqual(fixture.calls, {
    clock: 1,
    identifiers: 1,
    normalizer: 1,
    snapshots: 1,
  });
  assert.equal(
    result.value.plan.queryHash,
    canonicalContentHash(result.value.plan.normalizedQuery)
  );
  const { planHash: _planHash, ...draft } = result.value.plan;
  assert.equal(result.value.plan.planHash, canonicalContentHash(draft));
  assert.notEqual(
    result.value.plan.planHash,
    result.value.plan.requestIntentHash
  );
});

test("binds selected-contact routes to the exact Apollo or Prospeo lineage namespace", async () => {
  const selectedCapability = {
    capabilityId: capabilityId("contacts.work-email.resolve"),
    capabilityVersion: "1.0.0",
  } as const;
  const route = (
    routeKey: string,
    effectAdapterKey: string,
    providerIdentityNamespace: string
  ): DatasetGenerationRouteSnapshot => ({
    capability: selectedCapability,
    effectAdapterKey,
    factsHash: contentHash(`sha256:${"c".repeat(64)}`),
    pricingVersion: "pricing-1",
    providerIdentityNamespace,
    reservableUpperBound: 1,
    reservationUnit: "credits",
    routeKey,
  });
  const routes = [
    route("apollo-primary", "apollo-people-enrichment", "apollo-people-search"),
    route(
      "prospeo-primary",
      "prospeo-email-enrichment",
      "prospeo-person-search"
    ),
    route(
      "prospeo-fallback",
      "hunter-email-finder-prospeo",
      "prospeo-person-search"
    ),
    route("apollo-fallback", "hunter-email-finder", "apollo-people-search"),
  ] as const;

  for (const [providerIdentityNamespace, expectedRouteKeys] of [
    ["apollo-people-search", ["apollo-primary", "apollo-fallback"]],
    ["prospeo-person-search", ["prospeo-primary", "prospeo-fallback"]],
  ] as const) {
    const selectedQuery = {
      selected_contacts: [
        {
          provider_identity: {
            provider_key: providerIdentityNamespace,
            provider_subject_id: "synthetic-provider-subject",
          },
        },
      ],
    } as const;
    const fixture = dependencies({
      capability: selectedCapability,
      normalizedQuery: selectedQuery,
      routeSnapshots: routes,
    });
    const result = await makePlanDatasetGeneration(fixture.dependencies)(
      request({
        capability: selectedCapability,
        providerIdentityNamespace,
        query: selectedQuery,
      })
    );

    assert.equal(result.ok, true);
    if (result.ok) {
      assert.deepEqual(
        result.value.plan.routeSnapshots.map((candidate) => candidate.routeKey),
        expectedRouteKeys
      );
      assert.equal(
        result.value.plan.routeSnapshots.every(
          (candidate) =>
            candidate.providerIdentityNamespace === providerIdentityNamespace
        ),
        true
      );
    }
  }
});

test("fails closed when a selected-contact namespace is absent or has no admitted route", async () => {
  const selectedCapability = {
    capabilityId: capabilityId("contacts.identity.reveal"),
    capabilityVersion: "1.0.0",
  } as const;
  const selectedQuery = {
    selected_contacts: [
      {
        provider_identity: {
          provider_key: "prospeo-person-search",
          provider_subject_id: "synthetic-provider-subject",
        },
      },
    ],
  } as const;
  const routeSnapshots = [
    {
      capability: selectedCapability,
      effectAdapterKey: "apollo-people-enrichment",
      factsHash: contentHash(`sha256:${"c".repeat(64)}`),
      pricingVersion: "pricing-1",
      providerIdentityNamespace: "apollo-people-search",
      reservableUpperBound: 1,
      reservationUnit: "credits",
      routeKey: "apollo-primary",
    },
  ] as const;
  const withoutNamespace = dependencies({
    capability: selectedCapability,
    normalizedQuery: selectedQuery,
    routeSnapshots,
  });
  const missing = await makePlanDatasetGeneration(
    withoutNamespace.dependencies
  )(
    request({
      capability: selectedCapability,
      query: selectedQuery,
    })
  );
  assert.equal(missing.ok, false);
  if (!missing.ok) {
    assert.equal(missing.error.code, "request-invalid");
  }

  const unavailable = dependencies({
    capability: selectedCapability,
    normalizedQuery: selectedQuery,
    routeSnapshots,
  });
  const result = await makePlanDatasetGeneration(unavailable.dependencies)(
    request({
      capability: selectedCapability,
      providerIdentityNamespace: "prospeo-person-search",
      query: selectedQuery,
    })
  );
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, "snapshot-unavailable");
  }
  assert.equal(unavailable.persistence.insertCount, 0);
});

test("replays the exact stored plan before resolving mutable planning facts", async () => {
  const fixture = dependencies();
  const plan = makePlanDatasetGeneration(fixture.dependencies);
  const first = await plan(request());
  assert.equal(first.ok, true);

  const second = await plan(request());
  assert.equal(second.ok, true);
  if (!(first.ok && second.ok)) {
    return;
  }
  assert.equal(second.value.replayed, true);
  assert.deepEqual(second.value.plan, first.value.plan);
  assert.deepEqual(fixture.calls, {
    clock: 1,
    identifiers: 1,
    normalizer: 1,
    snapshots: 1,
  });
});

test("rejects an idempotency collision before normalization or snapshots", async () => {
  const fixture = dependencies();
  const plan = makePlanDatasetGeneration(fixture.dependencies);
  assert.equal((await plan(request())).ok, true);

  const collision = await plan(
    request({ query: { country: "FR", industry: "software" } })
  );
  assert.equal(collision.ok, false);
  if (collision.ok) {
    return;
  }
  assert.equal(collision.error.code, "idempotency-key-reused");
  assert.deepEqual(fixture.calls, {
    clock: 1,
    identifiers: 1,
    normalizer: 1,
    snapshots: 1,
  });
});

test("rejects a hostile normalizer snapshot before hashing or resolving facts", async () => {
  const fixture = dependencies();
  let accessorCalls = 0;
  const hostile: Record<string, unknown> = {};
  Object.defineProperty(hostile, "country", {
    enumerable: true,
    get: () => {
      accessorCalls += 1;
      return "ES";
    },
  });
  const hostileDependencies: PlanDatasetGenerationDependencies = {
    ...fixture.dependencies,
    normalizer: {
      normalize: (input) => ({
        capability: input.capability,
        contract: {
          catalogFingerprint: contentHash(`sha256:${"a".repeat(64)}`),
          catalogVersion: "catalog-1",
          schemaFingerprint: contentHash(`sha256:${"b".repeat(64)}`),
          schemaId: "organizations.discover.query",
          schemaVersion: "1.0.0",
        },
        normalizerVersion: "normalizer-hostile",
        status: "accepted",
        value: hostile as PlanDatasetGenerationRequest["query"],
      }),
    },
  };

  const result = await makePlanDatasetGeneration(hostileDependencies)(
    request()
  );

  assert.equal(result.ok, false);
  if (result.ok) {
    return;
  }
  assert.equal(result.error.code, "query-rejected");
  assert.equal(accessorCalls, 0);
  assert.equal(fixture.calls.snapshots, 0);
  assert.equal(fixture.persistence.transactionCount, 0);
});

test("serializes concurrent creates and allocates one identity", async () => {
  const fixture = dependencies();
  const plan = makePlanDatasetGeneration(fixture.dependencies);
  const [left, right] = await Promise.all([plan(request()), plan(request())]);

  assert.equal(left.ok, true);
  assert.equal(right.ok, true);
  if (!(left.ok && right.ok)) {
    return;
  }
  assert.equal(fixture.persistence.insertCount, 1);
  assert.equal(fixture.calls.identifiers, 1);
  assert.deepEqual(left.value.plan, right.value.plan);
  assert.deepEqual([left.value.replayed, right.value.replayed].sort(), [
    false,
    true,
  ]);
});

test("fails closed when a required cardinality cap is absent", async () => {
  const fixture = dependencies();
  const { maxCalls: _maxCalls, ...missingLimit } = limits;
  const result = await makePlanDatasetGeneration(fixture.dependencies)(
    request({ limits: missingLimit })
  );

  assert.equal(result.ok, false);
  if (result.ok) {
    return;
  }
  assert.equal(result.error.code, "preflight-denied");
  assert.deepEqual(result.error.reasonCodes, ["limit-missing"]);
  assert.equal(fixture.persistence.insertCount, 0);
  assert.equal(fixture.calls.identifiers, 0);
});

test("rechecks the deadline under the idempotency lock before allocating an identity", async () => {
  const fixture = dependencies();
  const expiringDependencies: PlanDatasetGenerationDependencies = {
    ...fixture.dependencies,
    clock: {
      now: () => {
        fixture.calls.clock += 1;
        return Promise.resolve(deadline);
      },
    },
  };
  const result = await makePlanDatasetGeneration(expiringDependencies)(
    request()
  );

  assert.equal(result.ok, false);
  if (result.ok) {
    return;
  }
  assert.equal(result.error.code, "preflight-denied");
  assert.deepEqual(result.error.reasonCodes, ["deadline-elapsed"]);
  assert.equal(fixture.persistence.transactionCount, 1);
  assert.equal(fixture.persistence.insertCount, 0);
  assert.equal(fixture.calls.identifiers, 0);
});

test("rejects a planning snapshot that expands the requested budget", async () => {
  const fixture = dependencies();
  const originalResolve = fixture.dependencies.snapshots.resolve.bind(
    fixture.dependencies.snapshots
  );
  const expandedDependencies: PlanDatasetGenerationDependencies = {
    ...fixture.dependencies,
    snapshots: {
      resolve: async (input) => {
        const snapshot = await originalResolve(input);
        return snapshot === undefined
          ? undefined
          : {
              ...snapshot,
              budget: {
                ...snapshot.budget,
                limit: input.requestedBudget.limit + 1,
              },
            };
      },
    },
  };
  const result = await makePlanDatasetGeneration(expandedDependencies)(
    request()
  );

  assert.equal(result.ok, false);
  if (result.ok) {
    return;
  }
  assert.equal(result.error.code, "authority-invalid");
  assert.equal(fixture.persistence.transactionCount, 0);
  assert.equal(fixture.calls.identifiers, 0);
});

test("keeps plan lookup isolated by workspace", async () => {
  const fixture = dependencies();
  const created = await makePlanDatasetGeneration(fixture.dependencies)(
    request()
  );
  assert.equal(created.ok, true);
  if (!created.ok) {
    return;
  }
  const otherWorkspace = workspaceId("workspace-other") as WorkspaceId;
  assert.equal(
    await fixture.persistence.get(
      { workspaceId: otherWorkspace },
      created.value.plan.generationPlanId
    ),
    undefined
  );
  const found = await makeGetDatasetGenerationPlan(fixture.persistence)({
    generationPlanId: created.value.plan.generationPlanId,
    workspaceId: workspace,
  });
  assert.equal(found.ok, true);
  const missing = await makeGetDatasetGenerationPlan(fixture.persistence)({
    generationPlanId: created.value.plan.generationPlanId,
    workspaceId: otherWorkspace,
  });
  assert.equal(missing.ok, false);
  if (!missing.ok) {
    assert.equal(missing.error.code, "generation-plan-not-found");
  }
});
