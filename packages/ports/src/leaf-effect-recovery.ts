import type {
  AttemptId,
  EventId,
  RunId,
  StepRunId,
  WorkspaceId,
} from "@kurobara/kernel";

import type { WorkspaceScope } from "./run-persistence.ts";

export type LeafEffectRecoveryClaim = Readonly<{
  attempt: number;
  attemptId: AttemptId;
  claimToken: string;
  claimedBy: string;
  effectAdapterKey: string;
  eventId: EventId;
  runId: RunId;
  startKey: string;
  stepRunId: StepRunId;
  workspaceId: WorkspaceId;
}>;

export type ClaimNextLeafEffectRecoveryInput = Readonly<{
  claimedBy: string;
  effectAdapterKey: string;
  leaseMilliseconds: number;
}>;

export type SettleLeafEffectRecoveryInput = Readonly<{
  attemptId: AttemptId;
  claimedBy: string;
  claimToken: string;
  effectAdapterKey: string;
  scope: WorkspaceScope;
}>;

export type ReleaseLeafEffectRecoveryInput = SettleLeafEffectRecoveryInput &
  Readonly<{
    reason: string;
    retryDelayMilliseconds: number;
  }>;

export type LeafEffectRecoverySettlement = Readonly<{
  status: "claim-lost" | "settled";
}>;

export type LeafEffectRecoveryReapResult = Readonly<{
  completed: number;
  exhausted: number;
}>;

export interface LeafEffectRecoveryPort {
  claimNextForSystem(
    input: ClaimNextLeafEffectRecoveryInput
  ): Promise<LeafEffectRecoveryClaim | undefined>;
  complete(
    input: SettleLeafEffectRecoveryInput
  ): Promise<LeafEffectRecoverySettlement>;
  reapForSystem(input: {
    readonly effectAdapterKey: string;
  }): Promise<LeafEffectRecoveryReapResult>;
  release(
    input: ReleaseLeafEffectRecoveryInput
  ): Promise<LeafEffectRecoverySettlement>;
}
