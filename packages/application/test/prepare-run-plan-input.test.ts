import assert from "node:assert/strict";
import test from "node:test";

import {
  actorId,
  capabilityId,
  contentHash,
  instant,
  type RunPlan,
  runPlanId,
  workflowSpecId,
  workspaceId,
} from "@kurobara/kernel";
import type { InputContractValidatorPort } from "@kurobara/ports";
import { canonicalContentHash } from "../src/canonical-content-hash.ts";
import {
  makePrepareRunPlanInputContent,
  prepareRunPlan,
} from "../src/index.ts";

const hash = (marker: string) =>
  contentHash(`sha256:${marker.repeat(64).slice(0, 64)}`);
const workspace = workspaceId("workspace-input-test");
const capability = {
  capabilityId: capabilityId("documents.summarize"),
  capabilityVersion: "1.0.0",
};
const RUN_INPUT_ID_PATTERN = /^run_input_[0-9a-f]{64}$/u;
const contract = {
  catalogFingerprint: hash("a"),
  catalogVersion: "1.0.0",
  schemaFingerprint: hash("b"),
  schemaId: "https://schemas.kurobara.invalid/input/1.0.0",
  schemaVersion: "1.0.0",
};

const planFor = (value: unknown): RunPlan => {
  const result = prepareRunPlan({
    actorPermissions: ["runs:create"],
    allowedCapabilities: [capability.capabilityId],
    authority: {
      authorityEnvelopeId: "authority-input-test",
      budgetLimit: { limit: 5, reserved: 0, spent: 0, unit: "credits" },
      capabilities: [capability],
      deadline: instant(20_000),
      permissions: ["runs:create"],
      subjectActorId: actorId("actor-input-test"),
      version: "1.0.0",
      workspaceId: workspace,
    },
    budget: { limit: 5, reserved: 0, spent: 0, unit: "credits" },
    catalogFingerprint: contract.catalogFingerprint,
    catalogVersion: contract.catalogVersion,
    compilationLimits: { maxDepth: 2, maxFanOut: 2, maxNodes: 2 },
    compilerVersion: "1.0.0",
    deadline: instant(15_000),
    inputContract: contract,
    normalizedInputHash: canonicalContentHash(value),
    now: instant(1000),
    outputContract: contract,
    planHash: hash("c"),
    policy: {
      factsHash: hash("d"),
      requiredPermission: "runs:create",
      version: "1.0.0",
    },
    quote: {
      expiresAt: instant(10_000),
      guarantee: "hard",
      pricingVersion: "1.0.0",
      quoteId: "quote-input-test",
      unit: "credits",
      upperBound: 5,
    },
    retryPolicy: { maxAttemptsPerStep: 3 },
    runPlanId: runPlanId("plan-input-test"),
    workflow: {
      contentHash: hash("e"),
      nodes: [{ capability, dependsOn: [], key: "summarize" }],
      revision: "1.0.0",
      workflowSpecId: workflowSpecId("workflow-input-test"),
    },
    workspaceId: workspace,
  });
  if (!result.ok) {
    throw new Error(`Plan fixture rejected: ${result.error.code}`);
  }
  return result.value;
};

const acceptedValidator = (): InputContractValidatorPort => ({
  validate: () =>
    Promise.resolve({
      status: "accepted",
      validatorVersion: "synthetic-validator-1",
    }),
});

test("prepares a bounded immutable input proof for the exact plan", async () => {
  const value = { document: "synthetic", options: [true, 2] } as const;
  const execute = makePrepareRunPlanInputContent({
    clock: { now: () => Promise.resolve(instant(2000)) },
    validator: acceptedValidator(),
  });

  const result = await execute({ plan: planFor(value), value });

  assert.equal(result.ok, true);
  if (!result.ok) {
    return;
  }
  assert.equal(result.value.contentHash, canonicalContentHash(value));
  assert.equal(result.value.contract, planFor(value).inputContract);
  assert.equal(result.value.classification, "internal");
  assert.equal(result.value.mediaType, "application/json");
  assert.equal(result.value.validatedAt, instant(2000));
  assert.match(result.value.inputId, RUN_INPUT_ID_PATTERN);
});

test("rejects a value that does not match the immutable plan hash", async () => {
  const execute = makePrepareRunPlanInputContent({
    clock: { now: () => Promise.resolve(instant(2000)) },
    validator: acceptedValidator(),
  });

  const result = await execute({
    plan: planFor({ document: "expected" }),
    value: { document: "different" },
  });

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, "input-hash-mismatch");
  }
});

test("fails closed on hostile shape, oversize content and contract rejection", async () => {
  const accepted = makePrepareRunPlanInputContent({
    clock: { now: () => Promise.resolve(instant(2000)) },
    validator: acceptedValidator(),
  });
  const hostile = JSON.parse('{"__proto__":{"polluted":true}}') as never;
  const hostileResult = await accepted({
    plan: planFor(hostile),
    value: hostile,
  });
  assert.equal(hostileResult.ok, false);
  if (!hostileResult.ok) {
    assert.equal(hostileResult.error.code, "input-invalid");
  }

  const oversized = "x".repeat(65_537);
  const oversizedResult = await accepted({
    plan: planFor(oversized),
    value: oversized,
  });
  assert.equal(oversizedResult.ok, false);
  if (!oversizedResult.ok) {
    assert.equal(oversizedResult.error.code, "input-too-large");
  }

  const rejected = makePrepareRunPlanInputContent({
    clock: { now: () => Promise.resolve(instant(2000)) },
    validator: {
      validate: () =>
        Promise.resolve({ reason: "synthetic", status: "rejected" }),
    },
  });
  const value = { document: "synthetic" } as const;
  const contractResult = await rejected({ plan: planFor(value), value });
  assert.equal(contractResult.ok, false);
  if (!contractResult.ok) {
    assert.equal(contractResult.error.code, "input-contract-rejected");
  }
});

test("does not persist a proof when the validator is unavailable", async () => {
  const value = { document: "synthetic" } as const;
  const execute = makePrepareRunPlanInputContent({
    clock: { now: () => Promise.resolve(instant(2000)) },
    validator: {
      validate: () => Promise.reject(new Error("synthetic validator outage")),
    },
  });

  const result = await execute({ plan: planFor(value), value });

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, "validator-unavailable");
    assert.equal(
      JSON.stringify(result).includes("synthetic validator outage"),
      false
    );
  }
});
