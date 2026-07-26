import { randomUUID } from "node:crypto";

import {
  type ContactSeniority,
  createContactCandidate,
  createContactProviderIdentity,
  type Record as DatasetRecord,
  type Instant,
  type InternalContactCandidate,
  instant,
  type RecordId,
  recordId,
} from "@kurobara/kernel";
import type {
  ContactDiscoveryCompanyOutcome,
  ContactDiscoveryPage,
  ContactDiscoveryPageRequest,
  ContactDiscoveryProviderPort,
} from "@kurobara/ports";

const ENDPOINT = "https://api.peopledatalabs.com/v5/person/search";
const PROVIDER_KEY = "pdl";
const EXECUTE_TIMEOUT_MS = 10_000;
const MAX_API_KEY_LENGTH = 4096;
const MAX_RESPONSE_BYTES = 524_288;
const MAX_CONTACTS_PER_COMPANY = 2;
const MAX_CONTACTS_TOTAL = 12;
const MAX_COMPANIES = 10;
const MAX_FILTER_VALUES = 20;
const JSON_CONTENT_TYPE_PATTERN =
  /^application\/[a-z0-9!#$&^_.+-]*\+?json(?:\s*;|$)/u;
const UNSIGNED_INTEGER_PATTERN = /^\d+$/u;
const DOMAIN_LABEL_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;
const TRAILING_DOT_PATTERN = /\.$/u;
const TRAILING_SLASH_PATTERN = /\/$/u;
const PROVIDER_SUBJECT_ID_PATTERN = /^[A-Za-z0-9_-]{1,160}$/u;
const TAXONOMY_PATTERN = /^[a-z][a-z0-9_]{0,63}$/u;
const LINKEDIN_PROFILE_PATH_PATTERN =
  /^\/in\/[A-Za-z0-9](?:[A-Za-z0-9-]{0,98}[A-Za-z0-9])?\/?$/u;

/**
 * Deliberately excludes every email, phone, address and consumer-social field.
 * The exact projection is also the exhaustive profile-response allowlist.
 */
export const PDL_CONTACT_DATA_INCLUDE = Object.freeze([
  "id",
  "full_name",
  "job_title",
  "job_title_role",
  "job_title_levels",
  "job_company_name",
  "job_company_website",
  "location_country",
  "linkedin_url",
] as const);

const PDL_CONTACT_DATA_INCLUDE_PARAMETER = PDL_CONTACT_DATA_INCLUDE.join(",");

const PDL_JOB_ROLES = new Set<string>([
  "advisory",
  "analyst",
  "creative",
  "education",
  "engineering",
  "finance",
  "fulfillment",
  "health",
  "hospitality",
  "human_resources",
  "legal",
  "manufacturing",
  "marketing",
  "operations",
  "partnerships",
  "product",
  "professional_service",
  "public_service",
  "research",
  "sales",
  "sales_engineering",
  "support",
  "trade",
]);

const COUNTRY_NAMES = Object.freeze({
  AD: "andorra",
  AT: "austria",
  AU: "australia",
  BE: "belgium",
  BR: "brazil",
  CA: "canada",
  CH: "switzerland",
  CN: "china",
  CZ: "czechia",
  DE: "germany",
  DK: "denmark",
  ES: "spain",
  FI: "finland",
  FR: "france",
  GB: "united kingdom",
  GR: "greece",
  IE: "ireland",
  IN: "india",
  IT: "italy",
  JP: "japan",
  KR: "south korea",
  LU: "luxembourg",
  MX: "mexico",
  NL: "netherlands",
  NO: "norway",
  NZ: "new zealand",
  PL: "poland",
  PT: "portugal",
  RO: "romania",
  SE: "sweden",
  SG: "singapore",
  US: "united states",
} as const);

type SupportedCountryCode = keyof typeof COUNTRY_NAMES;
type JsonRecord = Record<string, unknown>;
type PdlFetch = (
  input: RequestInfo | URL,
  init?: RequestInit
) => Promise<Response>;

const SENIORITY_TO_PDL_LEVEL = Object.freeze({
  c_suite: "cxo",
  director: "director",
  individual_contributor: "entry",
  manager: "manager",
  owner: "owner",
  senior: "senior",
  vp: "vp",
} satisfies Readonly<Record<ContactSeniority, string>>);

const PDL_LEVEL_TO_SENIORITY: Readonly<Record<string, ContactSeniority>> =
  Object.freeze({
    cxo: "c_suite",
    director: "director",
    entry: "individual_contributor",
    manager: "manager",
    owner: "owner",
    partner: "director",
    senior: "senior",
    training: "individual_contributor",
    unpaid: "individual_contributor",
    vp: "vp",
  });

const COUNTRY_CODE_BY_NAME = new Map<string, SupportedCountryCode>(
  Object.entries(COUNTRY_NAMES).map(([code, name]) => [
    name,
    code as SupportedCountryCode,
  ])
);

const PROFILE_KEYS = PDL_CONTACT_DATA_INCLUDE;
const WRAPPER_REQUIRED_KEYS = Object.freeze([
  "data",
  "status",
  "total",
] as const);
const WRAPPER_ALLOWED_KEYS = new Set([
  ...WRAPPER_REQUIRED_KEYS,
  "scroll_token",
]);

export type PdlContactProviderErrorReason =
  | "authentication-failed"
  | "authorization-failed"
  | "input-invalid"
  | "provider-response-invalid"
  | "provider-rejected"
  | "provider-unavailable"
  | "rate-limited"
  | "transport-outcome-unknown";

export class PdlProviderConfigurationError extends Error {
  readonly reasonCode = "provider-pdl-configuration-invalid" as const;

  constructor() {
    super("PDL provider configuration is invalid.");
    this.name = "PdlProviderConfigurationError";
  }
}

export class PdlContactProviderError extends Error {
  readonly reasonCode: PdlContactProviderErrorReason;

  constructor(reasonCode: PdlContactProviderErrorReason, message: string) {
    super(message);
    this.name = "PdlContactProviderError";
    this.reasonCode = reasonCode;
  }
}

export type PdlContactProviderOptions = Readonly<{
  apiKey: string;
  fetch?: PdlFetch;
  nextContactId?: () => string;
  now?: () => number;
  timeoutMs?: number;
}>;

type PdlProfile = Readonly<{
  full_name: string;
  id: string;
  job_company_name: string;
  job_company_website: string;
  job_title: string;
  job_title_levels: readonly string[] | null;
  job_title_role: string | null;
  linkedin_url: string | null;
  location_country: string | null;
}>;

type PdlSearchResponse = Readonly<{
  data: readonly PdlProfile[];
  scroll_token?: null | string;
  status: 200;
  total: number;
}>;

type NormalizedSearchFilters = Readonly<{
  companyCountryNames: readonly string[];
  departments: readonly string[];
  personCountryNames: readonly string[];
  seniorities: readonly string[];
  titles: readonly string[];
}>;

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
  const sortedExpected = [...expected].sort();
  return (
    actual.length === sortedExpected.length &&
    actual.every((key, index) => key === sortedExpected[index])
  );
};

const hasRequiredAllowedKeys = (
  value: JsonRecord,
  required: readonly string[],
  allowed: ReadonlySet<string>
): boolean =>
  required.every((key) => Object.hasOwn(value, key)) &&
  Object.keys(value).every((key) => allowed.has(key));

const boundedTrimmedText = (value: unknown, maximum: number): value is string =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= maximum &&
  value.trim() === value;

const apiKeyIsValid = (value: unknown): value is string =>
  boundedTrimmedText(value, MAX_API_KEY_LENGTH) &&
  ![...value].some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint !== undefined && (codePoint <= 31 || codePoint === 127);
  });

const throwInvalidInput = (): never => {
  throw new PdlContactProviderError(
    "input-invalid",
    "The PDL contact discovery request is invalid."
  );
};

const throwInvalidResponse = (): never => {
  throw new PdlContactProviderError(
    "provider-response-invalid",
    "PDL returned an invalid contact search response."
  );
};

const unique = <Value>(values: readonly Value[]): readonly Value[] => [
  ...new Set(values),
];

const supportedCountryCodes = (
  values: readonly string[]
): readonly SupportedCountryCode[] => {
  if (values.length > MAX_FILTER_VALUES) {
    throwInvalidInput();
  }
  const result: SupportedCountryCode[] = [];
  for (const value of values) {
    if (!(boundedTrimmedText(value, 2) && value in COUNTRY_NAMES)) {
      throwInvalidInput();
    }
    const code = value as SupportedCountryCode;
    if (!result.includes(code)) {
      result.push(code);
    }
  }
  return result;
};

const normalizedTitles = (values: readonly string[]): readonly string[] => {
  if (
    values.length > MAX_FILTER_VALUES ||
    values.some((value) => !boundedTrimmedText(value, 128))
  ) {
    throwInvalidInput();
  }
  return unique(values.map((value) => value.normalize("NFC").toLowerCase()));
};

const normalizedDepartments = (
  values: readonly string[]
): readonly string[] => {
  if (values.length > MAX_FILTER_VALUES) {
    throwInvalidInput();
  }
  for (const value of values) {
    if (
      !(
        boundedTrimmedText(value, 64) &&
        TAXONOMY_PATTERN.test(value) &&
        PDL_JOB_ROLES.has(value)
      )
    ) {
      throwInvalidInput();
    }
  }
  return unique(values);
};

const normalizedSeniorities = (
  values: readonly string[]
): readonly string[] => {
  if (
    values.length > MAX_FILTER_VALUES ||
    values.some((value) => !(value in SENIORITY_TO_PDL_LEVEL))
  ) {
    throwInvalidInput();
  }
  return unique(
    values.map(
      (value) =>
        SENIORITY_TO_PDL_LEVEL[value as keyof typeof SENIORITY_TO_PDL_LEVEL]
    )
  );
};

const normalizeDomain = (value: unknown): string | undefined => {
  if (typeof value !== "string" || value.trim() !== value) {
    return undefined;
  }
  const domain = value.toLowerCase().replace(TRAILING_DOT_PATTERN, "");
  if (
    domain.length === 0 ||
    domain.length > 253 ||
    domain.includes("..") ||
    !domain.split(".").every((label) => DOMAIN_LABEL_PATTERN.test(label))
  ) {
    return undefined;
  }
  return domain;
};

const fieldMatches = (fieldId: string, leaf: string): boolean =>
  fieldId === leaf ||
  fieldId.endsWith(`_${leaf}`) ||
  fieldId.endsWith(`-${leaf}`) ||
  fieldId.endsWith(`.${leaf}`);

const companyDomain = (company: DatasetRecord): string | undefined => {
  const domainEntry = company.values.find((entry) =>
    fieldMatches(String(entry.fieldId), "domain")
  );
  return normalizeDomain(domainEntry?.value);
};

const companyRecordIdentifier = (
  company: DatasetRecord
): string | undefined => {
  const value = company.recordId;
  return boundedTrimmedText(value, 255) ? String(value) : undefined;
};

const validateRequest = (request: ContactDiscoveryPageRequest): void => {
  if (
    request.companyRecords.length > MAX_COMPANIES ||
    !Number.isSafeInteger(request.maxContactsPerCompany) ||
    request.maxContactsPerCompany < 1 ||
    request.maxContactsPerCompany > MAX_CONTACTS_PER_COMPANY ||
    !Number.isSafeInteger(request.maxContactsTotal) ||
    request.maxContactsTotal < 1 ||
    request.maxContactsTotal > MAX_CONTACTS_TOTAL ||
    !(request.inputCursor === null || typeof request.inputCursor === "string")
  ) {
    throwInvalidInput();
  }
  const companyRecordIds = new Set<string>();
  for (const company of request.companyRecords) {
    const companyRecordId = companyRecordIdentifier(company);
    if (companyRecordId === undefined) {
      continue;
    }
    if (companyRecordIds.has(companyRecordId)) {
      throwInvalidInput();
    }
    companyRecordIds.add(companyRecordId);
  }
};

const buildQuery = (
  domain: string,
  filters: NormalizedSearchFilters
): JsonRecord => {
  const must: JsonRecord[] = [{ term: { job_company_website: domain } }];
  if (filters.titles.length > 0) {
    must.push({
      bool: {
        minimum_should_match: 1,
        should: filters.titles.map((title) => ({
          match_phrase: { job_title: title },
        })),
      },
    });
  }
  if (filters.departments.length > 0) {
    must.push({ terms: { job_title_role: filters.departments } });
  }
  if (filters.seniorities.length > 0) {
    must.push({ terms: { job_title_levels: filters.seniorities } });
  }
  if (filters.personCountryNames.length > 0) {
    must.push({ terms: { location_country: filters.personCountryNames } });
  }
  if (filters.companyCountryNames.length > 0) {
    must.push({
      terms: {
        job_company_location_country: filters.companyCountryNames,
      },
    });
  }
  return { bool: { must } };
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
    throwInvalidResponse();
  }
  const declaredLength = response.headers.get("content-length");
  if (
    declaredLength !== null &&
    (!UNSIGNED_INTEGER_PATTERN.test(declaredLength) ||
      Number(declaredLength) > MAX_RESPONSE_BYTES)
  ) {
    throwInvalidResponse();
  }
  if (response.body === null) {
    return throwInvalidResponse();
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      if (signal.aborted) {
        throw new PdlContactProviderError(
          "transport-outcome-unknown",
          "The PDL contact search outcome is unknown."
        );
      }
      const chunk = await reader.read();
      if (chunk.done) {
        break;
      }
      size += chunk.value.byteLength;
      if (size > MAX_RESPONSE_BYTES) {
        throwInvalidResponse();
      }
      chunks.push(chunk.value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    if (signal.aborted) {
      throw new PdlContactProviderError(
        "transport-outcome-unknown",
        "The PDL contact search outcome is unknown."
      );
    }
    throw error;
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return throwInvalidResponse();
  }
};

const stringOrNull = (
  value: unknown,
  maximum: number
): value is null | string =>
  value === null || boundedTrimmedText(value, maximum);

const titleLevelsAreValid = (
  value: unknown
): value is null | readonly string[] =>
  value === null ||
  (Array.isArray(value) &&
    value.length <= 10 &&
    value.every(
      (level) =>
        boundedTrimmedText(level, 16) && level in PDL_LEVEL_TO_SENIORITY
    ));

const reduceProfile = (value: unknown): PdlProfile => {
  if (!plainRecord(value)) {
    return throwInvalidResponse();
  }
  if (!hasExactKeys(value, PROFILE_KEYS)) {
    return throwInvalidResponse();
  }
  if (!boundedTrimmedText(value.id, 160)) {
    return throwInvalidResponse();
  }
  if (!PROVIDER_SUBJECT_ID_PATTERN.test(value.id)) {
    return throwInvalidResponse();
  }
  if (!boundedTrimmedText(value.full_name, 255)) {
    return throwInvalidResponse();
  }
  if (!boundedTrimmedText(value.job_title, 255)) {
    return throwInvalidResponse();
  }
  if (!boundedTrimmedText(value.job_company_name, 255)) {
    return throwInvalidResponse();
  }
  if (!boundedTrimmedText(value.job_company_website, 2048)) {
    return throwInvalidResponse();
  }
  if (!stringOrNull(value.job_title_role, 64)) {
    return throwInvalidResponse();
  }
  if (!titleLevelsAreValid(value.job_title_levels)) {
    return throwInvalidResponse();
  }
  if (!stringOrNull(value.location_country, 128)) {
    return throwInvalidResponse();
  }
  if (!stringOrNull(value.linkedin_url, 2048)) {
    return throwInvalidResponse();
  }
  if (
    value.job_title_role !== null &&
    !(
      TAXONOMY_PATTERN.test(value.job_title_role) &&
      PDL_JOB_ROLES.has(value.job_title_role)
    )
  ) {
    return throwInvalidResponse();
  }
  return {
    full_name: value.full_name,
    id: value.id,
    job_company_name: value.job_company_name,
    job_company_website: value.job_company_website,
    job_title: value.job_title,
    job_title_levels: value.job_title_levels,
    job_title_role: value.job_title_role,
    linkedin_url: value.linkedin_url,
    location_country: value.location_country,
  };
};

const reduceSearchResponse = (
  value: unknown,
  maximumRows: number
): PdlSearchResponse => {
  if (!plainRecord(value)) {
    return throwInvalidResponse();
  }
  if (
    !hasRequiredAllowedKeys(value, WRAPPER_REQUIRED_KEYS, WRAPPER_ALLOWED_KEYS)
  ) {
    return throwInvalidResponse();
  }
  if (value.status !== 200) {
    return throwInvalidResponse();
  }
  if (
    typeof value.total !== "number" ||
    !Number.isSafeInteger(value.total) ||
    value.total < 0
  ) {
    return throwInvalidResponse();
  }
  if (
    !(
      value.scroll_token === undefined ||
      value.scroll_token === null ||
      boundedTrimmedText(value.scroll_token, 512)
    )
  ) {
    return throwInvalidResponse();
  }
  if (!Array.isArray(value.data)) {
    return throwInvalidResponse();
  }
  if (value.data.length > maximumRows) {
    return throwInvalidResponse();
  }
  const profiles = value.data.map(reduceProfile);
  if (new Set(profiles.map(({ id }) => id)).size !== profiles.length) {
    return throwInvalidResponse();
  }
  return {
    data: profiles,
    ...(value.scroll_token === undefined
      ? {}
      : { scroll_token: value.scroll_token }),
    status: 200,
    total: value.total,
  };
};

const readSearchResponse = async (
  response: Response,
  signal: AbortSignal,
  maximumRows: number
): Promise<PdlSearchResponse> => {
  try {
    return reduceSearchResponse(
      await responseJson(response, signal),
      maximumRows
    );
  } catch (error) {
    if (error instanceof PdlContactProviderError) {
      throw error;
    }
    return throwInvalidResponse();
  }
};

const responseStatusError = (status: number): PdlContactProviderError => {
  if (status === 401) {
    return new PdlContactProviderError(
      "authentication-failed",
      "PDL rejected contact search authentication."
    );
  }
  if (status === 403) {
    return new PdlContactProviderError(
      "authorization-failed",
      "PDL rejected contact search authorization."
    );
  }
  if (status === 429) {
    return new PdlContactProviderError(
      "rate-limited",
      "PDL rate-limited contact search."
    );
  }
  if (status >= 500) {
    return new PdlContactProviderError(
      "provider-unavailable",
      "PDL contact search is unavailable."
    );
  }
  return new PdlContactProviderError(
    "provider-rejected",
    "PDL rejected contact search."
  );
};

const profileUrl = (value: string | null): string | null => {
  if (value === null) {
    return null;
  }
  const candidate = value.startsWith("https://") ? value : `https://${value}`;
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return throwInvalidResponse();
  }
  if (
    url.protocol !== "https:" ||
    !(url.hostname === "linkedin.com" || url.hostname === "www.linkedin.com") ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    url.port.length > 0 ||
    url.search.length > 0 ||
    url.hash.length > 0 ||
    !LINKEDIN_PROFILE_PATH_PATTERN.test(url.pathname)
  ) {
    return throwInvalidResponse();
  }
  return `https://www.linkedin.com${url.pathname.replace(
    TRAILING_SLASH_PATTERN,
    ""
  )}`;
};

const profileSeniority = (
  values: readonly string[] | null
): ContactSeniority | null => {
  if (values === null || values.length === 0) {
    return null;
  }
  const [first] = values;
  return first === undefined ? null : PDL_LEVEL_TO_SENIORITY[first];
};

const profileCountryCode = (value: string | null): string | null =>
  value === null ? null : (COUNTRY_CODE_BY_NAME.get(value) ?? null);

const createInternalCandidate = (
  profile: PdlProfile,
  company: DatasetRecord,
  expectedDomain: string,
  contactIdValue: string,
  now: number
): InternalContactCandidate => {
  const organizationDomain = normalizeDomain(profile.job_company_website);
  if (organizationDomain !== expectedDomain) {
    return throwInvalidResponse();
  }
  let contactId: RecordId;
  let observedAt: Instant;
  try {
    contactId = recordId(contactIdValue);
    observedAt = instant(now);
  } catch {
    return throwInvalidResponse();
  }
  const candidate = createContactCandidate({
    contactId,
    department: profile.job_title_role,
    displayName: profile.full_name,
    identityCompleteness: "full",
    jobTitle: profile.job_title,
    observedAt,
    organizationDomain,
    organizationId: String(company.recordId),
    organizationName: profile.job_company_name,
    personCountryCode: profileCountryCode(profile.location_country),
    profileUrl: profileUrl(profile.linkedin_url),
    seniority: profileSeniority(profile.job_title_levels),
  });
  const providerIdentity = createContactProviderIdentity({
    providerKey: PROVIDER_KEY,
    providerSubjectId: profile.id,
  });
  if (!(candidate.ok && providerIdentity.ok)) {
    return throwInvalidResponse();
  }
  return {
    candidate: candidate.value,
    providerIdentity: providerIdentity.value,
  };
};

const emptyPage = (): ContactDiscoveryPage => ({
  candidates: [],
  hasMore: false,
  nextCursor: null,
  outcomes: [],
  usage: { amount: 0, basis: "exact", unit: "records" },
});

const executeCompanySearch = async (
  input: Readonly<{
    apiKey: string;
    domain: string;
    fetchImplementation: PdlFetch;
    filters: NormalizedSearchFilters;
    size: number;
    timeoutMs: number;
  }>
): Promise<PdlSearchResponse> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), input.timeoutMs);
  try {
    let response: Response;
    try {
      response = await input.fetchImplementation(ENDPOINT, {
        body: JSON.stringify({
          data_include: PDL_CONTACT_DATA_INCLUDE_PARAMETER,
          dataset: "resume",
          query: buildQuery(input.domain, input.filters),
          size: input.size,
        }),
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          "x-api-key": input.apiKey,
        },
        method: "POST",
        redirect: "error",
        signal: controller.signal,
      });
    } catch {
      throw new PdlContactProviderError(
        "transport-outcome-unknown",
        "The PDL contact search outcome is unknown."
      );
    }
    if (response.status !== 200) {
      throw responseStatusError(response.status);
    }
    return await readSearchResponse(response, controller.signal, input.size);
  } finally {
    clearTimeout(timer);
  }
};

const materializeCandidates = (
  profiles: readonly PdlProfile[],
  company: DatasetRecord,
  domain: string,
  nextOpaqueCandidateIdentity: () => Readonly<{
    contactId: string;
    observedAt: number;
  }>
): readonly InternalContactCandidate[] => {
  const candidates: InternalContactCandidate[] = [];
  for (const profile of profiles) {
    const opaqueIdentity = nextOpaqueCandidateIdentity();
    candidates.push(
      createInternalCandidate(
        profile,
        company,
        domain,
        opaqueIdentity.contactId,
        opaqueIdentity.observedAt
      )
    );
  }
  return candidates;
};

/**
 * BYOK PDL Person Search adapter. Construction does not prove data rights and
 * does not admit the provider to an execution route; both remain composition-
 * root responsibilities. The adapter never retries an ambiguous transport.
 */
export const createPdlContactDiscoveryProvider = (
  options: PdlContactProviderOptions
): ContactDiscoveryProviderPort => {
  if (
    !apiKeyIsValid(options.apiKey) ||
    (options.timeoutMs !== undefined &&
      (!Number.isSafeInteger(options.timeoutMs) ||
        options.timeoutMs < 1 ||
        options.timeoutMs > 60_000))
  ) {
    throw new PdlProviderConfigurationError();
  }
  const fetchImplementation = options.fetch ?? globalThis.fetch;
  const nextContactId =
    options.nextContactId ?? (() => `contact_${randomUUID()}`);
  const now = options.now ?? Date.now;
  const timeoutMs = options.timeoutMs ?? EXECUTE_TIMEOUT_MS;
  const nextOpaqueCandidateIdentity = (): Readonly<{
    contactId: string;
    observedAt: number;
  }> => {
    try {
      return { contactId: nextContactId(), observedAt: now() };
    } catch {
      return throwInvalidResponse();
    }
  };

  return {
    discoverPage: async (request) => {
      validateRequest(request);
      const companyCountryNames = supportedCountryCodes(
        request.companyHeadquartersCountryCodes
      ).map((code) => COUNTRY_NAMES[code]);
      const personCountryNames = supportedCountryCodes(
        request.personCountryCodes
      ).map((code) => COUNTRY_NAMES[code]);
      const departments = normalizedDepartments(request.departments);
      const seniorities = normalizedSeniorities(request.seniorities);
      const titles = normalizedTitles(request.titles);
      const filters: NormalizedSearchFilters = {
        companyCountryNames,
        departments,
        personCountryNames,
        seniorities,
        titles,
      };
      if (request.inputCursor !== null) {
        return emptyPage();
      }

      const candidates: InternalContactCandidate[] = [];
      const outcomes: ContactDiscoveryCompanyOutcome[] = [];
      let chargedRows = 0;
      for (const company of request.companyRecords) {
        const companyRecordId = companyRecordIdentifier(company);
        if (companyRecordId === undefined) {
          outcomes.push({
            companyRecordId: "unknown",
            reason: "company-identifier-missing",
            status: "skipped",
          });
          continue;
        }
        if (chargedRows >= request.maxContactsTotal) {
          outcomes.push({
            companyRecordId,
            reason: "company-out-of-scope",
            status: "skipped",
          });
          continue;
        }
        const domain = companyDomain(company);
        if (domain === undefined) {
          outcomes.push({
            companyRecordId,
            reason: "company-domain-missing",
            status: "skipped",
          });
          continue;
        }
        const size = Math.min(
          request.maxContactsPerCompany,
          request.maxContactsTotal - chargedRows
        );
        const reduced = await executeCompanySearch({
          apiKey: options.apiKey,
          domain,
          fetchImplementation,
          filters,
          size,
          timeoutMs,
        });
        if (reduced.data.length === 0) {
          outcomes.push({
            companyRecordId,
            reason: "provider-no-result",
            status: "no_result",
          });
          continue;
        }
        chargedRows += reduced.data.length;
        const accepted = materializeCandidates(
          reduced.data,
          company,
          domain,
          nextOpaqueCandidateIdentity
        );
        candidates.push(...accepted);
        outcomes.push({
          acceptedCount: accepted.length,
          companyRecordId,
          status: "succeeded",
        });
      }
      return {
        candidates,
        hasMore: false,
        nextCursor: null,
        outcomes,
        usage: { amount: chargedRows, basis: "exact", unit: "records" },
      };
    },
  };
};
