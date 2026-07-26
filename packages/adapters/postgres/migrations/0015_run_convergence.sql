-- Deployment barrier: drain every worker older than 0015 before applying this
-- migration. An older DAG worker can consume the one-time running-run backfill
-- without persisting a convergence outcome or finalizing a failed run.

CREATE TABLE kurobara_core.run_result_manifests (
  workspace_id text NOT NULL,
  run_id text NOT NULL,
  run_plan_id text NOT NULL,
  result_manifest_id text NOT NULL,
  manifest_hash text NOT NULL,
  plan_hash text NOT NULL,
  conclusion text NOT NULL,
  result_completeness text NOT NULL,
  source_run_aggregate_version integer NOT NULL,
  cost_unit text NOT NULL,
  cost_spent numeric NOT NULL,
  manifest jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (workspace_id, run_id),
  UNIQUE (workspace_id, result_manifest_id),
  UNIQUE (
    workspace_id,
    run_id,
    result_manifest_id,
    manifest_hash
  ),
  FOREIGN KEY (workspace_id, run_id)
    REFERENCES kurobara_core.runs (workspace_id, run_id),
  FOREIGN KEY (workspace_id, run_plan_id)
    REFERENCES kurobara_core.run_plans (workspace_id, run_plan_id),
  CHECK (length(result_manifest_id) > 0),
  CHECK (manifest_hash ~ '^sha256:[0-9a-f]{64}$'),
  CHECK (plan_hash ~ '^sha256:[0-9a-f]{64}$'),
  CHECK (conclusion = 'failed'),
  CHECK (result_completeness = 'none'),
  CHECK (source_run_aggregate_version >= 1),
  CHECK (length(cost_unit) > 0),
  CHECK (cost_spent >= 0),
  CHECK (jsonb_typeof(manifest) = 'object'),
  CHECK (manifest ?& ARRAY[
    'workspaceId',
    'runId',
    'runPlanId',
    'resultManifestId',
    'manifestHash',
    'planHash',
    'conclusion',
    'resultCompleteness',
    'manifestVersion',
    'coverage',
    'entries',
    'attemptSettlements',
    'output',
    'cost',
    'createdAt',
    'sourceRunAggregateVersion'
  ]),
  CHECK (manifest ->> 'workspaceId' = workspace_id),
  CHECK (manifest ->> 'runId' = run_id),
  CHECK (manifest ->> 'runPlanId' = run_plan_id),
  CHECK (manifest ->> 'resultManifestId' = result_manifest_id),
  CHECK (manifest ->> 'manifestHash' = manifest_hash),
  CHECK (manifest ->> 'planHash' = plan_hash),
  CHECK (manifest ->> 'conclusion' = conclusion),
  CHECK (manifest ->> 'resultCompleteness' = result_completeness),
  CHECK ((manifest ->> 'manifestVersion')::integer = 1),
  CHECK (manifest ->> 'coverage' = 'complete'),
  CHECK (jsonb_typeof(manifest -> 'entries') = 'array'),
  CHECK (jsonb_typeof(manifest -> 'attemptSettlements') = 'array'),
  CHECK (jsonb_typeof(manifest -> 'output') = 'object'),
  CHECK ((manifest -> 'output') ?& ARRAY['status', 'reason']),
  CHECK (manifest #>> '{output,status}' = 'missing'),
  CHECK (manifest #>> '{output,reason}' = 'run-failed'),
  CHECK (jsonb_typeof(manifest -> 'cost') = 'object'),
  CHECK ((manifest -> 'cost') ?& ARRAY['reserved', 'spent', 'unit']),
  CHECK ((manifest #>> '{cost,reserved}')::numeric = 0),
  CHECK ((manifest #>> '{cost,spent}')::numeric = cost_spent),
  CHECK (manifest #>> '{cost,unit}' = cost_unit),
  CHECK ((manifest ->> 'createdAt')::bigint >= 0),
  CHECK (
    created_at = to_timestamp(
      (manifest ->> 'createdAt')::double precision / 1000
    )
  ),
  CHECK (
    (manifest ->> 'sourceRunAggregateVersion')::integer
      = source_run_aggregate_version
  )
);

CREATE FUNCTION kurobara_core.reject_immutable_result_manifest_change()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'Kurobara result manifests are immutable'
    USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER run_result_manifests_are_immutable
  BEFORE UPDATE OR DELETE ON kurobara_core.run_result_manifests
  FOR EACH ROW EXECUTE FUNCTION
    kurobara_core.reject_immutable_result_manifest_change();

ALTER TABLE kurobara_core.runs
  ADD COLUMN result_manifest_id text GENERATED ALWAYS AS (
    run #>> '{resultManifest,resultManifestId}'
  ) STORED,
  ADD COLUMN result_manifest_hash text GENERATED ALWAYS AS (
    run #>> '{resultManifest,manifestHash}'
  ) STORED,
  ADD CONSTRAINT runs_result_manifest_ref_consistent CHECK (
    (result_manifest_id IS NULL AND result_manifest_hash IS NULL)
    OR (
      result_manifest_id IS NOT NULL
      AND result_manifest_hash IS NOT NULL
      AND length(result_manifest_id) > 0
      AND result_manifest_hash ~ '^sha256:[0-9a-f]{64}$'
    )
  ),
  ADD CONSTRAINT runs_result_manifest_fkey
    FOREIGN KEY (
      workspace_id,
      run_id,
      result_manifest_id,
      result_manifest_hash
    )
    REFERENCES kurobara_core.run_result_manifests (
      workspace_id,
      run_id,
      result_manifest_id,
      manifest_hash
    )
    DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE kurobara_core.run_dag_schedule_jobs
  ADD COLUMN last_outcome text,
  ADD COLUMN blocked_reason text,
  ADD COLUMN evaluated_at timestamptz;

UPDATE kurobara_core.run_dag_schedule_jobs AS job
SET
  last_outcome = CASE
    WHEN stored_run.run ->> 'state' = 'running' THEN 'waiting'
    ELSE 'stale-terminal'
  END,
  evaluated_at = COALESCE(job.processed_at, clock_timestamp())
FROM kurobara_core.runs AS stored_run
WHERE NOT job.pending
  AND stored_run.workspace_id = job.workspace_id
  AND stored_run.run_id = job.run_id;

ALTER TABLE kurobara_core.run_dag_schedule_jobs
  ADD CONSTRAINT run_dag_schedule_jobs_last_outcome_valid CHECK (
    last_outcome IS NULL
    OR last_outcome IN (
      'steps-materialized',
      'waiting',
      'failure-finalized',
      'blocked',
      'stale-terminal'
    )
  ),
  ADD CONSTRAINT run_dag_schedule_jobs_blocked_reason_valid CHECK (
    blocked_reason IS NULL
    OR blocked_reason IN (
      'active-attempt-present',
      'result-proof-missing',
      'step-coverage-incomplete',
      'step-not-terminal',
      'unsettled-cost-present',
      'unsupported-terminal-mix'
    )
  ),
  ADD CONSTRAINT run_dag_schedule_jobs_evaluation_consistent CHECK (
    (
      pending
      AND processed_at IS NULL
      AND last_outcome IS NULL
      AND blocked_reason IS NULL
      AND evaluated_at IS NULL
    )
    OR (
      NOT pending
      AND processed_at IS NOT NULL
      AND last_outcome IS NOT NULL
      AND evaluated_at IS NOT NULL
      AND (
        (last_outcome = 'blocked' AND blocked_reason IS NOT NULL)
        OR (last_outcome <> 'blocked' AND blocked_reason IS NULL)
      )
    )
  );

-- Re-evaluate every running run once the 0015 worker is the only active DAG
-- writer. This does not synthesize a manifest or terminal lifecycle evidence.
INSERT INTO kurobara_core.run_dag_schedule_jobs (
  workspace_id,
  run_id,
  pending,
  requested_at,
  processed_at,
  last_outcome,
  blocked_reason,
  evaluated_at
)
SELECT
  workspace_id,
  run_id,
  true,
  clock_timestamp(),
  NULL,
  NULL,
  NULL,
  NULL
FROM kurobara_core.runs
WHERE run ->> 'state' = 'running'
ON CONFLICT (workspace_id, run_id) DO UPDATE SET
  pending = true,
  requested_at = clock_timestamp(),
  processed_at = NULL,
  last_outcome = NULL,
  blocked_reason = NULL,
  evaluated_at = NULL;
