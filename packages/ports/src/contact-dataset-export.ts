import type {
  CapabilityRef,
  ContactPrivacySubject,
  ContentHash,
  DatasetGenerationId,
  DatasetGenerationPlanId,
  DatasetId,
  Instant,
  RecordId,
} from "@kurobara/kernel";

import type { WorkspaceScope } from "./run-persistence.ts";

export type ContactDatasetExportDataClass =
  | "contact-identity"
  | "employment"
  | "professional-email"
  | "professional-social-profile";

export type ContactDatasetExportRecordAuthorization = Readonly<{
  observations: Readonly<
    Partial<Record<ContactDatasetExportDataClass, Instant>>
  >;
  recordId: RecordId;
  subjects: readonly ContactPrivacySubject[];
}>;

export type ContactDatasetExportAuthorization = Readonly<{
  providerKeys: readonly string[];
  records: readonly ContactDatasetExportRecordAuthorization[];
  source: Readonly<{
    capability: CapabilityRef;
    generationId: DatasetGenerationId;
    generationPlanId: DatasetGenerationPlanId;
    kind: "generated-dataset";
    planHash: ContentHash;
  }>;
}>;

/**
 * Reads the restricted privacy and immutable generation lineage attached to a
 * materialized dataset.
 *
 * `undefined` means that the dataset has no Contact provider lineage. A
 * protected dataset must return one exact authorization record per materialized
 * record and fail closed when its lineage or observation timestamps are
 * incomplete or malformed.
 */
export interface ContactDatasetExportPrivacySourcePort {
  loadAuthorization(
    scope: WorkspaceScope,
    datasetId: DatasetId
  ): Promise<ContactDatasetExportAuthorization | undefined>;
}
