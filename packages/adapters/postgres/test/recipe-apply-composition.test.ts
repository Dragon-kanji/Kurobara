import assert from "node:assert/strict";
import test from "node:test";

import { workspaceId } from "@kurobara/kernel";
import type {
  PlanningUnitOfWork,
  RunCreationUnitOfWork,
  WorkspaceScope,
} from "@kurobara/ports";
import type postgres from "postgres";

import { createPostgresRecipeApplyPersistence } from "../src/recipe.ts";

const workspace = workspaceId("workspace-recipe-apply-composition");
const scope = { workspaceId: workspace } as const;

const runUnitOfWork = (): RunCreationUnitOfWork => ({
  outbox: { append: () => Promise.resolve() },
  runEvents: { append: () => Promise.resolve() },
  runPlans: {
    get: () => Promise.resolve(undefined),
    insert: () => Promise.resolve(),
    markConsumed: () => Promise.resolve(),
  },
  runs: {
    findByIdempotencyKey: () => Promise.resolve(undefined),
    insert: () => Promise.resolve(),
    lockIdempotencyKey: () => Promise.resolve(),
  },
});

const planningUnitOfWork = (): PlanningUnitOfWork => ({
  runPlans: { insert: () => Promise.resolve() },
  snapshots: {
    getAuthority: () => Promise.resolve(undefined),
    getDefaults: () => Promise.resolve(undefined),
    getPolicy: () => Promise.resolve(undefined),
    getPricing: () => Promise.resolve(undefined),
    getWorkflow: () => Promise.resolve(undefined),
  },
});

test("composes planning, canonical Run, and recipe repositories in one SQL transaction", async () => {
  const transactionSql = (() => undefined) as unknown as postgres.Sql;
  let beginCalls = 0;
  const rootSql = {
    begin: (work: (sql: postgres.Sql) => Promise<unknown>) => {
      beginCalls += 1;
      return work(transactionSql);
    },
  } as unknown as postgres.Sql;
  const run = runUnitOfWork();
  const planning = planningUnitOfWork();
  let runFactoryScope: WorkspaceScope | undefined;
  let planningFactoryScope: WorkspaceScope | undefined;

  const persistence = createPostgresRecipeApplyPersistence(
    rootSql,
    (sql, requestedScope) => {
      assert.equal(sql, transactionSql);
      runFactoryScope = requestedScope;
      return run;
    },
    (sql, requestedScope) => {
      assert.equal(sql, transactionSql);
      planningFactoryScope = requestedScope;
      return planning;
    }
  );

  const result = await persistence.transaction(scope, (unitOfWork) => {
    assert.equal(unitOfWork.runs, run.runs);
    assert.equal(unitOfWork.runPlans, run.runPlans);
    assert.equal(unitOfWork.planning, planning);
    assert.equal(typeof unitOfWork.inputs.resolveExact, "function");
    assert.equal(typeof unitOfWork.runCreation.bindPending, "function");
    return Promise.resolve("composed");
  });

  assert.equal(result, "composed");
  assert.equal(beginCalls, 1);
  assert.deepEqual(runFactoryScope, scope);
  assert.deepEqual(planningFactoryScope, scope);
});
