-- Deployment barrier: every worker older than 0014 must be drained before this
-- migration is applied. Older DAG writers do not enqueue step routing jobs, so
-- allowing them to remain active would reopen a crash window after this one-off
-- backfill.

ALTER TABLE kurobara_core.step_attempts
  ADD COLUMN route_key text,
  ADD COLUMN effect_adapter_key text,
  ADD COLUMN routing_decision_id text,
  ADD COLUMN route_snapshot_hash text;

UPDATE kurobara_core.step_attempts
SET
  route_key = COALESCE(
    NULLIF(attempt ->> 'routeKey', ''),
    'legacy-unattributed'
  ),
  effect_adapter_key = COALESCE(
    NULLIF(attempt ->> 'effectAdapterKey', ''),
    'legacy-unattributed'
  ),
  routing_decision_id = attempt ->> 'routingDecisionId',
  route_snapshot_hash = attempt ->> 'routeSnapshotHash';

-- route_key/effect_adapter_key use an explicit legacy marker because these
-- columns are needed to fence every new dispatch. The decision id and snapshot
-- hash remain NULL when historical payloads cannot prove their provenance;
-- migration must never synthesize a routing decision for an old attempt.
ALTER TABLE kurobara_core.step_attempts
  ALTER COLUMN route_key SET NOT NULL,
  ALTER COLUMN effect_adapter_key SET NOT NULL,
  ADD CONSTRAINT step_attempts_route_key_valid CHECK (length(route_key) > 0),
  ADD CONSTRAINT step_attempts_effect_adapter_key_valid CHECK (
    length(effect_adapter_key) > 0
  ),
  ADD CONSTRAINT step_attempts_routing_decision_id_valid CHECK (
    routing_decision_id IS NULL OR length(routing_decision_id) > 0
  ),
  ADD CONSTRAINT step_attempts_route_snapshot_hash_valid CHECK (
    route_snapshot_hash IS NULL
    OR route_snapshot_hash ~ '^sha256:[0-9a-f]{64}$'
  ),
  ADD CONSTRAINT step_attempts_routing_provenance_consistent CHECK (
    (routing_decision_id IS NULL AND route_snapshot_hash IS NULL)
    OR (routing_decision_id IS NOT NULL AND route_snapshot_hash IS NOT NULL)
  );

CREATE INDEX step_attempts_routing_decision_idx
  ON kurobara_core.step_attempts (
    workspace_id,
    routing_decision_id,
    step_run_id,
    attempt_number
  );

CREATE TABLE kurobara_core.routing_decisions (
  workspace_id text NOT NULL,
  routing_decision_id text NOT NULL,
  run_id text NOT NULL,
  step_run_id text NOT NULL,
  route_key text NOT NULL,
  effect_adapter_key text NOT NULL,
  route_snapshot_hash text NOT NULL,
  reservation_unit text NOT NULL,
  reserved_amount numeric NOT NULL,
  policy_version text NOT NULL,
  policy_facts_hash text NOT NULL,
  pricing_version text NOT NULL,
  decision jsonb NOT NULL,
  decided_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workspace_id, routing_decision_id),
  UNIQUE (workspace_id, step_run_id, routing_decision_id),
  FOREIGN KEY (workspace_id, run_id, step_run_id)
    REFERENCES kurobara_core.step_runs (
      workspace_id,
      run_id,
      step_run_id
    )
    DEFERRABLE INITIALLY DEFERRED,
  CHECK (length(route_key) > 0),
  CHECK (length(effect_adapter_key) > 0),
  CHECK (length(reservation_unit) > 0),
  CHECK (reserved_amount >= 0),
  CHECK (length(policy_version) > 0),
  CHECK (length(pricing_version) > 0),
  CHECK (route_snapshot_hash ~ '^sha256:[0-9a-f]{64}$'),
  CHECK (policy_facts_hash ~ '^sha256:[0-9a-f]{64}$'),
  CHECK (decision ->> 'workspaceId' = workspace_id),
  CHECK (decision ->> 'runId' = run_id),
  CHECK (decision ->> 'stepRunId' = step_run_id),
  CHECK (decision ->> 'routingDecisionId' = routing_decision_id),
  CHECK (decision ->> 'routeKey' = route_key),
  CHECK (decision ->> 'effectAdapterKey' = effect_adapter_key),
  CHECK (decision ->> 'routeSnapshotHash' = route_snapshot_hash)
);

CREATE FUNCTION kurobara_core.reject_immutable_routing_decision_change()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'Kurobara routing decisions are immutable'
    USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER routing_decisions_are_immutable
  BEFORE UPDATE OR DELETE ON kurobara_core.routing_decisions
  FOR EACH ROW EXECUTE FUNCTION
    kurobara_core.reject_immutable_routing_decision_change();

CREATE INDEX routing_decisions_step_idx
  ON kurobara_core.routing_decisions (
    workspace_id,
    step_run_id,
    decided_at,
    routing_decision_id
  );

CREATE TABLE kurobara_core.step_routing_jobs (
  workspace_id text NOT NULL,
  run_id text NOT NULL,
  step_run_id text NOT NULL,
  pending boolean NOT NULL DEFAULT true,
  attempts bigint NOT NULL DEFAULT 0,
  requested_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  next_attempt_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  last_error text,
  processed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workspace_id, step_run_id),
  FOREIGN KEY (workspace_id, run_id, step_run_id)
    REFERENCES kurobara_core.step_runs (
      workspace_id,
      run_id,
      step_run_id
    ),
  CHECK (attempts >= 0),
  CHECK (last_error IS NULL OR length(last_error) > 0),
  CHECK (
    (pending AND processed_at IS NULL)
    OR (NOT pending AND processed_at IS NOT NULL)
  )
);

CREATE INDEX step_routing_jobs_pending_idx
  ON kurobara_core.step_routing_jobs (
    next_attempt_at,
    requested_at,
    workspace_id,
    run_id,
    step_run_id
  )
  WHERE pending;

-- Only relationally coherent ready steps are backfilled. A legacy run plan has
-- no routeSnapshots member; its job is still enqueued so the application can
-- record the explicit no-route rejection without inventing an adapter.
INSERT INTO kurobara_core.step_routing_jobs (
  workspace_id,
  run_id,
  step_run_id,
  pending
)
SELECT
  step.workspace_id,
  step.run_id,
  step.step_run_id,
  true
FROM kurobara_core.step_runs AS step
JOIN kurobara_core.runs AS stored_run
  ON stored_run.workspace_id = step.workspace_id
  AND stored_run.run_id = step.run_id
WHERE step.state = 'ready'
  AND stored_run.run ->> 'state' = 'running'
  AND step.step_run ->> 'workspaceId' = step.workspace_id
  AND step.step_run ->> 'runId' = step.run_id
  AND step.step_run ->> 'stepRunId' = step.step_run_id
  AND step.step_run ->> 'nodeKey' = step.node_key
  AND step.step_run ->> 'state' = step.state
  AND (step.step_run ->> 'aggregateVersion')::integer = step.aggregate_version
  AND (step.step_run ->> 'eventSequence')::integer = step.event_sequence
  AND jsonb_typeof(step.step_run -> 'attempts') = 'array'
  AND NOT (step.step_run ? 'activeAttemptId')
  AND jsonb_array_length(step.step_run -> 'attempts') = (
    SELECT count(*)::integer
    FROM kurobara_core.step_attempts AS attempt
    WHERE attempt.workspace_id = step.workspace_id
      AND attempt.step_run_id = step.step_run_id
  )
  AND NOT EXISTS (
    SELECT 1
    FROM kurobara_core.step_attempts AS attempt
    WHERE attempt.workspace_id = step.workspace_id
      AND attempt.step_run_id = step.step_run_id
      AND attempt.state IN ('prepared', 'claimed', 'in_flight', 'ambiguous')
  )
ON CONFLICT (workspace_id, step_run_id) DO NOTHING;

-- Re-enqueue every running run after the routing backfill. This lets the DAG
-- scheduler repair any ready/retry boundary once the 0014 worker is the only
-- active writer.
INSERT INTO kurobara_core.run_dag_schedule_jobs (
  workspace_id,
  run_id,
  pending,
  requested_at,
  processed_at
)
SELECT
  workspace_id,
  run_id,
  true,
  clock_timestamp(),
  NULL
FROM kurobara_core.runs
WHERE run ->> 'state' = 'running'
ON CONFLICT (workspace_id, run_id) DO UPDATE SET
  pending = true,
  requested_at = clock_timestamp(),
  processed_at = NULL;

ALTER TABLE kurobara_core.step_command_journal
  DROP CONSTRAINT step_command_journal_command_type_check,
  ADD CONSTRAINT step_command_journal_command_type_check CHECK (
    command_type IN (
      'ClaimStepAttempt',
      'RejectStepRouting',
      'StartAttemptEffect',
      'RecordAttemptSucceeded',
      'RecordAttemptFailure',
      'RecordAttemptNotStarted',
      'AuthorizeRetry',
      'MarkAttemptAmbiguous',
      'ResolveAttemptAmbiguity',
      'CancelAttemptBeforeEffect'
    )
  );
