-- KRB-PUB-001 extends the internal export registry without rewriting the
-- immutable v1 manifests introduced by 0026. Generated Contact datasets use a
-- discriminated v2 source, an effective expiry and restricted versioned HMAC
-- subject links. Tombstone registration can then revoke every matching
-- delivery and retain an audit-safe proof without storing contact values.

ALTER TABLE kurobara_core.export_deliveries
  ADD COLUMN manifest_version text NOT NULL DEFAULT '1.0.0',
  ADD COLUMN source_kind text NOT NULL DEFAULT 'recipe-application',
  ADD COLUMN generation_id text,
  ADD COLUMN generation_plan_id text,
  ADD COLUMN plan_hash text,
  ADD COLUMN capability_id text,
  ADD COLUMN capability_version text,
  ADD COLUMN effective_expires_at timestamptz;

-- Existing rows are valid v1 manifests. Backfill the relational expiry while
-- the append-only trigger is temporarily absent, then restore that guard.
DROP TRIGGER export_deliveries_are_append_only
  ON kurobara_core.export_deliveries;

UPDATE kurobara_core.export_deliveries AS delivery
SET effective_expires_at = to_timestamp((
  LEAST(
    (delivery.manifest -> 'policyPurpose' ->> 'policyExpiresAt')::numeric,
    (delivery.manifest -> 'providerRights' ->> 'expiresAt')::numeric,
    (
      SELECT min((observation ->> 'expiresAt')::numeric)
      FROM jsonb_array_elements(
        delivery.manifest -> 'observedExpiries'
      ) AS observation
    )
  ) / 1000
)::double precision);

ALTER TABLE kurobara_core.export_deliveries
  ALTER COLUMN effective_expires_at SET NOT NULL,
  ALTER COLUMN application_id DROP NOT NULL,
  ALTER COLUMN recipe_id DROP NOT NULL,
  ALTER COLUMN recipe_revision DROP NOT NULL,
  ADD CONSTRAINT export_deliveries_manifest_version_check
    CHECK (manifest_version IN ('1.0.0', '2.0.0')),
  ADD CONSTRAINT export_deliveries_source_kind_check
    CHECK (source_kind IN ('recipe-application', 'generated-dataset')),
  ADD CONSTRAINT export_deliveries_source_identity_check CHECK (
    (
      manifest_version = '1.0.0'
      AND source_kind = 'recipe-application'
      AND application_id IS NOT NULL
      AND recipe_id IS NOT NULL
      AND recipe_revision IS NOT NULL
      AND generation_id IS NULL
      AND generation_plan_id IS NULL
      AND plan_hash IS NULL
      AND capability_id IS NULL
      AND capability_version IS NULL
    )
    OR (
      manifest_version = '2.0.0'
      AND source_kind = 'generated-dataset'
      AND application_id IS NULL
      AND recipe_id IS NULL
      AND recipe_revision IS NULL
      AND generation_id IS NOT NULL
      AND generation_plan_id IS NOT NULL
      AND plan_hash ~ '^sha256:[0-9a-f]{64}$'
      AND capability_id IS NOT NULL
      AND capability_version IS NOT NULL
      AND btrim(generation_id) = generation_id
      AND btrim(generation_plan_id) = generation_plan_id
      AND btrim(capability_id) = capability_id
      AND btrim(capability_version) = capability_version
      AND char_length(generation_id) BETWEEN 1 AND 255
      AND char_length(generation_plan_id) BETWEEN 1 AND 255
      AND char_length(capability_id) BETWEEN 1 AND 255
      AND char_length(capability_version) BETWEEN 1 AND 255
    )
  ),
  ADD CONSTRAINT export_deliveries_effective_expiry_check
    CHECK (effective_expires_at > prepared_at);

CREATE INDEX export_deliveries_effective_expiry_idx
  ON kurobara_core.export_deliveries (
    effective_expires_at,
    workspace_id,
    delivery_id
  );

CREATE OR REPLACE FUNCTION kurobara_core.guard_export_delivery_manifest_insert()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  canonical_data_classes text[];
  data_classes text[];
  data_class_count integer;
  distinct_data_class_count integer;
  effective_expiry_ms numeric;
  field_count integer;
  distinct_field_count integer;
  manifest_keys text[];
  observed_count integer;
  observed_distinct_count integer;
  policy_keys text[];
  prepared_at_ms numeric;
  provider_rights_keys text[];
  source_keys text[];
BEGIN
  IF jsonb_typeof(NEW.manifest) <> 'object'
    OR jsonb_typeof(NEW.manifest -> 'policyPurpose') <> 'object'
    OR jsonb_typeof(NEW.manifest -> 'providerRights') <> 'object'
    OR jsonb_typeof(NEW.manifest -> 'dataClasses') <> 'array'
    OR jsonb_typeof(NEW.manifest -> 'fieldIds') <> 'array'
    OR jsonb_typeof(NEW.manifest -> 'observedExpiries') <> 'array'
  THEN
    RAISE EXCEPTION 'A Kurobara export manifest must contain bounded identity arrays'
      USING ERRCODE = '55000';
  END IF;

  SELECT array_agg(key ORDER BY key) INTO manifest_keys
  FROM jsonb_object_keys(NEW.manifest) AS key;
  SELECT array_agg(key ORDER BY key) INTO policy_keys
  FROM jsonb_object_keys(NEW.manifest -> 'policyPurpose') AS key;
  SELECT array_agg(key ORDER BY key) INTO provider_rights_keys
  FROM jsonb_object_keys(NEW.manifest -> 'providerRights') AS key;

  IF NEW.manifest_version = '1.0.0' THEN
    IF manifest_keys IS DISTINCT FROM ARRAY[
        'applicationId',
        'contentHash',
        'contentLength',
        'dataClasses',
        'datasetId',
        'fieldIds',
        'format',
        'observedExpiries',
        'ownerActorId',
        'policyPurpose',
        'providerRights',
        'recipeId',
        'recipeRevision',
        'workspaceId'
      ]::text[]
    THEN
      RAISE EXCEPTION 'A Kurobara export manifest must have its exact audit-safe field set'
        USING ERRCODE = '55000';
    END IF;
  ELSIF NEW.manifest_version = '2.0.0' THEN
    IF jsonb_typeof(NEW.manifest -> 'source') <> 'object' THEN
      RAISE EXCEPTION 'A Kurobara generated-dataset export requires an exact source'
        USING ERRCODE = '55000';
    END IF;
    SELECT array_agg(key ORDER BY key) INTO source_keys
    FROM jsonb_object_keys(NEW.manifest -> 'source') AS key;
    IF manifest_keys IS DISTINCT FROM ARRAY[
        'applicationId',
        'contentHash',
        'contentLength',
        'dataClasses',
        'datasetId',
        'fieldIds',
        'format',
        'manifestVersion',
        'observedExpiries',
        'ownerActorId',
        'policyPurpose',
        'providerRights',
        'recipeId',
        'recipeRevision',
        'source',
        'workspaceId'
      ]::text[]
      OR source_keys IS DISTINCT FROM ARRAY[
        'capabilityId',
        'capabilityVersion',
        'generationId',
        'generationPlanId',
        'kind',
        'planHash'
      ]::text[]
      OR NEW.manifest ->> 'manifestVersion' <> '2.0.0'
      OR NEW.manifest -> 'applicationId' <> 'null'::jsonb
      OR NEW.manifest -> 'recipeId' <> 'null'::jsonb
      OR NEW.manifest -> 'recipeRevision' <> 'null'::jsonb
      OR NEW.manifest #>> '{source,kind}' <> 'generated-dataset'
      OR NEW.manifest #>> '{source,generationId}'
        IS DISTINCT FROM NEW.generation_id
      OR NEW.manifest #>> '{source,generationPlanId}'
        IS DISTINCT FROM NEW.generation_plan_id
      OR NEW.manifest #>> '{source,planHash}'
        IS DISTINCT FROM NEW.plan_hash
      OR NEW.manifest #>> '{source,capabilityId}'
        IS DISTINCT FROM NEW.capability_id
      OR NEW.manifest #>> '{source,capabilityVersion}'
        IS DISTINCT FROM NEW.capability_version
    THEN
      RAISE EXCEPTION 'A Kurobara generated-dataset export source is invalid'
        USING ERRCODE = '55000';
    END IF;
  ELSE
    RAISE EXCEPTION 'A Kurobara export manifest version is invalid'
      USING ERRCODE = '55000';
  END IF;

  IF policy_keys IS DISTINCT FROM ARRAY[
      'policyExpiresAt',
      'policyVersion',
      'purposeRef',
      'territory'
    ]::text[]
    OR provider_rights_keys IS DISTINCT FROM ARRAY[
      'expiresAt',
      'mode',
      'version'
    ]::text[]
  THEN
    RAISE EXCEPTION 'A Kurobara export manifest must have its exact audit-safe field set'
      USING ERRCODE = '55000';
  END IF;

  IF jsonb_typeof(NEW.manifest -> 'contentLength') <> 'number'
    OR (NEW.manifest ->> 'contentLength') !~ '^(0|[1-9][0-9]*)$'
    OR (NEW.manifest ->> 'contentLength')::numeric > 9007199254740991
    OR EXISTS (
      SELECT 1
      FROM jsonb_array_elements(NEW.manifest -> 'fieldIds') AS field_id
      WHERE jsonb_typeof(field_id) <> 'string'
        OR btrim(field_id #>> '{}') = ''
    )
    OR EXISTS (
      SELECT 1
      FROM jsonb_array_elements(NEW.manifest -> 'observedExpiries')
        AS observation
      WHERE jsonb_typeof(observation) <> 'object'
        OR (
          SELECT array_agg(key ORDER BY key)
          FROM jsonb_object_keys(observation) AS key
        ) IS DISTINCT FROM ARRAY['dataClass', 'expiresAt', 'observedAt']::text[]
        OR jsonb_typeof(observation -> 'dataClass') <> 'string'
        OR jsonb_typeof(observation -> 'expiresAt') <> 'number'
        OR jsonb_typeof(observation -> 'observedAt') <> 'number'
        OR (observation ->> 'expiresAt') !~ '^(0|[1-9][0-9]*)$'
        OR (observation ->> 'observedAt') !~ '^(0|[1-9][0-9]*)$'
    )
  THEN
    RAISE EXCEPTION 'A Kurobara export manifest contains an invalid scalar or observation'
      USING ERRCODE = '55000';
  END IF;

  SELECT count(*), count(DISTINCT value)
    INTO data_class_count, distinct_data_class_count
  FROM jsonb_array_elements_text(NEW.manifest -> 'dataClasses');
  SELECT array_agg(value ORDER BY position)
    INTO data_classes
  FROM jsonb_array_elements_text(NEW.manifest -> 'dataClasses')
    WITH ORDINALITY AS data_class(value, position);
  SELECT array_agg(candidate)
    INTO canonical_data_classes
  FROM unnest(ARRAY[
    'contact-identity',
    'employment',
    'professional-social-profile',
    'professional-email',
    'personal-email',
    'phone'
  ]::text[]) AS candidate
  WHERE candidate = ANY(data_classes);
  SELECT count(*), count(DISTINCT value)
    INTO field_count, distinct_field_count
  FROM jsonb_array_elements_text(NEW.manifest -> 'fieldIds');
  SELECT count(*), count(DISTINCT observation ->> 'dataClass')
    INTO observed_count, observed_distinct_count
  FROM jsonb_array_elements(NEW.manifest -> 'observedExpiries') AS observation;

  IF data_class_count = 0
    OR data_class_count <> distinct_data_class_count
    OR data_classes IS DISTINCT FROM canonical_data_classes
    OR field_count = 0
    OR field_count <> distinct_field_count
    OR observed_count <> data_class_count
    OR observed_count <> observed_distinct_count
    OR EXISTS (
      SELECT 1
      FROM jsonb_array_elements(NEW.manifest -> 'dataClasses')
        WITH ORDINALITY AS data_class(value, position)
      FULL JOIN jsonb_array_elements(NEW.manifest -> 'observedExpiries')
        WITH ORDINALITY AS observation(value, position)
        USING (position)
      WHERE data_class.value #>> '{}' IS DISTINCT FROM
        observation.value ->> 'dataClass'
    )
  THEN
    RAISE EXCEPTION 'A Kurobara export manifest must contain unique aligned identities'
      USING ERRCODE = '55000';
  END IF;

  prepared_at_ms := extract(epoch FROM NEW.prepared_at) * 1000;
  effective_expiry_ms := LEAST(
    (NEW.manifest -> 'policyPurpose' ->> 'policyExpiresAt')::numeric,
    (NEW.manifest -> 'providerRights' ->> 'expiresAt')::numeric,
    (
      SELECT min((observation ->> 'expiresAt')::numeric)
      FROM jsonb_array_elements(
        NEW.manifest -> 'observedExpiries'
      ) AS observation
    )
  );
  IF prepared_at_ms >= effective_expiry_ms
    OR EXISTS (
      SELECT 1
      FROM jsonb_array_elements(NEW.manifest -> 'observedExpiries')
        AS observation
      WHERE (observation ->> 'observedAt')::numeric > prepared_at_ms
        OR prepared_at_ms >= (observation ->> 'expiresAt')::numeric
    )
  THEN
    RAISE EXCEPTION 'A Kurobara export manifest is outside its authorization window'
      USING ERRCODE = '55000';
  END IF;

  NEW.effective_expires_at := to_timestamp((
    effective_expiry_ms / 1000
  )::double precision);
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION kurobara_core.guard_export_delivery_event_insert()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  delivery_record kurobara_core.export_deliveries%ROWTYPE;
  delivered_at timestamptz;
BEGIN
  SELECT * INTO delivery_record
  FROM kurobara_core.export_deliveries AS delivery
  WHERE delivery.workspace_id = NEW.workspace_id
    AND delivery.delivery_id = NEW.delivery_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'The Kurobara export delivery does not exist'
      USING ERRCODE = '55000';
  END IF;

  IF NEW.recorded_at < delivery_record.prepared_at THEN
    RAISE EXCEPTION 'A Kurobara export event cannot predate preparation'
      USING ERRCODE = '55000';
  END IF;

  IF NEW.event_type = 'delivered' THEN
    IF EXISTS (
      SELECT 1
      FROM kurobara_core.export_delivery_events AS event
      WHERE event.workspace_id = NEW.workspace_id
        AND event.delivery_id = NEW.delivery_id
        AND event.event_type = 'revoked'
    ) THEN
      RAISE EXCEPTION 'A revoked Kurobara export cannot be delivered'
        USING ERRCODE = '55000';
    END IF;

    IF NEW.content_hash IS DISTINCT FROM delivery_record.content_hash
      OR NEW.content_length IS DISTINCT FROM delivery_record.content_length
    THEN
      RAISE EXCEPTION 'A Kurobara export delivery proof must match its manifest'
        USING ERRCODE = '55000';
    END IF;

    IF NEW.recorded_at >= delivery_record.effective_expires_at THEN
      RAISE EXCEPTION 'A Kurobara export cannot be delivered after authorization expiry'
        USING ERRCODE = '55000';
    END IF;
  ELSE
    SELECT event.recorded_at INTO delivered_at
    FROM kurobara_core.export_delivery_events AS event
    WHERE event.workspace_id = NEW.workspace_id
      AND event.delivery_id = NEW.delivery_id
      AND event.event_type = 'delivered';
    IF delivered_at IS NOT NULL AND NEW.recorded_at < delivered_at THEN
      RAISE EXCEPTION 'A Kurobara export revocation cannot predate delivery'
        USING ERRCODE = '55000';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER export_deliveries_are_append_only
  BEFORE UPDATE OR DELETE ON kurobara_core.export_deliveries
  FOR EACH ROW EXECUTE FUNCTION
    kurobara_core.guard_export_delivery_append_only();

CREATE TABLE kurobara_core.export_delivery_subject_keys (
  workspace_id text NOT NULL,
  delivery_id text NOT NULL,
  subject_key_algorithm text NOT NULL,
  subject_key_format_version text NOT NULL,
  subject_key_secret_version text NOT NULL,
  subject_identity_kind text NOT NULL,
  subject_provider_key text NOT NULL,
  subject_key_digest text NOT NULL,
  linked_at timestamptz NOT NULL,
  PRIMARY KEY (
    workspace_id,
    delivery_id,
    subject_key_algorithm,
    subject_key_format_version,
    subject_key_secret_version,
    subject_identity_kind,
    subject_provider_key,
    subject_key_digest
  ),
  FOREIGN KEY (workspace_id, delivery_id)
    REFERENCES kurobara_core.export_deliveries (workspace_id, delivery_id),
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
  CHECK (subject_key_digest ~ '^[0-9a-f]{64}$')
);

CREATE INDEX export_delivery_subject_keys_lookup
  ON kurobara_core.export_delivery_subject_keys (
    workspace_id,
    subject_identity_kind,
    subject_provider_key,
    subject_key_digest,
    delivery_id
  );

CREATE TRIGGER export_delivery_subject_keys_are_append_only
  BEFORE UPDATE OR DELETE ON kurobara_core.export_delivery_subject_keys
  FOR EACH ROW EXECUTE FUNCTION
    kurobara_core.guard_export_delivery_append_only();

CREATE FUNCTION kurobara_core.guard_generated_export_subject_keys()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.manifest_version = '2.0.0' AND NOT EXISTS (
    SELECT 1
    FROM kurobara_core.export_delivery_subject_keys AS subject_key
    WHERE subject_key.workspace_id = NEW.workspace_id
      AND subject_key.delivery_id = NEW.delivery_id
  ) THEN
    RAISE EXCEPTION 'A Kurobara generated-dataset export requires restricted subject keys'
      USING ERRCODE = '55000';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER generated_export_subject_keys_are_required
  AFTER INSERT ON kurobara_core.export_deliveries
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION
    kurobara_core.guard_generated_export_subject_keys();

CREATE TABLE kurobara_core.contact_privacy_tombstone_subject_keys (
  workspace_id text NOT NULL,
  tombstone_id text NOT NULL,
  subject_key_algorithm text NOT NULL,
  subject_key_format_version text NOT NULL,
  subject_key_secret_version text NOT NULL,
  subject_identity_kind text NOT NULL,
  subject_provider_key text NOT NULL,
  subject_key_digest text NOT NULL,
  linked_at timestamptz NOT NULL,
  PRIMARY KEY (
    workspace_id,
    tombstone_id,
    subject_key_algorithm,
    subject_key_format_version,
    subject_key_secret_version,
    subject_identity_kind,
    subject_provider_key,
    subject_key_digest
  ),
  FOREIGN KEY (workspace_id, tombstone_id)
    REFERENCES kurobara_core.contact_privacy_tombstones (
      workspace_id,
      tombstone_id
    ),
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
  CHECK (subject_key_digest ~ '^[0-9a-f]{64}$')
);

INSERT INTO kurobara_core.contact_privacy_tombstone_subject_keys (
  workspace_id,
  tombstone_id,
  subject_key_algorithm,
  subject_key_format_version,
  subject_key_secret_version,
  subject_identity_kind,
  subject_provider_key,
  subject_key_digest,
  linked_at
)
SELECT
  workspace_id,
  tombstone_id,
  subject_key_algorithm,
  subject_key_format_version,
  subject_key_secret_version,
  subject_identity_kind,
  subject_provider_key,
  subject_key_digest,
  registered_at
FROM kurobara_core.contact_privacy_tombstones;

CREATE INDEX contact_privacy_tombstone_subject_keys_lookup
  ON kurobara_core.contact_privacy_tombstone_subject_keys (
    workspace_id,
    subject_identity_kind,
    subject_provider_key,
    subject_key_digest,
    tombstone_id
  );

CREATE TRIGGER contact_privacy_tombstone_subject_keys_are_append_only
  BEFORE UPDATE OR DELETE
  ON kurobara_core.contact_privacy_tombstone_subject_keys
  FOR EACH ROW EXECUTE FUNCTION
    kurobara_core.guard_contact_privacy_append_only();

CREATE TABLE kurobara_core.export_delivery_revocation_proofs (
  workspace_id text NOT NULL,
  tombstone_id text NOT NULL,
  delivery_id text NOT NULL,
  revocation_id text NOT NULL,
  reason_code text NOT NULL,
  manifest jsonb NOT NULL,
  recorded_at timestamptz NOT NULL,
  PRIMARY KEY (workspace_id, tombstone_id, delivery_id),
  UNIQUE (workspace_id, revocation_id),
  FOREIGN KEY (workspace_id, tombstone_id)
    REFERENCES kurobara_core.contact_privacy_tombstones (
      workspace_id,
      tombstone_id
    ),
  FOREIGN KEY (workspace_id, delivery_id)
    REFERENCES kurobara_core.export_deliveries (workspace_id, delivery_id),
  CHECK (revocation_id ~ '^export-revocation-[0-9a-f]{64}$'),
  CHECK (reason_code IN (
    'provider-opt-out',
    'provider-deletion',
    'provider-claimed-email',
    'operator-subject-request'
  )),
  CHECK (jsonb_typeof(manifest) = 'object'),
  CHECK (manifest ?& ARRAY[
    'deliveryId',
    'reasonCode',
    'revocationId',
    'revokedAt',
    'tombstoneId',
    'workspaceId'
  ]),
  CHECK (manifest ->> 'workspaceId' = workspace_id),
  CHECK (manifest ->> 'tombstoneId' = tombstone_id),
  CHECK (manifest ->> 'deliveryId' = delivery_id),
  CHECK (manifest ->> 'revocationId' = revocation_id),
  CHECK (manifest ->> 'reasonCode' = reason_code),
  CHECK (jsonb_typeof(manifest -> 'revokedAt') = 'number'),
  CHECK ((manifest ->> 'revokedAt') ~ '^(0|[1-9][0-9]*)$'),
  CHECK (
    (manifest ->> 'revokedAt')::numeric =
      trunc(extract(epoch FROM recorded_at) * 1000)
  )
);

CREATE INDEX export_delivery_revocation_proofs_delivery_lookup
  ON kurobara_core.export_delivery_revocation_proofs (
    workspace_id,
    delivery_id,
    recorded_at,
    revocation_id
  );

CREATE FUNCTION kurobara_core.guard_export_delivery_revocation_proof_insert()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  manifest_keys text[];
BEGIN
  SELECT array_agg(key ORDER BY key) INTO manifest_keys
  FROM jsonb_object_keys(NEW.manifest) AS key;
  IF manifest_keys IS DISTINCT FROM ARRAY[
      'deliveryId',
      'reasonCode',
      'revocationId',
      'revokedAt',
      'tombstoneId',
      'workspaceId'
    ]::text[]
  THEN
    RAISE EXCEPTION 'A Kurobara export revocation proof must have its exact audit-safe field set'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER export_delivery_revocation_proof_is_valid
  BEFORE INSERT ON kurobara_core.export_delivery_revocation_proofs
  FOR EACH ROW EXECUTE FUNCTION
    kurobara_core.guard_export_delivery_revocation_proof_insert();

CREATE TRIGGER export_delivery_revocation_proofs_are_append_only
  BEFORE UPDATE OR DELETE
  ON kurobara_core.export_delivery_revocation_proofs
  FOR EACH ROW EXECUTE FUNCTION
    kurobara_core.guard_export_delivery_append_only();
