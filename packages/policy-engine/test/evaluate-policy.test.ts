import assert from "node:assert/strict";
import test from "node:test";

import {
  type AuthorityEnvelope,
  actorId,
  capabilityId,
  contentHash,
  instant,
  workspaceId,
} from "@kurobara/kernel";

import { evaluatePolicy, type PolicySnapshot } from "../src/index.ts";

const workspace = workspaceId("workspace-test");
const capability = {
  capabilityId: capabilityId("documents.summarize"),
  capabilityVersion: "1.0.0",
};
const authority: AuthorityEnvelope = {
  authorityEnvelopeId: "authority-test",
  budgetLimit: { limit: 5, reserved: 0, spent: 0, unit: "credits" },
  capabilities: [capability],
  deadline: instant(10_000),
  permissions: ["runs:create"],
  subjectActorId: actorId("actor-test"),
  version: "1.0.0",
  workspaceId: workspace,
};
const policy: PolicySnapshot = {
  factsHash: contentHash(`sha256:${"a".repeat(64)}`),
  requiredPermission: "runs:create",
  version: "1.0.0",
};

test("returns a stable allowed decision for identical snapshots", () => {
  const facts = {
    actorPermissions: ["runs:create"],
    authority,
    capability,
    now: instant(1000),
    workspaceId: workspace,
  };

  assert.deepEqual(
    evaluatePolicy(policy, facts),
    evaluatePolicy(policy, facts)
  );
  assert.deepEqual(evaluatePolicy(policy, facts).reasonCodes, ["allowed"]);
});

test("returns explicit reason codes when permission and authority are insufficient", () => {
  const decision = evaluatePolicy(policy, {
    actorPermissions: [],
    authority: { ...authority, capabilities: [] },
    capability,
    now: instant(1000),
    workspaceId: workspace,
  });

  assert.equal(decision.allowed, false);
  assert.deepEqual(decision.reasonCodes, [
    "permission-missing",
    "capability-outside-authority",
  ]);
});
