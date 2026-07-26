import type { OutboxMessageId } from "@kurobara/kernel";
import type {
  OrchestrationPort,
  OutboxClaim,
  OutboxDispatchPort,
  StartRunOutcome,
} from "@kurobara/ports";

import { makeDispatchRunQueued } from "./dispatch-run-queued.ts";

const ORCHESTRATION_OPERATION_FAILED = "orchestration-operation-failed";

export type DispatchNextOutboxResult =
  | Readonly<{ status: "idle" }>
  | Readonly<{
      messageId: OutboxMessageId;
      outcome: StartRunOutcome;
      status: "dispatched";
    }>
  | Readonly<{
      messageId: OutboxMessageId;
      reason: string;
      status: "retry-scheduled";
    }>
  | Readonly<{
      messageId: OutboxMessageId;
      reason: string;
      status: "dead-lettered";
    }>;

export type DispatchNextOutboxDependencies = Readonly<{
  claimLeaseMilliseconds: number;
  maxAttempts: number;
  orchestration: OrchestrationPort;
  outbox: OutboxDispatchPort;
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

const failureReason = (_error: unknown): string =>
  ORCHESTRATION_OPERATION_FAILED;

export const makeDispatchNextOutbox = (
  dependencies: DispatchNextOutboxDependencies
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
  const workerId = nonEmpty(dependencies.workerId, "workerId");
  const adapterKey = nonEmpty(
    dependencies.orchestration.adapterKey,
    "orchestration.adapterKey"
  );
  const dispatchRunQueued = makeDispatchRunQueued({
    orchestration: dependencies.orchestration,
  });

  const settleFailure = async (
    claim: OutboxClaim,
    reason: string,
    retryable: boolean
  ): Promise<DispatchNextOutboxResult> => {
    if (!(retryable && claim.attempt < maxAttempts)) {
      await dependencies.outbox.markDeadLetter({
        claimedBy: workerId,
        claimToken: claim.claimToken,
        messageId: claim.message.messageId,
        reason,
      });
      return {
        messageId: claim.message.messageId,
        reason,
        status: "dead-lettered",
      };
    }
    await dependencies.outbox.markRetry({
      claimedBy: workerId,
      claimToken: claim.claimToken,
      messageId: claim.message.messageId,
      reason,
      retryDelayMilliseconds,
    });
    return {
      messageId: claim.message.messageId,
      reason,
      status: "retry-scheduled",
    };
  };

  const settleStarted = async (
    claim: OutboxClaim,
    outcome: StartRunOutcome
  ): Promise<DispatchNextOutboxResult> => {
    if (
      !("orchestrationRunId" in outcome) ||
      outcome.orchestrationRunId.trim().length === 0
    ) {
      throw new Error("The orchestration adapter returned an invalid run ID.");
    }
    await dependencies.outbox.recordStarted({
      adapterKey,
      claimedBy: workerId,
      claimToken: claim.claimToken,
      messageId: claim.message.messageId,
      orchestrationRunId: outcome.orchestrationRunId,
    });
    await dependencies.outbox.markDispatched({
      claimedBy: workerId,
      claimToken: claim.claimToken,
      messageId: claim.message.messageId,
    });
    return {
      messageId: claim.message.messageId,
      outcome,
      status: "dispatched",
    };
  };

  const requireReconciliation = async (
    claim: OutboxClaim,
    reason: string
  ): Promise<DispatchNextOutboxResult> => {
    await dependencies.outbox.markReconciliationRequired({
      claimedBy: workerId,
      claimToken: claim.claimToken,
      messageId: claim.message.messageId,
    });
    return settleFailure(claim, reason, true);
  };

  const reconcile = async (
    claim: OutboxClaim
  ): Promise<DispatchNextOutboxResult> => {
    if (
      claim.binding.adapterKey !== undefined &&
      claim.binding.adapterKey !== adapterKey
    ) {
      return settleFailure(
        claim,
        "The orchestration binding belongs to another adapter.",
        false
      );
    }
    let outcome: Awaited<ReturnType<OrchestrationPort["findRunByStartKey"]>>;
    try {
      outcome = await dependencies.orchestration.findRunByStartKey({
        eventId: claim.message.eventId,
        runId: claim.message.aggregateId,
        startKey: claim.binding.startKey,
        workspaceId: claim.message.workspaceId,
      });
    } catch (error) {
      return requireReconciliation(claim, failureReason(error));
    }
    if (outcome.status === "found") {
      return settleStarted(claim, {
        orchestrationRunId: outcome.orchestrationRunId,
        status: "already-started",
      });
    }
    return requireReconciliation(
      claim,
      outcome.status === "not-found"
        ? "The prior orchestration start has no authoritative outcome."
        : outcome.reason
    );
  };

  return async (): Promise<DispatchNextOutboxResult> => {
    const claim = await dependencies.outbox.claimNext({
      claimedBy: workerId,
      leaseMilliseconds: claimLeaseMilliseconds,
    });
    if (claim === undefined) {
      return { status: "idle" };
    }

    if (claim.binding.state === "started") {
      const orchestrationRunId = claim.binding.orchestrationRunId;
      if (orchestrationRunId === undefined) {
        return settleFailure(
          claim,
          "A started orchestration binding has no run identifier.",
          false
        );
      }
      await dependencies.outbox.markDispatched({
        claimedBy: workerId,
        claimToken: claim.claimToken,
        messageId: claim.message.messageId,
      });
      return {
        messageId: claim.message.messageId,
        outcome: { orchestrationRunId, status: "already-started" },
        status: "dispatched",
      };
    }

    if (claim.binding.state === "reconciliation_exhausted") {
      return settleFailure(
        claim,
        "The orchestration reconciliation budget is exhausted.",
        false
      );
    }

    if (claim.binding.state !== "pending") {
      return reconcile(claim);
    }

    await dependencies.outbox.markStarting({
      adapterKey,
      claimedBy: workerId,
      claimToken: claim.claimToken,
      messageId: claim.message.messageId,
    });
    let result: Awaited<ReturnType<typeof dispatchRunQueued>>;
    try {
      result = await dispatchRunQueued(claim.message, claim.binding.startKey);
    } catch (error) {
      return requireReconciliation(claim, failureReason(error));
    }
    if (!result.ok) {
      await dependencies.outbox.resetPending({
        claimedBy: workerId,
        claimToken: claim.claimToken,
        messageId: claim.message.messageId,
      });
      return settleFailure(claim, result.error.message, false);
    }
    if (
      result.value.status === "accepted" ||
      result.value.status === "already-started"
    ) {
      return settleStarted(claim, result.value);
    }
    if (result.value.status === "outcome-unknown") {
      return requireReconciliation(claim, result.value.reason);
    }
    await dependencies.outbox.resetPending({
      claimedBy: workerId,
      claimToken: claim.claimToken,
      messageId: claim.message.messageId,
    });
    return settleFailure(claim, result.value.reason, result.value.retryable);
  };
};
