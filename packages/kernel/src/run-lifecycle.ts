import { type DomainResult, fail, succeed } from "./result.ts";
import { type ResultManifest, resultManifestRef } from "./result-manifest.ts";
import type {
  ResultCompleteness,
  ResultManifestRef,
  Run,
  RunState,
  StopReason,
} from "./run.ts";
import type {
  ActorId,
  ContentHash,
  CorrelationId,
  EventId,
  IdempotencyKey,
  Instant,
} from "./value-objects.ts";

export type RunCommand =
  | Readonly<{ type: "ClaimRun" }>
  | Readonly<{
      type: "OpenInputRequest";
      hasIndependentProgress: boolean;
    }>
  | Readonly<{
      type: "ConsumeSignal";
      reopensGlobalProgress: boolean;
    }>
  | Readonly<{ type: "RequestStop"; reason: StopReason }>
  | Readonly<{ type: "SettleCancellation" }>
  | Readonly<{
      manifest: ResultManifest;
      type: "CompleteRun";
    }>
  | Readonly<{
      manifest: ResultManifest;
      type: "FailRun";
    }>
  | Readonly<{
      type: "MarkEffectAmbiguous";
      operationKey: string;
    }>
  | Readonly<{
      type: "ResolveAmbiguity";
      outcome: "completed" | "failed" | "cancelled";
      proofId: string;
      resultCompleteness: ResultCompleteness;
      manifest?: ResultManifest;
    }>;

export type RunCommandIdentity = Readonly<{
  idempotencyKey: IdempotencyKey;
  commandHash: ContentHash;
}>;

/** Durable accepted-command evidence loaded by the application command journal. */
export type RunCommandReplayProof = Readonly<{
  runId: Run["runId"];
  workspaceId: Run["workspaceId"];
  identity: RunCommandIdentity;
  commandType: RunCommand["type"];
}>;

export type RunCommandContext = Readonly<{
  commandIdentity: RunCommandIdentity;
  expectedAggregateVersion: number;
  eventIds: readonly EventId[];
  occurredAt: Instant;
  actorId: ActorId;
  correlationId: CorrelationId;
  replayProof?: RunCommandReplayProof;
}>;

type RunEventBase = Readonly<{
  eventId: EventId;
  eventVersion: 1;
  runId: Run["runId"];
  workspaceId: Run["workspaceId"];
  sequence: number;
  occurredAt: Instant;
  actorId: ActorId;
  correlationId: CorrelationId;
}>;

type RunLifecycleEventDetail =
  | Readonly<{ eventType: "RunStarted" }>
  | Readonly<{ eventType: "InputRequested" }>
  | Readonly<{ eventType: "RunWaiting" }>
  | Readonly<{ eventType: "InputRequestConsumed" }>
  | Readonly<{ eventType: "RunResumed" }>
  | Readonly<{ eventType: "RunStopRequested"; reason: StopReason }>
  | Readonly<{ eventType: "RunCancelling"; reason: StopReason }>
  | Readonly<{ eventType: "RunCancelled"; reason: StopReason }>
  | Readonly<{
      conclusion: "completed" | "failed";
      eventType: "RunResultManifestRecorded";
      manifestHash: ContentHash;
      resultCompleteness: ResultCompleteness;
      resultManifestId: import("./value-objects.ts").ResultManifestId;
    }>
  | Readonly<{
      eventType: "RunCompleted";
      resultCompleteness: "partial" | "complete";
    }>
  | Readonly<{
      eventType: "RunFailed";
      resultCompleteness: ResultCompleteness;
    }>
  | Readonly<{
      eventType: "ExternalEffectBecameAmbiguous";
      operationKey: string;
    }>
  | Readonly<{
      eventType: "RunAmbiguous";
      operationKey: string;
    }>
  | Readonly<{
      eventType: "AmbiguityResolved";
      outcome: "completed" | "failed" | "cancelled";
      proofId: string;
    }>;

export type RunLifecycleEvent = RunEventBase & RunLifecycleEventDetail;

export type RunTransition = Readonly<{
  run: Run;
  events: readonly RunLifecycleEvent[];
  replayed: boolean;
}>;

export type RunTransitionFailureCode =
  | "aggregate-version-conflict"
  | "invalid-transition"
  | "event-id-count-mismatch"
  | "completion-precondition-failed"
  | "invalid-result-completeness"
  | "reconciliation-proof-required"
  | "operation-key-required"
  | "replay-proof-mismatch"
  | "idempotency-key-reused";

export type RunTransitionFailure = Readonly<{
  code: RunTransitionFailureCode;
  message: string;
  state: RunState;
  command: RunCommand["type"];
}>;

type TransitionPlan = Readonly<{
  state: RunState;
  resultCompleteness: ResultCompleteness;
  pendingStopReason?: StopReason;
  resultManifest?: ResultManifestRef;
  eventDetails: readonly RunLifecycleEventDetail[];
}>;

const invalidTransition = (
  run: Run,
  command: RunCommand
): DomainResult<never, RunTransitionFailure> =>
  fail({
    code: "invalid-transition",
    command: command.type,
    message: `${command.type} is not allowed from run state ${run.state}.`,
    state: run.state,
  });

const validateCompletion = (
  run: Run,
  command: Extract<RunCommand, { type: "CompleteRun" }>
): DomainResult<TransitionPlan, RunTransitionFailure> => {
  const { manifest } = command;
  if (
    manifest.workspaceId !== run.workspaceId ||
    manifest.runId !== run.runId ||
    manifest.runPlanId !== run.runPlanId ||
    manifest.sourceRunAggregateVersion !== run.aggregateVersion ||
    manifest.conclusion !== "completed" ||
    manifest.coverage !== "complete"
  ) {
    return fail({
      code: "completion-precondition-failed",
      command: command.type,
      message:
        "A run cannot complete without an identity-matching durable result manifest.",
      state: run.state,
    });
  }
  if (manifest.output.status !== "accepted") {
    return fail({
      code: "invalid-result-completeness",
      command: command.type,
      message:
        "Completion requires a complete accepted output proof and succeeded compiled-node coverage.",
      state: run.state,
    });
  }
  const acceptedOutput = manifest.output;
  if (
    manifest.resultCompleteness !== "complete" ||
    acceptedOutput.validatorVersion.trim().length === 0 ||
    acceptedOutput.contract.catalogVersion !==
      manifest.outputContract.catalogVersion ||
    acceptedOutput.contract.catalogFingerprint !==
      manifest.outputContract.catalogFingerprint ||
    acceptedOutput.contract.schemaId !== manifest.outputContract.schemaId ||
    acceptedOutput.contract.schemaVersion !==
      manifest.outputContract.schemaVersion ||
    acceptedOutput.contract.schemaFingerprint !==
      manifest.outputContract.schemaFingerprint ||
    manifest.entries.some((entry) => entry.state !== "succeeded") ||
    !manifest.entries.some(
      (entry) =>
        entry.result.status === "accepted" &&
        entry.result.artifact.artifactId ===
          acceptedOutput.artifact.artifactId &&
        entry.result.artifact.contentHash ===
          acceptedOutput.artifact.contentHash
    )
  ) {
    return fail({
      code: "invalid-result-completeness",
      command: command.type,
      message:
        "Completion requires a complete accepted output proof and succeeded compiled-node coverage.",
      state: run.state,
    });
  }

  return succeed({
    eventDetails: [
      {
        conclusion: "completed",
        eventType: "RunResultManifestRecorded",
        manifestHash: manifest.manifestHash,
        resultCompleteness: manifest.resultCompleteness,
        resultManifestId: manifest.resultManifestId,
      },
      {
        eventType: "RunCompleted",
        resultCompleteness: manifest.resultCompleteness,
      },
    ],
    resultCompleteness: manifest.resultCompleteness,
    resultManifest: resultManifestRef(manifest),
    state: "completed",
  });
};

const validateFailure = (
  run: Run,
  command: Extract<RunCommand, { type: "FailRun" }>
): DomainResult<TransitionPlan, RunTransitionFailure> => {
  const { manifest } = command;
  if (
    manifest.workspaceId !== run.workspaceId ||
    manifest.runId !== run.runId ||
    manifest.runPlanId !== run.runPlanId ||
    manifest.sourceRunAggregateVersion !== run.aggregateVersion ||
    manifest.conclusion !== "failed" ||
    manifest.coverage !== "complete" ||
    manifest.entries.every((entry) => entry.state !== "failed")
  ) {
    return fail({
      code: "completion-precondition-failed",
      command: command.type,
      message:
        "A run cannot fail without a complete identity-matching failure manifest.",
      state: run.state,
    });
  }
  return succeed({
    eventDetails: [
      {
        conclusion: "failed",
        eventType: "RunResultManifestRecorded",
        manifestHash: manifest.manifestHash,
        resultCompleteness: manifest.resultCompleteness,
        resultManifestId: manifest.resultManifestId,
      },
      {
        eventType: "RunFailed",
        resultCompleteness: manifest.resultCompleteness,
      },
    ],
    resultCompleteness: manifest.resultCompleteness,
    resultManifest: resultManifestRef(manifest),
    state: "failed",
  });
};

const resolveAmbiguity = (
  run: Run,
  command: Extract<RunCommand, { type: "ResolveAmbiguity" }>
): DomainResult<TransitionPlan, RunTransitionFailure> => {
  if (command.proofId.trim().length === 0) {
    return fail({
      code: "reconciliation-proof-required",
      command: command.type,
      message:
        "Ambiguity resolution requires a non-empty reconciliation proof identifier.",
      state: run.state,
    });
  }
  let terminalEvent: RunLifecycleEventDetail;
  let manifestEvent: RunLifecycleEventDetail | undefined;
  let manifestRef: ResultManifestRef | undefined;
  if (command.outcome === "completed") {
    if (command.manifest === undefined) {
      return fail({
        code: "completion-precondition-failed",
        command: command.type,
        message: "Reconciled completion requires a durable result manifest.",
        state: run.state,
      });
    }
    const validated = validateCompletion(run, {
      manifest: command.manifest,
      type: "CompleteRun",
    });
    if (!validated.ok) {
      return fail({ ...validated.error, command: command.type });
    }
    if (command.resultCompleteness !== command.manifest.resultCompleteness) {
      return fail({
        code: "invalid-result-completeness",
        command: command.type,
        message: "The reconciliation result and manifest completeness differ.",
        state: run.state,
      });
    }
    [manifestEvent, terminalEvent] = validated.value.eventDetails;
    manifestRef = validated.value.resultManifest;
  } else if (command.outcome === "failed") {
    if (command.manifest === undefined) {
      return fail({
        code: "completion-precondition-failed",
        command: command.type,
        message: "Reconciled failure requires a durable result manifest.",
        state: run.state,
      });
    }
    const validated = validateFailure(run, {
      manifest: command.manifest,
      type: "FailRun",
    });
    if (!validated.ok) {
      return fail({ ...validated.error, command: command.type });
    }
    if (command.resultCompleteness !== command.manifest.resultCompleteness) {
      return fail({
        code: "invalid-result-completeness",
        command: command.type,
        message: "The reconciliation result and manifest completeness differ.",
        state: run.state,
      });
    }
    [manifestEvent, terminalEvent] = validated.value.eventDetails;
    manifestRef = validated.value.resultManifest;
  } else {
    terminalEvent = {
      eventType: "RunCancelled",
      reason: run.pendingStopReason ?? "requested",
    };
  }

  return succeed({
    eventDetails: [
      ...(manifestEvent === undefined ? [] : [manifestEvent]),
      {
        eventType: "AmbiguityResolved",
        outcome: command.outcome,
        proofId: command.proofId,
      },
      terminalEvent,
    ],
    resultCompleteness: command.resultCompleteness,
    ...(manifestRef === undefined ? {} : { resultManifest: manifestRef }),
    state: command.outcome,
  });
};

const requestStop = (
  run: Run,
  command: Extract<RunCommand, { type: "RequestStop" }>
): DomainResult<TransitionPlan, RunTransitionFailure> => {
  if (run.state === "queued") {
    return succeed({
      eventDetails: [
        { eventType: "RunStopRequested", reason: command.reason },
        { eventType: "RunCancelled", reason: command.reason },
      ],
      resultCompleteness: run.resultCompleteness,
      state: "cancelled",
    });
  }
  if (run.state === "running" || run.state === "waiting") {
    return succeed({
      eventDetails: [
        { eventType: "RunStopRequested", reason: command.reason },
        { eventType: "RunCancelling", reason: command.reason },
      ],
      pendingStopReason: command.reason,
      resultCompleteness: run.resultCompleteness,
      state: "cancelling",
    });
  }
  if (run.state === "ambiguous") {
    return succeed({
      eventDetails: [{ eventType: "RunStopRequested", reason: command.reason }],
      pendingStopReason: command.reason,
      resultCompleteness: run.resultCompleteness,
      state: "ambiguous",
    });
  }
  return invalidTransition(run, command);
};

const markEffectAmbiguous = (
  run: Run,
  command: Extract<RunCommand, { type: "MarkEffectAmbiguous" }>
): DomainResult<TransitionPlan, RunTransitionFailure> => {
  if (run.state !== "running" && run.state !== "cancelling") {
    return invalidTransition(run, command);
  }
  if (command.operationKey.trim().length === 0) {
    return fail({
      code: "operation-key-required",
      command: command.type,
      message: "An ambiguous effect requires its durable operation key.",
      state: run.state,
    });
  }
  return succeed({
    eventDetails: [
      {
        eventType: "ExternalEffectBecameAmbiguous",
        operationKey: command.operationKey,
      },
      { eventType: "RunAmbiguous", operationKey: command.operationKey },
    ],
    pendingStopReason: run.pendingStopReason,
    resultCompleteness: run.resultCompleteness,
    state: "ambiguous",
  });
};

const claimRun = (
  run: Run,
  command: Extract<RunCommand, { type: "ClaimRun" }>
): DomainResult<TransitionPlan, RunTransitionFailure> =>
  run.state === "queued"
    ? succeed({
        eventDetails: [{ eventType: "RunStarted" }],
        resultCompleteness: run.resultCompleteness,
        state: "running",
      })
    : invalidTransition(run, command);

const openInputRequest = (
  run: Run,
  command: Extract<RunCommand, { type: "OpenInputRequest" }>
): DomainResult<TransitionPlan, RunTransitionFailure> =>
  run.state === "running"
    ? succeed({
        eventDetails: command.hasIndependentProgress
          ? [{ eventType: "InputRequested" }]
          : [{ eventType: "InputRequested" }, { eventType: "RunWaiting" }],
        resultCompleteness: run.resultCompleteness,
        state: command.hasIndependentProgress ? "running" : "waiting",
      })
    : invalidTransition(run, command);

const consumeSignal = (
  run: Run,
  command: Extract<RunCommand, { type: "ConsumeSignal" }>
): DomainResult<TransitionPlan, RunTransitionFailure> =>
  run.state === "waiting"
    ? succeed({
        eventDetails: command.reopensGlobalProgress
          ? [{ eventType: "InputRequestConsumed" }, { eventType: "RunResumed" }]
          : [{ eventType: "InputRequestConsumed" }],
        resultCompleteness: run.resultCompleteness,
        state: command.reopensGlobalProgress ? "running" : "waiting",
      })
    : invalidTransition(run, command);

const settleCancellation = (
  run: Run,
  command: Extract<RunCommand, { type: "SettleCancellation" }>
): DomainResult<TransitionPlan, RunTransitionFailure> =>
  run.state === "cancelling"
    ? succeed({
        eventDetails: [
          {
            eventType: "RunCancelled",
            reason: run.pendingStopReason ?? "requested",
          },
        ],
        resultCompleteness: run.resultCompleteness,
        state: "cancelled",
      })
    : invalidTransition(run, command);

const completeRun = (
  run: Run,
  command: Extract<RunCommand, { type: "CompleteRun" }>
): DomainResult<TransitionPlan, RunTransitionFailure> =>
  run.state === "running"
    ? validateCompletion(run, command)
    : invalidTransition(run, command);

const failRun = (
  run: Run,
  command: Extract<RunCommand, { type: "FailRun" }>
): DomainResult<TransitionPlan, RunTransitionFailure> =>
  run.state === "running"
    ? validateFailure(run, command)
    : invalidTransition(run, command);

const reconcileRun = (
  run: Run,
  command: Extract<RunCommand, { type: "ResolveAmbiguity" }>
): DomainResult<TransitionPlan, RunTransitionFailure> =>
  run.state === "ambiguous"
    ? resolveAmbiguity(run, command)
    : invalidTransition(run, command);

const planTransition = (
  run: Run,
  command: RunCommand
): DomainResult<TransitionPlan, RunTransitionFailure> => {
  switch (command.type) {
    case "ClaimRun":
      return claimRun(run, command);
    case "OpenInputRequest":
      return openInputRequest(run, command);
    case "ConsumeSignal":
      return consumeSignal(run, command);
    case "RequestStop":
      return requestStop(run, command);
    case "SettleCancellation":
      return settleCancellation(run, command);
    case "CompleteRun":
      return completeRun(run, command);
    case "FailRun":
      return failRun(run, command);
    case "MarkEffectAmbiguous":
      return markEffectAmbiguous(run, command);
    case "ResolveAmbiguity":
      return reconcileRun(run, command);
    default:
      return invalidTransition(run, command);
  }
};

const toEvent = (
  run: Run,
  detail: RunLifecycleEventDetail,
  context: RunCommandContext,
  index: number
): RunLifecycleEvent => ({
  actorId: context.actorId,
  correlationId: context.correlationId,
  eventId: context.eventIds[index] as EventId,
  eventVersion: 1,
  occurredAt: context.occurredAt,
  runId: run.runId,
  sequence: run.eventSequence + index + 1,
  workspaceId: run.workspaceId,
  ...detail,
});

export const applyRunCommand = (
  run: Run,
  command: RunCommand,
  context: RunCommandContext
): DomainResult<RunTransition, RunTransitionFailure> => {
  if (context.replayProof) {
    if (
      context.replayProof.runId !== run.runId ||
      context.replayProof.workspaceId !== run.workspaceId ||
      context.replayProof.identity.idempotencyKey !==
        context.commandIdentity.idempotencyKey
    ) {
      return fail({
        code: "replay-proof-mismatch",
        command: command.type,
        message:
          "The durable replay proof does not identify this run, workspace, and command idempotency key.",
        state: run.state,
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
          "The command idempotency key was already accepted for a different command.",
        state: run.state,
      });
    }
    return succeed({ events: [], replayed: true, run });
  }

  if (context.expectedAggregateVersion !== run.aggregateVersion) {
    return fail({
      code: "aggregate-version-conflict",
      command: command.type,
      message: `Expected aggregate version ${context.expectedAggregateVersion}, actual version is ${run.aggregateVersion}.`,
      state: run.state,
    });
  }

  const planned = planTransition(run, command);
  if (!planned.ok) {
    return planned;
  }
  if (context.eventIds.length !== planned.value.eventDetails.length) {
    return fail({
      code: "event-id-count-mismatch",
      command: command.type,
      message: `Command requires ${planned.value.eventDetails.length} event IDs; received ${context.eventIds.length}.`,
      state: run.state,
    });
  }

  const events = planned.value.eventDetails.map((detail, index) =>
    toEvent(run, detail, context, index)
  );
  const nextRun: Run = {
    ...run,
    aggregateVersion: run.aggregateVersion + 1,
    eventSequence: run.eventSequence + events.length,
    pendingStopReason: planned.value.pendingStopReason,
    ...(planned.value.resultManifest === undefined
      ? { resultManifest: undefined }
      : { resultManifest: planned.value.resultManifest }),
    resultCompleteness: planned.value.resultCompleteness,
    state: planned.value.state,
  };

  return succeed({ events, replayed: false, run: nextRun });
};
