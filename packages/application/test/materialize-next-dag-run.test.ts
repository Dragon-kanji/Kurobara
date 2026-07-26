import assert from "node:assert/strict";
import test from "node:test";

import {
  type Attempt,
  actorId,
  artifactId,
  attemptId,
  type CostReservation,
  capabilityId,
  cellResultId,
  contentHash,
  costReservationId,
  type Dataset,
  type Record as DatasetRecord,
  datasetId,
  type EnrichmentRecipe,
  enrichmentRecipeId,
  eventId,
  type Field,
  fieldId,
  idempotencyKey,
  instant,
  operationKey,
  type ResultManifest,
  type Run,
  type RunCommandReplayProof,
  type RunLifecycleEvent,
  type RunPlan,
  recordId,
  routingDecisionId,
  runId,
  runPlanId,
  type StepRun,
  stepRunId,
  workflowSpecId,
  workspaceId,
} from "@kurobara/kernel";
import type {
  DagCellResultFinalization,
  DagSchedulingContext,
  DagSchedulingJobOutcome,
  DagSchedulingPersistencePort,
  DagSchedulingUnitOfWork,
} from "@kurobara/ports";

import { canonicalContentHash } from "../src/canonical-content-hash.ts";
import {
  DagSchedulingInvariantError,
  makeMaterializeNextDagRun,
} from "../src/index.ts";

const hash = (character: string) =>
  contentHash(`sha256:${character.repeat(64)}`);
const workspace = workspaceId("workspace-dag-materializer");
const capability = {
  capabilityId: capabilityId("documents.summarize"),
  capabilityVersion: "1.0.0",
};
const OPAQUE_STEP_RUN_ID = /^step_[a-f0-9]{64}$/u;

type Node = RunPlan["compiledWorkflow"]["nodes"][number];

const node = (
  key: string,
  dependsOn: readonly string[] = [],
  humanGate?: string
): Node => ({
  capability,
  dependsOn,
  depth: dependsOn.length === 0 ? 0 : 1,
  ...(humanGate === undefined ? {} : { humanGate }),
  key,
});

const plan = (nodes: readonly Node[]): RunPlan => ({
  authority: {
    authorityEnvelopeId: "authority-dag-materializer",
    budgetLimit: { limit: 10, reserved: 0, spent: 0, unit: "credits" },
    capabilities: [capability],
    deadline: instant(10_000),
    permissions: ["steps:execute"],
    subjectActorId: actorId("agent-dag-materializer"),
    version: "1.0.0",
    workspaceId: workspace,
  },
  budget: { limit: 10, reserved: 0, spent: 0, unit: "credits" },
  catalogFingerprint: hash("b"),
  catalogVersion: "1.0.0",
  compiledWorkflow: {
    compilerVersion: "1.0.0",
    fingerprint: nodes.map((entry) => entry.key).join("|"),
    nodes,
    workflowContentHash: hash("c"),
    workflowRevision: "1.0.0",
    workflowSpecId: workflowSpecId("workflow-dag-materializer"),
  },
  deadline: instant(9000),
  inputContract: {
    catalogFingerprint: hash("b"),
    catalogVersion: "1.0.0",
    schemaFingerprint: hash("d"),
    schemaId: "https://schemas.kurobara.invalid/input/1.0.0",
    schemaVersion: "1.0.0",
  },
  normalizedInputHash: hash("e"),
  outputContract: {
    catalogFingerprint: hash("b"),
    catalogVersion: "1.0.0",
    schemaFingerprint: hash("f"),
    schemaId: "https://schemas.kurobara.invalid/output/1.0.0",
    schemaVersion: "1.0.0",
  },
  planHash: hash("1"),
  policyFactsHash: hash("2"),
  policyVersion: "1.0.0",
  quote: {
    expiresAt: instant(8000),
    guarantee: "hard",
    pricingVersion: "1.0.0",
    quoteId: "quote-dag-materializer",
    unit: "credits",
    upperBound: 10,
  },
  retryPolicy: { maxAttemptsPerStep: 3 },
  runPlanId: runPlanId("plan-dag-materializer"),
  workspaceId: workspace,
});

const runningRun = (state: Run["state"] = "running"): Run => ({
  aggregateVersion: 2,
  createdAt: instant(1000),
  eventSequence: 2,
  idempotencyKey: idempotencyKey("create-dag-materializer"),
  intentionHash: hash("1"),
  resultCompleteness: "none",
  runId: runId("run-dag-materializer"),
  runPlanId: runPlanId("plan-dag-materializer"),
  state,
  workspaceId: workspace,
});

const storedStep = (
  run: Run,
  nodeKey: string,
  state: StepRun["state"],
  dependsOn: readonly string[] = []
): StepRun => {
  const storedStepRunId = stepRunId(`existing-${nodeKey}`);
  const terminalAttempt = {
    attemptId: attemptId(`attempt-${nodeKey}`),
    attemptNumber: 1,
    authorityEnvelopeId: "authority-dag-materializer",
    claimedAt: instant(1100),
    costReservationId: costReservationId(`reservation-${nodeKey}`),
    effectAdapterKey: "adapter.test",
    effectStartedAt: instant(1200),
    finishedAt: instant(1300),
    operationKey: operationKey(`operation-${nodeKey}`),
    preparedAt: instant(1000),
    reason: "initial" as const,
    reservationUnit: "credits",
    reservedAmount: 0,
    routeKey: "route.test",
    routeSnapshotHash: hash("9"),
    routingDecisionId: routingDecisionId(`routing-${nodeKey}`),
    state: "succeeded" as const,
    stepRunId: storedStepRunId,
  };
  const activeAttempt = {
    ...terminalAttempt,
    state: "claimed" as const,
  };
  let attempts: StepRun["attempts"] = [];
  if (state === "succeeded") {
    attempts = [terminalAttempt];
  } else if (state === "active") {
    attempts = [activeAttempt];
  }
  return {
    ...(state === "active" ? { activeAttemptId: activeAttempt.attemptId } : {}),
    aggregateVersion: 1,
    attempts,
    createdAt: instant(1000),
    dependsOn,
    eventSequence: 1,
    nodeKey,
    runId: run.runId,
    state,
    stepRunId: storedStepRunId,
    workspaceId: run.workspaceId,
  };
};

const unresolvedStep = (
  run: Run,
  state: Extract<
    Attempt["state"],
    "ambiguous" | "claimed" | "in_flight" | "prepared"
  >
): StepRun => {
  const storedStepRunId = stepRunId(`unresolved-${state}`);
  const attempt: Attempt = {
    attemptId: attemptId(`attempt-unresolved-${state}`),
    attemptNumber: 1,
    authorityEnvelopeId: "authority-dag-materializer",
    claimedAt: instant(1100),
    costReservationId: costReservationId(`reservation-unresolved-${state}`),
    effectAdapterKey: "adapter.test",
    ...(state === "in_flight" || state === "ambiguous"
      ? { effectStartedAt: instant(1200) }
      : {}),
    ...(state === "ambiguous" ? { ambiguityObservedAt: instant(1250) } : {}),
    operationKey: operationKey(`operation-unresolved-${state}`),
    preparedAt: instant(1000),
    reason: "initial",
    reservationUnit: "credits",
    reservedAmount: 1,
    routeKey: "route.test",
    routeSnapshotHash: hash("9"),
    routingDecisionId: routingDecisionId(`routing-unresolved-${state}`),
    state,
    stepRunId: storedStepRunId,
  };
  return {
    activeAttemptId: attempt.attemptId,
    aggregateVersion: 1,
    attempts: [attempt],
    createdAt: instant(1000),
    dependsOn: [],
    eventSequence: 1,
    nodeKey: "root",
    runId: run.runId,
    state: state === "ambiguous" ? "ambiguous" : "active",
    stepRunId: storedStepRunId,
    workspaceId: run.workspaceId,
  };
};

class FakeDagSchedulingPersistence implements DagSchedulingPersistencePort {
  cellFinalizations: DagCellResultFinalization[] = [];
  completed: Run["runId"][] = [];
  completionOutcomes: DagSchedulingJobOutcome[] = [];
  commandProofs: RunCommandReplayProof[] = [];
  context: DagSchedulingContext | undefined;
  inserted: Array<{
    event: import("@kurobara/kernel").StepLifecycleEvent;
    stepRun: StepRun;
  }> = [];
  manifests: ResultManifest[] = [];
  routingRequested: StepRun["stepRunId"][] = [];
  runEvents: RunLifecycleEvent[] = [];
  updatedRuns: Run[] = [];

  constructor(context?: DagSchedulingContext) {
    this.context = context;
  }

  transactionForSystem<Value>(
    work: (unitOfWork: DagSchedulingUnitOfWork) => Promise<Value>
  ): Promise<Value> {
    const unitOfWork: DagSchedulingUnitOfWork = {
      cellResults: {
        finalize: (_scope, finalization) => {
          this.cellFinalizations.push(finalization);
          return Promise.resolve();
        },
      },
      commandJournal: {
        insert: (_scope, proof) => {
          this.commandProofs.push(proof);
          return Promise.resolve();
        },
      },
      jobs: {
        claimNextForUpdate: async () => this.context,
        complete: (_scope, requestedRunId, outcome) => {
          this.completed.push(requestedRunId);
          this.completionOutcomes.push(outcome);
          this.context = undefined;
          return Promise.resolve();
        },
      },
      manifests: {
        findByRun: async (_scope, requestedRunId) =>
          this.manifests.find((entry) => entry.runId === requestedRunId),
        insert: (_scope, manifest) => {
          this.manifests.push(manifest);
          return Promise.resolve();
        },
      },
      routing: {
        request: (_scope, requestedStepRunId) => {
          this.routingRequested.push(requestedStepRunId);
          return Promise.resolve();
        },
      },
      runEvents: {
        append: (_scope, event) => {
          this.runEvents.push(event);
          return Promise.resolve();
        },
      },
      runs: {
        update: (_scope, _expectedAggregateVersion, run) => {
          this.updatedRuns.push(run);
          return Promise.resolve();
        },
      },
      steps: {
        insertReady: (_scope, stepRun, event) => {
          this.inserted.push({ event, stepRun });
          return Promise.resolve();
        },
        insertSkipped: (_scope, stepRun, event) => {
          this.inserted.push({ event, stepRun });
          return Promise.resolve();
        },
      },
    };
    return work(unitOfWork);
  }
}

const context = (
  nodes: readonly Node[],
  stepRuns: readonly StepRun[] = [],
  run: Run = runningRun()
): DagSchedulingContext => {
  const reservations: CostReservation[] = stepRuns.flatMap((stepRun) =>
    stepRun.attempts.map((attempt) =>
      attempt.state === "claimed"
        ? {
            amount: attempt.reservedAmount,
            attemptId: attempt.attemptId,
            createdAt: attempt.preparedAt,
            operationKey: attempt.operationKey,
            reservationId: attempt.costReservationId,
            runId: run.runId,
            state: "reserved" as const,
            stepRunId: stepRun.stepRunId,
            unit: attempt.reservationUnit,
            workspaceId: run.workspaceId,
          }
        : {
            amount: attempt.reservedAmount,
            attemptId: attempt.attemptId,
            createdAt: attempt.preparedAt,
            operationKey: attempt.operationKey,
            releasedAt: attempt.finishedAt ?? instant(1300),
            reservationId: attempt.costReservationId,
            runId: run.runId,
            state: "released" as const,
            stepRunId: stepRun.stepRunId,
            unit: attempt.reservationUnit,
            workspaceId: run.workspaceId,
          }
    )
  );
  return {
    artifacts: [],
    cost: {
      reserved: reservations.reduce(
        (total, reservation) =>
          total + (reservation.state === "reserved" ? reservation.amount : 0),
        0
      ),
      spent: 0,
      unit: "credits",
    },
    plan: plan(nodes),
    reservations,
    run,
    stepRuns,
  };
};

const recipeCellForRun = (
  run: Run,
  status: "pending" | "running" = "running"
): NonNullable<DagSchedulingContext["recipeCell"]> => {
  const dataset: Dataset = {
    datasetId: datasetId("dataset-dag-cancellation"),
    name: "Synthetic cancellation dataset",
    workspaceId: workspace,
  };
  const inputField: Field = {
    datasetId: dataset.datasetId,
    fieldId: fieldId("field-dag-cancellation-input"),
    key: "source",
    label: "Source",
    valueType: "string",
    workspaceId: workspace,
  };
  const targetField: Field = {
    datasetId: dataset.datasetId,
    fieldId: fieldId("field-dag-cancellation-target"),
    key: "target",
    label: "Target",
    valueType: "string",
    workspaceId: workspace,
  };
  const record: DatasetRecord = {
    datasetId: dataset.datasetId,
    recordId: recordId("record-dag-cancellation"),
    values: [{ fieldId: inputField.fieldId, value: "synthetic.invalid" }],
    workspaceId: workspace,
  };
  const workflow = plan([node("root")]).compiledWorkflow;
  const recipe: EnrichmentRecipe = {
    datasetId: dataset.datasetId,
    enrichmentRecipeId: enrichmentRecipeId("recipe-dag-cancellation"),
    inputFieldIds: [inputField.fieldId],
    name: "Synthetic cancellation recipe",
    recipeRevision: workflow.workflowRevision,
    targetFieldId: targetField.fieldId,
    workflowContentHash: workflow.workflowContentHash,
    workflowRevision: workflow.workflowRevision,
    workflowSpecId: workflow.workflowSpecId,
    workspaceId: workspace,
  };
  return {
    current: {
      cellResultId: cellResultId("cell-result-dag-cancellation"),
      datasetId: dataset.datasetId,
      enrichmentRecipeId: recipe.enrichmentRecipeId,
      fieldId: targetField.fieldId,
      recipeRevision: recipe.recipeRevision,
      recordId: record.recordId,
      runId: run.runId,
      status,
      workspaceId: workspace,
    },
    dataset,
    fields: [inputField, targetField],
    recipe,
    record,
  };
};

const materializer = (
  persistence: FakeDagSchedulingPersistence,
  now = instant(2000)
) => {
  let nextEvent = 0;
  return makeMaterializeNextDagRun({
    clock: { now: async () => now },
    identifiers: {
      nextEventId: async () => eventId(`dag-ready-${++nextEvent}`),
    },
    persistence,
  });
};

test("returns idle without consuming identifiers when no DAG job is pending", async () => {
  const persistence = new FakeDagSchedulingPersistence();
  const result = await materializer(persistence)();

  assert.deepEqual(result, { status: "idle" });
  assert.deepEqual(persistence.inserted, []);
  assert.deepEqual(persistence.completed, []);
});

test("materializes every ungated root in compiled order with opaque deterministic identities", async () => {
  const nodes = [
    node("root-a"),
    node("root-b"),
    node("approved", [], "approval.required"),
    node("child", ["root-a"]),
  ];
  const firstPersistence = new FakeDagSchedulingPersistence(context(nodes));
  const secondPersistence = new FakeDagSchedulingPersistence(context(nodes));
  const first = await materializer(firstPersistence)();
  const second = await materializer(secondPersistence)();

  assert.equal(first.status, "processed");
  assert.equal(second.status, "processed");
  if (first.status === "processed" && second.status === "processed") {
    assert.deepEqual(first.outcome, { status: "steps-materialized" });
    assert.deepEqual(
      first.created.map((entry) => entry.nodeKey),
      ["root-a", "root-b"]
    );
    assert.deepEqual(
      first.created.map((entry) => entry.stepRunId),
      second.created.map((entry) => entry.stepRunId)
    );
    assert.match(first.created[0]?.stepRunId ?? "", OPAQUE_STEP_RUN_ID);
  }
  assert.deepEqual(
    firstPersistence.inserted.map((entry) => entry.event.eventType),
    ["StepReady", "StepReady"]
  );
  assert.deepEqual(firstPersistence.completed, [runningRun().runId]);
  assert.deepEqual(
    firstPersistence.routingRequested,
    firstPersistence.inserted.map((entry) => entry.stepRun.stepRunId)
  );
});

test("materializes fan-out and waits for every fan-in dependency to succeed", async () => {
  const nodes = [
    node("root"),
    node("left", ["root"]),
    node("right", ["root"]),
    node("join", ["left", "right"]),
  ];
  const run = runningRun();
  const fanOut = new FakeDagSchedulingPersistence(
    context(nodes, [storedStep(run, "root", "succeeded")], run)
  );
  const fanOutResult = await materializer(fanOut)();

  assert.equal(fanOutResult.status, "processed");
  if (fanOutResult.status === "processed") {
    assert.deepEqual(fanOutResult.outcome, {
      status: "steps-materialized",
    });
    assert.deepEqual(
      fanOutResult.created.map((entry) => entry.nodeKey),
      ["left", "right"]
    );
  }

  const partialFanIn = new FakeDagSchedulingPersistence(
    context(
      nodes,
      [
        storedStep(run, "root", "succeeded"),
        storedStep(run, "left", "succeeded", ["root"]),
        storedStep(run, "right", "active", ["root"]),
      ],
      run
    )
  );
  const partial = await materializer(partialFanIn)();
  assert.equal(partial.status, "processed");
  if (partial.status === "processed") {
    assert.deepEqual(partial.created, []);
    assert.deepEqual(partial.outcome, {
      reason: "step-coverage-incomplete",
      status: "blocked",
    });
  }

  const completeFanIn = new FakeDagSchedulingPersistence(
    context(
      nodes,
      [
        storedStep(run, "root", "succeeded"),
        storedStep(run, "left", "succeeded", ["root"]),
        storedStep(run, "right", "succeeded", ["root"]),
      ],
      run
    )
  );
  const complete = await materializer(completeFanIn)();
  assert.equal(complete.status, "processed");
  if (complete.status === "processed") {
    assert.deepEqual(complete.outcome, { status: "steps-materialized" });
    assert.deepEqual(
      complete.created.map((entry) => entry.nodeKey),
      ["join"]
    );
  }
});

test("non-running and expired contexts record a waiting outcome without new work", async () => {
  for (const [label, schedulingContext, now] of [
    [
      "stopped run",
      context([node("root")], [], runningRun("ambiguous")),
      instant(2000),
    ],
    ["plan deadline", context([node("root")]), instant(9000)],
    ["authority deadline", context([node("root")]), instant(10_000)],
  ] as const) {
    const persistence = new FakeDagSchedulingPersistence(schedulingContext);
    const result = await materializer(persistence, now)();
    assert.equal(result.status, "processed", label);
    if (result.status === "processed") {
      assert.deepEqual(result.created, [], label);
      assert.deepEqual(result.outcome, { status: "waiting" }, label);
    }
    assert.deepEqual(persistence.completed, [schedulingContext.run.runId]);
  }
});

test("settles a cancelling Run only after durable effects and reservations are closed", async () => {
  const run = {
    ...runningRun("cancelling"),
    pendingStopReason: "requested" as const,
  };
  const completedRoot = storedStep(run, "root", "succeeded");
  const schedulingContext = {
    ...context(
      [node("root"), node("never-started", ["root"])],
      [completedRoot],
      run
    ),
    recipeCell: recipeCellForRun(run),
  };
  const persistence = new FakeDagSchedulingPersistence(schedulingContext);

  const result = await materializer(persistence)();

  assert.equal(result.status, "processed");
  if (result.status === "processed") {
    assert.deepEqual(result.outcome, { status: "stale-terminal" });
    assert.deepEqual(result.created, []);
    assert.deepEqual(result.skipped, []);
  }
  assert.equal(persistence.updatedRuns.length, 1);
  const cancelled = persistence.updatedRuns[0];
  assert.equal(cancelled?.state, "cancelled");
  assert.equal(cancelled?.aggregateVersion, run.aggregateVersion + 1);
  assert.deepEqual(
    persistence.runEvents.map((event) => event.eventType),
    ["RunCancelled"]
  );
  assert.equal(persistence.commandProofs.length, 1);
  assert.equal(persistence.commandProofs[0]?.commandType, "SettleCancellation");
  assert.equal(persistence.manifests.length, 0);
  assert.equal(persistence.cellFinalizations.length, 1);
  assert.equal(persistence.cellFinalizations[0]?.cellResult.status, "skipped");
  assert.equal(
    persistence.cellFinalizations[0]?.sourceRunAggregateVersion,
    cancelled?.aggregateVersion
  );

  assert.ok(cancelled);
  const replay = new FakeDagSchedulingPersistence({
    ...schedulingContext,
    recipeCell: recipeCellForRun(cancelled),
    run: cancelled,
  });
  const replayResult = await materializer(replay)();
  assert.equal(replayResult.status, "processed");
  if (replayResult.status === "processed") {
    assert.deepEqual(replayResult.outcome, { status: "stale-terminal" });
  }
  assert.deepEqual(replay.updatedRuns, []);
  assert.deepEqual(replay.runEvents, []);
  assert.deepEqual(replay.commandProofs, []);
  assert.equal(replay.cellFinalizations.length, 1);
});

test("keeps cancellation open for prepared, claimed, in-flight, and ambiguous effects", async () => {
  for (const state of [
    "prepared",
    "claimed",
    "in_flight",
    "ambiguous",
  ] as const) {
    const run = runningRun("cancelling");
    const stepRun = unresolvedStep(run, state);
    const persistence = new FakeDagSchedulingPersistence(
      context([node("root")], [stepRun], run)
    );

    const result = await materializer(persistence)();

    assert.equal(result.status, "processed", state);
    if (result.status === "processed") {
      assert.deepEqual(result.outcome, { status: "waiting" }, state);
    }
    assert.deepEqual(persistence.updatedRuns, [], state);
    assert.deepEqual(persistence.runEvents, [], state);
    assert.deepEqual(persistence.commandProofs, [], state);
  }
});

test("keeps cancellation open while a matching durable reservation remains reserved", async () => {
  const run = runningRun("cancelling");
  const completed = storedStep(run, "root", "succeeded");
  const attempt = completed.attempts[0];
  assert.ok(attempt);
  const reservedAttempt = { ...attempt, reservedAmount: 1 };
  const stepRun = { ...completed, attempts: [reservedAttempt] };
  const schedulingContext = context([node("root")], [stepRun], run);
  const released = schedulingContext.reservations[0];
  assert.ok(released);
  const persistence = new FakeDagSchedulingPersistence({
    ...schedulingContext,
    cost: { ...schedulingContext.cost, reserved: 1 },
    reservations: [
      {
        amount: released.amount,
        attemptId: released.attemptId,
        createdAt: released.createdAt,
        operationKey: released.operationKey,
        reservationId: released.reservationId,
        runId: released.runId,
        state: "reserved",
        stepRunId: released.stepRunId,
        unit: released.unit,
        workspaceId: released.workspaceId,
      },
    ],
  });

  const result = await materializer(persistence)();

  assert.equal(result.status, "processed");
  if (result.status === "processed") {
    assert.deepEqual(result.outcome, { status: "waiting" });
  }
  assert.deepEqual(persistence.updatedRuns, []);
  assert.deepEqual(persistence.runEvents, []);
});

test("rejects cancellation convergence without one exact reservation proof per attempt", async () => {
  const run = runningRun("cancelling");
  const completed = storedStep(run, "root", "succeeded");
  const schedulingContext = context([node("root")], [completed], run);
  const persistence = new FakeDagSchedulingPersistence({
    ...schedulingContext,
    reservations: [],
  });

  await assert.rejects(
    materializer(persistence)(),
    DagSchedulingInvariantError
  );
  assert.deepEqual(persistence.updatedRuns, []);
  assert.deepEqual(persistence.completed, []);
});

test("persists skipped descendants and failure finalization atomically", async () => {
  const run = runningRun();
  const nodes = [node("root"), node("child", ["root"])];
  const failedRoot = storedStep(run, "root", "failed");
  const persistence = new FakeDagSchedulingPersistence({
    ...context(nodes, [failedRoot], run),
    recipeCell: recipeCellForRun(run),
  });

  const result = await materializer(persistence)();

  assert.equal(result.status, "processed");
  if (result.status !== "processed") {
    return;
  }
  assert.deepEqual(result.outcome, { status: "failure-finalized" });
  assert.deepEqual(
    result.skipped.map((entry) => entry.nodeKey),
    ["child"]
  );
  assert.equal(result.finalized?.run.state, "failed");
  assert.equal(result.finalized?.manifest.conclusion, "failed");
  assert.deepEqual(
    result.finalized?.manifest.entries.map((entry) => [
      entry.nodeKey,
      entry.state,
    ]),
    [
      ["root", "failed"],
      ["child", "skipped"],
    ]
  );
  assert.deepEqual(
    persistence.inserted.map((entry) => entry.event.eventType),
    ["StepSkipped"]
  );
  assert.deepEqual(
    persistence.runEvents.map((event) => event.eventType),
    ["RunResultManifestRecorded", "RunFailed"]
  );
  assert.equal(persistence.manifests.length, 1);
  assert.equal(persistence.updatedRuns.length, 1);
  assert.equal(persistence.commandProofs.length, 1);
  assert.equal(persistence.cellFinalizations.length, 1);
  assert.equal(persistence.cellFinalizations[0]?.cellResult.status, "failed");
  assert.deepEqual(persistence.cellFinalizations[0]?.manifest, {
    manifestHash: result.finalized?.manifest.manifestHash,
    resultManifestId: result.finalized?.manifest.resultManifestId,
  });
  assert.equal(
    persistence.cellFinalizations[0]?.sourceRunAggregateVersion,
    result.finalized?.run.aggregateVersion
  );
  assert.deepEqual(persistence.completionOutcomes, [
    { status: "failure-finalized" },
  ]);
});

test("converges a proven failure after the execution deadline", async () => {
  const run = runningRun();
  const nodes = [node("root"), node("child", ["root"])];
  const persistence = new FakeDagSchedulingPersistence(
    context(nodes, [storedStep(run, "root", "failed")], run)
  );

  const result = await materializer(persistence, instant(10_000))();

  assert.equal(result.status, "processed");
  if (result.status !== "processed") {
    return;
  }
  assert.deepEqual(result.created, []);
  assert.deepEqual(
    result.skipped.map((entry) => entry.nodeKey),
    ["child"]
  );
  assert.deepEqual(result.outcome, { status: "failure-finalized" });
  assert.equal(result.finalized?.run.state, "failed");
});

test("all-success coverage is durably blocked on missing result proof", async () => {
  const run = runningRun();
  const persistence = new FakeDagSchedulingPersistence(
    context([node("root")], [storedStep(run, "root", "succeeded")], run)
  );

  const result = await materializer(persistence)();

  assert.equal(result.status, "processed");
  if (result.status === "processed") {
    assert.deepEqual(result.outcome, {
      reason: "result-proof-missing",
      status: "blocked",
    });
    assert.equal(result.finalized, undefined);
  }
  assert.deepEqual(persistence.completionOutcomes, [
    { reason: "result-proof-missing", status: "blocked" },
  ]);
});

test("finalizes an accepted unique-sink output and verifies its late wake", async () => {
  const run = runningRun();
  const baseStep = storedStep(run, "root", "succeeded");
  const terminalAttempt = baseStep.attempts[0];
  assert.notEqual(terminalAttempt, undefined);
  if (terminalAttempt === undefined) {
    return;
  }
  const sinkPayload = {
    confidence: 0.9,
    freshness: { expiresAt: 9000, observedAt: 1800 },
    provenance: { references: ["https://synthetic.invalid/evidence"] },
    value: "https://synthetic.invalid",
  } as const;
  const output = {
    artifact: {
      artifactId: artifactId("artifact-dag-root"),
      contentHash: canonicalContentHash(sinkPayload),
    },
    contract: plan([node("root")]).outputContract,
    validatedAt: instant(1800),
    validatorVersion: "validator-dag-v1",
  } as const;
  const succeededStep: StepRun = {
    ...baseStep,
    attempts: [{ ...terminalAttempt, output }],
  };
  const schedulingContext = context([node("root")], [succeededStep], run);
  const dataset: Dataset = {
    datasetId: datasetId("dataset-dag-recipe"),
    name: "Synthetic organizations",
    workspaceId: workspace,
  };
  const inputField: Field = {
    datasetId: dataset.datasetId,
    fieldId: fieldId("field-dag-domain"),
    key: "domain",
    label: "Domain",
    valueType: "string",
    workspaceId: workspace,
  };
  const targetField: Field = {
    datasetId: dataset.datasetId,
    fieldId: fieldId("field-dag-official-website"),
    key: "official_website",
    label: "Official website",
    valueType: "string",
    workspaceId: workspace,
  };
  const record: DatasetRecord = {
    datasetId: dataset.datasetId,
    recordId: recordId("record-dag-recipe"),
    values: [{ fieldId: inputField.fieldId, value: "synthetic.invalid" }],
    workspaceId: workspace,
  };
  const recipe: EnrichmentRecipe = {
    datasetId: dataset.datasetId,
    enrichmentRecipeId: enrichmentRecipeId("recipe-dag-official-website"),
    inputFieldIds: [inputField.fieldId],
    name: "Find official website",
    recipeRevision: "1.0.0",
    targetFieldId: targetField.fieldId,
    workflowContentHash:
      schedulingContext.plan.compiledWorkflow.workflowContentHash,
    workflowRevision: schedulingContext.plan.compiledWorkflow.workflowRevision,
    workflowSpecId: schedulingContext.plan.compiledWorkflow.workflowSpecId,
    workspaceId: workspace,
  };
  const artifact: import("@kurobara/kernel").Artifact = {
    artifactId: output.artifact.artifactId,
    attemptId: terminalAttempt.attemptId,
    classification: "internal",
    contentHash: output.artifact.contentHash,
    contract: output.contract,
    finalizedAt: instant(1800),
    kind: "normalized-output",
    mediaType: "application/json",
    operationKey: terminalAttempt.operationKey,
    retentionPolicy: "run",
    runId: run.runId,
    sizeBytes: 21,
    state: "finalized",
    stepRunId: succeededStep.stepRunId,
    validatedAt: output.validatedAt,
    validatorVersion: output.validatorVersion,
    workspaceId: workspace,
  };
  const persistence = new FakeDagSchedulingPersistence({
    ...schedulingContext,
    artifactPayloads: [
      {
        artifactId: artifact.artifactId,
        contentHash: artifact.contentHash,
        value: sinkPayload,
      },
    ],
    artifacts: [artifact],
    recipeCell: {
      current: {
        cellResultId: cellResultId("cell-result-dag-recipe"),
        datasetId: dataset.datasetId,
        enrichmentRecipeId: recipe.enrichmentRecipeId,
        fieldId: targetField.fieldId,
        recipeRevision: recipe.recipeRevision,
        recordId: record.recordId,
        runId: run.runId,
        status: "running",
        workspaceId: workspace,
      },
      dataset,
      fields: [inputField, targetField],
      recipe,
      record,
    },
  });

  const result = await materializer(persistence)();

  assert.equal(result.status, "processed");
  if (result.status !== "processed" || result.finalized === undefined) {
    return;
  }
  assert.deepEqual(result.outcome, { status: "success-finalized" });
  assert.equal(result.finalized.run.state, "completed");
  assert.equal(result.finalized.manifest.output.status, "accepted");
  assert.deepEqual(
    persistence.runEvents.map((event) => event.eventType),
    ["RunResultManifestRecorded", "RunCompleted"]
  );
  assert.equal(persistence.cellFinalizations.length, 1);
  assert.deepEqual(persistence.cellFinalizations[0], {
    artifact: output.artifact,
    cellResult: {
      cellResultId: cellResultId("cell-result-dag-recipe"),
      confidence: sinkPayload.confidence,
      cost: { amount: 0, basis: "exact", unit: "credits" },
      datasetId: dataset.datasetId,
      enrichmentRecipeId: recipe.enrichmentRecipeId,
      fieldId: targetField.fieldId,
      freshness: {
        expiresAt: instant(9000),
        observedAt: instant(1800),
      },
      provenance: sinkPayload.provenance,
      recipeRevision: recipe.recipeRevision,
      recordId: record.recordId,
      runId: run.runId,
      status: "succeeded",
      value: sinkPayload.value,
      workspaceId: workspace,
    },
    manifest: {
      manifestHash: result.finalized.manifest.manifestHash,
      resultManifestId: result.finalized.manifest.resultManifestId,
    },
    sourceRunAggregateVersion: result.finalized.run.aggregateVersion,
  });

  const late = new FakeDagSchedulingPersistence({
    ...schedulingContext,
    run: result.finalized.run,
  });
  late.manifests.push(result.finalized.manifest);
  const lateResult = await materializer(late)();
  assert.equal(lateResult.status, "processed");
  if (lateResult.status === "processed") {
    assert.deepEqual(lateResult.outcome, { status: "stale-terminal" });
  }
});

test("blocks an all-success multi-sink DAG without inventing aggregation", async () => {
  const run = runningRun();
  const persistence = new FakeDagSchedulingPersistence(
    context(
      [node("left"), node("right")],
      [
        storedStep(run, "left", "succeeded"),
        storedStep(run, "right", "succeeded"),
      ],
      run
    )
  );

  const result = await materializer(persistence)();

  assert.equal(result.status, "processed");
  if (result.status === "processed") {
    assert.deepEqual(result.outcome, {
      reason: "output-binding-ambiguous",
      status: "blocked",
    });
  }
});

test("a late failed-run wake-up requires and verifies the durable manifest reference", async () => {
  const run = runningRun();
  const nodes = [node("root")];
  const failedRoot = storedStep(run, "root", "failed");
  const firstPersistence = new FakeDagSchedulingPersistence(
    context(nodes, [failedRoot], run)
  );
  const first = await materializer(firstPersistence)();
  assert.equal(first.status, "processed");
  if (first.status !== "processed" || first.finalized === undefined) {
    return;
  }

  const lateContext = context(nodes, [failedRoot], first.finalized.run);
  const verified = new FakeDagSchedulingPersistence(lateContext);
  verified.manifests.push(first.finalized.manifest);
  const result = await materializer(verified)();
  assert.equal(result.status, "processed");
  if (result.status === "processed") {
    assert.deepEqual(result.outcome, { status: "stale-terminal" });
  }

  const missingManifest = new FakeDagSchedulingPersistence(lateContext);
  await assert.rejects(
    materializer(missingManifest)(),
    DagSchedulingInvariantError
  );
  assert.deepEqual(missingManifest.completed, []);
});

test("converges a cancelled recipe Run to skipped and releases its CellResult lifecycle", async () => {
  const run = runningRun("cancelled");
  const persistence = new FakeDagSchedulingPersistence({
    ...context([node("root")], [], run),
    recipeCell: recipeCellForRun(run),
  });

  const result = await materializer(persistence)();

  assert.equal(result.status, "processed");
  if (result.status === "processed") {
    assert.deepEqual(result.outcome, { status: "stale-terminal" });
  }
  assert.equal(persistence.cellFinalizations.length, 1);
  assert.deepEqual(persistence.cellFinalizations[0], {
    cellResult: {
      ...recipeCellForRun(run).current,
      reason: {
        code: "run-cancelled",
        message: "The canonical run was cancelled.",
        retryable: false,
      },
      status: "skipped",
    },
    sourceRunAggregateVersion: run.aggregateVersion,
  });
});

test("rejects a cross-workspace scheduling context before completing it", async () => {
  const invalidRun = {
    ...runningRun(),
    workspaceId: workspaceId("workspace-other"),
  };
  const persistence = new FakeDagSchedulingPersistence(
    context([node("root")], [], invalidRun)
  );

  await assert.rejects(
    materializer(persistence)(),
    DagSchedulingInvariantError
  );
  assert.deepEqual(persistence.inserted, []);
  assert.deepEqual(persistence.completed, []);
});
