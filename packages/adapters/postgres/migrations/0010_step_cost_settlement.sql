ALTER TABLE kurobara_core.cost_reservations
  ADD COLUMN attempt_id text,
  ADD COLUMN step_run_id text;

DO $$
BEGIN
  IF EXISTS (
    SELECT attempt.workspace_id, attempt.reservation_id
    FROM kurobara_core.step_attempts AS attempt
    GROUP BY attempt.workspace_id, attempt.reservation_id
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION
      'Cannot bind a legacy cost reservation to more than one step attempt';
  END IF;
END
$$;

UPDATE kurobara_core.cost_reservations AS stored_reservation
SET
  attempt_id = attempt.attempt_id,
  step_run_id = attempt.step_run_id,
  reservation = jsonb_set(
    jsonb_set(
      stored_reservation.reservation,
      '{attemptId}',
      to_jsonb(attempt.attempt_id),
      true
    ),
    '{stepRunId}',
    to_jsonb(attempt.step_run_id),
    true
  )
FROM kurobara_core.step_attempts AS attempt
WHERE attempt.workspace_id = stored_reservation.workspace_id
  AND attempt.reservation_id = stored_reservation.reservation_id;

ALTER TABLE kurobara_core.step_runs
  ADD CONSTRAINT step_runs_run_identity_key
    UNIQUE (workspace_id, run_id, step_run_id);

ALTER TABLE kurobara_core.cost_reservations
  ALTER COLUMN attempt_id SET NOT NULL,
  ALTER COLUMN step_run_id SET NOT NULL,
  DROP CONSTRAINT IF EXISTS cost_reservations_state_check,
  DROP CONSTRAINT IF EXISTS cost_reservations_workspace_id_run_id_operation_key_key,
  ADD CONSTRAINT cost_reservations_state_check CHECK (
    state IN ('reserved', 'settled', 'released')
  ),
  ADD CONSTRAINT cost_reservations_attempt_key
    UNIQUE (workspace_id, attempt_id),
  ADD CONSTRAINT cost_reservations_attempt_reservation_key
    UNIQUE (workspace_id, attempt_id, reservation_id),
  ADD CONSTRAINT cost_reservations_run_reservation_key
    UNIQUE (workspace_id, run_id, reservation_id),
  ADD CONSTRAINT cost_reservations_step_run_fkey
    FOREIGN KEY (workspace_id, run_id, step_run_id)
    REFERENCES kurobara_core.step_runs (
      workspace_id,
      run_id,
      step_run_id
    )
    DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE kurobara_core.step_attempts
  DROP CONSTRAINT IF EXISTS step_attempts_workspace_id_reservation_id_fkey,
  ADD CONSTRAINT step_attempts_attempt_reservation_key
    UNIQUE (workspace_id, attempt_id, reservation_id),
  ADD CONSTRAINT step_attempts_reservation_pair_fkey
    FOREIGN KEY (workspace_id, attempt_id, reservation_id)
    REFERENCES kurobara_core.cost_reservations (
      workspace_id,
      attempt_id,
      reservation_id
    )
    DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE kurobara_core.cost_reservations
  ADD CONSTRAINT cost_reservations_attempt_pair_fkey
    FOREIGN KEY (workspace_id, attempt_id, reservation_id)
    REFERENCES kurobara_core.step_attempts (
      workspace_id,
      attempt_id,
      reservation_id
    )
    DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE kurobara_core.step_operation_bindings (
  workspace_id text NOT NULL,
  run_id text NOT NULL,
  operation_key text NOT NULL,
  step_run_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workspace_id, run_id, operation_key),
  UNIQUE (workspace_id, run_id, operation_key, step_run_id),
  FOREIGN KEY (workspace_id, run_id)
    REFERENCES kurobara_core.runs (workspace_id, run_id),
  FOREIGN KEY (workspace_id, run_id, step_run_id)
    REFERENCES kurobara_core.step_runs (
      workspace_id,
      run_id,
      step_run_id
    )
    DEFERRABLE INITIALLY DEFERRED,
  CHECK (length(operation_key) > 0)
);

INSERT INTO kurobara_core.step_operation_bindings (
  workspace_id,
  run_id,
  operation_key,
  step_run_id,
  created_at
)
SELECT
  reservation.workspace_id,
  reservation.run_id,
  reservation.operation_key,
  attempt.step_run_id,
  reservation.created_at
FROM kurobara_core.cost_reservations AS reservation
JOIN kurobara_core.step_attempts AS attempt
  ON attempt.workspace_id = reservation.workspace_id
  AND attempt.attempt_id = reservation.attempt_id;

ALTER TABLE kurobara_core.cost_reservations
  ADD CONSTRAINT cost_reservations_operation_binding_fkey
    FOREIGN KEY (workspace_id, run_id, operation_key, step_run_id)
    REFERENCES kurobara_core.step_operation_bindings (
      workspace_id,
      run_id,
      operation_key,
      step_run_id
    )
    DEFERRABLE INITIALLY DEFERRED;

CREATE INDEX cost_reservations_operation_idx
  ON kurobara_core.cost_reservations (
    workspace_id,
    run_id,
    operation_key,
    created_at
  );

CREATE TABLE kurobara_core.usage_ledger_entries (
  workspace_id text NOT NULL,
  usage_entry_id text NOT NULL,
  run_id text NOT NULL,
  attempt_id text NOT NULL,
  reservation_id text NOT NULL,
  operation_key text NOT NULL,
  unit text NOT NULL,
  amount numeric NOT NULL,
  entry jsonb NOT NULL,
  recorded_at timestamptz NOT NULL,
  PRIMARY KEY (workspace_id, usage_entry_id),
  UNIQUE (workspace_id, reservation_id),
  FOREIGN KEY (workspace_id, run_id)
    REFERENCES kurobara_core.runs (workspace_id, run_id),
  FOREIGN KEY (workspace_id, attempt_id)
    REFERENCES kurobara_core.step_attempts (workspace_id, attempt_id),
  FOREIGN KEY (workspace_id, reservation_id)
    REFERENCES kurobara_core.cost_reservations (workspace_id, reservation_id),
  FOREIGN KEY (workspace_id, run_id, reservation_id)
    REFERENCES kurobara_core.cost_reservations (
      workspace_id,
      run_id,
      reservation_id
    ),
  FOREIGN KEY (workspace_id, attempt_id, reservation_id)
    REFERENCES kurobara_core.step_attempts (
      workspace_id,
      attempt_id,
      reservation_id
    ),
  CHECK (length(operation_key) > 0),
  CHECK (length(unit) > 0),
  CHECK (amount >= 0)
);

CREATE INDEX usage_ledger_run_recorded_idx
  ON kurobara_core.usage_ledger_entries (
    workspace_id,
    run_id,
    recorded_at
  );

CREATE INDEX usage_ledger_attempt_idx
  ON kurobara_core.usage_ledger_entries (workspace_id, attempt_id);

UPDATE kurobara_core.step_command_journal
SET proof = jsonb_set(proof, '{actorId}', to_jsonb(actor_id), true)
WHERE NOT (proof ? 'actorId');

ALTER TABLE kurobara_core.step_command_journal
  DROP CONSTRAINT IF EXISTS step_command_journal_command_type_check,
  ADD CONSTRAINT step_command_journal_command_type_check CHECK (
    command_type IN (
      'ClaimStepAttempt',
      'StartAttemptEffect',
      'RecordAttemptSucceeded',
      'RecordAttemptFailure',
      'AuthorizeRetry',
      'MarkAttemptAmbiguous',
      'ResolveAttemptAmbiguity',
      'CancelAttemptBeforeEffect'
    )
  );
