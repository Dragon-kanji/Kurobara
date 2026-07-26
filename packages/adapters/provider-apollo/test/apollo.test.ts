import assert from "node:assert/strict";
import test from "node:test";

import { instant } from "@kurobara/kernel";
import type {
  PluginEstimateRequest,
  PluginExecuteRequest,
} from "@kurobara/plugin-sdk";

import {
  APOLLO_CONTACT_DISCOVERY_CAPABILITY,
  APOLLO_CONTACT_DISCOVERY_CONTRACTS,
  APOLLO_CONTACT_IDENTITY_CAPABILITY,
  APOLLO_CONTACT_IDENTITY_CONTRACTS,
  ApolloContactIdentityProviderError,
  ApolloProviderConfigurationError,
  createApolloContactIdentityProvider,
  createApolloProviderAdapter,
} from "../src/index.ts";

const SYNTHETIC_API_KEY = "synthetic-apollo-secret";
const SYNTHETIC_EMAIL = "private-person@example.invalid";
const SYNTHETIC_PHONE = "synthetic-phone.invalid";
const IDENTITY_DEADLINE = instant(2_000_000_000_000);
const hash = (character: string): string => `sha256:${character.repeat(64)}`;
const CONTACT_ID_PATTERN = /^contact_[0-9a-f]{64}$/u;
const CONTENT_HASH_PATTERN = /^sha256:[0-9a-f]{64}$/u;

const fieldDefinitions = [
  ["department", "Department", "string"],
  ["display_name", "Display name", "string"],
  ["identity_completeness", "Identity completeness", "string"],
  ["job_title", "Job title", "string"],
  ["observed_at_ms", "Observed", "number"],
  ["organization_domain", "Company domain", "string"],
  ["organization_id", "Company ID", "string"],
  ["organization_name", "Company name", "string"],
  ["person_country_code", "Country", "string"],
  ["profile_url", "Profile", "string"],
  ["seniority", "Seniority", "string"],
] as const;

const fields = fieldDefinitions.map(([key, label, valueType]) => ({
  datasetId: "contacts",
  fieldId: `field-${key}`,
  key,
  label,
  valueType,
  workspaceId: "workspace",
}));

const identityFieldDefinitions = [
  ["department", "Department", "string"],
  ["display_name", "Display name", "string"],
  ["first_name", "First name", "string"],
  ["identity_completeness", "Identity completeness", "string"],
  ["identity_observed_at_ms", "Identity observed", "number"],
  ["identity_status", "Identity status", "string"],
  ["job_title", "Job title", "string"],
  ["last_name", "Last name", "string"],
  ["observed_at_ms", "Observed", "number"],
  ["organization_domain", "Company domain", "string"],
  ["organization_id", "Company ID", "string"],
  ["organization_name", "Company name", "string"],
  ["person_country_code", "Country", "string"],
  ["profile_url", "Profile", "string"],
  ["seniority", "Seniority", "string"],
] as const;

const identityFields = identityFieldDefinitions.map(
  ([key, label, valueType]) => ({
    datasetId: "contacts-identity",
    fieldId: `identity-field-${key}`,
    key,
    label,
    valueType,
    workspaceId: "workspace",
  })
);

const identityCandidate = (
  suffix: string
): Readonly<Record<string, unknown>> => ({
  department: "sales",
  display_name: `Synthetic Pe***n ${suffix}`,
  identity_completeness: "obfuscated",
  job_title: "Sales Director",
  observed_at_ms: 1000,
  organization_domain: "synthetic.example",
  organization_id: "company-synthetic",
  organization_name: "Synthetic Company",
  person_country_code: "ES",
  profile_url: null,
  seniority: "director",
});

const selectedIdentity = (
  suffix: string
): Readonly<Record<string, unknown>> => ({
  candidate: identityCandidate(suffix),
  provider_identity: {
    provider_key: "apollo-people-search",
    provider_subject_id: `apollo_subject_${suffix}`,
  },
  source_record_id: `contact-source-${suffix}`,
});

const identityPageInput = (
  selection = [selectedIdentity("0001")],
  pageIndex = 0,
  overrides: Readonly<Record<string, unknown>> = {}
): Readonly<Record<string, unknown>> => ({
  capability: APOLLO_CONTACT_IDENTITY_CAPABILITY,
  datasetId: "contacts-identity",
  fields: identityFields,
  generationId: "generation-contact-identity",
  generationPlanId: "generation-plan-contact-identity",
  inputCursor: pageIndex === 0 ? null : `contact:${pageIndex}`,
  kind: "dataset-generation-page-input",
  limits: {
    maxCalls: selection.length,
    maxCompanies: 0,
    maxContactsPerCompany: 0,
    maxContactsTotal: selection.length,
    maxEnrichments: selection.length,
    maxPages: selection.length,
    maxPhones: 0,
    maxResults: selection.length - pageIndex,
  },
  normalizedQuery: {
    result_kind: "contact_identity",
    selected_contacts: selection,
    source_dataset_id: "contacts-source",
  },
  pageSequence: pageIndex + 1,
  planHash: hash("f"),
  queryHash: hash("1"),
  schemaHash: hash("2"),
  version: "1.0.0",
  workspaceId: "workspace",
  ...overrides,
});

const organization = (id: string, domain: null | string, name: string) => ({
  company_id: id,
  country_code: "ES",
  domain,
  name,
});

const pageInput = (
  overrides: Readonly<Record<string, unknown>> = {}
): Readonly<Record<string, unknown>> => ({
  capability: APOLLO_CONTACT_DISCOVERY_CAPABILITY,
  datasetId: "contacts",
  fields,
  generationId: "generation-contacts",
  generationPlanId: "generation-plan-contacts",
  inputCursor: null,
  kind: "dataset-generation-page-input",
  limits: {
    maxCalls: 2,
    maxCompanies: 2,
    maxContactsPerCompany: 2,
    maxContactsTotal: 3,
    maxEnrichments: 0,
    maxPages: 1,
    maxPhones: 0,
    maxResults: 3,
  },
  normalizedQuery: {
    company_headquarters_country_codes: ["ES"],
    departments: [],
    organization_generation_id: "organization-generation",
    organizations: [
      organization(
        "company-synthetic",
        "synthetic.example",
        "Synthetic Company"
      ),
    ],
    person_country_codes: ["FR"],
    result_kind: "contact",
    seniorities: ["director"],
    titles: ["Sales Director"],
  },
  pageSequence: 1,
  planHash: hash("a"),
  queryHash: hash("b"),
  schemaHash: hash("c"),
  version: "1.0.0",
  workspaceId: "workspace",
  ...overrides,
});

const context = {
  capability: APOLLO_CONTACT_DISCOVERY_CAPABILITY,
  configuration: { contentHash: hash("d"), value: {} },
  deadlineAtMs: 10_000,
};

const requestFor = (
  value: Readonly<Record<string, unknown>> = pageInput(),
  upperBound = 1
): PluginExecuteRequest => ({
  context,
  costLimit: { amount: upperBound, unit: "requests" },
  input: {
    contentHash: hash("e"),
    contract: APOLLO_CONTACT_DISCOVERY_CONTRACTS.input,
    sizeBytes: new TextEncoder().encode(JSON.stringify(value)).byteLength,
    value,
  },
  operationKey: "operation-apollo-contacts",
  quote: {
    expiresAtMs: 10_000,
    guarantee: "hard",
    pricingVersion: "1.0.0",
    unit: "requests",
    upperBound,
  },
});

const estimateRequestFor = (
  value: Readonly<Record<string, unknown>> = pageInput()
): PluginEstimateRequest => ({
  context,
  input: {
    contentHash: hash("e"),
    contract: APOLLO_CONTACT_DISCOVERY_CONTRACTS.input,
    sizeBytes: new TextEncoder().encode(JSON.stringify(value)).byteLength,
    value,
  },
});

const identityContext = {
  capability: APOLLO_CONTACT_IDENTITY_CAPABILITY,
  configuration: { contentHash: hash("3"), value: {} },
  deadlineAtMs: 10_000,
};

const identityRequestFor = (
  value: Readonly<Record<string, unknown>> = identityPageInput(),
  upperBound = 1
): PluginExecuteRequest => ({
  context: identityContext,
  costLimit: { amount: upperBound, unit: "requests" },
  input: {
    contentHash: hash("4"),
    contract: APOLLO_CONTACT_IDENTITY_CONTRACTS.input,
    sizeBytes: new TextEncoder().encode(JSON.stringify(value)).byteLength,
    value,
  },
  operationKey: "operation-apollo-contact-identity",
  quote: {
    expiresAtMs: 10_000,
    guarantee: "hard",
    pricingVersion: "1.0.0",
    unit: "requests",
    upperBound,
  },
});

const identityEstimateRequestFor = (
  value: Readonly<Record<string, unknown>> = identityPageInput()
): PluginEstimateRequest => ({
  context: identityContext,
  input: {
    contentHash: hash("4"),
    contract: APOLLO_CONTACT_IDENTITY_CONTRACTS.input,
    sizeBytes: new TextEncoder().encode(JSON.stringify(value)).byteLength,
    value,
  },
});

const apolloOrganization = (name: string) => ({
  has_city: true,
  has_country: true,
  has_employee_count: true,
  has_industry: true,
  has_phone: true,
  has_revenue: true,
  has_state: true,
  has_zip_code: true,
  name,
});

const apolloPerson = (
  id: string,
  organizationName: string,
  overrides: Readonly<Record<string, unknown>> = {}
) => ({
  first_name: "Synthetic",
  has_city: true,
  has_country: true,
  has_direct_phone: "Yes",
  has_email: true,
  has_state: true,
  id,
  last_name_obfuscated: "Pe***n",
  last_refreshed_at: "2026-07-01T12:00:00.000Z",
  organization: apolloOrganization(organizationName),
  title: "Sales Director",
  ...overrides,
});

const jsonResponse = (value: unknown, status = 200): Response =>
  new Response(JSON.stringify(value), {
    headers: { "content-type": "application/json" },
    status,
  });

type Output = Readonly<{
  hasMore: boolean;
  items: readonly Readonly<{
    contentHash: string;
    providerIdentity: Readonly<{
      providerKey: string;
      providerSubjectId: string;
    }>;
    record: Readonly<{
      recordId: string;
      values: readonly Readonly<{ fieldId: string; value: unknown }>[];
    }>;
  }>[];
  nextCursor: null | string;
  sourcePartitionCompleted: boolean;
}>;

type IdentityOutput = Readonly<{
  hasMore: boolean;
  items: readonly Readonly<{
    contentHash: string;
    providerIdentity: Readonly<{
      providerKey: string;
      providerSubjectId: string;
    }>;
    record: Readonly<{
      recordId: string;
      values: readonly Readonly<{ fieldId: string; value: unknown }>[];
    }>;
    source: Readonly<{ datasetId: string; recordId: string }>;
  }>[];
  nextCursor: null | string;
  sourcePartitionCompleted: boolean;
}>;

const identityValue = (
  output: IdentityOutput,
  key: (typeof identityFieldDefinitions)[number][0]
): unknown => {
  const fieldId = identityFields.find((field) => field.key === key)?.fieldId;
  return output.items[0]?.record.values.find(
    (entry) => entry.fieldId === fieldId
  )?.value;
};

test("declares the Apollo BYOK boundary and produces one privacy-safe canonical contact", async () => {
  let capturedUrl: URL | undefined;
  let capturedInit: RequestInit | undefined;
  const adapter = createApolloProviderAdapter({
    apiKey: SYNTHETIC_API_KEY,
    clock: { now: () => 1000 },
    fetch: (input, init) => {
      capturedUrl = new URL(String(input));
      capturedInit = init;
      return Promise.resolve(
        jsonResponse({
          people: [apolloPerson("apollo_subject_0001", "Synthetic Company")],
          total_entries: 1,
        })
      );
    },
  });

  const { manifest } = adapter.describe();
  assert.equal(manifest.id, "dev.kurobara.provider-apollo");
  assert.deepEqual(manifest.auth.modes, ["api-key-header"]);
  assert.deepEqual(manifest.permissions.egress.hosts, ["api.apollo.io"]);
  assert.deepEqual(
    manifest.capabilities[0]?.inputContract,
    APOLLO_CONTACT_DISCOVERY_CONTRACTS.input
  );
  assert.deepEqual(
    manifest.capabilities[0]?.outputContract,
    APOLLO_CONTACT_DISCOVERY_CONTRACTS.output
  );
  const estimated = await adapter.estimate(estimateRequestFor());
  assert.equal(estimated.status, "quoted");
  if (estimated.status === "quoted") {
    assert.equal(estimated.quote.upperBound, 1);
    assert.equal(estimated.quote.unit, "requests");
  }

  const result = await adapter.execute(requestFor());
  assert.equal(result.status, "succeeded");
  if (result.status !== "succeeded") {
    assert.fail("Expected a successful Apollo search.");
  }
  assert.ok(capturedUrl);
  assert.equal(
    capturedUrl.origin + capturedUrl.pathname,
    "https://api.apollo.io/api/v1/mixed_people/api_search"
  );
  assert.deepEqual(capturedUrl?.searchParams.getAll("person_titles[]"), [
    "sales director",
  ]);
  assert.equal(
    capturedUrl?.searchParams.get("include_similar_titles"),
    "false"
  );
  assert.deepEqual(capturedUrl?.searchParams.getAll("person_seniorities[]"), [
    "director",
  ]);
  assert.deepEqual(capturedUrl?.searchParams.getAll("person_locations[]"), [
    "France",
  ]);
  assert.deepEqual(
    capturedUrl?.searchParams.getAll("organization_locations[]"),
    ["Spain"]
  );
  assert.deepEqual(
    capturedUrl?.searchParams.getAll("q_organization_domains_list[]"),
    ["synthetic.example"]
  );
  assert.equal(capturedUrl?.searchParams.get("per_page"), "2");
  assert.equal(capturedUrl?.searchParams.has("contact_email_status[]"), false);
  assert.equal(capturedInit?.method, "POST");
  assert.equal(capturedInit?.redirect, "error");
  const headers = new Headers(capturedInit?.headers);
  assert.equal(headers.get("x-api-key"), SYNTHETIC_API_KEY);
  assert.equal(headers.get("authorization"), null);
  assert.equal(capturedInit?.body, undefined);

  assert.deepEqual(result.usage, {
    amount: 1,
    basis: "exact",
    unit: "requests",
  });
  const output = result.providerPayload as Output;
  assert.equal(output.hasMore, false);
  assert.equal(output.nextCursor, null);
  assert.equal(output.sourcePartitionCompleted, true);
  assert.equal(output.items.length, 1);
  assert.match(output.items[0]?.contentHash ?? "", CONTENT_HASH_PATTERN);
  assert.match(output.items[0]?.record.recordId ?? "", CONTACT_ID_PATTERN);
  assert.deepEqual(output.items[0]?.providerIdentity, {
    providerKey: "apollo-people-search",
    providerSubjectId: "apollo_subject_0001",
  });
  assert.deepEqual(output.items[0]?.record.values, [
    { fieldId: "field-department", value: null },
    { fieldId: "field-display_name", value: "Synthetic Pe***n" },
    { fieldId: "field-identity_completeness", value: "obfuscated" },
    { fieldId: "field-job_title", value: "Sales Director" },
    { fieldId: "field-observed_at_ms", value: 1_782_907_200_000 },
    { fieldId: "field-organization_domain", value: "synthetic.example" },
    { fieldId: "field-organization_id", value: "company-synthetic" },
    { fieldId: "field-organization_name", value: "Synthetic Company" },
    { fieldId: "field-person_country_code", value: "FR" },
    { fieldId: "field-profile_url", value: null },
    { fieldId: "field-seniority", value: "director" },
  ]);
  const serializedOutput = JSON.stringify(output);
  assert.equal(
    JSON.stringify(output.items[0]?.record).includes("apollo_subject_0001"),
    false
  );
  assert.equal(serializedOutput.includes("full_name"), false);
  assert.equal(serializedOutput.includes("email"), false);
  assert.equal(serializedOutput.includes("phone"), false);
  assert.equal(serializedOutput.includes(SYNTHETIC_API_KEY), false);

  const normalized = await adapter.normalize({
    context,
    operationKey: "operation-apollo-contacts",
    outputContract: APOLLO_CONTACT_DISCOVERY_CONTRACTS.output,
    providerPayload: output,
  });
  assert.equal(normalized.status, "normalized");
});

test("uses exactly one bounded search per durable company page", async () => {
  const calls: URL[] = [];
  const adapter = createApolloProviderAdapter({
    apiKey: SYNTHETIC_API_KEY,
    clock: { now: () => 1000 },
    fetch: (input) => {
      const url = new URL(String(input));
      calls.push(url);
      const domain = url.searchParams.get("q_organization_domains_list[]");
      const name = domain === "one.example" ? "Company One" : "Company Two";
      const count = Number(url.searchParams.get("per_page"));
      return Promise.resolve(
        jsonResponse({
          people: Array.from({ length: count }, (_, index) =>
            apolloPerson(`subject_${calls.length}_${index}`, name)
          ),
          total_entries: 20,
        })
      );
    },
  });
  const value = pageInput({
    normalizedQuery: {
      company_headquarters_country_codes: [],
      departments: [],
      organization_generation_id: "organization-generation",
      organizations: [
        organization("company-one", "one.example", "Company One"),
        organization("company-two", "two.example", "Company Two"),
      ],
      person_country_codes: [],
      result_kind: "contact",
      seniorities: [],
      titles: [],
    },
  });

  const first = await adapter.execute(requestFor(value));
  assert.equal(first.status, "succeeded");
  if (first.status !== "succeeded") {
    assert.fail("Expected a successful bounded Apollo search.");
  }
  const firstOutput = first.providerPayload as Output;
  assert.equal(calls.length, 1);
  assert.equal(firstOutput.hasMore, true);
  assert.equal(firstOutput.nextCursor, "organization:1");
  assert.equal(firstOutput.sourcePartitionCompleted, false);
  assert.equal(firstOutput.items.length, 2);
  assert.deepEqual(first.usage, {
    amount: 1,
    basis: "exact",
    unit: "requests",
  });

  const secondValue = {
    ...value,
    inputCursor: "organization:1",
    limits: {
      ...(value.limits as Readonly<Record<string, number>>),
      maxResults: 1,
    },
    pageSequence: 2,
  };
  const second = await adapter.execute(requestFor(secondValue));
  assert.equal(second.status, "succeeded");
  if (second.status !== "succeeded") {
    assert.fail("Expected a successful second Apollo page.");
  }
  const secondOutput = second.providerPayload as Output;
  assert.equal(calls.length, 2);
  assert.deepEqual(
    calls.map((url) => url.searchParams.get("per_page")),
    ["2", "1"]
  );
  assert.equal(secondOutput.hasMore, false);
  assert.equal(secondOutput.nextCursor, null);
  assert.equal(secondOutput.sourcePartitionCompleted, true);
  assert.equal(secondOutput.items.length, 1);
  assert.deepEqual(second.usage, {
    amount: 1,
    basis: "exact",
    unit: "requests",
  });
});

test("drops a prefix-only current employer match", async () => {
  const adapter = createApolloProviderAdapter({
    apiKey: SYNTHETIC_API_KEY,
    clock: { now: () => 1000 },
    fetch: () =>
      Promise.resolve(
        jsonResponse({
          people: [
            apolloPerson(
              "apollo_subject_previous_employer",
              "Synthetic Company Ventures"
            ),
          ],
          total_entries: 1,
        })
      ),
  });

  const result = await adapter.execute(requestFor());
  assert.equal(result.status, "succeeded");
  if (result.status !== "succeeded") {
    assert.fail("Expected a certain empty Apollo page.");
  }
  assert.equal((result.providerPayload as Output).items.length, 0);
});

test("quotes and executes zero calls when every parent company lacks a domain", async () => {
  let calls = 0;
  const adapter = createApolloProviderAdapter({
    apiKey: SYNTHETIC_API_KEY,
    clock: { now: () => 1000 },
    fetch: () => {
      calls += 1;
      throw new Error("fetch must not run");
    },
  });
  const value = pageInput({
    normalizedQuery: {
      company_headquarters_country_codes: [],
      departments: [],
      organization_generation_id: "organization-generation",
      organizations: [
        organization("company-without-domain", null, "No Domain Company"),
      ],
      person_country_codes: [],
      result_kind: "contact",
      seniorities: [],
      titles: [],
    },
  });
  const estimate = await adapter.estimate(estimateRequestFor(value));
  assert.equal(estimate.status, "quoted");
  if (estimate.status === "quoted") {
    assert.equal(estimate.quote.upperBound, 0);
  }
  const result = await adapter.execute(requestFor(value, 0));
  assert.equal(result.status, "succeeded");
  if (result.status !== "succeeded") {
    assert.fail("Expected a terminal empty page.");
  }
  assert.equal(calls, 0);
  assert.deepEqual(result.usage, {
    amount: 0,
    basis: "exact",
    unit: "requests",
  });
  assert.equal((result.providerPayload as Output).items.length, 0);
});

test("rejects contact-detail fields and malformed provider payloads without leaking them", async () => {
  for (const extra of [
    { email: SYNTHETIC_EMAIL },
    { phone_number: SYNTHETIC_PHONE },
    { linkedin_url: "https://www.linkedin.com/in/private" },
  ]) {
    const adapter = createApolloProviderAdapter({
      apiKey: SYNTHETIC_API_KEY,
      clock: { now: () => 1000 },
      fetch: () =>
        Promise.resolve(
          jsonResponse({
            people: [
              apolloPerson(
                "apollo_subject_private",
                "Synthetic Company",
                extra
              ),
            ],
            total_entries: 1,
          })
        ),
    });
    const result = await adapter.execute(requestFor());
    assert.deepEqual(result, {
      error: {
        class: "response",
        reasonCode: "provider-response-invalid",
      },
      status: "outcome-unknown",
    });
    const serialized = JSON.stringify(result);
    assert.equal(serialized.includes(SYNTHETIC_EMAIL), false);
    assert.equal(serialized.includes(SYNTHETIC_PHONE), false);
    assert.equal(serialized.includes(SYNTHETIC_API_KEY), false);
  }
});

test("maps HTTP failures to stable redacted outcomes", async () => {
  for (const [status, errorClass, reasonCode] of [
    [401, "authentication", "authentication-failed"],
    [403, "authorization", "authorization-failed"],
    [422, "provider", "provider-rejected"],
    [429, "rate-limit", "rate-limited"],
    [503, "provider", "provider-unavailable"],
  ] as const) {
    const adapter = createApolloProviderAdapter({
      apiKey: SYNTHETIC_API_KEY,
      clock: { now: () => 1000 },
      fetch: () =>
        Promise.resolve(
          jsonResponse(
            { error: SYNTHETIC_EMAIL, phone: SYNTHETIC_PHONE },
            status
          )
        ),
    });
    const result = await adapter.execute(requestFor());
    assert.equal(result.status, "failed");
    if (result.status !== "failed") {
      assert.fail("Expected a definite HTTP failure.");
    }
    assert.equal(result.error.class, errorClass);
    assert.equal(result.error.reasonCode, reasonCode);
    assert.deepEqual(result.usage, {
      amount: 1,
      basis: "exact",
      unit: "requests",
    });
    const serialized = JSON.stringify(result);
    assert.equal(serialized.includes(SYNTHETIC_EMAIL), false);
    assert.equal(serialized.includes(SYNTHETIC_PHONE), false);
    assert.equal(serialized.includes(SYNTHETIC_API_KEY), false);
  }
});

test("aborts once at the execution deadline and never retries", async () => {
  let calls = 0;
  const adapter = createApolloProviderAdapter({
    apiKey: SYNTHETIC_API_KEY,
    clock: { now: () => 1000 },
    fetch: (_input, init) => {
      calls += 1;
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => reject(new DOMException("aborted", "AbortError")),
          { once: true }
        );
      });
    },
  });
  const request = requestFor();
  const result = await adapter.execute({
    ...request,
    context: { ...request.context, deadlineAtMs: 1001 },
    quote: { ...request.quote, expiresAtMs: 1001 },
  });
  assert.deepEqual(result, {
    error: { class: "deadline", reasonCode: "deadline-exceeded" },
    status: "outcome-unknown",
  });
  assert.equal(calls, 1);
});

test("rejects unsafe configuration, invalid caps, and an underquoted execution", async () => {
  assert.throws(
    () => createApolloProviderAdapter({ apiKey: ` ${SYNTHETIC_API_KEY}` }),
    (error: unknown) => {
      assert.equal(error instanceof ApolloProviderConfigurationError, true);
      assert.equal(
        JSON.stringify(error, Object.getOwnPropertyNames(error)).includes(
          SYNTHETIC_API_KEY
        ),
        false
      );
      return true;
    }
  );
  let calls = 0;
  const adapter = createApolloProviderAdapter({
    apiKey: SYNTHETIC_API_KEY,
    clock: { now: () => 1000 },
    fetch: () => {
      calls += 1;
      return Promise.resolve(jsonResponse({ people: [], total_entries: 0 }));
    },
  });
  const invalid = pageInput({
    limits: {
      maxCalls: 1,
      maxCompanies: 1,
      maxContactsPerCompany: 3,
      maxContactsTotal: 13,
      maxEnrichments: 0,
      maxPages: 1,
      maxPhones: 0,
      maxResults: 13,
    },
  });
  const estimate = await adapter.estimate(estimateRequestFor(invalid));
  assert.equal(estimate.status, "unavailable");
  for (const normalizedQuery of [
    {
      ...(pageInput().normalizedQuery as Readonly<Record<string, unknown>>),
      departments: ["sales"],
    },
    {
      ...(pageInput().normalizedQuery as Readonly<Record<string, unknown>>),
      seniorities: ["individual_contributor"],
    },
  ]) {
    const unsupported = await adapter.estimate(
      estimateRequestFor(pageInput({ normalizedQuery }))
    );
    assert.equal(unsupported.status, "unavailable");
  }
  const invalidCursor = await adapter.estimate(
    estimateRequestFor(
      pageInput({ inputCursor: "organization:1", pageSequence: 1 })
    )
  );
  assert.equal(invalidCursor.status, "unavailable");
  const underquoted = await adapter.execute(requestFor(pageInput(), 0));
  assert.equal(underquoted.status, "failed");
  if (underquoted.status === "failed") {
    assert.equal(underquoted.error.class, "quota");
    assert.equal(underquoted.error.reasonCode, "quota-exhausted");
  }
  assert.equal(calls, 0);
});

test("executes one selected identity page with coordinate flags disabled and restricted lineage", async () => {
  let capturedUrl: URL | undefined;
  let capturedInit: RequestInit | undefined;
  const rawCanary = "raw-apollo-coordinate-must-not-escape";
  const adapter = createApolloProviderAdapter({
    apiKey: SYNTHETIC_API_KEY,
    clock: { now: () => 1100 },
    fetch: (input, init) => {
      capturedUrl = new URL(String(input));
      capturedInit = init;
      return Promise.resolve(
        jsonResponse({
          email: SYNTHETIC_EMAIL,
          person: {
            contact: { email: SYNTHETIC_EMAIL, phone: SYNTHETIC_PHONE },
            email: SYNTHETIC_EMAIL,
            first_name: "Synthetic",
            id: "apollo_subject_0001",
            last_name: "Person",
            linkedin_url:
              "http://linkedin.com/in/synthetic-person?tracking=provider",
            personal_emails: [rawCanary],
            phone_numbers: [SYNTHETIC_PHONE],
          },
          request_id: rawCanary,
        })
      );
    },
  });
  const selection = [selectedIdentity("0001"), selectedIdentity("0002")];
  const value = identityPageInput(selection);

  const { manifest } = adapter.describe();
  const identityCapability = manifest.capabilities.find(
    (capability) =>
      capability.capabilityId ===
      APOLLO_CONTACT_IDENTITY_CAPABILITY.capabilityId
  );
  assert.deepEqual(
    identityCapability?.inputContract,
    APOLLO_CONTACT_IDENTITY_CONTRACTS.input
  );
  assert.deepEqual(
    identityCapability?.outputContract,
    APOLLO_CONTACT_IDENTITY_CONTRACTS.output
  );
  const estimate = await adapter.estimate(identityEstimateRequestFor(value));
  assert.equal(estimate.status, "quoted");
  if (estimate.status === "quoted") {
    assert.equal(estimate.quote.upperBound, 1);
  }

  const result = await adapter.execute(identityRequestFor(value));
  assert.equal(result.status, "succeeded");
  if (result.status !== "succeeded") {
    assert.fail("Expected a successful selected identity page.");
  }
  assert.ok(capturedUrl);
  assert.equal(
    capturedUrl.origin + capturedUrl.pathname,
    "https://api.apollo.io/api/v1/people/match"
  );
  assert.deepEqual([...capturedUrl.searchParams.entries()].sort(), [
    ["id", "apollo_subject_0001"],
    ["reveal_personal_emails", "false"],
    ["reveal_phone_number", "false"],
    ["run_waterfall_email", "false"],
    ["run_waterfall_phone", "false"],
  ]);
  assert.equal(capturedUrl.searchParams.has("webhook_url"), false);
  assert.equal(capturedInit?.body, undefined);
  assert.equal(capturedInit?.method, "POST");
  assert.deepEqual(result.usage, {
    amount: 1,
    basis: "exact",
    unit: "requests",
  });
  const output = result.providerPayload as IdentityOutput;
  assert.equal(output.hasMore, true);
  assert.equal(output.nextCursor, "contact:1");
  assert.equal(output.sourcePartitionCompleted, false);
  assert.equal(output.items.length, 1);
  assert.deepEqual(output.items[0]?.source, {
    datasetId: "contacts-source",
    recordId: "contact-source-0001",
  });
  assert.deepEqual(output.items[0]?.providerIdentity, {
    providerKey: "apollo-people-search",
    providerSubjectId: "apollo_subject_0001",
  });
  assert.equal(output.items[0]?.record.recordId, "contact-source-0001");
  assert.equal(identityValue(output, "display_name"), "Synthetic Person");
  assert.equal(identityValue(output, "first_name"), "Synthetic");
  assert.equal(identityValue(output, "last_name"), "Person");
  assert.equal(identityValue(output, "identity_completeness"), "full");
  assert.equal(identityValue(output, "identity_status"), "found");
  assert.equal(identityValue(output, "identity_observed_at_ms"), 1100);
  assert.equal(identityValue(output, "job_title"), "Sales Director");
  assert.equal(identityValue(output, "organization_name"), "Synthetic Company");
  assert.equal(
    identityValue(output, "profile_url"),
    "https://www.linkedin.com/in/synthetic-person"
  );
  const publicRecord = JSON.stringify(output.items[0]?.record);
  const serialized = JSON.stringify(output);
  assert.equal(publicRecord.includes("apollo_subject_0001"), false);
  assert.equal(serialized.includes(SYNTHETIC_EMAIL), false);
  assert.equal(serialized.includes(SYNTHETIC_PHONE), false);
  assert.equal(serialized.includes(rawCanary), false);
  assert.equal(serialized.includes(SYNTHETIC_API_KEY), false);

  const normalized = await adapter.normalize({
    context: identityContext,
    operationKey: "operation-apollo-contact-identity",
    outputContract: APOLLO_CONTACT_IDENTITY_CONTRACTS.output,
    providerPayload: output,
  });
  assert.equal(normalized.status, "normalized");
});

test("represents a certain identity no-result as one safe derived record", async () => {
  let requestedSubject: null | string = null;
  const adapter = createApolloProviderAdapter({
    apiKey: SYNTHETIC_API_KEY,
    clock: { now: () => 1200 },
    fetch: (input) => {
      requestedSubject = new URL(String(input)).searchParams.get("id");
      return Promise.resolve(
        jsonResponse({
          email: SYNTHETIC_EMAIL,
          person: null,
          phone: SYNTHETIC_PHONE,
        })
      );
    },
  });
  const selection = [selectedIdentity("0001"), selectedIdentity("0002")];
  const result = await adapter.execute(
    identityRequestFor(identityPageInput(selection, 1))
  );
  assert.equal(result.status, "succeeded");
  if (result.status !== "succeeded") {
    assert.fail("Expected a certain Apollo no-result page.");
  }
  assert.equal(requestedSubject, "apollo_subject_0002");
  const output = result.providerPayload as IdentityOutput;
  assert.equal(output.hasMore, false);
  assert.equal(output.nextCursor, null);
  assert.equal(output.sourcePartitionCompleted, true);
  assert.equal(output.items.length, 1);
  assert.equal(output.items[0]?.record.recordId, "contact-source-0002");
  assert.equal(identityValue(output, "identity_status"), "not_found");
  assert.equal(identityValue(output, "identity_completeness"), "obfuscated");
  assert.equal(identityValue(output, "display_name"), "Synthetic Pe***n 0002");
  assert.equal(identityValue(output, "first_name"), null);
  assert.equal(identityValue(output, "last_name"), null);
  assert.equal(identityValue(output, "profile_url"), null);
  assert.equal(identityValue(output, "identity_observed_at_ms"), 1200);
  const serialized = JSON.stringify(output);
  assert.equal(serialized.includes(SYNTHETIC_EMAIL), false);
  assert.equal(serialized.includes(SYNTHETIC_PHONE), false);
});

test("rejects hostile identity queries, oversized selections, invalid caps, and underquotes before fetch", async () => {
  let calls = 0;
  const adapter = createApolloProviderAdapter({
    apiKey: SYNTHETIC_API_KEY,
    clock: { now: () => 1000 },
    fetch: () => {
      calls += 1;
      return Promise.resolve(jsonResponse({ person: null }));
    },
  });
  const base = identityPageInput();
  const baseQuery = base.normalizedQuery as Readonly<Record<string, unknown>>;
  const baseSelection = baseQuery.selected_contacts as readonly Readonly<
    Record<string, unknown>
  >[];
  const first = baseSelection[0];
  assert.ok(first);
  const invalidValues = [
    identityPageInput([
      selectedIdentity("0001"),
      selectedIdentity("0002"),
      selectedIdentity("0003"),
      selectedIdentity("0004"),
    ]),
    identityPageInput(undefined, 0, {
      normalizedQuery: {
        ...baseQuery,
        provider_subject_id: "apollo_subject_injected",
      },
    }),
    identityPageInput(undefined, 0, {
      normalizedQuery: {
        ...baseQuery,
        selected_contacts: [
          {
            ...first,
            candidate: {
              ...(first.candidate as Readonly<Record<string, unknown>>),
              email: SYNTHETIC_EMAIL,
            },
          },
        ],
      },
    }),
    identityPageInput(undefined, 0, {
      normalizedQuery: {
        ...baseQuery,
        selected_contacts: [
          {
            ...first,
            provider_identity: {
              provider_key: "attacker",
              provider_subject_id: "apollo_subject_0001",
            },
          },
        ],
      },
    }),
    identityPageInput(undefined, 0, {
      limits: {
        ...(base.limits as Readonly<Record<string, number>>),
        maxPhones: 1,
      },
    }),
  ];
  for (const invalid of invalidValues) {
    const estimate = await adapter.estimate(
      identityEstimateRequestFor(invalid)
    );
    assert.equal(estimate.status, "unavailable");
  }
  const underquoted = await adapter.execute(identityRequestFor(base, 0));
  assert.equal(underquoted.status, "failed");
  if (underquoted.status === "failed") {
    assert.equal(underquoted.error.class, "quota");
  }
  assert.equal(calls, 0);
});

test("classifies selected identity transport and server uncertainty as ambiguous", async () => {
  for (const fetchImplementation of [
    () => Promise.reject(new Error(SYNTHETIC_EMAIL)),
    () =>
      Promise.resolve(
        jsonResponse({ email: SYNTHETIC_EMAIL, phone: SYNTHETIC_PHONE }, 503)
      ),
  ]) {
    const adapter = createApolloProviderAdapter({
      apiKey: SYNTHETIC_API_KEY,
      clock: { now: () => 1000 },
      fetch: fetchImplementation,
    });
    const result = await adapter.execute(identityRequestFor());
    assert.equal(result.status, "outcome-unknown");
    const serialized = JSON.stringify(result);
    assert.equal(serialized.includes(SYNTHETIC_EMAIL), false);
    assert.equal(serialized.includes(SYNTHETIC_PHONE), false);
  }

  const rejected = createApolloProviderAdapter({
    apiKey: SYNTHETIC_API_KEY,
    clock: { now: () => 1000 },
    fetch: () =>
      Promise.resolve(
        jsonResponse({ email: SYNTHETIC_EMAIL, phone: SYNTHETIC_PHONE }, 422)
      ),
  });
  const result = await rejected.execute(identityRequestFor());
  assert.equal(result.status, "failed");
  if (result.status === "failed") {
    assert.equal(result.error.class, "provider");
    assert.deepEqual(result.usage, {
      amount: 1,
      basis: "exact",
      unit: "requests",
    });
  }
});

test("reveals only selected professional identity with every coordinate flag disabled", async () => {
  let capturedUrl: URL | undefined;
  let capturedInit: RequestInit | undefined;
  const provider = createApolloContactIdentityProvider({
    apiKey: SYNTHETIC_API_KEY,
    clock: { now: () => 1100 },
    fetch: (input, init) => {
      capturedUrl = new URL(String(input));
      capturedInit = init;
      return Promise.resolve(
        jsonResponse({
          person: {
            contact: {
              email: SYNTHETIC_EMAIL,
              phone_numbers: [SYNTHETIC_PHONE],
            },
            email: SYNTHETIC_EMAIL,
            first_name: "Synthetic",
            id: "apollo_subject_0001",
            last_name: "Person",
            linkedin_url: "http://linkedin.com/in/synthetic-person?tracking=1",
            phone_numbers: [SYNTHETIC_PHONE],
          },
          request_id: "synthetic-request",
        })
      );
    },
  });

  const result = await provider.reveal({
    deadline: IDENTITY_DEADLINE,
    operationId: "identity-1",
    providerIdentity: {
      providerKey: "apollo-people-search",
      providerSubjectId: "apollo_subject_0001",
    },
  });

  assert.deepEqual(
    await provider.quote({
      deadline: IDENTITY_DEADLINE,
      operationId: "identity-quote",
      providerIdentity: {
        providerKey: "apollo-people-search",
        providerSubjectId: "apollo_subject_0001",
      },
    }),
    { guarantee: "hard", unit: "requests", upperBound: 1 }
  );

  assert.ok(capturedUrl);
  assert.equal(
    capturedUrl.origin + capturedUrl.pathname,
    "https://api.apollo.io/api/v1/people/match"
  );
  assert.deepEqual([...capturedUrl.searchParams.entries()].sort(), [
    ["id", "apollo_subject_0001"],
    ["reveal_personal_emails", "false"],
    ["reveal_phone_number", "false"],
    ["run_waterfall_email", "false"],
    ["run_waterfall_phone", "false"],
  ]);
  assert.equal(capturedUrl.searchParams.has("webhook_url"), false);
  assert.equal(capturedUrl.toString().includes(SYNTHETIC_API_KEY), false);
  assert.equal(capturedInit?.method, "POST");
  assert.equal(capturedInit?.body, undefined);
  assert.equal(
    new Headers(capturedInit?.headers).get("x-api-key"),
    SYNTHETIC_API_KEY
  );
  assert.deepEqual(result, {
    usage: { amount: 1, basis: "exact", unit: "requests" },
    value: {
      displayName: "Synthetic Person",
      firstName: "Synthetic",
      identityCompleteness: "full",
      lastName: "Person",
      observedAt: 1100,
      profileUrl: "https://www.linkedin.com/in/synthetic-person",
    },
  });
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes(SYNTHETIC_EMAIL), false);
  assert.equal(serialized.includes(SYNTHETIC_PHONE), false);
  assert.equal(serialized.includes("request_id"), false);
});

test("keeps Apollo identity no-result distinct and rejects mismatched identities", async () => {
  const noResult = createApolloContactIdentityProvider({
    apiKey: SYNTHETIC_API_KEY,
    fetch: () => Promise.resolve(jsonResponse({ person: null })),
  });
  assert.deepEqual(
    await noResult.reveal({
      deadline: IDENTITY_DEADLINE,
      operationId: "identity-none",
      providerIdentity: {
        providerKey: "apollo-people-search",
        providerSubjectId: "apollo_subject_none",
      },
    }),
    {
      usage: { amount: 1, basis: "exact", unit: "requests" },
      value: undefined,
    }
  );

  let calls = 0;
  const invalidInput = createApolloContactIdentityProvider({
    apiKey: SYNTHETIC_API_KEY,
    fetch: () => {
      calls += 1;
      return Promise.resolve(jsonResponse({ person: null }));
    },
  });
  await assert.rejects(
    invalidInput.reveal({
      deadline: IDENTITY_DEADLINE,
      operationId: "identity-invalid",
      providerIdentity: {
        providerKey: "fixture",
        providerSubjectId: "apollo_subject_0001",
      },
    }),
    (error: unknown) =>
      error instanceof ApolloContactIdentityProviderError &&
      error.reasonCode === "provider-identity-invalid"
  );
  assert.equal(calls, 0);

  const mismatch = createApolloContactIdentityProvider({
    apiKey: SYNTHETIC_API_KEY,
    fetch: () =>
      Promise.resolve(
        jsonResponse({
          person: {
            first_name: "Synthetic",
            id: "another_subject",
            last_name: "Person",
          },
        })
      ),
  });
  await assert.rejects(
    mismatch.reveal({
      deadline: IDENTITY_DEADLINE,
      operationId: "identity-mismatch",
      providerIdentity: {
        providerKey: "apollo-people-search",
        providerSubjectId: "apollo_subject_0001",
      },
    }),
    (error: unknown) =>
      error instanceof ApolloContactIdentityProviderError &&
      error.reasonCode === "provider-outcome-unknown"
  );
});

test("maps selected identity HTTP and transport failures to redacted reasons", async () => {
  for (const [status, reasonCode] of [
    [401, "authentication-failed"],
    [403, "authorization-failed"],
    [422, "provider-rejected"],
    [429, "provider-rate-limited"],
    [503, "provider-outcome-unknown"],
  ] as const) {
    const provider = createApolloContactIdentityProvider({
      apiKey: SYNTHETIC_API_KEY,
      fetch: () =>
        Promise.resolve(
          jsonResponse(
            { email: SYNTHETIC_EMAIL, phone: SYNTHETIC_PHONE },
            status
          )
        ),
    });
    await assert.rejects(
      provider.reveal({
        deadline: IDENTITY_DEADLINE,
        operationId: `identity-${status}`,
        providerIdentity: {
          providerKey: "apollo-people-search",
          providerSubjectId: "apollo_subject_0001",
        },
      }),
      (error: unknown) => {
        assert.equal(error instanceof ApolloContactIdentityProviderError, true);
        if (!(error instanceof ApolloContactIdentityProviderError)) {
          return false;
        }
        assert.equal(error.reasonCode, reasonCode);
        const serialized = JSON.stringify(
          error,
          Object.getOwnPropertyNames(error)
        );
        assert.equal(serialized.includes(SYNTHETIC_EMAIL), false);
        assert.equal(serialized.includes(SYNTHETIC_PHONE), false);
        assert.equal(serialized.includes(SYNTHETIC_API_KEY), false);
        return true;
      }
    );
  }

  const transport = createApolloContactIdentityProvider({
    apiKey: SYNTHETIC_API_KEY,
    fetch: () => Promise.reject(new Error(SYNTHETIC_EMAIL)),
  });
  await assert.rejects(
    transport.reveal({
      deadline: IDENTITY_DEADLINE,
      operationId: "identity-transport",
      providerIdentity: {
        providerKey: "apollo-people-search",
        providerSubjectId: "apollo_subject_0001",
      },
    }),
    (error: unknown) =>
      error instanceof ApolloContactIdentityProviderError &&
      error.reasonCode === "transport-outcome-unknown"
  );
});

test("bounds selected identity transport by the operation deadline without retry", async () => {
  let calls = 0;
  const provider = createApolloContactIdentityProvider({
    apiKey: SYNTHETIC_API_KEY,
    clock: { now: () => 1000 },
    fetch: (_input, init) => {
      calls += 1;
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => reject(new DOMException("aborted", "AbortError")),
          { once: true }
        );
      });
    },
  });

  await assert.rejects(
    provider.reveal({
      deadline: instant(1001),
      operationId: "identity-deadline",
      providerIdentity: {
        providerKey: "apollo-people-search",
        providerSubjectId: "apollo_subject_0001",
      },
    }),
    (error: unknown) =>
      error instanceof ApolloContactIdentityProviderError &&
      error.reasonCode === "transport-outcome-unknown"
  );
  assert.equal(calls, 1);
});
