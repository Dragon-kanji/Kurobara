ALTER TABLE kurobara_core.runs
  ADD COLUMN cost jsonb;

UPDATE kurobara_core.runs AS stored_run
SET cost = jsonb_build_object(
  'unit', stored_plan.plan #>> '{budget,unit}',
  'spent', (stored_plan.plan #>> '{budget,spent}')::numeric,
  'reserved', (stored_plan.plan #>> '{budget,reserved}')::numeric
)
FROM kurobara_core.run_plans AS stored_plan
WHERE stored_plan.workspace_id = stored_run.workspace_id
  AND stored_plan.run_plan_id = stored_run.run_plan_id;

ALTER TABLE kurobara_core.runs
  ALTER COLUMN cost SET NOT NULL,
  ADD CONSTRAINT runs_cost_shape_check CHECK (
    jsonb_typeof(cost) = 'object'
    AND jsonb_typeof(cost -> 'unit') = 'string'
    AND jsonb_typeof(cost -> 'spent') = 'number'
    AND jsonb_typeof(cost -> 'reserved') = 'number'
    AND (cost ->> 'spent')::numeric >= 0
    AND (cost ->> 'reserved')::numeric >= 0
  );
