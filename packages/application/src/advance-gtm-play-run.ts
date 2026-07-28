import type {
  GtmPersistencePort,
  GtmPlayRunExecution,
  GtmPlayRunStageReceipt,
  GtmPlayRunState,
  GtmWorkbookSelectionReason,
  StoredGtmPlayRun,
  WorkspaceScope,
} from "@kurobara/ports";

export type GtmPlayGenerationSnapshot = Readonly<{
  cost: GtmPlayRunStageReceipt["cost"];
  datasetId?: GtmPlayRunStageReceipt["datasetId"];
  error?: Readonly<{
    code: string;
    message: string;
    retryable: boolean;
  }>;
  generationId: string;
  materializationId?: GtmPlayRunStageReceipt["materializationId"];
  provenance: readonly string[];
  providerCalls: number;
  recordCount?: number;
  selectedRecordIds?: readonly string[];
  selectionReasons?: readonly GtmWorkbookSelectionReason[];
  state: "ambiguous" | "cancelled" | "completed" | "failed" | "running";
}>;

export type GtmPlayProjectionResult = Readonly<{
  provenance: readonly string[];
  result: NonNullable<GtmPlayRunExecution["result"]>;
}>;

export type AdvanceGtmPlayRunDependencies = Readonly<{
  claimLeaseMs: number;
  clock: Readonly<{ now: () => Promise<number> }>;
  inspectGeneration: (
    run: StoredGtmPlayRun,
    stage: GtmPlayRunStageReceipt
  ) => Promise<GtmPlayGenerationSnapshot>;
  nextClaimToken: () => string;
  persistence: GtmPersistencePort;
  projectWorkbook: (
    run: StoredGtmPlayRun,
    stage: GtmPlayRunStageReceipt
  ) => Promise<GtmPlayProjectionResult>;
  startStage: (
    run: StoredGtmPlayRun,
    stage: GtmPlayRunStageReceipt
  ) => Promise<GtmPlayGenerationSnapshot>;
  workerId: string;
}>;

export type AdvanceGtmPlayRunResult = Readonly<{
  idle: boolean;
  run?: StoredGtmPlayRun;
  status: "conflict" | "idle" | "updated";
}>;

const aggregateExecution = (
  execution: GtmPlayRunExecution,
  stages: readonly GtmPlayRunStageReceipt[],
  provenance: readonly string[]
): GtmPlayRunExecution => ({
  ...execution,
  cost: {
    reserved: stages.reduce((total, stage) => total + stage.cost.reserved, 0),
    spent: stages.reduce((total, stage) => total + stage.cost.spent, 0),
    unit: execution.cost.unit,
  },
  providerCalls: stages.reduce(
    (total, stage) => total + stage.providerCalls,
    0
  ),
  provenance: [...new Set([...execution.provenance, ...provenance])].slice(
    0,
    256
  ),
  stages,
});

const terminalExecution = (
  execution: GtmPlayRunExecution,
  code: string,
  message: string,
  retryable: boolean
): GtmPlayRunExecution => ({
  ...execution,
  error: { code, message, retryable },
});

const snapshotStage = (
  current: GtmPlayRunStageReceipt,
  snapshot: GtmPlayGenerationSnapshot
): GtmPlayRunStageReceipt => {
  let state: GtmPlayRunStageReceipt["state"] = "failed";
  if (snapshot.state === "completed") {
    state = "completed";
  } else if (snapshot.state === "running") {
    state = "running";
  }
  return {
    cost: snapshot.cost,
    ...(snapshot.datasetId === undefined
      ? {}
      : { datasetId: snapshot.datasetId }),
    generationId: snapshot.generationId,
    ...(snapshot.materializationId === undefined
      ? {}
      : { materializationId: snapshot.materializationId }),
    operationId: current.operationId,
    ordinal: current.ordinal,
    providerCalls: snapshot.providerCalls,
    ...(snapshot.recordCount === undefined
      ? {}
      : { recordCount: snapshot.recordCount }),
    state,
  };
};

const replaceStage = (
  stages: readonly GtmPlayRunStageReceipt[],
  replacement: GtmPlayRunStageReceipt
): readonly GtmPlayRunStageReceipt[] =>
  stages.map((stage) =>
    stage.ordinal === replacement.ordinal ? replacement : stage
  );

const failureState = (
  state: GtmPlayGenerationSnapshot["state"]
): GtmPlayRunState => {
  if (state === "cancelled") {
    return "cancelled";
  }
  return state === "ambiguous" ? "paused" : "failed";
};

const scopeFor = (run: StoredGtmPlayRun): WorkspaceScope => ({
  workspaceId: run.workspaceId,
});

const validateDependencies = (
  dependencies: AdvanceGtmPlayRunDependencies
): void => {
  if (
    !Number.isSafeInteger(dependencies.claimLeaseMs) ||
    dependencies.claimLeaseMs <= 0 ||
    dependencies.workerId.trim().length === 0 ||
    dependencies.workerId !== dependencies.workerId.trim()
  ) {
    throw new RangeError(
      "The GTM Play scheduler requires a positive claim lease and a bounded worker identity."
    );
  }
};

type PlayProgress = Readonly<{
  execution: GtmPlayRunExecution;
  state: GtmPlayRunState;
}>;

const projectWorkbookStage = async (
  dependencies: AdvanceGtmPlayRunDependencies,
  run: StoredGtmPlayRun,
  current: GtmPlayRunStageReceipt,
  execution: GtmPlayRunExecution
): Promise<PlayProgress> => {
  try {
    const projected = await dependencies.projectWorkbook(run, current);
    const completedStage: GtmPlayRunStageReceipt = {
      ...current,
      datasetId: projected.result.datasetId,
      materializationId: projected.result.materializationId,
      recordCount: projected.result.recordCount,
      state: "completed",
    };
    return {
      execution: aggregateExecution(
        {
          ...execution,
          currentStageOrdinal: current.ordinal,
          result: projected.result,
        },
        replaceStage(execution.stages, completedStage),
        projected.provenance
      ),
      state: "completed",
    };
  } catch {
    return {
      execution: terminalExecution(
        execution,
        "play-workbook-projection-failed",
        "The final Workbook could not be projected from the durable dataset.",
        true
      ),
      state: "paused",
    };
  }
};

const unavailableSnapshot = (
  current: GtmPlayRunStageReceipt
): GtmPlayGenerationSnapshot => ({
  cost: current.cost,
  error: {
    code: "play-stage-unavailable",
    message: "The durable child generation could not be started or inspected.",
    retryable: true,
  },
  generationId: current.generationId ?? `unavailable-${current.ordinal}`,
  provenance: [],
  providerCalls: current.providerCalls,
  state: "ambiguous",
});

const captureStageSnapshot = async (
  dependencies: AdvanceGtmPlayRunDependencies,
  run: StoredGtmPlayRun,
  current: GtmPlayRunStageReceipt
): Promise<GtmPlayGenerationSnapshot> => {
  try {
    if (current.state === "pending") {
      return await dependencies.startStage(run, current);
    }
    return await dependencies.inspectGeneration(run, current);
  } catch {
    return unavailableSnapshot(current);
  }
};

const exceedsAuthorityCaps = (
  execution: GtmPlayRunExecution,
  run: StoredGtmPlayRun
): boolean =>
  execution.providerCalls > run.definition.preview.maxProviderCalls ||
  execution.cost.unit !== run.definition.budget.unit ||
  execution.cost.reserved > run.definition.budget.limit ||
  execution.cost.spent > run.definition.budget.limit;

const stageFailure = (
  execution: GtmPlayRunExecution,
  snapshot: GtmPlayGenerationSnapshot
): PlayProgress => ({
  execution: terminalExecution(
    execution,
    snapshot.error?.code ?? `play-stage-${snapshot.state}`,
    snapshot.error?.message ??
      "A durable child generation did not complete successfully.",
    snapshot.error?.retryable ?? snapshot.state === "ambiguous"
  ),
  state: failureState(snapshot.state),
});

const advanceGenerationStage = async (
  dependencies: AdvanceGtmPlayRunDependencies,
  run: StoredGtmPlayRun,
  current: GtmPlayRunStageReceipt,
  execution: GtmPlayRunExecution
): Promise<PlayProgress> => {
  const snapshot = await captureStageSnapshot(dependencies, run, current);
  const stages = replaceStage(
    execution.stages,
    snapshotStage(current, snapshot)
  );
  const nextExecution = aggregateExecution(
    {
      ...execution,
      currentStageOrdinal: current.ordinal,
      ...(snapshot.selectedRecordIds === undefined
        ? {}
        : { selectedRecordIds: snapshot.selectedRecordIds }),
      ...(snapshot.selectionReasons === undefined
        ? {}
        : { selectionReasons: snapshot.selectionReasons }),
    },
    stages,
    snapshot.provenance
  );
  if (exceedsAuthorityCaps(nextExecution, run)) {
    return {
      execution: terminalExecution(
        nextExecution,
        "play-budget-cap-exceeded",
        "A durable stage receipt exceeded the approved Play budget or provider-call cap.",
        false
      ),
      state: "failed",
    };
  }
  if (
    snapshot.state === "failed" ||
    snapshot.state === "cancelled" ||
    snapshot.state === "ambiguous"
  ) {
    return stageFailure(nextExecution, snapshot);
  }
  return {
    execution: nextExecution,
    state: run.state === "queued" ? "running" : run.state,
  };
};

const advanceClaimedRun = async (
  dependencies: AdvanceGtmPlayRunDependencies,
  run: StoredGtmPlayRun,
  nowMs: number
): Promise<PlayProgress> => {
  if (nowMs >= run.definition.deadlineMs) {
    return {
      execution: terminalExecution(
        run.execution,
        "play-deadline-elapsed",
        "The Play deadline elapsed before the next durable checkpoint.",
        false
      ),
      state: "failed",
    };
  }
  const current = run.execution.stages.find(
    (stage) => stage.state !== "completed"
  );
  if (current === undefined) {
    return {
      execution: terminalExecution(
        run.execution,
        "play-checkpoint-invalid",
        "The Play has no remaining stage and no terminal result.",
        false
      ),
      state: "failed",
    };
  }
  if (
    current.operationId === "workbooks.project" &&
    current.state === "pending"
  ) {
    return await projectWorkbookStage(
      dependencies,
      run,
      current,
      run.execution
    );
  }
  return await advanceGenerationStage(
    dependencies,
    run,
    current,
    run.execution
  );
};

export const makeAdvanceNextGtmPlayRun = (
  dependencies: AdvanceGtmPlayRunDependencies
) => {
  validateDependencies(dependencies);
  return async (): Promise<AdvanceGtmPlayRunResult> => {
    const nowMs = Number(await dependencies.clock.now());
    const claim = await dependencies.persistence.claimNextPlayRun(
      dependencies.workerId,
      dependencies.nextClaimToken(),
      nowMs,
      dependencies.claimLeaseMs
    );
    if (claim === undefined) {
      return { idle: true, status: "idle" };
    }
    const run = claim.run;
    const progress = await advanceClaimedRun(dependencies, run, nowMs);
    const updated = await dependencies.persistence.updatePlayRun(
      scopeFor(run),
      {
        claimToken: claim.claimToken,
        execution: progress.execution,
        expectedRevision: run.revision,
        runId: run.runId,
        state: progress.state,
        updatedAtMs: nowMs,
      }
    );
    return updated.status === "updated"
      ? { idle: false, run: updated.run, status: "updated" }
      : { idle: false, status: "conflict" };
  };
};
