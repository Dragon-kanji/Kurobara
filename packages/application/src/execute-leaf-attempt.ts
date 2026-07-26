import {
  type Artifact,
  type Attempt,
  artifactId,
  artifactRef,
  type ContractRef,
  correlationId,
  type DomainResult,
  fail,
  idempotencyKey,
  type StepRun,
  succeed,
} from "@kurobara/kernel";
import type {
  ExecuteLeafEffectOutcome,
  LeafEffectFinalOutcome,
  LeafEffectPort,
  LeafEffectRequest,
  LookupLeafEffectOutcome,
  NormalizedJsonValue,
  OutputContractValidatorPort,
  StartLeafAttemptRequest,
  StepExecutionQueryPort,
  ValidatedRunInput,
} from "@kurobara/ports";

import {
  canonicalContentByteSize,
  canonicalContentHash,
} from "./canonical-content-hash.ts";
import type { StepEventIdentifierPort } from "./claim-step-attempt.ts";
import {
  makeTransitionStepAttempt,
  type TransitionStepAttemptDependencies,
  type TransitionStepAttemptResult,
} from "./transition-step-attempt.ts";

export type ExecuteLeafAttemptSuccess = Readonly<{
  replayed: boolean;
  status: "ambiguous" | "cancelled" | "failed" | "succeeded";
  stepRun: StepRun;
}>;

export type ExecuteLeafAttemptFailure = Readonly<{
  code:
    | "attempt-not-found"
    | "effect-operation-failed"
    | "leaf-binding-mismatch"
    | "step-not-found"
    | "transition-rejected";
  domainCode?: string;
  message: string;
}>;

export type ExecuteLeafAttemptResult = DomainResult<
  ExecuteLeafAttemptSuccess,
  ExecuteLeafAttemptFailure
>;

export type ExecuteLeafAttemptDependencies = Readonly<{
  clock: TransitionStepAttemptDependencies["clock"];
  effect: LeafEffectPort;
  identifiers: StepEventIdentifierPort;
  outputValidator: OutputContractValidatorPort;
  persistence: TransitionStepAttemptDependencies["persistence"];
  queries: StepExecutionQueryPort;
  requiredPermission: string;
}>;

export type ExecuteLeafAttemptRegistryDependencies = Omit<
  ExecuteLeafAttemptDependencies,
  "effect"
> &
  Readonly<{
    effects: readonly LeafEffectPort[];
  }>;

type Transition = ReturnType<typeof makeTransitionStepAttempt>;
type CommandBase = Readonly<{
  actorId: import("@kurobara/kernel").ActorId;
  attemptId: import("@kurobara/kernel").AttemptId;
  correlationId: import("@kurobara/kernel").CorrelationId;
  stepRunId: import("@kurobara/kernel").StepRunId;
  workspaceId: import("@kurobara/kernel").WorkspaceId;
}>;
type LoadedLeaf = Readonly<{
  attempt: Attempt;
  commandBase: CommandBase;
  isOutputSink: boolean;
  outputContract: ContractRef;
  runInput?: ValidatedRunInput;
  startKey: string;
  stepRun: StepRun;
}>;
type PreparedOutput =
  import("./transition-step-attempt.ts").StepOutputMaterialization;
type OutputPreparation =
  | Readonly<{ output: PreparedOutput; status: "accepted" }>
  | Readonly<{ status: "rejected" }>
  | Readonly<{ status: "unavailable" }>;
type ThresholdContinuation = Readonly<{
  execute: boolean;
  attempt: Attempt;
  stepRun: StepRun;
}>;
type ThresholdResult =
  | Readonly<{ kind: "continue"; value: ThresholdContinuation }>
  | Readonly<{ kind: "final"; result: ExecuteLeafAttemptResult }>;

const terminalStatus = (
  attempt: Attempt
): ExecuteLeafAttemptSuccess["status"] | undefined => {
  switch (attempt.state) {
    case "succeeded":
      return "succeeded";
    case "failed_retryable":
    case "failed_terminal":
      return "failed";
    case "cancelled_before_effect":
      return "cancelled";
    case "ambiguous":
      return "ambiguous";
    default:
      return;
  }
};

const transitionFailure = (
  result: Extract<TransitionStepAttemptResult, { ok: false }>
): ExecuteLeafAttemptResult =>
  fail({
    code: "transition-rejected",
    domainCode: result.error.domainCode ?? result.error.code,
    message: result.error.message,
  });

const commandKey = (startKey: string, command: string) =>
  idempotencyKey(`leaf:${startKey}:${command}`);

const toEffectRequest = (
  request: StartLeafAttemptRequest,
  attempt: Attempt,
  runInput?: ValidatedRunInput
): LeafEffectRequest => ({
  attemptId: attempt.attemptId,
  operationKey: attempt.operationKey,
  reservationUnit: attempt.reservationUnit,
  reservedAmount: attempt.reservedAmount,
  routeSnapshotHash: attempt.routeSnapshotHash,
  routingDecisionId: attempt.routingDecisionId,
  runId: request.runId,
  ...(runInput === undefined ? {} : { runInput }),
  stepRunId: request.stepRunId,
  workspaceId: request.workspaceId,
});

const successFrom = (
  stepRun: StepRun,
  targetAttemptId: Attempt["attemptId"],
  replayed: boolean
): ExecuteLeafAttemptResult => {
  const attempt = stepRun.attempts.find(
    (candidate) => candidate.attemptId === targetAttemptId
  );
  const status = attempt === undefined ? undefined : terminalStatus(attempt);
  return status === undefined
    ? fail({
        code: "attempt-not-found",
        message: "The leaf transition did not preserve its target attempt.",
      })
    : succeed({ replayed, status, stepRun });
};

const recoverRecordedRetry = async (
  transition: Transition,
  loaded: LoadedLeaf
): Promise<ExecuteLeafAttemptResult> => {
  const result = await transition({
    ...loaded.commandBase,
    commandIdempotencyKey: commandKey(loaded.startKey, "authorize-retry"),
    expectedAggregateVersion: loaded.stepRun.aggregateVersion,
    type: "AuthorizeRetry",
  });
  return result.ok
    ? successFrom(result.value.stepRun, loaded.commandBase.attemptId, true)
    : transitionFailure(result);
};

const loadLeaf = async (
  queries: StepExecutionQueryPort,
  effectAdapterKey: string,
  request: StartLeafAttemptRequest
): Promise<DomainResult<LoadedLeaf, ExecuteLeafAttemptFailure>> => {
  const startKey = request.startKey.trim();
  if (startKey.length === 0) {
    return fail({
      code: "effect-operation-failed",
      message: "A leaf execution requires a non-empty durable start key.",
    });
  }
  const scope = { workspaceId: request.workspaceId } as const;
  const [context, identity] = await Promise.all([
    queries.getContextByStepId(scope, request.stepRunId),
    queries.getLeafExecutionIdentity(
      scope,
      request.stepRunId,
      request.attemptId
    ),
  ]);
  if (
    identity === undefined ||
    identity.workspaceId !== request.workspaceId ||
    identity.runId !== request.runId ||
    identity.stepRunId !== request.stepRunId ||
    identity.attemptId !== request.attemptId ||
    identity.effectAdapterKey !== effectAdapterKey ||
    identity.eventId !== request.eventId ||
    identity.startKey !== startKey
  ) {
    return fail({
      code: "leaf-binding-mismatch",
      message:
        "The leaf callback does not match its exact durable outbox binding.",
    });
  }
  const stepRun = context?.stepRun;
  if (
    context === undefined ||
    stepRun === undefined ||
    stepRun.runId !== request.runId
  ) {
    return fail({
      code: "step-not-found",
      message: "The leaf step does not exist in this workspace and run.",
    });
  }
  const attempt = stepRun.attempts.find(
    (candidate) => candidate.attemptId === request.attemptId
  );
  if (attempt === undefined) {
    return fail({
      code: "attempt-not-found",
      message: "The leaf execution does not identify a durable attempt.",
    });
  }
  const dependedOn = new Set(
    context.plan.compiledWorkflow.nodes.flatMap((node) => node.dependsOn)
  );
  const sinks = context.plan.compiledWorkflow.nodes.filter(
    (node) => !dependedOn.has(node.key)
  );
  return succeed({
    attempt,
    commandBase: {
      actorId: context.plan.authority.subjectActorId,
      attemptId: request.attemptId,
      correlationId: correlationId(`leaf:${request.eventId}`),
      stepRunId: request.stepRunId,
      workspaceId: request.workspaceId,
    },
    isOutputSink: sinks.length === 1 && sinks[0]?.key === stepRun.nodeKey,
    outputContract: context.plan.outputContract,
    ...(context.runInput !== undefined &&
    context.plan.compiledWorkflow.nodes.length === 1
      ? { runInput: context.runInput }
      : {}),
    startKey,
    stepRun,
  });
};

const prepareSinkOutput = async (
  dependencies: ExecuteLeafAttemptDependencies,
  loaded: LoadedLeaf,
  attempt: Attempt,
  value: NormalizedJsonValue
): Promise<OutputPreparation> => {
  try {
    const validation = await dependencies.outputValidator.validate({
      contract: loaded.outputContract,
      value,
    });
    if (validation.status === "rejected") {
      return { status: "rejected" };
    }
    if (validation.validatorVersion.trim().length === 0) {
      return { status: "unavailable" };
    }
    const validatedAt = await dependencies.clock.now();
    const contentHash = canonicalContentHash(value);
    const identityHash = canonicalContentHash({
      attemptId: attempt.attemptId,
      contentHash,
      contract: loaded.outputContract,
      operationKey: attempt.operationKey,
      runId: loaded.stepRun.runId,
      stepRunId: loaded.stepRun.stepRunId,
      workspaceId: loaded.stepRun.workspaceId,
    });
    const artifact: Artifact = {
      artifactId: artifactId(
        `artifact_${identityHash.slice("sha256:".length)}`
      ),
      attemptId: attempt.attemptId,
      classification: "internal",
      contentHash,
      contract: loaded.outputContract,
      finalizedAt: validatedAt,
      kind: "normalized-output",
      mediaType: "application/json",
      operationKey: attempt.operationKey,
      retentionPolicy: "run",
      runId: loaded.stepRun.runId,
      sizeBytes: canonicalContentByteSize(value),
      state: "finalized",
      stepRunId: loaded.stepRun.stepRunId,
      validatedAt,
      validatorVersion: validation.validatorVersion,
      workspaceId: loaded.stepRun.workspaceId,
    };
    return {
      output: {
        artifact,
        ref: {
          artifact: artifactRef(artifact),
          contract: artifact.contract,
          validatedAt,
          validatorVersion: validation.validatorVersion,
        },
        value,
      },
      status: "accepted",
    };
  } catch {
    return { status: "unavailable" };
  }
};

const settleFreshOutcome = async (
  transition: Transition,
  commandBase: CommandBase,
  startKey: string,
  stepRun: StepRun,
  outcome: LeafEffectFinalOutcome,
  output?: PreparedOutput
): Promise<ExecuteLeafAttemptResult> => {
  const result = await transition(
    outcome.status === "succeeded"
      ? {
          ...commandBase,
          commandIdempotencyKey: commandKey(startKey, "succeeded"),
          expectedAggregateVersion: stepRun.aggregateVersion,
          ...(output === undefined ? {} : { output }),
          settlement: outcome.settlement,
          type: "RecordAttemptSucceeded",
        }
      : {
          ...commandBase,
          commandIdempotencyKey: commandKey(startKey, "failed"),
          expectedAggregateVersion: stepRun.aggregateVersion,
          retryable: outcome.retryable,
          settlement: outcome.settlement,
          type: "RecordAttemptFailure",
        }
  );
  return result.ok
    ? successFrom(result.value.stepRun, commandBase.attemptId, false)
    : transitionFailure(result);
};

const markAmbiguous = async (
  transition: Transition,
  commandBase: CommandBase,
  startKey: string,
  stepRun: StepRun
): Promise<ExecuteLeafAttemptResult> => {
  const result = await transition({
    ...commandBase,
    commandIdempotencyKey: commandKey(startKey, "ambiguous"),
    expectedAggregateVersion: stepRun.aggregateVersion,
    type: "MarkAttemptAmbiguous",
  });
  return result.ok
    ? succeed({
        replayed: result.value.replayed,
        status: "ambiguous",
        stepRun: result.value.stepRun,
      })
    : transitionFailure(result);
};

const resolveBeforeEffect = async (
  transition: Transition,
  loaded: LoadedLeaf,
  rejection: Extract<TransitionStepAttemptResult, { ok: false }>
): Promise<ExecuteLeafAttemptResult> => {
  const { commandBase, startKey, stepRun } = loaded;
  if (rejection.error.code === "deadline-elapsed") {
    const expired = await transition({
      ...commandBase,
      commandIdempotencyKey: commandKey(startKey, "not-started"),
      expectedAggregateVersion: stepRun.aggregateVersion,
      retryable: false,
      settlement: { kind: "release" },
      type: "RecordAttemptNotStarted",
    });
    return expired.ok
      ? successFrom(expired.value.stepRun, commandBase.attemptId, false)
      : transitionFailure(expired);
  }
  if (rejection.error.code === "run-not-running") {
    const cancelled = await transition({
      ...commandBase,
      commandIdempotencyKey: commandKey(startKey, "cancel-before-effect"),
      expectedAggregateVersion: stepRun.aggregateVersion,
      type: "CancelAttemptBeforeEffect",
    });
    return cancelled.ok
      ? successFrom(cancelled.value.stepRun, commandBase.attemptId, false)
      : transitionFailure(cancelled);
  }
  return transitionFailure(rejection);
};

const ensureEffectThreshold = async (
  transition: Transition,
  loaded: LoadedLeaf
): Promise<ThresholdResult> => {
  if (
    loaded.attempt.state !== "claimed" &&
    loaded.attempt.state !== "in_flight"
  ) {
    return {
      kind: "continue",
      value: {
        attempt: loaded.attempt,
        execute: false,
        stepRun: loaded.stepRun,
      },
    };
  }
  const started = await transition({
    ...loaded.commandBase,
    commandIdempotencyKey: commandKey(loaded.startKey, "start-effect"),
    expectedAggregateVersion: loaded.stepRun.aggregateVersion,
    type: "StartAttemptEffect",
  });
  if (!started.ok) {
    return {
      kind: "final",
      result:
        loaded.attempt.state === "claimed"
          ? await resolveBeforeEffect(transition, loaded, started)
          : transitionFailure(started),
    };
  }
  const attempt = started.value.stepRun.attempts.find(
    (candidate) => candidate.attemptId === loaded.attempt.attemptId
  );
  if (attempt === undefined) {
    return {
      kind: "final",
      result: fail({
        code: "attempt-not-found",
        message: "The leaf attempt disappeared after its effect threshold.",
      }),
    };
  }
  return {
    kind: "continue",
    value: {
      attempt,
      execute: started.value.effectPermission === "granted",
      stepRun: started.value.stepRun,
    },
  };
};

const executeFreshEffect = async (
  dependencies: ExecuteLeafAttemptDependencies,
  transition: Transition,
  effect: LeafEffectPort,
  request: StartLeafAttemptRequest,
  loaded: LoadedLeaf,
  current: ThresholdContinuation
): Promise<ExecuteLeafAttemptResult> => {
  let outcome: ExecuteLeafEffectOutcome;
  try {
    outcome = await effect.execute(
      toEffectRequest(request, current.attempt, loaded.runInput)
    );
  } catch {
    outcome = {
      reason: "leaf-effect-operation-failed",
      status: "outcome-unknown",
    };
  }
  if (outcome.status === "failed") {
    return settleFreshOutcome(
      transition,
      loaded.commandBase,
      loaded.startKey,
      current.stepRun,
      outcome
    );
  }
  if (outcome.status === "outcome-unknown") {
    return markAmbiguous(
      transition,
      loaded.commandBase,
      loaded.startKey,
      current.stepRun
    );
  }
  if (!loaded.isOutputSink) {
    return settleFreshOutcome(
      transition,
      loaded.commandBase,
      loaded.startKey,
      current.stepRun,
      outcome
    );
  }
  const prepared = await prepareSinkOutput(
    dependencies,
    loaded,
    current.attempt,
    outcome.output
  );
  if (prepared.status === "unavailable") {
    return markAmbiguous(
      transition,
      loaded.commandBase,
      loaded.startKey,
      current.stepRun
    );
  }
  if (prepared.status === "rejected") {
    return settleFreshOutcome(
      transition,
      loaded.commandBase,
      loaded.startKey,
      current.stepRun,
      {
        reason: "output-contract-violation",
        retryable: false,
        settlement: outcome.settlement,
        status: "failed",
      }
    );
  }
  return settleFreshOutcome(
    transition,
    loaded.commandBase,
    loaded.startKey,
    current.stepRun,
    outcome,
    prepared.output
  );
};

const resolutionForLookup = (
  lookup: Extract<LookupLeafEffectOutcome, { status: "found" }>
): Readonly<{
  outcome: "failed_retryable" | "failed_terminal" | "succeeded";
  settlement: import("@kurobara/ports").LeafEffectSettlement;
}> => {
  if (lookup.outcome.status === "succeeded") {
    return { outcome: "succeeded", settlement: lookup.outcome.settlement };
  }
  return {
    outcome: lookup.outcome.retryable ? "failed_retryable" : "failed_terminal",
    settlement: lookup.outcome.settlement,
  };
};

const resolveLookup = async (
  dependencies: ExecuteLeafAttemptDependencies,
  transition: Transition,
  loaded: LoadedLeaf,
  commandBase: CommandBase,
  startKey: string,
  stepRun: StepRun,
  lookup: Extract<LookupLeafEffectOutcome, { status: "found" }>
): Promise<ExecuteLeafAttemptResult> => {
  let resolution = resolutionForLookup(lookup);
  let output: PreparedOutput | undefined;
  if (lookup.outcome.status === "succeeded" && loaded.isOutputSink) {
    const prepared = await prepareSinkOutput(
      dependencies,
      loaded,
      loaded.attempt,
      lookup.outcome.output
    );
    if (prepared.status === "unavailable") {
      return succeed({ replayed: true, status: "ambiguous", stepRun });
    }
    if (prepared.status === "rejected") {
      resolution = {
        outcome: "failed_terminal",
        settlement: lookup.outcome.settlement,
      };
    } else {
      output = prepared.output;
    }
  }
  const result = await transition({
    ...commandBase,
    commandIdempotencyKey: commandKey(startKey, `resolve:${lookup.proofId}`),
    expectedAggregateVersion: stepRun.aggregateVersion,
    outcome: resolution.outcome,
    ...(output === undefined ? {} : { output }),
    proofId: lookup.proofId,
    settlement: resolution.settlement,
    type: "ResolveAttemptAmbiguity",
  });
  return result.ok
    ? successFrom(result.value.stepRun, commandBase.attemptId, true)
    : transitionFailure(result);
};

const lookupEffect = async (
  effect: LeafEffectPort,
  request: LeafEffectRequest
): Promise<LookupLeafEffectOutcome> => {
  try {
    return await effect.lookup(request);
  } catch {
    return {
      reason: "leaf-effect-lookup-failed",
      status: "outcome-unknown",
    };
  }
};

const reconcileEffect = async (
  dependencies: ExecuteLeafAttemptDependencies,
  transition: Transition,
  effect: LeafEffectPort,
  request: StartLeafAttemptRequest,
  loaded: LoadedLeaf,
  current: ThresholdContinuation
): Promise<ExecuteLeafAttemptResult> => {
  const terminal = terminalStatus(current.attempt);
  if (terminal !== undefined && terminal !== "ambiguous") {
    return succeed({
      replayed: true,
      status: terminal,
      stepRun: current.stepRun,
    });
  }
  const lookup = await lookupEffect(
    effect,
    toEffectRequest(request, current.attempt, loaded.runInput)
  );
  const ambiguous =
    current.attempt.state === "in_flight"
      ? await markAmbiguous(
          transition,
          loaded.commandBase,
          loaded.startKey,
          current.stepRun
        )
      : succeed({
          replayed: true,
          status: "ambiguous" as const,
          stepRun: current.stepRun,
        });
  if (!ambiguous.ok || lookup.status !== "found") {
    return ambiguous;
  }
  return resolveLookup(
    dependencies,
    transition,
    loaded,
    loaded.commandBase,
    loaded.startKey,
    ambiguous.value.stepRun,
    lookup
  );
};

export const makeExecuteLeafAttempt = (
  dependencies: ExecuteLeafAttemptDependencies
) => {
  const transition = makeTransitionStepAttempt({
    clock: dependencies.clock,
    identifiers: dependencies.identifiers,
    persistence: dependencies.persistence,
    requiredPermission: dependencies.requiredPermission,
  });

  return async (
    request: StartLeafAttemptRequest
  ): Promise<ExecuteLeafAttemptResult> => {
    const loaded = await loadLeaf(
      dependencies.queries,
      dependencies.effect.adapterKey,
      request
    );
    if (!loaded.ok) {
      return loaded;
    }
    if (
      loaded.value.attempt.state === "failed_retryable" &&
      loaded.value.stepRun.state === "retryable"
    ) {
      return recoverRecordedRetry(transition, loaded.value);
    }
    const terminal = terminalStatus(loaded.value.attempt);
    if (terminal !== undefined && terminal !== "ambiguous") {
      return succeed({
        replayed: true,
        status: terminal,
        stepRun: loaded.value.stepRun,
      });
    }
    const threshold = await ensureEffectThreshold(transition, loaded.value);
    if (threshold.kind === "final") {
      return threshold.result;
    }
    return threshold.value.execute
      ? executeFreshEffect(
          dependencies,
          transition,
          dependencies.effect,
          request,
          loaded.value,
          threshold.value
        )
      : reconcileEffect(
          dependencies,
          transition,
          dependencies.effect,
          request,
          loaded.value,
          threshold.value
        );
  };
};

const matchesDurableLeafIdentity = (
  identity: Awaited<
    ReturnType<StepExecutionQueryPort["getLeafExecutionIdentity"]>
  >,
  request: StartLeafAttemptRequest
): identity is NonNullable<typeof identity> &
  Readonly<{ effectAdapterKey: string }> =>
  identity !== undefined &&
  identity.workspaceId === request.workspaceId &&
  identity.runId === request.runId &&
  identity.stepRunId === request.stepRunId &&
  identity.attemptId === request.attemptId &&
  identity.eventId === request.eventId &&
  identity.startKey === request.startKey.trim() &&
  identity.effectAdapterKey !== undefined;

export const makeExecuteLeafAttemptRegistry = (
  dependencies: ExecuteLeafAttemptRegistryDependencies
) => {
  const executors = new Map<
    string,
    ReturnType<typeof makeExecuteLeafAttempt>
  >();
  for (const effect of dependencies.effects) {
    const adapterKey = effect.adapterKey.trim();
    if (
      adapterKey.length === 0 ||
      adapterKey !== effect.adapterKey ||
      executors.has(adapterKey)
    ) {
      throw new RangeError(
        "Leaf effect adapter keys must be unique, non-empty, and free of outer whitespace."
      );
    }
    executors.set(
      adapterKey,
      makeExecuteLeafAttempt({ ...dependencies, effect })
    );
  }
  if (executors.size === 0) {
    throw new RangeError("At least one leaf effect adapter is required.");
  }

  return async (
    request: StartLeafAttemptRequest
  ): Promise<ExecuteLeafAttemptResult> => {
    const identity = await dependencies.queries.getLeafExecutionIdentity(
      { workspaceId: request.workspaceId },
      request.stepRunId,
      request.attemptId
    );
    if (!matchesDurableLeafIdentity(identity, request)) {
      return fail({
        code: "leaf-binding-mismatch",
        message:
          "The leaf callback does not match its exact durable outbox binding.",
      });
    }
    const execute = executors.get(identity.effectAdapterKey);
    if (execute === undefined) {
      return fail({
        code: "leaf-binding-mismatch",
        message:
          "The durable leaf binding requires an unavailable effect adapter.",
      });
    }
    return execute(request);
  };
};
