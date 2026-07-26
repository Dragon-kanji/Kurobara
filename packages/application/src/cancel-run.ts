import {
  applyRunCommand,
  contentHash,
  correlationId,
  type EventId,
  fail,
  InvalidValueObjectError,
  idempotencyKey,
  type Run,
  type RunCommandIdentity,
  type RunId,
  type RunTransition,
  runId,
  succeed,
} from "@kurobara/kernel";
import type {
  ClockPort,
  IdentifierPort,
  RunExecutionPersistencePort,
  RunExecutionUnitOfWork,
  VerifiedApiKey,
  WorkspaceScope,
} from "@kurobara/ports";

export const CANCEL_RUN_COMMAND_HASH = contentHash(
  "sha256:ea28a7e32707b83c7b15be078d3f6cec2b35a7bcf872ec0528090e8f2a749407"
);

export type CancelRunRequest = Readonly<{
  actor: VerifiedApiKey;
  correlationId: string;
  idempotencyKey: string;
  runId: string;
}>;

export type CancelRunSuccess = Readonly<{
  replayed: boolean;
  run: Run;
}>;

export type CancelRunFailureCode =
  | "authority-permission-missing"
  | "domain-rejected"
  | "idempotency-key-reused"
  | "request-invalid"
  | "run-not-found";

export type CancelRunFailure = Readonly<{
  code: CancelRunFailureCode;
  domainCode?: string;
  message: string;
}>;

export type CancelRunDependencies = Readonly<{
  clock: ClockPort;
  identifiers: Pick<IdentifierPort, "nextEventId">;
  persistence: RunExecutionPersistencePort;
  requiredPermission: string;
}>;

const requiredEventCount = (run: Run): number => {
  if (
    run.state === "queued" ||
    run.state === "running" ||
    run.state === "waiting"
  ) {
    return 2;
  }
  return run.state === "ambiguous" ? 1 : 0;
};

const persistFreshCancellation = async (
  unitOfWork: RunExecutionUnitOfWork,
  scope: WorkspaceScope,
  previousRun: Run,
  transition: RunTransition,
  identity: RunCommandIdentity,
  request: CancelRunRequest
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
    // Lifecycle sequence is part of the durable audit contract.
    await unitOfWork.runEvents.append(scope, event);
  }
  await unitOfWork.commandJournal.insert(
    scope,
    {
      commandType: "RequestStop",
      identity,
      runId: previousRun.runId,
      workspaceId: previousRun.workspaceId,
    },
    request.actor.actorId,
    correlationId(request.correlationId)
  );
  if (transition.run.state === "cancelling") {
    await unitOfWork.dagSchedule.request(scope, transition.run.runId);
  }
};

export const cancelRunInUnitOfWork = async (
  dependencies: Pick<CancelRunDependencies, "clock" | "identifiers">,
  unitOfWork: RunExecutionUnitOfWork,
  scope: WorkspaceScope,
  selectedRunId: RunId,
  identity: RunCommandIdentity,
  request: CancelRunRequest
) => {
  const run = await unitOfWork.runs.getForUpdate(scope, selectedRunId);
  if (run === undefined) {
    return fail<CancelRunFailure>({
      code: "run-not-found",
      message: "The run does not exist in this workspace.",
    });
  }
  const replayProof = await unitOfWork.commandJournal.find(
    scope,
    selectedRunId,
    identity.idempotencyKey
  );
  const eventIds: readonly EventId[] =
    replayProof === undefined
      ? await Promise.all(
          Array.from({ length: requiredEventCount(run) }, () =>
            dependencies.identifiers.nextEventId()
          )
        )
      : [];
  const transition = applyRunCommand(
    run,
    { reason: "requested", type: "RequestStop" },
    {
      actorId: request.actor.actorId,
      commandIdentity: identity,
      correlationId: correlationId(request.correlationId),
      eventIds,
      expectedAggregateVersion: run.aggregateVersion,
      occurredAt: await dependencies.clock.now(),
      ...(replayProof === undefined ? {} : { replayProof }),
    }
  );
  if (!transition.ok) {
    if (transition.error.code === "idempotency-key-reused") {
      return fail<CancelRunFailure>({
        code: "idempotency-key-reused",
        message: transition.error.message,
      });
    }
    return fail<CancelRunFailure>({
      code: "domain-rejected",
      domainCode: transition.error.code,
      message: transition.error.message,
    });
  }
  await persistFreshCancellation(
    unitOfWork,
    scope,
    run,
    transition.value,
    identity,
    request
  );
  return succeed<CancelRunSuccess>({
    replayed: transition.value.replayed,
    run: transition.value.run,
  });
};

export const makeCancelRun =
  (dependencies: CancelRunDependencies) =>
  async (request: CancelRunRequest) => {
    if (!request.actor.permissions.includes(dependencies.requiredPermission)) {
      return fail<CancelRunFailure>({
        code: "authority-permission-missing",
        message: "The authenticated actor lacks permission to cancel runs.",
      });
    }
    try {
      const selectedRunId = runId(request.runId);
      const identity = {
        commandHash: CANCEL_RUN_COMMAND_HASH,
        idempotencyKey: idempotencyKey(request.idempotencyKey),
      } as const;
      const scope = { workspaceId: request.actor.workspaceId } as const;
      return await dependencies.persistence.transaction(scope, (unitOfWork) =>
        cancelRunInUnitOfWork(
          dependencies,
          unitOfWork,
          scope,
          selectedRunId,
          identity,
          request
        )
      );
    } catch (error) {
      if (error instanceof InvalidValueObjectError) {
        return fail<CancelRunFailure>({
          code: "request-invalid",
          message: "The run cancellation request contains an invalid value.",
        });
      }
      throw error;
    }
  };
