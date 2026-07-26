-- KRB-DATASET-GEN-001C binds the first generated page to the canonical Run
-- runtime. The page is internal-only: no public HTTP, SDK, CLI, or MCP contract
-- is introduced by this migration.

ALTER TABLE kurobara_core.dataset_generations
  ADD COLUMN locked_provider text,
  ADD COLUMN last_committed_page_sequence bigint,
  ADD CONSTRAINT dataset_generations_provider_lock_consistent CHECK (
    (locked_provider IS NULL AND last_committed_page_sequence IS NULL)
    OR (
      locked_provider IS NOT NULL
      AND char_length(locked_provider) BETWEEN 1 AND 255
      AND btrim(locked_provider) <> ''
      AND last_committed_page_sequence IS NOT NULL
      AND last_committed_page_sequence > 0
      AND last_committed_page_sequence = page_count
    )
  ),
  ADD CONSTRAINT dataset_generations_payload_provider_lock_consistent CHECK (
    (
      locked_provider IS NULL
      AND NOT (payload ? 'lockedProvider')
      AND NOT (payload ? 'lastPageSequence')
    )
    OR (
      locked_provider IS NOT NULL
      AND payload ->> 'lockedProvider' = locked_provider
      AND (payload ->> 'lastPageSequence')::bigint =
        last_committed_page_sequence
    )
  );

CREATE TABLE kurobara_core.dataset_generation_pages (
  workspace_id text NOT NULL,
  generation_id text NOT NULL,
  page_sequence bigint NOT NULL,
  state text NOT NULL,
  aggregate_version bigint NOT NULL,
  run_plan_id text NOT NULL,
  input_id text NOT NULL,
  input_content_hash text NOT NULL,
  input_cursor text,
  run_id text NOT NULL,
  step_run_id text,
  attempt_id text,
  operation_key text,
  routing_decision_id text,
  route_key text,
  provider_key text,
  route_snapshot_hash text,
  reservation_id text,
  reserved_amount numeric,
  cost_unit text,
  artifact_id text,
  artifact_content_hash text,
  result_manifest_id text,
  result_manifest_hash text,
  usage_entry_id text,
  cost_amount numeric,
  returned_count bigint,
  accepted_count bigint,
  duplicate_count bigint,
  rejected_count bigint,
  next_cursor text,
  has_more boolean,
  source_partition_completed boolean,
  checkpoint_hash text,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  committed_at timestamptz,
  PRIMARY KEY (workspace_id, generation_id, page_sequence),
  UNIQUE (workspace_id, run_id),
  UNIQUE (workspace_id, run_plan_id),
  UNIQUE (workspace_id, generation_id, operation_key),
  FOREIGN KEY (workspace_id, generation_id)
    REFERENCES kurobara_core.dataset_generations (
      workspace_id,
      generation_id
    ),
  FOREIGN KEY (
    workspace_id,
    run_plan_id,
    input_id,
    input_content_hash
  ) REFERENCES kurobara_core.run_plan_inputs (
    workspace_id,
    run_plan_id,
    input_id,
    content_hash
  ) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (workspace_id, run_id)
    REFERENCES kurobara_core.runs (
      workspace_id,
      run_id
    ) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (workspace_id, run_id, step_run_id)
    REFERENCES kurobara_core.step_runs (
      workspace_id,
      run_id,
      step_run_id
    ) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (
    workspace_id,
    step_run_id,
    attempt_id,
    operation_key
  ) REFERENCES kurobara_core.step_attempts (
    workspace_id,
    step_run_id,
    attempt_id,
    operation_key
  ) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (
    workspace_id,
    step_run_id,
    routing_decision_id
  ) REFERENCES kurobara_core.routing_decisions (
    workspace_id,
    step_run_id,
    routing_decision_id
  ) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (workspace_id, attempt_id, reservation_id)
    REFERENCES kurobara_core.cost_reservations (
      workspace_id,
      attempt_id,
      reservation_id
    ) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (
    workspace_id,
    run_id,
    artifact_id,
    artifact_content_hash
  ) REFERENCES kurobara_core.run_output_artifacts (
    workspace_id,
    run_id,
    artifact_id,
    content_hash
  ) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (
    workspace_id,
    run_id,
    result_manifest_id,
    result_manifest_hash
  ) REFERENCES kurobara_core.run_result_manifests (
    workspace_id,
    run_id,
    result_manifest_id,
    manifest_hash
  ) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (workspace_id, usage_entry_id)
    REFERENCES kurobara_core.usage_ledger_entries (
      workspace_id,
      usage_entry_id
    ) DEFERRABLE INITIALLY DEFERRED,
  CHECK (page_sequence > 0),
  CHECK (state IN ('run_created', 'executing', 'committed', 'ambiguous')),
  CHECK (aggregate_version > 0),
  CHECK (input_content_hash ~ '^sha256:[0-9a-f]{64}$'),
  CHECK (input_cursor IS NULL),
  CHECK (route_snapshot_hash IS NULL
    OR route_snapshot_hash ~ '^sha256:[0-9a-f]{64}$'),
  CHECK (artifact_content_hash IS NULL
    OR artifact_content_hash ~ '^sha256:[0-9a-f]{64}$'),
  CHECK (result_manifest_hash IS NULL
    OR result_manifest_hash ~ '^sha256:[0-9a-f]{64}$'),
  CHECK (checkpoint_hash IS NULL
    OR checkpoint_hash ~ '^sha256:[0-9a-f]{64}$'),
  CHECK (reserved_amount IS NULL OR reserved_amount >= 0),
  CHECK (cost_amount IS NULL OR cost_amount >= 0),
  CHECK (cost_amount IS NULL OR reserved_amount IS NULL
    OR cost_amount <= reserved_amount),
  CHECK (has_more IS NULL OR source_partition_completed IS NULL
    OR source_partition_completed = NOT has_more),
  CHECK (returned_count IS NULL OR returned_count >= 0),
  CHECK (accepted_count IS NULL OR accepted_count >= 0),
  CHECK (duplicate_count IS NULL OR duplicate_count >= 0),
  CHECK (rejected_count IS NULL OR rejected_count >= 0),
  CHECK (
    returned_count IS NULL
    OR returned_count = accepted_count + duplicate_count + rejected_count
  ),
  CHECK (jsonb_typeof(payload) = 'object'),
  CHECK (octet_length(payload::text) <= 65536),
  CHECK (payload ->> 'workspaceId' = workspace_id),
  CHECK (payload ->> 'generationId' = generation_id),
  CHECK ((payload ->> 'pageSequence')::bigint = page_sequence),
  CHECK (payload ->> 'state' = state),
  CHECK ((payload ->> 'aggregateVersion')::bigint = aggregate_version),
  CHECK (payload ->> 'runPlanId' = run_plan_id),
  CHECK (payload ->> 'inputId' = input_id),
  CHECK (payload ->> 'inputContentHash' = input_content_hash),
  CHECK (payload ->> 'runId' = run_id),
  CHECK (
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
    OR (state IN ('executing', 'ambiguous')
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
  )
);

CREATE FUNCTION kurobara_core.guard_dataset_generation_page_run_binding()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  parent_run_plan_id text;
BEGIN
  SELECT run_plan_id
  INTO parent_run_plan_id
  FROM kurobara_core.runs
  WHERE workspace_id = NEW.workspace_id
    AND run_id = NEW.run_id
  FOR SHARE;

  IF parent_run_plan_id IS NULL
    OR parent_run_plan_id IS DISTINCT FROM NEW.run_plan_id THEN
    RAISE EXCEPTION 'Kurobara generation page run plan binding is invalid'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER dataset_generation_page_run_binding_is_guarded
  BEFORE INSERT OR UPDATE ON kurobara_core.dataset_generation_pages
  FOR EACH ROW EXECUTE FUNCTION
    kurobara_core.guard_dataset_generation_page_run_binding();

CREATE INDEX dataset_generation_pages_run_idx
  ON kurobara_core.dataset_generation_pages (
    workspace_id,
    run_id,
    page_sequence
  );

ALTER TABLE kurobara_core.dataset_records
  DROP CONSTRAINT dataset_records_workspace_id_import_id_dataset_id_fkey,
  DROP CONSTRAINT dataset_records_workspace_id_import_id_batch_sequence_fkey,
  DROP CONSTRAINT dataset_records_item_number_check,
  DROP CONSTRAINT dataset_records_record_number_check,
  ALTER COLUMN import_id DROP NOT NULL,
  ALTER COLUMN batch_sequence DROP NOT NULL,
  ALTER COLUMN item_number DROP NOT NULL,
  ALTER COLUMN record_number DROP NOT NULL,
  ADD COLUMN generation_id text,
  ADD COLUMN page_sequence bigint,
  ADD COLUMN candidate_position bigint,
  ADD CONSTRAINT dataset_records_exact_origin CHECK (
    (
      import_id IS NOT NULL
      AND batch_sequence IS NOT NULL
      AND item_number IS NOT NULL
      AND record_number IS NOT NULL
      AND generation_id IS NULL
      AND page_sequence IS NULL
      AND candidate_position IS NULL
    )
    OR (
      import_id IS NULL
      AND batch_sequence IS NULL
      AND item_number IS NULL
      AND record_number IS NULL
      AND generation_id IS NOT NULL
      AND page_sequence IS NOT NULL
      AND page_sequence > 0
      AND candidate_position IS NOT NULL
      AND candidate_position > 0
    )
  ),
  ADD CONSTRAINT dataset_records_import_parent_fk
    FOREIGN KEY (workspace_id, import_id, dataset_id)
    REFERENCES kurobara_core.dataset_imports (
      workspace_id,
      import_id,
      dataset_id
    ),
  ADD CONSTRAINT dataset_records_import_batch_fk
    FOREIGN KEY (workspace_id, import_id, batch_sequence)
    REFERENCES kurobara_core.dataset_import_batches (
      workspace_id,
      import_id,
      sequence
    ),
  ADD CONSTRAINT dataset_records_generation_page_key UNIQUE (
    workspace_id,
    generation_id,
    page_sequence,
    candidate_position
  ),
  ADD CONSTRAINT dataset_records_generation_page_fk
    FOREIGN KEY (workspace_id, generation_id, page_sequence)
    REFERENCES kurobara_core.dataset_generation_pages (
      workspace_id,
      generation_id,
      page_sequence
    ) DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE kurobara_core.dataset_generation_record_lineage (
  workspace_id text NOT NULL,
  dataset_id text NOT NULL,
  record_id text NOT NULL,
  generation_id text NOT NULL,
  page_sequence bigint NOT NULL,
  candidate_position bigint NOT NULL,
  run_id text NOT NULL,
  step_run_id text NOT NULL,
  attempt_id text NOT NULL,
  operation_key text NOT NULL,
  routing_decision_id text NOT NULL,
  reservation_id text NOT NULL,
  artifact_id text NOT NULL,
  result_manifest_id text NOT NULL,
  usage_entry_id text NOT NULL,
  cost_attribution text NOT NULL DEFAULT 'shared-page',
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workspace_id, dataset_id, record_id),
  UNIQUE (
    workspace_id,
    generation_id,
    page_sequence,
    candidate_position
  ),
  FOREIGN KEY (workspace_id, dataset_id, record_id)
    REFERENCES kurobara_core.dataset_records (
      workspace_id,
      dataset_id,
      record_id
    ),
  FOREIGN KEY (workspace_id, generation_id, page_sequence)
    REFERENCES kurobara_core.dataset_generation_pages (
      workspace_id,
      generation_id,
      page_sequence
    ) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (workspace_id, run_id, step_run_id)
    REFERENCES kurobara_core.step_runs (
      workspace_id,
      run_id,
      step_run_id
    ) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (
    workspace_id,
    step_run_id,
    attempt_id,
    operation_key
  ) REFERENCES kurobara_core.step_attempts (
    workspace_id,
    step_run_id,
    attempt_id,
    operation_key
  ) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (workspace_id, step_run_id, routing_decision_id)
    REFERENCES kurobara_core.routing_decisions (
      workspace_id,
      step_run_id,
      routing_decision_id
    ) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (workspace_id, attempt_id, reservation_id)
    REFERENCES kurobara_core.cost_reservations (
      workspace_id,
      attempt_id,
      reservation_id
    ) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (workspace_id, artifact_id)
    REFERENCES kurobara_core.run_output_artifacts (
      workspace_id,
      artifact_id
    ) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (workspace_id, result_manifest_id)
    REFERENCES kurobara_core.run_result_manifests (
      workspace_id,
      result_manifest_id
    ) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (workspace_id, usage_entry_id)
    REFERENCES kurobara_core.usage_ledger_entries (
      workspace_id,
      usage_entry_id
    ) DEFERRABLE INITIALLY DEFERRED,
  CHECK (page_sequence > 0),
  CHECK (candidate_position > 0),
  CHECK (cost_attribution = 'shared-page')
);

DROP TRIGGER dataset_records_changes_are_guarded
  ON kurobara_core.dataset_records;

CREATE FUNCTION kurobara_core.guard_dataset_record_change()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  parent_state text;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'Kurobara dataset records cannot be updated'
      USING ERRCODE = '55000';
  END IF;

  IF TG_OP = 'DELETE' THEN
    IF OLD.import_id IS NULL THEN
      RAISE EXCEPTION 'Kurobara generated dataset records cannot be deleted'
        USING ERRCODE = '55000';
    END IF;

    SELECT state
    INTO parent_state
    FROM kurobara_core.dataset_imports
    WHERE workspace_id = OLD.workspace_id
      AND import_id = OLD.import_id
    FOR SHARE;
    IF parent_state = 'running' THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'Kurobara terminal dataset import child rows are immutable'
      USING ERRCODE = '55000';
  END IF;

  IF NEW.import_id IS NOT NULL THEN
    SELECT state
    INTO parent_state
    FROM kurobara_core.dataset_imports
    WHERE workspace_id = NEW.workspace_id
      AND import_id = NEW.import_id
    FOR SHARE;
    IF parent_state = 'running' THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'Kurobara terminal dataset import child rows are immutable'
      USING ERRCODE = '55000';
  END IF;

  SELECT state
  INTO parent_state
  FROM kurobara_core.dataset_generation_pages
  WHERE workspace_id = NEW.workspace_id
    AND generation_id = NEW.generation_id
    AND page_sequence = NEW.page_sequence
  FOR SHARE;
  IF parent_state = 'executing' THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'Generated records require an executing generation page'
    USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER dataset_records_changes_are_guarded
  BEFORE INSERT OR UPDATE OR DELETE ON kurobara_core.dataset_records
  FOR EACH ROW EXECUTE FUNCTION kurobara_core.guard_dataset_record_change();

DROP TRIGGER dataset_generations_are_immutable
  ON kurobara_core.dataset_generations;
DROP FUNCTION kurobara_core.guard_dataset_generation_change();

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

  IF NEW.aggregate_version <> OLD.aggregate_version + 1 THEN
    RAISE EXCEPTION 'Kurobara generation version must advance once'
      USING ERRCODE = '55000';
  END IF;

  IF OLD.locked_provider IS NOT NULL
    AND (
      NEW.locked_provider IS DISTINCT FROM OLD.locked_provider
      OR NEW.last_committed_page_sequence IS DISTINCT FROM
        OLD.last_committed_page_sequence
    ) THEN
    RAISE EXCEPTION 'Kurobara generation provider lock is immutable'
      USING ERRCODE = '55000';
  END IF;

  IF OLD.state = 'planned' AND NEW.state = 'running' THEN
    IF NEW.call_count <> OLD.call_count + 1
      OR NEW.page_count <> OLD.page_count + 1
      OR NEW.accepted_count <> OLD.accepted_count
      OR NEW.duplicate_count <> OLD.duplicate_count
      OR NEW.rejected_count <> OLD.rejected_count
      OR NEW.returned_count <> OLD.returned_count
      OR NEW.cost_reserved < OLD.cost_reserved
      OR NEW.cost_spent <> OLD.cost_spent
      OR NEW.locked_provider IS NOT NULL THEN
      RAISE EXCEPTION 'Invalid first generation page authorization'
        USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.state = 'running' AND NEW.state = 'running' THEN
    IF NEW.call_count <> OLD.call_count
      OR NEW.page_count <> OLD.page_count
      OR NEW.accepted_count < OLD.accepted_count
      OR NEW.duplicate_count < OLD.duplicate_count
      OR NEW.rejected_count < OLD.rejected_count
      OR NEW.returned_count < OLD.returned_count
      OR NEW.cost_reserved <> 0
      OR NEW.cost_spent < OLD.cost_spent
      OR NEW.locked_provider IS NULL THEN
      RAISE EXCEPTION 'Invalid first generation page checkpoint'
        USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.state = 'running' AND NEW.state = 'ambiguous' THEN
    IF NEW.call_count <> OLD.call_count
      OR NEW.page_count <> OLD.page_count
      OR NEW.accepted_count <> OLD.accepted_count
      OR NEW.duplicate_count <> OLD.duplicate_count
      OR NEW.rejected_count <> OLD.rejected_count
      OR NEW.returned_count <> OLD.returned_count
      OR NEW.cost_reserved <> OLD.cost_reserved
      OR NEW.cost_spent <> OLD.cost_spent
      OR NEW.locked_provider IS DISTINCT FROM OLD.locked_provider THEN
      RAISE EXCEPTION 'Invalid generation ambiguity projection'
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
  IF OLD.state IN ('committed', 'ambiguous') AND OLD IS DISTINCT FROM NEW THEN
    RAISE EXCEPTION 'Kurobara terminal generation pages are immutable'
      USING ERRCODE = '55000';
  END IF;
  IF NEW.aggregate_version <> OLD.aggregate_version + 1
    OR NOT (
      (OLD.state = 'run_created' AND NEW.state = 'executing')
      OR (OLD.state = 'executing' AND NEW.state IN ('committed', 'ambiguous'))
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

CREATE FUNCTION kurobara_core.reject_dataset_generation_lineage_change()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'Kurobara generation lineage is immutable'
    USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER dataset_generation_lineage_is_immutable
  BEFORE UPDATE OR DELETE
  ON kurobara_core.dataset_generation_record_lineage
  FOR EACH ROW EXECUTE FUNCTION
    kurobara_core.reject_dataset_generation_lineage_change();
