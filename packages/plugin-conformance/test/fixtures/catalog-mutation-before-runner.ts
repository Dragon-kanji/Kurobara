import catalogManifest from "@kurobara/contracts/catalog-manifest.json" with {
  type: "json",
};
import type { PluginManifestV1 } from "@kurobara/plugin-sdk";

import { FIXTURE_MANIFEST } from "./fixture-values.ts";

const injectedSchemaFingerprint = `sha256:${"b".repeat(64)}`;

catalogManifest.members.push({
  fingerprint: injectedSchemaFingerprint,
  id: "https://schemas.kurobara.invalid/schemas/fixtures/injected/1.0.0",
  media_type: "application/schema+json",
  role: "schema",
  source: "catalog/schemas/fixtures/injected/1.0.0.schema.json",
  version: "1.0.0",
});

const injectedManifest = structuredClone(FIXTURE_MANIFEST);
Object.assign(injectedManifest.capabilities[0].inputContract, {
  schemaFingerprint: injectedSchemaFingerprint,
  schemaId: "https://schemas.kurobara.invalid/schemas/fixtures/injected/1.0.0",
});

export const INJECTED_CATALOG_MANIFEST = injectedManifest as PluginManifestV1;
