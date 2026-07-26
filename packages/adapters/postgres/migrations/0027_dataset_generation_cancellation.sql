-- One explicit stop request is durable, tenant-scoped and idempotent. The
-- generation closes authorization immediately while a page beyond its effect
-- threshold is allowed to reach only a certain or ambiguous issue.

ALTER TABLE kurobara_core.dataset_generations
  ADD COLUMN stop_reason text,
  ADD COLUMN stop_requested_at timestamptz,
  ADD CONSTRAINT dataset_generations_stop_consistent CHECK (
    (stop_reason IS NULL AND stop_requested_at IS NULL)
    OR (
      stop_reason = 'requested'
      AND stop_requested_at IS NOT NULL
      AND stop_requested_at >= created_at
      AND state IN ('stopping', 'cancelled', 'ambiguous')
    )
  );

CREATE TABLE kurobara_core.dataset_generation_cancellation_journal (
  workspace_id text NOT NULL,
  idempotency_key text NOT NULL,
  generation_id text NOT NULL,
  command_hash text NOT NULL,
  requested_at timestamptz NOT NULL,
  PRIMARY KEY (workspace_id, idempotency_key),
  FOREIGN KEY (workspace_id, generation_id)
    REFERENCES kurobara_core.dataset_generations (
      workspace_id,
      generation_id
    ),
  CHECK (char_length(idempotency_key) BETWEEN 1 AND 512),
  CHECK (btrim(idempotency_key) = idempotency_key),
  CHECK (command_hash ~ '^sha256:[0-9a-f]{64}$')
);

CREATE FUNCTION kurobara_core.reject_dataset_generation_cancellation_journal_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'Kurobara generation cancellation journal is append-only'
    USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER dataset_generation_cancellation_journal_is_append_only
  BEFORE UPDATE OR DELETE
  ON kurobara_core.dataset_generation_cancellation_journal
  FOR EACH ROW EXECUTE FUNCTION
    kurobara_core.reject_dataset_generation_cancellation_journal_mutation();

DROP TRIGGER dataset_generation_progress_is_guarded
  ON kurobara_core.dataset_generations;
DROP FUNCTION kurobara_core.guard_dataset_generation_progress();

CREATE FUNCTION kurobara_core.guard_dataset_generation_progress()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Kurobara dataset generations cannot be deleted'
      USING ERRCODE = '55000';
  END IF;
  IF OLD.workspace_id IS DISTINCT FROM NEW.workspace_id
    OR OLD.generation_id IS DISTINCT FROM NEW.generation_id
    OR OLD.generation_plan_id IS DISTINCT FROM NEW.generation_plan_id
    OR OLD.dataset_id IS DISTINCT FROM NEW.dataset_id
    OR OLD.materialization_id IS DISTINCT FROM NEW.materialization_id
    OR OLD.plan_hash IS DISTINCT FROM NEW.plan_hash
    OR OLD.query_hash IS DISTINCT FROM NEW.query_hash
    OR OLD.schema_hash IS DISTINCT FROM NEW.schema_hash
    OR OLD.request_intent_hash IS DISTINCT FROM NEW.request_intent_hash
    OR OLD.capability_id IS DISTINCT FROM NEW.capability_id
    OR OLD.capability_version IS DISTINCT FROM NEW.capability_version
    OR OLD.cost_unit IS DISTINCT FROM NEW.cost_unit
    OR OLD.created_at IS DISTINCT FROM NEW.created_at THEN
    RAISE EXCEPTION 'Kurobara dataset generation identity is immutable'
      USING ERRCODE = '55000';
  END IF;
  IF OLD.state IN ('completed', 'failed', 'cancelled', 'ambiguous')
    AND OLD IS DISTINCT FROM NEW THEN
    RAISE EXCEPTION 'Kurobara terminal dataset generations are immutable'
      USING ERRCODE = '55000';
  END IF;
  IF NEW.aggregate_version <> OLD.aggregate_version + 1 THEN
    RAISE EXCEPTION 'Kurobara generation version must advance once'
      USING ERRCODE = '55000';
  END IF;
  IF OLD.locked_provider IS NOT NULL
    AND NEW.locked_provider IS DISTINCT FROM OLD.locked_provider THEN
    RAISE EXCEPTION 'Kurobara generation provider lock is immutable'
      USING ERRCODE = '55000';
  END IF;
  IF OLD.stop_requested_at IS NOT NULL AND (
    NEW.stop_requested_at IS DISTINCT FROM OLD.stop_requested_at
    OR NEW.stop_reason IS DISTINCT FROM OLD.stop_reason
  ) THEN
    RAISE EXCEPTION 'Kurobara generation stop request is immutable'
      USING ERRCODE = '55000';
  END IF;

  -- Effect authorization reserves exactly one additional page/call.
  IF OLD.state IN ('planned', 'running') AND NEW.state = 'running'
    AND NEW.call_count = OLD.call_count + 1
    AND NEW.page_count = OLD.page_count + 1 THEN
    IF NEW.accepted_count <> OLD.accepted_count
      OR NEW.duplicate_count <> OLD.duplicate_count
      OR NEW.rejected_count <> OLD.rejected_count
      OR NEW.returned_count <> OLD.returned_count
      OR NEW.cost_reserved <= OLD.cost_reserved
      OR NEW.cost_spent <> OLD.cost_spent
      OR NEW.last_committed_page_sequence IS DISTINCT FROM
        OLD.last_committed_page_sequence
      OR NEW.stop_requested_at IS NOT NULL THEN
      RAISE EXCEPTION 'Invalid generation page authorization'
        USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
  END IF;

  -- A successful page checkpoint may settle while an explicit stop is held.
  IF OLD.state IN ('running', 'stopping') AND NEW.state = OLD.state
    AND NEW.call_count = OLD.call_count
    AND NEW.page_count = OLD.page_count THEN
    IF NEW.accepted_count < OLD.accepted_count
      OR NEW.duplicate_count < OLD.duplicate_count
      OR NEW.rejected_count < OLD.rejected_count
      OR NEW.returned_count < OLD.returned_count
      OR NEW.cost_reserved <> 0
      OR NEW.cost_spent < OLD.cost_spent
      OR NEW.locked_provider IS NULL
      OR NEW.last_committed_page_sequence <> NEW.page_count THEN
      RAISE EXCEPTION 'Invalid generation page checkpoint'
        USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.state = 'running' AND NEW.state = 'completed' THEN
    IF NEW.call_count <> OLD.call_count
      OR NEW.page_count <> OLD.page_count
      OR NEW.accepted_count <> OLD.accepted_count
      OR NEW.duplicate_count <> OLD.duplicate_count
      OR NEW.rejected_count <> OLD.rejected_count
      OR NEW.returned_count <> OLD.returned_count
      OR NEW.cost_reserved <> 0
      OR NEW.cost_spent <> OLD.cost_spent
      OR NEW.last_committed_page_sequence <> NEW.page_count
      OR NEW.stop_requested_at IS NOT NULL THEN
      RAISE EXCEPTION 'Invalid generation readiness projection'
        USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.state = 'running' AND NEW.state IN ('failed', 'ambiguous') THEN
    IF NEW.call_count <> OLD.call_count
      OR NEW.page_count <> OLD.page_count
      OR NEW.accepted_count <> OLD.accepted_count
      OR NEW.duplicate_count <> OLD.duplicate_count
      OR NEW.rejected_count <> OLD.rejected_count
      OR NEW.returned_count <> OLD.returned_count
      OR NEW.cost_spent <> OLD.cost_spent THEN
      RAISE EXCEPTION 'Invalid generation terminal stop projection'
        USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
  END IF;

  -- Explicit stop closes the next-page authority without erasing progress.
  IF OLD.state IN ('planned', 'running')
    AND NEW.state IN ('stopping', 'cancelled') THEN
    IF NEW.stop_reason <> 'requested'
      OR NEW.stop_requested_at IS NULL
      OR NEW.call_count <> OLD.call_count
      OR NEW.page_count <> OLD.page_count
      OR NEW.accepted_count <> OLD.accepted_count
      OR NEW.duplicate_count <> OLD.duplicate_count
      OR NEW.rejected_count <> OLD.rejected_count
      OR NEW.returned_count <> OLD.returned_count
      OR NEW.cost_reserved <> OLD.cost_reserved
      OR NEW.cost_spent <> OLD.cost_spent THEN
      RAISE EXCEPTION 'Invalid generation explicit stop request'
        USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
  END IF;

  -- A stopping generation converges only after a certain or ambiguous issue.
  IF OLD.state = 'stopping' AND NEW.state IN ('cancelled', 'ambiguous') THEN
    IF NEW.call_count <> OLD.call_count
      OR NEW.page_count <> OLD.page_count
      OR NEW.accepted_count <> OLD.accepted_count
      OR NEW.duplicate_count <> OLD.duplicate_count
      OR NEW.rejected_count <> OLD.rejected_count
      OR NEW.returned_count <> OLD.returned_count
      OR NEW.cost_spent <> OLD.cost_spent
      OR (NEW.state = 'cancelled' AND NEW.cost_reserved <> 0)
      OR (NEW.state = 'ambiguous'
        AND NEW.cost_reserved <> OLD.cost_reserved) THEN
      RAISE EXCEPTION 'Invalid generation stop convergence'
        USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'Unsupported Kurobara generation transition'
    USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER dataset_generation_progress_is_guarded
  BEFORE UPDATE OR DELETE ON kurobara_core.dataset_generations
  FOR EACH ROW EXECUTE FUNCTION
    kurobara_core.guard_dataset_generation_progress();
