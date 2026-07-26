import assert from "node:assert/strict";
import test from "node:test";

import {
  type Attempt,
  actorId,
  artifactId,
  attemptId,
  type CostReservation,
  capabilityId,
  contentHash,
  costReservationId,
  evaluateRunConvergence,
  idempotencyKey,
  instant,
  operationKey,
  type Run,
  type RunPlan,
  routingDecisionId,
  runId,
  runPlanId,
  type StepRun,
  stepRunId,
  usageEntryId,
  workflowSpecId,
  workspaceId,
} from "../src/index.ts";

const hash = (character: string) =>
  contentHash(`sha256:${character.repeat(64)}`);
const workspace = workspaceId("workspace-convergence");
const capability = {
  capabilityId: capabilityId("documents.summarize"),
  capabilityVersion: "1.0.0",
};
const contract = {
  catalogFingerprint: hash("a"),
  catalogVersion: "1.0.0",
  schemaFingerprint: hash("b"),
  schemaId: "https://schemas.kurobara.invalid/result/1.0.0",
  schemaVersion: "1.0.0",
};

type Node = RunPlan["compiledWorkflow"]["nodes"][number];

const node = (key: string, dependsOn: readonly string[] = []): Node => ({
  capability,
  dependsOn,
  depth: dependsOn.length,
  key,
});

const plan = (nodes: readonly Node[], initialSpent = 0): RunPlan => ({
  authority: {
    authorityEnvelopeId: "authority-convergence",
    budgetLimit: {
      limit: 10,
      reserved: 0,
      spent: initialSpent,
      unit: "credits",
    },
    capabilities: [capability],
    deadline: instant(10_000),
    permissions: ["steps:execute"],
    subjectActorId: actorId("agent-convergence"),
    version: "1.0.0",
    workspaceId: workspace,
  },
  budget: {
    limit: 10,
    reserved: 0,
    spent: initialSpent,
    unit: "credits",
  },
  catalogFingerprint: hash("a"),
  catalogVersion: "1.0.0",
  compiledWorkflow: {
    compilerVersion: "1.0.0",
    fingerprint: nodes.map((entry) => entry.key).join("|"),
    nodes,
    workflowContentHash: hash("c"),
    workflowRevision: "1.0.0",
    workflowSpecId: workflowSpecId("workflow-convergence"),
  },
  deadline: instant(9000),
  inputContract: { ...contract, schemaFingerprint: hash("d") },
  normalizedInputHash: hash("e"),
  outputContract: contract,
  planHash: hash("f"),
  policyFactsHash: hash("1"),
  policyVersion: "1.0.0",
  quote: {
    expiresAt: instant(8000),
    guarantee: "hard",
    pricingVersion: "1.0.0",
    quoteId: "quote-convergence",
    unit: "credits",
    upperBound: 10,
  },
  retryPolicy: { maxAttemptsPerStep: 3 },
  runPlanId: runPlanId("plan-convergence"),
  workspaceId: workspace,
});

const run: Run = {
  aggregateVersion: 3,
  createdAt: instant(1000),
  eventSequence: 3,
  idempotencyKey: idempotencyKey("run-convergence"),
  intentionHash: hash("2"),
  resultCompleteness: "none",
  runId: runId("run-convergence"),
  runPlanId: runPlanId("plan-convergence"),
  state: "running",
  workspaceId: workspace,
};

const attempt = (
  nodeKey: string,
  state: Attempt["state"],
  reservedAmount = 0
): Attempt => {
  const requestedStepRunId = stepRunId(`step-${nodeKey}`);
  return {
    attemptId: attemptId(`attempt-${nodeKey}`),
    attemptNumber: 1,
    authorityEnvelopeId: "authority-convergence",
    claimedAt: instant(1100),
    costReservationId: costReservationId(`reservation-${nodeKey}`),
    effectAdapterKey: "adapter.test",
    effectStartedAt: instant(1200),
    ...(state === "in_flight" ? {} : { finishedAt: instant(1300) }),
    operationKey: operationKey(`operation-${nodeKey}`),
    preparedAt: instant(1000),
    reason: "initial",
    reservationUnit: "credits",
    reservedAmount,
    routeKey: "route.test",
    routeSnapshotHash: hash("3"),
    routingDecisionId: routingDecisionId(`routing-${nodeKey}`),
    state,
    stepRunId: requestedStepRunId,
  };
};

const step = (
  nodeKey: string,
  state: StepRun["state"],
  dependsOn: readonly string[] = [],
  stepAttempts: readonly Attempt[] = []
): StepRun => ({
  ...(state === "active" && stepAttempts[0] !== undefined
    ? { activeAttemptId: stepAttempts[0].attemptId }
    : {}),
  aggregateVersion: 4,
  attempts: stepAttempts,
  createdAt: instant(1000),
  dependsOn,
  eventSequence: 6,
  nodeKey,
  runId: run.runId,
  state,
  stepRunId: stepRunId(`step-${nodeKey}`),
  workspaceId: workspace,
});

const released = (terminalAttempt: Attempt): CostReservation => ({
  amount: terminalAttempt.reservedAmount,
  attemptId: terminalAttempt.attemptId,
  createdAt: terminalAttempt.preparedAt,
  operationKey: terminalAttempt.operationKey,
  releasedAt: instant(1300),
  reservationId: terminalAttempt.costReservationId,
  runId: run.runId,
  state: "released",
  stepRunId: terminalAttempt.stepRunId,
  unit: terminalAttempt.reservationUnit,
  workspaceId: workspace,
});

const reserved = (activeAttempt: Attempt): CostReservation => ({
  amount: activeAttempt.reservedAmount,
  attemptId: activeAttempt.attemptId,
  createdAt: activeAttempt.preparedAt,
  operationKey: activeAttempt.operationKey,
  reservationId: activeAttempt.costReservationId,
  runId: run.runId,
  state: "reserved",
  stepRunId: activeAttempt.stepRunId,
  unit: activeAttempt.reservationUnit,
  workspaceId: workspace,
});

const settled = (
  terminalAttempt: Attempt,
  settledAmount: number
): CostReservation => ({
  amount: terminalAttempt.reservedAmount,
  attemptId: terminalAttempt.attemptId,
  createdAt: terminalAttempt.preparedAt,
  operationKey: terminalAttempt.operationKey,
  releasedAmount: terminalAttempt.reservedAmount - settledAmount,
  reservationId: terminalAttempt.costReservationId,
  runId: run.runId,
  settledAmount,
  settledAt: instant(1300),
  state: "settled",
  stepRunId: terminalAttempt.stepRunId,
  unit: terminalAttempt.reservationUnit,
  usageEntryId: usageEntryId(`usage-${terminalAttempt.attemptId}`),
  workspaceId: workspace,
});

test("all-success coverage stays blocked until accepted result proof exists", () => {
  const succeededAttempt = attempt("root", "succeeded");
  const decision = evaluateRunConvergence({
    artifacts: [],
    cost: { reserved: 0, spent: 0, unit: "credits" },
    createdAt: instant(2000),
    plan: plan([node("root")]),
    reservations: [released(succeededAttempt)],
    run,
    stepRuns: [step("root", "succeeded", [], [succeededAttempt])],
  });

  assert.deepEqual(decision, {
    ok: true,
    value: { reason: "result-proof-missing", status: "not-ready" },
  });
});

test("completes a unique sink only from its exact finalized accepted artifact", () => {
  const baseAttempt = attempt("root", "succeeded");
  const output = {
    artifact: {
      artifactId: artifactId("artifact-root"),
      contentHash: hash("9"),
    },
    contract,
    validatedAt: instant(1800),
    validatorVersion: "validator-test-v1",
  } as const;
  const succeededAttempt = { ...baseAttempt, output };
  const artifact: import("../src/index.ts").Artifact = {
    artifactId: output.artifact.artifactId,
    attemptId: succeededAttempt.attemptId,
    classification: "internal",
    contentHash: output.artifact.contentHash,
    contract,
    finalizedAt: instant(1800),
    kind: "normalized-output",
    mediaType: "application/json",
    operationKey: succeededAttempt.operationKey,
    retentionPolicy: "run",
    runId: run.runId,
    sizeBytes: 17,
    state: "finalized",
    stepRunId: succeededAttempt.stepRunId,
    validatedAt: output.validatedAt,
    validatorVersion: output.validatorVersion,
    workspaceId: workspace,
  };
  const decision = evaluateRunConvergence({
    artifacts: [artifact],
    cost: { reserved: 0, spent: 0, unit: "credits" },
    createdAt: instant(2000),
    plan: plan([node("root")]),
    reservations: [settled(succeededAttempt, 0)],
    run,
    stepRuns: [step("root", "succeeded", [], [succeededAttempt])],
  });

  assert.equal(decision.ok, true);
  if (decision.ok && decision.value.status === "completed") {
    assert.equal(decision.value.manifestBody.conclusion, "completed");
    assert.equal(decision.value.manifestBody.output.status, "accepted");
    assert.equal(
      decision.value.manifestBody.entries[0]?.result.status,
      "accepted"
    );
  }
});

test("blocks successful multi-sink coverage without an explicit output binding", () => {
  const left = attempt("left", "succeeded");
  const right = attempt("right", "succeeded");
  const decision = evaluateRunConvergence({
    artifacts: [],
    cost: { reserved: 0, spent: 0, unit: "credits" },
    createdAt: instant(2000),
    plan: plan([node("left"), node("right")]),
    reservations: [settled(left, 0), settled(right, 0)],
    run,
    stepRuns: [
      step("left", "succeeded", [], [left]),
      step("right", "succeeded", [], [right]),
    ],
  });

  assert.deepEqual(decision, {
    ok: true,
    value: { reason: "output-binding-ambiguous", status: "not-ready" },
  });
});

test("builds an ordered complete failure manifest from terminal steps and receipts", () => {
  const failedAttempt = attempt("root", "failed_terminal", 0.2);
  const decision = evaluateRunConvergence({
    artifacts: [],
    cost: { reserved: 0, spent: 0.3, unit: "credits" },
    createdAt: instant(2000),
    plan: plan([node("root"), node("child", ["root"])], 0.1),
    reservations: [settled(failedAttempt, 0.2)],
    run,
    stepRuns: [
      step("child", "skipped", ["root"]),
      step("root", "failed", [], [failedAttempt]),
    ],
  });

  assert.equal(decision.ok, true);
  if (decision.ok && decision.value.status === "failed") {
    assert.equal(decision.value.manifestBody.coverage, "complete");
    assert.deepEqual(
      decision.value.manifestBody.entries.map((entry) => ({
        blockedBy: entry.blockedByNodeKeys,
        nodeKey: entry.nodeKey,
        state: entry.state,
      })),
      [
        { blockedBy: undefined, nodeKey: "root", state: "failed" },
        { blockedBy: ["root"], nodeKey: "child", state: "skipped" },
      ]
    );
    assert.deepEqual(decision.value.manifestBody.cost, {
      reserved: 0,
      spent: 0.3,
      unit: "credits",
    });
    assert.equal(
      decision.value.manifestBody.attemptSettlements[0]?.settledAmount,
      0.2
    );
  }
});

test("classifies incomplete, active and unsettled convergence without finalizing", () => {
  const workflow = plan([node("root"), node("child", ["root"])]);
  const missing = evaluateRunConvergence({
    artifacts: [],
    cost: { reserved: 0, spent: 0, unit: "credits" },
    createdAt: instant(2000),
    plan: workflow,
    reservations: [],
    run,
    stepRuns: [step("root", "failed")],
  });
  const inFlightAttempt = attempt("root", "in_flight", 0.2);
  const active = evaluateRunConvergence({
    artifacts: [],
    cost: { reserved: 0.2, spent: 0, unit: "credits" },
    createdAt: instant(2000),
    plan: plan([node("root")]),
    reservations: [reserved(inFlightAttempt)],
    run,
    stepRuns: [step("root", "active", [], [inFlightAttempt])],
  });
  const failedAttempt = attempt("root", "failed_terminal", 0.2);
  const unsettled = evaluateRunConvergence({
    artifacts: [],
    cost: { reserved: 0.2, spent: 0, unit: "credits" },
    createdAt: instant(2000),
    plan: plan([node("root")]),
    reservations: [reserved(failedAttempt)],
    run,
    stepRuns: [step("root", "failed", [], [failedAttempt])],
  });

  assert.deepEqual(missing, {
    ok: true,
    value: { reason: "step-coverage-incomplete", status: "not-ready" },
  });
  assert.deepEqual(active, {
    ok: true,
    value: { reason: "step-not-terminal", status: "not-ready" },
  });
  assert.deepEqual(unsettled, {
    ok: true,
    value: { reason: "unsettled-cost-present", status: "not-ready" },
  });
});

test("fails closed on reservation identity and run-spend proof drift", () => {
  const failedAttempt = attempt("root", "failed_terminal", 0.2);
  const matchingReservation = settled(failedAttempt, 0.2);
  const reservationDrift = evaluateRunConvergence({
    artifacts: [],
    cost: { reserved: 0, spent: 0.2, unit: "credits" },
    createdAt: instant(2000),
    plan: plan([node("root")]),
    reservations: [
      { ...matchingReservation, operationKey: operationKey("operation-other") },
    ],
    run,
    stepRuns: [step("root", "failed", [], [failedAttempt])],
  });
  const spendDrift = evaluateRunConvergence({
    artifacts: [],
    cost: { reserved: 0, spent: 0.21, unit: "credits" },
    createdAt: instant(2000),
    plan: plan([node("root")]),
    reservations: [matchingReservation],
    run,
    stepRuns: [step("root", "failed", [], [failedAttempt])],
  });

  assert.equal(reservationDrift.ok, false);
  assert.equal(spendDrift.ok, false);
  if (!(reservationDrift.ok || spendDrift.ok)) {
    assert.equal(reservationDrift.error.code, "reservation-proof-invalid");
    assert.equal(spendDrift.error.code, "cost-proof-invalid");
  }
});
