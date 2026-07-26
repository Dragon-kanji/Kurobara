// biome-ignore-all lint/performance/noBarrelFile: This package root is its deliberate public API boundary.
export type {
  ContactDataAction,
  ContactDataClass,
  ContactDataRetentionLimit,
  ContactDataRule,
  ContactPrivacyDecision,
  ContactPrivacyFacts,
  ContactPrivacyPolicySnapshot,
  ContactPrivacyReasonCode,
  ContactPrivacyRestriction,
  RequestedContactData,
} from "./evaluate-contact-privacy.ts";
export {
  CONTACT_DATA_CLASSES,
  CONTACT_PRIVACY_RESTRICTIONS,
  evaluateContactPrivacy,
} from "./evaluate-contact-privacy.ts";
export type {
  PolicyDecision,
  PolicyFacts,
  PolicyReasonCode,
  PolicySnapshot,
} from "./evaluate-policy.ts";
export { evaluatePolicy } from "./evaluate-policy.ts";
export type {
  SourcingBudgetPreflightDecision,
  SourcingBudgetPreflightFacts,
  SourcingBudgetPreflightReasonCode,
  SourcingBudgetPreflightSnapshot,
  SourcingCardinalityLimitInput,
  SourcingCardinalityLimits,
  SourcingLimitName,
  UnknownSourcingCostPolicy,
} from "./evaluate-sourcing-budget-preflight.ts";
export {
  evaluateSourcingBudgetPreflight,
  SOURCING_LIMIT_NAMES,
} from "./evaluate-sourcing-budget-preflight.ts";
