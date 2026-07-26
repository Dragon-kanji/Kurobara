import { amountsEqual, isAmount } from "./amount.ts";
import type { ContactProviderIdentity } from "./contact-sourcing.ts";
import type { Dataset, Record as DatasetRecord, Field } from "./product.ts";
import { createDataset, validateDatasetFields } from "./product.ts";
import { type DomainResult, fail, succeed } from "./result.ts";
import type {
  AuthorityEnvelope,
  BudgetLimit,
  ContractRef,
  CostQuote,
} from "./run.ts";
import { isSupportedAuthorityEnvelopeVersion } from "./run.ts";
import type {
  ActorId,
  ArtifactId,
  AttemptId,
  ContentHash,
  CostReservationId,
  DatasetGenerationId,
  DatasetGenerationPlanId,
  DatasetMaterializationId,
  IdempotencyKey,
  Instant,
  OperationKey,
  ResultManifestId,
  RoutingDecisionId,
  RunId,
  RunPlanId,
  StepRunId,
  UsageEntryId,
  WorkspaceId,
} from "./value-objects.ts";
import { datasetMaterializationId } from "./value-objects.ts";
import type { CapabilityRef } from "./workflow.ts";

const CONTENT_HASH_PATTERN = /^sha256:[0-9a-f]{64}$/u;

export type DatasetGenerationQueryValue =
  | boolean
  | null
  | number
  | string
  | readonly DatasetGenerationQueryValue[]
  | Readonly<{ [key: string]: DatasetGenerationQueryValue }>;

export type DatasetGenerationQuerySnapshotResult = DomainResult<
  DatasetGenerationQueryValue,
  Readonly<{ code: "query-invalid"; message: string }>
>;

export const DATASET_GENERATION_LIMIT_NAMES = [
  "maxCompanies",
  "maxContactsPerCompany",
  "maxContactsTotal",
  "maxEnrichments",
  "maxPhones",
  "maxResults",
  "maxPages",
  "maxCalls",
] as const;

/** Permission required by the canonical Run worker at the effect boundary. */
export const DATASET_GENERATION_EXECUTION_PERMISSION = "steps:execute";

export type DatasetGenerationLimitName =
  (typeof DATASET_GENERATION_LIMIT_NAMES)[number];

export type DatasetGenerationLimitRequest = Readonly<
  Partial<Record<DatasetGenerationLimitName, number>>
>;

export type DatasetGenerationLimits = Readonly<
  Record<DatasetGenerationLimitName, number>
>;

export type DatasetGenerationUnknownCostPolicy =
  | Readonly<{ mode: "deny" }>
  | Readonly<{ hardCap: number; mode: "explicit-non-interactive" }>;

export type DatasetGenerationRequestIntent = Readonly<{
  actorId: ActorId;
  authorityEnvelopeId: string;
  capability: CapabilityRef;
  fields: readonly Field[];
  limits: DatasetGenerationLimitRequest;
  requestedBudget: Readonly<{ limit: number; unit: string }>;
  requestedDeadline: Instant;
  requestedQuery: DatasetGenerationQueryValue;
  targetDataset: Dataset;
  unknownCostPolicy: DatasetGenerationUnknownCostPolicy;
  workspaceId: WorkspaceId;
}>;

export type DatasetGenerationRouteSnapshot = Readonly<{
  capability: CapabilityRef;
  effectAdapterKey: string;
  factsHash: ContentHash;
  pricingVersion: string;
  providerIdentityNamespace?: string;
  reservableUpperBound: number;
  reservationUnit: string;
  routeKey: string;
}>;

export type DatasetGenerationPolicySnapshot = Readonly<{
  factsHash: ContentHash;
  requiredPermission: string;
  version: string;
}>;

export type DatasetGenerationPlan = Readonly<{
  authority: AuthorityEnvelope;
  budget: BudgetLimit;
  deadline: Instant;
  generationPlanId: DatasetGenerationPlanId;
  hardExecutionCap: number;
  idempotencyKey: IdempotencyKey;
  limits: DatasetGenerationLimits;
  normalizedQuery: DatasetGenerationQueryValue;
  normalizerVersion: string;
  planHash: ContentHash;
  policy: DatasetGenerationPolicySnapshot;
  queryContract: ContractRef;
  queryHash: ContentHash;
  quote: CostQuote;
  requestIntent: DatasetGenerationRequestIntent;
  requestIntentHash: ContentHash;
  routeSnapshots: readonly DatasetGenerationRouteSnapshot[];
  schemaHash: ContentHash;
  workspaceId: WorkspaceId;
}>;

export type DatasetGenerationPlanDraft = Omit<
  DatasetGenerationPlan,
  "planHash"
>;

/** Selects the persisted plan cap that bounds accepted dataset records. */
export const datasetGenerationAcceptedRecordLimit = (
  plan: Pick<DatasetGenerationPlan, "limits" | "requestIntent">
): number => {
  switch (plan.requestIntent.capability.capabilityId) {
    case "organizations.discover":
      return plan.limits.maxCompanies;
    case "contacts.discover":
      return plan.limits.maxContactsTotal;
    default:
      return plan.limits.maxResults;
  }
};

export type DatasetMaterializationState =
  | "building"
  | "ready"
  | "failed"
  | "cancelled"
  | "ambiguous";

export type DatasetMaterializationCoverage = Readonly<{
  basis: "imported_source" | "locked_provider_route";
  status: "complete_for_declared_source" | "bounded" | "unknown";
}>;

export type DatasetMaterializationOrigin =
  | Readonly<{ importId: string; kind: "import" }>
  | Readonly<{ generationId: DatasetGenerationId; kind: "generation" }>;

export type DatasetMaterialization = Readonly<{
  completedAt?: Instant;
  completionReason?: string;
  contentHash?: ContentHash;
  coverage?: DatasetMaterializationCoverage;
  createdAt: Instant;
  datasetId: Dataset["datasetId"];
  materializationId: DatasetMaterializationId;
  origin: DatasetMaterializationOrigin;
  recordCount: number;
  rejectedCount: number;
  revision: number;
  schemaHash: ContentHash;
  state: DatasetMaterializationState;
  workspaceId: WorkspaceId;
}>;

export type DatasetGenerationState =
  | "planned"
  | "running"
  | "stopping"
  | "completed"
  | "failed"
  | "cancelled"
  | "ambiguous";

export type DatasetGenerationCounters = Readonly<{
  accepted: number;
  calls: number;
  duplicates: number;
  pages: number;
  rejected: number;
  returned: number;
}>;

export type DatasetGenerationCost = Readonly<{
  reserved: number;
  spent: number;
  unit: string;
}>;

export type DatasetGenerationStop = Readonly<{
  reason: "requested";
  requestedAt: Instant;
}>;

export type DatasetGeneration = Readonly<{
  aggregateVersion: number;
  capability: CapabilityRef;
  cost: DatasetGenerationCost;
  counters: DatasetGenerationCounters;
  createdAt: Instant;
  datasetId: Dataset["datasetId"];
  generationId: DatasetGenerationId;
  generationPlanId: DatasetGenerationPlanId;
  lastPageSequence?: number;
  lockedProvider?: string;
  materializationId: DatasetMaterializationId;
  planHash: ContentHash;
  queryHash: ContentHash;
  requestIntentHash: ContentHash;
  schemaHash: ContentHash;
  state: DatasetGenerationState;
  stop?: DatasetGenerationStop;
  workspaceId: WorkspaceId;
}>;

export type DatasetGenerationPageState =
  | "run_created"
  | "executing"
  | "committed"
  | "failed"
  | "ambiguous";

export type DatasetGenerationPageArtifact = Readonly<{
  hasMore: boolean;
  items: readonly Readonly<{
    contentHash: ContentHash;
    providerIdentity?: ContactProviderIdentity;
    record: DatasetRecord;
    source?: Readonly<{
      datasetId: Dataset["datasetId"];
      recordId: DatasetRecord["recordId"];
    }>;
  }>[];
  nextCursor: null | string;
  sourcePartitionCompleted: boolean;
  version: "1.0.0";
}>;

export type DatasetGenerationPage = Readonly<{
  acceptedCount?: number;
  aggregateVersion: number;
  artifactContentHash?: ContentHash;
  artifactId?: ArtifactId;
  attemptId?: AttemptId;
  committedAt?: Instant;
  checkpointHash?: ContentHash;
  costAmount?: number;
  costUnit?: string;
  createdAt: Instant;
  generationId: DatasetGenerationId;
  hasMore?: boolean;
  inputContentHash: ContentHash;
  inputCursor: null | string;
  inputId: string;
  nextCursor?: null | string;
  operationKey?: OperationKey;
  pageSequence: number;
  providerKey?: string;
  duplicateCount?: number;
  rejectedCount?: number;
  reservationId?: CostReservationId;
  reservedAmount?: number;
  resultManifestId?: ResultManifestId;
  resultManifestHash?: ContentHash;
  routeKey?: string;
  routeSnapshotHash?: ContentHash;
  returnedCount?: number;
  routingDecisionId?: RoutingDecisionId;
  runId: RunId;
  runPlanId: RunPlanId;
  sourcePartitionCompleted?: boolean;
  state: DatasetGenerationPageState;
  stepRunId?: StepRunId;
  usageEntryId?: UsageEntryId;
  workspaceId: WorkspaceId;
}>;

export type DatasetGenerationPageFailure = Readonly<{
  code: "evidence-invalid" | "identity-invalid" | "state-invalid";
  message: string;
}>;

export type StartDatasetGenerationPageInput = Readonly<{
  attemptId: AttemptId;
  costUnit: string;
  operationKey: OperationKey;
  providerKey: string;
  reservationId: CostReservationId;
  reservedAmount: number;
  routeKey: string;
  routeSnapshotHash: ContentHash;
  routingDecisionId: RoutingDecisionId;
  stepRunId: StepRunId;
}>;

export type CommitDatasetGenerationPageInput = Readonly<{
  acceptedCount: number;
  artifactContentHash: ContentHash;
  artifactId: ArtifactId;
  checkpointHash: ContentHash;
  committedAt: Instant;
  costAmount: number;
  duplicateCount: number;
  hasMore: boolean;
  nextCursor: null | string;
  rejectedCount: number;
  resultManifestHash: ContentHash;
  resultManifestId: ResultManifestId;
  returnedCount: number;
  sourcePartitionCompleted: boolean;
  usageEntryId: UsageEntryId;
}>;

export type DatasetGenerationCreation = Readonly<{
  generation: DatasetGeneration;
  materialization: DatasetMaterialization;
}>;

export type DatasetMaterializationFailure = Readonly<{
  code:
    | "coverage-invalid"
    | "identity-invalid"
    | "progress-invalid"
    | "scope-mismatch"
    | "state-invalid"
    | "terminal-proof-invalid";
  message: string;
}>;

export type DatasetGenerationCreationFailure = Readonly<{
  code:
    | "binding-mismatch"
    | "generation-invalid"
    | "materialization-invalid"
    | "plan-invalid";
  message: string;
}>;

export type CreateDatasetGenerationInput = Readonly<{
  createdAt: Instant;
  generationId: DatasetGenerationId;
  plan: DatasetGenerationPlan;
}>;

export type DatasetGenerationPlanFailureCode =
  | "authority-invalid"
  | "budget-invalid"
  | "identity-invalid"
  | "query-invalid"
  | "route-invalid"
  | "schema-invalid"
  | "scope-mismatch"
  | "snapshot-invalid";

export type DatasetGenerationPlanFailure = Readonly<{
  code: DatasetGenerationPlanFailureCode;
  message: string;
}>;

export type DatasetGenerationRequestIntentFailure = Readonly<{
  code:
    | "request-invalid"
    | "query-invalid"
    | "schema-invalid"
    | "scope-mismatch";
  message: string;
}>;

const reject = (
  code: DatasetGenerationPlanFailureCode,
  message: string
): DomainResult<never, DatasetGenerationPlanFailure> => fail({ code, message });

const capabilityMatches = (
  left: CapabilityRef,
  right: CapabilityRef
): boolean =>
  left.capabilityId === right.capabilityId &&
  left.capabilityVersion === right.capabilityVersion;

const boundedText = (value: string, maximum = 255): boolean =>
  value.trim().length > 0 && [...value].length <= maximum;

const boundedIdentity = (value: string, maximum = 255): boolean =>
  value.trim() === value && boundedText(value, maximum);

const contentHashIsValid = (value: string): boolean =>
  CONTENT_HASH_PATTERN.test(value);

const instantIsValid = (value: number): boolean =>
  Number.isSafeInteger(value) && value >= 0;

const nonNegativeSafeInteger = (value: number): boolean =>
  Number.isSafeInteger(value) && value >= 0;

const DATASET_GENERATION_QUERY_MAX_BYTES = 1_048_576;
const DATASET_GENERATION_QUERY_MAX_DEPTH = 32;
const DATASET_GENERATION_QUERY_MAX_NODES = 10_000;
const DATASET_GENERATION_QUERY_MAX_ENTRIES = 1024;
const DATASET_GENERATION_QUERY_MAX_KEY_CODE_POINTS = 255;
const DATASET_GENERATION_QUERY_MAX_STRING_CODE_POINTS = 16_384;
const UTF8_ENCODER = new TextEncoder();
const UNSAFE_DATASET_GENERATION_QUERY_KEYS = new Set([
  "__proto__",
  "constructor",
  "prototype",
]);

interface QuerySnapshotState {
  bytes: number;
  nodes: number;
  readonly parents: Set<object>;
}

const reserveQueryBytes = (
  state: QuerySnapshotState,
  bytes: number
): boolean => {
  if (bytes > DATASET_GENERATION_QUERY_MAX_BYTES - state.bytes) {
    return false;
  }
  state.bytes += bytes;
  return true;
};

const reserveSerializedQueryText = (
  state: QuerySnapshotState,
  value: string
): boolean => reserveQueryBytes(state, UTF8_ENCODER.encode(value).byteLength);

const queryNodeIsAvailable = (
  depth: number,
  state: QuerySnapshotState
): boolean => {
  state.nodes += 1;
  return (
    depth <= DATASET_GENERATION_QUERY_MAX_DEPTH &&
    state.nodes <= DATASET_GENERATION_QUERY_MAX_NODES
  );
};

const snapshotQueryArray = (
  value: readonly unknown[],
  depth: number,
  state: QuerySnapshotState
): readonly DatasetGenerationQueryValue[] | undefined => {
  if (
    Object.getPrototypeOf(value) !== Array.prototype ||
    Object.getOwnPropertySymbols(value).length > 0 ||
    value.length > DATASET_GENERATION_QUERY_MAX_ENTRIES ||
    Object.getOwnPropertyNames(value).length !== value.length + 1 ||
    !reserveQueryBytes(state, 2 + Math.max(0, value.length - 1)) ||
    state.parents.has(value)
  ) {
    return;
  }
  state.parents.add(value);
  try {
    const snapshot: DatasetGenerationQueryValue[] = [];
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (
        descriptor === undefined ||
        !("value" in descriptor) ||
        !descriptor.enumerable
      ) {
        return;
      }
      const entry = snapshotQueryValue(descriptor.value, depth + 1, state);
      if (entry === undefined) {
        return;
      }
      snapshot.push(entry);
    }
    return snapshot;
  } finally {
    state.parents.delete(value);
  }
};

const queryObjectIsSupported = (
  value: object,
  state: QuerySnapshotState
): boolean => {
  const prototype = Object.getPrototypeOf(value);
  return (
    (prototype === Object.prototype || prototype === null) &&
    Object.getOwnPropertySymbols(value).length === 0 &&
    !state.parents.has(value)
  );
};

const snapshotQueryObject = (
  value: object,
  depth: number,
  state: QuerySnapshotState
): Readonly<{ [key: string]: DatasetGenerationQueryValue }> | undefined => {
  if (!queryObjectIsSupported(value, state)) {
    return;
  }
  const propertyNames = Object.getOwnPropertyNames(value);
  if (
    propertyNames.length > DATASET_GENERATION_QUERY_MAX_ENTRIES ||
    !reserveQueryBytes(state, 2 + Math.max(0, propertyNames.length - 1))
  ) {
    return;
  }
  state.parents.add(value);
  try {
    const snapshot: Record<string, DatasetGenerationQueryValue> =
      Object.create(null);
    for (const key of propertyNames) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (
        key.length === 0 ||
        UNSAFE_DATASET_GENERATION_QUERY_KEYS.has(key) ||
        [...key].length > DATASET_GENERATION_QUERY_MAX_KEY_CODE_POINTS ||
        descriptor === undefined ||
        !("value" in descriptor) ||
        !descriptor.enumerable ||
        !reserveSerializedQueryText(state, JSON.stringify(key)) ||
        !reserveQueryBytes(state, 1)
      ) {
        return;
      }
      const entry = snapshotQueryValue(descriptor.value, depth + 1, state);
      if (entry === undefined) {
        return;
      }
      snapshot[key] = entry;
    }
    return snapshot;
  } finally {
    state.parents.delete(value);
  }
};

const snapshotQueryValue = (
  value: unknown,
  depth: number,
  state: QuerySnapshotState
): DatasetGenerationQueryValue | undefined => {
  if (!queryNodeIsAvailable(depth, state)) {
    return;
  }
  if (value === null || typeof value === "boolean") {
    const bytes = value === null || value ? 4 : 5;
    return reserveQueryBytes(state, bytes) ? value : undefined;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) &&
      reserveSerializedQueryText(state, JSON.stringify(value))
      ? value
      : undefined;
  }
  if (typeof value === "string") {
    return [...value].length <=
      DATASET_GENERATION_QUERY_MAX_STRING_CODE_POINTS &&
      reserveSerializedQueryText(state, JSON.stringify(value))
      ? value
      : undefined;
  }
  if (Array.isArray(value)) {
    return snapshotQueryArray(value, depth, state);
  }
  if (typeof value !== "object" || value === null) {
    return;
  }
  return snapshotQueryObject(value, depth, state);
};

export const snapshotDatasetGenerationQuery = (
  value: unknown
): DatasetGenerationQuerySnapshotResult => {
  try {
    const snapshot = snapshotQueryValue(value, 0, {
      bytes: 0,
      nodes: 0,
      parents: new Set(),
    });
    return snapshot === undefined
      ? fail({
          code: "query-invalid",
          message: "The generation query must be bounded inert JSON.",
        })
      : succeed(snapshot);
  } catch {
    return fail({
      code: "query-invalid",
      message: "The generation query must be bounded inert JSON.",
    });
  }
};

const queryIsBounded = (value: unknown): value is DatasetGenerationQueryValue =>
  snapshotDatasetGenerationQuery(value).ok;

const limitsAreValid = (limits: DatasetGenerationLimits): boolean =>
  DATASET_GENERATION_LIMIT_NAMES.every((name) => {
    const value = limits[name];
    return Number.isSafeInteger(value) && value >= 0;
  });

const budgetIsValid = (budget: BudgetLimit): boolean => {
  const committed = budget.reserved + budget.spent;
  return (
    isAmount(budget.limit) &&
    isAmount(budget.reserved) &&
    isAmount(budget.spent) &&
    isAmount(committed) &&
    budget.unit.trim().length > 0 &&
    (committed <= budget.limit || amountsEqual(committed, budget.limit))
  );
};

const availableBudget = (budget: BudgetLimit): number =>
  budget.limit - budget.reserved - budget.spent;

const amountExceeds = (value: number, limit: number): boolean =>
  value > limit && !amountsEqual(value, limit);

const limitsDoNotExceedRequest = (
  limits: DatasetGenerationLimits,
  requested: DatasetGenerationLimitRequest
): boolean =>
  DATASET_GENERATION_LIMIT_NAMES.every((name) => {
    const requestedValue = requested[name];
    return requestedValue !== undefined && limits[name] <= requestedValue;
  });

const quoteIsValid = (quote: CostQuote): boolean =>
  boundedText(quote.quoteId) &&
  boundedText(quote.pricingVersion) &&
  boundedText(quote.unit, 64) &&
  (quote.guarantee === "hard" ||
    quote.guarantee === "estimated" ||
    quote.guarantee === "unknown") &&
  Number.isSafeInteger(quote.expiresAt) &&
  quote.expiresAt >= 0 &&
  (quote.upperBound === undefined || isAmount(quote.upperBound)) &&
  (quote.guarantee === "unknown" || quote.upperBound !== undefined);

const limitRequestIsValid = (
  limits: DatasetGenerationLimitRequest
): boolean => {
  const knownNames = new Set<string>(DATASET_GENERATION_LIMIT_NAMES);
  return Object.entries(limits).every(
    ([name, value]) =>
      knownNames.has(name) &&
      Number.isSafeInteger(value) &&
      (value as number) >= 0
  );
};

const routeSnapshotsAreValid = (
  input: DatasetGenerationPlan,
  intent: DatasetGenerationRequestIntent
): boolean => {
  if (input.routeSnapshots.length === 0 || input.routeSnapshots.length > 64) {
    return false;
  }
  const routeKeys = new Set<string>();
  return input.routeSnapshots.every((route) => {
    const duplicateRouteKey = routeKeys.has(route.routeKey);
    routeKeys.add(route.routeKey);
    return (
      capabilityMatches(route.capability, intent.capability) &&
      boundedText(route.routeKey) &&
      boundedText(route.effectAdapterKey) &&
      (route.providerIdentityNamespace === undefined ||
        boundedText(route.providerIdentityNamespace, 128)) &&
      boundedText(route.pricingVersion) &&
      boundedText(route.reservationUnit) &&
      route.pricingVersion === input.quote.pricingVersion &&
      route.reservationUnit === input.budget.unit &&
      route.factsHash === input.policy.factsHash &&
      isAmount(route.reservableUpperBound) &&
      !amountExceeds(route.reservableUpperBound, input.hardExecutionCap) &&
      !amountExceeds(
        route.reservableUpperBound,
        availableBudget(input.budget)
      ) &&
      !duplicateRouteKey
    );
  });
};

export const validateDatasetGenerationRequestIntent = (
  intent: DatasetGenerationRequestIntent
): DomainResult<
  DatasetGenerationRequestIntent,
  DatasetGenerationRequestIntentFailure
> => {
  if (
    intent.workspaceId !== intent.targetDataset.workspaceId ||
    !boundedIdentity(intent.authorityEnvelopeId)
  ) {
    return fail({
      code: "scope-mismatch",
      message:
        "The generation request and target dataset must share one workspace.",
    });
  }
  if (
    !(
      createDataset(intent.targetDataset).ok &&
      validateDatasetFields(intent.targetDataset, intent.fields).ok
    )
  ) {
    return fail({
      code: "schema-invalid",
      message: "The target dataset schema is invalid.",
    });
  }
  if (!queryIsBounded(intent.requestedQuery)) {
    return fail({
      code: "query-invalid",
      message: "The requested query must be bounded JSON.",
    });
  }
  if (
    !(
      boundedText(intent.capability.capabilityId) &&
      boundedText(intent.capability.capabilityVersion) &&
      isAmount(intent.requestedBudget.limit) &&
      boundedText(intent.requestedBudget.unit, 64) &&
      Number.isSafeInteger(intent.requestedDeadline)
    ) ||
    intent.requestedDeadline < 0 ||
    !limitRequestIsValid(intent.limits) ||
    !(
      intent.unknownCostPolicy.mode === "deny" ||
      (intent.unknownCostPolicy.mode === "explicit-non-interactive" &&
        isAmount(intent.unknownCostPolicy.hardCap))
    )
  ) {
    return fail({
      code: "request-invalid",
      message: "The generation request contains an invalid bounded value.",
    });
  }
  return succeed(intent);
};

export const createDatasetGenerationPlan = (
  input: DatasetGenerationPlan
): DomainResult<DatasetGenerationPlan, DatasetGenerationPlanFailure> => {
  if (
    !(
      boundedIdentity(input.generationPlanId) &&
      boundedIdentity(input.idempotencyKey, 512)
    )
  ) {
    return reject(
      "identity-invalid",
      "Generation plan identities are invalid."
    );
  }
  const intent = input.requestIntent;
  const intentValidation = validateDatasetGenerationRequestIntent(intent);
  if (!intentValidation.ok) {
    const codeByIntentFailure = {
      "query-invalid": "query-invalid",
      "request-invalid": "snapshot-invalid",
      "schema-invalid": "schema-invalid",
      "scope-mismatch": "scope-mismatch",
    } as const;
    return reject(
      codeByIntentFailure[intentValidation.error.code],
      intentValidation.error.message
    );
  }
  if (
    input.workspaceId !== intent.workspaceId ||
    input.workspaceId !== intent.targetDataset.workspaceId ||
    input.workspaceId !== input.authority.workspaceId
  ) {
    return reject(
      "scope-mismatch",
      "The plan, request, dataset, and authority must share one workspace."
    );
  }
  const dataset = createDataset(intent.targetDataset);
  if (
    !(
      dataset.ok &&
      validateDatasetFields(intent.targetDataset, intent.fields).ok
    )
  ) {
    return reject("schema-invalid", "The target dataset schema is invalid.");
  }
  if (
    !(
      queryIsBounded(intent.requestedQuery) &&
      queryIsBounded(input.normalizedQuery)
    )
  ) {
    return reject("query-invalid", "Generation queries must be bounded JSON.");
  }
  if (
    !(
      boundedText(input.normalizerVersion) &&
      boundedText(input.policy.version) &&
      boundedText(input.policy.requiredPermission)
    )
  ) {
    return reject("snapshot-invalid", "Planning snapshots are incomplete.");
  }
  if (
    input.authority.subjectActorId !== intent.actorId ||
    input.authority.authorityEnvelopeId !== intent.authorityEnvelopeId ||
    !isSupportedAuthorityEnvelopeVersion(input.authority.version) ||
    !input.authority.permissions.includes(input.policy.requiredPermission) ||
    !input.authority.permissions.includes(
      DATASET_GENERATION_EXECUTION_PERMISSION
    ) ||
    !input.authority.capabilities.some((candidate) =>
      capabilityMatches(candidate, intent.capability)
    )
  ) {
    return reject(
      "authority-invalid",
      "The authority snapshot does not cover the request intention."
    );
  }
  if (
    !(
      limitsAreValid(input.limits) &&
      limitsDoNotExceedRequest(input.limits, intent.limits) &&
      isAmount(input.hardExecutionCap) &&
      budgetIsValid(input.budget) &&
      budgetIsValid(input.authority.budgetLimit) &&
      quoteIsValid(input.quote) &&
      Number.isSafeInteger(input.deadline) &&
      input.deadline >= 0 &&
      Number.isSafeInteger(input.authority.deadline) &&
      input.authority.deadline >= 0
    ) ||
    amountExceeds(input.hardExecutionCap, availableBudget(input.budget)) ||
    input.budget.unit !== input.quote.unit ||
    input.budget.unit !== intent.requestedBudget.unit ||
    input.budget.unit !== input.authority.budgetLimit.unit ||
    amountExceeds(
      availableBudget(input.budget),
      intent.requestedBudget.limit
    ) ||
    amountExceeds(
      availableBudget(input.budget),
      availableBudget(input.authority.budgetLimit)
    ) ||
    input.deadline > intent.requestedDeadline ||
    input.deadline > input.authority.deadline ||
    (input.quote.guarantee === "hard" &&
      input.quote.upperBound !== undefined &&
      amountExceeds(input.hardExecutionCap, input.quote.upperBound)) ||
    (input.quote.guarantee === "unknown" &&
      !(
        intent.unknownCostPolicy.mode === "explicit-non-interactive" &&
        !amountExceeds(input.hardExecutionCap, intent.unknownCostPolicy.hardCap)
      ))
  ) {
    return reject("budget-invalid", "The budget snapshot is invalid.");
  }
  if (!routeSnapshotsAreValid(input, intent)) {
    return reject("route-invalid", "The route snapshot is invalid.");
  }
  return succeed(input);
};

const materializationFailure = (
  code: DatasetMaterializationFailure["code"],
  message: string
): DomainResult<never, DatasetMaterializationFailure> =>
  fail({ code, message });

const coverageIsValid = (materialization: DatasetMaterialization): boolean => {
  const coverage = materialization.coverage;
  if (coverage === undefined || coverage.status === "unknown") {
    return false;
  }
  if (materialization.origin.kind === "import") {
    return (
      coverage.basis === "imported_source" &&
      coverage.status === "complete_for_declared_source"
    );
  }
  return (
    coverage.basis === "locked_provider_route" &&
    (coverage.status === "complete_for_declared_source" ||
      coverage.status === "bounded")
  );
};

const materializationIdentityIsValid = (
  input: DatasetMaterialization
): boolean =>
  boundedText(input.materializationId) &&
  boundedText(input.datasetId) &&
  boundedText(input.workspaceId) &&
  input.materializationId ===
    datasetMaterializationId(String(input.datasetId)) &&
  contentHashIsValid(input.schemaHash);

const materializationOriginIsValid = (
  origin: DatasetMaterializationOrigin
): boolean =>
  (origin.kind === "import" && boundedText(origin.importId)) ||
  (origin.kind === "generation" && boundedIdentity(origin.generationId));

const materializationProgressIsValid = (
  input: DatasetMaterialization
): boolean =>
  instantIsValid(input.createdAt) &&
  nonNegativeSafeInteger(input.recordCount) &&
  nonNegativeSafeInteger(input.rejectedCount) &&
  Number.isSafeInteger(input.recordCount + input.rejectedCount) &&
  Number.isSafeInteger(input.revision) &&
  input.revision >= 1;

const materializationStateIsValid = (
  state: DatasetMaterializationState
): boolean =>
  state === "building" ||
  state === "ready" ||
  state === "failed" ||
  state === "cancelled" ||
  state === "ambiguous";

const terminalProofIsAbsent = (input: DatasetMaterialization): boolean =>
  input.completedAt === undefined &&
  input.completionReason === undefined &&
  input.contentHash === undefined &&
  input.coverage === undefined;

export const createDatasetMaterialization = (
  input: DatasetMaterialization
): DomainResult<DatasetMaterialization, DatasetMaterializationFailure> => {
  if (!materializationIdentityIsValid(input)) {
    return materializationFailure(
      "identity-invalid",
      "A materialization requires bounded deterministic identities and a schema hash."
    );
  }
  if (!materializationOriginIsValid(input.origin)) {
    return materializationFailure(
      "scope-mismatch",
      "A materialization requires exactly one bounded origin identity."
    );
  }
  if (!materializationProgressIsValid(input)) {
    return materializationFailure(
      "progress-invalid",
      "Materialization progress must use monotone safe integers."
    );
  }
  if (!materializationStateIsValid(input.state)) {
    return materializationFailure(
      "state-invalid",
      "The materialization readiness state is invalid."
    );
  }

  const completionReasonIsValid =
    input.completionReason !== undefined &&
    boundedText(input.completionReason, 128);
  const completedAtIsValid =
    input.completedAt !== undefined &&
    instantIsValid(input.completedAt) &&
    input.completedAt >= input.createdAt;
  if (input.state === "ready") {
    if (
      !(
        completedAtIsValid &&
        completionReasonIsValid &&
        input.contentHash !== undefined &&
        contentHashIsValid(input.contentHash) &&
        coverageIsValid(input)
      )
    ) {
      return materializationFailure(
        "terminal-proof-invalid",
        "A ready materialization requires exact completion, content, and coverage proofs."
      );
    }
    return succeed(input);
  }
  if (input.state === "failed" || input.state === "cancelled") {
    if (
      !(
        completedAtIsValid &&
        completionReasonIsValid &&
        input.contentHash === undefined &&
        input.coverage === undefined
      )
    ) {
      return materializationFailure(
        "terminal-proof-invalid",
        "A failed or cancelled materialization requires a terminal reason without consumable content proof."
      );
    }
    return succeed(input);
  }
  if (!terminalProofIsAbsent(input)) {
    return materializationFailure(
      "terminal-proof-invalid",
      "A non-terminal materialization cannot carry terminal content or coverage proofs."
    );
  }
  return succeed(input);
};

const generationCreationFailure = (
  code: DatasetGenerationCreationFailure["code"],
  message: string
): DomainResult<never, DatasetGenerationCreationFailure> =>
  fail({ code, message });

const countersAreZero = (counters: DatasetGenerationCounters): boolean =>
  counters.accepted === 0 &&
  counters.calls === 0 &&
  counters.duplicates === 0 &&
  counters.pages === 0 &&
  counters.rejected === 0 &&
  counters.returned === 0;

const pageFailure = (
  code: DatasetGenerationPageFailure["code"],
  message: string
): DomainResult<never, DatasetGenerationPageFailure> => fail({ code, message });

const pageEffectEvidenceIsAbsent = (page: DatasetGenerationPage): boolean =>
  page.attemptId === undefined &&
  page.costUnit === undefined &&
  page.operationKey === undefined &&
  page.providerKey === undefined &&
  page.reservationId === undefined &&
  page.reservedAmount === undefined &&
  page.routeKey === undefined &&
  page.routeSnapshotHash === undefined &&
  page.routingDecisionId === undefined &&
  page.stepRunId === undefined;

const pageEffectEvidenceIsPresent = (page: DatasetGenerationPage): boolean =>
  page.attemptId !== undefined &&
  boundedText(page.attemptId) &&
  page.costUnit !== undefined &&
  boundedText(page.costUnit, 64) &&
  page.operationKey !== undefined &&
  boundedText(page.operationKey, 512) &&
  page.providerKey !== undefined &&
  boundedText(page.providerKey) &&
  page.reservationId !== undefined &&
  boundedText(page.reservationId, 512) &&
  page.reservedAmount !== undefined &&
  isAmount(page.reservedAmount) &&
  page.routeKey !== undefined &&
  boundedText(page.routeKey) &&
  page.routeSnapshotHash !== undefined &&
  contentHashIsValid(page.routeSnapshotHash) &&
  page.routingDecisionId !== undefined &&
  boundedText(page.routingDecisionId, 512) &&
  page.stepRunId !== undefined &&
  boundedText(page.stepRunId, 512);

const pageResultEvidenceIsAbsent = (page: DatasetGenerationPage): boolean =>
  page.acceptedCount === undefined &&
  page.artifactContentHash === undefined &&
  page.artifactId === undefined &&
  page.checkpointHash === undefined &&
  page.committedAt === undefined &&
  page.costAmount === undefined &&
  page.duplicateCount === undefined &&
  page.hasMore === undefined &&
  page.nextCursor === undefined &&
  page.rejectedCount === undefined &&
  page.resultManifestHash === undefined &&
  page.resultManifestId === undefined &&
  page.returnedCount === undefined &&
  page.sourcePartitionCompleted === undefined &&
  page.usageEntryId === undefined;

const pageResultEvidenceIsPresent = (page: DatasetGenerationPage): boolean => {
  if (
    page.acceptedCount === undefined ||
    page.artifactContentHash === undefined ||
    page.artifactId === undefined ||
    page.checkpointHash === undefined ||
    page.committedAt === undefined ||
    page.costAmount === undefined ||
    page.duplicateCount === undefined ||
    page.hasMore === undefined ||
    page.nextCursor === undefined ||
    page.rejectedCount === undefined ||
    page.resultManifestHash === undefined ||
    page.resultManifestId === undefined ||
    page.returnedCount === undefined ||
    page.sourcePartitionCompleted === undefined ||
    page.usageEntryId === undefined ||
    page.reservedAmount === undefined
  ) {
    return false;
  }
  const countsAreValid = [
    page.acceptedCount,
    page.duplicateCount,
    page.rejectedCount,
    page.returnedCount,
  ].every(nonNegativeSafeInteger);
  const cursorIsCoherent = page.hasMore
    ? typeof page.nextCursor === "string" &&
      boundedText(page.nextCursor) &&
      !page.sourcePartitionCompleted
    : page.nextCursor === null && page.sourcePartitionCompleted;
  return (
    countsAreValid &&
    page.returnedCount ===
      page.acceptedCount + page.duplicateCount + page.rejectedCount &&
    cursorIsCoherent &&
    contentHashIsValid(page.artifactContentHash) &&
    boundedText(page.artifactId, 512) &&
    contentHashIsValid(page.checkpointHash) &&
    instantIsValid(page.committedAt) &&
    page.committedAt >= page.createdAt &&
    isAmount(page.costAmount) &&
    !amountExceeds(page.costAmount, page.reservedAmount) &&
    contentHashIsValid(page.resultManifestHash) &&
    boundedText(page.resultManifestId, 512) &&
    boundedText(page.usageEntryId, 512)
  );
};

/** Validates the exact durable state of the internal first-page aggregate. */
export const validateDatasetGenerationPageSnapshot = (
  page: DatasetGenerationPage
): DomainResult<DatasetGenerationPage, DatasetGenerationPageFailure> => {
  if (
    !Number.isSafeInteger(page.pageSequence) ||
    page.pageSequence < 1 ||
    (page.pageSequence === 1
      ? page.inputCursor !== null
      : !(
          typeof page.inputCursor === "string" &&
          boundedText(page.inputCursor, 4096)
        )) ||
    !boundedIdentity(page.workspaceId) ||
    !boundedIdentity(page.generationId) ||
    !boundedText(page.runPlanId, 512) ||
    !boundedText(page.runId, 512) ||
    !boundedText(page.inputId, 512) ||
    !contentHashIsValid(page.inputContentHash) ||
    !instantIsValid(page.createdAt) ||
    !Number.isSafeInteger(page.aggregateVersion) ||
    page.aggregateVersion < 1
  ) {
    return pageFailure(
      "identity-invalid",
      "A generation page requires exact bounded Run and input identities."
    );
  }
  if (page.state === "run_created") {
    return page.aggregateVersion === 1 &&
      pageEffectEvidenceIsAbsent(page) &&
      pageResultEvidenceIsAbsent(page)
      ? succeed(page)
      : pageFailure(
          "state-invalid",
          "A newly created page cannot carry effect or result evidence."
        );
  }
  if (
    page.state === "executing" ||
    page.state === "failed" ||
    page.state === "ambiguous"
  ) {
    return page.aggregateVersion >= 2 &&
      pageEffectEvidenceIsPresent(page) &&
      pageResultEvidenceIsAbsent(page)
      ? succeed(page)
      : pageFailure(
          "evidence-invalid",
          "An active or ambiguous page requires exact effect evidence without a checkpoint."
        );
  }
  return page.aggregateVersion >= 3 &&
    pageEffectEvidenceIsPresent(page) &&
    pageResultEvidenceIsPresent(page)
    ? succeed(page)
    : pageFailure(
        "evidence-invalid",
        "A committed page requires exact effect and checkpoint evidence."
      );
};

export const startDatasetGenerationPage = (
  page: DatasetGenerationPage,
  input: StartDatasetGenerationPageInput
): DomainResult<DatasetGenerationPage, DatasetGenerationPageFailure> => {
  const valid = validateDatasetGenerationPageSnapshot(page);
  if (!valid.ok) {
    return valid;
  }
  if (page.state !== "run_created") {
    return pageFailure(
      "state-invalid",
      "Only a newly created generation page can cross the effect threshold."
    );
  }
  return validateDatasetGenerationPageSnapshot({
    ...page,
    aggregateVersion: page.aggregateVersion + 1,
    ...input,
    state: "executing",
  });
};

export const markDatasetGenerationPageAmbiguous = (
  page: DatasetGenerationPage
): DomainResult<DatasetGenerationPage, DatasetGenerationPageFailure> => {
  const valid = validateDatasetGenerationPageSnapshot(page);
  if (!valid.ok) {
    return valid;
  }
  return page.state === "executing"
    ? validateDatasetGenerationPageSnapshot({
        ...page,
        aggregateVersion: page.aggregateVersion + 1,
        state: "ambiguous",
      })
    : pageFailure(
        "state-invalid",
        "Only an executing generation page can become ambiguous."
      );
};

export const markDatasetGenerationPageFailed = (
  page: DatasetGenerationPage
): DomainResult<DatasetGenerationPage, DatasetGenerationPageFailure> => {
  const valid = validateDatasetGenerationPageSnapshot(page);
  if (!valid.ok) {
    return valid;
  }
  return page.state === "executing"
    ? validateDatasetGenerationPageSnapshot({
        ...page,
        aggregateVersion: page.aggregateVersion + 1,
        state: "failed",
      })
    : pageFailure(
        "state-invalid",
        "Only an executing generation page can fail certainly."
      );
};

export const commitDatasetGenerationPage = (
  page: DatasetGenerationPage,
  input: CommitDatasetGenerationPageInput
): DomainResult<DatasetGenerationPage, DatasetGenerationPageFailure> => {
  const valid = validateDatasetGenerationPageSnapshot(page);
  if (!valid.ok) {
    return valid;
  }
  return page.state === "executing"
    ? validateDatasetGenerationPageSnapshot({
        ...page,
        aggregateVersion: page.aggregateVersion + 1,
        ...input,
        state: "committed",
      })
    : pageFailure(
        "state-invalid",
        "Only an executing generation page can be checkpointed."
      );
};

export const validateDatasetGenerationCreation = (
  creation: DatasetGenerationCreation,
  plan: DatasetGenerationPlan
): DomainResult<
  DatasetGenerationCreation,
  DatasetGenerationCreationFailure
> => {
  if (!createDatasetGenerationPlan(plan).ok) {
    return generationCreationFailure(
      "plan-invalid",
      "A generation requires an exact valid immutable plan."
    );
  }
  const { generation, materialization } = creation;
  const validMaterialization = createDatasetMaterialization(materialization);
  if (!validMaterialization.ok) {
    return generationCreationFailure(
      "materialization-invalid",
      validMaterialization.error.message
    );
  }
  if (
    !(
      boundedIdentity(generation.generationId) &&
      instantIsValid(generation.createdAt) &&
      generation.aggregateVersion === 1 &&
      generation.state === "planned" &&
      countersAreZero(generation.counters) &&
      generation.cost.reserved === 0 &&
      generation.cost.spent === 0 &&
      boundedText(generation.cost.unit, 64)
    )
  ) {
    return generationCreationFailure(
      "generation-invalid",
      "A newly created generation must be a zero-progress planned aggregate."
    );
  }
  const targetDataset = plan.requestIntent.targetDataset;
  if (
    !(
      generation.workspaceId === plan.workspaceId &&
      generation.workspaceId === targetDataset.workspaceId &&
      generation.datasetId === targetDataset.datasetId &&
      generation.generationPlanId === plan.generationPlanId &&
      generation.planHash === plan.planHash &&
      generation.queryHash === plan.queryHash &&
      generation.schemaHash === plan.schemaHash &&
      generation.requestIntentHash === plan.requestIntentHash &&
      generation.cost.unit === plan.budget.unit &&
      capabilityMatches(generation.capability, plan.requestIntent.capability) &&
      materialization.workspaceId === generation.workspaceId &&
      materialization.datasetId === generation.datasetId &&
      materialization.materializationId === generation.materializationId &&
      materialization.schemaHash === generation.schemaHash &&
      materialization.createdAt === generation.createdAt &&
      materialization.state === "building" &&
      materialization.revision === 1 &&
      materialization.recordCount === 0 &&
      materialization.rejectedCount === 0 &&
      materialization.origin.kind === "generation" &&
      materialization.origin.generationId === generation.generationId
    )
  ) {
    return generationCreationFailure(
      "binding-mismatch",
      "The generation and materialization must preserve every immutable plan binding."
    );
  }
  return succeed(creation);
};

const generationCountersAreValid = (
  counters: DatasetGenerationCounters
): boolean =>
  Object.values(counters).every(nonNegativeSafeInteger) &&
  Number.isSafeInteger(
    counters.accepted +
      counters.duplicates +
      counters.rejected +
      counters.returned +
      counters.pages +
      counters.calls
  );

const generationCountersFitPlan = (
  counters: DatasetGenerationCounters,
  plan: DatasetGenerationPlan
): boolean =>
  counters.pages <= plan.limits.maxPages &&
  counters.calls <= plan.limits.maxCalls &&
  counters.returned <= plan.limits.maxResults &&
  counters.accepted <= datasetGenerationAcceptedRecordLimit(plan);

const materializationStateForGeneration = (
  state: DatasetGenerationState
): DatasetMaterializationState => {
  switch (state) {
    case "completed":
      return "ready";
    case "failed":
      return "failed";
    case "cancelled":
      return "cancelled";
    case "ambiguous":
      return "ambiguous";
    default:
      return "building";
  }
};

const generationBindingMatchesPlan = (
  creation: DatasetGenerationCreation,
  plan: DatasetGenerationPlan
): boolean => {
  const { generation, materialization } = creation;
  const targetDataset = plan.requestIntent.targetDataset;
  return (
    generation.workspaceId === plan.workspaceId &&
    generation.workspaceId === targetDataset.workspaceId &&
    generation.datasetId === targetDataset.datasetId &&
    generation.generationPlanId === plan.generationPlanId &&
    generation.planHash === plan.planHash &&
    generation.queryHash === plan.queryHash &&
    generation.schemaHash === plan.schemaHash &&
    generation.requestIntentHash === plan.requestIntentHash &&
    generation.cost.unit === plan.budget.unit &&
    capabilityMatches(generation.capability, plan.requestIntent.capability) &&
    materialization.workspaceId === generation.workspaceId &&
    materialization.datasetId === generation.datasetId &&
    materialization.materializationId === generation.materializationId &&
    materialization.schemaHash === generation.schemaHash &&
    materialization.createdAt === generation.createdAt &&
    materialization.origin.kind === "generation" &&
    materialization.origin.generationId === generation.generationId
  );
};

const generationStopIsValid = (generation: DatasetGeneration): boolean => {
  if (generation.stop === undefined) {
    return generation.state !== "stopping" && generation.state !== "cancelled";
  }
  return (
    generation.stop.reason === "requested" &&
    instantIsValid(generation.stop.requestedAt) &&
    generation.stop.requestedAt >= generation.createdAt &&
    generation.state !== "planned" &&
    generation.state !== "running" &&
    generation.state !== "completed" &&
    generation.state !== "failed"
  );
};

/** Validates both a new generation and every durable progress snapshot. */
export const validateDatasetGenerationSnapshot = (
  creation: DatasetGenerationCreation,
  plan: DatasetGenerationPlan
): DomainResult<
  DatasetGenerationCreation,
  DatasetGenerationCreationFailure
> => {
  if (!createDatasetGenerationPlan(plan).ok) {
    return generationCreationFailure(
      "plan-invalid",
      "A generation requires an exact valid immutable plan."
    );
  }
  const { generation, materialization } = creation;
  const validMaterialization = createDatasetMaterialization(materialization);
  if (!validMaterialization.ok) {
    return generationCreationFailure(
      "materialization-invalid",
      validMaterialization.error.message
    );
  }
  if (!generationBindingMatchesPlan(creation, plan)) {
    return generationCreationFailure(
      "binding-mismatch",
      "The generation and materialization must preserve every immutable plan binding."
    );
  }
  const pagesAreBound =
    generation.lockedProvider === undefined
      ? generation.lastPageSequence === undefined &&
        generation.counters.pages <= 1
      : (generation.lastPageSequence === generation.counters.pages ||
          ((generation.state === "running" ||
            generation.state === "stopping" ||
            generation.state === "failed" ||
            generation.state === "cancelled") &&
            generation.lastPageSequence === generation.counters.pages - 1)) &&
        generation.counters.pages > 0 &&
        boundedText(generation.lockedProvider);
  const progressIsExact =
    boundedIdentity(generation.generationId) &&
    generation.aggregateVersion >= 1 &&
    instantIsValid(generation.createdAt) &&
    generationCountersAreValid(generation.counters) &&
    generationCountersFitPlan(generation.counters, plan) &&
    generation.counters.accepted === materialization.recordCount &&
    generation.counters.rejected === materialization.rejectedCount &&
    generation.counters.returned ===
      generation.counters.accepted +
        generation.counters.duplicates +
        generation.counters.rejected &&
    generation.counters.calls >= generation.counters.pages &&
    isAmount(generation.cost.reserved) &&
    isAmount(generation.cost.spent) &&
    isAmount(generation.cost.reserved + generation.cost.spent) &&
    !amountExceeds(
      generation.cost.reserved + generation.cost.spent,
      plan.budget.limit
    ) &&
    generationStopIsValid(generation) &&
    pagesAreBound &&
    materialization.state ===
      materializationStateForGeneration(generation.state);
  if (!progressIsExact) {
    return generationCreationFailure(
      "generation-invalid",
      "The generation progress, materialization, provider lock, or cost snapshot is invalid."
    );
  }
  if (
    generation.state === "planned" &&
    !(
      generation.aggregateVersion === 1 &&
      countersAreZero(generation.counters) &&
      generation.cost.reserved === 0 &&
      generation.cost.spent === 0 &&
      materialization.revision === 1
    )
  ) {
    return generationCreationFailure(
      "generation-invalid",
      "A planned generation must remain a zero-progress initial snapshot."
    );
  }
  return succeed(creation);
};

export type AuthorizeDatasetGenerationPageEffectInput = Readonly<{
  now: Instant;
  pageSequence: number;
  reservedAmount: number;
  unit: string;
}>;

export const authorizeDatasetGenerationPageEffect = (
  creation: DatasetGenerationCreation,
  plan: DatasetGenerationPlan,
  input: AuthorizeDatasetGenerationPageEffectInput
): DomainResult<
  DatasetGenerationCreation,
  DatasetGenerationCreationFailure
> => {
  const valid = validateDatasetGenerationSnapshot(creation, plan);
  if (!valid.ok) {
    return valid;
  }
  if (
    (creation.generation.state !== "planned" &&
      creation.generation.state !== "running") ||
    creation.materialization.state !== "building" ||
    !Number.isSafeInteger(input.pageSequence) ||
    input.pageSequence !== creation.generation.counters.pages + 1 ||
    (input.pageSequence === 1) !== (creation.generation.state === "planned") ||
    !instantIsValid(input.now) ||
    input.now >= plan.deadline ||
    input.now >= plan.authority.deadline ||
    input.unit !== creation.generation.cost.unit ||
    !isAmount(input.reservedAmount) ||
    amountExceeds(
      creation.generation.cost.spent + input.reservedAmount,
      plan.hardExecutionCap
    ) ||
    amountExceeds(
      input.reservedAmount,
      plan.budget.limit -
        creation.generation.cost.reserved -
        creation.generation.cost.spent
    ) ||
    creation.generation.counters.pages >= plan.limits.maxPages ||
    creation.generation.counters.calls >= plan.limits.maxCalls ||
    creation.generation.counters.accepted >=
      datasetGenerationAcceptedRecordLimit(plan) ||
    creation.generation.counters.returned >= plan.limits.maxResults ||
    !DATASET_GENERATION_LIMIT_NAMES.every((name) =>
      nonNegativeSafeInteger(plan.limits[name])
    )
  ) {
    return generationCreationFailure(
      "generation-invalid",
      "The generation cannot authorize this next page within its immutable authority, caps, deadline, and budget."
    );
  }
  return validateDatasetGenerationSnapshot(
    {
      generation: {
        ...creation.generation,
        aggregateVersion: creation.generation.aggregateVersion + 1,
        cost: {
          ...creation.generation.cost,
          reserved: creation.generation.cost.reserved + input.reservedAmount,
        },
        counters: {
          ...creation.generation.counters,
          calls: creation.generation.counters.calls + 1,
          pages: creation.generation.counters.pages + 1,
        },
        state: "running",
      },
      materialization: creation.materialization,
    },
    plan
  );
};

export type CheckpointDatasetGenerationPageProgressInput = Readonly<{
  accepted: number;
  costAmount: number;
  costUnit: string;
  duplicates: number;
  pageSequence: number;
  providerKey: string;
  rejected: number;
  returned: number;
}>;

export const checkpointDatasetGenerationPageProgress = (
  creation: DatasetGenerationCreation,
  plan: DatasetGenerationPlan,
  input: CheckpointDatasetGenerationPageProgressInput
): DomainResult<
  DatasetGenerationCreation,
  DatasetGenerationCreationFailure
> => {
  const valid = validateDatasetGenerationSnapshot(creation, plan);
  if (!valid.ok) {
    return valid;
  }
  if (
    (creation.generation.state !== "running" &&
      creation.generation.state !== "stopping") ||
    creation.generation.counters.pages !== input.pageSequence ||
    creation.generation.counters.calls !== input.pageSequence ||
    (creation.generation.lastPageSequence !== input.pageSequence - 1 &&
      !(
        input.pageSequence === 1 &&
        creation.generation.lastPageSequence === undefined
      )) ||
    (creation.generation.lockedProvider !== undefined &&
      creation.generation.lockedProvider !== input.providerKey) ||
    !Number.isSafeInteger(input.pageSequence) ||
    input.pageSequence < 1 ||
    !boundedText(input.providerKey) ||
    input.costUnit !== creation.generation.cost.unit ||
    !isAmount(input.costAmount) ||
    amountExceeds(input.costAmount, creation.generation.cost.reserved) ||
    ![input.accepted, input.duplicates, input.rejected, input.returned].every(
      nonNegativeSafeInteger
    ) ||
    input.returned !== input.accepted + input.duplicates + input.rejected
  ) {
    return generationCreationFailure(
      "generation-invalid",
      "The page checkpoint is not a valid monotone generation transition."
    );
  }
  const nextGeneration: DatasetGeneration = {
    ...creation.generation,
    aggregateVersion: creation.generation.aggregateVersion + 1,
    cost: {
      ...creation.generation.cost,
      reserved: 0,
      spent: creation.generation.cost.spent + input.costAmount,
    },
    counters: {
      accepted: creation.generation.counters.accepted + input.accepted,
      calls: creation.generation.counters.calls,
      duplicates: creation.generation.counters.duplicates + input.duplicates,
      pages: creation.generation.counters.pages,
      rejected: creation.generation.counters.rejected + input.rejected,
      returned: creation.generation.counters.returned + input.returned,
    },
    lastPageSequence: input.pageSequence,
    lockedProvider: creation.generation.lockedProvider ?? input.providerKey,
  };
  const nextMaterialization: DatasetMaterialization = {
    ...creation.materialization,
    recordCount: creation.materialization.recordCount + input.accepted,
    rejectedCount: creation.materialization.rejectedCount + input.rejected,
    revision: creation.materialization.revision + 1,
  };
  return validateDatasetGenerationSnapshot(
    { generation: nextGeneration, materialization: nextMaterialization },
    plan
  );
};

export type CompleteDatasetGenerationInput = Readonly<{
  completedAt: Instant;
  completionReason: "caps-reached" | "source-completed";
  contentHash: ContentHash;
  coverageStatus: "bounded" | "complete_for_declared_source";
}>;

/** Publishes a generated materialization only after its final page checkpoint. */
export const completeDatasetGeneration = (
  creation: DatasetGenerationCreation,
  plan: DatasetGenerationPlan,
  input: CompleteDatasetGenerationInput
): DomainResult<
  DatasetGenerationCreation,
  DatasetGenerationCreationFailure
> => {
  const valid = validateDatasetGenerationSnapshot(creation, plan);
  if (!valid.ok) {
    return valid;
  }
  if (
    creation.generation.state !== "running" ||
    creation.materialization.state !== "building" ||
    creation.generation.cost.reserved !== 0 ||
    creation.generation.lastPageSequence !==
      creation.generation.counters.pages ||
    !instantIsValid(input.completedAt) ||
    input.completedAt < creation.generation.createdAt ||
    !contentHashIsValid(input.contentHash) ||
    (input.completionReason === "source-completed") !==
      (input.coverageStatus === "complete_for_declared_source")
  ) {
    return generationCreationFailure(
      "generation-invalid",
      "Only a fully checkpointed generation can publish a ready materialization."
    );
  }
  return validateDatasetGenerationSnapshot(
    {
      generation: {
        ...creation.generation,
        aggregateVersion: creation.generation.aggregateVersion + 1,
        state: "completed",
      },
      materialization: {
        ...creation.materialization,
        completedAt: input.completedAt,
        completionReason: input.completionReason,
        contentHash: input.contentHash,
        coverage: {
          basis: "locked_provider_route",
          status: input.coverageStatus,
        },
        revision: creation.materialization.revision + 1,
        state: "ready",
      },
    },
    plan
  );
};

export type FailDatasetGenerationInput = Readonly<{
  completedAt: Instant;
  completionReason: string;
}>;

/** Projects a certain terminal Run failure without inventing usable data. */
export const failDatasetGeneration = (
  creation: DatasetGenerationCreation,
  plan: DatasetGenerationPlan,
  input: FailDatasetGenerationInput
): DomainResult<
  DatasetGenerationCreation,
  DatasetGenerationCreationFailure
> => {
  const valid = validateDatasetGenerationSnapshot(creation, plan);
  if (!valid.ok) {
    return valid;
  }
  if (
    creation.generation.state !== "running" ||
    creation.materialization.state !== "building" ||
    !instantIsValid(input.completedAt) ||
    input.completedAt < creation.generation.createdAt ||
    !boundedText(input.completionReason, 128)
  ) {
    return generationCreationFailure(
      "generation-invalid",
      "Only an active generation can project a certain page failure."
    );
  }
  return validateDatasetGenerationSnapshot(
    {
      generation: {
        ...creation.generation,
        aggregateVersion: creation.generation.aggregateVersion + 1,
        cost: { ...creation.generation.cost, reserved: 0 },
        state: "failed",
      },
      materialization: {
        ...creation.materialization,
        completedAt: input.completedAt,
        completionReason: input.completionReason,
        revision: creation.materialization.revision + 1,
        state: "failed",
      },
    },
    plan
  );
};

export const markDatasetGenerationAmbiguous = (
  creation: DatasetGenerationCreation,
  plan: DatasetGenerationPlan
): DomainResult<
  DatasetGenerationCreation,
  DatasetGenerationCreationFailure
> => {
  const valid = validateDatasetGenerationSnapshot(creation, plan);
  if (!valid.ok) {
    return valid;
  }
  if (
    (creation.generation.state !== "running" &&
      creation.generation.state !== "stopping") ||
    creation.materialization.state !== "building"
  ) {
    return generationCreationFailure(
      "generation-invalid",
      "Only an active generation can become ambiguous."
    );
  }
  return validateDatasetGenerationSnapshot(
    {
      generation: {
        ...creation.generation,
        aggregateVersion: creation.generation.aggregateVersion + 1,
        state: "ambiguous",
      },
      materialization: {
        ...creation.materialization,
        revision: creation.materialization.revision + 1,
        state: "ambiguous",
      },
    },
    plan
  );
};

export type RequestDatasetGenerationStopInput = Readonly<{
  reason: "requested";
  requestedAt: Instant;
}>;

/**
 * Persists an explicit stop before deciding whether an active page still owns
 * an uncertain external effect. A fully checkpointed or zero-effect
 * generation can terminate immediately; otherwise it must remain stopping.
 */
export const requestDatasetGenerationStop = (
  creation: DatasetGenerationCreation,
  plan: DatasetGenerationPlan,
  input: RequestDatasetGenerationStopInput
): DomainResult<
  DatasetGenerationCreation,
  DatasetGenerationCreationFailure
> => {
  const valid = validateDatasetGenerationSnapshot(creation, plan);
  if (!valid.ok) {
    return valid;
  }
  if (
    !instantIsValid(input.requestedAt) ||
    input.requestedAt < creation.generation.createdAt ||
    input.reason !== "requested" ||
    creation.generation.state === "ambiguous" ||
    creation.generation.state === "completed" ||
    creation.generation.state === "failed"
  ) {
    return generationCreationFailure(
      "generation-invalid",
      "This generation cannot accept an explicit stop request."
    );
  }
  if (
    creation.generation.state === "cancelled" ||
    creation.generation.state === "stopping"
  ) {
    return succeed(creation);
  }

  const noEffectIsInFlight =
    creation.generation.state === "planned" ||
    (creation.generation.cost.reserved === 0 &&
      creation.generation.lastPageSequence ===
        creation.generation.counters.pages);
  const state = noEffectIsInFlight ? "cancelled" : "stopping";
  return validateDatasetGenerationSnapshot(
    {
      generation: {
        ...creation.generation,
        aggregateVersion: creation.generation.aggregateVersion + 1,
        state,
        stop: { reason: input.reason, requestedAt: input.requestedAt },
      },
      materialization:
        state === "cancelled"
          ? {
              ...creation.materialization,
              completedAt: input.requestedAt,
              completionReason: input.reason,
              revision: creation.materialization.revision + 1,
              state: "cancelled",
            }
          : creation.materialization,
    },
    plan
  );
};

/** Converges a stopping generation only after its active page has a certain issue. */
export const cancelDatasetGenerationAfterStop = (
  creation: DatasetGenerationCreation,
  plan: DatasetGenerationPlan,
  completedAt: Instant
): DomainResult<
  DatasetGenerationCreation,
  DatasetGenerationCreationFailure
> => {
  const valid = validateDatasetGenerationSnapshot(creation, plan);
  if (!valid.ok) {
    return valid;
  }
  if (
    creation.generation.state !== "stopping" ||
    creation.generation.stop === undefined ||
    !instantIsValid(completedAt) ||
    completedAt < creation.generation.stop.requestedAt
  ) {
    return generationCreationFailure(
      "generation-invalid",
      "Only a stopping generation with a certain page issue can be cancelled."
    );
  }
  return validateDatasetGenerationSnapshot(
    {
      generation: {
        ...creation.generation,
        aggregateVersion: creation.generation.aggregateVersion + 1,
        cost: { ...creation.generation.cost, reserved: 0 },
        state: "cancelled",
      },
      materialization: {
        ...creation.materialization,
        completedAt,
        completionReason: creation.generation.stop.reason,
        revision: creation.materialization.revision + 1,
        state: "cancelled",
      },
    },
    plan
  );
};

export const createDatasetGeneration = (
  input: CreateDatasetGenerationInput
): DomainResult<
  DatasetGenerationCreation,
  DatasetGenerationCreationFailure
> => {
  const targetDataset = input.plan.requestIntent.targetDataset;
  const materializationId = datasetMaterializationId(
    String(targetDataset.datasetId)
  );
  const creation: DatasetGenerationCreation = {
    generation: {
      aggregateVersion: 1,
      capability: { ...input.plan.requestIntent.capability },
      cost: { reserved: 0, spent: 0, unit: input.plan.budget.unit },
      counters: {
        accepted: 0,
        calls: 0,
        duplicates: 0,
        pages: 0,
        rejected: 0,
        returned: 0,
      },
      createdAt: input.createdAt,
      datasetId: targetDataset.datasetId,
      generationId: input.generationId,
      generationPlanId: input.plan.generationPlanId,
      materializationId,
      planHash: input.plan.planHash,
      queryHash: input.plan.queryHash,
      requestIntentHash: input.plan.requestIntentHash,
      schemaHash: input.plan.schemaHash,
      state: "planned",
      workspaceId: input.plan.workspaceId,
    },
    materialization: {
      createdAt: input.createdAt,
      datasetId: targetDataset.datasetId,
      materializationId,
      origin: { generationId: input.generationId, kind: "generation" },
      recordCount: 0,
      rejectedCount: 0,
      revision: 1,
      schemaHash: input.plan.schemaHash,
      state: "building",
      workspaceId: input.plan.workspaceId,
    },
  };
  return validateDatasetGenerationCreation(creation, input.plan);
};

export const datasetGenerationSchemaHashContent = (
  intent: DatasetGenerationRequestIntent
): Readonly<{ dataset: Dataset; fields: readonly Field[] }> => ({
  dataset: intent.targetDataset,
  fields: intent.fields,
});

export const datasetGenerationPlanHashContent = (
  draft: DatasetGenerationPlanDraft
): DatasetGenerationPlanDraft => draft;

export const datasetGenerationRequestIntentHashContent = (
  intent: DatasetGenerationRequestIntent
): DatasetGenerationRequestIntent => intent;
