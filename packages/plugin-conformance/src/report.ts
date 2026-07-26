import type { PluginConformanceReport } from "@kurobara/contracts";
import pluginConformanceReportSchema from "@kurobara/contracts/schemas/plugin-conformance-report.json" with {
  type: "json",
};
import { validatePluginJson } from "@kurobara/plugin-sdk";
import Ajv2020 from "ajv/dist/2020.js";

import { serializeCanonicalJson } from "./canonical-json.ts";
import {
  PLUGIN_CONFORMANCE_COMPATIBILITY_MATRIX,
  PLUGIN_CONFORMANCE_GUARANTEE_IDS,
  PLUGIN_CONFORMANCE_PROFILE_ID,
  PLUGIN_CONFORMANCE_PROFILE_VERSION,
  PLUGIN_CONFORMANCE_REPORT_VERSION,
} from "./constants.ts";

const NON_ZERO_ARTIFACT_FINGERPRINT = /^sha256:(?!0{64}$)[0-9a-f]{64}$/u;

const ajv = new Ajv2020({
  allErrors: true,
  strict: true,
  strictRequired: false,
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

const validateSchema = ajv.compile<PluginConformanceReport>(
  pluginConformanceReportSchema
);

type Guarantee = PluginConformanceReport["guarantees"][number];
type GuaranteeStatus = Guarantee["status"];

const countStatus = (
  guarantees: PluginConformanceReport["guarantees"],
  status: GuaranteeStatus
): number =>
  guarantees.filter((guarantee) => guarantee.status === status).length;

const stringsAreSortedUnique = (values: readonly string[]): boolean =>
  values.every((value, index) => {
    if (index === 0) {
      return true;
    }
    const previous = values[index - 1];
    return previous !== undefined && previous < value;
  });

type CompatibilityCombination =
  (typeof PLUGIN_CONFORMANCE_COMPATIBILITY_MATRIX.combinations)[number];

const reportMatchesCombination = (
  report: PluginConformanceReport,
  combination: CompatibilityCombination
): boolean =>
  report.report_schema_fingerprint ===
    combination.schema_fingerprints.conformance_report &&
  report.toolchain.catalog_fingerprint === combination.catalog_fingerprint &&
  report.toolchain.catalog_version === combination.catalog_version &&
  report.toolchain.conformance_kit_version ===
    combination.conformance_kit_version &&
  report.toolchain.contracts_package_version ===
    combination.contracts_package_version &&
  report.toolchain.host_package_version === combination.plugin_host_version &&
  report.toolchain.plugin_api_version === combination.plugin_api_version &&
  report.toolchain.protocol_api_version === combination.protocol_api_version &&
  report.toolchain.sdk_package_version === combination.plugin_sdk_version;

const reportEnvironmentMatchesCombination = (
  report: PluginConformanceReport,
  combination: CompatibilityCombination
): boolean =>
  report.environment.architecture === combination.architecture &&
  report.environment.node_version === combination.node_version &&
  report.environment.platform === combination.platform;

export const validatePluginConformanceReport = (
  candidate: unknown
): PluginConformanceReport => {
  const snapshot = validatePluginJson(candidate);
  if (!(snapshot.ok && validateSchema(snapshot.value))) {
    throw new TypeError("Plugin conformance report rejected: report-invalid.");
  }
  const report = snapshot.value;
  const matchingCombinations =
    PLUGIN_CONFORMANCE_COMPATIBILITY_MATRIX.combinations.filter((candidate) =>
      reportMatchesCombination(report, candidate)
    );
  const combination =
    matchingCombinations.find((candidate) =>
      reportEnvironmentMatchesCombination(report, candidate)
    ) ?? matchingCombinations[0];
  if (
    report.report_version !== PLUGIN_CONFORMANCE_REPORT_VERSION ||
    report.profile.id !== PLUGIN_CONFORMANCE_PROFILE_ID ||
    report.profile.version !== PLUGIN_CONFORMANCE_PROFILE_VERSION ||
    report.profile.fingerprint !==
      PLUGIN_CONFORMANCE_COMPATIBILITY_MATRIX.profile.fingerprint ||
    report.profile.compatibility_matrix_fingerprint !==
      PLUGIN_CONFORMANCE_COMPATIBILITY_MATRIX.fingerprint ||
    !combination ||
    report.guarantees.length !== PLUGIN_CONFORMANCE_GUARANTEE_IDS.length
  ) {
    throw new TypeError("Plugin conformance report rejected: report-invalid.");
  }

  for (
    let index = 0;
    index < PLUGIN_CONFORMANCE_GUARANTEE_IDS.length;
    index += 1
  ) {
    const guarantee = report.guarantees[index];
    if (
      !guarantee ||
      guarantee.id !== PLUGIN_CONFORMANCE_GUARANTEE_IDS[index] ||
      !stringsAreSortedUnique(guarantee.reason_codes) ||
      !stringsAreSortedUnique(guarantee.evidence_refs) ||
      (guarantee.status === "passed" && guarantee.reason_codes.length !== 0) ||
      (guarantee.status === "failed" && guarantee.reason_codes.length === 0) ||
      (guarantee.status === "not-applicable" &&
        (guarantee.reason_codes.length !== 1 ||
          guarantee.reason_codes[0] !== "profile-not-applicable"))
    ) {
      throw new TypeError(
        "Plugin conformance report rejected: report-invalid."
      );
    }
  }

  const failed = countStatus(report.guarantees, "failed");
  const notApplicable = countStatus(report.guarantees, "not-applicable");
  const passed = countStatus(report.guarantees, "passed");
  const compatibilityPassed = report.guarantees[0]?.status === "passed";
  const artifactFingerprintIsQualified = NON_ZERO_ARTIFACT_FINGERPRINT.test(
    report.subject.artifact_fingerprint
  );
  if (
    report.summary.failed !== failed ||
    report.summary.not_applicable !== notApplicable ||
    report.summary.passed !== passed ||
    report.summary.total !== report.guarantees.length ||
    report.summary.status !== (failed === 0 ? "passed" : "failed") ||
    (report.summary.status === "passed" && notApplicable > 0) ||
    !artifactFingerprintIsQualified ||
    (compatibilityPassed &&
      !reportEnvironmentMatchesCombination(report, combination))
  ) {
    throw new TypeError("Plugin conformance report rejected: report-invalid.");
  }
  return report;
};

export const serializePluginConformanceReport = (
  report: PluginConformanceReport
): string => {
  const validated = validatePluginConformanceReport(report);
  const snapshot = validatePluginJson(validated);
  if (!snapshot.ok) {
    throw new TypeError("Plugin conformance report rejected: report-invalid.");
  }
  return serializeCanonicalJson(snapshot.value);
};
