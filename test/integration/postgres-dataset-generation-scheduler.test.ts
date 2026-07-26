import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { after, before, test } from "node:test";

import {
  createPostgresRuntime,
  type PostgresRuntime,
} from "@kurobara/adapter-postgres";
import {
  makeAuthorizeDatasetGenerationPage,
  makeCheckpointDatasetGenerationPage,
  makeClaimRunExecution,
  makeCreateDatasetGeneration,
  makeExecuteLeafAttemptRegistry,
  makeMaterializeNextDagRun,
  makePlanDatasetGeneration,
  makeRouteAndClaimNextReadyStep,
  makeScheduleNextDatasetGeneration,
} from "@kurobara/application";
import type { DatasetGenerationPage } from "@kurobara/kernel";
import {
  actorId,
  capabilityId,
  contentHash,
  correlationId,
  datasetGenerationId,
  datasetGenerationPlanId,
  datasetId,
  eventId,
  fieldId,
  idempotencyKey,
  instant,
  outboxMessageId,
  recordId,
  runId,
  usageEntryId,
  workspaceId,
} from "@kurobara/kernel";
import postgres from "postgres";

const adminUrl = process.env.KUROBARA_TEST_POSTGRES_URL;
if (adminUrl === undefined || adminUrl.trim().length === 0) {
  throw new Error(
    "KUROBARA_TEST_POSTGRES_URL must target a disposable-capable PostgreSQL admin database."
  );
}

const databaseName = `kurobara_generation_scheduler_${process.pid}_${Date.now()}`;
const databaseUrl = new URL(adminUrl);
databaseUrl.pathname = `/${databaseName}`;
const admin = postgres(adminUrl, { max: 1 });
const sql = postgres(databaseUrl.toString(), { max: 8 });
let runtime: PostgresRuntime;

before(async () => {
  await admin`CREATE DATABASE ${admin(databaseName)}`;
  runtime = createPostgresRuntime(databaseUrl.toString());
  await runtime.migrate();
  await runtime.verifyMigrations();
});

after(async () => {
  await runtime.close();
  await sql.end({ timeout: 5 });
  await admin`DROP DATABASE IF EXISTS ${admin(databaseName)} WITH (FORCE)`;
  await admin.end({ timeout: 5 });
});

const hash = (value: string) =>
  contentHash(`sha256:${createHash("sha256").update(value).digest("hex")}`);

const now = instant(1_900_000_000_000);
const deadline = instant(now + 60_000);
const adapterKey = "deterministic-dataset-generation-page";
const workspace = workspaceId("workspace-generation-scheduler-integration");
const actor = actorId("actor-generation-scheduler-integration");
const targetDataset = datasetId("dataset-generation-scheduler-integration");
const companyNameField = fieldId("field-company-name-scheduler");
const capability = {
  capabilityId: capabilityId("organizations.discover"),
  capabilityVersion: "1.0.0",
} as const;
const limits = {
  maxCalls: 2,
  maxCompanies: 10,
  maxContactsPerCompany: 0,
  maxContactsTotal: 0,
  maxEnrichments: 0,
  maxPages: 2,
  maxPhones: 0,
  maxResults: 10,
} as const;

let identitySequence = 0;
const nextIdentitySequence = (): number => {
  identitySequence += 1;
  return identitySequence;
};
const identifiers = (marker: string) => ({
  nextEventId: async () => eventId(`event-${marker}-${nextIdentitySequence()}`),
  nextOutboxMessageId: async () =>
    outboxMessageId(`outbox-${marker}-${nextIdentitySequence()}`),
  nextRunId: async () => runId(`run-${marker}-${nextIdentitySequence()}`),
});

const authorizationRequest = (
  generationIdValue: ReturnType<typeof datasetGenerationId>
) => ({
  actorId: actor,
  actorPermissions: ["datasets:generate", "steps:execute"],
  authenticationMode: "api-key",
  correlationId: correlationId("correlation-generation-scheduler"),
  generationId: generationIdValue,
  workspaceId: workspace,
});

const executePage = async (input: {
  page: DatasetGenerationPage;
  plan: Awaited<ReturnType<ReturnType<typeof makePlanDatasetGeneration>>> &
    Readonly<{ ok: true }>;
  output: Readonly<{
    companyName: string;
    hasMore: boolean;
    nextCursor: null | string;
  }>;
}): Promise<void> => {
  const bindingRows = await sql<
    readonly { event_id: string; start_key: string }[]
  >`
    SELECT message.event_id, binding.start_key
    FROM kurobara_core.run_orchestration_bindings AS binding
    JOIN kurobara_core.outbox_messages AS message
      ON message.workspace_id = binding.workspace_id
      AND message.message_id = binding.outbox_message_id
    WHERE binding.workspace_id = ${workspace}
      AND binding.run_id = ${input.page.runId}
  `;
  const [binding] = bindingRows;
  if (binding === undefined) {
    throw new Error("The generation page run binding was not persisted.");
  }
  const claimed = await makeClaimRunExecution({
    clock: { now: async () => instant(now + 100 + identitySequence) },
    identifiers: identifiers("claim"),
    persistence: runtime.runExecution,
  })({
    eventId: eventId(binding.event_id),
    runId: input.page.runId,
    startKey: binding.start_key,
    workspaceId: workspace,
  });
  if (!claimed.ok) {
    throw new Error(
      `The generation page run was not claimed: ${claimed.error.message}`
    );
  }

  const materialize = makeMaterializeNextDagRun({
    clock: { now: async () => instant(now + 10_000 + identitySequence) },
    identifiers: {
      nextEventId: async () => eventId(`dag-${nextIdentitySequence()}`),
    },
    persistence: runtime.dagScheduling,
  });
  let materialized = false;
  for (let index = 0; index < 10; index += 1) {
    const candidate = await materialize();
    if (
      candidate.status === "processed" &&
      candidate.runId === input.page.runId
    ) {
      materialized = true;
      break;
    }
  }
  if (!materialized) {
    throw new Error("The generation page run was not materialized.");
  }

  const routed = await makeRouteAndClaimNextReadyStep({
    availableEffectAdapterKeys: [adapterKey],
    clock: { now: async () => instant(now + 300 + identitySequence) },
    persistence: runtime.stepRouting,
    requiredPermission: "steps:execute",
    retryDelayMilliseconds: 1000,
  })();
  if (routed.status !== "claimed" || !routed.result.ok) {
    throw new Error("The generation page route was not claimed.");
  }
  const attempt = routed.result.value.stepRun.attempts.at(-1);
  if (attempt === undefined) {
    throw new Error("The generation page attempt was not persisted.");
  }
  const leafRows = await sql<
    readonly { event_id: string; start_key: string }[]
  >`
    SELECT event_id, start_key
    FROM kurobara_core.step_leaf_execution_bindings
    WHERE workspace_id = ${workspace}
      AND attempt_id = ${attempt.attemptId}
  `;
  const [leaf] = leafRows;
  if (leaf === undefined) {
    throw new Error("The generation page leaf binding was not persisted.");
  }

  const generatedRecord = {
    datasetId: targetDataset,
    recordId: recordId(`record-${input.page.pageSequence}`),
    values: [{ fieldId: companyNameField, value: input.output.companyName }],
    workspaceId: workspace,
  };
  let effectCalls = 0;
  const pageArtifact = {
    hasMore: input.output.hasMore,
    items: [
      {
        contentHash: hash(JSON.stringify(generatedRecord)),
        record: generatedRecord,
      },
    ],
    nextCursor: input.output.nextCursor,
    sourcePartitionCompleted: !input.output.hasMore,
    version: "1.0.0" as const,
  };
  const effect = {
    port: {
      adapterKey,
      execute: (request: { attemptId: string; reservationUnit: string }) => {
        effectCalls += 1;
        return Promise.resolve({
          output: pageArtifact,
          settlement: {
            amount: 0.5,
            kind: "settle" as const,
            unit: request.reservationUnit,
            usageEntryId: usageEntryId(`usage-scheduler-${request.attemptId}`),
          },
          status: "succeeded" as const,
        });
      },
      lookup: () =>
        Promise.resolve({
          proofId: "scheduler-fixture-not-found",
          status: "not-found" as const,
        }),
    },
  };
  const executed = await makeExecuteLeafAttemptRegistry({
    clock: { now: async () => instant(now + 400 + identitySequence) },
    effects: [effect.port],
    identifiers: {
      nextEventId: async () => eventId(`leaf-${nextIdentitySequence()}`),
    },
    outputValidator: {
      validate: async () => ({
        status: "accepted" as const,
        validatorVersion: "generation-scheduler-integration-1.0.0",
      }),
    },
    persistence: runtime.stepExecution,
    queries: runtime.stepQueries,
    requiredPermission: "steps:execute",
  })({
    attemptId: attempt.attemptId,
    eventId: eventId(leaf.event_id),
    runId: input.page.runId,
    startKey: leaf.start_key,
    stepRunId: routed.stepRunId,
    workspaceId: workspace,
  });
  if (!executed.ok) {
    throw new Error(
      `The generation page effect did not execute: ${executed.error.message}`
    );
  }

  let converged = false;
  for (let index = 0; index < 10; index += 1) {
    const candidate = await materialize();
    if (
      candidate.status === "processed" &&
      candidate.runId === input.page.runId
    ) {
      converged = true;
      break;
    }
  }
  if (!converged) {
    throw new Error("The generation page run did not converge.");
  }
  if (effectCalls !== 1) {
    throw new Error(
      `Expected one generation effect call, received ${effectCalls}.`
    );
  }
};

test("a restarted scheduler checkpoints page one, authorizes page two once, and publishes ready", async () => {
  await sql`
    INSERT INTO kurobara_core.workspaces (workspace_id)
    VALUES (${workspace})
  `;
  const planned = await makePlanDatasetGeneration({
    clock: { now: async () => now },
    identifiers: {
      nextDatasetGenerationPlanId: async () =>
        datasetGenerationPlanId("generation-plan-scheduler"),
    },
    normalizer: {
      normalize: (input) => ({
        capability: input.capability,
        contract: {
          catalogFingerprint: hash("catalog"),
          catalogVersion: "1.0.0",
          schemaFingerprint: hash("query-schema"),
          schemaId: "organizations.discover.query",
          schemaVersion: "1.0.0",
        },
        normalizerVersion: "integration-1.0.0",
        status: "accepted" as const,
        value: input.query,
      }),
    },
    persistence: runtime.datasetGenerationPlanning,
    snapshots: {
      resolve: (input) =>
        Promise.resolve({
          authority: {
            authorityEnvelopeId: input.authorityEnvelopeId,
            budgetLimit: { limit: 2, reserved: 0, spent: 0, unit: "credits" },
            capabilities: [capability],
            deadline,
            permissions: ["datasets:generate", "steps:execute"],
            subjectActorId: actor,
            version: "1.0.0",
            workspaceId: workspace,
          },
          budget: { limit: 2, reserved: 0, spent: 0, unit: "credits" },
          deadline,
          policy: {
            factsHash: hash("facts"),
            requiredPermission: "datasets:generate",
            version: "1.0.0",
          },
          quote: {
            expiresAt: instant(deadline + 60_000),
            guarantee: "hard" as const,
            pricingVersion: "1.0.0",
            quoteId: "quote-generation-scheduler",
            unit: "credits",
            upperBound: 2,
          },
          routeSnapshots: [
            {
              capability,
              effectAdapterKey: adapterKey,
              factsHash: hash("facts"),
              pricingVersion: "1.0.0",
              reservableUpperBound: 1,
              reservationUnit: "credits",
              routeKey: "route-generation-scheduler",
            },
          ],
          unknownCostPolicy: input.requestedUnknownCostPolicy,
        }),
    },
  })({
    actorId: actor,
    authorityEnvelopeId: "authority-generation-scheduler",
    capability,
    fields: [
      {
        datasetId: targetDataset,
        fieldId: companyNameField,
        key: "company_name",
        label: "Company name",
        valueType: "string",
        workspaceId: workspace,
      },
    ],
    idempotencyKey: idempotencyKey("plan-generation-scheduler"),
    limits,
    query: { country: "ES", industry: "software" },
    requestedBudget: { limit: 2, unit: "credits" },
    requestedDeadline: deadline,
    targetDataset: {
      datasetId: targetDataset,
      name: "Scheduler companies",
      workspaceId: workspace,
    },
    unknownCostPolicy: { mode: "deny" },
    workspaceId: workspace,
  });
  assert.equal(planned.ok, true);
  if (!planned.ok) {
    throw new Error(planned.error.message);
  }

  const created = await makeCreateDatasetGeneration({
    clock: { now: async () => now },
    identifiers: {
      nextDatasetGenerationId: async () =>
        datasetGenerationId("generation-scheduler-integration"),
    },
    persistence: runtime.datasetGeneration,
  })({
    generationPlanId: planned.value.plan.generationPlanId,
    workspaceId: workspace,
  });
  assert.equal(created.ok, true);
  if (!created.ok) {
    throw new Error(created.error.message);
  }
  const generationIdValue = created.value.creation.generation.generationId;
  const authorize = makeAuthorizeDatasetGenerationPage({
    clock: { now: async () => instant(now + 10) },
    identifiers: identifiers("authorize"),
    persistence: runtime.datasetGenerationFirstPage,
  });
  const pageOne = await authorize(authorizationRequest(generationIdValue));
  assert.equal(pageOne.ok, true);
  if (!pageOne.ok) {
    throw new Error(pageOne.error.message);
  }
  await executePage({
    output: { companyName: "Alpha", hasMore: true, nextCursor: "cursor-2" },
    page: pageOne.value.page,
    plan: planned,
  });

  const restarted = createPostgresRuntime(databaseUrl.toString());
  try {
    const scheduleWith = (schedulerId: string, token: string) =>
      makeScheduleNextDatasetGeneration({
        authorize: makeAuthorizeDatasetGenerationPage({
          clock: { now: async () => instant(now + 1000) },
          identifiers: identifiers(schedulerId),
          persistence: restarted.datasetGenerationFirstPage,
        }),
        checkpoint: makeCheckpointDatasetGenerationPage({
          clock: { now: async () => instant(now + 1000) },
          persistence: restarted.datasetGenerationFirstPage,
        }),
        claimLeaseMilliseconds: 30_000,
        clock: { now: async () => instant(now + 1000) },
        nextLeaseToken: () => token,
        schedulerId,
        work: restarted.datasetGenerationWork,
      });
    const outcomes = await Promise.all([
      scheduleWith("scheduler-a", "lease-a")(),
      scheduleWith("scheduler-b", "lease-b")(),
    ]);
    assert.deepEqual(outcomes.map((outcome) => outcome.status).sort(), [
      "authorized",
      "idle",
    ]);
  } finally {
    await restarted.close();
  }

  const pageTwo = await authorize(authorizationRequest(generationIdValue));
  assert.equal(pageTwo.ok, true);
  if (!pageTwo.ok) {
    throw new Error(pageTwo.error.message);
  }
  assert.equal(pageTwo.value.replayed, true);
  assert.equal(pageTwo.value.page.pageSequence, 2);
  assert.equal(pageTwo.value.page.inputCursor, "cursor-2");
  await executePage({
    output: { companyName: "Beta", hasMore: false, nextCursor: null },
    page: pageTwo.value.page,
    plan: planned,
  });

  const final = await makeScheduleNextDatasetGeneration({
    authorize,
    checkpoint: makeCheckpointDatasetGenerationPage({
      clock: { now: async () => instant(now + 2000) },
      persistence: runtime.datasetGenerationFirstPage,
    }),
    claimLeaseMilliseconds: 30_000,
    clock: { now: async () => instant(now + 2000) },
    nextLeaseToken: () => "lease-final",
    schedulerId: "scheduler-final",
    work: runtime.datasetGenerationWork,
  })();
  assert.equal(final.status, "checkpointed");

  const readback = await sql<
    readonly {
      generation_state: string;
      materialization_state: string;
      page_count: string;
      record_count: string;
      run_count: string;
    }[]
  >`
    SELECT
      generation.state AS generation_state,
      materialization.state AS materialization_state,
      generation.page_count::text AS page_count,
      materialization.record_count::text AS record_count,
      (
        SELECT count(*)::text
        FROM kurobara_core.dataset_generation_pages AS page
        WHERE page.workspace_id = generation.workspace_id
          AND page.generation_id = generation.generation_id
      ) AS run_count
    FROM kurobara_core.dataset_generations AS generation
    JOIN kurobara_core.dataset_materializations AS materialization
      ON materialization.workspace_id = generation.workspace_id
      AND materialization.materialization_id = generation.materialization_id
    WHERE generation.workspace_id = ${workspace}
      AND generation.generation_id = ${generationIdValue}
  `;
  assert.deepEqual(readback[0], {
    generation_state: "completed",
    materialization_state: "ready",
    page_count: "2",
    record_count: "2",
    run_count: "2",
  });
});
