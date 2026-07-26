-- KRB-PRIVACY-003 records only audit-safe export manifests and lifecycle
-- proofs. The manifest never contains raw rows, contact values or provider
-- subject identifiers. Revocation prevents a future delivery but cannot erase
-- copies that an owner already received.

CREATE TABLE kurobara_core.export_deliveries (
  workspace_id text NOT NULL,
  delivery_id text NOT NULL,
  owner_actor_id text NOT NULL,
  intent_hash text NOT NULL,
  application_id text NOT NULL,
  dataset_id text NOT NULL,
  recipe_id text NOT NULL,
  recipe_revision text NOT NULL,
  format text NOT NULL,
  content_hash text NOT NULL,
  content_length bigint NOT NULL,
  manifest jsonb NOT NULL,
  prepared_at timestamptz NOT NULL,
  PRIMARY KEY (workspace_id, delivery_id),
  UNIQUE (workspace_id, intent_hash),
  UNIQUE (workspace_id, delivery_id, intent_hash),
  FOREIGN KEY (workspace_id)
    REFERENCES kurobara_core.workspaces (workspace_id),
  CHECK (delivery_id ~ '^export-delivery-[0-9a-f]{64}$'),
  CHECK (intent_hash ~ '^sha256:[0-9a-f]{64}$'),
  CHECK (
    delivery_id = 'export-delivery-' || substring(intent_hash FROM 8)
  ),
  CHECK (char_length(owner_actor_id) BETWEEN 1 AND 255),
  CHECK (btrim(owner_actor_id) <> ''),
  CHECK (char_length(application_id) BETWEEN 1 AND 255),
  CHECK (btrim(application_id) <> ''),
  CHECK (char_length(dataset_id) BETWEEN 1 AND 255),
  CHECK (btrim(dataset_id) <> ''),
  CHECK (char_length(recipe_id) BETWEEN 1 AND 255),
  CHECK (btrim(recipe_id) <> ''),
  CHECK (char_length(recipe_revision) BETWEEN 1 AND 255),
  CHECK (btrim(recipe_revision) <> ''),
  CHECK (format IN ('csv', 'jsonl')),
  CHECK (content_hash ~ '^sha256:[0-9a-f]{64}$'),
  CHECK (content_length BETWEEN 0 AND 9007199254740991),
  CHECK (jsonb_typeof(manifest) = 'object'),
  CHECK (manifest ?& ARRAY[
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
  ]),
  CHECK (manifest ->> 'workspaceId' = workspace_id),
  CHECK (manifest ->> 'ownerActorId' = owner_actor_id),
  CHECK (manifest ->> 'applicationId' = application_id),
  CHECK (manifest ->> 'datasetId' = dataset_id),
  CHECK (manifest ->> 'recipeId' = recipe_id),
  CHECK (manifest ->> 'recipeRevision' = recipe_revision),
  CHECK (manifest ->> 'format' = format),
  CHECK (manifest ->> 'contentHash' = content_hash),
  CHECK ((manifest ->> 'contentLength')::bigint = content_length)
);

CREATE INDEX export_deliveries_owner_lookup
  ON kurobara_core.export_deliveries (
    workspace_id,
    owner_actor_id,
    prepared_at,
    delivery_id
  );

CREATE TABLE kurobara_core.export_delivery_requests (
  workspace_id text NOT NULL,
  idempotency_key text NOT NULL,
  delivery_id text NOT NULL,
  intent_hash text NOT NULL,
  requested_at timestamptz NOT NULL,
  PRIMARY KEY (workspace_id, idempotency_key),
  FOREIGN KEY (workspace_id, delivery_id, intent_hash)
    REFERENCES kurobara_core.export_deliveries (
      workspace_id,
      delivery_id,
      intent_hash
    ),
  CHECK (char_length(idempotency_key) BETWEEN 1 AND 255),
  CHECK (btrim(idempotency_key) <> ''),
  CHECK (intent_hash ~ '^sha256:[0-9a-f]{64}$')
);

CREATE TABLE kurobara_core.export_delivery_events (
  workspace_id text NOT NULL,
  delivery_id text NOT NULL,
  event_type text NOT NULL,
  recorded_at timestamptz NOT NULL,
  content_hash text,
  content_length bigint,
  PRIMARY KEY (workspace_id, delivery_id, event_type),
  FOREIGN KEY (workspace_id, delivery_id)
    REFERENCES kurobara_core.export_deliveries (workspace_id, delivery_id),
  CHECK (event_type IN ('delivered', 'revoked')),
  CHECK (
    (
      event_type = 'delivered'
      AND content_hash ~ '^sha256:[0-9a-f]{64}$'
      AND content_length >= 0
    )
    OR (
      event_type = 'revoked'
      AND content_hash IS NULL
      AND content_length IS NULL
    )
  )
);

CREATE FUNCTION kurobara_core.guard_export_delivery_append_only()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'Kurobara export delivery records are append-only'
    USING ERRCODE = '55000';
END;
$$;

CREATE FUNCTION kurobara_core.guard_export_delivery_event_insert()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  delivery_record kurobara_core.export_deliveries%ROWTYPE;
  delivered_at timestamptz;
  expiry_ms numeric;
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

    expiry_ms := LEAST(
      (delivery_record.manifest -> 'policyPurpose' ->> 'policyExpiresAt')::numeric,
      (delivery_record.manifest -> 'providerRights' ->> 'expiresAt')::numeric,
      (
        SELECT min((observation ->> 'expiresAt')::numeric)
        FROM jsonb_array_elements(
          delivery_record.manifest -> 'observedExpiries'
        ) AS observation
      )
    );
    IF extract(epoch FROM NEW.recorded_at) * 1000 >= expiry_ms THEN
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

CREATE FUNCTION kurobara_core.guard_export_delivery_manifest_insert()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  canonical_data_classes text[];
  data_classes text[];
  data_class_count integer;
  distinct_data_class_count integer;
  field_count integer;
  distinct_field_count integer;
  manifest_keys text[];
  observed_count integer;
  observed_distinct_count integer;
  policy_keys text[];
  prepared_at_ms numeric;
  provider_rights_keys text[];
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
    OR policy_keys IS DISTINCT FROM ARRAY[
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
  IF prepared_at_ms >=
      (NEW.manifest -> 'policyPurpose' ->> 'policyExpiresAt')::numeric
    OR prepared_at_ms >=
      (NEW.manifest -> 'providerRights' ->> 'expiresAt')::numeric
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
  RETURN NEW;
END;
$$;

CREATE TRIGGER export_deliveries_are_append_only
  BEFORE UPDATE OR DELETE ON kurobara_core.export_deliveries
  FOR EACH ROW EXECUTE FUNCTION
    kurobara_core.guard_export_delivery_append_only();

CREATE TRIGGER export_delivery_manifest_is_valid
  BEFORE INSERT ON kurobara_core.export_deliveries
  FOR EACH ROW EXECUTE FUNCTION
    kurobara_core.guard_export_delivery_manifest_insert();

CREATE TRIGGER export_delivery_requests_are_append_only
  BEFORE UPDATE OR DELETE ON kurobara_core.export_delivery_requests
  FOR EACH ROW EXECUTE FUNCTION
    kurobara_core.guard_export_delivery_append_only();

CREATE TRIGGER export_delivery_events_are_append_only
  BEFORE UPDATE OR DELETE ON kurobara_core.export_delivery_events
  FOR EACH ROW EXECUTE FUNCTION
    kurobara_core.guard_export_delivery_append_only();

CREATE TRIGGER export_delivery_event_transition_is_valid
  BEFORE INSERT ON kurobara_core.export_delivery_events
  FOR EACH ROW EXECUTE FUNCTION
    kurobara_core.guard_export_delivery_event_insert();
