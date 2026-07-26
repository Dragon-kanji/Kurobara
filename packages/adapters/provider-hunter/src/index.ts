import {
  type ContactWorkEmailResolution,
  type ContactWorkEmailVerification,
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
import type {
  ContactWorkEmailProviderPort,
  ContactWorkEmailProviderResult,
} from "@kurobara/ports";

const ENDPOINT = "https://api.hunter.io/v2/discover";
const EMAIL_FINDER_ENDPOINT = "https://api.hunter.io/v2/email-finder";
const EMAIL_VERIFIER_ENDPOINT = "https://api.hunter.io/v2/email-verifier";
const HOSTNAME = "api.hunter.io";
const EXECUTE_TIMEOUT_MS = 10_000;
const LOOKUP_TIMEOUT_MS = 1000;
const MAX_API_KEY_LENGTH = 4096;
const MAX_RESPONSE_BYTES = 524_288;
const MAX_RETRY_AFTER_MS = 86_400_000;
const HUNTER_MAX_OFFSET = 10_000;
const HUNTER_PAGE_SIZE = 100;
const MAX_CONTACT_SELECTION = 3;
const CONTACT_PROVIDER_NAMESPACES = new Set([
  "apollo-people-search",
  "prospeo-person-search",
] as const);
const CATALOG_VERSION = "0.12.0";

// Build-time admission binding. The contracts workspace remains outside the
// runtime provider boundary; refresh this after canonical contract generation.
export const HUNTER_CATALOG_FINGERPRINT =
  "sha256:e71489cc76d8e5cd9de5fbf57913402e4310431786ca4dd53bc5b2e069c87afd";
const DATASET_GENERATION_PAGE_INPUT_SCHEMA_FINGERPRINT =
  "sha256:40153b13ed33d9bf086dcfde537ce1e17946b0e82b6e0461683c42c24a382a55";
const DATASET_GENERATION_PAGE_INPUT_SCHEMA_ID =
  "https://schemas.kurobara.invalid/schemas/dataset-generations/page-input/1.0.0";
const DATASET_GENERATION_PAGE_OUTPUT_SCHEMA_FINGERPRINT =
  "sha256:f61bef0f513210cf17c84fd53aad2c1624a6913a732e98597056a442bc589ab3";
const DATASET_GENERATION_PAGE_OUTPUT_SCHEMA_ID =
  "https://schemas.kurobara.invalid/schemas/dataset-generations/page-output/1.0.0";

export const HUNTER_COMPANY_DISCOVERY_CAPABILITY = Object.freeze({
  capabilityId: "organizations.discover",
  capabilityVersion: "1.0.0",
});

export const HUNTER_WORK_EMAIL_RESOLVE_CAPABILITY = Object.freeze({
  capabilityId: "contacts.work-email.resolve",
  capabilityVersion: "1.0.0",
});

export const HUNTER_WORK_EMAIL_VERIFY_CAPABILITY = Object.freeze({
  capabilityId: "contacts.work-email.verify",
  capabilityVersion: "1.0.0",
});

export const HUNTER_COMPANY_DISCOVERY_CONTRACTS = Object.freeze({
  input: Object.freeze({
    catalogFingerprint: HUNTER_CATALOG_FINGERPRINT,
    catalogVersion: CATALOG_VERSION,
    schemaFingerprint: DATASET_GENERATION_PAGE_INPUT_SCHEMA_FINGERPRINT,
    schemaId: DATASET_GENERATION_PAGE_INPUT_SCHEMA_ID,
    schemaVersion: "1.0.0",
  }),
  output: Object.freeze({
    catalogFingerprint: HUNTER_CATALOG_FINGERPRINT,
    catalogVersion: CATALOG_VERSION,
    schemaFingerprint: DATASET_GENERATION_PAGE_OUTPUT_SCHEMA_FINGERPRINT,
    schemaId: DATASET_GENERATION_PAGE_OUTPUT_SCHEMA_ID,
    schemaVersion: "1.0.0",
  }),
}) satisfies Readonly<{
  input: PluginContractRef;
  output: PluginContractRef;
}>;

export const HUNTER_WORK_EMAIL_CONTRACTS = HUNTER_COMPANY_DISCOVERY_CONTRACTS;

export const HUNTER_INDUSTRY_MAPPING_VERSION = "kurobara-v1-hunter-1";

const INDUSTRY_LABELS = Object.freeze({
  gaming: "Computer Games",
  software: "Software Development",
} as const);

const HEADCOUNT_BUCKETS = Object.freeze([
  { label: "1-10", maximum: 10, minimum: 1 },
  { label: "11-50", maximum: 50, minimum: 11 },
  { label: "51-200", maximum: 200, minimum: 51 },
  { label: "201-500", maximum: 500, minimum: 201 },
  { label: "501-1000", maximum: 1000, minimum: 501 },
  { label: "1001-5000", maximum: 5000, minimum: 1001 },
  { label: "5001-10000", maximum: 10_000, minimum: 5001 },
  { label: "10001+", maximum: 1_000_000_000, minimum: 10_001 },
] as const);

const EXPECTED_FIELDS = Object.freeze({
  country_code: "string",
  domain: "string",
  employee_count: "number",
  industry_code: "string",
  name: "string",
  observed_at_ms: "number",
} as const);

const WORK_EMAIL_EXPECTED_FIELDS = Object.freeze({
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

const WORK_EMAIL_FIELD_ORDER = Object.freeze(
  Object.keys(WORK_EMAIL_EXPECTED_FIELDS)
);

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

const QUERY_REQUIRED_KEYS = Object.freeze([
  "country_codes",
  "country_scope",
  "industry_codes",
  "industry_taxonomy",
  "result_kind",
] as const);

const WORK_EMAIL_QUERY_KEYS = Object.freeze([
  "operation_kind",
  "result_kind",
  "selected_contacts",
  "source_dataset_id",
] as const);

const CONTACT_CANDIDATE_KEYS = Object.freeze([
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

const CONTACT_IDENTITY_KEYS = Object.freeze([
  "display_name",
  "first_name",
  "last_name",
  "observed_at_ms",
  "profile_url",
] as const);

const CONTACT_PROVIDER_IDENTITY_KEYS = Object.freeze([
  "provider_key",
  "provider_subject_id",
] as const);

const SELECTED_RESOLVE_CONTACT_KEYS = Object.freeze([
  "candidate",
  "identity",
  "provider_identity",
  "source_record_id",
] as const);

const SELECTED_VERIFY_CONTACT_KEYS = Object.freeze([
  ...SELECTED_RESOLVE_CONTACT_KEYS,
  "work_email",
] as const);

const SOURCE_WORK_EMAIL_KEYS = Object.freeze([
  "confidence",
  "email",
  "observed_at_ms",
  "source",
  "verification",
] as const);

const HASH_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const COUNTRY_PATTERN = /^[A-Z]{2}$/u;
const DOMAIN_LABEL_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;
const INDUSTRY_CODE_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/u;
const CURSOR_PATTERN = /^offset:([1-9]\d*)$/u;
const CONTACT_CURSOR_PATTERN = /^contact:([1-9]\d*)$/u;
const TAXONOMY_PATTERN = /^[a-z][a-z0-9._-]{0,127}$/u;
const PROVIDER_SUBJECT_PATTERN = /^\S{1,512}$/u;
const EMAIL_PATTERN = /^[^@\s]+@[^@\s]+$/u;
const UNSIGNED_INTEGER_PATTERN = /^\d+$/u;
const JSON_CONTENT_TYPE_PATTERN =
  /^application\/[a-z0-9!#$&^_.+-]*\+?json(?:\s*;|$)/u;

const CONTACT_SENIORITIES = new Set([
  "owner",
  "c_suite",
  "vp",
  "director",
  "manager",
  "senior",
  "individual_contributor",
]);

const WORK_EMAIL_VERIFICATIONS = new Set([
  "accept_all",
  "invalid",
  "unknown",
  "valid",
]);

type JsonRecord = Record<string, unknown>;
type HunterClock = Readonly<{ now: () => number }>;

type OrganizationDiscoveryQueryValue = Readonly<{
  country_codes: readonly string[];
  country_scope: "headquarters";
  employee_count?: Readonly<{ maximum: number; minimum: number }>;
  industry_codes: readonly string[];
  industry_taxonomy: "kurobara-v1";
  keywords?: readonly string[];
  result_kind: "company";
}>;

type FullContactCandidateValue = Readonly<{
  department: null | string;
  display_name: string;
  identity_completeness: "full";
  job_title: string;
  observed_at_ms: number;
  organization_domain: string;
  organization_id: string;
  organization_name: string;
  person_country_code: null | string;
  profile_url: null | string;
  seniority:
    | "owner"
    | "c_suite"
    | "vp"
    | "director"
    | "manager"
    | "senior"
    | "individual_contributor"
    | null;
}>;

type FullContactIdentityValue = Readonly<{
  display_name: string;
  first_name: string;
  last_name: string;
  observed_at_ms: number;
  profile_url: null | string;
}>;

type RestrictedContactProviderIdentityValue = Readonly<{
  provider_key: "apollo-people-search" | "prospeo-person-search";
  provider_subject_id: string;
}>;

type SourceWorkEmailValue = Readonly<{
  confidence: null | number;
  email: string;
  observed_at_ms: number;
  source: "provider_unspecified";
  verification: "accept_all" | "invalid" | "unknown" | "valid";
}>;

type SelectedWorkEmailContactValue = Readonly<{
  candidate: FullContactCandidateValue;
  identity: FullContactIdentityValue;
  provider_identity: RestrictedContactProviderIdentityValue;
  source_record_id: string;
  work_email?: SourceWorkEmailValue;
}>;

type WorkEmailOperationKind = "resolve" | "verify";

type ContactWorkEmailQueryValue = Readonly<{
  operation_kind: WorkEmailOperationKind;
  result_kind: "contact_work_email";
  selected_contacts: readonly SelectedWorkEmailContactValue[];
  source_dataset_id: string;
}>;

type DatasetGenerationLimitsValue = Readonly<{
  maxCalls: number;
  maxCompanies: number;
  maxContactsPerCompany: number;
  maxContactsTotal: number;
  maxEnrichments: number;
  maxPages: number;
  maxPhones: number;
  maxResults: number;
}>;

type DatasetGenerationFieldValue = Readonly<{
  datasetId: string;
  fieldId: string;
  key: string;
  label: string;
  valueType: "boolean" | "number" | "string";
  workspaceId: string;
}>;

type DatasetGenerationPageInputValue = Readonly<{
  capability: typeof HUNTER_COMPANY_DISCOVERY_CAPABILITY;
  datasetId: string;
  fields: readonly DatasetGenerationFieldValue[];
  generationId: string;
  generationPlanId: string;
  inputCursor: unknown;
  kind: "dataset-generation-page-input";
  limits: DatasetGenerationLimitsValue;
  normalizedQuery: OrganizationDiscoveryQueryValue;
  pageSequence: number;
  planHash: string;
  queryHash: string;
  schemaHash: string;
  version: "1.0.0";
  workspaceId: string;
}>;

type ContactWorkEmailPageInputValue = Readonly<{
  capability:
    | typeof HUNTER_WORK_EMAIL_RESOLVE_CAPABILITY
    | typeof HUNTER_WORK_EMAIL_VERIFY_CAPABILITY;
  datasetId: string;
  fields: readonly DatasetGenerationFieldValue[];
  generationId: string;
  generationPlanId: string;
  inputCursor: null | string;
  kind: "dataset-generation-page-input";
  limits: DatasetGenerationLimitsValue;
  normalizedQuery: ContactWorkEmailQueryValue;
  pageSequence: number;
  planHash: string;
  queryHash: string;
  schemaHash: string;
  version: "1.0.0";
  workspaceId: string;
}>;

type CompanyCandidateValue = Readonly<{
  company_id: string;
  country_code: string;
  domain: string;
  employee_count: number | null;
  industry_code: string | null;
  name: string;
  observed_at_ms: number;
}>;

type DatasetGenerationRecordValue = Readonly<{
  datasetId: string;
  recordId: string;
  values: readonly Readonly<{
    fieldId: string;
    value: boolean | null | number | string;
  }>[];
  workspaceId: string;
}>;

type DatasetGenerationPageOutputValue = Readonly<{
  hasMore: boolean;
  items: readonly Readonly<{
    contentHash: string;
    providerIdentity?: Readonly<{
      providerKey: string;
      providerSubjectId: string;
    }>;
    record: DatasetGenerationRecordValue;
    source?: Readonly<{
      datasetId: string;
      recordId: string;
    }>;
  }>[];
  nextCursor: string | null;
  sourcePartitionCompleted: boolean;
  version: "1.0.0";
}>;

type ParsedWorkEmailInput = Readonly<{
  input: ContactWorkEmailPageInputValue;
  operationKind: WorkEmailOperationKind;
  query: ContactWorkEmailQueryValue;
  selectedContact: SelectedWorkEmailContactValue;
  selectedContactIndex: number;
}>;

export type HunterProviderOptions = Readonly<{
  apiKey: string;
  clock?: HunterClock;
  fetch?: typeof fetch;
}>;

export class HunterProviderConfigurationError extends Error {
  readonly reasonCode = "provider-hunter-configuration-invalid" as const;

  constructor() {
    super("Hunter provider configuration is invalid.");
    this.name = "HunterProviderConfigurationError";
  }
}

export class HunterContactProviderError extends Error {
  readonly reasonCode:
    | "provider-response-invalid"
    | "provider-rejected"
    | "rate-limited"
    | "transport-outcome-unknown";

  constructor(
    reasonCode: HunterContactProviderError["reasonCode"],
    message: string
  ) {
    super(message);
    this.name = "HunterContactProviderError";
    this.reasonCode = reasonCode;
  }
}

/** Hunter Domain Search reveals paid emails before record selection. */
export const HUNTER_CONTACT_SHORTLIST_ADMISSION = Object.freeze({
  capability: "contacts.discover@1.0.0",
  reasonCode: "shortlist-inseparable-from-email-reveal",
  status: "inadmissible",
} as const);

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
  const keys = Object.keys(value).sort();
  const sorted = [...expected].sort();
  return (
    keys.length === sorted.length &&
    keys.every((key, index) => key === sorted[index])
  );
};

const boundedText = (value: unknown, maximum: number): value is string =>
  typeof value === "string" &&
  value.trim().length > 0 &&
  value.length <= maximum;

const boundedTrimmedText = (value: unknown, maximum: number): value is string =>
  boundedText(value, maximum) && value.trim() === value;

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
  value.length > 0 &&
  value.length <= options.maximumCount &&
  value.every(
    (entry) =>
      boundedText(entry, options.maximumLength) &&
      (options.pattern === undefined || options.pattern.test(entry))
  ) &&
  new Set(value).size === value.length;

const normalizeDomain = (value: unknown): string | undefined => {
  if (typeof value !== "string") {
    return;
  }
  const domain = value.trim().toLowerCase();
  if (
    domain.length > 253 ||
    domain.endsWith(".") ||
    domain.includes(":") ||
    domain.includes("/") ||
    domain.includes("@")
  ) {
    return;
  }
  const labels = domain.split(".");
  return labels.length >= 2 &&
    labels.every((label) => DOMAIN_LABEL_PATTERN.test(label))
    ? domain
    : undefined;
};

const workEmailMatchesOrganizationDomain = (
  email: unknown,
  organizationDomain: unknown
): boolean => {
  if (typeof email !== "string") {
    return false;
  }
  const separator = email.lastIndexOf("@");
  if (separator <= 0 || separator === email.length - 1) {
    return false;
  }
  const emailDomain = normalizeDomain(email.slice(separator + 1));
  const expectedDomain = normalizeDomain(organizationDomain);
  return emailDomain !== undefined && emailDomain === expectedDomain;
};

const secureHttpsUrl = (value: unknown): value is string => {
  if (!boundedTrimmedText(value, 2048)) {
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

const safeNow = (clock: HunterClock): number => {
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

const apiKeyIsValid = (value: string): boolean =>
  value.length > 0 &&
  value.length <= MAX_API_KEY_LENGTH &&
  value.trim() === value &&
  !Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f);
  });

const limitsAreValid = (
  value: unknown
): value is DatasetGenerationLimitsValue =>
  plainRecord(value) &&
  hasExactKeys(value, LIMIT_KEYS) &&
  LIMIT_KEYS.every((key) =>
    boundedInteger(value[key], 0, Number.MAX_SAFE_INTEGER)
  ) &&
  boundedInteger(value.maxCalls, 1, 10_000) &&
  boundedInteger(value.maxCompanies, 1, 1_000_000) &&
  boundedInteger(value.maxPages, 1, 10_000) &&
  boundedInteger(value.maxResults, 1, 1_000_000);

const workEmailLimitsAreValid = (
  value: unknown,
  selectionCount: number,
  selectionIndex: number
): value is DatasetGenerationLimitsValue =>
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
): value is readonly DatasetGenerationFieldValue[] => {
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
): value is readonly DatasetGenerationFieldValue[] =>
  fieldsMatch(value, datasetId, workspaceId, EXPECTED_FIELDS);

const workEmailFieldsAreValid = (
  value: unknown,
  datasetId: string,
  workspaceId: string
): value is readonly DatasetGenerationFieldValue[] =>
  fieldsMatch(value, datasetId, workspaceId, WORK_EMAIL_EXPECTED_FIELDS);

const exactHeadcountBuckets = (
  value: unknown
): readonly (typeof HEADCOUNT_BUCKETS)[number]["label"][] | undefined => {
  if (value === undefined) {
    return [];
  }
  if (
    !(
      plainRecord(value) &&
      hasExactKeys(value, ["maximum", "minimum"]) &&
      boundedInteger(value.minimum, 1, 1_000_000_000) &&
      boundedInteger(value.maximum, 1, 1_000_000_000)
    ) ||
    value.maximum < value.minimum
  ) {
    return;
  }
  const first = HEADCOUNT_BUCKETS.findIndex(
    (bucket) => bucket.minimum === value.minimum
  );
  const last = HEADCOUNT_BUCKETS.findIndex(
    (bucket) => bucket.maximum === value.maximum
  );
  if (first < 0 || last < first) {
    return;
  }
  return HEADCOUNT_BUCKETS.slice(first, last + 1).map((bucket) => bucket.label);
};

type ParsedQuery = Readonly<{
  headcount: readonly (typeof HEADCOUNT_BUCKETS)[number]["label"][];
  hunterIndustries: readonly string[];
  value: OrganizationDiscoveryQueryValue;
}>;

const parseQuery = (value: unknown): ParsedQuery | undefined => {
  if (!plainRecord(value)) {
    return;
  }
  const allowed = new Set([
    ...QUERY_REQUIRED_KEYS,
    "employee_count",
    "keywords",
  ]);
  if (
    !QUERY_REQUIRED_KEYS.every((key) => Object.hasOwn(value, key)) ||
    Object.keys(value).some((key) => !allowed.has(key)) ||
    value.country_scope !== "headquarters" ||
    value.industry_taxonomy !== "kurobara-v1" ||
    value.result_kind !== "company" ||
    !uniqueStrings(value.country_codes, {
      maximumCount: 32,
      maximumLength: 2,
      pattern: COUNTRY_PATTERN,
    }) ||
    value.country_codes.length !== 1 ||
    !uniqueStrings(value.industry_codes, {
      maximumCount: 64,
      maximumLength: 128,
      pattern: INDUSTRY_CODE_PATTERN,
    }) ||
    !value.industry_codes.every((code) =>
      Object.hasOwn(INDUSTRY_LABELS, code)
    ) ||
    (value.keywords !== undefined &&
      !uniqueStrings(value.keywords, {
        maximumCount: 32,
        maximumLength: 128,
      }))
  ) {
    return;
  }
  const headcount = exactHeadcountBuckets(value.employee_count);
  if (headcount === undefined) {
    return;
  }
  return {
    headcount,
    hunterIndustries: value.industry_codes.map(
      (code) => INDUSTRY_LABELS[code as keyof typeof INDUSTRY_LABELS]
    ),
    value: value as unknown as OrganizationDiscoveryQueryValue,
  };
};

type ParsedInput = Readonly<{
  input: DatasetGenerationPageInputValue;
  offset: number;
  query: ParsedQuery;
}>;

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
  const { capability } = value;
  const query = parseQuery(value.normalizedQuery);
  if (
    datasetId === undefined ||
    workspaceId === undefined ||
    !plainRecord(capability) ||
    !hasExactKeys(capability, ["capabilityId", "capabilityVersion"]) ||
    capability.capabilityId !==
      HUNTER_COMPANY_DISCOVERY_CAPABILITY.capabilityId ||
    capability.capabilityVersion !==
      HUNTER_COMPANY_DISCOVERY_CAPABILITY.capabilityVersion ||
    value.kind !== "dataset-generation-page-input" ||
    value.version !== "1.0.0" ||
    !boundedText(value.generationId, 255) ||
    !boundedText(value.generationPlanId, 255) ||
    !boundedInteger(value.pageSequence, 1, 10_000) ||
    !limitsAreValid(value.limits) ||
    !fieldsAreValid(value.fields, datasetId, workspaceId) ||
    query === undefined ||
    typeof value.planHash !== "string" ||
    !HASH_PATTERN.test(value.planHash) ||
    typeof value.queryHash !== "string" ||
    !HASH_PATTERN.test(value.queryHash) ||
    typeof value.schemaHash !== "string" ||
    !HASH_PATTERN.test(value.schemaHash)
  ) {
    return;
  }
  let offset = 0;
  if (value.pageSequence === 1) {
    if (value.inputCursor !== null) {
      return;
    }
  } else {
    if (typeof value.inputCursor !== "string") {
      return;
    }
    const match = CURSOR_PATTERN.exec(value.inputCursor);
    const parsed = match?.[1] === undefined ? Number.NaN : Number(match[1]);
    if (
      !Number.isSafeInteger(parsed) ||
      parsed > HUNTER_MAX_OFFSET ||
      parsed !== (value.pageSequence - 1) * HUNTER_PAGE_SIZE
    ) {
      return;
    }
    offset = parsed;
  }
  if (
    value.pageSequence > value.limits.maxCalls ||
    value.pageSequence > value.limits.maxPages ||
    offset >= value.limits.maxCompanies
  ) {
    return;
  }
  return {
    input: value as unknown as DatasetGenerationPageInputValue,
    offset,
    query,
  };
};

const fullCandidateIsValid = (
  value: unknown
): value is FullContactCandidateValue => {
  if (!(plainRecord(value) && hasExactKeys(value, CONTACT_CANDIDATE_KEYS))) {
    return false;
  }
  const normalizedOrganizationDomain = normalizeDomain(
    value.organization_domain
  );
  return (
    (value.department === null ||
      (boundedTrimmedText(value.department, 128) &&
        TAXONOMY_PATTERN.test(value.department))) &&
    boundedTrimmedText(value.display_name, 255) &&
    value.identity_completeness === "full" &&
    boundedTrimmedText(value.job_title, 255) &&
    boundedInteger(value.observed_at_ms, 0, Number.MAX_SAFE_INTEGER) &&
    typeof value.organization_domain === "string" &&
    normalizedOrganizationDomain === value.organization_domain &&
    boundedTrimmedText(value.organization_id, 255) &&
    boundedTrimmedText(value.organization_name, 255) &&
    (value.person_country_code === null ||
      (typeof value.person_country_code === "string" &&
        COUNTRY_PATTERN.test(value.person_country_code))) &&
    (value.profile_url === null || secureHttpsUrl(value.profile_url)) &&
    (value.seniority === null ||
      (typeof value.seniority === "string" &&
        CONTACT_SENIORITIES.has(value.seniority)))
  );
};

const fullIdentityIsValid = (
  value: unknown
): value is FullContactIdentityValue =>
  plainRecord(value) &&
  hasExactKeys(value, CONTACT_IDENTITY_KEYS) &&
  boundedTrimmedText(value.display_name, 255) &&
  boundedTrimmedText(value.first_name, 128) &&
  boundedTrimmedText(value.last_name, 128) &&
  boundedInteger(value.observed_at_ms, 0, Number.MAX_SAFE_INTEGER) &&
  (value.profile_url === null || secureHttpsUrl(value.profile_url));

const providerIdentityIsValid = (
  value: unknown
): value is RestrictedContactProviderIdentityValue =>
  plainRecord(value) &&
  hasExactKeys(value, CONTACT_PROVIDER_IDENTITY_KEYS) &&
  typeof value.provider_key === "string" &&
  CONTACT_PROVIDER_NAMESPACES.has(
    value.provider_key as RestrictedContactProviderIdentityValue["provider_key"]
  ) &&
  typeof value.provider_subject_id === "string" &&
  PROVIDER_SUBJECT_PATTERN.test(value.provider_subject_id);

const sourceWorkEmailIsValid = (
  value: unknown,
  organizationDomain: unknown
): value is SourceWorkEmailValue =>
  plainRecord(value) &&
  hasExactKeys(value, SOURCE_WORK_EMAIL_KEYS) &&
  (value.confidence === null ||
    (typeof value.confidence === "number" &&
      Number.isFinite(value.confidence) &&
      value.confidence >= 0 &&
      value.confidence <= 1)) &&
  boundedTrimmedText(value.email, 320) &&
  EMAIL_PATTERN.test(value.email) &&
  workEmailMatchesOrganizationDomain(value.email, organizationDomain) &&
  boundedInteger(value.observed_at_ms, 0, Number.MAX_SAFE_INTEGER) &&
  value.source === "provider_unspecified" &&
  typeof value.verification === "string" &&
  WORK_EMAIL_VERIFICATIONS.has(value.verification);

const parseSelectedWorkEmailContact = (
  value: unknown,
  operationKind: WorkEmailOperationKind
): SelectedWorkEmailContactValue | undefined => {
  const expectedKeys =
    operationKind === "resolve"
      ? SELECTED_RESOLVE_CONTACT_KEYS
      : SELECTED_VERIFY_CONTACT_KEYS;
  if (
    !(
      plainRecord(value) &&
      hasExactKeys(value, expectedKeys) &&
      boundedTrimmedText(value.source_record_id, 255) &&
      fullCandidateIsValid(value.candidate) &&
      fullIdentityIsValid(value.identity) &&
      providerIdentityIsValid(value.provider_identity) &&
      value.candidate.display_name === value.identity.display_name &&
      value.candidate.profile_url === value.identity.profile_url &&
      (operationKind === "resolve" ||
        sourceWorkEmailIsValid(
          value.work_email,
          value.candidate.organization_domain
        ))
    )
  ) {
    return;
  }
  return {
    candidate: value.candidate,
    identity: value.identity,
    provider_identity: {
      provider_key: value.provider_identity.provider_key,
      provider_subject_id: value.provider_identity.provider_subject_id,
    },
    source_record_id: value.source_record_id,
    ...(operationKind === "verify" ? { work_email: value.work_email } : {}),
  } as SelectedWorkEmailContactValue;
};

const parseWorkEmailQuery = (
  value: unknown
): ContactWorkEmailQueryValue | undefined => {
  if (
    !(
      plainRecord(value) &&
      hasExactKeys(value, WORK_EMAIL_QUERY_KEYS) &&
      (value.operation_kind === "resolve" ||
        value.operation_kind === "verify") &&
      value.result_kind === "contact_work_email" &&
      boundedTrimmedText(value.source_dataset_id, 255) &&
      Array.isArray(value.selected_contacts) &&
      value.selected_contacts.length >= 1 &&
      value.selected_contacts.length <= MAX_CONTACT_SELECTION
    )
  ) {
    return;
  }
  const selectedContacts: SelectedWorkEmailContactValue[] = [];
  const recordIds = new Set<string>();
  const providerSubjectIds = new Set<string>();
  for (const selected of value.selected_contacts) {
    const parsed = parseSelectedWorkEmailContact(
      selected,
      value.operation_kind
    );
    if (
      parsed === undefined ||
      recordIds.has(parsed.source_record_id) ||
      providerSubjectIds.has(parsed.provider_identity.provider_subject_id)
    ) {
      return;
    }
    recordIds.add(parsed.source_record_id);
    providerSubjectIds.add(parsed.provider_identity.provider_subject_id);
    selectedContacts.push(parsed);
  }
  return {
    operation_kind: value.operation_kind,
    result_kind: "contact_work_email",
    selected_contacts: selectedContacts,
    source_dataset_id: value.source_dataset_id,
  };
};

const parseWorkEmailInput = (
  value: unknown
): ParsedWorkEmailInput | undefined => {
  if (!(plainRecord(value) && hasExactKeys(value, INPUT_KEYS))) {
    return;
  }
  const datasetId = boundedTrimmedText(value.datasetId, 255)
    ? value.datasetId
    : undefined;
  const workspaceId = boundedTrimmedText(value.workspaceId, 255)
    ? value.workspaceId
    : undefined;
  const query = parseWorkEmailQuery(value.normalizedQuery);
  if (
    datasetId === undefined ||
    workspaceId === undefined ||
    query === undefined ||
    datasetId === query.source_dataset_id ||
    !plainRecord(value.capability) ||
    !hasExactKeys(value.capability, ["capabilityId", "capabilityVersion"]) ||
    value.capability.capabilityVersion !== "1.0.0" ||
    (query.operation_kind === "resolve"
      ? value.capability.capabilityId !==
        HUNTER_WORK_EMAIL_RESOLVE_CAPABILITY.capabilityId
      : value.capability.capabilityId !==
        HUNTER_WORK_EMAIL_VERIFY_CAPABILITY.capabilityId) ||
    value.kind !== "dataset-generation-page-input" ||
    value.version !== "1.0.0" ||
    !(
      value.inputCursor === null || boundedTrimmedText(value.inputCursor, 64)
    ) ||
    !boundedTrimmedText(value.generationId, 255) ||
    !boundedTrimmedText(value.generationPlanId, 255) ||
    !workEmailFieldsAreValid(value.fields, datasetId, workspaceId) ||
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
    !workEmailLimitsAreValid(
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
    input: value as unknown as ContactWorkEmailPageInputValue,
    operationKind: query.operation_kind,
    query,
    selectedContact,
    selectedContactIndex,
  };
};

const requestBody = (input: ParsedInput): JsonRecord => ({
  headquarters_location: {
    include: input.query.value.country_codes.map((country) => ({ country })),
  },
  industry: { include: input.query.hunterIndustries },
  ...(input.query.headcount.length === 0
    ? {}
    : { headcount: input.query.headcount }),
  ...(input.query.value.keywords === undefined
    ? {}
    : {
        keywords: {
          include: input.query.value.keywords,
          match: "all",
        },
      }),
  ...(input.offset === 0 ? {} : { offset: input.offset }),
  // Hunter reserves custom page sizes for eligible plans. Requesting the
  // documented default keeps the first page portable; pageOutput still
  // truncates before any record crosses the operator's immutable cap.
  limit: HUNTER_PAGE_SIZE,
});

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
  let streamComplete = false;
  try {
    while (!streamComplete) {
      if (signal.aborted) {
        throw new Error("aborted");
      }
      const chunk = await reader.read();
      if (chunk.done) {
        streamComplete = true;
        continue;
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
  let position = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, position);
    position += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
};

type HunterCompany = Readonly<{ domain: string; name: string }>;
type HunterResponse = Readonly<{
  companies: readonly HunterCompany[];
  limit: number;
  offset: number;
  total: number;
}>;

const reduceResponse = (
  value: unknown,
  input: ParsedInput
): HunterResponse | undefined => {
  const validated = validatePluginJson(value);
  if (!(validated.ok && plainRecord(validated.value))) {
    return;
  }
  const root = validated.value;
  if (
    !(hasExactKeys(root, ["data", "meta"]) && Array.isArray(root.data)) ||
    root.data.length > HUNTER_PAGE_SIZE ||
    !plainRecord(root.meta) ||
    !boundedInteger(root.meta.results, 0, Number.MAX_SAFE_INTEGER) ||
    root.meta.limit !== HUNTER_PAGE_SIZE ||
    root.meta.offset !== input.offset ||
    root.meta.results < input.offset + root.data.length
  ) {
    return;
  }
  const companies: HunterCompany[] = [];
  const domains = new Set<string>();
  for (const entry of root.data) {
    if (!plainRecord(entry)) {
      return;
    }
    const domain = normalizeDomain(entry.domain);
    if (
      domain === undefined ||
      !boundedText(entry.organization, 255) ||
      domains.has(domain)
    ) {
      return;
    }
    domains.add(domain);
    companies.push({ domain, name: entry.organization.trim() });
  }
  return {
    companies,
    limit: root.meta.limit,
    offset: root.meta.offset,
    total: root.meta.results,
  };
};

const fieldMap = (
  input: DatasetGenerationPageInputValue
): ReadonlyMap<string, DatasetGenerationFieldValue> =>
  new Map(input.fields.map((field) => [field.key, field]));

const candidateFor = async (
  company: HunterCompany,
  input: ParsedInput,
  observedAt: number
): Promise<CompanyCandidateValue> => ({
  company_id: `company_${await sha256Hex(`hunter-discover\0${company.domain}`)}`,
  country_code: input.query.value.country_codes[0] ?? "",
  domain: company.domain,
  employee_count: null,
  industry_code:
    input.query.value.industry_codes.length === 1
      ? (input.query.value.industry_codes[0] ?? null)
      : null,
  name: company.name,
  observed_at_ms: observedAt,
});

const recordFor = async (
  candidate: CompanyCandidateValue,
  input: DatasetGenerationPageInputValue
): Promise<DatasetGenerationPageOutputValue["items"][number]> => {
  const fields = fieldMap(input);
  const values = [
    ["name", candidate.name],
    ["domain", candidate.domain],
    ["country_code", candidate.country_code],
    ["industry_code", candidate.industry_code],
    ["employee_count", candidate.employee_count],
    ["observed_at_ms", candidate.observed_at_ms],
  ].map(([key, value]) => ({
    fieldId: fields.get(key as string)?.fieldId ?? "",
    value: value as null | number | string,
  }));
  const record = {
    datasetId: input.datasetId,
    recordId: candidate.company_id,
    values,
    workspaceId: input.workspaceId,
  };
  return { contentHash: await hash(record), record };
};

const pageOutput = async (
  response: HunterResponse,
  parsed: ParsedInput,
  observedAt: number
): Promise<DatasetGenerationPageOutputValue | undefined> => {
  if (
    response.offset !== parsed.offset ||
    response.limit !== HUNTER_PAGE_SIZE ||
    response.companies.length > response.limit
  ) {
    return;
  }
  const selected = response.companies.slice(0, parsed.input.limits.maxResults);
  const nextOffset = parsed.offset + response.companies.length;
  const providerHasMore = nextOffset < response.total;
  if (response.companies.length < response.limit && providerHasMore) {
    return;
  }
  if (providerHasMore && nextOffset > HUNTER_MAX_OFFSET) {
    return;
  }
  return {
    hasMore: providerHasMore,
    items: await Promise.all(
      selected.map(async (company) =>
        recordFor(await candidateFor(company, parsed, observedAt), parsed.input)
      )
    ),
    nextCursor: providerHasMore ? `offset:${nextOffset}` : null,
    sourcePartitionCompleted: !providerHasMore,
    version: "1.0.0",
  };
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

const definiteFailure = (
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
  if (response.status === 451) {
    return {
      error: { class: "provider", reasonCode: "provider-rejected" },
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

const executeCompanyDiscovery = async (options: {
  apiKey: string;
  clock: HunterClock;
  fetch: typeof fetch;
  request: PluginExecuteRequest;
}): Promise<PluginExecuteResult> => {
  const parsed = parseInput(options.request.input.value);
  if (parsed === undefined) {
    return {
      error: { class: "input", reasonCode: "input-invalid" },
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
      response = await options.fetch(ENDPOINT, {
        body: JSON.stringify(requestBody(parsed)),
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          "x-api-key": options.apiKey,
        },
        method: "POST",
        redirect: "error",
        signal: controller.signal,
      });
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
    const failed = definiteFailure(response);
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
    try {
      const reduced = reduceResponse(
        await responseJson(response, controller.signal),
        parsed
      );
      const output =
        reduced === undefined
          ? undefined
          : await pageOutput(reduced, parsed, safeNow(options.clock));
      return output === undefined
        ? {
            error: {
              class: "response",
              reasonCode: "provider-response-invalid",
            },
            status: "outcome-unknown",
          }
        : { providerPayload: output, status: "succeeded", usage };
    } catch {
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
  } finally {
    clearTimeout(timer);
  }
};

const isCompanyPageOutput = async (value: unknown): Promise<boolean> => {
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
    typeof value.sourcePartitionCompleted !== "boolean" ||
    value.sourcePartitionCompleted === value.hasMore ||
    value.version !== "1.0.0" ||
    (value.hasMore
      ? typeof value.nextCursor !== "string" ||
        !CURSOR_PATTERN.test(value.nextCursor)
      : value.nextCursor !== null) ||
    !Array.isArray(value.items) ||
    value.items.length > 10_000
  ) {
    return false;
  }
  const items = value.items as DatasetGenerationPageOutputValue["items"];
  const validItems = items.every(
    (item) =>
      plainRecord(item) &&
      hasExactKeys(item, ["contentHash", "record"]) &&
      typeof item.contentHash === "string" &&
      HASH_PATTERN.test(item.contentHash) &&
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
      item.record.values.length <= 256 &&
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
  if (!validItems) {
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
    if (
      request.context.capability.capabilityId ===
        HUNTER_WORK_EMAIL_RESOLVE_CAPABILITY.capabilityId ||
      request.context.capability.capabilityId ===
        HUNTER_WORK_EMAIL_VERIFY_CAPABILITY.capabilityId
    ) {
      return {
        error: {
          class: "rate-limit",
          reasonCode: "rate-limited",
          ...(request.diagnostic.retryAfterMs === undefined
            ? {}
            : { retryAfterMs: request.diagnostic.retryAfterMs }),
        },
      };
    }
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

const invalidContactResponse = (): HunterContactProviderError =>
  new HunterContactProviderError(
    "provider-response-invalid",
    "Hunter returned an invalid selected contact response."
  );

const finderWorkEmailStatus = (
  data: JsonRecord
): ContactWorkEmailResolution["verification"] => {
  if (data.verification !== undefined) {
    if (!plainRecord(data.verification)) {
      throw invalidContactResponse();
    }
    const status = data.verification.status;
    if (status === "valid" || status === "unknown") {
      return status;
    }
    if (status === "accept_all") {
      return "accept_all";
    }
    throw invalidContactResponse();
  }

  // Strict compatibility fallback for historical Finder fixtures: it is used
  // only when the official nested verification object is absent and accepts
  // only the three statuses emitted by Finder.
  if (data.status === "valid" || data.status === "unknown") {
    return data.status;
  }
  if (data.status === "accept_all") {
    return "accept_all";
  }
  throw invalidContactResponse();
};

const verifierWorkEmailStatus = (
  value: unknown
): ContactWorkEmailVerification["status"] => {
  if (value === "valid" || value === "invalid") {
    return value;
  }
  if (value === "accept_all") {
    return "accept_all";
  }
  if (value === "disposable" || value === "unknown" || value === "webmail") {
    return "unknown";
  }
  throw invalidContactResponse();
};

const hunterContactJson = async (
  response: Response,
  signal: AbortSignal
): Promise<JsonRecord> => {
  if (response.status !== 200) {
    await response.body?.cancel().catch(() => undefined);
    if (response.ok) {
      throw new HunterContactProviderError(
        "transport-outcome-unknown",
        "The Hunter selected contact outcome is unknown."
      );
    }
    if (response.status === 403) {
      throw new HunterContactProviderError(
        "rate-limited",
        "Hunter rate-limited the selected contact operation."
      );
    }
    throw new HunterContactProviderError(
      "provider-rejected",
      "Hunter rejected the selected contact operation."
    );
  }
  let value: unknown;
  try {
    value = await responseJson(response, signal);
  } catch {
    throw new HunterContactProviderError(
      "provider-response-invalid",
      "Hunter returned an invalid selected contact response."
    );
  }
  if (
    !(
      plainRecord(value) &&
      hasExactKeys(value, ["data", "meta"]) &&
      plainRecord(value.data) &&
      plainRecord(value.meta)
    )
  ) {
    throw invalidContactResponse();
  }
  return value.data;
};

const contactFetch = async (
  options: HunterProviderOptions,
  endpoint: string,
  query: Readonly<Record<string, string>>
): Promise<JsonRecord> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), EXECUTE_TIMEOUT_MS);
  try {
    const url = new URL(endpoint);
    for (const [key, value] of Object.entries(query)) {
      url.searchParams.set(key, value);
    }
    let response: Response;
    try {
      response = await (options.fetch ?? globalThis.fetch)(url, {
        headers: { accept: "application/json", "x-api-key": options.apiKey },
        method: "GET",
        redirect: "error",
        signal: controller.signal,
      });
    } catch {
      throw new HunterContactProviderError(
        "transport-outcome-unknown",
        "The Hunter selected contact outcome is unknown."
      );
    }
    return await hunterContactJson(response, controller.signal);
  } finally {
    clearTimeout(timer);
  }
};

const exactContactUsage = <Value>(
  value: Value,
  amount: number
): ContactWorkEmailProviderResult<Value> => ({
  usage: { amount, basis: "exact", unit: "credits" },
  value,
});

/**
 * Selected-only Hunter Finder and Verifier. Raw responses, source payloads,
 * phones, and provider-specific identifiers never escape this adapter.
 */
export const createHunterContactWorkEmailProvider = (
  options: HunterProviderOptions
): ContactWorkEmailProviderPort => {
  if (!apiKeyIsValid(options.apiKey)) {
    throw new HunterProviderConfigurationError();
  }
  const clock = options.clock ?? { now: Date.now };
  return {
    resolve: async ({ contact }) => {
      const data = await contactFetch(options, EMAIL_FINDER_ENDPOINT, {
        domain: contact.candidate.organizationDomain,
        full_name: contact.candidate.displayName,
      });
      if (data.email === null) {
        return exactContactUsage(undefined, 0);
      }
      if (typeof data.email !== "string") {
        throw invalidContactResponse();
      }
      const confidence =
        typeof data.score === "number" &&
        Number.isFinite(data.score) &&
        data.score >= 0 &&
        data.score <= 100
          ? data.score / 100
          : null;
      const created = createContactWorkEmailResolution({
        confidence,
        email: data.email,
        observedAt: safeNow(clock) as ContactWorkEmailResolution["observedAt"],
        source: "provider_unspecified",
        verification: finderWorkEmailStatus(data),
      });
      if (
        !(
          created.ok &&
          workEmailMatchesOrganizationDomain(
            created.value.email,
            contact.candidate.organizationDomain
          )
        )
      ) {
        throw invalidContactResponse();
      }
      return exactContactUsage(created.value, 1);
    },
    verify: async ({ email }) => {
      const data = await contactFetch(options, EMAIL_VERIFIER_ENDPOINT, {
        email,
      });
      const status = verifierWorkEmailStatus(data.status);
      const value: ContactWorkEmailVerification = {
        observedAt: safeNow(
          clock
        ) as ContactWorkEmailVerification["observedAt"],
        status,
      };
      return exactContactUsage(value, status === "unknown" ? 0 : 1);
    },
  };
};

type WorkEmailProviderOutcome =
  | Readonly<{ kind: "not-found"; observedAt: number }>
  | Readonly<{ kind: "resolved"; value: ContactWorkEmailResolution }>
  | Readonly<{ kind: "verified"; value: ContactWorkEmailVerification }>;

const selectedWorkEmailFailure = (
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

const selectedWorkEmailRequestUrl = (parsed: ParsedWorkEmailInput): URL => {
  const url = new URL(
    parsed.operationKind === "resolve"
      ? EMAIL_FINDER_ENDPOINT
      : EMAIL_VERIFIER_ENDPOINT
  );
  if (parsed.operationKind === "resolve") {
    url.searchParams.set(
      "domain",
      parsed.selectedContact.candidate.organization_domain
    );
    url.searchParams.set(
      "full_name",
      parsed.selectedContact.identity.display_name
    );
  } else {
    url.searchParams.set(
      "email",
      parsed.selectedContact.work_email?.email ?? ""
    );
  }
  return url;
};

const reduceSelectedWorkEmailResponse = (
  value: unknown,
  parsed: ParsedWorkEmailInput,
  observedAt: number
): WorkEmailProviderOutcome | undefined => {
  const validated = validatePluginJson(value);
  if (
    !(
      validated.ok &&
      plainRecord(validated.value) &&
      hasExactKeys(validated.value, ["data", "meta"]) &&
      plainRecord(validated.value.data) &&
      plainRecord(validated.value.meta)
    )
  ) {
    return;
  }
  const data = validated.value.data;
  if (parsed.operationKind === "resolve") {
    if (data.email === null) {
      return { kind: "not-found", observedAt };
    }
    if (typeof data.email !== "string") {
      return;
    }
    const confidence =
      typeof data.score === "number" &&
      Number.isFinite(data.score) &&
      data.score >= 0 &&
      data.score <= 100
        ? data.score / 100
        : null;
    let verification: ContactWorkEmailResolution["verification"];
    try {
      verification = finderWorkEmailStatus(data);
    } catch {
      return;
    }
    const created = createContactWorkEmailResolution({
      confidence,
      email: data.email,
      observedAt: observedAt as ContactWorkEmailResolution["observedAt"],
      source: "provider_unspecified",
      verification,
    });
    return created.ok &&
      workEmailMatchesOrganizationDomain(
        created.value.email,
        parsed.selectedContact.candidate.organization_domain
      )
      ? { kind: "resolved", value: created.value }
      : undefined;
  }
  let status: ContactWorkEmailVerification["status"];
  try {
    status = verifierWorkEmailStatus(data.status);
  } catch {
    return;
  }
  return {
    kind: "verified",
    value: {
      observedAt: observedAt as ContactWorkEmailVerification["observedAt"],
      status,
    },
  };
};

const selectedWorkEmailRecord = async (
  parsed: ParsedWorkEmailInput,
  outcome: WorkEmailProviderOutcome
): Promise<DatasetGenerationPageOutputValue["items"][number]> => {
  const fields = new Map(
    parsed.input.fields.map((field) => [field.key, field] as const)
  );
  const { candidate, identity } = parsed.selectedContact;
  const sourceWorkEmail = parsed.selectedContact.work_email;
  const resolution = outcome.kind === "resolved" ? outcome.value : undefined;
  const verification = outcome.kind === "verified" ? outcome.value : undefined;
  const workEmailObservedAt =
    outcome.kind === "not-found"
      ? outcome.observedAt
      : outcome.value.observedAt;
  const valuesByKey: Readonly<
    Record<
      keyof typeof WORK_EMAIL_EXPECTED_FIELDS,
      boolean | null | number | string
    >
  > = {
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
    work_email: resolution?.email ?? sourceWorkEmail?.email ?? null,
    work_email_confidence:
      resolution?.confidence ?? sourceWorkEmail?.confidence ?? null,
    work_email_observed_at_ms: workEmailObservedAt,
    work_email_source: resolution?.source ?? sourceWorkEmail?.source ?? null,
    work_email_status: outcome.kind === "not-found" ? "not_found" : "found",
    work_email_verification:
      resolution?.verification ?? verification?.status ?? null,
  };
  const record: DatasetGenerationRecordValue = {
    datasetId: parsed.input.datasetId,
    recordId: parsed.selectedContact.source_record_id,
    values: WORK_EMAIL_FIELD_ORDER.map((key) => ({
      fieldId: fields.get(key)?.fieldId ?? "",
      value: valuesByKey[key as keyof typeof WORK_EMAIL_EXPECTED_FIELDS],
    })),
    workspaceId: parsed.input.workspaceId,
  };
  return {
    contentHash: await hash(record),
    providerIdentity: {
      providerKey: parsed.selectedContact.provider_identity.provider_key,
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

const executeSelectedWorkEmail = async (options: {
  apiKey: string;
  clock: HunterClock;
  fetch: typeof fetch;
  request: PluginExecuteRequest;
  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: a one-contact page keeps the single irreversible request and its ambiguity classification together.
}): Promise<PluginExecuteResult> => {
  const parsed = parseWorkEmailInput(options.request.input.value);
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
      response = await options.fetch(selectedWorkEmailRequestUrl(parsed), {
        headers: {
          accept: "application/json",
          "cache-control": "no-cache",
          "x-api-key": options.apiKey,
        },
        method: "GET",
        redirect: "error",
        signal: controller.signal,
      });
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
    const failed = selectedWorkEmailFailure(response);
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
    let outcome: WorkEmailProviderOutcome | undefined;
    try {
      outcome = reduceSelectedWorkEmailResponse(
        await responseJson(response, controller.signal),
        parsed,
        safeNow(options.clock)
      );
    } catch {
      outcome = undefined;
    }
    if (outcome === undefined) {
      return {
        error: controller.signal.aborted
          ? { class: "deadline", reasonCode: "deadline-exceeded" }
          : { class: "response", reasonCode: "provider-response-invalid" },
        status: "outcome-unknown",
      };
    }
    const nextContactIndex = parsed.selectedContactIndex + 1;
    const hasMore = nextContactIndex < parsed.query.selected_contacts.length;
    const output: DatasetGenerationPageOutputValue = {
      hasMore,
      items: [await selectedWorkEmailRecord(parsed, outcome)],
      nextCursor: hasMore ? `contact:${nextContactIndex}` : null,
      sourcePartitionCompleted: !hasMore,
      version: "1.0.0",
    };
    return { providerPayload: output, status: "succeeded", usage };
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

const isSelectedWorkEmailPageOutput = async (
  value: unknown
): Promise<boolean> => {
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
      typeof item.providerIdentity.providerKey === "string" &&
      CONTACT_PROVIDER_NAMESPACES.has(
        item.providerIdentity
          .providerKey as RestrictedContactProviderIdentityValue["provider_key"]
      ) &&
      typeof item.providerIdentity.providerSubjectId === "string" &&
      PROVIDER_SUBJECT_PATTERN.test(item.providerIdentity.providerSubjectId) &&
      plainRecord(item.source) &&
      hasExactKeys(item.source, ["datasetId", "recordId"]) &&
      boundedTrimmedText(item.source.datasetId, 255) &&
      boundedTrimmedText(item.source.recordId, 255) &&
      plainRecord(item.record) &&
      hasExactKeys(item.record, [
        "datasetId",
        "recordId",
        "values",
        "workspaceId",
      ]) &&
      boundedTrimmedText(item.record.datasetId, 255) &&
      boundedTrimmedText(item.record.recordId, 255) &&
      item.record.recordId === item.source.recordId &&
      boundedTrimmedText(item.record.workspaceId, 255) &&
      Array.isArray(item.record.values) &&
      item.record.values.length === WORK_EMAIL_FIELD_ORDER.length &&
      item.record.values.every(
        (entry) =>
          plainRecord(entry) &&
          hasExactKeys(entry, ["fieldId", "value"]) &&
          boundedTrimmedText(entry.fieldId, 255) &&
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
};

const manifest = Object.freeze({
  apiVersion: "dev.kurobara.plugin/v1",
  auth: { modes: ["api-key-header"] },
  capabilities: [
    {
      ...HUNTER_COMPANY_DISCOVERY_CAPABILITY,
      inputContract: HUNTER_COMPANY_DISCOVERY_CONTRACTS.input,
      outputContract: HUNTER_COMPANY_DISCOVERY_CONTRACTS.output,
    },
    {
      ...HUNTER_WORK_EMAIL_RESOLVE_CAPABILITY,
      inputContract: HUNTER_WORK_EMAIL_CONTRACTS.input,
      outputContract: HUNTER_WORK_EMAIL_CONTRACTS.output,
    },
    {
      ...HUNTER_WORK_EMAIL_VERIFY_CAPABILITY,
      inputContract: HUNTER_WORK_EMAIL_CONTRACTS.input,
      outputContract: HUNTER_WORK_EMAIL_CONTRACTS.output,
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
  id: "dev.kurobara.provider-hunter",
  permissions: { egress: { hosts: [HOSTNAME], tlsRequired: true } },
  version: "1.1.0",
} as const satisfies PluginManifestV1);

export const createHunterProviderAdapter = (
  options: HunterProviderOptions
): PluginAdapterV1 => {
  if (!apiKeyIsValid(options.apiKey)) {
    throw new HunterProviderConfigurationError();
  }
  const clock = options.clock ?? { now: Date.now };
  const fetchImplementation = options.fetch ?? globalThis.fetch;
  return definePluginAdapter({
    classifyError: classify,
    describe: () => ({ manifest }),
    estimate: (request) => {
      const selectedWorkEmailCapability =
        request.context.capability.capabilityId ===
          HUNTER_WORK_EMAIL_RESOLVE_CAPABILITY.capabilityId ||
        request.context.capability.capabilityId ===
          HUNTER_WORK_EMAIL_VERIFY_CAPABILITY.capabilityId;
      const parsed = selectedWorkEmailCapability
        ? parseWorkEmailInput(request.input.value)
        : parseInput(request.input.value);
      return parsed === undefined
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
              upperBound: 1,
            },
            status: "quoted",
          };
    },
    execute: (request) => {
      const selectedWorkEmailCapability =
        request.context.capability.capabilityId ===
          HUNTER_WORK_EMAIL_RESOLVE_CAPABILITY.capabilityId ||
        request.context.capability.capabilityId ===
          HUNTER_WORK_EMAIL_VERIFY_CAPABILITY.capabilityId;
      return selectedWorkEmailCapability
        ? executeSelectedWorkEmail({
            apiKey: options.apiKey,
            clock,
            fetch: fetchImplementation,
            request,
          })
        : executeCompanyDiscovery({
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
      const selectedWorkEmailCapability =
        request.context.capability.capabilityId ===
          HUNTER_WORK_EMAIL_RESOLVE_CAPABILITY.capabilityId ||
        request.context.capability.capabilityId ===
          HUNTER_WORK_EMAIL_VERIFY_CAPABILITY.capabilityId;
      const valid =
        payload.ok &&
        (selectedWorkEmailCapability
          ? await isSelectedWorkEmailPageOutput(payload.value)
          : await isCompanyPageOutput(payload.value));
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
