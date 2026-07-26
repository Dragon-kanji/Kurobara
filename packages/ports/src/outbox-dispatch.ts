import type { OutboxMessageId } from "@kurobara/kernel";

import type { OutboxMessage } from "./run-persistence.ts";

export type RunOrchestrationBindingState =
  | "pending"
  | "reconciliation_exhausted"
  | "starting"
  | "started"
  | "reconciliation_required";

export type RunOrchestrationBinding = Readonly<{
  adapterKey?: string;
  orchestrationRunId?: string;
  startKey: string;
  state: RunOrchestrationBindingState;
}>;

export type OutboxClaim = Readonly<{
  attempt: number;
  binding: RunOrchestrationBinding;
  claimedBy: string;
  claimToken: string;
  message: OutboxMessage;
}>;

export type ClaimNextOutboxInput = Readonly<{
  claimedBy: string;
  leaseMilliseconds: number;
}>;

export type SettleOutboxInput = Readonly<{
  claimedBy: string;
  claimToken: string;
  messageId: OutboxMessageId;
}>;

export type MarkOutboxRetryInput = SettleOutboxInput &
  Readonly<{
    reason: string;
    retryDelayMilliseconds: number;
  }>;

export type MarkOutboxDeadLetterInput = SettleOutboxInput &
  Readonly<{
    reason: string;
  }>;

export type MarkRunOrchestrationStartingInput = SettleOutboxInput &
  Readonly<{ adapterKey: string }>;

export type RecordRunOrchestrationStartedInput =
  MarkRunOrchestrationStartingInput & Readonly<{ orchestrationRunId: string }>;

export interface OutboxDispatchPort {
  claimNext(input: ClaimNextOutboxInput): Promise<OutboxClaim | undefined>;
  markDeadLetter(input: MarkOutboxDeadLetterInput): Promise<void>;
  markDispatched(input: SettleOutboxInput): Promise<void>;
  markReconciliationRequired(input: SettleOutboxInput): Promise<void>;
  markRetry(input: MarkOutboxRetryInput): Promise<void>;
  markStarting(input: MarkRunOrchestrationStartingInput): Promise<void>;
  recordStarted(input: RecordRunOrchestrationStartedInput): Promise<void>;
  resetPending(input: SettleOutboxInput): Promise<void>;
}
