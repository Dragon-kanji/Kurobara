import assert from "node:assert/strict";
import test from "node:test";

import {
  actorId,
  contentHash,
  datasetId,
  enrichmentRecipeId,
  fieldId,
  instant,
  recordId,
  workspaceId,
} from "@kurobara/kernel";
import type {
  RecipeApplicationWatchCounts,
  RecipeApplicationWatchQueryPort,
  RecipeApplicationWatchSnapshot,
  VerifiedApiKey,
} from "@kurobara/ports";

import { makeGetRecipeApplicationStatus } from "../src/get-recipe-application-status.ts";

const workspace = workspaceId("workspace-recipe-watch");
const applicationId = "application-recipe-watch";
const actor: VerifiedApiKey = {
  actorId: actorId("actor-recipe-watch"),
  authenticationMode: "api-key",
  credentialId: "credential-recipe-watch",
  permissions: ["recipes:read"],
  workspaceId: workspace,
};
const application = {
  createdAt: instant(1000),
  datasetId: datasetId("dataset-recipe-watch"),
  graph: {
    recordIds: [recordId("record-watch-1"), recordId("record-watch-2")],
  },
  graphHash: contentHash(`sha256:${"a".repeat(64)}`),
  intentHash: contentHash(`sha256:${"b".repeat(64)}`),
  maxCells: 2,
  recipeApplicationId: applicationId,
  recipeId: enrichmentRecipeId("recipe-watch"),
  recipeRevision: "1",
  targetFieldId: fieldId("field-watch"),
  workspaceId: workspace,
} as const;

const snapshot = (
  counts: RecipeApplicationWatchCounts
): RecipeApplicationWatchSnapshot => ({ application, counts });

const makeWatches = (
  stored: RecipeApplicationWatchSnapshot | undefined,
  calls: unknown[] = []
): RecipeApplicationWatchQueryPort => ({
  get: (scope, requestedApplicationId) => {
    calls.push({ requestedApplicationId, scope });
    return Promise.resolve(stored);
  },
});

test("derives every durable recipe application status", async () => {
  const cases = [
    {
      counts: {
        bound: 1,
        failed: 0,
        pending: 1,
        running: 0,
        skipped: 0,
        succeeded: 0,
        total: 2,
        unbound: 1,
      },
      state: "needs_replay",
      terminal: false,
    },
    {
      counts: {
        bound: 2,
        failed: 0,
        pending: 1,
        running: 0,
        skipped: 0,
        succeeded: 1,
        total: 2,
        unbound: 0,
      },
      state: "running",
      terminal: false,
    },
    {
      counts: {
        bound: 2,
        failed: 0,
        pending: 0,
        running: 0,
        skipped: 0,
        succeeded: 2,
        total: 2,
        unbound: 0,
      },
      state: "succeeded",
      terminal: true,
    },
    {
      counts: {
        bound: 2,
        failed: 1,
        pending: 0,
        running: 0,
        skipped: 1,
        succeeded: 0,
        total: 2,
        unbound: 0,
      },
      state: "completed_with_errors",
      terminal: true,
    },
  ] as const;

  for (const expected of cases) {
    const getStatus = makeGetRecipeApplicationStatus({
      requiredPermission: "recipes:read",
      watches: makeWatches(snapshot(expected.counts)),
    });
    const result = await getStatus({
      actor,
      recipeApplicationId: applicationId,
    });
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.deepEqual(result.value, {
        application,
        counts: expected.counts,
        state: expected.state,
        terminal: expected.terminal,
      });
    }
  }
});

test("rejects missing permission and invalid identifiers before persistence", async () => {
  let queried = false;
  const watches: RecipeApplicationWatchQueryPort = {
    get: () => {
      queried = true;
      return Promise.resolve(
        snapshot({
          bound: 0,
          failed: 0,
          pending: 0,
          running: 0,
          skipped: 0,
          succeeded: 0,
          total: 2,
          unbound: 2,
        })
      );
    },
  };
  const getStatus = makeGetRecipeApplicationStatus({
    requiredPermission: "recipes:read",
    watches,
  });
  const forbidden = await getStatus({
    actor: { ...actor, permissions: [] },
    recipeApplicationId: applicationId,
  });
  assert.equal(forbidden.ok, false);
  if (!forbidden.ok) {
    assert.equal(forbidden.error.code, "authority-permission-missing");
  }
  const invalid = await getStatus({ actor, recipeApplicationId: "   " });
  assert.equal(invalid.ok, false);
  if (!invalid.ok) {
    assert.equal(invalid.error.code, "request-invalid");
  }
  assert.equal(queried, false);
});

test("masks a missing or foreign-workspace application", async () => {
  const calls: unknown[] = [];
  const getStatus = makeGetRecipeApplicationStatus({
    requiredPermission: "recipes:read",
    watches: makeWatches(undefined, calls),
  });
  const result = await getStatus({ actor, recipeApplicationId: applicationId });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, "recipe-application-not-found");
  }
  const paddedIdentifier = ` ${applicationId}`;
  const paddedResult = await getStatus({
    actor,
    recipeApplicationId: paddedIdentifier,
  });
  assert.equal(paddedResult.ok, false);
  if (!paddedResult.ok) {
    assert.equal(paddedResult.error.code, "recipe-application-not-found");
  }
  assert.deepEqual(calls, [
    {
      requestedApplicationId: applicationId,
      scope: { workspaceId: workspace },
    },
    {
      requestedApplicationId: paddedIdentifier,
      scope: { workspaceId: workspace },
    },
  ]);
});

test("rejects inconsistent watch identities and counters", async () => {
  const validCounts = {
    bound: 2,
    failed: 0,
    pending: 0,
    running: 0,
    skipped: 0,
    succeeded: 2,
    total: 2,
    unbound: 0,
  } as const;
  const invalidSnapshots: RecipeApplicationWatchSnapshot[] = [
    snapshot({ ...validCounts, total: 3 }),
    snapshot({ ...validCounts, bound: 1 }),
    snapshot({ ...validCounts, succeeded: 1 }),
    {
      application: { ...application, recipeApplicationId: "application-other" },
      counts: validCounts,
    },
    {
      application: {
        ...application,
        workspaceId: workspaceId("workspace-recipe-watch-other"),
      },
      counts: validCounts,
    },
  ];

  for (const stored of invalidSnapshots) {
    const getStatus = makeGetRecipeApplicationStatus({
      requiredPermission: "recipes:read",
      watches: makeWatches(stored),
    });
    const result = await getStatus({
      actor,
      recipeApplicationId: applicationId,
    });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error.code, "recipe-application-watch-invariant");
    }
  }
});
