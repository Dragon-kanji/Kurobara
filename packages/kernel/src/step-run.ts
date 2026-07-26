import { amountsEqual, isAmount } from "./amount.ts";
import type { ValidatedOutputRef } from "./artifact.ts";
import { type DomainResult, fail, succeed } from "./result.ts";
import type { Run, RunState } from "./run.ts";
import type {
  ActorId,
  AttemptId,
  ContentHash,
  CorrelationId,
  CostReservationId,
  EventId,
  IdempotencyKey,
  Instant,
  OperationKey,
  RoutingDecisionId,
  StepRunId,
  UsageEntryId,
  WorkspaceId,
} from "./value-objects.ts";

export type StepRunState =
  | "pending"
  | "ready"
  | "active"
  | "waiting"
  | "retryable"
  | "ambiguous"
  | "cancelling"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "skipped";

export type AttemptState =
  | "prepared"
  | "claimed"
  | "in_flight"
  | "succeeded"
  | "failed_retryable"
  | "failed_terminal"
  | "ambiguous"
  | "cancelled_before_effect";

export type AttemptReason = "initial" | "retry" | "fallback";

export type Attempt = Readonly<{
  attemptId: AttemptId;
  attemptNumber: number;
  authorityEnvelopeId: string;
  claimedAt: Instant;
  costReservationId: CostReservationId;
  effectAdapterKey: string;
  operationKey: OperationKey;
  preparedAt: Instant;
  reason: AttemptReason;
  reservedAmount: number;
  reservationUnit: string;
  routeKey: string;
  routeSnapshotHash: ContentHash;
  routingDecisionId: RoutingDecisionId;
  state: AttemptState;
  stepRunId: StepRunId;
  effectStartedAt?: Instant;
  ambiguityObservedAt?: Instant;
  finishedAt?: Instant;
  output?: ValidatedOutputRef;
}>;

export type StepRun = Readonly<{
  activeAttemptId?: AttemptId;
  aggregateVersion: number;
  attempts: readonly Attempt[];
  createdAt: Instant;
  dependsOn: readonly string[];
  eventSequence: number;
  nodeKey: string;
  runId: Run["runId"];
  state: StepRunState;
  stepRunId: StepRunId;
  workspaceId: WorkspaceId;
}>;

type StepEventBase = Readonly<{
  actorId: ActorId;
  correlationId: CorrelationId;
  eventId: EventId;
  eventVersion: 1;
  occurredAt: Instant;
  runId: Run["runId"];
  sequence: number;
  stepRunId: StepRunId;
  workspaceId: WorkspaceId;
}>;

type StepLifecycleEventDetail =
  | Readonly<{ eventType: "StepReady"; nodeKey: string }>
  | Readonly<{
      blockedByNodeKeys: readonly string[];
      eventType: "StepSkipped";
      reason: "blocked-by-dependency";
    }>
  | Readonly<{
      effectAdapterKey: string;
      eventType: "RoutingDecisionRecorded";
      routeKey: string;
      routeSnapshotHash: ContentHash;
      routingDecisionId: RoutingDecisionId;
    }>
  | Readonly<{
      eventType: "StepRoutingRejected";
      reason: "no-route-available";
    }>
  | Readonly<{
      attemptId: AttemptId;
      attemptNumber: number;
      eventType: "AttemptCreated";
      operationKey: OperationKey;
      reason: AttemptReason;
    }>
  | Readonly<{
      attemptId: AttemptId;
      attemptNumber: number;
      eventType: "AttemptClaimed";
    }>
  | Readonly<{
      attemptId: AttemptId;
      eventType: "AttemptEffectStarted";
    }>
  | Readonly<{
      attemptId: AttemptId;
      eventType: "AttemptSucceeded";
      output?: ValidatedOutputRef;
    }>
  | Readonly<{
      attemptId: AttemptId;
      eventType: "AttemptFailed";
      retryable: boolean;
    }>
  | Readonly<{
      attemptId: AttemptId;
      eventType: "AttemptBecameAmbiguous";
      operationKey: OperationKey;
    }>
  | Readonly<{
      attemptId: AttemptId;
      eventType: "AttemptAmbiguityResolved";
      outcome: "succeeded" | "failed_retryable" | "failed_terminal";
      proofId: string;
      output?: ValidatedOutputRef;
    }>
  | Readonly<{
      attemptId: AttemptId;
      eventType: "AttemptCancelledBeforeEffect";
    }>
  | Readonly<{ eventType: "StepRetryAuthorized" }>
  | Readonly<{ eventType: "StepRetryExhausted" }>;

export type StepLifecycleEvent = StepEventBase & StepLifecycleEventDetail;

export type ScheduleStepInput = Readonly<{
  actorId: ActorId;
  correlationId: CorrelationId;
  createdAt: Instant;
  dependsOn: readonly string[];
  eventId: EventId;
  nodeKey: string;
  runId: Run["runId"];
  runState: RunState;
  satisfiedDependencies: readonly string[];
  stepRunId: StepRunId;
  workspaceId: WorkspaceId;
}>;

export type ScheduleStepDecision = Readonly<{
  event: StepLifecycleEvent;
  stepRun: StepRun;
}>;

export type ScheduleStepFailure = Readonly<{
  code: "run-not-running" | "node-key-required" | "dependencies-unsatisfied";
  message: string;
}>;

export type SkipStepInput = Readonly<{
  actorId: ActorId;
  blockedByNodeKeys: readonly string[];
  correlationId: CorrelationId;
  createdAt: Instant;
  dependsOn: readonly string[];
  eventId: EventId;
  nodeKey: string;
  runId: Run["runId"];
  runState: RunState;
  stepRunId: StepRunId;
  workspaceId: WorkspaceId;
}>;

export type SkipStepDecision = Readonly<{
  event: Extract<StepLifecycleEvent, { eventType: "StepSkipped" }>;
  stepRun: StepRun;
}>;

export type SkipStepFailure = Readonly<{
  code:
    | "blocked-dependency-invalid"
    | "blocked-dependency-required"
    | "blocked-dependency-unknown"
    | "node-key-required"
    | "run-not-running";
  message: string;
}>;

export type AttemptPreparation = Readonly<{
  attemptId: AttemptId;
  authorityEnvelopeId: string;
  costReservationId: CostReservationId;
  effectAdapterKey: string;
  operationKey: OperationKey;
  reason: AttemptReason;
  reservedAmount: number;
  reservationUnit: string;
  routeKey: string;
  routeSnapshotHash: ContentHash;
  routingDecisionId: RoutingDecisionId;
}>;

type CostReservationBase = Readonly<{
  amount: number;
  attemptId: AttemptId;
  createdAt: Instant;
  operationKey: OperationKey;
  reservationId: CostReservationId;
  runId: Run["runId"];
  stepRunId: StepRunId;
  unit: string;
  workspaceId: WorkspaceId;
}>;

export type CostReservation =
  | (CostReservationBase & Readonly<{ state: "reserved" }>)
  | (CostReservationBase &
      Readonly<{
        settledAmount: number;
        releasedAmount: number;
        settledAt: Instant;
        state: "settled";
        usageEntryId: UsageEntryId;
      }>)
  | (CostReservationBase &
      Readonly<{
        releasedAt: Instant;
        state: "released";
      }>);

export type UsageEntry = Readonly<{
  amount: number;
  attemptId: AttemptId;
  operationKey: OperationKey;
  recordedAt: Instant;
  reservationId: CostReservationId;
  runId: Run["runId"];
  unit: string;
  usageEntryId: UsageEntryId;
  workspaceId: WorkspaceId;
  reconciliationProofId?: string;
}>;

type AttemptSettlementIdentity = Readonly<{
  attemptId: AttemptId;
  operationKey: OperationKey;
  reservationId: CostReservationId;
  unit: string;
}>;

export type AttemptSettlementProof =
  | (AttemptSettlementIdentity &
      Readonly<{
        disposition: "settled";
        releasedAmount: number;
        settledAmount: number;
        usageEntryId: UsageEntryId;
      }>)
  | (AttemptSettlementIdentity &
      Readonly<{
        disposition: "released";
        releasedAmount: number;
      }>);

export type StepCommand =
  | Readonly<{
      preparation: AttemptPreparation;
      type: "ClaimStepAttempt";
    }>
  | Readonly<{
      reason: "no-route-available";
      type: "RejectStepRouting";
    }>
  | Readonly<{
      attemptId: AttemptId;
      output?: ValidatedOutputRef;
      settlement: AttemptSettlementProof;
      type: "RecordAttemptSucceeded";
    }>
  | Readonly<{
      attemptId: AttemptId;
      retryAuthorized: boolean;
      retryable: boolean;
      settlement: AttemptSettlementProof;
      type: "RecordAttemptFailure";
    }>
  | Readonly<{
      attemptId: AttemptId;
      retryAuthorized: boolean;
      retryable: boolean;
      settlement: Extract<AttemptSettlementProof, { disposition: "released" }>;
      type: "RecordAttemptNotStarted";
    }>
  | Readonly<{
      attemptId: AttemptId;
      retryAuthorized: boolean;
      type: "AuthorizeRetry";
    }>
  | Readonly<{ attemptId: AttemptId; type: "MarkAttemptAmbiguous" }>
  | Readonly<{
      attemptId: AttemptId;
      outcome: "succeeded" | "failed_retryable" | "failed_terminal";
      proofId: string;
      retryAuthorized: boolean;
      settlement: AttemptSettlementProof;
      type: "ResolveAttemptAmbiguity";
      output?: ValidatedOutputRef;
    }>
  | Readonly<{
      attemptId: AttemptId;
      settlement: Extract<AttemptSettlementProof, { disposition: "released" }>;
      type: "CancelAttemptBeforeEffect";
    }>
  | Readonly<{ attemptId: AttemptId; type: "StartAttemptEffect" }>;

export type StepCommandIdentity = Readonly<{
  commandHash: ContentHash;
  idempotencyKey: IdempotencyKey;
}>;

export type StepCommandReplayProof = Readonly<{
  actorId: ActorId;
  commandType: StepCommand["type"];
  identity: StepCommandIdentity;
  stepRunId: StepRunId;
  workspaceId: WorkspaceId;
}>;

export type StepCommandContext = Readonly<{
  actorId: ActorId;
  commandIdentity: StepCommandIdentity;
  correlationId: CorrelationId;
  eventIds: readonly EventId[];
  expectedAggregateVersion: number;
  occurredAt: Instant;
  replayProof?: StepCommandReplayProof;
}>;

export type StepTransition = Readonly<{
  events: readonly StepLifecycleEvent[];
  replayed: boolean;
  stepRun: StepRun;
}>;

export type StepTransitionFailureCode =
  | "aggregate-version-conflict"
  | "attempt-id-reused"
  | "event-id-count-mismatch"
  | "idempotency-key-reused"
  | "invalid-attempt-preparation"
  | "invalid-attempt-reason"
  | "invalid-transition"
  | "operation-key-mismatch"
  | "reconciliation-proof-required"
  | "replay-proof-mismatch"
  | "settlement-precondition-failed";

export type StepTransitionFailure = Readonly<{
  code: StepTransitionFailureCode;
  command: StepCommand["type"];
  message: string;
  state: StepRunState;
}>;

type StepTransitionPlan = Readonly<{
  activeAttemptId?: AttemptId;
  attempts: readonly Attempt[];
  eventDetails: readonly StepLifecycleEventDetail[];
  state: StepRunState;
}>;

export const scheduleStep = (
  input: ScheduleStepInput
): DomainResult<ScheduleStepDecision, ScheduleStepFailure> => {
  if (input.runState !== "running") {
    return fail({
      code: "run-not-running",
      message: `A step cannot become ready while its run is ${input.runState}.`,
    });
  }
  if (input.nodeKey.trim().length === 0) {
    return fail({
      code: "node-key-required",
      message: "A scheduled step requires a non-empty workflow node key.",
    });
  }
  const satisfied = new Set(input.satisfiedDependencies);
  const missing = input.dependsOn.filter(
    (dependency) => !satisfied.has(dependency)
  );
  if (missing.length > 0) {
    return fail({
      code: "dependencies-unsatisfied",
      message: `Step dependencies are not satisfied: ${missing.join(", ")}.`,
    });
  }

  const stepRun: StepRun = {
    aggregateVersion: 1,
    attempts: [],
    createdAt: input.createdAt,
    dependsOn: [...input.dependsOn],
    eventSequence: 1,
    nodeKey: input.nodeKey,
    runId: input.runId,
    state: "ready",
    stepRunId: input.stepRunId,
    workspaceId: input.workspaceId,
  };
  const event: StepLifecycleEvent = {
    actorId: input.actorId,
    correlationId: input.correlationId,
    eventId: input.eventId,
    eventType: "StepReady",
    eventVersion: 1,
    nodeKey: input.nodeKey,
    occurredAt: input.createdAt,
    runId: input.runId,
    sequence: 1,
    stepRunId: input.stepRunId,
    workspaceId: input.workspaceId,
  };
  return succeed({ event, stepRun });
};

export const skipStep = (
  input: SkipStepInput
): DomainResult<SkipStepDecision, SkipStepFailure> => {
  if (input.runState !== "running") {
    return fail({
      code: "run-not-running",
      message: `A step cannot be skipped while its run is ${input.runState}.`,
    });
  }
  if (input.nodeKey.trim().length === 0) {
    return fail({
      code: "node-key-required",
      message: "A skipped step requires a non-empty workflow node key.",
    });
  }
  if (input.blockedByNodeKeys.length === 0) {
    return fail({
      code: "blocked-dependency-required",
      message: "A skipped step requires a terminal non-success dependency.",
    });
  }
  const blockedByNodeKeys = [...new Set(input.blockedByNodeKeys)].sort();
  if (
    blockedByNodeKeys.length !== input.blockedByNodeKeys.length ||
    blockedByNodeKeys.some((nodeKey) => nodeKey.trim().length === 0)
  ) {
    return fail({
      code: "blocked-dependency-invalid",
      message: "Skipped-step dependency evidence must be non-empty and unique.",
    });
  }
  const dependencies = new Set(input.dependsOn);
  if (blockedByNodeKeys.some((nodeKey) => !dependencies.has(nodeKey))) {
    return fail({
      code: "blocked-dependency-unknown",
      message: "A skipped step can only name one of its direct dependencies.",
    });
  }
  const stepRun: StepRun = {
    aggregateVersion: 1,
    attempts: [],
    createdAt: input.createdAt,
    dependsOn: [...input.dependsOn],
    eventSequence: 1,
    nodeKey: input.nodeKey,
    runId: input.runId,
    state: "skipped",
    stepRunId: input.stepRunId,
    workspaceId: input.workspaceId,
  };
  const event: Extract<StepLifecycleEvent, { eventType: "StepSkipped" }> = {
    actorId: input.actorId,
    blockedByNodeKeys,
    correlationId: input.correlationId,
    eventId: input.eventId,
    eventType: "StepSkipped",
    eventVersion: 1,
    occurredAt: input.createdAt,
    reason: "blocked-by-dependency",
    runId: input.runId,
    sequence: 1,
    stepRunId: input.stepRunId,
    workspaceId: input.workspaceId,
  };
  return succeed({ event, stepRun });
};

const invalidTransition = (
  stepRun: StepRun,
  command: StepCommand
): DomainResult<never, StepTransitionFailure> =>
  fail({
    code: "invalid-transition",
    command: command.type,
    message: `${command.type} is not allowed from step state ${stepRun.state}.`,
    state: stepRun.state,
  });

const activeAttempt = (stepRun: StepRun): Attempt | undefined =>
  stepRun.attempts.find(
    (attempt) => attempt.attemptId === stepRun.activeAttemptId
  );

const matchingActiveAttempt = (
  stepRun: StepRun,
  attemptId: AttemptId
): Attempt | undefined => {
  const attempt = activeAttempt(stepRun);
  return attempt?.attemptId === attemptId ? attempt : undefined;
};

const settlementMatches = (
  attempt: Attempt,
  settlement: AttemptSettlementProof
): boolean => {
  const identityMatches =
    settlement.attemptId === attempt.attemptId &&
    settlement.operationKey === attempt.operationKey &&
    settlement.reservationId === attempt.costReservationId &&
    settlement.unit === attempt.reservationUnit;
  if (!(identityMatches && isAmount(settlement.releasedAmount))) {
    return false;
  }
  if (settlement.disposition === "released") {
    return amountsEqual(settlement.releasedAmount, attempt.reservedAmount);
  }
  return (
    isAmount(settlement.settledAmount) &&
    amountsEqual(
      settlement.settledAmount + settlement.releasedAmount,
      attempt.reservedAmount
    )
  );
};

const replaceAttempt = (
  stepRun: StepRun,
  replacement: Attempt
): readonly Attempt[] =>
  stepRun.attempts.map((attempt) =>
    attempt.attemptId === replacement.attemptId ? replacement : attempt
  );

const validatedOutputIsWellFormed = (
  output: ValidatedOutputRef,
  occurredAt: Instant
): boolean =>
  output.validatorVersion.trim().length > 0 && output.validatedAt <= occurredAt;

const retryDecisionDetail = (
  retryAuthorized: boolean
): StepLifecycleEventDetail => ({
  eventType: retryAuthorized ? "StepRetryAuthorized" : "StepRetryExhausted",
});

const invalidRetryAuthorization = (
  stepRun: StepRun,
  command: StepCommand,
  retryRequested: boolean
): DomainResult<never, StepTransitionFailure> | undefined =>
  command.type !== "AuthorizeRetry" &&
  "retryAuthorized" in command &&
  command.retryAuthorized &&
  !retryRequested
    ? fail({
        code: "invalid-transition",
        command: command.type,
        message: `${command.type} cannot authorize a retry for a terminal outcome.`,
        state: stepRun.state,
      })
    : undefined;

const claimAttempt = (
  stepRun: StepRun,
  command: Extract<StepCommand, { type: "ClaimStepAttempt" }>,
  occurredAt: Instant
): DomainResult<StepTransitionPlan, StepTransitionFailure> => {
  if (stepRun.state !== "ready" || stepRun.activeAttemptId !== undefined) {
    return invalidTransition(stepRun, command);
  }
  const { preparation } = command;
  if (
    preparation.authorityEnvelopeId.trim().length === 0 ||
    preparation.effectAdapterKey.trim().length === 0 ||
    preparation.routeKey.trim().length === 0 ||
    preparation.reservationUnit.trim().length === 0 ||
    !isAmount(preparation.reservedAmount)
  ) {
    return fail({
      code: "invalid-attempt-preparation",
      command: command.type,
      message:
        "Attempt preparation requires authority, unit, and a non-negative finite reservation.",
      state: stepRun.state,
    });
  }
  const isInitial = stepRun.attempts.length === 0;
  if (
    (isInitial && preparation.reason !== "initial") ||
    (!isInitial && preparation.reason === "initial")
  ) {
    return fail({
      code: "invalid-attempt-reason",
      command: command.type,
      message:
        "The first attempt must be initial and every later attempt must be a retry or fallback.",
      state: stepRun.state,
    });
  }
  if (
    stepRun.attempts.some(
      (attempt) => attempt.attemptId === preparation.attemptId
    )
  ) {
    return fail({
      code: "attempt-id-reused",
      command: command.type,
      message: "A new attempt requires a fresh attempt identifier.",
      state: stepRun.state,
    });
  }
  const originalOperationKey = stepRun.attempts[0]?.operationKey;
  if (
    originalOperationKey !== undefined &&
    originalOperationKey !== preparation.operationKey
  ) {
    return fail({
      code: "operation-key-mismatch",
      command: command.type,
      message: "Retries and fallbacks must keep the logical operation key.",
      state: stepRun.state,
    });
  }

  const attempt: Attempt = {
    attemptId: preparation.attemptId,
    attemptNumber: stepRun.attempts.length + 1,
    authorityEnvelopeId: preparation.authorityEnvelopeId,
    claimedAt: occurredAt,
    costReservationId: preparation.costReservationId,
    effectAdapterKey: preparation.effectAdapterKey,
    operationKey: preparation.operationKey,
    preparedAt: occurredAt,
    reason: preparation.reason,
    reservationUnit: preparation.reservationUnit,
    reservedAmount: preparation.reservedAmount,
    routeKey: preparation.routeKey,
    routeSnapshotHash: preparation.routeSnapshotHash,
    routingDecisionId: preparation.routingDecisionId,
    state: "claimed",
    stepRunId: stepRun.stepRunId,
  };
  return succeed({
    activeAttemptId: attempt.attemptId,
    attempts: [...stepRun.attempts, attempt],
    eventDetails: [
      {
        effectAdapterKey: attempt.effectAdapterKey,
        eventType: "RoutingDecisionRecorded",
        routeKey: attempt.routeKey,
        routeSnapshotHash: attempt.routeSnapshotHash,
        routingDecisionId: attempt.routingDecisionId,
      },
      {
        attemptId: attempt.attemptId,
        attemptNumber: attempt.attemptNumber,
        eventType: "AttemptCreated",
        operationKey: attempt.operationKey,
        reason: attempt.reason,
      },
      {
        attemptId: attempt.attemptId,
        attemptNumber: attempt.attemptNumber,
        eventType: "AttemptClaimed",
      },
    ],
    state: "active",
  });
};

const rejectStepRouting = (
  stepRun: StepRun,
  command: Extract<StepCommand, { type: "RejectStepRouting" }>
): DomainResult<StepTransitionPlan, StepTransitionFailure> => {
  if (stepRun.state !== "ready" || stepRun.activeAttemptId !== undefined) {
    return invalidTransition(stepRun, command);
  }
  return succeed({
    attempts: stepRun.attempts,
    eventDetails: [
      { eventType: "StepRoutingRejected", reason: command.reason },
    ],
    state: "failed",
  });
};

const startAttemptEffect = (
  stepRun: StepRun,
  command: Extract<StepCommand, { type: "StartAttemptEffect" }>,
  occurredAt: Instant
): DomainResult<StepTransitionPlan, StepTransitionFailure> => {
  const attempt = matchingActiveAttempt(stepRun, command.attemptId);
  if (stepRun.state !== "active" || attempt?.state !== "claimed") {
    return invalidTransition(stepRun, command);
  }
  const started: Attempt = {
    ...attempt,
    effectStartedAt: occurredAt,
    state: "in_flight",
  };
  return succeed({
    activeAttemptId: attempt.attemptId,
    attempts: replaceAttempt(stepRun, started),
    eventDetails: [
      { attemptId: attempt.attemptId, eventType: "AttemptEffectStarted" },
    ],
    state: "active",
  });
};

type AttemptSettlementCommand = Extract<
  StepCommand,
  { type: "RecordAttemptSucceeded" | "RecordAttemptFailure" }
>;

const attemptSettlementEventDetails = (
  command: AttemptSettlementCommand,
  attempt: Attempt,
  retryRequested: boolean,
  retryable: boolean
): readonly StepLifecycleEventDetail[] => {
  if (command.type === "RecordAttemptSucceeded") {
    return [
      {
        attemptId: attempt.attemptId,
        eventType: "AttemptSucceeded",
        ...(command.output === undefined ? {} : { output: command.output }),
      },
    ];
  }
  return [
    {
      attemptId: attempt.attemptId,
      eventType: "AttemptFailed",
      retryable,
    },
    ...(retryRequested ? [retryDecisionDetail(command.retryAuthorized)] : []),
  ];
};

const settleAttempt = (
  stepRun: StepRun,
  command: AttemptSettlementCommand,
  occurredAt: Instant
): DomainResult<StepTransitionPlan, StepTransitionFailure> => {
  const attempt = matchingActiveAttempt(stepRun, command.attemptId);
  if (stepRun.state !== "active" || attempt?.state !== "in_flight") {
    return invalidTransition(stepRun, command);
  }
  if (
    !settlementMatches(attempt, command.settlement) ||
    (command.type === "RecordAttemptSucceeded" &&
      (command.settlement.disposition !== "settled" ||
        (command.output !== undefined &&
          !validatedOutputIsWellFormed(command.output, occurredAt))))
  ) {
    return fail({
      code: "settlement-precondition-failed",
      command: command.type,
      message:
        "An in-flight attempt requires an exact durable settlement receipt before conclusion.",
      state: stepRun.state,
    });
  }
  const succeeded = command.type === "RecordAttemptSucceeded";
  const retryRequested =
    command.type === "RecordAttemptFailure" && command.retryable;
  const retryFailure = invalidRetryAuthorization(
    stepRun,
    command,
    retryRequested
  );
  if (retryFailure !== undefined) {
    return retryFailure;
  }
  const retryable =
    retryRequested &&
    command.type === "RecordAttemptFailure" &&
    command.retryAuthorized;
  let attemptState: AttemptState = "failed_terminal";
  let stepState: StepRunState = "failed";
  if (succeeded) {
    attemptState = "succeeded";
    stepState = "succeeded";
  } else if (retryable) {
    attemptState = "failed_retryable";
    stepState = "ready";
  }
  const settled: Attempt = {
    ...attempt,
    finishedAt: occurredAt,
    ...(command.type === "RecordAttemptSucceeded" &&
    command.output !== undefined
      ? { output: command.output }
      : {}),
    state: attemptState,
  };
  return succeed({
    attempts: replaceAttempt(stepRun, settled),
    eventDetails: attemptSettlementEventDetails(
      command,
      attempt,
      retryRequested,
      retryable
    ),
    state: stepState,
  });
};

const recordAttemptNotStarted = (
  stepRun: StepRun,
  command: Extract<StepCommand, { type: "RecordAttemptNotStarted" }>,
  occurredAt: Instant
): DomainResult<StepTransitionPlan, StepTransitionFailure> => {
  const attempt = matchingActiveAttempt(stepRun, command.attemptId);
  if (stepRun.state !== "active" || attempt?.state !== "claimed") {
    return invalidTransition(stepRun, command);
  }
  if (!settlementMatches(attempt, command.settlement)) {
    return fail({
      code: "settlement-precondition-failed",
      command: command.type,
      message:
        "An attempt that did not start requires its exact durable release receipt before conclusion.",
      state: stepRun.state,
    });
  }
  const retryFailure = invalidRetryAuthorization(
    stepRun,
    command,
    command.retryable
  );
  if (retryFailure !== undefined) {
    return retryFailure;
  }
  const retryable = command.retryable && command.retryAuthorized;
  const failed: Attempt = {
    ...attempt,
    finishedAt: occurredAt,
    state: retryable ? "failed_retryable" : "failed_terminal",
  };
  return succeed({
    attempts: replaceAttempt(stepRun, failed),
    eventDetails: [
      {
        attemptId: attempt.attemptId,
        eventType: "AttemptFailed",
        retryable,
      },
      ...(command.retryable
        ? [retryDecisionDetail(command.retryAuthorized)]
        : []),
    ],
    state: retryable ? "ready" : "failed",
  });
};

const authorizeRetry = (
  stepRun: StepRun,
  command: Extract<StepCommand, { type: "AuthorizeRetry" }>
): DomainResult<StepTransitionPlan, StepTransitionFailure> => {
  if (
    stepRun.state !== "retryable" ||
    stepRun.activeAttemptId !== undefined ||
    stepRun.attempts.at(-1)?.attemptId !== command.attemptId ||
    stepRun.attempts.at(-1)?.state !== "failed_retryable"
  ) {
    return invalidTransition(stepRun, command);
  }
  return command.retryAuthorized
    ? succeed({
        attempts: stepRun.attempts,
        eventDetails: [{ eventType: "StepRetryAuthorized" }],
        state: "ready",
      })
    : succeed({
        attempts: stepRun.attempts,
        eventDetails: [{ eventType: "StepRetryExhausted" }],
        state: "failed",
      });
};

const markAttemptAmbiguous = (
  stepRun: StepRun,
  command: Extract<StepCommand, { type: "MarkAttemptAmbiguous" }>,
  occurredAt: Instant
): DomainResult<StepTransitionPlan, StepTransitionFailure> => {
  const attempt = matchingActiveAttempt(stepRun, command.attemptId);
  if (stepRun.state !== "active" || attempt?.state !== "in_flight") {
    return invalidTransition(stepRun, command);
  }
  const ambiguous: Attempt = {
    ...attempt,
    ambiguityObservedAt: occurredAt,
    state: "ambiguous",
  };
  return succeed({
    activeAttemptId: attempt.attemptId,
    attempts: replaceAttempt(stepRun, ambiguous),
    eventDetails: [
      {
        attemptId: attempt.attemptId,
        eventType: "AttemptBecameAmbiguous",
        operationKey: attempt.operationKey,
      },
    ],
    state: "ambiguous",
  });
};

const resolveAttemptAmbiguity = (
  stepRun: StepRun,
  command: Extract<StepCommand, { type: "ResolveAttemptAmbiguity" }>,
  occurredAt: Instant
): DomainResult<StepTransitionPlan, StepTransitionFailure> => {
  const attempt = matchingActiveAttempt(stepRun, command.attemptId);
  if (stepRun.state !== "ambiguous" || attempt?.state !== "ambiguous") {
    return invalidTransition(stepRun, command);
  }
  if (command.proofId.trim().length === 0) {
    return fail({
      code: "reconciliation-proof-required",
      command: command.type,
      message: "Attempt ambiguity resolution requires a proof identifier.",
      state: stepRun.state,
    });
  }
  if (
    !settlementMatches(attempt, command.settlement) ||
    (command.outcome === "succeeded" &&
      (command.settlement.disposition !== "settled" ||
        (command.output !== undefined &&
          !validatedOutputIsWellFormed(command.output, occurredAt)))) ||
    (command.outcome !== "succeeded" && command.output !== undefined)
  ) {
    return fail({
      code: "settlement-precondition-failed",
      command: command.type,
      message:
        "Attempt ambiguity requires an exact durable settlement receipt before resolution.",
      state: stepRun.state,
    });
  }
  const succeeded = command.outcome === "succeeded";
  const retryRequested = command.outcome === "failed_retryable";
  const retryFailure = invalidRetryAuthorization(
    stepRun,
    command,
    retryRequested
  );
  if (retryFailure !== undefined) {
    return retryFailure;
  }
  const retryable = retryRequested && command.retryAuthorized;
  const outcome =
    retryRequested && !retryable ? "failed_terminal" : command.outcome;
  let attemptState: AttemptState = "failed_terminal";
  let stepState: StepRunState = "failed";
  if (succeeded) {
    attemptState = "succeeded";
    stepState = "succeeded";
  } else if (retryable) {
    attemptState = "failed_retryable";
    stepState = "retryable";
  }
  const resolved: Attempt = {
    ...attempt,
    finishedAt: occurredAt,
    ...(succeeded && command.output !== undefined
      ? { output: command.output }
      : {}),
    state: attemptState,
  };
  return succeed({
    attempts: replaceAttempt(stepRun, resolved),
    eventDetails: [
      {
        attemptId: attempt.attemptId,
        eventType: "AttemptAmbiguityResolved",
        outcome,
        proofId: command.proofId,
        ...(command.output === undefined ? {} : { output: command.output }),
      },
      ...(retryRequested ? [retryDecisionDetail(command.retryAuthorized)] : []),
    ],
    state: retryable ? "ready" : stepState,
  });
};

const cancelAttemptBeforeEffect = (
  stepRun: StepRun,
  command: Extract<StepCommand, { type: "CancelAttemptBeforeEffect" }>,
  occurredAt: Instant
): DomainResult<StepTransitionPlan, StepTransitionFailure> => {
  const attempt = matchingActiveAttempt(stepRun, command.attemptId);
  if (stepRun.state !== "active" || attempt?.state !== "claimed") {
    return invalidTransition(stepRun, command);
  }
  if (!settlementMatches(attempt, command.settlement)) {
    return fail({
      code: "settlement-precondition-failed",
      command: command.type,
      message:
        "A claimed attempt cannot cancel without its exact durable release receipt.",
      state: stepRun.state,
    });
  }
  const cancelled: Attempt = {
    ...attempt,
    finishedAt: occurredAt,
    state: "cancelled_before_effect",
  };
  return succeed({
    attempts: replaceAttempt(stepRun, cancelled),
    eventDetails: [
      {
        attemptId: attempt.attemptId,
        eventType: "AttemptCancelledBeforeEffect",
      },
    ],
    state: "cancelled",
  });
};

const planTransition = (
  stepRun: StepRun,
  command: StepCommand,
  occurredAt: Instant
): DomainResult<StepTransitionPlan, StepTransitionFailure> => {
  switch (command.type) {
    case "ClaimStepAttempt":
      return claimAttempt(stepRun, command, occurredAt);
    case "RejectStepRouting":
      return rejectStepRouting(stepRun, command);
    case "StartAttemptEffect":
      return startAttemptEffect(stepRun, command, occurredAt);
    case "RecordAttemptSucceeded":
    case "RecordAttemptFailure":
      return settleAttempt(stepRun, command, occurredAt);
    case "RecordAttemptNotStarted":
      return recordAttemptNotStarted(stepRun, command, occurredAt);
    case "AuthorizeRetry":
      return authorizeRetry(stepRun, command);
    case "MarkAttemptAmbiguous":
      return markAttemptAmbiguous(stepRun, command, occurredAt);
    case "ResolveAttemptAmbiguity":
      return resolveAttemptAmbiguity(stepRun, command, occurredAt);
    case "CancelAttemptBeforeEffect":
      return cancelAttemptBeforeEffect(stepRun, command, occurredAt);
    default:
      return invalidTransition(stepRun, command);
  }
};

const toEvent = (
  stepRun: StepRun,
  detail: StepLifecycleEventDetail,
  context: StepCommandContext,
  index: number
): StepLifecycleEvent => ({
  actorId: context.actorId,
  correlationId: context.correlationId,
  eventId: context.eventIds[index] as EventId,
  eventVersion: 1,
  occurredAt: context.occurredAt,
  runId: stepRun.runId,
  sequence: stepRun.eventSequence + index + 1,
  stepRunId: stepRun.stepRunId,
  workspaceId: stepRun.workspaceId,
  ...detail,
});

export const applyStepCommand = (
  stepRun: StepRun,
  command: StepCommand,
  context: StepCommandContext
): DomainResult<StepTransition, StepTransitionFailure> => {
  if (context.replayProof !== undefined) {
    if (
      context.replayProof.stepRunId !== stepRun.stepRunId ||
      context.replayProof.workspaceId !== stepRun.workspaceId ||
      context.replayProof.actorId !== context.actorId ||
      context.replayProof.identity.idempotencyKey !==
        context.commandIdentity.idempotencyKey
    ) {
      return fail({
        code: "replay-proof-mismatch",
        command: command.type,
        message:
          "The durable replay proof does not identify this step, workspace, and command idempotency key.",
        state: stepRun.state,
      });
    }
    if (
      context.replayProof.commandType !== command.type ||
      context.replayProof.identity.commandHash !==
        context.commandIdentity.commandHash
    ) {
      return fail({
        code: "idempotency-key-reused",
        command: command.type,
        message:
          "The step command idempotency key was accepted for a different command.",
        state: stepRun.state,
      });
    }
    return succeed({ events: [], replayed: true, stepRun });
  }

  if (context.expectedAggregateVersion !== stepRun.aggregateVersion) {
    return fail({
      code: "aggregate-version-conflict",
      command: command.type,
      message: `Expected aggregate version ${context.expectedAggregateVersion}, actual version is ${stepRun.aggregateVersion}.`,
      state: stepRun.state,
    });
  }
  const planned = planTransition(stepRun, command, context.occurredAt);
  if (!planned.ok) {
    return planned;
  }
  if (context.eventIds.length !== planned.value.eventDetails.length) {
    return fail({
      code: "event-id-count-mismatch",
      command: command.type,
      message: `Command requires ${planned.value.eventDetails.length} event IDs; received ${context.eventIds.length}.`,
      state: stepRun.state,
    });
  }
  const events = planned.value.eventDetails.map((detail, index) =>
    toEvent(stepRun, detail, context, index)
  );
  const nextStepRun: StepRun = {
    ...stepRun,
    aggregateVersion: stepRun.aggregateVersion + 1,
    attempts: planned.value.attempts,
    eventSequence: stepRun.eventSequence + events.length,
    state: planned.value.state,
    ...(planned.value.activeAttemptId === undefined
      ? { activeAttemptId: undefined }
      : { activeAttemptId: planned.value.activeAttemptId }),
  };
  return succeed({ events, replayed: false, stepRun: nextStepRun });
};
