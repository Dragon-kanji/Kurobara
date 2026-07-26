import assert from "node:assert/strict";
import test from "node:test";

import {
  normalizedJsonEvidence,
  parseArtifact,
} from "../src/artifact-payload.ts";
import { DatabasePayloadError } from "../src/errors.ts";
import { toJsonValue } from "../src/json.ts";
import {
  parseRun,
  parseRunCommandReplayProof,
  parseRunPlan,
} from "../src/payload.ts";
import { parsePolicyPlanningSnapshot } from "../src/planning-payload.ts";
import {
  parseRunPlanInputRow,
  parseValidatedRunInput,
} from "../src/run-input-payload.ts";
import {
  parseCostReservation,
  parseStepCommandReplayProof,
  parseStepRun,
  parseUsageEntry,
} from "../src/step-payload.ts";

test("normalizes a JSON payload without undefined properties", () => {
  assert.deepEqual(
    toJsonValue({ nested: { kept: true, omitted: undefined } }),
    { nested: { kept: true } }
  );
});

test("rejects non-JSON values before they reach PostgreSQL", () => {
  assert.throws(() => toJsonValue({ unsupported: 1n }), DatabasePayloadError);
});

test("recomputes canonical artifact evidence independently of object key order", () => {
  assert.deepEqual(
    normalizedJsonEvidence({ alpha: true, nested: { left: 1, right: 2 } }),
    normalizedJsonEvidence({ alpha: true, nested: { left: 1, right: 2 } })
  );
});

test("parses finalized output artifact metadata without embedding its payload", () => {
  const digest = `sha256:${"a".repeat(64)}`;
  const artifact = parseArtifact({
    artifactId: "artifact-test",
    attemptId: "attempt-test",
    classification: "internal",
    contentHash: digest,
    contract: {
      catalogFingerprint: digest,
      catalogVersion: "1.0.0",
      schemaFingerprint: digest,
      schemaId: "https://schemas.kurobara.invalid/test/1.0.0",
      schemaVersion: "1.0.0",
    },
    finalizedAt: 2000,
    kind: "normalized-output",
    mediaType: "application/json",
    operationKey: "operation-test",
    retentionPolicy: "run",
    runId: "run-test",
    sizeBytes: 2,
    state: "finalized",
    stepRunId: "step-test",
    validatedAt: 1900,
    validatorVersion: "json-schema-2020-12:test",
    workspaceId: "workspace-test",
  });

  assert.equal(artifact.artifactId, "artifact-test");
  assert.equal("normalizedPayload" in artifact, false);
});

const runInputFixture = (value: unknown) => {
  const parsedValue = value as Parameters<typeof normalizedJsonEvidence>[0];
  const evidence = normalizedJsonEvidence(parsedValue);
  const digest = `sha256:${"a".repeat(64)}`;
  return {
    classification: "internal" as const,
    contentHash: evidence.contentHash,
    contract: {
      catalogFingerprint: digest,
      catalogVersion: "1.0.0",
      schemaFingerprint: digest,
      schemaId: "https://schemas.kurobara.invalid/input/1.0.0",
      schemaVersion: "1.0.0",
    },
    finalizedAt: 2000,
    inputId: "input-test",
    mediaType: "application/json" as const,
    sizeBytes: evidence.sizeBytes,
    validatedAt: 1900,
    validatorVersion: "json-schema-2020-12:test",
    value: parsedValue,
  };
};

test("parses a bounded normalized run input and recomputes its row evidence", () => {
  const input = runInputFixture({ prompt: "synthetic", safe: true });
  assert.deepEqual(parseValidatedRunInput(input), input);
  assert.deepEqual(
    parseRunPlanInputRow({
      classification: input.classification,
      content_hash: input.contentHash,
      contract: input.contract,
      finalized_at: new Date(input.finalizedAt),
      input_id: input.inputId,
      media_type: input.mediaType,
      normalized_payload: input.value,
      run_plan_id: "plan-test",
      size_bytes: String(input.sizeBytes),
      validated_at: new Date(input.validatedAt),
      validator_version: input.validatorVersion,
      workspace_id: "workspace-test",
    }),
    input
  );
});

test("rejects tampered, oversized, or structurally extended run input evidence", () => {
  const input = runInputFixture({ prompt: "synthetic" });
  assert.throws(
    () =>
      parseValidatedRunInput({
        ...input,
        contentHash: `sha256:${"b".repeat(64)}`,
      }),
    DatabasePayloadError
  );
  const maximum = runInputFixture("x".repeat(65_534));
  assert.equal(maximum.sizeBytes, 65_536);
  assert.equal(parseValidatedRunInput(maximum).sizeBytes, 65_536);
  assert.throws(
    () => parseValidatedRunInput(runInputFixture("x".repeat(65_535))),
    DatabasePayloadError
  );
  assert.throws(
    () =>
      parseValidatedRunInput({
        ...input,
        contract: { ...input.contract, unexpected: true },
      }),
    DatabasePayloadError
  );
  let nested: unknown = "leaf";
  for (let depth = 0; depth < 33; depth += 1) {
    nested = [nested];
  }
  assert.throws(
    () => parseValidatedRunInput(runInputFixture(nested)),
    DatabasePayloadError
  );
  const forbidden = JSON.parse('{"__proto__":{"polluted":true}}') as unknown;
  assert.throws(
    () => parseValidatedRunInput(runInputFixture(forbidden)),
    DatabasePayloadError
  );
});

test("rejects malformed run payloads read from PostgreSQL", () => {
  assert.throws(
    () => parseRun({ runId: "run-test", state: "invented" }),
    DatabasePayloadError
  );
});

test("parses cancellation command replay proofs from PostgreSQL", () => {
  const base = {
    identity: {
      commandHash: `sha256:${"a".repeat(64)}`,
      idempotencyKey: "cancel-test",
    },
    runId: "run-test",
    workspaceId: "workspace-test",
  };

  assert.equal(
    parseRunCommandReplayProof({ ...base, commandType: "RequestStop" })
      .commandType,
    "RequestStop"
  );
  assert.equal(
    parseRunCommandReplayProof({
      ...base,
      commandType: "SettleCancellation",
    }).commandType,
    "SettleCancellation"
  );
  assert.throws(
    () => parseRunCommandReplayProof({ ...base, commandType: "CancelNow" }),
    DatabasePayloadError
  );
});

test("upcasts legacy retry limits without mutating their persisted identity", () => {
  const digest = `sha256:${"a".repeat(64)}`;
  const contract = {
    catalogFingerprint: digest,
    catalogVersion: "1.0.0",
    schemaFingerprint: digest,
    schemaId: "https://schemas.kurobara.invalid/test/1.0.0",
    schemaVersion: "1.0.0",
  };
  const legacyPlan = {
    authority: {
      authorityEnvelopeId: "authority-legacy",
      budgetLimit: { limit: 2, reserved: 0, spent: 0, unit: "credits" },
      capabilities: [],
      deadline: 5000,
      permissions: ["runs:create"],
      subjectActorId: "actor-legacy",
      version: "1.0.0",
      workspaceId: "workspace-legacy",
    },
    budget: { limit: 2, reserved: 0, spent: 0, unit: "credits" },
    catalogFingerprint: digest,
    catalogVersion: "1.0.0",
    compiledWorkflow: {
      compilerVersion: "1.0.0",
      fingerprint: "legacy-workflow-fingerprint",
      nodes: [],
      workflowContentHash: digest,
      workflowRevision: "1.0.0",
      workflowSpecId: "workflow-legacy",
    },
    deadline: 5000,
    inputContract: contract,
    normalizedInputHash: digest,
    outputContract: contract,
    planHash: digest,
    policyFactsHash: digest,
    policyVersion: "legacy",
    quote: {
      expiresAt: 4000,
      guarantee: "hard",
      pricingVersion: "legacy",
      quoteId: "quote-legacy",
      unit: "credits",
      upperBound: 2,
    },
    runPlanId: "plan-legacy",
    workspaceId: "workspace-legacy",
  };
  const legacyPolicy = {
    policy: {
      factsHash: digest,
      requiredPermission: "plans:quote",
      version: "legacy",
    },
    snapshotId: "policy-legacy",
    workspaceId: "workspace-legacy",
  };

  assert.equal(parseRunPlan(legacyPlan).retryPolicy.maxAttemptsPerStep, 1);
  assert.equal(parseRunPlan(legacyPlan).planHash, digest);
  assert.equal(
    parsePolicyPlanningSnapshot(legacyPolicy).policy.maxAttemptsPerStep,
    1
  );
  assert.equal("retryPolicy" in legacyPlan, false);
  assert.equal("maxAttemptsPerStep" in legacyPolicy.policy, false);
});

test("rejects malformed step and reservation payloads read from PostgreSQL", () => {
  assert.throws(
    () =>
      parseStepRun({
        activeAttemptId: "attempt-missing",
        aggregateVersion: 1,
        attempts: [],
        createdAt: 1000,
        dependsOn: [],
        eventSequence: 1,
        nodeKey: "summarize",
        runId: "run-test",
        state: "active",
        stepRunId: "step-test",
        workspaceId: "workspace-test",
      }),
    DatabasePayloadError
  );
  assert.throws(
    () =>
      parseCostReservation({
        amount: -1,
        attemptId: "attempt-test",
        createdAt: 1000,
        operationKey: "operation-test",
        reservationId: "reservation-test",
        runId: "run-test",
        state: "reserved",
        stepRunId: "step-test",
        unit: "credits",
        workspaceId: "workspace-test",
      }),
    DatabasePayloadError
  );
});

test("parses settled reservations, usage and actor-bound command proofs", () => {
  assert.equal(
    parseCostReservation({
      amount: 0.11,
      attemptId: "attempt-test",
      createdAt: 1000,
      operationKey: "operation-test",
      releasedAmount: 0.07,
      reservationId: "reservation-test",
      runId: "run-test",
      settledAmount: 0.04,
      settledAt: 2000,
      state: "settled",
      stepRunId: "step-test",
      unit: "credits",
      usageEntryId: "usage-test",
      workspaceId: "workspace-test",
    }).state,
    "settled"
  );
  assert.equal(
    parseUsageEntry({
      amount: 0.04,
      attemptId: "attempt-test",
      operationKey: "operation-test",
      recordedAt: 2000,
      reservationId: "reservation-test",
      runId: "run-test",
      unit: "credits",
      usageEntryId: "usage-test",
      workspaceId: "workspace-test",
    }).amount,
    0.04
  );
  assert.equal(
    parseStepCommandReplayProof({
      actorId: "actor-test",
      commandType: "StartAttemptEffect",
      identity: {
        commandHash: `sha256:${"a".repeat(64)}`,
        idempotencyKey: "start-test",
      },
      stepRunId: "step-test",
      workspaceId: "workspace-test",
    }).commandType,
    "StartAttemptEffect"
  );
});
