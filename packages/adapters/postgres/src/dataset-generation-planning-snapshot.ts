import { instant } from "@kurobara/kernel";
import type {
  CapabilityRoute,
  CapabilityRouteCatalogPort,
  ClockPort,
  DatasetGenerationPlanningSnapshot,
  DatasetGenerationPlanningSnapshotRequest,
  DatasetGenerationPlanningSnapshotResolverPort,
  PlanningIdentifierPort,
  PlanningPersistencePort,
} from "@kurobara/ports";

export type PostgresDatasetGenerationPlanningSnapshotDependencies = Readonly<{
  clock: ClockPort;
  identifiers: Pick<PlanningIdentifierPort, "nextQuoteId">;
  persistence: PlanningPersistencePort;
  routes: CapabilityRouteCatalogPort;
}>;

const capabilityMatches = (
  route: CapabilityRoute,
  request: DatasetGenerationPlanningSnapshotRequest
): boolean =>
  route.capability.capabilityId === request.capability.capabilityId &&
  route.capability.capabilityVersion === request.capability.capabilityVersion;

const availableBudget = (
  budget: Readonly<{
    limit: number;
    reserved: number;
    spent: number;
  }>
): number => budget.limit - budget.reserved - budget.spent;

const positiveAmount = (value: number): boolean =>
  Number.isFinite(value) && value > 0;

/**
 * Resolves generation admission only from durable planning snapshots and the
 * exact non-secret route list admitted by the current process composition.
 * It never reads credentials and never invokes a provider.
 */
export const createPostgresDatasetGenerationPlanningSnapshotResolver = (
  dependencies: PostgresDatasetGenerationPlanningSnapshotDependencies
): DatasetGenerationPlanningSnapshotResolverPort => ({
  resolve: async (request) => {
    const scope = { workspaceId: request.workspaceId } as const;
    const admittedRoutes = dependencies.routes
      .listAvailable(scope)
      .filter((route) => capabilityMatches(route, request));
    if (admittedRoutes.length === 0) {
      return;
    }

    const facts = await dependencies.persistence.transaction(
      scope,
      async (unitOfWork) => {
        const authority = await unitOfWork.snapshots.getAuthority(
          scope,
          request.authorityEnvelopeId
        );
        const defaults = await unitOfWork.snapshots.getDefaults(scope);
        if (authority === undefined || defaults === undefined) {
          return;
        }
        const [policy, pricing] = await Promise.all([
          unitOfWork.snapshots.getPolicy(scope, defaults.policySnapshotId),
          unitOfWork.snapshots.getPricing(scope, defaults.pricingSnapshotId),
        ]);
        return policy === undefined || pricing === undefined
          ? undefined
          : { authority, defaults, policy, pricing };
      }
    );
    if (facts === undefined) {
      return;
    }

    const { authority, defaults, policy, pricing } = facts;
    const authorityAvailable = availableBudget(authority.budgetLimit);
    const budgetLimit = Math.min(
      request.requestedBudget.limit,
      authorityAvailable
    );
    if (
      authority.workspaceId !== request.workspaceId ||
      authority.subjectActorId !== request.actorId ||
      authority.authorityEnvelopeId !== request.authorityEnvelopeId ||
      defaults.workspaceId !== request.workspaceId ||
      policy.workspaceId !== request.workspaceId ||
      policy.snapshotId !== defaults.policySnapshotId ||
      pricing.workspaceId !== request.workspaceId ||
      pricing.snapshotId !== defaults.pricingSnapshotId ||
      !authority.capabilities.some(
        (capability) =>
          capability.capabilityId === request.capability.capabilityId &&
          capability.capabilityVersion === request.capability.capabilityVersion
      ) ||
      !authority.permissions.includes(policy.policy.requiredPermission) ||
      !authority.permissions.includes("steps:execute") ||
      authority.budgetLimit.unit !== request.requestedBudget.unit ||
      pricing.unit !== request.requestedBudget.unit ||
      !positiveAmount(budgetLimit) ||
      !Number.isSafeInteger(request.requestedDeadline) ||
      !Number.isSafeInteger(authority.deadline)
    ) {
      return;
    }

    const effectiveDeadline = Math.min(
      request.requestedDeadline,
      authority.deadline
    );
    const now = await dependencies.clock.now();
    const quoteExpiresAt = Math.min(
      effectiveDeadline,
      now + pricing.ttlMilliseconds
    );
    if (
      effectiveDeadline <= now ||
      !Number.isSafeInteger(quoteExpiresAt) ||
      quoteExpiresAt <= now ||
      ((pricing.guarantee === "hard" || pricing.guarantee === "estimated") &&
        (pricing.upperBound === undefined || pricing.upperBound > budgetLimit))
    ) {
      return;
    }

    const routeSnapshots = admittedRoutes
      .filter(
        (route) =>
          route.reservationUnit === pricing.unit &&
          route.reservableUpperBound <= budgetLimit &&
          (pricing.guarantee !== "hard" ||
            (pricing.upperBound !== undefined &&
              route.reservableUpperBound <= pricing.upperBound))
      )
      .map((route) => ({
        capability: { ...route.capability },
        effectAdapterKey: route.effectAdapterKey,
        factsHash: policy.policy.factsHash,
        pricingVersion: pricing.version,
        ...(route.providerIdentityNamespace === undefined
          ? {}
          : {
              providerIdentityNamespace: route.providerIdentityNamespace,
            }),
        reservableUpperBound: route.reservableUpperBound,
        reservationUnit: route.reservationUnit,
        routeKey: route.routeKey,
      }));
    if (routeSnapshots.length === 0) {
      return;
    }

    const { requestedUnknownCostPolicy } = request;
    const unknownCostPolicy =
      requestedUnknownCostPolicy.mode === "deny"
        ? requestedUnknownCostPolicy
        : {
            hardCap: Math.min(requestedUnknownCostPolicy.hardCap, budgetLimit),
            mode: "explicit-non-interactive" as const,
          };
    const quoteId = await dependencies.identifiers.nextQuoteId();
    return structuredClone({
      authority,
      budget: {
        limit: budgetLimit,
        reserved: 0,
        spent: 0,
        unit: pricing.unit,
      },
      deadline: instant(effectiveDeadline),
      policy: {
        factsHash: policy.policy.factsHash,
        requiredPermission: policy.policy.requiredPermission,
        version: policy.policy.version,
      },
      quote: {
        expiresAt: instant(quoteExpiresAt),
        guarantee: pricing.guarantee,
        pricingVersion: pricing.version,
        quoteId,
        unit: pricing.unit,
        ...(pricing.upperBound === undefined
          ? {}
          : { upperBound: pricing.upperBound }),
      },
      routeSnapshots,
      unknownCostPolicy,
    } satisfies DatasetGenerationPlanningSnapshot);
  },
});
