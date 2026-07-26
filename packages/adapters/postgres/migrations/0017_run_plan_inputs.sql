-- Deployment barrier: drain every API and worker older than 0017 before
-- enabling a public ingress that requires durable normalized run input. Older
-- processes neither persist this sidecar nor supply it to a leaf effect.

ALTER TABLE kurobara_core.run_plans
  ADD COLUMN normalized_input_hash text GENERATED ALWAYS AS (
    plan ->> 'normalizedInputHash'
  ) STORED,
  ADD CONSTRAINT run_plans_normalized_input_hash_valid CHECK (
    normalized_input_hash IS NULL
    OR normalized_input_hash ~ '^sha256:[0-9a-f]{64}$'
  ),
  ADD CONSTRAINT run_plans_input_identity_key UNIQUE (
    workspace_id,
    run_plan_id,
    normalized_input_hash
  );

CREATE TABLE kurobara_core.run_plan_inputs (
  workspace_id text NOT NULL,
  run_plan_id text NOT NULL,
  input_id text NOT NULL,
  content_hash text NOT NULL,
  contract jsonb NOT NULL,
  normalized_payload jsonb NOT NULL,
  classification text NOT NULL,
  media_type text NOT NULL,
  size_bytes bigint NOT NULL,
  validator_version text NOT NULL,
  validated_at timestamptz NOT NULL,
  finalized_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workspace_id, input_id),
  UNIQUE (workspace_id, run_plan_id),
  UNIQUE (workspace_id, run_plan_id, input_id, content_hash),
  FOREIGN KEY (
    workspace_id,
    run_plan_id,
    content_hash
  ) REFERENCES kurobara_core.run_plans (
    workspace_id,
    run_plan_id,
    normalized_input_hash
  ) DEFERRABLE INITIALLY DEFERRED,
  CHECK (length(input_id) BETWEEN 1 AND 512),
  CHECK (content_hash ~ '^sha256:[0-9a-f]{64}$'),
  CHECK (jsonb_typeof(contract) = 'object'),
  CHECK (contract ?& ARRAY[
    'catalogVersion',
    'catalogFingerprint',
    'schemaId',
    'schemaVersion',
    'schemaFingerprint'
  ]),
  CHECK (
    contract - ARRAY[
      'catalogVersion',
      'catalogFingerprint',
      'schemaId',
      'schemaVersion',
      'schemaFingerprint'
    ]::text[] = '{}'::jsonb
  ),
  CHECK (octet_length(contract::text) <= 16384),
  CHECK (classification = 'internal'),
  CHECK (media_type = 'application/json'),
  CHECK (size_bytes BETWEEN 0 AND 65536),
  -- jsonb::text adds separator whitespace and expands exponent-form numbers
  -- that are compact in Kurobara's canonical JSON. Keep a defensive 2 MiB
  -- storage bound while size_bytes carries the exact canonical 64 KiB limit
  -- and adapters recompute it on readback.
  CHECK (octet_length(normalized_payload::text) <= 2097152),
  CHECK (length(validator_version) BETWEEN 1 AND 256),
  CHECK (validated_at >= to_timestamp(0)),
  CHECK (finalized_at >= validated_at)
);

CREATE FUNCTION kurobara_core.reject_immutable_run_plan_input_change()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'Kurobara run plan inputs are immutable'
    USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER run_plan_inputs_are_immutable
  BEFORE UPDATE OR DELETE ON kurobara_core.run_plan_inputs
  FOR EACH ROW EXECUTE FUNCTION
    kurobara_core.reject_immutable_run_plan_input_change();
