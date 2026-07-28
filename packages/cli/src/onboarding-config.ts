import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  stat,
  unlink,
} from "node:fs/promises";
import path from "node:path";

import providerRegistry from "@kurobara/contracts/provider-registry.json" with {
  type: "json",
};

export const ONBOARDING_SCHEMA_VERSION = "1.0.0";
const LEGACY_SCHEMA_VERSION = "0.1.0";
const MAX_DOCUMENT_BYTES = 65_536;
const MAX_SECRET_BYTES = 16_384;
const SECRET_SERVICE = "dev.kurobara.cli";
const SECRET_KEY_PATTERN = /^(?:kurobara|apollo|exa|hunter|prospeo|tavily)$/u;
const TRAILING_NEWLINE_PATTERN = /\r?\n$/u;

export type SetupProfile = "local" | "remote";
export type Environment = Readonly<Record<string, string | undefined>>;

export type ProviderCatalogEntry = Readonly<{
  admission:
    | "candidate_rights_required"
    | "default"
    | "opt_in"
    | "rights_required";
  capabilities: readonly string[];
  cost_notice: string;
  credential_environment_variable: string;
  default_order: number | null;
  display_name: string;
  key: string;
  probe: "none";
  rights_attestation_environment_variable?: string;
  roles: readonly string[];
}>;

export const PROVIDER_CATALOG = Object.freeze(
  providerRegistry.providers as readonly ProviderCatalogEntry[]
);

export type SetupPlan = Readonly<{
  endpoint: string;
  fingerprint: string;
  profile: SetupProfile;
  provider_order: readonly string[];
  schema_version: typeof ONBOARDING_SCHEMA_VERSION;
  secret_references: Readonly<Record<string, string>>;
  steps: readonly ["write_config", "write_state", "verify_config"];
}>;

export type KurobaraConfiguration = Readonly<{
  endpoint: string;
  profile: SetupProfile;
  provider_order: readonly string[];
  schema_version: typeof ONBOARDING_SCHEMA_VERSION;
  secret_references: Readonly<Record<string, string>>;
}>;

export type SetupState = Readonly<{
  completed_steps: readonly string[];
  config_fingerprint: string;
  last_plan_fingerprint: string;
  schema_version: typeof ONBOARDING_SCHEMA_VERSION;
}>;

export type ConfigurationReadResult =
  | Readonly<{ kind: "missing" }>
  | Readonly<{ config: KurobaraConfiguration; kind: "current" }>
  | Readonly<{ config: KurobaraConfiguration; kind: "legacy" }>
  | Readonly<{ kind: "incompatible"; version: string }>;

export class OnboardingConfigError extends Error {
  readonly code:
    | "config-incompatible"
    | "config-invalid"
    | "config-permissions"
    | "config-unavailable"
    | "secret-backend";

  constructor(code: OnboardingConfigError["code"], message: string) {
    super(message);
    this.code = code;
    this.name = "OnboardingConfigError";
  }
}

const exactKeys = (
  value: Readonly<Record<string, unknown>>,
  expected: readonly string[]
): boolean => {
  const actual = Object.keys(value).sort();
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === [...expected].sort()[index])
  );
};

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isProfile = (value: unknown): value is SetupProfile =>
  value === "local" || value === "remote";

const providerKeysAreValid = (value: unknown): value is readonly string[] =>
  Array.isArray(value) &&
  value.length <= PROVIDER_CATALOG.length &&
  new Set(value).size === value.length &&
  value.every(
    (key) =>
      typeof key === "string" &&
      PROVIDER_CATALOG.some(
        (provider) =>
          provider.key === key &&
          provider.admission !== "candidate_rights_required"
      )
  );

const secretReferencesAreValid = (
  value: unknown
): value is Readonly<Record<string, string>> =>
  isRecord(value) &&
  Object.entries(value).every(
    ([key, reference]) =>
      SECRET_KEY_PATTERN.test(key) &&
      typeof reference === "string" &&
      reference === `secret:${key}`
  );

const endpointIsValid = (value: unknown): value is string => {
  if (typeof value !== "string" || value.length > 2048) {
    return false;
  }
  try {
    const parsed = new URL(value);
    return (
      (parsed.protocol === "http:" || parsed.protocol === "https:") &&
      parsed.username.length === 0 &&
      parsed.password.length === 0 &&
      parsed.hash.length === 0 &&
      parsed.search.length === 0
    );
  } catch {
    return false;
  }
};

const normalizeForFingerprint = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map(normalizeForFingerprint);
  }
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, normalizeForFingerprint(value[key])])
    );
  }
  return value;
};

export const documentFingerprint = (value: unknown): string =>
  `sha256:${createHash("sha256")
    .update(JSON.stringify(normalizeForFingerprint(value)), "utf8")
    .digest("hex")}`;

const secretReferencesFor = (
  profile: SetupProfile,
  providerOrder: readonly string[]
): Readonly<Record<string, string>> =>
  Object.freeze(
    Object.fromEntries([
      ["kurobara", "secret:kurobara"],
      ...(profile === "local"
        ? providerOrder.map((provider) => [provider, `secret:${provider}`])
        : []),
    ])
  );

export const createSetupPlan = (
  profile: SetupProfile,
  endpoint: string,
  providerOrder: readonly string[]
): SetupPlan => {
  if (!endpointIsValid(endpoint)) {
    throw new OnboardingConfigError(
      "config-invalid",
      "The Kurobara endpoint must be an HTTP(S) origin without credentials, query, or fragment."
    );
  }
  if (!providerKeysAreValid(providerOrder)) {
    throw new OnboardingConfigError(
      "config-invalid",
      "The provider order contains an unknown, duplicate, or unavailable provider."
    );
  }
  const base = {
    endpoint,
    profile,
    provider_order: [...providerOrder],
    schema_version: ONBOARDING_SCHEMA_VERSION,
    secret_references: secretReferencesFor(profile, providerOrder),
    steps: ["write_config", "write_state", "verify_config"] as const,
  } satisfies Omit<SetupPlan, "fingerprint">;
  return Object.freeze({
    ...base,
    fingerprint: documentFingerprint(base),
  });
};

export const parseSetupPlan = (value: unknown): SetupPlan => {
  if (
    !(
      isRecord(value) &&
      exactKeys(value, [
        "endpoint",
        "fingerprint",
        "profile",
        "provider_order",
        "schema_version",
        "secret_references",
        "steps",
      ])
    ) ||
    value.schema_version !== ONBOARDING_SCHEMA_VERSION ||
    !isProfile(value.profile) ||
    !endpointIsValid(value.endpoint) ||
    !providerKeysAreValid(value.provider_order) ||
    !secretReferencesAreValid(value.secret_references) ||
    !Array.isArray(value.steps) ||
    value.steps.join(",") !== "write_config,write_state,verify_config" ||
    typeof value.fingerprint !== "string"
  ) {
    throw new OnboardingConfigError(
      "config-invalid",
      "The setup plan does not match the supported onboarding contract."
    );
  }
  const expected = createSetupPlan(
    value.profile,
    value.endpoint,
    value.provider_order
  );
  if (
    value.fingerprint !== expected.fingerprint ||
    JSON.stringify(value.secret_references) !==
      JSON.stringify(expected.secret_references)
  ) {
    throw new OnboardingConfigError(
      "config-invalid",
      "The setup plan fingerprint or secret references were modified."
    );
  }
  return expected;
};

const parseCurrentConfiguration = (
  value: Readonly<Record<string, unknown>>
): KurobaraConfiguration | undefined => {
  if (
    !exactKeys(value, [
      "endpoint",
      "profile",
      "provider_order",
      "schema_version",
      "secret_references",
    ]) ||
    value.schema_version !== ONBOARDING_SCHEMA_VERSION ||
    !isProfile(value.profile) ||
    !endpointIsValid(value.endpoint) ||
    !providerKeysAreValid(value.provider_order) ||
    !secretReferencesAreValid(value.secret_references)
  ) {
    return;
  }
  return Object.freeze({
    endpoint: value.endpoint,
    profile: value.profile,
    provider_order: Object.freeze([...value.provider_order]),
    schema_version: ONBOARDING_SCHEMA_VERSION,
    secret_references: Object.freeze({ ...value.secret_references }),
  });
};

const parseLegacyConfiguration = (
  value: Readonly<Record<string, unknown>>
): KurobaraConfiguration | undefined => {
  if (
    !exactKeys(value, ["api_url", "profile", "providers", "schema_version"]) ||
    value.schema_version !== LEGACY_SCHEMA_VERSION ||
    !isProfile(value.profile) ||
    !endpointIsValid(value.api_url) ||
    !providerKeysAreValid(value.providers)
  ) {
    return;
  }
  return Object.freeze({
    endpoint: value.api_url,
    profile: value.profile,
    provider_order: Object.freeze([...value.providers]),
    schema_version: ONBOARDING_SCHEMA_VERSION,
    secret_references: secretReferencesFor(value.profile, value.providers),
  });
};

const configurationRoot = (environment: Environment): string => {
  const explicit = environment.KUROBARA_CONFIG_HOME;
  if (explicit !== undefined && explicit.length > 0) {
    return path.resolve(explicit);
  }
  const xdg = environment.XDG_CONFIG_HOME;
  if (xdg !== undefined && xdg.length > 0) {
    return path.resolve(xdg, "kurobara");
  }
  const home = environment.HOME;
  if (home === undefined || home.length === 0) {
    throw new OnboardingConfigError(
      "config-unavailable",
      "HOME, XDG_CONFIG_HOME, or KUROBARA_CONFIG_HOME is required."
    );
  }
  return path.resolve(home, ".config", "kurobara");
};

const dataRoot = (environment: Environment): string => {
  const explicit = environment.KUROBARA_DATA_HOME;
  if (explicit !== undefined && explicit.length > 0) {
    return path.resolve(explicit);
  }
  const xdg = environment.XDG_DATA_HOME;
  if (xdg !== undefined && xdg.length > 0) {
    return path.resolve(xdg, "kurobara");
  }
  const home = environment.HOME;
  if (home === undefined || home.length === 0) {
    throw new OnboardingConfigError(
      "config-unavailable",
      "HOME, XDG_DATA_HOME, or KUROBARA_DATA_HOME is required."
    );
  }
  return path.resolve(home, ".local", "share", "kurobara");
};

export const onboardingPaths = (
  environment: Environment
): Readonly<{
  config: string;
  configRoot: string;
  secretFile: string;
  state: string;
}> => {
  const configRootPath = configurationRoot(environment);
  return Object.freeze({
    config: path.join(configRootPath, "config.json"),
    configRoot: configRootPath,
    secretFile: path.join(dataRoot(environment), "secrets.json"),
    state: path.join(configRootPath, "setup-state.json"),
  });
};

const readBoundedDocument = async (filePath: string): Promise<unknown> => {
  let details: Awaited<ReturnType<typeof lstat>>;
  try {
    details = await lstat(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return;
    }
    throw new OnboardingConfigError(
      "config-unavailable",
      "A Kurobara configuration document is unavailable."
    );
  }
  if (
    !details.isFile() ||
    details.isSymbolicLink() ||
    details.size > MAX_DOCUMENT_BYTES
  ) {
    throw new OnboardingConfigError(
      "config-invalid",
      "A Kurobara configuration document must be a bounded regular file."
    );
  }
  try {
    return JSON.parse(await readFile(filePath, "utf8")) as unknown;
  } catch {
    throw new OnboardingConfigError(
      "config-invalid",
      "A Kurobara configuration document contains invalid JSON."
    );
  }
};

const atomicWrite = async (
  filePath: string,
  value: unknown,
  mode = 0o600
): Promise<void> => {
  const directory = path.dirname(filePath);
  await mkdir(directory, { mode: 0o700, recursive: true });
  await chmod(directory, 0o700);
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  const handle = await open(temporaryPath, "wx", mode);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporaryPath, filePath);
    await chmod(filePath, mode);
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
};

export const readConfiguration = async (
  environment: Environment
): Promise<ConfigurationReadResult> => {
  const candidate = await readBoundedDocument(
    onboardingPaths(environment).config
  );
  if (candidate === undefined) {
    return { kind: "missing" };
  }
  if (!isRecord(candidate) || typeof candidate.schema_version !== "string") {
    throw new OnboardingConfigError(
      "config-invalid",
      "The Kurobara configuration has no supported schema version."
    );
  }
  const current = parseCurrentConfiguration(candidate);
  if (current !== undefined) {
    return { config: current, kind: "current" };
  }
  const legacy = parseLegacyConfiguration(candidate);
  if (legacy !== undefined) {
    return { config: legacy, kind: "legacy" };
  }
  if (
    candidate.schema_version !== ONBOARDING_SCHEMA_VERSION &&
    candidate.schema_version !== LEGACY_SCHEMA_VERSION
  ) {
    return { kind: "incompatible", version: candidate.schema_version };
  }
  throw new OnboardingConfigError(
    "config-invalid",
    "The Kurobara configuration does not match its declared schema."
  );
};

export const readSetupState = async (
  environment: Environment
): Promise<SetupState | undefined> => {
  const candidate = await readBoundedDocument(
    onboardingPaths(environment).state
  );
  if (candidate === undefined) {
    return;
  }
  if (
    !(
      isRecord(candidate) &&
      exactKeys(candidate, [
        "completed_steps",
        "config_fingerprint",
        "last_plan_fingerprint",
        "schema_version",
      ])
    ) ||
    candidate.schema_version !== ONBOARDING_SCHEMA_VERSION ||
    !Array.isArray(candidate.completed_steps) ||
    !candidate.completed_steps.every((step) => typeof step === "string") ||
    typeof candidate.config_fingerprint !== "string" ||
    typeof candidate.last_plan_fingerprint !== "string"
  ) {
    throw new OnboardingConfigError(
      "config-invalid",
      "The setup state is incompatible or invalid."
    );
  }
  return Object.freeze({
    completed_steps: Object.freeze([...candidate.completed_steps]),
    config_fingerprint: candidate.config_fingerprint,
    last_plan_fingerprint: candidate.last_plan_fingerprint,
    schema_version: ONBOARDING_SCHEMA_VERSION,
  });
};

const configurationFromPlan = (plan: SetupPlan): KurobaraConfiguration =>
  Object.freeze({
    endpoint: plan.endpoint,
    profile: plan.profile,
    provider_order: Object.freeze([...plan.provider_order]),
    schema_version: ONBOARDING_SCHEMA_VERSION,
    secret_references: Object.freeze({ ...plan.secret_references }),
  });

export const applySetupPlan = async (
  environment: Environment,
  plan: SetupPlan
): Promise<Readonly<{ config: KurobaraConfiguration; state: SetupState }>> => {
  const config = configurationFromPlan(plan);
  const configFingerprint = documentFingerprint(config);
  const existing = await readConfiguration(environment);
  const existingState = await readSetupState(environment);
  if (
    existing.kind === "current" &&
    documentFingerprint(existing.config) === configFingerprint &&
    existingState?.last_plan_fingerprint === plan.fingerprint
  ) {
    return { config: existing.config, state: existingState };
  }
  const paths = onboardingPaths(environment);
  await atomicWrite(paths.config, config);
  const verified = await readConfiguration(environment);
  if (
    verified.kind !== "current" ||
    documentFingerprint(verified.config) !== configFingerprint
  ) {
    throw new OnboardingConfigError(
      "config-unavailable",
      "The written configuration could not be verified."
    );
  }
  const state = Object.freeze({
    completed_steps: Object.freeze([
      "detect",
      "plan",
      "confirm",
      "apply",
      "verify",
    ]),
    config_fingerprint: configFingerprint,
    last_plan_fingerprint: plan.fingerprint,
    schema_version: ONBOARDING_SCHEMA_VERSION,
  }) satisfies SetupState;
  await atomicWrite(paths.state, state);
  return { config, state };
};

export const migrateConfiguration = async (
  environment: Environment
): Promise<KurobaraConfiguration> => {
  const read = await readConfiguration(environment);
  if (read.kind === "current") {
    return read.config;
  }
  if (read.kind !== "legacy") {
    throw new OnboardingConfigError(
      read.kind === "incompatible" ? "config-incompatible" : "config-invalid",
      read.kind === "missing"
        ? "There is no configuration to migrate."
        : `Configuration schema ${read.version} is not supported.`
    );
  }
  const plan = createSetupPlan(
    read.config.profile,
    read.config.endpoint,
    read.config.provider_order
  );
  return (await applySetupPlan(environment, plan)).config;
};

export const readPlanFile = async (filePath: string): Promise<SetupPlan> => {
  const candidate = await readBoundedDocument(path.resolve(filePath));
  if (candidate === undefined) {
    throw new OnboardingConfigError(
      "config-unavailable",
      "The setup plan file is unavailable."
    );
  }
  return parseSetupPlan(candidate);
};

export const writePlanFile = async (
  filePath: string,
  plan: SetupPlan
): Promise<void> => atomicWrite(path.resolve(filePath), plan);

type SecretBackend = "file" | "keychain" | "secret-tool";

const executableOnPath = (
  executable: string,
  environment: Environment
): boolean => {
  const searchPath = environment.PATH;
  if (searchPath === undefined) {
    return false;
  }
  return searchPath
    .split(path.delimiter)
    .some((directory) => existsSync(path.join(directory, executable)));
};

export const selectSecretBackend = (
  environment: Environment,
  platform = process.platform
): SecretBackend => {
  const forced = environment.KUROBARA_SECRET_BACKEND;
  if (forced !== undefined) {
    if (
      forced !== "file" &&
      forced !== "keychain" &&
      forced !== "secret-tool"
    ) {
      throw new OnboardingConfigError(
        "secret-backend",
        "KUROBARA_SECRET_BACKEND must be file, keychain, or secret-tool."
      );
    }
    if (
      (forced === "keychain" && platform !== "darwin") ||
      (forced === "secret-tool" &&
        !executableOnPath("secret-tool", environment))
    ) {
      throw new OnboardingConfigError(
        "secret-backend",
        "The requested secret backend is unavailable."
      );
    }
    return forced;
  }
  if (platform === "darwin") {
    return "keychain";
  }
  return executableOnPath("secret-tool", environment) ? "secret-tool" : "file";
};

const runSecretProcess = async (
  executable: string,
  arguments_: readonly string[],
  input: string | undefined,
  environment: Environment
): Promise<Readonly<{ code: number; stdout: string }>> =>
  new Promise((resolve, reject) => {
    const child = spawn(executable, [...arguments_], {
      env: { ...process.env, ...environment },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout: Uint8Array[] = [];
    let outputBytes = 0;
    child.stdout.on("data", (chunk: Uint8Array) => {
      outputBytes += chunk.byteLength;
      if (outputBytes <= MAX_SECRET_BYTES) {
        stdout.push(chunk);
      }
    });
    child.stderr.on("data", () => undefined);
    child.once("error", reject);
    child.once("close", (code) =>
      resolve({
        code: code ?? 70,
        stdout: Buffer.concat(stdout).toString("utf8"),
      })
    );
    if (input === undefined) {
      child.stdin.end();
    } else {
      child.stdin.end(input);
    }
  });

const validateSecret = (key: string, value: string): void => {
  if (
    !SECRET_KEY_PATTERN.test(key) ||
    value.length === 0 ||
    Buffer.byteLength(value, "utf8") > MAX_SECRET_BYTES ||
    value.trim() !== value
  ) {
    throw new OnboardingConfigError(
      "secret-backend",
      "The secret name or value is invalid."
    );
  }
};

const readSecretFile = async (
  environment: Environment
): Promise<Record<string, string>> => {
  const secretFile = onboardingPaths(environment).secretFile;
  let details: Awaited<ReturnType<typeof stat>>;
  try {
    details = await stat(secretFile);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {};
    }
    throw new OnboardingConfigError(
      "secret-backend",
      "The private secret fallback is unavailable."
    );
  }
  if (!details.isFile() || details.mode % 64 !== 0) {
    throw new OnboardingConfigError(
      "config-permissions",
      "The private secret fallback must be a regular file with mode 0600."
    );
  }
  const candidate = await readBoundedDocument(secretFile);
  if (
    !isRecord(candidate) ||
    Object.entries(candidate).some(
      ([key, value]) =>
        !SECRET_KEY_PATTERN.test(key) || typeof value !== "string"
    )
  ) {
    throw new OnboardingConfigError(
      "secret-backend",
      "The private secret fallback is invalid."
    );
  }
  return { ...candidate } as Record<string, string>;
};

export class SecretStore {
  readonly backend: SecretBackend;
  readonly environment: Environment;

  constructor(environment: Environment, platform = process.platform) {
    this.environment = environment;
    this.backend = selectSecretBackend(environment, platform);
  }

  async delete(key: string): Promise<void> {
    if (!SECRET_KEY_PATTERN.test(key)) {
      throw new OnboardingConfigError(
        "secret-backend",
        "The secret name is invalid."
      );
    }
    if (this.backend === "file") {
      const secrets = await readSecretFile(this.environment);
      delete secrets[key];
      await atomicWrite(onboardingPaths(this.environment).secretFile, secrets);
      return;
    }
    const result =
      this.backend === "keychain"
        ? await runSecretProcess(
            "/usr/bin/security",
            ["delete-generic-password", "-a", key, "-s", SECRET_SERVICE],
            undefined,
            this.environment
          )
        : await runSecretProcess(
            "secret-tool",
            ["clear", "service", SECRET_SERVICE, "account", key],
            undefined,
            this.environment
          );
    if (result.code !== 0 && result.code !== 44) {
      throw new OnboardingConfigError(
        "secret-backend",
        "The secret backend refused deletion."
      );
    }
  }

  async get(key: string): Promise<string | undefined> {
    if (!SECRET_KEY_PATTERN.test(key)) {
      throw new OnboardingConfigError(
        "secret-backend",
        "The secret name is invalid."
      );
    }
    if (this.backend === "file") {
      return (await readSecretFile(this.environment))[key];
    }
    const result =
      this.backend === "keychain"
        ? await runSecretProcess(
            "/usr/bin/security",
            ["find-generic-password", "-a", key, "-s", SECRET_SERVICE, "-w"],
            undefined,
            this.environment
          )
        : await runSecretProcess(
            "secret-tool",
            ["lookup", "service", SECRET_SERVICE, "account", key],
            undefined,
            this.environment
          );
    if (result.code !== 0) {
      return;
    }
    const value = result.stdout.replace(TRAILING_NEWLINE_PATTERN, "");
    validateSecret(key, value);
    return value;
  }

  async has(key: string): Promise<boolean> {
    return (await this.get(key)) !== undefined;
  }

  async set(key: string, value: string): Promise<void> {
    validateSecret(key, value);
    if (this.backend === "file") {
      const secrets = await readSecretFile(this.environment);
      secrets[key] = value;
      await atomicWrite(onboardingPaths(this.environment).secretFile, secrets);
      return;
    }
    const result =
      this.backend === "keychain"
        ? await runSecretProcess(
            "/usr/bin/security",
            [
              "add-generic-password",
              "-U",
              "-a",
              key,
              "-s",
              SECRET_SERVICE,
              "-w",
            ],
            value,
            this.environment
          )
        : await runSecretProcess(
            "secret-tool",
            [
              "store",
              "--label",
              `Kurobara ${key}`,
              "service",
              SECRET_SERVICE,
              "account",
              key,
            ],
            value,
            this.environment
          );
    if (result.code !== 0) {
      throw new OnboardingConfigError(
        "secret-backend",
        "The secret backend refused the write."
      );
    }
  }
}
