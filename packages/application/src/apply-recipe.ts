import {
  type CorrelationId,
  type DomainResult,
  type EnrichmentRecipe,
  fail,
  type RecordId,
  succeed,
} from "@kurobara/kernel";
import type {
  CapabilityRouteCatalogPort,
  ClockPort,
  DatasetPersistencePort,
  IdentifierPort,
  InputContractValidatorPort,
  PlanningIdentifierPort,
  RecipeApplication,
  RecipeApplicationAggregateBudget,
  RecipeApplicationId,
  RecipeApplyPersistencePort,
  RecipePersistencePort,
  VerifiedApiKey,
  WorkspaceScope,
} from "@kurobara/ports";

import {
  MAX_RECIPE_APPLICATION_CELLS,
  makeCreateRecipeApplication,
  type RecipeApplicationIdentifierPort,
} from "./create-recipe-application.ts";
import { createRecipeCellRunInUnitOfWork } from "./create-recipe-cell-run.ts";
import { prepareRecipeCellInUnitOfWork } from "./prepare-recipe-cell.ts";
import { quoteRunPlanInUnitOfWork } from "./quote-run-plan.ts";
import { makeRegisterEnrichmentRecipe } from "./register-enrichment-recipe.ts";

const APPLY_PERMISSION = "recipes:apply";
const PLAN_QUOTE_PERMISSION = "plans:quote";
const REGISTER_PERMISSION = "recipes:register";
const REQUIRED_PERMISSIONS = [
  REGISTER_PERMISSION,
  APPLY_PERMISSION,
  PLAN_QUOTE_PERMISSION,
] as const;

export type ApplyRecipeRequest = Readonly<{
  actor: VerifiedApiKey;
  aggregateBudget?: RecipeApplicationAggregateBudget;
  applicationId: RecipeApplicationId;
  authorityEnvelopeId: string;
  cellBudget: Readonly<{ limit: number; unit: string }>;
  correlationId: CorrelationId;
  deadlineMs: number;
  maxCells: number;
  recordIds?: readonly RecordId[];
  recipe: EnrichmentRecipe;
}>;

export type ApplyRecipeCounts = Readonly<{
  active: number;
  bound: number;
  cached: number;
  createdRun: number;
  total: number;
}>;

export type ApplyRecipeSuccess = Readonly<{
  application: RecipeApplication;
  applicationReplayed: boolean;
  counts: ApplyRecipeCounts;
  recipeReplayed: boolean;
}>;

export type ApplyRecipeFailureCode =
  | "authority-permission-missing"
  | "aggregate-budget-exceeded"
  | "request-invalid"
  | "workspace-mismatch"
  | "recipe-registration-rejected"
  | "recipe-application-rejected"
  | "recipe-cell-preparation-rejected"
  | "recipe-cell-quote-rejected"
  | "recipe-cell-run-rejected"
  | "recipe-apply-invariant";

export type ApplyRecipeFailure = Readonly<{
  code: ApplyRecipeFailureCode;
  domainCode?: string;
  message: string;
  recordId?: string;
}>;

export type ApplyRecipeDependencies = Readonly<{
  applicationIdentifiers: RecipeApplicationIdentifierPort;
  clock: ClockPort;
  datasets: DatasetPersistencePort;
  identifiers: IdentifierPort;
  inputValidator: InputContractValidatorPort;
  persistence: RecipeApplyPersistencePort;
  planningIdentifiers: PlanningIdentifierPort;
  recipes: RecipePersistencePort;
  routes: CapabilityRouteCatalogPort;
}>;

type ApplyRecipeResult = DomainResult<ApplyRecipeSuccess, ApplyRecipeFailure>;
type AppliedCellStatus = "active" | "bound" | "cached" | "created";

class RecipeCellTransactionRollback extends Error {
  readonly failure: ApplyRecipeFailure;

  constructor(failure: ApplyRecipeFailure) {
    super("The recipe-cell transaction must roll back.");
    this.failure = failure;
  }
}

const rejected = (
  code: ApplyRecipeFailureCode,
  message: string,
  options: Readonly<{ domainCode?: string; recordId?: string }> = {}
): DomainResult<never, ApplyRecipeFailure> =>
  fail({
    code,
    ...(options.domainCode === undefined
      ? {}
      : { domainCode: options.domainCode }),
    message,
    ...(options.recordId === undefined ? {} : { recordId: options.recordId }),
  });

const isApplicationIdValid = (applicationId: string): boolean =>
  applicationId.length > 0 &&
  applicationId.length <= 255 &&
  applicationId.trim() === applicationId;

const validateRequest = (
  request: ApplyRecipeRequest
): ApplyRecipeFailure | undefined => {
  const missingPermission = REQUIRED_PERMISSIONS.find(
    (permission) => !request.actor.permissions.includes(permission)
  );
  if (missingPermission !== undefined) {
    return {
      code: "authority-permission-missing",
      domainCode: missingPermission,
      message:
        "The authenticated actor lacks a permission required to apply the recipe.",
    };
  }
  if (request.recipe.workspaceId !== request.actor.workspaceId) {
    return {
      code: "workspace-mismatch",
      message:
        "The authenticated actor and recipe belong to different workspaces.",
    };
  }
  if (
    !isApplicationIdValid(request.applicationId) ||
    request.authorityEnvelopeId.trim().length === 0 ||
    request.authorityEnvelopeId.trim() !== request.authorityEnvelopeId ||
    !Number.isSafeInteger(request.deadlineMs) ||
    request.deadlineMs < 0 ||
    !Number.isSafeInteger(request.maxCells) ||
    request.maxCells <= 0 ||
    request.maxCells > MAX_RECIPE_APPLICATION_CELLS ||
    !Number.isFinite(request.cellBudget.limit) ||
    request.cellBudget.limit < 0 ||
    request.cellBudget.unit.trim().length === 0 ||
    request.cellBudget.unit.trim() !== request.cellBudget.unit
  ) {
    return {
      code: "request-invalid",
      message: "The aggregate recipe apply request contains an invalid value.",
    };
  }
  if (request.recordIds !== undefined) {
    const aggregateBudget = request.aggregateBudget;
    const worstCase = request.cellBudget.limit * request.recordIds.length;
    if (
      aggregateBudget === undefined ||
      aggregateBudget.unit !== request.cellBudget.unit ||
      !Number.isFinite(aggregateBudget.limit) ||
      aggregateBudget.limit < 0 ||
      aggregateBudget.unit.length === 0 ||
      aggregateBudget.unit.length > 64 ||
      aggregateBudget.unit.trim() !== aggregateBudget.unit
    ) {
      return {
        code: "request-invalid",
        message:
          "An exact recipe selection requires an aggregate budget in the same unit as its per-cell budget.",
      };
    }
    if (!Number.isFinite(worstCase) || worstCase > aggregateBudget.limit) {
      return {
        code: "aggregate-budget-exceeded",
        message:
          "The selected cells could exceed the immutable aggregate budget before any Run is created.",
      };
    }
  }
};

const applyCell = async (
  dependencies: ApplyRecipeDependencies,
  request: ApplyRecipeRequest,
  scope: WorkspaceScope,
  recordId: RecordId
): Promise<DomainResult<AppliedCellStatus, ApplyRecipeFailure>> => {
  try {
    return await dependencies.persistence.transaction(
      scope,
      async (unitOfWork) => {
        const prepared = await prepareRecipeCellInUnitOfWork({
          request: {
            actor: request.actor,
            recipeApplicationId: request.applicationId,
            recordId,
          },
          scope,
          unitOfWork,
        });
        if (!prepared.ok) {
          return rejected(
            "recipe-cell-preparation-rejected",
            prepared.error.message,
            { domainCode: prepared.error.code, recordId }
          );
        }
        if (prepared.value.status !== "ready") {
          return succeed(prepared.value.status);
        }

        const quote = await quoteRunPlanInUnitOfWork({
          dependencies: {
            clock: dependencies.clock,
            identifiers: dependencies.planningIdentifiers,
            inputValidator: dependencies.inputValidator,
            routes: dependencies.routes,
          },
          request: {
            actor: request.actor,
            authorityEnvelopeId: request.authorityEnvelopeId,
            budget: request.cellBudget,
            deadlineMs: request.deadlineMs,
            normalizedInput: prepared.value.input.normalizedInput,
            normalizedInputHash: prepared.value.input.inputHash,
            workflowContentHash: prepared.value.input.workflowContentHash,
            workflowRevision: prepared.value.input.workflowRevision,
            workflowSpecId: prepared.value.input.workflowSpecId,
            workspaceId: scope.workspaceId,
          },
          scope,
          unitOfWork: unitOfWork.planning,
        });
        if (!quote.ok) {
          return rejected("recipe-cell-quote-rejected", quote.error.message, {
            domainCode: quote.error.domainCode ?? quote.error.code,
            recordId,
          });
        }
        if (quote.value.input === undefined) {
          throw new RecipeCellTransactionRollback({
            code: "recipe-apply-invariant",
            message:
              "The persisted recipe-cell plan did not expose its validated input.",
            recordId,
          });
        }

        const created = await createRecipeCellRunInUnitOfWork({
          dependencies: {
            clock: dependencies.clock,
            identifiers: dependencies.identifiers,
            requiredPermission: APPLY_PERMISSION,
          },
          request: {
            actor: request.actor,
            correlationId: request.correlationId,
            input: prepared.value.input,
            inputId: quote.value.input.inputId,
            planHash: quote.value.plan.planHash,
            runPlanId: quote.value.plan.runPlanId,
          },
          scope,
          unitOfWork,
        });
        if (!created.ok) {
          throw new RecipeCellTransactionRollback({
            code: "recipe-cell-run-rejected",
            domainCode: created.error.domainCode ?? created.error.code,
            message: created.error.message,
            recordId,
          });
        }
        if (created.value.status !== "created") {
          throw new RecipeCellTransactionRollback({
            code: "recipe-apply-invariant",
            message:
              "The locked recipe cell changed after its run plan was persisted.",
            recordId,
          });
        }
        return succeed("created" as const);
      }
    );
  } catch (error) {
    if (error instanceof RecipeCellTransactionRollback) {
      return fail(error.failure);
    }
    throw error;
  }
};

const applyRecipeCells = async (
  dependencies: ApplyRecipeDependencies,
  request: ApplyRecipeRequest,
  application: RecipeApplication
): Promise<DomainResult<ApplyRecipeCounts, ApplyRecipeFailure>> => {
  const counts = {
    active: 0,
    bound: 0,
    cached: 0,
    createdRun: 0,
    total: application.graph.recordIds.length,
  };
  const scope = { workspaceId: request.actor.workspaceId } as const;
  for (const recordId of application.graph.recordIds) {
    const cell = await applyCell(dependencies, request, scope, recordId);
    if (!cell.ok) {
      return fail(cell.error);
    }
    if (cell.value === "created") {
      counts.createdRun += 1;
    } else {
      counts[cell.value] += 1;
    }
  }
  return succeed(counts);
};

export const makeApplyRecipe = (dependencies: ApplyRecipeDependencies) =>
  async function applyRecipe(
    request: ApplyRecipeRequest
  ): Promise<ApplyRecipeResult> {
    const requestFailure = validateRequest(request);
    if (requestFailure !== undefined) {
      return fail(requestFailure);
    }

    const register = makeRegisterEnrichmentRecipe({
      datasets: dependencies.datasets,
      persistence: dependencies.recipes,
      requiredPermission: REGISTER_PERMISSION,
    });
    const registered = await register({
      actor: request.actor,
      datasetId: request.recipe.datasetId,
      recipe: request.recipe,
    });
    if (!registered.ok) {
      return rejected(
        "recipe-registration-rejected",
        registered.error.message,
        { domainCode: registered.error.domainCode ?? registered.error.code }
      );
    }

    const createApplication = makeCreateRecipeApplication({
      clock: dependencies.clock,
      datasets: dependencies.datasets,
      identifiers: dependencies.applicationIdentifiers,
      persistence: dependencies.recipes,
      requiredPermission: APPLY_PERMISSION,
    });
    const createdApplication = await createApplication({
      actor: request.actor,
      ...(request.aggregateBudget === undefined
        ? {}
        : { aggregateBudget: { ...request.aggregateBudget } }),
      datasetId: registered.value.recipe.datasetId,
      maxCells: request.maxCells,
      ...(request.recordIds === undefined
        ? {}
        : { recordIds: [...request.recordIds] }),
      recipeApplicationId: request.applicationId,
      recipeId: registered.value.recipe.enrichmentRecipeId,
      recipeRevision: registered.value.recipe.recipeRevision,
    });
    if (!createdApplication.ok) {
      return rejected(
        "recipe-application-rejected",
        createdApplication.error.message,
        {
          domainCode: createdApplication.error.code,
          ...(createdApplication.error.recordId === undefined
            ? {}
            : { recordId: createdApplication.error.recordId }),
        }
      );
    }

    const applied = await applyRecipeCells(
      dependencies,
      request,
      createdApplication.value.application
    );
    if (!applied.ok) {
      return applied;
    }

    return succeed({
      application: createdApplication.value.application,
      applicationReplayed: createdApplication.value.replayed,
      counts: applied.value,
      recipeReplayed: registered.value.replayed,
    });
  };
