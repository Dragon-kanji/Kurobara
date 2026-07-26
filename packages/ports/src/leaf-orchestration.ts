import type {
  AttemptId,
  EventId,
  RunId,
  StepRunId,
  WorkspaceId,
} from "@kurobara/kernel";

export type StartLeafAttemptRequest = Readonly<{
  attemptId: AttemptId;
  eventId: EventId;
  runId: RunId;
  startKey: string;
  stepRunId: StepRunId;
  workspaceId: WorkspaceId;
}>;

export type StartLeafAttemptOutcome =
  | Readonly<{
      externalExecutionId: string;
      status: "accepted" | "already-started";
    }>
  | Readonly<{ reason: string; status: "outcome-unknown" }>
  | Readonly<{
      reason: string;
      retryable: boolean;
      status: "definitely-rejected";
    }>;

export type FindLeafAttemptOutcome =
  | Readonly<{ externalExecutionId: string; status: "found" }>
  | Readonly<{ proofId: string; status: "not-found" }>
  | Readonly<{ reason: string; status: "outcome-unknown" }>;

export interface LeafOrchestrationPort {
  readonly adapterKey: string;
  findAttemptByStartKey(
    request: StartLeafAttemptRequest
  ): Promise<FindLeafAttemptOutcome>;
  startAttempt(
    request: StartLeafAttemptRequest
  ): Promise<StartLeafAttemptOutcome>;
}
