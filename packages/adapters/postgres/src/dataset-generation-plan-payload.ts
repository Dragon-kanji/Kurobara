import {
  type AuthorityEnvelope,
  actorId,
  type BudgetLimit,
  type CapabilityRef,
  type ContractRef,
  type CostQuote,
  capabilityId,
  contentHash,
  createDataset,
  createDatasetGenerationPlan,
  createField,
  DATASET_GENERATION_LIMIT_NAMES,
  type Dataset,
  type DatasetGenerationLimitName,
  type DatasetGenerationLimitRequest,
  type DatasetGenerationLimits,
  type DatasetGenerationPlan,
  type DatasetGenerationQueryValue,
  type DatasetGenerationRequestIntent,
  type DatasetGenerationRouteSnapshot,
  type DatasetGenerationUnknownCostPolicy,
  datasetGenerationPlanHashContent,
  datasetGenerationPlanId,
  datasetGenerationRequestIntentHashContent,
  datasetGenerationSchemaHashContent,
  datasetId,
  type Field,
  fieldId,
  idempotencyKey,
  instant,
  validateDatasetFields,
  validateDatasetGenerationRequestIntent,
  workspaceId,
} from "@kurobara/kernel";
import type { StoredDatasetGenerationPlan } from "@kurobara/ports";

import {
  normalizedJsonEvidence,
  parseNormalizedJsonValue,
} from "./artifact-payload.ts";
import { DatabasePayloadError } from "./errors.ts";
import { toJsonValue } from "./json.ts";

type JsonRecord = Readonly<Record<string, unknown>>;
const UNSAFE_QUERY_KEYS = new Set(["__proto__", "constructor", "prototype"]);

export type DatasetGenerationPlanRowIdentity = Readonly<{
  generationPlanId: string;
  idempotencyKey: string;
  planHash: string;
  queryHash: string;
  requestIntentHash: string;
  schemaHash: string;
  targetDatasetId: string;
  workspaceId: string;
}>;

const asRecord = (value: unknown, path: string): JsonRecord => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new DatabasePayloadError(`${path} must be an object.`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (!(prototype === Object.prototype || prototype === null)) {
    throw new DatabasePayloadError(`${path} must be a plain JSON object.`);
  }
  return value as JsonRecord;
};

const assertOnlyKeys = (
  value: JsonRecord,
  path: string,
  required: readonly string[],
  optional: readonly string[] = []
): void => {
  const allowed = new Set([...required, ...optional]);
  const missing = required.find((key) => !Object.hasOwn(value, key));
  const extra = Object.keys(value).find((key) => !allowed.has(key));
  if (missing !== undefined || extra !== undefined) {
    throw new DatabasePayloadError(
      `${path} does not have its exact canonical field set.`
    );
  }
};

const asString = (value: unknown, path: string): string => {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new DatabasePayloadError(`${path} must be a non-empty string.`);
  }
  return value;
};

const asBoundedString = (
  value: unknown,
  path: string,
  maximum = 255
): string => {
  const parsed = asString(value, path);
  if ([...parsed].length > maximum) {
    throw new DatabasePayloadError(`${path} exceeds its maximum length.`);
  }
  return parsed;
};

const asIdentity = (value: unknown, path: string, maximum = 255): string => {
  const parsed = asBoundedString(value, path, maximum);
  if (parsed.trim() !== parsed) {
    throw new DatabasePayloadError(`${path} must not have surrounding space.`);
  }
  return parsed;
};

const asFiniteNumber = (value: unknown, path: string): number => {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new DatabasePayloadError(`${path} must be a finite number.`);
  }
  return value;
};

const asNonNegativeAmount = (value: unknown, path: string): number => {
  const parsed = asFiniteNumber(value, path);
  if (parsed < 0) {
    throw new DatabasePayloadError(`${path} must be non-negative.`);
  }
  return parsed;
};

const asNonNegativeInteger = (value: unknown, path: string): number => {
  const parsed = asFiniteNumber(value, path);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new DatabasePayloadError(
      `${path} must be a non-negative safe integer.`
    );
  }
  return parsed;
};

const parseHash = (value: unknown, path: string) => {
  try {
    return contentHash(asString(value, path));
  } catch {
    throw new DatabasePayloadError(`${path} must be a SHA-256 content hash.`);
  }
};

const parseInstant = (value: unknown, path: string) => {
  try {
    return instant(asNonNegativeInteger(value, path));
  } catch {
    throw new DatabasePayloadError(
      `${path} must be an epoch millisecond instant.`
    );
  }
};

const parseCapability = (value: unknown, path: string): CapabilityRef => {
  const item = asRecord(value, path);
  assertOnlyKeys(item, path, ["capabilityId", "capabilityVersion"]);
  try {
    return {
      capabilityId: capabilityId(
        asBoundedString(item.capabilityId, `${path}.capabilityId`)
      ),
      capabilityVersion: asBoundedString(
        item.capabilityVersion,
        `${path}.capabilityVersion`
      ),
    };
  } catch (error) {
    if (error instanceof DatabasePayloadError) {
      throw error;
    }
    throw new DatabasePayloadError(`${path} is invalid.`);
  }
};

const parseBudget = (value: unknown, path: string): BudgetLimit => {
  const item = asRecord(value, path);
  assertOnlyKeys(item, path, ["limit", "reserved", "spent", "unit"]);
  return {
    limit: asNonNegativeAmount(item.limit, `${path}.limit`),
    reserved: asNonNegativeAmount(item.reserved, `${path}.reserved`),
    spent: asNonNegativeAmount(item.spent, `${path}.spent`),
    unit: asBoundedString(item.unit, `${path}.unit`, 64),
  };
};

const parseContract = (value: unknown, path: string): ContractRef => {
  const item = asRecord(value, path);
  assertOnlyKeys(item, path, [
    "catalogFingerprint",
    "catalogVersion",
    "schemaFingerprint",
    "schemaId",
    "schemaVersion",
  ]);
  return {
    catalogFingerprint: parseHash(
      item.catalogFingerprint,
      `${path}.catalogFingerprint`
    ),
    catalogVersion: asBoundedString(
      item.catalogVersion,
      `${path}.catalogVersion`
    ),
    schemaFingerprint: parseHash(
      item.schemaFingerprint,
      `${path}.schemaFingerprint`
    ),
    schemaId: asBoundedString(item.schemaId, `${path}.schemaId`),
    schemaVersion: asBoundedString(item.schemaVersion, `${path}.schemaVersion`),
  };
};

const parseQuery = (
  value: unknown,
  path: string,
  depth = 0,
  state = { nodes: 0 }
): DatasetGenerationQueryValue => {
  state.nodes += 1;
  if (depth > 32 || state.nodes > 10_000) {
    throw new DatabasePayloadError(`${path} exceeds the bounded query shape.`);
  }
  if (value === null || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    return asFiniteNumber(value, path);
  }
  if (typeof value === "string") {
    if ([...value].length > 16_384) {
      throw new DatabasePayloadError(`${path} exceeds its maximum length.`);
    }
    return value;
  }
  if (Array.isArray(value)) {
    if (value.length > 1024) {
      throw new DatabasePayloadError(`${path} has too many entries.`);
    }
    return value.map((entry, index) =>
      parseQuery(entry, `${path}[${index}]`, depth + 1, state)
    );
  }
  const item = asRecord(value, path);
  const entries = Object.entries(item);
  if (entries.length > 1024) {
    throw new DatabasePayloadError(`${path} has too many entries.`);
  }
  const result: Record<string, DatasetGenerationQueryValue> = {};
  for (const [key, entry] of entries) {
    if (
      key.length === 0 ||
      UNSAFE_QUERY_KEYS.has(key) ||
      [...key].length > 255
    ) {
      throw new DatabasePayloadError(`${path} contains an invalid key.`);
    }
    result[key] = parseQuery(entry, `${path}.${key}`, depth + 1, state);
  }
  return result;
};

const parseDataset = (value: unknown, path: string): Dataset => {
  const item = asRecord(value, path);
  assertOnlyKeys(item, path, ["datasetId", "name", "workspaceId"]);
  try {
    const candidate: Dataset = {
      datasetId: datasetId(asIdentity(item.datasetId, `${path}.datasetId`)),
      name: asBoundedString(item.name, `${path}.name`),
      workspaceId: workspaceId(
        asIdentity(item.workspaceId, `${path}.workspaceId`)
      ),
    };
    const created = createDataset(candidate);
    if (!created.ok) {
      throw new DatabasePayloadError(`${path} violates dataset invariants.`);
    }
    return created.value;
  } catch (error) {
    if (error instanceof DatabasePayloadError) {
      throw error;
    }
    throw new DatabasePayloadError(`${path} is invalid.`);
  }
};

const parseField = (value: unknown, path: string, dataset: Dataset): Field => {
  const item = asRecord(value, path);
  assertOnlyKeys(item, path, [
    "datasetId",
    "fieldId",
    "key",
    "label",
    "valueType",
    "workspaceId",
  ]);
  const valueType = asString(item.valueType, `${path}.valueType`);
  if (
    valueType !== "boolean" &&
    valueType !== "number" &&
    valueType !== "string"
  ) {
    throw new DatabasePayloadError(`${path}.valueType is invalid.`);
  }
  try {
    const candidate: Field = {
      datasetId: datasetId(asIdentity(item.datasetId, `${path}.datasetId`)),
      fieldId: fieldId(asIdentity(item.fieldId, `${path}.fieldId`)),
      key: asBoundedString(item.key, `${path}.key`, 128),
      label: asBoundedString(item.label, `${path}.label`),
      valueType,
      workspaceId: workspaceId(
        asIdentity(item.workspaceId, `${path}.workspaceId`)
      ),
    };
    const created = createField(dataset, candidate);
    if (!created.ok) {
      throw new DatabasePayloadError(`${path} violates field invariants.`);
    }
    return created.value;
  } catch (error) {
    if (error instanceof DatabasePayloadError) {
      throw error;
    }
    throw new DatabasePayloadError(`${path} is invalid.`);
  }
};

const parseLimitRequest = (
  value: unknown,
  path: string
): DatasetGenerationLimitRequest => {
  const item = asRecord(value, path);
  assertOnlyKeys(item, path, [], DATASET_GENERATION_LIMIT_NAMES);
  const parsed: Partial<Record<DatasetGenerationLimitName, number>> = {};
  for (const name of DATASET_GENERATION_LIMIT_NAMES) {
    if (Object.hasOwn(item, name)) {
      parsed[name] = asNonNegativeInteger(item[name], `${path}.${name}`);
    }
  }
  return parsed;
};

const parseLimits = (value: unknown, path: string): DatasetGenerationLimits => {
  const item = asRecord(value, path);
  assertOnlyKeys(item, path, DATASET_GENERATION_LIMIT_NAMES);
  return {
    maxCalls: asNonNegativeInteger(item.maxCalls, `${path}.maxCalls`),
    maxCompanies: asNonNegativeInteger(
      item.maxCompanies,
      `${path}.maxCompanies`
    ),
    maxContactsPerCompany: asNonNegativeInteger(
      item.maxContactsPerCompany,
      `${path}.maxContactsPerCompany`
    ),
    maxContactsTotal: asNonNegativeInteger(
      item.maxContactsTotal,
      `${path}.maxContactsTotal`
    ),
    maxEnrichments: asNonNegativeInteger(
      item.maxEnrichments,
      `${path}.maxEnrichments`
    ),
    maxPages: asNonNegativeInteger(item.maxPages, `${path}.maxPages`),
    maxPhones: asNonNegativeInteger(item.maxPhones, `${path}.maxPhones`),
    maxResults: asNonNegativeInteger(item.maxResults, `${path}.maxResults`),
  };
};

const parseUnknownCostPolicy = (
  value: unknown,
  path: string
): DatasetGenerationUnknownCostPolicy => {
  const item = asRecord(value, path);
  const mode = asString(item.mode, `${path}.mode`);
  if (mode === "deny") {
    assertOnlyKeys(item, path, ["mode"]);
    return { mode };
  }
  if (mode === "explicit-non-interactive") {
    assertOnlyKeys(item, path, ["hardCap", "mode"]);
    return {
      hardCap: asNonNegativeAmount(item.hardCap, `${path}.hardCap`),
      mode,
    };
  }
  throw new DatabasePayloadError(`${path}.mode is invalid.`);
};

const parseRequestIntent = (
  value: unknown,
  path: string
): DatasetGenerationRequestIntent => {
  const item = asRecord(value, path);
  assertOnlyKeys(item, path, [
    "actorId",
    "authorityEnvelopeId",
    "capability",
    "fields",
    "limits",
    "requestedBudget",
    "requestedDeadline",
    "requestedQuery",
    "targetDataset",
    "unknownCostPolicy",
    "workspaceId",
  ]);
  const targetDataset = parseDataset(
    item.targetDataset,
    `${path}.targetDataset`
  );
  if (!Array.isArray(item.fields) || item.fields.length > 256) {
    throw new DatabasePayloadError(`${path}.fields must be a bounded array.`);
  }
  const fields = item.fields.map((field, index) =>
    parseField(field, `${path}.fields[${index}]`, targetDataset)
  );
  const validatedFields = validateDatasetFields(targetDataset, fields);
  if (!validatedFields.ok) {
    throw new DatabasePayloadError(
      `${path}.fields violates dataset field invariants.`
    );
  }
  const requestedBudget = asRecord(
    item.requestedBudget,
    `${path}.requestedBudget`
  );
  assertOnlyKeys(requestedBudget, `${path}.requestedBudget`, ["limit", "unit"]);
  try {
    const intent: DatasetGenerationRequestIntent = {
      actorId: actorId(asIdentity(item.actorId, `${path}.actorId`)),
      authorityEnvelopeId: asIdentity(
        item.authorityEnvelopeId,
        `${path}.authorityEnvelopeId`
      ),
      capability: parseCapability(item.capability, `${path}.capability`),
      fields: validatedFields.value,
      limits: parseLimitRequest(item.limits, `${path}.limits`),
      requestedBudget: {
        limit: asNonNegativeAmount(
          requestedBudget.limit,
          `${path}.requestedBudget.limit`
        ),
        unit: asBoundedString(
          requestedBudget.unit,
          `${path}.requestedBudget.unit`,
          64
        ),
      },
      requestedDeadline: parseInstant(
        item.requestedDeadline,
        `${path}.requestedDeadline`
      ),
      requestedQuery: parseQuery(item.requestedQuery, `${path}.requestedQuery`),
      targetDataset,
      unknownCostPolicy: parseUnknownCostPolicy(
        item.unknownCostPolicy,
        `${path}.unknownCostPolicy`
      ),
      workspaceId: workspaceId(
        asIdentity(item.workspaceId, `${path}.workspaceId`)
      ),
    };
    const validated = validateDatasetGenerationRequestIntent(intent);
    if (!validated.ok) {
      throw new DatabasePayloadError(
        `${path} violates generation request invariants.`
      );
    }
    return validated.value;
  } catch (error) {
    if (error instanceof DatabasePayloadError) {
      throw error;
    }
    throw new DatabasePayloadError(`${path} is invalid.`);
  }
};

const parseAuthority = (value: unknown, path: string): AuthorityEnvelope => {
  const item = asRecord(value, path);
  assertOnlyKeys(item, path, [
    "authorityEnvelopeId",
    "budgetLimit",
    "capabilities",
    "deadline",
    "permissions",
    "subjectActorId",
    "version",
    "workspaceId",
  ]);
  if (!Array.isArray(item.capabilities) || item.capabilities.length > 256) {
    throw new DatabasePayloadError(
      `${path}.capabilities must be a bounded array.`
    );
  }
  if (!Array.isArray(item.permissions) || item.permissions.length > 256) {
    throw new DatabasePayloadError(
      `${path}.permissions must be a bounded array.`
    );
  }
  try {
    return {
      authorityEnvelopeId: asIdentity(
        item.authorityEnvelopeId,
        `${path}.authorityEnvelopeId`
      ),
      budgetLimit: parseBudget(item.budgetLimit, `${path}.budgetLimit`),
      capabilities: item.capabilities.map((entry, index) =>
        parseCapability(entry, `${path}.capabilities[${index}]`)
      ),
      deadline: parseInstant(item.deadline, `${path}.deadline`),
      permissions: item.permissions.map((entry, index) =>
        asBoundedString(entry, `${path}.permissions[${index}]`)
      ),
      subjectActorId: actorId(
        asIdentity(item.subjectActorId, `${path}.subjectActorId`)
      ),
      version: asBoundedString(item.version, `${path}.version`),
      workspaceId: workspaceId(
        asIdentity(item.workspaceId, `${path}.workspaceId`)
      ),
    };
  } catch (error) {
    if (error instanceof DatabasePayloadError) {
      throw error;
    }
    throw new DatabasePayloadError(`${path} is invalid.`);
  }
};

const parseQuote = (value: unknown, path: string): CostQuote => {
  const item = asRecord(value, path);
  assertOnlyKeys(
    item,
    path,
    ["expiresAt", "guarantee", "pricingVersion", "quoteId", "unit"],
    ["upperBound"]
  );
  const guarantee = asString(item.guarantee, `${path}.guarantee`);
  if (
    guarantee !== "hard" &&
    guarantee !== "estimated" &&
    guarantee !== "unknown"
  ) {
    throw new DatabasePayloadError(`${path}.guarantee is invalid.`);
  }
  return {
    expiresAt: parseInstant(item.expiresAt, `${path}.expiresAt`),
    guarantee,
    pricingVersion: asBoundedString(
      item.pricingVersion,
      `${path}.pricingVersion`
    ),
    quoteId: asBoundedString(item.quoteId, `${path}.quoteId`),
    unit: asBoundedString(item.unit, `${path}.unit`, 64),
    ...(item.upperBound === undefined
      ? {}
      : {
          upperBound: asNonNegativeAmount(
            item.upperBound,
            `${path}.upperBound`
          ),
        }),
  };
};

const parseRouteSnapshot = (
  value: unknown,
  path: string
): DatasetGenerationRouteSnapshot => {
  const item = asRecord(value, path);
  assertOnlyKeys(
    item,
    path,
    [
      "capability",
      "effectAdapterKey",
      "factsHash",
      "pricingVersion",
      "reservableUpperBound",
      "reservationUnit",
      "routeKey",
    ],
    ["providerIdentityNamespace"]
  );
  return {
    capability: parseCapability(item.capability, `${path}.capability`),
    effectAdapterKey: asBoundedString(
      item.effectAdapterKey,
      `${path}.effectAdapterKey`
    ),
    factsHash: parseHash(item.factsHash, `${path}.factsHash`),
    pricingVersion: asBoundedString(
      item.pricingVersion,
      `${path}.pricingVersion`
    ),
    ...(item.providerIdentityNamespace === undefined
      ? {}
      : {
          providerIdentityNamespace: asBoundedString(
            item.providerIdentityNamespace,
            `${path}.providerIdentityNamespace`,
            128
          ),
        }),
    reservableUpperBound: asNonNegativeAmount(
      item.reservableUpperBound,
      `${path}.reservableUpperBound`
    ),
    reservationUnit: asBoundedString(
      item.reservationUnit,
      `${path}.reservationUnit`,
      64
    ),
    routeKey: asBoundedString(item.routeKey, `${path}.routeKey`),
  };
};

const canonicalHash = (value: unknown) =>
  contentHash(
    normalizedJsonEvidence(parseNormalizedJsonValue(toJsonValue(value)))
      .contentHash
  );

const assertCanonicalHashes = (plan: DatasetGenerationPlan): void => {
  const expectedQueryHash = canonicalHash(plan.normalizedQuery);
  const expectedSchemaHash = canonicalHash(
    datasetGenerationSchemaHashContent(plan.requestIntent)
  );
  const expectedRequestIntentHash = canonicalHash(
    datasetGenerationRequestIntentHashContent(plan.requestIntent)
  );
  const { planHash, ...draft } = plan;
  const expectedPlanHash = canonicalHash(
    datasetGenerationPlanHashContent(draft)
  );
  if (
    plan.queryHash !== expectedQueryHash ||
    plan.schemaHash !== expectedSchemaHash ||
    plan.requestIntentHash !== expectedRequestIntentHash ||
    planHash !== expectedPlanHash
  ) {
    throw new DatabasePayloadError(
      "datasetGenerationPlan does not match its canonical hash evidence."
    );
  }
};

const parsePlan = (value: unknown): DatasetGenerationPlan => {
  const path = "datasetGenerationPlan";
  const item = asRecord(value, path);
  assertOnlyKeys(item, path, [
    "authority",
    "budget",
    "deadline",
    "generationPlanId",
    "hardExecutionCap",
    "idempotencyKey",
    "limits",
    "normalizedQuery",
    "normalizerVersion",
    "planHash",
    "policy",
    "queryContract",
    "queryHash",
    "quote",
    "requestIntent",
    "requestIntentHash",
    "routeSnapshots",
    "schemaHash",
    "workspaceId",
  ]);
  const policy = asRecord(item.policy, `${path}.policy`);
  assertOnlyKeys(policy, `${path}.policy`, [
    "factsHash",
    "requiredPermission",
    "version",
  ]);
  if (!Array.isArray(item.routeSnapshots) || item.routeSnapshots.length > 64) {
    throw new DatabasePayloadError(
      `${path}.routeSnapshots must be a bounded array.`
    );
  }
  try {
    const candidate: DatasetGenerationPlan = {
      authority: parseAuthority(item.authority, `${path}.authority`),
      budget: parseBudget(item.budget, `${path}.budget`),
      deadline: parseInstant(item.deadline, `${path}.deadline`),
      generationPlanId: datasetGenerationPlanId(
        asIdentity(item.generationPlanId, `${path}.generationPlanId`)
      ),
      hardExecutionCap: asNonNegativeAmount(
        item.hardExecutionCap,
        `${path}.hardExecutionCap`
      ),
      idempotencyKey: idempotencyKey(
        asIdentity(item.idempotencyKey, `${path}.idempotencyKey`, 512)
      ),
      limits: parseLimits(item.limits, `${path}.limits`),
      normalizedQuery: parseQuery(
        item.normalizedQuery,
        `${path}.normalizedQuery`
      ),
      normalizerVersion: asBoundedString(
        item.normalizerVersion,
        `${path}.normalizerVersion`
      ),
      planHash: parseHash(item.planHash, `${path}.planHash`),
      policy: {
        factsHash: parseHash(policy.factsHash, `${path}.policy.factsHash`),
        requiredPermission: asBoundedString(
          policy.requiredPermission,
          `${path}.policy.requiredPermission`
        ),
        version: asBoundedString(policy.version, `${path}.policy.version`),
      },
      queryContract: parseContract(item.queryContract, `${path}.queryContract`),
      queryHash: parseHash(item.queryHash, `${path}.queryHash`),
      quote: parseQuote(item.quote, `${path}.quote`),
      requestIntent: parseRequestIntent(
        item.requestIntent,
        `${path}.requestIntent`
      ),
      requestIntentHash: parseHash(
        item.requestIntentHash,
        `${path}.requestIntentHash`
      ),
      routeSnapshots: item.routeSnapshots.map((entry, index) =>
        parseRouteSnapshot(entry, `${path}.routeSnapshots[${index}]`)
      ),
      schemaHash: parseHash(item.schemaHash, `${path}.schemaHash`),
      workspaceId: workspaceId(
        asIdentity(item.workspaceId, `${path}.workspaceId`)
      ),
    };
    const created = createDatasetGenerationPlan(candidate);
    if (!created.ok) {
      throw new DatabasePayloadError(
        `${path} violates generation plan invariants.`
      );
    }
    assertCanonicalHashes(created.value);
    return created.value;
  } catch (error) {
    if (error instanceof DatabasePayloadError) {
      throw error;
    }
    throw new DatabasePayloadError(`${path} is invalid.`);
  }
};

const matchesRowIdentity = (
  record: StoredDatasetGenerationPlan,
  expected: DatasetGenerationPlanRowIdentity
): boolean =>
  record.plan.workspaceId === expected.workspaceId &&
  record.plan.generationPlanId === expected.generationPlanId &&
  record.idempotencyKey === expected.idempotencyKey &&
  record.plan.requestIntent.targetDataset.datasetId ===
    expected.targetDatasetId &&
  record.plan.queryHash === expected.queryHash &&
  record.plan.schemaHash === expected.schemaHash &&
  record.requestIntentHash === expected.requestIntentHash &&
  record.plan.planHash === expected.planHash;

export const parseDatasetGenerationPlanRecord = (
  value: unknown,
  expected?: DatasetGenerationPlanRowIdentity
): StoredDatasetGenerationPlan => {
  const payload = asRecord(value, "datasetGenerationPlanRecord");
  assertOnlyKeys(payload, "datasetGenerationPlanRecord", [
    "idempotencyKey",
    "plan",
    "requestIntentHash",
  ]);
  const plan = parsePlan(payload.plan);
  const record: StoredDatasetGenerationPlan = {
    idempotencyKey: idempotencyKey(
      asIdentity(
        payload.idempotencyKey,
        "datasetGenerationPlanRecord.idempotencyKey",
        512
      )
    ),
    plan,
    requestIntentHash: parseHash(
      payload.requestIntentHash,
      "datasetGenerationPlanRecord.requestIntentHash"
    ),
  };
  if (
    record.idempotencyKey !== plan.idempotencyKey ||
    record.requestIntentHash !== plan.requestIntentHash
  ) {
    throw new DatabasePayloadError(
      "datasetGenerationPlanRecord does not match its nested plan identity."
    );
  }
  if (expected !== undefined && !matchesRowIdentity(record, expected)) {
    throw new DatabasePayloadError(
      "datasetGenerationPlanRecord does not match its relational identity."
    );
  }
  return record;
};

export const datasetGenerationPlanRecordIdentity = (
  record: StoredDatasetGenerationPlan
): DatasetGenerationPlanRowIdentity => ({
  generationPlanId: record.plan.generationPlanId,
  idempotencyKey: record.idempotencyKey,
  planHash: record.plan.planHash,
  queryHash: record.plan.queryHash,
  requestIntentHash: record.requestIntentHash,
  schemaHash: record.plan.schemaHash,
  targetDatasetId: record.plan.requestIntent.targetDataset.datasetId,
  workspaceId: record.plan.workspaceId,
});
