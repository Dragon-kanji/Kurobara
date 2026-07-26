import assert from "node:assert/strict";
import test from "node:test";

import type {
  PluginEstimateRequest,
  PluginExecuteRequest,
} from "@kurobara/plugin-sdk";

import {
  createProspeoProviderAdapter,
  PROSPEO_CONTACT_DISCOVERY_CAPABILITY,
  PROSPEO_CONTACT_DISCOVERY_CONTRACTS,
  PROSPEO_CONTACT_IDENTITY_CAPABILITY,
  PROSPEO_CONTACT_IDENTITY_CONTRACTS,
  PROSPEO_WORK_EMAIL_CONTRACTS,
  PROSPEO_WORK_EMAIL_RESOLVE_CAPABILITY,
  ProspeoProviderConfigurationError,
} from "../src/index.ts";

const API_KEY = "synthetic-prospeo-key";
const EMAIL = "selected.person@synthetic.example";
const PHONE = "synthetic-phone.invalid";
const hash = (character: string): string => `sha256:${character.repeat(64)}`;

const discoveryDefinitions = [
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

const identityDefinitions = [
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

const workEmailDefinitions = [
  ...identityDefinitions,
  ["work_email", "Work email", "string"],
  ["work_email_confidence", "Work email confidence", "number"],
  ["work_email_observed_at_ms", "Work email observed", "number"],
  ["work_email_source", "Work email source", "string"],
  ["work_email_status", "Work email status", "string"],
  ["work_email_verification", "Work email verification", "string"],
] as const;

const fieldsFor = (
  datasetId: string,
  definitions: readonly (readonly [string, string, "number" | "string"])[]
) =>
  definitions.map(([key, label, valueType]) => ({
    datasetId,
    fieldId: `${datasetId}-${key}`,
    key,
    label,
    valueType,
    workspaceId: "workspace",
  }));

const organization = (id: string, domain: null | string, name: string) => ({
  company_id: id,
  country_code: "ES",
  domain,
  name,
});

const indexedOrganization = (index: number) => {
  if (index === 0) {
    return organization("company-0", "synthetic.example", "Synthetic Company");
  }
  if (index === 1) {
    return organization("company-1", "second.example", "Second Company");
  }
  return organization(
    `company-${index}`,
    `company-${index}.example`,
    `Company ${index}`
  );
};

const discoveryInput = (
  overrides: Readonly<Record<string, unknown>> = {}
): Readonly<Record<string, unknown>> => ({
  capability: PROSPEO_CONTACT_DISCOVERY_CAPABILITY,
  datasetId: "contacts",
  fields: fieldsFor("contacts", discoveryDefinitions),
  generationId: "generation-contacts",
  generationPlanId: "plan-contacts",
  inputCursor: null,
  kind: "dataset-generation-page-input",
  limits: {
    maxCalls: 4,
    maxCompanies: 10,
    maxContactsPerCompany: 2,
    maxContactsTotal: 12,
    maxEnrichments: 0,
    maxPages: 4,
    maxPhones: 0,
    maxResults: 12,
  },
  normalizedQuery: {
    company_headquarters_country_codes: ["ES"],
    departments: ["sales"],
    organization_generation_id: "organization-generation",
    organizations: [
      organization(
        "company-synthetic",
        "synthetic.example",
        "Synthetic Company"
      ),
      organization("company-second", "second.example", "Second Company"),
    ],
    person_country_codes: ["FR"],
    result_kind: "contact",
    seniorities: ["individual_contributor"],
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

const shortlistCandidate = {
  department: null,
  display_name: "Synthetic P*****",
  identity_completeness: "obfuscated",
  job_title: "Sales Director",
  observed_at_ms: 1000,
  organization_domain: "synthetic.example",
  organization_id: "company-synthetic",
  organization_name: "Synthetic Company",
  person_country_code: "FR",
  profile_url: null,
  seniority: "individual_contributor",
} as const;

const fullCandidate = {
  ...shortlistCandidate,
  display_name: "Synthetic Person",
  identity_completeness: "full",
  profile_url: "https://www.linkedin.com/in/synthetic-person",
} as const;

const providerIdentity = {
  provider_key: "prospeo-person-search",
  provider_subject_id: "prospeo_person_0001",
} as const;

const selectedIdentity = {
  candidate: shortlistCandidate,
  provider_identity: providerIdentity,
  source_record_id: "contact-source-0001",
} as const;

const selectedWorkEmail = {
  candidate: fullCandidate,
  identity: {
    display_name: "Synthetic Person",
    first_name: "Synthetic",
    last_name: "Person",
    observed_at_ms: 1100,
    profile_url: "https://www.linkedin.com/in/synthetic-person",
  },
  provider_identity: providerIdentity,
  source_record_id: "contact-source-0001",
} as const;

const selectedInput = (
  kind: "identity" | "work-email",
  selection: readonly Readonly<Record<string, unknown>>[],
  overrides: Readonly<Record<string, unknown>> = {}
): Readonly<Record<string, unknown>> => {
  const identity = kind === "identity";
  const datasetId = identity ? "contacts-identity" : "contacts-work-email";
  return {
    capability: identity
      ? PROSPEO_CONTACT_IDENTITY_CAPABILITY
      : PROSPEO_WORK_EMAIL_RESOLVE_CAPABILITY,
    datasetId,
    fields: fieldsFor(
      datasetId,
      identity ? identityDefinitions : workEmailDefinitions
    ),
    generationId: `generation-${datasetId}`,
    generationPlanId: `plan-${datasetId}`,
    inputCursor: null,
    kind: "dataset-generation-page-input",
    limits: {
      maxCalls: selection.length,
      maxCompanies: 0,
      maxContactsPerCompany: 0,
      maxContactsTotal: selection.length,
      maxEnrichments: selection.length,
      maxPages: selection.length,
      maxPhones: 0,
      maxResults: selection.length,
    },
    normalizedQuery: identity
      ? {
          result_kind: "contact_identity",
          selected_contacts: selection,
          source_dataset_id: "contacts-source",
        }
      : {
          operation_kind: "resolve",
          result_kind: "contact_work_email",
          selected_contacts: selection,
          source_dataset_id: "contacts-identity-source",
        },
    pageSequence: 1,
    planHash: hash("d"),
    queryHash: hash("e"),
    schemaHash: hash("f"),
    version: "1.0.0",
    workspaceId: "workspace",
    ...overrides,
  };
};

const contextFor = (
  capability: Readonly<{ capabilityId: string; capabilityVersion: string }>
) => ({
  capability,
  configuration: { contentHash: hash("0"), value: {} },
  deadlineAtMs: 10_000,
});

const requestFor = (
  capability: Readonly<{ capabilityId: string; capabilityVersion: string }>,
  contract: typeof PROSPEO_CONTACT_DISCOVERY_CONTRACTS,
  value: Readonly<Record<string, unknown>>,
  upperBound = 1
): PluginExecuteRequest => ({
  context: contextFor(capability),
  costLimit: { amount: upperBound, unit: "requests" },
  input: {
    contentHash: hash("1"),
    contract: contract.input,
    sizeBytes: new TextEncoder().encode(JSON.stringify(value)).byteLength,
    value,
  },
  operationKey: `operation-${capability.capabilityId}`,
  quote: {
    expiresAtMs: 10_000,
    guarantee: "hard",
    pricingVersion: "1.0.0",
    unit: "requests",
    upperBound,
  },
});

const estimateFor = (
  capability: Readonly<{ capabilityId: string; capabilityVersion: string }>,
  contract: typeof PROSPEO_CONTACT_DISCOVERY_CONTRACTS,
  value: Readonly<Record<string, unknown>>
): PluginEstimateRequest => ({
  context: contextFor(capability),
  input: {
    contentHash: hash("2"),
    contract: contract.input,
    sizeBytes: new TextEncoder().encode(JSON.stringify(value)).byteLength,
    value,
  },
});

const jsonResponse = (value: unknown, status = 200): Response =>
  new Response(JSON.stringify(value), {
    headers: { "content-type": "application/json" },
    status,
  });

const searchPerson = (
  id: string,
  overrides: Readonly<Record<string, unknown>> = {}
) => ({
  current_job_title: "Sales Director",
  email: {
    email: "s********@synthetic.example",
    revealed: false,
    status: "VERIFIED",
  },
  first_name: "Synthetic",
  last_name: "Person",
  linkedin_url: "https://www.linkedin.com/in/synthetic-person",
  location: { country_code: "FR" },
  mobile: { mobile: "+33 * ** ** ** **", revealed: false, status: "VERIFIED" },
  person_id: id,
  ...overrides,
});

const searchResponse = (
  results: readonly unknown[],
  page = 1,
  totalCount = results.length
) => ({
  error: false,
  free: false,
  pagination: {
    current_page: page,
    per_page: 25,
    total_count: totalCount,
    total_page: Math.ceil(totalCount / 25),
  },
  results,
});

const searchResult = (
  person: unknown,
  domain = "synthetic.example",
  name = "Synthetic Company"
) => ({ company: { domain, name }, person });

const enrichResponse = (
  person: null | Readonly<Record<string, unknown>>,
  company: null | Readonly<Record<string, unknown>> = {
    domain: "synthetic.example",
    name: "Synthetic Company",
  }
) => ({ company, error: false, free_enrichment: false, person });

type Output = Readonly<{
  hasMore: boolean;
  items: readonly Readonly<{
    providerIdentity: Readonly<{
      providerKey: string;
      providerSubjectId: string;
    }>;
    record: Readonly<{
      recordId: string;
      values: readonly Readonly<{ fieldId: string; value: unknown }>[];
    }>;
    source?: Readonly<{ datasetId: string; recordId: string }>;
  }>[];
  nextCursor: null | string;
  sourcePartitionCompleted: boolean;
}>;

const valueFor = (output: Output, datasetId: string, key: string): unknown =>
  output.items[0]?.record.values.find(
    (entry) => entry.fieldId === `${datasetId}-${key}`
  )?.value;

test("searches the immutable company websites with Prospeo filters and emits a coordinate-free shortlist", async () => {
  let capturedUrl = "";
  let capturedInit: RequestInit | undefined;
  const adapter = createProspeoProviderAdapter({
    apiKey: API_KEY,
    clock: { now: () => 1000 },
    fetch: (input, init) => {
      capturedUrl = String(input);
      capturedInit = init;
      return Promise.resolve(
        jsonResponse(
          searchResponse([searchResult(searchPerson("prospeo_person_0001"))])
        )
      );
    },
  });

  const { manifest } = adapter.describe();
  assert.equal(manifest.id, "dev.kurobara.provider-prospeo");
  assert.equal(manifest.execution.timeouts.executeMs, 10_000);
  assert.deepEqual(manifest.permissions.egress.hosts, ["api.prospeo.io"]);
  assert.deepEqual(
    manifest.capabilities.map((capability) => capability.capabilityId),
    [
      "contacts.discover",
      "contacts.identity.reveal",
      "contacts.work-email.resolve",
    ]
  );
  const estimate = await adapter.estimate(
    estimateFor(
      PROSPEO_CONTACT_DISCOVERY_CAPABILITY,
      PROSPEO_CONTACT_DISCOVERY_CONTRACTS,
      discoveryInput()
    )
  );
  assert.equal(estimate.status, "quoted");
  if (estimate.status === "quoted") {
    assert.equal(estimate.quote.upperBound, 1);
  }

  const result = await adapter.execute(
    requestFor(
      PROSPEO_CONTACT_DISCOVERY_CAPABILITY,
      PROSPEO_CONTACT_DISCOVERY_CONTRACTS,
      discoveryInput()
    )
  );
  assert.equal(result.status, "succeeded");
  if (result.status !== "succeeded") {
    assert.fail("Expected Prospeo discovery success.");
  }
  assert.equal(capturedUrl, "https://api.prospeo.io/search-person");
  assert.equal(capturedInit?.method, "POST");
  assert.equal(capturedInit?.redirect, "error");
  const headers = new Headers(capturedInit?.headers);
  assert.equal(headers.get("x-key"), API_KEY);
  assert.equal(headers.get("x-api-key"), null);
  assert.equal(headers.get("content-type"), "application/json");
  assert.deepEqual(JSON.parse(String(capturedInit?.body)), {
    filters: {
      company: {
        websites: { include: ["synthetic.example", "second.example"] },
      },
      company_location_search: { include: ["Spain"] },
      max_person_per_company: 2,
      person_contact_details: {
        email: ["VERIFIED"],
        hide_people_with_details_already_revealed: true,
      },
      person_department: { include: ["Sales"] },
      person_job_title: { include: ["Sales Director"], match_mode: "EXACT" },
      person_location_search: { include: ["France"] },
      person_seniority: { include: ["Entry"] },
    },
    page: 1,
  });
  assert.deepEqual(result.usage, {
    amount: 1,
    basis: "exact",
    unit: "requests",
  });
  const output = result.providerPayload as Output;
  assert.equal(output.hasMore, false);
  assert.equal(output.items.length, 1);
  assert.deepEqual(output.items[0]?.providerIdentity, {
    providerKey: "prospeo-person-search",
    providerSubjectId: "prospeo_person_0001",
  });
  assert.equal(
    valueFor(output, "contacts", "display_name"),
    "Synthetic P*****"
  );
  assert.equal(
    valueFor(output, "contacts", "identity_completeness"),
    "obfuscated"
  );
  assert.equal(valueFor(output, "contacts", "profile_url"), null);
  const publicRecord = JSON.stringify(output.items[0]?.record);
  assert.equal(publicRecord.includes("prospeo_person_0001"), false);
  assert.equal(publicRecord.includes("Person"), false);
  assert.equal(publicRecord.includes("email"), false);
  assert.equal(publicRecord.includes("mobile"), false);
  assert.equal(publicRecord.includes(PHONE), false);
  const normalized = await adapter.normalize({
    context: contextFor(PROSPEO_CONTACT_DISCOVERY_CAPABILITY),
    operationKey: "operation-discovery",
    outputContract: PROSPEO_CONTACT_DISCOVERY_CONTRACTS.output,
    providerPayload: output,
  });
  assert.equal(normalized.status, "normalized");
});

test("uses fixed 25-result provider pages and terminates once the Kurobara contact cap is filled", async () => {
  const bodies: unknown[] = [];
  const adapter = createProspeoProviderAdapter({
    apiKey: API_KEY,
    clock: { now: () => 1000 },
    fetch: (_input, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      const results = Array.from({ length: 12 }, (_, index) =>
        searchResult(
          searchPerson(`subject_${index}`),
          index % 2 === 0 ? "synthetic.example" : "second.example",
          index % 2 === 0 ? "Synthetic Company" : "Second Company"
        )
      );
      return Promise.resolve(jsonResponse(searchResponse(results, 1, 50)));
    },
  });
  const value = discoveryInput({
    limits: {
      maxCalls: 4,
      maxCompanies: 10,
      maxContactsPerCompany: 2,
      maxContactsTotal: 12,
      maxEnrichments: 0,
      maxPages: 4,
      maxPhones: 0,
      maxResults: 12,
    },
    normalizedQuery: {
      ...(discoveryInput().normalizedQuery as Readonly<
        Record<string, unknown>
      >),
      organizations: Array.from({ length: 10 }, (_, index) =>
        indexedOrganization(index)
      ),
    },
  });
  const result = await adapter.execute(
    requestFor(
      PROSPEO_CONTACT_DISCOVERY_CAPABILITY,
      PROSPEO_CONTACT_DISCOVERY_CONTRACTS,
      value
    )
  );
  // Six records per company violates max_person_per_company, so the provider
  // payload itself is rejected rather than silently truncating a biased page.
  assert.equal(result.status, "outcome-unknown");

  const cappedAdapter = createProspeoProviderAdapter({
    apiKey: API_KEY,
    clock: { now: () => 1000 },
    fetch: (_input, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      const domains = [
        ["synthetic.example", "Synthetic Company"],
        ["second.example", "Second Company"],
        ["company-2.example", "Company 2"],
        ["company-3.example", "Company 3"],
        ["company-4.example", "Company 4"],
        ["company-5.example", "Company 5"],
        ["company-6.example", "Company 6"],
        ["company-7.example", "Company 7"],
        ["company-8.example", "Company 8"],
        ["company-9.example", "Company 9"],
      ] as const;
      return Promise.resolve(
        jsonResponse(
          searchResponse(
            domains.flatMap(([domain, name], companyIndex) =>
              [0, 1].map((index) =>
                searchResult(
                  searchPerson(`person_${companyIndex}_${index}`),
                  domain,
                  name
                )
              )
            ),
            1,
            50
          )
        )
      );
    },
  });
  const capped = await cappedAdapter.execute(
    requestFor(
      PROSPEO_CONTACT_DISCOVERY_CAPABILITY,
      PROSPEO_CONTACT_DISCOVERY_CONTRACTS,
      value
    )
  );
  assert.equal(capped.status, "succeeded");
  if (capped.status === "succeeded") {
    const output = capped.providerPayload as Output;
    assert.equal(output.items.length, 12);
    assert.equal(output.hasMore, false);
    assert.equal(output.nextCursor, null);
    assert.equal(output.sourcePartitionCompleted, true);
  }
  assert.deepEqual(bodies.at(-1), {
    filters: {
      company: {
        websites: {
          include: [
            "synthetic.example",
            "second.example",
            "company-2.example",
            "company-3.example",
            "company-4.example",
            "company-5.example",
            "company-6.example",
            "company-7.example",
            "company-8.example",
            "company-9.example",
          ],
        },
      },
      company_location_search: { include: ["Spain"] },
      max_person_per_company: 2,
      person_contact_details: {
        email: ["VERIFIED"],
        hide_people_with_details_already_revealed: true,
      },
      person_department: { include: ["Sales"] },
      person_job_title: { include: ["Sales Director"], match_mode: "EXACT" },
      person_location_search: { include: ["France"] },
      person_seniority: { include: ["Entry"] },
    },
    page: 1,
  });
});

test("translates Prospeo page numbers into opaque Kurobara cursors", async () => {
  const requestedPages: number[] = [];
  const adapter = createProspeoProviderAdapter({
    apiKey: API_KEY,
    clock: { now: () => 1000 },
    fetch: (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { page: number };
      requestedPages.push(body.page);
      return Promise.resolve(
        jsonResponse(
          searchResponse(
            [
              searchResult(
                searchPerson(`person_page_${body.page}`),
                "synthetic.example",
                "Synthetic Company"
              ),
            ],
            body.page,
            50
          )
        )
      );
    },
  });
  const firstInput = discoveryInput();
  const first = await adapter.execute(
    requestFor(
      PROSPEO_CONTACT_DISCOVERY_CAPABILITY,
      PROSPEO_CONTACT_DISCOVERY_CONTRACTS,
      firstInput
    )
  );
  assert.equal(first.status, "succeeded");
  if (first.status !== "succeeded") {
    assert.fail("Expected the first Prospeo page.");
  }
  assert.equal((first.providerPayload as Output).nextCursor, "page:2");
  const secondInput = {
    ...firstInput,
    inputCursor: "page:2",
    pageSequence: 2,
  };
  const second = await adapter.execute(
    requestFor(
      PROSPEO_CONTACT_DISCOVERY_CAPABILITY,
      PROSPEO_CONTACT_DISCOVERY_CONTRACTS,
      secondInput
    )
  );
  assert.equal(second.status, "succeeded");
  if (second.status === "succeeded") {
    assert.equal((second.providerPayload as Output).nextCursor, null);
  }
  assert.deepEqual(requestedPages, [1, 2]);
});

test("rejects unsafe discovery limits and cursor drift while dropping coordinate incidents", async () => {
  let calls = 0;
  const adapter = createProspeoProviderAdapter({
    apiKey: API_KEY,
    clock: { now: () => 1000 },
    fetch: () => {
      calls += 1;
      return Promise.resolve(jsonResponse(searchResponse([])));
    },
  });
  for (const invalid of [
    discoveryInput({
      limits: {
        maxCalls: 1,
        maxCompanies: 11,
        maxContactsPerCompany: 2,
        maxContactsTotal: 12,
        maxEnrichments: 0,
        maxPages: 1,
        maxPhones: 0,
        maxResults: 12,
      },
    }),
    discoveryInput({
      limits: {
        maxCalls: 1,
        maxCompanies: 10,
        maxContactsPerCompany: 3,
        maxContactsTotal: 12,
        maxEnrichments: 0,
        maxPages: 1,
        maxPhones: 0,
        maxResults: 12,
      },
    }),
    discoveryInput({
      limits: {
        maxCalls: 1,
        maxCompanies: 10,
        maxContactsPerCompany: 2,
        maxContactsTotal: 13,
        maxEnrichments: 0,
        maxPages: 1,
        maxPhones: 0,
        maxResults: 13,
      },
    }),
    discoveryInput({ inputCursor: "page:2", pageSequence: 1 }),
    discoveryInput({
      normalizedQuery: {
        ...(discoveryInput().normalizedQuery as Readonly<
          Record<string, unknown>
        >),
        departments: ["not_a_prospeo_department"],
      },
    }),
  ]) {
    const estimate = await adapter.estimate(
      estimateFor(
        PROSPEO_CONTACT_DISCOVERY_CAPABILITY,
        PROSPEO_CONTACT_DISCOVERY_CONTRACTS,
        invalid
      )
    );
    assert.equal(estimate.status, "unavailable");
  }
  const underquoted = await adapter.execute(
    requestFor(
      PROSPEO_CONTACT_DISCOVERY_CAPABILITY,
      PROSPEO_CONTACT_DISCOVERY_CONTRACTS,
      discoveryInput(),
      0
    )
  );
  assert.equal(underquoted.status, "failed");
  assert.equal(calls, 0);

  for (const incident of [
    searchPerson("incident_email", {
      email: { email: EMAIL, revealed: true, status: "VERIFIED" },
    }),
    searchPerson("incident_mobile", {
      mobile: { mobile: PHONE, revealed: true, status: "VERIFIED" },
    }),
  ]) {
    const incidentAdapter = createProspeoProviderAdapter({
      apiKey: API_KEY,
      clock: { now: () => 1000 },
      fetch: () =>
        Promise.resolve(jsonResponse(searchResponse([searchResult(incident)]))),
    });
    const result = await incidentAdapter.execute(
      requestFor(
        PROSPEO_CONTACT_DISCOVERY_CAPABILITY,
        PROSPEO_CONTACT_DISCOVERY_CONTRACTS,
        discoveryInput()
      )
    );
    assert.equal(result.status, "succeeded");
    if (result.status === "succeeded") {
      assert.equal((result.providerPayload as Output).items.length, 0);
    }
    assert.equal(JSON.stringify(result).includes(EMAIL), false);
    assert.equal(JSON.stringify(result).includes(PHONE), false);
  }

  const mismatchAdapter = createProspeoProviderAdapter({
    apiKey: API_KEY,
    clock: { now: () => 1000 },
    fetch: () =>
      Promise.resolve(
        jsonResponse(
          searchResponse([
            searchResult(
              searchPerson("mismatch"),
              "synthetic.example",
              "Different Company"
            ),
          ])
        )
      ),
  });
  const mismatch = await mismatchAdapter.execute(
    requestFor(
      PROSPEO_CONTACT_DISCOVERY_CAPABILITY,
      PROSPEO_CONTACT_DISCOVERY_CONTRACTS,
      discoveryInput()
    )
  );
  assert.equal(mismatch.status, "succeeded");
  if (mismatch.status === "succeeded") {
    assert.equal(
      valueFor(
        mismatch.providerPayload as Output,
        "contacts",
        "organization_name"
      ),
      "Synthetic Company"
    );
  }
});

test("reveals one selected identity with mobile disabled and never materializes incidental email", async () => {
  let capturedInit: RequestInit | undefined;
  const rawCanary = "identity-email-canary";
  const adapter = createProspeoProviderAdapter({
    apiKey: API_KEY,
    clock: { now: () => 1100 },
    fetch: (input, init) => {
      assert.equal(String(input), "https://api.prospeo.io/enrich-person");
      capturedInit = init;
      return Promise.resolve(
        jsonResponse(
          enrichResponse(
            {
              email: {
                email: EMAIL,
                revealed: true,
                status: "VERIFIED",
                verification_method: rawCanary,
              },
              first_name: "Synthetic",
              last_name: "Person",
              linkedin_url:
                "http://linkedin.com/in/synthetic-person?tracking=provider",
              mobile: {
                mobile: "+33 * ** ** ** **",
                revealed: false,
                status: "VERIFIED",
              },
              person_id: "prospeo_person_0001",
            },
            { domain: "current-company.example", name: "Current Company" }
          )
        )
      );
    },
  });
  const value = selectedInput("identity", [selectedIdentity]);
  const providerMismatch = selectedInput("identity", [
    {
      ...selectedIdentity,
      provider_identity: {
        ...providerIdentity,
        provider_key: "apollo-people-search",
      },
    },
  ]);
  const mismatchEstimate = await adapter.estimate(
    estimateFor(
      PROSPEO_CONTACT_IDENTITY_CAPABILITY,
      PROSPEO_CONTACT_IDENTITY_CONTRACTS,
      providerMismatch
    )
  );
  assert.equal(mismatchEstimate.status, "unavailable");
  const estimate = await adapter.estimate(
    estimateFor(
      PROSPEO_CONTACT_IDENTITY_CAPABILITY,
      PROSPEO_CONTACT_IDENTITY_CONTRACTS,
      value
    )
  );
  assert.equal(estimate.status, "quoted");
  if (estimate.status === "quoted") {
    assert.equal(estimate.quote.upperBound, 1);
  }
  const result = await adapter.execute(
    requestFor(
      PROSPEO_CONTACT_IDENTITY_CAPABILITY,
      PROSPEO_CONTACT_IDENTITY_CONTRACTS,
      value
    )
  );
  assert.equal(result.status, "succeeded");
  if (result.status !== "succeeded") {
    assert.fail("Expected selected identity success.");
  }
  assert.equal(new Headers(capturedInit?.headers).get("x-key"), API_KEY);
  assert.deepEqual(JSON.parse(String(capturedInit?.body)), {
    data: { person_id: "prospeo_person_0001" },
    enrich_mobile: false,
    only_verified_email: false,
  });
  const output = result.providerPayload as Output;
  assert.deepEqual(output.items[0]?.source, {
    datasetId: "contacts-source",
    recordId: "contact-source-0001",
  });
  assert.equal(
    valueFor(output, "contacts-identity", "display_name"),
    "Synthetic Person"
  );
  assert.equal(
    valueFor(output, "contacts-identity", "first_name"),
    "Synthetic"
  );
  assert.equal(valueFor(output, "contacts-identity", "last_name"), "Person");
  assert.equal(
    valueFor(output, "contacts-identity", "identity_completeness"),
    "full"
  );
  assert.equal(
    valueFor(output, "contacts-identity", "identity_status"),
    "found"
  );
  assert.equal(
    valueFor(output, "contacts-identity", "profile_url"),
    "https://www.linkedin.com/in/synthetic-person"
  );
  const serialized = JSON.stringify(output);
  assert.equal(serialized.includes(EMAIL), false);
  assert.equal(serialized.includes(rawCanary), false);
  assert.equal(serialized.includes("work_email"), false);
  assert.deepEqual(result.usage, {
    amount: 1,
    basis: "exact",
    unit: "requests",
  });
});

test("resolves only a verified selected work email and rejects mobile, off-domain, or person mismatches", async () => {
  let capturedInit: RequestInit | undefined;
  const adapter = createProspeoProviderAdapter({
    apiKey: API_KEY,
    clock: { now: () => 1200 },
    fetch: (input, init) => {
      assert.equal(String(input), "https://api.prospeo.io/enrich-person");
      capturedInit = init;
      return Promise.resolve(
        jsonResponse(
          enrichResponse({
            email: {
              confidence: 0.98,
              email: EMAIL,
              revealed: true,
              status: "VERIFIED",
            },
            first_name: "Synthetic",
            last_name: "Person",
            linkedin_url: "https://www.linkedin.com/in/synthetic-person",
            mobile: {
              mobile: "+33 * ** ** ** **",
              revealed: false,
              status: "VERIFIED",
            },
            person_id: "prospeo_person_0001",
          })
        )
      );
    },
  });
  const value = selectedInput("work-email", [selectedWorkEmail]);
  const result = await adapter.execute(
    requestFor(
      PROSPEO_WORK_EMAIL_RESOLVE_CAPABILITY,
      PROSPEO_WORK_EMAIL_CONTRACTS,
      value
    )
  );
  assert.equal(result.status, "succeeded");
  if (result.status !== "succeeded") {
    assert.fail("Expected selected work email success.");
  }
  assert.deepEqual(JSON.parse(String(capturedInit?.body)), {
    data: { person_id: "prospeo_person_0001" },
    enrich_mobile: false,
    only_verified_email: true,
  });
  const output = result.providerPayload as Output;
  assert.equal(valueFor(output, "contacts-work-email", "work_email"), EMAIL);
  assert.equal(
    valueFor(output, "contacts-work-email", "work_email_confidence"),
    0.98
  );
  assert.equal(
    valueFor(output, "contacts-work-email", "work_email_status"),
    "found"
  );
  assert.equal(
    valueFor(output, "contacts-work-email", "work_email_verification"),
    "valid"
  );
  assert.equal(JSON.stringify(output).includes(PHONE), false);
  assert.deepEqual(result.usage, {
    amount: 1,
    basis: "exact",
    unit: "requests",
  });

  const alternateDomainAdapter = createProspeoProviderAdapter({
    apiKey: API_KEY,
    clock: { now: () => 1200 },
    fetch: () =>
      Promise.resolve(
        jsonResponse(
          enrichResponse(
            {
              email: {
                email: "person@alternate.example",
                revealed: true,
                status: "VERIFIED",
              },
              mobile: null,
              person_id: "prospeo_person_0001",
            },
            {
              domain: "alternate.example",
              name: "Synthetic Company",
              website: "https://synthetic.example/",
            }
          )
        )
      ),
  });
  const alternateDomain = await alternateDomainAdapter.execute(
    requestFor(
      PROSPEO_WORK_EMAIL_RESOLVE_CAPABILITY,
      PROSPEO_WORK_EMAIL_CONTRACTS,
      value
    )
  );
  assert.equal(alternateDomain.status, "succeeded");
  if (alternateDomain.status === "succeeded") {
    assert.equal(
      valueFor(
        alternateDomain.providerPayload as Output,
        "contacts-work-email",
        "work_email"
      ),
      "person@alternate.example"
    );
  }

  const absentCompanyAdapter = createProspeoProviderAdapter({
    apiKey: API_KEY,
    clock: { now: () => 1200 },
    fetch: () =>
      Promise.resolve(
        jsonResponse(
          enrichResponse(
            {
              email: { email: EMAIL, revealed: true, status: "VERIFIED" },
              mobile: null,
              person_id: "prospeo_person_0001",
            },
            null
          )
        )
      ),
  });
  const absentCompany = await absentCompanyAdapter.execute(
    requestFor(
      PROSPEO_WORK_EMAIL_RESOLVE_CAPABILITY,
      PROSPEO_WORK_EMAIL_CONTRACTS,
      value
    )
  );
  assert.equal(absentCompany.status, "succeeded");
  if (absentCompany.status === "succeeded") {
    assert.equal(
      valueFor(
        absentCompany.providerPayload as Output,
        "contacts-work-email",
        "work_email"
      ),
      EMAIL
    );
  }

  const contradictoryCompanyAdapter = createProspeoProviderAdapter({
    apiKey: API_KEY,
    clock: { now: () => 1200 },
    fetch: () =>
      Promise.resolve(
        jsonResponse(
          enrichResponse(
            {
              email: { email: EMAIL, revealed: true, status: "VERIFIED" },
              mobile: null,
              person_id: "prospeo_person_0001",
            },
            { domain: "new-employer.example", name: "New Employer" }
          )
        )
      ),
  });
  const contradictoryCompany = await contradictoryCompanyAdapter.execute(
    requestFor(
      PROSPEO_WORK_EMAIL_RESOLVE_CAPABILITY,
      PROSPEO_WORK_EMAIL_CONTRACTS,
      value
    )
  );
  assert.deepEqual(contradictoryCompany, {
    error: { class: "response", reasonCode: "provider-response-invalid" },
    status: "outcome-unknown",
  });

  for (const person of [
    {
      email: { email: EMAIL, revealed: true, status: "VERIFIED" },
      mobile: { mobile: PHONE, revealed: true, status: "VERIFIED" },
      person_id: "prospeo_person_0001",
    },
    {
      email: {
        email: "person@other.example",
        revealed: true,
        status: "VERIFIED",
      },
      mobile: null,
      person_id: "prospeo_person_0001",
    },
    {
      email: {
        email: "selected.******@synthetic.example",
        revealed: true,
        status: "VERIFIED",
      },
      mobile: null,
      person_id: "prospeo_person_0001",
    },
    {
      email: { email: EMAIL, revealed: true, status: "VERIFIED" },
      mobile: null,
      person_id: "different_person",
    },
  ]) {
    const rejectedAdapter = createProspeoProviderAdapter({
      apiKey: API_KEY,
      clock: { now: () => 1200 },
      fetch: () => Promise.resolve(jsonResponse(enrichResponse(person))),
    });
    const rejected = await rejectedAdapter.execute(
      requestFor(
        PROSPEO_WORK_EMAIL_RESOLVE_CAPABILITY,
        PROSPEO_WORK_EMAIL_CONTRACTS,
        value
      )
    );
    assert.deepEqual(rejected, {
      error: { class: "response", reasonCode: "provider-response-invalid" },
      status: "outcome-unknown",
    });
  }
});

test("matches an expected snapshot domain across company domain, website, and alternate websites", async () => {
  const adapter = createProspeoProviderAdapter({
    apiKey: API_KEY,
    clock: { now: () => 1000 },
    fetch: () =>
      Promise.resolve(
        jsonResponse(
          searchResponse([
            {
              company: {
                domain: "provider-primary.example",
                name: "Synthetic Company",
                other_websites: ["alternate.example"],
                website: "https://synthetic.example/",
              },
              person: searchPerson("prospeo_person_0001"),
            },
          ])
        )
      ),
  });
  const result = await adapter.execute(
    requestFor(
      PROSPEO_CONTACT_DISCOVERY_CAPABILITY,
      PROSPEO_CONTACT_DISCOVERY_CONTRACTS,
      discoveryInput()
    )
  );
  assert.equal(result.status, "succeeded");
  if (result.status === "succeeded") {
    assert.equal((result.providerPayload as Output).items.length, 1);
  }
});

test("drops a provider row whose company aliases overlap multiple snapshot organizations", async () => {
  const adapter = createProspeoProviderAdapter({
    apiKey: API_KEY,
    clock: { now: () => 1000 },
    fetch: () =>
      Promise.resolve(
        jsonResponse(
          searchResponse([
            {
              company: {
                domain: "synthetic.example",
                name: "Synthetic Company",
                website: "https://second.example/",
              },
              person: searchPerson("ambiguous_company_person"),
            },
          ])
        )
      ),
  });
  const result = await adapter.execute(
    requestFor(
      PROSPEO_CONTACT_DISCOVERY_CAPABILITY,
      PROSPEO_CONTACT_DISCOVERY_CONTRACTS,
      discoveryInput()
    )
  );
  assert.equal(result.status, "succeeded");
  if (result.status === "succeeded") {
    assert.equal((result.providerPayload as Output).items.length, 0);
  }
});

test("drops unrelated company rows without weakening coordinate validation", async () => {
  const adapter = createProspeoProviderAdapter({
    apiKey: API_KEY,
    clock: { now: () => 1000 },
    fetch: () =>
      Promise.resolve(
        jsonResponse(
          searchResponse([
            searchResult(
              searchPerson("incomplete_person", {
                current_job_title: null,
              })
            ),
            searchResult(
              searchPerson("unrelated_person"),
              "unrelated.example",
              "Unrelated Company"
            ),
            searchResult(searchPerson("prospeo_person_0001")),
          ])
        )
      ),
  });
  const result = await adapter.execute(
    requestFor(
      PROSPEO_CONTACT_DISCOVERY_CAPABILITY,
      PROSPEO_CONTACT_DISCOVERY_CONTRACTS,
      discoveryInput()
    )
  );
  assert.equal(result.status, "succeeded");
  if (result.status === "succeeded") {
    const output = result.providerPayload as Output;
    assert.equal(output.items.length, 1);
    assert.equal(
      output.items[0]?.providerIdentity.providerSubjectId,
      "prospeo_person_0001"
    );
  }
});

test("maps Prospeo HTTP 400 business errors without leaking provider payloads", async () => {
  const cases = [
    ["INVALID_API_KEY", "failed", "authentication", "authentication-failed"],
    ["INSUFFICIENT_CREDITS", "failed", "quota", "quota-exhausted"],
    [
      "SERVICE_TEMPORARILY_UNAVAILABLE",
      "failed",
      "provider",
      "provider-unavailable",
    ],
    ["INVALID_FILTERS", "failed", "provider", "provider-rejected"],
  ] as const;
  for (const [errorCode, status, errorClass, reasonCode] of cases) {
    const adapter = createProspeoProviderAdapter({
      apiKey: API_KEY,
      clock: { now: () => 1000 },
      fetch: () =>
        Promise.resolve(
          jsonResponse(
            {
              error: true,
              error_code: errorCode,
              filter_error: `${EMAIL} ${PHONE}`,
            },
            400
          )
        ),
    });
    const result = await adapter.execute(
      requestFor(
        PROSPEO_CONTACT_DISCOVERY_CAPABILITY,
        PROSPEO_CONTACT_DISCOVERY_CONTRACTS,
        discoveryInput()
      )
    );
    assert.equal(result.status, status);
    if (result.status === "failed") {
      assert.equal(result.error.class, errorClass);
      assert.equal(result.error.reasonCode, reasonCode);
    }
    assert.equal(JSON.stringify(result).includes(EMAIL), false);
    assert.equal(JSON.stringify(result).includes(PHONE), false);
  }

  const noResultsAdapter = createProspeoProviderAdapter({
    apiKey: API_KEY,
    clock: { now: () => 1000 },
    fetch: () =>
      Promise.resolve(
        jsonResponse({ error: true, error_code: "NO_RESULTS" }, 400)
      ),
  });
  const noResults = await noResultsAdapter.execute(
    requestFor(
      PROSPEO_CONTACT_DISCOVERY_CAPABILITY,
      PROSPEO_CONTACT_DISCOVERY_CONTRACTS,
      discoveryInput()
    )
  );
  assert.equal(noResults.status, "succeeded");
  if (noResults.status === "succeeded") {
    assert.equal((noResults.providerPayload as Output).items.length, 0);
  }

  for (const capability of ["identity", "work-email"] as const) {
    const input =
      capability === "identity"
        ? selectedInput("identity", [selectedIdentity])
        : selectedInput("work-email", [selectedWorkEmail]);
    const capabilityRef =
      capability === "identity"
        ? PROSPEO_CONTACT_IDENTITY_CAPABILITY
        : PROSPEO_WORK_EMAIL_RESOLVE_CAPABILITY;
    const contracts =
      capability === "identity"
        ? PROSPEO_CONTACT_IDENTITY_CONTRACTS
        : PROSPEO_WORK_EMAIL_CONTRACTS;
    const noMatchAdapter = createProspeoProviderAdapter({
      apiKey: API_KEY,
      clock: { now: () => 1300 },
      fetch: () =>
        Promise.resolve(
          jsonResponse({ error: true, error_code: "NO_MATCH" }, 400)
        ),
    });
    const result = await noMatchAdapter.execute(
      requestFor(capabilityRef, contracts, input)
    );
    assert.equal(result.status, "succeeded");
    if (result.status === "succeeded") {
      const output = result.providerPayload as Output;
      assert.equal(output.items.length, 1);
      assert.equal(
        valueFor(
          output,
          capability === "identity"
            ? "contacts-identity"
            : "contacts-work-email",
          capability === "identity" ? "identity_status" : "work_email_status"
        ),
        "not_found"
      );
    }
  }
});

test("keeps Enrich Person HTTP 5xx ambiguous so selected effects are not retried", async () => {
  for (const capability of ["identity", "work-email"] as const) {
    let calls = 0;
    const adapter = createProspeoProviderAdapter({
      apiKey: API_KEY,
      clock: { now: () => 1300 },
      fetch: () => {
        calls += 1;
        return Promise.resolve(
          jsonResponse({ error: true, error_code: "INTERNAL_ERROR" }, 503)
        );
      },
    });
    const identity = capability === "identity";
    const result = await adapter.execute(
      requestFor(
        identity
          ? PROSPEO_CONTACT_IDENTITY_CAPABILITY
          : PROSPEO_WORK_EMAIL_RESOLVE_CAPABILITY,
        identity
          ? PROSPEO_CONTACT_IDENTITY_CONTRACTS
          : PROSPEO_WORK_EMAIL_CONTRACTS,
        identity
          ? selectedInput("identity", [selectedIdentity])
          : selectedInput("work-email", [selectedWorkEmail])
      )
    );
    assert.deepEqual(result, {
      error: { class: "provider", reasonCode: "provider-unavailable" },
      status: "outcome-unknown",
    });
    assert.equal(calls, 1);
  }
});

test("classifies diagnostics and bounds a selected effect by deadline without retry", async () => {
  let calls = 0;
  const adapter = createProspeoProviderAdapter({
    apiKey: API_KEY,
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
  const base = requestFor(
    PROSPEO_CONTACT_IDENTITY_CAPABILITY,
    PROSPEO_CONTACT_IDENTITY_CONTRACTS,
    selectedInput("identity", [selectedIdentity])
  );
  const result = await adapter.execute({
    ...base,
    context: { ...base.context, deadlineAtMs: 1001 },
    quote: { ...base.quote, expiresAtMs: 1001 },
  });
  assert.deepEqual(result, {
    error: { class: "deadline", reasonCode: "deadline-exceeded" },
    status: "outcome-unknown",
  });
  assert.equal(calls, 1);
  assert.deepEqual(
    await adapter.classifyError({
      context: contextFor(PROSPEO_CONTACT_DISCOVERY_CAPABILITY),
      diagnostic: { kind: "timeout" },
      phase: "execute",
    }),
    { error: { class: "deadline", reasonCode: "deadline-exceeded" } }
  );
  assert.deepEqual(
    await adapter.classifyError({
      context: contextFor(PROSPEO_CONTACT_DISCOVERY_CAPABILITY),
      diagnostic: { httpStatus: 429, kind: "http-status" },
      phase: "execute",
    }),
    { error: { class: "rate-limit", reasonCode: "rate-limited" } }
  );
});

test("rejects unsafe API keys without retaining them", () => {
  assert.throws(
    () => createProspeoProviderAdapter({ apiKey: ` ${API_KEY}` }),
    (error: unknown) => {
      assert.equal(error instanceof ProspeoProviderConfigurationError, true);
      assert.equal(
        JSON.stringify(error, Object.getOwnPropertyNames(error)).includes(
          API_KEY
        ),
        false
      );
      return true;
    }
  );
});
