import assert from "node:assert/strict";
import test from "node:test";

import type {
  ApplyRecipeDependencies,
  AuthenticateApiKeyDependencies,
  CancelRunDependencies,
  CreateRunFromPlanDependencies,
  ExportRecipeApplicationDependencies,
  GetRecipeApplicationStatusDependencies,
  GetRunDependencies,
  ImportDatasetDependencies,
  ListCapabilitiesDependencies,
  QuoteRunPlanDependencies,
} from "@kurobara/application";

import { composeApi } from "../src/main.ts";

test("wires the API root to the application use case without a transport framework", async () => {
  const notExercised = (): Promise<never> =>
    Promise.reject(new Error("not exercised by composition smoke test"));
  const notExercisedStream = (): AsyncIterable<never> => ({
    [Symbol.asyncIterator]: () => ({ next: notExercised }),
  });
  const runCreation: CreateRunFromPlanDependencies = {
    clock: { now: notExercised },
    identifiers: {
      nextEventId: notExercised,
      nextOutboxMessageId: notExercised,
      nextRunId: notExercised,
    },
    persistence: {
      transaction: notExercised,
    },
    requiredPermission: "runs:create",
  };
  const authentication: AuthenticateApiKeyDependencies = {
    apiKeys: { authenticate: notExercised },
    clock: runCreation.clock,
  };
  const capabilityDiscovery: ListCapabilitiesDependencies = {
    catalog: { listAvailable: notExercised },
    clock: runCreation.clock,
    persistence: { transaction: notExercised },
    requiredPermission: "capabilities:list",
  };
  const planning: QuoteRunPlanDependencies = {
    clock: runCreation.clock,
    identifiers: {
      nextQuoteId: notExercised,
      nextRunPlanId: notExercised,
    },
    persistence: {
      transaction: notExercised,
    },
    routes: { listAvailable: () => [] },
  };
  const runQuery: GetRunDependencies = {
    requiredPermission: "runs:read",
    runs: { get: notExercised },
  };
  const runCancellation: CancelRunDependencies = {
    clock: runCreation.clock,
    identifiers: runCreation.identifiers,
    persistence: { transaction: notExercised },
    requiredPermission: "runs:cancel",
  };
  const recipeApplicationWatch: GetRecipeApplicationStatusDependencies = {
    requiredPermission: "recipes:read",
    watches: { get: notExercised },
  };
  const datasetImport: ImportDatasetDependencies = {
    codecs: {
      csv: {
        codecVersion: "1.0.0",
        decode: notExercisedStream,
        encode: notExercisedStream,
        format: "csv",
      },
      jsonl: {
        codecVersion: "1.0.0",
        decode: notExercisedStream,
        encode: notExercisedStream,
        format: "jsonl",
      },
    },
    datasets: {
      appendImportBatch: notExercised,
      beginImport: notExercised,
      finishImport: notExercised,
      getDataset: notExercised,
      isFieldSetComplete: notExercised,
      resetImport: notExercised,
      streamImportIssues: notExercisedStream,
      streamRecords: notExercisedStream,
    },
    requiredPermission: "datasets:import",
  };
  const recipeApply: ApplyRecipeDependencies = {
    applicationIdentifiers: { nextRecipeApplicationId: notExercised },
    clock: runCreation.clock,
    datasets: datasetImport.datasets,
    identifiers: runCreation.identifiers,
    inputValidator: { validate: notExercised },
    persistence: { transaction: notExercised },
    planningIdentifiers: planning.identifiers,
    recipes: {
      streamExactProjection: notExercisedStream,
      transaction: notExercised,
    },
    routes: planning.routes,
  };
  const recipeApplicationExport: ExportRecipeApplicationDependencies = {
    codecs: datasetImport.codecs,
    datasets: datasetImport.datasets,
    maxExportBytes: 1_073_741_824,
    maxRecordBytes: 16_777_216,
    persistence: recipeApply.recipes,
    requiredPermission: "recipes:export",
  };
  const datasetGenerationPersistence = {
    get: notExercised,
    transaction: notExercised,
  };
  const contactPrivacyGuard = { allows: async () => true };
  const contactPrivacyPersistence = {
    findBySubjectKeys: notExercised,
    register: notExercised,
  };
  const contactPrivacySubjectKeys = { derive: notExercised };
  const contactPrivacySubjects = { loadAuthorization: notExercised };

  const composition = composeApi({
    authentication,
    capabilityDiscovery,
    contactPrivacyGuard,
    contactPrivacyRestriction: {
      clock: runCreation.clock,
      persistence: contactPrivacyPersistence,
      requiredPermission: "contacts:privacy",
      subjectKeys: contactPrivacySubjectKeys,
    },
    datasetGenerationAuthorization: {
      clock: runCreation.clock,
      identifiers: runCreation.identifiers,
      persistence: { transaction: notExercised },
    },
    datasetGenerationCancellation: {
      clock: runCreation.clock,
      identifiers: runCreation.identifiers,
      persistence: { transaction: notExercised },
      requiredPermission: "datasets:generate",
    },
    datasetGenerationCreation: {
      clock: runCreation.clock,
      identifiers: { nextDatasetGenerationId: notExercised },
      persistence: datasetGenerationPersistence,
    },
    datasetGenerationPlanning: {
      clock: runCreation.clock,
      identifiers: { nextDatasetGenerationPlanId: notExercised },
      normalizer: {
        normalize: () => {
          throw new Error("not exercised by composition smoke test");
        },
      },
      persistence: {
        findByIdempotencyKey: notExercised,
        get: notExercised,
        transaction: notExercised,
      },
      snapshots: { resolve: notExercised },
    },
    datasetGenerationResults: {
      generations: datasetGenerationPersistence,
      privacy: {
        guard: contactPrivacyGuard,
        subjects: contactPrivacySubjects,
      },
      records: { listPage: notExercised },
      requiredPermission: "datasets:read",
    },
    datasetGenerationSelectionSources: {
      identity: { load: notExercised },
      workEmail: {
        loadIdentity: notExercised,
        loadWorkEmail: notExercised,
      },
    },
    datasetGenerationStatus: {
      persistence: datasetGenerationPersistence,
      requiredPermission: "datasets:read",
    },
    datasetExport: {
      codecs: datasetImport.codecs,
      contactPrivacy: {
        clock: runCreation.clock,
        guard: contactPrivacyGuard,
        requiredPermission: "contacts:export",
        subjects: contactPrivacySubjects,
      },
      datasets: datasetImport.datasets,
      requiredPermission: "datasets:export",
    },
    exportDelivery: {
      authorizeContactEffect: notExercised,
      clock: runCreation.clock,
      persistence: {
        complete: notExercised,
        getOwned: notExercised,
        prepare: notExercised,
        revoke: notExercised,
      },
      requiredPermission: "contacts:export",
      subjectKeys: contactPrivacySubjectKeys,
    },
    datasetImport,
    planning,
    recipeApplicationExport,
    recipeApplicationWatch,
    recipeApply,
    runCancellation,
    runCreation,
    runQuery,
  });

  assert.equal(typeof composition.applyRecipe, "function");
  assert.equal(typeof composition.authenticateApiKey, "function");
  assert.equal(typeof composition.cancelRun, "function");
  assert.equal(typeof composition.createRun, "function");
  assert.equal(typeof composition.createRunFromPlan, "function");
  assert.equal(typeof composition.discoverContacts, "function");
  assert.equal(typeof composition.deriveContactIdentities, "function");
  assert.equal(typeof composition.deriveContactWorkEmails, "function");
  assert.equal(typeof composition.discoverOrganizations, "function");
  assert.equal(typeof composition.exportDataset, "function");
  assert.equal(typeof composition.getDatasetGeneration, "function");
  assert.equal(typeof composition.getExportDelivery, "function");
  assert.equal(typeof composition.getRecipeApplicationStatus, "function");
  assert.equal(typeof composition.exportRecipeApplication, "function");
  assert.equal(typeof composition.getRun, "function");
  assert.equal(typeof composition.importDataset, "function");
  assert.equal(typeof composition.listCapabilities, "function");
  assert.equal(typeof composition.listContactCandidates, "function");
  assert.equal(typeof composition.listCompanyCandidates, "function");
  assert.equal(typeof composition.quoteRunPlan, "function");
  assert.equal(typeof composition.restrictContactPrivacy, "function");
  assert.equal(typeof composition.revokeExportDelivery, "function");

  const unauthorizedActor = {
    actorId: "actor-synthetic",
    authenticationMode: "api-key",
    credentialId: "credential-synthetic",
    permissions: [],
    workspaceId: "workspace-synthetic",
  } as unknown as Parameters<
    typeof composition.deriveContactIdentities
  >[0]["actor"];
  const selectedContactRequest = {
    actor: unauthorizedActor,
    authorityEnvelopeId: "authority-synthetic",
    budget: { limit: 1, unit: "credits" },
    contactDatasetId: "contacts-synthetic",
    contactRecordIds: ["contact-synthetic"],
    correlationId: "correlation-synthetic",
    deadline: 1_752_700_060_000,
    operationId: "operation-synthetic",
  } as unknown as Parameters<typeof composition.deriveContactIdentities>[0];
  const identityResult = await composition.deriveContactIdentities(
    selectedContactRequest
  );
  assert.equal(identityResult.ok, false);
  if (!identityResult.ok) {
    assert.equal(identityResult.error.code, "contact-selection-invalid");
    assert.equal(identityResult.error.stage, "selection");
  }
  const workEmailResult = await composition.deriveContactWorkEmails({
    ...selectedContactRequest,
    kind: "resolve",
  } as Parameters<typeof composition.deriveContactWorkEmails>[0]);
  assert.equal(workEmailResult.ok, false);
  if (!workEmailResult.ok) {
    assert.equal(workEmailResult.error.code, "contact-selection-invalid");
    assert.equal(workEmailResult.error.stage, "selection");
  }
  const exportResult = await composition.exportDataset({
    actor: unauthorizedActor,
    datasetId: "derived-contacts-synthetic",
    format: "jsonl",
    maxRecordBytes: 16_777_216,
  } as Parameters<typeof composition.exportDataset>[0]);
  assert.equal(exportResult.ok, false);
  if (!exportResult.ok) {
    assert.equal(exportResult.error.code, "authority-permission-missing");
  }
});
