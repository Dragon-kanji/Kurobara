import { correlationId } from "@kurobara/kernel";
import type {
  ClockPort,
  DatasetGenerationWorkClaim,
  DatasetGenerationWorkPort,
} from "@kurobara/ports";

import type { makeAuthorizeDatasetGenerationPage } from "./authorize-first-dataset-generation-page.ts";
import type { makeCheckpointDatasetGenerationPage } from "./checkpoint-first-dataset-generation-page.ts";

type AuthorizeDatasetGenerationPage = ReturnType<
  typeof makeAuthorizeDatasetGenerationPage
>;
type CheckpointDatasetGenerationPage = ReturnType<
  typeof makeCheckpointDatasetGenerationPage
>;

export type DatasetGenerationSchedulerCycleOutcome = Readonly<{
  generationId?: DatasetGenerationWorkClaim["generationId"];
  idle: boolean;
  status:
    | "authorized"
    | "blocked"
    | "checkpointed"
    | "idle"
    | "pending"
    | "terminal";
}>;

export class DatasetGenerationSchedulerError extends Error {
  readonly name = "DatasetGenerationSchedulerError";
}

const BLOCKING_AUTHORIZATION_CODES = new Set([
  "budget-exhausted",
  "deadline-elapsed",
  "limit-exhausted",
]);

export type ScheduleDatasetGenerationDependencies = Readonly<{
  authorize: AuthorizeDatasetGenerationPage;
  checkpoint: CheckpointDatasetGenerationPage;
  claimLeaseMilliseconds: number;
  clock: ClockPort;
  nextLeaseToken: () => string;
  schedulerId: string;
  work: DatasetGenerationWorkPort;
}>;

export const makeScheduleNextDatasetGeneration = (
  dependencies: ScheduleDatasetGenerationDependencies
) => {
  return async (): Promise<DatasetGenerationSchedulerCycleOutcome> => {
    const claimedAt = await dependencies.clock.now();
    const claim = await dependencies.work.claimNext({
      claimedAt,
      claimedBy: dependencies.schedulerId,
      claimLeaseMilliseconds: dependencies.claimLeaseMilliseconds,
      leaseToken: dependencies.nextLeaseToken(),
    });
    if (claim === undefined) {
      return { idle: true, status: "idle" };
    }

    const checkpointed = await dependencies.checkpoint({
      generationId: claim.generationId,
      workspaceId: claim.workspaceId,
    });
    if (!checkpointed.ok) {
      throw new DatasetGenerationSchedulerError(
        `Dataset generation checkpoint failed: ${checkpointed.error.code}.`
      );
    }
    if (checkpointed.value.status === "pending") {
      await dependencies.work.release(claim);
      return {
        generationId: claim.generationId,
        idle: false,
        status: "pending",
      };
    }
    if (
      checkpointed.value.status === "ambiguous" ||
      checkpointed.value.status === "cancelled" ||
      checkpointed.value.status === "failed"
    ) {
      await dependencies.work.release(claim);
      return {
        generationId: claim.generationId,
        idle: false,
        status: "terminal",
      };
    }
    if (
      checkpointed.value.page.state !== "committed" ||
      !checkpointed.value.page.hasMore
    ) {
      await dependencies.work.release(claim);
      return {
        generationId: claim.generationId,
        idle: false,
        status: "checkpointed",
      };
    }

    const authorized = await dependencies.authorize({
      actorId: claim.actorId,
      actorPermissions: claim.actorPermissions,
      authenticationMode: "system",
      correlationId: correlationId(
        `dataset-generation-scheduler:${claim.leaseToken}`
      ),
      generationId: claim.generationId,
      workspaceId: claim.workspaceId,
    });
    if (!authorized.ok) {
      if (authorized.error.code === "generation-not-planned") {
        await dependencies.work.release(claim);
        return {
          generationId: claim.generationId,
          idle: false,
          status: "terminal",
        };
      }
      if (BLOCKING_AUTHORIZATION_CODES.has(authorized.error.code)) {
        // Keep the short lease until expiry. This prevents a permanent
        // authority bound from becoming a hot loop while still allowing a
        // restarted worker to re-read the immutable plan.
        return {
          generationId: claim.generationId,
          idle: false,
          status: "blocked",
        };
      }
      throw new DatasetGenerationSchedulerError(
        `Dataset generation authorization failed: ${authorized.error.code}.`
      );
    }
    await dependencies.work.release(claim);
    return {
      generationId: claim.generationId,
      idle: false,
      status: "authorized",
    };
  };
};
