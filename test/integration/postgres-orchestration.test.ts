import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import {
  createPostgresRuntime,
  type PostgresRuntime,
} from "@kurobara/adapter-postgres";
import {
  makeClaimRunExecution,
  makeDispatchNextOutbox,
  makeReconcileRunOrchestrations,
} from "@kurobara/application";
import {
  eventId,
  instant,
  outboxMessageId,
  runId,
  workspaceId,
} from "@kurobara/kernel";
import type { OrchestrationPort, OutboxDispatchPort } from "@kurobara/ports";
import postgres from "postgres";

const SYNTHETIC_SETTLEMENT_OUTAGE = /synthetic settlement outage/u;

const adminUrl = process.env.KUROBARA_TEST_POSTGRES_URL;
if (adminUrl === undefined || adminUrl.trim().length === 0) {
  throw new Error(
    "KUROBARA_TEST_POSTGRES_URL must target a disposable-capable PostgreSQL admin database."
  );
}

const databaseName = `kurobara_orchestration_${process.pid}_${Date.now()}`;
const databaseUrl = new URL(adminUrl);
databaseUrl.pathname = `/${databaseName}`;
const admin = postgres(adminUrl, { max: 1 });
let runtime: PostgresRuntime;
let inspection: postgres.Sql;

before(async () => {
  await admin`CREATE DATABASE ${admin(databaseName)}`;
  runtime = createPostgresRuntime(databaseUrl.toString());
  await runtime.migrate();
  inspection = postgres(databaseUrl.toString(), { max: 2 });
});

after(async () => {
  await inspection?.end({ timeout: 5 });
  await runtime?.close();
  await admin`DROP DATABASE IF EXISTS ${admin(databaseName)} WITH (FORCE)`;
  await admin.end({ timeout: 5 });
});

const seedRun = async (suffix: string, requestedWorkspaceId?: string) => {
  const workspace = workspaceId(requestedWorkspaceId ?? `workspace-${suffix}`);
  const run = runId(`run-${suffix}`);
  const queuedEventId = eventId(`queued-${suffix}`);
  const message = outboxMessageId(`outbox-${suffix}`);
  const runPayload = {
    aggregateVersion: 1,
    createdAt: 1000,
    eventSequence: 1,
    idempotencyKey: `create-${suffix}`,
    intentionHash: `sha256:${"a".repeat(64)}`,
    resultCompleteness: "none",
    runId: run,
    runPlanId: `plan-${suffix}`,
    state: "queued",
    workspaceId: workspace,
  };
  const event = {
    actorId: "actor-test",
    correlationId: `correlation-${suffix}`,
    eventId: queuedEventId,
    eventType: "RunQueued",
    eventVersion: 1,
    occurredAt: 1000,
    runId: run,
    runPlanId: `plan-${suffix}`,
    sequence: 1,
    workspaceId: workspace,
  };
  await inspection.begin(async (transaction) => {
    const sql = transaction as unknown as postgres.Sql;
    await sql`
      INSERT INTO kurobara_core.workspaces (workspace_id) VALUES (${workspace})
      ON CONFLICT (workspace_id) DO NOTHING
    `;
    await sql`
      INSERT INTO kurobara_core.run_plans (workspace_id, run_plan_id, plan)
      VALUES (${workspace}, ${`plan-${suffix}`}, ${sql.json({ synthetic: true })})
    `;
    await sql`
      INSERT INTO kurobara_core.runs (
        workspace_id, run_id, run_plan_id, idempotency_key,
        intention_hash, cost, run
      ) VALUES (
        ${workspace}, ${run}, ${`plan-${suffix}`}, ${`create-${suffix}`},
        ${`sha256:${"a".repeat(64)}`},
        ${sql.json({ reserved: 0, spent: 0, unit: "credits" })},
        ${sql.json(runPayload)}
      )
    `;
    await sql`
      INSERT INTO kurobara_core.run_events (
        workspace_id, run_id, sequence, event_id, event, occurred_at
      ) VALUES (
        ${workspace}, ${run}, 1, ${queuedEventId}, ${sql.json(event)},
        to_timestamp(1)
      )
    `;
    await sql`
      INSERT INTO kurobara_core.outbox_messages (
        message_id, workspace_id, aggregate_id, aggregate_version,
        event_id, destination, event, available_at
      ) VALUES (
        ${message}, ${workspace}, ${run}, 1, ${queuedEventId},
        'orchestration.run.queued', ${sql.json(event)}, to_timestamp(1)
      )
    `;
    await sql`
      INSERT INTO kurobara_core.run_orchestration_bindings (
        workspace_id, run_id, outbox_message_id, start_key
      ) VALUES (${workspace}, ${run}, ${message}, ${message})
    `;
  });
  return {
    eventId: queuedEventId,
    messageId: message,
    runId: run,
    workspaceId: workspace,
  };
};

const dispatcher = (
  outbox: OutboxDispatchPort,
  orchestration: OrchestrationPort,
  workerId: string
) =>
  makeDispatchNextOutbox({
    claimLeaseMilliseconds: 30,
    maxAttempts: 3,
    orchestration,
    outbox,
    retryDelayMilliseconds: 20,
    workerId,
  });

test("reclaims a recorded start without starting a second workflow", async () => {
  const seeded = await seedRun("crash");
  let starts = 0;
  const orchestration: OrchestrationPort = {
    adapterKey: "fake-v1",
    findRunByStartKey: async () => ({ status: "not-found" }),
    startRun: () => {
      starts += 1;
      return Promise.resolve({
        orchestrationRunId: "external-crash",
        status: "accepted" as const,
      });
    },
  };
  let failOnce = true;
  const outbox: OutboxDispatchPort = {
    ...runtime.outbox,
    markDispatched: async (input) => {
      if (failOnce) {
        failOnce = false;
        throw new Error("synthetic settlement outage");
      }
      await runtime.outbox.markDispatched(input);
    },
  };
  await assert.rejects(
    () => dispatcher(outbox, orchestration, "worker-crash")(),
    SYNTHETIC_SETTLEMENT_OUTAGE
  );
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(
    (await dispatcher(runtime.outbox, orchestration, "worker-reclaim")())
      .status,
    "dispatched"
  );
  assert.equal(starts, 1);
  const rows = await inspection<
    readonly { orchestration_run_id: string; state: string }[]
  >`
    SELECT orchestration_run_id, state
    FROM kurobara_core.outbox_messages
    WHERE message_id = ${seeded.messageId}
  `;
  assert.deepEqual(rows[0], {
    orchestration_run_id: "external-crash",
    state: "dispatched",
  });
});

test("keeps an ambiguous start in reconciliation without a blind retry", async () => {
  await seedRun("ambiguous");
  let starts = 0;
  let lookups = 0;
  const orchestration: OrchestrationPort = {
    adapterKey: "fake-v1",
    findRunByStartKey: () => {
      lookups += 1;
      return Promise.resolve({ status: "not-found" as const });
    },
    startRun: () => {
      starts += 1;
      return Promise.resolve({
        reason: "response lost",
        status: "outcome-unknown" as const,
      });
    },
  };
  assert.equal(
    (await dispatcher(runtime.outbox, orchestration, "worker-ambiguous")())
      .status,
    "retry-scheduled"
  );
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(
    (await dispatcher(runtime.outbox, orchestration, "worker-reconcile")())
      .status,
    "retry-scheduled"
  );
  assert.equal(starts, 1);
  assert.equal(lookups, 1);
});

test("adopts a legacy reconciliation binding through lookup only", async () => {
  const seeded = await seedRun("legacy-adapter-adoption");
  await inspection`
    UPDATE kurobara_core.run_orchestration_bindings
    SET state = 'reconciliation_required', adapter_key = NULL
    WHERE outbox_message_id = ${seeded.messageId}
  `;
  await inspection`
    UPDATE kurobara_core.outbox_messages
    SET
      state = 'claimed',
      claimed_by = 'legacy-worker',
      claim_token = 'legacy-claim',
      claimed_until = clock_timestamp() - interval '1 second'
    WHERE message_id = ${seeded.messageId}
  `;
  let lookups = 0;
  let starts = 0;
  const orchestration: OrchestrationPort = {
    adapterKey: "fake-v1",
    findRunByStartKey: () => {
      lookups += 1;
      return Promise.resolve({
        orchestrationRunId: "external-legacy-adopted",
        status: "found" as const,
      });
    },
    startRun: () => {
      starts += 1;
      return Promise.resolve({
        orchestrationRunId: "forbidden",
        status: "accepted" as const,
      });
    },
  };

  const result = await dispatcher(
    runtime.outbox,
    orchestration,
    "worker-legacy-adoption"
  )();

  assert.equal(result.status, "dispatched");
  assert.equal(lookups, 1);
  assert.equal(starts, 0);
  const rows = await inspection<
    readonly {
      adapter_key: string;
      orchestration_run_id: string;
      outbox_state: string;
      state: string;
    }[]
  >`
    SELECT
      binding.adapter_key,
      binding.orchestration_run_id,
      binding.state,
      message.state AS outbox_state
    FROM kurobara_core.run_orchestration_bindings AS binding
    JOIN kurobara_core.outbox_messages AS message
      ON message.message_id = binding.outbox_message_id
    WHERE binding.outbox_message_id = ${seeded.messageId}
  `;
  assert.deepEqual(rows[0], {
    adapter_key: "fake-v1",
    orchestration_run_id: "external-legacy-adopted",
    outbox_state: "dispatched",
    state: "started",
  });
});

test("reconciles a bounded system batch across tenants through exact lookup", async () => {
  const first = await seedRun("operator-found-first", "workspace-operator");
  const second = await seedRun("operator-found-second", "workspace-operator");
  const foreign = await seedRun("operator-found-foreign");
  await inspection`
    UPDATE kurobara_core.run_orchestration_bindings
    SET
      state = 'reconciliation_required',
      adapter_key = 'fake-v1',
      next_reconciliation_at = CASE outbox_message_id
        WHEN ${first.messageId} THEN clock_timestamp() - interval '3 minutes'
        WHEN ${foreign.messageId} THEN clock_timestamp() - interval '2 minutes'
        ELSE clock_timestamp() - interval '1 minute'
      END
    WHERE outbox_message_id IN (
      ${first.messageId}, ${second.messageId}, ${foreign.messageId}
    )
  `;
  let starts = 0;
  const requests: unknown[] = [];
  const orchestration: OrchestrationPort = {
    adapterKey: "fake-v1",
    findRunByStartKey: (request) => {
      requests.push(request);
      return Promise.resolve({
        orchestrationRunId: `external-${request.runId}`,
        status: "found" as const,
      });
    },
    startRun: () => {
      starts += 1;
      return Promise.resolve({
        orchestrationRunId: "forbidden",
        status: "accepted",
      });
    },
  };
  const reconcile = makeReconcileRunOrchestrations({
    batchSize: 2,
    claimLeaseMilliseconds: 1000,
    lookupTimeoutMilliseconds: 250,
    maxAttempts: 5,
    operatorId: "operator-bounded",
    orchestration,
    reconciliation: runtime.orchestrationReconciliation,
    retryDelayMilliseconds: 1000,
  });

  const result = await reconcile();

  assert.equal(result.claimed, 2);
  assert.equal(result.items[0]?.status, "confirmed");
  assert.equal(result.items[1]?.status, "confirmed");
  assert.equal(starts, 0);
  assert.deepEqual(requests, [
    {
      eventId: first.eventId,
      runId: first.runId,
      startKey: first.messageId,
      workspaceId: first.workspaceId,
    },
    {
      eventId: foreign.eventId,
      runId: foreign.runId,
      startKey: foreign.messageId,
      workspaceId: foreign.workspaceId,
    },
  ]);
  const rows = await inspection<
    readonly {
      outbox_message_id: string;
      outbox_state: string;
      state: string;
      workspace_id: string;
    }[]
  >`
    SELECT
      binding.workspace_id,
      binding.outbox_message_id,
      binding.state,
      message.state AS outbox_state
    FROM kurobara_core.run_orchestration_bindings AS binding
    JOIN kurobara_core.outbox_messages AS message
      ON message.message_id = binding.outbox_message_id
    WHERE binding.outbox_message_id IN (
      ${first.messageId}, ${second.messageId}, ${foreign.messageId}
    )
    ORDER BY binding.outbox_message_id
  `;
  assert.deepEqual(Array.from(rows), [
    {
      outbox_message_id: first.messageId,
      outbox_state: "dispatched",
      state: "started",
      workspace_id: first.workspaceId,
    },
    {
      outbox_message_id: foreign.messageId,
      outbox_state: "dispatched",
      state: "started",
      workspace_id: foreign.workspaceId,
    },
    {
      outbox_message_id: second.messageId,
      outbox_state: "pending",
      state: "reconciliation_required",
      workspace_id: second.workspaceId,
    },
  ]);
});

test("keeps lookup failures redacted and never blind-starts", async () => {
  const seeded = await seedRun("operator-redaction");
  await inspection`
    UPDATE kurobara_core.run_orchestration_bindings
    SET state = 'starting', adapter_key = 'fake-v1'
    WHERE outbox_message_id = ${seeded.messageId}
  `;
  let starts = 0;
  const orchestration: OrchestrationPort = {
    adapterKey: "fake-v1",
    findRunByStartKey: () =>
      Promise.reject(new Error("token=private host=secret.example")),
    startRun: () => {
      starts += 1;
      return Promise.resolve({
        orchestrationRunId: "forbidden",
        status: "accepted",
      });
    },
  };
  const reconcile = makeReconcileRunOrchestrations({
    batchSize: 10,
    claimLeaseMilliseconds: 1000,
    lookupTimeoutMilliseconds: 250,
    maxAttempts: 5,
    operatorId: "operator-redaction",
    orchestration,
    reconciliation: runtime.orchestrationReconciliation,
    retryDelayMilliseconds: 1000,
  });

  const result = await reconcile();

  assert.equal(result.items[0]?.status, "unresolved");
  assert.equal(starts, 0);
  const rows = await inspection<
    readonly {
      last_reconciliation_error: string;
      reconciliation_claim_token: string | null;
      state: string;
    }[]
  >`
    SELECT state, reconciliation_claim_token, last_reconciliation_error
    FROM kurobara_core.run_orchestration_bindings
    WHERE outbox_message_id = ${seeded.messageId}
  `;
  assert.deepEqual(rows[0], {
    last_reconciliation_error: "orchestration-reconciliation-lookup-failed",
    reconciliation_claim_token: null,
    state: "reconciliation_required",
  });
  assert.equal(JSON.stringify(rows).includes("secret.example"), false);
});

test("backs off unresolved lookups and stops at the attempt budget", async () => {
  const seeded = await seedRun("operator-attempt-budget");
  await inspection`
    UPDATE kurobara_core.run_orchestration_bindings
    SET state = 'reconciliation_required', adapter_key = 'fake-v1'
    WHERE outbox_message_id = ${seeded.messageId}
  `;
  await inspection`
    UPDATE kurobara_core.run_orchestration_bindings
    SET next_reconciliation_at = clock_timestamp() + interval '1 hour'
    WHERE outbox_message_id <> ${seeded.messageId}
      AND adapter_key = 'fake-v1'
      AND state IN ('starting', 'reconciliation_required')
  `;
  let lookups = 0;
  const orchestration: OrchestrationPort = {
    adapterKey: "fake-v1",
    findRunByStartKey: () => {
      lookups += 1;
      return Promise.resolve({ status: "not-found" as const });
    },
    startRun: () =>
      Promise.resolve({
        orchestrationRunId: "forbidden",
        status: "accepted" as const,
      }),
  };
  const reconcile = makeReconcileRunOrchestrations({
    batchSize: 1,
    claimLeaseMilliseconds: 1000,
    lookupTimeoutMilliseconds: 250,
    maxAttempts: 2,
    operatorId: "operator-attempt-budget",
    orchestration,
    reconciliation: runtime.orchestrationReconciliation,
    retryDelayMilliseconds: 60_000,
  });

  assert.equal((await reconcile()).claimed, 1);
  assert.equal((await reconcile()).claimed, 0);
  await inspection`
    UPDATE kurobara_core.run_orchestration_bindings
    SET next_reconciliation_at = clock_timestamp()
    WHERE outbox_message_id = ${seeded.messageId}
  `;
  assert.equal((await reconcile()).claimed, 1);
  await inspection`
    UPDATE kurobara_core.run_orchestration_bindings
    SET next_reconciliation_at = clock_timestamp()
    WHERE outbox_message_id = ${seeded.messageId}
  `;
  assert.equal((await reconcile()).claimed, 0);

  const rows = await inspection<
    readonly {
      last_reconciliation_error: string;
      outbox_state: string;
      reconciliation_attempts: number;
      state: string;
    }[]
  >`
    SELECT
      binding.state,
      binding.reconciliation_attempts,
      binding.last_reconciliation_error,
      message.state AS outbox_state
    FROM kurobara_core.run_orchestration_bindings AS binding
    JOIN kurobara_core.outbox_messages AS message
      ON message.message_id = binding.outbox_message_id
    WHERE binding.outbox_message_id = ${seeded.messageId}
  `;
  assert.deepEqual(rows[0], {
    last_reconciliation_error: "orchestration-reconciliation-not-found",
    outbox_state: "dead_letter",
    reconciliation_attempts: 2,
    state: "reconciliation_exhausted",
  });
  assert.equal(lookups, 2);
});

test("reaps a final expired claim into an atomic dead letter", async () => {
  const seeded = await seedRun("operator-expired-final-claim");
  await inspection`
    UPDATE kurobara_core.run_orchestration_bindings
    SET state = 'reconciliation_required', adapter_key = 'fake-reaper-v1'
    WHERE outbox_message_id = ${seeded.messageId}
  `;
  await inspection`
    UPDATE kurobara_core.run_orchestration_bindings
    SET next_reconciliation_at = clock_timestamp() + interval '1 hour'
    WHERE outbox_message_id <> ${seeded.messageId}
      AND adapter_key = 'fake-reaper-v1'
      AND state IN ('starting', 'reconciliation_required')
  `;

  const claim = await runtime.orchestrationReconciliation.claimNextForSystem({
    adapterKey: "fake-reaper-v1",
    claimedBy: "operator-expired-final-claim",
    leaseMilliseconds: 50,
    maxAttempts: 1,
  });
  assert.ok(claim);
  await new Promise((resolve) => setTimeout(resolve, 100));

  assert.equal(
    await runtime.orchestrationReconciliation.reapExhaustedForSystem({
      adapterKey: "fake-reaper-v1",
      maxAttempts: 1,
    }),
    1
  );
  assert.equal(
    await runtime.orchestrationReconciliation.claimNextForSystem({
      adapterKey: "fake-reaper-v1",
      claimedBy: "operator-after-reap",
      leaseMilliseconds: 1000,
      maxAttempts: 1,
    }),
    undefined
  );

  const rows = await inspection<
    readonly {
      binding_error: string;
      claim_token: string | null;
      outbox_error: string;
      outbox_state: string;
      reconciliation_attempts: number;
      state: string;
    }[]
  >`
    SELECT
      binding.state,
      binding.reconciliation_attempts,
      binding.reconciliation_claim_token AS claim_token,
      binding.last_reconciliation_error AS binding_error,
      message.state AS outbox_state,
      message.last_error AS outbox_error
    FROM kurobara_core.run_orchestration_bindings AS binding
    JOIN kurobara_core.outbox_messages AS message
      ON message.workspace_id = binding.workspace_id
      AND message.message_id = binding.outbox_message_id
    WHERE binding.outbox_message_id = ${seeded.messageId}
  `;
  assert.deepEqual(rows[0], {
    binding_error: "orchestration-reconciliation-attempts-exhausted",
    claim_token: null,
    outbox_error: "orchestration-reconciliation-attempts-exhausted",
    outbox_state: "dead_letter",
    reconciliation_attempts: 1,
    state: "reconciliation_exhausted",
  });
});

test("fences concurrent reconciliation claims with the database clock", async () => {
  const seeded = await seedRun("operator-fencing");
  await inspection`
    UPDATE kurobara_core.run_orchestration_bindings
    SET state = 'reconciliation_required', adapter_key = 'fake-v1'
    WHERE outbox_message_id = ${seeded.messageId}
  `;
  await inspection`
    UPDATE kurobara_core.run_orchestration_bindings
    SET next_reconciliation_at = clock_timestamp() + interval '1 hour'
    WHERE outbox_message_id <> ${seeded.messageId}
      AND adapter_key = 'fake-v1'
      AND state IN ('starting', 'reconciliation_required')
  `;
  const firstClaim =
    await runtime.orchestrationReconciliation.claimNextForSystem({
      adapterKey: "fake-v1",
      claimedBy: "operator-first",
      leaseMilliseconds: 200,
      maxAttempts: 5,
    });
  assert.ok(firstClaim);
  assert.equal(
    await runtime.orchestrationReconciliation.claimNextForSystem({
      adapterKey: "fake-v1",
      claimedBy: "operator-second",
      leaseMilliseconds: 1000,
      maxAttempts: 5,
    }),
    undefined
  );
  await inspection`
    UPDATE kurobara_core.outbox_messages
    SET available_at = clock_timestamp() + interval '1 hour'
    WHERE message_id <> ${seeded.messageId}
      AND state IN ('pending', 'retry')
  `;
  assert.equal(
    await runtime.outbox.claimNext({
      claimedBy: "dispatcher-concurrent",
      leaseMilliseconds: 1000,
    }),
    undefined
  );
  await new Promise((resolve) => setTimeout(resolve, 250));
  const secondClaim =
    await runtime.orchestrationReconciliation.claimNextForSystem({
      adapterKey: "fake-v1",
      claimedBy: "operator-second",
      leaseMilliseconds: 1000,
      maxAttempts: 5,
    });
  assert.ok(secondClaim);
  assert.deepEqual(
    await runtime.orchestrationReconciliation.release({
      adapterKey: "fake-v1",
      claimedBy: firstClaim.claimedBy,
      claimToken: firstClaim.claimToken,
      maxAttempts: 5,
      messageId: firstClaim.messageId,
      reason: "stale-result",
      retryDelayMilliseconds: 1000,
      scope: { workspaceId: seeded.workspaceId },
    }),
    { status: "claim-lost" }
  );
  const settlement = {
    adapterKey: "fake-v1",
    claimedBy: secondClaim.claimedBy,
    claimToken: secondClaim.claimToken,
    messageId: secondClaim.messageId,
    orchestrationRunId: "external-fenced",
    scope: { workspaceId: seeded.workspaceId },
  };
  assert.deepEqual(
    await runtime.orchestrationReconciliation.confirm({
      ...settlement,
      scope: { workspaceId: workspaceId("workspace-wrong-settlement") },
    }),
    { status: "claim-lost" }
  );
  assert.deepEqual(
    await runtime.orchestrationReconciliation.confirm(settlement),
    { status: "settled" }
  );
  assert.deepEqual(
    await runtime.orchestrationReconciliation.confirm(settlement),
    { status: "settled" }
  );

  const rows = await inspection<
    readonly {
      orchestration_run_id: string;
      reconciliation_attempts: number;
      state: string;
    }[]
  >`
    SELECT state, orchestration_run_id, reconciliation_attempts
    FROM kurobara_core.run_orchestration_bindings
    WHERE outbox_message_id = ${seeded.messageId}
  `;
  assert.deepEqual(rows[0], {
    orchestration_run_id: "external-fenced",
    reconciliation_attempts: 2,
    state: "started",
  });
});

test("claims the run aggregate once and replays the same ClaimRun command", async () => {
  const seeded = await seedRun("claim");
  let nextEvent = 0;
  const claim = makeClaimRunExecution({
    clock: { now: async () => instant(2000) },
    identifiers: {
      nextEventId: async () => eventId(`run-started-${++nextEvent}`),
      nextOutboxMessageId: async () => outboxMessageId("unused-outbox"),
      nextRunId: async () => runId("unused-run"),
    },
    persistence: runtime.runExecution,
  });
  const input = { ...seeded, startKey: seeded.messageId };
  const first = await claim(input);
  const replay = await claim(input);
  assert.equal(first.ok, true);
  assert.equal(replay.ok, true);
  if (first.ok && replay.ok) {
    assert.equal(first.value.run.state, "running");
    assert.equal(replay.value.replayed, true);
  }
  const counts = await inspection<
    readonly { commands: string; started: string }[]
  >`
    SELECT
      (SELECT count(*)::text FROM kurobara_core.run_command_journal
        WHERE run_id = ${seeded.runId}) AS commands,
      (SELECT count(*)::text FROM kurobara_core.run_events
        WHERE run_id = ${seeded.runId} AND sequence = 2) AS started
  `;
  assert.deepEqual(counts[0], { commands: "1", started: "1" });
});

test("rejects a second binding for the same tenant run", async () => {
  const seeded = await seedRun("binding");
  await assert.rejects(
    () => inspection`
    INSERT INTO kurobara_core.run_orchestration_bindings (
      workspace_id, run_id, outbox_message_id, start_key
    ) VALUES (
      ${seeded.workspaceId}, ${seeded.runId}, ${seeded.messageId}, 'other-key'
    )
  `
  );
});

test("rejects a binding to another tenant run message", async () => {
  const left = await seedRun("binding-left");
  const right = await seedRun("binding-right");
  await inspection`
    DELETE FROM kurobara_core.run_orchestration_bindings
    WHERE outbox_message_id IN (${left.messageId}, ${right.messageId})
  `;

  await assert.rejects(
    () => inspection`
      INSERT INTO kurobara_core.run_orchestration_bindings (
        workspace_id, run_id, outbox_message_id, start_key
      ) VALUES (
        ${left.workspaceId}, ${left.runId}, ${right.messageId}, 'cross-tenant-key'
      )
    `
  );
});
