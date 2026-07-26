import type { ContactExportPolicyTemplate } from "@kurobara/application";

type ContactDataClass =
  keyof ContactExportPolicyTemplate["maxRetentionMilliseconds"];

export type ApiEnvironment = "development" | "production" | "test";

export type ApiProcessConfig = Readonly<{
  environment: ApiEnvironment;
  host: string;
  maxAuthorizationHeaderBytes: number;
  maxBodyBytes: number;
  maxExportBytes: number;
  maxExportRecordBytes: number;
  maxImportBytes: number;
  migrationMode: "apply" | "verify";
  port: number;
  shutdownTimeoutMs: number;
}>;

export class ApiConfigError extends Error {
  readonly name = "ApiConfigError";
}

const POSITIVE_INTEGER = /^[1-9]\d*$/;
const PROVIDER_KEY_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/u;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);
const CONTACT_DATA_CLASSES = new Set<ContactDataClass>([
  "contact-identity",
  "employment",
  "personal-email",
  "phone",
  "professional-email",
  "professional-social-profile",
]);

const parsePositiveInteger = (
  name: string,
  rawValue: string,
  maximum: number
): number => {
  if (!POSITIVE_INTEGER.test(rawValue)) {
    throw new ApiConfigError(`${name} must be a positive integer.`);
  }
  const value = Number(rawValue);
  if (!Number.isSafeInteger(value) || value > maximum) {
    throw new ApiConfigError(`${name} must be at most ${maximum}.`);
  }
  return value;
};

const parseEnvironment = (rawValue: string | undefined): ApiEnvironment => {
  const value = rawValue ?? "development";
  if (value === "development" || value === "production" || value === "test") {
    return value;
  }
  throw new ApiConfigError(
    "NODE_ENV must be one of development, production, or test."
  );
};

const parseBoolean = (name: string, rawValue: string | undefined): boolean => {
  if (rawValue === undefined || rawValue === "false") {
    return false;
  }
  if (rawValue === "true") {
    return true;
  }
  throw new ApiConfigError(`${name} must be true or false.`);
};

const parseMigrationMode = (
  rawValue: string | undefined,
  environment: ApiEnvironment
): "apply" | "verify" => {
  const value = rawValue ?? (environment === "production" ? "verify" : "apply");
  if (value === "apply" || value === "verify") {
    return value;
  }
  throw new ApiConfigError(
    "KUROBARA_DATABASE_MIGRATION_MODE must be apply or verify."
  );
};

export const parseApiProcessConfig = (
  environment: Readonly<Record<string, string | undefined>>
): ApiProcessConfig => {
  const parsedEnvironment = parseEnvironment(environment.NODE_ENV);
  const host = environment.KUROBARA_API_HOST ?? "127.0.0.1";
  if (host.trim() !== host || host.length === 0 || host.length > 255) {
    throw new ApiConfigError(
      "KUROBARA_API_HOST must be a non-empty host without surrounding whitespace."
    );
  }
  if (
    !(
      LOOPBACK_HOSTS.has(host) ||
      parseBoolean(
        "KUROBARA_ALLOW_NON_LOOPBACK",
        environment.KUROBARA_ALLOW_NON_LOOPBACK
      )
    )
  ) {
    throw new ApiConfigError(
      "KUROBARA_ALLOW_NON_LOOPBACK=true is required for a non-loopback API host."
    );
  }

  return {
    environment: parsedEnvironment,
    host,
    maxAuthorizationHeaderBytes: parsePositiveInteger(
      "KUROBARA_MAX_AUTHORIZATION_HEADER_BYTES",
      environment.KUROBARA_MAX_AUTHORIZATION_HEADER_BYTES ?? "512",
      4096
    ),
    maxBodyBytes: parsePositiveInteger(
      "KUROBARA_MAX_BODY_BYTES",
      environment.KUROBARA_MAX_BODY_BYTES ?? "65536",
      1_048_576
    ),
    maxExportBytes: parsePositiveInteger(
      "KUROBARA_MAX_EXPORT_BYTES",
      environment.KUROBARA_MAX_EXPORT_BYTES ?? "1073741824",
      1_099_511_627_776
    ),
    maxExportRecordBytes: parsePositiveInteger(
      "KUROBARA_MAX_EXPORT_RECORD_BYTES",
      environment.KUROBARA_MAX_EXPORT_RECORD_BYTES ?? "16777216",
      16_777_216
    ),
    maxImportBytes: parsePositiveInteger(
      "KUROBARA_MAX_IMPORT_BYTES",
      environment.KUROBARA_MAX_IMPORT_BYTES ?? "1073741824",
      1_099_511_627_776
    ),
    migrationMode: parseMigrationMode(
      environment.KUROBARA_DATABASE_MIGRATION_MODE,
      parsedEnvironment
    ),
    port: parsePositiveInteger(
      "KUROBARA_API_PORT",
      environment.KUROBARA_API_PORT ?? "3000",
      65_535
    ),
    shutdownTimeoutMs: parsePositiveInteger(
      "KUROBARA_SHUTDOWN_TIMEOUT_MS",
      environment.KUROBARA_SHUTDOWN_TIMEOUT_MS ?? "10000",
      120_000
    ),
  };
};

export const parseApiDatabaseUrl = (
  environment: Readonly<Record<string, string | undefined>>
): string => {
  const rawValue = environment.KUROBARA_DATABASE_URL;
  if (rawValue === undefined || rawValue.trim() !== rawValue) {
    throw new ApiConfigError(
      "KUROBARA_DATABASE_URL must be a configured PostgreSQL URL."
    );
  }
  try {
    const parsed = new URL(rawValue);
    if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
      throw new Error("unsupported protocol");
    }
  } catch {
    throw new ApiConfigError(
      "KUROBARA_DATABASE_URL must be a valid PostgreSQL URL."
    );
  }
  return rawValue;
};

type JsonObject = Readonly<Record<string, unknown>>;

const isJsonObject = (value: unknown): value is JsonObject =>
  typeof value === "object" &&
  value !== null &&
  !Array.isArray(value) &&
  (Object.getPrototypeOf(value) === Object.prototype ||
    Object.getPrototypeOf(value) === null);

const hasExactKeys = (
  value: JsonObject,
  expected: readonly string[]
): boolean =>
  Object.keys(value).length === expected.length &&
  expected.every((key) => Object.hasOwn(value, key));

const boundedString = (value: unknown, maximum: number): value is string =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= maximum &&
  value.trim() === value;

const positiveInteger = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) > 0;

const parseContactExportPolicyDocument = (
  value: unknown
): ContactExportPolicyTemplate => {
  if (
    !(
      isJsonObject(value) &&
      hasExactKeys(value, [
        "max_retention_ms",
        "policy_ttl_ms",
        "policy_version",
        "provider_rights",
        "purpose_ref",
        "territory",
      ]) &&
      boundedString(value.policy_version, 128) &&
      boundedString(value.purpose_ref, 255) &&
      boundedString(value.territory, 64) &&
      positiveInteger(value.policy_ttl_ms) &&
      isJsonObject(value.max_retention_ms) &&
      isJsonObject(value.provider_rights)
    )
  ) {
    throw new ApiConfigError(
      "KUROBARA_CONTACT_EXPORT_POLICY_JSON must be a bounded policy object."
    );
  }
  const maxRetentionMilliseconds: Partial<Record<ContactDataClass, number>> =
    {};
  for (const [dataClass, duration] of Object.entries(value.max_retention_ms)) {
    if (
      !(
        CONTACT_DATA_CLASSES.has(dataClass as ContactDataClass) &&
        positiveInteger(duration)
      )
    ) {
      throw new ApiConfigError(
        "KUROBARA_CONTACT_EXPORT_POLICY_JSON contains an invalid retention rule."
      );
    }
    maxRetentionMilliseconds[dataClass as ContactDataClass] = duration;
  }
  const providerRights: Record<
    string,
    ContactExportPolicyTemplate["providerRights"][string]
  > = {};
  for (const [providerKey, candidate] of Object.entries(
    value.provider_rights
  )) {
    if (
      !(
        PROVIDER_KEY_PATTERN.test(providerKey) &&
        isJsonObject(candidate) &&
        hasExactKeys(candidate, ["mode", "ttl_ms", "version"])
      ) ||
      (candidate.mode !== "operator-authorized-byok" &&
        candidate.mode !== "synthetic-fixture") ||
      !positiveInteger(candidate.ttl_ms) ||
      !boundedString(candidate.version, 128)
    ) {
      throw new ApiConfigError(
        "KUROBARA_CONTACT_EXPORT_POLICY_JSON contains invalid provider rights."
      );
    }
    providerRights[providerKey] = {
      mode: candidate.mode,
      ttlMilliseconds: candidate.ttl_ms,
      version: candidate.version,
    };
  }
  if (
    Object.keys(maxRetentionMilliseconds).length === 0 ||
    Object.keys(providerRights).length === 0
  ) {
    throw new ApiConfigError(
      "KUROBARA_CONTACT_EXPORT_POLICY_JSON requires retention and provider-rights entries."
    );
  }
  return {
    maxRetentionMilliseconds,
    policyTtlMilliseconds: value.policy_ttl_ms,
    policyVersion: value.policy_version,
    providerRights,
    purposeRef: value.purpose_ref,
    territory: value.territory,
  };
};

/**
 * Contact exports fail closed when this operator-owned policy is absent.
 * Parsing the optional document separately keeps generic dataset exports
 * available without inventing privacy or provider-rights assertions.
 */
export const parseContactExportPolicyTemplate = (
  environment: Readonly<Record<string, string | undefined>>
): ContactExportPolicyTemplate | undefined => {
  const raw = environment.KUROBARA_CONTACT_EXPORT_POLICY_JSON;
  if (raw === undefined) {
    return;
  }
  try {
    return parseContactExportPolicyDocument(JSON.parse(raw));
  } catch (error) {
    if (error instanceof ApiConfigError) {
      throw error;
    }
    throw new ApiConfigError(
      "KUROBARA_CONTACT_EXPORT_POLICY_JSON must contain valid JSON."
    );
  }
};
