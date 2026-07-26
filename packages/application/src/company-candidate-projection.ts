import type { DatasetRecordPageEntry } from "@kurobara/ports";

import {
  type GeneratedCandidateProjection,
  generatedRecordValues,
} from "./ready-generation-candidate-page.ts";

const COUNTRY_CODE_PATTERN = /^[A-Z]{2}$/u;
const DOMAIN_PATTERN = /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/u;
const INDUSTRY_CODE_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/u;

const COMPANY_FIELDS = Object.freeze({
  country_code: "string",
  domain: "string",
  employee_count: "number",
  industry_code: "string",
  name: "string",
  observed_at_ms: "number",
} as const);

export type CompanyCandidate = Readonly<{
  companyId: string;
  countryCode: string;
  domain: null | string;
  employeeCount: null | number;
  industryCode: null | string;
  name: string;
  observedAtMs: number;
}>;

const nonEmptyBounded = (value: unknown, maximum: number): value is string =>
  typeof value === "string" &&
  value.trim().length > 0 &&
  value.length <= maximum;

const candidateFromRecord = (
  entry: DatasetRecordPageEntry,
  fields: ReadonlyMap<string, string>
): CompanyCandidate | undefined => {
  const values = generatedRecordValues(entry, fields);
  if (values === undefined) {
    return;
  }
  const name = values.get("name");
  const domain = values.get("domain");
  const countryCode = values.get("country_code");
  const industryCode = values.get("industry_code");
  const employeeCount = values.get("employee_count");
  const observedAtMs = values.get("observed_at_ms");
  if (
    !(
      nonEmptyBounded(name, 255) &&
      (domain === null ||
        (nonEmptyBounded(domain, 253) && DOMAIN_PATTERN.test(domain))) &&
      typeof countryCode === "string" &&
      COUNTRY_CODE_PATTERN.test(countryCode) &&
      (industryCode === null ||
        (typeof industryCode === "string" &&
          INDUSTRY_CODE_PATTERN.test(industryCode))) &&
      (employeeCount === null ||
        (typeof employeeCount === "number" &&
          Number.isSafeInteger(employeeCount) &&
          employeeCount >= 0 &&
          employeeCount <= 1_000_000_000)) &&
      typeof observedAtMs === "number" &&
      Number.isSafeInteger(observedAtMs) &&
      observedAtMs >= 0
    )
  ) {
    return;
  }
  return {
    companyId: entry.record.recordId,
    countryCode,
    domain,
    employeeCount,
    industryCode,
    name: name.trim(),
    observedAtMs,
  };
};

export const companyCandidateProjection: GeneratedCandidateProjection<CompanyCandidate> =
  {
    capabilityId: "organizations.discover",
    capabilityVersion: "1.0.0",
    fields: COMPANY_FIELDS,
    label: "Company",
    project: candidateFromRecord,
  };
