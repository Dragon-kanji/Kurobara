-- Deployment barrier: drain every worker older than 0016 before applying this
-- migration. Older workers cannot validate output artifacts or persist a
-- successful convergence bundle when they consume a DAG wake-up.

ALTER TABLE kurobara_core.step_attempts
  ADD CONSTRAINT step_attempts_output_identity_key
    UNIQUE (
      workspace_id,
      step_run_id,
      attempt_id,
      operation_key
    );

CREATE TABLE kurobara_core.run_output_artifacts (
  workspace_id text NOT NULL,
  artifact_id text NOT NULL,
  run_id text NOT NULL,
  step_run_id text NOT NULL,
  attempt_id text NOT NULL,
  operation_key text NOT NULL,
  content_hash text NOT NULL,
  contract jsonb NOT NULL,
  normalized_payload jsonb NOT NULL,
  classification text NOT NULL,
  kind text NOT NULL,
  media_type text NOT NULL,
  retention_policy text NOT NULL,
  size_bytes bigint NOT NULL,
  state text NOT NULL,
  validator_version text NOT NULL,
  validated_at timestamptz NOT NULL,
  artifact jsonb NOT NULL,
  finalized_at timestamptz NOT NULL,
  PRIMARY KEY (workspace_id, artifact_id),
  UNIQUE (workspace_id, attempt_id),
  UNIQUE (
    workspace_id,
    run_id,
    artifact_id,
    content_hash
  ),
  FOREIGN KEY (workspace_id, run_id, step_run_id)
    REFERENCES kurobara_core.step_runs (
      workspace_id,
      run_id,
      step_run_id
    ),
  FOREIGN KEY (
    workspace_id,
    step_run_id,
    attempt_id,
    operation_key
  )
    REFERENCES kurobara_core.step_attempts (
      workspace_id,
      step_run_id,
      attempt_id,
      operation_key
    ),
  CHECK (length(artifact_id) > 0),
  CHECK (length(operation_key) > 0),
  CHECK (content_hash ~ '^sha256:[0-9a-f]{64}$'),
  CHECK (jsonb_typeof(contract) = 'object'),
  CHECK (contract ?& ARRAY[
    'catalogVersion',
    'catalogFingerprint',
    'schemaId',
    'schemaVersion',
    'schemaFingerprint'
  ]),
  CHECK (classification = 'internal'),
  CHECK (kind = 'normalized-output'),
  CHECK (media_type = 'application/json'),
  CHECK (retention_policy = 'run'),
  CHECK (size_bytes >= 0),
  CHECK (state = 'finalized'),
  CHECK (length(validator_version) > 0),
  CHECK (octet_length(normalized_payload::text) <= 65536),
  CHECK (jsonb_typeof(artifact) = 'object'),
  CHECK (artifact ?& ARRAY[
    'workspaceId',
    'runId',
    'stepRunId',
    'attemptId',
    'operationKey',
    'artifactId',
    'contentHash',
    'contract',
    'classification',
    'finalizedAt',
    'kind',
    'mediaType',
    'retentionPolicy',
    'sizeBytes',
    'state',
    'validatedAt',
    'validatorVersion'
  ]),
  CHECK (artifact ->> 'workspaceId' = workspace_id),
  CHECK (artifact ->> 'runId' = run_id),
  CHECK (artifact ->> 'stepRunId' = step_run_id),
  CHECK (artifact ->> 'attemptId' = attempt_id),
  CHECK (artifact ->> 'operationKey' = operation_key),
  CHECK (artifact ->> 'artifactId' = artifact_id),
  CHECK (artifact ->> 'contentHash' = content_hash),
  CHECK (artifact -> 'contract' = contract),
  CHECK (artifact ->> 'classification' = classification),
  CHECK (artifact ->> 'kind' = kind),
  CHECK (artifact ->> 'mediaType' = media_type),
  CHECK (artifact ->> 'retentionPolicy' = retention_policy),
  CHECK ((artifact ->> 'sizeBytes')::bigint = size_bytes),
  CHECK (artifact ->> 'state' = state),
  CHECK (artifact ->> 'validatorVersion' = validator_version),
  CHECK ((artifact ->> 'validatedAt')::bigint >= 0),
  CHECK (
    validated_at = to_timestamp(
      (artifact ->> 'validatedAt')::double precision / 1000
    )
  ),
  CHECK ((artifact ->> 'finalizedAt')::bigint >= 0),
  CHECK (
    finalized_at = to_timestamp(
      (artifact ->> 'finalizedAt')::double precision / 1000
    )
  )
);

CREATE FUNCTION kurobara_core.reject_immutable_output_artifact_change()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'Kurobara output artifacts are immutable'
    USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER run_output_artifacts_are_immutable
  BEFORE UPDATE OR DELETE ON kurobara_core.run_output_artifacts
  FOR EACH ROW EXECUTE FUNCTION
    kurobara_core.reject_immutable_output_artifact_change();

ALTER TABLE kurobara_core.run_result_manifests
  DROP CONSTRAINT run_result_manifests_conclusion_check,
  DROP CONSTRAINT run_result_manifests_result_completeness_check,
  DROP CONSTRAINT run_result_manifests_manifest_check7,
  DROP CONSTRAINT run_result_manifests_manifest_check8,
  DROP CONSTRAINT run_result_manifests_manifest_check9,
  ADD COLUMN output_artifact_id text GENERATED ALWAYS AS (
    manifest #>> '{output,artifact,artifactId}'
  ) STORED,
  ADD COLUMN output_content_hash text GENERATED ALWAYS AS (
    manifest #>> '{output,artifact,contentHash}'
  ) STORED,
  ADD CONSTRAINT run_result_manifests_conclusion_valid CHECK (
    conclusion IN ('failed', 'completed')
  ),
  ADD CONSTRAINT run_result_manifests_completeness_valid CHECK (
    (conclusion = 'failed' AND result_completeness = 'none')
    OR
    (conclusion = 'completed' AND result_completeness = 'complete')
  ),
  ADD CONSTRAINT run_result_manifests_output_valid CHECK (
    (
      conclusion = 'failed'
      AND manifest #>> '{output,status}' = 'missing'
      AND manifest #>> '{output,reason}' = 'run-failed'
      AND output_artifact_id IS NULL
      AND output_content_hash IS NULL
    )
    OR
    (
      conclusion = 'completed'
      AND manifest #>> '{output,status}' = 'accepted'
      AND (manifest -> 'output') ?& ARRAY[
        'artifact',
        'contract',
        'validatedAt',
        'validatorVersion'
      ]
      AND jsonb_typeof(manifest #> '{output,artifact}') = 'object'
      AND (manifest #> '{output,artifact}') ?& ARRAY[
        'artifactId',
        'contentHash'
      ]
      AND output_artifact_id IS NOT NULL
      AND length(output_artifact_id) > 0
      AND output_content_hash ~ '^sha256:[0-9a-f]{64}$'
      AND length(manifest #>> '{output,validatorVersion}') > 0
    )
  ),
  ADD CONSTRAINT run_result_manifests_output_artifact_fkey
    FOREIGN KEY (
      workspace_id,
      run_id,
      output_artifact_id,
      output_content_hash
    )
    REFERENCES kurobara_core.run_output_artifacts (
      workspace_id,
      run_id,
      artifact_id,
      content_hash
    )
    DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE kurobara_core.run_dag_schedule_jobs
  DROP CONSTRAINT run_dag_schedule_jobs_last_outcome_valid,
  DROP CONSTRAINT run_dag_schedule_jobs_blocked_reason_valid,
  ADD CONSTRAINT run_dag_schedule_jobs_last_outcome_valid CHECK (
    last_outcome IS NULL
    OR last_outcome IN (
      'steps-materialized',
      'waiting',
      'failure-finalized',
      'success-finalized',
      'blocked',
      'stale-terminal'
    )
  ),
  ADD CONSTRAINT run_dag_schedule_jobs_blocked_reason_valid CHECK (
    blocked_reason IS NULL
    OR blocked_reason IN (
      'active-attempt-present',
      'result-proof-missing',
      'output-binding-ambiguous',
      'step-coverage-incomplete',
      'step-not-terminal',
      'unsettled-cost-present',
      'unsupported-terminal-mix'
    )
  );
