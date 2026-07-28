import {
  type ContactIdentityResolution,
  createContactIdentityResolution,
} from "@kurobara/kernel";
import {
  definePluginAdapter,
  type PluginAdapterV1,
  type PluginClassifyErrorRequest,
  type PluginContractRef,
  type PluginExecuteRequest,
  type PluginExecuteResult,
  type PluginManifestV1,
  type PluginNormalizeResult,
  validatePluginJson,
} from "@kurobara/plugin-sdk";
import type {
  ContactIdentityProviderPort,
  ContactProviderEffectResult,
} from "@kurobara/ports";

const ENDPOINT = "https://api.apollo.io/api/v1/mixed_people/api_search";
const PEOPLE_MATCH_ENDPOINT = "https://api.apollo.io/api/v1/people/match";
const HOSTNAME = "api.apollo.io";
const PROVIDER_KEY = "apollo-people-search";
const EXECUTE_TIMEOUT_MS = 10_000;
const LOOKUP_TIMEOUT_MS = 1000;
const MAX_API_KEY_LENGTH = 4096;
const MAX_RESPONSE_BYTES = 524_288;
const MAX_RETRY_AFTER_MS = 86_400_000;
const MAX_COMPANIES = 10;
const MAX_CONTACTS_PER_COMPANY = 2;
const MAX_CONTACTS_TOTAL = 12;
const MAX_IDENTITY_SELECTION = 3;
const MAX_FILTER_VALUES = 32;
const CATALOG_VERSION = "0.13.0";

// Build-time bindings to the canonical dataset-generation page contracts.
// They intentionally avoid a runtime dependency on the contracts workspace.
export const APOLLO_CATALOG_FINGERPRINT =
  "sha256:26211b3954f9c88b24608746d744f15a870330809df021cd6fcd56499591d921";
const DATASET_GENERATION_PAGE_INPUT_SCHEMA_FINGERPRINT =
  "sha256:40153b13ed33d9bf086dcfde537ce1e17946b0e82b6e0461683c42c24a382a55";
const DATASET_GENERATION_PAGE_INPUT_SCHEMA_ID =
  "https://schemas.kurobara.invalid/schemas/dataset-generations/page-input/1.0.0";
const DATASET_GENERATION_PAGE_OUTPUT_SCHEMA_FINGERPRINT =
  "sha256:f61bef0f513210cf17c84fd53aad2c1624a6913a732e98597056a442bc589ab3";
const DATASET_GENERATION_PAGE_OUTPUT_SCHEMA_ID =
  "https://schemas.kurobara.invalid/schemas/dataset-generations/page-output/1.0.0";

export const APOLLO_CONTACT_DISCOVERY_CAPABILITY = Object.freeze({
  capabilityId: "contacts.discover",
  capabilityVersion: "1.0.0",
});

export const APOLLO_CONTACT_IDENTITY_CAPABILITY = Object.freeze({
  capabilityId: "contacts.identity.reveal",
  capabilityVersion: "1.0.0",
});

export const APOLLO_CONTACT_DISCOVERY_CONTRACTS = Object.freeze({
  input: Object.freeze({
    catalogFingerprint: APOLLO_CATALOG_FINGERPRINT,
    catalogVersion: CATALOG_VERSION,
    schemaFingerprint: DATASET_GENERATION_PAGE_INPUT_SCHEMA_FINGERPRINT,
    schemaId: DATASET_GENERATION_PAGE_INPUT_SCHEMA_ID,
    schemaVersion: "1.0.0",
  }),
  output: Object.freeze({
    catalogFingerprint: APOLLO_CATALOG_FINGERPRINT,
    catalogVersion: CATALOG_VERSION,
    schemaFingerprint: DATASET_GENERATION_PAGE_OUTPUT_SCHEMA_FINGERPRINT,
    schemaId: DATASET_GENERATION_PAGE_OUTPUT_SCHEMA_ID,
    schemaVersion: "1.0.0",
  }),
}) satisfies Readonly<{
  input: PluginContractRef;
  output: PluginContractRef;
}>;

// Identity reveal uses the same provider-neutral page envelope. The canonical
// catalog extends this schema binding atomically with the capability rollout.
export const APOLLO_CONTACT_IDENTITY_CONTRACTS =
  APOLLO_CONTACT_DISCOVERY_CONTRACTS;

const EXPECTED_FIELDS = Object.freeze({
  department: "string",
  display_name: "string",
  identity_completeness: "string",
  job_title: "string",
  observed_at_ms: "number",
  organization_domain: "string",
  organization_id: "string",
  organization_name: "string",
  person_country_code: "string",
  profile_url: "string",
  seniority: "string",
} as const);

const IDENTITY_EXPECTED_FIELDS = Object.freeze({
  department: "string",
  display_name: "string",
  first_name: "string",
  identity_completeness: "string",
  identity_observed_at_ms: "number",
  identity_status: "string",
  job_title: "string",
  last_name: "string",
  observed_at_ms: "number",
  organization_domain: "string",
  organization_id: "string",
  organization_name: "string",
  person_country_code: "string",
  profile_url: "string",
  seniority: "string",
} as const);

const INPUT_KEYS = Object.freeze([
  "capability",
  "datasetId",
  "fields",
  "generationId",
  "generationPlanId",
  "inputCursor",
  "kind",
  "limits",
  "normalizedQuery",
  "pageSequence",
  "planHash",
  "queryHash",
  "schemaHash",
  "version",
  "workspaceId",
] as const);

const LIMIT_KEYS = Object.freeze([
  "maxCalls",
  "maxCompanies",
  "maxContactsPerCompany",
  "maxContactsTotal",
  "maxEnrichments",
  "maxPages",
  "maxPhones",
  "maxResults",
] as const);

const FIELD_KEYS = Object.freeze([
  "datasetId",
  "fieldId",
  "key",
  "label",
  "valueType",
  "workspaceId",
] as const);

const QUERY_KEYS = Object.freeze([
  "company_headquarters_country_codes",
  "departments",
  "organization_source",
  "organizations",
  "person_country_codes",
  "result_kind",
  "seniorities",
  "titles",
] as const);

const IDENTITY_QUERY_KEYS = Object.freeze([
  "result_kind",
  "selected_contacts",
  "source_dataset_id",
] as const);

const SELECTED_CONTACT_KEYS = Object.freeze([
  "candidate",
  "provider_identity",
  "source_record_id",
] as const);

const PROVIDER_IDENTITY_KEYS = Object.freeze([
  "provider_key",
  "provider_subject_id",
] as const);

const IDENTITY_CANDIDATE_KEYS = Object.freeze([
  "department",
  "display_name",
  "identity_completeness",
  "job_title",
  "observed_at_ms",
  "organization_domain",
  "organization_id",
  "organization_name",
  "person_country_code",
  "profile_url",
  "seniority",
] as const);

const ORGANIZATION_KEYS = Object.freeze([
  "company_id",
  "country_code",
  "domain",
  "name",
] as const);

const APOLLO_PERSON_KEYS = Object.freeze([
  "first_name",
  "has_city",
  "has_country",
  "has_direct_phone",
  "has_email",
  "has_state",
  "id",
  "last_name_obfuscated",
  "last_refreshed_at",
  "organization",
  "title",
] as const);

const APOLLO_ORGANIZATION_KEYS = Object.freeze([
  "has_city",
  "has_country",
  "has_employee_count",
  "has_industry",
  "has_phone",
  "has_revenue",
  "has_state",
  "has_zip_code",
  "name",
] as const);

const CONTACT_FIELD_ORDER = Object.freeze(Object.keys(EXPECTED_FIELDS));
const IDENTITY_FIELD_ORDER = Object.freeze(
  Object.keys(IDENTITY_EXPECTED_FIELDS)
);
const HASH_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const COUNTRY_PATTERN = /^[A-Z]{2}$/u;
const TAXONOMY_PATTERN = /^[a-z][a-z0-9._-]{0,127}$/u;
const DOMAIN_LABEL_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;
const PROVIDER_SUBJECT_PATTERN = /^[A-Za-z0-9_-]{1,160}$/u;
const UNSIGNED_INTEGER_PATTERN = /^\d+$/u;
const ORGANIZATION_CURSOR_PATTERN = /^organization:([1-9]\d*)$/u;
const CONTACT_CURSOR_PATTERN = /^contact:([1-9]\d*)$/u;
const LINKEDIN_PROFILE_PATH_PATTERN = /^\/in\/[^/]+\/?$/u;
const JSON_CONTENT_TYPE_PATTERN =
  /^application\/[a-z0-9!#$&^_.+-]*\+?json(?:\s*;|$)/u;

const SENIORITIES = new Set([
  "owner",
  "c_suite",
  "vp",
  "director",
  "manager",
  "senior",
  "individual_contributor",
]);

const COUNTRY_DISPLAY_NAMES = new Intl.DisplayNames(["en"], {
  type: "region",
});

type JsonRecord = Record<string, unknown>;
type ApolloClock = Readonly<{ now: () => number }>;

type DatasetGenerationField = Readonly<{
  datasetId: string;
  fieldId: string;
  key: string;
  label: string;
  valueType: "boolean" | "number" | "string";
  workspaceId: string;
}>;

type DatasetGenerationLimits = Readonly<{
  maxCalls: number;
  maxCompanies: number;
  maxContactsPerCompany: number;
  maxContactsTotal: number;
  maxEnrichments: number;
  maxPages: number;
  maxPhones: number;
  maxResults: number;
}>;

type ContactOrganization = Readonly<{
  company_id: string;
  country_code: string;
  domain: null | string;
  name: string;
}>;

type ContactSeniority =
  | "owner"
  | "c_suite"
  | "vp"
  | "director"
  | "manager"
  | "senior"
  | "individual_contributor";

type ContactDiscoveryQuery = Readonly<{
  company_headquarters_country_codes: readonly string[];
  departments: readonly string[];
  organization_source: JsonRecord;
  organizations: readonly ContactOrganization[];
  person_country_codes: readonly string[];
  result_kind: "contact";
  seniorities: readonly ContactSeniority[];
  titles: readonly string[];
}>;

type ContactIdentityCandidate = Readonly<{
  department: null | string;
  display_name: string;
  identity_completeness: "obfuscated";
  job_title: string;
  observed_at_ms: number;
  organization_domain: string;
  organization_id: string;
  organization_name: string;
  person_country_code: null | string;
  profile_url: null | string;
  seniority: ContactSeniority | null;
}>;

type SelectedContactIdentity = Readonly<{
  candidate: ContactIdentityCandidate;
  provider_identity: Readonly<{
    provider_key: typeof PROVIDER_KEY;
    provider_subject_id: string;
  }>;
  source_record_id: string;
}>;

type ContactIdentityQuery = Readonly<{
  result_kind: "contact_identity";
  selected_contacts: readonly SelectedContactIdentity[];
  source_dataset_id: string;
}>;

type DatasetGenerationPageInput = Readonly<{
  capability: typeof APOLLO_CONTACT_DISCOVERY_CAPABILITY;
  datasetId: string;
  fields: readonly DatasetGenerationField[];
  generationId: string;
  generationPlanId: string;
  inputCursor: null | string;
  kind: "dataset-generation-page-input";
  limits: DatasetGenerationLimits;
  normalizedQuery: ContactDiscoveryQuery;
  pageSequence: number;
  planHash: string;
  queryHash: string;
  schemaHash: string;
  version: "1.0.0";
  workspaceId: string;
}>;

type ContactIdentityPageInput = Readonly<{
  capability: typeof APOLLO_CONTACT_IDENTITY_CAPABILITY;
  datasetId: string;
  fields: readonly DatasetGenerationField[];
  generationId: string;
  generationPlanId: string;
  inputCursor: null | string;
  kind: "dataset-generation-page-input";
  limits: DatasetGenerationLimits;
  normalizedQuery: ContactIdentityQuery;
  pageSequence: number;
  planHash: string;
  queryHash: string;
  schemaHash: string;
  version: "1.0.0";
  workspaceId: string;
}>;

type ContactCandidate = Readonly<{
  department: null | string;
  display_name: string;
  identity_completeness: "obfuscated";
  job_title: string;
  observed_at_ms: number;
  organization_domain: string;
  organization_id: string;
  organization_name: string;
  person_country_code: null | string;
  profile_url: null;
  seniority: ContactSeniority | null;
}>;

type DatasetGenerationRecord = Readonly<{
  datasetId: string;
  recordId: string;
  values: readonly Readonly<{
    fieldId: string;
    value: boolean | null | number | string;
  }>[];
  workspaceId: string;
}>;

type DatasetGenerationPageOutput = Readonly<{
  hasMore: boolean;
  items: readonly Readonly<{
    contentHash: string;
    providerIdentity: Readonly<{
      providerKey: typeof PROVIDER_KEY;
      providerSubjectId: string;
    }>;
    record: DatasetGenerationRecord;
    source?: Readonly<{
      datasetId: string;
      recordId: string;
    }>;
  }>[];
  nextCursor: null | string;
  sourcePartitionCompleted: boolean;
  version: "1.0.0";
}>;

type ApolloPerson = Readonly<{
  firstName: string;
  id: string;
  jobTitle: string | null;
  lastNameObfuscated: string;
  lastRefreshedAtMs: number;
  organizationName: string;
}>;

type ApolloSearchResponse = Readonly<{
  people: readonly ApolloPerson[];
  totalEntries: number;
}>;

type ParsedInput = Readonly<{
  input: DatasetGenerationPageInput;
  organization: ContactOrganization;
  organizationIndex: number;
  query: ContactDiscoveryQuery;
  requestCount: number;
}>;

type ParsedIdentityInput = Readonly<{
  input: ContactIdentityPageInput;
  query: ContactIdentityQuery;
  selectedContact: SelectedContactIdentity;
  selectedContactIndex: number;
}>;

export type ApolloProviderOptions = Readonly<{
  apiKey: string;
  clock?: ApolloClock;
  fetch?: typeof fetch;
}>;

export class ApolloProviderConfigurationError extends Error {
  readonly reasonCode = "provider-apollo-configuration-invalid" as const;

  constructor() {
    super("Apollo provider configuration is invalid.");
    this.name = "ApolloProviderConfigurationError";
  }
}

const plainRecord = (value: unknown): value is JsonRecord =>
  value !== null &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  (Object.getPrototypeOf(value) === Object.prototype ||
    Object.getPrototypeOf(value) === null);

const hasExactKeys = (
  value: JsonRecord,
  expected: readonly string[]
): boolean => {
  const actual = Object.keys(value).sort();
  const sorted = [...expected].sort();
  return (
    actual.length === sorted.length &&
    actual.every((key, index) => key === sorted[index])
  );
};

const boundedText = (value: unknown, maximum: number): value is string =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= maximum &&
  value.trim() === value;

const boundedInteger = (
  value: unknown,
  minimum: number,
  maximum: number
): value is number =>
  typeof value === "number" &&
  Number.isSafeInteger(value) &&
  value >= minimum &&
  value <= maximum;

const uniqueStrings = (
  value: unknown,
  options: Readonly<{
    maximumCount: number;
    maximumLength: number;
    pattern?: RegExp;
  }>
): value is readonly string[] =>
  Array.isArray(value) &&
  value.length <= options.maximumCount &&
  value.every(
    (entry) =>
      boundedText(entry, options.maximumLength) &&
      (options.pattern === undefined || options.pattern.test(entry))
  ) &&
  new Set(value).size === value.length;

const apiKeyIsValid = (value: unknown): value is string =>
  boundedText(value, MAX_API_KEY_LENGTH) &&
  !Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f);
  });

const normalizeDomain = (value: unknown): string | undefined => {
  if (typeof value !== "string" || value.trim() !== value) {
    return;
  }
  const domain = value.toLowerCase();
  if (
    domain.length > 253 ||
    domain.endsWith(".") ||
    domain.includes("..") ||
    domain.includes(":") ||
    domain.includes("/") ||
    domain.includes("@") ||
    domain.includes("?") ||
    domain.includes("#")
  ) {
    return;
  }
  const labels = domain.split(".");
  return labels.length >= 2 &&
    labels.every((label) => DOMAIN_LABEL_PATTERN.test(label))
    ? domain
    : undefined;
};

const secureHttpsUrl = (value: unknown): value is string => {
  if (!boundedText(value, 2048)) {
    return false;
  }
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      url.hostname.length > 0 &&
      url.username.length === 0 &&
      url.password.length === 0 &&
      url.port.length === 0
    );
  } catch {
    return false;
  }
};

const safeNow = (clock: ApolloClock): number => {
  const value = clock.now();
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
};

const limitsAreValid = (value: unknown): value is DatasetGenerationLimits =>
  plainRecord(value) &&
  hasExactKeys(value, LIMIT_KEYS) &&
  LIMIT_KEYS.every((key) =>
    boundedInteger(value[key], 0, Number.MAX_SAFE_INTEGER)
  ) &&
  boundedInteger(value.maxCalls, 1, 10_000) &&
  boundedInteger(value.maxCompanies, 1, MAX_COMPANIES) &&
  boundedInteger(value.maxContactsPerCompany, 1, MAX_CONTACTS_PER_COMPANY) &&
  boundedInteger(value.maxContactsTotal, 1, MAX_CONTACTS_TOTAL) &&
  value.maxContactsTotal <= value.maxCompanies * value.maxContactsPerCompany &&
  value.maxEnrichments === 0 &&
  boundedInteger(value.maxPages, 1, 10_000) &&
  value.maxPhones === 0 &&
  boundedInteger(value.maxResults, 1, MAX_CONTACTS_TOTAL);

const identityLimitsAreValid = (
  value: unknown,
  selectionCount: number,
  selectionIndex: number
): value is DatasetGenerationLimits =>
  plainRecord(value) &&
  hasExactKeys(value, LIMIT_KEYS) &&
  LIMIT_KEYS.every((key) =>
    boundedInteger(value[key], 0, Number.MAX_SAFE_INTEGER)
  ) &&
  value.maxCalls === selectionCount &&
  value.maxCompanies === 0 &&
  value.maxContactsPerCompany === 0 &&
  value.maxContactsTotal === selectionCount &&
  value.maxEnrichments === selectionCount &&
  value.maxPages === selectionCount &&
  value.maxPhones === 0 &&
  value.maxResults === selectionCount - selectionIndex;

const fieldsMatch = (
  value: unknown,
  datasetId: string,
  workspaceId: string,
  expectedFields: Readonly<Record<string, "boolean" | "number" | "string">>
): value is readonly DatasetGenerationField[] => {
  if (
    !Array.isArray(value) ||
    value.length !== Object.keys(expectedFields).length
  ) {
    return false;
  }
  const seenKeys = new Set<string>();
  const seenFieldIds = new Set<string>();
  for (const field of value) {
    if (
      !(plainRecord(field) && hasExactKeys(field, FIELD_KEYS)) ||
      field.datasetId !== datasetId ||
      field.workspaceId !== workspaceId ||
      !boundedText(field.fieldId, 255) ||
      !boundedText(field.label, 255) ||
      typeof field.key !== "string" ||
      !Object.hasOwn(expectedFields, field.key) ||
      field.valueType !== expectedFields[field.key] ||
      seenKeys.has(field.key) ||
      seenFieldIds.has(field.fieldId)
    ) {
      return false;
    }
    seenKeys.add(field.key);
    seenFieldIds.add(field.fieldId);
  }
  return seenKeys.size === Object.keys(expectedFields).length;
};

const fieldsAreValid = (
  value: unknown,
  datasetId: string,
  workspaceId: string
): value is readonly DatasetGenerationField[] =>
  fieldsMatch(value, datasetId, workspaceId, EXPECTED_FIELDS);

const identityFieldsAreValid = (
  value: unknown,
  datasetId: string,
  workspaceId: string
): value is readonly DatasetGenerationField[] =>
  fieldsMatch(value, datasetId, workspaceId, IDENTITY_EXPECTED_FIELDS);

const parseOrganizations = (
  value: unknown,
  maximum: number
): readonly ContactOrganization[] | undefined => {
  if (!Array.isArray(value) || value.length < 1 || value.length > maximum) {
    return;
  }
  const organizations: ContactOrganization[] = [];
  const companyIds = new Set<string>();
  const domains = new Set<string>();
  for (const item of value) {
    if (
      !(
        plainRecord(item) &&
        hasExactKeys(item, ORGANIZATION_KEYS) &&
        boundedText(item.company_id, 255) &&
        boundedText(item.name, 255) &&
        typeof item.country_code === "string" &&
        COUNTRY_PATTERN.test(item.country_code) &&
        (item.domain === null || typeof item.domain === "string")
      ) ||
      companyIds.has(item.company_id)
    ) {
      return;
    }
    const domain = item.domain === null ? null : normalizeDomain(item.domain);
    if (
      (item.domain !== null && domain === undefined) ||
      (domain !== null && domain !== undefined && domains.has(domain))
    ) {
      return;
    }
    companyIds.add(item.company_id);
    if (domain !== null && domain !== undefined) {
      domains.add(domain);
    }
    organizations.push({
      company_id: item.company_id,
      country_code: item.country_code,
      domain: domain ?? null,
      name: item.name,
    });
  }
  return organizations;
};

const parseQuery = (
  value: unknown,
  maximumCompanies: number
): ContactDiscoveryQuery | undefined => {
  if (!(plainRecord(value) && hasExactKeys(value, QUERY_KEYS))) {
    return;
  }
  const organizations = parseOrganizations(
    value.organizations,
    maximumCompanies
  );
  if (
    organizations === undefined ||
    !(
      plainRecord(value.organization_source) &&
      ((value.organization_source.kind === "generation" &&
        boundedText(value.organization_source.generation_id, 255)) ||
        (value.organization_source.kind === "dataset" &&
          boundedText(value.organization_source.dataset_id, 255) &&
          boundedText(value.organization_source.materialization_id, 255)))
    ) ||
    value.result_kind !== "contact" ||
    !uniqueStrings(value.company_headquarters_country_codes, {
      maximumCount: MAX_FILTER_VALUES,
      maximumLength: 2,
      pattern: COUNTRY_PATTERN,
    }) ||
    !uniqueStrings(value.person_country_codes, {
      maximumCount: MAX_FILTER_VALUES,
      maximumLength: 2,
      pattern: COUNTRY_PATTERN,
    }) ||
    !uniqueStrings(value.departments, {
      maximumCount: MAX_FILTER_VALUES,
      maximumLength: 128,
      pattern: TAXONOMY_PATTERN,
    }) ||
    !uniqueStrings(value.titles, {
      maximumCount: MAX_FILTER_VALUES,
      maximumLength: 128,
    }) ||
    !uniqueStrings(value.seniorities, {
      maximumCount: 16,
      maximumLength: 32,
    }) ||
    !value.seniorities.every((entry) => SENIORITIES.has(entry)) ||
    value.departments.length !== 0 ||
    value.seniorities.includes("individual_contributor")
  ) {
    return;
  }
  return {
    company_headquarters_country_codes:
      value.company_headquarters_country_codes,
    departments: value.departments,
    organization_source: value.organization_source,
    organizations,
    person_country_codes: value.person_country_codes,
    result_kind: "contact",
    seniorities: value.seniorities as readonly ContactSeniority[],
    titles: value.titles,
  };
};

const parseInput = (value: unknown): ParsedInput | undefined => {
  if (!(plainRecord(value) && hasExactKeys(value, INPUT_KEYS))) {
    return;
  }
  const datasetId = boundedText(value.datasetId, 255)
    ? value.datasetId
    : undefined;
  const workspaceId = boundedText(value.workspaceId, 255)
    ? value.workspaceId
    : undefined;
  if (
    datasetId === undefined ||
    workspaceId === undefined ||
    !limitsAreValid(value.limits) ||
    !plainRecord(value.capability) ||
    !hasExactKeys(value.capability, ["capabilityId", "capabilityVersion"]) ||
    value.capability.capabilityId !==
      APOLLO_CONTACT_DISCOVERY_CAPABILITY.capabilityId ||
    value.capability.capabilityVersion !==
      APOLLO_CONTACT_DISCOVERY_CAPABILITY.capabilityVersion ||
    value.kind !== "dataset-generation-page-input" ||
    value.version !== "1.0.0" ||
    !boundedInteger(value.pageSequence, 1, MAX_COMPANIES) ||
    !(value.inputCursor === null || boundedText(value.inputCursor, 64)) ||
    !boundedText(value.generationId, 255) ||
    !boundedText(value.generationPlanId, 255) ||
    !fieldsAreValid(value.fields, datasetId, workspaceId) ||
    typeof value.planHash !== "string" ||
    !HASH_PATTERN.test(value.planHash) ||
    typeof value.queryHash !== "string" ||
    !HASH_PATTERN.test(value.queryHash) ||
    typeof value.schemaHash !== "string" ||
    !HASH_PATTERN.test(value.schemaHash)
  ) {
    return;
  }
  const query = parseQuery(value.normalizedQuery, value.limits.maxCompanies);
  if (query === undefined) {
    return;
  }
  const cursorMatch =
    value.inputCursor === null
      ? null
      : ORGANIZATION_CURSOR_PATTERN.exec(value.inputCursor);
  const organizationIndex =
    value.inputCursor === null ? 0 : Number(cursorMatch?.[1]);
  if (
    !Number.isSafeInteger(organizationIndex) ||
    organizationIndex < 0 ||
    organizationIndex >= query.organizations.length ||
    value.pageSequence !== organizationIndex + 1
  ) {
    return;
  }
  const organization = query.organizations[organizationIndex];
  if (organization === undefined) {
    return;
  }
  return {
    input: value as unknown as DatasetGenerationPageInput,
    organization,
    organizationIndex,
    query,
    requestCount: organization.domain === null ? 0 : 1,
  };
};

const candidateIdentityIsValid = (
  value: unknown
): value is ContactIdentityCandidate => {
  if (!(plainRecord(value) && hasExactKeys(value, IDENTITY_CANDIDATE_KEYS))) {
    return false;
  }
  const normalizedOrganizationDomain = normalizeDomain(
    value.organization_domain
  );
  return (
    (value.department === null ||
      (boundedText(value.department, 128) &&
        TAXONOMY_PATTERN.test(value.department))) &&
    boundedText(value.display_name, 255) &&
    value.identity_completeness === "obfuscated" &&
    boundedText(value.job_title, 255) &&
    boundedInteger(value.observed_at_ms, 0, Number.MAX_SAFE_INTEGER) &&
    typeof value.organization_domain === "string" &&
    normalizedOrganizationDomain === value.organization_domain &&
    boundedText(value.organization_id, 255) &&
    boundedText(value.organization_name, 255) &&
    (value.person_country_code === null ||
      (typeof value.person_country_code === "string" &&
        COUNTRY_PATTERN.test(value.person_country_code))) &&
    (value.profile_url === null || secureHttpsUrl(value.profile_url)) &&
    (value.seniority === null ||
      (typeof value.seniority === "string" && SENIORITIES.has(value.seniority)))
  );
};

const parseIdentityQuery = (
  value: unknown
): ContactIdentityQuery | undefined => {
  if (
    !(
      plainRecord(value) &&
      hasExactKeys(value, IDENTITY_QUERY_KEYS) &&
      value.result_kind === "contact_identity" &&
      boundedText(value.source_dataset_id, 255) &&
      Array.isArray(value.selected_contacts) &&
      value.selected_contacts.length >= 1 &&
      value.selected_contacts.length <= MAX_IDENTITY_SELECTION
    )
  ) {
    return;
  }
  const selectedContacts: SelectedContactIdentity[] = [];
  const recordIds = new Set<string>();
  const providerSubjectIds = new Set<string>();
  for (const selected of value.selected_contacts) {
    if (
      !(
        plainRecord(selected) &&
        hasExactKeys(selected, SELECTED_CONTACT_KEYS) &&
        boundedText(selected.source_record_id, 255) &&
        !recordIds.has(selected.source_record_id) &&
        candidateIdentityIsValid(selected.candidate) &&
        plainRecord(selected.provider_identity) &&
        hasExactKeys(selected.provider_identity, PROVIDER_IDENTITY_KEYS) &&
        selected.provider_identity.provider_key === PROVIDER_KEY &&
        typeof selected.provider_identity.provider_subject_id === "string" &&
        PROVIDER_SUBJECT_PATTERN.test(
          selected.provider_identity.provider_subject_id
        ) &&
        !providerSubjectIds.has(selected.provider_identity.provider_subject_id)
      )
    ) {
      return;
    }
    recordIds.add(selected.source_record_id);
    providerSubjectIds.add(selected.provider_identity.provider_subject_id);
    selectedContacts.push({
      candidate: selected.candidate,
      provider_identity: {
        provider_key: PROVIDER_KEY,
        provider_subject_id: selected.provider_identity.provider_subject_id,
      },
      source_record_id: selected.source_record_id,
    });
  }
  return {
    result_kind: "contact_identity",
    selected_contacts: selectedContacts,
    source_dataset_id: value.source_dataset_id,
  };
};

const parseIdentityInput = (
  value: unknown
): ParsedIdentityInput | undefined => {
  if (!(plainRecord(value) && hasExactKeys(value, INPUT_KEYS))) {
    return;
  }
  const datasetId = boundedText(value.datasetId, 255)
    ? value.datasetId
    : undefined;
  const workspaceId = boundedText(value.workspaceId, 255)
    ? value.workspaceId
    : undefined;
  const query = parseIdentityQuery(value.normalizedQuery);
  if (
    datasetId === undefined ||
    workspaceId === undefined ||
    query === undefined ||
    datasetId === query.source_dataset_id ||
    !plainRecord(value.capability) ||
    !hasExactKeys(value.capability, ["capabilityId", "capabilityVersion"]) ||
    value.capability.capabilityId !==
      APOLLO_CONTACT_IDENTITY_CAPABILITY.capabilityId ||
    value.capability.capabilityVersion !==
      APOLLO_CONTACT_IDENTITY_CAPABILITY.capabilityVersion ||
    value.kind !== "dataset-generation-page-input" ||
    value.version !== "1.0.0" ||
    !(value.inputCursor === null || boundedText(value.inputCursor, 64)) ||
    !boundedText(value.generationId, 255) ||
    !boundedText(value.generationPlanId, 255) ||
    !identityFieldsAreValid(value.fields, datasetId, workspaceId) ||
    typeof value.planHash !== "string" ||
    !HASH_PATTERN.test(value.planHash) ||
    typeof value.queryHash !== "string" ||
    !HASH_PATTERN.test(value.queryHash) ||
    typeof value.schemaHash !== "string" ||
    !HASH_PATTERN.test(value.schemaHash)
  ) {
    return;
  }
  const cursorMatch =
    value.inputCursor === null
      ? null
      : CONTACT_CURSOR_PATTERN.exec(value.inputCursor);
  const selectedContactIndex =
    value.inputCursor === null ? 0 : Number(cursorMatch?.[1]);
  if (
    !Number.isSafeInteger(selectedContactIndex) ||
    selectedContactIndex < 0 ||
    selectedContactIndex >= query.selected_contacts.length ||
    value.pageSequence !== selectedContactIndex + 1 ||
    !identityLimitsAreValid(
      value.limits,
      query.selected_contacts.length,
      selectedContactIndex
    )
  ) {
    return;
  }
  const selectedContact = query.selected_contacts[selectedContactIndex];
  if (selectedContact === undefined) {
    return;
  }
  return {
    input: value as unknown as ContactIdentityPageInput,
    query,
    selectedContact,
    selectedContactIndex,
  };
};

const canonicalize = (value: unknown): string => {
  if (value === null || typeof value !== "object") {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) {
      throw new TypeError("Expected a JSON value.");
    }
    return encoded;
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalize(entry)).join(",")}]`;
  }
  const record = value as Readonly<Record<string, unknown>>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalize(record[key])}`)
    .join(",")}}`;
};

const sha256Hex = async (value: string): Promise<string> => {
  const digest = await globalThis.crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value)
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
};

const hash = async (value: unknown): Promise<`sha256:${string}`> =>
  `sha256:${await sha256Hex(canonicalize(value))}`;

const countryLocation = (code: string): string =>
  COUNTRY_DISPLAY_NAMES.of(code) ?? code;

const requestUrl = (
  organization: ContactOrganization & Readonly<{ domain: string }>,
  query: ContactDiscoveryQuery,
  perPage: number
): URL => {
  const url = new URL(ENDPOINT);
  url.searchParams.append("q_organization_domains_list[]", organization.domain);
  const titles = [
    ...new Set(
      query.titles.map((value) => value.normalize("NFC").toLowerCase())
    ),
  ];
  for (const title of titles) {
    url.searchParams.append("person_titles[]", title);
  }
  if (titles.length > 0) {
    url.searchParams.set("include_similar_titles", "false");
  }
  for (const seniority of query.seniorities) {
    url.searchParams.append("person_seniorities[]", seniority);
  }
  for (const country of query.person_country_codes) {
    url.searchParams.append("person_locations[]", countryLocation(country));
  }
  for (const country of query.company_headquarters_country_codes) {
    url.searchParams.append(
      "organization_locations[]",
      countryLocation(country)
    );
  }
  url.searchParams.set("page", "1");
  url.searchParams.set("per_page", String(perPage));
  return url;
};

const responseJson = async (
  response: Response,
  signal: AbortSignal
): Promise<unknown> => {
  const contentType = response.headers.get("content-type")?.toLowerCase();
  if (
    contentType === undefined ||
    !JSON_CONTENT_TYPE_PATTERN.test(contentType)
  ) {
    throw new TypeError("Expected JSON response.");
  }
  const declaredLength = response.headers.get("content-length");
  if (
    declaredLength !== null &&
    (!UNSIGNED_INTEGER_PATTERN.test(declaredLength) ||
      Number(declaredLength) > MAX_RESPONSE_BYTES)
  ) {
    throw new RangeError("Provider response is too large.");
  }
  const reader = response.body?.getReader();
  if (reader === undefined) {
    throw new TypeError("Provider response body is missing.");
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      if (signal.aborted) {
        throw new Error("aborted");
      }
      const chunk = await reader.read();
      if (chunk.done) {
        break;
      }
      size += chunk.value.byteLength;
      if (size > MAX_RESPONSE_BYTES) {
        throw new RangeError("Provider response is too large.");
      }
      chunks.push(chunk.value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
};

const parseRefreshedAt = (value: unknown): number | undefined => {
  if (!boundedText(value, 64)) {
    return;
  }
  const parsed = Date.parse(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
};

const availabilityFlagsAreValid = (value: JsonRecord): boolean =>
  typeof value.has_email === "boolean" &&
  typeof value.has_city === "boolean" &&
  typeof value.has_state === "boolean" &&
  typeof value.has_country === "boolean" &&
  boundedText(value.has_direct_phone, 128);

const organizationFlagsAreValid = (value: JsonRecord): boolean =>
  typeof value.has_industry === "boolean" &&
  typeof value.has_phone === "boolean" &&
  typeof value.has_city === "boolean" &&
  typeof value.has_state === "boolean" &&
  typeof value.has_country === "boolean" &&
  typeof value.has_zip_code === "boolean" &&
  typeof value.has_revenue === "boolean" &&
  typeof value.has_employee_count === "boolean";

const reducePerson = (value: unknown): ApolloPerson | undefined => {
  if (
    !(
      plainRecord(value) &&
      hasExactKeys(value, APOLLO_PERSON_KEYS) &&
      availabilityFlagsAreValid(value) &&
      PROVIDER_SUBJECT_PATTERN.test(String(value.id)) &&
      boundedText(value.first_name, 128) &&
      boundedText(value.last_name_obfuscated, 128) &&
      (value.title === null || boundedText(value.title, 255)) &&
      plainRecord(value.organization) &&
      hasExactKeys(value.organization, APOLLO_ORGANIZATION_KEYS) &&
      organizationFlagsAreValid(value.organization) &&
      boundedText(value.organization.name, 255)
    )
  ) {
    return;
  }
  const lastRefreshedAtMs = parseRefreshedAt(value.last_refreshed_at);
  if (lastRefreshedAtMs === undefined) {
    return;
  }
  return {
    firstName: value.first_name,
    id: String(value.id),
    jobTitle: value.title,
    lastNameObfuscated: value.last_name_obfuscated,
    lastRefreshedAtMs,
    organizationName: value.organization.name,
  };
};

const reduceResponse = (
  value: unknown,
  maximumRows: number
): ApolloSearchResponse | undefined => {
  const validated = validatePluginJson(value);
  if (!(validated.ok && plainRecord(validated.value))) {
    return;
  }
  const root = validated.value;
  if (
    !(
      hasExactKeys(root, ["people", "total_entries"]) &&
      Array.isArray(root.people)
    ) ||
    root.people.length > maximumRows ||
    !boundedInteger(root.total_entries, 0, Number.MAX_SAFE_INTEGER) ||
    root.total_entries < root.people.length
  ) {
    return;
  }
  const people: ApolloPerson[] = [];
  const ids = new Set<string>();
  for (const personValue of root.people) {
    const person = reducePerson(personValue);
    if (person === undefined || ids.has(person.id)) {
      return;
    }
    ids.add(person.id);
    people.push(person);
  }
  return { people, totalEntries: root.total_entries };
};

const comparableCompanyName = (value: string): string =>
  value
    .normalize("NFKC")
    .toLocaleLowerCase("en-US")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();

const companyNamesMatch = (left: string, right: string): boolean => {
  const normalizedLeft = comparableCompanyName(left);
  const normalizedRight = comparableCompanyName(right);
  return normalizedLeft === normalizedRight;
};

const candidateFor = (
  person: ApolloPerson,
  organization: ContactOrganization & Readonly<{ domain: string }>,
  query: ContactDiscoveryQuery
): ContactCandidate | undefined => {
  if (
    person.jobTitle === null ||
    !companyNamesMatch(person.organizationName, organization.name)
  ) {
    return;
  }
  const displayName = `${person.firstName} ${person.lastNameObfuscated}`;
  if (!boundedText(displayName, 255)) {
    return;
  }
  return {
    department: null,
    display_name: displayName,
    identity_completeness: "obfuscated",
    job_title: person.jobTitle,
    observed_at_ms: person.lastRefreshedAtMs,
    organization_domain: organization.domain,
    organization_id: organization.company_id,
    organization_name: organization.name,
    person_country_code:
      query.person_country_codes.length === 1
        ? (query.person_country_codes[0] ?? null)
        : null,
    profile_url: null,
    seniority:
      query.seniorities.length === 1 ? (query.seniorities[0] ?? null) : null,
  };
};

const fieldMap = (
  input: DatasetGenerationPageInput
): ReadonlyMap<string, DatasetGenerationField> =>
  new Map(input.fields.map((field) => [field.key, field]));

const recordFor = async (
  candidate: ContactCandidate,
  providerSubjectId: string,
  input: DatasetGenerationPageInput
): Promise<DatasetGenerationPageOutput["items"][number]> => {
  const fields = fieldMap(input);
  const values = CONTACT_FIELD_ORDER.map((key) => ({
    fieldId: fields.get(key)?.fieldId ?? "",
    value: candidate[key as keyof ContactCandidate],
  }));
  const record = {
    datasetId: input.datasetId,
    recordId: `contact_${await sha256Hex(
      `apollo-people-search\0${providerSubjectId}\0${candidate.organization_id}`
    )}`,
    values,
    workspaceId: input.workspaceId,
  };
  return {
    contentHash: await hash(record),
    providerIdentity: {
      providerKey: PROVIDER_KEY,
      providerSubjectId,
    },
    record,
  };
};

const retryAfterMs = (response: Response): number | undefined => {
  const value = response.headers.get("retry-after");
  if (value === null || !UNSIGNED_INTEGER_PATTERN.test(value)) {
    return;
  }
  const milliseconds = Number(value) * 1000;
  return Number.isSafeInteger(milliseconds) &&
    milliseconds <= MAX_RETRY_AFTER_MS
    ? milliseconds
    : undefined;
};

const failedResponse = (
  response: Response,
  requestCount: number
): PluginExecuteResult | undefined => {
  const usage = {
    amount: requestCount,
    basis: "exact" as const,
    unit: "requests",
  };
  if (response.status === 401) {
    return {
      error: { class: "authentication", reasonCode: "authentication-failed" },
      status: "failed",
      usage,
    };
  }
  if (response.status === 403) {
    return {
      error: { class: "authorization", reasonCode: "authorization-failed" },
      status: "failed",
      usage,
    };
  }
  if (response.status === 429) {
    const delay = retryAfterMs(response);
    return {
      error: {
        class: "rate-limit",
        reasonCode: "rate-limited",
        ...(delay === undefined ? {} : { retryAfterMs: delay }),
      },
      status: "failed",
      usage,
    };
  }
  if (response.status >= 500 && response.status <= 599) {
    return {
      error: { class: "provider", reasonCode: "provider-unavailable" },
      status: "failed",
      usage,
    };
  }
  if (response.status >= 400 && response.status <= 499) {
    return {
      error: { class: "provider", reasonCode: "provider-rejected" },
      status: "failed",
      usage,
    };
  }
};

const zeroUsage = Object.freeze({
  amount: 0,
  basis: "exact" as const,
  unit: "requests",
});

const executeDiscovery = async (options: {
  apiKey: string;
  clock: ApolloClock;
  fetch: typeof fetch;
  request: PluginExecuteRequest;
  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: one bounded page keeps validation, the single external effect, and outcome classification together.
}): Promise<PluginExecuteResult> => {
  const parsed = parseInput(options.request.input.value);
  if (parsed === undefined) {
    return {
      error: { class: "input", reasonCode: "input-invalid" },
      status: "failed",
      usage: zeroUsage,
    };
  }
  if (
    options.request.quote.upperBound === undefined ||
    options.request.quote.upperBound < parsed.requestCount
  ) {
    return {
      error: { class: "quota", reasonCode: "quota-exhausted" },
      status: "failed",
      usage: zeroUsage,
    };
  }
  const now = safeNow(options.clock);
  const deadlineAt = Math.min(
    options.request.context.deadlineAtMs,
    options.request.quote.expiresAtMs,
    now + EXECUTE_TIMEOUT_MS
  );
  if (deadlineAt <= now) {
    return {
      error: { class: "deadline", reasonCode: "deadline-exceeded" },
      status: "failed",
      usage: zeroUsage,
    };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deadlineAt - now);
  const items: DatasetGenerationPageOutput["items"][number][] = [];
  let requestCount = 0;
  const acceptedLimit = Math.min(
    parsed.input.limits.maxContactsPerCompany,
    parsed.input.limits.maxContactsTotal,
    parsed.input.limits.maxResults
  );
  try {
    const organization = parsed.organization;
    const domain = organization.domain;
    if (domain !== null) {
      let response: Response;
      try {
        response = await options.fetch(
          requestUrl({ ...organization, domain }, parsed.query, acceptedLimit),
          {
            headers: {
              accept: "application/json",
              "cache-control": "no-cache",
              "content-type": "application/json",
              "x-api-key": options.apiKey,
            },
            method: "POST",
            redirect: "error",
            signal: controller.signal,
          }
        );
        requestCount += 1;
      } catch {
        return {
          error: controller.signal.aborted
            ? { class: "deadline", reasonCode: "deadline-exceeded" }
            : { class: "transport", reasonCode: "transport-failed" },
          status: "outcome-unknown",
        };
      }
      if (controller.signal.aborted) {
        await response.body?.cancel().catch(() => undefined);
        return {
          error: { class: "deadline", reasonCode: "deadline-exceeded" },
          status: "outcome-unknown",
        };
      }
      const failed = failedResponse(response, requestCount);
      if (failed !== undefined) {
        await response.body?.cancel().catch(() => undefined);
        return failed;
      }
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        return {
          error: { class: "unknown", reasonCode: "unclassified" },
          status: "outcome-unknown",
        };
      }
      let reduced: ApolloSearchResponse | undefined;
      try {
        reduced = reduceResponse(
          await responseJson(response, controller.signal),
          acceptedLimit
        );
      } catch {
        reduced = undefined;
      }
      if (reduced === undefined) {
        return {
          error: controller.signal.aborted
            ? { class: "deadline", reasonCode: "deadline-exceeded" }
            : {
                class: "response",
                reasonCode: "provider-response-invalid",
              },
          status: "outcome-unknown",
        };
      }
      const companyItems = await Promise.all(
        reduced.people.map((person) => {
          const candidate = candidateFor(
            person,
            { ...organization, domain },
            parsed.query
          );
          return candidate === undefined
            ? undefined
            : recordFor(candidate, person.id, parsed.input);
        })
      );
      for (const item of companyItems) {
        if (item !== undefined && items.length < acceptedLimit) {
          items.push(await item);
        }
      }
    }
    const nextOrganizationIndex = parsed.organizationIndex + 1;
    const hasMore = nextOrganizationIndex < parsed.query.organizations.length;
    const output: DatasetGenerationPageOutput = {
      hasMore,
      items,
      nextCursor: hasMore ? `organization:${nextOrganizationIndex}` : null,
      sourcePartitionCompleted: !hasMore,
      version: "1.0.0",
    };
    return {
      providerPayload: output,
      status: "succeeded",
      usage: { amount: requestCount, basis: "exact", unit: "requests" },
    };
  } catch {
    return {
      error: controller.signal.aborted
        ? { class: "deadline", reasonCode: "deadline-exceeded" }
        : { class: "response", reasonCode: "provider-response-invalid" },
      status: "outcome-unknown",
    };
  } finally {
    clearTimeout(timer);
  }
};

const isDiscoveryPageOutput = async (value: unknown): Promise<boolean> => {
  if (
    !(
      plainRecord(value) &&
      hasExactKeys(value, [
        "hasMore",
        "items",
        "nextCursor",
        "sourcePartitionCompleted",
        "version",
      ])
    ) ||
    typeof value.hasMore !== "boolean" ||
    !(
      (value.hasMore === true &&
        typeof value.nextCursor === "string" &&
        ORGANIZATION_CURSOR_PATTERN.test(value.nextCursor) &&
        value.sourcePartitionCompleted === false) ||
      (value.hasMore === false &&
        value.nextCursor === null &&
        value.sourcePartitionCompleted === true)
    ) ||
    value.version !== "1.0.0" ||
    !Array.isArray(value.items) ||
    value.items.length > MAX_CONTACTS_TOTAL
  ) {
    return false;
  }
  const items = value.items as DatasetGenerationPageOutput["items"];
  const valid = items.every(
    (item) =>
      plainRecord(item) &&
      hasExactKeys(item, ["contentHash", "providerIdentity", "record"]) &&
      typeof item.contentHash === "string" &&
      HASH_PATTERN.test(item.contentHash) &&
      plainRecord(item.providerIdentity) &&
      hasExactKeys(item.providerIdentity, [
        "providerKey",
        "providerSubjectId",
      ]) &&
      item.providerIdentity.providerKey === PROVIDER_KEY &&
      typeof item.providerIdentity.providerSubjectId === "string" &&
      PROVIDER_SUBJECT_PATTERN.test(item.providerIdentity.providerSubjectId) &&
      plainRecord(item.record) &&
      hasExactKeys(item.record, [
        "datasetId",
        "recordId",
        "values",
        "workspaceId",
      ]) &&
      boundedText(item.record.datasetId, 255) &&
      boundedText(item.record.recordId, 255) &&
      boundedText(item.record.workspaceId, 255) &&
      Array.isArray(item.record.values) &&
      item.record.values.length === Object.keys(EXPECTED_FIELDS).length &&
      item.record.values.every(
        (entry) =>
          plainRecord(entry) &&
          hasExactKeys(entry, ["fieldId", "value"]) &&
          boundedText(entry.fieldId, 255) &&
          (entry.value === null ||
            typeof entry.value === "boolean" ||
            (typeof entry.value === "number" && Number.isFinite(entry.value)) ||
            (typeof entry.value === "string" && entry.value.length <= 16_384))
      )
  );
  if (!valid) {
    return false;
  }
  return (
    await Promise.all(
      items.map(async (item) => item.contentHash === (await hash(item.record)))
    )
  ).every(Boolean);
};

const classify = (
  request: PluginClassifyErrorRequest
): ReturnType<PluginAdapterV1["classifyError"]> => {
  if (request.diagnostic.kind === "timeout") {
    return { error: { class: "deadline", reasonCode: "deadline-exceeded" } };
  }
  if (request.diagnostic.kind === "transport") {
    return { error: { class: "transport", reasonCode: "transport-failed" } };
  }
  if (request.diagnostic.kind !== "http-status") {
    return { error: { class: "unknown", reasonCode: "unclassified" } };
  }
  const status = request.diagnostic.httpStatus;
  if (status === 401) {
    return {
      error: { class: "authentication", reasonCode: "authentication-failed" },
    };
  }
  if (status === 403) {
    return {
      error: { class: "authorization", reasonCode: "authorization-failed" },
    };
  }
  if (status === 429) {
    return { error: { class: "rate-limit", reasonCode: "rate-limited" } };
  }
  if (status >= 500 && status <= 599) {
    return {
      error: { class: "provider", reasonCode: "provider-unavailable" },
    };
  }
  if (status >= 400 && status <= 499) {
    return { error: { class: "provider", reasonCode: "provider-rejected" } };
  }
  return { error: { class: "unknown", reasonCode: "unclassified" } };
};

const manifest = Object.freeze({
  apiVersion: "dev.kurobara.plugin/v1",
  auth: { modes: ["api-key-header"] },
  capabilities: [
    {
      ...APOLLO_CONTACT_DISCOVERY_CAPABILITY,
      inputContract: APOLLO_CONTACT_DISCOVERY_CONTRACTS.input,
      outputContract: APOLLO_CONTACT_DISCOVERY_CONTRACTS.output,
    },
    {
      ...APOLLO_CONTACT_IDENTITY_CAPABILITY,
      inputContract: APOLLO_CONTACT_IDENTITY_CONTRACTS.input,
      outputContract: APOLLO_CONTACT_IDENTITY_CONTRACTS.output,
    },
  ],
  economics: {
    estimateGuarantee: "hard",
    unit: "requests",
    usageReporting: "exact",
  },
  execution: {
    idempotency: { keyScope: "operation", mode: "none" },
    lookup: { authoritativeNotFound: false, mode: "none" },
    timeouts: { executeMs: EXECUTE_TIMEOUT_MS, lookupMs: LOOKUP_TIMEOUT_MS },
  },
  id: "dev.kurobara.provider-apollo",
  permissions: { egress: { hosts: [HOSTNAME], tlsRequired: true } },
  version: "1.1.0",
} as const satisfies PluginManifestV1);

/**
 * Owner-key Apollo adapter for bounded People Search and selected identity
 * reveal pages. Identity reveal is limited to one selected provider subject,
 * disables every coordinate flag, and reduces the response to professional
 * identity fields before returning the derived record.
 */
export const createApolloProviderAdapter = (
  options: ApolloProviderOptions
): PluginAdapterV1 => {
  if (!apiKeyIsValid(options.apiKey)) {
    throw new ApolloProviderConfigurationError();
  }
  const clock = options.clock ?? { now: Date.now };
  const fetchImplementation = options.fetch ?? globalThis.fetch;
  return definePluginAdapter({
    classifyError: classify,
    describe: () => ({ manifest }),
    estimate: (request) => {
      const identityCapability =
        request.context.capability.capabilityId ===
          APOLLO_CONTACT_IDENTITY_CAPABILITY.capabilityId &&
        request.context.capability.capabilityVersion ===
          APOLLO_CONTACT_IDENTITY_CAPABILITY.capabilityVersion;
      let requestCount: number | undefined;
      if (identityCapability) {
        requestCount =
          parseIdentityInput(request.input.value) === undefined ? undefined : 1;
      } else {
        requestCount = parseInput(request.input.value)?.requestCount;
      }
      return requestCount === undefined
        ? {
            error: { class: "input", reasonCode: "input-invalid" },
            status: "unavailable",
          }
        : {
            quote: {
              expiresAtMs: request.context.deadlineAtMs,
              guarantee: "hard",
              pricingVersion: "1.0.0",
              unit: "requests",
              upperBound: requestCount,
            },
            status: "quoted",
          };
    },
    execute: (request) => {
      const identityCapability =
        request.context.capability.capabilityId ===
          APOLLO_CONTACT_IDENTITY_CAPABILITY.capabilityId &&
        request.context.capability.capabilityVersion ===
          APOLLO_CONTACT_IDENTITY_CAPABILITY.capabilityVersion;
      return identityCapability
        ? executeIdentity({
            apiKey: options.apiKey,
            clock,
            fetch: fetchImplementation,
            request,
          })
        : executeDiscovery({
            apiKey: options.apiKey,
            clock,
            fetch: fetchImplementation,
            request,
          });
    },
    health: (request) => {
      const observedAtMs = safeNow(clock);
      return {
        observedAtMs,
        status: "healthy",
        validUntilMs: Math.max(
          observedAtMs,
          Math.min(request.context.deadlineAtMs, observedAtMs + 30_000)
        ),
      };
    },
    lookup: () => ({
      error: { class: "unknown", reasonCode: "unclassified" },
      status: "outcome-unknown",
    }),
    normalize: async (request): Promise<PluginNormalizeResult> => {
      const payload = validatePluginJson(request.providerPayload);
      const identityCapability =
        request.context.capability.capabilityId ===
          APOLLO_CONTACT_IDENTITY_CAPABILITY.capabilityId &&
        request.context.capability.capabilityVersion ===
          APOLLO_CONTACT_IDENTITY_CAPABILITY.capabilityVersion;
      const valid =
        payload.ok &&
        (identityCapability
          ? await isIdentityPageOutput(payload.value)
          : await isDiscoveryPageOutput(payload.value));
      return valid
        ? {
            normalizerVersion: "1.0.0",
            output: payload.value,
            status: "normalized",
          }
        : {
            error: {
              class: "response",
              reasonCode: "provider-response-invalid",
            },
            status: "failed",
          };
    },
    validateConfig: (request) =>
      plainRecord(request.configuration.value) &&
      hasExactKeys(request.configuration.value, [])
        ? {
            configurationFingerprint: request.configuration.contentHash,
            status: "valid",
          }
        : {
            reasonCodes: ["configuration-unknown-field"],
            status: "invalid",
          },
  });
};

export type ApolloContactIdentityProviderReasonCode =
  | "authentication-failed"
  | "authorization-failed"
  | "deadline-elapsed"
  | "provider-identity-invalid"
  | "provider-outcome-unknown"
  | "provider-rate-limited"
  | "provider-rejected"
  | "transport-outcome-unknown";

export class ApolloContactIdentityProviderError extends Error {
  readonly reasonCode: ApolloContactIdentityProviderReasonCode;

  constructor(reasonCode: ApolloContactIdentityProviderReasonCode) {
    super(`Apollo contact identity reveal failed: ${reasonCode}.`);
    this.name = "ApolloContactIdentityProviderError";
    this.reasonCode = reasonCode;
  }
}

const normalizedLinkedInProfile = (value: unknown): null | string => {
  if (typeof value !== "string" || value.length > 2048) {
    return null;
  }
  try {
    const url = new URL(value);
    const hostname = url.hostname.toLowerCase();
    if (
      (url.protocol !== "http:" && url.protocol !== "https:") ||
      (hostname !== "linkedin.com" && hostname !== "www.linkedin.com") ||
      url.username.length > 0 ||
      url.password.length > 0 ||
      url.port.length > 0 ||
      !LINKEDIN_PROFILE_PATH_PATTERN.test(url.pathname)
    ) {
      return null;
    }
    url.protocol = "https:";
    url.hostname = "www.linkedin.com";
    url.hash = "";
    url.search = "";
    return url.toString();
  } catch {
    return null;
  }
};

const identityRequestUrl = (providerSubjectId: string): URL => {
  const url = new URL(PEOPLE_MATCH_ENDPOINT);
  url.searchParams.set("id", providerSubjectId);
  url.searchParams.set("reveal_personal_emails", "false");
  url.searchParams.set("reveal_phone_number", "false");
  url.searchParams.set("run_waterfall_email", "false");
  url.searchParams.set("run_waterfall_phone", "false");
  return url;
};

const identityFailureFor = (
  response: Response
): ApolloContactIdentityProviderReasonCode | undefined => {
  if (response.status === 401) {
    return "authentication-failed";
  }
  if (response.status === 403) {
    return "authorization-failed";
  }
  if (response.status === 429) {
    return "provider-rate-limited";
  }
  if (response.status >= 500 && response.status <= 599) {
    return "provider-outcome-unknown";
  }
  if (response.status >= 400 && response.status <= 499) {
    return "provider-rejected";
  }
};

const reduceIdentityResponse = (
  value: unknown,
  expectedProviderSubjectId: string,
  observedAt: number
): ContactIdentityResolution | null | undefined => {
  if (!(plainRecord(value) && Object.hasOwn(value, "person"))) {
    return;
  }
  if (value.person === null) {
    return null;
  }
  if (
    !plainRecord(value.person) ||
    value.person.id !== expectedProviderSubjectId ||
    !boundedText(value.person.first_name, 128) ||
    !boundedText(value.person.last_name, 128)
  ) {
    return;
  }
  const resolution = createContactIdentityResolution({
    displayName: `${value.person.first_name} ${value.person.last_name}`,
    firstName: value.person.first_name,
    identityCompleteness: "full",
    lastName: value.person.last_name,
    observedAt: observedAt as ContactIdentityResolution["observedAt"],
    profileUrl: normalizedLinkedInProfile(value.person.linkedin_url),
  });
  return resolution.ok ? resolution.value : undefined;
};

const identityPluginFailureFor = (
  response: Response
): PluginExecuteResult | undefined => {
  const usage = { amount: 1, basis: "exact" as const, unit: "requests" };
  if (response.status === 401) {
    return {
      error: { class: "authentication", reasonCode: "authentication-failed" },
      status: "failed",
      usage,
    };
  }
  if (response.status === 403) {
    return {
      error: { class: "authorization", reasonCode: "authorization-failed" },
      status: "failed",
      usage,
    };
  }
  if (response.status === 429) {
    const delay = retryAfterMs(response);
    return {
      error: {
        class: "rate-limit",
        reasonCode: "rate-limited",
        ...(delay === undefined ? {} : { retryAfterMs: delay }),
      },
      status: "failed",
      usage,
    };
  }
  if (response.status >= 400 && response.status <= 499) {
    return {
      error: { class: "provider", reasonCode: "provider-rejected" },
      status: "failed",
      usage,
    };
  }
};

const identityRecordFor = async (
  parsed: ParsedIdentityInput,
  resolution: ContactIdentityResolution | undefined,
  identityObservedAtMs: number
): Promise<DatasetGenerationPageOutput["items"][number]> => {
  const fields = new Map(
    parsed.input.fields.map((field) => [field.key, field] as const)
  );
  const candidate = parsed.selectedContact.candidate;
  const valuesByKey: Readonly<
    Record<
      keyof typeof IDENTITY_EXPECTED_FIELDS,
      boolean | null | number | string
    >
  > = {
    department: candidate.department,
    display_name: resolution?.displayName ?? candidate.display_name,
    first_name: resolution?.firstName ?? null,
    identity_completeness:
      resolution?.identityCompleteness ?? candidate.identity_completeness,
    identity_observed_at_ms: identityObservedAtMs,
    identity_status: resolution === undefined ? "not_found" : "found",
    job_title: candidate.job_title,
    last_name: resolution?.lastName ?? null,
    observed_at_ms: candidate.observed_at_ms,
    organization_domain: candidate.organization_domain,
    organization_id: candidate.organization_id,
    organization_name: candidate.organization_name,
    person_country_code: candidate.person_country_code,
    profile_url: resolution?.profileUrl ?? candidate.profile_url,
    seniority: candidate.seniority,
  };
  const record: DatasetGenerationRecord = {
    datasetId: parsed.input.datasetId,
    recordId: parsed.selectedContact.source_record_id,
    values: IDENTITY_FIELD_ORDER.map((key) => ({
      fieldId: fields.get(key)?.fieldId ?? "",
      value: valuesByKey[key as keyof typeof IDENTITY_EXPECTED_FIELDS],
    })),
    workspaceId: parsed.input.workspaceId,
  };
  return {
    contentHash: await hash(record),
    providerIdentity: {
      providerKey: PROVIDER_KEY,
      providerSubjectId:
        parsed.selectedContact.provider_identity.provider_subject_id,
    },
    record,
    source: {
      datasetId: parsed.query.source_dataset_id,
      recordId: parsed.selectedContact.source_record_id,
    },
  };
};

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: one selected page keeps validation, the single irreversible effect, and ambiguity classification together.
async function executeIdentity(options: {
  apiKey: string;
  clock: ApolloClock;
  fetch: typeof fetch;
  request: PluginExecuteRequest;
}): Promise<PluginExecuteResult> {
  const parsed = parseIdentityInput(options.request.input.value);
  if (parsed === undefined) {
    return {
      error: { class: "input", reasonCode: "input-invalid" },
      status: "failed",
      usage: zeroUsage,
    };
  }
  if (
    options.request.quote.upperBound === undefined ||
    options.request.quote.upperBound < 1
  ) {
    return {
      error: { class: "quota", reasonCode: "quota-exhausted" },
      status: "failed",
      usage: zeroUsage,
    };
  }
  const now = safeNow(options.clock);
  const deadlineAt = Math.min(
    options.request.context.deadlineAtMs,
    options.request.quote.expiresAtMs,
    now + EXECUTE_TIMEOUT_MS
  );
  if (deadlineAt <= now) {
    return {
      error: { class: "deadline", reasonCode: "deadline-exceeded" },
      status: "failed",
      usage: zeroUsage,
    };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deadlineAt - now);
  try {
    let response: Response;
    try {
      response = await options.fetch(
        identityRequestUrl(
          parsed.selectedContact.provider_identity.provider_subject_id
        ),
        {
          headers: {
            accept: "application/json",
            "cache-control": "no-cache",
            "content-type": "application/json",
            "x-api-key": options.apiKey,
          },
          method: "POST",
          redirect: "error",
          signal: controller.signal,
        }
      );
    } catch {
      return {
        error: controller.signal.aborted
          ? { class: "deadline", reasonCode: "deadline-exceeded" }
          : { class: "transport", reasonCode: "transport-failed" },
        status: "outcome-unknown",
      };
    }
    if (controller.signal.aborted) {
      await response.body?.cancel().catch(() => undefined);
      return {
        error: { class: "deadline", reasonCode: "deadline-exceeded" },
        status: "outcome-unknown",
      };
    }
    if (response.status >= 500 && response.status <= 599) {
      await response.body?.cancel().catch(() => undefined);
      return {
        error: { class: "provider", reasonCode: "provider-unavailable" },
        status: "outcome-unknown",
      };
    }
    const failed = identityPluginFailureFor(response);
    if (failed !== undefined) {
      await response.body?.cancel().catch(() => undefined);
      return failed;
    }
    if (response.status !== 200) {
      await response.body?.cancel().catch(() => undefined);
      return {
        error: { class: "unknown", reasonCode: "unclassified" },
        status: "outcome-unknown",
      };
    }
    let reduced: ContactIdentityResolution | null | undefined;
    try {
      reduced = reduceIdentityResponse(
        await responseJson(response, controller.signal),
        parsed.selectedContact.provider_identity.provider_subject_id,
        safeNow(options.clock)
      );
    } catch {
      reduced = undefined;
    }
    if (reduced === undefined) {
      return {
        error: controller.signal.aborted
          ? { class: "deadline", reasonCode: "deadline-exceeded" }
          : { class: "response", reasonCode: "provider-response-invalid" },
        status: "outcome-unknown",
      };
    }
    const nextContactIndex = parsed.selectedContactIndex + 1;
    const hasMore = nextContactIndex < parsed.query.selected_contacts.length;
    const output: DatasetGenerationPageOutput = {
      hasMore,
      items: [
        await identityRecordFor(
          parsed,
          reduced === null ? undefined : reduced,
          reduced === null ? safeNow(options.clock) : reduced.observedAt
        ),
      ],
      nextCursor: hasMore ? `contact:${nextContactIndex}` : null,
      sourcePartitionCompleted: !hasMore,
      version: "1.0.0",
    };
    return {
      providerPayload: output,
      status: "succeeded",
      usage: { amount: 1, basis: "exact", unit: "requests" },
    };
  } catch {
    return {
      error: controller.signal.aborted
        ? { class: "deadline", reasonCode: "deadline-exceeded" }
        : { class: "response", reasonCode: "provider-response-invalid" },
      status: "outcome-unknown",
    };
  } finally {
    clearTimeout(timer);
  }
}

async function isIdentityPageOutput(value: unknown): Promise<boolean> {
  if (
    !(
      plainRecord(value) &&
      hasExactKeys(value, [
        "hasMore",
        "items",
        "nextCursor",
        "sourcePartitionCompleted",
        "version",
      ])
    ) ||
    typeof value.hasMore !== "boolean" ||
    !(
      (value.hasMore === true &&
        typeof value.nextCursor === "string" &&
        CONTACT_CURSOR_PATTERN.test(value.nextCursor) &&
        value.sourcePartitionCompleted === false) ||
      (value.hasMore === false &&
        value.nextCursor === null &&
        value.sourcePartitionCompleted === true)
    ) ||
    value.version !== "1.0.0" ||
    !Array.isArray(value.items) ||
    value.items.length !== 1
  ) {
    return false;
  }
  const item = value.items[0];
  if (
    !(
      plainRecord(item) &&
      hasExactKeys(item, [
        "contentHash",
        "providerIdentity",
        "record",
        "source",
      ]) &&
      typeof item.contentHash === "string" &&
      HASH_PATTERN.test(item.contentHash) &&
      plainRecord(item.providerIdentity) &&
      hasExactKeys(item.providerIdentity, [
        "providerKey",
        "providerSubjectId",
      ]) &&
      item.providerIdentity.providerKey === PROVIDER_KEY &&
      typeof item.providerIdentity.providerSubjectId === "string" &&
      PROVIDER_SUBJECT_PATTERN.test(item.providerIdentity.providerSubjectId) &&
      plainRecord(item.source) &&
      hasExactKeys(item.source, ["datasetId", "recordId"]) &&
      boundedText(item.source.datasetId, 255) &&
      boundedText(item.source.recordId, 255) &&
      plainRecord(item.record) &&
      hasExactKeys(item.record, [
        "datasetId",
        "recordId",
        "values",
        "workspaceId",
      ]) &&
      boundedText(item.record.datasetId, 255) &&
      boundedText(item.record.recordId, 255) &&
      item.record.recordId === item.source.recordId &&
      boundedText(item.record.workspaceId, 255) &&
      Array.isArray(item.record.values) &&
      item.record.values.length === IDENTITY_FIELD_ORDER.length &&
      item.record.values.every(
        (entry) =>
          plainRecord(entry) &&
          hasExactKeys(entry, ["fieldId", "value"]) &&
          boundedText(entry.fieldId, 255) &&
          (entry.value === null ||
            typeof entry.value === "boolean" ||
            (typeof entry.value === "number" && Number.isFinite(entry.value)) ||
            (typeof entry.value === "string" && entry.value.length <= 16_384))
      )
    )
  ) {
    return false;
  }
  return item.contentHash === (await hash(item.record));
}

const exactIdentityUsage = <Value>(
  value: Value
): ContactProviderEffectResult<Value> => ({
  usage: { amount: 1, basis: "exact", unit: "requests" },
  value,
});

const identityRequestIsValid = (request: unknown): boolean =>
  plainRecord(request) &&
  hasExactKeys(request, ["deadline", "operationId", "providerIdentity"]) &&
  Number.isSafeInteger(request.deadline) &&
  Number(request.deadline) >= 0 &&
  boundedText(request.operationId, 512) &&
  plainRecord(request.providerIdentity) &&
  hasExactKeys(request.providerIdentity, [
    "providerKey",
    "providerSubjectId",
  ]) &&
  request.providerIdentity.providerKey === PROVIDER_KEY &&
  typeof request.providerIdentity.providerSubjectId === "string" &&
  PROVIDER_SUBJECT_PATTERN.test(request.providerIdentity.providerSubjectId);

/**
 * Provider seam for selected Apollo identities, composed by the worker through
 * the durable dataset-derived reveal route. The worker reloads the provider
 * subject from restricted lineage; callers cannot supply it through the public
 * route. Raw Apollo responses and incidental coordinates are reduced by
 * allowlist.
 */
export const createApolloContactIdentityProvider = (
  options: ApolloProviderOptions
): ContactIdentityProviderPort => {
  if (!apiKeyIsValid(options.apiKey)) {
    throw new ApolloProviderConfigurationError();
  }
  const clock = options.clock ?? { now: Date.now };
  const fetchImplementation = options.fetch ?? globalThis.fetch;
  return {
    quote: (request) => {
      if (!identityRequestIsValid(request)) {
        return Promise.reject(
          new ApolloContactIdentityProviderError("provider-identity-invalid")
        );
      }
      return Promise.resolve({
        guarantee: "hard",
        unit: "requests",
        upperBound: 1,
      });
    },
    reveal: async (request) => {
      if (!identityRequestIsValid(request)) {
        throw new ApolloContactIdentityProviderError(
          "provider-identity-invalid"
        );
      }
      const now = safeNow(clock);
      const remainingMilliseconds = Math.min(
        EXECUTE_TIMEOUT_MS,
        request.deadline - now
      );
      if (remainingMilliseconds <= 0) {
        throw new ApolloContactIdentityProviderError("deadline-elapsed");
      }
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), remainingMilliseconds);
      try {
        let response: Response;
        try {
          response = await fetchImplementation(
            identityRequestUrl(request.providerIdentity.providerSubjectId),
            {
              headers: {
                accept: "application/json",
                "cache-control": "no-cache",
                "content-type": "application/json",
                "x-api-key": options.apiKey,
              },
              method: "POST",
              redirect: "error",
              signal: controller.signal,
            }
          );
        } catch {
          throw new ApolloContactIdentityProviderError(
            "transport-outcome-unknown"
          );
        }
        const failure = identityFailureFor(response);
        if (failure !== undefined) {
          await response.body?.cancel().catch(() => undefined);
          throw new ApolloContactIdentityProviderError(failure);
        }
        if (!response.ok) {
          await response.body?.cancel().catch(() => undefined);
          throw new ApolloContactIdentityProviderError(
            "transport-outcome-unknown"
          );
        }
        let value: unknown;
        try {
          value = await responseJson(response, controller.signal);
        } catch {
          throw new ApolloContactIdentityProviderError(
            controller.signal.aborted
              ? "transport-outcome-unknown"
              : "provider-outcome-unknown"
          );
        }
        const reduced = reduceIdentityResponse(
          value,
          request.providerIdentity.providerSubjectId,
          safeNow(clock)
        );
        if (reduced === undefined) {
          throw new ApolloContactIdentityProviderError(
            "provider-outcome-unknown"
          );
        }
        return exactIdentityUsage(reduced === null ? undefined : reduced);
      } finally {
        clearTimeout(timer);
      }
    },
  };
};
