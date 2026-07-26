import { type DomainResult, fail, succeed } from "@kurobara/kernel";
import type {
  RecipeApplication,
  RecipeApplicationId,
  RecipeApplicationWatchCounts,
  RecipeApplicationWatchQueryPort,
  RecipeApplicationWatchSnapshot,
  VerifiedApiKey,
} from "@kurobara/ports";

export type RecipeApplicationStatusState =
  | "needs_replay"
  | "running"
  | "succeeded"
  | "completed_with_errors";

export type GetRecipeApplicationStatusRequest = Readonly<{
  actor: VerifiedApiKey;
  recipeApplicationId: string;
}>;

export type GetRecipeApplicationStatusFailureCode =
  | "authority-permission-missing"
  | "request-invalid"
  | "recipe-application-not-found"
  | "recipe-application-watch-invariant";

export type GetRecipeApplicationStatusFailure = Readonly<{
  code: GetRecipeApplicationStatusFailureCode;
  message: string;
}>;

export type GetRecipeApplicationStatusSuccess = Readonly<{
  application: RecipeApplication;
  counts: RecipeApplicationWatchCounts;
  state: RecipeApplicationStatusState;
  terminal: boolean;
}>;

export type GetRecipeApplicationStatusDependencies = Readonly<{
  requiredPermission: string;
  watches: RecipeApplicationWatchQueryPort;
}>;

const countsAreValid = (snapshot: RecipeApplicationWatchSnapshot): boolean => {
  const { application, counts } = snapshot;
  const values = Object.values(counts);
  return (
    values.every((value) => Number.isSafeInteger(value) && value >= 0) &&
    counts.total === application.graph.recordIds.length &&
    counts.bound + counts.unbound === counts.total &&
    counts.pending +
      counts.running +
      counts.succeeded +
      counts.failed +
      counts.skipped ===
      counts.bound
  );
};

const stateFrom = (
  counts: RecipeApplicationWatchCounts
): Readonly<{ state: RecipeApplicationStatusState; terminal: boolean }> => {
  if (counts.unbound > 0) {
    return { state: "needs_replay", terminal: false };
  }
  if (counts.pending > 0 || counts.running > 0) {
    return { state: "running", terminal: false };
  }
  if (counts.failed > 0 || counts.skipped > 0) {
    return { state: "completed_with_errors", terminal: true };
  }
  return { state: "succeeded", terminal: true };
};

export const makeGetRecipeApplicationStatus =
  (dependencies: GetRecipeApplicationStatusDependencies) =>
  async (
    request: GetRecipeApplicationStatusRequest
  ): Promise<
    DomainResult<
      GetRecipeApplicationStatusSuccess,
      GetRecipeApplicationStatusFailure
    >
  > => {
    if (!request.actor.permissions.includes(dependencies.requiredPermission)) {
      return fail({
        code: "authority-permission-missing",
        message:
          "The authenticated actor lacks permission to read recipe applications.",
      });
    }
    if (
      request.recipeApplicationId.length > 255 ||
      request.recipeApplicationId.trim().length === 0
    ) {
      return fail({
        code: "request-invalid",
        message: "The recipe application identifier is invalid.",
      });
    }

    const snapshot = await dependencies.watches.get(
      { workspaceId: request.actor.workspaceId },
      request.recipeApplicationId as RecipeApplicationId
    );
    if (snapshot === undefined) {
      return fail({
        code: "recipe-application-not-found",
        message: "The recipe application does not exist in this workspace.",
      });
    }
    if (
      snapshot.application.workspaceId !== request.actor.workspaceId ||
      snapshot.application.recipeApplicationId !==
        request.recipeApplicationId ||
      !countsAreValid(snapshot)
    ) {
      return fail({
        code: "recipe-application-watch-invariant",
        message:
          "The durable recipe application status does not match its identity and counters.",
      });
    }

    return succeed({
      application: snapshot.application,
      counts: snapshot.counts,
      ...stateFrom(snapshot.counts),
    });
  };
