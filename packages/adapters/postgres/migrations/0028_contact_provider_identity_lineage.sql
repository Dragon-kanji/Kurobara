ALTER TABLE kurobara_core.dataset_generation_record_lineage
  ADD COLUMN provider_key text,
  ADD COLUMN provider_subject_id text,
  ADD CONSTRAINT dataset_generation_lineage_provider_identity_pair_check
    CHECK (
      (provider_key IS NULL AND provider_subject_id IS NULL)
      OR (
        provider_key IS NOT NULL
        AND provider_subject_id IS NOT NULL
      )
    ),
  ADD CONSTRAINT dataset_generation_lineage_provider_key_check
    CHECK (
      provider_key IS NULL
      OR (
        char_length(provider_key) BETWEEN 1 AND 128
        AND provider_key ~ '^[a-z][a-z0-9._-]*$'
      )
    ),
  ADD CONSTRAINT dataset_generation_lineage_provider_subject_id_check
    CHECK (
      provider_subject_id IS NULL
      OR (
        char_length(provider_subject_id) BETWEEN 1 AND 512
        AND provider_subject_id = btrim(provider_subject_id)
        AND provider_subject_id ~ '\S'
      )
    );
