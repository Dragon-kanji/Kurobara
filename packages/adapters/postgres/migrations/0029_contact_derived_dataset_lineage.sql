-- Selected contact enrichments are immutable derived datasets. Keep their
-- exact source record binding beside the existing restricted provider lineage
-- without copying provider identifiers into public records.

ALTER TABLE kurobara_core.dataset_generation_record_lineage
  ADD COLUMN source_dataset_id text,
  ADD COLUMN source_record_id text,
  ADD CONSTRAINT dataset_generation_lineage_source_pair_check
    CHECK (
      (source_dataset_id IS NULL AND source_record_id IS NULL)
      OR (source_dataset_id IS NOT NULL AND source_record_id IS NOT NULL)
    ),
  ADD CONSTRAINT dataset_generation_lineage_source_record_fk
    FOREIGN KEY (workspace_id, source_dataset_id, source_record_id)
    REFERENCES kurobara_core.dataset_records (
      workspace_id,
      dataset_id,
      record_id
    );

CREATE INDEX dataset_generation_lineage_source_record_idx
  ON kurobara_core.dataset_generation_record_lineage (
    workspace_id,
    source_dataset_id,
    source_record_id
  )
  WHERE source_dataset_id IS NOT NULL;
