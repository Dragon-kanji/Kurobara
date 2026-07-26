ALTER TABLE kurobara_core.outbox_messages
  ADD CONSTRAINT outbox_messages_binding_identity_unique
  UNIQUE (workspace_id, aggregate_id, message_id);

CREATE TABLE kurobara_core.run_orchestration_bindings (
  workspace_id text NOT NULL,
  run_id text NOT NULL,
  outbox_message_id text NOT NULL UNIQUE,
  start_key text NOT NULL,
  state text NOT NULL DEFAULT 'pending',
  adapter_key text,
  orchestration_run_id text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workspace_id, run_id),
  UNIQUE (workspace_id, start_key),
  UNIQUE (workspace_id, adapter_key, orchestration_run_id),
  FOREIGN KEY (workspace_id, run_id)
    REFERENCES kurobara_core.runs (workspace_id, run_id),
  FOREIGN KEY (workspace_id, run_id, outbox_message_id)
    REFERENCES kurobara_core.outbox_messages (
      workspace_id,
      aggregate_id,
      message_id
    ),
  CHECK (start_key <> ''),
  CHECK (adapter_key IS NULL OR adapter_key <> ''),
  CHECK (orchestration_run_id IS NULL OR orchestration_run_id <> ''),
  CHECK (state IN (
    'pending',
    'starting',
    'started',
    'reconciliation_required'
  )),
  CHECK (
    (state = 'pending' AND adapter_key IS NULL AND orchestration_run_id IS NULL)
    OR (state = 'starting' AND adapter_key IS NOT NULL AND orchestration_run_id IS NULL)
    OR (state = 'reconciliation_required' AND orchestration_run_id IS NULL)
    OR (state = 'started' AND adapter_key IS NOT NULL AND orchestration_run_id IS NOT NULL)
  )
);

INSERT INTO kurobara_core.run_orchestration_bindings (
  workspace_id,
  run_id,
  outbox_message_id,
  start_key,
  state,
  adapter_key,
  orchestration_run_id
)
SELECT
  workspace_id,
  aggregate_id,
  message_id,
  message_id,
  CASE
    WHEN orchestration_run_id IS NOT NULL THEN 'started'
    WHEN state = 'claimed' THEN 'reconciliation_required'
    ELSE 'pending'
  END,
  CASE
    WHEN orchestration_run_id IS NOT NULL THEN 'legacy-unattributed'
    ELSE NULL
  END,
  orchestration_run_id
FROM kurobara_core.outbox_messages
WHERE destination = 'orchestration.run.queued';

CREATE INDEX run_orchestration_reconciliation_idx
  ON kurobara_core.run_orchestration_bindings (updated_at)
  WHERE state = 'reconciliation_required';

CREATE TABLE kurobara_core.run_command_journal (
  workspace_id text NOT NULL,
  run_id text NOT NULL,
  command_idempotency_key text NOT NULL,
  command_hash text NOT NULL,
  command_type text NOT NULL,
  actor_id text NOT NULL,
  correlation_id text NOT NULL,
  proof jsonb NOT NULL,
  accepted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workspace_id, run_id, command_idempotency_key),
  FOREIGN KEY (workspace_id, run_id)
    REFERENCES kurobara_core.runs (workspace_id, run_id),
  CHECK (command_idempotency_key <> ''),
  CHECK (command_hash ~ '^sha256:[0-9a-f]{64}$'),
  CHECK (command_type <> ''),
  CHECK (actor_id <> ''),
  CHECK (correlation_id <> '')
);
