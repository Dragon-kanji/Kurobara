import { amountsEqual, isAmount } from "./amount.ts";
import type { Artifact, ValidatedOutputRef } from "./artifact.ts";
import { type DomainResult, fail, succeed } from "./result.ts";
import type {
  ContractRef,
  ResultCompleteness,
  ResultManifestRef,
  Run,
  RunPlan,
} from "./run.ts";
import type { CostReservation, StepRun } from "./step-run.ts";
import type {
  AttemptId,
  ContentHash,
  CostReservationId,
  Instant,
  OperationKey,
  ResultManifestId,
  StepRunId,
  UsageEntryId,
} from "./value-objects.ts";

export type ResultManifestCost = Readonly<{
  reserved: number;
  spent: number;
  unit: string;
}>;

export type ResultManifestEntry = Readonly<{
  nodeKey: string;
  result:
    | (ValidatedOutputRef & Readonly<{ status: "accepted" }>)
    | Readonly<{
        reason:
          | "blocked-by-dependency"
          | "result-reference-not-persisted"
          | "step-failed";
        status: "missing";
      }>;
  state: "failed" | "skipped" | "succeeded";
  stepAggregateVersion: number;
  stepEventSequence: number;
  stepRunId: StepRunId;
  blockedByNodeKeys?: readonly string[];
  terminalAttemptId?: AttemptId;
}>;

export type ResultManifestAttemptSettlement = Readonly<{
  attemptId: AttemptId;
  disposition: "released" | "settled";
  operationKey: OperationKey;
  releasedAmount: number;
  reservationId: CostReservationId;
  unit: string;
  settledAmount?: number;
  usageEntryId?: UsageEntryId;
}>;

export type ResultManifestBody = Readonly<{
  attemptSettlements: readonly ResultManifestAttemptSettlement[];
  compiledWorkflowFingerprint: string;
  conclusion: "completed" | "failed";
  cost: Readonly<{ reserved: 0; spent: number; unit: string }>;
  coverage: "complete";
  createdAt: Instant;
  entries: readonly ResultManifestEntry[];
  manifestVersion: 1;
  output:
    | (ValidatedOutputRef & Readonly<{ status: "accepted" }>)
    | Readonly<{
        reason: "result-proof-missing" | "run-failed";
        status: "missing";
      }>;
  outputContract: ContractRef;
  planHash: ContentHash;
  resultCompleteness: ResultCompleteness;
  runId: Run["runId"];
  runPlanId: Run["runPlanId"];
  sourceRunAggregateVersion: number;
  workspaceId: Run["workspaceId"];
}>;

export type ResultManifest = ResultManifestBody &
  Readonly<{
    manifestHash: ContentHash;
    resultManifestId: ResultManifestId;
  }>;

export type RunConvergenceBlocker =
  | "active-attempt-present"
  | "result-proof-missing"
  | "output-binding-ambiguous"
  | "step-coverage-incomplete"
  | "step-not-terminal"
  | "unsettled-cost-present"
  | "unsupported-terminal-mix";

export type RunConvergenceInvariantFailureCode =
  | "cost-proof-invalid"
  | "identity-mismatch"
  | "reservation-proof-invalid"
  | "step-proof-invalid";

export type RunConvergenceInvariantFailure = Readonly<{
  code: RunConvergenceInvariantFailureCode;
  message: string;
}>;

export type RunConvergenceDecision =
  | Readonly<{ reason: RunConvergenceBlocker; status: "not-ready" }>
  | Readonly<{ manifestBody: ResultManifestBody; status: "completed" }>
  | Readonly<{ manifestBody: ResultManifestBody; status: "failed" }>;

export type EvaluateRunConvergenceInput = Readonly<{
  artifacts: readonly Artifact[];
  cost: ResultManifestCost;
  createdAt: Instant;
  plan: RunPlan;
  reservations: readonly CostReservation[];
  run: Run;
  stepRuns: readonly StepRun[];
}>;

const nonTerminalAttemptStates = new Set([
  "prepared",
  "claimed",
  "in_flight",
  "ambiguous",
]);

const terminalStepStates = new Set(["succeeded", "failed", "skipped"]);

const sameTextArray = (
  left: readonly string[],
  right: readonly string[]
): boolean =>
  left.length === right.length &&
  left.every((entry, index) => entry === right[index]);

const stepIdentityIsValid = (
  input: EvaluateRunConvergenceInput,
  stepRun: StepRun
): boolean => {
  const node = input.plan.compiledWorkflow.nodes.find(
    (candidate) => candidate.key === stepRun.nodeKey
  );
  return (
    node !== undefined &&
    stepRun.workspaceId === input.run.workspaceId &&
    stepRun.runId === input.run.runId &&
    sameTextArray(stepRun.dependsOn, node.dependsOn)
  );
};

const attemptsAreCoherent = (stepRun: StepRun): boolean => {
  if (
    stepRun.activeAttemptId !== undefined ||
    stepRun.attempts.some((attempt) =>
      nonTerminalAttemptStates.has(attempt.state)
    )
  ) {
    return false;
  }
  if (stepRun.state === "skipped") {
    return stepRun.attempts.length === 0;
  }
  if (stepRun.state === "succeeded") {
    return stepRun.attempts.at(-1)?.state === "succeeded";
  }
  if (stepRun.state === "failed") {
    const lastState = stepRun.attempts.at(-1)?.state;
    return (
      stepRun.attempts.length === 0 ||
      lastState === "failed_retryable" ||
      lastState === "failed_terminal"
    );
  }
  return false;
};

const reservationMatchesAttempt = (
  input: EvaluateRunConvergenceInput,
  stepRun: StepRun,
  reservation: CostReservation
): boolean => {
  const attempt = stepRun.attempts.find(
    (candidate) => candidate.attemptId === reservation.attemptId
  );
  return (
    attempt !== undefined &&
    reservation.workspaceId === input.run.workspaceId &&
    reservation.runId === input.run.runId &&
    reservation.stepRunId === stepRun.stepRunId &&
    reservation.reservationId === attempt.costReservationId &&
    reservation.operationKey === attempt.operationKey &&
    reservation.unit === attempt.reservationUnit &&
    amountsEqual(reservation.amount, attempt.reservedAmount)
  );
};

const toSettlement = (
  reservation: Exclude<CostReservation, { state: "reserved" }>
): ResultManifestAttemptSettlement =>
  reservation.state === "released"
    ? {
        attemptId: reservation.attemptId,
        disposition: "released",
        operationKey: reservation.operationKey,
        releasedAmount: reservation.amount,
        reservationId: reservation.reservationId,
        unit: reservation.unit,
      }
    : {
        attemptId: reservation.attemptId,
        disposition: "settled",
        operationKey: reservation.operationKey,
        releasedAmount: reservation.releasedAmount,
        reservationId: reservation.reservationId,
        settledAmount: reservation.settledAmount,
        unit: reservation.unit,
        usageEntryId: reservation.usageEntryId,
      };

const blockedBy = (
  stepRun: StepRun,
  stepsByNodeKey: ReadonlyMap<string, StepRun>
): readonly string[] =>
  stepRun.dependsOn.filter((dependency) => {
    const state = stepsByNodeKey.get(dependency)?.state;
    return state === "failed" || state === "skipped";
  });

const toManifestEntry = (
  stepRun: StepRun,
  stepsByNodeKey: ReadonlyMap<string, StepRun>
): ResultManifestEntry => {
  const state = stepRun.state as ResultManifestEntry["state"];
  const blockedByNodeKeys =
    state === "skipped" ? blockedBy(stepRun, stepsByNodeKey) : [];
  let reason:
    | "blocked-by-dependency"
    | "result-reference-not-persisted"
    | "step-failed" = "result-reference-not-persisted";
  if (state === "failed") {
    reason = "step-failed";
  } else if (state === "skipped") {
    reason = "blocked-by-dependency";
  }
  const output = stepRun.attempts.at(-1)?.output;
  return {
    nodeKey: stepRun.nodeKey,
    result:
      state === "succeeded" && output !== undefined
        ? { ...output, status: "accepted" }
        : { reason, status: "missing" },
    state,
    stepAggregateVersion: stepRun.aggregateVersion,
    stepEventSequence: stepRun.eventSequence,
    stepRunId: stepRun.stepRunId,
    ...(blockedByNodeKeys.length === 0 ? {} : { blockedByNodeKeys }),
    ...(stepRun.attempts.at(-1) === undefined
      ? {}
      : { terminalAttemptId: stepRun.attempts.at(-1)?.attemptId }),
  };
};

export const resultManifestRef = (
  manifest: ResultManifest
): ResultManifestRef => ({
  manifestHash: manifest.manifestHash,
  resultManifestId: manifest.resultManifestId,
});

type StepConvergenceProof = Readonly<{
  orderedSteps: readonly StepRun[];
  stepsByNodeKey: ReadonlyMap<string, StepRun>;
}>;

type SettlementConvergenceProof = Readonly<{
  orderedSettlements: readonly ResultManifestAttemptSettlement[];
}>;

const sameContract = (left: ContractRef, right: ContractRef): boolean =>
  left.catalogVersion === right.catalogVersion &&
  left.catalogFingerprint === right.catalogFingerprint &&
  left.schemaId === right.schemaId &&
  left.schemaVersion === right.schemaVersion &&
  left.schemaFingerprint === right.schemaFingerprint;

const artifactMatchesOutput = (
  artifact: Artifact,
  output: ValidatedOutputRef,
  stepRun: StepRun,
  attempt: NonNullable<StepRun["attempts"][number]>
): boolean =>
  artifact.artifactId === output.artifact.artifactId &&
  artifact.contentHash === output.artifact.contentHash &&
  sameContract(artifact.contract, output.contract) &&
  artifact.workspaceId === stepRun.workspaceId &&
  artifact.runId === stepRun.runId &&
  artifact.stepRunId === stepRun.stepRunId &&
  artifact.attemptId === attempt.attemptId &&
  artifact.operationKey === attempt.operationKey &&
  artifact.state === "finalized" &&
  Number.isSafeInteger(artifact.sizeBytes) &&
  artifact.sizeBytes >= 0 &&
  artifact.validatedAt === output.validatedAt &&
  artifact.validatorVersion === output.validatorVersion &&
  output.validatorVersion.trim().length > 0 &&
  output.validatedAt <= artifact.finalizedAt;

type ConvergencePhaseResult<Value> = DomainResult<
  RunConvergenceDecision | Value,
  RunConvergenceInvariantFailure
>;

const isConvergenceDecision = <Value>(
  value: RunConvergenceDecision | Value
): value is RunConvergenceDecision =>
  typeof value === "object" && value !== null && "status" in value;

const evaluateStepConvergenceProof = (
  input: EvaluateRunConvergenceInput
): ConvergencePhaseResult<StepConvergenceProof> => {
  const nodeKeys = new Set(
    input.plan.compiledWorkflow.nodes.map((node) => node.key)
  );
  const stepsByNodeKey = new Map(
    input.stepRuns.map((stepRun) => [stepRun.nodeKey, stepRun])
  );
  if (
    stepsByNodeKey.size !== input.stepRuns.length ||
    input.stepRuns.some(
      (stepRun) =>
        !(nodeKeys.has(stepRun.nodeKey) && stepIdentityIsValid(input, stepRun))
    )
  ) {
    return fail({
      code: "step-proof-invalid",
      message:
        "The convergence steps do not match the immutable compiled workflow.",
    });
  }
  if (stepsByNodeKey.size !== nodeKeys.size) {
    return succeed({
      reason: "step-coverage-incomplete",
      status: "not-ready",
    });
  }
  if (
    input.stepRuns.some((stepRun) => !terminalStepStates.has(stepRun.state))
  ) {
    return succeed({ reason: "step-not-terminal", status: "not-ready" });
  }
  if (
    input.stepRuns.some(
      (stepRun) =>
        stepRun.activeAttemptId !== undefined ||
        stepRun.attempts.some((attempt) =>
          nonTerminalAttemptStates.has(attempt.state)
        )
    )
  ) {
    return succeed({
      reason: "active-attempt-present",
      status: "not-ready",
    });
  }
  if (input.stepRuns.some((stepRun) => !attemptsAreCoherent(stepRun))) {
    return fail({
      code: "step-proof-invalid",
      message: "A terminal step has an incoherent terminal attempt history.",
    });
  }
  for (const stepRun of input.stepRuns) {
    if (
      stepRun.state === "skipped" &&
      blockedBy(stepRun, stepsByNodeKey).length === 0
    ) {
      return fail({
        code: "step-proof-invalid",
        message: "A skipped step has no terminal non-success dependency.",
      });
    }
  }
  const orderedSteps: StepRun[] = [];
  for (const node of input.plan.compiledWorkflow.nodes) {
    const stepRun = stepsByNodeKey.get(node.key);
    if (stepRun === undefined) {
      return succeed({
        reason: "step-coverage-incomplete",
        status: "not-ready",
      });
    }
    orderedSteps.push(stepRun);
  }
  return succeed({ orderedSteps, stepsByNodeKey });
};

const evaluateSettlementConvergenceProof = (
  input: EvaluateRunConvergenceInput,
  orderedSteps: readonly StepRun[]
): ConvergencePhaseResult<SettlementConvergenceProof> => {
  const attempts = orderedSteps.flatMap((stepRun) => stepRun.attempts);
  const reservationsByAttempt = new Map(
    input.reservations.map((reservation) => [
      reservation.attemptId,
      reservation,
    ])
  );
  if (
    reservationsByAttempt.size !== input.reservations.length ||
    reservationsByAttempt.size !== attempts.length ||
    input.reservations.some((reservation) => {
      const stepRun = orderedSteps.find(
        (candidate) => candidate.stepRunId === reservation.stepRunId
      );
      return (
        stepRun === undefined ||
        !reservationMatchesAttempt(input, stepRun, reservation)
      );
    })
  ) {
    return fail({
      code: "reservation-proof-invalid",
      message:
        "Every durable attempt must have exactly one identity-matching reservation receipt.",
    });
  }
  if (
    !amountsEqual(input.cost.reserved, 0) ||
    input.reservations.some((reservation) => reservation.state === "reserved")
  ) {
    return succeed({
      reason: "unsettled-cost-present",
      status: "not-ready",
    });
  }
  const orderedSettlements: ResultManifestAttemptSettlement[] = [];
  for (const stepRun of orderedSteps) {
    for (const stepAttempt of stepRun.attempts) {
      const reservation = reservationsByAttempt.get(stepAttempt.attemptId);
      if (reservation === undefined || reservation.state === "reserved") {
        return fail({
          code: "reservation-proof-invalid",
          message:
            "The ordered convergence settlement proof is incomplete or unsettled.",
        });
      }
      orderedSettlements.push(toSettlement(reservation));
    }
  }
  const expectedSpent =
    input.plan.budget.spent +
    orderedSettlements.reduce(
      (total, settlement) => total + (settlement.settledAmount ?? 0),
      0
    );
  if (!amountsEqual(input.cost.spent, expectedSpent)) {
    return fail({
      code: "cost-proof-invalid",
      message:
        "The run cost snapshot does not equal its initial spend plus settled usage receipts.",
    });
  }
  return succeed({ orderedSettlements });
};

export const evaluateRunConvergence = (
  input: EvaluateRunConvergenceInput
): DomainResult<RunConvergenceDecision, RunConvergenceInvariantFailure> => {
  if (
    input.plan.workspaceId !== input.run.workspaceId ||
    input.plan.runPlanId !== input.run.runPlanId
  ) {
    return fail({
      code: "identity-mismatch",
      message: "The convergence plan does not belong to the target run.",
    });
  }
  if (
    input.cost.unit !== input.plan.budget.unit ||
    !isAmount(input.cost.spent) ||
    !isAmount(input.cost.reserved)
  ) {
    return fail({
      code: "cost-proof-invalid",
      message: "The run cost proof is malformed or uses another unit.",
    });
  }
  const stepProof = evaluateStepConvergenceProof(input);
  if (!stepProof.ok) {
    return fail(stepProof.error);
  }
  if (isConvergenceDecision(stepProof.value)) {
    return succeed(stepProof.value);
  }
  const { orderedSteps, stepsByNodeKey } = stepProof.value;
  const settlementProof = evaluateSettlementConvergenceProof(
    input,
    orderedSteps
  );
  if (!settlementProof.ok) {
    return fail(settlementProof.error);
  }
  if (isConvergenceDecision(settlementProof.value)) {
    return succeed(settlementProof.value);
  }
  const { orderedSettlements } = settlementProof.value;
  const failed = orderedSteps.some((stepRun) => stepRun.state === "failed");
  if (failed) {
    return succeed({
      manifestBody: {
        attemptSettlements: orderedSettlements,
        compiledWorkflowFingerprint: input.plan.compiledWorkflow.fingerprint,
        conclusion: "failed",
        cost: {
          reserved: 0,
          spent: input.cost.spent,
          unit: input.cost.unit,
        },
        coverage: "complete",
        createdAt: input.createdAt,
        entries: orderedSteps.map((stepRun) =>
          toManifestEntry(stepRun, stepsByNodeKey)
        ),
        manifestVersion: 1,
        output: { reason: "run-failed", status: "missing" },
        outputContract: input.plan.outputContract,
        planHash: input.plan.planHash,
        resultCompleteness: "none",
        runId: input.run.runId,
        runPlanId: input.run.runPlanId,
        sourceRunAggregateVersion: input.run.aggregateVersion,
        workspaceId: input.run.workspaceId,
      },
      status: "failed",
    });
  }
  const dependedOnNodeKeys = new Set(
    input.plan.compiledWorkflow.nodes.flatMap((node) => node.dependsOn)
  );
  const sinkNodes = input.plan.compiledWorkflow.nodes.filter(
    (node) => !dependedOnNodeKeys.has(node.key)
  );
  if (sinkNodes.length !== 1) {
    return succeed({
      reason: "output-binding-ambiguous",
      status: "not-ready",
    });
  }
  const sinkStep = stepsByNodeKey.get(sinkNodes[0]?.key ?? "");
  const terminalAttempt = sinkStep?.attempts.at(-1);
  const output = terminalAttempt?.output;
  if (
    sinkStep === undefined ||
    terminalAttempt === undefined ||
    output === undefined
  ) {
    return succeed({ reason: "result-proof-missing", status: "not-ready" });
  }
  const artifactsById = new Map(
    input.artifacts.map((artifact) => [artifact.artifactId, artifact])
  );
  if (artifactsById.size !== input.artifacts.length) {
    return fail({
      code: "step-proof-invalid",
      message: "The output artifact proof contains duplicate identities.",
    });
  }
  const artifact = artifactsById.get(output.artifact.artifactId);
  if (artifact === undefined) {
    return succeed({ reason: "result-proof-missing", status: "not-ready" });
  }
  if (
    !(
      artifactMatchesOutput(artifact, output, sinkStep, terminalAttempt) &&
      sameContract(output.contract, input.plan.outputContract)
    ) ||
    artifact.finalizedAt > input.createdAt
  ) {
    return fail({
      code: "step-proof-invalid",
      message:
        "The unique sink output does not match its finalized artifact and immutable output contract.",
    });
  }
  return succeed({
    manifestBody: {
      attemptSettlements: orderedSettlements,
      compiledWorkflowFingerprint: input.plan.compiledWorkflow.fingerprint,
      conclusion: "completed",
      cost: {
        reserved: 0,
        spent: input.cost.spent,
        unit: input.cost.unit,
      },
      coverage: "complete",
      createdAt: input.createdAt,
      entries: orderedSteps.map((stepRun) =>
        toManifestEntry(stepRun, stepsByNodeKey)
      ),
      manifestVersion: 1,
      output: { ...output, status: "accepted" },
      outputContract: input.plan.outputContract,
      planHash: input.plan.planHash,
      resultCompleteness: "complete",
      runId: input.run.runId,
      runPlanId: input.run.runPlanId,
      sourceRunAggregateVersion: input.run.aggregateVersion,
      workspaceId: input.run.workspaceId,
    },
    status: "completed",
  });
};
