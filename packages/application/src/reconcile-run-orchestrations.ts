import type {
  OrchestrationPort,
  OrchestrationReconciliationClaim,
  OrchestrationReconciliationPort,
  WorkspaceScope,
} from "@kurobara/ports";

const MAX_BATCH_SIZE = 100;
const MAX_LEASE_MILLISECONDS = 300_000;
const MAX_LOOKUP_TIMEOUT_MILLISECONDS = 150_000;
const MAX_RECONCILIATION_ATTEMPTS = 100;
const MAX_RETRY_DELAY_MILLISECONDS = 86_400_000;
const LOOKUP_FAILED = "orchestration-reconciliation-lookup-failed";
const NOT_FOUND = "orchestration-reconciliation-not-found";
const OUTCOME_UNKNOWN = "orchestration-reconciliation-outcome-unknown";
const INVALID_RUN_ID = "orchestration-reconciliation-invalid-run-id";
const CLAIM_LOST = "orchestration-reconciliation-claim-lost";

type UnresolvedReason =
  | typeof CLAIM_LOST
  | typeof INVALID_RUN_ID
  | typeof LOOKUP_FAILED
  | typeof NOT_FOUND
  | typeof OUTCOME_UNKNOWN;

type SafeLookupResult =
  | Awaited<ReturnType<OrchestrationPort["findRunByStartKey"]>>
  | Readonly<{ status: "lookup-failed" }>;

export type ReconcileRunOrchestrationsDependencies = Readonly<{
  batchSize: number;
  claimLeaseMilliseconds: number;
  lookupTimeoutMilliseconds: number;
  maxAttempts: number;
  operatorId: string;
  orchestration: OrchestrationPort;
  reconciliation: OrchestrationReconciliationPort;
  retryDelayMilliseconds: number;
}>;

export type ReconcileRunOrchestrationItem =
  | Readonly<{
      orchestrationRunId: string;
      runId: OrchestrationReconciliationClaim["runId"];
      status: "confirmed";
    }>
  | Readonly<{
      reason: UnresolvedReason;
      runId: OrchestrationReconciliationClaim["runId"];
      status: "unresolved";
    }>;

export type ReconcileRunOrchestrationsResult = Readonly<{
  claimed: number;
  items: readonly ReconcileRunOrchestrationItem[];
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

const lookupClaim = async (
  orchestration: OrchestrationPort,
  claim: OrchestrationReconciliationClaim,
  timeoutMilliseconds: number
): Promise<SafeLookupResult> =>
  new Promise((resolve) => {
    let settled = false;
    const settle = (result: SafeLookupResult): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      resolve(result);
    };
    const timeout = setTimeout(() => {
      settle({ status: "lookup-failed" });
    }, timeoutMilliseconds);
    orchestration
      .findRunByStartKey({
        eventId: claim.eventId,
        runId: claim.runId,
        startKey: claim.startKey,
        workspaceId: claim.workspaceId,
      })
      .then(settle, () => {
        settle({ status: "lookup-failed" });
      });
  });

export const makeReconcileRunOrchestrations = (
  dependencies: ReconcileRunOrchestrationsDependencies
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
  const maxAttempts = boundedPositiveInteger(
    dependencies.maxAttempts,
    MAX_RECONCILIATION_ATTEMPTS,
    "maxAttempts"
  );
  const lookupTimeoutMilliseconds = boundedPositiveInteger(
    dependencies.lookupTimeoutMilliseconds,
    MAX_LOOKUP_TIMEOUT_MILLISECONDS,
    "lookupTimeoutMilliseconds"
  );
  if (lookupTimeoutMilliseconds * 2 > claimLeaseMilliseconds) {
    throw new RangeError(
      "lookupTimeoutMilliseconds must be no greater than half of claimLeaseMilliseconds."
    );
  }
  const retryDelayMilliseconds = boundedPositiveInteger(
    dependencies.retryDelayMilliseconds,
    MAX_RETRY_DELAY_MILLISECONDS,
    "retryDelayMilliseconds"
  );
  const operatorId = nonEmpty(dependencies.operatorId, "operatorId");
  const adapterKey = nonEmpty(
    dependencies.orchestration.adapterKey,
    "orchestration.adapterKey"
  );

  const release = async (
    claim: OrchestrationReconciliationClaim,
    scope: WorkspaceScope,
    reason: UnresolvedReason
  ): Promise<ReconcileRunOrchestrationItem> => {
    const settlement = await dependencies.reconciliation.release({
      adapterKey,
      claimedBy: operatorId,
      claimToken: claim.claimToken,
      maxAttempts,
      messageId: claim.messageId,
      reason,
      retryDelayMilliseconds,
      scope,
    });
    return {
      reason: settlement.status === "claim-lost" ? CLAIM_LOST : reason,
      runId: claim.runId,
      status: "unresolved",
    };
  };

  const reconcileClaim = async (
    claim: OrchestrationReconciliationClaim
  ): Promise<ReconcileRunOrchestrationItem> => {
    const scope = { workspaceId: claim.workspaceId };
    if (claim.adapterKey !== adapterKey || claim.claimedBy !== operatorId) {
      throw new Error(
        "The reconciliation claim does not match the requested system operator."
      );
    }

    const outcome = await lookupClaim(
      dependencies.orchestration,
      claim,
      lookupTimeoutMilliseconds
    );
    if (outcome.status === "found") {
      const orchestrationRunId = outcome.orchestrationRunId.trim();
      if (orchestrationRunId.length === 0) {
        return release(claim, scope, INVALID_RUN_ID);
      }
      const settlement = await dependencies.reconciliation.confirm({
        adapterKey,
        claimedBy: operatorId,
        claimToken: claim.claimToken,
        messageId: claim.messageId,
        orchestrationRunId,
        scope,
      });
      if (settlement.status === "claim-lost") {
        return { reason: CLAIM_LOST, runId: claim.runId, status: "unresolved" };
      }
      return { orchestrationRunId, runId: claim.runId, status: "confirmed" };
    }

    if (outcome.status === "lookup-failed") {
      return release(claim, scope, LOOKUP_FAILED);
    }
    return release(
      claim,
      scope,
      outcome.status === "not-found" ? NOT_FOUND : OUTCOME_UNKNOWN
    );
  };

  return async (): Promise<ReconcileRunOrchestrationsResult> => {
    const items: ReconcileRunOrchestrationItem[] = [];
    let claimed = 0;

    await dependencies.reconciliation.reapExhaustedForSystem({
      adapterKey,
      maxAttempts,
    });

    while (claimed < batchSize) {
      const claim = await dependencies.reconciliation.claimNextForSystem({
        adapterKey,
        claimedBy: operatorId,
        leaseMilliseconds: claimLeaseMilliseconds,
        maxAttempts,
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

    return { claimed, items };
  };
};
