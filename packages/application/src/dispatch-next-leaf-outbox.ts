import type { OutboxMessageId } from "@kurobara/kernel";
import type {
  FindLeafAttemptOutcome,
  LeafOrchestrationPort,
  LeafOutboxClaim,
  LeafOutboxDispatchPort,
  StartLeafAttemptOutcome,
  StartLeafAttemptRequest,
} from "@kurobara/ports";

import type { RecordLeafAttemptNotStartedResult } from "./record-leaf-attempt-not-started.ts";

const LEAF_ORCHESTRATION_OPERATION_FAILED =
  "leaf-orchestration-operation-failed";

export type DispatchNextLeafOutboxResult =
  | Readonly<{ status: "idle" }>
  | Readonly<{
      messageId: OutboxMessageId;
      outcome: StartLeafAttemptOutcome;
      status: "dispatched";
    }>
  | Readonly<{
      messageId: OutboxMessageId;
      reason: string;
      status: "reconciliation-scheduled" | "retry-scheduled";
    }>
  | Readonly<{
      messageId: OutboxMessageId;
      reason: string;
      status: "claim-lost" | "dead-lettered" | "rejected";
    }>;

export type DispatchNextLeafOutboxDependencies = Readonly<{
  availableEffectAdapterKeys: readonly string[];
  claimLeaseMilliseconds: number;
  effectRecoveryDelayMilliseconds: number;
  effectRecoveryMaxAttempts: number;
  leafOrchestration: LeafOrchestrationPort;
  maxAttempts: number;
  outbox: LeafOutboxDispatchPort;
  recordNotStarted(
    request: StartLeafAttemptRequest,
    retryable: boolean
  ): Promise<RecordLeafAttemptNotStartedResult>;
  retryDelayMilliseconds: number;
  workerId: string;
}>;

const positiveInteger = (value: number, name: string): number => {
  if (!(Number.isSafeInteger(value) && value > 0)) {
    throw new RangeError(`${name} must be a positive safe integer.`);
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

const requestFor = (claim: LeafOutboxClaim): StartLeafAttemptRequest => ({
  attemptId: claim.message.attemptId,
  eventId: claim.message.eventId,
  runId: claim.message.runId,
  startKey: claim.binding.startKey,
  stepRunId: claim.message.stepRunId,
  workspaceId: claim.message.workspaceId,
});

export const makeDispatchNextLeafOutbox = (
  dependencies: DispatchNextLeafOutboxDependencies
) => {
  const claimLeaseMilliseconds = positiveInteger(
    dependencies.claimLeaseMilliseconds,
    "claimLeaseMilliseconds"
  );
  const retryDelayMilliseconds = positiveInteger(
    dependencies.retryDelayMilliseconds,
    "retryDelayMilliseconds"
  );
  const maxAttempts = positiveInteger(dependencies.maxAttempts, "maxAttempts");
  const effectRecoveryDelayMilliseconds = positiveInteger(
    dependencies.effectRecoveryDelayMilliseconds,
    "effectRecoveryDelayMilliseconds"
  );
  const effectRecoveryMaxAttempts = positiveInteger(
    dependencies.effectRecoveryMaxAttempts,
    "effectRecoveryMaxAttempts"
  );
  if (effectRecoveryMaxAttempts > 100) {
    throw new RangeError("effectRecoveryMaxAttempts must be at most 100.");
  }
  const workerId = nonEmpty(dependencies.workerId, "workerId");
  const adapterKey = nonEmpty(
    dependencies.leafOrchestration.adapterKey,
    "leafOrchestration.adapterKey"
  );
  const availableEffectAdapterKeys = new Set<string>();
  for (const key of dependencies.availableEffectAdapterKeys) {
    const normalized = nonEmpty(key, "availableEffectAdapterKeys");
    if (normalized !== key || availableEffectAdapterKeys.has(normalized)) {
      throw new RangeError(
        "availableEffectAdapterKeys must contain unique keys without outer whitespace."
      );
    }
    availableEffectAdapterKeys.add(normalized);
  }
  if (availableEffectAdapterKeys.size === 0) {
    throw new RangeError("availableEffectAdapterKeys must not be empty.");
  }

  const claimLost = (
    claim: LeafOutboxClaim,
    operation: string
  ): DispatchNextLeafOutboxResult => ({
    messageId: claim.message.messageId,
    reason: `leaf-outbox-${operation}-claim-lost`,
    status: "claim-lost",
  });

  const scheduleReconciliation = async (
    claim: LeafOutboxClaim,
    reason: string
  ): Promise<DispatchNextLeafOutboxResult> => {
    if (claim.attempt >= maxAttempts) {
      const deadLettered = await dependencies.outbox.markDeadLetter({
        claimedBy: workerId,
        claimToken: claim.claimToken,
        messageId: claim.message.messageId,
        reason,
        scope: { workspaceId: claim.message.workspaceId },
      });
      if (deadLettered.status === "stale") {
        return claimLost(claim, "dead-letter");
      }
      return {
        messageId: claim.message.messageId,
        reason,
        status: "dead-lettered",
      };
    }
    const scheduled = await dependencies.outbox.markReconciliationRequired({
      claimedBy: workerId,
      claimToken: claim.claimToken,
      messageId: claim.message.messageId,
      reason,
      retryDelayMilliseconds,
      scope: { workspaceId: claim.message.workspaceId },
    });
    if (scheduled.status === "stale") {
      return claimLost(claim, "reconciliation");
    }
    return {
      messageId: claim.message.messageId,
      reason,
      status: "reconciliation-scheduled",
    };
  };

  const resetPending = async (
    claim: LeafOutboxClaim,
    reason: string
  ): Promise<DispatchNextLeafOutboxResult> => {
    if (claim.attempt >= maxAttempts) {
      const closed = await dependencies.recordNotStarted(
        requestFor(claim),
        false
      );
      if (!closed.ok) {
        return scheduleReconciliation(claim, closed.error.code);
      }
      const rejected = await dependencies.outbox.recordRejected({
        claimedBy: workerId,
        claimToken: claim.claimToken,
        messageId: claim.message.messageId,
        reason,
        scope: { workspaceId: claim.message.workspaceId },
      });
      if (rejected.status === "stale") {
        return claimLost(claim, "rejection");
      }
      return {
        messageId: claim.message.messageId,
        reason,
        status: "rejected",
      };
    }
    const reset = await dependencies.outbox.resetPending({
      claimedBy: workerId,
      claimToken: claim.claimToken,
      messageId: claim.message.messageId,
      reason,
      retryDelayMilliseconds,
      scope: { workspaceId: claim.message.workspaceId },
    });
    if (reset.status === "stale") {
      return claimLost(claim, "reset");
    }
    return {
      messageId: claim.message.messageId,
      reason,
      status: "retry-scheduled",
    };
  };

  const reconcile = async (
    claim: LeafOutboxClaim
  ): Promise<DispatchNextLeafOutboxResult> => {
    const effectAdapterKey = claim.message.effectAdapterKey;
    if (
      claim.binding.adapterKey !== undefined &&
      claim.binding.adapterKey !== adapterKey
    ) {
      const deadLettered = await dependencies.outbox.markDeadLetter({
        claimedBy: workerId,
        claimToken: claim.claimToken,
        messageId: claim.message.messageId,
        reason: "leaf-binding-adapter-mismatch",
        scope: { workspaceId: claim.message.workspaceId },
      });
      if (deadLettered.status === "stale") {
        return claimLost(claim, "adapter-mismatch");
      }
      return {
        messageId: claim.message.messageId,
        reason: "leaf-binding-adapter-mismatch",
        status: "dead-lettered",
      };
    }
    let lookup: FindLeafAttemptOutcome;
    try {
      lookup = await dependencies.leafOrchestration.findAttemptByStartKey(
        requestFor(claim)
      );
    } catch {
      return scheduleReconciliation(claim, LEAF_ORCHESTRATION_OPERATION_FAILED);
    }
    if (lookup.status === "found") {
      const started = await dependencies.outbox.recordStarted({
        adapterKey,
        claimedBy: workerId,
        claimToken: claim.claimToken,
        effectAdapterKey,
        externalExecutionId: lookup.externalExecutionId,
        messageId: claim.message.messageId,
        recoveryDelayMilliseconds: effectRecoveryDelayMilliseconds,
        recoveryMaxAttempts: effectRecoveryMaxAttempts,
        scope: { workspaceId: claim.message.workspaceId },
      });
      if (started.status === "stale") {
        return claimLost(claim, "record-started");
      }
      return {
        messageId: claim.message.messageId,
        outcome: {
          externalExecutionId: lookup.externalExecutionId,
          status: "already-started",
        },
        status: "dispatched",
      };
    }
    if (lookup.status === "not-found") {
      return resetPending(claim, lookup.proofId);
    }
    return scheduleReconciliation(claim, lookup.reason);
  };

  const dispatchPending = async (
    claim: LeafOutboxClaim
  ): Promise<DispatchNextLeafOutboxResult> => {
    const effectAdapterKey = claim.message.effectAdapterKey;
    const starting = await dependencies.outbox.markStarting({
      adapterKey,
      claimedBy: workerId,
      claimToken: claim.claimToken,
      effectAdapterKey,
      messageId: claim.message.messageId,
      scope: { workspaceId: claim.message.workspaceId },
    });
    if (starting.status === "stale") {
      return claimLost(claim, "mark-starting");
    }
    let outcome: StartLeafAttemptOutcome;
    try {
      outcome = await dependencies.leafOrchestration.startAttempt(
        requestFor(claim)
      );
    } catch {
      return scheduleReconciliation(claim, LEAF_ORCHESTRATION_OPERATION_FAILED);
    }
    switch (outcome.status) {
      case "accepted":
      case "already-started": {
        const started = await dependencies.outbox.recordStarted({
          adapterKey,
          claimedBy: workerId,
          claimToken: claim.claimToken,
          effectAdapterKey,
          externalExecutionId: outcome.externalExecutionId,
          messageId: claim.message.messageId,
          recoveryDelayMilliseconds: effectRecoveryDelayMilliseconds,
          recoveryMaxAttempts: effectRecoveryMaxAttempts,
          scope: { workspaceId: claim.message.workspaceId },
        });
        if (started.status === "stale") {
          return claimLost(claim, "record-started");
        }
        return {
          messageId: claim.message.messageId,
          outcome,
          status: "dispatched",
        };
      }
      case "outcome-unknown":
        return scheduleReconciliation(claim, outcome.reason);
      case "definitely-rejected": {
        if (outcome.retryable) {
          return resetPending(claim, outcome.reason);
        }
        const closed = await dependencies.recordNotStarted(
          requestFor(claim),
          false
        );
        if (!closed.ok) {
          return scheduleReconciliation(claim, closed.error.code);
        }
        const rejected = await dependencies.outbox.recordRejected({
          claimedBy: workerId,
          claimToken: claim.claimToken,
          messageId: claim.message.messageId,
          reason: outcome.reason,
          scope: { workspaceId: claim.message.workspaceId },
        });
        if (rejected.status === "stale") {
          return claimLost(claim, "rejection");
        }
        return {
          messageId: claim.message.messageId,
          reason: outcome.reason,
          status: "rejected",
        };
      }
      default:
        return scheduleReconciliation(
          claim,
          "leaf-orchestration-outcome-invalid"
        );
    }
  };

  return async (): Promise<DispatchNextLeafOutboxResult> => {
    const claim = await dependencies.outbox.claimNext({
      claimedBy: workerId,
      leaseMilliseconds: claimLeaseMilliseconds,
    });
    if (claim === undefined) {
      return { status: "idle" };
    }
    if (
      claim.binding.state === "pending" &&
      !availableEffectAdapterKeys.has(claim.message.effectAdapterKey)
    ) {
      const closed = await dependencies.recordNotStarted(
        requestFor(claim),
        true
      );
      if (!closed.ok) {
        return scheduleReconciliation(claim, closed.error.code);
      }
      const deadLettered = await dependencies.outbox.markDeadLetter({
        claimedBy: workerId,
        claimToken: claim.claimToken,
        messageId: claim.message.messageId,
        reason: "leaf-effect-adapter-unavailable",
        scope: { workspaceId: claim.message.workspaceId },
      });
      if (deadLettered.status === "stale") {
        return claimLost(claim, "effect-adapter-unavailable");
      }
      return {
        messageId: claim.message.messageId,
        reason: "leaf-effect-adapter-unavailable",
        status: "dead-lettered",
      };
    }
    if (claim.binding.state === "reconciliation_exhausted") {
      const deadLettered = await dependencies.outbox.markDeadLetter({
        claimedBy: workerId,
        claimToken: claim.claimToken,
        messageId: claim.message.messageId,
        reason: "leaf-reconciliation-exhausted",
        scope: { workspaceId: claim.message.workspaceId },
      });
      if (deadLettered.status === "stale") {
        return claimLost(claim, "reconciliation-exhausted");
      }
      return {
        messageId: claim.message.messageId,
        reason: "leaf-reconciliation-exhausted",
        status: "dead-lettered",
      };
    }
    if (claim.binding.state !== "pending") {
      return reconcile(claim);
    }
    return dispatchPending(claim);
  };
};
