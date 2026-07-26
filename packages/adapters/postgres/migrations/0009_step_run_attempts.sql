CREATE TABLE IF NOT EXISTS kurobara_core.step_runs (
  workspace_id text NOT NULL,
  step_run_id text NOT NULL,
  run_id text NOT NULL,
  node_key text NOT NULL,
  state text NOT NULL,
  aggregate_version integer NOT NULL,
  event_sequence integer NOT NULL,
  step_run jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workspace_id, step_run_id),
  UNIQUE (workspace_id, run_id, node_key),
  FOREIGN KEY (workspace_id, run_id)
    REFERENCES kurobara_core.runs (workspace_id, run_id),
  CHECK (length(node_key) > 0),
  CHECK (aggregate_version > 0),
  CHECK (event_sequence > 0),
  CHECK (
    state IN (
      'pending',
      'ready',
      'active',
      'waiting',
      'retryable',
      'ambiguous',
      'cancelling',
      'succeeded',
      'failed',
      'cancelled',
      'skipped'
    )
  )
);

CREATE INDEX IF NOT EXISTS step_runs_succeeded_dependency_idx
  ON kurobara_core.step_runs (workspace_id, run_id, node_key)
  WHERE state = 'succeeded';

CREATE TABLE IF NOT EXISTS kurobara_core.cost_reservations (
  workspace_id text NOT NULL,
  reservation_id text NOT NULL,
  run_id text NOT NULL,
  operation_key text NOT NULL,
  unit text NOT NULL,
  amount numeric NOT NULL,
  state text NOT NULL,
  reservation jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (workspace_id, reservation_id),
  UNIQUE (workspace_id, run_id, operation_key),
  FOREIGN KEY (workspace_id, run_id)
    REFERENCES kurobara_core.runs (workspace_id, run_id),
  CHECK (length(operation_key) > 0),
  CHECK (length(unit) > 0),
  CHECK (amount >= 0),
  CHECK (state = 'reserved')
);

CREATE TABLE IF NOT EXISTS kurobara_core.step_attempts (
  workspace_id text NOT NULL,
  attempt_id text NOT NULL,
  step_run_id text NOT NULL,
  attempt_number integer NOT NULL,
  operation_key text NOT NULL,
  reservation_id text NOT NULL,
  state text NOT NULL,
  attempt jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (workspace_id, attempt_id),
  UNIQUE (workspace_id, step_run_id, attempt_number),
  FOREIGN KEY (workspace_id, step_run_id)
    REFERENCES kurobara_core.step_runs (workspace_id, step_run_id),
  FOREIGN KEY (workspace_id, reservation_id)
    REFERENCES kurobara_core.cost_reservations (workspace_id, reservation_id),
  CHECK (attempt_number > 0),
  CHECK (length(operation_key) > 0),
  CHECK (
    state IN (
      'prepared',
      'claimed',
      'in_flight',
      'succeeded',
      'failed_retryable',
      'failed_terminal',
      'ambiguous',
      'cancelled_before_effect'
    )
  )
);

CREATE TABLE IF NOT EXISTS kurobara_core.step_events (
  workspace_id text NOT NULL,
  step_run_id text NOT NULL,
  sequence integer NOT NULL,
  event_id text NOT NULL,
  event jsonb NOT NULL,
  occurred_at timestamptz NOT NULL,
  PRIMARY KEY (workspace_id, step_run_id, sequence),
  UNIQUE (workspace_id, event_id),
  FOREIGN KEY (workspace_id, step_run_id)
    REFERENCES kurobara_core.step_runs (workspace_id, step_run_id),
  CHECK (sequence > 0)
);

CREATE TABLE IF NOT EXISTS kurobara_core.step_command_journal (
  workspace_id text NOT NULL,
  step_run_id text NOT NULL,
  command_idempotency_key text NOT NULL,
  command_hash text NOT NULL,
  command_type text NOT NULL,
  actor_id text NOT NULL,
  correlation_id text NOT NULL,
  proof jsonb NOT NULL,
  accepted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workspace_id, step_run_id, command_idempotency_key),
  FOREIGN KEY (workspace_id, step_run_id)
    REFERENCES kurobara_core.step_runs (workspace_id, step_run_id),
  CHECK (length(command_idempotency_key) > 0),
  CHECK (command_type = 'ClaimStepAttempt')
);
