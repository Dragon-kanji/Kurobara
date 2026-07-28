ALTER TABLE kurobara_core.gtm_play_runs
  ADD COLUMN revision integer NOT NULL DEFAULT 1,
  ADD COLUMN execution jsonb NOT NULL DEFAULT '{
    "cost": {"reserved": 0, "spent": 0, "unit": "credits"},
    "providerCalls": 0,
    "provenance": [],
    "selectedRecordIds": [],
    "selectionReasons": [],
    "stages": [
      {
        "cost": {"reserved": 0, "spent": 0, "unit": "credits"},
        "operationId": "plays.upgrade",
        "ordinal": 1,
        "providerCalls": 0,
        "state": "failed"
      }
    ]
  }'::jsonb,
  ADD COLUMN execution_actor jsonb NOT NULL DEFAULT '{
    "actorId": "migration-unknown",
    "authenticationMode": "api-key",
    "permissions": []
  }'::jsonb,
  ADD COLUMN updated_at_ms bigint NOT NULL DEFAULT 0,
  ADD COLUMN claim_owner text,
  ADD COLUMN claim_token text,
  ADD COLUMN claim_expires_at_ms bigint;

UPDATE kurobara_core.gtm_play_runs
SET
  definition = CASE
    WHEN definition ? 'authorityEnvelopeId' THEN definition
    ELSE jsonb_set(
      definition,
      '{authorityEnvelopeId}',
      '"migration-unknown"'::jsonb,
      true
    )
  END,
  execution = CASE
    WHEN definition ? 'authorityEnvelopeId' THEN execution
    ELSE jsonb_set(
      execution,
      '{error}',
      '{
        "code": "play-upgrade-required",
        "message": "This Play run predates durable execution authority and cannot be resumed.",
        "retryable": false
      }'::jsonb,
      true
    )
  END,
  state = CASE
    WHEN definition ? 'authorityEnvelopeId' THEN state
    ELSE 'failed'
  END,
  updated_at_ms = created_at_ms
WHERE updated_at_ms = 0;

ALTER TABLE kurobara_core.gtm_play_runs
  ADD CHECK (revision > 0),
  ADD CHECK (updated_at_ms >= created_at_ms),
  ADD CHECK (
    (claim_owner IS NULL AND claim_token IS NULL AND claim_expires_at_ms IS NULL)
    OR (
      claim_owner IS NOT NULL
      AND claim_owner <> ''
      AND length(claim_owner) <= 128
      AND claim_token IS NOT NULL
      AND claim_token <> ''
      AND length(claim_token) <= 255
      AND claim_expires_at_ms IS NOT NULL
      AND claim_expires_at_ms >= 0
    )
  );

CREATE INDEX gtm_play_runs_scheduler_idx
  ON kurobara_core.gtm_play_runs (
    state,
    claim_expires_at_ms,
    updated_at_ms
  )
  WHERE state IN ('queued', 'running');
