import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import {
  createPostgresRuntime,
  type PostgresRuntime,
} from "@kurobara/adapter-postgres";
import {
  actorId,
  datasetId,
  datasetMaterializationId,
  workspaceId,
} from "@kurobara/kernel";
import type {
  GtmPlayCompilation,
  GtmPlayDefinition,
  GtmPlayRunExecution,
  GtmPlayRunWrite,
} from "@kurobara/ports";
import postgres from "postgres";

const adminUrl = process.env.KUROBARA_TEST_POSTGRES_URL;
if (adminUrl === undefined || adminUrl.trim().length === 0) {
  throw new Error(
    "KUROBARA_TEST_POSTGRES_URL must target a disposable-capable PostgreSQL admin database."
  );
}

const databaseName = `kurobara_gtm_play_execution_${process.pid}_${Date.now()}`;
const databaseUrl = new URL(adminUrl);
databaseUrl.pathname = `/${databaseName}`;
const admin = postgres(adminUrl, { max: 1 });
let runtime: PostgresRuntime;
let inspection: postgres.Sql;

const hash = (character: string): string =>
  `sha256:${character.repeat(64).slice(0, 64)}`;

const scope = {
  workspaceId: workspaceId("workspace-gtm-play-execution"),
};
const definition: GtmPlayDefinition = {
  approvals: {
    export: false,
    providerSpend: true,
    reveal: false,
  },
  audience: {
    companyCountries: ["FR"],
    departments: ["sales"],
    personCountries: ["FR"],
    seniorities: ["director"],
    titles: ["Sales Director"],
  },
  authorityEnvelopeId: "authority-gtm-play-execution",
  broadening: "forbidden",
  budget: {
    limit: 4,
    unit: "provider_requests",
  },
  capabilities: ["organizations.discover"],
  contextRef: {
    contextId: "context-gtm-play-execution",
    fingerprint: hash("a"),
    revision: 1,
  },
  deadlineMs: 10_000,
  delivery: {
    mode: "no_send",
    privateExport: false,
  },
  exclusions: [],
  objective: {
    metric: "qualified_companies",
    target: 1,
    text: "Build one synthetic company fixture.",
  },
  playId: "play-gtm-execution",
  preview: {
    maxCompanies: 1,
    maxContactsPerCompany: 1,
    maxContactsTotal: 1,
    maxProviderCalls: 1,
    sampleSize: 1,
  },
  selection: {
    minimumScore: 0,
    requiredSignals: [],
  },
  source: {
    countries: ["FR"],
    industries: ["software"],
    keywords: ["synthetic"],
    kind: "organization_search",
  },
  stopConditions: ["budget_exhausted"],
};
const compilation: GtmPlayCompilation = {
  assumptions: [],
  authority: {
    humanGates: ["provider_spend"],
    permissions: ["datasets:generate", "plays:execute"],
  },
  budget: {
    limit: 4,
    quotedUpperBound: 1,
    unit: "provider_requests",
  },
  deadlineMs: 10_000,
  exportMode: "no_send",
  intentionHash: hash("b"),
  stages: [
    {
      capability: "organizations.discover",
      inputFingerprint: hash("c"),
      operationId: "organizations.discover",
      ordinal: 1,
    },
  ],
};
const pendingExecution: GtmPlayRunExecution = {
  cost: {
    reserved: 1,
    spent: 0,
    unit: "provider_requests",
  },
  currentStageOrdinal: 1,
  providerCalls: 0,
  provenance: [],
  selectedRecordIds: [],
  selectionReasons: [],
  stages: [
    {
      cost: {
        reserved: 1,
        spent: 0,
        unit: "provider_requests",
      },
      operationId: "organizations.discover",
      ordinal: 1,
      providerCalls: 0,
      state: "pending",
    },
  ],
};

before(async () => {
  await admin`CREATE DATABASE ${admin(databaseName)}`;
  runtime = createPostgresRuntime(databaseUrl.toString());
  await runtime.migrate();
  inspection = postgres(databaseUrl.toString(), { max: 2 });
  await inspection`
    INSERT INTO kurobara_core.workspaces (workspace_id)
    VALUES (${scope.workspaceId})
  `;

  const play = await runtime.gtm.putPlayRevision(scope, {
    compilation,
    createdAtMs: 1000,
    createdByActorId: actorId("actor-gtm-play-execution"),
    definition,
    expectedBaseRevision: 0,
    fingerprint: hash("d"),
    lifecycle: "active",
  });
  if (play.status !== "created") {
    throw new Error("The synthetic Play revision was not created.");
  }

  const input: GtmPlayRunWrite = {
    compilation,
    createdAtMs: 1000,
    definition,
    execution: pendingExecution,
    executionActor: {
      actorId: actorId("actor-gtm-play-execution"),
      authenticationMode: "api-key",
      permissions: ["datasets:generate", "plays:execute"],
    },
    idempotencyKey: "run-gtm-play-execution",
    playId: definition.playId,
    playRevision: play.revision.revision,
    runId: "run-gtm-play-execution",
  };
  const run = await runtime.gtm.createPlayRun(scope, input);
  if (run.status !== "created") {
    throw new Error("The synthetic Play run was not created.");
  }
});

after(async () => {
  await inspection?.end({ timeout: 5 });
  await runtime?.close();
  await admin`DROP DATABASE IF EXISTS ${admin(databaseName)} WITH (FORCE)`;
  await admin.end({ timeout: 5 });
});

test("claims once, recovers an expired lease, and fences every run revision", async () => {
  const concurrentClaims = await Promise.all([
    runtime.gtm.claimNextPlayRun("worker-a", "claim-a", 2000, 50),
    runtime.gtm.claimNextPlayRun("worker-b", "claim-b", 2000, 50),
  ]);
  const firstClaim = concurrentClaims.find((claim) => claim !== undefined);

  assert.equal(
    concurrentClaims.filter((claim) => claim !== undefined).length,
    1
  );
  assert.ok(firstClaim);
  assert.equal(firstClaim.run.revision, 1);
  assert.equal(firstClaim.run.state, "queued");
  assert.equal(firstClaim.claimExpiresAtMs, 2050);

  assert.equal(
    await runtime.gtm.claimNextPlayRun(
      "worker-before-expiry",
      "claim-before-expiry",
      2049,
      100
    ),
    undefined
  );

  const recovered = await runtime.gtm.claimNextPlayRun(
    "worker-recovered",
    "claim-recovered",
    2050,
    100
  );
  assert.ok(recovered);
  assert.equal(recovered.run.runId, firstClaim.run.runId);
  assert.equal(recovered.run.revision, 1);

  const runningExecution: GtmPlayRunExecution = {
    ...pendingExecution,
    stages: [
      {
        ...pendingExecution.stages[0],
        state: "running",
      },
    ],
  };
  assert.deepEqual(
    await runtime.gtm.updatePlayRun(scope, {
      claimToken: firstClaim.claimToken,
      execution: runningExecution,
      expectedRevision: 1,
      runId: firstClaim.run.runId,
      state: "running",
      updatedAtMs: 2051,
    }),
    { status: "conflict" }
  );
  assert.deepEqual(
    await runtime.gtm.updatePlayRun(scope, {
      claimToken: recovered.claimToken,
      execution: runningExecution,
      expectedRevision: 2,
      runId: recovered.run.runId,
      state: "running",
      updatedAtMs: 2051,
    }),
    { status: "conflict" }
  );

  const running = await runtime.gtm.updatePlayRun(scope, {
    claimToken: recovered.claimToken,
    execution: runningExecution,
    expectedRevision: 1,
    runId: recovered.run.runId,
    state: "running",
    updatedAtMs: 2051,
  });
  assert.equal(running.status, "updated");
  if (running.status !== "updated") {
    throw new Error("The recovered worker did not advance the Play run.");
  }
  assert.equal(running.run.revision, 2);
  assert.equal(running.run.state, "running");

  const finalClaim = await runtime.gtm.claimNextPlayRun(
    "worker-final",
    "claim-final",
    2052,
    100
  );
  assert.ok(finalClaim);
  assert.equal(finalClaim.run.revision, 2);

  const completedExecution: GtmPlayRunExecution = {
    cost: {
      reserved: 1,
      spent: 1,
      unit: "provider_requests",
    },
    providerCalls: 1,
    provenance: ["synthetic:postgres-integration"],
    result: {
      datasetId: datasetId("dataset-gtm-play-execution"),
      exportReady: false,
      materializationId: datasetMaterializationId(
        datasetId("dataset-gtm-play-execution")
      ),
      recordCount: 1,
      workbookId: "workbook-gtm-play-execution",
    },
    selectedRecordIds: [],
    selectionReasons: [],
    stages: [
      {
        cost: {
          reserved: 1,
          spent: 1,
          unit: "provider_requests",
        },
        datasetId: datasetId("dataset-gtm-play-execution"),
        materializationId: datasetMaterializationId(
          datasetId("dataset-gtm-play-execution")
        ),
        operationId: "organizations.discover",
        ordinal: 1,
        providerCalls: 1,
        recordCount: 1,
        state: "completed",
      },
    ],
  };
  assert.deepEqual(
    await runtime.gtm.updatePlayRun(scope, {
      claimToken: recovered.claimToken,
      execution: completedExecution,
      expectedRevision: 2,
      runId: finalClaim.run.runId,
      state: "completed",
      updatedAtMs: 2053,
    }),
    { status: "conflict" }
  );

  const completed = await runtime.gtm.updatePlayRun(scope, {
    claimToken: finalClaim.claimToken,
    execution: completedExecution,
    expectedRevision: 2,
    runId: finalClaim.run.runId,
    state: "completed",
    updatedAtMs: 2053,
  });
  assert.equal(completed.status, "updated");
  if (completed.status !== "updated") {
    throw new Error("The final worker did not complete the Play run.");
  }
  assert.equal(completed.run.revision, 3);
  assert.equal(completed.run.state, "completed");
  assert.deepEqual(completed.run.execution, completedExecution);

  assert.deepEqual(
    await runtime.gtm.getPlayRun(scope, completed.run.runId),
    completed.run
  );
  assert.equal(
    await runtime.gtm.claimNextPlayRun(
      "worker-after-terminal",
      "claim-after-terminal",
      3000,
      100
    ),
    undefined
  );
});
