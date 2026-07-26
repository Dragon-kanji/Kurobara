import {
  definePluginAdapter,
  type PluginManifestV1,
  validatePluginJson,
} from "@kurobara/plugin-sdk";

const hash = (character: string): string => `sha256:${character.repeat(64)}`;

const manifest = {
  apiVersion: "dev.kurobara.plugin/v1",
  auth: { modes: ["none"] },
  capabilities: [
    {
      capabilityId: "fixture.echo",
      capabilityVersion: "1.0.0",
      inputContract: {
        catalogFingerprint: hash("a"),
        catalogVersion: "0.6.0",
        schemaFingerprint: hash("b"),
        schemaId:
          "https://schemas.kurobara.invalid/schemas/fixtures/plugin-input/1.0.0",
        schemaVersion: "1.0.0",
      },
      outputContract: {
        catalogFingerprint: hash("a"),
        catalogVersion: "0.6.0",
        schemaFingerprint: hash("c"),
        schemaId:
          "https://schemas.kurobara.invalid/schemas/fixtures/plugin-output/1.0.0",
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
    timeouts: { executeMs: 1000, lookupMs: 1000 },
  },
  id: "dev.kurobara.external-plugin-fixture",
  permissions: { egress: { hosts: [], tlsRequired: true } },
  version: "1.0.0",
} as const satisfies PluginManifestV1;

const exactUsage = {
  amount: 1,
  basis: "exact",
  receiptReference: "receipt:external-fixture:1",
  unit: "credits",
} as const;

const safeError = {
  class: "unknown",
  reasonCode: "unclassified",
} as const;

export const externalPluginAdapter = definePluginAdapter({
  classifyError: () => ({ error: safeError }),
  describe: () => ({ manifest }),
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
