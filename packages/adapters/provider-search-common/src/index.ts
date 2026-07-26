import {
  definePluginAdapter,
  type PluginAdapterV1,
  type PluginClassifyErrorRequest,
  type PluginExecuteRequest,
  type PluginExecuteResult,
  type PluginManifestV1,
  type PluginNormalizeResult,
  validatePluginJson,
} from "@kurobara/plugin-sdk";

export const SEARCH_CAPABILITY = Object.freeze({
  capabilityId: "organizations.website.resolve",
  capabilityVersion: "1.0.0",
});

// This fingerprint is an admitted build-time binding, not a runtime import of
// the contracts workspace. It must be refreshed after canonical contract
// generation before the adapter set is released.
export const SEARCH_CATALOG_FINGERPRINT =
  "sha256:e71489cc76d8e5cd9de5fbf57913402e4310431786ca4dd53bc5b2e069c87afd";

const RECIPE_CELL_INPUT_SCHEMA_FINGERPRINT =
  "sha256:c40a6d60340e2fcc29415f4594b5b3f951da7a798d41a245bb63cecd1600eccd";
const RECIPE_CELL_INPUT_SCHEMA_ID =
  "https://schemas.kurobara.invalid/schemas/recipes/cell-input/1.0.0";
const RECIPE_CELL_OUTPUT_SCHEMA_FINGERPRINT =
  "sha256:a131ddf91ef2314dbaf7af91f3ba56eec4adf766d557a70185b0bbc320d13e9d";
const RECIPE_CELL_OUTPUT_SCHEMA_ID =
  "https://schemas.kurobara.invalid/schemas/recipes/cell-output/1.0.0";

// This is the only contract binding used by the official search adapters.
// Regeneration may update the catalog version/fingerprint without changing the
// two schema bindings.
export const SEARCH_CONTRACTS = Object.freeze({
  input: Object.freeze({
    catalogFingerprint: SEARCH_CATALOG_FINGERPRINT,
    catalogVersion: "0.12.0",
    schemaFingerprint: RECIPE_CELL_INPUT_SCHEMA_FINGERPRINT,
    schemaId: RECIPE_CELL_INPUT_SCHEMA_ID,
    schemaVersion: "1.0.0",
  }),
  output: Object.freeze({
    catalogFingerprint: SEARCH_CATALOG_FINGERPRINT,
    catalogVersion: "0.12.0",
    schemaFingerprint: RECIPE_CELL_OUTPUT_SCHEMA_FINGERPRINT,
    schemaId: RECIPE_CELL_OUTPUT_SCHEMA_ID,
    schemaVersion: "1.0.0",
  }),
});

const MAX_API_KEY_LENGTH = 4096;
const MAX_RESPONSE_BYTES = 262_144;
const MAX_JSON_DEPTH = 64;
const MAX_JSON_NODES = 16_384;
const EXECUTE_TIMEOUT_MS = 10_000;
const LOOKUP_TIMEOUT_MS = 1000;
const MAX_RETRY_AFTER_MS = 86_400_000;

const INPUT_KEYS = Object.freeze([
  "datasetId",
  "inputValues",
  "recipeId",
  "recipeRevision",
  "recordContentHash",
  "recordId",
  "targetFieldId",
  "workflowContentHash",
  "workflowRevision",
  "workflowSpecId",
  "workspaceId",
] as const);

const IDENTITY_KEYS = Object.freeze([
  "datasetId",
  "recipeId",
  "recipeRevision",
  "recordId",
  "targetFieldId",
  "workflowRevision",
  "workflowSpecId",
  "workspaceId",
] as const);

const HASH_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const SAFE_REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{1,255}$/u;
const DOMAIN_LABEL_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;
const TOP_LEVEL_DOMAIN_PATTERN = /^[a-z]{2,63}$/u;
const NON_WHITESPACE_PATTERN = /\S/u;
const JSON_CONTENT_TYPE_PATTERN =
  /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+\+json$/u;
const UNSIGNED_INTEGER_PATTERN = /^\d+$/u;

type JsonRecord = Record<string, unknown>;

export type SearchProviderClock = Readonly<{ now: () => number }>;

export type SearchProviderOptions = Readonly<{
  apiKey: string;
  clock?: SearchProviderClock;
  fetch?: typeof fetch;
}>;

export type SearchProviderDefinition = Readonly<{
  authMode: "api-key-header" | "bearer-token";
  endpoint: `https://${string}`;
  hostname: string;
  pluginId: string;
  request: (domain: string) => Readonly<Record<string, unknown>>;
  requestIdKey: "request_id" | "requestId";
}>;

export class SearchProviderConfigurationError extends Error {
  readonly reasonCode = "provider-search-configuration-invalid" as const;

  constructor() {
    super("Search provider configuration is invalid.");
    this.name = "SearchProviderConfigurationError";
  }
}

class SearchProviderResponseError extends Error {
  constructor(options?: ErrorOptions) {
    super("Search provider response was rejected.", options);
    this.name = "SearchProviderResponseError";
  }
}

const isJsonWhitespace = (character: string | undefined): boolean =>
  character === " " ||
  character === "\t" ||
  character === "\n" ||
  character === "\r";

const plainRecord = (value: unknown): value is JsonRecord => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

const hasExactKeys = (
  value: JsonRecord,
  expected: readonly string[]
): boolean => {
  const keys = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return (
    keys.length === sortedExpected.length &&
    keys.every((key, index) => key === sortedExpected[index])
  );
};

const isIdentity = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length >= 1 &&
  value.length <= 255 &&
  NON_WHITESPACE_PATTERN.test(value);

const isScalar = (value: unknown): boolean =>
  value === null ||
  typeof value === "boolean" ||
  (typeof value === "string" && value.length <= 16_384) ||
  (typeof value === "number" &&
    Number.isFinite(value) &&
    value >= -1_000_000_000_000_000 &&
    value <= 1_000_000_000_000_000);

const normalizeDomain = (value: string): string | undefined => {
  const domain = value.trim().toLowerCase();
  if (
    domain !== value.trim() ||
    domain.length > 253 ||
    domain.endsWith(".") ||
    domain.includes(":") ||
    domain.includes("/") ||
    domain.includes("@") ||
    domain.includes("?") ||
    domain.includes("#")
  ) {
    return;
  }
  const labels = domain.split(".");
  if (
    labels.length < 2 ||
    !labels.every((label) => DOMAIN_LABEL_PATTERN.test(label)) ||
    !TOP_LEVEL_DOMAIN_PATTERN.test(labels.at(-1) ?? "")
  ) {
    return;
  }
  return domain;
};

type DomainEntryResult = Readonly<{
  domain?: string;
  valid: boolean;
}>;

const domainEntry = (
  entry: unknown,
  fieldIds: Set<string>
): DomainEntryResult => {
  if (!(plainRecord(entry) && isIdentity(entry.fieldId))) {
    return { valid: false };
  }
  if (fieldIds.has(entry.fieldId)) {
    return { valid: false };
  }
  fieldIds.add(entry.fieldId);
  if (entry.present === false) {
    return {
      valid: hasExactKeys(entry, ["fieldId", "present"]),
    };
  }
  if (
    entry.present !== true ||
    !hasExactKeys(entry, ["fieldId", "present", "value"]) ||
    !isScalar(entry.value)
  ) {
    return { valid: false };
  }
  if (typeof entry.value !== "string") {
    return { valid: true };
  }
  const domain = normalizeDomain(entry.value);
  return {
    ...(domain === undefined ? {} : { domain }),
    valid: true,
  };
};

const extractDomain = (candidate: unknown): string | undefined => {
  if (!(plainRecord(candidate) && hasExactKeys(candidate, INPUT_KEYS))) {
    return;
  }
  if (!IDENTITY_KEYS.every((key) => isIdentity(candidate[key]))) {
    return;
  }
  if (
    typeof candidate.recordContentHash !== "string" ||
    !HASH_PATTERN.test(candidate.recordContentHash) ||
    typeof candidate.workflowContentHash !== "string" ||
    !HASH_PATTERN.test(candidate.workflowContentHash)
  ) {
    return;
  }
  if (
    !Array.isArray(candidate.inputValues) ||
    candidate.inputValues.length < 1 ||
    candidate.inputValues.length > 64
  ) {
    return;
  }

  const fieldIds = new Set<string>();
  const domains: string[] = [];
  for (const entry of candidate.inputValues) {
    const parsed = domainEntry(entry, fieldIds);
    if (!parsed.valid) {
      return;
    }
    if (parsed.domain !== undefined) {
      domains.push(parsed.domain);
    }
  }
  return domains.length === 1 ? domains[0] : undefined;
};

class StrictJsonParser {
  readonly #source: string;
  #index = 0;
  #nodes = 0;

  constructor(source: string) {
    this.#source = source;
  }

  parse(): unknown {
    const value = this.#parseValue(0);
    this.#skipWhitespace();
    if (this.#index !== this.#source.length) {
      throw new SearchProviderResponseError();
    }
    return value;
  }

  #bumpNode(depth: number): void {
    this.#nodes += 1;
    if (depth > MAX_JSON_DEPTH || this.#nodes > MAX_JSON_NODES) {
      throw new SearchProviderResponseError();
    }
  }

  #parseValue(depth: number): unknown {
    this.#skipWhitespace();
    this.#bumpNode(depth);
    const character = this.#source[this.#index];
    if (character === "{") {
      return this.#parseObject(depth + 1);
    }
    if (character === "[") {
      return this.#parseArray(depth + 1);
    }
    if (character === '"') {
      return this.#parseString();
    }
    return this.#parsePrimitive();
  }

  #parseObject(depth: number): JsonRecord {
    this.#index += 1;
    const result: JsonRecord = Object.create(null) as JsonRecord;
    const keys = new Set<string>();
    this.#skipWhitespace();
    if (this.#source[this.#index] === "}") {
      this.#index += 1;
      return result;
    }
    while (this.#index < this.#source.length) {
      this.#skipWhitespace();
      const key = this.#parseString();
      if (keys.has(key)) {
        throw new SearchProviderResponseError();
      }
      keys.add(key);
      this.#skipWhitespace();
      if (this.#source[this.#index] !== ":") {
        throw new SearchProviderResponseError();
      }
      this.#index += 1;
      result[key] = this.#parseValue(depth);
      this.#skipWhitespace();
      const separator = this.#source[this.#index];
      this.#index += 1;
      if (separator === "}") {
        return result;
      }
      if (separator !== ",") {
        throw new SearchProviderResponseError();
      }
    }
    throw new SearchProviderResponseError();
  }

  #parseArray(depth: number): unknown[] {
    this.#index += 1;
    const result: unknown[] = [];
    this.#skipWhitespace();
    if (this.#source[this.#index] === "]") {
      this.#index += 1;
      return result;
    }
    while (this.#index < this.#source.length) {
      result.push(this.#parseValue(depth));
      this.#skipWhitespace();
      const separator = this.#source[this.#index];
      this.#index += 1;
      if (separator === "]") {
        return result;
      }
      if (separator !== ",") {
        throw new SearchProviderResponseError();
      }
    }
    throw new SearchProviderResponseError();
  }

  #parseString(): string {
    if (this.#source[this.#index] !== '"') {
      throw new SearchProviderResponseError();
    }
    const start = this.#index;
    this.#index += 1;
    let escaped = false;
    while (this.#index < this.#source.length) {
      const character = this.#source[this.#index];
      this.#index += 1;
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === '"') {
        try {
          const parsed: unknown = JSON.parse(
            this.#source.slice(start, this.#index)
          );
          if (typeof parsed === "string") {
            return parsed;
          }
        } catch {
          // Reduced to a stable response error below.
        }
        throw new SearchProviderResponseError();
      } else if ((character?.codePointAt(0) ?? 0) < 0x20) {
        throw new SearchProviderResponseError();
      }
    }
    throw new SearchProviderResponseError();
  }

  #parsePrimitive(): unknown {
    const start = this.#index;
    while (this.#index < this.#source.length) {
      const character = this.#source[this.#index];
      if (
        character === "," ||
        character === "]" ||
        character === "}" ||
        isJsonWhitespace(character)
      ) {
        break;
      }
      this.#index += 1;
    }
    try {
      const parsed: unknown = JSON.parse(
        this.#source.slice(start, this.#index)
      );
      if (
        parsed === null ||
        typeof parsed === "boolean" ||
        (typeof parsed === "number" && Number.isFinite(parsed))
      ) {
        return parsed;
      }
    } catch {
      // Reduced to a stable response error below.
    }
    throw new SearchProviderResponseError();
  }

  #skipWhitespace(): void {
    while (isJsonWhitespace(this.#source[this.#index])) {
      this.#index += 1;
    }
  }
}

const readBoundedJson = async (
  response: Response,
  signal: AbortSignal
): Promise<unknown> => {
  const contentType = response.headers
    .get("content-type")
    ?.split(";", 1)[0]
    ?.trim()
    .toLowerCase();
  if (
    contentType === undefined ||
    !(
      contentType === "application/json" ||
      JSON_CONTENT_TYPE_PATTERN.test(contentType)
    )
  ) {
    throw new SearchProviderResponseError();
  }
  const declaredLength = response.headers.get("content-length");
  if (
    declaredLength !== null &&
    (!UNSIGNED_INTEGER_PATTERN.test(declaredLength) ||
      Number(declaredLength) > MAX_RESPONSE_BYTES)
  ) {
    await response.body?.cancel().catch(() => undefined);
    throw new SearchProviderResponseError();
  }
  if (response.body === null) {
    throw new SearchProviderResponseError();
  }
  if (signal.aborted) {
    throw new SearchProviderResponseError();
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let abortCancellation: Promise<void> | undefined;
  const cancelOnAbort = (): void => {
    abortCancellation = reader.cancel().catch(() => undefined);
  };
  signal.addEventListener("abort", cancelOnAbort, { once: true });
  let streamComplete = false;
  try {
    while (!streamComplete) {
      const part = await reader.read();
      if (signal.aborted) {
        throw new SearchProviderResponseError();
      }
      if (part.done) {
        streamComplete = true;
      } else {
        size += part.value.byteLength;
        if (size > MAX_RESPONSE_BYTES) {
          await reader.cancel().catch(() => undefined);
          throw new SearchProviderResponseError();
        }
        chunks.push(part.value);
      }
    }
  } finally {
    signal.removeEventListener("abort", cancelOnAbort);
    await abortCancellation;
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    throw new SearchProviderResponseError({ cause: error });
  }
  return new StrictJsonParser(text).parse();
};

type ReducedResult = Readonly<{
  requestId: string;
  score?: number;
  url: string;
}>;

type ReducedResponse =
  | Readonly<{
      requestId: string;
      status: "not-found";
    }>
  | Readonly<{
      result: ReducedResult;
      status: "found";
    }>;

const sanitizeUrl = (candidate: unknown): URL | undefined => {
  if (typeof candidate !== "string" || candidate.length > 2048) {
    return;
  }
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return;
  }
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.port !== "" ||
    normalizeDomain(url.hostname) === undefined
  ) {
    return;
  }
  url.hash = "";
  return url.href.length <= 2048 ? url : undefined;
};

const reduceResponse = (
  payload: unknown,
  requestIdKey: SearchProviderDefinition["requestIdKey"]
): ReducedResponse | undefined => {
  if (!(plainRecord(payload) && Array.isArray(payload.results))) {
    return;
  }
  const requestIdValue = payload[requestIdKey];
  const requestId =
    typeof requestIdValue === "string" &&
    SAFE_REQUEST_ID_PATTERN.test(requestIdValue)
      ? requestIdValue
      : undefined;
  if (requestId === undefined) {
    return;
  }
  if (payload.results.length === 0) {
    return { requestId, status: "not-found" };
  }
  if (payload.results.length !== 1) {
    return;
  }
  const [result] = payload.results;
  if (!plainRecord(result)) {
    return;
  }
  const url = sanitizeUrl(result.url);
  const { score } = result;
  if (
    url === undefined ||
    (score !== undefined &&
      (typeof score !== "number" ||
        !Number.isFinite(score) ||
        score < 0 ||
        score > 1))
  ) {
    return;
  }
  return {
    result: {
      requestId,
      ...(score === undefined ? {} : { score }),
      url: url.href,
    },
    status: "found",
  };
};

const safeNow = (clock: SearchProviderClock): number => {
  const value = clock.now();
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
};

const outputFrom = (
  result: ReducedResult,
  observedAt: number,
  domain: string
): JsonRecord => {
  const url = new URL(result.url);
  const confidence =
    url.hostname === domain
      ? 1
      : Math.min(0.75, Math.max(0.2, (result.score ?? 0.25) * 0.75));
  return {
    confidence,
    freshness: { observedAt },
    provenance: { references: [result.url] },
    value: url.origin,
  };
};

const resultMatchesDomain = (
  result: ReducedResult,
  domain: string
): boolean => {
  const { hostname } = new URL(result.url);
  return hostname === domain || hostname.endsWith(`.${domain}`);
};

const isRecipeCellOutput = (candidate: unknown): candidate is JsonRecord => {
  if (
    !(
      plainRecord(candidate) &&
      hasExactKeys(candidate, [
        "confidence",
        "freshness",
        "provenance",
        "value",
      ])
    ) ||
    typeof candidate.value !== "string" ||
    typeof candidate.confidence !== "number" ||
    candidate.confidence < 0 ||
    candidate.confidence > 1 ||
    !plainRecord(candidate.freshness) ||
    !hasExactKeys(candidate.freshness, ["observedAt"]) ||
    !Number.isSafeInteger(candidate.freshness.observedAt) ||
    (candidate.freshness.observedAt as number) < 0 ||
    !plainRecord(candidate.provenance) ||
    !hasExactKeys(candidate.provenance, ["references"]) ||
    !Array.isArray(candidate.provenance.references) ||
    candidate.provenance.references.length !== 1 ||
    typeof candidate.provenance.references[0] !== "string"
  ) {
    return false;
  }
  const reference = sanitizeUrl(candidate.provenance.references[0]);
  return reference !== undefined && reference.origin === candidate.value;
};

const usage = (receiptReference?: string) => ({
  amount: 1,
  basis: "exact" as const,
  ...(receiptReference === undefined ? {} : { receiptReference }),
  unit: "requests",
});

const zeroUsage = Object.freeze({
  amount: 0,
  basis: "exact" as const,
  unit: "requests",
});

const outcomeUnknown = Object.freeze({
  error: { class: "transport", reasonCode: "transport-failed" } as const,
  status: "outcome-unknown" as const,
});

const deadlineOutcomeUnknown = Object.freeze({
  error: { class: "deadline", reasonCode: "deadline-exceeded" } as const,
  status: "outcome-unknown" as const,
});

const responseOutcomeUnknown = Object.freeze({
  error: {
    class: "response",
    reasonCode: "provider-response-invalid",
  } as const,
  status: "outcome-unknown" as const,
});

const retryAfterMs = (response: Response): number | undefined => {
  const value = response.headers.get("retry-after");
  if (value === null || !UNSIGNED_INTEGER_PATTERN.test(value)) {
    return;
  }
  const milliseconds = Number(value) * 1000;
  return Number.isSafeInteger(milliseconds) &&
    milliseconds <= MAX_RETRY_AFTER_MS
    ? milliseconds
    : undefined;
};

const definiteHttpFailure = (
  response: Response
): PluginExecuteResult | undefined => {
  const exactUsage = usage();
  if (response.status === 401) {
    return {
      error: { class: "authentication", reasonCode: "authentication-failed" },
      status: "failed",
      usage: exactUsage,
    };
  }
  if (response.status === 403) {
    return {
      error: { class: "authorization", reasonCode: "authorization-failed" },
      status: "failed",
      usage: exactUsage,
    };
  }
  if (response.status === 429) {
    const delay = retryAfterMs(response);
    return {
      error: {
        class: "rate-limit",
        reasonCode: "rate-limited",
        ...(delay === undefined ? {} : { retryAfterMs: delay }),
      },
      status: "failed",
      usage: exactUsage,
    };
  }
  if ([502, 503, 504].includes(response.status)) {
    return {
      error: { class: "provider", reasonCode: "provider-unavailable" },
      status: "failed",
      usage: exactUsage,
    };
  }
  if (response.status >= 400 && response.status < 500) {
    return {
      error: { class: "provider", reasonCode: "provider-rejected" },
      status: "failed",
      usage: exactUsage,
    };
  }
};

const classify = (
  request: PluginClassifyErrorRequest
): ReturnType<PluginAdapterV1["classifyError"]> => {
  if (request.diagnostic.kind === "timeout") {
    return { error: { class: "deadline", reasonCode: "deadline-exceeded" } };
  }
  if (request.diagnostic.kind === "transport") {
    return { error: { class: "transport", reasonCode: "transport-failed" } };
  }
  if (request.diagnostic.kind !== "http-status") {
    return { error: { class: "unknown", reasonCode: "unclassified" } };
  }
  const status = request.diagnostic.httpStatus;
  if (status === 401) {
    return {
      error: { class: "authentication", reasonCode: "authentication-failed" },
    };
  }
  if (status === 403) {
    return {
      error: { class: "authorization", reasonCode: "authorization-failed" },
    };
  }
  if (status === 429) {
    return { error: { class: "rate-limit", reasonCode: "rate-limited" } };
  }
  if ([502, 503, 504].includes(status)) {
    return {
      error: { class: "provider", reasonCode: "provider-unavailable" },
    };
  }
  if (status >= 400 && status < 500) {
    return { error: { class: "provider", reasonCode: "provider-rejected" } };
  }
  return { error: { class: "unknown", reasonCode: "unclassified" } };
};

const containsControlCharacter = (value: string): boolean =>
  Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f);
  });

const validateApiKey = (apiKey: string): string => {
  if (
    apiKey.length < 1 ||
    apiKey.length > MAX_API_KEY_LENGTH ||
    apiKey.trim() !== apiKey ||
    containsControlCharacter(apiKey)
  ) {
    throw new SearchProviderConfigurationError();
  }
  return apiKey;
};

const authorizationHeaders = (
  definition: SearchProviderDefinition,
  apiKey: string
): Record<string, string> =>
  definition.authMode === "bearer-token"
    ? { authorization: `Bearer ${apiKey}` }
    : { "x-api-key": apiKey };

const discardBody = async (response: Response): Promise<void> => {
  await response.body?.cancel().catch(() => undefined);
};

type HandleSearchResponseOptions = Readonly<{
  clock: SearchProviderClock;
  definition: SearchProviderDefinition;
  domain: string;
  response: Response;
  signal: AbortSignal;
}>;

const handleSearchResponse = async ({
  clock,
  definition,
  domain,
  response,
  signal,
}: HandleSearchResponseOptions): Promise<PluginExecuteResult> => {
  if (signal.aborted) {
    await discardBody(response);
    return deadlineOutcomeUnknown;
  }
  const definiteFailure = definiteHttpFailure(response);
  if (definiteFailure !== undefined) {
    await discardBody(response);
    return definiteFailure;
  }
  if (!response.ok) {
    await discardBody(response);
    return outcomeUnknown;
  }

  let reduced: ReducedResponse | undefined;
  try {
    const payload = await readBoundedJson(response, signal);
    reduced = reduceResponse(payload, definition.requestIdKey);
  } catch {
    return signal.aborted ? deadlineOutcomeUnknown : responseOutcomeUnknown;
  }
  if (signal.aborted) {
    return deadlineOutcomeUnknown;
  }
  if (reduced === undefined) {
    return responseOutcomeUnknown;
  }
  if (reduced.status === "not-found") {
    return {
      error: { class: "provider", reasonCode: "provider-unavailable" },
      status: "failed",
      usage: usage(reduced.requestId),
    };
  }
  if (!resultMatchesDomain(reduced.result, domain)) {
    return {
      error: { class: "provider", reasonCode: "provider-unavailable" },
      status: "failed",
      usage: usage(reduced.result.requestId),
    };
  }
  const observedAt = safeNow(clock);
  return {
    externalOperationReference: reduced.result.requestId,
    providerPayload: outputFrom(reduced.result, observedAt, domain),
    status: "succeeded",
    usage: usage(reduced.result.requestId),
  };
};

type ExecuteSearchOptions = Readonly<{
  apiKey: string;
  clock: SearchProviderClock;
  definition: SearchProviderDefinition;
  fetchImplementation: typeof fetch;
  request: PluginExecuteRequest;
}>;

const executeSearch = async ({
  apiKey,
  clock,
  definition,
  fetchImplementation,
  request,
}: ExecuteSearchOptions): Promise<PluginExecuteResult> => {
  const domain = extractDomain(request.input.value);
  if (domain === undefined) {
    return {
      error: { class: "input", reasonCode: "input-invalid" },
      status: "failed",
      usage: zeroUsage,
    };
  }
  const now = safeNow(clock);
  const deadlineAtMs = Math.min(
    request.context.deadlineAtMs,
    request.quote.expiresAtMs,
    now + EXECUTE_TIMEOUT_MS
  );
  const availableMs = deadlineAtMs - now;
  if (availableMs <= 0) {
    return {
      error: { class: "deadline", reasonCode: "deadline-exceeded" },
      status: "failed",
      usage: zeroUsage,
    };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), availableMs);
  try {
    let response: Response;
    try {
      response = await fetchImplementation(definition.endpoint, {
        body: JSON.stringify(definition.request(domain)),
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          ...authorizationHeaders(definition, apiKey),
        },
        method: "POST",
        redirect: "error",
        signal: controller.signal,
      });
    } catch {
      return controller.signal.aborted
        ? deadlineOutcomeUnknown
        : outcomeUnknown;
    }
    return await handleSearchResponse({
      clock,
      definition,
      domain,
      response,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
};

export const createSearchProviderAdapter = (
  definition: SearchProviderDefinition,
  options: SearchProviderOptions
): PluginAdapterV1 => {
  const apiKey = validateApiKey(options.apiKey);
  const fetchImplementation = options.fetch ?? globalThis.fetch;
  const clock = options.clock ?? { now: Date.now };
  const endpoint = new URL(definition.endpoint);
  if (
    endpoint.protocol !== "https:" ||
    endpoint.hostname !== definition.hostname ||
    endpoint.username !== "" ||
    endpoint.password !== "" ||
    endpoint.port !== ""
  ) {
    throw new SearchProviderConfigurationError();
  }

  const manifest = {
    apiVersion: "dev.kurobara.plugin/v1",
    auth: { modes: [definition.authMode] },
    capabilities: [
      {
        ...SEARCH_CAPABILITY,
        inputContract: SEARCH_CONTRACTS.input,
        outputContract: SEARCH_CONTRACTS.output,
      },
    ],
    economics: {
      estimateGuarantee: "hard",
      unit: "requests",
      usageReporting: "exact",
    },
    execution: {
      idempotency: { keyScope: "operation", mode: "none" },
      lookup: { authoritativeNotFound: false, mode: "none" },
      timeouts: {
        executeMs: EXECUTE_TIMEOUT_MS,
        lookupMs: LOOKUP_TIMEOUT_MS,
      },
    },
    id: definition.pluginId,
    permissions: {
      egress: { hosts: [definition.hostname], tlsRequired: true },
    },
    version: "1.0.0",
  } as const satisfies PluginManifestV1;

  return definePluginAdapter({
    classifyError: classify,
    describe: () => ({ manifest }),
    estimate: (request) => {
      if (extractDomain(request.input.value) === undefined) {
        return {
          error: { class: "input", reasonCode: "input-invalid" },
          status: "unavailable",
        };
      }
      return {
        quote: {
          expiresAtMs: request.context.deadlineAtMs,
          guarantee: "hard",
          pricingVersion: "1.0.0",
          unit: "requests",
          upperBound: 1,
        },
        status: "quoted",
      };
    },
    execute: (request) =>
      executeSearch({
        apiKey,
        clock,
        definition,
        fetchImplementation,
        request,
      }),
    health: (request) => {
      const observedAtMs = safeNow(clock);
      return {
        observedAtMs,
        status: "healthy",
        validUntilMs: Math.max(
          observedAtMs,
          Math.min(request.context.deadlineAtMs, observedAtMs + 30_000)
        ),
      };
    },
    lookup: () => ({
      error: { class: "unknown", reasonCode: "unclassified" },
      status: "outcome-unknown",
    }),
    normalize: (request): PluginNormalizeResult => {
      const payload = validatePluginJson(request.providerPayload);
      if (!(payload.ok && isRecipeCellOutput(payload.value))) {
        return {
          error: {
            class: "response",
            reasonCode: "provider-response-invalid",
          },
          status: "failed",
        };
      }
      return {
        normalizerVersion: "1.0.0",
        output: payload.value,
        status: "normalized",
      };
    },
    validateConfig: (request) => {
      if (
        !(
          plainRecord(request.configuration.value) &&
          hasExactKeys(request.configuration.value, [])
        )
      ) {
        return {
          reasonCodes: ["configuration-unknown-field"],
          status: "invalid",
        };
      }
      return {
        configurationFingerprint: request.configuration.contentHash,
        status: "valid",
      };
    },
  });
};
