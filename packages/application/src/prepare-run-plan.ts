import {
  type AuthorityEnvelope,
  type BudgetLimit,
  type ContentHash,
  type ContractRef,
  type CostQuote,
  type DomainResult,
  fail,
  type Instant,
  type RetryPolicy,
  type RunPlan,
  type RunPlanId,
  type RunPlanRouteSnapshot,
  succeed,
  validateRunPlanRouteSnapshots,
  type WorkflowSpec,
  type WorkspaceId,
} from "@kurobara/kernel";
import { evaluatePolicy, type PolicySnapshot } from "@kurobara/policy-engine";
import {
  compileWorkflow,
  type WorkflowCompilationFailure,
  type WorkflowCompilationLimits,
} from "@kurobara/workflow-engine";

export type PrepareRunPlanInput = Readonly<{
  runPlanId: RunPlanId;
  workspaceId: WorkspaceId;
  planHash: ContentHash;
  normalizedInputHash: ContentHash;
  catalogVersion: string;
  catalogFingerprint: ContentHash;
  inputContract: ContractRef;
  outputContract: ContractRef;
  workflow: WorkflowSpec;
  allowedCapabilities: readonly string[];
  compilationLimits: WorkflowCompilationLimits;
  compilerVersion: string;
  policy: PolicySnapshot;
  retryPolicy: RetryPolicy;
  actorPermissions: readonly string[];
  authority: AuthorityEnvelope;
  quote: CostQuote;
  routeSnapshots?: readonly RunPlanRouteSnapshot[];
  budget: BudgetLimit;
  deadline: Instant;
  now: Instant;
}>;

export type PrepareRunPlanDraftInput = Omit<PrepareRunPlanInput, "planHash">;
export type PreparedRunPlanDraft = Omit<RunPlan, "planHash">;

export type PrepareRunPlanFailure =
  | Readonly<{
      code: "workflow-rejected";
      compilation: WorkflowCompilationFailure;
    }>
  | Readonly<{ code: "routing-rejected"; reason: string }>
  | Readonly<{ code: "policy-denied"; reasonCodes: readonly string[] }>;

export const prepareRunPlanDraft = (
  input: PrepareRunPlanDraftInput
): DomainResult<PreparedRunPlanDraft, PrepareRunPlanFailure> => {
  const compiled = compileWorkflow({
    allowedCapabilities: input.allowedCapabilities,
    compilerVersion: input.compilerVersion,
    limits: input.compilationLimits,
    spec: input.workflow,
  });
  if (!compiled.ok) {
    return fail({ code: "workflow-rejected", compilation: compiled.error });
  }

  for (const node of compiled.value.nodes) {
    const decision = evaluatePolicy(input.policy, {
      actorPermissions: input.actorPermissions,
      authority: input.authority,
      capability: node.capability,
      now: input.now,
      workspaceId: input.workspaceId,
    });
    if (!decision.allowed) {
      return fail({ code: "policy-denied", reasonCodes: decision.reasonCodes });
    }
  }

  const routes = validateRunPlanRouteSnapshots(
    input.routeSnapshots ?? [],
    compiled.value,
    input.budget,
    input.quote,
    input.retryPolicy,
    input.policy.factsHash
  );
  if (!routes.ok) {
    return fail({ code: "routing-rejected", reason: routes.error.message });
  }

  return succeed({
    authority: input.authority,
    budget: input.budget,
    catalogFingerprint: input.catalogFingerprint,
    catalogVersion: input.catalogVersion,
    compiledWorkflow: compiled.value,
    deadline: input.deadline,
    inputContract: input.inputContract,
    normalizedInputHash: input.normalizedInputHash,
    outputContract: input.outputContract,
    policyFactsHash: input.policy.factsHash,
    policyVersion: input.policy.version,
    quote: input.quote,
    retryPolicy: input.retryPolicy,
    routeSnapshots: routes.value,
    runPlanId: input.runPlanId,
    workspaceId: input.workspaceId,
  });
};

export const prepareRunPlan = (
  input: PrepareRunPlanInput
): DomainResult<RunPlan, PrepareRunPlanFailure> => {
  const prepared = prepareRunPlanDraft(input);
  if (!prepared.ok) {
    return prepared;
  }
  return succeed({ ...prepared.value, planHash: input.planHash });
};
