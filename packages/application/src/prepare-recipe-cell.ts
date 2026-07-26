import {
  type CellResultId,
  type DomainResult,
  fail,
  type RecordId,
  succeed,
} from "@kurobara/kernel";
import type {
  ExactRecipeCellInput,
  ExactRecipeProjectionRow,
  RecipeApplicationId,
  RecipeCellCacheIdentity,
  RecipeCellCacheSnapshot,
  RecipePersistencePort,
  RecipePersistenceUnitOfWork,
  VerifiedApiKey,
  WorkspaceScope,
} from "@kurobara/ports";

export type PrepareRecipeCellRequest = Readonly<{
  actor: VerifiedApiKey;
  recipeApplicationId: RecipeApplicationId;
  recordId: RecordId;
}>;

export type PrepareRecipeCellFailureCode =
  | "authority-permission-missing"
  | "cache-identity-mismatch"
  | "recipe-cell-input-not-found";

export type PrepareRecipeCellFailure = Readonly<{
  code: PrepareRecipeCellFailureCode;
  message: string;
}>;

export type PrepareRecipeCellSuccess =
  | Readonly<{
      projection: ExactRecipeProjectionRow;
      status: "bound";
    }>
  | Readonly<{
      cellResultId: CellResultId;
      input: ExactRecipeCellInput;
      status: "active" | "cached";
    }>
  | Readonly<{
      input: ExactRecipeCellInput;
      status: "ready";
    }>;

export type PrepareRecipeCellDependencies = Readonly<{
  persistence: RecipePersistencePort;
  requiredPermission: string;
}>;

type PrepareRecipeCellResult = DomainResult<
  PrepareRecipeCellSuccess,
  PrepareRecipeCellFailure
>;

export type PrepareRecipeCellInUnitOfWorkInput = Readonly<{
  request: PrepareRecipeCellRequest;
  scope: WorkspaceScope;
  unitOfWork: RecipePersistenceUnitOfWork;
}>;

const cacheIdentityFor = (
  input: ExactRecipeCellInput
): RecipeCellCacheIdentity => ({
  datasetId: input.datasetId,
  inputHash: input.inputHash,
  recipeId: input.recipeId,
  recipeRevision: input.recipeRevision,
  recordContentHash: input.recordContentHash,
  recordId: input.recordId,
  targetFieldId: input.targetFieldId,
  workflowContentHash: input.workflowContentHash,
  workflowRevision: input.workflowRevision,
  workflowSpecId: input.workflowSpecId,
  workspaceId: input.workspaceId,
});

const sameCacheIdentity = (
  left: RecipeCellCacheIdentity,
  right: RecipeCellCacheIdentity
): boolean =>
  left.datasetId === right.datasetId &&
  left.inputHash === right.inputHash &&
  left.recipeId === right.recipeId &&
  left.recipeRevision === right.recipeRevision &&
  left.recordContentHash === right.recordContentHash &&
  left.recordId === right.recordId &&
  left.targetFieldId === right.targetFieldId &&
  left.workflowContentHash === right.workflowContentHash &&
  left.workflowRevision === right.workflowRevision &&
  left.workflowSpecId === right.workflowSpecId &&
  left.workspaceId === right.workspaceId;

const prepareFromCache = async (
  unitOfWork: RecipePersistenceUnitOfWork,
  scope: WorkspaceScope,
  input: ExactRecipeCellInput,
  cache: RecipeCellCacheSnapshot
): Promise<PrepareRecipeCellResult> => {
  if (
    cache.cacheKey !== input.cacheKey ||
    !sameCacheIdentity(cache.cacheIdentity, cacheIdentityFor(input))
  ) {
    return fail({
      code: "cache-identity-mismatch",
      message:
        "The recipe cache slot does not match the exact cell input identity.",
    });
  }
  const { validCellResultId, validUntil } = cache;
  if (validCellResultId !== undefined && validUntil !== undefined) {
    const pinned = await unitOfWork.cachedBindings.pinCached(
      scope,
      input,
      validCellResultId
    );
    if (pinned) {
      return succeed({
        cellResultId: validCellResultId,
        input,
        status: "cached",
      });
    }
  }
  if (cache.activeCellResultId !== undefined) {
    await unitOfWork.cachedBindings.pinActive(
      scope,
      input,
      cache.activeCellResultId
    );
    return succeed({
      cellResultId: cache.activeCellResultId,
      input,
      status: "active",
    });
  }
  return succeed({ input, status: "ready" });
};

export const prepareRecipeCellInUnitOfWork = async (
  input: PrepareRecipeCellInUnitOfWorkInput
): Promise<PrepareRecipeCellResult> => {
  const { request, scope, unitOfWork } = input;
  const existing = await unitOfWork.applicationCells.get(
    scope,
    request.recipeApplicationId,
    request.recordId
  );
  if (existing !== undefined) {
    return succeed({ projection: existing, status: "bound" });
  }

  const exactInput = await unitOfWork.inputs.resolveExact(
    scope,
    request.recipeApplicationId,
    request.recordId
  );
  if (
    exactInput === undefined ||
    exactInput.workspaceId !== scope.workspaceId
  ) {
    return fail({
      code: "recipe-cell-input-not-found",
      message: "The exact recipe cell input does not exist in this workspace.",
    });
  }
  const cache = await unitOfWork.cache.getForUpdate(scope, exactInput.cacheKey);
  if (cache === undefined) {
    return succeed({ input: exactInput, status: "ready" });
  }
  return prepareFromCache(unitOfWork, scope, exactInput, cache);
};

export const makePrepareRecipeCell = (
  dependencies: PrepareRecipeCellDependencies
) =>
  function prepareRecipeCell(
    request: PrepareRecipeCellRequest
  ): Promise<DomainResult<PrepareRecipeCellSuccess, PrepareRecipeCellFailure>> {
    if (!request.actor.permissions.includes(dependencies.requiredPermission)) {
      return Promise.resolve(
        fail({
          code: "authority-permission-missing",
          message:
            "The authenticated actor lacks permission to prepare recipe cells.",
        })
      );
    }
    const scope = { workspaceId: request.actor.workspaceId } as const;
    return dependencies.persistence.transaction(scope, (unitOfWork) =>
      prepareRecipeCellInUnitOfWork({ request, scope, unitOfWork })
    );
  };
