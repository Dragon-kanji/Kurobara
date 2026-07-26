import type {
  ActorId,
  AuthorityEnvelope,
  BudgetLimit,
  CapabilityRef,
  ContentHash,
  ContractRef,
  CostQuote,
  DatasetGenerationPlan,
  DatasetGenerationPlanId,
  DatasetGenerationPolicySnapshot,
  DatasetGenerationQueryValue,
  DatasetGenerationRouteSnapshot,
  DatasetGenerationUnknownCostPolicy,
  IdempotencyKey,
  Instant,
  WorkspaceId,
} from "@kurobara/kernel";

import type { WorkspaceScope } from "./run-persistence.ts";

export type DatasetGenerationQueryNormalizationInput = Readonly<{
  capability: CapabilityRef;
  query: DatasetGenerationQueryValue;
}>;

export type DatasetGenerationQueryNormalizationResult =
  | Readonly<{
      capability: CapabilityRef;
      contract: ContractRef;
      normalizerVersion: string;
      status: "accepted";
      value: DatasetGenerationQueryValue;
    }>
  | Readonly<{
      reason: string;
      status: "rejected";
    }>;

/** Local, deterministic query normalization. Implementations must not perform I/O. */
export interface DatasetGenerationQueryNormalizerPort {
  normalize(
    input: DatasetGenerationQueryNormalizationInput
  ): DatasetGenerationQueryNormalizationResult;
}

export type DatasetGenerationPlanningSnapshot = Readonly<{
  authority: AuthorityEnvelope;
  budget: BudgetLimit;
  deadline: Instant;
  policy: DatasetGenerationPolicySnapshot;
  quote: CostQuote;
  routeSnapshots: readonly DatasetGenerationRouteSnapshot[];
  unknownCostPolicy: DatasetGenerationUnknownCostPolicy;
}>;

export type DatasetGenerationPlanningSnapshotRequest = Readonly<{
  actorId: ActorId;
  authorityEnvelopeId: string;
  capability: CapabilityRef;
  requestedBudget: Readonly<{ limit: number; unit: string }>;
  requestedDeadline: Instant;
  requestedUnknownCostPolicy: DatasetGenerationUnknownCostPolicy;
  workspaceId: WorkspaceId;
}>;

/**
 * Resolves trusted server-side planning facts. Implementations may read local
 * snapshots but must not invoke the target capability or a billable provider.
 */
export interface DatasetGenerationPlanningSnapshotResolverPort {
  resolve(
    request: DatasetGenerationPlanningSnapshotRequest
  ): Promise<DatasetGenerationPlanningSnapshot | undefined>;
}

export type StoredDatasetGenerationPlan = Readonly<{
  idempotencyKey: IdempotencyKey;
  plan: DatasetGenerationPlan;
  requestIntentHash: ContentHash;
}>;

export interface DatasetGenerationPlanRepository {
  findByIdempotencyKey(
    scope: WorkspaceScope,
    idempotencyKey: IdempotencyKey
  ): Promise<StoredDatasetGenerationPlan | undefined>;
  get(
    scope: WorkspaceScope,
    generationPlanId: DatasetGenerationPlanId
  ): Promise<StoredDatasetGenerationPlan | undefined>;
  insert(
    scope: WorkspaceScope,
    record: StoredDatasetGenerationPlan
  ): Promise<void>;
  lockIdempotencyKey(
    scope: WorkspaceScope,
    idempotencyKey: IdempotencyKey
  ): Promise<void>;
}

export type DatasetGenerationPlanningUnitOfWork = Readonly<{
  generationPlans: DatasetGenerationPlanRepository;
}>;

export interface DatasetGenerationPlanningPersistencePort {
  findByIdempotencyKey(
    scope: WorkspaceScope,
    idempotencyKey: IdempotencyKey
  ): Promise<StoredDatasetGenerationPlan | undefined>;
  get(
    scope: WorkspaceScope,
    generationPlanId: DatasetGenerationPlanId
  ): Promise<StoredDatasetGenerationPlan | undefined>;
  transaction<Value>(
    scope: WorkspaceScope,
    work: (unitOfWork: DatasetGenerationPlanningUnitOfWork) => Promise<Value>
  ): Promise<Value>;
}

export interface DatasetGenerationPlanningIdentifierPort {
  nextDatasetGenerationPlanId(): Promise<DatasetGenerationPlanId>;
}
