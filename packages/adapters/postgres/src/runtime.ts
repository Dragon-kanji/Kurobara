import { randomUUID } from "node:crypto";

import {
  type Artifact,
  type Attempt,
  amountsEqual,
  attemptId,
  type CostReservation,
  eventId,
  instant,
  isAmount,
  outboxMessageId,
  type ResultManifest,
  type RoutingDecision,
  type RunLifecycleEvent,
  type RunPlan,
  runId,
  type StepLifecycleEvent,
  type StepRun,
  stepRunId,
  type UsageEntry,
  workspaceId,
} from "@kurobara/kernel";
import type {
  ApiKeyAuthenticationPort,
  BootstrapPlanningInput,
  ContactDatasetExportPrivacySourcePort,
  ContactIdentitySourcePort,
  ContactPrivacyPersistencePort,
  CostReservationRelease,
  CostReservationReleaseResult,
  CostReservationResult,
  CostReservationSettlementResult,
  DagCellResultFinalization,
  DagSchedulingContext,
  DagSchedulingJobOutcome,
  DagSchedulingPersistencePort,
  DatasetGenerationCancellationPersistencePort,
  DatasetGenerationFirstPagePersistencePort,
  DatasetGenerationPersistencePort,
  DatasetGenerationPlanningPersistencePort,
  DatasetGenerationWorkPort,
  DatasetPersistencePort,
  DatasetRecordPageQueryPort,
  ExportDeliveryPersistencePort,
  LeafEffectRecoveryClaim,
  LeafEffectRecoveryPort,
  LeafOutboxClaim,
  LeafOutboxDispatchPort,
  LeafOutboxMessage,
  NormalizedJsonValue,
  OrchestrationReconciliationClaim,
  OrchestrationReconciliationPort,
  OutboxClaim,
  OutboxDispatchPort,
  OutboxMessage,
  PersistencePort,
  PlanningBundleApplyResult,
  PlanningPersistencePort,
  RecipeApplicationWatchQueryPort,
  RecipeApplyPersistencePort,
  RecipeCellRunCreationPersistencePort,
  RecipePersistencePort,
  RunCostSnapshot,
  RunCreationUnitOfWork,
  RunExecutionPersistencePort,
  RunExecutionUnitOfWork,
  RunQueryPort,
  SelectedContactEnrichmentSourcePort,
  StepExecutionContext,
  StepExecutionPersistencePort,
  StepExecutionQueryPort,
  StepExecutionUnitOfWork,
  StepRoutingContext,
  StepRoutingPersistencePort,
  StepRoutingUnitOfWork,
  ValidatedRunInput,
  WorkspaceScope,
} from "@kurobara/ports";
import postgres from "postgres";

import {
  type BootstrapApiKeyInput,
  type BootstrappedApiKey,
  bootstrapPostgresApiKey,
  createPostgresApiKeyAuthentication,
} from "./api-key-authentication.ts";
import {
  normalizedJsonEvidence,
  parseArtifact,
  parseContractRef,
  parseNormalizedJsonValue,
  serializeCanonicalJson,
} from "./artifact-payload.ts";
import { createPostgresContactPrivacyPersistence } from "./contact-privacy.ts";
import {
  createPostgresContactDatasetExportPrivacySource,
  createPostgresContactIdentitySource,
  createPostgresSelectedContactEnrichmentSource,
} from "./contact-source.ts";
import { createPostgresDatasetPersistence } from "./dataset.ts";
import {
  createPostgresDatasetGenerationCancellationPersistence,
  createPostgresDatasetGenerationFirstPagePersistence,
  createPostgresDatasetGenerationParentEffects,
} from "./dataset-generation-page.ts";
import { createPostgresDatasetGenerationPersistence } from "./dataset-generation-persistence.ts";
import { createPostgresDatasetGenerationPlanningPersistence } from "./dataset-generation-planning.ts";
import { createPostgresDatasetGenerationWork } from "./dataset-generation-work.ts";
import { createPostgresDatasetRecordPageQuery } from "./dataset-record-query.ts";
import {
  ImmutableRecordConflictError,
  OrchestrationBindingConflictError,
  OutboxLeaseConflictError,
  PostgresAdapterError,
  RunAggregateConflictError,
} from "./errors.ts";
import { createPostgresExportDeliveryPersistence } from "./export-delivery.ts";
import { toJsonValue } from "./json.ts";
import { parseLeafOutboxMessageIdentity } from "./leaf-outbox-payload.ts";
import {
  applyPostgresMigrations,
  verifyPostgresMigrations,
} from "./migrations.ts";
import {
  parseRun,
  parseRunCommandReplayProof,
  parseRunCreationRecord,
  parseRunPlan,
  parseRunQueued,
} from "./payload.ts";
import {
  bootstrapPostgresPlanning,
  createPostgresPlanningUnitOfWork,
  makePostgresPlanning,
  type PlanningStateReadback,
  readPostgresPlanningState,
  verifyPostgresPlanningBundle,
} from "./planning.ts";
import {
  createPostgresRecipeApplicationWatchQueries,
  createPostgresRecipeApplyPersistence,
  createPostgresRecipeCellRunCreationPersistence,
  createPostgresRecipePersistence,
  createPostgresRecipeUnitOfWork,
  loadPostgresRecipeCellConvergenceContext,
} from "./recipe.ts";
import { parseResultManifest } from "./result-manifest-payload.ts";
import {
  parseRunPlanInputRow,
  type RunPlanInputRow,
} from "./run-input-payload.ts";
import {
  parseAttempt,
  parseCostReservation,
  parseRoutingDecision,
  parseStepCommandReplayProof,
  parseStepRun,
  parseUsageEntry,
} from "./step-payload.ts";

type PlanRow = Readonly<{
  consumed_by: unknown;
  plan: unknown;
}>;

type RunRow = Readonly<{
  idempotency_key: string;
  intention_hash: string;
  run: unknown;
}>;

type RunSnapshotRow = Readonly<{
  cost: unknown;
  run: unknown;
}>;

type RunExecutionRow = Readonly<{ run: unknown }>;
type RunCommandProofRow = Readonly<{ proof: unknown }>;
type StepContextRow = Readonly<{
  plan: unknown;
  run: unknown;
}>;
type StepRunRow = Readonly<{ step_run: unknown }>;
type DagSchedulingRunIdentityRow = Readonly<{
  run: unknown;
  run_id: string;
  run_plan_id: string;
  workspace_id: string;
}>;
type DagSchedulingCandidateRow = DagSchedulingRunIdentityRow &
  Readonly<{ cost: unknown }>;
type DagSchedulingReservationRow = Readonly<{
  amount: string;
  attempt_id: string;
  operation_key: string;
  reservation: unknown;
  reservation_id: string;
  run_id: string;
  state: string;
  step_run_id: string;
  unit: string;
  workspace_id: string;
}>;
type DagSchedulingUsageRow = Readonly<{
  amount: string;
  attempt_id: string;
  entry: unknown;
  operation_key: string;
  reservation_id: string;
  run_id: string;
  unit: string;
  usage_entry_id: string;
  workspace_id: string;
}>;
type OutputArtifactRow = Readonly<{
  artifact: unknown;
  artifact_id: string;
  attempt_id: string;
  classification: string;
  content_hash: string;
  contract: unknown;
  finalized_at: Date;
  kind: string;
  media_type: string;
  normalized_payload: unknown;
  operation_key: string;
  retention_policy: string;
  run_id: string;
  size_bytes: string;
  state: string;
  step_run_id: string;
  validated_at: Date;
  validator_version: string;
  workspace_id: string;
}>;
type ResultManifestRow = Readonly<{
  conclusion: string;
  cost_spent: string;
  cost_unit: string;
  created_at: Date;
  manifest: unknown;
  manifest_hash: string;
  plan_hash: string;
  result_completeness: string;
  result_manifest_id: string;
  run_id: string;
  run_plan_id: string;
  source_run_aggregate_version: number;
  workspace_id: string;
}>;
type RunConvergenceEventRow = Readonly<{
  event: unknown;
  event_id: string;
  sequence: number;
}>;
type RunConvergenceCommandRow = Readonly<{
  actor_id: string;
  command_hash: string;
  command_idempotency_key: string;
  command_type: string;
  correlation_id: string;
  proof: unknown;
}>;
type DagSchedulingStepRow = Readonly<{
  aggregate_version: number;
  event_sequence: number;
  node_key: string;
  state: string;
  step_run: unknown;
  step_run_id: string;
}>;
type DagSchedulingAttemptRow = Readonly<{
  attempt: unknown;
  attempt_id: string;
  attempt_number: number;
  created_at: Date;
  effect_adapter_key: string;
  operation_key: string;
  reservation_id: string;
  route_key: string;
  route_snapshot_hash: string;
  routing_decision_id: string;
  state: string;
  step_run_id: string;
  workspace_id: string;
}>;
type StepRoutingCandidateRow = Readonly<{
  run: unknown;
  run_id: string;
  run_plan_id: string;
  step_run_id: string;
  workspace_id: string;
}>;
type StepRoutingStepRow = Readonly<{
  aggregate_version: number;
  event_sequence: number;
  node_key: string;
  run_id: string;
  state: string;
  step_run: unknown;
  step_run_id: string;
  workspace_id: string;
}>;
type StepCommandProofRow = Readonly<{ proof: unknown }>;
type CostReservationRow = Readonly<{ reservation: unknown }>;
type UsageEntryRow = Readonly<{ entry: unknown }>;
const RECONCILIATION_ATTEMPTS_EXHAUSTED =
  "orchestration-reconciliation-attempts-exhausted";

const parseRunCostSnapshot = (value: unknown): RunCostSnapshot => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new PostgresAdapterError(
      "database-payload-invalid",
      "The stored run cost snapshot is not an object."
    );
  }
  const candidate = value as Readonly<Record<string, unknown>>;
  if (
    typeof candidate.unit !== "string" ||
    candidate.unit.length === 0 ||
    typeof candidate.spent !== "number" ||
    !Number.isFinite(candidate.spent) ||
    candidate.spent < 0 ||
    typeof candidate.reserved !== "number" ||
    !Number.isFinite(candidate.reserved) ||
    candidate.reserved < 0
  ) {
    throw new PostgresAdapterError(
      "database-payload-invalid",
      "The stored run cost snapshot is malformed."
    );
  }
  return {
    reserved: candidate.reserved,
    spent: candidate.spent,
    unit: candidate.unit,
  };
};

type OutboxRow = Readonly<{
  adapter_key: string | null;
  aggregate_id: string;
  aggregate_version: number;
  attempt: number;
  available_at_ms: string;
  claimed_by: string;
  claim_token: string;
  destination: string;
  event: unknown;
  event_id: string;
  message_id: string;
  orchestration_run_id: string | null;
  orchestration_state: string;
  start_key: string;
  workspace_id: string;
}>;

type OrchestrationReconciliationRow = Readonly<{
  adapter_key: string;
  event: unknown;
  event_id: string;
  message_id: string;
  reconciliation_claim_token: string;
  reconciliation_claimed_by: string;
  run_id: string;
  start_key: string;
  workspace_id: string;
}>;

type LeafOutboxRow = Readonly<{
  adapter_key: string | null;
  aggregate_version: number;
  attempt: number;
  attempt_effect_adapter_key: string;
  attempt_id: string;
  available_at_ms: string;
  binding_state: string;
  claimed_by: string;
  claim_token: string;
  destination: string;
  effect_adapter_key: string | null;
  event: unknown;
  event_id: string;
  external_execution_id: string | null;
  message_id: string;
  operation_key: string;
  run_id: string;
  start_key: string;
  step_run_id: string;
  workspace_id: string;
}>;

type LeafEffectRecoveryRow = Readonly<{
  attempt_id: string;
  attempts: number;
  claim_token: string;
  claimed_by: string;
  effect_adapter_key: string;
  event_id: string;
  run_id: string;
  start_key: string;
  step_run_id: string;
  workspace_id: string;
}>;

const assertScope = (
  transactionScope: WorkspaceScope,
  operationScope: WorkspaceScope
): void => {
  if (transactionScope.workspaceId !== operationScope.workspaceId) {
    throw new PostgresAdapterError(
      "workspace-scope-mismatch",
      "A transaction cannot access another workspace."
    );
  }
};

const assertPlanIdentity = (
  plan: RunPlan,
  scope: WorkspaceScope,
  expectedRunPlanId?: string
): void => {
  if (
    plan.workspaceId !== scope.workspaceId ||
    (expectedRunPlanId !== undefined && plan.runPlanId !== expectedRunPlanId)
  ) {
    throw new PostgresAdapterError(
      "database-identity-mismatch",
      "The stored run plan identity does not match its database key."
    );
  }
};

const makeUnitOfWork = (
  sql: postgres.Sql,
  transactionScope: WorkspaceScope
): RunCreationUnitOfWork => ({
  outbox: {
    append: async (scope, message) => {
      assertScope(transactionScope, scope);
      if (
        message.workspaceId !== scope.workspaceId ||
        message.event.workspaceId !== scope.workspaceId ||
        message.aggregateId !== message.event.runId ||
        message.eventId !== message.event.eventId
      ) {
        throw new PostgresAdapterError(
          "outbox-message-inconsistent",
          "The outbox message identity does not match its event and workspace."
        );
      }
      await sql`
        INSERT INTO kurobara_core.outbox_messages (
          message_id,
          workspace_id,
          aggregate_id,
          aggregate_version,
          event_id,
          destination,
          event,
          available_at
        ) VALUES (
          ${message.messageId},
          ${scope.workspaceId},
          ${message.aggregateId},
          ${message.aggregateVersion},
          ${message.eventId},
          ${message.destination},
          ${sql.json(toJsonValue(message.event))},
          ${new Date(message.availableAt)}
        )
      `;
      await sql`
        INSERT INTO kurobara_core.run_orchestration_bindings (
          workspace_id,
          run_id,
          outbox_message_id,
          start_key
        ) VALUES (
          ${scope.workspaceId},
          ${message.aggregateId},
          ${message.messageId},
          ${message.messageId}
        )
      `;
    },
  },
  runEvents: {
    append: async (scope, event) => {
      assertScope(transactionScope, scope);
      if (event.workspaceId !== scope.workspaceId) {
        throw new PostgresAdapterError(
          "workspace-scope-mismatch",
          "The run event belongs to another workspace."
        );
      }
      await sql`
        INSERT INTO kurobara_core.run_events (
          workspace_id,
          run_id,
          sequence,
          event_id,
          event,
          occurred_at
        ) VALUES (
          ${scope.workspaceId},
          ${event.runId},
          ${event.sequence},
          ${event.eventId},
          ${sql.json(toJsonValue(event))},
          ${new Date(event.occurredAt)}
        )
      `;
    },
  },
  runPlans: {
    get: async (scope, requestedRunPlanId) => {
      assertScope(transactionScope, scope);
      const rows = await sql<readonly PlanRow[]>`
        SELECT plan, consumed_by
        FROM kurobara_core.run_plans
        WHERE workspace_id = ${scope.workspaceId}
          AND run_plan_id = ${requestedRunPlanId}
        FOR UPDATE
      `;
      const row = rows[0];
      if (row === undefined) {
        return;
      }
      const plan = parseRunPlan(row.plan);
      assertPlanIdentity(plan, scope, requestedRunPlanId);
      const consumedBy =
        row.consumed_by === null
          ? undefined
          : parseRunCreationRecord(row.consumed_by);
      if (
        consumedBy !== undefined &&
        (consumedBy.run.workspaceId !== scope.workspaceId ||
          consumedBy.run.runPlanId !== requestedRunPlanId)
      ) {
        throw new PostgresAdapterError(
          "database-identity-mismatch",
          "The stored run-plan consumption does not match its database key."
        );
      }
      return {
        plan,
        ...(consumedBy === undefined ? {} : { consumedBy }),
      };
    },
    insert: async (scope, plan) => {
      assertScope(transactionScope, scope);
      assertPlanIdentity(plan, scope);
      const rows = await sql<readonly { run_plan_id: string }[]>`
        INSERT INTO kurobara_core.run_plans (
          workspace_id,
          run_plan_id,
          plan
        ) VALUES (
          ${scope.workspaceId},
          ${plan.runPlanId},
          ${sql.json(toJsonValue(plan))}
        )
        ON CONFLICT (workspace_id, run_plan_id) DO UPDATE
        SET plan = excluded.plan
        WHERE kurobara_core.run_plans.plan = excluded.plan
        RETURNING run_plan_id
      `;
      if (rows.length === 0) {
        throw new ImmutableRecordConflictError("run plan");
      }
    },
    markConsumed: async (scope, requestedRunPlanId, creation) => {
      assertScope(transactionScope, scope);
      if (
        creation.run.workspaceId !== scope.workspaceId ||
        creation.run.runPlanId !== requestedRunPlanId
      ) {
        throw new PostgresAdapterError(
          "workspace-scope-mismatch",
          "The run creation belongs to another workspace."
        );
      }
      const rows = await sql<readonly { run_plan_id: string }[]>`
        UPDATE kurobara_core.run_plans
        SET
          consumed_by = ${sql.json(toJsonValue(creation))},
          consumed_at = clock_timestamp()
        WHERE workspace_id = ${scope.workspaceId}
          AND run_plan_id = ${requestedRunPlanId}
          AND consumed_by IS NULL
        RETURNING run_plan_id
      `;
      if (rows.length === 0) {
        throw new PostgresAdapterError(
          "run-plan-consumption-conflict",
          `Run plan ${requestedRunPlanId} is missing or already consumed.`
        );
      }
    },
  },
  runs: {
    findByIdempotencyKey: async (scope, key) => {
      assertScope(transactionScope, scope);
      const rows = await sql<readonly RunRow[]>`
        SELECT idempotency_key, intention_hash, run
        FROM kurobara_core.runs
        WHERE workspace_id = ${scope.workspaceId}
          AND idempotency_key = ${key}
      `;
      const row = rows[0];
      if (row === undefined) {
        return;
      }
      const run = parseRun(row.run);
      if (
        run.workspaceId !== scope.workspaceId ||
        run.idempotencyKey !== row.idempotency_key ||
        run.intentionHash !== row.intention_hash
      ) {
        throw new PostgresAdapterError(
          "database-identity-mismatch",
          "The stored run identity does not match its database key."
        );
      }
      return parseRunCreationRecord({
        idempotencyKey: row.idempotency_key,
        intentionHash: row.intention_hash,
        run,
      });
    },
    insert: async (scope, run, cost) => {
      assertScope(transactionScope, scope);
      if (run.workspaceId !== scope.workspaceId) {
        throw new PostgresAdapterError(
          "workspace-scope-mismatch",
          "The run belongs to another workspace."
        );
      }
      await sql`
        INSERT INTO kurobara_core.runs (
          workspace_id,
          run_id,
          run_plan_id,
          idempotency_key,
          intention_hash,
          cost,
          run
        ) VALUES (
          ${scope.workspaceId},
          ${run.runId},
          ${run.runPlanId},
          ${run.idempotencyKey},
          ${run.intentionHash},
          ${sql.json(toJsonValue(cost))},
          ${sql.json(toJsonValue(run))}
        )
      `;
    },
    lockIdempotencyKey: async (scope, key) => {
      assertScope(transactionScope, scope);
      const lockIdentity = JSON.stringify([scope.workspaceId, key]);
      await sql`
        SELECT pg_advisory_xact_lock(
          hashtextextended(${lockIdentity}, 0)
        )
      `;
    },
  },
});

const parseOutboxRow = (row: OutboxRow): OutboxClaim => {
  if (row.destination !== "orchestration.run.queued") {
    throw new PostgresAdapterError(
      "outbox-destination-unsupported",
      `Unsupported outbox destination ${row.destination}.`
    );
  }
  const event = parseRunQueued(row.event);
  const message: OutboxMessage = {
    aggregateId: runId(row.aggregate_id),
    aggregateVersion: 1,
    availableAt: instant(Number(row.available_at_ms)),
    destination: "orchestration.run.queued",
    event,
    eventId: eventIdFromRow(row.event_id, event.eventId),
    messageId: outboxMessageId(row.message_id),
    workspaceId: workspaceId(row.workspace_id),
  };
  if (
    row.aggregate_version !== 1 ||
    message.aggregateId !== event.runId ||
    message.workspaceId !== event.workspaceId
  ) {
    throw new PostgresAdapterError(
      "database-identity-mismatch",
      "The outbox row does not match its event payload."
    );
  }
  if (
    row.orchestration_state !== "pending" &&
    row.orchestration_state !== "starting" &&
    row.orchestration_state !== "started" &&
    row.orchestration_state !== "reconciliation_required" &&
    row.orchestration_state !== "reconciliation_exhausted"
  ) {
    throw new PostgresAdapterError(
      "database-payload-invalid",
      "The orchestration binding state is invalid."
    );
  }
  return {
    attempt: row.attempt,
    binding: {
      ...(row.adapter_key === null ? {} : { adapterKey: row.adapter_key }),
      ...(row.orchestration_run_id === null
        ? {}
        : { orchestrationRunId: row.orchestration_run_id }),
      startKey: row.start_key,
      state: row.orchestration_state,
    },
    claimedBy: row.claimed_by,
    claimToken: row.claim_token,
    message,
  };
};

const eventIdFromRow = (
  databaseEventId: string,
  payloadEventId: OutboxMessage["eventId"]
): OutboxMessage["eventId"] => {
  if (databaseEventId !== payloadEventId) {
    throw new PostgresAdapterError(
      "database-identity-mismatch",
      "The outbox event identifier does not match its payload."
    );
  }
  return payloadEventId;
};

const settle = async (
  input: { messageId: string },
  update: postgres.PendingQuery<readonly { message_id: string }[]>
): Promise<void> => {
  const rows = await update;
  if (rows.length === 0) {
    throw new OutboxLeaseConflictError(input.messageId);
  }
};

const settleBinding = async (
  messageId: string,
  update: postgres.PendingQuery<readonly { message_id: string }[]>
): Promise<void> => {
  const rows = await update;
  if (rows.length === 0) {
    throw new OrchestrationBindingConflictError(messageId);
  }
};

const makeOutbox = (sql: postgres.Sql): OutboxDispatchPort => ({
  claimNext: async (input) => {
    const claimToken = randomUUID();
    const rows = await sql<readonly OutboxRow[]>`
      WITH candidate AS (
        SELECT message.message_id, message.state
        FROM kurobara_core.outbox_messages AS message
        WHERE message.destination = 'orchestration.run.queued'
          AND EXISTS (
            SELECT 1
            FROM kurobara_core.run_orchestration_bindings AS binding
            WHERE binding.outbox_message_id = message.message_id
              AND (
                binding.reconciliation_claimed_until IS NULL
                OR binding.reconciliation_claimed_until <= clock_timestamp()
              )
          )
          AND (
            (
              message.state IN ('pending', 'retry')
              AND message.available_at <= clock_timestamp()
            ) OR (
              message.state = 'claimed'
              AND message.claimed_until <= clock_timestamp()
            )
          )
        ORDER BY message.available_at, message.created_at
        FOR UPDATE SKIP LOCKED
        LIMIT 1
      ), reconciled AS (
        UPDATE kurobara_core.run_orchestration_bindings AS binding
        SET
          state = 'reconciliation_required',
          updated_at = clock_timestamp()
        FROM candidate
        WHERE candidate.state = 'claimed'
          AND binding.outbox_message_id = candidate.message_id
          AND binding.state = 'starting'
        RETURNING binding.outbox_message_id
      ), claimed AS (
        UPDATE kurobara_core.outbox_messages AS message
        SET
          state = 'claimed',
          claimed_by = ${input.claimedBy},
          claim_token = ${claimToken},
          claimed_until = clock_timestamp()
            + (${input.leaseMilliseconds} * interval '1 millisecond'),
          attempts = attempts + 1,
          updated_at = clock_timestamp()
        FROM candidate
        WHERE message.message_id = candidate.message_id
        RETURNING message.*
      )
      SELECT
        claimed.message_id,
        claimed.workspace_id,
        claimed.aggregate_id,
        claimed.aggregate_version,
        claimed.event_id,
        claimed.destination,
        claimed.event,
        claimed.claimed_by,
        claimed.claim_token,
        claimed.attempts AS attempt,
        binding.start_key,
        binding.state AS orchestration_state,
        binding.adapter_key,
        binding.orchestration_run_id,
        floor(extract(epoch FROM claimed.available_at) * 1000)::bigint::text
          AS available_at_ms,
        (SELECT count(*) FROM reconciled) AS reconciliation_count
      FROM claimed
      JOIN kurobara_core.run_orchestration_bindings AS binding
        ON binding.outbox_message_id = claimed.message_id
    `;
    return rows[0] === undefined ? undefined : parseOutboxRow(rows[0]);
  },
  markDeadLetter: async (input) =>
    settle(
      input,
      sql<readonly { message_id: string }[]>`
        UPDATE kurobara_core.outbox_messages AS message
        SET
          state = 'dead_letter',
          claimed_by = NULL,
          claim_token = NULL,
          claimed_until = NULL,
          last_error = ${input.reason},
          updated_at = clock_timestamp()
        WHERE message_id = ${input.messageId}
          AND state = 'claimed'
          AND claimed_by = ${input.claimedBy}
          AND claim_token = ${input.claimToken}
          AND claimed_until > clock_timestamp()
        RETURNING message_id
      `
    ),
  markDispatched: async (input) =>
    settle(
      input,
      sql<readonly { message_id: string }[]>`
        UPDATE kurobara_core.outbox_messages AS message
        SET
          state = 'dispatched',
          claimed_by = NULL,
          claim_token = NULL,
          claimed_until = NULL,
          orchestration_run_id = binding.orchestration_run_id,
          dispatched_at = clock_timestamp(),
          last_error = NULL,
          updated_at = clock_timestamp()
        FROM kurobara_core.run_orchestration_bindings AS binding
        WHERE message.message_id = ${input.messageId}
          AND binding.outbox_message_id = message.message_id
          AND binding.state = 'started'
          AND message.state = 'claimed'
          AND message.claimed_by = ${input.claimedBy}
          AND message.claim_token = ${input.claimToken}
          AND message.claimed_until > clock_timestamp()
        RETURNING message.message_id
      `
    ),
  markReconciliationRequired: async (input) =>
    settle(
      input,
      sql<readonly { message_id: string }[]>`
        UPDATE kurobara_core.run_orchestration_bindings AS binding
        SET
          state = 'reconciliation_required',
          updated_at = clock_timestamp()
        FROM kurobara_core.outbox_messages AS message
        WHERE binding.outbox_message_id = ${input.messageId}
          AND message.message_id = binding.outbox_message_id
          AND binding.state IN ('starting', 'reconciliation_required')
          AND message.state = 'claimed'
          AND message.claimed_by = ${input.claimedBy}
          AND message.claim_token = ${input.claimToken}
          AND message.claimed_until > clock_timestamp()
        RETURNING binding.outbox_message_id AS message_id
      `
    ),
  markRetry: async (input) =>
    settle(
      input,
      sql<readonly { message_id: string }[]>`
        UPDATE kurobara_core.outbox_messages
        SET
          state = 'retry',
          available_at = clock_timestamp()
            + (${input.retryDelayMilliseconds} * interval '1 millisecond'),
          claimed_by = NULL,
          claim_token = NULL,
          claimed_until = NULL,
          last_error = ${input.reason},
          updated_at = clock_timestamp()
        WHERE message_id = ${input.messageId}
          AND state = 'claimed'
          AND claimed_by = ${input.claimedBy}
          AND claim_token = ${input.claimToken}
          AND claimed_until > clock_timestamp()
        RETURNING message_id
      `
    ),
  markStarting: async (input) =>
    settleBinding(
      input.messageId,
      sql<readonly { message_id: string }[]>`
        UPDATE kurobara_core.run_orchestration_bindings AS binding
        SET
          adapter_key = ${input.adapterKey},
          state = 'starting',
          updated_at = clock_timestamp()
        FROM kurobara_core.outbox_messages AS message
        WHERE binding.outbox_message_id = ${input.messageId}
          AND message.message_id = binding.outbox_message_id
          AND binding.state = 'pending'
          AND message.state = 'claimed'
          AND message.claimed_by = ${input.claimedBy}
          AND message.claim_token = ${input.claimToken}
          AND message.claimed_until > clock_timestamp()
        RETURNING binding.outbox_message_id AS message_id
      `
    ),
  recordStarted: async (input) =>
    settleBinding(
      input.messageId,
      sql<readonly { message_id: string }[]>`
        UPDATE kurobara_core.run_orchestration_bindings AS binding
        SET
          adapter_key = ${input.adapterKey},
          orchestration_run_id = ${input.orchestrationRunId},
          state = 'started',
          reconciliation_claimed_by = NULL,
          reconciliation_claim_token = NULL,
          reconciliation_claimed_until = NULL,
          updated_at = clock_timestamp()
        FROM kurobara_core.outbox_messages AS message
        WHERE binding.outbox_message_id = ${input.messageId}
          AND message.message_id = binding.outbox_message_id
          AND binding.state IN ('starting', 'reconciliation_required')
          AND (binding.adapter_key IS NULL OR binding.adapter_key = ${input.adapterKey})
          AND message.state = 'claimed'
          AND message.claimed_by = ${input.claimedBy}
          AND message.claim_token = ${input.claimToken}
          AND message.claimed_until > clock_timestamp()
        RETURNING binding.outbox_message_id AS message_id
      `
    ),
  resetPending: async (input) =>
    settleBinding(
      input.messageId,
      sql<readonly { message_id: string }[]>`
        UPDATE kurobara_core.run_orchestration_bindings AS binding
        SET
          adapter_key = NULL,
          state = 'pending',
          updated_at = clock_timestamp()
        FROM kurobara_core.outbox_messages AS message
        WHERE binding.outbox_message_id = ${input.messageId}
          AND message.message_id = binding.outbox_message_id
          AND binding.state = 'starting'
          AND message.state = 'claimed'
          AND message.claimed_by = ${input.claimedBy}
          AND message.claim_token = ${input.claimToken}
          AND message.claimed_until > clock_timestamp()
        RETURNING binding.outbox_message_id AS message_id
      `
    ),
});

const assertLeafMessageIdentity = (
  scope: WorkspaceScope,
  message: LeafOutboxMessage
): void => {
  const parsed = parseLeafOutboxMessageIdentity({
    aggregateVersion: message.aggregateVersion,
    attemptId: message.attemptId,
    availableAtMilliseconds: message.availableAt,
    destination: message.destination,
    effectAdapterKey: message.effectAdapterKey,
    event: message.event,
    eventId: message.eventId,
    messageId: message.messageId,
    operationKey: message.operationKey,
    runId: message.runId,
    stepRunId: message.stepRunId,
    workspaceId: message.workspaceId,
  });
  if (
    parsed.workspaceId !== scope.workspaceId ||
    parsed.event.workspaceId !== scope.workspaceId
  ) {
    throw new PostgresAdapterError(
      "workspace-scope-mismatch",
      "The leaf outbox message belongs to another workspace."
    );
  }
};

const appendLeafOutbox = async (
  transactionSql: postgres.Sql,
  transactionScope: WorkspaceScope,
  operationScope: WorkspaceScope,
  message: LeafOutboxMessage
): Promise<void> => {
  assertScope(transactionScope, operationScope);
  assertLeafMessageIdentity(transactionScope, message);
  const outboxRows = await transactionSql<readonly { message_id: string }[]>`
    INSERT INTO kurobara_core.outbox_messages (
      message_id, workspace_id, aggregate_id, aggregate_version,
      event_id, destination, event, available_at
    ) VALUES (
      ${message.messageId}, ${transactionScope.workspaceId}, ${message.runId},
      ${message.aggregateVersion}, ${message.eventId}, ${message.destination},
      ${transactionSql.json(toJsonValue(message.event))},
      ${new Date(message.availableAt)}
    )
    ON CONFLICT (workspace_id, event_id, destination) DO UPDATE
    SET updated_at = kurobara_core.outbox_messages.updated_at
    WHERE kurobara_core.outbox_messages.message_id = excluded.message_id
      AND kurobara_core.outbox_messages.aggregate_id = excluded.aggregate_id
      AND kurobara_core.outbox_messages.aggregate_version = excluded.aggregate_version
      AND kurobara_core.outbox_messages.event = excluded.event
      AND kurobara_core.outbox_messages.available_at = excluded.available_at
    RETURNING message_id
  `;
  if (outboxRows.length === 0) {
    throw new ImmutableRecordConflictError("leaf outbox message");
  }

  const startKey = `effect:${message.attemptId}`;
  const bindingRows = await transactionSql<readonly { attempt_id: string }[]>`
    INSERT INTO kurobara_core.step_leaf_execution_bindings (
      workspace_id, run_id, step_run_id, attempt_id, event_id, reservation_id,
      operation_key, outbox_message_id, start_key, effect_adapter_key
    )
    SELECT
      attempt.workspace_id, step.run_id, attempt.step_run_id,
      attempt.attempt_id, step_event.event_id, attempt.reservation_id,
      attempt.operation_key,
      ${message.messageId}, ${startKey}, ${message.effectAdapterKey}
    FROM kurobara_core.step_attempts AS attempt
    JOIN kurobara_core.step_runs AS step
      ON step.workspace_id = attempt.workspace_id
      AND step.step_run_id = attempt.step_run_id
    JOIN kurobara_core.step_events AS step_event
      ON step_event.workspace_id = attempt.workspace_id
      AND step_event.step_run_id = attempt.step_run_id
      AND step_event.event_id = ${message.eventId}
      AND step_event.event = ${transactionSql.json(toJsonValue(message.event))}
    WHERE attempt.workspace_id = ${transactionScope.workspaceId}
      AND attempt.attempt_id = ${message.attemptId}
      AND attempt.step_run_id = ${message.stepRunId}
      AND attempt.operation_key = ${message.operationKey}
      AND attempt.effect_adapter_key = ${message.effectAdapterKey}
      AND attempt.state = 'claimed'
      AND step.run_id = ${message.runId}
      AND step.aggregate_version = ${message.aggregateVersion}
      AND EXISTS (
        SELECT 1
        FROM kurobara_core.routing_decisions AS decision
        WHERE decision.workspace_id = attempt.workspace_id
          AND decision.routing_decision_id = attempt.routing_decision_id
          AND decision.run_id = step.run_id
          AND decision.step_run_id = attempt.step_run_id
          AND decision.effect_adapter_key = attempt.effect_adapter_key
          AND decision.route_key = attempt.route_key
          AND decision.route_snapshot_hash = attempt.route_snapshot_hash
      )
    ON CONFLICT (workspace_id, attempt_id) DO UPDATE
    SET updated_at = kurobara_core.step_leaf_execution_bindings.updated_at
    WHERE kurobara_core.step_leaf_execution_bindings.run_id = excluded.run_id
      AND kurobara_core.step_leaf_execution_bindings.step_run_id = excluded.step_run_id
      AND kurobara_core.step_leaf_execution_bindings.event_id = excluded.event_id
      AND kurobara_core.step_leaf_execution_bindings.reservation_id = excluded.reservation_id
      AND kurobara_core.step_leaf_execution_bindings.operation_key = excluded.operation_key
      AND kurobara_core.step_leaf_execution_bindings.outbox_message_id = excluded.outbox_message_id
      AND kurobara_core.step_leaf_execution_bindings.start_key = excluded.start_key
      AND kurobara_core.step_leaf_execution_bindings.effect_adapter_key =
        excluded.effect_adapter_key
    RETURNING attempt_id
  `;
  if (bindingRows.length === 0) {
    throw new ImmutableRecordConflictError("leaf execution binding");
  }
};

const leafEffectAdapterKey = (row: LeafOutboxRow): string => {
  const selected = row.effect_adapter_key;
  const legacyAttempt =
    row.attempt_effect_adapter_key === "legacy-unattributed";
  if (
    row.attempt_effect_adapter_key.length === 0 ||
    (selected === null && !legacyAttempt) ||
    (selected !== null &&
      selected !== row.attempt_effect_adapter_key &&
      !legacyAttempt)
  ) {
    throw new PostgresAdapterError(
      "database-identity-mismatch",
      "The leaf outbox adapter does not match its routed attempt."
    );
  }
  return selected ?? row.attempt_effect_adapter_key;
};

const parseLeafOutboxRow = (row: LeafOutboxRow): LeafOutboxClaim => {
  const selectedEffectAdapterKey = leafEffectAdapterKey(row);
  if (
    row.binding_state !== "pending" &&
    row.binding_state !== "starting" &&
    row.binding_state !== "started" &&
    row.binding_state !== "reconciliation_required" &&
    row.binding_state !== "reconciliation_exhausted" &&
    row.binding_state !== "rejected" &&
    row.binding_state !== "cancelled"
  ) {
    throw new PostgresAdapterError(
      "database-payload-invalid",
      "The leaf execution binding state is invalid."
    );
  }
  const adapterPresent = row.adapter_key !== null && row.adapter_key.length > 0;
  const externalPresent =
    row.external_execution_id !== null && row.external_execution_id.length > 0;
  const bindingShapeValid =
    (row.binding_state === "pending" &&
      row.adapter_key === null &&
      row.external_execution_id === null) ||
    ((row.binding_state === "starting" ||
      row.binding_state === "reconciliation_required" ||
      row.binding_state === "reconciliation_exhausted") &&
      adapterPresent &&
      row.external_execution_id === null) ||
    (row.binding_state === "started" && adapterPresent && externalPresent) ||
    ((row.binding_state === "rejected" || row.binding_state === "cancelled") &&
      !externalPresent) ||
    ((row.binding_state === "rejected" || row.binding_state === "cancelled") &&
      adapterPresent &&
      externalPresent);
  if (
    !bindingShapeValid ||
    (row.adapter_key !== null && !adapterPresent) ||
    (row.external_execution_id !== null && !externalPresent) ||
    !Number.isSafeInteger(row.attempt) ||
    row.attempt < 1 ||
    row.claimed_by.length === 0 ||
    row.claim_token.length === 0 ||
    row.start_key !== `effect:${row.attempt_id}`
  ) {
    throw new PostgresAdapterError(
      "database-identity-mismatch",
      "The leaf outbox claim has inconsistent identity or binding fields."
    );
  }
  const message = parseLeafOutboxMessageIdentity({
    aggregateVersion: row.aggregate_version,
    attemptId: row.attempt_id,
    availableAtMilliseconds: Number(row.available_at_ms),
    destination: row.destination,
    effectAdapterKey: selectedEffectAdapterKey,
    event: row.event,
    eventId: row.event_id,
    messageId: row.message_id,
    operationKey: row.operation_key,
    runId: row.run_id,
    stepRunId: row.step_run_id,
    workspaceId: row.workspace_id,
  });
  return {
    attempt: row.attempt,
    binding: {
      ...(row.adapter_key === null ? {} : { adapterKey: row.adapter_key }),
      ...(row.external_execution_id === null
        ? {}
        : { externalExecutionId: row.external_execution_id }),
      startKey: row.start_key,
      state: row.binding_state,
    },
    claimedBy: row.claimed_by,
    claimToken: row.claim_token,
    message,
  };
};

const settleLeaf = async (
  update: postgres.PendingQuery<readonly { message_id: string }[]>
): Promise<Readonly<{ status: "applied" | "stale" }>> => {
  const rows = await update;
  return { status: rows.length === 0 ? "stale" : "applied" };
};

const makeLeafOutbox = (sql: postgres.Sql): LeafOutboxDispatchPort => ({
  claimNext: async (input) => {
    const claimToken = randomUUID();
    const rows = await sql<readonly LeafOutboxRow[]>`
      WITH candidate AS (
        SELECT message.workspace_id, message.message_id, message.state,
          attempt.state AS attempt_state, binding.state AS binding_state,
          EXISTS (
            SELECT 1
            FROM kurobara_core.step_events AS effect_event
            WHERE effect_event.workspace_id = attempt.workspace_id
              AND effect_event.step_run_id = attempt.step_run_id
              AND effect_event.event ->> 'attemptId' = attempt.attempt_id
              AND effect_event.event ->> 'eventType' = 'AttemptEffectStarted'
          ) AS effect_started
        FROM kurobara_core.outbox_messages AS message
        JOIN kurobara_core.step_leaf_execution_bindings AS binding
          ON binding.workspace_id = message.workspace_id
          AND binding.run_id = message.aggregate_id
          AND binding.outbox_message_id = message.message_id
        JOIN kurobara_core.step_attempts AS attempt
          ON attempt.workspace_id = binding.workspace_id
          AND attempt.step_run_id = binding.step_run_id
          AND attempt.attempt_id = binding.attempt_id
        WHERE message.destination = 'orchestration.step.attempt.claimed'
          AND binding.state NOT IN (
            'reconciliation_exhausted', 'rejected', 'cancelled'
          )
          AND (
            (
              message.state IN ('pending', 'retry')
              AND message.available_at <= clock_timestamp()
            )
            OR (
              message.state = 'claimed'
              AND message.claimed_until <= clock_timestamp()
            )
          )
        ORDER BY message.available_at, message.created_at,
          message.workspace_id, message.message_id
        FOR UPDATE OF message, binding, attempt SKIP LOCKED
        LIMIT 1
      ), cancelled_binding AS (
        UPDATE kurobara_core.step_leaf_execution_bindings AS binding
        SET state = 'cancelled', updated_at = clock_timestamp()
        FROM candidate
        WHERE candidate.attempt_state IN (
            'failed_retryable', 'failed_terminal', 'cancelled_before_effect'
          )
          AND NOT candidate.effect_started
          AND candidate.binding_state = 'pending'
          AND binding.workspace_id = candidate.workspace_id
          AND binding.outbox_message_id = candidate.message_id
        RETURNING binding.workspace_id, binding.outbox_message_id
      ), cancelled_message AS (
        UPDATE kurobara_core.outbox_messages AS message
        SET
          state = 'cancelled', claimed_by = NULL, claim_token = NULL,
          claimed_until = NULL, cancelled_at = clock_timestamp(),
          last_error = 'leaf-attempt-no-longer-claimed',
          updated_at = clock_timestamp()
        FROM cancelled_binding
        WHERE message.workspace_id = cancelled_binding.workspace_id
          AND message.message_id = cancelled_binding.outbox_message_id
        RETURNING message.message_id
      ), reconciled AS (
        UPDATE kurobara_core.step_leaf_execution_bindings AS binding
        SET state = 'reconciliation_required', updated_at = clock_timestamp()
        FROM candidate
        WHERE (
            (candidate.state = 'claimed' AND binding.state = 'starting')
            OR (
              binding.state = 'pending'
              AND (
                candidate.effect_started
                OR candidate.attempt_state IN (
                  'in_flight', 'ambiguous', 'succeeded'
                )
              )
            )
          )
          AND binding.workspace_id = candidate.workspace_id
          AND binding.outbox_message_id = candidate.message_id
        RETURNING binding.workspace_id, binding.outbox_message_id, binding.state
      ), claimed AS (
        UPDATE kurobara_core.outbox_messages AS message
        SET
          state = 'claimed',
          claimed_by = ${input.claimedBy},
          claim_token = ${claimToken},
          claimed_until = clock_timestamp()
            + (${input.leaseMilliseconds} * interval '1 millisecond'),
          attempts = attempts + 1,
          updated_at = clock_timestamp()
        FROM candidate
        WHERE (
            candidate.attempt_state = 'claimed'
            OR candidate.binding_state IN (
              'starting', 'reconciliation_required'
            )
            OR EXISTS (
              SELECT 1
              FROM reconciled
              WHERE reconciled.workspace_id = candidate.workspace_id
                AND reconciled.outbox_message_id = candidate.message_id
            )
          )
          AND message.workspace_id = candidate.workspace_id
          AND message.message_id = candidate.message_id
        RETURNING message.*
      )
      SELECT
        claimed.workspace_id,
        claimed.message_id,
        claimed.aggregate_version,
        claimed.event_id,
        claimed.destination,
        claimed.event,
        claimed.claimed_by,
        claimed.claim_token,
        claimed.attempts AS attempt,
        binding.run_id,
        binding.step_run_id,
        binding.attempt_id,
        attempt.effect_adapter_key AS attempt_effect_adapter_key,
        binding.operation_key,
        binding.start_key,
        COALESCE(reconciled.state, binding.state) AS binding_state,
        binding.adapter_key,
        binding.effect_adapter_key,
        binding.external_execution_id,
        floor(extract(epoch FROM claimed.available_at) * 1000)::bigint::text
          AS available_at_ms
      FROM claimed
      JOIN kurobara_core.step_leaf_execution_bindings AS binding
        ON binding.workspace_id = claimed.workspace_id
        AND binding.run_id = claimed.aggregate_id
        AND binding.outbox_message_id = claimed.message_id
      JOIN kurobara_core.step_attempts AS attempt
        ON attempt.workspace_id = binding.workspace_id
        AND attempt.step_run_id = binding.step_run_id
        AND attempt.attempt_id = binding.attempt_id
      LEFT JOIN reconciled
        ON reconciled.workspace_id = binding.workspace_id
        AND reconciled.outbox_message_id = binding.outbox_message_id
    `;
    return rows[0] === undefined ? undefined : parseLeafOutboxRow(rows[0]);
  },
  markCancelled: (input) =>
    settleLeaf(
      sql<readonly { message_id: string }[]>`
        WITH terminal_binding AS (
          UPDATE kurobara_core.step_leaf_execution_bindings AS binding
          SET state = 'cancelled', updated_at = clock_timestamp()
          FROM kurobara_core.outbox_messages AS message
          WHERE binding.workspace_id = ${input.scope.workspaceId}
            AND binding.outbox_message_id = ${input.messageId}
            AND message.workspace_id = binding.workspace_id
            AND message.message_id = binding.outbox_message_id
            AND binding.state NOT IN ('reconciliation_exhausted', 'rejected')
            AND message.state = 'claimed'
            AND message.claimed_by = ${input.claimedBy}
            AND message.claim_token = ${input.claimToken}
          RETURNING binding.workspace_id, binding.outbox_message_id
        )
        UPDATE kurobara_core.outbox_messages AS message
        SET
          state = 'cancelled', claimed_by = NULL, claim_token = NULL,
          claimed_until = NULL, last_error = ${input.reason},
          cancelled_at = clock_timestamp(), updated_at = clock_timestamp()
        FROM terminal_binding
        WHERE message.workspace_id = terminal_binding.workspace_id
          AND message.message_id = terminal_binding.outbox_message_id
        RETURNING message.message_id
      `
    ),
  markDeadLetter: (input) =>
    settleLeaf(
      sql<readonly { message_id: string }[]>`
        WITH terminal_binding AS (
          UPDATE kurobara_core.step_leaf_execution_bindings AS binding
          SET
            state = CASE
              WHEN binding.state IN ('starting', 'reconciliation_required')
                THEN 'reconciliation_exhausted'
              ELSE 'rejected'
            END,
            updated_at = clock_timestamp()
          FROM kurobara_core.outbox_messages AS message
          WHERE binding.workspace_id = ${input.scope.workspaceId}
            AND binding.outbox_message_id = ${input.messageId}
            AND message.workspace_id = binding.workspace_id
            AND message.message_id = binding.outbox_message_id
            AND binding.state NOT IN ('started', 'cancelled', 'rejected')
            AND message.state = 'claimed'
            AND message.claimed_by = ${input.claimedBy}
            AND message.claim_token = ${input.claimToken}
          RETURNING binding.workspace_id, binding.outbox_message_id
        )
        UPDATE kurobara_core.outbox_messages AS message
        SET
          state = 'dead_letter', claimed_by = NULL, claim_token = NULL,
          claimed_until = NULL, last_error = ${input.reason},
          updated_at = clock_timestamp()
        FROM terminal_binding
        WHERE message.workspace_id = terminal_binding.workspace_id
          AND message.message_id = terminal_binding.outbox_message_id
        RETURNING message.message_id
      `
    ),
  markReconciliationRequired: (input) =>
    settleLeaf(
      sql<readonly { message_id: string }[]>`
        WITH delayed_binding AS (
          UPDATE kurobara_core.step_leaf_execution_bindings AS binding
          SET state = 'reconciliation_required', updated_at = clock_timestamp()
          FROM kurobara_core.outbox_messages AS message
          WHERE binding.workspace_id = ${input.scope.workspaceId}
            AND binding.outbox_message_id = ${input.messageId}
            AND message.workspace_id = binding.workspace_id
            AND message.message_id = binding.outbox_message_id
            AND binding.state IN ('starting', 'reconciliation_required')
            AND message.state = 'claimed'
            AND message.claimed_by = ${input.claimedBy}
            AND message.claim_token = ${input.claimToken}
          RETURNING binding.workspace_id, binding.outbox_message_id
        )
        UPDATE kurobara_core.outbox_messages AS message
        SET
          state = 'retry',
          available_at = clock_timestamp()
            + (${input.retryDelayMilliseconds} * interval '1 millisecond'),
          claimed_by = NULL, claim_token = NULL, claimed_until = NULL,
          last_error = ${input.reason}, updated_at = clock_timestamp()
        FROM delayed_binding
        WHERE message.workspace_id = delayed_binding.workspace_id
          AND message.message_id = delayed_binding.outbox_message_id
        RETURNING message.message_id
      `
    ),
  markStarting: (input) =>
    settleLeaf(
      sql<readonly { message_id: string }[]>`
        UPDATE kurobara_core.step_leaf_execution_bindings AS binding
        SET
          adapter_key = ${input.adapterKey},
          effect_adapter_key = ${input.effectAdapterKey},
          state = 'starting',
          updated_at = clock_timestamp()
        FROM kurobara_core.outbox_messages AS message,
          kurobara_core.step_attempts AS attempt
        WHERE binding.workspace_id = ${input.scope.workspaceId}
          AND binding.outbox_message_id = ${input.messageId}
          AND binding.state = 'pending'
          AND message.workspace_id = binding.workspace_id
          AND message.message_id = binding.outbox_message_id
          AND message.state = 'claimed'
          AND message.claimed_by = ${input.claimedBy}
          AND message.claim_token = ${input.claimToken}
          AND attempt.workspace_id = binding.workspace_id
          AND attempt.step_run_id = binding.step_run_id
          AND attempt.attempt_id = binding.attempt_id
          AND attempt.reservation_id = binding.reservation_id
          AND attempt.operation_key = binding.operation_key
          AND attempt.state = 'claimed'
          AND binding.effect_adapter_key = ${input.effectAdapterKey}
        RETURNING binding.outbox_message_id AS message_id
      `
    ),
  recordRejected: (input) =>
    settleLeaf(
      sql<readonly { message_id: string }[]>`
        WITH terminal_binding AS (
          UPDATE kurobara_core.step_leaf_execution_bindings AS binding
          SET state = 'rejected', updated_at = clock_timestamp()
          FROM kurobara_core.outbox_messages AS message
          WHERE binding.workspace_id = ${input.scope.workspaceId}
            AND binding.outbox_message_id = ${input.messageId}
            AND message.workspace_id = binding.workspace_id
            AND message.message_id = binding.outbox_message_id
            AND binding.state IN ('pending', 'starting', 'reconciliation_required')
            AND message.state = 'claimed'
            AND message.claimed_by = ${input.claimedBy}
            AND message.claim_token = ${input.claimToken}
          RETURNING binding.workspace_id, binding.outbox_message_id
        )
        UPDATE kurobara_core.outbox_messages AS message
        SET
          state = 'dead_letter', claimed_by = NULL, claim_token = NULL,
          claimed_until = NULL, last_error = ${input.reason},
          updated_at = clock_timestamp()
        FROM terminal_binding
        WHERE message.workspace_id = terminal_binding.workspace_id
          AND message.message_id = terminal_binding.outbox_message_id
        RETURNING message.message_id
      `
    ),
  recordStarted: (input) =>
    settleLeaf(
      sql<readonly { message_id: string }[]>`
        WITH started_binding AS (
          UPDATE kurobara_core.step_leaf_execution_bindings AS binding
          SET
            adapter_key = ${input.adapterKey},
            external_execution_id = ${input.externalExecutionId},
            state = 'started',
            updated_at = clock_timestamp()
          FROM kurobara_core.outbox_messages AS message
          WHERE binding.workspace_id = ${input.scope.workspaceId}
            AND binding.outbox_message_id = ${input.messageId}
            AND message.workspace_id = binding.workspace_id
            AND message.message_id = binding.outbox_message_id
            AND binding.state IN ('starting', 'reconciliation_required')
            AND binding.adapter_key = ${input.adapterKey}
            AND binding.effect_adapter_key = ${input.effectAdapterKey}
            AND message.state = 'claimed'
            AND message.claimed_by = ${input.claimedBy}
            AND message.claim_token = ${input.claimToken}
          RETURNING binding.workspace_id, binding.attempt_id,
            binding.effect_adapter_key, binding.outbox_message_id
        ), recovery_job AS (
          INSERT INTO kurobara_core.step_leaf_effect_recovery_jobs (
            workspace_id, attempt_id, effect_adapter_key, state,
            max_attempts, next_attempt_at
          )
          SELECT
            started_binding.workspace_id,
            started_binding.attempt_id,
            started_binding.effect_adapter_key,
            'pending',
            ${input.recoveryMaxAttempts},
            clock_timestamp()
              + (${input.recoveryDelayMilliseconds} * interval '1 millisecond')
          FROM started_binding
          ON CONFLICT (workspace_id, attempt_id) DO UPDATE
          SET updated_at = kurobara_core.step_leaf_effect_recovery_jobs.updated_at
          WHERE kurobara_core.step_leaf_effect_recovery_jobs.effect_adapter_key
              = excluded.effect_adapter_key
            AND kurobara_core.step_leaf_effect_recovery_jobs.max_attempts
              = excluded.max_attempts
          RETURNING workspace_id, attempt_id
        )
        UPDATE kurobara_core.outbox_messages AS message
        SET
          state = 'dispatched', claimed_by = NULL, claim_token = NULL,
          claimed_until = NULL, dispatched_at = clock_timestamp(),
          last_error = NULL, updated_at = clock_timestamp()
        FROM started_binding
        JOIN recovery_job
          ON recovery_job.workspace_id = started_binding.workspace_id
          AND recovery_job.attempt_id = started_binding.attempt_id
        WHERE message.workspace_id = started_binding.workspace_id
          AND message.message_id = started_binding.outbox_message_id
        RETURNING message.message_id
      `
    ),
  resetPending: async (input) => {
    const result = await sql.begin(async (transaction) => {
      const transactionSql = transaction as unknown as postgres.Sql;
      const locked = await transactionSql<
        readonly { attempt_id: string; step_run_id: string }[]
      >`
        SELECT binding.attempt_id, binding.step_run_id
        FROM kurobara_core.step_leaf_execution_bindings AS binding
        JOIN kurobara_core.outbox_messages AS message
          ON message.workspace_id = binding.workspace_id
          AND message.message_id = binding.outbox_message_id
        WHERE binding.workspace_id = ${input.scope.workspaceId}
          AND binding.outbox_message_id = ${input.messageId}
          AND binding.state IN ('starting', 'reconciliation_required')
          AND message.state = 'claimed'
          AND message.claimed_by = ${input.claimedBy}
          AND message.claim_token = ${input.claimToken}
        FOR UPDATE OF binding, message
      `;
      const identity = locked[0];
      if (identity === undefined) {
        return { status: "stale" as const };
      }
      const attempts = await transactionSql<readonly { state: string }[]>`
        SELECT state
        FROM kurobara_core.step_attempts
        WHERE workspace_id = ${input.scope.workspaceId}
          AND step_run_id = ${identity.step_run_id}
          AND attempt_id = ${identity.attempt_id}
        FOR UPDATE
      `;
      if (attempts[0]?.state !== "claimed") {
        return { status: "stale" as const };
      }
      const rows = await transactionSql<readonly { message_id: string }[]>`
        WITH reset_binding AS (
          UPDATE kurobara_core.step_leaf_execution_bindings AS binding
          SET
            adapter_key = NULL,
            external_execution_id = NULL,
            state = 'pending',
            updated_at = clock_timestamp()
          FROM kurobara_core.outbox_messages AS message
          WHERE binding.workspace_id = ${input.scope.workspaceId}
            AND binding.outbox_message_id = ${input.messageId}
            AND message.workspace_id = binding.workspace_id
            AND message.message_id = binding.outbox_message_id
            AND binding.state IN ('starting', 'reconciliation_required')
            AND message.state = 'claimed'
            AND message.claimed_by = ${input.claimedBy}
            AND message.claim_token = ${input.claimToken}
          RETURNING binding.workspace_id, binding.outbox_message_id
        )
        UPDATE kurobara_core.outbox_messages AS message
        SET
          state = 'retry',
          available_at = clock_timestamp()
            + (${input.retryDelayMilliseconds} * interval '1 millisecond'),
          claimed_by = NULL, claim_token = NULL, claimed_until = NULL,
          last_error = ${input.reason}, updated_at = clock_timestamp()
        FROM reset_binding
        WHERE message.workspace_id = reset_binding.workspace_id
          AND message.message_id = reset_binding.outbox_message_id
        RETURNING message.message_id
      `;
      return { status: rows.length === 0 ? "stale" : "applied" } as const;
    });
    return result as unknown as Readonly<{ status: "applied" | "stale" }>;
  },
});

const parseLeafEffectRecoveryRow = (
  row: LeafEffectRecoveryRow
): LeafEffectRecoveryClaim => {
  if (
    row.attempts < 1 ||
    !Number.isSafeInteger(row.attempts) ||
    row.claim_token.length === 0 ||
    row.claimed_by.length === 0 ||
    row.effect_adapter_key.length === 0 ||
    row.start_key !== `effect:${row.attempt_id}`
  ) {
    throw new PostgresAdapterError(
      "database-identity-mismatch",
      "The leaf effect recovery row has inconsistent identity."
    );
  }
  return {
    attempt: row.attempts,
    attemptId: attemptId(row.attempt_id),
    claimedBy: row.claimed_by,
    claimToken: row.claim_token,
    effectAdapterKey: row.effect_adapter_key,
    eventId: eventId(row.event_id),
    runId: runId(row.run_id),
    startKey: row.start_key,
    stepRunId: stepRunId(row.step_run_id),
    workspaceId: workspaceId(row.workspace_id),
  };
};

const makeLeafEffectRecovery = (sql: postgres.Sql): LeafEffectRecoveryPort => ({
  claimNextForSystem: async (input) => {
    const claimToken = randomUUID();
    const rows = await sql<readonly LeafEffectRecoveryRow[]>`
      WITH candidate AS (
        SELECT job.workspace_id, job.attempt_id
        FROM kurobara_core.step_leaf_effect_recovery_jobs AS job
        JOIN kurobara_core.step_leaf_execution_bindings AS binding
          ON binding.workspace_id = job.workspace_id
          AND binding.attempt_id = job.attempt_id
        JOIN kurobara_core.step_attempts AS attempt
          ON attempt.workspace_id = binding.workspace_id
          AND attempt.step_run_id = binding.step_run_id
          AND attempt.attempt_id = binding.attempt_id
        JOIN kurobara_core.outbox_messages AS message
          ON message.workspace_id = binding.workspace_id
          AND message.message_id = binding.outbox_message_id
        WHERE job.effect_adapter_key = ${input.effectAdapterKey}
          AND job.state IN ('pending', 'retry', 'claimed')
          AND job.attempts < job.max_attempts
          AND job.next_attempt_at <= clock_timestamp()
          AND (
            job.state <> 'claimed'
            OR job.claimed_until <= clock_timestamp()
          )
          AND binding.state = 'started'
          AND binding.effect_adapter_key = job.effect_adapter_key
          AND message.state = 'dispatched'
          AND attempt.state IN ('claimed', 'in_flight', 'ambiguous')
        ORDER BY job.next_attempt_at, job.updated_at,
          job.workspace_id, job.attempt_id
        FOR UPDATE OF job, binding, attempt, message SKIP LOCKED
        LIMIT 1
      ), claimed AS (
        UPDATE kurobara_core.step_leaf_effect_recovery_jobs AS job
        SET
          state = 'claimed',
          claimed_by = ${input.claimedBy},
          claim_token = ${claimToken},
          claimed_until = clock_timestamp()
            + (${input.leaseMilliseconds} * interval '1 millisecond'),
          attempts = attempts + 1,
          updated_at = clock_timestamp()
        FROM candidate
        WHERE job.workspace_id = candidate.workspace_id
          AND job.attempt_id = candidate.attempt_id
        RETURNING job.*
      )
      SELECT
        claimed.workspace_id,
        claimed.attempt_id,
        claimed.effect_adapter_key,
        claimed.attempts,
        claimed.claimed_by,
        claimed.claim_token,
        binding.run_id,
        binding.step_run_id,
        binding.event_id,
        binding.start_key
      FROM claimed
      JOIN kurobara_core.step_leaf_execution_bindings AS binding
        ON binding.workspace_id = claimed.workspace_id
        AND binding.attempt_id = claimed.attempt_id
    `;
    return rows[0] === undefined
      ? undefined
      : parseLeafEffectRecoveryRow(rows[0]);
  },
  complete: async (input) => {
    const rows = await sql<readonly { attempt_id: string }[]>`
      UPDATE kurobara_core.step_leaf_effect_recovery_jobs AS job
      SET
        state = 'completed',
        claimed_by = NULL,
        claim_token = NULL,
        claimed_until = NULL,
        last_error = NULL,
        finished_at = clock_timestamp(),
        updated_at = clock_timestamp()
      FROM kurobara_core.step_attempts AS attempt
      WHERE job.workspace_id = ${input.scope.workspaceId}
        AND job.attempt_id = ${input.attemptId}
        AND job.effect_adapter_key = ${input.effectAdapterKey}
        AND job.state = 'claimed'
        AND job.claimed_by = ${input.claimedBy}
        AND job.claim_token = ${input.claimToken}
        AND job.claimed_until > clock_timestamp()
        AND attempt.workspace_id = job.workspace_id
        AND attempt.attempt_id = job.attempt_id
        AND attempt.state IN (
          'succeeded',
          'failed_retryable',
          'failed_terminal',
          'cancelled_before_effect'
        )
      RETURNING job.attempt_id
    `;
    return { status: rows.length === 0 ? "claim-lost" : "settled" };
  },
  reapForSystem: async (input) => {
    const result = await sql.begin(async (transaction) => {
      const transactionSql = transaction as unknown as postgres.Sql;
      const completed = await transactionSql<readonly { attempt_id: string }[]>`
        WITH candidate AS (
          SELECT job.workspace_id, job.attempt_id
          FROM kurobara_core.step_leaf_effect_recovery_jobs AS job
          JOIN kurobara_core.step_attempts AS attempt
            ON attempt.workspace_id = job.workspace_id
            AND attempt.attempt_id = job.attempt_id
          WHERE job.effect_adapter_key = ${input.effectAdapterKey}
            AND job.state IN ('pending', 'retry', 'claimed', 'exhausted')
            AND (
              job.state <> 'claimed'
              OR job.claimed_until <= clock_timestamp()
            )
            AND attempt.state IN (
              'succeeded',
              'failed_retryable',
              'failed_terminal',
              'cancelled_before_effect'
            )
          ORDER BY job.updated_at, job.workspace_id, job.attempt_id
          FOR UPDATE OF job, attempt SKIP LOCKED
          LIMIT 100
        )
        UPDATE kurobara_core.step_leaf_effect_recovery_jobs AS job
        SET
          state = 'completed',
          claimed_by = NULL,
          claim_token = NULL,
          claimed_until = NULL,
          last_error = CASE
            WHEN job.state = 'exhausted' THEN job.last_error
            ELSE NULL
          END,
          finished_at = clock_timestamp(),
          updated_at = clock_timestamp()
        FROM candidate
        WHERE job.workspace_id = candidate.workspace_id
          AND job.attempt_id = candidate.attempt_id
        RETURNING job.attempt_id
      `;
      const exhausted = await transactionSql<readonly { attempt_id: string }[]>`
        WITH candidate AS (
          SELECT job.workspace_id, job.attempt_id
          FROM kurobara_core.step_leaf_effect_recovery_jobs AS job
          JOIN kurobara_core.step_attempts AS attempt
            ON attempt.workspace_id = job.workspace_id
            AND attempt.attempt_id = job.attempt_id
          WHERE job.effect_adapter_key = ${input.effectAdapterKey}
            AND job.state IN ('pending', 'retry', 'claimed')
            AND job.attempts >= job.max_attempts
            AND (
              job.state <> 'claimed'
              OR job.claimed_until <= clock_timestamp()
            )
            AND attempt.state IN ('claimed', 'in_flight', 'ambiguous')
          ORDER BY job.attempts DESC, job.updated_at,
            job.workspace_id, job.attempt_id
          FOR UPDATE OF job, attempt SKIP LOCKED
          LIMIT 100
        )
        UPDATE kurobara_core.step_leaf_effect_recovery_jobs AS job
        SET
          state = 'exhausted',
          claimed_by = NULL,
          claim_token = NULL,
          claimed_until = NULL,
          last_error = 'leaf-effect-recovery-attempts-exhausted',
          finished_at = clock_timestamp(),
          updated_at = clock_timestamp()
        FROM candidate
        WHERE job.workspace_id = candidate.workspace_id
          AND job.attempt_id = candidate.attempt_id
        RETURNING job.attempt_id
      `;
      return { completed: completed.length, exhausted: exhausted.length };
    });
    return result as unknown as Readonly<{
      completed: number;
      exhausted: number;
    }>;
  },
  release: async (input) => {
    const rows = await sql<readonly { attempt_id: string }[]>`
      UPDATE kurobara_core.step_leaf_effect_recovery_jobs AS job
      SET
        state = CASE
          WHEN attempts >= max_attempts THEN 'exhausted'
          ELSE 'retry'
        END,
        claimed_by = NULL,
        claim_token = NULL,
        claimed_until = NULL,
        next_attempt_at = clock_timestamp()
          + (${input.retryDelayMilliseconds} * interval '1 millisecond'),
        last_error = ${input.reason},
        finished_at = CASE
          WHEN attempts >= max_attempts THEN clock_timestamp()
          ELSE NULL
        END,
        updated_at = clock_timestamp()
      FROM kurobara_core.step_attempts AS attempt
      WHERE job.workspace_id = ${input.scope.workspaceId}
        AND job.attempt_id = ${input.attemptId}
        AND job.effect_adapter_key = ${input.effectAdapterKey}
        AND job.state = 'claimed'
        AND job.claimed_by = ${input.claimedBy}
        AND job.claim_token = ${input.claimToken}
        AND job.claimed_until > clock_timestamp()
        AND attempt.workspace_id = job.workspace_id
        AND attempt.attempt_id = job.attempt_id
        AND attempt.state IN ('claimed', 'in_flight', 'ambiguous')
      RETURNING job.attempt_id
    `;
    return { status: rows.length === 0 ? "claim-lost" : "settled" };
  },
});

const parseOrchestrationReconciliationRow = (
  row: OrchestrationReconciliationRow
): OrchestrationReconciliationClaim => {
  const event = parseRunQueued(row.event);
  if (
    event.eventId !== row.event_id ||
    event.runId !== row.run_id ||
    event.workspaceId !== row.workspace_id ||
    row.adapter_key.length === 0 ||
    row.reconciliation_claim_token.length === 0 ||
    row.reconciliation_claimed_by.length === 0 ||
    row.start_key.length === 0
  ) {
    throw new PostgresAdapterError(
      "database-identity-mismatch",
      "The orchestration reconciliation row has inconsistent identity."
    );
  }
  return {
    adapterKey: row.adapter_key,
    claimedBy: row.reconciliation_claimed_by,
    claimToken: row.reconciliation_claim_token,
    eventId: event.eventId,
    messageId: outboxMessageId(row.message_id),
    runId: event.runId,
    startKey: row.start_key,
    workspaceId: event.workspaceId,
  };
};

const makeOrchestrationReconciliation = (
  sql: postgres.Sql
): OrchestrationReconciliationPort => ({
  claimNextForSystem: async (input) => {
    const claimToken = randomUUID();
    const rows = await sql<readonly OrchestrationReconciliationRow[]>`
      WITH candidate AS (
        SELECT binding.workspace_id, binding.run_id
        FROM kurobara_core.run_orchestration_bindings AS binding
        JOIN kurobara_core.outbox_messages AS message
          ON message.workspace_id = binding.workspace_id
          AND message.message_id = binding.outbox_message_id
        WHERE binding.adapter_key = ${input.adapterKey}
          AND binding.state IN ('starting', 'reconciliation_required')
          AND binding.reconciliation_attempts < ${input.maxAttempts}
          AND binding.next_reconciliation_at <= clock_timestamp()
          AND (
            binding.reconciliation_claimed_until IS NULL
            OR binding.reconciliation_claimed_until <= clock_timestamp()
          )
          AND (
            message.state <> 'claimed'
            OR message.claimed_until <= clock_timestamp()
          )
        ORDER BY
          binding.next_reconciliation_at,
          binding.updated_at,
          binding.created_at,
          binding.workspace_id,
          binding.run_id
        FOR UPDATE OF binding, message SKIP LOCKED
        LIMIT 1
      ), claimed AS (
        UPDATE kurobara_core.run_orchestration_bindings AS binding
        SET
          reconciliation_claimed_by = ${input.claimedBy},
          reconciliation_claim_token = ${claimToken},
          reconciliation_claimed_until = clock_timestamp()
            + (${input.leaseMilliseconds} * interval '1 millisecond'),
          reconciliation_attempts = reconciliation_attempts + 1,
          updated_at = clock_timestamp()
        FROM candidate
        WHERE binding.workspace_id = candidate.workspace_id
          AND binding.run_id = candidate.run_id
        RETURNING binding.*
      )
      SELECT
        claimed.workspace_id,
        claimed.run_id,
        claimed.outbox_message_id AS message_id,
        claimed.start_key,
        claimed.adapter_key,
        claimed.reconciliation_claimed_by,
        claimed.reconciliation_claim_token,
        message.event_id,
        message.event
      FROM claimed
      JOIN kurobara_core.outbox_messages AS message
        ON message.workspace_id = claimed.workspace_id
        AND message.message_id = claimed.outbox_message_id
      ORDER BY claimed.updated_at, claimed.created_at
    `;
    const row = rows[0];
    return row === undefined
      ? undefined
      : parseOrchestrationReconciliationRow(row);
  },
  confirm: async (input) => {
    const settled = await sql.begin(async (transaction) => {
      const transactionSql = transaction as unknown as postgres.Sql;
      const updated = await transactionSql<readonly { run_id: string }[]>`
        UPDATE kurobara_core.run_orchestration_bindings
        SET
          state = 'started',
          orchestration_run_id = ${input.orchestrationRunId},
          reconciliation_claimed_by = NULL,
          reconciliation_claim_token = NULL,
          reconciliation_claimed_until = NULL,
          last_reconciliation_error = NULL,
          updated_at = clock_timestamp()
        WHERE workspace_id = ${input.scope.workspaceId}
          AND outbox_message_id = ${input.messageId}
          AND adapter_key = ${input.adapterKey}
          AND state IN ('starting', 'reconciliation_required')
          AND reconciliation_claimed_by = ${input.claimedBy}
          AND reconciliation_claim_token = ${input.claimToken}
          AND reconciliation_claimed_until > clock_timestamp()
        RETURNING run_id
      `;
      if (updated.length === 0) {
        const existing = await transactionSql<
          readonly {
            adapter_key: string | null;
            orchestration_run_id: string | null;
            state: string;
          }[]
        >`
          SELECT state, adapter_key, orchestration_run_id
          FROM kurobara_core.run_orchestration_bindings
          WHERE workspace_id = ${input.scope.workspaceId}
            AND outbox_message_id = ${input.messageId}
          FOR UPDATE
        `;
        const binding = existing[0];
        if (
          binding?.state !== "started" ||
          binding.adapter_key !== input.adapterKey ||
          binding.orchestration_run_id !== input.orchestrationRunId
        ) {
          return false;
        }
      }

      await transactionSql`
        UPDATE kurobara_core.outbox_messages
        SET
          state = 'dispatched',
          claimed_by = NULL,
          claim_token = NULL,
          claimed_until = NULL,
          orchestration_run_id = ${input.orchestrationRunId},
          dispatched_at = COALESCE(dispatched_at, clock_timestamp()),
          last_error = NULL,
          updated_at = clock_timestamp()
        WHERE workspace_id = ${input.scope.workspaceId}
          AND message_id = ${input.messageId}
          AND (
            state <> 'claimed'
            OR claimed_until <= clock_timestamp()
          )
      `;
      return true;
    });
    return { status: settled ? "settled" : "claim-lost" };
  },
  reapExhaustedForSystem: async (input) => {
    const rows = await sql<readonly { reaped: number }[]>`
      WITH exhausted_candidate AS (
        SELECT binding.workspace_id, binding.run_id
        FROM kurobara_core.run_orchestration_bindings AS binding
        JOIN kurobara_core.outbox_messages AS message
          ON message.workspace_id = binding.workspace_id
          AND message.message_id = binding.outbox_message_id
        WHERE binding.adapter_key = ${input.adapterKey}
          AND binding.state IN ('starting', 'reconciliation_required')
          AND binding.reconciliation_attempts >= ${input.maxAttempts}
          AND (
            binding.reconciliation_claimed_until IS NULL
            OR binding.reconciliation_claimed_until <= clock_timestamp()
          )
          AND (
            message.state <> 'claimed'
            OR message.claimed_until <= clock_timestamp()
          )
        ORDER BY
          binding.reconciliation_attempts DESC,
          binding.reconciliation_claimed_until NULLS FIRST,
          binding.updated_at,
          binding.created_at,
          binding.workspace_id,
          binding.run_id
        FOR UPDATE OF binding, message SKIP LOCKED
        LIMIT 100
      ), exhausted AS (
        UPDATE kurobara_core.run_orchestration_bindings AS binding
        SET
          state = 'reconciliation_exhausted',
          reconciliation_claimed_by = NULL,
          reconciliation_claim_token = NULL,
          reconciliation_claimed_until = NULL,
          last_reconciliation_error = ${RECONCILIATION_ATTEMPTS_EXHAUSTED},
          updated_at = clock_timestamp()
        FROM exhausted_candidate
        WHERE binding.workspace_id = exhausted_candidate.workspace_id
          AND binding.run_id = exhausted_candidate.run_id
        RETURNING binding.workspace_id, binding.outbox_message_id
      ), exhausted_messages AS (
        UPDATE kurobara_core.outbox_messages AS message
        SET
          state = 'dead_letter',
          claimed_by = NULL,
          claim_token = NULL,
          claimed_until = NULL,
          last_error = ${RECONCILIATION_ATTEMPTS_EXHAUSTED},
          updated_at = clock_timestamp()
        FROM exhausted
        WHERE message.workspace_id = exhausted.workspace_id
          AND message.message_id = exhausted.outbox_message_id
        RETURNING message.message_id
      )
      SELECT count(*)::integer AS reaped FROM exhausted_messages
    `;
    return rows[0]?.reaped ?? 0;
  },
  release: async (input) => {
    const settled = await sql.begin(async (transaction) => {
      const transactionSql = transaction as unknown as postgres.Sql;
      const rows = await transactionSql<readonly { exhausted: boolean }[]>`
        UPDATE kurobara_core.run_orchestration_bindings
        SET
          state = CASE
            WHEN reconciliation_attempts >= ${input.maxAttempts}
              THEN 'reconciliation_exhausted'
            ELSE 'reconciliation_required'
          END,
          reconciliation_claimed_by = NULL,
          reconciliation_claim_token = NULL,
          reconciliation_claimed_until = NULL,
          next_reconciliation_at = clock_timestamp()
            + (${input.retryDelayMilliseconds} * interval '1 millisecond'),
          last_reconciliation_error = ${input.reason},
          updated_at = clock_timestamp()
        WHERE workspace_id = ${input.scope.workspaceId}
          AND outbox_message_id = ${input.messageId}
          AND adapter_key = ${input.adapterKey}
          AND state IN ('starting', 'reconciliation_required')
          AND reconciliation_claimed_by = ${input.claimedBy}
          AND reconciliation_claim_token = ${input.claimToken}
          AND reconciliation_claimed_until > clock_timestamp()
        RETURNING state = 'reconciliation_exhausted' AS exhausted
      `;
      const row = rows[0];
      if (row === undefined) {
        return false;
      }
      if (row.exhausted) {
        await transactionSql`
          UPDATE kurobara_core.outbox_messages
          SET
            state = 'dead_letter',
            claimed_by = NULL,
            claim_token = NULL,
            claimed_until = NULL,
            last_error = ${input.reason},
            updated_at = clock_timestamp()
          WHERE workspace_id = ${input.scope.workspaceId}
            AND message_id = ${input.messageId}
            AND (
              state <> 'claimed'
              OR claimed_until <= clock_timestamp()
            )
        `;
      }
      return true;
    });
    return { status: settled ? "settled" : "claim-lost" };
  },
});

const makeRunQueries = (sql: postgres.Sql): RunQueryPort => ({
  get: async (scope, requestedRunId) => {
    const rows = await sql<readonly RunSnapshotRow[]>`
      SELECT stored_run.run, stored_run.cost
      FROM kurobara_core.runs AS stored_run
      WHERE stored_run.workspace_id = ${scope.workspaceId}
        AND stored_run.run_id = ${requestedRunId}
      LIMIT 1
    `;
    const row = rows[0];
    if (row === undefined) {
      return;
    }

    const run = parseRun(row.run);
    if (run.workspaceId !== scope.workspaceId || run.runId !== requestedRunId) {
      throw new PostgresAdapterError(
        "database-identity-mismatch",
        "The stored run snapshot does not match its database key."
      );
    }

    return {
      cost: parseRunCostSnapshot(row.cost),
      run,
    };
  },
});

const requestDagSchedule = async (
  transactionSql: postgres.Sql,
  scope: WorkspaceScope,
  operationScope: WorkspaceScope,
  requestedRunId: import("@kurobara/kernel").RunId
): Promise<void> => {
  assertScope(scope, operationScope);
  const locked = await transactionSql<readonly { run_id: string }[]>`
    SELECT run_id
    FROM kurobara_core.runs
    WHERE workspace_id = ${scope.workspaceId}
      AND run_id = ${requestedRunId}
    FOR UPDATE
  `;
  if (locked.length === 0) {
    throw new PostgresAdapterError(
      "database-identity-mismatch",
      "The DAG schedule request targets a missing run."
    );
  }
  await transactionSql`
    INSERT INTO kurobara_core.run_dag_schedule_jobs (
      workspace_id,
      run_id,
      pending,
      requested_at,
      processed_at,
      last_outcome,
      blocked_reason,
      evaluated_at
    ) VALUES (
      ${scope.workspaceId},
      ${requestedRunId},
      true,
      clock_timestamp(),
      NULL,
      NULL,
      NULL,
      NULL
    )
    ON CONFLICT (workspace_id, run_id) DO UPDATE SET
      pending = true,
      requested_at = clock_timestamp(),
      processed_at = NULL,
      last_outcome = NULL,
      blocked_reason = NULL,
      evaluated_at = NULL
  `;
};

const requestStepRouting = async (
  transactionSql: postgres.Sql,
  scope: WorkspaceScope,
  operationScope: WorkspaceScope,
  requestedStepRunId: import("@kurobara/kernel").StepRunId
): Promise<void> => {
  assertScope(scope, operationScope);
  const identities = await transactionSql<readonly { run_id: string }[]>`
    SELECT run_id
    FROM kurobara_core.step_runs
    WHERE workspace_id = ${scope.workspaceId}
      AND step_run_id = ${requestedStepRunId}
  `;
  const identity = identities[0];
  if (identity === undefined) {
    throw new PostgresAdapterError(
      "database-identity-mismatch",
      "The routing request targets a missing step."
    );
  }

  const lockedRuns = await transactionSql<readonly { run_id: string }[]>`
    SELECT run_id
    FROM kurobara_core.runs
    WHERE workspace_id = ${scope.workspaceId}
      AND run_id = ${identity.run_id}
    FOR UPDATE
  `;
  if (lockedRuns.length === 0) {
    throw new PostgresAdapterError(
      "database-identity-mismatch",
      "The routing request targets a step without a durable run."
    );
  }

  const lockedSteps = await transactionSql<readonly { step_run_id: string }[]>`
    SELECT step_run_id
    FROM kurobara_core.step_runs
    WHERE workspace_id = ${scope.workspaceId}
      AND run_id = ${identity.run_id}
      AND step_run_id = ${requestedStepRunId}
    FOR UPDATE
  `;
  if (lockedSteps.length === 0) {
    throw new PostgresAdapterError(
      "database-identity-mismatch",
      "The routing step identity changed while acquiring its locks."
    );
  }

  await transactionSql`
    INSERT INTO kurobara_core.step_routing_jobs (
      workspace_id,
      run_id,
      step_run_id,
      pending,
      attempts,
      requested_at,
      next_attempt_at,
      last_error,
      processed_at
    ) VALUES (
      ${scope.workspaceId},
      ${identity.run_id},
      ${requestedStepRunId},
      true,
      0,
      clock_timestamp(),
      clock_timestamp(),
      NULL,
      NULL
    )
    ON CONFLICT (workspace_id, step_run_id) DO UPDATE SET
      run_id = excluded.run_id,
      pending = true,
      attempts = CASE
        WHEN kurobara_core.step_routing_jobs.pending
          THEN kurobara_core.step_routing_jobs.attempts
        ELSE 0
      END,
      requested_at = CASE
        WHEN kurobara_core.step_routing_jobs.pending
          THEN kurobara_core.step_routing_jobs.requested_at
        ELSE clock_timestamp()
      END,
      next_attempt_at = CASE
        WHEN kurobara_core.step_routing_jobs.pending
          THEN kurobara_core.step_routing_jobs.next_attempt_at
        ELSE clock_timestamp()
      END,
      last_error = CASE
        WHEN kurobara_core.step_routing_jobs.pending
          THEN kurobara_core.step_routing_jobs.last_error
        ELSE NULL
      END,
      processed_at = NULL,
      updated_at = clock_timestamp()
  `;
};

const makeRunExecutionUnitOfWork = (
  transactionSql: postgres.Sql,
  scope: WorkspaceScope
): RunExecutionUnitOfWork => {
  const recipeUnitOfWork = createPostgresRecipeUnitOfWork(
    transactionSql,
    scope
  );
  return {
    cellResults: {
      getByRun: recipeUnitOfWork.cellResults.getByRun,
      markRunning: recipeUnitOfWork.runExecution.markRunning,
    },
    commandJournal: {
      find: async (operationScope, requestedRunId, commandKey) => {
        assertScope(scope, operationScope);
        const rows = await transactionSql<readonly RunCommandProofRow[]>`
              SELECT proof
              FROM kurobara_core.run_command_journal
              WHERE workspace_id = ${scope.workspaceId}
                AND run_id = ${requestedRunId}
                AND command_idempotency_key = ${commandKey}
            `;
        const row = rows[0];
        return row === undefined
          ? undefined
          : parseRunCommandReplayProof(row.proof);
      },
      insert: async (
        operationScope,
        proof,
        commandActorId,
        commandCorrelationId
      ) => {
        assertScope(scope, operationScope);
        if (
          proof.workspaceId !== scope.workspaceId ||
          proof.runId.toString().length === 0
        ) {
          throw new PostgresAdapterError(
            "workspace-scope-mismatch",
            "The command proof belongs to another workspace."
          );
        }
        await transactionSql`
              INSERT INTO kurobara_core.run_command_journal (
                workspace_id,
                run_id,
                command_idempotency_key,
                command_hash,
                command_type,
                actor_id,
                correlation_id,
                proof
              ) VALUES (
                ${scope.workspaceId},
                ${proof.runId},
                ${proof.identity.idempotencyKey},
                ${proof.identity.commandHash},
                ${proof.commandType},
                ${commandActorId},
                ${commandCorrelationId},
                ${transactionSql.json(toJsonValue(proof))}
              )
            `;
      },
    },
    dagSchedule: {
      request: (operationScope, requestedRunId) =>
        requestDagSchedule(
          transactionSql,
          scope,
          operationScope,
          requestedRunId
        ),
    },
    runEvents: {
      append: async (operationScope, event: RunLifecycleEvent) => {
        assertScope(scope, operationScope);
        if (event.workspaceId !== scope.workspaceId) {
          throw new PostgresAdapterError(
            "workspace-scope-mismatch",
            "The lifecycle event belongs to another workspace."
          );
        }
        await transactionSql`
              INSERT INTO kurobara_core.run_events (
                workspace_id,
                run_id,
                sequence,
                event_id,
                event,
                occurred_at
              ) VALUES (
                ${scope.workspaceId},
                ${event.runId},
                ${event.sequence},
                ${event.eventId},
                ${transactionSql.json(toJsonValue(event))},
                ${new Date(event.occurredAt)}
              )
            `;
      },
    },
    runs: {
      getForUpdate: async (operationScope, requestedRunId) => {
        assertScope(scope, operationScope);
        const rows = await transactionSql<readonly RunExecutionRow[]>`
              SELECT run
              FROM kurobara_core.runs
              WHERE workspace_id = ${scope.workspaceId}
                AND run_id = ${requestedRunId}
              FOR UPDATE
            `;
        const row = rows[0];
        if (row === undefined) {
          return;
        }
        const run = parseRun(row.run);
        if (
          run.workspaceId !== scope.workspaceId ||
          run.runId !== requestedRunId
        ) {
          throw new PostgresAdapterError(
            "database-identity-mismatch",
            "The run execution identity does not match its database key."
          );
        }
        return run;
      },
      update: async (operationScope, expectedAggregateVersion, run) => {
        assertScope(scope, operationScope);
        if (run.workspaceId !== scope.workspaceId) {
          throw new PostgresAdapterError(
            "workspace-scope-mismatch",
            "The updated run belongs to another workspace."
          );
        }
        const rows = await transactionSql<readonly { run_id: string }[]>`
              UPDATE kurobara_core.runs
              SET run = ${transactionSql.json(toJsonValue(run))}
              WHERE workspace_id = ${scope.workspaceId}
                AND run_id = ${run.runId}
                AND (run ->> 'aggregateVersion')::integer = ${expectedAggregateVersion}
              RETURNING run_id
            `;
        if (rows.length === 0) {
          throw new RunAggregateConflictError(run.runId);
        }
      },
    },
  };
};

const makeRunExecution = (sql: postgres.Sql): RunExecutionPersistencePort => ({
  transaction: async (scope, work) => {
    const result = await sql.begin((transaction) => {
      const transactionSql = transaction as unknown as postgres.Sql;
      return work(makeRunExecutionUnitOfWork(transactionSql, scope));
    });
    return result as unknown as Awaited<ReturnType<typeof work>>;
  },
});

const reservationMatches = (
  existing: CostReservation,
  requested: CostReservation
): boolean =>
  existing.workspaceId === requested.workspaceId &&
  existing.runId === requested.runId &&
  existing.attemptId === requested.attemptId &&
  existing.reservationId === requested.reservationId &&
  existing.operationKey === requested.operationKey &&
  existing.stepRunId === requested.stepRunId &&
  existing.unit === requested.unit &&
  existing.amount === requested.amount;

const lockReservationIdentities = async (
  transactionSql: postgres.Sql,
  scope: WorkspaceScope,
  reservation: CostReservation
): Promise<void> => {
  const lockKeys = [
    ["cost-reservation", scope.workspaceId, reservation.reservationId].join(
      "\u001f"
    ),
    ["step-attempt", scope.workspaceId, reservation.attemptId].join("\u001f"),
  ].sort();
  for (const lockKey of lockKeys) {
    await transactionSql`
      SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0::bigint))
    `;
  }
};

const findReservation = async (
  transactionSql: postgres.Sql,
  scope: WorkspaceScope,
  reservation: CostReservation
): Promise<CostReservationResult | undefined> => {
  const rows = await transactionSql<readonly CostReservationRow[]>`
    SELECT reservation
    FROM kurobara_core.cost_reservations
    WHERE workspace_id = ${scope.workspaceId}
      AND (
        reservation_id = ${reservation.reservationId}
        OR attempt_id = ${reservation.attemptId}
      )
    FOR UPDATE
  `;
  if (rows.length === 0) {
    return;
  }
  const existing = rows.map((row) => parseCostReservation(row.reservation));
  const exact = existing[0];
  if (
    existing.length !== 1 ||
    exact === undefined ||
    !reservationMatches(exact, reservation)
  ) {
    return { status: "conflict" };
  }
  return { reservation: exact, status: "existing" };
};

const loadReservationBudget = async (
  transactionSql: postgres.Sql,
  scope: WorkspaceScope,
  reservation: CostReservation
): Promise<
  Readonly<{ cost: RunCostSnapshot; fits: boolean; plan: RunPlan }>
> => {
  const rows = await transactionSql<
    readonly { cost: unknown; fits: boolean; plan: unknown }[]
  >`
    SELECT
      stored_run.cost,
      stored_plan.plan,
      (
        (stored_run.cost ->> 'spent')::numeric
        + (stored_run.cost ->> 'reserved')::numeric
        + ${reservation.amount}::numeric
        <= (stored_plan.plan #>> '{budget,limit}')::numeric
      ) AS fits
    FROM kurobara_core.runs AS stored_run
    JOIN kurobara_core.run_plans AS stored_plan
      ON stored_plan.workspace_id = stored_run.workspace_id
      AND stored_plan.run_plan_id = stored_run.run_plan_id
    WHERE stored_run.workspace_id = ${scope.workspaceId}
      AND stored_run.run_id = ${reservation.runId}
    FOR UPDATE OF stored_run, stored_plan
  `;
  const row = rows[0];
  if (row === undefined) {
    throw new PostgresAdapterError(
      "database-identity-mismatch",
      "The reservation run or immutable plan is missing."
    );
  }
  return {
    cost: parseRunCostSnapshot(row.cost),
    fits: row.fits,
    plan: parseRunPlan(row.plan),
  };
};

const fitsReservationBudget = (
  cost: RunCostSnapshot,
  plan: RunPlan,
  reservation: CostReservation,
  fits: boolean
): boolean => {
  if (cost.unit !== reservation.unit || plan.budget.unit !== reservation.unit) {
    return false;
  }
  return (
    isAmount(cost.spent) &&
    isAmount(cost.reserved) &&
    isAmount(reservation.amount) &&
    isAmount(plan.budget.limit) &&
    fits
  );
};

const bindStepOperation = async (
  transactionSql: postgres.Sql,
  scope: WorkspaceScope,
  reservation: CostReservation
): Promise<boolean> => {
  await transactionSql`
    INSERT INTO kurobara_core.step_operation_bindings (
      workspace_id,
      run_id,
      operation_key,
      step_run_id
    ) VALUES (
      ${scope.workspaceId},
      ${reservation.runId},
      ${reservation.operationKey},
      ${reservation.stepRunId}
    )
    ON CONFLICT DO NOTHING
  `;
  const rows = await transactionSql<readonly { step_run_id: string }[]>`
    SELECT step_run_id
    FROM kurobara_core.step_operation_bindings
    WHERE workspace_id = ${scope.workspaceId}
      AND run_id = ${reservation.runId}
      AND operation_key = ${reservation.operationKey}
    FOR UPDATE
  `;
  return rows[0]?.step_run_id === reservation.stepRunId;
};

const persistReservation = async (
  transactionSql: postgres.Sql,
  scope: WorkspaceScope,
  reservation: CostReservation
): Promise<CostReservationResult> => {
  const inserted = await transactionSql<readonly { reservation_id: string }[]>`
    INSERT INTO kurobara_core.cost_reservations (
      workspace_id,
      reservation_id,
      attempt_id,
      step_run_id,
      run_id,
      operation_key,
      unit,
      amount,
      state,
      reservation,
      created_at
    ) VALUES (
      ${scope.workspaceId},
      ${reservation.reservationId},
      ${reservation.attemptId},
      ${reservation.stepRunId},
      ${reservation.runId},
      ${reservation.operationKey},
      ${reservation.unit},
      ${reservation.amount},
      ${reservation.state},
      ${transactionSql.json(toJsonValue(reservation))},
      ${new Date(reservation.createdAt)}
    )
    ON CONFLICT DO NOTHING
    RETURNING reservation_id
  `;
  if (inserted.length === 0) {
    throw new PostgresAdapterError(
      "cost-reservation-conflict",
      "The reservation identity changed during its locked transaction."
    );
  }
  const updated = await transactionSql<readonly { run_id: string }[]>`
    UPDATE kurobara_core.runs
    SET cost = jsonb_set(
      cost,
      '{reserved}',
      to_jsonb(
        ((cost ->> 'reserved')::numeric + ${reservation.amount}::numeric)::numeric
      ),
      true
    )
    WHERE workspace_id = ${scope.workspaceId}
      AND run_id = ${reservation.runId}
    RETURNING run_id
  `;
  if (updated.length === 0) {
    throw new PostgresAdapterError(
      "database-identity-mismatch",
      "The reservation run disappeared during its transaction."
    );
  }
  return { reservation, status: "created" };
};

const reserveStepCost = async (
  transactionSql: postgres.Sql,
  scope: WorkspaceScope,
  operationScope: WorkspaceScope,
  reservation: CostReservation
): Promise<CostReservationResult> => {
  assertScope(scope, operationScope);
  if (reservation.workspaceId !== scope.workspaceId) {
    throw new PostgresAdapterError(
      "workspace-scope-mismatch",
      "The cost reservation belongs to another workspace."
    );
  }
  await lockReservationIdentities(transactionSql, scope, reservation);
  const existing = await findReservation(transactionSql, scope, reservation);
  if (existing !== undefined) {
    return existing;
  }
  const { cost, fits, plan } = await loadReservationBudget(
    transactionSql,
    scope,
    reservation
  );
  if (!fitsReservationBudget(cost, plan, reservation, fits)) {
    return { status: "budget-exceeded" };
  }
  if (!(await bindStepOperation(transactionSql, scope, reservation))) {
    return { status: "conflict" };
  }
  return persistReservation(transactionSql, scope, reservation);
};

const loadRunPlanInput = async (
  transactionSql: postgres.Sql,
  scope: WorkspaceScope,
  plan: RunPlan
): Promise<ValidatedRunInput | undefined> => {
  const rows = await transactionSql<readonly RunPlanInputRow[]>`
    SELECT
      workspace_id,
      run_plan_id,
      input_id,
      content_hash,
      contract,
      normalized_payload,
      classification,
      media_type,
      size_bytes,
      validator_version,
      validated_at,
      finalized_at
    FROM kurobara_core.run_plan_inputs
    WHERE workspace_id = ${scope.workspaceId}
      AND run_plan_id = ${plan.runPlanId}
  `;
  const row = rows[0];
  if (row === undefined) {
    return;
  }
  const runInput = parseRunPlanInputRow(row);
  if (
    rows.length !== 1 ||
    row.workspace_id !== scope.workspaceId ||
    row.run_plan_id !== plan.runPlanId ||
    runInput.contentHash !== plan.normalizedInputHash ||
    JSON.stringify(toJsonValue(runInput.contract)) !==
      JSON.stringify(toJsonValue(plan.inputContract))
  ) {
    throw new PostgresAdapterError(
      "database-identity-mismatch",
      "The normalized run input does not match its workspace or immutable plan."
    );
  }
  return runInput;
};

const loadStepExecutionContext = async (
  transactionSql: postgres.Sql,
  scope: WorkspaceScope,
  operationScope: WorkspaceScope,
  requestedRunId: import("@kurobara/kernel").RunId,
  nodeKey: string
): Promise<StepExecutionContext | undefined> => {
  assertScope(scope, operationScope);
  const contextRows = await transactionSql<readonly StepContextRow[]>`
    SELECT stored_run.run, stored_plan.plan
    FROM kurobara_core.runs AS stored_run
    JOIN kurobara_core.run_plans AS stored_plan
      ON stored_plan.workspace_id = stored_run.workspace_id
      AND stored_plan.run_plan_id = stored_run.run_plan_id
    WHERE stored_run.workspace_id = ${scope.workspaceId}
      AND stored_run.run_id = ${requestedRunId}
    FOR UPDATE OF stored_run, stored_plan
  `;
  const contextRow = contextRows[0];
  if (contextRow === undefined) {
    return;
  }
  const run = parseRun(contextRow.run);
  const plan = parseRunPlan(contextRow.plan);
  const contextIdentityMatches =
    run.workspaceId === scope.workspaceId &&
    run.runId === requestedRunId &&
    plan.workspaceId === scope.workspaceId &&
    plan.runPlanId === run.runPlanId;
  if (!contextIdentityMatches) {
    throw new PostgresAdapterError(
      "database-identity-mismatch",
      "The step execution context does not match its database keys."
    );
  }
  // The parent run and immutable plan are locked before the optional immutable
  // input child is read. The child is never locked, preserving the established
  // run -> plan -> steps ordering for every writer.
  const runInput = await loadRunPlanInput(transactionSql, scope, plan);
  const stepRows = await transactionSql<readonly StepRunRow[]>`
    SELECT step_run
    FROM kurobara_core.step_runs
    WHERE workspace_id = ${scope.workspaceId}
      AND run_id = ${requestedRunId}
      AND node_key = ${nodeKey}
    FOR UPDATE
  `;
  const stepRun =
    stepRows[0] === undefined ? undefined : parseStepRun(stepRows[0].step_run);
  const stepIdentityMatches =
    stepRun === undefined ||
    (stepRun.workspaceId === scope.workspaceId &&
      stepRun.runId === requestedRunId &&
      stepRun.nodeKey === nodeKey);
  if (!stepIdentityMatches) {
    throw new PostgresAdapterError(
      "database-identity-mismatch",
      "The stored step aggregate does not match its database key."
    );
  }
  const succeeded = await transactionSql<readonly { node_key: string }[]>`
    SELECT node_key
    FROM kurobara_core.step_runs
    WHERE workspace_id = ${scope.workspaceId}
      AND run_id = ${requestedRunId}
      AND state = 'succeeded'
    ORDER BY node_key
  `;
  return {
    plan,
    run,
    ...(runInput === undefined ? {} : { runInput }),
    ...(stepRun === undefined ? {} : { stepRun }),
    succeededNodeKeys: succeeded.map((row) => row.node_key),
  };
};

const loadStepExecutionContextById = async (
  transactionSql: postgres.Sql,
  scope: WorkspaceScope,
  operationScope: WorkspaceScope,
  requestedStepRunId: import("@kurobara/kernel").StepRunId
): Promise<StepExecutionContext | undefined> => {
  assertScope(scope, operationScope);
  const identities = await transactionSql<
    readonly { node_key: string; run_id: string }[]
  >`
    SELECT node_key, run_id
    FROM kurobara_core.step_runs
    WHERE workspace_id = ${scope.workspaceId}
      AND step_run_id = ${requestedStepRunId}
  `;
  const identity = identities[0];
  if (identity === undefined) {
    return;
  }
  const context = await loadStepExecutionContext(
    transactionSql,
    scope,
    operationScope,
    runId(identity.run_id),
    identity.node_key
  );
  if (context?.stepRun?.stepRunId !== requestedStepRunId) {
    throw new PostgresAdapterError(
      "database-identity-mismatch",
      "The step execution identity changed while acquiring its locks."
    );
  }
  return context;
};

const reservationMatchesRelease = (
  reservation: CostReservation,
  input: CostReservationRelease
): boolean =>
  reservation.workspaceId === input.workspaceId &&
  reservation.runId === input.runId &&
  reservation.attemptId === input.attemptId &&
  reservation.reservationId === input.reservationId &&
  reservation.operationKey === input.operationKey &&
  reservation.unit === input.unit &&
  reservation.amount === input.amount;

const reservationMatchesUsage = (
  reservation: CostReservation,
  usage: UsageEntry
): boolean =>
  reservation.workspaceId === usage.workspaceId &&
  reservation.runId === usage.runId &&
  reservation.attemptId === usage.attemptId &&
  reservation.reservationId === usage.reservationId &&
  reservation.operationKey === usage.operationKey &&
  reservation.unit === usage.unit;

const usageMatches = (existing: UsageEntry, requested: UsageEntry): boolean =>
  existing.workspaceId === requested.workspaceId &&
  existing.runId === requested.runId &&
  existing.attemptId === requested.attemptId &&
  existing.reservationId === requested.reservationId &&
  existing.operationKey === requested.operationKey &&
  existing.usageEntryId === requested.usageEntryId &&
  existing.unit === requested.unit &&
  existing.amount === requested.amount &&
  existing.reconciliationProofId === requested.reconciliationProofId;

const getReservationForSettlement = async (
  transactionSql: postgres.Sql,
  scope: WorkspaceScope,
  reservationId: import("@kurobara/kernel").CostReservationId
): Promise<CostReservation | undefined> => {
  const rows = await transactionSql<readonly CostReservationRow[]>`
    SELECT reservation
    FROM kurobara_core.cost_reservations
    WHERE workspace_id = ${scope.workspaceId}
      AND reservation_id = ${reservationId}
    FOR UPDATE
  `;
  return rows[0] === undefined
    ? undefined
    : parseCostReservation(rows[0].reservation);
};

const updateRunCostAfterReservation = async (
  transactionSql: postgres.Sql,
  scope: WorkspaceScope,
  reservation: CostReservation,
  spentDelta: number
): Promise<void> => {
  const rows = await transactionSql<readonly { run_id: string }[]>`
    UPDATE kurobara_core.runs
    SET cost = jsonb_set(
      jsonb_set(
        cost,
        '{reserved}',
        to_jsonb(((cost ->> 'reserved')::numeric - ${reservation.amount})::numeric),
        true
      ),
      '{spent}',
      to_jsonb(((cost ->> 'spent')::numeric + ${spentDelta})::numeric),
      true
    )
    WHERE workspace_id = ${scope.workspaceId}
      AND run_id = ${reservation.runId}
      AND cost ->> 'unit' = ${reservation.unit}
      AND (cost ->> 'reserved')::numeric >= ${reservation.amount}
    RETURNING run_id
  `;
  if (rows.length === 0) {
    throw new PostgresAdapterError(
      "cost-ledger-invariant-violation",
      "The run cost snapshot cannot apply this reservation movement."
    );
  }
};

const releaseStepCost = async (
  transactionSql: postgres.Sql,
  scope: WorkspaceScope,
  operationScope: WorkspaceScope,
  input: CostReservationRelease
): Promise<CostReservationReleaseResult> => {
  assertScope(scope, operationScope);
  if (input.workspaceId !== scope.workspaceId) {
    throw new PostgresAdapterError(
      "workspace-scope-mismatch",
      "The reservation release belongs to another workspace."
    );
  }
  const reservation = await getReservationForSettlement(
    transactionSql,
    scope,
    input.reservationId
  );
  if (
    reservation === undefined ||
    !isAmount(input.amount) ||
    !reservationMatchesRelease(reservation, input) ||
    reservation.state === "settled"
  ) {
    return { status: "conflict" };
  }
  if (reservation.state === "released") {
    return { reservation, status: "existing" };
  }
  const released: CostReservation = {
    ...reservation,
    releasedAt: input.releasedAt,
    state: "released",
  };
  await updateRunCostAfterReservation(transactionSql, scope, reservation, 0);
  await transactionSql`
    UPDATE kurobara_core.cost_reservations
    SET
      state = 'released',
      reservation = ${transactionSql.json(toJsonValue(released))}
    WHERE workspace_id = ${scope.workspaceId}
      AND reservation_id = ${reservation.reservationId}
      AND state = 'reserved'
  `;
  return { reservation: released, status: "released" };
};

const findUsageForSettlement = async (
  transactionSql: postgres.Sql,
  scope: WorkspaceScope,
  usage: UsageEntry
): Promise<UsageEntry | undefined> => {
  const rows = await transactionSql<readonly UsageEntryRow[]>`
    SELECT entry
    FROM kurobara_core.usage_ledger_entries
    WHERE workspace_id = ${scope.workspaceId}
      AND (
        usage_entry_id = ${usage.usageEntryId}
        OR reservation_id = ${usage.reservationId}
      )
    FOR UPDATE
  `;
  if (rows.length === 0) {
    return;
  }
  const entries = rows.map((row) => parseUsageEntry(row.entry));
  const exact = entries[0];
  return entries.length === 1 && exact !== undefined ? exact : undefined;
};

const settleStepCost = async (
  transactionSql: postgres.Sql,
  scope: WorkspaceScope,
  operationScope: WorkspaceScope,
  usage: UsageEntry
): Promise<CostReservationSettlementResult> => {
  assertScope(scope, operationScope);
  if (usage.workspaceId !== scope.workspaceId) {
    throw new PostgresAdapterError(
      "workspace-scope-mismatch",
      "The usage entry belongs to another workspace."
    );
  }
  const reservation = await getReservationForSettlement(
    transactionSql,
    scope,
    usage.reservationId
  );
  if (
    reservation === undefined ||
    !isAmount(usage.amount) ||
    !reservationMatchesUsage(reservation, usage) ||
    reservation.state === "released"
  ) {
    return { status: "conflict" };
  }
  if (usage.amount > reservation.amount) {
    return { status: "amount-exceeded" };
  }
  const existingUsage = await findUsageForSettlement(
    transactionSql,
    scope,
    usage
  );
  if (reservation.state === "settled") {
    return existingUsage !== undefined && usageMatches(existingUsage, usage)
      ? { reservation, status: "existing", usage: existingUsage }
      : { status: "conflict" };
  }
  if (existingUsage !== undefined) {
    return { status: "conflict" };
  }
  const settled: CostReservation = {
    ...reservation,
    releasedAmount: reservation.amount - usage.amount,
    settledAmount: usage.amount,
    settledAt: usage.recordedAt,
    state: "settled",
    usageEntryId: usage.usageEntryId,
  };
  await transactionSql`
    INSERT INTO kurobara_core.usage_ledger_entries (
      workspace_id,
      usage_entry_id,
      run_id,
      attempt_id,
      reservation_id,
      operation_key,
      unit,
      amount,
      entry,
      recorded_at
    ) VALUES (
      ${scope.workspaceId},
      ${usage.usageEntryId},
      ${usage.runId},
      ${usage.attemptId},
      ${usage.reservationId},
      ${usage.operationKey},
      ${usage.unit},
      ${usage.amount},
      ${transactionSql.json(toJsonValue(usage))},
      ${new Date(usage.recordedAt)}
    )
  `;
  await updateRunCostAfterReservation(
    transactionSql,
    scope,
    reservation,
    usage.amount
  );
  await transactionSql`
    UPDATE kurobara_core.cost_reservations
    SET
      state = 'settled',
      reservation = ${transactionSql.json(toJsonValue(settled))}
    WHERE workspace_id = ${scope.workspaceId}
      AND reservation_id = ${reservation.reservationId}
      AND state = 'reserved'
  `;
  return { reservation: settled, status: "settled", usage };
};

const parseOutputArtifactRow = (
  row: OutputArtifactRow
): Readonly<{ artifact: Artifact; value: NormalizedJsonValue }> => {
  const artifact = parseArtifact(row.artifact);
  const value = parseNormalizedJsonValue(
    row.normalized_payload,
    "outputArtifact.normalizedPayload"
  );
  const evidence = normalizedJsonEvidence(value);
  const relationalContract = parseContractRef(
    row.contract,
    "outputArtifact.contract"
  );
  const relationalSize = Number(row.size_bytes);
  if (
    artifact.workspaceId !== row.workspace_id ||
    artifact.runId !== row.run_id ||
    artifact.stepRunId !== row.step_run_id ||
    artifact.attemptId !== row.attempt_id ||
    artifact.operationKey !== row.operation_key ||
    artifact.artifactId !== row.artifact_id ||
    artifact.contentHash !== row.content_hash ||
    artifact.contentHash !== evidence.contentHash ||
    artifact.classification !== row.classification ||
    artifact.kind !== row.kind ||
    artifact.mediaType !== row.media_type ||
    artifact.retentionPolicy !== row.retention_policy ||
    artifact.state !== row.state ||
    artifact.finalizedAt !== row.finalized_at.getTime() ||
    artifact.validatedAt !== row.validated_at.getTime() ||
    artifact.validatorVersion !== row.validator_version ||
    !Number.isSafeInteger(relationalSize) ||
    artifact.sizeBytes !== relationalSize ||
    artifact.sizeBytes !== evidence.sizeBytes ||
    artifact.contract.catalogVersion !== relationalContract.catalogVersion ||
    artifact.contract.catalogFingerprint !==
      relationalContract.catalogFingerprint ||
    artifact.contract.schemaId !== relationalContract.schemaId ||
    artifact.contract.schemaVersion !== relationalContract.schemaVersion ||
    artifact.contract.schemaFingerprint !== relationalContract.schemaFingerprint
  ) {
    throw new PostgresAdapterError(
      "database-identity-mismatch",
      "An output artifact does not match its relational identity or canonical payload evidence."
    );
  }
  return { artifact, value };
};

const insertOutputArtifact = async (
  transactionSql: postgres.Sql,
  scope: WorkspaceScope,
  operationScope: WorkspaceScope,
  artifact: Artifact,
  value: NormalizedJsonValue
): Promise<void> => {
  assertScope(scope, operationScope);
  const parsedArtifact = parseArtifact(toJsonValue(artifact));
  const parsedValue = parseNormalizedJsonValue(
    toJsonValue(value),
    "outputArtifact.normalizedPayload"
  );
  const evidence = normalizedJsonEvidence(parsedValue);
  if (
    parsedArtifact.workspaceId !== scope.workspaceId ||
    parsedArtifact.contentHash !== evidence.contentHash ||
    parsedArtifact.sizeBytes !== evidence.sizeBytes ||
    parsedArtifact.sizeBytes > 65_536
  ) {
    throw new PostgresAdapterError(
      "database-identity-mismatch",
      "The output artifact does not match its workspace or canonical payload evidence."
    );
  }
  const inserted = await transactionSql<readonly { artifact_id: string }[]>`
    INSERT INTO kurobara_core.run_output_artifacts (
      workspace_id,
      artifact_id,
      run_id,
      step_run_id,
      attempt_id,
      operation_key,
      content_hash,
      contract,
      normalized_payload,
      classification,
      kind,
      media_type,
      retention_policy,
      size_bytes,
      state,
      validator_version,
      validated_at,
      artifact,
      finalized_at
    ) VALUES (
      ${scope.workspaceId},
      ${parsedArtifact.artifactId},
      ${parsedArtifact.runId},
      ${parsedArtifact.stepRunId},
      ${parsedArtifact.attemptId},
      ${parsedArtifact.operationKey},
      ${parsedArtifact.contentHash},
      ${transactionSql.json(toJsonValue(parsedArtifact.contract))},
      ${transactionSql.json(toJsonValue(parsedValue))},
      ${parsedArtifact.classification},
      ${parsedArtifact.kind},
      ${parsedArtifact.mediaType},
      ${parsedArtifact.retentionPolicy},
      ${parsedArtifact.sizeBytes},
      ${parsedArtifact.state},
      ${parsedArtifact.validatorVersion},
      ${new Date(parsedArtifact.validatedAt)},
      ${transactionSql.json(toJsonValue(parsedArtifact))},
      ${new Date(parsedArtifact.finalizedAt)}
    )
    ON CONFLICT DO NOTHING
    RETURNING artifact_id
  `;
  if (inserted.length > 0) {
    return;
  }
  const rows = await transactionSql<readonly OutputArtifactRow[]>`
      SELECT
        workspace_id,
        artifact_id,
        run_id,
        step_run_id,
        attempt_id,
        operation_key,
        content_hash,
        contract,
        normalized_payload,
        classification,
        kind,
        media_type,
        retention_policy,
        size_bytes,
        state,
        validator_version,
        validated_at,
        artifact,
        finalized_at
      FROM kurobara_core.run_output_artifacts
      WHERE workspace_id = ${scope.workspaceId}
        AND (
          artifact_id = ${parsedArtifact.artifactId}
          OR attempt_id = ${parsedArtifact.attemptId}
      )
      FOR UPDATE
    `;
  const existing = rows[0];
  if (rows.length !== 1 || existing === undefined) {
    throw new ImmutableRecordConflictError("output artifact");
  }
  const parsedExisting = parseOutputArtifactRow(existing);
  if (
    JSON.stringify(toJsonValue(parsedExisting.artifact)) !==
      JSON.stringify(toJsonValue(parsedArtifact)) ||
    serializeArtifactValue(parsedExisting.value) !==
      serializeArtifactValue(parsedValue)
  ) {
    throw new ImmutableRecordConflictError("output artifact");
  }
};

const serializeArtifactValue = (value: NormalizedJsonValue): string =>
  serializeCanonicalJson(value);

const makeStepExecutionUnitOfWork = (
  transactionSql: postgres.Sql,
  scope: WorkspaceScope
): StepExecutionUnitOfWork => ({
  artifacts: {
    insert: (operationScope, artifact, value) =>
      insertOutputArtifact(
        transactionSql,
        scope,
        operationScope,
        artifact,
        value
      ),
  },
  attempts: {
    insert: async (operationScope, attempt) => {
      assertScope(scope, operationScope);
      const parsedAttempt = parseAttempt(attempt);
      if (parsedAttempt.stepRunId !== attempt.stepRunId) {
        throw new PostgresAdapterError(
          "database-identity-mismatch",
          "The step attempt identity changed during validation."
        );
      }
      await transactionSql`
              INSERT INTO kurobara_core.step_attempts (
                workspace_id,
                attempt_id,
                step_run_id,
                attempt_number,
                operation_key,
                reservation_id,
                route_key,
                effect_adapter_key,
                routing_decision_id,
                route_snapshot_hash,
                state,
                attempt,
                created_at
              ) VALUES (
                ${scope.workspaceId},
                ${attempt.attemptId},
                ${attempt.stepRunId},
                ${attempt.attemptNumber},
                ${attempt.operationKey},
                ${attempt.costReservationId},
                ${attempt.routeKey},
                ${attempt.effectAdapterKey},
                ${attempt.routingDecisionId},
                ${attempt.routeSnapshotHash},
                ${attempt.state},
                ${transactionSql.json(toJsonValue(attempt))},
                ${new Date(attempt.preparedAt)}
              )
            `;
    },
    update: async (operationScope, expectedState, attempt) => {
      assertScope(scope, operationScope);
      const parsedAttempt = parseAttempt(attempt);
      if (parsedAttempt.attemptId !== attempt.attemptId) {
        throw new PostgresAdapterError(
          "database-identity-mismatch",
          "The step attempt identity changed during validation."
        );
      }
      if (expectedState === "claimed" && attempt.state === "in_flight") {
        const bindings = await transactionSql<
          readonly { attempt_id: string }[]
        >`
                UPDATE kurobara_core.step_leaf_execution_bindings AS binding
                SET updated_at = binding.updated_at
                FROM kurobara_core.outbox_messages AS message
                WHERE binding.workspace_id = ${scope.workspaceId}
                  AND binding.step_run_id = ${attempt.stepRunId}
                  AND binding.attempt_id = ${attempt.attemptId}
                  AND message.workspace_id = binding.workspace_id
                  AND message.message_id = binding.outbox_message_id
                  AND (
                    binding.state IN (
                      'starting', 'started', 'reconciliation_required'
                    )
                    OR (
                      binding.state = 'pending'
                      AND message.state = 'pending'
                    )
                  )
                RETURNING binding.attempt_id
              `;
        if (bindings.length === 0) {
          throw new PostgresAdapterError(
            "step-attempt-conflict",
            `Attempt ${attempt.attemptId} has no active leaf execution binding.`
          );
        }
      }
      const rows = await transactionSql<readonly { attempt_id: string }[]>`
              UPDATE kurobara_core.step_attempts
              SET
                state = ${attempt.state},
                route_key = ${attempt.routeKey},
                effect_adapter_key = ${attempt.effectAdapterKey},
                routing_decision_id = ${attempt.routingDecisionId},
                route_snapshot_hash = ${attempt.routeSnapshotHash},
                attempt = ${transactionSql.json(toJsonValue(attempt))}
              WHERE workspace_id = ${scope.workspaceId}
                AND attempt_id = ${attempt.attemptId}
                AND step_run_id = ${attempt.stepRunId}
                AND state = ${expectedState}
              RETURNING attempt_id
            `;
      if (rows.length === 0) {
        throw new PostgresAdapterError(
          "step-attempt-conflict",
          `Attempt ${attempt.attemptId} no longer has the expected state.`
        );
      }
    },
  },
  commandJournal: {
    find: async (operationScope, requestedStepRunId, commandKey) => {
      assertScope(scope, operationScope);
      const rows = await transactionSql<readonly StepCommandProofRow[]>`
              SELECT proof
              FROM kurobara_core.step_command_journal
              WHERE workspace_id = ${scope.workspaceId}
                AND step_run_id = ${requestedStepRunId}
                AND command_idempotency_key = ${commandKey}
            `;
      const row = rows[0];
      return row === undefined
        ? undefined
        : parseStepCommandReplayProof(row.proof);
    },
    insert: async (
      operationScope,
      proof,
      commandActorId,
      commandCorrelationId
    ) => {
      assertScope(scope, operationScope);
      if (proof.workspaceId !== scope.workspaceId) {
        throw new PostgresAdapterError(
          "workspace-scope-mismatch",
          "The step command proof belongs to another workspace."
        );
      }
      await transactionSql`
              INSERT INTO kurobara_core.step_command_journal (
                workspace_id,
                step_run_id,
                command_idempotency_key,
                command_hash,
                command_type,
                actor_id,
                correlation_id,
                proof
              ) VALUES (
                ${scope.workspaceId},
                ${proof.stepRunId},
                ${proof.identity.idempotencyKey},
                ${proof.identity.commandHash},
                ${proof.commandType},
                ${commandActorId},
                ${commandCorrelationId},
                ${transactionSql.json(toJsonValue(proof))}
              )
            `;
    },
  },
  dagSchedule: {
    request: (operationScope, requestedRunId) =>
      requestDagSchedule(transactionSql, scope, operationScope, requestedRunId),
  },
  leafOutbox: {
    append: (operationScope, message) =>
      appendLeafOutbox(transactionSql, scope, operationScope, message),
  },
  parentEffects: createPostgresDatasetGenerationParentEffects(
    transactionSql,
    scope
  ),
  reservations: {
    release: (operationScope, input) =>
      releaseStepCost(transactionSql, scope, operationScope, input),
    reserve: (operationScope, reservation) =>
      reserveStepCost(transactionSql, scope, operationScope, reservation),
    settle: (operationScope, usage) =>
      settleStepCost(transactionSql, scope, operationScope, usage),
  },
  routingDecisions: {
    insert: async (operationScope, decision: RoutingDecision) => {
      assertScope(scope, operationScope);
      const parsed = parseRoutingDecision(decision);
      if (
        parsed.workspaceId !== scope.workspaceId ||
        parsed.routingDecisionId !== decision.routingDecisionId ||
        parsed.stepRunId !== decision.stepRunId ||
        parsed.runId !== decision.runId
      ) {
        throw new PostgresAdapterError(
          "database-identity-mismatch",
          "The routing decision does not match its durable identity."
        );
      }
      const rows = await transactionSql<
        readonly { routing_decision_id: string }[]
      >`
              INSERT INTO kurobara_core.routing_decisions (
                workspace_id,
                routing_decision_id,
                run_id,
                step_run_id,
                route_key,
                effect_adapter_key,
                route_snapshot_hash,
                reservation_unit,
                reserved_amount,
                policy_version,
                policy_facts_hash,
                pricing_version,
                decision,
                decided_at
              ) VALUES (
                ${scope.workspaceId},
                ${decision.routingDecisionId},
                ${decision.runId},
                ${decision.stepRunId},
                ${decision.routeKey},
                ${decision.effectAdapterKey},
                ${decision.routeSnapshotHash},
                ${decision.reservationUnit},
                ${decision.reservedAmount},
                ${decision.policyVersion},
                ${decision.policyFactsHash},
                ${decision.pricingVersion},
                ${transactionSql.json(toJsonValue(decision))},
                ${new Date(decision.decidedAt)}
              )
              ON CONFLICT (workspace_id, routing_decision_id) DO NOTHING
              RETURNING routing_decision_id
            `;
      if (rows.length > 0) {
        return;
      }
      const exact = await transactionSql<
        readonly { routing_decision_id: string }[]
      >`
              SELECT routing_decision_id
              FROM kurobara_core.routing_decisions
              WHERE workspace_id = ${scope.workspaceId}
                AND routing_decision_id = ${decision.routingDecisionId}
                AND run_id = ${decision.runId}
                AND step_run_id = ${decision.stepRunId}
                AND route_key = ${decision.routeKey}
                AND effect_adapter_key = ${decision.effectAdapterKey}
                AND route_snapshot_hash = ${decision.routeSnapshotHash}
                AND reservation_unit = ${decision.reservationUnit}
                AND reserved_amount = ${decision.reservedAmount}
                AND policy_version = ${decision.policyVersion}
                AND policy_facts_hash = ${decision.policyFactsHash}
                AND pricing_version = ${decision.pricingVersion}
                AND decision = ${transactionSql.json(toJsonValue(decision))}
                AND decided_at = ${new Date(decision.decidedAt)}
            `;
      if (exact.length === 0) {
        throw new ImmutableRecordConflictError("routing decision");
      }
    },
  },
  stepEvents: {
    append: async (operationScope, event: StepLifecycleEvent) => {
      assertScope(scope, operationScope);
      if (event.workspaceId !== scope.workspaceId) {
        throw new PostgresAdapterError(
          "workspace-scope-mismatch",
          "The step event belongs to another workspace."
        );
      }
      await transactionSql`
              INSERT INTO kurobara_core.step_events (
                workspace_id,
                step_run_id,
                sequence,
                event_id,
                event,
                occurred_at
              ) VALUES (
                ${scope.workspaceId},
                ${event.stepRunId},
                ${event.sequence},
                ${event.eventId},
                ${transactionSql.json(toJsonValue(event))},
                ${new Date(event.occurredAt)}
              )
            `;
    },
  },
  stepRouting: {
    request: (operationScope, requestedStepRunId) =>
      requestStepRouting(
        transactionSql,
        scope,
        operationScope,
        requestedStepRunId
      ),
  },
  steps: {
    getContextByStepIdForUpdate: (operationScope, requestedStepRunId) =>
      loadStepExecutionContextById(
        transactionSql,
        scope,
        operationScope,
        requestedStepRunId
      ),
    getContextForUpdate: (operationScope, requestedRunId, nodeKey) =>
      loadStepExecutionContext(
        transactionSql,
        scope,
        operationScope,
        requestedRunId,
        nodeKey
      ),
    insert: async (operationScope, stepRun) => {
      assertScope(scope, operationScope);
      const parsedStep = parseStepRun(stepRun);
      if (
        parsedStep.workspaceId !== scope.workspaceId ||
        parsedStep.stepRunId !== stepRun.stepRunId
      ) {
        throw new PostgresAdapterError(
          "workspace-scope-mismatch",
          "The inserted step belongs to another workspace."
        );
      }
      await transactionSql`
              INSERT INTO kurobara_core.step_runs (
                workspace_id,
                step_run_id,
                run_id,
                node_key,
                state,
                aggregate_version,
                event_sequence,
                step_run,
                created_at
              ) VALUES (
                ${scope.workspaceId},
                ${stepRun.stepRunId},
                ${stepRun.runId},
                ${stepRun.nodeKey},
                ${stepRun.state},
                ${stepRun.aggregateVersion},
                ${stepRun.eventSequence},
                ${transactionSql.json(toJsonValue(stepRun))},
                ${new Date(stepRun.createdAt)}
              )
            `;
    },
    update: async (operationScope, expectedAggregateVersion, stepRun) => {
      assertScope(scope, operationScope);
      if (stepRun.workspaceId !== scope.workspaceId) {
        throw new PostgresAdapterError(
          "workspace-scope-mismatch",
          "The updated step belongs to another workspace."
        );
      }
      const rows = await transactionSql<readonly { step_run_id: string }[]>`
              UPDATE kurobara_core.step_runs
              SET
                state = ${stepRun.state},
                aggregate_version = ${stepRun.aggregateVersion},
                event_sequence = ${stepRun.eventSequence},
                step_run = ${transactionSql.json(toJsonValue(stepRun))},
                updated_at = clock_timestamp()
              WHERE workspace_id = ${scope.workspaceId}
                AND step_run_id = ${stepRun.stepRunId}
                AND aggregate_version = ${expectedAggregateVersion}
              RETURNING step_run_id
            `;
      if (rows.length === 0) {
        throw new PostgresAdapterError(
          "step-aggregate-conflict",
          `Step ${stepRun.stepRunId} no longer has the expected aggregate version.`
        );
      }
    },
  },
});

const makeStepExecution = (
  sql: postgres.Sql
): StepExecutionPersistencePort => ({
  transaction: async (scope, work) => {
    const result = await sql.begin((transaction) => {
      const transactionSql = transaction as unknown as postgres.Sql;
      return work(makeStepExecutionUnitOfWork(transactionSql, scope));
    });
    return result as unknown as Awaited<ReturnType<typeof work>>;
  },
});

const dagSchedulingIdentityMatches = (
  context: DagSchedulingContext,
  stepRun: StepRun,
  event: Extract<StepLifecycleEvent, { eventType: "StepReady" }>
): boolean => {
  const node = context.plan.compiledWorkflow.nodes.find(
    (candidate) => candidate.key === stepRun.nodeKey
  );
  const dependenciesMatch =
    node !== undefined &&
    node.dependsOn.length === stepRun.dependsOn.length &&
    node.dependsOn.every(
      (dependency, index) => dependency === stepRun.dependsOn[index]
    );
  return (
    context.run.state === "running" &&
    stepRun.workspaceId === context.run.workspaceId &&
    stepRun.runId === context.run.runId &&
    stepRun.state === "ready" &&
    stepRun.aggregateVersion === 1 &&
    stepRun.eventSequence === 1 &&
    stepRun.attempts.length === 0 &&
    stepRun.activeAttemptId === undefined &&
    dependenciesMatch &&
    event.workspaceId === stepRun.workspaceId &&
    event.runId === stepRun.runId &&
    event.stepRunId === stepRun.stepRunId &&
    event.nodeKey === stepRun.nodeKey &&
    event.sequence === 1 &&
    event.eventVersion === 1 &&
    event.occurredAt === stepRun.createdAt
  );
};

const dagSchedulingSkippedIdentityMatches = (
  context: DagSchedulingContext,
  knownStepsByNodeKey: ReadonlyMap<string, StepRun>,
  stepRun: StepRun,
  event: Extract<StepLifecycleEvent, { eventType: "StepSkipped" }>
): boolean => {
  const node = context.plan.compiledWorkflow.nodes.find(
    (candidate) => candidate.key === stepRun.nodeKey
  );
  const dependenciesMatch =
    node !== undefined &&
    node.dependsOn.length === stepRun.dependsOn.length &&
    node.dependsOn.every(
      (dependency, index) => dependency === stepRun.dependsOn[index]
    );
  const blockedByAreTerminalDependencies =
    event.blockedByNodeKeys.length > 0 &&
    event.blockedByNodeKeys.every((blockedNodeKey) => {
      if (!stepRun.dependsOn.includes(blockedNodeKey)) {
        return false;
      }
      const dependency = knownStepsByNodeKey.get(blockedNodeKey);
      return dependency?.state === "failed" || dependency?.state === "skipped";
    });
  return (
    context.run.state === "running" &&
    stepRun.workspaceId === context.run.workspaceId &&
    stepRun.runId === context.run.runId &&
    stepRun.state === "skipped" &&
    stepRun.aggregateVersion === 1 &&
    stepRun.eventSequence === 1 &&
    stepRun.attempts.length === 0 &&
    stepRun.activeAttemptId === undefined &&
    dependenciesMatch &&
    blockedByAreTerminalDependencies &&
    event.workspaceId === stepRun.workspaceId &&
    event.runId === stepRun.runId &&
    event.stepRunId === stepRun.stepRunId &&
    event.sequence === 1 &&
    event.eventVersion === 1 &&
    event.occurredAt === stepRun.createdAt
  );
};

const parseDagSchedulingRun = (
  candidate: DagSchedulingRunIdentityRow
): import("@kurobara/kernel").Run => {
  const storedRun = parseRun(candidate.run);
  if (
    storedRun.workspaceId !== candidate.workspace_id ||
    storedRun.runId !== candidate.run_id ||
    storedRun.runPlanId !== candidate.run_plan_id
  ) {
    throw new PostgresAdapterError(
      "database-identity-mismatch",
      "The DAG scheduling run does not match its database keys."
    );
  }
  return storedRun;
};

const loadDagSchedulingPlan = async (
  transactionSql: postgres.Sql,
  candidate: DagSchedulingRunIdentityRow,
  storedRun: import("@kurobara/kernel").Run
): Promise<RunPlan> => {
  const plans = await transactionSql<readonly { plan: unknown }[]>`
    SELECT plan
    FROM kurobara_core.run_plans
    WHERE workspace_id = ${candidate.workspace_id}
      AND run_plan_id = ${candidate.run_plan_id}
  `;
  const planRow = plans[0];
  if (planRow === undefined) {
    throw new PostgresAdapterError(
      "database-identity-mismatch",
      "The DAG scheduling run has no immutable plan."
    );
  }
  const plan = parseRunPlan(planRow.plan);
  if (
    plan.workspaceId !== storedRun.workspaceId ||
    plan.runPlanId !== storedRun.runPlanId
  ) {
    throw new PostgresAdapterError(
      "database-identity-mismatch",
      "The DAG scheduling plan does not match its run."
    );
  }
  return plan;
};

const loadDagSchedulingSteps = async (
  transactionSql: postgres.Sql,
  candidate: DagSchedulingRunIdentityRow,
  storedRun: import("@kurobara/kernel").Run,
  plan: RunPlan
): Promise<readonly StepRun[]> => {
  const rows = await transactionSql<readonly DagSchedulingStepRow[]>`
    SELECT
      step_run_id,
      node_key,
      state,
      aggregate_version,
      event_sequence,
      step_run
    FROM kurobara_core.step_runs
    WHERE workspace_id = ${candidate.workspace_id}
      AND run_id = ${candidate.run_id}
    ORDER BY node_key
    FOR UPDATE
  `;
  return rows.map((row) => {
    const stepRun = parseStepRun(row.step_run);
    const node = plan.compiledWorkflow.nodes.find(
      (candidateNode) => candidateNode.key === stepRun.nodeKey
    );
    const dependenciesMatch =
      node !== undefined &&
      node.dependsOn.length === stepRun.dependsOn.length &&
      node.dependsOn.every(
        (dependency, index) => dependency === stepRun.dependsOn[index]
      );
    if (
      stepRun.workspaceId !== storedRun.workspaceId ||
      stepRun.runId !== storedRun.runId ||
      stepRun.stepRunId !== row.step_run_id ||
      stepRun.nodeKey !== row.node_key ||
      stepRun.state !== row.state ||
      stepRun.aggregateVersion !== row.aggregate_version ||
      stepRun.eventSequence !== row.event_sequence ||
      !dependenciesMatch
    ) {
      throw new PostgresAdapterError(
        "database-identity-mismatch",
        "A DAG scheduling step does not match its relational keys or immutable plan."
      );
    }
    return stepRun;
  });
};

const attemptsAreEqual = (left: Attempt, right: Attempt): boolean =>
  left.attemptId === right.attemptId &&
  left.attemptNumber === right.attemptNumber &&
  left.authorityEnvelopeId === right.authorityEnvelopeId &&
  left.claimedAt === right.claimedAt &&
  left.costReservationId === right.costReservationId &&
  left.effectAdapterKey === right.effectAdapterKey &&
  left.operationKey === right.operationKey &&
  left.preparedAt === right.preparedAt &&
  left.reason === right.reason &&
  amountsEqual(left.reservedAmount, right.reservedAmount) &&
  left.reservationUnit === right.reservationUnit &&
  left.routeKey === right.routeKey &&
  left.routeSnapshotHash === right.routeSnapshotHash &&
  left.routingDecisionId === right.routingDecisionId &&
  left.state === right.state &&
  left.stepRunId === right.stepRunId &&
  left.effectStartedAt === right.effectStartedAt &&
  left.ambiguityObservedAt === right.ambiguityObservedAt &&
  left.finishedAt === right.finishedAt &&
  ((left.output === undefined && right.output === undefined) ||
    (left.output !== undefined &&
      right.output !== undefined &&
      JSON.stringify(toJsonValue(left.output)) ===
        JSON.stringify(toJsonValue(right.output))));

const loadDagSchedulingAttemptProof = async (
  transactionSql: postgres.Sql,
  candidate: DagSchedulingRunIdentityRow,
  stepRuns: readonly StepRun[]
): Promise<void> => {
  // Parent run and step rows are already locked; child attempt rows are read
  // without locks to preserve the single run -> steps -> job lock order.
  const rows = await transactionSql<readonly DagSchedulingAttemptRow[]>`
    SELECT
      attempt.workspace_id,
      attempt.step_run_id,
      attempt.attempt_id,
      attempt.attempt_number,
      attempt.operation_key,
      attempt.reservation_id,
      attempt.route_key,
      attempt.effect_adapter_key,
      attempt.routing_decision_id,
      attempt.route_snapshot_hash,
      attempt.state,
      attempt.attempt,
      attempt.created_at
    FROM kurobara_core.step_attempts AS attempt
    JOIN kurobara_core.step_runs AS step
      ON step.workspace_id = attempt.workspace_id
      AND step.step_run_id = attempt.step_run_id
    WHERE step.workspace_id = ${candidate.workspace_id}
      AND step.run_id = ${candidate.run_id}
    ORDER BY step.node_key, attempt.attempt_number, attempt.attempt_id
  `;
  const rowsByStep = new Map<string, DagSchedulingAttemptRow[]>();
  for (const row of rows) {
    const existing = rowsByStep.get(row.step_run_id) ?? [];
    existing.push(row);
    rowsByStep.set(row.step_run_id, existing);
  }
  for (const stepRun of stepRuns) {
    const attemptRows = rowsByStep.get(stepRun.stepRunId) ?? [];
    if (attemptRows.length !== stepRun.attempts.length) {
      throw new PostgresAdapterError(
        "database-identity-mismatch",
        "A DAG convergence step does not match its relational attempt count."
      );
    }
    for (const [index, row] of attemptRows.entries()) {
      const relationalAttempt = parseAttempt(row.attempt);
      const aggregateAttempt = stepRun.attempts[index];
      if (
        aggregateAttempt === undefined ||
        row.workspace_id !== candidate.workspace_id ||
        row.step_run_id !== stepRun.stepRunId ||
        row.attempt_number !== index + 1 ||
        relationalAttempt.attemptId !== row.attempt_id ||
        relationalAttempt.stepRunId !== row.step_run_id ||
        relationalAttempt.attemptNumber !== row.attempt_number ||
        relationalAttempt.operationKey !== row.operation_key ||
        relationalAttempt.costReservationId !== row.reservation_id ||
        relationalAttempt.routeKey !== row.route_key ||
        relationalAttempt.effectAdapterKey !== row.effect_adapter_key ||
        relationalAttempt.routingDecisionId !== row.routing_decision_id ||
        relationalAttempt.routeSnapshotHash !== row.route_snapshot_hash ||
        relationalAttempt.state !== row.state ||
        relationalAttempt.preparedAt !== row.created_at.getTime() ||
        !attemptsAreEqual(relationalAttempt, aggregateAttempt)
      ) {
        throw new PostgresAdapterError(
          "database-identity-mismatch",
          "A DAG convergence attempt does not match its relational row or parent aggregate."
        );
      }
    }
    rowsByStep.delete(stepRun.stepRunId);
  }
  if (rowsByStep.size !== 0) {
    throw new PostgresAdapterError(
      "database-identity-mismatch",
      "The DAG convergence attempt proof contains an unknown step identity."
    );
  }
};

const outputRefMatchesArtifact = (
  attempt: Attempt,
  artifact: Artifact
): boolean =>
  attempt.output?.artifact.artifactId === artifact.artifactId &&
  attempt.output.artifact.contentHash === artifact.contentHash &&
  attempt.output.validatedAt === artifact.validatedAt &&
  attempt.output.validatorVersion === artifact.validatorVersion &&
  JSON.stringify(toJsonValue(attempt.output.contract)) ===
    JSON.stringify(toJsonValue(artifact.contract));

const loadDagSchedulingArtifactProof = async (
  transactionSql: postgres.Sql,
  candidate: DagSchedulingRunIdentityRow,
  storedRun: import("@kurobara/kernel").Run,
  stepRuns: readonly StepRun[]
): Promise<
  Readonly<{
    artifactPayloads: NonNullable<DagSchedulingContext["artifactPayloads"]>;
    artifacts: readonly Artifact[];
  }>
> => {
  // The run and all step aggregates are already locked. Artifact rows are
  // immutable children and can be read without introducing another lock order.
  const rows = await transactionSql<readonly OutputArtifactRow[]>`
    SELECT
      workspace_id,
      artifact_id,
      run_id,
      step_run_id,
      attempt_id,
      operation_key,
      content_hash,
      contract,
      normalized_payload,
      classification,
      kind,
      media_type,
      retention_policy,
      size_bytes,
      state,
      validator_version,
      validated_at,
      artifact,
      finalized_at
    FROM kurobara_core.run_output_artifacts
    WHERE workspace_id = ${candidate.workspace_id}
      AND run_id = ${candidate.run_id}
    ORDER BY step_run_id, attempt_id, artifact_id
  `;
  const artifacts: Artifact[] = [];
  const artifactPayloads: NonNullable<
    DagSchedulingContext["artifactPayloads"]
  >[number][] = [];
  for (const row of rows) {
    const parsedRow = parseOutputArtifactRow(row);
    const parsed = parsedRow.artifact;
    const stepRun = stepRuns.find(
      (candidateStep) => candidateStep.stepRunId === parsed.stepRunId
    );
    const attempt = stepRun?.attempts.find(
      (candidateAttempt) => candidateAttempt.attemptId === parsed.attemptId
    );
    if (
      parsed.workspaceId !== storedRun.workspaceId ||
      parsed.runId !== storedRun.runId ||
      attempt === undefined ||
      parsed.operationKey !== attempt.operationKey ||
      !outputRefMatchesArtifact(attempt, parsed)
    ) {
      throw new PostgresAdapterError(
        "database-identity-mismatch",
        "A DAG convergence artifact does not match its run, step, attempt or validated output reference."
      );
    }
    artifacts.push(parsed);
    artifactPayloads.push({
      artifactId: parsed.artifactId,
      contentHash: parsed.contentHash,
      value: parsedRow.value,
    });
  }
  return { artifactPayloads, artifacts };
};

const databaseAmount = (value: string, subject: string): number => {
  const parsed = Number(value);
  if (!isAmount(parsed)) {
    throw new PostgresAdapterError(
      "database-payload-invalid",
      `The ${subject} amount is not a supported non-negative number.`
    );
  }
  return parsed;
};

const loadDagSchedulingSettlementProof = async (
  transactionSql: postgres.Sql,
  candidate: DagSchedulingRunIdentityRow,
  storedRun: import("@kurobara/kernel").Run
): Promise<readonly CostReservation[]> => {
  // The run and every step aggregate are already locked. Legal attempt,
  // reservation and ledger writers are fenced by those parents, so child-row
  // locks here would only introduce a competing lock order.
  const reservationRows = await transactionSql<
    readonly DagSchedulingReservationRow[]
  >`
    SELECT
      workspace_id,
      run_id,
      step_run_id,
      attempt_id,
      reservation_id,
      operation_key,
      unit,
      amount,
      state,
      reservation
    FROM kurobara_core.cost_reservations
    WHERE workspace_id = ${candidate.workspace_id}
      AND run_id = ${candidate.run_id}
    ORDER BY step_run_id, attempt_id, reservation_id
  `;
  const usageRows = await transactionSql<readonly DagSchedulingUsageRow[]>`
    SELECT
      workspace_id,
      run_id,
      attempt_id,
      reservation_id,
      usage_entry_id,
      operation_key,
      unit,
      amount,
      entry
    FROM kurobara_core.usage_ledger_entries
    WHERE workspace_id = ${candidate.workspace_id}
      AND run_id = ${candidate.run_id}
    ORDER BY attempt_id, usage_entry_id
  `;
  const usageByReservation = new Map(
    usageRows.map((row) => [row.reservation_id, row])
  );
  if (usageByReservation.size !== usageRows.length) {
    throw new PostgresAdapterError(
      "database-identity-mismatch",
      "The DAG convergence usage ledger contains duplicate reservation evidence."
    );
  }
  const reservations = reservationRows.map((row) => {
    const reservation = parseCostReservation(row.reservation);
    const relationalAmount = databaseAmount(row.amount, "cost reservation");
    if (
      reservation.workspaceId !== storedRun.workspaceId ||
      reservation.workspaceId !== row.workspace_id ||
      reservation.runId !== storedRun.runId ||
      reservation.runId !== row.run_id ||
      reservation.stepRunId !== row.step_run_id ||
      reservation.attemptId !== row.attempt_id ||
      reservation.reservationId !== row.reservation_id ||
      reservation.operationKey !== row.operation_key ||
      reservation.unit !== row.unit ||
      !amountsEqual(reservation.amount, relationalAmount) ||
      reservation.state !== row.state
    ) {
      throw new PostgresAdapterError(
        "database-identity-mismatch",
        "A DAG convergence reservation does not match its relational identity."
      );
    }
    const usageRow = usageByReservation.get(row.reservation_id);
    if (reservation.state !== "settled") {
      if (usageRow !== undefined) {
        throw new PostgresAdapterError(
          "database-identity-mismatch",
          "A non-settled reservation has unexpected usage ledger evidence."
        );
      }
      return reservation;
    }
    if (usageRow === undefined) {
      throw new PostgresAdapterError(
        "database-identity-mismatch",
        "A settled reservation is missing its usage ledger evidence."
      );
    }
    const usage = parseUsageEntry(usageRow.entry);
    const relationalUsageAmount = databaseAmount(
      usageRow.amount,
      "usage ledger"
    );
    if (
      usage.workspaceId !== reservation.workspaceId ||
      usage.workspaceId !== usageRow.workspace_id ||
      usage.runId !== reservation.runId ||
      usage.runId !== usageRow.run_id ||
      usage.attemptId !== reservation.attemptId ||
      usage.attemptId !== usageRow.attempt_id ||
      usage.reservationId !== reservation.reservationId ||
      usage.reservationId !== usageRow.reservation_id ||
      usage.usageEntryId !== reservation.usageEntryId ||
      usage.usageEntryId !== usageRow.usage_entry_id ||
      usage.operationKey !== reservation.operationKey ||
      usage.operationKey !== usageRow.operation_key ||
      usage.unit !== reservation.unit ||
      usage.unit !== usageRow.unit ||
      !amountsEqual(usage.amount, reservation.settledAmount) ||
      !amountsEqual(usage.amount, relationalUsageAmount)
    ) {
      throw new PostgresAdapterError(
        "database-identity-mismatch",
        "A settled reservation does not match its usage ledger receipt."
      );
    }
    usageByReservation.delete(row.reservation_id);
    return reservation;
  });
  if (usageByReservation.size !== 0) {
    throw new PostgresAdapterError(
      "database-identity-mismatch",
      "The DAG convergence usage ledger contains an orphan receipt."
    );
  }
  return reservations;
};

const parseResultManifestRow = (row: ResultManifestRow): ResultManifest => {
  const manifest = parseResultManifest(row.manifest);
  if (
    manifest.workspaceId !== row.workspace_id ||
    manifest.runId !== row.run_id ||
    manifest.runPlanId !== row.run_plan_id ||
    manifest.resultManifestId !== row.result_manifest_id ||
    manifest.manifestHash !== row.manifest_hash ||
    manifest.planHash !== row.plan_hash ||
    manifest.conclusion !== row.conclusion ||
    manifest.resultCompleteness !== row.result_completeness ||
    manifest.sourceRunAggregateVersion !== row.source_run_aggregate_version ||
    manifest.cost.unit !== row.cost_unit ||
    manifest.createdAt !== row.created_at.getTime() ||
    !amountsEqual(
      manifest.cost.spent,
      databaseAmount(row.cost_spent, "result manifest cost")
    )
  ) {
    throw new PostgresAdapterError(
      "database-identity-mismatch",
      "A result manifest does not match its relational identity or cost proof."
    );
  }
  return manifest;
};

const findDagSchedulingManifest = async (
  transactionSql: postgres.Sql,
  scope: WorkspaceScope,
  requestedRunId: import("@kurobara/kernel").RunId
): Promise<ResultManifest | undefined> => {
  const rows = await transactionSql<readonly ResultManifestRow[]>`
    SELECT
      workspace_id,
      run_id,
      run_plan_id,
      result_manifest_id,
      manifest_hash,
      plan_hash,
      conclusion,
      result_completeness,
      source_run_aggregate_version,
      cost_unit,
      cost_spent,
      manifest,
      created_at
    FROM kurobara_core.run_result_manifests
    WHERE workspace_id = ${scope.workspaceId}
      AND run_id = ${requestedRunId}
  `;
  return rows[0] === undefined ? undefined : parseResultManifestRow(rows[0]);
};

const databaseObject = (
  value: unknown,
  subject: string
): Readonly<Record<string, unknown>> => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new PostgresAdapterError(
      "database-payload-invalid",
      `The ${subject} payload is not an object.`
    );
  }
  return value as Readonly<Record<string, unknown>>;
};

const assertStoredTerminalConvergenceBundle = async (
  transactionSql: postgres.Sql,
  run: import("@kurobara/kernel").Run,
  manifest: ResultManifest
): Promise<void> => {
  const expectedState =
    manifest.conclusion === "completed" ? "completed" : "failed";
  const expectedCompleteness =
    manifest.conclusion === "completed" ? "complete" : "none";
  const expectedTerminalEvent =
    manifest.conclusion === "completed" ? "RunCompleted" : "RunFailed";
  const expectedCommandType =
    manifest.conclusion === "completed" ? "CompleteRun" : "FailRun";
  if (
    run.state !== expectedState ||
    run.resultCompleteness !== expectedCompleteness ||
    manifest.resultCompleteness !== expectedCompleteness ||
    run.resultManifest?.resultManifestId !== manifest.resultManifestId ||
    run.resultManifest.manifestHash !== manifest.manifestHash ||
    run.aggregateVersion !== manifest.sourceRunAggregateVersion + 1
  ) {
    throw new PostgresAdapterError(
      "database-identity-mismatch",
      "A stale terminal run does not match its immutable result manifest."
    );
  }
  const eventRows = await transactionSql<readonly RunConvergenceEventRow[]>`
    SELECT sequence, event_id, event
    FROM kurobara_core.run_events
    WHERE workspace_id = ${run.workspaceId}
      AND run_id = ${run.runId}
      AND sequence IN (${run.eventSequence - 1}, ${run.eventSequence})
    ORDER BY sequence
  `;
  const manifestEventRow = eventRows[0];
  const terminalEventRow = eventRows[1];
  if (manifestEventRow === undefined || terminalEventRow === undefined) {
    throw new PostgresAdapterError(
      "database-identity-mismatch",
      "A stale terminal run is missing its lifecycle evidence."
    );
  }
  const manifestEvent = databaseObject(
    manifestEventRow.event,
    "result manifest lifecycle event"
  );
  const terminalEvent = databaseObject(
    terminalEventRow.event,
    "terminal-run lifecycle event"
  );
  const commonEventIdentityMatches = (
    event: Readonly<Record<string, unknown>>,
    row: RunConvergenceEventRow
  ): boolean =>
    event.workspaceId === run.workspaceId &&
    event.runId === run.runId &&
    event.eventId === row.event_id &&
    event.sequence === row.sequence &&
    event.eventVersion === 1;
  if (
    eventRows.length !== 2 ||
    !commonEventIdentityMatches(manifestEvent, manifestEventRow) ||
    !commonEventIdentityMatches(terminalEvent, terminalEventRow) ||
    manifestEvent.eventType !== "RunResultManifestRecorded" ||
    manifestEvent.resultManifestId !== manifest.resultManifestId ||
    manifestEvent.manifestHash !== manifest.manifestHash ||
    manifestEvent.conclusion !== manifest.conclusion ||
    manifestEvent.resultCompleteness !== expectedCompleteness ||
    terminalEvent.eventType !== expectedTerminalEvent ||
    terminalEvent.resultCompleteness !== expectedCompleteness ||
    terminalEventRow.sequence !== manifestEventRow.sequence + 1 ||
    terminalEventRow.sequence !== run.eventSequence ||
    manifestEvent.actorId !== terminalEvent.actorId ||
    manifestEvent.correlationId !== terminalEvent.correlationId
  ) {
    throw new PostgresAdapterError(
      "database-identity-mismatch",
      "A stale terminal run has incoherent lifecycle evidence."
    );
  }
  const commandRows = await transactionSql<readonly RunConvergenceCommandRow[]>`
    SELECT
      command_idempotency_key,
      command_hash,
      command_type,
      actor_id,
      correlation_id,
      proof
    FROM kurobara_core.run_command_journal
    WHERE workspace_id = ${run.workspaceId}
      AND run_id = ${run.runId}
      AND command_type = ${expectedCommandType}
  `;
  const commandRow = commandRows[0];
  if (commandRows.length !== 1 || commandRow === undefined) {
    throw new PostgresAdapterError(
      "database-identity-mismatch",
      "A stale terminal run is missing its unique convergence command proof."
    );
  }
  const proof = parseRunCommandReplayProof(commandRow.proof);
  if (
    proof.workspaceId !== run.workspaceId ||
    proof.runId !== run.runId ||
    proof.commandType !== expectedCommandType ||
    proof.identity.idempotencyKey !== commandRow.command_idempotency_key ||
    proof.identity.commandHash !== commandRow.command_hash ||
    commandRow.command_type !== expectedCommandType ||
    commandRow.actor_id !== manifestEvent.actorId ||
    commandRow.correlation_id !== manifestEvent.correlationId
  ) {
    throw new PostgresAdapterError(
      "database-identity-mismatch",
      "A stale terminal run has an incoherent convergence command proof."
    );
  }
};

const claimDagSchedulingContext = async (
  transactionSql: postgres.Sql
): Promise<DagSchedulingContext | undefined> => {
  const candidates = await transactionSql<readonly DagSchedulingCandidateRow[]>`
    SELECT
      stored_run.workspace_id,
      stored_run.run_id,
      stored_run.run_plan_id,
      stored_run.cost,
      stored_run.run
    FROM kurobara_core.run_dag_schedule_jobs AS job
    JOIN kurobara_core.runs AS stored_run
      ON stored_run.workspace_id = job.workspace_id
      AND stored_run.run_id = job.run_id
    WHERE job.pending
    ORDER BY job.requested_at, job.workspace_id, job.run_id
    FOR UPDATE OF stored_run SKIP LOCKED
    LIMIT 1
  `;
  const candidate = candidates[0];
  if (candidate === undefined) {
    return;
  }
  const storedRun = parseDagSchedulingRun(candidate);
  const plan = await loadDagSchedulingPlan(
    transactionSql,
    candidate,
    storedRun
  );
  const stepRuns = await loadDagSchedulingSteps(
    transactionSql,
    candidate,
    storedRun,
    plan
  );
  await loadDagSchedulingAttemptProof(transactionSql, candidate, stepRuns);
  const cost = parseRunCostSnapshot(candidate.cost);
  const reservations = await loadDagSchedulingSettlementProof(
    transactionSql,
    candidate,
    storedRun
  );
  const artifactProof = await loadDagSchedulingArtifactProof(
    transactionSql,
    candidate,
    storedRun,
    stepRuns
  );
  const recipeCell = await loadPostgresRecipeCellConvergenceContext(
    transactionSql,
    { workspaceId: storedRun.workspaceId },
    storedRun.runId
  );
  const jobs = await transactionSql<readonly { pending: boolean }[]>`
    SELECT pending
    FROM kurobara_core.run_dag_schedule_jobs
    WHERE workspace_id = ${candidate.workspace_id}
      AND run_id = ${candidate.run_id}
    FOR UPDATE
  `;
  return jobs[0]?.pending === true
    ? {
        artifactPayloads: artifactProof.artifactPayloads,
        artifacts: artifactProof.artifacts,
        cost,
        plan,
        ...(recipeCell === undefined ? {} : { recipeCell }),
        reservations,
        run: storedRun,
        stepRuns,
      }
    : undefined;
};

const loadStepRoutingStep = async (
  transactionSql: postgres.Sql,
  candidate: StepRoutingCandidateRow,
  storedRun: import("@kurobara/kernel").Run,
  plan: RunPlan
): Promise<StepRun> => {
  const rows = await transactionSql<readonly StepRoutingStepRow[]>`
    SELECT
      workspace_id,
      run_id,
      step_run_id,
      node_key,
      state,
      aggregate_version,
      event_sequence,
      step_run
    FROM kurobara_core.step_runs
    WHERE workspace_id = ${candidate.workspace_id}
      AND run_id = ${candidate.run_id}
      AND step_run_id = ${candidate.step_run_id}
    FOR UPDATE
  `;
  const row = rows[0];
  if (row === undefined) {
    throw new PostgresAdapterError(
      "database-identity-mismatch",
      "The routing job targets a missing step."
    );
  }
  const stepRun = parseStepRun(row.step_run);
  const node = plan.compiledWorkflow.nodes.find(
    (candidateNode) => candidateNode.key === stepRun.nodeKey
  );
  const dependenciesMatch =
    node !== undefined &&
    node.dependsOn.length === stepRun.dependsOn.length &&
    node.dependsOn.every(
      (dependency, index) => dependency === stepRun.dependsOn[index]
    );
  if (
    row.workspace_id !== storedRun.workspaceId ||
    row.run_id !== storedRun.runId ||
    row.step_run_id !== candidate.step_run_id ||
    stepRun.workspaceId !== row.workspace_id ||
    stepRun.runId !== row.run_id ||
    stepRun.stepRunId !== row.step_run_id ||
    stepRun.nodeKey !== row.node_key ||
    stepRun.state !== row.state ||
    stepRun.aggregateVersion !== row.aggregate_version ||
    stepRun.eventSequence !== row.event_sequence ||
    !dependenciesMatch
  ) {
    throw new PostgresAdapterError(
      "database-identity-mismatch",
      "The routing step does not match its relational keys or immutable plan."
    );
  }
  return stepRun;
};

const deferOneUnavailableStepRoutingJob = async (
  transactionSql: postgres.Sql,
  availableEffectAdapterKeys: readonly string[]
): Promise<void> => {
  const availableKeys = transactionSql.json(
    toJsonValue(availableEffectAdapterKeys)
  );
  const candidates = await transactionSql<readonly StepRoutingCandidateRow[]>`
    SELECT
      stored_run.workspace_id,
      stored_run.run_id,
      stored_run.run_plan_id,
      stored_run.run,
      step.step_run_id
    FROM kurobara_core.step_routing_jobs AS job
    JOIN kurobara_core.runs AS stored_run
      ON stored_run.workspace_id = job.workspace_id
      AND stored_run.run_id = job.run_id
    JOIN kurobara_core.run_plans AS stored_plan
      ON stored_plan.workspace_id = stored_run.workspace_id
      AND stored_plan.run_plan_id = stored_run.run_plan_id
    JOIN kurobara_core.step_runs AS step
      ON step.workspace_id = job.workspace_id
      AND step.run_id = job.run_id
      AND step.step_run_id = job.step_run_id
    WHERE job.pending
      AND job.next_attempt_at <= clock_timestamp()
      AND stored_run.run ->> 'state' = 'running'
      AND step.state = 'ready'
      AND EXISTS (
        SELECT 1
        FROM jsonb_array_elements(
          CASE
            WHEN jsonb_typeof(stored_plan.plan -> 'routeSnapshots') = 'array'
              THEN stored_plan.plan -> 'routeSnapshots'
            ELSE '[]'::jsonb
          END
        ) AS route(snapshot)
        WHERE route.snapshot ->> 'nodeKey' = step.node_key
      )
      AND NOT EXISTS (
        SELECT 1
        FROM jsonb_array_elements(
          CASE
            WHEN jsonb_typeof(stored_plan.plan -> 'routeSnapshots') = 'array'
              THEN stored_plan.plan -> 'routeSnapshots'
            ELSE '[]'::jsonb
          END
        ) AS route(snapshot)
        JOIN jsonb_array_elements_text(${availableKeys}) AS available(key)
          ON available.key = route.snapshot ->> 'effectAdapterKey'
        WHERE route.snapshot ->> 'nodeKey' = step.node_key
      )
    ORDER BY
      job.next_attempt_at,
      job.requested_at,
      job.workspace_id,
      job.run_id,
      job.step_run_id
    FOR UPDATE OF stored_run SKIP LOCKED
    LIMIT 1
  `;
  const candidate = candidates[0];
  if (candidate === undefined) {
    return;
  }
  const storedRun = parseDagSchedulingRun(candidate);
  const plan = await loadDagSchedulingPlan(
    transactionSql,
    candidate,
    storedRun
  );
  const stepRun = await loadStepRoutingStep(
    transactionSql,
    candidate,
    storedRun,
    plan
  );
  const jobs = await transactionSql<readonly { pending: boolean }[]>`
    SELECT pending
    FROM kurobara_core.step_routing_jobs
    WHERE workspace_id = ${candidate.workspace_id}
      AND run_id = ${candidate.run_id}
      AND step_run_id = ${candidate.step_run_id}
    FOR UPDATE
  `;
  const available = new Set(availableEffectAdapterKeys);
  const plannedRoutes = (plan.routeSnapshots ?? []).filter(
    (route) => route.nodeKey === stepRun.nodeKey
  );
  if (
    jobs[0]?.pending !== true ||
    storedRun.state !== "running" ||
    stepRun.state !== "ready" ||
    plannedRoutes.length === 0 ||
    plannedRoutes.some((route) => available.has(route.effectAdapterKey))
  ) {
    return;
  }
  await transactionSql`
    UPDATE kurobara_core.step_routing_jobs
    SET
      attempts = attempts + 1,
      next_attempt_at = clock_timestamp() + (
        LEAST(60_000, 1000 * power(2, LEAST(attempts, 6)))
        * interval '1 millisecond'
      ),
      last_error = 'effect-adapter-unavailable',
      updated_at = clock_timestamp()
    WHERE workspace_id = ${candidate.workspace_id}
      AND run_id = ${candidate.run_id}
      AND step_run_id = ${candidate.step_run_id}
      AND pending
  `;
};

const claimStepRoutingContext = async (
  transactionSql: postgres.Sql,
  availableEffectAdapterKeys: readonly string[]
): Promise<StepRoutingContext | undefined> => {
  await deferOneUnavailableStepRoutingJob(
    transactionSql,
    availableEffectAdapterKeys
  );
  const availableKeys = transactionSql.json(
    toJsonValue(availableEffectAdapterKeys)
  );
  const candidates = await transactionSql<readonly StepRoutingCandidateRow[]>`
    SELECT
      stored_run.workspace_id,
      stored_run.run_id,
      stored_run.run_plan_id,
      stored_run.run,
      step.step_run_id
    FROM kurobara_core.step_routing_jobs AS job
    JOIN kurobara_core.runs AS stored_run
      ON stored_run.workspace_id = job.workspace_id
      AND stored_run.run_id = job.run_id
    JOIN kurobara_core.run_plans AS stored_plan
      ON stored_plan.workspace_id = stored_run.workspace_id
      AND stored_plan.run_plan_id = stored_run.run_plan_id
    JOIN kurobara_core.step_runs AS step
      ON step.workspace_id = job.workspace_id
      AND step.run_id = job.run_id
      AND step.step_run_id = job.step_run_id
    WHERE job.pending
      AND job.next_attempt_at <= clock_timestamp()
      AND (
        (
          stored_run.run ->> 'workspaceId' = stored_run.workspace_id
          AND stored_run.run ->> 'runId' = stored_run.run_id
          AND stored_run.run ->> 'runPlanId' = stored_run.run_plan_id
          AND stored_run.run ->> 'state' = 'running'
          AND step.state = 'ready'
          AND step.step_run ->> 'workspaceId' = step.workspace_id
          AND step.step_run ->> 'runId' = step.run_id
          AND step.step_run ->> 'stepRunId' = step.step_run_id
          AND step.step_run ->> 'nodeKey' = step.node_key
          AND step.step_run ->> 'state' = step.state
          AND step.step_run -> 'aggregateVersion' =
            to_jsonb(step.aggregate_version)
          AND step.step_run -> 'eventSequence' =
            to_jsonb(step.event_sequence)
        ) IS NOT TRUE
        OR NOT EXISTS (
          SELECT 1
          FROM jsonb_array_elements(
            CASE
              WHEN jsonb_typeof(stored_plan.plan -> 'routeSnapshots') = 'array'
                THEN stored_plan.plan -> 'routeSnapshots'
              ELSE '[]'::jsonb
            END
          ) AS route(snapshot)
          WHERE route.snapshot ->> 'nodeKey' = step.node_key
        )
        OR EXISTS (
          SELECT 1
          FROM jsonb_array_elements(
            CASE
              WHEN jsonb_typeof(stored_plan.plan -> 'routeSnapshots') = 'array'
                THEN stored_plan.plan -> 'routeSnapshots'
              ELSE '[]'::jsonb
            END
          ) AS route(snapshot)
          JOIN jsonb_array_elements_text(${availableKeys}) AS available(key)
            ON available.key = route.snapshot ->> 'effectAdapterKey'
          WHERE route.snapshot ->> 'nodeKey' = step.node_key
        )
      )
    ORDER BY
      job.next_attempt_at,
      job.requested_at,
      job.workspace_id,
      job.run_id,
      job.step_run_id
    FOR UPDATE OF stored_run SKIP LOCKED
    LIMIT 1
  `;
  const candidate = candidates[0];
  if (candidate === undefined) {
    return;
  }
  const storedRun = parseDagSchedulingRun(candidate);
  const plan = await loadDagSchedulingPlan(
    transactionSql,
    candidate,
    storedRun
  );
  const stepRun = await loadStepRoutingStep(
    transactionSql,
    candidate,
    storedRun,
    plan
  );
  const jobs = await transactionSql<
    readonly { eligible: boolean; pending: boolean }[]
  >`
    SELECT
      pending,
      next_attempt_at <= clock_timestamp() AS eligible
    FROM kurobara_core.step_routing_jobs
    WHERE workspace_id = ${candidate.workspace_id}
      AND run_id = ${candidate.run_id}
      AND step_run_id = ${candidate.step_run_id}
    FOR UPDATE
  `;
  const job = jobs[0];
  if (job === undefined || !job.pending || !job.eligible) {
    return;
  }
  return { plan, run: storedRun, stepRun };
};

const makeStepRouting = (sql: postgres.Sql): StepRoutingPersistencePort => ({
  transactionForSystem: async (work) => {
    const result = await sql.begin((transaction) => {
      const transactionSql = transaction as unknown as postgres.Sql;
      let claimedContext: StepRoutingContext | undefined;
      let executionUnitOfWork: StepExecutionUnitOfWork | undefined;
      let claimAttempted = false;

      const requireClaim = (): StepRoutingContext => {
        if (claimedContext === undefined) {
          throw new PostgresAdapterError(
            "database-identity-mismatch",
            "A routing transaction must claim a job before mutating step state."
          );
        }
        return claimedContext;
      };
      const requireExecution = (): StepExecutionUnitOfWork => {
        if (executionUnitOfWork === undefined) {
          throw new PostgresAdapterError(
            "database-identity-mismatch",
            "A routing transaction has no claimed workspace."
          );
        }
        return executionUnitOfWork;
      };
      const assertClaimedJob = (
        scope: WorkspaceScope,
        requestedStepRunId: import("@kurobara/kernel").StepRunId
      ): StepRoutingContext => {
        const context = requireClaim();
        if (
          context.run.workspaceId !== scope.workspaceId ||
          context.stepRun.stepRunId !== requestedStepRunId
        ) {
          throw new PostgresAdapterError(
            "workspace-scope-mismatch",
            "The routing job mutation does not match the claimed step."
          );
        }
        return context;
      };

      const unitOfWork: StepRoutingUnitOfWork = {
        get artifacts() {
          return requireExecution().artifacts;
        },
        get attempts() {
          return requireExecution().attempts;
        },
        get commandJournal() {
          return requireExecution().commandJournal;
        },
        get dagSchedule() {
          return requireExecution().dagSchedule;
        },
        get leafOutbox() {
          return requireExecution().leafOutbox;
        },
        get reservations() {
          return requireExecution().reservations;
        },
        get routingDecisions() {
          return requireExecution().routingDecisions;
        },
        routingJobs: {
          claimNextForUpdate: async (availableEffectAdapterKeys) => {
            if (claimAttempted) {
              return claimedContext;
            }
            claimAttempted = true;
            const normalized = availableEffectAdapterKeys.map((key) =>
              key.trim()
            );
            if (normalized.some((key) => key.length === 0)) {
              throw new PostgresAdapterError(
                "database-payload-invalid",
                "Available effect adapter keys must be non-empty."
              );
            }
            claimedContext = await claimStepRoutingContext(transactionSql, [
              ...new Set(normalized),
            ]);
            if (claimedContext !== undefined) {
              executionUnitOfWork = makeStepExecutionUnitOfWork(
                transactionSql,
                {
                  workspaceId: claimedContext.run.workspaceId,
                }
              );
            }
            return claimedContext;
          },
          complete: async (scope, requestedStepRunId) => {
            const context = assertClaimedJob(scope, requestedStepRunId);
            const completed = await transactionSql<
              readonly { step_run_id: string }[]
            >`
              UPDATE kurobara_core.step_routing_jobs
              SET
                pending = false,
                last_error = NULL,
                processed_at = clock_timestamp(),
                updated_at = clock_timestamp()
              WHERE workspace_id = ${scope.workspaceId}
                AND run_id = ${context.run.runId}
                AND step_run_id = ${requestedStepRunId}
                AND pending
              RETURNING step_run_id
            `;
            if (completed.length === 0) {
              throw new PostgresAdapterError(
                "database-identity-mismatch",
                "The claimed routing job is no longer pending."
              );
            }
          },
          defer: async (
            scope,
            requestedStepRunId,
            reason,
            retryDelayMilliseconds
          ) => {
            const context = assertClaimedJob(scope, requestedStepRunId);
            if (
              reason.trim().length === 0 ||
              !Number.isSafeInteger(retryDelayMilliseconds) ||
              retryDelayMilliseconds <= 0
            ) {
              throw new PostgresAdapterError(
                "database-payload-invalid",
                "A routing deferral requires a reason and positive delay."
              );
            }
            const deferred = await transactionSql<
              readonly { step_run_id: string }[]
            >`
              UPDATE kurobara_core.step_routing_jobs
              SET
                pending = true,
                attempts = attempts + 1,
                next_attempt_at = clock_timestamp()
                  + (${retryDelayMilliseconds} * interval '1 millisecond'),
                last_error = ${reason},
                processed_at = NULL,
                updated_at = clock_timestamp()
              WHERE workspace_id = ${scope.workspaceId}
                AND run_id = ${context.run.runId}
                AND step_run_id = ${requestedStepRunId}
                AND pending
              RETURNING step_run_id
            `;
            if (deferred.length === 0) {
              throw new PostgresAdapterError(
                "database-identity-mismatch",
                "The claimed routing job is no longer pending."
              );
            }
          },
        },
        get stepEvents() {
          return requireExecution().stepEvents;
        },
        get stepRouting() {
          return requireExecution().stepRouting;
        },
        get steps() {
          return requireExecution().steps;
        },
      };
      return work(unitOfWork);
    });
    return result as unknown as Awaited<ReturnType<typeof work>>;
  },
});

const insertDagSchedulingStep = async (
  transactionSql: postgres.Sql,
  scope: WorkspaceScope,
  stepRun: StepRun,
  event: Extract<StepLifecycleEvent, { eventType: "StepReady" | "StepSkipped" }>
): Promise<void> => {
  await transactionSql`
    INSERT INTO kurobara_core.step_runs (
      workspace_id,
      step_run_id,
      run_id,
      node_key,
      state,
      aggregate_version,
      event_sequence,
      step_run,
      created_at
    ) VALUES (
      ${scope.workspaceId},
      ${stepRun.stepRunId},
      ${stepRun.runId},
      ${stepRun.nodeKey},
      ${stepRun.state},
      ${stepRun.aggregateVersion},
      ${stepRun.eventSequence},
      ${transactionSql.json(toJsonValue(stepRun))},
      ${new Date(stepRun.createdAt)}
    )
  `;
  await transactionSql`
    INSERT INTO kurobara_core.step_events (
      workspace_id,
      step_run_id,
      sequence,
      event_id,
      event,
      occurred_at
    ) VALUES (
      ${scope.workspaceId},
      ${event.stepRunId},
      ${event.sequence},
      ${event.eventId},
      ${transactionSql.json(toJsonValue(event))},
      ${new Date(event.occurredAt)}
    )
  `;
};

const terminalBundleMatchesOutcome = (
  outcome: DagSchedulingJobOutcome,
  manifest: ResultManifest | undefined,
  run: import("@kurobara/kernel").Run | undefined,
  events: readonly RunLifecycleEvent[],
  commandType: "CompleteRun" | "FailRun" | undefined
): boolean => {
  if (
    outcome.status !== "failure-finalized" &&
    outcome.status !== "success-finalized"
  ) {
    return true;
  }
  const success = outcome.status === "success-finalized";
  const expectedState = success ? "completed" : "failed";
  const expectedConclusion = success ? "completed" : "failed";
  const expectedCompleteness = success ? "complete" : "none";
  const expectedTerminalEvent = success ? "RunCompleted" : "RunFailed";
  const expectedCommandType = success ? "CompleteRun" : "FailRun";
  const manifestEvent = events[0];
  const terminalEvent = events[1];
  return (
    manifest !== undefined &&
    run?.state === expectedState &&
    manifest.conclusion === expectedConclusion &&
    manifest.resultCompleteness === expectedCompleteness &&
    run.aggregateVersion === manifest.sourceRunAggregateVersion + 1 &&
    run.resultManifest?.resultManifestId === manifest.resultManifestId &&
    run.resultManifest.manifestHash === manifest.manifestHash &&
    manifestEvent?.eventType === "RunResultManifestRecorded" &&
    manifestEvent.resultManifestId === manifest.resultManifestId &&
    manifestEvent.manifestHash === manifest.manifestHash &&
    manifestEvent.conclusion === expectedConclusion &&
    manifestEvent.resultCompleteness === expectedCompleteness &&
    terminalEvent?.eventType === expectedTerminalEvent &&
    terminalEvent.resultCompleteness === expectedCompleteness &&
    terminalEvent.sequence === manifestEvent.sequence + 1 &&
    run.eventSequence === terminalEvent.sequence &&
    manifestEvent.actorId === terminalEvent.actorId &&
    manifestEvent.correlationId === terminalEvent.correlationId &&
    commandType === expectedCommandType &&
    events.length === 2
  );
};

const outcomeMatchesTransactionEffects = (
  outcome: DagSchedulingJobOutcome,
  claimedRunState: import("@kurobara/kernel").Run["state"],
  insertedStepCount: number
): boolean => {
  if (outcome.status === "steps-materialized") {
    return insertedStepCount > 0;
  }
  if (
    outcome.status === "failure-finalized" ||
    outcome.status === "success-finalized"
  ) {
    return true;
  }
  if (insertedStepCount !== 0) {
    return false;
  }
  return (
    outcome.status !== "stale-terminal" ||
    claimedRunState === "cancelled" ||
    claimedRunState === "completed" ||
    claimedRunState === "failed"
  );
};

const recipeCellEffectsMatchOutcome = (
  outcome: DagSchedulingJobOutcome,
  context: DagSchedulingContext,
  finalizedRecipeCell: boolean
): boolean => {
  if (context.recipeCell === undefined) {
    return !finalizedRecipeCell;
  }
  if (
    outcome.status === "failure-finalized" ||
    outcome.status === "success-finalized" ||
    (outcome.status === "stale-terminal" && context.run.state === "cancelled")
  ) {
    return finalizedRecipeCell;
  }
  if (outcome.status === "stale-terminal") {
    return (
      !finalizedRecipeCell &&
      (context.recipeCell.current.status === "failed" ||
        context.recipeCell.current.status === "succeeded")
    );
  }
  return !finalizedRecipeCell;
};

const terminalCellStatusForRun = (
  state: DagSchedulingContext["run"]["state"]
): DagCellResultFinalization["cellResult"]["status"] | undefined => {
  if (state === "completed") {
    return "succeeded";
  }
  if (state === "failed") {
    return "failed";
  }
  return state === "cancelled" ? "skipped" : undefined;
};

const assertClaimedCellFinalization = (
  context: DagSchedulingContext | undefined,
  updatedRun: DagSchedulingContext["run"] | undefined,
  finalizedRecipeCell: boolean,
  scope: WorkspaceScope,
  finalization: DagCellResultFinalization
): void => {
  const terminalRun = updatedRun ?? context?.run;
  const expectedCellStatus =
    terminalRun === undefined
      ? undefined
      : terminalCellStatusForRun(terminalRun.state);
  if (
    context?.recipeCell === undefined ||
    terminalRun === undefined ||
    expectedCellStatus === undefined ||
    finalizedRecipeCell ||
    scope.workspaceId !== context.run.workspaceId ||
    finalization.cellResult.cellResultId !==
      context.recipeCell.current.cellResultId ||
    finalization.cellResult.runId !== terminalRun.runId ||
    finalization.cellResult.status !== expectedCellStatus ||
    finalization.sourceRunAggregateVersion !== terminalRun.aggregateVersion
  ) {
    throw new PostgresAdapterError(
      "database-identity-mismatch",
      "The CellResult finalization does not match the claimed terminal Run."
    );
  }
};

const makeDagScheduling = (
  sql: postgres.Sql
): DagSchedulingPersistencePort => ({
  transactionForSystem: async (work) => {
    const result = await sql.begin((transaction) => {
      const transactionSql = transaction as unknown as postgres.Sql;
      let claimedContext: DagSchedulingContext | undefined;
      let claimAttempted = false;
      let insertedStepCount = 0;
      const knownStepsByNodeKey = new Map<string, StepRun>();
      let insertedManifest: ResultManifest | undefined;
      let updatedRun: import("@kurobara/kernel").Run | undefined;
      const appendedRunEvents: RunLifecycleEvent[] = [];
      let insertedTerminalCommandType: "CompleteRun" | "FailRun" | undefined;
      let finalizedRecipeCell = false;

      return work({
        cellResults: {
          finalize: async (scope, finalization) => {
            assertClaimedCellFinalization(
              claimedContext,
              updatedRun,
              finalizedRecipeCell,
              scope,
              finalization
            );
            const scopedRecipeUnitOfWork = createPostgresRecipeUnitOfWork(
              transactionSql,
              scope
            );
            await scopedRecipeUnitOfWork.dagConvergence.finalize(
              scope,
              finalization
            );
            finalizedRecipeCell = true;
          },
        },
        commandJournal: {
          insert: async (
            scope,
            proof,
            commandActorId,
            commandCorrelationId
          ) => {
            if (
              claimedContext === undefined ||
              claimedContext.run.workspaceId !== scope.workspaceId ||
              proof.workspaceId !== scope.workspaceId ||
              proof.runId !== claimedContext.run.runId ||
              (proof.commandType !== "FailRun" &&
                proof.commandType !== "CompleteRun") ||
              insertedTerminalCommandType !== undefined
            ) {
              throw new PostgresAdapterError(
                "database-identity-mismatch",
                "The convergence command proof does not match the claimed run."
              );
            }
            await transactionSql`
              INSERT INTO kurobara_core.run_command_journal (
                workspace_id,
                run_id,
                command_idempotency_key,
                command_hash,
                command_type,
                actor_id,
                correlation_id,
                proof
              ) VALUES (
                ${scope.workspaceId},
                ${proof.runId},
                ${proof.identity.idempotencyKey},
                ${proof.identity.commandHash},
                ${proof.commandType},
                ${commandActorId},
                ${commandCorrelationId},
                ${transactionSql.json(toJsonValue(proof))}
              )
            `;
            insertedTerminalCommandType = proof.commandType;
          },
        },
        jobs: {
          claimNextForUpdate: async () => {
            if (claimAttempted) {
              return claimedContext;
            }
            claimAttempted = true;
            claimedContext = await claimDagSchedulingContext(transactionSql);
            for (const stepRun of claimedContext?.stepRuns ?? []) {
              knownStepsByNodeKey.set(stepRun.nodeKey, stepRun);
            }
            return claimedContext;
          },
          complete: async (scope, requestedRunId, outcome) => {
            if (
              claimedContext === undefined ||
              claimedContext.run.workspaceId !== scope.workspaceId ||
              claimedContext.run.runId !== requestedRunId
            ) {
              throw new PostgresAdapterError(
                "workspace-scope-mismatch",
                "The DAG schedule completion does not match the claimed run."
              );
            }
            if (
              !(
                terminalBundleMatchesOutcome(
                  outcome,
                  insertedManifest,
                  updatedRun,
                  appendedRunEvents,
                  insertedTerminalCommandType
                ) &&
                outcomeMatchesTransactionEffects(
                  outcome,
                  claimedContext.run.state,
                  insertedStepCount
                ) &&
                recipeCellEffectsMatchOutcome(
                  outcome,
                  claimedContext,
                  finalizedRecipeCell
                )
              )
            ) {
              throw new PostgresAdapterError(
                "database-identity-mismatch",
                "The DAG schedule outcome does not match its transaction effects."
              );
            }
            const completed = await transactionSql<
              readonly { run_id: string }[]
            >`
              UPDATE kurobara_core.run_dag_schedule_jobs
              SET
                pending = false,
                processed_at = clock_timestamp(),
                last_outcome = ${outcome.status},
                blocked_reason = ${
                  outcome.status === "blocked" ? outcome.reason : null
                },
                evaluated_at = clock_timestamp()
              WHERE workspace_id = ${scope.workspaceId}
                AND run_id = ${requestedRunId}
                AND pending
              RETURNING run_id
            `;
            if (completed.length === 0) {
              throw new PostgresAdapterError(
                "database-identity-mismatch",
                "The claimed DAG schedule job is no longer pending."
              );
            }
          },
        },
        manifests: {
          findByRun: async (scope, requestedRunId) => {
            if (
              claimedContext === undefined ||
              claimedContext.run.workspaceId !== scope.workspaceId ||
              claimedContext.run.runId !== requestedRunId
            ) {
              throw new PostgresAdapterError(
                "workspace-scope-mismatch",
                "The result manifest lookup does not match the claimed run."
              );
            }
            const manifest = await findDagSchedulingManifest(
              transactionSql,
              scope,
              requestedRunId
            );
            if (
              claimedContext.run.state === "failed" ||
              claimedContext.run.state === "completed"
            ) {
              if (manifest === undefined) {
                throw new PostgresAdapterError(
                  "database-identity-mismatch",
                  "A stale terminal run is missing its result manifest."
                );
              }
              await assertStoredTerminalConvergenceBundle(
                transactionSql,
                claimedContext.run,
                manifest
              );
            }
            return manifest;
          },
          insert: async (scope, manifest) => {
            if (
              claimedContext === undefined ||
              claimedContext.run.workspaceId !== scope.workspaceId ||
              manifest.workspaceId !== scope.workspaceId ||
              manifest.runId !== claimedContext.run.runId ||
              manifest.runPlanId !== claimedContext.run.runPlanId ||
              manifest.planHash !== claimedContext.plan.planHash ||
              manifest.sourceRunAggregateVersion !==
                claimedContext.run.aggregateVersion ||
              manifest.cost.unit !== claimedContext.cost.unit ||
              !amountsEqual(
                manifest.cost.reserved,
                claimedContext.cost.reserved
              ) ||
              !amountsEqual(manifest.cost.spent, claimedContext.cost.spent) ||
              insertedManifest !== undefined
            ) {
              throw new PostgresAdapterError(
                "database-identity-mismatch",
                "The result manifest does not match the claimed convergence proof."
              );
            }
            const parsedManifest = parseResultManifest(toJsonValue(manifest));
            await transactionSql`
              INSERT INTO kurobara_core.run_result_manifests (
                workspace_id,
                run_id,
                run_plan_id,
                result_manifest_id,
                manifest_hash,
                plan_hash,
                conclusion,
                result_completeness,
                source_run_aggregate_version,
                cost_unit,
                cost_spent,
                manifest,
                created_at
              ) VALUES (
                ${scope.workspaceId},
                ${parsedManifest.runId},
                ${parsedManifest.runPlanId},
                ${parsedManifest.resultManifestId},
                ${parsedManifest.manifestHash},
                ${parsedManifest.planHash},
                ${parsedManifest.conclusion},
                ${parsedManifest.resultCompleteness},
                ${parsedManifest.sourceRunAggregateVersion},
                ${parsedManifest.cost.unit},
                ${parsedManifest.cost.spent},
                ${transactionSql.json(toJsonValue(parsedManifest))},
                ${new Date(parsedManifest.createdAt)}
              )
            `;
            insertedManifest = parsedManifest;
          },
        },
        routing: {
          request: async (scope, requestedStepRunId) => {
            if (
              claimedContext === undefined ||
              claimedContext.run.workspaceId !== scope.workspaceId
            ) {
              throw new PostgresAdapterError(
                "workspace-scope-mismatch",
                "The routing request does not belong to the claimed DAG workspace."
              );
            }
            await requestStepRouting(
              transactionSql,
              scope,
              scope,
              requestedStepRunId
            );
          },
        },
        runEvents: {
          append: async (scope, event) => {
            if (
              claimedContext === undefined ||
              claimedContext.run.workspaceId !== scope.workspaceId ||
              event.workspaceId !== scope.workspaceId ||
              event.runId !== claimedContext.run.runId ||
              (event.eventType !== "RunResultManifestRecorded" &&
                event.eventType !== "RunFailed" &&
                event.eventType !== "RunCompleted")
            ) {
              throw new PostgresAdapterError(
                "database-identity-mismatch",
                "The convergence lifecycle event does not match the claimed run."
              );
            }
            await transactionSql`
              INSERT INTO kurobara_core.run_events (
                workspace_id,
                run_id,
                sequence,
                event_id,
                event,
                occurred_at
              ) VALUES (
                ${scope.workspaceId},
                ${event.runId},
                ${event.sequence},
                ${event.eventId},
                ${transactionSql.json(toJsonValue(event))},
                ${new Date(event.occurredAt)}
              )
            `;
            appendedRunEvents.push(event);
          },
        },
        runs: {
          update: async (scope, expectedAggregateVersion, run) => {
            if (
              claimedContext === undefined ||
              claimedContext.run.workspaceId !== scope.workspaceId ||
              run.workspaceId !== scope.workspaceId ||
              run.runId !== claimedContext.run.runId ||
              expectedAggregateVersion !==
                claimedContext.run.aggregateVersion ||
              updatedRun !== undefined
            ) {
              throw new PostgresAdapterError(
                "database-identity-mismatch",
                "The converged run does not match the claimed aggregate."
              );
            }
            const parsedRun = parseRun(toJsonValue(run));
            const rows = await transactionSql<readonly { run_id: string }[]>`
              UPDATE kurobara_core.runs
              SET run = ${transactionSql.json(toJsonValue(parsedRun))}
              WHERE workspace_id = ${scope.workspaceId}
                AND run_id = ${parsedRun.runId}
                AND (run ->> 'aggregateVersion')::integer = ${expectedAggregateVersion}
              RETURNING run_id
            `;
            if (rows.length === 0) {
              throw new RunAggregateConflictError(run.runId);
            }
            updatedRun = parsedRun;
          },
        },
        steps: {
          insertReady: async (scope, stepRun, event) => {
            if (
              claimedContext === undefined ||
              claimedContext.run.workspaceId !== scope.workspaceId
            ) {
              throw new PostgresAdapterError(
                "workspace-scope-mismatch",
                "The ready step does not belong to the claimed DAG workspace."
              );
            }
            const parsedStepRun = parseStepRun(stepRun);
            if (
              parsedStepRun.stepRunId !== stepRun.stepRunId ||
              !dagSchedulingIdentityMatches(claimedContext, stepRun, event)
            ) {
              throw new PostgresAdapterError(
                "database-identity-mismatch",
                "The ready step or event does not match the claimed DAG node."
              );
            }
            await insertDagSchedulingStep(
              transactionSql,
              scope,
              stepRun,
              event
            );
            insertedStepCount += 1;
            knownStepsByNodeKey.set(stepRun.nodeKey, stepRun);
          },
          insertSkipped: async (scope, stepRun, event) => {
            if (
              claimedContext === undefined ||
              claimedContext.run.workspaceId !== scope.workspaceId
            ) {
              throw new PostgresAdapterError(
                "workspace-scope-mismatch",
                "The skipped step does not belong to the claimed DAG workspace."
              );
            }
            const parsedStepRun = parseStepRun(stepRun);
            if (
              parsedStepRun.stepRunId !== stepRun.stepRunId ||
              !dagSchedulingSkippedIdentityMatches(
                claimedContext,
                knownStepsByNodeKey,
                stepRun,
                event
              )
            ) {
              throw new PostgresAdapterError(
                "database-identity-mismatch",
                "The skipped step or event does not match the claimed DAG node."
              );
            }
            await insertDagSchedulingStep(
              transactionSql,
              scope,
              stepRun,
              event
            );
            insertedStepCount += 1;
            knownStepsByNodeKey.set(stepRun.nodeKey, stepRun);
          },
        },
      });
    });
    return result as unknown as Awaited<ReturnType<typeof work>>;
  },
});

const makeStepQueries = (sql: postgres.Sql): StepExecutionQueryPort => ({
  getContextByStepId: async (scope, requestedStepRunId) => {
    const result = await sql.begin((transaction) =>
      loadStepExecutionContextById(
        transaction as unknown as postgres.Sql,
        scope,
        scope,
        requestedStepRunId
      )
    );
    return result as unknown as StepExecutionContext | undefined;
  },
  getLeafExecutionIdentity: async (
    scope,
    requestedStepRunId,
    requestedAttemptId
  ) => {
    const rows = await sql<
      readonly {
        attempt_id: string;
        effect_adapter_key: string | null;
        event_id: string;
        run_id: string;
        start_key: string;
        step_run_id: string;
        workspace_id: string;
      }[]
    >`
      SELECT
        binding.workspace_id,
        binding.run_id,
        binding.step_run_id,
        binding.attempt_id,
        binding.effect_adapter_key,
        binding.event_id,
        binding.start_key
      FROM kurobara_core.step_leaf_execution_bindings AS binding
      JOIN kurobara_core.step_attempts AS attempt
        ON attempt.workspace_id = binding.workspace_id
        AND attempt.step_run_id = binding.step_run_id
        AND attempt.attempt_id = binding.attempt_id
      WHERE binding.workspace_id = ${scope.workspaceId}
        AND binding.step_run_id = ${requestedStepRunId}
        AND binding.attempt_id = ${requestedAttemptId}
        AND binding.state NOT IN (
          'reconciliation_exhausted', 'rejected', 'cancelled'
        )
    `;
    const row = rows[0];
    return row === undefined
      ? undefined
      : {
          attemptId: attemptId(row.attempt_id),
          ...(row.effect_adapter_key === null
            ? {}
            : { effectAdapterKey: row.effect_adapter_key }),
          eventId: eventId(row.event_id),
          runId: runId(row.run_id),
          startKey: row.start_key,
          stepRunId: stepRunId(row.step_run_id),
          workspaceId: workspaceId(row.workspace_id),
        };
  },
});

export type PostgresRuntime = Readonly<{
  apiKeys: ApiKeyAuthenticationPort;
  bootstrapApiKey(input: BootstrapApiKeyInput): Promise<BootstrappedApiKey>;
  bootstrapPlanning(
    input: BootstrapPlanningInput
  ): Promise<PlanningBundleApplyResult>;
  close(): Promise<void>;
  contactPrivacy: ContactPrivacyPersistencePort;
  contactDatasetExportPrivacy: ContactDatasetExportPrivacySourcePort;
  contactIdentitySource: ContactIdentitySourcePort;
  selectedContactEnrichmentSource: SelectedContactEnrichmentSourcePort;
  dagScheduling: DagSchedulingPersistencePort;
  datasetGeneration: DatasetGenerationPersistencePort;
  datasetGenerationCancellation: DatasetGenerationCancellationPersistencePort;
  datasetGenerationFirstPage: DatasetGenerationFirstPagePersistencePort;
  datasetGenerationPlanning: DatasetGenerationPlanningPersistencePort;
  datasetGenerationWork: DatasetGenerationWorkPort;
  datasets: DatasetPersistencePort;
  datasetRecordPages: DatasetRecordPageQueryPort;
  exportDeliveries: ExportDeliveryPersistencePort;
  health(): Promise<void>;
  leafEffectRecovery: LeafEffectRecoveryPort;
  leafOutbox: LeafOutboxDispatchPort;
  migrate(): Promise<void>;
  outbox: OutboxDispatchPort;
  orchestrationReconciliation: OrchestrationReconciliationPort;
  persistence: PersistencePort;
  planning: PlanningPersistencePort;
  recipeApply: RecipeApplyPersistencePort;
  recipeApplicationWatches: RecipeApplicationWatchQueryPort;
  recipeCellRuns: RecipeCellRunCreationPersistencePort;
  recipes: RecipePersistencePort;
  readPlanningState(
    workspaceId: string
  ): Promise<PlanningStateReadback | undefined>;
  runQueries: RunQueryPort;
  runExecution: RunExecutionPersistencePort;
  stepExecution: StepExecutionPersistencePort;
  stepQueries: StepExecutionQueryPort;
  stepRouting: StepRoutingPersistencePort;
  verifyPlanningBundle(
    input: BootstrapPlanningInput,
    expectedDefaultsRevision: number
  ): Promise<boolean>;
  verifyMigrations(): Promise<void>;
}>;

export const createPostgresRuntime = (
  connectionString: string
): PostgresRuntime => {
  if (connectionString.trim().length === 0) {
    throw new PostgresAdapterError(
      "database-url-required",
      "A non-empty PostgreSQL connection string is required."
    );
  }
  const sql = postgres(connectionString, {
    connect_timeout: 10,
    idle_timeout: 20,
    max: 10,
    onnotice: () => undefined,
  });
  const persistence: PersistencePort = {
    transaction: async <Value>(
      scope: WorkspaceScope,
      work: (unitOfWork: RunCreationUnitOfWork) => Promise<Value>
    ) => {
      const result = await sql.begin((transaction) =>
        work(makeUnitOfWork(transaction as unknown as postgres.Sql, scope))
      );
      // postgres-js unwraps arrays in its generic return type even when the
      // callback returns an opaque application value.
      return result as unknown as Value;
    },
  };
  const recipes = createPostgresRecipePersistence(sql);
  const datasets = createPostgresDatasetPersistence(sql);
  return {
    apiKeys: createPostgresApiKeyAuthentication(sql),
    bootstrapApiKey: (input) => bootstrapPostgresApiKey(sql, input),
    bootstrapPlanning: (input) => bootstrapPostgresPlanning(sql, input),
    close: async () => sql.end({ timeout: 5 }),
    contactDatasetExportPrivacy:
      createPostgresContactDatasetExportPrivacySource(sql, datasets),
    contactPrivacy: createPostgresContactPrivacyPersistence(sql),
    contactIdentitySource: createPostgresContactIdentitySource(sql, datasets),
    selectedContactEnrichmentSource:
      createPostgresSelectedContactEnrichmentSource(sql, datasets),
    dagScheduling: makeDagScheduling(sql),
    datasetGeneration: createPostgresDatasetGenerationPersistence(sql),
    datasetGenerationCancellation:
      createPostgresDatasetGenerationCancellationPersistence(
        sql,
        makeRunExecutionUnitOfWork
      ),
    datasetGenerationFirstPage:
      createPostgresDatasetGenerationFirstPagePersistence(sql, makeUnitOfWork),
    datasetGenerationPlanning:
      createPostgresDatasetGenerationPlanningPersistence(sql),
    datasetGenerationWork: createPostgresDatasetGenerationWork(sql),
    datasetRecordPages: createPostgresDatasetRecordPageQuery(sql, datasets),
    datasets,
    exportDeliveries: createPostgresExportDeliveryPersistence(sql),
    health: async () => {
      await sql`SELECT 1`;
    },
    leafEffectRecovery: makeLeafEffectRecovery(sql),
    leafOutbox: makeLeafOutbox(sql),
    migrate: async () => applyPostgresMigrations(sql),
    orchestrationReconciliation: makeOrchestrationReconciliation(sql),
    outbox: makeOutbox(sql),
    persistence,
    planning: makePostgresPlanning(sql),
    readPlanningState: (requestedWorkspaceId) =>
      readPostgresPlanningState(sql, requestedWorkspaceId),
    recipeApplicationWatches: createPostgresRecipeApplicationWatchQueries(sql),
    recipeApply: createPostgresRecipeApplyPersistence(
      sql,
      makeUnitOfWork,
      createPostgresPlanningUnitOfWork
    ),
    recipeCellRuns: createPostgresRecipeCellRunCreationPersistence(
      sql,
      makeUnitOfWork
    ),
    recipes,
    runExecution: makeRunExecution(sql),
    runQueries: makeRunQueries(sql),
    stepExecution: makeStepExecution(sql),
    stepQueries: makeStepQueries(sql),
    stepRouting: makeStepRouting(sql),
    verifyMigrations: async () => verifyPostgresMigrations(sql),
    verifyPlanningBundle: (input, expectedDefaultsRevision) =>
      verifyPostgresPlanningBundle(sql, input, expectedDefaultsRevision),
  };
};
