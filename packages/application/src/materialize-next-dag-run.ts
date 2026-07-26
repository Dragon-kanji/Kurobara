import {
  type Attempt,
  actorId,
  amountsEqual,
  applyRunCommand,
  type CellResult,
  type CompiledWorkflowNode,
  correlationId,
  evaluateRunConvergence,
  type Instant,
  idempotencyKey,
  isAmount,
  type ResultManifest,
  type Run,
  type RunConvergenceBlocker,
  type RunId,
  resultManifestId,
  type StepRun,
  scheduleStep,
  skipStep,
  stepRunId,
  type WorkspaceId,
} from "@kurobara/kernel";
import type {
  ClockPort,
  DagSchedulingContext,
  DagSchedulingJobOutcome,
  DagSchedulingPersistencePort,
  DagSchedulingUnitOfWork,
} from "@kurobara/ports";

import { canonicalContentHash } from "./canonical-content-hash.ts";
import type { StepEventIdentifierPort } from "./claim-step-attempt.ts";
import { projectCellResult } from "./project-cell-result.ts";

export type MaterializeNextDagRunResult =
  | Readonly<{ status: "idle" }>
  | Readonly<{
      created: readonly StepRun[];
      finalized?: Readonly<{
        manifest: ResultManifest;
        run: Run;
      }>;
      outcome: DagSchedulingJobOutcome;
      runId: RunId;
      skipped: readonly StepRun[];
      status: "processed";
      workspaceId: WorkspaceId;
    }>;

export type MaterializeNextDagRunDependencies = Readonly<{
  clock: ClockPort;
  identifiers: StepEventIdentifierPort;
  persistence: DagSchedulingPersistencePort;
}>;

export class DagSchedulingInvariantError extends Error {
  readonly code = "dag-scheduling-invariant-violated";

  constructor(message: string) {
    super(message);
    this.name = "DagSchedulingInvariantError";
  }
}

const isTerminalCellResult = (
  cellResult: CellResult
): cellResult is CellResult &
  Readonly<{ status: "failed" | "skipped" | "succeeded" }> =>
  cellResult.status === "failed" ||
  cellResult.status === "skipped" ||
  cellResult.status === "succeeded";

const assertContextIdentity = (context: DagSchedulingContext): void => {
  const { plan, run } = context;
  if (
    plan.workspaceId !== run.workspaceId ||
    plan.authority.workspaceId !== run.workspaceId ||
    plan.runPlanId !== run.runPlanId ||
    context.stepRuns.some(
      (stepRun) =>
        stepRun.workspaceId !== run.workspaceId || stepRun.runId !== run.runId
    )
  ) {
    throw new DagSchedulingInvariantError(
      "The claimed DAG scheduling context contains inconsistent identities."
    );
  }
};

const deterministicStepRunId = (
  context: DagSchedulingContext,
  nodeKey: string
) => {
  const identity = canonicalContentHash({
    nodeKey,
    planHash: context.plan.planHash,
    runId: context.run.runId,
    workspaceId: context.run.workspaceId,
  });
  return stepRunId(`step_${identity.slice("sha256:".length)}`);
};

const schedulingWindowIsOpen = (
  context: DagSchedulingContext,
  now: Instant
): boolean =>
  context.run.state === "running" &&
  now < context.plan.deadline &&
  now < context.plan.authority.deadline;

const nodeIsReady = (
  node: CompiledWorkflowNode,
  stepsByNodeKey: ReadonlyMap<string, StepRun>
): boolean =>
  !stepsByNodeKey.has(node.key) &&
  node.humanGate === undefined &&
  node.dependsOn.every(
    (dependency) => stepsByNodeKey.get(dependency)?.state === "succeeded"
  );

const blockedDependencies = (
  node: CompiledWorkflowNode,
  stepsByNodeKey: ReadonlyMap<string, StepRun>
): readonly string[] =>
  node.dependsOn.filter((dependency) => {
    const state = stepsByNodeKey.get(dependency)?.state;
    return state === "failed" || state === "skipped";
  });

type MaterializedDagNodes = Readonly<{
  created: readonly StepRun[];
  skipped: readonly StepRun[];
  stepRuns: readonly StepRun[];
}>;

type CancellationAttemptProof = Readonly<{
  attempt: Attempt;
  stepRun: StepRun;
}>;

const unresolvedCancellationAttemptStates = new Set<Attempt["state"]>([
  "ambiguous",
  "claimed",
  "in_flight",
  "prepared",
]);

const unresolvedCancellationStepStates = new Set<StepRun["state"]>([
  "active",
  "ambiguous",
  "cancelling",
]);

const cancellationAttemptProofs = (
  context: DagSchedulingContext
): readonly CancellationAttemptProof[] =>
  context.stepRuns.flatMap((stepRun) =>
    stepRun.attempts.map((attempt) => ({ attempt, stepRun }))
  );

const cancellationReservationMatchesAttempt = (
  context: DagSchedulingContext,
  proof: CancellationAttemptProof,
  reservation: DagSchedulingContext["reservations"][number]
): boolean =>
  reservation.workspaceId === context.run.workspaceId &&
  reservation.runId === context.run.runId &&
  reservation.stepRunId === proof.stepRun.stepRunId &&
  reservation.attemptId === proof.attempt.attemptId &&
  reservation.reservationId === proof.attempt.costReservationId &&
  reservation.operationKey === proof.attempt.operationKey &&
  reservation.unit === proof.attempt.reservationUnit &&
  amountsEqual(reservation.amount, proof.attempt.reservedAmount);

const cancellationSettlementReceiptIsValid = (
  reservation: DagSchedulingContext["reservations"][number]
): boolean =>
  isAmount(reservation.amount) &&
  (reservation.state !== "settled" ||
    (isAmount(reservation.releasedAmount) &&
      isAmount(reservation.settledAmount) &&
      amountsEqual(
        reservation.amount,
        reservation.releasedAmount + reservation.settledAmount
      )));

const assertCancellationLedgerProof = (
  context: DagSchedulingContext,
  proofs: readonly CancellationAttemptProof[]
): void => {
  const attemptIds = new Set(proofs.map(({ attempt }) => attempt.attemptId));
  const reservationIds = new Set(
    context.reservations.map((reservation) => reservation.reservationId)
  );
  const reservationsByAttempt = new Map(
    context.reservations.map((reservation) => [
      reservation.attemptId,
      reservation,
    ])
  );
  const identityProofIsExact =
    attemptIds.size === proofs.length &&
    reservationIds.size === context.reservations.length &&
    reservationsByAttempt.size === context.reservations.length &&
    context.reservations.length === proofs.length &&
    proofs.every(({ attempt, stepRun }) => {
      const reservation = reservationsByAttempt.get(attempt.attemptId);
      return (
        attempt.stepRunId === stepRun.stepRunId &&
        reservation !== undefined &&
        cancellationReservationMatchesAttempt(
          context,
          { attempt, stepRun },
          reservation
        ) &&
        cancellationSettlementReceiptIsValid(reservation)
      );
    });
  const reservedAmount = context.reservations.reduce(
    (total, reservation) =>
      total + (reservation.state === "reserved" ? reservation.amount : 0),
    0
  );
  const spentAmount = context.reservations.reduce(
    (total, reservation) =>
      total + (reservation.state === "settled" ? reservation.settledAmount : 0),
    context.plan.budget.spent
  );
  const costProofIsExact =
    context.cost.unit === context.plan.budget.unit &&
    context.reservations.every(
      (reservation) => reservation.unit === context.cost.unit
    ) &&
    isAmount(context.cost.reserved) &&
    isAmount(context.cost.spent) &&
    amountsEqual(context.cost.reserved, reservedAmount) &&
    amountsEqual(context.cost.spent, spentAmount);
  if (!(identityProofIsExact && costProofIsExact)) {
    throw new DagSchedulingInvariantError(
      "A cancelling run requires an exact durable attempt and cost-settlement proof."
    );
  }
};

const cancellationCanSettle = (context: DagSchedulingContext): boolean => {
  const proofs = cancellationAttemptProofs(context);
  assertCancellationLedgerProof(context, proofs);
  return (
    amountsEqual(context.cost.reserved, 0) &&
    context.reservations.every(
      (reservation) => reservation.state !== "reserved"
    ) &&
    context.stepRuns.every(
      (stepRun) =>
        stepRun.activeAttemptId === undefined &&
        !unresolvedCancellationStepStates.has(stepRun.state) &&
        stepRun.attempts.every(
          (attempt) => !unresolvedCancellationAttemptStates.has(attempt.state)
        )
    )
  );
};

const materializeReadyNodes = async (
  dependencies: MaterializeNextDagRunDependencies,
  unitOfWork: DagSchedulingUnitOfWork,
  context: DagSchedulingContext,
  now: Instant
): Promise<MaterializedDagNodes> => {
  const { plan, run } = context;
  const readyNodeAuthorizationIsOpen = schedulingWindowIsOpen(context, now);
  const scope = { workspaceId: run.workspaceId } as const;
  const created: StepRun[] = [];
  const skipped: StepRun[] = [];
  const stepsByNodeKey = new Map(
    context.stepRuns.map((stepRun) => [stepRun.nodeKey, stepRun])
  );
  for (const node of plan.compiledWorkflow.nodes) {
    if (stepsByNodeKey.has(node.key)) {
      continue;
    }
    const blockedByNodeKeys = blockedDependencies(node, stepsByNodeKey);
    if (blockedByNodeKeys.length > 0) {
      const decision = skipStep({
        actorId: actorId("system:dag-scheduler"),
        blockedByNodeKeys,
        correlationId: correlationId(`dag-schedule:${run.runId}`),
        createdAt: now,
        dependsOn: node.dependsOn,
        eventId: await dependencies.identifiers.nextEventId(),
        nodeKey: node.key,
        runId: run.runId,
        runState: run.state,
        stepRunId: deterministicStepRunId(context, node.key),
        workspaceId: run.workspaceId,
      });
      if (!decision.ok) {
        throw new DagSchedulingInvariantError(decision.error.message);
      }
      await unitOfWork.steps.insertSkipped(
        scope,
        decision.value.stepRun,
        decision.value.event
      );
      stepsByNodeKey.set(node.key, decision.value.stepRun);
      skipped.push(decision.value.stepRun);
      continue;
    }
    if (!readyNodeAuthorizationIsOpen) {
      continue;
    }
    if (!nodeIsReady(node, stepsByNodeKey)) {
      continue;
    }
    const decision = scheduleStep({
      actorId: actorId("system:dag-scheduler"),
      correlationId: correlationId(`dag-schedule:${run.runId}`),
      createdAt: now,
      dependsOn: node.dependsOn,
      eventId: await dependencies.identifiers.nextEventId(),
      nodeKey: node.key,
      runId: run.runId,
      runState: run.state,
      satisfiedDependencies: node.dependsOn,
      stepRunId: deterministicStepRunId(context, node.key),
      workspaceId: run.workspaceId,
    });
    if (!decision.ok) {
      throw new DagSchedulingInvariantError(decision.error.message);
    }
    if (decision.value.event.eventType !== "StepReady") {
      throw new DagSchedulingInvariantError(
        "ScheduleStep returned an unexpected lifecycle event."
      );
    }
    await unitOfWork.steps.insertReady(
      scope,
      decision.value.stepRun,
      decision.value.event
    );
    await unitOfWork.routing.request(scope, decision.value.stepRun.stepRunId);
    stepsByNodeKey.set(node.key, decision.value.stepRun);
    created.push(decision.value.stepRun);
  }
  return {
    created,
    skipped,
    stepRuns: [...stepsByNodeKey.values()],
  };
};

const finalizeRun = async (
  dependencies: MaterializeNextDagRunDependencies,
  unitOfWork: DagSchedulingUnitOfWork,
  context: DagSchedulingContext,
  stepRuns: readonly StepRun[],
  now: Instant
): Promise<
  | Readonly<{ reason: RunConvergenceBlocker; status: "not-ready" }>
  | Readonly<{
      finalized: Readonly<{ manifest: ResultManifest; run: Run }>;
      status: "completed" | "failed";
    }>
> => {
  const convergence = evaluateRunConvergence({
    artifacts: context.artifacts,
    cost: context.cost,
    createdAt: now,
    plan: context.plan,
    reservations: context.reservations,
    run: context.run,
    stepRuns,
  });
  if (!convergence.ok) {
    throw new DagSchedulingInvariantError(convergence.error.message);
  }
  if (convergence.value.status === "not-ready") {
    return convergence.value;
  }
  const scope = { workspaceId: context.run.workspaceId } as const;
  const existing = await unitOfWork.manifests.findByRun(
    scope,
    context.run.runId
  );
  if (existing !== undefined) {
    throw new DagSchedulingInvariantError(
      "A running run already has a durable result manifest."
    );
  }
  const manifestHash = canonicalContentHash(convergence.value.manifestBody);
  const manifest: ResultManifest = {
    ...convergence.value.manifestBody,
    manifestHash,
    resultManifestId: resultManifestId(
      `manifest_${manifestHash.slice("sha256:".length)}`
    ),
  };
  const commandType =
    convergence.value.status === "completed" ? "CompleteRun" : "FailRun";
  const identity = {
    commandHash: canonicalContentHash({
      manifestHash,
      runId: context.run.runId,
      type: commandType,
    }),
    idempotencyKey: idempotencyKey(
      `converge-run:${context.run.runId}:${context.plan.planHash}`
    ),
  } as const;
  const commandActorId = actorId("system:dag-scheduler");
  const commandCorrelationId = correlationId(
    `dag-converge:${context.run.runId}`
  );
  const transition = applyRunCommand(
    context.run,
    { manifest, type: commandType },
    {
      actorId: commandActorId,
      commandIdentity: identity,
      correlationId: commandCorrelationId,
      eventIds: [
        await dependencies.identifiers.nextEventId(),
        await dependencies.identifiers.nextEventId(),
      ],
      expectedAggregateVersion: context.run.aggregateVersion,
      occurredAt: now,
    }
  );
  if (!transition.ok) {
    throw new DagSchedulingInvariantError(transition.error.message);
  }
  await unitOfWork.manifests.insert(scope, manifest);
  await unitOfWork.runs.update(
    scope,
    context.run.aggregateVersion,
    transition.value.run
  );
  for (const event of transition.value.events) {
    await unitOfWork.runEvents.append(scope, event);
  }
  await unitOfWork.commandJournal.insert(
    scope,
    {
      commandType,
      identity,
      runId: context.run.runId,
      workspaceId: context.run.workspaceId,
    },
    commandActorId,
    commandCorrelationId
  );
  if (context.recipeCell !== undefined) {
    if (unitOfWork.cellResults === undefined) {
      throw new DagSchedulingInvariantError(
        "A recipe-cell run requires atomic CellResult convergence persistence."
      );
    }
    const output = manifest.output;
    const artifactPayload =
      output.status === "accepted"
        ? context.artifactPayloads?.find(
            (candidate) =>
              candidate.artifactId === output.artifact.artifactId &&
              candidate.contentHash === output.artifact.contentHash
          )
        : undefined;
    const projection = projectCellResult({
      current: context.recipeCell.current,
      dataset: context.recipeCell.dataset,
      fields: context.recipeCell.fields,
      manifest,
      ...(artifactPayload === undefined
        ? {}
        : { normalizedSinkPayload: artifactPayload.value }),
      recipe: context.recipeCell.recipe,
      record: context.recipeCell.record,
      run: transition.value.run,
    });
    if (!projection.ok) {
      throw new DagSchedulingInvariantError(projection.error.message);
    }
    const cellResult = projection.value.cellResult;
    if (!isTerminalCellResult(cellResult)) {
      throw new DagSchedulingInvariantError(
        "A terminal recipe-cell run projected a non-terminal CellResult."
      );
    }
    await unitOfWork.cellResults.finalize(scope, {
      ...(output.status === "accepted" ? { artifact: output.artifact } : {}),
      cellResult,
      manifest: {
        manifestHash: manifest.manifestHash,
        resultManifestId: manifest.resultManifestId,
      },
      sourceRunAggregateVersion: transition.value.run.aggregateVersion,
    });
  }
  return {
    finalized: { manifest, run: transition.value.run },
    status: convergence.value.status,
  };
};

const isTerminalRun = (run: Run): boolean =>
  run.state === "cancelled" ||
  run.state === "completed" ||
  run.state === "failed";

const assertTerminalRunManifest = async (
  unitOfWork: DagSchedulingUnitOfWork,
  context: DagSchedulingContext
): Promise<void> => {
  const { run } = context;
  if (run.state !== "failed" && run.state !== "completed") {
    return;
  }
  const scope = { workspaceId: run.workspaceId } as const;
  const manifest = await unitOfWork.manifests.findByRun(scope, run.runId);
  if (
    run.resultManifest === undefined ||
    manifest === undefined ||
    manifest.workspaceId !== run.workspaceId ||
    manifest.runId !== run.runId ||
    manifest.runPlanId !== run.runPlanId ||
    manifest.conclusion !== run.state ||
    manifest.resultCompleteness !== run.resultCompleteness ||
    manifest.sourceRunAggregateVersion + 1 !== run.aggregateVersion ||
    manifest.resultManifestId !== run.resultManifest.resultManifestId ||
    manifest.manifestHash !== run.resultManifest.manifestHash
  ) {
    throw new DagSchedulingInvariantError(
      "A stale terminal-run wake-up requires its identity-matching durable result manifest."
    );
  }
};

const finalizeCancelledRecipeCell = async (
  unitOfWork: DagSchedulingUnitOfWork,
  context: DagSchedulingContext
): Promise<void> => {
  if (context.run.state !== "cancelled" || context.recipeCell === undefined) {
    return;
  }
  if (unitOfWork.cellResults === undefined) {
    throw new DagSchedulingInvariantError(
      "A cancelled recipe-cell run requires atomic CellResult convergence persistence."
    );
  }
  const projection = projectCellResult({
    current: context.recipeCell.current,
    dataset: context.recipeCell.dataset,
    fields: context.recipeCell.fields,
    recipe: context.recipeCell.recipe,
    record: context.recipeCell.record,
    run: context.run,
  });
  if (!projection.ok) {
    throw new DagSchedulingInvariantError(projection.error.message);
  }
  const cellResult = projection.value.cellResult;
  if (cellResult.status !== "skipped") {
    throw new DagSchedulingInvariantError(
      "A cancelled recipe-cell run must project a skipped CellResult."
    );
  }
  await unitOfWork.cellResults.finalize(
    { workspaceId: context.run.workspaceId },
    {
      cellResult: { ...cellResult, status: "skipped" },
      sourceRunAggregateVersion: context.run.aggregateVersion,
    }
  );
};

const settleCancellation = async (
  dependencies: MaterializeNextDagRunDependencies,
  unitOfWork: DagSchedulingUnitOfWork,
  context: DagSchedulingContext,
  now: Instant
): Promise<Run> => {
  const { run } = context;
  const commandType = "SettleCancellation";
  const identity = {
    commandHash: canonicalContentHash({
      runId: run.runId,
      type: commandType,
    }),
    idempotencyKey: idempotencyKey(
      `settle-cancellation:${run.runId}:${context.plan.planHash}`
    ),
  } as const;
  const commandActorId = actorId("system:dag-scheduler");
  const commandCorrelationId = correlationId(`dag-cancel:${context.run.runId}`);
  const transition = applyRunCommand(
    run,
    { type: commandType },
    {
      actorId: commandActorId,
      commandIdentity: identity,
      correlationId: commandCorrelationId,
      eventIds: [await dependencies.identifiers.nextEventId()],
      expectedAggregateVersion: run.aggregateVersion,
      occurredAt: now,
    }
  );
  if (!transition.ok) {
    throw new DagSchedulingInvariantError(transition.error.message);
  }
  const scope = { workspaceId: run.workspaceId } as const;
  await unitOfWork.runs.update(
    scope,
    run.aggregateVersion,
    transition.value.run
  );
  for (const event of transition.value.events) {
    await unitOfWork.runEvents.append(scope, event);
  }
  await unitOfWork.commandJournal.insert(
    scope,
    {
      commandType,
      identity,
      runId: run.runId,
      workspaceId: run.workspaceId,
    },
    commandActorId,
    commandCorrelationId
  );
  await finalizeCancelledRecipeCell(unitOfWork, {
    ...context,
    run: transition.value.run,
  });
  return transition.value.run;
};

const classifyJobOutcome = (
  convergence: Awaited<ReturnType<typeof finalizeRun>>,
  materialized: MaterializedDagNodes,
  readyNodeAuthorizationIsOpen: boolean
): DagSchedulingJobOutcome => {
  if (convergence.status === "failed") {
    return { status: "failure-finalized" };
  }
  if (convergence.status === "completed") {
    return { status: "success-finalized" };
  }
  const blocked = convergence as Extract<
    Awaited<ReturnType<typeof finalizeRun>>,
    { status: "not-ready" }
  >;
  if (materialized.created.length > 0 || materialized.skipped.length > 0) {
    return { status: "steps-materialized" };
  }
  if (
    !readyNodeAuthorizationIsOpen &&
    blocked.reason === "step-coverage-incomplete"
  ) {
    return { status: "waiting" };
  }
  return { reason: blocked.reason, status: "blocked" };
};

export const makeMaterializeNextDagRun =
  (dependencies: MaterializeNextDagRunDependencies) =>
  (): Promise<MaterializeNextDagRunResult> =>
    dependencies.persistence.transactionForSystem(async (unitOfWork) => {
      const context = await unitOfWork.jobs.claimNextForUpdate();
      if (context === undefined) {
        return { status: "idle" };
      }
      assertContextIdentity(context);

      const { run } = context;
      const scope = { workspaceId: run.workspaceId } as const;
      const now = await dependencies.clock.now();
      if (isTerminalRun(run)) {
        await assertTerminalRunManifest(unitOfWork, context);
        await finalizeCancelledRecipeCell(unitOfWork, context);
        const outcome = { status: "stale-terminal" } as const;
        await unitOfWork.jobs.complete(scope, run.runId, outcome);
        return {
          created: [],
          outcome,
          runId: run.runId,
          skipped: [],
          status: "processed",
          workspaceId: run.workspaceId,
        };
      }
      if (run.state === "cancelling") {
        if (cancellationCanSettle(context)) {
          await settleCancellation(dependencies, unitOfWork, context, now);
          const outcome = { status: "stale-terminal" } as const;
          await unitOfWork.jobs.complete(scope, run.runId, outcome);
          return {
            created: [],
            outcome,
            runId: run.runId,
            skipped: [],
            status: "processed",
            workspaceId: run.workspaceId,
          };
        }
        const outcome = { status: "waiting" } as const;
        await unitOfWork.jobs.complete(scope, run.runId, outcome);
        return {
          created: [],
          outcome,
          runId: run.runId,
          skipped: [],
          status: "processed",
          workspaceId: run.workspaceId,
        };
      }
      if (run.state !== "running") {
        const outcome = { status: "waiting" } as const;
        await unitOfWork.jobs.complete(scope, run.runId, outcome);
        return {
          created: [],
          outcome,
          runId: run.runId,
          skipped: [],
          status: "processed",
          workspaceId: run.workspaceId,
        };
      }
      const materialized = await materializeReadyNodes(
        dependencies,
        unitOfWork,
        context,
        now
      );
      const convergence = await finalizeRun(
        dependencies,
        unitOfWork,
        context,
        materialized.stepRuns,
        now
      );
      const outcome = classifyJobOutcome(
        convergence,
        materialized,
        schedulingWindowIsOpen(context, now)
      );

      await unitOfWork.jobs.complete(scope, run.runId, outcome);
      return {
        created: materialized.created,
        ...(convergence.status === "failed" ||
        convergence.status === "completed"
          ? { finalized: convergence.finalized }
          : {}),
        outcome,
        runId: run.runId,
        skipped: materialized.skipped,
        status: "processed",
        workspaceId: run.workspaceId,
      };
    });
