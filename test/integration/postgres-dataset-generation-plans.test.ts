import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";

import {
  createCsvDatasetCodec,
  createJsonlDatasetCodec,
} from "@kurobara/adapter-dataset-codec";
import { createPostgresRuntime } from "@kurobara/adapter-postgres";
import {
  makeCreateDatasetGeneration,
  makeImportDataset,
  makePlanDatasetGeneration,
  type PlanDatasetGenerationDependencies,
  type PlanDatasetGenerationRequest,
} from "@kurobara/application";
import {
  actorId,
  capabilityId,
  contentHash,
  datasetGenerationId,
  datasetGenerationPlanId,
  datasetId,
  fieldId,
  idempotencyKey,
  instant,
  type WorkspaceId,
  workspaceId,
} from "@kurobara/kernel";
import postgres from "postgres";

const adminUrl = process.env.KUROBARA_TEST_POSTGRES_URL;
if (adminUrl === undefined || adminUrl.trim().length === 0) {
  throw new Error(
    "KUROBARA_TEST_POSTGRES_URL must target a disposable-capable PostgreSQL admin database."
  );
}

const migrationsUrl = new URL(
  "../../packages/adapters/postgres/migrations/",
  import.meta.url
);
const PRE_GENERATION_PLAN_MIGRATION_PATTERN =
  /^(?:000[1-9]|001[0-9])_[a-z0-9_]+\.sql$/u;
const IMMUTABLE_PLAN = /dataset generation plans are immutable/u;

const hash = (character: string) =>
  contentHash(`sha256:${character.repeat(64).slice(0, 64)}`);

const capability = {
  capabilityId: capabilityId(" organizations.discover "),
  capabilityVersion: " 1.0.0 ",
} as const;
const budgetUnit = " credits ";
const now = instant(1_800_000_000_000);
const deadline = instant(now + 60_000);
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

const generationRequest = (
  workspace: WorkspaceId,
  query: PlanDatasetGenerationRequest["query"] = {
    country: "es",
    industry: "software",
  },
  targetDatasetIdentity = "dataset-generation-target",
  requestIdempotencyKey = "generation-plan-create-shared"
): PlanDatasetGenerationRequest => ({
  actorId: actorId("actor-generation"),
  authorityEnvelopeId: "authority-generation",
  capability,
  fields: [
    {
      datasetId: datasetId(targetDatasetIdentity),
      fieldId: fieldId("field-company-name"),
      key: "company_name",
      label: "Company name",
      valueType: "string",
      workspaceId: workspace,
    },
  ],
  idempotencyKey: idempotencyKey(requestIdempotencyKey),
  limits,
  query,
  requestedBudget: { limit: 10, unit: budgetUnit },
  requestedDeadline: deadline,
  targetDataset: {
    datasetId: datasetId(targetDatasetIdentity),
    name: "Synthetic companies",
    workspaceId: workspace,
  },
  unknownCostPolicy: { mode: "deny" },
  workspaceId: workspace,
});

const generationDependencies = (
  runtime: ReturnType<typeof createPostgresRuntime>,
  identifierCalls: { value: number }
): PlanDatasetGenerationDependencies => ({
  clock: { now: () => Promise.resolve(now) },
  identifiers: {
    nextDatasetGenerationPlanId: () => {
      identifierCalls.value += 1;
      return Promise.resolve(
        datasetGenerationPlanId(`generation-plan-${identifierCalls.value}`)
      );
    },
  },
  normalizer: {
    normalize: (input) => ({
      capability: input.capability,
      contract: {
        catalogFingerprint: hash("a"),
        catalogVersion: "catalog-1",
        schemaFingerprint: hash("b"),
        schemaId: "organizations.discover.query",
        schemaVersion: "1.0.0",
      },
      normalizerVersion: "normalizer-1",
      status: "accepted",
      value: { country: "ES", industry: "software" },
    }),
  },
  persistence: runtime.datasetGenerationPlanning,
  snapshots: {
    resolve: (input) =>
      Promise.resolve({
        authority: {
          authorityEnvelopeId: input.authorityEnvelopeId,
          budgetLimit: {
            limit: 10,
            reserved: 0,
            spent: 0,
            unit: budgetUnit,
          },
          capabilities: [capability],
          deadline,
          permissions: ["datasets:generate", "steps:execute"],
          subjectActorId: input.actorId,
          version: "1.0.0",
          workspaceId: input.workspaceId,
        },
        budget: { limit: 10, reserved: 0, spent: 0, unit: budgetUnit },
        deadline,
        policy: {
          factsHash: hash("c"),
          requiredPermission: "datasets:generate",
          version: "policy-1",
        },
        quote: {
          expiresAt: instant(deadline + 60_000),
          guarantee: "hard",
          pricingVersion: "pricing-1",
          quoteId: "quote-1",
          unit: budgetUnit,
          upperBound: 2,
        },
        routeSnapshots: [
          {
            capability,
            effectAdapterKey: "synthetic-organizations",
            factsHash: hash("c"),
            pricingVersion: "pricing-1",
            reservableUpperBound: 2,
            reservationUnit: budgetUnit,
            routeKey: "synthetic-primary",
          },
        ],
        unknownCostPolicy: input.requestedUnknownCostPolicy,
      }),
  },
});

test("rolls populated 0019 storage into no-effect dataset generations", async () => {
  const databaseName = `kurobara_generation_plan_${process.pid}_${Date.now()}`;
  const databaseUrl = new URL(adminUrl);
  databaseUrl.pathname = `/${databaseName}`;
  const admin = postgres(adminUrl, { max: 1 });
  let sql: ReturnType<typeof postgres> | undefined;
  let runtime: ReturnType<typeof createPostgresRuntime> | undefined;

  try {
    await admin`CREATE DATABASE ${admin(databaseName)}`;
    sql = postgres(databaseUrl.toString(), { max: 2 });
    await sql`CREATE SCHEMA IF NOT EXISTS kurobara_core`;
    await sql`
      CREATE TABLE kurobara_core.schema_migrations (
        migration_name text PRIMARY KEY,
        checksum text NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT clock_timestamp()
      )
    `;

    const migrationNames = (await readdir(migrationsUrl))
      .filter((name) => PRE_GENERATION_PLAN_MIGRATION_PATTERN.test(name))
      .sort();
    assert.equal(migrationNames.at(-1), "0019_enrichment_recipe_storage.sql");
    assert.equal(migrationNames.length, 19);
    for (const migrationName of migrationNames) {
      const content = await readFile(
        new URL(migrationName, migrationsUrl),
        "utf8"
      );
      const checksum = createHash("sha256").update(content).digest("hex");
      await sql.unsafe(content);
      await sql`
        INSERT INTO kurobara_core.schema_migrations (
          migration_name,
          checksum
        ) VALUES (${migrationName}, ${checksum})
      `;
    }

    await sql`
      INSERT INTO kurobara_core.workspaces (workspace_id)
      VALUES ('workspace-generation-a'), ('workspace-generation-b')
    `;
    const legacyDataset = {
      datasetId: "dataset-import-preserved",
      name: "Synthetic preserved import",
      workspaceId: "workspace-generation-a",
    };
    await sql`
      INSERT INTO kurobara_core.datasets (
        workspace_id,
        dataset_id,
        name,
        schema_hash,
        dataset
      ) VALUES (
        'workspace-generation-a',
        'dataset-import-preserved',
        'Synthetic preserved import',
        ${hash("e")},
        ${sql.json(legacyDataset)}
      )
    `;
    await sql`
      INSERT INTO kurobara_core.dataset_imports (
        workspace_id,
        import_id,
        dataset_id,
        schema_hash,
        intent_hash,
        source_content_hash,
        format,
        codec_version,
        max_record_bytes,
        max_batch_items,
        max_batch_bytes
      ) VALUES (
        'workspace-generation-a',
        'import-preserved',
        'dataset-import-preserved',
        ${hash("e")},
        ${hash("f")},
        ${hash("9")},
        'jsonl',
        '1.0.0',
        1024,
        10,
        16384
      )
    `;

    runtime = createPostgresRuntime(databaseUrl.toString());
    await runtime.migrate();
    await runtime.verifyMigrations();

    const migrated = await sql<
      readonly {
        dataset: unknown;
        generation_plan_count: string;
        import_intent_hash: string;
        migration_count: string;
        migration_name: string;
      }[]
    >`
      SELECT
        dataset.dataset,
        (
          SELECT count(*)::text
          FROM kurobara_core.dataset_generation_plans
        ) AS generation_plan_count,
        dataset_import.intent_hash AS import_intent_hash,
        (
          SELECT count(*)::text
          FROM kurobara_core.schema_migrations
        ) AS migration_count,
        (
          SELECT migration_name
          FROM kurobara_core.schema_migrations
          ORDER BY migration_name DESC
          LIMIT 1
        ) AS migration_name
      FROM kurobara_core.datasets AS dataset
      JOIN kurobara_core.dataset_imports AS dataset_import
        ON dataset_import.workspace_id = dataset.workspace_id
        AND dataset_import.dataset_id = dataset.dataset_id
      WHERE dataset.workspace_id = 'workspace-generation-a'
        AND dataset.dataset_id = 'dataset-import-preserved'
    `;
    assert.deepEqual(migrated[0], {
      dataset: legacyDataset,
      generation_plan_count: "0",
      import_intent_hash: hash("f"),
      migration_count: "31",
      migration_name: "0031_gtm_context_play_workbook.sql",
    });

    const workspaceA = workspaceId("workspace-generation-a");
    const workspaceB = workspaceId("workspace-generation-b");
    await assert.rejects(
      sql`
        INSERT INTO kurobara_core.dataset_generation_plans (
          workspace_id,
          generation_plan_id,
          idempotency_key,
          target_dataset_id,
          query_hash,
          schema_hash,
          request_intent_hash,
          plan_hash,
          payload
        ) VALUES (
          ${workspaceA},
          'generation-plan-malformed',
          'generation-plan-malformed',
          'dataset-generation-target',
          ${hash("1")},
          ${hash("2")},
          ${hash("3")},
          ${hash("4")},
          ${sql.json({
            idempotencyKey: "generation-plan-malformed",
            plan: {},
            requestIntentHash: hash("3"),
          })}
        )
      `,
      (error: unknown) =>
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "23514"
    );
    const identifierCalls = { value: 0 };
    const plan = makePlanDatasetGeneration(
      generationDependencies(runtime, identifierCalls)
    );
    const [left, right] = await Promise.all([
      plan(generationRequest(workspaceA)),
      plan(generationRequest(workspaceA)),
    ]);
    assert.equal(left.ok, true);
    assert.equal(right.ok, true);
    if (!(left.ok && right.ok)) {
      return;
    }
    assert.equal(identifierCalls.value, 1);
    assert.deepEqual(left.value.plan, right.value.plan);
    assert.deepEqual([left.value.replayed, right.value.replayed].sort(), [
      false,
      true,
    ]);

    const generationIdentifierCalls = { value: 0 };
    const createGeneration = makeCreateDatasetGeneration({
      clock: { now: () => Promise.resolve(now) },
      identifiers: {
        nextDatasetGenerationId: () => {
          generationIdentifierCalls.value += 1;
          return Promise.resolve(
            datasetGenerationId(`generation-${generationIdentifierCalls.value}`)
          );
        },
      },
      persistence: runtime.datasetGeneration,
    });
    const generationRequestInput = {
      generationPlanId: left.value.plan.generationPlanId,
      workspaceId: workspaceA,
    } as const;
    const [generationLeft, generationRight] = await Promise.all([
      createGeneration(generationRequestInput),
      createGeneration(generationRequestInput),
    ]);
    assert.equal(generationLeft.ok, true);
    assert.equal(generationRight.ok, true);
    if (!(generationLeft.ok && generationRight.ok)) {
      return;
    }
    assert.deepEqual(
      generationLeft.value.creation,
      generationRight.value.creation
    );
    assert.deepEqual(
      [generationLeft.value.replayed, generationRight.value.replayed].sort(),
      [false, true]
    );
    assert.equal(generationIdentifierCalls.value, 1);
    assert.deepEqual(
      await runtime.datasetGeneration.get(
        { workspaceId: workspaceA },
        generationLeft.value.creation.generation.generationId
      ),
      generationLeft.value.creation
    );
    assert.equal(
      await runtime.datasetGeneration.get(
        { workspaceId: workspaceB },
        generationLeft.value.creation.generation.generationId
      ),
      undefined
    );
    const generatedDataset = await runtime.datasets.getDataset(
      { workspaceId: workspaceA },
      left.value.plan.requestIntent.targetDataset.datasetId
    );
    assert.deepEqual(generatedDataset, {
      dataset: left.value.plan.requestIntent.targetDataset,
      fields: left.value.plan.requestIntent.fields,
      materialization: generationLeft.value.creation.materialization,
    });
    assert.equal(
      await runtime.datasets.isFieldSetComplete(
        { workspaceId: workspaceA },
        left.value.plan.requestIntent.targetDataset.datasetId,
        [left.value.plan.requestIntent.fields[0]?.fieldId].filter(
          (value) => value !== undefined
        )
      ),
      false
    );
    const noEffectState = await sql<
      readonly {
        cost_reservation_count: string;
        generation_count: string;
        import_count: string;
        outbox_count: string;
        run_count: string;
        usage_count: string;
      }[]
    >`
      SELECT
        (SELECT count(*)::text FROM kurobara_core.dataset_generations)
          AS generation_count,
        (SELECT count(*)::text FROM kurobara_core.dataset_imports
          WHERE dataset_id = 'dataset-generation-target') AS import_count,
        (SELECT count(*)::text FROM kurobara_core.runs) AS run_count,
        (SELECT count(*)::text FROM kurobara_core.outbox_messages)
          AS outbox_count,
        (SELECT count(*)::text FROM kurobara_core.cost_reservations)
          AS cost_reservation_count,
        (SELECT count(*)::text FROM kurobara_core.usage_ledger_entries)
          AS usage_count
    `;
    assert.deepEqual(noEffectState[0], {
      cost_reservation_count: "0",
      generation_count: "1",
      import_count: "0",
      outbox_count: "0",
      run_count: "0",
      usage_count: "0",
    });
    const reconstructedRuntime = createPostgresRuntime(databaseUrl.toString());
    const reconstructedCreate = makeCreateDatasetGeneration({
      clock: {
        now: () => {
          throw new Error("A durable replay must not allocate time.");
        },
      },
      identifiers: {
        nextDatasetGenerationId: () => {
          throw new Error("A durable replay must not allocate an identity.");
        },
      },
      persistence: reconstructedRuntime.datasetGeneration,
    });
    try {
      assert.deepEqual(
        await reconstructedRuntime.datasetGeneration.get(
          { workspaceId: workspaceA },
          generationLeft.value.creation.generation.generationId
        ),
        generationLeft.value.creation
      );
      const restartedReplay = await reconstructedCreate(generationRequestInput);
      assert.equal(restartedReplay.ok, true);
      if (!restartedReplay.ok) {
        return;
      }
      assert.equal(restartedReplay.value.replayed, true);
      assert.deepEqual(
        restartedReplay.value.creation,
        generationLeft.value.creation
      );
    } finally {
      await reconstructedRuntime.close();
    }
    const importGeneratedDataset = makeImportDataset({
      codecs: {
        csv: createCsvDatasetCodec(),
        jsonl: createJsonlDatasetCodec(),
      },
      datasets: runtime.datasets,
      requiredPermission: "datasets:import",
    });
    const generatedImportConflict = await importGeneratedDataset({
      actor: {
        actorId: actorId("actor-generation-import"),
        authenticationMode: "api-key",
        credentialId: "credential-generation-import",
        permissions: ["datasets:import"],
        workspaceId: workspaceA,
      },
      batchLimits: { maxBytes: 1024, maxItems: 1 },
      bytes: {
        async *[Symbol.asyncIterator]() {
          await Promise.resolve();
          yield* [];
        },
      },
      dataset: left.value.plan.requestIntent.targetDataset,
      fields: left.value.plan.requestIntent.fields,
      format: "jsonl",
      importId: "import-generation-target",
      maxRecordBytes: 1024,
      sourceContentHash: `sha256:${createHash("sha256").digest("hex")}`,
    });
    assert.equal(generatedImportConflict.ok, false);
    if (!generatedImportConflict.ok) {
      assert.equal(
        generatedImportConflict.error.code,
        "dataset-import-conflict"
      );
    }

    const beforeCollision = await sql<readonly { count: string }[]>`
      SELECT count(*)::text AS count
      FROM kurobara_core.dataset_generation_plans
      WHERE workspace_id = ${workspaceA}
    `;
    const collision = await plan(
      generationRequest(workspaceA, {
        country: "fr",
        industry: "software",
      })
    );
    assert.equal(collision.ok, false);
    if (!collision.ok) {
      assert.equal(collision.error.code, "idempotency-key-reused");
    }
    const afterCollision = await sql<readonly { count: string }[]>`
      SELECT count(*)::text AS count
      FROM kurobara_core.dataset_generation_plans
      WHERE workspace_id = ${workspaceA}
    `;
    assert.deepEqual(afterCollision, beforeCollision);
    assert.equal(identifierCalls.value, 1);

    const otherWorkspace = await plan(generationRequest(workspaceB));
    assert.equal(otherWorkspace.ok, true);
    if (!otherWorkspace.ok) {
      return;
    }
    assert.equal(identifierCalls.value, 2);
    assert.equal(
      await runtime.datasetGenerationPlanning.get(
        { workspaceId: workspaceB },
        left.value.plan.generationPlanId
      ),
      undefined
    );
    assert.deepEqual(
      await runtime.datasetGenerationPlanning.get(
        { workspaceId: workspaceA },
        left.value.plan.generationPlanId
      ),
      {
        idempotencyKey: left.value.plan.idempotencyKey,
        plan: left.value.plan,
        requestIntentHash: left.value.plan.requestIntentHash,
      }
    );

    const scoped = await sql<
      readonly { plan_count: string; workspace_id: string }[]
    >`
      SELECT workspace_id, count(*)::text AS plan_count
      FROM kurobara_core.dataset_generation_plans
      GROUP BY workspace_id
      ORDER BY workspace_id
    `;
    assert.deepEqual(
      [...scoped],
      [
        { plan_count: "1", workspace_id: "workspace-generation-a" },
        { plan_count: "1", workspace_id: "workspace-generation-b" },
      ]
    );

    const importedTargetPlan = await plan(
      generationRequest(
        workspaceA,
        { country: "de", industry: "software" },
        "dataset-import-preserved",
        "generation-plan-imported-target"
      )
    );
    assert.equal(importedTargetPlan.ok, true);
    if (!importedTargetPlan.ok) {
      return;
    }
    const importedTargetConflict = await createGeneration({
      generationPlanId: importedTargetPlan.value.plan.generationPlanId,
      workspaceId: workspaceA,
    });
    assert.equal(importedTargetConflict.ok, false);
    if (!importedTargetConflict.ok) {
      assert.equal(
        importedTargetConflict.error.code,
        "target-dataset-conflict"
      );
    }
    assert.equal(generationIdentifierCalls.value, 1);

    const racePlan = await plan(
      generationRequest(
        workspaceA,
        { country: "it", industry: "software" },
        "dataset-import-generation-race",
        "generation-plan-import-race"
      )
    );
    assert.equal(racePlan.ok, true);
    if (!racePlan.ok) {
      return;
    }
    const raceIdentifierCalls = { value: 0 };
    const createRaceGeneration = makeCreateDatasetGeneration({
      clock: { now: () => Promise.resolve(now) },
      identifiers: {
        nextDatasetGenerationId: () => {
          raceIdentifierCalls.value += 1;
          return Promise.resolve(datasetGenerationId("generation-race"));
        },
      },
      persistence: runtime.datasetGeneration,
    });
    const [raceGeneration, raceImport] = await Promise.all([
      createRaceGeneration({
        generationPlanId: racePlan.value.plan.generationPlanId,
        workspaceId: workspaceA,
      }),
      importGeneratedDataset({
        actor: {
          actorId: actorId("actor-generation-race"),
          authenticationMode: "api-key",
          credentialId: "credential-generation-race",
          permissions: ["datasets:import"],
          workspaceId: workspaceA,
        },
        batchLimits: { maxBytes: 16_384, maxItems: 10 },
        bytes: {
          async *[Symbol.asyncIterator]() {
            await Promise.resolve();
            yield* [];
          },
        },
        dataset: racePlan.value.plan.requestIntent.targetDataset,
        fields: racePlan.value.plan.requestIntent.fields,
        format: "jsonl",
        importId: "import-generation-race",
        maxRecordBytes: 1024,
        sourceContentHash: `sha256:${createHash("sha256").digest("hex")}`,
      }),
    ]);
    const generationWon = raceGeneration.ok;
    const importWon = raceImport.ok;
    assert.notEqual(generationWon, importWon);
    if (generationWon) {
      assert.equal(raceIdentifierCalls.value, 1);
      assert.equal(raceImport.ok, false);
      if (!raceImport.ok) {
        assert.equal(raceImport.error.code, "dataset-import-conflict");
      }
    } else {
      assert.equal(raceGeneration.error.code, "target-dataset-conflict");
      assert.equal(raceIdentifierCalls.value, 0);
      assert.equal(raceImport.ok, true);
    }
    const racedDataset = await runtime.datasets.getDataset(
      { workspaceId: workspaceA },
      racePlan.value.plan.requestIntent.targetDataset.datasetId
    );
    assert.equal(
      racedDataset?.materialization.origin.kind,
      generationWon ? "generation" : "import"
    );

    await assert.rejects(
      sql`
        UPDATE kurobara_core.dataset_generation_plans
        SET payload = payload
        WHERE workspace_id = ${workspaceA}
          AND generation_plan_id = ${left.value.plan.generationPlanId}
      `,
      IMMUTABLE_PLAN
    );
    await assert.rejects(
      sql`
        DELETE FROM kurobara_core.dataset_generation_plans
        WHERE workspace_id = ${workspaceA}
          AND generation_plan_id = ${left.value.plan.generationPlanId}
      `,
      IMMUTABLE_PLAN
    );
  } finally {
    if (runtime !== undefined) {
      await runtime.close();
    }
    if (sql !== undefined) {
      await sql.end({ timeout: 5 });
    }
    await admin`DROP DATABASE IF EXISTS ${admin(databaseName)} WITH (FORCE)`;
    await admin.end({ timeout: 5 });
  }
});
