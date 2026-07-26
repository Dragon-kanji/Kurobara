import assert from "node:assert/strict";
import test from "node:test";

import {
  attemptId,
  eventId,
  runId,
  type StepRun,
  stepRunId,
  succeed,
  workspaceId,
} from "@kurobara/kernel";
import type {
  LeafEffectRecoveryClaim,
  LeafEffectRecoveryPort,
  ReleaseLeafEffectRecoveryInput,
  SettleLeafEffectRecoveryInput,
  StartLeafAttemptRequest,
} from "@kurobara/ports";

import { makeReconcileLeafEffects } from "../src/reconcile-leaf-effects.ts";

const claim = (): LeafEffectRecoveryClaim => ({
  attempt: 1,
  attemptId: attemptId("attempt-recovery"),
  claimedBy: "effect-reconciler-test",
  claimToken: "claim-recovery",
  effectAdapterKey: "effect-test-v1",
  eventId: eventId("event-recovery"),
  runId: runId("run-recovery"),
  startKey: "effect:attempt-recovery",
  stepRunId: stepRunId("step-recovery"),
  workspaceId: workspaceId("workspace-recovery"),
});

class FakeRecovery implements LeafEffectRecoveryPort {
  readonly completed: SettleLeafEffectRecoveryInput[] = [];
  readonly released: ReleaseLeafEffectRecoveryInput[] = [];
  private pending: LeafEffectRecoveryClaim | undefined = claim();

  claimNextForSystem(): Promise<LeafEffectRecoveryClaim | undefined> {
    const claimed = this.pending;
    this.pending = undefined;
    return Promise.resolve(claimed);
  }

  complete(input: SettleLeafEffectRecoveryInput) {
    this.completed.push(input);
    return Promise.resolve({ status: "settled" as const });
  }

  reapForSystem() {
    return Promise.resolve({ completed: 0, exhausted: 0 });
  }

  release(input: ReleaseLeafEffectRecoveryInput) {
    this.released.push(input);
    return Promise.resolve({ status: "settled" as const });
  }
}

const stepRun = {} as StepRun;

const reconcileWith = (
  recovery: FakeRecovery,
  executeLeafAttempt: (
    request: StartLeafAttemptRequest
  ) => ReturnType<
    Parameters<typeof makeReconcileLeafEffects>[0]["executeLeafAttempt"]
  >,
  operationTimeoutMilliseconds = 10_000
) =>
  makeReconcileLeafEffects({
    batchSize: 10,
    claimLeaseMilliseconds: Math.max(30_000, operationTimeoutMilliseconds * 2),
    effectAdapterKey: "effect-test-v1",
    executeLeafAttempt,
    operationTimeoutMilliseconds,
    operatorId: "effect-reconciler-test",
    recovery,
    retryDelayMilliseconds: 5000,
  });

test("completes a recovered terminal leaf through its exact durable identity", async () => {
  const recovery = new FakeRecovery();
  const requests: StartLeafAttemptRequest[] = [];
  const reconcile = reconcileWith(recovery, (request) => {
    requests.push(request);
    return Promise.resolve(
      succeed({ replayed: true, status: "succeeded" as const, stepRun })
    );
  });

  const result = await reconcile();

  assert.deepEqual(requests, [
    {
      attemptId: attemptId("attempt-recovery"),
      eventId: eventId("event-recovery"),
      runId: runId("run-recovery"),
      startKey: "effect:attempt-recovery",
      stepRunId: stepRunId("step-recovery"),
      workspaceId: workspaceId("workspace-recovery"),
    },
  ]);
  assert.equal(result.claimed, 1);
  assert.equal(result.items[0]?.status, "completed");
  assert.equal(recovery.completed.length, 1);
  assert.equal(recovery.released.length, 0);
});

test("releases an ambiguous outcome with a fixed redacted reason", async () => {
  const recovery = new FakeRecovery();
  const reconcile = reconcileWith(recovery, () =>
    Promise.resolve(
      succeed({ replayed: true, status: "ambiguous" as const, stepRun })
    )
  );

  const result = await reconcile();

  assert.deepEqual(result.items[0], {
    attemptId: attemptId("attempt-recovery"),
    reason: "leaf-effect-recovery-outcome-unknown",
    status: "unresolved",
  });
  assert.equal(recovery.completed.length, 0);
  assert.equal(recovery.released.length, 1);
  assert.equal(
    recovery.released[0]?.reason,
    "leaf-effect-recovery-outcome-unknown"
  );
});

test("bounds a hung recovery operation and ignores its late completion", async () => {
  const recovery = new FakeRecovery();
  let resolveExecution: (
    result: Awaited<
      ReturnType<
        Parameters<typeof makeReconcileLeafEffects>[0]["executeLeafAttempt"]
      >
    >
  ) => void = () => undefined;
  const execution = new Promise<
    Awaited<
      ReturnType<
        Parameters<typeof makeReconcileLeafEffects>[0]["executeLeafAttempt"]
      >
    >
  >((resolve) => {
    resolveExecution = resolve;
  });
  const reconcile = reconcileWith(recovery, () => execution, 10);

  const result = await reconcile();
  resolveExecution(
    succeed({ replayed: true, status: "succeeded" as const, stepRun })
  );
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.equal(result.items[0]?.status, "unresolved");
  assert.equal(recovery.released.length, 1);
  assert.equal(
    recovery.released[0]?.reason,
    "leaf-effect-recovery-operation-failed"
  );
  assert.equal(recovery.completed.length, 0);
});
