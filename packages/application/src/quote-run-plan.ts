import {
  contentHash,
  type DomainResult,
  fail,
  InvalidValueObjectError,
  instant,
  isSupportedAuthorityEnvelopeVersion,
  type RunPlan,
  type RunPlanRouteSnapshot,
  succeed,
  workflowSpecId,
} from "@kurobara/kernel";
import type {
  AuthoritySnapshot,
  CapabilityRoute,
  CapabilityRouteCatalogPort,
  ClockPort,
  InputContractValidatorPort,
  NormalizedJsonValue,
  PlanningIdentifierPort,
  PlanningPersistencePort,
  PlanningUnitOfWork,
  PolicyPlanningSnapshot,
  PricingSnapshot,
  RunPlanSources,
  ValidatedRunInput,
  VerifiedApiKey,
  WorkflowSnapshot,
  WorkflowSnapshotIdentity,
  WorkspaceScope,
} from "@kurobara/ports";

import { canonicalContentHash } from "./canonical-content-hash.ts";
import {
  type PrepareRunPlanFailure,
  prepareRunPlanDraft,
} from "./prepare-run-plan.ts";
import { makePrepareRunPlanInputContent } from "./prepare-run-plan-input.ts";

const REQUIRED_PERMISSION = "plans:quote";

export type QuoteRunPlanRequest = Readonly<{
  actor: VerifiedApiKey;
  authorityEnvelopeId: string;
  budget: Readonly<{
    limit: number;
    unit: string;
  }>;
  deadlineMs: number;
  normalizedInput?: NormalizedJsonValue;
  normalizedInputHash: string;
  workflowContentHash: string;
  workflowRevision: string;
  workflowSpecId: string;
  workspaceId: string;
}>;

export type QuoteRunPlanFailureCode =
  | "authority-capability-missing"
  | "authority-permission-missing"
  | "authority-subject-mismatch"
  | "deadline-elapsed"
  | "domain-rejected"
  | "invalid-budget"
  | "quote-unit-mismatch"
  | "request-invalid"
  | "service-unavailable"
  | "workspace-mismatch";

export type QuoteRunPlanFailure = Readonly<{
  code: QuoteRunPlanFailureCode;
  domainCode?: string;
  message: string;
}>;

export type QuoteRunPlanSuccess = Readonly<{
  input?: ValidatedRunInput;
  plan: RunPlan;
}>;

export type QuoteRunPlanResult = DomainResult<
  QuoteRunPlanSuccess,
  QuoteRunPlanFailure
>;

export type QuoteRunPlanDependencies = Readonly<{
  clock: ClockPort;
  identifiers: PlanningIdentifierPort;
  inputValidator?: InputContractValidatorPort;
  persistence: PlanningPersistencePort;
  routes: CapabilityRouteCatalogPort;
}>;

export type QuoteRunPlanInUnitOfWorkInput = Readonly<{
  dependencies: Pick<
    QuoteRunPlanDependencies,
    "clock" | "identifiers" | "inputValidator" | "routes"
  >;
  request: QuoteRunPlanRequest;
  scope: WorkspaceScope;
  unitOfWork: PlanningUnitOfWork;
}>;

type ParsedQuoteRequest = Readonly<{
  authorityEnvelopeId: string;
  budget: Readonly<{ limit: number; reserved: 0; spent: 0; unit: string }>;
  deadline: ReturnType<typeof instant>;
  normalizedInputHash: ReturnType<typeof contentHash>;
  workflowIdentity: WorkflowSnapshotIdentity;
}>;

type ValidatedAuthority = Readonly<{
  authorityRemaining: number;
}>;

const invalid = (
  code: QuoteRunPlanFailureCode,
  message: string,
  domainCode?: string
): QuoteRunPlanResult =>
  fail({ code, ...(domainCode === undefined ? {} : { domainCode }), message });

const parseRequest = (
  request: QuoteRunPlanRequest
): DomainResult<ParsedQuoteRequest, QuoteRunPlanFailure> => {
  if (
    request.authorityEnvelopeId.trim().length === 0 ||
    request.workflowRevision.trim().length === 0 ||
    request.budget.unit.trim().length === 0 ||
    !(Number.isFinite(request.budget.limit) && request.budget.limit >= 0)
  ) {
    return fail({
      code: "request-invalid",
      message: "The plan quote request contains an invalid value.",
    });
  }

  try {
    return succeed({
      authorityEnvelopeId: request.authorityEnvelopeId,
      budget: {
        limit: request.budget.limit,
        reserved: 0,
        spent: 0,
        unit: request.budget.unit,
      },
      deadline: instant(request.deadlineMs),
      normalizedInputHash: contentHash(request.normalizedInputHash),
      workflowIdentity: {
        workflowContentHash: contentHash(request.workflowContentHash),
        workflowRevision: request.workflowRevision,
        workflowSpecId: workflowSpecId(request.workflowSpecId),
      },
    });
  } catch (error) {
    if (error instanceof InvalidValueObjectError) {
      return fail({
        code: "request-invalid",
        message: "The plan quote request contains an invalid value.",
      });
    }
    throw error;
  }
};

const workflowIsExact = (
  scope: WorkspaceScope,
  identity: WorkflowSnapshotIdentity,
  snapshot: WorkflowSnapshot
): boolean =>
  snapshot.workspaceId === scope.workspaceId &&
  snapshot.workflow.workflowSpecId === identity.workflowSpecId &&
  snapshot.workflow.revision === identity.workflowRevision &&
  snapshot.workflow.contentHash === identity.workflowContentHash;

const pricingIsUsable = (snapshot: PricingSnapshot): boolean =>
  snapshot.unit.trim().length > 0 &&
  snapshot.version.trim().length > 0 &&
  Number.isSafeInteger(snapshot.ttlMilliseconds) &&
  snapshot.ttlMilliseconds > 0 &&
  (snapshot.upperBound === undefined ||
    (Number.isFinite(snapshot.upperBound) && snapshot.upperBound >= 0));

const mapPreparationFailure = (
  failure: PrepareRunPlanFailure
): QuoteRunPlanFailure => {
  if (failure.code === "workflow-rejected") {
    return {
      code: "domain-rejected",
      domainCode: failure.compilation.code,
      message: "The exact workflow snapshot cannot be planned.",
    };
  }
  if (failure.code === "routing-rejected") {
    return {
      code: "service-unavailable",
      domainCode: "routing-snapshot-invalid",
      message: "The configured execution routes are unavailable.",
    };
  }

  if (failure.reasonCodes.includes("workspace-mismatch")) {
    return {
      code: "workspace-mismatch",
      message: "The authority and plan belong to different workspaces.",
    };
  }
  if (failure.reasonCodes.includes("permission-missing")) {
    return {
      code: "authority-permission-missing",
      message: "The planning policy requires additional authority.",
    };
  }
  if (failure.reasonCodes.includes("capability-outside-authority")) {
    return {
      code: "authority-capability-missing",
      message: "The authority does not cover every workflow capability.",
    };
  }
  if (failure.reasonCodes.includes("authority-deadline-elapsed")) {
    return {
      code: "deadline-elapsed",
      message: "The authority deadline has elapsed.",
    };
  }
  return {
    code: "domain-rejected",
    domainCode: "policy-denied",
    message: "The planning policy denied the request.",
  };
};

const preparePersistedInput = async (
  dependencies: QuoteRunPlanInUnitOfWorkInput["dependencies"],
  request: QuoteRunPlanRequest,
  plan: RunPlan
): Promise<
  DomainResult<ValidatedRunInput | undefined, QuoteRunPlanFailure>
> => {
  if (request.normalizedInput === undefined) {
    return succeed(undefined);
  }
  if (dependencies.inputValidator === undefined) {
    return fail({
      code: "service-unavailable",
      message: "The exact input contract validator is unavailable.",
    });
  }
  const prepared = await makePrepareRunPlanInputContent({
    clock: dependencies.clock,
    validator: dependencies.inputValidator,
  })({ plan, value: request.normalizedInput });
  if (!prepared.ok) {
    if (prepared.error.code === "validator-unavailable") {
      return fail({
        code: "service-unavailable",
        message: "The exact input contract validator is unavailable.",
      });
    }
    return fail({
      code:
        prepared.error.code === "input-contract-rejected"
          ? "domain-rejected"
          : "request-invalid",
      domainCode: prepared.error.code,
      message: prepared.error.message,
    });
  }
  if (
    prepared.value.validatedAt > plan.deadline ||
    prepared.value.validatedAt > plan.quote.expiresAt
  ) {
    return fail({
      code: "deadline-elapsed",
      message: "The plan deadline elapsed before its input could be persisted.",
    });
  }
  return succeed(prepared.value);
};

const quoteWithinBudget = (
  pricing: PricingSnapshot,
  budgetLimit: number,
  authorityRemaining: number
): boolean =>
  pricing.upperBound === undefined ||
  (pricing.upperBound <= budgetLimit &&
    pricing.upperBound <= authorityRemaining);

const validatePricingQuote = (
  pricing: PricingSnapshot,
  parsed: ParsedQuoteRequest,
  authorityRemaining: number
): QuoteRunPlanFailure | undefined => {
  if (pricing.unit !== parsed.budget.unit) {
    return {
      code: "quote-unit-mismatch",
      message: "The quote and requested budget use different units.",
    };
  }
  if (pricing.guarantee === "hard" && pricing.upperBound === undefined) {
    return {
      code: "invalid-budget",
      message: "A hard quote requires a finite upper bound.",
    };
  }
  if (!quoteWithinBudget(pricing, parsed.budget.limit, authorityRemaining)) {
    return {
      code: "invalid-budget",
      message: "The local quote exceeds the available budget.",
    };
  }
};

const capabilityMatches = (
  left: CapabilityRoute["capability"],
  right: CapabilityRoute["capability"]
): boolean =>
  left.capabilityId === right.capabilityId &&
  left.capabilityVersion === right.capabilityVersion;

const snapshotRoutes = (
  dependencies: QuoteRunPlanInUnitOfWorkInput["dependencies"],
  scope: WorkspaceScope,
  workflow: WorkflowSnapshot,
  policy: PolicyPlanningSnapshot,
  pricing: PricingSnapshot
) => {
  const available = dependencies.routes.listAvailable(scope);
  return workflow.workflow.nodes.flatMap((node) =>
    available
      .filter((route) => capabilityMatches(route.capability, node.capability))
      .map((route) => ({
        capability: { ...node.capability },
        effectAdapterKey: route.effectAdapterKey,
        factsHash: policy.policy.factsHash,
        nodeKey: node.key,
        pricingVersion: pricing.version,
        reservableUpperBound: route.reservableUpperBound,
        reservationUnit: route.reservationUnit,
        routeKey: route.routeKey,
      }))
  );
};

const resolveRouteSnapshots = (
  dependencies: QuoteRunPlanInUnitOfWorkInput["dependencies"],
  scope: WorkspaceScope,
  workflow: WorkflowSnapshot,
  policy: PolicyPlanningSnapshot,
  pricing: PricingSnapshot
): DomainResult<readonly RunPlanRouteSnapshot[], QuoteRunPlanFailure> => {
  try {
    const routes = snapshotRoutes(
      dependencies,
      scope,
      workflow,
      policy,
      pricing
    );
    const unroutableNode = workflow.workflow.nodes.some(
      (node) => !routes.some((route) => route.nodeKey === node.key)
    );
    return unroutableNode
      ? fail({
          code: "service-unavailable",
          message:
            "No admitted execution route is available for the exact workflow.",
        })
      : succeed(routes);
  } catch {
    return fail({
      code: "service-unavailable",
      message: "The execution route catalog is unavailable.",
    });
  }
};

const validateAuthority = (
  authority: AuthoritySnapshot,
  scope: WorkspaceScope,
  request: QuoteRunPlanRequest,
  parsed: ParsedQuoteRequest,
  now: ReturnType<typeof instant>
): DomainResult<ValidatedAuthority, QuoteRunPlanFailure> => {
  if (authority.authorityEnvelopeId !== parsed.authorityEnvelopeId) {
    return fail({
      code: "authority-subject-mismatch",
      message:
        "The requested authority does not authorize the authenticated actor.",
    });
  }
  if (authority.workspaceId !== scope.workspaceId) {
    return fail({
      code: "workspace-mismatch",
      message: "The authority and plan belong to different workspaces.",
    });
  }
  if (authority.subjectActorId !== request.actor.actorId) {
    return fail({
      code: "authority-subject-mismatch",
      message:
        "The requested authority does not authorize the authenticated actor.",
    });
  }
  if (!isSupportedAuthorityEnvelopeVersion(authority.version)) {
    return fail({
      code: "domain-rejected",
      domainCode: "authority-version-unsupported",
      message: "The authority envelope version is not supported.",
    });
  }
  if (!authority.permissions.includes(REQUIRED_PERMISSION)) {
    return fail({
      code: "authority-permission-missing",
      message: "The authority envelope does not permit plan quotes.",
    });
  }

  const authorityBudget = authority.budgetLimit;
  const authorityBudgetIsValid =
    Number.isFinite(authorityBudget.limit) &&
    authorityBudget.limit >= 0 &&
    Number.isFinite(authorityBudget.reserved) &&
    authorityBudget.reserved >= 0 &&
    Number.isFinite(authorityBudget.spent) &&
    authorityBudget.spent >= 0 &&
    authorityBudget.reserved + authorityBudget.spent <= authorityBudget.limit;
  if (!authorityBudgetIsValid) {
    return fail({
      code: "domain-rejected",
      domainCode: "authority-budget-invalid",
      message: "The authority snapshot contains an invalid budget.",
    });
  }
  if (authorityBudget.unit !== parsed.budget.unit) {
    return fail({
      code: "quote-unit-mismatch",
      message: "The requested budget and authority budget use different units.",
    });
  }
  const authorityRemaining =
    authorityBudget.limit - authorityBudget.spent - authorityBudget.reserved;
  if (parsed.budget.limit > authorityRemaining) {
    return fail({
      code: "invalid-budget",
      message: "The requested budget exceeds the remaining authority budget.",
    });
  }
  if (authority.deadline <= now) {
    return fail({
      code: "deadline-elapsed",
      message: "The authority deadline has elapsed.",
    });
  }
  return succeed({ authorityRemaining });
};

const quoteInTransaction = async (
  dependencies: QuoteRunPlanInUnitOfWorkInput["dependencies"],
  unitOfWork: PlanningUnitOfWork,
  scope: WorkspaceScope,
  request: QuoteRunPlanRequest,
  parsed: ParsedQuoteRequest,
  now: ReturnType<typeof instant>
): Promise<QuoteRunPlanResult> => {
  const authority = await unitOfWork.snapshots.getAuthority(
    scope,
    parsed.authorityEnvelopeId
  );
  if (authority === undefined) {
    return invalid(
      "authority-subject-mismatch",
      "The requested authority does not authorize the authenticated actor."
    );
  }
  const validatedAuthority = validateAuthority(
    authority,
    scope,
    request,
    parsed,
    now
  );
  if (!validatedAuthority.ok) {
    return fail(validatedAuthority.error);
  }

  const workflow = await unitOfWork.snapshots.getWorkflow(
    scope,
    parsed.workflowIdentity
  );
  if (
    workflow === undefined ||
    !workflowIsExact(scope, parsed.workflowIdentity, workflow)
  ) {
    return invalid(
      "domain-rejected",
      "The exact workflow snapshot cannot be used.",
      "workflow-snapshot-unavailable"
    );
  }

  const defaults = await unitOfWork.snapshots.getDefaults(scope);
  if (defaults === undefined || defaults.workspaceId !== scope.workspaceId) {
    return invalid("service-unavailable", "Planning defaults are unavailable.");
  }
  const [policy, pricing] = await Promise.all([
    unitOfWork.snapshots.getPolicy(scope, defaults.policySnapshotId),
    unitOfWork.snapshots.getPricing(scope, defaults.pricingSnapshotId),
  ]);
  if (
    policy === undefined ||
    policy.workspaceId !== scope.workspaceId ||
    policy.snapshotId !== defaults.policySnapshotId
  ) {
    return invalid(
      "service-unavailable",
      "The planning policy snapshot is unavailable."
    );
  }
  if (
    pricing === undefined ||
    pricing.workspaceId !== scope.workspaceId ||
    pricing.snapshotId !== defaults.pricingSnapshotId ||
    !pricingIsUsable(pricing)
  ) {
    return invalid(
      "service-unavailable",
      "The pricing snapshot is unavailable."
    );
  }
  const pricingFailure = validatePricingQuote(
    pricing,
    parsed,
    validatedAuthority.value.authorityRemaining
  );
  if (pricingFailure !== undefined) {
    return fail(pricingFailure);
  }

  const finalDeadline = instant(Math.min(parsed.deadline, authority.deadline));
  const finalNow = await dependencies.clock.now();
  if (finalDeadline <= finalNow) {
    return invalid(
      "deadline-elapsed",
      "The plan deadline elapsed before the quote could be persisted."
    );
  }
  const quoteExpiresAt = instant(
    finalNow + Math.min(pricing.ttlMilliseconds, finalDeadline - finalNow)
  );
  const routeSnapshots = resolveRouteSnapshots(
    dependencies,
    scope,
    workflow,
    policy,
    pricing
  );
  if (!routeSnapshots.ok) {
    return fail(routeSnapshots.error);
  }
  const [nextRunPlanId, nextQuoteId] = await Promise.all([
    dependencies.identifiers.nextRunPlanId(),
    dependencies.identifiers.nextQuoteId(),
  ]);
  const prepared = prepareRunPlanDraft({
    actorPermissions: request.actor.permissions,
    allowedCapabilities: workflow.allowedCapabilities,
    authority,
    budget: parsed.budget,
    catalogFingerprint: workflow.catalogFingerprint,
    catalogVersion: workflow.catalogVersion,
    compilationLimits: workflow.compilationLimits,
    compilerVersion: workflow.compilerVersion,
    deadline: finalDeadline,
    inputContract: workflow.inputContract,
    normalizedInputHash: parsed.normalizedInputHash,
    now: finalNow,
    outputContract: workflow.outputContract,
    policy: policy.policy,
    quote: {
      expiresAt: quoteExpiresAt,
      guarantee: pricing.guarantee,
      pricingVersion: pricing.version,
      quoteId: nextQuoteId,
      unit: pricing.unit,
      ...(pricing.upperBound === undefined
        ? {}
        : { upperBound: pricing.upperBound }),
    },
    retryPolicy: {
      maxAttemptsPerStep: policy.policy.maxAttemptsPerStep,
    },
    routeSnapshots: routeSnapshots.value,
    runPlanId: nextRunPlanId,
    workflow: workflow.workflow,
    workspaceId: scope.workspaceId,
  });
  if (!prepared.ok) {
    return fail(mapPreparationFailure(prepared.error));
  }
  const plan: RunPlan = {
    ...prepared.value,
    planHash: canonicalContentHash(prepared.value),
  };
  const sources: RunPlanSources = {
    authorityEnvelopeId: authority.authorityEnvelopeId,
    policySnapshotId: policy.snapshotId,
    pricingSnapshotId: pricing.snapshotId,
    workflowContentHash: workflow.workflow.contentHash,
    workflowRevision: workflow.workflow.revision,
    workflowSpecId: workflow.workflow.workflowSpecId,
  };
  const input = await preparePersistedInput(dependencies, request, plan);
  if (!input.ok) {
    return fail(input.error);
  }
  await unitOfWork.runPlans.insert(scope, {
    ...(input.value === undefined ? {} : { input: input.value }),
    plan,
    sources,
  });
  return succeed({
    ...(input.value === undefined ? {} : { input: input.value }),
    plan,
  });
};

export const quoteRunPlanInUnitOfWork = async (
  input: QuoteRunPlanInUnitOfWorkInput
): Promise<QuoteRunPlanResult> => {
  const { dependencies, request, scope, unitOfWork } = input;
  if (!request.actor.permissions.includes(REQUIRED_PERMISSION)) {
    return invalid(
      "authority-permission-missing",
      "The authenticated actor lacks permission to quote run plans."
    );
  }
  if (
    request.workspaceId !== request.actor.workspaceId ||
    scope.workspaceId !== request.actor.workspaceId
  ) {
    return invalid(
      "workspace-mismatch",
      "The authenticated actor and request belong to different workspaces."
    );
  }

  const parsed = parseRequest(request);
  if (!parsed.ok) {
    return fail(parsed.error);
  }
  const now = await dependencies.clock.now();
  if (parsed.value.deadline <= now) {
    return invalid("deadline-elapsed", "The requested deadline has elapsed.");
  }
  return quoteInTransaction(
    dependencies,
    unitOfWork,
    scope,
    request,
    parsed.value,
    now
  );
};

export const makeQuoteRunPlan =
  (dependencies: QuoteRunPlanDependencies) =>
  async (request: QuoteRunPlanRequest): Promise<QuoteRunPlanResult> => {
    if (!request.actor.permissions.includes(REQUIRED_PERMISSION)) {
      return invalid(
        "authority-permission-missing",
        "The authenticated actor lacks permission to quote run plans."
      );
    }
    if (request.workspaceId !== request.actor.workspaceId) {
      return invalid(
        "workspace-mismatch",
        "The authenticated actor and request belong to different workspaces."
      );
    }

    const parsed = parseRequest(request);
    if (!parsed.ok) {
      return fail(parsed.error);
    }
    const now = await dependencies.clock.now();
    if (parsed.value.deadline <= now) {
      return invalid("deadline-elapsed", "The requested deadline has elapsed.");
    }

    const scope = { workspaceId: request.actor.workspaceId } as const;
    return dependencies.persistence.transaction(scope, (unitOfWork) =>
      quoteInTransaction(
        dependencies,
        unitOfWork,
        scope,
        request,
        parsed.value,
        now
      )
    );
  };
