import { createHash } from "node:crypto";

import {
  type CellResult,
  cellResultId,
  contentHash,
  createCellResult,
  createEnrichmentRecipe,
  type Dataset,
  type Record as DatasetRecord,
  datasetId,
  type EnrichmentRecipe,
  enrichmentRecipeId,
  type Field,
  fieldId,
  instant,
  recordId,
  runId,
  type ScalarValue,
  workflowSpecId,
  workspaceId,
} from "@kurobara/kernel";
import type {
  ExactRecipeCellInput,
  NormalizedJsonValue,
  RecipeApplication,
  RecipeApplicationGraph,
  RecipeCellCacheIdentity,
  RecipeCellInputValue,
} from "@kurobara/ports";

const BUDGET_UNIT_PATTERN = /^[a-z][a-z0-9._-]*$/u;

import { DatabasePayloadError } from "./errors.ts";

type JsonRecord = Readonly<Record<string, unknown>>;
type CanonicalJson =
  | boolean
  | null
  | number
  | string
  | readonly CanonicalJson[]
  | Readonly<{ [key: string]: CanonicalJson }>;

const asRecord = (value: unknown, path: string): JsonRecord => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new DatabasePayloadError(`${path} must be an object.`);
  }
  return value as JsonRecord;
};

const asString = (value: unknown, path: string): string => {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new DatabasePayloadError(`${path} must be a non-empty string.`);
  }
  return value;
};

const asBoundedString = (
  value: unknown,
  path: string,
  maximum: number
): string => {
  const parsed = asString(value, path);
  if ([...parsed].length > maximum) {
    throw new DatabasePayloadError(`${path} exceeds its maximum length.`);
  }
  return parsed;
};

const asFiniteNumber = (value: unknown, path: string): number => {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new DatabasePayloadError(`${path} must be a finite number.`);
  }
  return value;
};

const asNonNegativeInteger = (value: unknown, path: string): number => {
  const parsed = asFiniteNumber(value, path);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new DatabasePayloadError(
      `${path} must be a non-negative safe integer.`
    );
  }
  return parsed;
};

const asPositiveInteger = (
  value: unknown,
  path: string,
  maximum: number
): number => {
  const parsed = asNonNegativeInteger(value, path);
  if (parsed === 0 || parsed > maximum) {
    throw new DatabasePayloadError(
      `${path} must be an integer between 1 and ${maximum}.`
    );
  }
  return parsed;
};

const asBoolean = (value: unknown, path: string): boolean => {
  if (typeof value !== "boolean") {
    throw new DatabasePayloadError(`${path} must be a boolean.`);
  }
  return value;
};

const asScalar = (value: unknown, path: string): ScalarValue => {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "string" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return value;
  }
  throw new DatabasePayloadError(`${path} must be a scalar or explicit null.`);
};

const assertOnlyKeys = (
  value: JsonRecord,
  path: string,
  required: readonly string[],
  optional: readonly string[] = []
): void => {
  const allowed = new Set([...required, ...optional]);
  const actual = Object.keys(value);
  const missing = required.find((key) => !Object.hasOwn(value, key));
  const extra = actual.find((key) => !allowed.has(key));
  if (missing !== undefined || extra !== undefined) {
    throw new DatabasePayloadError(
      `${path} does not have its exact canonical field set.`
    );
  }
};

const canonicalJson = (
  value: unknown,
  path = "canonicalJson"
): CanonicalJson => {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "string"
  ) {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new DatabasePayloadError(`${path} contains a non-finite number.`);
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((entry, index) =>
      canonicalJson(entry, `${path}[${index}]`)
    );
  }
  const source = asRecord(value, path);
  const result: Record<string, CanonicalJson> = {};
  for (const [key, entry] of Object.entries(source)) {
    if (entry === undefined) {
      throw new DatabasePayloadError(`${path}.${key} must not be undefined.`);
    }
    result[key] = canonicalJson(entry, `${path}.${key}`);
  }
  return result;
};

const compareKeys = (left: string, right: string): number => {
  if (left < right) {
    return -1;
  }
  return left > right ? 1 : 0;
};

const serializeCanonicalJson = (value: CanonicalJson): string => {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "number" ||
    typeof value === "string"
  ) {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(serializeCanonicalJson).join(",")}]`;
  }
  return `{${Object.entries(value)
    .sort(([left], [right]) => compareKeys(left, right))
    .map(
      ([key, entry]) =>
        `${JSON.stringify(key)}:${serializeCanonicalJson(entry)}`
    )
    .join(",")}}`;
};

export const recipeCanonicalHash = (
  value: unknown
): ReturnType<typeof contentHash> =>
  contentHash(
    `sha256:${createHash("sha256")
      .update(serializeCanonicalJson(canonicalJson(value)), "utf8")
      .digest("hex")}`
  );

export type RecipePayloadIdentity = Readonly<{
  datasetId: string;
  enrichmentRecipeId: string;
  inputFieldIds: readonly string[];
  recipeRevision: string;
  targetFieldId: string;
  workflowContentHash: string;
  workflowRevision: string;
  workflowSpecId: string;
  workspaceId: string;
}>;

export const parseRecipePayload = (
  value: unknown,
  dataset: Dataset,
  fields: readonly Field[],
  expected: RecipePayloadIdentity
): EnrichmentRecipe => {
  const payload = asRecord(value, "recipe");
  assertOnlyKeys(payload, "recipe", [
    "datasetId",
    "enrichmentRecipeId",
    "inputFieldIds",
    "name",
    "recipeRevision",
    "targetFieldId",
    "workflowContentHash",
    "workflowRevision",
    "workflowSpecId",
    "workspaceId",
  ]);
  if (!Array.isArray(payload.inputFieldIds)) {
    throw new DatabasePayloadError("recipe.inputFieldIds must be an array.");
  }
  const inputFieldIds = payload.inputFieldIds.map((entry, index) =>
    fieldId(asString(entry, `recipe.inputFieldIds[${index}]`))
  );
  const created = createEnrichmentRecipe(dataset, fields, {
    datasetId: datasetId(asString(payload.datasetId, "recipe.datasetId")),
    enrichmentRecipeId: enrichmentRecipeId(
      asString(payload.enrichmentRecipeId, "recipe.enrichmentRecipeId")
    ),
    inputFieldIds,
    name: asString(payload.name, "recipe.name"),
    recipeRevision: asString(payload.recipeRevision, "recipe.recipeRevision"),
    targetFieldId: fieldId(
      asString(payload.targetFieldId, "recipe.targetFieldId")
    ),
    workflowContentHash: contentHash(
      asString(payload.workflowContentHash, "recipe.workflowContentHash")
    ),
    workflowRevision: asString(
      payload.workflowRevision,
      "recipe.workflowRevision"
    ),
    workflowSpecId: workflowSpecId(
      asString(payload.workflowSpecId, "recipe.workflowSpecId")
    ),
    workspaceId: workspaceId(
      asString(payload.workspaceId, "recipe.workspaceId")
    ),
  });
  if (!created.ok) {
    throw new DatabasePayloadError(
      "The stored recipe violates product invariants."
    );
  }
  const recipe = created.value;
  if (
    recipe.workspaceId !== expected.workspaceId ||
    recipe.datasetId !== expected.datasetId ||
    recipe.enrichmentRecipeId !== expected.enrichmentRecipeId ||
    recipe.recipeRevision !== expected.recipeRevision ||
    recipe.targetFieldId !== expected.targetFieldId ||
    recipe.workflowSpecId !== expected.workflowSpecId ||
    recipe.workflowRevision !== expected.workflowRevision ||
    recipe.workflowContentHash !== expected.workflowContentHash ||
    recipe.inputFieldIds.length !== expected.inputFieldIds.length ||
    recipe.inputFieldIds.some(
      (inputFieldId, index) => inputFieldId !== expected.inputFieldIds[index]
    )
  ) {
    throw new DatabasePayloadError(
      "The stored recipe identity does not match its relational evidence."
    );
  }
  return recipe;
};

export const recipeApplicationGraphHash = (
  graph: RecipeApplicationGraph
): ReturnType<typeof contentHash> =>
  recipeCanonicalHash({ recordIds: [...graph.recordIds] });

const applicationIntentEvidence = (
  application: Pick<
    RecipeApplication,
    | "aggregateBudget"
    | "datasetId"
    | "graphHash"
    | "maxCells"
    | "recipeId"
    | "recipeRevision"
    | "targetFieldId"
    | "workspaceId"
  >
): unknown => ({
  ...(application.aggregateBudget === undefined
    ? {}
    : { aggregateBudget: { ...application.aggregateBudget } }),
  datasetId: application.datasetId,
  graphHash: application.graphHash,
  maxCells: application.maxCells,
  recipeId: application.recipeId,
  recipeRevision: application.recipeRevision,
  targetFieldId: application.targetFieldId,
  workspaceId: application.workspaceId,
});

export const recipeApplicationIntentHash = (
  application: Pick<
    RecipeApplication,
    | "aggregateBudget"
    | "datasetId"
    | "graphHash"
    | "maxCells"
    | "recipeId"
    | "recipeRevision"
    | "targetFieldId"
    | "workspaceId"
  >
): ReturnType<typeof contentHash> =>
  recipeCanonicalHash(applicationIntentEvidence(application));

export type RecipeApplicationPayloadIdentity = Readonly<{
  datasetId: string;
  graphHash: string;
  intentHash: string;
  recipeApplicationId: string;
  recipeId: string;
  recipeRevision: string;
  targetFieldId: string;
  workspaceId: string;
}>;

export const parseRecipeApplicationPayload = (
  value: unknown,
  expected: RecipeApplicationPayloadIdentity
): RecipeApplication => {
  const payload = asRecord(value, "recipeApplication");
  assertOnlyKeys(
    payload,
    "recipeApplication",
    [
      "createdAt",
      "datasetId",
      "graph",
      "graphHash",
      "intentHash",
      "maxCells",
      "recipeApplicationId",
      "recipeId",
      "recipeRevision",
      "targetFieldId",
      "workspaceId",
    ],
    ["aggregateBudget"]
  );
  const storedGraph = asRecord(payload.graph, "recipeApplication.graph");
  assertOnlyKeys(storedGraph, "recipeApplication.graph", ["recordIds"]);
  if (!Array.isArray(storedGraph.recordIds)) {
    throw new DatabasePayloadError(
      "recipeApplication.graph.recordIds must be an array."
    );
  }
  const recordIds = storedGraph.recordIds.map((entry, index) =>
    recordId(asString(entry, `recipeApplication.graph.recordIds[${index}]`))
  );
  const maxCells = asPositiveInteger(
    payload.maxCells,
    "recipeApplication.maxCells",
    10_000
  );
  if (
    recordIds.length === 0 ||
    recordIds.length > maxCells ||
    new Set(recordIds).size !== recordIds.length
  ) {
    throw new DatabasePayloadError(
      "recipeApplication graph must contain unique records within maxCells."
    );
  }
  const graph = { recordIds } satisfies RecipeApplicationGraph;
  const aggregateBudgetPayload =
    payload.aggregateBudget === undefined
      ? undefined
      : asRecord(payload.aggregateBudget, "recipeApplication.aggregateBudget");
  if (aggregateBudgetPayload !== undefined) {
    assertOnlyKeys(
      aggregateBudgetPayload,
      "recipeApplication.aggregateBudget",
      ["limit", "unit"]
    );
  }
  const aggregateBudget =
    aggregateBudgetPayload === undefined
      ? undefined
      : {
          limit: asFiniteNumber(
            aggregateBudgetPayload.limit,
            "recipeApplication.aggregateBudget.limit"
          ),
          unit: asBoundedString(
            aggregateBudgetPayload.unit,
            "recipeApplication.aggregateBudget.unit",
            64
          ),
        };
  if (
    aggregateBudget !== undefined &&
    (aggregateBudget.limit < 0 ||
      aggregateBudget.unit.trim() !== aggregateBudget.unit ||
      !BUDGET_UNIT_PATTERN.test(aggregateBudget.unit))
  ) {
    throw new DatabasePayloadError(
      "recipeApplication.aggregateBudget must be canonical and non-negative."
    );
  }
  const application: RecipeApplication = {
    ...(aggregateBudget === undefined ? {} : { aggregateBudget }),
    createdAt: instant(
      asNonNegativeInteger(payload.createdAt, "recipeApplication.createdAt")
    ),
    datasetId: datasetId(
      asString(payload.datasetId, "recipeApplication.datasetId")
    ),
    graph,
    graphHash: contentHash(
      asString(payload.graphHash, "recipeApplication.graphHash")
    ),
    intentHash: contentHash(
      asString(payload.intentHash, "recipeApplication.intentHash")
    ),
    maxCells,
    recipeApplicationId: asBoundedString(
      payload.recipeApplicationId,
      "recipeApplication.recipeApplicationId",
      255
    ),
    recipeId: enrichmentRecipeId(
      asString(payload.recipeId, "recipeApplication.recipeId")
    ),
    recipeRevision: asBoundedString(
      payload.recipeRevision,
      "recipeApplication.recipeRevision",
      255
    ),
    targetFieldId: fieldId(
      asString(payload.targetFieldId, "recipeApplication.targetFieldId")
    ),
    workspaceId: workspaceId(
      asString(payload.workspaceId, "recipeApplication.workspaceId")
    ),
  };
  if (
    application.graphHash !== recipeApplicationGraphHash(application.graph) ||
    application.intentHash !== recipeApplicationIntentHash(application) ||
    application.workspaceId !== expected.workspaceId ||
    application.datasetId !== expected.datasetId ||
    application.recipeApplicationId !== expected.recipeApplicationId ||
    application.recipeId !== expected.recipeId ||
    application.recipeRevision !== expected.recipeRevision ||
    application.targetFieldId !== expected.targetFieldId ||
    application.graphHash !== expected.graphHash ||
    application.intentHash !== expected.intentHash
  ) {
    throw new DatabasePayloadError(
      "The stored recipe application does not match its canonical identity."
    );
  }
  return application;
};

const inputValuesFor = (
  recipe: EnrichmentRecipe,
  record: DatasetRecord
): readonly RecipeCellInputValue[] => {
  const values = new Map(record.values.map((entry) => [entry.fieldId, entry]));
  return recipe.inputFieldIds.map((inputFieldId) => {
    const entry = values.get(inputFieldId);
    return entry === undefined
      ? { fieldId: inputFieldId, present: false }
      : { fieldId: inputFieldId, present: true, value: entry.value };
  });
};

const inputEvidence = (
  dataset: Dataset,
  recipe: EnrichmentRecipe,
  record: DatasetRecord,
  recordContentHash: ReturnType<typeof contentHash>,
  inputValues: readonly RecipeCellInputValue[]
): NormalizedJsonValue => {
  const normalizedValues: readonly NormalizedJsonValue[] = inputValues.map(
    (entry): NormalizedJsonValue =>
      entry.present
        ? { fieldId: entry.fieldId, present: true, value: entry.value }
        : { fieldId: entry.fieldId, present: false }
  );
  return {
    datasetId: dataset.datasetId,
    inputValues: normalizedValues,
    recipeId: recipe.enrichmentRecipeId,
    recipeRevision: recipe.recipeRevision,
    recordContentHash,
    recordId: record.recordId,
    targetFieldId: recipe.targetFieldId,
    workflowContentHash: recipe.workflowContentHash,
    workflowRevision: recipe.workflowRevision,
    workflowSpecId: recipe.workflowSpecId,
    workspaceId: dataset.workspaceId,
  };
};

export const recipeCellCacheKey = (
  identity: RecipeCellCacheIdentity
): ReturnType<typeof contentHash> => recipeCanonicalHash({ ...identity });

export const resolveExactRecipeCellInput = (
  application: RecipeApplication,
  dataset: Dataset,
  recipe: EnrichmentRecipe,
  record: DatasetRecord,
  storedRecordContentHash: string
): ExactRecipeCellInput => {
  if (
    application.workspaceId !== dataset.workspaceId ||
    application.datasetId !== dataset.datasetId ||
    application.recipeId !== recipe.enrichmentRecipeId ||
    application.recipeRevision !== recipe.recipeRevision ||
    application.targetFieldId !== recipe.targetFieldId ||
    record.workspaceId !== dataset.workspaceId ||
    record.datasetId !== dataset.datasetId ||
    !application.graph.recordIds.includes(record.recordId)
  ) {
    throw new DatabasePayloadError(
      "Recipe application, recipe, dataset, and record identities disagree."
    );
  }
  const recordContentHash = contentHash(storedRecordContentHash);
  const inputValues = inputValuesFor(recipe, record);
  const normalizedInput = inputEvidence(
    dataset,
    recipe,
    record,
    recordContentHash,
    inputValues
  );
  const inputHash = recipeCanonicalHash(normalizedInput);
  const cacheIdentity: RecipeCellCacheIdentity = {
    datasetId: dataset.datasetId,
    inputHash,
    recipeId: recipe.enrichmentRecipeId,
    recipeRevision: recipe.recipeRevision,
    recordContentHash,
    recordId: record.recordId,
    targetFieldId: recipe.targetFieldId,
    workflowContentHash: recipe.workflowContentHash,
    workflowRevision: recipe.workflowRevision,
    workflowSpecId: recipe.workflowSpecId,
    workspaceId: dataset.workspaceId,
  };
  return {
    cacheKey: recipeCellCacheKey(cacheIdentity),
    datasetId: dataset.datasetId,
    inputHash,
    inputValues,
    normalizedInput,
    recipeApplicationId: application.recipeApplicationId,
    recipeId: recipe.enrichmentRecipeId,
    recipeRevision: recipe.recipeRevision,
    recordContentHash,
    recordId: record.recordId,
    targetFieldId: recipe.targetFieldId,
    workflowContentHash: recipe.workflowContentHash,
    workflowRevision: recipe.workflowRevision,
    workflowSpecId: recipe.workflowSpecId,
    workspaceId: dataset.workspaceId,
  };
};

export const parseRecipeCellCacheIdentity = (
  value: unknown,
  expectedCacheKey: string
): RecipeCellCacheIdentity => {
  const payload = asRecord(value, "recipeCellCacheIdentity");
  assertOnlyKeys(payload, "recipeCellCacheIdentity", [
    "datasetId",
    "inputHash",
    "recipeId",
    "recipeRevision",
    "recordContentHash",
    "recordId",
    "targetFieldId",
    "workflowContentHash",
    "workflowRevision",
    "workflowSpecId",
    "workspaceId",
  ]);
  const identity: RecipeCellCacheIdentity = {
    datasetId: datasetId(
      asString(payload.datasetId, "recipeCellCacheIdentity.datasetId")
    ),
    inputHash: contentHash(
      asString(payload.inputHash, "recipeCellCacheIdentity.inputHash")
    ),
    recipeId: enrichmentRecipeId(
      asString(payload.recipeId, "recipeCellCacheIdentity.recipeId")
    ),
    recipeRevision: asString(
      payload.recipeRevision,
      "recipeCellCacheIdentity.recipeRevision"
    ),
    recordContentHash: contentHash(
      asString(
        payload.recordContentHash,
        "recipeCellCacheIdentity.recordContentHash"
      )
    ),
    recordId: recordId(
      asString(payload.recordId, "recipeCellCacheIdentity.recordId")
    ),
    targetFieldId: fieldId(
      asString(payload.targetFieldId, "recipeCellCacheIdentity.targetFieldId")
    ),
    workflowContentHash: contentHash(
      asString(
        payload.workflowContentHash,
        "recipeCellCacheIdentity.workflowContentHash"
      )
    ),
    workflowRevision: asString(
      payload.workflowRevision,
      "recipeCellCacheIdentity.workflowRevision"
    ),
    workflowSpecId: workflowSpecId(
      asString(payload.workflowSpecId, "recipeCellCacheIdentity.workflowSpecId")
    ),
    workspaceId: workspaceId(
      asString(payload.workspaceId, "recipeCellCacheIdentity.workspaceId")
    ),
  };
  if (recipeCellCacheKey(identity) !== expectedCacheKey) {
    throw new DatabasePayloadError(
      "The stored recipe cache identity does not match its cache key."
    );
  }
  return identity;
};

export type CellResultPayloadIdentity = Readonly<{
  cellResultId: string;
  datasetId: string;
  enrichmentRecipeId: string;
  fieldId: string;
  recipeRevision: string;
  recordId: string;
  runId: string;
  status: string;
  workspaceId: string;
}>;

const parseProvenance = (value: unknown): CellResult["provenance"] => {
  const payload = asRecord(value, "cellResult.provenance");
  assertOnlyKeys(payload, "cellResult.provenance", ["references"]);
  if (!Array.isArray(payload.references)) {
    throw new DatabasePayloadError(
      "cellResult.provenance.references must be an array."
    );
  }
  return {
    references: payload.references.map((entry, index) =>
      asString(entry, `cellResult.provenance.references[${index}]`)
    ),
  };
};

const parseFreshness = (value: unknown): CellResult["freshness"] => {
  const payload = asRecord(value, "cellResult.freshness");
  assertOnlyKeys(
    payload,
    "cellResult.freshness",
    ["observedAt"],
    ["expiresAt"]
  );
  return {
    observedAt: instant(
      asNonNegativeInteger(
        payload.observedAt,
        "cellResult.freshness.observedAt"
      )
    ),
    ...(Object.hasOwn(payload, "expiresAt")
      ? {
          expiresAt: instant(
            asNonNegativeInteger(
              payload.expiresAt,
              "cellResult.freshness.expiresAt"
            )
          ),
        }
      : {}),
  };
};

const parseCost = (value: unknown): CellResult["cost"] => {
  const payload = asRecord(value, "cellResult.cost");
  assertOnlyKeys(payload, "cellResult.cost", ["amount", "basis", "unit"]);
  if (payload.basis !== "estimated" && payload.basis !== "exact") {
    throw new DatabasePayloadError("cellResult.cost.basis is invalid.");
  }
  return {
    amount: asFiniteNumber(payload.amount, "cellResult.cost.amount"),
    basis: payload.basis,
    unit: asString(payload.unit, "cellResult.cost.unit"),
  };
};

const parseReason = (value: unknown): CellResult["reason"] => {
  const payload = asRecord(value, "cellResult.reason");
  assertOnlyKeys(payload, "cellResult.reason", [
    "code",
    "message",
    "retryable",
  ]);
  return {
    code: asString(payload.code, "cellResult.reason.code"),
    message: asString(payload.message, "cellResult.reason.message"),
    retryable: asBoolean(payload.retryable, "cellResult.reason.retryable"),
  };
};

export const parseCellResultPayload = (
  value: unknown,
  dataset: Dataset,
  fields: readonly Field[],
  record: DatasetRecord,
  recipe: EnrichmentRecipe,
  expected: CellResultPayloadIdentity
): CellResult => {
  const payload = asRecord(value, "cellResult");
  assertOnlyKeys(
    payload,
    "cellResult",
    [
      "cellResultId",
      "datasetId",
      "enrichmentRecipeId",
      "fieldId",
      "recipeRevision",
      "recordId",
      "runId",
      "status",
      "workspaceId",
    ],
    ["confidence", "cost", "freshness", "provenance", "reason", "value"]
  );
  const status = asString(payload.status, "cellResult.status");
  if (
    status !== "pending" &&
    status !== "running" &&
    status !== "succeeded" &&
    status !== "failed" &&
    status !== "skipped"
  ) {
    throw new DatabasePayloadError("cellResult.status is invalid.");
  }
  const candidate: CellResult = {
    cellResultId: cellResultId(
      asString(payload.cellResultId, "cellResult.cellResultId")
    ),
    datasetId: datasetId(asString(payload.datasetId, "cellResult.datasetId")),
    enrichmentRecipeId: enrichmentRecipeId(
      asString(payload.enrichmentRecipeId, "cellResult.enrichmentRecipeId")
    ),
    fieldId: fieldId(asString(payload.fieldId, "cellResult.fieldId")),
    recipeRevision: asString(
      payload.recipeRevision,
      "cellResult.recipeRevision"
    ),
    recordId: recordId(asString(payload.recordId, "cellResult.recordId")),
    runId: runId(asString(payload.runId, "cellResult.runId")),
    status,
    workspaceId: workspaceId(
      asString(payload.workspaceId, "cellResult.workspaceId")
    ),
    ...(Object.hasOwn(payload, "value")
      ? { value: asScalar(payload.value, "cellResult.value") }
      : {}),
    ...(Object.hasOwn(payload, "confidence")
      ? {
          confidence: asFiniteNumber(
            payload.confidence,
            "cellResult.confidence"
          ),
        }
      : {}),
    ...(Object.hasOwn(payload, "cost")
      ? { cost: parseCost(payload.cost) }
      : {}),
    ...(Object.hasOwn(payload, "freshness")
      ? { freshness: parseFreshness(payload.freshness) }
      : {}),
    ...(Object.hasOwn(payload, "provenance")
      ? { provenance: parseProvenance(payload.provenance) }
      : {}),
    ...(Object.hasOwn(payload, "reason")
      ? { reason: parseReason(payload.reason) }
      : {}),
  };
  const created = createCellResult(dataset, fields, record, recipe, candidate);
  if (!created.ok) {
    throw new DatabasePayloadError(
      "The stored cell result violates product invariants."
    );
  }
  const cellResult = created.value;
  if (
    cellResult.workspaceId !== expected.workspaceId ||
    cellResult.cellResultId !== expected.cellResultId ||
    cellResult.datasetId !== expected.datasetId ||
    cellResult.enrichmentRecipeId !== expected.enrichmentRecipeId ||
    cellResult.fieldId !== expected.fieldId ||
    cellResult.recipeRevision !== expected.recipeRevision ||
    cellResult.recordId !== expected.recordId ||
    cellResult.runId !== expected.runId ||
    cellResult.status !== expected.status
  ) {
    throw new DatabasePayloadError(
      "The stored cell result identity does not match its relational evidence."
    );
  }
  return cellResult;
};
