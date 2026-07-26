-- This migration persists only immutable, provider-neutral generation plans.
-- It intentionally creates no dataset, generation runtime, page, Run, outbox,
-- record, materialization, cursor, provider receipt, or cost-ledger entry.

CREATE TABLE kurobara_core.dataset_generation_plans (
  workspace_id text NOT NULL
    REFERENCES kurobara_core.workspaces (workspace_id),
  generation_plan_id text NOT NULL,
  idempotency_key text NOT NULL,
  target_dataset_id text NOT NULL,
  query_hash text NOT NULL,
  schema_hash text NOT NULL,
  request_intent_hash text NOT NULL,
  plan_hash text NOT NULL,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workspace_id, generation_plan_id),
  UNIQUE (workspace_id, idempotency_key),
  UNIQUE (workspace_id, target_dataset_id),
  CHECK (char_length(generation_plan_id) BETWEEN 1 AND 255),
  CHECK (btrim(generation_plan_id) = generation_plan_id),
  CHECK (char_length(idempotency_key) BETWEEN 1 AND 512),
  CHECK (btrim(idempotency_key) = idempotency_key),
  CHECK (char_length(target_dataset_id) BETWEEN 1 AND 255),
  CHECK (btrim(target_dataset_id) = target_dataset_id),
  CHECK (query_hash ~ '^sha256:[0-9a-f]{64}$'),
  CHECK (schema_hash ~ '^sha256:[0-9a-f]{64}$'),
  CHECK (request_intent_hash ~ '^sha256:[0-9a-f]{64}$'),
  CHECK (plan_hash ~ '^sha256:[0-9a-f]{64}$'),
  CHECK (jsonb_typeof(payload) = 'object'),
  CHECK (payload ?& ARRAY[
    'idempotencyKey',
    'requestIntentHash',
    'plan'
  ]),
  CHECK (jsonb_typeof(payload -> 'plan') = 'object'),
  CHECK (payload -> 'plan' ?& ARRAY[
    'authority',
    'budget',
    'deadline',
    'generationPlanId',
    'hardExecutionCap',
    'idempotencyKey',
    'limits',
    'normalizedQuery',
    'normalizerVersion',
    'planHash',
    'policy',
    'queryContract',
    'queryHash',
    'quote',
    'requestIntent',
    'requestIntentHash',
    'routeSnapshots',
    'schemaHash',
    'workspaceId'
  ]),
  CHECK (
    jsonb_typeof(payload #> '{plan,requestIntent}') = 'object'
    AND (payload #> '{plan,requestIntent}') ?& ARRAY[
      'actorId',
      'authorityEnvelopeId',
      'capability',
      'fields',
      'limits',
      'requestedBudget',
      'requestedDeadline',
      'requestedQuery',
      'targetDataset',
      'unknownCostPolicy',
      'workspaceId'
    ]
  ),
  CHECK (
    jsonb_typeof(
      payload #> '{plan,requestIntent,targetDataset}'
    ) = 'object'
    AND (payload #> '{plan,requestIntent,targetDataset}') ? 'datasetId'
  ),
  CHECK (
    payload ->> 'idempotencyKey' IS NOT NULL
    AND payload ->> 'idempotencyKey' = idempotency_key
  ),
  CHECK (
    payload ->> 'requestIntentHash' IS NOT NULL
    AND payload ->> 'requestIntentHash' = request_intent_hash
  ),
  CHECK (
    payload #>> '{plan,workspaceId}' IS NOT NULL
    AND payload #>> '{plan,workspaceId}' = workspace_id
  ),
  CHECK (
    payload #>> '{plan,generationPlanId}' IS NOT NULL
    AND payload #>> '{plan,generationPlanId}' = generation_plan_id
  ),
  CHECK (
    payload #>> '{plan,idempotencyKey}' IS NOT NULL
    AND payload #>> '{plan,idempotencyKey}' = idempotency_key
  ),
  CHECK (
    payload #>> '{plan,requestIntentHash}' IS NOT NULL
    AND payload #>> '{plan,requestIntentHash}' = request_intent_hash
  ),
  CHECK (
    payload #>> '{plan,requestIntent,targetDataset,datasetId}' IS NOT NULL
    AND payload #>> '{plan,requestIntent,targetDataset,datasetId}' =
        target_dataset_id
  ),
  CHECK (
    payload #>> '{plan,queryHash}' IS NOT NULL
    AND payload #>> '{plan,queryHash}' = query_hash
  ),
  CHECK (
    payload #>> '{plan,schemaHash}' IS NOT NULL
    AND payload #>> '{plan,schemaHash}' = schema_hash
  ),
  CHECK (
    payload #>> '{plan,planHash}' IS NOT NULL
    AND payload #>> '{plan,planHash}' = plan_hash
  ),
  -- A plan can include up to 256 bounded field definitions and one bounded
  -- normalized query. Keep storage defensive without introducing object
  -- storage or an unbounded JSON escape hatch in this foundation slice.
  CHECK (octet_length(payload::text) <= 2097152)
);

CREATE FUNCTION kurobara_core.reject_dataset_generation_plan_change()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'Kurobara dataset generation plans are immutable'
    USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER dataset_generation_plans_are_immutable
  BEFORE UPDATE OR DELETE ON kurobara_core.dataset_generation_plans
  FOR EACH ROW EXECUTE FUNCTION
    kurobara_core.reject_dataset_generation_plan_change();
