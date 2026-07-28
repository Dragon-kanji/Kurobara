import assert from "node:assert/strict";
import test from "node:test";

import type {
  PluginEstimateRequest,
  PluginExecuteRequest,
} from "@kurobara/plugin-sdk";

import {
  createHunterContactWorkEmailProvider,
  createHunterProviderAdapter,
  HUNTER_COMPANY_DISCOVERY_CAPABILITY,
  HUNTER_COMPANY_DISCOVERY_CONTRACTS,
  HUNTER_CONTACT_SHORTLIST_ADMISSION,
  HUNTER_WORK_EMAIL_CONTRACTS,
  HUNTER_WORK_EMAIL_RESOLVE_CAPABILITY,
  HUNTER_WORK_EMAIL_VERIFY_CAPABILITY,
  HunterContactProviderError,
  HunterProviderConfigurationError,
} from "../src/index.ts";

test("keeps Hunter Domain Search inadmissible for the strict shortlist", () => {
  assert.deepEqual(HUNTER_CONTACT_SHORTLIST_ADMISSION, {
    capability: "contacts.discover@1.0.0",
    reasonCode: "shortlist-inseparable-from-email-reveal",
    status: "inadmissible",
  });
});

test("uses Hunter Finder and Verifier only for an explicitly supplied contact", async () => {
  const urls: string[] = [];
  const rawCanary = "raw-provider-data-must-not-escape";
  const provider = createHunterContactWorkEmailProvider({
    apiKey: "synthetic-hunter-key",
    clock: { now: () => 1000 },
    fetch: (input) => {
      const url = String(input);
      urls.push(url);
      return Promise.resolve(
        jsonResponse(
          url.includes("email-finder")
            ? {
                data: {
                  email: "Synthetic@COMPANY.EXAMPLE",
                  phone_number: rawCanary,
                  score: 90,
                  verification: { date: "2026-07-22", status: "valid" },
                },
                meta: { params: { api_key: rawCanary } },
              }
            : {
                data: { score: 100, sources: [rawCanary], status: "valid" },
                meta: { params: { api_key: rawCanary } },
              }
        )
      );
    },
  });
  const contact = {
    candidate: {
      contactId: "contact-1" as never,
      department: "sales",
      displayName: "Synthetic Contact",
      identityCompleteness: "full",
      jobTitle: "Director",
      observedAt: 1000 as never,
      organizationDomain: "company.example",
      organizationId: "company-1",
      organizationName: "Synthetic Company",
      personCountryCode: "ES",
      profileUrl: null,
      seniority: "director",
    },
    providerIdentity: {
      providerKey: "hunter",
      providerSubjectId: "hunter-subject-1",
    },
  } as const;
  const resolved = await provider.resolve({
    contact,
    operationId: "resolve-1",
  });
  assert.equal(resolved.value?.email, "synthetic@company.example");
  assert.equal(resolved.value?.verification, "valid");
  assert.equal(resolved.usage.amount, 1);
  const verified = await provider.verify({
    email: resolved.value.email,
    operationId: "verify-1",
    providerIdentity: contact.providerIdentity,
  });
  assert.equal(verified.value.status, "valid");
  assert.equal(urls.length, 2);
  assert.equal(urls[0]?.includes("synthetic-hunter-key"), false);
  assert.equal(JSON.stringify(resolved).includes(rawCanary), false);
  assert.equal(
    JSON.stringify(resolved).includes("synthetic-hunter-key"),
    false
  );
  assert.equal(JSON.stringify(verified).includes(rawCanary), false);
  assert.equal(
    JSON.stringify(verified).includes("synthetic-hunter-key"),
    false
  );
});

const selectedContact = {
  candidate: {
    contactId: "contact-1" as never,
    department: "sales",
    displayName: "Synthetic Contact",
    identityCompleteness: "full",
    jobTitle: "Director",
    observedAt: 1000 as never,
    organizationDomain: "company.example",
    organizationId: "company-1",
    organizationName: "Synthetic Company",
    personCountryCode: "ES",
    profileUrl: null,
    seniority: "director",
  },
  providerIdentity: {
    providerKey: "hunter",
    providerSubjectId: "hunter-subject-1",
  },
} as const;

test("rejects a Finder email outside the selected organization domain", async () => {
  const mismatchedEmail = "synthetic@personal.example";
  const provider = createHunterContactWorkEmailProvider({
    apiKey: "synthetic-hunter-key",
    fetch: () =>
      Promise.resolve(
        jsonResponse({
          data: {
            email: mismatchedEmail,
            score: 90,
            verification: { status: "valid" },
          },
          meta: {},
        })
      ),
  });

  await assert.rejects(
    provider.resolve({
      contact: selectedContact,
      operationId: "resolve-domain-mismatch",
    }),
    (error: unknown) => {
      assert.equal(error instanceof HunterContactProviderError, true);
      if (!(error instanceof HunterContactProviderError)) {
        return false;
      }
      assert.equal(error.reasonCode, "provider-response-invalid");
      assert.equal(JSON.stringify(error).includes(mismatchedEmail), false);
      return true;
    }
  );
});

test("classifies a selected-contact Hunter 403 as rate limiting", async () => {
  const provider = createHunterContactWorkEmailProvider({
    apiKey: "synthetic-hunter-key",
    fetch: () => Promise.resolve(new Response(null, { status: 403 })),
  });

  await assert.rejects(
    provider.resolve({
      contact: selectedContact,
      operationId: "resolve-rate-limited",
    }),
    (error: unknown) =>
      error instanceof HunterContactProviderError &&
      error.reasonCode === "rate-limited"
  );
});

test("uses the strict legacy Finder status fallback only without verification", async () => {
  const provider = createHunterContactWorkEmailProvider({
    apiKey: "synthetic-hunter-key",
    clock: { now: () => 1000 },
    fetch: () =>
      Promise.resolve(
        jsonResponse({
          data: {
            email: "synthetic@company.example",
            score: 80,
            status: "accept_all",
          },
          meta: {},
        })
      ),
  });

  const resolved = await provider.resolve({
    contact: selectedContact,
    operationId: "resolve-legacy-fixture",
  });

  assert.equal(resolved.value?.verification, "accept_all");
});

test("rejects malformed Finder envelopes and statuses without leaking provider data", async () => {
  const secret = "synthetic-hunter-key";
  const rawCanary = "hostile-raw-body";
  const responses = [
    jsonResponse({
      data: {
        email: "synthetic@company.example",
        verification: { status: "invalid", raw: rawCanary },
      },
      meta: {},
    }),
    jsonResponse({
      data: {
        email: "synthetic@company.example",
        verification: "valid",
      },
      meta: {},
    }),
    jsonResponse({
      data: {
        email: "synthetic@company.example",
        verification: { status: "valid" },
      },
    }),
  ];
  const provider = createHunterContactWorkEmailProvider({
    apiKey: secret,
    fetch: () =>
      Promise.resolve(responses.shift() ?? new Response(null, { status: 500 })),
  });

  for (let index = 0; index < 3; index += 1) {
    await assert.rejects(
      provider.resolve({
        contact: selectedContact,
        operationId: `resolve-hostile-${index}`,
      }),
      (error: unknown) => {
        assert.equal(error instanceof HunterContactProviderError, true);
        if (!(error instanceof HunterContactProviderError)) {
          return false;
        }
        assert.equal(error.reasonCode, "provider-response-invalid");
        assert.equal(JSON.stringify(error).includes(rawCanary), false);
        assert.equal(JSON.stringify(error).includes(secret), false);
        return true;
      }
    );
  }
});

test("marks an asynchronous Verifier response as outcome unknown", async () => {
  const provider = createHunterContactWorkEmailProvider({
    apiKey: "synthetic-hunter-key",
    fetch: () =>
      Promise.resolve(
        jsonResponse({ data: { status: "valid" }, meta: {} }, 202)
      ),
  });

  await assert.rejects(
    provider.verify({
      email: "synthetic@company.example" as never,
      operationId: "verify-pending",
      providerIdentity: selectedContact.providerIdentity,
    }),
    (error: unknown) =>
      error instanceof HunterContactProviderError &&
      error.reasonCode === "transport-outcome-unknown"
  );
});

const hash = (character: string): string => `sha256:${character.repeat(64)}`;
const CONTENT_HASH_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const COMPANY_ID_PATTERN = /^company_[0-9a-f]{64}$/u;
const SYNTHETIC_HUNTER_KEY = "synthetic-hunter-key";
const SYNTHETIC_PERSONAL_EMAIL = "personal@example.invalid";
const SYNTHETIC_PHONE = "synthetic-phone.invalid";

const workEmailFieldDefinitions = [
  ["department", "Department", "string"],
  ["display_name", "Display name", "string"],
  ["first_name", "First name", "string"],
  ["identity_completeness", "Identity completeness", "string"],
  ["identity_observed_at_ms", "Identity observed at", "number"],
  ["identity_status", "Identity status", "string"],
  ["job_title", "Current job title", "string"],
  ["last_name", "Last name", "string"],
  ["observed_at_ms", "Employment observed at", "number"],
  ["organization_domain", "Company domain", "string"],
  ["organization_id", "Company ID", "string"],
  ["organization_name", "Company name", "string"],
  ["person_country_code", "Person country", "string"],
  ["profile_url", "Professional profile", "string"],
  ["seniority", "Seniority", "string"],
  ["work_email", "Work email", "string"],
  ["work_email_confidence", "Work email confidence", "number"],
  ["work_email_observed_at_ms", "Work email observed at", "number"],
  ["work_email_source", "Work email source", "string"],
  ["work_email_status", "Work email status", "string"],
  ["work_email_verification", "Work email verification", "string"],
] as const;

const workEmailFields = workEmailFieldDefinitions.map(
  ([key, label, valueType]) => ({
    datasetId: "dataset-work-email-output",
    fieldId: `field-${key}`,
    key,
    label,
    valueType,
    workspaceId: "workspace",
  })
);

const workEmailSelection = (
  suffix: string,
  kind: "resolve" | "verify",
  providerKey:
    | "apollo-people-search"
    | "prospeo-person-search" = "apollo-people-search"
): Readonly<Record<string, unknown>> => ({
  candidate: {
    department: "sales",
    display_name: `Synthetic Contact ${suffix}`,
    identity_completeness: "full",
    job_title: "Sales Director",
    observed_at_ms: 1000,
    organization_domain: "company.example",
    organization_id: "company-1",
    organization_name: "Synthetic Company",
    person_country_code: "ES",
    profile_url: `https://professional.example/contact-${suffix}`,
    seniority: "director",
  },
  identity: {
    display_name: `Synthetic Contact ${suffix}`,
    first_name: "Synthetic",
    last_name: `Contact-${suffix}`,
    observed_at_ms: 1200,
    profile_url: `https://professional.example/contact-${suffix}`,
  },
  provider_identity: {
    provider_key: providerKey,
    provider_subject_id: `person-synthetic-${suffix}`,
  },
  source_record_id: `contact-${suffix}`,
  ...(kind === "verify"
    ? {
        work_email: {
          confidence: 0.9,
          email: `synthetic-${suffix}@company.example`,
          observed_at_ms: 1400,
          source: "provider_unspecified",
          verification: "unknown",
        },
      }
    : {}),
});

const workEmailPageInput = (
  kind: "resolve" | "verify",
  selection = [workEmailSelection("1", kind)],
  pageIndex = 0,
  overrides: Readonly<Record<string, unknown>> = {}
): Readonly<Record<string, unknown>> => ({
  capability:
    kind === "resolve"
      ? HUNTER_WORK_EMAIL_RESOLVE_CAPABILITY
      : HUNTER_WORK_EMAIL_VERIFY_CAPABILITY,
  datasetId: "dataset-work-email-output",
  fields: workEmailFields,
  generationId: `generation-work-email-${kind}`,
  generationPlanId: `generation-plan-work-email-${kind}`,
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
    operation_kind: kind,
    result_kind: "contact_work_email",
    selected_contacts: selection,
    source_dataset_id: `dataset-work-email-source-${kind}`,
  },
  pageSequence: pageIndex + 1,
  planHash: hash("f"),
  queryHash: hash("1"),
  schemaHash: hash("2"),
  version: "1.0.0",
  workspaceId: "workspace",
  ...overrides,
});

const workEmailContext = (kind: "resolve" | "verify") => ({
  capability:
    kind === "resolve"
      ? HUNTER_WORK_EMAIL_RESOLVE_CAPABILITY
      : HUNTER_WORK_EMAIL_VERIFY_CAPABILITY,
  configuration: { contentHash: hash("3"), value: {} },
  deadlineAtMs: 10_000,
});

const workEmailRequestFor = (
  kind: "resolve" | "verify",
  inputValue: Readonly<Record<string, unknown>> = workEmailPageInput(kind),
  upperBound = 1
): PluginExecuteRequest => ({
  context: workEmailContext(kind),
  costLimit: { amount: upperBound, unit: "requests" },
  input: {
    contentHash: hash("4"),
    contract: HUNTER_WORK_EMAIL_CONTRACTS.input,
    sizeBytes: new TextEncoder().encode(JSON.stringify(inputValue)).byteLength,
    value: inputValue,
  },
  operationKey: `operation-work-email-${kind}`,
  quote: {
    expiresAtMs: 10_000,
    guarantee: "hard",
    pricingVersion: "1.0.0",
    unit: "requests",
    upperBound,
  },
});

const workEmailEstimateFor = (
  kind: "resolve" | "verify",
  inputValue: Readonly<Record<string, unknown>> = workEmailPageInput(kind)
): PluginEstimateRequest => ({
  context: workEmailContext(kind),
  input: {
    contentHash: hash("4"),
    contract: HUNTER_WORK_EMAIL_CONTRACTS.input,
    sizeBytes: new TextEncoder().encode(JSON.stringify(inputValue)).byteLength,
    value: inputValue,
  },
});

type WorkEmailPageOutput = Readonly<{
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

const workEmailValue = (
  output: WorkEmailPageOutput,
  key: (typeof workEmailFieldDefinitions)[number][0]
): unknown => {
  const fieldId = workEmailFields.find((field) => field.key === key)?.fieldId;
  return output.items[0]?.record.values.find(
    (entry) => entry.fieldId === fieldId
  )?.value;
};

test("resolves one selected contact per Finder page into a fully joined record", async () => {
  const rawCanary = "raw-hunter-finder-data-must-not-escape";
  let capturedUrl: URL | undefined;
  let capturedInit: RequestInit | undefined;
  const adapter = createHunterProviderAdapter({
    apiKey: SYNTHETIC_HUNTER_KEY,
    clock: { now: () => 1600 },
    fetch: (input, init) => {
      capturedUrl = new URL(String(input));
      capturedInit = init;
      return Promise.resolve(
        jsonResponse({
          data: {
            email: "synthetic@company.example",
            personal_email: SYNTHETIC_PERSONAL_EMAIL,
            phone_number: SYNTHETIC_PHONE,
            score: 90,
            verification: { sources: [rawCanary], status: "valid" },
          },
          meta: { params: { api_key: rawCanary } },
        })
      );
    },
  });
  const selection = [
    workEmailSelection("1", "resolve"),
    workEmailSelection("2", "resolve"),
  ];
  const input = workEmailPageInput("resolve", selection);

  const { manifest } = adapter.describe();
  for (const capabilityId of [
    HUNTER_WORK_EMAIL_RESOLVE_CAPABILITY.capabilityId,
    HUNTER_WORK_EMAIL_VERIFY_CAPABILITY.capabilityId,
  ]) {
    const capability = manifest.capabilities.find(
      (candidate) => candidate.capabilityId === capabilityId
    );
    assert.deepEqual(
      capability?.inputContract,
      HUNTER_WORK_EMAIL_CONTRACTS.input
    );
    assert.deepEqual(
      capability?.outputContract,
      HUNTER_WORK_EMAIL_CONTRACTS.output
    );
  }
  const estimate = await adapter.estimate(
    workEmailEstimateFor("resolve", input)
  );
  assert.equal(estimate.status, "quoted");
  if (estimate.status === "quoted") {
    assert.equal(estimate.quote.upperBound, 1);
  }

  const result = await adapter.execute(workEmailRequestFor("resolve", input));
  assert.equal(result.status, "succeeded");
  if (result.status !== "succeeded") {
    assert.fail("Expected a successful Finder page.");
  }
  assert.ok(capturedUrl);
  assert.equal(
    capturedUrl.origin + capturedUrl.pathname,
    "https://api.hunter.io/v2/email-finder"
  );
  assert.deepEqual([...capturedUrl.searchParams.entries()].sort(), [
    ["domain", "company.example"],
    ["full_name", "Synthetic Contact 1"],
  ]);
  assert.equal(capturedUrl.searchParams.has("api_key"), false);
  assert.equal(capturedInit?.method, "GET");
  assert.equal(
    new Headers(capturedInit?.headers).get("x-api-key"),
    SYNTHETIC_HUNTER_KEY
  );
  assert.deepEqual(result.usage, {
    amount: 1,
    basis: "exact",
    unit: "requests",
  });
  const output = result.providerPayload as WorkEmailPageOutput;
  assert.equal(output.hasMore, true);
  assert.equal(output.nextCursor, "contact:1");
  assert.equal(output.sourcePartitionCompleted, false);
  assert.equal(output.items.length, 1);
  assert.equal(output.items[0]?.record.recordId, "contact-1");
  assert.deepEqual(output.items[0]?.source, {
    datasetId: "dataset-work-email-source-resolve",
    recordId: "contact-1",
  });
  assert.deepEqual(output.items[0]?.providerIdentity, {
    providerKey: "apollo-people-search",
    providerSubjectId: "person-synthetic-1",
  });
  assert.equal(workEmailValue(output, "display_name"), "Synthetic Contact 1");
  assert.equal(workEmailValue(output, "first_name"), "Synthetic");
  assert.equal(workEmailValue(output, "identity_status"), "found");
  assert.equal(
    workEmailValue(output, "organization_domain"),
    "company.example"
  );
  assert.equal(
    workEmailValue(output, "work_email"),
    "synthetic@company.example"
  );
  assert.equal(workEmailValue(output, "work_email_confidence"), 0.9);
  assert.equal(workEmailValue(output, "work_email_observed_at_ms"), 1600);
  assert.equal(
    workEmailValue(output, "work_email_source"),
    "provider_unspecified"
  );
  assert.equal(workEmailValue(output, "work_email_status"), "found");
  assert.equal(workEmailValue(output, "work_email_verification"), "valid");
  const record = JSON.stringify(output.items[0]?.record);
  const serialized = JSON.stringify(output);
  assert.equal(record.includes("person-synthetic-1"), false);
  assert.equal(serialized.includes(SYNTHETIC_PERSONAL_EMAIL), false);
  assert.equal(serialized.includes(SYNTHETIC_PHONE), false);
  assert.equal(serialized.includes(rawCanary), false);
  assert.equal(serialized.includes(SYNTHETIC_HUNTER_KEY), false);

  const normalized = await adapter.normalize({
    context: workEmailContext("resolve"),
    operationKey: "operation-work-email-resolve",
    outputContract: HUNTER_WORK_EMAIL_CONTRACTS.output,
    providerPayload: output,
  });
  assert.equal(normalized.status, "normalized");
});

test("rejects an off-domain Finder response without materializing it", async () => {
  const mismatchedEmail = "synthetic@personal.example";
  const adapter = createHunterProviderAdapter({
    apiKey: SYNTHETIC_HUNTER_KEY,
    clock: { now: () => 1600 },
    fetch: () =>
      Promise.resolve(
        jsonResponse({
          data: {
            email: mismatchedEmail,
            score: 90,
            verification: { status: "valid" },
          },
          meta: {},
        })
      ),
  });

  const result = await adapter.execute(workEmailRequestFor("resolve"));

  assert.deepEqual(result, {
    error: { class: "response", reasonCode: "provider-response-invalid" },
    status: "outcome-unknown",
  });
  assert.equal(JSON.stringify(result).includes(mismatchedEmail), false);
});

test("resolves a Prospeo-selected work email and preserves its provider namespace", async () => {
  const adapter = createHunterProviderAdapter({
    apiKey: SYNTHETIC_HUNTER_KEY,
    clock: { now: () => 1650 },
    fetch: () =>
      Promise.resolve(
        jsonResponse({
          data: {
            email: "synthetic@company.example",
            score: 90,
            verification: { status: "valid" },
          },
          meta: {},
        })
      ),
  });
  const result = await adapter.execute(
    workEmailRequestFor(
      "resolve",
      workEmailPageInput("resolve", [
        workEmailSelection(
          "prospeo-resolve",
          "resolve",
          "prospeo-person-search"
        ),
      ])
    )
  );

  assert.equal(result.status, "succeeded");
  if (result.status !== "succeeded") {
    assert.fail("Expected a successful Prospeo-selected Finder page.");
  }
  const output = result.providerPayload as WorkEmailPageOutput;
  assert.equal(
    output.items[0]?.providerIdentity.providerKey,
    "prospeo-person-search"
  );
  assert.equal(workEmailValue(output, "work_email_status"), "found");
});

test("maps selected-contact Hunter 403 responses to rate limiting", async () => {
  const adapter = createHunterProviderAdapter({
    apiKey: SYNTHETIC_HUNTER_KEY,
    clock: { now: () => 1600 },
    fetch: () =>
      Promise.resolve(
        new Response(null, {
          headers: { "retry-after": "3" },
          status: 403,
        })
      ),
  });

  assert.deepEqual(await adapter.execute(workEmailRequestFor("resolve")), {
    error: {
      class: "rate-limit",
      reasonCode: "rate-limited",
      retryAfterMs: 3000,
    },
    status: "failed",
    usage: { amount: 1, basis: "exact", unit: "requests" },
  });
  assert.deepEqual(
    await adapter.classifyError({
      context: workEmailContext("verify"),
      diagnostic: {
        httpStatus: 403,
        kind: "http-status",
        retryAfterMs: 3000,
      },
      phase: "execute",
    }),
    {
      error: {
        class: "rate-limit",
        reasonCode: "rate-limited",
        retryAfterMs: 3000,
      },
    }
  );
});

test("keeps a certain Finder no-result as the third joined row without invention", async () => {
  let capturedUrl: URL | undefined;
  const adapter = createHunterProviderAdapter({
    apiKey: SYNTHETIC_HUNTER_KEY,
    clock: { now: () => 1700 },
    fetch: (input) => {
      capturedUrl = new URL(String(input));
      return Promise.resolve(
        jsonResponse({
          data: {
            email: null,
            personal_email: SYNTHETIC_PERSONAL_EMAIL,
            phone_number: SYNTHETIC_PHONE,
          },
          meta: {},
        })
      );
    },
  });
  const selection = ["1", "2", "3"].map((suffix) =>
    workEmailSelection(suffix, "resolve")
  );
  const result = await adapter.execute(
    workEmailRequestFor("resolve", workEmailPageInput("resolve", selection, 2))
  );
  assert.equal(result.status, "succeeded");
  if (result.status !== "succeeded") {
    assert.fail("Expected a certain Finder no-result.");
  }
  assert.equal(
    capturedUrl?.searchParams.get("full_name"),
    "Synthetic Contact 3"
  );
  const output = result.providerPayload as WorkEmailPageOutput;
  assert.equal(output.hasMore, false);
  assert.equal(output.nextCursor, null);
  assert.equal(output.sourcePartitionCompleted, true);
  assert.equal(output.items.length, 1);
  assert.equal(output.items[0]?.record.recordId, "contact-3");
  assert.equal(workEmailValue(output, "identity_completeness"), "full");
  assert.equal(workEmailValue(output, "work_email"), null);
  assert.equal(workEmailValue(output, "work_email_confidence"), null);
  assert.equal(workEmailValue(output, "work_email_observed_at_ms"), 1700);
  assert.equal(workEmailValue(output, "work_email_source"), null);
  assert.equal(workEmailValue(output, "work_email_status"), "not_found");
  assert.equal(workEmailValue(output, "work_email_verification"), null);
  const serialized = JSON.stringify(output);
  assert.equal(serialized.includes(SYNTHETIC_PERSONAL_EMAIL), false);
  assert.equal(serialized.includes(SYNTHETIC_PHONE), false);
});

test("verifies only the selected source work email and preserves the joined record", async () => {
  const rawCanary = "raw-verifier-data-must-not-escape";
  let capturedUrl: URL | undefined;
  const adapter = createHunterProviderAdapter({
    apiKey: SYNTHETIC_HUNTER_KEY,
    clock: { now: () => 1800 },
    fetch: (input) => {
      capturedUrl = new URL(String(input));
      return Promise.resolve(
        jsonResponse({
          data: {
            phone_number: SYNTHETIC_PHONE,
            sources: [rawCanary],
            status: "valid",
          },
          meta: { params: { api_key: rawCanary } },
        })
      );
    },
  });
  const result = await adapter.execute(workEmailRequestFor("verify"));
  assert.equal(result.status, "succeeded");
  if (result.status !== "succeeded") {
    assert.fail("Expected a successful Verifier page.");
  }
  assert.ok(capturedUrl);
  assert.equal(
    capturedUrl.origin + capturedUrl.pathname,
    "https://api.hunter.io/v2/email-verifier"
  );
  assert.deepEqual(
    [...capturedUrl.searchParams.entries()],
    [["email", "synthetic-1@company.example"]]
  );
  assert.equal(capturedUrl.searchParams.has("api_key"), false);
  const output = result.providerPayload as WorkEmailPageOutput;
  assert.equal(output.items[0]?.record.recordId, "contact-1");
  assert.equal(
    workEmailValue(output, "work_email"),
    "synthetic-1@company.example"
  );
  assert.equal(workEmailValue(output, "work_email_confidence"), 0.9);
  assert.equal(workEmailValue(output, "work_email_observed_at_ms"), 1800);
  assert.equal(
    workEmailValue(output, "work_email_source"),
    "provider_unspecified"
  );
  assert.equal(workEmailValue(output, "work_email_status"), "found");
  assert.equal(workEmailValue(output, "work_email_verification"), "valid");
  const serialized = JSON.stringify(output);
  assert.equal(serialized.includes(SYNTHETIC_PHONE), false);
  assert.equal(serialized.includes(rawCanary), false);
});

test("verifies a Prospeo-selected work email and preserves its provider namespace", async () => {
  const adapter = createHunterProviderAdapter({
    apiKey: SYNTHETIC_HUNTER_KEY,
    clock: { now: () => 1850 },
    fetch: () =>
      Promise.resolve(jsonResponse({ data: { status: "valid" }, meta: {} })),
  });
  const result = await adapter.execute(
    workEmailRequestFor(
      "verify",
      workEmailPageInput("verify", [
        workEmailSelection("prospeo", "verify", "prospeo-person-search"),
      ])
    )
  );

  assert.equal(result.status, "succeeded");
  if (result.status !== "succeeded") {
    assert.fail("Expected a successful Prospeo-selected Verifier page.");
  }
  const output = result.providerPayload as WorkEmailPageOutput;
  assert.equal(
    output.items[0]?.providerIdentity.providerKey,
    "prospeo-person-search"
  );
  assert.equal(workEmailValue(output, "work_email_verification"), "valid");
});

test("rejects hostile work-email pages and classifies uncertain effects without leaking payloads", async () => {
  let calls = 0;
  const rejectingAdapter = createHunterProviderAdapter({
    apiKey: SYNTHETIC_HUNTER_KEY,
    clock: { now: () => 1000 },
    fetch: () => {
      calls += 1;
      return Promise.resolve(jsonResponse({ data: { email: null }, meta: {} }));
    },
  });
  const resolveInput = workEmailPageInput("resolve");
  const resolveQuery = resolveInput.normalizedQuery as Readonly<
    Record<string, unknown>
  >;
  const resolveSelection = resolveQuery.selected_contacts as readonly Readonly<
    Record<string, unknown>
  >[];
  const first = resolveSelection[0];
  assert.ok(first);
  const verifySelection = workEmailSelection("1", "verify");
  const verifyWorkEmail = verifySelection.work_email as Readonly<
    Record<string, unknown>
  >;
  const invalidInputs: readonly Readonly<{
    input: Readonly<Record<string, unknown>>;
    kind: "resolve" | "verify";
  }>[] = [
    {
      input: workEmailPageInput(
        "resolve",
        ["1", "2", "3", "4"].map((suffix) =>
          workEmailSelection(suffix, "resolve")
        )
      ),
      kind: "resolve",
    },
    {
      input: workEmailPageInput("resolve", undefined, 0, {
        normalizedQuery: {
          ...resolveQuery,
          selected_contacts: [
            {
              ...first,
              candidate: {
                ...(first.candidate as Readonly<Record<string, unknown>>),
                phone_number: SYNTHETIC_PHONE,
              },
            },
          ],
        },
      }),
      kind: "resolve",
    },
    {
      input: workEmailPageInput("resolve", undefined, 0, {
        normalizedQuery: {
          ...resolveQuery,
          selected_contacts: [
            {
              ...first,
              provider_identity: {
                provider_key: "attacker",
                provider_subject_id: "person-synthetic-1",
              },
            },
          ],
        },
      }),
      kind: "resolve",
    },
    {
      input: workEmailPageInput("verify", [workEmailSelection("1", "resolve")]),
      kind: "verify",
    },
    {
      input: workEmailPageInput("resolve", [workEmailSelection("1", "verify")]),
      kind: "resolve",
    },
    {
      input: workEmailPageInput("verify", [
        {
          ...verifySelection,
          work_email: {
            ...verifyWorkEmail,
            email: "synthetic@personal.example",
          },
        },
      ]),
      kind: "verify",
    },
    {
      input: workEmailPageInput("resolve", undefined, 0, {
        limits: {
          ...(resolveInput.limits as Readonly<Record<string, number>>),
          maxPhones: 1,
        },
      }),
      kind: "resolve",
    },
  ];
  for (const invalid of invalidInputs) {
    const estimate = await rejectingAdapter.estimate(
      workEmailEstimateFor(invalid.kind, invalid.input)
    );
    assert.equal(estimate.status, "unavailable");
  }
  const underquoted = await rejectingAdapter.execute(
    workEmailRequestFor("resolve", resolveInput, 0)
  );
  assert.equal(underquoted.status, "failed");
  assert.equal(calls, 0);

  for (const fetchImplementation of [
    () => Promise.reject(new Error(SYNTHETIC_PERSONAL_EMAIL)),
    () =>
      Promise.resolve(
        jsonResponse({ data: { phone: SYNTHETIC_PHONE }, meta: {} }, 503)
      ),
    () =>
      Promise.resolve(
        jsonResponse({ data: { status: "valid" }, meta: {} }, 202)
      ),
    () =>
      Promise.resolve(
        jsonResponse({ data: { email: SYNTHETIC_PERSONAL_EMAIL } })
      ),
  ]) {
    const adapter = createHunterProviderAdapter({
      apiKey: SYNTHETIC_HUNTER_KEY,
      clock: { now: () => 1000 },
      fetch: fetchImplementation,
    });
    const result = await adapter.execute(workEmailRequestFor("resolve"));
    assert.equal(result.status, "outcome-unknown");
    const serialized = JSON.stringify(result);
    assert.equal(serialized.includes(SYNTHETIC_PERSONAL_EMAIL), false);
    assert.equal(serialized.includes(SYNTHETIC_PHONE), false);
  }

  let timedCalls = 0;
  const timed = createHunterProviderAdapter({
    apiKey: SYNTHETIC_HUNTER_KEY,
    clock: { now: () => 1000 },
    fetch: (_input, init) => {
      timedCalls += 1;
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => reject(new DOMException("aborted", "AbortError")),
          { once: true }
        );
      });
    },
  });
  const timedRequest = workEmailRequestFor("resolve");
  const timedResult = await timed.execute({
    ...timedRequest,
    context: { ...timedRequest.context, deadlineAtMs: 1001 },
    quote: { ...timedRequest.quote, expiresAtMs: 1001 },
  });
  assert.deepEqual(timedResult, {
    error: { class: "deadline", reasonCode: "deadline-exceeded" },
    status: "outcome-unknown",
  });
  assert.equal(timedCalls, 1);

  const rejected = createHunterProviderAdapter({
    apiKey: SYNTHETIC_HUNTER_KEY,
    clock: { now: () => 1000 },
    fetch: () =>
      Promise.resolve(
        jsonResponse(
          { data: { email: SYNTHETIC_PERSONAL_EMAIL }, meta: {} },
          422
        )
      ),
  });
  const rejectedResult = await rejected.execute(workEmailRequestFor("resolve"));
  assert.equal(rejectedResult.status, "failed");
  if (rejectedResult.status === "failed") {
    assert.equal(rejectedResult.error.class, "provider");
    assert.deepEqual(rejectedResult.usage, {
      amount: 1,
      basis: "exact",
      unit: "requests",
    });
  }
});

const fields = [
  {
    datasetId: "dataset",
    fieldId: "field-name",
    key: "name",
    label: "Name",
    valueType: "string",
    workspaceId: "workspace",
  },
  {
    datasetId: "dataset",
    fieldId: "field-domain",
    key: "domain",
    label: "Domain",
    valueType: "string",
    workspaceId: "workspace",
  },
  {
    datasetId: "dataset",
    fieldId: "field-country_code",
    key: "country_code",
    label: "Country",
    valueType: "string",
    workspaceId: "workspace",
  },
  {
    datasetId: "dataset",
    fieldId: "field-industry_code",
    key: "industry_code",
    label: "Industry",
    valueType: "string",
    workspaceId: "workspace",
  },
  {
    datasetId: "dataset",
    fieldId: "field-employee_count",
    key: "employee_count",
    label: "Employees",
    valueType: "number",
    workspaceId: "workspace",
  },
  {
    datasetId: "dataset",
    fieldId: "field-observed_at_ms",
    key: "observed_at_ms",
    label: "Observed",
    valueType: "number",
    workspaceId: "workspace",
  },
] as const;

const value = {
  capability: HUNTER_COMPANY_DISCOVERY_CAPABILITY,
  datasetId: "dataset",
  fields,
  generationId: "generation",
  generationPlanId: "generation-plan",
  inputCursor: null,
  kind: "dataset-generation-page-input",
  limits: {
    maxCalls: 2,
    maxCompanies: 150,
    maxContactsPerCompany: 0,
    maxContactsTotal: 0,
    maxEnrichments: 0,
    maxPages: 2,
    maxPhones: 0,
    maxResults: 150,
  },
  normalizedQuery: {
    country_codes: ["FR"],
    country_scope: "headquarters",
    employee_count: { maximum: 200, minimum: 11 },
    industry_codes: ["software"],
    industry_taxonomy: "kurobara-v1",
    keywords: ["agentic", "automation"],
    result_kind: "company",
  },
  pageSequence: 1,
  planHash: hash("a"),
  queryHash: hash("b"),
  schemaHash: hash("c"),
  version: "1.0.0",
  workspaceId: "workspace",
} as const;

type PageInputValue = Readonly<Record<string, unknown>> &
  Readonly<{ pageSequence: number }>;

type PageOutputValue = Readonly<{
  hasMore: boolean;
  items: readonly Readonly<{
    contentHash: string;
    record: Readonly<{
      recordId: string;
      values: readonly unknown[];
    }>;
  }>[];
  nextCursor: string | null;
  sourcePartitionCompleted: boolean;
}>;

const context = {
  capability: HUNTER_COMPANY_DISCOVERY_CAPABILITY,
  configuration: { contentHash: hash("d"), value: {} },
  deadlineAtMs: 10_000,
};

const requestFor = (
  inputValue: PageInputValue = value
): PluginExecuteRequest => ({
  context,
  costLimit: { amount: 1, unit: "requests" },
  input: {
    contentHash: hash("e"),
    contract: HUNTER_COMPANY_DISCOVERY_CONTRACTS.input,
    sizeBytes: new TextEncoder().encode(JSON.stringify(inputValue)).byteLength,
    value: inputValue,
  },
  operationKey: `operation-${inputValue.pageSequence}`,
  quote: {
    expiresAtMs: 10_000,
    guarantee: "hard",
    pricingVersion: "1.0.0",
    unit: "requests",
    upperBound: 1,
  },
});

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
    status,
  });

test("declares the owner-key Hunter boundary and normalizes one company page", async () => {
  const secret = "synthetic-hunter-key";
  let capturedInput: string | undefined;
  let capturedInit: RequestInit | undefined;
  const adapter = createHunterProviderAdapter({
    apiKey: secret,
    clock: { now: () => 1000 },
    fetch: (input, init) => {
      capturedInput = input instanceof Request ? input.url : String(input);
      capturedInit = init;
      return Promise.resolve(
        jsonResponse({
          data: [
            {
              domain: "synthetic.example",
              emails_count: { generic: 0, personal: 0, total: 0 },
              organization: "Synthetic Company",
            },
          ],
          meta: { filters: {}, limit: 100, offset: 0, params: {}, results: 1 },
        })
      );
    },
  });

  const { manifest } = adapter.describe();
  assert.equal(manifest.id, "dev.kurobara.provider-hunter");
  assert.deepEqual(manifest.auth.modes, ["api-key-header"]);
  assert.deepEqual(manifest.permissions.egress.hosts, ["api.hunter.io"]);
  assert.deepEqual(
    manifest.capabilities[0]?.inputContract,
    HUNTER_COMPANY_DISCOVERY_CONTRACTS.input
  );
  assert.deepEqual(
    manifest.capabilities[0]?.outputContract,
    HUNTER_COMPANY_DISCOVERY_CONTRACTS.output
  );

  const result = await adapter.execute(requestFor());

  assert.equal(capturedInput, "https://api.hunter.io/v2/discover");
  assert.equal(capturedInit?.method, "POST");
  assert.equal(capturedInit?.redirect, "error");
  assert.equal(new Headers(capturedInit?.headers).get("x-api-key"), secret);
  assert.equal(new Headers(capturedInit?.headers).get("authorization"), null);
  assert.deepEqual(JSON.parse(String(capturedInit?.body)), {
    headcount: ["11-50", "51-200"],
    headquarters_location: { include: [{ country: "FR" }] },
    industry: { include: ["Software Development"] },
    keywords: { include: ["agentic", "automation"], match: "all" },
    limit: 100,
  });
  assert.equal(String(capturedInit?.body).includes(secret), false);
  assert.equal(JSON.stringify(result).includes(secret), false);
  assert.equal(result.status, "succeeded");
  if (result.status !== "succeeded") {
    assert.fail("Expected a successful fixture result.");
  }
  assert.deepEqual(result.usage, {
    amount: 1,
    basis: "exact",
    unit: "requests",
  });
  const output = result.providerPayload as PageOutputValue;
  assert.equal(output.hasMore, false);
  assert.equal(output.nextCursor, null);
  assert.equal(output.sourcePartitionCompleted, true);
  assert.equal(output.items.length, 1);
  assert.match(output.items[0]?.contentHash ?? "", CONTENT_HASH_PATTERN);
  assert.match(output.items[0]?.record.recordId ?? "", COMPANY_ID_PATTERN);
  assert.deepEqual(output.items[0]?.record.values, [
    { fieldId: "field-name", value: "Synthetic Company" },
    { fieldId: "field-domain", value: "synthetic.example" },
    { fieldId: "field-country_code", value: "FR" },
    { fieldId: "field-industry_code", value: "software" },
    { fieldId: "field-employee_count", value: null },
    { fieldId: "field-observed_at_ms", value: 1000 },
  ]);
  const normalized = await adapter.normalize({
    context,
    operationKey: "operation-1",
    outputContract: HUNTER_COMPANY_DISCOVERY_CONTRACTS.output,
    providerPayload: output,
  });
  assert.equal(normalized.status, "normalized");
});

test("falls back from arbitrary industry codes to explicit Hunter keywords", async () => {
  let body: Record<string, unknown> | undefined;
  const adapter = createHunterProviderAdapter({
    apiKey: "synthetic-hunter-key",
    clock: { now: () => 1000 },
    fetch: (_input, init) => {
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return Promise.resolve(
        jsonResponse({
          data: [],
          meta: { filters: {}, limit: 100, offset: 0, params: {}, results: 0 },
        })
      );
    },
  });
  const input = {
    ...value,
    normalizedQuery: {
      ...value.normalizedQuery,
      industry_codes: ["pet-food"],
    },
  };

  const result = await adapter.execute(requestFor(input));

  assert.equal(result.status, "succeeded");
  assert.deepEqual(body, {
    headcount: ["11-50", "51-200"],
    headquarters_location: { include: [{ country: "FR" }] },
    keywords: {
      include: ["agentic", "automation", "pet food"],
      match: "any",
    },
    limit: 100,
  });
});

test("emits an opaque bounded cursor and consumes it on the next page", async () => {
  const companies = Array.from({ length: 100 }, (_, index) => ({
    domain: `company-${index}.example`,
    organization: `Synthetic Company ${index}`,
  }));
  const bodies: unknown[] = [];
  const adapter = createHunterProviderAdapter({
    apiKey: "synthetic-hunter-key",
    clock: { now: () => 1000 },
    fetch: (_input, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      return Promise.resolve(
        jsonResponse({
          data: bodies.length === 1 ? companies : companies.slice(0, 50),
          meta: {
            limit: 100,
            offset: bodies.length === 1 ? 0 : 100,
            results: 150,
          },
        })
      );
    },
  });

  const first = await adapter.execute(requestFor());
  assert.equal(first.status, "succeeded");
  if (first.status !== "succeeded") {
    assert.fail("Expected a successful first page.");
  }
  const firstOutput = first.providerPayload as PageOutputValue;
  assert.equal(firstOutput.hasMore, true);
  assert.equal(firstOutput.nextCursor, "offset:100");
  assert.equal(firstOutput.items.length, 100);

  const secondValue = {
    ...value,
    inputCursor: "offset:100",
    pageSequence: 2,
  };
  const second = await adapter.execute(requestFor(secondValue));
  assert.equal(second.status, "succeeded");
  if (second.status !== "succeeded") {
    assert.fail("Expected a successful second page.");
  }
  const secondOutput = second.providerPayload as PageOutputValue;
  assert.equal(secondOutput.hasMore, false);
  assert.equal(secondOutput.items.length, 50);
  assert.deepEqual(bodies[1], {
    headcount: ["11-50", "51-200"],
    headquarters_location: { include: [{ country: "FR" }] },
    industry: { include: ["Software Development"] },
    keywords: { include: ["agentic", "automation"], match: "all" },
    limit: 100,
    offset: 100,
  });
});

test("uses Hunter's default page size and stops exactly at a smaller company cap", async () => {
  const companies = Array.from({ length: 100 }, (_, index) => ({
    domain: `bounded-${index}.example`,
    organization: `Bounded Company ${index}`,
  }));
  let body: Record<string, unknown> | undefined;
  const adapter = createHunterProviderAdapter({
    apiKey: "synthetic-hunter-key",
    clock: { now: () => 1000 },
    fetch: (_input, init) => {
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return Promise.resolve(
        jsonResponse({
          data: companies,
          meta: { limit: 100, offset: 0, results: 400 },
        })
      );
    },
  });
  const bounded = {
    ...value,
    limits: {
      ...value.limits,
      maxCompanies: 35,
      maxResults: 35,
    },
  };

  const result = await adapter.execute(requestFor(bounded));
  assert.equal(result.status, "succeeded");
  if (result.status !== "succeeded") {
    assert.fail("Expected a successful bounded page.");
  }
  const output = result.providerPayload as PageOutputValue;
  assert.equal(body?.limit, 100);
  assert.equal(output.items.length, 35);
  assert.equal(output.hasMore, true);
  assert.equal(output.nextCursor, "offset:100");
});

test("preserves provider continuation while the application enforces caps", async () => {
  const companies = Array.from({ length: 100 }, (_, index) => ({
    domain: `capped-${index}.example`,
    organization: `Capped Company ${index}`,
  }));
  const adapter = createHunterProviderAdapter({
    apiKey: "synthetic-hunter-key",
    clock: { now: () => 1000 },
    fetch: () =>
      Promise.resolve(
        jsonResponse({
          data: companies,
          meta: { limit: 100, offset: 0, results: 150 },
        })
      ),
  });
  const capped = {
    ...value,
    limits: { ...value.limits, maxCalls: 1, maxPages: 1 },
  };

  const result = await adapter.execute(requestFor(capped));
  assert.equal(result.status, "succeeded");
  if (result.status !== "succeeded") {
    assert.fail("Expected a successful capped page.");
  }
  const output = result.providerPayload as PageOutputValue;
  assert.equal(output.items.length, 100);
  assert.equal(output.hasMore, true);
  assert.equal(output.nextCursor, "offset:100");
});

test("fails closed before fetch for lossy filters, multiple countries, or cursor drift", async () => {
  let calls = 0;
  const adapter = createHunterProviderAdapter({
    apiKey: "synthetic-hunter-key",
    fetch: () => {
      calls += 1;
      return Promise.resolve(jsonResponse({ data: [], meta: {} }));
    },
  });
  const candidates = [
    {
      ...value,
      normalizedQuery: {
        ...value.normalizedQuery,
        employee_count: { maximum: 200, minimum: 12 },
      },
    },
    {
      ...value,
      normalizedQuery: {
        ...value.normalizedQuery,
        country_codes: ["FR", "ES"],
      },
    },
    {
      ...value,
      inputCursor: "offset:200",
      pageSequence: 2,
    },
  ] as unknown as PageInputValue[];

  await Promise.all(
    candidates.map(async (candidate) => {
      const estimated = await adapter.estimate({
        context,
        input: requestFor(candidate).input,
      });
      assert.equal(estimated.status, "unavailable");
      const executed = await adapter.execute(requestFor(candidate));
      assert.deepEqual(executed, {
        error: { class: "input", reasonCode: "input-invalid" },
        status: "failed",
        usage: { amount: 0, basis: "exact", unit: "requests" },
      });
    })
  );
  assert.equal(calls, 0);
});

test("normalizes privacy refusal, rate limit, and hostile success separately", async () => {
  const outcomes = [
    new Response(null, { status: 451 }),
    new Response(null, { headers: { "retry-after": "3" }, status: 429 }),
    jsonResponse({
      data: [{ domain: "invalid" }],
      meta: { limit: 100, offset: 0, results: 1 },
    }),
  ];
  const adapter = createHunterProviderAdapter({
    apiKey: "synthetic-hunter-key",
    clock: { now: () => 1000 },
    fetch: () =>
      Promise.resolve(outcomes.shift() ?? new Response(null, { status: 500 })),
  });

  assert.deepEqual(await adapter.execute(requestFor()), {
    error: { class: "provider", reasonCode: "provider-rejected" },
    status: "failed",
    usage: { amount: 1, basis: "exact", unit: "requests" },
  });
  assert.deepEqual(await adapter.execute(requestFor()), {
    error: {
      class: "rate-limit",
      reasonCode: "rate-limited",
      retryAfterMs: 3000,
    },
    status: "failed",
    usage: { amount: 1, basis: "exact", unit: "requests" },
  });
  assert.deepEqual(await adapter.execute(requestFor()), {
    error: { class: "response", reasonCode: "provider-response-invalid" },
    status: "outcome-unknown",
  });
});

test("rejects pagination metadata drift and short pages that claim more data", async () => {
  const responses = [
    jsonResponse({ data: [], meta: { limit: 50, offset: 0, results: 0 } }),
    jsonResponse({ data: [], meta: { limit: 100, offset: 100, results: 100 } }),
    jsonResponse({
      data: [{ domain: "short.example", organization: "Short Company" }],
      meta: { limit: 100, offset: 0, results: 2 },
    }),
  ];
  const adapter = createHunterProviderAdapter({
    apiKey: "synthetic-hunter-key",
    clock: { now: () => 1000 },
    fetch: () =>
      Promise.resolve(responses.shift() ?? new Response(null, { status: 500 })),
  });

  for (let index = 0; index < 3; index += 1) {
    assert.deepEqual(await adapter.execute(requestFor()), {
      error: { class: "response", reasonCode: "provider-response-invalid" },
      status: "outcome-unknown",
    });
  }
});

test("rejects invalid credentials without retaining them", () => {
  const secret = " synthetic-hunter-key";
  assert.throws(
    () => createHunterProviderAdapter({ apiKey: secret }),
    (error: unknown) => {
      assert.equal(error instanceof HunterProviderConfigurationError, true);
      assert.equal(JSON.stringify(error).includes(secret), false);
      return true;
    }
  );
});
