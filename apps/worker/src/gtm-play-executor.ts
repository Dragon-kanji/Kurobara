import { createHash } from "node:crypto";

import {
  contactDiscoveryExecutionQueryContract,
  contactIdentityExecutionQueryContract,
  contactWorkEmailExecutionQueryContract,
  organizationDiscoveryQueryContract,
} from "@kurobara/adapter-http";
import {
  createPostgresDatasetGenerationPlanningSnapshotResolver,
  type PostgresRuntime,
} from "@kurobara/adapter-postgres";
import {
  createConfiguredDeterministicFixtureRoutes,
  createConfiguredOfficialProviderRoutes,
  createConfiguredSelectedContactProviderRoutes,
  parseConfiguredContactPrivacyHmacSecrets,
} from "@kurobara/adapter-provider-registry";
import {
  contactDiscoveryCapability,
  contactIdentityRevealCapability,
  contactWorkEmailResolveCapability,
  contactWorkEmailVerifyCapability,
  createCompanyDiscoveryQueryNormalizer,
  createContactDiscoveryQueryNormalizer,
  createContactIdentityQueryNormalizer,
  createContactWorkEmailQueryNormalizer,
  createDatasetGenerationQueryNormalizerRouter,
  createRandomDatasetGenerationIdentifiers,
  createRandomIdentifiers,
  createRandomPlanningIdentifiers,
  createStaticExecutionCatalog,
  createSystemClock,
  organizationDiscoveryCapability,
  toCapabilityId,
  toCorrelationId,
  toDatasetId,
  toFieldId,
  toIdempotencyKey,
  toInstant,
  toRecordId,
} from "@kurobara/adapter-system";
import {
  authorizePrivacySafeContactDiscovery,
  createContactPrivacyTombstoneGuard,
  createHmacContactPrivacySubjectKeyDeriver,
  type DatasetGenerationCreation,
  type DatasetGenerationQueryValue,
  type GtmPlayGenerationSnapshot,
  type GtmPlayProjectionResult,
  type GtmPlayRunStageReceipt,
  makeAuthorizeDatasetGenerationPage,
  makeCreateDatasetGeneration,
  makeDeriveSelectedContactIdentities,
  makeDeriveSelectedContactWorkEmails,
  makeDiscoverContacts,
  makeDiscoverOrganizations,
  makeGetDatasetGenerationStatus,
  makeListContactCandidates,
  makeLoadImportedCompanyCandidates,
  makeLoadReadyCompanyCandidates,
  makePlanDatasetGeneration,
  type OrganizationSource,
  type StoredGtmPlayRun,
  type VerifiedApiKey,
} from "@kurobara/application";

const COMPANY_FIELDS = [
  ["name", "Company name", "string"],
  ["domain", "Company domain", "string"],
  ["country_code", "Headquarters country", "string"],
  ["industry_code", "Industry", "string"],
  ["employee_count", "Employee count", "number"],
  ["observed_at_ms", "Observed at", "number"],
] as const;

const CONTACT_FIELDS = [
  ["department", "Department", "string"],
  ["display_name", "Display name", "string"],
  ["identity_completeness", "Identity completeness", "string"],
  ["job_title", "Current job title", "string"],
  ["observed_at_ms", "Employment observed at", "number"],
  ["organization_domain", "Company domain", "string"],
  ["organization_id", "Company ID", "string"],
  ["organization_name", "Company name", "string"],
  ["person_country_code", "Person country", "string"],
  ["profile_url", "Professional profile", "string"],
  ["seniority", "Seniority", "string"],
] as const;

const stableSuffix = (
  run: StoredGtmPlayRun,
  stage: GtmPlayRunStageReceipt
): string =>
  createHash("sha256")
    .update(`${run.runId}\u0000${stage.ordinal}\u0000${stage.operationId}`)
    .digest("hex")
    .slice(0, 32);

const actorFor = (run: StoredGtmPlayRun): VerifiedApiKey => ({
  actorId: run.executionActor.actorId,
  authenticationMode: "api-key",
  credentialId: `play-run:${run.runId}`,
  permissions: run.executionActor.permissions,
  workspaceId: run.workspaceId,
});

const remainingBudget = (run: StoredGtmPlayRun) => ({
  limit: Math.max(
    0.000_001,
    run.definition.budget.limit - run.execution.cost.spent
  ),
  unit: run.definition.budget.unit,
});

const snapshotFromCreation = (
  creation: DatasetGenerationCreation
): GtmPlayGenerationSnapshot => {
  const generation = creation.generation;
  const terminal = generation.state;
  const snapshot: GtmPlayGenerationSnapshot = {
    cost: generation.cost,
    datasetId: generation.datasetId,
    generationId: generation.generationId,
    materializationId: generation.materializationId,
    provenance: [
      `${generation.capability.capabilityId}@${generation.capability.capabilityVersion}`,
      ...(generation.lockedProvider === undefined
        ? []
        : [`provider:${generation.lockedProvider}`]),
    ],
    providerCalls: generation.counters.calls,
    recordCount: creation.materialization.recordCount,
    state: "running",
  };
  if (terminal === "completed") {
    return { ...snapshot, state: "completed" };
  }
  if (
    terminal === "failed" ||
    terminal === "cancelled" ||
    terminal === "ambiguous"
  ) {
    return {
      ...snapshot,
      error: {
        code: `dataset-generation-${terminal}`,
        message:
          "The durable dataset generation did not complete successfully.",
        retryable: terminal === "ambiguous",
      },
      state: terminal,
    };
  }
  return snapshot;
};

const previousCompletedStage = (
  run: StoredGtmPlayRun,
  stage: GtmPlayRunStageReceipt
): GtmPlayRunStageReceipt | undefined =>
  [...run.execution.stages]
    .reverse()
    .find(
      (candidate) =>
        candidate.ordinal < stage.ordinal && candidate.state === "completed"
    );

const stageExecutionFor = (
  run: StoredGtmPlayRun,
  stage: GtmPlayRunStageReceipt
) => {
  const actor = actorFor(run);
  const suffix = stableSuffix(run, stage);
  return {
    actor,
    execution: {
      actorId: actor.actorId,
      actorPermissions: actor.permissions,
      authenticationMode: actor.authenticationMode,
      correlationId: toCorrelationId(`play-${suffix}`),
      workspaceId: actor.workspaceId,
    } as const,
    suffix,
  };
};

const organizationSourceFor = (
  run: StoredGtmPlayRun,
  stage: GtmPlayRunStageReceipt
): OrganizationSource => {
  if (run.definition.source.kind === "organization_search") {
    return {
      generationId:
        previousCompletedStage(run, stage)?.generationId ??
        "missing-generation",
      kind: "generation",
    };
  }
  return {
    datasetId: run.definition.source.datasetId,
    ...(run.definition.source.defaultCountryCode === undefined
      ? {}
      : {
          defaultCountryCode: run.definition.source.defaultCountryCode,
        }),
    fieldMapping: run.definition.source.fieldMapping,
    kind: "dataset",
    materializationId: run.definition.source.materializationId,
  };
};

const organizationSourceQueryFor = (
  source: OrganizationSource
): DatasetGenerationQueryValue => {
  if (source.kind === "generation") {
    return {
      generation_id: source.generationId,
      kind: "generation",
    };
  }
  return {
    dataset_id: source.datasetId,
    ...(source.defaultCountryCode === undefined
      ? {}
      : {
          default_country_code: source.defaultCountryCode,
        }),
    field_mapping: {
      ...(source.fieldMapping.countryCode === undefined
        ? {}
        : {
            country_code: source.fieldMapping.countryCode,
          }),
      domain: source.fieldMapping.domain,
      ...(source.fieldMapping.name === undefined
        ? {}
        : { name: source.fieldMapping.name }),
    },
    kind: "dataset",
  };
};

export const organizationDiscoveryQueryForPlay = (
  source: Extract<
    StoredGtmPlayRun["definition"]["source"],
    Readonly<{ kind: "organization_search" }>
  >
): DatasetGenerationQueryValue => ({
  country_codes: source.countries,
  country_scope: "headquarters",
  industry_codes: source.industries,
  industry_taxonomy: "kurobara-v1",
  ...(source.keywords.length === 0 ? {} : { keywords: source.keywords }),
  result_kind: "company",
});

export type ConfiguredGtmPlayExecutor = Readonly<{
  inspectGeneration: (
    run: StoredGtmPlayRun,
    stage: GtmPlayRunStageReceipt
  ) => Promise<GtmPlayGenerationSnapshot>;
  projectWorkbook: (
    run: StoredGtmPlayRun,
    stage: GtmPlayRunStageReceipt
  ) => Promise<GtmPlayProjectionResult>;
  startStage: (
    run: StoredGtmPlayRun,
    stage: GtmPlayRunStageReceipt
  ) => Promise<GtmPlayGenerationSnapshot>;
}>;

export const createConfiguredGtmPlayExecutor = (
  runtime: PostgresRuntime,
  environment: Readonly<Record<string, string | undefined>>
): ConfiguredGtmPlayExecutor => {
  const clock = createSystemClock();
  const planningIdentifiers = createRandomPlanningIdentifiers();
  const generationIdentifiers = createRandomDatasetGenerationIdentifiers();
  const runIdentifiers = createRandomIdentifiers();
  const routes = [
    ...createConfiguredDeterministicFixtureRoutes(environment),
    ...createConfiguredOfficialProviderRoutes(environment),
    ...createConfiguredSelectedContactProviderRoutes(environment),
  ];
  const catalog = createStaticExecutionCatalog(routes);
  const snapshots = createPostgresDatasetGenerationPlanningSnapshotResolver({
    clock,
    identifiers: planningIdentifiers,
    persistence: runtime.planning,
    routes: catalog.routes,
  });
  const planGeneration = makePlanDatasetGeneration({
    clock,
    identifiers: generationIdentifiers,
    normalizer: createDatasetGenerationQueryNormalizerRouter([
      {
        capability: organizationDiscoveryCapability,
        normalizer: createCompanyDiscoveryQueryNormalizer({
          contract: organizationDiscoveryQueryContract,
        }),
      },
      {
        capability: contactDiscoveryCapability,
        normalizer: createContactDiscoveryQueryNormalizer({
          contract: contactDiscoveryExecutionQueryContract,
        }),
      },
      {
        capability: contactIdentityRevealCapability,
        normalizer: createContactIdentityQueryNormalizer({
          contract: contactIdentityExecutionQueryContract,
        }),
      },
      {
        capability: contactWorkEmailResolveCapability,
        normalizer: createContactWorkEmailQueryNormalizer({
          contract: contactWorkEmailExecutionQueryContract,
        }),
      },
      {
        capability: contactWorkEmailVerifyCapability,
        normalizer: createContactWorkEmailQueryNormalizer({
          contract: contactWorkEmailExecutionQueryContract,
        }),
      },
    ]),
    persistence: runtime.datasetGenerationPlanning,
    snapshots,
  });
  const createGeneration = makeCreateDatasetGeneration({
    clock,
    identifiers: generationIdentifiers,
    persistence: runtime.datasetGeneration,
  });
  const authorizePage = makeAuthorizeDatasetGenerationPage({
    clock,
    identifiers: runIdentifiers,
    persistence: runtime.datasetGenerationFirstPage,
  });
  const privacySecrets = parseConfiguredContactPrivacyHmacSecrets(environment);
  const privacySubjectKeys =
    privacySecrets === undefined
      ? {
          derive: (): Promise<never> =>
            Promise.reject(
              new Error("Contact privacy HMAC secret is not configured.")
            ),
        }
      : createHmacContactPrivacySubjectKeyDeriver(privacySecrets);
  const privacy = createContactPrivacyTombstoneGuard({
    persistence: runtime.contactPrivacy,
    subjectKeys: privacySubjectKeys,
  });
  const discoverOrganizations = makeDiscoverOrganizations({
    authorizePage,
    createGeneration,
    planGeneration,
  });
  const discoverContacts = makeDiscoverContacts({
    authorizePage,
    authorizePrivacy: authorizePrivacySafeContactDiscovery,
    createGeneration,
    loadImportedOrganizations: makeLoadImportedCompanyCandidates({
      datasets: runtime.datasets,
    }),
    loadOrganizations: makeLoadReadyCompanyCandidates({
      generations: runtime.datasetGeneration,
      records: runtime.datasetRecordPages,
    }),
    planGeneration,
  });
  const deriveIdentities = makeDeriveSelectedContactIdentities({
    authorizePage,
    createGeneration,
    planGeneration,
    privacy,
    source: runtime.contactIdentitySource,
  });
  const deriveWorkEmails = makeDeriveSelectedContactWorkEmails({
    authorizePage,
    createGeneration,
    planGeneration,
    privacy,
    source: runtime.selectedContactEnrichmentSource,
  });
  const getGeneration = makeGetDatasetGenerationStatus({
    persistence: runtime.datasetGeneration,
    requiredPermission: "datasets:read",
  });
  const listContacts = makeListContactCandidates({
    generations: runtime.datasetGeneration,
    privacy: {
      guard: privacy,
      subjects: runtime.contactDatasetExportPrivacy,
    },
    records: runtime.datasetRecordPages,
    requiredPermission: "datasets:read",
  });

  const inspectGeneration = async (
    run: StoredGtmPlayRun,
    stage: GtmPlayRunStageReceipt
  ): Promise<GtmPlayGenerationSnapshot> => {
    if (stage.generationId === undefined) {
      throw new Error("The Play stage has no durable generation identity.");
    }
    const actor = actorFor(run);
    const result = await getGeneration({
      actorId: actor.actorId,
      actorPermissions: actor.permissions,
      generationId: stage.generationId as Parameters<
        typeof getGeneration
      >[0]["generationId"],
      workspaceId: actor.workspaceId,
    });
    if (!result.ok) {
      throw new Error("The Play child generation is unavailable.");
    }
    return snapshotFromCreation(result.value);
  };

  const selectContactRecords = async (
    run: StoredGtmPlayRun,
    contactStage: GtmPlayRunStageReceipt
  ) => {
    if (run.execution.selectedRecordIds.length > 0) {
      return {
        recordIds: run.execution.selectedRecordIds,
        reasons: run.execution.selectionReasons,
      };
    }
    if (contactStage.generationId === undefined) {
      throw new Error("Contact selection requires a completed generation.");
    }
    const selected = await listContacts({
      actor: actorFor(run),
      afterOrdinal: 0,
      generationId: contactStage.generationId as Parameters<
        typeof listContacts
      >[0]["generationId"],
      limit: Math.min(3, run.definition.preview.maxContactsTotal),
    });
    if (!(selected.ok && selected.value.items.length > 0)) {
      throw new Error("The Play contact selection is empty or unavailable.");
    }
    const recordIds = selected.value.items.map(
      ({ candidate }) => candidate.contactId
    );
    return {
      recordIds,
      reasons: recordIds.map((recordId) => ({
        reasons: ["bounded_play_selection"],
        recordId,
      })),
    };
  };

  const startOrganizationStage = async (
    run: StoredGtmPlayRun,
    stage: GtmPlayRunStageReceipt
  ): Promise<GtmPlayGenerationSnapshot> => {
    if (run.definition.source.kind !== "organization_search") {
      throw new Error("The Play organization source is invalid.");
    }
    const { actor, execution, suffix } = stageExecutionFor(run, stage);
    const targetDatasetId = toDatasetId(`play_org_${suffix}`);
    const result = await discoverOrganizations({
      execution,
      mode: "start",
      planning: {
        actorId: actor.actorId,
        authorityEnvelopeId: run.definition.authorityEnvelopeId,
        capability: {
          capabilityId: toCapabilityId("organizations.discover"),
          capabilityVersion: "1.0.0",
        },
        fields: COMPANY_FIELDS.map(([key, label, valueType]) => ({
          datasetId: targetDatasetId,
          fieldId: toFieldId(`company_${key}`),
          key,
          label,
          valueType,
          workspaceId: actor.workspaceId,
        })),
        idempotencyKey: toIdempotencyKey(`play-${suffix}`),
        limits: {
          maxCalls: 1,
          maxCompanies: run.definition.preview.maxCompanies,
          maxContactsPerCompany: 0,
          maxContactsTotal: 0,
          maxEnrichments: 0,
          maxPages: 1,
          maxPhones: 0,
          maxResults: run.definition.preview.maxCompanies,
        },
        query: organizationDiscoveryQueryForPlay(run.definition.source),
        requestedBudget: remainingBudget(run),
        requestedDeadline: toInstant(run.definition.deadlineMs),
        targetDataset: {
          datasetId: targetDatasetId,
          name: `Play ${run.playId} organizations`,
          workspaceId: actor.workspaceId,
        },
        unknownCostPolicy: { mode: "deny" },
        workspaceId: actor.workspaceId,
      },
    });
    if (!(result.ok && result.value.mode === "start")) {
      throw new Error("The organization stage was rejected.");
    }
    return snapshotFromCreation(result.value.creation);
  };

  const startContactStage = async (
    run: StoredGtmPlayRun,
    stage: GtmPlayRunStageReceipt
  ): Promise<GtmPlayGenerationSnapshot> => {
    const { actor, execution, suffix } = stageExecutionFor(run, stage);
    const targetDatasetId = toDatasetId(`play_contacts_${suffix}`);
    const organizationSource = organizationSourceFor(run, stage);
    const result = await discoverContacts({
      execution,
      mode: "start",
      organizationSource,
      planning: {
        actorId: actor.actorId,
        authorityEnvelopeId: run.definition.authorityEnvelopeId,
        capability: {
          capabilityId: toCapabilityId("contacts.discover"),
          capabilityVersion: "1.0.0",
        },
        fields: CONTACT_FIELDS.map(([key, label, valueType]) => ({
          datasetId: targetDatasetId,
          fieldId: toFieldId(`contact_${key}`),
          key,
          label,
          valueType,
          workspaceId: actor.workspaceId,
        })),
        idempotencyKey: toIdempotencyKey(`play-${suffix}`),
        limits: {
          maxCalls: 1,
          maxCompanies: run.definition.preview.maxCompanies,
          maxContactsPerCompany: run.definition.preview.maxContactsPerCompany,
          maxContactsTotal: run.definition.preview.maxContactsTotal,
          maxEnrichments: 0,
          maxPages: 1,
          maxPhones: 0,
          maxResults: run.definition.preview.maxContactsTotal,
        },
        query: {
          company_headquarters_country_codes:
            run.definition.audience.companyCountries,
          departments: run.definition.audience.departments,
          organization_source: organizationSourceQueryFor(organizationSource),
          person_country_codes: run.definition.audience.personCountries,
          result_kind: "contact",
          seniorities: run.definition.audience.seniorities,
          titles: run.definition.audience.titles,
        },
        requestedBudget: remainingBudget(run),
        requestedDeadline: toInstant(run.definition.deadlineMs),
        targetDataset: {
          datasetId: targetDatasetId,
          name: `Play ${run.playId} contacts`,
          workspaceId: actor.workspaceId,
        },
        unknownCostPolicy: { mode: "deny" },
        workspaceId: actor.workspaceId,
      },
    });
    if (!(result.ok && result.value.mode === "start")) {
      throw new Error("The contact discovery stage was rejected.");
    }
    return snapshotFromCreation(result.value.creation);
  };

  const startEnrichmentStage = async (
    run: StoredGtmPlayRun,
    stage: GtmPlayRunStageReceipt
  ): Promise<GtmPlayGenerationSnapshot> => {
    const { actor, suffix } = stageExecutionFor(run, stage);
    const source = previousCompletedStage(run, stage);
    if (source?.datasetId === undefined || source.generationId === undefined) {
      throw new Error("The Play enrichment source is unavailable.");
    }
    const selection = await selectContactRecords(
      run,
      run.execution.stages.find(
        (candidate) => candidate.operationId === "contacts.discover"
      ) ?? source
    );
    const common = {
      actor,
      authorityEnvelopeId: run.definition.authorityEnvelopeId,
      budget: remainingBudget(run),
      contactDatasetId: source.datasetId,
      contactRecordIds: selection.recordIds.map(toRecordId),
      correlationId: toCorrelationId(`play-${suffix}`),
      deadline: toInstant(run.definition.deadlineMs),
      operationId: toIdempotencyKey(`play-${suffix}`),
    } as const;
    const result =
      stage.operationId === "contacts.identity.reveal"
        ? await deriveIdentities(common)
        : await deriveWorkEmails({
            ...common,
            kind:
              stage.operationId === "contacts.work-email.verify"
                ? "verify"
                : "resolve",
          });
    if (!result.ok) {
      throw new Error("The selected-contact enrichment stage was rejected.");
    }
    return {
      ...snapshotFromCreation(result.value.creation),
      selectedRecordIds: selection.recordIds,
      selectionReasons: selection.reasons,
    };
  };

  const startStage = (
    run: StoredGtmPlayRun,
    stage: GtmPlayRunStageReceipt
  ): Promise<GtmPlayGenerationSnapshot> => {
    if (stage.operationId === "organizations.discover") {
      return startOrganizationStage(run, stage);
    }
    if (stage.operationId === "contacts.discover") {
      return startContactStage(run, stage);
    }
    return startEnrichmentStage(run, stage);
  };

  const projectWorkbook = async (
    run: StoredGtmPlayRun,
    stage: GtmPlayRunStageReceipt
  ): Promise<GtmPlayProjectionResult> => {
    const source = previousCompletedStage(run, stage);
    if (
      source?.datasetId === undefined ||
      source.materializationId === undefined
    ) {
      throw new Error("The final Play dataset is unavailable.");
    }
    const page = await runtime.datasetRecordPages.listPage(
      { workspaceId: run.workspaceId },
      {
        afterOrdinal: 0,
        datasetId: source.datasetId,
        limit: Math.max(1, Math.min(100, source.recordCount ?? 3)),
        materializationId: source.materializationId,
      }
    );
    if (page === undefined || page.materialization.state !== "ready") {
      throw new Error("The final Play materialization is not ready.");
    }
    const selectedRecordIds =
      run.execution.selectedRecordIds.length > 0
        ? run.execution.selectedRecordIds
        : page.items.map(({ record }) => record.recordId);
    const selectionReasons =
      run.execution.selectionReasons.length > 0
        ? run.execution.selectionReasons
        : selectedRecordIds.map((recordId) => ({
            reasons: ["bounded_play_result"],
            recordId,
          }));
    const workbookId = `workbook_${stableSuffix(run, stage)}`;
    const write = await runtime.gtm.putWorkbookView(
      { workspaceId: run.workspaceId },
      {
        annotations: [],
        approvals: [],
        columnOrder: page.fields.map((field) => field.key),
        contextRef: run.definition.contextRef,
        datasetId: source.datasetId,
        expectedRevision: 0,
        filters: [],
        materializationId: source.materializationId,
        name: `Play ${run.playId} review`,
        playId: run.playId,
        playRevision: run.playRevision,
        playRunId: run.runId,
        selectionReasons,
        selectedRecordIds,
        workbookId,
      }
    );
    if (write.status === "conflict") {
      const existing = await runtime.gtm.getWorkbookView(
        { workspaceId: run.workspaceId },
        workbookId
      );
      if (
        existing === undefined ||
        existing.playRunId !== run.runId ||
        existing.datasetId !== source.datasetId ||
        existing.materializationId !== source.materializationId
      ) {
        throw new Error("The deterministic Workbook identity conflicts.");
      }
    }
    return {
      provenance: ["workbook:durable-projection", "delivery:no_send"],
      result: {
        datasetId: source.datasetId,
        exportReady:
          run.definition.delivery.privateExport &&
          run.definition.approvals.export,
        materializationId: source.materializationId,
        recordCount: page.materialization.recordCount,
        workbookId,
      },
    };
  };

  return { inspectGeneration, projectWorkbook, startStage };
};
