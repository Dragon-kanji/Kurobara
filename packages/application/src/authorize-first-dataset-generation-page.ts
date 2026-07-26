import {
  type ActorId,
  type CorrelationId,
  type DatasetGenerationCreation,
  type DatasetGenerationPage,
  type DatasetGenerationPlan,
  type DomainResult,
  datasetGenerationAcceptedRecordLimit,
  fail,
  idempotencyKey,
  type RunPlan,
  runPlanId,
  succeed,
  validateDatasetGenerationPageSnapshot,
  validateDatasetGenerationSnapshot,
  type WorkflowSpec,
  type WorkspaceId,
  workflowSpecId,
} from "@kurobara/kernel";
import type {
  ClockPort,
  DatasetGenerationFirstPagePersistencePort,
  DatasetGenerationFirstPageUnitOfWork,
  IdentifierPort,
  NormalizedJsonValue,
  StoredDatasetGenerationPlan,
  ValidatedRunInput,
  WorkspaceScope,
} from "@kurobara/ports";

import {
  canonicalContentByteSize,
  canonicalContentHash,
} from "./canonical-content-hash.ts";
import {
  type CreateRunUseCaseFailure,
  createRunInUnitOfWork,
} from "./create-run-from-plan.ts";
import {
  type PrepareRunPlanFailure,
  prepareRunPlanDraft,
} from "./prepare-run-plan.ts";

const RUN_PERMISSION = "steps:execute";
const MAX_RUN_INPUT_BYTES = 65_536;
const PAGE_CONTRACT_VERSION = "1.0.0";
const PAGE_COMPILER_VERSION = "1.0.0";

export type DatasetGenerationPageInput = Readonly<{
  capability: DatasetGenerationPlan["requestIntent"]["capability"];
  datasetId: DatasetGenerationPlan["requestIntent"]["targetDataset"]["datasetId"];
  fields: DatasetGenerationPlan["requestIntent"]["fields"];
  generationId: DatasetGenerationPage["generationId"];
  generationPlanId: DatasetGenerationPlan["generationPlanId"];
  inputCursor: null | string;
  kind: "dataset-generation-page-input";
  limits: DatasetGenerationPlan["limits"];
  normalizedQuery: DatasetGenerationPlan["normalizedQuery"];
  pageSequence: number;
  planHash: DatasetGenerationPlan["planHash"];
  queryHash: DatasetGenerationPlan["queryHash"];
  schemaHash: DatasetGenerationPlan["schemaHash"];
  version: "1.0.0";
  workspaceId: WorkspaceId;
}>;

export type AuthorizeFirstDatasetGenerationPageRequest = Readonly<{
  actorId: ActorId;
  actorPermissions: readonly string[];
  authenticationMode: string;
  correlationId: CorrelationId;
  generationId: DatasetGenerationPage["generationId"];
  workspaceId: WorkspaceId;
}>;

export type AuthorizeFirstDatasetGenerationPageFailureCode =
  | "authority-permission-missing"
  | "budget-exhausted"
  | "deadline-elapsed"
  | "generation-not-found"
  | "generation-not-planned"
  | "generation-plan-not-found"
  | "generation-proof-invalid"
  | "idempotency-conflict"
  | "input-too-large"
  | "limit-exhausted"
  | "run-creation-rejected"
  | "run-plan-rejected"
  | "workspace-mismatch";

export type AuthorizeFirstDatasetGenerationPageFailure = Readonly<{
  code: AuthorizeFirstDatasetGenerationPageFailureCode;
  message: string;
  domainCode?: string;
}>;

export type AuthorizeFirstDatasetGenerationPageSuccess = Readonly<{
  page: DatasetGenerationPage;
  replayed: boolean;
}>;

export type AuthorizeFirstDatasetGenerationPageResult = DomainResult<
  AuthorizeFirstDatasetGenerationPageSuccess,
  AuthorizeFirstDatasetGenerationPageFailure
>;

export type AuthorizeFirstDatasetGenerationPageDependencies = Readonly<{
  clock: ClockPort;
  identifiers: IdentifierPort;
  persistence: DatasetGenerationFirstPagePersistencePort;
}>;

const invalid = (
  code: AuthorizeFirstDatasetGenerationPageFailureCode,
  message: string,
  domainCode?: string
): AuthorizeFirstDatasetGenerationPageResult =>
  fail({ code, ...(domainCode === undefined ? {} : { domainCode }), message });

const pageIdentity = (
  generationId: DatasetGenerationPage["generationId"],
  pageSequence: number
) => canonicalContentHash({ generationId, pageSequence });

const pageIdentitySuffix = (
  generationId: DatasetGenerationPage["generationId"],
  pageSequence: number
): string => pageIdentity(generationId, pageSequence).slice("sha256:".length);

export const datasetGenerationPageOutputContract = (
  plan: DatasetGenerationPlan
): DatasetGenerationPlan["queryContract"] => ({
  catalogFingerprint: plan.queryContract.catalogFingerprint,
  catalogVersion: plan.queryContract.catalogVersion,
  schemaFingerprint:
    "sha256:f61bef0f513210cf17c84fd53aad2c1624a6913a732e98597056a442bc589ab3" as DatasetGenerationPlan["queryContract"]["schemaFingerprint"],
  schemaId:
    "https://schemas.kurobara.invalid/schemas/dataset-generations/page-output/1.0.0",
  schemaVersion: PAGE_CONTRACT_VERSION,
});

export const datasetGenerationPageInputContract = (
  plan: DatasetGenerationPlan
): DatasetGenerationPlan["queryContract"] => ({
  catalogFingerprint: plan.queryContract.catalogFingerprint,
  catalogVersion: plan.queryContract.catalogVersion,
  schemaFingerprint:
    "sha256:40153b13ed33d9bf086dcfde537ce1e17946b0e82b6e0461683c42c24a382a55" as DatasetGenerationPlan["queryContract"]["schemaFingerprint"],
  schemaId:
    "https://schemas.kurobara.invalid/schemas/dataset-generations/page-input/1.0.0",
  schemaVersion: PAGE_CONTRACT_VERSION,
});

const generationPageInput = (
  generationId: DatasetGenerationPage["generationId"],
  plan: DatasetGenerationPlan,
  generation: DatasetGenerationCreation,
  pageSequence: number,
  inputCursor: null | string
): DatasetGenerationPageInput => {
  const remainingAccepted =
    datasetGenerationAcceptedRecordLimit(plan) -
    generation.generation.counters.accepted;
  const remainingReturned =
    plan.limits.maxResults - generation.generation.counters.returned;
  return {
    capability: { ...plan.requestIntent.capability },
    datasetId: plan.requestIntent.targetDataset.datasetId,
    fields: plan.requestIntent.fields.map((field) => ({ ...field })),
    generationId,
    generationPlanId: plan.generationPlanId,
    inputCursor,
    kind: "dataset-generation-page-input",
    limits: {
      ...plan.limits,
      maxResults: Math.min(remainingAccepted, remainingReturned),
    },
    normalizedQuery: structuredClone(plan.normalizedQuery),
    pageSequence,
    planHash: plan.planHash,
    queryHash: plan.queryHash,
    schemaHash: plan.schemaHash,
    version: PAGE_CONTRACT_VERSION,
    workspaceId: plan.workspaceId,
  };
};

const generationPageWorkflow = (
  generationId: DatasetGenerationPage["generationId"],
  plan: DatasetGenerationPlan,
  pageSequence: number
): WorkflowSpec => {
  const workflowSpecIdentity = workflowSpecId(
    `dataset-generation-page_${pageIdentitySuffix(generationId, pageSequence)}`
  );
  const workflowBody = {
    nodes: [
      {
        capability: { ...plan.requestIntent.capability },
        dependsOn: [] as readonly string[],
        key: "page",
      },
    ],
    revision: PAGE_CONTRACT_VERSION,
    workflowSpecId: workflowSpecIdentity,
  };
  return {
    ...workflowBody,
    contentHash: canonicalContentHash(workflowBody),
  };
};

const mapPreparationFailure = (
  failure: PrepareRunPlanFailure
): AuthorizeFirstDatasetGenerationPageFailure => {
  if (failure.code === "workflow-rejected") {
    return {
      code: "run-plan-rejected",
      domainCode: failure.compilation.code,
      message: "The canonical generation page workflow was rejected.",
    };
  }
  if (failure.code === "routing-rejected") {
    return {
      code: "run-plan-rejected",
      domainCode: "routing-snapshot-invalid",
      message: "The immutable generation routes cannot execute the first page.",
    };
  }
  return {
    code: "authority-permission-missing",
    domainCode: failure.reasonCodes.join(","),
    message: "The generation authority cannot execute the canonical page Run.",
  };
};

const mapRunFailure = (
  failure: CreateRunUseCaseFailure
): AuthorizeFirstDatasetGenerationPageFailure => ({
  code:
    failure.code === "authority-permission-missing"
      ? "authority-permission-missing"
      : "run-creation-rejected",
  domainCode: failure.domainCode ?? failure.code,
  message: failure.message,
});

const availableBudget = (plan: DatasetGenerationPlan): number =>
  plan.budget.limit - plan.budget.reserved - plan.budget.spent;

const validateCallerAuthorization = (
  request: AuthorizeFirstDatasetGenerationPageRequest,
  plan: DatasetGenerationPlan
): AuthorizeFirstDatasetGenerationPageFailure | undefined => {
  if (
    request.workspaceId !== plan.workspaceId ||
    request.actorId !== plan.authority.subjectActorId
  ) {
    return {
      code: "workspace-mismatch",
      message: "The actor, generation plan, and request must share one scope.",
    };
  }
  if (
    !(
      request.actorPermissions.includes(RUN_PERMISSION) &&
      plan.authority.permissions.includes(RUN_PERMISSION)
    )
  ) {
    return {
      code: "authority-permission-missing",
      message: `The first page Run requires ${RUN_PERMISSION}.`,
    };
  }
};

const validateAuthorization = (
  request: AuthorizeFirstDatasetGenerationPageRequest,
  plan: DatasetGenerationPlan,
  generation: DatasetGenerationCreation,
  now: Awaited<ReturnType<ClockPort["now"]>>
): AuthorizeFirstDatasetGenerationPageFailure | undefined => {
  const callerDenied = validateCallerAuthorization(request, plan);
  if (callerDenied !== undefined) {
    return callerDenied;
  }
  if (
    now >= plan.deadline ||
    now >= plan.authority.deadline ||
    now >= plan.quote.expiresAt
  ) {
    return {
      code: "deadline-elapsed",
      message: "The generation deadline or immutable quote has elapsed.",
    };
  }
  if (
    generation.generation.counters.pages >= plan.limits.maxPages ||
    generation.generation.counters.calls >= plan.limits.maxCalls ||
    generation.generation.counters.returned >= plan.limits.maxResults ||
    generation.generation.counters.accepted >=
      datasetGenerationAcceptedRecordLimit(plan)
  ) {
    return {
      code: "limit-exhausted",
      message: "The immutable cardinality caps do not authorize another page.",
    };
  }
  if (
    generation.generation.cost.spent >= plan.hardExecutionCap ||
    generation.generation.cost.spent >= availableBudget(plan) ||
    generation.generation.cost.spent >=
      plan.authority.budgetLimit.limit -
        plan.authority.budgetLimit.reserved -
        plan.authority.budgetLimit.spent
  ) {
    return {
      code: "budget-exhausted",
      message: "The immutable budget cannot reserve another page effect.",
    };
  }
};

type PreparedPageRun = Readonly<{
  runPlan: RunPlan;
  validatedInput: ValidatedRunInput;
  workflow: WorkflowSpec;
}>;

const preparePageRun = (
  generationId: DatasetGenerationPage["generationId"],
  plan: DatasetGenerationPlan,
  generation: DatasetGenerationCreation,
  pageSequence: number,
  inputCursor: null | string,
  actorPermissions: readonly string[],
  now: Awaited<ReturnType<ClockPort["now"]>>
): DomainResult<
  PreparedPageRun,
  AuthorizeFirstDatasetGenerationPageFailure
> => {
  const inputValue = generationPageInput(
    generationId,
    plan,
    generation,
    pageSequence,
    inputCursor
  );
  const normalizedInputHash = canonicalContentHash(inputValue);
  const workflow = generationPageWorkflow(generationId, plan, pageSequence);
  const remainingExecutionCap =
    plan.hardExecutionCap - generation.generation.cost.spent;
  const admittedRoutes = plan.routeSnapshots
    .filter(
      (route) =>
        generation.generation.lockedProvider === undefined ||
        route.effectAdapterKey === generation.generation.lockedProvider
    )
    .map((route) => ({
      capability: { ...route.capability },
      effectAdapterKey: route.effectAdapterKey,
      factsHash: route.factsHash,
      nodeKey: "page",
      pricingVersion: route.pricingVersion,
      reservableUpperBound: Math.min(
        route.reservableUpperBound,
        remainingExecutionCap
      ),
      reservationUnit: route.reservationUnit,
      routeKey: route.routeKey,
    }));
  const prepared = prepareRunPlanDraft({
    actorPermissions,
    allowedCapabilities: [plan.requestIntent.capability.capabilityId],
    authority: plan.authority,
    budget: {
      limit: remainingExecutionCap,
      reserved: 0,
      spent: 0,
      unit: plan.budget.unit,
    },
    catalogFingerprint: plan.queryContract.catalogFingerprint,
    catalogVersion: plan.queryContract.catalogVersion,
    compilationLimits: { maxDepth: 1, maxFanOut: 1, maxNodes: 1 },
    compilerVersion: PAGE_COMPILER_VERSION,
    deadline: plan.deadline,
    inputContract: datasetGenerationPageInputContract(plan),
    normalizedInputHash,
    now,
    outputContract: datasetGenerationPageOutputContract(plan),
    policy: {
      factsHash: plan.policy.factsHash,
      requiredPermission: RUN_PERMISSION,
      version: plan.policy.version,
    },
    quote: {
      ...plan.quote,
      upperBound: remainingExecutionCap,
    },
    // 001C accounts exactly one provider call; retries/fallbacks need their own
    // generation-level authorization before this can be raised.
    retryPolicy: { maxAttemptsPerStep: 1 },
    routeSnapshots: admittedRoutes,
    runPlanId: runPlanId(
      `dataset-generation-page-plan_${pageIdentitySuffix(generationId, pageSequence)}`
    ),
    workflow,
    workspaceId: plan.workspaceId,
  });
  if (!prepared.ok) {
    return fail(mapPreparationFailure(prepared.error));
  }
  const runPlan = {
    ...prepared.value,
    planHash: canonicalContentHash(prepared.value),
  };
  const sizeBytes = canonicalContentByteSize(inputValue);
  if (sizeBytes > MAX_RUN_INPUT_BYTES) {
    return fail({
      code: "input-too-large",
      message: "The canonical generation page input exceeds 65536 bytes.",
    });
  }
  const inputContract = runPlan.inputContract;
  const inputIdentity = canonicalContentHash({
    contentHash: normalizedInputHash,
    contract: inputContract,
    runPlanId: runPlan.runPlanId,
    workspaceId: runPlan.workspaceId,
  });
  const validatedInput: ValidatedRunInput = {
    classification: "internal",
    contentHash: normalizedInputHash,
    contract: inputContract,
    finalizedAt: now,
    inputId: `run_input_${inputIdentity.slice("sha256:".length)}`,
    mediaType: "application/json",
    sizeBytes,
    validatedAt: now,
    validatorVersion: "dataset-generation-page-input/1.0.0",
    value: inputValue as NormalizedJsonValue,
  };
  return succeed({ runPlan, validatedInput, workflow });
};

const creationKey = (
  generationId: DatasetGenerationPage["generationId"],
  pageSequence: number
) => idempotencyKey(`dataset-generation-page:${generationId}:${pageSequence}`);

type AuthorizationTransactionInput = Readonly<{
  dependencies: AuthorizeFirstDatasetGenerationPageDependencies;
  now: Awaited<ReturnType<ClockPort["now"]>>;
  request: AuthorizeFirstDatasetGenerationPageRequest;
  scope: WorkspaceScope;
  unitOfWork: DatasetGenerationFirstPageUnitOfWork;
}>;

const replayPriorPage = async (
  input: AuthorizationTransactionInput,
  prior: DatasetGenerationPage
): Promise<AuthorizeFirstDatasetGenerationPageResult> => {
  const { request, scope, unitOfWork } = input;
  const runCreation = await unitOfWork.runs.findByIdempotencyKey(
    scope,
    creationKey(request.generationId, prior.pageSequence)
  );
  const bindingIsExact =
    prior.workspaceId === scope.workspaceId &&
    prior.generationId === request.generationId &&
    prior.pageSequence > 0 &&
    runCreation !== undefined &&
    runCreation.run.runId === prior.runId &&
    runCreation.run.runPlanId === prior.runPlanId;
  return bindingIsExact
    ? succeed({ page: structuredClone(prior), replayed: true })
    : invalid(
        "idempotency-conflict",
        "The durable first-page binding diverges from its canonical Run."
      );
};

const persistFreshPage = async (
  input: AuthorizationTransactionInput,
  storedPlan: StoredDatasetGenerationPlan,
  generation: DatasetGenerationCreation,
  pageSequence: number,
  inputCursor: null | string
): Promise<AuthorizeFirstDatasetGenerationPageResult> => {
  const { dependencies, now, request, scope, unitOfWork } = input;
  const denied = validateAuthorization(
    request,
    storedPlan.plan,
    generation,
    now
  );
  if (denied !== undefined) {
    return fail(denied);
  }
  const prepared = preparePageRun(
    request.generationId,
    storedPlan.plan,
    generation,
    pageSequence,
    inputCursor,
    request.actorPermissions,
    now
  );
  if (!prepared.ok) {
    return fail(prepared.error);
  }
  await unitOfWork.runPlans.insert(scope, prepared.value.runPlan);
  await unitOfWork.runInputs.insert(
    scope,
    prepared.value.runPlan,
    prepared.value.validatedInput
  );
  const runCreation = await createRunInUnitOfWork({
    command: {
      actorId: request.actorId,
      actorPermissions: request.actorPermissions,
      authenticationMode: request.authenticationMode,
      correlationId: request.correlationId,
      idempotencyKey: creationKey(request.generationId, pageSequence),
      intentionHash: prepared.value.runPlan.planHash,
      runPlanId: prepared.value.runPlan.runPlanId,
      workspaceId: request.workspaceId,
    },
    dependencies: {
      identifiers: dependencies.identifiers,
      requiredPermission: RUN_PERMISSION,
    },
    expectedPlanBinding: {
      normalizedInputHash: prepared.value.validatedInput.contentHash,
      workflowContentHash: prepared.value.workflow.contentHash,
      workflowRevision: prepared.value.workflow.revision,
      workflowSpecId: prepared.value.workflow.workflowSpecId,
    },
    now,
    unitOfWork,
  });
  if (!runCreation.ok) {
    return fail(mapRunFailure(runCreation.error));
  }
  const page: DatasetGenerationPage = {
    aggregateVersion: 1,
    createdAt: now,
    generationId: request.generationId,
    inputContentHash: prepared.value.validatedInput.contentHash,
    inputCursor,
    inputId: prepared.value.validatedInput.inputId,
    pageSequence,
    runId: runCreation.value.run.runId,
    runPlanId: prepared.value.runPlan.runPlanId,
    state: "run_created",
    workspaceId: request.workspaceId,
  };
  const validPage = validateDatasetGenerationPageSnapshot(page);
  if (!validPage.ok) {
    return invalid(
      "generation-proof-invalid",
      validPage.error.message,
      validPage.error.code
    );
  }
  await unitOfWork.generationPages.insertPage(scope, validPage.value);
  return succeed({ page: structuredClone(validPage.value), replayed: false });
};

const authorizeInUnitOfWork = async (
  input: AuthorizationTransactionInput
): Promise<AuthorizeFirstDatasetGenerationPageResult> => {
  const { request, scope, unitOfWork } = input;
  const generation = await unitOfWork.generationPages.getGenerationForUpdate(
    scope,
    request.generationId
  );
  if (generation === undefined) {
    return invalid(
      "generation-not-found",
      "The dataset generation does not exist."
    );
  }
  const storedPlan = await unitOfWork.generationPlans.get(
    scope,
    generation.generation.generationPlanId
  );
  if (storedPlan === undefined) {
    return invalid(
      "generation-plan-not-found",
      "The immutable generation plan does not exist."
    );
  }
  const validGeneration = validateDatasetGenerationSnapshot(
    generation,
    storedPlan.plan
  );
  if (!validGeneration.ok) {
    return invalid(
      "generation-proof-invalid",
      validGeneration.error.message,
      validGeneration.error.code
    );
  }
  const callerDenied = validateCallerAuthorization(request, storedPlan.plan);
  if (callerDenied !== undefined) {
    return fail(callerDenied);
  }
  if (
    generation.generation.state === "completed" ||
    generation.generation.state === "failed" ||
    generation.generation.state === "cancelled" ||
    generation.generation.state === "ambiguous"
  ) {
    return invalid(
      "generation-not-planned",
      "A terminal generation cannot authorize another page."
    );
  }
  const nextSequence = generation.generation.counters.pages + 1;
  const prior = await unitOfWork.generationPages.getPageForUpdate(
    scope,
    request.generationId,
    nextSequence
  );
  if (prior !== undefined) {
    return replayPriorPage(input, prior);
  }
  if (nextSequence === 1) {
    return generation.generation.state === "planned"
      ? persistFreshPage(input, storedPlan, generation, 1, null)
      : invalid(
          "generation-not-planned",
          "Only a zero-progress planned generation can create its first page."
        );
  }
  const previous = await unitOfWork.generationPages.getPageForUpdate(
    scope,
    request.generationId,
    nextSequence - 1
  );
  if (
    generation.generation.state !== "running" ||
    previous?.state !== "committed" ||
    !previous.hasMore ||
    typeof previous.nextCursor !== "string"
  ) {
    return invalid(
      "generation-not-planned",
      "Another page requires an exact committed predecessor cursor."
    );
  }
  return persistFreshPage(
    input,
    storedPlan,
    generation,
    nextSequence,
    previous.nextCursor
  );
};

export const makeAuthorizeFirstDatasetGenerationPage =
  (dependencies: AuthorizeFirstDatasetGenerationPageDependencies) =>
  async (
    request: AuthorizeFirstDatasetGenerationPageRequest
  ): Promise<AuthorizeFirstDatasetGenerationPageResult> => {
    const scope = { workspaceId: request.workspaceId } as const;
    const now = await dependencies.clock.now();
    return dependencies.persistence.transaction(scope, (unitOfWork) =>
      authorizeInUnitOfWork({
        dependencies,
        now,
        request,
        scope,
        unitOfWork,
      })
    );
  };

export type AuthorizeDatasetGenerationPageRequest =
  AuthorizeFirstDatasetGenerationPageRequest;
export type AuthorizeDatasetGenerationPageResult =
  AuthorizeFirstDatasetGenerationPageResult;
export type AuthorizeDatasetGenerationPageDependencies =
  AuthorizeFirstDatasetGenerationPageDependencies;
export const makeAuthorizeDatasetGenerationPage =
  makeAuthorizeFirstDatasetGenerationPage;
