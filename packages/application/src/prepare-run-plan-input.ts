import {
  type DomainResult,
  fail,
  type RunPlan,
  succeed,
} from "@kurobara/kernel";
import type {
  ClockPort,
  InputContractValidatorPort,
  NormalizedJsonValue,
  ValidatedRunInput,
} from "@kurobara/ports";

import {
  canonicalContentByteSize,
  canonicalContentHash,
} from "./canonical-content-hash.ts";

const MAX_INPUT_BYTES = 64 * 1024;
const MAX_INPUT_DEPTH = 32;
const MAX_INPUT_NODES = 4096;
const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);

export type PrepareRunPlanInputContentRequest = Readonly<{
  plan: RunPlan;
  value: NormalizedJsonValue;
}>;

export type PrepareRunPlanInputContentFailure = Readonly<{
  code:
    | "input-contract-rejected"
    | "input-hash-mismatch"
    | "input-invalid"
    | "input-too-large"
    | "validator-unavailable";
  message: string;
}>;

export type PrepareRunPlanInputContentResult = DomainResult<
  ValidatedRunInput,
  PrepareRunPlanInputContentFailure
>;

export type PrepareRunPlanInputContentDependencies = Readonly<{
  clock: ClockPort;
  validator: InputContractValidatorPort;
}>;

type JsonShapeState = Readonly<{ nodes: number; valid: boolean }>;

const inspectJsonShape = (
  value: unknown,
  depth: number,
  nodes: number
): JsonShapeState => {
  const nextNodes = nodes + 1;
  if (depth > MAX_INPUT_DEPTH || nextNodes > MAX_INPUT_NODES) {
    return { nodes: nextNodes, valid: false };
  }
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "string" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return { nodes: nextNodes, valid: true };
  }
  if (Array.isArray(value)) {
    let state: JsonShapeState = { nodes: nextNodes, valid: true };
    for (const entry of value) {
      state = inspectJsonShape(entry, depth + 1, state.nodes);
      if (!state.valid) {
        return state;
      }
    }
    return state;
  }
  if (typeof value !== "object") {
    return { nodes: nextNodes, valid: false };
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    return { nodes: nextNodes, valid: false };
  }
  let state: JsonShapeState = { nodes: nextNodes, valid: true };
  for (const [key, entry] of Object.entries(value)) {
    if (FORBIDDEN_KEYS.has(key) || entry === undefined) {
      return { nodes: state.nodes, valid: false };
    }
    state = inspectJsonShape(entry, depth + 1, state.nodes);
    if (!state.valid) {
      return state;
    }
  }
  return state;
};

const rejected = (
  code: PrepareRunPlanInputContentFailure["code"],
  message: string
): PrepareRunPlanInputContentResult => fail({ code, message });

export const makePrepareRunPlanInputContent =
  (dependencies: PrepareRunPlanInputContentDependencies) =>
  async (
    request: PrepareRunPlanInputContentRequest
  ): Promise<PrepareRunPlanInputContentResult> => {
    let shapeIsValid = false;
    try {
      shapeIsValid = inspectJsonShape(request.value, 0, 0).valid;
    } catch {
      shapeIsValid = false;
    }
    if (!shapeIsValid) {
      return rejected(
        "input-invalid",
        "The run input is not bounded normalized JSON."
      );
    }

    let contentHash: ValidatedRunInput["contentHash"];
    let sizeBytes: number;
    try {
      contentHash = canonicalContentHash(request.value);
      sizeBytes = canonicalContentByteSize(request.value);
    } catch {
      return rejected(
        "input-invalid",
        "The run input cannot be serialized as canonical JSON."
      );
    }
    if (sizeBytes > MAX_INPUT_BYTES) {
      return rejected(
        "input-too-large",
        "The inline run input exceeds 65536 canonical bytes."
      );
    }
    if (contentHash !== request.plan.normalizedInputHash) {
      return rejected(
        "input-hash-mismatch",
        "The run input does not match the immutable plan input hash."
      );
    }

    let validation: Awaited<ReturnType<InputContractValidatorPort["validate"]>>;
    try {
      validation = await dependencies.validator.validate({
        contract: request.plan.inputContract,
        value: request.value,
      });
    } catch {
      return rejected(
        "validator-unavailable",
        "The exact input contract could not be evaluated."
      );
    }
    if (validation.status === "rejected") {
      return rejected(
        "input-contract-rejected",
        "The run input does not satisfy the exact input contract."
      );
    }
    if (validation.validatorVersion.trim().length === 0) {
      return rejected(
        "validator-unavailable",
        "The input validator did not provide a version."
      );
    }

    const validatedAt = await dependencies.clock.now();
    const identityHash = canonicalContentHash({
      contentHash,
      contract: request.plan.inputContract,
      runPlanId: request.plan.runPlanId,
      workspaceId: request.plan.workspaceId,
    });
    return succeed({
      classification: "internal",
      contentHash,
      contract: request.plan.inputContract,
      finalizedAt: validatedAt,
      inputId: `run_input_${identityHash.slice("sha256:".length)}`,
      mediaType: "application/json",
      sizeBytes,
      validatedAt,
      validatorVersion: validation.validatorVersion,
      value: request.value,
    });
  };
