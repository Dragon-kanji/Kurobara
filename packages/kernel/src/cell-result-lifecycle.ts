import type { CellResult, CellResultStatus, ScalarValue } from "./product.ts";
import { type DomainResult, fail, succeed } from "./result.ts";

export type CellResultTransitionFailureCode =
  | "cell-result-identity-mismatch"
  | "cell-result-terminal-immutable"
  | "cell-result-transition-invalid";

export type CellResultTransitionFailure = Readonly<{
  code: CellResultTransitionFailureCode;
  currentStatus: CellResultStatus;
  message: string;
  requestedStatus: CellResultStatus;
}>;

export type CellResultTransition = Readonly<{
  cellResult: CellResult;
  replayed: boolean;
}>;

const terminalStatuses = new Set<CellResultStatus>([
  "failed",
  "skipped",
  "succeeded",
]);

const hasOwn = (value: CellResult, key: keyof CellResult): boolean =>
  Object.hasOwn(value, key);

const sameOptionalScalar = (left: CellResult, right: CellResult): boolean =>
  hasOwn(left, "value") === hasOwn(right, "value") &&
  Object.is(left.value as ScalarValue | undefined, right.value);

const sameOptionalNumber = (
  left: CellResult,
  right: CellResult,
  key: "confidence"
): boolean =>
  hasOwn(left, key) === hasOwn(right, key) && Object.is(left[key], right[key]);

const sameReason = (left: CellResult, right: CellResult): boolean =>
  hasOwn(left, "reason") === hasOwn(right, "reason") &&
  (left.reason === undefined || right.reason === undefined
    ? left.reason === right.reason
    : left.reason.code === right.reason.code &&
      left.reason.message === right.reason.message &&
      left.reason.retryable === right.reason.retryable);

const sameCost = (left: CellResult, right: CellResult): boolean =>
  hasOwn(left, "cost") === hasOwn(right, "cost") &&
  (left.cost === undefined || right.cost === undefined
    ? left.cost === right.cost
    : Object.is(left.cost.amount, right.cost.amount) &&
      left.cost.basis === right.cost.basis &&
      left.cost.unit === right.cost.unit);

const sameFreshness = (left: CellResult, right: CellResult): boolean =>
  hasOwn(left, "freshness") === hasOwn(right, "freshness") &&
  (left.freshness === undefined || right.freshness === undefined
    ? left.freshness === right.freshness
    : left.freshness.observedAt === right.freshness.observedAt &&
      left.freshness.expiresAt === right.freshness.expiresAt);

const sameProvenance = (left: CellResult, right: CellResult): boolean =>
  hasOwn(left, "provenance") === hasOwn(right, "provenance") &&
  (left.provenance === undefined || right.provenance === undefined
    ? left.provenance === right.provenance
    : left.provenance.references.length ===
        right.provenance.references.length &&
      left.provenance.references.every(
        (reference, index) => reference === right.provenance?.references[index]
      ));

const hasSameIdentity = (left: CellResult, right: CellResult): boolean =>
  left.cellResultId === right.cellResultId &&
  left.datasetId === right.datasetId &&
  left.enrichmentRecipeId === right.enrichmentRecipeId &&
  left.fieldId === right.fieldId &&
  left.recipeRevision === right.recipeRevision &&
  left.recordId === right.recordId &&
  left.runId === right.runId &&
  left.workspaceId === right.workspaceId;

const isExactReplay = (left: CellResult, right: CellResult): boolean =>
  hasSameIdentity(left, right) &&
  left.status === right.status &&
  sameOptionalNumber(left, right, "confidence") &&
  sameCost(left, right) &&
  sameFreshness(left, right) &&
  sameProvenance(left, right) &&
  sameReason(left, right) &&
  sameOptionalScalar(left, right);

const cloneCellResult = (input: CellResult): CellResult => ({
  ...input,
  ...(input.cost === undefined ? {} : { cost: { ...input.cost } }),
  ...(input.freshness === undefined
    ? {}
    : { freshness: { ...input.freshness } }),
  ...(input.provenance === undefined
    ? {}
    : { provenance: { references: [...input.provenance.references] } }),
  ...(input.reason === undefined ? {} : { reason: { ...input.reason } }),
});

const transitionIsAllowed = (
  current: CellResultStatus,
  requested: CellResultStatus
): boolean =>
  (current === "pending" &&
    (requested === "running" || terminalStatuses.has(requested))) ||
  (current === "running" && terminalStatuses.has(requested));

export const transitionCellResult = (
  current: CellResult,
  requested: CellResult
): DomainResult<CellResultTransition, CellResultTransitionFailure> => {
  if (!hasSameIdentity(current, requested)) {
    return fail({
      code: "cell-result-identity-mismatch",
      currentStatus: current.status,
      message:
        "A cell-result transition must preserve its exact durable identity.",
      requestedStatus: requested.status,
    });
  }
  if (isExactReplay(current, requested)) {
    return succeed({ cellResult: cloneCellResult(current), replayed: true });
  }
  if (terminalStatuses.has(current.status)) {
    return fail({
      code: "cell-result-terminal-immutable",
      currentStatus: current.status,
      message:
        "A terminal cell result is immutable except for an exact replay.",
      requestedStatus: requested.status,
    });
  }
  if (!transitionIsAllowed(current.status, requested.status)) {
    return fail({
      code: "cell-result-transition-invalid",
      currentStatus: current.status,
      message: `A cell result cannot transition from ${current.status} to ${requested.status}.`,
      requestedStatus: requested.status,
    });
  }
  return succeed({ cellResult: cloneCellResult(requested), replayed: false });
};
