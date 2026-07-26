-- KRB-PRIVACY-002 introduces only the durable pre-effect revocation guard.
-- It stores versioned keyed digests and audit-safe proofs, never raw contact
-- values. Existing immutable records and delivered exports are not rewritten by
-- this migration; their revocation lifecycle remains KRB-PRIVACY-003.

CREATE TABLE kurobara_core.contact_privacy_tombstones (
  workspace_id text NOT NULL,
  tombstone_id text NOT NULL,
  subject_key_algorithm text NOT NULL,
  subject_key_format_version text NOT NULL,
  subject_key_secret_version text NOT NULL,
  subject_identity_kind text NOT NULL,
  subject_provider_key text NOT NULL,
  subject_key_digest text NOT NULL,
  reason_code text NOT NULL,
  intent_hash text NOT NULL,
  registered_at timestamptz NOT NULL,
  PRIMARY KEY (workspace_id, tombstone_id),
  UNIQUE (workspace_id, intent_hash),
  UNIQUE (workspace_id, tombstone_id, intent_hash),
  UNIQUE (
    workspace_id,
    subject_key_algorithm,
    subject_key_format_version,
    subject_key_secret_version,
    subject_identity_kind,
    subject_provider_key,
    subject_key_digest,
    reason_code
  ),
  FOREIGN KEY (workspace_id)
    REFERENCES kurobara_core.workspaces (workspace_id),
  CHECK (tombstone_id ~ '^privacy-ts-[0-9a-f]{64}$'),
  CHECK (subject_key_algorithm = 'hmac-sha-256'),
  CHECK (subject_key_format_version = '1.0.0'),
  CHECK (
    subject_key_secret_version ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'
  ),
  CHECK (subject_identity_kind IN ('email', 'provider-subject')),
  CHECK (
    (subject_identity_kind = 'email' AND subject_provider_key = '')
    OR (
      subject_identity_kind = 'provider-subject'
      AND subject_provider_key ~ '^[a-z0-9][a-z0-9._-]{0,127}$'
    )
  ),
  CHECK (subject_key_digest ~ '^[0-9a-f]{64}$'),
  CHECK (reason_code IN (
    'provider-opt-out',
    'provider-deletion',
    'provider-claimed-email',
    'operator-subject-request'
  )),
  CHECK (intent_hash ~ '^sha256:[0-9a-f]{64}$'),
  CHECK (
    tombstone_id = 'privacy-ts-' || substring(intent_hash FROM 8)
  )
);

CREATE INDEX contact_privacy_tombstones_subject_lookup
  ON kurobara_core.contact_privacy_tombstones (
    workspace_id,
    subject_identity_kind,
    subject_provider_key,
    subject_key_digest
  );

CREATE TABLE kurobara_core.contact_privacy_registration_requests (
  workspace_id text NOT NULL,
  idempotency_key text NOT NULL,
  tombstone_id text NOT NULL,
  intent_hash text NOT NULL,
  requested_at timestamptz NOT NULL,
  PRIMARY KEY (workspace_id, idempotency_key),
  FOREIGN KEY (workspace_id, tombstone_id, intent_hash)
    REFERENCES kurobara_core.contact_privacy_tombstones (
      workspace_id,
      tombstone_id,
      intent_hash
    ),
  CHECK (char_length(idempotency_key) BETWEEN 1 AND 255),
  CHECK (btrim(idempotency_key) <> ''),
  CHECK (intent_hash ~ '^sha256:[0-9a-f]{64}$')
);

CREATE FUNCTION kurobara_core.guard_contact_privacy_append_only()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'Kurobara contact privacy records are append-only'
    USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER contact_privacy_tombstones_are_append_only
  BEFORE UPDATE OR DELETE ON kurobara_core.contact_privacy_tombstones
  FOR EACH ROW EXECUTE FUNCTION
    kurobara_core.guard_contact_privacy_append_only();

CREATE TRIGGER contact_privacy_registration_requests_are_append_only
  BEFORE UPDATE OR DELETE ON kurobara_core.contact_privacy_registration_requests
  FOR EACH ROW EXECUTE FUNCTION
    kurobara_core.guard_contact_privacy_append_only();
