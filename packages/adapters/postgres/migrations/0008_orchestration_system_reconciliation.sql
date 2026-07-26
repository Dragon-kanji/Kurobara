ALTER TABLE kurobara_core.run_orchestration_bindings
  DROP CONSTRAINT run_orchestration_bindings_state_check,
  DROP CONSTRAINT run_orchestration_bindings_check,
  ADD CONSTRAINT run_orchestration_bindings_state_check CHECK (state IN (
    'pending',
    'starting',
    'started',
    'reconciliation_required',
    'reconciliation_exhausted'
  )),
  ADD CONSTRAINT run_orchestration_bindings_check CHECK (
    (state = 'pending' AND adapter_key IS NULL AND orchestration_run_id IS NULL)
    OR (state = 'starting' AND adapter_key IS NOT NULL AND orchestration_run_id IS NULL)
    OR (state = 'reconciliation_required' AND orchestration_run_id IS NULL)
    OR (
      state = 'reconciliation_exhausted'
      AND adapter_key IS NOT NULL
      AND orchestration_run_id IS NULL
    )
    OR (state = 'started' AND adapter_key IS NOT NULL AND orchestration_run_id IS NOT NULL)
  );

DROP INDEX kurobara_core.run_orchestration_reconciliation_idx;

CREATE INDEX run_orchestration_system_reconciliation_idx
  ON kurobara_core.run_orchestration_bindings (
    adapter_key,
    next_reconciliation_at,
    updated_at,
    created_at,
    workspace_id,
    run_id
  )
  WHERE state IN ('starting', 'reconciliation_required');

CREATE INDEX run_orchestration_system_exhaustion_idx
  ON kurobara_core.run_orchestration_bindings (
    adapter_key,
    reconciliation_attempts DESC,
    reconciliation_claimed_until NULLS FIRST,
    updated_at,
    created_at,
    workspace_id,
    run_id
  )
  WHERE state IN ('starting', 'reconciliation_required');
