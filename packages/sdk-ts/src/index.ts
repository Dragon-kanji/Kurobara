import type {
  ContactPrivacyRestrictRequest,
  ContactPrivacyRestrictResponse,
  ContactsCandidatesListRequest,
  ContactsCandidatesListResponse,
  ContactsDiscoverRequest,
  ContactsDiscoverResponse,
  DatasetGenerationsCancelRequest,
  DatasetGenerationsCancelResponse,
  DatasetGenerationsGetRequest,
  DatasetGenerationsGetResponse,
  DatasetsExportRequest,
  DatasetsImportRequest,
  DatasetsImportResponse,
  ExportDeliveriesGetRequest,
  ExportDeliveriesRevokeRequest,
  ExportDeliveryRevokeResponse,
  ExportDeliveryStateResponse,
  OrganizationsCandidatesListRequest,
  OrganizationsCandidatesListResponse,
  OrganizationsDiscoverRequest,
  OrganizationsDiscoverResponse,
  ProblemDetails,
  RecipeApplicationsExportRequest,
  RecipeApplicationsGetRequest,
  RecipeApplicationsGetResponse,
  RecipesApplyRequest,
  RecipesApplyResponse,
  RunsCancelRequest,
  RunsCancelResponse,
  SelectedContactDerivedDatasetRequest,
  SelectedContactDerivedDatasetResponse,
} from "@kurobara/contracts";
import contactPrivacyRestrictOperation from "@kurobara/contracts/operations/contact-privacy-restrict.json" with {
  type: "json",
};
import contactsCandidatesListOperation from "@kurobara/contracts/operations/contacts-candidates-list.json" with {
  type: "json",
};
import contactsDiscoverOperation from "@kurobara/contracts/operations/contacts-discover.json" with {
  type: "json",
};
import contactsIdentityRevealOperation from "@kurobara/contracts/operations/contacts-identity-reveal.json" with {
  type: "json",
};
import contactsWorkEmailResolveOperation from "@kurobara/contracts/operations/contacts-work-email-resolve.json" with {
  type: "json",
};
import contactsWorkEmailVerifyOperation from "@kurobara/contracts/operations/contacts-work-email-verify.json" with {
  type: "json",
};
import datasetGenerationsCancelOperation from "@kurobara/contracts/operations/dataset-generations-cancel.json" with {
  type: "json",
};
import datasetGenerationsGetOperation from "@kurobara/contracts/operations/dataset-generations-get.json" with {
  type: "json",
};
import datasetsExportOperation from "@kurobara/contracts/operations/datasets-export.json" with {
  type: "json",
};
import datasetsImportOperation from "@kurobara/contracts/operations/datasets-import.json" with {
  type: "json",
};
import exportDeliveriesGetOperation from "@kurobara/contracts/operations/export-deliveries-get.json" with {
  type: "json",
};
import exportDeliveriesRevokeOperation from "@kurobara/contracts/operations/export-deliveries-revoke.json" with {
  type: "json",
};
import organizationsCandidatesListOperation from "@kurobara/contracts/operations/organizations-candidates-list.json" with {
  type: "json",
};
import organizationsDiscoverOperation from "@kurobara/contracts/operations/organizations-discover.json" with {
  type: "json",
};
import recipeApplicationsExportOperation from "@kurobara/contracts/operations/recipe-applications-export.json" with {
  type: "json",
};
import recipeApplicationsGetOperation from "@kurobara/contracts/operations/recipe-applications-get.json" with {
  type: "json",
};
import recipesApplyOperation from "@kurobara/contracts/operations/recipes-apply.json" with {
  type: "json",
};
import runsCancelOperation from "@kurobara/contracts/operations/runs-cancel.json" with {
  type: "json",
};
import problemRegistry from "@kurobara/contracts/problem-registry.json" with {
  type: "json",
};
import companyCandidateSchema from "@kurobara/contracts/schemas/company-candidate.json" with {
  type: "json",
};
import contactCandidateSchema from "@kurobara/contracts/schemas/contact-candidate.json" with {
  type: "json",
};
import contactDiscoveryQuerySchema from "@kurobara/contracts/schemas/contact-discovery-query.json" with {
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
import problemDetailsSchema from "@kurobara/contracts/schemas/problem-details.json" with {
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
import selectedContactDerivedDatasetRequestSchema from "@kurobara/contracts/schemas/selected-contact-derived-dataset-request.json" with {
  type: "json",
};
import selectedContactDerivedDatasetResponseSchema from "@kurobara/contracts/schemas/selected-contact-derived-dataset-response.json" with {
  type: "json",
};
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import Ajv2020 from "ajv/dist/2020.js";

const DEFAULT_MAX_REQUEST_BYTES = 64 * 1024;
const DEFAULT_MAX_RESPONSE_BYTES = 1024 * 1024;
const DEFAULT_MAX_EXPORT_BYTES = 1024 * 1024 * 1024;
const MULTIPART_CRLF = "\r\n";
const API_KEY_LINE_BREAK_PATTERN = /[\r\n]/u;
const BOUNDARY_PATTERN = /^[A-Za-z0-9-]{16,96}$/u;
const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/u;
const TRAILING_SLASH_PATTERN = /\/+$/u;
const JSON_MEDIA_TYPE = "application/json";
const PROBLEM_MEDIA_TYPE = "application/problem+json";
const datasetImportProblemCodes = new Set<string>(
  datasetsImportOperation.problem_codes
);
const datasetExportProblemCodes = new Set<string>(
  datasetsExportOperation.problem_codes
);
const contactPrivacyRestrictProblemCodes = new Set<string>(
  contactPrivacyRestrictOperation.problem_codes
);
const exportDeliveriesGetProblemCodes = new Set<string>(
  exportDeliveriesGetOperation.problem_codes
);
const exportDeliveriesRevokeProblemCodes = new Set<string>(
  exportDeliveriesRevokeOperation.problem_codes
);
const datasetGenerationsGetProblemCodes = new Set<string>(
  datasetGenerationsGetOperation.problem_codes
);
const datasetGenerationsCancelProblemCodes = new Set<string>(
  datasetGenerationsCancelOperation.problem_codes
);
const organizationsDiscoverProblemCodes = new Set<string>(
  organizationsDiscoverOperation.problem_codes
);
const organizationsCandidatesListProblemCodes = new Set<string>(
  organizationsCandidatesListOperation.problem_codes
);
const contactsDiscoverProblemCodes = new Set<string>(
  contactsDiscoverOperation.problem_codes
);
const contactsIdentityRevealProblemCodes = new Set<string>(
  contactsIdentityRevealOperation.problem_codes
);
const contactsWorkEmailResolveProblemCodes = new Set<string>(
  contactsWorkEmailResolveOperation.problem_codes
);
const contactsWorkEmailVerifyProblemCodes = new Set<string>(
  contactsWorkEmailVerifyOperation.problem_codes
);
const contactsCandidatesListProblemCodes = new Set<string>(
  contactsCandidatesListOperation.problem_codes
);
const recipesApplyProblemCodes = new Set<string>(
  recipesApplyOperation.problem_codes
);
const recipeApplicationsGetProblemCodes = new Set<string>(
  recipeApplicationsGetOperation.problem_codes
);
const recipeApplicationsExportProblemCodes = new Set<string>(
  recipeApplicationsExportOperation.problem_codes
);
const runsCancelProblemCodes = new Set<string>(
  runsCancelOperation.problem_codes
);

const ajv = new Ajv2020({ strict: true, validateFormats: false });
for (const keyword of [
  "x-kurobara-data-classification",
  "x-kurobara-owner",
  "x-kurobara-publication-status",
  "x-kurobara-redaction",
  "x-kurobara-schema-version",
]) {
  ajv.addKeyword({ keyword, schemaType: "string", valid: true });
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
const validateOrganizationsCandidatesListRequest =
  ajv.compile<OrganizationsCandidatesListRequest>(
    organizationsCandidatesListRequestSchema
  );
const validateOrganizationsCandidatesListResponse =
  ajv.compile<OrganizationsCandidatesListResponse>(
    organizationsCandidatesListResponseSchema
  );
const validateContactsCandidatesListRequest =
  ajv.compile<ContactsCandidatesListRequest>(
    contactsCandidatesListRequestSchema
  );
const validateContactsCandidatesListResponse =
  ajv.compile<ContactsCandidatesListResponse>(
    contactsCandidatesListResponseSchema
  );
const validateContactPrivacyRestrictRequest =
  ajv.compile<ContactPrivacyRestrictRequest>(
    contactPrivacyRestrictRequestSchema
  );
const validateContactPrivacyRestrictResponse =
  ajv.compile<ContactPrivacyRestrictResponse>(
    contactPrivacyRestrictResponseSchema
  );
const validateDatasetGenerationGetRequest =
  ajv.compile<DatasetGenerationsGetRequest>(datasetGenerationsGetRequestSchema);
const validateDatasetGenerationGetResponse =
  ajv.compile<DatasetGenerationsGetResponse>(
    datasetGenerationsGetResponseSchema
  );
const validateDatasetGenerationCancelRequest =
  ajv.compile<DatasetGenerationsCancelRequest>(
    datasetGenerationsCancelRequestSchema
  );
const validateDatasetGenerationCancelResponse =
  ajv.compile<DatasetGenerationsCancelResponse>(
    datasetGenerationsCancelResponseSchema
  );
const validateOrganizationsDiscoverRequest =
  ajv.compile<OrganizationsDiscoverRequest>(organizationsDiscoverRequestSchema);
const validateOrganizationsDiscoverResponse =
  ajv.compile<OrganizationsDiscoverResponse>(
    organizationsDiscoverResponseSchema
  );
const validateContactsDiscoverRequest = ajv.compile<ContactsDiscoverRequest>(
  contactsDiscoverRequestSchema
);
const validateContactsDiscoverResponse = ajv.compile<ContactsDiscoverResponse>(
  contactsDiscoverResponseSchema
);
const validateSelectedContactDerivedDatasetRequest =
  ajv.compile<SelectedContactDerivedDatasetRequest>(
    selectedContactDerivedDatasetRequestSchema
  );
const validateSelectedContactDerivedDatasetResponse =
  ajv.compile<SelectedContactDerivedDatasetResponse>(
    selectedContactDerivedDatasetResponseSchema
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
const validateExportDeliveryStateResponse =
  ajv.compile<ExportDeliveryStateResponse>(exportDeliveryStateResponseSchema);
const validateExportDeliveryRevokeResponse =
  ajv.compile<ExportDeliveryRevokeResponse>(exportDeliveryRevokeResponseSchema);
const validateDatasetImportMetadata = ajv.compile<DatasetsImportRequest>(
  datasetsImportRequestSchema
);
const validateDatasetImportResponse = ajv.compile<DatasetsImportResponse>(
  datasetsImportResponseSchema
);
const validateRecipesApplyRequest = ajv.compile<RecipesApplyRequest>(
  recipesApplyRequestSchema
);
const validateRecipesApplyResponse = ajv.compile<RecipesApplyResponse>(
  recipesApplyResponseSchema
);
const validateRecipeApplicationsGetRequest =
  ajv.compile<RecipeApplicationsGetRequest>(recipeApplicationsGetRequestSchema);
const validateRecipeApplicationsExportRequest =
  ajv.compile<RecipeApplicationsExportRequest>(
    recipeApplicationsExportRequestSchema
  );
const validateRecipeApplicationsGetResponse =
  ajv.compile<RecipeApplicationsGetResponse>(
    recipeApplicationsGetResponseSchema
  );
const validateRunsCancelRequest = ajv.compile<RunsCancelRequest>(
  runsCancelRequestSchema
);
const validateRunsCancelResponse = ajv.compile<RunsCancelResponse>(
  runsCancelResponseSchema
);
const validateProblemDetails =
  ajv.compile<ProblemDetails>(problemDetailsSchema);
const problemMetadata = new Map(
  problemRegistry.problems.map((problem) => [problem.code, problem] as const)
);

export type DatasetImportMetadata = DatasetsImportRequest;
export type DatasetImportResponse = DatasetsImportResponse;
export type DatasetGenerationGetRequest = DatasetGenerationsGetRequest;
export type DatasetGenerationGetResponse = DatasetGenerationsGetResponse;
export type DatasetGenerationCancelRequest = DatasetGenerationsCancelRequest;
export type DatasetGenerationCancelResponse = DatasetGenerationsCancelResponse;
export type OrganizationDiscoverRequest = OrganizationsDiscoverRequest;
export type OrganizationDiscoverResponse = OrganizationsDiscoverResponse;
export type OrganizationCandidatesListRequest =
  OrganizationsCandidatesListRequest;
export type OrganizationCandidatesListResponse =
  OrganizationsCandidatesListResponse;
export type ContactDiscoverRequest = ContactsDiscoverRequest;
export type ContactDiscoverResponse = ContactsDiscoverResponse;
export type ContactCandidatesListRequest = ContactsCandidatesListRequest;
export type ContactCandidatesListResponse = ContactsCandidatesListResponse;
export type ContactPrivacyRestrictionRequest = ContactPrivacyRestrictRequest;
export type ContactPrivacyRestrictionResponse = ContactPrivacyRestrictResponse;
export type SelectedContactDerivationRequest =
  SelectedContactDerivedDatasetRequest;
export type SelectedContactDerivationResponse =
  SelectedContactDerivedDatasetResponse;
export type ContactWorkEmailRequest = SelectedContactDerivationRequest;
export type ContactWorkEmailResponse = SelectedContactDerivationResponse;
export type ContactIdentityRevealRequest = SelectedContactDerivationRequest;
export type ContactIdentityRevealResponse = SelectedContactDerivationResponse;
export type RecipeApplyRequest = RecipesApplyRequest;
export type RecipeApplyResponse = RecipesApplyResponse;
export type RecipeApplicationGetRequest = RecipeApplicationsGetRequest;
export type RecipeApplicationGetResponse = RecipeApplicationsGetResponse;
export type RecipeApplicationExportRequest = RecipeApplicationsExportRequest;
export type DatasetExportRequest = DatasetsExportRequest;
export type ExportDeliveryGetRequest = ExportDeliveriesGetRequest;
export type ExportDeliveryRevokeRequest = ExportDeliveriesRevokeRequest;
export type ExportDeliveryRevocation = ExportDeliveryRevokeResponse;
export type ExportDeliveryState = ExportDeliveryStateResponse;
export type RunCancelRequest = RunsCancelRequest;
export type RunCancelResponse = RunsCancelResponse;

type KurobaraExportDescriptor = Readonly<{
  bytes: AsyncIterable<Uint8Array>;
  contentType: "application/x-ndjson" | "text/csv";
  filename: string;
}>;

type ExportIntegrityProof = Readonly<{
  contentLength: number;
  contentSha256: string;
}>;

export type DatasetExportDelivery = Readonly<{
  deliveryId: string;
  expiresAtMs: number;
  stateAtResponse: "delivered" | "prepared";
}>;

export type RecipeApplicationExportStream = KurobaraExportDescriptor &
  ExportIntegrityProof;
export type DatasetExportStream = KurobaraExportDescriptor &
  ExportIntegrityProof &
  Readonly<{ delivery?: DatasetExportDelivery }>;
export type KurobaraExportStream = DatasetExportStream;

const isExportContentType = (
  value: string
): value is KurobaraExportStream["contentType"] =>
  value === "application/x-ndjson" || value === "text/csv";

export type DatasetImportSource = AsyncIterable<Uint8Array>;

export type DatasetImportInput = Readonly<{
  metadata: DatasetImportMetadata;
  signal?: AbortSignal;
  source: DatasetImportSource;
}>;

export type KurobaraRequestOptions = Readonly<{
  signal?: AbortSignal;
}>;

export type RecipeApplicationExportOptions = Readonly<{
  maxBytes?: number;
  signal?: AbortSignal;
}>;

export type DatasetExportOptions = RecipeApplicationExportOptions;

export type KurobaraClientOptions = Readonly<{
  apiKey: string;
  baseUrl: string | URL;
  fetch?: typeof fetch;
  maxResponseBytes?: number;
  multipartBoundary?: () => string;
}>;

export type KurobaraClient = Readonly<{
  contactPrivacy: Readonly<{
    restrict: (
      request: ContactPrivacyRestrictionRequest,
      options?: KurobaraRequestOptions
    ) => Promise<ContactPrivacyRestrictionResponse>;
  }>;
  contacts: Readonly<{
    discover: (
      request: ContactDiscoverRequest,
      options?: KurobaraRequestOptions
    ) => Promise<ContactDiscoverResponse>;
    listCandidates: (
      request: ContactCandidatesListRequest,
      options?: KurobaraRequestOptions
    ) => Promise<ContactCandidatesListResponse>;
    revealIdentities: (
      request: ContactIdentityRevealRequest,
      options?: KurobaraRequestOptions
    ) => Promise<ContactIdentityRevealResponse>;
    resolveWorkEmails: (
      request: ContactWorkEmailRequest,
      options?: KurobaraRequestOptions
    ) => Promise<ContactWorkEmailResponse>;
    verifyWorkEmails: (
      request: ContactWorkEmailRequest,
      options?: KurobaraRequestOptions
    ) => Promise<ContactWorkEmailResponse>;
  }>;
  datasets: Readonly<{
    export: (
      request: DatasetExportRequest,
      options?: DatasetExportOptions
    ) => Promise<DatasetExportStream>;
    import: (input: DatasetImportInput) => Promise<DatasetImportResponse>;
  }>;
  exportDeliveries: Readonly<{
    get: (
      request: ExportDeliveryGetRequest,
      options?: KurobaraRequestOptions
    ) => Promise<ExportDeliveryState>;
    revoke: (
      request: ExportDeliveryRevokeRequest,
      options?: KurobaraRequestOptions
    ) => Promise<ExportDeliveryRevocation>;
  }>;
  datasetGenerations: Readonly<{
    cancel: (
      request: DatasetGenerationCancelRequest,
      options?: KurobaraRequestOptions
    ) => Promise<DatasetGenerationCancelResponse>;
    get: (
      request: DatasetGenerationGetRequest,
      options?: KurobaraRequestOptions
    ) => Promise<DatasetGenerationGetResponse>;
  }>;
  organizations: Readonly<{
    discover: (
      request: OrganizationDiscoverRequest,
      options?: KurobaraRequestOptions
    ) => Promise<OrganizationDiscoverResponse>;
    listCandidates: (
      request: OrganizationCandidatesListRequest,
      options?: KurobaraRequestOptions
    ) => Promise<OrganizationCandidatesListResponse>;
  }>;
  recipes: Readonly<{
    apply: (
      request: RecipeApplyRequest,
      options?: KurobaraRequestOptions
    ) => Promise<RecipeApplyResponse>;
  }>;
  recipeApplications: Readonly<{
    export: (
      request: RecipeApplicationExportRequest,
      options?: RecipeApplicationExportOptions
    ) => Promise<RecipeApplicationExportStream>;
    get: (
      request: RecipeApplicationGetRequest,
      options?: KurobaraRequestOptions
    ) => Promise<RecipeApplicationGetResponse>;
  }>;
  runs: Readonly<{
    cancel: (
      request: RunCancelRequest,
      options?: KurobaraRequestOptions
    ) => Promise<RunCancelResponse>;
  }>;
}>;

export class KurobaraProblemError extends Error {
  readonly name = "KurobaraProblemError";
  readonly problem: ProblemDetails;
  readonly status: number;

  constructor(problem: ProblemDetails) {
    super(`${problem.code}: ${problem.title}`);
    this.problem = problem;
    this.status = problem.status;
  }
}

export class KurobaraConfigError extends Error {
  readonly name = "KurobaraConfigError";
}

export type KurobaraTransportErrorKind =
  | "environment"
  | "invalid-input"
  | "invalid-response"
  | "network";

export class KurobaraTransportError extends Error {
  readonly kind: KurobaraTransportErrorKind;
  readonly name = "KurobaraTransportError";

  constructor(
    kind: KurobaraTransportErrorKind,
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.kind = kind;
  }
}

const normalizeBaseUrl = (value: string | URL): URL => {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new KurobaraConfigError("Kurobara baseUrl is invalid.");
  }
  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
    parsed.username.length > 0 ||
    parsed.password.length > 0
  ) {
    throw new KurobaraConfigError("Kurobara baseUrl must use http or https.");
  }
  parsed.hash = "";
  parsed.search = "";
  parsed.pathname = `${parsed.pathname.replace(TRAILING_SLASH_PATTERN, "")}/`;
  return parsed;
};

const validateApiKey = (apiKey: string): string => {
  if (
    apiKey.length === 0 ||
    apiKey.length > 4096 ||
    apiKey.trim() !== apiKey ||
    API_KEY_LINE_BREAK_PATTERN.test(apiKey)
  ) {
    throw new KurobaraConfigError("Kurobara apiKey is invalid.");
  }
  return apiKey;
};

const validateMaximum = (value: number | undefined): number => {
  const selected = value ?? DEFAULT_MAX_RESPONSE_BYTES;
  if (!Number.isSafeInteger(selected) || selected < 1) {
    throw new KurobaraConfigError(
      "maxResponseBytes must be a positive safe integer."
    );
  }
  return selected;
};

const defaultBoundary = (): string => {
  const identifier = globalThis.crypto?.randomUUID();
  if (identifier === undefined) {
    throw new KurobaraTransportError(
      "environment",
      "A cryptographically random multipart boundary is unavailable."
    );
  }
  return `kurobara-${identifier}`;
};

const validateBoundary = (boundary: string): string => {
  if (!BOUNDARY_PATTERN.test(boundary)) {
    throw new KurobaraTransportError(
      "environment",
      "The multipart boundary is invalid."
    );
  }
  return boundary;
};

const sourceMediaType = (format: DatasetImportMetadata["format"]): string =>
  format === "csv" ? "text/csv" : "application/x-ndjson";

const multipartBody = async function* (
  metadata: DatasetImportMetadata,
  source: DatasetImportSource,
  boundary: string
): AsyncGenerator<Uint8Array> {
  const encoder = new TextEncoder();
  const iterator = source[Symbol.asyncIterator]();
  try {
    yield encoder.encode(
      [
        `--${boundary}`,
        'Content-Disposition: form-data; name="metadata"',
        "Content-Type: application/json",
        "",
        JSON.stringify(metadata),
        `--${boundary}`,
        'Content-Disposition: form-data; name="source"; filename="source"',
        `Content-Type: ${sourceMediaType(metadata.format)}`,
        "",
      ].join(MULTIPART_CRLF) + MULTIPART_CRLF
    );
    while (true) {
      const next = await iterator.next();
      if (next.done) {
        break;
      }
      if (!(next.value instanceof Uint8Array)) {
        throw new KurobaraTransportError(
          "invalid-input",
          "The dataset source yielded a non-binary chunk."
        );
      }
      if (next.value.byteLength > 0) {
        yield next.value;
      }
    }
    yield encoder.encode(`${MULTIPART_CRLF}--${boundary}--${MULTIPART_CRLF}`);
  } finally {
    await iterator.return?.();
  }
};

const readableStreamFrom = (
  source: AsyncIterable<Uint8Array>
): ReadableStream<Uint8Array> => {
  const iterator = source[Symbol.asyncIterator]();
  return new ReadableStream<Uint8Array>({
    cancel: async () => {
      await iterator.return?.();
    },
    pull: async (controller) => {
      try {
        const next = await iterator.next();
        if (next.done) {
          controller.close();
        } else {
          controller.enqueue(next.value);
        }
      } catch (error) {
        controller.error(error);
      }
    },
  });
};

const readBoundedJson = async (
  response: Response,
  maxBytes: number
): Promise<unknown> => {
  if (response.body === null) {
    throw new KurobaraTransportError(
      "invalid-response",
      "The Kurobara API returned an empty body."
    );
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) {
        break;
      }
      byteLength += next.value.byteLength;
      if (byteLength > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new KurobaraTransportError(
          "invalid-response",
          "The Kurobara API response exceeded the configured limit."
        );
      }
      chunks.push(next.value);
    }
  } catch (error) {
    if (error instanceof KurobaraTransportError) {
      throw error;
    }
    throw new KurobaraTransportError(
      "network",
      "The Kurobara API response stream failed.",
      { cause: error }
    );
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new KurobaraTransportError(
      "invalid-response",
      "The Kurobara API returned invalid JSON."
    );
  }
};

const isOperationProblem = (
  value: unknown,
  allowedCodes: ReadonlySet<string>
): value is ProblemDetails => {
  if (!validateProblemDetails(value)) {
    return false;
  }
  const metadata = problemMetadata.get(value.code);
  return (
    metadata !== undefined &&
    allowedCodes.has(value.code) &&
    value.retryable === metadata.retryable &&
    value.status === metadata.status &&
    value.title === metadata.title &&
    value.type === metadata.type
  );
};

const normalizedMediaType = (response: Response): string | null => {
  const value = response.headers
    .get("content-type")
    ?.split(";", 1)[0]
    ?.trim()
    .toLowerCase();
  return value === undefined || value.length === 0 ? null : value;
};

const isDatasetImportResponse = (
  value: unknown
): value is DatasetImportResponse => validateDatasetImportResponse(value);

const isRecipeApplyResponse = (
  value: unknown
): value is RecipeApplyResponse => {
  if (!validateRecipesApplyResponse(value)) {
    return false;
  }
  return (
    value.created_run_count +
      value.active_cell_count +
      value.cached_cell_count +
      value.bound_cell_count ===
    value.total_cell_count
  );
};

const recipeApplicationStatusMatches = (
  value: RecipeApplicationGetResponse
): boolean => {
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

const isRecipeApplicationGetResponse = (
  value: unknown
): value is RecipeApplicationGetResponse =>
  validateRecipeApplicationsGetResponse(value) &&
  recipeApplicationStatusMatches(value);

const isRunCancelResponse = (value: unknown): value is RunCancelResponse =>
  validateRunsCancelResponse(value);

const organizationDiscoverResponseMatches = (
  value: OrganizationDiscoverResponse
): boolean =>
  value.mode === "dry-run"
    ? value.state === "planned" && value.generation_id === undefined
    : (value.state === "building" || value.state === "ready") &&
      value.generation_id !== undefined;

const isOrganizationDiscoverResponse = (
  value: unknown
): value is OrganizationDiscoverResponse =>
  validateOrganizationsDiscoverResponse(value) &&
  organizationDiscoverResponseMatches(value);

const candidateListResponseMatches = (
  value: OrganizationCandidatesListResponse | ContactCandidatesListResponse
): boolean => {
  const remaining = value.record_count - value.page.after_ordinal;
  const completionProofMatches =
    (value.provenance.completion_reason === "caps-reached" &&
      value.provenance.coverage.status === "bounded") ||
    (value.provenance.completion_reason === "source-completed" &&
      value.provenance.coverage.status === "complete_for_declared_source");
  if (
    remaining < 0 ||
    value.items.length !== Math.min(value.page.limit, remaining) ||
    value.page.has_more !== remaining > value.page.limit ||
    !completionProofMatches
  ) {
    return false;
  }
  let previousOrdinal = value.page.after_ordinal;
  for (const { ordinal } of value.items) {
    if (ordinal !== previousOrdinal + 1 || ordinal > value.record_count) {
      return false;
    }
    previousOrdinal = ordinal;
  }
  return (
    value.page.next_after_ordinal ===
    (value.page.has_more ? previousOrdinal : null)
  );
};

const isOrganizationCandidatesListResponse = (
  value: unknown
): value is OrganizationCandidatesListResponse =>
  validateOrganizationsCandidatesListResponse(value) &&
  candidateListResponseMatches(value);

const isContactCandidatesListResponse = (
  value: unknown
): value is ContactCandidatesListResponse =>
  validateContactsCandidatesListResponse(value) &&
  candidateListResponseMatches(value);

const isContactPrivacyRestrictionResponse = (
  value: unknown
): value is ContactPrivacyRestrictionResponse =>
  validateContactPrivacyRestrictResponse(value);

const exportDeliveryLifecycleIsCoherent = (
  value: ExportDeliveryState
): boolean => {
  if (value.expires_at_ms <= value.prepared_at_ms) {
    return false;
  }
  const deliveredAt = value.delivered_at_ms;
  const revokedAt = value.revoked_at_ms;
  const deliveredAtIsValid =
    deliveredAt !== undefined &&
    deliveredAt >= value.prepared_at_ms &&
    deliveredAt < value.expires_at_ms;
  if (value.state === "prepared") {
    return deliveredAt === undefined && revokedAt === undefined;
  }
  if (value.state === "delivered") {
    return deliveredAtIsValid && revokedAt === undefined;
  }
  if (value.state === "expired") {
    return (
      revokedAt === undefined &&
      (deliveredAt === undefined || deliveredAtIsValid)
    );
  }
  return (
    revokedAt !== undefined &&
    revokedAt >= value.prepared_at_ms &&
    (deliveredAt === undefined ||
      (deliveredAtIsValid && deliveredAt <= revokedAt))
  );
};

const isExportDeliveryState = (value: unknown): value is ExportDeliveryState =>
  validateExportDeliveryStateResponse(value) &&
  exportDeliveryLifecycleIsCoherent(value);

const isExportDeliveryRevocation = (
  value: unknown
): value is ExportDeliveryRevocation =>
  validateExportDeliveryRevokeResponse(value) &&
  exportDeliveryLifecycleIsCoherent(value);

const contactDiscoverResponseMatches = (
  value: ContactDiscoverResponse
): boolean =>
  value.mode === "dry-run"
    ? value.state === "planned" && value.generation_id === undefined
    : (value.state === "building" || value.state === "ready") &&
      value.generation_id !== undefined;

const isContactDiscoverResponse = (
  value: unknown
): value is ContactDiscoverResponse =>
  validateContactsDiscoverResponse(value) &&
  contactDiscoverResponseMatches(value);

const isSelectedContactDerivationResponse = (
  value: unknown
): value is SelectedContactDerivationResponse =>
  validateSelectedContactDerivedDatasetResponse(value);

const datasetGenerationResponseMatches = (
  value: DatasetGenerationGetResponse
): boolean =>
  value.terminal ===
  ["ambiguous", "cancelled", "completed", "failed"].includes(value.state);

const isDatasetGenerationGetResponse = (
  value: unknown
): value is DatasetGenerationGetResponse =>
  validateDatasetGenerationGetResponse(value) &&
  datasetGenerationResponseMatches(value);

const isDatasetGenerationCancelResponse = (
  value: unknown
): value is DatasetGenerationCancelResponse =>
  validateDatasetGenerationCancelResponse(value) &&
  value.terminal === ["ambiguous", "cancelled"].includes(value.state);

export const parseOrganizationDiscoverRequest = (
  value: unknown
): OrganizationDiscoverRequest => {
  try {
    if (
      validateOrganizationsDiscoverRequest(value) &&
      (value.query.employee_count === undefined ||
        value.query.employee_count.minimum <=
          value.query.employee_count.maximum)
    ) {
      return value;
    }
  } catch {
    // AJV may throw while traversing hostile cyclic or accessor-backed input.
  }
  throw new KurobaraTransportError(
    "invalid-input",
    "Organization discovery request is invalid."
  );
};

export const parseOrganizationCandidatesListRequest = (
  value: unknown
): OrganizationCandidatesListRequest => {
  try {
    if (validateOrganizationsCandidatesListRequest(value)) {
      return value;
    }
  } catch {
    // AJV may throw while traversing hostile cyclic or accessor-backed input.
  }
  throw new KurobaraTransportError(
    "invalid-input",
    "Organization candidate list request is invalid."
  );
};

export const parseContactCandidatesListRequest = (
  value: unknown
): ContactCandidatesListRequest => {
  try {
    if (validateContactsCandidatesListRequest(value)) {
      return value;
    }
  } catch {
    // AJV may throw while traversing hostile cyclic or accessor-backed input.
  }
  throw new KurobaraTransportError(
    "invalid-input",
    "Contact candidate list request is invalid."
  );
};

export const parseContactDiscoverRequest = (
  value: unknown
): ContactDiscoverRequest => {
  try {
    if (
      validateContactsDiscoverRequest(value) &&
      value.limits.max_contacts_total <=
        value.limits.max_companies * value.limits.max_contacts_per_company
    ) {
      return value;
    }
  } catch {
    // AJV may throw while traversing hostile cyclic or accessor-backed input.
  }
  throw new KurobaraTransportError(
    "invalid-input",
    "Contact discovery request is invalid."
  );
};

export const parseContactPrivacyRestrictionRequest = (
  value: unknown
): ContactPrivacyRestrictionRequest => {
  try {
    if (validateContactPrivacyRestrictRequest(value)) {
      return value;
    }
  } catch {
    // AJV may throw while traversing hostile cyclic or accessor-backed input.
  }
  throw new KurobaraTransportError(
    "invalid-input",
    "Contact privacy restriction request is invalid."
  );
};

const parseSelectedContactDerivationRequest = (
  value: unknown,
  invalidMessage: string
): SelectedContactDerivationRequest => {
  try {
    if (validateSelectedContactDerivedDatasetRequest(value)) {
      return value;
    }
  } catch {
    // AJV may throw while traversing hostile cyclic or accessor-backed input.
  }
  throw new KurobaraTransportError("invalid-input", invalidMessage);
};

export const parseContactWorkEmailRequest = (
  value: unknown
): ContactWorkEmailRequest =>
  parseSelectedContactDerivationRequest(
    value,
    "Contact work-email request is invalid."
  );

export const parseContactIdentityRevealRequest = (
  value: unknown
): ContactIdentityRevealRequest =>
  parseSelectedContactDerivationRequest(
    value,
    "Contact identity reveal request is invalid."
  );

const parseDatasetGenerationGetRequest = (
  value: unknown
): DatasetGenerationGetRequest => {
  try {
    if (validateDatasetGenerationGetRequest(value)) {
      return value;
    }
  } catch {
    // AJV may throw while traversing hostile accessor-backed input.
  }
  throw new KurobaraTransportError(
    "invalid-input",
    "Dataset generation get request is invalid."
  );
};

export const parseExportDeliveryGetRequest = (
  value: unknown
): ExportDeliveryGetRequest => {
  try {
    if (validateExportDeliveriesGetRequest(value)) {
      return value;
    }
  } catch {
    // AJV may throw while traversing hostile accessor-backed input.
  }
  throw new KurobaraTransportError(
    "invalid-input",
    "Export delivery get request is invalid."
  );
};

export const parseExportDeliveryRevokeRequest = (
  value: unknown
): ExportDeliveryRevokeRequest => {
  try {
    if (validateExportDeliveriesRevokeRequest(value)) {
      return value;
    }
  } catch {
    // AJV may throw while traversing hostile accessor-backed input.
  }
  throw new KurobaraTransportError(
    "invalid-input",
    "Export delivery revocation request is invalid."
  );
};

export const parseDatasetGenerationCancelRequest = (
  value: unknown
): DatasetGenerationCancelRequest => {
  try {
    if (validateDatasetGenerationCancelRequest(value)) {
      return value;
    }
  } catch {
    // AJV may throw while traversing hostile accessor-backed input.
  }
  throw new KurobaraTransportError(
    "invalid-input",
    "Dataset generation cancellation request is invalid."
  );
};

export const parseRecipeApplyRequest = (value: unknown): RecipeApplyRequest => {
  try {
    if (validateRecipesApplyRequest(value)) {
      return value;
    }
  } catch {
    // AJV may throw while traversing hostile cyclic or accessor-backed input.
  }
  throw new KurobaraTransportError(
    "invalid-input",
    "Recipe apply request is invalid."
  );
};

const parseRecipeApplicationGetRequest = (
  value: unknown
): RecipeApplicationGetRequest => {
  try {
    if (validateRecipeApplicationsGetRequest(value)) {
      return value;
    }
  } catch {
    // AJV may throw while traversing hostile accessor-backed input.
  }
  throw new KurobaraTransportError(
    "invalid-input",
    "Recipe application get request is invalid."
  );
};

const parseRecipeApplicationExportRequest = (
  value: unknown
): RecipeApplicationExportRequest => {
  try {
    if (validateRecipeApplicationsExportRequest(value)) {
      return value;
    }
  } catch {
    // AJV may throw while traversing hostile cyclic or accessor-backed input.
  }
  throw new KurobaraTransportError(
    "invalid-input",
    "Recipe application export request is invalid."
  );
};

export const parseDatasetExportRequest = (
  value: unknown
): DatasetExportRequest => {
  try {
    if (validateDatasetsExportRequest(value)) {
      return value;
    }
  } catch {
    // AJV may throw while traversing hostile cyclic or accessor-backed input.
  }
  throw new KurobaraTransportError(
    "invalid-input",
    "Dataset export request is invalid."
  );
};

export const parseRunCancelRequest = (value: unknown): RunCancelRequest => {
  try {
    if (validateRunsCancelRequest(value)) {
      return value;
    }
  } catch {
    // AJV may throw while traversing hostile cyclic or accessor-backed input.
  }
  throw new KurobaraTransportError(
    "invalid-input",
    "Run cancellation request is invalid."
  );
};

const validateExportMaximum = (value: number | undefined): number => {
  const selected = value ?? DEFAULT_MAX_EXPORT_BYTES;
  if (!Number.isSafeInteger(selected) || selected < 1) {
    throw new KurobaraTransportError(
      "invalid-input",
      "Export maxBytes must be a positive safe integer."
    );
  }
  return selected;
};

const validateImportMetadata = (
  value: DatasetImportMetadata
): DatasetImportMetadata => {
  if (
    !(
      validateDatasetImportMetadata(value) &&
      SHA256_PATTERN.test(value.source_content_hash)
    ) ||
    value.batch_limits.max_bytes < value.max_record_bytes
  ) {
    throw new KurobaraTransportError(
      "invalid-input",
      "Dataset import metadata is invalid."
    );
  }
  return value;
};

const nestedTransportError = (
  error: unknown
): KurobaraTransportError | undefined => {
  let candidate: unknown = error;
  for (let depth = 0; depth < 4; depth += 1) {
    if (candidate instanceof KurobaraTransportError) {
      return candidate;
    }
    candidate =
      candidate instanceof Error && "cause" in candidate
        ? candidate.cause
        : undefined;
  }
};

const serializeBoundedJson = (
  value: unknown,
  maximumBytes: number,
  label: string
): string => {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value);
  } catch {
    serialized = undefined;
  }
  if (serialized === undefined) {
    throw new KurobaraTransportError(
      "invalid-input",
      `${label} cannot be serialized as JSON.`
    );
  }
  if (new TextEncoder().encode(serialized).byteLength > maximumBytes) {
    throw new KurobaraTransportError(
      "invalid-input",
      `${label} exceeded the ${maximumBytes}-byte limit.`
    );
  }
  return serialized;
};

type JsonMutationFetchOptions = Readonly<{
  apiKey: string;
  baseUrl: URL;
  body: string;
  fetchImplementation: typeof fetch;
  path: string;
  signal?: AbortSignal;
}>;

const fetchJsonMutation = async ({
  apiKey,
  baseUrl,
  body,
  fetchImplementation,
  path,
  signal,
}: JsonMutationFetchOptions): Promise<Response> => {
  try {
    return await fetchImplementation(new URL(path, baseUrl), {
      body,
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": JSON_MEDIA_TYPE,
      },
      method: "POST",
      signal,
    });
  } catch (error) {
    const transportError = nestedTransportError(error);
    if (transportError !== undefined) {
      throw transportError;
    }
    throw new KurobaraTransportError(
      "network",
      "The Kurobara API request failed.",
      { cause: error }
    );
  }
};

type JsonGetFetchOptions = Readonly<{
  apiKey: string;
  baseUrl: URL;
  fetchImplementation: typeof fetch;
  path: string;
  signal?: AbortSignal;
}>;

const fetchJsonGet = async ({
  apiKey,
  baseUrl,
  fetchImplementation,
  path,
  signal,
}: JsonGetFetchOptions): Promise<Response> => {
  try {
    return await fetchImplementation(new URL(path, baseUrl), {
      headers: { authorization: `Bearer ${apiKey}` },
      method: "GET",
      signal,
    });
  } catch (error) {
    const transportError = nestedTransportError(error);
    if (transportError !== undefined) {
      throw transportError;
    }
    throw new KurobaraTransportError(
      "network",
      "The Kurobara API request failed.",
      { cause: error }
    );
  }
};

type DatasetImportFetchOptions = Readonly<{
  apiKey: string;
  baseUrl: URL;
  boundary: string;
  fetchImplementation: typeof fetch;
  input: DatasetImportInput;
  metadata: DatasetImportMetadata;
}>;

const fetchDatasetImport = async ({
  apiKey,
  baseUrl,
  boundary,
  fetchImplementation,
  input,
  metadata,
}: DatasetImportFetchOptions): Promise<Response> => {
  const requestBody = readableStreamFrom(
    multipartBody(metadata, input.source, boundary)
  );
  try {
    const requestInit: RequestInit & { duplex: "half" } = {
      body: requestBody,
      duplex: "half",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": `multipart/form-data; boundary=${boundary}`,
      },
      method: "POST",
      signal: input.signal,
    };
    const response = await fetchImplementation(
      new URL("v1/dataset-imports", baseUrl),
      requestInit
    );
    await requestBody.cancel().catch(() => undefined);
    return response;
  } catch (error) {
    await requestBody.cancel().catch(() => undefined);
    const transportError = nestedTransportError(error);
    if (transportError !== undefined) {
      throw transportError;
    }
    throw new KurobaraTransportError(
      "network",
      "The Kurobara API request failed.",
      { cause: error }
    );
  }
};

const parseOperationResponse = async <Value>(
  response: Response,
  maxResponseBytes: number,
  problemCodes: ReadonlySet<string>,
  isSuccess: (value: unknown) => value is Value,
  invalidSuccessMessage: string
): Promise<Value> => {
  const mediaType = normalizedMediaType(response);
  if (!response.ok) {
    if (mediaType !== PROBLEM_MEDIA_TYPE) {
      throw new KurobaraTransportError(
        "invalid-response",
        "The Kurobara API returned an invalid problem media type."
      );
    }
    const problem = await readBoundedJson(response, maxResponseBytes);
    if (
      isOperationProblem(problem, problemCodes) &&
      problem.status === response.status
    ) {
      throw new KurobaraProblemError(problem);
    }
    throw new KurobaraTransportError(
      "invalid-response",
      "The Kurobara API returned an invalid problem response."
    );
  }
  if (response.status !== 200 || mediaType !== JSON_MEDIA_TYPE) {
    throw new KurobaraTransportError(
      "invalid-response",
      "The Kurobara API returned an invalid success envelope."
    );
  }
  const body = await readBoundedJson(response, maxResponseBytes);
  if (!isSuccess(body)) {
    throw new KurobaraTransportError("invalid-response", invalidSuccessMessage);
  }
  return body;
};

const parseDatasetImportResponse = (
  response: Response,
  maxResponseBytes: number
): Promise<DatasetImportResponse> =>
  parseOperationResponse(
    response,
    maxResponseBytes,
    datasetImportProblemCodes,
    isDatasetImportResponse,
    "The Kurobara API returned an invalid dataset import response."
  );

const parseRecipeApplyResponse = (
  response: Response,
  maxResponseBytes: number
): Promise<RecipeApplyResponse> =>
  parseOperationResponse(
    response,
    maxResponseBytes,
    recipesApplyProblemCodes,
    isRecipeApplyResponse,
    "The Kurobara API returned an invalid recipe apply response."
  );

const parseRecipeApplicationGetResponse = (
  response: Response,
  maxResponseBytes: number
): Promise<RecipeApplicationGetResponse> =>
  parseOperationResponse(
    response,
    maxResponseBytes,
    recipeApplicationsGetProblemCodes,
    isRecipeApplicationGetResponse,
    "The Kurobara API returned an invalid recipe application response."
  );

const parseRunCancelResponse = (
  response: Response,
  maxResponseBytes: number
): Promise<RunCancelResponse> =>
  parseOperationResponse(
    response,
    maxResponseBytes,
    runsCancelProblemCodes,
    isRunCancelResponse,
    "The Kurobara API returned an invalid run cancellation response."
  );

const parseOrganizationDiscoverResponse = (
  response: Response,
  maxResponseBytes: number
): Promise<OrganizationDiscoverResponse> =>
  parseOperationResponse(
    response,
    maxResponseBytes,
    organizationsDiscoverProblemCodes,
    isOrganizationDiscoverResponse,
    "The Kurobara API returned an invalid organization discovery response."
  );

const parseOrganizationCandidatesListResponse = (
  response: Response,
  maxResponseBytes: number
): Promise<OrganizationCandidatesListResponse> =>
  parseOperationResponse(
    response,
    maxResponseBytes,
    organizationsCandidatesListProblemCodes,
    isOrganizationCandidatesListResponse,
    "The Kurobara API returned an invalid organization candidate list response."
  );

const parseContactCandidatesListResponse = (
  response: Response,
  maxResponseBytes: number
): Promise<ContactCandidatesListResponse> =>
  parseOperationResponse(
    response,
    maxResponseBytes,
    contactsCandidatesListProblemCodes,
    isContactCandidatesListResponse,
    "The Kurobara API returned an invalid contact candidate list response."
  );

const parseContactDiscoverResponse = (
  response: Response,
  maxResponseBytes: number
): Promise<ContactDiscoverResponse> =>
  parseOperationResponse(
    response,
    maxResponseBytes,
    contactsDiscoverProblemCodes,
    isContactDiscoverResponse,
    "The Kurobara API returned an invalid contact discovery response."
  );

const parseContactPrivacyRestrictionResponse = (
  response: Response,
  maxResponseBytes: number
): Promise<ContactPrivacyRestrictionResponse> =>
  parseOperationResponse(
    response,
    maxResponseBytes,
    contactPrivacyRestrictProblemCodes,
    isContactPrivacyRestrictionResponse,
    "The Kurobara API returned an invalid contact privacy restriction response."
  );

const parseExportDeliveryGetResponse = (
  response: Response,
  maxResponseBytes: number
): Promise<ExportDeliveryState> =>
  parseOperationResponse(
    response,
    maxResponseBytes,
    exportDeliveriesGetProblemCodes,
    isExportDeliveryState,
    "The Kurobara API returned an invalid export delivery response."
  );

const parseExportDeliveryRevokeResponse = (
  response: Response,
  maxResponseBytes: number
): Promise<ExportDeliveryRevocation> =>
  parseOperationResponse(
    response,
    maxResponseBytes,
    exportDeliveriesRevokeProblemCodes,
    isExportDeliveryRevocation,
    "The Kurobara API returned an invalid export delivery revocation response."
  );

const parseSelectedContactDerivationResponse = (
  response: Response,
  maxResponseBytes: number,
  problemCodes: ReadonlySet<string>,
  invalidMessage: string
): Promise<SelectedContactDerivationResponse> =>
  parseOperationResponse(
    response,
    maxResponseBytes,
    problemCodes,
    isSelectedContactDerivationResponse,
    invalidMessage
  );

const parseDatasetGenerationGetResponse = (
  response: Response,
  maxResponseBytes: number
): Promise<DatasetGenerationGetResponse> =>
  parseOperationResponse(
    response,
    maxResponseBytes,
    datasetGenerationsGetProblemCodes,
    isDatasetGenerationGetResponse,
    "The Kurobara API returned an invalid dataset generation response."
  );

const parseDatasetGenerationCancelResponse = (
  response: Response,
  maxResponseBytes: number
): Promise<DatasetGenerationCancelResponse> =>
  parseOperationResponse(
    response,
    maxResponseBytes,
    datasetGenerationsCancelProblemCodes,
    isDatasetGenerationCancelResponse,
    "The Kurobara API returned an invalid dataset generation cancellation response."
  );

const DECIMAL_LENGTH_PATTERN = /^(0|[1-9][0-9]*)$/u;
const EXPORT_SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/u;
const DELIVERY_ID_PATTERN = /^\S{1,255}$/u;

const cancelResponseBody = async (response: Response): Promise<void> => {
  await response.body?.cancel().catch(() => undefined);
};

const invalidExportResponse = async (
  response: Response,
  message: string
): Promise<never> => {
  await cancelResponseBody(response);
  throw new KurobaraTransportError("invalid-response", message);
};

const readExportChunk = async (
  reader: ReadableStreamDefaultReader<Uint8Array>,
  onFailure: () => void
): Promise<ReadableStreamReadResult<Uint8Array>> => {
  try {
    return await reader.read();
  } catch (error) {
    onFailure();
    throw new KurobaraTransportError(
      "network",
      "The Kurobara API export stream failed.",
      { cause: error }
    );
  }
};

const exceedsExportLimit = (
  byteCount: number,
  maxBytes: number,
  integrity: ExportIntegrityProof | undefined
): boolean =>
  byteCount > maxBytes ||
  (integrity !== undefined && byteCount > integrity.contentLength);

const exportBytes = (
  body: ReadableStream<Uint8Array>,
  integrity: ExportIntegrityProof | undefined,
  maxBytes: number
): AsyncIterable<Uint8Array> => {
  let acquired = false;
  return {
    [Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
      if (acquired) {
        throw new KurobaraTransportError(
          "invalid-input",
          "Export bytes can be consumed only once."
        );
      }
      acquired = true;
      const reader = body.getReader();
      const digest = integrity === undefined ? undefined : sha256.create();
      let byteCount = 0;
      let finished = false;

      const release = (): void => {
        if (!finished) {
          finished = true;
          reader.releaseLock();
        }
      };

      return {
        next: async (): Promise<IteratorResult<Uint8Array>> => {
          if (finished) {
            return { done: true, value: undefined };
          }
          const next = await readExportChunk(reader, () => {
            digest?.destroy();
            release();
          });
          if (next.done) {
            const observedSha256 =
              digest === undefined
                ? undefined
                : `sha256:${bytesToHex(digest.digest())}`;
            release();
            if (
              integrity !== undefined &&
              (byteCount !== integrity.contentLength ||
                observedSha256 !== integrity.contentSha256)
            ) {
              throw new KurobaraTransportError(
                "invalid-response",
                "The Kurobara API export integrity proof did not match its body."
              );
            }
            return { done: true, value: undefined };
          }
          byteCount += next.value.byteLength;
          if (exceedsExportLimit(byteCount, maxBytes, integrity)) {
            await reader.cancel().catch(() => undefined);
            digest?.destroy();
            release();
            throw new KurobaraTransportError(
              "invalid-response",
              "The Kurobara API export exceeded its configured or declared limit."
            );
          }
          digest?.update(next.value);
          return { done: false, value: next.value };
        },
        return: async (): Promise<IteratorResult<Uint8Array>> => {
          if (!finished) {
            await reader.cancel().catch(() => undefined);
            digest?.destroy();
            release();
          }
          return { done: true, value: undefined };
        },
      };
    },
  };
};

type ExportOperation =
  | typeof datasetsExportOperation
  | typeof recipeApplicationsExportOperation;

const parseExportDeliveryHeaders = async (
  response: Response,
  deliveryTracking: "forbidden" | "optional"
): Promise<DatasetExportDelivery | undefined> => {
  const deliveryId = response.headers.get("x-kurobara-delivery-id");
  const deliveryExpiresAtMs = response.headers.get(
    "x-kurobara-delivery-expires-at-ms"
  );
  const deliveryState = response.headers.get("x-kurobara-delivery-state");
  const deliveryHeaderCount = [
    deliveryId,
    deliveryExpiresAtMs,
    deliveryState,
  ].filter((value) => value !== null).length;
  if (deliveryTracking === "forbidden" && deliveryHeaderCount > 0) {
    return await invalidExportResponse(
      response,
      "The Kurobara API returned unexpected export delivery metadata."
    );
  }
  if (deliveryHeaderCount === 0) {
    return undefined;
  }
  if (
    deliveryHeaderCount !== 3 ||
    deliveryId === null ||
    deliveryExpiresAtMs === null ||
    deliveryState === null ||
    !DELIVERY_ID_PATTERN.test(deliveryId) ||
    !DECIMAL_LENGTH_PATTERN.test(deliveryExpiresAtMs) ||
    (deliveryState !== "prepared" && deliveryState !== "delivered")
  ) {
    return await invalidExportResponse(
      response,
      "The Kurobara API returned invalid export delivery metadata."
    );
  }
  const expiresAtMs = Number(deliveryExpiresAtMs);
  if (!Number.isSafeInteger(expiresAtMs)) {
    return await invalidExportResponse(
      response,
      "The Kurobara API returned invalid export delivery metadata."
    );
  }
  return {
    deliveryId,
    expiresAtMs,
    stateAtResponse: deliveryState,
  };
};

function parseExportResponse(
  response: Response,
  format: "csv" | "jsonl",
  operation: ExportOperation,
  problemCodes: ReadonlySet<string>,
  maxBytes: number,
  maxResponseBytes: number,
  deliveryTracking: "forbidden"
): Promise<RecipeApplicationExportStream>;
function parseExportResponse(
  response: Response,
  format: "csv" | "jsonl",
  operation: ExportOperation,
  problemCodes: ReadonlySet<string>,
  maxBytes: number,
  maxResponseBytes: number,
  deliveryTracking: "optional"
): Promise<DatasetExportStream>;
async function parseExportResponse(
  response: Response,
  format: "csv" | "jsonl",
  operation: ExportOperation,
  problemCodes: ReadonlySet<string>,
  maxBytes: number,
  maxResponseBytes: number,
  deliveryTracking: "forbidden" | "optional"
): Promise<DatasetExportStream> {
  if (!response.ok) {
    const mediaType = normalizedMediaType(response);
    if (mediaType !== PROBLEM_MEDIA_TYPE) {
      return invalidExportResponse(
        response,
        "The Kurobara API returned an invalid problem media type."
      );
    }
    const problem = await readBoundedJson(response, maxResponseBytes);
    if (
      isOperationProblem(problem, problemCodes) &&
      problem.status === response.status
    ) {
      throw new KurobaraProblemError(problem);
    }
    throw new KurobaraTransportError(
      "invalid-response",
      "The Kurobara API returned an invalid problem response."
    );
  }

  const exportDescriptor = operation.output_stream.formats[format];
  const contentType = exportDescriptor.media_type;
  const filename = exportDescriptor.filename;
  if (!isExportContentType(contentType)) {
    return invalidExportResponse(
      response,
      "The Kurobara SDK export contract is invalid."
    );
  }
  const contentLengthHeader = response.headers.get("content-length");
  const contentSha256 = response.headers.get("x-kurobara-content-sha256");
  if (
    response.status !== 200 ||
    normalizedMediaType(response) !== contentType ||
    response.body === null ||
    response.headers.get("cache-control") !== "private, no-store" ||
    response.headers.get("x-content-type-options") !== "nosniff" ||
    response.headers.get("content-disposition") !==
      `attachment; filename="${filename}"`
  ) {
    return invalidExportResponse(
      response,
      "The Kurobara API returned invalid export metadata."
    );
  }
  if (
    contentLengthHeader === null ||
    contentSha256 === null ||
    !DECIMAL_LENGTH_PATTERN.test(contentLengthHeader) ||
    !EXPORT_SHA256_PATTERN.test(contentSha256)
  ) {
    return invalidExportResponse(
      response,
      "The Kurobara API returned invalid export integrity metadata."
    );
  }
  const contentLength = Number(contentLengthHeader);
  if (!Number.isSafeInteger(contentLength) || contentLength > maxBytes) {
    return invalidExportResponse(
      response,
      "The Kurobara API export exceeded the configured limit."
    );
  }
  const delivery = await parseExportDeliveryHeaders(response, deliveryTracking);

  return {
    bytes: exportBytes(
      response.body,
      { contentLength, contentSha256 },
      maxBytes
    ),
    contentLength,
    contentSha256,
    contentType,
    ...(delivery === undefined ? {} : { delivery }),
    filename,
  };
}

export const createKurobaraClient = (
  options: KurobaraClientOptions
): KurobaraClient => {
  const apiKey = validateApiKey(options.apiKey);
  const baseUrl = normalizeBaseUrl(options.baseUrl);
  const fetchImplementation = options.fetch ?? globalThis.fetch;
  const maxResponseBytes = validateMaximum(options.maxResponseBytes);
  const nextBoundary = options.multipartBoundary ?? defaultBoundary;

  const restrictContactPrivacy = async (
    request: ContactPrivacyRestrictionRequest,
    requestOptions: KurobaraRequestOptions = {}
  ): Promise<ContactPrivacyRestrictionResponse> => {
    const validated = parseContactPrivacyRestrictionRequest(request);
    const body = serializeBoundedJson(
      validated,
      DEFAULT_MAX_REQUEST_BYTES,
      "Contact privacy restriction request"
    );
    const response = await fetchJsonMutation({
      apiKey,
      baseUrl,
      body,
      fetchImplementation,
      path: "v1/contact-privacy-restrictions",
      ...(requestOptions.signal === undefined
        ? {}
        : { signal: requestOptions.signal }),
    });
    return parseContactPrivacyRestrictionResponse(response, maxResponseBytes);
  };

  const getExportDelivery = async (
    request: ExportDeliveryGetRequest,
    requestOptions: KurobaraRequestOptions = {}
  ): Promise<ExportDeliveryState> => {
    const validated = parseExportDeliveryGetRequest(request);
    const response = await fetchJsonGet({
      apiKey,
      baseUrl,
      fetchImplementation,
      path: `v1/export-deliveries/${encodeURIComponent(validated.delivery_id)}`,
      ...(requestOptions.signal === undefined
        ? {}
        : { signal: requestOptions.signal }),
    });
    const parsed = await parseExportDeliveryGetResponse(
      response,
      maxResponseBytes
    );
    if (parsed.delivery_id !== validated.delivery_id) {
      throw new KurobaraTransportError(
        "invalid-response",
        "The Kurobara API returned a mismatched export delivery response."
      );
    }
    return parsed;
  };

  const revokeExportDelivery = async (
    request: ExportDeliveryRevokeRequest,
    requestOptions: KurobaraRequestOptions = {}
  ): Promise<ExportDeliveryRevocation> => {
    const validated = parseExportDeliveryRevokeRequest(request);
    const response = await fetchJsonMutation({
      apiKey,
      baseUrl,
      body: "{}",
      fetchImplementation,
      path: `v1/export-deliveries/${encodeURIComponent(validated.delivery_id)}/revoke`,
      ...(requestOptions.signal === undefined
        ? {}
        : { signal: requestOptions.signal }),
    });
    const parsed = await parseExportDeliveryRevokeResponse(
      response,
      maxResponseBytes
    );
    if (parsed.delivery_id !== validated.delivery_id) {
      throw new KurobaraTransportError(
        "invalid-response",
        "The Kurobara API returned a mismatched export delivery revocation response."
      );
    }
    return parsed;
  };

  const importDataset = async (
    input: DatasetImportInput
  ): Promise<DatasetImportResponse> => {
    const metadata = validateImportMetadata(input.metadata);
    const boundary = validateBoundary(nextBoundary());
    const response = await fetchDatasetImport({
      apiKey,
      baseUrl,
      boundary,
      fetchImplementation,
      input,
      metadata,
    });
    return parseDatasetImportResponse(response, maxResponseBytes);
  };

  const discoverContacts = async (
    request: ContactDiscoverRequest,
    requestOptions: KurobaraRequestOptions = {}
  ): Promise<ContactDiscoverResponse> => {
    const validated = parseContactDiscoverRequest(request);
    const body = serializeBoundedJson(
      validated,
      DEFAULT_MAX_REQUEST_BYTES,
      "Contact discovery request"
    );
    const response = await fetchJsonMutation({
      apiKey,
      baseUrl,
      body,
      fetchImplementation,
      path: "v1/contact-discoveries",
      ...(requestOptions.signal === undefined
        ? {}
        : { signal: requestOptions.signal }),
    });
    const parsed = await parseContactDiscoverResponse(
      response,
      maxResponseBytes
    );
    const sourceMatches =
      validated.organization_dataset === undefined
        ? parsed.organization_source.kind === "generation" &&
          parsed.organization_source.generation_id ===
            validated.organization_generation_id
        : parsed.organization_source.kind === "dataset" &&
          parsed.organization_source.dataset_id ===
            validated.organization_dataset.dataset_id &&
          JSON.stringify(parsed.organization_source.field_mapping) ===
            JSON.stringify(validated.organization_dataset.field_mapping) &&
          parsed.organization_source.default_country_code ===
            validated.organization_dataset.default_country_code;
    if (
      parsed.dataset_id !== validated.dataset_id ||
      parsed.mode !== validated.mode ||
      !sourceMatches
    ) {
      throw new KurobaraTransportError(
        "invalid-response",
        "The Kurobara API returned a mismatched contact discovery response."
      );
    }
    return parsed;
  };

  type SelectedContactDerivationRoute = Readonly<{
    invalidResponseMessage: string;
    mismatchMessage: string;
    parseRequest: (value: unknown) => SelectedContactDerivationRequest;
    path: string;
    problemCodes: ReadonlySet<string>;
    requestLabel: string;
  }>;

  const mutateSelectedContactDerivation = async (
    request: SelectedContactDerivationRequest,
    route: SelectedContactDerivationRoute,
    requestOptions: KurobaraRequestOptions
  ): Promise<SelectedContactDerivationResponse> => {
    const validated = route.parseRequest(request);
    const body = serializeBoundedJson(
      validated,
      DEFAULT_MAX_REQUEST_BYTES,
      route.requestLabel
    );
    const response = await fetchJsonMutation({
      apiKey,
      baseUrl,
      body,
      fetchImplementation,
      path: route.path,
      ...(requestOptions.signal === undefined
        ? {}
        : { signal: requestOptions.signal }),
    });
    const parsed = await parseSelectedContactDerivationResponse(
      response,
      maxResponseBytes,
      route.problemCodes,
      route.invalidResponseMessage
    );
    if (
      parsed.operation_id !== validated.operation_id ||
      parsed.contact_dataset_id !== validated.contact_dataset_id ||
      parsed.contact_record_ids.length !==
        validated.contact_record_ids.length ||
      parsed.contact_record_ids.some(
        (recordId, index) => recordId !== validated.contact_record_ids[index]
      )
    ) {
      throw new KurobaraTransportError(
        "invalid-response",
        route.mismatchMessage
      );
    }
    return parsed;
  };

  const resolveContactWorkEmails = (
    request: ContactWorkEmailRequest,
    requestOptions: KurobaraRequestOptions = {}
  ): Promise<ContactWorkEmailResponse> =>
    mutateSelectedContactDerivation(
      request,
      {
        invalidResponseMessage:
          "The Kurobara API returned an invalid contact work-email response.",
        mismatchMessage:
          "The Kurobara API returned a mismatched contact work-email response.",
        parseRequest: parseContactWorkEmailRequest,
        path: "v1/contact-work-email-resolutions",
        problemCodes: contactsWorkEmailResolveProblemCodes,
        requestLabel: "Contact work-email request",
      },
      requestOptions
    );

  const revealContactIdentities = (
    request: ContactIdentityRevealRequest,
    requestOptions: KurobaraRequestOptions = {}
  ): Promise<ContactIdentityRevealResponse> =>
    mutateSelectedContactDerivation(
      request,
      {
        invalidResponseMessage:
          "The Kurobara API returned an invalid contact identity reveal response.",
        mismatchMessage:
          "The Kurobara API returned a mismatched contact identity reveal response.",
        parseRequest: parseContactIdentityRevealRequest,
        path: "v1/contact-identity-reveals",
        problemCodes: contactsIdentityRevealProblemCodes,
        requestLabel: "Contact identity reveal request",
      },
      requestOptions
    );

  const verifyContactWorkEmails = (
    request: ContactWorkEmailRequest,
    requestOptions: KurobaraRequestOptions = {}
  ): Promise<ContactWorkEmailResponse> =>
    mutateSelectedContactDerivation(
      request,
      {
        invalidResponseMessage:
          "The Kurobara API returned an invalid contact work-email response.",
        mismatchMessage:
          "The Kurobara API returned a mismatched contact work-email response.",
        parseRequest: parseContactWorkEmailRequest,
        path: "v1/contact-work-email-verifications",
        problemCodes: contactsWorkEmailVerifyProblemCodes,
        requestLabel: "Contact work-email request",
      },
      requestOptions
    );

  const discoverOrganizations = async (
    request: OrganizationDiscoverRequest,
    requestOptions: KurobaraRequestOptions = {}
  ): Promise<OrganizationDiscoverResponse> => {
    const validated = parseOrganizationDiscoverRequest(request);
    const body = serializeBoundedJson(
      validated,
      DEFAULT_MAX_REQUEST_BYTES,
      "Organization discovery request"
    );
    const response = await fetchJsonMutation({
      apiKey,
      baseUrl,
      body,
      fetchImplementation,
      path: "v1/organization-discoveries",
      ...(requestOptions.signal === undefined
        ? {}
        : { signal: requestOptions.signal }),
    });
    const parsed = await parseOrganizationDiscoverResponse(
      response,
      maxResponseBytes
    );
    if (
      parsed.dataset_id !== validated.dataset_id ||
      parsed.mode !== validated.mode
    ) {
      throw new KurobaraTransportError(
        "invalid-response",
        "The Kurobara API returned a mismatched organization discovery response."
      );
    }
    return parsed;
  };

  const listOrganizationCandidates = async (
    request: OrganizationCandidatesListRequest,
    requestOptions: KurobaraRequestOptions = {}
  ): Promise<OrganizationCandidatesListResponse> => {
    const validated = parseOrganizationCandidatesListRequest(request);
    const query = new URLSearchParams({ limit: String(validated.limit) });
    if (validated.after_ordinal !== undefined) {
      query.set("after_ordinal", String(validated.after_ordinal));
    }
    const response = await fetchJsonGet({
      apiKey,
      baseUrl,
      fetchImplementation,
      path: `v1/dataset-generations/${encodeURIComponent(validated.generation_id)}/company-candidates?${query.toString()}`,
      ...(requestOptions.signal === undefined
        ? {}
        : { signal: requestOptions.signal }),
    });
    const parsed = await parseOrganizationCandidatesListResponse(
      response,
      maxResponseBytes
    );
    const expectedAfterOrdinal = validated.after_ordinal ?? 0;
    const ordinals = parsed.items.map(({ ordinal }) => ordinal);
    if (
      parsed.generation_id !== validated.generation_id ||
      parsed.page.after_ordinal !== expectedAfterOrdinal ||
      parsed.page.limit !== validated.limit ||
      parsed.items.length > validated.limit ||
      ordinals.some(
        (ordinal, index) =>
          ordinal <= (index === 0 ? expectedAfterOrdinal : ordinals[index - 1])
      ) ||
      (parsed.page.has_more
        ? parsed.items.length !== validated.limit ||
          parsed.page.next_after_ordinal !== ordinals.at(-1)
        : parsed.page.next_after_ordinal !== null)
    ) {
      throw new KurobaraTransportError(
        "invalid-response",
        "The Kurobara API returned a mismatched organization candidate list response."
      );
    }
    return parsed;
  };

  const listContactCandidates = async (
    request: ContactCandidatesListRequest,
    requestOptions: KurobaraRequestOptions = {}
  ): Promise<ContactCandidatesListResponse> => {
    const validated = parseContactCandidatesListRequest(request);
    const query = new URLSearchParams({ limit: String(validated.limit) });
    if (validated.after_ordinal !== undefined) {
      query.set("after_ordinal", String(validated.after_ordinal));
    }
    const response = await fetchJsonGet({
      apiKey,
      baseUrl,
      fetchImplementation,
      path: `v1/dataset-generations/${encodeURIComponent(validated.generation_id)}/contact-candidates?${query.toString()}`,
      ...(requestOptions.signal === undefined
        ? {}
        : { signal: requestOptions.signal }),
    });
    const parsed = await parseContactCandidatesListResponse(
      response,
      maxResponseBytes
    );
    const expectedAfterOrdinal = validated.after_ordinal ?? 0;
    const ordinals = parsed.items.map(({ ordinal }) => ordinal);
    if (
      parsed.generation_id !== validated.generation_id ||
      parsed.page.after_ordinal !== expectedAfterOrdinal ||
      parsed.page.limit !== validated.limit ||
      parsed.items.length > validated.limit ||
      ordinals.some(
        (ordinal, index) =>
          ordinal <= (index === 0 ? expectedAfterOrdinal : ordinals[index - 1])
      ) ||
      (parsed.page.has_more
        ? parsed.items.length !== validated.limit ||
          parsed.page.next_after_ordinal !== ordinals.at(-1)
        : parsed.page.next_after_ordinal !== null)
    ) {
      throw new KurobaraTransportError(
        "invalid-response",
        "The Kurobara API returned a mismatched contact candidate list response."
      );
    }
    return parsed;
  };

  const getDatasetGeneration = async (
    request: DatasetGenerationGetRequest,
    requestOptions: KurobaraRequestOptions = {}
  ): Promise<DatasetGenerationGetResponse> => {
    const validated = parseDatasetGenerationGetRequest(request);
    const response = await fetchJsonGet({
      apiKey,
      baseUrl,
      fetchImplementation,
      path: `v1/dataset-generations/${encodeURIComponent(validated.generation_id)}`,
      ...(requestOptions.signal === undefined
        ? {}
        : { signal: requestOptions.signal }),
    });
    const parsed = await parseDatasetGenerationGetResponse(
      response,
      maxResponseBytes
    );
    if (parsed.generation_id !== validated.generation_id) {
      throw new KurobaraTransportError(
        "invalid-response",
        "The Kurobara API returned a mismatched dataset generation response."
      );
    }
    return parsed;
  };

  const cancelDatasetGeneration = async (
    request: DatasetGenerationCancelRequest,
    requestOptions: KurobaraRequestOptions = {}
  ): Promise<DatasetGenerationCancelResponse> => {
    const validated = parseDatasetGenerationCancelRequest(request);
    const body = serializeBoundedJson(
      { idempotency_key: validated.idempotency_key },
      DEFAULT_MAX_REQUEST_BYTES,
      "Dataset generation cancellation request"
    );
    const response = await fetchJsonMutation({
      apiKey,
      baseUrl,
      body,
      fetchImplementation,
      path: `v1/dataset-generations/${encodeURIComponent(validated.generation_id)}/cancel`,
      ...(requestOptions.signal === undefined
        ? {}
        : { signal: requestOptions.signal }),
    });
    const parsed = await parseDatasetGenerationCancelResponse(
      response,
      maxResponseBytes
    );
    if (parsed.generation_id !== validated.generation_id) {
      throw new KurobaraTransportError(
        "invalid-response",
        "The Kurobara API returned a mismatched dataset generation cancellation response."
      );
    }
    return parsed;
  };

  const applyRecipe = async (
    request: RecipeApplyRequest,
    requestOptions: KurobaraRequestOptions = {}
  ): Promise<RecipeApplyResponse> => {
    const validated = parseRecipeApplyRequest(request);
    const body = serializeBoundedJson(
      validated,
      DEFAULT_MAX_REQUEST_BYTES,
      "Recipe apply request"
    );
    const response = await fetchJsonMutation({
      apiKey,
      baseUrl,
      body,
      fetchImplementation,
      path: "v1/recipe-applications",
      ...(requestOptions.signal === undefined
        ? {}
        : { signal: requestOptions.signal }),
    });
    return parseRecipeApplyResponse(response, maxResponseBytes);
  };

  const getRecipeApplication = async (
    request: RecipeApplicationGetRequest,
    requestOptions: KurobaraRequestOptions = {}
  ): Promise<RecipeApplicationGetResponse> => {
    const validated = parseRecipeApplicationGetRequest(request);
    const response = await fetchJsonGet({
      apiKey,
      baseUrl,
      fetchImplementation,
      path: `v1/recipe-applications/${encodeURIComponent(validated.application_id)}`,
      ...(requestOptions.signal === undefined
        ? {}
        : { signal: requestOptions.signal }),
    });
    const parsed = await parseRecipeApplicationGetResponse(
      response,
      maxResponseBytes
    );
    if (parsed.application_id !== validated.application_id) {
      throw new KurobaraTransportError(
        "invalid-response",
        "The Kurobara API returned a mismatched recipe application response."
      );
    }
    return parsed;
  };

  const exportRecipeApplication = async (
    request: RecipeApplicationExportRequest,
    requestOptions: RecipeApplicationExportOptions = {}
  ): Promise<RecipeApplicationExportStream> => {
    const validated = parseRecipeApplicationExportRequest(request);
    const maximumBytes = validateExportMaximum(requestOptions.maxBytes);
    const body = serializeBoundedJson(
      validated,
      DEFAULT_MAX_REQUEST_BYTES,
      "Recipe application export request"
    );
    const response = await fetchJsonMutation({
      apiKey,
      baseUrl,
      body,
      fetchImplementation,
      path: "v1/recipe-application-exports",
      ...(requestOptions.signal === undefined
        ? {}
        : { signal: requestOptions.signal }),
    });
    return parseExportResponse(
      response,
      validated.format,
      recipeApplicationsExportOperation,
      recipeApplicationsExportProblemCodes,
      maximumBytes,
      maxResponseBytes,
      "forbidden"
    );
  };

  const exportDataset = async (
    request: DatasetExportRequest,
    requestOptions: DatasetExportOptions = {}
  ): Promise<DatasetExportStream> => {
    const validated = parseDatasetExportRequest(request);
    const maximumBytes = validateExportMaximum(requestOptions.maxBytes);
    const body = serializeBoundedJson(
      validated,
      DEFAULT_MAX_REQUEST_BYTES,
      "Dataset export request"
    );
    const response = await fetchJsonMutation({
      apiKey,
      baseUrl,
      body,
      fetchImplementation,
      path: "v1/dataset-exports",
      ...(requestOptions.signal === undefined
        ? {}
        : { signal: requestOptions.signal }),
    });
    return parseExportResponse(
      response,
      validated.format,
      datasetsExportOperation,
      datasetExportProblemCodes,
      maximumBytes,
      maxResponseBytes,
      "optional"
    );
  };

  const cancelRun = async (
    request: RunCancelRequest,
    requestOptions: KurobaraRequestOptions = {}
  ): Promise<RunCancelResponse> => {
    const validated = parseRunCancelRequest(request);
    const body = serializeBoundedJson(
      { idempotency_key: validated.idempotency_key },
      DEFAULT_MAX_REQUEST_BYTES,
      "Run cancellation request"
    );
    const response = await fetchJsonMutation({
      apiKey,
      baseUrl,
      body,
      fetchImplementation,
      path: `v1/runs/${encodeURIComponent(validated.run_id)}/cancel`,
      ...(requestOptions.signal === undefined
        ? {}
        : { signal: requestOptions.signal }),
    });
    const parsed = await parseRunCancelResponse(response, maxResponseBytes);
    if (parsed.run_id !== validated.run_id) {
      throw new KurobaraTransportError(
        "invalid-response",
        "The Kurobara API returned a mismatched run cancellation response."
      );
    }
    return parsed;
  };

  return {
    contactPrivacy: {
      restrict: restrictContactPrivacy,
    },
    contacts: {
      discover: discoverContacts,
      listCandidates: listContactCandidates,
      revealIdentities: revealContactIdentities,
      resolveWorkEmails: resolveContactWorkEmails,
      verifyWorkEmails: verifyContactWorkEmails,
    },
    datasetGenerations: {
      cancel: cancelDatasetGeneration,
      get: getDatasetGeneration,
    },
    datasets: { export: exportDataset, import: importDataset },
    exportDeliveries: {
      get: getExportDelivery,
      revoke: revokeExportDelivery,
    },
    organizations: {
      discover: discoverOrganizations,
      listCandidates: listOrganizationCandidates,
    },
    recipeApplications: {
      export: exportRecipeApplication,
      get: getRecipeApplication,
    },
    recipes: { apply: applyRecipe },
    runs: { cancel: cancelRun },
  };
};
