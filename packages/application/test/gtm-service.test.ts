import assert from "node:assert/strict";
import test from "node:test";

import {
  actorId,
  cellResultId,
  contentHash,
  datasetId,
  datasetMaterializationId,
  enrichmentRecipeId,
  fieldId,
  instant,
  recordId,
  runId,
  workspaceId,
} from "@kurobara/kernel";
import type {
  DatasetRecordPage,
  DatasetRecordPageQueryPort,
  ExactRecipeProjectionRow,
  GtmContextDocument,
  GtmContextRevisionRef,
  GtmContextRevisionWrite,
  GtmContextRevisionWriteResult,
  GtmPersistencePort,
  GtmPlayDefinition,
  GtmPlayRevisionWrite,
  GtmPlayRevisionWriteResult,
  GtmPlayRunClaim,
  GtmPlayRunUpdate,
  GtmPlayRunUpdateResult,
  GtmPlayRunWrite,
  GtmPlayRunWriteResult,
  GtmWorkbookView,
  GtmWorkbookViewWrite,
  GtmWorkbookViewWriteResult,
  StoredGtmContextRevision,
  StoredGtmPlayRevision,
  StoredGtmPlayRun,
  VerifiedApiKey,
  WorkspaceScope,
} from "@kurobara/ports";

import {
  createGtmService,
  GTM_QUESTIONNAIRE_VERSION,
  GTM_QUESTIONS,
} from "../src/index.ts";

class MemoryGtmPersistence implements GtmPersistencePort {
  readonly active = new Map<string, GtmContextRevisionRef>();
  readonly contexts = new Map<string, StoredGtmContextRevision[]>();
  readonly plays = new Map<string, StoredGtmPlayRevision[]>();
  readonly runs = new Map<string, StoredGtmPlayRun>();
  readonly workbooks = new Map<string, GtmWorkbookView>();

  activateContext(
    scope: WorkspaceScope,
    reference: GtmContextRevisionRef
  ): Promise<void> {
    this.active.set(String(scope.workspaceId), reference);
    return Promise.resolve();
  }

  createPlayRun(
    scope: WorkspaceScope,
    input: GtmPlayRunWrite
  ): Promise<GtmPlayRunWriteResult> {
    const existing = [...this.runs.values()].find(
      (run) =>
        run.workspaceId === scope.workspaceId &&
        run.idempotencyKey === input.idempotencyKey
    );
    if (existing !== undefined) {
      return Promise.resolve(
        existing.playId === input.playId &&
          existing.playRevision === input.playRevision &&
          existing.compilation.intentionHash === input.compilation.intentionHash
          ? { run: existing, status: "existing" }
          : { status: "conflict" }
      );
    }
    const run: StoredGtmPlayRun = {
      compilation: input.compilation,
      createdAtMs: input.createdAtMs,
      definition: input.definition,
      execution: input.execution,
      executionActor: input.executionActor,
      idempotencyKey: input.idempotencyKey,
      playId: input.playId,
      playRevision: input.playRevision,
      revision: 1,
      runId: input.runId,
      state: "queued",
      updatedAtMs: input.createdAtMs,
      workspaceId: scope.workspaceId,
    };
    this.runs.set(`${scope.workspaceId}:${input.runId}`, run);
    return Promise.resolve({ run, status: "created" });
  }

  claimNextPlayRun(
    workerId: string,
    claimToken: string,
    nowMs: number,
    leaseMs: number
  ): Promise<GtmPlayRunClaim | undefined> {
    const run = [...this.runs.values()].find(
      (candidate) =>
        candidate.state === "queued" || candidate.state === "running"
    );
    return Promise.resolve(
      run === undefined
        ? undefined
        : {
            claimExpiresAtMs: nowMs + leaseMs,
            claimToken,
            run,
            workerId,
          }
    );
  }

  getActiveContext(
    scope: WorkspaceScope
  ): Promise<StoredGtmContextRevision | undefined> {
    const reference = this.active.get(String(scope.workspaceId));
    return reference === undefined
      ? Promise.resolve(undefined)
      : this.getContextRevision(scope, reference.contextId, reference.revision);
  }

  getContextRevision(
    scope: WorkspaceScope,
    contextId: string,
    revision?: number
  ): Promise<StoredGtmContextRevision | undefined> {
    const revisions =
      this.contexts.get(`${scope.workspaceId}:${contextId}`) ?? [];
    return Promise.resolve(
      revision === undefined
        ? revisions.at(-1)
        : revisions.find((candidate) => candidate.revision === revision)
    );
  }

  getLatestContext(
    scope: WorkspaceScope
  ): Promise<StoredGtmContextRevision | undefined> {
    return Promise.resolve(
      [...this.contexts.entries()]
        .filter(([key]) => key.startsWith(`${scope.workspaceId}:`))
        .flatMap(([, revisions]) => revisions)
        .sort((left, right) => right.createdAtMs - left.createdAtMs)
        .at(0)
    );
  }

  getPlayRevision(
    scope: WorkspaceScope,
    playId: string,
    revision?: number
  ): Promise<StoredGtmPlayRevision | undefined> {
    const revisions = this.plays.get(`${scope.workspaceId}:${playId}`) ?? [];
    return Promise.resolve(
      revision === undefined
        ? revisions.at(-1)
        : revisions.find((candidate) => candidate.revision === revision)
    );
  }

  getPlayRun(
    scope: WorkspaceScope,
    runId: string
  ): Promise<StoredGtmPlayRun | undefined> {
    return Promise.resolve(this.runs.get(`${scope.workspaceId}:${runId}`));
  }

  getWorkbookView(
    scope: WorkspaceScope,
    workbookId: string
  ): Promise<GtmWorkbookView | undefined> {
    return Promise.resolve(
      this.workbooks.get(`${scope.workspaceId}:${workbookId}`)
    );
  }

  putContextRevision(
    scope: WorkspaceScope,
    input: GtmContextRevisionWrite
  ): Promise<GtmContextRevisionWriteResult> {
    const key = `${scope.workspaceId}:${input.document.contextId}`;
    const revisions = this.contexts.get(key) ?? [];
    const latest = revisions.at(-1);
    const existing = revisions.find(
      (candidate) => candidate.fingerprint === input.fingerprint
    );
    if (existing !== undefined) {
      return Promise.resolve({ revision: existing, status: "existing" });
    }
    if (
      input.expectedBaseRevision !== undefined &&
      input.expectedBaseRevision !== (latest?.revision ?? 0)
    ) {
      return Promise.resolve({ status: "conflict" });
    }
    const revision: StoredGtmContextRevision = {
      contextId: input.document.contextId,
      createdAtMs: input.createdAtMs,
      createdByActorId: input.createdByActorId,
      document: input.document,
      fingerprint: input.fingerprint,
      revision: (latest?.revision ?? 0) + 1,
      workspaceId: scope.workspaceId,
    };
    revisions.push(revision);
    this.contexts.set(key, revisions);
    return Promise.resolve({ revision, status: "created" });
  }

  putPlayRevision(
    scope: WorkspaceScope,
    input: GtmPlayRevisionWrite
  ): Promise<GtmPlayRevisionWriteResult> {
    const key = `${scope.workspaceId}:${input.definition.playId}`;
    const revisions = this.plays.get(key) ?? [];
    const latest = revisions.at(-1);
    const existing = revisions.find(
      (candidate) =>
        candidate.fingerprint === input.fingerprint &&
        candidate.lifecycle === input.lifecycle
    );
    if (existing !== undefined) {
      return Promise.resolve({ revision: existing, status: "existing" });
    }
    if (
      input.expectedBaseRevision !== undefined &&
      input.expectedBaseRevision !== (latest?.revision ?? 0)
    ) {
      return Promise.resolve({ status: "conflict" });
    }
    const revision: StoredGtmPlayRevision = {
      compilation: input.compilation,
      createdAtMs: input.createdAtMs,
      createdByActorId: input.createdByActorId,
      definition: input.definition,
      fingerprint: input.fingerprint,
      lifecycle: input.lifecycle,
      playId: input.definition.playId,
      revision: (latest?.revision ?? 0) + 1,
      workspaceId: scope.workspaceId,
    };
    revisions.push(revision);
    this.plays.set(key, revisions);
    return Promise.resolve({ revision, status: "created" });
  }

  putWorkbookView(
    scope: WorkspaceScope,
    input: GtmWorkbookViewWrite
  ): Promise<GtmWorkbookViewWriteResult> {
    const key = `${scope.workspaceId}:${input.workbookId}`;
    const current = this.workbooks.get(key);
    if ((current?.revision ?? 0) !== input.expectedRevision) {
      return Promise.resolve({ status: "conflict" });
    }
    const view: GtmWorkbookView = {
      annotations: input.annotations,
      approvals: input.approvals,
      columnOrder: input.columnOrder,
      ...(input.contextRef === undefined
        ? {}
        : { contextRef: input.contextRef }),
      datasetId: input.datasetId,
      filters: input.filters,
      materializationId: input.materializationId,
      name: input.name,
      ...(input.playId === undefined ? {} : { playId: input.playId }),
      ...(input.playRevision === undefined
        ? {}
        : { playRevision: input.playRevision }),
      ...(input.playRunId === undefined ? {} : { playRunId: input.playRunId }),
      ...(input.recipeApplicationId === undefined
        ? {}
        : { recipeApplicationId: input.recipeApplicationId }),
      revision: (current?.revision ?? 0) + 1,
      selectionReasons: input.selectionReasons,
      selectedRecordIds: input.selectedRecordIds,
      workbookId: input.workbookId,
      workspaceId: scope.workspaceId,
    };
    this.workbooks.set(key, view);
    return Promise.resolve({
      status: current === undefined ? "created" : "updated",
      view,
    });
  }

  updatePlayRun(
    scope: WorkspaceScope,
    input: GtmPlayRunUpdate
  ): Promise<GtmPlayRunUpdateResult> {
    const key = `${scope.workspaceId}:${input.runId}`;
    const current = this.runs.get(key);
    if (current === undefined) {
      return Promise.resolve({ status: "not_found" });
    }
    if (current.revision !== input.expectedRevision) {
      return Promise.resolve({ status: "conflict" });
    }
    const run: StoredGtmPlayRun = {
      ...current,
      execution: input.execution,
      revision: current.revision + 1,
      state: input.state,
      updatedAtMs: input.updatedAtMs,
    };
    this.runs.set(key, run);
    return Promise.resolve({ run, status: "updated" });
  }
}

const persistence = new MemoryGtmPersistence();
const datasetRecords: DatasetRecordPageQueryPort = {
  listPage: () => Promise.resolve(undefined),
};
const service = createGtmService({
  clock: { now: () => Promise.resolve(instant(1000)) },
  datasetRecords,
  identifiers: { nextPlayRunId: () => "play_run_test" },
  persistence,
});

const actor = (
  workspace: string,
  permissions: readonly string[] = ["contexts:read", "contexts:write"]
): VerifiedApiKey => ({
  actorId: actorId(`actor-${workspace}`),
  authenticationMode: "api-key",
  credentialId: `credential-${workspace}`,
  permissions,
  workspaceId: workspaceId(workspace),
});

const playActor = (workspace: string): VerifiedApiKey =>
  actor(workspace, [
    "contacts:discover",
    "contacts:enrich",
    "contexts:read",
    "contexts:write",
    "datasets:generate",
    "datasets:read",
    "plans:quote",
    "plays:execute",
    "plays:write",
    "recipes:apply",
    "recipes:register",
    "steps:execute",
    "workbooks:read",
    "workbooks:write",
  ]);

const answerValue = (
  questionId: string,
  answerType: "boolean" | "number" | "string" | "string_array"
) => {
  if (questionId === "activation.mode") {
    return "no_send";
  }
  if (questionId === "audience.company_countries") {
    return ["FR"];
  }
  if (answerType === "boolean") {
    return true;
  }
  if (answerType === "number") {
    return 10;
  }
  if (answerType === "string_array") {
    return [`value-for-${questionId}`];
  }
  return `value-for-${questionId}`;
};

const readyContext = (contextId = "context-test"): GtmContextDocument => ({
  assertions: GTM_QUESTIONS.map((question) => ({
    provenance: {
      actorId: actorId("actor-human"),
      recordedAtMs: 900,
      source: question.requiresHumanConfirmation ? "human" : "agent",
    },
    questionId: question.questionId,
    state: question.requiresHumanConfirmation ? "confirmed" : "inferred",
    value: answerValue(question.questionId, question.answerType),
  })),
  contextId,
  name: "Synthetic GTM context",
  questionnaireVersion: GTM_QUESTIONNAIRE_VERSION,
});

const readyPlay = (
  contextRef: GtmContextRevisionRef,
  source: GtmPlayDefinition["source"]
): GtmPlayDefinition => ({
  approvals: {
    export: false,
    providerSpend: true,
    reveal: true,
  },
  authorityEnvelopeId: "authority-envelope-test",
  audience: {
    companyCountries: ["FR"],
    departments: ["sales"],
    personCountries: ["FR"],
    seniorities: ["director"],
    titles: ["Head of Sales"],
  },
  broadening: "forbidden",
  budget: { limit: 10, unit: "credits" },
  capabilities: ["contacts.discover", "contacts.work-email.resolve"],
  contextRef,
  deadlineMs: 2000,
  delivery: { mode: "no_send", privateExport: false },
  exclusions: ["existing customers"],
  objective: {
    metric: "qualified_contacts",
    target: 10,
    text: "Produce ten qualified contacts for human review.",
  },
  playId: `play-${source.kind}`,
  preview: {
    maxCompanies: 1,
    maxContactsPerCompany: 1,
    maxContactsTotal: 1,
    maxProviderCalls: 4,
    sampleSize: 1,
  },
  selection: {
    minimumScore: 0,
    requiredSignals: [],
  },
  source,
  stopConditions: ["budget_exhausted", "deadline_elapsed"],
});

test("publishes one stable questionnaire with explicit human policy gates", () => {
  const questions = service.questionnaire();
  assert.equal(questions.length, GTM_QUESTIONS.length);
  assert.equal(
    new Set(questions.map((question) => question.questionId)).size,
    questions.length
  );
  assert.deepEqual(
    questions
      .filter((question) => question.requiresHumanConfirmation)
      .map((question) => question.questionId),
    [
      "data.prohibited_fields",
      "policy.provider_rights_confirmed",
      "policy.initial_budget_limit",
      "policy.initial_budget_unit",
      "policy.retention_days",
      "activation.private_export_requested",
      "policy.export_destination_approved",
      "activation.mode",
    ]
  );
});

test("refuses agent-inferred policy answers before persistence", async () => {
  const document = readyContext("context-agent-policy");
  const prohibited = document.assertions.find(
    (assertion) => assertion.questionId === "policy.initial_budget_limit"
  );
  assert.ok(prohibited !== undefined);
  const unsafe: GtmContextDocument = {
    ...document,
    assertions: document.assertions.map((assertion) =>
      assertion.questionId === prohibited.questionId
        ? {
            ...assertion,
            provenance: { ...assertion.provenance, source: "agent" },
            state: "inferred",
          }
        : assertion
    ),
  };
  const plan = service.planContext(unsafe);
  assert.equal(
    plan.issues.some(
      (issue) =>
        issue.code === "confirmation-required" &&
        issue.questionId === "policy.initial_budget_limit"
    ),
    true
  );
  const result = await service.applyContext(actor("workspace-policy"), {
    activate: true,
    confirmActiveChange: true,
    confirmed: true,
    document: unsafe,
    planFingerprint: plan.fingerprint,
  });
  assert.equal(result.ok, false);
});

test("stores immutable revisions, replays fingerprints, and isolates workspaces", async () => {
  const firstActor = actor("workspace-one");
  const document = readyContext();
  const plan = service.planContext(document, 0);
  const created = await service.applyContext(firstActor, {
    activate: true,
    confirmActiveChange: true,
    confirmed: true,
    document,
    expectedBaseRevision: 0,
    planFingerprint: plan.fingerprint,
  });
  assert.equal(created.ok, true);
  assert.equal(created.ok ? created.status : undefined, "created");

  const replayed = await service.applyContext(firstActor, {
    activate: true,
    confirmActiveChange: true,
    confirmed: true,
    document,
    expectedBaseRevision: 0,
    planFingerprint: plan.fingerprint,
  });
  assert.equal(replayed.ok, true);
  assert.equal(replayed.ok ? replayed.status : undefined, "existing");

  const firstStatus = await service.status(firstActor);
  assert.equal(firstStatus.active?.revision, 1);
  assert.equal(
    firstStatus.readiness.find(
      (candidate) => candidate.profile === "agentic_outbound_play"
    )?.ready,
    true
  );

  const foreignStatus = await service.status(actor("workspace-two"));
  assert.equal(foreignStatus.active, undefined);
  assert.equal(foreignStatus.latest, undefined);
  assert.equal(
    foreignStatus.readiness.find(
      (candidate) => candidate.profile === "agentic_outbound_play"
    )?.businessContext,
    "missing"
  );
});

test("projects every business-context readiness state without exposing answers", async () => {
  const seed = (
    workspace: string,
    document: GtmContextDocument,
    activate: boolean
  ): void => {
    const revision: StoredGtmContextRevision = {
      contextId: document.contextId,
      createdAtMs: 900,
      createdByActorId: actorId("actor-human"),
      document,
      fingerprint: `sha256:${"a".repeat(64)}`,
      revision: 1,
      workspaceId: workspaceId(workspace),
    };
    persistence.contexts.set(`${workspace}:${document.contextId}`, [revision]);
    if (activate) {
      persistence.active.set(workspace, {
        contextId: document.contextId,
        fingerprint: revision.fingerprint,
        revision: 1,
      });
    }
  };
  const stateFor = async (workspace: string) =>
    (await service.status(actor(workspace))).readiness.find(
      (candidate) => candidate.profile === "agentic_outbound_play"
    )?.businessContext;

  seed("workspace-draft", readyContext("context-draft"), false);
  assert.equal(await stateFor("workspace-draft"), "draft");

  seed(
    "workspace-incomplete",
    {
      ...readyContext("context-incomplete"),
      assertions: readyContext("context-incomplete").assertions.map(
        (assertion) =>
          assertion.questionId === "policy.initial_budget_limit"
            ? {
                provenance: assertion.provenance,
                questionId: assertion.questionId,
                state: "unknown",
              }
            : assertion
      ),
    },
    true
  );
  assert.equal(await stateFor("workspace-incomplete"), "incomplete");

  seed(
    "workspace-stale",
    {
      ...readyContext("context-stale"),
      questionnaireVersion: "0.9.0",
    },
    true
  );
  assert.equal(await stateFor("workspace-stale"), "stale");

  seed(
    "workspace-incompatible",
    {
      ...readyContext("context-incompatible"),
      name: "",
    },
    true
  );
  assert.equal(await stateFor("workspace-incompatible"), "incompatible");

  assert.equal(await stateFor("workspace-missing"), "missing");
});

const activeContextRef = async (
  workspace: string
): Promise<GtmContextRevisionRef> => {
  const document = readyContext(`context-${workspace}`);
  const plan = service.planContext(document, 0);
  const result = await service.applyContext(playActor(workspace), {
    activate: true,
    confirmActiveChange: true,
    confirmed: true,
    document,
    expectedBaseRevision: 0,
    planFingerprint: plan.fingerprint,
  });
  if (!result.ok) {
    throw new Error("Synthetic active Context setup failed.");
  }
  return {
    contextId: result.revision.contextId,
    fingerprint: result.revision.fingerprint,
    revision: result.revision.revision,
  };
};

test("compiles both Play sources to canonical bounded primitives", async () => {
  const organizationWorkspace = "workspace-play-organization";
  const organizationContext = await activeContextRef(organizationWorkspace);
  const organizationPlay = readyPlay(organizationContext, {
    countries: ["FR"],
    industries: ["software"],
    keywords: ["revenue operations"],
    kind: "organization_search",
  });
  const organizationPreview = await service.previewPlay(
    playActor(organizationWorkspace),
    organizationPlay
  );
  assert.deepEqual(
    organizationPreview.compilation.stages.map((stage) => stage.operationId),
    [
      "organizations.discover",
      "contacts.discover",
      "contacts.identity.reveal",
      "contacts.work-email.resolve",
      "workbooks.project",
    ]
  );
  assert.equal(organizationPreview.lifecycle, "awaiting_approval");
  assert.equal(organizationPreview.issues.length, 0);
  const requestBudgetPreview = await service.previewPlay(
    playActor(organizationWorkspace),
    {
      ...organizationPlay,
      budget: { limit: 4, unit: "requests" },
    }
  );
  assert.equal(requestBudgetPreview.compilation.budget.quotedUpperBound, 4);
  const underfundedRequestPreview = await service.previewPlay(
    playActor(organizationWorkspace),
    {
      ...organizationPlay,
      budget: { limit: 3, unit: "requests" },
    }
  );
  assert.equal(
    underfundedRequestPreview.issues.some(
      (issue) => issue.code === "play-invalid"
    ),
    true
  );
  assert.deepEqual(
    await service.previewPlay(
      playActor(organizationWorkspace),
      organizationPlay
    ),
    organizationPreview
  );

  const importedWorkspace = "workspace-play-imported";
  const importedContext = await activeContextRef(importedWorkspace);
  const importedPlay = readyPlay(importedContext, {
    datasetId: datasetId("dataset-imported-play"),
    defaultCountryCode: "FR",
    fieldMapping: { domain: "company_domain", name: "company_name" },
    kind: "imported_dataset",
    materializationId: datasetMaterializationId(
      datasetId("dataset-imported-play")
    ),
  });
  const importedPreview = await service.previewPlay(
    playActor(importedWorkspace),
    importedPlay
  );
  assert.deepEqual(
    importedPreview.compilation.stages.map((stage) => stage.operationId),
    [
      "contacts.discover",
      "contacts.identity.reveal",
      "contacts.work-email.resolve",
      "workbooks.project",
    ]
  );
  assert.equal(importedPreview.issues.length, 0);
  assert.equal(
    JSON.stringify(importedPreview).includes("provider_type"),
    false
  );
  assert.equal(JSON.stringify(importedPreview).includes("secret"), false);
});

test("stores immutable Play lifecycle revisions and replays one durable run", async () => {
  const workspace = "workspace-play-lifecycle";
  const contextRef = await activeContextRef(workspace);
  const definition = readyPlay(contextRef, {
    countries: ["FR"],
    industries: ["software"],
    keywords: ["sales"],
    kind: "organization_search",
  });
  const owner = playActor(workspace);
  const preview = await service.previewPlay(owner, definition);

  const approved = await service.applyPlay(owner, {
    action: "approve",
    approvedByHuman: true,
    definition,
    expectedBaseRevision: 0,
    idempotencyKey: "approve-play",
    previewFingerprint: preview.fingerprint,
  });
  assert.equal(approved.ok, true);
  assert.ok(approved.ok);
  assert.equal(approved.revision.lifecycle, "approved");

  const started = await service.applyPlay(owner, {
    action: "start",
    approvedByHuman: true,
    definition,
    expectedBaseRevision: 1,
    idempotencyKey: "start-play",
    previewFingerprint: preview.fingerprint,
  });
  assert.equal(started.ok, true);
  assert.ok(started.ok);
  assert.equal(started.revision.lifecycle, "active");
  assert.equal(started.run?.state, "queued");
  assert.deepEqual(started.run?.definition, definition);

  const replayed = await service.applyPlay(owner, {
    action: "start",
    approvedByHuman: true,
    definition,
    expectedBaseRevision: 1,
    idempotencyKey: "start-play",
    previewFingerprint: preview.fingerprint,
  });
  assert.deepEqual(replayed, started);

  const paused = await service.applyPlay(owner, {
    action: "pause",
    approvedByHuman: false,
    definition,
    expectedBaseRevision: 2,
    idempotencyKey: "pause-play",
    previewFingerprint: preview.fingerprint,
  });
  assert.equal(paused.ok, true);
  assert.ok(paused.ok);
  assert.equal(paused.revision.lifecycle, "paused");

  const retired = await service.applyPlay(owner, {
    action: "retire",
    approvedByHuman: false,
    definition,
    expectedBaseRevision: 3,
    idempotencyKey: "retire-play",
    previewFingerprint: preview.fingerprint,
  });
  assert.equal(retired.ok, true);
  assert.ok(retired.ok);
  assert.equal(retired.revision.lifecycle, "retired");
  assert.equal(
    await service.getPlayRevision(
      playActor("workspace-play-foreign"),
      definition.playId
    ),
    undefined
  );
  assert.equal(
    await service.getPlayRun(
      playActor("workspace-play-foreign"),
      started.run?.runId ?? ""
    ),
    undefined
  );
});

test("refuses Play execution when a matching human gate is absent", async () => {
  const workspace = "workspace-play-gates";
  const contextRef = await activeContextRef(workspace);
  const definition = {
    ...readyPlay(contextRef, {
      countries: ["FR"],
      industries: ["software"],
      keywords: ["sales"],
      kind: "organization_search" as const,
    }),
    approvals: {
      export: false,
      providerSpend: false,
      reveal: true,
    },
  };
  const owner = playActor(workspace);
  const preview = await service.previewPlay(owner, definition);
  const rejected = await service.applyPlay(owner, {
    action: "start",
    approvedByHuman: true,
    definition,
    expectedBaseRevision: 0,
    idempotencyKey: "start-without-spend-approval",
    previewFingerprint: preview.fingerprint,
  });
  assert.equal(rejected.ok, false);
  assert.equal(
    rejected.ok
      ? false
      : rejected.issues.some((issue) => issue.code === "confirmation-required"),
    true
  );
});

test("projects recipe evidence and durable selection decisions through Workbook", async () => {
  const workspace = workspaceId("workspace-workbook");
  const dataset = datasetId("dataset-workbook");
  const materialization = datasetMaterializationId("materialization-workbook");
  const domainField = fieldId("field-domain");
  const emailField = fieldId("field-work-email");
  const companyRecordId = recordId("record-company");
  const hash = contentHash(`sha256:${"b".repeat(64)}`);
  const record = {
    datasetId: dataset,
    recordId: companyRecordId,
    values: [
      { fieldId: domainField, value: "company.example" },
      { fieldId: emailField, value: null },
    ],
    workspaceId: workspace,
  };
  const page: DatasetRecordPage = {
    dataset: {
      datasetId: dataset,
      name: "Synthetic Workbook",
      workspaceId: workspace,
    },
    fields: [
      {
        datasetId: dataset,
        fieldId: domainField,
        key: "domain",
        label: "Domain",
        valueType: "string",
        workspaceId: workspace,
      },
      {
        datasetId: dataset,
        fieldId: emailField,
        key: "work_email",
        label: "Work email",
        valueType: "string",
        workspaceId: workspace,
      },
    ],
    hasMore: false,
    items: [{ ordinal: 1, record }],
    materialization: {
      completedAt: instant(900),
      completionReason: "source-completed",
      contentHash: hash,
      coverage: {
        basis: "imported_source",
        status: "complete_for_declared_source",
      },
      createdAt: instant(800),
      datasetId: dataset,
      materializationId: materialization,
      origin: { importId: "import-workbook", kind: "import" },
      recordCount: 1,
      rejectedCount: 0,
      revision: 1,
      schemaHash: hash,
      state: "ready",
      workspaceId: workspace,
    },
  };
  const recipeApplicationId = "recipe-application-workbook";
  const projection: ExactRecipeProjectionRow = {
    application: {
      createdAt: instant(900),
      datasetId: dataset,
      graph: { recordIds: [companyRecordId] },
      graphHash: hash,
      intentHash: hash,
      maxCells: 1,
      recipeApplicationId,
      recipeId: enrichmentRecipeId("recipe-work-email"),
      recipeRevision: "1.0.0",
      targetFieldId: emailField,
      workspaceId: workspace,
    },
    binding: "executed",
    cellResult: {
      cellResultId: cellResultId("cell-work-email"),
      confidence: 0.91,
      cost: { amount: 1, basis: "exact", unit: "credits" },
      datasetId: dataset,
      enrichmentRecipeId: enrichmentRecipeId("recipe-work-email"),
      fieldId: emailField,
      freshness: {
        expiresAt: instant(2000),
        observedAt: instant(950),
      },
      provenance: { references: ["source:synthetic-directory"] },
      recipeRevision: "1.0.0",
      recordId: companyRecordId,
      runId: runId("run-work-email"),
      status: "succeeded",
      value: "person@company.example",
      workspaceId: workspace,
    },
    record,
    recordContentHash: hash,
  };
  const workbookPersistence = new MemoryGtmPersistence();
  const workbookService = createGtmService({
    clock: { now: () => Promise.resolve(instant(1000)) },
    datasetRecords: { listPage: () => Promise.resolve(page) },
    identifiers: { nextPlayRunId: () => "play-run-workbook" },
    persistence: workbookPersistence,
    recipeProjection: {
      getMany: (_scope, applicationId, recordIds) =>
        Promise.resolve(
          recordIds.map((candidate) =>
            applicationId === recipeApplicationId &&
            candidate === companyRecordId
              ? projection
              : undefined
          )
        ),
    },
  });
  const reviewer = actor("workspace-workbook", [
    "workbooks:read",
    "workbooks:write",
  ]);
  const saved = await workbookService.saveWorkbook(reviewer, {
    annotations: [
      {
        createdAtMs: 0,
        createdByActorId: actorId("spoofed-actor"),
        note: "Qualified for review.",
        recordId: companyRecordId,
      },
    ],
    approvals: [
      {
        createdAtMs: 0,
        createdByActorId: actorId("spoofed-actor"),
        decision: "approved",
        recordId: companyRecordId,
      },
    ],
    columnOrder: ["domain", "work_email"],
    datasetId: dataset,
    expectedRevision: 0,
    filters: [],
    materializationId: materialization,
    name: "Synthetic Workbook",
    recipeApplicationId,
    selectionReasons: [
      {
        reasons: ["role_match", "company_match"],
        recordId: companyRecordId,
      },
    ],
    selectedRecordIds: [companyRecordId],
    workbookId: "workbook-synthetic",
  });
  assert.equal(saved.ok, true);
  assert.ok(saved.ok);
  assert.equal(saved.view.annotations[0]?.createdByActorId, reviewer.actorId);
  assert.equal(saved.view.annotations[0]?.createdAtMs, 1000);
  assert.equal(saved.view.approvals[0]?.createdByActorId, reviewer.actorId);

  const redacted = await workbookService.getWorkbook(reviewer, {
    afterOrdinal: 0,
    datasetId: dataset,
    limit: 10,
    materializationId: materialization,
    workbookId: "workbook-synthetic",
  });
  assert.equal(redacted.ok, true);
  assert.ok(redacted.ok);
  assert.deepEqual(redacted.page.records[0]?.selectionReasons, [
    "role_match",
    "company_match",
  ]);
  const redactedEmail = redacted.page.records[0]?.cells.find(
    (cell) => cell.fieldId === emailField
  );
  assert.equal(redactedEmail?.redacted, true);
  assert.equal(redactedEmail?.value, null);
  assert.equal(redactedEmail?.confidence, 0.91);
  assert.deepEqual(redactedEmail?.cost, {
    amount: 1,
    basis: "exact",
    unit: "credits",
  });
  assert.deepEqual(redactedEmail?.freshness, {
    expiresAtMs: 2000,
    observedAtMs: 950,
  });
  assert.deepEqual(redactedEmail?.provenance, [
    "cell-result:cell-work-email",
    "source:synthetic-directory",
  ]);

  const revealed = await workbookService.getWorkbook(
    actor("workspace-workbook", ["contacts:enrich", "workbooks:read"]),
    {
      afterOrdinal: 0,
      datasetId: dataset,
      limit: 10,
      materializationId: materialization,
      workbookId: "workbook-synthetic",
    }
  );
  assert.equal(revealed.ok, true);
  assert.ok(revealed.ok);
  assert.equal(
    revealed.page.records[0]?.cells.find((cell) => cell.fieldId === emailField)
      ?.value,
    "person@company.example"
  );

  const foreign = await workbookService.getWorkbook(
    actor("workspace-workbook-foreign", ["workbooks:read"]),
    {
      afterOrdinal: 0,
      datasetId: dataset,
      limit: 10,
      materializationId: materialization,
      workbookId: "workbook-synthetic",
    }
  );
  assert.equal(foreign.ok, false);

  const unauthorized = await workbookService.getWorkbook(
    actor("workspace-workbook", []),
    {
      afterOrdinal: 0,
      datasetId: dataset,
      limit: 10,
      materializationId: materialization,
      workbookId: "workbook-synthetic",
    }
  );
  assert.equal(unauthorized.ok, false);
});

test("keeps Workbook projection work bounded to one page of a large dataset", async () => {
  const workspace = workspaceId("workspace-workbook-large");
  const dataset = datasetId("dataset-workbook-large");
  const materialization = datasetMaterializationId(
    "materialization-workbook-large"
  );
  const companyField = fieldId("field-company-large");
  const hash = contentHash(`sha256:${"c".repeat(64)}`);
  const items = Array.from({ length: 100 }, (_, index) => ({
    ordinal: 50_001 + index,
    record: {
      datasetId: dataset,
      recordId: recordId(`record-large-${index + 1}`),
      values: [
        {
          fieldId: companyField,
          value: `Company ${index + 1}`,
        },
      ],
      workspaceId: workspace,
    },
  }));
  const persistence = new MemoryGtmPersistence();
  persistence.workbooks.set("workspace-workbook-large:workbook-large", {
    annotations: [],
    approvals: [],
    columnOrder: ["company_name"],
    datasetId: dataset,
    filters: [],
    materializationId: materialization,
    name: "Large Workbook",
    recipeApplicationId: "recipe-application-large",
    revision: 1,
    selectionReasons: [],
    selectedRecordIds: [],
    workbookId: "workbook-large",
    workspaceId: workspace,
  });
  let projectedRecordCount = 0;
  const workbookService = createGtmService({
    clock: { now: () => Promise.resolve(instant(1000)) },
    datasetRecords: {
      listPage: () =>
        Promise.resolve({
          dataset: {
            datasetId: dataset,
            name: "Large dataset",
            workspaceId: workspace,
          },
          fields: [
            {
              datasetId: dataset,
              fieldId: companyField,
              key: "company_name",
              label: "Company",
              valueType: "string",
              workspaceId: workspace,
            },
          ],
          hasMore: true,
          items,
          materialization: {
            completedAt: instant(900),
            completionReason: "source-completed",
            contentHash: hash,
            coverage: {
              basis: "imported_source",
              status: "complete_for_declared_source",
            },
            createdAt: instant(800),
            datasetId: dataset,
            materializationId: materialization,
            origin: { importId: "import-workbook-large", kind: "import" },
            recordCount: 100_000,
            rejectedCount: 0,
            revision: 1,
            schemaHash: hash,
            state: "ready",
            workspaceId: workspace,
          },
        }),
    },
    identifiers: { nextPlayRunId: () => "play-run-large" },
    persistence,
    recipeProjection: {
      getMany: (_scope, _applicationId, recordIds) => {
        projectedRecordCount = recordIds.length;
        return Promise.resolve(recordIds.map(() => undefined));
      },
    },
  });
  const result = await workbookService.getWorkbook(
    actor("workspace-workbook-large", ["workbooks:read"]),
    {
      afterOrdinal: 50_000,
      datasetId: dataset,
      limit: 100,
      materializationId: materialization,
      workbookId: "workbook-large",
    }
  );
  assert.equal(result.ok, true);
  assert.ok(result.ok);
  assert.equal(result.page.records.length, 100);
  assert.equal(result.page.nextAfterOrdinal, 50_100);
  assert.equal(projectedRecordCount, 100);
});
