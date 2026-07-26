import {
  type ActorId,
  type Attempt,
  type AttemptId,
  type AttemptReason,
  applyStepCommand,
  type CapabilityRef,
  type CompiledWorkflowNode,
  type ContentHash,
  type CorrelationId,
  type CostReservation,
  type CostReservationId,
  createRoutingDecision,
  type DomainResult,
  type EventId,
  fail,
  type IdempotencyKey,
  type Instant,
  isAmount,
  isSupportedAuthorityEnvelopeVersion,
  type OperationKey,
  type OutboxMessageId,
  type RoutingDecision,
  type RoutingDecisionId,
  type RunId,
  routingDecisionId,
  type StepCommand,
  type StepCommandIdentity,
  type StepCommandReplayProof,
  type StepLifecycleEvent,
  type StepRun,
  type StepRunId,
  type StepTransition,
  scheduleStep,
  succeed,
  type WorkspaceId,
} from "@kurobara/kernel";
import type {
  ClockPort,
  LeafOutboxMessage,
  StepExecutionContext,
  StepExecutionPersistencePort,
  StepExecutionUnitOfWork,
  WorkspaceScope,
} from "@kurobara/ports";

import { canonicalContentHash } from "./canonical-content-hash.ts";

export type ClaimStepAttemptInput = Readonly<{
  actorId: ActorId;
  attemptId: AttemptId;
  commandIdempotencyKey: IdempotencyKey;
  correlationId: CorrelationId;
  costReservationId: CostReservationId;
  expectedAggregateVersion: number | "absent";
  nodeKey: string;
  operationKey: OperationKey;
  reason: AttemptReason;
  routeKey: string;
  runId: RunId;
  stepRunId: StepRunId;
  workspaceId: WorkspaceId;
}>;

export type ClaimStepAttemptSuccess = Readonly<{
  replayed: boolean;
  reservationStatus: "created" | "existing";
  stepRun: StepRun;
}>;

export type ClaimStepAttemptFailureCode =
  | "authority-capability-missing"
  | "authority-permission-missing"
  | "authority-subject-mismatch"
  | "authority-version-unsupported"
  | "budget-exceeded"
  | "cost-reservation-conflict"
  | "deadline-elapsed"
  | "invalid-reservation"
  | "node-not-found"
  | "run-not-found"
  | "run-not-running"
  | "route-not-found"
  | "step-id-conflict"
  | "step-version-conflict"
  | "transition-rejected";

export type ClaimStepAttemptFailure = Readonly<{
  code: ClaimStepAttemptFailureCode;
  domainCode?: string;
  message: string;
}>;

export type ClaimStepAttemptResult = DomainResult<
  ClaimStepAttemptSuccess,
  ClaimStepAttemptFailure
>;

export type StepEventIdentifierPort = Readonly<{
  nextEventId(): Promise<EventId>;
}>;

export type StepClaimIdentifierPort = StepEventIdentifierPort &
  Readonly<{
    nextOutboxMessageId(): Promise<OutboxMessageId>;
  }>;

export type ClaimStepAttemptDependencies = Readonly<{
  clock: ClockPort;
  identifiers: StepClaimIdentifierPort;
  persistence: StepExecutionPersistencePort;
  requiredPermission: string;
}>;

type ClaimStepCommand = Extract<StepCommand, { type: "ClaimStepAttempt" }>;
type ReadyStep = Readonly<{
  event?: StepLifecycleEvent;
  stepRun: StepRun;
}>;

const transitionRejected = (
  domainCode: string,
  message: string
): ClaimStepAttemptResult =>
  fail({ code: "transition-rejected", domainCode, message });

const capabilityMatches = (
  left: CapabilityRef,
  right: CapabilityRef
): boolean =>
  left.capabilityId === right.capabilityId &&
  left.capabilityVersion === right.capabilityVersion;

const claimStepAttemptCommandHash = (
  input: ClaimStepAttemptInput
): ContentHash =>
  canonicalContentHash({
    attemptId: input.attemptId,
    costReservationId: input.costReservationId,
    expectedAggregateVersion: input.expectedAggregateVersion,
    nodeKey: input.nodeKey,
    operationKey: input.operationKey,
    reason: input.reason,
    routeKey: input.routeKey,
    runId: input.runId,
    stepRunId: input.stepRunId,
    type: "ClaimStepAttempt",
    workspaceId: input.workspaceId,
  });

const toCommand = (
  input: ClaimStepAttemptInput,
  authorityEnvelopeId: string,
  decision: RoutingDecision
): ClaimStepCommand => ({
  preparation: {
    attemptId: input.attemptId,
    authorityEnvelopeId,
    costReservationId: input.costReservationId,
    effectAdapterKey: decision.effectAdapterKey,
    operationKey: input.operationKey,
    reason: input.reason,
    reservationUnit: decision.reservationUnit,
    reservedAmount: decision.reservedAmount,
    routeKey: decision.routeKey,
    routeSnapshotHash: decision.routeSnapshotHash,
    routingDecisionId: decision.routingDecisionId,
  },
  type: "ClaimStepAttempt",
});

const replayClaim = (
  existingStep: StepRun | undefined,
  replayProof: StepCommandReplayProof,
  command: ClaimStepCommand,
  identity: StepCommandIdentity,
  input: ClaimStepAttemptInput,
  technicalActorId: ActorId
): ClaimStepAttemptResult => {
  if (existingStep === undefined) {
    return transitionRejected(
      "replay-proof-mismatch",
      "A durable step command proof exists without its step aggregate."
    );
  }
  const replay = applyStepCommand(existingStep, command, {
    actorId: technicalActorId,
    commandIdentity: identity,
    correlationId: input.correlationId,
    eventIds: [],
    expectedAggregateVersion: existingStep.aggregateVersion,
    occurredAt: existingStep.createdAt,
    replayProof,
  });
  if (!replay.ok) {
    return transitionRejected(replay.error.code, replay.error.message);
  }
  return succeed({
    replayed: true,
    reservationStatus: "existing",
    stepRun: replay.value.stepRun,
  });
};

const replayCommandFrom = (
  existingStep: StepRun | undefined,
  input: ClaimStepAttemptInput,
  authorityEnvelopeId: string
): ClaimStepCommand | undefined => {
  const attempt = existingStep?.attempts.find(
    (entry) => entry.attemptId === input.attemptId
  );
  return attempt === undefined
    ? undefined
    : {
        preparation: {
          attemptId: attempt.attemptId,
          authorityEnvelopeId,
          costReservationId: attempt.costReservationId,
          effectAdapterKey: attempt.effectAdapterKey,
          operationKey: attempt.operationKey,
          reason: attempt.reason,
          reservationUnit: attempt.reservationUnit,
          reservedAmount: attempt.reservedAmount,
          routeKey: attempt.routeKey,
          routeSnapshotHash: attempt.routeSnapshotHash,
          routingDecisionId: attempt.routingDecisionId,
        },
        type: "ClaimStepAttempt",
      };
};

const findAdmittedNode = (
  context: StepExecutionContext,
  input: ClaimStepAttemptInput,
  now: Instant,
  requiredPermission: string,
  authoritySubjectActorId: ActorId
): DomainResult<CompiledWorkflowNode, ClaimStepAttemptFailure> => {
  if (context.run.state !== "running") {
    return fail({
      code: "run-not-running",
      message: `A step attempt cannot be claimed while its run is ${context.run.state}.`,
    });
  }
  if (context.plan.authority.subjectActorId !== authoritySubjectActorId) {
    return fail({
      code: "authority-subject-mismatch",
      message: "The step actor is not the immutable authority subject.",
    });
  }
  if (!isSupportedAuthorityEnvelopeVersion(context.plan.authority.version)) {
    return fail({
      code: "authority-version-unsupported",
      message: "The step authority envelope version is not supported.",
    });
  }
  if (now >= context.plan.deadline || now >= context.plan.authority.deadline) {
    return fail({
      code: "deadline-elapsed",
      message:
        "A step attempt cannot be claimed after its execution authority expires.",
    });
  }
  if (!context.plan.authority.permissions.includes(requiredPermission)) {
    return fail({
      code: "authority-permission-missing",
      message: `The run authority is missing permission ${requiredPermission}.`,
    });
  }
  const node = context.plan.compiledWorkflow.nodes.find(
    (candidate) => candidate.key === input.nodeKey
  );
  if (node === undefined) {
    return fail({
      code: "node-not-found",
      message: "The requested step is not part of the immutable run plan.",
    });
  }
  const capabilityAuthorized = context.plan.authority.capabilities.some(
    (authorized) => capabilityMatches(authorized, node.capability)
  );
  if (!capabilityAuthorized) {
    return fail({
      code: "authority-capability-missing",
      message: "The run authority does not cover this step capability.",
    });
  }
  return succeed(node);
};

const routeSnapshotHash = (
  plan: StepExecutionContext["plan"],
  input: ClaimStepAttemptInput,
  candidate: NonNullable<StepExecutionContext["plan"]["routeSnapshots"]>[number]
): ContentHash =>
  canonicalContentHash({
    candidate,
    planHash: plan.planHash,
    runId: input.runId,
    stepRunId: input.stepRunId,
  });

const derivedRoutingDecisionId = (
  input: ClaimStepAttemptInput,
  snapshotHash: ContentHash
): RoutingDecisionId =>
  routingDecisionId(
    `routing_${canonicalContentHash({
      attemptId: input.attemptId,
      routeSnapshotHash: snapshotHash,
      runId: input.runId,
      stepRunId: input.stepRunId,
    }).slice("sha256:".length)}`
  );

const decideRoute = (
  context: StepExecutionContext,
  node: CompiledWorkflowNode,
  input: ClaimStepAttemptInput,
  now: Instant
): DomainResult<RoutingDecision, ClaimStepAttemptFailure> => {
  const candidate = (context.plan.routeSnapshots ?? []).find(
    (entry) => entry.nodeKey === node.key && entry.routeKey === input.routeKey
  );
  if (candidate === undefined) {
    return fail({
      code: "route-not-found",
      message: "The requested route is not admitted by the immutable run plan.",
    });
  }
  if (
    candidate.reservationUnit !== context.plan.budget.unit ||
    candidate.reservationUnit !== context.plan.quote.unit ||
    !isAmount(candidate.reservableUpperBound)
  ) {
    return fail({
      code: "invalid-reservation",
      message: "The selected route has an invalid immutable reservation.",
    });
  }
  const snapshotHash = routeSnapshotHash(context.plan, input, candidate);
  const decision = createRoutingDecision({
    candidate,
    decidedAt: now,
    expectedCapability: node.capability,
    expectedNodeKey: node.key,
    expectedPricingVersion: context.plan.quote.pricingVersion,
    policyFactsHash: context.plan.policyFactsHash,
    policyVersion: context.plan.policyVersion,
    routeSnapshotHash: snapshotHash,
    routingDecisionId: derivedRoutingDecisionId(input, snapshotHash),
    runId: input.runId,
    stepRunId: input.stepRunId,
    workspaceId: input.workspaceId,
  });
  if (!decision.ok) {
    return fail({
      code: "invalid-reservation",
      message: decision.error.message,
    });
  }
  return decision;
};

const prepareReadyStep = async (
  existingStep: StepRun | undefined,
  context: StepExecutionContext,
  node: CompiledWorkflowNode,
  input: ClaimStepAttemptInput,
  now: Instant,
  identifiers: StepEventIdentifierPort,
  technicalActorId: ActorId
): Promise<DomainResult<ReadyStep, ClaimStepAttemptFailure>> => {
  if (existingStep !== undefined) {
    return succeed({ stepRun: existingStep });
  }
  const scheduled = scheduleStep({
    actorId: technicalActorId,
    correlationId: input.correlationId,
    createdAt: now,
    dependsOn: node.dependsOn,
    eventId: await identifiers.nextEventId(),
    nodeKey: node.key,
    runId: input.runId,
    runState: context.run.state,
    satisfiedDependencies: context.succeededNodeKeys,
    stepRunId: input.stepRunId,
    workspaceId: input.workspaceId,
  });
  return scheduled.ok
    ? succeed({
        event: scheduled.value.event,
        stepRun: scheduled.value.stepRun,
      })
    : fail({
        code: "transition-rejected",
        domainCode: scheduled.error.code,
        message: scheduled.error.message,
      });
};

const prepareClaimTransition = async (
  readyStep: StepRun,
  command: ClaimStepCommand,
  identity: StepCommandIdentity,
  input: ClaimStepAttemptInput,
  now: Instant,
  identifiers: StepEventIdentifierPort,
  technicalActorId: ActorId
): Promise<DomainResult<StepTransition, ClaimStepAttemptFailure>> => {
  const transition = applyStepCommand(readyStep, command, {
    actorId: technicalActorId,
    commandIdentity: identity,
    correlationId: input.correlationId,
    eventIds: [
      await identifiers.nextEventId(),
      await identifiers.nextEventId(),
      await identifiers.nextEventId(),
    ],
    expectedAggregateVersion: readyStep.aggregateVersion,
    occurredAt: now,
  });
  return transition.ok
    ? transition
    : fail({
        code: "transition-rejected",
        domainCode: transition.error.code,
        message: transition.error.message,
      });
};

const toReservation = (
  input: ClaimStepAttemptInput,
  decision: RoutingDecision,
  createdAt: Instant
): CostReservation => ({
  amount: decision.reservedAmount,
  attemptId: input.attemptId,
  createdAt,
  operationKey: input.operationKey,
  reservationId: input.costReservationId,
  runId: input.runId,
  state: "reserved",
  stepRunId: input.stepRunId,
  unit: decision.reservationUnit,
  workspaceId: input.workspaceId,
});

const persistClaim = async (
  unitOfWork: StepExecutionUnitOfWork,
  scope: WorkspaceScope,
  existingStep: StepRun | undefined,
  readyEvent: StepLifecycleEvent | undefined,
  transition: StepTransition,
  attempt: Attempt,
  decision: RoutingDecision,
  reservation: CostReservation,
  leafOutboxMessage: LeafOutboxMessage,
  identity: StepCommandIdentity,
  input: ClaimStepAttemptInput,
  technicalActorId: ActorId
): Promise<ClaimStepAttemptResult> => {
  const reserved = await unitOfWork.reservations.reserve(scope, reservation);
  if (reserved.status === "budget-exceeded") {
    return fail({
      code: "budget-exceeded",
      message: "The step reservation exceeds the remaining run budget.",
    });
  }
  if (reserved.status === "conflict") {
    return fail({
      code: "cost-reservation-conflict",
      message:
        "The operation key is already bound to another cost reservation.",
    });
  }
  await unitOfWork.routingDecisions.insert(scope, decision);
  if (existingStep === undefined) {
    await unitOfWork.steps.insert(scope, transition.stepRun);
    if (readyEvent !== undefined) {
      await unitOfWork.stepEvents.append(scope, readyEvent);
    }
  } else {
    await unitOfWork.steps.update(
      scope,
      existingStep.aggregateVersion,
      transition.stepRun
    );
  }
  await unitOfWork.attempts.insert(scope, attempt);
  for (const event of transition.events) {
    await unitOfWork.stepEvents.append(scope, event);
  }
  await unitOfWork.leafOutbox.append(scope, leafOutboxMessage);
  await unitOfWork.commandJournal.insert(
    scope,
    {
      actorId: technicalActorId,
      commandType: "ClaimStepAttempt",
      identity,
      stepRunId: input.stepRunId,
      workspaceId: input.workspaceId,
    },
    technicalActorId,
    input.correlationId
  );
  return succeed({
    replayed: false,
    reservationStatus: reserved.status,
    stepRun: transition.stepRun,
  });
};

export type ClaimStepAttemptExecutionDependencies = Omit<
  ClaimStepAttemptDependencies,
  "persistence"
>;

export type ClaimStepAttemptExecutionActors = Readonly<{
  authoritySubjectActorId: ActorId;
  technicalActorId: ActorId;
}>;

export const claimStepAttemptInUnitOfWork = async (
  unitOfWork: StepExecutionUnitOfWork,
  scope: WorkspaceScope,
  input: ClaimStepAttemptInput,
  dependencies: ClaimStepAttemptExecutionDependencies,
  actors: ClaimStepAttemptExecutionActors
): Promise<ClaimStepAttemptResult> => {
  const identity = {
    commandHash: claimStepAttemptCommandHash(input),
    idempotencyKey: input.commandIdempotencyKey,
  } as const;
  const context = await unitOfWork.steps.getContextForUpdate(
    scope,
    input.runId,
    input.nodeKey
  );
  if (context === undefined) {
    return fail({
      code: "run-not-found",
      message: "The run to execute does not exist in this workspace.",
    });
  }
  const existingStep = context.stepRun;
  if (
    existingStep !== undefined &&
    existingStep.stepRunId !== input.stepRunId
  ) {
    return fail({
      code: "step-id-conflict",
      message: "The workflow node is already bound to another step identifier.",
    });
  }
  const replayProof = await unitOfWork.commandJournal.find(
    scope,
    input.stepRunId,
    input.commandIdempotencyKey
  );
  if (replayProof !== undefined) {
    const replayCommand = replayCommandFrom(
      existingStep,
      input,
      context.plan.authority.authorityEnvelopeId
    );
    return replayCommand === undefined
      ? transitionRejected(
          "replay-proof-mismatch",
          "A durable claim proof exists without its target attempt."
        )
      : replayClaim(
          existingStep,
          replayProof,
          replayCommand,
          identity,
          input,
          actors.technicalActorId
        );
  }
  const versionMatches =
    input.expectedAggregateVersion === "absent"
      ? existingStep === undefined
      : existingStep?.aggregateVersion === input.expectedAggregateVersion;
  if (!versionMatches) {
    return fail({
      code: "step-version-conflict",
      message:
        "The step no longer has the aggregate version expected by this claim.",
    });
  }
  const now = await dependencies.clock.now();
  const admittedNode = findAdmittedNode(
    context,
    input,
    now,
    dependencies.requiredPermission,
    actors.authoritySubjectActorId
  );
  if (!admittedNode.ok) {
    return admittedNode;
  }
  const routing = decideRoute(context, admittedNode.value, input, now);
  if (!routing.ok) {
    return routing;
  }
  const command = toCommand(
    input,
    context.plan.authority.authorityEnvelopeId,
    routing.value
  );
  const ready = await prepareReadyStep(
    existingStep,
    context,
    admittedNode.value,
    input,
    now,
    dependencies.identifiers,
    actors.technicalActorId
  );
  if (!ready.ok) {
    return ready;
  }
  const transition = await prepareClaimTransition(
    ready.value.stepRun,
    command,
    identity,
    input,
    now,
    dependencies.identifiers,
    actors.technicalActorId
  );
  if (!transition.ok) {
    return transition;
  }
  const attempt = transition.value.stepRun.attempts.at(-1);
  if (attempt === undefined) {
    return transitionRejected(
      "attempt-missing",
      "The accepted claim did not produce a durable attempt."
    );
  }
  const claimedEvent = transition.value.events.find(
    (event) => event.eventType === "AttemptClaimed"
  );
  if (claimedEvent === undefined) {
    return transitionRejected(
      "attempt-claimed-event-missing",
      "The accepted claim did not produce its durable claimed event."
    );
  }
  const leafOutboxMessage: LeafOutboxMessage = {
    aggregateVersion: transition.value.stepRun.aggregateVersion,
    attemptId: attempt.attemptId,
    availableAt: now,
    destination: "orchestration.step.attempt.claimed",
    effectAdapterKey: attempt.effectAdapterKey,
    event: claimedEvent,
    eventId: claimedEvent.eventId,
    messageId: await dependencies.identifiers.nextOutboxMessageId(),
    operationKey: attempt.operationKey,
    runId: transition.value.stepRun.runId,
    stepRunId: transition.value.stepRun.stepRunId,
    workspaceId: transition.value.stepRun.workspaceId,
  };
  return persistClaim(
    unitOfWork,
    scope,
    existingStep,
    ready.value.event,
    transition.value,
    attempt,
    routing.value,
    toReservation(input, routing.value, now),
    leafOutboxMessage,
    identity,
    input,
    actors.technicalActorId
  );
};

export const makeClaimStepAttempt =
  (dependencies: ClaimStepAttemptDependencies) =>
  (input: ClaimStepAttemptInput): Promise<ClaimStepAttemptResult> => {
    if (input.routeKey.trim().length === 0) {
      return Promise.resolve(
        fail({
          code: "route-not-found",
          message: "A step attempt requires an immutable route key.",
        })
      );
    }
    if (
      input.expectedAggregateVersion !== "absent" &&
      !(
        Number.isSafeInteger(input.expectedAggregateVersion) &&
        input.expectedAggregateVersion > 0
      )
    ) {
      return Promise.resolve(
        fail({
          code: "step-version-conflict",
          message:
            "A retry claim requires a positive expected aggregate version.",
        })
      );
    }
    const scope = { workspaceId: input.workspaceId } as const;
    return dependencies.persistence.transaction(scope, (unitOfWork) =>
      claimStepAttemptInUnitOfWork(unitOfWork, scope, input, dependencies, {
        authoritySubjectActorId: input.actorId,
        technicalActorId: input.actorId,
      })
    );
  };
