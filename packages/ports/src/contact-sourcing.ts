import type {
  ContactIdentityOperation,
  ContactIdentityResolution,
  ContactProviderIdentity,
  ContactWorkEmailOperation,
  ContactWorkEmailResolution,
  ContactWorkEmailVerification,
  DatasetId,
  Instant,
  InternalContactCandidate,
  Record,
  RecordId,
  RevealedInternalContactCandidate,
} from "@kurobara/kernel";

import type { WorkspaceScope } from "./run-persistence.ts";

export type ContactDiscoveryPageRequest = Readonly<{
  companyHeadquartersCountryCodes: readonly string[];
  companyRecords: readonly Record[];
  departments: readonly string[];
  inputCursor: null | string;
  maxContactsPerCompany: number;
  maxContactsTotal: number;
  personCountryCodes: readonly string[];
  seniorities: readonly string[];
  titles: readonly string[];
}>;

export type ContactDiscoveryPage = Readonly<{
  candidates: readonly InternalContactCandidate[];
  hasMore: boolean;
  nextCursor: null | string;
  /** Optional additive detail for durable per-company orchestration. */
  outcomes?: readonly ContactDiscoveryCompanyOutcome[];
  usage: Readonly<{
    amount: number;
    basis: "exact" | "upper-bound";
    unit: string;
  }>;
}>;

export type ContactDiscoveryCompanySkipReason =
  | "company-domain-missing"
  | "company-identifier-missing"
  | "company-out-of-scope"
  | "provider-restricted";

export type ContactDiscoveryCompanyOutcome =
  | Readonly<{
      acceptedCount: number;
      companyRecordId: string;
      status: "succeeded";
    }>
  | Readonly<{
      companyRecordId: string;
      reason: "provider-no-result";
      status: "no_result";
    }>
  | Readonly<{
      companyRecordId: string;
      reason: ContactDiscoveryCompanySkipReason;
      status: "skipped";
    }>;

export interface ContactDiscoveryProviderPort {
  discoverPage: (
    request: ContactDiscoveryPageRequest
  ) => Promise<ContactDiscoveryPage>;
}

export type ResolveContactWorkEmailRequest = Readonly<{
  contact: InternalContactCandidate;
  operationId: string;
}>;

export type RevealContactIdentityRequest = Readonly<{
  deadline: Instant;
  operationId: string;
  providerIdentity: ContactProviderIdentity;
}>;

export type ContactProviderQuote = Readonly<{
  guarantee: "hard";
  unit: string;
  upperBound: number;
}>;

export type VerifyContactWorkEmailRequest = Readonly<{
  email: string;
  operationId: string;
  providerIdentity: ContactProviderIdentity;
}>;

export type ContactProviderEffectResult<Value> = Readonly<{
  usage: Readonly<{
    amount: number;
    basis: "exact" | "upper-bound";
    unit: string;
  }>;
  value: Value;
}>;

export type ContactWorkEmailProviderResult<Value> =
  ContactProviderEffectResult<Value>;

export interface ContactIdentityProviderPort {
  quote: (
    request: RevealContactIdentityRequest
  ) => Promise<ContactProviderQuote>;
  reveal: (
    request: RevealContactIdentityRequest
  ) => Promise<
    ContactProviderEffectResult<ContactIdentityResolution | undefined>
  >;
}

export interface ContactIdentitySourcePort {
  load: (
    scope: WorkspaceScope,
    contactDatasetId: DatasetId,
    contactRecordId: RecordId
  ) => Promise<InternalContactCandidate | undefined>;
}

export type SelectedContactWorkEmailSource = Readonly<{
  contact: RevealedInternalContactCandidate;
  workEmail: ContactWorkEmailResolution;
}>;

/**
 * Loads only immutable, materialized selected-contact derivatives. Provider
 * lineage stays restricted to the server-side execution path.
 */
export interface SelectedContactEnrichmentSourcePort {
  loadIdentity: (
    scope: WorkspaceScope,
    contactDatasetId: DatasetId,
    contactRecordId: RecordId
  ) => Promise<RevealedInternalContactCandidate | undefined>;
  loadWorkEmail: (
    scope: WorkspaceScope,
    contactDatasetId: DatasetId,
    contactRecordId: RecordId
  ) => Promise<SelectedContactWorkEmailSource | undefined>;
}

export interface ContactWorkEmailProviderPort {
  resolve: (
    request: ResolveContactWorkEmailRequest
  ) => Promise<
    ContactWorkEmailProviderResult<ContactWorkEmailResolution | undefined>
  >;
  verify: (
    request: VerifyContactWorkEmailRequest
  ) => Promise<ContactWorkEmailProviderResult<ContactWorkEmailVerification>>;
}

export type ContactWorkEmailPlanResult =
  | Readonly<{
      operation: ContactWorkEmailOperation;
      replayed: boolean;
      status: "accepted";
    }>
  | Readonly<{ status: "idempotency-conflict" | "selection-out-of-scope" }>;

export interface ContactWorkEmailPlanningPersistencePort {
  plan: (
    scope: WorkspaceScope,
    operation: ContactWorkEmailOperation
  ) => Promise<ContactWorkEmailPlanResult>;
}

export type ContactIdentityPlanResult =
  | Readonly<{
      operation: ContactIdentityOperation;
      replayed: boolean;
      status: "accepted";
    }>
  | Readonly<{ status: "idempotency-conflict" | "selection-out-of-scope" }>;

export interface ContactIdentityPlanningPersistencePort {
  plan: (
    scope: WorkspaceScope,
    operation: ContactIdentityOperation
  ) => Promise<ContactIdentityPlanResult>;
}
