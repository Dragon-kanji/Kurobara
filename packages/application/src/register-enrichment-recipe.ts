import {
  createEnrichmentRecipe,
  type DatasetId,
  type DomainResult,
  type EnrichmentRecipe,
  fail,
  succeed,
} from "@kurobara/kernel";
import type {
  DatasetPersistencePort,
  RecipePersistencePort,
  VerifiedApiKey,
} from "@kurobara/ports";

export type RegisterEnrichmentRecipeRequest = Readonly<{
  actor: VerifiedApiKey;
  datasetId: DatasetId;
  recipe: EnrichmentRecipe;
}>;

export type RegisterEnrichmentRecipeFailureCode =
  | "authority-permission-missing"
  | "dataset-not-ready"
  | "dataset-not-found"
  | "recipe-domain-rejected"
  | "recipe-revision-conflict";

export type RegisterEnrichmentRecipeFailure = Readonly<{
  code: RegisterEnrichmentRecipeFailureCode;
  message: string;
  domainCode?: string;
}>;

export type RegisterEnrichmentRecipeSuccess = Readonly<{
  recipe: EnrichmentRecipe;
  replayed: boolean;
}>;

export type RegisterEnrichmentRecipeDependencies = Readonly<{
  datasets: DatasetPersistencePort;
  persistence: RecipePersistencePort;
  requiredPermission: string;
}>;

const cloneRecipe = (recipe: EnrichmentRecipe): EnrichmentRecipe => ({
  ...recipe,
  inputFieldIds: [...recipe.inputFieldIds],
});

const recipesAreExactlyEqual = (
  left: EnrichmentRecipe,
  right: EnrichmentRecipe
): boolean =>
  left.datasetId === right.datasetId &&
  left.enrichmentRecipeId === right.enrichmentRecipeId &&
  left.inputFieldIds.length === right.inputFieldIds.length &&
  left.inputFieldIds.every(
    (fieldId, index) => fieldId === right.inputFieldIds[index]
  ) &&
  left.name === right.name &&
  left.recipeRevision === right.recipeRevision &&
  left.targetFieldId === right.targetFieldId &&
  left.workflowContentHash === right.workflowContentHash &&
  left.workflowRevision === right.workflowRevision &&
  left.workflowSpecId === right.workflowSpecId &&
  left.workspaceId === right.workspaceId;

export const makeRegisterEnrichmentRecipe = (
  dependencies: RegisterEnrichmentRecipeDependencies
) =>
  async function registerEnrichmentRecipe(
    request: RegisterEnrichmentRecipeRequest
  ): Promise<
    DomainResult<
      RegisterEnrichmentRecipeSuccess,
      RegisterEnrichmentRecipeFailure
    >
  > {
    if (!request.actor.permissions.includes(dependencies.requiredPermission)) {
      return fail({
        code: "authority-permission-missing",
        message:
          "The authenticated actor lacks permission to register enrichment recipes.",
      });
    }

    const scope = { workspaceId: request.actor.workspaceId } as const;
    const stored = await dependencies.datasets.getDataset(
      scope,
      request.datasetId
    );
    if (
      stored === undefined ||
      stored.dataset.workspaceId !== scope.workspaceId ||
      stored.dataset.datasetId !== request.datasetId ||
      stored.materialization.workspaceId !== scope.workspaceId ||
      stored.materialization.datasetId !== request.datasetId
    ) {
      return fail({
        code: "dataset-not-found",
        message: "The dataset does not exist in this workspace.",
      });
    }
    if (stored.materialization.state !== "ready") {
      return fail({
        code: "dataset-not-ready",
        message:
          "An enrichment recipe can be registered only from a ready dataset materialization.",
      });
    }

    const created = createEnrichmentRecipe(
      stored.dataset,
      stored.fields,
      request.recipe
    );
    if (!created.ok) {
      return fail({
        code: "recipe-domain-rejected",
        domainCode: created.error.code,
        message: created.error.message,
      });
    }

    return dependencies.persistence.transaction(scope, async (unitOfWork) => {
      const existing = await unitOfWork.recipes.get(
        scope,
        created.value.datasetId,
        created.value.enrichmentRecipeId,
        created.value.recipeRevision
      );
      if (existing !== undefined) {
        if (!recipesAreExactlyEqual(existing, created.value)) {
          return fail({
            code: "recipe-revision-conflict",
            message:
              "The recipe identity and revision already resolve to different immutable content.",
          });
        }
        return succeed({ recipe: cloneRecipe(existing), replayed: true });
      }

      await unitOfWork.recipes.register(scope, created.value);
      return succeed({ recipe: cloneRecipe(created.value), replayed: false });
    });
  };
