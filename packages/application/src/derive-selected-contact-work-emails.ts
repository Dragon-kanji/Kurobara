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
  ContactPrivacyGuardPort,
  SelectedContactEnrichmentSourcePort,
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

const WORK_EMAIL_FIELDS = [
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
  ["work_email", "Work email", "string"],
  ["work_email_confidence", "Work email confidence", "number"],
  ["work_email_observed_at_ms", "Work email observed at", "number"],
  ["work_email_source", "Work email source", "string"],
  ["work_email_status", "Work email status", "string"],
  ["work_email_verification", "Work email verification", "string"],
] as const;

export type DeriveSelectedContactWorkEmailsRequest = Readonly<{
  actor: VerifiedApiKey;
  authorityEnvelopeId: string;
  budget: Readonly<{ limit: number; unit: string }>;
  contactDatasetId: Parameters<
    SelectedContactEnrichmentSourcePort["loadIdentity"]
  >[1];
  contactRecordIds: readonly Parameters<
    SelectedContactEnrichmentSourcePort["loadIdentity"]
  >[2][];
  correlationId: AuthorizeDatasetGenerationPageRequest["correlationId"];
  deadline: Instant;
  kind: "resolve" | "verify";
  operationId: IdempotencyKey;
}>;

export type DeriveSelectedContactWorkEmailsSuccess = Readonly<{
  creation: DatasetGenerationCreation;
  page?: DatasetGenerationPage;
  plan: DatasetGenerationPlan;
  replayed: boolean;
  sourceContactDatasetId: DeriveSelectedContactWorkEmailsRequest["contactDatasetId"];
  sourceContactRecordIds: DeriveSelectedContactWorkEmailsRequest["contactRecordIds"];
  status: "ready" | "running";
}>;

export type DeriveSelectedContactWorkEmailsFailure = Readonly<{
  code: string;
  message: string;
  stage: "authorization" | "creation" | "planning" | "privacy" | "selection";
}>;

export type DeriveSelectedContactWorkEmailsResult = DomainResult<
  DeriveSelectedContactWorkEmailsSuccess,
  DeriveSelectedContactWorkEmailsFailure
>;

export type DeriveSelectedContactWorkEmailsDependencies = Readonly<{
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
  source: SelectedContactEnrichmentSourcePort;
}>;

type SelectedContact = NonNullable<
  Awaited<ReturnType<SelectedContactEnrichmentSourcePort["loadWorkEmail"]>>
>;

const selectionIsBounded = (
  request: DeriveSelectedContactWorkEmailsRequest
): boolean =>
  request.actor.permissions.includes("contacts:enrich") &&
  request.actor.permissions.includes("steps:execute") &&
  request.contactRecordIds.length >= 1 &&
  request.contactRecordIds.length <= 3 &&
  new Set(request.contactRecordIds).size === request.contactRecordIds.length;

const loadSelection = async (
  dependencies: DeriveSelectedContactWorkEmailsDependencies,
  request: DeriveSelectedContactWorkEmailsRequest
): Promise<readonly SelectedContact[] | undefined> => {
  const loaded = await Promise.all(
    request.contactRecordIds.map(async (recordId) => {
      if (request.kind === "verify") {
        return await dependencies.source.loadWorkEmail(
          { workspaceId: request.actor.workspaceId },
          request.contactDatasetId,
          recordId
        );
      }
      const contact = await dependencies.source.loadIdentity(
        { workspaceId: request.actor.workspaceId },
        request.contactDatasetId,
        recordId
      );
      return contact === undefined
        ? undefined
        : ({ contact, workEmail: undefined } as const);
    })
  );
  if (
    loaded.some(
      (entry, index) =>
        entry === undefined ||
        entry.contact.candidate.contactId !== request.contactRecordIds[index]
    )
  ) {
    return;
  }
  const selection = loaded as readonly Readonly<{
    contact: SelectedContact["contact"];
    workEmail: SelectedContact["workEmail"] | undefined;
  }>[];
  const namespaces = new Set(
    selection.map((entry) => entry.contact.providerIdentity.providerKey)
  );
  if (namespaces.size !== 1) {
    return;
  }
  return selection as readonly SelectedContact[];
};

const targetDatasetId = (request: DeriveSelectedContactWorkEmailsRequest) =>
  datasetId(
    `contact_work_email_${canonicalContentHash({
      kind: `selected-contact-work-email-${request.kind}`,
      operationId: request.operationId,
      workspaceId: request.actor.workspaceId,
    }).slice("sha256:".length, "sha256:".length + 40)}`
  );

const selectedContactQuery = (
  selection: readonly SelectedContact[],
  kind: DeriveSelectedContactWorkEmailsRequest["kind"]
) =>
  selection.map(({ contact, workEmail }) => ({
    candidate: {
      department: contact.candidate.department,
      display_name: contact.candidate.displayName,
      identity_completeness: contact.candidate.identityCompleteness,
      job_title: contact.candidate.jobTitle,
      observed_at_ms: contact.candidate.observedAt,
      organization_domain: contact.candidate.organizationDomain,
      organization_id: contact.candidate.organizationId,
      organization_name: contact.candidate.organizationName,
      person_country_code: contact.candidate.personCountryCode,
      profile_url: contact.candidate.profileUrl,
      seniority: contact.candidate.seniority,
    },
    identity: {
      display_name: contact.identity.displayName,
      first_name: contact.identity.firstName,
      last_name: contact.identity.lastName,
      observed_at_ms: contact.identity.observedAt,
      profile_url: contact.identity.profileUrl,
    },
    provider_identity: {
      provider_key: contact.providerIdentity.providerKey,
      provider_subject_id: contact.providerIdentity.providerSubjectId,
    },
    source_record_id: contact.candidate.contactId,
    ...(kind === "verify"
      ? {
          work_email: {
            confidence: workEmail.confidence,
            email: workEmail.email,
            observed_at_ms: workEmail.observedAt,
            source: workEmail.source,
            verification: workEmail.verification,
          },
        }
      : {}),
  }));

const planRequest = (
  request: DeriveSelectedContactWorkEmailsRequest,
  selection: readonly SelectedContact[]
): PlanDatasetGenerationRequest => {
  const firstSelection = selection[0];
  if (firstSelection === undefined) {
    throw new Error("Selected work-email planning requires one contact.");
  }
  const resultDatasetId = targetDatasetId(request);
  const workspaceId = request.actor.workspaceId;
  const count = selection.length;
  return {
    actorId: request.actor.actorId,
    authorityEnvelopeId: request.authorityEnvelopeId,
    capability: {
      capabilityId:
        `contacts.work-email.${request.kind}` as PlanDatasetGenerationRequest["capability"]["capabilityId"],
      capabilityVersion: "1.0.0",
    },
    fields: WORK_EMAIL_FIELDS.map(([key, label, valueType]) => ({
      datasetId: resultDatasetId,
      fieldId: fieldId(`contact_work_email_${key}`),
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
    providerIdentityNamespace:
      firstSelection.contact.providerIdentity.providerKey,
    query: {
      operation_kind: request.kind,
      result_kind: "contact_work_email",
      selected_contacts: selectedContactQuery(selection, request.kind),
      source_dataset_id: request.contactDatasetId,
    },
    requestedBudget: request.budget,
    requestedDeadline: request.deadline,
    targetDataset: {
      datasetId: resultDatasetId,
      name:
        request.kind === "resolve"
          ? "Selected contact work emails"
          : "Verified selected contact work emails",
      workspaceId,
    },
    unknownCostPolicy: { mode: "deny" },
    workspaceId,
  };
};

/** Starts one immutable, selected-only work-email derivation. */
export const makeDeriveSelectedContactWorkEmails =
  (dependencies: DeriveSelectedContactWorkEmailsDependencies) =>
  async (
    request: DeriveSelectedContactWorkEmailsRequest
  ): Promise<DeriveSelectedContactWorkEmailsResult> => {
    if (!selectionIsBounded(request)) {
      return fail({
        code: "contact-selection-invalid",
        message:
          "Work-email enrichment requires contacts:enrich, steps:execute, and one to three unique records.",
        stage: "selection",
      });
    }
    const selection = await loadSelection(dependencies, request);
    if (selection === undefined) {
      return fail({
        code: "contact-selection-invalid",
        message:
          request.kind === "resolve"
            ? "Every selected record must contain a full immutable identity from one provider namespace."
            : "Every selected record must contain a resolved work email from one provider namespace.",
        stage: "selection",
      });
    }
    const privacyAllowed = await dependencies.privacy.allows(
      { workspaceId: request.actor.workspaceId },
      selection.flatMap(({ contact, workEmail }) => [
        {
          kind: "provider-subject" as const,
          providerKey: contact.providerIdentity.providerKey,
          value: contact.providerIdentity.providerSubjectId,
        },
        ...(request.kind === "verify"
          ? [{ kind: "email" as const, value: workEmail.email }]
          : []),
      ])
    );
    if (!privacyAllowed) {
      return fail({
        code: "contact-privacy-restricted",
        message: "Contact privacy restrictions block the work-email effect.",
        stage: "privacy",
      });
    }
    const planned = await dependencies.planGeneration(
      planRequest(request, selection)
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
