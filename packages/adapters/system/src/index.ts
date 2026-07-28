import { randomUUID } from "node:crypto";

import {
  type CapabilityRef,
  capabilityId,
  contentHash,
  type DatasetGenerationQueryValue,
  datasetGenerationId,
  datasetGenerationPlanId,
  eventId,
  instant,
  outboxMessageId,
  runId,
  runPlanId,
} from "@kurobara/kernel";
import type {
  CapabilityCatalogPort,
  CapabilityRoute,
  CapabilityRouteCatalogPort,
  ClockPort,
  DatasetGenerationIdentifierPort,
  DatasetGenerationPlanningIdentifierPort,
  DatasetGenerationQueryNormalizerPort,
  IdentifierPort,
  PlanningIdentifierPort,
} from "@kurobara/ports";

const ORGANIZATIONS_DISCOVER = Object.freeze({
  capabilityId: capabilityId("organizations.discover"),
  capabilityVersion: "1.0.0",
}) satisfies CapabilityRef;

export const organizationDiscoveryCapability = ORGANIZATIONS_DISCOVER;

const ORGANIZATION_DISCOVERY_QUERY_SCHEMA_ID =
  "https://schemas.kurobara.invalid/schemas/organizations/discovery-query/1.0.0";
const CONTACT_DISCOVERY_EXECUTION_QUERY_SCHEMA_ID =
  "https://schemas.kurobara.invalid/schemas/contacts/discovery-execution-query/1.0.0";

const CONTACTS_DISCOVER = Object.freeze({
  capabilityId: capabilityId("contacts.discover"),
  capabilityVersion: "1.0.0",
}) satisfies CapabilityRef;

export const contactDiscoveryCapability = CONTACTS_DISCOVER;

const CONTACTS_IDENTITY_REVEAL = Object.freeze({
  capabilityId: capabilityId("contacts.identity.reveal"),
  capabilityVersion: "1.0.0",
}) satisfies CapabilityRef;

export const contactIdentityRevealCapability = CONTACTS_IDENTITY_REVEAL;

const CONTACT_IDENTITY_EXECUTION_QUERY_SCHEMA_ID =
  "https://schemas.kurobara.invalid/schemas/contacts/identity-execution-query/1.0.0";

const CONTACTS_WORK_EMAIL_RESOLVE = Object.freeze({
  capabilityId: capabilityId("contacts.work-email.resolve"),
  capabilityVersion: "1.0.0",
}) satisfies CapabilityRef;

export const contactWorkEmailResolveCapability = CONTACTS_WORK_EMAIL_RESOLVE;

const CONTACTS_WORK_EMAIL_VERIFY = Object.freeze({
  capabilityId: capabilityId("contacts.work-email.verify"),
  capabilityVersion: "1.0.0",
}) satisfies CapabilityRef;

export const contactWorkEmailVerifyCapability = CONTACTS_WORK_EMAIL_VERIFY;

const CONTACT_WORK_EMAIL_EXECUTION_QUERY_SCHEMA_ID =
  "https://schemas.kurobara.invalid/schemas/contacts/work-email-execution-query/1.0.0";

/**
 * ISO 3166-1 alpha-2 assigned country codes. The closed snapshot is local so
 * query normalization remains deterministic and performs no network or locale
 * lookup.
 */
const ISO_3166_ALPHA_2 = new Set(
  "AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW".split(
    " "
  )
);

const INDUSTRY_CODE_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/u;
const NON_WHITESPACE_PATTERN = /\S/u;
const QUERY_REQUIRED_KEYS = Object.freeze([
  "country_codes",
  "country_scope",
  "industry_codes",
  "industry_taxonomy",
  "result_kind",
] as const);
const QUERY_OPTIONAL_KEYS = Object.freeze(["employee_count", "keywords"]);
const HEADCOUNT_BUCKETS = Object.freeze([
  { maximum: 10, minimum: 1 },
  { maximum: 50, minimum: 11 },
  { maximum: 200, minimum: 51 },
  { maximum: 500, minimum: 201 },
  { maximum: 1000, minimum: 501 },
  { maximum: 5000, minimum: 1001 },
  { maximum: 10_000, minimum: 5001 },
  { maximum: 1_000_000_000, minimum: 10_001 },
] as const);

type JsonRecord = Record<string, unknown>;

const isPlainRecord = (value: unknown): value is JsonRecord =>
  value !== null &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  (Object.getPrototypeOf(value) === Object.prototype ||
    Object.getPrototypeOf(value) === null);

const hasExactQueryKeys = (value: JsonRecord): boolean => {
  const allowed = new Set<string>([
    ...QUERY_REQUIRED_KEYS,
    ...QUERY_OPTIONAL_KEYS,
  ]);
  return (
    QUERY_REQUIRED_KEYS.every((key) => Object.hasOwn(value, key)) &&
    Object.keys(value).every((key) => allowed.has(key))
  );
};

const isUniqueStringList = (
  value: unknown,
  maximumCount: number,
  maximumLength: number,
  predicate: (entry: string) => boolean
): value is readonly string[] =>
  Array.isArray(value) &&
  value.length > 0 &&
  value.length <= maximumCount &&
  value.every(
    (entry) =>
      typeof entry === "string" &&
      entry.length > 0 &&
      entry.length <= maximumLength &&
      predicate(entry)
  ) &&
  new Set(value).size === value.length;

const isExactHeadcountRange = (value: unknown): boolean => {
  if (value === undefined) {
    return true;
  }
  if (
    !isPlainRecord(value) ||
    Object.keys(value).length !== 2 ||
    !Object.hasOwn(value, "minimum") ||
    !Object.hasOwn(value, "maximum") ||
    !Number.isSafeInteger(value.minimum) ||
    !Number.isSafeInteger(value.maximum)
  ) {
    return false;
  }
  const minimum = value.minimum as number;
  const maximum = value.maximum as number;
  const first = HEADCOUNT_BUCKETS.findIndex(
    (bucket) => bucket.minimum === minimum
  );
  const last = HEADCOUNT_BUCKETS.findIndex(
    (bucket) => bucket.maximum === maximum
  );
  return first >= 0 && last >= first;
};

const normalizeOrganizationDiscoveryQuery = (
  value: unknown
): DatasetGenerationQueryValue | undefined => {
  if (
    !(isPlainRecord(value) && hasExactQueryKeys(value)) ||
    value.country_scope !== "headquarters" ||
    value.industry_taxonomy !== "kurobara-v1" ||
    value.result_kind !== "company" ||
    !isUniqueStringList(value.country_codes, 1, 2, (country) =>
      ISO_3166_ALPHA_2.has(country)
    ) ||
    !isUniqueStringList(value.industry_codes, 64, 128, (industry) =>
      INDUSTRY_CODE_PATTERN.test(industry)
    ) ||
    (value.keywords !== undefined &&
      !isUniqueStringList(value.keywords, 32, 128, (keyword) =>
        NON_WHITESPACE_PATTERN.test(keyword)
      )) ||
    !isExactHeadcountRange(value.employee_count)
  ) {
    return;
  }
  return Object.freeze({
    country_codes: Object.freeze([...value.country_codes].sort()),
    country_scope: "headquarters",
    ...(value.employee_count === undefined
      ? {}
      : { employee_count: Object.freeze({ ...value.employee_count }) }),
    industry_codes: Object.freeze([...value.industry_codes].sort()),
    industry_taxonomy: "kurobara-v1",
    ...(value.keywords === undefined
      ? {}
      : { keywords: Object.freeze([...value.keywords].sort()) }),
    result_kind: "company",
  }) as DatasetGenerationQueryValue;
};

export type CompanyDiscoveryQueryNormalizerOptions = Readonly<{
  contract: Readonly<{
    catalogFingerprint: string;
    catalogVersion: string;
    schemaFingerprint: string;
    schemaId: string;
    schemaVersion: string;
  }>;
}>;

export const createCompanyDiscoveryQueryNormalizer = ({
  contract,
}: CompanyDiscoveryQueryNormalizerOptions): DatasetGenerationQueryNormalizerPort => {
  if (
    contract.catalogVersion.trim().length === 0 ||
    contract.schemaId !== ORGANIZATION_DISCOVERY_QUERY_SCHEMA_ID ||
    contract.schemaVersion !== "1.0.0"
  ) {
    throw new TypeError(
      "The company discovery normalizer requires the exact canonical query contract."
    );
  }
  const exactContract = Object.freeze({
    ...contract,
    catalogFingerprint: contentHash(contract.catalogFingerprint),
    schemaFingerprint: contentHash(contract.schemaFingerprint),
  });
  return {
    normalize: ({ capability, query }) => {
      if (
        capability.capabilityId !== ORGANIZATIONS_DISCOVER.capabilityId ||
        capability.capabilityVersion !==
          ORGANIZATIONS_DISCOVER.capabilityVersion
      ) {
        return {
          reason: "The query normalizer does not support this capability.",
          status: "rejected",
        };
      }
      const normalized = normalizeOrganizationDiscoveryQuery(query);
      return normalized === undefined
        ? {
            reason:
              "The organization discovery query contains an invalid country, industry code, headcount range, or field.",
            status: "rejected",
          }
        : {
            capability: ORGANIZATIONS_DISCOVER,
            contract: exactContract,
            normalizerVersion: "kurobara-v1-organization-2",
            status: "accepted",
            value: normalized,
          };
    },
  };
};

const CONTACT_QUERY_KEYS = Object.freeze([
  "company_headquarters_country_codes",
  "departments",
  "organization_source",
  "organizations",
  "person_country_codes",
  "result_kind",
  "seniorities",
  "titles",
] as const);
const CONTACT_SENIORITIES = new Set([
  "owner",
  "c_suite",
  "vp",
  "director",
  "manager",
  "senior",
  "individual_contributor",
]);
const CONTACT_TAXONOMY_PATTERN = /^[a-z][a-z0-9._-]{0,127}$/u;
const DOMAIN_LABEL_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;
const CONTENT_HASH_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const FIELD_KEY_PATTERN = /^[a-z][a-z0-9_]{0,127}$/u;

type ContactOrganizationSnapshot = Readonly<{
  company_id: string;
  country_code: string;
  domain: null | string;
  name: string;
}>;

const exactKeys = (value: JsonRecord, expected: readonly string[]): boolean => {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return (
    actual.length === sortedExpected.length &&
    actual.every((key, index) => key === sortedExpected[index])
  );
};

const boundedText = (
  value: unknown,
  maximum: number,
  allowEmpty = false
): value is string =>
  typeof value === "string" &&
  value.length <= maximum &&
  (allowEmpty || value.trim().length > 0) &&
  value.trim() === value;

const domainIsValid = (value: string): boolean => {
  if (
    value.length > 253 ||
    value.endsWith(".") ||
    value.includes(":") ||
    value.includes("/") ||
    value.includes("@")
  ) {
    return false;
  }
  const labels = value.split(".");
  return (
    labels.length >= 2 &&
    labels.every((label) => DOMAIN_LABEL_PATTERN.test(label))
  );
};

const contactOrganizationSnapshot = (
  value: unknown
): ContactOrganizationSnapshot | undefined => {
  if (
    !(
      isPlainRecord(value) &&
      exactKeys(value, ["company_id", "country_code", "domain", "name"]) &&
      boundedText(value.company_id, 255)
    ) ||
    typeof value.country_code !== "string" ||
    !ISO_3166_ALPHA_2.has(value.country_code) ||
    !boundedText(value.name, 255) ||
    !(
      value.domain === null ||
      (typeof value.domain === "string" && domainIsValid(value.domain))
    )
  ) {
    return;
  }
  return Object.freeze({
    company_id: value.company_id,
    country_code: value.country_code,
    domain: value.domain,
    name: value.name,
  });
};

const contactOrganizationSource = (
  value: unknown
): DatasetGenerationQueryValue | undefined => {
  if (!isPlainRecord(value)) {
    return;
  }
  if (
    value.kind === "generation" &&
    exactKeys(value, ["generation_id", "kind"]) &&
    boundedText(value.generation_id, 255)
  ) {
    return Object.freeze({
      generation_id: value.generation_id,
      kind: "generation",
    });
  }
  const allowedKeys = new Set([
    "accepted",
    "content_hash",
    "dataset_id",
    "default_country_code",
    "duplicates",
    "field_mapping",
    "inspected",
    "kind",
    "materialization_id",
    "rejected",
    "source_record_count",
    "truncated",
  ]);
  if (
    value.kind !== "dataset" ||
    Object.keys(value).some((key) => !allowedKeys.has(key)) ||
    ![
      "accepted",
      "content_hash",
      "dataset_id",
      "duplicates",
      "field_mapping",
      "inspected",
      "kind",
      "materialization_id",
      "rejected",
      "source_record_count",
      "truncated",
    ].every((key) => Object.hasOwn(value, key)) ||
    !boundedText(value.dataset_id, 255) ||
    !boundedText(value.materialization_id, 255) ||
    typeof value.content_hash !== "string" ||
    !CONTENT_HASH_PATTERN.test(value.content_hash) ||
    !Number.isSafeInteger(value.accepted) ||
    !Number.isSafeInteger(value.duplicates) ||
    !Number.isSafeInteger(value.inspected) ||
    !Number.isSafeInteger(value.rejected) ||
    !Number.isSafeInteger(value.source_record_count) ||
    (value.accepted as number) < 1 ||
    (value.accepted as number) > 10 ||
    (value.duplicates as number) < 0 ||
    (value.inspected as number) < (value.accepted as number) ||
    (value.inspected as number) > 1000 ||
    (value.rejected as number) < 0 ||
    (value.source_record_count as number) < (value.inspected as number) ||
    typeof value.truncated !== "boolean" ||
    !isPlainRecord(value.field_mapping)
  ) {
    return;
  }
  const fieldMapping = value.field_mapping;
  const mappingKeys = new Set(["country_code", "domain", "name"]);
  if (
    Object.keys(fieldMapping).some((key) => !mappingKeys.has(key)) ||
    !boundedText(fieldMapping.domain, 128) ||
    !FIELD_KEY_PATTERN.test(fieldMapping.domain) ||
    (fieldMapping.country_code !== undefined &&
      !(
        boundedText(fieldMapping.country_code, 128) &&
        FIELD_KEY_PATTERN.test(fieldMapping.country_code)
      )) ||
    (fieldMapping.name !== undefined &&
      !(
        boundedText(fieldMapping.name, 128) &&
        FIELD_KEY_PATTERN.test(fieldMapping.name)
      )) ||
    (value.default_country_code !== undefined &&
      (typeof value.default_country_code !== "string" ||
        !ISO_3166_ALPHA_2.has(value.default_country_code))) ||
    (fieldMapping.country_code === undefined &&
      value.default_country_code === undefined)
  ) {
    return;
  }
  return Object.freeze({
    accepted: value.accepted as number,
    content_hash: value.content_hash,
    dataset_id: value.dataset_id,
    ...(value.default_country_code === undefined
      ? {}
      : { default_country_code: value.default_country_code }),
    duplicates: value.duplicates as number,
    field_mapping: Object.freeze({
      ...(fieldMapping.country_code === undefined
        ? {}
        : { country_code: fieldMapping.country_code }),
      domain: fieldMapping.domain,
      ...(fieldMapping.name === undefined ? {} : { name: fieldMapping.name }),
    }),
    inspected: value.inspected as number,
    kind: "dataset",
    materialization_id: value.materialization_id,
    rejected: value.rejected as number,
    source_record_count: value.source_record_count as number,
    truncated: value.truncated,
  });
};

const contactFilterList = (
  value: unknown,
  maximumCount: number,
  predicate: (entry: string) => boolean
): value is readonly string[] =>
  Array.isArray(value) &&
  value.length <= maximumCount &&
  value.every(
    (entry) =>
      typeof entry === "string" &&
      entry.length > 0 &&
      entry.length <= 128 &&
      entry.trim() === entry &&
      predicate(entry)
  ) &&
  new Set(value).size === value.length;

const normalizeContactDiscoveryExecutionQuery = (
  value: unknown
): DatasetGenerationQueryValue | undefined => {
  if (
    !(isPlainRecord(value) && exactKeys(value, CONTACT_QUERY_KEYS)) ||
    value.result_kind !== "contact" ||
    !contactFilterList(
      value.company_headquarters_country_codes,
      32,
      (country) => country.length === 2 && ISO_3166_ALPHA_2.has(country)
    ) ||
    !contactFilterList(value.departments, 32, (department) =>
      CONTACT_TAXONOMY_PATTERN.test(department)
    ) ||
    !contactFilterList(value.person_country_codes, 32, (country) =>
      ISO_3166_ALPHA_2.has(country)
    ) ||
    !contactFilterList(value.seniorities, 16, (seniority) =>
      CONTACT_SENIORITIES.has(seniority)
    ) ||
    !contactFilterList(value.titles, 32, (title) =>
      NON_WHITESPACE_PATTERN.test(title)
    ) ||
    !Array.isArray(value.organizations) ||
    value.organizations.length < 1 ||
    value.organizations.length > 10
  ) {
    return;
  }
  const organizationSource = contactOrganizationSource(
    value.organization_source
  );
  if (organizationSource === undefined) {
    return;
  }
  const organizations = value.organizations.map(contactOrganizationSnapshot);
  if (
    organizations.some((organization) => organization === undefined) ||
    new Set(organizations.map((organization) => organization?.company_id))
      .size !== organizations.length
  ) {
    return;
  }
  return Object.freeze({
    company_headquarters_country_codes: Object.freeze(
      [...value.company_headquarters_country_codes].sort()
    ),
    departments: Object.freeze([...value.departments].sort()),
    organization_source: organizationSource,
    organizations: Object.freeze(organizations),
    person_country_codes: Object.freeze([...value.person_country_codes].sort()),
    result_kind: "contact",
    seniorities: Object.freeze([...value.seniorities].sort()),
    titles: Object.freeze([...value.titles].sort()),
  }) as DatasetGenerationQueryValue;
};

export type ContactDiscoveryQueryNormalizerOptions = Readonly<{
  contract: Readonly<{
    catalogFingerprint: string;
    catalogVersion: string;
    schemaFingerprint: string;
    schemaId: string;
    schemaVersion: string;
  }>;
}>;

export const createContactDiscoveryQueryNormalizer = ({
  contract,
}: ContactDiscoveryQueryNormalizerOptions): DatasetGenerationQueryNormalizerPort => {
  if (
    contract.catalogVersion.trim().length === 0 ||
    contract.schemaId !== CONTACT_DISCOVERY_EXECUTION_QUERY_SCHEMA_ID ||
    contract.schemaVersion !== "1.0.0"
  ) {
    throw new TypeError(
      "The contact discovery normalizer requires the exact canonical execution-query contract."
    );
  }
  const exactContract = Object.freeze({
    ...contract,
    catalogFingerprint: contentHash(contract.catalogFingerprint),
    schemaFingerprint: contentHash(contract.schemaFingerprint),
  });
  return {
    normalize: ({ capability, query }) => {
      if (
        capability.capabilityId !== CONTACTS_DISCOVER.capabilityId ||
        capability.capabilityVersion !== CONTACTS_DISCOVER.capabilityVersion
      ) {
        return {
          reason: "The query normalizer does not support this capability.",
          status: "rejected",
        };
      }
      const normalized = normalizeContactDiscoveryExecutionQuery(query);
      return normalized === undefined
        ? {
            reason:
              "The contact discovery query or bounded organization snapshot is invalid.",
            status: "rejected",
          }
        : {
            capability: CONTACTS_DISCOVER,
            contract: exactContract,
            normalizerVersion: "kurobara-v1-contact-1",
            status: "accepted",
            value: normalized,
          };
    },
  };
};

const IDENTITY_QUERY_KEYS = Object.freeze([
  "result_kind",
  "selected_contacts",
  "source_dataset_id",
] as const);
const IDENTITY_SELECTED_CONTACT_KEYS = Object.freeze([
  "candidate",
  "provider_identity",
  "source_record_id",
] as const);
const IDENTITY_PROVIDER_KEYS = Object.freeze([
  "provider_key",
  "provider_subject_id",
] as const);
const CONTACT_PROVIDER_IDENTITY_NAMESPACES = new Set([
  "apollo-people-search",
  "prospeo-person-search",
]);
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

const nullableBoundedText = (
  value: unknown,
  maximum: number
): value is null | string => value === null || boundedText(value, maximum);

const identityCandidateIsValid = (value: unknown): value is JsonRecord =>
  isPlainRecord(value) &&
  exactKeys(value, IDENTITY_CANDIDATE_KEYS) &&
  nullableBoundedText(value.department, 128) &&
  boundedText(value.display_name, 255) &&
  value.identity_completeness === "obfuscated" &&
  boundedText(value.job_title, 255) &&
  Number.isSafeInteger(value.observed_at_ms) &&
  Number(value.observed_at_ms) >= 0 &&
  typeof value.organization_domain === "string" &&
  domainIsValid(value.organization_domain) &&
  boundedText(value.organization_id, 255) &&
  boundedText(value.organization_name, 255) &&
  nullableBoundedText(value.person_country_code, 2) &&
  (value.person_country_code === null ||
    ISO_3166_ALPHA_2.has(value.person_country_code)) &&
  nullableBoundedText(value.profile_url, 2048) &&
  (value.seniority === null ||
    (typeof value.seniority === "string" &&
      CONTACT_SENIORITIES.has(value.seniority)));

const identitySelectedContactIsValid = (value: unknown): value is JsonRecord =>
  isPlainRecord(value) &&
  exactKeys(value, IDENTITY_SELECTED_CONTACT_KEYS) &&
  boundedText(value.source_record_id, 255) &&
  identityCandidateIsValid(value.candidate) &&
  isPlainRecord(value.provider_identity) &&
  exactKeys(value.provider_identity, IDENTITY_PROVIDER_KEYS) &&
  typeof value.provider_identity.provider_key === "string" &&
  CONTACT_PROVIDER_IDENTITY_NAMESPACES.has(
    value.provider_identity.provider_key
  ) &&
  boundedText(value.provider_identity.provider_subject_id, 512);

const normalizeContactIdentityExecutionQuery = (
  value: unknown
): DatasetGenerationQueryValue | undefined => {
  if (
    !(isPlainRecord(value) && exactKeys(value, IDENTITY_QUERY_KEYS)) ||
    value.result_kind !== "contact_identity" ||
    !boundedText(value.source_dataset_id, 255) ||
    !Array.isArray(value.selected_contacts) ||
    value.selected_contacts.length < 1 ||
    value.selected_contacts.length > 3 ||
    !value.selected_contacts.every(identitySelectedContactIsValid) ||
    new Set(
      value.selected_contacts.map(
        (entry) =>
          (entry.provider_identity as JsonRecord).provider_key as string
      )
    ).size !== 1 ||
    new Set(
      value.selected_contacts.map((entry) => entry.source_record_id as string)
    ).size !== value.selected_contacts.length
  ) {
    return;
  }
  return Object.freeze({
    result_kind: "contact_identity",
    selected_contacts: Object.freeze(
      structuredClone(value.selected_contacts) as DatasetGenerationQueryValue[]
    ),
    source_dataset_id: value.source_dataset_id,
  }) as DatasetGenerationQueryValue;
};

export type ContactIdentityQueryNormalizerOptions = Readonly<{
  contract: Readonly<{
    catalogFingerprint: string;
    catalogVersion: string;
    schemaFingerprint: string;
    schemaId: string;
    schemaVersion: string;
  }>;
}>;

export const createContactIdentityQueryNormalizer = ({
  contract,
}: ContactIdentityQueryNormalizerOptions): DatasetGenerationQueryNormalizerPort => {
  if (
    contract.catalogVersion.trim().length === 0 ||
    contract.schemaId !== CONTACT_IDENTITY_EXECUTION_QUERY_SCHEMA_ID ||
    contract.schemaVersion !== "1.0.0"
  ) {
    throw new TypeError(
      "The contact identity normalizer requires the exact canonical execution-query contract."
    );
  }
  const exactContract = Object.freeze({
    ...contract,
    catalogFingerprint: contentHash(contract.catalogFingerprint),
    schemaFingerprint: contentHash(contract.schemaFingerprint),
  });
  return {
    normalize: ({ capability, query }) => {
      if (
        capability.capabilityId !== CONTACTS_IDENTITY_REVEAL.capabilityId ||
        capability.capabilityVersion !==
          CONTACTS_IDENTITY_REVEAL.capabilityVersion
      ) {
        return {
          reason: "The query normalizer does not support this capability.",
          status: "rejected",
        };
      }
      const normalized = normalizeContactIdentityExecutionQuery(query);
      return normalized === undefined
        ? {
            reason:
              "The selected contact identity query is invalid or outside the V1 bounds.",
            status: "rejected",
          }
        : {
            capability: CONTACTS_IDENTITY_REVEAL,
            contract: exactContract,
            normalizerVersion: "kurobara-v1-contact-identity-1",
            status: "accepted",
            value: normalized,
          };
    },
  };
};

const WORK_EMAIL_QUERY_KEYS = Object.freeze([
  "operation_kind",
  "result_kind",
  "selected_contacts",
  "source_dataset_id",
] as const);
const WORK_EMAIL_RESOLVE_CONTACT_KEYS = Object.freeze([
  "candidate",
  "identity",
  "provider_identity",
  "source_record_id",
] as const);
const WORK_EMAIL_VERIFY_CONTACT_KEYS = Object.freeze([
  ...WORK_EMAIL_RESOLVE_CONTACT_KEYS,
  "work_email",
] as const);
const WORK_EMAIL_IDENTITY_KEYS = Object.freeze([
  "display_name",
  "first_name",
  "last_name",
  "observed_at_ms",
  "profile_url",
] as const);
const WORK_EMAIL_KEYS = Object.freeze([
  "confidence",
  "email",
  "observed_at_ms",
  "source",
  "verification",
] as const);
const WORK_EMAIL_PATTERN = /^[^\s@]+@[^\s@]+$/u;

const workEmailCandidateIsValid = (value: unknown): value is JsonRecord =>
  isPlainRecord(value) &&
  exactKeys(value, IDENTITY_CANDIDATE_KEYS) &&
  nullableBoundedText(value.department, 128) &&
  boundedText(value.display_name, 255) &&
  value.identity_completeness === "full" &&
  boundedText(value.job_title, 255) &&
  Number.isSafeInteger(value.observed_at_ms) &&
  Number(value.observed_at_ms) >= 0 &&
  typeof value.organization_domain === "string" &&
  domainIsValid(value.organization_domain) &&
  boundedText(value.organization_id, 255) &&
  boundedText(value.organization_name, 255) &&
  nullableBoundedText(value.person_country_code, 2) &&
  (value.person_country_code === null ||
    ISO_3166_ALPHA_2.has(value.person_country_code)) &&
  nullableBoundedText(value.profile_url, 2048) &&
  (value.profile_url === null || value.profile_url.startsWith("https://")) &&
  (value.seniority === null ||
    (typeof value.seniority === "string" &&
      CONTACT_SENIORITIES.has(value.seniority)));

const workEmailIdentityIsValid = (value: unknown): value is JsonRecord =>
  isPlainRecord(value) &&
  exactKeys(value, WORK_EMAIL_IDENTITY_KEYS) &&
  boundedText(value.display_name, 255) &&
  boundedText(value.first_name, 128) &&
  boundedText(value.last_name, 128) &&
  value.display_name === `${value.first_name} ${value.last_name}` &&
  Number.isSafeInteger(value.observed_at_ms) &&
  Number(value.observed_at_ms) >= 0 &&
  nullableBoundedText(value.profile_url, 2048) &&
  (value.profile_url === null || value.profile_url.startsWith("https://"));

const workEmailEvidenceIsValid = (value: unknown): value is JsonRecord =>
  isPlainRecord(value) &&
  exactKeys(value, WORK_EMAIL_KEYS) &&
  (value.confidence === null ||
    (typeof value.confidence === "number" &&
      Number.isFinite(value.confidence) &&
      value.confidence >= 0 &&
      value.confidence <= 1)) &&
  boundedText(value.email, 320) &&
  WORK_EMAIL_PATTERN.test(value.email) &&
  Number.isSafeInteger(value.observed_at_ms) &&
  Number(value.observed_at_ms) >= 0 &&
  value.source === "provider_unspecified" &&
  (value.verification === "valid" ||
    value.verification === "accept_all" ||
    value.verification === "invalid" ||
    value.verification === "unknown");

const workEmailSelectedContactIsValid = (
  value: unknown,
  operationKind: "resolve" | "verify"
): value is JsonRecord =>
  isPlainRecord(value) &&
  exactKeys(
    value,
    operationKind === "resolve"
      ? WORK_EMAIL_RESOLVE_CONTACT_KEYS
      : WORK_EMAIL_VERIFY_CONTACT_KEYS
  ) &&
  boundedText(value.source_record_id, 255) &&
  workEmailCandidateIsValid(value.candidate) &&
  workEmailIdentityIsValid(value.identity) &&
  value.candidate.display_name === value.identity.display_name &&
  value.candidate.profile_url === value.identity.profile_url &&
  isPlainRecord(value.provider_identity) &&
  exactKeys(value.provider_identity, IDENTITY_PROVIDER_KEYS) &&
  typeof value.provider_identity.provider_key === "string" &&
  CONTACT_PROVIDER_IDENTITY_NAMESPACES.has(
    value.provider_identity.provider_key
  ) &&
  boundedText(value.provider_identity.provider_subject_id, 512) &&
  (operationKind === "resolve" || workEmailEvidenceIsValid(value.work_email));

const normalizeContactWorkEmailExecutionQuery = (
  value: unknown
): DatasetGenerationQueryValue | undefined => {
  if (
    !(isPlainRecord(value) && exactKeys(value, WORK_EMAIL_QUERY_KEYS)) ||
    value.result_kind !== "contact_work_email" ||
    (value.operation_kind !== "resolve" && value.operation_kind !== "verify") ||
    !boundedText(value.source_dataset_id, 255) ||
    !Array.isArray(value.selected_contacts) ||
    value.selected_contacts.length < 1 ||
    value.selected_contacts.length > 3 ||
    !value.selected_contacts.every((entry) =>
      workEmailSelectedContactIsValid(
        entry,
        value.operation_kind as "resolve" | "verify"
      )
    ) ||
    new Set(
      value.selected_contacts.map(
        (entry) =>
          (entry.provider_identity as JsonRecord).provider_key as string
      )
    ).size !== 1 ||
    new Set(
      value.selected_contacts.map((entry) => entry.source_record_id as string)
    ).size !== value.selected_contacts.length ||
    new Set(
      value.selected_contacts.map(
        (entry) =>
          (entry.provider_identity as JsonRecord).provider_subject_id as string
      )
    ).size !== value.selected_contacts.length
  ) {
    return;
  }
  return Object.freeze({
    operation_kind: value.operation_kind,
    result_kind: "contact_work_email",
    selected_contacts: Object.freeze(
      structuredClone(value.selected_contacts) as DatasetGenerationQueryValue[]
    ),
    source_dataset_id: value.source_dataset_id,
  }) as DatasetGenerationQueryValue;
};

export type ContactWorkEmailQueryNormalizerOptions = Readonly<{
  contract: Readonly<{
    catalogFingerprint: string;
    catalogVersion: string;
    schemaFingerprint: string;
    schemaId: string;
    schemaVersion: string;
  }>;
}>;

export const createContactWorkEmailQueryNormalizer = ({
  contract,
}: ContactWorkEmailQueryNormalizerOptions): DatasetGenerationQueryNormalizerPort => {
  if (
    contract.catalogVersion.trim().length === 0 ||
    contract.schemaId !== CONTACT_WORK_EMAIL_EXECUTION_QUERY_SCHEMA_ID ||
    contract.schemaVersion !== "1.0.0"
  ) {
    throw new TypeError(
      "The contact work-email normalizer requires the exact canonical execution-query contract."
    );
  }
  const exactContract = Object.freeze({
    ...contract,
    catalogFingerprint: contentHash(contract.catalogFingerprint),
    schemaFingerprint: contentHash(contract.schemaFingerprint),
  });
  return {
    normalize: ({ capability, query }) => {
      const operationKind =
        isPlainRecord(query) &&
        (query.operation_kind === "resolve" ||
          query.operation_kind === "verify")
          ? query.operation_kind
          : undefined;
      const normalized = normalizeContactWorkEmailExecutionQuery(query);
      let expectedCapability:
        | typeof CONTACTS_WORK_EMAIL_RESOLVE
        | typeof CONTACTS_WORK_EMAIL_VERIFY
        | undefined;
      if (operationKind === "resolve") {
        expectedCapability = CONTACTS_WORK_EMAIL_RESOLVE;
      } else if (operationKind === "verify") {
        expectedCapability = CONTACTS_WORK_EMAIL_VERIFY;
      }
      if (
        normalized === undefined ||
        expectedCapability === undefined ||
        capability.capabilityId !== expectedCapability.capabilityId ||
        capability.capabilityVersion !== expectedCapability.capabilityVersion
      ) {
        return {
          reason:
            "The selected contact work-email query does not match the requested capability.",
          status: "rejected",
        };
      }
      return {
        capability: expectedCapability,
        contract: exactContract,
        normalizerVersion: "kurobara-v1-contact-work-email-1",
        status: "accepted",
        value: normalized,
      };
    },
  };
};

export type DatasetGenerationQueryNormalizerRoute = Readonly<{
  capability: CapabilityRef;
  normalizer: DatasetGenerationQueryNormalizerPort;
}>;

/** Routes locally to one exact capability normalizer without widening queries. */
export const createDatasetGenerationQueryNormalizerRouter = (
  routes: readonly DatasetGenerationQueryNormalizerRoute[]
): DatasetGenerationQueryNormalizerPort => {
  const byCapability = new Map<string, DatasetGenerationQueryNormalizerPort>();
  for (const route of routes) {
    const key = `${route.capability.capabilityId}@${route.capability.capabilityVersion}`;
    if (byCapability.has(key)) {
      throw new TypeError(
        "Dataset generation normalizer routes must be unique."
      );
    }
    byCapability.set(key, route.normalizer);
  }
  return {
    normalize: (input) => {
      const key = `${input.capability.capabilityId}@${input.capability.capabilityVersion}`;
      const normalizer = byCapability.get(key);
      return (
        normalizer?.normalize(input) ?? {
          reason: "No query normalizer supports this capability.",
          status: "rejected",
        }
      );
    },
  };
};

export const createStaticCapabilityCatalog = (
  capabilities: readonly CapabilityRef[] = []
): CapabilityCatalogPort => {
  const snapshot = Object.freeze(
    capabilities.map((capability) => Object.freeze({ ...capability }))
  );
  return {
    listAvailable: async () => snapshot,
  };
};

export const createStaticCapabilityRouteCatalog = (
  routes: readonly CapabilityRoute[] = []
): CapabilityRouteCatalogPort => {
  const snapshot = Object.freeze(
    routes.map((route) =>
      Object.freeze({
        ...route,
        capability: Object.freeze({ ...route.capability }),
      })
    )
  );
  return {
    listAvailable: () => snapshot,
  };
};

export const createStaticExecutionCatalog = (
  routes: readonly CapabilityRoute[] = []
): Readonly<{
  capabilities: CapabilityCatalogPort;
  routes: CapabilityRouteCatalogPort;
}> => {
  const capabilities = new Map<string, CapabilityRef>();
  for (const route of routes) {
    const key = `${route.capability.capabilityId}\u0000${route.capability.capabilityVersion}`;
    if (!capabilities.has(key)) {
      capabilities.set(key, route.capability);
    }
  }
  return Object.freeze({
    capabilities: createStaticCapabilityCatalog([...capabilities.values()]),
    routes: createStaticCapabilityRouteCatalog(routes),
  });
};

export const createSystemClock = (): ClockPort => ({
  now: async () => instant(Date.now()),
});

export const createRandomIdentifiers = (): IdentifierPort => ({
  nextEventId: async () => eventId(`evt_${randomUUID()}`),
  nextOutboxMessageId: async () => outboxMessageId(`out_${randomUUID()}`),
  nextRunId: async () => runId(`run_${randomUUID()}`),
});

export const createRandomPlanningIdentifiers = (): PlanningIdentifierPort => ({
  nextQuoteId: async () => `quote_${randomUUID()}`,
  nextRunPlanId: async () => runPlanId(`plan_${randomUUID()}`),
});

export const createRandomDatasetGenerationIdentifiers =
  (): DatasetGenerationIdentifierPort &
    DatasetGenerationPlanningIdentifierPort => ({
    nextDatasetGenerationId: async () =>
      datasetGenerationId(`generation_${randomUUID()}`),
    nextDatasetGenerationPlanId: async () =>
      datasetGenerationPlanId(`generation_plan_${randomUUID()}`),
  });
