// biome-ignore-all lint/performance/noBarrelFile: this file is the package's single intentional public export surface.
export {
  PLUGIN_CONFORMANCE_COMPATIBILITY_MATRIX,
  PLUGIN_CONFORMANCE_GUARANTEE_IDS,
  PLUGIN_CONFORMANCE_PROFILE_ID,
  PLUGIN_CONFORMANCE_PROFILE_VERSION,
  PLUGIN_CONFORMANCE_REPORT_VERSION,
  type PluginConformanceGuaranteeId,
} from "./constants.ts";
export { serializePluginConformanceReport } from "./report.ts";
export { runSidecarConformance } from "./runner.ts";
export type {
  PluginConformanceEffectObservation,
  PluginConformanceEffectProbe,
  PluginConformanceGuaranteeResult,
  PluginConformanceHostTarget,
  PluginConformanceReportV1,
  PluginConformanceRequests,
  PluginConformanceSafeReasonCode,
  PluginConformanceStatus,
  PluginConformanceSubject,
  RunSidecarConformanceOptions,
} from "./types.ts";
