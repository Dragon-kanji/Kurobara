import {
  type DatasetGenerationCreation,
  type DatasetGenerationPage,
  type DatasetGenerationPlan,
  type DomainResult,
  datasetId,
  fail,
  fieldId,
  type IdempotencyKey,
  type Instant,
  succeed,
} from "@kurobara/kernel";
import type {
  ContactIdentitySourcePort,
  ContactPrivacyGuardPort,
  VerifiedApiKey,
} from "@kurobara/ports";

import type {
  AuthorizeDatasetGenerationPageRequest,
  AuthorizeDatasetGenerationPageResult,
} from "./authorize-first-dataset-generation-page.ts";
import { canonicalContentHash } from "./canonical-content-hash.ts";
import type {
  CreateDatasetGenerationRequest,
  CreateDatasetGenerationResult,
} from "./create-dataset-generation.ts";
import type {
  PlanDatasetGenerationRequest,
  PlanDatasetGenerationResult,
} from "./plan-dataset-generation.ts";

const IDENTITY_FIELDS = [
  ["department", "Department", "string"],
  ["display_name", "Display name", "string"],
  ["first_name", "First name", "string"],
  ["identity_completeness", "Identity completeness", "string"],
  ["identity_observed_at_ms", "Identity observed at", "number"],
  ["identity_status", "Identity status", "string"],
  ["job_title", "Current job title", "string"],
  ["last_name", "Last name", "string"],
  ["observed_at_ms", "Employment observed at", "number"],
  ["organization_domain", "Company domain", "string"],
  ["organization_id", "Company ID", "string"],
  ["organization_name", "Company name", "string"],
  ["person_country_code", "Person country", "string"],
  ["profile_url", "Professional profile", "string"],
  ["seniority", "Seniority", "string"],
] as const;

export type DeriveSelectedContactIdentitiesRequest = Readonly<{
  actor: VerifiedApiKey;
  authorityEnvelopeId: string;
  budget: Readonly<{ limit: number; unit: string }>;
  contactDatasetId: Parameters<ContactIdentitySourcePort["load"]>[1];
  contactRecordIds: readonly Parameters<ContactIdentitySourcePort["load"]>[2][];
  correlationId: AuthorizeDatasetGenerationPageRequest["correlationId"];
  deadline: Instant;
  operationId: IdempotencyKey;
}>;

export type DeriveSelectedContactIdentitiesSuccess = Readonly<{
  creation: DatasetGenerationCreation;
  page?: DatasetGenerationPage;
  plan: DatasetGenerationPlan;
  replayed: boolean;
  sourceContactDatasetId: DeriveSelectedContactIdentitiesRequest["contactDatasetId"];
  sourceContactRecordIds: DeriveSelectedContactIdentitiesRequest["contactRecordIds"];
  status: "ready" | "running";
}>;

export type DeriveSelectedContactIdentitiesFailure = Readonly<{
  code: string;
  message: string;
  stage: "authorization" | "creation" | "planning" | "privacy" | "selection";
}>;

export type DeriveSelectedContactIdentitiesResult = DomainResult<
  DeriveSelectedContactIdentitiesSuccess,
  DeriveSelectedContactIdentitiesFailure
>;

export type DeriveSelectedContactIdentitiesDependencies = Readonly<{
  authorizePage: (
    request: AuthorizeDatasetGenerationPageRequest
  ) => Promise<AuthorizeDatasetGenerationPageResult>;
  createGeneration: (
    request: CreateDatasetGenerationRequest
  ) => Promise<CreateDatasetGenerationResult>;
  planGeneration: (
    request: PlanDatasetGenerationRequest
  ) => Promise<PlanDatasetGenerationResult>;
  privacy: ContactPrivacyGuardPort;
  source: ContactIdentitySourcePort;
}>;

const targetDatasetId = (request: DeriveSelectedContactIdentitiesRequest) =>
  datasetId(
    `contact_identity_${canonicalContentHash({
      kind: "selected-contact-identity",
      operationId: request.operationId,
      workspaceId: request.actor.workspaceId,
    }).slice("sha256:".length, "sha256:".length + 40)}`
  );

const selectionIsBounded = (
  request: DeriveSelectedContactIdentitiesRequest
): boolean =>
  request.actor.permissions.includes("contacts:enrich") &&
  request.actor.permissions.includes("steps:execute") &&
  request.contactRecordIds.length >= 1 &&
  request.contactRecordIds.length <= 3 &&
  new Set(request.contactRecordIds).size === request.contactRecordIds.length;

const loadSelection = async (
  dependencies: DeriveSelectedContactIdentitiesDependencies,
  request: DeriveSelectedContactIdentitiesRequest
) => {
  const contacts = await Promise.all(
    request.contactRecordIds.map((recordId) =>
      dependencies.source.load(
        { workspaceId: request.actor.workspaceId },
        request.contactDatasetId,
        recordId
      )
    )
  );
  if (
    contacts.some(
      (contact, index) =>
        contact === undefined ||
        contact.candidate.contactId !== request.contactRecordIds[index] ||
        contact.candidate.identityCompleteness !== "obfuscated"
    )
  ) {
    return;
  }
  const loaded = contacts as readonly NonNullable<
    Awaited<ReturnType<ContactIdentitySourcePort["load"]>>
  >[];
  const namespaces = new Set(
    loaded.map((contact) => contact.providerIdentity.providerKey)
  );
  return namespaces.size === 1 ? loaded : undefined;
};

const planRequest = (
  request: DeriveSelectedContactIdentitiesRequest,
  contacts: NonNullable<Awaited<ReturnType<typeof loadSelection>>>
): PlanDatasetGenerationRequest => {
  const firstContact = contacts[0];
  if (firstContact === undefined) {
    throw new Error("Selected contact identity planning requires one contact.");
  }
  const resultDatasetId = targetDatasetId(request);
  const workspaceId = request.actor.workspaceId;
  const count = contacts.length;
  return {
    actorId: request.actor.actorId,
    authorityEnvelopeId: request.authorityEnvelopeId,
    capability: {
      capabilityId:
        "contacts.identity.reveal" as PlanDatasetGenerationRequest["capability"]["capabilityId"],
      capabilityVersion: "1.0.0",
    },
    fields: IDENTITY_FIELDS.map(([key, label, valueType]) => ({
      datasetId: resultDatasetId,
      fieldId: fieldId(`contact_identity_${key}`),
      key,
      label,
      valueType,
      workspaceId,
    })),
    idempotencyKey: request.operationId,
    limits: {
      maxCalls: count,
      maxCompanies: 0,
      maxContactsPerCompany: 0,
      maxContactsTotal: count,
      maxEnrichments: count,
      maxPages: count,
      maxPhones: 0,
      maxResults: count,
    },
    providerIdentityNamespace: firstContact.providerIdentity.providerKey,
    query: {
      result_kind: "contact_identity",
      selected_contacts: contacts.map(({ candidate, providerIdentity }) => ({
        candidate: {
          department: candidate.department,
          display_name: candidate.displayName,
          identity_completeness: candidate.identityCompleteness,
          job_title: candidate.jobTitle,
          observed_at_ms: candidate.observedAt,
          organization_domain: candidate.organizationDomain,
          organization_id: candidate.organizationId,
          organization_name: candidate.organizationName,
          person_country_code: candidate.personCountryCode,
          profile_url: candidate.profileUrl,
          seniority: candidate.seniority,
        },
        provider_identity: {
          provider_key: providerIdentity.providerKey,
          provider_subject_id: providerIdentity.providerSubjectId,
        },
        source_record_id: candidate.contactId,
      })),
      source_dataset_id: request.contactDatasetId,
    },
    requestedBudget: request.budget,
    requestedDeadline: request.deadline,
    targetDataset: {
      datasetId: resultDatasetId,
      name: "Selected contact identities",
      workspaceId,
    },
    unknownCostPolicy: { mode: "deny" },
    workspaceId,
  };
};

/** Starts one immutable, selected-only identity derivation. */
export const makeDeriveSelectedContactIdentities =
  (dependencies: DeriveSelectedContactIdentitiesDependencies) =>
  async (
    request: DeriveSelectedContactIdentitiesRequest
  ): Promise<DeriveSelectedContactIdentitiesResult> => {
    if (!selectionIsBounded(request)) {
      return fail({
        code: "contact-selection-invalid",
        message:
          "Identity reveal requires contacts:enrich, steps:execute, and one to three unique records.",
        stage: "selection",
      });
    }
    const contacts = await loadSelection(dependencies, request);
    if (contacts === undefined) {
      return fail({
        code: "contact-selection-invalid",
        message:
          "Every selected record must be an obfuscated contact from one provider namespace in this workspace.",
        stage: "selection",
      });
    }
    const privacyAllowed = await dependencies.privacy.allows(
      { workspaceId: request.actor.workspaceId },
      contacts.map(({ providerIdentity }) => ({
        kind: "provider-subject" as const,
        providerKey: providerIdentity.providerKey,
        value: providerIdentity.providerSubjectId,
      }))
    );
    if (!privacyAllowed) {
      return fail({
        code: "contact-privacy-restricted",
        message: "Contact privacy restrictions block the identity reveal.",
        stage: "privacy",
      });
    }
    const planned = await dependencies.planGeneration(
      planRequest(request, contacts)
    );
    if (!planned.ok) {
      return fail({ ...planned.error, stage: "planning" });
    }
    const created = await dependencies.createGeneration({
      generationPlanId: planned.value.plan.generationPlanId,
      workspaceId: request.actor.workspaceId,
    });
    if (!created.ok) {
      return fail({ ...created.error, stage: "creation" });
    }
    const creation = created.value.creation;
    if (creation.generation.state === "completed") {
      return succeed({
        creation,
        plan: planned.value.plan,
        replayed: true,
        sourceContactDatasetId: request.contactDatasetId,
        sourceContactRecordIds: request.contactRecordIds,
        status: "ready",
      });
    }
    const authorized = await dependencies.authorizePage({
      actorId: request.actor.actorId,
      actorPermissions: request.actor.permissions,
      authenticationMode: request.actor.authenticationMode,
      correlationId: request.correlationId,
      generationId: creation.generation.generationId,
      workspaceId: request.actor.workspaceId,
    });
    if (!authorized.ok) {
      return fail({ ...authorized.error, stage: "authorization" });
    }
    return succeed({
      creation,
      page: authorized.value.page,
      plan: planned.value.plan,
      replayed:
        planned.value.replayed ||
        created.value.replayed ||
        authorized.value.replayed,
      sourceContactDatasetId: request.contactDatasetId,
      sourceContactRecordIds: request.contactRecordIds,
      status: "running",
    });
  };
