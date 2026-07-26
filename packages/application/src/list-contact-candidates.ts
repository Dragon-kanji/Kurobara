import {
  type ContactCandidate,
  createContactCandidate,
  type DatasetGenerationId,
  type DomainResult,
  fail,
  instant,
} from "@kurobara/kernel";
import type {
  ContactDatasetExportAuthorization,
  ContactDatasetExportPrivacySourcePort,
  ContactPrivacyGuardPort,
  DatasetGenerationPersistencePort,
  DatasetRecordPageEntry,
  DatasetRecordPageQueryPort,
  VerifiedApiKey,
} from "@kurobara/ports";

import {
  type GeneratedCandidateProjection,
  generatedRecordValues,
  type ReadyGenerationCandidatePageFailureCode,
  type ReadyGenerationCandidatePageSuccess,
  readReadyGenerationCandidatePage,
} from "./ready-generation-candidate-page.ts";

const CONTACT_FIELDS = Object.freeze({
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

const nullableString = (value: unknown): value is null | string =>
  value === null || typeof value === "string";

const contactSeniority = (
  value: unknown
): value is ContactCandidate["seniority"] =>
  value === null ||
  value === "owner" ||
  value === "c_suite" ||
  value === "vp" ||
  value === "director" ||
  value === "manager" ||
  value === "senior" ||
  value === "individual_contributor";

const identityCompleteness = (
  value: unknown
): value is ContactCandidate["identityCompleteness"] =>
  value === "full" || value === "obfuscated";

const candidateFromRecord = (
  entry: DatasetRecordPageEntry,
  fields: ReadonlyMap<string, string>
): ContactCandidate | undefined => {
  const values = generatedRecordValues(entry, fields);
  if (values === undefined) {
    return;
  }
  const department = values.get("department");
  const displayName = values.get("display_name");
  const completeness = values.get("identity_completeness");
  const jobTitle = values.get("job_title");
  const observedAt = values.get("observed_at_ms");
  const organizationDomain = values.get("organization_domain");
  const organizationId = values.get("organization_id");
  const organizationName = values.get("organization_name");
  const personCountryCode = values.get("person_country_code");
  const profileUrl = values.get("profile_url");
  const seniority = values.get("seniority");
  if (
    !nullableString(department) ||
    typeof displayName !== "string" ||
    !identityCompleteness(completeness) ||
    typeof jobTitle !== "string" ||
    typeof observedAt !== "number" ||
    !Number.isSafeInteger(observedAt) ||
    observedAt < 0 ||
    typeof organizationDomain !== "string" ||
    typeof organizationId !== "string" ||
    typeof organizationName !== "string" ||
    !nullableString(personCountryCode) ||
    !nullableString(profileUrl) ||
    !contactSeniority(seniority)
  ) {
    return;
  }
  const candidate = createContactCandidate({
    contactId: entry.record.recordId,
    department,
    displayName,
    identityCompleteness: completeness,
    jobTitle,
    observedAt: instant(observedAt),
    organizationDomain,
    organizationId,
    organizationName,
    personCountryCode,
    profileUrl,
    seniority,
  });
  return candidate.ok ? candidate.value : undefined;
};

const contactCandidateProjection: GeneratedCandidateProjection<ContactCandidate> =
  {
    capabilityId: "contacts.discover",
    capabilityVersion: "1.0.0",
    fields: CONTACT_FIELDS,
    label: "Contact",
    project: candidateFromRecord,
  };

export type ListContactCandidatesRequest = Readonly<{
  actor: VerifiedApiKey;
  afterOrdinal: number;
  generationId: DatasetGenerationId;
  limit: number;
}>;

export type ListContactCandidatesSuccess =
  ReadyGenerationCandidatePageSuccess<ContactCandidate>;

export type ListContactCandidatesFailureCode =
  | ReadyGenerationCandidatePageFailureCode
  | "contact-privacy-check-failed"
  | "contact-privacy-restricted"
  | "permission-missing";

export type ListContactCandidatesFailure = Readonly<{
  code: ListContactCandidatesFailureCode;
  message: string;
}>;

export type ListContactCandidatesResult = DomainResult<
  ListContactCandidatesSuccess,
  ListContactCandidatesFailure
>;

export type ListContactCandidatesDependencies = Readonly<{
  generations: DatasetGenerationPersistencePort;
  privacy: Readonly<{
    guard: ContactPrivacyGuardPort;
    subjects: ContactDatasetExportPrivacySourcePort;
  }>;
  records: DatasetRecordPageQueryPort;
  requiredPermission?: string;
}>;

export const makeListContactCandidates = (
  dependencies: ListContactCandidatesDependencies
) => {
  const requiredPermission = dependencies.requiredPermission ?? "datasets:read";
  return async (
    request: ListContactCandidatesRequest
  ): Promise<ListContactCandidatesResult> => {
    if (!request.actor.permissions.includes(requiredPermission)) {
      return fail({
        code: "permission-missing",
        message: `Contact candidate reads require ${requiredPermission}.`,
      });
    }
    const result = await readReadyGenerationCandidatePage(
      dependencies,
      {
        afterOrdinal: request.afterOrdinal,
        generationId: request.generationId,
        limit: request.limit,
        workspaceId: request.actor.workspaceId,
      },
      contactCandidateProjection
    );
    if (!result.ok || result.value.items.length === 0) {
      return result;
    }

    const scope = { workspaceId: request.actor.workspaceId } as const;
    let authorization: ContactDatasetExportAuthorization | undefined;
    try {
      authorization = await dependencies.privacy.subjects.loadAuthorization(
        scope,
        result.value.generation.datasetId
      );
    } catch {
      return fail({
        code: "contact-privacy-check-failed",
        message: "Contact privacy lineage could not be verified.",
      });
    }
    if (authorization === undefined) {
      return fail({
        code: "contact-privacy-check-failed",
        message: "Contact privacy lineage is unavailable.",
      });
    }

    const authorizationByRecordId = new Map(
      authorization.records.map((record) => [record.recordId, record] as const)
    );
    const pageAuthorizations = result.value.items.map(({ candidate }) =>
      authorizationByRecordId.get(candidate.contactId)
    );
    if (
      authorizationByRecordId.size !== authorization.records.length ||
      pageAuthorizations.some(
        (record) => record === undefined || record.subjects.length === 0
      )
    ) {
      return fail({
        code: "contact-privacy-check-failed",
        message: "Contact privacy lineage does not cover the requested page.",
      });
    }

    let allowed: boolean;
    try {
      allowed = await dependencies.privacy.guard.allows(
        scope,
        pageAuthorizations.flatMap((record) => record?.subjects ?? [])
      );
    } catch {
      return fail({
        code: "contact-privacy-check-failed",
        message: "Contact privacy restrictions could not be verified.",
      });
    }
    return allowed
      ? result
      : fail({
          code: "contact-privacy-restricted",
          message: "Contact privacy restrictions block this result page.",
        });
  };
};
