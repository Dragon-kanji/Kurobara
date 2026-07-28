import assert from "node:assert/strict";
import test from "node:test";

import {
  type ContactCandidatesListResponse,
  type ContactDiscoverRequest,
  type ContactIdentityRevealRequest,
  type ContactWorkEmailRequest,
  createKurobaraClient,
  type DatasetImportMetadata,
  KurobaraConfigError,
  KurobaraProblemError,
  KurobaraTransportError,
  type OrganizationCandidatesListResponse,
  type OrganizationDiscoverRequest,
  parseContactPrivacyRestrictionRequest,
  type RecipeApplicationGetResponse,
  type RecipeApplyRequest,
  type RunCancelRequest,
  type RunCancelResponse,
} from "../src/index.ts";

const CONTACT_SENSITIVE_FIELD_PATTERN =
  /email|phone|provider_(?:candidate_)?id|provider_cursor/u;

const metadata: DatasetImportMetadata = {
  batch_limits: { max_bytes: 4096, max_items: 10 },
  dataset: {
    dataset_id: "dataset-client-test",
    name: "Synthetic client test",
    workspace_id: "workspace-client-test",
  },
  fields: [
    {
      dataset_id: "dataset-client-test",
      field_id: "company_name",
      key: "company_name",
      label: "Company name",
      value_type: "string",
      workspace_id: "workspace-client-test",
    },
  ],
  format: "csv",
  import_id: "import-client-test",
  max_record_bytes: 2048,
  source_content_hash: `sha256:${"a".repeat(64)}`,
};

const successBody = {
  batch_count: 1,
  dataset_id: "dataset-client-test",
  error_count: 0,
  import_id: "import-client-test",
  item_count: 1,
  record_count: 1,
  replayed: false,
  state: "completed",
  workspace_id: "workspace-client-test",
} as const;

const recipeRequest: RecipeApplyRequest = {
  aggregate_budget: { limit: 10, unit: "credits" },
  application_id: "application-client-test",
  authority_envelope_id: "authority-client-test",
  cell_budget: { limit: 5, unit: "credits" },
  deadline_ms: 20_000,
  max_cells: 10,
  recipe: {
    dataset_id: "dataset-client-test",
    input_field_ids: ["field-domain"],
    name: "Resolve official website",
    recipe_id: "recipe-client-test",
    recipe_revision: "1.0.0",
    target_field_id: "field-website",
    workflow_content_hash: `sha256:${"b".repeat(64)}`,
    workflow_revision: "1.0.0",
    workflow_spec_id: "workflow-client-test",
    workspace_id: "workspace-client-test",
  },
  record_ids: ["record-1", "record-2"],
};

const recipeSuccessBody = {
  active_cell_count: 0,
  application_id: "application-client-test",
  application_replayed: false,
  bound_cell_count: 0,
  cached_cell_count: 0,
  created_run_count: 2,
  dataset_id: "dataset-client-test",
  recipe_id: "recipe-client-test",
  recipe_replayed: false,
  recipe_revision: "1.0.0",
  total_cell_count: 2,
  workspace_id: "workspace-client-test",
} as const;

const runCancelRequest = {
  idempotency_key: "cancel-client-test",
  run_id: "run/client test",
} as const satisfies RunCancelRequest;

const runCancelResponse = {
  aggregate_version: 2,
  created_at_ms: 1_752_700_000_000,
  event_sequence: 3,
  replayed: false,
  result_completeness: "none",
  run_id: "run/client test",
  run_plan_id: "plan-client-test",
  state: "cancelled",
  workspace_id: "workspace-client-test",
} as const satisfies RunCancelResponse;

const recipeWatchBody = {
  application_id: "application/client test",
  bound_cell_count: 2,
  dataset_id: "dataset-client-test",
  failed_cell_count: 0,
  pending_cell_count: 1,
  recipe_id: "recipe-client-test",
  recipe_revision: "1.0.0",
  running_cell_count: 0,
  skipped_cell_count: 0,
  state: "running",
  succeeded_cell_count: 1,
  terminal: false,
  total_cell_count: 2,
  unbound_cell_count: 0,
  workspace_id: "workspace-client-test",
} as const satisfies RecipeApplicationGetResponse;

const organizationDiscoverRequest = {
  authority_envelope_id: "authority-client-test",
  budget: { limit: 10, unit: "credits" },
  dataset_id: "dataset-client-test",
  dataset_name: "Synthetic companies",
  deadline_ms: 1_752_700_060_000,
  discovery_id: "discovery-client-test",
  limits: { max_calls: 2, max_companies: 50, max_pages: 2 },
  mode: "start",
  query: {
    country_codes: ["FR"],
    country_scope: "headquarters",
    industry_codes: ["software"],
    industry_taxonomy: "kurobara-v1",
    result_kind: "company",
  },
} as const satisfies OrganizationDiscoverRequest;

const organizationDiscoverResponse = {
  dataset_id: "dataset-client-test",
  generation_id: "generation-client-test",
  generation_plan_id: "generation-plan-client-test",
  mode: "start",
  plan_hash: `sha256:${"c".repeat(64)}`,
  query_hash: `sha256:${"d".repeat(64)}`,
  quote: {
    expires_at_ms: 1_752_700_030_000,
    guarantee: "hard",
    unit: "credits",
    upper_bound: 8,
  },
  replayed: false,
  state: "building",
  workspace_id: "workspace-client-test",
} as const;

const organizationCandidatesListResponse = {
  dataset_id: "dataset-client-test",
  generation_id: "generation/client test",
  items: [
    {
      candidate: {
        company_id: "company-client-test",
        country_code: "FR",
        domain: "example.invalid",
        employee_count: null,
        industry_code: "software",
        name: "Synthetic Company",
        observed_at_ms: 1_752_700_001_000,
      },
      ordinal: 2,
    },
  ],
  page: {
    after_ordinal: 1,
    has_more: false,
    limit: 1,
    next_after_ordinal: null,
  },
  provenance: {
    capability_id: "organizations.discover",
    capability_version: "1.0.0",
    completed_at_ms: 1_752_700_002_000,
    completion_reason: "source-completed",
    coverage: {
      basis: "locked_provider_route",
      status: "complete_for_declared_source",
    },
    generation_plan_id: "generation-plan-client-test",
    materialization_content_hash: `sha256:${"e".repeat(64)}`,
    materialization_id: "materialization-client-test",
    materialization_revision: 1,
    plan_hash: `sha256:${"a".repeat(64)}`,
    query_hash: `sha256:${"b".repeat(64)}`,
    schema_hash: `sha256:${"c".repeat(64)}`,
  },
  record_count: 2,
  workspace_id: "workspace-client-test",
} as const satisfies OrganizationCandidatesListResponse;

const contactCandidatesListResponse = {
  ...organizationCandidatesListResponse,
  items: [
    {
      candidate: {
        contact_id: "contact-client-test",
        department: "sales",
        display_name: "Synthetic Contact",
        identity_completeness: "full",
        job_title: "Sales Director",
        observed_at_ms: 1_752_700_001_000,
        organization_domain: "example.invalid",
        organization_id: "company-client-test",
        organization_name: "Synthetic Company",
        person_country_code: "ES",
        profile_url: "https://social.example/synthetic-contact",
        seniority: "director",
      },
      ordinal: 2,
    },
  ],
  provenance: {
    ...organizationCandidatesListResponse.provenance,
    capability_id: "contacts.discover",
  },
} as const satisfies ContactCandidatesListResponse;

const contactDiscoverRequest = {
  authority_envelope_id: "authority-client-test",
  budget: { limit: 2, unit: "credits" },
  dataset_id: "contacts-client-test",
  dataset_name: "Synthetic contacts",
  deadline_ms: 1_752_700_060_000,
  discovery_id: "contact-discovery-client-test",
  limits: {
    max_calls: 2,
    max_companies: 3,
    max_contacts_per_company: 2,
    max_contacts_total: 6,
    max_pages: 2,
  },
  mode: "dry-run",
  organization_generation_id: "generation-client-test",
  query: {
    company_headquarters_country_codes: ["ES"],
    departments: ["sales"],
    person_country_codes: [],
    result_kind: "contact",
    seniorities: ["director"],
    titles: [],
  },
} as const satisfies ContactDiscoverRequest;

const contactDiscoverResponse = {
  dataset_id: "contacts-client-test",
  generation_plan_id: "contact-generation-plan-client-test",
  mode: "dry-run",
  organization_generation_id: "generation-client-test",
  organization_source: {
    generation_id: "generation-client-test",
    kind: "generation",
  },
  plan_hash: `sha256:${"e".repeat(64)}`,
  query_hash: `sha256:${"f".repeat(64)}`,
  quote: {
    expires_at_ms: 1_752_700_030_000,
    guarantee: "hard",
    unit: "credits",
    upper_bound: 2,
  },
  replayed: false,
  state: "planned",
  workspace_id: "workspace-client-test",
} as const;

const contactWorkEmailRequest = {
  authority_envelope_id: "authority-client-test",
  budget: { limit: 1, unit: "credits" },
  contact_dataset_id: "contacts-client-test",
  contact_record_ids: ["contact-1"],
  deadline_ms: 1_752_700_060_000,
  operation_id: "resolve-client-test",
} as const satisfies ContactWorkEmailRequest;

const contactIdentityRevealRequest = {
  ...contactWorkEmailRequest,
  contact_record_ids: ["contact-1", "contact-2"],
  operation_id: "identity-reveal-client-test",
} as const satisfies ContactIdentityRevealRequest;

const contactIdentityRevealResponse = {
  contact_dataset_id: "contacts-client-test",
  contact_record_ids: ["contact-1", "contact-2"],
  generation_id: "identity-generation-client-test",
  generation_plan_id: "identity-plan-client-test",
  operation_id: "identity-reveal-client-test",
  replayed: false,
  result_dataset_id: "identity-results-client-test",
  state: "building",
  workspace_id: "workspace-client-test",
} as const;

const datasetGenerationResponse = {
  cost: { reserved: 2, spent: 1, unit: "credits" },
  counters: {
    accepted: 25,
    calls: 1,
    duplicates: 0,
    pages: 1,
    rejected: 0,
    returned: 25,
  },
  dataset_id: "dataset-client-test",
  generation_id: "generation/client test",
  generation_plan_id: "generation-plan-client-test",
  materialization_id: "materialization-client-test",
  materialization_state: "building",
  record_count: 25,
  state: "running",
  terminal: false,
  workspace_id: "workspace-client-test",
} as const;

test("discovers organizations with the bounded canonical JSON contract", async () => {
  const client = createKurobaraClient({
    apiKey: "synthetic-api-key",
    baseUrl: "http://127.0.0.1:3000/base/",
    fetch: (input, init) => {
      assert.equal(
        String(input),
        "http://127.0.0.1:3000/base/v1/organization-discoveries"
      );
      assert.equal(init?.method, "POST");
      assert.deepEqual(
        JSON.parse(String(init?.body)),
        organizationDiscoverRequest
      );
      return Promise.resolve(Response.json(organizationDiscoverResponse));
    },
  });
  assert.deepEqual(
    await client.organizations.discover(organizationDiscoverRequest),
    organizationDiscoverResponse
  );
});

test("discovers contacts and plans selected work-email resolution", async () => {
  const client = createKurobaraClient({
    apiKey: "synthetic-api-key",
    baseUrl: "http://127.0.0.1:3000/base/",
    fetch: (input, init) => {
      const pathname = new URL(String(input)).pathname;
      if (pathname.endsWith("/contact-discoveries")) {
        assert.deepEqual(
          JSON.parse(String(init?.body)),
          contactDiscoverRequest
        );
        return Promise.resolve(Response.json(contactDiscoverResponse));
      }
      assert.equal(pathname.endsWith("/contact-work-email-resolutions"), true);
      assert.deepEqual(JSON.parse(String(init?.body)), contactWorkEmailRequest);
      return Promise.resolve(
        Response.json({
          contact_dataset_id: "contacts-client-test",
          contact_record_ids: ["contact-1"],
          generation_id: "work-email-generation-client-test",
          generation_plan_id: "work-email-plan-client-test",
          operation_id: "resolve-client-test",
          replayed: false,
          result_dataset_id: "work-email-results-client-test",
          state: "building",
          workspace_id: "workspace-client-test",
        })
      );
    },
  });
  assert.deepEqual(
    await client.contacts.discover(contactDiscoverRequest),
    contactDiscoverResponse
  );
  assert.equal(
    (await client.contacts.resolveWorkEmails(contactWorkEmailRequest))
      .operation_id,
    "resolve-client-test"
  );
});

test("reveals selected contact identities through the exact generated route", async () => {
  const controller = new AbortController();
  let calls = 0;
  const client = createKurobaraClient({
    apiKey: "synthetic-api-key",
    baseUrl: "http://127.0.0.1:3000/base/",
    fetch: (input, init) => {
      calls += 1;
      assert.equal(
        String(input),
        "http://127.0.0.1:3000/base/v1/contact-identity-reveals"
      );
      assert.equal(init?.method, "POST");
      assert.equal(init?.signal, controller.signal);
      assert.deepEqual(
        JSON.parse(String(init?.body)),
        contactIdentityRevealRequest
      );
      return Promise.resolve(Response.json(contactIdentityRevealResponse));
    },
  });

  assert.deepEqual(
    await client.contacts.revealIdentities(contactIdentityRevealRequest, {
      signal: controller.signal,
    }),
    contactIdentityRevealResponse
  );
  assert.equal(calls, 1);
});

test("validates identity selections and rejects mismatched receipts without retry", async () => {
  let inputCalls = 0;
  const inputClient = createKurobaraClient({
    apiKey: "synthetic-api-key",
    baseUrl: "http://127.0.0.1:3000",
    fetch: () => {
      inputCalls += 1;
      return Promise.resolve(Response.json(contactIdentityRevealResponse));
    },
  });
  for (const invalid of [
    { ...contactIdentityRevealRequest, contact_record_ids: [] },
    {
      ...contactIdentityRevealRequest,
      contact_record_ids: ["contact-1", "contact-1"],
    },
    {
      ...contactIdentityRevealRequest,
      contact_record_ids: ["contact-1", "contact-2", "contact-3", "contact-4"],
    },
    { ...contactIdentityRevealRequest, unexpected: true },
  ]) {
    await assert.rejects(
      inputClient.contacts.revealIdentities(invalid),
      (error: unknown) => {
        assert.ok(error instanceof KurobaraTransportError);
        assert.equal(error.kind, "invalid-input");
        assert.equal(
          error.message,
          "Contact identity reveal request is invalid."
        );
        return true;
      }
    );
  }
  assert.equal(inputCalls, 0);

  for (const mismatch of [
    { ...contactIdentityRevealResponse, operation_id: "another-operation" },
    { ...contactIdentityRevealResponse, contact_dataset_id: "another-dataset" },
    {
      ...contactIdentityRevealResponse,
      contact_record_ids: ["contact-2", "contact-1"],
    },
  ]) {
    let calls = 0;
    const client = createKurobaraClient({
      apiKey: "synthetic-api-key",
      baseUrl: "http://127.0.0.1:3000",
      fetch: () => {
        calls += 1;
        return Promise.resolve(Response.json(mismatch));
      },
    });
    await assert.rejects(
      client.contacts.revealIdentities(contactIdentityRevealRequest),
      (error: unknown) => {
        assert.ok(error instanceof KurobaraTransportError);
        assert.equal(error.kind, "invalid-response");
        assert.equal(
          error.message,
          "The Kurobara API returned a mismatched contact identity reveal response."
        );
        return true;
      }
    );
    assert.equal(calls, 1);
  }
});

test("projects only canonical identity reveal problems", async () => {
  const canonicalProblem = {
    code: "idempotency-key-reused",
    retryable: false,
    status: 409,
    title: "Idempotency key reused",
    type: "https://problems.kurobara.invalid/idempotency-key-reused",
  } as const;
  const foreignProblem = {
    code: "dataset-generation-not-found",
    retryable: false,
    status: 404,
    title: "Dataset generation not found",
    type: "https://problems.kurobara.invalid/dataset-generation-not-found",
  } as const;

  for (const [problem, expectedKind] of [
    [canonicalProblem, "problem"],
    [foreignProblem, "invalid-response"],
  ] as const) {
    let calls = 0;
    const client = createKurobaraClient({
      apiKey: "synthetic-api-key",
      baseUrl: "http://127.0.0.1:3000",
      fetch: () => {
        calls += 1;
        return Promise.resolve(
          Response.json(problem, {
            headers: { "content-type": "application/problem+json" },
            status: problem.status,
          })
        );
      },
    });
    await assert.rejects(
      client.contacts.revealIdentities(contactIdentityRevealRequest),
      (error: unknown) => {
        if (expectedKind === "problem") {
          assert.ok(error instanceof KurobaraProblemError);
          assert.deepEqual(error.problem, canonicalProblem);
        } else {
          assert.ok(error instanceof KurobaraTransportError);
          assert.equal(error.kind, expectedKind);
        }
        return true;
      }
    );
    assert.equal(calls, 1);
  }
});

test("reads a URL-encoded dataset generation identity", async () => {
  const client = createKurobaraClient({
    apiKey: "synthetic-api-key",
    baseUrl: "http://127.0.0.1:3000/base/",
    fetch: (input, init) => {
      assert.equal(
        String(input),
        "http://127.0.0.1:3000/base/v1/dataset-generations/generation%2Fclient%20test"
      );
      assert.equal(init?.method, "GET");
      return Promise.resolve(Response.json(datasetGenerationResponse));
    },
  });
  assert.deepEqual(
    await client.datasetGenerations.get({
      generation_id: "generation/client test",
    }),
    datasetGenerationResponse
  );
});

test("lists one bounded company-candidate page with exact keyset query", async () => {
  const client = createKurobaraClient({
    apiKey: "synthetic-api-key",
    baseUrl: "http://127.0.0.1:3000/base/",
    fetch: (input, init) => {
      assert.equal(
        String(input),
        "http://127.0.0.1:3000/base/v1/dataset-generations/generation%2Fclient%20test/company-candidates?limit=1&after_ordinal=1"
      );
      assert.equal(init?.method, "GET");
      return Promise.resolve(Response.json(organizationCandidatesListResponse));
    },
  });

  assert.deepEqual(
    await client.organizations.listCandidates({
      after_ordinal: 1,
      generation_id: "generation/client test",
      limit: 1,
    }),
    organizationCandidatesListResponse
  );
});

test("lists one bounded privacy-safe contact-candidate page", async () => {
  const client = createKurobaraClient({
    apiKey: "synthetic-api-key",
    baseUrl: "http://127.0.0.1:3000/base/",
    fetch: (input, init) => {
      assert.equal(
        String(input),
        "http://127.0.0.1:3000/base/v1/dataset-generations/generation%2Fclient%20test/contact-candidates?limit=1&after_ordinal=1"
      );
      assert.equal(init?.method, "GET");
      return Promise.resolve(Response.json(contactCandidatesListResponse));
    },
  });
  const result = await client.contacts.listCandidates({
    after_ordinal: 1,
    generation_id: "generation/client test",
    limit: 1,
  });
  assert.deepEqual(result, contactCandidatesListResponse);
  assert.doesNotMatch(JSON.stringify(result), CONTACT_SENSITIVE_FIELD_PATTERN);
});

test("rejects invalid company-candidate input and response cursor drift", async () => {
  let calls = 0;
  const client = createKurobaraClient({
    apiKey: "synthetic-api-key",
    baseUrl: "http://127.0.0.1:3000/base/",
    fetch: () => {
      calls += 1;
      return Promise.resolve(
        Response.json({
          ...organizationCandidatesListResponse,
          page: {
            ...organizationCandidatesListResponse.page,
            after_ordinal: 0,
          },
        })
      );
    },
  });

  await assert.rejects(
    client.organizations.listCandidates({
      generation_id: "generation/client test",
      limit: 0,
    }),
    (error: unknown) => {
      assert.ok(error instanceof KurobaraTransportError);
      assert.equal(error.kind, "invalid-input");
      return true;
    }
  );
  assert.equal(calls, 0);

  await assert.rejects(
    client.organizations.listCandidates({
      after_ordinal: 1,
      generation_id: "generation/client test",
      limit: 1,
    }),
    (error: unknown) => {
      assert.ok(error instanceof KurobaraTransportError);
      assert.equal(error.kind, "invalid-response");
      return true;
    }
  );
  assert.equal(calls, 1);
});

test("rejects internally inconsistent company-candidate pages", async () => {
  const invalidResponses = [
    {
      ...organizationCandidatesListResponse,
      record_count: 1,
    },
    {
      ...organizationCandidatesListResponse,
      provenance: {
        ...organizationCandidatesListResponse.provenance,
        completion_reason: "caps-reached",
      },
    },
    {
      ...organizationCandidatesListResponse,
      items: [
        {
          ...organizationCandidatesListResponse.items[0],
          ordinal: 1,
        },
      ],
    },
  ] as const;

  for (const response of invalidResponses) {
    const client = createKurobaraClient({
      apiKey: "synthetic-api-key",
      baseUrl: "http://127.0.0.1:3000/base/",
      fetch: () => Promise.resolve(Response.json(response)),
    });
    await assert.rejects(
      client.organizations.listCandidates({
        after_ordinal: 1,
        generation_id: "generation/client test",
        limit: 1,
      }),
      (error: unknown) => {
        assert.ok(error instanceof KurobaraTransportError);
        assert.equal(error.kind, "invalid-response");
        return true;
      }
    );
  }
});

test("cancels one URL-encoded dataset generation without retry", async () => {
  let calls = 0;
  const response = {
    ...datasetGenerationResponse,
    cost: { reserved: 0, spent: 1, unit: "credits" },
    materialization_state: "cancelled",
    replayed: false,
    state: "cancelled",
    stop_reason: "requested",
    stop_requested_at_ms: 1_752_700_001_000,
    terminal: true,
  } as const;
  const client = createKurobaraClient({
    apiKey: "synthetic-api-key",
    baseUrl: "http://127.0.0.1:3000/base/",
    fetch: (input, init) => {
      calls += 1;
      assert.equal(
        String(input),
        "http://127.0.0.1:3000/base/v1/dataset-generations/generation%2Fclient%20test/cancel"
      );
      assert.equal(init?.method, "POST");
      assert.deepEqual(JSON.parse(String(init?.body)), {
        idempotency_key: "cancel-client-test",
      });
      return Promise.resolve(Response.json(response));
    },
  });
  assert.deepEqual(
    await client.datasetGenerations.cancel({
      generation_id: "generation/client test",
      idempotency_key: "cancel-client-test",
    }),
    response
  );
  assert.equal(calls, 1);
});

const IMPORT_ID_PATTERN = /"import_id":"import-client-test"/u;
const SOURCE_HEADER_PATTERN = /record_id,company_name/u;

const source = async function* (): AsyncGenerator<Uint8Array> {
  await Promise.resolve();
  yield new TextEncoder().encode("record_id,company_name\nrecord-1,Example\n");
};

const exportRequest = {
  application_id: "application-client-test",
  field_ids: ["field-domain", "field-website"],
  format: "jsonl",
} as const;

const datasetExportRequest = {
  dataset_id: "dataset-client-test",
  field_ids: ["field-name", "field-domain"],
  format: "csv",
} as const;

const exportDeliveryBase = {
  content_hash: `sha256:${"a".repeat(64)}`,
  content_length: 3,
  dataset_id: "dataset-client-test",
  delivery_id: "delivery/client test",
  expires_at_ms: 1_752_786_400_000,
  format: "csv",
  prepared_at_ms: 1_752_700_000_000,
} as const;

const exportDeliveryState = {
  ...exportDeliveryBase,
  delivered_at_ms: 1_752_700_001_000,
  state: "delivered",
} as const;

const exportDeliveryRevocation = {
  ...exportDeliveryState,
  revoked_at_ms: 1_752_700_002_000,
  state: "revoked",
} as const;

const contactPrivacyRestrictionRequest = {
  idempotency_key: "privacy-client-test",
  reason: "operator-subject-request",
  subject: {
    kind: "email",
    value: "privacy-subject@example.invalid",
  },
} as const;

const contactPrivacyRestrictionResponse = {
  affected_delivery_count: 2,
  newly_revoked_delivery_count: 1,
  reason: "operator-subject-request",
  registered_at_ms: 1_752_700_000_000,
  replayed: false,
  tombstone_id: "privacy-ts-client-test",
} as const;

test("accepts the exact public contact privacy subject grammar", () => {
  for (const subject of [
    { kind: "email", value: "privacy-subject@localhost" },
    {
      kind: "provider-subject",
      provider_key: "provider.v1_subject-key",
      value: "provider-subject-synthetic-grammar",
    },
    {
      kind: "provider-subject",
      provider_key: "a".repeat(128),
      value: "provider-subject-synthetic-boundary",
    },
  ] as const) {
    const request = {
      idempotency_key: "privacy-client-grammar-test",
      reason: "operator-subject-request",
      subject,
    } as const;
    assert.deepEqual(parseContactPrivacyRestrictionRequest(request), request);
  }

  for (const subject of [
    { kind: "email", value: "privacy@subject@localhost" },
    {
      kind: "provider-subject",
      provider_key: "Provider.v1",
      value: "provider-subject-synthetic-uppercase",
    },
    {
      kind: "provider-subject",
      provider_key: "a".repeat(129),
      value: "provider-subject-synthetic-boundary",
    },
  ] as const) {
    assert.throws(
      () =>
        parseContactPrivacyRestrictionRequest({
          idempotency_key: "privacy-client-grammar-invalid",
          reason: "operator-subject-request",
          subject,
        }),
      (error: unknown) => {
        assert.ok(error instanceof KurobaraTransportError);
        assert.equal(error.kind, "invalid-input");
        return true;
      }
    );
  }
});

const exportSha256 =
  "sha256:039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81";

const exportResponse = (
  body: BodyInit,
  options: Readonly<{
    contentLength?: string;
    contentSha256?: string;
    contentType?: string;
    disposition?: string;
    delivery?: boolean;
    deliveryExpiresAtMs?: string;
    deliveryId?: string;
    deliveryState?: string;
    format?: "csv" | "jsonl";
    integrity?: boolean;
  }> = {}
): Response => {
  const format = options.format ?? "jsonl";
  const headers = new Headers({
    "cache-control": "private, no-store",
    "content-disposition":
      options.disposition ??
      `attachment; filename="kurobara-recipe-application.${format}"`,
    "content-type":
      options.contentType ??
      (format === "csv" ? "text/csv" : "application/x-ndjson"),
    "x-content-type-options": "nosniff",
  });
  if (options.integrity !== false) {
    headers.set("content-length", options.contentLength ?? "3");
    headers.set(
      "x-kurobara-content-sha256",
      options.contentSha256 ?? exportSha256
    );
  }
  if (options.delivery === true) {
    headers.set(
      "x-kurobara-delivery-id",
      options.deliveryId ?? "delivery-client-test"
    );
    headers.set(
      "x-kurobara-delivery-expires-at-ms",
      options.deliveryExpiresAtMs ?? "1752786400000"
    );
    headers.set(
      "x-kurobara-delivery-state",
      options.deliveryState ?? "prepared"
    );
  }
  return new Response(body, {
    headers,
  });
};

test("streams canonical metadata before source bytes exactly once", async () => {
  let calls = 0;
  const client = createKurobaraClient({
    apiKey: "synthetic-api-key",
    baseUrl: "http://127.0.0.1:3000/base/",
    fetch: async (input, init) => {
      calls += 1;
      assert.equal(
        String(input),
        "http://127.0.0.1:3000/base/v1/dataset-imports"
      );
      assert.equal(init?.method, "POST");
      assert.equal(
        new Headers(init?.headers).get("authorization"),
        "Bearer synthetic-api-key"
      );
      assert.equal(
        new Headers(init?.headers).get("content-type"),
        "multipart/form-data; boundary=kurobara-test-boundary"
      );
      const request = new Request(input, init);
      const body = await request.text();
      const metadataPosition = body.indexOf('name="metadata"');
      const sourcePosition = body.indexOf('name="source"');
      assert.ok(metadataPosition >= 0);
      assert.ok(sourcePosition > metadataPosition);
      assert.match(body, IMPORT_ID_PATTERN);
      assert.match(body, SOURCE_HEADER_PATTERN);
      return Response.json(successBody);
    },
    multipartBoundary: () => "kurobara-test-boundary",
  });

  assert.deepEqual(
    await client.datasets.import({ metadata, source: source() }),
    successBody
  );
  assert.equal(calls, 1);
});

test("posts one strict recipe application request with cancellation support", async () => {
  const controller = new AbortController();
  let calls = 0;
  const client = createKurobaraClient({
    apiKey: "synthetic-api-key",
    baseUrl: "http://127.0.0.1:3000/base/",
    fetch: (input, init) => {
      calls += 1;
      assert.equal(
        String(input),
        "http://127.0.0.1:3000/base/v1/recipe-applications"
      );
      assert.equal(init?.method, "POST");
      assert.equal(init?.signal, controller.signal);
      const headers = new Headers(init?.headers);
      assert.equal(headers.get("authorization"), "Bearer synthetic-api-key");
      assert.equal(headers.get("content-type"), "application/json");
      assert.deepEqual(JSON.parse(String(init?.body)), recipeRequest);
      return Promise.resolve(Response.json(recipeSuccessBody));
    },
  });

  assert.deepEqual(
    await client.recipes.apply(recipeRequest, { signal: controller.signal }),
    recipeSuccessBody
  );
  assert.equal(calls, 1);
});

test("cancels one encoded run with only the idempotency key in the JSON body", async () => {
  const controller = new AbortController();
  let calls = 0;
  const client = createKurobaraClient({
    apiKey: "synthetic-api-key",
    baseUrl: "http://127.0.0.1:3000/base/",
    fetch: (input, init) => {
      calls += 1;
      assert.equal(
        String(input),
        "http://127.0.0.1:3000/base/v1/runs/run%2Fclient%20test/cancel"
      );
      assert.equal(init?.method, "POST");
      assert.equal(init?.signal, controller.signal);
      const headers = new Headers(init?.headers);
      assert.equal(headers.get("authorization"), "Bearer synthetic-api-key");
      assert.equal(headers.get("content-type"), "application/json");
      assert.deepEqual(JSON.parse(String(init?.body)), {
        idempotency_key: "cancel-client-test",
      });
      return Promise.resolve(Response.json(runCancelResponse));
    },
  });

  assert.deepEqual(
    await client.runs.cancel(runCancelRequest, { signal: controller.signal }),
    runCancelResponse
  );
  assert.equal(calls, 1);
});

test("validates run cancellation input and response identity without a request retry", async () => {
  let calls = 0;
  const client = createKurobaraClient({
    apiKey: "synthetic-api-key",
    baseUrl: "http://127.0.0.1:3000",
    fetch: () => {
      calls += 1;
      return Promise.resolve(
        Response.json({ ...runCancelResponse, run_id: "run-other" })
      );
    },
  });

  await assert.rejects(
    client.runs.cancel(runCancelRequest),
    (error: unknown) => {
      assert.ok(error instanceof KurobaraTransportError);
      assert.equal(error.kind, "invalid-response");
      return true;
    }
  );
  assert.equal(calls, 1);

  await assert.rejects(
    client.runs.cancel({
      ...runCancelRequest,
      idempotency_key: "",
    }),
    (error: unknown) => {
      assert.ok(error instanceof KurobaraTransportError);
      assert.equal(error.kind, "invalid-input");
      return true;
    }
  );
  assert.equal(calls, 1);
});

test("projects a canonical cancellation conflict without retry", async () => {
  const problem = {
    code: "idempotency-key-reused",
    retryable: false,
    status: 409,
    title: "Idempotency key reused",
    type: "https://problems.kurobara.invalid/idempotency-key-reused",
  } as const;
  let calls = 0;
  const client = createKurobaraClient({
    apiKey: "synthetic-api-key",
    baseUrl: "http://127.0.0.1:3000",
    fetch: () => {
      calls += 1;
      return Promise.resolve(
        Response.json(problem, {
          headers: { "content-type": "application/problem+json" },
          status: 409,
        })
      );
    },
  });

  await assert.rejects(
    client.runs.cancel(runCancelRequest),
    (error: unknown) => {
      assert.ok(error instanceof KurobaraProblemError);
      assert.deepEqual(error.problem, problem);
      return true;
    }
  );
  assert.equal(calls, 1);
});

test("gets one encoded recipe application snapshot with cancellation support", async () => {
  const controller = new AbortController();
  let calls = 0;
  const client = createKurobaraClient({
    apiKey: "synthetic-api-key",
    baseUrl: "http://127.0.0.1:3000/base/",
    fetch: (input, init) => {
      calls += 1;
      assert.equal(
        String(input),
        "http://127.0.0.1:3000/base/v1/recipe-applications/application%2Fclient%20test"
      );
      assert.equal(init?.method, "GET");
      assert.equal(init?.signal, controller.signal);
      const headers = new Headers(init?.headers);
      assert.equal(headers.get("authorization"), "Bearer synthetic-api-key");
      assert.equal(headers.has("content-type"), false);
      assert.equal(init?.body, undefined);
      return Promise.resolve(Response.json(recipeWatchBody));
    },
  });

  assert.deepEqual(
    await client.recipeApplications.get(
      { application_id: "application/client test" },
      { signal: controller.signal }
    ),
    recipeWatchBody
  );
  assert.equal(calls, 1);
});

test("opens one strict recipe application export without retry", async () => {
  const controller = new AbortController();
  let calls = 0;
  const client = createKurobaraClient({
    apiKey: "synthetic-api-key",
    baseUrl: "http://127.0.0.1:3000/base/",
    fetch: (input, init) => {
      calls += 1;
      assert.equal(
        String(input),
        "http://127.0.0.1:3000/base/v1/recipe-application-exports"
      );
      assert.equal(init?.method, "POST");
      assert.equal(init?.signal, controller.signal);
      const headers = new Headers(init?.headers);
      assert.equal(headers.get("authorization"), "Bearer synthetic-api-key");
      assert.equal(headers.get("content-type"), "application/json");
      assert.deepEqual(JSON.parse(String(init?.body)), exportRequest);
      return Promise.resolve(exportResponse(new Uint8Array([1, 2, 3])));
    },
  });

  const exported = await client.recipeApplications.export(exportRequest, {
    maxBytes: 3,
    signal: controller.signal,
  });
  assert.equal(calls, 1);
  assert.deepEqual(
    {
      contentLength: exported.contentLength,
      contentSha256: exported.contentSha256,
      contentType: exported.contentType,
      filename: exported.filename,
    },
    {
      contentLength: 3,
      contentSha256: exportSha256,
      contentType: "application/x-ndjson",
      filename: "kurobara-recipe-application.jsonl",
    }
  );
  const chunks: Uint8Array[] = [];
  for await (const chunk of exported.bytes) {
    chunks.push(chunk);
  }
  assert.deepEqual(chunks, [new Uint8Array([1, 2, 3])]);
});

test("opens one chunked dataset export as a bounded byte stream", async () => {
  const controller = new AbortController();
  let calls = 0;
  const client = createKurobaraClient({
    apiKey: "synthetic-api-key",
    baseUrl: "http://127.0.0.1:3000/base/",
    fetch: (input, init) => {
      calls += 1;
      assert.equal(
        String(input),
        "http://127.0.0.1:3000/base/v1/dataset-exports"
      );
      assert.equal(init?.method, "POST");
      assert.equal(init?.signal, controller.signal);
      const headers = new Headers(init?.headers);
      assert.equal(headers.get("authorization"), "Bearer synthetic-api-key");
      assert.equal(headers.get("content-type"), "application/json");
      assert.deepEqual(JSON.parse(String(init?.body)), datasetExportRequest);
      return Promise.resolve(
        exportResponse(new Uint8Array([1, 2, 3]), {
          delivery: true,
          disposition: 'attachment; filename="kurobara-dataset.csv"',
          format: "csv",
        })
      );
    },
  });

  const exported = await client.datasets.export(datasetExportRequest, {
    maxBytes: 3,
    signal: controller.signal,
  });
  assert.equal(calls, 1);
  assert.deepEqual(
    {
      contentLength: exported.contentLength,
      contentSha256: exported.contentSha256,
      contentType: exported.contentType,
      filename: exported.filename,
    },
    {
      contentLength: 3,
      contentSha256: exportSha256,
      contentType: "text/csv",
      filename: "kurobara-dataset.csv",
    }
  );
  assert.deepEqual(exported.delivery, {
    deliveryId: "delivery-client-test",
    expiresAtMs: 1_752_786_400_000,
    stateAtResponse: "prepared",
  });
  const chunks: Uint8Array[] = [];
  for await (const chunk of exported.bytes) {
    chunks.push(chunk);
  }
  assert.deepEqual(chunks, [new Uint8Array([1, 2, 3])]);
});

test("reads and revokes one owner-scoped export delivery", async () => {
  const calls: string[] = [];
  const client = createKurobaraClient({
    apiKey: "synthetic-api-key",
    baseUrl: "http://127.0.0.1:3000/base/",
    fetch: (input, init) => {
      calls.push(`${init?.method} ${String(input)}`);
      const headers = new Headers(init?.headers);
      assert.equal(headers.get("authorization"), "Bearer synthetic-api-key");
      if (init?.method === "POST") {
        assert.equal(headers.get("content-type"), "application/json");
        assert.equal(String(init.body), "{}");
      } else {
        assert.equal(init?.body, undefined);
      }
      return Promise.resolve(
        Response.json(
          init?.method === "POST"
            ? exportDeliveryRevocation
            : exportDeliveryState
        )
      );
    },
  });

  assert.deepEqual(
    await client.exportDeliveries.get({
      delivery_id: "delivery/client test",
    }),
    exportDeliveryState
  );
  assert.deepEqual(
    await client.exportDeliveries.revoke({
      delivery_id: "delivery/client test",
    }),
    exportDeliveryRevocation
  );
  assert.deepEqual(calls, [
    "GET http://127.0.0.1:3000/base/v1/export-deliveries/delivery%2Fclient%20test",
    "POST http://127.0.0.1:3000/base/v1/export-deliveries/delivery%2Fclient%20test/revoke",
  ]);
});

test("rejects a non-revoked or chronologically invalid revoke success", async () => {
  for (const responseBody of [
    exportDeliveryState,
    { ...exportDeliveryState, state: "revoked" },
    {
      ...exportDeliveryRevocation,
      revoked_at_ms: exportDeliveryRevocation.prepared_at_ms - 1,
    },
    {
      ...exportDeliveryRevocation,
      delivered_at_ms: exportDeliveryRevocation.revoked_at_ms + 1,
    },
  ]) {
    const client = createKurobaraClient({
      apiKey: "synthetic-api-key",
      baseUrl: "http://127.0.0.1:3000",
      fetch: () => Promise.resolve(Response.json(responseBody)),
    });
    await assert.rejects(
      client.exportDeliveries.revoke({
        delivery_id: "delivery/client test",
      }),
      (error: unknown) => {
        assert.ok(error instanceof KurobaraTransportError);
        assert.equal(error.kind, "invalid-response");
        return true;
      }
    );
  }
});

test("accepts coherent prepared, expired, and revoked delivery states", async () => {
  for (const responseBody of [
    { ...exportDeliveryBase, state: "prepared" },
    { ...exportDeliveryBase, state: "expired" },
    {
      ...exportDeliveryBase,
      delivered_at_ms: exportDeliveryState.delivered_at_ms,
      state: "expired",
    },
    exportDeliveryRevocation,
  ] as const) {
    const client = createKurobaraClient({
      apiKey: "synthetic-api-key",
      baseUrl: "http://127.0.0.1:3000",
      fetch: () => Promise.resolve(Response.json(responseBody)),
    });
    assert.deepEqual(
      await client.exportDeliveries.get({
        delivery_id: "delivery/client test",
      }),
      responseBody
    );
  }
});

test("rejects incoherent export delivery lifecycle state successes", async () => {
  const coherentDeliveredAt = exportDeliveryState.delivered_at_ms;
  const coherentRevokedAt = exportDeliveryRevocation.revoked_at_ms;
  for (const responseBody of [
    {
      ...exportDeliveryBase,
      delivered_at_ms: coherentDeliveredAt,
      state: "prepared",
    },
    {
      ...exportDeliveryBase,
      state: "delivered",
    },
    {
      ...exportDeliveryState,
      revoked_at_ms: coherentRevokedAt,
    },
    {
      ...exportDeliveryBase,
      expires_at_ms: exportDeliveryBase.prepared_at_ms,
      state: "prepared",
    },
    {
      ...exportDeliveryState,
      delivered_at_ms: exportDeliveryBase.prepared_at_ms - 1,
    },
    {
      ...exportDeliveryState,
      delivered_at_ms: exportDeliveryBase.expires_at_ms,
    },
    {
      ...exportDeliveryBase,
      delivered_at_ms: exportDeliveryBase.expires_at_ms,
      state: "expired",
    },
    {
      ...exportDeliveryBase,
      revoked_at_ms: coherentRevokedAt,
      state: "expired",
    },
    {
      ...exportDeliveryRevocation,
      revoked_at_ms: exportDeliveryBase.prepared_at_ms - 1,
    },
    {
      ...exportDeliveryRevocation,
      delivered_at_ms: coherentRevokedAt + 1,
    },
  ]) {
    const client = createKurobaraClient({
      apiKey: "synthetic-api-key",
      baseUrl: "http://127.0.0.1:3000",
      fetch: () => Promise.resolve(Response.json(responseBody)),
    });
    await assert.rejects(
      client.exportDeliveries.get({
        delivery_id: "delivery/client test",
      }),
      (error: unknown) => {
        assert.ok(error instanceof KurobaraTransportError);
        assert.equal(error.kind, "invalid-response");
        return true;
      }
    );
  }
});

test("registers a privacy restriction without accepting subject data in the response", async () => {
  let calls = 0;
  const client = createKurobaraClient({
    apiKey: "synthetic-api-key",
    baseUrl: "http://127.0.0.1:3000",
    fetch: (_input, init) => {
      calls += 1;
      assert.deepEqual(
        JSON.parse(String(init?.body)),
        contactPrivacyRestrictionRequest
      );
      return Promise.resolve(Response.json(contactPrivacyRestrictionResponse));
    },
  });

  assert.deepEqual(
    await client.contactPrivacy.restrict(contactPrivacyRestrictionRequest),
    contactPrivacyRestrictionResponse
  );
  await assert.rejects(
    client.contactPrivacy.restrict({
      ...contactPrivacyRestrictionRequest,
      subject: {
        kind: "email",
        provider_key: "synthetic-provider",
        value: "privacy-subject@example.invalid",
      },
    } as never),
    (error: unknown) => {
      assert.ok(error instanceof KurobaraTransportError);
      assert.equal(error.kind, "invalid-input");
      return true;
    }
  );
  assert.equal(calls, 1);
});

test("rejects partial or terminal dataset export delivery headers", async () => {
  for (const headers of [
    { "x-kurobara-delivery-id": "delivery-client-test" },
    {
      "x-kurobara-delivery-expires-at-ms": "1752786400000",
      "x-kurobara-delivery-id": "delivery-client-test",
      "x-kurobara-delivery-state": "revoked",
    },
  ]) {
    const response = exportResponse(new Uint8Array([1, 2, 3]), {
      disposition: 'attachment; filename="kurobara-dataset.csv"',
      format: "csv",
    });
    for (const [name, value] of Object.entries(headers)) {
      response.headers.set(name, value);
    }
    const client = createKurobaraClient({
      apiKey: "synthetic-api-key",
      baseUrl: "http://127.0.0.1:3000",
      fetch: () => Promise.resolve(response),
    });
    await assert.rejects(
      client.datasets.export(datasetExportRequest),
      (error: unknown) => {
        assert.ok(error instanceof KurobaraTransportError);
        assert.equal(error.kind, "invalid-response");
        return true;
      }
    );
  }
});

test("enforces the configured dataset export limit from required integrity headers", async () => {
  const client = createKurobaraClient({
    apiKey: "synthetic-api-key",
    baseUrl: "http://127.0.0.1:3000",
    fetch: () =>
      Promise.resolve(
        exportResponse(new Uint8Array([1, 2, 3]), {
          disposition: 'attachment; filename="kurobara-dataset.csv"',
          format: "csv",
        })
      ),
  });
  await assert.rejects(
    client.datasets.export(datasetExportRequest, { maxBytes: 2 }),
    (error: unknown) => {
      assert.ok(error instanceof KurobaraTransportError);
      assert.equal(error.kind, "invalid-response");
      return true;
    }
  );
});

test("rejects incomplete required dataset export integrity metadata", async () => {
  const headers = new Headers({
    "cache-control": "private, no-store",
    "content-disposition": 'attachment; filename="kurobara-dataset.csv"',
    "content-length": "3",
    "content-type": "text/csv",
    "x-content-type-options": "nosniff",
  });
  const client = createKurobaraClient({
    apiKey: "synthetic-api-key",
    baseUrl: "http://127.0.0.1:3000",
    fetch: () =>
      Promise.resolve(new Response(new Uint8Array([1, 2, 3]), { headers })),
  });

  await assert.rejects(
    client.datasets.export(datasetExportRequest),
    (error: unknown) => {
      assert.ok(error instanceof KurobaraTransportError);
      assert.equal(error.kind, "invalid-response");
      return true;
    }
  );
});

test("validates dataset export input before network I/O", async () => {
  let calls = 0;
  const client = createKurobaraClient({
    apiKey: "synthetic-api-key",
    baseUrl: "http://127.0.0.1:3000",
    fetch: () => {
      calls += 1;
      return Promise.resolve(
        exportResponse(new Uint8Array([1, 2, 3]), {
          disposition: 'attachment; filename="kurobara-dataset.csv"',
          format: "csv",
        })
      );
    },
  });

  await assert.rejects(
    client.datasets.export({
      ...datasetExportRequest,
      field_ids: ["field-name", "field-name"],
    }),
    (error: unknown) => {
      assert.ok(error instanceof KurobaraTransportError);
      assert.equal(error.kind, "invalid-input");
      return true;
    }
  );
  await assert.rejects(
    client.datasets.export(datasetExportRequest, { maxBytes: 0 }),
    (error: unknown) => {
      assert.ok(error instanceof KurobaraTransportError);
      assert.equal(error.kind, "invalid-input");
      return true;
    }
  );
  assert.equal(calls, 0);
});

test("keeps export reads backpressured and cancels an abandoned body", async () => {
  let pulls = 0;
  let cancellations = 0;
  const body = new ReadableStream<Uint8Array>(
    {
      cancel: () => {
        cancellations += 1;
      },
      pull: (controller) => {
        pulls += 1;
        controller.enqueue(new Uint8Array([pulls]));
      },
    },
    { highWaterMark: 0 }
  );
  const client = createKurobaraClient({
    apiKey: "synthetic-api-key",
    baseUrl: "http://127.0.0.1:3000",
    fetch: () => Promise.resolve(exportResponse(body)),
  });

  const exported = await client.recipeApplications.export(exportRequest);
  assert.equal(pulls, 0);
  const iterator = exported.bytes[Symbol.asyncIterator]();
  assert.deepEqual(await iterator.next(), {
    done: false,
    value: new Uint8Array([1]),
  });
  assert.equal(pulls, 1);
  await iterator.return?.();
  assert.equal(cancellations, 1);
  await assert.rejects(
    async () => exported.bytes[Symbol.asyncIterator](),
    (error: unknown) => {
      assert.ok(error instanceof KurobaraTransportError);
      assert.equal(error.kind, "invalid-input");
      return true;
    }
  );
});

test("rejects export body failures, truncation, overruns, and hash drift", async () => {
  const bodyFailure = new ReadableStream<Uint8Array>({
    pull: (controller) => controller.error(new Error("sensitive body failure")),
  });
  const candidates = [
    {
      expectedKind: "network",
      response: exportResponse(bodyFailure),
    },
    {
      expectedKind: "invalid-response",
      response: exportResponse(new Uint8Array([1, 2]), { contentLength: "3" }),
    },
    {
      expectedKind: "invalid-response",
      response: exportResponse(new Uint8Array([1, 2, 3, 4]), {
        contentLength: "3",
      }),
    },
    {
      expectedKind: "invalid-response",
      response: exportResponse(new Uint8Array([1, 2, 3]), {
        contentSha256: `sha256:${"d".repeat(64)}`,
      }),
    },
  ] as const;

  for (const candidate of candidates) {
    const client = createKurobaraClient({
      apiKey: "secret-that-must-not-appear",
      baseUrl: "http://127.0.0.1:3000",
      fetch: () => Promise.resolve(candidate.response),
    });
    const exported = await client.recipeApplications.export(exportRequest);
    await assert.rejects(
      async () => {
        for await (const _chunk of exported.bytes) {
          // Consume the one-shot stream to exercise its integrity checks.
        }
      },
      (error: unknown) => {
        assert.ok(error instanceof KurobaraTransportError);
        assert.equal(error.kind, candidate.expectedKind);
        assert.equal(error.message.includes("sensitive body failure"), false);
        assert.equal(
          error.message.includes("secret-that-must-not-appear"),
          false
        );
        return true;
      }
    );
  }
});

test("rejects invalid export metadata and configured limits before consumption", async () => {
  const invalidResponses = [
    exportResponse(new Uint8Array([1, 2, 3]), { contentType: "text/csv" }),
    exportResponse(new Uint8Array([1, 2, 3]), { integrity: false }),
    exportResponse(new Uint8Array([1, 2, 3]), { contentLength: "03" }),
    exportResponse(new Uint8Array([1, 2, 3]), {
      contentSha256: "c".repeat(64),
    }),
    exportResponse(new Uint8Array([1, 2, 3]), {
      disposition: 'attachment; filename="other.jsonl"',
    }),
    new Response(new Uint8Array([1, 2, 3]), {
      headers: {
        "content-disposition":
          'attachment; filename="kurobara-recipe-application.jsonl"',
        "content-length": "3",
        "content-type": "application/x-ndjson",
        "x-content-type-options": "nosniff",
        "x-kurobara-content-sha256": exportSha256,
      },
    }),
  ];
  for (const response of invalidResponses) {
    const client = createKurobaraClient({
      apiKey: "synthetic-api-key",
      baseUrl: "http://127.0.0.1:3000",
      fetch: () => Promise.resolve(response),
    });
    await assert.rejects(
      client.recipeApplications.export(exportRequest),
      (error: unknown) => {
        assert.ok(error instanceof KurobaraTransportError);
        assert.equal(error.kind, "invalid-response");
        return true;
      }
    );
  }

  const limited = createKurobaraClient({
    apiKey: "synthetic-api-key",
    baseUrl: "http://127.0.0.1:3000",
    fetch: () =>
      Promise.resolve(
        exportResponse(new Uint8Array([1, 2, 3]), { contentLength: "3" })
      ),
  });
  await assert.rejects(
    limited.recipeApplications.export(exportRequest, { maxBytes: 2 }),
    (error: unknown) => {
      assert.ok(error instanceof KurobaraTransportError);
      assert.equal(error.kind, "invalid-response");
      return true;
    }
  );
});

test("validates export input and canonical problems without retry", async () => {
  let calls = 0;
  const inputClient = createKurobaraClient({
    apiKey: "synthetic-api-key",
    baseUrl: "http://127.0.0.1:3000",
    fetch: () => {
      calls += 1;
      return Promise.resolve(exportResponse(new Uint8Array([1, 2, 3])));
    },
  });
  for (const request of [
    { ...exportRequest, extra: true },
    { ...exportRequest, field_ids: ["field-domain", "field-domain"] },
  ]) {
    await assert.rejects(
      inputClient.recipeApplications.export(request),
      (error: unknown) => {
        assert.ok(error instanceof KurobaraTransportError);
        assert.equal(error.kind, "invalid-input");
        return true;
      }
    );
  }
  await assert.rejects(
    inputClient.recipeApplications.export(exportRequest, { maxBytes: 0 }),
    (error: unknown) => {
      assert.ok(error instanceof KurobaraTransportError);
      assert.equal(error.kind, "invalid-input");
      return true;
    }
  );
  assert.equal(calls, 0);

  const problem = {
    code: "recipe-application-export-unavailable",
    retryable: false,
    status: 409,
    title: "Recipe application export unavailable",
    type: "https://problems.kurobara.invalid/recipe-application-export-unavailable",
  } as const;
  let problemCalls = 0;
  const problemClient = createKurobaraClient({
    apiKey: "synthetic-api-key",
    baseUrl: "http://127.0.0.1:3000",
    fetch: () => {
      problemCalls += 1;
      return Promise.resolve(
        Response.json(problem, {
          headers: { "content-type": "application/problem+json" },
          status: 409,
        })
      );
    },
  });
  await assert.rejects(
    problemClient.recipeApplications.export(exportRequest),
    (error: unknown) => {
      assert.ok(error instanceof KurobaraProblemError);
      assert.deepEqual(error.problem, problem);
      return true;
    }
  );
  assert.equal(problemCalls, 1);

  const foreignProblem = {
    code: "idempotency-key-reused",
    retryable: false,
    status: 409,
    title: "Idempotency key reused",
    type: "https://problems.kurobara.invalid/idempotency-key-reused",
  } as const;
  const foreignClient = createKurobaraClient({
    apiKey: "synthetic-api-key",
    baseUrl: "http://127.0.0.1:3000",
    fetch: () =>
      Promise.resolve(
        Response.json(foreignProblem, {
          headers: { "content-type": "application/problem+json" },
          status: 409,
        })
      ),
  });
  await assert.rejects(
    foreignClient.recipeApplications.export(exportRequest),
    (error: unknown) => {
      assert.ok(error instanceof KurobaraTransportError);
      assert.equal(error.kind, "invalid-response");
      return true;
    }
  );
});

test("rejects invalid recipe application input and status invariants", async () => {
  let calls = 0;
  const inputClient = createKurobaraClient({
    apiKey: "synthetic-api-key",
    baseUrl: "http://127.0.0.1:3000",
    fetch: () => {
      calls += 1;
      return Promise.resolve(Response.json(recipeWatchBody));
    },
  });
  await assert.rejects(
    inputClient.recipeApplications.get({ application_id: " ".repeat(256) }),
    (error: unknown) => {
      assert.ok(error instanceof KurobaraTransportError);
      assert.equal(error.kind, "invalid-input");
      return true;
    }
  );
  assert.equal(calls, 0);

  for (const body of [
    { ...recipeWatchBody, unexpected: "must-not-pass" },
    { ...recipeWatchBody, total_cell_count: 3 },
    { ...recipeWatchBody, state: "succeeded", terminal: true },
  ]) {
    const client = createKurobaraClient({
      apiKey: "synthetic-api-key",
      baseUrl: "http://127.0.0.1:3000",
      fetch: () => Promise.resolve(Response.json(body)),
    });
    await assert.rejects(
      client.recipeApplications.get({ application_id: "application-test" }),
      (error: unknown) => {
        assert.ok(error instanceof KurobaraTransportError);
        assert.equal(error.kind, "invalid-response");
        return true;
      }
    );
  }
});

test("maps recipe application aborts and canonical problems without retry", async () => {
  const controller = new AbortController();
  controller.abort();
  let abortedCalls = 0;
  const abortedClient = createKurobaraClient({
    apiKey: "synthetic-api-key",
    baseUrl: "http://127.0.0.1:3000",
    fetch: (_input, init) => {
      abortedCalls += 1;
      assert.equal(init?.signal, controller.signal);
      return Promise.reject(new DOMException("Aborted", "AbortError"));
    },
  });
  await assert.rejects(
    abortedClient.recipeApplications.get(
      { application_id: "application-test" },
      { signal: controller.signal }
    ),
    (error: unknown) => {
      assert.ok(error instanceof KurobaraTransportError);
      assert.equal(error.kind, "network");
      return true;
    }
  );
  assert.equal(abortedCalls, 1);

  const problem = {
    code: "recipe-application-not-found",
    retryable: false,
    status: 404,
    title: "Recipe application not found",
    type: "https://problems.kurobara.invalid/recipe-application-not-found",
  } as const;
  let problemCalls = 0;
  const problemClient = createKurobaraClient({
    apiKey: "synthetic-api-key",
    baseUrl: "http://127.0.0.1:3000",
    fetch: () => {
      problemCalls += 1;
      return Promise.resolve(
        Response.json(problem, {
          headers: { "content-type": "application/problem+json" },
          status: 404,
        })
      );
    },
  });
  await assert.rejects(
    problemClient.recipeApplications.get({ application_id: "missing" }),
    (error: unknown) => {
      assert.ok(error instanceof KurobaraProblemError);
      assert.deepEqual(error.problem, problem);
      return true;
    }
  );
  assert.equal(problemCalls, 1);
});

test("rejects invalid and hostile recipe requests before network I/O", async () => {
  let calls = 0;
  const client = createKurobaraClient({
    apiKey: "synthetic-api-key",
    baseUrl: "http://127.0.0.1:3000",
    fetch: () => {
      calls += 1;
      return Promise.resolve(Response.json(recipeSuccessBody));
    },
  });

  const invalidRequests: unknown[] = [
    { ...recipeRequest, unexpected: "must-not-pass" },
    { ...recipeRequest, max_cells: 0 },
    {
      ...recipeRequest,
      recipe: { ...recipeRequest.recipe, workspace_id: "" },
    },
  ];
  const cyclic: Record<string, unknown> = { ...recipeRequest };
  cyclic.self = cyclic;
  invalidRequests.push(cyclic);

  for (const candidate of invalidRequests) {
    await assert.rejects(
      client.recipes.apply(candidate as RecipeApplyRequest),
      (error: unknown) => {
        assert.ok(error instanceof KurobaraTransportError);
        assert.equal(error.kind, "invalid-input");
        assert.equal(error.message.includes("synthetic-api-key"), false);
        return true;
      }
    );
  }
  assert.equal(calls, 0);
});

test("limits recipe problems to the canonical operation", async () => {
  const canonicalProblem = {
    code: "idempotency-key-reused",
    retryable: false,
    status: 409,
    title: "Idempotency key reused",
    type: "https://problems.kurobara.invalid/idempotency-key-reused",
  } as const;
  const accepted = createKurobaraClient({
    apiKey: "synthetic-api-key",
    baseUrl: "http://127.0.0.1:3000",
    fetch: () =>
      Promise.resolve(
        Response.json(canonicalProblem, {
          headers: { "content-type": "application/problem+json" },
          status: 409,
        })
      ),
  });
  await assert.rejects(
    accepted.recipes.apply(recipeRequest),
    (error: unknown) => {
      assert.ok(error instanceof KurobaraProblemError);
      assert.deepEqual(error.problem, canonicalProblem);
      return true;
    }
  );

  const foreignProblem = {
    code: "dataset-import-conflict",
    retryable: false,
    status: 409,
    title: "Dataset import conflict",
    type: "https://problems.kurobara.invalid/dataset-import-conflict",
  } as const;
  const rejected = createKurobaraClient({
    apiKey: "synthetic-api-key",
    baseUrl: "http://127.0.0.1:3000",
    fetch: () =>
      Promise.resolve(
        Response.json(foreignProblem, {
          headers: { "content-type": "application/problem+json" },
          status: 409,
        })
      ),
  });
  await assert.rejects(
    rejected.recipes.apply(recipeRequest),
    (error: unknown) => {
      assert.ok(error instanceof KurobaraTransportError);
      assert.equal(error.kind, "invalid-response");
      return true;
    }
  );
});

test("rejects malformed recipe success envelopes and count drift", async () => {
  for (const response of [
    Response.json({ ...recipeSuccessBody, credential: "must-not-pass" }),
    Response.json({ ...recipeSuccessBody, total_cell_count: 3 }),
    Response.json(recipeSuccessBody, { status: 201 }),
    Response.json(recipeSuccessBody, {
      headers: { "content-type": "application/problem+json" },
    }),
  ]) {
    const client = createKurobaraClient({
      apiKey: "synthetic-api-key",
      baseUrl: "http://127.0.0.1:3000",
      fetch: () => Promise.resolve(response),
    });
    await assert.rejects(
      client.recipes.apply(recipeRequest),
      (error: unknown) => {
        assert.ok(error instanceof KurobaraTransportError);
        assert.equal(error.kind, "invalid-response");
        return true;
      }
    );
  }
});

test("classifies an aborted recipe request without exposing credentials", async () => {
  const controller = new AbortController();
  controller.abort();
  const client = createKurobaraClient({
    apiKey: "secret-that-must-not-appear",
    baseUrl: "http://127.0.0.1:3000",
    fetch: (_input, init) => {
      assert.equal(init?.signal, controller.signal);
      return Promise.reject(new DOMException("aborted", "AbortError"));
    },
  });

  await assert.rejects(
    client.recipes.apply(recipeRequest, { signal: controller.signal }),
    (error: unknown) => {
      assert.ok(error instanceof KurobaraTransportError);
      assert.equal(error.kind, "network");
      assert.equal(
        error.message.includes("secret-that-must-not-appear"),
        false
      );
      return true;
    }
  );
});

test("projects a canonical API problem without retrying the mutation", async () => {
  let calls = 0;
  const problem = {
    code: "dataset-import-conflict",
    retryable: false,
    status: 409,
    title: "Dataset import conflict",
    type: "https://problems.kurobara.invalid/dataset-import-conflict",
  } as const;
  const client = createKurobaraClient({
    apiKey: "synthetic-api-key",
    baseUrl: "http://127.0.0.1:3000",
    fetch: () => {
      calls += 1;
      return Promise.resolve(
        Response.json(problem, {
          headers: { "content-type": "application/problem+json" },
          status: 409,
        })
      );
    },
    multipartBoundary: () => "kurobara-test-boundary",
  });

  await assert.rejects(
    client.datasets.import({ metadata, source: source() }),
    (error: unknown) => {
      assert.ok(error instanceof KurobaraProblemError);
      assert.deepEqual(error.problem, problem);
      return true;
    }
  );
  assert.equal(calls, 1);
});

test("rejects malformed successful responses and unsafe credentials", async () => {
  assert.throws(
    () =>
      createKurobaraClient({
        apiKey: "unsafe\ncredential",
        baseUrl: "http://127.0.0.1:3000",
      }),
    KurobaraConfigError
  );

  const client = createKurobaraClient({
    apiKey: "synthetic-api-key",
    baseUrl: "http://127.0.0.1:3000",
    fetch: () => Promise.resolve(Response.json({ state: "completed" })),
    multipartBoundary: () => "kurobara-test-boundary",
  });
  await assert.rejects(
    client.datasets.import({ metadata, source: source() }),
    (error: unknown) => {
      assert.ok(error instanceof KurobaraTransportError);
      assert.equal(error.kind, "invalid-response");
      return true;
    }
  );
});

test("rejects noncanonical, operation-foreign, and extended problem bodies", async () => {
  const canonical = {
    code: "dataset-import-conflict",
    retryable: false,
    status: 409,
    title: "Dataset import conflict",
    type: "https://problems.kurobara.invalid/dataset-import-conflict",
  } as const;
  const candidates = [
    { ...canonical, credential: "must-not-be-forwarded" },
    { ...canonical, type: "https://problems.kurobara.invalid/request-invalid" },
    {
      code: "run-not-found",
      retryable: false,
      status: 404,
      title: "Run not found",
      type: "https://problems.kurobara.invalid/run-not-found",
    },
  ];

  for (const candidate of candidates) {
    const client = createKurobaraClient({
      apiKey: "synthetic-api-key",
      baseUrl: "http://127.0.0.1:3000",
      fetch: () =>
        Promise.resolve(
          Response.json(candidate, {
            headers: { "content-type": "application/problem+json" },
            status: candidate.status,
          })
        ),
      multipartBoundary: () => "kurobara-test-boundary",
    });
    await assert.rejects(
      client.datasets.import({ metadata, source: source() }),
      (error: unknown) => {
        assert.ok(error instanceof KurobaraTransportError);
        assert.equal(error.kind, "invalid-response");
        assert.equal(error.message.includes("must-not-be-forwarded"), false);
        return true;
      }
    );
  }
});

test("rejects extended success bodies and noncanonical success envelopes", async () => {
  for (const response of [
    Response.json({ ...successBody, credential: "must-not-be-forwarded" }),
    Response.json(successBody, { status: 201 }),
    Response.json(successBody, {
      headers: { "content-type": "application/problem+json" },
    }),
  ]) {
    const client = createKurobaraClient({
      apiKey: "synthetic-api-key",
      baseUrl: "http://127.0.0.1:3000",
      fetch: () => Promise.resolve(response),
      multipartBoundary: () => "kurobara-test-boundary",
    });
    await assert.rejects(
      client.datasets.import({ metadata, source: source() }),
      (error: unknown) => {
        assert.ok(error instanceof KurobaraTransportError);
        assert.equal(error.kind, "invalid-response");
        return true;
      }
    );
  }
});

test("classifies network failures and closes an unconsumed source on cancellation", async () => {
  let rejectedSourceReturned = 0;
  const rejectedSource = {
    [Symbol.asyncIterator]() {
      return {
        next: () =>
          Promise.resolve({ done: false as const, value: new Uint8Array([1]) }),
        return: () => {
          rejectedSourceReturned += 1;
          return Promise.resolve({ done: true as const, value: undefined });
        },
      };
    },
  };
  const networkClient = createKurobaraClient({
    apiKey: "synthetic-api-key",
    baseUrl: "http://127.0.0.1:3000",
    fetch: () => Promise.reject(new TypeError("synthetic network failure")),
    multipartBoundary: () => "kurobara-test-boundary",
  });
  await assert.rejects(
    networkClient.datasets.import({ metadata, source: rejectedSource }),
    (error: unknown) => {
      assert.ok(error instanceof KurobaraTransportError);
      assert.equal(error.kind, "network");
      return true;
    }
  );
  assert.equal(rejectedSourceReturned, 1);

  let sourceAcquired = 0;
  let sourceRead = 0;
  let sourceReturned = 0;
  const cancellableSource = {
    [Symbol.asyncIterator]() {
      sourceAcquired += 1;
      return {
        next: () => {
          sourceRead += 1;
          return Promise.resolve({
            done: false as const,
            value: new Uint8Array([1]),
          });
        },
        return: () => {
          sourceReturned += 1;
          return Promise.resolve({ done: true as const, value: undefined });
        },
      };
    },
  };
  const cancellingClient = createKurobaraClient({
    apiKey: "synthetic-api-key",
    baseUrl: "http://127.0.0.1:3000",
    fetch: async (_input, init) => {
      assert.ok(init?.body instanceof ReadableStream);
      const reader = init.body.getReader();
      const first = await reader.read();
      assert.equal(first.done, false);
      await reader.cancel();
      return Response.json(successBody);
    },
    multipartBoundary: () => "kurobara-test-boundary",
  });
  await cancellingClient.datasets.import({
    metadata,
    source: cancellableSource,
  });
  assert.equal(sourceAcquired, 1);
  assert.equal(sourceRead, 0);
  assert.equal(sourceReturned, 1);
});
