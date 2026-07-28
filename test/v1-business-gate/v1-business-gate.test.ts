import assert from "node:assert/strict";
import test from "node:test";

import {
  createCsvDatasetCodec,
  createJsonlDatasetCodec,
} from "@kurobara/adapter-dataset-codec";
import { datasetId, workspaceId } from "@kurobara/kernel";
import type {
  PluginAdapterV1,
  PluginCapability,
  PluginContractRef,
  PluginExecuteRequest,
} from "@kurobara/plugin-sdk";
import type {
  DatasetCodecPort,
  DatasetFieldCodecSpec,
  DatasetRecord,
} from "@kurobara/ports";
import {
  createHunterProviderAdapter,
  HUNTER_COMPANY_DISCOVERY_CAPABILITY,
  HUNTER_COMPANY_DISCOVERY_CONTRACTS,
  HUNTER_WORK_EMAIL_CONTRACTS,
  HUNTER_WORK_EMAIL_VERIFY_CAPABILITY,
} from "@kurobara/provider-hunter";
import {
  createProspeoProviderAdapter,
  PROSPEO_CONTACT_DISCOVERY_CAPABILITY,
  PROSPEO_CONTACT_DISCOVERY_CONTRACTS,
  PROSPEO_CONTACT_IDENTITY_CAPABILITY,
  PROSPEO_CONTACT_IDENTITY_CONTRACTS,
  PROSPEO_WORK_EMAIL_CONTRACTS,
  PROSPEO_WORK_EMAIL_RESOLVE_CAPABILITY,
} from "@kurobara/provider-prospeo";

const WORKSPACE_ID = workspaceId("workspace-v1-business-gate");
const COMPANY_DATASET_ID = datasetId("dataset-v1-companies");
const SHORTLIST_DATASET_ID = datasetId("dataset-v1-shortlist");
const IDENTITY_DATASET_ID = datasetId("dataset-v1-identities");
const RESOLVED_DATASET_ID = datasetId("dataset-v1-resolved-emails");
const VERIFIED_DATASET_ID = datasetId("dataset-v1-verified-emails");
const RAW_CANARY = "raw-provider-payload-canary";
const PERSONAL_EMAIL_CANARY = "personal@example.invalid";
const PHONE_CANARY = "synthetic-phone.invalid";
const HUNTER_KEY = "synthetic-hunter-key";
const PROSPEO_KEY = "synthetic-prospeo-key";
const HASH_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const COMPANY_ID_PATTERN = /^company_[0-9a-f]{64}$/u;

const hash = (character: string): string => `sha256:${character.repeat(64)}`;

const COMPANY_FIELD_DEFINITIONS = [
  ["name", "Name", "string"],
  ["domain", "Domain", "string"],
  ["country_code", "Country", "string"],
  ["industry_code", "Industry", "string"],
  ["employee_count", "Employees", "number"],
  ["observed_at_ms", "Observed", "number"],
] as const;

const CONTACT_FIELD_DEFINITIONS = [
  ["department", "Department", "string"],
  ["display_name", "Display name", "string"],
  ["identity_completeness", "Identity completeness", "string"],
  ["job_title", "Job title", "string"],
  ["observed_at_ms", "Observed", "number"],
  ["organization_domain", "Company domain", "string"],
  ["organization_id", "Company ID", "string"],
  ["organization_name", "Company name", "string"],
  ["person_country_code", "Person country", "string"],
  ["profile_url", "Professional profile", "string"],
  ["seniority", "Seniority", "string"],
] as const;

const IDENTITY_FIELD_DEFINITIONS = [
  ["department", "Department", "string"],
  ["display_name", "Display name", "string"],
  ["first_name", "First name", "string"],
  ["identity_completeness", "Identity completeness", "string"],
  ["identity_observed_at_ms", "Identity observed", "number"],
  ["identity_status", "Identity status", "string"],
  ["job_title", "Job title", "string"],
  ["last_name", "Last name", "string"],
  ["observed_at_ms", "Employment observed", "number"],
  ["organization_domain", "Company domain", "string"],
  ["organization_id", "Company ID", "string"],
  ["organization_name", "Company name", "string"],
  ["person_country_code", "Person country", "string"],
  ["profile_url", "Professional profile", "string"],
  ["seniority", "Seniority", "string"],
] as const;

const WORK_EMAIL_FIELD_DEFINITIONS = [
  ["department", "Department", "string"],
  ["display_name", "Display name", "string"],
  ["first_name", "First name", "string"],
  ["identity_completeness", "Identity completeness", "string"],
  ["identity_observed_at_ms", "Identity observed", "number"],
  ["identity_status", "Identity status", "string"],
  ["job_title", "Current job title", "string"],
  ["last_name", "Last name", "string"],
  ["observed_at_ms", "Employment observed", "number"],
  ["organization_domain", "Company domain", "string"],
  ["organization_id", "Company ID", "string"],
  ["organization_name", "Company name", "string"],
  ["person_country_code", "Person country", "string"],
  ["profile_url", "Professional profile", "string"],
  ["seniority", "Seniority", "string"],
  ["work_email", "Work email", "string"],
  ["work_email_confidence", "Work email confidence", "number"],
  ["work_email_observed_at_ms", "Work email observed", "number"],
  ["work_email_source", "Work email source", "string"],
  ["work_email_status", "Work email status", "string"],
  ["work_email_verification", "Work email verification", "string"],
] as const;

type FieldDefinition = readonly [
  key: string,
  label: string,
  valueType: "boolean" | "number" | "string",
];

const fieldsFor = (
  targetDatasetId: string,
  definitions: readonly FieldDefinition[]
) =>
  definitions.map(([key, label, valueType]) => ({
    datasetId: targetDatasetId,
    fieldId: `field-${key}`,
    key,
    label,
    valueType,
    workspaceId: WORKSPACE_ID,
  }));

const companyFields = fieldsFor(COMPANY_DATASET_ID, COMPANY_FIELD_DEFINITIONS);
const contactFields = fieldsFor(
  SHORTLIST_DATASET_ID,
  CONTACT_FIELD_DEFINITIONS
);
const identityFields = fieldsFor(
  IDENTITY_DATASET_ID,
  IDENTITY_FIELD_DEFINITIONS
);
const resolvedEmailFields = fieldsFor(
  RESOLVED_DATASET_ID,
  WORK_EMAIL_FIELD_DEFINITIONS
);
const verifiedEmailFields = fieldsFor(
  VERIFIED_DATASET_ID,
  WORK_EMAIL_FIELD_DEFINITIONS
);

type PageRecord = Readonly<{
  datasetId: string;
  recordId: string;
  values: readonly Readonly<{ fieldId: string; value: unknown }>[];
  workspaceId: string;
}>;

type PageItem = Readonly<{
  contentHash: string;
  providerIdentity?: Readonly<{
    providerKey: string;
    providerSubjectId: string;
  }>;
  record: PageRecord;
  source?: Readonly<{ datasetId: string; recordId: string }>;
}>;

type PageOutput = Readonly<{
  hasMore: boolean;
  items: readonly PageItem[];
  nextCursor: null | string;
  sourcePartitionCompleted: boolean;
  version: "1.0.0";
}>;

const valuesByKey = (
  item: PageItem,
  fields: readonly Readonly<{ fieldId: string; key: string }>[]
): Readonly<Record<string, unknown>> => {
  const keysById = new Map(fields.map((field) => [field.fieldId, field.key]));
  return Object.fromEntries(
    item.record.values.map((entry) => [
      keysById.get(entry.fieldId) ?? "unexpected-field",
      entry.value,
    ])
  );
};

const jsonResponse = (value: unknown): Response =>
  new Response(JSON.stringify(value), {
    headers: { "content-type": "application/json" },
    status: 200,
  });

const pageInput = (input: {
  capability: PluginCapability;
  datasetId: string;
  fields: readonly Readonly<Record<string, unknown>>[];
  limits: Readonly<Record<string, number>>;
  normalizedQuery: Readonly<Record<string, unknown>>;
  suffix: string;
}): Readonly<Record<string, unknown>> => ({
  capability: input.capability,
  datasetId: input.datasetId,
  fields: input.fields,
  generationId: `generation-${input.suffix}`,
  generationPlanId: `generation-plan-${input.suffix}`,
  inputCursor: null,
  kind: "dataset-generation-page-input",
  limits: input.limits,
  normalizedQuery: input.normalizedQuery,
  pageSequence: 1,
  planHash: hash("a"),
  queryHash: hash("b"),
  schemaHash: hash("c"),
  version: "1.0.0",
  workspaceId: WORKSPACE_ID,
});

const pluginInput = (
  contract: PluginContractRef,
  value: Readonly<Record<string, unknown>>
) => ({
  contentHash: hash("d"),
  contract,
  sizeBytes: new TextEncoder().encode(JSON.stringify(value)).byteLength,
  value,
});

const executeOneEffectPage = async (input: {
  adapter: PluginAdapterV1;
  capability: PluginCapability;
  contracts: Readonly<{ input: PluginContractRef; output: PluginContractRef }>;
  effectLog: readonly string[];
  operationKey: string;
  page: Readonly<Record<string, unknown>>;
}): Promise<PageOutput> => {
  const context = {
    capability: input.capability,
    configuration: { contentHash: hash("e"), value: {} },
    deadlineAtMs: 10_000,
  };
  const encodedInput = pluginInput(input.contracts.input, input.page);
  const estimate = await input.adapter.estimate({
    context,
    input: encodedInput,
  });
  if (estimate.status !== "quoted") {
    throw new Error(
      `Expected a hard one-request quote for ${input.operationKey}.`
    );
  }
  if (
    estimate.quote.guarantee !== "hard" ||
    estimate.quote.unit !== "requests" ||
    estimate.quote.upperBound !== 1
  ) {
    throw new Error(
      `Expected a hard one-request quote for ${input.operationKey}.`
    );
  }
  const before = input.effectLog.length;
  const request: PluginExecuteRequest = {
    context,
    costLimit: { amount: 1, unit: "requests" },
    input: encodedInput,
    operationKey: input.operationKey,
    quote: estimate.quote,
  };
  const result = await input.adapter.execute(request);
  if (input.effectLog.length - before !== 1) {
    throw new Error(
      `${input.operationKey} must perform exactly one provider effect per page.`
    );
  }
  if (result.status !== "succeeded") {
    throw new Error(`Expected ${input.operationKey} to succeed.`);
  }
  if (
    result.usage.amount !== 1 ||
    result.usage.basis !== "exact" ||
    result.usage.unit !== "requests"
  ) {
    throw new Error(
      `Expected exact one-request usage for ${input.operationKey}.`
    );
  }
  const output = result.providerPayload as PageOutput;
  const normalized = await input.adapter.normalize({
    context,
    operationKey: input.operationKey,
    outputContract: input.contracts.output,
    providerPayload: output,
  });
  if (
    normalized.status !== "normalized" ||
    output.items.length < 1 ||
    !output.items.every((item) => HASH_PATTERN.test(item.contentHash))
  ) {
    throw new Error(
      `Expected a normalized non-empty page for ${input.operationKey}.`
    );
  }
  return output;
};

const selectedIdentity = (item: PageItem) => {
  if (item.providerIdentity === undefined) {
    throw new Error(
      "A selected identity requires restricted provider lineage."
    );
  }
  return {
    candidate: valuesByKey(item, contactFields),
    provider_identity: {
      provider_key: item.providerIdentity.providerKey,
      provider_subject_id: item.providerIdentity.providerSubjectId,
    },
    source_record_id: item.record.recordId,
  };
};

const selectedWorkEmail = (item: PageItem, includeEmail: boolean) => {
  if (item.providerIdentity === undefined) {
    throw new Error(
      "A selected work email requires restricted provider lineage."
    );
  }
  const values = valuesByKey(
    item,
    includeEmail ? resolvedEmailFields : identityFields
  );
  return {
    candidate: Object.fromEntries(
      CONTACT_FIELD_DEFINITIONS.map(([key]) => [key, values[key]])
    ),
    identity: {
      display_name: values.display_name,
      first_name: values.first_name,
      last_name: values.last_name,
      observed_at_ms: values.identity_observed_at_ms,
      profile_url: values.profile_url,
    },
    provider_identity: {
      provider_key: item.providerIdentity.providerKey,
      provider_subject_id: item.providerIdentity.providerSubjectId,
    },
    source_record_id: item.record.recordId,
    ...(includeEmail
      ? {
          work_email: {
            confidence: values.work_email_confidence,
            email: values.work_email,
            observed_at_ms: values.work_email_observed_at_ms,
            source: values.work_email_source,
            verification: values.work_email_verification,
          },
        }
      : {}),
  };
};

async function* oneRecord(record: DatasetRecord) {
  await Promise.resolve();
  yield record;
}

const encode = async (
  codec: DatasetCodecPort,
  record: DatasetRecord,
  fields: readonly DatasetFieldCodecSpec[]
): Promise<string> => {
  const chunks: Uint8Array[] = [];
  for await (const event of codec.encode({
    datasetId: record.datasetId,
    fields,
    maxRecordBytes: 16_384,
    records: oneRecord(record),
    workspaceId: record.workspaceId,
  })) {
    if (event.type !== "chunk") {
      throw new Error(`The ${codec.format} fixture export failed.`);
    }
    chunks.push(event.bytes);
  }
  const size = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
  const joined = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(joined);
};

test("proves the fixture-only V1 business vertical from company filters to deterministic exports", async () => {
  const effects: string[] = [];
  const hunterBodies: unknown[] = [];
  const prospeoRequests: Readonly<{
    body: Readonly<Record<string, unknown>>;
    headers: Headers;
    method: string | undefined;
    pathname: string;
  }>[] = [];
  const hunter = createHunterProviderAdapter({
    apiKey: HUNTER_KEY,
    clock: { now: () => 1500 },
    fetch: (input, init) => {
      const url = new URL(String(input));
      effects.push(url.pathname);
      if (url.pathname.endsWith("/discover")) {
        hunterBodies.push(JSON.parse(String(init?.body)));
        return Promise.resolve(
          jsonResponse({
            data: [
              {
                domain: "synthetic.example",
                organization: "Synthetic Company",
                personal_email: PERSONAL_EMAIL_CANARY,
                phone_number: PHONE_CANARY,
                private_payload: RAW_CANARY,
              },
            ],
            meta: {
              limit: 100,
              offset: 0,
              params: { raw: RAW_CANARY },
              results: 1,
            },
          })
        );
      }
      assert.equal(url.pathname.endsWith("/email-verifier"), true);
      return Promise.resolve(
        jsonResponse({
          data: {
            phone_number: PHONE_CANARY,
            sources: [RAW_CANARY],
            status: "valid",
          },
          meta: { params: { raw: RAW_CANARY } },
        })
      );
    },
  });
  const prospeo = createProspeoProviderAdapter({
    apiKey: PROSPEO_KEY,
    clock: { now: () => 1300 },
    fetch: (input, init) => {
      const url = new URL(String(input));
      effects.push(url.pathname);
      const body = JSON.parse(String(init?.body)) as Readonly<
        Record<string, unknown>
      >;
      prospeoRequests.push({
        body,
        headers: new Headers(init?.headers),
        method: init?.method,
        pathname: url.pathname,
      });
      if (url.pathname.endsWith("/search-person")) {
        const person = (id: string, suffix: string) => ({
          current_job_title: "Sales Director",
          email: {
            email: `s${suffix.toLowerCase()}********@synthetic.example`,
            revealed: false,
            status: "VERIFIED",
          },
          first_name: `Synthetic${suffix}`,
          last_name: `Person${suffix}`,
          linkedin_url: `https://www.linkedin.com/in/synthetic-person${suffix.toLowerCase()}`,
          location: { country_code: "FR" },
          mobile: {
            mobile: "+33 * ** ** ** **",
            revealed: false,
            status: "VERIFIED",
          },
          person_id: id,
        });
        return Promise.resolve(
          jsonResponse({
            error: false,
            free: false,
            pagination: {
              current_page: 1,
              per_page: 25,
              total_count: 2,
              total_page: 1,
            },
            results: [
              {
                company: {
                  domain: "synthetic.example",
                  name: "Synthetic Company",
                },
                person: person("prospeo_subject_selected", ""),
              },
              {
                company: {
                  domain: "synthetic.example",
                  name: "Synthetic Company",
                },
                person: person("prospeo_subject_not_selected", "Two"),
              },
            ],
          })
        );
      }
      assert.equal(url.pathname.endsWith("/enrich-person"), true);
      const onlyVerifiedEmail = body.only_verified_email === true;
      return Promise.resolve(
        jsonResponse({
          company: {
            domain: "synthetic.example",
            name: "Synthetic Company",
          },
          error: false,
          free_enrichment: false,
          person: {
            email: onlyVerifiedEmail
              ? {
                  confidence: 0.98,
                  email: "synthetic.person@synthetic.example",
                  revealed: true,
                  status: "VERIFIED",
                  verification_method: RAW_CANARY,
                }
              : {
                  email: PERSONAL_EMAIL_CANARY,
                  revealed: true,
                  status: "VERIFIED",
                  verification_method: RAW_CANARY,
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
            personal_email: PERSONAL_EMAIL_CANARY,
            person_id: "prospeo_subject_selected",
            phone_number: PHONE_CANARY,
          },
        })
      );
    },
  });

  const companies = await executeOneEffectPage({
    adapter: hunter,
    capability: HUNTER_COMPANY_DISCOVERY_CAPABILITY,
    contracts: HUNTER_COMPANY_DISCOVERY_CONTRACTS,
    effectLog: effects,
    operationKey: "v1-company-discovery",
    page: pageInput({
      capability: HUNTER_COMPANY_DISCOVERY_CAPABILITY,
      datasetId: COMPANY_DATASET_ID,
      fields: companyFields,
      limits: {
        maxCalls: 1,
        maxCompanies: 1,
        maxContactsPerCompany: 0,
        maxContactsTotal: 0,
        maxEnrichments: 0,
        maxPages: 1,
        maxPhones: 0,
        maxResults: 1,
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
      suffix: "company-discovery",
    }),
  });
  assert.deepEqual(hunterBodies, [
    {
      headcount: ["11-50", "51-200"],
      headquarters_location: { include: [{ country: "FR" }] },
      industry: { include: ["Software Development"] },
      keywords: { include: ["agentic", "automation"], match: "all" },
      limit: 100,
    },
  ]);
  assert.equal(companies.items.length, 1);
  const company = companies.items[0];
  assert.ok(company);
  const companyValues = valuesByKey(company, companyFields);
  assert.match(company.record.recordId, COMPANY_ID_PATTERN);

  const shortlist = await executeOneEffectPage({
    adapter: prospeo,
    capability: PROSPEO_CONTACT_DISCOVERY_CAPABILITY,
    contracts: PROSPEO_CONTACT_DISCOVERY_CONTRACTS,
    effectLog: effects,
    operationKey: "v1-contact-shortlist",
    page: pageInput({
      capability: PROSPEO_CONTACT_DISCOVERY_CAPABILITY,
      datasetId: SHORTLIST_DATASET_ID,
      fields: contactFields,
      limits: {
        maxCalls: 1,
        maxCompanies: 1,
        maxContactsPerCompany: 2,
        maxContactsTotal: 2,
        maxEnrichments: 0,
        maxPages: 1,
        maxPhones: 0,
        maxResults: 2,
      },
      normalizedQuery: {
        company_headquarters_country_codes: [companyValues.country_code],
        departments: [],
        organization_source: {
          generation_id: "generation-company-discovery",
          kind: "generation",
        },
        organizations: [
          {
            company_id: company.record.recordId,
            country_code: companyValues.country_code,
            domain: companyValues.domain,
            name: companyValues.name,
          },
        ],
        person_country_codes: ["FR"],
        result_kind: "contact",
        seniorities: ["director"],
        titles: ["Sales Director"],
      },
      suffix: "contact-shortlist",
    }),
  });
  assert.equal(shortlist.items.length, 2);
  assert.equal(
    shortlist.items.every(
      (item) => item.providerIdentity?.providerKey === "prospeo-person-search"
    ),
    true
  );
  const discoveryRequest = prospeoRequests[0];
  assert.ok(discoveryRequest);
  assert.equal(discoveryRequest.pathname, "/search-person");
  assert.equal(discoveryRequest.method, "POST");
  assert.equal(discoveryRequest.headers.get("x-key"), PROSPEO_KEY);
  assert.equal(discoveryRequest.headers.get("x-api-key"), null);
  assert.deepEqual(discoveryRequest.body, {
    filters: {
      company: { websites: { include: ["synthetic.example"] } },
      company_location_search: { include: ["France"] },
      max_person_per_company: 2,
      person_contact_details: {
        email: ["VERIFIED"],
        hide_people_with_details_already_revealed: true,
      },
      person_job_title: {
        include: ["Sales Director"],
        match_mode: "EXACT",
      },
      person_location_search: { include: ["France"] },
      person_seniority: { include: ["Director"] },
    },
    page: 1,
  });
  const selection = shortlist.items.slice(0, 1).map(selectedIdentity);
  assert.equal(selection.length >= 1 && selection.length <= 3, true);

  const identities = await executeOneEffectPage({
    adapter: prospeo,
    capability: PROSPEO_CONTACT_IDENTITY_CAPABILITY,
    contracts: PROSPEO_CONTACT_IDENTITY_CONTRACTS,
    effectLog: effects,
    operationKey: "v1-selected-identity",
    page: pageInput({
      capability: PROSPEO_CONTACT_IDENTITY_CAPABILITY,
      datasetId: IDENTITY_DATASET_ID,
      fields: identityFields,
      limits: {
        maxCalls: 1,
        maxCompanies: 0,
        maxContactsPerCompany: 0,
        maxContactsTotal: 1,
        maxEnrichments: 1,
        maxPages: 1,
        maxPhones: 0,
        maxResults: 1,
      },
      normalizedQuery: {
        result_kind: "contact_identity",
        selected_contacts: selection,
        source_dataset_id: SHORTLIST_DATASET_ID,
      },
      suffix: "selected-identity",
    }),
  });
  const shortlistItem = shortlist.items[0];
  const identityItem = identities.items[0];
  assert.ok(shortlistItem);
  assert.ok(identityItem);
  assert.equal(identityItem.record.recordId, shortlistItem.record.recordId);
  assert.deepEqual(identityItem.source, {
    datasetId: SHORTLIST_DATASET_ID,
    recordId: shortlistItem.record.recordId,
  });
  assert.deepEqual(
    identityItem.providerIdentity,
    shortlistItem.providerIdentity
  );
  const identityRequest = prospeoRequests.find(
    (request) => request.body.only_verified_email === false
  );
  assert.ok(identityRequest);
  assert.equal(identityRequest.pathname, "/enrich-person");
  assert.equal(identityRequest.method, "POST");
  assert.equal(identityRequest.headers.get("x-key"), PROSPEO_KEY);
  assert.equal(identityRequest.headers.get("x-api-key"), null);
  assert.deepEqual(identityRequest.body, {
    data: { person_id: "prospeo_subject_selected" },
    enrich_mobile: false,
    only_verified_email: false,
  });

  const resolvedEmails = await executeOneEffectPage({
    adapter: prospeo,
    capability: PROSPEO_WORK_EMAIL_RESOLVE_CAPABILITY,
    contracts: PROSPEO_WORK_EMAIL_CONTRACTS,
    effectLog: effects,
    operationKey: "v1-work-email-finder",
    page: pageInput({
      capability: PROSPEO_WORK_EMAIL_RESOLVE_CAPABILITY,
      datasetId: RESOLVED_DATASET_ID,
      fields: resolvedEmailFields,
      limits: {
        maxCalls: 1,
        maxCompanies: 0,
        maxContactsPerCompany: 0,
        maxContactsTotal: 1,
        maxEnrichments: 1,
        maxPages: 1,
        maxPhones: 0,
        maxResults: 1,
      },
      normalizedQuery: {
        operation_kind: "resolve",
        result_kind: "contact_work_email",
        selected_contacts: [selectedWorkEmail(identityItem, false)],
        source_dataset_id: IDENTITY_DATASET_ID,
      },
      suffix: "work-email-finder",
    }),
  });
  const resolvedItem = resolvedEmails.items[0];
  assert.ok(resolvedItem);
  assert.equal(resolvedItem.record.recordId, shortlistItem.record.recordId);
  assert.deepEqual(resolvedItem.source, {
    datasetId: IDENTITY_DATASET_ID,
    recordId: shortlistItem.record.recordId,
  });
  const resolvedValues = valuesByKey(resolvedItem, resolvedEmailFields);
  assert.equal(typeof resolvedValues.work_email, "string");
  assert.equal(
    (resolvedValues.work_email as string).split("@").at(-1),
    resolvedValues.organization_domain
  );
  assert.equal(resolvedValues.work_email_verification, "valid");
  const workEmailRequest = prospeoRequests.find(
    (request) => request.body.only_verified_email === true
  );
  assert.ok(workEmailRequest);
  assert.equal(workEmailRequest.pathname, "/enrich-person");
  assert.equal(workEmailRequest.method, "POST");
  assert.equal(workEmailRequest.headers.get("x-key"), PROSPEO_KEY);
  assert.equal(workEmailRequest.headers.get("x-api-key"), null);
  assert.deepEqual(workEmailRequest.body, {
    data: { person_id: "prospeo_subject_selected" },
    enrich_mobile: false,
    only_verified_email: true,
  });

  const verifiedEmails = await executeOneEffectPage({
    adapter: hunter,
    capability: HUNTER_WORK_EMAIL_VERIFY_CAPABILITY,
    contracts: HUNTER_WORK_EMAIL_CONTRACTS,
    effectLog: effects,
    operationKey: "v1-work-email-verifier",
    page: pageInput({
      capability: HUNTER_WORK_EMAIL_VERIFY_CAPABILITY,
      datasetId: VERIFIED_DATASET_ID,
      fields: verifiedEmailFields,
      limits: {
        maxCalls: 1,
        maxCompanies: 0,
        maxContactsPerCompany: 0,
        maxContactsTotal: 1,
        maxEnrichments: 1,
        maxPages: 1,
        maxPhones: 0,
        maxResults: 1,
      },
      normalizedQuery: {
        operation_kind: "verify",
        result_kind: "contact_work_email",
        selected_contacts: [selectedWorkEmail(resolvedItem, true)],
        source_dataset_id: RESOLVED_DATASET_ID,
      },
      suffix: "work-email-verifier",
    }),
  });
  const verifiedItem = verifiedEmails.items[0];
  assert.ok(verifiedItem);
  assert.equal(verifiedItem.record.recordId, shortlistItem.record.recordId);
  assert.deepEqual(verifiedItem.source, {
    datasetId: RESOLVED_DATASET_ID,
    recordId: shortlistItem.record.recordId,
  });
  assert.deepEqual(
    verifiedItem.providerIdentity,
    shortlistItem.providerIdentity
  );
  assert.equal(
    verifiedItem.providerIdentity?.providerKey,
    "prospeo-person-search"
  );

  assert.deepEqual(effects, [
    "/v2/discover",
    "/search-person",
    "/enrich-person",
    "/enrich-person",
    "/v2/email-verifier",
  ]);
  assert.equal(effects.length, 5);

  const finalValues = valuesByKey(verifiedItem, verifiedEmailFields);
  const expectedValues: Readonly<Record<string, unknown>> = {
    department: null,
    display_name: "Synthetic Person",
    first_name: "Synthetic",
    identity_completeness: "full",
    identity_observed_at_ms: 1300,
    identity_status: "found",
    job_title: "Sales Director",
    last_name: "Person",
    observed_at_ms: 1300,
    organization_domain: "synthetic.example",
    organization_id: company.record.recordId,
    organization_name: "Synthetic Company",
    person_country_code: "FR",
    profile_url: "https://www.linkedin.com/in/synthetic-person",
    seniority: "director",
    work_email: "synthetic.person@synthetic.example",
    work_email_confidence: 0.98,
    work_email_observed_at_ms: 1500,
    work_email_source: "provider_unspecified",
    work_email_status: "found",
    work_email_verification: "valid",
  };
  assert.deepEqual(finalValues, expectedValues);

  const finalRecord: DatasetRecord = {
    datasetId: verifiedItem.record.datasetId,
    recordId: verifiedItem.record.recordId,
    values: verifiedItem.record.values as DatasetRecord["values"],
    workspaceId: WORKSPACE_ID,
  };
  const exportFields = WORK_EMAIL_FIELD_DEFINITIONS.map(
    ([key, , valueType]) => ({
      fieldId: `field-${key}`,
      key,
      valueType,
    })
  );
  const reversedRecord: DatasetRecord = {
    ...finalRecord,
    values: [...finalRecord.values].reverse(),
  };
  const csv = await encode(createCsvDatasetCodec(), finalRecord, exportFields);
  const csvFromReversed = await encode(
    createCsvDatasetCodec(),
    reversedRecord,
    exportFields
  );
  const jsonl = await encode(
    createJsonlDatasetCodec(),
    finalRecord,
    exportFields
  );
  const jsonlFromReversed = await encode(
    createJsonlDatasetCodec(),
    reversedRecord,
    exportFields
  );
  assert.equal(csv, csvFromReversed);
  assert.equal(jsonl, jsonlFromReversed);

  const expectedCsv = [
    `record_id,${WORK_EMAIL_FIELD_DEFINITIONS.map(([key]) => key).join(",")}`,
    [
      finalRecord.recordId,
      ...WORK_EMAIL_FIELD_DEFINITIONS.map(([key]) => expectedValues[key] ?? ""),
    ].join(","),
    "",
  ].join("\r\n");
  assert.equal(csv, expectedCsv);
  const expectedJsonl = `${JSON.stringify({
    dataset_id: VERIFIED_DATASET_ID,
    record_id: finalRecord.recordId,
    values: WORK_EMAIL_FIELD_DEFINITIONS.map(([key]) => ({
      field_id: `field-${key}`,
      value: expectedValues[key],
    })),
    workspace_id: WORKSPACE_ID,
  })}\n`;
  assert.equal(jsonl, expectedJsonl);

  const publicSurface = JSON.stringify({
    companies,
    finalRecord,
    identities,
    resolvedEmails,
    shortlist,
    verifiedItem,
  });
  for (const forbidden of [
    HUNTER_KEY,
    PROSPEO_KEY,
    PERSONAL_EMAIL_CANARY,
    PHONE_CANARY,
    RAW_CANARY,
    "personal_email",
    "phone_number",
    "verification_method",
  ]) {
    assert.equal(publicSurface.includes(forbidden), false);
    assert.equal(csv.includes(forbidden), false);
    assert.equal(jsonl.includes(forbidden), false);
  }
  assert.equal(
    finalRecord.values.some((entry) => entry.fieldId.includes("phone")),
    false
  );
  assert.equal(
    finalRecord.values.some((entry) =>
      entry.fieldId.includes("personal_email")
    ),
    false
  );
});
