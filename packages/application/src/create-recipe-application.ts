import {
  type DatasetId,
  type Record as DatasetRecord,
  type DomainResult,
  type EnrichmentRecipeId,
  fail,
  type RecordId,
  succeed,
} from "@kurobara/kernel";
import type {
  ClockPort,
  DatasetPersistencePort,
  RecipeApplication,
  RecipeApplicationAggregateBudget,
  RecipeApplicationGraph,
  RecipeApplicationId,
  RecipePersistencePort,
  VerifiedApiKey,
} from "@kurobara/ports";
import { canonicalContentHash } from "./canonical-content-hash.ts";

export const MAX_RECIPE_APPLICATION_CELLS = 10_000;

const BUDGET_UNIT_PATTERN = /^[a-z][a-z0-9._-]*$/u;

export type RecipeApplicationIdentifierPort = Readonly<{
  nextRecipeApplicationId(): Promise<RecipeApplicationId>;
}>;

export type CreateRecipeApplicationRequest = Readonly<{
  actor: VerifiedApiKey;
  aggregateBudget?: RecipeApplicationAggregateBudget;
  datasetId: DatasetId;
  maxCells: number;
  recordIds?: readonly RecordId[];
  recipeApplicationId?: RecipeApplicationId;
  recipeId: EnrichmentRecipeId;
  recipeRevision: string;
}>;

export type CreateRecipeApplicationFailureCode =
  | "authority-permission-missing"
  | "dataset-not-ready"
  | "dataset-not-found"
  | "record-duplicate"
  | "record-not-found"
  | "record-selection-duplicate"
  | "record-selection-invalid"
  | "record-scope-mismatch"
  | "recipe-application-conflict"
  | "recipe-application-empty"
  | "recipe-application-id-invalid"
  | "recipe-application-limit-exceeded"
  | "recipe-application-limit-invalid"
  | "recipe-not-found";

export type CreateRecipeApplicationFailure = Readonly<{
  code: CreateRecipeApplicationFailureCode;
  message: string;
  recordId?: string;
}>;

export type CreateRecipeApplicationSuccess = Readonly<{
  application: RecipeApplication;
  replayed: boolean;
}>;

export type CreateRecipeApplicationDependencies = Readonly<{
  clock: ClockPort;
  datasets: DatasetPersistencePort;
  identifiers: RecipeApplicationIdentifierPort;
  persistence: RecipePersistencePort;
  requiredPermission: string;
}>;

const cloneApplication = (
  application: RecipeApplication
): RecipeApplication => ({
  ...application,
  ...(application.aggregateBudget === undefined
    ? {}
    : { aggregateBudget: { ...application.aggregateBudget } }),
  graph: { recordIds: [...application.graph.recordIds] },
});

const applicationsHaveExactIntent = (
  existing: RecipeApplication,
  requested: Omit<RecipeApplication, "createdAt">
): boolean =>
  existing.aggregateBudget?.limit === requested.aggregateBudget?.limit &&
  existing.aggregateBudget?.unit === requested.aggregateBudget?.unit &&
  existing.datasetId === requested.datasetId &&
  existing.graph.recordIds.length === requested.graph.recordIds.length &&
  existing.graph.recordIds.every(
    (recordId, index) => recordId === requested.graph.recordIds[index]
  ) &&
  existing.graphHash === requested.graphHash &&
  existing.intentHash === requested.intentHash &&
  existing.maxCells === requested.maxCells &&
  existing.recipeApplicationId === requested.recipeApplicationId &&
  existing.recipeId === requested.recipeId &&
  existing.recipeRevision === requested.recipeRevision &&
  existing.targetFieldId === requested.targetFieldId &&
  existing.workspaceId === requested.workspaceId;

const suppliedApplicationIdIsValid = (
  recipeApplicationId: RecipeApplicationId | undefined
): boolean =>
  recipeApplicationId === undefined ||
  (recipeApplicationId.trim() === recipeApplicationId &&
    recipeApplicationId.length > 0 &&
    recipeApplicationId.length <= 255);

const aggregateBudgetIsValid = (
  budget: RecipeApplicationAggregateBudget | undefined
): boolean =>
  budget === undefined ||
  (Number.isFinite(budget.limit) &&
    budget.limit >= 0 &&
    budget.unit.length > 0 &&
    budget.unit.length <= 64 &&
    budget.unit.trim() === budget.unit &&
    BUDGET_UNIT_PATTERN.test(budget.unit));

const validateCreateRequest = (
  request: CreateRecipeApplicationRequest,
  requiredPermission: string
): CreateRecipeApplicationFailure | undefined => {
  if (!request.actor.permissions.includes(requiredPermission)) {
    return {
      code: "authority-permission-missing",
      message:
        "The authenticated actor lacks permission to create recipe applications.",
    };
  }
  if (
    !Number.isSafeInteger(request.maxCells) ||
    request.maxCells <= 0 ||
    request.maxCells > MAX_RECIPE_APPLICATION_CELLS
  ) {
    return {
      code: "recipe-application-limit-invalid",
      message: `Recipe applications require a positive cell limit no greater than ${MAX_RECIPE_APPLICATION_CELLS}.`,
    };
  }
  if (
    request.recordIds !== undefined &&
    (!Array.isArray(request.recordIds) ||
      request.recordIds.length === 0 ||
      request.recordIds.length > request.maxCells ||
      request.recordIds.some(
        (recordIdentity) =>
          typeof recordIdentity !== "string" ||
          recordIdentity.length === 0 ||
          recordIdentity.length > 255 ||
          recordIdentity.trim() !== recordIdentity
      ))
  ) {
    return {
      code: "record-selection-invalid",
      message:
        "An exact recipe selection requires 1 to maxCells bounded record identities.",
    };
  }
  if (
    request.recordIds !== undefined &&
    new Set(request.recordIds).size !== request.recordIds.length
  ) {
    return {
      code: "record-selection-duplicate",
      message:
        "An exact recipe selection cannot contain duplicate record identities.",
    };
  }
  if (!suppliedApplicationIdIsValid(request.recipeApplicationId)) {
    return {
      code: "recipe-application-id-invalid",
      message:
        "A supplied recipe application identity must contain 1 to 255 non-whitespace-delimited characters.",
    };
  }
  if (!aggregateBudgetIsValid(request.aggregateBudget)) {
    return {
      code: "recipe-application-limit-invalid",
      message:
        "A recipe application aggregate budget requires a non-negative finite limit and a canonical unit.",
    };
  }
};

interface RecordCollection {
  readonly recordIds: RecordId[];
  readonly requested: ReadonlySet<RecordId> | undefined;
  readonly seen: Set<RecordId>;
  readonly selected: Map<RecordId, RecordId>;
}

const collectStoredRecord = (
  collection: RecordCollection,
  record: DatasetRecord,
  request: CreateRecipeApplicationRequest
): CreateRecipeApplicationFailure | undefined => {
  if (
    record.workspaceId !== request.actor.workspaceId ||
    record.datasetId !== request.datasetId
  ) {
    return {
      code: "record-scope-mismatch",
      message:
        "Every recipe-application record must belong to the requested dataset scope.",
      recordId: record.recordId,
    };
  }
  if (collection.seen.has(record.recordId)) {
    return {
      code: "record-duplicate",
      message:
        "A recipe application cannot contain the same record identity twice.",
      recordId: record.recordId,
    };
  }
  collection.seen.add(record.recordId);
  if (collection.requested?.has(record.recordId) === false) {
    return;
  }
  if (
    collection.requested === undefined &&
    collection.recordIds.length >= request.maxCells
  ) {
    return {
      code: "recipe-application-limit-exceeded",
      message: `The dataset contains more than the allowed ${request.maxCells} recipe cells.`,
    };
  }
  if (collection.requested === undefined) {
    collection.recordIds.push(record.recordId);
  } else {
    collection.selected.set(record.recordId, record.recordId);
  }
};

const appendRequestedRecordIds = (
  requestedRecordIds: readonly RecordId[] | undefined,
  collection: RecordCollection
): CreateRecipeApplicationFailure | undefined => {
  if (requestedRecordIds === undefined) {
    return;
  }
  for (const requestedRecordId of requestedRecordIds) {
    const storedRecordId = collection.selected.get(requestedRecordId);
    if (storedRecordId === undefined) {
      return {
        code: "record-not-found",
        message:
          "Every selected recipe-application record must exist in the requested dataset scope.",
        recordId: requestedRecordId,
      };
    }
    collection.recordIds.push(storedRecordId);
  }
};

const collectRecordIds = async (
  dependencies: CreateRecipeApplicationDependencies,
  request: CreateRecipeApplicationRequest
): Promise<
  DomainResult<readonly RecordId[], CreateRecipeApplicationFailure>
> => {
  const scope = { workspaceId: request.actor.workspaceId } as const;
  const requestedRecordIds = request.recordIds;
  const requested =
    requestedRecordIds === undefined
      ? undefined
      : new Set<RecordId>(requestedRecordIds);
  const collection: RecordCollection = {
    recordIds: [],
    requested,
    seen: new Set<RecordId>(),
    selected: new Map<RecordId, RecordId>(),
  };
  for await (const record of dependencies.datasets.streamRecords(
    scope,
    request.datasetId
  )) {
    const failure = collectStoredRecord(collection, record, request);
    if (failure !== undefined) {
      return fail(failure);
    }
  }
  const selectionFailure = appendRequestedRecordIds(
    requestedRecordIds,
    collection
  );
  if (selectionFailure !== undefined) {
    return fail(selectionFailure);
  }
  if (collection.recordIds.length === 0) {
    return fail({
      code: "recipe-application-empty",
      message: "A recipe application requires at least one dataset record.",
    });
  }
  return succeed(collection.recordIds);
};

export const makeCreateRecipeApplication = (
  dependencies: CreateRecipeApplicationDependencies
) =>
  async function createRecipeApplication(
    request: CreateRecipeApplicationRequest
  ): Promise<
    DomainResult<CreateRecipeApplicationSuccess, CreateRecipeApplicationFailure>
  > {
    const requestFailure = validateCreateRequest(
      request,
      dependencies.requiredPermission
    );
    if (requestFailure !== undefined) {
      return fail(requestFailure);
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
          "A recipe application can be created only from a ready dataset materialization.",
      });
    }

    const recordIds = await collectRecordIds(dependencies, request);
    if (!recordIds.ok) {
      return recordIds;
    }

    const recipeApplicationIdPromise: Promise<RecipeApplicationId> =
      request.recipeApplicationId === undefined
        ? dependencies.identifiers.nextRecipeApplicationId()
        : Promise.resolve(request.recipeApplicationId);
    const [createdAt, recipeApplicationId] = await Promise.all([
      dependencies.clock.now(),
      recipeApplicationIdPromise,
    ]);

    return dependencies.persistence.transaction(scope, async (unitOfWork) => {
      // Composite recipe flows acquire immutable identities application-first.
      // PostgreSQL also fences missing identities, so this order prevents a
      // create/export deadlock while preserving exact replay classification.
      const existing = await unitOfWork.applications.get(
        scope,
        recipeApplicationId
      );
      const recipe = await unitOfWork.recipes.get(
        scope,
        request.datasetId,
        request.recipeId,
        request.recipeRevision
      );
      if (
        recipe === undefined ||
        recipe.workspaceId !== scope.workspaceId ||
        recipe.datasetId !== request.datasetId ||
        recipe.enrichmentRecipeId !== request.recipeId ||
        recipe.recipeRevision !== request.recipeRevision
      ) {
        return fail({
          code: "recipe-not-found",
          message:
            "The exact enrichment recipe revision does not exist in this dataset scope.",
        });
      }

      const graph: RecipeApplicationGraph = {
        recordIds: [...recordIds.value],
      };
      const graphHash = canonicalContentHash(graph);
      const intentEvidence = {
        ...(request.aggregateBudget === undefined
          ? {}
          : { aggregateBudget: { ...request.aggregateBudget } }),
        datasetId: request.datasetId,
        graphHash,
        maxCells: request.maxCells,
        recipeId: recipe.enrichmentRecipeId,
        recipeRevision: recipe.recipeRevision,
        targetFieldId: recipe.targetFieldId,
        workspaceId: scope.workspaceId,
      } as const;
      const application: RecipeApplication = {
        ...(request.aggregateBudget === undefined
          ? {}
          : { aggregateBudget: { ...request.aggregateBudget } }),
        createdAt,
        datasetId: request.datasetId,
        graph,
        graphHash,
        intentHash: canonicalContentHash(intentEvidence),
        maxCells: request.maxCells,
        recipeApplicationId,
        recipeId: recipe.enrichmentRecipeId,
        recipeRevision: recipe.recipeRevision,
        targetFieldId: recipe.targetFieldId,
        workspaceId: scope.workspaceId,
      };

      if (existing !== undefined) {
        if (!applicationsHaveExactIntent(existing, application)) {
          return fail({
            code: "recipe-application-conflict",
            message:
              "The recipe application identity already resolves to another immutable intention.",
          });
        }
        return succeed({
          application: cloneApplication(existing),
          replayed: true,
        });
      }

      await unitOfWork.applications.register(scope, application);
      return succeed({
        application: cloneApplication(application),
        replayed: false,
      });
    });
  };
