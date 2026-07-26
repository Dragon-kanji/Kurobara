import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import {
  createPostgresRuntime,
  type PostgresRuntime,
} from "@kurobara/adapter-postgres";
import {
  type Attempt,
  actorId,
  attemptId,
  contentHash,
  correlationId,
  costReservationId,
  eventId,
  instant,
  operationKey,
  outboxMessageId,
  routingDecisionId,
  runId,
  stepRunId,
  workspaceId,
} from "@kurobara/kernel";
import type { LeafOutboxMessage } from "@kurobara/ports";
import postgres from "postgres";

const adminUrl = process.env.KUROBARA_TEST_POSTGRES_URL;
const LEAF_BINDING_INACTIVE = /has no active leaf execution binding/u;
const SYNTHETIC_ROLLBACK = /synthetic transaction rollback/u;
if (adminUrl === undefined || adminUrl.trim().length === 0) {
  throw new Error(
    "KUROBARA_TEST_POSTGRES_URL must target a disposable-capable PostgreSQL admin database."
  );
}

const databaseName = `kurobara_leaf_outbox_${process.pid}_${Date.now()}`;
const databaseUrl = new URL(adminUrl);
databaseUrl.pathname = `/${databaseName}`;
const admin = postgres(adminUrl, { max: 1 });
let runtime: PostgresRuntime;
let inspection: postgres.Sql;

before(async () => {
  await admin`CREATE DATABASE ${admin(databaseName)}`;
  runtime = createPostgresRuntime(databaseUrl.toString());
  await runtime.migrate();
  await runtime.verifyMigrations();
  inspection = postgres(databaseUrl.toString(), { max: 4 });
});

after(async () => {
  await inspection?.end({ timeout: 5 });
  await runtime?.close();
  await admin`DROP DATABASE IF EXISTS ${admin(databaseName)} WITH (FORCE)`;
  await admin.end({ timeout: 5 });
});

const seedAttempt = async (
  suffix: string,
  workspaceSuffix = suffix,
  selectedEffectAdapterKey = "deterministic-local"
) => {
  const workspace = workspaceId(`workspace-${workspaceSuffix}`);
  const run = runId(`run-${suffix}`);
  const step = stepRunId(`step-${suffix}`);
  const attempt = attemptId(`attempt-${suffix}`);
  const operation = operationKey(`operation-${suffix}`);
  const reservation = `reservation-${suffix}`;
  await inspection.begin(async (transaction) => {
    const sql = transaction as unknown as postgres.Sql;
    await sql`
      INSERT INTO kurobara_core.workspaces (workspace_id)
      VALUES (${workspace})
      ON CONFLICT (workspace_id) DO NOTHING
    `;
    await sql`
      INSERT INTO kurobara_core.run_plans (workspace_id, run_plan_id, plan)
      VALUES (${workspace}, ${`plan-${suffix}`}, ${sql.json({})})
    `;
    await sql`
      INSERT INTO kurobara_core.runs (
        workspace_id, run_id, run_plan_id, idempotency_key,
        intention_hash, cost, run
      ) VALUES (
        ${workspace}, ${run}, ${`plan-${suffix}`}, ${`create-${suffix}`},
        ${`sha256:${"a".repeat(64)}`},
        ${sql.json({ reserved: 1, spent: 0, unit: "credits" })},
        ${sql.json({})}
      )
    `;
    await sql`
      INSERT INTO kurobara_core.step_runs (
        workspace_id, step_run_id, run_id, node_key, state,
        aggregate_version, event_sequence, step_run, created_at
      ) VALUES (
        ${workspace}, ${step}, ${run}, ${`node-${suffix}`}, 'active',
        2, 2, ${sql.json({})}, to_timestamp(1)
      )
    `;
    await sql`
      INSERT INTO kurobara_core.step_operation_bindings (
        workspace_id, run_id, operation_key, step_run_id
      ) VALUES (${workspace}, ${run}, ${operation}, ${step})
    `;
    const routingDecision = {
      decidedAt: 1000,
      effectAdapterKey: selectedEffectAdapterKey,
      policyFactsHash: `sha256:${"c".repeat(64)}`,
      policyVersion: "test-v1",
      pricingVersion: "test-v1",
      reservationUnit: "credits",
      reservedAmount: 1,
      routeKey: "deterministic-test",
      routeSnapshotHash: `sha256:${"b".repeat(64)}`,
      routingDecisionId: `route-${suffix}`,
      runId: run,
      stepRunId: step,
      workspaceId: workspace,
    };
    await sql`
      INSERT INTO kurobara_core.routing_decisions (
        workspace_id, routing_decision_id, run_id, step_run_id, route_key,
        effect_adapter_key, route_snapshot_hash, reservation_unit,
        reserved_amount, policy_version, policy_facts_hash, pricing_version,
        decision, decided_at
      ) VALUES (
        ${workspace}, ${routingDecision.routingDecisionId}, ${run}, ${step},
        ${routingDecision.routeKey}, ${routingDecision.effectAdapterKey},
        ${routingDecision.routeSnapshotHash}, ${routingDecision.reservationUnit},
        ${routingDecision.reservedAmount}, ${routingDecision.policyVersion},
        ${routingDecision.policyFactsHash}, ${routingDecision.pricingVersion},
        ${sql.json(routingDecision)}, to_timestamp(1)
      )
    `;
    await sql`
      INSERT INTO kurobara_core.cost_reservations (
        workspace_id, reservation_id, run_id, operation_key, unit,
        amount, state, reservation, created_at, attempt_id, step_run_id
      ) VALUES (
        ${workspace}, ${reservation}, ${run}, ${operation}, 'credits',
        1, 'reserved', ${sql.json({})}, to_timestamp(1), ${attempt}, ${step}
      )
    `;
    await sql`
      INSERT INTO kurobara_core.step_attempts (
        workspace_id, attempt_id, step_run_id, attempt_number,
        operation_key, reservation_id, route_key, effect_adapter_key,
        routing_decision_id, route_snapshot_hash, state, attempt, created_at
      ) VALUES (
        ${workspace}, ${attempt}, ${step}, 1, ${operation}, ${reservation},
        'deterministic-test', ${selectedEffectAdapterKey}, ${`route-${suffix}`},
        ${`sha256:${"b".repeat(64)}`}, 'claimed', ${sql.json({})}, to_timestamp(1)
      )
    `;
    const claimedEvent = {
      actorId: "actor-leaf-test",
      attemptId: attempt,
      attemptNumber: 1,
      correlationId: `correlation-${suffix}`,
      eventId: `leaf-event-${suffix}`,
      eventType: "AttemptClaimed",
      eventVersion: 1,
      occurredAt: 1000,
      runId: run,
      sequence: 2,
      stepRunId: step,
      workspaceId: workspace,
    };
    await sql`
      INSERT INTO kurobara_core.step_events (
        workspace_id, step_run_id, sequence, event_id, event, occurred_at
      ) VALUES (
        ${workspace}, ${step}, 2, ${claimedEvent.eventId},
        ${sql.json(claimedEvent)}, to_timestamp(1)
      )
    `;
  });
  return {
    attempt,
    effectAdapterKey: selectedEffectAdapterKey,
    operation,
    run,
    step,
    workspace,
  };
};

const messageFor = (
  suffix: string,
  seeded: Awaited<ReturnType<typeof seedAttempt>>
): LeafOutboxMessage => {
  const claimedEventId = eventId(`leaf-event-${suffix}`);
  return {
    aggregateVersion: 2,
    attemptId: seeded.attempt,
    availableAt: instant(1000),
    destination: "orchestration.step.attempt.claimed",
    effectAdapterKey: seeded.effectAdapterKey,
    event: {
      actorId: actorId("actor-leaf-test"),
      attemptId: seeded.attempt,
      attemptNumber: 1,
      correlationId: correlationId(`correlation-${suffix}`),
      eventId: claimedEventId,
      eventType: "AttemptClaimed",
      eventVersion: 1,
      occurredAt: instant(1000),
      runId: seeded.run,
      sequence: 2,
      stepRunId: seeded.step,
      workspaceId: seeded.workspace,
    },
    eventId: claimedEventId,
    messageId: outboxMessageId(`leaf-outbox-${suffix}`),
    operationKey: seeded.operation,
    runId: seeded.run,
    stepRunId: seeded.step,
    workspaceId: seeded.workspace,
  };
};

const append = async (
  seeded: Awaited<ReturnType<typeof seedAttempt>>,
  message: LeafOutboxMessage
): Promise<void> => {
  const scope = { workspaceId: seeded.workspace } as const;
  await runtime.stepExecution.transaction(scope, (unitOfWork) =>
    unitOfWork.leafOutbox.append(scope, message)
  );
};

const inFlightAttemptFor = (
  suffix: string,
  seeded: Awaited<ReturnType<typeof seedAttempt>>
): Attempt => ({
  attemptId: seeded.attempt,
  attemptNumber: 1,
  authorityEnvelopeId: `authority-${suffix}`,
  claimedAt: instant(1000),
  costReservationId: costReservationId(`reservation-${suffix}`),
  effectAdapterKey: seeded.effectAdapterKey,
  effectStartedAt: instant(2000),
  operationKey: seeded.operation,
  preparedAt: instant(1000),
  reason: "initial",
  reservationUnit: "credits",
  reservedAmount: 1,
  routeKey: "deterministic-test",
  routeSnapshotHash: contentHash(`sha256:${"b".repeat(64)}`),
  routingDecisionId: routingDecisionId(`route-${suffix}`),
  state: "in_flight",
  stepRunId: seeded.step,
});

test("fresh migration appends and replays one tenant-scoped leaf binding", async () => {
  const seeded = await seedAttempt("append");
  const message = messageFor("append", seeded);
  await append(seeded, message);
  await append(seeded, message);

  const rows = await inspection<
    readonly { bindings: string; messages: string }[]
  >`
    SELECT
      (SELECT count(*)::text
       FROM kurobara_core.outbox_messages
       WHERE workspace_id = ${seeded.workspace}
         AND message_id = ${message.messageId}) AS messages,
      (SELECT count(*)::text
       FROM kurobara_core.step_leaf_execution_bindings
       WHERE workspace_id = ${seeded.workspace}
         AND attempt_id = ${seeded.attempt}) AS bindings
  `;
  assert.deepEqual(rows[0], { bindings: "1", messages: "1" });
  assert.deepEqual(
    await runtime.stepQueries.getLeafExecutionIdentity(
      { workspaceId: seeded.workspace },
      seeded.step,
      seeded.attempt
    ),
    {
      attemptId: seeded.attempt,
      effectAdapterKey: seeded.effectAdapterKey,
      eventId: message.eventId,
      runId: seeded.run,
      startKey: `effect:${seeded.attempt}`,
      stepRunId: seeded.step,
      workspaceId: seeded.workspace,
    }
  );
  await inspection`
    UPDATE kurobara_core.step_attempts
    SET state = 'in_flight'
    WHERE workspace_id = ${seeded.workspace}
      AND attempt_id = ${seeded.attempt}
  `;
  assert.equal(
    (
      await runtime.stepQueries.getLeafExecutionIdentity(
        { workspaceId: seeded.workspace },
        seeded.step,
        seeded.attempt
      )
    )?.startKey,
    `effect:${seeded.attempt}`
  );
  await inspection`
    UPDATE kurobara_core.step_attempts
    SET state = 'succeeded'
    WHERE workspace_id = ${seeded.workspace}
      AND attempt_id = ${seeded.attempt}
  `;
  assert.equal(
    (
      await runtime.stepQueries.getLeafExecutionIdentity(
        { workspaceId: seeded.workspace },
        seeded.step,
        seeded.attempt
      )
    )?.eventId,
    message.eventId
  );
  await inspection`
    UPDATE kurobara_core.step_attempts
    SET state = 'claimed'
    WHERE workspace_id = ${seeded.workspace}
      AND attempt_id = ${seeded.attempt}
  `;

  const claim = await runtime.leafOutbox.claimNext({
    claimedBy: "append-cleanup",
    leaseMilliseconds: 1000,
  });
  assert.ok(claim);
  assert.deepEqual(
    await runtime.leafOutbox.recordRejected({
      claimedBy: claim.claimedBy,
      claimToken: claim.claimToken,
      messageId: claim.message.messageId,
      reason: "integration-cleanup",
      scope: { workspaceId: seeded.workspace },
    }),
    { status: "applied" }
  );
});

test("rolls back the leaf message and binding with the step transaction", async () => {
  const seeded = await seedAttempt("rollback");
  const message = messageFor("rollback", seeded);
  const scope = { workspaceId: seeded.workspace } as const;
  await assert.rejects(
    runtime.stepExecution.transaction(scope, async (unitOfWork) => {
      await unitOfWork.leafOutbox.append(scope, message);
      throw new Error("synthetic transaction rollback");
    }),
    SYNTHETIC_ROLLBACK
  );

  const rows = await inspection<
    readonly { bindings: string; messages: string }[]
  >`
    SELECT
      (SELECT count(*)::text FROM kurobara_core.outbox_messages
       WHERE message_id = ${message.messageId}) AS messages,
      (SELECT count(*)::text FROM kurobara_core.step_leaf_execution_bindings
       WHERE attempt_id = ${seeded.attempt}) AS bindings
  `;
  assert.deepEqual(rows[0], { bindings: "0", messages: "0" });
});

test("claims once, reclaims with reconciliation, and fences stale or foreign settlement", async () => {
  const seeded = await seedAttempt("fencing");
  const message = messageFor("fencing", seeded);
  await append(seeded, message);

  const concurrentClaims = await Promise.all([
    runtime.leafOutbox.claimNext({
      claimedBy: "leaf-worker-a",
      leaseMilliseconds: 40,
    }),
    runtime.leafOutbox.claimNext({
      claimedBy: "leaf-worker-b",
      leaseMilliseconds: 40,
    }),
  ]);
  const firstClaim = concurrentClaims.find((claim) => claim !== undefined);
  assert.ok(firstClaim);
  assert.equal(
    concurrentClaims.filter((claim) => claim !== undefined).length,
    1
  );
  assert.equal(firstClaim.binding.startKey, `effect:${seeded.attempt}`);

  assert.deepEqual(
    await runtime.leafOutbox.markStarting({
      adapterKey: "leaf-fake-v1",
      claimedBy: firstClaim.claimedBy,
      claimToken: firstClaim.claimToken,
      effectAdapterKey: "deterministic-local",
      messageId: firstClaim.message.messageId,
      scope: { workspaceId: seeded.workspace },
    }),
    { status: "applied" }
  );
  await new Promise((resolve) => setTimeout(resolve, 80));

  const reclaimed = await runtime.leafOutbox.claimNext({
    claimedBy: "leaf-worker-reclaimer",
    leaseMilliseconds: 1000,
  });
  assert.ok(reclaimed);
  assert.equal(reclaimed.binding.state, "reconciliation_required");
  assert.equal(reclaimed.attempt, 2);

  assert.deepEqual(
    await runtime.leafOutbox.recordStarted({
      adapterKey: "leaf-fake-v1",
      claimedBy: firstClaim.claimedBy,
      claimToken: firstClaim.claimToken,
      effectAdapterKey: "deterministic-local",
      externalExecutionId: "external-stale",
      messageId: firstClaim.message.messageId,
      recoveryDelayMilliseconds: 1,
      recoveryMaxAttempts: 3,
      scope: { workspaceId: seeded.workspace },
    }),
    { status: "stale" }
  );
  assert.deepEqual(
    await runtime.leafOutbox.recordStarted({
      adapterKey: "leaf-fake-v1",
      claimedBy: reclaimed.claimedBy,
      claimToken: reclaimed.claimToken,
      effectAdapterKey: "effect-other-v1",
      externalExecutionId: "external-wrong-effect-adapter",
      messageId: reclaimed.message.messageId,
      recoveryDelayMilliseconds: 1,
      recoveryMaxAttempts: 3,
      scope: { workspaceId: seeded.workspace },
    }),
    { status: "stale" }
  );
  assert.deepEqual(
    await runtime.leafOutbox.recordStarted({
      adapterKey: "leaf-fake-v1",
      claimedBy: reclaimed.claimedBy,
      claimToken: reclaimed.claimToken,
      effectAdapterKey: "deterministic-local",
      externalExecutionId: "external-foreign",
      messageId: reclaimed.message.messageId,
      recoveryDelayMilliseconds: 1,
      recoveryMaxAttempts: 3,
      scope: { workspaceId: workspaceId("workspace-foreign") },
    }),
    { status: "stale" }
  );

  assert.deepEqual(
    await runtime.leafOutbox.recordStarted({
      adapterKey: "leaf-fake-v1",
      claimedBy: reclaimed.claimedBy,
      claimToken: reclaimed.claimToken,
      effectAdapterKey: "deterministic-local",
      externalExecutionId: "external-fenced",
      messageId: reclaimed.message.messageId,
      recoveryDelayMilliseconds: 1,
      recoveryMaxAttempts: 3,
      scope: { workspaceId: seeded.workspace },
    }),
    { status: "applied" }
  );
  const rows = await inspection<
    readonly {
      binding_state: string;
      external_execution_id: string;
      outbox_state: string;
    }[]
  >`
    SELECT
      binding.state AS binding_state,
      binding.external_execution_id,
      message.state AS outbox_state
    FROM kurobara_core.step_leaf_execution_bindings AS binding
    JOIN kurobara_core.outbox_messages AS message
      ON message.workspace_id = binding.workspace_id
      AND message.message_id = binding.outbox_message_id
    WHERE binding.workspace_id = ${seeded.workspace}
      AND binding.attempt_id = ${seeded.attempt}
  `;
  assert.deepEqual(rows[0], {
    binding_state: "started",
    external_execution_id: "external-fenced",
    outbox_state: "dispatched",
  });
});

test("accepts a late settlement while the claim token is still current", async () => {
  const seeded = await seedAttempt("late-current");
  const message = messageFor("late-current", seeded);
  await append(seeded, message);

  const claim = await runtime.leafOutbox.claimNext({
    claimedBy: "leaf-worker-slow",
    leaseMilliseconds: 30,
  });
  assert.ok(claim);
  assert.deepEqual(
    await runtime.leafOutbox.markStarting({
      adapterKey: "leaf-fake-v1",
      claimedBy: claim.claimedBy,
      claimToken: claim.claimToken,
      effectAdapterKey: "deterministic-local",
      messageId: claim.message.messageId,
      scope: { workspaceId: seeded.workspace },
    }),
    { status: "applied" }
  );

  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.deepEqual(
    await runtime.leafOutbox.recordStarted({
      adapterKey: "leaf-fake-v1",
      claimedBy: claim.claimedBy,
      claimToken: claim.claimToken,
      effectAdapterKey: "deterministic-local",
      externalExecutionId: "external-slow-current",
      messageId: claim.message.messageId,
      recoveryDelayMilliseconds: 1,
      recoveryMaxAttempts: 3,
      scope: { workspaceId: seeded.workspace },
    }),
    { status: "applied" }
  );
});

test("claims leaf effect recovery once and fences technical exhaustion", async () => {
  const seeded = await seedAttempt(
    "effect-recovery",
    "effect-recovery",
    "effect-recovery-integration"
  );
  const message = messageFor("effect-recovery", seeded);
  await append(seeded, message);
  const leafClaim = await runtime.leafOutbox.claimNext({
    claimedBy: "leaf-worker-effect-recovery",
    leaseMilliseconds: 1000,
  });
  assert.ok(leafClaim);
  await runtime.leafOutbox.markStarting({
    adapterKey: "leaf-fake-v1",
    claimedBy: leafClaim.claimedBy,
    claimToken: leafClaim.claimToken,
    effectAdapterKey: seeded.effectAdapterKey,
    messageId: leafClaim.message.messageId,
    scope: { workspaceId: seeded.workspace },
  });
  assert.deepEqual(
    await runtime.leafOutbox.recordStarted({
      adapterKey: "leaf-fake-v1",
      claimedBy: leafClaim.claimedBy,
      claimToken: leafClaim.claimToken,
      effectAdapterKey: seeded.effectAdapterKey,
      externalExecutionId: "external-effect-recovery",
      messageId: leafClaim.message.messageId,
      recoveryDelayMilliseconds: 1,
      recoveryMaxAttempts: 2,
      scope: { workspaceId: seeded.workspace },
    }),
    { status: "applied" }
  );
  await new Promise((resolve) => setTimeout(resolve, 10));

  assert.equal(
    await runtime.leafEffectRecovery.claimNextForSystem({
      claimedBy: "wrong-adapter-worker",
      effectAdapterKey: "effect-other-v1",
      leaseMilliseconds: 1000,
    }),
    undefined
  );
  const concurrent = await Promise.all([
    runtime.leafEffectRecovery.claimNextForSystem({
      claimedBy: "effect-worker-a",
      effectAdapterKey: seeded.effectAdapterKey,
      leaseMilliseconds: 1000,
    }),
    runtime.leafEffectRecovery.claimNextForSystem({
      claimedBy: "effect-worker-b",
      effectAdapterKey: seeded.effectAdapterKey,
      leaseMilliseconds: 1000,
    }),
  ]);
  const first = concurrent.find((candidate) => candidate !== undefined);
  assert.ok(first);
  assert.equal(
    concurrent.filter((candidate) => candidate !== undefined).length,
    1
  );
  assert.deepEqual(
    {
      attempt: first.attempt,
      attemptId: first.attemptId,
      eventId: first.eventId,
      runId: first.runId,
      startKey: first.startKey,
      stepRunId: first.stepRunId,
      workspaceId: first.workspaceId,
    },
    {
      attempt: 1,
      attemptId: seeded.attempt,
      eventId: message.eventId,
      runId: seeded.run,
      startKey: `effect:${seeded.attempt}`,
      stepRunId: seeded.step,
      workspaceId: seeded.workspace,
    }
  );

  assert.deepEqual(
    await runtime.leafEffectRecovery.release({
      attemptId: first.attemptId,
      claimedBy: first.claimedBy,
      claimToken: first.claimToken,
      effectAdapterKey: first.effectAdapterKey,
      reason: "leaf-effect-recovery-outcome-unknown",
      retryDelayMilliseconds: 1,
      scope: { workspaceId: workspaceId("workspace-foreign") },
    }),
    { status: "claim-lost" }
  );
  assert.deepEqual(
    await runtime.leafEffectRecovery.release({
      attemptId: first.attemptId,
      claimedBy: first.claimedBy,
      claimToken: first.claimToken,
      effectAdapterKey: first.effectAdapterKey,
      reason: "leaf-effect-recovery-outcome-unknown",
      retryDelayMilliseconds: 1,
      scope: { workspaceId: seeded.workspace },
    }),
    { status: "settled" }
  );
  await new Promise((resolve) => setTimeout(resolve, 10));

  const second = await runtime.leafEffectRecovery.claimNextForSystem({
    claimedBy: "effect-worker-final",
    effectAdapterKey: seeded.effectAdapterKey,
    leaseMilliseconds: 1000,
  });
  assert.ok(second);
  assert.equal(second.attempt, 2);
  assert.deepEqual(
    await runtime.leafEffectRecovery.complete({
      attemptId: second.attemptId,
      claimedBy: second.claimedBy,
      claimToken: second.claimToken,
      effectAdapterKey: second.effectAdapterKey,
      scope: { workspaceId: seeded.workspace },
    }),
    { status: "claim-lost" }
  );
  assert.deepEqual(
    await runtime.leafEffectRecovery.release({
      attemptId: second.attemptId,
      claimedBy: second.claimedBy,
      claimToken: second.claimToken,
      effectAdapterKey: second.effectAdapterKey,
      reason: "leaf-effect-recovery-outcome-unknown",
      retryDelayMilliseconds: 1,
      scope: { workspaceId: seeded.workspace },
    }),
    { status: "settled" }
  );

  const rows = await inspection<
    readonly {
      attempt_state: string;
      job_state: string;
      reservation_state: string;
    }[]
  >`
    SELECT
      attempt.state AS attempt_state,
      job.state AS job_state,
      reservation.state AS reservation_state
    FROM kurobara_core.step_leaf_effect_recovery_jobs AS job
    JOIN kurobara_core.step_attempts AS attempt
      ON attempt.workspace_id = job.workspace_id
      AND attempt.attempt_id = job.attempt_id
    JOIN kurobara_core.cost_reservations AS reservation
      ON reservation.workspace_id = attempt.workspace_id
      AND reservation.reservation_id = attempt.reservation_id
    WHERE job.workspace_id = ${seeded.workspace}
      AND job.attempt_id = ${seeded.attempt}
  `;
  assert.deepEqual(rows[0], {
    attempt_state: "claimed",
    job_state: "exhausted",
    reservation_state: "reserved",
  });

  await inspection.begin(async (transaction) => {
    const sql = transaction as unknown as postgres.Sql;
    await sql`
      UPDATE kurobara_core.step_attempts
      SET state = 'succeeded'
      WHERE workspace_id = ${seeded.workspace}
        AND attempt_id = ${seeded.attempt}
    `;
    await sql`
      UPDATE kurobara_core.cost_reservations
      SET state = 'settled'
      WHERE workspace_id = ${seeded.workspace}
        AND reservation_id = 'reservation-effect-recovery'
    `;
  });
  assert.deepEqual(
    await runtime.leafEffectRecovery.reapForSystem({
      effectAdapterKey: seeded.effectAdapterKey,
    }),
    { completed: 1, exhausted: 0 }
  );
  const converged = await inspection<
    readonly { job_state: string; last_error: string }[]
  >`
    SELECT state AS job_state, last_error
    FROM kurobara_core.step_leaf_effect_recovery_jobs
    WHERE workspace_id = ${seeded.workspace}
      AND attempt_id = ${seeded.attempt}
  `;
  assert.deepEqual(converged[0], {
    job_state: "completed",
    last_error: "leaf-effect-recovery-outcome-unknown",
  });
});

test("atomically cancels terminal attempts and returns stale for a lost start", async () => {
  const terminalSeed = await seedAttempt("terminal-before-claim");
  const terminalMessage = messageFor("terminal-before-claim", terminalSeed);
  await append(terminalSeed, terminalMessage);
  await inspection`
    UPDATE kurobara_core.step_attempts
    SET state = 'failed_terminal'
    WHERE workspace_id = ${terminalSeed.workspace}
      AND attempt_id = ${terminalSeed.attempt}
  `;

  assert.equal(
    await runtime.leafOutbox.claimNext({
      claimedBy: "leaf-worker-terminal",
      leaseMilliseconds: 1000,
    }),
    undefined
  );

  const racedSeed = await seedAttempt("terminal-after-claim");
  const racedMessage = messageFor("terminal-after-claim", racedSeed);
  await append(racedSeed, racedMessage);
  const racedClaim = await runtime.leafOutbox.claimNext({
    claimedBy: "leaf-worker-raced",
    leaseMilliseconds: 30,
  });
  assert.ok(racedClaim);
  await inspection`
    UPDATE kurobara_core.step_attempts
    SET state = 'cancelled_before_effect'
    WHERE workspace_id = ${racedSeed.workspace}
      AND attempt_id = ${racedSeed.attempt}
  `;
  assert.deepEqual(
    await runtime.leafOutbox.markStarting({
      adapterKey: "leaf-fake-v1",
      claimedBy: racedClaim.claimedBy,
      claimToken: racedClaim.claimToken,
      effectAdapterKey: "deterministic-local",
      messageId: racedClaim.message.messageId,
      scope: { workspaceId: racedSeed.workspace },
    }),
    { status: "stale" }
  );
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(
    await runtime.leafOutbox.claimNext({
      claimedBy: "leaf-worker-race-cleanup",
      leaseMilliseconds: 1000,
    }),
    undefined
  );

  const terminalRows = await inspection<
    readonly { binding_state: string; message_state: string }[]
  >`
    SELECT binding.state AS binding_state, message.state AS message_state
    FROM kurobara_core.step_leaf_execution_bindings AS binding
    JOIN kurobara_core.outbox_messages AS message
      ON message.workspace_id = binding.workspace_id
      AND message.message_id = binding.outbox_message_id
    WHERE binding.outbox_message_id IN (
      ${terminalMessage.messageId}, ${racedMessage.messageId}
    )
    ORDER BY binding.outbox_message_id
  `;
  assert.deepEqual(Array.from(terminalRows), [
    { binding_state: "cancelled", message_state: "cancelled" },
    { binding_state: "cancelled", message_state: "cancelled" },
  ]);
});

test("reclaims a terminal attempt when its external start may already exist", async () => {
  const seeded = await seedAttempt("terminal-after-starting");
  const message = messageFor("terminal-after-starting", seeded);
  await append(seeded, message);
  const firstClaim = await runtime.leafOutbox.claimNext({
    claimedBy: "leaf-worker-before-terminal-callback",
    leaseMilliseconds: 30,
  });
  assert.ok(firstClaim);
  assert.deepEqual(
    await runtime.leafOutbox.markStarting({
      adapterKey: "leaf-fake-v1",
      claimedBy: firstClaim.claimedBy,
      claimToken: firstClaim.claimToken,
      effectAdapterKey: "deterministic-local",
      messageId: firstClaim.message.messageId,
      scope: { workspaceId: seeded.workspace },
    }),
    { status: "applied" }
  );
  await inspection`
    UPDATE kurobara_core.step_attempts
    SET state = 'succeeded'
    WHERE workspace_id = ${seeded.workspace}
      AND attempt_id = ${seeded.attempt}
  `;
  await new Promise((resolve) => setTimeout(resolve, 60));

  const recoveredClaim = await runtime.leafOutbox.claimNext({
    claimedBy: "leaf-worker-after-terminal-callback",
    leaseMilliseconds: 1000,
  });
  assert.ok(recoveredClaim);
  assert.equal(recoveredClaim.attempt, 2);
  assert.equal(recoveredClaim.binding.state, "reconciliation_required");
  assert.deepEqual(
    await runtime.leafOutbox.recordStarted({
      adapterKey: "leaf-fake-v1",
      claimedBy: recoveredClaim.claimedBy,
      claimToken: recoveredClaim.claimToken,
      effectAdapterKey: "deterministic-local",
      externalExecutionId: "external-terminal-callback",
      messageId: recoveredClaim.message.messageId,
      recoveryDelayMilliseconds: 1,
      recoveryMaxAttempts: 3,
      scope: { workspaceId: seeded.workspace },
    }),
    { status: "applied" }
  );
  assert.deepEqual(
    await runtime.leafEffectRecovery.reapForSystem({
      effectAdapterKey: "deterministic-local",
    }),
    { completed: 1, exhausted: 0 }
  );

  const rows = await inspection<
    readonly {
      binding_state: string;
      external_execution_id: string;
      message_state: string;
      recovery_state: string;
    }[]
  >`
    SELECT
      binding.state AS binding_state,
      binding.external_execution_id,
      message.state AS message_state,
      recovery.state AS recovery_state
    FROM kurobara_core.step_leaf_execution_bindings AS binding
    JOIN kurobara_core.outbox_messages AS message
      ON message.workspace_id = binding.workspace_id
      AND message.message_id = binding.outbox_message_id
    JOIN kurobara_core.step_leaf_effect_recovery_jobs AS recovery
      ON recovery.workspace_id = binding.workspace_id
      AND recovery.attempt_id = binding.attempt_id
    WHERE binding.workspace_id = ${seeded.workspace}
      AND binding.attempt_id = ${seeded.attempt}
  `;
  assert.deepEqual(rows[0], {
    binding_state: "started",
    external_execution_id: "external-terminal-callback",
    message_state: "dispatched",
    recovery_state: "completed",
  });
});

test("fences a late effect threshold after a proven start reset", async () => {
  const suffix = "reset-before-threshold";
  const seeded = await seedAttempt(suffix);
  const message = messageFor(suffix, seeded);
  await append(seeded, message);
  const claim = await runtime.leafOutbox.claimNext({
    claimedBy: "leaf-worker-reset-before-threshold",
    leaseMilliseconds: 1000,
  });
  assert.ok(claim);
  assert.deepEqual(
    await runtime.leafOutbox.markStarting({
      adapterKey: "leaf-fake-reset-v1",
      claimedBy: claim.claimedBy,
      claimToken: claim.claimToken,
      effectAdapterKey: "deterministic-local",
      messageId: claim.message.messageId,
      scope: { workspaceId: seeded.workspace },
    }),
    { status: "applied" }
  );
  assert.deepEqual(
    await runtime.leafOutbox.resetPending({
      claimedBy: claim.claimedBy,
      claimToken: claim.claimToken,
      messageId: claim.message.messageId,
      reason: "proven-not-started",
      retryDelayMilliseconds: 1,
      scope: { workspaceId: seeded.workspace },
    }),
    { status: "applied" }
  );
  await assert.rejects(
    runtime.stepExecution.transaction(
      { workspaceId: seeded.workspace },
      (unitOfWork) =>
        unitOfWork.attempts.update(
          { workspaceId: seeded.workspace },
          "claimed",
          inFlightAttemptFor(suffix, seeded)
        )
    ),
    LEAF_BINDING_INACTIVE
  );

  await new Promise((resolve) => setTimeout(resolve, 10));
  const cleanup = await runtime.leafOutbox.claimNext({
    claimedBy: "leaf-worker-reset-cleanup",
    leaseMilliseconds: 1000,
  });
  assert.ok(cleanup);
  assert.equal(cleanup.binding.state, "pending");
  assert.deepEqual(
    await runtime.leafOutbox.recordRejected({
      claimedBy: cleanup.claimedBy,
      claimToken: cleanup.claimToken,
      messageId: cleanup.message.messageId,
      reason: "integration-cleanup",
      scope: { workspaceId: seeded.workspace },
    }),
    { status: "applied" }
  );
});

test("keeps a post-effect reset race in reconciliation", async () => {
  const suffix = "reset-after-threshold";
  const seeded = await seedAttempt(suffix);
  const message = messageFor(suffix, seeded);
  await append(seeded, message);
  const claim = await runtime.leafOutbox.claimNext({
    claimedBy: "leaf-worker-reset-after-threshold",
    leaseMilliseconds: 30,
  });
  assert.ok(claim);
  assert.deepEqual(
    await runtime.leafOutbox.markStarting({
      adapterKey: "leaf-fake-race-v1",
      claimedBy: claim.claimedBy,
      claimToken: claim.claimToken,
      effectAdapterKey: "deterministic-local",
      messageId: claim.message.messageId,
      scope: { workspaceId: seeded.workspace },
    }),
    { status: "applied" }
  );
  const inFlight = inFlightAttemptFor(suffix, seeded);
  await runtime.stepExecution.transaction(
    { workspaceId: seeded.workspace },
    (unitOfWork) =>
      unitOfWork.attempts.update(
        { workspaceId: seeded.workspace },
        "claimed",
        inFlight
      )
  );
  await runtime.stepExecution.transaction(
    { workspaceId: seeded.workspace },
    (unitOfWork) =>
      unitOfWork.attempts.update(
        { workspaceId: seeded.workspace },
        "in_flight",
        {
          ...inFlight,
          ambiguityObservedAt: instant(3000),
          state: "ambiguous",
        }
      )
  );
  assert.deepEqual(
    await runtime.leafOutbox.resetPending({
      claimedBy: claim.claimedBy,
      claimToken: claim.claimToken,
      messageId: claim.message.messageId,
      reason: "stale-not-found-proof",
      retryDelayMilliseconds: 1,
      scope: { workspaceId: seeded.workspace },
    }),
    { status: "stale" }
  );
  await new Promise((resolve) => setTimeout(resolve, 60));

  const recovered = await runtime.leafOutbox.claimNext({
    claimedBy: "leaf-worker-race-recovery",
    leaseMilliseconds: 1000,
  });
  assert.ok(recovered);
  assert.equal(recovered.binding.state, "reconciliation_required");
  assert.deepEqual(
    await runtime.leafOutbox.recordStarted({
      adapterKey: "leaf-fake-race-v1",
      claimedBy: recovered.claimedBy,
      claimToken: recovered.claimToken,
      effectAdapterKey: "deterministic-local",
      externalExecutionId: "external-race-recovery",
      messageId: recovered.message.messageId,
      recoveryDelayMilliseconds: 1,
      recoveryMaxAttempts: 3,
      scope: { workspaceId: seeded.workspace },
    }),
    { status: "applied" }
  );
  await inspection`
    UPDATE kurobara_core.step_attempts
    SET state = 'failed_terminal'
    WHERE workspace_id = ${seeded.workspace}
      AND attempt_id = ${seeded.attempt}
  `;
  assert.deepEqual(
    await runtime.leafEffectRecovery.reapForSystem({
      effectAdapterKey: "deterministic-local",
    }),
    { completed: 1, exhausted: 0 }
  );
});

test("backs off reconciliation and persists terminal exhaustion or cancellation", async () => {
  const exhaustedSeed = await seedAttempt("exhausted");
  const exhaustedMessage = messageFor("exhausted", exhaustedSeed);
  await append(exhaustedSeed, exhaustedMessage);
  const firstClaim = await runtime.leafOutbox.claimNext({
    claimedBy: "leaf-worker-exhaustion",
    leaseMilliseconds: 1000,
  });
  assert.ok(firstClaim);
  await runtime.leafOutbox.markStarting({
    adapterKey: "leaf-fake-v1",
    claimedBy: firstClaim.claimedBy,
    claimToken: firstClaim.claimToken,
    effectAdapterKey: "deterministic-local",
    messageId: firstClaim.message.messageId,
    scope: { workspaceId: exhaustedSeed.workspace },
  });
  await runtime.leafOutbox.markReconciliationRequired({
    claimedBy: firstClaim.claimedBy,
    claimToken: firstClaim.claimToken,
    messageId: firstClaim.message.messageId,
    reason: "outcome-unknown",
    retryDelayMilliseconds: 40,
    scope: { workspaceId: exhaustedSeed.workspace },
  });
  assert.equal(
    await runtime.leafOutbox.claimNext({
      claimedBy: "leaf-worker-too-early",
      leaseMilliseconds: 1000,
    }),
    undefined
  );
  await new Promise((resolve) => setTimeout(resolve, 60));
  const reconciliationClaim = await runtime.leafOutbox.claimNext({
    claimedBy: "leaf-worker-final",
    leaseMilliseconds: 1000,
  });
  assert.ok(reconciliationClaim);
  assert.equal(reconciliationClaim.binding.state, "reconciliation_required");
  await runtime.leafOutbox.markDeadLetter({
    claimedBy: reconciliationClaim.claimedBy,
    claimToken: reconciliationClaim.claimToken,
    messageId: reconciliationClaim.message.messageId,
    reason: "attempts-exhausted",
    scope: { workspaceId: exhaustedSeed.workspace },
  });

  const cancelledSeed = await seedAttempt("cancelled");
  const cancelledMessage = messageFor("cancelled", cancelledSeed);
  await append(cancelledSeed, cancelledMessage);
  const cancellationClaim = await runtime.leafOutbox.claimNext({
    claimedBy: "leaf-worker-cancel",
    leaseMilliseconds: 1000,
  });
  assert.ok(cancellationClaim);
  await runtime.leafOutbox.markCancelled({
    claimedBy: cancellationClaim.claimedBy,
    claimToken: cancellationClaim.claimToken,
    messageId: cancellationClaim.message.messageId,
    reason: "run-cancelled",
    scope: { workspaceId: cancelledSeed.workspace },
  });

  const terminalRows = await inspection<
    readonly {
      binding_state: string;
      cancelled: boolean;
      message_id: string;
      outbox_state: string;
    }[]
  >`
    SELECT
      binding.outbox_message_id AS message_id,
      binding.state AS binding_state,
      message.state AS outbox_state,
      message.cancelled_at IS NOT NULL AS cancelled
    FROM kurobara_core.step_leaf_execution_bindings AS binding
    JOIN kurobara_core.outbox_messages AS message
      ON message.workspace_id = binding.workspace_id
      AND message.message_id = binding.outbox_message_id
    WHERE binding.outbox_message_id IN (
      ${exhaustedMessage.messageId}, ${cancelledMessage.messageId}
    )
    ORDER BY binding.outbox_message_id
  `;
  assert.deepEqual(Array.from(terminalRows), [
    {
      binding_state: "cancelled",
      cancelled: true,
      message_id: cancelledMessage.messageId,
      outbox_state: "cancelled",
    },
    {
      binding_state: "reconciliation_exhausted",
      cancelled: false,
      message_id: exhaustedMessage.messageId,
      outbox_state: "dead_letter",
    },
  ]);
});
