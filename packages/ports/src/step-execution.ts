import type {
  ActorId,
  Artifact,
  Attempt,
  AttemptId,
  AttemptState,
  CorrelationId,
  CostReservation,
  CostReservationId,
  EventId,
  IdempotencyKey,
  Instant,
  OperationKey,
  RoutingDecision,
  Run,
  RunId,
  RunPlan,
  StepCommandReplayProof,
  StepLifecycleEvent,
  StepRun,
  StepRunId,
  UsageEntry,
  WorkspaceId,
} from "@kurobara/kernel";
import type { DagScheduleRequestRepository } from "./dag-scheduling.ts";
import type { LeafOutboxRepository } from "./leaf-outbox-dispatch.ts";
import type { NormalizedJsonValue } from "./normalized-json.ts";
import type { WorkspaceScope } from "./run-persistence.ts";
import type { ValidatedRunInput } from "./run-plan-input.ts";
import type { StepRoutingRequestRepository } from "./step-routing-request.ts";

export type StepExecutionContext = Readonly<{
  plan: RunPlan;
  run: Run;
  runInput?: ValidatedRunInput;
  stepRun?: StepRun;
  succeededNodeKeys: readonly string[];
}>;

export type StepParentEffectInput = Readonly<{
  attempt: Attempt;
  now: Instant;
  plan: RunPlan;
  run: Run;
  stepRun: StepRun;
}>;

export type StepParentEffectResult =
  | Readonly<{ status: "authorized" | "not-parented" | "replayed" }>
  | Readonly<{
      code: string;
      message: string;
      status: "denied";
    }>;

/**
 * Optional parent aggregate projection performed in the same transaction as
 * the canonical Step attempt transition. A parent may authorize, replay, or
 * deny the effect threshold; it never selects an execution route.
 */
export interface StepParentEffectRepository {
  authorize(
    scope: WorkspaceScope,
    input: StepParentEffectInput
  ): Promise<StepParentEffectResult>;
  markAmbiguous(
    scope: WorkspaceScope,
    input: StepParentEffectInput
  ): Promise<StepParentEffectResult>;
}

export type LeafExecutionIdentity = Readonly<{
  attemptId: AttemptId;
  effectAdapterKey?: string;
  eventId: EventId;
  runId: RunId;
  startKey: string;
  stepRunId: StepRunId;
  workspaceId: WorkspaceId;
}>;

export type CostReservationResult =
  | Readonly<{ status: "created"; reservation: CostReservation }>
  | Readonly<{ status: "existing"; reservation: CostReservation }>
  | Readonly<{ status: "budget-exceeded" }>
  | Readonly<{ status: "conflict" }>;

export interface StepExecutionRepository {
  getContextByStepIdForUpdate(
    scope: WorkspaceScope,
    stepRunId: StepRunId
  ): Promise<StepExecutionContext | undefined>;
  getContextForUpdate(
    scope: WorkspaceScope,
    runId: RunId,
    nodeKey: string
  ): Promise<StepExecutionContext | undefined>;
  insert(scope: WorkspaceScope, stepRun: StepRun): Promise<void>;
  update(
    scope: WorkspaceScope,
    expectedAggregateVersion: number,
    stepRun: StepRun
  ): Promise<void>;
}

export interface StepAttemptRepository {
  insert(scope: WorkspaceScope, attempt: Attempt): Promise<void>;
  update(
    scope: WorkspaceScope,
    expectedState: AttemptState,
    attempt: Attempt
  ): Promise<void>;
}

export interface ArtifactRepository {
  insert(
    scope: WorkspaceScope,
    artifact: Artifact,
    value: NormalizedJsonValue
  ): Promise<void>;
}

export interface StepLifecycleEventRepository {
  append(scope: WorkspaceScope, event: StepLifecycleEvent): Promise<void>;
}

export interface RoutingDecisionRepository {
  insert(scope: WorkspaceScope, decision: RoutingDecision): Promise<void>;
}

export interface StepCommandJournalRepository {
  find(
    scope: WorkspaceScope,
    stepRunId: StepRunId,
    commandIdempotencyKey: IdempotencyKey
  ): Promise<StepCommandReplayProof | undefined>;
  insert(
    scope: WorkspaceScope,
    proof: StepCommandReplayProof,
    actorId: ActorId,
    correlationId: CorrelationId
  ): Promise<void>;
}

export interface CostReservationRepository {
  release(
    scope: WorkspaceScope,
    input: CostReservationRelease
  ): Promise<CostReservationReleaseResult>;
  reserve(
    scope: WorkspaceScope,
    reservation: CostReservation
  ): Promise<CostReservationResult>;
  settle(
    scope: WorkspaceScope,
    usage: UsageEntry
  ): Promise<CostReservationSettlementResult>;
}

export type CostReservationRelease = Readonly<{
  amount: number;
  attemptId: import("@kurobara/kernel").AttemptId;
  operationKey: OperationKey;
  releasedAt: Instant;
  reservationId: CostReservationId;
  runId: RunId;
  unit: string;
  workspaceId: WorkspaceId;
}>;

export type CostReservationReleaseResult =
  | Readonly<{ reservation: CostReservation; status: "released" }>
  | Readonly<{ reservation: CostReservation; status: "existing" }>
  | Readonly<{ status: "conflict" }>;

export type CostReservationSettlementResult =
  | Readonly<{
      reservation: CostReservation;
      status: "settled";
      usage: UsageEntry;
    }>
  | Readonly<{
      reservation: CostReservation;
      status: "existing";
      usage: UsageEntry;
    }>
  | Readonly<{ status: "amount-exceeded" | "conflict" }>;

export type StepExecutionUnitOfWork = Readonly<{
  artifacts: ArtifactRepository;
  attempts: StepAttemptRepository;
  commandJournal: StepCommandJournalRepository;
  dagSchedule: DagScheduleRequestRepository;
  leafOutbox: LeafOutboxRepository;
  parentEffects?: StepParentEffectRepository;
  reservations: CostReservationRepository;
  routingDecisions: RoutingDecisionRepository;
  stepEvents: StepLifecycleEventRepository;
  stepRouting: StepRoutingRequestRepository;
  steps: StepExecutionRepository;
}>;

export interface StepExecutionPersistencePort {
  transaction<Value>(
    scope: WorkspaceScope,
    work: (unitOfWork: StepExecutionUnitOfWork) => Promise<Value>
  ): Promise<Value>;
}

export interface StepExecutionQueryPort {
  getContextByStepId(
    scope: WorkspaceScope,
    stepRunId: StepRunId
  ): Promise<StepExecutionContext | undefined>;
  getLeafExecutionIdentity(
    scope: WorkspaceScope,
    stepRunId: StepRunId,
    attemptId: AttemptId
  ): Promise<LeafExecutionIdentity | undefined>;
}
