import assert from "node:assert/strict";
import test from "node:test";

import {
  contentHash,
  idempotencyKey,
  instant,
  runId,
  runPlanId,
  workspaceId,
} from "@kurobara/kernel";
import type { RunQueryPort, RunSnapshotRecord } from "@kurobara/ports";

import { makeGetRun } from "../src/get-run.ts";

const workspace = workspaceId("workspace-test");
const stored: RunSnapshotRecord = {
  cost: { reserved: 2, spent: 1, unit: "credits" },
  run: {
    aggregateVersion: 1,
    createdAt: instant(1000),
    eventSequence: 1,
    idempotencyKey: idempotencyKey("idempotency-test"),
    intentionHash: contentHash(`sha256:${"a".repeat(64)}`),
    resultCompleteness: "none",
    runId: runId("run-test"),
    runPlanId: runPlanId("plan-test"),
    state: "queued",
    workspaceId: workspace,
  },
};

test("returns a tenant-scoped run snapshot for an authorized actor", async () => {
  const calls: unknown[] = [];
  const runs: RunQueryPort = {
    get: (scope, requestedRunId) => {
      calls.push({ requestedRunId, scope });
      return Promise.resolve(stored);
    },
  };
  const getRun = makeGetRun({ requiredPermission: "runs:read", runs });

  const result = await getRun({
    actorPermissions: ["runs:read"],
    runId: runId("run-test"),
    workspaceId: workspace,
  });

  assert.deepEqual(result, { ok: true, value: stored });
  assert.deepEqual(calls, [
    {
      requestedRunId: runId("run-test"),
      scope: { workspaceId: workspace },
    },
  ]);
});

test("rejects missing permission before querying persistence", async () => {
  let queried = false;
  const getRun = makeGetRun({
    requiredPermission: "runs:read",
    runs: {
      get: () => {
        queried = true;
        return Promise.resolve(stored);
      },
    },
  });

  const result = await getRun({
    actorPermissions: ["runs:create"],
    runId: runId("run-test"),
    workspaceId: workspace,
  });

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, "authority-permission-missing");
  }
  assert.equal(queried, false);
});

test("does not reveal whether a run exists in another workspace", async () => {
  const getRun = makeGetRun({
    requiredPermission: "runs:read",
    runs: { get: () => Promise.resolve(undefined) },
  });

  const result = await getRun({
    actorPermissions: ["runs:read"],
    runId: runId("run-other"),
    workspaceId: workspace,
  });

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, "run-not-found");
  }
});
