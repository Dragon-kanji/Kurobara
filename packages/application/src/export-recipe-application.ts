import { createHash } from "node:crypto";

import {
  type CellResult,
  type ContentHash,
  contentHash,
  createCellResult,
  type Dataset,
  type Record as DatasetRecord,
  type DomainResult,
  type EnrichmentRecipe,
  type Field,
  type FieldId,
  fail,
  type RecordId,
  type ScalarValue,
  succeed,
} from "@kurobara/kernel";
import type {
  DatasetCodecPort,
  DatasetEncodeEvent,
  DatasetEncodeInput,
  DatasetFieldCodecSpec,
  DatasetImportFormat,
  DatasetPersistencePort,
  ExactRecipeProjectionRow,
  RecipeApplication,
  RecipeApplicationId,
  RecipePersistencePort,
  StoredDataset,
  VerifiedApiKey,
  WorkspaceScope,
} from "@kurobara/ports";

import { canonicalContentHash } from "./canonical-content-hash.ts";

export type ExportRecipeApplicationRequest = Readonly<{
  actor: VerifiedApiKey;
  fieldIds?: readonly FieldId[];
  format: DatasetImportFormat;
  recipeApplicationId: RecipeApplicationId;
}>;

export type ExportRecipeApplicationFailureCode =
  | "authority-permission-missing"
  | "codec-configuration-invalid"
  | "dataset-not-ready"
  | "dataset-not-found"
  | "export-too-large"
  | "field-selection-invalid"
  | "recipe-application-not-found"
  | "recipe-not-found"
  | "recipe-projection-count-mismatch"
  | "recipe-projection-duplicate"
  | "recipe-projection-identity-mismatch"
  | "recipe-projection-incomplete"
  | "recipe-projection-invalid"
  | "sparse-csv-unsupported";

export type ExportRecipeApplicationFailure = Readonly<{
  code: ExportRecipeApplicationFailureCode;
  message: string;
}>;

export type RecipeApplicationExport = Readonly<{
  application: RecipeApplication;
  contentHash: ContentHash;
  contentLength: number;
  dataset: Dataset;
  events: AsyncIterable<DatasetEncodeEvent>;
  fields: readonly Field[];
  format: DatasetImportFormat;
  recipe: EnrichmentRecipe;
}>;

export type ExportRecipeApplicationResult = DomainResult<
  RecipeApplicationExport,
  ExportRecipeApplicationFailure
>;

export type ExportRecipeApplicationDependencies = Readonly<{
  codecs: Readonly<Record<DatasetImportFormat, DatasetCodecPort>>;
  datasets: DatasetPersistencePort;
  maxExportBytes: number;
  maxRecordBytes: number;
  persistence: RecipePersistencePort;
  requiredPermission: string;
}>;

type ExactMetadata = Readonly<{
  application: RecipeApplication;
  recipe: EnrichmentRecipe;
}>;

type ProjectionProof = Readonly<{
  cellResultId: CellResult["cellResultId"];
  projectionHash: ReturnType<typeof canonicalContentHash>;
  recordId: RecordId;
  runId: CellResult["runId"];
}>;

type ProjectionPreflight = DomainResult<
  readonly ProjectionProof[],
  ExportRecipeApplicationFailure
>;

type EncodedContentProof = Readonly<{
  contentHash: ContentHash;
  contentLength: number;
}>;

type SelectedApplicationDataset = Readonly<{
  dataset: Dataset;
  fields: readonly Field[];
  storedFields: readonly Field[];
}>;

const rejected = (
  code: ExportRecipeApplicationFailureCode,
  message: string
): DomainResult<never, ExportRecipeApplicationFailure> =>
  fail({ code, message });

const sameOrderedIdentities = (
  left: readonly RecordId[],
  right: readonly RecordId[]
): boolean =>
  left.length === right.length &&
  left.every((recordId, index) => recordId === right[index]);

const applicationMatches = (
  candidate: RecipeApplication,
  expected: RecipeApplication
): boolean =>
  candidate.createdAt === expected.createdAt &&
  candidate.datasetId === expected.datasetId &&
  candidate.graphHash === expected.graphHash &&
  candidate.intentHash === expected.intentHash &&
  candidate.maxCells === expected.maxCells &&
  candidate.recipeApplicationId === expected.recipeApplicationId &&
  candidate.recipeId === expected.recipeId &&
  candidate.recipeRevision === expected.recipeRevision &&
  candidate.targetFieldId === expected.targetFieldId &&
  candidate.workspaceId === expected.workspaceId &&
  sameOrderedIdentities(candidate.graph.recordIds, expected.graph.recordIds);

const recipeMatchesApplication = (
  recipe: EnrichmentRecipe,
  application: RecipeApplication
): boolean =>
  recipe.workspaceId === application.workspaceId &&
  recipe.datasetId === application.datasetId &&
  recipe.enrichmentRecipeId === application.recipeId &&
  recipe.recipeRevision === application.recipeRevision &&
  recipe.targetFieldId === application.targetFieldId;

const selectFields = (
  fields: readonly Field[],
  requested: readonly FieldId[] | undefined
): readonly Field[] | undefined => {
  const selectedIds = requested ?? fields.map((field) => field.fieldId);
  if (
    selectedIds.length === 0 ||
    new Set(selectedIds).size !== selectedIds.length
  ) {
    return;
  }
  const byId = new Map(fields.map((field) => [field.fieldId, field]));
  if (byId.size !== fields.length) {
    return;
  }
  const selected: Field[] = [];
  for (const fieldId of selectedIds) {
    const field = byId.get(fieldId);
    if (field === undefined) {
      return;
    }
    selected.push(field);
  }
  return selected;
};

const validateApplicationDataset = (
  stored: StoredDataset | undefined,
  scope: WorkspaceScope,
  application: RecipeApplication,
  requestedFieldIds: readonly FieldId[] | undefined
): DomainResult<SelectedApplicationDataset, ExportRecipeApplicationFailure> => {
  if (
    stored === undefined ||
    stored.dataset.workspaceId !== scope.workspaceId ||
    stored.dataset.datasetId !== application.datasetId ||
    stored.materialization.workspaceId !== scope.workspaceId ||
    stored.materialization.datasetId !== application.datasetId
  ) {
    return rejected(
      "dataset-not-found",
      "The application dataset does not exist in this workspace."
    );
  }
  if (stored.materialization.state !== "ready") {
    return rejected(
      "dataset-not-ready",
      "Recipe applications can be exported only from a ready dataset materialization."
    );
  }
  const fields = selectFields(stored.fields, requestedFieldIds);
  if (fields === undefined) {
    return rejected(
      "field-selection-invalid",
      "Requested export fields must be non-empty, unique, and belong to the application dataset."
    );
  }
  return succeed({
    dataset: stored.dataset,
    fields,
    storedFields: stored.fields,
  });
};

const codecFields = (
  fields: readonly Field[]
): readonly DatasetFieldCodecSpec[] =>
  fields.map((field) => ({
    fieldId: field.fieldId,
    key: field.key,
    valueType: field.valueType,
  }));

const rowHasExactIdentity = (
  row: ExactRecipeProjectionRow,
  metadata: ExactMetadata,
  expectedRecordId: RecordId
): boolean =>
  applicationMatches(row.application, metadata.application) &&
  row.record.workspaceId === metadata.application.workspaceId &&
  row.record.datasetId === metadata.application.datasetId &&
  row.record.recordId === expectedRecordId &&
  row.cellResult.workspaceId === metadata.application.workspaceId &&
  row.cellResult.datasetId === metadata.application.datasetId &&
  row.cellResult.recordId === expectedRecordId &&
  row.cellResult.enrichmentRecipeId === metadata.application.recipeId &&
  row.cellResult.recipeRevision === metadata.application.recipeRevision &&
  row.cellResult.fieldId === metadata.application.targetFieldId;

const projectionHash = (row: ExactRecipeProjectionRow) =>
  canonicalContentHash({
    binding: row.binding,
    cellResult: row.cellResult,
    record: row.record,
    recordContentHash: row.recordContentHash,
  });

const proofForRow = (row: ExactRecipeProjectionRow): ProjectionProof => ({
  cellResultId: row.cellResult.cellResultId,
  projectionHash: projectionHash(row),
  recordId: row.record.recordId,
  runId: row.cellResult.runId,
});

const preflightProjection = async (
  persistence: RecipePersistencePort,
  scope: WorkspaceScope,
  metadata: ExactMetadata,
  dataset: Dataset,
  fields: readonly Field[]
): Promise<ProjectionPreflight> => {
  const expectedRecordIds = metadata.application.graph.recordIds;
  if (new Set(expectedRecordIds).size !== expectedRecordIds.length) {
    return rejected(
      "recipe-projection-duplicate",
      "The immutable recipe application contains duplicate record identities."
    );
  }

  const proofs: ProjectionProof[] = [];
  const seenRecordIds = new Set<RecordId>();
  const seenCellResultIds = new Set<CellResult["cellResultId"]>();
  const seenRunIds = new Set<CellResult["runId"]>();
  try {
    for await (const row of persistence.streamExactProjection(
      scope,
      metadata.application.recipeApplicationId
    )) {
      if (
        seenRecordIds.has(row.record.recordId) ||
        seenCellResultIds.has(row.cellResult.cellResultId) ||
        seenRunIds.has(row.cellResult.runId)
      ) {
        return rejected(
          "recipe-projection-duplicate",
          "The exact recipe projection contains duplicate durable identities."
        );
      }
      const expectedRecordId = expectedRecordIds[proofs.length];
      if (expectedRecordId === undefined) {
        return rejected(
          "recipe-projection-count-mismatch",
          "The exact recipe projection contains more rows than its immutable application graph."
        );
      }
      if (!rowHasExactIdentity(row, metadata, expectedRecordId)) {
        return rejected(
          "recipe-projection-identity-mismatch",
          "An exact recipe projection row does not match its immutable application identity and order."
        );
      }
      const validated = createCellResult(
        dataset,
        fields,
        row.record,
        metadata.recipe,
        row.cellResult
      );
      if (!validated.ok) {
        return rejected(
          "recipe-projection-invalid",
          "An exact recipe projection row failed cell-result validation."
        );
      }
      if (
        validated.value.status !== "succeeded" ||
        !Object.hasOwn(validated.value, "value") ||
        validated.value.value === undefined
      ) {
        return rejected(
          "recipe-projection-incomplete",
          "Every exported recipe cell must have one explicit succeeded value."
        );
      }
      seenRecordIds.add(row.record.recordId);
      seenCellResultIds.add(row.cellResult.cellResultId);
      seenRunIds.add(row.cellResult.runId);
      proofs.push(proofForRow(row));
    }
  } catch {
    return rejected(
      "recipe-projection-invalid",
      "The exact recipe projection could not be validated."
    );
  }

  if (proofs.length !== expectedRecordIds.length) {
    return rejected(
      "recipe-projection-count-mismatch",
      "The exact recipe projection does not cover its immutable application graph."
    );
  }
  return succeed(proofs);
};

const sameProof = (
  row: ExactRecipeProjectionRow,
  proof: ProjectionProof
): boolean =>
  row.record.recordId === proof.recordId &&
  row.cellResult.cellResultId === proof.cellResultId &&
  row.cellResult.runId === proof.runId &&
  projectionHash(row) === proof.projectionHash;

export class RecipeApplicationExportInvariantError extends Error {
  readonly code = "recipe-application-export-drift";

  constructor() {
    super("The recipe-application export did not match its preflight proof.");
    this.name = "RecipeApplicationExportInvariantError";
  }
}

const overlaidRecord = (
  row: ExactRecipeProjectionRow,
  fields: readonly Field[],
  targetFieldId: FieldId,
  targetValue: ScalarValue
): DatasetRecord => {
  const values = fields.flatMap((field) => {
    if (field.fieldId === targetFieldId) {
      return [{ fieldId: field.fieldId, value: targetValue }];
    }
    const baseValue = row.record.values.find(
      (entry) => entry.fieldId === field.fieldId
    );
    return baseValue === undefined ? [] : [baseValue];
  });
  return { ...row.record, values };
};

const exactOverlaidRecords = (
  persistence: RecipePersistencePort,
  scope: WorkspaceScope,
  metadata: ExactMetadata,
  fields: readonly Field[],
  proofs: readonly ProjectionProof[]
): AsyncIterable<DatasetRecord> => ({
  async *[Symbol.asyncIterator]() {
    let index = 0;
    try {
      for await (const row of persistence.streamExactProjection(
        scope,
        metadata.application.recipeApplicationId
      )) {
        const proof = proofs[index];
        if (
          proof === undefined ||
          !rowHasExactIdentity(row, metadata, proof.recordId) ||
          row.cellResult.status !== "succeeded" ||
          !Object.hasOwn(row.cellResult, "value") ||
          row.cellResult.value === undefined ||
          !sameProof(row, proof)
        ) {
          throw new RecipeApplicationExportInvariantError();
        }
        yield overlaidRecord(
          row,
          fields,
          metadata.application.targetFieldId,
          row.cellResult.value
        );
        index += 1;
      }
      if (index !== proofs.length) {
        throw new RecipeApplicationExportInvariantError();
      }
    } catch (error) {
      if (error instanceof RecipeApplicationExportInvariantError) {
        throw error;
      }
      throw new RecipeApplicationExportInvariantError();
    }
  },
});

const encodeInput = (
  dataset: Dataset,
  fields: readonly Field[],
  maxRecordBytes: number,
  records: AsyncIterable<DatasetRecord>
): DatasetEncodeInput => ({
  datasetId: dataset.datasetId,
  fields: codecFields(fields),
  maxRecordBytes,
  records,
  workspaceId: dataset.workspaceId,
});

const exportTooLarge = (): DomainResult<
  never,
  ExportRecipeApplicationFailure
> =>
  rejected(
    "export-too-large",
    "The encoded recipe-application export exceeds its configured byte limit."
  );

const codecInvalid = (): DomainResult<never, ExportRecipeApplicationFailure> =>
  rejected(
    "codec-configuration-invalid",
    "The selected dataset codec could not produce a valid export stream."
  );

const preflightEncodedContent = async (
  codec: DatasetCodecPort,
  input: DatasetEncodeInput,
  maxExportBytes: number
): Promise<
  DomainResult<EncodedContentProof, ExportRecipeApplicationFailure>
> => {
  const digest = createHash("sha256");
  let contentLength = 0;
  try {
    for await (const event of codec.encode(input)) {
      if (event.type === "error") {
        return event.error.code === "record-too-large"
          ? exportTooLarge()
          : codecInvalid();
      }
      if (!(event.bytes instanceof Uint8Array)) {
        return codecInvalid();
      }
      if (event.bytes.byteLength > maxExportBytes - contentLength) {
        return exportTooLarge();
      }
      contentLength += event.bytes.byteLength;
      digest.update(event.bytes);
    }
  } catch (error) {
    if (error instanceof RecipeApplicationExportInvariantError) {
      return rejected(
        "recipe-projection-invalid",
        "The exact recipe projection changed while the export was validated."
      );
    }
    return codecInvalid();
  }
  return succeed({
    contentHash: contentHash(`sha256:${digest.digest("hex")}`),
    contentLength,
  });
};

type EncodedChunk = Extract<DatasetEncodeEvent, Readonly<{ type: "chunk" }>>;

interface EncodedContentAccumulator {
  contentLength: number;
  digest: ReturnType<typeof createHash>;
}

const accumulateEncodedChunk = (
  event: DatasetEncodeEvent,
  accumulator: EncodedContentAccumulator,
  maxExportBytes: number
): EncodedChunk | undefined => {
  if (event.type !== "chunk" || !(event.bytes instanceof Uint8Array)) {
    throw new RecipeApplicationExportInvariantError();
  }
  if (event.bytes.byteLength > maxExportBytes - accumulator.contentLength) {
    throw new RecipeApplicationExportInvariantError();
  }
  const bytes =
    event.bytes.byteLength === 0 ? event.bytes : event.bytes.slice();
  accumulator.contentLength += bytes.byteLength;
  accumulator.digest.update(bytes);
  return bytes.byteLength === 0 ? undefined : { ...event, bytes };
};

const assertEncodedContentProof = (
  accumulator: EncodedContentAccumulator,
  expected: EncodedContentProof
): void => {
  const observedHash = contentHash(
    `sha256:${accumulator.digest.digest("hex")}`
  );
  if (
    accumulator.contentLength !== expected.contentLength ||
    observedHash !== expected.contentHash
  ) {
    throw new RecipeApplicationExportInvariantError();
  }
};

const verifiedEncodedEvents = (
  codec: DatasetCodecPort,
  makeInput: () => DatasetEncodeInput,
  maxExportBytes: number,
  expected: EncodedContentProof
): AsyncIterable<DatasetEncodeEvent> => ({
  async *[Symbol.asyncIterator]() {
    const accumulator: EncodedContentAccumulator = {
      contentLength: 0,
      digest: createHash("sha256"),
    };
    let pendingChunk: EncodedChunk | undefined;
    try {
      for await (const event of codec.encode(makeInput())) {
        const chunk = accumulateEncodedChunk(
          event,
          accumulator,
          maxExportBytes
        );
        if (chunk === undefined) {
          continue;
        }
        if (pendingChunk !== undefined) {
          yield pendingChunk;
        }
        pendingChunk = chunk;
      }
      assertEncodedContentProof(accumulator, expected);
      if (pendingChunk !== undefined) {
        yield pendingChunk;
      }
    } catch (error) {
      if (error instanceof RecipeApplicationExportInvariantError) {
        throw error;
      }
      throw new RecipeApplicationExportInvariantError();
    }
  },
});

const loadExactMetadata = (
  persistence: RecipePersistencePort,
  scope: WorkspaceScope,
  recipeApplicationId: RecipeApplicationId
): Promise<DomainResult<ExactMetadata, ExportRecipeApplicationFailure>> =>
  persistence.transaction(scope, async (unitOfWork) => {
    const application = await unitOfWork.applications.get(
      scope,
      recipeApplicationId
    );
    if (
      application === undefined ||
      application.workspaceId !== scope.workspaceId ||
      application.recipeApplicationId !== recipeApplicationId
    ) {
      return rejected(
        "recipe-application-not-found",
        "The recipe application does not exist in this workspace."
      );
    }
    const recipe = await unitOfWork.recipes.get(
      scope,
      application.datasetId,
      application.recipeId,
      application.recipeRevision
    );
    if (
      recipe === undefined ||
      !recipeMatchesApplication(recipe, application)
    ) {
      return rejected(
        "recipe-not-found",
        "The exact enrichment recipe revision does not exist in this application scope."
      );
    }
    return succeed({ application, recipe });
  });

export const makeExportRecipeApplication = (
  dependencies: ExportRecipeApplicationDependencies
) => {
  const limitsAreValid =
    Number.isSafeInteger(dependencies.maxRecordBytes) &&
    dependencies.maxRecordBytes > 0 &&
    Number.isSafeInteger(dependencies.maxExportBytes) &&
    dependencies.maxExportBytes > 0;

  return async function exportRecipeApplication(
    request: ExportRecipeApplicationRequest
  ): Promise<ExportRecipeApplicationResult> {
    if (!limitsAreValid) {
      return rejected(
        "codec-configuration-invalid",
        "Recipe-application export byte limits are not configured correctly."
      );
    }
    if (!request.actor.permissions.includes(dependencies.requiredPermission)) {
      return rejected(
        "authority-permission-missing",
        "The authenticated actor lacks permission to export recipe applications."
      );
    }
    const codec = dependencies.codecs[request.format];
    if (codec === undefined || codec.format !== request.format) {
      return rejected(
        "codec-configuration-invalid",
        "The selected dataset codec is not configured for this format."
      );
    }

    const scope = { workspaceId: request.actor.workspaceId } as const;
    const metadata = await loadExactMetadata(
      dependencies.persistence,
      scope,
      request.recipeApplicationId
    );
    if (!metadata.ok) {
      return metadata;
    }
    const stored = await dependencies.datasets.getDataset(
      scope,
      metadata.value.application.datasetId
    );
    const selectedDataset = validateApplicationDataset(
      stored,
      scope,
      metadata.value.application,
      request.fieldIds
    );
    if (!selectedDataset.ok) {
      return selectedDataset;
    }
    const { dataset, fields, storedFields } = selectedDataset.value;

    const preflight = await preflightProjection(
      dependencies.persistence,
      scope,
      metadata.value,
      dataset,
      storedFields
    );
    if (!preflight.ok) {
      return preflight;
    }

    const baseCsvFields = fields.filter(
      (field) => field.fieldId !== metadata.value.application.targetFieldId
    );
    if (
      request.format === "csv" &&
      baseCsvFields.length > 0 &&
      !(await dependencies.datasets.isFieldSetComplete(
        scope,
        dataset.datasetId,
        baseCsvFields.map((field) => field.fieldId)
      ))
    ) {
      return rejected(
        "sparse-csv-unsupported",
        "CSV export requires every selected base field to be present in every application record."
      );
    }

    const makeEncodeInput = (): DatasetEncodeInput =>
      encodeInput(
        dataset,
        fields,
        dependencies.maxRecordBytes,
        exactOverlaidRecords(
          dependencies.persistence,
          scope,
          metadata.value,
          fields,
          preflight.value
        )
      );
    const encodedPreflight = await preflightEncodedContent(
      codec,
      makeEncodeInput(),
      dependencies.maxExportBytes
    );
    if (!encodedPreflight.ok) {
      return encodedPreflight;
    }

    const events = verifiedEncodedEvents(
      codec,
      makeEncodeInput,
      dependencies.maxExportBytes,
      encodedPreflight.value
    );
    return succeed({
      application: metadata.value.application,
      contentHash: encodedPreflight.value.contentHash,
      contentLength: encodedPreflight.value.contentLength,
      dataset,
      events,
      fields,
      format: request.format,
      recipe: metadata.value.recipe,
    });
  };
};
