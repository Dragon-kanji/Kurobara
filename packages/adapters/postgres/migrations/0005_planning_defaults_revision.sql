ALTER TABLE kurobara_core.planning_defaults
  ADD COLUMN revision bigint NOT NULL DEFAULT 1,
  ADD COLUMN updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  ADD CONSTRAINT planning_defaults_revision_is_positive CHECK (revision > 0);
