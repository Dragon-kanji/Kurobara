ALTER TABLE kurobara_core.outbox_messages
  ADD COLUMN cancelled_at timestamptz,
  DROP CONSTRAINT outbox_messages_state_check,
  ADD CONSTRAINT outbox_messages_state_check CHECK (
    state IN (
      'pending',
      'claimed',
      'retry',
      'dispatched',
      'dead_letter',
      'cancelled'
    )
  ),
  ADD CONSTRAINT outbox_messages_cancelled_at_consistent CHECK (
    (state = 'cancelled' AND cancelled_at IS NOT NULL)
    OR (state <> 'cancelled' AND cancelled_at IS NULL)
  );

ALTER TABLE kurobara_core.step_attempts
  ADD CONSTRAINT step_attempts_leaf_identity_key UNIQUE (
    workspace_id,
    step_run_id,
    attempt_id,
    reservation_id,
    operation_key
  );

ALTER TABLE kurobara_core.step_events
  ADD CONSTRAINT step_events_leaf_identity_key UNIQUE (
    workspace_id,
    step_run_id,
    event_id
  );

ALTER TABLE kurobara_core.step_command_journal
  DROP CONSTRAINT step_command_journal_command_type_check,
  ADD CONSTRAINT step_command_journal_command_type_check CHECK (
    command_type IN (
      'ClaimStepAttempt',
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

CREATE TABLE kurobara_core.step_leaf_execution_bindings (
  workspace_id text NOT NULL,
  run_id text NOT NULL,
  step_run_id text NOT NULL,
  attempt_id text NOT NULL,
  event_id text NOT NULL,
  reservation_id text NOT NULL,
  operation_key text NOT NULL,
  outbox_message_id text NOT NULL,
  start_key text NOT NULL,
  state text NOT NULL DEFAULT 'pending',
  adapter_key text,
  external_execution_id text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workspace_id, attempt_id),
  UNIQUE (workspace_id, outbox_message_id),
  UNIQUE (workspace_id, start_key),
  UNIQUE (workspace_id, adapter_key, external_execution_id),
  FOREIGN KEY (workspace_id, run_id, step_run_id)
    REFERENCES kurobara_core.step_runs (
      workspace_id,
      run_id,
      step_run_id
    )
    DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (
    workspace_id,
    step_run_id,
    attempt_id,
    reservation_id,
    operation_key
  ) REFERENCES kurobara_core.step_attempts (
    workspace_id,
    step_run_id,
    attempt_id,
    reservation_id,
    operation_key
  )
    DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (workspace_id, step_run_id, event_id)
    REFERENCES kurobara_core.step_events (
      workspace_id,
      step_run_id,
      event_id
    )
    DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (workspace_id, attempt_id, reservation_id)
    REFERENCES kurobara_core.cost_reservations (
      workspace_id,
      attempt_id,
      reservation_id
    )
    DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (workspace_id, run_id, operation_key, step_run_id)
    REFERENCES kurobara_core.step_operation_bindings (
      workspace_id,
      run_id,
      operation_key,
      step_run_id
    )
    DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (workspace_id, run_id, outbox_message_id)
    REFERENCES kurobara_core.outbox_messages (
      workspace_id,
      aggregate_id,
      message_id
    )
    DEFERRABLE INITIALLY DEFERRED,
  CHECK (length(operation_key) > 0),
  CHECK (length(start_key) > 0),
  CHECK (adapter_key IS NULL OR length(adapter_key) > 0),
  CHECK (external_execution_id IS NULL OR length(external_execution_id) > 0),
  CHECK (state IN (
    'pending',
    'starting',
    'started',
    'reconciliation_required',
    'reconciliation_exhausted',
    'rejected',
    'cancelled'
  )),
  CHECK (
    (state = 'pending' AND adapter_key IS NULL AND external_execution_id IS NULL)
    OR (
      state IN ('starting', 'reconciliation_required', 'reconciliation_exhausted')
      AND adapter_key IS NOT NULL
      AND external_execution_id IS NULL
    )
    OR (
      state = 'started'
      AND adapter_key IS NOT NULL
      AND external_execution_id IS NOT NULL
    )
    OR (
      state IN ('rejected', 'cancelled')
      AND (external_execution_id IS NULL OR adapter_key IS NOT NULL)
    )
  )
);

CREATE INDEX leaf_outbox_dispatch_idx
  ON kurobara_core.outbox_messages (
    available_at,
    created_at,
    workspace_id,
    message_id
  )
  WHERE destination = 'orchestration.step.attempt.claimed'
    AND state IN ('pending', 'retry');

CREATE INDEX leaf_outbox_expired_claim_idx
  ON kurobara_core.outbox_messages (
    claimed_until,
    workspace_id,
    message_id
  )
  WHERE destination = 'orchestration.step.attempt.claimed'
    AND state = 'claimed';

CREATE INDEX step_leaf_execution_reconciliation_idx
  ON kurobara_core.step_leaf_execution_bindings (
    adapter_key,
    updated_at,
    workspace_id,
    attempt_id
  )
  WHERE state IN ('starting', 'reconciliation_required');
