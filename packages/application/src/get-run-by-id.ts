import { InvalidValueObjectError, runId } from "@kurobara/kernel";
import type { VerifiedApiKey } from "@kurobara/ports";

import {
  type GetRunDependencies,
  type GetRunFailure,
  makeGetRun,
} from "./get-run.ts";

export type GetRunByIdRequest = Readonly<{
  actor: VerifiedApiKey;
  runId: string;
}>;

export type GetRunByIdFailure =
  | GetRunFailure
  | Readonly<{ code: "request-invalid"; message: string }>;

export const makeGetRunById = (dependencies: GetRunDependencies) => {
  const getRun = makeGetRun(dependencies);

  return async (request: GetRunByIdRequest) => {
    try {
      return await getRun({
        actorPermissions: request.actor.permissions,
        runId: runId(request.runId),
        workspaceId: request.actor.workspaceId,
      });
    } catch (error) {
      if (error instanceof InvalidValueObjectError) {
        return {
          error: {
            code: "request-invalid",
            message: "The run identifier is invalid.",
          } as const,
          ok: false as const,
        };
      }
      throw error;
    }
  };
};
