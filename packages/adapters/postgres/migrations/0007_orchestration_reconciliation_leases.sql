ALTER TABLE kurobara_core.run_orchestration_bindings
  ADD COLUMN reconciliation_claimed_by text,
  ADD COLUMN reconciliation_claim_token text,
  ADD COLUMN reconciliation_claimed_until timestamptz,
  ADD COLUMN reconciliation_attempts integer NOT NULL DEFAULT 0,
  ADD COLUMN next_reconciliation_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  ADD COLUMN last_reconciliation_error text,
  ADD CONSTRAINT run_orchestration_reconciliation_lease_consistent CHECK (
    (
      reconciliation_claimed_by IS NULL
      AND reconciliation_claim_token IS NULL
      AND reconciliation_claimed_until IS NULL
    )
    OR (
      state IN ('starting', 'reconciliation_required')
      AND reconciliation_claimed_by IS NOT NULL
      AND reconciliation_claim_token IS NOT NULL
      AND reconciliation_claimed_until IS NOT NULL
    )
  ),
  ADD CONSTRAINT run_orchestration_reconciliation_attempts_valid CHECK (
    reconciliation_attempts BETWEEN 0 AND 100
  ),
  ADD CONSTRAINT run_orchestration_reconciliation_error_valid CHECK (
    last_reconciliation_error IS NULL OR last_reconciliation_error <> ''
  );

DROP INDEX kurobara_core.run_orchestration_reconciliation_idx;

CREATE INDEX run_orchestration_reconciliation_idx
  ON kurobara_core.run_orchestration_bindings (
    workspace_id,
    adapter_key,
    next_reconciliation_at,
    updated_at
  )
  WHERE state IN ('starting', 'reconciliation_required');
