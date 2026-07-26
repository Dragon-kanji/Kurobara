CREATE TABLE kurobara_core.workspaces (
  workspace_id text PRIMARY KEY,
  status text NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (status IN ('active', 'disabled'))
);

INSERT INTO kurobara_core.workspaces (workspace_id)
SELECT DISTINCT workspace_id FROM kurobara_core.run_plans
ON CONFLICT (workspace_id) DO NOTHING;

ALTER TABLE kurobara_core.run_plans
  ADD CONSTRAINT run_plans_workspace_fk
  FOREIGN KEY (workspace_id)
  REFERENCES kurobara_core.workspaces (workspace_id);

CREATE TABLE kurobara_core.api_keys (
  api_key_id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES kurobara_core.workspaces (workspace_id),
  actor_id text NOT NULL,
  credential_digest text NOT NULL UNIQUE,
  label text NOT NULL,
  permissions text[] NOT NULL,
  expires_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (api_key_id ~ '^[A-Za-z0-9_-]{12,64}$'),
  CHECK (actor_id <> ''),
  CHECK (label <> '' AND length(label) <= 100),
  CHECK (credential_digest ~ '^[0-9a-f]{64}$'),
  CHECK (cardinality(permissions) > 0),
  CHECK (array_position(permissions, '') IS NULL)
);

CREATE INDEX api_keys_workspace_idx
  ON kurobara_core.api_keys (workspace_id, created_at);
