import { type DomainResult, fail, succeed } from "./result.ts";
import type { RunPlanRouteSnapshot } from "./routing.ts";
import type {
  ActorId,
  ContentHash,
  CorrelationId,
  EventId,
  IdempotencyKey,
  Instant,
  ResultManifestId,
  RunId,
  RunPlanId,
  WorkspaceId,
} from "./value-objects.ts";
import type { CapabilityRef, CompiledWorkflow } from "./workflow.ts";

export type ContractRef = Readonly<{
  catalogVersion: string;
  catalogFingerprint: ContentHash;
  schemaId: string;
  schemaVersion: string;
  schemaFingerprint: ContentHash;
}>;

export type BudgetLimit = Readonly<{
  unit: string;
  limit: number;
  spent: number;
  reserved: number;
}>;

export type AuthorityEnvelope = Readonly<{
  authorityEnvelopeId: string;
  version: string;
  subjectActorId: ActorId;
  workspaceId: WorkspaceId;
  permissions: readonly string[];
  capabilities: readonly CapabilityRef[];
  budgetLimit: BudgetLimit;
  deadline: Instant;
}>;

export const AUTHORITY_ENVELOPE_VERSION_V1 = "1.0.0";

export const isSupportedAuthorityEnvelopeVersion = (version: string): boolean =>
  version === AUTHORITY_ENVELOPE_VERSION_V1;

export type CostQuote = Readonly<{
  quoteId: string;
  guarantee: "hard" | "estimated" | "unknown";
  unit: string;
  upperBound?: number;
  pricingVersion: string;
  expiresAt: Instant;
}>;

export type RetryPolicy = Readonly<{
  maxAttemptsPerStep: number;
}>;

export type RunPlan = Readonly<{
  runPlanId: RunPlanId;
  workspaceId: WorkspaceId;
  planHash: ContentHash;
  normalizedInputHash: ContentHash;
  catalogVersion: string;
  catalogFingerprint: ContentHash;
  compiledWorkflow: CompiledWorkflow;
  inputContract: ContractRef;
  outputContract: ContractRef;
  policyVersion: string;
  policyFactsHash: ContentHash;
  retryPolicy: RetryPolicy;
  /** Explicit on newly prepared plans; absent only on legacy persisted plans. */
  routeSnapshots?: readonly RunPlanRouteSnapshot[];
  quote: CostQuote;
  budget: BudgetLimit;
  deadline: Instant;
  authority: AuthorityEnvelope;
}>;

export type RunState =
  | "queued"
  | "running"
  | "waiting"
  | "cancelling"
  | "ambiguous"
  | "completed"
  | "failed"
  | "cancelled";

export type ResultCompleteness = "none" | "partial" | "complete";

export type ResultManifestRef = Readonly<{
  manifestHash: ContentHash;
  resultManifestId: ResultManifestId;
}>;

export type StopReason =
  | "requested"
  | "deadline"
  | "budget"
  | "authority-revoked"
  | "ancestor-stopped";

export type Run = Readonly<{
  runId: RunId;
  runPlanId: RunPlanId;
  workspaceId: WorkspaceId;
  state: RunState;
  aggregateVersion: number;
  eventSequence: number;
  resultCompleteness: ResultCompleteness;
  createdAt: Instant;
  idempotencyKey: IdempotencyKey;
  intentionHash: ContentHash;
  pendingStopReason?: StopReason;
  resultManifest?: ResultManifestRef;
}>;

export type RunQueued = Readonly<{
  eventId: EventId;
  eventType: "RunQueued";
  eventVersion: 1;
  runId: RunId;
  runPlanId: RunPlanId;
  workspaceId: WorkspaceId;
  sequence: 1;
  occurredAt: Instant;
  actorId: ActorId;
  correlationId: CorrelationId;
}>;

export type CreateRunFailureCode =
  | "workspace-mismatch"
  | "authority-subject-mismatch"
  | "authority-version-unsupported"
  | "quote-expired"
  | "deadline-elapsed"
  | "invalid-budget"
  | "quote-unit-mismatch"
  | "authority-capability-missing"
  | "authority-permission-missing";

export type CreateRunFailure = Readonly<{
  code: CreateRunFailureCode;
  message: string;
}>;

export type CreateRunDecision = Readonly<{
  run: Run;
  event: RunQueued;
}>;

export type CreateRunInput = Readonly<{
  plan: RunPlan;
  runId: RunId;
  eventId: EventId;
  now: Instant;
  actorId: ActorId;
  correlationId: CorrelationId;
  idempotencyKey: IdempotencyKey;
  intentionHash: ContentHash;
  requiredPermission: string;
}>;

const isPositiveFinite = (value: number): boolean =>
  Number.isFinite(value) && value >= 0;

const capabilityMatches = (
  left: CapabilityRef,
  right: CapabilityRef
): boolean =>
  left.capabilityId === right.capabilityId &&
  left.capabilityVersion === right.capabilityVersion;

export const createRunFromPlan = (
  input: CreateRunInput
): DomainResult<CreateRunDecision, CreateRunFailure> => {
  const { plan } = input;

  if (plan.workspaceId !== plan.authority.workspaceId) {
    return fail({
      code: "workspace-mismatch",
      message:
        "The plan and authority envelope belong to different workspaces.",
    });
  }

  if (input.actorId !== plan.authority.subjectActorId) {
    return fail({
      code: "authority-subject-mismatch",
      message: "The authenticated actor is not the authority envelope subject.",
    });
  }

  if (!isSupportedAuthorityEnvelopeVersion(plan.authority.version)) {
    return fail({
      code: "authority-version-unsupported",
      message: "The authority envelope version is not supported.",
    });
  }

  if (input.now >= plan.quote.expiresAt) {
    return fail({
      code: "quote-expired",
      message: "The plan quote has expired.",
    });
  }

  if (input.now >= plan.deadline || input.now >= plan.authority.deadline) {
    return fail({
      code: "deadline-elapsed",
      message: "The plan deadline has elapsed.",
    });
  }

  const budget = plan.budget;
  const authorityBudget = plan.authority.budgetLimit;
  if (
    !(
      isPositiveFinite(budget.limit) &&
      isPositiveFinite(budget.spent) &&
      isPositiveFinite(budget.reserved)
    ) ||
    budget.spent + budget.reserved > budget.limit ||
    budget.unit !== authorityBudget.unit ||
    budget.limit > authorityBudget.limit
  ) {
    return fail({
      code: "invalid-budget",
      message: "The plan budget is invalid or exceeds the authority budget.",
    });
  }

  if (plan.quote.unit !== budget.unit) {
    return fail({
      code: "quote-unit-mismatch",
      message: "The quote and budget must use the same unit.",
    });
  }

  const missingCapability = plan.compiledWorkflow.nodes.some((node) =>
    plan.authority.capabilities.every(
      (authorizedCapability) =>
        !capabilityMatches(node.capability, authorizedCapability)
    )
  );
  if (missingCapability) {
    return fail({
      code: "authority-capability-missing",
      message:
        "The authority envelope does not cover every workflow capability.",
    });
  }

  if (!plan.authority.permissions.includes(input.requiredPermission)) {
    return fail({
      code: "authority-permission-missing",
      message: `The authority envelope is missing permission ${input.requiredPermission}.`,
    });
  }

  const run: Run = {
    aggregateVersion: 1,
    createdAt: input.now,
    eventSequence: 1,
    idempotencyKey: input.idempotencyKey,
    intentionHash: input.intentionHash,
    resultCompleteness: "none",
    runId: input.runId,
    runPlanId: plan.runPlanId,
    state: "queued",
    workspaceId: plan.workspaceId,
  };
  const event: RunQueued = {
    actorId: input.actorId,
    correlationId: input.correlationId,
    eventId: input.eventId,
    eventType: "RunQueued",
    eventVersion: 1,
    occurredAt: input.now,
    runId: input.runId,
    runPlanId: plan.runPlanId,
    sequence: 1,
    workspaceId: plan.workspaceId,
  };

  return succeed({ event, run });
};
