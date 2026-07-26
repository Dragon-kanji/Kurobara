import type {
  ContactPrivacySubject,
  ContactPrivacySubjectKey,
  ContactPrivacyTombstone,
  ContactPrivacyTombstoneReason,
  ContentHash,
  IdempotencyKey,
  Instant,
} from "@kurobara/kernel";
import type { WorkspaceScope } from "./run-persistence.ts";

export interface ContactPrivacyGuardPort {
  allows(
    scope: WorkspaceScope,
    subjects: readonly ContactPrivacySubject[]
  ): Promise<boolean>;
}

export type ContactPrivacySubjectKeySet = Readonly<{
  all: readonly ContactPrivacySubjectKey[];
  current: ContactPrivacySubjectKey;
}>;

export interface ContactPrivacySubjectKeyDerivationPort {
  derive(subject: ContactPrivacySubject): Promise<ContactPrivacySubjectKeySet>;
}

export type RegisterContactPrivacyTombstoneInput = Readonly<{
  idempotencyKey: IdempotencyKey;
  intentHash: ContentHash;
  reason: ContactPrivacyTombstoneReason;
  registeredAt: Instant;
  subjectKeys: ContactPrivacySubjectKeySet;
}>;

export type ContactPrivacyRegistrationResult =
  | Readonly<{
      /**
       * PostgreSQL always returns both counters. They remain optional so older
       * in-memory ports can implement the compatible registration contract.
       */
      affectedDeliveryCount?: number;
      newlyRevokedDeliveryCount?: number;
      proof: ContactPrivacyTombstone;
      replayed: boolean;
      status: "registered";
    }>
  | Readonly<{
      status: "idempotency-conflict";
    }>;

export interface ContactPrivacyPersistencePort {
  findBySubjectKeys(
    scope: WorkspaceScope,
    subjectKeys: readonly ContactPrivacySubjectKey[]
  ): Promise<readonly ContactPrivacyTombstone[]>;
  register(
    scope: WorkspaceScope,
    input: RegisterContactPrivacyTombstoneInput
  ): Promise<ContactPrivacyRegistrationResult>;
}
