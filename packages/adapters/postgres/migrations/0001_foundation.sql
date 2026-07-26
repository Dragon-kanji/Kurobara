CREATE SCHEMA IF NOT EXISTS kurobara_core;

CREATE TABLE IF NOT EXISTS kurobara_core.run_plans (
  workspace_id text NOT NULL,
  run_plan_id text NOT NULL,
  plan jsonb NOT NULL,
  consumed_by jsonb,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workspace_id, run_plan_id),
  CHECK ((consumed_by IS NULL) = (consumed_at IS NULL))
);

CREATE TABLE IF NOT EXISTS kurobara_core.runs (
  workspace_id text NOT NULL,
  run_id text NOT NULL,
  run_plan_id text NOT NULL,
  idempotency_key text NOT NULL,
  intention_hash text NOT NULL,
  run jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workspace_id, run_id),
  UNIQUE (workspace_id, idempotency_key),
  FOREIGN KEY (workspace_id, run_plan_id)
    REFERENCES kurobara_core.run_plans (workspace_id, run_plan_id)
);

CREATE TABLE IF NOT EXISTS kurobara_core.run_events (
  workspace_id text NOT NULL,
  run_id text NOT NULL,
  sequence integer NOT NULL,
  event_id text NOT NULL,
  event jsonb NOT NULL,
  occurred_at timestamptz NOT NULL,
  PRIMARY KEY (workspace_id, run_id, sequence),
  UNIQUE (workspace_id, event_id),
  FOREIGN KEY (workspace_id, run_id)
    REFERENCES kurobara_core.runs (workspace_id, run_id)
);

CREATE TABLE IF NOT EXISTS kurobara_core.outbox_messages (
  message_id text PRIMARY KEY,
  workspace_id text NOT NULL,
  aggregate_id text NOT NULL,
  aggregate_version integer NOT NULL,
  event_id text NOT NULL,
  destination text NOT NULL,
  event jsonb NOT NULL,
  state text NOT NULL DEFAULT 'pending',
  available_at timestamptz NOT NULL,
  claimed_by text,
  claim_token text,
  claimed_until timestamptz,
  attempts integer NOT NULL DEFAULT 0,
  orchestration_run_id text,
  last_error text,
  dispatched_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (workspace_id, event_id, destination),
  FOREIGN KEY (workspace_id, aggregate_id)
    REFERENCES kurobara_core.runs (workspace_id, run_id),
  CHECK (state IN ('pending', 'claimed', 'retry', 'dispatched', 'dead_letter')),
  CHECK (attempts >= 0),
  CHECK (
    (
      state = 'claimed'
      AND claimed_by IS NOT NULL
      AND claim_token IS NOT NULL
      AND claimed_until IS NOT NULL
    )
    OR (
      state <> 'claimed'
      AND claimed_by IS NULL
      AND claim_token IS NULL
      AND claimed_until IS NULL
    )
  )
);

CREATE INDEX IF NOT EXISTS outbox_messages_dispatch_idx
  ON kurobara_core.outbox_messages (available_at, created_at)
  WHERE state IN ('pending', 'retry');

CREATE INDEX IF NOT EXISTS outbox_messages_expired_claim_idx
  ON kurobara_core.outbox_messages (claimed_until)
  WHERE state = 'claimed';
