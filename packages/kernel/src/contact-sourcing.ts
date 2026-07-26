import { type DomainResult, fail, succeed } from "./result.ts";
import type {
  DatasetId,
  Instant,
  RecordId,
  WorkspaceId,
} from "./value-objects.ts";

const DOMAIN_PATTERN = /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/u;
const COUNTRY_PATTERN = /^[A-Z]{2}$/u;
const TAXONOMY_PATTERN = /^[a-z][a-z0-9._-]{0,127}$/u;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+$/u;

const CONTACT_CANDIDATE_KEYS = new Set<PropertyKey>([
  "contactId",
  "department",
  "displayName",
  "identityCompleteness",
  "jobTitle",
  "observedAt",
  "organizationDomain",
  "organizationId",
  "organizationName",
  "personCountryCode",
  "profileUrl",
  "seniority",
]);
const CONTACT_PROVIDER_IDENTITY_KEYS = new Set<PropertyKey>([
  "providerKey",
  "providerSubjectId",
]);
const INTERNAL_CONTACT_CANDIDATE_KEYS = new Set<PropertyKey>([
  "candidate",
  "providerIdentity",
]);
const CONTACT_IDENTITY_RESOLUTION_KEYS = new Set<PropertyKey>([
  "displayName",
  "firstName",
  "identityCompleteness",
  "lastName",
  "observedAt",
  "profileUrl",
]);
const CONTACT_IDENTITY_OPERATION_KEYS = new Set<PropertyKey>([
  "authorityEnvelopeId",
  "budget",
  "contactDatasetId",
  "contactRecordIds",
  "deadline",
  "kind",
  "operationId",
  "state",
  "workspaceId",
]);
const CONTACT_OPERATION_BUDGET_KEYS = new Set<PropertyKey>(["limit", "unit"]);

export type ContactSeniority =
  | "owner"
  | "c_suite"
  | "vp"
  | "director"
  | "manager"
  | "senior"
  | "individual_contributor";

export type ContactCandidate = Readonly<{
  contactId: RecordId;
  department: null | string;
  displayName: string;
  identityCompleteness: "full" | "obfuscated";
  jobTitle: string;
  observedAt: Instant;
  organizationDomain: string;
  organizationId: string;
  organizationName: string;
  personCountryCode: null | string;
  profileUrl: null | string;
  seniority: ContactSeniority | null;
}>;

export type ContactProviderIdentity = Readonly<{
  providerKey: string;
  providerSubjectId: string;
}>;

export type InternalContactCandidate = Readonly<{
  candidate: ContactCandidate;
  providerIdentity: ContactProviderIdentity;
}>;

export type FullContactCandidate = Readonly<
  Omit<ContactCandidate, "identityCompleteness"> & {
    identityCompleteness: "full";
  }
>;

export type ContactIdentityResolution = Readonly<{
  displayName: string;
  firstName: string;
  identityCompleteness: "full";
  lastName: string;
  observedAt: Instant;
  profileUrl: null | string;
}>;

export type ContactIdentityOperationState =
  | "planned"
  | "running"
  | "completed"
  | "failed"
  | "ambiguous";

export type ContactIdentityOperation = Readonly<{
  authorityEnvelopeId: string;
  budget: Readonly<{ limit: number; unit: string }>;
  contactDatasetId: DatasetId;
  contactRecordIds: readonly RecordId[];
  deadline: Instant;
  kind: "reveal";
  operationId: string;
  state: ContactIdentityOperationState;
  workspaceId: WorkspaceId;
}>;

export type RevealedInternalContactCandidate = Readonly<{
  candidate: FullContactCandidate;
  identity: ContactIdentityResolution;
  providerIdentity: ContactProviderIdentity;
}>;

export type ContactWorkEmailResolution = Readonly<{
  confidence: null | number;
  email: string;
  observedAt: Instant;
  source: "inferred" | "public" | "provider_unspecified";
  verification: "accept_all" | "invalid" | "unknown" | "valid";
}>;

export type ContactWorkEmailVerification = Readonly<{
  observedAt: Instant;
  status: "accept_all" | "invalid" | "unknown" | "valid";
}>;

export type ContactWorkEmailOperationKind = "resolve" | "verify";
export type ContactWorkEmailOperationState =
  | "planned"
  | "running"
  | "completed"
  | "failed"
  | "ambiguous";

export type ContactWorkEmailOperation = Readonly<{
  budget: Readonly<{ limit: number; unit: string }>;
  contactDatasetId: DatasetId;
  contactRecordIds: readonly RecordId[];
  deadline: Instant;
  kind: ContactWorkEmailOperationKind;
  operationId: string;
  state: ContactWorkEmailOperationState;
  workspaceId: WorkspaceId;
}>;

export type ContactSourcingFailure = Readonly<{
  code:
    | "contact-candidate-invalid"
    | "contact-identity-invalid"
    | "contact-identity-state-invalid"
    | "contact-provider-identity-invalid"
    | "contact-selection-invalid"
    | "work-email-invalid";
  message: string;
}>;

const bounded = (value: unknown, maximum = 255): value is string =>
  typeof value === "string" &&
  value.trim().length > 0 &&
  [...value].length <= maximum;

const boundedTrimmed = (value: unknown, maximum = 255): value is string =>
  bounded(value, maximum) && value === value.trim();

const hasExactOwnKeys = (
  value: object,
  expectedKeys: ReadonlySet<PropertyKey>
): boolean => {
  const keys = Reflect.ownKeys(value);
  return (
    keys.length === expectedKeys.size &&
    keys.every((key) => expectedKeys.has(key))
  );
};

const secureHttpsUrl = (value: string): boolean => {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      url.hostname.length > 0 &&
      url.username.length === 0 &&
      url.password.length === 0 &&
      url.port.length === 0
    );
  } catch {
    return false;
  }
};

const contactSeniorityIsValid = (
  value: ContactCandidate["seniority"]
): boolean =>
  value === null ||
  value === "owner" ||
  value === "c_suite" ||
  value === "vp" ||
  value === "director" ||
  value === "manager" ||
  value === "senior" ||
  value === "individual_contributor";

const failContact = (
  code: ContactSourcingFailure["code"],
  message: string
): DomainResult<never, ContactSourcingFailure> => fail({ code, message });

export const createContactCandidate = (
  candidate: ContactCandidate
): DomainResult<ContactCandidate, ContactSourcingFailure> => {
  if (
    typeof candidate !== "object" ||
    candidate === null ||
    Array.isArray(candidate) ||
    !hasExactOwnKeys(candidate, CONTACT_CANDIDATE_KEYS) ||
    !(
      bounded(candidate.contactId) &&
      bounded(candidate.displayName) &&
      bounded(candidate.jobTitle) &&
      bounded(candidate.organizationId) &&
      bounded(candidate.organizationName) &&
      bounded(candidate.organizationDomain, 253) &&
      DOMAIN_PATTERN.test(candidate.organizationDomain) &&
      Number.isSafeInteger(candidate.observedAt)
    ) ||
    candidate.observedAt < 0
  ) {
    return failContact(
      "contact-candidate-invalid",
      "The contact candidate identity, employment, domain, or observation time is invalid."
    );
  }
  if (
    candidate.identityCompleteness !== "full" &&
    candidate.identityCompleteness !== "obfuscated"
  ) {
    return failContact(
      "contact-candidate-invalid",
      "The contact candidate identity completeness is invalid."
    );
  }
  if (
    (candidate.department !== null &&
      !TAXONOMY_PATTERN.test(candidate.department)) ||
    (candidate.personCountryCode !== null &&
      !COUNTRY_PATTERN.test(candidate.personCountryCode)) ||
    (candidate.profileUrl !== null &&
      !(
        bounded(candidate.profileUrl, 2048) &&
        candidate.profileUrl.startsWith("https://")
      )) ||
    !contactSeniorityIsValid(candidate.seniority)
  ) {
    return failContact(
      "contact-candidate-invalid",
      "The contact candidate optional professional attributes are invalid."
    );
  }
  return succeed({
    contactId: candidate.contactId,
    department: candidate.department,
    displayName: candidate.displayName,
    identityCompleteness: candidate.identityCompleteness,
    jobTitle: candidate.jobTitle,
    observedAt: candidate.observedAt,
    organizationDomain: candidate.organizationDomain,
    organizationId: candidate.organizationId,
    organizationName: candidate.organizationName,
    personCountryCode: candidate.personCountryCode,
    profileUrl: candidate.profileUrl,
    seniority: candidate.seniority,
  });
};

export const createContactProviderIdentity = (
  identity: ContactProviderIdentity
): DomainResult<ContactProviderIdentity, ContactSourcingFailure> => {
  if (
    typeof identity !== "object" ||
    identity === null ||
    Array.isArray(identity) ||
    !hasExactOwnKeys(identity, CONTACT_PROVIDER_IDENTITY_KEYS) ||
    !TAXONOMY_PATTERN.test(identity.providerKey) ||
    !bounded(identity.providerSubjectId, 512) ||
    identity.providerSubjectId !== identity.providerSubjectId.trim()
  ) {
    return failContact(
      "contact-provider-identity-invalid",
      "The internal contact provider identity is invalid."
    );
  }
  return succeed({
    providerKey: identity.providerKey,
    providerSubjectId: identity.providerSubjectId,
  });
};

export const createContactIdentityResolution = (
  input: ContactIdentityResolution
): DomainResult<ContactIdentityResolution, ContactSourcingFailure> => {
  if (
    typeof input !== "object" ||
    input === null ||
    Array.isArray(input) ||
    !hasExactOwnKeys(input, CONTACT_IDENTITY_RESOLUTION_KEYS) ||
    !boundedTrimmed(input.firstName, 128) ||
    !boundedTrimmed(input.lastName, 128) ||
    !boundedTrimmed(input.displayName, 255) ||
    input.displayName !== `${input.firstName} ${input.lastName}` ||
    input.identityCompleteness !== "full" ||
    !Number.isSafeInteger(input.observedAt) ||
    input.observedAt < 0 ||
    (input.profileUrl !== null &&
      !(
        boundedTrimmed(input.profileUrl, 2048) &&
        secureHttpsUrl(input.profileUrl)
      ))
  ) {
    return failContact(
      "contact-identity-invalid",
      "The resolved contact identity is incomplete or invalid."
    );
  }
  return succeed({ ...input });
};

export const createContactIdentityOperation = (
  input: ContactIdentityOperation
): DomainResult<ContactIdentityOperation, ContactSourcingFailure> => {
  if (
    typeof input !== "object" ||
    input === null ||
    Array.isArray(input) ||
    !hasExactOwnKeys(input, CONTACT_IDENTITY_OPERATION_KEYS) ||
    typeof input.budget !== "object" ||
    input.budget === null ||
    Array.isArray(input.budget) ||
    !hasExactOwnKeys(input.budget, CONTACT_OPERATION_BUDGET_KEYS) ||
    !boundedTrimmed(input.authorityEnvelopeId) ||
    !boundedTrimmed(input.contactDatasetId) ||
    !boundedTrimmed(input.workspaceId) ||
    !boundedTrimmed(input.operationId, 512) ||
    input.kind !== "reveal" ||
    !(
      input.state === "planned" ||
      input.state === "running" ||
      input.state === "completed" ||
      input.state === "failed" ||
      input.state === "ambiguous"
    ) ||
    !Array.isArray(input.contactRecordIds) ||
    input.contactRecordIds.length < 1 ||
    input.contactRecordIds.length > 3 ||
    new Set(input.contactRecordIds).size !== input.contactRecordIds.length ||
    input.contactRecordIds.some((recordId) => !boundedTrimmed(recordId)) ||
    !Number.isFinite(input.budget.limit) ||
    input.budget.limit <= 0 ||
    !TAXONOMY_PATTERN.test(input.budget.unit) ||
    !Number.isSafeInteger(input.deadline) ||
    input.deadline < 0
  ) {
    return failContact(
      "contact-selection-invalid",
      "Identity operations require one to three unique contact records, an explicit budget, and a bounded deadline."
    );
  }
  return succeed(structuredClone(input));
};

export const revealContactCandidateIdentity = (
  contact: InternalContactCandidate,
  resolution: ContactIdentityResolution
): DomainResult<RevealedInternalContactCandidate, ContactSourcingFailure> => {
  if (
    typeof contact !== "object" ||
    contact === null ||
    Array.isArray(contact) ||
    !hasExactOwnKeys(contact, INTERNAL_CONTACT_CANDIDATE_KEYS)
  ) {
    return failContact(
      "contact-candidate-invalid",
      "The internal contact candidate is invalid."
    );
  }
  const candidate = createContactCandidate(contact.candidate);
  if (!candidate.ok) {
    return candidate;
  }
  const providerIdentity = createContactProviderIdentity(
    contact.providerIdentity
  );
  if (!providerIdentity.ok) {
    return providerIdentity;
  }
  if (candidate.value.identityCompleteness !== "obfuscated") {
    return failContact(
      "contact-identity-state-invalid",
      "Only an obfuscated contact identity can be revealed."
    );
  }
  const identity = createContactIdentityResolution(resolution);
  if (!identity.ok) {
    return identity;
  }
  const revealed = createContactCandidate({
    ...candidate.value,
    displayName: identity.value.displayName,
    identityCompleteness: "full",
    profileUrl: identity.value.profileUrl,
  });
  if (!revealed.ok || revealed.value.identityCompleteness !== "full") {
    return failContact(
      "contact-identity-invalid",
      "The resolved contact identity cannot be applied to the candidate."
    );
  }
  return succeed({
    candidate: revealed.value as FullContactCandidate,
    identity: identity.value,
    providerIdentity: providerIdentity.value,
  });
};

export const createContactWorkEmailOperation = (
  input: ContactWorkEmailOperation
): DomainResult<ContactWorkEmailOperation, ContactSourcingFailure> => {
  if (
    !bounded(input.operationId, 512) ||
    input.contactRecordIds.length < 1 ||
    input.contactRecordIds.length > 3 ||
    new Set(input.contactRecordIds).size !== input.contactRecordIds.length ||
    input.contactRecordIds.some((recordId) => !bounded(recordId)) ||
    !Number.isFinite(input.budget.limit) ||
    input.budget.limit <= 0 ||
    !TAXONOMY_PATTERN.test(input.budget.unit) ||
    !Number.isSafeInteger(input.deadline) ||
    input.deadline < 0
  ) {
    return failContact(
      "contact-selection-invalid",
      "Work-email operations require one to three unique contact records, an explicit budget, and a bounded deadline."
    );
  }
  return succeed(structuredClone(input));
};

export const createContactWorkEmailResolution = (
  input: ContactWorkEmailResolution
): DomainResult<ContactWorkEmailResolution, ContactSourcingFailure> => {
  const email = input.email.trim().toLowerCase();
  if (
    email.length > 320 ||
    !EMAIL_PATTERN.test(email) ||
    (input.confidence !== null &&
      (!Number.isFinite(input.confidence) ||
        input.confidence < 0 ||
        input.confidence > 1)) ||
    !Number.isSafeInteger(input.observedAt) ||
    input.observedAt < 0
  ) {
    return failContact(
      "work-email-invalid",
      "The resolved work email evidence is invalid."
    );
  }
  return succeed({ ...input, email });
};
