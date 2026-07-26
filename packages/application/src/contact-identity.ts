import {
  type ContactIdentityOperation,
  type ContactProviderIdentity,
  createContactCandidate,
  createContactIdentityOperation,
  createContactProviderIdentity,
  type DatasetId,
  type DomainResult,
  fail,
  type IdempotencyKey,
  type Instant,
  type InternalContactCandidate,
  type RecordId,
  type RevealedInternalContactCandidate,
  revealContactCandidateIdentity,
  succeed,
  type WorkspaceId,
} from "@kurobara/kernel";
import type {
  ContactIdentityPlanningPersistencePort,
  ContactIdentityProviderPort,
  ContactIdentitySourcePort,
  ContactProviderEffectResult,
  ContactProviderQuote,
} from "@kurobara/ports";

import type {
  AuthorizeContactEffectRequest,
  AuthorizeContactEffectResult,
} from "./contact-privacy.ts";

export type PlanContactIdentityRequest = Readonly<{
  actorPermissions: readonly string[];
  authorityEnvelopeId: string;
  budget: Readonly<{ limit: number; unit: string }>;
  contactDatasetId: DatasetId;
  contactRecordIds: readonly RecordId[];
  deadline: Instant;
  operationId: IdempotencyKey;
  workspaceId: WorkspaceId;
}>;

export type PlanContactIdentityFailure = Readonly<{
  code:
    | "authority-permission-missing"
    | "contact-selection-invalid"
    | "deadline-elapsed"
    | "idempotency-key-reused"
    | "selection-out-of-scope";
  message: string;
}>;

export type PlanContactIdentityResult = DomainResult<
  Readonly<{ operation: ContactIdentityOperation; replayed: boolean }>,
  PlanContactIdentityFailure
>;

export type PlanContactIdentityDependencies = Readonly<{
  now: () => Promise<Instant>;
  persistence: ContactIdentityPlanningPersistencePort;
}>;

const contactIdentityOperationIntentsEqual = (
  left: ContactIdentityOperation,
  right: ContactIdentityOperation
): boolean =>
  left.authorityEnvelopeId === right.authorityEnvelopeId &&
  left.budget.limit === right.budget.limit &&
  left.budget.unit === right.budget.unit &&
  left.contactDatasetId === right.contactDatasetId &&
  left.contactRecordIds.length === right.contactRecordIds.length &&
  left.contactRecordIds.every(
    (recordId, index) => recordId === right.contactRecordIds[index]
  ) &&
  left.deadline === right.deadline &&
  left.kind === right.kind &&
  left.operationId === right.operationId &&
  left.workspaceId === right.workspaceId;

export const makePlanContactIdentity =
  (dependencies: PlanContactIdentityDependencies) =>
  async (
    request: PlanContactIdentityRequest
  ): Promise<PlanContactIdentityResult> => {
    if (!request.actorPermissions.includes("contacts:enrich")) {
      return fail({
        code: "authority-permission-missing",
        message: "The actor is not allowed to reveal contact identities.",
      });
    }
    const now = await dependencies.now();
    if (request.deadline <= now) {
      return fail({
        code: "deadline-elapsed",
        message: "The contact identity operation deadline has elapsed.",
      });
    }
    const created = createContactIdentityOperation({
      authorityEnvelopeId: request.authorityEnvelopeId,
      budget: request.budget,
      contactDatasetId: request.contactDatasetId,
      contactRecordIds: request.contactRecordIds,
      deadline: request.deadline,
      kind: "reveal",
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
        message: "The contact identity selection could not be planned.",
      });
    }
    const persistedOperation = createContactIdentityOperation(
      persisted.operation
    );
    if (
      !(
        persistedOperation.ok &&
        contactIdentityOperationIntentsEqual(
          created.value,
          persistedOperation.value
        )
      )
    ) {
      return fail({
        code: "idempotency-key-reused",
        message:
          "The persisted contact identity operation does not match the requested selection.",
      });
    }
    return succeed({
      operation: persistedOperation.value,
      replayed: persisted.replayed,
    });
  };

export type ContactIdentityPrivacyContext = Readonly<{
  facts: Pick<
    AuthorizeContactEffectRequest["facts"],
    "activeRestrictions" | "purposeRef" | "territory"
  >;
  policy: AuthorizeContactEffectRequest["policy"];
}>;

export type RevealSelectedContactIdentityRequest = Readonly<{
  contactRecordId: RecordId;
  operation: ContactIdentityOperation;
  privacy: ContactIdentityPrivacyContext;
}>;

export type RevealSelectedContactIdentityFailure = Readonly<{
  code:
    | "contact-candidate-invalid"
    | "contact-identity-state-invalid"
    | "contact-not-found"
    | "contact-privacy-restricted"
    | "contact-provider-identity-invalid"
    | "contact-provider-output-invalid"
    | "contact-provider-quote-invalid"
    | "contact-provider-usage-invalid"
    | "contact-selection-invalid"
    | "deadline-elapsed"
    | "subject-invalid";
  message: string;
}>;

type AuthorizeContactEffect = (
  request: AuthorizeContactEffectRequest
) => Promise<AuthorizeContactEffectResult>;

export type RevealSelectedContactIdentityDependencies = Readonly<{
  authorizeContactEffect: AuthorizeContactEffect;
  now: () => Promise<Instant>;
  provider: ContactIdentityProviderPort;
  source: ContactIdentitySourcePort;
}>;

const providerResultIsWithinBudget = (
  result: ContactProviderEffectResult<unknown>,
  operation: ContactIdentityOperation,
  quote: ContactProviderQuote
): boolean =>
  typeof result === "object" &&
  result !== null &&
  typeof result.usage === "object" &&
  result.usage !== null &&
  Number.isFinite(result.usage.amount) &&
  result.usage.amount >= 0 &&
  result.usage.amount <= quote.upperBound &&
  result.usage.amount * operation.contactRecordIds.length <=
    operation.budget.limit &&
  (result.usage.basis === "exact" || result.usage.basis === "upper-bound") &&
  result.usage.unit === operation.budget.unit;

const providerQuoteIsWithinBudget = (
  quote: ContactProviderQuote,
  operation: ContactIdentityOperation
): boolean =>
  typeof quote === "object" &&
  quote !== null &&
  quote.guarantee === "hard" &&
  Number.isFinite(quote.upperBound) &&
  quote.upperBound >= 0 &&
  quote.upperBound * operation.contactRecordIds.length <=
    operation.budget.limit &&
  quote.unit === operation.budget.unit;

const safeUsage = (
  result: ContactProviderEffectResult<unknown>
): ContactProviderEffectResult<unknown>["usage"] => ({
  amount: result.usage.amount,
  basis: result.usage.basis,
  unit: result.usage.unit,
});

const validateIdentityOperation = (
  request: RevealSelectedContactIdentityRequest
): DomainResult<
  ContactIdentityOperation,
  RevealSelectedContactIdentityFailure
> => {
  const operation = createContactIdentityOperation(request.operation);
  if (!operation.ok) {
    return fail({
      code: "contact-selection-invalid",
      message: operation.error.message,
    });
  }
  if (!operation.value.contactRecordIds.includes(request.contactRecordId)) {
    return fail({
      code: "contact-selection-invalid",
      message: "The contact record is not selected for identity reveal.",
    });
  }
  if (
    operation.value.state !== "planned" &&
    operation.value.state !== "running"
  ) {
    return fail({
      code: "contact-identity-state-invalid",
      message: "The contact identity operation cannot perform effects.",
    });
  }
  return operation;
};

type LoadedIdentityContact = Readonly<{
  contact: InternalContactCandidate;
  providerIdentity: ContactProviderIdentity;
}>;

const loadSelectedIdentityContact = async (
  source: ContactIdentitySourcePort,
  operation: ContactIdentityOperation,
  contactRecordId: RecordId
): Promise<
  DomainResult<LoadedIdentityContact, RevealSelectedContactIdentityFailure>
> => {
  const contact = await source.load(
    { workspaceId: operation.workspaceId },
    operation.contactDatasetId,
    contactRecordId
  );
  if (
    contact === undefined ||
    typeof contact !== "object" ||
    contact === null ||
    Array.isArray(contact)
  ) {
    return fail({
      code: "contact-not-found",
      message:
        "The selected contact and its restricted lineage are unavailable.",
    });
  }
  const candidate = createContactCandidate(contact.candidate);
  if (!candidate.ok) {
    return fail({
      code: "contact-candidate-invalid",
      message: candidate.error.message,
    });
  }
  if (candidate.value.contactId !== contactRecordId) {
    return fail({
      code: "contact-selection-invalid",
      message: "The loaded contact does not match the selected record.",
    });
  }
  if (candidate.value.identityCompleteness !== "obfuscated") {
    return fail({
      code: "contact-identity-state-invalid",
      message: "Only an obfuscated contact identity can be revealed.",
    });
  }
  const providerIdentity = createContactProviderIdentity(
    contact.providerIdentity
  );
  if (!providerIdentity.ok) {
    return fail({
      code: "contact-provider-identity-invalid",
      message: providerIdentity.error.message,
    });
  }
  return succeed({ contact, providerIdentity: providerIdentity.value });
};

const identityAuthorizationRequest = (
  request: RevealSelectedContactIdentityRequest,
  operation: ContactIdentityOperation,
  providerIdentity: ContactProviderIdentity
): AuthorizeContactEffectRequest => ({
  facts: {
    action: "enrich",
    activeRestrictions: request.privacy.facts.activeRestrictions,
    explicitlyEnabledDataClasses: [],
    purposeRef: request.privacy.facts.purposeRef,
    requestedData: [
      { dataClass: "contact-identity" },
      { dataClass: "professional-social-profile" },
    ],
    territory: request.privacy.facts.territory,
  },
  policy: request.privacy.policy,
  subject: {
    kind: "provider-subject",
    providerKey: providerIdentity.providerKey,
    value: providerIdentity.providerSubjectId,
  },
  workspaceId: operation.workspaceId,
});

const authorizeIdentityEffect = async (
  authorize: AuthorizeContactEffect,
  request: AuthorizeContactEffectRequest
): Promise<DomainResult<true, RevealSelectedContactIdentityFailure>> => {
  const authorization = await authorize(request);
  if (!authorization.ok) {
    return fail(authorization.error);
  }
  if (
    !authorization.value.decision.allowed ||
    authorization.value.decision.stopExternalEffects
  ) {
    return fail({
      code: "contact-privacy-restricted",
      message: "Contact privacy policy blocks the identity reveal.",
    });
  }
  return succeed(true);
};

const reduceProviderIdentityResult = (
  contact: InternalContactCandidate,
  operation: ContactIdentityOperation,
  quote: ContactProviderQuote,
  providerResult: ContactProviderEffectResult<
    Parameters<typeof revealContactCandidateIdentity>[1] | undefined
  >
): DomainResult<
  ContactProviderEffectResult<RevealedInternalContactCandidate | undefined>,
  RevealSelectedContactIdentityFailure
> => {
  if (!providerResultIsWithinBudget(providerResult, operation, quote)) {
    return fail({
      code: "contact-provider-usage-invalid",
      message: "The contact identity provider reported incoherent usage.",
    });
  }
  if (providerResult.value === undefined) {
    return succeed({
      usage: safeUsage(providerResult),
      value: undefined,
    });
  }
  const revealed = revealContactCandidateIdentity(
    contact,
    providerResult.value
  );
  if (!revealed.ok) {
    return fail({
      code: "contact-provider-output-invalid",
      message: "The contact identity provider returned an invalid result.",
    });
  }
  return succeed({
    usage: safeUsage(providerResult),
    value: revealed.value,
  });
};

export const makeRevealSelectedContactIdentity =
  (dependencies: RevealSelectedContactIdentityDependencies) =>
  async (
    request: RevealSelectedContactIdentityRequest
  ): Promise<
    DomainResult<
      ContactProviderEffectResult<RevealedInternalContactCandidate | undefined>,
      RevealSelectedContactIdentityFailure
    >
  > => {
    const operation = validateIdentityOperation(request);
    if (!operation.ok) {
      return operation;
    }
    if (operation.value.deadline <= (await dependencies.now())) {
      return fail({
        code: "deadline-elapsed",
        message: "The contact identity operation deadline has elapsed.",
      });
    }
    const loaded = await loadSelectedIdentityContact(
      dependencies.source,
      operation.value,
      request.contactRecordId
    );
    if (!loaded.ok) {
      return loaded;
    }
    const providerRequest = {
      deadline: operation.value.deadline,
      operationId: operation.value.operationId,
      providerIdentity: loaded.value.providerIdentity,
    };
    const authorizationRequest = identityAuthorizationRequest(
      request,
      operation.value,
      loaded.value.providerIdentity
    );
    let authorization = await authorizeIdentityEffect(
      dependencies.authorizeContactEffect,
      authorizationRequest
    );
    if (!authorization.ok) {
      return authorization;
    }
    const quote = await dependencies.provider.quote(providerRequest);
    if (!providerQuoteIsWithinBudget(quote, operation.value)) {
      return fail({
        code: "contact-provider-quote-invalid",
        message:
          "The contact identity provider cannot guarantee the selected budget.",
      });
    }
    authorization = await authorizeIdentityEffect(
      dependencies.authorizeContactEffect,
      authorizationRequest
    );
    if (!authorization.ok) {
      return authorization;
    }
    if (operation.value.deadline <= (await dependencies.now())) {
      return fail({
        code: "deadline-elapsed",
        message:
          "The contact identity operation deadline elapsed before the effect.",
      });
    }
    const providerResult = await dependencies.provider.reveal(providerRequest);
    return reduceProviderIdentityResult(
      loaded.value.contact,
      operation.value,
      quote,
      providerResult
    );
  };
