import type {
  EventId,
  OutboxMessageId,
  RunId,
  WorkspaceId,
} from "@kurobara/kernel";

import type { WorkspaceScope } from "./run-persistence.ts";

export type OrchestrationReconciliationClaim = Readonly<{
  adapterKey: string;
  claimToken: string;
  claimedBy: string;
  eventId: EventId;
  messageId: OutboxMessageId;
  runId: RunId;
  startKey: string;
  workspaceId: WorkspaceId;
}>;

export type ClaimNextOrchestrationReconciliationInput = Readonly<{
  adapterKey: string;
  claimedBy: string;
  leaseMilliseconds: number;
  maxAttempts: number;
}>;

export type ReapExhaustedOrchestrationReconciliationsInput = Readonly<{
  adapterKey: string;
  maxAttempts: number;
}>;

export type SettleOrchestrationReconciliationInput = Readonly<{
  adapterKey: string;
  claimedBy: string;
  claimToken: string;
  messageId: OutboxMessageId;
  scope: WorkspaceScope;
}>;

export type ConfirmOrchestrationReconciliationInput =
  SettleOrchestrationReconciliationInput &
    Readonly<{ orchestrationRunId: string }>;

export type ReleaseOrchestrationReconciliationInput =
  SettleOrchestrationReconciliationInput &
    Readonly<{
      maxAttempts: number;
      reason: string;
      retryDelayMilliseconds: number;
    }>;

export type OrchestrationReconciliationSettlement = Readonly<{
  status: "claim-lost" | "settled";
}>;

export interface OrchestrationReconciliationPort {
  claimNextForSystem(
    input: ClaimNextOrchestrationReconciliationInput
  ): Promise<OrchestrationReconciliationClaim | undefined>;
  confirm(
    input: ConfirmOrchestrationReconciliationInput
  ): Promise<OrchestrationReconciliationSettlement>;
  reapExhaustedForSystem(
    input: ReapExhaustedOrchestrationReconciliationsInput
  ): Promise<number>;
  release(
    input: ReleaseOrchestrationReconciliationInput
  ): Promise<OrchestrationReconciliationSettlement>;
}
