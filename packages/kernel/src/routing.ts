import { amountsEqual, isAmount } from "./amount.ts";
import { type DomainResult, fail, succeed } from "./result.ts";
import type {
  ContentHash,
  Instant,
  RoutingDecisionId,
  RunId,
  StepRunId,
  WorkspaceId,
} from "./value-objects.ts";
import type { CapabilityRef, CompiledWorkflow } from "./workflow.ts";

type UnitBearingValue = Readonly<{ unit: string }>;

type RouteQuote = UnitBearingValue &
  Readonly<{
    guarantee: "hard" | "estimated" | "unknown";
    pricingVersion: string;
    upperBound?: number;
  }>;

type RouteRetryPolicy = Readonly<{ maxAttemptsPerStep: number }>;

export type RunPlanRouteSnapshot = Readonly<{
  capability: CapabilityRef;
  effectAdapterKey: string;
  factsHash: ContentHash;
  nodeKey: string;
  pricingVersion: string;
  reservableUpperBound: number;
  reservationUnit: string;
  routeKey: string;
}>;

export type RoutingDecision = Readonly<{
  capability: CapabilityRef;
  decidedAt: Instant;
  effectAdapterKey: string;
  policyFactsHash: ContentHash;
  policyVersion: string;
  pricingVersion: string;
  reservedAmount: number;
  reservationUnit: string;
  routeKey: string;
  routeSnapshotHash: ContentHash;
  routingDecisionId: RoutingDecisionId;
  runId: RunId;
  stepRunId: StepRunId;
  workspaceId: WorkspaceId;
}>;

export type RoutingDecisionInput = Readonly<{
  candidate: RunPlanRouteSnapshot;
  decidedAt: Instant;
  expectedCapability: CapabilityRef;
  expectedNodeKey: string;
  expectedPricingVersion: string;
  policyFactsHash: ContentHash;
  policyVersion: string;
  routeSnapshotHash: ContentHash;
  routingDecisionId: RoutingDecisionId;
  runId: RunId;
  stepRunId: StepRunId;
  workspaceId: WorkspaceId;
}>;

export type RoutingFailure = Readonly<{
  code: "capability-mismatch" | "invalid-route-snapshot" | "node-mismatch";
  message: string;
}>;

const capabilityMatches = (
  left: CapabilityRef,
  right: CapabilityRef
): boolean =>
  left.capabilityId === right.capabilityId &&
  left.capabilityVersion === right.capabilityVersion;

const snapshotIsStructurallyValid = (snapshot: RunPlanRouteSnapshot): boolean =>
  snapshot.routeKey.trim().length > 0 &&
  snapshot.effectAdapterKey.trim().length > 0 &&
  snapshot.nodeKey.trim().length > 0 &&
  snapshot.pricingVersion.trim().length > 0 &&
  snapshot.reservationUnit.trim().length > 0 &&
  isAmount(snapshot.reservableUpperBound);

const amountExceeds = (value: number, limit: number): boolean =>
  value > limit && !amountsEqual(value, limit);

const retryPolicyIsValid = (policy: RouteRetryPolicy): boolean =>
  Number.isInteger(policy.maxAttemptsPerStep) &&
  policy.maxAttemptsPerStep >= 1 &&
  policy.maxAttemptsPerStep <= 100;

const compensatedAmountSum = (
  amounts: readonly number[]
): number | undefined => {
  let correction = 0;
  let sum = 0;
  for (const amount of amounts) {
    if (!isAmount(amount)) {
      return;
    }
    const next = sum + amount;
    correction +=
      Math.abs(sum) >= Math.abs(amount)
        ? sum - next + amount
        : amount - next + sum;
    sum = next;
    if (!(Number.isFinite(sum) && Number.isFinite(correction))) {
      return;
    }
  }
  const corrected = sum + correction;
  return isAmount(corrected) ? corrected : undefined;
};

const hardQuoteFitsPlan = (
  snapshots: readonly RunPlanRouteSnapshot[],
  budget: UnitBearingValue & Readonly<{ limit: number }>,
  quote: RouteQuote,
  retryPolicy: RouteRetryPolicy
): boolean => {
  if (quote.guarantee !== "hard") {
    return true;
  }
  const quoteUpperBound = quote.upperBound;
  if (
    quoteUpperBound === undefined ||
    !isAmount(quoteUpperBound) ||
    amountExceeds(quoteUpperBound, budget.limit)
  ) {
    return false;
  }

  const maximumBoundByNode = new Map<string, number>();
  for (const snapshot of snapshots) {
    const current = maximumBoundByNode.get(snapshot.nodeKey) ?? 0;
    maximumBoundByNode.set(
      snapshot.nodeKey,
      Math.max(current, snapshot.reservableUpperBound)
    );
  }

  const worstCasePlanCost = compensatedAmountSum(
    [...maximumBoundByNode.values()].map(
      (upperBound) => upperBound * retryPolicy.maxAttemptsPerStep
    )
  );
  if (worstCasePlanCost === undefined) {
    return false;
  }
  return !(
    amountExceeds(worstCasePlanCost, quoteUpperBound) ||
    amountExceeds(worstCasePlanCost, budget.limit)
  );
};

export const createRoutingDecision = (
  input: RoutingDecisionInput
): DomainResult<RoutingDecision, RoutingFailure> => {
  const { candidate } = input;
  if (!snapshotIsStructurallyValid(candidate)) {
    return fail({
      code: "invalid-route-snapshot",
      message:
        "A routing decision requires a complete reservable route snapshot.",
    });
  }
  if (candidate.nodeKey !== input.expectedNodeKey) {
    return fail({
      code: "node-mismatch",
      message:
        "The selected route does not belong to the requested workflow node.",
    });
  }
  if (!capabilityMatches(candidate.capability, input.expectedCapability)) {
    return fail({
      code: "capability-mismatch",
      message:
        "The selected route does not implement the exact node capability.",
    });
  }
  if (
    candidate.factsHash !== input.policyFactsHash ||
    candidate.pricingVersion !== input.expectedPricingVersion
  ) {
    return fail({
      code: "invalid-route-snapshot",
      message:
        "The selected route does not match the immutable policy and pricing provenance.",
    });
  }
  return succeed({
    capability: candidate.capability,
    decidedAt: input.decidedAt,
    effectAdapterKey: candidate.effectAdapterKey,
    policyFactsHash: input.policyFactsHash,
    policyVersion: input.policyVersion,
    pricingVersion: candidate.pricingVersion,
    reservationUnit: candidate.reservationUnit,
    reservedAmount: candidate.reservableUpperBound,
    routeKey: candidate.routeKey,
    routeSnapshotHash: input.routeSnapshotHash,
    routingDecisionId: input.routingDecisionId,
    runId: input.runId,
    stepRunId: input.stepRunId,
    workspaceId: input.workspaceId,
  });
};

export const validateRunPlanRouteSnapshots = (
  snapshots: readonly RunPlanRouteSnapshot[],
  workflow: CompiledWorkflow,
  budget: UnitBearingValue & Readonly<{ limit: number }>,
  quote: RouteQuote,
  retryPolicy: RouteRetryPolicy,
  policyFactsHash: ContentHash
): DomainResult<readonly RunPlanRouteSnapshot[], RoutingFailure> => {
  if (!(isAmount(budget.limit) && retryPolicyIsValid(retryPolicy))) {
    return fail({
      code: "invalid-route-snapshot",
      message: "Run-plan routes require a valid budget and retry policy.",
    });
  }
  const identities = new Set<string>();
  for (const snapshot of snapshots) {
    if (!snapshotIsStructurallyValid(snapshot)) {
      return fail({
        code: "invalid-route-snapshot",
        message: "Every run-plan route must be complete and reservable.",
      });
    }
    const node = workflow.nodes.find((entry) => entry.key === snapshot.nodeKey);
    if (node === undefined) {
      return fail({
        code: "node-mismatch",
        message:
          "A run-plan route targets a node outside the compiled workflow.",
      });
    }
    if (!capabilityMatches(node.capability, snapshot.capability)) {
      return fail({
        code: "capability-mismatch",
        message: "A run-plan route does not match its node capability.",
      });
    }
    if (
      snapshot.reservationUnit !== budget.unit ||
      snapshot.reservationUnit !== quote.unit ||
      snapshot.pricingVersion !== quote.pricingVersion ||
      snapshot.factsHash !== policyFactsHash ||
      amountExceeds(snapshot.reservableUpperBound, budget.limit)
    ) {
      return fail({
        code: "invalid-route-snapshot",
        message: "A run-plan route must fit the immutable budget and quote.",
      });
    }
    const identity = `${snapshot.nodeKey}\u0000${snapshot.routeKey}`;
    if (identities.has(identity)) {
      return fail({
        code: "invalid-route-snapshot",
        message: "A run-plan node cannot contain the same route key twice.",
      });
    }
    identities.add(identity);
  }
  if (!hardQuoteFitsPlan(snapshots, budget, quote, retryPolicy)) {
    return fail({
      code: "invalid-route-snapshot",
      message:
        "The worst-case routed plan must fit its immutable hard quote and budget.",
    });
  }
  return succeed([...snapshots]);
};
