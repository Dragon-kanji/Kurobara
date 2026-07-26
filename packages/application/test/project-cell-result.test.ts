import assert from "node:assert/strict";
import test from "node:test";

import {
  artifactId,
  attemptId,
  type CellResult,
  cellResultId,
  contentHash,
  type Dataset,
  type Record as DatasetRecord,
  datasetId,
  type EnrichmentRecipe,
  enrichmentRecipeId,
  type Field,
  fieldId,
  idempotencyKey,
  instant,
  type ResultManifest,
  type Run,
  type RunState,
  recordId,
  resultManifestId,
  runId,
  runPlanId,
  stepRunId,
  workflowSpecId,
  workspaceId,
} from "@kurobara/kernel";

import { canonicalContentHash } from "../src/canonical-content-hash.ts";
import {
  type ProjectCellResultRequest,
  type ProjectCellResultResult,
  projectCellResult,
} from "../src/project-cell-result.ts";

const hash = (marker: string) =>
  contentHash(`sha256:${marker.repeat(64).slice(0, 64)}`);

const workspace = workspaceId("workspace-cell-projection");
const dataset: Dataset = {
  datasetId: datasetId("dataset-cell-projection"),
  name: "Synthetic organizations",
  workspaceId: workspace,
};
const inputField: Field = {
  datasetId: dataset.datasetId,
  fieldId: fieldId("field-domain"),
  key: "domain",
  label: "Domain",
  valueType: "string",
  workspaceId: workspace,
};
const targetField: Field = {
  datasetId: dataset.datasetId,
  fieldId: fieldId("field-official-website"),
  key: "official_website",
  label: "Official website",
  valueType: "string",
  workspaceId: workspace,
};
const fields = [inputField, targetField] as const;
const record: DatasetRecord = {
  datasetId: dataset.datasetId,
  recordId: recordId("record-cell-projection"),
  values: [{ fieldId: inputField.fieldId, value: "synthetic.invalid" }],
  workspaceId: workspace,
};
const recipe: EnrichmentRecipe = {
  datasetId: dataset.datasetId,
  enrichmentRecipeId: enrichmentRecipeId("recipe-official-website"),
  inputFieldIds: [inputField.fieldId],
  name: "Find official website",
  recipeRevision: "1.0.0",
  targetFieldId: targetField.fieldId,
  workflowContentHash: hash("a"),
  workflowRevision: "1.0.0",
  workflowSpecId: workflowSpecId("workflow-official-website"),
  workspaceId: workspace,
};
const canonicalRunId = runId("run-cell-projection");
const canonicalPlanId = runPlanId("plan-cell-projection");
const canonicalManifestId = resultManifestId("manifest-cell-projection");
const canonicalManifestHash = hash("b");
const contract = {
  catalogFingerprint: hash("c"),
  catalogVersion: "local-development-only",
  schemaFingerprint: hash("d"),
  schemaId: "https://schemas.kurobara.invalid/local/cell-result-sink/1.0.0",
  schemaVersion: "1.0.0",
};

const pendingCell = (): CellResult => ({
  cellResultId: cellResultId("cell-result-projection"),
  datasetId: dataset.datasetId,
  enrichmentRecipeId: recipe.enrichmentRecipeId,
  fieldId: targetField.fieldId,
  recipeRevision: recipe.recipeRevision,
  recordId: record.recordId,
  runId: canonicalRunId,
  status: "pending",
  workspaceId: workspace,
});

const activeRun = (state: Exclude<RunState, "completed" | "failed">): Run => ({
  aggregateVersion: 1,
  createdAt: instant(1000),
  eventSequence: 1,
  idempotencyKey: idempotencyKey("cell-projection-intention"),
  intentionHash: hash("e"),
  resultCompleteness: "none",
  runId: canonicalRunId,
  runPlanId: canonicalPlanId,
  state,
  workspaceId: workspace,
});

type TerminalFixture = Readonly<{
  manifest: ResultManifest;
  run: Run;
}>;

const terminalFixture = (
  state: "completed" | "failed",
  sinkPayload?: unknown
): TerminalFixture => {
  const outputHash =
    state === "completed" ? canonicalContentHash(sinkPayload) : hash("f");
  const artifact = {
    artifactId: artifactId("artifact-cell-projection"),
    contentHash: outputHash,
  };
  const output =
    state === "completed"
      ? ({
          artifact,
          contract,
          status: "accepted",
          validatedAt: instant(3000),
          validatorVersion: "synthetic-validator-1",
        } as const)
      : ({ reason: "run-failed", status: "missing" } as const);
  const entries: ResultManifest["entries"] =
    state === "completed"
      ? [
          {
            nodeKey: "resolve-official-website",
            result: {
              artifact,
              contract,
              status: "accepted",
              validatedAt: instant(3000),
              validatorVersion: "synthetic-validator-1",
            },
            state: "succeeded",
            stepAggregateVersion: 3,
            stepEventSequence: 3,
            stepRunId: stepRunId("step-cell-projection"),
            terminalAttemptId: attemptId("attempt-cell-projection"),
          },
        ]
      : [
          {
            nodeKey: "resolve-official-website",
            result: { reason: "step-failed", status: "missing" },
            state: "failed",
            stepAggregateVersion: 3,
            stepEventSequence: 3,
            stepRunId: stepRunId("step-cell-projection"),
            terminalAttemptId: attemptId("attempt-cell-projection"),
          },
        ];
  const resultCompleteness = state === "completed" ? "complete" : "none";
  const manifest: ResultManifest = {
    attemptSettlements: [],
    compiledWorkflowFingerprint: "compiled-cell-projection",
    conclusion: state,
    cost: { reserved: 0, spent: 1.25, unit: "credits" },
    coverage: "complete",
    createdAt: instant(4000),
    entries,
    manifestHash: canonicalManifestHash,
    manifestVersion: 1,
    output,
    outputContract: contract,
    planHash: hash("1"),
    resultCompleteness,
    resultManifestId: canonicalManifestId,
    runId: canonicalRunId,
    runPlanId: canonicalPlanId,
    sourceRunAggregateVersion: 2,
    workspaceId: workspace,
  };
  return {
    manifest,
    run: {
      aggregateVersion: 3,
      createdAt: instant(1000),
      eventSequence: 3,
      idempotencyKey: idempotencyKey("cell-projection-intention"),
      intentionHash: hash("e"),
      resultCompleteness,
      resultManifest: {
        manifestHash: canonicalManifestHash,
        resultManifestId: canonicalManifestId,
      },
      runId: canonicalRunId,
      runPlanId: canonicalPlanId,
      state,
      workspaceId: workspace,
    },
  };
};

const baseRequest = (
  run: Run,
  extra: Partial<ProjectCellResultRequest> = {}
): ProjectCellResultRequest => ({
  current: pendingCell(),
  dataset,
  fields,
  recipe,
  record,
  run,
  ...extra,
});

const unwrap = (result: ProjectCellResultResult) => {
  if (!result.ok) {
    throw new Error(`Projection rejected: ${result.error.code}`);
  }
  return result.value;
};

const failureCode = (result: ProjectCellResultResult) => {
  if (result.ok) {
    throw new Error("Expected projection to fail.");
  }
  return result.error.code;
};

test("maps every active and non-success terminal Run state without another lifecycle", () => {
  const activeCases = [
    ["queued", "pending", true],
    ["running", "running", false],
    ["waiting", "running", false],
    ["cancelling", "running", false],
    ["ambiguous", "running", false],
  ] as const;
  for (const [runState, expectedStatus, replayed] of activeCases) {
    const projected = unwrap(
      projectCellResult(baseRequest(activeRun(runState)))
    );
    assert.equal(projected.cellResult.status, expectedStatus);
    assert.equal(projected.replayed, replayed);
  }

  const failed = terminalFixture("failed");
  const failedProjection = unwrap(
    projectCellResult(baseRequest(failed.run, { manifest: failed.manifest }))
  );
  assert.equal(failedProjection.cellResult.status, "failed");
  assert.deepEqual(failedProjection.cellResult.reason, {
    code: "run-failed",
    message: "The canonical run failed.",
    retryable: false,
  });
  assert.deepEqual(failedProjection.cellResult.cost, {
    amount: 1.25,
    basis: "exact",
    unit: "credits",
  });

  const cancelledProjection = unwrap(
    projectCellResult(baseRequest(activeRun("cancelled")))
  );
  assert.equal(cancelledProjection.cellResult.status, "skipped");
  assert.deepEqual(cancelledProjection.cellResult.reason, {
    code: "run-cancelled",
    message: "The canonical run was cancelled.",
    retryable: false,
  });
});

test("projects an accepted bounded sink envelope and takes exact cost only from its manifest", () => {
  const sink = {
    confidence: 0.875,
    freshness: { expiresAt: 9000, observedAt: 5000 },
    provenance: {
      references: ["https://synthetic.invalid/evidence"],
    },
    value: "https://synthetic.invalid",
  } as const;
  const terminal = terminalFixture("completed", sink);

  const projected = unwrap(
    projectCellResult(
      baseRequest(terminal.run, {
        manifest: terminal.manifest,
        normalizedSinkPayload: sink,
      })
    )
  );

  assert.equal(projected.cellResult.status, "succeeded");
  assert.equal(projected.cellResult.value, sink.value);
  assert.equal(projected.cellResult.confidence, sink.confidence);
  assert.deepEqual(projected.cellResult.provenance, sink.provenance);
  assert.deepEqual(projected.cellResult.freshness, {
    expiresAt: instant(9000),
    observedAt: instant(5000),
  });
  assert.deepEqual(projected.cellResult.cost, {
    amount: 1.25,
    basis: "exact",
    unit: "credits",
  });
  assert.notStrictEqual(projected.cellResult.provenance, sink.provenance);
  assert.notStrictEqual(
    projected.cellResult.provenance?.references,
    sink.provenance.references
  );
});

test("preserves an explicit null sink value", () => {
  const sink = { value: null } as const;
  const terminal = terminalFixture("completed", sink);

  const projected = unwrap(
    projectCellResult(
      baseRequest(terminal.run, {
        manifest: terminal.manifest,
        normalizedSinkPayload: sink,
      })
    )
  );

  assert.equal(projected.cellResult.status, "succeeded");
  assert.equal(Object.hasOwn(projected.cellResult, "value"), true);
  assert.equal(projected.cellResult.value, null);
});

test("rejects malformed and hostile sink outputs with stable redacted failures", () => {
  const secret = "DO-NOT-COPY-SYNTHETIC-SECRET";
  const getterPayload = {};
  Object.defineProperty(getterPayload, "value", {
    enumerable: true,
    get: () => {
      throw new Error(secret);
    },
  });
  const payloads = [
    { cost: { amount: 999 }, value: "https://synthetic.invalid" },
    { confidence: "high", value: null },
    { freshness: { observedAt: 1, timezone: secret }, value: null },
    { provenance: { references: [] }, value: null },
    { value: "x".repeat(16_385) },
    getterPayload,
    Object.create({ value: "https://synthetic.invalid" }),
  ];

  for (const payload of payloads) {
    const terminal = terminalFixture("completed", { value: null });
    const result = projectCellResult(
      baseRequest(terminal.run, {
        manifest: terminal.manifest,
        normalizedSinkPayload: payload,
      })
    );
    assert.equal(failureCode(result), "sink-output-invalid");
    if (!result.ok) {
      assert.equal(result.error.message.includes(secret), false);
      assert.equal(Object.hasOwn(result.error, "payload"), false);
    }
  }
});

test("rejects Run, manifest and accepted artifact identity drift", () => {
  const otherRun = {
    ...activeRun("running"),
    runId: runId("run-other-cell"),
  };
  assert.equal(
    failureCode(projectCellResult(baseRequest(otherRun))),
    "cell-result-run-binding-mismatch"
  );

  const sink = { value: "https://synthetic.invalid" } as const;
  const terminal = terminalFixture("completed", sink);
  assert.equal(
    failureCode(
      projectCellResult(
        baseRequest(terminal.run, {
          manifest: {
            ...terminal.manifest,
            resultManifestId: resultManifestId("manifest-other-cell"),
          },
          normalizedSinkPayload: sink,
        })
      )
    ),
    "result-manifest-mismatch"
  );

  assert.equal(
    failureCode(
      projectCellResult(
        baseRequest(terminal.run, {
          manifest: terminal.manifest,
          normalizedSinkPayload: { value: "https://other.invalid" },
        })
      )
    ),
    "sink-output-mismatch"
  );
});

test("replays the exact terminal projection without mutating its evidence", () => {
  const sink = {
    confidence: 0.5,
    provenance: { references: ["https://synthetic.invalid/source"] },
    value: "https://synthetic.invalid",
  } as const;
  const terminal = terminalFixture("completed", sink);
  const request = baseRequest(terminal.run, {
    manifest: terminal.manifest,
    normalizedSinkPayload: sink,
  });
  const first = unwrap(projectCellResult(request));
  assert.equal(first.replayed, false);

  const replay = unwrap(
    projectCellResult({ ...request, current: first.cellResult })
  );

  assert.equal(replay.replayed, true);
  assert.deepEqual(replay.cellResult, first.cellResult);
});
