import assert from "node:assert/strict";
import test from "node:test";

import {
  actorId,
  applyRunCommand,
  artifactId,
  contentHash,
  correlationId,
  eventId,
  idempotencyKey,
  instant,
  type ResultManifest,
  type Run,
  type RunCommand,
  type RunCommandContext,
  type RunCommandIdentity,
  type RunCommandReplayProof,
  resultManifestId,
  runId,
  runPlanId,
  stepRunId,
  workspaceId,
} from "../src/index.ts";

const baseRun = (overrides: Partial<Run> = {}): Run => ({
  aggregateVersion: 1,
  createdAt: instant(1000),
  eventSequence: 1,
  idempotencyKey: idempotencyKey("create-run"),
  intentionHash: contentHash(`sha256:${"a".repeat(64)}`),
  resultCompleteness: "none",
  runId: runId("run-test"),
  runPlanId: runPlanId("plan-test"),
  state: "queued",
  workspaceId: workspaceId("workspace-test"),
  ...overrides,
});

const contract = {
  catalogFingerprint: contentHash(`sha256:${"c".repeat(64)}`),
  catalogVersion: "1.0.0",
  schemaFingerprint: contentHash(`sha256:${"d".repeat(64)}`),
  schemaId: "https://schemas.kurobara.invalid/result/1.0.0",
  schemaVersion: "1.0.0",
};

const manifestFor = (
  run: Run,
  conclusion: ResultManifest["conclusion"],
  overrides: Partial<ResultManifest> = {}
): ResultManifest => {
  const completed = conclusion === "completed";
  const accepted = {
    artifact: {
      artifactId: artifactId("artifact-test"),
      contentHash: contentHash(`sha256:${"f".repeat(64)}`),
    },
    contract,
    validatedAt: instant(2900),
    validatorVersion: "1.0.0",
  } as const;
  return {
    attemptSettlements: [],
    compiledWorkflowFingerprint: "workflow-test",
    conclusion,
    cost: { reserved: 0, spent: 0, unit: "credits" },
    coverage: "complete",
    createdAt: instant(3000),
    entries: [
      {
        nodeKey: "node-test",
        result: completed
          ? { ...accepted, status: "accepted" }
          : { reason: "step-failed", status: "missing" },
        state: completed ? "succeeded" : "failed",
        stepAggregateVersion: 1,
        stepEventSequence: 1,
        stepRunId: stepRunId("step-test"),
      },
    ],
    manifestHash: contentHash(`sha256:${"e".repeat(64)}`),
    manifestVersion: 1,
    output: completed
      ? {
          ...accepted,
          status: "accepted",
        }
      : { reason: "run-failed", status: "missing" },
    outputContract: contract,
    planHash: contentHash(`sha256:${"1".repeat(64)}`),
    resultCompleteness: completed ? "complete" : "none",
    resultManifestId: resultManifestId(`manifest-${run.runId}`),
    runId: run.runId,
    runPlanId: run.runPlanId,
    sourceRunAggregateVersion: run.aggregateVersion,
    workspaceId: run.workspaceId,
    ...overrides,
  };
};

const commandIdentity = (
  key: string,
  hashCharacter = "b"
): RunCommandIdentity => ({
  commandHash: contentHash(`sha256:${hashCharacter.repeat(64)}`),
  idempotencyKey: idempotencyKey(key),
});

const replayProof = (
  run: Run,
  identity: RunCommandIdentity,
  commandType: RunCommand["type"]
): RunCommandReplayProof => ({
  commandType,
  identity,
  runId: run.runId,
  workspaceId: run.workspaceId,
});

const context = (
  run: Run,
  eventCount: number,
  overrides: Partial<RunCommandContext> = {}
): RunCommandContext => ({
  actorId: actorId("actor-test"),
  commandIdentity: commandIdentity(`command-${run.aggregateVersion}`),
  correlationId: correlationId("correlation-test"),
  eventIds: Array.from({ length: eventCount }, (_, index) =>
    eventId(`event-${run.eventSequence + index + 1}`)
  ),
  expectedAggregateVersion: run.aggregateVersion,
  occurredAt: instant(2000 + run.aggregateVersion),
  ...overrides,
});

const apply = (run: Run, command: RunCommand, eventCount: number): Run => {
  const result = applyRunCommand(run, command, context(run, eventCount));
  if (!result.ok) {
    throw new Error(result.error.message);
  }
  return result.value.run;
};

test("claims, waits, resumes and completes with monotone aggregate and event sequences", () => {
  const queued = baseRun();
  const running = apply(queued, { type: "ClaimRun" }, 1);
  const waiting = apply(
    running,
    { hasIndependentProgress: false, type: "OpenInputRequest" },
    2
  );
  const resumed = apply(
    waiting,
    { reopensGlobalProgress: true, type: "ConsumeSignal" },
    2
  );
  const result = applyRunCommand(
    resumed,
    {
      manifest: manifestFor(resumed, "completed"),
      type: "CompleteRun",
    },
    context(resumed, 2)
  );

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.value.replayed, false);
    assert.equal(result.value.run.state, "completed");
    assert.equal(result.value.run.aggregateVersion, 5);
    assert.equal(result.value.run.eventSequence, 8);
    assert.equal(result.value.run.resultCompleteness, "complete");
    assert.deepEqual(
      result.value.events.map((event) => event.sequence),
      [7, 8]
    );
  }
});

test("replays ClaimRun after later progression before checking aggregate version", () => {
  const queued = baseRun();
  const identity = commandIdentity("claim-command");
  const claimed = applyRunCommand(
    queued,
    { type: "ClaimRun" },
    context(queued, 1, { commandIdentity: identity })
  );
  assert.equal(claimed.ok, true);
  if (!claimed.ok) {
    return;
  }
  const waiting = apply(
    claimed.value.run,
    { hasIndependentProgress: false, type: "OpenInputRequest" },
    2
  );
  const replayed = applyRunCommand(
    waiting,
    { type: "ClaimRun" },
    context(waiting, 0, {
      commandIdentity: identity,
      expectedAggregateVersion: queued.aggregateVersion,
      replayProof: replayProof(queued, identity, "ClaimRun"),
    })
  );

  assert.equal(replayed.ok, true);
  if (replayed.ok) {
    assert.equal(replayed.value.replayed, true);
    assert.equal(replayed.value.events.length, 0);
    assert.strictEqual(replayed.value.run, waiting);
  }
});

test("rejects replay proof from another run or workspace", () => {
  const sourceRun = baseRun();
  const identity = commandIdentity("aggregate-bound-command", "f");
  const proof = replayProof(sourceRun, identity, "ClaimRun");
  const otherRun = baseRun({ runId: runId("run-other") });
  const otherWorkspace = baseRun({
    workspaceId: workspaceId("workspace-other"),
  });
  const runMismatch = applyRunCommand(
    otherRun,
    { type: "ClaimRun" },
    context(otherRun, 0, { commandIdentity: identity, replayProof: proof })
  );
  const workspaceMismatch = applyRunCommand(
    otherWorkspace,
    { type: "ClaimRun" },
    context(otherWorkspace, 0, {
      commandIdentity: identity,
      replayProof: proof,
    })
  );

  assert.equal(runMismatch.ok, false);
  assert.equal(workspaceMismatch.ok, false);
  if (!(runMismatch.ok || workspaceMismatch.ok)) {
    assert.equal(runMismatch.error.code, "replay-proof-mismatch");
    assert.equal(workspaceMismatch.error.code, "replay-proof-mismatch");
  }
});

test("keeps the run globally running when an input request has independent progress", () => {
  const running = apply(baseRun(), { type: "ClaimRun" }, 1);
  const result = applyRunCommand(
    running,
    { hasIndependentProgress: true, type: "OpenInputRequest" },
    context(running, 1)
  );

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.value.run.state, "running");
    assert.deepEqual(
      result.value.events.map((event) => event.eventType),
      ["InputRequested"]
    );
  }
});

test("rejects every modeled command from a state outside its closed transition cells", () => {
  const invalidCases: readonly [Run, RunCommand, number][] = [
    [
      baseRun(),
      {
        manifest: manifestFor(baseRun(), "completed"),
        type: "CompleteRun",
      },
      1,
    ],
    [
      baseRun({ state: "running" }),
      { reopensGlobalProgress: true, type: "ConsumeSignal" },
      2,
    ],
    [baseRun({ state: "waiting" }), { type: "ClaimRun" }, 1],
    [
      baseRun({ state: "cancelling" }),
      {
        manifest: manifestFor(baseRun({ state: "cancelling" }), "failed"),
        type: "FailRun",
      },
      1,
    ],
    [baseRun({ state: "ambiguous" }), { type: "SettleCancellation" }, 1],
    [
      baseRun({ resultCompleteness: "complete", state: "completed" }),
      { type: "ClaimRun" },
      1,
    ],
    [baseRun({ state: "failed" }), { type: "ClaimRun" }, 1],
    [baseRun({ state: "cancelled" }), { type: "ClaimRun" }, 1],
  ];

  for (const [run, command, eventCount] of invalidCases) {
    const result = applyRunCommand(run, command, context(run, eventCount));
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error.code, "invalid-transition");
    }
  }
});

test("detects aggregate concurrency and event allocation conflicts without mutation", () => {
  const run = baseRun();
  const versionConflict = applyRunCommand(
    run,
    { type: "ClaimRun" },
    {
      ...context(run, 1),
      expectedAggregateVersion: 0,
    }
  );
  const eventConflict = applyRunCommand(
    run,
    { type: "ClaimRun" },
    context(run, 0)
  );

  assert.equal(versionConflict.ok, false);
  assert.equal(eventConflict.ok, false);
  if (!(versionConflict.ok || eventConflict.ok)) {
    assert.equal(versionConflict.error.code, "aggregate-version-conflict");
    assert.equal(eventConflict.error.code, "event-id-count-mismatch");
  }
  assert.deepEqual(run, baseRun());
});

test("rejects reuse of an accepted key before checking aggregate version", () => {
  const queued = baseRun();
  const identity = commandIdentity("reused-command", "c");
  const claimed = applyRunCommand(
    queued,
    { type: "ClaimRun" },
    context(queued, 1, { commandIdentity: identity })
  );
  assert.equal(claimed.ok, true);
  if (!claimed.ok) {
    return;
  }

  const reused = applyRunCommand(
    claimed.value.run,
    { reason: "requested", type: "RequestStop" },
    context(claimed.value.run, 0, {
      commandIdentity: identity,
      expectedAggregateVersion: 0,
      replayProof: replayProof(queued, identity, "ClaimRun"),
    })
  );

  assert.equal(reused.ok, false);
  if (!reused.ok) {
    assert.equal(reused.error.code, "idempotency-key-reused");
  }
});

test("cancels a queued run immediately and settles an active run through cancelling", () => {
  const queued = baseRun({ resultCompleteness: "partial" });
  const queuedCancellation = applyRunCommand(
    queued,
    { reason: "deadline", type: "RequestStop" },
    context(queued, 2)
  );
  assert.equal(queuedCancellation.ok, true);
  if (queuedCancellation.ok) {
    assert.equal(queuedCancellation.value.run.state, "cancelled");
    assert.equal(queuedCancellation.value.run.resultCompleteness, "partial");
    assert.deepEqual(
      queuedCancellation.value.events.map((event) => [
        event.eventType,
        "reason" in event ? event.reason : undefined,
      ]),
      [
        ["RunStopRequested", "deadline"],
        ["RunCancelled", "deadline"],
      ]
    );
  }

  const running = apply(
    baseRun({ resultCompleteness: "partial" }),
    { type: "ClaimRun" },
    1
  );
  const cancelling = apply(
    running,
    { reason: "budget", type: "RequestStop" },
    2
  );
  const cancelled = apply(cancelling, { type: "SettleCancellation" }, 1);

  assert.equal(cancelling.state, "cancelling");
  assert.equal(cancelling.pendingStopReason, "budget");
  assert.equal(cancelled.state, "cancelled");
  assert.equal(cancelled.resultCompleteness, "partial");
});

test("replays RequestStop after queued cancellation without a new event", () => {
  const queued = baseRun();
  const identity = commandIdentity("stop-command", "d");
  const stopped = applyRunCommand(
    queued,
    { reason: "deadline", type: "RequestStop" },
    context(queued, 2, { commandIdentity: identity })
  );
  assert.equal(stopped.ok, true);
  if (!stopped.ok) {
    return;
  }

  const replayed = applyRunCommand(
    stopped.value.run,
    { reason: "deadline", type: "RequestStop" },
    context(stopped.value.run, 0, {
      commandIdentity: identity,
      expectedAggregateVersion: queued.aggregateVersion,
      replayProof: replayProof(queued, identity, "RequestStop"),
    })
  );

  assert.equal(replayed.ok, true);
  if (replayed.ok) {
    assert.equal(replayed.value.replayed, true);
    assert.deepEqual(replayed.value.events, []);
    assert.strictEqual(replayed.value.run, stopped.value.run);
  }
});

test("preserves ambiguity until a proof resolves it and honors a pending stop", () => {
  const running = apply(
    baseRun({ resultCompleteness: "partial" }),
    { type: "ClaimRun" },
    1
  );
  const ambiguous = apply(
    running,
    { operationKey: "operation-test", type: "MarkEffectAmbiguous" },
    2
  );
  const stopRequested = apply(
    ambiguous,
    { reason: "requested", type: "RequestStop" },
    1
  );
  const result = applyRunCommand(
    stopRequested,
    {
      outcome: "cancelled",
      proofId: "reconciliation-test",
      resultCompleteness: "partial",
      type: "ResolveAmbiguity",
    },
    context(stopRequested, 2)
  );

  assert.equal(stopRequested.state, "ambiguous");
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.value.run.state, "cancelled");
    assert.equal(result.value.run.resultCompleteness, "partial");
    assert.deepEqual(
      result.value.events.map((event) => event.eventType),
      ["AmbiguityResolved", "RunCancelled"]
    );
  }
});

test("replays ResolveAmbiguity after terminal reconciliation", () => {
  const running = apply(baseRun(), { type: "ClaimRun" }, 1);
  const ambiguous = apply(
    running,
    { operationKey: "operation-replay", type: "MarkEffectAmbiguous" },
    2
  );
  const identity = commandIdentity("resolve-command", "e");
  const command: RunCommand = {
    manifest: manifestFor(ambiguous, "completed"),
    outcome: "completed",
    proofId: "reconciliation-replay",
    resultCompleteness: "complete",
    type: "ResolveAmbiguity",
  };
  const resolved = applyRunCommand(
    ambiguous,
    command,
    context(ambiguous, 3, { commandIdentity: identity })
  );
  assert.equal(resolved.ok, true);
  if (!resolved.ok) {
    return;
  }

  const replayed = applyRunCommand(
    resolved.value.run,
    command,
    context(resolved.value.run, 0, {
      commandIdentity: identity,
      expectedAggregateVersion: ambiguous.aggregateVersion,
      replayProof: replayProof(ambiguous, identity, "ResolveAmbiguity"),
    })
  );

  assert.equal(replayed.ok, true);
  if (replayed.ok) {
    assert.equal(replayed.value.replayed, true);
    assert.deepEqual(replayed.value.events, []);
    assert.strictEqual(replayed.value.run, resolved.value.run);
  }
});

test("requires an operation key and reconciliation proof for ambiguity", () => {
  const running = apply(baseRun(), { type: "ClaimRun" }, 1);
  const missingOperationKey = applyRunCommand(
    running,
    { operationKey: "   ", type: "MarkEffectAmbiguous" },
    context(running, 2)
  );
  const ambiguous = apply(
    running,
    { operationKey: "operation-test", type: "MarkEffectAmbiguous" },
    2
  );
  const missingProof = applyRunCommand(
    ambiguous,
    {
      outcome: "failed",
      proofId: " ",
      resultCompleteness: "none",
      type: "ResolveAmbiguity",
    },
    context(ambiguous, 2)
  );

  assert.equal(missingOperationKey.ok, false);
  assert.equal(missingProof.ok, false);
  if (!(missingOperationKey.ok || missingProof.ok)) {
    assert.equal(missingOperationKey.error.code, "operation-key-required");
    assert.equal(missingProof.error.code, "reconciliation-proof-required");
  }
});

test("rejects completion with partial output or mismatched manifest identity", () => {
  const running = apply(baseRun(), { type: "ClaimRun" }, 1);
  const partial = applyRunCommand(
    running,
    {
      manifest: manifestFor(running, "completed", {
        resultCompleteness: "partial",
      }),
      type: "CompleteRun",
    },
    context(running, 1)
  );
  const mismatched = applyRunCommand(
    running,
    {
      manifest: manifestFor(running, "completed", {
        sourceRunAggregateVersion: running.aggregateVersion + 1,
      }),
      type: "CompleteRun",
    },
    context(running, 1)
  );

  assert.equal(partial.ok, false);
  assert.equal(mismatched.ok, false);
  if (!(partial.ok || mismatched.ok)) {
    assert.equal(partial.error.code, "invalid-result-completeness");
    assert.equal(mismatched.error.code, "completion-precondition-failed");
  }
});

test("fails with a partial result without converting partiality into success", () => {
  const running = apply(baseRun(), { type: "ClaimRun" }, 1);
  const failed = apply(
    running,
    {
      manifest: manifestFor(running, "failed", {
        resultCompleteness: "partial",
      }),
      type: "FailRun",
    },
    2
  );

  assert.equal(failed.state, "failed");
  assert.equal(failed.resultCompleteness, "partial");
});
