import {
  type ApplyRecipeDependencies,
  type AuthenticateApiKeyDependencies,
  type AuthorizeDatasetGenerationPageDependencies,
  authorizePrivacySafeContactDiscovery,
  type CancelDatasetGenerationDependencies,
  type CancelRunDependencies,
  type CreateDatasetGenerationDependencies,
  type CreateRunFromPlanDependencies,
  type ExportRecipeApplicationDependencies,
  type GetRecipeApplicationStatusDependencies,
  type GetRunDependencies,
  type ImportDatasetDependencies,
  type ListCapabilitiesDependencies,
  type ListCompanyCandidatesDependencies,
  type ListContactCandidatesDependencies,
  makeApplyRecipe,
  makeAuthenticateApiKey,
  makeAuthorizeDatasetGenerationPage,
  makeCancelDatasetGeneration,
  makeCancelRun,
  makeCreateDatasetGeneration,
  makeCreateRun,
  makeCreateRunFromPlan,
  makeDeriveSelectedContactIdentities,
  makeDeriveSelectedContactWorkEmails,
  makeDiscoverContacts,
  makeDiscoverOrganizations,
  makeExportDataset,
  makeExportRecipeApplication,
  makeGetDatasetGenerationStatus,
  makeGetExportDelivery,
  makeGetRecipeApplicationStatus,
  makeGetRunById,
  makeImportDataset,
  makeListCapabilities,
  makeListCompanyCandidates,
  makeListContactCandidates,
  makeLoadImportedCompanyCandidates,
  makeLoadReadyCompanyCandidates,
  makePlanDatasetGeneration,
  makePrepareExportDelivery,
  makeQuoteRunPlan,
  makeRestrictContactPrivacy,
  makeRevokeExportDelivery,
  type PlanDatasetGenerationDependencies,
  type QuoteRunPlanDependencies,
} from "@kurobara/application";

export type ApiComposition = Readonly<{
  applyRecipe: ReturnType<typeof makeApplyRecipe>;
  authenticateApiKey: ReturnType<typeof makeAuthenticateApiKey>;
  cancelRun: ReturnType<typeof makeCancelRun>;
  cancelDatasetGeneration: ReturnType<typeof makeCancelDatasetGeneration>;
  createRun: ReturnType<typeof makeCreateRun>;
  createRunFromPlan: ReturnType<typeof makeCreateRunFromPlan>;
  discoverContacts: ReturnType<typeof makeDiscoverContacts>;
  deriveContactIdentities: ReturnType<
    typeof makeDeriveSelectedContactIdentities
  >;
  deriveContactWorkEmails: ReturnType<
    typeof makeDeriveSelectedContactWorkEmails
  >;
  discoverOrganizations: ReturnType<typeof makeDiscoverOrganizations>;
  exportDataset: ReturnType<typeof makeExportDataset>;
  getExportDelivery: ReturnType<typeof makeGetExportDelivery>;
  getDatasetGeneration: ReturnType<typeof makeGetDatasetGenerationStatus>;
  getRecipeApplicationStatus: ReturnType<typeof makeGetRecipeApplicationStatus>;
  exportRecipeApplication: ReturnType<typeof makeExportRecipeApplication>;
  getRun: ReturnType<typeof makeGetRunById>;
  importDataset: ReturnType<typeof makeImportDataset>;
  listCapabilities: ReturnType<typeof makeListCapabilities>;
  listContactCandidates: ReturnType<typeof makeListContactCandidates>;
  listCompanyCandidates: ReturnType<typeof makeListCompanyCandidates>;
  quoteRunPlan: ReturnType<typeof makeQuoteRunPlan>;
  restrictContactPrivacy: ReturnType<typeof makeRestrictContactPrivacy>;
  revokeExportDelivery: ReturnType<typeof makeRevokeExportDelivery>;
}>;

export type ApiCompositionDependencies = Readonly<{
  recipeApply: ApplyRecipeDependencies;
  authentication: AuthenticateApiKeyDependencies;
  capabilityDiscovery: ListCapabilitiesDependencies;
  datasetImport: ImportDatasetDependencies;
  datasetGenerationAuthorization: AuthorizeDatasetGenerationPageDependencies;
  datasetGenerationCancellation: CancelDatasetGenerationDependencies;
  datasetGenerationCreation: CreateDatasetGenerationDependencies;
  datasetGenerationPlanning: PlanDatasetGenerationDependencies;
  datasetGenerationStatus: Parameters<typeof makeGetDatasetGenerationStatus>[0];
  datasetGenerationResults: ListCompanyCandidatesDependencies &
    ListContactCandidatesDependencies;
  datasetGenerationSelectionSources: Readonly<{
    identity: Parameters<
      typeof makeDeriveSelectedContactIdentities
    >[0]["source"];
    workEmail: Parameters<
      typeof makeDeriveSelectedContactWorkEmails
    >[0]["source"];
  }>;
  contactPrivacyGuard: Parameters<
    typeof makeDeriveSelectedContactIdentities
  >[0]["privacy"];
  contactPrivacyRestriction: Parameters<typeof makeRestrictContactPrivacy>[0];
  datasetExport: Parameters<typeof makeExportDataset>[0];
  exportDelivery: Parameters<typeof makePrepareExportDelivery>[0] &
    Readonly<{ requiredPermission: string }>;
  recipeApplicationExport: ExportRecipeApplicationDependencies;
  planning: QuoteRunPlanDependencies;
  recipeApplicationWatch: GetRecipeApplicationStatusDependencies;
  runCancellation: CancelRunDependencies;
  runCreation: CreateRunFromPlanDependencies;
  runQuery: GetRunDependencies;
}>;

export const composeApi = ({
  recipeApply,
  authentication,
  capabilityDiscovery,
  datasetImport,
  datasetGenerationAuthorization,
  datasetGenerationCancellation,
  datasetGenerationCreation,
  datasetGenerationPlanning,
  datasetGenerationStatus,
  datasetGenerationResults,
  datasetGenerationSelectionSources,
  contactPrivacyGuard,
  contactPrivacyRestriction,
  datasetExport,
  exportDelivery,
  recipeApplicationExport,
  planning,
  recipeApplicationWatch,
  runCancellation,
  runCreation,
  runQuery,
}: ApiCompositionDependencies): ApiComposition => {
  const authorizePage = makeAuthorizeDatasetGenerationPage(
    datasetGenerationAuthorization
  );
  const createGeneration = makeCreateDatasetGeneration(
    datasetGenerationCreation
  );
  const planGeneration = makePlanDatasetGeneration(datasetGenerationPlanning);
  const prepareExportDelivery = makePrepareExportDelivery(exportDelivery);
  return {
    applyRecipe: makeApplyRecipe(recipeApply),
    authenticateApiKey: makeAuthenticateApiKey(authentication),
    cancelDatasetGeneration: makeCancelDatasetGeneration(
      datasetGenerationCancellation
    ),
    cancelRun: makeCancelRun(runCancellation),
    createRun: makeCreateRun(runCreation),
    createRunFromPlan: makeCreateRunFromPlan(runCreation),
    discoverContacts: makeDiscoverContacts({
      authorizePage,
      authorizePrivacy: authorizePrivacySafeContactDiscovery,
      createGeneration,
      loadOrganizations: makeLoadReadyCompanyCandidates(
        datasetGenerationResults
      ),
      loadImportedOrganizations: makeLoadImportedCompanyCandidates({
        datasets: datasetImport.datasets,
      }),
      planGeneration,
    }),
    deriveContactIdentities: makeDeriveSelectedContactIdentities({
      authorizePage,
      createGeneration,
      planGeneration,
      privacy: contactPrivacyGuard,
      source: datasetGenerationSelectionSources.identity,
    }),
    deriveContactWorkEmails: makeDeriveSelectedContactWorkEmails({
      authorizePage,
      createGeneration,
      planGeneration,
      privacy: contactPrivacyGuard,
      source: datasetGenerationSelectionSources.workEmail,
    }),
    discoverOrganizations: makeDiscoverOrganizations({
      authorizePage,
      createGeneration,
      planGeneration,
    }),
    exportDataset: makeExportDataset({
      ...datasetExport,
      contactPrivacy: {
        ...datasetExport.contactPrivacy,
        prepareDelivery: prepareExportDelivery,
      },
    }),
    exportRecipeApplication: makeExportRecipeApplication(
      recipeApplicationExport
    ),
    getDatasetGeneration: makeGetDatasetGenerationStatus(
      datasetGenerationStatus
    ),
    getExportDelivery: makeGetExportDelivery(exportDelivery),
    getRecipeApplicationStatus: makeGetRecipeApplicationStatus(
      recipeApplicationWatch
    ),
    getRun: makeGetRunById(runQuery),
    importDataset: makeImportDataset(datasetImport),
    listCapabilities: makeListCapabilities(capabilityDiscovery),
    listContactCandidates: makeListContactCandidates(datasetGenerationResults),
    listCompanyCandidates: makeListCompanyCandidates(datasetGenerationResults),
    quoteRunPlan: makeQuoteRunPlan(planning),
    restrictContactPrivacy: makeRestrictContactPrivacy(
      contactPrivacyRestriction
    ),
    revokeExportDelivery: makeRevokeExportDelivery(exportDelivery),
  };
};
