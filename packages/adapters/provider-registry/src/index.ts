import { type CapabilityRef, capabilityId } from "@kurobara/kernel";
import type { CapabilityRoute } from "@kurobara/ports";

/**
 * "Official" identifies adapters maintained in this repository. It does not
 * imply provider endorsement, contractual admission, or rights over provider
 * data or marks.
 */
export const OFFICIAL_PROVIDER_NAMES = Object.freeze([
  "prospeo",
  "apollo",
  "hunter",
  "tavily",
  "exa",
] as const);

export type OfficialProviderName = (typeof OFFICIAL_PROVIDER_NAMES)[number];
export type OfficialProviderId =
  | "apollo-people-enrichment"
  | "apollo-people-search"
  | "exa-search"
  | "hunter-discover"
  | "hunter-email-finder"
  | "hunter-email-finder-prospeo"
  | "hunter-email-verifier"
  | "hunter-email-verifier-prospeo"
  | "prospeo-email-enrichment"
  | "prospeo-person-enrichment"
  | "prospeo-person-search"
  | "tavily-search";

export type PdlContactDiscoveryRouteCandidate = CapabilityRoute &
  Readonly<{
    credentialEnvironmentVariable: "PDL_API_KEY";
    providerId: "pdl-contact-search";
    rightsAttestationEnvironmentVariable: "KUROBARA_PDL_DATA_RIGHTS_CONFIRMED";
  }>;

export type OfficialProviderRouteDescriptor = CapabilityRoute &
  Readonly<{
    credentialEnvironmentVariable:
      | "APOLLO_API_KEY"
      | "EXA_API_KEY"
      | "HUNTER_API_KEY"
      | "PROSPEO_API_KEY"
      | "TAVILY_API_KEY";
    providerId: OfficialProviderId;
  }>;

export type OfficialSelectedContactProviderRouteDescriptor =
  OfficialProviderRouteDescriptor &
    Readonly<{
      providerIdentityNamespace:
        | "apollo-people-search"
        | "prospeo-person-search";
    }>;

export type DeterministicFixtureRouteDescriptor = CapabilityRoute &
  Readonly<{
    effectAdapterKey: "deterministic-local";
    routeKey: "deterministic-local";
  }>;

export class ProviderRegistryConfigError extends Error {
  readonly name = "ProviderRegistryConfigError";
}

const WEBSITE_CAPABILITY = Object.freeze({
  capabilityId: capabilityId("organizations.website.resolve"),
  capabilityVersion: "1.0.0",
}) satisfies CapabilityRef;

const COMPANY_DISCOVERY_CAPABILITY = Object.freeze({
  capabilityId: capabilityId("organizations.discover"),
  capabilityVersion: "1.0.0",
}) satisfies CapabilityRef;

const CONTACT_DISCOVERY_CAPABILITY = Object.freeze({
  capabilityId: capabilityId("contacts.discover"),
  capabilityVersion: "1.0.0",
}) satisfies CapabilityRef;

const CONTACT_IDENTITY_CAPABILITY = Object.freeze({
  capabilityId: capabilityId("contacts.identity.reveal"),
  capabilityVersion: "1.0.0",
}) satisfies CapabilityRef;

const CONTACT_WORK_EMAIL_RESOLVE_CAPABILITY = Object.freeze({
  capabilityId: capabilityId("contacts.work-email.resolve"),
  capabilityVersion: "1.0.0",
}) satisfies CapabilityRef;

const CONTACT_WORK_EMAIL_VERIFY_CAPABILITY = Object.freeze({
  capabilityId: capabilityId("contacts.work-email.verify"),
  capabilityVersion: "1.0.0",
}) satisfies CapabilityRef;

const createDescriptor = (
  providerId: OfficialProviderId,
  credentialEnvironmentVariable: OfficialProviderRouteDescriptor["credentialEnvironmentVariable"],
  capability: CapabilityRef = WEBSITE_CAPABILITY
): OfficialProviderRouteDescriptor =>
  Object.freeze({
    capability,
    credentialEnvironmentVariable,
    effectAdapterKey: providerId,
    providerId,
    reservableUpperBound: 1,
    reservationUnit: "requests",
    routeKey: providerId,
  });

const DESCRIPTORS = Object.freeze({
  apollo: createDescriptor(
    "apollo-people-search",
    "APOLLO_API_KEY",
    CONTACT_DISCOVERY_CAPABILITY
  ),
  exa: createDescriptor("exa-search", "EXA_API_KEY"),
  hunter: createDescriptor(
    "hunter-discover",
    "HUNTER_API_KEY",
    COMPANY_DISCOVERY_CAPABILITY
  ),
  prospeo: createDescriptor(
    "prospeo-person-search",
    "PROSPEO_API_KEY",
    CONTACT_DISCOVERY_CAPABILITY
  ),
  tavily: createDescriptor("tavily-search", "TAVILY_API_KEY"),
}) satisfies Readonly<
  Record<OfficialProviderName, OfficialProviderRouteDescriptor>
>;

const DETERMINISTIC_FIXTURE_DESCRIPTOR = Object.freeze({
  capability: WEBSITE_CAPABILITY,
  effectAdapterKey: "deterministic-local",
  reservableUpperBound: 1,
  reservationUnit: "requests",
  routeKey: "deterministic-local",
}) satisfies DeterministicFixtureRouteDescriptor;

const SELECTED_CONTACT_DESCRIPTORS = Object.freeze([
  Object.freeze({
    ...createDescriptor(
      "prospeo-person-enrichment",
      "PROSPEO_API_KEY",
      CONTACT_IDENTITY_CAPABILITY
    ),
    providerIdentityNamespace: "prospeo-person-search",
  }),
  Object.freeze({
    ...createDescriptor(
      "prospeo-email-enrichment",
      "PROSPEO_API_KEY",
      CONTACT_WORK_EMAIL_RESOLVE_CAPABILITY
    ),
    providerIdentityNamespace: "prospeo-person-search",
  }),
  Object.freeze({
    ...createDescriptor(
      "hunter-email-finder-prospeo",
      "HUNTER_API_KEY",
      CONTACT_WORK_EMAIL_RESOLVE_CAPABILITY
    ),
    providerIdentityNamespace: "prospeo-person-search",
  }),
  Object.freeze({
    ...createDescriptor(
      "apollo-people-enrichment",
      "APOLLO_API_KEY",
      CONTACT_IDENTITY_CAPABILITY
    ),
    providerIdentityNamespace: "apollo-people-search",
  }),
  Object.freeze({
    ...createDescriptor(
      "hunter-email-finder",
      "HUNTER_API_KEY",
      CONTACT_WORK_EMAIL_RESOLVE_CAPABILITY
    ),
    providerIdentityNamespace: "apollo-people-search",
  }),
  Object.freeze({
    ...createDescriptor(
      "hunter-email-verifier",
      "HUNTER_API_KEY",
      CONTACT_WORK_EMAIL_VERIFY_CAPABILITY
    ),
    providerIdentityNamespace: "apollo-people-search",
  }),
  Object.freeze({
    ...createDescriptor(
      "hunter-email-verifier-prospeo",
      "HUNTER_API_KEY",
      CONTACT_WORK_EMAIL_VERIFY_CAPABILITY
    ),
    providerIdentityNamespace: "prospeo-person-search",
  }),
] as const) satisfies readonly OfficialSelectedContactProviderRouteDescriptor[];

const selectedContactRouteOwner = (
  descriptor: OfficialSelectedContactProviderRouteDescriptor
): Extract<OfficialProviderName, "apollo" | "hunter" | "prospeo"> => {
  if (descriptor.credentialEnvironmentVariable === "APOLLO_API_KEY") {
    return "apollo";
  }
  return descriptor.credentialEnvironmentVariable === "HUNTER_API_KEY"
    ? "hunter"
    : "prospeo";
};

const isOfficialProviderName = (
  candidate: string
): candidate is OfficialProviderName =>
  candidate === "prospeo" ||
  candidate === "apollo" ||
  candidate === "hunter" ||
  candidate === "tavily" ||
  candidate === "exa";

const parseProviderOrder = (
  rawValue: string | undefined
): readonly OfficialProviderName[] => {
  const value = rawValue ?? "prospeo,hunter";
  if (value.length === 0 || value.trim() !== value) {
    throw new ProviderRegistryConfigError(
      "KUROBARA_PROVIDER_ORDER must be a comma-separated list of configured adapter names without whitespace."
    );
  }
  const parsed: OfficialProviderName[] = [];
  for (const candidate of value.split(",")) {
    if (
      !isOfficialProviderName(candidate) ||
      parsed.includes(candidate) ||
      parsed.length >= OFFICIAL_PROVIDER_NAMES.length
    ) {
      throw new ProviderRegistryConfigError(
        "KUROBARA_PROVIDER_ORDER must contain unique configured adapter names."
      );
    }
    parsed.push(candidate);
  }
  return Object.freeze(parsed);
};

const PRIVACY_SECRET_VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;

export type ConfiguredContactPrivacyHmacSecret = Readonly<{
  current: boolean;
  keyMaterial: Uint8Array;
  version: string;
}>;

const validPrivacySecret = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length > 0 &&
  value.trim() === value &&
  new TextEncoder().encode(value).byteLength >= 32;

const configuredPrivacySecret = (
  current: boolean,
  secret: string,
  version: string
): ConfiguredContactPrivacyHmacSecret =>
  Object.freeze({
    current,
    keyMaterial: new TextEncoder().encode(secret),
    version,
  });

const parseLegacyContactPrivacySecret = (
  legacySecret: string | undefined,
  legacyVersion: string | undefined
): readonly ConfiguredContactPrivacyHmacSecret[] | undefined => {
  if (legacySecret === undefined) {
    if (legacyVersion !== undefined) {
      throw new ProviderRegistryConfigError(
        "KUROBARA_CONTACT_PRIVACY_HMAC_SECRET_VERSION requires KUROBARA_CONTACT_PRIVACY_HMAC_SECRET."
      );
    }
    return;
  }
  const version = legacyVersion ?? "v1";
  if (
    !(
      validPrivacySecret(legacySecret) &&
      PRIVACY_SECRET_VERSION_PATTERN.test(version)
    )
  ) {
    throw new ProviderRegistryConfigError(
      "The contact privacy HMAC secret configuration is invalid."
    );
  }
  return Object.freeze([configuredPrivacySecret(true, legacySecret, version)]);
};

const parseContactPrivacyKeyringDocument = (rawKeyring: string): unknown[] => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawKeyring);
  } catch {
    throw new ProviderRegistryConfigError(
      "KUROBARA_CONTACT_PRIVACY_HMAC_KEYRING_JSON must contain valid JSON."
    );
  }
  if (!Array.isArray(parsed) || parsed.length === 0 || parsed.length > 16) {
    throw new ProviderRegistryConfigError(
      "KUROBARA_CONTACT_PRIVACY_HMAC_KEYRING_JSON must contain between 1 and 16 keys."
    );
  }
  return parsed;
};

const parseContactPrivacyKeyringEntry = (
  candidate: unknown
): ConfiguredContactPrivacyHmacSecret => {
  if (
    typeof candidate !== "object" ||
    candidate === null ||
    Array.isArray(candidate) ||
    Object.keys(candidate).length !== 3 ||
    !Object.hasOwn(candidate, "current") ||
    !Object.hasOwn(candidate, "secret") ||
    !Object.hasOwn(candidate, "version")
  ) {
    throw new ProviderRegistryConfigError(
      "KUROBARA_CONTACT_PRIVACY_HMAC_KEYRING_JSON contains an invalid key."
    );
  }
  const key = candidate as Readonly<Record<string, unknown>>;
  if (
    typeof key.current !== "boolean" ||
    !validPrivacySecret(key.secret) ||
    typeof key.version !== "string" ||
    !PRIVACY_SECRET_VERSION_PATTERN.test(key.version)
  ) {
    throw new ProviderRegistryConfigError(
      "KUROBARA_CONTACT_PRIVACY_HMAC_KEYRING_JSON contains an invalid key."
    );
  }
  return configuredPrivacySecret(key.current, key.secret, key.version);
};

/**
 * Parses either the backwards-compatible single HMAC secret or an explicit
 * rotation keyring. Keeping prior versions available is what lets tombstones
 * remain effective after a process restart or a current-key rotation.
 */
export const parseConfiguredContactPrivacyHmacSecrets = (
  environment: Readonly<Record<string, string | undefined>>
): readonly ConfiguredContactPrivacyHmacSecret[] | undefined => {
  const rawKeyring = environment.KUROBARA_CONTACT_PRIVACY_HMAC_KEYRING_JSON;
  const legacySecret = environment.KUROBARA_CONTACT_PRIVACY_HMAC_SECRET;
  const legacyVersion =
    environment.KUROBARA_CONTACT_PRIVACY_HMAC_SECRET_VERSION;

  if (
    rawKeyring !== undefined &&
    (legacySecret !== undefined || legacyVersion !== undefined)
  ) {
    throw new ProviderRegistryConfigError(
      "Configure either KUROBARA_CONTACT_PRIVACY_HMAC_KEYRING_JSON or the legacy contact privacy HMAC variables, not both."
    );
  }
  if (rawKeyring === undefined) {
    return parseLegacyContactPrivacySecret(legacySecret, legacyVersion);
  }

  const secrets = parseContactPrivacyKeyringDocument(rawKeyring).map(
    parseContactPrivacyKeyringEntry
  );
  if (
    secrets.filter((secret) => secret.current).length !== 1 ||
    new Set(secrets.map((secret) => secret.version)).size !== secrets.length
  ) {
    throw new ProviderRegistryConfigError(
      "KUROBARA_CONTACT_PRIVACY_HMAC_KEYRING_JSON requires unique versions and exactly one current key."
    );
  }
  return Object.freeze(secrets);
};

const contactPrivacyGuardIsConfigured = (
  environment: Readonly<Record<string, string | undefined>>
): boolean =>
  parseConfiguredContactPrivacyHmacSecrets(environment) !== undefined;

const PDL_CONTACT_DISCOVERY_DESCRIPTOR = Object.freeze({
  capability: CONTACT_DISCOVERY_CAPABILITY,
  credentialEnvironmentVariable: "PDL_API_KEY",
  effectAdapterKey: "pdl-contact-search",
  providerId: "pdl-contact-search",
  reservableUpperBound: 12,
  reservationUnit: "records",
  rightsAttestationEnvironmentVariable: "KUROBARA_PDL_DATA_RIGHTS_CONFIRMED",
  routeKey: "pdl-contact-search",
}) satisfies PdlContactDiscoveryRouteCandidate;

const credentialIsConfigured = (
  environment: Readonly<Record<string, string | undefined>>,
  variableName:
    | OfficialProviderRouteDescriptor["credentialEnvironmentVariable"]
    | PdlContactDiscoveryRouteCandidate["credentialEnvironmentVariable"]
): boolean => {
  const value = environment[variableName];
  if (value === undefined || value.length === 0) {
    return false;
  }
  if (value.trim() !== value) {
    throw new ProviderRegistryConfigError(
      `${variableName} must not contain surrounding whitespace.`
    );
  }
  return true;
};

const rightsAttestationIsConfirmed = (
  environment: Readonly<Record<string, string | undefined>>,
  variableName:
    | "KUROBARA_EXA_DATA_RIGHTS_CONFIRMED"
    | "KUROBARA_PDL_DATA_RIGHTS_CONFIRMED"
): boolean => {
  const attestation = environment[variableName];
  if (
    attestation !== undefined &&
    attestation.length > 0 &&
    attestation !== "false" &&
    attestation !== "true"
  ) {
    throw new ProviderRegistryConfigError(
      `${variableName} must be exactly true or false when configured.`
    );
  }
  return attestation === "true";
};

/**
 * Builds the immutable, non-secret execution-route snapshot selected by the
 * current process configuration. This is a technical composition decision, not
 * evidence of provider rights. Exa additionally requires an exact operational
 * rights attestation; that boolean is fail-closed control, not proof of written
 * terms. Credential values are inspected only for strict presence and are never
 * retained in the returned descriptors.
 */
export const createConfiguredOfficialProviderRoutes = (
  environment: Readonly<Record<string, string | undefined>>
): readonly OfficialProviderRouteDescriptor[] => {
  const order = parseProviderOrder(environment.KUROBARA_PROVIDER_ORDER);
  const exaCredentialIsConfigured = credentialIsConfigured(
    environment,
    "EXA_API_KEY"
  );
  const exaRightsAreConfirmed = rightsAttestationIsConfirmed(
    environment,
    "KUROBARA_EXA_DATA_RIGHTS_CONFIRMED"
  );
  const configured = Object.freeze({
    apollo: credentialIsConfigured(environment, "APOLLO_API_KEY"),
    exa: exaCredentialIsConfigured && exaRightsAreConfirmed,
    hunter: credentialIsConfigured(environment, "HUNTER_API_KEY"),
    prospeo: credentialIsConfigured(environment, "PROSPEO_API_KEY"),
    tavily: credentialIsConfigured(environment, "TAVILY_API_KEY"),
  });
  return Object.freeze(
    order
      .filter((providerName) => configured[providerName])
      .map((providerName) => DESCRIPTORS[providerName])
  );
};

/**
 * Exposes one local, zero-network execution route only when an operator opts
 * into the exact deterministic fixture mode. It exists for quickstarts and
 * self-hosted acceptance tests, and must never be inferred from NODE_ENV or
 * provider credential state.
 */
export const createConfiguredDeterministicFixtureRoutes = (
  environment: Readonly<Record<string, string | undefined>>
): readonly DeterministicFixtureRouteDescriptor[] => {
  const fixtureMode = environment.KUROBARA_FIXTURE_MODE;
  if (fixtureMode === undefined) {
    return Object.freeze([]);
  }
  if (fixtureMode !== "deterministic") {
    throw new ProviderRegistryConfigError(
      "KUROBARA_FIXTURE_MODE must be exactly deterministic when configured."
    );
  }
  return Object.freeze([DETERMINISTIC_FIXTURE_DESCRIPTOR]);
};

/**
 * Selected-contact effects are separate routes even when they share a BYOK
 * credential with discovery. Keeping this list explicit prevents presence of a
 * Prospeo, Hunter, or Apollo key from silently widening an unrelated
 * capability.
 */
export const createConfiguredSelectedContactProviderRoutes = (
  environment: Readonly<Record<string, string | undefined>>
): readonly OfficialSelectedContactProviderRouteDescriptor[] => {
  if (!contactPrivacyGuardIsConfigured(environment)) {
    return Object.freeze([]);
  }
  const providerOrder = parseProviderOrder(environment.KUROBARA_PROVIDER_ORDER);
  const routeIsEnabled = (
    descriptor: OfficialSelectedContactProviderRouteDescriptor
  ): boolean => {
    const hunterIsEnabled = providerOrder.includes("hunter");
    const routeUsesHunter =
      descriptor.providerId === "hunter-email-finder" ||
      descriptor.providerId === "hunter-email-finder-prospeo" ||
      descriptor.providerId === "hunter-email-verifier" ||
      descriptor.providerId === "hunter-email-verifier-prospeo";
    if (descriptor.providerIdentityNamespace === "prospeo-person-search") {
      return (
        providerOrder.includes("prospeo") &&
        (!routeUsesHunter || hunterIsEnabled)
      );
    }
    return (
      providerOrder.includes("apollo") && (!routeUsesHunter || hunterIsEnabled)
    );
  };
  return Object.freeze(
    providerOrder.flatMap((providerName) =>
      SELECTED_CONTACT_DESCRIPTORS.filter(
        (descriptor) =>
          selectedContactRouteOwner(descriptor) === providerName &&
          routeIsEnabled(descriptor) &&
          credentialIsConfigured(
            environment,
            descriptor.credentialEnvironmentVariable
          )
      )
    )
  );
};

/**
 * Returns a non-secret PDL route candidate only after strict BYOK and operator
 * rights attestation checks. The boolean is an operational admission control,
 * not proof of contractual or legal rights. This candidate is intentionally
 * absent from createConfiguredOfficialProviderRoutes until a PDL runtime is
 * explicitly composed by the application.
 */
export const createConfiguredPdlContactDiscoveryRouteCandidate = (
  environment: Readonly<Record<string, string | undefined>>
): PdlContactDiscoveryRouteCandidate | undefined => {
  const configured = credentialIsConfigured(environment, "PDL_API_KEY");
  const rightsAreConfirmed = rightsAttestationIsConfirmed(
    environment,
    "KUROBARA_PDL_DATA_RIGHTS_CONFIRMED"
  );
  return configured && rightsAreConfirmed
    ? PDL_CONTACT_DISCOVERY_DESCRIPTOR
    : undefined;
};
