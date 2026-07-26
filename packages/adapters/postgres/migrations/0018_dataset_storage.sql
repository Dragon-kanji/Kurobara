-- Dataset imports are synchronous, bounded application operations. PostgreSQL
-- keeps their durable replay ledger; no orchestration or outbox is involved.

CREATE TABLE kurobara_core.datasets (
  workspace_id text NOT NULL REFERENCES kurobara_core.workspaces (workspace_id),
  dataset_id text NOT NULL,
  name text NOT NULL,
  schema_hash text NOT NULL,
  dataset jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workspace_id, dataset_id),
  CHECK (char_length(dataset_id) BETWEEN 1 AND 255),
  CHECK (btrim(dataset_id) <> ''),
  CHECK (char_length(name) BETWEEN 1 AND 255),
  CHECK (btrim(name) <> ''),
  CHECK (schema_hash ~ '^sha256:[0-9a-f]{64}$'),
  CHECK (jsonb_typeof(dataset) = 'object'),
  CHECK (octet_length(dataset::text) <= 4096)
);

CREATE TABLE kurobara_core.dataset_fields (
  workspace_id text NOT NULL,
  dataset_id text NOT NULL,
  field_id text NOT NULL,
  ordinal integer NOT NULL,
  field_key text NOT NULL,
  label text NOT NULL,
  value_type text NOT NULL,
  field jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workspace_id, dataset_id, field_id),
  UNIQUE (workspace_id, dataset_id, ordinal),
  UNIQUE (workspace_id, dataset_id, field_key),
  FOREIGN KEY (workspace_id, dataset_id)
    REFERENCES kurobara_core.datasets (workspace_id, dataset_id),
  CHECK (char_length(field_id) BETWEEN 1 AND 255),
  CHECK (btrim(field_id) <> ''),
  CHECK (ordinal BETWEEN 0 AND 255),
  CHECK (field_key ~ '^[a-z][a-z0-9_]*$'),
  CHECK (char_length(field_key) <= 128),
  CHECK (char_length(label) BETWEEN 1 AND 255),
  CHECK (btrim(label) <> ''),
  CHECK (value_type IN ('boolean', 'number', 'string')),
  CHECK (jsonb_typeof(field) = 'object'),
  CHECK (octet_length(field::text) <= 8192)
);

CREATE TABLE kurobara_core.dataset_imports (
  workspace_id text NOT NULL,
  import_id text NOT NULL,
  dataset_id text NOT NULL,
  schema_hash text NOT NULL,
  intent_hash text NOT NULL,
  source_content_hash text NOT NULL,
  format text NOT NULL,
  codec_version text NOT NULL,
  max_record_bytes integer NOT NULL,
  max_batch_items integer NOT NULL,
  max_batch_bytes integer NOT NULL,
  state text NOT NULL DEFAULT 'running',
  batch_count integer NOT NULL DEFAULT 0,
  item_count bigint NOT NULL DEFAULT 0,
  record_count bigint NOT NULL DEFAULT 0,
  error_count bigint NOT NULL DEFAULT 0,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workspace_id, import_id),
  UNIQUE (workspace_id, dataset_id),
  UNIQUE (workspace_id, import_id, dataset_id),
  FOREIGN KEY (workspace_id, dataset_id)
    REFERENCES kurobara_core.datasets (workspace_id, dataset_id),
  CHECK (char_length(import_id) BETWEEN 1 AND 255),
  CHECK (btrim(import_id) <> ''),
  CHECK (schema_hash ~ '^sha256:[0-9a-f]{64}$'),
  CHECK (intent_hash ~ '^sha256:[0-9a-f]{64}$'),
  CHECK (source_content_hash ~ '^sha256:[0-9a-f]{64}$'),
  CHECK (format IN ('csv', 'jsonl')),
  CHECK (codec_version = '1.0.0'),
  CHECK (max_record_bytes BETWEEN 1 AND 16777216),
  CHECK (max_batch_items BETWEEN 1 AND 1000),
  CHECK (
    max_batch_bytes BETWEEN GREATEST(max_record_bytes, 1024) AND 67108864
  ),
  CHECK (state IN ('running', 'completed', 'failed')),
  CHECK (batch_count >= 0),
  CHECK (item_count >= 0),
  CHECK (record_count >= 0),
  CHECK (error_count >= 0),
  CHECK (item_count = record_count + error_count),
  CHECK ((state = 'running') = (completed_at IS NULL))
);

CREATE TABLE kurobara_core.dataset_import_batches (
  workspace_id text NOT NULL,
  import_id text NOT NULL,
  sequence integer NOT NULL,
  content_hash text NOT NULL,
  item_count integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workspace_id, import_id, sequence),
  FOREIGN KEY (workspace_id, import_id)
    REFERENCES kurobara_core.dataset_imports (workspace_id, import_id),
  CHECK (sequence > 0),
  CHECK (content_hash ~ '^sha256:[0-9a-f]{64}$'),
  CHECK (item_count BETWEEN 1 AND 1000)
);

CREATE TABLE kurobara_core.dataset_records (
  workspace_id text NOT NULL,
  dataset_id text NOT NULL,
  record_id text NOT NULL,
  import_id text NOT NULL,
  batch_sequence integer NOT NULL,
  item_number bigint NOT NULL,
  record_number bigint NOT NULL,
  content_hash text NOT NULL,
  record jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workspace_id, dataset_id, record_id),
  UNIQUE (workspace_id, import_id, item_number),
  FOREIGN KEY (workspace_id, import_id, dataset_id)
    REFERENCES kurobara_core.dataset_imports (
      workspace_id,
      import_id,
      dataset_id
    ),
  FOREIGN KEY (workspace_id, import_id, batch_sequence)
    REFERENCES kurobara_core.dataset_import_batches (
      workspace_id,
      import_id,
      sequence
    ),
  CHECK (char_length(record_id) BETWEEN 1 AND 255),
  CHECK (btrim(record_id) <> ''),
  CHECK (item_number > 0),
  CHECK (record_number > 0),
  CHECK (content_hash ~ '^sha256:[0-9a-f]{64}$'),
  CHECK (jsonb_typeof(record) = 'object'),
  CHECK (octet_length(record::text) <= 67108864)
);

CREATE INDEX dataset_records_import_order_idx
  ON kurobara_core.dataset_records (
    workspace_id,
    dataset_id,
    item_number
  );

CREATE TABLE kurobara_core.dataset_import_issues (
  workspace_id text NOT NULL,
  import_id text NOT NULL,
  dataset_id text NOT NULL,
  batch_sequence integer NOT NULL,
  item_number bigint NOT NULL,
  source_content_hash text NOT NULL,
  issue_code text NOT NULL,
  message text NOT NULL,
  recoverable boolean NOT NULL,
  issue_scope text NOT NULL,
  field_key text,
  line_end bigint,
  line_start bigint,
  record_id text,
  record_number bigint,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workspace_id, import_id, item_number),
  FOREIGN KEY (workspace_id, import_id, dataset_id)
    REFERENCES kurobara_core.dataset_imports (
      workspace_id,
      import_id,
      dataset_id
    ),
  FOREIGN KEY (workspace_id, import_id, batch_sequence)
    REFERENCES kurobara_core.dataset_import_batches (
      workspace_id,
      import_id,
      sequence
    ),
  CHECK (item_number > 0),
  CHECK (source_content_hash ~ '^sha256:[0-9a-f]{64}$'),
  CHECK (char_length(issue_code) BETWEEN 1 AND 128),
  CHECK (char_length(message) BETWEEN 1 AND 2048),
  CHECK (issue_scope IN ('document', 'record')),
  CHECK (field_key IS NULL OR char_length(field_key) BETWEEN 1 AND 128),
  CHECK (line_end IS NULL OR line_end > 0),
  CHECK (line_start IS NULL OR line_start > 0),
  CHECK (line_end IS NULL OR line_start IS NULL OR line_end >= line_start),
  CHECK (record_id IS NULL OR char_length(record_id) BETWEEN 1 AND 255),
  CHECK (record_number IS NULL OR record_number > 0)
);

CREATE INDEX dataset_import_issues_order_idx
  ON kurobara_core.dataset_import_issues (
    workspace_id,
    dataset_id,
    item_number
  );

CREATE FUNCTION kurobara_core.reject_immutable_dataset_record_change()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'Kurobara dataset records are immutable'
    USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER datasets_are_immutable
  BEFORE UPDATE OR DELETE ON kurobara_core.datasets
  FOR EACH ROW EXECUTE FUNCTION
    kurobara_core.reject_immutable_dataset_record_change();

CREATE TRIGGER dataset_fields_are_immutable
  BEFORE UPDATE OR DELETE ON kurobara_core.dataset_fields
  FOR EACH ROW EXECUTE FUNCTION
    kurobara_core.reject_immutable_dataset_record_change();

CREATE FUNCTION kurobara_core.guard_dataset_import_child_change()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  parent_state text;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'Kurobara dataset import child rows cannot be updated'
      USING ERRCODE = '55000';
  END IF;

  IF TG_OP = 'INSERT' THEN
    SELECT state
    INTO parent_state
    FROM kurobara_core.dataset_imports
    WHERE workspace_id = NEW.workspace_id
      AND import_id = NEW.import_id
    FOR SHARE;
  ELSE
    SELECT state
    INTO parent_state
    FROM kurobara_core.dataset_imports
    WHERE workspace_id = OLD.workspace_id
      AND import_id = OLD.import_id
    FOR SHARE;
  END IF;

  IF parent_state = 'running' THEN
    IF TG_OP = 'INSERT' THEN
      RETURN NEW;
    END IF;
    RETURN OLD;
  END IF;

  RAISE EXCEPTION 'Kurobara terminal dataset import child rows are immutable'
    USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER dataset_import_batches_changes_are_guarded
  BEFORE INSERT OR UPDATE OR DELETE ON kurobara_core.dataset_import_batches
  FOR EACH ROW EXECUTE FUNCTION
    kurobara_core.guard_dataset_import_child_change();

CREATE TRIGGER dataset_records_changes_are_guarded
  BEFORE INSERT OR UPDATE OR DELETE ON kurobara_core.dataset_records
  FOR EACH ROW EXECUTE FUNCTION
    kurobara_core.guard_dataset_import_child_change();

CREATE TRIGGER dataset_import_issues_changes_are_guarded
  BEFORE INSERT OR UPDATE OR DELETE ON kurobara_core.dataset_import_issues
  FOR EACH ROW EXECUTE FUNCTION
    kurobara_core.guard_dataset_import_child_change();

CREATE FUNCTION kurobara_core.guard_dataset_import_change()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  reset_is_consistent boolean;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Kurobara dataset imports cannot be deleted'
      USING ERRCODE = '55000';
  END IF;

  IF OLD.workspace_id IS DISTINCT FROM NEW.workspace_id
    OR OLD.import_id IS DISTINCT FROM NEW.import_id
    OR OLD.dataset_id IS DISTINCT FROM NEW.dataset_id
    OR OLD.schema_hash IS DISTINCT FROM NEW.schema_hash
    OR OLD.intent_hash IS DISTINCT FROM NEW.intent_hash
    OR OLD.source_content_hash IS DISTINCT FROM NEW.source_content_hash
    OR OLD.format IS DISTINCT FROM NEW.format
    OR OLD.codec_version IS DISTINCT FROM NEW.codec_version
    OR OLD.max_record_bytes IS DISTINCT FROM NEW.max_record_bytes
    OR OLD.max_batch_items IS DISTINCT FROM NEW.max_batch_items
    OR OLD.max_batch_bytes IS DISTINCT FROM NEW.max_batch_bytes THEN
    RAISE EXCEPTION 'Kurobara dataset import identity is immutable'
      USING ERRCODE = '55000';
  END IF;

  IF OLD.state <> 'running' AND OLD IS DISTINCT FROM NEW THEN
    RAISE EXCEPTION 'Kurobara terminal dataset imports are immutable'
      USING ERRCODE = '55000';
  END IF;

  IF NEW.batch_count < OLD.batch_count
    OR NEW.item_count < OLD.item_count
    OR NEW.record_count < OLD.record_count
    OR NEW.error_count < OLD.error_count THEN
    reset_is_consistent :=
      OLD.state = 'running'
      AND NEW.state = 'running'
      AND NEW.batch_count = 0
      AND NEW.item_count = 0
      AND NEW.record_count = 0
      AND NEW.error_count = 0
      AND NOT EXISTS (
        SELECT 1
        FROM kurobara_core.dataset_import_batches AS batch
        WHERE batch.workspace_id = OLD.workspace_id
          AND batch.import_id = OLD.import_id
      )
      AND NOT EXISTS (
        SELECT 1
        FROM kurobara_core.dataset_records AS record
        WHERE record.workspace_id = OLD.workspace_id
          AND record.import_id = OLD.import_id
      )
      AND NOT EXISTS (
        SELECT 1
        FROM kurobara_core.dataset_import_issues AS issue
        WHERE issue.workspace_id = OLD.workspace_id
          AND issue.import_id = OLD.import_id
      );

    IF NOT reset_is_consistent THEN
      RAISE EXCEPTION 'Kurobara dataset import progress cannot move backwards'
        USING ERRCODE = '55000';
    END IF;
  END IF;

  IF NEW.state NOT IN ('running', 'completed', 'failed') THEN
    RAISE EXCEPTION 'Kurobara dataset import state is invalid'
      USING ERRCODE = '55000';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER dataset_import_changes_are_guarded
  BEFORE UPDATE OR DELETE ON kurobara_core.dataset_imports
  FOR EACH ROW EXECUTE FUNCTION kurobara_core.guard_dataset_import_change();
