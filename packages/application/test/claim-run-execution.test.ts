import assert from "node:assert/strict";
import test from "node:test";

import {
  type CellResult,
  cellResultId,
  contentHash,
  datasetId,
  enrichmentRecipeId,
  eventId,
  fieldId,
  idempotencyKey,
  instant,
  type Run,
  type RunCommandReplayProof,
  recordId,
  runId,
  runPlanId,
  workspaceId,
} from "@kurobara/kernel";
import type {
  RunExecutionPersistencePort,
  RunExecutionUnitOfWork,
  WorkspaceScope,
} from "@kurobara/ports";

import { makeClaimRunExecution } from "../src/index.ts";

const workspace = workspaceId("workspace-test");
const initialRun: Run = {
  aggregateVersion: 1,
  createdAt: instant(1000),
  eventSequence: 1,
  idempotencyKey: idempotencyKey("create-test"),
  intentionHash: contentHash(`sha256:${"a".repeat(64)}`),
  resultCompleteness: "none",
  runId: runId("run-test"),
  runPlanId: runPlanId("plan-test"),
  state: "queued",
  workspaceId: workspace,
};

class FakeRunExecutionPersistence implements RunExecutionPersistencePort {
  cellResult: CellResult | undefined;
  cellResultUpdates = 0;
  events: import("@kurobara/kernel").RunLifecycleEvent[] = [];
  proof: RunCommandReplayProof | undefined;
  run: Run | undefined = initialRun;
  scheduledRuns: import("@kurobara/kernel").RunId[] = [];

  transaction<Value>(
    _scope: WorkspaceScope,
    work: (unitOfWork: RunExecutionUnitOfWork) => Promise<Value>
  ): Promise<Value> {
    return work({
      cellResults: {
        getByRun: async () => this.cellResult,
        markRunning: (_scope, _runId, cellResult) => {
          this.cellResult = cellResult;
          this.cellResultUpdates += 1;
          return Promise.resolve();
        },
      },
      commandJournal: {
        find: async (_scope, _runId, commandKey) =>
          this.proof?.identity.idempotencyKey === commandKey
            ? this.proof
            : undefined,
        insert: (_scope, proof) => {
          this.proof = proof;
          return Promise.resolve();
        },
      },
      dagSchedule: {
        request: (_scope, requestedRunId) => {
          this.scheduledRuns.push(requestedRunId);
          return Promise.resolve();
        },
      },
      runEvents: {
        append: (_scope, event) => {
          this.events.push(event);
          return Promise.resolve();
        },
      },
      runs: {
        getForUpdate: async () => this.run,
        update: (_scope, expectedVersion, run) => {
          if (this.run?.aggregateVersion !== expectedVersion) {
            return Promise.reject(new Error("Unexpected aggregate version."));
          }
          this.run = run;
          return Promise.resolve();
        },
      },
    });
  }
}

test("claims a queued run once and replays the same start key", async () => {
  const persistence = new FakeRunExecutionPersistence();
  let generatedEvents = 0;
  const claim = makeClaimRunExecution({
    clock: { now: async () => instant(2000) },
    identifiers: {
      nextEventId: () => {
        generatedEvents += 1;
        return Promise.resolve(eventId(`started-${generatedEvents}`));
      },
      nextOutboxMessageId: () => Promise.reject(new Error("not used")),
      nextRunId: () => Promise.reject(new Error("not used")),
    },
    persistence,
  });
  const input = {
    eventId: eventId("queued-event"),
    runId: initialRun.runId,
    startKey: "start-test",
    workspaceId: workspace,
  };

  const first = await claim(input);
  const replay = await claim(input);

  assert.equal(first.ok, true);
  assert.equal(replay.ok, true);
  if (first.ok && replay.ok) {
    assert.equal(first.value.run.state, "running");
    assert.equal(first.value.replayed, false);
    assert.equal(replay.value.replayed, true);
  }
  assert.equal(persistence.events.length, 1);
  assert.equal(generatedEvents, 1);
  assert.deepEqual(persistence.scheduledRuns, [
    initialRun.runId,
    initialRun.runId,
  ]);
});

test("does not let another start key claim an already running run", async () => {
  const persistence = new FakeRunExecutionPersistence();
  const claim = makeClaimRunExecution({
    clock: { now: async () => instant(2000) },
    identifiers: {
      nextEventId: async () => eventId("started-event"),
      nextOutboxMessageId: () => Promise.reject(new Error("not used")),
      nextRunId: () => Promise.reject(new Error("not used")),
    },
    persistence,
  });
  const base = {
    eventId: eventId("queued-event"),
    runId: initialRun.runId,
    workspaceId: workspace,
  };
  assert.equal((await claim({ ...base, startKey: "start-one" })).ok, true);
  const collision = await claim({ ...base, startKey: "start-two" });
  assert.equal(collision.ok, false);
  if (!collision.ok) {
    assert.equal(collision.error.domainCode, "invalid-transition");
  }
  assert.deepEqual(persistence.scheduledRuns, [initialRun.runId]);
});

test("moves a bound CellResult to running in the same claimed transaction", async () => {
  const persistence = new FakeRunExecutionPersistence();
  persistence.cellResult = {
    cellResultId: cellResultId("cell-result-test"),
    datasetId: datasetId("dataset-test"),
    enrichmentRecipeId: enrichmentRecipeId("recipe-test"),
    fieldId: fieldId("field-target"),
    recipeRevision: "1.0.0",
    recordId: recordId("record-test"),
    runId: initialRun.runId,
    status: "pending",
    workspaceId: workspace,
  };
  const claim = makeClaimRunExecution({
    clock: { now: async () => instant(2000) },
    identifiers: {
      nextEventId: async () => eventId("started-cell-event"),
      nextOutboxMessageId: () => Promise.reject(new Error("not used")),
      nextRunId: () => Promise.reject(new Error("not used")),
    },
    persistence,
  });
  const input = {
    eventId: eventId("queued-cell-event"),
    runId: initialRun.runId,
    startKey: "start-cell-test",
    workspaceId: workspace,
  };

  assert.equal((await claim(input)).ok, true);
  assert.equal((await claim(input)).ok, true);
  assert.equal(persistence.cellResult?.status, "running");
  assert.equal(persistence.cellResultUpdates, 1);
});

test("does not persist a Run claim when its bound CellResult cannot enter running", async () => {
  const persistence = new FakeRunExecutionPersistence();
  persistence.cellResult = {
    cellResultId: cellResultId("cell-result-terminal"),
    datasetId: datasetId("dataset-test"),
    enrichmentRecipeId: enrichmentRecipeId("recipe-test"),
    fieldId: fieldId("field-target"),
    recipeRevision: "1.0.0",
    recordId: recordId("record-test"),
    runId: initialRun.runId,
    status: "succeeded",
    value: "already-terminal",
    workspaceId: workspace,
  };
  const claim = makeClaimRunExecution({
    clock: { now: async () => instant(2000) },
    identifiers: {
      nextEventId: async () => eventId("started-terminal-cell-event"),
      nextOutboxMessageId: () => Promise.reject(new Error("not used")),
      nextRunId: () => Promise.reject(new Error("not used")),
    },
    persistence,
  });

  const result = await claim({
    eventId: eventId("queued-terminal-cell-event"),
    runId: initialRun.runId,
    startKey: "start-terminal-cell-test",
    workspaceId: workspace,
  });

  assert.equal(result.ok, false);
  assert.equal(persistence.run, initialRun);
  assert.equal(persistence.cellResultUpdates, 0);
  assert.deepEqual(persistence.events, []);
  assert.equal(persistence.proof, undefined);
  assert.deepEqual(persistence.scheduledRuns, []);
});
