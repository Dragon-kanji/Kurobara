import {
  type ActorId,
  type ContentHash,
  type CorrelationId,
  createRunFromPlan,
  type DomainResult,
  fail,
  type IdempotencyKey,
  type Run,
  type RunPlan,
  type RunPlanId,
  succeed,
  type WorkspaceId,
} from "@kurobara/kernel";
import type {
  ClockPort,
  IdentifierPort,
  PersistencePort,
  RunCreationRecord,
  RunCreationUnitOfWork,
} from "@kurobara/ports";

export type CreateRunCommand = Readonly<{
  workspaceId: WorkspaceId;
  actorId: ActorId;
  actorPermissions: readonly string[];
  authenticationMode: string;
  correlationId: CorrelationId;
  idempotencyKey: IdempotencyKey;
  intentionHash: ContentHash;
  runPlanId: RunPlanId;
}>;

export type CreateRunUseCaseFailureCode =
  | "authority-permission-missing"
  | "idempotency-key-reused"
  | "intention-hash-mismatch"
  | "run-plan-not-found"
  | "run-plan-already-consumed"
  | "domain-rejected";

export type CreateRunUseCaseFailure = Readonly<{
  code: CreateRunUseCaseFailureCode;
  message: string;
  domainCode?: string;
}>;

export type CreateRunUseCaseSuccess = Readonly<{
  run: Run;
  replayed: boolean;
}>;

export type CreateRunFromPlanDependencies = Readonly<{
  clock: ClockPort;
  identifiers: IdentifierPort;
  persistence: PersistencePort;
  requiredPermission: string;
}>;

const replayCreation = (
  creation: RunCreationRecord,
  command: CreateRunCommand
): DomainResult<CreateRunUseCaseSuccess, CreateRunUseCaseFailure> => {
  if (creation.intentionHash !== command.intentionHash) {
    return fail({
      code: "idempotency-key-reused",
      message: "The idempotency key was already used for another intention.",
    });
  }
  return succeed({ replayed: true, run: creation.run });
};

export type CreateRunInUnitOfWorkInput = Readonly<{
  command: CreateRunCommand;
  dependencies: Pick<
    CreateRunFromPlanDependencies,
    "identifiers" | "requiredPermission"
  >;
  expectedPlanBinding?: Readonly<{
    normalizedInputHash: ContentHash;
    workflowContentHash: ContentHash;
    workflowRevision: string;
    workflowSpecId: RunPlan["compiledWorkflow"]["workflowSpecId"];
  }>;
  now: Awaited<ReturnType<ClockPort["now"]>>;
  unitOfWork: RunCreationUnitOfWork;
}>;

const validateExpectedPlanBinding = (
  plan: RunPlan,
  expected: CreateRunInUnitOfWorkInput["expectedPlanBinding"]
): CreateRunUseCaseFailure | undefined => {
  if (expected === undefined) {
    return;
  }
  if (plan.normalizedInputHash !== expected.normalizedInputHash) {
    return {
      code: "domain-rejected",
      domainCode: "run-plan-input-mismatch",
      message:
        "The immutable run plan is not bound to the expected normalized input.",
    };
  }
  const workflow = plan.compiledWorkflow;
  if (
    workflow.workflowSpecId !== expected.workflowSpecId ||
    workflow.workflowRevision !== expected.workflowRevision ||
    workflow.workflowContentHash !== expected.workflowContentHash
  ) {
    return {
      code: "domain-rejected",
      domainCode: "run-plan-workflow-mismatch",
      message:
        "The immutable run plan does not compile the expected workflow revision.",
    };
  }
};

export const createRunInUnitOfWork = async (
  input: CreateRunInUnitOfWorkInput
): Promise<DomainResult<CreateRunUseCaseSuccess, CreateRunUseCaseFailure>> => {
  const { command, dependencies, now, unitOfWork } = input;
  const scope = { workspaceId: command.workspaceId } as const;
  await unitOfWork.runs.lockIdempotencyKey(scope, command.idempotencyKey);
  const prior = await unitOfWork.runs.findByIdempotencyKey(
    scope,
    command.idempotencyKey
  );
  const priorReplay =
    prior === undefined ? undefined : replayCreation(prior, command);
  if (priorReplay !== undefined && !priorReplay.ok) {
    return priorReplay;
  }
  const storedPlan = await unitOfWork.runPlans.get(scope, command.runPlanId);
  if (storedPlan === undefined) {
    return fail({
      code: "run-plan-not-found",
      message: "The run plan does not exist.",
    });
  }
  if (storedPlan.plan.planHash !== command.intentionHash) {
    return fail({
      code: "intention-hash-mismatch",
      message:
        "The supplied intention hash does not match the immutable run plan identity.",
    });
  }
  const bindingFailure = validateExpectedPlanBinding(
    storedPlan.plan,
    input.expectedPlanBinding
  );
  if (bindingFailure !== undefined) {
    return fail(bindingFailure);
  }
  if (priorReplay !== undefined) {
    return priorReplay;
  }
  if (storedPlan.consumedBy !== undefined) {
    if (storedPlan.consumedBy.idempotencyKey === command.idempotencyKey) {
      return replayCreation(storedPlan.consumedBy, command);
    }
    return fail({
      code: "run-plan-already-consumed",
      message: "The single-use run plan already created a run.",
    });
  }

  const [nextRunId, nextEventId, nextOutboxMessageId] = await Promise.all([
    dependencies.identifiers.nextRunId(),
    dependencies.identifiers.nextEventId(),
    dependencies.identifiers.nextOutboxMessageId(),
  ]);
  const decision = createRunFromPlan({
    actorId: command.actorId,
    correlationId: command.correlationId,
    eventId: nextEventId,
    idempotencyKey: command.idempotencyKey,
    intentionHash: command.intentionHash,
    now,
    plan: storedPlan.plan,
    requiredPermission: dependencies.requiredPermission,
    runId: nextRunId,
  });
  if (!decision.ok) {
    return fail({
      code: "domain-rejected",
      domainCode: decision.error.code,
      message: decision.error.message,
    });
  }

  const creation: RunCreationRecord = {
    idempotencyKey: command.idempotencyKey,
    intentionHash: command.intentionHash,
    run: decision.value.run,
  };
  await unitOfWork.runs.insert(scope, decision.value.run, {
    reserved: storedPlan.plan.budget.reserved,
    spent: storedPlan.plan.budget.spent,
    unit: storedPlan.plan.budget.unit,
  });
  await unitOfWork.runEvents.append(scope, decision.value.event);
  await unitOfWork.outbox.append(scope, {
    aggregateId: decision.value.run.runId,
    aggregateVersion: 1,
    availableAt: now,
    destination: "orchestration.run.queued",
    event: decision.value.event,
    eventId: decision.value.event.eventId,
    messageId: nextOutboxMessageId,
    workspaceId: command.workspaceId,
  });
  await unitOfWork.runPlans.markConsumed(scope, command.runPlanId, creation);

  return succeed({ replayed: false, run: decision.value.run });
};

export const makeCreateRunFromPlan =
  (dependencies: CreateRunFromPlanDependencies) =>
  async (
    command: CreateRunCommand
  ): Promise<
    DomainResult<CreateRunUseCaseSuccess, CreateRunUseCaseFailure>
  > => {
    if (!command.actorPermissions.includes(dependencies.requiredPermission)) {
      return fail({
        code: "authority-permission-missing",
        message: "The authenticated actor lacks permission to create runs.",
      });
    }

    const now = await dependencies.clock.now();
    const scope = { workspaceId: command.workspaceId } as const;

    return dependencies.persistence.transaction(scope, (unitOfWork) =>
      createRunInUnitOfWork({
        command,
        dependencies: {
          identifiers: dependencies.identifiers,
          requiredPermission: dependencies.requiredPermission,
        },
        now,
        unitOfWork,
      })
    );
  };
