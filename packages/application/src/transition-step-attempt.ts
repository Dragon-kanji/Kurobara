import {
  type ActorId,
  type Artifact,
  type Attempt,
  type AttemptId,
  type AttemptSettlementProof,
  amountsEqual,
  applyStepCommand,
  type CapabilityRef,
  type ContentHash,
  type CorrelationId,
  type DomainResult,
  fail,
  type IdempotencyKey,
  type Instant,
  isAmount,
  isSupportedAuthorityEnvelopeVersion,
  type StepCommand,
  type StepCommandIdentity,
  type StepLifecycleEvent,
  type StepRun,
  type StepRunId,
  succeed,
  type UsageEntry,
  type UsageEntryId,
  type ValidatedOutputRef,
  type WorkspaceId,
} from "@kurobara/kernel";
import type {
  ClockPort,
  CostReservationReleaseResult,
  CostReservationSettlementResult,
  NormalizedJsonValue,
  StepExecutionContext,
  StepExecutionPersistencePort,
  StepExecutionUnitOfWork,
  WorkspaceScope,
} from "@kurobara/ports";

import {
  canonicalContentByteSize,
  canonicalContentHash,
} from "./canonical-content-hash.ts";
import type { StepEventIdentifierPort } from "./claim-step-attempt.ts";

type TransitionInputBase = Readonly<{
  actorId: ActorId;
  attemptId: AttemptId;
  commandIdempotencyKey: IdempotencyKey;
  correlationId: CorrelationId;
  expectedAggregateVersion: number;
  stepRunId: StepRunId;
  workspaceId: WorkspaceId;
}>;

export type StepCostSettlement =
  | Readonly<{
      amount: number;
      kind: "settle";
      unit: string;
      usageEntryId: UsageEntryId;
    }>
  | Readonly<{ kind: "release" }>;

export type StepOutputMaterialization = Readonly<{
  artifact: Artifact;
  ref: ValidatedOutputRef;
  value: NormalizedJsonValue;
}>;

export type TransitionStepAttemptInput =
  | (TransitionInputBase & Readonly<{ type: "StartAttemptEffect" }>)
  | (TransitionInputBase &
      Readonly<{
        output?: StepOutputMaterialization;
        settlement: Extract<StepCostSettlement, { kind: "settle" }>;
        type: "RecordAttemptSucceeded";
      }>)
  | (TransitionInputBase &
      Readonly<{
        retryable: boolean;
        settlement: StepCostSettlement;
        type: "RecordAttemptFailure";
      }>)
  | (TransitionInputBase &
      Readonly<{
        retryable: boolean;
        settlement: Extract<StepCostSettlement, { kind: "release" }>;
        type: "RecordAttemptNotStarted";
      }>)
  | (TransitionInputBase & Readonly<{ type: "AuthorizeRetry" }>)
  | (TransitionInputBase & Readonly<{ type: "MarkAttemptAmbiguous" }>)
  | (TransitionInputBase &
      Readonly<{
        outcome: "succeeded" | "failed_retryable" | "failed_terminal";
        proofId: string;
        output?: StepOutputMaterialization;
        settlement: StepCostSettlement;
        type: "ResolveAttemptAmbiguity";
      }>)
  | (TransitionInputBase & Readonly<{ type: "CancelAttemptBeforeEffect" }>);

export type TransitionStepAttemptFailureCode =
  | "authority-capability-missing"
  | "authority-permission-missing"
  | "authority-subject-mismatch"
  | "authority-version-unsupported"
  | "cost-settlement-conflict"
  | "deadline-elapsed"
  | "invalid-output"
  | "invalid-settlement"
  | "run-not-cancelling"
  | "run-not-running"
  | "step-not-found"
  | "transition-rejected"
  | "usage-exceeds-reservation";

export type TransitionStepAttemptFailure = Readonly<{
  code: TransitionStepAttemptFailureCode;
  domainCode?: string;
  message: string;
}>;

export type TransitionStepAttemptSuccess = Readonly<{
  effectPermission: "granted" | "not-applicable" | "replay-only";
  replayed: boolean;
  settlementStatus?: "existing" | "released" | "settled";
  stepRun: StepRun;
}>;

export type TransitionStepAttemptResult = DomainResult<
  TransitionStepAttemptSuccess,
  TransitionStepAttemptFailure
>;

export type TransitionStepAttemptDependencies = Readonly<{
  clock: ClockPort;
  identifiers: StepEventIdentifierPort;
  persistence: StepExecutionPersistencePort;
  requiredPermission: string;
}>;

class StepSettlementReceiptMismatchError extends Error {
  readonly code = "step-settlement-receipt-mismatch";

  constructor() {
    super("The cost ledger returned an inconsistent settlement receipt.");
    this.name = "StepSettlementReceiptMismatchError";
  }
}

const transitionRejected = (
  domainCode: string,
  message: string
): TransitionStepAttemptResult =>
  fail({ code: "transition-rejected", domainCode, message });

const settlementOf = (
  input: TransitionStepAttemptInput
): StepCostSettlement | undefined => {
  switch (input.type) {
    case "RecordAttemptSucceeded":
    case "RecordAttemptFailure":
    case "RecordAttemptNotStarted":
    case "ResolveAttemptAmbiguity":
      return input.settlement;
    case "CancelAttemptBeforeEffect":
      return { kind: "release" };
    default:
      return;
  }
};

const outputOf = (
  input: TransitionStepAttemptInput
): StepOutputMaterialization | undefined =>
  input.type === "RecordAttemptSucceeded" ||
  input.type === "ResolveAttemptAmbiguity"
    ? input.output
    : undefined;

const sameContract = (
  left: import("@kurobara/kernel").ContractRef,
  right: import("@kurobara/kernel").ContractRef
): boolean =>
  left.catalogVersion === right.catalogVersion &&
  left.catalogFingerprint === right.catalogFingerprint &&
  left.schemaId === right.schemaId &&
  left.schemaVersion === right.schemaVersion &&
  left.schemaFingerprint === right.schemaFingerprint;

const validateSettlement = (
  input: TransitionStepAttemptInput
): TransitionStepAttemptFailure | undefined => {
  const settlement = settlementOf(input);
  if (
    settlement?.kind === "settle" &&
    (settlement.unit.trim().length === 0 || !isAmount(settlement.amount))
  ) {
    return {
      code: "invalid-settlement",
      message: "A usage settlement requires a non-negative amount and unit.",
    };
  }
  if (
    input.type === "ResolveAttemptAmbiguity" &&
    input.outcome === "succeeded" &&
    input.settlement.kind !== "settle"
  ) {
    return {
      code: "invalid-settlement",
      message:
        "A reconciled successful effect requires an explicit usage entry.",
    };
  }
  const output = outputOf(input);
  if (
    output !== undefined &&
    (output.ref.artifact.artifactId !== output.artifact.artifactId ||
      output.ref.artifact.contentHash !== output.artifact.contentHash ||
      !sameContract(output.ref.contract, output.artifact.contract) ||
      output.ref.validatedAt !== output.artifact.validatedAt ||
      output.ref.validatorVersion !== output.artifact.validatorVersion ||
      output.ref.validatorVersion.trim().length === 0 ||
      output.artifact.contentHash !== canonicalContentHash(output.value) ||
      output.artifact.sizeBytes !== canonicalContentByteSize(output.value) ||
      output.artifact.finalizedAt < output.artifact.validatedAt)
  ) {
    return {
      code: "invalid-output",
      message:
        "A step output requires one exact finalized artifact and validation proof.",
    };
  }
  if (
    input.type === "ResolveAttemptAmbiguity" &&
    input.outcome !== "succeeded" &&
    input.output !== undefined
  ) {
    return {
      code: "invalid-output",
      message: "A non-success ambiguity outcome cannot accept an output.",
    };
  }
};

const validateFreshTransitionContext = (
  context: StepExecutionContext,
  attempt: Attempt,
  input: TransitionStepAttemptInput
): TransitionStepAttemptFailure | undefined => {
  if (
    input.type === "CancelAttemptBeforeEffect" &&
    context.run.state !== "cancelling"
  ) {
    return {
      code: "run-not-cancelling",
      message: "A claimed attempt can cancel only while its run is stopping.",
    };
  }
  const output = outputOf(input);
  if (output !== undefined) {
    const dependedOn = new Set(
      context.plan.compiledWorkflow.nodes.flatMap((node) => node.dependsOn)
    );
    const sinks = context.plan.compiledWorkflow.nodes.filter(
      (node) => !dependedOn.has(node.key)
    );
    if (
      sinks.length !== 1 ||
      sinks[0]?.key !== context.stepRun?.nodeKey ||
      !sameContract(output.artifact.contract, context.plan.outputContract) ||
      output.artifact.workspaceId !== input.workspaceId ||
      output.artifact.runId !== context.run.runId ||
      output.artifact.stepRunId !== input.stepRunId ||
      output.artifact.attemptId !== attempt.attemptId ||
      output.artifact.operationKey !== attempt.operationKey
    ) {
      return {
        code: "invalid-output",
        message:
          "Only the unique DAG sink may materialize an output bound to its exact run contract and attempt.",
      };
    }
  }
  const settlement = settlementOf(input);
  if (
    settlement?.kind === "settle" &&
    settlement.amount > attempt.reservedAmount &&
    !amountsEqual(settlement.amount, attempt.reservedAmount)
  ) {
    return {
      code: "usage-exceeds-reservation",
      message: "Observed usage exceeds the amount reserved for this effect.",
    };
  }
};

const settlementForCommand = (
  input: TransitionStepAttemptInput,
  attempt: Attempt | undefined,
  durableSettlement: AttemptSettlementProof | undefined
): AttemptSettlementProof | undefined =>
  durableSettlement ??
  (attempt === undefined ? undefined : settlementProof(input, attempt));

const hashableCommand = (
  input: TransitionStepAttemptInput
): Readonly<Record<string, unknown>> => {
  const base = {
    attemptId: input.attemptId,
    stepRunId: input.stepRunId,
    type: input.type,
    workspaceId: input.workspaceId,
  };
  switch (input.type) {
    case "RecordAttemptSucceeded":
      return {
        ...base,
        ...(input.output === undefined
          ? {}
          : { output: input.output.artifact }),
        settlement: input.settlement,
      };
    case "RecordAttemptFailure":
    case "RecordAttemptNotStarted":
      return {
        ...base,
        retryable: input.retryable,
        settlement: input.settlement,
      };
    case "ResolveAttemptAmbiguity":
      return {
        ...base,
        outcome: input.outcome,
        ...(input.output === undefined
          ? {}
          : { output: input.output.artifact }),
        proofId: input.proofId,
        settlement: input.settlement,
      };
    default:
      return base;
  }
};

const commandHash = (input: TransitionStepAttemptInput): ContentHash =>
  canonicalContentHash(hashableCommand(input));

const effectPermission = (
  type: StepCommand["type"],
  replayed: boolean
): TransitionStepAttemptSuccess["effectPermission"] => {
  if (type !== "StartAttemptEffect") {
    return "not-applicable";
  }
  return replayed ? "replay-only" : "granted";
};

const isTerminalStepRun = (stepRun: StepRun): boolean =>
  stepRun.state === "succeeded" ||
  stepRun.state === "failed" ||
  stepRun.state === "cancelled" ||
  stepRun.state === "skipped";

const requestDagSchedulingForTerminalStep = async (
  unitOfWork: StepExecutionUnitOfWork,
  scope: WorkspaceScope,
  result: TransitionStepAttemptResult
): Promise<void> => {
  if (result.ok && isTerminalStepRun(result.value.stepRun)) {
    await unitOfWork.dagSchedule.request(scope, result.value.stepRun.runId);
  }
};

const requestRoutingForReadyStep = async (
  unitOfWork: StepExecutionUnitOfWork,
  scope: WorkspaceScope,
  result: TransitionStepAttemptResult
): Promise<void> => {
  if (result.ok && result.value.stepRun.state === "ready") {
    await unitOfWork.stepRouting.request(scope, result.value.stepRun.stepRunId);
  }
};

const replayCommand = (
  stepRun: StepRun,
  input: TransitionStepAttemptInput,
  command: StepCommand,
  identity: StepCommandIdentity,
  proof: import("@kurobara/kernel").StepCommandReplayProof
): TransitionStepAttemptResult => {
  const replay = applyStepCommand(stepRun, command, {
    actorId: input.actorId,
    commandIdentity: identity,
    correlationId: input.correlationId,
    eventIds: [],
    expectedAggregateVersion: input.expectedAggregateVersion,
    occurredAt: stepRun.createdAt,
    replayProof: proof,
  });
  if (!replay.ok) {
    return transitionRejected(replay.error.code, replay.error.message);
  }
  return succeed({
    effectPermission: effectPermission(input.type, true),
    replayed: true,
    stepRun: replay.value.stepRun,
  });
};

const capabilityMatches = (
  left: CapabilityRef,
  right: CapabilityRef
): boolean =>
  left.capabilityId === right.capabilityId &&
  left.capabilityVersion === right.capabilityVersion;

const validateAuthorityIdentity = (
  context: StepExecutionContext,
  actorId: ActorId
): TransitionStepAttemptFailure | undefined => {
  if (context.plan.authority.subjectActorId !== actorId) {
    return {
      code: "authority-subject-mismatch",
      message: "The step actor is not the immutable authority subject.",
    };
  }
  if (!isSupportedAuthorityEnvelopeVersion(context.plan.authority.version)) {
    return {
      code: "authority-version-unsupported",
      message: "The step authority envelope version is not supported.",
    };
  }
};

const validateExecutionWindow = (
  context: StepExecutionContext,
  now: Instant,
  requiredPermission: string
): TransitionStepAttemptFailure | undefined => {
  if (context.run.state !== "running") {
    return {
      code: "run-not-running",
      message: `A new effect cannot start while its run is ${context.run.state}.`,
    };
  }
  if (now >= context.plan.deadline || now >= context.plan.authority.deadline) {
    return {
      code: "deadline-elapsed",
      message:
        "A new effect cannot start after its execution authority expires.",
    };
  }
  if (!context.plan.authority.permissions.includes(requiredPermission)) {
    return {
      code: "authority-permission-missing",
      message: `The run authority is missing permission ${requiredPermission}.`,
    };
  }
  const node = context.plan.compiledWorkflow.nodes.find(
    (candidate) => candidate.key === context.stepRun?.nodeKey
  );
  if (
    node === undefined ||
    context.plan.authority.capabilities.every(
      (authorized) => !capabilityMatches(authorized, node.capability)
    )
  ) {
    return {
      code: "authority-capability-missing",
      message: "The immutable authority does not admit this step capability.",
    };
  }
};

const targetAttempt = (
  stepRun: StepRun,
  requestedAttemptId: AttemptId
): Attempt | undefined =>
  stepRun.attempts.find((attempt) => attempt.attemptId === requestedAttemptId);

const settlementProof = (
  input: TransitionStepAttemptInput,
  attempt: Attempt
): AttemptSettlementProof | undefined => {
  const settlement = settlementOf(input);
  if (settlement === undefined) {
    return;
  }
  if (settlement.kind === "release") {
    return {
      attemptId: attempt.attemptId,
      disposition: "released",
      operationKey: attempt.operationKey,
      releasedAmount: attempt.reservedAmount,
      reservationId: attempt.costReservationId,
      unit: attempt.reservationUnit,
    };
  }
  return {
    attemptId: attempt.attemptId,
    disposition: "settled",
    operationKey: attempt.operationKey,
    releasedAmount: attempt.reservedAmount - settlement.amount,
    reservationId: attempt.costReservationId,
    settledAmount: settlement.amount,
    unit: settlement.unit,
    usageEntryId: settlement.usageEntryId,
  };
};

const toCommand = (
  input: TransitionStepAttemptInput,
  attempt: Attempt | undefined,
  retryAuthorized: boolean,
  durableSettlement?: AttemptSettlementProof
): StepCommand | undefined => {
  switch (input.type) {
    case "StartAttemptEffect":
    case "MarkAttemptAmbiguous":
      return { attemptId: input.attemptId, type: input.type };
    case "AuthorizeRetry":
      return {
        attemptId: input.attemptId,
        retryAuthorized,
        type: input.type,
      };
    case "RecordAttemptSucceeded": {
      const settlement = settlementForCommand(
        input,
        attempt,
        durableSettlement
      );
      return settlement === undefined
        ? undefined
        : {
            attemptId: input.attemptId,
            ...(input.output === undefined ? {} : { output: input.output.ref }),
            settlement,
            type: input.type,
          };
    }
    case "RecordAttemptFailure": {
      const settlement = settlementForCommand(
        input,
        attempt,
        durableSettlement
      );
      return settlement === undefined
        ? undefined
        : {
            attemptId: input.attemptId,
            retryAuthorized: input.retryable && retryAuthorized,
            retryable: input.retryable,
            settlement,
            type: input.type,
          };
    }
    case "RecordAttemptNotStarted": {
      const settlement = settlementForCommand(
        input,
        attempt,
        durableSettlement
      );
      return settlement?.disposition === "released"
        ? {
            attemptId: input.attemptId,
            retryAuthorized: input.retryable && retryAuthorized,
            retryable: input.retryable,
            settlement,
            type: input.type,
          }
        : undefined;
    }
    case "ResolveAttemptAmbiguity": {
      const settlement = settlementForCommand(
        input,
        attempt,
        durableSettlement
      );
      return settlement === undefined
        ? undefined
        : {
            attemptId: input.attemptId,
            outcome: input.outcome,
            ...(input.output === undefined ? {} : { output: input.output.ref }),
            proofId: input.proofId,
            retryAuthorized:
              input.outcome === "failed_retryable" && retryAuthorized,
            settlement,
            type: input.type,
          };
    }
    case "CancelAttemptBeforeEffect": {
      const settlement = settlementForCommand(
        input,
        attempt,
        durableSettlement
      );
      return settlement?.disposition === "released"
        ? {
            attemptId: input.attemptId,
            settlement,
            type: input.type,
          }
        : undefined;
    }
    default:
      return;
  }
};

const usageFor = (
  input: TransitionStepAttemptInput,
  attempt: Attempt,
  stepRun: StepRun,
  now: Instant,
  settlement: Extract<StepCostSettlement, { kind: "settle" }>
): UsageEntry => ({
  amount: settlement.amount,
  attemptId: attempt.attemptId,
  operationKey: attempt.operationKey,
  recordedAt: now,
  reservationId: attempt.costReservationId,
  runId: stepRun.runId,
  unit: settlement.unit,
  usageEntryId: settlement.usageEntryId,
  workspaceId: input.workspaceId,
  ...(input.type === "ResolveAttemptAmbiguity"
    ? { reconciliationProofId: input.proofId }
    : {}),
});

type AppliedSettlement = Readonly<{
  proof?: AttemptSettlementProof;
  status?: "existing" | "released" | "settled";
}>;

const reservationIdentityMatches = (
  reservation: import("@kurobara/kernel").CostReservation,
  attempt: Attempt,
  stepRun: StepRun,
  workspaceId: WorkspaceId
): boolean =>
  reservation.workspaceId === workspaceId &&
  reservation.runId === stepRun.runId &&
  reservation.stepRunId === stepRun.stepRunId &&
  reservation.attemptId === attempt.attemptId &&
  reservation.reservationId === attempt.costReservationId &&
  reservation.operationKey === attempt.operationKey &&
  reservation.unit === attempt.reservationUnit &&
  reservation.amount === attempt.reservedAmount;

const usageMatchesRequest = (
  actual: UsageEntry,
  requested: UsageEntry
): boolean =>
  actual.workspaceId === requested.workspaceId &&
  actual.runId === requested.runId &&
  actual.attemptId === requested.attemptId &&
  actual.reservationId === requested.reservationId &&
  actual.operationKey === requested.operationKey &&
  actual.usageEntryId === requested.usageEntryId &&
  actual.unit === requested.unit &&
  actual.amount === requested.amount &&
  actual.reconciliationProofId === requested.reconciliationProofId;

const releaseProofFrom = (
  reservation: import("@kurobara/kernel").CostReservation,
  attempt: Attempt,
  stepRun: StepRun,
  workspaceId: WorkspaceId
): AttemptSettlementProof => {
  if (
    reservation.state !== "released" ||
    !reservationIdentityMatches(reservation, attempt, stepRun, workspaceId)
  ) {
    throw new StepSettlementReceiptMismatchError();
  }
  return {
    attemptId: reservation.attemptId,
    disposition: "released",
    operationKey: reservation.operationKey,
    releasedAmount: reservation.amount,
    reservationId: reservation.reservationId,
    unit: reservation.unit,
  };
};

const settlementProofFrom = (
  result: Exclude<
    CostReservationSettlementResult,
    { status: "conflict" | "amount-exceeded" }
  >,
  requestedUsage: UsageEntry,
  attempt: Attempt,
  stepRun: StepRun,
  workspaceId: WorkspaceId
): AttemptSettlementProof => {
  const { reservation, usage } = result;
  if (
    reservation.state !== "settled" ||
    !reservationIdentityMatches(reservation, attempt, stepRun, workspaceId) ||
    !usageMatchesRequest(usage, requestedUsage) ||
    reservation.usageEntryId !== usage.usageEntryId ||
    reservation.settledAmount !== usage.amount ||
    !isAmount(reservation.releasedAmount) ||
    !amountsEqual(
      reservation.settledAmount + reservation.releasedAmount,
      reservation.amount
    )
  ) {
    throw new StepSettlementReceiptMismatchError();
  }
  return {
    attemptId: reservation.attemptId,
    disposition: "settled",
    operationKey: reservation.operationKey,
    releasedAmount: reservation.releasedAmount,
    reservationId: reservation.reservationId,
    settledAmount: reservation.settledAmount,
    unit: reservation.unit,
    usageEntryId: reservation.usageEntryId,
  };
};

const settleReservation = async (
  unitOfWork: StepExecutionUnitOfWork,
  scope: WorkspaceScope,
  input: TransitionStepAttemptInput,
  stepRun: StepRun,
  attempt: Attempt,
  now: Instant
): Promise<DomainResult<AppliedSettlement, TransitionStepAttemptFailure>> => {
  const settlement = settlementOf(input);
  if (settlement === undefined) {
    return succeed({});
  }
  if (settlement.kind === "release") {
    const result: CostReservationReleaseResult =
      await unitOfWork.reservations.release(scope, {
        amount: attempt.reservedAmount,
        attemptId: attempt.attemptId,
        operationKey: attempt.operationKey,
        releasedAt: now,
        reservationId: attempt.costReservationId,
        runId: stepRun.runId,
        unit: attempt.reservationUnit,
        workspaceId: input.workspaceId,
      });
    if (result.status === "conflict") {
      return fail({
        code: "cost-settlement-conflict",
        message: "The reservation cannot be released from its durable state.",
      });
    }
    return succeed({
      proof: releaseProofFrom(
        result.reservation,
        attempt,
        stepRun,
        input.workspaceId
      ),
      status: result.status,
    });
  }
  const requestedUsage = usageFor(input, attempt, stepRun, now, settlement);
  const result: CostReservationSettlementResult =
    await unitOfWork.reservations.settle(scope, requestedUsage);
  if (result.status === "amount-exceeded") {
    return fail({
      code: "usage-exceeds-reservation",
      message: "Observed usage exceeds the amount reserved for this effect.",
    });
  }
  if (result.status === "conflict") {
    return fail({
      code: "cost-settlement-conflict",
      message: "The reservation is already bound to another settlement.",
    });
  }
  if (!("reservation" in result)) {
    throw new StepSettlementReceiptMismatchError();
  }
  return succeed({
    proof: settlementProofFrom(
      result,
      requestedUsage,
      attempt,
      stepRun,
      input.workspaceId
    ),
    status: result.status,
  });
};

const persistTransition = async (
  unitOfWork: StepExecutionUnitOfWork,
  scope: WorkspaceScope,
  previous: StepRun,
  next: StepRun,
  input: TransitionStepAttemptInput,
  identity: StepCommandIdentity,
  events: readonly StepLifecycleEvent[]
): Promise<void> => {
  if (
    (input.type === "RecordAttemptSucceeded" ||
      input.type === "ResolveAttemptAmbiguity") &&
    input.output !== undefined
  ) {
    await unitOfWork.artifacts.insert(
      scope,
      input.output.artifact,
      input.output.value
    );
  }
  const previousAttempt = targetAttempt(previous, input.attemptId);
  const nextAttempt = targetAttempt(next, input.attemptId);
  if (
    previousAttempt !== undefined &&
    nextAttempt !== undefined &&
    nextAttempt.state !== previousAttempt.state
  ) {
    await unitOfWork.attempts.update(scope, previousAttempt.state, nextAttempt);
  }
  await unitOfWork.steps.update(scope, previous.aggregateVersion, next);
  for (const event of events) {
    await unitOfWork.stepEvents.append(scope, event);
  }
  await unitOfWork.commandJournal.insert(
    scope,
    {
      actorId: input.actorId,
      commandType: input.type,
      identity,
      stepRunId: input.stepRunId,
      workspaceId: input.workspaceId,
    },
    input.actorId,
    input.correlationId
  );
};

const eventCountForCommand = (command: StepCommand): number => {
  switch (command.type) {
    case "RecordAttemptFailure":
    case "RecordAttemptNotStarted":
      return command.retryable ? 2 : 1;
    case "ResolveAttemptAmbiguity":
      return command.outcome === "failed_retryable" ? 2 : 1;
    default:
      return 1;
  }
};

const allocateEventIds = async (
  identifiers: StepEventIdentifierPort,
  count: number
): Promise<readonly import("@kurobara/kernel").EventId[]> => {
  const ids: import("@kurobara/kernel").EventId[] = [];
  while (ids.length < count) {
    ids.push(await identifiers.nextEventId());
  }
  return ids;
};

const projectParentEffect = async (
  unitOfWork: StepExecutionUnitOfWork,
  scope: WorkspaceScope,
  context: StepExecutionContext,
  stepRun: StepRun,
  attempt: Attempt,
  input: TransitionStepAttemptInput,
  now: Instant
): Promise<TransitionStepAttemptResult | undefined> => {
  const parents = unitOfWork.parentEffects;
  if (
    parents === undefined ||
    (input.type !== "StartAttemptEffect" &&
      input.type !== "MarkAttemptAmbiguous")
  ) {
    return;
  }
  const projectionInput = {
    attempt,
    now,
    plan: context.plan,
    run: context.run,
    stepRun,
  } as const;
  const result =
    input.type === "StartAttemptEffect"
      ? await parents.authorize(scope, projectionInput)
      : await parents.markAmbiguous(scope, projectionInput);
  return result.status === "denied"
    ? transitionRejected(result.code, result.message)
    : undefined;
};

const executeFreshTransition = async (
  unitOfWork: StepExecutionUnitOfWork,
  scope: WorkspaceScope,
  input: TransitionStepAttemptInput,
  identity: StepCommandIdentity,
  dependencies: TransitionStepAttemptDependencies,
  context: StepExecutionContext,
  stepRun: StepRun,
  attempt: Attempt,
  retryCapacityAvailable: boolean
): Promise<TransitionStepAttemptResult> => {
  const authorityFailure = validateAuthorityIdentity(context, input.actorId);
  if (authorityFailure !== undefined) {
    return fail(authorityFailure);
  }
  const contextFailure = validateFreshTransitionContext(
    context,
    attempt,
    input
  );
  if (contextFailure !== undefined) {
    return fail(contextFailure);
  }
  const now = await dependencies.clock.now();
  const windowFailure = validateExecutionWindow(
    context,
    now,
    dependencies.requiredPermission
  );
  const retryDeadlineOpen =
    now < context.plan.deadline && now < context.plan.authority.deadline;
  const retryAuthorized =
    context.run.state === "running" &&
    retryCapacityAvailable &&
    retryDeadlineOpen;
  if (
    (input.type === "StartAttemptEffect" ||
      (input.type === "AuthorizeRetry" && retryAuthorized)) &&
    windowFailure !== undefined
  ) {
    return fail(windowFailure);
  }
  const command = toCommand(input, attempt, retryAuthorized);
  if (command === undefined) {
    return transitionRejected(
      "attempt-id-mismatch",
      "The command does not identify an attempt in this step."
    );
  }
  const eventIds = await allocateEventIds(
    dependencies.identifiers,
    eventCountForCommand(command)
  );
  const transitionContext = {
    actorId: input.actorId,
    commandIdentity: identity,
    correlationId: input.correlationId,
    eventIds,
    expectedAggregateVersion: input.expectedAggregateVersion,
    occurredAt: now,
  } as const;
  const transition = applyStepCommand(stepRun, command, transitionContext);
  if (!transition.ok) {
    return transitionRejected(transition.error.code, transition.error.message);
  }
  const parentFailure = await projectParentEffect(
    unitOfWork,
    scope,
    context,
    stepRun,
    attempt,
    input,
    now
  );
  if (parentFailure !== undefined) {
    return parentFailure;
  }
  const settlement = await settleReservation(
    unitOfWork,
    scope,
    input,
    stepRun,
    attempt,
    now
  );
  if (!settlement.ok) {
    return settlement;
  }
  const durableCommand = toCommand(
    input,
    attempt,
    retryAuthorized,
    settlement.value.proof
  );
  if (durableCommand === undefined) {
    throw new StepSettlementReceiptMismatchError();
  }
  const durableTransition = applyStepCommand(
    stepRun,
    durableCommand,
    transitionContext
  );
  if (!durableTransition.ok) {
    throw new StepSettlementReceiptMismatchError();
  }
  await persistTransition(
    unitOfWork,
    scope,
    stepRun,
    durableTransition.value.stepRun,
    input,
    identity,
    durableTransition.value.events
  );
  const result = succeed({
    effectPermission: effectPermission(input.type, false),
    replayed: false,
    ...(settlement.value.status === undefined
      ? {}
      : { settlementStatus: settlement.value.status }),
    stepRun: durableTransition.value.stepRun,
  });
  await requestDagSchedulingForTerminalStep(unitOfWork, scope, result);
  await requestRoutingForReadyStep(unitOfWork, scope, result);
  return result;
};

const executeTransition = async (
  unitOfWork: StepExecutionUnitOfWork,
  scope: WorkspaceScope,
  input: TransitionStepAttemptInput,
  identity: StepCommandIdentity,
  dependencies: TransitionStepAttemptDependencies
): Promise<TransitionStepAttemptResult> => {
  const context = await unitOfWork.steps.getContextByStepIdForUpdate(
    scope,
    input.stepRunId
  );
  const stepRun = context?.stepRun;
  if (context === undefined || stepRun === undefined) {
    return fail({
      code: "step-not-found",
      message: "The step to transition does not exist in this workspace.",
    });
  }
  const attempt = targetAttempt(stepRun, input.attemptId);
  if (attempt === undefined) {
    return transitionRejected(
      "attempt-id-mismatch",
      "The command does not identify an attempt in this step."
    );
  }
  const maxAttempts = context.plan.retryPolicy.maxAttemptsPerStep;
  const retryCapacityAvailable =
    Number.isSafeInteger(maxAttempts) &&
    maxAttempts >= 1 &&
    maxAttempts <= 100 &&
    stepRun.attempts.length < maxAttempts;
  const replayCandidate = toCommand(input, attempt, retryCapacityAvailable);
  if (replayCandidate === undefined) {
    return transitionRejected(
      "attempt-id-mismatch",
      "The command does not identify an attempt in this step."
    );
  }
  const proof = await unitOfWork.commandJournal.find(
    scope,
    input.stepRunId,
    input.commandIdempotencyKey
  );
  if (proof !== undefined) {
    const replay = replayCommand(
      stepRun,
      input,
      replayCandidate,
      identity,
      proof
    );
    await requestDagSchedulingForTerminalStep(unitOfWork, scope, replay);
    await requestRoutingForReadyStep(unitOfWork, scope, replay);
    return replay;
  }
  return executeFreshTransition(
    unitOfWork,
    scope,
    input,
    identity,
    dependencies,
    context,
    stepRun,
    attempt,
    retryCapacityAvailable
  );
};

export const makeTransitionStepAttempt =
  (dependencies: TransitionStepAttemptDependencies) =>
  (input: TransitionStepAttemptInput): Promise<TransitionStepAttemptResult> => {
    const settlementFailure = validateSettlement(input);
    if (settlementFailure !== undefined) {
      return Promise.resolve(fail(settlementFailure));
    }
    const identity = {
      commandHash: commandHash(input),
      idempotencyKey: input.commandIdempotencyKey,
    } as const;
    const scope = { workspaceId: input.workspaceId } as const;
    return dependencies.persistence.transaction(scope, (unitOfWork) =>
      executeTransition(unitOfWork, scope, input, identity, dependencies)
    );
  };
