import type {
  LeafEffectRecoveryClaim,
  LeafEffectRecoveryPort,
  StartLeafAttemptRequest,
} from "@kurobara/ports";

import type { ExecuteLeafAttemptResult } from "./execute-leaf-attempt.ts";

const MAX_BATCH_SIZE = 100;
const MAX_LEASE_MILLISECONDS = 300_000;
const MAX_OPERATION_TIMEOUT_MILLISECONDS = 150_000;
const MAX_RETRY_DELAY_MILLISECONDS = 86_400_000;
const OPERATION_FAILED = "leaf-effect-recovery-operation-failed";
const OUTCOME_UNKNOWN = "leaf-effect-recovery-outcome-unknown";
const CLAIM_LOST = "leaf-effect-recovery-claim-lost";

type UnresolvedReason =
  | typeof CLAIM_LOST
  | typeof OPERATION_FAILED
  | typeof OUTCOME_UNKNOWN;

type SafeExecutionResult =
  | ExecuteLeafAttemptResult
  | Readonly<{ kind: "operation-failed" }>;

export type ReconcileLeafEffectsDependencies = Readonly<{
  batchSize: number;
  claimLeaseMilliseconds: number;
  effectAdapterKey: string;
  executeLeafAttempt(
    request: StartLeafAttemptRequest
  ): Promise<ExecuteLeafAttemptResult>;
  operationTimeoutMilliseconds: number;
  operatorId: string;
  recovery: LeafEffectRecoveryPort;
  retryDelayMilliseconds: number;
}>;

export type ReconcileLeafEffectItem =
  | Readonly<{
      attemptId: LeafEffectRecoveryClaim["attemptId"];
      status: "completed";
    }>
  | Readonly<{
      attemptId: LeafEffectRecoveryClaim["attemptId"];
      reason: UnresolvedReason;
      status: "unresolved";
    }>;

export type ReconcileLeafEffectsResult = Readonly<{
  claimed: number;
  items: readonly ReconcileLeafEffectItem[];
  reaped: Readonly<{ completed: number; exhausted: number }>;
}>;

const boundedPositiveInteger = (
  value: number,
  maximum: number,
  name: string
): number => {
  if (!(Number.isSafeInteger(value) && value > 0 && value <= maximum)) {
    throw new RangeError(
      `${name} must be a positive safe integer no greater than ${maximum}.`
    );
  }
  return value;
};

const nonEmpty = (value: string, name: string): string => {
  const normalized = value.trim();
  if (normalized.length === 0) {
    throw new RangeError(`${name} must not be empty.`);
  }
  return normalized;
};

const requestFor = (
  claim: LeafEffectRecoveryClaim
): StartLeafAttemptRequest => ({
  attemptId: claim.attemptId,
  eventId: claim.eventId,
  runId: claim.runId,
  startKey: claim.startKey,
  stepRunId: claim.stepRunId,
  workspaceId: claim.workspaceId,
});

const executeWithTimeout = (
  execute: ReconcileLeafEffectsDependencies["executeLeafAttempt"],
  claim: LeafEffectRecoveryClaim,
  timeoutMilliseconds: number
): Promise<SafeExecutionResult> =>
  new Promise((resolve) => {
    let settled = false;
    const settle = (result: SafeExecutionResult): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      resolve(result);
    };
    const timeout = setTimeout(
      () => settle({ kind: "operation-failed" }),
      timeoutMilliseconds
    );
    execute(requestFor(claim)).then(settle, () => {
      settle({ kind: "operation-failed" });
    });
  });

export const makeReconcileLeafEffects = (
  dependencies: ReconcileLeafEffectsDependencies
) => {
  const batchSize = boundedPositiveInteger(
    dependencies.batchSize,
    MAX_BATCH_SIZE,
    "batchSize"
  );
  const claimLeaseMilliseconds = boundedPositiveInteger(
    dependencies.claimLeaseMilliseconds,
    MAX_LEASE_MILLISECONDS,
    "claimLeaseMilliseconds"
  );
  const operationTimeoutMilliseconds = boundedPositiveInteger(
    dependencies.operationTimeoutMilliseconds,
    MAX_OPERATION_TIMEOUT_MILLISECONDS,
    "operationTimeoutMilliseconds"
  );
  if (operationTimeoutMilliseconds * 2 > claimLeaseMilliseconds) {
    throw new RangeError(
      "operationTimeoutMilliseconds must be no greater than half of claimLeaseMilliseconds."
    );
  }
  const retryDelayMilliseconds = boundedPositiveInteger(
    dependencies.retryDelayMilliseconds,
    MAX_RETRY_DELAY_MILLISECONDS,
    "retryDelayMilliseconds"
  );
  const operatorId = nonEmpty(dependencies.operatorId, "operatorId");
  const effectAdapterKey = nonEmpty(
    dependencies.effectAdapterKey,
    "effectAdapterKey"
  );

  const release = async (
    claim: LeafEffectRecoveryClaim,
    reason: UnresolvedReason
  ): Promise<ReconcileLeafEffectItem> => {
    const settlement = await dependencies.recovery.release({
      attemptId: claim.attemptId,
      claimedBy: operatorId,
      claimToken: claim.claimToken,
      effectAdapterKey,
      reason,
      retryDelayMilliseconds,
      scope: { workspaceId: claim.workspaceId },
    });
    return {
      attemptId: claim.attemptId,
      reason: settlement.status === "claim-lost" ? CLAIM_LOST : reason,
      status: "unresolved",
    };
  };

  const reconcileClaim = async (
    claim: LeafEffectRecoveryClaim
  ): Promise<ReconcileLeafEffectItem> => {
    if (
      claim.claimedBy !== operatorId ||
      claim.effectAdapterKey !== effectAdapterKey
    ) {
      throw new Error(
        "The leaf effect recovery claim does not match the requested system operator."
      );
    }
    const result = await executeWithTimeout(
      dependencies.executeLeafAttempt,
      claim,
      operationTimeoutMilliseconds
    );
    if ("kind" in result) {
      return release(claim, OPERATION_FAILED);
    }
    if (!result.ok) {
      return release(claim, OPERATION_FAILED);
    }
    if (result.value.status === "ambiguous") {
      return release(claim, OUTCOME_UNKNOWN);
    }
    const settlement = await dependencies.recovery.complete({
      attemptId: claim.attemptId,
      claimedBy: operatorId,
      claimToken: claim.claimToken,
      effectAdapterKey,
      scope: { workspaceId: claim.workspaceId },
    });
    return settlement.status === "settled"
      ? { attemptId: claim.attemptId, status: "completed" }
      : {
          attemptId: claim.attemptId,
          reason: CLAIM_LOST,
          status: "unresolved",
        };
  };

  return async (): Promise<ReconcileLeafEffectsResult> => {
    const items: ReconcileLeafEffectItem[] = [];
    let claimed = 0;
    const reaped = await dependencies.recovery.reapForSystem({
      effectAdapterKey,
    });
    while (claimed < batchSize) {
      const claim = await dependencies.recovery.claimNextForSystem({
        claimedBy: operatorId,
        effectAdapterKey,
        leaseMilliseconds: claimLeaseMilliseconds,
      });
      if (claim === undefined) {
        break;
      }
      claimed += 1;
      const item = await reconcileClaim(claim);
      items.push(item);
      if (item.status === "unresolved" && item.reason === CLAIM_LOST) {
        break;
      }
    }
    return { claimed, items, reaped };
  };
};
