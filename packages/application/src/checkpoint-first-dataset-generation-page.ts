import {
  amountsEqual,
  cancelDatasetGenerationAfterStop,
  checkpointDatasetGenerationPageProgress,
  commitDatasetGenerationPage,
  completeDatasetGeneration,
  contentHash,
  createContactProviderIdentity,
  createRecord,
  type DatasetGenerationCreation,
  type DatasetGenerationPage,
  type DatasetGenerationPageArtifact,
  type DatasetGenerationPlan,
  type DomainResult,
  datasetGenerationAcceptedRecordLimit,
  datasetId,
  fail,
  failDatasetGeneration,
  fieldId,
  markDatasetGenerationAmbiguous,
  markDatasetGenerationPageAmbiguous,
  markDatasetGenerationPageFailed,
  recordId,
  succeed,
  validateDatasetGenerationSnapshot,
  workspaceId,
} from "@kurobara/kernel";
import type {
  ClockPort,
  DatasetGenerationFirstPagePersistencePort,
  DatasetGenerationFirstPageUnitOfWork,
  DatasetGenerationPageRunProof,
  NormalizedJsonValue,
  StoredDatasetGenerationPlan,
  WorkspaceScope,
} from "@kurobara/ports";
import {
  datasetGenerationPageInputContract,
  datasetGenerationPageOutputContract,
} from "./authorize-first-dataset-generation-page.ts";
import {
  canonicalContentByteSize,
  canonicalContentHash,
} from "./canonical-content-hash.ts";

const MAX_ARTIFACT_BYTES = 65_536;
const CONTENT_HASH_PATTERN = /^sha256:[0-9a-f]{64}$/u;

const amountDoesNotExceed = (value: number, limit: number): boolean =>
  value < limit || amountsEqual(value, limit);

export type CheckpointFirstDatasetGenerationPageRequest = Readonly<{
  generationId: DatasetGenerationPage["generationId"];
  workspaceId: DatasetGenerationPage["workspaceId"];
}>;

export type CheckpointFirstDatasetGenerationPageFailureCode =
  | "artifact-invalid"
  | "checkpoint-conflict"
  | "generation-not-found"
  | "generation-plan-not-found"
  | "generation-proof-invalid"
  | "page-not-found"
  | "run-proof-invalid";

export type CheckpointFirstDatasetGenerationPageFailure = Readonly<{
  code: CheckpointFirstDatasetGenerationPageFailureCode;
  message: string;
  domainCode?: string;
}>;

export type CheckpointFirstDatasetGenerationPageSuccess = Readonly<{
  page: DatasetGenerationPage;
  status:
    | "ambiguous"
    | "cancelled"
    | "checkpointed"
    | "failed"
    | "pending"
    | "unchanged";
}>;

export type CheckpointFirstDatasetGenerationPageResult = DomainResult<
  CheckpointFirstDatasetGenerationPageSuccess,
  CheckpointFirstDatasetGenerationPageFailure
>;

export type CheckpointFirstDatasetGenerationPageDependencies = Readonly<{
  clock: ClockPort;
  persistence: DatasetGenerationFirstPagePersistencePort;
}>;

type ParsedPageArtifact = Readonly<{
  artifact: DatasetGenerationPageArtifact;
  records: readonly DatasetGenerationPageArtifact["items"][number][];
}>;

const invalid = (
  code: CheckpointFirstDatasetGenerationPageFailureCode,
  message: string,
  domainCode?: string
): CheckpointFirstDatasetGenerationPageResult =>
  fail({ code, ...(domainCode === undefined ? {} : { domainCode }), message });

const checkpointFailure = (
  code: CheckpointFirstDatasetGenerationPageFailureCode,
  message: string,
  domainCode?: string
): CheckpointFirstDatasetGenerationPageFailure => ({
  code,
  ...(domainCode === undefined ? {} : { domainCode }),
  message,
});

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" &&
  value !== null &&
  !Array.isArray(value) &&
  (Object.getPrototypeOf(value) === Object.prototype ||
    Object.getPrototypeOf(value) === null);

const hasExactKeys = (
  value: Record<string, unknown>,
  keys: readonly string[]
): boolean => {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === expected[index])
  );
};

const parseRecordValue = (
  value: unknown
):
  | Readonly<{ fieldId: ReturnType<typeof fieldId>; value: unknown }>
  | undefined => {
  if (!(isObject(value) && hasExactKeys(value, ["fieldId", "value"]))) {
    return;
  }
  if (typeof value.fieldId !== "string") {
    return;
  }
  const scalar = value.value;
  if (
    !(
      scalar === null ||
      typeof scalar === "boolean" ||
      typeof scalar === "string" ||
      (typeof scalar === "number" && Number.isFinite(scalar))
    )
  ) {
    return;
  }
  try {
    return { fieldId: fieldId(value.fieldId), value: scalar };
  } catch {
    // Invalid branded identities make the artifact inadmissible.
  }
};

type PageArtifactItem = DatasetGenerationPageArtifact["items"][number];

const parseArtifactProviderIdentity = (
  value: unknown
): NonNullable<PageArtifactItem["providerIdentity"]> | undefined => {
  if (
    !(
      isObject(value) &&
      hasExactKeys(value, ["providerKey", "providerSubjectId"])
    ) ||
    typeof value.providerKey !== "string" ||
    typeof value.providerSubjectId !== "string"
  ) {
    return;
  }
  const validIdentity = createContactProviderIdentity({
    providerKey: value.providerKey,
    providerSubjectId: value.providerSubjectId,
  });
  return validIdentity.ok ? validIdentity.value : undefined;
};

const parseArtifactSource = (
  value: unknown
): NonNullable<PageArtifactItem["source"]> | undefined => {
  if (
    !(isObject(value) && hasExactKeys(value, ["datasetId", "recordId"])) ||
    typeof value.datasetId !== "string" ||
    typeof value.recordId !== "string"
  ) {
    return;
  }
  try {
    return {
      datasetId: datasetId(value.datasetId),
      recordId: recordId(value.recordId),
    };
  } catch {
    return;
  }
};

const parseArtifactRecord = (
  rawContentHash: unknown,
  value: unknown,
  plan: DatasetGenerationPlan
): Pick<PageArtifactItem, "contentHash" | "record"> | undefined => {
  if (
    typeof rawContentHash !== "string" ||
    !CONTENT_HASH_PATTERN.test(rawContentHash) ||
    !isObject(value) ||
    !hasExactKeys(value, ["datasetId", "recordId", "values", "workspaceId"]) ||
    typeof value.datasetId !== "string" ||
    typeof value.recordId !== "string" ||
    typeof value.workspaceId !== "string" ||
    !Array.isArray(value.values)
  ) {
    return;
  }
  const parsedValues = value.values.map(parseRecordValue);
  if (parsedValues.some((entry) => entry === undefined)) {
    return;
  }
  try {
    const record = {
      datasetId: datasetId(value.datasetId),
      recordId: recordId(value.recordId),
      values: parsedValues as PageArtifactItem["record"]["values"],
      workspaceId: workspaceId(value.workspaceId),
    };
    const valid = createRecord(
      plan.requestIntent.targetDataset,
      plan.requestIntent.fields,
      record
    );
    if (!valid.ok || canonicalContentHash(valid.value) !== rawContentHash) {
      return;
    }
    return {
      contentHash: contentHash(rawContentHash),
      record: valid.value,
    };
  } catch {
    return;
  }
};

const parseArtifactItem = (
  value: unknown,
  plan: DatasetGenerationPlan
): DatasetGenerationPageArtifact["items"][number] | undefined => {
  if (!isObject(value)) {
    return;
  }
  const hasProviderIdentity = Object.hasOwn(value, "providerIdentity");
  const hasSource = Object.hasOwn(value, "source");
  const capabilityId = plan.requestIntent.capability.capabilityId;
  const isDerivedContactArtifact =
    capabilityId === "contacts.identity.reveal" ||
    capabilityId === "contacts.work-email.resolve" ||
    capabilityId === "contacts.work-email.verify";
  const isContactArtifact =
    capabilityId === "contacts.discover" || isDerivedContactArtifact;
  if (
    !hasExactKeys(value, [
      "contentHash",
      ...(hasProviderIdentity ? ["providerIdentity"] : []),
      "record",
      ...(hasSource ? ["source"] : []),
    ]) ||
    hasProviderIdentity !== isContactArtifact ||
    hasSource !== isDerivedContactArtifact
  ) {
    return;
  }
  const providerIdentity = hasProviderIdentity
    ? parseArtifactProviderIdentity(value.providerIdentity)
    : undefined;
  if (hasProviderIdentity && providerIdentity === undefined) {
    return;
  }
  const source = hasSource ? parseArtifactSource(value.source) : undefined;
  if (hasSource && source === undefined) {
    return;
  }
  const parsedRecord = parseArtifactRecord(
    value.contentHash,
    value.record,
    plan
  );
  if (parsedRecord === undefined) {
    return;
  }
  return {
    ...parsedRecord,
    ...(providerIdentity === undefined ? {} : { providerIdentity }),
    ...(source === undefined ? {} : { source }),
  };
};

const selectedSourceForPage = (
  plan: DatasetGenerationPlan,
  pageSequence: number
): Readonly<{ datasetId: string; recordId: string }> | undefined => {
  const query = plan.normalizedQuery;
  if (!(isObject(query) && Array.isArray(query.selected_contacts))) {
    return;
  }
  const selected = query.selected_contacts[pageSequence - 1];
  if (
    !isObject(selected) ||
    typeof query.source_dataset_id !== "string" ||
    typeof selected.source_record_id !== "string"
  ) {
    return;
  }
  return {
    datasetId: query.source_dataset_id,
    recordId: selected.source_record_id,
  };
};

const selectedContactLineageIsExact = (
  page: DatasetGenerationPage,
  plan: DatasetGenerationPlan,
  records: readonly DatasetGenerationPageArtifact["items"][number][]
): boolean => {
  const capabilityId = plan.requestIntent.capability.capabilityId;
  const derived =
    capabilityId === "contacts.identity.reveal" ||
    capabilityId === "contacts.work-email.resolve" ||
    capabilityId === "contacts.work-email.verify";
  if (!derived) {
    return records.every((item) => item.source === undefined);
  }
  const expected = selectedSourceForPage(plan, page.pageSequence);
  return (
    expected !== undefined &&
    records.length <= 1 &&
    records.every(
      (item) =>
        item.source?.datasetId === expected.datasetId &&
        item.source.recordId === expected.recordId &&
        item.record.recordId === item.source.recordId
    )
  );
};

const contactProviderNamespaceIsExact = (
  plan: DatasetGenerationPlan,
  effectAdapterKey: string,
  records: readonly DatasetGenerationPageArtifact["items"][number][]
): boolean => {
  const route = plan.routeSnapshots.find(
    (candidate) => candidate.effectAdapterKey === effectAdapterKey
  );
  const expectedNamespace =
    route?.providerIdentityNamespace ?? effectAdapterKey;
  return records.every(
    (item) =>
      item.providerIdentity === undefined ||
      item.providerIdentity.providerKey === expectedNamespace
  );
};

const parsePageArtifact = (
  value: NormalizedJsonValue,
  plan: DatasetGenerationPlan
): ParsedPageArtifact | undefined => {
  if (
    canonicalContentByteSize(value) > MAX_ARTIFACT_BYTES ||
    !isObject(value) ||
    !hasExactKeys(value, [
      "hasMore",
      "items",
      "nextCursor",
      "sourcePartitionCompleted",
      "version",
    ]) ||
    value.version !== "1.0.0" ||
    typeof value.hasMore !== "boolean" ||
    typeof value.sourcePartitionCompleted !== "boolean" ||
    !(value.nextCursor === null || typeof value.nextCursor === "string") ||
    !Array.isArray(value.items)
  ) {
    return;
  }
  if (
    (value.hasMore &&
      (typeof value.nextCursor !== "string" ||
        value.nextCursor.trim().length === 0 ||
        value.sourcePartitionCompleted)) ||
    (!value.hasMore &&
      (value.nextCursor !== null || !value.sourcePartitionCompleted)) ||
    (value.sourcePartitionCompleted && value.hasMore)
  ) {
    return;
  }
  const items = value.items.map((item) => parseArtifactItem(item, plan));
  if (items.some((item) => item === undefined)) {
    return;
  }
  const records =
    items as readonly DatasetGenerationPageArtifact["items"][number][];
  const recordIds = new Set(records.map((item) => item.record.recordId));
  if (recordIds.size !== records.length) {
    return;
  }
  return {
    artifact: {
      hasMore: value.hasMore,
      items: records,
      nextCursor: value.nextCursor,
      sourcePartitionCompleted: value.sourcePartitionCompleted,
      version: "1.0.0",
    },
    records,
  };
};

const sameContract = (
  left: DatasetGenerationPlan["queryContract"],
  right: DatasetGenerationPlan["queryContract"]
): boolean =>
  left.catalogFingerprint === right.catalogFingerprint &&
  left.catalogVersion === right.catalogVersion &&
  left.schemaFingerprint === right.schemaFingerprint &&
  left.schemaId === right.schemaId &&
  left.schemaVersion === right.schemaVersion;

const successfulProofIsExact = (
  page: DatasetGenerationPage,
  plan: DatasetGenerationPlan,
  generation: DatasetGenerationCreation,
  proof: Extract<DatasetGenerationPageRunProof, { status: "succeeded" }>,
  parsed: ParsedPageArtifact
): boolean => {
  const {
    artifact,
    attempt,
    manifest,
    routingDecision,
    run,
    runPlan,
    stepRun,
    usage,
  } = proof;
  const { planHash: _runPlanHash, ...runPlanDraft } = runPlan;
  const {
    manifestHash: _manifestHash,
    resultManifestId: _manifestId,
    ...body
  } = manifest;
  const manifestOutput = manifest.output;
  const manifestEntry = manifest.entries[0];
  const settlement = manifest.attemptSettlements[0];
  const spentBeforePage =
    generation.generation.cost.spent - (page.costAmount ?? 0);
  const lockedProviderBeforePage =
    page.pageSequence === 1 ? undefined : generation.generation.lockedProvider;
  return (
    page.state !== "run_created" &&
    run.runId === page.runId &&
    run.runPlanId === page.runPlanId &&
    run.workspaceId === page.workspaceId &&
    run.state === "completed" &&
    run.resultManifest?.resultManifestId === manifest.resultManifestId &&
    run.resultManifest?.manifestHash === manifest.manifestHash &&
    runPlan.runPlanId === page.runPlanId &&
    runPlan.workspaceId === page.workspaceId &&
    canonicalContentHash(runPlan.authority) ===
      canonicalContentHash(plan.authority) &&
    runPlan.deadline === plan.deadline &&
    runPlan.policyFactsHash === plan.policy.factsHash &&
    runPlan.policyVersion === plan.policy.version &&
    runPlan.budget.limit === plan.hardExecutionCap - spentBeforePage &&
    runPlan.budget.reserved === 0 &&
    runPlan.budget.spent === 0 &&
    runPlan.budget.unit === plan.budget.unit &&
    runPlan.quote.quoteId === plan.quote.quoteId &&
    runPlan.quote.pricingVersion === plan.quote.pricingVersion &&
    runPlan.quote.unit === plan.quote.unit &&
    runPlan.quote.upperBound === plan.hardExecutionCap - spentBeforePage &&
    runPlan.normalizedInputHash === page.inputContentHash &&
    runPlan.planHash === canonicalContentHash(runPlanDraft) &&
    runPlan.planHash === manifest.planHash &&
    sameContract(
      runPlan.inputContract,
      datasetGenerationPageInputContract(plan)
    ) &&
    sameContract(
      runPlan.outputContract,
      datasetGenerationPageOutputContract(plan)
    ) &&
    runPlan.compiledWorkflow.nodes.length === 1 &&
    runPlan.compiledWorkflow.nodes[0]?.key === "page" &&
    runPlan.compiledWorkflow.nodes[0]?.dependsOn.length === 0 &&
    runPlan.compiledWorkflow.nodes[0]?.capability.capabilityId ===
      plan.requestIntent.capability.capabilityId &&
    runPlan.compiledWorkflow.nodes[0]?.capability.capabilityVersion ===
      plan.requestIntent.capability.capabilityVersion &&
    runPlan.routeSnapshots?.length ===
      plan.routeSnapshots.filter(
        (route) =>
          lockedProviderBeforePage === undefined ||
          route.effectAdapterKey === lockedProviderBeforePage
      ).length &&
    runPlan.routeSnapshots.every((route, index) => {
      const source = plan.routeSnapshots.filter(
        (candidate) =>
          lockedProviderBeforePage === undefined ||
          candidate.effectAdapterKey === lockedProviderBeforePage
      )[index];
      return (
        source !== undefined &&
        route.nodeKey === "page" &&
        route.routeKey === source.routeKey &&
        route.effectAdapterKey === source.effectAdapterKey &&
        route.factsHash === source.factsHash &&
        route.pricingVersion === source.pricingVersion &&
        route.reservationUnit === source.reservationUnit &&
        route.reservableUpperBound ===
          Math.min(
            source.reservableUpperBound,
            plan.hardExecutionCap - spentBeforePage
          ) &&
        route.capability.capabilityId === source.capability.capabilityId &&
        route.capability.capabilityVersion ===
          source.capability.capabilityVersion
      );
    }) &&
    stepRun.runId === page.runId &&
    stepRun.workspaceId === page.workspaceId &&
    stepRun.nodeKey === "page" &&
    stepRun.state === "succeeded" &&
    stepRun.stepRunId === attempt.stepRunId &&
    stepRun.attempts.at(-1)?.attemptId === attempt.attemptId &&
    attempt.state === "succeeded" &&
    page.stepRunId === stepRun.stepRunId &&
    page.attemptId === attempt.attemptId &&
    page.operationKey === attempt.operationKey &&
    page.providerKey === attempt.effectAdapterKey &&
    page.reservationId === attempt.costReservationId &&
    page.reservedAmount === attempt.reservedAmount &&
    page.costUnit === attempt.reservationUnit &&
    page.routeKey === attempt.routeKey &&
    page.routeSnapshotHash === attempt.routeSnapshotHash &&
    page.routingDecisionId === attempt.routingDecisionId &&
    attempt.output?.artifact.artifactId === artifact.artifactId &&
    attempt.output?.artifact.contentHash === artifact.contentHash &&
    attempt.output !== undefined &&
    sameContract(attempt.output.contract, runPlan.outputContract) &&
    attempt.operationKey === artifact.operationKey &&
    attempt.operationKey === usage.operationKey &&
    attempt.routingDecisionId === routingDecision.routingDecisionId &&
    attempt.costReservationId === usage.reservationId &&
    attempt.attemptId === artifact.attemptId &&
    attempt.attemptId === usage.attemptId &&
    attempt.effectAdapterKey === routingDecision.effectAdapterKey &&
    contactProviderNamespaceIsExact(
      plan,
      routingDecision.effectAdapterKey,
      parsed.records
    ) &&
    selectedContactLineageIsExact(page, plan, parsed.records) &&
    attempt.routeKey === routingDecision.routeKey &&
    attempt.routeSnapshotHash === routingDecision.routeSnapshotHash &&
    attempt.reservedAmount === routingDecision.reservedAmount &&
    attempt.reservationUnit === routingDecision.reservationUnit &&
    routingDecision.runId === page.runId &&
    routingDecision.stepRunId === stepRun.stepRunId &&
    routingDecision.workspaceId === page.workspaceId &&
    usage.runId === page.runId &&
    usage.workspaceId === page.workspaceId &&
    usage.unit === attempt.reservationUnit &&
    amountDoesNotExceed(usage.amount, attempt.reservedAmount) &&
    artifact.runId === page.runId &&
    artifact.stepRunId === stepRun.stepRunId &&
    artifact.workspaceId === page.workspaceId &&
    artifact.sizeBytes === canonicalContentByteSize(proof.artifactValue) &&
    artifact.contentHash === canonicalContentHash(proof.artifactValue) &&
    artifact.sizeBytes <= MAX_ARTIFACT_BYTES &&
    sameContract(artifact.contract, runPlan.outputContract) &&
    manifest.manifestHash === canonicalContentHash(body) &&
    manifest.runId === page.runId &&
    manifest.runPlanId === page.runPlanId &&
    manifest.workspaceId === page.workspaceId &&
    manifest.conclusion === "completed" &&
    manifest.resultCompleteness === "complete" &&
    manifest.cost.reserved === 0 &&
    amountsEqual(manifest.cost.spent, usage.amount) &&
    manifest.cost.unit === usage.unit &&
    manifest.entries.length === 1 &&
    manifestEntry?.stepRunId === stepRun.stepRunId &&
    manifestEntry?.terminalAttemptId === attempt.attemptId &&
    manifestEntry?.state === "succeeded" &&
    manifestEntry?.result.status === "accepted" &&
    manifestEntry.result.artifact.artifactId === artifact.artifactId &&
    manifestEntry.result.artifact.contentHash === artifact.contentHash &&
    sameContract(manifestEntry.result.contract, runPlan.outputContract) &&
    manifestOutput.status === "accepted" &&
    manifestOutput.artifact.artifactId === artifact.artifactId &&
    manifestOutput.artifact.contentHash === artifact.contentHash &&
    sameContract(manifestOutput.contract, runPlan.outputContract) &&
    manifest.attemptSettlements.length === 1 &&
    settlement !== undefined &&
    settlement.attemptId === attempt.attemptId &&
    settlement.operationKey === attempt.operationKey &&
    settlement.reservationId === attempt.costReservationId &&
    settlement.disposition === "settled" &&
    settlement.settledAmount !== undefined &&
    settlement.usageEntryId !== undefined &&
    settlement.usageEntryId === usage.usageEntryId &&
    amountsEqual(settlement.settledAmount, usage.amount) &&
    amountsEqual(
      settlement.releasedAmount + usage.amount,
      attempt.reservedAmount
    ) &&
    settlement.unit === usage.unit
  );
};

const committedPageMatches = (
  page: DatasetGenerationPage,
  parsed: ParsedPageArtifact,
  proof: Extract<DatasetGenerationPageRunProof, { status: "succeeded" }>,
  checkpointHash: ReturnType<typeof canonicalContentHash>
): boolean =>
  page.state === "committed" &&
  page.acceptedCount !== undefined &&
  page.acceptedCount + (page.duplicateCount ?? 0) === parsed.records.length &&
  page.artifactId === proof.artifact.artifactId &&
  page.artifactContentHash === proof.artifact.contentHash &&
  page.attemptId === proof.attempt.attemptId &&
  page.costAmount === proof.usage.amount &&
  page.costUnit === proof.usage.unit &&
  page.checkpointHash === checkpointHash &&
  page.duplicateCount !== undefined &&
  page.hasMore === parsed.artifact.hasMore &&
  page.nextCursor === parsed.artifact.nextCursor &&
  page.operationKey === proof.attempt.operationKey &&
  page.providerKey === proof.routingDecision.effectAdapterKey &&
  page.reservationId === proof.usage.reservationId &&
  page.reservedAmount === proof.attempt.reservedAmount &&
  page.resultManifestId === proof.manifest.resultManifestId &&
  page.resultManifestHash === proof.manifest.manifestHash &&
  page.rejectedCount === 0 &&
  page.returnedCount === parsed.records.length &&
  page.routingDecisionId === proof.routingDecision.routingDecisionId &&
  page.routeKey === proof.routingDecision.routeKey &&
  page.routeSnapshotHash === proof.routingDecision.routeSnapshotHash &&
  page.sourcePartitionCompleted === parsed.artifact.sourcePartitionCompleted &&
  page.stepRunId === proof.stepRun.stepRunId &&
  page.usageEntryId === proof.usage.usageEntryId;

const committedGenerationMatches = (
  generation: DatasetGenerationCreation,
  page: DatasetGenerationPage,
  parsed: ParsedPageArtifact,
  proof: Extract<DatasetGenerationPageRunProof, { status: "succeeded" }>
): boolean =>
  (generation.generation.state === "running" ||
    generation.generation.state === "completed" ||
    generation.generation.state === "cancelled") &&
  generation.generation.lastPageSequence === page.pageSequence &&
  generation.generation.lockedProvider ===
    proof.routingDecision.effectAdapterKey &&
  generation.generation.counters.accepted >= (page.acceptedCount ?? 0) &&
  generation.generation.counters.calls === page.pageSequence &&
  generation.generation.counters.duplicates >= (page.duplicateCount ?? 0) &&
  generation.generation.counters.pages === page.pageSequence &&
  generation.generation.counters.rejected >= (page.rejectedCount ?? 0) &&
  generation.generation.counters.returned >= parsed.records.length &&
  generation.generation.cost.reserved === 0 &&
  generation.generation.cost.spent >= proof.usage.amount &&
  generation.generation.cost.unit === proof.usage.unit &&
  generation.materialization.recordCount ===
    generation.generation.counters.accepted &&
  generation.materialization.rejectedCount ===
    generation.generation.counters.rejected;

type CheckpointContext = Readonly<{
  generation: DatasetGenerationCreation;
  page: DatasetGenerationPage;
  storedPlan: StoredDatasetGenerationPlan;
}>;

type CheckpointTransactionInput = Readonly<{
  dependencies: CheckpointFirstDatasetGenerationPageDependencies;
  request: CheckpointFirstDatasetGenerationPageRequest;
  scope: WorkspaceScope;
  unitOfWork: DatasetGenerationFirstPageUnitOfWork;
}>;

type ValidatedSuccessfulProof = Readonly<{
  checkpointHash: ReturnType<typeof canonicalContentHash>;
  parsed: ParsedPageArtifact;
}>;

const loadCheckpointContext = async (
  input: CheckpointTransactionInput
): Promise<
  DomainResult<CheckpointContext, CheckpointFirstDatasetGenerationPageFailure>
> => {
  const { request, scope, unitOfWork } = input;
  const generation = await unitOfWork.generationPages.getGenerationForUpdate(
    scope,
    request.generationId
  );
  if (generation === undefined) {
    return fail(
      checkpointFailure(
        "generation-not-found",
        "The dataset generation does not exist."
      )
    );
  }
  const storedPlan = await unitOfWork.generationPlans.get(
    scope,
    generation.generation.generationPlanId
  );
  if (storedPlan === undefined) {
    return fail(
      checkpointFailure(
        "generation-plan-not-found",
        "The immutable generation plan does not exist."
      )
    );
  }
  const validGeneration = validateDatasetGenerationSnapshot(
    generation,
    storedPlan.plan
  );
  if (!validGeneration.ok) {
    return fail(
      checkpointFailure(
        "generation-proof-invalid",
        validGeneration.error.message,
        validGeneration.error.code
      )
    );
  }
  const page = await unitOfWork.generationPages.getPageForUpdate(
    scope,
    request.generationId,
    generation.generation.counters.pages
  );
  return page === undefined
    ? fail(
        checkpointFailure("page-not-found", "The active page does not exist.")
      )
    : succeed({ generation, page, storedPlan });
};

const projectAmbiguousProof = async (
  input: CheckpointTransactionInput,
  context: CheckpointContext
): Promise<CheckpointFirstDatasetGenerationPageResult> => {
  const { generation, page, storedPlan } = context;
  if (page.state === "committed") {
    return invalid(
      "checkpoint-conflict",
      "A committed page cannot become ambiguous."
    );
  }
  const marked = markDatasetGenerationAmbiguous(generation, storedPlan.plan);
  if (!marked.ok) {
    return invalid(
      "generation-proof-invalid",
      marked.error.message,
      marked.error.code
    );
  }
  const markedPage = markDatasetGenerationPageAmbiguous(page);
  if (!markedPage.ok) {
    return invalid(
      "generation-proof-invalid",
      markedPage.error.message,
      markedPage.error.code
    );
  }
  await input.unitOfWork.generationPages.updateGeneration(input.scope, {
    expectedGenerationVersion: generation.generation.aggregateVersion,
    expectedMaterializationRevision: generation.materialization.revision,
    value: marked.value,
  });
  await input.unitOfWork.generationPages.updatePage(
    input.scope,
    page.aggregateVersion,
    markedPage.value
  );
  return succeed({
    page: structuredClone(markedPage.value),
    status: "ambiguous",
  });
};

const projectFailedProof = async (
  input: CheckpointTransactionInput,
  context: CheckpointContext,
  reason: string
): Promise<CheckpointFirstDatasetGenerationPageResult> => {
  const completedAt = await input.dependencies.clock.now();
  const stopRequested = context.generation.generation.state === "stopping";
  const failed = stopRequested
    ? cancelDatasetGenerationAfterStop(
        context.generation,
        context.storedPlan.plan,
        completedAt
      )
    : failDatasetGeneration(context.generation, context.storedPlan.plan, {
        completedAt,
        completionReason: reason.slice(0, 128) || "page-failed",
      });
  const failedPage = markDatasetGenerationPageFailed(context.page);
  if (!failed.ok) {
    return invalid(
      "generation-proof-invalid",
      failed.error.message,
      failed.error.code
    );
  }
  if (!failedPage.ok) {
    return invalid(
      "generation-proof-invalid",
      failedPage.error.message,
      failedPage.error.code
    );
  }
  await input.unitOfWork.generationPages.updateGeneration(input.scope, {
    expectedGenerationVersion: context.generation.generation.aggregateVersion,
    expectedMaterializationRevision:
      context.generation.materialization.revision,
    value: failed.value,
  });
  await input.unitOfWork.generationPages.updatePage(
    input.scope,
    context.page.aggregateVersion,
    failedPage.value
  );
  return succeed({
    page: structuredClone(failedPage.value),
    status: stopRequested ? "cancelled" : "failed",
  });
};

const validateSuccessfulProof = (
  context: CheckpointContext,
  proof: Extract<DatasetGenerationPageRunProof, { status: "succeeded" }>
): DomainResult<
  ValidatedSuccessfulProof,
  CheckpointFirstDatasetGenerationPageFailure
> => {
  const { page, storedPlan } = context;
  const parsed = parsePageArtifact(proof.artifactValue, storedPlan.plan);
  if (parsed === undefined) {
    return fail(
      checkpointFailure(
        page.state === "committed" ? "checkpoint-conflict" : "artifact-invalid",
        page.state === "committed"
          ? "The committed page diverges from its durable artifact."
          : "The durable page artifact does not satisfy the exact page contract."
      )
    );
  }
  if (
    !successfulProofIsExact(
      page,
      storedPlan.plan,
      context.generation,
      proof,
      parsed
    )
  ) {
    return fail(
      checkpointFailure(
        page.state === "committed"
          ? "checkpoint-conflict"
          : "run-proof-invalid",
        page.state === "committed"
          ? "The committed page diverges from its canonical Run proof."
          : "The durable Run proof does not bind the page, artifact, route, usage, and manifest."
      )
    );
  }
  return succeed({
    checkpointHash: canonicalContentHash({
      artifact: parsed.artifact,
      proof,
      version: "1.0.0",
    }),
    parsed,
  });
};

const persistSuccessfulCheckpoint = async (
  input: CheckpointTransactionInput,
  context: CheckpointContext,
  proof: Extract<DatasetGenerationPageRunProof, { status: "succeeded" }>,
  validated: ValidatedSuccessfulProof
): Promise<CheckpointFirstDatasetGenerationPageResult> => {
  const { generation, page, storedPlan } = context;
  const { checkpointHash, parsed } = validated;
  const existingHashes = new Set(
    await input.unitOfWork.generationPages.findExistingContentHashes(
      input.scope,
      input.request.generationId,
      parsed.records.map((item) => item.contentHash)
    )
  );
  const seenHashes = new Set(existingHashes);
  const accepted = parsed.records
    .map((item, index) => ({ candidatePosition: index + 1, item }))
    .filter(({ item }) => {
      if (seenHashes.has(item.contentHash)) {
        return false;
      }
      seenHashes.add(item.contentHash);
      return true;
    });
  const duplicateCount = parsed.records.length - accepted.length;
  const checkpoint = checkpointDatasetGenerationPageProgress(
    generation,
    storedPlan.plan,
    {
      accepted: accepted.length,
      costAmount: proof.usage.amount,
      costUnit: proof.usage.unit,
      duplicates: duplicateCount,
      pageSequence: page.pageSequence,
      providerKey: proof.routingDecision.effectAdapterKey,
      rejected: 0,
      returned: parsed.records.length,
    }
  );
  if (!checkpoint.ok) {
    return invalid(
      "generation-proof-invalid",
      checkpoint.error.message,
      checkpoint.error.code
    );
  }
  const writes = accepted.map(({ candidatePosition, item }, index) => ({
    candidatePosition,
    contentHash: item.contentHash,
    generationId: input.request.generationId,
    pageSequence: page.pageSequence,
    record: item.record,
    recordOrdinal: generation.generation.counters.accepted + index + 1,
  }));
  await input.unitOfWork.generationPages.appendRecordsAndLineage(input.scope, {
    lineage: writes.map((write, index) => {
      const providerIdentity = accepted[index]?.item.providerIdentity;
      const source = accepted[index]?.item.source;
      return {
        artifactId: proof.artifact.artifactId,
        attemptId: proof.attempt.attemptId,
        candidatePosition: write.candidatePosition,
        generationId: input.request.generationId,
        operationKey: proof.attempt.operationKey,
        pageSequence: page.pageSequence,
        ...(providerIdentity === undefined ? {} : { providerIdentity }),
        recordId: write.record.recordId,
        recordOrdinal: write.recordOrdinal,
        reservationId: proof.usage.reservationId,
        resultManifestId: proof.manifest.resultManifestId,
        routingDecisionId: proof.routingDecision.routingDecisionId,
        runId: proof.run.runId,
        stepRunId: proof.stepRun.stepRunId,
        usageEntryId: proof.usage.usageEntryId,
        ...(source === undefined ? {} : { source }),
      };
    }),
    records: writes,
  });
  const committedPage = commitDatasetGenerationPage(page, {
    acceptedCount: accepted.length,
    artifactContentHash: proof.artifact.contentHash,
    artifactId: proof.artifact.artifactId,
    checkpointHash,
    committedAt: await input.dependencies.clock.now(),
    costAmount: proof.usage.amount,
    duplicateCount,
    hasMore: parsed.artifact.hasMore,
    nextCursor: parsed.artifact.nextCursor,
    rejectedCount: 0,
    resultManifestHash: proof.manifest.manifestHash,
    resultManifestId: proof.manifest.resultManifestId,
    returnedCount: parsed.records.length,
    sourcePartitionCompleted: parsed.artifact.sourcePartitionCompleted,
    usageEntryId: proof.usage.usageEntryId,
  });
  if (!committedPage.ok) {
    return invalid(
      "generation-proof-invalid",
      committedPage.error.message,
      committedPage.error.code
    );
  }
  const next = checkpoint.value.generation;
  const capsReached =
    next.counters.pages >= storedPlan.plan.limits.maxPages ||
    next.counters.calls >= storedPlan.plan.limits.maxCalls ||
    next.counters.returned >= storedPlan.plan.limits.maxResults ||
    next.counters.accepted >=
      datasetGenerationAcceptedRecordLimit(storedPlan.plan) ||
    next.cost.spent >= storedPlan.plan.hardExecutionCap;
  const stopRequested = checkpoint.value.generation.state === "stopping";
  const shouldComplete =
    !stopRequested && (!parsed.artifact.hasMore || capsReached);
  let generationValue = checkpoint.value;
  if (stopRequested) {
    const cancelled = cancelDatasetGenerationAfterStop(
      checkpoint.value,
      storedPlan.plan,
      committedPage.value.committedAt ?? (await input.dependencies.clock.now())
    );
    if (!cancelled.ok) {
      return invalid(
        "generation-proof-invalid",
        cancelled.error.message,
        cancelled.error.code
      );
    }
    generationValue = cancelled.value;
  } else if (shouldComplete) {
    const materializationContentHash =
      await input.unitOfWork.generationPages.computeMaterializationContentHash(
        input.scope,
        input.request.generationId
      );
    const completed = completeDatasetGeneration(
      checkpoint.value,
      storedPlan.plan,
      {
        completedAt:
          committedPage.value.committedAt ??
          (await input.dependencies.clock.now()),
        completionReason: capsReached ? "caps-reached" : "source-completed",
        contentHash: materializationContentHash,
        coverageStatus: capsReached
          ? "bounded"
          : "complete_for_declared_source",
      }
    );
    if (!completed.ok) {
      return invalid(
        "generation-proof-invalid",
        completed.error.message,
        completed.error.code
      );
    }
    generationValue = completed.value;
  }
  await input.unitOfWork.generationPages.updateGeneration(input.scope, {
    expectedGenerationVersion: generation.generation.aggregateVersion,
    expectedMaterializationRevision: generation.materialization.revision,
    value: checkpoint.value,
  });
  if (shouldComplete || stopRequested) {
    await input.unitOfWork.generationPages.updateGeneration(input.scope, {
      expectedGenerationVersion: checkpoint.value.generation.aggregateVersion,
      expectedMaterializationRevision:
        checkpoint.value.materialization.revision,
      value: generationValue,
    });
  }
  await input.unitOfWork.generationPages.updatePage(
    input.scope,
    page.aggregateVersion,
    committedPage.value
  );
  return succeed({
    page: structuredClone(committedPage.value),
    status: stopRequested ? "cancelled" : "checkpointed",
  });
};

const processSuccessfulProof = (
  input: CheckpointTransactionInput,
  context: CheckpointContext,
  proof: Extract<DatasetGenerationPageRunProof, { status: "succeeded" }>
): Promise<CheckpointFirstDatasetGenerationPageResult> => {
  const validated = validateSuccessfulProof(context, proof);
  if (!validated.ok) {
    return Promise.resolve(fail(validated.error));
  }
  if (context.page.state === "committed") {
    return Promise.resolve(
      committedPageMatches(
        context.page,
        validated.value.parsed,
        proof,
        validated.value.checkpointHash
      ) &&
        committedGenerationMatches(
          context.generation,
          context.page,
          validated.value.parsed,
          proof
        )
        ? succeed({
            page: structuredClone(context.page),
            status: "unchanged",
          })
        : invalid(
            "checkpoint-conflict",
            "The durable checkpoint diverges from the canonical Run proof."
          )
    );
  }
  return context.page.state === "executing"
    ? persistSuccessfulCheckpoint(input, context, proof, validated.value)
    : Promise.resolve(
        invalid(
          "checkpoint-conflict",
          "Only an executing page can consume a successful Run proof."
        )
      );
};

const checkpointInUnitOfWork = async (
  input: CheckpointTransactionInput
): Promise<CheckpointFirstDatasetGenerationPageResult> => {
  const loaded = await loadCheckpointContext(input);
  if (!loaded.ok) {
    return fail(loaded.error);
  }
  const { page } = loaded.value;
  if (page.state === "ambiguous") {
    return succeed({ page: structuredClone(page), status: "ambiguous" });
  }
  if (page.state === "failed") {
    return succeed({ page: structuredClone(page), status: "failed" });
  }
  const proof = await input.unitOfWork.generationPages.readRunProof(
    input.scope,
    page
  );
  if (proof.status === "pending") {
    return page.state === "committed"
      ? invalid(
          "checkpoint-conflict",
          "A committed page lost its durable Run proof."
        )
      : succeed({ page: structuredClone(page), status: "pending" });
  }
  if (proof.status === "ambiguous") {
    return projectAmbiguousProof(input, loaded.value);
  }
  if (proof.status === "failed") {
    return projectFailedProof(input, loaded.value, proof.reason);
  }
  return processSuccessfulProof(input, loaded.value, proof);
};

export const makeCheckpointFirstDatasetGenerationPage =
  (dependencies: CheckpointFirstDatasetGenerationPageDependencies) =>
  (
    request: CheckpointFirstDatasetGenerationPageRequest
  ): Promise<CheckpointFirstDatasetGenerationPageResult> => {
    const scope = { workspaceId: request.workspaceId } as const;
    return dependencies.persistence.transaction(scope, (unitOfWork) =>
      checkpointInUnitOfWork({
        dependencies,
        request,
        scope,
        unitOfWork,
      })
    );
  };

export type CheckpointDatasetGenerationPageRequest =
  CheckpointFirstDatasetGenerationPageRequest;
export type CheckpointDatasetGenerationPageResult =
  CheckpointFirstDatasetGenerationPageResult;
export type CheckpointDatasetGenerationPageDependencies =
  CheckpointFirstDatasetGenerationPageDependencies;
export const makeCheckpointDatasetGenerationPage =
  makeCheckpointFirstDatasetGenerationPage;
