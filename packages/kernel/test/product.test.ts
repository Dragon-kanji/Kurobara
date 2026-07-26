import assert from "node:assert/strict";
import test from "node:test";

import {
  type CellResult,
  cellResultId,
  contentHash,
  createCellResult,
  createDataset,
  createEnrichmentRecipe,
  createField,
  createRecord,
  type Record as DatasetRecord,
  type DomainResult,
  datasetId,
  enrichmentRecipeId,
  type Field,
  fieldId,
  InvalidValueObjectError,
  instant,
  type ProductFailure,
  type RecordValue,
  recordId,
  runId,
  validateDatasetFields,
  workflowSpecId,
  workspaceId,
} from "../src/index.ts";

const unwrap = <Value>(result: DomainResult<Value, ProductFailure>): Value => {
  if (!result.ok) {
    throw new Error(`${result.error.code}: ${result.error.message}`);
  }
  return result.value;
};

const failureCode = <Value>(
  result: DomainResult<Value, ProductFailure>
): ProductFailure["code"] => {
  if (result.ok) {
    throw new Error("Expected a product-domain failure.");
  }
  return result.error.code;
};

const workspace = workspaceId("workspace-product");
const dataset = unwrap(
  createDataset({
    datasetId: datasetId("dataset-product"),
    name: "Synthetic companies",
    workspaceId: workspace,
  })
);
const otherDataset = unwrap(
  createDataset({
    datasetId: datasetId("dataset-other"),
    name: "Other dataset",
    workspaceId: workspace,
  })
);

const makeField = (
  id: string,
  key: string,
  valueType: Field["valueType"]
): Field =>
  unwrap(
    createField(dataset, {
      datasetId: dataset.datasetId,
      fieldId: fieldId(id),
      key,
      label: key,
      valueType,
      workspaceId: workspace,
    })
  );

const domainField = makeField("field-domain", "company_domain", "string");
const activeField = makeField("field-active", "is_active", "boolean");
const scoreField = makeField("field-score", "company_score", "number");
const categoryField = makeField("field-category", "company_category", "string");
const fields = [domainField, activeField, scoreField, categoryField] as const;

const record = unwrap(
  createRecord(dataset, fields, {
    datasetId: dataset.datasetId,
    recordId: recordId("record-product"),
    values: [
      { fieldId: domainField.fieldId, value: "example.invalid" },
      { fieldId: activeField.fieldId, value: true },
      { fieldId: scoreField.fieldId, value: null },
    ],
    workspaceId: workspace,
  })
);

const recipe = unwrap(
  createEnrichmentRecipe(dataset, fields, {
    datasetId: dataset.datasetId,
    enrichmentRecipeId: enrichmentRecipeId("recipe-category"),
    inputFieldIds: [domainField.fieldId, activeField.fieldId],
    name: "Resolve company category",
    recipeRevision: "1.0.0",
    targetFieldId: categoryField.fieldId,
    workflowContentHash: contentHash(
      "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    ),
    workflowRevision: "1",
    workflowSpecId: workflowSpecId("workflow-company-category"),
    workspaceId: workspace,
  })
);

const succeededCell = {
  cellResultId: cellResultId("cell-result-product"),
  confidence: 0.92,
  cost: { amount: 1.25, basis: "exact" as const, unit: "credits" },
  datasetId: dataset.datasetId,
  enrichmentRecipeId: recipe.enrichmentRecipeId,
  fieldId: categoryField.fieldId,
  freshness: {
    expiresAt: instant(2000),
    observedAt: instant(1000),
  },
  provenance: {
    references: ["artifact:artifact-synthetic", "https://example.invalid"],
  },
  recipeRevision: recipe.recipeRevision,
  recordId: record.recordId,
  runId: runId("run-product"),
  status: "succeeded" as const,
  value: "software",
  workspaceId: workspace,
};

test("rejects empty product identities at their value-object boundary", () => {
  for (const makeId of [
    cellResultId,
    datasetId,
    enrichmentRecipeId,
    fieldId,
    recordId,
  ]) {
    assert.throws(() => makeId(" "), InvalidValueObjectError);
    assert.throws(() => makeId("x".repeat(256)), InvalidValueObjectError);
  }
  assert.doesNotThrow(() => datasetId("🌸".repeat(128)));
});

test("creates the bounded product entities and copies caller-owned collections", () => {
  const values: RecordValue[] = [
    { fieldId: domainField.fieldId, value: "example.invalid" },
  ];
  const createdRecord = unwrap(
    createRecord(dataset, fields, {
      datasetId: dataset.datasetId,
      recordId: recordId("record-copy"),
      values,
      workspaceId: workspace,
    })
  );
  const inputFieldIds = [domainField.fieldId];
  const createdRecipe = unwrap(
    createEnrichmentRecipe(dataset, fields, {
      ...recipe,
      enrichmentRecipeId: enrichmentRecipeId("recipe-copy"),
      inputFieldIds,
    })
  );
  const references = ["artifact:artifact-synthetic"];
  const createdCell = unwrap(
    createCellResult(dataset, fields, record, recipe, {
      ...succeededCell,
      provenance: { references },
    })
  );

  values.push({ fieldId: activeField.fieldId, value: true });
  inputFieldIds.push(activeField.fieldId);
  references.push("https://example.invalid/late");

  assert.deepEqual(createdRecord.values, [
    { fieldId: domainField.fieldId, value: "example.invalid" },
  ]);
  assert.deepEqual(createdRecipe.inputFieldIds, [domainField.fieldId]);
  assert.deepEqual(createdCell.provenance?.references, [
    "artifact:artifact-synthetic",
  ]);
  assert.notStrictEqual(createdCell.cost, succeededCell.cost);
  assert.notStrictEqual(createdCell.freshness, succeededCell.freshness);
});

test("rejects invalid dataset and field definitions", () => {
  assert.equal(
    failureCode(
      createDataset({
        ...dataset,
        workspaceId: workspaceId("w".repeat(256)),
      })
    ),
    "product-identity-invalid"
  );
  assert.equal(
    failureCode(createDataset({ ...dataset, name: " " })),
    "dataset-name-invalid"
  );
  assert.equal(
    failureCode(
      createField(dataset, {
        ...domainField,
        datasetId: otherDataset.datasetId,
      })
    ),
    "field-scope-mismatch"
  );
  assert.equal(
    failureCode(createField(dataset, { ...domainField, key: "Bad-Key" })),
    "field-key-invalid"
  );
  assert.equal(
    failureCode(createField(dataset, { ...domainField, label: "" })),
    "field-label-invalid"
  );
  assert.equal(
    failureCode(
      createField(dataset, {
        ...domainField,
        valueType: "vector" as Field["valueType"],
      })
    ),
    "field-value-type-invalid"
  );
  assert.equal(
    failureCode(
      validateDatasetFields(dataset, [
        domainField,
        { ...domainField, fieldId: fieldId("field-duplicate-key") },
      ])
    ),
    "field-collection-invalid"
  );
  assert.equal(
    failureCode(validateDatasetFields(dataset, [domainField, domainField])),
    "field-collection-invalid"
  );
  assert.equal(
    failureCode(
      validateDatasetFields(
        dataset,
        Array.from({ length: 257 }, (_value, index) => ({
          ...domainField,
          fieldId: fieldId(`field-${index}`),
          key: `field_${index}`,
        }))
      )
    ),
    "field-collection-invalid"
  );
  const validated = unwrap(validateDatasetFields(dataset, fields));
  assert.deepEqual(validated, fields);
  assert.notStrictEqual(validated, fields);
});

test("enforces record field identity, scalar bounds and declared value types", () => {
  const base: DatasetRecord = {
    datasetId: dataset.datasetId,
    recordId: recordId("record-invalid"),
    values: [{ fieldId: domainField.fieldId, value: "example.invalid" }],
    workspaceId: workspace,
  };
  assert.equal(
    createRecord(dataset, fields, {
      ...base,
      values: [{ fieldId: domainField.fieldId, value: "🌸".repeat(16_384) }],
    }).ok,
    true
  );
  assert.equal(
    failureCode(
      createRecord(dataset, fields, {
        ...base,
        values: [{ fieldId: domainField.fieldId, value: "🌸".repeat(16_385) }],
      })
    ),
    "record-value-invalid"
  );
  assert.equal(
    failureCode(
      createRecord(dataset, fields, {
        ...base,
        datasetId: otherDataset.datasetId,
      })
    ),
    "record-scope-mismatch"
  );
  assert.equal(
    failureCode(
      createRecord(dataset, fields, {
        ...base,
        values: [
          base.values[0] as (typeof base.values)[number],
          base.values[0] as (typeof base.values)[number],
        ],
      })
    ),
    "record-value-duplicate"
  );
  assert.equal(
    failureCode(
      createRecord(dataset, fields, {
        ...base,
        values: [{ fieldId: fieldId("field-unknown"), value: "unknown" }],
      })
    ),
    "record-value-field-unknown"
  );
  assert.equal(
    failureCode(
      createRecord(dataset, fields, {
        ...base,
        values: [{ fieldId: domainField.fieldId, value: true }],
      })
    ),
    "record-value-type-mismatch"
  );
  assert.equal(
    failureCode(
      createRecord(dataset, fields, {
        ...base,
        values: [
          {
            fieldId: scoreField.fieldId,
            value: Number.POSITIVE_INFINITY,
          },
        ],
      })
    ),
    "record-value-invalid"
  );
  assert.equal(
    failureCode(
      createRecord(
        dataset,
        [
          domainField,
          {
            ...activeField,
            fieldId: fieldId("field-duplicate-key"),
            key: domainField.key,
          },
        ],
        base
      )
    ),
    "field-collection-invalid"
  );
});

test("requires a non-circular recipe over unique known fields and an exact workflow revision", () => {
  assert.equal(
    failureCode(
      createEnrichmentRecipe(dataset, fields, {
        ...recipe,
        workflowSpecId: workflowSpecId("w".repeat(256)),
      })
    ),
    "product-identity-invalid"
  );
  assert.equal(
    failureCode(
      createEnrichmentRecipe(dataset, fields, {
        ...recipe,
        inputFieldIds: [],
      })
    ),
    "recipe-input-required"
  );
  assert.equal(
    failureCode(
      createEnrichmentRecipe(dataset, fields, {
        ...recipe,
        inputFieldIds: [domainField.fieldId, domainField.fieldId],
      })
    ),
    "recipe-input-duplicate"
  );
  assert.equal(
    failureCode(
      createEnrichmentRecipe(dataset, fields, {
        ...recipe,
        inputFieldIds: [categoryField.fieldId],
      })
    ),
    "recipe-input-target-conflict"
  );
  assert.equal(
    failureCode(
      createEnrichmentRecipe(dataset, fields, {
        ...recipe,
        inputFieldIds: [fieldId("field-unknown")],
      })
    ),
    "recipe-input-unknown"
  );
  assert.equal(
    failureCode(
      createEnrichmentRecipe(dataset, fields, {
        ...recipe,
        targetFieldId: fieldId("field-unknown"),
      })
    ),
    "recipe-target-unknown"
  );
  assert.equal(
    failureCode(
      createEnrichmentRecipe(dataset, fields, {
        ...recipe,
        recipeRevision: " ",
      })
    ),
    "recipe-revision-invalid"
  );
  assert.equal(
    failureCode(
      createEnrichmentRecipe(dataset, fields, {
        ...recipe,
        workflowContentHash: "invalid" as typeof recipe.workflowContentHash,
      })
    ),
    "recipe-workflow-hash-invalid"
  );
  assert.equal(
    failureCode(
      createEnrichmentRecipe(dataset, fields, {
        ...recipe,
        workflowRevision: " ",
      })
    ),
    "recipe-workflow-revision-invalid"
  );
});

test("keeps cell availability aligned with dataset identities and target type", () => {
  const completed = createCellResult(
    dataset,
    fields,
    record,
    recipe,
    succeededCell
  );
  const explicitNull = createCellResult(dataset, fields, record, recipe, {
    ...succeededCell,
    value: null,
  });

  assert.equal(completed.ok, true);
  assert.equal(explicitNull.ok, true);
  assert.equal(
    failureCode(
      createCellResult(dataset, fields, record, recipe, {
        ...succeededCell,
        runId: runId("r".repeat(256)),
      })
    ),
    "product-identity-invalid"
  );
  assert.equal(
    failureCode(
      createCellResult(dataset, fields, record, recipe, {
        ...succeededCell,
        datasetId: otherDataset.datasetId,
      })
    ),
    "cell-result-scope-mismatch"
  );
  assert.equal(
    failureCode(
      createCellResult(dataset, fields, record, recipe, {
        ...succeededCell,
        recipeRevision: "2.0.0",
      })
    ),
    "cell-result-recipe-revision-mismatch"
  );
  assert.equal(
    failureCode(
      createCellResult(dataset, fields, record, recipe, {
        ...succeededCell,
        fieldId: scoreField.fieldId,
      })
    ),
    "cell-result-target-mismatch"
  );
  assert.equal(
    failureCode(
      createCellResult(dataset, fields, record, recipe, {
        ...succeededCell,
        value: 42,
      })
    ),
    "cell-result-value-invalid"
  );
});

test("enforces lean status rules without duplicating the Run lifecycle", () => {
  const { value: _value, ...withoutValue } = succeededCell;
  const reason = {
    code: "provider-unavailable",
    message: "The configured capability is temporarily unavailable.",
    retryable: true,
  };
  const failed = {
    ...withoutValue,
    reason,
    status: "failed" as const,
  };

  assert.equal(
    failureCode(
      createCellResult(
        dataset,
        fields,
        record,
        recipe,
        withoutValue as CellResult
      )
    ),
    "cell-result-status-invalid"
  );
  assert.equal(
    failureCode(
      createCellResult(dataset, fields, record, recipe, {
        ...succeededCell,
        status: "pending",
      })
    ),
    "cell-result-status-invalid"
  );
  assert.equal(
    failureCode(
      createCellResult(dataset, fields, record, recipe, {
        ...withoutValue,
        status: "failed",
      } as CellResult)
    ),
    "cell-result-status-invalid"
  );
  assert.equal(
    failureCode(
      createCellResult(dataset, fields, record, recipe, {
        ...failed,
        reason: { ...failed.reason, code: "Provider_Secret" },
      })
    ),
    "cell-result-reason-invalid"
  );
  const created = createCellResult(dataset, fields, record, recipe, failed);
  assert.equal(created.ok, true);
  if (created.ok) {
    reason.message = "Changed after construction.";
    assert.equal(
      created.value.reason?.message,
      "The configured capability is temporarily unavailable."
    );
  }
});

test("validates provenance, freshness, confidence and cost evidence", () => {
  assert.equal(
    failureCode(
      createCellResult(dataset, fields, record, recipe, {
        ...succeededCell,
        provenance: { references: ["artifact:same", "artifact:same"] },
      })
    ),
    "cell-result-provenance-invalid"
  );
  assert.equal(
    failureCode(
      createCellResult(dataset, fields, record, recipe, {
        ...succeededCell,
        freshness: {
          expiresAt: instant(999),
          observedAt: instant(1000),
        },
      })
    ),
    "cell-result-freshness-invalid"
  );
  assert.equal(
    failureCode(
      createCellResult(dataset, fields, record, recipe, {
        ...succeededCell,
        confidence: 1.1,
      })
    ),
    "cell-result-confidence-invalid"
  );
  assert.equal(
    failureCode(
      createCellResult(dataset, fields, record, recipe, {
        ...succeededCell,
        cost: { amount: -1, basis: "exact", unit: "credits" },
      })
    ),
    "cell-result-cost-invalid"
  );
});
