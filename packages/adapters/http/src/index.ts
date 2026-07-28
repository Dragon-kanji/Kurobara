import { once } from "node:events";

import Busboy, { type BusboyFileStream } from "@fastify/busboy";
import {
  type ApplyRecipeDependencies,
  exportDeliveryEffectiveExpiresAt,
  type GtmService,
  type makeApplyRecipe,
  type makeAuthenticateApiKey,
  type makeCancelDatasetGeneration,
  type makeCancelRun,
  type makeCreateRun,
  type makeDeriveSelectedContactIdentities,
  type makeDeriveSelectedContactWorkEmails,
  type makeDiscoverContacts,
  type makeDiscoverOrganizations,
  type makeExportDataset,
  type makeExportRecipeApplication,
  type makeGetDatasetGenerationStatus,
  type makeGetExportDelivery,
  type makeGetRecipeApplicationStatus,
  type makeGetRunById,
  type makeImportDataset,
  type makeListCapabilities,
  type makeListCompanyCandidates,
  type makeListContactCandidates,
  type makeQuoteRunPlan,
  type makeRestrictContactPrivacy,
  type makeRevokeExportDelivery,
} from "@kurobara/application";
import {
  type ContactPrivacyRestrictRequest,
  type ContactsCandidatesListRequest,
  type ContactsDiscoverRequest,
  catalogFingerprint,
  type DatasetGenerationsCancelRequest,
  type DatasetGenerationsGetRequest,
  type DatasetsExportRequest,
  type ExportDeliveriesGetRequest,
  type ExportDeliveriesRevokeRequest,
  type GtmContextCommandRequest,
  type GtmContextStatusRequest,
  type GtmQuestionnaireRequest,
  type OrganizationsCandidatesListRequest,
  type OrganizationsDiscoverRequest,
  type PlayCommandRequest,
  type PlayRunGetRequest,
  type RecipeApplicationsExportRequest,
  type RecipeApplicationsGetRequest,
  type RecipesApplyRequest,
  type SelectedContactDerivedDatasetRequest,
  schemaIds,
  type WorkbookGetRequest,
  type WorkbookUpdateRequest,
} from "@kurobara/contracts";
import catalogManifest from "@kurobara/contracts/catalog-manifest.json" with {
  type: "json",
};
import datasetsExportOperation from "@kurobara/contracts/operations/datasets-export.json" with {
  type: "json",
};
import recipeApplicationsExportOperation from "@kurobara/contracts/operations/recipe-applications-export.json" with {
  type: "json",
};
import problemRegistryDocument from "@kurobara/contracts/problem-registry.json" with {
  type: "json",
};
import capabilitiesListRequestSchema from "@kurobara/contracts/schemas/capabilities-list-request.json" with {
  type: "json",
};
import capabilitiesListResponseSchema from "@kurobara/contracts/schemas/capabilities-list-response.json" with {
  type: "json",
};
import companyCandidateSchema from "@kurobara/contracts/schemas/company-candidate.json" with {
  type: "json",
};
import contactCandidateSchema from "@kurobara/contracts/schemas/contact-candidate.json" with {
  type: "json",
};
import contactDiscoveryExecutionQuerySchema from "@kurobara/contracts/schemas/contact-discovery-execution-query.json" with {
  type: "json",
};
import contactDiscoveryQuerySchema from "@kurobara/contracts/schemas/contact-discovery-query.json" with {
  type: "json",
};
import contactIdentityExecutionQuerySchema from "@kurobara/contracts/schemas/contact-identity-execution-query.json" with {
  type: "json",
};
import contactOrganizationDatasetSourceSchema from "@kurobara/contracts/schemas/contact-organization-dataset-source.json" with {
  type: "json",
};
import contactOrganizationSourceLineageSchema from "@kurobara/contracts/schemas/contact-organization-source-lineage.json" with {
  type: "json",
};
import contactPrivacyRestrictRequestSchema from "@kurobara/contracts/schemas/contact-privacy-restrict-request.json" with {
  type: "json",
};
import contactPrivacyRestrictResponseSchema from "@kurobara/contracts/schemas/contact-privacy-restrict-response.json" with {
  type: "json",
};
import contactWorkEmailExecutionQuerySchema from "@kurobara/contracts/schemas/contact-work-email-execution-query.json" with {
  type: "json",
};
import contactsCandidatesListRequestSchema from "@kurobara/contracts/schemas/contacts-candidates-list-request.json" with {
  type: "json",
};
import contactsCandidatesListResponseSchema from "@kurobara/contracts/schemas/contacts-candidates-list-response.json" with {
  type: "json",
};
import contactsDiscoverRequestSchema from "@kurobara/contracts/schemas/contacts-discover-request.json" with {
  type: "json",
};
import contactsDiscoverResponseSchema from "@kurobara/contracts/schemas/contacts-discover-response.json" with {
  type: "json",
};
import datasetSchema from "@kurobara/contracts/schemas/dataset.json" with {
  type: "json",
};
import datasetGenerationsCancelRequestSchema from "@kurobara/contracts/schemas/dataset-generations-cancel-request.json" with {
  type: "json",
};
import datasetGenerationsCancelResponseSchema from "@kurobara/contracts/schemas/dataset-generations-cancel-response.json" with {
  type: "json",
};
import datasetGenerationsGetRequestSchema from "@kurobara/contracts/schemas/dataset-generations-get-request.json" with {
  type: "json",
};
import datasetGenerationsGetResponseSchema from "@kurobara/contracts/schemas/dataset-generations-get-response.json" with {
  type: "json",
};
import datasetsExportRequestSchema from "@kurobara/contracts/schemas/datasets-export-request.json" with {
  type: "json",
};
import datasetsImportRequestSchema from "@kurobara/contracts/schemas/datasets-import-request.json" with {
  type: "json",
};
import datasetsImportResponseSchema from "@kurobara/contracts/schemas/datasets-import-response.json" with {
  type: "json",
};
import enrichmentRecipeSchema from "@kurobara/contracts/schemas/enrichment-recipe.json" with {
  type: "json",
};
import exportDeliveriesGetRequestSchema from "@kurobara/contracts/schemas/export-deliveries-get-request.json" with {
  type: "json",
};
import exportDeliveriesRevokeRequestSchema from "@kurobara/contracts/schemas/export-deliveries-revoke-request.json" with {
  type: "json",
};
import exportDeliveryRevokeResponseSchema from "@kurobara/contracts/schemas/export-delivery-revoke-response.json" with {
  type: "json",
};
import exportDeliveryStateResponseSchema from "@kurobara/contracts/schemas/export-delivery-state-response.json" with {
  type: "json",
};
import fieldSchema from "@kurobara/contracts/schemas/field.json" with {
  type: "json",
};
import gtmContextCommandRequestSchema from "@kurobara/contracts/schemas/gtm-context-command-request.json" with {
  type: "json",
};
import gtmContextCommandResponseSchema from "@kurobara/contracts/schemas/gtm-context-command-response.json" with {
  type: "json",
};
import gtmContextStatusRequestSchema from "@kurobara/contracts/schemas/gtm-context-status-request.json" with {
  type: "json",
};
import gtmContextStatusResponseSchema from "@kurobara/contracts/schemas/gtm-context-status-response.json" with {
  type: "json",
};
import gtmQuestionnaireRequestSchema from "@kurobara/contracts/schemas/gtm-questionnaire-request.json" with {
  type: "json",
};
import gtmQuestionnaireResponseSchema from "@kurobara/contracts/schemas/gtm-questionnaire-response.json" with {
  type: "json",
};
import organizationDiscoveryQuerySchema from "@kurobara/contracts/schemas/organization-discovery-query.json" with {
  type: "json",
};
import organizationsCandidatesListRequestSchema from "@kurobara/contracts/schemas/organizations-candidates-list-request.json" with {
  type: "json",
};
import organizationsCandidatesListResponseSchema from "@kurobara/contracts/schemas/organizations-candidates-list-response.json" with {
  type: "json",
};
import organizationsDiscoverRequestSchema from "@kurobara/contracts/schemas/organizations-discover-request.json" with {
  type: "json",
};
import organizationsDiscoverResponseSchema from "@kurobara/contracts/schemas/organizations-discover-response.json" with {
  type: "json",
};
import plansQuoteRequestSchema from "@kurobara/contracts/schemas/plans-quote-request.json" with {
  type: "json",
};
import plansQuoteResponseSchema from "@kurobara/contracts/schemas/plans-quote-response.json" with {
  type: "json",
};
import playCommandRequestSchema from "@kurobara/contracts/schemas/play-command-request.json" with {
  type: "json",
};
import playCommandResponseSchema from "@kurobara/contracts/schemas/play-command-response.json" with {
  type: "json",
};
import playRunGetRequestSchema from "@kurobara/contracts/schemas/play-run-get-request.json" with {
  type: "json",
};
import playRunGetResponseSchema from "@kurobara/contracts/schemas/play-run-get-response.json" with {
  type: "json",
};
import recipeApplicationsExportRequestSchema from "@kurobara/contracts/schemas/recipe-applications-export-request.json" with {
  type: "json",
};
import recipeApplicationsGetRequestSchema from "@kurobara/contracts/schemas/recipe-applications-get-request.json" with {
  type: "json",
};
import recipeApplicationsGetResponseSchema from "@kurobara/contracts/schemas/recipe-applications-get-response.json" with {
  type: "json",
};
import recipeCellInputSchema from "@kurobara/contracts/schemas/recipe-cell-input.json" with {
  type: "json",
};
import recipesApplyRequestSchema from "@kurobara/contracts/schemas/recipes-apply-request.json" with {
  type: "json",
};
import recipesApplyResponseSchema from "@kurobara/contracts/schemas/recipes-apply-response.json" with {
  type: "json",
};
import runsCancelRequestSchema from "@kurobara/contracts/schemas/runs-cancel-request.json" with {
  type: "json",
};
import runsCancelResponseSchema from "@kurobara/contracts/schemas/runs-cancel-response.json" with {
  type: "json",
};
import runsCreateRequestSchema from "@kurobara/contracts/schemas/runs-create-request.json" with {
  type: "json",
};
import runsCreateResponseSchema from "@kurobara/contracts/schemas/runs-create-response.json" with {
  type: "json",
};
import runsGetRequestSchema from "@kurobara/contracts/schemas/runs-get-request.json" with {
  type: "json",
};
import runsGetResponseSchema from "@kurobara/contracts/schemas/runs-get-response.json" with {
  type: "json",
};
import selectedContactDerivedDatasetRequestSchema from "@kurobara/contracts/schemas/selected-contact-derived-dataset-request.json" with {
  type: "json",
};
import selectedContactDerivedDatasetResponseSchema from "@kurobara/contracts/schemas/selected-contact-derived-dataset-response.json" with {
  type: "json",
};
import workbookGetRequestSchema from "@kurobara/contracts/schemas/workbook-get-request.json" with {
  type: "json",
};
import workbookGetResponseSchema from "@kurobara/contracts/schemas/workbook-get-response.json" with {
  type: "json",
};
import workbookUpdateRequestSchema from "@kurobara/contracts/schemas/workbook-update-request.json" with {
  type: "json",
};
import workbookUpdateResponseSchema from "@kurobara/contracts/schemas/workbook-update-response.json" with {
  type: "json",
};
import Ajv2020, { type ValidateFunction } from "ajv/dist/2020.js";
import { type Context, Hono } from "hono";

const MAX_AUTHORIZATION_HEADER_BYTES = 4096;
const MAX_CORRELATION_ID_LENGTH = 255;
const MAX_JSON_BODY_BYTES = 64 * 1024;
const MAX_IMPORT_BYTES = 1024 * 1024 * 1024;
const MAX_EXPORT_RECORD_BYTES = 16 * 1024 * 1024;
const JSON_MEDIA_TYPE = "application/json";
const MULTIPART_MEDIA_TYPE = "multipart/form-data";
const JSONL_MEDIA_TYPE = "application/x-ndjson";
const CSV_MEDIA_TYPE = "text/csv";
const PROBLEM_MEDIA_TYPE = "application/problem+json";
const BEARER_HEADER_PATTERN = /^Bearer ([^\s,]+)$/;
const CORRELATION_ID_PATTERN = /^[A-Za-z0-9._:-]+$/;

const PROBLEM_CODES = [
  "authentication-required",
  "authority-capability-missing",
  "authority-permission-missing",
  "authority-subject-mismatch",
  "dataset-generation-not-found",
  "dataset-import-conflict",
  "dataset-import-failed",
  "dataset-source-mismatch",
  "deadline-elapsed",
  "domain-rejected",
  "export-too-large",
  "export-delivery-not-found",
  "gtm-resource-not-found",
  "idempotency-key-reused",
  "intention-hash-mismatch",
  "internal-error",
  "invalid-budget",
  "invalid-credential",
  "method-not-allowed",
  "output-contract-violation",
  "payload-too-large",
  "quote-expired",
  "quote-unit-mismatch",
  "request-invalid",
  "revision-conflict",
  "recipe-application-export-unavailable",
  "recipe-application-not-found",
  "route-not-found",
  "run-not-found",
  "run-plan-already-consumed",
  "run-plan-not-found",
  "service-unavailable",
  "unsupported-media-type",
  "workspace-mismatch",
] as const;

type ProblemCode = (typeof PROBLEM_CODES)[number];
type ProblemStatus =
  | 400
  | 401
  | 403
  | 404
  | 405
  | 409
  | 413
  | 415
  | 422
  | 500
  | 503;

type ProblemMetadata = Readonly<{
  code: ProblemCode;
  retryable: boolean;
  status: ProblemStatus;
  title: string;
  type: string;
}>;

type AuthenticateApiKey = ReturnType<typeof makeAuthenticateApiKey>;
type AuthenticationResult = Awaited<ReturnType<AuthenticateApiKey>>;
type AuthenticatedActor = Extract<
  AuthenticationResult,
  Readonly<{ ok: true }>
>["value"];
type CreateRun = ReturnType<typeof makeCreateRun>;
type CancelRun = ReturnType<typeof makeCancelRun>;
type CancelDatasetGeneration = ReturnType<typeof makeCancelDatasetGeneration>;
type ApplyRecipe = ReturnType<typeof makeApplyRecipe>;
type ApplyRecipeRequest = Parameters<ApplyRecipe>[0];
type ExportRecipeApplication = ReturnType<typeof makeExportRecipeApplication>;
type ExportRecipeApplicationRequest = Parameters<ExportRecipeApplication>[0];
type ExportRecipeApplicationResult = Awaited<
  ReturnType<ExportRecipeApplication>
>;
type ExportRecipeApplicationValue = Extract<
  ExportRecipeApplicationResult,
  Readonly<{ ok: true }>
>["value"];
type GetRecipeApplicationStatus = ReturnType<
  typeof makeGetRecipeApplicationStatus
>;
type GetRunById = ReturnType<typeof makeGetRunById>;
type DiscoverOrganizations = ReturnType<typeof makeDiscoverOrganizations>;
type DiscoverContacts = ReturnType<typeof makeDiscoverContacts>;
type DeriveContactIdentities = ReturnType<
  typeof makeDeriveSelectedContactIdentities
>;
type DeriveContactWorkEmails = ReturnType<
  typeof makeDeriveSelectedContactWorkEmails
>;
type ExportDataset = ReturnType<typeof makeExportDataset>;
type ExportDatasetValue = Extract<
  Awaited<ReturnType<ExportDataset>>,
  Readonly<{ ok: true }>
>["value"];
type GetExportDelivery = ReturnType<typeof makeGetExportDelivery>;
type RestrictContactPrivacy = ReturnType<typeof makeRestrictContactPrivacy>;
type RevokeExportDelivery = ReturnType<typeof makeRevokeExportDelivery>;
type GetDatasetGeneration = ReturnType<typeof makeGetDatasetGenerationStatus>;
type ImportDataset = ReturnType<typeof makeImportDataset>;
type ImportDatasetRequest = Parameters<ImportDataset>[0];
type ImportDatasetResult = Awaited<ReturnType<ImportDataset>>;
type ListCapabilities = ReturnType<typeof makeListCapabilities>;
type ListCompanyCandidates = ReturnType<typeof makeListCompanyCandidates>;
type ListContactCandidates = ReturnType<typeof makeListContactCandidates>;
type QuoteRunPlan = ReturnType<typeof makeQuoteRunPlan>;
type GtmContextDocument = Parameters<GtmService["planContext"]>[0];
type GtmPlayDefinition = Parameters<GtmService["previewPlay"]>[1];
type GtmWorkbookViewWrite = Parameters<GtmService["saveWorkbook"]>[1];

type AdapterEnvironment = Readonly<{
  Variables: {
    correlationId: string;
  };
}>;

type AdapterContext = Context<AdapterEnvironment>;

export type HttpAdapterDependencies = Readonly<{
  applyRecipe: ApplyRecipe;
  authenticateApiKey: AuthenticateApiKey;
  cancelRun: CancelRun;
  cancelDatasetGeneration?: CancelDatasetGeneration;
  createRun: CreateRun;
  deriveContactIdentities?: DeriveContactIdentities;
  deriveContactWorkEmails?: DeriveContactWorkEmails;
  discoverContacts?: DiscoverContacts;
  discoverOrganizations?: DiscoverOrganizations;
  exportDataset?: ExportDataset;
  exportRecipeApplication: ExportRecipeApplication;
  getExportDelivery?: GetExportDelivery;
  getRecipeApplicationStatus: GetRecipeApplicationStatus;
  getRun: GetRunById;
  getDatasetGeneration?: GetDatasetGeneration;
  gtm?: GtmService;
  importDataset: ImportDataset;
  listCapabilities: ListCapabilities;
  listContactCandidates?: ListContactCandidates;
  listCompanyCandidates: ListCompanyCandidates;
  quoteRunPlan: QuoteRunPlan;
  readiness: () => boolean | Promise<boolean>;
  restrictContactPrivacy?: RestrictContactPrivacy;
  revokeExportDelivery?: RevokeExportDelivery;
}>;

export type HttpAdapterOptions = Readonly<{
  maxAuthorizationHeaderBytes?: number;
  maxBodyBytes?: number;
  maxExportRecordBytes?: number;
  maxImportBytes?: number;
}>;

type RunsCreateRequest = Readonly<{
  idempotency_key: string;
  intention_hash: string;
  run_plan_id: string;
}>;

type RunsCancelRequest = Readonly<{
  idempotency_key: string;
  run_id: string;
}>;

type RunsCancelBody = Readonly<{
  idempotency_key: string;
}>;

type DatasetGenerationsCancelBody = Readonly<{
  idempotency_key: string;
}>;

type CapabilitiesListRequest = Readonly<{
  authority_envelope_id: string;
}>;

type RunsGetRequest = Readonly<{
  run_id: string;
}>;

type PlansQuoteRequest = Readonly<{
  authority_envelope_id: string;
  budget: Readonly<{
    limit: number;
    unit: string;
  }>;
  deadline_ms: number;
  normalized_input_hash: string;
  workflow_content_hash: string;
  workflow_revision: string;
  workflow_spec_id: string;
  workspace_id: string;
}>;

type DatasetsImportRequest = Readonly<{
  batch_limits: Readonly<{
    max_bytes: number;
    max_items: number;
  }>;
  dataset: Readonly<{
    dataset_id: string;
    name: string;
    workspace_id: string;
  }>;
  fields: readonly Readonly<{
    dataset_id: string;
    field_id: string;
    key: string;
    label: string;
    value_type: "boolean" | "number" | "string";
    workspace_id: string;
  }>[];
  format: "csv" | "jsonl";
  import_id: string;
  max_record_bytes: number;
  source_content_hash: string;
}>;

type ProblemDetails = Readonly<{
  code: ProblemCode;
  correlation_id: string;
  detail?: string;
  retryable: boolean;
  status: ProblemStatus;
  title: string;
  type: string;
}>;

const isProblemCode = (value: string): value is ProblemCode =>
  (PROBLEM_CODES as readonly string[]).includes(value);

const isProblemStatus = (value: number): value is ProblemStatus =>
  [400, 401, 403, 404, 405, 409, 413, 415, 422, 500, 503].includes(value);

const problemMetadata = new Map<ProblemCode, ProblemMetadata>();
for (const entry of problemRegistryDocument.problems) {
  if (!(isProblemCode(entry.code) && isProblemStatus(entry.status))) {
    throw new Error(
      "The generated problem registry contains an invalid entry."
    );
  }
  problemMetadata.set(entry.code, {
    code: entry.code,
    retryable: entry.retryable,
    status: entry.status,
    title: entry.title,
    type: entry.type,
  });
}
for (const code of PROBLEM_CODES) {
  if (!problemMetadata.has(code)) {
    throw new Error(`The generated problem registry is missing ${code}.`);
  }
}

const ajv = new Ajv2020({
  allErrors: true,
  allowUnionTypes: true,
  strict: true,
  strictRequired: false,
  validateFormats: false,
});
for (const keyword of [
  "x-kurobara-data-classification",
  "x-kurobara-owner",
  "x-kurobara-publication-status",
  "x-kurobara-redaction",
  "x-kurobara-schema-version",
]) {
  ajv.addKeyword(keyword);
}
ajv.addSchema(datasetSchema);
ajv.addSchema(enrichmentRecipeSchema);
ajv.addSchema(fieldSchema);
ajv.addSchema(contactDiscoveryQuerySchema);
ajv.addSchema(contactOrganizationDatasetSourceSchema);
ajv.addSchema(contactOrganizationSourceLineageSchema);
ajv.addSchema(contactCandidateSchema);
ajv.addSchema(organizationDiscoveryQuerySchema);
ajv.addSchema(companyCandidateSchema);
ajv.addSchema(recipeCellInputSchema);
ajv.addSchema(gtmQuestionnaireRequestSchema);
ajv.addSchema(gtmQuestionnaireResponseSchema);
ajv.addSchema(gtmContextCommandRequestSchema);
ajv.addSchema(gtmContextCommandResponseSchema);
ajv.addSchema(gtmContextStatusRequestSchema);
ajv.addSchema(gtmContextStatusResponseSchema);
ajv.addSchema(playCommandRequestSchema);
ajv.addSchema(playCommandResponseSchema);
ajv.addSchema(playRunGetRequestSchema);
ajv.addSchema(playRunGetResponseSchema);
ajv.addSchema(workbookGetRequestSchema);
ajv.addSchema(workbookGetResponseSchema);
ajv.addSchema(workbookUpdateRequestSchema);
ajv.addSchema(workbookUpdateResponseSchema);

const validatorFor = <T>(schemaId: string): ValidateFunction<T> => {
  const validator = ajv.getSchema<T>(schemaId);
  if (validator === undefined) {
    throw new Error(
      `The generated contract validator is unavailable: ${schemaId}`
    );
  }
  return validator;
};

const validateOrganizationsDiscoverRequest =
  ajv.compile<OrganizationsDiscoverRequest>(organizationsDiscoverRequestSchema);
const validateOrganizationsDiscoverResponse = ajv.compile(
  organizationsDiscoverResponseSchema
);
const validateOrganizationsCandidatesListRequest =
  ajv.compile<OrganizationsCandidatesListRequest>(
    organizationsCandidatesListRequestSchema
  );
const validateOrganizationsCandidatesListResponse = ajv.compile(
  organizationsCandidatesListResponseSchema
);
const validateContactsCandidatesListRequest =
  ajv.compile<ContactsCandidatesListRequest>(
    contactsCandidatesListRequestSchema
  );
const validateContactsCandidatesListResponse = ajv.compile(
  contactsCandidatesListResponseSchema
);
const validateContactsDiscoverRequest = ajv.compile<ContactsDiscoverRequest>(
  contactsDiscoverRequestSchema
);
const validateContactsDiscoverResponse = ajv.compile(
  contactsDiscoverResponseSchema
);
const validateSelectedContactDerivedDatasetRequest =
  ajv.compile<SelectedContactDerivedDatasetRequest>(
    selectedContactDerivedDatasetRequestSchema
  );
const validateSelectedContactDerivedDatasetResponse = ajv.compile(
  selectedContactDerivedDatasetResponseSchema
);
const validateDatasetGenerationsGetRequest =
  ajv.compile<DatasetGenerationsGetRequest>(datasetGenerationsGetRequestSchema);
const validateDatasetGenerationsGetResponse = ajv.compile(
  datasetGenerationsGetResponseSchema
);
const validateDatasetGenerationsCancelRequest =
  ajv.compile<DatasetGenerationsCancelRequest>(
    datasetGenerationsCancelRequestSchema
  );
const validateDatasetGenerationsCancelBody =
  ajv.compile<DatasetGenerationsCancelBody>({
    additionalProperties: false,
    properties: {
      idempotency_key:
        datasetGenerationsCancelRequestSchema.properties.idempotency_key,
    },
    required: ["idempotency_key"],
    type: "object",
  });
const validateDatasetGenerationsCancelResponse = ajv.compile(
  datasetGenerationsCancelResponseSchema
);
const validateDatasetsExportRequest = ajv.compile<DatasetsExportRequest>(
  datasetsExportRequestSchema
);
const validateExportDeliveriesGetRequest =
  ajv.compile<ExportDeliveriesGetRequest>(exportDeliveriesGetRequestSchema);
const validateExportDeliveriesRevokeRequest =
  ajv.compile<ExportDeliveriesRevokeRequest>(
    exportDeliveriesRevokeRequestSchema
  );
const validateExportDeliveriesRevokeBody = ajv.compile({
  additionalProperties: false,
  type: "object",
});
const validateExportDeliveryStateResponse = ajv.compile(
  exportDeliveryStateResponseSchema
);
const validateExportDeliveryRevokeResponse = ajv.compile(
  exportDeliveryRevokeResponseSchema
);
const validateContactPrivacyRestrictRequest =
  ajv.compile<ContactPrivacyRestrictRequest>(
    contactPrivacyRestrictRequestSchema
  );
const validateContactPrivacyRestrictResponse = ajv.compile(
  contactPrivacyRestrictResponseSchema
);

const validateRunsCreateRequest = ajv.compile<RunsCreateRequest>(
  runsCreateRequestSchema
);
const validateRunsCancelRequest = ajv.compile<RunsCancelRequest>(
  runsCancelRequestSchema
);
const validateRunsCancelBody = ajv.compile<RunsCancelBody>({
  additionalProperties: false,
  properties: {
    idempotency_key: runsCancelRequestSchema.properties.idempotency_key,
  },
  required: ["idempotency_key"],
  type: "object",
});
const validateRunsCancelResponse = ajv.compile(runsCancelResponseSchema);
const validateCapabilitiesListRequest = ajv.compile<CapabilitiesListRequest>(
  capabilitiesListRequestSchema
);
const validateCapabilitiesListResponse = ajv.compile(
  capabilitiesListResponseSchema
);
const validateRunsCreateResponse = ajv.compile(runsCreateResponseSchema);
const validatePlansQuoteRequest = ajv.compile<PlansQuoteRequest>(
  plansQuoteRequestSchema
);
const validatePlansQuoteResponse = ajv.compile(plansQuoteResponseSchema);
const validateRunsGetRequest =
  ajv.compile<RunsGetRequest>(runsGetRequestSchema);
const validateRunsGetResponse = ajv.compile(runsGetResponseSchema);
const validateDatasetsImportRequest = ajv.compile<DatasetsImportRequest>(
  datasetsImportRequestSchema
);
const validateDatasetsImportResponse = ajv.compile(
  datasetsImportResponseSchema
);
const validateRecipesApplyRequest = ajv.compile<RecipesApplyRequest>(
  recipesApplyRequestSchema
);
const validateRecipesApplyResponse = ajv.compile(recipesApplyResponseSchema);
const validateRecipeApplicationsExportRequest =
  ajv.compile<RecipeApplicationsExportRequest>(
    recipeApplicationsExportRequestSchema
  );
const validateRecipeApplicationsGetRequest =
  ajv.compile<RecipeApplicationsGetRequest>(recipeApplicationsGetRequestSchema);
const validateRecipeApplicationsGetResponse = ajv.compile(
  recipeApplicationsGetResponseSchema
);
const validateGtmQuestionnaireRequest = validatorFor<GtmQuestionnaireRequest>(
  gtmQuestionnaireRequestSchema.$id
);
const validateGtmQuestionnaireResponse = validatorFor(
  gtmQuestionnaireResponseSchema.$id
);
const validateGtmContextCommandRequest = validatorFor<GtmContextCommandRequest>(
  gtmContextCommandRequestSchema.$id
);
const validateGtmContextCommandResponse = validatorFor(
  gtmContextCommandResponseSchema.$id
);
const validateGtmContextStatusRequest = validatorFor<GtmContextStatusRequest>(
  gtmContextStatusRequestSchema.$id
);
const validateGtmContextStatusResponse = validatorFor(
  gtmContextStatusResponseSchema.$id
);
const validatePlayCommandRequest = validatorFor<PlayCommandRequest>(
  playCommandRequestSchema.$id
);
const validatePlayCommandResponse = validatorFor(playCommandResponseSchema.$id);
const validatePlayRunGetRequest = validatorFor<PlayRunGetRequest>(
  playRunGetRequestSchema.$id
);
const validatePlayRunGetResponse = validatorFor(playRunGetResponseSchema.$id);
const validateWorkbookGetRequest = validatorFor<WorkbookGetRequest>(
  workbookGetRequestSchema.$id
);
const validateWorkbookGetResponse = validatorFor(workbookGetResponseSchema.$id);
const validateWorkbookUpdateRequest = validatorFor<WorkbookUpdateRequest>(
  workbookUpdateRequestSchema.$id
);
const validateWorkbookUpdateResponse = validatorFor(
  workbookUpdateResponseSchema.$id
);
const validateRecipeCellInput = ajv.getSchema(schemaIds.RecipeCellInput);

const recipeCellInputCatalogMember = catalogManifest.members.find(
  (member) => member.id === schemaIds.RecipeCellInput
);
const organizationDiscoveryQueryCatalogMember = catalogManifest.members.find(
  (member) => member.id === schemaIds.OrganizationDiscoveryQuery
);
const contactDiscoveryExecutionQueryCatalogMember =
  catalogManifest.members.find(
    (member) => member.id === schemaIds.ContactDiscoveryExecutionQuery
  );
const contactIdentityExecutionQueryCatalogMember = catalogManifest.members.find(
  (member) => member.id === schemaIds.ContactIdentityExecutionQuery
);
const contactWorkEmailExecutionQueryCatalogMember =
  catalogManifest.members.find(
    (member) => member.id === schemaIds.ContactWorkEmailExecutionQuery
  );

if (
  validateRecipeCellInput === undefined ||
  recipeCellInputCatalogMember === undefined ||
  recipeCellInputCatalogMember.role !== "schema"
) {
  throw new Error(
    "The generated recipe-cell input contract is unavailable to the HTTP adapter."
  );
}

if (
  organizationDiscoveryQueryCatalogMember === undefined ||
  organizationDiscoveryQueryCatalogMember.role !== "schema"
) {
  throw new Error(
    "The generated organization-discovery query contract is unavailable to the HTTP adapter."
  );
}

if (
  contactDiscoveryExecutionQueryCatalogMember === undefined ||
  contactDiscoveryExecutionQueryCatalogMember.role !== "schema"
) {
  throw new Error(
    "The generated contact-discovery execution-query contract is unavailable to the HTTP adapter."
  );
}

if (
  contactIdentityExecutionQueryCatalogMember === undefined ||
  contactIdentityExecutionQueryCatalogMember.role !== "schema"
) {
  throw new Error(
    "The generated contact-identity execution-query contract is unavailable to the HTTP adapter."
  );
}

if (
  contactWorkEmailExecutionQueryCatalogMember === undefined ||
  contactWorkEmailExecutionQueryCatalogMember.role !== "schema"
) {
  throw new Error(
    "The generated contact-work-email execution-query contract is unavailable to the HTTP adapter."
  );
}

export const recipeCellInputContract = Object.freeze({
  catalogFingerprint,
  catalogVersion: catalogManifest.catalog_version,
  schemaFingerprint: recipeCellInputCatalogMember.fingerprint,
  schemaId: schemaIds.RecipeCellInput,
  schemaVersion: recipeCellInputSchema["x-kurobara-schema-version"],
});

export const organizationDiscoveryQueryContract = Object.freeze({
  catalogFingerprint,
  catalogVersion: catalogManifest.catalog_version,
  schemaFingerprint: organizationDiscoveryQueryCatalogMember.fingerprint,
  schemaId: schemaIds.OrganizationDiscoveryQuery,
  schemaVersion: organizationDiscoveryQuerySchema["x-kurobara-schema-version"],
});

export const contactDiscoveryExecutionQueryContract = Object.freeze({
  catalogFingerprint,
  catalogVersion: catalogManifest.catalog_version,
  schemaFingerprint: contactDiscoveryExecutionQueryCatalogMember.fingerprint,
  schemaId: schemaIds.ContactDiscoveryExecutionQuery,
  schemaVersion:
    contactDiscoveryExecutionQuerySchema["x-kurobara-schema-version"],
});

export const contactIdentityExecutionQueryContract = Object.freeze({
  catalogFingerprint,
  catalogVersion: catalogManifest.catalog_version,
  schemaFingerprint: contactIdentityExecutionQueryCatalogMember.fingerprint,
  schemaId: schemaIds.ContactIdentityExecutionQuery,
  schemaVersion:
    contactIdentityExecutionQuerySchema["x-kurobara-schema-version"],
});

export const contactWorkEmailExecutionQueryContract = Object.freeze({
  catalogFingerprint,
  catalogVersion: catalogManifest.catalog_version,
  schemaFingerprint: contactWorkEmailExecutionQueryCatalogMember.fingerprint,
  schemaId: schemaIds.ContactWorkEmailExecutionQuery,
  schemaVersion:
    contactWorkEmailExecutionQuerySchema["x-kurobara-schema-version"],
});

const contractsMatch = (
  left: Parameters<
    ApplyRecipeDependencies["inputValidator"]["validate"]
  >[0]["contract"],
  right: typeof recipeCellInputContract
): boolean =>
  left.catalogFingerprint === right.catalogFingerprint &&
  left.catalogVersion === right.catalogVersion &&
  left.schemaFingerprint === right.schemaFingerprint &&
  left.schemaId === right.schemaId &&
  left.schemaVersion === right.schemaVersion;

type RecipeCellInputValidator = ApplyRecipeDependencies["inputValidator"];

export const createRecipeCellInputValidator = (): RecipeCellInputValidator => {
  const validate: RecipeCellInputValidator["validate"] = ({
    contract,
    value,
  }) =>
    Promise.resolve(
      contractsMatch(contract, recipeCellInputContract) &&
        validateRecipeCellInput(value)
        ? {
            status: "accepted" as const,
            validatorVersion: "ajv-8.18.0-json-schema-2020-12",
          }
        : {
            reason: "input-contract-rejected" as const,
            status: "rejected" as const,
          }
    );
  return Object.freeze({ validate });
};

const recipeApplyCountsMatch = (value: {
  active_cell_count: number;
  bound_cell_count: number;
  cached_cell_count: number;
  created_run_count: number;
  total_cell_count: number;
}): boolean =>
  value.active_cell_count +
    value.bound_cell_count +
    value.cached_cell_count +
    value.created_run_count ===
  value.total_cell_count;

const recipeApplicationStatusMatches = (value: {
  bound_cell_count: number;
  failed_cell_count: number;
  pending_cell_count: number;
  running_cell_count: number;
  skipped_cell_count: number;
  state: string;
  succeeded_cell_count: number;
  terminal: boolean;
  total_cell_count: number;
  unbound_cell_count: number;
}): boolean => {
  if (
    value.bound_cell_count + value.unbound_cell_count !==
      value.total_cell_count ||
    value.pending_cell_count +
      value.running_cell_count +
      value.succeeded_cell_count +
      value.failed_cell_count +
      value.skipped_cell_count !==
      value.bound_cell_count
  ) {
    return false;
  }
  if (value.unbound_cell_count > 0) {
    return value.state === "needs_replay" && !value.terminal;
  }
  if (value.pending_cell_count > 0 || value.running_cell_count > 0) {
    return value.state === "running" && !value.terminal;
  }
  if (value.failed_cell_count > 0 || value.skipped_cell_count > 0) {
    return value.state === "completed_with_errors" && value.terminal;
  }
  return value.state === "succeeded" && value.terminal;
};

const safeDetailByCode: Readonly<Record<ProblemCode, string>> = {
  "authentication-required": "A valid Bearer credential is required.",
  "authority-capability-missing":
    "The authenticated authority does not cover this operation.",
  "authority-permission-missing":
    "The authenticated actor lacks permission for this operation.",
  "authority-subject-mismatch":
    "The requested authority does not authorize the authenticated actor.",
  "dataset-generation-not-found":
    "The requested dataset generation does not exist.",
  "dataset-import-conflict":
    "The import identity conflicts with existing dataset input.",
  "dataset-import-failed": "The dataset import could not be completed.",
  "dataset-source-mismatch":
    "The source does not match its declared content hash.",
  "deadline-elapsed":
    "The applicable authority or run plan deadline has elapsed.",
  "domain-rejected": "The run plan was rejected.",
  "export-delivery-not-found": "The export delivery was not found.",
  "export-too-large": "The requested export exceeds the configured limit.",
  "gtm-resource-not-found":
    "The requested GTM context, Play, run, or Workbook was not found.",
  "idempotency-key-reused":
    "The idempotency key was already used for another intention.",
  "intention-hash-mismatch":
    "The intention hash does not match the immutable run plan.",
  "internal-error": "The request could not be completed.",
  "invalid-budget": "The run plan budget is invalid.",
  "invalid-credential": "The presented credential is invalid.",
  "method-not-allowed": "The method is not allowed for this route.",
  "output-contract-violation":
    "The operation produced a response that violates its public contract.",
  "payload-too-large": "The request body exceeds the allowed size.",
  "quote-expired": "The run plan quote has expired.",
  "quote-unit-mismatch": "The quote and budget units do not match.",
  "recipe-application-export-unavailable":
    "The recipe application cannot be exported in its current state.",
  "recipe-application-not-found": "The recipe application was not found.",
  "request-invalid": "The request does not match its public contract.",
  "revision-conflict":
    "The resource changed since it was inspected; re-plan against the latest revision.",
  "route-not-found": "The requested route does not exist.",
  "run-not-found": "The run was not found.",
  "run-plan-already-consumed": "The run plan was already consumed.",
  "run-plan-not-found": "The run plan was not found.",
  "service-unavailable": "The service is not ready to accept requests.",
  "unsupported-media-type": "The request body uses an unsupported media type.",
  "workspace-mismatch": "The requested operation is not authorized.",
};

const metadataFor = (code: ProblemCode): ProblemMetadata => {
  const metadata = problemMetadata.get(code);
  if (metadata === undefined) {
    throw new Error("The generated problem registry is incomplete.");
  }
  return metadata;
};

const problemResponse = (
  context: AdapterContext,
  code: ProblemCode,
  headers?: Readonly<Record<string, string>>
): Response => {
  const metadata = metadataFor(code);
  const problem: ProblemDetails = {
    code,
    correlation_id: context.get("correlationId"),
    detail: safeDetailByCode[code],
    retryable: metadata.retryable,
    status: metadata.status,
    title: metadata.title,
    type: metadata.type,
  };

  return context.body(JSON.stringify(problem), metadata.status, {
    "content-type": PROBLEM_MEDIA_TYPE,
    ...headers,
  });
};

const generatedCorrelationId = (): string => globalThis.crypto.randomUUID();

const isValidCorrelationId = (value: string): boolean =>
  value.length > 0 &&
  value.length <= MAX_CORRELATION_ID_LENGTH &&
  CORRELATION_ID_PATTERN.test(value);

const extractBearerCredential = (
  header: string | undefined,
  maxHeaderBytes: number
): string | null => {
  if (
    header === undefined ||
    new TextEncoder().encode(header).byteLength > maxHeaderBytes
  ) {
    return null;
  }
  const match = BEARER_HEADER_PATTERN.exec(header);
  return match?.[1] ?? null;
};

const authenticate = async (
  context: AdapterContext,
  dependency: AuthenticateApiKey,
  maxAuthorizationHeaderBytes: number
): Promise<
  | Readonly<{ actor: AuthenticatedActor; ok: true }>
  | Readonly<{ ok: false; response: Response }>
> => {
  const presentedKey = extractBearerCredential(
    context.req.header("authorization"),
    maxAuthorizationHeaderBytes
  );
  if (presentedKey === null) {
    return {
      ok: false,
      response: problemResponse(context, "authentication-required", {
        "www-authenticate": "Bearer",
      }),
    };
  }

  const result = await dependency({ presentedKey });
  if (!result.ok) {
    return {
      ok: false,
      response: problemResponse(context, "invalid-credential", {
        "www-authenticate": "Bearer",
      }),
    };
  }
  return { actor: result.value, ok: true };
};

const hasJsonMediaType = (contentType: string | undefined): boolean =>
  contentType?.split(";", 1)[0]?.trim().toLowerCase() === JSON_MEDIA_TYPE;

type ReadJsonResult =
  | Readonly<{ code: "payload-too-large" | "request-invalid"; ok: false }>
  | Readonly<{ ok: true; value: unknown }>;

const readJsonBody = async (
  request: Request,
  maxBodyBytes: number
): Promise<ReadJsonResult> => {
  const stream = request.body;
  if (stream === null) {
    return { code: "request-invalid", ok: false };
  }

  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) {
        break;
      }
      totalBytes += next.value.byteLength;
      if (totalBytes > maxBodyBytes) {
        await reader.cancel();
        return { code: "payload-too-large", ok: false };
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }

  if (totalBytes === 0) {
    return { code: "request-invalid", ok: false };
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { code: "request-invalid", ok: false };
  }
};

const normalizedMediaType = (value: string | undefined): string | null => {
  const mediaType = value?.split(";", 1)[0]?.trim().toLowerCase();
  return mediaType === undefined || mediaType.length === 0 ? null : mediaType;
};

type MultipartProblemCode =
  | "payload-too-large"
  | "request-invalid"
  | "unsupported-media-type";

class MultipartRequestError extends Error {
  readonly code: MultipartProblemCode;

  constructor(code: MultipartProblemCode) {
    super(code);
    this.name = "MultipartRequestError";
    this.code = code;
  }
}

type Deferred<T> = Readonly<{
  promise: Promise<T>;
  resolve: (value: T) => void;
}>;

const deferred = <T>(): Deferred<T> => {
  let resolvePromise: ((value: T) => void) | undefined;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  if (resolvePromise === undefined) {
    throw new Error("The multipart completion promise was not initialized.");
  }
  return { promise, resolve: resolvePromise };
};

type MetadataResult =
  | Readonly<{ code: MultipartProblemCode; ok: false }>
  | Readonly<{ ok: true; value: DatasetsImportRequest }>;

const byteChunk = (value: unknown): Uint8Array => {
  if (!(value instanceof Uint8Array)) {
    throw new MultipartRequestError("request-invalid");
  }
  return value;
};

const readMultipartMetadata = async (
  stream: BusboyFileStream,
  maxBodyBytes: number
): Promise<MetadataResult> => {
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  let oversized = false;

  try {
    for await (const candidate of stream) {
      const chunk = byteChunk(candidate);
      totalBytes += chunk.byteLength;
      if (totalBytes > maxBodyBytes) {
        oversized = true;
      } else {
        chunks.push(chunk);
      }
    }
  } catch (error) {
    return error instanceof MultipartRequestError
      ? { code: error.code, ok: false }
      : { code: "request-invalid", ok: false };
  }

  if (oversized || stream.truncated) {
    return { code: "payload-too-large", ok: false };
  }
  if (totalBytes === 0) {
    return { code: "request-invalid", ok: false };
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const value: unknown = JSON.parse(text);
    return validateDatasetsImportRequest(value)
      ? { ok: true, value }
      : { code: "request-invalid", ok: false };
  } catch {
    return { code: "request-invalid", ok: false };
  }
};

const streamingSource = (
  stream: BusboyFileStream,
  maxImportBytes: number,
  parserCompletion: Promise<MultipartProblemCode | null>
): AsyncIterable<Uint8Array> => ({
  async *[Symbol.asyncIterator]() {
    let totalBytes = 0;
    const iterator: AsyncIterator<unknown> = stream.iterator({
      destroyOnReturn: false,
    });
    try {
      while (true) {
        const next = await iterator.next();
        if (next.done) {
          break;
        }
        const chunk = byteChunk(next.value);
        totalBytes += chunk.byteLength;
        if (totalBytes > maxImportBytes) {
          throw new MultipartRequestError("payload-too-large");
        }
        yield chunk;
      }
      if (stream.truncated) {
        throw new MultipartRequestError("payload-too-large");
      }
      const parserProblem = await parserCompletion;
      if (parserProblem !== null) {
        throw new MultipartRequestError(parserProblem);
      }
    } finally {
      if (!(stream.destroyed || stream.readableEnded)) {
        stream.resume();
      }
    }
  },
});

const importRequestFromMetadata = (
  actor: AuthenticatedActor,
  metadata: DatasetsImportRequest,
  bytes: AsyncIterable<Uint8Array>
): ImportDatasetRequest => {
  type DatasetId = ImportDatasetRequest["dataset"]["datasetId"];
  type FieldId = ImportDatasetRequest["fields"][number]["fieldId"];
  type WorkspaceId = ImportDatasetRequest["dataset"]["workspaceId"];
  const datasetId = metadata.dataset.dataset_id as DatasetId;
  const workspaceId = metadata.dataset.workspace_id as WorkspaceId;

  return {
    actor,
    batchLimits: {
      maxBytes: metadata.batch_limits.max_bytes,
      maxItems: metadata.batch_limits.max_items,
    },
    bytes,
    dataset: {
      datasetId,
      name: metadata.dataset.name,
      workspaceId,
    },
    fields: metadata.fields.map((field) => ({
      datasetId: field.dataset_id as DatasetId,
      fieldId: field.field_id as FieldId,
      key: field.key,
      label: field.label,
      valueType: field.value_type,
      workspaceId: field.workspace_id as WorkspaceId,
    })),
    format: metadata.format,
    importId: metadata.import_id,
    maxRecordBytes: metadata.max_record_bytes,
    sourceContentHash: metadata.source_content_hash,
  };
};

const applyRequestFromBody = (
  actor: AuthenticatedActor,
  correlationId: string,
  request: RecipesApplyRequest
): ApplyRecipeRequest => {
  type DatasetId = ApplyRecipeRequest["recipe"]["datasetId"];
  type EnrichmentRecipeId = ApplyRecipeRequest["recipe"]["enrichmentRecipeId"];
  type ContentHash = ApplyRecipeRequest["recipe"]["workflowContentHash"];
  type CorrelationId = ApplyRecipeRequest["correlationId"];
  type FieldId = ApplyRecipeRequest["recipe"]["inputFieldIds"][number];
  type WorkflowSpecId = ApplyRecipeRequest["recipe"]["workflowSpecId"];
  type WorkspaceId = ApplyRecipeRequest["recipe"]["workspaceId"];

  return {
    actor,
    ...(request.aggregate_budget === undefined
      ? {}
      : {
          aggregateBudget: {
            limit: request.aggregate_budget.limit,
            unit: request.aggregate_budget.unit,
          },
        }),
    applicationId: request.application_id,
    authorityEnvelopeId: request.authority_envelope_id,
    cellBudget: {
      limit: request.cell_budget.limit,
      unit: request.cell_budget.unit,
    },
    correlationId: correlationId as CorrelationId,
    deadlineMs: request.deadline_ms,
    maxCells: request.max_cells,
    ...(request.record_ids === undefined
      ? {}
      : { recordIds: request.record_ids as ApplyRecipeRequest["recordIds"] }),
    recipe: {
      datasetId: request.recipe.dataset_id as DatasetId,
      enrichmentRecipeId: request.recipe.recipe_id as EnrichmentRecipeId,
      inputFieldIds: request.recipe.input_field_ids.map(
        (fieldId) => fieldId as FieldId
      ),
      name: request.recipe.name,
      recipeRevision: request.recipe.recipe_revision,
      targetFieldId: request.recipe.target_field_id as FieldId,
      workflowContentHash: request.recipe.workflow_content_hash as ContentHash,
      workflowRevision: request.recipe.workflow_revision,
      workflowSpecId: request.recipe.workflow_spec_id as WorkflowSpecId,
      workspaceId: request.recipe.workspace_id as WorkspaceId,
    },
  };
};

const COMPANY_FIELDS = [
  ["name", "Company name", "string"],
  ["domain", "Company domain", "string"],
  ["country_code", "Headquarters country", "string"],
  ["industry_code", "Industry", "string"],
  ["employee_count", "Employee count", "number"],
  ["observed_at_ms", "Observed at", "number"],
] as const;

const organizationDiscoverRequestFromBody = (
  actor: AuthenticatedActor,
  correlationId: string,
  request: OrganizationsDiscoverRequest
): Parameters<DiscoverOrganizations>[0] => {
  type DiscoveryRequest = Parameters<DiscoverOrganizations>[0];
  type CapabilityId =
    DiscoveryRequest["planning"]["capability"]["capabilityId"];
  type CapabilityVersion =
    DiscoveryRequest["planning"]["capability"]["capabilityVersion"];
  type CorrelationId = DiscoveryRequest["execution"]["correlationId"];
  type DatasetId = DiscoveryRequest["planning"]["targetDataset"]["datasetId"];
  type FieldId = DiscoveryRequest["planning"]["fields"][number]["fieldId"];
  type IdempotencyKey = DiscoveryRequest["planning"]["idempotencyKey"];
  type Instant = DiscoveryRequest["planning"]["requestedDeadline"];
  type WorkspaceId = DiscoveryRequest["planning"]["workspaceId"];
  const datasetId = request.dataset_id as DatasetId;
  const workspaceId = actor.workspaceId as WorkspaceId;
  return {
    execution: {
      actorId: actor.actorId,
      actorPermissions: actor.permissions,
      authenticationMode: actor.authenticationMode,
      correlationId: correlationId as CorrelationId,
      workspaceId,
    },
    mode: request.mode === "dry-run" ? "dry_run" : "start",
    planning: {
      actorId: actor.actorId,
      authorityEnvelopeId: request.authority_envelope_id,
      capability: {
        capabilityId: "organizations.discover" as CapabilityId,
        capabilityVersion: "1.0.0" as CapabilityVersion,
      },
      fields: COMPANY_FIELDS.map(([key, label, valueType]) => ({
        datasetId,
        fieldId: `company_${key}` as FieldId,
        key,
        label,
        valueType,
        workspaceId,
      })),
      idempotencyKey: request.discovery_id as IdempotencyKey,
      limits: {
        maxCalls: request.limits.max_calls,
        maxCompanies: request.limits.max_companies,
        maxContactsPerCompany: 0,
        maxContactsTotal: 0,
        maxEnrichments: 0,
        maxPages: request.limits.max_pages,
        maxPhones: 0,
        maxResults: request.limits.max_companies,
      },
      query: structuredClone(request.query),
      requestedBudget: {
        limit: request.budget.limit,
        unit: request.budget.unit,
      },
      requestedDeadline: request.deadline_ms as Instant,
      targetDataset: {
        datasetId,
        name: request.dataset_name,
        workspaceId,
      },
      unknownCostPolicy: { mode: "deny" },
      workspaceId,
    },
  };
};

const mapOrganizationDiscoverFailure = (code: string): ProblemCode => {
  if (code === "authority-permission-missing") {
    return "authority-permission-missing";
  }
  if (code === "deadline-elapsed") {
    return "deadline-elapsed";
  }
  if (code === "idempotency-key-reused") {
    return "idempotency-key-reused";
  }
  if (code === "budget-exhausted" || code === "preflight-denied") {
    return "invalid-budget";
  }
  if (code === "snapshot-unavailable" || code === "route-unavailable") {
    return "service-unavailable";
  }
  if (
    code === "query-rejected" ||
    code === "request-invalid" ||
    code === "contact-selection-invalid"
  ) {
    return "request-invalid";
  }
  return "domain-rejected";
};

const generationResponseState = (
  mode: "dry_run" | "start",
  status: string | undefined
): "building" | "planned" | "ready" => {
  if (mode === "dry_run") {
    return "planned";
  }
  return status === "ready" ? "ready" : "building";
};

const organizationDiscoverResponse = (
  value: Extract<
    Awaited<ReturnType<DiscoverOrganizations>>,
    { ok: true }
  >["value"]
) => {
  const plan = value.plan;
  const generation =
    value.mode === "start" ? value.creation.generation : undefined;
  return {
    dataset_id: plan.requestIntent.targetDataset.datasetId,
    ...(generation === undefined
      ? {}
      : { generation_id: generation.generationId }),
    generation_plan_id: plan.generationPlanId,
    mode: value.mode === "dry_run" ? "dry-run" : "start",
    plan_hash: plan.planHash,
    query_hash: plan.queryHash,
    quote: {
      expires_at_ms: plan.quote.expiresAt,
      guarantee: plan.quote.guarantee,
      unit: plan.quote.unit,
      ...(plan.quote.upperBound === undefined
        ? {}
        : { upper_bound: plan.quote.upperBound }),
    },
    replayed: value.replayed,
    state: generationResponseState(value.mode, value.status),
    workspace_id: plan.workspaceId,
  } as const;
};

const CONTACT_FIELDS = [
  ["department", "Department", "string"],
  ["display_name", "Display name", "string"],
  ["identity_completeness", "Identity completeness", "string"],
  ["job_title", "Current job title", "string"],
  ["observed_at_ms", "Observed at", "number"],
  ["organization_domain", "Company domain", "string"],
  ["organization_id", "Company ID", "string"],
  ["organization_name", "Company name", "string"],
  ["person_country_code", "Person country", "string"],
  ["profile_url", "Professional profile", "string"],
  ["seniority", "Seniority", "string"],
] as const;

const contactDiscoverRequestFromBody = (
  actor: AuthenticatedActor,
  correlationId: string,
  request: ContactsDiscoverRequest
): Parameters<DiscoverContacts>[0] => {
  type DiscoveryRequest = Parameters<DiscoverContacts>[0];
  type CapabilityId =
    DiscoveryRequest["planning"]["capability"]["capabilityId"];
  type CapabilityVersion =
    DiscoveryRequest["planning"]["capability"]["capabilityVersion"];
  type CorrelationId = DiscoveryRequest["execution"]["correlationId"];
  type DatasetId = DiscoveryRequest["planning"]["targetDataset"]["datasetId"];
  type FieldId = DiscoveryRequest["planning"]["fields"][number]["fieldId"];
  type IdempotencyKey = DiscoveryRequest["planning"]["idempotencyKey"];
  type Instant = DiscoveryRequest["planning"]["requestedDeadline"];
  type WorkspaceId = DiscoveryRequest["planning"]["workspaceId"];
  const datasetId = request.dataset_id as DatasetId;
  const workspaceId = actor.workspaceId as WorkspaceId;
  const organizationSource =
    request.organization_dataset === undefined
      ? {
          generationId: request.organization_generation_id as string,
          kind: "generation" as const,
        }
      : {
          datasetId: request.organization_dataset.dataset_id,
          ...(request.organization_dataset.default_country_code === undefined
            ? {}
            : {
                defaultCountryCode:
                  request.organization_dataset.default_country_code,
              }),
          fieldMapping: {
            ...(request.organization_dataset.field_mapping.country_code ===
            undefined
              ? {}
              : {
                  countryCode:
                    request.organization_dataset.field_mapping.country_code,
                }),
            domain: request.organization_dataset.field_mapping.domain,
            ...(request.organization_dataset.field_mapping.name === undefined
              ? {}
              : { name: request.organization_dataset.field_mapping.name }),
          },
          kind: "dataset" as const,
        };
  const organizationSourceQuery = (
    organizationSource.kind === "generation"
      ? {
          generation_id: organizationSource.generationId,
          kind: "generation" as const,
        }
      : {
          dataset_id: organizationSource.datasetId,
          ...(organizationSource.defaultCountryCode === undefined
            ? {}
            : {
                default_country_code: organizationSource.defaultCountryCode,
              }),
          field_mapping: {
            ...(organizationSource.fieldMapping.countryCode === undefined
              ? {}
              : {
                  country_code: organizationSource.fieldMapping.countryCode,
                }),
            domain: organizationSource.fieldMapping.domain,
            ...(organizationSource.fieldMapping.name === undefined
              ? {}
              : { name: organizationSource.fieldMapping.name }),
          },
          kind: "dataset" as const,
        }
  ) as DiscoveryRequest["planning"]["query"];
  return {
    execution: {
      actorId: actor.actorId,
      actorPermissions: actor.permissions,
      authenticationMode: actor.authenticationMode,
      correlationId: correlationId as CorrelationId,
      workspaceId,
    },
    mode: request.mode === "dry-run" ? "dry_run" : "start",
    organizationSource,
    planning: {
      actorId: actor.actorId,
      authorityEnvelopeId: request.authority_envelope_id,
      capability: {
        capabilityId: "contacts.discover" as CapabilityId,
        capabilityVersion: "1.0.0" as CapabilityVersion,
      },
      fields: CONTACT_FIELDS.map(([key, label, valueType]) => ({
        datasetId,
        fieldId: `contact_${key}` as FieldId,
        key,
        label,
        valueType,
        workspaceId,
      })),
      idempotencyKey: request.discovery_id as IdempotencyKey,
      limits: {
        maxCalls: request.limits.max_calls,
        maxCompanies: request.limits.max_companies,
        maxContactsPerCompany: request.limits.max_contacts_per_company,
        maxContactsTotal: request.limits.max_contacts_total,
        maxEnrichments: 0,
        maxPages: request.limits.max_pages,
        maxPhones: 0,
        maxResults: request.limits.max_contacts_total,
      },
      query: {
        ...structuredClone(request.query),
        organization_source: organizationSourceQuery,
      },
      requestedBudget: {
        limit: request.budget.limit,
        unit: request.budget.unit,
      },
      requestedDeadline: request.deadline_ms as Instant,
      targetDataset: { datasetId, name: request.dataset_name, workspaceId },
      unknownCostPolicy: { mode: "deny" },
      workspaceId,
    },
  };
};

const contactDiscoverResponse = (
  value: Extract<Awaited<ReturnType<DiscoverContacts>>, { ok: true }>["value"]
) => {
  const plan = value.plan;
  const generation =
    value.mode === "start" ? value.creation.generation : undefined;
  const organizationSource =
    value.organizationSource.kind === "generation"
      ? {
          generation_id: value.organizationSource.generationId,
          kind: "generation" as const,
        }
      : {
          accepted: value.organizationSource.accepted,
          content_hash: value.organizationSource.contentHash,
          dataset_id: value.organizationSource.datasetId,
          ...(value.organizationSource.defaultCountryCode === undefined
            ? {}
            : {
                default_country_code:
                  value.organizationSource.defaultCountryCode,
              }),
          duplicates: value.organizationSource.duplicates,
          field_mapping: {
            ...(value.organizationSource.fieldMapping.countryCode === undefined
              ? {}
              : {
                  country_code:
                    value.organizationSource.fieldMapping.countryCode,
                }),
            domain: value.organizationSource.fieldMapping.domain,
            ...(value.organizationSource.fieldMapping.name === undefined
              ? {}
              : { name: value.organizationSource.fieldMapping.name }),
          },
          inspected: value.organizationSource.inspected,
          kind: "dataset" as const,
          materialization_id: value.organizationSource.materializationId,
          rejected: value.organizationSource.rejected,
          source_record_count: value.organizationSource.sourceRecordCount,
          truncated: value.organizationSource.truncated,
        };
  return {
    dataset_id: plan.requestIntent.targetDataset.datasetId,
    ...(generation === undefined
      ? {}
      : { generation_id: generation.generationId }),
    generation_plan_id: plan.generationPlanId,
    mode: value.mode === "dry_run" ? "dry-run" : "start",
    ...(value.organizationSource.kind === "generation"
      ? {
          organization_generation_id: value.organizationSource.generationId,
        }
      : {}),
    organization_source: organizationSource,
    plan_hash: plan.planHash,
    query_hash: plan.queryHash,
    quote: {
      expires_at_ms: plan.quote.expiresAt,
      guarantee: plan.quote.guarantee,
      unit: plan.quote.unit,
      ...(plan.quote.upperBound === undefined
        ? {}
        : { upper_bound: plan.quote.upperBound }),
    },
    replayed: value.replayed,
    state: generationResponseState(value.mode, value.status),
    workspace_id: plan.workspaceId,
  } as const;
};

const deriveContactIdentitiesRequestFromBody = (
  actor: AuthenticatedActor,
  correlationId: string,
  request: SelectedContactDerivedDatasetRequest
): Parameters<DeriveContactIdentities>[0] => ({
  actor,
  authorityEnvelopeId: request.authority_envelope_id,
  budget: { ...request.budget },
  contactDatasetId:
    request.contact_dataset_id as Parameters<DeriveContactIdentities>[0]["contactDatasetId"],
  contactRecordIds:
    request.contact_record_ids as Parameters<DeriveContactIdentities>[0]["contactRecordIds"],
  correlationId:
    correlationId as Parameters<DeriveContactIdentities>[0]["correlationId"],
  deadline:
    request.deadline_ms as Parameters<DeriveContactIdentities>[0]["deadline"],
  operationId:
    request.operation_id as Parameters<DeriveContactIdentities>[0]["operationId"],
});

const deriveContactWorkEmailsRequestFromBody = (
  actor: AuthenticatedActor,
  correlationId: string,
  request: SelectedContactDerivedDatasetRequest,
  kind: "resolve" | "verify"
): Parameters<DeriveContactWorkEmails>[0] => ({
  actor,
  authorityEnvelopeId: request.authority_envelope_id,
  budget: { ...request.budget },
  contactDatasetId:
    request.contact_dataset_id as Parameters<DeriveContactWorkEmails>[0]["contactDatasetId"],
  contactRecordIds:
    request.contact_record_ids as Parameters<DeriveContactWorkEmails>[0]["contactRecordIds"],
  correlationId:
    correlationId as Parameters<DeriveContactWorkEmails>[0]["correlationId"],
  deadline:
    request.deadline_ms as Parameters<DeriveContactWorkEmails>[0]["deadline"],
  kind,
  operationId:
    request.operation_id as Parameters<DeriveContactWorkEmails>[0]["operationId"],
});

const selectedContactDerivedDatasetResponse = (
  value:
    | Extract<
        Awaited<ReturnType<DeriveContactIdentities>>,
        { ok: true }
      >["value"]
    | Extract<
        Awaited<ReturnType<DeriveContactWorkEmails>>,
        { ok: true }
      >["value"],
  operationId: string
) => ({
  contact_dataset_id: value.sourceContactDatasetId,
  contact_record_ids: value.sourceContactRecordIds,
  generation_id: value.creation.generation.generationId,
  generation_plan_id: value.plan.generationPlanId,
  operation_id: operationId,
  replayed: value.replayed,
  result_dataset_id: value.creation.generation.datasetId,
  state: value.status === "ready" ? "ready" : "building",
  workspace_id: value.creation.generation.workspaceId,
});

const datasetGenerationResponse = (
  creation: Extract<
    Awaited<ReturnType<GetDatasetGeneration>>,
    { ok: true }
  >["value"]
) => ({
  cost: { ...creation.generation.cost },
  counters: { ...creation.generation.counters },
  dataset_id: creation.generation.datasetId,
  generation_id: creation.generation.generationId,
  generation_plan_id: creation.generation.generationPlanId,
  materialization_id: creation.materialization.materializationId,
  materialization_state: creation.materialization.state,
  record_count: creation.materialization.recordCount,
  state: creation.generation.state,
  ...(creation.generation.stop === undefined
    ? {}
    : {
        stop_reason: creation.generation.stop.reason,
        stop_requested_at_ms: creation.generation.stop.requestedAt,
      }),
  terminal: ["ambiguous", "cancelled", "completed", "failed"].includes(
    creation.generation.state
  ),
  workspace_id: creation.generation.workspaceId,
});

const exportRequestFromBody = (
  actor: AuthenticatedActor,
  request: RecipeApplicationsExportRequest
): ExportRecipeApplicationRequest => {
  type FieldId = NonNullable<
    ExportRecipeApplicationRequest["fieldIds"]
  >[number];

  return {
    actor,
    ...(request.field_ids === undefined
      ? {}
      : {
          fieldIds: request.field_ids.map(
            (requestedFieldId) => requestedFieldId as FieldId
          ),
        }),
    format: request.format,
    recipeApplicationId: request.application_id,
  };
};

const datasetExportRequestFromBody = (
  actor: AuthenticatedActor,
  request: DatasetsExportRequest,
  maxRecordBytes: number
): Parameters<ExportDataset>[0] => ({
  actor,
  datasetId: request.dataset_id as Parameters<ExportDataset>[0]["datasetId"],
  ...(request.field_ids === undefined
    ? {}
    : {
        fieldIds: request.field_ids as Parameters<ExportDataset>[0]["fieldIds"],
      }),
  format: request.format,
  maxRecordBytes,
});

const datasetExportMatchesRequest = (
  value: ExportDatasetValue,
  request: DatasetsExportRequest,
  actor: AuthenticatedActor
): boolean =>
  value.dataset.datasetId === request.dataset_id &&
  value.dataset.workspaceId === actor.workspaceId &&
  value.format === request.format &&
  Number.isSafeInteger(value.contentLength) &&
  value.contentLength >= 0 &&
  EXPORT_HASH_PATTERN.test(value.contentHash) &&
  (request.field_ids === undefined ||
    (value.fields.length === request.field_ids.length &&
      value.fields.every(
        (field, index) => field.fieldId === request.field_ids?.[index]
      )));

type ExportDelivery = Extract<
  Awaited<ReturnType<RevokeExportDelivery>>,
  Readonly<{ ok: true }>
>["value"];

const validLifecycleTimestamp = (value: number): boolean =>
  Number.isSafeInteger(value) && value >= 0;

const exportDeliveryLifecycleMatches = (delivery: ExportDelivery): boolean => {
  if (!validLifecycleTimestamp(delivery.preparedAt)) {
    return false;
  }
  if (delivery.state === "prepared") {
    return (
      delivery.deliveredAt === undefined && delivery.revokedAt === undefined
    );
  }
  if (delivery.state === "delivered") {
    return (
      delivery.deliveredAt !== undefined &&
      validLifecycleTimestamp(delivery.deliveredAt) &&
      delivery.deliveredAt >= delivery.preparedAt &&
      delivery.revokedAt === undefined
    );
  }
  return (
    delivery.revokedAt !== undefined &&
    validLifecycleTimestamp(delivery.revokedAt) &&
    delivery.revokedAt >= delivery.preparedAt &&
    (delivery.deliveredAt === undefined ||
      (validLifecycleTimestamp(delivery.deliveredAt) &&
        delivery.deliveredAt >= delivery.preparedAt &&
        delivery.deliveredAt <= delivery.revokedAt))
  );
};

const exportDeliveryOwnedBy = (
  delivery: ExportDelivery,
  actor: AuthenticatedActor
): boolean =>
  delivery.manifest.ownerActorId === actor.actorId &&
  delivery.manifest.workspaceId === actor.workspaceId;

const exportDeliveryResponse = (
  delivery: ExportDelivery,
  effectiveExpiresAt: number,
  state: "delivered" | "expired" | "prepared" | "revoked"
) => ({
  content_hash: delivery.manifest.contentHash,
  content_length: delivery.manifest.contentLength,
  dataset_id: delivery.manifest.datasetId,
  delivered_at_ms: delivery.deliveredAt,
  delivery_id: delivery.deliveryId,
  expires_at_ms: effectiveExpiresAt,
  format: delivery.manifest.format,
  prepared_at_ms: delivery.preparedAt,
  revoked_at_ms: delivery.revokedAt,
  state,
});

const exportDeliveryReadbackMatches = (
  value: Extract<
    Awaited<ReturnType<GetExportDelivery>>,
    Readonly<{ ok: true }>
  >["value"],
  actor: AuthenticatedActor
): boolean => {
  const { delivery, effectiveExpiresAt, state } = value;
  const stateMatches =
    (delivery.state === "prepared" &&
      (state === "prepared" || state === "expired")) ||
    (delivery.state === "delivered" &&
      (state === "delivered" || state === "expired")) ||
    (delivery.state === "revoked" && state === "revoked");
  const timestampsMatch = exportDeliveryLifecycleMatches(delivery);
  return (
    exportDeliveryOwnedBy(delivery, actor) &&
    delivery.deliveryId.length > 0 &&
    Number.isSafeInteger(effectiveExpiresAt) &&
    effectiveExpiresAt >= 0 &&
    effectiveExpiresAt === exportDeliveryEffectiveExpiresAt(delivery) &&
    stateMatches &&
    timestampsMatch
  );
};

const datasetExportDeliveryHeaders = (
  value: ExportDatasetValue,
  actor: AuthenticatedActor
): Readonly<Record<string, string>> | null => {
  const delivery = value.delivery;
  if (delivery === undefined) {
    return {};
  }
  const effectiveExpiresAt = exportDeliveryEffectiveExpiresAt(delivery);
  if (
    !exportDeliveryOwnedBy(delivery, actor) ||
    delivery.deliveryId.length === 0 ||
    delivery.state === "revoked" ||
    !exportDeliveryLifecycleMatches(delivery) ||
    delivery.manifest.contentHash !== value.contentHash ||
    delivery.manifest.contentLength !== value.contentLength ||
    delivery.manifest.datasetId !== value.dataset.datasetId ||
    delivery.manifest.format !== value.format ||
    delivery.manifest.fieldIds.length !== value.fields.length ||
    !delivery.manifest.fieldIds.every(
      (fieldId, index) => fieldId === value.fields[index]?.fieldId
    ) ||
    !Number.isSafeInteger(effectiveExpiresAt) ||
    effectiveExpiresAt <= delivery.preparedAt
  ) {
    return null;
  }
  return {
    "x-kurobara-delivery-expires-at-ms": String(effectiveExpiresAt),
    "x-kurobara-delivery-id": delivery.deliveryId,
    "x-kurobara-delivery-state": delivery.state,
  };
};

const contactPrivacyRestrictionRequestFromBody = (
  actor: AuthenticatedActor,
  request: ContactPrivacyRestrictRequest
): Parameters<RestrictContactPrivacy>[0] => ({
  actor,
  idempotencyKey:
    request.idempotency_key as Parameters<RestrictContactPrivacy>[0]["idempotencyKey"],
  reason: request.reason,
  subject:
    request.subject.kind === "email"
      ? request.subject
      : {
          kind: "provider-subject",
          providerKey: request.subject.provider_key,
          value: request.subject.value,
        },
});

type MultipartImportResult =
  | Readonly<{ code: MultipartProblemCode; ok: false }>
  | Readonly<{ ok: true; result: ImportDatasetResult }>;

type SourceTaskResult =
  | MultipartImportResult
  | Readonly<{ error: unknown; ok: false }>;

const multipartProblemPriority: Readonly<Record<MultipartProblemCode, number>> =
  {
    "payload-too-large": 3,
    "request-invalid": 2,
    "unsupported-media-type": 1,
  };

const pumpRequestIntoBusboy = async (
  request: Request,
  busboy: ReturnType<typeof Busboy>,
  stopActiveParts: () => void
): Promise<void> => {
  const body = request.body;
  if (body === null) {
    throw new MultipartRequestError("request-invalid");
  }
  const reader = body.getReader();
  let aborted = request.signal.aborted;
  const abort = (): void => {
    aborted = true;
    reader.cancel().catch(() => undefined);
  };
  request.signal.addEventListener("abort", abort, { once: true });
  try {
    if (aborted) {
      throw new MultipartRequestError("request-invalid");
    }
    while (true) {
      const next = await reader.read();
      if (aborted) {
        throw new MultipartRequestError("request-invalid");
      }
      if (next.done) {
        break;
      }
      if (!busboy.write(next.value)) {
        await once(busboy, "drain");
      }
    }
    busboy.end();
  } catch (error) {
    stopActiveParts();
    busboy.destroy();
    throw error;
  } finally {
    request.signal.removeEventListener("abort", abort);
    reader.releaseLock();
  }
};

const runDatasetSourceTask = async (
  actor: AuthenticatedActor,
  metadataTask: Promise<MetadataResult>,
  stream: BusboyFileStream,
  mimeType: string,
  importDataset: ImportDataset,
  maxImportBytes: number,
  parserCompletion: Promise<MultipartProblemCode | null>,
  recordProblem: (code: MultipartProblemCode) => void
): Promise<MultipartImportResult> => {
  const metadataResult = await metadataTask;
  if (!metadataResult.ok) {
    stream.resume();
    return metadataResult;
  }
  const expectedMediaType =
    metadataResult.value.format === "jsonl" ? JSONL_MEDIA_TYPE : CSV_MEDIA_TYPE;
  if (normalizedMediaType(mimeType) !== expectedMediaType) {
    recordProblem("unsupported-media-type");
    stream.resume();
    return { code: "unsupported-media-type", ok: false };
  }
  try {
    const result = await importDataset(
      importRequestFromMetadata(
        actor,
        metadataResult.value,
        streamingSource(stream, maxImportBytes, parserCompletion)
      )
    );
    return { ok: true, result };
  } catch (error) {
    return error instanceof MultipartRequestError
      ? { code: error.code, ok: false }
      : Promise.reject(error);
  } finally {
    stream.resume();
  }
};

const executeMultipartImport = async (
  request: Request,
  actor: AuthenticatedActor,
  importDataset: ImportDataset,
  maxBodyBytes: number,
  maxImportBytes: number
): Promise<MultipartImportResult> => {
  const contentType = request.headers.get("content-type");
  if (
    contentType === null ||
    normalizedMediaType(contentType) !== MULTIPART_MEDIA_TYPE
  ) {
    return { code: "unsupported-media-type", ok: false };
  }

  let busboy: ReturnType<typeof Busboy>;
  try {
    busboy = Busboy({
      headers: { "content-type": contentType },
      isPartAFile: () => true,
      limits: {
        fields: 0,
        fileSize: Math.max(maxBodyBytes, maxImportBytes),
        files: 2,
        parts: 2,
      },
    });
  } catch {
    return { code: "request-invalid", ok: false };
  }

  const parserCompletion = deferred<MultipartProblemCode | null>();
  let parserSettled = false;
  let partCount = 0;
  let recordedProblem: MultipartProblemCode | null = null;
  let metadataTask: Promise<MetadataResult> | undefined;
  let sourceTask: Promise<SourceTaskResult> | undefined;
  const activePartStreams = new Set<BusboyFileStream>();

  const recordProblem = (code: MultipartProblemCode): void => {
    if (
      recordedProblem === null ||
      multipartProblemPriority[code] > multipartProblemPriority[recordedProblem]
    ) {
      recordedProblem = code;
    }
  };
  const settleParser = (): void => {
    if (parserSettled) {
      return;
    }
    parserSettled = true;
    if (
      partCount !== 2 ||
      metadataTask === undefined ||
      sourceTask === undefined
    ) {
      recordProblem("request-invalid");
    }
    parserCompletion.resolve(recordedProblem);
  };

  busboy.on(
    "file",
    (
      fieldName: string,
      stream: BusboyFileStream,
      _filename: string,
      _transferEncoding: string,
      mimeType: string
    ) => {
      partCount += 1;
      activePartStreams.add(stream);
      const forgetStream = (): void => {
        activePartStreams.delete(stream);
      };
      stream.once("close", forgetStream);
      stream.once("end", forgetStream);
      if (partCount === 1) {
        if (fieldName !== "metadata") {
          recordProblem("request-invalid");
          stream.resume();
          return;
        }
        if (normalizedMediaType(mimeType) !== JSON_MEDIA_TYPE) {
          recordProblem("unsupported-media-type");
          stream.resume();
          metadataTask = Promise.resolve({
            code: "unsupported-media-type",
            ok: false,
          });
          return;
        }
        metadataTask = readMultipartMetadata(stream, maxBodyBytes).then(
          (result) => {
            if (!result.ok) {
              recordProblem(result.code);
            }
            return result;
          }
        );
        return;
      }

      if (partCount !== 2 || fieldName !== "source") {
        recordProblem("request-invalid");
        stream.resume();
        return;
      }
      const capturedMetadataTask = metadataTask;
      if (capturedMetadataTask === undefined) {
        recordProblem("request-invalid");
        stream.resume();
        return;
      }
      sourceTask = runDatasetSourceTask(
        actor,
        capturedMetadataTask,
        stream,
        mimeType,
        importDataset,
        maxImportBytes,
        parserCompletion.promise,
        recordProblem
      ).catch((error: unknown) => ({ error, ok: false }));
    }
  );
  busboy.on("partsLimit", () => recordProblem("request-invalid"));
  busboy.on("filesLimit", () => recordProblem("request-invalid"));
  busboy.on("fieldsLimit", () => recordProblem("request-invalid"));
  busboy.on("error", () => {
    recordProblem("request-invalid");
    settleParser();
  });
  busboy.on("finish", settleParser);

  try {
    await pumpRequestIntoBusboy(request, busboy, () => {
      for (const stream of activePartStreams) {
        stream.destroy();
      }
      activePartStreams.clear();
    });
  } catch (error) {
    recordProblem(
      error instanceof MultipartRequestError ? error.code : "request-invalid"
    );
    settleParser();
  }

  const parserProblem = await parserCompletion.promise;
  if (metadataTask === undefined || sourceTask === undefined) {
    return { code: parserProblem ?? "request-invalid", ok: false };
  }
  const metadataResult = await metadataTask;
  const completedSourceTask = await sourceTask;
  if (parserProblem !== null) {
    return { code: parserProblem, ok: false };
  }
  if (!metadataResult.ok) {
    return metadataResult;
  }
  if (!("result" in completedSourceTask)) {
    if ("code" in completedSourceTask) {
      return completedSourceTask;
    }
    throw completedSourceTask.error;
  }
  return completedSourceTask;
};

const mapDomainFailure = (domainCode: string | undefined): ProblemCode => {
  switch (domainCode) {
    case "authority-capability-missing":
    case "authority-permission-missing":
    case "authority-subject-mismatch":
    case "deadline-elapsed":
    case "invalid-budget":
    case "quote-expired":
    case "quote-unit-mismatch":
    case "workspace-mismatch":
      return domainCode;
    default:
      return "domain-rejected";
  }
};

const mapCreateFailure = (error: {
  code: string;
  domainCode?: string;
}): ProblemCode => {
  switch (error.code) {
    case "authority-permission-missing":
    case "authority-subject-mismatch":
    case "idempotency-key-reused":
    case "intention-hash-mismatch":
    case "request-invalid":
    case "run-plan-already-consumed":
    case "run-plan-not-found":
      return error.code;
    case "domain-rejected":
      return mapDomainFailure(error.domainCode);
    default:
      return "internal-error";
  }
};

const mapQuoteFailure = (error: {
  code: string;
  domainCode?: string;
}): ProblemCode => {
  switch (error.code) {
    case "authority-capability-missing":
    case "authority-permission-missing":
    case "authority-subject-mismatch":
    case "deadline-elapsed":
    case "invalid-budget":
    case "quote-unit-mismatch":
    case "request-invalid":
    case "service-unavailable":
    case "workspace-mismatch":
      return error.code;
    case "domain-rejected":
      return mapDomainFailure(error.domainCode);
    default:
      return "internal-error";
  }
};

const mapGetFailure = (error: { code: string }): ProblemCode => {
  switch (error.code) {
    case "authority-permission-missing":
    case "request-invalid":
    case "run-not-found":
      return error.code;
    default:
      return "internal-error";
  }
};

const mapCancelFailure = (error: {
  code: string;
  domainCode?: string;
}): ProblemCode => {
  switch (error.code) {
    case "authority-permission-missing":
    case "idempotency-key-reused":
    case "request-invalid":
    case "run-not-found":
      return error.code;
    case "domain-rejected":
      return mapDomainFailure(error.domainCode);
    default:
      return "internal-error";
  }
};

const mapDatasetGenerationCancelFailure = (error: {
  code: string;
}): ProblemCode => {
  switch (error.code) {
    case "authority-permission-missing":
    case "dataset-generation-not-found":
    case "domain-rejected":
    case "idempotency-key-reused":
    case "request-invalid":
      return error.code;
    default:
      return "internal-error";
  }
};

const mapCandidatesListFailure = (error: { code: string }): ProblemCode => {
  switch (error.code) {
    case "dataset-generation-not-found":
    case "request-invalid":
      return error.code;
    case "permission-missing":
      return "authority-permission-missing";
    case "contact-privacy-restricted":
      return "authority-permission-missing";
    case "contact-privacy-check-failed":
      return "service-unavailable";
    case "dataset-generation-not-ready":
      return "dataset-generation-not-found";
    case "dataset-record-invalid":
    case "dataset-schema-invalid":
      return "output-contract-violation";
    default:
      return "internal-error";
  }
};

const mapGetRecipeApplicationStatusFailure = (error: {
  code: string;
}): ProblemCode => {
  switch (error.code) {
    case "authority-permission-missing":
    case "recipe-application-not-found":
    case "request-invalid":
      return error.code;
    case "recipe-application-watch-invariant":
      return "output-contract-violation";
    default:
      return "internal-error";
  }
};

const mapExportRecipeApplicationFailure = (error: {
  code: string;
}): ProblemCode => {
  switch (error.code) {
    case "authority-permission-missing":
    case "export-too-large":
    case "recipe-application-not-found":
      return error.code;
    case "field-selection-invalid":
      return "request-invalid";
    case "dataset-not-ready":
    case "recipe-projection-incomplete":
    case "sparse-csv-unsupported":
      return "recipe-application-export-unavailable";
    case "dataset-not-found":
    case "recipe-not-found":
    case "recipe-projection-count-mismatch":
    case "recipe-projection-duplicate":
    case "recipe-projection-identity-mismatch":
    case "recipe-projection-invalid":
      return "output-contract-violation";
    default:
      return "internal-error";
  }
};

const mapDatasetExportFailure = (error: { code: string }): ProblemCode => {
  switch (error.code) {
    case "authority-permission-missing":
    case "export-too-large":
      return error.code;
    case "contact-privacy-restricted":
      return "authority-permission-missing";
    case "contact-export-policy-unavailable":
    case "contact-privacy-check-failed":
      return "service-unavailable";
    case "export-delivery-conflict":
      return "idempotency-key-reused";
    case "export-delivery-revoked":
      return "authority-permission-missing";
    case "dataset-not-found":
    case "dataset-not-ready":
    case "field-selection-invalid":
    case "sparse-csv-unsupported":
      return "request-invalid";
    default:
      return "internal-error";
  }
};

const mapExportDeliveryFailure = (error: { code: string }): ProblemCode => {
  switch (error.code) {
    case "authority-permission-missing":
      return error.code;
    case "delivery-not-found":
      return "export-delivery-not-found";
    default:
      return "internal-error";
  }
};

const mapContactPrivacyRestrictionFailure = (error: {
  code: string;
}): ProblemCode => {
  switch (error.code) {
    case "authority-permission-missing":
      return error.code;
    case "idempotency-conflict":
      return "idempotency-key-reused";
    case "subject-invalid":
      return "request-invalid";
    default:
      return "internal-error";
  }
};

const mapCapabilitiesFailure = (error: { code: string }): ProblemCode => {
  switch (error.code) {
    case "authority-permission-missing":
    case "authority-subject-mismatch":
    case "deadline-elapsed":
    case "request-invalid":
    case "service-unavailable":
      return error.code;
    default:
      return "internal-error";
  }
};

const mapImportFailure = (error: { code: string }): ProblemCode => {
  switch (error.code) {
    case "authority-permission-missing":
    case "authority-subject-mismatch":
    case "dataset-import-conflict":
    case "dataset-import-failed":
    case "dataset-source-mismatch":
    case "request-invalid":
      return error.code;
    default:
      return "internal-error";
  }
};

const mapApplyNestedFailure = (domainCode: string | undefined): ProblemCode => {
  switch (domainCode) {
    case "authority-capability-missing":
    case "authority-permission-missing":
    case "authority-subject-mismatch":
    case "deadline-elapsed":
    case "invalid-budget":
    case "quote-unit-mismatch":
    case "request-invalid":
    case "service-unavailable":
    case "workspace-mismatch":
      return domainCode;
    case "recipe-application-conflict":
    case "recipe-revision-conflict":
      return "idempotency-key-reused";
    default:
      return "domain-rejected";
  }
};

const mapApplyFailure = (error: {
  code: string;
  domainCode?: string;
}): ProblemCode => {
  switch (error.code) {
    case "authority-permission-missing":
    case "request-invalid":
    case "workspace-mismatch":
      return error.code;
    case "recipe-apply-invariant":
      return "internal-error";
    case "recipe-application-rejected":
    case "recipe-cell-preparation-rejected":
    case "recipe-cell-quote-rejected":
    case "recipe-cell-run-rejected":
    case "recipe-registration-rejected":
      return mapApplyNestedFailure(error.domainCode);
    default:
      return "internal-error";
  }
};

const capabilityListRequestFromUrl = (
  requestUrl: string
): CapabilitiesListRequest | null => {
  const searchParams = new URL(requestUrl).searchParams;
  const values = searchParams.getAll("authority_envelope_id");
  if (
    values.length !== 1 ||
    [...searchParams.keys()].some((name) => name !== "authority_envelope_id")
  ) {
    return null;
  }
  return { authority_envelope_id: values[0] ?? "" };
};

const UNSIGNED_INTEGER_PATTERN = /^(?:0|[1-9][0-9]*)$/u;

const candidatesListRequestFromUrl = <
  Request extends Readonly<{
    after_ordinal?: number;
    generation_id: string;
    limit: number;
  }>,
>(
  requestUrl: string,
  generationId: string,
  validateRequest: (value: unknown) => value is Request
): Request | null => {
  const searchParams = new URL(requestUrl).searchParams;
  const limitValues = searchParams.getAll("limit");
  const afterOrdinalValues = searchParams.getAll("after_ordinal");
  if (
    limitValues.length !== 1 ||
    afterOrdinalValues.length > 1 ||
    [...searchParams.keys()].some(
      (name) => name !== "after_ordinal" && name !== "limit"
    )
  ) {
    return null;
  }
  const limitText = limitValues[0] ?? "";
  const afterOrdinalText = afterOrdinalValues[0] ?? "0";
  if (
    !(
      UNSIGNED_INTEGER_PATTERN.test(limitText) &&
      UNSIGNED_INTEGER_PATTERN.test(afterOrdinalText)
    )
  ) {
    return null;
  }
  const request = {
    after_ordinal: Number(afterOrdinalText),
    generation_id: generationId,
    limit: Number(limitText),
  };
  return validateRequest(request) ? request : null;
};

const workbookGetRequestFromUrl = (
  requestUrl: string,
  workbookId: string
): WorkbookGetRequest | null => {
  const searchParams = new URL(requestUrl).searchParams;
  const allowed = new Set([
    "after_ordinal",
    "dataset_id",
    "limit",
    "materialization_id",
  ]);
  if (
    [...searchParams.keys()].some((name) => !allowed.has(name)) ||
    [...allowed].some((name) => searchParams.getAll(name).length !== 1)
  ) {
    return null;
  }
  const afterOrdinal = searchParams.get("after_ordinal") ?? "";
  const limit = searchParams.get("limit") ?? "";
  if (
    !(
      UNSIGNED_INTEGER_PATTERN.test(afterOrdinal) &&
      UNSIGNED_INTEGER_PATTERN.test(limit)
    )
  ) {
    return null;
  }
  const request = {
    after_ordinal: Number(afterOrdinal),
    dataset_id: searchParams.get("dataset_id") ?? "",
    limit: Number(limit),
    materialization_id: searchParams.get("materialization_id") ?? "",
    workbook_id: workbookId,
  };
  return validateWorkbookGetRequest(request) ? request : null;
};

const contextDocumentFromContract = (
  document: GtmContextCommandRequest["context"]
): GtmContextDocument =>
  ({
    assertions: document.assertions.map((assertion) => ({
      provenance: {
        ...(assertion.provenance.actor_id === undefined
          ? {}
          : { actorId: assertion.provenance.actor_id }),
        recordedAtMs: assertion.provenance.recorded_at_ms,
        source: assertion.provenance.source,
      },
      questionId: assertion.question_id,
      state: assertion.state,
      ...("value" in assertion ? { value: assertion.value } : {}),
    })),
    contextId: document.context_id,
    name: document.name,
    questionnaireVersion: document.questionnaire_version,
  }) as GtmContextDocument;

const playDefinitionFromContract = (
  play: PlayCommandRequest["play"]
): GtmPlayDefinition => {
  const source =
    play.source.kind === "organization_search"
      ? {
          countries: play.source.countries,
          industries: play.source.industries,
          keywords: play.source.keywords,
          kind: play.source.kind,
        }
      : {
          datasetId: play.source.dataset_id,
          ...(play.source.default_country_code === undefined
            ? {}
            : { defaultCountryCode: play.source.default_country_code }),
          fieldMapping: {
            ...(play.source.field_mapping.country_code === undefined
              ? {}
              : {
                  countryCode: play.source.field_mapping.country_code,
                }),
            domain: play.source.field_mapping.domain,
            ...(play.source.field_mapping.name === undefined
              ? {}
              : { name: play.source.field_mapping.name }),
          },
          kind: play.source.kind,
          materializationId: play.source.materialization_id,
        };
  return {
    approvals: {
      export: play.approvals.export,
      providerSpend: play.approvals.provider_spend,
      reveal: play.approvals.reveal,
    },
    audience: {
      companyCountries: play.audience.company_countries,
      departments: play.audience.departments,
      personCountries: play.audience.person_countries,
      seniorities: play.audience.seniorities,
      titles: play.audience.titles,
    },
    broadening: play.broadening,
    budget: play.budget,
    capabilities: play.capabilities,
    contextRef: {
      contextId: play.context_ref.context_id,
      fingerprint: play.context_ref.fingerprint,
      revision: play.context_ref.revision,
    },
    deadlineMs: play.deadline_ms,
    delivery: {
      mode: play.delivery.mode,
      privateExport: play.delivery.private_export,
    },
    exclusions: play.exclusions,
    objective: play.objective,
    playId: play.play_id,
    preview: {
      maxCompanies: play.preview.max_companies,
      maxContactsPerCompany: play.preview.max_contacts_per_company,
      maxContactsTotal: play.preview.max_contacts_total,
      maxProviderCalls: play.preview.max_provider_calls,
      sampleSize: play.preview.sample_size,
    },
    selection: {
      minimumScore: play.selection.minimum_score,
      requiredSignals: play.selection.required_signals,
    },
    source,
    stopConditions: play.stop_conditions,
  } as GtmPlayDefinition;
};

const workbookViewWriteFromContract = (
  request: WorkbookUpdateRequest
): GtmWorkbookViewWrite =>
  ({
    annotations: request.annotations.map((annotation) => ({
      createdAtMs: annotation.created_at_ms,
      createdByActorId: annotation.created_by_actor_id,
      note: annotation.note,
      recordId: annotation.record_id,
    })),
    approvals: request.approvals.map((approval) => ({
      createdAtMs: approval.created_at_ms,
      createdByActorId: approval.created_by_actor_id,
      decision: approval.decision,
      recordId: approval.record_id,
    })),
    columnOrder: request.column_order,
    ...(request.context_ref === undefined
      ? {}
      : {
          contextRef: {
            contextId: request.context_ref.context_id,
            fingerprint: request.context_ref.fingerprint,
            revision: request.context_ref.revision,
          },
        }),
    datasetId: request.dataset_id,
    expectedRevision: request.expected_revision,
    filters: request.filters.map((filter) => ({
      fieldKey: filter.field_key,
      operator: filter.operator,
      ...(filter.value === undefined ? {} : { value: filter.value }),
    })),
    materializationId: request.materialization_id,
    name: request.name,
    ...(request.play_id === undefined ? {} : { playId: request.play_id }),
    ...(request.play_revision === undefined
      ? {}
      : { playRevision: request.play_revision }),
    ...(request.play_run_id === undefined
      ? {}
      : { playRunId: request.play_run_id }),
    ...(request.recipe_application_id === undefined
      ? {}
      : { recipeApplicationId: request.recipe_application_id }),
    selectionReasons: request.selection_reasons.map((selection) => ({
      reasons: selection.reasons,
      recordId: selection.record_id,
    })),
    selectedRecordIds: request.selected_record_ids,
    workbookId: request.workbook_id,
  }) as unknown as GtmWorkbookViewWrite;

const snakeCaseKey = (key: string): string =>
  key.replace(/[A-Z]/gu, (character) => `_${character.toLowerCase()}`);

const toContractProjection = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map(toContractProjection);
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        snakeCaseKey(key),
        toContractProjection(entry),
      ])
    );
  }
  return value;
};

const hasActorPermission = (
  actor: AuthenticatedActor,
  permission: string
): boolean => actor.permissions.includes(permission);

const gtmFailureProblem = (
  issues: readonly Readonly<{ code: string }>[]
): ProblemCode => {
  if (issues.some((issue) => issue.code === "permission-missing")) {
    return "authority-permission-missing";
  }
  if (issues.some((issue) => issue.code === "revision-conflict")) {
    return "revision-conflict";
  }
  if (
    issues.some(
      (issue) =>
        issue.code === "context-not-found" ||
        issue.code === "workbook-not-found"
    )
  ) {
    return "gtm-resource-not-found";
  }
  return "request-invalid";
};

const validateOutput = (
  context: AdapterContext,
  validate: ValidateFunction,
  body: unknown
): Response | null =>
  validate(body) ? null : problemResponse(context, "output-contract-violation");

const methodNotAllowed =
  (allow: string) =>
  (context: AdapterContext): Response =>
    problemResponse(context, "method-not-allowed", { allow });

const configuredLimit = (
  name: string,
  value: number | undefined,
  defaultValue: number
): number => {
  const resolved = value ?? defaultValue;
  if (!(Number.isSafeInteger(resolved) && resolved > 0)) {
    throw new TypeError(`${name} must be a positive safe integer.`);
  }
  return resolved;
};

const EXPORT_HASH_PATTERN = /^sha256:[0-9a-f]{64}$/u;

const exportStream = (
  events: ExportRecipeApplicationValue["events"] | ExportDatasetValue["events"]
): ReadableStream<Uint8Array> => {
  const iterator = events[Symbol.asyncIterator]();
  let completed = false;
  const closeIterator = async (): Promise<void> => {
    if (completed) {
      return;
    }
    completed = true;
    try {
      await iterator.return?.();
    } catch {
      // The transport exposes only a generic stream failure.
    }
  };
  return new ReadableStream<Uint8Array>({
    cancel: closeIterator,
    pull: async (controller) => {
      if (completed) {
        controller.close();
        return;
      }
      try {
        const next = await iterator.next();
        if (next.done) {
          completed = true;
          controller.close();
          return;
        }
        if (next.value.type !== "chunk") {
          throw new Error("Unexpected export codec event.");
        }
        controller.enqueue(next.value.bytes);
      } catch {
        await closeIterator();
        controller.error(new Error("Dataset export stream failed."));
      }
    },
  });
};

const exportMatchesRequest = (
  value: ExportRecipeApplicationValue,
  request: RecipeApplicationsExportRequest,
  actor: AuthenticatedActor
): boolean =>
  value.application.recipeApplicationId === request.application_id &&
  value.application.workspaceId === actor.workspaceId &&
  value.dataset.datasetId === value.application.datasetId &&
  value.dataset.workspaceId === actor.workspaceId &&
  value.format === request.format &&
  Number.isSafeInteger(value.contentLength) &&
  value.contentLength >= 0 &&
  EXPORT_HASH_PATTERN.test(value.contentHash) &&
  (request.field_ids === undefined ||
    (value.fields.length === request.field_ids.length &&
      value.fields.every(
        (field, index) => field.fieldId === request.field_ids?.[index]
      )));

export const createHttpApp = (
  dependencies: HttpAdapterDependencies,
  options: HttpAdapterOptions = {}
): Hono<AdapterEnvironment> => {
  const maxAuthorizationHeaderBytes = configuredLimit(
    "maxAuthorizationHeaderBytes",
    options.maxAuthorizationHeaderBytes,
    MAX_AUTHORIZATION_HEADER_BYTES
  );
  const maxBodyBytes = configuredLimit(
    "maxBodyBytes",
    options.maxBodyBytes,
    MAX_JSON_BODY_BYTES
  );
  const maxImportBytes = configuredLimit(
    "maxImportBytes",
    options.maxImportBytes,
    MAX_IMPORT_BYTES
  );
  const maxExportRecordBytes = configuredLimit(
    "maxExportRecordBytes",
    options.maxExportRecordBytes,
    MAX_EXPORT_RECORD_BYTES
  );
  const app = new Hono<AdapterEnvironment>();
  const deriveContactIdentities = dependencies.deriveContactIdentities;
  const deriveContactWorkEmails = dependencies.deriveContactWorkEmails;
  const discoverContacts = dependencies.discoverContacts;
  const discoverOrganizations = dependencies.discoverOrganizations;
  const cancelDatasetGeneration = dependencies.cancelDatasetGeneration;
  const getDatasetGeneration = dependencies.getDatasetGeneration;
  const exportDataset = dependencies.exportDataset;
  const listContactCandidates = dependencies.listContactCandidates;

  app.use("*", async (context, next) => {
    const suppliedCorrelationId = context.req.header("x-correlation-id");
    const correlationId =
      suppliedCorrelationId === undefined ||
      !isValidCorrelationId(suppliedCorrelationId)
        ? generatedCorrelationId()
        : suppliedCorrelationId;
    context.set("correlationId", correlationId);
    context.header("x-correlation-id", correlationId);

    if (
      suppliedCorrelationId !== undefined &&
      !isValidCorrelationId(suppliedCorrelationId)
    ) {
      return problemResponse(context, "request-invalid");
    }
    await next();
  });

  app.get("/healthz", (context) => context.json({ status: "healthy" }));

  app.get("/readyz", async (context) => {
    let ready = false;
    try {
      ready = await dependencies.readiness();
    } catch {
      ready = false;
    }
    return ready
      ? context.json({ status: "ready" })
      : problemResponse(context, "service-unavailable");
  });

  app.get("/v1/capabilities", async (context) => {
    context.header("cache-control", "private, no-store");
    const authentication = await authenticate(
      context,
      dependencies.authenticateApiKey,
      maxAuthorizationHeaderBytes
    );
    if (!authentication.ok) {
      return authentication.response;
    }

    const requestValue = capabilityListRequestFromUrl(context.req.url);
    if (
      requestValue === null ||
      !validateCapabilitiesListRequest(requestValue)
    ) {
      return problemResponse(context, "request-invalid");
    }

    const result = await dependencies.listCapabilities({
      actor: authentication.actor,
      authorityEnvelopeId: requestValue.authority_envelope_id,
    });
    if (!result.ok) {
      return problemResponse(context, mapCapabilitiesFailure(result.error));
    }

    const responseBody = {
      authority_envelope_id: result.value.authorityEnvelopeId,
      capabilities: result.value.capabilities.map((capability) => ({
        capability_id: capability.capabilityId,
        capability_version: capability.capabilityVersion,
      })),
      workspace_id: result.value.workspaceId,
    };
    const contractFailure = validateOutput(
      context,
      validateCapabilitiesListResponse,
      responseBody
    );
    return contractFailure ?? context.json(responseBody);
  });

  app.get("/v1/gtm-context-questionnaires/:profile", async (context) => {
    context.header("cache-control", "private, no-store");
    const authentication = await authenticate(
      context,
      dependencies.authenticateApiKey,
      maxAuthorizationHeaderBytes
    );
    if (!authentication.ok) {
      return authentication.response;
    }
    if (dependencies.gtm === undefined) {
      return problemResponse(context, "service-unavailable");
    }
    if (!hasActorPermission(authentication.actor, "contexts:read")) {
      return problemResponse(context, "authority-permission-missing");
    }
    const requestValue: unknown = { profile: context.req.param("profile") };
    if (!validateGtmQuestionnaireRequest(requestValue)) {
      return problemResponse(context, "request-invalid");
    }
    const responseBody = {
      profile: requestValue.profile,
      questionnaire_version: "1.0.0",
      questions: dependencies.gtm
        .questionnaire()
        .filter((question) =>
          question.requiredFor.includes(requestValue.profile)
        )
        .map((question) => ({
          answer_schema: {
            ...(question.enumValues === undefined
              ? {}
              : { enum_values: question.enumValues }),
            type: question.answerType,
          },
          ...(question.askIf === undefined
            ? {}
            : {
                ask_if: {
                  equals: question.askIf.equals,
                  question_id: question.askIf.questionId,
                },
              }),
          prompt: question.prompt,
          question_id: question.questionId,
          required_for: question.requiredFor,
          requires_human_confirmation: question.requiresHumanConfirmation,
          section: question.section,
          sensitivity: question.sensitivity,
        })),
    };
    const contractFailure = validateOutput(
      context,
      validateGtmQuestionnaireResponse,
      responseBody
    );
    return contractFailure ?? context.json(responseBody);
  });

  app.post("/v1/gtm-context-plans", async (context) => {
    context.header("cache-control", "private, no-store");
    const authentication = await authenticate(
      context,
      dependencies.authenticateApiKey,
      maxAuthorizationHeaderBytes
    );
    if (!authentication.ok) {
      return authentication.response;
    }
    if (dependencies.gtm === undefined) {
      return problemResponse(context, "service-unavailable");
    }
    if (!hasActorPermission(authentication.actor, "contexts:read")) {
      return problemResponse(context, "authority-permission-missing");
    }
    if (!hasJsonMediaType(context.req.header("content-type"))) {
      return problemResponse(context, "unsupported-media-type");
    }
    const parsed = await readJsonBody(context.req.raw, maxBodyBytes);
    if (
      !(
        parsed.ok &&
        validateGtmContextCommandRequest(parsed.value) &&
        parsed.value.mode === "plan"
      )
    ) {
      return problemResponse(
        context,
        parsed.ok ? "request-invalid" : parsed.code
      );
    }
    const result = dependencies.gtm.planContext(
      contextDocumentFromContract(parsed.value.context),
      parsed.value.expected_base_revision
    );
    const responseBody = {
      blocking_question_ids: result.blockingQuestionIds,
      context: toContractProjection(result.context),
      ...(result.expectedBaseRevision === undefined
        ? {}
        : { expected_base_revision: result.expectedBaseRevision }),
      fingerprint: result.fingerprint,
      issues: toContractProjection(result.issues),
      mode: "plan",
      ready_for: result.readyFor,
    };
    const contractFailure = validateOutput(
      context,
      validateGtmContextCommandResponse,
      responseBody
    );
    return contractFailure ?? context.json(responseBody);
  });

  app.post("/v1/gtm-context-revisions", async (context) => {
    context.header("cache-control", "private, no-store");
    const authentication = await authenticate(
      context,
      dependencies.authenticateApiKey,
      maxAuthorizationHeaderBytes
    );
    if (!authentication.ok) {
      return authentication.response;
    }
    if (dependencies.gtm === undefined) {
      return problemResponse(context, "service-unavailable");
    }
    if (!hasJsonMediaType(context.req.header("content-type"))) {
      return problemResponse(context, "unsupported-media-type");
    }
    const parsed = await readJsonBody(context.req.raw, maxBodyBytes);
    if (
      !(
        parsed.ok &&
        validateGtmContextCommandRequest(parsed.value) &&
        parsed.value.mode === "apply"
      )
    ) {
      return problemResponse(
        context,
        parsed.ok ? "request-invalid" : parsed.code
      );
    }
    const result = await dependencies.gtm.applyContext(authentication.actor, {
      activate: parsed.value.activate,
      confirmActiveChange: parsed.value.confirm_active_change,
      confirmed: parsed.value.confirmed,
      document: contextDocumentFromContract(parsed.value.context),
      ...(parsed.value.expected_base_revision === undefined
        ? {}
        : { expectedBaseRevision: parsed.value.expected_base_revision }),
      planFingerprint: parsed.value.plan_fingerprint,
    });
    if (!result.ok) {
      return problemResponse(context, gtmFailureProblem(result.issues));
    }
    const responseBody = {
      active: result.active,
      mode: "apply",
      revision: {
        context: toContractProjection(result.revision.document),
        context_id: result.revision.contextId,
        created_at_ms: result.revision.createdAtMs,
        created_by_actor_id: result.revision.createdByActorId,
        fingerprint: result.revision.fingerprint,
        revision: result.revision.revision,
        workspace_id: result.revision.workspaceId,
      },
      status: result.status,
    };
    const contractFailure = validateOutput(
      context,
      validateGtmContextCommandResponse,
      responseBody
    );
    return contractFailure ?? context.json(responseBody);
  });

  app.get("/v1/gtm-context-status/:profile", async (context) => {
    context.header("cache-control", "private, no-store");
    const authentication = await authenticate(
      context,
      dependencies.authenticateApiKey,
      maxAuthorizationHeaderBytes
    );
    if (!authentication.ok) {
      return authentication.response;
    }
    if (dependencies.gtm === undefined) {
      return problemResponse(context, "service-unavailable");
    }
    if (!hasActorPermission(authentication.actor, "contexts:read")) {
      return problemResponse(context, "authority-permission-missing");
    }
    const requestValue: unknown = { profile: context.req.param("profile") };
    if (!validateGtmContextStatusRequest(requestValue)) {
      return problemResponse(context, "request-invalid");
    }
    const result = await dependencies.gtm.status(authentication.actor);
    const readiness = result.readiness.find(
      (candidate) => candidate.profile === requestValue.profile
    );
    if (readiness === undefined) {
      return problemResponse(context, "output-contract-violation");
    }
    const revisionSummary = (revision: NonNullable<typeof result.active>) => ({
      context_id: revision.contextId,
      fingerprint: revision.fingerprint,
      questionnaire_version: revision.document.questionnaireVersion,
      revision: revision.revision,
    });
    const responseBody = {
      ...(result.active === undefined
        ? {}
        : { active_context: revisionSummary(result.active) }),
      blocking_question_ids: readiness.blockingQuestionIds,
      business_context: readiness.businessContext,
      ...(result.latest === undefined
        ? {}
        : { latest_context: revisionSummary(result.latest) }),
      profile: readiness.profile,
      ready: readiness.ready,
      remediation: readiness.remediation,
    };
    const contractFailure = validateOutput(
      context,
      validateGtmContextStatusResponse,
      responseBody
    );
    return contractFailure ?? context.json(responseBody);
  });

  app.post("/v1/play-previews", async (context) => {
    context.header("cache-control", "private, no-store");
    const authentication = await authenticate(
      context,
      dependencies.authenticateApiKey,
      maxAuthorizationHeaderBytes
    );
    if (!authentication.ok) {
      return authentication.response;
    }
    if (dependencies.gtm === undefined) {
      return problemResponse(context, "service-unavailable");
    }
    if (!hasActorPermission(authentication.actor, "plays:read")) {
      return problemResponse(context, "authority-permission-missing");
    }
    if (!hasJsonMediaType(context.req.header("content-type"))) {
      return problemResponse(context, "unsupported-media-type");
    }
    const parsed = await readJsonBody(context.req.raw, maxBodyBytes);
    if (
      !(
        parsed.ok &&
        validatePlayCommandRequest(parsed.value) &&
        parsed.value.action === "preview"
      )
    ) {
      return problemResponse(
        context,
        parsed.ok ? "request-invalid" : parsed.code
      );
    }
    const result = await dependencies.gtm.previewPlay(
      authentication.actor,
      playDefinitionFromContract(parsed.value.play)
    );
    const responseBody = {
      action: "preview",
      compilation: toContractProjection(result.compilation),
      fingerprint: result.fingerprint,
      issues: toContractProjection(result.issues),
      lifecycle: result.lifecycle,
      play: toContractProjection(result.definition),
      requires_human_approval: result.requiresHumanApproval,
    };
    const contractFailure = validateOutput(
      context,
      validatePlayCommandResponse,
      responseBody
    );
    return contractFailure ?? context.json(responseBody);
  });

  app.post("/v1/play-revisions", async (context) => {
    context.header("cache-control", "private, no-store");
    const authentication = await authenticate(
      context,
      dependencies.authenticateApiKey,
      maxAuthorizationHeaderBytes
    );
    if (!authentication.ok) {
      return authentication.response;
    }
    if (dependencies.gtm === undefined) {
      return problemResponse(context, "service-unavailable");
    }
    if (!hasJsonMediaType(context.req.header("content-type"))) {
      return problemResponse(context, "unsupported-media-type");
    }
    const parsed = await readJsonBody(context.req.raw, maxBodyBytes);
    if (
      !(
        parsed.ok &&
        validatePlayCommandRequest(parsed.value) &&
        parsed.value.action !== "preview"
      )
    ) {
      return problemResponse(
        context,
        parsed.ok ? "request-invalid" : parsed.code
      );
    }
    const result = await dependencies.gtm.applyPlay(authentication.actor, {
      action: parsed.value.action,
      approvedByHuman: parsed.value.approved_by_human,
      definition: playDefinitionFromContract(parsed.value.play),
      ...(parsed.value.expected_base_revision === undefined
        ? {}
        : { expectedBaseRevision: parsed.value.expected_base_revision }),
      idempotencyKey: parsed.value.idempotency_key,
      previewFingerprint: parsed.value.preview_fingerprint,
    });
    if (!result.ok) {
      return problemResponse(context, gtmFailureProblem(result.issues));
    }
    const revision = {
      compilation: toContractProjection(result.revision.compilation),
      created_at_ms: result.revision.createdAtMs,
      created_by_actor_id: result.revision.createdByActorId,
      fingerprint: result.revision.fingerprint,
      lifecycle: result.revision.lifecycle,
      play: toContractProjection(result.revision.definition),
      play_id: result.revision.playId,
      revision: result.revision.revision,
      workspace_id: result.revision.workspaceId,
    };
    const responseBody = {
      action: parsed.value.action,
      revision,
      ...(result.run === undefined
        ? {}
        : { run: toContractProjection(result.run) }),
    };
    const contractFailure = validateOutput(
      context,
      validatePlayCommandResponse,
      responseBody
    );
    return contractFailure ?? context.json(responseBody);
  });

  app.get("/v1/play-runs/:run_id", async (context) => {
    context.header("cache-control", "private, no-store");
    const authentication = await authenticate(
      context,
      dependencies.authenticateApiKey,
      maxAuthorizationHeaderBytes
    );
    if (!authentication.ok) {
      return authentication.response;
    }
    if (dependencies.gtm === undefined) {
      return problemResponse(context, "service-unavailable");
    }
    if (!hasActorPermission(authentication.actor, "plays:read")) {
      return problemResponse(context, "authority-permission-missing");
    }
    const requestValue: unknown = { run_id: context.req.param("run_id") };
    if (!validatePlayRunGetRequest(requestValue)) {
      return problemResponse(context, "request-invalid");
    }
    const run = await dependencies.gtm.getPlayRun(
      authentication.actor,
      requestValue.run_id
    );
    if (run === undefined) {
      return problemResponse(context, "gtm-resource-not-found");
    }
    const responseBody = { run: toContractProjection(run) };
    const contractFailure = validateOutput(
      context,
      validatePlayRunGetResponse,
      responseBody
    );
    return contractFailure ?? context.json(responseBody);
  });

  app.get("/v1/workbooks/:workbook_id", async (context) => {
    context.header("cache-control", "private, no-store");
    const authentication = await authenticate(
      context,
      dependencies.authenticateApiKey,
      maxAuthorizationHeaderBytes
    );
    if (!authentication.ok) {
      return authentication.response;
    }
    if (dependencies.gtm === undefined) {
      return problemResponse(context, "service-unavailable");
    }
    const requestValue = workbookGetRequestFromUrl(
      context.req.url,
      context.req.param("workbook_id")
    );
    if (requestValue === null) {
      return problemResponse(context, "request-invalid");
    }
    const result = await dependencies.gtm.getWorkbook(authentication.actor, {
      afterOrdinal: requestValue.after_ordinal,
      datasetId: requestValue.dataset_id as Parameters<
        GtmService["getWorkbook"]
      >[1]["datasetId"],
      limit: requestValue.limit,
      materializationId: requestValue.materialization_id as Parameters<
        GtmService["getWorkbook"]
      >[1]["materializationId"],
      workbookId: requestValue.workbook_id,
    });
    if (!result.ok) {
      return problemResponse(context, gtmFailureProblem(result.issues));
    }
    const responseBody = toContractProjection(result.page);
    const contractFailure = validateOutput(
      context,
      validateWorkbookGetResponse,
      responseBody
    );
    return contractFailure ?? context.json(responseBody);
  });

  app.put("/v1/workbooks/:workbook_id", async (context) => {
    context.header("cache-control", "private, no-store");
    const authentication = await authenticate(
      context,
      dependencies.authenticateApiKey,
      maxAuthorizationHeaderBytes
    );
    if (!authentication.ok) {
      return authentication.response;
    }
    if (dependencies.gtm === undefined) {
      return problemResponse(context, "service-unavailable");
    }
    if (!hasJsonMediaType(context.req.header("content-type"))) {
      return problemResponse(context, "unsupported-media-type");
    }
    const parsed = await readJsonBody(context.req.raw, maxBodyBytes);
    if (!(parsed.ok && validateWorkbookUpdateRequest(parsed.value))) {
      return problemResponse(
        context,
        parsed.ok ? "request-invalid" : parsed.code
      );
    }
    if (parsed.value.workbook_id !== context.req.param("workbook_id")) {
      return problemResponse(context, "request-invalid");
    }
    const result = await dependencies.gtm.saveWorkbook(
      authentication.actor,
      workbookViewWriteFromContract(parsed.value)
    );
    if (!result.ok) {
      return problemResponse(context, gtmFailureProblem(result.issues));
    }
    const responseBody = { view: toContractProjection(result.view) };
    const contractFailure = validateOutput(
      context,
      validateWorkbookUpdateResponse,
      responseBody
    );
    return contractFailure ?? context.json(responseBody);
  });

  app.post("/v1/plans", async (context) => {
    const authentication = await authenticate(
      context,
      dependencies.authenticateApiKey,
      maxAuthorizationHeaderBytes
    );
    if (!authentication.ok) {
      return authentication.response;
    }
    if (!hasJsonMediaType(context.req.header("content-type"))) {
      return problemResponse(context, "unsupported-media-type");
    }

    const parsed = await readJsonBody(context.req.raw, maxBodyBytes);
    if (!parsed.ok) {
      return problemResponse(context, parsed.code);
    }
    if (!validatePlansQuoteRequest(parsed.value)) {
      return problemResponse(context, "request-invalid");
    }

    const result = await dependencies.quoteRunPlan({
      actor: authentication.actor,
      authorityEnvelopeId: parsed.value.authority_envelope_id,
      budget: {
        limit: parsed.value.budget.limit,
        unit: parsed.value.budget.unit,
      },
      deadlineMs: parsed.value.deadline_ms,
      normalizedInputHash: parsed.value.normalized_input_hash,
      workflowContentHash: parsed.value.workflow_content_hash,
      workflowRevision: parsed.value.workflow_revision,
      workflowSpecId: parsed.value.workflow_spec_id,
      workspaceId: parsed.value.workspace_id,
    });
    if (!result.ok) {
      return problemResponse(context, mapQuoteFailure(result.error));
    }

    const { plan } = result.value;
    const responseBody = {
      authority_envelope_id: plan.authority.authorityEnvelopeId,
      budget: {
        limit: plan.budget.limit,
        reserved: plan.budget.reserved,
        spent: plan.budget.spent,
        unit: plan.budget.unit,
      },
      catalog_fingerprint: plan.catalogFingerprint,
      catalog_version: plan.catalogVersion,
      deadline_ms: plan.deadline,
      plan_hash: plan.planHash,
      quote: {
        expires_at_ms: plan.quote.expiresAt,
        guarantee: plan.quote.guarantee,
        pricing_version: plan.quote.pricingVersion,
        quote_id: plan.quote.quoteId,
        unit: plan.quote.unit,
        ...(plan.quote.upperBound === undefined
          ? {}
          : { upper_bound: plan.quote.upperBound }),
      },
      run_plan_id: plan.runPlanId,
      workspace_id: plan.workspaceId,
    };
    const contractFailure = validateOutput(
      context,
      validatePlansQuoteResponse,
      responseBody
    );
    return contractFailure ?? context.json(responseBody);
  });

  app.post("/v1/runs", async (context) => {
    const authentication = await authenticate(
      context,
      dependencies.authenticateApiKey,
      maxAuthorizationHeaderBytes
    );
    if (!authentication.ok) {
      return authentication.response;
    }
    if (!hasJsonMediaType(context.req.header("content-type"))) {
      return problemResponse(context, "unsupported-media-type");
    }

    const parsed = await readJsonBody(context.req.raw, maxBodyBytes);
    if (!parsed.ok) {
      return problemResponse(context, parsed.code);
    }
    if (!validateRunsCreateRequest(parsed.value)) {
      return problemResponse(context, "request-invalid");
    }

    const result = await dependencies.createRun({
      actor: authentication.actor,
      correlationId: context.get("correlationId"),
      idempotencyKey: parsed.value.idempotency_key,
      intentionHash: parsed.value.intention_hash,
      runPlanId: parsed.value.run_plan_id,
    });
    if (!result.ok) {
      return problemResponse(context, mapCreateFailure(result.error));
    }

    const { run } = result.value;
    const responseBody = {
      aggregate_version: run.aggregateVersion,
      created_at_ms: run.createdAt,
      event_sequence: run.eventSequence,
      replayed: result.value.replayed,
      result_completeness: run.resultCompleteness,
      run_id: run.runId,
      run_plan_id: run.runPlanId,
      state: run.state,
      workspace_id: run.workspaceId,
    };
    const contractFailure = validateOutput(
      context,
      validateRunsCreateResponse,
      responseBody
    );
    return contractFailure ?? context.json(responseBody);
  });

  app.post("/v1/runs/:run_id/cancel", async (context) => {
    const authentication = await authenticate(
      context,
      dependencies.authenticateApiKey,
      maxAuthorizationHeaderBytes
    );
    if (!authentication.ok) {
      return authentication.response;
    }
    if (!hasJsonMediaType(context.req.header("content-type"))) {
      return problemResponse(context, "unsupported-media-type");
    }

    const parsed = await readJsonBody(context.req.raw, maxBodyBytes);
    if (!(parsed.ok && validateRunsCancelBody(parsed.value))) {
      return problemResponse(
        context,
        parsed.ok ? "request-invalid" : parsed.code
      );
    }
    const requestValue: unknown = {
      idempotency_key: parsed.value.idempotency_key,
      run_id: context.req.param("run_id"),
    };
    if (!validateRunsCancelRequest(requestValue)) {
      return problemResponse(context, "request-invalid");
    }

    const result = await dependencies.cancelRun({
      actor: authentication.actor,
      correlationId: context.get("correlationId"),
      idempotencyKey: requestValue.idempotency_key,
      runId: requestValue.run_id,
    });
    if (!result.ok) {
      return problemResponse(context, mapCancelFailure(result.error));
    }

    const { run } = result.value;
    const responseBody = {
      aggregate_version: run.aggregateVersion,
      created_at_ms: run.createdAt,
      event_sequence: run.eventSequence,
      replayed: result.value.replayed,
      result_completeness: run.resultCompleteness,
      run_id: run.runId,
      run_plan_id: run.runPlanId,
      state: run.state,
      workspace_id: run.workspaceId,
    };
    const contractFailure = validateOutput(
      context,
      validateRunsCancelResponse,
      responseBody
    );
    return contractFailure ?? context.json(responseBody);
  });

  app.post("/v1/organization-discoveries", async (context) => {
    context.header("cache-control", "private, no-store");
    const authentication = await authenticate(
      context,
      dependencies.authenticateApiKey,
      maxAuthorizationHeaderBytes
    );
    if (!authentication.ok) {
      return authentication.response;
    }
    if (discoverOrganizations === undefined) {
      return problemResponse(context, "service-unavailable");
    }
    if (!hasJsonMediaType(context.req.header("content-type"))) {
      return problemResponse(context, "unsupported-media-type");
    }
    const parsed = await readJsonBody(context.req.raw, maxBodyBytes);
    if (
      !(
        parsed.ok &&
        validateOrganizationsDiscoverRequest(parsed.value) &&
        (parsed.value.query.employee_count === undefined ||
          parsed.value.query.employee_count.minimum <=
            parsed.value.query.employee_count.maximum)
      )
    ) {
      return problemResponse(
        context,
        parsed.ok ? "request-invalid" : parsed.code
      );
    }
    const result = await discoverOrganizations(
      organizationDiscoverRequestFromBody(
        authentication.actor,
        context.get("correlationId"),
        parsed.value
      )
    );
    if (!result.ok) {
      return problemResponse(
        context,
        mapOrganizationDiscoverFailure(result.error.code)
      );
    }
    const responseBody = organizationDiscoverResponse(result.value);
    const contractFailure = validateOutput(
      context,
      validateOrganizationsDiscoverResponse,
      responseBody
    );
    return contractFailure ?? context.json(responseBody);
  });

  app.post("/v1/contact-discoveries", async (context) => {
    context.header("cache-control", "private, no-store");
    const authentication = await authenticate(
      context,
      dependencies.authenticateApiKey,
      maxAuthorizationHeaderBytes
    );
    if (!authentication.ok) {
      return authentication.response;
    }
    if (discoverContacts === undefined) {
      return problemResponse(context, "service-unavailable");
    }
    if (!hasJsonMediaType(context.req.header("content-type"))) {
      return problemResponse(context, "unsupported-media-type");
    }
    const parsed = await readJsonBody(context.req.raw, maxBodyBytes);
    if (
      !(
        parsed.ok &&
        validateContactsDiscoverRequest(parsed.value) &&
        parsed.value.limits.max_contacts_total <=
          parsed.value.limits.max_companies *
            parsed.value.limits.max_contacts_per_company
      )
    ) {
      return problemResponse(
        context,
        parsed.ok ? "request-invalid" : parsed.code
      );
    }
    const result = await discoverContacts(
      contactDiscoverRequestFromBody(
        authentication.actor,
        context.get("correlationId"),
        parsed.value
      )
    );
    if (!result.ok) {
      return problemResponse(
        context,
        mapOrganizationDiscoverFailure(result.error.code)
      );
    }
    const responseBody = contactDiscoverResponse(result.value);
    const contractFailure = validateOutput(
      context,
      validateContactsDiscoverResponse,
      responseBody
    );
    return contractFailure ?? context.json(responseBody);
  });

  app.post("/v1/contact-identity-reveals", async (context) => {
    context.header("cache-control", "private, no-store");
    const authentication = await authenticate(
      context,
      dependencies.authenticateApiKey,
      maxAuthorizationHeaderBytes
    );
    if (!authentication.ok) {
      return authentication.response;
    }
    if (deriveContactIdentities === undefined) {
      return problemResponse(context, "service-unavailable");
    }
    if (!hasJsonMediaType(context.req.header("content-type"))) {
      return problemResponse(context, "unsupported-media-type");
    }
    const parsed = await readJsonBody(context.req.raw, maxBodyBytes);
    if (
      !(parsed.ok && validateSelectedContactDerivedDatasetRequest(parsed.value))
    ) {
      return problemResponse(
        context,
        parsed.ok ? "request-invalid" : parsed.code
      );
    }
    const result = await deriveContactIdentities(
      deriveContactIdentitiesRequestFromBody(
        authentication.actor,
        context.get("correlationId"),
        parsed.value
      )
    );
    if (!result.ok) {
      return problemResponse(
        context,
        mapOrganizationDiscoverFailure(result.error.code)
      );
    }
    const responseBody = selectedContactDerivedDatasetResponse(
      result.value,
      parsed.value.operation_id
    );
    const contractFailure = validateOutput(
      context,
      validateSelectedContactDerivedDatasetResponse,
      responseBody
    );
    return contractFailure ?? context.json(responseBody);
  });

  const deriveWorkEmail = async (
    context: AdapterContext,
    kind: "resolve" | "verify"
  ) => {
    context.header("cache-control", "private, no-store");
    const authentication = await authenticate(
      context,
      dependencies.authenticateApiKey,
      maxAuthorizationHeaderBytes
    );
    if (!authentication.ok) {
      return authentication.response;
    }
    if (deriveContactWorkEmails === undefined) {
      return problemResponse(context, "service-unavailable");
    }
    if (!hasJsonMediaType(context.req.header("content-type"))) {
      return problemResponse(context, "unsupported-media-type");
    }
    const parsed = await readJsonBody(context.req.raw, maxBodyBytes);
    if (
      !(parsed.ok && validateSelectedContactDerivedDatasetRequest(parsed.value))
    ) {
      return problemResponse(
        context,
        parsed.ok ? "request-invalid" : parsed.code
      );
    }
    const result = await deriveContactWorkEmails(
      deriveContactWorkEmailsRequestFromBody(
        authentication.actor,
        context.get("correlationId"),
        parsed.value,
        kind
      )
    );
    if (!result.ok) {
      return problemResponse(
        context,
        mapOrganizationDiscoverFailure(result.error.code)
      );
    }
    const responseBody = selectedContactDerivedDatasetResponse(
      result.value,
      parsed.value.operation_id
    );
    const contractFailure = validateOutput(
      context,
      validateSelectedContactDerivedDatasetResponse,
      responseBody
    );
    return contractFailure ?? context.json(responseBody);
  };

  app.post("/v1/contact-work-email-resolutions", (context) =>
    deriveWorkEmail(context, "resolve")
  );
  app.post("/v1/contact-work-email-verifications", (context) =>
    deriveWorkEmail(context, "verify")
  );

  app.get("/v1/dataset-generations/:generation_id", async (context) => {
    context.header("cache-control", "private, no-store");
    const authentication = await authenticate(
      context,
      dependencies.authenticateApiKey,
      maxAuthorizationHeaderBytes
    );
    if (!authentication.ok) {
      return authentication.response;
    }
    if (getDatasetGeneration === undefined) {
      return problemResponse(context, "service-unavailable");
    }
    const requestValue: unknown = {
      generation_id: context.req.param("generation_id"),
    };
    if (!validateDatasetGenerationsGetRequest(requestValue)) {
      return problemResponse(context, "request-invalid");
    }
    const result = await getDatasetGeneration({
      actorId: authentication.actor.actorId,
      actorPermissions: authentication.actor.permissions,
      generationId:
        requestValue.generation_id as Parameters<GetDatasetGeneration>[0]["generationId"],
      workspaceId: authentication.actor.workspaceId,
    });
    if (!result.ok) {
      return problemResponse(
        context,
        result.error.code === "permission-missing"
          ? "authority-permission-missing"
          : "dataset-generation-not-found"
      );
    }
    const responseBody = datasetGenerationResponse(result.value);
    const contractFailure = validateOutput(
      context,
      validateDatasetGenerationsGetResponse,
      responseBody
    );
    return contractFailure ?? context.json(responseBody);
  });

  app.get(
    "/v1/dataset-generations/:generation_id/company-candidates",
    async (context) => {
      context.header("cache-control", "private, no-store");
      const authentication = await authenticate(
        context,
        dependencies.authenticateApiKey,
        maxAuthorizationHeaderBytes
      );
      if (!authentication.ok) {
        return authentication.response;
      }
      const requestValue = candidatesListRequestFromUrl(
        context.req.url,
        context.req.param("generation_id"),
        validateOrganizationsCandidatesListRequest
      );
      if (requestValue === null) {
        return problemResponse(context, "request-invalid");
      }
      const result = await dependencies.listCompanyCandidates({
        actor: authentication.actor,
        afterOrdinal: requestValue.after_ordinal ?? 0,
        generationId:
          requestValue.generation_id as Parameters<ListCompanyCandidates>[0]["generationId"],
        limit: requestValue.limit,
      });
      if (!result.ok) {
        return problemResponse(context, mapCandidatesListFailure(result.error));
      }
      const { generation, items, materialization, page } = result.value;
      const responseBody = {
        dataset_id: generation.datasetId,
        generation_id: generation.generationId,
        items: items.map(({ candidate, ordinal }) => ({
          candidate: {
            company_id: candidate.companyId,
            country_code: candidate.countryCode,
            domain: candidate.domain,
            employee_count: candidate.employeeCount,
            industry_code: candidate.industryCode,
            name: candidate.name,
            observed_at_ms: candidate.observedAtMs,
          },
          ordinal,
        })),
        page: {
          after_ordinal: page.afterOrdinal,
          has_more: page.hasMore,
          limit: page.limit,
          next_after_ordinal: page.nextAfterOrdinal,
        },
        provenance: {
          capability_id: generation.capability.capabilityId,
          capability_version: generation.capability.capabilityVersion,
          completed_at_ms: materialization.completedAt,
          completion_reason: materialization.completionReason,
          coverage: materialization.coverage,
          generation_plan_id: generation.generationPlanId,
          materialization_content_hash: materialization.contentHash,
          materialization_id: materialization.materializationId,
          materialization_revision: materialization.revision,
          plan_hash: generation.planHash,
          query_hash: generation.queryHash,
          schema_hash: generation.schemaHash,
        },
        record_count: materialization.recordCount,
        workspace_id: generation.workspaceId,
      };
      const contractFailure = validateOutput(
        context,
        validateOrganizationsCandidatesListResponse,
        responseBody
      );
      return contractFailure ?? context.json(responseBody);
    }
  );

  app.get(
    "/v1/dataset-generations/:generation_id/contact-candidates",
    async (context) => {
      context.header("cache-control", "private, no-store");
      const authentication = await authenticate(
        context,
        dependencies.authenticateApiKey,
        maxAuthorizationHeaderBytes
      );
      if (!authentication.ok) {
        return authentication.response;
      }
      if (listContactCandidates === undefined) {
        return problemResponse(context, "service-unavailable");
      }
      const requestValue = candidatesListRequestFromUrl(
        context.req.url,
        context.req.param("generation_id"),
        validateContactsCandidatesListRequest
      );
      if (requestValue === null) {
        return problemResponse(context, "request-invalid");
      }
      const result = await listContactCandidates({
        actor: authentication.actor,
        afterOrdinal: requestValue.after_ordinal ?? 0,
        generationId:
          requestValue.generation_id as Parameters<ListContactCandidates>[0]["generationId"],
        limit: requestValue.limit,
      });
      if (!result.ok) {
        return problemResponse(context, mapCandidatesListFailure(result.error));
      }
      const { generation, items, materialization, page } = result.value;
      const responseBody = {
        dataset_id: generation.datasetId,
        generation_id: generation.generationId,
        items: items.map(({ candidate, ordinal }) => ({
          candidate: {
            contact_id: candidate.contactId,
            department: candidate.department,
            display_name: candidate.displayName,
            identity_completeness: candidate.identityCompleteness,
            job_title: candidate.jobTitle,
            observed_at_ms: candidate.observedAt,
            organization_domain: candidate.organizationDomain,
            organization_id: candidate.organizationId,
            organization_name: candidate.organizationName,
            person_country_code: candidate.personCountryCode,
            profile_url: candidate.profileUrl,
            seniority: candidate.seniority,
          },
          ordinal,
        })),
        page: {
          after_ordinal: page.afterOrdinal,
          has_more: page.hasMore,
          limit: page.limit,
          next_after_ordinal: page.nextAfterOrdinal,
        },
        provenance: {
          capability_id: generation.capability.capabilityId,
          capability_version: generation.capability.capabilityVersion,
          completed_at_ms: materialization.completedAt,
          completion_reason: materialization.completionReason,
          coverage: materialization.coverage,
          generation_plan_id: generation.generationPlanId,
          materialization_content_hash: materialization.contentHash,
          materialization_id: materialization.materializationId,
          materialization_revision: materialization.revision,
          plan_hash: generation.planHash,
          query_hash: generation.queryHash,
          schema_hash: generation.schemaHash,
        },
        record_count: materialization.recordCount,
        workspace_id: generation.workspaceId,
      };
      const contractFailure = validateOutput(
        context,
        validateContactsCandidatesListResponse,
        responseBody
      );
      return contractFailure ?? context.json(responseBody);
    }
  );

  app.post("/v1/dataset-generations/:generation_id/cancel", async (context) => {
    context.header("cache-control", "private, no-store");
    const authentication = await authenticate(
      context,
      dependencies.authenticateApiKey,
      maxAuthorizationHeaderBytes
    );
    if (!authentication.ok) {
      return authentication.response;
    }
    if (cancelDatasetGeneration === undefined) {
      return problemResponse(context, "service-unavailable");
    }
    if (!hasJsonMediaType(context.req.header("content-type"))) {
      return problemResponse(context, "unsupported-media-type");
    }
    const parsed = await readJsonBody(context.req.raw, maxBodyBytes);
    if (!(parsed.ok && validateDatasetGenerationsCancelBody(parsed.value))) {
      return problemResponse(
        context,
        parsed.ok ? "request-invalid" : parsed.code
      );
    }
    const requestValue: unknown = {
      generation_id: context.req.param("generation_id"),
      idempotency_key: parsed.value.idempotency_key,
    };
    if (!validateDatasetGenerationsCancelRequest(requestValue)) {
      return problemResponse(context, "request-invalid");
    }
    const result = await cancelDatasetGeneration({
      actor: authentication.actor,
      correlationId: context.get("correlationId"),
      generationId: requestValue.generation_id,
      idempotencyKey: requestValue.idempotency_key,
    });
    if (!result.ok) {
      return problemResponse(
        context,
        mapDatasetGenerationCancelFailure(result.error)
      );
    }
    const responseBody = {
      ...datasetGenerationResponse(result.value.generation),
      replayed: result.value.replayed,
    };
    const contractFailure = validateOutput(
      context,
      validateDatasetGenerationsCancelResponse,
      responseBody
    );
    return contractFailure ?? context.json(responseBody);
  });

  app.post("/v1/recipe-applications", async (context) => {
    const authentication = await authenticate(
      context,
      dependencies.authenticateApiKey,
      maxAuthorizationHeaderBytes
    );
    if (!authentication.ok) {
      return authentication.response;
    }
    if (!hasJsonMediaType(context.req.header("content-type"))) {
      return problemResponse(context, "unsupported-media-type");
    }

    const parsed = await readJsonBody(context.req.raw, maxBodyBytes);
    if (!parsed.ok) {
      return problemResponse(context, parsed.code);
    }
    if (!validateRecipesApplyRequest(parsed.value)) {
      return problemResponse(context, "request-invalid");
    }

    const result = await dependencies.applyRecipe(
      applyRequestFromBody(
        authentication.actor,
        context.get("correlationId"),
        parsed.value
      )
    );
    if (!result.ok) {
      return problemResponse(context, mapApplyFailure(result.error));
    }

    const responseBody = {
      active_cell_count: result.value.counts.active,
      application_id: result.value.application.recipeApplicationId,
      application_replayed: result.value.applicationReplayed,
      bound_cell_count: result.value.counts.bound,
      cached_cell_count: result.value.counts.cached,
      created_run_count: result.value.counts.createdRun,
      dataset_id: result.value.application.datasetId,
      recipe_id: result.value.application.recipeId,
      recipe_replayed: result.value.recipeReplayed,
      recipe_revision: result.value.application.recipeRevision,
      total_cell_count: result.value.counts.total,
      workspace_id: result.value.application.workspaceId,
    };
    if (
      !(
        validateRecipesApplyResponse(responseBody) &&
        recipeApplyCountsMatch(responseBody)
      )
    ) {
      return problemResponse(context, "output-contract-violation");
    }
    return context.json(responseBody);
  });

  app.post("/v1/recipe-application-exports", async (context) => {
    const authentication = await authenticate(
      context,
      dependencies.authenticateApiKey,
      maxAuthorizationHeaderBytes
    );
    if (!authentication.ok) {
      return authentication.response;
    }
    if (!hasJsonMediaType(context.req.header("content-type"))) {
      return problemResponse(context, "unsupported-media-type");
    }

    const parsed = await readJsonBody(context.req.raw, maxBodyBytes);
    if (!parsed.ok) {
      return problemResponse(context, parsed.code);
    }
    if (!validateRecipeApplicationsExportRequest(parsed.value)) {
      return problemResponse(context, "request-invalid");
    }

    const result = await dependencies.exportRecipeApplication(
      exportRequestFromBody(authentication.actor, parsed.value)
    );
    if (!result.ok) {
      return problemResponse(
        context,
        mapExportRecipeApplicationFailure(result.error)
      );
    }
    if (
      !exportMatchesRequest(result.value, parsed.value, authentication.actor)
    ) {
      return problemResponse(context, "output-contract-violation");
    }

    const exportDescriptor =
      recipeApplicationsExportOperation.output_stream.formats[
        parsed.value.format
      ];
    return context.body(exportStream(result.value.events), 200, {
      "cache-control": "private, no-store",
      "content-disposition": `attachment; filename="${exportDescriptor.filename}"`,
      "content-length": String(result.value.contentLength),
      "content-type":
        parsed.value.format === "csv"
          ? `${exportDescriptor.media_type}; charset=utf-8`
          : exportDescriptor.media_type,
      "x-content-type-options": "nosniff",
      "x-kurobara-content-sha256": result.value.contentHash,
    });
  });

  app.post("/v1/dataset-exports", async (context) => {
    const authentication = await authenticate(
      context,
      dependencies.authenticateApiKey,
      maxAuthorizationHeaderBytes
    );
    if (!authentication.ok) {
      return authentication.response;
    }
    if (exportDataset === undefined) {
      return problemResponse(context, "service-unavailable");
    }
    if (!hasJsonMediaType(context.req.header("content-type"))) {
      return problemResponse(context, "unsupported-media-type");
    }
    const parsed = await readJsonBody(context.req.raw, maxBodyBytes);
    if (!(parsed.ok && validateDatasetsExportRequest(parsed.value))) {
      return problemResponse(
        context,
        parsed.ok ? "request-invalid" : parsed.code
      );
    }
    const result = await exportDataset(
      datasetExportRequestFromBody(
        authentication.actor,
        parsed.value,
        maxExportRecordBytes
      )
    );
    if (!result.ok) {
      return problemResponse(context, mapDatasetExportFailure(result.error));
    }
    if (
      !datasetExportMatchesRequest(
        result.value,
        parsed.value,
        authentication.actor
      )
    ) {
      return problemResponse(context, "output-contract-violation");
    }
    const deliveryHeaders = datasetExportDeliveryHeaders(
      result.value,
      authentication.actor
    );
    if (deliveryHeaders === null) {
      return problemResponse(context, "output-contract-violation");
    }
    const exportDescriptor =
      datasetsExportOperation.output_stream.formats[parsed.value.format];
    return context.body(exportStream(result.value.events), 200, {
      "cache-control": "private, no-store",
      "content-disposition": `attachment; filename="${exportDescriptor.filename}"`,
      "content-length": String(result.value.contentLength),
      "content-type":
        parsed.value.format === "csv"
          ? `${exportDescriptor.media_type}; charset=utf-8`
          : exportDescriptor.media_type,
      ...deliveryHeaders,
      "x-content-type-options": "nosniff",
      "x-kurobara-content-sha256": result.value.contentHash,
    });
  });

  app.get("/v1/export-deliveries/:delivery_id", async (context) => {
    context.header("cache-control", "private, no-store");
    const authentication = await authenticate(
      context,
      dependencies.authenticateApiKey,
      maxAuthorizationHeaderBytes
    );
    if (!authentication.ok) {
      return authentication.response;
    }
    if (dependencies.getExportDelivery === undefined) {
      return problemResponse(context, "service-unavailable");
    }
    const requestValue: unknown = {
      delivery_id: context.req.param("delivery_id"),
    };
    if (!validateExportDeliveriesGetRequest(requestValue)) {
      return problemResponse(context, "request-invalid");
    }
    const result = await dependencies.getExportDelivery({
      actor: authentication.actor,
      deliveryId: requestValue.delivery_id,
    });
    if (!result.ok) {
      return problemResponse(context, mapExportDeliveryFailure(result.error));
    }
    if (!exportDeliveryReadbackMatches(result.value, authentication.actor)) {
      return problemResponse(context, "output-contract-violation");
    }
    const responseBody = exportDeliveryResponse(
      result.value.delivery,
      result.value.effectiveExpiresAt,
      result.value.state
    );
    const contractFailure = validateOutput(
      context,
      validateExportDeliveryStateResponse,
      responseBody
    );
    return contractFailure ?? context.json(responseBody);
  });

  app.post("/v1/export-deliveries/:delivery_id/revoke", async (context) => {
    context.header("cache-control", "private, no-store");
    const authentication = await authenticate(
      context,
      dependencies.authenticateApiKey,
      maxAuthorizationHeaderBytes
    );
    if (!authentication.ok) {
      return authentication.response;
    }
    if (dependencies.revokeExportDelivery === undefined) {
      return problemResponse(context, "service-unavailable");
    }
    if (!hasJsonMediaType(context.req.header("content-type"))) {
      return problemResponse(context, "unsupported-media-type");
    }
    const parsed = await readJsonBody(context.req.raw, maxBodyBytes);
    if (!(parsed.ok && validateExportDeliveriesRevokeBody(parsed.value))) {
      return problemResponse(
        context,
        parsed.ok ? "request-invalid" : parsed.code
      );
    }
    const requestValue: unknown = {
      delivery_id: context.req.param("delivery_id"),
    };
    if (!validateExportDeliveriesRevokeRequest(requestValue)) {
      return problemResponse(context, "request-invalid");
    }
    const result = await dependencies.revokeExportDelivery({
      actor: authentication.actor,
      deliveryId: requestValue.delivery_id,
    });
    if (!result.ok) {
      return problemResponse(context, mapExportDeliveryFailure(result.error));
    }
    if (
      !exportDeliveryOwnedBy(result.value, authentication.actor) ||
      result.value.state !== "revoked" ||
      !exportDeliveryLifecycleMatches(result.value)
    ) {
      return problemResponse(context, "output-contract-violation");
    }
    const responseBody = exportDeliveryResponse(
      result.value,
      exportDeliveryEffectiveExpiresAt(result.value),
      "revoked"
    );
    const contractFailure = validateOutput(
      context,
      validateExportDeliveryRevokeResponse,
      responseBody
    );
    return contractFailure ?? context.json(responseBody);
  });

  app.post("/v1/contact-privacy-restrictions", async (context) => {
    context.header("cache-control", "private, no-store");
    const authentication = await authenticate(
      context,
      dependencies.authenticateApiKey,
      maxAuthorizationHeaderBytes
    );
    if (!authentication.ok) {
      return authentication.response;
    }
    if (dependencies.restrictContactPrivacy === undefined) {
      return problemResponse(context, "service-unavailable");
    }
    if (!hasJsonMediaType(context.req.header("content-type"))) {
      return problemResponse(context, "unsupported-media-type");
    }
    const parsed = await readJsonBody(context.req.raw, maxBodyBytes);
    if (!(parsed.ok && validateContactPrivacyRestrictRequest(parsed.value))) {
      return problemResponse(
        context,
        parsed.ok ? "request-invalid" : parsed.code
      );
    }
    const result = await dependencies.restrictContactPrivacy(
      contactPrivacyRestrictionRequestFromBody(
        authentication.actor,
        parsed.value
      )
    );
    if (!result.ok) {
      return problemResponse(
        context,
        mapContactPrivacyRestrictionFailure(result.error)
      );
    }
    if (
      result.value.proof.workspaceId !== authentication.actor.workspaceId ||
      result.value.proof.reason !== parsed.value.reason
    ) {
      return problemResponse(context, "output-contract-violation");
    }
    const responseBody = {
      affected_delivery_count: result.value.affectedDeliveryCount,
      newly_revoked_delivery_count: result.value.newlyRevokedDeliveryCount,
      reason: result.value.proof.reason,
      registered_at_ms: result.value.proof.registeredAt,
      replayed: result.value.replayed,
      tombstone_id: result.value.proof.tombstoneId,
    };
    const contractFailure = validateOutput(
      context,
      validateContactPrivacyRestrictResponse,
      responseBody
    );
    return contractFailure ?? context.json(responseBody);
  });

  app.get("/v1/recipe-applications/:application_id", async (context) => {
    context.header("cache-control", "private, no-store");
    const authentication = await authenticate(
      context,
      dependencies.authenticateApiKey,
      maxAuthorizationHeaderBytes
    );
    if (!authentication.ok) {
      return authentication.response;
    }

    const requestValue: unknown = {
      application_id: context.req.param("application_id"),
    };
    if (!validateRecipeApplicationsGetRequest(requestValue)) {
      return problemResponse(context, "request-invalid");
    }

    const result = await dependencies.getRecipeApplicationStatus({
      actor: authentication.actor,
      recipeApplicationId: requestValue.application_id,
    });
    if (!result.ok) {
      return problemResponse(
        context,
        mapGetRecipeApplicationStatusFailure(result.error)
      );
    }

    const responseBody = {
      application_id: result.value.application.recipeApplicationId,
      bound_cell_count: result.value.counts.bound,
      dataset_id: result.value.application.datasetId,
      failed_cell_count: result.value.counts.failed,
      pending_cell_count: result.value.counts.pending,
      recipe_id: result.value.application.recipeId,
      recipe_revision: result.value.application.recipeRevision,
      running_cell_count: result.value.counts.running,
      skipped_cell_count: result.value.counts.skipped,
      state: result.value.state,
      succeeded_cell_count: result.value.counts.succeeded,
      terminal: result.value.terminal,
      total_cell_count: result.value.counts.total,
      unbound_cell_count: result.value.counts.unbound,
      workspace_id: result.value.application.workspaceId,
    };
    if (
      !(
        validateRecipeApplicationsGetResponse(responseBody) &&
        recipeApplicationStatusMatches(responseBody)
      )
    ) {
      return problemResponse(context, "output-contract-violation");
    }
    return context.json(responseBody);
  });

  app.post("/v1/dataset-imports", async (context) => {
    const authentication = await authenticate(
      context,
      dependencies.authenticateApiKey,
      maxAuthorizationHeaderBytes
    );
    if (!authentication.ok) {
      return authentication.response;
    }

    const executed = await executeMultipartImport(
      context.req.raw,
      authentication.actor,
      dependencies.importDataset,
      maxBodyBytes,
      maxImportBytes
    );
    if (!executed.ok) {
      return problemResponse(context, executed.code);
    }
    if (!executed.result.ok) {
      return problemResponse(context, mapImportFailure(executed.result.error));
    }

    const { progress } = executed.result.value;
    const responseBody = {
      batch_count: progress.batchCount,
      dataset_id: progress.datasetId,
      error_count: progress.errorCount,
      import_id: progress.importId,
      item_count: progress.itemCount,
      record_count: progress.recordCount,
      replayed: executed.result.value.replayed,
      state: progress.state,
      workspace_id: progress.workspaceId,
    };
    const contractFailure = validateOutput(
      context,
      validateDatasetsImportResponse,
      responseBody
    );
    return contractFailure ?? context.json(responseBody);
  });

  app.get("/v1/runs/:run_id", async (context) => {
    const authentication = await authenticate(
      context,
      dependencies.authenticateApiKey,
      maxAuthorizationHeaderBytes
    );
    if (!authentication.ok) {
      return authentication.response;
    }

    const requestValue: unknown = { run_id: context.req.param("run_id") };
    if (!validateRunsGetRequest(requestValue)) {
      return problemResponse(context, "request-invalid");
    }

    const result = await dependencies.getRun({
      actor: authentication.actor,
      runId: requestValue.run_id,
    });
    if (!result.ok) {
      return problemResponse(context, mapGetFailure(result.error));
    }

    const { cost, run } = result.value;
    const responseBody = {
      aggregate_version: run.aggregateVersion,
      cost: {
        reserved: cost.reserved,
        spent: cost.spent,
        unit: cost.unit,
      },
      created_at_ms: run.createdAt,
      event_sequence: run.eventSequence,
      result_completeness: run.resultCompleteness,
      run_id: run.runId,
      run_plan_id: run.runPlanId,
      state: run.state,
      workspace_id: run.workspaceId,
    };
    const contractFailure = validateOutput(
      context,
      validateRunsGetResponse,
      responseBody
    );
    return contractFailure ?? context.json(responseBody);
  });

  app.all("/healthz", methodNotAllowed("GET"));
  app.all("/readyz", methodNotAllowed("GET"));
  app.all("/v1/capabilities", methodNotAllowed("GET"));
  app.all("/v1/gtm-context-questionnaires/:profile", methodNotAllowed("GET"));
  app.all("/v1/gtm-context-plans", methodNotAllowed("POST"));
  app.all("/v1/gtm-context-revisions", methodNotAllowed("POST"));
  app.all("/v1/gtm-context-status/:profile", methodNotAllowed("GET"));
  app.all("/v1/play-previews", methodNotAllowed("POST"));
  app.all("/v1/play-revisions", methodNotAllowed("POST"));
  app.all("/v1/play-runs/:run_id", methodNotAllowed("GET"));
  app.all("/v1/workbooks/:workbook_id", methodNotAllowed("GET, PUT"));
  app.all("/v1/plans", methodNotAllowed("POST"));
  app.all("/v1/runs", methodNotAllowed("POST"));
  app.all("/v1/runs/:run_id", methodNotAllowed("GET"));
  app.all("/v1/runs/:run_id/cancel", methodNotAllowed("POST"));
  app.all("/v1/organization-discoveries", methodNotAllowed("POST"));
  app.all("/v1/contact-discoveries", methodNotAllowed("POST"));
  app.all("/v1/contact-identity-reveals", methodNotAllowed("POST"));
  app.all("/v1/contact-work-email-resolutions", methodNotAllowed("POST"));
  app.all("/v1/contact-work-email-verifications", methodNotAllowed("POST"));
  app.all("/v1/dataset-generations/:generation_id", methodNotAllowed("GET"));
  app.all(
    "/v1/dataset-generations/:generation_id/contact-candidates",
    methodNotAllowed("GET")
  );
  app.all(
    "/v1/dataset-generations/:generation_id/company-candidates",
    methodNotAllowed("GET")
  );
  app.all(
    "/v1/dataset-generations/:generation_id/cancel",
    methodNotAllowed("POST")
  );
  app.all("/v1/recipe-applications", methodNotAllowed("POST"));
  app.all("/v1/recipe-application-exports", methodNotAllowed("POST"));
  app.all("/v1/recipe-applications/:application_id", methodNotAllowed("GET"));
  app.all("/v1/dataset-imports", methodNotAllowed("POST"));
  app.all("/v1/dataset-exports", methodNotAllowed("POST"));
  app.all("/v1/export-deliveries/:delivery_id", methodNotAllowed("GET"));
  app.all(
    "/v1/export-deliveries/:delivery_id/revoke",
    methodNotAllowed("POST")
  );
  app.all("/v1/contact-privacy-restrictions", methodNotAllowed("POST"));

  app.notFound((context) => problemResponse(context, "route-not-found"));
  app.onError((_error, context) => problemResponse(context, "internal-error"));

  return app;
};

export const HTTP_ADAPTER_LIMITS = Object.freeze({
  authorizationHeaderBytes: MAX_AUTHORIZATION_HEADER_BYTES,
  correlationIdLength: MAX_CORRELATION_ID_LENGTH,
  importBytes: MAX_IMPORT_BYTES,
  jsonBodyBytes: MAX_JSON_BODY_BYTES,
});
