import assert from "node:assert/strict";
import test from "node:test";

import {
  ApiConfigError,
  parseApiDatabaseUrl,
  parseApiProcessConfig,
  parseContactExportPolicyTemplate,
} from "../src/config.ts";

test("parses explicit API process configuration", () => {
  assert.deepEqual(
    parseApiProcessConfig({
      KUROBARA_ALLOW_NON_LOOPBACK: "true",
      KUROBARA_API_HOST: "0.0.0.0",
      KUROBARA_API_PORT: "8080",
      KUROBARA_DATABASE_MIGRATION_MODE: "verify",
      KUROBARA_MAX_AUTHORIZATION_HEADER_BYTES: "1024",
      KUROBARA_MAX_BODY_BYTES: "131072",
      KUROBARA_MAX_EXPORT_BYTES: "1073741824",
      KUROBARA_MAX_EXPORT_RECORD_BYTES: "8388608",
      KUROBARA_MAX_IMPORT_BYTES: "2147483648",
      KUROBARA_SHUTDOWN_TIMEOUT_MS: "2500",
      NODE_ENV: "production",
    }),
    {
      environment: "production",
      host: "0.0.0.0",
      maxAuthorizationHeaderBytes: 1024,
      maxBodyBytes: 131_072,
      maxExportBytes: 1_073_741_824,
      maxExportRecordBytes: 8_388_608,
      maxImportBytes: 2_147_483_648,
      migrationMode: "verify",
      port: 8080,
      shutdownTimeoutMs: 2500,
    }
  );
});

test("defaults to loopback and local migration application", () => {
  assert.deepEqual(parseApiProcessConfig({ NODE_ENV: "development" }), {
    environment: "development",
    host: "127.0.0.1",
    maxAuthorizationHeaderBytes: 512,
    maxBodyBytes: 65_536,
    maxExportBytes: 1_073_741_824,
    maxExportRecordBytes: 16_777_216,
    maxImportBytes: 1_073_741_824,
    migrationMode: "apply",
    port: 3000,
    shutdownTimeoutMs: 10_000,
  });
});

test("requires an explicit opt-in for non-loopback binding", () => {
  assert.throws(
    () => parseApiProcessConfig({ KUROBARA_API_HOST: "0.0.0.0" }),
    ApiConfigError
  );
});

test("accepts only an explicit PostgreSQL database URL", () => {
  assert.equal(
    parseApiDatabaseUrl({
      KUROBARA_DATABASE_URL:
        "postgres://synthetic-user@127.0.0.1:5432/kurobara",
    }),
    "postgres://synthetic-user@127.0.0.1:5432/kurobara"
  );
  assert.throws(
    () =>
      parseApiDatabaseUrl({ KUROBARA_DATABASE_URL: "https://example.invalid" }),
    ApiConfigError
  );
  assert.throws(() => parseApiDatabaseUrl({}), ApiConfigError);
});

test("rejects an invalid API port", () => {
  assert.throws(
    () => parseApiProcessConfig({ KUROBARA_API_PORT: "65536" }),
    ApiConfigError
  );
});

test("rejects export limits outside the supported bounds", () => {
  assert.throws(
    () =>
      parseApiProcessConfig({
        KUROBARA_MAX_EXPORT_BYTES: "1099511627777",
      }),
    ApiConfigError
  );
  assert.throws(
    () =>
      parseApiProcessConfig({
        KUROBARA_MAX_EXPORT_RECORD_BYTES: "16777217",
      }),
    ApiConfigError
  );
});

test("parses an explicit fail-closed Contact export policy", () => {
  assert.deepEqual(
    parseContactExportPolicyTemplate({
      KUROBARA_CONTACT_EXPORT_POLICY_JSON: JSON.stringify({
        max_retention_ms: {
          "contact-identity": 86_400_000,
          employment: 86_400_000,
          "professional-email": 43_200_000,
          "professional-social-profile": 86_400_000,
        },
        policy_ttl_ms: 3_600_000,
        policy_version: "operator-policy-v1",
        provider_rights: {
          prospeo: {
            mode: "operator-authorized-byok",
            ttl_ms: 3_600_000,
            version: "operator-prospeo-rights-v1",
          },
        },
        purpose_ref: "owner-controlled-business-research",
        territory: "ES",
      }),
    }),
    {
      maxRetentionMilliseconds: {
        "contact-identity": 86_400_000,
        employment: 86_400_000,
        "professional-email": 43_200_000,
        "professional-social-profile": 86_400_000,
      },
      policyTtlMilliseconds: 3_600_000,
      policyVersion: "operator-policy-v1",
      providerRights: {
        prospeo: {
          mode: "operator-authorized-byok",
          ttlMilliseconds: 3_600_000,
          version: "operator-prospeo-rights-v1",
        },
      },
      purposeRef: "owner-controlled-business-research",
      territory: "ES",
    }
  );
  assert.equal(parseContactExportPolicyTemplate({}), undefined);
});

test("rejects malformed or incomplete Contact export policies", () => {
  assert.throws(
    () =>
      parseContactExportPolicyTemplate({
        KUROBARA_CONTACT_EXPORT_POLICY_JSON: "{",
      }),
    ApiConfigError
  );
  assert.throws(
    () =>
      parseContactExportPolicyTemplate({
        KUROBARA_CONTACT_EXPORT_POLICY_JSON: JSON.stringify({
          max_retention_ms: {},
          policy_ttl_ms: 3_600_000,
          policy_version: "operator-policy-v1",
          provider_rights: {},
          purpose_ref: "owner-controlled-business-research",
          territory: "ES",
        }),
      }),
    ApiConfigError
  );
});
