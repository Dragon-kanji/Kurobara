import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";

import type { PluginConformanceReport } from "@kurobara/contracts";
import catalogManifest from "@kurobara/contracts/catalog-manifest.json" with {
  type: "json",
};
import {
  type DevelopmentPluginHost,
  PluginHostError,
  startDevelopmentPluginHost,
} from "@kurobara/plugin-host";
import {
  PLUGIN_PROTOCOL_API_VERSION,
  type PluginProtocolMethod,
  type PluginProtocolRequest,
  type PluginProtocolResult,
  validatePluginJson,
  validatePluginManifest,
} from "@kurobara/plugin-sdk";

import packageMetadata from "../package.json" with { type: "json" };
import { serializeCanonicalJson } from "./canonical-json.ts";
import {
  PLUGIN_CONFORMANCE_COMPATIBILITY_MATRIX,
  PLUGIN_CONFORMANCE_GUARANTEE_IDS,
  PLUGIN_CONFORMANCE_PROFILE_ID,
  PLUGIN_CONFORMANCE_PROFILE_VERSION,
  PLUGIN_CONFORMANCE_REPORT_VERSION,
  type PluginConformanceGuaranteeId,
} from "./constants.ts";
import { validatePluginConformanceReport } from "./report.ts";
import type {
  PluginConformanceEffectObservation,
  PluginConformanceSafeReasonCode,
  RunSidecarConformanceOptions,
} from "./types.ts";

const REPORT_SCHEMA_ID =
  "https://schemas.kurobara.invalid/schemas/plugins/conformance-report/1.0.0";
const MANIFEST_SCHEMA_ID =
  "https://schemas.kurobara.invalid/schemas/plugins/manifest/1.0.0";
const PROTOCOL_SCHEMA_ID =
  "https://schemas.kurobara.invalid/schemas/plugins/protocol-message/1.0.0";
const SIDECAR_SCHEMA_ID =
  "https://schemas.kurobara.invalid/schemas/plugins/sidecar-json-rpc-frame/1.0.0";
const ARTIFACT_FINGERPRINT = /^sha256:[0-9a-f]{64}$/u;
const CANARY_TOKEN = /^[A-Za-z0-9_-]{8,128}$/u;
const NON_ZERO_ARTIFACT_FINGERPRINT = /^sha256:(?!0{64}$)[0-9a-f]{64}$/u;
const NODE_VERSION_PREFIX = /^v/u;
const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u;
const PLUGIN_ID = /^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9-]*)+$/u;
const SEMVER = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/u;
const REPORT_STATIC_SKELETON = Object.freeze({
  environment: {
    architecture: "",
    node_version: "",
    platform: "",
  },
  guarantees: PLUGIN_CONFORMANCE_GUARANTEE_IDS.map((id) => ({
    evidence_refs: [`case:${id}`],
    id,
    reason_codes: [
      "behavior-mismatch",
      "compatibility-unsupported",
      "contract-rejected",
      "forbidden-observation",
      "profile-not-applicable",
    ],
    status: "not-applicable",
  })),
  profile: {
    compatibility_matrix_fingerprint: "",
    fingerprint: "",
    id: PLUGIN_CONFORMANCE_PROFILE_ID,
    version: PLUGIN_CONFORMANCE_PROFILE_VERSION,
  },
  report_schema_fingerprint: "",
  report_version: PLUGIN_CONFORMANCE_REPORT_VERSION,
  subject: {
    artifact_fingerprint: "",
    declared_plugin_id: "",
    declared_plugin_version: "",
    manifest_fingerprint: "",
    package_name: "",
    package_version: "",
  },
  summary: {
    failed: 0,
    not_applicable: 0,
    passed: 0,
    status: "passed",
    total: 0,
  },
  toolchain: {
    catalog_fingerprint: "",
    catalog_version: "",
    conformance_kit_version: "",
    contracts_package_version: "",
    host_package_version: "",
    plugin_api_version: "",
    protocol_api_version: "",
    sdk_package_version: "",
  },
});

const snapshotCatalogManifest = (): typeof catalogManifest => {
  const snapshot = validatePluginJson(catalogManifest);
  if (!snapshot.ok) {
    throw new TypeError("Plugin conformance catalog snapshot is invalid.");
  }
  return snapshot.value as unknown as typeof catalogManifest;
};

const CATALOG_MANIFEST = snapshotCatalogManifest();
const CATALOG_SCHEMA_MEMBERS = Object.freeze(
  CATALOG_MANIFEST.members.filter((member) => member.role === "schema")
);

interface MutableGuarantee {
  reasons: Set<PluginConformanceSafeReasonCode>;
  status: "passed" | "failed" | "not-applicable";
}

type CompatibilityCombination =
  (typeof PLUGIN_CONFORMANCE_COMPATIBILITY_MATRIX.combinations)[number];

const guarantees = (): Map<PluginConformanceGuaranteeId, MutableGuarantee> =>
  new Map(
    PLUGIN_CONFORMANCE_GUARANTEE_IDS.map((id) => [
      id,
      {
        reasons: new Set(["profile-not-applicable"] as const),
        status: "not-applicable" as const,
      },
    ])
  );

const updateGuarantee = (
  state: ReadonlyMap<PluginConformanceGuaranteeId, MutableGuarantee>,
  id: PluginConformanceGuaranteeId,
  status: MutableGuarantee["status"],
  reasons: readonly PluginConformanceSafeReasonCode[] = []
): void => {
  const guarantee = state.get(id);
  if (!guarantee) {
    throw new TypeError("Plugin conformance guarantee registry is incomplete.");
  }
  guarantee.status = status;
  guarantee.reasons = new Set(reasons);
};

const failGuarantee = (
  state: ReadonlyMap<PluginConformanceGuaranteeId, MutableGuarantee>,
  id: PluginConformanceGuaranteeId,
  reason: Exclude<PluginConformanceSafeReasonCode, "profile-not-applicable">
): void => {
  const guarantee = state.get(id);
  if (!guarantee) {
    throw new TypeError("Plugin conformance guarantee registry is incomplete.");
  }
  guarantee.status = "failed";
  guarantee.reasons.delete("profile-not-applicable");
  guarantee.reasons.add(reason);
};

const closeQuietly = async (
  host: DevelopmentPluginHost | undefined
): Promise<void> => {
  try {
    await host?.close();
  } catch {
    // Close diagnostics are intentionally excluded from the public report.
  }
};

const recordHostStartFailure = (
  state: ReadonlyMap<PluginConformanceGuaranteeId, MutableGuarantee>,
  error: unknown,
  canaryObserved: boolean
): void => {
  updateGuarantee(state, "adapter.exact-surface", "failed", [
    "contract-rejected",
  ]);
  if (
    error instanceof PluginHostError &&
    (error.reasonCode === "plugin-host-admission-rejected" ||
      error.reasonCode === "plugin-host-describe-mismatch")
  ) {
    failGuarantee(state, "manifest.schema-and-semantics", "contract-rejected");
  }
  if (
    error instanceof PluginHostError &&
    (error.reasonCode === "plugin-host-timeout" ||
      error.reasonCode === "plugin-host-deadline-exceeded")
  ) {
    updateGuarantee(state, "timeouts.call-bound", "failed", [
      "behavior-mismatch",
    ]);
  }
  if (canaryObserved) {
    updateGuarantee(state, "redaction.canary-absent", "failed", [
      "forbidden-observation",
    ]);
  }
};

const containsCanary = (value: unknown, canary: string): boolean => {
  try {
    if (value instanceof Error) {
      return `${value.name}:${value.message}`.includes(canary);
    }
    return JSON.stringify(value).includes(canary);
  } catch {
    return false;
  }
};

const fingerprint = (value: unknown): string => {
  const snapshot = validatePluginJson(value);
  if (!snapshot.ok) {
    return `sha256:${"0".repeat(64)}`;
  }
  return `sha256:${createHash("sha256")
    .update(serializeCanonicalJson(snapshot.value).slice(0, -1))
    .digest("hex")}`;
};

const matrixFingerprint = (): string => {
  const { fingerprint: _declared, ...content } =
    PLUGIN_CONFORMANCE_COMPATIBILITY_MATRIX;
  return fingerprint(content);
};

const profileFingerprint = (): string =>
  fingerprint({
    guarantee_ids: PLUGIN_CONFORMANCE_GUARANTEE_IDS,
    id: PLUGIN_CONFORMANCE_PROFILE_ID,
    version: PLUGIN_CONFORMANCE_PROFILE_VERSION,
  });

const catalogMemberFingerprint = (id: string): string | undefined =>
  CATALOG_SCHEMA_MEMBERS.find((member) => member.id === id)?.fingerprint;

const catalogManifestFingerprintMatches = (): boolean => {
  const { catalog_fingerprint: declaredFingerprint, ...manifest } =
    CATALOG_MANIFEST;
  return fingerprint(manifest) === declaredFingerprint;
};

const matrixMatchesPackageMetadata = (
  combination: CompatibilityCombination
): boolean =>
  packageMetadata.version === combination.conformance_kit_version &&
  packageMetadata.dependencies["@kurobara/contracts"] ===
    combination.contracts_package_version &&
  packageMetadata.dependencies["@kurobara/plugin-host"] ===
    combination.plugin_host_version &&
  packageMetadata.dependencies["@kurobara/plugin-sdk"] ===
    combination.plugin_sdk_version;

const matrixMatchesContracts = (
  combination: CompatibilityCombination
): boolean =>
  catalogManifestFingerprintMatches() &&
  CATALOG_MANIFEST.catalog_version === combination.catalog_version &&
  CATALOG_MANIFEST.catalog_fingerprint === combination.catalog_fingerprint &&
  combination.conformance_report_schema_version ===
    PLUGIN_CONFORMANCE_REPORT_VERSION &&
  catalogMemberFingerprint(REPORT_SCHEMA_ID) ===
    combination.schema_fingerprints.conformance_report &&
  catalogMemberFingerprint(MANIFEST_SCHEMA_ID) ===
    combination.schema_fingerprints.manifest &&
  catalogMemberFingerprint(PROTOCOL_SCHEMA_ID) ===
    combination.schema_fingerprints.protocol_message &&
  catalogMemberFingerprint(SIDECAR_SCHEMA_ID) ===
    combination.schema_fingerprints.sidecar_json_rpc_frame &&
  matrixFingerprint() === PLUGIN_CONFORMANCE_COMPATIBILITY_MATRIX.fingerprint &&
  profileFingerprint() ===
    PLUGIN_CONFORMANCE_COMPATIBILITY_MATRIX.profile.fingerprint &&
  matrixMatchesPackageMetadata(combination);

const catalogVersions = (
  manifest: RunSidecarConformanceOptions["host"]["expectedManifest"]
): readonly string[] =>
  manifest.capabilities.flatMap((capability) => [
    capability.inputContract.catalogVersion,
    capability.outputContract.catalogVersion,
  ]);

const catalogFingerprints = (
  manifest: RunSidecarConformanceOptions["host"]["expectedManifest"]
): readonly string[] =>
  manifest.capabilities.flatMap((capability) => [
    capability.inputContract.catalogFingerprint,
    capability.outputContract.catalogFingerprint,
  ]);

const contractRefMatchesCatalog = (
  contract: RunSidecarConformanceOptions["host"]["expectedManifest"]["capabilities"][number]["inputContract"]
): boolean =>
  CATALOG_SCHEMA_MEMBERS.some(
    (member) =>
      member.id === contract.schemaId &&
      member.version === contract.schemaVersion &&
      member.fingerprint === contract.schemaFingerprint
  );

const currentProfileCombination = (
  options: RunSidecarConformanceOptions
): CompatibilityCombination | undefined => {
  const nodeVersion = process.version.replace(NODE_VERSION_PREFIX, "");
  return PLUGIN_CONFORMANCE_COMPATIBILITY_MATRIX.combinations.find(
    (candidate) =>
      matrixMatchesContracts(candidate) &&
      candidate.architecture === process.arch &&
      candidate.node_version === nodeVersion &&
      candidate.platform === process.platform &&
      options.host.executablePath === process.execPath &&
      candidate.protocol_api_version === PLUGIN_PROTOCOL_API_VERSION
  );
};

const manifestMatchesCombination = (
  manifest: RunSidecarConformanceOptions["host"]["expectedManifest"],
  combination: CompatibilityCombination
): boolean =>
  manifest.apiVersion === combination.plugin_api_version &&
  catalogVersions(manifest).length > 0 &&
  catalogVersions(manifest).every(
    (version) => version === combination.catalog_version
  ) &&
  catalogFingerprints(manifest).every(
    (candidateFingerprint) =>
      candidateFingerprint === combination.catalog_fingerprint
  ) &&
  manifest.capabilities.every(
    (capability) =>
      contractRefMatchesCatalog(capability.inputContract) &&
      contractRefMatchesCatalog(capability.outputContract)
  );

const validObservation = (
  candidate: unknown
): candidate is PluginConformanceEffectObservation => {
  if (candidate === null || typeof candidate !== "object") {
    return false;
  }
  const observation = candidate as Partial<PluginConformanceEffectObservation>;
  return (
    Number.isSafeInteger(observation.effectCount) &&
    (observation.effectCount ?? -1) >= 0 &&
    Array.isArray(observation.operationKeys) &&
    observation.operationKeys.every(
      (operationKey) =>
        typeof operationKey === "string" && operationKey.length > 0
    )
  );
};

const readEffectProbe = async (
  options: RunSidecarConformanceOptions,
  canaryObserved: { value: boolean }
): Promise<PluginConformanceEffectObservation | undefined> => {
  try {
    const observed = await options.effectProbe.read();
    canaryObserved.value ||= containsCanary(observed, options.canary);
    return validObservation(observed)
      ? {
          effectCount: observed.effectCount,
          operationKeys: Object.freeze([...observed.operationKeys]),
        }
      : undefined;
  } catch (error) {
    canaryObserved.value ||= containsCanary(error, options.canary);
  }
};

const call = async <Method extends PluginProtocolMethod>(
  host: DevelopmentPluginHost,
  method: Method,
  payload: PluginProtocolRequest<Method>,
  canary: string,
  canaryObserved: { value: boolean }
): Promise<
  | Readonly<{ ok: true; result: PluginProtocolResult<Method> }>
  | Readonly<{ ok: false }>
> => {
  try {
    const result = await host.call(method, payload);
    canaryObserved.value ||= containsCanary(result, canary);
    return { ok: true, result };
  } catch (error) {
    canaryObserved.value ||= containsCanary(error, canary);
    return { ok: false };
  }
};

const operationProbeMatches = (
  observation: PluginConformanceEffectObservation | undefined,
  expectedCount: number,
  operationKey: string
): boolean =>
  observation !== undefined &&
  observation.effectCount === expectedCount &&
  observation.operationKeys.length === expectedCount &&
  observation.operationKeys.every((candidate) => candidate === operationKey);

const sortedGuarantees = (
  state: ReadonlyMap<PluginConformanceGuaranteeId, MutableGuarantee>
): PluginConformanceReport["guarantees"] =>
  PLUGIN_CONFORMANCE_GUARANTEE_IDS.map((guaranteeId) => {
    const guarantee = state.get(guaranteeId);
    if (!guarantee) {
      throw new TypeError(
        "Plugin conformance guarantee registry is incomplete."
      );
    }
    const evidence = Object.freeze([`case:${guaranteeId}`]);
    if (guarantee.status === "passed") {
      return Object.freeze({
        evidence_refs: evidence,
        id: guaranteeId,
        reason_codes: Object.freeze([]),
        status: "passed" as const,
      });
    }
    if (guarantee.status === "not-applicable") {
      return Object.freeze({
        evidence_refs: evidence,
        id: guaranteeId,
        reason_codes: Object.freeze(["profile-not-applicable"] as const),
        status: "not-applicable" as const,
      });
    }
    const reasons = [...guarantee.reasons]
      .filter(
        (
          reason
        ): reason is Exclude<
          PluginConformanceSafeReasonCode,
          "profile-not-applicable"
        > => reason !== "profile-not-applicable"
      )
      .sort((left, right) => left.localeCompare(right, "en"));
    return Object.freeze({
      evidence_refs: evidence,
      id: guaranteeId,
      reason_codes: Object.freeze(reasons),
      status: "failed" as const,
    });
  });

const safeSubjectPackageName = (candidate: string): string => {
  if (
    candidate.length >= 3 &&
    candidate.length <= 214 &&
    PACKAGE_NAME.test(candidate)
  ) {
    return candidate;
  }
  return "invalid-conformance-subject";
};

const safeSubjectPackageVersion = (candidate: string): string => {
  if (SEMVER.test(candidate)) {
    return candidate;
  }
  return "0.0.0";
};

const safeArtifactFingerprint = (candidate: string): string => {
  if (ARTIFACT_FINGERPRINT.test(candidate)) {
    return candidate;
  }
  return `sha256:${"0".repeat(64)}`;
};

const declaredManifestIdentity = (
  candidate: unknown
): Readonly<{
  declared_plugin_id?: string;
  declared_plugin_version?: string;
}> => {
  if (candidate === null || typeof candidate !== "object") {
    return {};
  }
  const record = candidate as Readonly<Record<string, unknown>>;
  const identity: {
    declared_plugin_id?: string;
    declared_plugin_version?: string;
  } = {};
  if (
    typeof record.id === "string" &&
    record.id.length <= 128 &&
    PLUGIN_ID.test(record.id)
  ) {
    identity.declared_plugin_id = record.id;
  }
  if (typeof record.version === "string" && SEMVER.test(record.version)) {
    identity.declared_plugin_version = record.version;
  }
  return identity;
};

const report = (
  options: RunSidecarConformanceOptions,
  combination: CompatibilityCombination | undefined,
  state: ReadonlyMap<PluginConformanceGuaranteeId, MutableGuarantee>
): PluginConformanceReport => {
  const selected =
    combination ?? PLUGIN_CONFORMANCE_COMPATIBILITY_MATRIX.combinations[0];
  if (!selected) {
    throw new TypeError("Plugin conformance compatibility matrix is empty.");
  }
  const results = sortedGuarantees(state);
  const failed = results.filter((result) => result.status === "failed").length;
  const notApplicable = results.filter(
    (result) => result.status === "not-applicable"
  ).length;
  const passed = results.filter((result) => result.status === "passed").length;
  const summary =
    failed === 0
      ? ({
          failed: 0,
          not_applicable: notApplicable,
          passed,
          status: "passed",
          total: results.length,
        } as const)
      : ({
          failed,
          not_applicable: notApplicable,
          passed,
          status: "failed",
          total: results.length,
        } as const);
  return validatePluginConformanceReport({
    environment: {
      architecture: process.arch,
      node_version: process.version.replace(NODE_VERSION_PREFIX, ""),
      platform: process.platform,
    },
    guarantees: results,
    profile: {
      compatibility_matrix_fingerprint:
        PLUGIN_CONFORMANCE_COMPATIBILITY_MATRIX.fingerprint,
      fingerprint: PLUGIN_CONFORMANCE_COMPATIBILITY_MATRIX.profile.fingerprint,
      id: PLUGIN_CONFORMANCE_PROFILE_ID,
      version: PLUGIN_CONFORMANCE_PROFILE_VERSION,
    },
    report_schema_fingerprint: selected.schema_fingerprints.conformance_report,
    report_version: PLUGIN_CONFORMANCE_REPORT_VERSION,
    subject: {
      ...declaredManifestIdentity(options.host.expectedManifest),
      artifact_fingerprint: safeArtifactFingerprint(
        options.subject.artifactFingerprint
      ),
      manifest_fingerprint: fingerprint(options.host.expectedManifest),
      package_name: safeSubjectPackageName(options.subject.packageName),
      package_version: safeSubjectPackageVersion(
        options.subject.packageVersion
      ),
    },
    summary,
    toolchain: {
      catalog_fingerprint: selected.catalog_fingerprint,
      catalog_version: selected.catalog_version,
      conformance_kit_version: selected.conformance_kit_version,
      contracts_package_version: selected.contracts_package_version,
      host_package_version: selected.plugin_host_version,
      plugin_api_version: selected.plugin_api_version,
      protocol_api_version: selected.protocol_api_version,
      sdk_package_version: selected.plugin_sdk_version,
    },
  });
};

const optionsHaveValidPublicMetadata = (
  options: RunSidecarConformanceOptions
): boolean =>
  NON_ZERO_ARTIFACT_FINGERPRINT.test(options.subject.artifactFingerprint) &&
  options.subject.packageName.length >= 3 &&
  options.subject.packageName.length <= 214 &&
  PACKAGE_NAME.test(options.subject.packageName) &&
  SEMVER.test(options.subject.packageVersion) &&
  CANARY_TOKEN.test(options.canary) &&
  options.requests.classifyError.diagnostic.kind === "provider-code" &&
  options.requests.classifyError.diagnostic.providerCode === options.canary &&
  typeof options.effectProbe?.read === "function";

const reportBoundMetadataContainsCanary = (
  options: RunSidecarConformanceOptions
): boolean =>
  containsCanary(
    [
      {
        environment: {
          architecture: process.arch,
          node_version: process.version.replace(NODE_VERSION_PREFIX, ""),
          platform: process.platform,
        },
        guarantee_ids: PLUGIN_CONFORMANCE_GUARANTEE_IDS,
        manifest: options.host.expectedManifest,
        manifest_fingerprint: fingerprint(options.host.expectedManifest),
        matrix: PLUGIN_CONFORMANCE_COMPATIBILITY_MATRIX,
        report_version: PLUGIN_CONFORMANCE_REPORT_VERSION,
        subject: options.subject,
      },
      REPORT_STATIC_SKELETON,
    ],
    options.canary
  );

const declaredManifestApiVersion = (candidate: unknown): string | undefined => {
  if (candidate === null || typeof candidate !== "object") {
    return;
  }
  const apiVersion = (candidate as Readonly<Record<string, unknown>>)
    .apiVersion;
  return typeof apiVersion === "string" ? apiVersion : undefined;
};

const invocationInvalid = (): never => {
  throw new TypeError(
    "Plugin conformance invocation rejected: invocation-invalid."
  );
};

const snapshotPluginJson = <Value>(candidate: Value): Value => {
  const snapshot = validatePluginJson(candidate);
  if (!snapshot.ok) {
    return invocationInvalid();
  }
  return snapshot.value as unknown as Value;
};

const snapshotInvocation = (
  candidate: RunSidecarConformanceOptions
): RunSidecarConformanceOptions => {
  try {
    const effectProbe = candidate.effectProbe;
    const readEffectProbeSnapshot = effectProbe?.read;
    if (typeof readEffectProbeSnapshot !== "function") {
      return invocationInvalid();
    }
    const requests = candidate.requests;
    return Object.freeze({
      canary: snapshotPluginJson(candidate.canary),
      effectProbe: Object.freeze({
        read: () => readEffectProbeSnapshot.call(effectProbe),
      }),
      host: snapshotPluginJson(candidate.host),
      requests: Object.freeze({
        classifyError: snapshotPluginJson(requests.classifyError),
        estimate: snapshotPluginJson(requests.estimate),
        execute: snapshotPluginJson(requests.execute),
        health: snapshotPluginJson(requests.health),
        lookup: snapshotPluginJson(requests.lookup),
        normalize: snapshotPluginJson(requests.normalize),
        validateConfig: snapshotPluginJson(requests.validateConfig),
      }),
      subject: snapshotPluginJson(candidate.subject),
    });
  } catch {
    return invocationInvalid();
  }
};

const withValidatedManifest = (
  options: RunSidecarConformanceOptions,
  manifest: RunSidecarConformanceOptions["host"]["expectedManifest"]
): RunSidecarConformanceOptions =>
  Object.freeze({
    ...options,
    host: Object.freeze({ ...options.host, expectedManifest: manifest }),
  });

interface RuntimeCallState {
  contractRejected: boolean;
  protocolValid: boolean;
  surfaceValid: boolean;
}

interface ExecutionResult {
  readonly firstElapsedMs: number;
  readonly firstReference: string | undefined;
  readonly firstSucceeded: boolean;
  readonly secondElapsedMs: number;
  readonly secondInvoked: boolean;
  readonly secondReference: string | undefined;
  readonly secondSucceeded: boolean;
}

interface LookupResult {
  readonly elapsedMs: number;
  readonly succeeded: boolean;
}

const createRuntimeCallState = (): RuntimeCallState => ({
  contractRejected: false,
  protocolValid: true,
  surfaceValid: true,
});

const registerProtocolCall = (
  runtime: RuntimeCallState,
  responseOk: boolean,
  protocolAccepted: boolean
): void => {
  runtime.protocolValid &&= protocolAccepted;
  runtime.surfaceValid &&= responseOk;
  runtime.contractRejected ||= !responseOk;
};

const registerSurfaceCall = (
  runtime: RuntimeCallState,
  responseOk: boolean
): void => {
  runtime.surfaceValid &&= responseOk;
  runtime.contractRejected ||= !responseOk;
};

const operationReferencesAreStable = (
  references: readonly (string | undefined)[],
  undefinedAllowed: boolean
): boolean => {
  const first = references[0];
  if (first === undefined) {
    return undefinedAllowed && references.every((reference) => !reference);
  }
  return references.every((reference) => reference === first);
};

const negativeLookupOperationKey = (operationKey: string): string =>
  `conformance-negative:${createHash("sha256")
    .update(operationKey)
    .digest("hex")}`;

const negativeLookupRequest = (
  request: PluginProtocolRequest<"lookup">,
  executeOperationKey: string,
  byExternalOperationId: boolean
): PluginProtocolRequest<"lookup"> => {
  const {
    externalOperationReference: _externalOperationReference,
    ...requestWithoutExternalReference
  } = request;
  const negativeRequest = {
    ...requestWithoutExternalReference,
    operationKey: negativeLookupOperationKey(executeOperationKey),
  };
  if (!byExternalOperationId) {
    return negativeRequest;
  }
  return {
    ...requestWithoutExternalReference,
    externalOperationReference: `conformance-negative-reference:${createHash(
      "sha256"
    )
      .update(request.externalOperationReference ?? executeOperationKey)
      .digest("hex")}`,
    operationKey: request.operationKey,
  };
};

const updateBehaviorGuarantee = (
  state: ReadonlyMap<PluginConformanceGuaranteeId, MutableGuarantee>,
  id: PluginConformanceGuaranteeId,
  passed: boolean,
  failedReason: Exclude<
    PluginConformanceSafeReasonCode,
    "profile-not-applicable"
  >
): void => {
  if (passed) {
    updateGuarantee(state, id, "passed");
    return;
  }
  updateGuarantee(state, id, "failed", [failedReason]);
};

const classificationFailureReason = (
  responseOk: boolean
): Exclude<PluginConformanceSafeReasonCode, "profile-not-applicable"> => {
  if (responseOk) {
    return "forbidden-observation";
  }
  return "contract-rejected";
};

const exerciseNonEffectMethods = async (
  host: DevelopmentPluginHost,
  options: RunSidecarConformanceOptions,
  state: ReadonlyMap<PluginConformanceGuaranteeId, MutableGuarantee>,
  runtime: RuntimeCallState,
  canaryObserved: { value: boolean }
): Promise<void> => {
  const validation = await call(
    host,
    "validateConfig",
    options.requests.validateConfig,
    options.canary,
    canaryObserved
  );
  registerProtocolCall(
    runtime,
    validation.ok,
    validation.ok && validation.result.status === "valid"
  );

  const estimate = await call(
    host,
    "estimate",
    options.requests.estimate,
    options.canary,
    canaryObserved
  );
  registerProtocolCall(
    runtime,
    estimate.ok,
    estimate.ok && estimate.result.status === "quoted"
  );

  const health = await call(
    host,
    "health",
    options.requests.health,
    options.canary,
    canaryObserved
  );
  registerProtocolCall(runtime, health.ok, health.ok);

  const normalization = await call(
    host,
    "normalize",
    options.requests.normalize,
    options.canary,
    canaryObserved
  );
  registerProtocolCall(
    runtime,
    normalization.ok,
    normalization.ok && normalization.result.status === "normalized"
  );

  const classified = await call(
    host,
    "classifyError",
    options.requests.classifyError,
    options.canary,
    canaryObserved
  );
  registerSurfaceCall(runtime, classified.ok);
  const classificationPassed =
    classified.ok && !containsCanary(classified.result, options.canary);
  updateBehaviorGuarantee(
    state,
    "errors.closed-and-redacted",
    classificationPassed,
    classificationFailureReason(classified.ok)
  );
};

const exerciseExecution = async (
  host: DevelopmentPluginHost,
  options: RunSidecarConformanceOptions,
  state: ReadonlyMap<PluginConformanceGuaranteeId, MutableGuarantee>,
  runtime: RuntimeCallState,
  canaryObserved: { value: boolean },
  undefinedReferenceAllowed: boolean,
  redeliveryRequired: boolean
): Promise<ExecutionResult> => {
  const firstStartedAt = performance.now();
  const first = await call(
    host,
    "execute",
    options.requests.execute,
    options.canary,
    canaryObserved
  );
  const firstElapsedMs = performance.now() - firstStartedAt;
  const firstSucceeded = first.ok && first.result.status === "succeeded";
  const firstReference = firstSucceeded
    ? first.result.externalOperationReference
    : undefined;
  registerProtocolCall(runtime, first.ok, firstSucceeded);
  const afterFirst = await readEffectProbe(options, canaryObserved);
  const firstEffectMatches = operationProbeMatches(
    afterFirst,
    1,
    options.requests.execute.operationKey
  );

  let secondElapsedMs = 0;
  let secondReference: string | undefined;
  let secondSucceeded = true;
  if (redeliveryRequired) {
    const secondStartedAt = performance.now();
    const second = await call(
      host,
      "execute",
      options.requests.execute,
      options.canary,
      canaryObserved
    );
    secondElapsedMs = performance.now() - secondStartedAt;
    if (second.ok && second.result.status === "succeeded") {
      secondSucceeded = true;
      secondReference = second.result.externalOperationReference;
    } else {
      secondSucceeded = false;
      secondReference = undefined;
    }
    registerProtocolCall(runtime, second.ok, secondSucceeded);
  }
  const afterSecond = await readEffectProbe(options, canaryObserved);
  const secondEffectMatches = operationProbeMatches(
    afterSecond,
    1,
    options.requests.execute.operationKey
  );

  updateBehaviorGuarantee(
    state,
    "execution.declared-delivery-semantics",
    firstSucceeded &&
      secondSucceeded &&
      firstEffectMatches &&
      secondEffectMatches &&
      (!redeliveryRequired ||
        operationReferencesAreStable(
          [firstReference, secondReference],
          undefinedReferenceAllowed
        )),
    "behavior-mismatch"
  );
  return {
    firstElapsedMs,
    firstReference,
    firstSucceeded,
    secondElapsedMs,
    secondInvoked: redeliveryRequired,
    secondReference,
    secondSucceeded,
  };
};

const exerciseLookup = async (
  host: DevelopmentPluginHost,
  options: RunSidecarConformanceOptions,
  state: ReadonlyMap<PluginConformanceGuaranteeId, MutableGuarantee>,
  runtime: RuntimeCallState,
  canaryObserved: { value: boolean },
  execution: ExecutionResult,
  undefinedReferenceAllowed: boolean,
  authoritativeNegativeRequired: boolean,
  lookupByExternalOperationId: boolean,
  lookupUnavailable: boolean
): Promise<LookupResult> => {
  const startedAt = performance.now();
  const lookup = await call(
    host,
    "lookup",
    options.requests.lookup,
    options.canary,
    canaryObserved
  );
  const positiveElapsedMs = performance.now() - startedAt;
  const unavailable = lookup.ok && lookup.result.status === "outcome-unknown";
  const found = lookup.ok && lookup.result.status === "found";
  const outcomeSucceeded =
    found && lookup.result.outcome.status === "succeeded";
  const lookupReference = outcomeSucceeded
    ? lookup.result.outcome.externalOperationReference
    : undefined;
  const positiveSemanticsMatch = lookupUnavailable
    ? unavailable
    : outcomeSucceeded;
  registerProtocolCall(runtime, lookup.ok, positiveSemanticsMatch);
  const afterLookup = await readEffectProbe(options, canaryObserved);
  const positiveProbeMatches = operationProbeMatches(
    afterLookup,
    1,
    options.requests.execute.operationKey
  );
  let negativeElapsedMs = 0;
  let negativeProtocolSucceeded = true;
  let negativeProbeMatches = true;
  if (authoritativeNegativeRequired) {
    const negativeStartedAt = performance.now();
    const negativeLookup = await call(
      host,
      "lookup",
      negativeLookupRequest(
        options.requests.lookup,
        options.requests.execute.operationKey,
        lookupByExternalOperationId
      ),
      options.canary,
      canaryObserved
    );
    negativeElapsedMs = performance.now() - negativeStartedAt;
    negativeProtocolSucceeded =
      negativeLookup.ok &&
      negativeLookup.result.status === "authoritative-absent";
    registerProtocolCall(runtime, negativeLookup.ok, negativeProtocolSucceeded);
    negativeProbeMatches = operationProbeMatches(
      await readEffectProbe(options, canaryObserved),
      1,
      options.requests.execute.operationKey
    );
  }
  updateBehaviorGuarantee(
    state,
    "lookup.declared-reconciliation-no-effect",
    positiveSemanticsMatch &&
      options.requests.lookup.operationKey ===
        options.requests.execute.operationKey &&
      positiveProbeMatches &&
      (lookupUnavailable ||
        operationReferencesAreStable(
          [
            execution.firstReference,
            execution.secondReference,
            lookupReference,
          ],
          undefinedReferenceAllowed
        )) &&
      negativeProtocolSucceeded &&
      negativeProbeMatches,
    "behavior-mismatch"
  );
  return {
    elapsedMs: Math.max(positiveElapsedMs, negativeElapsedMs),
    succeeded: positiveSemanticsMatch && negativeProtocolSucceeded,
  };
};

const protocolFailureReason = (
  runtime: RuntimeCallState
): Exclude<PluginConformanceSafeReasonCode, "profile-not-applicable"> => {
  if (runtime.contractRejected) {
    return "contract-rejected";
  }
  return "behavior-mismatch";
};

const runRuntimeProfile = async (
  host: DevelopmentPluginHost,
  options: RunSidecarConformanceOptions,
  state: ReadonlyMap<PluginConformanceGuaranteeId, MutableGuarantee>,
  canaryObserved: { value: boolean },
  executeTimeoutMs: number,
  lookupTimeoutMs: number,
  undefinedReferenceAllowed: boolean,
  authoritativeNegativeRequired: boolean,
  lookupByExternalOperationId: boolean,
  oneShot: boolean
): Promise<void> => {
  const runtime = createRuntimeCallState();
  await exerciseNonEffectMethods(host, options, state, runtime, canaryObserved);
  const execution = await exerciseExecution(
    host,
    options,
    state,
    runtime,
    canaryObserved,
    undefinedReferenceAllowed,
    !oneShot
  );
  const lookup = await exerciseLookup(
    host,
    options,
    state,
    runtime,
    canaryObserved,
    execution,
    undefinedReferenceAllowed,
    authoritativeNegativeRequired,
    lookupByExternalOperationId,
    oneShot
  );

  const hostTimeoutMs = options.host.callTimeoutMs ?? 5000;
  updateBehaviorGuarantee(
    state,
    "timeouts.call-bound",
    execution.firstSucceeded &&
      execution.secondSucceeded &&
      lookup.succeeded &&
      execution.firstElapsedMs <= Math.min(hostTimeoutMs, executeTimeoutMs) &&
      (!execution.secondInvoked ||
        execution.secondElapsedMs <=
          Math.min(hostTimeoutMs, executeTimeoutMs)) &&
      lookup.elapsedMs <= Math.min(hostTimeoutMs, lookupTimeoutMs),
    "behavior-mismatch"
  );
  updateBehaviorGuarantee(
    state,
    "adapter.exact-surface",
    runtime.surfaceValid,
    "contract-rejected"
  );
  updateBehaviorGuarantee(
    state,
    "protocol.closed-messages",
    runtime.protocolValid,
    protocolFailureReason(runtime)
  );
  updateBehaviorGuarantee(
    state,
    "redaction.canary-absent",
    !canaryObserved.value,
    "forbidden-observation"
  );
};

export const runSidecarConformance = async (
  candidate: RunSidecarConformanceOptions
): Promise<PluginConformanceReport> => {
  const options = snapshotInvocation(candidate);
  if (
    !optionsHaveValidPublicMetadata(options) ||
    reportBoundMetadataContainsCanary(options)
  ) {
    return invocationInvalid();
  }
  const state = guarantees();
  const canaryObserved = { value: false };
  const profileCombination = currentProfileCombination(options);
  if (!profileCombination) {
    updateGuarantee(state, "compatibility.exact-versions", "failed", [
      "compatibility-unsupported",
    ]);
    return report(options, profileCombination, state);
  }

  const declaredApiVersion = declaredManifestApiVersion(
    options.host.expectedManifest
  );
  if (
    declaredApiVersion !== undefined &&
    declaredApiVersion !== profileCombination.plugin_api_version
  ) {
    updateGuarantee(state, "compatibility.exact-versions", "failed", [
      "compatibility-unsupported",
    ]);
    return report(options, profileCombination, state);
  }
  updateGuarantee(state, "compatibility.exact-versions", "passed");

  const manifest = validatePluginManifest(options.host.expectedManifest);
  if (!manifest.ok) {
    updateGuarantee(state, "manifest.schema-and-semantics", "failed", [
      "contract-rejected",
    ]);
    return report(options, profileCombination, state);
  }
  const validatedOptions = withValidatedManifest(options, manifest.manifest);
  updateGuarantee(state, "manifest.schema-and-semantics", "passed");
  if (!manifestMatchesCombination(manifest.manifest, profileCombination)) {
    updateGuarantee(state, "compatibility.exact-versions", "failed", [
      "compatibility-unsupported",
    ]);
    return report(validatedOptions, profileCombination, state);
  }

  const baseline = await readEffectProbe(validatedOptions, canaryObserved);
  if (
    !operationProbeMatches(
      baseline,
      0,
      validatedOptions.requests.execute.operationKey
    )
  ) {
    updateGuarantee(state, "execution.declared-delivery-semantics", "failed", [
      "behavior-mismatch",
    ]);
    if (canaryObserved.value) {
      updateGuarantee(state, "redaction.canary-absent", "failed", [
        "forbidden-observation",
      ]);
    }
    return report(validatedOptions, profileCombination, state);
  }

  let host: DevelopmentPluginHost | undefined;
  try {
    try {
      host = await startDevelopmentPluginHost(validatedOptions.host);
      updateGuarantee(state, "adapter.exact-surface", "passed");
    } catch (error) {
      canaryObserved.value ||= containsCanary(error, validatedOptions.canary);
      recordHostStartFailure(state, error, canaryObserved.value);
      return report(validatedOptions, profileCombination, state);
    }

    await runRuntimeProfile(
      host,
      validatedOptions,
      state,
      canaryObserved,
      manifest.manifest.execution.timeouts.executeMs,
      manifest.manifest.execution.timeouts.lookupMs,
      manifest.manifest.execution.lookup.mode === "by-operation-key",
      manifest.manifest.execution.lookup.authoritativeNotFound,
      manifest.manifest.execution.lookup.mode === "by-external-operation-id",
      manifest.manifest.execution.idempotency.mode === "none"
    );
    return report(validatedOptions, profileCombination, state);
  } finally {
    await closeQuietly(host);
  }
};
