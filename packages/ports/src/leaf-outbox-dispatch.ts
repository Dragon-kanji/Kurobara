import type {
  AttemptId,
  EventId,
  Instant,
  OperationKey,
  OutboxMessageId,
  RunId,
  StepLifecycleEvent,
  StepRunId,
  WorkspaceId,
} from "@kurobara/kernel";

import type { WorkspaceScope } from "./run-persistence.ts";

export type AttemptClaimedEvent = Extract<
  StepLifecycleEvent,
  { eventType: "AttemptClaimed" }
>;

export type LeafOutboxMessage = Readonly<{
  aggregateVersion: number;
  attemptId: AttemptId;
  availableAt: Instant;
  destination: "orchestration.step.attempt.claimed";
  effectAdapterKey: string;
  event: AttemptClaimedEvent;
  eventId: EventId;
  messageId: OutboxMessageId;
  operationKey: OperationKey;
  runId: RunId;
  stepRunId: StepRunId;
  workspaceId: WorkspaceId;
}>;

export type LeafExecutionBindingState =
  | "pending"
  | "starting"
  | "started"
  | "reconciliation_required"
  | "reconciliation_exhausted"
  | "rejected"
  | "cancelled";

export type LeafExecutionBinding = Readonly<{
  adapterKey?: string;
  externalExecutionId?: string;
  startKey: string;
  state: LeafExecutionBindingState;
}>;

export type LeafOutboxClaim = Readonly<{
  attempt: number;
  binding: LeafExecutionBinding;
  claimedBy: string;
  claimToken: string;
  message: LeafOutboxMessage;
}>;

export type ClaimNextLeafOutboxInput = Readonly<{
  claimedBy: string;
  leaseMilliseconds: number;
}>;

export type LeafOutboxSettlementInput = Readonly<{
  claimedBy: string;
  claimToken: string;
  messageId: OutboxMessageId;
  scope: WorkspaceScope;
}>;

export type MarkLeafStartingInput = LeafOutboxSettlementInput &
  Readonly<{ adapterKey: string; effectAdapterKey: string }>;

export type RecordLeafStartedInput = MarkLeafStartingInput &
  Readonly<{
    effectAdapterKey: string;
    externalExecutionId: string;
    recoveryDelayMilliseconds: number;
    recoveryMaxAttempts: number;
  }>;

export type DelayLeafOutboxInput = LeafOutboxSettlementInput &
  Readonly<{
    reason: string;
    retryDelayMilliseconds: number;
  }>;

export type RecordLeafTerminalInput = LeafOutboxSettlementInput &
  Readonly<{ reason: string }>;

export type LeafOutboxMutationResult = Readonly<{
  status: "applied" | "stale";
}>;

export interface LeafOutboxRepository {
  append(scope: WorkspaceScope, message: LeafOutboxMessage): Promise<void>;
}

export interface LeafOutboxDispatchPort {
  claimNext(
    input: ClaimNextLeafOutboxInput
  ): Promise<LeafOutboxClaim | undefined>;
  markCancelled(
    input: RecordLeafTerminalInput
  ): Promise<LeafOutboxMutationResult>;
  markDeadLetter(
    input: RecordLeafTerminalInput
  ): Promise<LeafOutboxMutationResult>;
  markReconciliationRequired(
    input: DelayLeafOutboxInput
  ): Promise<LeafOutboxMutationResult>;
  markStarting(input: MarkLeafStartingInput): Promise<LeafOutboxMutationResult>;
  recordRejected(
    input: RecordLeafTerminalInput
  ): Promise<LeafOutboxMutationResult>;
  recordStarted(
    input: RecordLeafStartedInput
  ): Promise<LeafOutboxMutationResult>;
  resetPending(input: DelayLeafOutboxInput): Promise<LeafOutboxMutationResult>;
}
