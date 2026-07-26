import {
  type Attempt,
  actorId,
  amountsEqual,
  attemptId,
  type CostReservation,
  capabilityId,
  contentHash,
  costReservationId,
  idempotencyKey,
  instant,
  isAmount,
  operationKey,
  type RoutingDecision,
  routingDecisionId,
  runId,
  type StepCommandReplayProof,
  type StepRun,
  stepRunId,
  type UsageEntry,
  usageEntryId,
  workspaceId,
} from "@kurobara/kernel";
import { parseValidatedOutputRef } from "./artifact-payload.ts";
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

const finiteNumber = (value: unknown, path: string): number => {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new DatabasePayloadError(`${path} must be a finite number.`);
  }
  return value;
};

const safeInteger = (value: unknown, path: string): number => {
  const parsed = finiteNumber(value, path);
  if (!Number.isSafeInteger(parsed)) {
    throw new DatabasePayloadError(`${path} must be a safe integer.`);
  }
  return parsed;
};

const stringArray = (value: unknown, path: string): readonly string[] => {
  if (!Array.isArray(value)) {
    throw new DatabasePayloadError(`${path} must be an array.`);
  }
  return value.map((item, index) => string(item, `${path}[${index}]`));
};

const ATTEMPT_STATES: readonly Attempt["state"][] = [
  "prepared",
  "claimed",
  "in_flight",
  "succeeded",
  "failed_retryable",
  "failed_terminal",
  "ambiguous",
  "cancelled_before_effect",
];
const ATTEMPT_REASONS: readonly Attempt["reason"][] = [
  "initial",
  "retry",
  "fallback",
];

const LEGACY_ROUTE_KEY = "legacy-unattributed";
const LEGACY_EFFECT_ADAPTER_KEY = "legacy-unattributed";

export const parseAttempt = (value: unknown): Attempt => {
  const item = record(value, "attempt");
  const state = string(item.state, "attempt.state") as Attempt["state"];
  const reason = string(item.reason, "attempt.reason") as Attempt["reason"];
  if (!ATTEMPT_STATES.includes(state)) {
    throw new DatabasePayloadError("attempt.state is invalid.");
  }
  if (!ATTEMPT_REASONS.includes(reason)) {
    throw new DatabasePayloadError("attempt.reason is invalid.");
  }
  const effectStartedAt = item.effectStartedAt;
  const ambiguityObservedAt = item.ambiguityObservedAt;
  const finishedAt = item.finishedAt;
  const output = item.output;
  const reservedAmount = finiteNumber(
    item.reservedAmount,
    "attempt.reservedAmount"
  );
  const attemptNumber = safeInteger(
    item.attemptNumber,
    "attempt.attemptNumber"
  );
  if (reservedAmount < 0 || attemptNumber < 1) {
    throw new DatabasePayloadError(
      "attempt reservation and number must be non-negative and positive respectively."
    );
  }
  return {
    attemptId: attemptId(string(item.attemptId, "attempt.attemptId")),
    attemptNumber,
    authorityEnvelopeId: string(
      item.authorityEnvelopeId,
      "attempt.authorityEnvelopeId"
    ),
    claimedAt: instant(safeInteger(item.claimedAt, "attempt.claimedAt")),
    costReservationId: costReservationId(
      string(item.costReservationId, "attempt.costReservationId")
    ),
    effectAdapterKey:
      item.effectAdapterKey === undefined
        ? LEGACY_EFFECT_ADAPTER_KEY
        : string(item.effectAdapterKey, "attempt.effectAdapterKey"),
    operationKey: operationKey(
      string(item.operationKey, "attempt.operationKey")
    ),
    preparedAt: instant(safeInteger(item.preparedAt, "attempt.preparedAt")),
    reason,
    reservationUnit: string(item.reservationUnit, "attempt.reservationUnit"),
    reservedAmount,
    routeKey:
      item.routeKey === undefined
        ? LEGACY_ROUTE_KEY
        : string(item.routeKey, "attempt.routeKey"),
    routeSnapshotHash: contentHash(
      string(item.routeSnapshotHash, "attempt.routeSnapshotHash")
    ),
    routingDecisionId: routingDecisionId(
      string(item.routingDecisionId, "attempt.routingDecisionId")
    ),
    state,
    stepRunId: stepRunId(string(item.stepRunId, "attempt.stepRunId")),
    ...(effectStartedAt === undefined
      ? {}
      : {
          effectStartedAt: instant(
            safeInteger(effectStartedAt, "attempt.effectStartedAt")
          ),
        }),
    ...(ambiguityObservedAt === undefined
      ? {}
      : {
          ambiguityObservedAt: instant(
            safeInteger(ambiguityObservedAt, "attempt.ambiguityObservedAt")
          ),
        }),
    ...(finishedAt === undefined
      ? {}
      : {
          finishedAt: instant(safeInteger(finishedAt, "attempt.finishedAt")),
        }),
    ...(output === undefined
      ? {}
      : { output: parseValidatedOutputRef(output, "attempt.output") }),
  };
};

export const parseRoutingDecision = (value: unknown): RoutingDecision => {
  const item = record(value, "routingDecision");
  const capability = record(item.capability, "routingDecision.capability");
  const reservedAmount = finiteNumber(
    item.reservedAmount,
    "routingDecision.reservedAmount"
  );
  if (!isAmount(reservedAmount)) {
    throw new DatabasePayloadError(
      "routingDecision.reservedAmount must be non-negative."
    );
  }
  return {
    capability: {
      capabilityId: capabilityId(
        string(
          capability.capabilityId,
          "routingDecision.capability.capabilityId"
        )
      ),
      capabilityVersion: string(
        capability.capabilityVersion,
        "routingDecision.capability.capabilityVersion"
      ),
    },
    decidedAt: instant(
      safeInteger(item.decidedAt, "routingDecision.decidedAt")
    ),
    effectAdapterKey: string(
      item.effectAdapterKey,
      "routingDecision.effectAdapterKey"
    ),
    policyFactsHash: contentHash(
      string(item.policyFactsHash, "routingDecision.policyFactsHash")
    ),
    policyVersion: string(item.policyVersion, "routingDecision.policyVersion"),
    pricingVersion: string(
      item.pricingVersion,
      "routingDecision.pricingVersion"
    ),
    reservationUnit: string(
      item.reservationUnit,
      "routingDecision.reservationUnit"
    ),
    reservedAmount,
    routeKey: string(item.routeKey, "routingDecision.routeKey"),
    routeSnapshotHash: contentHash(
      string(item.routeSnapshotHash, "routingDecision.routeSnapshotHash")
    ),
    routingDecisionId: routingDecisionId(
      string(item.routingDecisionId, "routingDecision.routingDecisionId")
    ),
    runId: runId(string(item.runId, "routingDecision.runId")),
    stepRunId: stepRunId(string(item.stepRunId, "routingDecision.stepRunId")),
    workspaceId: workspaceId(
      string(item.workspaceId, "routingDecision.workspaceId")
    ),
  };
};

const STEP_STATES: readonly StepRun["state"][] = [
  "pending",
  "ready",
  "active",
  "waiting",
  "retryable",
  "ambiguous",
  "cancelling",
  "succeeded",
  "failed",
  "cancelled",
  "skipped",
];

export const parseStepRun = (value: unknown): StepRun => {
  const item = record(value, "stepRun");
  const state = string(item.state, "stepRun.state") as StepRun["state"];
  if (!STEP_STATES.includes(state)) {
    throw new DatabasePayloadError("stepRun.state is invalid.");
  }
  if (!Array.isArray(item.attempts)) {
    throw new DatabasePayloadError("stepRun.attempts must be an array.");
  }
  const aggregateVersion = safeInteger(
    item.aggregateVersion,
    "stepRun.aggregateVersion"
  );
  const eventSequence = safeInteger(
    item.eventSequence,
    "stepRun.eventSequence"
  );
  if (aggregateVersion < 1 || eventSequence < 1) {
    throw new DatabasePayloadError(
      "stepRun aggregate version and event sequence must be positive."
    );
  }
  const activeAttemptId = item.activeAttemptId;
  const attempts = item.attempts.map(parseAttempt);
  const parsed: StepRun = {
    aggregateVersion,
    attempts,
    createdAt: instant(safeInteger(item.createdAt, "stepRun.createdAt")),
    dependsOn: stringArray(item.dependsOn, "stepRun.dependsOn"),
    eventSequence,
    nodeKey: string(item.nodeKey, "stepRun.nodeKey"),
    runId: runId(string(item.runId, "stepRun.runId")),
    state,
    stepRunId: stepRunId(string(item.stepRunId, "stepRun.stepRunId")),
    workspaceId: workspaceId(string(item.workspaceId, "stepRun.workspaceId")),
    ...(activeAttemptId === undefined
      ? {}
      : {
          activeAttemptId: attemptId(
            string(activeAttemptId, "stepRun.activeAttemptId")
          ),
        }),
  };
  if (
    parsed.attempts.some((attempt) => attempt.stepRunId !== parsed.stepRunId) ||
    (parsed.activeAttemptId !== undefined &&
      parsed.attempts.every(
        (attempt) => attempt.attemptId !== parsed.activeAttemptId
      ))
  ) {
    throw new DatabasePayloadError(
      "stepRun attempts do not match the aggregate identity."
    );
  }
  return parsed;
};

export const parseCostReservation = (value: unknown): CostReservation => {
  const item = record(value, "costReservation");
  const amount = finiteNumber(item.amount, "costReservation.amount");
  if (
    !(
      isAmount(amount) &&
      ["reserved", "settled", "released"].includes(
        string(item.state, "costReservation.state")
      )
    )
  ) {
    throw new DatabasePayloadError("costReservation is malformed.");
  }
  const base = {
    amount,
    attemptId: attemptId(string(item.attemptId, "costReservation.attemptId")),
    createdAt: instant(
      safeInteger(item.createdAt, "costReservation.createdAt")
    ),
    operationKey: operationKey(
      string(item.operationKey, "costReservation.operationKey")
    ),
    reservationId: costReservationId(
      string(item.reservationId, "costReservation.reservationId")
    ),
    runId: runId(string(item.runId, "costReservation.runId")),
    stepRunId: stepRunId(string(item.stepRunId, "costReservation.stepRunId")),
    unit: string(item.unit, "costReservation.unit"),
    workspaceId: workspaceId(
      string(item.workspaceId, "costReservation.workspaceId")
    ),
  };
  if (item.state === "reserved") {
    return { ...base, state: "reserved" };
  }
  if (item.state === "released") {
    return {
      ...base,
      releasedAt: instant(
        safeInteger(item.releasedAt, "costReservation.releasedAt")
      ),
      state: "released",
    };
  }
  const settledAmount = finiteNumber(
    item.settledAmount,
    "costReservation.settledAmount"
  );
  const releasedAmount = finiteNumber(
    item.releasedAmount,
    "costReservation.releasedAmount"
  );
  if (
    !(
      isAmount(settledAmount) &&
      isAmount(releasedAmount) &&
      amountsEqual(settledAmount + releasedAmount, amount)
    )
  ) {
    throw new DatabasePayloadError(
      "costReservation settlement amounts are malformed."
    );
  }
  return {
    ...base,
    releasedAmount,
    settledAmount,
    settledAt: instant(
      safeInteger(item.settledAt, "costReservation.settledAt")
    ),
    state: "settled",
    usageEntryId: usageEntryId(
      string(item.usageEntryId, "costReservation.usageEntryId")
    ),
  };
};

export const parseUsageEntry = (value: unknown): UsageEntry => {
  const item = record(value, "usageEntry");
  const amount = finiteNumber(item.amount, "usageEntry.amount");
  if (!isAmount(amount)) {
    throw new DatabasePayloadError(
      "usageEntry.amount must be a non-negative finite number."
    );
  }
  const reconciliationProofId = item.reconciliationProofId;
  return {
    amount,
    attemptId: attemptId(string(item.attemptId, "usageEntry.attemptId")),
    operationKey: operationKey(
      string(item.operationKey, "usageEntry.operationKey")
    ),
    recordedAt: instant(safeInteger(item.recordedAt, "usageEntry.recordedAt")),
    reservationId: costReservationId(
      string(item.reservationId, "usageEntry.reservationId")
    ),
    runId: runId(string(item.runId, "usageEntry.runId")),
    unit: string(item.unit, "usageEntry.unit"),
    usageEntryId: usageEntryId(
      string(item.usageEntryId, "usageEntry.usageEntryId")
    ),
    workspaceId: workspaceId(
      string(item.workspaceId, "usageEntry.workspaceId")
    ),
    ...(reconciliationProofId === undefined
      ? {}
      : {
          reconciliationProofId: string(
            reconciliationProofId,
            "usageEntry.reconciliationProofId"
          ),
        }),
  };
};

const STEP_COMMAND_TYPES: readonly StepCommandReplayProof["commandType"][] = [
  "ClaimStepAttempt",
  "RejectStepRouting",
  "StartAttemptEffect",
  "RecordAttemptSucceeded",
  "RecordAttemptFailure",
  "RecordAttemptNotStarted",
  "AuthorizeRetry",
  "MarkAttemptAmbiguous",
  "ResolveAttemptAmbiguity",
  "CancelAttemptBeforeEffect",
];

export const parseStepCommandReplayProof = (
  value: unknown
): StepCommandReplayProof => {
  const item = record(value, "stepCommandProof");
  const identity = record(item.identity, "stepCommandProof.identity");
  const commandType = string(
    item.commandType,
    "stepCommandProof.commandType"
  ) as StepCommandReplayProof["commandType"];
  if (!STEP_COMMAND_TYPES.includes(commandType)) {
    throw new DatabasePayloadError("stepCommandProof.commandType is invalid.");
  }
  return {
    actorId: actorId(string(item.actorId, "stepCommandProof.actorId")),
    commandType,
    identity: {
      commandHash: contentHash(
        string(identity.commandHash, "stepCommandProof.identity.commandHash")
      ),
      idempotencyKey: idempotencyKey(
        string(
          identity.idempotencyKey,
          "stepCommandProof.identity.idempotencyKey"
        )
      ),
    },
    stepRunId: stepRunId(string(item.stepRunId, "stepCommandProof.stepRunId")),
    workspaceId: workspaceId(
      string(item.workspaceId, "stepCommandProof.workspaceId")
    ),
  };
};
