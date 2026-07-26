import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

import { recipeCellInputContract } from "@kurobara/adapter-http";
import {
  createPostgresRuntime,
  type PostgresRuntime,
} from "@kurobara/adapter-postgres";
import {
  makeClaimRunExecution,
  makeMaterializeNextDagRun,
} from "@kurobara/application";
import {
  actorId,
  capabilityId,
  contentHash,
  datasetGenerationPlanId,
  eventId,
  instant,
  outboxMessageId,
  type Run,
  type RunPlan,
  runId,
  type WorkspaceId,
  workflowSpecId,
  workspaceId,
} from "@kurobara/kernel";
import type { BootstrapPlanningInput } from "@kurobara/ports";
import {
  createKurobaraClient,
  type DatasetImportMetadata,
  KurobaraProblemError,
  type RecipeApplyRequest,
} from "@kurobara/sdk";
import postgres from "postgres";
import {
  type ApiProcessLifecycle,
  createApiProcessLifecycle,
} from "../../apps/api/src/lifecycle.ts";
import {
  type ApiService,
  createApiService,
} from "../../apps/api/src/service.ts";

const FORCED_SHUTDOWN_TIMEOUT = /Shutdown exceeded 50ms/u;
const CLI_RECIPE_EXPORT_FAILURE = /CLI recipe export failed/u;
const projectRoot = fileURLToPath(new URL("../../", import.meta.url));
const adminUrl = process.env.KUROBARA_TEST_POSTGRES_URL;
if (adminUrl === undefined || adminUrl.trim().length === 0) {
  throw new Error(
    "KUROBARA_TEST_POSTGRES_URL must target a disposable-capable PostgreSQL admin database."
  );
}

const databaseName = `kurobara_http_test_${process.pid}_${Date.now()}`;
const databaseUrl = new URL(adminUrl);
databaseUrl.pathname = `/${databaseName}`;
const admin = postgres(adminUrl, { max: 1 });

let baseUrl = "";
let credentialA = "";
let credentialB = "";
let credentialIntruder = "";
let lifecycle: ApiProcessLifecycle;
let service: ApiService | undefined;

const workspaceA = workspaceId("workspace-http-a");
const actorA = actorId("actor-http-a");
const workspaceB = workspaceId("workspace-http-b");
const actorB = actorId("actor-http-b");
const executionCapability = {
  capabilityId: capabilityId("documents.summarize"),
  capabilityVersion: "1.0.0",
};
const companyDiscoveryCapability = {
  capabilityId: capabilityId("organizations.discover"),
  capabilityVersion: "1.0.0",
};
const recipeApplicationId = "recipe-application-http";
const recipeDatasetId = "dataset-http-recipe";
const recipeId = "recipe-http";

const hash = (value: string) =>
  contentHash(`sha256:${value.repeat(64).slice(0, 64)}`);

const planningBootstrap = (
  workspace: WorkspaceId,
  subjectActorId: ReturnType<typeof actorId>
): BootstrapPlanningInput => {
  const now = Date.now();
  const capability = executionCapability;
  const outputContract = {
    catalogFingerprint: hash("a"),
    catalogVersion: "1.0.0",
    schemaFingerprint: hash("b"),
    schemaId: "https://schemas.kurobara.invalid/outputs/summary/1.0.0",
    schemaVersion: "1.0.0",
  };
  const workflow = {
    contentHash: hash("f"),
    nodes: [{ capability, dependsOn: [], key: "summarize" }],
    revision: "1.0.0",
    workflowSpecId: workflowSpecId("workflow-http"),
  } as const;
  return {
    authorities: [
      {
        authorityEnvelopeId: "authority-http",
        budgetLimit: { limit: 10, reserved: 0, spent: 0, unit: "credits" },
        capabilities: [capability, companyDiscoveryCapability],
        deadline: instant(now + 600_000),
        permissions: [
          "capabilities:list",
          "plans:quote",
          "recipes:apply",
          "runs:create",
          "steps:execute",
        ],
        subjectActorId,
        version: "1.0.0",
        workspaceId: workspace,
      },
    ],
    defaults: {
      policySnapshotId: "policy-http",
      pricingSnapshotId: "pricing-http",
      workspaceId: workspace,
    },
    expectedDefaultsRevision: null,
    policies: [
      {
        policy: {
          factsHash: hash("e"),
          maxAttemptsPerStep: 3,
          requiredPermission: "plans:quote",
          version: "1.0.0",
        },
        snapshotId: "policy-http",
        workspaceId: workspace,
      },
    ],
    pricing: [
      {
        guarantee: "hard",
        snapshotId: "pricing-http",
        ttlMilliseconds: 60_000,
        unit: "credits",
        upperBound: 5,
        version: "1.0.0",
        workspaceId: workspace,
      },
    ],
    workflows: [
      {
        allowedCapabilities: [capability.capabilityId],
        catalogFingerprint: hash("a"),
        catalogVersion: "1.0.0",
        compilationLimits: { maxDepth: 2, maxFanOut: 2, maxNodes: 2 },
        compilerVersion: "1.0.0",
        inputContract: recipeCellInputContract,
        outputContract,
        workflow,
        workspaceId: workspace,
      },
    ],
    workspaceId: workspace,
  };
};

before(async () => {
  await admin`CREATE DATABASE ${admin(databaseName)}`;
  const setupRuntime: PostgresRuntime = createPostgresRuntime(
    databaseUrl.toString()
  );
  try {
    await setupRuntime.migrate();
    const keyA = await setupRuntime.bootstrapApiKey({
      actorId: actorA,
      label: "HTTP integration workspace A",
      permissions: [
        "capabilities:list",
        "datasets:import",
        "datasets:read",
        "plans:quote",
        "recipes:apply",
        "recipes:export",
        "recipes:read",
        "recipes:register",
        "runs:create",
        "runs:read",
        "steps:execute",
      ],
      workspaceId: workspaceA,
    });
    const keyIntruder = await setupRuntime.bootstrapApiKey({
      actorId: actorId("actor-http-intruder"),
      label: "HTTP integration subject mismatch",
      permissions: [
        "capabilities:list",
        "datasets:import",
        "datasets:read",
        "plans:quote",
        "recipes:apply",
        "recipes:export",
        "recipes:read",
        "recipes:register",
        "runs:create",
        "runs:read",
        "steps:execute",
      ],
      workspaceId: workspaceA,
    });
    const keyB = await setupRuntime.bootstrapApiKey({
      actorId: actorB,
      label: "HTTP integration workspace B",
      permissions: [
        "capabilities:list",
        "datasets:import",
        "datasets:read",
        "plans:quote",
        "recipes:apply",
        "recipes:export",
        "recipes:read",
        "recipes:register",
        "runs:create",
        "runs:read",
        "steps:execute",
      ],
      workspaceId: workspaceB,
    });
    credentialA = keyA.presentedKey;
    credentialIntruder = keyIntruder.presentedKey;
    credentialB = keyB.presentedKey;
    await setupRuntime.bootstrapPlanning(planningBootstrap(workspaceA, actorA));
    await setupRuntime.bootstrapPlanning(planningBootstrap(workspaceB, actorB));
  } finally {
    await setupRuntime.close();
  }

  service = createApiService({
    config: {
      environment: "test",
      host: "127.0.0.1",
      maxAuthorizationHeaderBytes: 512,
      maxBodyBytes: 65_536,
      maxExportBytes: 1_073_741_824,
      maxExportRecordBytes: 16_777_216,
      maxImportBytes: 1_073_741_824,
      migrationMode: "verify",
      port: 0,
      shutdownTimeoutMs: 10_000,
    },
    databaseUrl: databaseUrl.toString(),
    executionRoutes: [
      {
        capability: executionCapability,
        effectAdapterKey: "deterministic-local",
        reservableUpperBound: 1,
        reservationUnit: "credits",
        routeKey: "integration-local",
      },
      {
        capability: companyDiscoveryCapability,
        effectAdapterKey: "hunter-discover",
        reservableUpperBound: 1,
        reservationUnit: "credits",
        routeKey: "hunter-discover",
      },
    ],
  });
  lifecycle = createApiProcessLifecycle(service, 50);
  await lifecycle.start();
  const address = service.address();
  if (address === null) {
    throw new Error("The HTTP integration service did not publish an address.");
  }
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  try {
    await service?.forceStop?.("integration-test-cleanup");
  } finally {
    await admin`DROP DATABASE IF EXISTS ${admin(databaseName)} WITH (FORCE)`;
    await admin.end({ timeout: 5 });
  }
});

const bearerHeaders = (credential: string) => ({
  authorization: `Bearer ${credential}`,
  "content-type": "application/json",
});

const createBody = (runPlanId: string, planHash: string) =>
  JSON.stringify({
    idempotency_key: "idempotency-http-a",
    intention_hash: planHash,
    run_plan_id: runPlanId,
  });

const quoteBody = (workspace: WorkspaceId = workspaceA) =>
  JSON.stringify({
    authority_envelope_id: "authority-http",
    budget: { limit: 5, unit: "credits" },
    deadline_ms: Date.now() + 300_000,
    normalized_input_hash: hash("c"),
    workflow_content_hash: hash("f"),
    workflow_revision: "1.0.0",
    workflow_spec_id: "workflow-http",
    workspace_id: workspace,
  });

const organizationDiscoveryBody = (
  discoveryId: string,
  datasetId: string,
  mode: "dry-run" | "start" = "dry-run"
) =>
  JSON.stringify({
    authority_envelope_id: "authority-http",
    budget: { limit: 5, unit: "credits" },
    dataset_id: datasetId,
    dataset_name: "Synthetic companies",
    deadline_ms: Date.now() + 300_000,
    discovery_id: discoveryId,
    limits: { max_calls: 2, max_companies: 50, max_pages: 2 },
    mode,
    query: {
      country_codes: ["FR"],
      country_scope: "headquarters",
      employee_count: { maximum: 200, minimum: 11 },
      industry_codes: ["software"],
      industry_taxonomy: "kurobara-v1",
      keywords: ["platform"],
      result_kind: "company",
    },
  });

const readProblemCode = async (response: Response): Promise<unknown> =>
  Reflect.get((await response.json()) as object, "code");

const sourceHash = (source: Uint8Array): string =>
  `sha256:${createHash("sha256").update(source).digest("hex")}`;

const canonicalSerialize = (value: unknown): string => {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "string"
  ) {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError("Canonical JSON cannot contain non-finite numbers.");
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalSerialize).join(",")}]`;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value)
      .filter((entry) => entry[1] !== undefined)
      .sort(([left], [right]) => left.localeCompare(right));
    return `{${entries
      .map(
        ([key, entryValue]) =>
          `${JSON.stringify(key)}:${canonicalSerialize(entryValue)}`
      )
      .join(",")}}`;
  }
  throw new TypeError(`Canonical JSON cannot contain ${typeof value}.`);
};

const canonicalHash = (value: unknown) =>
  contentHash(
    `sha256:${createHash("sha256")
      .update(canonicalSerialize(value))
      .digest("hex")}`
  );

const collectBytes = async (
  source: AsyncIterable<Uint8Array>
): Promise<Uint8Array> => {
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of source) {
    chunks.push(chunk);
    total += chunk.byteLength;
  }
  const collected = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    collected.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return collected;
};

const sourceChunks = async function* (
  source: Uint8Array
): AsyncGenerator<Uint8Array> {
  await Promise.resolve();
  for (let offset = 0; offset < source.byteLength; offset += 7) {
    yield source.slice(offset, offset + 7);
  }
};

const importMetadata = (
  datasetId: string,
  importId: string,
  source: Uint8Array,
  workspace: WorkspaceId = workspaceA
): DatasetImportMetadata => ({
  batch_limits: { max_bytes: 4096, max_items: 10 },
  dataset: {
    dataset_id: datasetId,
    name: "Synthetic HTTP import",
    workspace_id: workspace,
  },
  fields: [
    {
      dataset_id: datasetId,
      field_id: "field-name",
      key: "name",
      label: "Name",
      value_type: "string",
      workspace_id: workspace,
    },
  ],
  format: "csv",
  import_id: importId,
  max_record_bytes: 2048,
  source_content_hash: sourceHash(source),
});

const runCliImport = (
  metadataFile: string,
  sourceFile: string
): Promise<Readonly<{ stderr: string; stdout: string }>> =>
  new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      [
        "--no-warnings",
        "--experimental-strip-types",
        "packages/cli/src/index.ts",
        "dataset",
        "import",
        "--metadata",
        metadataFile,
        "--source",
        sourceFile,
      ],
      {
        cwd: projectRoot,
        encoding: "utf8",
        env: {
          KUROBARA_API_KEY: credentialA,
          KUROBARA_API_URL: baseUrl,
          PATH: process.env.PATH,
        },
        maxBuffer: 1024 * 1024,
      },
      (error, stdout, stderr) => {
        if (error === null) {
          resolve({ stderr, stdout });
        } else {
          reject(
            new Error(`CLI import failed with code ${error.code ?? "unknown"}.`)
          );
        }
      }
    );
  });

const runCliRecipeApply = (
  requestFile: string
): Promise<Readonly<{ stderr: string; stdout: string }>> =>
  new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      [
        "--no-warnings",
        "--experimental-strip-types",
        "packages/cli/src/index.ts",
        "recipe",
        "apply",
        "--request",
        requestFile,
      ],
      {
        cwd: projectRoot,
        encoding: "utf8",
        env: {
          KUROBARA_API_KEY: credentialA,
          KUROBARA_API_URL: baseUrl,
          PATH: process.env.PATH,
        },
        maxBuffer: 1024 * 1024,
      },
      (error, stdout, stderr) => {
        if (error === null) {
          resolve({ stderr, stdout });
        } else {
          reject(
            new Error(
              `CLI recipe apply failed with code ${error.code ?? "unknown"}.`
            )
          );
        }
      }
    );
  });

const runCliRecipeWatch = (
  applicationId: string
): Promise<Readonly<{ stderr: string; stdout: string }>> =>
  new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      [
        "--no-warnings",
        "--experimental-strip-types",
        "packages/cli/src/index.ts",
        "recipe",
        "watch",
        "--application-id",
        applicationId,
        "--timeout-ms",
        "0",
      ],
      {
        cwd: projectRoot,
        encoding: "utf8",
        env: {
          KUROBARA_API_KEY: credentialA,
          KUROBARA_API_URL: baseUrl,
          PATH: process.env.PATH,
        },
        maxBuffer: 1024 * 1024,
      },
      (error, stdout, stderr) => {
        if (error === null) {
          resolve({ stderr, stdout });
        } else {
          reject(
            new Error(
              `CLI recipe watch failed with code ${error.code ?? "unknown"}.`
            )
          );
        }
      }
    );
  });

const runCliRecipeExport = (
  applicationId: string,
  outputFile: string
): Promise<Readonly<{ stderr: string; stdout: string }>> =>
  new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      [
        "--no-warnings",
        "--experimental-strip-types",
        "packages/cli/src/index.ts",
        "recipe",
        "export",
        "--application-id",
        applicationId,
        "--format",
        "csv",
        "--field-id",
        "field-target",
        "--field-id",
        "field-source",
        "--output",
        outputFile,
        "--timeout-ms",
        "5000",
      ],
      {
        cwd: projectRoot,
        encoding: "utf8",
        env: {
          KUROBARA_API_KEY: credentialA,
          KUROBARA_API_URL: baseUrl,
          PATH: process.env.PATH,
        },
        maxBuffer: 1024 * 1024,
      },
      (error, stdout, stderr) => {
        if (error === null) {
          resolve({ stderr, stdout });
        } else {
          reject(
            new Error(
              `CLI recipe export failed with code ${error.code ?? "unknown"}.`
            )
          );
        }
      }
    );
  });

const setStepSucceededWithOutputEvidence = async (
  inspection: ReturnType<typeof postgres>,
  run: Run,
  nodeKey: string,
  outputContract: RunPlan["outputContract"],
  normalizedPayload: unknown
): Promise<void> => {
  await inspection.begin(async (transaction) => {
    const rows = await transaction<
      readonly {
        step_run: Readonly<Record<string, unknown>>;
        step_run_id: string;
      }[]
    >`
      SELECT step_run_id, step_run
      FROM kurobara_core.step_runs
      WHERE workspace_id = ${run.workspaceId}
        AND run_id = ${run.runId}
        AND node_key = ${nodeKey}
      FOR UPDATE
    `;
    const row = rows[0];
    if (row === undefined) {
      throw new Error(`Missing synthetic step ${nodeKey}.`);
    }

    const attemptIdentifier = `attempt-${run.runId}-${nodeKey}`;
    const reservationIdentifier = `reservation-${run.runId}-${nodeKey}`;
    const operationIdentifier = `operation-${run.runId}-${nodeKey}`;
    const usageIdentifier = `usage-${run.runId}-${nodeKey}`;
    const routingIdentifier = `routing-${run.runId}-${nodeKey}`;
    const snapshotHash = canonicalHash(`route-${run.runId}-${nodeKey}`);
    const canonicalPayload = canonicalSerialize(normalizedPayload);
    const outputContentHash = canonicalHash(normalizedPayload);
    const artifactIdentifier = `artifact_${outputContentHash.slice(
      "sha256:".length
    )}`;
    const validatedOutput = {
      artifact: {
        artifactId: artifactIdentifier,
        contentHash: outputContentHash,
      },
      contract: outputContract,
      validatedAt: 5000,
      validatorVersion: "json-schema-2020-12:http-export-integration",
    } as const;
    const attempt = {
      attemptId: attemptIdentifier,
      attemptNumber: 1,
      authorityEnvelopeId: "authority-http",
      claimedAt: 5000,
      costReservationId: reservationIdentifier,
      effectAdapterKey: "deterministic-local",
      effectStartedAt: 5000,
      finishedAt: 5000,
      operationKey: operationIdentifier,
      output: validatedOutput,
      preparedAt: 5000,
      reason: "initial",
      reservationUnit: "credits",
      reservedAmount: 0,
      routeKey: "deterministic-local",
      routeSnapshotHash: snapshotHash,
      routingDecisionId: routingIdentifier,
      state: "succeeded",
      stepRunId: row.step_run_id,
    } as const;
    const reservation = {
      amount: 0,
      attemptId: attemptIdentifier,
      createdAt: 5000,
      operationKey: operationIdentifier,
      releasedAmount: 0,
      reservationId: reservationIdentifier,
      runId: run.runId,
      settledAmount: 0,
      settledAt: 5000,
      state: "settled",
      stepRunId: row.step_run_id,
      unit: "credits",
      usageEntryId: usageIdentifier,
      workspaceId: run.workspaceId,
    } as const;
    const usage = {
      amount: 0,
      attemptId: attemptIdentifier,
      operationKey: operationIdentifier,
      recordedAt: 5000,
      reservationId: reservationIdentifier,
      runId: run.runId,
      unit: "credits",
      usageEntryId: usageIdentifier,
      workspaceId: run.workspaceId,
    } as const;
    const artifact = {
      artifactId: artifactIdentifier,
      attemptId: attemptIdentifier,
      classification: "internal",
      contentHash: outputContentHash,
      contract: outputContract,
      finalizedAt: 5000,
      kind: "normalized-output",
      mediaType: "application/json",
      operationKey: operationIdentifier,
      retentionPolicy: "run",
      runId: run.runId,
      sizeBytes: Buffer.byteLength(canonicalPayload, "utf8"),
      state: "finalized",
      stepRunId: row.step_run_id,
      validatedAt: 5000,
      validatorVersion: "json-schema-2020-12:http-export-integration",
      workspaceId: run.workspaceId,
    } as const;

    await transaction`
      INSERT INTO kurobara_core.step_operation_bindings (
        workspace_id, run_id, operation_key, step_run_id
      ) VALUES (
        ${run.workspaceId}, ${run.runId}, ${operationIdentifier},
        ${row.step_run_id}
      )
    `;
    await transaction`
      INSERT INTO kurobara_core.cost_reservations (
        workspace_id, reservation_id, attempt_id, step_run_id, run_id,
        operation_key, unit, amount, state, reservation, created_at
      ) VALUES (
        ${run.workspaceId}, ${reservationIdentifier}, ${attemptIdentifier},
        ${row.step_run_id}, ${run.runId}, ${operationIdentifier}, 'credits',
        0, 'settled', ${transaction.json(reservation)}, to_timestamp(5)
      )
    `;
    await transaction`
      INSERT INTO kurobara_core.step_attempts (
        workspace_id, attempt_id, step_run_id, attempt_number,
        operation_key, reservation_id, route_key, effect_adapter_key,
        routing_decision_id, route_snapshot_hash, state, attempt, created_at
      ) VALUES (
        ${run.workspaceId}, ${attemptIdentifier}, ${row.step_run_id}, 1,
        ${operationIdentifier}, ${reservationIdentifier},
        'deterministic-local', 'deterministic-local', ${routingIdentifier},
        ${snapshotHash}, 'succeeded', ${transaction.json(attempt)},
        to_timestamp(5)
      )
    `;
    await transaction`
      INSERT INTO kurobara_core.run_output_artifacts (
        workspace_id, artifact_id, run_id, step_run_id, attempt_id,
        operation_key, content_hash, contract, normalized_payload,
        classification, kind, media_type, retention_policy, size_bytes,
        state, validator_version, validated_at, artifact, finalized_at
      ) VALUES (
        ${run.workspaceId}, ${artifact.artifactId}, ${run.runId},
        ${row.step_run_id}, ${attemptIdentifier}, ${operationIdentifier},
        ${outputContentHash}, ${transaction.json(outputContract)},
        ${transaction.json(normalizedPayload)}, ${artifact.classification},
        ${artifact.kind}, ${artifact.mediaType}, ${artifact.retentionPolicy},
        ${artifact.sizeBytes}, ${artifact.state}, ${artifact.validatorVersion},
        to_timestamp(5), ${transaction.json(artifact)}, to_timestamp(5)
      )
    `;
    await transaction`
      INSERT INTO kurobara_core.usage_ledger_entries (
        workspace_id, usage_entry_id, run_id, attempt_id, reservation_id,
        operation_key, unit, amount, entry, recorded_at
      ) VALUES (
        ${run.workspaceId}, ${usageIdentifier}, ${run.runId},
        ${attemptIdentifier}, ${reservationIdentifier}, ${operationIdentifier},
        'credits', 0, ${transaction.json(usage)}, to_timestamp(5)
      )
    `;
    await transaction`
      UPDATE kurobara_core.step_runs
      SET
        state = 'succeeded',
        aggregate_version = aggregate_version + 1,
        event_sequence = event_sequence + 1,
        step_run = ${transaction.json({
          ...row.step_run,
          aggregateVersion: Number(row.step_run.aggregateVersion ?? 0) + 1,
          attempts: [attempt],
          eventSequence: Number(row.step_run.eventSequence ?? 0) + 1,
          state: "succeeded",
        })}
      WHERE workspace_id = ${run.workspaceId}
        AND run_id = ${run.runId}
        AND step_run_id = ${row.step_run_id}
    `;
  });
};

const convergeRecipeApplicationFixture = async (
  inspection: ReturnType<typeof postgres>
): Promise<void> => {
  const rows = await inspection<
    readonly {
      output_contract: RunPlan["outputContract"];
      record_id: string;
      run_id: string;
    }[]
  >`
    SELECT
      stored_plan.plan -> 'outputContract' AS output_contract,
      cell.record_id,
      cell.run_id
    FROM kurobara_core.cell_results AS cell
    JOIN kurobara_core.run_plans AS stored_plan
      ON stored_plan.workspace_id = cell.workspace_id
      AND stored_plan.run_plan_id = cell.run_plan_id
    WHERE cell.workspace_id = ${workspaceA}
      AND cell.recipe_application_id = ${recipeApplicationId}
    ORDER BY cell.record_id
  `;
  if (
    rows.length !== 2 ||
    rows[0]?.record_id !== "record-recipe-1" ||
    rows[1]?.record_id !== "record-recipe-2"
  ) {
    throw new Error("The synthetic recipe application is incomplete.");
  }

  const terminalValues = new Map<string, Readonly<{ value: null | string }>>([
    ["record-recipe-1", { value: "Synthetic enriched" }],
    ["record-recipe-2", { value: null }],
  ]);
  const convergenceRuntime = createPostgresRuntime(databaseUrl.toString());
  let eventSequence = 0;
  try {
    const claim = makeClaimRunExecution({
      clock: { now: async () => instant(Date.now()) },
      identifiers: {
        nextEventId: async () =>
          eventId(`http-export-claim-${++eventSequence}`),
        nextOutboxMessageId: async () =>
          outboxMessageId(`unused-http-export-${eventSequence}`),
        nextRunId: async () => runId(`unused-http-export-${eventSequence}`),
      },
      persistence: convergenceRuntime.runExecution,
    });
    const materialize = makeMaterializeNextDagRun({
      clock: { now: async () => instant(Date.now()) },
      identifiers: {
        nextEventId: async () => eventId(`http-export-dag-${++eventSequence}`),
      },
      persistence: convergenceRuntime.dagScheduling,
    });

    for (const row of rows) {
      const sink = terminalValues.get(row.record_id);
      if (sink === undefined) {
        throw new Error("Missing synthetic recipe output fixture.");
      }
      const claimed = await claim({
        eventId: eventId(`http-export-orchestration-${row.record_id}`),
        runId: runId(row.run_id),
        startKey: `http-export-${row.record_id}`,
        workspaceId: workspaceA,
      });
      if (!claimed.ok) {
        throw new Error(claimed.error.message);
      }
      if (claimed.value.run.state !== "running") {
        throw new Error("The synthetic recipe run was not claimed.");
      }

      const roots = await materialize();
      if (roots.status !== "processed") {
        throw new Error("The synthetic recipe root was not materialized.");
      }
      if (
        roots.runId !== claimed.value.run.runId ||
        roots.created.length !== 1 ||
        roots.created[0]?.nodeKey !== "summarize"
      ) {
        throw new Error("The synthetic recipe root identity is invalid.");
      }

      await setStepSucceededWithOutputEvidence(
        inspection,
        claimed.value.run,
        "summarize",
        row.output_contract,
        sink
      );
      await convergenceRuntime.runExecution.transaction(
        { workspaceId: workspaceA },
        ({ dagSchedule }) =>
          dagSchedule.request(
            { workspaceId: workspaceA },
            claimed.value.run.runId
          )
      );
      const convergence = await materialize();
      if (convergence.status !== "processed") {
        throw new Error("The synthetic recipe run did not converge.");
      }
      if (
        convergence.runId !== claimed.value.run.runId ||
        convergence.outcome.status !== "success-finalized" ||
        convergence.finalized?.run.state !== "completed"
      ) {
        throw new Error("The synthetic recipe convergence is invalid.");
      }
    }
  } finally {
    await convergenceRuntime.close();
  }
};

type RecipePersistenceCounts = Readonly<{
  active_cache_count: string;
  application_count: string;
  consumed_plan_count: string;
  dag_job_count: string;
  executed_binding_count: string;
  outbox_count: string;
  pending_cell_result_count: string;
  plan_input_count: string;
  plan_source_count: string;
  queued_run_count: string;
  recipe_count: string;
  routing_job_count: string;
  run_event_count: string;
}>;

type RecipePersistenceReadback = Readonly<{
  counts: RecipePersistenceCounts;
  durableState: unknown;
}>;

const readRecipePersistence = async (
  inspection: ReturnType<typeof postgres>,
  applicationId: string
): Promise<RecipePersistenceReadback> => {
  const countRows = await inspection<readonly RecipePersistenceCounts[]>`
    WITH application_cells AS (
      SELECT cell_result_id, cache_key, run_id, run_plan_id
      FROM kurobara_core.cell_results
      WHERE workspace_id = ${workspaceA}
        AND recipe_application_id = ${applicationId}
    )
    SELECT
      (
        SELECT count(*)::text
        FROM kurobara_core.enrichment_recipes AS recipe
        JOIN kurobara_core.recipe_applications AS application
          ON application.workspace_id = recipe.workspace_id
          AND application.dataset_id = recipe.dataset_id
          AND application.enrichment_recipe_id = recipe.enrichment_recipe_id
          AND application.recipe_revision = recipe.recipe_revision
        WHERE application.workspace_id = ${workspaceA}
          AND application.recipe_application_id = ${applicationId}
      ) AS recipe_count,
      (
        SELECT count(*)::text
        FROM kurobara_core.recipe_applications
        WHERE workspace_id = ${workspaceA}
          AND recipe_application_id = ${applicationId}
      ) AS application_count,
      (
        SELECT count(*)::text
        FROM kurobara_core.run_plans AS plan
        JOIN application_cells AS cell
          ON cell.run_plan_id = plan.run_plan_id
        WHERE plan.workspace_id = ${workspaceA}
          AND plan.consumed_by IS NOT NULL
      ) AS consumed_plan_count,
      (
        SELECT count(*)::text
        FROM kurobara_core.run_plan_inputs AS input
        JOIN application_cells AS cell
          ON cell.run_plan_id = input.run_plan_id
        WHERE input.workspace_id = ${workspaceA}
      ) AS plan_input_count,
      (
        SELECT count(*)::text
        FROM kurobara_core.run_plan_sources AS source
        JOIN application_cells AS cell
          ON cell.run_plan_id = source.run_plan_id
        WHERE source.workspace_id = ${workspaceA}
      ) AS plan_source_count,
      (
        SELECT count(*)::text
        FROM kurobara_core.runs AS run
        JOIN application_cells AS cell ON cell.run_id = run.run_id
        WHERE run.workspace_id = ${workspaceA}
          AND run.run ->> 'state' = 'queued'
      ) AS queued_run_count,
      (
        SELECT count(*)::text
        FROM kurobara_core.run_events AS event
        JOIN application_cells AS cell ON cell.run_id = event.run_id
        WHERE event.workspace_id = ${workspaceA}
      ) AS run_event_count,
      (
        SELECT count(*)::text
        FROM kurobara_core.outbox_messages AS message
        JOIN application_cells AS cell ON cell.run_id = message.aggregate_id
        WHERE message.workspace_id = ${workspaceA}
      ) AS outbox_count,
      (
        SELECT count(*)::text
        FROM kurobara_core.cell_results
        WHERE workspace_id = ${workspaceA}
          AND recipe_application_id = ${applicationId}
          AND status = 'pending'
      ) AS pending_cell_result_count,
      (
        SELECT count(*)::text
        FROM kurobara_core.recipe_application_cells
        WHERE workspace_id = ${workspaceA}
          AND recipe_application_id = ${applicationId}
          AND binding = 'executed'
      ) AS executed_binding_count,
      (
        SELECT count(*)::text
        FROM kurobara_core.recipe_cell_cache AS cache
        JOIN application_cells AS cell
          ON cell.cache_key = cache.cache_key
          AND cell.cell_result_id = cache.active_cell_result_id
        WHERE cache.workspace_id = ${workspaceA}
      ) AS active_cache_count,
      (
        SELECT count(*)::text
        FROM kurobara_core.run_dag_schedule_jobs AS job
        JOIN application_cells AS cell ON cell.run_id = job.run_id
        WHERE job.workspace_id = ${workspaceA}
      ) AS dag_job_count,
      (
        SELECT count(*)::text
        FROM kurobara_core.step_routing_jobs AS job
        JOIN application_cells AS cell ON cell.run_id = job.run_id
        WHERE job.workspace_id = ${workspaceA}
      ) AS routing_job_count
  `;
  const stateRows = await inspection<readonly { durable_state: unknown }[]>`
    WITH application_cells AS (
      SELECT cell_result_id, cache_key, run_id, run_plan_id
      FROM kurobara_core.cell_results
      WHERE workspace_id = ${workspaceA}
        AND recipe_application_id = ${applicationId}
    )
    SELECT jsonb_build_object(
      'recipes', COALESCE((
        SELECT jsonb_agg(to_jsonb(recipe) ORDER BY recipe.enrichment_recipe_id)
        FROM kurobara_core.enrichment_recipes AS recipe
        JOIN kurobara_core.recipe_applications AS application
          ON application.workspace_id = recipe.workspace_id
          AND application.dataset_id = recipe.dataset_id
          AND application.enrichment_recipe_id = recipe.enrichment_recipe_id
          AND application.recipe_revision = recipe.recipe_revision
        WHERE application.workspace_id = ${workspaceA}
          AND application.recipe_application_id = ${applicationId}
      ), '[]'::jsonb),
      'applications', COALESCE((
        SELECT jsonb_agg(to_jsonb(application) ORDER BY recipe_application_id)
        FROM kurobara_core.recipe_applications AS application
        WHERE workspace_id = ${workspaceA}
          AND recipe_application_id = ${applicationId}
      ), '[]'::jsonb),
      'plans', COALESCE((
        SELECT jsonb_agg(to_jsonb(plan) ORDER BY plan.run_plan_id)
        FROM kurobara_core.run_plans AS plan
        JOIN application_cells AS cell ON cell.run_plan_id = plan.run_plan_id
        WHERE plan.workspace_id = ${workspaceA}
      ), '[]'::jsonb),
      'inputs', COALESCE((
        SELECT jsonb_agg(to_jsonb(input) ORDER BY input.input_id)
        FROM kurobara_core.run_plan_inputs AS input
        JOIN application_cells AS cell ON cell.run_plan_id = input.run_plan_id
        WHERE input.workspace_id = ${workspaceA}
      ), '[]'::jsonb),
      'sources', COALESCE((
        SELECT jsonb_agg(to_jsonb(source) ORDER BY source.run_plan_id)
        FROM kurobara_core.run_plan_sources AS source
        JOIN application_cells AS cell ON cell.run_plan_id = source.run_plan_id
        WHERE source.workspace_id = ${workspaceA}
      ), '[]'::jsonb),
      'runs', COALESCE((
        SELECT jsonb_agg(to_jsonb(run) ORDER BY run.run_id)
        FROM kurobara_core.runs AS run
        JOIN application_cells AS cell ON cell.run_id = run.run_id
        WHERE run.workspace_id = ${workspaceA}
      ), '[]'::jsonb),
      'events', COALESCE((
        SELECT jsonb_agg(to_jsonb(event) ORDER BY event.run_id, event.sequence)
        FROM kurobara_core.run_events AS event
        JOIN application_cells AS cell ON cell.run_id = event.run_id
        WHERE event.workspace_id = ${workspaceA}
      ), '[]'::jsonb),
      'outbox', COALESCE((
        SELECT jsonb_agg(to_jsonb(message) ORDER BY message.message_id)
        FROM kurobara_core.outbox_messages AS message
        JOIN application_cells AS cell ON cell.run_id = message.aggregate_id
        WHERE message.workspace_id = ${workspaceA}
      ), '[]'::jsonb),
      'cellResults', COALESCE((
        SELECT jsonb_agg(to_jsonb(result) ORDER BY result.cell_result_id)
        FROM kurobara_core.cell_results AS result
        WHERE result.workspace_id = ${workspaceA}
          AND result.recipe_application_id = ${applicationId}
      ), '[]'::jsonb),
      'bindings', COALESCE((
        SELECT jsonb_agg(to_jsonb(binding) ORDER BY binding.record_id)
        FROM kurobara_core.recipe_application_cells AS binding
        WHERE binding.workspace_id = ${workspaceA}
          AND binding.recipe_application_id = ${applicationId}
      ), '[]'::jsonb),
      'caches', COALESCE((
        SELECT jsonb_agg(to_jsonb(cache) ORDER BY cache.cache_key)
        FROM kurobara_core.recipe_cell_cache AS cache
        JOIN application_cells AS cell ON cell.cache_key = cache.cache_key
        WHERE cache.workspace_id = ${workspaceA}
      ), '[]'::jsonb),
      'dagJobs', COALESCE((
        SELECT jsonb_agg(to_jsonb(job) ORDER BY job.run_id)
        FROM kurobara_core.run_dag_schedule_jobs AS job
        JOIN application_cells AS cell ON cell.run_id = job.run_id
        WHERE job.workspace_id = ${workspaceA}
      ), '[]'::jsonb),
      'routingJobs', COALESCE((
        SELECT jsonb_agg(to_jsonb(job) ORDER BY job.run_id, job.step_run_id)
        FROM kurobara_core.step_routing_jobs AS job
        JOIN application_cells AS cell ON cell.run_id = job.run_id
        WHERE job.workspace_id = ${workspaceA}
      ), '[]'::jsonb)
    ) AS durable_state
  `;
  const counts = countRows[0];
  const durableState = stateRows[0]?.durable_state;
  if (counts === undefined || durableState === undefined) {
    throw new Error("Recipe persistence readback did not return one row.");
  }
  return { counts, durableState };
};

test("serves live probes and rejects unauthenticated traffic", async () => {
  const health = await fetch(`${baseUrl}/healthz`);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { status: "healthy" });

  const ready = await fetch(`${baseUrl}/readyz`);
  assert.equal(ready.status, 200);
  assert.deepEqual(await ready.json(), { status: "ready" });

  const missing = await fetch(`${baseUrl}/v1/plans`, {
    body: quoteBody(),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  assert.equal(missing.status, 401);
  assert.equal(await readProblemCode(missing), "authentication-required");

  const missingDiscovery = await fetch(
    `${baseUrl}/v1/capabilities?authority_envelope_id=authority-http`
  );
  assert.equal(missingDiscovery.status, 401);
  assert.equal(
    await readProblemCode(missingDiscovery),
    "authentication-required"
  );
});

test("discovers only runtime-backed capabilities under one exact authority", async () => {
  const missingAuthority = await fetch(
    `${baseUrl}/v1/capabilities?authority_envelope_id=authority-missing`,
    { headers: { authorization: `Bearer ${credentialA}` } }
  );
  assert.equal(missingAuthority.status, 403);
  assert.equal(
    await readProblemCode(missingAuthority),
    "authority-subject-mismatch"
  );

  const foreignAuthority = await fetch(
    `${baseUrl}/v1/capabilities?authority_envelope_id=authority-http`,
    { headers: { authorization: `Bearer ${credentialIntruder}` } }
  );
  assert.equal(foreignAuthority.status, 403);
  assert.equal(
    await readProblemCode(foreignAuthority),
    "authority-subject-mismatch"
  );

  const discovery = await fetch(
    `${baseUrl}/v1/capabilities?authority_envelope_id=authority-http`,
    {
      headers: {
        authorization: `Bearer ${credentialA}`,
        "x-correlation-id": "http-integration-capabilities",
      },
    }
  );
  assert.equal(discovery.status, 200);
  assert.equal(
    discovery.headers.get("x-correlation-id"),
    "http-integration-capabilities"
  );
  assert.equal(discovery.headers.get("cache-control"), "private, no-store");
  assert.deepEqual(await discovery.json(), {
    authority_envelope_id: "authority-http",
    capabilities: [
      {
        capability_id: "documents.summarize",
        capability_version: "1.0.0",
      },
      {
        capability_id: "organizations.discover",
        capability_version: "1.0.0",
      },
    ],
    workspace_id: workspaceA,
  });

  const workspaceBDiscovery = await fetch(
    `${baseUrl}/v1/capabilities?authority_envelope_id=authority-http`,
    { headers: { authorization: `Bearer ${credentialB}` } }
  );
  assert.equal(workspaceBDiscovery.status, 200);
  assert.deepEqual(await workspaceBDiscovery.json(), {
    authority_envelope_id: "authority-http",
    capabilities: [
      {
        capability_id: "documents.summarize",
        capability_version: "1.0.0",
      },
      {
        capability_id: "organizations.discover",
        capability_version: "1.0.0",
      },
    ],
    workspace_id: workspaceB,
  });

  const inspection = postgres(databaseUrl.toString(), { max: 1 });
  try {
    const rows = await inspection<
      readonly {
        outbox_count: string;
        run_count: string;
        run_event_count: string;
        run_plan_count: string;
      }[]
    >`
      SELECT
        (SELECT count(*)::text FROM kurobara_core.run_plans) AS run_plan_count,
        (SELECT count(*)::text FROM kurobara_core.runs) AS run_count,
        (SELECT count(*)::text FROM kurobara_core.run_events) AS run_event_count,
        (SELECT count(*)::text FROM kurobara_core.outbox_messages) AS outbox_count
    `;
    assert.deepEqual(rows[0], {
      outbox_count: "0",
      run_count: "0",
      run_event_count: "0",
      run_plan_count: "0",
    });
  } finally {
    await inspection.end({ timeout: 5 });
  }
});

test("plans and starts company discovery through the real PostgreSQL composition", async () => {
  const invalidQuery = await fetch(`${baseUrl}/v1/organization-discoveries`, {
    body: organizationDiscoveryBody(
      "discovery-http-invalid",
      "dataset-http-invalid"
    ).replace('"FR"', '"ZZ"'),
    headers: bearerHeaders(credentialA),
    method: "POST",
  });
  assert.equal(invalidQuery.status, 400);
  assert.equal(await readProblemCode(invalidQuery), "request-invalid");

  const unavailableSnapshot = await fetch(
    `${baseUrl}/v1/organization-discoveries`,
    {
      body: organizationDiscoveryBody(
        "discovery-http-intruder",
        "dataset-http-intruder"
      ),
      headers: bearerHeaders(credentialIntruder),
      method: "POST",
    }
  );
  assert.equal(unavailableSnapshot.status, 503);
  assert.equal(
    await readProblemCode(unavailableSnapshot),
    "service-unavailable"
  );

  const dryRun = await fetch(`${baseUrl}/v1/organization-discoveries`, {
    body: organizationDiscoveryBody(
      "discovery-http-dry-run",
      "dataset-http-company-dry-run"
    ),
    headers: bearerHeaders(credentialA),
    method: "POST",
  });
  assert.equal(dryRun.status, 200);
  const dryRunBody = (await dryRun.json()) as Readonly<{
    dataset_id: string;
    generation_plan_id: string;
    mode: string;
    state: string;
  }>;
  assert.equal(dryRunBody.dataset_id, "dataset-http-company-dry-run");
  assert.equal(dryRunBody.mode, "dry-run");
  assert.equal(dryRunBody.state, "planned");

  const inspectionRuntime = createPostgresRuntime(databaseUrl.toString());
  try {
    const storedPlan = await inspectionRuntime.datasetGenerationPlanning.get(
      { workspaceId: workspaceA },
      datasetGenerationPlanId(dryRunBody.generation_plan_id)
    );
    assert.equal(storedPlan?.plan.normalizedQuery !== undefined, true);
    assert.equal(
      storedPlan?.plan.routeSnapshots[0]?.effectAdapterKey,
      "hunter-discover"
    );
    assert.deepEqual(storedPlan?.plan.normalizedQuery, {
      country_codes: ["FR"],
      country_scope: "headquarters",
      employee_count: { maximum: 200, minimum: 11 },
      industry_codes: ["software"],
      industry_taxonomy: "kurobara-v1",
      keywords: ["platform"],
      result_kind: "company",
    });
  } finally {
    await inspectionRuntime.close();
  }

  const started = await fetch(`${baseUrl}/v1/organization-discoveries`, {
    body: organizationDiscoveryBody(
      "discovery-http-start",
      "dataset-http-company-start",
      "start"
    ),
    headers: bearerHeaders(credentialA),
    method: "POST",
  });
  assert.equal(started.status, 200);
  const startedBody = (await started.json()) as Readonly<{
    generation_id: string;
    generation_plan_id: string;
    state: string;
  }>;
  assert.equal(startedBody.state, "building");
  assert.equal(startedBody.generation_id.length > 0, true);

  const readback = await fetch(
    `${baseUrl}/v1/dataset-generations/${encodeURIComponent(startedBody.generation_id)}`,
    { headers: { authorization: `Bearer ${credentialA}` } }
  );
  assert.equal(readback.status, 200);
  assert.deepEqual(await readback.json(), {
    cost: { reserved: 0, spent: 0, unit: "credits" },
    counters: {
      accepted: 0,
      calls: 0,
      duplicates: 0,
      pages: 0,
      rejected: 0,
      returned: 0,
    },
    dataset_id: "dataset-http-company-start",
    generation_id: startedBody.generation_id,
    generation_plan_id: startedBody.generation_plan_id,
    materialization_id: "dataset-http-company-start",
    materialization_state: "building",
    record_count: 0,
    state: "planned",
    terminal: false,
    workspace_id: workspaceA,
  });

  const noCompanyRouteService = createApiService({
    config: {
      environment: "test",
      host: "127.0.0.1",
      maxAuthorizationHeaderBytes: 512,
      maxBodyBytes: 65_536,
      maxExportBytes: 1_073_741_824,
      maxExportRecordBytes: 16_777_216,
      maxImportBytes: 1_073_741_824,
      migrationMode: "verify",
      port: 0,
      shutdownTimeoutMs: 10_000,
    },
    databaseUrl: databaseUrl.toString(),
    executionRoutes: [
      {
        capability: executionCapability,
        effectAdapterKey: "deterministic-local",
        reservableUpperBound: 1,
        reservationUnit: "credits",
        routeKey: "integration-local",
      },
    ],
  });
  try {
    await noCompanyRouteService.start();
    const address = noCompanyRouteService.address();
    if (address === null) {
      throw new Error("The missing-route service did not bind an address.");
    }
    const unavailableRoute = await fetch(
      `http://127.0.0.1:${address.port}/v1/organization-discoveries`,
      {
        body: organizationDiscoveryBody(
          "discovery-http-no-route",
          "dataset-http-no-route"
        ),
        headers: bearerHeaders(credentialA),
        method: "POST",
      }
    );
    assert.equal(unavailableRoute.status, 503);
    assert.equal(
      await readProblemCode(unavailableRoute),
      "service-unavailable"
    );
  } finally {
    await noCompanyRouteService.stop("integration-test-cleanup");
  }
});

test("quotes a durable tenant-scoped plan before creating its run", async () => {
  const crossWorkspaceQuote = await fetch(`${baseUrl}/v1/plans`, {
    body: quoteBody(workspaceA),
    headers: bearerHeaders(credentialB),
    method: "POST",
  });
  assert.equal(crossWorkspaceQuote.status, 403);
  assert.equal(
    await readProblemCode(crossWorkspaceQuote),
    "workspace-mismatch"
  );

  const rejectedQuote = await fetch(`${baseUrl}/v1/plans`, {
    body: quoteBody(),
    headers: bearerHeaders(credentialIntruder),
    method: "POST",
  });
  assert.equal(rejectedQuote.status, 403);
  assert.equal(
    await readProblemCode(rejectedQuote),
    "authority-subject-mismatch"
  );

  const missingAuthorityQuote = await fetch(`${baseUrl}/v1/plans`, {
    body: quoteBody().replace("authority-http", "authority-missing"),
    headers: bearerHeaders(credentialA),
    method: "POST",
  });
  assert.equal(missingAuthorityQuote.status, 403);
  assert.equal(
    await readProblemCode(missingAuthorityQuote),
    "authority-subject-mismatch"
  );

  const unavailableWorkflow = await fetch(`${baseUrl}/v1/plans`, {
    body: quoteBody().replace(String(hash("f")), String(hash("9"))),
    headers: bearerHeaders(credentialA),
    method: "POST",
  });
  assert.equal(unavailableWorkflow.status, 422);
  assert.equal(await readProblemCode(unavailableWorkflow), "domain-rejected");

  const quoted = await fetch(`${baseUrl}/v1/plans`, {
    body: quoteBody(),
    headers: {
      ...bearerHeaders(credentialA),
      "x-correlation-id": "http-integration-quote",
    },
    method: "POST",
  });
  assert.equal(quoted.status, 200);
  assert.equal(
    quoted.headers.get("x-correlation-id"),
    "http-integration-quote"
  );
  const quotedBody = (await quoted.json()) as Record<string, unknown>;
  assert.equal("run_id" in quotedBody, false);
  assert.equal(quotedBody.workspace_id, workspaceA);
  assert.deepEqual(quotedBody.budget, {
    limit: 5,
    reserved: 0,
    spent: 0,
    unit: "credits",
  });

  const quotedRunPlanId = quotedBody.run_plan_id;
  const quotedPlanHash = quotedBody.plan_hash;
  assert.equal(typeof quotedRunPlanId, "string");
  assert.equal(typeof quotedPlanHash, "string");

  const inspection = postgres(databaseUrl.toString(), { max: 1 });
  try {
    const rows = await inspection<
      readonly {
        authority_envelope_id: string;
        outbox_count: string;
        pricing_snapshot_id: string;
        route_snapshots: unknown;
        run_count: string;
        run_event_count: string;
        source_count: string;
        workflow_spec_id: string;
      }[]
    >`
      SELECT
        source.workflow_spec_id,
        source.authority_envelope_id,
        source.pricing_snapshot_id,
        plan.plan -> 'routeSnapshots' AS route_snapshots,
        (SELECT count(*)::text FROM kurobara_core.run_plan_sources) AS source_count,
        (SELECT count(*)::text FROM kurobara_core.runs) AS run_count,
        (SELECT count(*)::text FROM kurobara_core.run_events) AS run_event_count,
        (SELECT count(*)::text FROM kurobara_core.outbox_messages) AS outbox_count
      FROM kurobara_core.run_plan_sources AS source
      JOIN kurobara_core.run_plans AS plan
        ON plan.workspace_id = source.workspace_id
       AND plan.run_plan_id = source.run_plan_id
      WHERE source.workspace_id = ${workspaceA}
        AND source.run_plan_id = ${String(quotedRunPlanId)}
    `;
    assert.equal(rows[0]?.workflow_spec_id, "workflow-http");
    assert.equal(rows[0]?.authority_envelope_id, "authority-http");
    assert.equal(rows[0]?.pricing_snapshot_id, "pricing-http");
    assert.deepEqual(rows[0]?.route_snapshots, [
      {
        capability: {
          capabilityId: "documents.summarize",
          capabilityVersion: "1.0.0",
        },
        effectAdapterKey: "deterministic-local",
        factsHash: hash("e"),
        nodeKey: "summarize",
        pricingVersion: "1.0.0",
        reservableUpperBound: 1,
        reservationUnit: "credits",
        routeKey: "integration-local",
      },
    ]);
    assert.equal(rows[0]?.source_count, "1");
    assert.equal(rows[0]?.run_count, "1");
    assert.equal(rows[0]?.run_event_count, "1");
    assert.equal(rows[0]?.outbox_count, "1");
  } finally {
    await inspection.end({ timeout: 5 });
  }

  const rejectedRun = await fetch(`${baseUrl}/v1/runs`, {
    body: createBody(String(quotedRunPlanId), String(quotedPlanHash)),
    headers: bearerHeaders(credentialIntruder),
    method: "POST",
  });
  assert.equal(rejectedRun.status, 403);
  assert.equal(
    await readProblemCode(rejectedRun),
    "authority-subject-mismatch"
  );

  const created = await fetch(`${baseUrl}/v1/runs`, {
    body: createBody(String(quotedRunPlanId), String(quotedPlanHash)),
    headers: {
      ...bearerHeaders(credentialA),
      "x-correlation-id": "http-integration-create",
    },
    method: "POST",
  });
  assert.equal(created.status, 200);
  assert.equal(
    created.headers.get("x-correlation-id"),
    "http-integration-create"
  );
  const createdBody = (await created.json()) as Record<string, unknown>;
  assert.equal(createdBody.replayed, false);
  assert.equal(createdBody.state, "queued");

  const replayed = await fetch(`${baseUrl}/v1/runs`, {
    body: createBody(String(quotedRunPlanId), String(quotedPlanHash)),
    headers: bearerHeaders(credentialA),
    method: "POST",
  });
  assert.equal(replayed.status, 200);
  assert.equal(
    Reflect.get((await replayed.json()) as object, "replayed"),
    true
  );

  const runIdValue = createdBody.run_id;
  assert.equal(typeof runIdValue, "string");
  const read = await fetch(`${baseUrl}/v1/runs/${String(runIdValue)}`, {
    headers: { authorization: `Bearer ${credentialA}` },
  });
  assert.equal(read.status, 200);
  const snapshot = (await read.json()) as Record<string, unknown>;
  assert.deepEqual(snapshot.cost, { reserved: 0, spent: 0, unit: "credits" });

  const crossWorkspace = await fetch(
    `${baseUrl}/v1/runs/${String(runIdValue)}`,
    { headers: { authorization: `Bearer ${credentialB}` } }
  );
  assert.equal(crossWorkspace.status, 404);
  assert.equal(await readProblemCode(crossWorkspace), "run-not-found");

  const workspaceBQuote = await fetch(`${baseUrl}/v1/plans`, {
    body: quoteBody(workspaceB),
    headers: bearerHeaders(credentialB),
    method: "POST",
  });
  assert.equal(workspaceBQuote.status, 200);
  assert.equal(
    Reflect.get((await workspaceBQuote.json()) as object, "workspace_id"),
    workspaceB
  );
});

test("imports a streamed dataset through the shared SDK and noninteractive CLI", async () => {
  const sdkSource = new TextEncoder().encode(
    "record_id,name\r\nrecord-sdk-1,Synthetic SDK\r\n"
  );
  const sdkMetadata = importMetadata(
    "dataset-http-sdk",
    "import-http-sdk",
    sdkSource
  );
  const client = createKurobaraClient({
    apiKey: credentialA,
    baseUrl,
  });

  const imported = await client.datasets.import({
    metadata: sdkMetadata,
    source: sourceChunks(sdkSource),
  });
  assert.deepEqual(imported, {
    batch_count: 1,
    dataset_id: "dataset-http-sdk",
    error_count: 0,
    import_id: "import-http-sdk",
    item_count: 1,
    record_count: 1,
    replayed: false,
    state: "completed",
    workspace_id: workspaceA,
  });
  const replayed = await client.datasets.import({
    metadata: sdkMetadata,
    source: sourceChunks(sdkSource),
  });
  assert.equal(replayed.replayed, true);

  const crossWorkspaceClient = createKurobaraClient({
    apiKey: credentialB,
    baseUrl,
  });
  await assert.rejects(
    crossWorkspaceClient.datasets.import({
      metadata: sdkMetadata,
      source: sourceChunks(sdkSource),
    }),
    (error: unknown) => {
      assert.ok(error instanceof KurobaraProblemError);
      assert.equal(error.problem.code, "authority-subject-mismatch");
      assert.equal(error.status, 403);
      return true;
    }
  );

  const cliSource = new TextEncoder().encode(
    "record_id,name\r\nrecord-cli-1,Synthetic CLI\r\n"
  );
  const cliMetadata = importMetadata(
    "dataset-http-cli",
    "import-http-cli",
    cliSource
  );
  const temporaryDirectory = await mkdtemp(
    path.join(tmpdir(), "kurobara-cli-import-")
  );
  try {
    const metadataFile = path.join(temporaryDirectory, "metadata.json");
    const sourceFile = path.join(temporaryDirectory, "source.csv");
    await Promise.all([
      writeFile(metadataFile, JSON.stringify(cliMetadata), { mode: 0o600 }),
      writeFile(sourceFile, cliSource, { mode: 0o600 }),
    ]);
    const firstCliRun = await runCliImport(metadataFile, sourceFile);
    assert.equal(firstCliRun.stderr, "");
    assert.deepEqual(JSON.parse(firstCliRun.stdout), {
      batch_count: 1,
      dataset_id: "dataset-http-cli",
      error_count: 0,
      import_id: "import-http-cli",
      item_count: 1,
      record_count: 1,
      replayed: false,
      state: "completed",
      workspace_id: workspaceA,
    });
    const secondCliRun = await runCliImport(metadataFile, sourceFile);
    assert.equal(secondCliRun.stderr, "");
    assert.equal(
      Reflect.get(JSON.parse(secondCliRun.stdout) as object, "replayed"),
      true
    );
  } finally {
    await rm(temporaryDirectory, { force: true, recursive: true });
  }

  const inspection = postgres(databaseUrl.toString(), { max: 1 });
  try {
    const rows = await inspection<
      readonly {
        dataset_count: string;
        import_count: string;
        record_count: string;
      }[]
    >`
      SELECT
        (SELECT count(*)::text FROM kurobara_core.datasets
          WHERE workspace_id = ${workspaceA}) AS dataset_count,
        (SELECT count(*)::text FROM kurobara_core.dataset_imports
          WHERE workspace_id = ${workspaceA}
            AND state = 'completed') AS import_count,
        (SELECT count(*)::text FROM kurobara_core.dataset_records
          WHERE workspace_id = ${workspaceA}) AS record_count
    `;
    assert.deepEqual(rows[0], {
      dataset_count: "3",
      import_count: "2",
      record_count: "2",
    });
  } finally {
    await inspection.end({ timeout: 5 });
  }
});

test("applies, converges, and exports a recipe over HTTP, SDK, and CLI", async () => {
  const recipeSource = new TextEncoder().encode(
    [
      "record_id,source,target",
      "record-recipe-1,Synthetic one,",
      "record-recipe-2,Synthetic two,",
      "",
    ].join("\r\n")
  );
  const recipeMetadata: DatasetImportMetadata = {
    batch_limits: { max_bytes: 4096, max_items: 10 },
    dataset: {
      dataset_id: recipeDatasetId,
      name: "Synthetic recipe application dataset",
      workspace_id: workspaceA,
    },
    fields: [
      {
        dataset_id: recipeDatasetId,
        field_id: "field-source",
        key: "source",
        label: "Source",
        value_type: "string",
        workspace_id: workspaceA,
      },
      {
        dataset_id: recipeDatasetId,
        field_id: "field-target",
        key: "target",
        label: "Target",
        value_type: "string",
        workspace_id: workspaceA,
      },
    ],
    format: "csv",
    import_id: "import-http-recipe",
    max_record_bytes: 2048,
    source_content_hash: sourceHash(recipeSource),
  };
  const client = createKurobaraClient({ apiKey: credentialA, baseUrl });
  const imported = await client.datasets.import({
    metadata: recipeMetadata,
    source: sourceChunks(recipeSource),
  });
  assert.deepEqual(imported, {
    batch_count: 1,
    dataset_id: recipeDatasetId,
    error_count: 0,
    import_id: "import-http-recipe",
    item_count: 2,
    record_count: 2,
    replayed: false,
    state: "completed",
    workspace_id: workspaceA,
  });

  const recipeRequest: RecipeApplyRequest = {
    application_id: recipeApplicationId,
    authority_envelope_id: "authority-http",
    cell_budget: { limit: 5, unit: "credits" },
    deadline_ms: Date.now() + 300_000,
    max_cells: 2,
    recipe: {
      dataset_id: recipeDatasetId,
      input_field_ids: ["field-source"],
      name: "Copy synthetic source into a target cell",
      recipe_id: recipeId,
      recipe_revision: "1",
      target_field_id: "field-target",
      workflow_content_hash: hash("f"),
      workflow_revision: "1.0.0",
      workflow_spec_id: "workflow-http",
      workspace_id: workspaceA,
    },
  };

  const workspaceMismatch = await fetch(`${baseUrl}/v1/recipe-applications`, {
    body: JSON.stringify(recipeRequest),
    headers: bearerHeaders(credentialB),
    method: "POST",
  });
  assert.equal(workspaceMismatch.status, 403);
  const workspaceProblem = (await workspaceMismatch.json()) as Record<
    string,
    unknown
  >;
  assert.equal(workspaceProblem.code, "workspace-mismatch");
  assert.equal(
    workspaceProblem.detail,
    "The requested operation is not authorized."
  );
  assert.equal(JSON.stringify(workspaceProblem).includes(workspaceA), false);

  const created = await fetch(`${baseUrl}/v1/recipe-applications`, {
    body: JSON.stringify(recipeRequest),
    headers: bearerHeaders(credentialA),
    method: "POST",
  });
  const createdBody = await created.json();
  assert.equal(created.status, 200, JSON.stringify(createdBody));
  assert.deepEqual(createdBody, {
    active_cell_count: 0,
    application_id: recipeApplicationId,
    application_replayed: false,
    bound_cell_count: 0,
    cached_cell_count: 0,
    created_run_count: 2,
    dataset_id: recipeDatasetId,
    recipe_id: recipeId,
    recipe_replayed: false,
    recipe_revision: "1",
    total_cell_count: 2,
    workspace_id: workspaceA,
  });

  const expectedWatch = {
    application_id: recipeApplicationId,
    bound_cell_count: 2,
    dataset_id: recipeDatasetId,
    failed_cell_count: 0,
    pending_cell_count: 2,
    recipe_id: recipeId,
    recipe_revision: "1",
    running_cell_count: 0,
    skipped_cell_count: 0,
    state: "running",
    succeeded_cell_count: 0,
    terminal: false,
    total_cell_count: 2,
    unbound_cell_count: 0,
    workspace_id: workspaceA,
  } as const;
  const watched = await fetch(
    `${baseUrl}/v1/recipe-applications/${recipeApplicationId}`,
    { headers: bearerHeaders(credentialA) }
  );
  assert.equal(watched.status, 200);
  assert.equal(watched.headers.get("cache-control"), "private, no-store");
  assert.deepEqual(await watched.json(), expectedWatch);
  assert.deepEqual(
    await client.recipeApplications.get({
      application_id: recipeApplicationId,
    }),
    expectedWatch
  );
  const cliWatch = await runCliRecipeWatch(recipeApplicationId);
  assert.equal(cliWatch.stderr, "");
  assert.deepEqual(JSON.parse(cliWatch.stdout), expectedWatch);

  const hiddenWatch = await fetch(
    `${baseUrl}/v1/recipe-applications/${recipeApplicationId}`,
    { headers: bearerHeaders(credentialB) }
  );
  assert.equal(hiddenWatch.status, 404);
  assert.equal(
    await readProblemCode(hiddenWatch),
    "recipe-application-not-found"
  );

  const inspection = postgres(databaseUrl.toString(), { max: 1 });
  try {
    const createdPersistence = await readRecipePersistence(
      inspection,
      recipeApplicationId
    );
    assert.deepEqual(createdPersistence.counts, {
      active_cache_count: "2",
      application_count: "1",
      consumed_plan_count: "2",
      dag_job_count: "0",
      executed_binding_count: "2",
      outbox_count: "2",
      pending_cell_result_count: "2",
      plan_input_count: "2",
      plan_source_count: "2",
      queued_run_count: "2",
      recipe_count: "1",
      routing_job_count: "0",
      run_event_count: "2",
    });

    const sdkReplay = await client.recipes.apply(recipeRequest);
    assert.deepEqual(sdkReplay, {
      active_cell_count: 0,
      application_id: recipeApplicationId,
      application_replayed: true,
      bound_cell_count: 2,
      cached_cell_count: 0,
      created_run_count: 0,
      dataset_id: recipeDatasetId,
      recipe_id: recipeId,
      recipe_replayed: true,
      recipe_revision: "1",
      total_cell_count: 2,
      workspace_id: workspaceA,
    });
    assert.deepEqual(
      await readRecipePersistence(inspection, recipeApplicationId),
      createdPersistence
    );

    const temporaryDirectory = await mkdtemp(
      path.join(tmpdir(), "kurobara-cli-recipe-")
    );
    try {
      const requestFile = path.join(temporaryDirectory, "request.json");
      await writeFile(requestFile, JSON.stringify(recipeRequest), {
        mode: 0o600,
      });
      const cliReplay = await runCliRecipeApply(requestFile);
      assert.equal(cliReplay.stderr, "");
      assert.deepEqual(JSON.parse(cliReplay.stdout), sdkReplay);
    } finally {
      await rm(temporaryDirectory, { force: true, recursive: true });
    }
    assert.deepEqual(
      await readRecipePersistence(inspection, recipeApplicationId),
      createdPersistence
    );

    const conflicting = await fetch(`${baseUrl}/v1/recipe-applications`, {
      body: JSON.stringify({ ...recipeRequest, max_cells: 3 }),
      headers: bearerHeaders(credentialA),
      method: "POST",
    });
    assert.equal(conflicting.status, 409);
    assert.equal(await readProblemCode(conflicting), "idempotency-key-reused");
    assert.deepEqual(
      await readRecipePersistence(inspection, recipeApplicationId),
      createdPersistence
    );

    await convergeRecipeApplicationFixture(inspection);
    const terminalRows = await inspection<
      readonly {
        cell_result: Record<string, unknown>;
        record_id: string;
        status: string;
        value: unknown;
      }[]
    >`
      SELECT record_id, status, value, cell_result
      FROM kurobara_core.cell_results
      WHERE workspace_id = ${workspaceA}
        AND recipe_application_id = ${recipeApplicationId}
      ORDER BY record_id
    `;
    assert.equal(terminalRows.length, 2);
    for (const [index, row] of terminalRows.entries()) {
      const expectedValue = index === 0 ? "Synthetic enriched" : null;
      assert.equal(row.status, "succeeded");
      assert.equal(row.value, expectedValue);
      assert.deepEqual(Object.keys(row.cell_result).sort(), [
        "cellResultId",
        "cost",
        "datasetId",
        "enrichmentRecipeId",
        "fieldId",
        "recipeRevision",
        "recordId",
        "runId",
        "status",
        "value",
        "workspaceId",
      ]);
      assert.equal(row.cell_result.status, "succeeded");
      assert.equal(row.cell_result.value, expectedValue);
    }

    const exportRequest = {
      application_id: recipeApplicationId,
      field_ids: ["field-target", "field-source"],
      format: "jsonl",
    } as const;
    const expectedJsonl = [
      JSON.stringify({
        dataset_id: recipeDatasetId,
        record_id: "record-recipe-1",
        values: [
          { field_id: "field-target", value: "Synthetic enriched" },
          { field_id: "field-source", value: "Synthetic one" },
        ],
        workspace_id: workspaceA,
      }),
      JSON.stringify({
        dataset_id: recipeDatasetId,
        record_id: "record-recipe-2",
        values: [
          { field_id: "field-target", value: null },
          { field_id: "field-source", value: "Synthetic two" },
        ],
        workspace_id: workspaceA,
      }),
      "",
    ].join("\n");
    const expectedJsonlBytes = new TextEncoder().encode(expectedJsonl);
    const firstExport = await client.recipeApplications.export(exportRequest);
    assert.equal(firstExport.contentType, "application/x-ndjson");
    assert.equal(firstExport.filename, "kurobara-recipe-application.jsonl");
    assert.equal(firstExport.contentLength, expectedJsonlBytes.byteLength);
    assert.equal(firstExport.contentSha256, sourceHash(expectedJsonlBytes));
    const firstBytes = await collectBytes(firstExport.bytes);
    assert.deepEqual(firstBytes, expectedJsonlBytes);
    assert.equal(firstExport.contentLength, firstBytes.byteLength);
    assert.equal(firstExport.contentSha256, sourceHash(firstBytes));

    const replayedExport =
      await client.recipeApplications.export(exportRequest);
    const replayedBytes = await collectBytes(replayedExport.bytes);
    assert.equal(replayedExport.contentLength, firstExport.contentLength);
    assert.equal(replayedExport.contentSha256, firstExport.contentSha256);
    assert.deepEqual(replayedBytes, firstBytes);

    const missingClient = createKurobaraClient({
      apiKey: credentialA,
      baseUrl,
    });
    const foreignClient = createKurobaraClient({
      apiKey: credentialB,
      baseUrl,
    });
    const problemSummaries: Record<string, unknown>[] = [];
    for (const [candidate, applicationId] of [
      [missingClient, "recipe-application-absent"],
      [foreignClient, recipeApplicationId],
    ] as const) {
      await assert.rejects(
        candidate.recipeApplications.export({
          application_id: applicationId,
          format: "jsonl",
        }),
        (error: unknown) => {
          assert.ok(error instanceof KurobaraProblemError);
          problemSummaries.push({
            code: error.problem.code,
            detail: error.problem.detail,
            status: error.status,
            title: error.problem.title,
          });
          return true;
        }
      );
    }
    assert.equal(problemSummaries.length, 2);
    assert.deepEqual(problemSummaries[0], problemSummaries[1]);
    assert.deepEqual(problemSummaries[0], {
      code: "recipe-application-not-found",
      detail: "The recipe application was not found.",
      status: 404,
      title: "Recipe application not found",
    });

    const expectedCsvBytes = new TextEncoder().encode(
      [
        "record_id,target,source",
        "record-recipe-1,Synthetic enriched,Synthetic one",
        "record-recipe-2,,Synthetic two",
        "",
      ].join("\r\n")
    );
    const exportDirectory = await mkdtemp(
      path.join(tmpdir(), "kurobara-cli-export-")
    );
    try {
      const firstOutput = path.join(exportDirectory, "application.csv");
      const secondOutput = path.join(exportDirectory, "application-replay.csv");
      const firstCliExport = await runCliRecipeExport(
        recipeApplicationId,
        firstOutput
      );
      assert.equal(firstCliExport.stderr, "");
      assert.deepEqual(JSON.parse(firstCliExport.stdout), {
        application_id: recipeApplicationId,
        byte_count: expectedCsvBytes.byteLength,
        format: "csv",
        sha256: sourceHash(expectedCsvBytes),
      });
      assert.deepEqual(
        new Uint8Array(await readFile(firstOutput)),
        expectedCsvBytes
      );
      assert.equal((await stat(firstOutput)).mode % 0o1000, 0o600);

      await assert.rejects(
        runCliRecipeExport(recipeApplicationId, firstOutput),
        CLI_RECIPE_EXPORT_FAILURE
      );
      assert.deepEqual(
        new Uint8Array(await readFile(firstOutput)),
        expectedCsvBytes
      );

      const replayedCliExport = await runCliRecipeExport(
        recipeApplicationId,
        secondOutput
      );
      assert.equal(replayedCliExport.stderr, "");
      assert.deepEqual(
        JSON.parse(replayedCliExport.stdout),
        JSON.parse(firstCliExport.stdout)
      );
      assert.deepEqual(
        new Uint8Array(await readFile(secondOutput)),
        expectedCsvBytes
      );
      assert.equal((await stat(secondOutput)).mode % 0o1000, 0o600);
    } finally {
      await rm(exportDirectory, { force: true, recursive: true });
    }
  } finally {
    await inspection.end({ timeout: 5 });
  }
});

test("forces a bounded shutdown when an HTTP request remains active", async () => {
  const address = service?.address();
  if (address === null || address === undefined) {
    throw new Error("The HTTP integration service is not listening.");
  }
  const socket = createConnection({ host: "127.0.0.1", port: address.port });
  socket.on("error", () => undefined);
  await once(socket, "connect");
  const closed = once(socket, "close");
  socket.write(
    [
      "POST /v1/runs HTTP/1.1",
      "Host: 127.0.0.1",
      `Authorization: Bearer ${credentialA}`,
      "Content-Type: application/json",
      "Content-Length: 1000",
      "Connection: keep-alive",
      "",
      "{",
    ].join("\r\n")
  );

  await new Promise((resolve) => setTimeout(resolve, 10));
  await assert.rejects(
    lifecycle.stop("blocked-request-test"),
    FORCED_SHUTDOWN_TIMEOUT
  );
  await closed;
  assert.equal(lifecycle.health().status, "unhealthy");
  assert.equal(service?.address(), null);
});
