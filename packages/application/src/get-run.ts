import {
  type DomainResult,
  fail,
  type RunId,
  succeed,
  type WorkspaceId,
} from "@kurobara/kernel";
import type { RunQueryPort, RunSnapshotRecord } from "@kurobara/ports";

export type GetRunQuery = Readonly<{
  actorPermissions: readonly string[];
  runId: RunId;
  workspaceId: WorkspaceId;
}>;

export type GetRunFailure = Readonly<{
  code: "authority-permission-missing" | "run-not-found";
  message: string;
}>;

export type GetRunDependencies = Readonly<{
  requiredPermission: string;
  runs: RunQueryPort;
}>;

export const makeGetRun =
  (dependencies: GetRunDependencies) =>
  async (
    query: GetRunQuery
  ): Promise<DomainResult<RunSnapshotRecord, GetRunFailure>> => {
    if (!query.actorPermissions.includes(dependencies.requiredPermission)) {
      return fail({
        code: "authority-permission-missing",
        message: "The authenticated actor lacks permission to read runs.",
      });
    }

    const snapshot = await dependencies.runs.get(
      { workspaceId: query.workspaceId },
      query.runId
    );
    if (snapshot === undefined) {
      return fail({
        code: "run-not-found",
        message: "The run does not exist in this workspace.",
      });
    }

    return succeed(snapshot);
  };
