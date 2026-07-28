import {
  actorId,
  datasetId,
  datasetMaterializationId,
  workspaceId,
} from "@kurobara/kernel";
import type {
  GtmAnswerValue,
  GtmCompiledStage,
  GtmContextAssertion,
  GtmContextDocument,
  GtmContextRevisionRef,
  GtmPersistencePort,
  GtmPlayCompilation,
  GtmPlayDefinition,
  GtmPlayLifecycle,
  GtmPlayRunActor,
  GtmPlayRunClaim,
  GtmPlayRunExecution,
  GtmPlayRunStageReceipt,
  GtmPlayRunState,
  GtmPlayRunUpdate,
  GtmPlayRunUpdateResult,
  GtmWorkbookAnnotation,
  GtmWorkbookApproval,
  GtmWorkbookFilter,
  GtmWorkbookSelectionReason,
  GtmWorkbookView,
  GtmWorkbookViewWrite,
  RecipeApplicationId,
  StoredGtmContextRevision,
  StoredGtmPlayRevision,
  StoredGtmPlayRun,
  WorkspaceScope,
} from "@kurobara/ports";
import type postgres from "postgres";

import { DatabasePayloadError } from "./errors.ts";
import { toJsonValue } from "./json.ts";

const HASH_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const FIELD_KEY_PATTERN = /^[a-z][a-z0-9_]{0,127}$/u;

type ContextRow = Readonly<{
  context_id: string;
  created_at_ms: string;
  created_by_actor_id: string;
  document: unknown;
  fingerprint: string;
  revision: number;
  workspace_id: string;
}>;

type PlayRow = Readonly<{
  compilation: unknown;
  created_at_ms: string;
  created_by_actor_id: string;
  definition: unknown;
  fingerprint: string;
  lifecycle: string;
  play_id: string;
  revision: number;
  workspace_id: string;
}>;

type PlayRunRow = Readonly<{
  compilation: unknown;
  created_at_ms: string;
  definition: unknown;
  execution: unknown;
  execution_actor: unknown;
  idempotency_key: string;
  play_id: string;
  play_revision: number;
  revision: number;
  run_id: string;
  state: string;
  updated_at_ms: string;
  workspace_id: string;
}>;

type WorkbookRow = Readonly<{
  dataset_id: string;
  materialization_id: string;
  revision: number;
  view: unknown;
  workbook_id: string;
  workspace_id: string;
}>;

const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const invalid = (message: string): never => {
  throw new DatabasePayloadError(message);
};

const requiredString = (
  value: unknown,
  name: string,
  maximum = 16_384
): string => {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.length > maximum
  ) {
    return invalid(`Stored ${name} is invalid.`);
  }
  return value;
};

const finiteNumber = (value: unknown, name: string, minimum = 0): number => {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum) {
    return invalid(`Stored ${name} is invalid.`);
  }
  return value;
};

const safeInteger = (value: unknown, name: string, minimum = 0): number => {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < minimum
  ) {
    return invalid(`Stored ${name} is invalid.`);
  }
  return value;
};

const bigintNumber = (value: string, name: string): number => {
  const parsed = Number(value);
  return safeInteger(parsed, name);
};

const stringArray = (
  value: unknown,
  name: string,
  maximumItems = 1000
): readonly string[] => {
  if (
    !Array.isArray(value) ||
    value.length > maximumItems ||
    value.some(
      (entry) =>
        typeof entry !== "string" ||
        entry.trim().length === 0 ||
        entry.length > 16_384
    )
  ) {
    return invalid(`Stored ${name} is invalid.`);
  }
  return value;
};

const answerValue = (value: unknown): GtmAnswerValue => {
  if (
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value)) ||
    (typeof value === "string" && value.length <= 16_384)
  ) {
    return value;
  }
  return stringArray(value, "GTM answer value", 128);
};

const parseAssertion = (value: unknown): GtmContextAssertion => {
  if (!(isObject(value) && isObject(value.provenance))) {
    return invalid("Stored GTM assertion is invalid.");
  }
  const state = requiredString(value.state, "GTM assertion state", 32);
  if (
    ![
      "confirmed",
      "imported_unverified",
      "inferred",
      "not_applicable",
      "unknown",
    ].includes(state)
  ) {
    return invalid("Stored GTM assertion state is invalid.");
  }
  const source = requiredString(
    value.provenance.source,
    "GTM assertion provenance source",
    16
  );
  if (!["agent", "human", "import"].includes(source)) {
    return invalid("Stored GTM assertion provenance source is invalid.");
  }
  return {
    provenance: {
      ...(value.provenance.actorId === undefined
        ? {}
        : {
            actorId: actorId(
              requiredString(
                value.provenance.actorId,
                "GTM assertion actor",
                255
              )
            ),
          }),
      recordedAtMs: safeInteger(
        value.provenance.recordedAtMs,
        "GTM assertion timestamp"
      ),
      source: source as "agent" | "human" | "import",
    },
    questionId: requiredString(value.questionId, "GTM question identity", 255),
    state: state as GtmContextAssertion["state"],
    ...(value.value === undefined ? {} : { value: answerValue(value.value) }),
  };
};

const parseContextDocument = (value: unknown): GtmContextDocument => {
  if (
    !(isObject(value) && Array.isArray(value.assertions)) ||
    value.assertions.length > 128
  ) {
    return invalid("Stored GTM Context document is invalid.");
  }
  return {
    assertions: value.assertions.map(parseAssertion),
    contextId: requiredString(value.contextId, "GTM Context identity", 255),
    name: requiredString(value.name, "GTM Context name", 255),
    questionnaireVersion: requiredString(
      value.questionnaireVersion,
      "GTM questionnaire version",
      32
    ),
  };
};

const parseContextRow = (row: ContextRow): StoredGtmContextRevision => {
  if (!HASH_PATTERN.test(row.fingerprint)) {
    return invalid("Stored GTM Context fingerprint is invalid.");
  }
  return {
    contextId: requiredString(row.context_id, "GTM Context identity", 255),
    createdAtMs: bigintNumber(row.created_at_ms, "GTM Context timestamp"),
    createdByActorId: actorId(row.created_by_actor_id),
    document: parseContextDocument(row.document),
    fingerprint: row.fingerprint,
    revision: safeInteger(row.revision, "GTM Context revision", 1),
    workspaceId: workspaceId(row.workspace_id),
  };
};

const parseContextRef = (value: unknown): GtmContextRevisionRef => {
  if (!isObject(value)) {
    return invalid("Stored GTM Context reference is invalid.");
  }
  const fingerprint = requiredString(
    value.fingerprint,
    "GTM Context reference fingerprint",
    71
  );
  if (!HASH_PATTERN.test(fingerprint)) {
    return invalid("Stored GTM Context reference fingerprint is invalid.");
  }
  return {
    contextId: requiredString(
      value.contextId,
      "GTM Context reference identity",
      255
    ),
    fingerprint,
    revision: safeInteger(value.revision, "GTM Context reference revision", 1),
  };
};

const parsePlaySource = (
  value: Record<string, unknown>
): GtmPlayDefinition["source"] => {
  const sourceKind = requiredString(value.kind, "Play source kind", 32);
  if (sourceKind === "organization_search") {
    return {
      countries: stringArray(value.countries, "Play source countries", 64),
      industries: stringArray(value.industries, "Play source industries", 128),
      keywords: stringArray(value.keywords, "Play source keywords", 128),
      kind: "organization_search",
    };
  }
  if (sourceKind !== "imported_dataset" || !isObject(value.fieldMapping)) {
    return invalid("Stored Play source is invalid.");
  }
  const fieldMapping = {
    ...(value.fieldMapping.countryCode === undefined
      ? {}
      : {
          countryCode: requiredString(
            value.fieldMapping.countryCode,
            "Play country field",
            128
          ),
        }),
    domain: requiredString(value.fieldMapping.domain, "Play domain field", 128),
    ...(value.fieldMapping.name === undefined
      ? {}
      : {
          name: requiredString(value.fieldMapping.name, "Play name field", 128),
        }),
  };
  for (const fieldKey of Object.values(fieldMapping)) {
    if (!FIELD_KEY_PATTERN.test(fieldKey)) {
      return invalid("Stored Play source field mapping is invalid.");
    }
  }
  return {
    datasetId: datasetId(requiredString(value.datasetId, "Play dataset", 255)),
    ...(value.defaultCountryCode === undefined
      ? {}
      : {
          defaultCountryCode: requiredString(
            value.defaultCountryCode,
            "Play default country",
            2
          ),
        }),
    fieldMapping,
    kind: "imported_dataset",
    materializationId: datasetMaterializationId(
      requiredString(value.materializationId, "Play materialization", 255)
    ),
  };
};

const parsePlayDefinition = (value: unknown): GtmPlayDefinition => {
  if (
    !(
      isObject(value) &&
      isObject(value.approvals) &&
      isObject(value.audience) &&
      isObject(value.budget) &&
      isObject(value.contextRef) &&
      isObject(value.delivery) &&
      isObject(value.objective) &&
      isObject(value.preview) &&
      isObject(value.selection) &&
      isObject(value.source)
    )
  ) {
    return invalid("Stored Play definition is invalid.");
  }
  const broadening = requiredString(
    value.broadening,
    "Play broadening mode",
    32
  );
  if (!["forbidden", "human_approval"].includes(broadening)) {
    return invalid("Stored Play broadening mode is invalid.");
  }
  const source = parsePlaySource(value.source);
  if (
    typeof value.approvals.export !== "boolean" ||
    typeof value.approvals.providerSpend !== "boolean" ||
    typeof value.approvals.reveal !== "boolean" ||
    typeof value.delivery.privateExport !== "boolean" ||
    value.delivery.mode !== "no_send"
  ) {
    return invalid("Stored Play approvals or delivery policy is invalid.");
  }
  return {
    approvals: {
      export: value.approvals.export,
      providerSpend: value.approvals.providerSpend,
      reveal: value.approvals.reveal,
    },
    authorityEnvelopeId: requiredString(
      value.authorityEnvelopeId,
      "Play authority envelope",
      255
    ),
    audience: {
      companyCountries: stringArray(
        value.audience.companyCountries,
        "Play company countries",
        64
      ),
      departments: stringArray(
        value.audience.departments,
        "Play departments",
        128
      ),
      personCountries: stringArray(
        value.audience.personCountries,
        "Play person countries",
        64
      ),
      seniorities: stringArray(
        value.audience.seniorities,
        "Play seniorities",
        128
      ),
      titles: stringArray(value.audience.titles, "Play titles", 256),
    },
    broadening: broadening as GtmPlayDefinition["broadening"],
    budget: {
      limit: finiteNumber(value.budget.limit, "Play budget", 0),
      unit: requiredString(value.budget.unit, "Play budget unit", 64),
    },
    capabilities: stringArray(value.capabilities, "Play capabilities", 64),
    contextRef: parseContextRef(value.contextRef),
    deadlineMs: safeInteger(value.deadlineMs, "Play deadline"),
    delivery: {
      mode: "no_send",
      privateExport: value.delivery.privateExport,
    },
    exclusions: stringArray(value.exclusions, "Play exclusions", 256),
    objective: {
      metric: requiredString(
        value.objective.metric,
        "Play objective metric",
        255
      ),
      target: finiteNumber(value.objective.target, "Play objective target", 0),
      text: requiredString(value.objective.text, "Play objective", 2048),
    },
    playId: requiredString(value.playId, "Play identity", 255),
    preview: {
      maxCompanies: safeInteger(
        value.preview.maxCompanies,
        "Play max companies",
        1
      ),
      maxContactsPerCompany: safeInteger(
        value.preview.maxContactsPerCompany,
        "Play max contacts per company",
        1
      ),
      maxContactsTotal: safeInteger(
        value.preview.maxContactsTotal,
        "Play max contacts total",
        1
      ),
      maxProviderCalls: safeInteger(
        value.preview.maxProviderCalls,
        "Play max provider calls"
      ),
      sampleSize: safeInteger(value.preview.sampleSize, "Play sample size", 1),
    },
    selection: {
      minimumScore: finiteNumber(
        value.selection.minimumScore,
        "Play minimum score"
      ),
      requiredSignals: stringArray(
        value.selection.requiredSignals,
        "Play required signals",
        128
      ),
    },
    source,
    stopConditions: stringArray(
      value.stopConditions,
      "Play stop conditions",
      128
    ),
  };
};

const parseCompiledStage = (value: unknown): GtmCompiledStage => {
  if (!isObject(value)) {
    return invalid("Stored compiled Play stage is invalid.");
  }
  const inputFingerprint = requiredString(
    value.inputFingerprint,
    "compiled Play stage fingerprint",
    71
  );
  if (!HASH_PATTERN.test(inputFingerprint)) {
    return invalid("Stored compiled Play stage fingerprint is invalid.");
  }
  return {
    ...(value.capability === undefined
      ? {}
      : {
          capability: requiredString(
            value.capability,
            "compiled Play capability",
            255
          ),
        }),
    inputFingerprint,
    operationId: requiredString(
      value.operationId,
      "compiled Play operation",
      255
    ),
    ordinal: safeInteger(value.ordinal, "compiled Play stage ordinal", 1),
  };
};

const parseCompilation = (value: unknown): GtmPlayCompilation => {
  if (
    !(
      isObject(value) &&
      isObject(value.authority) &&
      isObject(value.budget) &&
      Array.isArray(value.stages)
    )
  ) {
    return invalid("Stored Play compilation is invalid.");
  }
  const intentionHash = requiredString(
    value.intentionHash,
    "Play intention hash",
    71
  );
  if (!HASH_PATTERN.test(intentionHash) || value.exportMode !== "no_send") {
    return invalid("Stored Play compilation identity is invalid.");
  }
  return {
    assumptions: stringArray(
      value.assumptions,
      "Play compilation assumptions",
      64
    ),
    authority: {
      humanGates: stringArray(
        value.authority.humanGates,
        "Play human gates",
        32
      ),
      permissions: stringArray(
        value.authority.permissions,
        "Play permissions",
        64
      ),
    },
    budget: {
      limit: finiteNumber(value.budget.limit, "Play budget limit"),
      quotedUpperBound: finiteNumber(
        value.budget.quotedUpperBound,
        "Play quoted upper bound"
      ),
      unit: requiredString(value.budget.unit, "Play budget unit", 64),
    },
    deadlineMs: safeInteger(value.deadlineMs, "Play deadline"),
    exportMode: "no_send",
    intentionHash,
    stages: value.stages.map(parseCompiledStage),
  };
};

const isPlayLifecycle = (value: string): value is GtmPlayLifecycle =>
  [
    "active",
    "approved",
    "awaiting_approval",
    "draft",
    "paused",
    "previewed",
    "retired",
    "validated",
  ].includes(value);

const parsePlayRow = (row: PlayRow): StoredGtmPlayRevision => {
  if (!(HASH_PATTERN.test(row.fingerprint) && isPlayLifecycle(row.lifecycle))) {
    return invalid("Stored Play revision identity is invalid.");
  }
  return {
    compilation: parseCompilation(row.compilation),
    createdAtMs: bigintNumber(row.created_at_ms, "Play timestamp"),
    createdByActorId: actorId(row.created_by_actor_id),
    definition: parsePlayDefinition(row.definition),
    fingerprint: row.fingerprint,
    lifecycle: row.lifecycle,
    playId: requiredString(row.play_id, "Play identity", 255),
    revision: safeInteger(row.revision, "Play revision", 1),
    workspaceId: workspaceId(row.workspace_id),
  };
};

const isPlayRunState = (value: string): value is GtmPlayRunState =>
  ["cancelled", "completed", "failed", "paused", "queued", "running"].includes(
    value
  );

const parseRunCost = (
  value: unknown,
  label: string
): GtmPlayRunExecution["cost"] => {
  if (!isObject(value)) {
    return invalid(`Stored ${label} cost is invalid.`);
  }
  return {
    reserved: finiteNumber(value.reserved, `${label} reserved cost`),
    spent: finiteNumber(value.spent, `${label} spent cost`),
    unit: requiredString(value.unit, `${label} cost unit`, 64),
  };
};

const parseRunStageReceipt = (value: unknown): GtmPlayRunStageReceipt => {
  if (!isObject(value)) {
    return invalid("Stored Play run stage receipt is invalid.");
  }
  const state = requiredString(value.state, "Play run stage state", 32);
  if (!["completed", "failed", "pending", "running"].includes(state)) {
    return invalid("Stored Play run stage state is invalid.");
  }
  return {
    cost: parseRunCost(value.cost, "Play run stage"),
    ...(value.datasetId === undefined
      ? {}
      : {
          datasetId: datasetId(
            requiredString(value.datasetId, "Play run stage dataset", 255)
          ),
        }),
    ...(value.generationId === undefined
      ? {}
      : {
          generationId: requiredString(
            value.generationId,
            "Play run stage generation",
            255
          ),
        }),
    ...(value.materializationId === undefined
      ? {}
      : {
          materializationId: datasetMaterializationId(
            requiredString(
              value.materializationId,
              "Play run stage materialization",
              255
            )
          ),
        }),
    operationId: requiredString(
      value.operationId,
      "Play run stage operation",
      255
    ),
    ordinal: safeInteger(value.ordinal, "Play run stage ordinal", 1),
    providerCalls: safeInteger(
      value.providerCalls,
      "Play run stage provider calls"
    ),
    ...(value.recordCount === undefined
      ? {}
      : {
          recordCount: safeInteger(
            value.recordCount,
            "Play run stage record count"
          ),
        }),
    state: state as GtmPlayRunStageReceipt["state"],
  };
};

const parseRunSelectionReasons = (
  value: unknown
): GtmPlayRunExecution["selectionReasons"] => {
  if (!Array.isArray(value) || value.length > 1000) {
    return invalid("Stored Play run selection reasons are invalid.");
  }
  return value.map((entry) => {
    if (!isObject(entry)) {
      return invalid("Stored Play run selection reason is invalid.");
    }
    return {
      reasons: stringArray(
        entry.reasons,
        "Play run selection reason values",
        32
      ),
      recordId: requiredString(
        entry.recordId,
        "Play run selection record",
        255
      ),
    };
  });
};

const parseRunExecution = (value: unknown): GtmPlayRunExecution => {
  if (
    !(
      isObject(value) &&
      Array.isArray(value.provenance) &&
      Array.isArray(value.selectedRecordIds) &&
      Array.isArray(value.stages)
    )
  ) {
    return invalid("Stored Play run execution is invalid.");
  }
  const result = value.result;
  const error = value.error;
  let parsedError: GtmPlayRunExecution["error"];
  if (error !== undefined) {
    if (!(isObject(error) && typeof error.retryable === "boolean")) {
      return invalid("Stored Play run error is invalid.");
    }
    parsedError = {
      code: requiredString(error.code, "Play run error code", 128),
      message: requiredString(error.message, "Play run error message", 2048),
      retryable: error.retryable,
    };
  }
  let parsedResult: GtmPlayRunExecution["result"];
  if (result !== undefined) {
    if (!isObject(result)) {
      return invalid("Stored Play run result is invalid.");
    }
    parsedResult = {
      datasetId: datasetId(
        requiredString(result.datasetId, "Play run result dataset", 255)
      ),
      exportReady:
        typeof result.exportReady === "boolean"
          ? result.exportReady
          : invalid("Stored Play run export readiness is invalid."),
      materializationId: datasetMaterializationId(
        requiredString(
          result.materializationId,
          "Play run result materialization",
          255
        )
      ),
      recordCount: safeInteger(
        result.recordCount,
        "Play run result record count"
      ),
      workbookId: requiredString(
        result.workbookId,
        "Play run result Workbook",
        255
      ),
    };
  }
  return {
    cost: parseRunCost(value.cost, "Play run"),
    ...(value.currentStageOrdinal === undefined
      ? {}
      : {
          currentStageOrdinal: safeInteger(
            value.currentStageOrdinal,
            "Play run current stage",
            1
          ),
        }),
    ...(parsedError === undefined ? {} : { error: parsedError }),
    providerCalls: safeInteger(value.providerCalls, "Play run provider calls"),
    provenance: stringArray(value.provenance, "Play run provenance", 256),
    ...(parsedResult === undefined ? {} : { result: parsedResult }),
    selectedRecordIds: stringArray(
      value.selectedRecordIds,
      "Play run selected records",
      1000
    ),
    selectionReasons: parseRunSelectionReasons(value.selectionReasons),
    stages: value.stages.map(parseRunStageReceipt),
  };
};

const parseRunActor = (value: unknown): GtmPlayRunActor => {
  if (
    !(
      isObject(value) &&
      value.authenticationMode === "api-key" &&
      Array.isArray(value.permissions)
    )
  ) {
    return invalid("Stored Play run actor is invalid.");
  }
  return {
    actorId: actorId(requiredString(value.actorId, "Play run actor", 255)),
    authenticationMode: "api-key",
    permissions: stringArray(
      value.permissions,
      "Play run actor permissions",
      256
    ),
  };
};

const parsePlayRunRow = (row: PlayRunRow): StoredGtmPlayRun => {
  if (!isPlayRunState(row.state)) {
    return invalid("Stored Play run state is invalid.");
  }
  return {
    compilation: parseCompilation(row.compilation),
    createdAtMs: bigintNumber(row.created_at_ms, "Play run timestamp"),
    definition: parsePlayDefinition(row.definition),
    execution: parseRunExecution(row.execution),
    executionActor: parseRunActor(row.execution_actor),
    idempotencyKey: requiredString(
      row.idempotency_key,
      "Play run idempotency key",
      255
    ),
    playId: requiredString(row.play_id, "Play identity", 255),
    playRevision: safeInteger(row.play_revision, "Play revision", 1),
    revision: safeInteger(row.revision, "Play run revision", 1),
    runId: requiredString(row.run_id, "Play run identity", 255),
    state: row.state,
    updatedAtMs: bigintNumber(row.updated_at_ms, "Play run update timestamp"),
    workspaceId: workspaceId(row.workspace_id),
  };
};

const parseWorkbookFilter = (value: unknown): GtmWorkbookFilter => {
  if (!isObject(value)) {
    return invalid("Stored Workbook filter is invalid.");
  }
  const operator = requiredString(
    value.operator,
    "Workbook filter operator",
    32
  );
  if (!["equals", "is_not_null"].includes(operator)) {
    return invalid("Stored Workbook filter operator is invalid.");
  }
  const filterValue = value.value;
  if (
    filterValue !== undefined &&
    typeof filterValue !== "boolean" &&
    typeof filterValue !== "string" &&
    (typeof filterValue !== "number" || !Number.isFinite(filterValue))
  ) {
    return invalid("Stored Workbook filter value is invalid.");
  }
  return {
    fieldKey: requiredString(value.fieldKey, "Workbook filter field", 128),
    operator: operator as GtmWorkbookFilter["operator"],
    ...(filterValue === undefined ? {} : { value: filterValue }),
  };
};

const parseWorkbookSelectionReason = (
  value: unknown
): GtmWorkbookSelectionReason => {
  if (!isObject(value)) {
    return invalid("Stored Workbook selection reason is invalid.");
  }
  return {
    reasons: stringArray(value.reasons, "Workbook selection reasons", 32),
    recordId: requiredString(value.recordId, "Workbook selection record", 255),
  };
};

const parseWorkbookAnnotation = (value: unknown): GtmWorkbookAnnotation => {
  if (!isObject(value)) {
    return invalid("Stored Workbook annotation is invalid.");
  }
  return {
    createdAtMs: safeInteger(
      value.createdAtMs,
      "Workbook annotation timestamp"
    ),
    createdByActorId: actorId(
      requiredString(value.createdByActorId, "Workbook annotation actor", 255)
    ),
    note: requiredString(value.note, "Workbook annotation note", 2048),
    recordId: requiredString(value.recordId, "Workbook annotation record", 255),
  };
};

const parseWorkbookApproval = (value: unknown): GtmWorkbookApproval => {
  if (!isObject(value)) {
    return invalid("Stored Workbook approval is invalid.");
  }
  const decision = requiredString(
    value.decision,
    "Workbook approval decision",
    16
  );
  if (!["approved", "rejected"].includes(decision)) {
    return invalid("Stored Workbook approval decision is invalid.");
  }
  return {
    createdAtMs: safeInteger(value.createdAtMs, "Workbook approval timestamp"),
    createdByActorId: actorId(
      requiredString(value.createdByActorId, "Workbook approval actor", 255)
    ),
    decision: decision as GtmWorkbookApproval["decision"],
    recordId: requiredString(value.recordId, "Workbook approval record", 255),
  };
};

const parseWorkbookRow = (row: WorkbookRow): GtmWorkbookView => {
  if (
    !(
      isObject(row.view) &&
      Array.isArray(row.view.annotations) &&
      Array.isArray(row.view.approvals) &&
      Array.isArray(row.view.filters) &&
      Array.isArray(row.view.selectionReasons)
    )
  ) {
    return invalid("Stored Workbook view is invalid.");
  }
  return {
    annotations: row.view.annotations.map(parseWorkbookAnnotation),
    approvals: row.view.approvals.map(parseWorkbookApproval),
    columnOrder: stringArray(
      row.view.columnOrder,
      "Workbook column order",
      256
    ),
    ...(row.view.contextRef === undefined
      ? {}
      : { contextRef: parseContextRef(row.view.contextRef) }),
    datasetId: datasetId(row.dataset_id),
    filters: row.view.filters.map(parseWorkbookFilter),
    materializationId: datasetMaterializationId(row.materialization_id),
    name: requiredString(row.view.name, "Workbook name", 255),
    ...(row.view.playId === undefined
      ? {}
      : {
          playId: requiredString(row.view.playId, "Workbook Play", 255),
        }),
    ...(row.view.playRevision === undefined
      ? {}
      : {
          playRevision: safeInteger(
            row.view.playRevision,
            "Workbook Play revision",
            1
          ),
        }),
    ...(row.view.playRunId === undefined
      ? {}
      : {
          playRunId: requiredString(
            row.view.playRunId,
            "Workbook Play run",
            255
          ),
        }),
    ...(row.view.recipeApplicationId === undefined
      ? {}
      : {
          recipeApplicationId: requiredString(
            row.view.recipeApplicationId,
            "Workbook recipe application",
            255
          ) as RecipeApplicationId,
        }),
    revision: safeInteger(row.revision, "Workbook revision", 1),
    selectionReasons: row.view.selectionReasons.map(
      parseWorkbookSelectionReason
    ),
    selectedRecordIds: stringArray(
      row.view.selectedRecordIds,
      "Workbook selection",
      1000
    ),
    workbookId: requiredString(row.workbook_id, "Workbook identity", 255),
    workspaceId: workspaceId(row.workspace_id),
  };
};

const contextSelect = async (
  sql: postgres.Sql,
  scope: WorkspaceScope,
  contextId?: string,
  revision?: number
): Promise<StoredGtmContextRevision | undefined> => {
  let rows: readonly ContextRow[];
  if (contextId === undefined) {
    rows = await sql<readonly ContextRow[]>`
          SELECT
            revision.workspace_id,
            revision.context_id,
            revision.revision,
            revision.fingerprint,
            revision.document,
            revision.created_by_actor_id,
            revision.created_at_ms::text
          FROM kurobara_core.gtm_context_revisions AS revision
          WHERE revision.workspace_id = ${scope.workspaceId}
          ORDER BY revision.created_at_ms DESC, revision.revision DESC
          LIMIT 1
        `;
  } else if (revision === undefined) {
    rows = await sql<readonly ContextRow[]>`
            SELECT
              stored.workspace_id,
              stored.context_id,
              stored.revision,
              stored.fingerprint,
              stored.document,
              stored.created_by_actor_id,
              stored.created_at_ms::text
            FROM kurobara_core.gtm_context_revisions AS stored
            WHERE stored.workspace_id = ${scope.workspaceId}
              AND stored.context_id = ${contextId}
            ORDER BY stored.revision DESC
            LIMIT 1
          `;
  } else {
    rows = await sql<readonly ContextRow[]>`
            SELECT
              stored.workspace_id,
              stored.context_id,
              stored.revision,
              stored.fingerprint,
              stored.document,
              stored.created_by_actor_id,
              stored.created_at_ms::text
            FROM kurobara_core.gtm_context_revisions AS stored
            WHERE stored.workspace_id = ${scope.workspaceId}
              AND stored.context_id = ${contextId}
              AND stored.revision = ${revision}
            LIMIT 1
          `;
  }
  return rows[0] === undefined ? undefined : parseContextRow(rows[0]);
};

const workbookViewValue = (input: GtmWorkbookViewWrite) => ({
  annotations: input.annotations,
  approvals: input.approvals,
  columnOrder: input.columnOrder,
  ...(input.contextRef === undefined ? {} : { contextRef: input.contextRef }),
  filters: input.filters,
  name: input.name,
  ...(input.playId === undefined ? {} : { playId: input.playId }),
  ...(input.playRevision === undefined
    ? {}
    : { playRevision: input.playRevision }),
  ...(input.playRunId === undefined ? {} : { playRunId: input.playRunId }),
  ...(input.recipeApplicationId === undefined
    ? {}
    : { recipeApplicationId: input.recipeApplicationId }),
  selectionReasons: input.selectionReasons,
  selectedRecordIds: input.selectedRecordIds,
});

const playSelect = async (
  sql: postgres.Sql,
  scope: WorkspaceScope,
  playId: string,
  revision?: number
): Promise<StoredGtmPlayRevision | undefined> => {
  const rows =
    revision === undefined
      ? await sql<readonly PlayRow[]>`
          SELECT
            stored.workspace_id,
            stored.play_id,
            stored.revision,
            stored.fingerprint,
            stored.lifecycle,
            stored.definition,
            stored.compilation,
            stored.created_by_actor_id,
            stored.created_at_ms::text
          FROM kurobara_core.gtm_play_revisions AS stored
          WHERE stored.workspace_id = ${scope.workspaceId}
            AND stored.play_id = ${playId}
          ORDER BY stored.revision DESC
          LIMIT 1
        `
      : await sql<readonly PlayRow[]>`
          SELECT
            stored.workspace_id,
            stored.play_id,
            stored.revision,
            stored.fingerprint,
            stored.lifecycle,
            stored.definition,
            stored.compilation,
            stored.created_by_actor_id,
            stored.created_at_ms::text
          FROM kurobara_core.gtm_play_revisions AS stored
          WHERE stored.workspace_id = ${scope.workspaceId}
            AND stored.play_id = ${playId}
            AND stored.revision = ${revision}
          LIMIT 1
        `;
  return rows[0] === undefined ? undefined : parsePlayRow(rows[0]);
};

export const createPostgresGtmPersistence = (
  sql: postgres.Sql
): GtmPersistencePort => ({
  activateContext: async (scope, reference) => {
    const rows = await sql<readonly { fingerprint: string }[]>`
      SELECT fingerprint
      FROM kurobara_core.gtm_context_revisions
      WHERE workspace_id = ${scope.workspaceId}
        AND context_id = ${reference.contextId}
        AND revision = ${reference.revision}
        AND fingerprint = ${reference.fingerprint}
      LIMIT 1
    `;
    if (rows[0] === undefined) {
      throw new DatabasePayloadError(
        "The active GTM Context reference does not resolve in this workspace."
      );
    }
    await sql`
      INSERT INTO kurobara_core.gtm_active_contexts (
        workspace_id,
        context_id,
        revision,
        fingerprint
      ) VALUES (
        ${scope.workspaceId},
        ${reference.contextId},
        ${reference.revision},
        ${reference.fingerprint}
      )
      ON CONFLICT (workspace_id) DO UPDATE
      SET
        context_id = EXCLUDED.context_id,
        revision = EXCLUDED.revision,
        fingerprint = EXCLUDED.fingerprint,
        activated_at = clock_timestamp()
    `;
  },
  createPlayRun: async (scope, input) =>
    sql.begin(async (transactionSql) => {
      const transaction = transactionSql as unknown as postgres.Sql;
      const existing = await transaction<readonly PlayRunRow[]>`
        SELECT
          workspace_id,
          run_id,
          play_id,
          play_revision,
          idempotency_key,
          state,
          compilation,
          definition,
          execution,
          execution_actor,
          revision,
          created_at_ms::text,
          updated_at_ms::text
        FROM kurobara_core.gtm_play_runs
        WHERE workspace_id = ${scope.workspaceId}
          AND idempotency_key = ${input.idempotencyKey}
        FOR UPDATE
      `;
      if (existing[0] !== undefined) {
        const parsed = parsePlayRunRow(existing[0]);
        return parsed.playId === input.playId &&
          parsed.playRevision === input.playRevision &&
          parsed.compilation.intentionHash === input.compilation.intentionHash
          ? { run: parsed, status: "existing" as const }
          : { status: "conflict" as const };
      }
      await transaction`
        INSERT INTO kurobara_core.gtm_play_runs (
          workspace_id,
          run_id,
          play_id,
          play_revision,
          idempotency_key,
          intention_hash,
          state,
          compilation,
          definition,
          execution,
          execution_actor,
          revision,
          created_at_ms,
          updated_at_ms
        ) VALUES (
          ${scope.workspaceId},
          ${input.runId},
          ${input.playId},
          ${input.playRevision},
          ${input.idempotencyKey},
          ${input.compilation.intentionHash},
          'queued',
          ${transaction.json(toJsonValue(input.compilation))},
          ${transaction.json(toJsonValue(input.definition))},
          ${transaction.json(toJsonValue(input.execution))},
          ${transaction.json(toJsonValue(input.executionActor))},
          1,
          ${input.createdAtMs},
          ${input.createdAtMs}
        )
      `;
      const created = await transaction<readonly PlayRunRow[]>`
        SELECT
          workspace_id,
          run_id,
          play_id,
          play_revision,
          idempotency_key,
          state,
          compilation,
          definition,
          execution,
          execution_actor,
          revision,
          created_at_ms::text,
          updated_at_ms::text
        FROM kurobara_core.gtm_play_runs
        WHERE workspace_id = ${scope.workspaceId}
          AND run_id = ${input.runId}
      `;
      return {
        run: parsePlayRunRow(
          created[0] ?? invalid("Created Play run could not be read back.")
        ),
        status: "created" as const,
      };
    }),
  claimNextPlayRun: async (
    workerId,
    claimToken,
    nowMs,
    leaseMs
  ): Promise<GtmPlayRunClaim | undefined> =>
    sql.begin(async (transactionSql) => {
      const transaction = transactionSql as unknown as postgres.Sql;
      const candidates = await transaction<readonly PlayRunRow[]>`
        SELECT
          workspace_id,
          run_id,
          play_id,
          play_revision,
          idempotency_key,
          state,
          compilation,
          definition,
          execution,
          execution_actor,
          revision,
          created_at_ms::text,
          updated_at_ms::text
        FROM kurobara_core.gtm_play_runs
        WHERE state IN ('queued', 'running')
          AND (
            claim_expires_at_ms IS NULL
            OR claim_expires_at_ms <= ${nowMs}
          )
        ORDER BY updated_at_ms ASC, run_id ASC
        FOR UPDATE SKIP LOCKED
        LIMIT 1
      `;
      const candidate = candidates[0];
      if (candidate === undefined) {
        return;
      }
      const claimExpiresAtMs = nowMs + leaseMs;
      await transaction`
        UPDATE kurobara_core.gtm_play_runs
        SET
          claim_owner = ${workerId},
          claim_token = ${claimToken},
          claim_expires_at_ms = ${claimExpiresAtMs}
        WHERE workspace_id = ${candidate.workspace_id}
          AND run_id = ${candidate.run_id}
      `;
      return {
        claimExpiresAtMs,
        claimToken,
        run: parsePlayRunRow(candidate),
        workerId,
      };
    }),
  getActiveContext: async (scope) => {
    const rows = await sql<readonly ContextRow[]>`
      SELECT
        revision.workspace_id,
        revision.context_id,
        revision.revision,
        revision.fingerprint,
        revision.document,
        revision.created_by_actor_id,
        revision.created_at_ms::text
      FROM kurobara_core.gtm_active_contexts AS active
      INNER JOIN kurobara_core.gtm_context_revisions AS revision
        ON revision.workspace_id = active.workspace_id
        AND revision.context_id = active.context_id
        AND revision.revision = active.revision
      WHERE active.workspace_id = ${scope.workspaceId}
      LIMIT 1
    `;
    return rows[0] === undefined ? undefined : parseContextRow(rows[0]);
  },
  getContextRevision: (scope, contextId, revision) =>
    contextSelect(sql, scope, contextId, revision),
  getLatestContext: (scope) => contextSelect(sql, scope),
  getPlayRevision: (scope, playId, revision) =>
    playSelect(sql, scope, playId, revision),
  getPlayRun: async (scope, runId) => {
    const rows = await sql<readonly PlayRunRow[]>`
      SELECT
        workspace_id,
        run_id,
        play_id,
        play_revision,
        idempotency_key,
        state,
        compilation,
        definition,
        execution,
        execution_actor,
        revision,
        created_at_ms::text,
        updated_at_ms::text
      FROM kurobara_core.gtm_play_runs
      WHERE workspace_id = ${scope.workspaceId}
        AND run_id = ${runId}
      LIMIT 1
    `;
    return rows[0] === undefined ? undefined : parsePlayRunRow(rows[0]);
  },
  getWorkbookView: async (scope, workbookId) => {
    const rows = await sql<readonly WorkbookRow[]>`
      SELECT
        workspace_id,
        workbook_id,
        revision,
        dataset_id,
        materialization_id,
        view
      FROM kurobara_core.gtm_workbook_revisions
      WHERE workspace_id = ${scope.workspaceId}
        AND workbook_id = ${workbookId}
      ORDER BY revision DESC
      LIMIT 1
    `;
    return rows[0] === undefined ? undefined : parseWorkbookRow(rows[0]);
  },
  putContextRevision: async (scope, input) =>
    sql.begin(async (transactionSql) => {
      const transaction = transactionSql as unknown as postgres.Sql;
      const existing = await transaction<readonly ContextRow[]>`
        SELECT
          workspace_id,
          context_id,
          revision,
          fingerprint,
          document,
          created_by_actor_id,
          created_at_ms::text
        FROM kurobara_core.gtm_context_revisions
        WHERE workspace_id = ${scope.workspaceId}
          AND context_id = ${input.document.contextId}
          AND fingerprint = ${input.fingerprint}
        LIMIT 1
      `;
      if (existing[0] !== undefined) {
        return {
          revision: parseContextRow(existing[0]),
          status: "existing" as const,
        };
      }
      const latest = await transaction<readonly { revision: number }[]>`
        SELECT revision
        FROM kurobara_core.gtm_context_revisions
        WHERE workspace_id = ${scope.workspaceId}
          AND context_id = ${input.document.contextId}
        ORDER BY revision DESC
        LIMIT 1
        FOR UPDATE
      `;
      const latestRevision = latest[0]?.revision ?? 0;
      if (
        input.expectedBaseRevision !== undefined &&
        input.expectedBaseRevision !== latestRevision
      ) {
        return { status: "conflict" as const };
      }
      const nextRevision = latestRevision + 1;
      await transaction`
        INSERT INTO kurobara_core.gtm_context_revisions (
          workspace_id,
          context_id,
          revision,
          fingerprint,
          document,
          created_by_actor_id,
          created_at_ms
        ) VALUES (
          ${scope.workspaceId},
          ${input.document.contextId},
          ${nextRevision},
          ${input.fingerprint},
          ${transaction.json(toJsonValue(input.document))},
          ${input.createdByActorId},
          ${input.createdAtMs}
        )
      `;
      const created = await contextSelect(
        transaction,
        scope,
        input.document.contextId,
        nextRevision
      );
      return {
        revision:
          created ??
          invalid("Created GTM Context revision could not be read back."),
        status: "created" as const,
      };
    }),
  putPlayRevision: async (scope, input) =>
    sql.begin(async (transactionSql) => {
      const transaction = transactionSql as unknown as postgres.Sql;
      const existing = await transaction<readonly PlayRow[]>`
        SELECT
          workspace_id,
          play_id,
          revision,
          fingerprint,
          lifecycle,
          definition,
          compilation,
          created_by_actor_id,
          created_at_ms::text
        FROM kurobara_core.gtm_play_revisions
        WHERE workspace_id = ${scope.workspaceId}
          AND play_id = ${input.definition.playId}
          AND fingerprint = ${input.fingerprint}
          AND lifecycle = ${input.lifecycle}
        LIMIT 1
      `;
      if (existing[0] !== undefined) {
        return {
          revision: parsePlayRow(existing[0]),
          status: "existing" as const,
        };
      }
      const latest = await transaction<readonly { revision: number }[]>`
        SELECT revision
        FROM kurobara_core.gtm_play_revisions
        WHERE workspace_id = ${scope.workspaceId}
          AND play_id = ${input.definition.playId}
        ORDER BY revision DESC
        LIMIT 1
        FOR UPDATE
      `;
      const latestRevision = latest[0]?.revision ?? 0;
      if (
        input.expectedBaseRevision !== undefined &&
        input.expectedBaseRevision !== latestRevision
      ) {
        return { status: "conflict" as const };
      }
      const nextRevision = latestRevision + 1;
      await transaction`
        INSERT INTO kurobara_core.gtm_play_revisions (
          workspace_id,
          play_id,
          revision,
          fingerprint,
          lifecycle,
          definition,
          compilation,
          created_by_actor_id,
          created_at_ms
        ) VALUES (
          ${scope.workspaceId},
          ${input.definition.playId},
          ${nextRevision},
          ${input.fingerprint},
          ${input.lifecycle},
          ${transaction.json(toJsonValue(input.definition))},
          ${transaction.json(toJsonValue(input.compilation))},
          ${input.createdByActorId},
          ${input.createdAtMs}
        )
      `;
      const created = await playSelect(
        transaction,
        scope,
        input.definition.playId,
        nextRevision
      );
      return {
        revision:
          created ?? invalid("Created Play revision could not be read back."),
        status: "created" as const,
      };
    }),
  putWorkbookView: async (scope, input) =>
    sql.begin(async (transactionSql) => {
      const transaction = transactionSql as unknown as postgres.Sql;
      const latest = await transaction<readonly WorkbookRow[]>`
        SELECT
          workspace_id,
          workbook_id,
          revision,
          dataset_id,
          materialization_id,
          view
        FROM kurobara_core.gtm_workbook_revisions
        WHERE workspace_id = ${scope.workspaceId}
          AND workbook_id = ${input.workbookId}
        ORDER BY revision DESC
        LIMIT 1
        FOR UPDATE
      `;
      const latestRevision = latest[0]?.revision ?? 0;
      if (latestRevision !== input.expectedRevision) {
        return { status: "conflict" as const };
      }
      const nextRevision = latestRevision + 1;
      const view = workbookViewValue(input);
      await transaction`
        INSERT INTO kurobara_core.gtm_workbook_revisions (
          workspace_id,
          workbook_id,
          revision,
          dataset_id,
          materialization_id,
          view
        ) VALUES (
          ${scope.workspaceId},
          ${input.workbookId},
          ${nextRevision},
          ${input.datasetId},
          ${input.materializationId},
          ${transaction.json(toJsonValue(view))}
        )
      `;
      const created = await transaction<readonly WorkbookRow[]>`
        SELECT
          workspace_id,
          workbook_id,
          revision,
          dataset_id,
          materialization_id,
          view
        FROM kurobara_core.gtm_workbook_revisions
        WHERE workspace_id = ${scope.workspaceId}
          AND workbook_id = ${input.workbookId}
          AND revision = ${nextRevision}
      `;
      return {
        status:
          latestRevision === 0 ? ("created" as const) : ("updated" as const),
        view: parseWorkbookRow(
          created[0] ??
            invalid("Created Workbook revision could not be read back.")
        ),
      };
    }),
  updatePlayRun: async (
    scope,
    input: GtmPlayRunUpdate
  ): Promise<GtmPlayRunUpdateResult> => {
    const rows = await sql<readonly PlayRunRow[]>`
      UPDATE kurobara_core.gtm_play_runs
      SET
        state = ${input.state},
        execution = ${sql.json(toJsonValue(input.execution))},
        revision = revision + 1,
        updated_at_ms = ${input.updatedAtMs},
        claim_owner = NULL,
        claim_token = NULL,
        claim_expires_at_ms = NULL
      WHERE workspace_id = ${scope.workspaceId}
        AND run_id = ${input.runId}
        AND revision = ${input.expectedRevision}
        AND claim_token = ${input.claimToken}
      RETURNING
        workspace_id,
        run_id,
        play_id,
        play_revision,
        idempotency_key,
        state,
        compilation,
        definition,
        execution,
        execution_actor,
        revision,
        created_at_ms::text,
        updated_at_ms::text
    `;
    if (rows[0] !== undefined) {
      return { run: parsePlayRunRow(rows[0]), status: "updated" };
    }
    const exists = await sql<readonly { exists: boolean }[]>`
      SELECT EXISTS (
        SELECT 1
        FROM kurobara_core.gtm_play_runs
        WHERE workspace_id = ${scope.workspaceId}
          AND run_id = ${input.runId}
      ) AS exists
    `;
    return { status: exists[0]?.exists === true ? "conflict" : "not_found" };
  },
});
