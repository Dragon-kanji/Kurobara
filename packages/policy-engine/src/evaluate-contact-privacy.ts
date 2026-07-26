import type { Instant } from "@kurobara/kernel";
import { instant } from "@kurobara/kernel";

export const CONTACT_DATA_CLASSES = [
  "contact-identity",
  "employment",
  "professional-social-profile",
  "professional-email",
  "personal-email",
  "phone",
] as const;

export type ContactDataClass = (typeof CONTACT_DATA_CLASSES)[number];

export type ContactDataAction = "discover" | "enrich" | "export";

export const CONTACT_PRIVACY_RESTRICTIONS = [
  "provider-opt-out",
  "provider-deletion",
  "provider-claimed-email",
  "operator-subject-request",
  "privacy-tombstone",
  "territory-restriction",
] as const;

export type ContactPrivacyRestriction =
  (typeof CONTACT_PRIVACY_RESTRICTIONS)[number];

export type ContactDataRule = Readonly<{
  allowedActions: readonly ContactDataAction[];
  maxRetentionMilliseconds: number;
}>;

export type ContactPrivacyPolicySnapshot = Readonly<{
  version: string;
  purposeRefs: readonly string[];
  territories: readonly string[];
  expiresAt: Instant;
  rules: Readonly<Partial<Record<ContactDataClass, ContactDataRule>>>;
}>;

export type RequestedContactData = Readonly<{
  dataClass: ContactDataClass;
  observedAt?: Instant;
}>;

export type ContactPrivacyFacts = Readonly<{
  action: ContactDataAction;
  purposeRef: string | null;
  territory: string | null;
  requestedData: readonly RequestedContactData[];
  explicitlyEnabledDataClasses: readonly ContactDataClass[];
  activeRestrictions: readonly ContactPrivacyRestriction[];
  now: Instant;
}>;

export type ContactPrivacyReasonCode =
  | ContactPrivacyRestriction
  | "policy-expired"
  | "purpose-unresolved"
  | "purpose-denied"
  | "territory-unresolved"
  | "territory-denied"
  | "data-class-missing"
  | "data-class-unknown"
  | "data-class-duplicate"
  | "data-class-disabled"
  | "restriction-unknown"
  | "explicit-opt-in-required"
  | "action-denied"
  | "retention-limit-invalid"
  | "observation-time-missing"
  | "observation-time-invalid"
  | "ttl-expired"
  | "allowed";

export type ContactDataRetentionLimit = Readonly<{
  dataClass: ContactDataClass;
  maxRetentionMilliseconds: number;
  expiresAt?: Instant;
}>;

export type ContactPrivacyDecision = Readonly<{
  allowed: boolean;
  policyVersion: string;
  reasonCodes: readonly ContactPrivacyReasonCode[];
  deniedDataClasses: readonly ContactDataClass[];
  retentionLimits: readonly ContactDataRetentionLimit[];
  stopExternalEffects: boolean;
  stopFallback: boolean;
}>;

const EXPLICIT_OPT_IN_CLASSES: ReadonlySet<ContactDataClass> = new Set([
  "personal-email",
  "phone",
]);
const KNOWN_CONTACT_DATA_CLASSES: ReadonlySet<string> = new Set(
  CONTACT_DATA_CLASSES
);
const KNOWN_CONTACT_PRIVACY_RESTRICTIONS: ReadonlySet<string> = new Set(
  CONTACT_PRIVACY_RESTRICTIONS
);

const pushUnique = <Value>(values: Value[], value: Value): void => {
  if (!values.includes(value)) {
    values.push(value);
  }
};

const isResolved = (value: string | null): value is string =>
  value !== null && value.trim().length > 0;

const requestedDataInCanonicalOrder = (
  requests: readonly RequestedContactData[]
): RequestedContactData[] =>
  CONTACT_DATA_CLASSES.flatMap((dataClass) => {
    const request = requests.find(
      (candidate) => candidate.dataClass === dataClass
    );
    return request ? [request] : [];
  });

const effectiveExpiry = (
  observedAt: Instant,
  maxRetentionMilliseconds: number,
  policyExpiresAt: Instant
): Instant | null => {
  const retainedUntil = observedAt + maxRetentionMilliseconds;
  if (!Number.isSafeInteger(retainedUntil)) {
    return null;
  }
  return instant(Math.min(retainedUntil, policyExpiresAt));
};

interface MutableContactPrivacyDecision {
  deniedDataClasses: Set<ContactDataClass>;
  reasonCodes: ContactPrivacyReasonCode[];
  retentionLimits: ContactDataRetentionLimit[];
}

const denyDataClass = (
  decision: MutableContactPrivacyDecision,
  dataClass: ContactDataClass,
  reasonCode: ContactPrivacyReasonCode
): void => {
  pushUnique(decision.reasonCodes, reasonCode);
  decision.deniedDataClasses.add(dataClass);
};

const evaluateRequestedData = (
  policy: ContactPrivacyPolicySnapshot,
  facts: ContactPrivacyFacts,
  request: RequestedContactData,
  decision: MutableContactPrivacyDecision
): void => {
  const { dataClass } = request;
  const rule = policy.rules[dataClass];
  if (!rule) {
    denyDataClass(decision, dataClass, "data-class-disabled");
    return;
  }
  if (
    EXPLICIT_OPT_IN_CLASSES.has(dataClass) &&
    !facts.explicitlyEnabledDataClasses.includes(dataClass)
  ) {
    denyDataClass(decision, dataClass, "explicit-opt-in-required");
  }
  if (!rule.allowedActions.includes(facts.action)) {
    denyDataClass(decision, dataClass, "action-denied");
  }
  if (
    !Number.isSafeInteger(rule.maxRetentionMilliseconds) ||
    rule.maxRetentionMilliseconds <= 0
  ) {
    denyDataClass(decision, dataClass, "retention-limit-invalid");
    return;
  }
  if (request.observedAt === undefined) {
    if (facts.action === "export") {
      denyDataClass(decision, dataClass, "observation-time-missing");
    } else {
      decision.retentionLimits.push({
        dataClass,
        expiresAt: policy.expiresAt,
        maxRetentionMilliseconds: rule.maxRetentionMilliseconds,
      });
    }
    return;
  }
  if (request.observedAt > facts.now) {
    denyDataClass(decision, dataClass, "observation-time-invalid");
    return;
  }
  const expiresAt = effectiveExpiry(
    request.observedAt,
    rule.maxRetentionMilliseconds,
    policy.expiresAt
  );
  if (expiresAt === null) {
    denyDataClass(decision, dataClass, "retention-limit-invalid");
    return;
  }
  decision.retentionLimits.push({
    dataClass,
    expiresAt,
    maxRetentionMilliseconds: rule.maxRetentionMilliseconds,
  });
  if (facts.now >= expiresAt) {
    denyDataClass(decision, dataClass, "ttl-expired");
  }
};

export const evaluateContactPrivacy = (
  policy: ContactPrivacyPolicySnapshot,
  facts: ContactPrivacyFacts
): ContactPrivacyDecision => {
  const decision: MutableContactPrivacyDecision = {
    deniedDataClasses: new Set<ContactDataClass>(),
    reasonCodes: [],
    retentionLimits: [],
  };
  const requestedData = requestedDataInCanonicalOrder(facts.requestedData);

  if (
    facts.activeRestrictions.some(
      (restriction) => !KNOWN_CONTACT_PRIVACY_RESTRICTIONS.has(restriction)
    )
  ) {
    decision.reasonCodes.push("restriction-unknown");
  }

  for (const restriction of CONTACT_PRIVACY_RESTRICTIONS) {
    if (facts.activeRestrictions.includes(restriction)) {
      decision.reasonCodes.push(restriction);
    }
  }

  if (facts.now >= policy.expiresAt) {
    decision.reasonCodes.push("policy-expired");
  }
  if (!isResolved(facts.purposeRef)) {
    decision.reasonCodes.push("purpose-unresolved");
  } else if (!policy.purposeRefs.includes(facts.purposeRef)) {
    decision.reasonCodes.push("purpose-denied");
  }
  if (!isResolved(facts.territory)) {
    decision.reasonCodes.push("territory-unresolved");
  } else if (!policy.territories.includes(facts.territory)) {
    decision.reasonCodes.push("territory-denied");
  }
  if (
    facts.requestedData.some(
      (request) => !KNOWN_CONTACT_DATA_CLASSES.has(request.dataClass)
    )
  ) {
    decision.reasonCodes.push("data-class-unknown");
  }
  if (
    new Set(facts.requestedData.map((request) => request.dataClass)).size !==
    facts.requestedData.length
  ) {
    decision.reasonCodes.push("data-class-duplicate");
  }
  if (requestedData.length === 0) {
    decision.reasonCodes.push("data-class-missing");
  }

  const hasGlobalDenial = decision.reasonCodes.length > 0;
  if (hasGlobalDenial) {
    for (const { dataClass } of requestedData) {
      decision.deniedDataClasses.add(dataClass);
    }
  }

  for (const request of requestedData) {
    evaluateRequestedData(policy, facts, request, decision);
  }

  const allowed = decision.reasonCodes.length === 0;
  return {
    allowed,
    deniedDataClasses: CONTACT_DATA_CLASSES.filter((dataClass) =>
      decision.deniedDataClasses.has(dataClass)
    ),
    policyVersion: policy.version,
    reasonCodes: allowed ? ["allowed"] : decision.reasonCodes,
    retentionLimits: decision.retentionLimits,
    stopExternalEffects: !allowed,
    stopFallback: !allowed,
  };
};
