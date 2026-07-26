import {
  actorId,
  applyRunCommand,
  contentHash,
  correlationId,
  type DomainResult,
  type EventId,
  fail,
  idempotencyKey,
  type Run,
  type RunCommandIdentity,
  type RunId,
  type RunTransition,
  succeed,
  transitionCellResult,
  type WorkspaceId,
} from "@kurobara/kernel";
import type {
  ClockPort,
  IdentifierPort,
  RunExecutionPersistencePort,
  RunExecutionUnitOfWork,
  WorkspaceScope,
} from "@kurobara/ports";

const CLAIM_RUN_COMMAND_HASH = contentHash(
  "sha256:d2bdbe63e605e62d210f59245f07894fec610812f3100a174d0c4ed0d4dbe446"
);

export type ClaimRunExecutionInput = Readonly<{
  eventId: EventId;
  runId: RunId;
  startKey: string;
  workspaceId: WorkspaceId;
}>;

export type ClaimRunExecutionSuccess = Readonly<{
  replayed: boolean;
  run: Run;
}>;

export type ClaimRunExecutionFailure = Readonly<{
  code: "run-not-found" | "start-key-required" | "transition-rejected";
  domainCode?: string;
  message: string;
}>;

type ClaimRunExecutionResult = DomainResult<
  ClaimRunExecutionSuccess,
  ClaimRunExecutionFailure
>;

export type ClaimRunExecutionDependencies = Readonly<{
  clock: ClockPort;
  identifiers: IdentifierPort;
  persistence: RunExecutionPersistencePort;
}>;

const requestDagScheduling = async (
  unitOfWork: RunExecutionUnitOfWork,
  scope: WorkspaceScope,
  run: Run
): Promise<void> => {
  if (run.state === "running") {
    await unitOfWork.dagSchedule.request(scope, run.runId);
  }
};

const persistFreshClaim = async (
  unitOfWork: RunExecutionUnitOfWork,
  scope: WorkspaceScope,
  input: ClaimRunExecutionInput,
  identity: RunCommandIdentity,
  previousRun: Run,
  transition: RunTransition
): Promise<void> => {
  if (transition.replayed) {
    return;
  }
  await unitOfWork.runs.update(
    scope,
    previousRun.aggregateVersion,
    transition.run
  );
  for (const event of transition.events) {
    await unitOfWork.runEvents.append(scope, event);
  }
  await unitOfWork.commandJournal.insert(
    scope,
    {
      commandType: "ClaimRun",
      identity,
      runId: input.runId,
      workspaceId: input.workspaceId,
    },
    actorId("system:orchestration"),
    correlationId(`orchestration:${input.eventId}`)
  );
};

const markBoundCellRunning = async (
  unitOfWork: RunExecutionUnitOfWork,
  scope: WorkspaceScope,
  run: Run
): Promise<DomainResult<undefined, ClaimRunExecutionFailure>> => {
  if (run.state !== "running" || unitOfWork.cellResults === undefined) {
    return succeed(undefined);
  }
  const current = await unitOfWork.cellResults.getByRun(scope, run.runId);
  if (current === undefined) {
    return succeed(undefined);
  }
  const transition = transitionCellResult(current, {
    ...current,
    status: "running",
  });
  if (!transition.ok) {
    return fail({
      code: "transition-rejected",
      domainCode: transition.error.code,
      message: transition.error.message,
    });
  }
  if (transition.value.replayed) {
    return succeed(undefined);
  }
  const runningCell = transition.value.cellResult;
  if (runningCell.status !== "running") {
    return fail({
      code: "transition-rejected",
      message: "The recipe cell did not enter the canonical running state.",
    });
  }
  await unitOfWork.cellResults.markRunning(scope, run.runId, {
    ...runningCell,
    status: "running",
  });
  return succeed(undefined);
};

const claimRunInUnitOfWork = async (
  dependencies: ClaimRunExecutionDependencies,
  unitOfWork: RunExecutionUnitOfWork,
  scope: WorkspaceScope,
  input: ClaimRunExecutionInput,
  identity: RunCommandIdentity
): Promise<ClaimRunExecutionResult> => {
  const run = await unitOfWork.runs.getForUpdate(scope, input.runId);
  if (run === undefined) {
    return fail({
      code: "run-not-found",
      message: "The run to claim does not exist in this workspace.",
    });
  }
  const replayProof = await unitOfWork.commandJournal.find(
    scope,
    input.runId,
    identity.idempotencyKey
  );
  const transition = applyRunCommand(
    run,
    { type: "ClaimRun" },
    {
      actorId: actorId("system:orchestration"),
      commandIdentity: identity,
      correlationId: correlationId(`orchestration:${input.eventId}`),
      eventIds:
        replayProof === undefined
          ? [await dependencies.identifiers.nextEventId()]
          : [],
      expectedAggregateVersion: run.aggregateVersion,
      occurredAt: await dependencies.clock.now(),
      ...(replayProof === undefined ? {} : { replayProof }),
    }
  );
  if (!transition.ok) {
    return fail({
      code: "transition-rejected",
      domainCode: transition.error.code,
      message: transition.error.message,
    });
  }
  const cellResult = await markBoundCellRunning(
    unitOfWork,
    scope,
    transition.value.run
  );
  if (!cellResult.ok) {
    return cellResult;
  }
  await persistFreshClaim(
    unitOfWork,
    scope,
    input,
    identity,
    run,
    transition.value
  );
  await requestDagScheduling(unitOfWork, scope, transition.value.run);
  return succeed({
    replayed: transition.value.replayed,
    run: transition.value.run,
  });
};

export const makeClaimRunExecution =
  (dependencies: ClaimRunExecutionDependencies) =>
  (input: ClaimRunExecutionInput): Promise<ClaimRunExecutionResult> => {
    const startKey = input.startKey.trim();
    if (startKey.length === 0) {
      return Promise.resolve<ClaimRunExecutionResult>(
        fail({
          code: "start-key-required",
          message: "ClaimRun requires a non-empty orchestration start key.",
        })
      );
    }
    const scope = { workspaceId: input.workspaceId } as const;
    const identity = {
      commandHash: CLAIM_RUN_COMMAND_HASH,
      idempotencyKey: idempotencyKey(`claim-run:${startKey}`),
    } as const;

    return dependencies.persistence.transaction<ClaimRunExecutionResult>(
      scope,
      (unitOfWork) =>
        claimRunInUnitOfWork(dependencies, unitOfWork, scope, input, identity)
    );
  };
