import type { PluginConformanceReport } from "@kurobara/contracts";
import type { DevelopmentPluginHostOptions } from "@kurobara/plugin-host";
import type {
  PluginClassifyErrorRequest,
  PluginEstimateRequest,
  PluginExecuteRequest,
  PluginHealthRequest,
  PluginLookupRequest,
  PluginManifestV1,
  PluginNormalizeRequest,
  PluginValidateConfigRequest,
} from "@kurobara/plugin-sdk";

import type { PluginConformanceGuaranteeId } from "./constants.ts";

export type PluginConformanceStatus = "passed" | "failed" | "not-applicable";

export interface PluginConformanceEffectObservation {
  readonly effectCount: number;
  readonly operationKeys: readonly string[];
}

export interface PluginConformanceEffectProbe {
  read(): Promise<PluginConformanceEffectObservation>;
}

export interface PluginConformanceSubject {
  readonly artifactFingerprint: string;
  readonly packageName: string;
  readonly packageVersion: string;
}

export interface PluginConformanceHostTarget {
  readonly arguments?: DevelopmentPluginHostOptions["arguments"];
  readonly callTimeoutMs?: DevelopmentPluginHostOptions["callTimeoutMs"];
  readonly executablePath: DevelopmentPluginHostOptions["executablePath"];
  readonly expectedManifest: PluginManifestV1;
  readonly workingDirectory: DevelopmentPluginHostOptions["workingDirectory"];
}

export interface PluginConformanceRequests {
  readonly classifyError: PluginClassifyErrorRequest;
  readonly estimate: PluginEstimateRequest;
  readonly execute: PluginExecuteRequest;
  readonly health: PluginHealthRequest;
  readonly lookup: PluginLookupRequest;
  readonly normalize: PluginNormalizeRequest;
  readonly validateConfig: PluginValidateConfigRequest;
}

export interface RunSidecarConformanceOptions {
  readonly canary: string;
  readonly effectProbe: PluginConformanceEffectProbe;
  readonly host: PluginConformanceHostTarget;
  readonly requests: PluginConformanceRequests;
  readonly subject: PluginConformanceSubject;
}

export type PluginConformanceSafeReasonCode =
  | "compatibility-unsupported"
  | "contract-rejected"
  | "behavior-mismatch"
  | "forbidden-observation"
  | "profile-not-applicable";

export interface PluginConformanceGuaranteeResult {
  readonly evidence_refs: readonly string[];
  readonly id: PluginConformanceGuaranteeId;
  readonly reason_codes: readonly PluginConformanceSafeReasonCode[];
  readonly status: PluginConformanceStatus;
}

export type PluginConformanceReportV1 = PluginConformanceReport;
