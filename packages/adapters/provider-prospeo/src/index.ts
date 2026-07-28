import {
  type ContactIdentityResolution,
  type ContactWorkEmailResolution,
  createContactIdentityResolution,
  createContactWorkEmailResolution,
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

const SEARCH_ENDPOINT = "https://api.prospeo.io/search-person";
const ENRICH_ENDPOINT = "https://api.prospeo.io/enrich-person";
const HOSTNAME = "api.prospeo.io";
const PROVIDER_KEY = "prospeo-person-search";
const EXECUTE_TIMEOUT_MS = 10_000;
const LOOKUP_TIMEOUT_MS = 1000;
const MAX_API_KEY_LENGTH = 4096;
const MAX_RESPONSE_BYTES = 524_288;
const MAX_RETRY_AFTER_MS = 86_400_000;
const MAX_COMPANIES = 10;
const MAX_CONTACTS_PER_COMPANY = 2;
const MAX_CONTACTS_TOTAL = 12;
const MAX_CONTACT_SELECTION = 3;
const PROSPEO_PAGE_SIZE = 25;
const PROSPEO_MAX_PAGE = 1000;
const MAX_FILTER_VALUES = 32;
const CATALOG_VERSION = "0.13.0";

export const PROSPEO_CATALOG_FINGERPRINT =
  "sha256:1466e9c9bff8bc3c3f3c5e330a5770cb57429cb03bd9a75cc0701c9a71c9744e";
const PAGE_INPUT_SCHEMA_FINGERPRINT =
  "sha256:40153b13ed33d9bf086dcfde537ce1e17946b0e82b6e0461683c42c24a382a55";
const PAGE_INPUT_SCHEMA_ID =
  "https://schemas.kurobara.invalid/schemas/dataset-generations/page-input/1.0.0";
const PAGE_OUTPUT_SCHEMA_FINGERPRINT =
  "sha256:f61bef0f513210cf17c84fd53aad2c1624a6913a732e98597056a442bc589ab3";
const PAGE_OUTPUT_SCHEMA_ID =
  "https://schemas.kurobara.invalid/schemas/dataset-generations/page-output/1.0.0";

export const PROSPEO_CONTACT_DISCOVERY_CAPABILITY = Object.freeze({
  capabilityId: "contacts.discover",
  capabilityVersion: "1.0.0",
});

export const PROSPEO_CONTACT_IDENTITY_CAPABILITY = Object.freeze({
  capabilityId: "contacts.identity.reveal",
  capabilityVersion: "1.0.0",
});

export const PROSPEO_WORK_EMAIL_RESOLVE_CAPABILITY = Object.freeze({
  capabilityId: "contacts.work-email.resolve",
  capabilityVersion: "1.0.0",
});

export const PROSPEO_CONTACT_CONTRACTS = Object.freeze({
  input: Object.freeze({
    catalogFingerprint: PROSPEO_CATALOG_FINGERPRINT,
    catalogVersion: CATALOG_VERSION,
    schemaFingerprint: PAGE_INPUT_SCHEMA_FINGERPRINT,
    schemaId: PAGE_INPUT_SCHEMA_ID,
    schemaVersion: "1.0.0",
  }),
  output: Object.freeze({
    catalogFingerprint: PROSPEO_CATALOG_FINGERPRINT,
    catalogVersion: CATALOG_VERSION,
    schemaFingerprint: PAGE_OUTPUT_SCHEMA_FINGERPRINT,
    schemaId: PAGE_OUTPUT_SCHEMA_ID,
    schemaVersion: "1.0.0",
  }),
}) satisfies Readonly<{ input: PluginContractRef; output: PluginContractRef }>;

export const PROSPEO_CONTACT_DISCOVERY_CONTRACTS = PROSPEO_CONTACT_CONTRACTS;
export const PROSPEO_CONTACT_IDENTITY_CONTRACTS = PROSPEO_CONTACT_CONTRACTS;
export const PROSPEO_WORK_EMAIL_CONTRACTS = PROSPEO_CONTACT_CONTRACTS;

const DISCOVERY_FIELDS = Object.freeze({
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

const IDENTITY_FIELDS = Object.freeze({
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

const WORK_EMAIL_FIELDS = Object.freeze({
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
  work_email: "string",
  work_email_confidence: "number",
  work_email_observed_at_ms: "number",
  work_email_source: "string",
  work_email_status: "string",
  work_email_verification: "string",
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
const DISCOVERY_QUERY_KEYS = Object.freeze([
  "company_headquarters_country_codes",
  "departments",
  "organization_source",
  "organizations",
  "person_country_codes",
  "result_kind",
  "seniorities",
  "titles",
] as const);
const ORGANIZATION_KEYS = Object.freeze([
  "company_id",
  "country_code",
  "domain",
  "name",
] as const);
const IDENTITY_QUERY_KEYS = Object.freeze([
  "result_kind",
  "selected_contacts",
  "source_dataset_id",
] as const);
const WORK_EMAIL_QUERY_KEYS = Object.freeze([
  "operation_kind",
  "result_kind",
  "selected_contacts",
  "source_dataset_id",
] as const);
const SELECTED_IDENTITY_KEYS = Object.freeze([
  "candidate",
  "provider_identity",
  "source_record_id",
] as const);
const SELECTED_WORK_EMAIL_KEYS = Object.freeze([
  "candidate",
  "identity",
  "provider_identity",
  "source_record_id",
] as const);
const PROVIDER_IDENTITY_KEYS = Object.freeze([
  "provider_key",
  "provider_subject_id",
] as const);
const CANDIDATE_KEYS = Object.freeze([
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
const FULL_IDENTITY_KEYS = Object.freeze([
  "display_name",
  "first_name",
  "last_name",
  "observed_at_ms",
  "profile_url",
] as const);

const HASH_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const COUNTRY_PATTERN = /^[A-Z]{2}$/u;
const TAXONOMY_PATTERN = /^[a-z][a-z0-9._-]{0,127}$/u;
const DOMAIN_LABEL_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;
const PROVIDER_SUBJECT_PATTERN = /^[A-Za-z0-9_-]{1,160}$/u;
const LEADING_WWW_PATTERN = /^www\./u;
const TRAILING_DOT_PATTERN = /\.$/u;
const PAGE_CURSOR_PATTERN = /^page:([2-9]|[1-9]\d{1,2}|1000)$/u;
const CONTACT_CURSOR_PATTERN = /^contact:([1-9]\d*)$/u;
const LINKEDIN_PROFILE_PATH_PATTERN = /^\/in\/[^/]+\/?$/u;
const EMAIL_PATTERN = /^[^@\s]+@[^@\s]+$/u;
const UNSIGNED_INTEGER_PATTERN = /^\d+$/u;
const JSON_CONTENT_TYPE_PATTERN =
  /^application\/[a-z0-9!#$&^_.+-]*\+?json(?:\s*;|$)/u;

const SENIORITY_TO_PROSPEO = Object.freeze({
  owner: "Founder/Owner",
  c_suite: "C-Suite",
  vp: "Vice President",
  director: "Director",
  manager: "Manager",
  senior: "Senior",
  individual_contributor: "Entry",
} as const);
const DEPARTMENT_TO_PROSPEO = Object.freeze({
  c_suite: "C-Suite",
  consulting: "Consulting",
  design: "Design",
  education: "Education & Coaching",
  engineering: "Engineering & Technical",
  executive: "C-Suite",
  finance: "Finance",
  human_resources: "Human Resources",
  information_technology: "Information Technology",
  legal: "Legal",
  marketing: "Marketing",
  medical_health: "Medical & Health",
  operations: "Operations",
  product: "Product",
  sales: "Sales",
} as const);
const SENIORITIES = new Set([
  ...Object.keys(SENIORITY_TO_PROSPEO),
  "individual_contributor",
]);
const COUNTRY_DISPLAY_NAMES = new Intl.DisplayNames(["en"], { type: "region" });

type JsonRecord = Record<string, unknown>;
type ProspeoClock = Readonly<{ now: () => number }>;
type ValueType = "boolean" | "number" | "string";
type ContactSeniority =
  | "owner"
  | "c_suite"
  | "vp"
  | "director"
  | "manager"
  | "senior"
  | "individual_contributor";

type Field = Readonly<{
  datasetId: string;
  fieldId: string;
  key: string;
  label: string;
  valueType: ValueType;
  workspaceId: string;
}>;
type Limits = Readonly<{
  maxCalls: number;
  maxCompanies: number;
  maxContactsPerCompany: number;
  maxContactsTotal: number;
  maxEnrichments: number;
  maxPages: number;
  maxPhones: number;
  maxResults: number;
}>;
type Organization = Readonly<{
  company_id: string;
  country_code: string;
  domain: null | string;
  name: string;
}>;
type DiscoveryQuery = Readonly<{
  company_headquarters_country_codes: readonly string[];
  departments: readonly string[];
  organization_source: JsonRecord;
  organizations: readonly Organization[];
  person_country_codes: readonly string[];
  result_kind: "contact";
  seniorities: readonly ContactSeniority[];
  titles: readonly string[];
}>;
type Candidate = Readonly<{
  department: null | string;
  display_name: string;
  identity_completeness: "full" | "obfuscated";
  job_title: string;
  observed_at_ms: number;
  organization_domain: string;
  organization_id: string;
  organization_name: string;
  person_country_code: null | string;
  profile_url: null | string;
  seniority: ContactSeniority | null;
}>;
type FullIdentity = Readonly<{
  display_name: string;
  first_name: string;
  last_name: string;
  observed_at_ms: number;
  profile_url: null | string;
}>;
type ProviderIdentity = Readonly<{
  provider_key: typeof PROVIDER_KEY;
  provider_subject_id: string;
}>;
type SelectedIdentity = Readonly<{
  candidate: Candidate & Readonly<{ identity_completeness: "obfuscated" }>;
  provider_identity: ProviderIdentity;
  source_record_id: string;
}>;
type SelectedWorkEmail = Readonly<{
  candidate: Candidate & Readonly<{ identity_completeness: "full" }>;
  identity: FullIdentity;
  provider_identity: ProviderIdentity;
  source_record_id: string;
}>;
type IdentityQuery = Readonly<{
  result_kind: "contact_identity";
  selected_contacts: readonly SelectedIdentity[];
  source_dataset_id: string;
}>;
type WorkEmailQuery = Readonly<{
  operation_kind: "resolve";
  result_kind: "contact_work_email";
  selected_contacts: readonly SelectedWorkEmail[];
  source_dataset_id: string;
}>;
type PageInput = Readonly<{
  capability: Readonly<{ capabilityId: string; capabilityVersion: "1.0.0" }>;
  datasetId: string;
  fields: readonly Field[];
  generationId: string;
  generationPlanId: string;
  inputCursor: null | string;
  kind: "dataset-generation-page-input";
  limits: Limits;
  normalizedQuery: DiscoveryQuery | IdentityQuery | WorkEmailQuery;
  pageSequence: number;
  planHash: string;
  queryHash: string;
  schemaHash: string;
  version: "1.0.0";
  workspaceId: string;
}>;
type RecordValue = Readonly<{
  fieldId: string;
  value: boolean | null | number | string;
}>;
type PageRecord = Readonly<{
  datasetId: string;
  recordId: string;
  values: readonly RecordValue[];
  workspaceId: string;
}>;
type PageItem = Readonly<{
  contentHash: string;
  providerIdentity: Readonly<{
    providerKey: typeof PROVIDER_KEY;
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
type ParsedDiscovery = Readonly<{
  input: PageInput;
  page: number;
  query: DiscoveryQuery;
  requestCount: number;
  organizationsByDomain: ReadonlyMap<
    string,
    Organization & Readonly<{ domain: string }>
  >;
}>;
type ParsedIdentity = Readonly<{
  input: PageInput;
  query: IdentityQuery;
  selected: SelectedIdentity;
  selectedIndex: number;
}>;
type ParsedWorkEmail = Readonly<{
  input: PageInput;
  query: WorkEmailQuery;
  selected: SelectedWorkEmail;
  selectedIndex: number;
}>;

export type ProspeoProviderOptions = Readonly<{
  apiKey: string;
  clock?: ProspeoClock;
  fetch?: typeof fetch;
}>;

export class ProspeoProviderConfigurationError extends Error {
  readonly reasonCode = "provider-prospeo-configuration-invalid" as const;

  constructor() {
    super("Prospeo provider configuration is invalid.");
    this.name = "ProspeoProviderConfigurationError";
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
  const candidate = value.toLowerCase();
  let domain = candidate;
  if (candidate.includes("://")) {
    try {
      const url = new URL(candidate);
      if (
        url.username ||
        url.password ||
        url.port ||
        (url.protocol !== "http:" && url.protocol !== "https:")
      ) {
        return;
      }
      domain = url.hostname;
    } catch {
      return;
    }
  }
  domain = domain
    .replace(LEADING_WWW_PATTERN, "")
    .replace(TRAILING_DOT_PATTERN, "");
  if (
    domain.length > 253 ||
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
      Boolean(url.hostname) &&
      !url.username &&
      !url.password &&
      !url.port
    );
  } catch {
    return false;
  }
};

const safeNow = (clock: ProspeoClock): number => {
  const value = clock.now();
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
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

const fieldsMatch = (
  value: unknown,
  datasetId: string,
  workspaceId: string,
  expected: Readonly<Record<string, ValueType>>
): value is readonly Field[] => {
  if (!Array.isArray(value) || value.length !== Object.keys(expected).length) {
    return false;
  }
  const keys = new Set<string>();
  const fieldIds = new Set<string>();
  for (const field of value) {
    if (
      !(
        plainRecord(field) &&
        hasExactKeys(field, FIELD_KEYS) &&
        field.datasetId === datasetId &&
        field.workspaceId === workspaceId &&
        boundedText(field.fieldId, 255) &&
        boundedText(field.label, 255) &&
        typeof field.key === "string" &&
        Object.hasOwn(expected, field.key) &&
        field.valueType === expected[field.key] &&
        !keys.has(field.key) &&
        !fieldIds.has(field.fieldId)
      )
    ) {
      return false;
    }
    keys.add(field.key);
    fieldIds.add(field.fieldId);
  }
  return keys.size === Object.keys(expected).length;
};

const limitsShapeIsValid = (value: unknown): value is Limits =>
  plainRecord(value) &&
  hasExactKeys(value, LIMIT_KEYS) &&
  LIMIT_KEYS.every((key) =>
    boundedInteger(value[key], 0, Number.MAX_SAFE_INTEGER)
  );

const discoveryLimitsAreValid = (value: unknown): value is Limits =>
  limitsShapeIsValid(value) &&
  boundedInteger(value.maxCalls, 1, PROSPEO_MAX_PAGE) &&
  boundedInteger(value.maxCompanies, 1, MAX_COMPANIES) &&
  boundedInteger(value.maxContactsPerCompany, 1, MAX_CONTACTS_PER_COMPANY) &&
  boundedInteger(value.maxContactsTotal, 1, MAX_CONTACTS_TOTAL) &&
  value.maxContactsTotal <= value.maxCompanies * value.maxContactsPerCompany &&
  value.maxEnrichments === 0 &&
  boundedInteger(value.maxPages, 1, PROSPEO_MAX_PAGE) &&
  value.maxPhones === 0 &&
  boundedInteger(value.maxResults, 1, MAX_CONTACTS_TOTAL);

const selectedLimitsAreValid = (
  value: unknown,
  selectionCount: number,
  selectionIndex: number
): value is Limits =>
  limitsShapeIsValid(value) &&
  value.maxCalls === selectionCount &&
  value.maxCompanies === 0 &&
  value.maxContactsPerCompany === 0 &&
  value.maxContactsTotal === selectionCount &&
  value.maxEnrichments === selectionCount &&
  value.maxPages === selectionCount &&
  value.maxPhones === 0 &&
  value.maxResults === selectionCount - selectionIndex;

const parseOrganizations = (
  value: unknown,
  maximum: number
): readonly Organization[] | undefined => {
  if (!Array.isArray(value) || value.length < 1 || value.length > maximum) {
    return;
  }
  const organizations: Organization[] = [];
  const ids = new Set<string>();
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
        (item.domain === null || typeof item.domain === "string") &&
        !ids.has(item.company_id)
      )
    ) {
      return;
    }
    const normalized =
      item.domain === null ? null : normalizeDomain(item.domain);
    if (
      (item.domain !== null && normalized === undefined) ||
      (typeof normalized === "string" && domains.has(normalized))
    ) {
      return;
    }
    ids.add(item.company_id);
    if (typeof normalized === "string") {
      domains.add(normalized);
    }
    organizations.push({
      company_id: item.company_id,
      country_code: item.country_code,
      domain: normalized ?? null,
      name: item.name,
    });
  }
  return organizations;
};

const parseDiscoveryQuery = (
  value: unknown,
  maximumCompanies: number
): DiscoveryQuery | undefined => {
  if (!(plainRecord(value) && hasExactKeys(value, DISCOVERY_QUERY_KEYS))) {
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
    !value.departments.every((entry) =>
      Object.hasOwn(DEPARTMENT_TO_PROSPEO, entry)
    ) ||
    !uniqueStrings(value.titles, {
      maximumCount: MAX_FILTER_VALUES,
      maximumLength: 100,
    }) ||
    !uniqueStrings(value.seniorities, {
      maximumCount: 16,
      maximumLength: 32,
    }) ||
    !value.seniorities.every((entry) => SENIORITIES.has(entry))
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

const pageEnvelopeIsValid = (
  value: JsonRecord,
  expectedFields: Readonly<Record<string, ValueType>>
): value is JsonRecord &
  Readonly<{
    datasetId: string;
    workspaceId: string;
    fields: readonly Field[];
  }> => {
  if (!hasExactKeys(value, INPUT_KEYS)) {
    return false;
  }
  const datasetId = boundedText(value.datasetId, 255)
    ? value.datasetId
    : undefined;
  const workspaceId = boundedText(value.workspaceId, 255)
    ? value.workspaceId
    : undefined;
  return (
    datasetId !== undefined &&
    workspaceId !== undefined &&
    value.kind === "dataset-generation-page-input" &&
    value.version === "1.0.0" &&
    boundedText(value.generationId, 255) &&
    boundedText(value.generationPlanId, 255) &&
    fieldsMatch(value.fields, datasetId, workspaceId, expectedFields) &&
    typeof value.planHash === "string" &&
    HASH_PATTERN.test(value.planHash) &&
    typeof value.queryHash === "string" &&
    HASH_PATTERN.test(value.queryHash) &&
    typeof value.schemaHash === "string" &&
    HASH_PATTERN.test(value.schemaHash)
  );
};

const capabilityMatches = (
  value: unknown,
  expected: Readonly<{ capabilityId: string; capabilityVersion: string }>
): boolean =>
  plainRecord(value) &&
  hasExactKeys(value, ["capabilityId", "capabilityVersion"]) &&
  value.capabilityId === expected.capabilityId &&
  value.capabilityVersion === expected.capabilityVersion;

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: one parser keeps caps, cursor, and snapshot invariants at the provider boundary.
const parseDiscoveryInput = (value: unknown): ParsedDiscovery | undefined => {
  if (!(plainRecord(value) && pageEnvelopeIsValid(value, DISCOVERY_FIELDS))) {
    return;
  }
  if (
    !(
      discoveryLimitsAreValid(value.limits) &&
      capabilityMatches(value.capability, PROSPEO_CONTACT_DISCOVERY_CAPABILITY)
    )
  ) {
    return;
  }
  const query = parseDiscoveryQuery(
    value.normalizedQuery,
    value.limits.maxCompanies
  );
  if (
    query === undefined ||
    !boundedInteger(value.pageSequence, 1, PROSPEO_MAX_PAGE)
  ) {
    return;
  }
  let page = 1;
  if (value.pageSequence === 1) {
    if (value.inputCursor !== null) {
      return;
    }
  } else {
    if (typeof value.inputCursor !== "string") {
      return;
    }
    const match = PAGE_CURSOR_PATTERN.exec(value.inputCursor);
    const parsedPage = Number(match?.[1]);
    if (
      !Number.isSafeInteger(parsedPage) ||
      parsedPage !== value.pageSequence
    ) {
      return;
    }
    page = parsedPage;
  }
  if (page > value.limits.maxCalls || page > value.limits.maxPages) {
    return;
  }
  const organizationsByDomain = new Map<
    string,
    Organization & Readonly<{ domain: string }>
  >();
  for (const organization of query.organizations) {
    if (organization.domain !== null) {
      organizationsByDomain.set(organization.domain, {
        ...organization,
        domain: organization.domain,
      });
    }
  }
  return {
    input: value as unknown as PageInput,
    page,
    query,
    requestCount: organizationsByDomain.size === 0 ? 0 : 1,
    organizationsByDomain,
  };
};

const candidateIsValid = (
  value: unknown,
  completeness: "full" | "obfuscated"
): value is Candidate => {
  if (!(plainRecord(value) && hasExactKeys(value, CANDIDATE_KEYS))) {
    return false;
  }
  const domain = normalizeDomain(value.organization_domain);
  return (
    (value.department === null ||
      (boundedText(value.department, 128) &&
        TAXONOMY_PATTERN.test(value.department))) &&
    boundedText(value.display_name, 255) &&
    value.identity_completeness === completeness &&
    boundedText(value.job_title, 255) &&
    boundedInteger(value.observed_at_ms, 0, Number.MAX_SAFE_INTEGER) &&
    domain !== undefined &&
    domain === value.organization_domain &&
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

const providerIdentityIsValid = (value: unknown): value is ProviderIdentity =>
  plainRecord(value) &&
  hasExactKeys(value, PROVIDER_IDENTITY_KEYS) &&
  value.provider_key === PROVIDER_KEY &&
  typeof value.provider_subject_id === "string" &&
  PROVIDER_SUBJECT_PATTERN.test(value.provider_subject_id);

const fullIdentityIsValid = (value: unknown): value is FullIdentity =>
  plainRecord(value) &&
  hasExactKeys(value, FULL_IDENTITY_KEYS) &&
  boundedText(value.display_name, 255) &&
  boundedText(value.first_name, 128) &&
  boundedText(value.last_name, 128) &&
  value.display_name === `${value.first_name} ${value.last_name}` &&
  boundedInteger(value.observed_at_ms, 0, Number.MAX_SAFE_INTEGER) &&
  (value.profile_url === null || secureHttpsUrl(value.profile_url));

const parseIdentityQuery = (value: unknown): IdentityQuery | undefined => {
  if (
    !(
      plainRecord(value) &&
      hasExactKeys(value, IDENTITY_QUERY_KEYS) &&
      value.result_kind === "contact_identity" &&
      boundedText(value.source_dataset_id, 255) &&
      Array.isArray(value.selected_contacts) &&
      value.selected_contacts.length >= 1 &&
      value.selected_contacts.length <= MAX_CONTACT_SELECTION
    )
  ) {
    return;
  }
  const selectedContacts: SelectedIdentity[] = [];
  const recordIds = new Set<string>();
  const subjectIds = new Set<string>();
  for (const selected of value.selected_contacts) {
    if (
      !(
        plainRecord(selected) &&
        hasExactKeys(selected, SELECTED_IDENTITY_KEYS) &&
        boundedText(selected.source_record_id, 255) &&
        !recordIds.has(selected.source_record_id) &&
        candidateIsValid(selected.candidate, "obfuscated") &&
        providerIdentityIsValid(selected.provider_identity) &&
        !subjectIds.has(selected.provider_identity.provider_subject_id)
      )
    ) {
      return;
    }
    recordIds.add(selected.source_record_id);
    subjectIds.add(selected.provider_identity.provider_subject_id);
    selectedContacts.push(selected as unknown as SelectedIdentity);
  }
  return {
    result_kind: "contact_identity",
    selected_contacts: selectedContacts,
    source_dataset_id: value.source_dataset_id,
  };
};

const parseWorkEmailQuery = (value: unknown): WorkEmailQuery | undefined => {
  if (
    !(
      plainRecord(value) &&
      hasExactKeys(value, WORK_EMAIL_QUERY_KEYS) &&
      value.operation_kind === "resolve" &&
      value.result_kind === "contact_work_email" &&
      boundedText(value.source_dataset_id, 255) &&
      Array.isArray(value.selected_contacts) &&
      value.selected_contacts.length >= 1 &&
      value.selected_contacts.length <= MAX_CONTACT_SELECTION
    )
  ) {
    return;
  }
  const selectedContacts: SelectedWorkEmail[] = [];
  const recordIds = new Set<string>();
  const subjectIds = new Set<string>();
  for (const selected of value.selected_contacts) {
    if (
      !(
        plainRecord(selected) &&
        hasExactKeys(selected, SELECTED_WORK_EMAIL_KEYS) &&
        boundedText(selected.source_record_id, 255) &&
        !recordIds.has(selected.source_record_id) &&
        candidateIsValid(selected.candidate, "full") &&
        fullIdentityIsValid(selected.identity) &&
        selected.candidate.display_name === selected.identity.display_name &&
        selected.candidate.profile_url === selected.identity.profile_url &&
        providerIdentityIsValid(selected.provider_identity) &&
        !subjectIds.has(selected.provider_identity.provider_subject_id)
      )
    ) {
      return;
    }
    recordIds.add(selected.source_record_id);
    subjectIds.add(selected.provider_identity.provider_subject_id);
    selectedContacts.push(selected as unknown as SelectedWorkEmail);
  }
  return {
    operation_kind: "resolve",
    result_kind: "contact_work_email",
    selected_contacts: selectedContacts,
    source_dataset_id: value.source_dataset_id,
  };
};

const selectedIndex = (
  value: JsonRecord,
  selectionCount: number
): number | undefined => {
  const cursorMatch =
    value.inputCursor === null
      ? null
      : CONTACT_CURSOR_PATTERN.exec(String(value.inputCursor));
  const index = value.inputCursor === null ? 0 : Number(cursorMatch?.[1]);
  if (
    !Number.isSafeInteger(index) ||
    index < 0 ||
    index >= selectionCount ||
    value.pageSequence !== index + 1 ||
    !selectedLimitsAreValid(value.limits, selectionCount, index)
  ) {
    return;
  }
  return index;
};

const parseIdentityInput = (value: unknown): ParsedIdentity | undefined => {
  if (!(plainRecord(value) && pageEnvelopeIsValid(value, IDENTITY_FIELDS))) {
    return;
  }
  const query = parseIdentityQuery(value.normalizedQuery);
  if (
    query === undefined ||
    value.datasetId === query.source_dataset_id ||
    !capabilityMatches(value.capability, PROSPEO_CONTACT_IDENTITY_CAPABILITY) ||
    !(value.inputCursor === null || boundedText(value.inputCursor, 64))
  ) {
    return;
  }
  const index = selectedIndex(value, query.selected_contacts.length);
  const selected =
    index === undefined ? undefined : query.selected_contacts[index];
  return index === undefined || selected === undefined
    ? undefined
    : {
        input: value as unknown as PageInput,
        query,
        selected,
        selectedIndex: index,
      };
};

const parseWorkEmailInput = (value: unknown): ParsedWorkEmail | undefined => {
  if (!(plainRecord(value) && pageEnvelopeIsValid(value, WORK_EMAIL_FIELDS))) {
    return;
  }
  const query = parseWorkEmailQuery(value.normalizedQuery);
  if (
    query === undefined ||
    value.datasetId === query.source_dataset_id ||
    !capabilityMatches(
      value.capability,
      PROSPEO_WORK_EMAIL_RESOLVE_CAPABILITY
    ) ||
    !(value.inputCursor === null || boundedText(value.inputCursor, 64))
  ) {
    return;
  }
  const index = selectedIndex(value, query.selected_contacts.length);
  const selected =
    index === undefined ? undefined : query.selected_contacts[index];
  return index === undefined || selected === undefined
    ? undefined
    : {
        input: value as unknown as PageInput,
        query,
        selected,
        selectedIndex: index,
      };
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

const countryLocation = (code: string): string =>
  COUNTRY_DISPLAY_NAMES.of(code) ?? code;

const discoveryBody = (parsed: ParsedDiscovery): JsonRecord => {
  const filters: JsonRecord = {
    company: {
      websites: { include: [...parsed.organizationsByDomain.keys()] },
    },
    max_person_per_company: parsed.input.limits.maxContactsPerCompany,
    person_contact_details: {
      email: ["VERIFIED"],
      hide_people_with_details_already_revealed: true,
    },
  };
  if (parsed.query.titles.length > 0) {
    filters.person_job_title = {
      include: parsed.query.titles,
      match_mode: "EXACT",
    };
  }
  if (parsed.query.departments.length > 0) {
    filters.person_department = {
      include: parsed.query.departments.map(
        (department) =>
          DEPARTMENT_TO_PROSPEO[
            department as keyof typeof DEPARTMENT_TO_PROSPEO
          ]
      ),
    };
  }
  if (parsed.query.seniorities.length > 0) {
    filters.person_seniority = {
      include: parsed.query.seniorities.map(
        (seniority) =>
          SENIORITY_TO_PROSPEO[seniority as keyof typeof SENIORITY_TO_PROSPEO]
      ),
    };
  }
  if (parsed.query.person_country_codes.length > 0) {
    filters.person_location_search = {
      include: parsed.query.person_country_codes.map(countryLocation),
    };
  }
  if (parsed.query.company_headquarters_country_codes.length > 0) {
    filters.company_location_search = {
      include:
        parsed.query.company_headquarters_country_codes.map(countryLocation),
    };
  }
  return { filters, page: parsed.page };
};

const enrichBody = (
  providerSubjectId: string,
  onlyVerifiedEmail: boolean
): JsonRecord => ({
  data: { person_id: providerSubjectId },
  enrich_mobile: false,
  only_verified_email: onlyVerifiedEmail,
});

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
      url.username ||
      url.password ||
      url.port ||
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

const actualCoordinatePresent = (
  value: unknown,
  coordinateKeys: ReadonlySet<string>
): boolean => {
  if (value === null || value === undefined) {
    return false;
  }
  if (!plainRecord(value)) {
    return true;
  }
  if (value.revealed === true) {
    return true;
  }
  for (const key of coordinateKeys) {
    const coordinate = value[key];
    if (
      typeof coordinate === "string" &&
      coordinate.length > 0 &&
      !coordinate.includes("*")
    ) {
      return true;
    }
  }
  return false;
};

const EMAIL_COORDINATE_KEYS = new Set(["email"]);
const MOBILE_COORDINATE_KEYS = new Set([
  "mobile",
  "mobile_national",
  "mobile_international",
]);

const providerCompanyDomains = (value: JsonRecord): ReadonlySet<string> => {
  const candidates = [value.domain, value.website];
  if (Array.isArray(value.other_websites)) {
    candidates.push(...value.other_websites);
  }
  const domains = new Set<string>();
  for (const candidate of candidates) {
    const domain = normalizeDomain(candidate);
    if (domain !== undefined) {
      domains.add(domain);
    }
  }
  return domains;
};

const comparableCompanyName = (value: string): string =>
  value
    .normalize("NFKC")
    .toLocaleLowerCase("en-US")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();

const maskLastName = (value: string): string => {
  const characters = Array.from(value);
  const first = characters[0] ?? "";
  return `${first}${"*".repeat(Math.max(3, characters.length - 1))}`;
};

type DiscoveryPerson = Readonly<{
  firstName: string;
  jobTitle: string;
  lastName: string;
  personId: string;
  personCountryCode: null | string;
}>;

const reduceDiscoveryPerson = (value: unknown): DiscoveryPerson | undefined => {
  if (
    !(
      plainRecord(value) &&
      boundedText(value.person_id, 160) &&
      PROVIDER_SUBJECT_PATTERN.test(value.person_id) &&
      boundedText(value.first_name, 128) &&
      boundedText(value.last_name, 128) &&
      boundedText(value.current_job_title, 255) &&
      !actualCoordinatePresent(value.email, EMAIL_COORDINATE_KEYS) &&
      !actualCoordinatePresent(value.mobile, MOBILE_COORDINATE_KEYS)
    )
  ) {
    return;
  }
  let personCountryCode: null | string = null;
  if (value.location !== null && value.location !== undefined) {
    if (!plainRecord(value.location)) {
      return;
    }
    if (
      value.location.country_code !== null &&
      value.location.country_code !== undefined
    ) {
      if (
        typeof value.location.country_code !== "string" ||
        !COUNTRY_PATTERN.test(value.location.country_code)
      ) {
        return;
      }
      personCountryCode = value.location.country_code;
    }
  }
  return {
    firstName: value.first_name,
    jobTitle: value.current_job_title,
    lastName: value.last_name,
    personCountryCode,
    personId: value.person_id,
  };
};

type DiscoveryResponse = Readonly<{
  currentPage: number;
  people: readonly Readonly<{
    organization: Organization & Readonly<{ domain: string }>;
    person: DiscoveryPerson;
  }>[];
  totalCount: number;
  totalPage: number;
}>;

const discoveryCoordinateIncident = (value: unknown): boolean =>
  plainRecord(value) &&
  (actualCoordinatePresent(value.email, EMAIL_COORDINATE_KEYS) ||
    actualCoordinatePresent(value.mobile, MOBILE_COORDINATE_KEYS));

const matchingOrganization = (
  company: JsonRecord,
  organizationsByDomain: ParsedDiscovery["organizationsByDomain"]
): (Organization & Readonly<{ domain: string }>) | undefined => {
  let match: (Organization & Readonly<{ domain: string }>) | undefined;
  for (const domain of providerCompanyDomains(company)) {
    const organization = organizationsByDomain.get(domain);
    if (organization === undefined) {
      continue;
    }
    if (match !== undefined && match.company_id !== organization.company_id) {
      return;
    }
    match = organization;
  }
  return match;
};

const discoveryEnvelopeIsValid = (
  root: JsonRecord,
  parsed: ParsedDiscovery
): root is JsonRecord &
  Readonly<{
    pagination: JsonRecord &
      Readonly<{
        current_page: number;
        total_count: number;
        total_page: number;
      }>;
    results: readonly unknown[];
  }> =>
  hasExactKeys(root, ["error", "free", "pagination", "results"]) &&
  root.error === false &&
  typeof root.free === "boolean" &&
  Array.isArray(root.results) &&
  root.results.length <= PROSPEO_PAGE_SIZE &&
  plainRecord(root.pagination) &&
  hasExactKeys(root.pagination, [
    "current_page",
    "per_page",
    "total_count",
    "total_page",
  ]) &&
  root.pagination.current_page === parsed.page &&
  root.pagination.per_page === PROSPEO_PAGE_SIZE &&
  boundedInteger(root.pagination.total_page, 0, PROSPEO_MAX_PAGE) &&
  boundedInteger(
    root.pagination.total_count,
    0,
    PROSPEO_MAX_PAGE * PROSPEO_PAGE_SIZE
  ) &&
  root.pagination.total_page ===
    Math.ceil(root.pagination.total_count / PROSPEO_PAGE_SIZE) &&
  (root.pagination.total_page === 0 ||
    parsed.page <= root.pagination.total_page) &&
  root.pagination.total_count >= root.results.length;

const reduceDiscoveryResponse = (
  value: unknown,
  parsed: ParsedDiscovery
): DiscoveryResponse | undefined => {
  const validated = validatePluginJson(value);
  if (!(validated.ok && plainRecord(validated.value))) {
    return;
  }
  const root = validated.value;
  if (!discoveryEnvelopeIsValid(root, parsed)) {
    return;
  }
  const people: DiscoveryResponse["people"][number][] = [];
  const ids = new Set<string>();
  const companyCounts = new Map<string, number>();
  for (const result of root.results) {
    if (
      !(
        plainRecord(result) &&
        hasExactKeys(result, ["company", "person"]) &&
        plainRecord(result.company)
      )
    ) {
      return;
    }
    if (discoveryCoordinateIncident(result.person)) {
      continue;
    }
    const person = reduceDiscoveryPerson(result.person);
    if (person === undefined || !boundedText(result.company.name, 255)) {
      continue;
    }
    const organization = matchingOrganization(
      result.company,
      parsed.organizationsByDomain
    );
    if (organization === undefined) {
      continue;
    }
    if (ids.has(person.personId)) {
      continue;
    }
    const matchedDomain = organization.domain;
    const count = (companyCounts.get(matchedDomain) ?? 0) + 1;
    if (count > parsed.input.limits.maxContactsPerCompany) {
      return;
    }
    ids.add(person.personId);
    companyCounts.set(matchedDomain, count);
    people.push({ organization, person });
  }
  return {
    currentPage: root.pagination.current_page,
    people,
    totalCount: root.pagination.total_count,
    totalPage: root.pagination.total_page,
  };
};

const candidateFor = (
  value: DiscoveryResponse["people"][number],
  query: DiscoveryQuery,
  observedAt: number
): Candidate & Readonly<{ identity_completeness: "obfuscated" }> => ({
  department: null,
  display_name: `${value.person.firstName} ${maskLastName(value.person.lastName)}`,
  identity_completeness: "obfuscated",
  job_title: value.person.jobTitle,
  observed_at_ms: observedAt,
  organization_domain: value.organization.domain,
  organization_id: value.organization.company_id,
  organization_name: value.organization.name,
  person_country_code:
    value.person.personCountryCode ??
    (query.person_country_codes.length === 1
      ? (query.person_country_codes[0] ?? null)
      : null),
  profile_url: null,
  seniority:
    query.seniorities.length === 1 ? (query.seniorities[0] ?? null) : null,
});

const fieldMap = (input: PageInput): ReadonlyMap<string, Field> =>
  new Map(input.fields.map((field) => [field.key, field]));

const discoveryRecord = async (
  candidate: Candidate,
  providerSubjectId: string,
  input: PageInput
): Promise<PageItem> => {
  const fields = fieldMap(input);
  const record: PageRecord = {
    datasetId: input.datasetId,
    recordId: `contact_${await sha256Hex(`${PROVIDER_KEY}\0${providerSubjectId}\0${candidate.organization_id}`)}`,
    values: Object.keys(DISCOVERY_FIELDS).map((key) => ({
      fieldId: fields.get(key)?.fieldId ?? "",
      value: candidate[key as keyof Candidate],
    })),
    workspaceId: input.workspaceId,
  };
  return {
    contentHash: await hash(record),
    providerIdentity: { providerKey: PROVIDER_KEY, providerSubjectId },
    record,
  };
};

const enrichEnvelope = (
  value: unknown,
  expectedProviderSubjectId: string
):
  | Readonly<{ company: null | JsonRecord; person: null | JsonRecord }>
  | undefined => {
  const validated = validatePluginJson(value);
  if (!(validated.ok && plainRecord(validated.value))) {
    return;
  }
  const root = validated.value;
  if (
    !(
      hasExactKeys(root, ["company", "error", "free_enrichment", "person"]) &&
      root.error === false &&
      typeof root.free_enrichment === "boolean" &&
      (root.person === null || plainRecord(root.person)) &&
      (root.company === null || plainRecord(root.company))
    )
  ) {
    return;
  }
  if (root.person === null) {
    return root.company === null ? { company: null, person: null } : undefined;
  }
  if (root.person.person_id !== expectedProviderSubjectId) {
    return;
  }
  return { company: root.company, person: root.person };
};

const reduceIdentityResponse = (
  value: unknown,
  selected: SelectedIdentity,
  observedAt: number
): ContactIdentityResolution | null | undefined => {
  const envelope = enrichEnvelope(
    value,
    selected.provider_identity.provider_subject_id
  );
  if (envelope === undefined) {
    return;
  }
  if (envelope.person === null) {
    return null;
  }
  if (
    !(
      boundedText(envelope.person.first_name, 128) &&
      boundedText(envelope.person.last_name, 128)
    ) ||
    actualCoordinatePresent(envelope.person.mobile, MOBILE_COORDINATE_KEYS)
  ) {
    return;
  }
  const created = createContactIdentityResolution({
    displayName: `${envelope.person.first_name} ${envelope.person.last_name}`,
    firstName: envelope.person.first_name,
    identityCompleteness: "full",
    lastName: envelope.person.last_name,
    observedAt: observedAt as ContactIdentityResolution["observedAt"],
    profileUrl: normalizedLinkedInProfile(envelope.person.linkedin_url),
  });
  return created.ok ? created.value : undefined;
};

type WorkEmailOutcome =
  | Readonly<{ kind: "not-found"; observedAt: number }>
  | Readonly<{ kind: "resolved"; value: ContactWorkEmailResolution }>;

const workEmailMatchesSelectedOrganization = (
  email: string,
  company: null | JsonRecord,
  selected: SelectedWorkEmail
): boolean => {
  const separator = email.lastIndexOf("@");
  if (separator <= 0) {
    return false;
  }
  const emailDomain = normalizeDomain(email.slice(separator + 1));
  const expectedDomain = selected.candidate.organization_domain;
  if (emailDomain === expectedDomain) {
    return (
      company === null || providerCompanyDomains(company).has(expectedDomain)
    );
  }
  if (
    emailDomain === undefined ||
    company === null ||
    !boundedText(company.name, 255) ||
    comparableCompanyName(company.name) !==
      comparableCompanyName(selected.candidate.organization_name)
  ) {
    return false;
  }
  const providerDomains = providerCompanyDomains(company);
  return (
    providerDomains.has(expectedDomain) && providerDomains.has(emailDomain)
  );
};

const reduceWorkEmailResponse = (
  value: unknown,
  selected: SelectedWorkEmail,
  observedAt: number
): WorkEmailOutcome | undefined => {
  const envelope = enrichEnvelope(
    value,
    selected.provider_identity.provider_subject_id
  );
  if (envelope === undefined) {
    return;
  }
  if (envelope.person === null) {
    return { kind: "not-found", observedAt };
  }
  if (actualCoordinatePresent(envelope.person.mobile, MOBILE_COORDINATE_KEYS)) {
    return;
  }
  const email = envelope.person.email;
  if (email === null || email === undefined) {
    return { kind: "not-found", observedAt };
  }
  if (
    !(
      plainRecord(email) &&
      email.status === "VERIFIED" &&
      email.revealed === true &&
      boundedText(email.email, 320) &&
      EMAIL_PATTERN.test(email.email) &&
      !email.email.includes("*") &&
      workEmailMatchesSelectedOrganization(
        email.email,
        envelope.company,
        selected
      )
    )
  ) {
    return;
  }
  const confidence =
    typeof email.confidence === "number" &&
    Number.isFinite(email.confidence) &&
    email.confidence >= 0 &&
    email.confidence <= 1
      ? email.confidence
      : null;
  const created = createContactWorkEmailResolution({
    confidence,
    email: email.email,
    observedAt: observedAt as ContactWorkEmailResolution["observedAt"],
    source: "provider_unspecified",
    verification: "valid",
  });
  return created.ok ? { kind: "resolved", value: created.value } : undefined;
};

const joinedItem = async (
  input: PageInput,
  sourceDatasetId: string,
  sourceRecordId: string,
  providerSubjectId: string,
  valuesByKey: Readonly<Record<string, boolean | null | number | string>>,
  fieldOrder: readonly string[]
): Promise<PageItem> => {
  const fields = fieldMap(input);
  const record: PageRecord = {
    datasetId: input.datasetId,
    recordId: sourceRecordId,
    values: fieldOrder.map((key) => ({
      fieldId: fields.get(key)?.fieldId ?? "",
      value: valuesByKey[key] ?? null,
    })),
    workspaceId: input.workspaceId,
  };
  return {
    contentHash: await hash(record),
    providerIdentity: { providerKey: PROVIDER_KEY, providerSubjectId },
    record,
    source: { datasetId: sourceDatasetId, recordId: sourceRecordId },
  };
};

const identityItem = (
  parsed: ParsedIdentity,
  resolution: ContactIdentityResolution | undefined,
  observedAt: number
): Promise<PageItem> => {
  const candidate = parsed.selected.candidate;
  return joinedItem(
    parsed.input,
    parsed.query.source_dataset_id,
    parsed.selected.source_record_id,
    parsed.selected.provider_identity.provider_subject_id,
    {
      department: candidate.department,
      display_name: resolution?.displayName ?? candidate.display_name,
      first_name: resolution?.firstName ?? null,
      identity_completeness:
        resolution?.identityCompleteness ?? candidate.identity_completeness,
      identity_observed_at_ms: observedAt,
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
    },
    Object.keys(IDENTITY_FIELDS)
  );
};

const workEmailItem = (
  parsed: ParsedWorkEmail,
  outcome: WorkEmailOutcome
): Promise<PageItem> => {
  const candidate = parsed.selected.candidate;
  const identity = parsed.selected.identity;
  const resolution = outcome.kind === "resolved" ? outcome.value : undefined;
  const observedAt =
    outcome.kind === "resolved" ? outcome.value.observedAt : outcome.observedAt;
  return joinedItem(
    parsed.input,
    parsed.query.source_dataset_id,
    parsed.selected.source_record_id,
    parsed.selected.provider_identity.provider_subject_id,
    {
      department: candidate.department,
      display_name: identity.display_name,
      first_name: identity.first_name,
      identity_completeness: "full",
      identity_observed_at_ms: identity.observed_at_ms,
      identity_status: "found",
      job_title: candidate.job_title,
      last_name: identity.last_name,
      observed_at_ms: candidate.observed_at_ms,
      organization_domain: candidate.organization_domain,
      organization_id: candidate.organization_id,
      organization_name: candidate.organization_name,
      person_country_code: candidate.person_country_code,
      profile_url: identity.profile_url,
      seniority: candidate.seniority,
      work_email: resolution?.email ?? null,
      work_email_confidence: resolution?.confidence ?? null,
      work_email_observed_at_ms: observedAt,
      work_email_source: resolution?.source ?? null,
      work_email_status: outcome.kind === "resolved" ? "found" : "not_found",
      work_email_verification: resolution?.verification ?? null,
    },
    Object.keys(WORK_EMAIL_FIELDS)
  );
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

const usage = Object.freeze({
  amount: 1,
  basis: "exact" as const,
  unit: "requests",
});
const zeroUsage = Object.freeze({
  amount: 0,
  basis: "exact" as const,
  unit: "requests",
});

const failedResponse = (
  response: Response
): PluginExecuteResult | undefined => {
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

type HttpOutcome = "not-found" | "ok" | PluginExecuteResult;

const providerErrorCode = async (
  response: Response,
  signal: AbortSignal
): Promise<string | undefined> => {
  let value: unknown;
  try {
    value = await responseJson(response, signal);
  } catch {
    return;
  }
  const validated = validatePluginJson(value);
  return validated.ok &&
    plainRecord(validated.value) &&
    validated.value.error === true &&
    boundedText(validated.value.error_code, 128)
    ? validated.value.error_code
    : undefined;
};

const httpOutcome = async (
  response: Response,
  signal: AbortSignal,
  serverFailureOutcome: "ambiguous" | "retryable" = "retryable"
): Promise<HttpOutcome> => {
  if (response.status === 200) {
    return "ok";
  }
  if (response.status === 400) {
    const errorCode = await providerErrorCode(response, signal);
    if (errorCode === undefined) {
      return {
        error: { class: "response", reasonCode: "provider-response-invalid" },
        status: "outcome-unknown",
      };
    }
    if (errorCode === "NO_RESULTS" || errorCode === "NO_MATCH") {
      return "not-found";
    }
    if (errorCode === "INVALID_API_KEY") {
      return {
        error: { class: "authentication", reasonCode: "authentication-failed" },
        status: "failed",
        usage,
      };
    }
    if (errorCode === "INSUFFICIENT_CREDITS") {
      return {
        error: { class: "quota", reasonCode: "quota-exhausted" },
        status: "failed",
        usage,
      };
    }
    if (
      errorCode === "SERVICE_TEMPORARILY_UNAVAILABLE" ||
      errorCode === "INTERNAL_ERROR"
    ) {
      return {
        error: { class: "provider", reasonCode: "provider-unavailable" },
        status: "failed",
        usage,
      };
    }
    return {
      error: { class: "provider", reasonCode: "provider-rejected" },
      status: "failed",
      usage,
    };
  }
  if (
    serverFailureOutcome === "ambiguous" &&
    response.status >= 500 &&
    response.status <= 599
  ) {
    await response.body?.cancel().catch(() => undefined);
    return {
      error: { class: "provider", reasonCode: "provider-unavailable" },
      status: "outcome-unknown",
    };
  }
  const failed = failedResponse(response);
  if (failed !== undefined) {
    await response.body?.cancel().catch(() => undefined);
    return failed;
  }
  await response.body?.cancel().catch(() => undefined);
  return {
    error: { class: "unknown", reasonCode: "unclassified" },
    status: "outcome-unknown",
  };
};

const preflight = (
  request: PluginExecuteRequest,
  clock: ProspeoClock,
  requiredQuote: number
):
  | Readonly<{
      controller: AbortController;
      timer: ReturnType<typeof setTimeout>;
    }>
  | PluginExecuteResult => {
  if (
    request.quote.upperBound === undefined ||
    request.quote.upperBound < requiredQuote
  ) {
    return {
      error: { class: "quota", reasonCode: "quota-exhausted" },
      status: "failed",
      usage: zeroUsage,
    };
  }
  const now = safeNow(clock);
  const deadlineAt = Math.min(
    request.context.deadlineAtMs,
    request.quote.expiresAtMs,
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
  return {
    controller,
    timer: setTimeout(() => controller.abort(), deadlineAt - now),
  };
};

const fetchOnce = async (
  endpoint: string,
  body: JsonRecord,
  apiKey: string,
  fetchImplementation: typeof fetch,
  controller: AbortController
): Promise<Response | PluginExecuteResult> => {
  try {
    const response = await fetchImplementation(endpoint, {
      body: JSON.stringify(body),
      headers: {
        accept: "application/json",
        "cache-control": "no-cache",
        "content-type": "application/json",
        "x-key": apiKey,
      },
      method: "POST",
      redirect: "error",
      signal: controller.signal,
    });
    if (controller.signal.aborted) {
      await response.body?.cancel().catch(() => undefined);
      return {
        error: { class: "deadline", reasonCode: "deadline-exceeded" },
        status: "outcome-unknown",
      };
    }
    return response;
  } catch {
    return {
      error: controller.signal.aborted
        ? { class: "deadline", reasonCode: "deadline-exceeded" }
        : { class: "transport", reasonCode: "transport-failed" },
      status: "outcome-unknown",
    };
  }
};

const isExecuteResult = (
  value: Response | PluginExecuteResult
): value is PluginExecuteResult => !(value instanceof Response);

const executeDiscovery = async (options: {
  apiKey: string;
  clock: ProspeoClock;
  fetch: typeof fetch;
  request: PluginExecuteRequest;
}): Promise<PluginExecuteResult> => {
  const parsed = parseDiscoveryInput(options.request.input.value);
  if (parsed === undefined) {
    return {
      error: { class: "input", reasonCode: "input-invalid" },
      status: "failed",
      usage: zeroUsage,
    };
  }
  const checked = preflight(
    options.request,
    options.clock,
    parsed.requestCount
  );
  if ("status" in checked) {
    return checked;
  }
  try {
    if (parsed.requestCount === 0) {
      return {
        providerPayload: {
          hasMore: false,
          items: [],
          nextCursor: null,
          sourcePartitionCompleted: true,
          version: "1.0.0",
        } satisfies PageOutput,
        status: "succeeded",
        usage: zeroUsage,
      };
    }
    const response = await fetchOnce(
      SEARCH_ENDPOINT,
      discoveryBody(parsed),
      options.apiKey,
      options.fetch,
      checked.controller
    );
    if (isExecuteResult(response)) {
      return response;
    }
    const httpStatusOutcome = await httpOutcome(
      response,
      checked.controller.signal
    );
    if (httpStatusOutcome !== "ok") {
      if (httpStatusOutcome !== "not-found") {
        return httpStatusOutcome;
      }
      return {
        providerPayload: {
          hasMore: false,
          items: [],
          nextCursor: null,
          sourcePartitionCompleted: true,
          version: "1.0.0",
        } satisfies PageOutput,
        status: "succeeded",
        usage,
      };
    }
    let reduced: DiscoveryResponse | undefined;
    try {
      reduced = reduceDiscoveryResponse(
        await responseJson(response, checked.controller.signal),
        parsed
      );
    } catch {
      reduced = undefined;
    }
    if (reduced === undefined) {
      return {
        error: checked.controller.signal.aborted
          ? { class: "deadline", reasonCode: "deadline-exceeded" }
          : { class: "response", reasonCode: "provider-response-invalid" },
        status: "outcome-unknown",
      };
    }
    const maximum = Math.min(
      parsed.input.limits.maxContactsTotal,
      parsed.input.limits.maxResults
    );
    const selected = reduced.people.slice(0, maximum);
    const items = await Promise.all(
      selected.map(({ organization, person }) =>
        discoveryRecord(
          candidateFor(
            { organization, person },
            parsed.query,
            safeNow(options.clock)
          ),
          person.personId,
          parsed.input
        )
      )
    );
    const providerHasMore = reduced.currentPage < reduced.totalPage;
    const reachedKurobaraLimit = items.length >= maximum;
    const hasMore = providerHasMore && !reachedKurobaraLimit;
    const output: PageOutput = {
      hasMore,
      items,
      nextCursor: hasMore ? `page:${reduced.currentPage + 1}` : null,
      sourcePartitionCompleted: !hasMore,
      version: "1.0.0",
    };
    return { providerPayload: output, status: "succeeded", usage };
  } catch {
    return {
      error: checked.controller.signal.aborted
        ? { class: "deadline", reasonCode: "deadline-exceeded" }
        : { class: "response", reasonCode: "provider-response-invalid" },
      status: "outcome-unknown",
    };
  } finally {
    clearTimeout(checked.timer);
  }
};

const executeIdentity = async (options: {
  apiKey: string;
  clock: ProspeoClock;
  fetch: typeof fetch;
  request: PluginExecuteRequest;
}): Promise<PluginExecuteResult> => {
  const parsed = parseIdentityInput(options.request.input.value);
  if (parsed === undefined) {
    return {
      error: { class: "input", reasonCode: "input-invalid" },
      status: "failed",
      usage: zeroUsage,
    };
  }
  const checked = preflight(options.request, options.clock, 1);
  if ("status" in checked) {
    return checked;
  }
  try {
    const response = await fetchOnce(
      ENRICH_ENDPOINT,
      enrichBody(parsed.selected.provider_identity.provider_subject_id, false),
      options.apiKey,
      options.fetch,
      checked.controller
    );
    if (isExecuteResult(response)) {
      return response;
    }
    const workEmailHttpOutcome = await httpOutcome(
      response,
      checked.controller.signal,
      "ambiguous"
    );
    if (workEmailHttpOutcome !== "ok") {
      if (workEmailHttpOutcome !== "not-found") {
        return workEmailHttpOutcome;
      }
      const nextIndex = parsed.selectedIndex + 1;
      const hasMore = nextIndex < parsed.query.selected_contacts.length;
      return {
        providerPayload: {
          hasMore,
          items: [
            await identityItem(parsed, undefined, safeNow(options.clock)),
          ],
          nextCursor: hasMore ? `contact:${nextIndex}` : null,
          sourcePartitionCompleted: !hasMore,
          version: "1.0.0",
        } satisfies PageOutput,
        status: "succeeded",
        usage,
      };
    }
    let reduced: ContactIdentityResolution | null | undefined;
    try {
      reduced = reduceIdentityResponse(
        await responseJson(response, checked.controller.signal),
        parsed.selected,
        safeNow(options.clock)
      );
    } catch {
      reduced = undefined;
    }
    if (reduced === undefined) {
      return {
        error: checked.controller.signal.aborted
          ? { class: "deadline", reasonCode: "deadline-exceeded" }
          : { class: "response", reasonCode: "provider-response-invalid" },
        status: "outcome-unknown",
      };
    }
    const nextIndex = parsed.selectedIndex + 1;
    const hasMore = nextIndex < parsed.query.selected_contacts.length;
    const observedAt =
      reduced === null ? safeNow(options.clock) : reduced.observedAt;
    const output: PageOutput = {
      hasMore,
      items: [
        await identityItem(
          parsed,
          reduced === null ? undefined : reduced,
          observedAt
        ),
      ],
      nextCursor: hasMore ? `contact:${nextIndex}` : null,
      sourcePartitionCompleted: !hasMore,
      version: "1.0.0",
    };
    return { providerPayload: output, status: "succeeded", usage };
  } catch {
    return {
      error: checked.controller.signal.aborted
        ? { class: "deadline", reasonCode: "deadline-exceeded" }
        : { class: "response", reasonCode: "provider-response-invalid" },
      status: "outcome-unknown",
    };
  } finally {
    clearTimeout(checked.timer);
  }
};

const executeWorkEmail = async (options: {
  apiKey: string;
  clock: ProspeoClock;
  fetch: typeof fetch;
  request: PluginExecuteRequest;
}): Promise<PluginExecuteResult> => {
  const parsed = parseWorkEmailInput(options.request.input.value);
  if (parsed === undefined) {
    return {
      error: { class: "input", reasonCode: "input-invalid" },
      status: "failed",
      usage: zeroUsage,
    };
  }
  const checked = preflight(options.request, options.clock, 1);
  if ("status" in checked) {
    return checked;
  }
  try {
    const response = await fetchOnce(
      ENRICH_ENDPOINT,
      enrichBody(parsed.selected.provider_identity.provider_subject_id, true),
      options.apiKey,
      options.fetch,
      checked.controller
    );
    if (isExecuteResult(response)) {
      return response;
    }
    const workEmailHttpOutcome = await httpOutcome(
      response,
      checked.controller.signal,
      "ambiguous"
    );
    if (workEmailHttpOutcome !== "ok") {
      if (workEmailHttpOutcome !== "not-found") {
        return workEmailHttpOutcome;
      }
      const nextIndex = parsed.selectedIndex + 1;
      const hasMore = nextIndex < parsed.query.selected_contacts.length;
      return {
        providerPayload: {
          hasMore,
          items: [
            await workEmailItem(parsed, {
              kind: "not-found",
              observedAt: safeNow(options.clock),
            }),
          ],
          nextCursor: hasMore ? `contact:${nextIndex}` : null,
          sourcePartitionCompleted: !hasMore,
          version: "1.0.0",
        } satisfies PageOutput,
        status: "succeeded",
        usage,
      };
    }
    let outcome: WorkEmailOutcome | undefined;
    try {
      outcome = reduceWorkEmailResponse(
        await responseJson(response, checked.controller.signal),
        parsed.selected,
        safeNow(options.clock)
      );
    } catch {
      outcome = undefined;
    }
    if (outcome === undefined) {
      return {
        error: checked.controller.signal.aborted
          ? { class: "deadline", reasonCode: "deadline-exceeded" }
          : { class: "response", reasonCode: "provider-response-invalid" },
        status: "outcome-unknown",
      };
    }
    const nextIndex = parsed.selectedIndex + 1;
    const hasMore = nextIndex < parsed.query.selected_contacts.length;
    const output: PageOutput = {
      hasMore,
      items: [await workEmailItem(parsed, outcome)],
      nextCursor: hasMore ? `contact:${nextIndex}` : null,
      sourcePartitionCompleted: !hasMore,
      version: "1.0.0",
    };
    return { providerPayload: output, status: "succeeded", usage };
  } catch {
    return {
      error: checked.controller.signal.aborted
        ? { class: "deadline", reasonCode: "deadline-exceeded" }
        : { class: "response", reasonCode: "provider-response-invalid" },
      status: "outcome-unknown",
    };
  } finally {
    clearTimeout(checked.timer);
  }
};

const outputEnvelopeIsValid = (
  value: unknown,
  expectedItemCount: Readonly<{ maximum: number; minimum: number }>,
  allowedFields: number,
  requireSource: boolean,
  cursorPattern: RegExp
): value is PageOutput => {
  if (
    !(
      plainRecord(value) &&
      hasExactKeys(value, [
        "hasMore",
        "items",
        "nextCursor",
        "sourcePartitionCompleted",
        "version",
      ]) &&
      typeof value.hasMore === "boolean" &&
      ((value.hasMore &&
        typeof value.nextCursor === "string" &&
        cursorPattern.test(value.nextCursor) &&
        value.sourcePartitionCompleted === false) ||
        (!value.hasMore &&
          value.nextCursor === null &&
          value.sourcePartitionCompleted === true)) &&
      value.version === "1.0.0" &&
      Array.isArray(value.items) &&
      value.items.length >= expectedItemCount.minimum &&
      value.items.length <= expectedItemCount.maximum
    )
  ) {
    return false;
  }
  return value.items.every((item) => {
    if (!plainRecord(item)) {
      return false;
    }
    const expectedKeys = requireSource
      ? ["contentHash", "providerIdentity", "record", "source"]
      : ["contentHash", "providerIdentity", "record"];
    if (
      !(
        hasExactKeys(item, expectedKeys) &&
        typeof item.contentHash === "string" &&
        HASH_PATTERN.test(item.contentHash) &&
        plainRecord(item.providerIdentity) &&
        hasExactKeys(item.providerIdentity, [
          "providerKey",
          "providerSubjectId",
        ]) &&
        item.providerIdentity.providerKey === PROVIDER_KEY &&
        typeof item.providerIdentity.providerSubjectId === "string" &&
        PROVIDER_SUBJECT_PATTERN.test(
          item.providerIdentity.providerSubjectId
        ) &&
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
        item.record.values.length === allowedFields &&
        item.record.values.every(
          (entry) =>
            plainRecord(entry) &&
            hasExactKeys(entry, ["fieldId", "value"]) &&
            boundedText(entry.fieldId, 255) &&
            (entry.value === null ||
              typeof entry.value === "boolean" ||
              (typeof entry.value === "number" &&
                Number.isFinite(entry.value)) ||
              (typeof entry.value === "string" && entry.value.length <= 16_384))
        )
      )
    ) {
      return false;
    }
    if (
      requireSource &&
      !(
        plainRecord(item.source) &&
        hasExactKeys(item.source, ["datasetId", "recordId"]) &&
        boundedText(item.source.datasetId, 255) &&
        boundedText(item.source.recordId, 255) &&
        item.record.recordId === item.source.recordId
      )
    ) {
      return false;
    }
    return true;
  });
};

const pageOutputIsValid = async (
  value: unknown,
  capabilityId: string
): Promise<boolean> => {
  const selected =
    capabilityId === PROSPEO_CONTACT_IDENTITY_CAPABILITY.capabilityId ||
    capabilityId === PROSPEO_WORK_EMAIL_RESOLVE_CAPABILITY.capabilityId;
  let fieldCount = Object.keys(DISCOVERY_FIELDS).length;
  if (capabilityId === PROSPEO_CONTACT_IDENTITY_CAPABILITY.capabilityId) {
    fieldCount = Object.keys(IDENTITY_FIELDS).length;
  } else if (
    capabilityId === PROSPEO_WORK_EMAIL_RESOLVE_CAPABILITY.capabilityId
  ) {
    fieldCount = Object.keys(WORK_EMAIL_FIELDS).length;
  }
  if (
    !outputEnvelopeIsValid(
      value,
      selected
        ? { maximum: 1, minimum: 1 }
        : { maximum: MAX_CONTACTS_TOTAL, minimum: 0 },
      fieldCount,
      selected,
      selected ? CONTACT_CURSOR_PATTERN : PAGE_CURSOR_PATTERN
    )
  ) {
    return false;
  }
  return (
    await Promise.all(
      value.items.map(
        async (item) => item.contentHash === (await hash(item.record))
      )
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
    return { error: { class: "provider", reasonCode: "provider-unavailable" } };
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
      ...PROSPEO_CONTACT_DISCOVERY_CAPABILITY,
      inputContract: PROSPEO_CONTACT_DISCOVERY_CONTRACTS.input,
      outputContract: PROSPEO_CONTACT_DISCOVERY_CONTRACTS.output,
    },
    {
      ...PROSPEO_CONTACT_IDENTITY_CAPABILITY,
      inputContract: PROSPEO_CONTACT_IDENTITY_CONTRACTS.input,
      outputContract: PROSPEO_CONTACT_IDENTITY_CONTRACTS.output,
    },
    {
      ...PROSPEO_WORK_EMAIL_RESOLVE_CAPABILITY,
      inputContract: PROSPEO_WORK_EMAIL_CONTRACTS.input,
      outputContract: PROSPEO_WORK_EMAIL_CONTRACTS.output,
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
  id: "dev.kurobara.provider-prospeo",
  permissions: { egress: { hosts: [HOSTNAME], tlsRequired: true } },
  version: "1.0.0",
} as const satisfies PluginManifestV1);

const capabilityKind = (
  capability: Readonly<{ capabilityId: string; capabilityVersion: string }>
): "discovery" | "identity" | "work-email" | undefined => {
  if (
    capability.capabilityId ===
      PROSPEO_CONTACT_DISCOVERY_CAPABILITY.capabilityId &&
    capability.capabilityVersion ===
      PROSPEO_CONTACT_DISCOVERY_CAPABILITY.capabilityVersion
  ) {
    return "discovery";
  }
  if (
    capability.capabilityId ===
      PROSPEO_CONTACT_IDENTITY_CAPABILITY.capabilityId &&
    capability.capabilityVersion ===
      PROSPEO_CONTACT_IDENTITY_CAPABILITY.capabilityVersion
  ) {
    return "identity";
  }
  if (
    capability.capabilityId ===
      PROSPEO_WORK_EMAIL_RESOLVE_CAPABILITY.capabilityId &&
    capability.capabilityVersion ===
      PROSPEO_WORK_EMAIL_RESOLVE_CAPABILITY.capabilityVersion
  ) {
    return "work-email";
  }
};

const estimatedRequestCount = (
  kind: ReturnType<typeof capabilityKind>,
  value: unknown
): number | undefined => {
  if (kind === "discovery") {
    return parseDiscoveryInput(value)?.requestCount;
  }
  if (kind === "identity") {
    return parseIdentityInput(value) === undefined ? undefined : 1;
  }
  if (kind === "work-email") {
    return parseWorkEmailInput(value) === undefined ? undefined : 1;
  }
};

/**
 * Owner-key Prospeo adapter. Search pages use only organization websites from
 * the immutable snapshot and reduce full names to a public obfuscated
 * shortlist. Selected identity and work-email pages reuse the restricted
 * Prospeo person ID. Mobile enrichment is disabled on every enrich request;
 * incidental identity email fields are deliberately discarded.
 */
export const createProspeoProviderAdapter = (
  options: ProspeoProviderOptions
): PluginAdapterV1 => {
  if (!apiKeyIsValid(options.apiKey)) {
    throw new ProspeoProviderConfigurationError();
  }
  const clock = options.clock ?? { now: Date.now };
  const fetchImplementation = options.fetch ?? globalThis.fetch;
  return definePluginAdapter({
    classifyError: classify,
    describe: () => ({ manifest }),
    estimate: (request) => {
      const kind = capabilityKind(request.context.capability);
      const requestCount = estimatedRequestCount(kind, request.input.value);
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
      const kind = capabilityKind(request.context.capability);
      if (kind === "identity") {
        return executeIdentity({
          apiKey: options.apiKey,
          clock,
          fetch: fetchImplementation,
          request,
        });
      }
      if (kind === "work-email") {
        return executeWorkEmail({
          apiKey: options.apiKey,
          clock,
          fetch: fetchImplementation,
          request,
        });
      }
      return executeDiscovery({
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
      const valid =
        payload.ok &&
        (await pageOutputIsValid(
          payload.value,
          request.context.capability.capabilityId
        ));
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
