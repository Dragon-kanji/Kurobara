import type { PluginManifest } from "@kurobara/contracts";
import pluginManifestSchema from "@kurobara/contracts/schemas/plugin-manifest.json" with {
  type: "json",
};
import Ajv2020, { type ErrorObject } from "ajv/dist/2020.js";

import { validatePluginJson } from "./json.ts";

export const PLUGIN_MANIFEST_API_VERSION = "dev.kurobara.plugin/v1" as const;

export type PluginManifestV1 = PluginManifest;
export type PluginCapability = PluginManifestV1["capabilities"][number];
export type PluginContractRef = PluginCapability["inputContract"];
export type PluginAuthMode = PluginManifestV1["auth"]["modes"][number];

export const PLUGIN_MANIFEST_VALIDATION_REASON_CODES = [
  "plugin-api-version-unsupported",
  "plugin-manifest-unknown-field",
  "plugin-capability-duplicate",
  "plugin-auth-mode-duplicate",
  "plugin-auth-mode-conflict",
  "plugin-egress-host-duplicate",
  "plugin-egress-host-dangerous",
  "plugin-recovery-contract-unsafe",
  "plugin-manifest-schema-invalid",
] as const;

export type PluginManifestValidationReasonCode =
  (typeof PLUGIN_MANIFEST_VALIDATION_REASON_CODES)[number];

export type PluginManifestValidationResult =
  | Readonly<{
      manifest: PluginManifestV1;
      ok: true;
      validatorVersion: string;
    }>
  | Readonly<{
      ok: false;
      reasonCodes: readonly PluginManifestValidationReasonCode[];
      validatorVersion: string;
    }>;

export const PLUGIN_MANIFEST_VALIDATOR_VERSION =
  "ajv-8.20.0-kurobara-plugin-manifest-v1";

const IPV4_ADDRESS = /^\d+(?:\.\d+){3}$/u;

const ajv = new Ajv2020({
  allErrors: true,
  strict: true,
  validateFormats: false,
});

for (const keyword of [
  "x-kurobara-data-classification",
  "x-kurobara-owner",
  "x-kurobara-publication-status",
  "x-kurobara-schema-version",
]) {
  ajv.addKeyword({ keyword, schemaType: "string", valid: true });
}

const validateSchema = ajv.compile<PluginManifestV1>(pluginManifestSchema);

const schemaReasonCode = (
  error: ErrorObject
): PluginManifestValidationReasonCode => {
  if (error.instancePath === "/apiVersion" && error.keyword === "const") {
    return "plugin-api-version-unsupported";
  }
  if (error.keyword === "additionalProperties") {
    return "plugin-manifest-unknown-field";
  }
  if (error.keyword === "uniqueItems") {
    if (error.instancePath === "/capabilities") {
      return "plugin-capability-duplicate";
    }
    if (error.instancePath === "/auth/modes") {
      return "plugin-auth-mode-duplicate";
    }
    if (error.instancePath === "/permissions/egress/hosts") {
      return "plugin-egress-host-duplicate";
    }
  }
  if (error.instancePath.startsWith("/permissions/egress/hosts/")) {
    return "plugin-egress-host-dangerous";
  }
  return "plugin-manifest-schema-invalid";
};

const stableReasonCodes = (
  codes: Iterable<PluginManifestValidationReasonCode>
): readonly PluginManifestValidationReasonCode[] => {
  const selected = new Set(codes);
  return PLUGIN_MANIFEST_VALIDATION_REASON_CODES.filter((code) =>
    selected.has(code)
  );
};

const duplicateCapability = (manifest: PluginManifestV1): boolean => {
  const identities = manifest.capabilities.map(
    (capability) =>
      `${capability.capabilityId}\u0000${capability.capabilityVersion}`
  );
  return new Set(identities).size !== identities.length;
};

const dangerousEgressHost = (host: string): boolean => {
  const normalized = host.toLowerCase();
  return (
    normalized !== host ||
    normalized === "localhost" ||
    normalized.endsWith(".localhost") ||
    normalized.endsWith(".local") ||
    normalized.endsWith(".internal") ||
    normalized.endsWith(".home") ||
    normalized.endsWith(".lan") ||
    normalized.includes("*") ||
    normalized.includes(":") ||
    normalized.includes("/") ||
    normalized.includes("@") ||
    IPV4_ADDRESS.test(normalized)
  );
};

const semanticReasonCodes = (
  manifest: PluginManifestV1
): readonly PluginManifestValidationReasonCode[] => {
  const reasons: PluginManifestValidationReasonCode[] = [];
  if (duplicateCapability(manifest)) {
    reasons.push("plugin-capability-duplicate");
  }
  if (
    manifest.auth.modes.includes("none") &&
    manifest.auth.modes.length !== 1
  ) {
    reasons.push("plugin-auth-mode-conflict");
  }
  if (
    manifest.execution.idempotency.mode === "lookup-only" &&
    manifest.execution.lookup.mode !== "by-operation-key"
  ) {
    reasons.push("plugin-recovery-contract-unsafe");
  }
  if (manifest.permissions.egress.hosts.some(dangerousEgressHost)) {
    reasons.push("plugin-egress-host-dangerous");
  }
  return stableReasonCodes(reasons);
};

export const validatePluginManifest = (
  candidate: unknown
): PluginManifestValidationResult => {
  const snapshot = validatePluginJson(candidate);
  if (!snapshot.ok) {
    return {
      ok: false,
      reasonCodes: ["plugin-manifest-schema-invalid"],
      validatorVersion: PLUGIN_MANIFEST_VALIDATOR_VERSION,
    };
  }
  if (!validateSchema(snapshot.value)) {
    return {
      ok: false,
      reasonCodes: stableReasonCodes(
        (validateSchema.errors ?? []).map(schemaReasonCode)
      ),
      validatorVersion: PLUGIN_MANIFEST_VALIDATOR_VERSION,
    };
  }
  const semanticErrors = semanticReasonCodes(snapshot.value);
  return semanticErrors.length === 0
    ? {
        manifest: snapshot.value,
        ok: true,
        validatorVersion: PLUGIN_MANIFEST_VALIDATOR_VERSION,
      }
    : {
        ok: false,
        reasonCodes: semanticErrors,
        validatorVersion: PLUGIN_MANIFEST_VALIDATOR_VERSION,
      };
};

export const isPluginManifestV1 = (
  candidate: unknown
): candidate is PluginManifestV1 => validatePluginManifest(candidate).ok;
