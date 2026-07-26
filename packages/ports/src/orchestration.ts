import type { EventId, RunId, WorkspaceId } from "@kurobara/kernel";

export type StartRunRequest = Readonly<{
  eventId: EventId;
  runId: RunId;
  startKey: string;
  workspaceId: WorkspaceId;
}>;

export type StartRunOutcome =
  | Readonly<{
      orchestrationRunId: string;
      status: "accepted";
    }>
  | Readonly<{
      orchestrationRunId: string;
      status: "already-started";
    }>
  | Readonly<{
      reason: string;
      status: "outcome-unknown";
    }>
  | Readonly<{
      reason: string;
      retryable: boolean;
      status: "definitely-rejected";
    }>;

export type FindRunByStartKeyRequest = StartRunRequest;

export type FindRunByStartKeyOutcome =
  | Readonly<{
      orchestrationRunId: string;
      status: "found";
    }>
  | Readonly<{ status: "not-found" }>
  | Readonly<{
      reason: string;
      status: "outcome-unknown";
    }>;

export interface OrchestrationPort {
  readonly adapterKey: string;
  findRunByStartKey(
    request: FindRunByStartKeyRequest
  ): Promise<FindRunByStartKeyOutcome>;
  startRun(request: StartRunRequest): Promise<StartRunOutcome>;
}
