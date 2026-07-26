import {
  type ContactWorkEmailOperation,
  type ContactWorkEmailOperationKind,
  type ContactWorkEmailResolution,
  type ContactWorkEmailVerification,
  createContactWorkEmailOperation,
  type DatasetId,
  type DomainResult,
  fail,
  type IdempotencyKey,
  type Instant,
  type InternalContactCandidate,
  type RecordId,
  succeed,
  type WorkspaceId,
} from "@kurobara/kernel";
import type {
  ContactWorkEmailPlanningPersistencePort,
  ContactWorkEmailProviderPort,
  ContactWorkEmailProviderResult,
} from "@kurobara/ports";

import type {
  AuthorizeContactEffectRequest,
  AuthorizeContactEffectResult,
} from "./contact-privacy.ts";

export type PlanContactWorkEmailRequest = Readonly<{
  actorPermissions: readonly string[];
  authorityEnvelopeId: string;
  budget: Readonly<{ limit: number; unit: string }>;
  contactDatasetId: DatasetId;
  contactRecordIds: readonly RecordId[];
  deadline: Instant;
  kind: ContactWorkEmailOperationKind;
  operationId: IdempotencyKey;
  workspaceId: WorkspaceId;
}>;

export type PlanContactWorkEmailFailure = Readonly<{
  code:
    | "authority-permission-missing"
    | "contact-selection-invalid"
    | "deadline-elapsed"
    | "idempotency-key-reused"
    | "selection-out-of-scope";
  message: string;
}>;

export type PlanContactWorkEmailResult = DomainResult<
  Readonly<{ operation: ContactWorkEmailOperation; replayed: boolean }>,
  PlanContactWorkEmailFailure
>;

export type PlanContactWorkEmailDependencies = Readonly<{
  now: () => Promise<Instant>;
  persistence: ContactWorkEmailPlanningPersistencePort;
}>;

export const makePlanContactWorkEmail =
  (dependencies: PlanContactWorkEmailDependencies) =>
  async (
    request: PlanContactWorkEmailRequest
  ): Promise<PlanContactWorkEmailResult> => {
    if (!request.actorPermissions.includes("contacts:enrich")) {
      return fail({
        code: "authority-permission-missing",
        message: "The actor is not allowed to enrich contacts.",
      });
    }
    const now = await dependencies.now();
    if (request.deadline <= now) {
      return fail({
        code: "deadline-elapsed",
        message: "The work-email operation deadline has elapsed.",
      });
    }
    const created = createContactWorkEmailOperation({
      budget: request.budget,
      contactDatasetId: request.contactDatasetId,
      contactRecordIds: request.contactRecordIds,
      deadline: request.deadline,
      kind: request.kind,
      operationId: request.operationId,
      state: "planned",
      workspaceId: request.workspaceId,
    });
    if (!created.ok) {
      return fail({
        code: "contact-selection-invalid",
        message: created.error.message,
      });
    }
    const persisted = await dependencies.persistence.plan(
      { workspaceId: request.workspaceId },
      created.value
    );
    if (persisted.status === "idempotency-conflict") {
      return fail({
        code: "idempotency-key-reused",
        message: "The operation ID is already bound to another selection.",
      });
    }
    if (persisted.status === "selection-out-of-scope") {
      return fail({
        code: "selection-out-of-scope",
        message: "Every selected record must belong to the contact dataset.",
      });
    }
    if (persisted.status !== "accepted") {
      return fail({
        code: "contact-selection-invalid",
        message: "The contact selection could not be planned.",
      });
    }
    return succeed({
      operation: persisted.operation,
      replayed: persisted.replayed,
    });
  };

export type ExecuteSelectedContactEffectRequest = Readonly<{
  contact: InternalContactCandidate;
  operation: ContactWorkEmailOperation;
  privacy: Omit<AuthorizeContactEffectRequest, "subject" | "workspaceId">;
}>;

export type ExecuteSelectedContactEffectFailure = Readonly<{
  code:
    | "contact-identity-insufficient"
    | "contact-privacy-restricted"
    | "contact-selection-invalid"
    | "subject-invalid";
  message: string;
}>;

type AuthorizeContactEffect = (
  request: AuthorizeContactEffectRequest
) => Promise<AuthorizeContactEffectResult>;

export type ExecuteSelectedContactEffectDependencies = Readonly<{
  authorizeContactEffect: AuthorizeContactEffect;
  provider: ContactWorkEmailProviderPort;
}>;

const selectionContains = (
  operation: ContactWorkEmailOperation,
  contact: InternalContactCandidate
): boolean => operation.contactRecordIds.includes(contact.candidate.contactId);

export const makeResolveSelectedContactWorkEmail =
  (dependencies: ExecuteSelectedContactEffectDependencies) =>
  async (
    request: ExecuteSelectedContactEffectRequest
  ): Promise<
    DomainResult<
      ContactWorkEmailProviderResult<ContactWorkEmailResolution | undefined>,
      ExecuteSelectedContactEffectFailure
    >
  > => {
    if (
      request.operation.kind !== "resolve" ||
      !selectionContains(request.operation, request.contact)
    ) {
      return fail({
        code: "contact-selection-invalid",
        message: "The contact record is not selected for this resolution.",
      });
    }
    if (request.contact.candidate.identityCompleteness !== "full") {
      return fail({
        code: "contact-identity-insufficient",
        message: "Work-email resolution requires a complete contact identity.",
      });
    }
    const authorization = await dependencies.authorizeContactEffect({
      ...request.privacy,
      subject: {
        kind: "provider-subject",
        providerKey: request.contact.providerIdentity.providerKey,
        value: request.contact.providerIdentity.providerSubjectId,
      },
      workspaceId: request.operation.workspaceId,
    });
    if (!authorization.ok) {
      return fail(authorization.error);
    }
    if (
      !authorization.value.decision.allowed ||
      authorization.value.decision.stopExternalEffects
    ) {
      return fail({
        code: "contact-privacy-restricted",
        message: "Contact privacy policy blocks the email resolution.",
      });
    }
    return succeed(
      await dependencies.provider.resolve({
        contact: request.contact,
        operationId: request.operation.operationId,
      })
    );
  };

export const makeVerifySelectedContactWorkEmail =
  (dependencies: ExecuteSelectedContactEffectDependencies) =>
  async (
    request: ExecuteSelectedContactEffectRequest & Readonly<{ email: string }>
  ): Promise<
    DomainResult<
      ContactWorkEmailProviderResult<ContactWorkEmailVerification>,
      ExecuteSelectedContactEffectFailure
    >
  > => {
    if (
      request.operation.kind !== "verify" ||
      !selectionContains(request.operation, request.contact)
    ) {
      return fail({
        code: "contact-selection-invalid",
        message: "The contact record is not selected for this verification.",
      });
    }
    const authorization = await dependencies.authorizeContactEffect({
      ...request.privacy,
      subject: { kind: "email", value: request.email },
      workspaceId: request.operation.workspaceId,
    });
    if (!authorization.ok) {
      return fail(authorization.error);
    }
    if (
      !authorization.value.decision.allowed ||
      authorization.value.decision.stopExternalEffects
    ) {
      return fail({
        code: "contact-privacy-restricted",
        message: "Contact privacy policy blocks the email verification.",
      });
    }
    return succeed(
      await dependencies.provider.verify({
        email: request.email,
        operationId: request.operation.operationId,
        providerIdentity: request.contact.providerIdentity,
      })
    );
  };
