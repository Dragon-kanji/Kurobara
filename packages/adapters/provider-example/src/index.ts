import {
  definePluginAdapter,
  type PluginManifestV1,
  validatePluginJson,
} from "@kurobara/plugin-sdk";

const CATALOG_FINGERPRINT =
  "sha256:c3cb2220664b2b8a0357c2a51c2eb5db398994c746bf89fb23c83398703425f4";
const INPUT_SCHEMA_FINGERPRINT =
  "sha256:9c1fed09cc7cc924ac5e824ea07fcefc738fd78265075c7c37e5bd935b2c5d78";
const OUTPUT_SCHEMA_FINGERPRINT =
  "sha256:02f08ae5cb4775e420fcc1c4ce468943e497ef430da7e03d7be0b6a91e060d8e";
const CONFIGURATION_MODE = JSON.stringify({ mode: "echo" });

export const PROVIDER_EXAMPLE_LOOKUP_KEYS = Object.freeze({
  authoritativeAbsent: "synthetic:authoritative-absent",
  eventualNotFound: "synthetic:eventual-not-found",
  found: "synthetic:found",
  outcomeUnknown: "synthetic:outcome-unknown",
});

const manifest = {
  apiVersion: "dev.kurobara.plugin/v1",
  auth: { modes: ["none"] },
  capabilities: [
    {
      capabilityId: "fixture.echo",
      capabilityVersion: "1.0.0",
      inputContract: {
        catalogFingerprint: CATALOG_FINGERPRINT,
        catalogVersion: "0.12.0",
        schemaFingerprint: INPUT_SCHEMA_FINGERPRINT,
        schemaId:
          "https://schemas.kurobara.invalid/schemas/product/record/1.0.0",
        schemaVersion: "1.0.0",
      },
      outputContract: {
        catalogFingerprint: CATALOG_FINGERPRINT,
        catalogVersion: "0.12.0",
        schemaFingerprint: OUTPUT_SCHEMA_FINGERPRINT,
        schemaId:
          "https://schemas.kurobara.invalid/schemas/fixtures/deterministic-output/1.0.0",
        schemaVersion: "1.0.0",
      },
    },
  ],
  economics: {
    estimateGuarantee: "hard",
    unit: "requests",
    usageReporting: "exact",
  },
  execution: {
    idempotency: { keyScope: "operation", mode: "native-key" },
    lookup: { authoritativeNotFound: true, mode: "by-operation-key" },
    timeouts: { executeMs: 1000, lookupMs: 1000 },
  },
  id: "dev.kurobara.provider-example",
  permissions: { egress: { hosts: [], tlsRequired: true } },
  version: "1.0.0",
} as const satisfies PluginManifestV1;

const safeError = {
  class: "unknown",
  reasonCode: "unclassified",
} as const;

const unavailableUsage = {
  basis: "unavailable",
  unit: "requests",
} as const;

const exactUsage = {
  amount: 1,
  basis: "exact",
  receiptReference: "synthetic-receipt",
  unit: "requests",
} as const;

const proof = (proofReference: string, observedAtMs: number) => ({
  observedAtMs,
  proofReference,
});

export const providerExampleAdapter = definePluginAdapter({
  classifyError: () => ({ error: safeError }),
  describe: () => ({ manifest }),
  estimate: (request) => ({
    quote: {
      expiresAtMs: request.context.deadlineAtMs,
      guarantee: "hard",
      pricingVersion: "1.0.0",
      unit: "requests",
      upperBound: 1,
    },
    status: "quoted",
  }),
  execute: (request) =>
    request.costLimit.unit === "requests" &&
    request.costLimit.amount >= 1 &&
    request.quote.unit === request.costLimit.unit &&
    request.quote.guarantee === "hard" &&
    request.quote.upperBound <= request.costLimit.amount
      ? {
          externalOperationReference: "synthetic-operation-reference",
          providerPayload: {
            adapter: "deterministic-local",
            attempt_id: "synthetic-attempt",
            operation_key: request.operationKey,
            run_id: "synthetic-run",
            status: "succeeded",
            step_run_id: "synthetic-step-run",
          },
          status: "succeeded",
          usage: exactUsage,
        }
      : {
          error: { class: "quota", reasonCode: "quota-exhausted" },
          status: "failed",
          usage: unavailableUsage,
        },
  health: (request) => ({
    observedAtMs: request.context.deadlineAtMs,
    status: "healthy",
    validUntilMs: request.context.deadlineAtMs,
  }),
  lookup: (request) => {
    const observedAtMs = request.context.deadlineAtMs;
    if (request.operationKey === PROVIDER_EXAMPLE_LOOKUP_KEYS.found) {
      return {
        outcome: {
          externalOperationReference: "synthetic-operation-reference",
          providerPayload: {
            adapter: "deterministic-local",
            attempt_id: "synthetic-attempt",
            operation_key: request.operationKey,
            run_id: "synthetic-run",
            status: "succeeded",
            step_run_id: "synthetic-step-run",
          },
          status: "succeeded",
          usage: exactUsage,
        },
        proof: proof("synthetic-found-proof", observedAtMs),
        status: "found",
      };
    }
    if (
      request.operationKey === PROVIDER_EXAMPLE_LOOKUP_KEYS.eventualNotFound
    ) {
      return {
        proof: proof("synthetic-eventual-proof", observedAtMs),
        status: "eventual-not-found",
      };
    }
    if (
      request.operationKey === PROVIDER_EXAMPLE_LOOKUP_KEYS.authoritativeAbsent
    ) {
      return {
        proof: proof("synthetic-absent-proof", observedAtMs),
        status: "authoritative-absent",
      };
    }
    return { error: safeError, status: "outcome-unknown" };
  },
  normalize: (request) => {
    const output = validatePluginJson(request.providerPayload);
    return output.ok
      ? {
          normalizerVersion: "1.0.0",
          output: output.value,
          status: "normalized",
        }
      : {
          error: {
            class: "response",
            reasonCode: "provider-response-invalid",
          },
          status: "failed",
        };
  },
  validateConfig: (request) => {
    const configuration = validatePluginJson(request.configuration.value);
    return configuration.ok &&
      JSON.stringify(configuration.value) === CONFIGURATION_MODE
      ? {
          configurationFingerprint: request.configuration.contentHash,
          status: "valid",
        }
      : {
          reasonCodes: ["configuration-value-invalid"],
          status: "invalid",
        };
  },
});
