import assert from "node:assert/strict";
import test from "node:test";

import { actorId, instant, workspaceId } from "@kurobara/kernel";
import type { VerifiedApiKey } from "@kurobara/ports";

import { makeCreateRun, makeGetRunById } from "../src/index.ts";

const actor: VerifiedApiKey = {
  actorId: actorId("actor-test"),
  authenticationMode: "api-key",
  credentialId: "credential-test",
  permissions: ["runs:create", "runs:read"],
  workspaceId: workspaceId("workspace-test"),
};

test("rejects malformed public run creation values before persistence", async () => {
  let persisted = false;
  const createRun = makeCreateRun({
    clock: { now: async () => instant(1000) },
    identifiers: {
      nextEventId: () => Promise.reject(new Error("not reached")),
      nextOutboxMessageId: () => Promise.reject(new Error("not reached")),
      nextRunId: () => Promise.reject(new Error("not reached")),
    },
    persistence: {
      transaction: () => {
        persisted = true;
        return Promise.reject(new Error("not reached"));
      },
    },
    requiredPermission: "runs:create",
  });

  const result = await createRun({
    actor,
    correlationId: "correlation-test",
    idempotencyKey: "idempotency-test",
    intentionHash: "not-a-content-hash",
    runPlanId: "plan-test",
  });

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, "request-invalid");
  }
  assert.equal(persisted, false);
});

test("rejects an empty public run identifier before the query port", async () => {
  let queried = false;
  const getRun = makeGetRunById({
    requiredPermission: "runs:read",
    runs: {
      get: () => {
        queried = true;
        return Promise.resolve(undefined);
      },
    },
  });

  const result = await getRun({ actor, runId: "" });

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, "request-invalid");
  }
  assert.equal(queried, false);
});
