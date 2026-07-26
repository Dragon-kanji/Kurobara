import assert from "node:assert/strict";
import test from "node:test";

import {
  actorId,
  contentHash,
  eventId,
  idempotencyKey,
  instant,
  type Run,
  type RunCommandReplayProof,
  runId,
  runPlanId,
  workspaceId,
} from "@kurobara/kernel";
import type {
  RunExecutionPersistencePort,
  RunExecutionUnitOfWork,
  VerifiedApiKey,
  WorkspaceScope,
} from "@kurobara/ports";

import { makeCancelRun, makeClaimRunExecution } from "../src/index.ts";

const workspace = workspaceId("workspace-test");
const otherWorkspace = workspaceId("workspace-other");
const baseRun: Run = {
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
const actor: VerifiedApiKey = {
  actorId: actorId("actor-test"),
  authenticationMode: "api-key",
  credentialId: "credential-test",
  permissions: ["runs:cancel"],
  workspaceId: workspace,
};

class FakeRunExecutionPersistence implements RunExecutionPersistencePort {
  readonly events: import("@kurobara/kernel").RunLifecycleEvent[] = [];
  readonly scheduledRuns: import("@kurobara/kernel").RunId[] = [];
  proof: RunCommandReplayProof | undefined;
  run: Run | undefined;
  transactionCalls = 0;

  constructor(run: Run | undefined = baseRun) {
    this.run = run;
  }

  transaction<Value>(
    scope: WorkspaceScope,
    work: (unitOfWork: RunExecutionUnitOfWork) => Promise<Value>
  ): Promise<Value> {
    this.transactionCalls += 1;
    return work({
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
        request: (_scope, selectedRunId) => {
          this.scheduledRuns.push(selectedRunId);
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
        getForUpdate: async () =>
          this.run?.workspaceId === scope.workspaceId ? this.run : undefined,
        update: (_scope, expectedVersion, run) => {
          if (this.run?.aggregateVersion !== expectedVersion) {
            throw new Error("The fake aggregate version fence was violated.");
          }
          this.run = run;
          return Promise.resolve();
        },
      },
    });
  }
}

const makeCancellation = (persistence: FakeRunExecutionPersistence) => {
  let generatedEvents = 0;
  return {
    cancel: makeCancelRun({
      clock: { now: async () => instant(2000) },
      identifiers: {
        nextEventId: () => {
          generatedEvents += 1;
          return Promise.resolve(eventId(`cancel-event-${generatedEvents}`));
        },
      },
      persistence,
      requiredPermission: "runs:cancel",
    }),
    generatedEvents: () => generatedEvents,
  };
};

const request = {
  actor,
  correlationId: "correlation-test",
  idempotencyKey: "cancel-test",
  runId: "run-test",
} as const;

test("cancels a queued run atomically and safely replays the terminal snapshot", async () => {
  const persistence = new FakeRunExecutionPersistence();
  const { cancel, generatedEvents } = makeCancellation(persistence);

  const first = await cancel(request);
  const replay = await cancel(request);

  assert.equal(first.ok, true);
  assert.equal(replay.ok, true);
  if (first.ok && replay.ok) {
    assert.equal(first.value.run.state, "cancelled");
    assert.equal(first.value.replayed, false);
    assert.equal(replay.value.run.state, "cancelled");
    assert.equal(replay.value.replayed, true);
  }
  assert.deepEqual(
    persistence.events.map(({ eventType }) => eventType),
    ["RunStopRequested", "RunCancelled"]
  );
  assert.equal(persistence.proof?.commandType, "RequestStop");
  assert.equal(generatedEvents(), 2);
});

test("moves running and waiting runs to cancelling and requests convergence once", async () => {
  await Promise.all(
    (["running", "waiting"] as const).map(async (state) => {
      const persistence = new FakeRunExecutionPersistence({
        ...baseRun,
        aggregateVersion: 2,
        eventSequence: 2,
        state,
      });
      const { cancel } = makeCancellation(persistence);
      const result = await cancel(request);
      const replay = await cancel(request);

      assert.equal(result.ok, true);
      assert.equal(replay.ok, true);
      if (result.ok) {
        assert.equal(result.value.run.state, "cancelling");
        assert.equal(result.value.run.pendingStopReason, "requested");
      }
      assert.deepEqual(
        persistence.events.map(({ eventType }) => eventType),
        ["RunStopRequested", "RunCancelling"]
      );
      assert.deepEqual(persistence.scheduledRuns, [persistence.run?.runId]);
    })
  );
});

test("replays the current terminal snapshot after ambiguity reconciliation", async () => {
  const persistence = new FakeRunExecutionPersistence({
    ...baseRun,
    aggregateVersion: 2,
    eventSequence: 2,
    state: "ambiguous",
  });
  const { cancel } = makeCancellation(persistence);

  const first = await cancel(request);
  assert.equal(first.ok, true);
  if (!first.ok) {
    return;
  }
  persistence.run = {
    ...first.value.run,
    aggregateVersion: first.value.run.aggregateVersion + 2,
    eventSequence: first.value.run.eventSequence + 3,
    pendingStopReason: undefined,
    resultCompleteness: "complete",
    state: "completed",
  };

  const replay = await cancel(request);
  assert.equal(replay.ok, true);
  if (replay.ok) {
    assert.equal(replay.value.replayed, true);
    assert.equal(replay.value.run.state, "completed");
  }
  assert.equal(persistence.events.length, 1);
  assert.deepEqual(persistence.scheduledRuns, []);
});

test("authorizes before tenant-scoped lookup and does not reveal foreign runs", async () => {
  const persistence = new FakeRunExecutionPersistence();
  const { cancel } = makeCancellation(persistence);
  const forbidden = await cancel({
    ...request,
    actor: { ...actor, permissions: [] },
    runId: "run-secret",
  });
  assert.equal(forbidden.ok, false);
  if (!forbidden.ok) {
    assert.equal(forbidden.error.code, "authority-permission-missing");
  }
  assert.equal(persistence.transactionCalls, 0);

  const foreign = await cancel({
    ...request,
    actor: { ...actor, workspaceId: otherWorkspace },
  });
  assert.equal(foreign.ok, false);
  if (!foreign.ok) {
    assert.equal(foreign.error.code, "run-not-found");
  }
});

test("rejects an idempotency key already bound to another command", async () => {
  const persistence = new FakeRunExecutionPersistence();
  persistence.proof = {
    commandType: "ClaimRun",
    identity: {
      commandHash: contentHash(`sha256:${"b".repeat(64)}`),
      idempotencyKey: idempotencyKey(request.idempotencyKey),
    },
    runId: baseRun.runId,
    workspaceId: workspace,
  };
  const { cancel } = makeCancellation(persistence);

  const result = await cancel(request);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, "idempotency-key-reused");
  }
  assert.equal(persistence.run, baseRun);
  assert.deepEqual(persistence.events, []);
});

test("a queued cancellation prevents the orchestration claim and any DAG scheduling", async () => {
  const persistence = new FakeRunExecutionPersistence();
  const { cancel } = makeCancellation(persistence);
  assert.equal((await cancel(request)).ok, true);

  const claim = makeClaimRunExecution({
    clock: { now: async () => instant(3000) },
    identifiers: {
      nextEventId: async () => eventId("claim-event"),
      nextOutboxMessageId: () => Promise.reject(new Error("not used")),
      nextRunId: () => Promise.reject(new Error("not used")),
    },
    persistence,
  });
  const result = await claim({
    eventId: eventId("queued-event"),
    runId: baseRun.runId,
    startKey: "start-after-cancel",
    workspaceId: workspace,
  });

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.domainCode, "invalid-transition");
  }
  assert.deepEqual(persistence.scheduledRuns, []);
  assert.equal(persistence.run?.state, "cancelled");
});
