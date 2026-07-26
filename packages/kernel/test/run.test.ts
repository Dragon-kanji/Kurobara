import assert from "node:assert/strict";
import test from "node:test";

import {
  actorId,
  capabilityId,
  contentHash,
  correlationId,
  createRunFromPlan,
  eventId,
  idempotencyKey,
  instant,
  type RunPlan,
  runId,
  runPlanId,
  workflowSpecId,
  workspaceId,
} from "../src/index.ts";

const hash = (value: string) =>
  contentHash(`sha256:${value.repeat(64).slice(0, 64)}`);
const capability = {
  capabilityId: capabilityId("documents.summarize"),
  capabilityVersion: "1.0.0",
};

const plan = (overrides: Partial<RunPlan> = {}): RunPlan => {
  const workspace = workspaceId("workspace-test");
  return {
    authority: {
      authorityEnvelopeId: "authority-test",
      budgetLimit: { limit: 10, reserved: 0, spent: 0, unit: "credits" },
      capabilities: [capability],
      deadline: instant(20_000),
      permissions: ["runs:create"],
      subjectActorId: actorId("actor-test"),
      version: "1.0.0",
      workspaceId: workspace,
    },
    budget: { limit: 5, reserved: 0, spent: 0, unit: "credits" },
    catalogFingerprint: hash("a"),
    catalogVersion: "1.0.0",
    compiledWorkflow: {
      compilerVersion: "1.0.0",
      fingerprint: "summarize:",
      nodes: [{ capability, dependsOn: [], depth: 0, key: "summarize" }],
      workflowContentHash: hash("b"),
      workflowRevision: "1.0.0",
      workflowSpecId: workflowSpecId("workflow-test"),
    },
    deadline: instant(15_000),
    inputContract: {
      catalogFingerprint: hash("a"),
      catalogVersion: "1.0.0",
      schemaFingerprint: hash("c"),
      schemaId: "https://schemas.kurobara.dev/schemas/inputs/document/1.0.0",
      schemaVersion: "1.0.0",
    },
    normalizedInputHash: hash("d"),
    outputContract: {
      catalogFingerprint: hash("a"),
      catalogVersion: "1.0.0",
      schemaFingerprint: hash("e"),
      schemaId: "https://schemas.kurobara.dev/schemas/outputs/summary/1.0.0",
      schemaVersion: "1.0.0",
    },
    planHash: hash("f"),
    policyFactsHash: hash("1"),
    policyVersion: "1.0.0",
    quote: {
      expiresAt: instant(10_000),
      guarantee: "hard",
      pricingVersion: "1.0.0",
      quoteId: "quote-test",
      unit: "credits",
      upperBound: 5,
    },
    retryPolicy: { maxAttemptsPerStep: 3 },
    runPlanId: runPlanId("plan-test"),
    workspaceId: workspace,
    ...overrides,
  };
};

const decide = (runPlan: RunPlan, now = instant(1000)) =>
  createRunFromPlan({
    actorId: actorId("actor-test"),
    correlationId: correlationId("correlation-test"),
    eventId: eventId("event-test"),
    idempotencyKey: idempotencyKey("idempotency-test"),
    intentionHash: runPlan.planHash,
    now,
    plan: runPlan,
    requiredPermission: "runs:create",
    runId: runId("run-test"),
  });

test("creates a queued run and initial event from a valid immutable plan", () => {
  const result = decide(plan());

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.value.run.state, "queued");
    assert.equal(result.value.event.eventType, "RunQueued");
    assert.equal(result.value.run.aggregateVersion, 1);
    assert.equal(result.value.event.sequence, 1);
  }
});

test("refuses an expired quote without creating a run", () => {
  const result = decide(plan(), instant(10_000));

  assert.deepEqual(result, {
    error: { code: "quote-expired", message: "The plan quote has expired." },
    ok: false,
  });
});

test("refuses a plan whose budget exceeds its authority envelope", () => {
  const result = decide(
    plan({ budget: { limit: 11, reserved: 0, spent: 0, unit: "credits" } })
  );

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, "invalid-budget");
  }
});

test("refuses a plan after its execution or authority deadline", () => {
  const source = plan();
  const validQuote = { ...source.quote, expiresAt: instant(30_000) };
  const planDeadline = decide(
    plan({ deadline: instant(500), quote: validQuote }),
    instant(1000)
  );
  const authorityDeadline = decide(
    plan({
      authority: { ...source.authority, deadline: instant(500) },
      quote: validQuote,
    }),
    instant(1000)
  );

  assert.equal(planDeadline.ok, false);
  assert.equal(authorityDeadline.ok, false);
  if (!(planDeadline.ok || authorityDeadline.ok)) {
    assert.equal(planDeadline.error.code, "deadline-elapsed");
    assert.equal(authorityDeadline.error.code, "deadline-elapsed");
  }
});

test("refuses capabilities and permissions outside the authority envelope", () => {
  const source = plan();
  const missingCapability = decide(
    plan({ authority: { ...source.authority, capabilities: [] } })
  );
  const missingPermission = decide(
    plan({ authority: { ...source.authority, permissions: [] } })
  );

  assert.equal(missingCapability.ok, false);
  assert.equal(missingPermission.ok, false);
  if (!(missingCapability.ok || missingPermission.ok)) {
    assert.equal(missingCapability.error.code, "authority-capability-missing");
    assert.equal(missingPermission.error.code, "authority-permission-missing");
  }
});

test("refuses an authenticated actor outside the authority envelope", () => {
  const source = plan();
  const result = decide(
    plan({
      authority: {
        ...source.authority,
        subjectActorId: actorId("actor-other"),
      },
    })
  );

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, "authority-subject-mismatch");
  }
});

test("refuses an unsupported authority envelope version", () => {
  const source = plan();
  const result = decide(
    plan({ authority: { ...source.authority, version: "2.0.0" } })
  );

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, "authority-version-unsupported");
  }
});
