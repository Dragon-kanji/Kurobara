import assert from "node:assert/strict";
import test from "node:test";

import {
  attemptId,
  contentHash,
  operationKey,
  routingDecisionId,
  runId,
  stepRunId,
  workspaceId,
} from "@kurobara/kernel";

import { createDeterministicLeafEffect } from "../src/index.ts";

const request = {
  attemptId: attemptId("attempt-deterministic"),
  operationKey: operationKey("operation-deterministic"),
  reservationUnit: "credits",
  reservedAmount: 2,
  routeSnapshotHash: contentHash(`sha256:${"a".repeat(64)}`),
  routingDecisionId: routingDecisionId("route-deterministic"),
  runId: runId("run-deterministic"),
  stepRunId: stepRunId("step-deterministic"),
  workspaceId: workspaceId("workspace-deterministic"),
} as const;

test("returns a receipt only after execution in the current process", async () => {
  const effect = createDeterministicLeafEffect();

  const absent = await effect.port.lookup(request);
  const executed = await effect.port.execute(request);
  const lookedUp = await effect.port.lookup(request);

  assert.deepEqual(absent, {
    proofId: "deterministic:attempt-deterministic",
    status: "not-found",
  });
  assert.equal(executed.status, "succeeded");
  if (executed.status === "succeeded") {
    assert.deepEqual(executed.output, {
      adapter: "deterministic-local",
      attempt_id: "attempt-deterministic",
      operation_key: "operation-deterministic",
      run_id: "run-deterministic",
      status: "succeeded",
      step_run_id: "step-deterministic",
    });
  }
  assert.equal(lookedUp.status, "found");
  if (executed.status === "succeeded" && lookedUp.status === "found") {
    assert.deepEqual(lookedUp.outcome, executed);
    assert.equal(lookedUp.proofId, "deterministic:attempt-deterministic");
  }
  assert.equal(effect.history().executions.length, 1);
  assert.equal(effect.history().lookups.length, 2);
});

test("rejects invalid reservation data at the adapter boundary", async () => {
  const effect = createDeterministicLeafEffect();

  await assert.rejects(
    () => effect.port.execute({ ...request, reservedAmount: Number.NaN }),
    RangeError
  );
});

test("allows the composition root to select a contract-specific fixture output", async () => {
  const effect = createDeterministicLeafEffect({
    outputFor: () => ({ value: "https://fixture.invalid/example" }),
  });

  const outcome = await effect.port.execute(request);

  assert.equal(outcome.status, "succeeded");
  if (outcome.status === "succeeded") {
    assert.deepEqual(outcome.output, {
      value: "https://fixture.invalid/example",
    });
  }
});
