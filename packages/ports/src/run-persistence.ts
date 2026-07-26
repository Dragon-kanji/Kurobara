import type {
  ActorId,
  CellResult,
  ContentHash,
  CorrelationId,
  EventId,
  IdempotencyKey,
  Instant,
  OutboxMessageId,
  Run,
  RunCommandReplayProof,
  RunId,
  RunLifecycleEvent,
  RunPlan,
  RunPlanId,
  RunQueued,
  WorkspaceId,
} from "@kurobara/kernel";
import type { DagScheduleRequestRepository } from "./dag-scheduling.ts";

export type WorkspaceScope = Readonly<{ workspaceId: WorkspaceId }>;

export type RunCreationRecord = Readonly<{
  idempotencyKey: IdempotencyKey;
  intentionHash: ContentHash;
  run: Run;
}>;

export type RunCostSnapshot = Readonly<{
  unit: string;
  spent: number;
  reserved: number;
}>;

export type StoredRunPlan = Readonly<{
  plan: RunPlan;
  consumedBy?: RunCreationRecord;
}>;

export type RunSnapshotRecord = Readonly<{
  run: Run;
  cost: RunCostSnapshot;
}>;

export type OutboxMessage = Readonly<{
  messageId: OutboxMessageId;
  destination: "orchestration.run.queued";
  eventId: EventId;
  workspaceId: WorkspaceId;
  aggregateId: RunId;
  aggregateVersion: 1;
  availableAt: Instant;
  event: RunQueued;
}>;

export interface RunPlanRepository {
  get(
    scope: WorkspaceScope,
    runPlanId: RunPlanId
  ): Promise<StoredRunPlan | undefined>;
  insert(scope: WorkspaceScope, plan: RunPlan): Promise<void>;
  markConsumed(
    scope: WorkspaceScope,
    runPlanId: RunPlanId,
    creation: RunCreationRecord
  ): Promise<void>;
}

export interface RunRepository {
  findByIdempotencyKey(
    scope: WorkspaceScope,
    idempotencyKey: IdempotencyKey
  ): Promise<RunCreationRecord | undefined>;
  insert(scope: WorkspaceScope, run: Run, cost: RunCostSnapshot): Promise<void>;
  lockIdempotencyKey(
    scope: WorkspaceScope,
    idempotencyKey: IdempotencyKey
  ): Promise<void>;
}

export interface RunEventRepository {
  append(scope: WorkspaceScope, event: RunQueued): Promise<void>;
}

export interface OutboxRepository {
  append(scope: WorkspaceScope, message: OutboxMessage): Promise<void>;
}

export type RunCreationUnitOfWork = Readonly<{
  runPlans: RunPlanRepository;
  runs: RunRepository;
  runEvents: RunEventRepository;
  outbox: OutboxRepository;
}>;

export interface PersistencePort {
  transaction<Value>(
    scope: WorkspaceScope,
    work: (unitOfWork: RunCreationUnitOfWork) => Promise<Value>
  ): Promise<Value>;
}

export interface RunQueryPort {
  get(
    scope: WorkspaceScope,
    runId: RunId
  ): Promise<RunSnapshotRecord | undefined>;
}

export interface ClockPort {
  now(): Promise<Instant>;
}

export interface RunExecutionRepository {
  getForUpdate(scope: WorkspaceScope, runId: RunId): Promise<Run | undefined>;
  update(
    scope: WorkspaceScope,
    expectedAggregateVersion: number,
    run: Run
  ): Promise<void>;
}

export interface RunLifecycleEventRepository {
  append(scope: WorkspaceScope, event: RunLifecycleEvent): Promise<void>;
}

export interface RunCommandJournalRepository {
  find(
    scope: WorkspaceScope,
    runId: RunId,
    commandIdempotencyKey: IdempotencyKey
  ): Promise<RunCommandReplayProof | undefined>;
  insert(
    scope: WorkspaceScope,
    proof: RunCommandReplayProof,
    actorId: ActorId,
    correlationId: CorrelationId
  ): Promise<void>;
}

export interface RunExecutionCellResultRepository {
  getByRun(
    scope: WorkspaceScope,
    runId: RunId
  ): Promise<CellResult | undefined>;
  markRunning(
    scope: WorkspaceScope,
    runId: RunId,
    cellResult: CellResult &
      Readonly<{
        status: "running";
      }>
  ): Promise<void>;
}

export type RunExecutionUnitOfWork = Readonly<{
  cellResults?: RunExecutionCellResultRepository;
  commandJournal: RunCommandJournalRepository;
  dagSchedule: DagScheduleRequestRepository;
  runEvents: RunLifecycleEventRepository;
  runs: RunExecutionRepository;
}>;

export interface RunExecutionPersistencePort {
  transaction<Value>(
    scope: WorkspaceScope,
    work: (unitOfWork: RunExecutionUnitOfWork) => Promise<Value>
  ): Promise<Value>;
}

export interface IdentifierPort {
  nextEventId(): Promise<EventId>;
  nextOutboxMessageId(): Promise<OutboxMessageId>;
  nextRunId(): Promise<RunId>;
}
