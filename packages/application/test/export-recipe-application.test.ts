import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  actorId,
  cellResultId,
  contentHash,
  type Dataset,
  type Record as DatasetRecord,
  datasetId,
  datasetMaterializationId,
  type EnrichmentRecipe,
  enrichmentRecipeId,
  type Field,
  fieldId,
  instant,
  recordId,
  runId,
  workflowSpecId,
  workspaceId,
} from "@kurobara/kernel";
import type {
  DatasetCodecPort,
  DatasetDecodeEvent,
  DatasetEncodeEvent,
  DatasetEncodeInput,
  DatasetImportBatch,
  DatasetImportCompletion,
  DatasetImportDefinition,
  DatasetImportIssue,
  DatasetImportMutationResult,
  DatasetPersistencePort,
  ExactRecipeProjectionRow,
  RecipeApplication,
  RecipePersistencePort,
  RecipePersistenceUnitOfWork,
  StoredDataset,
  VerifiedApiKey,
  WorkspaceScope,
} from "@kurobara/ports";

import {
  type ExportRecipeApplicationRequest,
  type ExportRecipeApplicationResult,
  makeExportRecipeApplication,
  RecipeApplicationExportInvariantError,
} from "../src/export-recipe-application.ts";

const hash = (marker: string) =>
  contentHash(`sha256:${marker.repeat(64).slice(0, 64)}`);

const workspace = workspaceId("workspace-recipe-export");
const dataset: Dataset = {
  datasetId: datasetId("dataset-recipe-export"),
  name: "Synthetic organizations",
  workspaceId: workspace,
};
const domainField: Field = {
  datasetId: dataset.datasetId,
  fieldId: fieldId("field-domain"),
  key: "domain",
  label: "Domain",
  valueType: "string",
  workspaceId: workspace,
};
const targetField: Field = {
  datasetId: dataset.datasetId,
  fieldId: fieldId("field-website"),
  key: "website",
  label: "Website",
  valueType: "string",
  workspaceId: workspace,
};
const scoreField: Field = {
  datasetId: dataset.datasetId,
  fieldId: fieldId("field-score"),
  key: "score",
  label: "Score",
  valueType: "number",
  workspaceId: workspace,
};
const fields = [domainField, targetField, scoreField] as const;
const recipe: EnrichmentRecipe = {
  datasetId: dataset.datasetId,
  enrichmentRecipeId: enrichmentRecipeId("recipe-website"),
  inputFieldIds: [domainField.fieldId],
  name: "Find official website",
  recipeRevision: "recipe-r1",
  targetFieldId: targetField.fieldId,
  workflowContentHash: hash("a"),
  workflowRevision: "workflow-r1",
  workflowSpecId: workflowSpecId("workflow-website"),
  workspaceId: workspace,
};
const records = [
  {
    datasetId: dataset.datasetId,
    recordId: recordId("record-1"),
    values: [
      { fieldId: domainField.fieldId, value: "one.invalid" },
      { fieldId: targetField.fieldId, value: "https://stale-one.invalid" },
      { fieldId: scoreField.fieldId, value: 1 },
    ],
    workspaceId: workspace,
  },
  {
    datasetId: dataset.datasetId,
    recordId: recordId("record-2"),
    values: [
      { fieldId: domainField.fieldId, value: "two.invalid" },
      { fieldId: targetField.fieldId, value: "https://stale-two.invalid" },
    ],
    workspaceId: workspace,
  },
] as const satisfies readonly DatasetRecord[];
const application: RecipeApplication = {
  createdAt: instant(1000),
  datasetId: dataset.datasetId,
  graph: { recordIds: records.map((record) => record.recordId) },
  graphHash: hash("b"),
  intentHash: hash("c"),
  maxCells: 100,
  recipeApplicationId: "application-recipe-export",
  recipeId: recipe.enrichmentRecipeId,
  recipeRevision: recipe.recipeRevision,
  targetFieldId: targetField.fieldId,
  workspaceId: workspace,
};
const actor: VerifiedApiKey = {
  actorId: actorId("actor-recipe-export"),
  authenticationMode: "api-key",
  credentialId: "credential-recipe-export",
  permissions: ["recipes:export"],
  workspaceId: workspace,
};

const storedDataset = (
  state: StoredDataset["materialization"]["state"] = "ready"
): StoredDataset => ({
  dataset,
  fields,
  import: {
    batchCount: 1,
    datasetId: dataset.datasetId,
    errorCount: 0,
    importId: "import-recipe-export",
    itemCount: records.length,
    recordCount: records.length,
    state: "completed",
    workspaceId: workspace,
  },
  materialization: {
    completedAt: instant(2),
    completionReason: "source-exhausted",
    contentHash: hash("d"),
    coverage: {
      basis: "imported_source",
      status: "complete_for_declared_source",
    },
    createdAt: instant(1),
    datasetId: dataset.datasetId,
    materializationId: datasetMaterializationId(dataset.datasetId),
    origin: { importId: "import-recipe-export", kind: "import" },
    recordCount: records.length,
    rejectedCount: 0,
    revision: 2,
    schemaHash: hash("e"),
    state,
    workspaceId: workspace,
  },
});

const cellResult = (
  index: number,
  status: "failed" | "pending" | "succeeded" = "succeeded",
  value: string | null = `https://exact-${index + 1}.invalid`
): ExactRecipeProjectionRow["cellResult"] => {
  const identity = {
    cellResultId: cellResultId(`cell-result-${index + 1}`),
    datasetId: dataset.datasetId,
    enrichmentRecipeId: recipe.enrichmentRecipeId,
    fieldId: targetField.fieldId,
    recipeRevision: recipe.recipeRevision,
    recordId: records[index]?.recordId ?? recordId("record-missing"),
    runId: runId(`run-cell-${index + 1}`),
    workspaceId: workspace,
  } as const;
  if (status === "failed") {
    return {
      ...identity,
      reason: {
        code: "run-failed",
        message: "The canonical run failed.",
        retryable: false,
      },
      status,
    };
  }
  if (status === "pending") {
    return { ...identity, status };
  }
  return { ...identity, status, value };
};

const projectionRow = (
  index: number,
  overrides: Partial<ExactRecipeProjectionRow> = {}
): ExactRecipeProjectionRow => ({
  application,
  binding: "executed",
  cellResult: cellResult(index),
  record: records[index] as DatasetRecord,
  recordContentHash: hash(String(index + 1)),
  ...overrides,
});

const defaultRows = () => [projectionRow(0), projectionRow(1)] as const;

const emptyAsyncIterable = <Value>(): AsyncIterable<Value> => ({
  [Symbol.asyncIterator]: () => ({
    next: () => Promise.resolve({ done: true, value: undefined }),
  }),
});

class FakeDatasets implements DatasetPersistencePort {
  complete = true;
  completenessCalls: readonly string[][] = [];
  getCalls = 0;
  stored: StoredDataset | undefined = storedDataset();
  streamRecordCalls = 0;

  appendImportBatch(
    _scope: WorkspaceScope,
    _importId: string,
    _batch: DatasetImportBatch
  ): Promise<DatasetImportMutationResult> {
    throw new Error("not used");
  }

  beginImport(
    _scope: WorkspaceScope,
    _definition: DatasetImportDefinition
  ): Promise<DatasetImportMutationResult> {
    throw new Error("not used");
  }

  finishImport(
    _scope: WorkspaceScope,
    _importId: string,
    _completion: DatasetImportCompletion
  ): Promise<DatasetImportMutationResult> {
    throw new Error("not used");
  }

  getDataset(): Promise<StoredDataset | undefined> {
    this.getCalls += 1;
    return Promise.resolve(this.stored);
  }

  isFieldSetComplete(
    _scope: WorkspaceScope,
    _datasetId: string,
    fieldIds: readonly string[]
  ): Promise<boolean> {
    this.completenessCalls = [...this.completenessCalls, [...fieldIds]];
    return Promise.resolve(this.complete);
  }

  resetImport(): Promise<DatasetImportMutationResult> {
    throw new Error("not used");
  }

  streamImportIssues(): AsyncIterable<DatasetImportIssue> {
    return emptyAsyncIterable();
  }

  streamRecords(): AsyncIterable<DatasetRecord> {
    this.streamRecordCalls += 1;
    return emptyAsyncIterable();
  }
}

class FakeRecipes implements RecipePersistencePort {
  application: RecipeApplication | undefined = application;
  recipe: EnrichmentRecipe | undefined = recipe;
  readonly streamPasses: readonly (readonly ExactRecipeProjectionRow[])[];
  streamCalls = 0;
  transactionCalls = 0;

  constructor(
    streamPasses: readonly (readonly ExactRecipeProjectionRow[])[] = [
      defaultRows(),
      defaultRows(),
    ]
  ) {
    this.streamPasses = streamPasses;
  }

  streamExactProjection(): AsyncIterable<ExactRecipeProjectionRow> {
    const call = this.streamCalls;
    this.streamCalls += 1;
    const rows = this.streamPasses[call] ?? this.streamPasses.at(-1) ?? [];
    return {
      async *[Symbol.asyncIterator]() {
        for (const row of rows) {
          await Promise.resolve();
          yield row;
        }
      },
    };
  }

  transaction<Value>(
    _scope: WorkspaceScope,
    work: (unitOfWork: RecipePersistenceUnitOfWork) => Promise<Value>
  ): Promise<Value> {
    this.transactionCalls += 1;
    const unitOfWork: RecipePersistenceUnitOfWork = {
      applicationCells: { get: () => Promise.resolve(undefined) },
      applications: {
        get: () => Promise.resolve(this.application),
        register: () => Promise.resolve(),
      },
      cache: {
        getForUpdate: () => Promise.resolve(undefined),
      },
      cachedBindings: {
        pinActive: () => Promise.resolve(),
        pinCached: () => Promise.resolve(true),
      },
      cellResults: { getByRun: () => Promise.resolve(undefined) },
      inputs: { resolveExact: () => Promise.resolve(undefined) },
      recipes: {
        get: () => Promise.resolve(this.recipe),
        register: () => Promise.resolve(),
      },
    };
    return work(unitOfWork);
  }
}

class ObservingCodec implements DatasetCodecPort {
  readonly format: "csv" | "jsonl";
  encodeCalls = 0;
  readonly records: DatasetRecord[] = [];
  readonly scriptedEvents = new Map<number, readonly DatasetEncodeEvent[]>();

  constructor(format: "csv" | "jsonl") {
    this.format = format;
  }

  readonly codecVersion = "1.0.0";

  decode(): AsyncIterable<DatasetDecodeEvent> {
    return emptyAsyncIterable();
  }

  encode(input: DatasetEncodeInput) {
    this.encodeCalls += 1;
    const scriptedEvents = this.scriptedEvents.get(this.encodeCalls);
    const observed = this.records;
    return {
      async *[Symbol.asyncIterator]() {
        if (scriptedEvents !== undefined) {
          for await (const record of input.records) {
            observed.push(record as DatasetRecord);
          }
          yield* scriptedEvents;
          return;
        }
        for await (const record of input.records) {
          observed.push(record as DatasetRecord);
          yield {
            bytes: new TextEncoder().encode(record.recordId),
            type: "chunk" as const,
          };
        }
      },
    };
  }
}

const request = (
  overrides: Partial<ExportRecipeApplicationRequest> = {}
): ExportRecipeApplicationRequest => ({
  actor,
  format: "jsonl",
  recipeApplicationId: application.recipeApplicationId,
  ...overrides,
});

const makeUseCase = (
  recipes = new FakeRecipes(),
  limits: Readonly<{ maxExportBytes: number; maxRecordBytes: number }> = {
    maxExportBytes: 4096,
    maxRecordBytes: 4096,
  }
) => {
  const datasets = new FakeDatasets();
  const csv = new ObservingCodec("csv");
  const jsonl = new ObservingCodec("jsonl");
  const useCase = makeExportRecipeApplication({
    codecs: { csv, jsonl },
    datasets,
    ...limits,
    persistence: recipes,
    requiredPermission: "recipes:export",
  });
  return { csv, datasets, jsonl, recipes, useCase };
};

const failureCode = (result: ExportRecipeApplicationResult) => {
  if (result.ok) {
    throw new Error("Expected recipe-application export to fail.");
  }
  return result.error.code;
};

const encodedHash = (value: string) =>
  contentHash(
    `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`
  );

const collectChunks = async (
  events: AsyncIterable<DatasetEncodeEvent>
): Promise<string> => {
  const chunks: Uint8Array[] = [];
  for await (const event of events) {
    if (event.type !== "chunk") {
      throw new Error("Expected the verified export to contain only chunks.");
    }
    chunks.push(event.bytes);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
};

test("enforces export permission and hides a foreign application scope", async () => {
  const deniedSetup = makeUseCase();
  const denied = await deniedSetup.useCase(
    request({ actor: { ...actor, permissions: [] } })
  );
  assert.equal(failureCode(denied), "authority-permission-missing");
  assert.equal(deniedSetup.recipes.transactionCalls, 0);
  assert.equal(deniedSetup.datasets.getCalls, 0);

  const foreignSetup = makeUseCase();
  foreignSetup.recipes.application = {
    ...application,
    workspaceId: workspaceId("workspace-other"),
  };
  const foreign = await foreignSetup.useCase(request());
  assert.equal(failureCode(foreign), "recipe-application-not-found");
  assert.equal(foreignSetup.datasets.getCalls, 0);
});

test("requires the exact recipe and a completed application dataset", async () => {
  const missingRecipeSetup = makeUseCase();
  missingRecipeSetup.recipes.recipe = undefined;
  const missingRecipe = await missingRecipeSetup.useCase(request());
  assert.equal(failureCode(missingRecipe), "recipe-not-found");
  assert.equal(missingRecipeSetup.datasets.getCalls, 0);

  const incompleteSetup = makeUseCase();
  incompleteSetup.datasets.stored = storedDataset("building");
  const incomplete = await incompleteSetup.useCase(request());
  assert.equal(failureCode(incomplete), "dataset-not-ready");
  assert.equal(incompleteSetup.recipes.streamCalls, 0);
  assert.equal(incompleteSetup.jsonl.encodeCalls, 0);
});

test("preflights pending and failed cells before invoking a codec", async () => {
  for (const status of ["pending", "failed"] as const) {
    const rows = defaultRows();
    const incompleteRow = projectionRow(0, {
      cellResult: cellResult(0, status),
    });
    const setup = makeUseCase(
      new FakeRecipes([[incompleteRow, rows[1] as ExactRecipeProjectionRow]])
    );

    const result = await setup.useCase(request());

    assert.equal(failureCode(result), "recipe-projection-incomplete");
    assert.equal(setup.jsonl.encodeCalls, 0);
    assert.equal(setup.recipes.streamCalls, 1);
  }
});

test("requires a non-empty unique selection of known application fields", async () => {
  const selections = [
    [],
    [domainField.fieldId, domainField.fieldId],
    [fieldId("field-unknown")],
  ] as const;

  for (const fieldIds of selections) {
    const setup = makeUseCase();
    const result = await setup.useCase(request({ fieldIds }));
    assert.equal(failureCode(result), "field-selection-invalid");
    assert.equal(setup.recipes.streamCalls, 0);
    assert.equal(setup.jsonl.encodeCalls, 0);
  }
});

test("rejects mismatched, duplicated, out-of-order and incomplete projection rows", async () => {
  const rows = defaultRows();
  const cases = [
    {
      code: "recipe-projection-identity-mismatch",
      rows: [
        rows[1] as ExactRecipeProjectionRow,
        rows[0] as ExactRecipeProjectionRow,
      ],
    },
    {
      code: "recipe-projection-duplicate",
      rows: [
        rows[0] as ExactRecipeProjectionRow,
        rows[0] as ExactRecipeProjectionRow,
      ],
    },
    {
      code: "recipe-projection-identity-mismatch",
      rows: [
        projectionRow(0, {
          application: { ...application, intentHash: hash("d") },
        }),
        rows[1] as ExactRecipeProjectionRow,
      ],
    },
    {
      code: "recipe-projection-count-mismatch",
      rows: [rows[0] as ExactRecipeProjectionRow],
    },
  ] as const;

  for (const projectionCase of cases) {
    const setup = makeUseCase(new FakeRecipes([projectionCase.rows]));
    const result = await setup.useCase(request());
    assert.equal(failureCode(result), projectionCase.code);
    assert.equal(setup.jsonl.encodeCalls, 0);
  }
});

test("overlays exact target values in application order and preserves null", async () => {
  const rows = [
    projectionRow(0, {
      cellResult: cellResult(0, "succeeded", "https://exact.invalid"),
    }),
    projectionRow(1, { cellResult: cellResult(1, "succeeded", null) }),
  ] as const;
  const setup = makeUseCase(new FakeRecipes([rows, rows]));
  const result = await setup.useCase(
    request({ fieldIds: [targetField.fieldId, domainField.fieldId] })
  );

  assert.equal(result.ok, true);
  if (!result.ok) {
    return;
  }
  assert.equal(result.value.contentLength, 16);
  assert.equal(result.value.contentHash, encodedHash("record-1record-2"));
  assert.equal(setup.recipes.streamCalls, 2);
  assert.equal(setup.jsonl.encodeCalls, 1);
  const firstExport = await collectChunks(result.value.events);
  const replayedExport = await collectChunks(result.value.events);

  assert.equal(result.value.application, application);
  assert.equal(result.value.recipe, recipe);
  assert.equal(firstExport, "record-1record-2");
  assert.equal(replayedExport, firstExport);
  assert.equal(setup.recipes.streamCalls, 4);
  assert.equal(setup.jsonl.encodeCalls, 3);
  assert.equal(setup.datasets.streamRecordCalls, 0);
  assert.deepEqual(setup.jsonl.records, [
    {
      ...records[0],
      values: [
        { fieldId: targetField.fieldId, value: "https://exact.invalid" },
        { fieldId: domainField.fieldId, value: "one.invalid" },
      ],
    },
    {
      ...records[1],
      values: [
        { fieldId: targetField.fieldId, value: null },
        { fieldId: domainField.fieldId, value: "two.invalid" },
      ],
    },
    {
      ...records[0],
      values: [
        { fieldId: targetField.fieldId, value: "https://exact.invalid" },
        { fieldId: domainField.fieldId, value: "one.invalid" },
      ],
    },
    {
      ...records[1],
      values: [
        { fieldId: targetField.fieldId, value: null },
        { fieldId: domainField.fieldId, value: "two.invalid" },
      ],
    },
    {
      ...records[0],
      values: [
        { fieldId: targetField.fieldId, value: "https://exact.invalid" },
        { fieldId: domainField.fieldId, value: "one.invalid" },
      ],
    },
    {
      ...records[1],
      values: [
        { fieldId: targetField.fieldId, value: null },
        { fieldId: domainField.fieldId, value: "two.invalid" },
      ],
    },
  ]);
});

test("retains immutable bytes when a codec reuses its yielded buffer", async () => {
  const setup = makeUseCase();
  const mutableCodec: DatasetCodecPort = {
    codecVersion: "1.0.0",
    decode: () => emptyAsyncIterable(),
    encode(input) {
      return {
        async *[Symbol.asyncIterator]() {
          for await (const _record of input.records) {
            // Exercise the complete projection before producing the fixture.
          }
          const reused = new Uint8Array([1]);
          yield { bytes: reused, type: "chunk" as const };
          reused[0] = 2;
          yield { bytes: new Uint8Array([3]), type: "chunk" as const };
        },
      };
    },
    format: "jsonl",
  };
  const useCase = makeExportRecipeApplication({
    codecs: { csv: setup.csv, jsonl: mutableCodec },
    datasets: setup.datasets,
    maxExportBytes: 4096,
    maxRecordBytes: 4096,
    persistence: setup.recipes,
    requiredPermission: "recipes:export",
  });

  const result = await useCase(request());

  assert.equal(result.ok, true);
  if (!result.ok) {
    return;
  }
  const observed: number[] = [];
  for await (const event of result.value.events) {
    if (event.type === "chunk") {
      observed.push(...event.bytes);
    }
  }
  assert.deepEqual(observed, [1, 3]);
});

test("preflights only selected non-target base fields for CSV", async () => {
  const setup = makeUseCase();
  setup.datasets.complete = false;

  const result = await setup.useCase(
    request({
      fieldIds: [targetField.fieldId, scoreField.fieldId, domainField.fieldId],
      format: "csv",
    })
  );

  assert.equal(failureCode(result), "sparse-csv-unsupported");
  assert.deepEqual(setup.datasets.completenessCalls, [
    [scoreField.fieldId, domainField.fieldId],
  ]);
  assert.equal(setup.recipes.streamCalls, 1);
  assert.equal(setup.csv.encodeCalls, 0);
});

test("rejects codec miswiring before persistence I/O", async () => {
  const setup = makeUseCase();
  const miswired = makeExportRecipeApplication({
    codecs: {
      csv: setup.csv,
      jsonl: setup.csv,
    },
    datasets: setup.datasets,
    maxExportBytes: 4096,
    maxRecordBytes: 4096,
    persistence: setup.recipes,
    requiredPermission: "recipes:export",
  });

  const result = await miswired(request());

  assert.equal(failureCode(result), "codec-configuration-invalid");
  assert.equal(setup.recipes.transactionCalls, 0);
  assert.equal(setup.datasets.getCalls, 0);
});

test("rejects invalid byte limits before persistence I/O", async () => {
  for (const invalid of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    for (const limit of ["maxExportBytes", "maxRecordBytes"] as const) {
      const setup = makeUseCase(new FakeRecipes(), {
        maxExportBytes: 4096,
        maxRecordBytes: 4096,
        [limit]: invalid,
      });

      const result = await setup.useCase(request());

      assert.equal(failureCode(result), "codec-configuration-invalid");
      assert.equal(setup.recipes.transactionCalls, 0);
      assert.equal(setup.datasets.getCalls, 0);
      assert.equal(setup.jsonl.encodeCalls, 0);
    }
  }
});

test("rejects record and total encoded size limits before success", async () => {
  const recordSetup = makeUseCase();
  recordSetup.jsonl.scriptedEvents.set(1, [
    {
      error: {
        code: "record-too-large",
        message: "DO-NOT-COPY-OVERSIZED-RECORD",
        recoverable: false,
        scope: "record",
      },
      type: "error",
    },
  ]);
  const recordResult = await recordSetup.useCase(request());
  assert.equal(failureCode(recordResult), "export-too-large");
  if (!recordResult.ok) {
    assert.equal(recordResult.error.message.includes("DO-NOT-COPY"), false);
  }

  const totalSetup = makeUseCase(new FakeRecipes(), {
    maxExportBytes: 15,
    maxRecordBytes: 4096,
  });
  const totalResult = await totalSetup.useCase(request());
  assert.equal(failureCode(totalResult), "export-too-large");
  assert.equal(totalSetup.recipes.streamCalls, 2);
  assert.equal(totalSetup.jsonl.encodeCalls, 1);
});

test("redacts a non-size codec failure before success", async () => {
  const secret = "DO-NOT-COPY-CODEC-PREFLIGHT";
  const setup = makeUseCase();
  setup.jsonl.scriptedEvents.set(1, [
    {
      error: {
        code: "invalid-record-shape",
        message: secret,
        recoverable: false,
        scope: "record",
      },
      type: "error",
    },
  ]);

  const result = await setup.useCase(request());

  assert.equal(failureCode(result), "codec-configuration-invalid");
  if (!result.ok) {
    assert.equal(result.error.message.includes(secret), false);
  }
});

test("throws a redacted invariant error if the immutable second pass drifts", async () => {
  const secret = "DO-NOT-COPY-SECOND-PASS-DRIFT";
  const firstPass = defaultRows();
  const drifted = [
    projectionRow(0, {
      cellResult: cellResult(0, "succeeded", secret),
    }),
    projectionRow(1),
  ] as const;
  const setup = makeUseCase(new FakeRecipes([firstPass, firstPass, drifted]));
  const result = await setup.useCase(request());
  assert.equal(result.ok, true);
  if (!result.ok) {
    return;
  }

  await assert.rejects(
    async () => {
      for await (const _event of result.value.events) {
        // The first changed row must be fenced before an event is yielded.
      }
    },
    (error: unknown) => {
      assert.equal(
        error instanceof RecipeApplicationExportInvariantError,
        true
      );
      if (!(error instanceof RecipeApplicationExportInvariantError)) {
        return false;
      }
      assert.equal(error.code, "recipe-application-export-drift");
      assert.equal(error.message.includes(secret), false);
      return true;
    }
  );
  assert.equal(setup.jsonl.records.length, 2);
});

test("throws only redacted invariant errors for replay codec, size and proof drift", async () => {
  const secret = "DO-NOT-COPY-REPLAY-FAILURE";
  const cases = [
    {
      configure(codec: ObservingCodec) {
        codec.scriptedEvents.set(2, [
          {
            error: {
              code: "invalid-record-shape",
              message: secret,
              recoverable: false,
              scope: "record",
            },
            type: "error",
          },
        ]);
      },
      name: "codec error",
    },
    {
      configure(codec: ObservingCodec) {
        codec.scriptedEvents.set(2, [
          {
            bytes: new TextEncoder().encode(`${secret}-TOO-LARGE`),
            type: "chunk",
          },
        ]);
      },
      name: "byte limit drift",
    },
    {
      configure(codec: ObservingCodec) {
        codec.scriptedEvents.set(2, [
          {
            bytes: new TextEncoder().encode("xxxxxxxxxxxxxxxx"),
            type: "chunk",
          },
        ]);
      },
      name: "content proof drift",
    },
  ] as const;

  for (const replayCase of cases) {
    const setup = makeUseCase(new FakeRecipes(), {
      maxExportBytes: 16,
      maxRecordBytes: 4096,
    });
    replayCase.configure(setup.jsonl);
    const result = await setup.useCase(request());
    assert.equal(result.ok, true, replayCase.name);
    if (!result.ok) {
      continue;
    }

    let emittedBytes = 0;
    await assert.rejects(
      async () => {
        for await (const event of result.value.events) {
          if (event.type === "chunk") {
            emittedBytes += event.bytes.byteLength;
          }
        }
      },
      (error: unknown) => {
        assert.equal(
          error instanceof RecipeApplicationExportInvariantError,
          true,
          replayCase.name
        );
        if (!(error instanceof RecipeApplicationExportInvariantError)) {
          return false;
        }
        assert.equal(error.message.includes(secret), false);
        return true;
      }
    );
    assert.ok(emittedBytes < result.value.contentLength, replayCase.name);
  }
});
