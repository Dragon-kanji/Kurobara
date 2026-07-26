import {
  type DomainResult,
  fail,
  type Instant,
  instant,
  succeed,
} from "@kurobara/kernel";
import {
  CONTACT_DATA_CLASSES,
  type ContactDataClass,
  type ContactDataRule,
  type ContactPrivacyFacts,
  type ContactPrivacyPolicySnapshot,
  type RequestedContactData,
} from "@kurobara/policy-engine";
import type { ExportProviderRightsMode } from "@kurobara/ports";

export type ContactExportProviderRightsTemplate = Readonly<{
  mode: ExportProviderRightsMode;
  ttlMilliseconds: number;
  version: string;
}>;

export type ContactExportPolicyTemplate = Readonly<{
  maxRetentionMilliseconds: Readonly<Partial<Record<ContactDataClass, number>>>;
  policyTtlMilliseconds: number;
  policyVersion: string;
  providerRights: Readonly<Record<string, ContactExportProviderRightsTemplate>>;
  purposeRef: string;
  territory: string;
}>;

export type ResolveContactExportPolicyRequest = Readonly<{
  now: number;
  providerKeys: readonly string[];
  requestedData: readonly RequestedContactData[];
}>;

export type ResolvedContactExportPolicy = Readonly<{
  privacy: Readonly<{
    facts: Omit<ContactPrivacyFacts, "action" | "now">;
    policy: ContactPrivacyPolicySnapshot;
  }>;
  providerRights: Readonly<{
    authorized: true;
    expiresAt: Instant;
    mode: ExportProviderRightsMode;
    version: string;
  }>;
}>;

export type ResolveContactExportPolicyFailure = Readonly<{
  code: "contact-export-policy-unavailable";
  message: string;
}>;

export type ContactExportPolicyResolver = (
  request: ResolveContactExportPolicyRequest
) => DomainResult<
  ResolvedContactExportPolicy,
  ResolveContactExportPolicyFailure
>;

const VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const PROVIDER_KEY_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/u;

const isPositiveSafeInteger = (value: number): boolean =>
  Number.isSafeInteger(value) && value > 0;

const configurationIsValid = (
  template: ContactExportPolicyTemplate
): boolean => {
  const providerEntries = Object.entries(template.providerRights);
  return (
    VERSION_PATTERN.test(template.policyVersion) &&
    template.purposeRef.trim() === template.purposeRef &&
    template.purposeRef.length > 0 &&
    template.purposeRef.length <= 255 &&
    template.territory.trim() === template.territory &&
    template.territory.length > 0 &&
    template.territory.length <= 64 &&
    isPositiveSafeInteger(template.policyTtlMilliseconds) &&
    providerEntries.length > 0 &&
    providerEntries.every(
      ([providerKey, rights]) =>
        PROVIDER_KEY_PATTERN.test(providerKey) &&
        VERSION_PATTERN.test(rights.version) &&
        isPositiveSafeInteger(rights.ttlMilliseconds)
    ) &&
    Object.entries(template.maxRetentionMilliseconds).every(
      ([dataClass, duration]) =>
        CONTACT_DATA_CLASSES.includes(dataClass as ContactDataClass) &&
        duration !== undefined &&
        isPositiveSafeInteger(duration)
    )
  );
};

const boundedExpiry = (
  now: number,
  duration: number
): ReturnType<typeof instant> | undefined => {
  const expiresAt = now + duration;
  return Number.isSafeInteger(expiresAt) && expiresAt > now
    ? instant(expiresAt)
    : undefined;
};

const unavailable = (): DomainResult<
  never,
  ResolveContactExportPolicyFailure
> =>
  fail({
    code: "contact-export-policy-unavailable",
    message:
      "The server has no current policy and provider-rights authorization for this Contact export.",
  });

/**
 * Creates a process-local resolver from operator-owned configuration. The
 * caller can select data only through the immutable dataset; purpose, TTL and
 * provider rights never come from the public export request.
 */
export const createContactExportPolicyResolver = (
  template: ContactExportPolicyTemplate
): ContactExportPolicyResolver => {
  if (!configurationIsValid(template)) {
    throw new TypeError(
      "Contact export policy configuration must be bounded, versioned, and provider-scoped."
    );
  }
  const exactTemplate = structuredClone(template);
  return ({ now, providerKeys, requestedData }) => {
    if (
      !Number.isSafeInteger(now) ||
      now < 0 ||
      providerKeys.length !== 1 ||
      new Set(providerKeys).size !== providerKeys.length ||
      requestedData.length === 0 ||
      new Set(requestedData.map((item) => item.dataClass)).size !==
        requestedData.length
    ) {
      return unavailable();
    }
    const providerKey = providerKeys[0];
    const rights =
      providerKey === undefined
        ? undefined
        : exactTemplate.providerRights[providerKey];
    if (rights === undefined) {
      return unavailable();
    }
    const policyExpiresAt = boundedExpiry(
      now,
      exactTemplate.policyTtlMilliseconds
    );
    const providerRightsExpiresAt = boundedExpiry(now, rights.ttlMilliseconds);
    if (
      policyExpiresAt === undefined ||
      providerRightsExpiresAt === undefined
    ) {
      return unavailable();
    }
    const rules: Partial<Record<ContactDataClass, ContactDataRule>> = {};
    for (const requested of requestedData) {
      const retention =
        exactTemplate.maxRetentionMilliseconds[requested.dataClass];
      if (retention === undefined) {
        return unavailable();
      }
      rules[requested.dataClass] = {
        allowedActions: ["export"],
        maxRetentionMilliseconds: retention,
      };
    }
    return succeed({
      privacy: {
        facts: {
          activeRestrictions: [],
          explicitlyEnabledDataClasses: [],
          purposeRef: exactTemplate.purposeRef,
          requestedData,
          territory: exactTemplate.territory,
        },
        policy: {
          expiresAt: policyExpiresAt,
          purposeRefs: [exactTemplate.purposeRef],
          rules,
          territories: [exactTemplate.territory],
          version: exactTemplate.policyVersion,
        },
      },
      providerRights: {
        authorized: true,
        expiresAt: providerRightsExpiresAt,
        mode: rights.mode,
        version: rights.version,
      },
    });
  };
};
