import { type DomainResult, fail, succeed } from "./result.ts";
import type {
  CellResultId,
  ContentHash,
  DatasetId,
  EnrichmentRecipeId,
  FieldId,
  Instant,
  RecordId,
  RunId,
  WorkflowSpecId,
  WorkspaceId,
} from "./value-objects.ts";

const MAX_NAME_LENGTH = 255;
const MAX_DATASET_FIELDS = 256;
const MAX_FIELD_KEY_LENGTH = 128;
const MAX_SCALAR_STRING_LENGTH = 16_384;
const MAX_SCALAR_NUMBER = 1_000_000_000_000_000;
const MAX_RECORD_VALUES = 256;
const MAX_RECIPE_INPUTS = 64;
const MAX_PROVENANCE_REFERENCES = 32;
const MAX_PROVENANCE_REFERENCE_LENGTH = 2048;
const MAX_REASON_CODE_LENGTH = 128;
const MAX_REASON_MESSAGE_LENGTH = 1024;
const MAX_COST_UNIT_LENGTH = 64;

const FIELD_KEY_PATTERN = /^[a-z][a-z0-9_]*$/u;
const COST_UNIT_PATTERN = /^[a-z][a-z0-9._-]*$/u;
const REDACTED_REASON_CODE_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;
const CONTENT_HASH_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const CELL_RESULT_STATUSES = new Set([
  "failed",
  "pending",
  "running",
  "skipped",
  "succeeded",
]);

export type ScalarValue = boolean | null | number | string;
export type FieldValueType = "boolean" | "number" | "string";

export type Dataset = Readonly<{
  datasetId: DatasetId;
  name: string;
  workspaceId: WorkspaceId;
}>;

export type Field = Readonly<{
  datasetId: DatasetId;
  fieldId: FieldId;
  key: string;
  label: string;
  valueType: FieldValueType;
  workspaceId: WorkspaceId;
}>;

export type RecordValue = Readonly<{
  fieldId: FieldId;
  value: ScalarValue;
}>;

export type Record = Readonly<{
  datasetId: DatasetId;
  recordId: RecordId;
  values: readonly RecordValue[];
  workspaceId: WorkspaceId;
}>;

export type EnrichmentRecipe = Readonly<{
  datasetId: DatasetId;
  enrichmentRecipeId: EnrichmentRecipeId;
  inputFieldIds: readonly FieldId[];
  name: string;
  recipeRevision: string;
  targetFieldId: FieldId;
  workflowContentHash: ContentHash;
  workflowRevision: string;
  workflowSpecId: WorkflowSpecId;
  workspaceId: WorkspaceId;
}>;

export type CellResultStatus =
  | "pending"
  | "running"
  | "succeeded"
  | "failed"
  | "skipped";

export type CellResultProvenance = Readonly<{
  references: readonly string[];
}>;

export type CellResultFreshness = Readonly<{
  observedAt: Instant;
  expiresAt?: Instant;
}>;

export type CellResultCost = Readonly<{
  amount: number;
  basis: "estimated" | "exact";
  unit: string;
}>;

export type CellResultReason = Readonly<{
  code: string;
  message: string;
  retryable: boolean;
}>;

export type CellResult = Readonly<{
  cellResultId: CellResultId;
  datasetId: DatasetId;
  enrichmentRecipeId: EnrichmentRecipeId;
  fieldId: FieldId;
  recipeRevision: string;
  recordId: RecordId;
  runId: RunId;
  status: CellResultStatus;
  workspaceId: WorkspaceId;
  confidence?: number;
  cost?: CellResultCost;
  freshness?: CellResultFreshness;
  provenance?: CellResultProvenance;
  reason?: CellResultReason;
  value?: ScalarValue;
}>;

export type ProductFailureCode =
  | "cell-result-confidence-invalid"
  | "cell-result-cost-invalid"
  | "cell-result-freshness-invalid"
  | "cell-result-provenance-invalid"
  | "cell-result-reason-invalid"
  | "cell-result-recipe-revision-mismatch"
  | "cell-result-scope-mismatch"
  | "cell-result-status-invalid"
  | "cell-result-target-mismatch"
  | "cell-result-value-invalid"
  | "dataset-name-invalid"
  | "field-collection-invalid"
  | "field-key-invalid"
  | "field-label-invalid"
  | "field-scope-mismatch"
  | "field-value-type-invalid"
  | "product-identity-invalid"
  | "record-scope-mismatch"
  | "record-too-large"
  | "record-value-duplicate"
  | "record-value-field-unknown"
  | "record-value-invalid"
  | "record-value-type-mismatch"
  | "recipe-input-duplicate"
  | "recipe-input-required"
  | "recipe-input-target-conflict"
  | "recipe-input-unknown"
  | "recipe-name-invalid"
  | "recipe-revision-invalid"
  | "recipe-scope-mismatch"
  | "recipe-target-unknown"
  | "recipe-workflow-hash-invalid"
  | "recipe-workflow-revision-invalid";

export type ProductFailure = Readonly<{
  code: ProductFailureCode;
  message: string;
}>;

const reject = (
  code: ProductFailureCode,
  message: string
): DomainResult<never, ProductFailure> => fail({ code, message });

const codePointLength = (value: string): number => {
  let length = 0;
  for (const _character of value) {
    length += 1;
  }
  return length;
};

const isBoundedText = (value: string, maximum: number): boolean =>
  value.trim().length > 0 && codePointLength(value) <= maximum;

const isBoundedIdentity = (value: string): boolean =>
  isBoundedText(value, MAX_NAME_LENGTH);

const isBoundedScalar = (value: unknown): value is ScalarValue =>
  value === null ||
  typeof value === "boolean" ||
  (typeof value === "string" &&
    codePointLength(value) <= MAX_SCALAR_STRING_LENGTH) ||
  (typeof value === "number" &&
    Number.isFinite(value) &&
    value >= -MAX_SCALAR_NUMBER &&
    value <= MAX_SCALAR_NUMBER);

const valueMatchesField = (value: ScalarValue, field: Field): boolean =>
  value === null || typeof value === field.valueType;

const hasDatasetScope = (
  dataset: Dataset,
  candidate: Readonly<{ datasetId: DatasetId; workspaceId: WorkspaceId }>
): boolean =>
  candidate.datasetId === dataset.datasetId &&
  candidate.workspaceId === dataset.workspaceId;

const validateField = (
  dataset: Dataset,
  field: Field
): DomainResult<undefined, ProductFailure> => {
  if (!isBoundedIdentity(field.fieldId)) {
    return reject(
      "product-identity-invalid",
      "Product identities must contain between 1 and 255 characters."
    );
  }
  if (!hasDatasetScope(dataset, field)) {
    return reject(
      "field-scope-mismatch",
      "A field must belong to the dataset workspace and identity."
    );
  }
  if (
    field.key.length > MAX_FIELD_KEY_LENGTH ||
    !FIELD_KEY_PATTERN.test(field.key)
  ) {
    return reject(
      "field-key-invalid",
      "A field key must start with a lowercase letter and contain only lowercase letters, digits, or underscores."
    );
  }
  if (!isBoundedText(field.label, MAX_NAME_LENGTH)) {
    return reject(
      "field-label-invalid",
      "A field label must contain between 1 and 255 characters."
    );
  }
  if (!(["boolean", "number", "string"] as const).includes(field.valueType)) {
    return reject(
      "field-value-type-invalid",
      "A field value type must be string, number, or boolean."
    );
  }
  return succeed(undefined);
};

const indexFields = (
  dataset: Dataset,
  fields: readonly Field[]
): DomainResult<ReadonlyMap<FieldId, Field>, ProductFailure> => {
  if (fields.length > MAX_DATASET_FIELDS) {
    return reject(
      "field-collection-invalid",
      "A dataset cannot contain more than 256 fields."
    );
  }
  const fieldsById = new Map<FieldId, Field>();
  const fieldKeys = new Set<string>();
  for (const field of fields) {
    const validated = validateField(dataset, field);
    if (!validated.ok) {
      return validated;
    }
    if (fieldsById.has(field.fieldId) || fieldKeys.has(field.key)) {
      return reject(
        "field-collection-invalid",
        "Field identifiers and keys must be unique within a dataset."
      );
    }
    fieldsById.set(field.fieldId, field);
    fieldKeys.add(field.key);
  }
  return succeed(fieldsById);
};

export const createDataset = (
  input: Dataset
): DomainResult<Dataset, ProductFailure> => {
  if (
    !(
      isBoundedIdentity(input.datasetId) && isBoundedIdentity(input.workspaceId)
    )
  ) {
    return reject(
      "product-identity-invalid",
      "Product identities must contain between 1 and 255 characters."
    );
  }
  if (!isBoundedText(input.name, MAX_NAME_LENGTH)) {
    return reject(
      "dataset-name-invalid",
      "A dataset name must contain between 1 and 255 characters."
    );
  }
  return succeed({ ...input });
};

export const createField = (
  dataset: Dataset,
  input: Field
): DomainResult<Field, ProductFailure> => {
  const validated = validateField(dataset, input);
  if (!validated.ok) {
    return validated;
  }
  return succeed({ ...input });
};

export const validateDatasetFields = (
  dataset: Dataset,
  fields: readonly Field[]
): DomainResult<readonly Field[], ProductFailure> => {
  const indexed = indexFields(dataset, fields);
  if (!indexed.ok) {
    return indexed;
  }
  return succeed(fields.map((field) => ({ ...field })));
};

export const createRecord = (
  dataset: Dataset,
  fields: readonly Field[],
  input: Record
): DomainResult<Record, ProductFailure> => {
  if (!isBoundedIdentity(input.recordId)) {
    return reject(
      "product-identity-invalid",
      "Product identities must contain between 1 and 255 characters."
    );
  }
  if (!hasDatasetScope(dataset, input)) {
    return reject(
      "record-scope-mismatch",
      "A record must belong to the dataset workspace and identity."
    );
  }
  if (input.values.length > MAX_RECORD_VALUES) {
    return reject(
      "record-too-large",
      "A record cannot contain more than 256 field values."
    );
  }
  const indexed = indexFields(dataset, fields);
  if (!indexed.ok) {
    return indexed;
  }
  const seen = new Set<FieldId>();
  for (const entry of input.values) {
    if (seen.has(entry.fieldId)) {
      return reject(
        "record-value-duplicate",
        "A record can contain at most one value for each field."
      );
    }
    seen.add(entry.fieldId);
    const field = indexed.value.get(entry.fieldId);
    if (field === undefined) {
      return reject(
        "record-value-field-unknown",
        "Every record value must reference a field in the same dataset."
      );
    }
    if (!isBoundedScalar(entry.value)) {
      return reject(
        "record-value-invalid",
        "A record value must be a bounded string, number, boolean, or explicit null."
      );
    }
    if (!valueMatchesField(entry.value, field)) {
      return reject(
        "record-value-type-mismatch",
        "A non-null record value must match its field value type."
      );
    }
  }
  return succeed({
    ...input,
    values: input.values.map((entry) => ({ ...entry })),
  });
};

export const createEnrichmentRecipe = (
  dataset: Dataset,
  fields: readonly Field[],
  input: EnrichmentRecipe
): DomainResult<EnrichmentRecipe, ProductFailure> => {
  if (
    !(
      isBoundedIdentity(input.enrichmentRecipeId) &&
      isBoundedIdentity(input.workflowSpecId)
    )
  ) {
    return reject(
      "product-identity-invalid",
      "Product identities must contain between 1 and 255 characters."
    );
  }
  if (!hasDatasetScope(dataset, input)) {
    return reject(
      "recipe-scope-mismatch",
      "An enrichment recipe must belong to the dataset workspace and identity."
    );
  }
  if (!isBoundedText(input.name, MAX_NAME_LENGTH)) {
    return reject(
      "recipe-name-invalid",
      "An enrichment recipe name must contain between 1 and 255 characters."
    );
  }
  if (!isBoundedText(input.recipeRevision, MAX_NAME_LENGTH)) {
    return reject(
      "recipe-revision-invalid",
      "An enrichment recipe requires an exact non-empty recipe revision."
    );
  }
  if (!CONTENT_HASH_PATTERN.test(input.workflowContentHash)) {
    return reject(
      "recipe-workflow-hash-invalid",
      "An enrichment recipe requires the exact SHA-256 content hash of its workflow."
    );
  }
  if (!isBoundedText(input.workflowRevision, MAX_NAME_LENGTH)) {
    return reject(
      "recipe-workflow-revision-invalid",
      "An enrichment recipe requires an exact non-empty workflow revision."
    );
  }
  if (
    input.inputFieldIds.length === 0 ||
    input.inputFieldIds.length > MAX_RECIPE_INPUTS
  ) {
    return reject(
      "recipe-input-required",
      "An enrichment recipe requires between 1 and 64 input fields."
    );
  }
  const indexed = indexFields(dataset, fields);
  if (!indexed.ok) {
    return indexed;
  }
  if (!indexed.value.has(input.targetFieldId)) {
    return reject(
      "recipe-target-unknown",
      "An enrichment recipe target must reference a field in the same dataset."
    );
  }
  const inputs = new Set(input.inputFieldIds);
  if (inputs.size !== input.inputFieldIds.length) {
    return reject(
      "recipe-input-duplicate",
      "An enrichment recipe input field can appear only once."
    );
  }
  if (inputs.has(input.targetFieldId)) {
    return reject(
      "recipe-input-target-conflict",
      "An enrichment recipe cannot use its target field as an input."
    );
  }
  if (input.inputFieldIds.some((fieldId) => !indexed.value.has(fieldId))) {
    return reject(
      "recipe-input-unknown",
      "Every enrichment recipe input must reference a field in the same dataset."
    );
  }
  return succeed({ ...input, inputFieldIds: [...input.inputFieldIds] });
};

const validateProvenance = (
  provenance: CellResultProvenance | undefined
): DomainResult<undefined, ProductFailure> => {
  if (provenance === undefined) {
    return succeed(undefined);
  }
  const { references } = provenance;
  if (
    references.length === 0 ||
    references.length > MAX_PROVENANCE_REFERENCES ||
    new Set(references).size !== references.length ||
    references.some(
      (reference) => !isBoundedText(reference, MAX_PROVENANCE_REFERENCE_LENGTH)
    )
  ) {
    return reject(
      "cell-result-provenance-invalid",
      "Cell-result provenance requires between 1 and 32 unique bounded references."
    );
  }
  return succeed(undefined);
};

const validateFreshness = (
  freshness: CellResultFreshness | undefined
): DomainResult<undefined, ProductFailure> => {
  if (freshness === undefined) {
    return succeed(undefined);
  }
  if (
    !Number.isSafeInteger(freshness.observedAt) ||
    freshness.observedAt < 0 ||
    (freshness.expiresAt !== undefined &&
      (!Number.isSafeInteger(freshness.expiresAt) ||
        freshness.expiresAt < freshness.observedAt))
  ) {
    return reject(
      "cell-result-freshness-invalid",
      "Cell-result freshness requires safe non-negative instants and expiration no earlier than observation."
    );
  }
  return succeed(undefined);
};

const validateConfidence = (
  confidence: number | undefined
): DomainResult<undefined, ProductFailure> =>
  confidence === undefined ||
  (Number.isFinite(confidence) && confidence >= 0 && confidence <= 1)
    ? succeed(undefined)
    : reject(
        "cell-result-confidence-invalid",
        "Cell-result confidence must be a finite number between 0 and 1."
      );

const validateCost = (
  cost: CellResultCost | undefined
): DomainResult<undefined, ProductFailure> => {
  if (cost === undefined) {
    return succeed(undefined);
  }
  if (
    cost.unit.length > MAX_COST_UNIT_LENGTH ||
    !COST_UNIT_PATTERN.test(cost.unit) ||
    !Number.isFinite(cost.amount) ||
    cost.amount < 0 ||
    cost.amount > MAX_SCALAR_NUMBER ||
    (cost.basis !== "exact" && cost.basis !== "estimated")
  ) {
    return reject(
      "cell-result-cost-invalid",
      "Cell-result cost requires a bounded non-negative amount, valid unit, and exact or estimated basis."
    );
  }
  return succeed(undefined);
};

const validateCellStatus = (
  input: CellResult,
  target: Field
): DomainResult<undefined, ProductFailure> => {
  if (!CELL_RESULT_STATUSES.has(input.status)) {
    return reject(
      "cell-result-status-invalid",
      "A cell result requires a supported availability status."
    );
  }
  const hasValue = Object.hasOwn(input, "value");
  const claimsReason = Object.hasOwn(input, "reason");
  const hasReason = input.reason !== undefined;
  if (
    input.status === "succeeded" &&
    (!(hasValue && isBoundedScalar(input.value)) || claimsReason)
  ) {
    return reject(
      "cell-result-status-invalid",
      "A succeeded cell result requires one explicit scalar value and no failure reason."
    );
  }
  if (
    (input.status === "failed" || input.status === "skipped") &&
    (!hasReason || hasValue)
  ) {
    return reject(
      "cell-result-status-invalid",
      "A failed or skipped cell result requires a redacted reason and cannot contain a value."
    );
  }
  if (
    (input.status === "pending" || input.status === "running") &&
    (hasValue || claimsReason)
  ) {
    return reject(
      "cell-result-status-invalid",
      "A pending or running cell result cannot claim a terminal value or reason."
    );
  }
  if (
    input.value !== undefined &&
    isBoundedScalar(input.value) &&
    !valueMatchesField(input.value, target)
  ) {
    return reject(
      "cell-result-value-invalid",
      "A non-null cell-result value must match its target field value type."
    );
  }
  if (
    input.reason !== undefined &&
    (input.reason.code.length > MAX_REASON_CODE_LENGTH ||
      !REDACTED_REASON_CODE_PATTERN.test(input.reason.code) ||
      !isBoundedText(input.reason.message, MAX_REASON_MESSAGE_LENGTH) ||
      typeof input.reason.retryable !== "boolean")
  ) {
    return reject(
      "cell-result-reason-invalid",
      "A cell-result reason requires a stable code, bounded redacted message, and retryability flag."
    );
  }
  return succeed(undefined);
};

export const createCellResult = (
  dataset: Dataset,
  fields: readonly Field[],
  record: Record,
  recipe: EnrichmentRecipe,
  input: CellResult
): DomainResult<CellResult, ProductFailure> => {
  if (
    !(isBoundedIdentity(input.cellResultId) && isBoundedIdentity(input.runId))
  ) {
    return reject(
      "product-identity-invalid",
      "Product identities must contain between 1 and 255 characters."
    );
  }
  if (
    !(
      hasDatasetScope(dataset, input) &&
      hasDatasetScope(dataset, record) &&
      hasDatasetScope(dataset, recipe)
    ) ||
    input.recordId !== record.recordId ||
    input.enrichmentRecipeId !== recipe.enrichmentRecipeId
  ) {
    return reject(
      "cell-result-scope-mismatch",
      "A cell result, record, and recipe must share the same dataset scope and identities."
    );
  }
  if (input.recipeRevision !== recipe.recipeRevision) {
    return reject(
      "cell-result-recipe-revision-mismatch",
      "A cell result must reference the exact enrichment recipe revision."
    );
  }
  const indexed = indexFields(dataset, fields);
  if (!indexed.ok) {
    return indexed;
  }
  const target = indexed.value.get(input.fieldId);
  if (target === undefined || input.fieldId !== recipe.targetFieldId) {
    return reject(
      "cell-result-target-mismatch",
      "A cell result must target the recipe field in the same dataset."
    );
  }
  for (const validation of [
    validateCellStatus(input, target),
    validateProvenance(input.provenance),
    validateFreshness(input.freshness),
    validateConfidence(input.confidence),
    validateCost(input.cost),
  ]) {
    if (!validation.ok) {
      return validation;
    }
  }
  return succeed({
    ...input,
    ...(input.cost === undefined ? {} : { cost: { ...input.cost } }),
    ...(input.freshness === undefined
      ? {}
      : { freshness: { ...input.freshness } }),
    ...(input.provenance === undefined
      ? {}
      : {
          provenance: {
            references: [...input.provenance.references],
          },
        }),
    ...(input.reason === undefined ? {} : { reason: { ...input.reason } }),
  });
};
