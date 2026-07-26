import type { PluginManifestV1 } from "@kurobara/plugin-sdk";

const hash = (character: string): string => `sha256:${character.repeat(64)}`;

export const FIXTURE_MANIFEST = Object.freeze({
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
          "https://schemas.kurobara.invalid/schemas/product/record/1.0.0",
        schemaVersion: "1.0.0",
      },
      outputContract: {
        catalogFingerprint: hash("a"),
        catalogVersion: "0.6.0",
        schemaFingerprint: hash("c"),
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
    timeouts: { executeMs: 100, lookupMs: 100 },
  },
  id: "dev.kurobara.plugin-host-fixture",
  permissions: { egress: { hosts: [], tlsRequired: true } },
  version: "1.0.0",
} as const satisfies PluginManifestV1);

export const FIXTURE_CONFIGURATION_HASH = hash("d");
export const FIXTURE_INPUT_HASH = hash("e");
