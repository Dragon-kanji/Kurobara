import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import {
  createPostgresRuntime,
  type PostgresRuntime,
} from "@kurobara/adapter-postgres";
import {
  type DispatchNextOutboxResult,
  makeAuthenticateApiKey,
  makeClaimRunExecution,
  makeClaimStepAttempt,
  makeCreateRunFromPlan,
  makeDispatchNextOutbox,
  makeTransitionStepAttempt,
  prepareRunPlan,
} from "@kurobara/application";
import {
  actorId,
  attemptId,
  capabilityId,
  contentHash,
  correlationId,
  costReservationId,
  eventId,
  idempotencyKey,
  instant,
  operationKey,
  outboxMessageId,
  type RunPlan,
  runId,
  runPlanId,
  stepRunId,
  usageEntryId,
  type WorkspaceId,
  workflowSpecId,
  workspaceId,
} from "@kurobara/kernel";
import type { IdentifierPort } from "@kurobara/ports";
import postgres from "postgres";

const adminUrl = process.env.KUROBARA_TEST_POSTGRES_URL;
if (adminUrl === undefined || adminUrl.trim().length === 0) {
  throw new Error(
    "KUROBARA_TEST_POSTGRES_URL must target a disposable-capable PostgreSQL admin database."
  );
}

const databaseName = `kurobara_test_${process.pid}_${Date.now()}`;
const databaseUrl = new URL(adminUrl);
databaseUrl.pathname = `/${databaseName}`;

const admin = postgres(adminUrl, { max: 1 });
let runtime: PostgresRuntime;
const MISSING_MIGRATION_SOURCE = /has no source file/u;
const FORCED_ROUTING_ENQUEUE_FAILURE = /forced step routing enqueue failure/u;

before(async () => {
  await admin`CREATE DATABASE ${admin(databaseName)}`;
  runtime = createPostgresRuntime(databaseUrl.toString());
  await runtime.migrate();
  await runtime.migrate();
  await runtime.verifyMigrations();
});

after(async () => {
  if (runtime !== undefined) {
    await runtime.close();
  }
  await admin`DROP DATABASE IF EXISTS ${admin(databaseName)} WITH (FORCE)`;
  await admin.end({ timeout: 5 });
});

const hash = (value: string) =>
  contentHash(`sha256:${value.repeat(64).slice(0, 64)}`);

const preparedPlan = (workspace: WorkspaceId, identifier: string): RunPlan => {
  const capability = {
    capabilityId: capabilityId("documents.summarize"),
    capabilityVersion: "1.0.0",
  };
  const contract = {
    catalogFingerprint: hash("a"),
    catalogVersion: "1.0.0",
    schemaFingerprint: hash("b"),
    schemaId: "https://schemas.kurobara.invalid/inputs/document/1.0.0",
    schemaVersion: "1.0.0",
  };
  const result = prepareRunPlan({
    actorPermissions: ["runs:create"],
    allowedCapabilities: [capability.capabilityId],
    authority: {
      authorityEnvelopeId: `authority-${identifier}`,
      budgetLimit: { limit: 10, reserved: 0, spent: 0, unit: "credits" },
      capabilities: [capability],
      deadline: instant(20_000),
      permissions: ["runs:create", "steps:execute"],
      subjectActorId: actorId("actor-test"),
      version: "1.0.0",
      workspaceId: workspace,
    },
    budget: { limit: 5, reserved: 0, spent: 0, unit: "credits" },
    catalogFingerprint: hash("a"),
    catalogVersion: "1.0.0",
    compilationLimits: { maxDepth: 2, maxFanOut: 3, maxNodes: 3 },
    compilerVersion: "1.0.0",
    deadline: instant(15_000),
    inputContract: contract,
    normalizedInputHash: hash("c"),
    now: instant(1000),
    outputContract: {
      ...contract,
      schemaId: "https://schemas.kurobara.invalid/outputs/summary/1.0.0",
    },
    planHash: hash("d"),
    policy: {
      factsHash: hash("e"),
      requiredPermission: "runs:create",
      version: "1.0.0",
    },
    quote: {
      expiresAt: instant(10_000),
      guarantee: "estimated",
      pricingVersion: "1.0.0",
      quoteId: `quote-${identifier}`,
      unit: "credits",
      upperBound: 5,
    },
    retryPolicy: { maxAttemptsPerStep: 3 },
    routeSnapshots: [
      { nodeKey: "classify", reservableUpperBound: 3 },
      { nodeKey: "summarize", reservableUpperBound: 2 },
      { nodeKey: "translate", reservableUpperBound: 3 },
    ].map(({ nodeKey, reservableUpperBound }) => ({
      capability,
      effectAdapterKey: "deterministic-test",
      factsHash: hash("e"),
      nodeKey,
      pricingVersion: "1.0.0",
      reservableUpperBound,
      reservationUnit: "credits",
      routeKey: `deterministic-test-${nodeKey}`,
    })),
    runPlanId: runPlanId(`plan-${identifier}`),
    workflow: {
      contentHash: hash("f"),
      nodes: [
        { capability, dependsOn: [], key: "classify" },
        { capability, dependsOn: [], key: "summarize" },
        { capability, dependsOn: [], key: "translate" },
      ],
      revision: "1.0.0",
      workflowSpecId: workflowSpecId(`workflow-${identifier}`),
    },
    workspaceId: workspace,
  });
  if (!result.ok) {
    throw new Error(`Plan preparation failed: ${result.error.code}`);
  }
  return result.value;
};

const insertPlan = async (plan: RunPlan): Promise<void> => {
  const scope = { workspaceId: plan.workspaceId } as const;
  await runtime.persistence.transaction(scope, (unitOfWork) =>
    unitOfWork.runPlans.insert(scope, plan)
  );
};

const identifiers = (
  suffix: string,
  messageSuffix = suffix
): IdentifierPort => ({
  nextEventId: async () => eventId(`event-${suffix}`),
  nextOutboxMessageId: async () => outboxMessageId(`outbox-${messageSuffix}`),
  nextRunId: async () => runId(`run-${suffix}`),
});

const createRun = (plan: RunPlan, suffix: string, messageSuffix = suffix) =>
  makeCreateRunFromPlan({
    clock: { now: async () => instant(1000) },
    identifiers: identifiers(suffix, messageSuffix),
    persistence: runtime.persistence,
    requiredPermission: "runs:create",
  })({
    actorId: actorId("actor-test"),
    actorPermissions: ["runs:create"],
    authenticationMode: "api-key",
    correlationId: correlationId(`correlation-${suffix}`),
    idempotencyKey: idempotencyKey(`idempotency-${suffix}`),
    intentionHash: hash("d"),
    runPlanId: plan.runPlanId,
    workspaceId: plan.workspaceId,
  });

test("persists and dispatches the V1 run foundation atomically", async () => {
  const inspection = postgres(databaseUrl.toString(), { max: 1 });
  try {
    await inspection`
      INSERT INTO kurobara_core.schema_migrations (migration_name, checksum)
      VALUES ('0000_removed.sql', 'synthetic-checksum')
    `;
    await assert.rejects(() => runtime.migrate(), MISSING_MIGRATION_SOURCE);
    await inspection`
      DELETE FROM kurobara_core.schema_migrations
      WHERE migration_name = '0000_removed.sql'
    `;
  } finally {
    await inspection.end({ timeout: 5 });
  }

  const workspaceA = workspaceId("workspace-a");
  const bootstrapA = await runtime.bootstrapApiKey({
    actorId: actorId("actor-a"),
    label: "integration workspace A",
    permissions: ["runs:create", "runs:read"],
    workspaceId: workspaceA,
  });
  const authenticate = makeAuthenticateApiKey({
    apiKeys: runtime.apiKeys,
    clock: { now: async () => instant(1000) },
  });
  const authenticatedA = await authenticate({
    presentedKey: bootstrapA.presentedKey,
  });
  assert.equal(authenticatedA.ok, true);
  if (authenticatedA.ok) {
    assert.equal(authenticatedA.value.workspaceId, workspaceA);
    assert.deepEqual(authenticatedA.value.permissions, [
      "runs:create",
      "runs:read",
    ]);
  }
  assert.equal(
    (
      await authenticate({
        presentedKey: `${bootstrapA.presentedKey.slice(0, -1)}${bootstrapA.presentedKey.endsWith("x") ? "y" : "x"}`,
      })
    ).ok,
    false
  );

  const expiredKey = await runtime.bootstrapApiKey({
    actorId: actorId("actor-expired"),
    expiresAt: instant(999),
    label: "expired integration credential",
    permissions: ["runs:read"],
    workspaceId: workspaceA,
  });
  assert.equal(
    (await authenticate({ presentedKey: expiredKey.presentedKey })).ok,
    false
  );

  const revokedKey = await runtime.bootstrapApiKey({
    actorId: actorId("actor-revoked"),
    label: "revoked integration credential",
    permissions: ["runs:read"],
    workspaceId: workspaceA,
  });
  const authInspection = postgres(databaseUrl.toString(), { max: 1 });
  try {
    await authInspection`
      UPDATE kurobara_core.api_keys
      SET revoked_at = clock_timestamp()
      WHERE api_key_id = ${revokedKey.credentialId}
    `;
  } finally {
    await authInspection.end({ timeout: 5 });
  }
  assert.equal(
    (await authenticate({ presentedKey: revokedKey.presentedKey })).ok,
    false
  );

  const planA = preparedPlan(workspaceA, "a");
  await insertPlan(planA);

  const first = await createRun(planA, "a");
  const replay = await createRun(planA, "a");
  assert.equal(first.ok, true);
  assert.equal(replay.ok, true);
  if (first.ok) {
    const snapshot = await runtime.runQueries.get(
      { workspaceId: workspaceA },
      first.value.run.runId
    );
    assert.equal(snapshot?.run.runId, first.value.run.runId);
    assert.deepEqual(snapshot?.cost, {
      reserved: planA.budget.reserved,
      spent: planA.budget.spent,
      unit: planA.budget.unit,
    });
    assert.equal(
      await runtime.runQueries.get(
        { workspaceId: workspaceId("workspace-isolated") },
        first.value.run.runId
      ),
      undefined
    );

    let stepEventSequence = 0;
    const claimRun = makeClaimRunExecution({
      clock: { now: async () => instant(1500) },
      identifiers: {
        nextEventId: async () => eventId("run-started-step-foundation"),
        nextOutboxMessageId: async () => outboxMessageId("unused-step-outbox"),
        nextRunId: async () => runId("unused-step-run"),
      },
      persistence: runtime.runExecution,
    });
    const runClaim = await claimRun({
      eventId: eventId("orchestration-step-foundation"),
      runId: first.value.run.runId,
      startKey: "start-step-foundation",
      workspaceId: workspaceA,
    });
    assert.equal(runClaim.ok, true);

    const claimStep = makeClaimStepAttempt({
      clock: { now: async () => instant(2000) },
      identifiers: {
        nextEventId: async () =>
          eventId(`step-foundation-${++stepEventSequence}`),
        nextOutboxMessageId: async () =>
          outboxMessageId(`step-outbox-foundation-${stepEventSequence}`),
      },
      persistence: runtime.stepExecution,
      requiredPermission: "steps:execute",
    });
    const stepInput = {
      actorId: actorId("actor-test"),
      attemptId: attemptId("attempt-foundation"),
      commandIdempotencyKey: idempotencyKey("claim-step-foundation"),
      correlationId: correlationId("correlation-step-foundation"),
      costReservationId: costReservationId("reservation-foundation"),
      expectedAggregateVersion: "absent" as const,
      nodeKey: "summarize",
      operationKey: operationKey("operation-foundation"),
      reason: "initial" as const,
      routeKey: "deterministic-test-summarize",
      runId: first.value.run.runId,
      stepRunId: stepRunId("step-foundation"),
      workspaceId: workspaceA,
    };
    const stepClaim = await claimStep(stepInput);
    const stepReplay = await claimStep(stepInput);
    assert.equal(stepClaim.ok, true);
    assert.equal(stepReplay.ok, true);
    if (stepClaim.ok && stepReplay.ok) {
      assert.equal(stepClaim.value.reservationStatus, "created");
      assert.equal(stepReplay.value.replayed, true);
    }
    assert.equal(
      (
        await claimStep({
          ...stepInput,
          workspaceId: workspaceId("workspace-isolated"),
        })
      ).ok,
      false
    );

    const transitionStep = makeTransitionStepAttempt({
      clock: { now: async () => instant(2100 + stepEventSequence) },
      identifiers: {
        nextEventId: async () =>
          eventId(`step-transition-foundation-${++stepEventSequence}`),
      },
      persistence: runtime.stepExecution,
      requiredPermission: "steps:execute",
    });
    const startInitialInput = {
      actorId: actorId("actor-test"),
      attemptId: stepInput.attemptId,
      commandIdempotencyKey: idempotencyKey("start-step-foundation"),
      correlationId: stepInput.correlationId,
      expectedAggregateVersion: 2,
      stepRunId: stepInput.stepRunId,
      type: "StartAttemptEffect" as const,
      workspaceId: workspaceA,
    };
    const startedInitial = await transitionStep(startInitialInput);
    const replayedStart = await transitionStep(startInitialInput);
    assert.equal(startedInitial.ok, true);
    assert.equal(replayedStart.ok, true);
    if (startedInitial.ok && replayedStart.ok) {
      assert.equal(startedInitial.value.effectPermission, "granted");
      assert.equal(replayedStart.value.effectPermission, "replay-only");
    }
    const retryableFailureInput = {
      ...startInitialInput,
      commandIdempotencyKey: idempotencyKey("fail-step-foundation"),
      expectedAggregateVersion: 3,
      retryable: true,
      settlement: { kind: "release" },
      type: "RecordAttemptFailure" as const,
    };
    const atomicRetryInspection = postgres(databaseUrl.toString(), { max: 1 });
    await atomicRetryInspection`
      CREATE FUNCTION kurobara_core.reject_foundation_step_routing()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $$
      BEGIN
        IF NEW.step_run_id = 'step-foundation' THEN
          RAISE EXCEPTION 'forced step routing enqueue failure';
        END IF;
        RETURN NEW;
      END;
      $$
    `;
    await atomicRetryInspection`
      CREATE TRIGGER reject_foundation_step_routing
      BEFORE INSERT OR UPDATE ON kurobara_core.step_routing_jobs
      FOR EACH ROW
      EXECUTE FUNCTION kurobara_core.reject_foundation_step_routing()
    `;
    try {
      await assert.rejects(
        () => transitionStep(retryableFailureInput),
        FORCED_ROUTING_ENQUEUE_FAILURE
      );
      const rollbackRows = await atomicRetryInspection<
        readonly {
          attempt_state: string;
          failure_commands: string;
          failure_events: string;
          reservation_state: string;
          routing_jobs: string;
          step_state: string;
          step_version: number;
        }[]
      >`
        SELECT
          (SELECT state FROM kurobara_core.step_attempts
            WHERE workspace_id = ${workspaceA}
              AND attempt_id = ${stepInput.attemptId}) AS attempt_state,
          (SELECT count(*)::text FROM kurobara_core.step_command_journal
            WHERE workspace_id = ${workspaceA}
              AND step_run_id = ${stepInput.stepRunId}
              AND command_idempotency_key = 'fail-step-foundation')
            AS failure_commands,
          (SELECT count(*)::text FROM kurobara_core.step_events
            WHERE workspace_id = ${workspaceA}
              AND step_run_id = ${stepInput.stepRunId}
              AND event ->> 'eventType' IN (
                'AttemptFailed',
                'StepRetryAuthorized'
              )) AS failure_events,
          (SELECT state FROM kurobara_core.cost_reservations
            WHERE workspace_id = ${workspaceA}
              AND reservation_id = ${stepInput.costReservationId})
            AS reservation_state,
          (SELECT count(*)::text FROM kurobara_core.step_routing_jobs
            WHERE workspace_id = ${workspaceA}
              AND step_run_id = ${stepInput.stepRunId}) AS routing_jobs,
          (SELECT state FROM kurobara_core.step_runs
            WHERE workspace_id = ${workspaceA}
              AND step_run_id = ${stepInput.stepRunId}) AS step_state,
          (SELECT aggregate_version FROM kurobara_core.step_runs
            WHERE workspace_id = ${workspaceA}
              AND step_run_id = ${stepInput.stepRunId}) AS step_version
      `;
      assert.deepEqual(rollbackRows[0], {
        attempt_state: "in_flight",
        failure_commands: "0",
        failure_events: "0",
        reservation_state: "reserved",
        routing_jobs: "0",
        step_state: "active",
        step_version: 3,
      });
    } finally {
      await atomicRetryInspection`
        DROP TRIGGER reject_foundation_step_routing
        ON kurobara_core.step_routing_jobs
      `;
      await atomicRetryInspection`
        DROP FUNCTION kurobara_core.reject_foundation_step_routing()
      `;
    }
    const failedInitial = await transitionStep(retryableFailureInput);
    assert.equal(failedInitial.ok, true);
    const committedRetryRows = await atomicRetryInspection<
      readonly {
        attempt_state: string;
        pending: boolean;
        reservation_state: string;
        retry_events: readonly string[];
        step_state: string;
        step_version: number;
      }[]
    >`
      SELECT
        (SELECT state FROM kurobara_core.step_attempts
          WHERE workspace_id = ${workspaceA}
            AND attempt_id = ${stepInput.attemptId}) AS attempt_state,
        (SELECT pending FROM kurobara_core.step_routing_jobs
          WHERE workspace_id = ${workspaceA}
            AND step_run_id = ${stepInput.stepRunId}) AS pending,
        (SELECT state FROM kurobara_core.cost_reservations
          WHERE workspace_id = ${workspaceA}
            AND reservation_id = ${stepInput.costReservationId})
          AS reservation_state,
        (SELECT array_agg(event ->> 'eventType' ORDER BY sequence)
          FROM kurobara_core.step_events
          WHERE workspace_id = ${workspaceA}
            AND step_run_id = ${stepInput.stepRunId}
            AND event ->> 'eventType' IN (
              'AttemptFailed',
              'StepRetryAuthorized'
            )) AS retry_events,
        (SELECT state FROM kurobara_core.step_runs
          WHERE workspace_id = ${workspaceA}
            AND step_run_id = ${stepInput.stepRunId}) AS step_state,
        (SELECT aggregate_version FROM kurobara_core.step_runs
          WHERE workspace_id = ${workspaceA}
            AND step_run_id = ${stepInput.stepRunId}) AS step_version
    `;
    assert.deepEqual(committedRetryRows[0], {
      attempt_state: "failed_retryable",
      pending: true,
      reservation_state: "released",
      retry_events: ["AttemptFailed", "StepRetryAuthorized"],
      step_state: "ready",
      step_version: 4,
    });
    await atomicRetryInspection.end({ timeout: 5 });

    const retryInput = {
      ...stepInput,
      attemptId: attemptId("attempt-foundation-retry"),
      commandIdempotencyKey: idempotencyKey("claim-step-foundation-retry"),
      costReservationId: costReservationId("reservation-foundation-retry"),
      expectedAggregateVersion: 4,
      reason: "retry" as const,
    };
    const retryClaim = await claimStep(retryInput);
    assert.equal(retryClaim.ok, true);
    const startRetryInput = {
      actorId: actorId("actor-test"),
      attemptId: retryInput.attemptId,
      commandIdempotencyKey: idempotencyKey("start-step-foundation-retry"),
      correlationId: retryInput.correlationId,
      expectedAggregateVersion: 5,
      stepRunId: retryInput.stepRunId,
      type: "StartAttemptEffect" as const,
      workspaceId: workspaceA,
    };
    assert.equal((await transitionStep(startRetryInput)).ok, true);
    const successRetryInput = {
      ...startRetryInput,
      commandIdempotencyKey: idempotencyKey("succeed-step-foundation-retry"),
      expectedAggregateVersion: 6,
      settlement: {
        amount: 1,
        kind: "settle" as const,
        unit: "credits",
        usageEntryId: usageEntryId("usage-foundation-retry"),
      },
      type: "RecordAttemptSucceeded" as const,
    };
    const competingSuccessInput = {
      ...successRetryInput,
      commandIdempotencyKey: idempotencyKey(
        "succeed-step-foundation-retry-competing"
      ),
      settlement: {
        ...successRetryInput.settlement,
        usageEntryId: usageEntryId("usage-foundation-retry-competing"),
      },
    };
    const rollbackTransition = makeTransitionStepAttempt({
      clock: { now: async () => instant(2300) },
      identifiers: {
        nextEventId: async () =>
          eventId(`step-transition-foundation-${stepEventSequence}`),
      },
      persistence: runtime.stepExecution,
      requiredPermission: "steps:execute",
    });
    await assert.rejects(() =>
      rollbackTransition({
        ...successRetryInput,
        commandIdempotencyKey: idempotencyKey("settlement-rollback"),
        settlement: {
          ...successRetryInput.settlement,
          usageEntryId: usageEntryId("usage-settlement-rollback"),
        },
      })
    );
    const rollbackInspection = postgres(databaseUrl.toString(), { max: 1 });
    try {
      const rows = await rollbackInspection<
        readonly {
          attempt_state: string;
          reserved: string;
          spent: string;
          step_version: number;
          usages: string;
        }[]
      >`
        SELECT
          (SELECT state FROM kurobara_core.step_attempts
            WHERE workspace_id = ${workspaceA}
              AND attempt_id = ${retryInput.attemptId}) AS attempt_state,
          (SELECT cost ->> 'reserved' FROM kurobara_core.runs
            WHERE workspace_id = ${workspaceA}
              AND run_id = ${first.value.run.runId}) AS reserved,
          (SELECT cost ->> 'spent' FROM kurobara_core.runs
            WHERE workspace_id = ${workspaceA}
              AND run_id = ${first.value.run.runId}) AS spent,
          (SELECT aggregate_version FROM kurobara_core.step_runs
            WHERE workspace_id = ${workspaceA}
              AND step_run_id = ${stepInput.stepRunId}) AS step_version,
          (SELECT count(*)::text FROM kurobara_core.usage_ledger_entries
            WHERE workspace_id = ${workspaceA}
              AND run_id = ${first.value.run.runId}) AS usages
      `;
      assert.deepEqual(rows[0], {
        attempt_state: "in_flight",
        reserved: "2",
        spent: "0",
        step_version: 6,
        usages: "0",
      });
    } finally {
      await rollbackInspection.end({ timeout: 5 });
    }
    const concurrentSettlements = await Promise.all([
      transitionStep(successRetryInput),
      transitionStep(competingSuccessInput),
    ]);
    assert.equal(concurrentSettlements.filter((result) => result.ok).length, 1);
    const winningSuccessInput = concurrentSettlements[0]?.ok
      ? successRetryInput
      : competingSuccessInput;
    const replayedSuccess = await transitionStep(winningSuccessInput);
    assert.equal(replayedSuccess.ok, true);
    if (replayedSuccess.ok) {
      assert.equal(replayedSuccess.value.replayed, true);
    }

    const stepInspection = postgres(databaseUrl.toString(), { max: 1 });
    try {
      const stepRows = await stepInspection<
        readonly {
          attempts: string;
          commands: string;
          events: string;
          reserved: string;
          spent: string;
          usages: string;
        }[]
      >`
        SELECT
          (SELECT count(*)::text FROM kurobara_core.step_attempts
            WHERE workspace_id = ${workspaceA}
              AND step_run_id = ${stepInput.stepRunId}) AS attempts,
          (SELECT count(*)::text FROM kurobara_core.step_command_journal
            WHERE workspace_id = ${workspaceA}
              AND step_run_id = ${stepInput.stepRunId}) AS commands,
          (SELECT count(*)::text FROM kurobara_core.step_events
            WHERE workspace_id = ${workspaceA}
              AND step_run_id = ${stepInput.stepRunId}) AS events,
          (SELECT cost ->> 'reserved' FROM kurobara_core.runs
            WHERE workspace_id = ${workspaceA}
              AND run_id = ${first.value.run.runId}) AS reserved,
          (SELECT cost ->> 'spent' FROM kurobara_core.runs
            WHERE workspace_id = ${workspaceA}
              AND run_id = ${first.value.run.runId}) AS spent,
          (SELECT count(*)::text FROM kurobara_core.usage_ledger_entries
            WHERE workspace_id = ${workspaceA}
              AND run_id = ${first.value.run.runId}) AS usages
      `;
      assert.deepEqual(stepRows[0], {
        attempts: "2",
        commands: "6",
        events: "12",
        reserved: "0",
        spent: "1",
        usages: "1",
      });
    } finally {
      await stepInspection.end({ timeout: 5 });
    }

    const aliasedOperation = await claimStep({
      ...stepInput,
      attemptId: attemptId("attempt-operation-alias"),
      commandIdempotencyKey: idempotencyKey("claim-operation-alias"),
      costReservationId: costReservationId("reservation-operation-alias"),
      nodeKey: "classify",
      operationKey: stepInput.operationKey,
      routeKey: "deterministic-test-classify",
      stepRunId: stepRunId("step-operation-alias"),
    });
    assert.equal(aliasedOperation.ok, false);
    if (!aliasedOperation.ok) {
      assert.equal(aliasedOperation.error.code, "cost-reservation-conflict");
    }

    const concurrentStepClaims = await Promise.all(
      ["classify", "translate"].map((nodeKey) =>
        claimStep({
          ...stepInput,
          attemptId: attemptId(`attempt-${nodeKey}`),
          commandIdempotencyKey: idempotencyKey(`claim-${nodeKey}`),
          costReservationId: costReservationId(`reservation-${nodeKey}`),
          nodeKey,
          operationKey: operationKey(`operation-${nodeKey}`),
          routeKey: `deterministic-test-${nodeKey}`,
          stepRunId: stepRunId(`step-${nodeKey}`),
        })
      )
    );
    assert.equal(concurrentStepClaims.filter((result) => result.ok).length, 1);
    const rejectedReservation = concurrentStepClaims.find(
      (result) => !result.ok
    );
    if (rejectedReservation?.ok === false) {
      assert.equal(rejectedReservation.error.code, "budget-exceeded");
    }
    const reservedSnapshot = await runtime.runQueries.get(
      { workspaceId: workspaceA },
      first.value.run.runId
    );
    assert.equal(reservedSnapshot?.cost.reserved, 3);
    assert.equal(reservedSnapshot?.cost.spent, 1);
  }
  if (replay.ok) {
    assert.equal(replay.value.replayed, true);
  }

  const conflict = await makeCreateRunFromPlan({
    clock: { now: async () => instant(1000) },
    identifiers: identifiers("unused"),
    persistence: runtime.persistence,
    requiredPermission: "runs:create",
  })({
    actorId: actorId("actor-test"),
    actorPermissions: ["runs:create"],
    authenticationMode: "api-key",
    correlationId: correlationId("correlation-conflict"),
    idempotencyKey: idempotencyKey("idempotency-a"),
    intentionHash: hash("9"),
    runPlanId: planA.runPlanId,
    workspaceId: workspaceA,
  });
  assert.equal(conflict.ok, false);
  if (!conflict.ok) {
    assert.equal(conflict.error.code, "idempotency-key-reused");
  }

  const concurrentPlan = preparedPlan(workspaceA, "concurrent");
  await insertPlan(concurrentPlan);
  const concurrentCommand = {
    actorId: actorId("actor-test"),
    actorPermissions: ["runs:create"],
    authenticationMode: "api-key",
    correlationId: correlationId("correlation-concurrent"),
    idempotencyKey: idempotencyKey("idempotency-concurrent"),
    intentionHash: hash("d"),
    runPlanId: concurrentPlan.runPlanId,
    workspaceId: workspaceA,
  };
  const concurrentSubjects = ["concurrent-left", "concurrent-right"].map(
    (suffix) =>
      makeCreateRunFromPlan({
        clock: { now: async () => instant(1000) },
        identifiers: identifiers(suffix),
        persistence: runtime.persistence,
        requiredPermission: "runs:create",
      })
  );
  const concurrent = await Promise.all(
    concurrentSubjects.map((execute) => execute(concurrentCommand))
  );
  assert.equal(
    concurrent.every((result) => result.ok),
    true
  );
  if (concurrent[0]?.ok && concurrent[1]?.ok) {
    assert.equal(concurrent[0].value.run.runId, concurrent[1].value.run.runId);
    assert.deepEqual(concurrent.map((result) => result.value.replayed).sort(), [
      false,
      true,
    ]);
  }

  const workspaceB = workspaceId("workspace-b");
  await runtime.bootstrapApiKey({
    actorId: actorId("actor-b"),
    label: "integration workspace B",
    permissions: ["runs:create", "runs:read"],
    workspaceId: workspaceB,
  });
  const planB = preparedPlan(workspaceB, "b");
  await insertPlan(planB);
  const isolated = await createRun(planB, "a", "b");
  assert.equal(isolated.ok, true);

  const planRollback = preparedPlan(workspaceA, "rollback");
  await insertPlan(planRollback);
  await assert.rejects(() => createRun(planRollback, "rollback", "a"));
  const recovered = await createRun(planRollback, "rollback", "recovered");
  assert.equal(recovered.ok, true);

  const orchestrationRequests: unknown[] = [];
  const dispatch = makeDispatchNextOutbox({
    claimLeaseMilliseconds: 5000,
    maxAttempts: 3,
    orchestration: {
      adapterKey: "fake-integration-v1",
      findRunByStartKey: () => Promise.resolve({ status: "not-found" }),
      startRun: (request) => {
        orchestrationRequests.push(request);
        return Promise.resolve({
          orchestrationRunId: `orchestration-${request.eventId}`,
          status: "accepted" as const,
        });
      },
    },
    outbox: runtime.outbox,
    retryDelayMilliseconds: 5000,
    workerId: "worker-integration",
  });

  const dispatchResults: DispatchNextOutboxResult[] = [];
  for (;;) {
    const result = await dispatch();
    if (result.status === "idle") {
      break;
    }
    dispatchResults.push(result);
  }

  assert.equal(dispatchResults.length, 4);
  assert.equal(orchestrationRequests.length, 4);
  assert.equal(
    dispatchResults.every((result) => result.status === "dispatched"),
    true
  );

  const retryPlan = preparedPlan(workspaceA, "retry");
  await insertPlan(retryPlan);
  assert.equal((await createRun(retryPlan, "retry")).ok, true);
  const failingDispatch = () =>
    makeDispatchNextOutbox({
      claimLeaseMilliseconds: 5000,
      maxAttempts: 2,
      orchestration: {
        adapterKey: "fake-retry-v1",
        findRunByStartKey: () => Promise.resolve({ status: "not-found" }),
        startRun: () => Promise.reject(new Error("orchestrator unavailable")),
      },
      outbox: runtime.outbox,
      retryDelayMilliseconds: 100,
      workerId: "worker-retry",
    });

  assert.equal((await failingDispatch()()).status, "retry-scheduled");
  assert.equal((await failingDispatch()()).status, "idle");
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.equal((await failingDispatch()()).status, "dead-lettered");

  const leasePlan = preparedPlan(workspaceA, "lease");
  await insertPlan(leasePlan);
  assert.equal((await createRun(leasePlan, "lease")).ok, true);
  const firstLease = await runtime.outbox.claimNext({
    claimedBy: "worker-shared",
    leaseMilliseconds: 30,
  });
  assert.equal(firstLease?.attempt, 1);
  if (firstLease === undefined) {
    throw new Error("The first worker should acquire the outbox lease.");
  }
  assert.equal(
    await runtime.outbox.claimNext({
      claimedBy: "worker-shared",
      leaseMilliseconds: 30,
    }),
    undefined
  );
  await new Promise((resolve) => setTimeout(resolve, 40));
  const reclaimed = await runtime.outbox.claimNext({
    claimedBy: "worker-shared",
    leaseMilliseconds: 30,
  });
  assert.equal(reclaimed?.attempt, 2);
  if (reclaimed === undefined) {
    throw new Error("The expired lease should have been reclaimed.");
  }
  await assert.rejects(() =>
    runtime.outbox.markDeadLetter({
      claimedBy: "worker-shared",
      claimToken: firstLease.claimToken,
      messageId: reclaimed.message.messageId,
      reason: "stale worker",
    })
  );
  await runtime.outbox.markDeadLetter({
    claimedBy: "worker-shared",
    claimToken: reclaimed.claimToken,
    messageId: reclaimed.message.messageId,
    reason: "test complete",
  });
});

test("rolls back the losing operation binding in a cross-run reservation race", async () => {
  const raceWorkspace = workspaceId("workspace-reservation-race");
  await runtime.bootstrapApiKey({
    actorId: actorId("actor-test"),
    label: "reservation race workspace",
    permissions: ["runs:create"],
    workspaceId: raceWorkspace,
  });
  const leftPlan = preparedPlan(raceWorkspace, "reservation-race-left");
  const rightPlan = preparedPlan(raceWorkspace, "reservation-race-right");
  await insertPlan(leftPlan);
  await insertPlan(rightPlan);
  const [leftCreated, rightCreated] = await Promise.all([
    createRun(leftPlan, "reservation-race-left"),
    createRun(rightPlan, "reservation-race-right"),
  ]);
  if (!(leftCreated.ok && rightCreated.ok)) {
    throw new Error("Both reservation-race runs must be created.");
  }

  const claimRun = (suffix: string, requestedRunId: ReturnType<typeof runId>) =>
    makeClaimRunExecution({
      clock: { now: async () => instant(1500) },
      identifiers: {
        nextEventId: async () => eventId(`event-start-${suffix}`),
        nextOutboxMessageId: async () =>
          outboxMessageId(`outbox-unused-${suffix}`),
        nextRunId: async () => runId(`run-unused-${suffix}`),
      },
      persistence: runtime.runExecution,
    })({
      eventId: eventId(`orchestration-${suffix}`),
      runId: requestedRunId,
      startKey: `start-${suffix}`,
      workspaceId: raceWorkspace,
    });
  const runClaims = await Promise.all([
    claimRun("reservation-race-left", leftCreated.value.run.runId),
    claimRun("reservation-race-right", rightCreated.value.run.runId),
  ]);
  assert.equal(
    runClaims.every((result) => result.ok),
    true
  );

  const sharedReservationId = costReservationId("reservation-global-race");
  const claimStep = (
    suffix: string,
    requestedRunId: ReturnType<typeof runId>
  ) => {
    let nextEvent = 0;
    return makeClaimStepAttempt({
      clock: { now: async () => instant(2000) },
      identifiers: {
        nextEventId: async () => eventId(`event-step-${suffix}-${++nextEvent}`),
        nextOutboxMessageId: async () =>
          outboxMessageId(`outbox-step-${suffix}`),
      },
      persistence: runtime.stepExecution,
      requiredPermission: "steps:execute",
    })({
      actorId: actorId("actor-test"),
      attemptId: attemptId(`attempt-${suffix}`),
      commandIdempotencyKey: idempotencyKey(`claim-${suffix}`),
      correlationId: correlationId(`correlation-${suffix}`),
      costReservationId: sharedReservationId,
      expectedAggregateVersion: "absent",
      nodeKey: "summarize",
      operationKey: operationKey(`operation-${suffix}`),
      reason: "initial",
      routeKey: "deterministic-test-summarize",
      runId: requestedRunId,
      stepRunId: stepRunId(`step-${suffix}`),
      workspaceId: raceWorkspace,
    });
  };
  const claims = await Promise.all([
    claimStep("reservation-race-left", leftCreated.value.run.runId),
    claimStep("reservation-race-right", rightCreated.value.run.runId),
  ]);
  assert.equal(claims.filter((result) => result.ok).length, 1);
  const rejected = claims.find((result) => !result.ok);
  if (rejected?.ok === false) {
    assert.equal(rejected.error.code, "cost-reservation-conflict");
  }

  const inspection = postgres(databaseUrl.toString(), { max: 1 });
  try {
    const rows = await inspection<
      readonly {
        attempts: string;
        bindings: string;
        reservations: string;
        steps: string;
      }[]
    >`
      SELECT
        (SELECT count(*)::text FROM kurobara_core.cost_reservations
          WHERE workspace_id = ${raceWorkspace}
            AND reservation_id = ${sharedReservationId}) AS reservations,
        (SELECT count(*)::text FROM kurobara_core.step_operation_bindings
          WHERE workspace_id = ${raceWorkspace}
            AND operation_key IN (
              'operation-reservation-race-left',
              'operation-reservation-race-right'
            )) AS bindings,
        (SELECT count(*)::text FROM kurobara_core.step_attempts
          WHERE workspace_id = ${raceWorkspace}) AS attempts,
        (SELECT count(*)::text FROM kurobara_core.step_runs
          WHERE workspace_id = ${raceWorkspace}) AS steps
    `;
    assert.deepEqual(rows[0], {
      attempts: "1",
      bindings: "1",
      reservations: "1",
      steps: "1",
    });
  } finally {
    await inspection.end({ timeout: 5 });
  }
});
