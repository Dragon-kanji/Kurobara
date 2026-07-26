import {
  actorId,
  applyStepCommand,
  attemptId,
  correlationId,
  costReservationId,
  eventId,
  idempotencyKey,
  operationKey,
  outboxMessageId,
  type RunPlanRouteSnapshot,
  type StepCommandIdentity,
  type StepRun,
} from "@kurobara/kernel";
import type {
  ClockPort,
  StepRoutingContext,
  StepRoutingPersistencePort,
  StepRoutingUnitOfWork,
  WorkspaceScope,
} from "@kurobara/ports";

import { canonicalContentHash } from "./canonical-content-hash.ts";
import {
  type ClaimStepAttemptResult,
  claimStepAttemptInUnitOfWork,
} from "./claim-step-attempt.ts";

const SYSTEM_ACTOR = actorId("system:step-router");

export type RouteAndClaimNextReadyStepResult =
  | Readonly<{ status: "idle" }>
  | Readonly<{
      result: ClaimStepAttemptResult;
      status: "claimed";
      stepRunId: StepRun["stepRunId"];
    }>
  | Readonly<{
      reason: "no-route-available";
      status: "rejected";
      stepRun: StepRun;
    }>
  | Readonly<{
      reason: string;
      status: "deferred";
      stepRunId: StepRun["stepRunId"];
    }>
  | Readonly<{
      status: "stale";
      stepRunId: StepRun["stepRunId"];
    }>;

export type RouteAndClaimNextReadyStepDependencies = Readonly<{
  availableEffectAdapterKeys: readonly string[];
  clock: ClockPort;
  persistence: StepRoutingPersistencePort;
  requiredPermission: string;
  retryDelayMilliseconds: number;
}>;

export class StepRoutingInvariantError extends Error {
  readonly code = "step-routing-invariant-violated";

  constructor(message: string) {
    super(message);
    this.name = "StepRoutingInvariantError";
  }
}

const assertContext = (context: StepRoutingContext): void => {
  if (
    context.plan.workspaceId !== context.run.workspaceId ||
    context.plan.runPlanId !== context.run.runPlanId ||
    context.stepRun.workspaceId !== context.run.workspaceId ||
    context.stepRun.runId !== context.run.runId ||
    !context.plan.compiledWorkflow.nodes.some(
      (node) => node.key === context.stepRun.nodeKey
    )
  ) {
    throw new StepRoutingInvariantError(
      "The routing job context contains inconsistent durable identities."
    );
  }
};

const stableHex = (value: unknown): string =>
  canonicalContentHash(value).slice("sha256:".length);

const stableIdentity = (
  context: StepRoutingContext,
  candidate: RunPlanRouteSnapshot
) => {
  const attemptNumber = context.stepRun.attempts.length + 1;
  const base = {
    attemptNumber,
    planHash: context.plan.planHash,
    routeKey: candidate.routeKey,
    runId: context.run.runId,
    stepRunId: context.stepRun.stepRunId,
    workspaceId: context.run.workspaceId,
  };
  const firstOperation = context.stepRun.attempts[0]?.operationKey;
  return {
    attemptId: attemptId(`attempt_${stableHex({ ...base, kind: "attempt" })}`),
    commandIdempotencyKey: idempotencyKey(
      `route-claim:${stableHex({ ...base, kind: "command" })}`
    ),
    costReservationId: costReservationId(
      `reservation_${stableHex({ ...base, kind: "reservation" })}`
    ),
    operationKey:
      firstOperation ??
      operationKey(
        `operation_${stableHex({
          planHash: context.plan.planHash,
          runId: context.run.runId,
          stepRunId: context.stepRun.stepRunId,
          workspaceId: context.run.workspaceId,
        })}`
      ),
    outboxMessageId: outboxMessageId(
      `outbox_${stableHex({ ...base, kind: "outbox" })}`
    ),
  };
};

const plannedRoutes = (
  context: StepRoutingContext
): readonly RunPlanRouteSnapshot[] =>
  (context.plan.routeSnapshots ?? []).filter(
    (candidate) => candidate.nodeKey === context.stepRun.nodeKey
  );

const nextAvailableRoute = (
  context: StepRoutingContext,
  routes: readonly RunPlanRouteSnapshot[],
  available: ReadonlySet<string>
): RunPlanRouteSnapshot | undefined => {
  const availableRoutes = routes.filter((entry) =>
    available.has(entry.effectAdapterKey)
  );
  const attemptedRouteKeys = new Set(
    context.stepRun.attempts.map((attempt) => attempt.routeKey)
  );
  return (
    availableRoutes.find((entry) => !attemptedRouteKeys.has(entry.routeKey)) ??
    availableRoutes[0]
  );
};

const routingReason = (
  context: StepRoutingContext,
  candidate: RunPlanRouteSnapshot
): "fallback" | "initial" | "retry" => {
  const previousAttempt = context.stepRun.attempts.at(-1);
  if (previousAttempt === undefined) {
    return "initial";
  }
  return previousAttempt.routeKey === candidate.routeKey ? "retry" : "fallback";
};

const rejectNoRoute = async (
  unitOfWork: StepRoutingUnitOfWork,
  scope: WorkspaceScope,
  context: StepRoutingContext,
  now: Awaited<ReturnType<ClockPort["now"]>>
): Promise<
  Extract<RouteAndClaimNextReadyStepResult, { status: "rejected" }>
> => {
  const identity: StepCommandIdentity = {
    commandHash: canonicalContentHash({
      reason: "no-route-available",
      stepRunId: context.stepRun.stepRunId,
      type: "RejectStepRouting",
    }),
    idempotencyKey: idempotencyKey(
      `route-reject:${context.run.runId}:${context.stepRun.stepRunId}`
    ),
  };
  const transition = applyStepCommand(
    context.stepRun,
    { reason: "no-route-available", type: "RejectStepRouting" },
    {
      actorId: SYSTEM_ACTOR,
      commandIdentity: identity,
      correlationId: correlationId(`route:${context.run.runId}`),
      eventIds: [
        eventId(
          `event_${stableHex({
            identity,
            kind: "routing-rejected",
            stepRunId: context.stepRun.stepRunId,
          })}`
        ),
      ],
      expectedAggregateVersion: context.stepRun.aggregateVersion,
      occurredAt: now,
    }
  );
  if (!transition.ok) {
    throw new StepRoutingInvariantError(transition.error.message);
  }
  await unitOfWork.steps.update(
    scope,
    context.stepRun.aggregateVersion,
    transition.value.stepRun
  );
  for (const event of transition.value.events) {
    await unitOfWork.stepEvents.append(scope, event);
  }
  await unitOfWork.commandJournal.insert(
    scope,
    {
      actorId: SYSTEM_ACTOR,
      commandType: "RejectStepRouting",
      identity,
      stepRunId: context.stepRun.stepRunId,
      workspaceId: context.run.workspaceId,
    },
    SYSTEM_ACTOR,
    correlationId(`route:${context.run.runId}`)
  );
  await unitOfWork.dagSchedule.request(scope, context.run.runId);
  await unitOfWork.routingJobs.complete(scope, context.stepRun.stepRunId);
  return {
    reason: "no-route-available",
    status: "rejected",
    stepRun: transition.value.stepRun,
  };
};

const routeClaimedContext = async (
  dependencies: RouteAndClaimNextReadyStepDependencies,
  available: ReadonlySet<string>,
  unitOfWork: StepRoutingUnitOfWork,
  context: StepRoutingContext
): Promise<RouteAndClaimNextReadyStepResult> => {
  assertContext(context);
  const scope = { workspaceId: context.run.workspaceId } as const;
  if (context.run.state !== "running" || context.stepRun.state !== "ready") {
    await unitOfWork.routingJobs.complete(scope, context.stepRun.stepRunId);
    return { status: "stale", stepRunId: context.stepRun.stepRunId };
  }
  const now = await dependencies.clock.now();
  const routes = plannedRoutes(context);
  if (routes.length === 0) {
    return rejectNoRoute(unitOfWork, scope, context, now);
  }
  const candidate = nextAvailableRoute(context, routes, available);
  if (candidate === undefined) {
    await unitOfWork.routingJobs.defer(
      scope,
      context.stepRun.stepRunId,
      "effect-adapter-unavailable",
      dependencies.retryDelayMilliseconds
    );
    return {
      reason: "effect-adapter-unavailable",
      status: "deferred",
      stepRunId: context.stepRun.stepRunId,
    };
  }
  const stable = stableIdentity(context, candidate);
  const input = {
    actorId: context.plan.authority.subjectActorId,
    attemptId: stable.attemptId,
    commandIdempotencyKey: stable.commandIdempotencyKey,
    correlationId: correlationId(`route:${context.run.runId}`),
    costReservationId: stable.costReservationId,
    expectedAggregateVersion: context.stepRun.aggregateVersion,
    nodeKey: context.stepRun.nodeKey,
    operationKey: stable.operationKey,
    reason: routingReason(context, candidate),
    routeKey: candidate.routeKey,
    runId: context.run.runId,
    stepRunId: context.stepRun.stepRunId,
    workspaceId: context.run.workspaceId,
  } as const;
  let nextEventIndex = 0;
  const result = await claimStepAttemptInUnitOfWork(
    unitOfWork,
    scope,
    input,
    {
      clock: { now: async () => now },
      identifiers: {
        nextEventId: async () =>
          eventId(
            `event_${stableHex({
              index: ++nextEventIndex,
              kind: "route-claim-event",
              stable,
              stepRunId: context.stepRun.stepRunId,
            })}`
          ),
        nextOutboxMessageId: async () => stable.outboxMessageId,
      },
      requiredPermission: dependencies.requiredPermission,
    },
    {
      authoritySubjectActorId: context.plan.authority.subjectActorId,
      technicalActorId: SYSTEM_ACTOR,
    }
  );
  if (result.ok) {
    await unitOfWork.routingJobs.complete(scope, context.stepRun.stepRunId);
  } else {
    await unitOfWork.routingJobs.defer(
      scope,
      context.stepRun.stepRunId,
      result.error.code,
      dependencies.retryDelayMilliseconds
    );
    return {
      reason: result.error.code,
      status: "deferred",
      stepRunId: context.stepRun.stepRunId,
    };
  }
  return {
    result,
    status: "claimed",
    stepRunId: context.stepRun.stepRunId,
  };
};

export const makeRouteAndClaimNextReadyStep = (
  dependencies: RouteAndClaimNextReadyStepDependencies
) => {
  const available = new Set(
    dependencies.availableEffectAdapterKeys.map((key) => key.trim())
  );
  if (available.has("")) {
    throw new RangeError("Available effect adapter keys must not be empty.");
  }
  if (
    !(
      Number.isSafeInteger(dependencies.retryDelayMilliseconds) &&
      dependencies.retryDelayMilliseconds > 0
    )
  ) {
    throw new RangeError("retryDelayMilliseconds must be a positive integer.");
  }
  return (): Promise<RouteAndClaimNextReadyStepResult> =>
    dependencies.persistence.transactionForSystem(async (unitOfWork) => {
      const context = await unitOfWork.routingJobs.claimNextForUpdate([
        ...available,
      ]);
      if (context === undefined) {
        return { status: "idle" };
      }
      return routeClaimedContext(dependencies, available, unitOfWork, context);
    });
};
