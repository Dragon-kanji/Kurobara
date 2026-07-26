import { type ContractRef, contentHash, instant } from "@kurobara/kernel";
import type { NormalizedJsonValue, ValidatedRunInput } from "@kurobara/ports";

import {
  normalizedJsonEvidence,
  parseContractRef,
  serializeCanonicalJson,
} from "./artifact-payload.ts";
import { DatabasePayloadError } from "./errors.ts";

type JsonRecord = Record<string, unknown>;

export type RunPlanInputRow = Readonly<{
  classification: string;
  content_hash: string;
  contract: unknown;
  finalized_at: Date;
  input_id: string;
  media_type: string;
  normalized_payload: unknown;
  run_plan_id: string;
  size_bytes: string;
  validated_at: Date;
  validator_version: string;
  workspace_id: string;
}>;

const record = (value: unknown, path: string): JsonRecord => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new DatabasePayloadError(`${path} must be an object.`);
  }
  return value as JsonRecord;
};

const exactRecord = (
  value: unknown,
  path: string,
  keys: readonly string[]
): JsonRecord => {
  const parsed = record(value, path);
  const allowed = new Set(keys);
  const extra = Object.keys(parsed).find((key) => !allowed.has(key));
  if (extra !== undefined) {
    throw new DatabasePayloadError(`${path}.${extra} is not supported.`);
  }
  return parsed;
};

const string = (value: unknown, path: string): string => {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.trim() !== value ||
    value.length > 4096
  ) {
    throw new DatabasePayloadError(
      `${path} must be a bounded non-empty string without surrounding whitespace.`
    );
  }
  return value;
};

const nonNegativeInteger = (value: unknown, path: string): number => {
  const parsed = typeof value === "string" ? Number(value) : value;
  if (
    typeof parsed !== "number" ||
    !Number.isSafeInteger(parsed) ||
    parsed < 0
  ) {
    throw new DatabasePayloadError(
      `${path} must be a non-negative safe integer.`
    );
  }
  return parsed;
};

const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const MAX_INPUT_DEPTH = 32;
const MAX_INPUT_NODES = 4096;

const parseBoundedNormalizedJson = (
  value: unknown,
  path: string,
  depth: number,
  state: { nodes: number }
): NormalizedJsonValue => {
  state.nodes += 1;
  if (depth > MAX_INPUT_DEPTH || state.nodes > MAX_INPUT_NODES) {
    throw new DatabasePayloadError(`${path} exceeds the supported JSON shape.`);
  }
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "string"
  ) {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new DatabasePayloadError(`${path} must contain finite numbers.`);
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((entry, index) =>
      parseBoundedNormalizedJson(entry, `${path}[${index}]`, depth + 1, state)
    );
  }
  const item = record(value, path);
  const output: Record<string, NormalizedJsonValue> = {};
  for (const [key, entry] of Object.entries(item)) {
    if (FORBIDDEN_KEYS.has(key)) {
      throw new DatabasePayloadError(`${path}.${key} is not supported.`);
    }
    output[key] = parseBoundedNormalizedJson(
      entry,
      `${path}.${key}`,
      depth + 1,
      state
    );
  }
  return output;
};

const contract = (value: unknown, path: string): ContractRef => {
  const parsed = exactRecord(value, path, [
    "catalogFingerprint",
    "catalogVersion",
    "schemaFingerprint",
    "schemaId",
    "schemaVersion",
  ]);
  return parseContractRef(parsed, path);
};

const parseInputValue = (input: JsonRecord): ValidatedRunInput => {
  if (input.classification !== "internal") {
    throw new DatabasePayloadError("runInput.classification must be internal.");
  }
  if (input.mediaType !== "application/json") {
    throw new DatabasePayloadError(
      "runInput.mediaType must be application/json."
    );
  }
  const value = parseBoundedNormalizedJson(input.value, "runInput.value", 0, {
    nodes: 0,
  });
  const evidence = normalizedJsonEvidence(value);
  const sizeBytes = nonNegativeInteger(input.sizeBytes, "runInput.sizeBytes");
  const parsedContentHash = contentHash(
    string(input.contentHash, "runInput.contentHash")
  );
  const validatedAt = instant(
    nonNegativeInteger(input.validatedAt, "runInput.validatedAt")
  );
  const finalizedAt = instant(
    nonNegativeInteger(input.finalizedAt, "runInput.finalizedAt")
  );
  if (
    parsedContentHash !== evidence.contentHash ||
    sizeBytes !== evidence.sizeBytes ||
    sizeBytes > 65_536 ||
    validatedAt > finalizedAt
  ) {
    throw new DatabasePayloadError(
      "runInput does not match its canonical payload evidence or lifecycle."
    );
  }
  const inputId = string(input.inputId, "runInput.inputId");
  const validatorVersion = string(
    input.validatorVersion,
    "runInput.validatorVersion"
  );
  if (inputId.length > 512 || validatorVersion.length > 256) {
    throw new DatabasePayloadError(
      "runInput identifiers exceed their supported bounds."
    );
  }
  return {
    classification: "internal",
    contentHash: parsedContentHash,
    contract: contract(input.contract, "runInput.contract"),
    finalizedAt,
    inputId,
    mediaType: "application/json",
    sizeBytes,
    validatedAt,
    validatorVersion,
    value,
  };
};

export const parseValidatedRunInput = (value: unknown): ValidatedRunInput => {
  const input = exactRecord(value, "runInput", [
    "classification",
    "contentHash",
    "contract",
    "finalizedAt",
    "inputId",
    "mediaType",
    "sizeBytes",
    "validatedAt",
    "validatorVersion",
    "value",
  ]);
  return parseInputValue(input);
};

export const parseRunPlanInputRow = (row: RunPlanInputRow): ValidatedRunInput =>
  parseInputValue({
    classification: row.classification,
    contentHash: row.content_hash,
    contract: row.contract,
    finalizedAt: row.finalized_at.getTime(),
    inputId: row.input_id,
    mediaType: row.media_type,
    sizeBytes: row.size_bytes,
    validatedAt: row.validated_at.getTime(),
    validatorVersion: row.validator_version,
    value: row.normalized_payload,
  });

export const runInputValuesMatch = (
  left: NormalizedJsonValue,
  right: NormalizedJsonValue
): boolean => serializeCanonicalJson(left) === serializeCanonicalJson(right);
