import type {
  PluginManifestV1,
  PluginProtocolRequest,
} from "@kurobara/plugin-sdk";

const hash = (character: string): string => `sha256:${character.repeat(64)}`;

export const FIXTURE_CATALOG_FINGERPRINT =
  "sha256:c3cb2220664b2b8a0357c2a51c2eb5db398994c746bf89fb23c83398703425f4";
export const FIXTURE_OPERATION_KEY = "operation:conformance:exact";
const FIXTURE_RECORD_SCHEMA_FINGERPRINT =
  "sha256:9c1fed09cc7cc924ac5e824ea07fcefc738fd78265075c7c37e5bd935b2c5d78";
const FIXTURE_RECORD_SCHEMA_ID =
  "https://schemas.kurobara.invalid/schemas/product/record/1.0.0";

export const FIXTURE_RECORD_VALUE = Object.freeze({
  dataset_id: "dataset:conformance:synthetic",
  record_id: "record:conformance:synthetic",
  values: Object.freeze([
    Object.freeze({ field_id: "document", value: "synthetic" }),
  ]),
  workspace_id: "workspace:conformance:synthetic",
});

export const FIXTURE_MANIFEST = Object.freeze({
  apiVersion: "dev.kurobara.plugin/v1",
  auth: { modes: ["none"] },
  capabilities: [
    {
      capabilityId: "fixture.echo",
      capabilityVersion: "1.0.0",
      inputContract: {
        catalogFingerprint: FIXTURE_CATALOG_FINGERPRINT,
        catalogVersion: "0.12.0",
        schemaFingerprint: FIXTURE_RECORD_SCHEMA_FINGERPRINT,
        schemaId: FIXTURE_RECORD_SCHEMA_ID,
        schemaVersion: "1.0.0",
      },
      outputContract: {
        catalogFingerprint: FIXTURE_CATALOG_FINGERPRINT,
        catalogVersion: "0.12.0",
        schemaFingerprint: FIXTURE_RECORD_SCHEMA_FINGERPRINT,
        schemaId: FIXTURE_RECORD_SCHEMA_ID,
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
    timeouts: { executeMs: 5000, lookupMs: 5000 },
  },
  id: "dev.kurobara.conformance-fixture",
  permissions: { egress: { hosts: [], tlsRequired: true } },
  version: "1.0.0",
} as const satisfies PluginManifestV1);

export const FIXTURE_LOOKUP_ONLY_MANIFEST = Object.freeze({
  ...FIXTURE_MANIFEST,
  execution: {
    ...FIXTURE_MANIFEST.execution,
    idempotency: { keyScope: "operation", mode: "lookup-only" },
  },
} as const satisfies PluginManifestV1);

export const FIXTURE_EXTERNAL_ID_MANIFEST = Object.freeze({
  ...FIXTURE_MANIFEST,
  execution: {
    ...FIXTURE_MANIFEST.execution,
    lookup: {
      authoritativeNotFound: true,
      mode: "by-external-operation-id",
    },
  },
} as const satisfies PluginManifestV1);

export const FIXTURE_ONE_SHOT_MANIFEST = Object.freeze({
  ...FIXTURE_MANIFEST,
  execution: {
    ...FIXTURE_MANIFEST.execution,
    idempotency: { keyScope: "operation", mode: "none" },
    lookup: { authoritativeNotFound: false, mode: "none" },
  },
} as const satisfies PluginManifestV1);

export const FIXTURE_TIMEOUT_MANIFEST = Object.freeze({
  ...FIXTURE_MANIFEST,
  execution: {
    ...FIXTURE_MANIFEST.execution,
    timeouts: { executeMs: 500, lookupMs: 500 },
  },
} as const satisfies PluginManifestV1);

const configurationHash = hash("c");
const inputHash = hash("d");

const context = () => ({
  capability: {
    capabilityId: "fixture.echo",
    capabilityVersion: "1.0.0",
  },
  configuration: {
    contentHash: configurationHash,
    value: { mode: "synthetic" },
  },
  deadlineAtMs: Date.now() + 60_000,
});

export const fixtureRequests = (
  canary: string,
  operationKey = FIXTURE_OPERATION_KEY
) => {
  const inputValue = FIXTURE_RECORD_VALUE;
  const input = {
    contentHash: inputHash,
    contract: FIXTURE_MANIFEST.capabilities[0].inputContract,
    sizeBytes: new TextEncoder().encode(JSON.stringify(inputValue)).byteLength,
    value: inputValue,
  };
  const callContext = context();
  return Object.freeze({
    classifyError: {
      context: callContext,
      diagnostic: { kind: "provider-code", providerCode: canary },
      phase: "execute",
    } satisfies PluginProtocolRequest<"classifyError">,
    estimate: {
      context: callContext,
      input,
    } satisfies PluginProtocolRequest<"estimate">,
    execute: {
      context: callContext,
      costLimit: { amount: 1, unit: "credits" },
      input,
      operationKey,
      quote: {
        expiresAtMs: callContext.deadlineAtMs,
        guarantee: "hard",
        pricingVersion: "1.0.0",
        unit: "credits",
        upperBound: 1,
      },
    } satisfies PluginProtocolRequest<"execute">,
    health: { context: callContext } satisfies PluginProtocolRequest<"health">,
    lookup: {
      context: callContext,
      operationKey,
    } satisfies PluginProtocolRequest<"lookup">,
    normalize: {
      context: callContext,
      operationKey,
      outputContract: FIXTURE_MANIFEST.capabilities[0].outputContract,
      providerPayload: FIXTURE_RECORD_VALUE,
    } satisfies PluginProtocolRequest<"normalize">,
    validateConfig: {
      capability: callContext.capability,
      configuration: callContext.configuration,
    } satisfies PluginProtocolRequest<"validateConfig">,
  });
};

export interface FixtureEffectState {
  readonly executeInvocations?: number;
  readonly lookupInvocations?: number;
  readonly operationKeys: readonly string[];
}
