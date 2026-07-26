import assert from "node:assert/strict";
import test from "node:test";

import {
  type Record as DatasetRecord,
  datasetId,
  fieldId,
  recordId,
  workspaceId,
} from "@kurobara/kernel";
import type { ContactDiscoveryPageRequest } from "@kurobara/ports";

import {
  createPdlContactDiscoveryProvider,
  PDL_CONTACT_DATA_INCLUDE,
  PdlContactProviderError,
  type PdlContactProviderOptions,
  PdlProviderConfigurationError,
} from "../src/index.ts";

const SYNTHETIC_API_KEY = "synthetic-pdl-secret";
const SYNTHETIC_EMAIL = "private-person@example.invalid";
const JSON_HEADERS = { "content-type": "application/json" };

type FetchImplementation = NonNullable<PdlContactProviderOptions["fetch"]>;
type FetchCall = Readonly<{
  init: RequestInit | undefined;
  input: RequestInfo | URL;
}>;

const companyRecord = (
  id: string,
  domain: string | undefined
): DatasetRecord => ({
  datasetId: datasetId("companies"),
  recordId: recordId(id),
  values: [
    { fieldId: fieldId("company_name"), value: `Company ${id}` },
    ...(domain === undefined
      ? []
      : [{ fieldId: fieldId("company_domain"), value: domain }]),
  ],
  workspaceId: workspaceId("workspace"),
});

const request = (
  overrides: Partial<ContactDiscoveryPageRequest> = {}
): ContactDiscoveryPageRequest => ({
  companyHeadquartersCountryCodes: [],
  companyRecords: [companyRecord("company-1", "synthetic.example")],
  departments: [],
  inputCursor: null,
  maxContactsPerCompany: 2,
  maxContactsTotal: 12,
  personCountryCodes: [],
  seniorities: [],
  titles: [],
  ...overrides,
});

const profile = (
  overrides: Readonly<Record<string, unknown>> = {}
): Readonly<Record<string, unknown>> => ({
  full_name: "Synthetic Person",
  id: "pdl_subject_0001",
  job_company_name: "Synthetic Company",
  job_company_website: "synthetic.example",
  job_title: "sales director",
  job_title_levels: ["director"],
  job_title_role: "sales",
  linkedin_url: "linkedin.com/in/synthetic-person",
  location_country: "spain",
  ...overrides,
});

const searchResponse = (
  data: readonly Readonly<Record<string, unknown>>[]
): Readonly<Record<string, unknown>> => ({
  data,
  scroll_token: "synthetic-scroll-token",
  status: 200,
  total: data.length,
});

const jsonResponse = (
  value: unknown,
  status = 200,
  headers: Readonly<Record<string, string>> = JSON_HEADERS
): Response =>
  new Response(JSON.stringify(value), {
    headers,
    status,
  });

const recordingFetch = (
  handler: (call: FetchCall, index: number) => Promise<Response> | Response
): Readonly<{ calls: FetchCall[]; fetch: FetchImplementation }> => {
  const calls: FetchCall[] = [];
  return {
    calls,
    fetch: (input, init) => {
      const call = { init, input };
      calls.push(call);
      return Promise.resolve(handler(call, calls.length - 1));
    },
  };
};

const assertProviderError =
  (
    reasonCode: PdlContactProviderError["reasonCode"],
    forbiddenValues: readonly string[] = []
  ) =>
  (error: unknown): boolean => {
    if (!(error instanceof PdlContactProviderError)) {
      throw new Error("Expected a PDL contact provider error.");
    }
    if (error.reasonCode !== reasonCode) {
      throw new Error("Expected the PDL contact provider reason code.");
    }
    const serialized = JSON.stringify(error, Object.getOwnPropertyNames(error));
    for (const forbidden of forbiddenValues) {
      if (serialized.includes(forbidden)) {
        throw new Error("The PDL provider error leaked a forbidden value.");
      }
    }
    return true;
  };

test("sends the exact privacy-bounded PDL POST body and headers", async () => {
  const transport = recordingFetch(() =>
    jsonResponse(searchResponse([profile()]))
  );
  const provider = createPdlContactDiscoveryProvider({
    apiKey: SYNTHETIC_API_KEY,
    fetch: transport.fetch,
    nextContactId: () => "contact_opaque_0001",
    now: () => 1000,
  });

  const page = await provider.discoverPage(
    request({
      companyHeadquartersCountryCodes: ["ES"],
      departments: ["sales", "marketing"],
      personCountryCodes: ["FR"],
      seniorities: ["c_suite", "director"],
      titles: ["Sales Director", "VP Revenue"],
    })
  );

  assert.equal(transport.calls.length, 1);
  const [call] = transport.calls;
  assert.ok(call);
  assert.equal(
    String(call.input),
    "https://api.peopledatalabs.com/v5/person/search"
  );
  assert.equal(call.init?.method, "POST");
  assert.equal(call.init?.redirect, "error");
  const headers = new Headers(call.init?.headers);
  assert.equal(headers.get("x-api-key"), SYNTHETIC_API_KEY);
  assert.equal(headers.get("content-type"), "application/json");
  assert.equal(headers.get("accept"), "application/json");
  assert.deepEqual(JSON.parse(String(call.init?.body)), {
    data_include: PDL_CONTACT_DATA_INCLUDE.join(","),
    dataset: "resume",
    query: {
      bool: {
        must: [
          { term: { job_company_website: "synthetic.example" } },
          {
            bool: {
              minimum_should_match: 1,
              should: [
                { match_phrase: { job_title: "sales director" } },
                { match_phrase: { job_title: "vp revenue" } },
              ],
            },
          },
          { terms: { job_title_role: ["sales", "marketing"] } },
          { terms: { job_title_levels: ["cxo", "director"] } },
          { terms: { location_country: ["france"] } },
          {
            terms: { job_company_location_country: ["spain"] },
          },
        ],
      },
    },
    size: 2,
  });
  const serializedBody = String(call.init?.body);
  for (const forbidden of ["email", "phone", "address", "street"]) {
    assert.equal(serializedBody.includes(forbidden), false);
  }
  assert.deepEqual(page.usage, {
    amount: 1,
    basis: "exact",
    unit: "records",
  });
});

test("does not fetch or charge for companies without a usable domain", async () => {
  const transport = recordingFetch(() => {
    throw new Error("fetch must not run");
  });
  const provider = createPdlContactDiscoveryProvider({
    apiKey: SYNTHETIC_API_KEY,
    fetch: transport.fetch,
  });

  const page = await provider.discoverPage(
    request({
      companyRecords: [
        companyRecord("missing-domain", undefined),
        companyRecord("invalid-domain", "https://synthetic.example/path"),
      ],
    })
  );

  assert.equal(transport.calls.length, 0);
  assert.deepEqual(page, {
    candidates: [],
    hasMore: false,
    nextCursor: null,
    outcomes: [
      {
        companyRecordId: "missing-domain",
        reason: "company-domain-missing",
        status: "skipped",
      },
      {
        companyRecordId: "invalid-domain",
        reason: "company-domain-missing",
        status: "skipped",
      },
    ],
    usage: { amount: 0, basis: "exact", unit: "records" },
  });
});

test("reports a stable skipped outcome when the company identifier is missing", async () => {
  const missingIdentifier = structuredClone(
    companyRecord("deleted-identifier", "synthetic.example")
  );
  Reflect.deleteProperty(missingIdentifier, "recordId");
  const transport = recordingFetch(() => {
    throw new Error("fetch must not run");
  });
  const provider = createPdlContactDiscoveryProvider({
    apiKey: SYNTHETIC_API_KEY,
    fetch: transport.fetch,
  });

  const page = await provider.discoverPage(
    request({ companyRecords: [missingIdentifier] })
  );

  assert.equal(transport.calls.length, 0);
  assert.deepEqual(page.outcomes, [
    {
      companyRecordId: "unknown",
      reason: "company-identifier-missing",
      status: "skipped",
    },
  ]);
});

test("rejects duplicate company identities before any provider call", async () => {
  const transport = recordingFetch(() => {
    throw new Error("fetch must not run");
  });
  const provider = createPdlContactDiscoveryProvider({
    apiKey: SYNTHETIC_API_KEY,
    fetch: transport.fetch,
  });
  const duplicate = companyRecord("company-duplicate", "duplicate.example");

  await assert.rejects(
    () =>
      provider.discoverPage(
        request({ companyRecords: [duplicate, duplicate] })
      ),
    assertProviderError("input-invalid", [SYNTHETIC_API_KEY])
  );
  assert.equal(transport.calls.length, 0);
});

test("caps at two contacts per company and twelve total with one request per used company", async () => {
  const domains = ["one.example", "two.example", "three.example"];
  const transport = recordingFetch((call, callIndex) => {
    const body = JSON.parse(String(call.init?.body)) as {
      query: {
        bool: { must: readonly [{ term: { job_company_website: string } }] };
      };
      size: number;
    };
    const domain = body.query.bool.must[0].term.job_company_website;
    return jsonResponse(
      searchResponse(
        Array.from({ length: body.size }, (_, index) =>
          profile({
            id: `pdl_subject_${callIndex}_${index}`,
            job_company_website: domain,
          })
        )
      )
    );
  });
  let contactPosition = 0;
  const provider = createPdlContactDiscoveryProvider({
    apiKey: SYNTHETIC_API_KEY,
    fetch: transport.fetch,
    nextContactId: () => `contact_opaque_${contactPosition++}`,
    now: () => 1000,
  });

  const page = await provider.discoverPage(
    request({
      companyRecords: domains.map((domain, index) =>
        companyRecord(`company-${index}`, domain)
      ),
      maxContactsPerCompany: 2,
      maxContactsTotal: 3,
    })
  );

  assert.equal(transport.calls.length, 2);
  assert.deepEqual(
    transport.calls.map((call) => JSON.parse(String(call.init?.body)).size),
    [2, 1]
  );
  assert.equal(page.candidates.length, 3);
  assert.deepEqual(page.usage, {
    amount: 3,
    basis: "exact",
    unit: "records",
  });
  assert.deepEqual(page.outcomes, [
    { acceptedCount: 2, companyRecordId: "company-0", status: "succeeded" },
    { acceptedCount: 1, companyRecordId: "company-1", status: "succeeded" },
    {
      companyRecordId: "company-2",
      reason: "company-out-of-scope",
      status: "skipped",
    },
  ]);
});

test("rejects a response larger than the exact requested remainder", async () => {
  const transport = recordingFetch(() =>
    jsonResponse(
      searchResponse([
        profile({ id: "pdl_subject_overflow_1" }),
        profile({ id: "pdl_subject_overflow_2" }),
      ])
    )
  );
  const provider = createPdlContactDiscoveryProvider({
    apiKey: SYNTHETIC_API_KEY,
    fetch: transport.fetch,
  });

  await assert.rejects(
    () => provider.discoverPage(request({ maxContactsTotal: 1 })),
    assertProviderError("provider-response-invalid", [SYNTHETIC_API_KEY])
  );
  assert.equal(transport.calls.length, 1);
  assert.equal(JSON.parse(String(transport.calls[0]?.init?.body)).size, 1);
});

test("rejects duplicate provider subjects before materialization or another paid call", async () => {
  const transport = recordingFetch((call) => {
    const body = JSON.parse(String(call.init?.body)) as {
      query: {
        bool: { must: readonly [{ term: { job_company_website: string } }] };
      };
    };
    const domain = body.query.bool.must[0].term.job_company_website;
    const duplicate = profile({
      id: "pdl_subject_duplicate",
      job_company_website: domain,
    });
    return jsonResponse(searchResponse([duplicate, duplicate]));
  });
  let generatedIdentities = 0;
  const provider = createPdlContactDiscoveryProvider({
    apiKey: SYNTHETIC_API_KEY,
    fetch: transport.fetch,
    nextContactId: () => `contact_${generatedIdentities++}`,
  });

  await assert.rejects(
    () =>
      provider.discoverPage(
        request({
          companyRecords: [
            companyRecord("company-one", "one.example"),
            companyRecord("company-two", "two.example"),
          ],
        })
      ),
    assertProviderError("provider-response-invalid", [SYNTHETIC_API_KEY])
  );
  assert.equal(transport.calls.length, 1);
  assert.equal(generatedIdentities, 0);
});

test("treats exact 200 empty searches as zero-cost no-result outcomes", async () => {
  for (const response of [
    jsonResponse({ data: [], status: 200, total: 0 }),
    jsonResponse({ data: [], scroll_token: null, status: 200, total: 0 }),
  ]) {
    const transport = recordingFetch(() => response);
    const provider = createPdlContactDiscoveryProvider({
      apiKey: SYNTHETIC_API_KEY,
      fetch: transport.fetch,
    });

    const page = await provider.discoverPage(request());

    assert.equal(transport.calls.length, 1);
    assert.equal(page.candidates.length, 0);
    assert.deepEqual(page.usage, {
      amount: 0,
      basis: "exact",
      unit: "records",
    });
    assert.deepEqual(page.outcomes, [
      {
        companyRecordId: "company-1",
        reason: "provider-no-result",
        status: "no_result",
      },
    ]);
    assert.equal(JSON.stringify(page).includes(SYNTHETIC_EMAIL), false);
  }
});

test("keeps opaque generated IDs separate from internal provider identities", async () => {
  const provider = createPdlContactDiscoveryProvider({
    apiKey: SYNTHETIC_API_KEY,
    fetch: recordingFetch(() =>
      jsonResponse(searchResponse([profile({ id: "pdl_subject_private_42" })]))
    ).fetch,
    nextContactId: () => "contact_random_opaque_42",
    now: () => 1234,
  });

  const page = await provider.discoverPage(request());
  const [contact] = page.candidates;
  assert.ok(contact);
  assert.equal(contact.candidate.contactId, "contact_random_opaque_42");
  assert.equal(
    String(contact.candidate.contactId).includes("pdl_subject_private_42"),
    false
  );
  assert.deepEqual(contact.providerIdentity, {
    providerKey: "pdl",
    providerSubjectId: "pdl_subject_private_42",
  });
  assert.equal(contact.candidate.displayName, "Synthetic Person");
  assert.equal(contact.candidate.identityCompleteness, "full");
  assert.equal(contact.candidate.observedAt, 1234);
});

test("canonicalizes safe LinkedIn profiles and rejects query, fragment, or unsafe paths", async () => {
  const canonicalProvider = createPdlContactDiscoveryProvider({
    apiKey: SYNTHETIC_API_KEY,
    fetch: recordingFetch(() =>
      jsonResponse(
        searchResponse([
          profile({
            linkedin_url: "https://linkedin.com/in/Synthetic-Profile/",
          }),
        ])
      )
    ).fetch,
    nextContactId: () => "contact_canonical_profile",
    now: () => 1234,
  });
  const canonicalPage = await canonicalProvider.discoverPage(request());
  assert.equal(
    canonicalPage.candidates[0]?.candidate.profileUrl,
    "https://www.linkedin.com/in/Synthetic-Profile"
  );

  for (const linkedinUrl of [
    `linkedin.com/in/synthetic-person?email=${SYNTHETIC_EMAIL}`,
    "linkedin.com/in/synthetic-person#phone",
    "linkedin.com/company/synthetic-company",
    "linkedin.com/in/synthetic_person",
  ]) {
    const provider = createPdlContactDiscoveryProvider({
      apiKey: SYNTHETIC_API_KEY,
      fetch: recordingFetch(() =>
        jsonResponse(searchResponse([profile({ linkedin_url: linkedinUrl })]))
      ).fetch,
    });
    await assert.rejects(
      () => provider.discoverPage(request()),
      assertProviderError("provider-response-invalid", [
        SYNTHETIC_API_KEY,
        SYNTHETIC_EMAIL,
      ])
    );
  }
});

test("rejects every extra email, phone, or address profile field", async () => {
  for (const [field, value] of [
    ["work_email", SYNTHETIC_EMAIL],
    ["phone_numbers", ["synthetic-phone.invalid"]],
    ["street_addresses", [{ street_address: "Private address" }]],
  ] as const) {
    const provider = createPdlContactDiscoveryProvider({
      apiKey: SYNTHETIC_API_KEY,
      fetch: recordingFetch(() =>
        jsonResponse(searchResponse([profile({ [field]: value })]))
      ).fetch,
    });
    await assert.rejects(
      () => provider.discoverPage(request()),
      assertProviderError("provider-response-invalid", [
        SYNTHETIC_API_KEY,
        SYNTHETIC_EMAIL,
        "synthetic-phone.invalid",
        "Private address",
      ])
    );
  }
});

test("rejects extra wrapper keys and malformed profile shapes", async () => {
  for (const responseValue of [
    { ...searchResponse([profile()]), meta: { charged: 1 } },
    searchResponse([profile({ full_name: { raw: SYNTHETIC_EMAIL } })]),
    searchResponse([profile({ id: SYNTHETIC_EMAIL })]),
    searchResponse([profile({ job_title_levels: ["unknown_level"] })]),
  ]) {
    const provider = createPdlContactDiscoveryProvider({
      apiKey: SYNTHETIC_API_KEY,
      fetch: recordingFetch(() => jsonResponse(responseValue)).fetch,
    });
    await assert.rejects(
      () => provider.discoverPage(request()),
      assertProviderError("provider-response-invalid", [
        SYNTHETIC_API_KEY,
        SYNTHETIC_EMAIL,
      ])
    );
  }
});

test("rejects bad content types, bodies, UTF-8, JSON, and response size", async () => {
  const invalidResponses = [
    new Response("{}", {
      headers: { "content-type": "text/plain" },
      status: 200,
    }),
    new Response(null, { headers: JSON_HEADERS, status: 200 }),
    new Response("{", { headers: JSON_HEADERS, status: 200 }),
    new Response(new Uint8Array([0xc3, 0x28]), {
      headers: JSON_HEADERS,
      status: 200,
    }),
    new Response("{}", {
      headers: {
        "content-length": "524289",
        "content-type": "application/json",
      },
      status: 200,
    }),
  ];
  for (const response of invalidResponses) {
    const provider = createPdlContactDiscoveryProvider({
      apiKey: SYNTHETIC_API_KEY,
      fetch: recordingFetch(() => response).fetch,
    });
    await assert.rejects(
      () => provider.discoverPage(request()),
      assertProviderError("provider-response-invalid", [SYNTHETIC_API_KEY])
    );
  }
});

test("maps 401, 403, 404, 429, 5xx, and other bad statuses to stable outcomes", async () => {
  for (const [status, reasonCode] of [
    [401, "authentication-failed"],
    [403, "authorization-failed"],
    [404, "provider-rejected"],
    [429, "rate-limited"],
    [503, "provider-unavailable"],
    [400, "provider-rejected"],
  ] as const) {
    const provider = createPdlContactDiscoveryProvider({
      apiKey: SYNTHETIC_API_KEY,
      fetch: recordingFetch(() =>
        jsonResponse({ error: SYNTHETIC_EMAIL }, status)
      ).fetch,
    });
    await assert.rejects(
      () => provider.discoverPage(request()),
      assertProviderError(reasonCode, [SYNTHETIC_API_KEY, SYNTHETIC_EMAIL])
    );
  }
});

test("marks an aborted in-flight request unknown and never retries", async () => {
  const transport = recordingFetch(
    (call) =>
      new Promise<Response>((_resolve, reject) => {
        call.init?.signal?.addEventListener(
          "abort",
          () => reject(new DOMException("aborted", "AbortError")),
          { once: true }
        );
      })
  );
  const provider = createPdlContactDiscoveryProvider({
    apiKey: SYNTHETIC_API_KEY,
    fetch: transport.fetch,
    timeoutMs: 1,
  });

  await assert.rejects(
    () => provider.discoverPage(request()),
    assertProviderError("transport-outcome-unknown", [SYNTHETIC_API_KEY])
  );
  assert.equal(transport.calls.length, 1);
});

test("normalizes opaque ID generator failures without leaking their payload", async () => {
  const transport = recordingFetch(() =>
    jsonResponse(searchResponse([profile()]))
  );
  const provider = createPdlContactDiscoveryProvider({
    apiKey: SYNTHETIC_API_KEY,
    fetch: transport.fetch,
    nextContactId: () => {
      throw new Error(SYNTHETIC_EMAIL);
    },
  });

  await assert.rejects(
    () => provider.discoverPage(request()),
    assertProviderError("provider-response-invalid", [
      SYNTHETIC_API_KEY,
      SYNTHETIC_EMAIL,
    ])
  );
  assert.equal(transport.calls.length, 1);
});

test("returns a terminal zero-cost page for a non-null input cursor", async () => {
  const transport = recordingFetch(() => {
    throw new Error("fetch must not run");
  });
  const provider = createPdlContactDiscoveryProvider({
    apiKey: SYNTHETIC_API_KEY,
    fetch: transport.fetch,
  });

  const page = await provider.discoverPage(
    request({ inputCursor: "already-completed" })
  );
  assert.equal(transport.calls.length, 0);
  assert.equal(page.hasMore, false);
  assert.equal(page.nextCursor, null);
  assert.equal(page.usage.amount, 0);
});

test("rejects unsafe configuration and request bounds without secrets", async () => {
  assert.throws(
    () =>
      createPdlContactDiscoveryProvider({ apiKey: ` ${SYNTHETIC_API_KEY}` }),
    (error: unknown) => {
      assert.equal(error instanceof PdlProviderConfigurationError, true);
      const serialized = JSON.stringify(
        error,
        Object.getOwnPropertyNames(error)
      );
      assert.equal(serialized.includes(SYNTHETIC_API_KEY), false);
      return true;
    }
  );
  const transport = recordingFetch(() =>
    jsonResponse(searchResponse([profile()]))
  );
  const provider = createPdlContactDiscoveryProvider({
    apiKey: SYNTHETIC_API_KEY,
    fetch: transport.fetch,
  });
  await assert.rejects(
    () =>
      provider.discoverPage(
        request({ maxContactsPerCompany: 3, maxContactsTotal: 13 })
      ),
    assertProviderError("input-invalid", [SYNTHETIC_API_KEY])
  );
  assert.equal(transport.calls.length, 0);
});
