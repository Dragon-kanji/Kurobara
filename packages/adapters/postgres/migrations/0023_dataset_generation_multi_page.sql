-- KRB-DATASET-GEN-001 completes the internal generation runtime: every page
-- remains a canonical Run, while PostgreSQL owns cursor continuity, durable
-- deduplication, monotone counters, readiness, and terminal stop states.

ALTER TABLE kurobara_core.dataset_generation_pages
  DROP CONSTRAINT dataset_generation_pages_state_check,
  DROP CONSTRAINT dataset_generation_pages_input_cursor_check,
  ADD CONSTRAINT dataset_generation_pages_state_check CHECK (
    state IN ('run_created', 'executing', 'committed', 'failed', 'ambiguous')
  ),
  ADD CONSTRAINT dataset_generation_pages_cursor_sequence_check CHECK (
    (page_sequence = 1 AND input_cursor IS NULL)
    OR (page_sequence > 1 AND input_cursor IS NOT NULL
      AND char_length(input_cursor) BETWEEN 1 AND 4096
      AND btrim(input_cursor) <> '')
  );

DO $$
DECLARE
  lifecycle_constraint text;
BEGIN
  SELECT constraint_record.conname
  INTO lifecycle_constraint
  FROM pg_constraint AS constraint_record
  WHERE constraint_record.conrelid =
      'kurobara_core.dataset_generation_pages'::regclass
    AND constraint_record.contype = 'c'
    AND pg_get_constraintdef(constraint_record.oid) LIKE
      '%state = ''run_created''%step_run_id IS NULL%';

  IF lifecycle_constraint IS NULL THEN
    RAISE EXCEPTION 'Dataset generation page lifecycle constraint is missing'
      USING ERRCODE = '23514';
  END IF;

  EXECUTE format(
    'ALTER TABLE kurobara_core.dataset_generation_pages DROP CONSTRAINT %I',
    lifecycle_constraint
  );
END;
$$;

ALTER TABLE kurobara_core.dataset_generation_pages
  ADD CONSTRAINT dataset_generation_pages_lifecycle_check CHECK (
    (state = 'run_created'
      AND step_run_id IS NULL
      AND attempt_id IS NULL
      AND operation_key IS NULL
      AND routing_decision_id IS NULL
      AND reservation_id IS NULL
      AND artifact_id IS NULL
      AND result_manifest_id IS NULL
      AND usage_entry_id IS NULL
      AND checkpoint_hash IS NULL
      AND committed_at IS NULL)
    OR (state IN ('executing', 'failed', 'ambiguous')
      AND step_run_id IS NOT NULL
      AND attempt_id IS NOT NULL
      AND operation_key IS NOT NULL
      AND routing_decision_id IS NOT NULL
      AND route_key IS NOT NULL
      AND provider_key IS NOT NULL
      AND route_snapshot_hash IS NOT NULL
      AND reservation_id IS NOT NULL
      AND reserved_amount IS NOT NULL
      AND cost_unit IS NOT NULL
      AND artifact_id IS NULL
      AND result_manifest_id IS NULL
      AND usage_entry_id IS NULL
      AND checkpoint_hash IS NULL
      AND committed_at IS NULL)
    OR (state = 'committed'
      AND step_run_id IS NOT NULL
      AND attempt_id IS NOT NULL
      AND operation_key IS NOT NULL
      AND routing_decision_id IS NOT NULL
      AND route_key IS NOT NULL
      AND provider_key IS NOT NULL
      AND route_snapshot_hash IS NOT NULL
      AND reservation_id IS NOT NULL
      AND reserved_amount IS NOT NULL
      AND cost_unit IS NOT NULL
      AND artifact_id IS NOT NULL
      AND artifact_content_hash IS NOT NULL
      AND result_manifest_id IS NOT NULL
      AND result_manifest_hash IS NOT NULL
      AND usage_entry_id IS NOT NULL
      AND cost_amount IS NOT NULL
      AND returned_count IS NOT NULL
      AND accepted_count IS NOT NULL
      AND duplicate_count IS NOT NULL
      AND rejected_count IS NOT NULL
      AND has_more IS NOT NULL
      AND source_partition_completed IS NOT NULL
      AND checkpoint_hash IS NOT NULL
      AND committed_at IS NOT NULL)
  );

ALTER TABLE kurobara_core.dataset_generations
  DROP CONSTRAINT dataset_generations_provider_lock_consistent,
  ADD CONSTRAINT dataset_generations_provider_lock_consistent CHECK (
    (locked_provider IS NULL AND last_committed_page_sequence IS NULL)
    OR (
      locked_provider IS NOT NULL
      AND char_length(locked_provider) BETWEEN 1 AND 255
      AND btrim(locked_provider) <> ''
      AND last_committed_page_sequence IS NOT NULL
      AND last_committed_page_sequence > 0
      AND last_committed_page_sequence IN (page_count, page_count - 1)
    )
  );

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
        OLD.last_committed_page_sequence THEN
      RAISE EXCEPTION 'Invalid generation page authorization'
        USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
  END IF;

  -- Successful checkpoint settles the in-flight page and advances progress.
  IF OLD.state = 'running' AND NEW.state = 'running'
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

  -- Readiness is a separate, proven transition after the final checkpoint.
  IF OLD.state = 'running' AND NEW.state = 'completed' THEN
    IF NEW.call_count <> OLD.call_count
      OR NEW.page_count <> OLD.page_count
      OR NEW.accepted_count <> OLD.accepted_count
      OR NEW.duplicate_count <> OLD.duplicate_count
      OR NEW.rejected_count <> OLD.rejected_count
      OR NEW.returned_count <> OLD.returned_count
      OR NEW.cost_reserved <> 0
      OR NEW.cost_spent <> OLD.cost_spent
      OR NEW.last_committed_page_sequence <> NEW.page_count THEN
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

  RAISE EXCEPTION 'Unsupported Kurobara generation transition'
    USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER dataset_generation_progress_is_guarded
  BEFORE UPDATE OR DELETE ON kurobara_core.dataset_generations
  FOR EACH ROW EXECUTE FUNCTION
    kurobara_core.guard_dataset_generation_progress();

DROP TRIGGER dataset_generation_page_changes_are_guarded
  ON kurobara_core.dataset_generation_pages;
DROP FUNCTION kurobara_core.guard_dataset_generation_page_change();

CREATE FUNCTION kurobara_core.guard_dataset_generation_page_change()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Kurobara dataset generation pages cannot be deleted'
      USING ERRCODE = '55000';
  END IF;
  IF OLD.workspace_id IS DISTINCT FROM NEW.workspace_id
    OR OLD.generation_id IS DISTINCT FROM NEW.generation_id
    OR OLD.page_sequence IS DISTINCT FROM NEW.page_sequence
    OR OLD.run_plan_id IS DISTINCT FROM NEW.run_plan_id
    OR OLD.input_id IS DISTINCT FROM NEW.input_id
    OR OLD.input_content_hash IS DISTINCT FROM NEW.input_content_hash
    OR OLD.input_cursor IS DISTINCT FROM NEW.input_cursor
    OR OLD.run_id IS DISTINCT FROM NEW.run_id
    OR OLD.created_at IS DISTINCT FROM NEW.created_at THEN
    RAISE EXCEPTION 'Kurobara generation page identity is immutable'
      USING ERRCODE = '55000';
  END IF;
  IF OLD.state IN ('committed', 'failed', 'ambiguous')
    AND OLD IS DISTINCT FROM NEW THEN
    RAISE EXCEPTION 'Kurobara terminal generation pages are immutable'
      USING ERRCODE = '55000';
  END IF;
  IF NEW.aggregate_version <> OLD.aggregate_version + 1
    OR NOT (
      (OLD.state = 'run_created' AND NEW.state = 'executing')
      OR (OLD.state = 'executing'
        AND NEW.state IN ('committed', 'failed', 'ambiguous'))
    ) THEN
    RAISE EXCEPTION 'Unsupported Kurobara generation page transition'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER dataset_generation_page_changes_are_guarded
  BEFORE UPDATE OR DELETE ON kurobara_core.dataset_generation_pages
  FOR EACH ROW EXECUTE FUNCTION
    kurobara_core.guard_dataset_generation_page_change();

CREATE INDEX dataset_records_generation_content_hash_idx
  ON kurobara_core.dataset_records (
    workspace_id,
    generation_id,
    content_hash
  ) WHERE generation_id IS NOT NULL;
