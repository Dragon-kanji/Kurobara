CREATE TABLE kurobara_core.run_dag_schedule_jobs (
  workspace_id text NOT NULL,
  run_id text NOT NULL,
  pending boolean NOT NULL DEFAULT true,
  requested_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  processed_at timestamptz,
  PRIMARY KEY (workspace_id, run_id),
  FOREIGN KEY (workspace_id, run_id)
    REFERENCES kurobara_core.runs (workspace_id, run_id),
  CHECK (
    (pending AND processed_at IS NULL)
    OR (NOT pending AND processed_at IS NOT NULL)
  )
);

CREATE INDEX run_dag_schedule_pending_idx
  ON kurobara_core.run_dag_schedule_jobs (
    requested_at,
    workspace_id,
    run_id
  )
  WHERE pending;

INSERT INTO kurobara_core.run_dag_schedule_jobs (
  workspace_id,
  run_id,
  pending
)
SELECT workspace_id, run_id, true
FROM kurobara_core.runs
WHERE run ->> 'state' = 'running'
ON CONFLICT (workspace_id, run_id) DO NOTHING;
