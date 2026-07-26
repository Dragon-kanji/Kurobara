import assert from "node:assert/strict";
import test from "node:test";

import {
  actorId,
  contentHash,
  datasetGenerationId,
  instant,
  runId,
  runPlanId,
  succeed,
  workspaceId,
} from "@kurobara/kernel";
import type {
  DatasetGenerationWorkClaim,
  DatasetGenerationWorkPort,
} from "@kurobara/ports";

import type { AuthorizeDatasetGenerationPageResult } from "../src/authorize-first-dataset-generation-page.ts";
import type { CheckpointDatasetGenerationPageResult } from "../src/checkpoint-first-dataset-generation-page.ts";
import { makeScheduleNextDatasetGeneration } from "../src/schedule-dataset-generation.ts";

const workspace = workspaceId("workspace-generation-scheduler");
const generation = datasetGenerationId("generation-scheduler");
const now = instant(1_900_000_000_000);

const claim = (
  leaseToken = "lease-generation-scheduler"
): DatasetGenerationWorkClaim => ({
  actorId: actorId("actor-generation-scheduler"),
  actorPermissions: ["datasets:generate", "steps:execute"],
  claimedBy: "generation-scheduler-test",
  generationId: generation,
  leaseExpiresAt: instant(now + 30_000),
  leaseToken,
  workspaceId: workspace,
});

const committedPage = (hasMore: boolean) => ({
  aggregateVersion: 3,
  createdAt: now,
  generationId: generation,
  hasMore,
  inputContentHash: contentHash(`sha256:${"a".repeat(64)}`),
  inputCursor: null,
  inputId: "input-generation-scheduler",
  nextCursor: hasMore ? "cursor-next" : null,
  pageSequence: 1,
  runId: runId("run-generation-scheduler"),
  runPlanId: runPlanId("run-plan-generation-scheduler"),
  state: "committed" as const,
  workspaceId: workspace,
});

const memoryWork = (claims: DatasetGenerationWorkClaim[]) => {
  const released: string[] = [];
  const work: DatasetGenerationWorkPort = {
    claimNext: () => Promise.resolve(claims.shift()),
    release: (leased) => {
      released.push(leased.leaseToken);
      return Promise.resolve({ status: "released" });
    },
  };
  return { released, work };
};

const checkpointResult = (
  hasMore: boolean
): CheckpointDatasetGenerationPageResult =>
  succeed({
    page: committedPage(hasMore),
    status: "checkpointed",
  });

const authorizationResult = (): AuthorizeDatasetGenerationPageResult =>
  succeed({ page: committedPage(true), replayed: false });

test("authorizes the next page with only the immutable claimed authority", async () => {
  const memory = memoryWork([claim()]);
  const authorizationRequests: unknown[] = [];
  const schedule = makeScheduleNextDatasetGeneration({
    authorize: (request) => {
      authorizationRequests.push(structuredClone(request));
      return Promise.resolve(authorizationResult());
    },
    checkpoint: () => Promise.resolve(checkpointResult(true)),
    claimLeaseMilliseconds: 30_000,
    clock: { now: async () => now },
    nextLeaseToken: () => "next-lease",
    schedulerId: "generation-scheduler-test",
    work: memory.work,
  });

  assert.deepEqual(await schedule(), {
    generationId: generation,
    idle: false,
    status: "authorized",
  });
  assert.deepEqual(authorizationRequests, [
    {
      actorId: actorId("actor-generation-scheduler"),
      actorPermissions: ["datasets:generate", "steps:execute"],
      authenticationMode: "system",
      correlationId: "dataset-generation-scheduler:lease-generation-scheduler",
      generationId: generation,
      workspaceId: workspace,
    },
  ]);
  assert.deepEqual(memory.released, ["lease-generation-scheduler"]);
});

test("does not authorize after a terminal checkpoint", async () => {
  const memory = memoryWork([claim()]);
  let authorizationCalls = 0;
  const schedule = makeScheduleNextDatasetGeneration({
    authorize: () => {
      authorizationCalls += 1;
      return Promise.resolve(authorizationResult());
    },
    checkpoint: () =>
      Promise.resolve(
        succeed({ page: committedPage(false), status: "failed" })
      ),
    claimLeaseMilliseconds: 30_000,
    clock: { now: async () => now },
    nextLeaseToken: () => "next-lease",
    schedulerId: "generation-scheduler-test",
    work: memory.work,
  });

  assert.equal((await schedule()).status, "terminal");
  assert.equal(authorizationCalls, 0);
  assert.deepEqual(memory.released, ["lease-generation-scheduler"]);
});

test("retains the lease when immutable bounds block another page", async () => {
  const memory = memoryWork([claim()]);
  const schedule = makeScheduleNextDatasetGeneration({
    authorize: () =>
      Promise.resolve({
        error: {
          code: "deadline-elapsed" as const,
          message: "The immutable deadline elapsed.",
        },
        ok: false as const,
      }),
    checkpoint: () => Promise.resolve(checkpointResult(true)),
    claimLeaseMilliseconds: 30_000,
    clock: { now: async () => now },
    nextLeaseToken: () => "next-lease",
    schedulerId: "generation-scheduler-test",
    work: memory.work,
  });

  assert.equal((await schedule()).status, "blocked");
  assert.deepEqual(memory.released, []);
});

test("concurrent scheduler cycles consume one claim and create one next page", async () => {
  const memory = memoryWork([claim()]);
  let authorizationCalls = 0;
  const dependencies = {
    authorize: () => {
      authorizationCalls += 1;
      return Promise.resolve(authorizationResult());
    },
    checkpoint: () => Promise.resolve(checkpointResult(true)),
    claimLeaseMilliseconds: 30_000,
    clock: { now: async () => now },
    nextLeaseToken: () => "next-lease",
    schedulerId: "generation-scheduler-test",
    work: memory.work,
  } as const;
  const first = makeScheduleNextDatasetGeneration(dependencies);
  const second = makeScheduleNextDatasetGeneration(dependencies);

  const outcomes = await Promise.all([first(), second()]);
  assert.deepEqual(outcomes.map((outcome) => outcome.status).sort(), [
    "authorized",
    "idle",
  ]);
  assert.equal(authorizationCalls, 1);
});
