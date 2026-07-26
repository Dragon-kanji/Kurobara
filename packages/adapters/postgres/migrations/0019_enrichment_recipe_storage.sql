-- Recipe applications are immutable, bounded descriptions of work. They do
-- not own an execution lifecycle: canonical Runs and CellResults do.

ALTER TABLE kurobara_core.dataset_records
  ADD CONSTRAINT dataset_records_exact_content_key UNIQUE (
    workspace_id,
    dataset_id,
    record_id,
    content_hash
  );

ALTER TABLE kurobara_core.runs
  ADD CONSTRAINT runs_exact_plan_key UNIQUE (
    workspace_id,
    run_id,
    run_plan_id
  );

ALTER TABLE kurobara_core.run_plan_sources
  ADD CONSTRAINT run_plan_sources_exact_workflow_key UNIQUE (
    workspace_id,
    run_plan_id,
    workflow_spec_id,
    workflow_revision,
    workflow_content_hash
  );

CREATE TABLE kurobara_core.enrichment_recipes (
  workspace_id text NOT NULL,
  dataset_id text NOT NULL,
  enrichment_recipe_id text NOT NULL,
  recipe_revision text NOT NULL,
  name text NOT NULL,
  target_field_id text NOT NULL,
  workflow_spec_id text NOT NULL,
  workflow_revision text NOT NULL,
  workflow_content_hash text NOT NULL,
  input_count integer NOT NULL,
  recipe jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (
    workspace_id,
    dataset_id,
    enrichment_recipe_id,
    recipe_revision
  ),
  UNIQUE (
    workspace_id,
    dataset_id,
    enrichment_recipe_id,
    recipe_revision,
    target_field_id
  ),
  UNIQUE (
    workspace_id,
    dataset_id,
    enrichment_recipe_id,
    recipe_revision,
    target_field_id,
    workflow_spec_id,
    workflow_revision,
    workflow_content_hash
  ),
  FOREIGN KEY (workspace_id, dataset_id)
    REFERENCES kurobara_core.datasets (workspace_id, dataset_id),
  FOREIGN KEY (workspace_id, dataset_id, target_field_id)
    REFERENCES kurobara_core.dataset_fields (
      workspace_id,
      dataset_id,
      field_id
    ),
  FOREIGN KEY (
    workspace_id,
    workflow_spec_id,
    workflow_revision,
    workflow_content_hash
  ) REFERENCES kurobara_core.workflow_snapshots (
    workspace_id,
    workflow_spec_id,
    workflow_revision,
    workflow_content_hash
  ),
  CHECK (char_length(enrichment_recipe_id) BETWEEN 1 AND 255),
  CHECK (btrim(enrichment_recipe_id) <> ''),
  CHECK (char_length(recipe_revision) BETWEEN 1 AND 255),
  CHECK (btrim(recipe_revision) <> ''),
  CHECK (char_length(name) BETWEEN 1 AND 255),
  CHECK (btrim(name) <> ''),
  CHECK (input_count BETWEEN 1 AND 64),
  CHECK (workflow_content_hash ~ '^sha256:[0-9a-f]{64}$'),
  CHECK (jsonb_typeof(recipe) = 'object'),
  CHECK (recipe ?& ARRAY[
    'workspaceId',
    'datasetId',
    'enrichmentRecipeId',
    'recipeRevision',
    'name',
    'targetFieldId',
    'workflowSpecId',
    'workflowRevision',
    'workflowContentHash',
    'inputFieldIds'
  ]),
  CHECK (octet_length(recipe::text) <= 65536),
  CHECK (recipe ->> 'workspaceId' = workspace_id),
  CHECK (recipe ->> 'datasetId' = dataset_id),
  CHECK (recipe ->> 'enrichmentRecipeId' = enrichment_recipe_id),
  CHECK (recipe ->> 'recipeRevision' = recipe_revision),
  CHECK (recipe ->> 'name' = name),
  CHECK (recipe ->> 'targetFieldId' = target_field_id),
  CHECK (recipe ->> 'workflowSpecId' = workflow_spec_id),
  CHECK (recipe ->> 'workflowRevision' = workflow_revision),
  CHECK (recipe ->> 'workflowContentHash' = workflow_content_hash),
  CHECK (jsonb_typeof(recipe -> 'inputFieldIds') = 'array'),
  CHECK (jsonb_array_length(recipe -> 'inputFieldIds') = input_count)
);

CREATE TABLE kurobara_core.enrichment_recipe_inputs (
  workspace_id text NOT NULL,
  dataset_id text NOT NULL,
  enrichment_recipe_id text NOT NULL,
  recipe_revision text NOT NULL,
  ordinal integer NOT NULL,
  input_field_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (
    workspace_id,
    dataset_id,
    enrichment_recipe_id,
    recipe_revision,
    ordinal
  ),
  UNIQUE (
    workspace_id,
    dataset_id,
    enrichment_recipe_id,
    recipe_revision,
    input_field_id
  ),
  FOREIGN KEY (
    workspace_id,
    dataset_id,
    enrichment_recipe_id,
    recipe_revision
  ) REFERENCES kurobara_core.enrichment_recipes (
    workspace_id,
    dataset_id,
    enrichment_recipe_id,
    recipe_revision
  ),
  FOREIGN KEY (workspace_id, dataset_id, input_field_id)
    REFERENCES kurobara_core.dataset_fields (
      workspace_id,
      dataset_id,
      field_id
    ),
  CHECK (ordinal BETWEEN 0 AND 63),
  CHECK (char_length(input_field_id) BETWEEN 1 AND 255),
  CHECK (btrim(input_field_id) <> '')
);

CREATE TABLE kurobara_core.recipe_applications (
  workspace_id text NOT NULL,
  recipe_application_id text NOT NULL,
  dataset_id text NOT NULL,
  enrichment_recipe_id text NOT NULL,
  recipe_revision text NOT NULL,
  target_field_id text NOT NULL,
  graph_hash text NOT NULL,
  intent_hash text NOT NULL,
  max_cells integer NOT NULL,
  record_count integer NOT NULL,
  application jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (workspace_id, recipe_application_id),
  UNIQUE (
    workspace_id,
    recipe_application_id,
    dataset_id,
    enrichment_recipe_id,
    recipe_revision,
    target_field_id
  ),
  FOREIGN KEY (
    workspace_id,
    dataset_id,
    enrichment_recipe_id,
    recipe_revision,
    target_field_id
  ) REFERENCES kurobara_core.enrichment_recipes (
    workspace_id,
    dataset_id,
    enrichment_recipe_id,
    recipe_revision,
    target_field_id
  ),
  CHECK (char_length(recipe_application_id) BETWEEN 1 AND 255),
  CHECK (btrim(recipe_application_id) <> ''),
  CHECK (graph_hash ~ '^sha256:[0-9a-f]{64}$'),
  CHECK (intent_hash ~ '^sha256:[0-9a-f]{64}$'),
  CHECK (max_cells BETWEEN 1 AND 10000),
  CHECK (record_count BETWEEN 1 AND max_cells),
  CHECK (jsonb_typeof(application) = 'object'),
  CHECK (application ?& ARRAY[
    'workspaceId',
    'recipeApplicationId',
    'datasetId',
    'recipeId',
    'recipeRevision',
    'targetFieldId',
    'graph',
    'graphHash',
    'intentHash',
    'maxCells',
    'createdAt'
  ]),
  CHECK (octet_length(application::text) <= 2097152),
  CHECK (application ->> 'workspaceId' = workspace_id),
  CHECK (application ->> 'recipeApplicationId' = recipe_application_id),
  CHECK (application ->> 'datasetId' = dataset_id),
  CHECK (application ->> 'recipeId' = enrichment_recipe_id),
  CHECK (application ->> 'recipeRevision' = recipe_revision),
  CHECK (application ->> 'targetFieldId' = target_field_id),
  CHECK (application ->> 'graphHash' = graph_hash),
  CHECK (application ->> 'intentHash' = intent_hash),
  CHECK ((application ->> 'maxCells')::integer = max_cells),
  CHECK (jsonb_typeof(application -> 'graph') = 'object'),
  CHECK ((application -> 'graph') ?& ARRAY['recordIds']),
  CHECK (jsonb_typeof(application #> '{graph,recordIds}') = 'array'),
  CHECK (
    jsonb_array_length(application #> '{graph,recordIds}') = record_count
  ),
  CHECK ((application ->> 'createdAt')::bigint >= 0),
  CHECK (
    created_at = to_timestamp(
      (application ->> 'createdAt')::double precision / 1000
    )
  )
);

CREATE TABLE kurobara_core.cell_results (
  workspace_id text NOT NULL,
  cell_result_id text NOT NULL,
  recipe_application_id text NOT NULL,
  dataset_id text NOT NULL,
  record_id text NOT NULL,
  record_content_hash text NOT NULL,
  field_id text NOT NULL,
  enrichment_recipe_id text NOT NULL,
  recipe_revision text NOT NULL,
  workflow_spec_id text NOT NULL,
  workflow_revision text NOT NULL,
  workflow_content_hash text NOT NULL,
  cache_key text NOT NULL,
  input_id text NOT NULL,
  input_hash text NOT NULL,
  run_plan_id text NOT NULL,
  run_id text NOT NULL,
  status text NOT NULL,
  value jsonb,
  confidence numeric,
  cost jsonb,
  freshness jsonb,
  provenance jsonb,
  reason jsonb,
  freshness_expires_at timestamptz,
  result_manifest_id text,
  manifest_hash text,
  artifact_id text,
  artifact_content_hash text,
  source_run_aggregate_version integer,
  cell_result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workspace_id, cell_result_id),
  UNIQUE (workspace_id, run_id),
  UNIQUE (workspace_id, cache_key, cell_result_id),
  UNIQUE (
    workspace_id,
    dataset_id,
    record_id,
    record_content_hash,
    field_id,
    enrichment_recipe_id,
    recipe_revision,
    input_hash,
    cache_key,
    cell_result_id
  ),
  FOREIGN KEY (
    workspace_id,
    recipe_application_id,
    dataset_id,
    enrichment_recipe_id,
    recipe_revision,
    field_id
  ) REFERENCES kurobara_core.recipe_applications (
    workspace_id,
    recipe_application_id,
    dataset_id,
    enrichment_recipe_id,
    recipe_revision,
    target_field_id
  ),
  FOREIGN KEY (
    workspace_id,
    dataset_id,
    enrichment_recipe_id,
    recipe_revision,
    field_id,
    workflow_spec_id,
    workflow_revision,
    workflow_content_hash
  ) REFERENCES kurobara_core.enrichment_recipes (
    workspace_id,
    dataset_id,
    enrichment_recipe_id,
    recipe_revision,
    target_field_id,
    workflow_spec_id,
    workflow_revision,
    workflow_content_hash
  ),
  FOREIGN KEY (
    workspace_id,
    dataset_id,
    record_id,
    record_content_hash
  ) REFERENCES kurobara_core.dataset_records (
    workspace_id,
    dataset_id,
    record_id,
    content_hash
  ),
  FOREIGN KEY (workspace_id, dataset_id, field_id)
    REFERENCES kurobara_core.dataset_fields (
      workspace_id,
      dataset_id,
      field_id
    ),
  FOREIGN KEY (workspace_id, run_id, run_plan_id)
    REFERENCES kurobara_core.runs (
      workspace_id,
      run_id,
      run_plan_id
    ),
  FOREIGN KEY (
    workspace_id,
    run_plan_id,
    workflow_spec_id,
    workflow_revision,
    workflow_content_hash
  ) REFERENCES kurobara_core.run_plan_sources (
    workspace_id,
    run_plan_id,
    workflow_spec_id,
    workflow_revision,
    workflow_content_hash
  ),
  FOREIGN KEY (workspace_id, run_plan_id, input_id, input_hash)
    REFERENCES kurobara_core.run_plan_inputs (
      workspace_id,
      run_plan_id,
      input_id,
      content_hash
    ),
  FOREIGN KEY (
    workspace_id,
    run_id,
    result_manifest_id,
    manifest_hash
  ) REFERENCES kurobara_core.run_result_manifests (
    workspace_id,
    run_id,
    result_manifest_id,
    manifest_hash
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
  CHECK (char_length(cell_result_id) BETWEEN 1 AND 255),
  CHECK (btrim(cell_result_id) <> ''),
  CHECK (record_content_hash ~ '^sha256:[0-9a-f]{64}$'),
  CHECK (cache_key ~ '^sha256:[0-9a-f]{64}$'),
  CHECK (input_hash ~ '^sha256:[0-9a-f]{64}$'),
  CHECK (workflow_content_hash ~ '^sha256:[0-9a-f]{64}$'),
  CHECK (status IN ('pending', 'running', 'succeeded', 'failed', 'skipped')),
  CHECK (confidence IS NULL OR confidence BETWEEN 0 AND 1),
  CHECK (cost IS NULL OR jsonb_typeof(cost) = 'object'),
  CHECK (cost IS NULL OR cost ?& ARRAY['amount', 'basis', 'unit']),
  CHECK (freshness IS NULL OR jsonb_typeof(freshness) = 'object'),
  CHECK (freshness IS NULL OR freshness ?& ARRAY['observedAt']),
  CHECK (provenance IS NULL OR jsonb_typeof(provenance) = 'object'),
  CHECK (provenance IS NULL OR provenance ?& ARRAY['references']),
  CHECK (reason IS NULL OR jsonb_typeof(reason) = 'object'),
  CHECK (reason IS NULL OR reason ?& ARRAY['code', 'message', 'retryable']),
  CHECK (
    (status = 'succeeded' AND value IS NOT NULL AND reason IS NULL)
    OR (status IN ('failed', 'skipped') AND value IS NULL AND reason IS NOT NULL)
    OR (
      status IN ('pending', 'running')
      AND value IS NULL
      AND reason IS NULL
    )
  ),
  CHECK (
    (status IN ('pending', 'running')
      AND result_manifest_id IS NULL
      AND manifest_hash IS NULL
      AND artifact_id IS NULL
      AND artifact_content_hash IS NULL
      AND source_run_aggregate_version IS NULL)
    OR (status = 'failed'
      AND result_manifest_id IS NOT NULL
      AND manifest_hash IS NOT NULL
      AND artifact_id IS NULL
      AND artifact_content_hash IS NULL
      AND source_run_aggregate_version >= 1)
    OR (status = 'skipped'
      AND result_manifest_id IS NULL
      AND manifest_hash IS NULL
      AND artifact_id IS NULL
      AND artifact_content_hash IS NULL
      AND source_run_aggregate_version >= 1)
    OR (status = 'succeeded'
      AND result_manifest_id IS NOT NULL
      AND manifest_hash IS NOT NULL
      AND artifact_id IS NOT NULL
      AND artifact_content_hash IS NOT NULL
      AND source_run_aggregate_version >= 1)
  ),
  CHECK (
    freshness_expires_at IS NULL
    OR (status = 'succeeded' AND freshness IS NOT NULL)
  ),
  CHECK (jsonb_typeof(cell_result) = 'object'),
  CHECK (cell_result ?& ARRAY[
    'workspaceId',
    'cellResultId',
    'datasetId',
    'recordId',
    'fieldId',
    'enrichmentRecipeId',
    'recipeRevision',
    'runId',
    'status'
  ]),
  CHECK (
    status IN ('pending', 'running')
    OR (status = 'succeeded' AND cell_result ?& ARRAY['value'])
    OR (status IN ('failed', 'skipped') AND cell_result ?& ARRAY['reason'])
  ),
  CHECK (octet_length(cell_result::text) <= 131072),
  CHECK (cell_result ->> 'workspaceId' = workspace_id),
  CHECK (cell_result ->> 'cellResultId' = cell_result_id),
  CHECK (cell_result ->> 'datasetId' = dataset_id),
  CHECK (cell_result ->> 'recordId' = record_id),
  CHECK (cell_result ->> 'fieldId' = field_id),
  CHECK (cell_result ->> 'enrichmentRecipeId' = enrichment_recipe_id),
  CHECK (cell_result ->> 'recipeRevision' = recipe_revision),
  CHECK (cell_result ->> 'runId' = run_id),
  CHECK (cell_result ->> 'status' = status),
  CHECK ((cell_result ? 'value') = (value IS NOT NULL)),
  CHECK (NOT (cell_result ? 'value') OR cell_result -> 'value' = value),
  CHECK ((cell_result ? 'confidence') = (confidence IS NOT NULL)),
  CHECK (
    NOT (cell_result ? 'confidence')
    OR (cell_result ->> 'confidence')::numeric = confidence
  ),
  CHECK ((cell_result ? 'cost') = (cost IS NOT NULL)),
  CHECK (NOT (cell_result ? 'cost') OR cell_result -> 'cost' = cost),
  CHECK ((cell_result ? 'freshness') = (freshness IS NOT NULL)),
  CHECK (
    NOT (cell_result ? 'freshness') OR cell_result -> 'freshness' = freshness
  ),
  CHECK ((cell_result ? 'provenance') = (provenance IS NOT NULL)),
  CHECK (
    NOT (cell_result ? 'provenance')
    OR cell_result -> 'provenance' = provenance
  ),
  CHECK ((cell_result ? 'reason') = (reason IS NOT NULL)),
  CHECK (NOT (cell_result ? 'reason') OR cell_result -> 'reason' = reason)
);

CREATE INDEX cell_results_application_order_idx
  ON kurobara_core.cell_results (
    workspace_id,
    recipe_application_id,
    record_id
  );

CREATE TABLE kurobara_core.recipe_application_cells (
  workspace_id text NOT NULL,
  recipe_application_id text NOT NULL,
  dataset_id text NOT NULL,
  record_id text NOT NULL,
  record_content_hash text NOT NULL,
  ordinal integer NOT NULL,
  field_id text NOT NULL,
  enrichment_recipe_id text NOT NULL,
  recipe_revision text NOT NULL,
  input_hash text NOT NULL,
  cache_key text NOT NULL,
  cell_result_id text NOT NULL,
  binding text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workspace_id, recipe_application_id, record_id),
  UNIQUE (workspace_id, recipe_application_id, ordinal),
  FOREIGN KEY (
    workspace_id,
    recipe_application_id,
    dataset_id,
    enrichment_recipe_id,
    recipe_revision,
    field_id
  ) REFERENCES kurobara_core.recipe_applications (
    workspace_id,
    recipe_application_id,
    dataset_id,
    enrichment_recipe_id,
    recipe_revision,
    target_field_id
  ),
  FOREIGN KEY (
    workspace_id,
    dataset_id,
    record_id,
    record_content_hash
  ) REFERENCES kurobara_core.dataset_records (
    workspace_id,
    dataset_id,
    record_id,
    content_hash
  ),
  FOREIGN KEY (
    workspace_id,
    dataset_id,
    record_id,
    record_content_hash,
    field_id,
    enrichment_recipe_id,
    recipe_revision,
    input_hash,
    cache_key,
    cell_result_id
  ) REFERENCES kurobara_core.cell_results (
    workspace_id,
    dataset_id,
    record_id,
    record_content_hash,
    field_id,
    enrichment_recipe_id,
    recipe_revision,
    input_hash,
    cache_key,
    cell_result_id
  ),
  CHECK (ordinal BETWEEN 0 AND 9999),
  CHECK (input_hash ~ '^sha256:[0-9a-f]{64}$'),
  CHECK (cache_key ~ '^sha256:[0-9a-f]{64}$'),
  CHECK (binding IN ('cached', 'executed'))
);

CREATE TABLE kurobara_core.recipe_cell_cache (
  workspace_id text NOT NULL,
  cache_key text NOT NULL,
  dataset_id text NOT NULL,
  record_id text NOT NULL,
  record_content_hash text NOT NULL,
  field_id text NOT NULL,
  enrichment_recipe_id text NOT NULL,
  recipe_revision text NOT NULL,
  workflow_spec_id text NOT NULL,
  workflow_revision text NOT NULL,
  workflow_content_hash text NOT NULL,
  input_hash text NOT NULL,
  active_cell_result_id text,
  valid_cell_result_id text,
  valid_until timestamptz,
  revision integer NOT NULL,
  cache_identity jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workspace_id, cache_key),
  FOREIGN KEY (workspace_id, cache_key, active_cell_result_id)
    REFERENCES kurobara_core.cell_results (
      workspace_id,
      cache_key,
      cell_result_id
    ) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (workspace_id, cache_key, valid_cell_result_id)
    REFERENCES kurobara_core.cell_results (
      workspace_id,
      cache_key,
      cell_result_id
    ) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (
    workspace_id,
    dataset_id,
    enrichment_recipe_id,
    recipe_revision,
    field_id,
    workflow_spec_id,
    workflow_revision,
    workflow_content_hash
  ) REFERENCES kurobara_core.enrichment_recipes (
    workspace_id,
    dataset_id,
    enrichment_recipe_id,
    recipe_revision,
    target_field_id,
    workflow_spec_id,
    workflow_revision,
    workflow_content_hash
  ),
  FOREIGN KEY (
    workspace_id,
    dataset_id,
    record_id,
    record_content_hash
  ) REFERENCES kurobara_core.dataset_records (
    workspace_id,
    dataset_id,
    record_id,
    content_hash
  ),
  CHECK (cache_key ~ '^sha256:[0-9a-f]{64}$'),
  CHECK (record_content_hash ~ '^sha256:[0-9a-f]{64}$'),
  CHECK (workflow_content_hash ~ '^sha256:[0-9a-f]{64}$'),
  CHECK (input_hash ~ '^sha256:[0-9a-f]{64}$'),
  CHECK (revision >= 1),
  CHECK ((valid_cell_result_id IS NULL) = (valid_until IS NULL)),
  CHECK (
    active_cell_result_id IS NULL
    OR valid_cell_result_id IS NULL
    OR active_cell_result_id <> valid_cell_result_id
  ),
  CHECK (jsonb_typeof(cache_identity) = 'object'),
  CHECK (cache_identity ?& ARRAY[
    'workspaceId',
    'datasetId',
    'recordId',
    'recordContentHash',
    'targetFieldId',
    'recipeId',
    'recipeRevision',
    'workflowSpecId',
    'workflowRevision',
    'workflowContentHash',
    'inputHash'
  ]),
  CHECK (octet_length(cache_identity::text) <= 32768),
  CHECK (cache_identity ->> 'workspaceId' = workspace_id),
  CHECK (cache_identity ->> 'datasetId' = dataset_id),
  CHECK (cache_identity ->> 'recordId' = record_id),
  CHECK (cache_identity ->> 'recordContentHash' = record_content_hash),
  CHECK (cache_identity ->> 'targetFieldId' = field_id),
  CHECK (cache_identity ->> 'recipeId' = enrichment_recipe_id),
  CHECK (cache_identity ->> 'recipeRevision' = recipe_revision),
  CHECK (cache_identity ->> 'workflowSpecId' = workflow_spec_id),
  CHECK (cache_identity ->> 'workflowRevision' = workflow_revision),
  CHECK (cache_identity ->> 'workflowContentHash' = workflow_content_hash),
  CHECK (cache_identity ->> 'inputHash' = input_hash)
);

CREATE FUNCTION kurobara_core.reject_immutable_recipe_record_change()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'Kurobara recipe records are immutable'
    USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER enrichment_recipes_are_immutable
  BEFORE UPDATE OR DELETE ON kurobara_core.enrichment_recipes
  FOR EACH ROW EXECUTE FUNCTION
    kurobara_core.reject_immutable_recipe_record_change();

CREATE TRIGGER enrichment_recipe_inputs_are_immutable
  BEFORE UPDATE OR DELETE ON kurobara_core.enrichment_recipe_inputs
  FOR EACH ROW EXECUTE FUNCTION
    kurobara_core.reject_immutable_recipe_record_change();

CREATE TRIGGER recipe_applications_are_immutable
  BEFORE UPDATE OR DELETE ON kurobara_core.recipe_applications
  FOR EACH ROW EXECUTE FUNCTION
    kurobara_core.reject_immutable_recipe_record_change();

CREATE TRIGGER recipe_application_cells_are_immutable
  BEFORE UPDATE OR DELETE ON kurobara_core.recipe_application_cells
  FOR EACH ROW EXECUTE FUNCTION
    kurobara_core.reject_immutable_recipe_record_change();

CREATE FUNCTION kurobara_core.guard_cell_result_change()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Kurobara cell results cannot be deleted'
      USING ERRCODE = '55000';
  END IF;

  IF OLD.workspace_id IS DISTINCT FROM NEW.workspace_id
    OR OLD.cell_result_id IS DISTINCT FROM NEW.cell_result_id
    OR OLD.recipe_application_id IS DISTINCT FROM NEW.recipe_application_id
    OR OLD.dataset_id IS DISTINCT FROM NEW.dataset_id
    OR OLD.record_id IS DISTINCT FROM NEW.record_id
    OR OLD.record_content_hash IS DISTINCT FROM NEW.record_content_hash
    OR OLD.field_id IS DISTINCT FROM NEW.field_id
    OR OLD.enrichment_recipe_id IS DISTINCT FROM NEW.enrichment_recipe_id
    OR OLD.recipe_revision IS DISTINCT FROM NEW.recipe_revision
    OR OLD.workflow_spec_id IS DISTINCT FROM NEW.workflow_spec_id
    OR OLD.workflow_revision IS DISTINCT FROM NEW.workflow_revision
    OR OLD.workflow_content_hash IS DISTINCT FROM NEW.workflow_content_hash
    OR OLD.cache_key IS DISTINCT FROM NEW.cache_key
    OR OLD.input_id IS DISTINCT FROM NEW.input_id
    OR OLD.input_hash IS DISTINCT FROM NEW.input_hash
    OR OLD.run_plan_id IS DISTINCT FROM NEW.run_plan_id
    OR OLD.run_id IS DISTINCT FROM NEW.run_id
    OR OLD.created_at IS DISTINCT FROM NEW.created_at THEN
    RAISE EXCEPTION 'Kurobara cell result identity is immutable'
      USING ERRCODE = '55000';
  END IF;

  IF OLD.status IN ('succeeded', 'failed', 'skipped') THEN
    RAISE EXCEPTION 'Kurobara terminal cell results are immutable'
      USING ERRCODE = '55000';
  END IF;

  IF NOT (
    (OLD.status = 'pending'
      AND NEW.status IN ('running', 'succeeded', 'failed', 'skipped'))
    OR (OLD.status = 'running' AND NEW.status IN ('succeeded', 'failed', 'skipped'))
  ) THEN
    RAISE EXCEPTION 'Kurobara cell result transition is invalid'
      USING ERRCODE = '55000';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER cell_result_changes_are_guarded
  BEFORE UPDATE OR DELETE ON kurobara_core.cell_results
  FOR EACH ROW EXECUTE FUNCTION kurobara_core.guard_cell_result_change();

CREATE FUNCTION kurobara_core.guard_recipe_cache_change()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Kurobara recipe cache slots cannot be deleted'
      USING ERRCODE = '55000';
  END IF;

  IF OLD.workspace_id IS DISTINCT FROM NEW.workspace_id
    OR OLD.cache_key IS DISTINCT FROM NEW.cache_key
    OR OLD.dataset_id IS DISTINCT FROM NEW.dataset_id
    OR OLD.record_id IS DISTINCT FROM NEW.record_id
    OR OLD.record_content_hash IS DISTINCT FROM NEW.record_content_hash
    OR OLD.field_id IS DISTINCT FROM NEW.field_id
    OR OLD.enrichment_recipe_id IS DISTINCT FROM NEW.enrichment_recipe_id
    OR OLD.recipe_revision IS DISTINCT FROM NEW.recipe_revision
    OR OLD.workflow_spec_id IS DISTINCT FROM NEW.workflow_spec_id
    OR OLD.workflow_revision IS DISTINCT FROM NEW.workflow_revision
    OR OLD.workflow_content_hash IS DISTINCT FROM NEW.workflow_content_hash
    OR OLD.input_hash IS DISTINCT FROM NEW.input_hash
    OR OLD.cache_identity IS DISTINCT FROM NEW.cache_identity
    OR OLD.created_at IS DISTINCT FROM NEW.created_at THEN
    RAISE EXCEPTION 'Kurobara recipe cache identity is immutable'
      USING ERRCODE = '55000';
  END IF;

  IF NEW.revision <> OLD.revision + 1 THEN
    RAISE EXCEPTION 'Kurobara recipe cache revision must advance by one'
      USING ERRCODE = '55000';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER recipe_cache_changes_are_guarded
  BEFORE UPDATE OR DELETE ON kurobara_core.recipe_cell_cache
  FOR EACH ROW EXECUTE FUNCTION kurobara_core.guard_recipe_cache_change();

CREATE FUNCTION kurobara_core.assert_recipe_run_cell_alignment()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  aligned_cell_status text;
  aligned_run_state text;
BEGIN
  SELECT stored_run.run ->> 'state', cell.status
  INTO aligned_run_state, aligned_cell_status
  FROM kurobara_core.runs AS stored_run
  JOIN kurobara_core.cell_results AS cell
    ON cell.workspace_id = stored_run.workspace_id
    AND cell.run_id = stored_run.run_id
  WHERE stored_run.workspace_id = NEW.workspace_id
    AND stored_run.run_id = NEW.run_id;

  IF aligned_cell_status IS NULL THEN
    RETURN NULL;
  END IF;

  IF NOT (
    (aligned_run_state = 'queued' AND aligned_cell_status = 'pending')
    OR (
      aligned_run_state IN ('running', 'waiting', 'cancelling', 'ambiguous')
      AND aligned_cell_status = 'running'
    )
    OR (aligned_run_state = 'completed' AND aligned_cell_status = 'succeeded')
    OR (aligned_run_state = 'failed' AND aligned_cell_status = 'failed')
    OR (aligned_run_state = 'cancelled' AND aligned_cell_status = 'skipped')
  ) THEN
    RAISE EXCEPTION
      'Kurobara recipe Run and CellResult must converge in one transaction'
      USING ERRCODE = '23514';
  END IF;

  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER recipe_run_cell_alignment_after_run
  AFTER INSERT OR UPDATE ON kurobara_core.runs
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION
    kurobara_core.assert_recipe_run_cell_alignment();

CREATE CONSTRAINT TRIGGER recipe_run_cell_alignment_after_cell
  AFTER INSERT OR UPDATE ON kurobara_core.cell_results
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION
    kurobara_core.assert_recipe_run_cell_alignment();
