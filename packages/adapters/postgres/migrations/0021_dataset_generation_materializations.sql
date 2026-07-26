-- Dataset readiness is represented by exactly one durable materialization per
-- dataset. This migration adds the no-effect generation aggregate only: it
-- creates no Run, outbox message, provider receipt, reservation, or ledger row.

ALTER TABLE kurobara_core.dataset_generation_plans
  ADD CONSTRAINT dataset_generation_plans_exact_generation_binding_key
  UNIQUE (
    workspace_id,
    generation_plan_id,
    target_dataset_id,
    plan_hash,
    query_hash,
    schema_hash,
    request_intent_hash
  );

CREATE TABLE kurobara_core.dataset_generations (
  workspace_id text NOT NULL,
  generation_id text NOT NULL,
  generation_plan_id text NOT NULL,
  dataset_id text NOT NULL,
  materialization_id text NOT NULL,
  plan_hash text NOT NULL,
  query_hash text NOT NULL,
  schema_hash text NOT NULL,
  request_intent_hash text NOT NULL,
  capability_id text NOT NULL,
  capability_version text NOT NULL,
  state text NOT NULL,
  aggregate_version bigint NOT NULL,
  accepted_count bigint NOT NULL,
  call_count bigint NOT NULL,
  duplicate_count bigint NOT NULL,
  page_count bigint NOT NULL,
  rejected_count bigint NOT NULL,
  returned_count bigint NOT NULL,
  cost_reserved numeric NOT NULL,
  cost_spent numeric NOT NULL,
  cost_unit text NOT NULL,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (workspace_id, generation_id),
  UNIQUE (workspace_id, generation_plan_id),
  UNIQUE (workspace_id, dataset_id),
  UNIQUE (
    workspace_id,
    generation_id,
    dataset_id,
    materialization_id
  ),
  FOREIGN KEY (workspace_id, dataset_id)
    REFERENCES kurobara_core.datasets (workspace_id, dataset_id),
  FOREIGN KEY (
    workspace_id,
    generation_plan_id,
    dataset_id,
    plan_hash,
    query_hash,
    schema_hash,
    request_intent_hash
  ) REFERENCES kurobara_core.dataset_generation_plans (
    workspace_id,
    generation_plan_id,
    target_dataset_id,
    plan_hash,
    query_hash,
    schema_hash,
    request_intent_hash
  ),
  CHECK (char_length(generation_id) BETWEEN 1 AND 255),
  CHECK (btrim(generation_id) = generation_id),
  CHECK (char_length(generation_plan_id) BETWEEN 1 AND 255),
  CHECK (btrim(generation_plan_id) = generation_plan_id),
  CHECK (char_length(dataset_id) BETWEEN 1 AND 255),
  CHECK (btrim(dataset_id) <> ''),
  CHECK (materialization_id = dataset_id),
  CHECK (plan_hash ~ '^sha256:[0-9a-f]{64}$'),
  CHECK (query_hash ~ '^sha256:[0-9a-f]{64}$'),
  CHECK (schema_hash ~ '^sha256:[0-9a-f]{64}$'),
  CHECK (request_intent_hash ~ '^sha256:[0-9a-f]{64}$'),
  CHECK (char_length(capability_id) BETWEEN 1 AND 255),
  CHECK (btrim(capability_id) <> ''),
  CHECK (char_length(capability_version) BETWEEN 1 AND 255),
  CHECK (btrim(capability_version) <> ''),
  CHECK (state IN (
    'planned', 'running', 'stopping', 'completed', 'failed', 'cancelled',
    'ambiguous'
  )),
  CHECK (aggregate_version > 0),
  CHECK (accepted_count >= 0),
  CHECK (call_count >= 0),
  CHECK (duplicate_count >= 0),
  CHECK (page_count >= 0),
  CHECK (rejected_count >= 0),
  CHECK (returned_count >= 0),
  CHECK (cost_reserved >= 0),
  CHECK (cost_spent >= 0),
  CHECK (char_length(cost_unit) BETWEEN 1 AND 64),
  CHECK (btrim(cost_unit) <> ''),
  CHECK (jsonb_typeof(payload) = 'object'),
  CHECK (octet_length(payload::text) <= 65536),
  CHECK (payload ?& ARRAY[
    'aggregateVersion',
    'capability',
    'cost',
    'counters',
    'createdAt',
    'datasetId',
    'generationId',
    'generationPlanId',
    'materializationId',
    'planHash',
    'queryHash',
    'requestIntentHash',
    'schemaHash',
    'state',
    'workspaceId'
  ]),
  CHECK (
    jsonb_typeof(payload -> 'capability') = 'object'
    AND payload -> 'capability' ?& ARRAY[
      'capabilityId', 'capabilityVersion'
    ]
  ),
  CHECK (
    jsonb_typeof(payload -> 'cost') = 'object'
    AND payload -> 'cost' ?& ARRAY['reserved', 'spent', 'unit']
  ),
  CHECK (
    jsonb_typeof(payload -> 'counters') = 'object'
    AND payload -> 'counters' ?& ARRAY[
      'accepted', 'calls', 'duplicates', 'pages', 'rejected', 'returned'
    ]
  ),
  CHECK (payload ->> 'workspaceId' = workspace_id),
  CHECK (payload ->> 'generationId' = generation_id),
  CHECK (payload ->> 'generationPlanId' = generation_plan_id),
  CHECK (payload ->> 'datasetId' = dataset_id),
  CHECK (payload ->> 'materializationId' = materialization_id),
  CHECK (payload ->> 'planHash' = plan_hash),
  CHECK (payload ->> 'queryHash' = query_hash),
  CHECK (payload ->> 'schemaHash' = schema_hash),
  CHECK (payload ->> 'requestIntentHash' = request_intent_hash),
  CHECK (payload ->> 'state' = state),
  CHECK ((payload ->> 'aggregateVersion')::bigint = aggregate_version),
  CHECK (payload #>> '{capability,capabilityId}' = capability_id),
  CHECK (payload #>> '{capability,capabilityVersion}' = capability_version),
  CHECK ((payload #>> '{counters,accepted}')::bigint = accepted_count),
  CHECK ((payload #>> '{counters,calls}')::bigint = call_count),
  CHECK ((payload #>> '{counters,duplicates}')::bigint = duplicate_count),
  CHECK ((payload #>> '{counters,pages}')::bigint = page_count),
  CHECK ((payload #>> '{counters,rejected}')::bigint = rejected_count),
  CHECK ((payload #>> '{counters,returned}')::bigint = returned_count),
  CHECK ((payload #>> '{cost,reserved}')::numeric = cost_reserved),
  CHECK ((payload #>> '{cost,spent}')::numeric = cost_spent),
  CHECK (payload #>> '{cost,unit}' = cost_unit),
  CHECK (
    to_timestamp((payload ->> 'createdAt')::double precision / 1000)
      = created_at
  )
);

CREATE TABLE kurobara_core.dataset_materializations (
  workspace_id text NOT NULL,
  materialization_id text NOT NULL,
  dataset_id text NOT NULL,
  schema_hash text NOT NULL,
  origin_kind text NOT NULL,
  origin_id text NOT NULL,
  import_id text GENERATED ALWAYS AS (
    CASE WHEN origin_kind = 'import' THEN origin_id END
  ) STORED,
  generation_id text GENERATED ALWAYS AS (
    CASE WHEN origin_kind = 'generation' THEN origin_id END
  ) STORED,
  state text NOT NULL,
  revision bigint NOT NULL,
  record_count bigint NOT NULL,
  rejected_count bigint NOT NULL,
  completed_at timestamptz,
  completion_reason text,
  content_hash text,
  coverage_basis text,
  coverage_status text,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (workspace_id, materialization_id),
  UNIQUE (workspace_id, dataset_id),
  UNIQUE (workspace_id, origin_kind, origin_id),
  UNIQUE (workspace_id, materialization_id, dataset_id),
  FOREIGN KEY (workspace_id, dataset_id)
    REFERENCES kurobara_core.datasets (workspace_id, dataset_id),
  FOREIGN KEY (workspace_id, import_id, dataset_id)
    REFERENCES kurobara_core.dataset_imports (
      workspace_id,
      import_id,
      dataset_id
    ),
  FOREIGN KEY (
    workspace_id,
    generation_id,
    dataset_id,
    materialization_id
  ) REFERENCES kurobara_core.dataset_generations (
    workspace_id,
    generation_id,
    dataset_id,
    materialization_id
  ),
  CHECK (char_length(materialization_id) BETWEEN 1 AND 255),
  CHECK (btrim(materialization_id) <> ''),
  CHECK (materialization_id = dataset_id),
  CHECK (schema_hash ~ '^sha256:[0-9a-f]{64}$'),
  CHECK (origin_kind IN ('import', 'generation')),
  CHECK (char_length(origin_id) BETWEEN 1 AND 255),
  CHECK (btrim(origin_id) <> ''),
  CHECK ((origin_kind = 'import') = (import_id IS NOT NULL)),
  CHECK ((origin_kind = 'generation') = (generation_id IS NOT NULL)),
  CHECK (state IN ('building', 'ready', 'failed', 'cancelled', 'ambiguous')),
  CHECK (revision > 0),
  CHECK (record_count >= 0),
  CHECK (rejected_count >= 0),
  CHECK (char_length(completion_reason) BETWEEN 1 AND 128),
  CHECK (content_hash IS NULL OR content_hash ~ '^sha256:[0-9a-f]{64}$'),
  CHECK (
    coverage_basis IS NULL
    OR coverage_basis IN ('imported_source', 'locked_provider_route')
  ),
  CHECK (
    coverage_status IS NULL
    OR coverage_status IN (
      'complete_for_declared_source', 'bounded', 'unknown'
    )
  ),
  CHECK (
    (state = 'ready' AND completed_at IS NOT NULL
      AND completion_reason IS NOT NULL AND content_hash IS NOT NULL
      AND (
        (origin_kind = 'import'
          AND coverage_basis = 'imported_source'
          AND coverage_status = 'complete_for_declared_source')
        OR (origin_kind = 'generation'
          AND coverage_basis = 'locked_provider_route'
          AND coverage_status IN ('complete_for_declared_source', 'bounded'))
      ))
    OR (state IN ('failed', 'cancelled') AND completed_at IS NOT NULL
      AND completion_reason IS NOT NULL AND content_hash IS NULL
      AND coverage_basis IS NULL AND coverage_status IS NULL)
    OR (state IN ('building', 'ambiguous') AND completed_at IS NULL
      AND completion_reason IS NULL AND content_hash IS NULL
      AND coverage_basis IS NULL AND coverage_status IS NULL)
  ),
  CHECK (jsonb_typeof(payload) = 'object'),
  CHECK (octet_length(payload::text) <= 65536),
  CHECK (payload ?& ARRAY[
    'createdAt',
    'datasetId',
    'materializationId',
    'origin',
    'recordCount',
    'rejectedCount',
    'revision',
    'schemaHash',
    'state',
    'workspaceId'
  ]),
  CHECK (
    jsonb_typeof(payload -> 'origin') = 'object'
    AND (
      (origin_kind = 'import'
        AND payload -> 'origin' ?& ARRAY['kind', 'importId']
        AND (payload -> 'origin') - ARRAY[
          'kind', 'importId'
        ] = '{}'::jsonb
        AND jsonb_typeof(payload #> '{origin,importId}') = 'string')
      OR (origin_kind = 'generation'
        AND payload -> 'origin' ?& ARRAY['kind', 'generationId']
        AND (payload -> 'origin') - ARRAY[
          'kind', 'generationId'
        ] = '{}'::jsonb
        AND jsonb_typeof(payload #> '{origin,generationId}') = 'string')
    )
  ),
  CHECK (
    NOT (payload ? 'coverage')
    OR (
      jsonb_typeof(payload -> 'coverage') = 'object'
      AND payload -> 'coverage' ?& ARRAY['basis', 'status']
    )
  ),
  CHECK (payload ->> 'workspaceId' = workspace_id),
  CHECK (payload ->> 'materializationId' = materialization_id),
  CHECK (payload ->> 'datasetId' = dataset_id),
  CHECK (payload ->> 'schemaHash' = schema_hash),
  CHECK (payload #>> '{origin,kind}' = origin_kind),
  CHECK (
    CASE origin_kind
      WHEN 'import' THEN payload #>> '{origin,importId}' = origin_id
      ELSE payload #>> '{origin,generationId}' = origin_id
    END
  ),
  CHECK (payload ->> 'state' = state),
  CHECK ((payload ->> 'revision')::bigint = revision),
  CHECK ((payload ->> 'recordCount')::bigint = record_count),
  CHECK ((payload ->> 'rejectedCount')::bigint = rejected_count),
  CHECK (
    to_timestamp((payload ->> 'createdAt')::double precision / 1000)
      = created_at
  ),
  CHECK (
    (completed_at IS NULL AND NOT (payload ? 'completedAt'))
    OR (completed_at IS NOT NULL AND payload ? 'completedAt'
      AND to_timestamp((payload ->> 'completedAt')::double precision / 1000)
        = completed_at)
  ),
  CHECK (
    (completion_reason IS NULL AND NOT (payload ? 'completionReason'))
    OR (completion_reason IS NOT NULL AND payload ? 'completionReason'
      AND payload ->> 'completionReason' = completion_reason)
  ),
  CHECK (
    (content_hash IS NULL AND NOT (payload ? 'contentHash'))
    OR (content_hash IS NOT NULL AND payload ? 'contentHash'
      AND payload ->> 'contentHash' = content_hash)
  ),
  CHECK (
    (coverage_basis IS NULL AND coverage_status IS NULL
      AND NOT (payload ? 'coverage'))
    OR (coverage_basis IS NOT NULL AND coverage_status IS NOT NULL
      AND payload ? 'coverage'
      AND payload #>> '{coverage,basis}' = coverage_basis
      AND payload #>> '{coverage,status}' = coverage_status
    )
  )
);

ALTER TABLE kurobara_core.dataset_records
  ADD COLUMN materialization_id text,
  ADD COLUMN record_ordinal bigint;

ALTER TABLE kurobara_core.dataset_records
  DISABLE TRIGGER dataset_records_changes_are_guarded;

WITH ordered_records AS (
  SELECT
    workspace_id,
    dataset_id,
    record_id,
    row_number() OVER (
      PARTITION BY workspace_id, dataset_id
      ORDER BY item_number
    ) AS record_ordinal
  FROM kurobara_core.dataset_records
)
UPDATE kurobara_core.dataset_records AS record
SET
  materialization_id = record.dataset_id,
  record_ordinal = ordered_records.record_ordinal
FROM ordered_records
WHERE ordered_records.workspace_id = record.workspace_id
  AND ordered_records.dataset_id = record.dataset_id
  AND ordered_records.record_id = record.record_id;

CREATE FUNCTION kurobara_core.dataset_materialization_content_hash(
  requested_workspace_id text,
  requested_dataset_id text
)
RETURNS text
LANGUAGE sql
STABLE
AS $$
  SELECT 'sha256:' || encode(
    sha256(
      convert_to(
        COALESCE(
          string_agg(
            octet_length(record_id)::text || ':' || record_id ||
            octet_length(content_hash)::text || ':' || content_hash,
            '' ORDER BY record_ordinal
          ),
          ''
        ),
        'UTF8'
      )
    ),
    'hex'
  )
  FROM kurobara_core.dataset_records
  WHERE workspace_id = requested_workspace_id
    AND dataset_id = requested_dataset_id
$$;

INSERT INTO kurobara_core.dataset_materializations (
  workspace_id,
  materialization_id,
  dataset_id,
  schema_hash,
  origin_kind,
  origin_id,
  state,
  revision,
  record_count,
  rejected_count,
  completed_at,
  completion_reason,
  content_hash,
  coverage_basis,
  coverage_status,
  payload,
  created_at
)
SELECT
  dataset_import.workspace_id,
  dataset_import.dataset_id,
  dataset_import.dataset_id,
  dataset_import.schema_hash,
  'import',
  dataset_import.import_id,
  CASE dataset_import.state
    WHEN 'running' THEN 'building'
    WHEN 'completed' THEN 'ready'
    ELSE 'failed'
  END,
  1,
  dataset_import.record_count,
  dataset_import.error_count,
  CASE WHEN dataset_import.state = 'running' THEN NULL
    ELSE date_trunc('milliseconds', dataset_import.completed_at) END,
  CASE dataset_import.state
    WHEN 'completed' THEN 'source-exhausted'
    WHEN 'failed' THEN 'dataset-import-failed'
    ELSE NULL
  END,
  CASE WHEN dataset_import.state = 'completed'
    THEN kurobara_core.dataset_materialization_content_hash(
      dataset_import.workspace_id,
      dataset_import.dataset_id
    )
    ELSE NULL
  END,
  CASE WHEN dataset_import.state = 'completed' THEN 'imported_source' END,
  CASE WHEN dataset_import.state = 'completed'
    THEN 'complete_for_declared_source' END,
  jsonb_strip_nulls(jsonb_build_object(
    'completedAt', CASE WHEN dataset_import.state = 'running' THEN NULL
      ELSE floor(extract(epoch FROM dataset_import.completed_at) * 1000)::bigint
      END,
    'completionReason', CASE dataset_import.state
      WHEN 'completed' THEN 'source-exhausted'
      WHEN 'failed' THEN 'dataset-import-failed'
      ELSE NULL
      END,
    'contentHash', CASE WHEN dataset_import.state = 'completed'
      THEN kurobara_core.dataset_materialization_content_hash(
        dataset_import.workspace_id,
        dataset_import.dataset_id
      )
      ELSE NULL
      END,
    'coverage', CASE WHEN dataset_import.state = 'completed'
      THEN jsonb_build_object(
        'basis', 'imported_source',
        'status', 'complete_for_declared_source'
      )
      ELSE NULL
      END,
    'createdAt', floor(extract(epoch FROM dataset_import.created_at) * 1000)::bigint,
    'datasetId', dataset_import.dataset_id,
    'materializationId', dataset_import.dataset_id,
    'origin', jsonb_build_object(
      'importId', dataset_import.import_id,
      'kind', 'import'
    ),
    'recordCount', dataset_import.record_count,
    'rejectedCount', dataset_import.error_count,
    'revision', 1,
    'schemaHash', dataset_import.schema_hash,
    'state', CASE dataset_import.state
      WHEN 'running' THEN 'building'
      WHEN 'completed' THEN 'ready'
      ELSE 'failed'
      END,
    'workspaceId', dataset_import.workspace_id
  )),
  date_trunc('milliseconds', dataset_import.created_at)
FROM kurobara_core.dataset_imports AS dataset_import;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM kurobara_core.datasets AS dataset
    LEFT JOIN kurobara_core.dataset_materializations AS materialization
      ON materialization.workspace_id = dataset.workspace_id
      AND materialization.dataset_id = dataset.dataset_id
    WHERE materialization.materialization_id IS NULL
  ) THEN
    RAISE EXCEPTION
      'Cannot migrate a dataset without an exact import materialization'
      USING ERRCODE = '23514';
  END IF;
END;
$$;

ALTER TABLE kurobara_core.dataset_records
  ENABLE TRIGGER dataset_records_changes_are_guarded;

ALTER TABLE kurobara_core.dataset_records
  ALTER COLUMN materialization_id SET NOT NULL,
  ALTER COLUMN record_ordinal SET NOT NULL,
  ADD CONSTRAINT dataset_records_materialization_ordinal_key
    UNIQUE (workspace_id, materialization_id, record_ordinal),
  ADD CONSTRAINT dataset_records_materialization_fk
    FOREIGN KEY (workspace_id, materialization_id, dataset_id)
    REFERENCES kurobara_core.dataset_materializations (
      workspace_id,
      materialization_id,
      dataset_id
    ),
  ADD CHECK (record_ordinal > 0);

CREATE INDEX dataset_records_materialization_order_idx
  ON kurobara_core.dataset_records (
    workspace_id,
    materialization_id,
    record_ordinal
  );

CREATE FUNCTION kurobara_core.guard_dataset_generation_change()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'Kurobara dataset generations are immutable in this slice'
    USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER dataset_generations_are_immutable
  BEFORE UPDATE OR DELETE ON kurobara_core.dataset_generations
  FOR EACH ROW EXECUTE FUNCTION
    kurobara_core.guard_dataset_generation_change();

CREATE FUNCTION kurobara_core.guard_dataset_materialization_change()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Kurobara dataset materializations cannot be deleted'
      USING ERRCODE = '55000';
  END IF;

  IF OLD.workspace_id IS DISTINCT FROM NEW.workspace_id
    OR OLD.materialization_id IS DISTINCT FROM NEW.materialization_id
    OR OLD.dataset_id IS DISTINCT FROM NEW.dataset_id
    OR OLD.schema_hash IS DISTINCT FROM NEW.schema_hash
    OR OLD.origin_kind IS DISTINCT FROM NEW.origin_kind
    OR OLD.origin_id IS DISTINCT FROM NEW.origin_id
    OR OLD.created_at IS DISTINCT FROM NEW.created_at THEN
    RAISE EXCEPTION 'Kurobara dataset materialization identity is immutable'
      USING ERRCODE = '55000';
  END IF;

  IF OLD.state IN ('ready', 'failed', 'cancelled')
    AND OLD IS DISTINCT FROM NEW THEN
    RAISE EXCEPTION 'Kurobara terminal dataset materializations are immutable'
      USING ERRCODE = '55000';
  END IF;

  IF NEW.revision <> OLD.revision + 1 THEN
    RAISE EXCEPTION 'Kurobara materialization revision must advance once'
      USING ERRCODE = '55000';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER dataset_materialization_changes_are_guarded
  BEFORE UPDATE OR DELETE ON kurobara_core.dataset_materializations
  FOR EACH ROW EXECUTE FUNCTION
    kurobara_core.guard_dataset_materialization_change();

CREATE FUNCTION kurobara_core.require_dataset_materialization()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM kurobara_core.dataset_materializations AS materialization
    WHERE materialization.workspace_id = NEW.workspace_id
      AND materialization.dataset_id = NEW.dataset_id
      AND materialization.materialization_id = NEW.dataset_id
  ) THEN
    RAISE EXCEPTION 'A Kurobara dataset requires one materialization'
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER datasets_require_one_materialization
  AFTER INSERT ON kurobara_core.datasets
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION
    kurobara_core.require_dataset_materialization();
