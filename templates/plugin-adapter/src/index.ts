import {
  definePluginAdapter,
  type PluginManifestV1,
  validatePluginJson,
} from "@kurobara/plugin-sdk";

const CATALOG_FINGERPRINT =
  "sha256:1466e9c9bff8bc3c3f3c5e330a5770cb57429cb03bd9a75cc0701c9a71c9744e";

export const pluginManifest = {
  apiVersion: "dev.kurobara.plugin/v1",
  auth: { modes: ["none"] },
  capabilities: [
    {
      capabilityId: "fixture.echo",
      capabilityVersion: "1.0.0",
      inputContract: {
        catalogFingerprint: CATALOG_FINGERPRINT,
        catalogVersion: "0.13.0",
        schemaFingerprint:
          "sha256:9c1fed09cc7cc924ac5e824ea07fcefc738fd78265075c7c37e5bd935b2c5d78",
        schemaId:
          "https://schemas.kurobara.invalid/schemas/product/record/1.0.0",
        schemaVersion: "1.0.0",
      },
      outputContract: {
        catalogFingerprint: CATALOG_FINGERPRINT,
        catalogVersion: "0.13.0",
        schemaFingerprint:
          "sha256:02f08ae5cb4775e420fcc1c4ce468943e497ef430da7e03d7be0b6a91e060d8e",
        schemaId:
          "https://schemas.kurobara.invalid/schemas/fixtures/deterministic-output/1.0.0",
        schemaVersion: "1.0.0",
      },
    },
  ],
  economics: {
    estimateGuarantee: "hard",
    unit: "credits",
    usageReporting: "exact",
  },
  execution: {
    idempotency: { keyScope: "operation", mode: "native-key" },
    lookup: { authoritativeNotFound: true, mode: "by-operation-key" },
    timeouts: { executeMs: 20_000, lookupMs: 20_000 },
  },
  id: "dev.kurobara.plugin-adapter-template",
  permissions: { egress: { hosts: [], tlsRequired: true } },
  version: "1.0.0",
} as const satisfies PluginManifestV1;

const exactUsage = {
  amount: 1,
  basis: "exact",
  receiptReference: "receipt:template:1",
  unit: "credits",
} as const;

const safeError = {
  class: "unknown",
  reasonCode: "unclassified",
} as const;

export const pluginAdapter = definePluginAdapter({
  classifyError: () => ({ error: safeError }),
  describe: () => ({ manifest: pluginManifest }),
  estimate: (request) => ({
    quote: {
      expiresAtMs: request.context.deadlineAtMs,
      guarantee: "hard",
      pricingVersion: "1.0.0",
      unit: "credits",
      upperBound: 1,
    },
    status: "quoted",
  }),
  execute: (request) => ({
    externalOperationReference: `external:${request.operationKey}`,
    providerPayload: {
      echo: request.input.value,
      operation_key: request.operationKey,
    },
    status: "succeeded",
    usage: exactUsage,
  }),
  health: (request) => ({
    observedAtMs: request.context.deadlineAtMs,
    status: "healthy",
    validUntilMs: request.context.deadlineAtMs,
  }),
  lookup: (request) => ({
    outcome: {
      externalOperationReference: `external:${request.operationKey}`,
      providerPayload: { operation_key: request.operationKey },
      status: "succeeded",
      usage: exactUsage,
    },
    proof: {
      observedAtMs: request.context.deadlineAtMs,
      proofReference: `proof:${request.operationKey}`,
    },
    status: "found",
  }),
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
  validateConfig: (request) => ({
    configurationFingerprint: request.configuration.contentHash,
    status: "valid",
  }),
});
