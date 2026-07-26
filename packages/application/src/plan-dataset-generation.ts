import {
  type ActorId,
  type CapabilityRef,
  createDatasetGenerationPlan,
  type Dataset,
  type DatasetGenerationLimitRequest,
  type DatasetGenerationPlan,
  type DatasetGenerationPlanDraft,
  type DatasetGenerationQueryValue,
  type DatasetGenerationRequestIntent,
  type DatasetGenerationUnknownCostPolicy,
  type DomainResult,
  datasetGenerationPlanHashContent,
  datasetGenerationRequestIntentHashContent,
  datasetGenerationSchemaHashContent,
  type Field,
  fail,
  type IdempotencyKey,
  isSupportedAuthorityEnvelopeVersion,
  snapshotDatasetGenerationQuery,
  succeed,
  validateDatasetGenerationRequestIntent,
  type WorkspaceId,
} from "@kurobara/kernel";
import {
  evaluateSourcingBudgetPreflight,
  type SourcingBudgetPreflightReasonCode,
} from "@kurobara/policy-engine";
import type {
  ClockPort,
  DatasetGenerationPlanningIdentifierPort,
  DatasetGenerationPlanningPersistencePort,
  DatasetGenerationPlanningSnapshot,
  DatasetGenerationPlanningSnapshotResolverPort,
  DatasetGenerationQueryNormalizerPort,
  StoredDatasetGenerationPlan,
  WorkspaceScope,
} from "@kurobara/ports";

import {
  canonicalContentByteSize,
  canonicalContentHash,
} from "./canonical-content-hash.ts";

const MAX_REQUEST_INTENT_BYTES = 1_048_576;
const MAX_PROVIDER_IDENTITY_NAMESPACE_CODE_POINTS = 128;
const SELECTED_CONTACT_CAPABILITY_IDS = new Set([
  "contacts.identity.reveal",
  "contacts.work-email.resolve",
  "contacts.work-email.verify",
]);

export type PlanDatasetGenerationRequest = Readonly<{
  actorId: ActorId;
  authorityEnvelopeId: string;
  capability: CapabilityRef;
  fields: readonly Field[];
  idempotencyKey: IdempotencyKey;
  limits: DatasetGenerationLimitRequest;
  providerIdentityNamespace?: string;
  query: DatasetGenerationQueryValue;
  requestedBudget: Readonly<{ limit: number; unit: string }>;
  requestedDeadline: DatasetGenerationRequestIntent["requestedDeadline"];
  targetDataset: Dataset;
  unknownCostPolicy: DatasetGenerationUnknownCostPolicy;
  workspaceId: WorkspaceId;
}>;

export type PlanDatasetGenerationFailureCode =
  | "authority-invalid"
  | "domain-rejected"
  | "idempotency-key-reused"
  | "preflight-denied"
  | "query-rejected"
  | "request-invalid"
  | "snapshot-unavailable";

export type PlanDatasetGenerationFailure = Readonly<{
  code: PlanDatasetGenerationFailureCode;
  message: string;
  reasonCodes?: readonly SourcingBudgetPreflightReasonCode[];
}>;

export type PlanDatasetGenerationSuccess = Readonly<{
  plan: DatasetGenerationPlan;
  replayed: boolean;
}>;

export type PlanDatasetGenerationResult = DomainResult<
  PlanDatasetGenerationSuccess,
  PlanDatasetGenerationFailure
>;

export type PlanDatasetGenerationDependencies = Readonly<{
  clock: ClockPort;
  identifiers: DatasetGenerationPlanningIdentifierPort;
  normalizer: DatasetGenerationQueryNormalizerPort;
  persistence: DatasetGenerationPlanningPersistencePort;
  snapshots: DatasetGenerationPlanningSnapshotResolverPort;
}>;

const invalid = (
  code: PlanDatasetGenerationFailureCode,
  message: string,
  reasonCodes?: readonly SourcingBudgetPreflightReasonCode[]
): PlanDatasetGenerationResult =>
  fail({
    code,
    message,
    ...(reasonCodes === undefined ? {} : { reasonCodes }),
  });

const detach = <Value>(value: Value): Value => structuredClone(value);

const isObject = (
  value: DatasetGenerationQueryValue
): value is Readonly<Record<string, DatasetGenerationQueryValue>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const selectedContactProviderIdentityNamespace = (
  query: DatasetGenerationQueryValue
): string | undefined => {
  if (!isObject(query)) {
    return;
  }
  const selectedContacts = query.selected_contacts;
  if (!(Array.isArray(selectedContacts) && selectedContacts.length > 0)) {
    return;
  }
  const namespaces = new Set<string>();
  for (const selected of selectedContacts) {
    if (!isObject(selected)) {
      return;
    }
    const providerIdentity = selected.provider_identity;
    if (!isObject(providerIdentity)) {
      return;
    }
    const providerKey = providerIdentity.provider_key;
    if (typeof providerKey !== "string") {
      return;
    }
    namespaces.add(providerKey);
  }
  return namespaces.size === 1 ? namespaces.values().next().value : undefined;
};

const providerIdentityNamespaceIsValid = (
  request: PlanDatasetGenerationRequest,
  query: DatasetGenerationQueryValue
): boolean => {
  const requiresNamespace =
    request.capability.capabilityVersion === "1.0.0" &&
    SELECTED_CONTACT_CAPABILITY_IDS.has(request.capability.capabilityId);
  const namespace = request.providerIdentityNamespace;
  if (!requiresNamespace) {
    return namespace === undefined;
  }
  return (
    namespace !== undefined &&
    namespace.length > 0 &&
    namespace.trim() === namespace &&
    [...namespace].length <= MAX_PROVIDER_IDENTITY_NAMESPACE_CODE_POINTS &&
    selectedContactProviderIdentityNamespace(query) === namespace
  );
};

const snapshotNormalizedGenerationQuery = (
  request: PlanDatasetGenerationRequest,
  value: DatasetGenerationQueryValue
): ReturnType<typeof snapshotDatasetGenerationQuery> => {
  const normalizedQuery = snapshotDatasetGenerationQuery(value);
  if (!normalizedQuery.ok) {
    return normalizedQuery;
  }
  return providerIdentityNamespaceIsValid(request, normalizedQuery.value)
    ? normalizedQuery
    : fail({
        code: "query-invalid",
        message:
          "The normalized selected-contact query changed its provider identity namespace.",
      });
};

const routeSnapshotsForRequest = (
  request: PlanDatasetGenerationRequest,
  snapshot: DatasetGenerationPlanningSnapshot
): DatasetGenerationPlanningSnapshot["routeSnapshots"] =>
  request.providerIdentityNamespace === undefined
    ? snapshot.routeSnapshots
    : snapshot.routeSnapshots.filter(
        (route) =>
          route.providerIdentityNamespace === request.providerIdentityNamespace
      );

const buildIntent = (
  request: PlanDatasetGenerationRequest,
  requestedQuery: DatasetGenerationQueryValue
): DatasetGenerationRequestIntent =>
  detach({
    actorId: request.actorId,
    authorityEnvelopeId: request.authorityEnvelopeId,
    capability: request.capability,
    fields: request.fields,
    limits: request.limits,
    requestedBudget: request.requestedBudget,
    requestedDeadline: request.requestedDeadline,
    requestedQuery,
    targetDataset: request.targetDataset,
    unknownCostPolicy: request.unknownCostPolicy,
    workspaceId: request.workspaceId,
  });

const replay = (
  stored: StoredDatasetGenerationPlan,
  requestIntentHash: DatasetGenerationPlan["requestIntentHash"]
): PlanDatasetGenerationResult =>
  stored.requestIntentHash === requestIntentHash
    ? succeed({ plan: detach(stored.plan), replayed: true })
    : invalid(
        "idempotency-key-reused",
        "The idempotency key was already used for another generation intention."
      );

const capabilityMatches = (
  left: CapabilityRef,
  right: CapabilityRef
): boolean =>
  left.capabilityId === right.capabilityId &&
  left.capabilityVersion === right.capabilityVersion;

const availableBudget = (
  budget: DatasetGenerationPlanningSnapshot["budget"]
): number => budget.limit - budget.spent - budget.reserved;

const unknownPolicyIsMonotone = (
  requested: DatasetGenerationUnknownCostPolicy,
  resolved: DatasetGenerationUnknownCostPolicy
): boolean => {
  if (resolved.mode === "deny") {
    return true;
  }
  return (
    requested.mode === "explicit-non-interactive" &&
    resolved.hardCap <= requested.hardCap
  );
};

const snapshotCoversRequest = (
  intent: DatasetGenerationRequestIntent,
  snapshot: DatasetGenerationPlanningSnapshot
): boolean => {
  const authority = snapshot.authority;
  return (
    isSupportedAuthorityEnvelopeVersion(authority.version) &&
    authority.workspaceId === intent.workspaceId &&
    authority.subjectActorId === intent.actorId &&
    authority.authorityEnvelopeId === intent.authorityEnvelopeId &&
    authority.capabilities.some((candidate) =>
      capabilityMatches(candidate, intent.capability)
    ) &&
    authority.permissions.includes(snapshot.policy.requiredPermission) &&
    snapshot.deadline <= intent.requestedDeadline &&
    snapshot.deadline <= authority.deadline &&
    snapshot.budget.unit === intent.requestedBudget.unit &&
    snapshot.budget.unit === authority.budgetLimit.unit &&
    availableBudget(snapshot.budget) <= intent.requestedBudget.limit &&
    availableBudget(snapshot.budget) <=
      availableBudget(authority.budgetLimit) &&
    unknownPolicyIsMonotone(
      intent.unknownCostPolicy,
      snapshot.unknownCostPolicy
    )
  );
};

const normalizerResultIsExact = (
  capability: CapabilityRef,
  result: Extract<
    ReturnType<DatasetGenerationQueryNormalizerPort["normalize"]>,
    { status: "accepted" }
  >
): boolean =>
  capabilityMatches(capability, result.capability) &&
  result.normalizerVersion.trim().length > 0 &&
  result.contract.catalogVersion.trim().length > 0 &&
  result.contract.schemaId.trim().length > 0 &&
  result.contract.schemaVersion.trim().length > 0;

type PreparedGenerationRequest = Readonly<{
  requestedQuery: DatasetGenerationQueryValue;
  requestIntent: DatasetGenerationRequestIntent;
  requestIntentHash: DatasetGenerationPlan["requestIntentHash"];
}>;

const prepareGenerationRequest = (
  request: PlanDatasetGenerationRequest
): DomainResult<PreparedGenerationRequest, PlanDatasetGenerationFailure> => {
  if (
    request.idempotencyKey.trim().length === 0 ||
    request.idempotencyKey.trim() !== request.idempotencyKey ||
    [...request.idempotencyKey].length > 512
  ) {
    return fail({
      code: "request-invalid",
      message: "A generation request requires a bounded idempotency key.",
    });
  }
  try {
    const requestedQuery = snapshotDatasetGenerationQuery(request.query);
    if (!requestedQuery.ok) {
      return fail({
        code: "request-invalid",
        message: requestedQuery.error.message,
      });
    }
    if (!providerIdentityNamespaceIsValid(request, requestedQuery.value)) {
      return fail({
        code: "request-invalid",
        message:
          "Selected-contact generation requires one exact bounded provider identity namespace.",
      });
    }
    const requestIntent = buildIntent(request, requestedQuery.value);
    const validatedIntent =
      validateDatasetGenerationRequestIntent(requestIntent);
    if (!validatedIntent.ok) {
      return fail({
        code: "request-invalid",
        message: validatedIntent.error.message,
      });
    }
    const intentContent =
      datasetGenerationRequestIntentHashContent(requestIntent);
    if (canonicalContentByteSize(intentContent) > MAX_REQUEST_INTENT_BYTES) {
      return fail({
        code: "request-invalid",
        message: "The generation request exceeds the bounded planning payload.",
      });
    }
    return succeed({
      requestedQuery: requestedQuery.value,
      requestIntent,
      requestIntentHash: canonicalContentHash(intentContent),
    });
  } catch {
    return fail({
      code: "request-invalid",
      message: "The generation request is not detached bounded JSON.",
    });
  }
};

export const makePlanDatasetGeneration =
  (dependencies: PlanDatasetGenerationDependencies) =>
  async (
    request: PlanDatasetGenerationRequest
  ): Promise<PlanDatasetGenerationResult> => {
    const preparedRequest = prepareGenerationRequest(request);
    if (!preparedRequest.ok) {
      return preparedRequest;
    }
    const { requestIntent, requestIntentHash, requestedQuery } =
      preparedRequest.value;
    const scope: WorkspaceScope = { workspaceId: request.workspaceId };
    const prior = await dependencies.persistence.findByIdempotencyKey(
      scope,
      request.idempotencyKey
    );
    if (prior !== undefined) {
      return replay(prior, requestIntentHash);
    }

    const normalized = dependencies.normalizer.normalize({
      capability: request.capability,
      query: detach(requestedQuery),
    });
    if (
      normalized.status === "rejected" ||
      !normalizerResultIsExact(request.capability, normalized)
    ) {
      return invalid(
        "query-rejected",
        normalized.status === "rejected"
          ? normalized.reason
          : "The query normalizer returned a mismatched snapshot."
      );
    }
    const normalizedQuery = snapshotNormalizedGenerationQuery(
      request,
      normalized.value
    );
    if (!normalizedQuery.ok) {
      return invalid("query-rejected", normalizedQuery.error.message);
    }

    const snapshot = await dependencies.snapshots.resolve({
      actorId: request.actorId,
      authorityEnvelopeId: request.authorityEnvelopeId,
      capability: request.capability,
      requestedBudget: request.requestedBudget,
      requestedDeadline: request.requestedDeadline,
      requestedUnknownCostPolicy: request.unknownCostPolicy,
      workspaceId: request.workspaceId,
    });
    if (snapshot === undefined) {
      return invalid(
        "snapshot-unavailable",
        "Trusted generation planning facts are unavailable."
      );
    }
    if (!snapshotCoversRequest(requestIntent, snapshot)) {
      return invalid(
        "authority-invalid",
        "The resolved planning snapshot would exceed the requested authority."
      );
    }
    const routeSnapshots = routeSnapshotsForRequest(request, snapshot);
    if (routeSnapshots.length === 0) {
      return invalid(
        "snapshot-unavailable",
        "No admitted execution route matches the selected contact provider identity namespace."
      );
    }

    const queryHash = canonicalContentHash(normalizedQuery.value);
    const schemaHash = canonicalContentHash(
      datasetGenerationSchemaHashContent(requestIntent)
    );

    return dependencies.persistence.transaction(scope, async (unitOfWork) => {
      await unitOfWork.generationPlans.lockIdempotencyKey(
        scope,
        request.idempotencyKey
      );
      const concurrent = await unitOfWork.generationPlans.findByIdempotencyKey(
        scope,
        request.idempotencyKey
      );
      if (concurrent !== undefined) {
        return replay(concurrent, requestIntentHash);
      }

      const now = await dependencies.clock.now();
      const preflight = evaluateSourcingBudgetPreflight({
        budget: snapshot.budget,
        deadline: snapshot.deadline,
        limits: request.limits,
        now,
        quote: snapshot.quote,
        unknownCostPolicy: snapshot.unknownCostPolicy,
      });
      if (!preflight.allowed || preflight.snapshot === undefined) {
        return invalid(
          "preflight-denied",
          "The generation request was denied before any external effect.",
          preflight.reasonCodes
        );
      }
      const preflightSnapshot = preflight.snapshot;

      const generationPlanId =
        await dependencies.identifiers.nextDatasetGenerationPlanId();
      const draft: DatasetGenerationPlanDraft = detach({
        authority: snapshot.authority,
        budget: preflightSnapshot.budget,
        deadline: preflightSnapshot.deadline,
        generationPlanId,
        hardExecutionCap: preflightSnapshot.hardExecutionCap,
        idempotencyKey: request.idempotencyKey,
        limits: preflightSnapshot.limits,
        normalizedQuery: normalizedQuery.value,
        normalizerVersion: normalized.normalizerVersion,
        policy: snapshot.policy,
        queryContract: normalized.contract,
        queryHash,
        quote: preflightSnapshot.quote,
        requestIntent,
        requestIntentHash,
        routeSnapshots,
        schemaHash,
        workspaceId: request.workspaceId,
      });
      const plan: DatasetGenerationPlan = {
        ...draft,
        planHash: canonicalContentHash(datasetGenerationPlanHashContent(draft)),
      };
      const validPlan = createDatasetGenerationPlan(plan);
      if (!validPlan.ok) {
        return invalid("domain-rejected", validPlan.error.message);
      }
      const record: StoredDatasetGenerationPlan = {
        idempotencyKey: request.idempotencyKey,
        plan: detach(validPlan.value),
        requestIntentHash,
      };
      await unitOfWork.generationPlans.insert(scope, record);
      return succeed({ plan: detach(record.plan), replayed: false });
    });
  };
