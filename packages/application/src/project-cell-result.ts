import {
  type CellResult,
  type CellResultFreshness,
  type CellResultProvenance,
  type CellResultTransition,
  type CellResultTransitionFailureCode,
  createCellResult,
  type Dataset,
  type Record as DatasetRecord,
  type DomainResult,
  type EnrichmentRecipe,
  type Field,
  fail,
  instant,
  type ProductFailureCode,
  type ResultManifest,
  type Run,
  type ScalarValue,
  transitionCellResult,
} from "@kurobara/kernel";

import { canonicalContentHash } from "./canonical-content-hash.ts";

const MAX_SCALAR_STRING_LENGTH = 16_384;
const MAX_PROVENANCE_REFERENCES = 32;
const MAX_PROVENANCE_REFERENCE_LENGTH = 2048;
const MAX_SCALAR_NUMBER = 1_000_000_000_000_000;
const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const SINK_KEYS = new Set(["confidence", "freshness", "provenance", "value"]);
const FRESHNESS_KEYS = new Set(["expiresAt", "observedAt"]);
const PROVENANCE_KEYS = new Set(["references"]);

export type ProjectCellResultRequest = Readonly<{
  current: CellResult;
  dataset: Dataset;
  fields: readonly Field[];
  manifest?: ResultManifest;
  normalizedSinkPayload?: unknown;
  recipe: EnrichmentRecipe;
  record: DatasetRecord;
  run: Run;
}>;

export type ProjectCellResultFailureCode =
  | "cell-result-invalid"
  | "cell-result-run-binding-mismatch"
  | "cell-result-transition-rejected"
  | "result-manifest-mismatch"
  | "result-manifest-missing"
  | "run-state-invalid"
  | "sink-output-invalid"
  | "sink-output-mismatch"
  | "sink-output-missing"
  | "sink-output-unexpected";

export type ProjectCellResultFailure = Readonly<{
  code: ProjectCellResultFailureCode;
  message: string;
  domainCode?: ProductFailureCode | CellResultTransitionFailureCode;
}>;

export type ProjectCellResultResult = DomainResult<
  CellResultTransition,
  ProjectCellResultFailure
>;

type DataDescriptors = Readonly<Record<string, PropertyDescriptor>>;

type ParsedSinkEnvelope = Readonly<{
  value: ScalarValue;
  confidence?: number;
  freshness?: CellResultFreshness;
  provenance?: CellResultProvenance;
}>;

const rejected = (
  code: ProjectCellResultFailureCode,
  message: string,
  domainCode?: ProductFailureCode | CellResultTransitionFailureCode
): ProjectCellResultResult =>
  fail({
    code,
    ...(domainCode === undefined ? {} : { domainCode }),
    message,
  });

const codePointLengthAtMost = (value: string, maximum: number): boolean => {
  if (value.length > maximum * 2) {
    return false;
  }
  let length = 0;
  for (const _character of value) {
    length += 1;
    if (length > maximum) {
      return false;
    }
  }
  return true;
};

const plainDataDescriptors = (
  value: unknown,
  allowedKeys: ReadonlySet<string>
): DataDescriptors | undefined => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return;
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    return;
  }
  const keys = Reflect.ownKeys(value);
  if (
    keys.some(
      (key) =>
        typeof key !== "string" ||
        FORBIDDEN_KEYS.has(key) ||
        !allowedKeys.has(key)
    )
  ) {
    return;
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (
    keys.some((key) => {
      if (typeof key !== "string") {
        return true;
      }
      const descriptor = descriptors[key];
      return (
        descriptor === undefined ||
        !Object.hasOwn(descriptor, "value") ||
        descriptor.enumerable !== true ||
        descriptor.get !== undefined ||
        descriptor.set !== undefined
      );
    })
  ) {
    return;
  }
  return descriptors;
};

const descriptorValue = (descriptors: DataDescriptors, key: string): unknown =>
  descriptors[key]?.value;

const isBoundedScalar = (value: unknown): value is ScalarValue =>
  value === null ||
  typeof value === "boolean" ||
  (typeof value === "string" &&
    codePointLengthAtMost(value, MAX_SCALAR_STRING_LENGTH)) ||
  (typeof value === "number" &&
    Number.isFinite(value) &&
    value >= -MAX_SCALAR_NUMBER &&
    value <= MAX_SCALAR_NUMBER);

const parseReferences = (value: unknown): readonly string[] | undefined => {
  if (
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    value.length === 0 ||
    value.length > MAX_PROVENANCE_REFERENCES
  ) {
    return;
  }
  const keys = Reflect.ownKeys(value);
  const expectedKeys = new Set([
    "length",
    ...Array.from({ length: value.length }, (_entry, index) => String(index)),
  ]);
  if (
    keys.length !== expectedKeys.size ||
    keys.some((key) => typeof key !== "string" || !expectedKeys.has(key))
  ) {
    return;
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const references: string[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = descriptors[String(index)];
    const reference = descriptor?.value;
    if (
      descriptor === undefined ||
      !Object.hasOwn(descriptor, "value") ||
      typeof reference !== "string" ||
      reference.trim().length === 0 ||
      !codePointLengthAtMost(reference, MAX_PROVENANCE_REFERENCE_LENGTH)
    ) {
      return;
    }
    references.push(reference);
  }
  return new Set(references).size === references.length
    ? references
    : undefined;
};

const parseProvenance = (value: unknown): CellResultProvenance | undefined => {
  const descriptors = plainDataDescriptors(value, PROVENANCE_KEYS);
  if (descriptors === undefined || !Object.hasOwn(descriptors, "references")) {
    return;
  }
  const references = parseReferences(
    descriptorValue(descriptors, "references")
  );
  return references === undefined ? undefined : { references };
};

const parseFreshness = (value: unknown): CellResultFreshness | undefined => {
  const descriptors = plainDataDescriptors(value, FRESHNESS_KEYS);
  if (descriptors === undefined || !Object.hasOwn(descriptors, "observedAt")) {
    return;
  }
  const observedAt = descriptorValue(descriptors, "observedAt");
  const expiresAt = descriptorValue(descriptors, "expiresAt");
  if (
    !Number.isSafeInteger(observedAt) ||
    (observedAt as number) < 0 ||
    (Object.hasOwn(descriptors, "expiresAt") &&
      (!Number.isSafeInteger(expiresAt) ||
        (expiresAt as number) < (observedAt as number)))
  ) {
    return;
  }
  return {
    ...(Object.hasOwn(descriptors, "expiresAt")
      ? { expiresAt: instant(expiresAt as number) }
      : {}),
    observedAt: instant(observedAt as number),
  };
};

const parseSinkEnvelope = (value: unknown): ParsedSinkEnvelope | undefined => {
  try {
    const descriptors = plainDataDescriptors(value, SINK_KEYS);
    if (descriptors === undefined || !Object.hasOwn(descriptors, "value")) {
      return;
    }
    const scalar = descriptorValue(descriptors, "value");
    if (!isBoundedScalar(scalar)) {
      return;
    }

    const claimsProvenance = Object.hasOwn(descriptors, "provenance");
    const provenance = claimsProvenance
      ? parseProvenance(descriptorValue(descriptors, "provenance"))
      : undefined;
    if (claimsProvenance && provenance === undefined) {
      return;
    }

    const claimsFreshness = Object.hasOwn(descriptors, "freshness");
    const freshness = claimsFreshness
      ? parseFreshness(descriptorValue(descriptors, "freshness"))
      : undefined;
    if (claimsFreshness && freshness === undefined) {
      return;
    }

    const claimsConfidence = Object.hasOwn(descriptors, "confidence");
    const confidence = claimsConfidence
      ? descriptorValue(descriptors, "confidence")
      : undefined;
    if (
      claimsConfidence &&
      (typeof confidence !== "number" ||
        !Number.isFinite(confidence) ||
        confidence < 0 ||
        confidence > 1)
    ) {
      return;
    }

    return {
      ...(claimsConfidence ? { confidence: confidence as number } : {}),
      ...(freshness === undefined ? {} : { freshness }),
      ...(provenance === undefined ? {} : { provenance }),
      value: scalar,
    };
  } catch {
    // Invalid provider output deliberately maps to no projected value.
  }
};

const sameContract = (
  left: ResultManifest["outputContract"],
  right: ResultManifest["outputContract"]
): boolean =>
  left.catalogFingerprint === right.catalogFingerprint &&
  left.catalogVersion === right.catalogVersion &&
  left.schemaFingerprint === right.schemaFingerprint &&
  left.schemaId === right.schemaId &&
  left.schemaVersion === right.schemaVersion;

const manifestMatchesRun = (
  run: Run,
  manifest: ResultManifest,
  expectedConclusion: "completed" | "failed"
): boolean => {
  if (
    run.resultManifest === undefined ||
    manifest.resultManifestId !== run.resultManifest.resultManifestId ||
    manifest.manifestHash !== run.resultManifest.manifestHash ||
    manifest.workspaceId !== run.workspaceId ||
    manifest.runId !== run.runId ||
    manifest.runPlanId !== run.runPlanId ||
    manifest.manifestVersion !== 1 ||
    manifest.coverage !== "complete" ||
    manifest.conclusion !== expectedConclusion ||
    manifest.resultCompleteness !== run.resultCompleteness ||
    manifest.sourceRunAggregateVersion + 1 !== run.aggregateVersion
  ) {
    return false;
  }
  if (expectedConclusion === "completed") {
    if (
      run.resultCompleteness !== "complete" ||
      manifest.output.status !== "accepted" ||
      manifest.output.validatorVersion.trim().length === 0 ||
      !sameContract(manifest.output.contract, manifest.outputContract)
    ) {
      return false;
    }
    const output = manifest.output;
    return manifest.entries.some(
      (entry) =>
        entry.state === "succeeded" &&
        entry.result.status === "accepted" &&
        entry.result.artifact.artifactId === output.artifact.artifactId &&
        entry.result.artifact.contentHash === output.artifact.contentHash &&
        sameContract(entry.result.contract, output.contract)
    );
  }
  return (
    manifest.output.status === "missing" &&
    manifest.output.reason === "run-failed" &&
    manifest.entries.some((entry) => entry.state === "failed")
  );
};

const baseCellResult = (current: CellResult): CellResult => ({
  cellResultId: current.cellResultId,
  datasetId: current.datasetId,
  enrichmentRecipeId: current.enrichmentRecipeId,
  fieldId: current.fieldId,
  recipeRevision: current.recipeRevision,
  recordId: current.recordId,
  runId: current.runId,
  status: current.status,
  workspaceId: current.workspaceId,
});

const requestedForRun = (
  request: ProjectCellResultRequest
): ProjectCellResultResult | CellResult => {
  const base = baseCellResult(request.current);
  if (
    request.run.state !== "completed" &&
    Object.hasOwn(request, "normalizedSinkPayload")
  ) {
    return rejected(
      "sink-output-unexpected",
      "Only a completed run can project a normalized sink output."
    );
  }

  switch (request.run.state) {
    case "queued":
      return { ...base, status: "pending" };
    case "running":
    case "waiting":
    case "cancelling":
    case "ambiguous":
      return { ...base, status: "running" };
    case "cancelled":
      return {
        ...base,
        reason: {
          code: "run-cancelled",
          message: "The canonical run was cancelled.",
          retryable: false,
        },
        status: "skipped",
      };
    case "failed": {
      if (request.manifest === undefined) {
        return rejected(
          "result-manifest-missing",
          "A failed run requires its exact durable result manifest."
        );
      }
      if (!manifestMatchesRun(request.run, request.manifest, "failed")) {
        return rejected(
          "result-manifest-mismatch",
          "The result manifest does not match the canonical run."
        );
      }
      return {
        ...base,
        cost: {
          amount: request.manifest.cost.spent,
          basis: "exact",
          unit: request.manifest.cost.unit,
        },
        reason: {
          code: "run-failed",
          message: "The canonical run failed.",
          retryable: false,
        },
        status: "failed",
      };
    }
    case "completed": {
      if (request.manifest === undefined) {
        return rejected(
          "result-manifest-missing",
          "A completed run requires its exact durable result manifest."
        );
      }
      if (!manifestMatchesRun(request.run, request.manifest, "completed")) {
        return rejected(
          "result-manifest-mismatch",
          "The result manifest does not match the canonical run."
        );
      }
      if (request.normalizedSinkPayload === undefined) {
        return rejected(
          "sink-output-missing",
          "A completed run requires its normalized sink output."
        );
      }
      const parsed = parseSinkEnvelope(request.normalizedSinkPayload);
      if (parsed === undefined) {
        return rejected(
          "sink-output-invalid",
          "The normalized sink output is not a valid bounded cell-result envelope."
        );
      }
      if (
        request.manifest.output.status !== "accepted" ||
        canonicalContentHash(parsed) !==
          request.manifest.output.artifact.contentHash
      ) {
        return rejected(
          "sink-output-mismatch",
          "The normalized sink output does not match the accepted output artifact."
        );
      }
      return {
        ...base,
        ...parsed,
        cost: {
          amount: request.manifest.cost.spent,
          basis: "exact",
          unit: request.manifest.cost.unit,
        },
        status: "succeeded",
      };
    }
    default:
      return rejected(
        "run-state-invalid",
        "The canonical run has an unsupported state."
      );
  }
};

const isProjectionResult = (
  value: ProjectCellResultResult | CellResult
): value is ProjectCellResultResult => Object.hasOwn(value, "ok");

export const projectCellResult = (
  request: ProjectCellResultRequest
): ProjectCellResultResult => {
  const current = createCellResult(
    request.dataset,
    request.fields,
    request.record,
    request.recipe,
    request.current
  );
  if (!current.ok) {
    return rejected(
      "cell-result-invalid",
      "The current cell result is not valid for the supplied product identities.",
      current.error.code
    );
  }
  if (
    request.run.workspaceId !== current.value.workspaceId ||
    request.run.runId !== current.value.runId
  ) {
    return rejected(
      "cell-result-run-binding-mismatch",
      "The current cell result is not bound to the canonical run."
    );
  }
  if (
    request.run.state !== "completed" &&
    request.run.state !== "failed" &&
    (request.manifest !== undefined || request.run.resultManifest !== undefined)
  ) {
    return rejected(
      "result-manifest-mismatch",
      "A non-manifest run state cannot project a result manifest."
    );
  }

  const requested = requestedForRun(request);
  if (isProjectionResult(requested)) {
    return requested;
  }
  const validated = createCellResult(
    request.dataset,
    request.fields,
    request.record,
    request.recipe,
    requested
  );
  if (!validated.ok) {
    return rejected(
      "cell-result-invalid",
      "The projected cell result failed domain validation.",
      validated.error.code
    );
  }
  const transition = transitionCellResult(current.value, validated.value);
  if (!transition.ok) {
    return rejected(
      "cell-result-transition-rejected",
      "The canonical run cannot move the current cell result through that transition.",
      transition.error.code
    );
  }
  return transition;
};
