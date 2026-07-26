import {
  type CellResultStatus,
  type ContentHash,
  type CorrelationId,
  cellResultId,
  type DomainResult,
  fail,
  type Instant,
  idempotencyKey,
  type Run,
  type RunPlanId,
  succeed,
} from "@kurobara/kernel";
import type {
  CellResultWithStatus,
  ClockPort,
  ExactRecipeCellInput,
  IdentifierPort,
  RecipeCellCacheIdentity,
  RecipeCellCacheSnapshot,
  RecipeCellRunCreationPersistencePort,
  RecipeCellRunCreationUnitOfWork,
  VerifiedApiKey,
  WorkspaceScope,
} from "@kurobara/ports";

import { canonicalContentHash } from "./canonical-content-hash.ts";
import {
  type CreateRunCommand,
  createRunInUnitOfWork,
} from "./create-run-from-plan.ts";

export type CreateRecipeCellRunRequest = Readonly<{
  actor: VerifiedApiKey;
  correlationId: CorrelationId;
  input: ExactRecipeCellInput;
  inputId: string;
  planHash: ContentHash;
  runPlanId: RunPlanId;
}>;

export type CreateRecipeCellRunFailureCode =
  | "authority-permission-missing"
  | "cache-identity-mismatch"
  | "input-id-required"
  | "recipe-application-cell-conflict"
  | "recipe-cell-input-not-found"
  | "run-creation-rejected"
  | "run-plan-input-mismatch"
  | "run-plan-workflow-mismatch";

export type CreateRecipeCellRunFailure = Readonly<{
  code: CreateRecipeCellRunFailureCode;
  message: string;
  domainCode?: string;
}>;

export type CreateRecipeCellRunSuccess =
  | Readonly<{
      cellResultId: CellResultWithStatus<"pending">["cellResultId"];
      replayed: boolean;
      run: Run;
      status: "created";
    }>
  | Readonly<{
      cellResultId: CellResultWithStatus<"pending">["cellResultId"];
      status: "active" | "cached";
    }>
  | Readonly<{
      cellResultId: CellResultWithStatus<"pending">["cellResultId"];
      cellResultStatus: CellResultStatus;
      status: "bound";
    }>;

export type CreateRecipeCellRunDependencies = Readonly<{
  clock: ClockPort;
  identifiers: IdentifierPort;
  persistence: RecipeCellRunCreationPersistencePort;
  requiredPermission: string;
}>;

type CreateRecipeCellRunResult = DomainResult<
  CreateRecipeCellRunSuccess,
  CreateRecipeCellRunFailure
>;

export type CreateRecipeCellRunInUnitOfWorkInput = Readonly<{
  dependencies: Pick<
    CreateRecipeCellRunDependencies,
    "clock" | "identifiers" | "requiredPermission"
  >;
  request: CreateRecipeCellRunRequest;
  scope: WorkspaceScope;
  unitOfWork: RecipeCellRunCreationUnitOfWork;
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

const exactInputMatches = (
  left: ExactRecipeCellInput,
  right: ExactRecipeCellInput
): boolean => canonicalContentHash(left) === canonicalContentHash(right);

const deterministicCellResultId = (input: ExactRecipeCellInput) => {
  const hash = canonicalContentHash({
    cacheKey: input.cacheKey,
    recipeApplicationId: input.recipeApplicationId,
    recordId: input.recordId,
  });
  return cellResultId(`cell_${hash.slice("sha256:".length)}`);
};

const runCommand = (request: CreateRecipeCellRunRequest): CreateRunCommand => ({
  actorId: request.actor.actorId,
  actorPermissions: request.actor.permissions,
  authenticationMode: request.actor.authenticationMode,
  correlationId: request.correlationId,
  idempotencyKey: idempotencyKey(
    `recipe-cell:${request.input.recipeApplicationId}:${request.input.cacheKey}`
  ),
  intentionHash: request.planHash,
  runPlanId: request.runPlanId,
  workspaceId: request.actor.workspaceId,
});

const resolveExistingApplicationCell = async (
  unitOfWork: RecipeCellRunCreationUnitOfWork,
  scope: WorkspaceScope,
  input: ExactRecipeCellInput
): Promise<CreateRecipeCellRunResult | undefined> => {
  const priorBinding = await unitOfWork.applicationCells.get(
    scope,
    input.recipeApplicationId,
    input.recordId
  );
  if (priorBinding === undefined) {
    return;
  }
  if (
    priorBinding.recordContentHash !== input.recordContentHash ||
    priorBinding.cellResult.enrichmentRecipeId !== input.recipeId ||
    priorBinding.cellResult.recipeRevision !== input.recipeRevision ||
    priorBinding.cellResult.fieldId !== input.targetFieldId
  ) {
    return fail({
      code: "recipe-application-cell-conflict",
      message:
        "The immutable application cell is already bound to another exact result.",
    });
  }
  return succeed({
    cellResultId: priorBinding.cellResult.cellResultId,
    cellResultStatus: priorBinding.cellResult.status,
    status: "bound",
  });
};

const resolveCachedApplicationCell = async (
  unitOfWork: RecipeCellRunCreationUnitOfWork,
  scope: WorkspaceScope,
  input: ExactRecipeCellInput,
  cache: RecipeCellCacheSnapshot | undefined
): Promise<CreateRecipeCellRunResult | undefined> => {
  if (cache === undefined) {
    return;
  }
  if (
    cache.cacheKey !== input.cacheKey ||
    canonicalContentHash(cache.cacheIdentity) !==
      canonicalContentHash(cacheIdentityFor(input))
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
      return succeed({ cellResultId: validCellResultId, status: "cached" });
    }
  }
  if (cache.activeCellResultId === undefined) {
    return;
  }
  await unitOfWork.cachedBindings.pinActive(
    scope,
    input,
    cache.activeCellResultId
  );
  return succeed({
    cellResultId: cache.activeCellResultId,
    status: "active",
  });
};

const createAndBindRecipeCellRun = async (
  dependencies: Pick<
    CreateRecipeCellRunDependencies,
    "identifiers" | "requiredPermission"
  >,
  unitOfWork: RecipeCellRunCreationUnitOfWork,
  scope: WorkspaceScope,
  request: CreateRecipeCellRunRequest,
  input: ExactRecipeCellInput,
  now: Instant
): Promise<CreateRecipeCellRunResult> => {
  const creation = await createRunInUnitOfWork({
    command: runCommand(request),
    dependencies: {
      identifiers: dependencies.identifiers,
      requiredPermission: dependencies.requiredPermission,
    },
    expectedPlanBinding: {
      normalizedInputHash: input.inputHash,
      workflowContentHash: input.workflowContentHash,
      workflowRevision: input.workflowRevision,
      workflowSpecId: input.workflowSpecId,
    },
    now,
    unitOfWork,
  });
  if (!creation.ok) {
    if (
      creation.error.domainCode === "run-plan-input-mismatch" ||
      creation.error.domainCode === "run-plan-workflow-mismatch"
    ) {
      return fail({
        code: creation.error.domainCode,
        message: creation.error.message,
      });
    }
    return fail({
      code: "run-creation-rejected",
      domainCode: creation.error.domainCode ?? creation.error.code,
      message: creation.error.message,
    });
  }
  const pending: CellResultWithStatus<"pending"> = {
    cellResultId: deterministicCellResultId(input),
    datasetId: input.datasetId,
    enrichmentRecipeId: input.recipeId,
    fieldId: input.targetFieldId,
    recipeRevision: input.recipeRevision,
    recordId: input.recordId,
    runId: creation.value.run.runId,
    status: "pending",
    workspaceId: input.workspaceId,
  };
  await unitOfWork.runCreation.bindPending(scope, {
    applicationBinding: "executed",
    cellResult: pending,
    input,
    inputId: request.inputId,
    runPlanId: request.runPlanId,
  });
  return succeed({
    cellResultId: pending.cellResultId,
    replayed: creation.value.replayed,
    run: creation.value.run,
    status: "created",
  });
};

export const createRecipeCellRunInUnitOfWork = async (
  input: CreateRecipeCellRunInUnitOfWorkInput
): Promise<CreateRecipeCellRunResult> => {
  const { dependencies, request, scope, unitOfWork } = input;
  if (!request.actor.permissions.includes(dependencies.requiredPermission)) {
    return fail({
      code: "authority-permission-missing",
      message:
        "The authenticated actor lacks permission to create recipe-cell runs.",
    });
  }
  if (request.inputId.trim().length === 0) {
    return fail({
      code: "input-id-required",
      message: "A recipe-cell run requires an exact persisted input identity.",
    });
  }
  if (
    request.input.workspaceId !== request.actor.workspaceId ||
    scope.workspaceId !== request.actor.workspaceId
  ) {
    return fail({
      code: "recipe-cell-input-not-found",
      message: "The exact recipe cell input does not exist in this workspace.",
    });
  }

  const storedInput = await unitOfWork.inputs.resolveExact(
    scope,
    request.input.recipeApplicationId,
    request.input.recordId
  );
  if (
    storedInput === undefined ||
    !exactInputMatches(storedInput, request.input)
  ) {
    return fail({
      code: "recipe-cell-input-not-found",
      message:
        "The requested cell does not match the exact stored recipe input.",
    });
  }
  const bound = await resolveExistingApplicationCell(
    unitOfWork,
    scope,
    storedInput
  );
  if (bound !== undefined) {
    return bound;
  }
  const cache = await unitOfWork.cache.getForUpdate(
    scope,
    storedInput.cacheKey
  );
  const cached = await resolveCachedApplicationCell(
    unitOfWork,
    scope,
    storedInput,
    cache
  );
  if (cached !== undefined) {
    return cached;
  }
  const now = await dependencies.clock.now();
  return createAndBindRecipeCellRun(
    dependencies,
    unitOfWork,
    scope,
    request,
    storedInput,
    now
  );
};

export const makeCreateRecipeCellRun = (
  dependencies: CreateRecipeCellRunDependencies
) =>
  function createRecipeCellRun(
    request: CreateRecipeCellRunRequest
  ): Promise<CreateRecipeCellRunResult> {
    if (!request.actor.permissions.includes(dependencies.requiredPermission)) {
      return Promise.resolve(
        fail({
          code: "authority-permission-missing",
          message:
            "The authenticated actor lacks permission to create recipe-cell runs.",
        })
      );
    }
    if (request.inputId.trim().length === 0) {
      return Promise.resolve(
        fail({
          code: "input-id-required",
          message:
            "A recipe-cell run requires an exact persisted input identity.",
        })
      );
    }
    if (request.input.workspaceId !== request.actor.workspaceId) {
      return Promise.resolve(
        fail({
          code: "recipe-cell-input-not-found",
          message:
            "The exact recipe cell input does not exist in this workspace.",
        })
      );
    }
    const scope = { workspaceId: request.actor.workspaceId } as const;
    return dependencies.persistence.transaction(scope, (unitOfWork) =>
      createRecipeCellRunInUnitOfWork({
        dependencies,
        request,
        scope,
        unitOfWork,
      })
    );
  };
