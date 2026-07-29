CREATE TABLE kurobara_core.gtm_context_revisions (
  workspace_id text NOT NULL REFERENCES kurobara_core.workspaces (workspace_id),
  context_id text NOT NULL,
  revision integer NOT NULL,
  fingerprint text NOT NULL,
  document jsonb NOT NULL,
  created_by_actor_id text NOT NULL,
  created_at_ms bigint NOT NULL,
  PRIMARY KEY (workspace_id, context_id, revision),
  UNIQUE (workspace_id, context_id, fingerprint),
  CHECK (context_id <> '' AND length(context_id) <= 255),
  CHECK (revision > 0),
  CHECK (fingerprint ~ '^sha256:[0-9a-f]{64}$'),
  CHECK (created_by_actor_id <> ''),
  CHECK (created_at_ms >= 0)
);

CREATE TABLE kurobara_core.gtm_active_contexts (
  workspace_id text PRIMARY KEY REFERENCES kurobara_core.workspaces (workspace_id),
  context_id text NOT NULL,
  revision integer NOT NULL,
  fingerprint text NOT NULL,
  activated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (workspace_id, context_id, revision)
    REFERENCES kurobara_core.gtm_context_revisions (
      workspace_id,
      context_id,
      revision
    )
);

CREATE TABLE kurobara_core.gtm_play_revisions (
  workspace_id text NOT NULL REFERENCES kurobara_core.workspaces (workspace_id),
  play_id text NOT NULL,
  revision integer NOT NULL,
  fingerprint text NOT NULL,
  lifecycle text NOT NULL,
  definition jsonb NOT NULL,
  compilation jsonb NOT NULL,
  created_by_actor_id text NOT NULL,
  created_at_ms bigint NOT NULL,
  PRIMARY KEY (workspace_id, play_id, revision),
  UNIQUE (workspace_id, play_id, fingerprint, lifecycle),
  CHECK (play_id <> '' AND length(play_id) <= 255),
  CHECK (revision > 0),
  CHECK (fingerprint ~ '^sha256:[0-9a-f]{64}$'),
  CHECK (
    lifecycle IN (
      'draft',
      'validated',
      'previewed',
      'awaiting_approval',
      'approved',
      'active',
      'paused',
      'retired'
    )
  ),
  CHECK (created_by_actor_id <> ''),
  CHECK (created_at_ms >= 0)
);

CREATE TABLE kurobara_core.gtm_play_runs (
  workspace_id text NOT NULL REFERENCES kurobara_core.workspaces (workspace_id),
  run_id text NOT NULL,
  play_id text NOT NULL,
  play_revision integer NOT NULL,
  idempotency_key text NOT NULL,
  intention_hash text NOT NULL,
  state text NOT NULL,
  compilation jsonb NOT NULL,
  definition jsonb NOT NULL,
  created_at_ms bigint NOT NULL,
  PRIMARY KEY (workspace_id, run_id),
  UNIQUE (workspace_id, idempotency_key),
  FOREIGN KEY (workspace_id, play_id, play_revision)
    REFERENCES kurobara_core.gtm_play_revisions (
      workspace_id,
      play_id,
      revision
    ),
  CHECK (run_id <> '' AND length(run_id) <= 255),
  CHECK (idempotency_key <> '' AND length(idempotency_key) <= 255),
  CHECK (intention_hash ~ '^sha256:[0-9a-f]{64}$'),
  CHECK (
    state IN (
      'queued',
      'running',
      'paused',
      'completed',
      'failed',
      'cancelled'
    )
  ),
  CHECK (created_at_ms >= 0)
);

CREATE INDEX gtm_play_runs_play_idx
  ON kurobara_core.gtm_play_runs (
    workspace_id,
    play_id,
    play_revision,
    created_at_ms
  );

CREATE TABLE kurobara_core.gtm_workbook_revisions (
  workspace_id text NOT NULL REFERENCES kurobara_core.workspaces (workspace_id),
  workbook_id text NOT NULL,
  revision integer NOT NULL,
  dataset_id text NOT NULL,
  materialization_id text NOT NULL,
  view jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workspace_id, workbook_id, revision),
  CHECK (workbook_id <> '' AND length(workbook_id) <= 255),
  CHECK (revision > 0),
  CHECK (dataset_id <> '' AND length(dataset_id) <= 255),
  CHECK (materialization_id <> '' AND length(materialization_id) <= 255)
);

CREATE INDEX gtm_workbook_latest_idx
  ON kurobara_core.gtm_workbook_revisions (
    workspace_id,
    workbook_id,
    revision DESC
  );
