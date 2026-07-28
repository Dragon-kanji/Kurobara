import type {
  ActorId,
  CellResult,
  DatasetId,
  DatasetMaterializationId,
  RecordId,
  WorkspaceId,
} from "@kurobara/kernel";
import type {
  ClockPort,
  DatasetRecordPageQueryPort,
  ExactRecipeProjectionRow,
  GtmContextAssertion,
  GtmContextDocument,
  GtmContextRevisionRef,
  GtmPersistencePort,
  GtmPlayCompilation,
  GtmPlayDefinition,
  GtmPlayLifecycle,
  GtmWorkbookView,
  GtmWorkbookViewWrite,
  RecipeApplicationId,
  StoredGtmContextRevision,
  StoredGtmPlayRevision,
  StoredGtmPlayRun,
  VerifiedApiKey,
  WorkspaceScope,
} from "@kurobara/ports";

import { canonicalContentHash } from "./canonical-content-hash.ts";

export const GTM_QUESTIONNAIRE_VERSION = "1.0.0";

export type GtmReadinessProfile =
  | "agentic_outbound_play"
  | "dataset_import"
  | "imported_dataset_enrichment"
  | "offline_fixture";

export type GtmBusinessContextState =
  | "draft"
  | "incompatible"
  | "incomplete"
  | "missing"
  | "ready"
  | "stale";

export type GtmQuestion = Readonly<{
  answerType: "boolean" | "number" | "string" | "string_array";
  askIf?: Readonly<{
    equals: boolean | number | string;
    questionId: string;
  }>;
  enumValues?: readonly string[];
  prompt: string;
  questionId: string;
  requiredFor: readonly GtmReadinessProfile[];
  requiresHumanConfirmation: boolean;
  section:
    | "activation"
    | "audience"
    | "data"
    | "offer"
    | "policy"
    | "qualification";
  sensitivity: "business" | "policy";
}>;

const OUTBOUND_PROFILE: readonly GtmReadinessProfile[] = [
  "agentic_outbound_play",
];
const ENRICHMENT_PROFILES: readonly GtmReadinessProfile[] = [
  "agentic_outbound_play",
  "imported_dataset_enrichment",
];

export const GTM_QUESTIONS: readonly GtmQuestion[] = [
  {
    answerType: "string",
    prompt: "What do you sell, in one concrete sentence?",
    questionId: "offer.summary",
    requiredFor: OUTBOUND_PROFILE,
    requiresHumanConfirmation: false,
    section: "offer",
    sensitivity: "business",
  },
  {
    answerType: "string",
    prompt: "What measurable outcome does the offer create?",
    questionId: "offer.value_proposition",
    requiredFor: OUTBOUND_PROFILE,
    requiresHumanConfirmation: false,
    section: "offer",
    sensitivity: "business",
  },
  {
    answerType: "string_array",
    prompt: "Which customer problems are explicit buying triggers?",
    questionId: "offer.customer_problems",
    requiredFor: OUTBOUND_PROFILE,
    requiresHumanConfirmation: false,
    section: "offer",
    sensitivity: "business",
  },
  {
    answerType: "string_array",
    prompt: "Which proof points may be used to qualify a prospect?",
    questionId: "offer.proof_points",
    requiredFor: OUTBOUND_PROFILE,
    requiresHumanConfirmation: false,
    section: "offer",
    sensitivity: "business",
  },
  {
    answerType: "string_array",
    prompt: "Which ICP segments are in scope?",
    questionId: "audience.segments",
    requiredFor: OUTBOUND_PROFILE,
    requiresHumanConfirmation: false,
    section: "audience",
    sensitivity: "business",
  },
  {
    answerType: "string_array",
    prompt: "Which company countries are in scope as ISO-2 codes?",
    questionId: "audience.company_countries",
    requiredFor: ENRICHMENT_PROFILES,
    requiresHumanConfirmation: false,
    section: "audience",
    sensitivity: "business",
  },
  {
    answerType: "string_array",
    prompt: "Which industries or company traits define the ICP?",
    questionId: "audience.company_traits",
    requiredFor: OUTBOUND_PROFILE,
    requiresHumanConfirmation: false,
    section: "audience",
    sensitivity: "business",
  },
  {
    answerType: "string_array",
    prompt: "Which companies or traits must always be excluded?",
    questionId: "audience.exclusions",
    requiredFor: ENRICHMENT_PROFILES,
    requiresHumanConfirmation: false,
    section: "audience",
    sensitivity: "business",
  },
  {
    answerType: "string_array",
    prompt: "Which buyer personas and responsibilities are relevant?",
    questionId: "audience.personas",
    requiredFor: OUTBOUND_PROFILE,
    requiresHumanConfirmation: false,
    section: "audience",
    sensitivity: "business",
  },
  {
    answerType: "string_array",
    prompt: "Which titles and seniorities should be selected?",
    questionId: "audience.titles",
    requiredFor: OUTBOUND_PROFILE,
    requiresHumanConfirmation: false,
    section: "audience",
    sensitivity: "business",
  },
  {
    answerType: "string_array",
    prompt: "Which observable signals count toward qualification?",
    questionId: "qualification.required_signals",
    requiredFor: ENRICHMENT_PROFILES,
    requiresHumanConfirmation: false,
    section: "qualification",
    sensitivity: "business",
  },
  {
    answerType: "number",
    prompt: "What minimum score from 0 to 100 qualifies a record?",
    questionId: "qualification.minimum_score",
    requiredFor: ENRICHMENT_PROFILES,
    requiresHumanConfirmation: false,
    section: "qualification",
    sensitivity: "business",
  },
  {
    answerType: "string_array",
    prompt: "Which data fields may Kurobara enrich?",
    questionId: "data.desired_fields",
    requiredFor: ENRICHMENT_PROFILES,
    requiresHumanConfirmation: false,
    section: "data",
    sensitivity: "policy",
  },
  {
    answerType: "string_array",
    prompt: "Which data fields or categories are prohibited?",
    questionId: "data.prohibited_fields",
    requiredFor: ENRICHMENT_PROFILES,
    requiresHumanConfirmation: true,
    section: "data",
    sensitivity: "policy",
  },
  {
    answerType: "boolean",
    prompt:
      "Have you confirmed that the admitted providers may be used for this purpose and data scope?",
    questionId: "policy.provider_rights_confirmed",
    requiredFor: ENRICHMENT_PROFILES,
    requiresHumanConfirmation: true,
    section: "policy",
    sensitivity: "policy",
  },
  {
    answerType: "number",
    prompt: "What is the maximum initial provider-credit budget?",
    questionId: "policy.initial_budget_limit",
    requiredFor: ENRICHMENT_PROFILES,
    requiresHumanConfirmation: true,
    section: "policy",
    sensitivity: "policy",
  },
  {
    answerType: "string",
    prompt: "Which canonical unit is used for the initial budget?",
    questionId: "policy.initial_budget_unit",
    requiredFor: ENRICHMENT_PROFILES,
    requiresHumanConfirmation: true,
    section: "policy",
    sensitivity: "policy",
  },
  {
    answerType: "number",
    prompt: "How many days may enriched data be retained?",
    questionId: "policy.retention_days",
    requiredFor: ENRICHMENT_PROFILES,
    requiresHumanConfirmation: true,
    section: "policy",
    sensitivity: "policy",
  },
  {
    answerType: "boolean",
    prompt: "Should this Play be allowed to prepare a private export?",
    questionId: "activation.private_export_requested",
    requiredFor: OUTBOUND_PROFILE,
    requiresHumanConfirmation: true,
    section: "activation",
    sensitivity: "policy",
  },
  {
    answerType: "boolean",
    askIf: {
      equals: true,
      questionId: "activation.private_export_requested",
    },
    prompt: "Has the private export destination been approved?",
    questionId: "policy.export_destination_approved",
    requiredFor: OUTBOUND_PROFILE,
    requiresHumanConfirmation: true,
    section: "policy",
    sensitivity: "policy",
  },
  {
    answerType: "string",
    enumValues: ["no_send"],
    prompt: "Which activation mode is approved?",
    questionId: "activation.mode",
    requiredFor: OUTBOUND_PROFILE,
    requiresHumanConfirmation: true,
    section: "activation",
    sensitivity: "policy",
  },
] as const;

const QUESTION_BY_ID = new Map(
  GTM_QUESTIONS.map((question) => [question.questionId, question])
);
const IDENTIFIER_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,254}$/u;
const FIELD_KEY_PATTERN = /^[a-z][a-z0-9_]{0,127}$/u;
const HASH_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const COUNTRY_PATTERN = /^[A-Z]{2}$/u;
const UNIT_PATTERN = /^[a-z][a-z0-9._-]{0,63}$/u;
const SENSITIVE_FIELD_PATTERN = /(email|phone|mobile|personal)/iu;
const PLAY_CAPABILITIES = new Set([
  "contacts.discover",
  "contacts.identity.reveal",
  "contacts.work-email.resolve",
  "contacts.work-email.verify",
]);
const MAX_ASSERTIONS = 128;
const MAX_LIST_ITEMS = 128;
const MAX_TEXT_LENGTH = 16_384;

export type GtmValidationIssue = Readonly<{
  code:
    | "answer-invalid"
    | "confirmation-required"
    | "context-incompatible"
    | "context-not-found"
    | "duplicate-answer"
    | "permission-missing"
    | "play-invalid"
    | "revision-conflict"
    | "workbook-not-found";
  message: string;
  questionId?: string;
}>;

export type GtmContextPlan = Readonly<{
  blockingQuestionIds: readonly string[];
  context: GtmContextDocument;
  expectedBaseRevision?: number;
  fingerprint: string;
  issues: readonly GtmValidationIssue[];
  readyFor: Readonly<Record<GtmReadinessProfile, boolean>>;
}>;

export type GtmReadiness = Readonly<{
  blockingQuestionIds: readonly string[];
  businessContext: GtmBusinessContextState;
  profile: GtmReadinessProfile;
  ready: boolean;
  remediation: readonly string[];
}>;

export type GtmContextStatus = Readonly<{
  active?: StoredGtmContextRevision;
  latest?: StoredGtmContextRevision;
  readiness: readonly GtmReadiness[];
}>;

export type GtmPlayPreview = Readonly<{
  compilation: GtmPlayCompilation;
  definition: GtmPlayDefinition;
  fingerprint: string;
  issues: readonly GtmValidationIssue[];
  lifecycle: GtmPlayLifecycle;
  requiresHumanApproval: boolean;
}>;

export type GtmWorkbookCell = Readonly<{
  confidence: number | null;
  cost: Readonly<{
    amount: number;
    basis: "estimated" | "exact";
    unit: string;
  }> | null;
  error: Readonly<{
    code: string;
    message: string;
    retryable: boolean;
  }> | null;
  fieldId: string;
  freshness: Readonly<{
    expiresAtMs: number | null;
    observedAtMs: number;
  }> | null;
  provenance: readonly string[];
  redacted: boolean;
  status: "failed" | "pending" | "running" | "skipped" | "succeeded";
  value: boolean | number | string | null;
}>;

export type GtmWorkbookPage = Readonly<{
  fields: readonly Readonly<{
    fieldId: string;
    key: string;
    label: string;
    valueType: "boolean" | "number" | "string";
  }>[];
  hasMore: boolean;
  nextAfterOrdinal: number | null;
  records: readonly Readonly<{
    cells: readonly GtmWorkbookCell[];
    ordinal: number;
    recordId: string;
    selectionReasons: readonly string[];
  }>[];
  view: GtmWorkbookView;
}>;

export type GtmIdentifierPort = Readonly<{
  nextPlayRunId(): string;
}>;

export type GtmRecipeProjectionPort = Readonly<{
  getMany(
    scope: WorkspaceScope,
    recipeApplicationId: RecipeApplicationId,
    recordIds: readonly RecordId[]
  ): Promise<readonly (ExactRecipeProjectionRow | undefined)[]>;
}>;

export type GtmServiceDependencies = Readonly<{
  clock: ClockPort;
  datasetRecords: DatasetRecordPageQueryPort;
  identifiers: GtmIdentifierPort;
  persistence: GtmPersistencePort;
  recipeProjection?: GtmRecipeProjectionPort;
}>;

export type GtmService = ReturnType<typeof createGtmService>;

const hasPermission = (actor: VerifiedApiKey, permission: string): boolean =>
  actor.permissions.includes(permission);

const actorScope = (
  actor: VerifiedApiKey
): Readonly<{ workspaceId: WorkspaceId }> => ({
  workspaceId: actor.workspaceId,
});

const normalizedStrings = (
  value: unknown,
  maximum = MAX_LIST_ITEMS
): readonly string[] | undefined => {
  if (
    !Array.isArray(value) ||
    value.length > maximum ||
    value.some(
      (entry) =>
        typeof entry !== "string" ||
        entry.trim().length === 0 ||
        entry.length > MAX_TEXT_LENGTH
    )
  ) {
    return;
  }
  return [...new Set(value.map((entry) => entry.trim()))].sort();
};

const isAnswerValueValid = (question: GtmQuestion, value: unknown): boolean => {
  if (question.answerType === "boolean") {
    return typeof value === "boolean";
  }
  if (question.answerType === "number") {
    return typeof value === "number" && Number.isFinite(value) && value >= 0;
  }
  if (question.answerType === "string") {
    return (
      typeof value === "string" &&
      value.trim().length > 0 &&
      value.length <= MAX_TEXT_LENGTH &&
      (question.enumValues === undefined ||
        question.enumValues.includes(value.trim()))
    );
  }
  return normalizedStrings(value) !== undefined;
};

const validateAssertion = (
  assertion: GtmContextAssertion
): readonly GtmValidationIssue[] => {
  const question = QUESTION_BY_ID.get(assertion.questionId);
  if (question === undefined) {
    return [
      {
        code: "answer-invalid",
        message: "The answer references an unknown questionnaire item.",
        questionId: assertion.questionId,
      },
    ];
  }
  if (
    !Number.isSafeInteger(assertion.provenance.recordedAtMs) ||
    assertion.provenance.recordedAtMs < 0
  ) {
    return [
      {
        code: "answer-invalid",
        message: "Answer provenance must contain a valid timestamp.",
        questionId: assertion.questionId,
      },
    ];
  }
  if (assertion.state === "unknown" || assertion.state === "not_applicable") {
    return assertion.value === undefined
      ? []
      : [
          {
            code: "answer-invalid",
            message: "Unknown and not-applicable answers cannot carry a value.",
            questionId: assertion.questionId,
          },
        ];
  }
  if (!isAnswerValueValid(question, assertion.value)) {
    return [
      {
        code: "answer-invalid",
        message: "The answer value does not match the canonical answer schema.",
        questionId: assertion.questionId,
      },
    ];
  }
  if (
    question.requiresHumanConfirmation &&
    (assertion.state !== "confirmed" || assertion.provenance.source !== "human")
  ) {
    return [
      {
        code: "confirmation-required",
        message:
          "This policy answer requires explicit human confirmation and cannot be inferred by an agent.",
        questionId: assertion.questionId,
      },
    ];
  }
  return [];
};

const blockingQuestionsFor = (
  document: GtmContextDocument,
  profile: GtmReadinessProfile
): readonly string[] => {
  if (profile === "offline_fixture" || profile === "dataset_import") {
    return [];
  }
  const answerById = new Map(
    document.assertions.map((answer) => [answer.questionId, answer])
  );
  return GTM_QUESTIONS.filter((question) =>
    question.requiredFor.includes(profile)
  )
    .filter((question) => {
      if (question.askIf === undefined) {
        return true;
      }
      const prerequisite = answerById.get(question.askIf.questionId);
      return prerequisite?.value === question.askIf.equals;
    })
    .filter((question) => {
      const answer = answerById.get(question.questionId);
      return (
        answer === undefined ||
        answer.state === "unknown" ||
        answer.state === "imported_unverified" ||
        (question.requiresHumanConfirmation &&
          (answer.state !== "confirmed" ||
            answer.provenance.source !== "human"))
      );
    })
    .map((question) => question.questionId);
};

const contextReadiness = (
  revision: StoredGtmContextRevision | undefined,
  latest: StoredGtmContextRevision | undefined,
  profile: GtmReadinessProfile
): GtmReadiness => {
  if (profile === "offline_fixture" || profile === "dataset_import") {
    let businessContext: GtmBusinessContextState = "ready";
    if (revision === undefined) {
      businessContext = latest === undefined ? "missing" : "draft";
    }
    return {
      blockingQuestionIds: [],
      businessContext,
      profile,
      ready: true,
      remediation: [],
    };
  }
  if (revision === undefined) {
    return {
      blockingQuestionIds: [],
      businessContext: latest === undefined ? "missing" : "draft",
      profile,
      ready: false,
      remediation: [
        latest === undefined
          ? "Create and explicitly activate a GTM Context revision."
          : "Explicitly activate the reviewed GTM Context revision.",
      ],
    };
  }
  if (revision.document.questionnaireVersion !== GTM_QUESTIONNAIRE_VERSION) {
    return {
      blockingQuestionIds: [],
      businessContext: "stale",
      profile,
      ready: false,
      remediation: [
        `Revalidate the active context with questionnaire ${GTM_QUESTIONNAIRE_VERSION}.`,
      ],
    };
  }
  if (
    validateContextDocument(revision.document).some(
      (issue) => issue.code !== "confirmation-required"
    )
  ) {
    return {
      blockingQuestionIds: [],
      businessContext: "incompatible",
      profile,
      ready: false,
      remediation: [
        "Create a new GTM Context revision from the canonical questionnaire.",
      ],
    };
  }
  const blockingQuestionIds = blockingQuestionsFor(revision.document, profile);
  return {
    blockingQuestionIds,
    businessContext: blockingQuestionIds.length === 0 ? "ready" : "incomplete",
    profile,
    ready: blockingQuestionIds.length === 0,
    remediation: blockingQuestionIds.map(
      (questionId) => `Resolve and confirm ${questionId}.`
    ),
  };
};

const validateContextDocument = (
  document: GtmContextDocument
): readonly GtmValidationIssue[] => {
  const issues: GtmValidationIssue[] = [];
  if (
    !IDENTIFIER_PATTERN.test(document.contextId) ||
    document.name.trim().length === 0 ||
    document.name.length > 255 ||
    document.questionnaireVersion !== GTM_QUESTIONNAIRE_VERSION ||
    document.assertions.length > MAX_ASSERTIONS
  ) {
    issues.push({
      code: "context-incompatible",
      message:
        "The context identity, name, questionnaire version, or answer count is incompatible.",
    });
  }
  const seen = new Set<string>();
  for (const assertion of document.assertions) {
    if (seen.has(assertion.questionId)) {
      issues.push({
        code: "duplicate-answer",
        message: "A questionnaire item may be answered only once.",
        questionId: assertion.questionId,
      });
    } else {
      seen.add(assertion.questionId);
    }
    issues.push(...validateAssertion(assertion));
  }
  return issues;
};

const readyForMap = (
  document: GtmContextDocument
): Readonly<Record<GtmReadinessProfile, boolean>> => ({
  agentic_outbound_play:
    blockingQuestionsFor(document, "agentic_outbound_play").length === 0,
  dataset_import: true,
  imported_dataset_enrichment:
    blockingQuestionsFor(document, "imported_dataset_enrichment").length === 0,
  offline_fixture: true,
});

const planContext = (
  document: GtmContextDocument,
  expectedBaseRevision?: number
): GtmContextPlan => {
  const issues = validateContextDocument(document);
  const blockingQuestionIds = [
    ...new Set(
      (
        ["agentic_outbound_play", "imported_dataset_enrichment"] as const
      ).flatMap((profile) => blockingQuestionsFor(document, profile))
    ),
  ].sort();
  const fingerprint = String(
    canonicalContentHash({
      context: document,
      expectedBaseRevision: expectedBaseRevision ?? null,
      questionnaireVersion: GTM_QUESTIONNAIRE_VERSION,
    })
  );
  return {
    blockingQuestionIds,
    context: document,
    ...(expectedBaseRevision === undefined ? {} : { expectedBaseRevision }),
    fingerprint,
    issues,
    readyFor: readyForMap(document),
  };
};

const effectiveEnrichmentStageCount = (
  definition: GtmPlayDefinition
): number => {
  const requested = new Set(definition.capabilities);
  if (
    requested.has("contacts.work-email.resolve") ||
    requested.has("contacts.work-email.verify")
  ) {
    requested.add("contacts.identity.reveal");
  }
  if (requested.has("contacts.work-email.verify")) {
    requested.add("contacts.work-email.resolve");
  }
  return [
    "contacts.identity.reveal",
    "contacts.work-email.resolve",
    "contacts.work-email.verify",
  ].filter((capability) => requested.has(capability)).length;
};

const requiredProviderCallsFor = (definition: GtmPlayDefinition): number =>
  (definition.source.kind === "organization_search" ? 1 : 0) +
  1 +
  definition.preview.maxContactsTotal *
    effectiveEnrichmentStageCount(definition);

const validatePlayDefinition = (
  definition: GtmPlayDefinition
): readonly GtmValidationIssue[] => {
  const issues: GtmValidationIssue[] = [];
  const effectiveEnrichmentStages = effectiveEnrichmentStageCount(definition);
  const requiredProviderCalls = requiredProviderCallsFor(definition);
  if (
    !(
      IDENTIFIER_PATTERN.test(definition.playId) &&
      IDENTIFIER_PATTERN.test(definition.authorityEnvelopeId) &&
      IDENTIFIER_PATTERN.test(definition.contextRef.contextId) &&
      HASH_PATTERN.test(definition.contextRef.fingerprint) &&
      Number.isSafeInteger(definition.contextRef.revision)
    ) ||
    definition.contextRef.revision < 1 ||
    definition.objective.text.trim().length === 0 ||
    definition.objective.metric.trim().length === 0 ||
    !Number.isFinite(definition.objective.target) ||
    definition.objective.target <= 0 ||
    !Number.isFinite(definition.budget.limit) ||
    definition.budget.limit <= 0 ||
    !UNIT_PATTERN.test(definition.budget.unit) ||
    !Number.isSafeInteger(definition.deadlineMs) ||
    definition.deadlineMs < 0 ||
    definition.delivery.mode !== "no_send" ||
    definition.capabilities.length === 0 ||
    new Set(definition.capabilities).size !== definition.capabilities.length ||
    definition.capabilities.some(
      (capability) => !PLAY_CAPABILITIES.has(capability)
    ) ||
    definition.preview.sampleSize < 1 ||
    definition.preview.sampleSize > 100 ||
    definition.preview.maxCompanies < 1 ||
    definition.preview.maxCompanies > 100 ||
    definition.preview.maxContactsPerCompany < 1 ||
    definition.preview.maxContactsPerCompany > 10 ||
    definition.preview.maxContactsTotal < 1 ||
    definition.preview.maxContactsTotal > 1000 ||
    definition.preview.maxProviderCalls < 0 ||
    definition.preview.maxProviderCalls > 1000 ||
    definition.preview.maxProviderCalls < requiredProviderCalls ||
    (definition.budget.unit === "requests" &&
      definition.budget.limit < requiredProviderCalls) ||
    (effectiveEnrichmentStages > 0 &&
      definition.preview.maxContactsTotal > 3) ||
    definition.selection.minimumScore < 0 ||
    definition.selection.minimumScore > 100 ||
    definition.selection.minimumScore !== 0 ||
    definition.selection.requiredSignals.length > 0
  ) {
    issues.push({
      code: "play-invalid",
      message:
        "The Play violates an identity, authority, objective, capability, budget, deadline, no-send, provider-call, preview, or selection bound.",
    });
  }
  if (
    definition.source.kind === "organization_search" &&
    (definition.source.countries.length === 0 ||
      definition.source.countries.some(
        (country) => !COUNTRY_PATTERN.test(country)
      ))
  ) {
    issues.push({
      code: "play-invalid",
      message:
        "Organization search requires at least one canonical ISO-2 country.",
    });
  }
  if (
    definition.source.kind === "imported_dataset" &&
    !(
      IDENTIFIER_PATTERN.test(definition.source.datasetId) &&
      IDENTIFIER_PATTERN.test(definition.source.materializationId) &&
      FIELD_KEY_PATTERN.test(definition.source.fieldMapping.domain)
    )
  ) {
    issues.push({
      code: "play-invalid",
      message:
        "Imported dataset Plays require bounded dataset, materialization, and domain-field identities.",
    });
  }
  return issues;
};

const permissionsForCapability = (capability: string): readonly string[] => {
  if (capability === "contacts.discover") {
    return ["contacts:discover", "datasets:generate", "plans:quote"];
  }
  if (capability === "contacts.identity.reveal") {
    return [
      "contacts:enrich",
      "datasets:generate",
      "plans:quote",
      "steps:execute",
    ];
  }
  if (
    capability === "contacts.work-email.resolve" ||
    capability === "contacts.work-email.verify"
  ) {
    return [
      "contacts:enrich",
      "datasets:generate",
      "plans:quote",
      "steps:execute",
    ];
  }
  return ["datasets:generate", "plans:quote"];
};

const compilePlay = (definition: GtmPlayDefinition): GtmPlayCompilation => {
  const requiredProviderCalls = requiredProviderCallsFor(definition);
  const sourceOperation =
    definition.source.kind === "organization_search"
      ? "organizations.discover"
      : "contacts.discover";
  const requestedCapabilities = new Set(definition.capabilities);
  if (
    requestedCapabilities.has("contacts.work-email.resolve") ||
    requestedCapabilities.has("contacts.work-email.verify")
  ) {
    requestedCapabilities.add("contacts.identity.reveal");
  }
  if (requestedCapabilities.has("contacts.work-email.verify")) {
    requestedCapabilities.add("contacts.work-email.resolve");
  }
  const enrichmentOperationIds = [
    "contacts.identity.reveal",
    "contacts.work-email.resolve",
    "contacts.work-email.verify",
  ].filter((operationId) => requestedCapabilities.has(operationId));
  const operationIds = [
    sourceOperation,
    ...(definition.source.kind === "organization_search"
      ? ["contacts.discover"]
      : []),
    ...enrichmentOperationIds,
    "workbooks.project",
  ];
  const stages = operationIds.map((operationId, index) => ({
    ...(operationId.startsWith("contacts.") ? { capability: operationId } : {}),
    inputFingerprint: String(
      canonicalContentHash({
        contextRef: definition.contextRef,
        operationId,
        ordinal: index + 1,
        playId: definition.playId,
        source: definition.source,
      })
    ),
    operationId,
    ordinal: index + 1,
  }));
  const permissions = [
    ...new Set([
      ...(definition.source.kind === "organization_search"
        ? ["datasets:generate", "plans:quote"]
        : ["datasets:read"]),
      ...definition.capabilities.flatMap(permissionsForCapability),
      "plays:execute",
      "workbooks:read",
      "workbooks:write",
      ...(definition.delivery.privateExport
        ? ["contacts:export", "datasets:export"]
        : []),
    ]),
  ].sort();
  const humanGates = [
    ...(definition.preview.maxProviderCalls > 0 ? ["provider_spend"] : []),
    ...(definition.capabilities.some(
      (capability) =>
        capability === "contacts.identity.reveal" ||
        capability.includes("work-email")
    )
      ? ["sensitive_data_reveal"]
      : []),
    ...(definition.delivery.privateExport ? ["private_export"] : []),
  ];
  return {
    assumptions: [
      "Provider routes are selected only from the admitted capability catalog at execution time.",
      definition.budget.unit === "requests"
        ? "The preview upper bound is the exact provider-request ceiling implied by the approved cardinality and capability chain."
        : "The preview upper bound is the human-approved budget cap because no provider-free conversion from requests to this unit is available; each execution stage records its admitted quote and settled cost.",
      definition.broadening === "forbidden"
        ? "Audience broadening is forbidden."
        : "Audience broadening requires a new human approval.",
    ],
    authority: { humanGates, permissions },
    budget: {
      limit: definition.budget.limit,
      quotedUpperBound:
        definition.budget.unit === "requests"
          ? requiredProviderCalls
          : definition.budget.limit,
      unit: definition.budget.unit,
    },
    deadlineMs: definition.deadlineMs,
    exportMode: "no_send",
    intentionHash: String(canonicalContentHash(definition)),
    stages,
  };
};

const playGateIsApproved = (
  definition: GtmPlayDefinition,
  gate: string
): boolean => {
  if (gate === "provider_spend") {
    return definition.approvals.providerSpend;
  }
  if (gate === "sensitive_data_reveal") {
    return definition.approvals.reveal;
  }
  if (gate === "private_export") {
    return definition.approvals.export;
  }
  return false;
};

const initialPlayRunExecution = (
  definition: GtmPlayDefinition,
  compilation: GtmPlayCompilation
): import("@kurobara/ports").GtmPlayRunExecution => ({
  cost: {
    reserved: 0,
    spent: 0,
    unit: definition.budget.unit,
  },
  providerCalls: 0,
  provenance: [],
  selectedRecordIds: [],
  selectionReasons: [],
  stages: compilation.stages.map((stage) => ({
    cost: {
      reserved: 0,
      spent: 0,
      unit: definition.budget.unit,
    },
    operationId: stage.operationId,
    ordinal: stage.ordinal,
    providerCalls: 0,
    state: "pending",
  })),
});

const previewFingerprint = (
  definition: GtmPlayDefinition,
  compilation: GtmPlayCompilation
): string =>
  String(
    canonicalContentHash({
      compilation,
      definition,
      previewVersion: "1.0.0",
    })
  );

const toWorkbookCell = (
  field: Readonly<{ fieldId: string; key: string }>,
  value: boolean | number | string | null,
  materialization: Readonly<{
    completedAt?: number;
    contentHash?: string;
    materializationId: string;
  }>,
  canReadSensitive: boolean
): GtmWorkbookCell => {
  const redacted = !canReadSensitive && SENSITIVE_FIELD_PATTERN.test(field.key);
  return {
    confidence: null,
    cost: null,
    error: null,
    fieldId: field.fieldId,
    freshness:
      materialization.completedAt === undefined
        ? null
        : {
            expiresAtMs: null,
            observedAtMs: Number(materialization.completedAt),
          },
    provenance: [
      `dataset-materialization:${materialization.materializationId}`,
      ...(materialization.contentHash === undefined
        ? []
        : [String(materialization.contentHash)]),
    ],
    redacted,
    status: "succeeded",
    value: redacted ? null : value,
  };
};

const toRecipeWorkbookCell = (
  field: Readonly<{ fieldId: string; key: string }>,
  result: CellResult,
  canReadSensitive: boolean
): GtmWorkbookCell => {
  const redacted = !canReadSensitive && SENSITIVE_FIELD_PATTERN.test(field.key);
  return {
    confidence: result.confidence ?? null,
    cost: result.cost ?? null,
    error: result.reason ?? null,
    fieldId: field.fieldId,
    freshness:
      result.freshness === undefined
        ? null
        : {
            expiresAtMs:
              result.freshness.expiresAt === undefined
                ? null
                : Number(result.freshness.expiresAt),
            observedAtMs: Number(result.freshness.observedAt),
          },
    provenance: [
      `cell-result:${result.cellResultId}`,
      ...(result.provenance?.references ?? []),
    ],
    redacted,
    status: result.status,
    value:
      redacted || result.status !== "succeeded" ? null : (result.value ?? null),
  };
};

export const createGtmService = (dependencies: GtmServiceDependencies) => {
  const questionnaire = (): readonly GtmQuestion[] =>
    GTM_QUESTIONS.map((question) => ({
      ...question,
      requiredFor: [...question.requiredFor],
      ...(question.enumValues === undefined
        ? {}
        : { enumValues: [...question.enumValues] }),
      ...(question.askIf === undefined ? {} : { askIf: { ...question.askIf } }),
    }));

  const status = async (actor: VerifiedApiKey): Promise<GtmContextStatus> => {
    const scope = actorScope(actor);
    const [active, latest] = await Promise.all([
      dependencies.persistence.getActiveContext(scope),
      dependencies.persistence.getLatestContext(scope),
    ]);
    return {
      ...(active === undefined ? {} : { active }),
      ...(latest === undefined ? {} : { latest }),
      readiness: (
        [
          "offline_fixture",
          "dataset_import",
          "imported_dataset_enrichment",
          "agentic_outbound_play",
        ] as const
      ).map((profile) => contextReadiness(active, latest, profile)),
    };
  };

  const applyContext = async (
    actor: VerifiedApiKey,
    input: Readonly<{
      activate: boolean;
      confirmActiveChange: boolean;
      confirmed: boolean;
      document: GtmContextDocument;
      expectedBaseRevision?: number;
      planFingerprint: string;
    }>
  ): Promise<
    | Readonly<{ issues: readonly GtmValidationIssue[]; ok: false }>
    | Readonly<{
        active: boolean;
        ok: true;
        revision: StoredGtmContextRevision;
        status: "created" | "existing";
      }>
  > => {
    if (!hasPermission(actor, "contexts:write")) {
      return {
        issues: [
          {
            code: "permission-missing",
            message: "The API key does not grant contexts:write.",
          },
        ],
        ok: false,
      };
    }
    const plan = planContext(input.document, input.expectedBaseRevision);
    const issues = [...plan.issues];
    if (!input.confirmed || input.planFingerprint !== plan.fingerprint) {
      issues.push({
        code: "confirmation-required",
        message:
          "Applying a context requires the exact reviewed plan fingerprint and explicit confirmation.",
      });
    }
    const current = await dependencies.persistence.getActiveContext(
      actorScope(actor)
    );
    if (
      input.activate &&
      current !== undefined &&
      (current.contextId !== input.document.contextId ||
        current.fingerprint !== plan.fingerprint) &&
      !input.confirmActiveChange
    ) {
      issues.push({
        code: "confirmation-required",
        message:
          "Changing the active context requires a separate explicit confirmation.",
      });
    }
    if (issues.length > 0) {
      return { issues, ok: false };
    }
    const createdAtMs = Number(await dependencies.clock.now());
    const stored = await dependencies.persistence.putContextRevision(
      actorScope(actor),
      {
        createdAtMs,
        createdByActorId: actor.actorId,
        document: input.document,
        ...(input.expectedBaseRevision === undefined
          ? {}
          : { expectedBaseRevision: input.expectedBaseRevision }),
        fingerprint: plan.fingerprint,
      }
    );
    if (stored.status === "conflict") {
      return {
        issues: [
          {
            code: "revision-conflict",
            message:
              "The context base revision changed; inspect and re-plan before applying.",
          },
        ],
        ok: false,
      };
    }
    if (input.activate) {
      await dependencies.persistence.activateContext(
        actorScope(actor),
        stored.revision
      );
    }
    return {
      active: input.activate,
      ok: true,
      revision: stored.revision,
      status: stored.status,
    };
  };

  const previewPlay = async (
    actor: VerifiedApiKey,
    definition: GtmPlayDefinition
  ): Promise<GtmPlayPreview> => {
    const issues = [...validatePlayDefinition(definition)];
    const context = await dependencies.persistence.getContextRevision(
      actorScope(actor),
      definition.contextRef.contextId,
      definition.contextRef.revision
    );
    if (
      context === undefined ||
      context.fingerprint !== definition.contextRef.fingerprint
    ) {
      issues.push({
        code: "context-not-found",
        message:
          "The Play must pin an exact context revision in the authenticated workspace.",
      });
    } else if (
      blockingQuestionsFor(context.document, "agentic_outbound_play").length > 0
    ) {
      issues.push({
        code: "context-incompatible",
        message:
          "The pinned context is not ready for an agentic outbound Play.",
      });
    }
    const compilation = compilePlay(definition);
    for (const permission of compilation.authority.permissions) {
      if (!hasPermission(actor, permission)) {
        issues.push({
          code: "permission-missing",
          message: `The API key does not grant ${permission}.`,
        });
      }
    }
    const fingerprint = previewFingerprint(definition, compilation);
    let lifecycle: GtmPlayLifecycle = "draft";
    if (issues.length === 0) {
      lifecycle =
        compilation.authority.humanGates.length === 0
          ? "previewed"
          : "awaiting_approval";
    }
    return {
      compilation,
      definition,
      fingerprint,
      issues,
      lifecycle,
      requiresHumanApproval: compilation.authority.humanGates.length > 0,
    };
  };

  const applyPlay = async (
    actor: VerifiedApiKey,
    input: Readonly<{
      action: "approve" | "pause" | "retire" | "start";
      approvedByHuman: boolean;
      definition: GtmPlayDefinition;
      expectedBaseRevision?: number;
      idempotencyKey: string;
      previewFingerprint: string;
    }>
  ): Promise<
    | Readonly<{ issues: readonly GtmValidationIssue[]; ok: false }>
    | Readonly<{
        ok: true;
        revision: StoredGtmPlayRevision;
        run?: StoredGtmPlayRun;
      }>
    // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: This application boundary keeps permission, fingerprint, human-gate, revision, and idempotency checks visible in one transaction flow.
  > => {
    if (!hasPermission(actor, "plays:write")) {
      return {
        issues: [
          {
            code: "permission-missing",
            message: "The API key does not grant plays:write.",
          },
        ],
        ok: false,
      };
    }
    const preview = await previewPlay(actor, input.definition);
    const issues = [...preview.issues];
    if (preview.fingerprint !== input.previewFingerprint) {
      issues.push({
        code: "play-invalid",
        message:
          "The applied Play does not match the exact reviewed preview fingerprint.",
      });
    }
    const approvalAction =
      input.action === "approve" || input.action === "start";
    if (
      approvalAction &&
      preview.requiresHumanApproval &&
      (!input.approvedByHuman ||
        preview.compilation.authority.humanGates.some(
          (gate) => !playGateIsApproved(input.definition, gate)
        ))
    ) {
      issues.push({
        code: "confirmation-required",
        message:
          "Provider spend, sensitive reveal, or export gates require matching Play approvals and explicit human confirmation.",
      });
    }
    if (
      !IDENTIFIER_PATTERN.test(input.idempotencyKey) ||
      (input.action === "start" && !hasPermission(actor, "plays:execute"))
    ) {
      issues.push({
        code: input.action === "start" ? "permission-missing" : "play-invalid",
        message:
          input.action === "start"
            ? "The API key does not grant plays:execute."
            : "The Play idempotency key is invalid.",
      });
    }
    if (issues.length > 0) {
      return { issues, ok: false };
    }
    const createdAtMs = Number(await dependencies.clock.now());
    const lifecycleByAction: Readonly<
      Record<typeof input.action, GtmPlayLifecycle>
    > = {
      approve: "approved",
      pause: "paused",
      retire: "retired",
      start: "active",
    };
    const lifecycle = lifecycleByAction[input.action];
    const revisionResult = await dependencies.persistence.putPlayRevision(
      actorScope(actor),
      {
        compilation: preview.compilation,
        createdAtMs,
        createdByActorId: actor.actorId,
        definition: input.definition,
        ...(input.expectedBaseRevision === undefined
          ? {}
          : { expectedBaseRevision: input.expectedBaseRevision }),
        fingerprint: preview.fingerprint,
        lifecycle,
      }
    );
    if (revisionResult.status === "conflict") {
      return {
        issues: [
          {
            code: "revision-conflict",
            message:
              "The Play base revision changed; preview the latest revision before applying.",
          },
        ],
        ok: false,
      };
    }
    if (input.action !== "start") {
      return { ok: true, revision: revisionResult.revision };
    }
    const runResult = await dependencies.persistence.createPlayRun(
      actorScope(actor),
      {
        compilation: preview.compilation,
        createdAtMs,
        definition: input.definition,
        execution: initialPlayRunExecution(
          input.definition,
          preview.compilation
        ),
        executionActor: {
          actorId: actor.actorId,
          authenticationMode: actor.authenticationMode,
          permissions: actor.permissions,
        },
        idempotencyKey: input.idempotencyKey,
        playId: input.definition.playId,
        playRevision: revisionResult.revision.revision,
        runId: dependencies.identifiers.nextPlayRunId(),
      }
    );
    if (runResult.status === "conflict") {
      return {
        issues: [
          {
            code: "revision-conflict",
            message:
              "The idempotency key is already bound to a different Play intention.",
          },
        ],
        ok: false,
      };
    }
    return {
      ok: true,
      revision: revisionResult.revision,
      run: runResult.run,
    };
  };

  const getWorkbook = async (
    actor: VerifiedApiKey,
    input: Readonly<{
      afterOrdinal: number;
      datasetId: DatasetId;
      limit: number;
      materializationId: DatasetMaterializationId;
      workbookId: string;
    }>
  ): Promise<
    | Readonly<{ issues: readonly GtmValidationIssue[]; ok: false }>
    | Readonly<{ ok: true; page: GtmWorkbookPage }>
    // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: The projection boundary validates one immutable page, overlays exact recipe evidence, and then verifies the result without hidden I/O.
  > => {
    if (!hasPermission(actor, "workbooks:read")) {
      return {
        issues: [
          {
            code: "permission-missing",
            message: "The API key does not grant workbooks:read.",
          },
        ],
        ok: false,
      };
    }
    const scope = actorScope(actor);
    const [storedView, page] = await Promise.all([
      dependencies.persistence.getWorkbookView(scope, input.workbookId),
      dependencies.datasetRecords.listPage(scope, {
        afterOrdinal: input.afterOrdinal,
        datasetId: input.datasetId,
        limit: input.limit,
        materializationId: input.materializationId,
      }),
    ]);
    if (
      page === undefined ||
      page.dataset.workspaceId !== actor.workspaceId ||
      page.dataset.datasetId !== input.datasetId ||
      page.materialization.workspaceId !== actor.workspaceId ||
      page.materialization.datasetId !== input.datasetId ||
      page.materialization.materializationId !== input.materializationId ||
      page.fields.some(
        (field) =>
          field.workspaceId !== actor.workspaceId ||
          field.datasetId !== input.datasetId
      ) ||
      page.items.some(
        ({ record }) =>
          record.workspaceId !== actor.workspaceId ||
          record.datasetId !== input.datasetId
      )
    ) {
      return {
        issues: [
          {
            code: "workbook-not-found",
            message:
              "The requested ready dataset materialization is unavailable in this workspace.",
          },
        ],
        ok: false,
      };
    }
    const view: GtmWorkbookView =
      storedView ??
      ({
        annotations: [],
        approvals: [],
        columnOrder: page.fields.map((field) => field.key),
        datasetId: page.dataset.datasetId,
        filters: [],
        materializationId: page.materialization.materializationId,
        name: page.dataset.name,
        revision: 0,
        selectionReasons: [],
        selectedRecordIds: [],
        workbookId: input.workbookId,
        workspaceId: actor.workspaceId,
      } as const);
    if (
      view.datasetId !== input.datasetId ||
      view.materializationId !== input.materializationId
    ) {
      return {
        issues: [
          {
            code: "workbook-not-found",
            message:
              "The saved Workbook is bound to another immutable dataset materialization.",
          },
        ],
        ok: false,
      };
    }
    const recipeRows =
      view.recipeApplicationId === undefined ||
      dependencies.recipeProjection === undefined
        ? []
        : await dependencies.recipeProjection.getMany(
            scope,
            view.recipeApplicationId,
            page.items.map(({ record }) => record.recordId)
          );
    const recipeRowByRecordId = new Map(
      recipeRows
        .filter((row) => row !== undefined)
        .map((row) => [String(row.record.recordId), row])
    );
    const selectionReasonByRecordId = new Map(
      view.selectionReasons.map((selection) => [
        selection.recordId,
        selection.reasons,
      ])
    );
    const canReadSensitive = hasPermission(actor, "contacts:enrich");
    const fieldById = new Map(
      page.fields.map((field) => [String(field.fieldId), field])
    );
    for (const row of recipeRowByRecordId.values()) {
      if (
        row.application.datasetId !== view.datasetId ||
        row.cellResult.datasetId !== view.datasetId ||
        row.cellResult.recordId !== row.record.recordId ||
        !fieldById.has(String(row.cellResult.fieldId))
      ) {
        throw new Error("Workbook recipe projection is inconsistent.");
      }
    }
    const records = page.items.map(({ ordinal, record }) => ({
      cells: page.fields.map((field) => {
        const recipeRow = recipeRowByRecordId.get(String(record.recordId));
        if (
          recipeRow !== undefined &&
          recipeRow.cellResult.fieldId === field.fieldId
        ) {
          return toRecipeWorkbookCell(
            { fieldId: String(field.fieldId), key: field.key },
            recipeRow.cellResult,
            canReadSensitive
          );
        }
        const recordValue = record.values.find(
          (candidate) => candidate.fieldId === field.fieldId
        );
        return toWorkbookCell(
          { fieldId: String(field.fieldId), key: field.key },
          recordValue?.value ?? null,
          {
            ...(page.materialization.completedAt === undefined
              ? {}
              : { completedAt: Number(page.materialization.completedAt) }),
            ...(page.materialization.contentHash === undefined
              ? {}
              : { contentHash: String(page.materialization.contentHash) }),
            materializationId: String(page.materialization.materializationId),
          },
          canReadSensitive
        );
      }),
      ordinal,
      recordId: String(record.recordId),
      selectionReasons:
        selectionReasonByRecordId.get(String(record.recordId)) ?? [],
    }));
    for (const record of records) {
      for (const cell of record.cells) {
        if (!fieldById.has(cell.fieldId)) {
          throw new Error("Workbook projection produced an unknown field.");
        }
      }
    }
    return {
      ok: true,
      page: {
        fields: page.fields.map((field) => ({
          fieldId: String(field.fieldId),
          key: field.key,
          label: field.label,
          valueType: field.valueType,
        })),
        hasMore: page.hasMore,
        nextAfterOrdinal:
          page.hasMore && records.length > 0
            ? (records.at(-1)?.ordinal ?? null)
            : null,
        records,
        view,
      },
    };
  };

  const saveWorkbook = async (
    actor: VerifiedApiKey,
    input: GtmWorkbookViewWrite
  ): Promise<
    | Readonly<{ issues: readonly GtmValidationIssue[]; ok: false }>
    | Readonly<{ ok: true; view: GtmWorkbookView }>
  > => {
    if (!hasPermission(actor, "workbooks:write")) {
      return {
        issues: [
          {
            code: "permission-missing",
            message: "The API key does not grant workbooks:write.",
          },
        ],
        ok: false,
      };
    }
    if (
      !IDENTIFIER_PATTERN.test(input.workbookId) ||
      input.name.trim().length === 0 ||
      input.name.length > 255 ||
      input.columnOrder.length > 256 ||
      input.filters.length > 128 ||
      input.selectedRecordIds.length > 1000 ||
      input.selectionReasons.length > 1000 ||
      input.annotations.length > 1000 ||
      input.approvals.length > 1000 ||
      new Set(input.columnOrder).size !== input.columnOrder.length ||
      new Set(input.selectedRecordIds).size !==
        input.selectedRecordIds.length ||
      new Set(input.selectionReasons.map(({ recordId }) => recordId)).size !==
        input.selectionReasons.length ||
      (input.recipeApplicationId !== undefined &&
        !IDENTIFIER_PATTERN.test(input.recipeApplicationId)) ||
      input.selectionReasons.some(
        (selection) =>
          !input.selectedRecordIds.includes(selection.recordId) ||
          selection.reasons.length === 0 ||
          selection.reasons.length > 32 ||
          selection.reasons.some(
            (reason) =>
              reason.trim().length === 0 || reason.length > MAX_TEXT_LENGTH
          )
      )
    ) {
      return {
        issues: [
          {
            code: "play-invalid",
            message:
              "The Workbook identity, name, columns, selections, annotations, or approvals exceed public bounds.",
          },
        ],
        ok: false,
      };
    }
    const scope = actorScope(actor);
    const current = await dependencies.persistence.getWorkbookView(
      scope,
      input.workbookId
    );
    if (
      current !== undefined &&
      (current.datasetId !== input.datasetId ||
        current.materializationId !== input.materializationId)
    ) {
      return {
        issues: [
          {
            code: "workbook-not-found",
            message:
              "A Workbook cannot be rebound to another immutable dataset materialization.",
          },
        ],
        ok: false,
      };
    }
    const priorAnnotations = current?.annotations ?? [];
    const priorApprovals = current?.approvals ?? [];
    const preservesHistory =
      canonicalContentHash(
        input.annotations.slice(0, priorAnnotations.length)
      ) === canonicalContentHash(priorAnnotations) &&
      canonicalContentHash(input.approvals.slice(0, priorApprovals.length)) ===
        canonicalContentHash(priorApprovals);
    if (!preservesHistory) {
      return {
        issues: [
          {
            code: "play-invalid",
            message: "Workbook annotation and approval history is append-only.",
          },
        ],
        ok: false,
      };
    }
    const createdAtMs = Number(await dependencies.clock.now());
    const canonicalInput: GtmWorkbookViewWrite = {
      ...input,
      annotations: [
        ...priorAnnotations,
        ...input.annotations
          .slice(priorAnnotations.length)
          .map((annotation) => ({
            ...annotation,
            createdAtMs,
            createdByActorId: actor.actorId,
          })),
      ],
      approvals: [
        ...priorApprovals,
        ...input.approvals.slice(priorApprovals.length).map((approval) => ({
          ...approval,
          createdAtMs,
          createdByActorId: actor.actorId,
        })),
      ],
    };
    const result = await dependencies.persistence.putWorkbookView(
      scope,
      canonicalInput
    );
    return result.status === "conflict"
      ? {
          issues: [
            {
              code: "revision-conflict",
              message:
                "The Workbook view changed; inspect its latest revision before saving.",
            },
          ],
          ok: false,
        }
      : { ok: true, view: result.view };
  };

  return {
    applyContext,
    applyPlay,
    getPlayRevision: (
      actor: VerifiedApiKey,
      playId: string,
      revision?: number
    ) =>
      dependencies.persistence.getPlayRevision(
        actorScope(actor),
        playId,
        revision
      ),
    getPlayRun: (actor: VerifiedApiKey, runId: string) =>
      dependencies.persistence.getPlayRun(actorScope(actor), runId),
    getWorkbook,
    planContext,
    previewPlay,
    questionnaire,
    saveWorkbook,
    status,
  } as const;
};

export type GtmServiceActor = Readonly<{
  actorId: ActorId;
  permissions: readonly string[];
  workspaceId: WorkspaceId;
}>;

export type GtmDatasetIdentity = Readonly<{
  datasetId: DatasetId;
  materializationId: DatasetMaterializationId;
}>;

export type GtmContextIdentity = Readonly<{
  contextId: string;
  reference?: GtmContextRevisionRef;
}>;
