import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { HatchetClient } from "@hatchet-dev/typescript-sdk/v1/index.js";
import { createHatchetOrchestration } from "@kurobara/adapter-orchestration-hatchet";
import { JSON_SCHEMA_OUTPUT_VALIDATOR_VERSION } from "@kurobara/adapter-output-json-schema";
import {
  createPostgresRuntime,
  type PostgresRuntime,
} from "@kurobara/adapter-postgres";
import { makeCreateRunFromPlan, prepareRunPlan } from "@kurobara/application";
import {
  actorId,
  attemptId,
  capabilityId,
  contentHash,
  correlationId,
  eventId,
  idempotencyKey,
  instant,
  outboxMessageId,
  type RunId,
  type RunPlan,
  runId,
  runPlanId,
  type StepRunId,
  stepRunId,
  type WorkspaceId,
  workflowSpecId,
  workspaceId,
} from "@kurobara/kernel";
import type { StartLeafAttemptRequest } from "@kurobara/ports";
import postgres from "postgres";

import { deterministicOutputContract } from "../../../apps/worker/src/deterministic-output.ts";

const TEST_TIMEOUT_MILLISECONDS = 120_000;
const PHASE_TIMEOUT_MILLISECONDS = 30_000;
const POLL_INTERVAL_MILLISECONDS = 50;
const REPOSITORY_ROOT = fileURLToPath(new URL("../../../", import.meta.url));

const requiredEnvironment = (name: string): string => {
  const value = process.env[name];
  if (value === undefined || value.length === 0) {
    throw new Error(`${name} is required by the Hatchet worker integration.`);
  }
  return value;
};

const adminUrl = requiredEnvironment("KUROBARA_TEST_POSTGRES_URL");

const hash = (value: string) =>
  contentHash(`sha256:${value.repeat(64).slice(0, 64)}`);

type DatabaseFixture = Readonly<{
  admin: postgres.Sql;
  databaseName: string;
  databaseUrl: string;
  inspection: postgres.Sql;
  runtime: PostgresRuntime;
}>;

type RunnableRun = Readonly<{
  run: RunId;
  workspace: WorkspaceId;
}>;

type ClaimedLeaf = Readonly<{
  request: StartLeafAttemptRequest;
  step: StepRunId;
}>;

type WorkerHandle = Readonly<{
  applicationName: string;
  child: ChildProcess;
  diagnostics(): string;
  exit: Promise<readonly [number | null, NodeJS.Signals | null]>;
}>;

type LeafState = Readonly<{
  adapter_key: string | null;
  attempt_state: string;
  binding_state: string;
  effect_adapter_key: string | null;
  effect_started_events: string;
  external_execution_id: string | null;
  leaf_dispatch_attempts: number;
  leaf_outbox_state: string;
  recovery_attempts: number | null;
  recovery_state: string | null;
  reservation_state: string;
  run_reserved: string;
  run_spent: string;
  run_state: string;
  step_state: string;
  succeeded_events: string;
  usage_amount: string | null;
  usage_entries: string;
}>;

type PreRecordState = Omit<LeafState, "recovery_attempts" | "recovery_state"> &
  Readonly<{ claim_expired: boolean }>;

const waitFor = async <Value>(options: {
  readonly accept: (value: Value) => boolean;
  readonly description: string;
  readonly read: () => Promise<Value>;
  readonly timeoutMilliseconds?: number;
  readonly worker?: WorkerHandle;
}): Promise<Value> => {
  const deadline =
    Date.now() + (options.timeoutMilliseconds ?? PHASE_TIMEOUT_MILLISECONDS);
  let lastValue: Value | undefined;
  while (Date.now() < deadline) {
    if (
      options.worker !== undefined &&
      (options.worker.child.exitCode !== null ||
        options.worker.child.signalCode !== null)
    ) {
      throw new Error(
        `The Kurobara worker exited before ${options.description}. ${options.worker.diagnostics()}`
      );
    }
    lastValue = await options.read();
    if (options.accept(lastValue)) {
      return lastValue;
    }
    await new Promise((resolve) =>
      setTimeout(resolve, POLL_INTERVAL_MILLISECONDS)
    );
  }
  throw new Error(
    `Timed out waiting for ${options.description}. Last state: ${JSON.stringify(lastValue)}`
  );
};

const createDatabaseFixture = async (
  suffix: string
): Promise<DatabaseFixture> => {
  const databaseName = `kurobara_hatchet_${process.pid}_${suffix}`;
  const databaseUrl = new URL(adminUrl);
  databaseUrl.pathname = `/${databaseName}`;
  const admin = postgres(adminUrl, { max: 1 });
  let inspection: postgres.Sql | undefined;
  let runtime: PostgresRuntime | undefined;
  try {
    await admin`CREATE DATABASE ${admin(databaseName)}`;
    runtime = createPostgresRuntime(databaseUrl.toString());
    await runtime.migrate();
    await runtime.verifyMigrations();
    inspection = postgres(databaseUrl.toString(), { max: 6 });
    return {
      admin,
      databaseName,
      databaseUrl: databaseUrl.toString(),
      inspection,
      runtime,
    };
  } catch (error) {
    await inspection?.end({ timeout: 5 }).catch(() => undefined);
    await runtime?.close().catch(() => undefined);
    await admin`
      DROP DATABASE IF EXISTS ${admin(databaseName)} WITH (FORCE)
    `.catch(() => undefined);
    await admin.end({ timeout: 5 }).catch(() => undefined);
    throw error;
  }
};

const closeDatabaseFixture = async (
  fixture: DatabaseFixture
): Promise<void> => {
  await fixture.inspection.end({ timeout: 5 });
  await fixture.runtime.close();
  await fixture.admin`
    DROP DATABASE IF EXISTS ${fixture.admin(fixture.databaseName)} WITH (FORCE)
  `;
  await fixture.admin.end({ timeout: 5 });
};

const planFor = (
  workspace: WorkspaceId,
  actor: ReturnType<typeof actorId>,
  suffix: string,
  nodes: readonly Readonly<{
    dependsOn: readonly string[];
    key: string;
  }>[] = [{ dependsOn: [], key: "execute" }]
): RunPlan => {
  const now = Date.now();
  const capability = {
    capabilityId: capabilityId("test.kurobara.deterministic-leaf"),
    capabilityVersion: "1.0.0",
  };
  const contract = {
    catalogFingerprint: deterministicOutputContract.catalogFingerprint,
    catalogVersion: deterministicOutputContract.catalogVersion,
    schemaFingerprint: hash("b"),
    schemaId: "https://schemas.kurobara.invalid/inputs/document/1.0.0",
    schemaVersion: "1.0.0",
  };
  const prepared = prepareRunPlan({
    actorPermissions: ["runs:create", "steps:execute"],
    allowedCapabilities: [capability.capabilityId],
    authority: {
      authorityEnvelopeId: `authority-${suffix}`,
      budgetLimit: { limit: 10, reserved: 0, spent: 0, unit: "credits" },
      capabilities: [capability],
      deadline: instant(now + 300_000),
      permissions: ["runs:create", "steps:execute"],
      subjectActorId: actor,
      version: "1.0.0",
      workspaceId: workspace,
    },
    budget: { limit: 5, reserved: 0, spent: 0, unit: "credits" },
    catalogFingerprint: deterministicOutputContract.catalogFingerprint,
    catalogVersion: deterministicOutputContract.catalogVersion,
    compilationLimits: {
      maxDepth: Math.max(2, nodes.length),
      maxFanOut: 2,
      maxNodes: Math.max(2, nodes.length),
    },
    compilerVersion: "1.0.0",
    deadline: instant(now + 240_000),
    inputContract: contract,
    normalizedInputHash: hash("c"),
    now: instant(now),
    outputContract: deterministicOutputContract,
    planHash: hash("d"),
    policy: {
      factsHash: hash("e"),
      requiredPermission: "runs:create",
      version: "1.0.0",
    },
    quote: {
      expiresAt: instant(now + 180_000),
      guarantee: "hard",
      pricingVersion: "1.0.0",
      quoteId: `quote-${suffix}`,
      unit: "credits",
      upperBound: 5,
    },
    retryPolicy: { maxAttemptsPerStep: 3 },
    routeSnapshots: nodes.map((node) => ({
      capability,
      effectAdapterKey: "deterministic-local",
      factsHash: hash("e"),
      nodeKey: node.key,
      pricingVersion: "1.0.0",
      reservableUpperBound: 0,
      reservationUnit: "credits",
      routeKey: `deterministic-local-${node.key}`,
    })),
    runPlanId: runPlanId(`plan-${suffix}`),
    workflow: {
      contentHash: hash("f"),
      nodes: nodes.map((node) => ({ capability, ...node })),
      revision: "1.0.0",
      workflowSpecId: workflowSpecId(`workflow-${suffix}`),
    },
    workspaceId: workspace,
  });
  if (!prepared.ok) {
    throw new Error(
      `The worker qualification plan was rejected: ${prepared.error.code}.`
    );
  }
  return prepared.value;
};

const createRunnableRun = async (
  fixture: DatabaseFixture,
  suffix: string,
  nodes?: readonly Readonly<{
    dependsOn: readonly string[];
    key: string;
  }>[]
): Promise<RunnableRun> => {
  const workspace = workspaceId(`workspace-${suffix}`);
  const actor = actorId(`actor-${suffix}`);
  const plan = planFor(workspace, actor, suffix, nodes);
  const scope = { workspaceId: workspace } as const;
  await fixture.runtime.bootstrapApiKey({
    actorId: actor,
    label: "Hatchet worker qualification",
    permissions: ["runs:create", "steps:execute"],
    workspaceId: workspace,
  });
  await fixture.runtime.persistence.transaction(scope, (unitOfWork) =>
    unitOfWork.runPlans.insert(scope, plan)
  );
  const created = await makeCreateRunFromPlan({
    clock: { now: async () => instant(Date.now()) },
    identifiers: {
      nextEventId: async () => eventId(`run-event-${suffix}`),
      nextOutboxMessageId: async () => outboxMessageId(`run-outbox-${suffix}`),
      nextRunId: async () => runId(`run-${suffix}`),
    },
    persistence: fixture.runtime.persistence,
    requiredPermission: "runs:create",
  })({
    actorId: actor,
    actorPermissions: ["runs:create"],
    authenticationMode: "api-key",
    correlationId: correlationId(`run-correlation-${suffix}`),
    idempotencyKey: idempotencyKey(`run-create-${suffix}`),
    intentionHash: plan.planHash,
    runPlanId: plan.runPlanId,
    workspaceId: workspace,
  });
  if (!created.ok) {
    throw new Error(
      `The worker qualification run was rejected: ${created.error.code}.`
    );
  }
  return { run: created.value.run.runId, workspace };
};

const waitForAutomaticLeaf = async (options: {
  readonly fixture: DatabaseFixture;
  readonly nodeKey?: string;
  readonly run: RunnableRun;
  readonly worker: WorkerHandle;
}): Promise<ClaimedLeaf> => {
  const nodeKey = options.nodeKey ?? "execute";
  const routed = await waitFor({
    accept: (candidate) => candidate !== undefined,
    description: `the route scheduler to claim node ${nodeKey}`,
    read: async () => {
      const rows = await options.fixture.inspection<
        readonly {
          attempt_id: string;
          event_id: string;
          start_key: string;
          step_run_id: string;
        }[]
      >`
        SELECT
          attempt.attempt_id,
          binding.event_id,
          binding.start_key,
          step.step_run_id
        FROM kurobara_core.step_runs AS step
        JOIN kurobara_core.step_attempts AS attempt
          ON attempt.workspace_id = step.workspace_id
          AND attempt.step_run_id = step.step_run_id
        JOIN kurobara_core.step_leaf_execution_bindings AS binding
          ON binding.workspace_id = attempt.workspace_id
          AND binding.step_run_id = attempt.step_run_id
          AND binding.attempt_id = attempt.attempt_id
        WHERE step.workspace_id = ${options.run.workspace}
          AND step.run_id = ${options.run.run}
          AND step.node_key = ${nodeKey}
        ORDER BY attempt.attempt_number DESC
        LIMIT 1
      `;
      return rows[0];
    },
    worker: options.worker,
  });
  if (routed === undefined) {
    throw new Error(`The route scheduler did not claim node ${nodeKey}.`);
  }
  const step = stepRunId(routed.step_run_id);
  return {
    request: {
      attemptId: attemptId(routed.attempt_id),
      eventId: eventId(routed.event_id),
      runId: options.run.run,
      startKey: routed.start_key,
      stepRunId: step,
      workspaceId: options.run.workspace,
    },
    step,
  };
};

const workerEnvironment = (
  databaseUrl: string,
  suffix: string
): Record<string, string> => ({
  HATCHET_CLIENT_API_URL: requiredEnvironment("HATCHET_CLIENT_API_URL"),
  HATCHET_CLIENT_HOST_PORT: requiredEnvironment("HATCHET_CLIENT_HOST_PORT"),
  HATCHET_CLIENT_NAMESPACE: requiredEnvironment("HATCHET_CLIENT_NAMESPACE"),
  HATCHET_CLIENT_TLS_STRATEGY: requiredEnvironment(
    "HATCHET_CLIENT_TLS_STRATEGY"
  ),
  HATCHET_CLIENT_TOKEN: requiredEnvironment("HATCHET_CLIENT_TOKEN"),
  KUROBARA_DAG_SCHEDULER_POLL_INTERVAL_MS: "50",
  KUROBARA_DATABASE_MIGRATION_MODE: "verify",
  KUROBARA_DATABASE_URL: databaseUrl,
  KUROBARA_DISPATCHER_ID: `run-dispatcher-${suffix}`,
  KUROBARA_HATCHET_IDEMPOTENCY_TTL_MS: "120000",
  KUROBARA_HATCHET_WORKER_SLOTS: "1",
  KUROBARA_LEAF_DISPATCHER_ID: `leaf-dispatcher-${suffix}`,
  KUROBARA_LEAF_EFFECT_ADAPTER: "deterministic-local",
  KUROBARA_LEAF_EFFECT_RECONCILER_CLAIM_LEASE_MS: "2000",
  KUROBARA_LEAF_EFFECT_RECONCILER_ID: `effect-reconciler-${suffix}`,
  KUROBARA_LEAF_EFFECT_RECONCILER_INITIAL_DELAY_MS: "1000",
  KUROBARA_LEAF_EFFECT_RECONCILER_MAX_ATTEMPTS: "5",
  KUROBARA_LEAF_EFFECT_RECONCILER_OPERATION_TIMEOUT_MS: "500",
  KUROBARA_LEAF_EFFECT_RECONCILER_POLL_INTERVAL_MS: "50",
  KUROBARA_LEAF_EFFECT_RECONCILER_RETRY_DELAY_MS: "100",
  KUROBARA_LEAF_OUTBOX_CLAIM_LEASE_MS: "1000",
  KUROBARA_LEAF_OUTBOX_MAX_ATTEMPTS: "5",
  KUROBARA_LEAF_OUTBOX_POLL_INTERVAL_MS: "50",
  KUROBARA_LEAF_OUTBOX_RETRY_DELAY_MS: "100",
  KUROBARA_OUTBOX_CLAIM_LEASE_MS: "1000",
  KUROBARA_OUTBOX_MAX_ATTEMPTS: "5",
  KUROBARA_OUTBOX_POLL_INTERVAL_MS: "50",
  KUROBARA_OUTBOX_RETRY_DELAY_MS: "100",
  KUROBARA_RECONCILER_CLAIM_LEASE_MS: "2000",
  KUROBARA_RECONCILER_ID: `run-reconciler-${suffix}`,
  KUROBARA_RECONCILER_LOOKUP_TIMEOUT_MS: "500",
  KUROBARA_RECONCILER_MAX_ATTEMPTS: "5",
  KUROBARA_RECONCILER_POLL_INTERVAL_MS: "50",
  KUROBARA_RECONCILER_RETRY_DELAY_MS: "100",
  KUROBARA_ROUTE_SCHEDULER_ID: `route-scheduler-${suffix}`,
  KUROBARA_ROUTE_SCHEDULER_POLL_INTERVAL_MS: "50",
  KUROBARA_ROUTE_SCHEDULER_RETRY_DELAY_MS: "100",
  KUROBARA_SHUTDOWN_TIMEOUT_MS: "5000",
  KUROBARA_WORKER_ID: `worker-${suffix}`,
  KUROBARA_WORKER_READINESS_TIMEOUT_MS: "15000",
  NODE_ENV: "test",
});

const redactDiagnostics = (
  value: string,
  secrets: readonly string[]
): string => {
  let redacted = value;
  for (const secret of secrets) {
    if (secret.length > 0) {
      redacted = redacted.split(secret).join("[redacted]");
    }
  }
  return redacted.slice(-4096).trim();
};

const startWorker = (databaseUrl: string, suffix: string): WorkerHandle => {
  const databaseApplicationName = `kb-${process.pid}-${suffix.slice(0, 48)}`;
  const workerDatabaseUrl = new URL(databaseUrl);
  workerDatabaseUrl.searchParams.set(
    "application_name",
    databaseApplicationName
  );
  const environment = workerEnvironment(workerDatabaseUrl.toString(), suffix);
  let output = "";
  const child = spawn(
    process.execPath,
    [
      "--experimental-strip-types",
      `${REPOSITORY_ROOT}apps/worker/src/index.ts`,
    ],
    {
      cwd: REPOSITORY_ROOT,
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
    }
  );
  const collect = (chunk: Buffer | string): void => {
    output = `${output}${chunk.toString()}`.slice(-8192);
  };
  child.stdout?.on("data", collect);
  child.stderr?.on("data", collect);
  const exit = once(child, "exit") as unknown as Promise<
    readonly [number | null, NodeJS.Signals | null]
  >;
  return {
    applicationName: databaseApplicationName,
    child,
    diagnostics: () => {
      const safe = redactDiagnostics(output, [
        environment.HATCHET_CLIENT_TOKEN,
        environment.KUROBARA_DATABASE_URL,
      ]);
      return safe.length === 0 ? "No worker diagnostics were emitted." : safe;
    },
    exit,
  };
};

const stopWorker = async (
  worker: WorkerHandle,
  signal: NodeJS.Signals = "SIGTERM"
): Promise<readonly [number | null, NodeJS.Signals | null]> => {
  if (worker.child.exitCode === null && worker.child.signalCode === null) {
    worker.child.kill(signal);
  }
  let timeout: NodeJS.Timeout | undefined;
  const expired = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(
      () => reject(new Error("The Kurobara worker did not stop in time.")),
      15_000
    );
  });
  try {
    return await Promise.race([worker.exit, expired]);
  } catch (error) {
    worker.child.kill("SIGKILL");
    await worker.exit;
    throw error;
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
  }
};

const waitForRun = (
  fixture: DatabaseFixture,
  run: RunnableRun,
  worker: WorkerHandle
) =>
  waitFor({
    accept: (state) => state === "running",
    description: "the real Hatchet run callback to claim the run",
    read: async () =>
      (
        await fixture.runtime.runQueries.get(
          { workspaceId: run.workspace },
          run.run
        )
      )?.run.state,
    worker,
  });

const readDagNodeStates = async (fixture: DatabaseFixture, run: RunnableRun) =>
  fixture.inspection<readonly { node_key: string; state: string }[]>`
    SELECT node_key, state
    FROM kurobara_core.step_runs
    WHERE workspace_id = ${run.workspace}
      AND run_id = ${run.run}
    ORDER BY node_key
  `;

const waitForDagSuccess = (
  fixture: DatabaseFixture,
  run: RunnableRun,
  worker: WorkerHandle
) =>
  waitFor({
    accept: (completed) => completed,
    description: "the DAG scheduler to persist the successful result bundle",
    read: async () => {
      const rows = await fixture.inspection<readonly { completed: boolean }[]>`
        SELECT
          NOT pending
          AND processed_at IS NOT NULL
          AND processed_at >= requested_at
          AND last_outcome = 'success-finalized'
          AND blocked_reason IS NULL
          AND evaluated_at IS NOT NULL
          AND evaluated_at >= requested_at
          AND stored_run.run ->> 'state' = 'completed'
          AND stored_run.run ->> 'resultCompleteness' = 'complete'
          AS completed
        FROM kurobara_core.run_dag_schedule_jobs
        JOIN kurobara_core.runs AS stored_run USING (workspace_id, run_id)
        WHERE workspace_id = ${run.workspace}
          AND run_id = ${run.run}
      `;
      return rows[0]?.completed ?? false;
    },
    worker,
  });

const waitForDagStaleTerminal = (
  fixture: DatabaseFixture,
  run: RunnableRun,
  worker: WorkerHandle
) =>
  waitFor({
    accept: (stale) => stale,
    description: "the restarted DAG scheduler to consume the terminal wake-up",
    read: async () => {
      const rows = await fixture.inspection<readonly { stale: boolean }[]>`
        SELECT
          NOT pending
          AND last_outcome = 'stale-terminal'
          AND blocked_reason IS NULL
          AND stored_run.run ->> 'state' = 'completed' AS stale
        FROM kurobara_core.run_dag_schedule_jobs
        JOIN kurobara_core.runs AS stored_run USING (workspace_id, run_id)
        WHERE workspace_id = ${run.workspace}
          AND run_id = ${run.run}
      `;
      return rows[0]?.stale ?? false;
    },
    worker,
  });

const readLeafState = async (
  fixture: DatabaseFixture,
  leaf: ClaimedLeaf
): Promise<LeafState> => {
  const rows = await fixture.inspection<readonly LeafState[]>`
    SELECT
      stored_run.run ->> 'state' AS run_state,
      stored_run.cost ->> 'reserved' AS run_reserved,
      stored_run.cost ->> 'spent' AS run_spent,
      step.state AS step_state,
      attempt.state AS attempt_state,
      reservation.state AS reservation_state,
      message.state AS leaf_outbox_state,
      message.attempts AS leaf_dispatch_attempts,
      binding.state AS binding_state,
      binding.adapter_key,
      binding.effect_adapter_key,
      binding.external_execution_id,
      recovery.state AS recovery_state,
      recovery.attempts AS recovery_attempts,
      (SELECT count(*)::text
       FROM kurobara_core.step_events AS started_event
       WHERE started_event.workspace_id = attempt.workspace_id
         AND started_event.step_run_id = attempt.step_run_id
         AND started_event.event ->> 'eventType' = 'AttemptEffectStarted')
        AS effect_started_events,
      (SELECT count(*)::text
       FROM kurobara_core.step_events AS succeeded_event
       WHERE succeeded_event.workspace_id = attempt.workspace_id
         AND succeeded_event.step_run_id = attempt.step_run_id
         AND succeeded_event.event ->> 'eventType' = 'AttemptSucceeded')
        AS succeeded_events,
      (SELECT count(*)::text
       FROM kurobara_core.usage_ledger_entries AS usage
       WHERE usage.workspace_id = attempt.workspace_id
         AND usage.attempt_id = attempt.attempt_id) AS usage_entries,
      (SELECT usage.amount::text
       FROM kurobara_core.usage_ledger_entries AS usage
       WHERE usage.workspace_id = attempt.workspace_id
         AND usage.attempt_id = attempt.attempt_id) AS usage_amount
    FROM kurobara_core.step_attempts AS attempt
    JOIN kurobara_core.step_runs AS step
      ON step.workspace_id = attempt.workspace_id
      AND step.step_run_id = attempt.step_run_id
    JOIN kurobara_core.runs AS stored_run
      ON stored_run.workspace_id = step.workspace_id
      AND stored_run.run_id = step.run_id
    JOIN kurobara_core.cost_reservations AS reservation
      ON reservation.workspace_id = attempt.workspace_id
      AND reservation.reservation_id = attempt.reservation_id
    JOIN kurobara_core.step_leaf_execution_bindings AS binding
      ON binding.workspace_id = attempt.workspace_id
      AND binding.attempt_id = attempt.attempt_id
    JOIN kurobara_core.outbox_messages AS message
      ON message.workspace_id = binding.workspace_id
      AND message.message_id = binding.outbox_message_id
    LEFT JOIN kurobara_core.step_leaf_effect_recovery_jobs AS recovery
      ON recovery.workspace_id = attempt.workspace_id
      AND recovery.attempt_id = attempt.attempt_id
    WHERE attempt.workspace_id = ${leaf.request.workspaceId}
      AND attempt.attempt_id = ${leaf.request.attemptId}
  `;
  const state = rows[0];
  if (state === undefined) {
    throw new Error("The durable leaf qualification state is missing.");
  }
  return state;
};

const readPreRecordState = async (
  fixture: DatabaseFixture,
  leaf: ClaimedLeaf
): Promise<PreRecordState> => {
  const rows = await fixture.inspection<readonly PreRecordState[]>`
    SELECT
      stored_run.run ->> 'state' AS run_state,
      stored_run.cost ->> 'reserved' AS run_reserved,
      stored_run.cost ->> 'spent' AS run_spent,
      step.state AS step_state,
      attempt.state AS attempt_state,
      reservation.state AS reservation_state,
      message.state AS leaf_outbox_state,
      message.attempts AS leaf_dispatch_attempts,
      message.claimed_until <= clock_timestamp() AS claim_expired,
      binding.state AS binding_state,
      binding.adapter_key,
      binding.effect_adapter_key,
      binding.external_execution_id,
      (SELECT count(*)::text
       FROM kurobara_core.step_events AS started_event
       WHERE started_event.workspace_id = attempt.workspace_id
         AND started_event.step_run_id = attempt.step_run_id
         AND started_event.event ->> 'eventType' = 'AttemptEffectStarted')
        AS effect_started_events,
      (SELECT count(*)::text
       FROM kurobara_core.step_events AS succeeded_event
       WHERE succeeded_event.workspace_id = attempt.workspace_id
         AND succeeded_event.step_run_id = attempt.step_run_id
         AND succeeded_event.event ->> 'eventType' = 'AttemptSucceeded')
        AS succeeded_events,
      (SELECT count(*)::text
       FROM kurobara_core.usage_ledger_entries AS usage
       WHERE usage.workspace_id = attempt.workspace_id
         AND usage.attempt_id = attempt.attempt_id) AS usage_entries,
      (SELECT usage.amount::text
       FROM kurobara_core.usage_ledger_entries AS usage
       WHERE usage.workspace_id = attempt.workspace_id
         AND usage.attempt_id = attempt.attempt_id) AS usage_amount
    FROM kurobara_core.step_attempts AS attempt
    JOIN kurobara_core.step_runs AS step
      ON step.workspace_id = attempt.workspace_id
      AND step.step_run_id = attempt.step_run_id
    JOIN kurobara_core.runs AS stored_run
      ON stored_run.workspace_id = step.workspace_id
      AND stored_run.run_id = step.run_id
    JOIN kurobara_core.cost_reservations AS reservation
      ON reservation.workspace_id = attempt.workspace_id
      AND reservation.reservation_id = attempt.reservation_id
    JOIN kurobara_core.step_leaf_execution_bindings AS binding
      ON binding.workspace_id = attempt.workspace_id
      AND binding.attempt_id = attempt.attempt_id
    JOIN kurobara_core.outbox_messages AS message
      ON message.workspace_id = binding.workspace_id
      AND message.message_id = binding.outbox_message_id
    WHERE attempt.workspace_id = ${leaf.request.workspaceId}
      AND attempt.attempt_id = ${leaf.request.attemptId}
  `;
  const state = rows[0];
  if (state === undefined) {
    throw new Error("The durable pre-record leaf state is missing.");
  }
  return state;
};

const settledLeafState = (state: LeafState): boolean =>
  (state.run_state === "running" || state.run_state === "completed") &&
  state.run_reserved === "0" &&
  state.run_spent === "0" &&
  state.step_state === "succeeded" &&
  state.attempt_state === "succeeded" &&
  state.reservation_state === "settled" &&
  state.leaf_outbox_state === "dispatched" &&
  state.binding_state === "started" &&
  state.adapter_key === "orchestration-hatchet" &&
  state.effect_adapter_key === "deterministic-local" &&
  state.external_execution_id !== null &&
  state.recovery_state === "completed" &&
  state.effect_started_events === "1" &&
  state.succeeded_events === "1" &&
  state.usage_entries === "1" &&
  state.usage_amount === "0";

const createLookup = (suffix: string) =>
  createHatchetOrchestration(
    {
      apiUrl: requiredEnvironment("HATCHET_CLIENT_API_URL"),
      hostPort: requiredEnvironment("HATCHET_CLIENT_HOST_PORT"),
      idempotencyTtlMilliseconds: 120_000,
      namespace: requiredEnvironment("HATCHET_CLIENT_NAMESPACE"),
      readinessTimeoutMilliseconds: 15_000,
      requestTimeoutMilliseconds: 7500,
      slots: 1,
      tlsStrategy: "none",
      token: requiredEnvironment("HATCHET_CLIENT_TOKEN"),
      workerName: `lookup-${suffix}`,
    },
    async () => undefined,
    async () => undefined
  );

const waitForHatchetLeaf = (
  request: StartLeafAttemptRequest,
  suffix: string
) => {
  const lookup = createLookup(suffix);
  return waitFor({
    accept: (result) => result.status === "found",
    description: "Hatchet to expose the exact leaf task",
    read: () => lookup.leafPort.findAttemptByStartKey(request),
  });
};

const waitForHatchetCompletion = (externalExecutionId: string) => {
  const client = HatchetClient.init(
    {
      api_url: requiredEnvironment("HATCHET_CLIENT_API_URL"),
      host_port: requiredEnvironment("HATCHET_CLIENT_HOST_PORT"),
      namespace: requiredEnvironment("HATCHET_CLIENT_NAMESPACE"),
      tls_config: { tls_strategy: "none" },
      token: requiredEnvironment("HATCHET_CLIENT_TOKEN"),
    },
    undefined,
    { timeout: 7500 }
  );
  return waitFor({
    accept: (status) => status === "COMPLETED",
    description: "Hatchet to complete the exact leaf task",
    read: async () => {
      try {
        return await client.runs.get_status(externalExecutionId);
      } catch {
        return "read-failed";
      }
    },
  });
};

const holdRecoveryTableLock = async (databaseUrl: string) => {
  const lockClient = postgres(databaseUrl, { max: 1 });
  let release = (): void => undefined;
  let acquired = (): void => undefined;
  let rejectAcquired = (_error: unknown): void => undefined;
  const acquiredPromise = new Promise<void>((resolve, reject) => {
    acquired = resolve;
    rejectAcquired = reject;
  });
  const releasePromise = new Promise<void>((resolve) => {
    release = resolve;
  });
  const transaction = lockClient
    .begin(async (transactionSql) => {
      const sql = transactionSql as unknown as postgres.Sql;
      await sql`
        LOCK TABLE kurobara_core.step_leaf_effect_recovery_jobs
        IN ACCESS EXCLUSIVE MODE
      `;
      acquired();
      await releasePromise;
    })
    .catch((error: unknown) => {
      rejectAcquired(error);
      throw error;
    });
  await acquiredPromise;
  return {
    release: async () => {
      release();
      await transaction;
      await lockClient.end({ timeout: 5 });
    },
  };
};

const waitForBlockedRecordStarted = (
  fixture: DatabaseFixture,
  worker: WorkerHandle
) =>
  waitFor({
    accept: (count) => count > 0,
    description: "recordStarted to block behind the recovery-table barrier",
    read: async () => {
      const rows = await fixture.inspection<readonly { count: string }[]>`
        SELECT count(*)::text AS count
        FROM pg_stat_activity
        WHERE datname = current_database()
          AND application_name = ${worker.applicationName}
          AND wait_event_type = 'Lock'
          AND position('WITH started_binding AS' IN query) > 0
      `;
      return Number(rows[0]?.count ?? "0");
    },
    worker,
  });

const terminateCrashedWorkerBackends = async (
  fixture: DatabaseFixture,
  worker: WorkerHandle
): Promise<number> => {
  const rows = await fixture.inspection<readonly { terminated: boolean }[]>`
    SELECT pg_terminate_backend(pid) AS terminated
    FROM pg_stat_activity
    WHERE datname = current_database()
      AND application_name = ${worker.applicationName}
      AND pid <> pg_backend_pid()
  `;
  return rows.filter((row) => row.terminated).length;
};

const waitForBlockedWorkerBackendsToClose = (
  fixture: DatabaseFixture,
  worker: WorkerHandle
) =>
  waitFor({
    accept: (count) => count === 0,
    description: "the crashed worker lock waiters to close",
    read: async () => {
      const rows = await fixture.inspection<readonly { count: string }[]>`
        SELECT count(*)::text AS count
        FROM pg_stat_activity
        WHERE datname = current_database()
          AND application_name = ${worker.applicationName}
      `;
      return Number(rows[0]?.count ?? "0");
    },
  });

test("executes and settles a real leaf through the complete worker process", {
  timeout: TEST_TIMEOUT_MILLISECONDS,
}, async () => {
  const suffix = randomUUID();
  const fixture = await createDatabaseFixture(suffix);
  let worker: WorkerHandle | undefined;
  try {
    const run = await createRunnableRun(fixture, suffix);
    worker = startWorker(fixture.databaseUrl, `happy-${suffix}`);
    await waitForRun(fixture, run, worker);
    const leaf = await waitForAutomaticLeaf({ fixture, run, worker });
    const state = await waitFor({
      accept: settledLeafState,
      description: "the complete worker to settle the leaf and reap recovery",
      read: () => readLeafState(fixture, leaf),
    });
    assert.equal(state.leaf_dispatch_attempts, 1);
    assert.equal(state.recovery_attempts, 0);
    assert.ok(state.external_execution_id);
    const found = await waitForHatchetLeaf(leaf.request, suffix);
    assert.equal(found.status, "found");
    if (found.status === "found") {
      assert.equal(found.externalExecutionId, state.external_execution_id);
      await waitForHatchetCompletion(found.externalExecutionId);
    }
  } finally {
    if (worker !== undefined) {
      await stopWorker(worker);
    }
    await closeDatabaseFixture(fixture);
  }
});

test("completes a real fan-out and fan-in DAG from a validated local output", {
  timeout: TEST_TIMEOUT_MILLISECONDS,
}, async () => {
  const suffix = randomUUID();
  const fixture = await createDatabaseFixture(suffix);
  let worker: WorkerHandle | undefined;
  try {
    const run = await createRunnableRun(fixture, suffix, [
      { dependsOn: [], key: "root" },
      { dependsOn: ["root"], key: "left" },
      { dependsOn: ["root"], key: "right" },
      { dependsOn: ["left", "right"], key: "join" },
    ]);
    worker = startWorker(fixture.databaseUrl, `dag-${suffix}`);
    await waitForRun(fixture, run, worker);

    const root = await waitForAutomaticLeaf({
      fixture,
      nodeKey: "root",
      run,
      worker,
    });
    const rootState = await waitFor({
      accept: settledLeafState,
      description: "the root leaf to settle",
      read: () => readLeafState(fixture, root),
      worker,
    });
    assert.ok(rootState.external_execution_id);
    await waitForHatchetCompletion(rootState.external_execution_id);

    const left = await waitForAutomaticLeaf({
      fixture,
      nodeKey: "left",
      run,
      worker,
    });
    const leftState = await waitFor({
      accept: settledLeafState,
      description: "the left fan-out leaf to settle",
      read: () => readLeafState(fixture, left),
      worker,
    });
    assert.ok(leftState.external_execution_id);
    await waitForHatchetCompletion(leftState.external_execution_id);
    const right = await waitForAutomaticLeaf({
      fixture,
      nodeKey: "right",
      run,
      worker,
    });
    const rightState = await waitFor({
      accept: settledLeafState,
      description: "the right fan-out leaf to settle",
      read: () => readLeafState(fixture, right),
      worker,
    });
    assert.ok(rightState.external_execution_id);
    await waitForHatchetCompletion(rightState.external_execution_id);

    const join = await waitForAutomaticLeaf({
      fixture,
      nodeKey: "join",
      run,
      worker,
    });
    const joinState = await waitFor({
      accept: settledLeafState,
      description: "the fan-in leaf to settle",
      read: () => readLeafState(fixture, join),
      worker,
    });
    assert.ok(joinState.external_execution_id);
    await waitForHatchetCompletion(joinState.external_execution_id);
    await waitForDagSuccess(fixture, run, worker);

    assert.deepEqual(
      [...(await readDagNodeStates(fixture, run))],
      [
        { node_key: "join", state: "succeeded" },
        { node_key: "left", state: "succeeded" },
        { node_key: "right", state: "succeeded" },
        { node_key: "root", state: "succeeded" },
      ]
    );
    const causalRows = await fixture.inspection<
      readonly {
        events: readonly string[];
        node_key: string;
        ready_at: string;
        succeeded_at: string;
      }[]
    >`
      SELECT
        step.node_key,
        jsonb_agg(event.event ->> 'eventType' ORDER BY event.sequence) AS events,
        max((event.event ->> 'occurredAt')::bigint)
          FILTER (WHERE event.event ->> 'eventType' = 'StepReady')::text
          AS ready_at,
        max((event.event ->> 'occurredAt')::bigint)
          FILTER (WHERE event.event ->> 'eventType' = 'AttemptSucceeded')::text
          AS succeeded_at
      FROM kurobara_core.step_runs AS step
      JOIN kurobara_core.step_events AS event
        ON event.workspace_id = step.workspace_id
        AND event.step_run_id = step.step_run_id
      WHERE step.workspace_id = ${run.workspace}
        AND step.run_id = ${run.run}
      GROUP BY step.node_key
      ORDER BY step.node_key
    `;
    const expectedLifecycle = [
      "StepReady",
      "RoutingDecisionRecorded",
      "AttemptCreated",
      "AttemptClaimed",
      "AttemptEffectStarted",
      "AttemptSucceeded",
    ];
    assert.equal(causalRows.length, 4);
    for (const row of causalRows) {
      assert.deepEqual(row.events, expectedLifecycle);
    }
    const causalByNode = new Map(
      causalRows.map((row) => [row.node_key, row] as const)
    );
    const rootCausal = causalByNode.get("root");
    const leftCausal = causalByNode.get("left");
    const rightCausal = causalByNode.get("right");
    const joinCausal = causalByNode.get("join");
    assert.ok(rootCausal && leftCausal && rightCausal && joinCausal);
    assert.ok(Number(leftCausal.ready_at) >= Number(rootCausal.succeeded_at));
    assert.ok(Number(rightCausal.ready_at) >= Number(rootCausal.succeeded_at));
    assert.ok(Number(joinCausal.ready_at) >= Number(leftCausal.succeeded_at));
    assert.ok(Number(joinCausal.ready_at) >= Number(rightCausal.succeeded_at));
    const finalRows = await fixture.inspection<
      readonly {
        attempts: string;
        bindings: string;
        blocked_reason: string | null;
        complete_commands: string;
        distinct_external_executions: string;
        output_artifacts: string;
        reservations: string;
        routing_decisions: string;
        routing_events: string;
        routing_jobs_completed: string;
        result_completeness: string;
        result_manifests: string;
        run_completed_events: string;
        run_result_recorded_events: string;
        run_reserved: string;
        run_spent: string;
        run_state: string;
        schedule_pending: boolean;
        schedule_evaluated: boolean;
        schedule_last_outcome: string | null;
        usage_amount: string;
        usage_entries: string;
      }[]
    >`
      SELECT
        stored_run.run ->> 'state' AS run_state,
        stored_run.run ->> 'resultCompleteness' AS result_completeness,
        stored_run.cost ->> 'reserved' AS run_reserved,
        stored_run.cost ->> 'spent' AS run_spent,
        schedule.pending AS schedule_pending,
        schedule.last_outcome AS schedule_last_outcome,
        schedule.blocked_reason,
        schedule.evaluated_at IS NOT NULL AS schedule_evaluated,
        (SELECT count(*)::text
         FROM kurobara_core.run_result_manifests AS manifest
         WHERE manifest.workspace_id = stored_run.workspace_id
           AND manifest.run_id = stored_run.run_id) AS result_manifests,
        (SELECT count(*)::text
         FROM kurobara_core.run_events AS completed_event
         WHERE completed_event.workspace_id = stored_run.workspace_id
           AND completed_event.run_id = stored_run.run_id
           AND completed_event.event ->> 'eventType' = 'RunCompleted')
          AS run_completed_events,
        (SELECT count(*)::text
         FROM kurobara_core.run_events AS result_event
         WHERE result_event.workspace_id = stored_run.workspace_id
           AND result_event.run_id = stored_run.run_id
           AND result_event.event ->> 'eventType' =
             'RunResultManifestRecorded') AS run_result_recorded_events,
        (SELECT count(*)::text
         FROM kurobara_core.run_command_journal AS command
         WHERE command.workspace_id = stored_run.workspace_id
           AND command.run_id = stored_run.run_id
           AND command.command_type = 'CompleteRun') AS complete_commands,
        (SELECT count(*)::text
         FROM kurobara_core.run_output_artifacts AS artifact
         WHERE artifact.workspace_id = stored_run.workspace_id
           AND artifact.run_id = stored_run.run_id) AS output_artifacts,
        (SELECT count(*)::text
         FROM kurobara_core.step_attempts AS attempt
         JOIN kurobara_core.step_runs AS step
           ON step.workspace_id = attempt.workspace_id
           AND step.step_run_id = attempt.step_run_id
         WHERE step.workspace_id = stored_run.workspace_id
           AND step.run_id = stored_run.run_id) AS attempts,
        (SELECT count(*)::text
         FROM kurobara_core.cost_reservations AS reservation
         WHERE reservation.workspace_id = stored_run.workspace_id
           AND reservation.run_id = stored_run.run_id
           AND reservation.state = 'settled') AS reservations,
        (SELECT count(*)::text
         FROM kurobara_core.routing_decisions AS decision
         WHERE decision.workspace_id = stored_run.workspace_id
           AND decision.run_id = stored_run.run_id
           AND decision.effect_adapter_key = 'deterministic-local')
          AS routing_decisions,
        (SELECT count(*)::text
         FROM kurobara_core.step_events AS routing_event
         JOIN kurobara_core.step_runs AS routed_step
           ON routed_step.workspace_id = routing_event.workspace_id
           AND routed_step.step_run_id = routing_event.step_run_id
         WHERE routed_step.workspace_id = stored_run.workspace_id
           AND routed_step.run_id = stored_run.run_id
           AND routing_event.event ->> 'eventType' =
             'RoutingDecisionRecorded') AS routing_events,
        (SELECT count(*)::text
         FROM kurobara_core.step_routing_jobs AS routing_job
         WHERE routing_job.workspace_id = stored_run.workspace_id
           AND routing_job.run_id = stored_run.run_id
           AND NOT routing_job.pending
           AND routing_job.processed_at IS NOT NULL)
          AS routing_jobs_completed,
        (SELECT count(*)::text
         FROM kurobara_core.step_leaf_execution_bindings AS binding
         WHERE binding.workspace_id = stored_run.workspace_id
           AND binding.run_id = stored_run.run_id
           AND binding.state = 'started') AS bindings,
        (SELECT count(DISTINCT binding.external_execution_id)::text
         FROM kurobara_core.step_leaf_execution_bindings AS binding
         WHERE binding.workspace_id = stored_run.workspace_id
           AND binding.run_id = stored_run.run_id
           AND binding.state = 'started') AS distinct_external_executions,
        (SELECT count(*)::text
         FROM kurobara_core.usage_ledger_entries AS usage
         WHERE usage.workspace_id = stored_run.workspace_id
           AND usage.run_id = stored_run.run_id) AS usage_entries,
        (SELECT coalesce(sum(usage.amount), 0)::text
         FROM kurobara_core.usage_ledger_entries AS usage
         WHERE usage.workspace_id = stored_run.workspace_id
           AND usage.run_id = stored_run.run_id) AS usage_amount
      FROM kurobara_core.runs AS stored_run
      JOIN kurobara_core.run_dag_schedule_jobs AS schedule
        ON schedule.workspace_id = stored_run.workspace_id
        AND schedule.run_id = stored_run.run_id
      WHERE stored_run.workspace_id = ${run.workspace}
        AND stored_run.run_id = ${run.run}
    `;
    assert.deepEqual(finalRows[0], {
      attempts: "4",
      bindings: "4",
      blocked_reason: null,
      complete_commands: "1",
      distinct_external_executions: "4",
      output_artifacts: "1",
      reservations: "4",
      result_completeness: "complete",
      result_manifests: "1",
      routing_decisions: "4",
      routing_events: "4",
      routing_jobs_completed: "4",
      run_completed_events: "1",
      run_reserved: "0",
      run_result_recorded_events: "1",
      run_spent: "0",
      run_state: "completed",
      schedule_evaluated: true,
      schedule_last_outcome: "success-finalized",
      schedule_pending: false,
      usage_amount: "0",
      usage_entries: "4",
    });

    const proofRows = await fixture.inspection<
      readonly {
        artifact_id: string;
        attempt_id: string;
        content_hash: string;
        manifest: {
          output: {
            artifact: { artifactId: string; contentHash: string };
            contract: typeof deterministicOutputContract;
            status: string;
            validatorVersion: string;
          };
        };
        manifest_hash: string;
        node_key: string;
        operation_key: string;
        normalized_payload: {
          adapter: string;
          attempt_id: string;
          operation_key: string;
          run_id: string;
          status: string;
          step_run_id: string;
        };
        validator_version: string;
        result_manifest_id: string;
        step_run_id: string;
      }[]
    >`
      SELECT
        artifact.artifact_id,
        artifact.attempt_id,
        artifact.content_hash,
        artifact.normalized_payload,
        artifact.operation_key,
        artifact.step_run_id,
        artifact.validator_version,
        manifest.manifest,
        manifest.manifest_hash,
        manifest.result_manifest_id,
        step.node_key
      FROM kurobara_core.run_result_manifests AS manifest
      JOIN kurobara_core.run_output_artifacts AS artifact
        ON artifact.workspace_id = manifest.workspace_id
        AND artifact.run_id = manifest.run_id
        AND artifact.artifact_id = manifest.output_artifact_id
        AND artifact.content_hash = manifest.output_content_hash
      JOIN kurobara_core.step_runs AS step
        ON step.workspace_id = artifact.workspace_id
        AND step.step_run_id = artifact.step_run_id
      WHERE manifest.workspace_id = ${run.workspace}
        AND manifest.run_id = ${run.run}
    `;
    const proof = proofRows[0];
    assert.ok(proof);
    assert.equal(proofRows.length, 1);
    assert.equal(proof.node_key, "join");
    assert.equal(proof.manifest.output.status, "accepted");
    assert.deepEqual(
      proof.manifest.output.contract,
      deterministicOutputContract
    );
    assert.equal(
      proof.manifest.output.validatorVersion,
      JSON_SCHEMA_OUTPUT_VALIDATOR_VERSION
    );
    assert.equal(proof.validator_version, JSON_SCHEMA_OUTPUT_VALIDATOR_VERSION);
    assert.deepEqual(proof.manifest.output.artifact, {
      artifactId: proof.artifact_id,
      contentHash: proof.content_hash,
    });
    assert.deepEqual(proof.normalized_payload, {
      adapter: "deterministic-local",
      attempt_id: proof.attempt_id,
      operation_key: proof.operation_key,
      run_id: run.run,
      status: "succeeded",
      step_run_id: proof.step_run_id,
    });

    await stopWorker(worker);
    worker = undefined;
    const scope = { workspaceId: run.workspace } as const;
    await fixture.runtime.runExecution.transaction(scope, (unitOfWork) =>
      unitOfWork.dagSchedule.request(scope, run.run)
    );
    worker = startWorker(fixture.databaseUrl, `dag-restart-${suffix}`);
    await waitForDagStaleTerminal(fixture, run, worker);

    const afterRestart = await fixture.inspection<
      readonly {
        attempts: string;
        blocked_reason: string | null;
        complete_commands: string;
        distinct_external_executions: string;
        output_artifacts: string;
        reservations: string;
        result_manifest_id: string | null;
        manifest_hash: string | null;
        result_manifests: string;
        result_completeness: string;
        routing_decisions: string;
        run_completed_events: string;
        run_result_recorded_events: string;
        run_state: string;
        schedule_last_outcome: string | null;
        usage_entries: string;
      }[]
    >`
      SELECT
        stored_run.run ->> 'state' AS run_state,
        stored_run.run ->> 'resultCompleteness' AS result_completeness,
        schedule.last_outcome AS schedule_last_outcome,
        schedule.blocked_reason,
        (SELECT count(*)::text
         FROM kurobara_core.step_attempts AS attempt
         JOIN kurobara_core.step_runs AS step
           ON step.workspace_id = attempt.workspace_id
           AND step.step_run_id = attempt.step_run_id
         WHERE step.workspace_id = stored_run.workspace_id
           AND step.run_id = stored_run.run_id) AS attempts,
        (SELECT count(DISTINCT binding.external_execution_id)::text
         FROM kurobara_core.step_leaf_execution_bindings AS binding
         WHERE binding.workspace_id = stored_run.workspace_id
           AND binding.run_id = stored_run.run_id
           AND binding.state = 'started') AS distinct_external_executions,
        (SELECT count(*)::text
         FROM kurobara_core.usage_ledger_entries AS usage
         WHERE usage.workspace_id = stored_run.workspace_id
           AND usage.run_id = stored_run.run_id) AS usage_entries,
        (SELECT count(*)::text
         FROM kurobara_core.cost_reservations AS reservation
         WHERE reservation.workspace_id = stored_run.workspace_id
           AND reservation.run_id = stored_run.run_id
           AND reservation.state = 'settled') AS reservations,
        (SELECT count(*)::text
         FROM kurobara_core.routing_decisions AS decision
         WHERE decision.workspace_id = stored_run.workspace_id
           AND decision.run_id = stored_run.run_id) AS routing_decisions,
        (SELECT count(*)::text
         FROM kurobara_core.run_result_manifests AS manifest
         WHERE manifest.workspace_id = stored_run.workspace_id
           AND manifest.run_id = stored_run.run_id) AS result_manifests,
        (SELECT manifest.result_manifest_id
         FROM kurobara_core.run_result_manifests AS manifest
         WHERE manifest.workspace_id = stored_run.workspace_id
           AND manifest.run_id = stored_run.run_id) AS result_manifest_id,
        (SELECT manifest.manifest_hash
         FROM kurobara_core.run_result_manifests AS manifest
         WHERE manifest.workspace_id = stored_run.workspace_id
           AND manifest.run_id = stored_run.run_id) AS manifest_hash,
        (SELECT count(*)::text
         FROM kurobara_core.run_output_artifacts AS artifact
         WHERE artifact.workspace_id = stored_run.workspace_id
           AND artifact.run_id = stored_run.run_id) AS output_artifacts,
        (SELECT count(*)::text
         FROM kurobara_core.run_command_journal AS command
         WHERE command.workspace_id = stored_run.workspace_id
           AND command.run_id = stored_run.run_id
           AND command.command_type = 'CompleteRun') AS complete_commands,
        (SELECT count(*)::text
         FROM kurobara_core.run_events AS completed_event
         WHERE completed_event.workspace_id = stored_run.workspace_id
           AND completed_event.run_id = stored_run.run_id
           AND completed_event.event ->> 'eventType' = 'RunCompleted')
          AS run_completed_events,
        (SELECT count(*)::text
         FROM kurobara_core.run_events AS result_event
         WHERE result_event.workspace_id = stored_run.workspace_id
           AND result_event.run_id = stored_run.run_id
           AND result_event.event ->> 'eventType' =
             'RunResultManifestRecorded') AS run_result_recorded_events
      FROM kurobara_core.runs AS stored_run
      JOIN kurobara_core.run_dag_schedule_jobs AS schedule
        ON schedule.workspace_id = stored_run.workspace_id
        AND schedule.run_id = stored_run.run_id
      WHERE stored_run.workspace_id = ${run.workspace}
        AND stored_run.run_id = ${run.run}
    `;
    assert.deepEqual(afterRestart[0], {
      attempts: "4",
      blocked_reason: null,
      complete_commands: "1",
      distinct_external_executions: "4",
      manifest_hash: proof.manifest_hash,
      output_artifacts: "1",
      reservations: "4",
      result_completeness: "complete",
      result_manifest_id: proof.result_manifest_id,
      result_manifests: "1",
      routing_decisions: "4",
      run_completed_events: "1",
      run_result_recorded_events: "1",
      run_state: "completed",
      schedule_last_outcome: "stale-terminal",
      usage_entries: "4",
    });
  } finally {
    if (worker !== undefined) {
      await stopWorker(worker);
    }
    await closeDatabaseFixture(fixture);
  }
});

test("adopts the same completed Hatchet leaf after SIGKILL before recordStarted", {
  timeout: TEST_TIMEOUT_MILLISECONDS,
}, async () => {
  const suffix = randomUUID();
  const fixture = await createDatabaseFixture(suffix);
  let firstWorker: WorkerHandle | undefined;
  let recoveryLock:
    | Awaited<ReturnType<typeof holdRecoveryTableLock>>
    | undefined;
  let restartedWorker: WorkerHandle | undefined;
  try {
    const run = await createRunnableRun(fixture, suffix);
    recoveryLock = await holdRecoveryTableLock(fixture.databaseUrl);
    firstWorker = startWorker(fixture.databaseUrl, `before-record-${suffix}`);
    await waitForRun(fixture, run, firstWorker);
    const leaf = await waitForAutomaticLeaf({
      fixture,
      run,
      worker: firstWorker,
    });
    const preCrash = await waitFor({
      accept: (state) =>
        state.attempt_state === "succeeded" &&
        state.reservation_state === "settled" &&
        state.binding_state === "starting" &&
        state.leaf_outbox_state === "claimed" &&
        state.external_execution_id === null &&
        state.usage_entries === "1",
      description: "the callback to settle before recordStarted commits",
      read: () => readPreRecordState(fixture, leaf),
      worker: firstWorker,
    });
    assert.equal(preCrash.leaf_dispatch_attempts, 1);
    assert.equal(preCrash.effect_started_events, "1");
    assert.equal(preCrash.succeeded_events, "1");
    const submitted = await waitForHatchetLeaf(leaf.request, suffix);
    assert.equal(submitted.status, "found");
    if (submitted.status !== "found") {
      throw new Error("The exact Hatchet leaf task was not found.");
    }
    await waitForHatchetCompletion(submitted.externalExecutionId);
    await waitForBlockedRecordStarted(fixture, firstWorker);
    await waitForDagSuccess(fixture, run, firstWorker);

    const crashedWorker = firstWorker;
    const crashed = await stopWorker(crashedWorker, "SIGKILL");
    assert.equal(crashed[0], null);
    assert.equal(crashed[1], "SIGKILL");
    assert.ok(
      (await terminateCrashedWorkerBackends(fixture, crashedWorker)) > 0,
      "The crash barrier must terminate at least one blocked worker backend."
    );
    await waitForBlockedWorkerBackendsToClose(fixture, crashedWorker);
    firstWorker = undefined;
    await recoveryLock.release();
    recoveryLock = undefined;

    await waitFor({
      accept: (state) => state.claim_expired,
      description: "the interrupted leaf outbox claim to expire",
      read: () => readPreRecordState(fixture, leaf),
    });
    restartedWorker = startWorker(
      fixture.databaseUrl,
      `after-record-${suffix}`
    );
    const recovered = await waitFor({
      accept: settledLeafState,
      description: "the restarted worker to adopt and finalize the leaf",
      read: () => readLeafState(fixture, leaf),
      worker: restartedWorker,
    });
    assert.equal(recovered.leaf_dispatch_attempts, 2);
    assert.equal(recovered.recovery_attempts, 0);
    assert.equal(
      recovered.external_execution_id,
      submitted.externalExecutionId
    );
    const afterRestart = await waitForHatchetLeaf(
      leaf.request,
      `after-${suffix}`
    );
    assert.equal(afterRestart.status, "found");
    if (afterRestart.status === "found") {
      assert.equal(
        afterRestart.externalExecutionId,
        submitted.externalExecutionId
      );
    }
    const stableBundle = await fixture.inspection<
      readonly {
        complete_commands: string;
        output_artifacts: string;
        result_manifests: string;
        run_completed_events: string;
        run_state: string;
      }[]
    >`
      SELECT
        stored_run.run ->> 'state' AS run_state,
        (SELECT count(*)::text
         FROM kurobara_core.run_output_artifacts AS artifact
         WHERE artifact.workspace_id = stored_run.workspace_id
           AND artifact.run_id = stored_run.run_id) AS output_artifacts,
        (SELECT count(*)::text
         FROM kurobara_core.run_result_manifests AS manifest
         WHERE manifest.workspace_id = stored_run.workspace_id
           AND manifest.run_id = stored_run.run_id) AS result_manifests,
        (SELECT count(*)::text
         FROM kurobara_core.run_command_journal AS command
         WHERE command.workspace_id = stored_run.workspace_id
           AND command.run_id = stored_run.run_id
           AND command.command_type = 'CompleteRun') AS complete_commands,
        (SELECT count(*)::text
         FROM kurobara_core.run_events AS completed_event
         WHERE completed_event.workspace_id = stored_run.workspace_id
           AND completed_event.run_id = stored_run.run_id
           AND completed_event.event ->> 'eventType' = 'RunCompleted')
          AS run_completed_events
      FROM kurobara_core.runs AS stored_run
      WHERE stored_run.workspace_id = ${run.workspace}
        AND stored_run.run_id = ${run.run}
    `;
    assert.deepEqual(stableBundle[0], {
      complete_commands: "1",
      output_artifacts: "1",
      result_manifests: "1",
      run_completed_events: "1",
      run_state: "completed",
    });
  } finally {
    if (firstWorker !== undefined) {
      await stopWorker(firstWorker, "SIGKILL").catch(() => undefined);
    }
    if (restartedWorker !== undefined) {
      await stopWorker(restartedWorker).catch(() => undefined);
    }
    if (recoveryLock !== undefined) {
      await recoveryLock.release().catch(() => undefined);
    }
    await closeDatabaseFixture(fixture);
  }
});
