CREATE TABLE kurobara_core.workflow_snapshots (
  workspace_id text NOT NULL REFERENCES kurobara_core.workspaces (workspace_id),
  workflow_spec_id text NOT NULL,
  workflow_revision text NOT NULL,
  workflow_content_hash text NOT NULL,
  snapshot jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (
    workspace_id,
    workflow_spec_id,
    workflow_revision,
    workflow_content_hash
  ),
  UNIQUE (workspace_id, workflow_spec_id, workflow_revision)
);

CREATE TABLE kurobara_core.authority_snapshots (
  workspace_id text NOT NULL REFERENCES kurobara_core.workspaces (workspace_id),
  authority_envelope_id text NOT NULL,
  snapshot jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workspace_id, authority_envelope_id)
);

CREATE TABLE kurobara_core.policy_snapshots (
  workspace_id text NOT NULL REFERENCES kurobara_core.workspaces (workspace_id),
  snapshot_id text NOT NULL,
  snapshot jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workspace_id, snapshot_id)
);

CREATE TABLE kurobara_core.pricing_snapshots (
  workspace_id text NOT NULL REFERENCES kurobara_core.workspaces (workspace_id),
  snapshot_id text NOT NULL,
  snapshot jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workspace_id, snapshot_id)
);

CREATE TABLE kurobara_core.planning_defaults (
  workspace_id text PRIMARY KEY REFERENCES kurobara_core.workspaces (workspace_id),
  policy_snapshot_id text NOT NULL,
  pricing_snapshot_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (workspace_id, policy_snapshot_id)
    REFERENCES kurobara_core.policy_snapshots (workspace_id, snapshot_id),
  FOREIGN KEY (workspace_id, pricing_snapshot_id)
    REFERENCES kurobara_core.pricing_snapshots (workspace_id, snapshot_id)
);

CREATE TABLE kurobara_core.run_plan_sources (
  workspace_id text NOT NULL,
  run_plan_id text NOT NULL,
  workflow_spec_id text NOT NULL,
  workflow_revision text NOT NULL,
  workflow_content_hash text NOT NULL,
  authority_envelope_id text NOT NULL,
  policy_snapshot_id text NOT NULL,
  pricing_snapshot_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workspace_id, run_plan_id),
  FOREIGN KEY (workspace_id, run_plan_id)
    REFERENCES kurobara_core.run_plans (workspace_id, run_plan_id),
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
  FOREIGN KEY (workspace_id, authority_envelope_id)
    REFERENCES kurobara_core.authority_snapshots (
      workspace_id,
      authority_envelope_id
    ),
  FOREIGN KEY (workspace_id, policy_snapshot_id)
    REFERENCES kurobara_core.policy_snapshots (workspace_id, snapshot_id),
  FOREIGN KEY (workspace_id, pricing_snapshot_id)
    REFERENCES kurobara_core.pricing_snapshots (workspace_id, snapshot_id)
);

CREATE FUNCTION kurobara_core.reject_immutable_planning_record_change()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'Kurobara planning snapshots and provenance are immutable'
    USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER workflow_snapshots_are_immutable
  BEFORE UPDATE OR DELETE ON kurobara_core.workflow_snapshots
  FOR EACH ROW EXECUTE FUNCTION kurobara_core.reject_immutable_planning_record_change();

CREATE TRIGGER authority_snapshots_are_immutable
  BEFORE UPDATE OR DELETE ON kurobara_core.authority_snapshots
  FOR EACH ROW EXECUTE FUNCTION kurobara_core.reject_immutable_planning_record_change();

CREATE TRIGGER policy_snapshots_are_immutable
  BEFORE UPDATE OR DELETE ON kurobara_core.policy_snapshots
  FOR EACH ROW EXECUTE FUNCTION kurobara_core.reject_immutable_planning_record_change();

CREATE TRIGGER pricing_snapshots_are_immutable
  BEFORE UPDATE OR DELETE ON kurobara_core.pricing_snapshots
  FOR EACH ROW EXECUTE FUNCTION kurobara_core.reject_immutable_planning_record_change();

CREATE TRIGGER run_plan_sources_are_immutable
  BEFORE UPDATE OR DELETE ON kurobara_core.run_plan_sources
  FOR EACH ROW EXECUTE FUNCTION kurobara_core.reject_immutable_planning_record_change();

CREATE FUNCTION kurobara_core.reject_run_plan_identity_change()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.workspace_id IS DISTINCT FROM NEW.workspace_id
    OR OLD.run_plan_id IS DISTINCT FROM NEW.run_plan_id
    OR OLD.plan IS DISTINCT FROM NEW.plan THEN
    RAISE EXCEPTION 'Kurobara run plan identity and payload are immutable'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER run_plan_payload_is_immutable
  BEFORE UPDATE ON kurobara_core.run_plans
  FOR EACH ROW EXECUTE FUNCTION kurobara_core.reject_run_plan_identity_change();
