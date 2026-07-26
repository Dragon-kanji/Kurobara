ALTER TABLE kurobara_core.step_leaf_execution_bindings
  ADD COLUMN effect_adapter_key text,
  ADD CONSTRAINT step_leaf_execution_effect_adapter_key_valid CHECK (
    effect_adapter_key IS NULL OR length(effect_adapter_key) > 0
  );

CREATE TABLE kurobara_core.step_leaf_effect_recovery_jobs (
  workspace_id text NOT NULL,
  attempt_id text NOT NULL,
  effect_adapter_key text,
  state text NOT NULL DEFAULT 'pending',
  attempts integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL,
  next_attempt_at timestamptz NOT NULL,
  claimed_by text,
  claim_token text,
  claimed_until timestamptz,
  last_error text,
  finished_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workspace_id, attempt_id),
  FOREIGN KEY (workspace_id, attempt_id)
    REFERENCES kurobara_core.step_leaf_execution_bindings (
      workspace_id,
      attempt_id
    )
    DEFERRABLE INITIALLY DEFERRED,
  CHECK (state IN (
    'pending',
    'claimed',
    'retry',
    'completed',
    'exhausted',
    'blocked'
  )),
  CHECK (attempts BETWEEN 0 AND 100),
  CHECK (max_attempts BETWEEN 1 AND 100),
  CHECK (attempts <= max_attempts),
  CHECK (last_error IS NULL OR length(last_error) > 0),
  CHECK (
    (
      state = 'claimed'
      AND claimed_by IS NOT NULL
      AND length(claimed_by) > 0
      AND claim_token IS NOT NULL
      AND length(claim_token) > 0
      AND claimed_until IS NOT NULL
    )
    OR (
      state <> 'claimed'
      AND claimed_by IS NULL
      AND claim_token IS NULL
      AND claimed_until IS NULL
    )
  ),
  CHECK (
    (state = 'blocked' AND effect_adapter_key IS NULL)
    OR (
      state <> 'blocked'
      AND effect_adapter_key IS NOT NULL
      AND length(effect_adapter_key) > 0
    )
  ),
  CHECK (
    (state IN ('completed', 'exhausted') AND finished_at IS NOT NULL)
    OR (state NOT IN ('completed', 'exhausted') AND finished_at IS NULL)
  )
);

CREATE INDEX step_leaf_effect_recovery_claim_idx
  ON kurobara_core.step_leaf_effect_recovery_jobs (
    effect_adapter_key,
    next_attempt_at,
    updated_at,
    workspace_id,
    attempt_id
  )
  WHERE state IN ('pending', 'retry', 'claimed');

CREATE INDEX step_leaf_effect_recovery_reap_idx
  ON kurobara_core.step_leaf_effect_recovery_jobs (
    effect_adapter_key,
    attempts DESC,
    claimed_until NULLS FIRST,
    updated_at,
    workspace_id,
    attempt_id
  )
  WHERE state IN ('pending', 'retry', 'claimed', 'exhausted');

INSERT INTO kurobara_core.step_leaf_effect_recovery_jobs (
  workspace_id,
  attempt_id,
  effect_adapter_key,
  state,
  max_attempts,
  next_attempt_at,
  last_error
)
SELECT
  binding.workspace_id,
  binding.attempt_id,
  NULL,
  'blocked',
  1,
  clock_timestamp(),
  'leaf-effect-adapter-provenance-missing'
FROM kurobara_core.step_leaf_execution_bindings AS binding
WHERE binding.state = 'started'
ON CONFLICT (workspace_id, attempt_id) DO NOTHING;
