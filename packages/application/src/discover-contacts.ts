import {
  type DatasetGenerationCreation,
  type DatasetGenerationPage,
  type DatasetGenerationPlan,
  type DomainResult,
  datasetGenerationId,
  fail,
  succeed,
} from "@kurobara/kernel";

import type {
  AuthorizeDatasetGenerationPageRequest,
  AuthorizeDatasetGenerationPageResult,
} from "./authorize-first-dataset-generation-page.ts";
import type {
  CreateDatasetGenerationRequest,
  CreateDatasetGenerationResult,
} from "./create-dataset-generation.ts";
import type {
  LoadImportedCompanyCandidatesRequest,
  LoadImportedCompanyCandidatesResult,
  OrganizationSnapshotCandidate,
  OrganizationSource,
  OrganizationSourceLineage,
} from "./load-imported-company-candidates.ts";
import type {
  LoadReadyCompanyCandidatesRequest,
  LoadReadyCompanyCandidatesResult,
} from "./load-ready-company-candidates.ts";
import type {
  PlanDatasetGenerationRequest,
  PlanDatasetGenerationResult,
} from "./plan-dataset-generation.ts";

export type DiscoverContactsRequest = Readonly<{
  execution: Omit<AuthorizeDatasetGenerationPageRequest, "generationId">;
  mode: "dry_run" | "start";
  organizationSource: OrganizationSource;
  planning: PlanDatasetGenerationRequest;
}>;

export type DiscoverContactsSuccess =
  | Readonly<{
      mode: "dry_run";
      organizationSource: OrganizationSourceLineage;
      plan: DatasetGenerationPlan;
      replayed: boolean;
      status: "planned";
    }>
  | Readonly<{
      creation: DatasetGenerationCreation;
      mode: "start";
      organizationSource: OrganizationSourceLineage;
      page?: DatasetGenerationPage;
      plan: DatasetGenerationPlan;
      replayed: boolean;
      status: "ready" | "running";
    }>;

export type DiscoverContactsFailure = Readonly<{
  code: string;
  message: string;
  stage: "authorization" | "creation" | "parent" | "planning" | "privacy";
}>;

export type DiscoverContactsResult = DomainResult<
  DiscoverContactsSuccess,
  DiscoverContactsFailure
>;

export type DiscoverContactsDependencies = Readonly<{
  authorizePage: (
    request: AuthorizeDatasetGenerationPageRequest
  ) => Promise<AuthorizeDatasetGenerationPageResult>;
  authorizePrivacy: (
    request: DiscoverContactsRequest
  ) => Promise<
    DomainResult<
      Readonly<{ allowed: true }>,
      Readonly<{ code: string; message: string }>
    >
  >;
  createGeneration: (
    request: CreateDatasetGenerationRequest
  ) => Promise<CreateDatasetGenerationResult>;
  loadOrganizations: (
    request: LoadReadyCompanyCandidatesRequest
  ) => Promise<LoadReadyCompanyCandidatesResult>;
  loadImportedOrganizations: (
    request: LoadImportedCompanyCandidatesRequest
  ) => Promise<LoadImportedCompanyCandidatesResult>;
  planGeneration: (
    request: PlanDatasetGenerationRequest
  ) => Promise<PlanDatasetGenerationResult>;
}>;

type OrganizationSnapshotExpectation = "absent" | "required";

const COUNTRY_CODE_PATTERN = /^[A-Z]{2}$/u;
const DOMAIN_PATTERN = /^[A-Za-z0-9.-]+$/u;
const ORGANIZATION_SNAPSHOT_KEYS = new Set([
  "company_id",
  "country_code",
  "domain",
  "name",
]);

type PreparedDiscoverContactsRequest = DiscoverContactsRequest &
  Readonly<{ organizationSourceLineage: OrganizationSourceLineage }>;

const boundedNonEmptyString = (value: unknown, maximum: number): boolean =>
  typeof value === "string" &&
  value.trim().length > 0 &&
  value.length <= maximum;

const organizationSnapshotIsBounded = (
  value: import("@kurobara/kernel").DatasetGenerationQueryValue | undefined,
  maxCompanies: number
): boolean =>
  Array.isArray(value) &&
  value.length >= 1 &&
  value.length <= maxCompanies &&
  value.every((candidate) => {
    if (
      typeof candidate !== "object" ||
      candidate === null ||
      Array.isArray(candidate)
    ) {
      return false;
    }
    const keys = Object.keys(candidate);
    if (
      keys.length !== ORGANIZATION_SNAPSHOT_KEYS.size ||
      keys.some((key) => !ORGANIZATION_SNAPSHOT_KEYS.has(key))
    ) {
      return false;
    }
    const domain = candidate.domain;
    return (
      boundedNonEmptyString(candidate.company_id, 255) &&
      typeof candidate.country_code === "string" &&
      COUNTRY_CODE_PATTERN.test(candidate.country_code) &&
      (domain === null ||
        (boundedNonEmptyString(domain, 253) &&
          typeof domain === "string" &&
          DOMAIN_PATTERN.test(domain))) &&
      boundedNonEmptyString(candidate.name, 255)
    );
  });

const organizationSourceQuery = (
  source: OrganizationSource | OrganizationSourceLineage
): import("@kurobara/kernel").DatasetGenerationQueryValue => {
  if (source.kind === "generation") {
    return {
      generation_id: source.generationId,
      kind: "generation",
    };
  }
  const lineage: Readonly<
    Record<string, import("@kurobara/kernel").DatasetGenerationQueryValue>
  > =
    "contentHash" in source
      ? {
          accepted: source.accepted,
          content_hash: source.contentHash,
          duplicates: source.duplicates,
          inspected: source.inspected,
          materialization_id: source.materializationId,
          rejected: source.rejected,
          source_record_count: source.sourceRecordCount,
          truncated: source.truncated,
        }
      : {};
  return {
    dataset_id: source.datasetId,
    ...(source.defaultCountryCode === undefined
      ? {}
      : { default_country_code: source.defaultCountryCode }),
    field_mapping: {
      ...(source.fieldMapping.countryCode === undefined
        ? {}
        : { country_code: source.fieldMapping.countryCode }),
      domain: source.fieldMapping.domain,
      ...(source.fieldMapping.name === undefined
        ? {}
        : { name: source.fieldMapping.name }),
    },
    kind: "dataset",
    ...lineage,
  } as import("@kurobara/kernel").DatasetGenerationQueryValue;
};

const queryValuesEqual = (
  left: import("@kurobara/kernel").DatasetGenerationQueryValue,
  right: import("@kurobara/kernel").DatasetGenerationQueryValue
): boolean => JSON.stringify(left) === JSON.stringify(right);

const requestIsBounded = (
  request: DiscoverContactsRequest,
  organizationSnapshotExpectation: OrganizationSnapshotExpectation
): boolean => {
  const limits = request.planning.limits;
  const query = request.planning.query;
  const maxCompanies = limits.maxCompanies;
  const maxContactsPerCompany = limits.maxContactsPerCompany;
  const maxContactsTotal = limits.maxContactsTotal;
  if (
    maxCompanies === undefined ||
    maxContactsPerCompany === undefined ||
    maxContactsTotal === undefined ||
    typeof query !== "object" ||
    query === null ||
    Array.isArray(query)
  ) {
    return false;
  }
  const queryRecord = query as Readonly<{
    [key: string]: import("@kurobara/kernel").DatasetGenerationQueryValue;
  }>;
  const organizationSnapshotMatches =
    organizationSnapshotExpectation === "absent"
      ? !("organizations" in queryRecord)
      : organizationSnapshotIsBounded(queryRecord.organizations, maxCompanies);
  return (
    request.planning.capability.capabilityId === "contacts.discover" &&
    request.planning.capability.capabilityVersion === "1.0.0" &&
    maxCompanies >= 1 &&
    maxCompanies <= 10 &&
    maxContactsPerCompany >= 1 &&
    maxContactsPerCompany <= 2 &&
    maxContactsTotal >= 1 &&
    maxContactsTotal <= 12 &&
    maxContactsTotal <= maxCompanies * maxContactsPerCompany &&
    limits.maxEnrichments === 0 &&
    limits.maxPhones === 0 &&
    queryRecord.result_kind === "contact" &&
    queryRecord.organization_source !== undefined &&
    queryValuesEqual(
      queryRecord.organization_source,
      organizationSourceQuery(request.organizationSource)
    ) &&
    organizationSnapshotMatches &&
    !("email" in queryRecord) &&
    !("phone" in queryRecord)
  );
};

/**
 * Default OSS admission for a shortlist-only contact discovery. Provider
 * accounts remain BYOK, while Kurobara still enforces the explicit capability
 * permission and the zero-detail V1 bounds at its own application boundary.
 */
export const authorizePrivacySafeContactDiscovery = (
  request: DiscoverContactsRequest
): Promise<
  DomainResult<
    Readonly<{ allowed: true }>,
    Readonly<{ code: string; message: string }>
  >
> => {
  if (!request.execution.actorPermissions.includes("contacts:discover")) {
    return Promise.resolve(
      fail({
        code: "authority-permission-missing",
        message: "Contact discovery requires contacts:discover.",
      })
    );
  }
  if (!requestIsBounded(request, "required")) {
    return Promise.resolve(
      fail({
        code: "contact-request-invalid",
        message: "Contact discovery is outside the privacy-safe V1 bounds.",
      })
    );
  }
  return Promise.resolve(succeed({ allowed: true as const }));
};

const attachReadyOrganizationSnapshot = async (
  dependencies: DiscoverContactsDependencies,
  request: DiscoverContactsRequest
): Promise<
  DomainResult<PreparedDiscoverContactsRequest, DiscoverContactsFailure>
> => {
  const maxCompanies = request.planning.limits.maxCompanies;
  if (maxCompanies === undefined) {
    return fail({
      code: "contact-request-invalid",
      message: "Contact discovery requires an explicit company cap.",
      stage: "planning",
    });
  }
  let organizationSnapshot: readonly OrganizationSnapshotCandidate[];
  let organizationSourceLineage: OrganizationSourceLineage;
  if (request.organizationSource.kind === "dataset") {
    const imported = await dependencies.loadImportedOrganizations({
      limit: maxCompanies,
      source: request.organizationSource,
      workspaceId: request.planning.workspaceId,
    });
    if (!imported.ok) {
      return fail({
        code: imported.error.code,
        message: imported.error.message,
        stage: "parent",
      });
    }
    organizationSnapshot = imported.value.organizations;
    organizationSourceLineage = imported.value.lineage;
  } else {
    const organizations = await dependencies.loadOrganizations({
      afterOrdinal: 0,
      generationId: datasetGenerationId(
        request.organizationSource.generationId
      ),
      limit: maxCompanies,
      workspaceId: request.planning.workspaceId,
    });
    if (!organizations.ok) {
      return fail({
        code: "organization-generation-unavailable",
        message:
          "The organization generation is unavailable for contact discovery.",
        stage: "parent",
      });
    }
    if (organizations.value.items.length === 0) {
      return fail({
        code: "organization-generation-empty",
        message:
          "Contact discovery requires at least one ready organization candidate.",
        stage: "parent",
      });
    }
    organizationSnapshot = organizations.value.items.flatMap(({ candidate }) =>
      candidate.domain === null
        ? []
        : [
            {
              company_id: candidate.companyId,
              country_code: candidate.countryCode,
              domain: candidate.domain,
              name: candidate.name,
            },
          ]
    );
    if (organizationSnapshot.length === 0) {
      return fail({
        code: "organization-generation-empty",
        message:
          "Contact discovery requires at least one organization with a domain.",
        stage: "parent",
      });
    }
    organizationSourceLineage = request.organizationSource;
  }
  return succeed({
    ...request,
    organizationSourceLineage,
    planning: {
      ...request.planning,
      query: {
        ...(structuredClone(request.planning.query) as Readonly<{
          [key: string]: import("@kurobara/kernel").DatasetGenerationQueryValue;
        }>),
        organization_source: organizationSourceQuery(organizationSourceLineage),
        organizations: organizationSnapshot,
      },
    },
  });
};

/** Plans or starts only a privacy-admitted, explicitly bounded shortlist. */
export const makeDiscoverContacts =
  (dependencies: DiscoverContactsDependencies) =>
  async (request: DiscoverContactsRequest): Promise<DiscoverContactsResult> => {
    if (!requestIsBounded(request, "absent")) {
      return fail({
        code: "contact-request-invalid",
        message:
          "Contact discovery requires explicit organization lineage and V1 shortlist caps without contact-detail filters.",
        stage: "planning",
      });
    }
    const prepared = await attachReadyOrganizationSnapshot(
      dependencies,
      request
    );
    if (!prepared.ok) {
      return prepared;
    }
    const effectiveRequest = prepared.value;
    const privacy = await dependencies.authorizePrivacy(effectiveRequest);
    if (!privacy.ok) {
      return fail({ ...privacy.error, stage: "privacy" });
    }
    const planned = await dependencies.planGeneration(
      effectiveRequest.planning
    );
    if (!planned.ok) {
      return fail({ ...planned.error, stage: "planning" });
    }
    if (request.mode === "dry_run") {
      return succeed({
        mode: "dry_run",
        organizationSource: effectiveRequest.organizationSourceLineage,
        plan: planned.value.plan,
        replayed: planned.value.replayed,
        status: "planned",
      });
    }
    const created = await dependencies.createGeneration({
      generationPlanId: planned.value.plan.generationPlanId,
      workspaceId: request.planning.workspaceId,
    });
    if (!created.ok) {
      return fail({ ...created.error, stage: "creation" });
    }
    if (created.value.creation.generation.state === "completed") {
      return succeed({
        creation: created.value.creation,
        mode: "start",
        organizationSource: effectiveRequest.organizationSourceLineage,
        plan: planned.value.plan,
        replayed: true,
        status: "ready",
      });
    }
    if (
      created.value.creation.generation.state === "running" &&
      created.value.creation.generation.cost.reserved > 0
    ) {
      return succeed({
        creation: created.value.creation,
        mode: "start",
        organizationSource: effectiveRequest.organizationSourceLineage,
        plan: planned.value.plan,
        replayed: true,
        status: "running",
      });
    }
    const authorized = await dependencies.authorizePage({
      ...request.execution,
      generationId: created.value.creation.generation.generationId,
    });
    if (!authorized.ok) {
      return fail({ ...authorized.error, stage: "authorization" });
    }
    return succeed({
      creation: created.value.creation,
      mode: "start",
      organizationSource: effectiveRequest.organizationSourceLineage,
      page: authorized.value.page,
      plan: planned.value.plan,
      replayed:
        planned.value.replayed ||
        created.value.replayed ||
        authorized.value.replayed,
      status: "running",
    });
  };
