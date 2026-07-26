import assert from "node:assert/strict";
import test from "node:test";

import {
  capabilityId,
  type DatasetGenerationQueryValue,
  workspaceId,
} from "@kurobara/kernel";

import {
  createCompanyDiscoveryQueryNormalizer,
  createContactDiscoveryQueryNormalizer,
  createDatasetGenerationQueryNormalizerRouter,
  createRandomDatasetGenerationIdentifiers,
  createRandomIdentifiers,
  createRandomPlanningIdentifiers,
  createStaticCapabilityCatalog,
  createStaticCapabilityRouteCatalog,
  createStaticExecutionCatalog,
  createSystemClock,
} from "../src/index.ts";

const EVENT_ID_PATTERN = /^evt_[0-9a-f-]+$/u;
const GENERATION_ID_PATTERN = /^generation_[0-9a-f-]+$/u;
const GENERATION_PLAN_ID_PATTERN = /^generation_plan_[0-9a-f-]+$/u;
const OUTBOX_ID_PATTERN = /^out_[0-9a-f-]+$/u;
const PLAN_ID_PATTERN = /^plan_[0-9a-f-]+$/u;
const QUOTE_ID_PATTERN = /^quote_[0-9a-f-]+$/u;
const RUN_ID_PATTERN = /^run_[0-9a-f-]+$/u;
const UNIQUE_ROUTE_PATTERN = /unique/u;
const QUERY_CONTRACT = Object.freeze({
  catalogFingerprint: `sha256:${"a".repeat(64)}`,
  catalogVersion: "test",
  schemaFingerprint: `sha256:${"b".repeat(64)}`,
  schemaId:
    "https://schemas.kurobara.invalid/schemas/organizations/discovery-query/1.0.0",
  schemaVersion: "1.0.0",
});
const CONTACT_QUERY_CONTRACT = Object.freeze({
  catalogFingerprint: `sha256:${"c".repeat(64)}`,
  catalogVersion: "test",
  schemaFingerprint: `sha256:${"d".repeat(64)}`,
  schemaId:
    "https://schemas.kurobara.invalid/schemas/contacts/discovery-execution-query/1.0.0",
  schemaVersion: "1.0.0",
});

test("provides a current wall clock through the clock port", async () => {
  const before = Date.now();
  const now = await createSystemClock().now();
  const after = Date.now();

  assert.equal(now >= before, true);
  assert.equal(now <= after, true);
});

test("creates distinct opaque identifiers for each durable identity", async () => {
  const identifiers = createRandomIdentifiers();
  const planningIdentifiers = createRandomPlanningIdentifiers();
  const generationIdentifiers = createRandomDatasetGenerationIdentifiers();
  const values = await Promise.all([
    identifiers.nextEventId(),
    identifiers.nextEventId(),
    identifiers.nextOutboxMessageId(),
    identifiers.nextRunId(),
    planningIdentifiers.nextRunPlanId(),
    planningIdentifiers.nextQuoteId(),
    generationIdentifiers.nextDatasetGenerationId(),
    generationIdentifiers.nextDatasetGenerationPlanId(),
  ]);

  assert.equal(new Set(values).size, values.length);
  assert.match(values[0] ?? "", EVENT_ID_PATTERN);
  assert.match(values[2] ?? "", OUTBOX_ID_PATTERN);
  assert.match(values[3] ?? "", RUN_ID_PATTERN);
  assert.match(values[4] ?? "", PLAN_ID_PATTERN);
  assert.match(values[5] ?? "", QUOTE_ID_PATTERN);
  assert.match(values[6] ?? "", GENERATION_ID_PATTERN);
  assert.match(values[7] ?? "", GENERATION_PLAN_ID_PATTERN);
});

test("normalizes only exact company discovery queries supported by the admitted mapping", () => {
  const normalizer = createCompanyDiscoveryQueryNormalizer({
    contract: QUERY_CONTRACT,
  });
  const accepted = normalizer.normalize({
    capability: {
      capabilityId: capabilityId("organizations.discover"),
      capabilityVersion: "1.0.0",
    },
    query: {
      country_codes: ["FR"],
      country_scope: "headquarters",
      employee_count: { maximum: 200, minimum: 11 },
      industry_codes: ["software", "gaming"],
      industry_taxonomy: "kurobara-v1",
      keywords: ["platform", "game"],
      result_kind: "company",
    },
  });

  assert.equal(accepted.status, "accepted");
  if (accepted.status === "accepted") {
    assert.equal(
      accepted.contract.schemaId,
      "https://schemas.kurobara.invalid/schemas/organizations/discovery-query/1.0.0"
    );
    assert.deepEqual(accepted.value, {
      country_codes: ["FR"],
      country_scope: "headquarters",
      employee_count: { maximum: 200, minimum: 11 },
      industry_codes: ["gaming", "software"],
      industry_taxonomy: "kurobara-v1",
      keywords: ["game", "platform"],
      result_kind: "company",
    });
  }

  const rejectedQueries: readonly DatasetGenerationQueryValue[] = [
    {
      country_codes: ["ZZ"],
      country_scope: "headquarters",
      industry_codes: ["software"],
      industry_taxonomy: "kurobara-v1",
      result_kind: "company",
    },
    {
      country_codes: ["FR", "ES"],
      country_scope: "headquarters",
      industry_codes: ["software"],
      industry_taxonomy: "kurobara-v1",
      result_kind: "company",
    },
    {
      country_codes: ["FR"],
      country_scope: "headquarters",
      industry_codes: ["unmapped"],
      industry_taxonomy: "kurobara-v1",
      result_kind: "company",
    },
    {
      country_codes: ["FR"],
      country_scope: "headquarters",
      employee_count: { maximum: 199, minimum: 11 },
      industry_codes: ["software"],
      industry_taxonomy: "kurobara-v1",
      result_kind: "company",
    },
    {
      country_codes: ["FR"],
      country_scope: "headquarters",
      industry_codes: ["software"],
      industry_taxonomy: "kurobara-v1",
      result_kind: "company",
      widened: true,
    },
  ];
  for (const query of rejectedQueries) {
    assert.equal(
      normalizer.normalize({
        capability: {
          capabilityId: capabilityId("organizations.discover"),
          capabilityVersion: "1.0.0",
        },
        query,
      }).status,
      "rejected"
    );
  }
});

test("normalizes an exact bounded contact execution query without contact details", () => {
  const normalizer = createContactDiscoveryQueryNormalizer({
    contract: CONTACT_QUERY_CONTRACT,
  });
  const accepted = normalizer.normalize({
    capability: {
      capabilityId: capabilityId("contacts.discover"),
      capabilityVersion: "1.0.0",
    },
    query: {
      company_headquarters_country_codes: ["ES"],
      departments: ["sales"],
      organization_generation_id: "generation-organizations",
      organizations: [
        {
          company_id: "company-1",
          country_code: "ES",
          domain: "example.com",
          name: "Example",
        },
        {
          company_id: "company-2",
          country_code: "FR",
          domain: null,
          name: "No domain",
        },
      ],
      person_country_codes: [],
      result_kind: "contact",
      seniorities: ["director"],
      titles: [],
    },
  });

  assert.equal(accepted.status, "accepted");
  if (accepted.status === "accepted") {
    assert.equal(accepted.normalizerVersion, "kurobara-v1-contact-1");
    assert.deepEqual(accepted.contract, CONTACT_QUERY_CONTRACT);
    assert.deepEqual(accepted.value, {
      company_headquarters_country_codes: ["ES"],
      departments: ["sales"],
      organization_generation_id: "generation-organizations",
      organizations: [
        {
          company_id: "company-1",
          country_code: "ES",
          domain: "example.com",
          name: "Example",
        },
        {
          company_id: "company-2",
          country_code: "FR",
          domain: null,
          name: "No domain",
        },
      ],
      person_country_codes: [],
      result_kind: "contact",
      seniorities: ["director"],
      titles: [],
    });
  }

  for (const query of [
    {
      company_headquarters_country_codes: ["ES"],
      departments: ["sales"],
      email: "blocked@example.com",
      organization_generation_id: "generation-organizations",
      organizations: [
        {
          company_id: "company-1",
          country_code: "ES",
          domain: "example.com",
          name: "Example",
        },
      ],
      person_country_codes: [],
      result_kind: "contact",
      seniorities: ["director"],
      titles: [],
    },
    {
      company_headquarters_country_codes: ["ES"],
      departments: ["sales"],
      organization_generation_id: "generation-organizations",
      organizations: [],
      person_country_codes: [],
      result_kind: "contact",
      seniorities: ["director"],
      titles: [],
    },
    {
      company_headquarters_country_codes: ["ES"],
      departments: ["sales"],
      organization_generation_id: "generation-organizations",
      organizations: [
        {
          company_id: "company-1",
          country_code: "ES",
          domain: "https://example.com",
          name: "Example",
        },
      ],
      person_country_codes: [],
      result_kind: "contact",
      seniorities: ["director"],
      titles: [],
    },
  ] as const) {
    assert.equal(
      normalizer.normalize({
        capability: {
          capabilityId: capabilityId("contacts.discover"),
          capabilityVersion: "1.0.0",
        },
        query: query as DatasetGenerationQueryValue,
      }).status,
      "rejected"
    );
  }
});

test("routes generation queries to exactly one capability normalizer", () => {
  const company = createCompanyDiscoveryQueryNormalizer({
    contract: QUERY_CONTRACT,
  });
  const contact = createContactDiscoveryQueryNormalizer({
    contract: CONTACT_QUERY_CONTRACT,
  });
  const router = createDatasetGenerationQueryNormalizerRouter([
    {
      capability: {
        capabilityId: capabilityId("organizations.discover"),
        capabilityVersion: "1.0.0",
      },
      normalizer: company,
    },
    {
      capability: {
        capabilityId: capabilityId("contacts.discover"),
        capabilityVersion: "1.0.0",
      },
      normalizer: contact,
    },
  ]);

  assert.equal(
    router.normalize({
      capability: {
        capabilityId: capabilityId("contacts.resolve"),
        capabilityVersion: "1.0.0",
      },
      query: {},
    }).status,
    "rejected"
  );
  assert.throws(
    () =>
      createDatasetGenerationQueryNormalizerRouter([
        {
          capability: {
            capabilityId: capabilityId("contacts.discover"),
            capabilityVersion: "1.0.0",
          },
          normalizer: contact,
        },
        {
          capability: {
            capabilityId: capabilityId("contacts.discover"),
            capabilityVersion: "1.0.0",
          },
          normalizer: contact,
        },
      ]),
    UNIQUE_ROUTE_PATTERN
  );
});

test("exposes an immutable snapshot of explicitly composed capabilities", async () => {
  const source = [
    {
      capabilityId: capabilityId("documents.summarize"),
      capabilityVersion: "1.0.0",
    },
  ];
  const catalog = createStaticCapabilityCatalog(source);
  source[0] = {
    capabilityId: capabilityId("documents.changed"),
    capabilityVersion: "2.0.0",
  };

  const available = await catalog.listAvailable({
    workspaceId: workspaceId("workspace-test"),
  });

  assert.deepEqual(available, [
    {
      capabilityId: capabilityId("documents.summarize"),
      capabilityVersion: "1.0.0",
    },
  ]);
  assert.equal(Object.isFrozen(available), true);
  assert.equal(Object.isFrozen(available[0]), true);
});

test("exposes an immutable ordered snapshot of admitted execution routes", () => {
  const source = [
    {
      capability: {
        capabilityId: capabilityId("documents.summarize"),
        capabilityVersion: "1.0.0",
      },
      effectAdapterKey: "provider-primary",
      reservableUpperBound: 1,
      reservationUnit: "credits",
      routeKey: "primary",
    },
  ];
  const catalog = createStaticCapabilityRouteCatalog(source);
  source[0] = {
    ...source[0],
    effectAdapterKey: "provider-changed",
  };

  const available = catalog.listAvailable({
    workspaceId: workspaceId("workspace-test"),
  });

  assert.deepEqual(available, [
    {
      capability: {
        capabilityId: capabilityId("documents.summarize"),
        capabilityVersion: "1.0.0",
      },
      effectAdapterKey: "provider-primary",
      reservableUpperBound: 1,
      reservationUnit: "credits",
      routeKey: "primary",
    },
  ]);
  assert.equal(Object.isFrozen(available), true);
  assert.equal(Object.isFrozen(available[0]), true);
  assert.equal(Object.isFrozen(available[0]?.capability), true);
});

test("derives advertised capabilities from the canonical route list", async () => {
  const execution = createStaticExecutionCatalog([
    {
      capability: {
        capabilityId: capabilityId("documents.summarize"),
        capabilityVersion: "1.0.0",
      },
      effectAdapterKey: "provider-primary",
      reservableUpperBound: 1,
      reservationUnit: "credits",
      routeKey: "primary",
    },
    {
      capability: {
        capabilityId: capabilityId("documents.summarize"),
        capabilityVersion: "1.0.0",
      },
      effectAdapterKey: "provider-fallback",
      reservableUpperBound: 1,
      reservationUnit: "credits",
      routeKey: "fallback",
    },
  ]);

  assert.deepEqual(
    await execution.capabilities.listAvailable({
      workspaceId: workspaceId("workspace-test"),
    }),
    [
      {
        capabilityId: capabilityId("documents.summarize"),
        capabilityVersion: "1.0.0",
      },
    ]
  );
  assert.equal(
    execution.routes.listAvailable({
      workspaceId: workspaceId("workspace-test"),
    }).length,
    2
  );
  assert.deepEqual(
    execution.routes
      .listAvailable({ workspaceId: workspaceId("workspace-test") })
      .map((route) => route.routeKey),
    ["primary", "fallback"]
  );
});
