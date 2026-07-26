import type {
  AttemptId,
  ContentHash,
  OperationKey,
  RoutingDecisionId,
  RunId,
  StepRunId,
  UsageEntryId,
  WorkspaceId,
} from "@kurobara/kernel";
import type { NormalizedJsonValue } from "./normalized-json.ts";
import type { ValidatedRunInput } from "./run-plan-input.ts";

export type LeafEffectRequest = Readonly<{
  attemptId: AttemptId;
  operationKey: OperationKey;
  reservedAmount: number;
  reservationUnit: string;
  routeSnapshotHash: ContentHash;
  routingDecisionId: RoutingDecisionId;
  runId: RunId;
  runInput?: ValidatedRunInput;
  stepRunId: StepRunId;
  workspaceId: WorkspaceId;
}>;

export type LeafEffectSettlement =
  | Readonly<{ kind: "release" }>
  | Readonly<{
      amount: number;
      kind: "settle";
      unit: string;
      usageEntryId: UsageEntryId;
    }>;

export type LeafEffectFinalOutcome =
  | Readonly<{
      output: NormalizedJsonValue;
      settlement: Extract<LeafEffectSettlement, { kind: "settle" }>;
      status: "succeeded";
    }>
  | Readonly<{
      reason: string;
      retryable: boolean;
      settlement: LeafEffectSettlement;
      status: "failed";
    }>;

export type ExecuteLeafEffectOutcome =
  | LeafEffectFinalOutcome
  | Readonly<{ reason: string; status: "outcome-unknown" }>;

export type LookupLeafEffectOutcome =
  | Readonly<{
      outcome: LeafEffectFinalOutcome;
      proofId: string;
      status: "found";
    }>
  | Readonly<{ proofId: string; status: "not-found" }>
  | Readonly<{ reason: string; status: "outcome-unknown" }>;

export interface LeafEffectPort {
  readonly adapterKey: string;
  execute(request: LeafEffectRequest): Promise<ExecuteLeafEffectOutcome>;
  lookup(request: LeafEffectRequest): Promise<LookupLeafEffectOutcome>;
}
