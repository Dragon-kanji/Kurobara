import assert from "node:assert/strict";
import test from "node:test";

import {
  actorId,
  capabilityId,
  contentHash,
  correlationId,
  type DatasetGenerationCreation,
  datasetGenerationId,
  datasetGenerationPlanId,
  datasetId,
  datasetMaterializationId,
  fail,
  fieldId,
  idempotencyKey,
  instant,
  succeed,
  workspaceId,
} from "@kurobara/kernel";

import {
  authorizePrivacySafeContactDiscovery,
  type DiscoverContactsDependencies,
  type DiscoverContactsRequest,
  makeDiscoverContacts,
} from "../src/discover-contacts.ts";
import type { LoadReadyCompanyCandidatesResult } from "../src/load-ready-company-candidates.ts";
import type { PlanDatasetGenerationRequest } from "../src/plan-dataset-generation.ts";

const workspace = workspaceId("workspace-contact-discovery");
const organizationGenerationIdentity = datasetGenerationId(
  "organization-generation-contact-discovery"
);
const organizationDatasetIdentity = datasetId(
  "organization-dataset-contact-discovery"
);
const organizationMaterializationIdentity = datasetMaterializationId(
  "organization-materialization-contact-discovery"
);
const hash = contentHash(`sha256:${"c".repeat(64)}`);
const now = instant(1_900_000_000_000);

const parentCreation: DatasetGenerationCreation = {
  generation: {
    aggregateVersion: 3,
    capability: {
      capabilityId: capabilityId("organizations.discover"),
      capabilityVersion: "1.0.0",
    },
    cost: { reserved: 0, spent: 1, unit: "requests" },
    counters: {
      accepted: 2,
      calls: 1,
      duplicates: 0,
      pages: 1,
      rejected: 0,
      returned: 2,
    },
    createdAt: instant(now - 1000),
    datasetId: organizationDatasetIdentity,
    generationId: organizationGenerationIdentity,
    generationPlanId: datasetGenerationPlanId(
      "organization-plan-contact-discovery"
    ),
    lastPageSequence: 1,
    lockedProvider: "private-organization-provider",
    materializationId: organizationMaterializationIdentity,
    planHash: hash,
    queryHash: hash,
    requestIntentHash: hash,
    schemaHash: hash,
    state: "completed",
    workspaceId: workspace,
  },
  materialization: {
    completedAt: now,
    completionReason: "source-completed",
    contentHash: hash,
    coverage: {
      basis: "locked_provider_route",
      status: "complete_for_declared_source",
    },
    createdAt: instant(now - 1000),
    datasetId: organizationDatasetIdentity,
    materializationId: organizationMaterializationIdentity,
    origin: {
      generationId: organizationGenerationIdentity,
      kind: "generation",
    },
    recordCount: 2,
    rejectedCount: 0,
    revision: 1,
    schemaHash: hash,
    state: "ready",
    workspaceId: workspace,
  },
};

const parentResult = (count = 2): LoadReadyCompanyCandidatesResult =>
  succeed({
    generation: parentCreation.generation,
    items: [
      {
        candidate: {
          companyId: "company-1",
          countryCode: "ES",
          domain: "one.example",
          employeeCount: 10,
          industryCode: "software",
          name: "Company One",
          observedAtMs: now,
        },
        ordinal: 1,
      },
      {
        candidate: {
          companyId: "company-2",
          countryCode: "FR",
          domain: null,
          employeeCount: null,
          industryCode: null,
          name: "Company Two",
          observedAtMs: now,
        },
        ordinal: 2,
      },
    ].slice(0, count),
    materialization: {
      ...parentCreation.materialization,
      recordCount: count,
    },
    page: {
      afterOrdinal: 0,
      hasMore: false,
      limit: 2,
      nextAfterOrdinal: null,
    },
  });

const request = (): DiscoverContactsRequest => {
  const capability = {
    capabilityId: capabilityId("contacts.discover"),
    capabilityVersion: "1.0.0",
  } as const;
  const targetDataset = {
    datasetId: datasetId("contact-dataset-discovery"),
    name: "Contact shortlist",
    workspaceId: workspace,
  };
  return {
    execution: {
      actorId: actorId("actor-contact-discovery"),
      actorPermissions: [
        "contacts:discover",
        "datasets:generate",
        "steps:execute",
      ],
      authenticationMode: "api-key",
      correlationId: correlationId("correlation-contact-discovery"),
      workspaceId: workspace,
    },
    mode: "dry_run",
    organizationGenerationId: organizationGenerationIdentity,
    planning: {
      actorId: actorId("actor-contact-discovery"),
      authorityEnvelopeId: "authority-contact-discovery",
      capability,
      fields: [
        {
          datasetId: targetDataset.datasetId,
          fieldId: fieldId("contact-display-name"),
          key: "display_name",
          label: "Display name",
          valueType: "string",
          workspaceId: workspace,
        },
      ],
      idempotencyKey: idempotencyKey("contact-discovery-plan"),
      limits: {
        maxCalls: 2,
        maxCompanies: 2,
        maxContactsPerCompany: 2,
        maxContactsTotal: 4,
        maxEnrichments: 0,
        maxPages: 2,
        maxPhones: 0,
        maxResults: 4,
      },
      query: {
        company_headquarters_country_codes: ["ES", "FR"],
        departments: ["sales"],
        organization_generation_id: organizationGenerationIdentity,
        person_country_codes: [],
        result_kind: "contact",
        seniorities: ["director"],
        titles: [],
      },
      requestedBudget: { limit: 2, unit: "credits" },
      requestedDeadline: instant(now + 60_000),
      targetDataset,
      unknownCostPolicy: { mode: "deny" },
      workspaceId: workspace,
    },
  };
};

const effectiveRequest = (): DiscoverContactsRequest => {
  const base = request();
  return {
    ...base,
    planning: {
      ...base.planning,
      query: {
        ...(base.planning.query as Readonly<Record<string, unknown>>),
        organizations: [
          {
            company_id: "company-1",
            country_code: "ES",
            domain: "one.example",
            name: "Company One",
          },
          {
            company_id: "company-2",
            country_code: "FR",
            domain: null,
            name: "Company Two",
          },
        ],
      },
    },
  } as DiscoverContactsRequest;
};

const makeDependencies = (
  overrides: Partial<DiscoverContactsDependencies> = {}
): DiscoverContactsDependencies => ({
  authorizePage: () => Promise.reject(new Error("not used in dry-run")),
  authorizePrivacy: () => Promise.resolve(succeed({ allowed: true as const })),
  createGeneration: () => Promise.reject(new Error("not used in dry-run")),
  loadOrganizations: () => Promise.resolve(parentResult()),
  planGeneration: () =>
    Promise.resolve(
      fail({
        code: "snapshot-unavailable" as const,
        message: "Synthetic stop after observing the planning request.",
      })
    ),
  ...overrides,
});

test("loads the bounded parent page and plans with an exact detached snapshot", async () => {
  let loadedRequest:
    | Parameters<DiscoverContactsDependencies["loadOrganizations"]>[0]
    | null = null;
  const plannedRequests: PlanDatasetGenerationRequest[] = [];
  const original = request();
  const originalQuery = structuredClone(original.planning.query);
  const result = await makeDiscoverContacts(
    makeDependencies({
      loadOrganizations: (input) => {
        loadedRequest = structuredClone(input);
        return Promise.resolve(parentResult());
      },
      planGeneration: (input) => {
        plannedRequests.push(structuredClone(input));
        return Promise.resolve(
          fail({
            code: "snapshot-unavailable" as const,
            message: "Synthetic stop after observing the planning request.",
          })
        );
      },
    })
  )(original);

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.stage, "planning");
  }
  assert.deepEqual(loadedRequest, {
    afterOrdinal: 0,
    generationId: organizationGenerationIdentity,
    limit: 2,
    workspaceId: workspace,
  });
  assert.deepEqual(original.planning.query, originalQuery);
  const plannedRequest = plannedRequests[0];
  assert.ok(plannedRequest !== undefined);
  const plannedQuery = plannedRequest.query as Readonly<{
    organization_generation_id: string;
    organizations: readonly unknown[];
  }>;
  assert.equal(
    plannedQuery.organization_generation_id,
    organizationGenerationIdentity
  );
  assert.deepEqual(plannedQuery.organizations, [
    {
      company_id: "company-1",
      country_code: "ES",
      domain: "one.example",
      name: "Company One",
    },
    {
      company_id: "company-2",
      country_code: "FR",
      domain: null,
      name: "Company Two",
    },
  ]);
});

test("masks unavailable parent generations before privacy and planning", async () => {
  for (const code of [
    "dataset-generation-not-found",
    "dataset-generation-not-ready",
    "dataset-schema-invalid",
  ] as const) {
    let privacyCalls = 0;
    let planCalls = 0;
    const result = await makeDiscoverContacts(
      makeDependencies({
        authorizePrivacy: () => {
          privacyCalls += 1;
          return Promise.resolve(succeed({ allowed: true as const }));
        },
        loadOrganizations: () =>
          Promise.resolve(
            fail({ code, message: "Private parent diagnostic." })
          ),
        planGeneration: () => {
          planCalls += 1;
          return Promise.resolve(
            fail({
              code: "snapshot-unavailable" as const,
              message: "must not run",
            })
          );
        },
      })
    )(request());

    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error.code, "organization-generation-unavailable");
      assert.equal(result.error.stage, "parent");
      assert.equal(result.error.message.includes("Private"), false);
    }
    assert.equal(privacyCalls, 0);
    assert.equal(planCalls, 0);
  }
});

test("default OSS privacy admission requires explicit contact discovery authority", async () => {
  const admitted = await authorizePrivacySafeContactDiscovery(
    effectiveRequest()
  );
  assert.equal(admitted.ok, true);

  const deniedRequest = effectiveRequest();
  const denied = await authorizePrivacySafeContactDiscovery({
    ...deniedRequest,
    execution: {
      ...deniedRequest.execution,
      actorPermissions: ["datasets:generate", "steps:execute"],
    },
  });
  assert.equal(denied.ok, false);
  if (!denied.ok) {
    assert.equal(denied.error.code, "authority-permission-missing");
  }
});

test("default OSS privacy admission accepts only a bounded server snapshot", async () => {
  const malformed = effectiveRequest();
  const oversized = effectiveRequest();
  const malformedQuery = malformed.planning.query as Readonly<
    Record<string, unknown>
  >;
  const oversizedQuery = oversized.planning.query as Readonly<
    Record<string, unknown>
  >;
  for (const candidate of [
    {
      ...malformed,
      planning: {
        ...malformed.planning,
        query: {
          ...malformedQuery,
          organizations: [{ company_id: "incomplete" }],
        },
      },
    },
    {
      ...oversized,
      planning: {
        ...oversized.planning,
        query: {
          ...oversizedQuery,
          organizations: [
            ...(oversizedQuery.organizations as readonly unknown[]),
            {
              company_id: "company-3",
              country_code: "DE",
              domain: "three.example",
              name: "Company Three",
            },
          ],
        },
      },
    },
  ] as DiscoverContactsRequest[]) {
    const result = await authorizePrivacySafeContactDiscovery(candidate);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error.code, "contact-request-invalid");
    }
  }
});

test("real OSS privacy admission reaches planning after the server snapshot", async () => {
  let planCalls = 0;
  const result = await makeDiscoverContacts(
    makeDependencies({
      authorizePrivacy: authorizePrivacySafeContactDiscovery,
      planGeneration: () => {
        planCalls += 1;
        return Promise.resolve(
          fail({
            code: "snapshot-unavailable" as const,
            message: "Synthetic stop after proving privacy admission.",
          })
        );
      },
    })
  )(request());

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.stage, "planning");
  }
  assert.equal(planCalls, 1);
});

test("rejects empty parents and caller-supplied organization snapshots", async () => {
  let planCalls = 0;
  const empty = await makeDiscoverContacts(
    makeDependencies({
      loadOrganizations: () => Promise.resolve(parentResult(0)),
      planGeneration: () => {
        planCalls += 1;
        return Promise.resolve(
          fail({
            code: "snapshot-unavailable" as const,
            message: "must not run",
          })
        );
      },
    })
  )(request());
  assert.equal(empty.ok, false);
  if (!empty.ok) {
    assert.equal(empty.error.code, "organization-generation-empty");
    assert.equal(empty.error.stage, "parent");
  }

  let loadCalls = 0;
  const supplied = request();
  const callerSnapshot = {
    ...supplied,
    planning: {
      ...supplied.planning,
      query: {
        ...(supplied.planning.query as Readonly<Record<string, unknown>>),
        organizations: [{ company_id: "caller-controlled" }],
      },
    },
  } as DiscoverContactsRequest;
  const rejected = await makeDiscoverContacts(
    makeDependencies({
      loadOrganizations: () => {
        loadCalls += 1;
        return Promise.resolve(parentResult());
      },
    })
  )(callerSnapshot);
  assert.equal(rejected.ok, false);
  if (!rejected.ok) {
    assert.equal(rejected.error.code, "contact-request-invalid");
    assert.equal(rejected.error.stage, "planning");
  }
  assert.equal(loadCalls, 0);
  assert.equal(planCalls, 0);
});
