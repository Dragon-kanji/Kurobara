import type {
  ActorId,
  ContactPrivacySubjectKey,
  ContentHash,
  DatasetId,
  EnrichmentRecipeId,
  FieldId,
  IdempotencyKey,
  Instant,
  WorkspaceId,
} from "@kurobara/kernel";

import type { DatasetImportFormat } from "./dataset-persistence.ts";
import type { RecipeApplicationId } from "./recipe-persistence.ts";
import type { WorkspaceScope } from "./run-persistence.ts";

export type ExportDeliveryId = string;

export type ExportContactDataClass =
  | "contact-identity"
  | "employment"
  | "personal-email"
  | "phone"
  | "professional-email"
  | "professional-social-profile";

export type ExportProviderRightsMode =
  | "operator-authorized-byok"
  | "synthetic-fixture";

export type ExportDeliveryPurposeSnapshot = Readonly<{
  policyExpiresAt: Instant;
  policyVersion: string;
  purposeRef: string;
  territory: string;
}>;

export type ExportDeliveryProviderRightsSnapshot = Readonly<{
  expiresAt: Instant;
  mode: ExportProviderRightsMode;
  version: string;
}>;

export type ExportDeliveryObservedExpiry = Readonly<{
  dataClass: ExportContactDataClass;
  expiresAt: Instant;
  observedAt: Instant;
}>;

type ExportDeliveryManifestCommon = Readonly<{
  contentHash: ContentHash;
  contentLength: number;
  dataClasses: readonly ExportContactDataClass[];
  datasetId: DatasetId;
  fieldIds: readonly FieldId[];
  format: DatasetImportFormat;
  observedExpiries: readonly ExportDeliveryObservedExpiry[];
  ownerActorId: ActorId;
  policyPurpose: ExportDeliveryPurposeSnapshot;
  providerRights: ExportDeliveryProviderRightsSnapshot;
  workspaceId: WorkspaceId;
}>;

export type RecipeApplicationExportDeliveryManifest =
  ExportDeliveryManifestCommon &
    Readonly<{
      applicationId: RecipeApplicationId;
      recipeId: EnrichmentRecipeId;
      recipeRevision: string;
    }>;

export type GeneratedDatasetExportDeliverySource = Readonly<{
  capabilityId: string;
  capabilityVersion: string;
  generationId: string;
  generationPlanId: string;
  kind: "generated-dataset";
  planHash: ContentHash;
}>;

export type GeneratedDatasetExportDeliveryManifest =
  ExportDeliveryManifestCommon &
    Readonly<{
      applicationId: null;
      manifestVersion: "2.0.0";
      recipeId: null;
      recipeRevision: null;
      source: GeneratedDatasetExportDeliverySource;
    }>;

/**
 * Audit-safe immutable description of one exact export. It deliberately omits
 * contact values, raw rows, provider subject identifiers and provider keys.
 */
export type ExportDeliveryManifest =
  | GeneratedDatasetExportDeliveryManifest
  | RecipeApplicationExportDeliveryManifest;

export type ExportDeliveryState = "delivered" | "prepared" | "revoked";

export type ExportDelivery = Readonly<{
  deliveryId: ExportDeliveryId;
  /**
   * Always populated by durable adapters. It stays optional for compatibility
   * with in-memory ports written before the lifecycle registry existed.
   */
  effectiveExpiresAt?: Instant;
  intentHash: ContentHash;
  manifest: ExportDeliveryManifest;
  preparedAt: Instant;
  state: ExportDeliveryState;
  deliveredAt?: Instant;
  revokedAt?: Instant;
}>;

export type PrepareExportDeliveryInput = Readonly<{
  delivery: Omit<
    ExportDelivery,
    "deliveredAt" | "effectiveExpiresAt" | "revokedAt" | "state"
  >;
  idempotencyKey: IdempotencyKey;
  /**
   * Restricted, versioned HMAC keys derived from every exact exported subject.
   * Generated-dataset manifests require at least one key; legacy recipe
   * manifests may omit them until their caller is migrated.
   */
  subjectKeys?: readonly ContactPrivacySubjectKey[];
}>;

export type PrepareExportDeliveryResult =
  | Readonly<{
      delivery: ExportDelivery;
      replayed: boolean;
      status: "prepared";
    }>
  | Readonly<{ status: "idempotency-conflict" }>
  | Readonly<{ status: "subject-restricted" }>
  | Readonly<{ delivery: ExportDelivery; status: "revoked" }>;

export type CompleteExportDeliveryInput = Readonly<{
  contentHash: ContentHash;
  contentLength: number;
  deliveredAt: Instant;
  deliveryId: ExportDeliveryId;
  ownerActorId: ActorId;
}>;

export type CompleteExportDeliveryResult =
  | Readonly<{
      delivery: ExportDelivery;
      replayed: boolean;
      status: "delivered";
    }>
  | Readonly<{
      status: "not-found-or-owner-mismatch";
    }>
  | Readonly<{
      status: "proof-conflict";
    }>
  | Readonly<{
      delivery: ExportDelivery;
      status: "revoked";
    }>;

export type RevokeExportDeliveryInput = Readonly<{
  deliveryId: ExportDeliveryId;
  ownerActorId: ActorId;
  revokedAt: Instant;
}>;

export type RevokeExportDeliveryResult =
  | Readonly<{
      delivery: ExportDelivery;
      replayed: boolean;
      status: "revoked";
    }>
  | Readonly<{
      status: "not-found-or-owner-mismatch";
    }>;

export interface ExportDeliveryPersistencePort {
  complete(
    scope: WorkspaceScope,
    input: CompleteExportDeliveryInput
  ): Promise<CompleteExportDeliveryResult>;
  getOwned(
    scope: WorkspaceScope,
    deliveryId: ExportDeliveryId,
    ownerActorId: ActorId
  ): Promise<ExportDelivery | undefined>;
  prepare(
    scope: WorkspaceScope,
    input: PrepareExportDeliveryInput
  ): Promise<PrepareExportDeliveryResult>;
  revoke(
    scope: WorkspaceScope,
    input: RevokeExportDeliveryInput
  ): Promise<RevokeExportDeliveryResult>;
}
