import type { StepRunId, WorkspaceId } from "@kurobara/kernel";

type StepRoutingWorkspaceScope = Readonly<{ workspaceId: WorkspaceId }>;

export interface StepRoutingRequestRepository {
  request(
    scope: StepRoutingWorkspaceScope,
    stepRunId: StepRunId
  ): Promise<void>;
}
