import { createDeterministicLeafEffect } from "@kurobara/adapter-effect-deterministic";
import { createTrustedPluginLeafEffect } from "@kurobara/adapter-effect-plugin";
import {
  createConfiguredOfficialProviderRoutes,
  createConfiguredSelectedContactProviderRoutes,
  type OfficialProviderId,
  type OfficialProviderRouteDescriptor,
  parseConfiguredContactPrivacyHmacSecrets,
} from "@kurobara/adapter-provider-registry";
import {
  createContactPrivacyTombstoneGuard,
  createHmacContactPrivacySubjectKeyDeriver,
} from "@kurobara/application";
import { createApolloProviderAdapter } from "@kurobara/provider-apollo";
import { createExaProviderAdapter } from "@kurobara/provider-exa";
import { createHunterProviderAdapter } from "@kurobara/provider-hunter";
import { createProspeoProviderAdapter } from "@kurobara/provider-prospeo";
import { createTavilyProviderAdapter } from "@kurobara/provider-tavily";

import type { LeafEffectAdapter } from "./config.ts";
import {
  createConfiguredProviderOutputValidator,
  datasetGenerationPageInputContract,
  datasetGenerationPageOutputContract,
} from "./configured-provider-output.ts";
import { createDeterministicOutputValidator } from "./deterministic-output.ts";
import { recipeCellInputContract } from "./recipe-cell-input.ts";
import {
  createRecipeCellOutputValidator,
  recipeCellOutputContract,
} from "./recipe-cell-output.ts";

const EMPTY_CONFIGURATION_HASH =
  "sha256:44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a";
const PROVIDER_EFFECT_DEADLINE_MS = 10_000;
const CONTACT_CURSOR_PATTERN = /^contact:([1-9]\d*)$/u;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+$/u;
const PROVIDER_SUBJECT_PATTERN = /^[A-Za-z0-9_-]{1,160}$/u;

type SelectedContactProviderId = Extract<
  OfficialProviderId,
  | "apollo-people-enrichment"
  | "hunter-email-finder"
  | "hunter-email-finder-prospeo"
  | "hunter-email-verifier"
  | "hunter-email-verifier-prospeo"
  | "prospeo-email-enrichment"
  | "prospeo-person-enrichment"
>;
type ContactPrivacyGuardPort = ReturnType<
  typeof createContactPrivacyTombstoneGuard
>;
type ContactPrivacyPersistencePort = Parameters<
  typeof createContactPrivacyTombstoneGuard
>[0]["persistence"];
type ContactPrivacySubject = Parameters<
  ContactPrivacyGuardPort["allows"]
>[1][number];
type BeforePluginExecute = NonNullable<
  Parameters<typeof createTrustedPluginLeafEffect>[0]["beforeExecute"]
>;
type LeafEffectRequest = Parameters<BeforePluginExecute>[0];
type LeafEffectFinalOutcome = Exclude<
  Awaited<ReturnType<BeforePluginExecute>>,
  undefined
>;

export type ConfiguredLeafEffectRuntime = Readonly<{
  effects: readonly (
    | Awaited<ReturnType<typeof createTrustedPluginLeafEffect>>
    | ReturnType<typeof createDeterministicLeafEffect>["port"]
  )[];
  outputValidator:
    | ReturnType<typeof createConfiguredProviderOutputValidator>
    | ReturnType<typeof createDeterministicOutputValidator>;
}>;

export class WorkerProviderConfigurationError extends Error {
  readonly name = "WorkerProviderConfigurationError";

  constructor() {
    super(
      "Configured providers require at least one valid provider credential."
    );
  }
}

export class WorkerContactPrivacyConfigurationError extends Error {
  readonly name = "WorkerContactPrivacyConfigurationError";

  constructor() {
    super(
      "Selected-contact providers require the configured contact privacy runtime."
    );
  }
}

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isSelectedContactProvider = (
  providerId: OfficialProviderId
): providerId is SelectedContactProviderId =>
  providerId === "apollo-people-enrichment" ||
  providerId === "hunter-email-finder" ||
  providerId === "hunter-email-finder-prospeo" ||
  providerId === "hunter-email-verifier" ||
  providerId === "hunter-email-verifier-prospeo" ||
  providerId === "prospeo-email-enrichment" ||
  providerId === "prospeo-person-enrichment";

const isIdentityProvider = (providerId: SelectedContactProviderId): boolean =>
  providerId === "apollo-people-enrichment" ||
  providerId === "prospeo-person-enrichment";

const isWorkEmailResolveProvider = (
  providerId: SelectedContactProviderId
): boolean =>
  providerId === "hunter-email-finder" ||
  providerId === "hunter-email-finder-prospeo" ||
  providerId === "prospeo-email-enrichment";

const isWorkEmailVerifyProvider = (
  providerId: SelectedContactProviderId
): boolean =>
  providerId === "hunter-email-verifier" ||
  providerId === "hunter-email-verifier-prospeo";

const providerIdentityNamespaceFor = (
  providerId: SelectedContactProviderId
): "apollo-people-search" | "prospeo-person-search" =>
  providerId === "prospeo-person-enrichment" ||
  providerId === "prospeo-email-enrichment" ||
  providerId === "hunter-email-finder-prospeo" ||
  providerId === "hunter-email-verifier-prospeo"
    ? "prospeo-person-search"
    : "apollo-people-search";

const expectedCapabilityId = (
  providerId: SelectedContactProviderId
): string => {
  if (isIdentityProvider(providerId)) {
    return "contacts.identity.reveal";
  }
  if (isWorkEmailResolveProvider(providerId)) {
    return "contacts.work-email.resolve";
  }
  return "contacts.work-email.verify";
};

const selectedContactIndexFor = (inputCursor: unknown): number => {
  if (inputCursor === null) {
    return 0;
  }
  if (typeof inputCursor !== "string") {
    return Number.NaN;
  }
  return Number(CONTACT_CURSOR_PATTERN.exec(inputCursor)?.[1]);
};

const selectedContactFor = (
  request: LeafEffectRequest,
  providerId: SelectedContactProviderId
): Readonly<Record<string, unknown>> | undefined => {
  const value = request.runInput?.value;
  if (
    !isRecord(value) ||
    value.workspaceId !== request.workspaceId ||
    !isRecord(value.capability) ||
    value.capability.capabilityId !== expectedCapabilityId(providerId) ||
    value.capability.capabilityVersion !== "1.0.0" ||
    !Number.isSafeInteger(value.pageSequence) ||
    (value.pageSequence as number) < 1 ||
    !isRecord(value.normalizedQuery)
  ) {
    return;
  }
  const query = value.normalizedQuery;
  const operationMatches = isIdentityProvider(providerId)
    ? query.result_kind === "contact_identity"
    : query.result_kind === "contact_work_email" &&
      query.operation_kind ===
        (isWorkEmailResolveProvider(providerId) ? "resolve" : "verify");
  if (
    !(operationMatches && Array.isArray(query.selected_contacts)) ||
    query.selected_contacts.length < 1 ||
    query.selected_contacts.length > 3
  ) {
    return;
  }
  const pageSequence = value.pageSequence as number;
  const cursorIndex = selectedContactIndexFor(value.inputCursor);
  if (!Number.isSafeInteger(cursorIndex) || cursorIndex !== pageSequence - 1) {
    return;
  }
  const selected = query.selected_contacts[cursorIndex];
  return isRecord(selected) ? selected : undefined;
};

const privacySubjectsFor = (
  request: LeafEffectRequest,
  providerId: SelectedContactProviderId
): readonly ContactPrivacySubject[] | undefined => {
  const selected = selectedContactFor(request, providerId);
  if (!isRecord(selected?.provider_identity)) {
    return;
  }
  const providerIdentity = selected.provider_identity;
  const providerIdentityNamespace = providerIdentityNamespaceFor(providerId);
  if (
    providerIdentity.provider_key !== providerIdentityNamespace ||
    typeof providerIdentity.provider_subject_id !== "string" ||
    !PROVIDER_SUBJECT_PATTERN.test(providerIdentity.provider_subject_id)
  ) {
    return;
  }
  const providerSubject = Object.freeze({
    kind: "provider-subject" as const,
    providerKey: providerIdentityNamespace,
    value: providerIdentity.provider_subject_id,
  });
  if (!isWorkEmailVerifyProvider(providerId)) {
    return Object.freeze([providerSubject]);
  }
  if (!isRecord(selected.work_email)) {
    return;
  }
  const email = selected.work_email.email;
  if (
    typeof email !== "string" ||
    email.trim() !== email ||
    email.length > 320 ||
    !EMAIL_PATTERN.test(email) ||
    email.split("@").length !== 2
  ) {
    return;
  }
  return Object.freeze([
    providerSubject,
    Object.freeze({ kind: "email" as const, value: email }),
  ]);
};

const privacyFailure = (reason: string) =>
  Object.freeze({
    reason,
    retryable: false,
    settlement: Object.freeze({ kind: "release" as const }),
    status: "failed" as const,
  });

export const authorizeSelectedContactEffect = async (
  request: LeafEffectRequest,
  providerId: SelectedContactProviderId,
  privacy: ContactPrivacyGuardPort
): Promise<LeafEffectFinalOutcome | undefined> => {
  const subjects = privacySubjectsFor(request, providerId);
  if (subjects === undefined) {
    return privacyFailure("contact-privacy-input-invalid");
  }
  let allowed = false;
  try {
    allowed = await privacy.allows(
      { workspaceId: request.workspaceId },
      subjects
    );
  } catch {
    allowed = false;
  }
  return allowed ? undefined : privacyFailure("contact-privacy-denied");
};

const credentialFor = (
  environment: Readonly<Record<string, string | undefined>>,
  route: OfficialProviderRouteDescriptor
): string => {
  const credential = environment[route.credentialEnvironmentVariable];
  if (credential === undefined || credential.length === 0) {
    throw new WorkerProviderConfigurationError();
  }
  return credential;
};

const adapterFor = (
  route: OfficialProviderRouteDescriptor,
  apiKey: string,
  now: () => number
) => {
  if (
    route.providerId === "apollo-people-search" ||
    route.providerId === "apollo-people-enrichment"
  ) {
    return createApolloProviderAdapter({ apiKey, clock: { now } });
  }
  if (route.providerId === "tavily-search") {
    return createTavilyProviderAdapter({ apiKey, clock: { now } });
  }
  if (
    route.providerId === "hunter-discover" ||
    route.providerId === "hunter-email-finder" ||
    route.providerId === "hunter-email-finder-prospeo" ||
    route.providerId === "hunter-email-verifier" ||
    route.providerId === "hunter-email-verifier-prospeo"
  ) {
    return createHunterProviderAdapter({ apiKey, clock: { now } });
  }
  if (
    route.providerId === "prospeo-person-search" ||
    route.providerId === "prospeo-person-enrichment" ||
    route.providerId === "prospeo-email-enrichment"
  ) {
    return createProspeoProviderAdapter({ apiKey, clock: { now } });
  }
  return createExaProviderAdapter({ apiKey, clock: { now } });
};

const contractsFor = (route: OfficialProviderRouteDescriptor) =>
  route.providerId === "hunter-discover" ||
  route.providerId === "hunter-email-finder" ||
  route.providerId === "hunter-email-finder-prospeo" ||
  route.providerId === "hunter-email-verifier" ||
  route.providerId === "hunter-email-verifier-prospeo" ||
  route.providerId === "prospeo-person-search" ||
  route.providerId === "prospeo-person-enrichment" ||
  route.providerId === "prospeo-email-enrichment" ||
  route.providerId === "apollo-people-search" ||
  route.providerId === "apollo-people-enrichment"
    ? Object.freeze({
        input: datasetGenerationPageInputContract,
        output: datasetGenerationPageOutputContract,
      })
    : Object.freeze({
        input: recipeCellInputContract,
        output: recipeCellOutputContract,
      });

const configuredContactPrivacyGuard = (
  environment: Readonly<Record<string, string | undefined>>,
  persistence: ContactPrivacyPersistencePort | undefined
): ContactPrivacyGuardPort => {
  const secrets = parseConfiguredContactPrivacyHmacSecrets(environment);
  if (secrets === undefined || persistence === undefined) {
    throw new WorkerContactPrivacyConfigurationError();
  }
  return createContactPrivacyTombstoneGuard({
    persistence,
    subjectKeys: createHmacContactPrivacySubjectKeyDeriver(secrets),
  });
};

const configuredProviderEffects = async (
  environment: Readonly<Record<string, string | undefined>>,
  now: () => number,
  contactPrivacy: ContactPrivacyPersistencePort | undefined
): Promise<ConfiguredLeafEffectRuntime> => {
  const officialRoutes = createConfiguredOfficialProviderRoutes(environment);
  const selectedContactRoutes =
    createConfiguredSelectedContactProviderRoutes(environment);
  const routes = [...officialRoutes, ...selectedContactRoutes];
  if (routes.length === 0) {
    throw new WorkerProviderConfigurationError();
  }
  const privacy =
    selectedContactRoutes.length === 0
      ? undefined
      : configuredContactPrivacyGuard(environment, contactPrivacy);
  const effects: Awaited<ReturnType<typeof createTrustedPluginLeafEffect>>[] =
    [];
  for (const route of routes) {
    const adapter = adapterFor(route, credentialFor(environment, route), now);
    const contracts = contractsFor(route);
    const selectedProviderId = isSelectedContactProvider(route.providerId)
      ? route.providerId
      : undefined;
    const effect = await createTrustedPluginLeafEffect({
      adapter,
      adapterKey: route.effectAdapterKey,
      ...(selectedProviderId === undefined || privacy === undefined
        ? {}
        : {
            beforeExecute: (request: LeafEffectRequest) =>
              authorizeSelectedContactEffect(
                request,
                selectedProviderId,
                privacy
              ),
          }),
      capability: route.capability,
      clock: now,
      configuration: {
        contentHash: EMPTY_CONFIGURATION_HASH,
        value: {},
      },
      deadlineAtMs: () => now() + PROVIDER_EFFECT_DEADLINE_MS,
      inputContract: contracts.input,
      outputContract: contracts.output,
    });
    effects.push(effect);
  }
  return Object.freeze({
    effects: Object.freeze(effects),
    outputValidator: createConfiguredProviderOutputValidator(),
  });
};

export const createConfiguredLeafEffectRuntime = async (options: {
  readonly adapterMode: LeafEffectAdapter;
  readonly contactPrivacy?: ContactPrivacyPersistencePort;
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly now?: () => number;
}): Promise<ConfiguredLeafEffectRuntime> => {
  if (options.adapterMode === "configured-providers") {
    return await configuredProviderEffects(
      options.environment,
      options.now ?? Date.now,
      options.contactPrivacy
    );
  }
  const effect = createDeterministicLeafEffect({
    outputFor: (request) => {
      const contract = request.runInput?.contract;
      if (
        contract?.catalogFingerprint !==
          recipeCellInputContract.catalogFingerprint ||
        contract.catalogVersion !== recipeCellInputContract.catalogVersion ||
        contract.schemaFingerprint !==
          recipeCellInputContract.schemaFingerprint ||
        contract.schemaId !== recipeCellInputContract.schemaId ||
        contract.schemaVersion !== recipeCellInputContract.schemaVersion
      ) {
        return;
      }
      const value = request.runInput?.value;
      const recordId =
        isRecord(value) && typeof value.recordId === "string"
          ? value.recordId
          : "record";
      return {
        value: `https://fixture.invalid/${encodeURIComponent(recordId)}`,
      };
    },
  });
  const deterministicValidator = createDeterministicOutputValidator();
  const recipeCellValidator = createRecipeCellOutputValidator();
  return Object.freeze({
    effects: Object.freeze([effect.port]),
    outputValidator: Object.freeze({
      validate: async (
        input: Parameters<typeof deterministicValidator.validate>[0]
      ) => {
        const deterministic = await deterministicValidator.validate(input);
        return deterministic.status === "accepted" ||
          deterministic.reason !== "output-contract-not-registered"
          ? deterministic
          : recipeCellValidator.validate(input);
      },
    }),
  });
};
