import compatibilityMatrix from "../compatibility-matrix.v1.json" with {
  type: "json",
};

export const PLUGIN_CONFORMANCE_PROFILE_ID =
  "dev.kurobara.plugin-conformance/local-v1" as const;
export const PLUGIN_CONFORMANCE_PROFILE_VERSION = "1.1.0" as const;
export const PLUGIN_CONFORMANCE_REPORT_VERSION = "1.0.0" as const;

const pluginConformanceGuaranteeIds = [
  "compatibility.exact-versions",
  "manifest.schema-and-semantics",
  "adapter.exact-surface",
  "protocol.closed-messages",
  "errors.closed-and-redacted",
  "timeouts.call-bound",
  "execution.declared-delivery-semantics",
  "lookup.declared-reconciliation-no-effect",
  "redaction.canary-absent",
] as const;

export const PLUGIN_CONFORMANCE_GUARANTEE_IDS = Object.freeze(
  pluginConformanceGuaranteeIds
);

export type PluginConformanceGuaranteeId =
  (typeof PLUGIN_CONFORMANCE_GUARANTEE_IDS)[number];

const frozenCombinations = compatibilityMatrix.combinations.map((combination) =>
  Object.freeze({
    ...combination,
    schema_fingerprints: Object.freeze({
      ...combination.schema_fingerprints,
    }),
  })
);

export const PLUGIN_CONFORMANCE_COMPATIBILITY_MATRIX = Object.freeze({
  ...compatibilityMatrix,
  combinations: Object.freeze(frozenCombinations),
  profile: Object.freeze({ ...compatibilityMatrix.profile }),
});
