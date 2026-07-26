import {
  correlationId,
  type DomainResult,
  fail,
  idempotencyKey,
  type StepRun,
  succeed,
} from "@kurobara/kernel";
import type {
  StartLeafAttemptRequest,
  StepExecutionQueryPort,
} from "@kurobara/ports";

import type { StepEventIdentifierPort } from "./claim-step-attempt.ts";
import {
  makeTransitionStepAttempt,
  type TransitionStepAttemptDependencies,
  type TransitionStepAttemptResult,
} from "./transition-step-attempt.ts";

export type RecordLeafAttemptNotStartedSuccess = Readonly<{
  replayed: boolean;
  stepRun: StepRun;
}>;

export type RecordLeafAttemptNotStartedFailure = Readonly<{
  code: "attempt-not-found" | "step-not-found" | "transition-rejected";
  domainCode?: string;
  message: string;
}>;

export type RecordLeafAttemptNotStartedResult = DomainResult<
  RecordLeafAttemptNotStartedSuccess,
  RecordLeafAttemptNotStartedFailure
>;

export type RecordLeafAttemptNotStartedDependencies = Readonly<{
  clock: TransitionStepAttemptDependencies["clock"];
  identifiers: StepEventIdentifierPort;
  persistence: TransitionStepAttemptDependencies["persistence"];
  queries: StepExecutionQueryPort;
  requiredPermission: string;
}>;

type Transition = ReturnType<typeof makeTransitionStepAttempt>;
type CommandBase = Readonly<{
  actorId: import("@kurobara/kernel").ActorId;
  attemptId: import("@kurobara/kernel").AttemptId;
  correlationId: import("@kurobara/kernel").CorrelationId;
  stepRunId: import("@kurobara/kernel").StepRunId;
  workspaceId: import("@kurobara/kernel").WorkspaceId;
}>;

const transitionFailure = (
  result: Extract<TransitionStepAttemptResult, { ok: false }>
): RecordLeafAttemptNotStartedResult =>
  fail({
    code: "transition-rejected",
    domainCode: result.error.domainCode ?? result.error.code,
    message: result.error.message,
  });

const recoverLegacyRetry = async (
  transition: Transition,
  base: CommandBase,
  startKey: string,
  stepRun: StepRun,
  replayed: boolean
): Promise<RecordLeafAttemptNotStartedResult> => {
  if (stepRun.state !== "retryable") {
    return succeed({ replayed, stepRun });
  }
  const authorized = await transition({
    ...base,
    commandIdempotencyKey: idempotencyKey(`leaf:${startKey}:authorize-retry`),
    expectedAggregateVersion: stepRun.aggregateVersion,
    type: "AuthorizeRetry",
  });
  return authorized.ok
    ? succeed({
        replayed: replayed || authorized.value.replayed,
        stepRun: authorized.value.stepRun,
      })
    : transitionFailure(authorized);
};

export const makeRecordLeafAttemptNotStarted = (
  dependencies: RecordLeafAttemptNotStartedDependencies
) => {
  const transition = makeTransitionStepAttempt({
    clock: dependencies.clock,
    identifiers: dependencies.identifiers,
    persistence: dependencies.persistence,
    requiredPermission: dependencies.requiredPermission,
  });
  return async (
    request: StartLeafAttemptRequest,
    retryable: boolean
  ): Promise<RecordLeafAttemptNotStartedResult> => {
    const scope = { workspaceId: request.workspaceId } as const;
    const context = await dependencies.queries.getContextByStepId(
      scope,
      request.stepRunId
    );
    const stepRun = context?.stepRun;
    if (
      context === undefined ||
      stepRun === undefined ||
      stepRun.runId !== request.runId
    ) {
      return fail({
        code: "step-not-found",
        message: "The rejected leaf step does not exist in this workspace.",
      });
    }
    const attempt = stepRun.attempts.find(
      (candidate) => candidate.attemptId === request.attemptId
    );
    if (attempt === undefined) {
      return fail({
        code: "attempt-not-found",
        message: "The rejected leaf execution does not identify an attempt.",
      });
    }
    const base: CommandBase = {
      actorId: context.plan.authority.subjectActorId,
      attemptId: request.attemptId,
      correlationId: correlationId(`leaf:${request.eventId}`),
      stepRunId: request.stepRunId,
      workspaceId: request.workspaceId,
    };
    if (
      attempt.state === "failed_terminal" ||
      attempt.state === "cancelled_before_effect"
    ) {
      return succeed({ replayed: true, stepRun });
    }
    if (attempt.state === "failed_retryable") {
      return recoverLegacyRetry(
        transition,
        base,
        request.startKey,
        stepRun,
        true
      );
    }
    const recorded = await transition(
      context.run.state === "cancelling"
        ? {
            ...base,
            commandIdempotencyKey: idempotencyKey(
              `leaf:${request.startKey}:cancel-before-effect`
            ),
            expectedAggregateVersion: stepRun.aggregateVersion,
            type: "CancelAttemptBeforeEffect",
          }
        : {
            ...base,
            commandIdempotencyKey: idempotencyKey(
              `leaf:${request.startKey}:not-started`
            ),
            expectedAggregateVersion: stepRun.aggregateVersion,
            retryable,
            settlement: { kind: "release" },
            type: "RecordAttemptNotStarted",
          }
    );
    return recorded.ok
      ? succeed({
          replayed: recorded.value.replayed,
          stepRun: recorded.value.stepRun,
        })
      : transitionFailure(recorded);
  };
};
