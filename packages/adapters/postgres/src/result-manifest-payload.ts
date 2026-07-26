import {
  attemptId,
  contentHash,
  costReservationId,
  instant,
  operationKey,
  type ResultManifest,
  type ResultManifestAttemptSettlement,
  type ResultManifestEntry,
  resultManifestId,
  runId,
  runPlanId,
  stepRunId,
  usageEntryId,
  workspaceId,
} from "@kurobara/kernel";
import {
  parseContractRef,
  parseValidatedOutputRef,
} from "./artifact-payload.ts";
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

const number = (value: unknown, path: string): number => {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new DatabasePayloadError(
      `${path} must be a finite non-negative number.`
    );
  }
  return value;
};

const integer = (value: unknown, path: string): number => {
  const parsed = number(value, path);
  if (!Number.isSafeInteger(parsed)) {
    throw new DatabasePayloadError(`${path} must be a safe integer.`);
  }
  return parsed;
};

const stringArray = (value: unknown, path: string): readonly string[] => {
  if (!Array.isArray(value)) {
    throw new DatabasePayloadError(`${path} must be an array.`);
  }
  return value.map((entry, index) => string(entry, `${path}[${index}]`));
};

const entry = (value: unknown, index: number): ResultManifestEntry => {
  const path = `resultManifest.entries[${index}]`;
  const item = record(value, path);
  const state = string(item.state, `${path}.state`);
  if (state !== "failed" && state !== "skipped" && state !== "succeeded") {
    throw new DatabasePayloadError(`${path}.state is invalid.`);
  }
  const storedResult = record(item.result, `${path}.result`);
  let result: ResultManifestEntry["result"];
  if (storedResult.status === "accepted") {
    result = {
      ...parseValidatedOutputRef(storedResult, `${path}.result`),
      status: "accepted",
    };
  } else if (storedResult.status === "missing") {
    const reason = string(storedResult.reason, `${path}.result.reason`);
    if (
      reason !== "blocked-by-dependency" &&
      reason !== "result-reference-not-persisted" &&
      reason !== "step-failed"
    ) {
      throw new DatabasePayloadError(`${path}.result.reason is invalid.`);
    }
    result = { reason, status: "missing" };
  } else {
    throw new DatabasePayloadError(`${path}.result.status is invalid.`);
  }
  const blockedByNodeKeys = item.blockedByNodeKeys;
  const terminalAttemptId = item.terminalAttemptId;
  return {
    nodeKey: string(item.nodeKey, `${path}.nodeKey`),
    result,
    state,
    stepAggregateVersion: integer(
      item.stepAggregateVersion,
      `${path}.stepAggregateVersion`
    ),
    stepEventSequence: integer(
      item.stepEventSequence,
      `${path}.stepEventSequence`
    ),
    stepRunId: stepRunId(string(item.stepRunId, `${path}.stepRunId`)),
    ...(blockedByNodeKeys === undefined
      ? {}
      : {
          blockedByNodeKeys: stringArray(
            blockedByNodeKeys,
            `${path}.blockedByNodeKeys`
          ),
        }),
    ...(terminalAttemptId === undefined
      ? {}
      : {
          terminalAttemptId: attemptId(
            string(terminalAttemptId, `${path}.terminalAttemptId`)
          ),
        }),
  };
};

const settlement = (
  value: unknown,
  index: number
): ResultManifestAttemptSettlement => {
  const path = `resultManifest.attemptSettlements[${index}]`;
  const item = record(value, path);
  const disposition = string(item.disposition, `${path}.disposition`);
  const common = {
    attemptId: attemptId(string(item.attemptId, `${path}.attemptId`)),
    operationKey: operationKey(
      string(item.operationKey, `${path}.operationKey`)
    ),
    releasedAmount: number(item.releasedAmount, `${path}.releasedAmount`),
    reservationId: costReservationId(
      string(item.reservationId, `${path}.reservationId`)
    ),
    unit: string(item.unit, `${path}.unit`),
  };
  if (disposition === "released") {
    return { ...common, disposition };
  }
  if (disposition !== "settled") {
    throw new DatabasePayloadError(`${path}.disposition is invalid.`);
  }
  return {
    ...common,
    disposition,
    settledAmount: number(item.settledAmount, `${path}.settledAmount`),
    usageEntryId: usageEntryId(
      string(item.usageEntryId, `${path}.usageEntryId`)
    ),
  };
};

export const parseResultManifest = (value: unknown): ResultManifest => {
  const item = record(value, "resultManifest");
  const isFailure =
    item.conclusion === "failed" && item.resultCompleteness === "none";
  const isCompletion =
    item.conclusion === "completed" && item.resultCompleteness === "complete";
  if (
    item.manifestVersion !== 1 ||
    item.coverage !== "complete" ||
    !(isFailure || isCompletion)
  ) {
    throw new DatabasePayloadError(
      "resultManifest is not a supported V1 terminal manifest."
    );
  }
  if (!Array.isArray(item.entries)) {
    throw new DatabasePayloadError("resultManifest.entries must be an array.");
  }
  if (!Array.isArray(item.attemptSettlements)) {
    throw new DatabasePayloadError(
      "resultManifest.attemptSettlements must be an array."
    );
  }
  const storedOutput = record(item.output, "resultManifest.output");
  if (
    isFailure &&
    (storedOutput.status !== "missing" || storedOutput.reason !== "run-failed")
  ) {
    throw new DatabasePayloadError(
      "resultManifest.output must contain the supported failure proof."
    );
  }
  if (isCompletion && storedOutput.status !== "accepted") {
    throw new DatabasePayloadError(
      "resultManifest.output must contain an accepted output proof."
    );
  }
  const output = isFailure
    ? ({ reason: "run-failed", status: "missing" } as const)
    : ({
        ...parseValidatedOutputRef(storedOutput, "resultManifest.output"),
        status: "accepted",
      } as const);
  const cost = record(item.cost, "resultManifest.cost");
  if (cost.reserved !== 0) {
    throw new DatabasePayloadError(
      "resultManifest.cost.reserved must be zero."
    );
  }
  return {
    attemptSettlements: item.attemptSettlements.map(settlement),
    compiledWorkflowFingerprint: string(
      item.compiledWorkflowFingerprint,
      "resultManifest.compiledWorkflowFingerprint"
    ),
    conclusion: isFailure ? "failed" : "completed",
    cost: {
      reserved: 0,
      spent: number(cost.spent, "resultManifest.cost.spent"),
      unit: string(cost.unit, "resultManifest.cost.unit"),
    },
    coverage: "complete",
    createdAt: instant(integer(item.createdAt, "resultManifest.createdAt")),
    entries: item.entries.map(entry),
    manifestHash: contentHash(
      string(item.manifestHash, "resultManifest.manifestHash")
    ),
    manifestVersion: 1,
    output,
    outputContract: parseContractRef(
      item.outputContract,
      "resultManifest.outputContract"
    ),
    planHash: contentHash(string(item.planHash, "resultManifest.planHash")),
    resultCompleteness: isFailure ? "none" : "complete",
    resultManifestId: resultManifestId(
      string(item.resultManifestId, "resultManifest.resultManifestId")
    ),
    runId: runId(string(item.runId, "resultManifest.runId")),
    runPlanId: runPlanId(string(item.runPlanId, "resultManifest.runPlanId")),
    sourceRunAggregateVersion: integer(
      item.sourceRunAggregateVersion,
      "resultManifest.sourceRunAggregateVersion"
    ),
    workspaceId: workspaceId(
      string(item.workspaceId, "resultManifest.workspaceId")
    ),
  };
};
