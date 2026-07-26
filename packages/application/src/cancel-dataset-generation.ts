import {
  contentHash,
  type DatasetGenerationCreation,
  type DomainResult,
  datasetGenerationId,
  fail,
  InvalidValueObjectError,
  idempotencyKey,
  requestDatasetGenerationStop,
  succeed,
} from "@kurobara/kernel";
import type {
  ClockPort,
  DatasetGenerationCancellationPersistencePort,
  DatasetGenerationCancellationUnitOfWork,
  IdentifierPort,
  VerifiedApiKey,
  WorkspaceScope,
} from "@kurobara/ports";

import {
  CANCEL_RUN_COMMAND_HASH,
  cancelRunInUnitOfWork,
} from "./cancel-run.ts";

const CANCEL_DATASET_GENERATION_COMMAND_HASH = contentHash(
  "sha256:3b9d16e8ca745d5882f45fe3e21405a276d13aeb6f5272e8808903415bab253f"
);

export type CancelDatasetGenerationRequest = Readonly<{
  actor: VerifiedApiKey;
  correlationId: string;
  generationId: string;
  idempotencyKey: string;
}>;

export type CancelDatasetGenerationSuccess = Readonly<{
  generation: DatasetGenerationCreation;
  replayed: boolean;
}>;

export type CancelDatasetGenerationFailure = Readonly<{
  code:
    | "authority-permission-missing"
    | "dataset-generation-not-found"
    | "domain-rejected"
    | "idempotency-key-reused"
    | "request-invalid";
  domainCode?: string;
  message: string;
}>;

export type CancelDatasetGenerationResult = DomainResult<
  CancelDatasetGenerationSuccess,
  CancelDatasetGenerationFailure
>;

export type CancelDatasetGenerationDependencies = Readonly<{
  clock: ClockPort;
  identifiers: Pick<IdentifierPort, "nextEventId">;
  persistence: DatasetGenerationCancellationPersistencePort;
  requiredPermission?: string;
}>;

const rejected = (
  code: CancelDatasetGenerationFailure["code"],
  message: string,
  domainCode?: string
): CancelDatasetGenerationResult =>
  fail({ code, ...(domainCode === undefined ? {} : { domainCode }), message });

const cancelInUnitOfWork = async (
  dependencies: CancelDatasetGenerationDependencies,
  unitOfWork: DatasetGenerationCancellationUnitOfWork,
  scope: WorkspaceScope,
  request: CancelDatasetGenerationRequest,
  selectedGenerationId: ReturnType<typeof datasetGenerationId>,
  selectedIdempotencyKey: ReturnType<typeof idempotencyKey>
): Promise<CancelDatasetGenerationResult> => {
  const prior = await unitOfWork.generationCancellationJournal.find(
    scope,
    selectedIdempotencyKey
  );
  const generation = await unitOfWork.generationPages.getGenerationForUpdate(
    scope,
    selectedGenerationId
  );
  if (generation === undefined) {
    return rejected(
      "dataset-generation-not-found",
      "The dataset generation does not exist in this workspace."
    );
  }
  if (prior !== undefined) {
    return prior.generationId === selectedGenerationId &&
      prior.commandHash === CANCEL_DATASET_GENERATION_COMMAND_HASH
      ? succeed({ generation: structuredClone(generation), replayed: true })
      : rejected(
          "idempotency-key-reused",
          "The dataset generation cancellation key is already bound to another command."
        );
  }

  const storedPlan = await unitOfWork.generationPlans.get(
    scope,
    generation.generation.generationPlanId
  );
  if (storedPlan === undefined) {
    return rejected(
      "domain-rejected",
      "The immutable dataset generation plan is missing.",
      "generation-plan-not-found"
    );
  }
  if (storedPlan.plan.authority.subjectActorId !== request.actor.actorId) {
    return rejected(
      "authority-permission-missing",
      "Only the generation authority subject can cancel this dataset generation."
    );
  }

  if (
    generation.generation.stop !== undefined &&
    (generation.generation.state === "stopping" ||
      generation.generation.state === "cancelled" ||
      generation.generation.state === "ambiguous")
  ) {
    await unitOfWork.generationCancellationJournal.insert(scope, {
      commandHash: CANCEL_DATASET_GENERATION_COMMAND_HASH,
      generationId: selectedGenerationId,
      idempotencyKey: selectedIdempotencyKey,
      requestedAt: generation.generation.stop.requestedAt,
    });
    return succeed({ generation: structuredClone(generation), replayed: true });
  }
  if (
    generation.generation.state === "ambiguous" ||
    generation.generation.state === "completed" ||
    generation.generation.state === "failed"
  ) {
    return rejected(
      "domain-rejected",
      "A terminal or independently ambiguous generation cannot be cancelled.",
      `generation-${generation.generation.state}`
    );
  }

  const requestedAt = await dependencies.clock.now();
  const stopped = requestDatasetGenerationStop(generation, storedPlan.plan, {
    reason: "requested",
    requestedAt,
  });
  if (!stopped.ok) {
    return rejected(
      "domain-rejected",
      stopped.error.message,
      stopped.error.code
    );
  }

  const activeSequence =
    generation.generation.counters.pages === 0
      ? 1
      : generation.generation.counters.pages;
  const page = await unitOfWork.generationPages.getPageForUpdate(
    scope,
    selectedGenerationId,
    activeSequence
  );
  if (page?.state === "run_created") {
    const runCancellation = await cancelRunInUnitOfWork(
      dependencies,
      unitOfWork,
      scope,
      page.runId,
      {
        commandHash: CANCEL_RUN_COMMAND_HASH,
        idempotencyKey: selectedIdempotencyKey,
      },
      {
        actor: request.actor,
        correlationId: request.correlationId,
        idempotencyKey: request.idempotencyKey,
        runId: page.runId,
      }
    );
    if (!runCancellation.ok) {
      return rejected(
        "domain-rejected",
        "The canonical page Run could not be cancelled before its effect threshold.",
        runCancellation.error.domainCode ?? runCancellation.error.code
      );
    }
  }

  await unitOfWork.generationPages.updateGeneration(scope, {
    expectedGenerationVersion: generation.generation.aggregateVersion,
    expectedMaterializationRevision: generation.materialization.revision,
    value: stopped.value,
  });
  await unitOfWork.generationCancellationJournal.insert(scope, {
    commandHash: CANCEL_DATASET_GENERATION_COMMAND_HASH,
    generationId: selectedGenerationId,
    idempotencyKey: selectedIdempotencyKey,
    requestedAt,
  });
  return succeed({
    generation: structuredClone(stopped.value),
    replayed: false,
  });
};

export const makeCancelDatasetGeneration = (
  dependencies: CancelDatasetGenerationDependencies
) => {
  const requiredPermission =
    dependencies.requiredPermission ?? "datasets:generate";
  return async (
    request: CancelDatasetGenerationRequest
  ): Promise<CancelDatasetGenerationResult> => {
    if (!request.actor.permissions.includes(requiredPermission)) {
      return rejected(
        "authority-permission-missing",
        `Dataset generation cancellation requires ${requiredPermission}.`
      );
    }
    try {
      const selectedGenerationId = datasetGenerationId(request.generationId);
      const selectedIdempotencyKey = idempotencyKey(request.idempotencyKey);
      const scope = { workspaceId: request.actor.workspaceId } as const;
      return await dependencies.persistence.transaction(scope, (unitOfWork) =>
        cancelInUnitOfWork(
          dependencies,
          unitOfWork,
          scope,
          request,
          selectedGenerationId,
          selectedIdempotencyKey
        )
      );
    } catch (error) {
      if (error instanceof InvalidValueObjectError) {
        return rejected(
          "request-invalid",
          "The dataset generation cancellation request is invalid."
        );
      }
      throw error;
    }
  };
};
