import {
  contentHash,
  correlationId,
  InvalidValueObjectError,
  idempotencyKey,
  runPlanId,
} from "@kurobara/kernel";
import type { VerifiedApiKey } from "@kurobara/ports";

import {
  type CreateRunFromPlanDependencies,
  type CreateRunUseCaseFailure,
  type CreateRunUseCaseSuccess,
  makeCreateRunFromPlan,
} from "./create-run-from-plan.ts";

export type CreateRunRequest = Readonly<{
  actor: VerifiedApiKey;
  correlationId: string;
  idempotencyKey: string;
  intentionHash: string;
  runPlanId: string;
}>;

export type CreateRunRequestFailure =
  | CreateRunUseCaseFailure
  | Readonly<{
      code: "request-invalid";
      message: string;
    }>;

export type CreateRunResult =
  | Readonly<{ ok: true; value: CreateRunUseCaseSuccess }>
  | Readonly<{ error: CreateRunRequestFailure; ok: false }>;

export const makeCreateRun = (dependencies: CreateRunFromPlanDependencies) => {
  const createRunFromPlan = makeCreateRunFromPlan(dependencies);

  return async (request: CreateRunRequest): Promise<CreateRunResult> => {
    try {
      return await createRunFromPlan({
        actorId: request.actor.actorId,
        actorPermissions: request.actor.permissions,
        authenticationMode: request.actor.authenticationMode,
        correlationId: correlationId(request.correlationId),
        idempotencyKey: idempotencyKey(request.idempotencyKey),
        intentionHash: contentHash(request.intentionHash),
        runPlanId: runPlanId(request.runPlanId),
        workspaceId: request.actor.workspaceId,
      });
    } catch (error) {
      if (error instanceof InvalidValueObjectError) {
        return {
          error: {
            code: "request-invalid",
            message: "The run creation request contains an invalid value.",
          },
          ok: false,
        };
      }
      throw error;
    }
  };
};
