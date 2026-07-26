import { createHash } from "node:crypto";

import {
  type Artifact,
  artifactId,
  attemptId,
  type ContractRef,
  contentHash,
  instant,
  operationKey,
  runId,
  stepRunId,
  type ValidatedOutputRef,
  workspaceId,
} from "@kurobara/kernel";
import type { NormalizedJsonValue } from "@kurobara/ports";

import { DatabasePayloadError } from "./errors.ts";

type JsonRecord = Record<string, unknown>;

const record = (value: unknown, path: string): JsonRecord => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new DatabasePayloadError(`${path} must be an object.`);
  }
  return value as JsonRecord;
};

const string = (value: unknown, path: string): string => {
  if (typeof value !== "string" || value.length === 0) {
    throw new DatabasePayloadError(`${path} must be a non-empty string.`);
  }
  return value;
};

const integer = (value: unknown, path: string): number => {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new DatabasePayloadError(
      `${path} must be a non-negative safe integer.`
    );
  }
  return value;
};

export const parseContractRef = (value: unknown, path: string): ContractRef => {
  const item = record(value, path);
  return {
    catalogFingerprint: contentHash(
      string(item.catalogFingerprint, `${path}.catalogFingerprint`)
    ),
    catalogVersion: string(item.catalogVersion, `${path}.catalogVersion`),
    schemaFingerprint: contentHash(
      string(item.schemaFingerprint, `${path}.schemaFingerprint`)
    ),
    schemaId: string(item.schemaId, `${path}.schemaId`),
    schemaVersion: string(item.schemaVersion, `${path}.schemaVersion`),
  };
};

export const parseNormalizedJsonValue = (
  value: unknown,
  path = "normalizedJson"
): NormalizedJsonValue => {
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
      parseNormalizedJsonValue(entry, `${path}[${index}]`)
    );
  }
  const item = record(value, path);
  return Object.fromEntries(
    Object.entries(item).map(([key, entry]) => [
      key,
      parseNormalizedJsonValue(entry, `${path}.${key}`),
    ])
  );
};

const compareKeys = (left: string, right: string): number => {
  if (left < right) {
    return -1;
  }
  return left > right ? 1 : 0;
};

export const serializeCanonicalJson = (value: NormalizedJsonValue): string => {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "number" ||
    typeof value === "string"
  ) {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(serializeCanonicalJson).join(",")}]`;
  }
  const entries = Object.entries(value).sort(([left], [right]) =>
    compareKeys(left, right)
  );
  return `{${entries
    .map(
      ([key, entry]) =>
        `${JSON.stringify(key)}:${serializeCanonicalJson(entry)}`
    )
    .join(",")}}`;
};

export const normalizedJsonEvidence = (
  value: NormalizedJsonValue
): Readonly<{ contentHash: string; sizeBytes: number }> => {
  const canonical = serializeCanonicalJson(value);
  return {
    contentHash: `sha256:${createHash("sha256").update(canonical, "utf8").digest("hex")}`,
    sizeBytes: Buffer.byteLength(canonical, "utf8"),
  };
};

export const parseArtifact = (value: unknown): Artifact => {
  const path = "artifact";
  const item = record(value, path);
  if (
    item.classification !== "internal" ||
    item.kind !== "normalized-output" ||
    item.mediaType !== "application/json" ||
    item.retentionPolicy !== "run" ||
    item.state !== "finalized"
  ) {
    throw new DatabasePayloadError(
      "artifact is not a supported finalized inline output artifact."
    );
  }
  return {
    artifactId: artifactId(string(item.artifactId, `${path}.artifactId`)),
    attemptId: attemptId(string(item.attemptId, `${path}.attemptId`)),
    classification: "internal",
    contentHash: contentHash(string(item.contentHash, `${path}.contentHash`)),
    contract: parseContractRef(item.contract, `${path}.contract`),
    finalizedAt: instant(integer(item.finalizedAt, `${path}.finalizedAt`)),
    kind: "normalized-output",
    mediaType: "application/json",
    operationKey: operationKey(
      string(item.operationKey, `${path}.operationKey`)
    ),
    retentionPolicy: "run",
    runId: runId(string(item.runId, `${path}.runId`)),
    sizeBytes: integer(item.sizeBytes, `${path}.sizeBytes`),
    state: "finalized",
    stepRunId: stepRunId(string(item.stepRunId, `${path}.stepRunId`)),
    validatedAt: instant(integer(item.validatedAt, `${path}.validatedAt`)),
    validatorVersion: string(item.validatorVersion, `${path}.validatorVersion`),
    workspaceId: workspaceId(string(item.workspaceId, `${path}.workspaceId`)),
  };
};

export const parseValidatedOutputRef = (
  value: unknown,
  path: string
): ValidatedOutputRef => {
  const item = record(value, path);
  const storedArtifact = record(item.artifact, `${path}.artifact`);
  return {
    artifact: {
      artifactId: artifactId(
        string(storedArtifact.artifactId, `${path}.artifact.artifactId`)
      ),
      contentHash: contentHash(
        string(storedArtifact.contentHash, `${path}.artifact.contentHash`)
      ),
    },
    contract: parseContractRef(item.contract, `${path}.contract`),
    validatedAt: instant(integer(item.validatedAt, `${path}.validatedAt`)),
    validatorVersion: string(item.validatorVersion, `${path}.validatorVersion`),
  };
};
