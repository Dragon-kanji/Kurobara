-- The dataset generation scheduler uses a short durable lease so multiple
-- workers cannot checkpoint or advance the same generation concurrently.
-- Expiry keeps the work recoverable after an unclean worker shutdown.

CREATE TABLE kurobara_core.dataset_generation_work_leases (
  workspace_id text NOT NULL,
  generation_id text NOT NULL,
  lease_token text NOT NULL,
  claimed_by text NOT NULL,
  claimed_until timestamptz NOT NULL,
  claimed_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workspace_id, generation_id),
  UNIQUE (lease_token),
  FOREIGN KEY (workspace_id, generation_id)
    REFERENCES kurobara_core.dataset_generations (
      workspace_id,
      generation_id
    ),
  CHECK (char_length(lease_token) BETWEEN 1 AND 255),
  CHECK (btrim(lease_token) = lease_token),
  CHECK (char_length(claimed_by) BETWEEN 1 AND 128),
  CHECK (btrim(claimed_by) = claimed_by),
  CHECK (claimed_until > claimed_at)
);

CREATE INDEX dataset_generation_work_leases_expiry_idx
  ON kurobara_core.dataset_generation_work_leases (claimed_until);

CREATE INDEX dataset_generation_terminal_page_work_idx
  ON kurobara_core.dataset_generation_pages (
    workspace_id,
    generation_id,
    page_sequence
  )
  WHERE state IN ('executing', 'committed');
