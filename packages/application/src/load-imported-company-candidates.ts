import { isIP } from "node:net";
import { domainToASCII } from "node:url";

import {
  type ContentHash,
  type DatasetMaterialization,
  type Record as DatasetRecord,
  type DomainResult,
  datasetId,
  type Field,
  fail,
  succeed,
  type WorkspaceId,
} from "@kurobara/kernel";
import type { DatasetPersistencePort, StoredDataset } from "@kurobara/ports";

export const MAX_IMPORTED_COMPANY_RECORDS_INSPECTED = 1000;

export type OrganizationDatasetFieldMapping = Readonly<{
  countryCode?: string;
  domain: string;
  name?: string;
}>;

export type OrganizationDatasetSource = Readonly<{
  datasetId: string;
  defaultCountryCode?: string;
  fieldMapping: OrganizationDatasetFieldMapping;
  kind: "dataset";
}>;

export type OrganizationGenerationSource = Readonly<{
  generationId: string;
  kind: "generation";
}>;

export type OrganizationSource =
  | OrganizationDatasetSource
  | OrganizationGenerationSource;

export type OrganizationSnapshotCandidate = Readonly<{
  company_id: string;
  country_code: string;
  domain: string;
  name: string;
}>;

export type OrganizationSourceLineage =
  | OrganizationGenerationSource
  | Readonly<{
      accepted: number;
      contentHash: string;
      datasetId: string;
      defaultCountryCode?: string;
      duplicates: number;
      fieldMapping: OrganizationDatasetFieldMapping;
      inspected: number;
      kind: "dataset";
      materializationId: string;
      rejected: number;
      sourceRecordCount: number;
      truncated: boolean;
    }>;

export type LoadImportedCompanyCandidatesRequest = Readonly<{
  limit: number;
  source: OrganizationDatasetSource;
  workspaceId: WorkspaceId;
}>;

export type LoadImportedCompanyCandidatesSuccess = Readonly<{
  lineage: Extract<OrganizationSourceLineage, Readonly<{ kind: "dataset" }>>;
  organizations: readonly OrganizationSnapshotCandidate[];
}>;

export type LoadImportedCompanyCandidatesFailure = Readonly<{
  code:
    | "organization-dataset-empty"
    | "organization-dataset-field-invalid"
    | "organization-dataset-invalid"
    | "organization-dataset-unavailable";
  message: string;
}>;

export type LoadImportedCompanyCandidatesResult = DomainResult<
  LoadImportedCompanyCandidatesSuccess,
  LoadImportedCompanyCandidatesFailure
>;

export type LoadImportedCompanyCandidatesDependencies = Readonly<{
  datasets: DatasetPersistencePort;
}>;

const COUNTRY_CODE_PATTERN = /^[A-Z]{2}$/u;
const FIELD_KEY_PATTERN = /^[a-z][a-z0-9_]{0,127}$/u;
const HOST_LABEL_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u;
const LEADING_DOUBLE_SLASH_PATTERN = /^\/\//u;
const TRAILING_DOTS_PATTERN = /\.+$/u;
const URL_SCHEME_PATTERN = /^[a-z][a-z0-9+.-]*:\/\//iu;

const normalizedFieldKey = (value: string | undefined): string | undefined => {
  if (value === undefined || !FIELD_KEY_PATTERN.test(value)) {
    return;
  }
  return value;
};

const normalizedCountryCode = (
  value: unknown,
  fallback: string | undefined
): string | undefined => {
  const candidate =
    typeof value === "string" && value.trim().length > 0
      ? value.trim().toUpperCase()
      : fallback;
  return candidate !== undefined && COUNTRY_CODE_PATTERN.test(candidate)
    ? candidate
    : undefined;
};

/**
 * Canonicalizes a hostname or HTTP(S) URL without network access.
 * Subdomains are preserved; credentials, IPs and local/single-label hosts are
 * rejected so imported data cannot silently change identity semantics.
 */
export const normalizeOrganizationDomain = (
  value: unknown
): string | undefined => {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.length > 2048
  ) {
    return;
  }
  const input = value.trim();
  let parsed: URL;
  try {
    parsed = new URL(
      URL_SCHEME_PATTERN.test(input)
        ? input
        : `https://${input.replace(LEADING_DOUBLE_SLASH_PATTERN, "")}`
    );
  } catch {
    return;
  }
  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
    parsed.username.length > 0 ||
    parsed.password.length > 0
  ) {
    return;
  }
  const withoutTrailingDot = parsed.hostname
    .toLowerCase()
    .replace(TRAILING_DOTS_PATTERN, "");
  const ascii = domainToASCII(withoutTrailingDot);
  if (
    ascii.length === 0 ||
    ascii.length > 253 ||
    isIP(ascii) !== 0 ||
    !ascii.includes(".")
  ) {
    return;
  }
  const labels = ascii.split(".");
  if (
    labels.some(
      (label) =>
        label.length === 0 ||
        label.length > 63 ||
        !HOST_LABEL_PATTERN.test(label)
    )
  ) {
    return;
  }
  return ascii;
};

const recordValuesByFieldId = (
  record: DatasetRecord
): ReadonlyMap<string, unknown> =>
  new Map(record.values.map(({ fieldId, value }) => [fieldId, value]));

const boundedName = (value: unknown, domain: string): string => {
  if (typeof value !== "string") {
    return domain;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= 255 ? trimmed : domain;
};

type ResolvedSource = Readonly<{
  countryKey?: string;
  defaultCountryCode?: string;
  domainKey: string;
  mapping: OrganizationDatasetFieldMapping;
  nameKey?: string;
}>;

type ReadyImportedDataset = StoredDataset &
  Readonly<{
    materialization: DatasetMaterialization &
      Readonly<{
        contentHash: ContentHash;
        origin: Readonly<{ importId: string; kind: "import" }>;
      }>;
  }>;

type ResolvedFields = Readonly<{
  countryField?: Field;
  domainField: Field;
  nameField?: Field;
}>;

type ImportedProjection = Readonly<{
  duplicates: number;
  inspected: number;
  organizations: readonly OrganizationSnapshotCandidate[];
  rejected: number;
}>;

const resolveSource = (
  request: LoadImportedCompanyCandidatesRequest
): ResolvedSource | undefined => {
  const mapping = request.source.fieldMapping;
  const domainKey = normalizedFieldKey(mapping.domain);
  const nameKey = normalizedFieldKey(mapping.name);
  const countryKey = normalizedFieldKey(mapping.countryCode);
  const defaultCountryCode = normalizedCountryCode(
    request.source.defaultCountryCode,
    undefined
  );
  const invalid =
    !Number.isSafeInteger(request.limit) ||
    request.limit < 1 ||
    request.limit > 10 ||
    domainKey === undefined ||
    (mapping.name !== undefined && nameKey === undefined) ||
    (mapping.countryCode !== undefined && countryKey === undefined) ||
    (countryKey === undefined && defaultCountryCode === undefined) ||
    (request.source.defaultCountryCode !== undefined &&
      defaultCountryCode === undefined);
  if (invalid) {
    return;
  }
  return {
    ...(countryKey === undefined ? {} : { countryKey }),
    ...(defaultCountryCode === undefined ? {} : { defaultCountryCode }),
    domainKey,
    mapping,
    ...(nameKey === undefined ? {} : { nameKey }),
  };
};

const isReadyImportedDataset = (
  stored: StoredDataset | undefined
): stored is ReadyImportedDataset =>
  stored !== undefined &&
  stored.materialization.state === "ready" &&
  stored.materialization.origin.kind === "import" &&
  stored.materialization.contentHash !== undefined &&
  stored.materialization.coverage?.basis === "imported_source";

const resolveFields = (
  stored: ReadyImportedDataset,
  source: ResolvedSource
): ResolvedFields | undefined => {
  const fieldsByKey = new Map(
    stored.fields.map((field) => [field.key, field] as const)
  );
  const domainField = fieldsByKey.get(source.domainKey);
  const nameField =
    source.nameKey === undefined ? undefined : fieldsByKey.get(source.nameKey);
  const countryField =
    source.countryKey === undefined
      ? undefined
      : fieldsByKey.get(source.countryKey);
  if (
    domainField?.valueType !== "string" ||
    (source.nameKey !== undefined && nameField?.valueType !== "string") ||
    (source.countryKey !== undefined && countryField?.valueType !== "string")
  ) {
    return;
  }
  return {
    ...(countryField === undefined ? {} : { countryField }),
    domainField,
    ...(nameField === undefined ? {} : { nameField }),
  };
};

const projectImportedRecords = async (
  dependencies: LoadImportedCompanyCandidatesDependencies,
  request: LoadImportedCompanyCandidatesRequest,
  stored: ReadyImportedDataset,
  source: ResolvedSource,
  fields: ResolvedFields
): Promise<ImportedProjection> => {
  const organizations: OrganizationSnapshotCandidate[] = [];
  const seenDomains = new Set<string>();
  let duplicates = 0;
  let inspected = 0;
  let rejected = 0;
  const inspectionLimit = Math.min(
    MAX_IMPORTED_COMPANY_RECORDS_INSPECTED,
    request.limit * 10,
    stored.materialization.recordCount
  );
  for await (const record of dependencies.datasets.streamRecords(
    { workspaceId: request.workspaceId },
    stored.dataset.datasetId
  )) {
    if (inspected >= inspectionLimit || organizations.length >= request.limit) {
      break;
    }
    inspected += 1;
    const values = recordValuesByFieldId(record);
    const domain = normalizeOrganizationDomain(
      values.get(fields.domainField.fieldId)
    );
    const countryCode = normalizedCountryCode(
      fields.countryField === undefined
        ? undefined
        : values.get(fields.countryField.fieldId),
      source.defaultCountryCode
    );
    if (domain === undefined || countryCode === undefined) {
      rejected += 1;
    } else if (seenDomains.has(domain)) {
      duplicates += 1;
    } else {
      seenDomains.add(domain);
      organizations.push({
        company_id: record.recordId,
        country_code: countryCode,
        domain,
        name: boundedName(
          fields.nameField === undefined
            ? undefined
            : values.get(fields.nameField.fieldId),
          domain
        ),
      });
    }
  }
  return { duplicates, inspected, organizations, rejected };
};

export const makeLoadImportedCompanyCandidates =
  (dependencies: LoadImportedCompanyCandidatesDependencies) =>
  async (
    request: LoadImportedCompanyCandidatesRequest
  ): Promise<LoadImportedCompanyCandidatesResult> => {
    const source = resolveSource(request);
    if (source === undefined) {
      return fail({
        code: "organization-dataset-invalid",
        message:
          "The organization dataset source or its bounded field mapping is invalid.",
      });
    }

    const stored = await dependencies.datasets.getDataset(
      { workspaceId: request.workspaceId },
      datasetId(request.source.datasetId)
    );
    if (!isReadyImportedDataset(stored)) {
      return fail({
        code: "organization-dataset-unavailable",
        message:
          "The organization dataset must be a completed, content-addressed import.",
      });
    }

    const fields = resolveFields(stored, source);
    if (fields === undefined) {
      return fail({
        code: "organization-dataset-field-invalid",
        message:
          "Every mapped organization field must exist in the dataset as a string field.",
      });
    }

    const projection = await projectImportedRecords(
      dependencies,
      request,
      stored,
      source,
      fields
    );
    if (projection.organizations.length === 0) {
      return fail({
        code: "organization-dataset-empty",
        message:
          "No valid organization candidate was found within the bounded dataset inspection.",
      });
    }

    return succeed({
      lineage: {
        accepted: projection.organizations.length,
        contentHash: stored.materialization.contentHash,
        datasetId: stored.dataset.datasetId,
        ...(source.defaultCountryCode === undefined
          ? {}
          : { defaultCountryCode: source.defaultCountryCode }),
        duplicates: projection.duplicates,
        fieldMapping: source.mapping,
        inspected: projection.inspected,
        kind: "dataset",
        materializationId: stored.materialization.materializationId,
        rejected: projection.rejected,
        sourceRecordCount: stored.materialization.recordCount,
        truncated: projection.inspected < stored.materialization.recordCount,
      },
      organizations: projection.organizations,
    });
  };
