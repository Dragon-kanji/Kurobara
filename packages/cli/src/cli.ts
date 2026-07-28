import { createHash, randomUUID } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import { link, lstat, open, rename, unlink } from "node:fs/promises";
import path from "node:path";
import type { Readable } from "node:stream";

import cliCommands from "@kurobara/contracts/cli-commands.json" with {
  type: "json",
};
import {
  type ContactCandidatesListResponse,
  type ContactDiscoverRequest,
  type ContactPrivacyRestrictionRequest,
  createKurobaraClient,
  type DatasetExportRequest,
  type DatasetGenerationCancelResponse,
  type DatasetGenerationGetResponse,
  type DatasetImportMetadata,
  type DatasetImportSource,
  type ExportDeliveryState,
  type GtmContextCommand,
  type GtmContextStatusInput,
  type GtmQuestionnaireInput,
  KurobaraConfigError,
  type KurobaraExportStream,
  KurobaraProblemError,
  KurobaraTransportError,
  type OrganizationCandidatesListResponse,
  type OrganizationDiscoverRequest,
  type PlayCommand,
  type PlayRun,
  type PlayRunGetInput,
  parseRecipeApplyRequest,
  type RecipeApplicationExportRequest,
  type RecipeApplicationGetResponse,
  type RecipeApplyRequest,
  type SelectedContactDerivationRequest,
  type WorkbookGetInput,
  type WorkbookUpdateInput,
} from "@kurobara/sdk";
import { renderHumanCommandResult } from "./human-output.ts";
import { runOnboardingCli } from "./onboarding.ts";

const DEFAULT_ENDPOINT = "http://127.0.0.1:3000";
const MAX_API_KEY_FILE_BYTES = 4096;
const MAX_CONTACT_PRIVACY_SUBJECT_FILE_BYTES = 4096;
const MAX_METADATA_FILE_BYTES = 65_536;
const MAX_RECIPE_REQUEST_FILE_BYTES = 65_536;
const DEFAULT_WATCH_POLL_INTERVAL_MS = 1000;
const MAX_WATCH_POLL_INTERVAL_MS = 60_000;
const MAX_WATCH_TIMEOUT_MS = 86_400_000;
const DEFAULT_EXPORT_MAX_BYTES = 1024 * 1024 * 1024;
const DEFAULT_EXPORT_TIMEOUT_MS = 10 * 60_000;
const MAX_EXPORT_BYTES = 1024 * 1024 * 1024 * 1024;
const MAX_EXPORT_TIMEOUT_MS = 86_400_000;
const MIN_WATCH_POLL_INTERVAL_MS = 100;
const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const COMPANY_COUNTRY_CODE_PATTERN = /^[A-Z]{2}$/u;
const DATASET_FIELD_KEY_PATTERN = /^[a-z][a-z0-9_]{0,127}$/u;
const UNSIGNED_INTEGER_PATTERN = /^(0|[1-9][0-9]*)$/u;
const TRAILING_NEWLINE_PATTERN = /\r?\n$/u;
const WHITESPACE_PATTERN = /\s/u;
const DATASET_IMPORT_COMMAND = cliCommands.commands.find(
  (command) => command.operation_id === "datasets.import"
);
const DATASET_EXPORT_COMMAND = cliCommands.commands.find(
  (command) => command.operation_id === "datasets.export"
);
const RECIPE_APPLY_COMMAND = cliCommands.commands.find(
  (command) => command.operation_id === "recipes.apply"
);
const RECIPE_WATCH_COMMAND = cliCommands.commands.find(
  (command) => command.operation_id === "recipe-applications.get"
);
const RECIPE_EXPORT_COMMAND = cliCommands.commands.find(
  (command) => command.operation_id === "recipe-applications.export"
);
const RUN_CANCEL_COMMAND = cliCommands.commands.find(
  (command) => command.operation_id === "runs.cancel"
);
const ORGANIZATION_DISCOVER_COMMAND = cliCommands.commands.find(
  (command) => command.operation_id === "organizations.discover"
);
const ORGANIZATION_CANDIDATES_LIST_COMMAND = cliCommands.commands.find(
  (command) => command.operation_id === "organizations.candidates.list"
);
const CONTACT_CANDIDATES_LIST_COMMAND = cliCommands.commands.find(
  (command) => command.operation_id === "contacts.candidates.list"
);
const CONTACT_DISCOVER_COMMAND = cliCommands.commands.find(
  (command) => command.operation_id === "contacts.discover"
);
const CONTACT_PRIVACY_RESTRICT_COMMAND = cliCommands.commands.find(
  (command) => command.operation_id === "contact-privacy.restrict"
);
const CONTACT_IDENTITY_REVEAL_COMMAND = cliCommands.commands.find(
  (command) => command.operation_id === "contacts.identity.reveal"
);
const CONTACT_WORK_EMAIL_RESOLVE_COMMAND = cliCommands.commands.find(
  (command) => command.operation_id === "contacts.work-email.resolve"
);
const CONTACT_WORK_EMAIL_VERIFY_COMMAND = cliCommands.commands.find(
  (command) => command.operation_id === "contacts.work-email.verify"
);
const DATASET_GENERATION_WATCH_COMMAND = cliCommands.commands.find(
  (command) => command.operation_id === "dataset-generations.get"
);
const DATASET_GENERATION_CANCEL_COMMAND = cliCommands.commands.find(
  (command) => command.operation_id === "dataset-generations.cancel"
);
const EXPORT_DELIVERY_GET_COMMAND = cliCommands.commands.find(
  (command) => command.operation_id === "export-deliveries.get"
);
const EXPORT_DELIVERY_REVOKE_COMMAND = cliCommands.commands.find(
  (command) => command.operation_id === "export-deliveries.revoke"
);
const GTM_QUESTIONS_COMMAND = cliCommands.commands.find(
  (command) => command.operation_id === "gtm-contexts.questionnaire.get"
);
const GTM_CONTEXT_PLAN_COMMAND = cliCommands.commands.find(
  (command) => command.operation_id === "gtm-contexts.plan"
);
const GTM_CONTEXT_APPLY_COMMAND = cliCommands.commands.find(
  (command) => command.operation_id === "gtm-contexts.apply"
);
const GTM_CONTEXT_STATUS_COMMAND = cliCommands.commands.find(
  (command) => command.operation_id === "gtm-contexts.status.get"
);
const PLAY_PREVIEW_COMMAND = cliCommands.commands.find(
  (command) => command.operation_id === "plays.preview"
);
const PLAY_APPLY_COMMAND = cliCommands.commands.find(
  (command) => command.operation_id === "plays.apply"
);
const PLAY_RUN_COMMAND = cliCommands.commands.find(
  (command) => command.operation_id === "play-runs.get"
);
const WORKBOOK_GET_COMMAND = cliCommands.commands.find(
  (command) => command.operation_id === "workbooks.get"
);
const WORKBOOK_UPDATE_COMMAND = cliCommands.commands.find(
  (command) => command.operation_id === "workbooks.update"
);

if (
  DATASET_IMPORT_COMMAND === undefined ||
  DATASET_EXPORT_COMMAND === undefined ||
  RECIPE_APPLY_COMMAND === undefined ||
  RECIPE_EXPORT_COMMAND === undefined ||
  RECIPE_WATCH_COMMAND === undefined ||
  RUN_CANCEL_COMMAND === undefined ||
  ORGANIZATION_CANDIDATES_LIST_COMMAND === undefined ||
  CONTACT_CANDIDATES_LIST_COMMAND === undefined ||
  ORGANIZATION_DISCOVER_COMMAND === undefined ||
  CONTACT_DISCOVER_COMMAND === undefined ||
  CONTACT_IDENTITY_REVEAL_COMMAND === undefined ||
  CONTACT_WORK_EMAIL_RESOLVE_COMMAND === undefined ||
  CONTACT_WORK_EMAIL_VERIFY_COMMAND === undefined ||
  CONTACT_PRIVACY_RESTRICT_COMMAND === undefined ||
  DATASET_GENERATION_CANCEL_COMMAND === undefined ||
  DATASET_GENERATION_WATCH_COMMAND === undefined ||
  EXPORT_DELIVERY_GET_COMMAND === undefined ||
  EXPORT_DELIVERY_REVOKE_COMMAND === undefined ||
  GTM_QUESTIONS_COMMAND === undefined ||
  GTM_CONTEXT_PLAN_COMMAND === undefined ||
  GTM_CONTEXT_APPLY_COMMAND === undefined ||
  GTM_CONTEXT_STATUS_COMMAND === undefined ||
  PLAY_PREVIEW_COMMAND === undefined ||
  PLAY_APPLY_COMMAND === undefined ||
  PLAY_RUN_COMMAND === undefined ||
  WORKBOOK_GET_COMMAND === undefined ||
  WORKBOOK_UPDATE_COMMAND === undefined
) {
  throw new Error("The generated Kurobara CLI contracts are unavailable.");
}

type WritableTarget = Readonly<{
  isTTY?: boolean;
  off?: (event: "drain", listener: () => void) => unknown;
  once?: (event: "drain", listener: () => void) => unknown;
  write: (chunk: string | Uint8Array) => unknown;
}>;

type ReadableSource = Readable & AsyncIterable<unknown>;

export type CliInvocation = Readonly<{
  argv: readonly string[];
  environment: Readonly<Record<string, string | undefined>>;
  fetch?: typeof fetch;
  now?: () => number;
  signal?: AbortSignal;
  stderr: WritableTarget;
  stdin: ReadableSource;
  stdout: WritableTarget;
  wait?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
}>;

type DatasetImportArguments = Readonly<{
  apiKeyFile?: string;
  command: "datasets.import";
  endpoint: string;
  metadataFile: string;
  sourceFile: string;
}>;

type DatasetExportArguments = Readonly<{
  apiKeyFile?: string;
  command: "datasets.export";
  datasetId: string;
  endpoint: string;
  fieldIds?: readonly string[];
  format: "csv" | "jsonl";
  maxBytes: number;
  outputFile?: string;
  receiptFile?: string;
  timeoutMs: number;
}>;

type ExportDeliveryArguments = Readonly<{
  apiKeyFile?: string;
  deliveryId: string;
  endpoint: string;
}> &
  (
    | Readonly<{ command: "export-deliveries.get" }>
    | Readonly<{ command: "export-deliveries.revoke" }>
  );

type ContactPrivacyRestrictArguments = Readonly<{
  apiKeyFile?: string;
  command: "contact-privacy.restrict";
  endpoint: string;
  idempotencyKey: string;
  reason: ContactPrivacyRestrictionRequest["reason"];
  valueFile: string;
}> &
  (
    | Readonly<{ kind: "email"; providerKey?: never }>
    | Readonly<{ kind: "provider-subject"; providerKey: string }>
  );

type RecipeApplyArguments = Readonly<{
  apiKeyFile?: string;
  command: "recipes.apply";
  endpoint: string;
  requestFile: string;
}>;

type RecipeWatchArguments = Readonly<{
  apiKeyFile?: string;
  applicationId: string;
  command: "recipe-applications.get";
  endpoint: string;
  pollIntervalMs: number;
  timeoutMs: number;
}>;

type RecipeExportArguments = Readonly<{
  apiKeyFile?: string;
  applicationId: string;
  command: "recipe-applications.export";
  endpoint: string;
  fieldIds?: readonly string[];
  format: "csv" | "jsonl";
  maxBytes: number;
  outputFile: string;
  timeoutMs: number;
}>;

type RunCancelArguments = Readonly<{
  apiKeyFile?: string;
  command: "runs.cancel";
  endpoint: string;
  idempotencyKey: string;
  runId: string;
}>;

type CompanySearchArguments = Readonly<{
  apiKeyFile?: string;
  authorityEnvelopeId: string;
  budgetLimit: number;
  budgetUnit: string;
  command: "organizations.discover";
  countries: readonly string[];
  datasetId: string;
  datasetName: string;
  deadlineMs: number;
  discoveryId: string;
  employeeMaximum?: number;
  employeeMinimum?: number;
  endpoint: string;
  industries: readonly string[];
  keywords?: readonly string[];
  maxCalls: number;
  maxCompanies: number;
  maxPages: number;
  mode: "dry-run" | "start";
}>;

type CompanyWatchArguments = Readonly<{
  apiKeyFile?: string;
  command: "dataset-generations.get";
  endpoint: string;
  generationId: string;
  pollIntervalMs: number;
  timeoutMs: number;
}>;

type CompanyCancelArguments = Readonly<{
  apiKeyFile?: string;
  command: "dataset-generations.cancel";
  endpoint: string;
  generationId: string;
  idempotencyKey: string;
}>;

type CompanyResultsArguments = Readonly<{
  afterOrdinal: number;
  apiKeyFile?: string;
  command: "organizations.candidates.list";
  endpoint: string;
  generationId: string;
  limit: number;
}>;

type ContactResultsArguments = Readonly<{
  afterOrdinal: number;
  apiKeyFile?: string;
  command: "contacts.candidates.list";
  endpoint: string;
  generationId: string;
  limit: number;
}>;

type ContactSearchArguments = Readonly<{
  apiKeyFile?: string;
  authorityEnvelopeId: string;
  budgetLimit: number;
  budgetUnit: string;
  command: "contacts.discover";
  companyCountries: readonly string[];
  datasetId: string;
  datasetName: string;
  deadlineMs: number;
  departments: readonly string[];
  discoveryId: string;
  endpoint: string;
  maxCalls: number;
  maxCompanies: number;
  maxContactsPerCompany: number;
  maxContactsTotal: number;
  maxPages: number;
  mode: "dry-run" | "start";
  organizationSource:
    | Readonly<{ generationId: string; kind: "generation" }>
    | Readonly<{
        datasetId: string;
        defaultCountryCode?: string;
        fieldMapping: Readonly<{
          countryCode?: string;
          domain: string;
          name?: string;
        }>;
        kind: "dataset";
      }>;
  personCountries: readonly string[];
  seniorities: readonly string[];
  titles: readonly string[];
}>;

type ContactDerivationArguments = Readonly<{
  apiKeyFile?: string;
  authorityEnvelopeId: string;
  budgetLimit: number;
  budgetUnit: string;
  contactDatasetId: string;
  contactRecordIds: readonly string[];
  deadlineMs: number;
  endpoint: string;
  operationId: string;
}> &
  (
    | Readonly<{ command: "contacts.identity.reveal" }>
    | Readonly<{ command: "contacts.work-email.resolve" }>
    | Readonly<{ command: "contacts.work-email.verify" }>
  );

type AgentSurfaceArguments = Readonly<{
  apiKeyFile?: string;
  endpoint: string;
}> &
  (
    | Readonly<{
        command: "gtm-contexts.questionnaire.get" | "gtm-contexts.status.get";
        profile: GtmQuestionnaireInput["profile"];
      }>
    | Readonly<{
        command:
          | "gtm-contexts.apply"
          | "gtm-contexts.plan"
          | "plays.apply"
          | "plays.preview"
          | "workbooks.get"
          | "workbooks.update";
        requestFile: string;
      }>
    | Readonly<{
        command: "play-runs.get";
        pollIntervalMs: number;
        runId: string;
        timeoutMs: number;
      }>
  );

type CliArguments =
  | AgentSurfaceArguments
  | ContactPrivacyRestrictArguments
  | ContactResultsArguments
  | ContactSearchArguments
  | ContactDerivationArguments
  | CompanySearchArguments
  | CompanyCancelArguments
  | CompanyResultsArguments
  | CompanyWatchArguments
  | DatasetExportArguments
  | DatasetImportArguments
  | ExportDeliveryArguments
  | RecipeApplyArguments
  | RecipeExportArguments
  | RecipeWatchArguments
  | RunCancelArguments;

type CliFailureCode =
  | "cli-config-invalid"
  | "cli-contract-error"
  | "cli-input-invalid"
  | "cli-runtime-error"
  | "cli-export-aborted"
  | "cli-export-timeout"
  | "cli-output-error"
  | "cli-watch-aborted"
  | "cli-watch-timeout"
  | "cli-transport-error"
  | "cli-usage-error";

type CliFailure = Readonly<{
  code: CliFailureCode;
  retryable: boolean;
  status: 0;
  title: string;
  type: "about:blank";
}>;

class CliInputError extends Error {
  readonly code: CliFailureCode;

  constructor(code: CliFailureCode, message: string) {
    super(message);
    this.code = code;
    this.name = "CliInputError";
  }
}

class CliWatchError extends Error {
  readonly code: "cli-watch-aborted" | "cli-watch-timeout";

  constructor(
    code: "cli-watch-aborted" | "cli-watch-timeout",
    message: string
  ) {
    super(message);
    this.code = code;
    this.name = "CliWatchError";
  }
}

class CliExportError extends Error {
  readonly code: "cli-export-aborted" | "cli-export-timeout";

  constructor(
    code: "cli-export-aborted" | "cli-export-timeout",
    message: string
  ) {
    super(message);
    this.code = code;
    this.name = "CliExportError";
  }
}

class CliOutputError extends Error {
  readonly name = "CliOutputError";
}

const failure = (
  code: CliFailureCode,
  title: string,
  retryable = false
): CliFailure => ({
  code,
  retryable,
  status: 0,
  title,
  type: "about:blank",
});

const writeJson = (target: WritableTarget, value: unknown): void => {
  target.write(`${JSON.stringify(value)}\n`);
};

type ParsedFlagValues = Readonly<{
  repeated: ReadonlyMap<string, readonly string[]>;
  values: ReadonlyMap<string, string>;
}>;

const parseFlagValues = (
  argv: readonly string[],
  allowedFlags: ReadonlySet<string>,
  invalidMessage: string,
  repeatableFlags: ReadonlySet<string> = new Set()
): ParsedFlagValues => {
  const values = new Map<string, string>();
  const repeated = new Map<string, string[]>();
  for (let index = 2; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag === undefined || value === undefined || !allowedFlags.has(flag)) {
      throw new CliInputError("cli-usage-error", invalidMessage);
    }
    if (repeatableFlags.has(flag)) {
      const selected = repeated.get(flag) ?? [];
      if (selected.includes(value)) {
        throw new CliInputError("cli-usage-error", invalidMessage);
      }
      selected.push(value);
      repeated.set(flag, selected);
    } else {
      if (values.has(flag)) {
        throw new CliInputError("cli-usage-error", invalidMessage);
      }
      values.set(flag, value);
    }
  }
  return { repeated, values };
};

const commonArguments = (
  values: ReadonlyMap<string, string>,
  environment: Readonly<Record<string, string | undefined>>
) => {
  const endpoint = values.get("--endpoint") ?? environment.KUROBARA_API_URL;
  return {
    ...(values.get("--api-key-file") === undefined
      ? {}
      : { apiKeyFile: values.get("--api-key-file") }),
    endpoint: endpoint ?? DEFAULT_ENDPOINT,
  };
};

const parseDatasetImportArguments = (
  argv: readonly string[],
  environment: Readonly<Record<string, string | undefined>>
): DatasetImportArguments => {
  const { values } = parseFlagValues(
    argv,
    new Set(["--api-key-file", "--endpoint", "--metadata", "--source"]),
    "Dataset import arguments are invalid."
  );
  const metadataFile = values.get("--metadata");
  const sourceFile = values.get("--source");
  if (
    metadataFile === undefined ||
    metadataFile.length === 0 ||
    sourceFile === undefined ||
    sourceFile.length === 0
  ) {
    throw new CliInputError(
      "cli-usage-error",
      "Dataset import requires --metadata and --source."
    );
  }
  return {
    ...commonArguments(values, environment),
    command: "datasets.import",
    metadataFile,
    sourceFile,
  };
};

const parseRecipeApplyArguments = (
  argv: readonly string[],
  environment: Readonly<Record<string, string | undefined>>
): RecipeApplyArguments => {
  const { values } = parseFlagValues(
    argv,
    new Set(["--api-key-file", "--endpoint", "--request"]),
    "Recipe apply arguments are invalid."
  );
  const requestFile = values.get("--request");
  if (requestFile === undefined || requestFile.length === 0) {
    throw new CliInputError(
      "cli-usage-error",
      "Recipe apply requires --request."
    );
  }
  return {
    ...commonArguments(values, environment),
    command: "recipes.apply",
    requestFile,
  };
};

const parseBoundedInteger = (
  value: string | undefined,
  minimum: number,
  maximum: number,
  message: string
): number => {
  if (value === undefined || !UNSIGNED_INTEGER_PATTERN.test(value)) {
    throw new CliInputError("cli-usage-error", message);
  }
  const parsed = Number(value);
  if (
    !(Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum)
  ) {
    throw new CliInputError("cli-usage-error", message);
  }
  return parsed;
};

const parsePositiveAmount = (
  value: string | undefined,
  message: string
): number => {
  const parsed = value === undefined ? Number.NaN : Number(value);
  if (
    !(Number.isFinite(parsed) && parsed > 0 && parsed <= 1_000_000_000_000_000)
  ) {
    throw new CliInputError("cli-usage-error", message);
  }
  return parsed;
};

const parseContactOrganizationSource = (
  values: ReadonlyMap<string, string>
): ContactSearchArguments["organizationSource"] => {
  const generationId = values.get("--organization-generation-id");
  const datasetId = values.get("--organization-dataset-id");
  const domain = values.get("--domain-field");
  const name = values.get("--name-field");
  const countryCode = values.get("--country-field");
  const defaultCountryCode = values.get("--default-company-country");
  const hasGeneration = generationId !== undefined && generationId.length > 0;
  const hasDataset = datasetId !== undefined && datasetId.length > 0;
  const datasetFieldsInvalid =
    domain === undefined ||
    !DATASET_FIELD_KEY_PATTERN.test(domain) ||
    (name !== undefined && !DATASET_FIELD_KEY_PATTERN.test(name)) ||
    (countryCode !== undefined &&
      !DATASET_FIELD_KEY_PATTERN.test(countryCode)) ||
    (defaultCountryCode !== undefined &&
      !COMPANY_COUNTRY_CODE_PATTERN.test(defaultCountryCode)) ||
    (countryCode === undefined && defaultCountryCode === undefined);
  const generationHasDatasetFields =
    domain !== undefined ||
    name !== undefined ||
    countryCode !== undefined ||
    defaultCountryCode !== undefined;
  if (
    hasGeneration === hasDataset ||
    (hasDataset && datasetFieldsInvalid) ||
    (hasGeneration && generationHasDatasetFields)
  ) {
    throw new CliInputError(
      "cli-usage-error",
      "Contact search requires exactly one source: --organization-generation-id, or --organization-dataset-id with --domain-field and a country field/default."
    );
  }
  if (hasGeneration) {
    return { generationId: generationId as string, kind: "generation" };
  }
  return {
    datasetId: datasetId as string,
    ...(defaultCountryCode === undefined ? {} : { defaultCountryCode }),
    fieldMapping: {
      ...(countryCode === undefined ? {} : { countryCode }),
      domain: domain as string,
      ...(name === undefined ? {} : { name }),
    },
    kind: "dataset",
  };
};

const parseContactSearchArguments = (
  argv: readonly string[],
  environment: Readonly<Record<string, string | undefined>>
): ContactSearchArguments => {
  const { repeated, values } = parseFlagValues(
    argv,
    new Set([
      "--api-key-file",
      "--authority-envelope-id",
      "--budget-limit",
      "--budget-unit",
      "--company-country",
      "--country-field",
      "--dataset-id",
      "--dataset-name",
      "--default-company-country",
      "--deadline-ms",
      "--department",
      "--discovery-id",
      "--domain-field",
      "--endpoint",
      "--max-calls",
      "--max-companies",
      "--max-contacts-per-company",
      "--max-contacts-total",
      "--max-pages",
      "--mode",
      "--name-field",
      "--organization-dataset-id",
      "--organization-generation-id",
      "--person-country",
      "--seniority",
      "--title",
    ]),
    "Contact search arguments are invalid.",
    new Set([
      "--company-country",
      "--department",
      "--person-country",
      "--seniority",
      "--title",
    ])
  );
  const authorityEnvelopeId = values.get("--authority-envelope-id");
  const budgetUnit = values.get("--budget-unit");
  const datasetId = values.get("--dataset-id");
  const datasetName = values.get("--dataset-name");
  const discoveryId = values.get("--discovery-id");
  const mode = values.get("--mode");
  if (
    authorityEnvelopeId === undefined ||
    authorityEnvelopeId.length === 0 ||
    budgetUnit === undefined ||
    budgetUnit.length === 0 ||
    datasetId === undefined ||
    datasetId.length === 0 ||
    datasetName === undefined ||
    datasetName.length === 0 ||
    discoveryId === undefined ||
    discoveryId.length === 0 ||
    (mode !== "dry-run" && mode !== "start")
  ) {
    throw new CliInputError(
      "cli-usage-error",
      "Contact search requires organization lineage, identity, mode, deadline, cost and cardinality bounds."
    );
  }
  const organizationSource = parseContactOrganizationSource(values);
  const maxCompanies = parseBoundedInteger(
    values.get("--max-companies"),
    1,
    10,
    "Contact search --max-companies is invalid."
  );
  const maxContactsPerCompany = parseBoundedInteger(
    values.get("--max-contacts-per-company"),
    1,
    2,
    "Contact search --max-contacts-per-company is invalid."
  );
  const maxContactsTotal = parseBoundedInteger(
    values.get("--max-contacts-total"),
    1,
    12,
    "Contact search --max-contacts-total is invalid."
  );
  if (maxContactsTotal > maxCompanies * maxContactsPerCompany) {
    throw new CliInputError(
      "cli-usage-error",
      "Contact search total cannot exceed companies times contacts per company."
    );
  }
  return {
    ...commonArguments(values, environment),
    authorityEnvelopeId,
    budgetLimit: parsePositiveAmount(
      values.get("--budget-limit"),
      "Contact search --budget-limit must be a positive finite amount."
    ),
    budgetUnit,
    command: "contacts.discover",
    companyCountries: repeated.get("--company-country") ?? [],
    datasetId,
    datasetName,
    deadlineMs: parseBoundedInteger(
      values.get("--deadline-ms"),
      0,
      Number.MAX_SAFE_INTEGER,
      "Contact search --deadline-ms is invalid."
    ),
    departments: repeated.get("--department") ?? [],
    discoveryId,
    maxCalls: parseBoundedInteger(
      values.get("--max-calls"),
      1,
      100,
      "Contact search --max-calls is invalid."
    ),
    maxCompanies,
    maxContactsPerCompany,
    maxContactsTotal,
    maxPages: parseBoundedInteger(
      values.get("--max-pages"),
      1,
      100,
      "Contact search --max-pages is invalid."
    ),
    mode,
    organizationSource,
    personCountries: repeated.get("--person-country") ?? [],
    seniorities: repeated.get("--seniority") ?? [],
    titles: repeated.get("--title") ?? [],
  };
};

const parseContactDerivationArguments = (
  argv: readonly string[],
  environment: Readonly<Record<string, string | undefined>>,
  command: ContactDerivationArguments["command"]
): ContactDerivationArguments => {
  const { repeated, values } = parseFlagValues(
    argv,
    new Set([
      "--api-key-file",
      "--authority-envelope-id",
      "--budget-limit",
      "--budget-unit",
      "--contact-dataset-id",
      "--deadline-ms",
      "--endpoint",
      "--operation-id",
      "--record-id",
    ]),
    "Contact derivation arguments are invalid.",
    new Set(["--record-id"])
  );
  const authorityEnvelopeId = values.get("--authority-envelope-id");
  const budgetUnit = values.get("--budget-unit");
  const contactDatasetId = values.get("--contact-dataset-id");
  const contactRecordIds = repeated.get("--record-id");
  const operationId = values.get("--operation-id");
  if (
    authorityEnvelopeId === undefined ||
    authorityEnvelopeId.length === 0 ||
    budgetUnit === undefined ||
    budgetUnit.length === 0 ||
    contactDatasetId === undefined ||
    contactDatasetId.length === 0 ||
    contactRecordIds === undefined ||
    contactRecordIds.length < 1 ||
    contactRecordIds.length > 3 ||
    new Set(contactRecordIds).size !== contactRecordIds.length ||
    operationId === undefined ||
    operationId.length === 0
  ) {
    throw new CliInputError(
      "cli-usage-error",
      "Contact derivation commands require one to three unique record IDs plus explicit source dataset, authority, deadline and budget."
    );
  }
  return {
    ...commonArguments(values, environment),
    authorityEnvelopeId,
    budgetLimit: parsePositiveAmount(
      values.get("--budget-limit"),
      "Contact derivation --budget-limit must be positive."
    ),
    budgetUnit,
    command,
    contactDatasetId,
    contactRecordIds,
    deadlineMs: parseBoundedInteger(
      values.get("--deadline-ms"),
      0,
      Number.MAX_SAFE_INTEGER,
      "Contact derivation --deadline-ms is invalid."
    ),
    operationId,
  };
};

const parseCompanySearchArguments = (
  argv: readonly string[],
  environment: Readonly<Record<string, string | undefined>>
): CompanySearchArguments => {
  const { repeated, values } = parseFlagValues(
    argv,
    new Set([
      "--api-key-file",
      "--authority-envelope-id",
      "--budget-limit",
      "--budget-unit",
      "--country",
      "--dataset-id",
      "--dataset-name",
      "--deadline-ms",
      "--discovery-id",
      "--employee-maximum",
      "--employee-minimum",
      "--endpoint",
      "--industry",
      "--keyword",
      "--max-calls",
      "--max-companies",
      "--max-pages",
      "--mode",
    ]),
    "Company search arguments are invalid.",
    new Set(["--country", "--industry", "--keyword"])
  );
  const authorityEnvelopeId = values.get("--authority-envelope-id");
  const budgetUnit = values.get("--budget-unit");
  const countries = repeated.get("--country");
  const datasetId = values.get("--dataset-id");
  const datasetName = values.get("--dataset-name");
  const discoveryId = values.get("--discovery-id");
  const industries = repeated.get("--industry");
  const mode = values.get("--mode");
  if (
    authorityEnvelopeId === undefined ||
    authorityEnvelopeId.length === 0 ||
    budgetUnit === undefined ||
    budgetUnit.length === 0 ||
    countries === undefined ||
    countries.length === 0 ||
    datasetId === undefined ||
    datasetId.length === 0 ||
    datasetName === undefined ||
    datasetName.length === 0 ||
    discoveryId === undefined ||
    discoveryId.length === 0 ||
    industries === undefined ||
    industries.length === 0 ||
    (mode !== "dry-run" && mode !== "start")
  ) {
    throw new CliInputError(
      "cli-usage-error",
      "Company search requires identity, country, industry, mode, deadline, cost and cardinality bounds."
    );
  }
  const employeeMinimumValue = values.get("--employee-minimum");
  const employeeMaximumValue = values.get("--employee-maximum");
  if (
    (employeeMinimumValue === undefined) !==
    (employeeMaximumValue === undefined)
  ) {
    throw new CliInputError(
      "cli-usage-error",
      "Company search employee bounds must be supplied together."
    );
  }
  const employeeMinimum =
    employeeMinimumValue === undefined
      ? undefined
      : parseBoundedInteger(
          employeeMinimumValue,
          0,
          1_000_000_000,
          "Company search --employee-minimum is invalid."
        );
  const employeeMaximum =
    employeeMaximumValue === undefined
      ? undefined
      : parseBoundedInteger(
          employeeMaximumValue,
          1,
          1_000_000_000,
          "Company search --employee-maximum is invalid."
        );
  if (
    employeeMinimum !== undefined &&
    employeeMaximum !== undefined &&
    employeeMinimum > employeeMaximum
  ) {
    throw new CliInputError(
      "cli-usage-error",
      "Company search employee minimum cannot exceed its maximum."
    );
  }
  return {
    ...commonArguments(values, environment),
    authorityEnvelopeId,
    budgetLimit: parsePositiveAmount(
      values.get("--budget-limit"),
      "Company search --budget-limit must be a positive finite amount."
    ),
    budgetUnit,
    command: "organizations.discover",
    countries,
    datasetId,
    datasetName,
    deadlineMs: parseBoundedInteger(
      values.get("--deadline-ms"),
      0,
      Number.MAX_SAFE_INTEGER,
      "Company search --deadline-ms is invalid."
    ),
    discoveryId,
    ...(employeeMaximum === undefined ? {} : { employeeMaximum }),
    ...(employeeMinimum === undefined ? {} : { employeeMinimum }),
    industries,
    ...(repeated.get("--keyword") === undefined
      ? {}
      : { keywords: repeated.get("--keyword") }),
    maxCalls: parseBoundedInteger(
      values.get("--max-calls"),
      1,
      10_000,
      "Company search --max-calls is invalid."
    ),
    maxCompanies: parseBoundedInteger(
      values.get("--max-companies"),
      1,
      1_000_000,
      "Company search --max-companies is invalid."
    ),
    maxPages: parseBoundedInteger(
      values.get("--max-pages"),
      1,
      10_000,
      "Company search --max-pages is invalid."
    ),
    mode,
  };
};

const parseCompanyResultsArguments = (
  argv: readonly string[],
  environment: Readonly<Record<string, string | undefined>>
): CompanyResultsArguments => {
  const { values } = parseFlagValues(
    argv,
    new Set([
      "--after-ordinal",
      "--api-key-file",
      "--endpoint",
      "--generation-id",
      "--limit",
    ]),
    "Company results arguments are invalid."
  );
  const generationId = values.get("--generation-id");
  if (generationId === undefined || generationId.length === 0) {
    throw new CliInputError(
      "cli-usage-error",
      "Company results requires --generation-id."
    );
  }
  return {
    ...commonArguments(values, environment),
    afterOrdinal: parseBoundedInteger(
      values.get("--after-ordinal") ?? "0",
      0,
      Number.MAX_SAFE_INTEGER,
      "Company results --after-ordinal is invalid."
    ),
    command: "organizations.candidates.list",
    generationId,
    limit: parseBoundedInteger(
      values.get("--limit") ?? "100",
      1,
      100,
      "Company results --limit is invalid."
    ),
  };
};

const parseContactResultsArguments = (
  argv: readonly string[],
  environment: Readonly<Record<string, string | undefined>>
): ContactResultsArguments => {
  const { values } = parseFlagValues(
    argv,
    new Set([
      "--after-ordinal",
      "--api-key-file",
      "--endpoint",
      "--generation-id",
      "--limit",
    ]),
    "Contact results arguments are invalid."
  );
  const generationId = values.get("--generation-id");
  if (generationId === undefined || generationId.length === 0) {
    throw new CliInputError(
      "cli-usage-error",
      "Contact results requires --generation-id."
    );
  }
  return {
    ...commonArguments(values, environment),
    afterOrdinal: parseBoundedInteger(
      values.get("--after-ordinal") ?? "0",
      0,
      Number.MAX_SAFE_INTEGER,
      "Contact results --after-ordinal is invalid."
    ),
    command: "contacts.candidates.list",
    generationId,
    limit: parseBoundedInteger(
      values.get("--limit") ?? "100",
      1,
      100,
      "Contact results --limit is invalid."
    ),
  };
};

const parseCompanyWatchArguments = (
  argv: readonly string[],
  environment: Readonly<Record<string, string | undefined>>
): CompanyWatchArguments => {
  const { values } = parseFlagValues(
    argv,
    new Set([
      "--api-key-file",
      "--endpoint",
      "--generation-id",
      "--poll-interval-ms",
      "--timeout-ms",
    ]),
    "Company watch arguments are invalid."
  );
  const generationId = values.get("--generation-id");
  if (generationId === undefined || generationId.length === 0) {
    throw new CliInputError(
      "cli-usage-error",
      "Company watch requires --generation-id and --timeout-ms."
    );
  }
  const pollIntervalValue = values.get("--poll-interval-ms");
  return {
    ...commonArguments(values, environment),
    command: "dataset-generations.get",
    generationId,
    pollIntervalMs:
      pollIntervalValue === undefined
        ? DEFAULT_WATCH_POLL_INTERVAL_MS
        : parseBoundedInteger(
            pollIntervalValue,
            MIN_WATCH_POLL_INTERVAL_MS,
            MAX_WATCH_POLL_INTERVAL_MS,
            "Company watch --poll-interval-ms is invalid."
          ),
    timeoutMs: parseBoundedInteger(
      values.get("--timeout-ms"),
      0,
      MAX_WATCH_TIMEOUT_MS,
      "Company watch --timeout-ms is invalid."
    ),
  };
};

const parseCompanyCancelArguments = (
  argv: readonly string[],
  environment: Readonly<Record<string, string | undefined>>
): CompanyCancelArguments => {
  const { values } = parseFlagValues(
    argv,
    new Set([
      "--api-key-file",
      "--endpoint",
      "--generation-id",
      "--idempotency-key",
    ]),
    "Company cancel arguments are invalid."
  );
  const generationId = values.get("--generation-id");
  const idempotencyKey = values.get("--idempotency-key");
  if (
    generationId === undefined ||
    generationId.length === 0 ||
    idempotencyKey === undefined ||
    idempotencyKey.length === 0
  ) {
    throw new CliInputError(
      "cli-usage-error",
      "Company cancel requires --generation-id and --idempotency-key."
    );
  }
  return {
    ...commonArguments(values, environment),
    command: "dataset-generations.cancel",
    generationId,
    idempotencyKey,
  };
};

const parseRecipeExportArguments = (
  argv: readonly string[],
  environment: Readonly<Record<string, string | undefined>>
): RecipeExportArguments => {
  const { repeated, values } = parseFlagValues(
    argv,
    new Set([
      "--api-key-file",
      "--application-id",
      "--endpoint",
      "--field-id",
      "--format",
      "--max-bytes",
      "--output",
      "--timeout-ms",
    ]),
    "Recipe export arguments are invalid.",
    new Set(["--field-id"])
  );
  const applicationId = values.get("--application-id");
  const format = values.get("--format");
  const outputFile = values.get("--output");
  if (
    applicationId === undefined ||
    applicationId.length === 0 ||
    (format !== "csv" && format !== "jsonl") ||
    outputFile === undefined ||
    outputFile.length === 0 ||
    outputFile === "-"
  ) {
    throw new CliInputError(
      "cli-usage-error",
      "Recipe export requires --application-id, --format csv|jsonl, --output PATH, and --timeout-ms."
    );
  }
  const timeoutMs = parseBoundedInteger(
    values.get("--timeout-ms"),
    1,
    MAX_EXPORT_TIMEOUT_MS,
    "Recipe export --timeout-ms must be an integer from 1 to 86400000."
  );
  const maximumValue = values.get("--max-bytes");
  const maxBytes =
    maximumValue === undefined
      ? DEFAULT_EXPORT_MAX_BYTES
      : parseBoundedInteger(
          maximumValue,
          1,
          MAX_EXPORT_BYTES,
          "Recipe export --max-bytes must be an integer from 1 to 1099511627776."
        );
  const fieldIds = repeated.get("--field-id");
  if (fieldIds?.some((fieldId) => fieldId.length === 0)) {
    throw new CliInputError(
      "cli-usage-error",
      "Recipe export arguments are invalid."
    );
  }
  return {
    ...commonArguments(values, environment),
    applicationId,
    command: "recipe-applications.export",
    ...(fieldIds === undefined ? {} : { fieldIds }),
    format,
    maxBytes,
    outputFile,
    timeoutMs,
  };
};

const parseDatasetExportArguments = (
  argv: readonly string[],
  environment: Readonly<Record<string, string | undefined>>
): DatasetExportArguments => {
  const { repeated, values } = parseFlagValues(
    argv,
    new Set([
      "--api-key-file",
      "--dataset-id",
      "--endpoint",
      "--field-id",
      "--format",
      "--max-bytes",
      "--output",
      "--receipt",
      "--timeout-ms",
    ]),
    "Dataset export arguments are invalid.",
    new Set(["--field-id"])
  );
  const datasetId = values.get("--dataset-id");
  const format = values.get("--format");
  const outputFile = values.get("--output");
  const receiptFile = values.get("--receipt");
  if (
    datasetId === undefined ||
    datasetId.length === 0 ||
    (format !== "csv" && format !== "jsonl") ||
    outputFile === "" ||
    receiptFile === ""
  ) {
    throw new CliInputError(
      "cli-usage-error",
      "Dataset export requires --dataset-id and --format csv|jsonl."
    );
  }
  if (outputFile === "-") {
    throw new CliInputError(
      "cli-usage-error",
      "Dataset export writes to stdout by default; --output requires a file path."
    );
  }
  if (
    receiptFile === "-" ||
    (outputFile !== undefined && receiptFile === outputFile)
  ) {
    throw new CliInputError(
      "cli-usage-error",
      "Dataset export --receipt requires a distinct file path."
    );
  }
  const timeoutValue = values.get("--timeout-ms");
  const timeoutMs =
    timeoutValue === undefined
      ? DEFAULT_EXPORT_TIMEOUT_MS
      : parseBoundedInteger(
          timeoutValue,
          1,
          MAX_EXPORT_TIMEOUT_MS,
          "Dataset export --timeout-ms must be an integer from 1 to 86400000."
        );
  const maximumValue = values.get("--max-bytes");
  const maxBytes =
    maximumValue === undefined
      ? DEFAULT_EXPORT_MAX_BYTES
      : parseBoundedInteger(
          maximumValue,
          1,
          MAX_EXPORT_BYTES,
          "Dataset export --max-bytes must be an integer from 1 to 1099511627776."
        );
  const fieldIds = repeated.get("--field-id");
  if (fieldIds?.some((fieldId) => fieldId.length === 0)) {
    throw new CliInputError(
      "cli-usage-error",
      "Dataset export arguments are invalid."
    );
  }
  return {
    ...commonArguments(values, environment),
    command: "datasets.export",
    datasetId,
    ...(fieldIds === undefined ? {} : { fieldIds }),
    format,
    maxBytes,
    ...(outputFile === undefined ? {} : { outputFile }),
    ...(receiptFile === undefined ? {} : { receiptFile }),
    timeoutMs,
  };
};

const parseExportDeliveryArguments = (
  argv: readonly string[],
  environment: Readonly<Record<string, string | undefined>>,
  command: ExportDeliveryArguments["command"]
): ExportDeliveryArguments => {
  const { values } = parseFlagValues(
    argv,
    new Set(["--api-key-file", "--delivery-id", "--endpoint"]),
    "Export delivery arguments are invalid."
  );
  const deliveryId = values.get("--delivery-id");
  if (deliveryId === undefined || deliveryId.length === 0) {
    throw new CliInputError(
      "cli-usage-error",
      "Export delivery status and revocation require --delivery-id."
    );
  }
  return {
    ...commonArguments(values, environment),
    command,
    deliveryId,
  };
};

const CONTACT_PRIVACY_REASONS = new Set<
  ContactPrivacyRestrictionRequest["reason"]
>([
  "operator-subject-request",
  "provider-claimed-email",
  "provider-deletion",
  "provider-opt-out",
]);

const parseContactPrivacyRestrictArguments = (
  argv: readonly string[],
  environment: Readonly<Record<string, string | undefined>>
): ContactPrivacyRestrictArguments => {
  const { values } = parseFlagValues(
    argv,
    new Set([
      "--api-key-file",
      "--endpoint",
      "--idempotency-key",
      "--kind",
      "--provider-key",
      "--reason",
      "--value-file",
    ]),
    "Contact restriction arguments are invalid."
  );
  const idempotencyKey = values.get("--idempotency-key");
  const kind = values.get("--kind");
  const providerKey = values.get("--provider-key");
  const reason = values.get("--reason");
  const valueFile = values.get("--value-file");
  if (
    idempotencyKey === undefined ||
    idempotencyKey.length === 0 ||
    (kind !== "email" && kind !== "provider-subject") ||
    reason === undefined ||
    !CONTACT_PRIVACY_REASONS.has(
      reason as ContactPrivacyRestrictionRequest["reason"]
    ) ||
    valueFile === undefined ||
    valueFile.length === 0 ||
    (kind === "email" && providerKey !== undefined) ||
    (kind === "provider-subject" &&
      (providerKey === undefined || providerKey.length === 0))
  ) {
    throw new CliInputError(
      "cli-usage-error",
      "Contact restrict requires --kind email|provider-subject, --value-file PATH|-, --reason and --idempotency-key; --provider-key is required only for provider-subject."
    );
  }
  const common = {
    ...commonArguments(values, environment),
    command: "contact-privacy.restrict" as const,
    idempotencyKey,
    reason: reason as ContactPrivacyRestrictionRequest["reason"],
    valueFile,
  };
  return kind === "email"
    ? { ...common, kind }
    : { ...common, kind, providerKey: providerKey as string };
};

const parseRecipeWatchArguments = (
  argv: readonly string[],
  environment: Readonly<Record<string, string | undefined>>
): RecipeWatchArguments => {
  const { values } = parseFlagValues(
    argv,
    new Set([
      "--api-key-file",
      "--application-id",
      "--endpoint",
      "--poll-interval-ms",
      "--timeout-ms",
    ]),
    "Recipe watch arguments are invalid."
  );
  const applicationId = values.get("--application-id");
  if (applicationId === undefined || applicationId.length === 0) {
    throw new CliInputError(
      "cli-usage-error",
      "Recipe watch requires --application-id and --timeout-ms."
    );
  }
  const timeoutMs = parseBoundedInteger(
    values.get("--timeout-ms"),
    0,
    MAX_WATCH_TIMEOUT_MS,
    "Recipe watch --timeout-ms must be an integer from 0 to 86400000."
  );
  const pollIntervalValue = values.get("--poll-interval-ms");
  const pollIntervalMs =
    pollIntervalValue === undefined
      ? DEFAULT_WATCH_POLL_INTERVAL_MS
      : parseBoundedInteger(
          pollIntervalValue,
          MIN_WATCH_POLL_INTERVAL_MS,
          MAX_WATCH_POLL_INTERVAL_MS,
          "Recipe watch --poll-interval-ms must be an integer from 100 to 60000."
        );
  return {
    ...commonArguments(values, environment),
    applicationId,
    command: "recipe-applications.get",
    pollIntervalMs,
    timeoutMs,
  };
};

const parseRunCancelArguments = (
  argv: readonly string[],
  environment: Readonly<Record<string, string | undefined>>
): RunCancelArguments => {
  const { values } = parseFlagValues(
    argv,
    new Set(["--api-key-file", "--endpoint", "--idempotency-key", "--run-id"]),
    "Run cancel arguments are invalid."
  );
  const idempotencyKey = values.get("--idempotency-key");
  const runId = values.get("--run-id");
  if (
    idempotencyKey === undefined ||
    idempotencyKey.length === 0 ||
    runId === undefined ||
    runId.length === 0
  ) {
    throw new CliInputError(
      "cli-usage-error",
      "Run cancel requires --run-id and --idempotency-key."
    );
  }
  return {
    ...commonArguments(values, environment),
    command: "runs.cancel",
    idempotencyKey,
    runId,
  };
};

const GTM_PROFILES = new Set<GtmQuestionnaireInput["profile"]>([
  "offline_fixture",
  "dataset_import",
  "imported_dataset_enrichment",
  "agentic_outbound_play",
]);

const parseGtmProfileArguments = (
  argv: readonly string[],
  environment: Readonly<Record<string, string | undefined>>,
  command: "gtm-contexts.questionnaire.get" | "gtm-contexts.status.get"
): AgentSurfaceArguments => {
  const { values } = parseFlagValues(
    argv,
    new Set(["--api-key-file", "--endpoint", "--profile"]),
    "Context profile arguments are invalid."
  );
  const profile = values.get("--profile");
  if (
    profile === undefined ||
    !GTM_PROFILES.has(profile as GtmQuestionnaireInput["profile"])
  ) {
    throw new CliInputError(
      "cli-usage-error",
      "Context command requires a canonical --profile."
    );
  }
  return {
    ...commonArguments(values, environment),
    command,
    profile: profile as GtmQuestionnaireInput["profile"],
  };
};

const parseAgentFileArguments = (
  argv: readonly string[],
  environment: Readonly<Record<string, string | undefined>>,
  command:
    | "gtm-contexts.apply"
    | "gtm-contexts.plan"
    | "plays.apply"
    | "plays.preview"
    | "workbooks.get"
    | "workbooks.update"
): AgentSurfaceArguments => {
  const { values } = parseFlagValues(
    argv,
    new Set(["--api-key-file", "--endpoint", "--request"]),
    "Agent command arguments are invalid."
  );
  const requestFile = values.get("--request");
  if (requestFile === undefined || requestFile.length === 0) {
    throw new CliInputError(
      "cli-usage-error",
      "Agent command requires --request <json-file>."
    );
  }
  return {
    ...commonArguments(values, environment),
    command,
    requestFile,
  };
};

const parsePlayRunArguments = (
  argv: readonly string[],
  environment: Readonly<Record<string, string | undefined>>
): AgentSurfaceArguments => {
  const { values } = parseFlagValues(
    argv,
    new Set([
      "--api-key-file",
      "--endpoint",
      "--poll-interval-ms",
      "--run-id",
      "--timeout-ms",
    ]),
    "Play run arguments are invalid."
  );
  const runId = values.get("--run-id");
  if (runId === undefined || runId.length === 0) {
    throw new CliInputError("cli-usage-error", "Play run requires --run-id.");
  }
  return {
    ...commonArguments(values, environment),
    command: "play-runs.get",
    pollIntervalMs: parseBoundedInteger(
      values.get("--poll-interval-ms") ??
        String(DEFAULT_WATCH_POLL_INTERVAL_MS),
      MIN_WATCH_POLL_INTERVAL_MS,
      MAX_WATCH_POLL_INTERVAL_MS,
      "Play run --poll-interval-ms must be an integer from 100 to 60000."
    ),
    runId,
    timeoutMs: parseBoundedInteger(
      values.get("--timeout-ms") ?? "0",
      0,
      MAX_WATCH_TIMEOUT_MS,
      "Play run --timeout-ms must be an integer from 0 to 86400000."
    ),
  };
};

const parseArguments = (
  argv: readonly string[],
  environment: Readonly<Record<string, string | undefined>>
): CliArguments => {
  switch (`${argv[0]}:${argv[1]}`) {
    case "context:questions":
      return parseGtmProfileArguments(
        argv,
        environment,
        "gtm-contexts.questionnaire.get"
      );
    case "context:inspect":
    case "context:status":
      return parseGtmProfileArguments(
        argv,
        environment,
        "gtm-contexts.status.get"
      );
    case "context:validate":
    case "context:plan":
      return parseAgentFileArguments(argv, environment, "gtm-contexts.plan");
    case "context:apply":
      return parseAgentFileArguments(argv, environment, "gtm-contexts.apply");
    case "play:validate":
    case "play:preview":
      return parseAgentFileArguments(argv, environment, "plays.preview");
    case "play:apply":
    case "play:start":
    case "play:pause":
    case "play:retire":
      return parseAgentFileArguments(argv, environment, "plays.apply");
    case "play:run":
      return parsePlayRunArguments(argv, environment);
    case "workbook:get":
    case "workbook:inspect":
      return parseAgentFileArguments(argv, environment, "workbooks.get");
    case "workbook:update":
    case "workbook:select":
    case "workbook:approve":
    case "workbook:reject":
      return parseAgentFileArguments(argv, environment, "workbooks.update");
    case "contact:search":
      return parseContactSearchArguments(argv, environment);
    case "contact:results":
      return parseContactResultsArguments(argv, environment);
    case "contact:reveal-identity":
      return parseContactDerivationArguments(
        argv,
        environment,
        "contacts.identity.reveal"
      );
    case "contact:enrich-email":
      return parseContactDerivationArguments(
        argv,
        environment,
        "contacts.work-email.resolve"
      );
    case "contact:verify-email":
      return parseContactDerivationArguments(
        argv,
        environment,
        "contacts.work-email.verify"
      );
    case "contact:restrict":
      return parseContactPrivacyRestrictArguments(argv, environment);
    case "company:search":
      return parseCompanySearchArguments(argv, environment);
    case "company:results":
      return parseCompanyResultsArguments(argv, environment);
    case "company:cancel":
      return parseCompanyCancelArguments(argv, environment);
    case "company:watch":
      return parseCompanyWatchArguments(argv, environment);
    case "dataset:import":
      return parseDatasetImportArguments(argv, environment);
    case "dataset:export":
      return parseDatasetExportArguments(argv, environment);
    case "dataset:export-status":
      return parseExportDeliveryArguments(
        argv,
        environment,
        "export-deliveries.get"
      );
    case "dataset:export-revoke":
      return parseExportDeliveryArguments(
        argv,
        environment,
        "export-deliveries.revoke"
      );
    case "recipe:apply":
      return parseRecipeApplyArguments(argv, environment);
    case "recipe:export":
      return parseRecipeExportArguments(argv, environment);
    case "recipe:watch":
      return parseRecipeWatchArguments(argv, environment);
    case "run:cancel":
      return parseRunCancelArguments(argv, environment);
    default:
      throw new CliInputError(
        "cli-usage-error",
        "Expected a generated command such as context questions, play preview, workbook inspect, workbook select, workbook approve, workbook reject, contact reveal-identity, contact enrich-email, company search, dataset import, recipe apply, or run cancel."
      );
  }
};

const readBoundedFile = async (
  path: string,
  maximumBytes: number,
  label: string
): Promise<Uint8Array> => {
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(path, constants.O_RDONLY + constants.O_NOFOLLOW);
  } catch {
    throw new CliInputError("cli-input-invalid", `${label} is unavailable.`);
  }
  try {
    const details = await handle.stat();
    if (!details.isFile() || details.size > maximumBytes) {
      throw new CliInputError(
        "cli-input-invalid",
        `${label} must be a bounded regular file.`
      );
    }
    const bytes = await handle.readFile();
    if (bytes.byteLength > maximumBytes) {
      throw new CliInputError(
        "cli-input-invalid",
        `${label} must be a bounded regular file.`
      );
    }
    return bytes;
  } catch (error) {
    if (error instanceof CliInputError) {
      throw error;
    }
    throw new CliInputError("cli-input-invalid", `${label} is unreadable.`);
  } finally {
    await handle.close().catch(() => undefined);
  }
};

const readBoundedStream = async (
  stream: ReadableSource,
  maximumBytes: number,
  label: string
): Promise<Uint8Array> => {
  const chunks: Uint8Array[] = [];
  let byteCount = 0;
  try {
    for await (const chunk of stream) {
      let bytes: Uint8Array | undefined;
      if (typeof chunk === "string") {
        bytes = new TextEncoder().encode(chunk);
      } else if (chunk instanceof Uint8Array) {
        bytes = chunk;
      }
      if (bytes === undefined) {
        throw new CliInputError(
          "cli-input-invalid",
          `${label} yielded invalid bytes.`
        );
      }
      byteCount += bytes.byteLength;
      if (byteCount > maximumBytes) {
        throw new CliInputError(
          "cli-input-invalid",
          `${label} must be bounded.`
        );
      }
      chunks.push(bytes);
    }
  } catch (error) {
    if (error instanceof CliInputError) {
      throw error;
    }
    throw new CliInputError("cli-input-invalid", `${label} is unreadable.`);
  }
  const result = new Uint8Array(byteCount);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
};

const readContactPrivacySubject = async (
  valueFile: string,
  stdin: ReadableSource
): Promise<string> => {
  const bytes =
    valueFile === "-"
      ? await readBoundedStream(
          stdin,
          MAX_CONTACT_PRIVACY_SUBJECT_FILE_BYTES,
          "Contact restriction value input"
        )
      : await readBoundedFile(
          valueFile,
          MAX_CONTACT_PRIVACY_SUBJECT_FILE_BYTES,
          "Contact restriction value file"
        );
  let value: string;
  try {
    value = new TextDecoder("utf-8", { fatal: true })
      .decode(bytes)
      .replace(TRAILING_NEWLINE_PATTERN, "");
  } catch {
    throw new CliInputError(
      "cli-input-invalid",
      "Contact restriction value input must contain bounded UTF-8."
    );
  }
  if (value.length === 0) {
    throw new CliInputError(
      "cli-input-invalid",
      "Contact restriction value input is empty."
    );
  }
  return value;
};

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const hasString = (
  value: Readonly<Record<string, unknown>>,
  key: string
): boolean => typeof value[key] === "string";

const isDataset = (value: unknown): boolean =>
  isRecord(value) &&
  hasString(value, "dataset_id") &&
  hasString(value, "name") &&
  hasString(value, "workspace_id");

const isField = (value: unknown): boolean =>
  isRecord(value) &&
  hasString(value, "dataset_id") &&
  hasString(value, "field_id") &&
  hasString(value, "key") &&
  hasString(value, "label") &&
  ["boolean", "number", "string"].includes(String(value.value_type)) &&
  hasString(value, "workspace_id");

const isPositiveSafeInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0;

const isDatasetImportMetadata = (
  value: unknown
): value is DatasetImportMetadata => {
  if (!(isRecord(value) && isRecord(value.batch_limits))) {
    return false;
  }
  return (
    hasString(value, "import_id") &&
    isDataset(value.dataset) &&
    Array.isArray(value.fields) &&
    value.fields.length > 0 &&
    value.fields.length <= 256 &&
    value.fields.every(isField) &&
    (value.format === "csv" || value.format === "jsonl") &&
    typeof value.source_content_hash === "string" &&
    SHA256_PATTERN.test(value.source_content_hash) &&
    isPositiveSafeInteger(value.max_record_bytes) &&
    value.max_record_bytes <= 16_777_216 &&
    isPositiveSafeInteger(value.batch_limits.max_bytes) &&
    value.batch_limits.max_bytes >= 1024 &&
    value.batch_limits.max_bytes <= 67_108_864 &&
    value.batch_limits.max_bytes >= value.max_record_bytes &&
    isPositiveSafeInteger(value.batch_limits.max_items) &&
    value.batch_limits.max_items <= 1000
  );
};

const readMetadata = async (path: string): Promise<DatasetImportMetadata> => {
  const bytes = await readBoundedFile(
    path,
    MAX_METADATA_FILE_BYTES,
    "Metadata file"
  );
  let candidate: unknown;
  try {
    candidate = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes)
    );
  } catch {
    throw new CliInputError(
      "cli-input-invalid",
      "Metadata file must contain UTF-8 JSON."
    );
  }
  if (!isDatasetImportMetadata(candidate)) {
    throw new CliInputError(
      "cli-input-invalid",
      "Metadata file does not match the dataset import shape."
    );
  }
  return candidate;
};

const readRecipeRequest = async (path: string): Promise<RecipeApplyRequest> => {
  const bytes = await readBoundedFile(
    path,
    MAX_RECIPE_REQUEST_FILE_BYTES,
    "Recipe request file"
  );
  let candidate: unknown;
  try {
    candidate = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes)
    ) as unknown;
  } catch {
    throw new CliInputError(
      "cli-input-invalid",
      "Recipe request file must contain UTF-8 JSON."
    );
  }
  try {
    return parseRecipeApplyRequest(candidate);
  } catch (error) {
    if (
      error instanceof KurobaraTransportError &&
      error.kind === "invalid-input"
    ) {
      throw new CliInputError(
        "cli-input-invalid",
        "Recipe request file does not match the recipe apply shape."
      );
    }
    throw error;
  }
};

const readAgentRequest = async (path: string): Promise<unknown> => {
  const bytes = await readBoundedFile(
    path,
    MAX_RECIPE_REQUEST_FILE_BYTES,
    "Agent request file"
  );
  try {
    return JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes)
    ) as unknown;
  } catch {
    throw new CliInputError(
      "cli-input-invalid",
      "Agent request file must contain bounded UTF-8 JSON."
    );
  }
};

const readApiKey = async (
  apiKeyFile: string | undefined,
  environment: Readonly<Record<string, string | undefined>>
): Promise<string> => {
  const environmentKey = environment.KUROBARA_API_KEY;
  if (apiKeyFile !== undefined && environmentKey !== undefined) {
    throw new CliInputError(
      "cli-config-invalid",
      "Configure one API key source only."
    );
  }
  if (apiKeyFile === undefined) {
    if (environmentKey === undefined || environmentKey.length === 0) {
      throw new CliInputError(
        "cli-config-invalid",
        "KUROBARA_API_KEY or --api-key-file is required."
      );
    }
    return environmentKey;
  }
  const bytes = await readBoundedFile(
    apiKeyFile,
    MAX_API_KEY_FILE_BYTES,
    "API key file"
  );
  let value: string;
  try {
    value = new TextDecoder("utf-8", { fatal: true })
      .decode(bytes)
      .replace(TRAILING_NEWLINE_PATTERN, "");
  } catch {
    throw new CliInputError(
      "cli-config-invalid",
      "API key file content is invalid."
    );
  }
  if (value.length === 0 || WHITESPACE_PATTERN.test(value)) {
    throw new CliInputError(
      "cli-config-invalid",
      "API key file content is invalid."
    );
  }
  return value;
};

const chunksFrom = async function* (
  stream: ReadableSource
): AsyncGenerator<Uint8Array> {
  for await (const chunk of stream) {
    if (chunk instanceof Uint8Array) {
      yield chunk;
    } else if (typeof chunk === "string") {
      yield new TextEncoder().encode(chunk);
    } else {
      throw new CliInputError(
        "cli-input-invalid",
        "Dataset source yielded an invalid chunk."
      );
    }
  }
};

const openSource = async (
  path: string,
  stdin: ReadableSource
): Promise<DatasetImportSource> => {
  if (path === "-") {
    return chunksFrom(stdin);
  }
  let details: Awaited<ReturnType<typeof lstat>>;
  try {
    details = await lstat(path);
  } catch {
    throw new CliInputError(
      "cli-input-invalid",
      "Dataset source is unavailable."
    );
  }
  if (!details.isFile() || details.isSymbolicLink()) {
    throw new CliInputError(
      "cli-input-invalid",
      "Dataset source must be a regular file or stdin."
    );
  }
  return {
    async *[Symbol.asyncIterator]() {
      yield* chunksFrom(createReadStream(path));
    },
  };
};

const problemExitCode = (
  command: CliArguments["command"],
  code: string
): number => {
  const metadata = (() => {
    switch (command) {
      case "gtm-contexts.questionnaire.get":
        return GTM_QUESTIONS_COMMAND;
      case "gtm-contexts.plan":
        return GTM_CONTEXT_PLAN_COMMAND;
      case "gtm-contexts.apply":
        return GTM_CONTEXT_APPLY_COMMAND;
      case "gtm-contexts.status.get":
        return GTM_CONTEXT_STATUS_COMMAND;
      case "plays.preview":
        return PLAY_PREVIEW_COMMAND;
      case "plays.apply":
        return PLAY_APPLY_COMMAND;
      case "play-runs.get":
        return PLAY_RUN_COMMAND;
      case "workbooks.get":
        return WORKBOOK_GET_COMMAND;
      case "workbooks.update":
        return WORKBOOK_UPDATE_COMMAND;
      case "contact-privacy.restrict":
        return CONTACT_PRIVACY_RESTRICT_COMMAND;
      case "contacts.discover":
        return CONTACT_DISCOVER_COMMAND;
      case "contacts.candidates.list":
        return CONTACT_CANDIDATES_LIST_COMMAND;
      case "contacts.identity.reveal":
        return CONTACT_IDENTITY_REVEAL_COMMAND;
      case "contacts.work-email.resolve":
        return CONTACT_WORK_EMAIL_RESOLVE_COMMAND;
      case "contacts.work-email.verify":
        return CONTACT_WORK_EMAIL_VERIFY_COMMAND;
      case "organizations.candidates.list":
        return ORGANIZATION_CANDIDATES_LIST_COMMAND;
      case "organizations.discover":
        return ORGANIZATION_DISCOVER_COMMAND;
      case "dataset-generations.get":
        return DATASET_GENERATION_WATCH_COMMAND;
      case "dataset-generations.cancel":
        return DATASET_GENERATION_CANCEL_COMMAND;
      case "datasets.import":
        return DATASET_IMPORT_COMMAND;
      case "datasets.export":
        return DATASET_EXPORT_COMMAND;
      case "export-deliveries.get":
        return EXPORT_DELIVERY_GET_COMMAND;
      case "export-deliveries.revoke":
        return EXPORT_DELIVERY_REVOKE_COMMAND;
      case "recipes.apply":
        return RECIPE_APPLY_COMMAND;
      case "recipe-applications.export":
        return RECIPE_EXPORT_COMMAND;
      case "recipe-applications.get":
        return RECIPE_WATCH_COMMAND;
      case "runs.cancel":
        return RUN_CANCEL_COMMAND;
      default:
        throw new Error("Unsupported generated CLI command.");
    }
  })();
  return (
    metadata.problems.find((problem) => problem.code === code)?.exit_code ?? 70
  );
};

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Each generated command family keeps one stable, human-readable input error title.
const invalidInputTitle = (command: CliArguments["command"]): string => {
  if (command.startsWith("gtm-contexts.")) {
    return "GTM Context input is invalid.";
  }
  if (command.startsWith("plays.") || command === "play-runs.get") {
    return "Play input is invalid.";
  }
  if (command.startsWith("workbooks.")) {
    return "Workbook input is invalid.";
  }
  if (command === "contact-privacy.restrict") {
    return "Contact restriction input is invalid.";
  }
  if (command === "contacts.discover") {
    return "Contact search input is invalid.";
  }
  if (command === "contacts.candidates.list") {
    return "Contact results input is invalid.";
  }
  if (command === "contacts.identity.reveal") {
    return "Contact identity reveal input is invalid.";
  }
  if (
    command === "contacts.work-email.resolve" ||
    command === "contacts.work-email.verify"
  ) {
    return "Contact work-email input is invalid.";
  }
  if (command === "organizations.discover") {
    return "Company search input is invalid.";
  }
  if (command === "organizations.candidates.list") {
    return "Company results input is invalid.";
  }
  if (command === "datasets.export") {
    return "Dataset export input is invalid.";
  }
  if (
    command === "export-deliveries.get" ||
    command === "export-deliveries.revoke"
  ) {
    return "Export delivery input is invalid.";
  }
  if (command === "dataset-generations.get") {
    return "Company watch input is invalid.";
  }
  if (command === "dataset-generations.cancel") {
    return "Company cancel input is invalid.";
  }
  if (command === "datasets.import") {
    return "Dataset import input is invalid.";
  }
  if (command === "recipes.apply") {
    return "Recipe apply input is invalid.";
  }
  if (command === "recipe-applications.export") {
    return "Recipe export input is invalid.";
  }
  return command === "recipe-applications.get"
    ? "Recipe watch input is invalid."
    : "Run cancel input is invalid.";
};

const waitFor = (milliseconds: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(
        new CliWatchError(
          "cli-watch-aborted",
          "Recipe application watch was aborted."
        )
      );
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(
        new CliWatchError(
          "cli-watch-aborted",
          "Recipe application watch was aborted."
        )
      );
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    signal?.addEventListener("abort", onAbort, { once: true });
  });

type WatchRuntime = Readonly<{
  now: () => number;
  signal?: AbortSignal;
  wait: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
}>;

type WatchDeadline = Readonly<{
  dispose: () => void;
  elapsed: () => boolean;
  signal: AbortSignal;
}>;

const createWatchDeadline = (
  timeoutMs: number,
  callerSignal?: AbortSignal
): WatchDeadline => {
  const controller = new AbortController();
  let deadlineElapsed = false;
  const abortFromCaller = (): void => controller.abort();
  if (callerSignal?.aborted) {
    controller.abort();
  } else {
    callerSignal?.addEventListener("abort", abortFromCaller, { once: true });
  }
  const timer =
    timeoutMs === 0
      ? undefined
      : setTimeout(() => {
          deadlineElapsed = true;
          controller.abort();
        }, timeoutMs);
  return {
    dispose: () => {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      callerSignal?.removeEventListener("abort", abortFromCaller);
    },
    elapsed: () => deadlineElapsed,
    signal: controller.signal,
  };
};

const abortedWatch = (): CliWatchError =>
  new CliWatchError(
    "cli-watch-aborted",
    "Recipe application watch was aborted."
  );

const timedOutWatch = (): CliWatchError =>
  new CliWatchError("cli-watch-timeout", "Recipe application watch timed out.");

const getWatchSnapshot = async (
  parsed: RecipeWatchArguments,
  client: ReturnType<typeof createKurobaraClient>,
  signal?: AbortSignal
): Promise<RecipeApplicationGetResponse> => {
  if (signal?.aborted) {
    throw abortedWatch();
  }
  try {
    return await client.recipeApplications.get(
      { application_id: parsed.applicationId },
      signal === undefined ? {} : { signal }
    );
  } catch (error) {
    if (signal?.aborted) {
      throw abortedWatch();
    }
    throw error;
  }
};

const watchRecipeApplication = async (
  parsed: RecipeWatchArguments,
  client: ReturnType<typeof createKurobaraClient>,
  runtime: WatchRuntime
): Promise<RecipeApplicationGetResponse> => {
  const deadline = createWatchDeadline(parsed.timeoutMs, runtime.signal);
  const startedAt = runtime.now();
  try {
    let snapshot = await getWatchSnapshot(parsed, client, deadline.signal);
    if (
      parsed.timeoutMs === 0 ||
      snapshot.terminal ||
      snapshot.state === "needs_replay"
    ) {
      return snapshot;
    }

    while (true) {
      const remainingMs = parsed.timeoutMs - (runtime.now() - startedAt);
      if (remainingMs <= 0) {
        throw timedOutWatch();
      }
      await runtime.wait(
        Math.min(parsed.pollIntervalMs, remainingMs),
        deadline.signal
      );
      if (runtime.signal?.aborted) {
        throw abortedWatch();
      }
      if (runtime.now() - startedAt >= parsed.timeoutMs) {
        throw timedOutWatch();
      }
      snapshot = await getWatchSnapshot(parsed, client, deadline.signal);
      if (snapshot.terminal || snapshot.state === "needs_replay") {
        return snapshot;
      }
    }
  } catch (error) {
    if (deadline.elapsed()) {
      throw timedOutWatch();
    }
    if (runtime.signal?.aborted) {
      throw abortedWatch();
    }
    throw error;
  } finally {
    deadline.dispose();
  }
};

const getGenerationWatchSnapshot = async (
  parsed: CompanyWatchArguments,
  client: ReturnType<typeof createKurobaraClient>,
  signal?: AbortSignal
): Promise<DatasetGenerationGetResponse> => {
  if (signal?.aborted) {
    throw new CliWatchError("cli-watch-aborted", "Company watch was aborted.");
  }
  try {
    return await client.datasetGenerations.get(
      { generation_id: parsed.generationId },
      signal === undefined ? {} : { signal }
    );
  } catch (error) {
    if (signal?.aborted) {
      throw new CliWatchError(
        "cli-watch-aborted",
        "Company watch was aborted."
      );
    }
    throw error;
  }
};

const watchDatasetGeneration = async (
  parsed: CompanyWatchArguments,
  client: ReturnType<typeof createKurobaraClient>,
  runtime: WatchRuntime
): Promise<DatasetGenerationGetResponse> => {
  const deadline = createWatchDeadline(parsed.timeoutMs, runtime.signal);
  const startedAt = runtime.now();
  const timedOut = (): CliWatchError =>
    new CliWatchError("cli-watch-timeout", "Company watch timed out.");
  const aborted = (): CliWatchError =>
    new CliWatchError("cli-watch-aborted", "Company watch was aborted.");
  try {
    let snapshot = await getGenerationWatchSnapshot(
      parsed,
      client,
      deadline.signal
    );
    if (parsed.timeoutMs === 0 || snapshot.terminal) {
      return snapshot;
    }
    while (true) {
      const remainingMs = parsed.timeoutMs - (runtime.now() - startedAt);
      if (remainingMs <= 0) {
        throw timedOut();
      }
      await runtime.wait(
        Math.min(parsed.pollIntervalMs, remainingMs),
        deadline.signal
      );
      if (runtime.signal?.aborted) {
        throw aborted();
      }
      if (runtime.now() - startedAt >= parsed.timeoutMs) {
        throw timedOut();
      }
      snapshot = await getGenerationWatchSnapshot(
        parsed,
        client,
        deadline.signal
      );
      if (snapshot.terminal) {
        return snapshot;
      }
    }
  } catch (error) {
    if (deadline.elapsed()) {
      throw timedOut();
    }
    if (runtime.signal?.aborted) {
      throw aborted();
    }
    throw error;
  } finally {
    deadline.dispose();
  }
};

const watchPlayRun = async (
  parsed: Extract<
    AgentSurfaceArguments,
    Readonly<{ command: "play-runs.get" }>
  >,
  client: ReturnType<typeof createKurobaraClient>,
  runtime: WatchRuntime
): Promise<PlayRun> => {
  const deadline = createWatchDeadline(parsed.timeoutMs, runtime.signal);
  const startedAt = runtime.now();
  const timedOut = (): CliWatchError =>
    new CliWatchError("cli-watch-timeout", "Play run watch timed out.");
  const aborted = (): CliWatchError =>
    new CliWatchError("cli-watch-aborted", "Play run watch was aborted.");
  const getSnapshot = async (): Promise<PlayRun> => {
    if (deadline.signal.aborted) {
      throw aborted();
    }
    try {
      return await client.playRuns.get(
        { run_id: parsed.runId } satisfies PlayRunGetInput,
        requestOptions(deadline.signal)
      );
    } catch (error) {
      if (deadline.signal.aborted) {
        throw aborted();
      }
      throw error;
    }
  };
  const shouldReturn = (snapshot: PlayRun): boolean =>
    parsed.timeoutMs === 0 ||
    snapshot.run.state === "paused" ||
    snapshot.run.state === "completed" ||
    snapshot.run.state === "failed" ||
    snapshot.run.state === "cancelled";

  try {
    let snapshot = await getSnapshot();
    if (shouldReturn(snapshot)) {
      return snapshot;
    }
    while (true) {
      const remainingMs = parsed.timeoutMs - (runtime.now() - startedAt);
      if (remainingMs <= 0) {
        throw timedOut();
      }
      await runtime.wait(
        Math.min(parsed.pollIntervalMs, remainingMs),
        deadline.signal
      );
      if (runtime.signal?.aborted) {
        throw aborted();
      }
      if (runtime.now() - startedAt >= parsed.timeoutMs) {
        throw timedOut();
      }
      snapshot = await getSnapshot();
      if (shouldReturn(snapshot)) {
        return snapshot;
      }
    }
  } catch (error) {
    if (deadline.elapsed()) {
      throw timedOut();
    }
    if (runtime.signal?.aborted) {
      throw aborted();
    }
    throw error;
  } finally {
    deadline.dispose();
  }
};

type ExportDeadline = Readonly<{
  callerAborted: () => boolean;
  dispose: () => void;
  signal: AbortSignal;
  timedOut: () => boolean;
}>;

const createExportDeadline = (
  timeoutMs: number,
  callerSignal?: AbortSignal
): ExportDeadline => {
  const controller = new AbortController();
  let callerDidAbort = callerSignal?.aborted ?? false;
  let deadlineElapsed = false;
  const abortFromCaller = (): void => {
    callerDidAbort = true;
    controller.abort();
  };
  if (callerDidAbort) {
    controller.abort();
  } else {
    callerSignal?.addEventListener("abort", abortFromCaller, { once: true });
  }
  const timer = setTimeout(() => {
    deadlineElapsed = true;
    controller.abort();
  }, timeoutMs);
  return {
    callerAborted: () => callerDidAbort,
    dispose: () => {
      clearTimeout(timer);
      callerSignal?.removeEventListener("abort", abortFromCaller);
    },
    signal: controller.signal,
    timedOut: () => deadlineElapsed,
  };
};

const writeAll = async (
  handle: Awaited<ReturnType<typeof open>>,
  chunk: Uint8Array
): Promise<void> => {
  let offset = 0;
  try {
    while (offset < chunk.byteLength) {
      const { bytesWritten } = await handle.write(
        chunk,
        offset,
        chunk.byteLength - offset
      );
      if (bytesWritten < 1) {
        throw new Error("zero-byte write");
      }
      offset += bytesWritten;
    }
  } catch (error) {
    throw new CliOutputError("Export output could not be written.", {
      cause: error,
    });
  }
};

type ExportFileArguments = Readonly<{
  format: "csv" | "jsonl";
  outputFile: string;
}>;

type ExportFileReceipt = Readonly<{
  byte_count: number;
  format: "csv" | "jsonl";
  sha256: string;
}>;

type StagedPrivateFile = Readonly<{
  destinationPath: string;
  temporaryPath: string;
}>;

type StagedExport = Readonly<{
  file: StagedPrivateFile;
  receipt: ExportFileReceipt;
}>;

const createPrivateTemporaryPath = (destinationPath: string): string =>
  path.join(
    path.dirname(destinationPath),
    `.${path.basename(destinationPath)}.${randomUUID()}.tmp`
  );

const stagePrivateBytes = async (
  destinationPath: string,
  bytes: Uint8Array,
  signal: AbortSignal,
  errorLabel: string
): Promise<StagedPrivateFile> => {
  const temporaryPath = createPrivateTemporaryPath(destinationPath);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    if (signal.aborted) {
      throw new DOMException("Aborted", "AbortError");
    }
    try {
      handle = await open(
        temporaryPath,
        constants.O_CREAT +
          constants.O_EXCL +
          constants.O_NOFOLLOW +
          constants.O_WRONLY,
        0o600
      );
    } catch (error) {
      throw new CliOutputError(`${errorLabel} could not be created.`, {
        cause: error,
      });
    }
    await writeAll(handle, bytes);
    if (signal.aborted) {
      throw new DOMException("Aborted", "AbortError");
    }
    try {
      await handle.sync();
      await handle.close();
      handle = undefined;
    } catch (error) {
      throw new CliOutputError(`${errorLabel} could not be synchronized.`, {
        cause: error,
      });
    }
    return { destinationPath, temporaryPath };
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
};

const stageExport = async (
  parsed: ExportFileArguments,
  exported: KurobaraExportStream,
  signal: AbortSignal
): Promise<StagedExport> => {
  const temporaryPath = createPrivateTemporaryPath(parsed.outputFile);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  const hash = createHash("sha256");
  let byteCount = 0;
  try {
    if (signal.aborted) {
      throw new DOMException("Aborted", "AbortError");
    }
    try {
      handle = await open(
        temporaryPath,
        constants.O_CREAT +
          constants.O_EXCL +
          constants.O_NOFOLLOW +
          constants.O_WRONLY,
        0o600
      );
    } catch (error) {
      throw new CliOutputError(
        "Export temporary output could not be created.",
        { cause: error }
      );
    }

    for await (const chunk of exported.bytes) {
      if (signal.aborted) {
        throw new DOMException("Aborted", "AbortError");
      }
      await writeAll(handle, chunk);
      hash.update(chunk);
      byteCount += chunk.byteLength;
    }
    const contentSha256 = `sha256:${hash.digest("hex")}`;
    if (
      (exported.contentLength !== undefined ||
        exported.contentSha256 !== undefined) &&
      (byteCount !== exported.contentLength ||
        contentSha256 !== exported.contentSha256)
    ) {
      throw new KurobaraTransportError(
        "invalid-response",
        "The Kurobara API export integrity proof did not match."
      );
    }
    if (signal.aborted) {
      throw new DOMException("Aborted", "AbortError");
    }
    try {
      await handle.sync();
      await handle.close();
      handle = undefined;
    } catch (error) {
      throw new CliOutputError("Export output could not be synchronized.", {
        cause: error,
      });
    }
    return {
      file: { destinationPath: parsed.outputFile, temporaryPath },
      receipt: {
        byte_count: byteCount,
        format: parsed.format,
        sha256: contentSha256,
      },
    };
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
};

const publishStagedFiles = async (
  files: readonly StagedPrivateFile[],
  signal: AbortSignal
): Promise<void> => {
  const publishedPaths: string[] = [];
  try {
    for (const file of files) {
      if (signal.aborted) {
        throw new DOMException("Aborted", "AbortError");
      }
      try {
        await link(file.temporaryPath, file.destinationPath);
        publishedPaths.push(file.destinationPath);
      } catch (error) {
        throw new CliOutputError(
          "Export destination could not be published without overwrite.",
          { cause: error }
        );
      }
    }
  } catch (error) {
    for (const publishedPath of publishedPaths) {
      await unlink(publishedPath).catch(() => undefined);
    }
    throw error;
  }
};

const cleanupStagedFiles = async (
  files: readonly (StagedPrivateFile | undefined)[]
): Promise<void> => {
  for (const file of files) {
    if (file !== undefined) {
      await unlink(file.temporaryPath).catch(() => undefined);
    }
  }
};

const assertDestinationAvailable = async (
  destinationPath: string
): Promise<void> => {
  try {
    await lstat(destinationPath);
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") {
      return;
    }
    throw new CliOutputError("Export destination could not be inspected.", {
      cause: error,
    });
  }
  throw new CliOutputError(
    "Export destination could not be published without overwrite."
  );
};

const publishExport = async (
  parsed: ExportFileArguments,
  exported: KurobaraExportStream,
  signal: AbortSignal
): Promise<ExportFileReceipt> => {
  const staged = await stageExport(parsed, exported, signal);
  try {
    await publishStagedFiles([staged.file], signal);
    return staged.receipt;
  } finally {
    await cleanupStagedFiles([staged.file]);
  }
};

type RecipeExportReceipt = Readonly<{
  application_id: string;
}> &
  ExportFileReceipt;

type DatasetExportReceipt = Readonly<{
  dataset_id: string;
  delivery_id?: string;
  delivery_state?: ExportDeliveryState["state"];
  expires_at_ms?: number;
}> &
  ExportFileReceipt;

const stageDatasetExportReceipt = (
  receiptFile: string,
  receipt: DatasetExportReceipt,
  signal: AbortSignal
): Promise<StagedPrivateFile> =>
  stagePrivateBytes(
    receiptFile,
    new TextEncoder().encode(`${JSON.stringify(receipt)}\n`),
    signal,
    "Export receipt"
  );

const publishDatasetExportReceipt = async (
  receiptFile: string,
  receipt: DatasetExportReceipt,
  signal: AbortSignal
): Promise<void> => {
  const stagedReceipt = await stageDatasetExportReceipt(
    receiptFile,
    receipt,
    signal
  );
  try {
    await publishStagedFiles([stagedReceipt], signal);
  } finally {
    await cleanupStagedFiles([stagedReceipt]);
  }
};

const replaceDatasetExportReceipt = async (
  receiptFile: string,
  receipt: DatasetExportReceipt,
  signal: AbortSignal
): Promise<void> => {
  const stagedReceipt = await stageDatasetExportReceipt(
    receiptFile,
    receipt,
    signal
  );
  try {
    try {
      await rename(stagedReceipt.temporaryPath, receiptFile);
    } catch (error) {
      throw new CliOutputError("Export receipt could not be finalized.", {
        cause: error,
      });
    }
  } finally {
    await cleanupStagedFiles([stagedReceipt]);
  }
};

const cancelExportBytes = async (
  exported: KurobaraExportStream
): Promise<void> => {
  const iterator = exported.bytes[Symbol.asyncIterator]();
  await iterator.return?.();
};

const datasetExportResponseReceipt = (
  parsed: DatasetExportArguments,
  exported: KurobaraExportStream
): DatasetExportReceipt => {
  if (exported.delivery === undefined) {
    return {
      byte_count: exported.contentLength,
      dataset_id: parsed.datasetId,
      format: parsed.format,
      sha256: exported.contentSha256,
    };
  }
  return {
    byte_count: exported.contentLength,
    dataset_id: parsed.datasetId,
    delivery_id: exported.delivery.deliveryId,
    delivery_state: exported.delivery.stateAtResponse,
    expires_at_ms: exported.delivery.expiresAtMs,
    format: parsed.format,
    sha256: exported.contentSha256,
  };
};

const resolveDatasetExportReceipt = async (
  parsed: DatasetExportArguments,
  exported: KurobaraExportStream,
  fileReceipt: ExportFileReceipt,
  client: ReturnType<typeof createKurobaraClient>,
  signal: AbortSignal
): Promise<DatasetExportReceipt> => {
  if (exported.delivery === undefined) {
    return { dataset_id: parsed.datasetId, ...fileReceipt };
  }
  const delivery = await client.exportDeliveries.get(
    { delivery_id: exported.delivery.deliveryId },
    { signal }
  );
  if (
    delivery.delivery_id !== exported.delivery.deliveryId ||
    delivery.dataset_id !== parsed.datasetId ||
    delivery.format !== parsed.format ||
    delivery.content_length !== fileReceipt.byte_count ||
    delivery.content_hash !== fileReceipt.sha256 ||
    delivery.expires_at_ms !== exported.delivery.expiresAtMs ||
    delivery.state !== "delivered"
  ) {
    throw new KurobaraTransportError(
      "invalid-response",
      "The Kurobara API export delivery proof did not match its body."
    );
  }
  return {
    dataset_id: parsed.datasetId,
    ...fileReceipt,
    delivery_id: delivery.delivery_id,
    delivery_state: delivery.state,
    expires_at_ms: delivery.expires_at_ms,
  };
};

const exportRecipeApplication = async (
  parsed: RecipeExportArguments,
  client: ReturnType<typeof createKurobaraClient>,
  callerSignal?: AbortSignal
): Promise<RecipeExportReceipt> => {
  const deadline = createExportDeadline(parsed.timeoutMs, callerSignal);
  const request: RecipeApplicationExportRequest = {
    application_id: parsed.applicationId,
    ...(parsed.fieldIds === undefined ? {} : { field_ids: parsed.fieldIds }),
    format: parsed.format,
  };
  try {
    const exported = await client.recipeApplications.export(request, {
      maxBytes: parsed.maxBytes,
      signal: deadline.signal,
    });
    return {
      application_id: parsed.applicationId,
      ...(await publishExport(parsed, exported, deadline.signal)),
    };
  } catch (error) {
    if (deadline.timedOut()) {
      throw new CliExportError(
        "cli-export-timeout",
        "Recipe application export timed out."
      );
    }
    if (deadline.callerAborted()) {
      throw new CliExportError(
        "cli-export-aborted",
        "Recipe application export was aborted."
      );
    }
    throw error;
  } finally {
    deadline.dispose();
  }
};

const DATASET_EXPORT_STDOUT_COMPLETE = Symbol("dataset-export-stdout-complete");

const writeOutputChunk = async (
  target: WritableTarget,
  chunk: Uint8Array,
  signal: AbortSignal
): Promise<void> => {
  let accepted: unknown;
  try {
    accepted = target.write(chunk);
  } catch (error) {
    throw new CliOutputError("Export stdout could not be written.", {
      cause: error,
    });
  }
  if (accepted !== false) {
    return;
  }
  if (target.once === undefined) {
    throw new CliOutputError("Export stdout cannot signal backpressure.");
  }
  await new Promise<void>((resolve, reject) => {
    const cleanup = (): void => {
      target.off?.("drain", onDrain);
      signal.removeEventListener("abort", onAbort);
    };
    const onDrain = (): void => {
      cleanup();
      resolve();
    };
    const onAbort = (): void => {
      cleanup();
      reject(new DOMException("Aborted", "AbortError"));
    };
    target.once?.("drain", onDrain);
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) {
      onAbort();
    }
  });
};

const streamExportToStdout = async (
  exported: KurobaraExportStream,
  stdout: WritableTarget,
  signal: AbortSignal
): Promise<void> => {
  for await (const chunk of exported.bytes) {
    if (signal.aborted) {
      throw new DOMException("Aborted", "AbortError");
    }
    await writeOutputChunk(stdout, chunk, signal);
  }
};

const exportDatasetToStdout = async (
  parsed: DatasetExportArguments,
  exported: KurobaraExportStream,
  client: ReturnType<typeof createKurobaraClient>,
  stdout: WritableTarget,
  signal: AbortSignal
): Promise<typeof DATASET_EXPORT_STDOUT_COMPLETE> => {
  if (exported.delivery !== undefined && parsed.receiptFile === undefined) {
    await cancelExportBytes(exported);
    throw new CliInputError(
      "cli-usage-error",
      "Tracked dataset exports to stdout require --receipt PATH."
    );
  }
  if (exported.delivery !== undefined && parsed.receiptFile !== undefined) {
    try {
      await publishDatasetExportReceipt(
        parsed.receiptFile,
        datasetExportResponseReceipt(parsed, exported),
        signal
      );
    } catch (error) {
      await cancelExportBytes(exported);
      throw error;
    }
  }
  await streamExportToStdout(exported, stdout, signal);
  if (parsed.receiptFile === undefined) {
    return DATASET_EXPORT_STDOUT_COMPLETE;
  }
  const receipt = await resolveDatasetExportReceipt(
    parsed,
    exported,
    datasetExportResponseReceipt(parsed, exported),
    client,
    signal
  );
  if (exported.delivery === undefined) {
    await publishDatasetExportReceipt(parsed.receiptFile, receipt, signal);
  } else {
    await replaceDatasetExportReceipt(parsed.receiptFile, receipt, signal);
  }
  return DATASET_EXPORT_STDOUT_COMPLETE;
};

const exportDataset = async (
  parsed: DatasetExportArguments,
  client: ReturnType<typeof createKurobaraClient>,
  stdout: WritableTarget,
  callerSignal?: AbortSignal
): Promise<DatasetExportReceipt | typeof DATASET_EXPORT_STDOUT_COMPLETE> => {
  const deadline = createExportDeadline(parsed.timeoutMs, callerSignal);
  const request: DatasetExportRequest = {
    dataset_id: parsed.datasetId,
    ...(parsed.fieldIds === undefined ? {} : { field_ids: parsed.fieldIds }),
    format: parsed.format,
  };
  try {
    if (parsed.outputFile === undefined && parsed.receiptFile !== undefined) {
      await assertDestinationAvailable(parsed.receiptFile);
    }
    const exported = await client.datasets.export(request, {
      maxBytes: parsed.maxBytes,
      signal: deadline.signal,
    });
    if (parsed.outputFile === undefined) {
      return exportDatasetToStdout(
        parsed,
        exported,
        client,
        stdout,
        deadline.signal
      );
    }
    const stagedExport = await stageExport(
      { format: parsed.format, outputFile: parsed.outputFile },
      exported,
      deadline.signal
    );
    let stagedReceipt: StagedPrivateFile | undefined;
    try {
      const receipt = await resolveDatasetExportReceipt(
        parsed,
        exported,
        stagedExport.receipt,
        client,
        deadline.signal
      );
      stagedReceipt =
        parsed.receiptFile === undefined
          ? undefined
          : await stageDatasetExportReceipt(
              parsed.receiptFile,
              receipt,
              deadline.signal
            );
      await publishStagedFiles(
        stagedReceipt === undefined
          ? [stagedExport.file]
          : [stagedExport.file, stagedReceipt],
        deadline.signal
      );
      return receipt;
    } finally {
      await cleanupStagedFiles([stagedExport.file, stagedReceipt]);
    }
  } catch (error) {
    if (deadline.timedOut()) {
      throw new CliExportError(
        "cli-export-timeout",
        "Dataset export timed out."
      );
    }
    if (deadline.callerAborted()) {
      throw new CliExportError(
        "cli-export-aborted",
        "Dataset export was aborted."
      );
    }
    throw error;
  } finally {
    deadline.dispose();
  }
};

const requestOptions = (
  signal: AbortSignal | undefined
): Readonly<{ signal?: AbortSignal }> =>
  signal === undefined ? {} : { signal };

const isContactDerivation = (
  parsed: CliArguments
): parsed is ContactDerivationArguments =>
  parsed.command === "contacts.identity.reveal" ||
  parsed.command === "contacts.work-email.resolve" ||
  parsed.command === "contacts.work-email.verify";

const executeContactDerivation = (
  parsed: ContactDerivationArguments,
  client: ReturnType<typeof createKurobaraClient>,
  signal?: AbortSignal
) => {
  const request: SelectedContactDerivationRequest = {
    authority_envelope_id: parsed.authorityEnvelopeId,
    budget: { limit: parsed.budgetLimit, unit: parsed.budgetUnit },
    contact_dataset_id: parsed.contactDatasetId,
    contact_record_ids: parsed.contactRecordIds,
    deadline_ms: parsed.deadlineMs,
    operation_id: parsed.operationId,
  };
  const options = requestOptions(signal);
  if (parsed.command === "contacts.identity.reveal") {
    return client.contacts.revealIdentities(request, options);
  }
  return parsed.command === "contacts.work-email.resolve"
    ? client.contacts.resolveWorkEmails(request, options)
    : client.contacts.verifyWorkEmails(request, options);
};

const executeContactPrivacyRestriction = async (
  parsed: ContactPrivacyRestrictArguments,
  client: ReturnType<typeof createKurobaraClient>,
  stdin: ReadableSource,
  signal?: AbortSignal
): Promise<unknown> => {
  const value = await readContactPrivacySubject(parsed.valueFile, stdin);
  const subject: ContactPrivacyRestrictionRequest["subject"] =
    parsed.kind === "email"
      ? { kind: parsed.kind, value }
      : {
          kind: parsed.kind,
          provider_key: parsed.providerKey,
          value,
        };
  return client.contactPrivacy.restrict(
    {
      idempotency_key: parsed.idempotencyKey,
      reason: parsed.reason,
      subject,
    },
    requestOptions(signal)
  );
};

const executeContactDiscovery = (
  parsed: ContactSearchArguments,
  client: ReturnType<typeof createKurobaraClient>,
  signal?: AbortSignal
): Promise<unknown> => {
  const organizationSource =
    parsed.organizationSource.kind === "generation"
      ? {
          organization_generation_id: parsed.organizationSource.generationId,
        }
      : {
          organization_dataset: {
            dataset_id: parsed.organizationSource.datasetId,
            ...(parsed.organizationSource.defaultCountryCode === undefined
              ? {}
              : {
                  default_country_code:
                    parsed.organizationSource.defaultCountryCode,
                }),
            field_mapping: {
              ...(parsed.organizationSource.fieldMapping.countryCode ===
              undefined
                ? {}
                : {
                    country_code:
                      parsed.organizationSource.fieldMapping.countryCode,
                  }),
              domain: parsed.organizationSource.fieldMapping.domain,
              ...(parsed.organizationSource.fieldMapping.name === undefined
                ? {}
                : { name: parsed.organizationSource.fieldMapping.name }),
            },
          },
        };
  const request: ContactDiscoverRequest = {
    authority_envelope_id: parsed.authorityEnvelopeId,
    budget: { limit: parsed.budgetLimit, unit: parsed.budgetUnit },
    dataset_id: parsed.datasetId,
    dataset_name: parsed.datasetName,
    deadline_ms: parsed.deadlineMs,
    discovery_id: parsed.discoveryId,
    limits: {
      max_calls: parsed.maxCalls,
      max_companies: parsed.maxCompanies,
      max_contacts_per_company: parsed.maxContactsPerCompany,
      max_contacts_total: parsed.maxContactsTotal,
      max_pages: parsed.maxPages,
    },
    mode: parsed.mode,
    ...organizationSource,
    query: {
      company_headquarters_country_codes: parsed.companyCountries,
      departments: parsed.departments,
      person_country_codes: parsed.personCountries,
      result_kind: "contact",
      seniorities:
        parsed.seniorities as ContactDiscoverRequest["query"]["seniorities"],
      titles: parsed.titles,
    },
  };
  return client.contacts.discover(request, requestOptions(signal));
};

const executeCommand = async (
  parsed: CliArguments,
  client: ReturnType<typeof createKurobaraClient>,
  stdin: ReadableSource,
  stdout: WritableTarget,
  watchRuntime: WatchRuntime
  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: This is the explicit generated-command dispatcher; each branch delegates to one bounded operation.
): Promise<unknown> => {
  if (parsed.command === "gtm-contexts.questionnaire.get") {
    return client.contexts.questions(
      { profile: parsed.profile },
      requestOptions(watchRuntime.signal)
    );
  }
  if (parsed.command === "gtm-contexts.status.get") {
    return client.contexts.status(
      { profile: parsed.profile } satisfies GtmContextStatusInput,
      requestOptions(watchRuntime.signal)
    );
  }
  if (parsed.command === "gtm-contexts.plan") {
    return client.contexts.plan(
      (await readAgentRequest(parsed.requestFile)) as Extract<
        GtmContextCommand,
        Readonly<{ mode: "plan" }>
      >,
      requestOptions(watchRuntime.signal)
    );
  }
  if (parsed.command === "gtm-contexts.apply") {
    return client.contexts.apply(
      (await readAgentRequest(parsed.requestFile)) as Extract<
        GtmContextCommand,
        Readonly<{ mode: "apply" }>
      >,
      requestOptions(watchRuntime.signal)
    );
  }
  if (parsed.command === "plays.preview") {
    return client.plays.preview(
      (await readAgentRequest(parsed.requestFile)) as Extract<
        PlayCommand,
        Readonly<{ action: "preview" }>
      >,
      requestOptions(watchRuntime.signal)
    );
  }
  if (parsed.command === "plays.apply") {
    return client.plays.apply(
      (await readAgentRequest(parsed.requestFile)) as Exclude<
        PlayCommand,
        Readonly<{ action: "preview" }>
      >,
      requestOptions(watchRuntime.signal)
    );
  }
  if (parsed.command === "play-runs.get") {
    return watchPlayRun(parsed, client, watchRuntime);
  }
  if (parsed.command === "workbooks.get") {
    return client.workbooks.get(
      (await readAgentRequest(parsed.requestFile)) as WorkbookGetInput,
      requestOptions(watchRuntime.signal)
    );
  }
  if (parsed.command === "workbooks.update") {
    return client.workbooks.update(
      (await readAgentRequest(parsed.requestFile)) as WorkbookUpdateInput,
      requestOptions(watchRuntime.signal)
    );
  }
  if (parsed.command === "contact-privacy.restrict") {
    return executeContactPrivacyRestriction(
      parsed,
      client,
      stdin,
      watchRuntime.signal
    );
  }
  if (parsed.command === "contacts.discover") {
    return executeContactDiscovery(parsed, client, watchRuntime.signal);
  }
  if (isContactDerivation(parsed)) {
    return executeContactDerivation(parsed, client, watchRuntime.signal);
  }
  if (parsed.command === "organizations.discover") {
    const request: OrganizationDiscoverRequest = {
      authority_envelope_id: parsed.authorityEnvelopeId,
      budget: { limit: parsed.budgetLimit, unit: parsed.budgetUnit },
      dataset_id: parsed.datasetId,
      dataset_name: parsed.datasetName,
      deadline_ms: parsed.deadlineMs,
      discovery_id: parsed.discoveryId,
      limits: {
        max_calls: parsed.maxCalls,
        max_companies: parsed.maxCompanies,
        max_pages: parsed.maxPages,
      },
      mode: parsed.mode,
      query: {
        country_codes: parsed.countries,
        country_scope: "headquarters",
        ...(parsed.employeeMaximum === undefined ||
        parsed.employeeMinimum === undefined
          ? {}
          : {
              employee_count: {
                maximum: parsed.employeeMaximum,
                minimum: parsed.employeeMinimum,
              },
            }),
        industry_codes: parsed.industries,
        industry_taxonomy: "kurobara-v1",
        ...(parsed.keywords === undefined ? {} : { keywords: parsed.keywords }),
        result_kind: "company",
      },
    };
    return client.organizations.discover(
      request,
      requestOptions(watchRuntime.signal)
    );
  }
  if (parsed.command === "organizations.candidates.list") {
    return client.organizations.listCandidates(
      {
        after_ordinal: parsed.afterOrdinal,
        generation_id: parsed.generationId,
        limit: parsed.limit,
      },
      requestOptions(watchRuntime.signal)
    ) satisfies Promise<OrganizationCandidatesListResponse>;
  }
  if (parsed.command === "contacts.candidates.list") {
    return client.contacts.listCandidates(
      {
        after_ordinal: parsed.afterOrdinal,
        generation_id: parsed.generationId,
        limit: parsed.limit,
      },
      requestOptions(watchRuntime.signal)
    ) satisfies Promise<ContactCandidatesListResponse>;
  }
  if (parsed.command === "dataset-generations.get") {
    return watchDatasetGeneration(parsed, client, watchRuntime);
  }
  if (parsed.command === "dataset-generations.cancel") {
    return client.datasetGenerations.cancel(
      {
        generation_id: parsed.generationId,
        idempotency_key: parsed.idempotencyKey,
      },
      requestOptions(watchRuntime.signal)
    ) satisfies Promise<DatasetGenerationCancelResponse>;
  }
  if (parsed.command === "recipes.apply") {
    return client.recipes.apply(await readRecipeRequest(parsed.requestFile));
  }
  if (parsed.command === "datasets.export") {
    return exportDataset(parsed, client, stdout, watchRuntime.signal);
  }
  if (parsed.command === "export-deliveries.get") {
    return client.exportDeliveries.get(
      { delivery_id: parsed.deliveryId },
      requestOptions(watchRuntime.signal)
    );
  }
  if (parsed.command === "export-deliveries.revoke") {
    return client.exportDeliveries.revoke(
      { delivery_id: parsed.deliveryId },
      requestOptions(watchRuntime.signal)
    );
  }
  if (parsed.command === "recipe-applications.export") {
    return exportRecipeApplication(parsed, client, watchRuntime.signal);
  }
  if (parsed.command === "recipe-applications.get") {
    return watchRecipeApplication(parsed, client, watchRuntime);
  }
  if (parsed.command === "runs.cancel") {
    return client.runs.cancel(
      {
        idempotency_key: parsed.idempotencyKey,
        run_id: parsed.runId,
      },
      requestOptions(watchRuntime.signal)
    );
  }
  if (parsed.command === "datasets.import") {
    const [metadata, source] = await Promise.all([
      readMetadata(parsed.metadataFile),
      openSource(parsed.sourceFile, stdin),
    ]);
    return client.datasets.import({ metadata, source });
  }
  throw new Error("Unsupported generated CLI command.");
};

const handleCliError = (
  error: unknown,
  command: CliArguments["command"] | undefined,
  stderr: WritableTarget
): number => {
  if (error instanceof KurobaraProblemError) {
    writeJson(stderr, error.problem);
    return command === undefined
      ? 70
      : problemExitCode(command, error.problem.code);
  }
  if (error instanceof CliInputError) {
    writeJson(stderr, failure(error.code, error.message));
    return 2;
  }
  if (error instanceof CliWatchError) {
    writeJson(stderr, failure(error.code, error.message));
    return error.code === "cli-watch-aborted" ? 130 : 75;
  }
  if (error instanceof CliExportError) {
    writeJson(stderr, failure(error.code, error.message));
    return error.code === "cli-export-aborted" ? 130 : 75;
  }
  if (error instanceof CliOutputError) {
    writeJson(
      stderr,
      failure("cli-output-error", "Export output could not be written.")
    );
    return 74;
  }
  if (error instanceof KurobaraConfigError) {
    writeJson(
      stderr,
      failure(
        "cli-config-invalid",
        "Kurobara endpoint or credential configuration is invalid."
      )
    );
    return 2;
  }
  if (error instanceof KurobaraTransportError) {
    if (error.kind === "invalid-input") {
      writeJson(
        stderr,
        failure(
          "cli-input-invalid",
          command === undefined
            ? "Kurobara input is invalid."
            : invalidInputTitle(command)
        )
      );
      return 2;
    }
    if (error.kind === "network") {
      writeJson(
        stderr,
        failure("cli-transport-error", "Kurobara API request failed.", true)
      );
      return 75;
    }
    writeJson(
      stderr,
      failure("cli-contract-error", "Kurobara API contract validation failed.")
    );
    return 70;
  }
  writeJson(
    stderr,
    failure("cli-runtime-error", "Kurobara CLI execution failed.")
  );
  return 70;
};

export const runCli = async (invocation: CliInvocation): Promise<number> => {
  const onboardingExitCode = await runOnboardingCli(invocation);
  if (onboardingExitCode !== undefined) {
    return onboardingExitCode;
  }
  let selectedCommand: CliArguments["command"] | undefined;
  try {
    const machineRequested = invocation.argv.includes("--json");
    const noColor =
      invocation.argv.includes("--no-color") ||
      invocation.environment.NO_COLOR !== undefined ||
      invocation.environment.TERM === "dumb";
    const argv = invocation.argv.filter(
      (argument) => argument !== "--json" && argument !== "--no-color"
    );
    const parsed = parseArguments(argv, invocation.environment);
    selectedCommand = parsed.command;
    const apiKey = await readApiKey(parsed.apiKeyFile, invocation.environment);
    const client = createKurobaraClient({
      apiKey,
      baseUrl: parsed.endpoint,
      ...(invocation.fetch === undefined ? {} : { fetch: invocation.fetch }),
    });
    const result = await executeCommand(
      parsed,
      client,
      invocation.stdin,
      invocation.stdout,
      {
        now: invocation.now ?? Date.now,
        ...(invocation.signal === undefined
          ? {}
          : { signal: invocation.signal }),
        wait: invocation.wait ?? waitFor,
      }
    );
    if (result !== DATASET_EXPORT_STDOUT_COMPLETE) {
      const humanSurface =
        !machineRequested &&
        invocation.stdout.isTTY === true &&
        (parsed.command.startsWith("gtm-contexts.") ||
          parsed.command.startsWith("plays.") ||
          parsed.command === "play-runs.get" ||
          parsed.command.startsWith("workbooks."));
      if (humanSurface) {
        renderHumanCommandResult(
          invocation.stdout,
          parsed.command,
          result,
          !noColor
        );
      } else {
        writeJson(invocation.stdout, result);
      }
    }
    return 0;
  } catch (error) {
    return handleCliError(error, selectedCommand, invocation.stderr);
  }
};
