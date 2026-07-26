import { spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, mkdir, mkdtemp, open, readFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPOSITORY_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);
const EXPECTED_NODE_VERSION = "24.14.0";
const EXPECTED_NPM_VERSION = "10.9.4";
const MAX_CAPTURE_BYTES = 1024 * 1024;
const MAX_ENV_FILE_BYTES = 64 * 1024;
const ENV_LITERAL_FORBIDDEN_PATTERN = /[\s`]/u;
const NEWLINE_PATTERN = /\r?\n/u;
const PROVIDER_VARIABLES = Object.freeze([
  "EXA_API_KEY",
  "KUROBARA_EXA_DATA_RIGHTS_CONFIRMED",
  "TAVILY_API_KEY",
]);
const LIVE_PROVIDER_CALL_LIMITS = Object.freeze({ exa: 2, tavily: 1 });
const PROVIDER_CALL_KEYS = Object.freeze({
  exa: Object.freeze({
    attempted: "exa_attempted_requests_upper_bound",
    confirmed: "exa_confirmed_requests",
    maximum: "exa_max_requests",
  }),
  tavily: Object.freeze({
    attempted: "tavily_attempted_requests_upper_bound",
    confirmed: "tavily_confirmed_requests",
    maximum: "tavily_max_requests",
  }),
});
const LIVE_ROUTING_PROOF_KEYS = Object.freeze([
  "attempt_count",
  "attempt_numbers",
  "attempt_reasons",
  "attempt_states",
  "effect_thresholds_started",
  "exact_usage_settled",
  "kind",
  "operation_key_reused",
  "provider_order",
  "routing_provenance_complete",
  "target_run_count",
]);
const LIVE_ROUTING_PROOF_SQL = `
WITH target_runs AS (
  SELECT DISTINCT cell.workspace_id, cell.run_id
  FROM kurobara_core.cell_results AS cell
  JOIN kurobara_core.recipe_application_cells AS binding
    ON binding.workspace_id = cell.workspace_id
   AND binding.recipe_application_id = cell.recipe_application_id
   AND binding.cell_result_id = cell.cell_result_id
  WHERE cell.workspace_id = 'workspace_demo'
    AND cell.recipe_application_id = 'application_demo_org_website_v1'
    AND binding.binding = 'executed'
),
attempt_rows AS (
  SELECT
    attempt.attempt_number,
    attempt.operation_key,
    attempt.effect_adapter_key,
    attempt.state,
    attempt.attempt ->> 'reason' AS reason,
    EXISTS (
      SELECT 1
      FROM kurobara_core.step_events AS event
      WHERE event.workspace_id = attempt.workspace_id
        AND event.step_run_id = attempt.step_run_id
        AND event.event ->> 'eventType' = 'AttemptEffectStarted'
        AND event.event ->> 'attemptId' = attempt.attempt_id
    ) AS effect_started,
    EXISTS (
      SELECT 1
      FROM kurobara_core.usage_ledger_entries AS usage
      JOIN kurobara_core.cost_reservations AS reservation
        ON reservation.workspace_id = usage.workspace_id
       AND reservation.reservation_id = usage.reservation_id
       AND reservation.attempt_id = usage.attempt_id
      WHERE usage.workspace_id = attempt.workspace_id
        AND usage.run_id = target.run_id
        AND usage.attempt_id = attempt.attempt_id
        AND usage.reservation_id = attempt.reservation_id
        AND usage.operation_key = attempt.operation_key
        AND usage.unit = 'requests'
        AND usage.amount = 1
        AND reservation.operation_key = attempt.operation_key
        AND reservation.state = 'settled'
    ) AS exact_usage,
    EXISTS (
      SELECT 1
      FROM kurobara_core.routing_decisions AS decision
      WHERE decision.workspace_id = attempt.workspace_id
        AND decision.run_id = target.run_id
        AND decision.step_run_id = attempt.step_run_id
        AND decision.routing_decision_id = attempt.routing_decision_id
        AND decision.route_key = attempt.route_key
        AND decision.effect_adapter_key = attempt.effect_adapter_key
        AND decision.route_snapshot_hash = attempt.route_snapshot_hash
    ) AS routing_provenance
  FROM target_runs AS target
  JOIN kurobara_core.step_runs AS step
    ON step.workspace_id = target.workspace_id
   AND step.run_id = target.run_id
  JOIN kurobara_core.step_attempts AS attempt
    ON attempt.workspace_id = step.workspace_id
   AND attempt.step_run_id = step.step_run_id
)
SELECT jsonb_build_object(
  'kind', 'durable-live-worker-routing',
  'target_run_count', (SELECT count(*) FROM target_runs),
  'attempt_count', count(*),
  'attempt_numbers',
    COALESCE(jsonb_agg(attempt_number ORDER BY attempt_number), '[]'::jsonb),
  'provider_order',
    COALESCE(jsonb_agg(effect_adapter_key ORDER BY attempt_number), '[]'::jsonb),
  'attempt_reasons',
    COALESCE(jsonb_agg(reason ORDER BY attempt_number), '[]'::jsonb),
  'attempt_states',
    COALESCE(jsonb_agg(state ORDER BY attempt_number), '[]'::jsonb),
  'operation_key_reused',
    count(*) = 2 AND count(DISTINCT operation_key) = 1,
  'effect_thresholds_started', COALESCE(bool_and(effect_started), false),
  'exact_usage_settled', COALESCE(bool_and(exact_usage), false),
  'routing_provenance_complete',
    COALESCE(bool_and(routing_provenance), false)
)
FROM attempt_rows;
`;

const BOOLEAN_OPTIONS = Object.freeze({
  "--confirm-provider-calls": "confirmProviderCalls",
  "--keep-infrastructure": "keepInfrastructure",
  "--require-clean": "requireClean",
});
const VALUE_OPTIONS = new Set(["--mode", "--provider-env-file", "--report"]);

export class V1GateError extends Error {
  constructor(code, message, options) {
    super(message, options);
    this.code = code;
    this.name = "V1GateError";
  }
}

export const createProviderCallAccounting = () => ({
  exa_attempted_requests_upper_bound: 0,
  exa_confirmed_requests: 0,
  exa_max_requests: 0,
  tavily_attempted_requests_upper_bound: 0,
  tavily_confirmed_requests: 0,
  tavily_max_requests: 0,
});

const providerCallKeys = (provider) => {
  const keys = PROVIDER_CALL_KEYS[provider];
  if (keys === undefined) {
    throw new V1GateError(
      "provider-call-accounting-invalid",
      "Provider call accounting accepts only exa or tavily."
    );
  }
  return keys;
};

const assertProviderCallIncrement = (count) => {
  if (!(Number.isSafeInteger(count) && count > 0)) {
    throw new V1GateError(
      "provider-call-accounting-invalid",
      "Provider call accounting increments must be positive safe integers."
    );
  }
};

export const authorizeLiveProviderCalls = (accounting) => {
  accounting.exa_max_requests = LIVE_PROVIDER_CALL_LIMITS.exa;
  accounting.tavily_max_requests = LIVE_PROVIDER_CALL_LIMITS.tavily;
  return accounting;
};

export const recordPossibleProviderCalls = (
  accounting,
  provider,
  count = 1
) => {
  assertProviderCallIncrement(count);
  const keys = providerCallKeys(provider);
  const next = accounting[keys.attempted] + count;
  if (next > accounting[keys.maximum]) {
    throw new V1GateError(
      "provider-call-accounting-invalid",
      "A possible provider call exceeded its authorized upper bound."
    );
  }
  accounting[keys.attempted] = next;
  return accounting;
};

export const confirmProviderCalls = (accounting, provider, count = 1) => {
  assertProviderCallIncrement(count);
  const keys = providerCallKeys(provider);
  const next = accounting[keys.confirmed] + count;
  if (next > accounting[keys.attempted]) {
    throw new V1GateError(
      "provider-call-accounting-invalid",
      "Confirmed provider calls cannot exceed the possible-attempt upper bound."
    );
  }
  accounting[keys.confirmed] = next;
  return accounting;
};

const exactStringArray = (value, expected) =>
  Array.isArray(value) &&
  value.length === expected.length &&
  value.every((item, index) => item === expected[index]);

export const assertLiveRoutingProof = (proof) => {
  const keys =
    proof !== null && typeof proof === "object" && !Array.isArray(proof)
      ? Object.keys(proof).sort()
      : [];
  if (
    !exactStringArray(keys, LIVE_ROUTING_PROOF_KEYS) ||
    proof.kind !== "durable-live-worker-routing" ||
    proof.target_run_count !== 1 ||
    proof.attempt_count !== 2 ||
    !exactStringArray(proof.attempt_numbers, [1, 2]) ||
    !exactStringArray(proof.provider_order, ["tavily-search", "exa-search"]) ||
    !exactStringArray(proof.attempt_reasons, ["initial", "fallback"]) ||
    !exactStringArray(proof.attempt_states, [
      "failed_retryable",
      "succeeded",
    ]) ||
    proof.operation_key_reused !== true ||
    proof.effect_thresholds_started !== true ||
    proof.exact_usage_settled !== true ||
    proof.routing_provenance_complete !== true
  ) {
    throw new V1GateError(
      "live-fallback-proof-invalid",
      "The durable live worker routing proof did not show an exact Tavily-to-Exa fallback."
    );
  }
  return proof;
};

const usage = () =>
  [
    "Usage: node scripts/v1-gate.mjs --mode fixture|live [options]",
    "  --provider-env-file PATH   strict local BYOK file (live only; default .env.local)",
    "  --confirm-provider-calls   acknowledge the bounded live Tavily/Exa calls",
    "  --report PATH              create a private redacted JSON report without overwrite",
    "  --require-clean            fail unless the Git worktree is clean",
    "  --keep-infrastructure      retain the isolated live Compose project and state directory",
  ].join("\n");

const defaultArguments = () => ({
  confirmProviderCalls: false,
  keepInfrastructure: false,
  mode: "fixture",
  providerEnvFile: path.join(REPOSITORY_ROOT, ".env.local"),
  reportPath: undefined,
  requireClean: false,
});

const assertOptionNotSeen = (seen, argument) => {
  if (seen.has(argument)) {
    throw new V1GateError("usage-invalid", `Duplicate option: ${argument}.`);
  }
  seen.add(argument);
};

const applyValueOption = (parsed, argument, value) => {
  if (argument === "--mode") {
    if (value !== "fixture" && value !== "live") {
      throw new V1GateError("usage-invalid", "--mode must be fixture or live.");
    }
    parsed.mode = value;
    return;
  }
  if (argument === "--provider-env-file") {
    parsed.providerEnvFile = path.resolve(value);
    return;
  }
  parsed.reportPath = path.resolve(value);
};

const validateModeOptions = (parsed, seen) => {
  if (parsed.mode === "fixture" && seen.has("--provider-env-file")) {
    throw new V1GateError(
      "usage-invalid",
      "--provider-env-file is accepted only in live mode."
    );
  }
  if (parsed.mode === "fixture" && parsed.confirmProviderCalls) {
    throw new V1GateError(
      "usage-invalid",
      "--confirm-provider-calls is accepted only in live mode."
    );
  }
  if (parsed.mode === "fixture" && parsed.keepInfrastructure) {
    throw new V1GateError(
      "usage-invalid",
      "--keep-infrastructure is accepted only in live mode."
    );
  }
};

export const parseArguments = (arguments_) => {
  const parsed = defaultArguments();
  const seen = new Set();
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--help") {
      return { help: true };
    }
    const booleanProperty = BOOLEAN_OPTIONS[argument];
    if (booleanProperty !== undefined) {
      assertOptionNotSeen(seen, argument);
      parsed[booleanProperty] = true;
      continue;
    }
    if (!VALUE_OPTIONS.has(argument)) {
      throw new V1GateError(
        "usage-invalid",
        `Unknown option: ${argument ?? ""}.`
      );
    }
    assertOptionNotSeen(seen, argument);
    const value = arguments_[index + 1];
    if (value === undefined || value.length === 0 || value.startsWith("--")) {
      throw new V1GateError("usage-invalid", `${argument} requires a value.`);
    }
    index += 1;
    applyValueOption(parsed, argument, value);
  }
  validateModeOptions(parsed, seen);
  return parsed;
};

const strictLine = /^(?:export[ \t]+)?([A-Z][A-Z0-9_]*)=(.*)$/u;

export const parseProviderEnvironment = (source) => {
  const environment = {};
  for (const [zeroBasedIndex, sourceLine] of source
    .split(NEWLINE_PATTERN)
    .entries()) {
    const line = sourceLine;
    if (line.trim().length === 0 || line.trimStart().startsWith("#")) {
      continue;
    }
    const match = strictLine.exec(line);
    if (match === null) {
      throw new V1GateError(
        "provider-env-invalid",
        `Provider environment line ${zeroBasedIndex + 1} is invalid.`
      );
    }
    const [, name, rawValue] = match;
    if (!PROVIDER_VARIABLES.includes(name)) {
      continue;
    }
    if (Object.hasOwn(environment, name)) {
      throw new V1GateError(
        "provider-env-invalid",
        `Provider environment variable ${name} is duplicated.`
      );
    }
    if (
      rawValue.length === 0 ||
      rawValue.trim() !== rawValue ||
      rawValue.startsWith('"') ||
      rawValue.startsWith("'") ||
      ENV_LITERAL_FORBIDDEN_PATTERN.test(rawValue)
    ) {
      throw new V1GateError(
        "provider-env-invalid",
        `${name} must be an unquoted, non-empty literal without whitespace or shell expansion.`
      );
    }
    environment[name] = rawValue;
  }
  return Object.freeze(environment);
};

export const assertExaDataRightsAttestation = (environment) => {
  if (environment.KUROBARA_EXA_DATA_RIGHTS_CONFIRMED !== "true") {
    throw new V1GateError(
      "exa-data-rights-attestation-required",
      "Live mode requires KUROBARA_EXA_DATA_RIGHTS_CONFIRMED=true after written Exa terms cover this use."
    );
  }
};

export const redactText = (text, secrets = []) => {
  let redacted = String(text);
  for (const secret of [...secrets].sort(
    (left, right) => right.length - left.length
  )) {
    if (secret.length > 0) {
      redacted = redacted.split(secret).join("[REDACTED]");
    }
  }
  return redacted
    .replace(/("presented_key"\s*:\s*")[^"]+("?)/giu, "$1[REDACTED]$2")
    .replace(/(authorization:\s*bearer\s+)[^\s]+/giu, "$1[REDACTED]")
    .replace(/(postgres(?:ql)?:\/\/[^:\s/]+:)[^@\s]+@/giu, "$1[REDACTED]@");
};

const baseEnvironment = () =>
  Object.freeze({
    COREPACK_ENABLE_DOWNLOAD_PROMPT: "0",
    HOME: process.env.HOME ?? "",
    LANG: process.env.LANG ?? "C.UTF-8",
    NODE_OPTIONS: "",
    npm_config_audit: "false",
    npm_config_fund: "false",
    npm_config_update_notifier: "false",
    PATH: process.env.PATH ?? "",
    TMPDIR: process.env.TMPDIR ?? tmpdir(),
  });

const capture = (stream, state) => {
  stream?.on("data", (chunk) => {
    if (state.bytes >= MAX_CAPTURE_BYTES) {
      return;
    }
    const buffer = Buffer.from(chunk);
    const available = MAX_CAPTURE_BYTES - state.bytes;
    state.chunks.push(buffer.subarray(0, available));
    state.bytes += Math.min(buffer.byteLength, available);
  });
};

const runCommand = (command, arguments_, options = {}) =>
  new Promise((resolve, reject) => {
    const stdout = { bytes: 0, chunks: [] };
    const stderr = { bytes: 0, chunks: [] };
    const child = spawn(command, arguments_, {
      cwd: options.cwd ?? REPOSITORY_ROOT,
      env: options.environment ?? baseEnvironment(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    capture(child.stdout, stdout);
    capture(child.stderr, stderr);
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, options.timeoutMs ?? 300_000);
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("close", (code, signal) => {
      clearTimeout(timeout);
      const result = {
        code,
        signal,
        stderr: Buffer.concat(stderr.chunks).toString("utf8"),
        stdout: Buffer.concat(stdout.chunks).toString("utf8"),
        timedOut,
      };
      if (code === 0 && !timedOut) {
        resolve(result);
        return;
      }
      const diagnosticLines = redactText(
        result.stderr || result.stdout,
        options.secrets
      )
        .trim()
        .split(NEWLINE_PATTERN)
        .filter((line) => line.length > 0);
      const diagnostic = options.sensitiveOutput
        ? "diagnostic withheld because the command handled credentials or provider data"
        : [...diagnosticLines.slice(0, 12), ...diagnosticLines.slice(-5)].join(
            " | "
          );
      reject(
        new V1GateError(
          timedOut ? "command-timeout" : "command-failed",
          `${options.label ?? command} failed (${timedOut ? "timeout" : `exit ${code ?? signal ?? "unknown"}`}): ${diagnostic || "no diagnostic"}.`
        )
      );
    });
  });

const jsonOutput = (result, label) => {
  try {
    return JSON.parse(result.stdout.trim());
  } catch (error) {
    throw new V1GateError(
      "output-contract-invalid",
      `${label} did not return exactly one JSON value.`,
      { cause: error }
    );
  }
};

const hasExactObjectKeys = (value, expectedKeys) =>
  value !== null &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.keys(value).sort().join(",") === [...expectedKeys].sort().join(",");

const assertControlledFallbackProof = (condition) => {
  if (!condition) {
    throw new V1GateError(
      "fallback-proof-invalid",
      "The controlled provider fallback proof did not satisfy its strict output contract."
    );
  }
};

const validateControlledFallbackProof = (proof) => {
  assertControlledFallbackProof(
    hasExactObjectKeys(proof, [
      "components",
      "kind",
      "operation_key_reused",
      "primary",
      "provider_order",
      "secondary",
      "simulated_requests",
    ])
  );
  assertControlledFallbackProof(
    hasExactObjectKeys(proof.primary, [
      "outcome",
      "provider",
      "reason",
      "retryable",
      "settlement",
    ])
  );
  assertControlledFallbackProof(
    hasExactObjectKeys(proof.simulated_requests, ["exa", "tavily"])
  );
  assertControlledFallbackProof(
    hasExactObjectKeys(proof.secondary, [
      "normalized_origin",
      "outcome",
      "provider",
      "settlement",
    ])
  );
  assertControlledFallbackProof(
    proof.kind === "controlled-component-no-network"
  );
  assertControlledFallbackProof(proof.operation_key_reused === true);
  assertControlledFallbackProof(
    Array.isArray(proof.components) &&
      proof.components.join(",") ===
        "official-provider-registry,official-provider-adapters,trusted-plugin-bridge"
  );
  assertControlledFallbackProof(proof.primary.provider === "tavily-search");
  assertControlledFallbackProof(proof.primary.outcome === "failed");
  assertControlledFallbackProof(proof.primary.reason === "plugin-rate-limited");
  assertControlledFallbackProof(proof.primary.retryable === true);
  assertControlledFallbackProof(
    proof.primary.settlement === "settle-exactly-one-request"
  );
  assertControlledFallbackProof(proof.secondary.provider === "exa-search");
  assertControlledFallbackProof(proof.secondary.outcome === "succeeded");
  assertControlledFallbackProof(
    proof.secondary.settlement === "settle-exactly-one-request"
  );
  assertControlledFallbackProof(
    proof.secondary.normalized_origin === "https://example.com"
  );
  assertControlledFallbackProof(
    proof.simulated_requests.tavily === 1 && proof.simulated_requests.exa === 1
  );
  assertControlledFallbackProof(
    Array.isArray(proof.provider_order) &&
      proof.provider_order.join(",") === "tavily-search,exa-search"
  );
  return proof;
};

const sha256 = (bytes) =>
  `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

const readJson = async (relativePath) =>
  JSON.parse(await readFile(path.join(REPOSITORY_ROOT, relativePath), "utf8"));

export const verifyTrackedFixtures = async () => {
  const catalog = await readJson(
    "packages/contracts/catalog/generated/catalog-manifest.json"
  );
  const bundle = await readJson("examples/planning-bundle.v1.json");
  const recipeRequest = await readJson(
    "examples/recipe-apply/request.example.json"
  );
  const metadata = await readJson("examples/dataset-import/metadata.json");
  const source = await readFile(
    path.join(REPOSITORY_ROOT, "examples/dataset-import/source.jsonl")
  );
  const workflow = bundle.planning?.workflows?.[0];
  const authority = bundle.planning?.authorities?.[0];
  const outputMember = catalog.members?.find(
    (member) =>
      member.id ===
      "https://schemas.kurobara.invalid/schemas/recipes/cell-output/1.0.0"
  );
  const inputMember = catalog.members?.find(
    (member) =>
      member.id ===
      "https://schemas.kurobara.invalid/schemas/recipes/cell-input/1.0.0"
  );
  if (
    workflow === undefined ||
    authority === undefined ||
    outputMember === undefined ||
    inputMember === undefined
  ) {
    throw new V1GateError(
      "fixture-drift",
      "The V1 planning bundle or generated cell contracts are unavailable."
    );
  }
  const contracts = [workflow.inputContract, workflow.outputContract];
  if (
    workflow.catalogVersion !== catalog.catalog_version ||
    workflow.catalogFingerprint !== catalog.catalog_fingerprint ||
    contracts.some(
      (contract) =>
        contract.catalogVersion !== catalog.catalog_version ||
        contract.catalogFingerprint !== catalog.catalog_fingerprint
    ) ||
    workflow.inputContract.schemaFingerprint !== inputMember.fingerprint ||
    workflow.outputContract.schemaFingerprint !== outputMember.fingerprint
  ) {
    throw new V1GateError(
      "fixture-drift",
      "The V1 planning bundle does not reference the exact generated catalog and cell contracts."
    );
  }
  if (
    authority.budgetLimit?.unit !== "requests" ||
    workflow.allowedCapabilities?.[0] !== "organizations.website.resolve" ||
    workflow.workflow?.nodes?.[0]?.capability?.capabilityId !==
      "organizations.website.resolve" ||
    recipeRequest.authority_envelope_id !== authority.authorityEnvelopeId ||
    recipeRequest.cell_budget?.unit !== "requests" ||
    recipeRequest.recipe?.workflow_content_hash !==
      workflow.workflow?.contentHash
  ) {
    throw new V1GateError(
      "fixture-drift",
      "The V1 examples are not aligned with the provider-neutral website resolution workflow."
    );
  }
  if (metadata.source_content_hash !== sha256(source)) {
    throw new V1GateError(
      "fixture-drift",
      "The dataset fixture content hash does not match its tracked source bytes."
    );
  }
  const lines = source.toString("utf8").trim().split("\n");
  if (lines.length !== 1 || !lines[0]?.includes('"value":"example.com"')) {
    throw new V1GateError(
      "fixture-drift",
      "The V1 provider probe dataset must contain only the public synthetic example.com input."
    );
  }
  return {
    catalog_fingerprint: catalog.catalog_fingerprint,
    catalog_version: catalog.catalog_version,
    dataset_source_sha256: metadata.source_content_hash,
  };
};

const step = async (report, name, operation) => {
  const startedAt = Date.now();
  try {
    const details = await operation();
    report.steps.push({
      duration_ms: Date.now() - startedAt,
      name,
      status: "passed",
      ...(details === undefined ? {} : { details }),
    });
    return details;
  } catch (error) {
    report.steps.push({
      duration_ms: Date.now() - startedAt,
      name,
      reason_code:
        error instanceof V1GateError ? error.code : "unexpected-error",
      status: "failed",
    });
    throw error;
  }
};

const skipStep = (report, name, reasonCode) => {
  report.steps.push({
    duration_ms: 0,
    name,
    reason_code: reasonCode,
    status: "not-applicable",
  });
};

const localChecks = async (report, options) => {
  await step(report, "runtime.version", async () => {
    if (process.versions.node !== EXPECTED_NODE_VERSION) {
      throw new V1GateError(
        "node-version-mismatch",
        `Node ${EXPECTED_NODE_VERSION} is required; observed ${process.versions.node}.`
      );
    }
    const npm = await runCommand("npm", ["--version"], {
      label: "npm version check",
      timeoutMs: 30_000,
    });
    if (npm.stdout.trim() !== EXPECTED_NPM_VERSION) {
      throw new V1GateError(
        "npm-version-mismatch",
        `npm ${EXPECTED_NPM_VERSION} is required; observed ${npm.stdout.trim() || "unknown"}.`
      );
    }
    return { node: process.versions.node, npm: npm.stdout.trim() };
  });
  await step(report, "git.snapshot", async () => {
    const revision = await runCommand("git", ["rev-parse", "HEAD"], {
      label: "Git revision readback",
      timeoutMs: 30_000,
    });
    const status = await runCommand("git", ["status", "--porcelain=v1"], {
      label: "Git status readback",
      timeoutMs: 30_000,
    });
    if (options.requireClean && status.stdout.length > 0) {
      throw new V1GateError(
        "worktree-not-clean",
        "--require-clean requires a clean tracked and untracked worktree."
      );
    }
    return {
      clean: status.stdout.length === 0,
      revision: revision.stdout.trim(),
    };
  });
  await step(report, "fixtures.integrity", verifyTrackedFixtures);
  await step(report, "planning.check", async () => {
    await runCommand(
      "npm",
      [
        "run",
        "--silent",
        "bootstrap:planning",
        "-w",
        "@kurobara/api",
        "--",
        "--check",
        "--file",
        path.join(REPOSITORY_ROOT, "examples/planning-bundle.v1.json"),
      ],
      { label: "planning manifest dry-run" }
    );
    return { mutation: false };
  });
  const fallbackProof = await step(
    report,
    "providers.fallback-controlled",
    async () => {
      const proofCommand = await runCommand(
        process.execPath,
        [
          "--conditions=kurobara-source",
          "--experimental-strip-types",
          "test/v1-gate/provider-fallback-proof.mjs",
        ],
        {
          label: "controlled provider fallback proof",
          timeoutMs: 30_000,
        }
      );
      return validateControlledFallbackProof(
        jsonOutput(proofCommand, "controlled provider fallback proof")
      );
    }
  );
  report.proofs.fallback = fallbackProof;
  const qualityFailures = [];
  const runQualityStep = async (name, npmArguments) => {
    try {
      await step(report, name, async () => {
        await runCommand("npm", npmArguments, {
          label: name,
          timeoutMs: 900_000,
        });
        return { command: `npm ${npmArguments.join(" ")}` };
      });
    } catch (error) {
      qualityFailures.push({ error, name });
    }
  };
  await runQualityStep("quality.check", ["run", "check"]);
  await runQualityStep("quality.typecheck", ["run", "typecheck"]);
  await runQualityStep("quality.test", ["test"]);
  await runQualityStep("quality.build", ["run", "build"]);
  if (qualityFailures.length > 0) {
    throw new V1GateError(
      "quality-gate-failed",
      `The candidate failed required quality steps: ${qualityFailures.map(({ name }) => name).join(", ")}.`,
      {
        cause: new AggregateError(
          qualityFailures.map(({ error }) => error),
          "Required V1 quality steps failed."
        ),
      }
    );
  }
};

const freePort = () =>
  new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close();
        reject(
          new V1GateError(
            "port-allocation-failed",
            "A loopback port could not be allocated."
          )
        );
        return;
      }
      const { port } = address;
      server.close((error) =>
        error === undefined ? resolve(port) : reject(error)
      );
    });
  });

const readProviderEnvironmentFile = async (filePath) => {
  const handle = await open(
    filePath,
    // biome-ignore lint/suspicious/noBitwiseOperators: O_NOFOLLOW must be combined with the read-only POSIX flag.
    constants.O_RDONLY | constants.O_NOFOLLOW
  ).catch(() => {
    throw new V1GateError(
      "provider-env-unavailable",
      "The live provider environment file is unavailable or is a symlink."
    );
  });
  try {
    const details = await handle.stat();
    if (
      !details.isFile() ||
      details.size > MAX_ENV_FILE_BYTES ||
      details.mode % 64 !== 0
    ) {
      throw new V1GateError(
        "provider-env-permissions",
        "The live provider environment file must be a private regular file no larger than 64 KiB."
      );
    }
    return parseProviderEnvironment(await handle.readFile("utf8"));
  } finally {
    await handle.close();
  }
};

const composeArguments = (state, tail) => [
  "compose",
  "--env-file",
  state.composeEnvFile,
  "--file",
  path.join(REPOSITORY_ROOT, "infra/hatchet/compose.yaml"),
  "--project-directory",
  REPOSITORY_ROOT,
  "--project-name",
  state.composeProject,
  ...tail,
];

const readDurableLiveRoutingProof = async (state) => {
  const result = await runCommand(
    "docker",
    composeArguments(state, [
      "exec",
      "-T",
      "kurobara-postgres",
      "psql",
      "--no-psqlrc",
      "--set=ON_ERROR_STOP=1",
      "--username=kurobara",
      "--dbname=kurobara",
      "--tuples-only",
      "--no-align",
      "--quiet",
      "--command",
      LIVE_ROUTING_PROOF_SQL,
    ]),
    {
      label: "durable live provider routing readback",
      sensitiveOutput: true,
      timeoutMs: 30_000,
    }
  );
  return assertLiveRoutingProof(
    jsonOutput(result, "durable live provider routing readback")
  );
};

const startService = (entry, command, arguments_, environment, secrets) => {
  const stdout = { bytes: 0, chunks: [] };
  const stderr = { bytes: 0, chunks: [] };
  const child = spawn(command, arguments_, {
    cwd: REPOSITORY_ROOT,
    detached: true,
    env: environment,
    stdio: ["ignore", "pipe", "pipe"],
  });
  capture(child.stdout, stdout);
  capture(child.stderr, stderr);
  child.once("error", (error) => {
    entry.spawnError = error;
  });
  entry.child = child;
  entry.output = () =>
    redactText(
      `${Buffer.concat(stdout.chunks).toString("utf8")}\n${Buffer.concat(stderr.chunks).toString("utf8")}`,
      secrets
    );
  return child;
};

const assertServiceAlive = async (entry, label) => {
  await new Promise((resolve) => setTimeout(resolve, 1500));
  if (
    entry.spawnError !== undefined ||
    entry.child?.exitCode !== null ||
    entry.child?.signalCode !== null
  ) {
    throw new V1GateError(
      "service-start-failed",
      `${label} exited before readiness; diagnostics are withheld from the report.`
    );
  }
};

const stopService = async (entry) => {
  const { child } = entry;
  if (
    child === undefined ||
    child.exitCode !== null ||
    child.signalCode !== null
  ) {
    return;
  }
  const signal = (value) => {
    try {
      if (child.pid === undefined) {
        child.kill(value);
      } else {
        process.kill(-child.pid, value);
      }
    } catch {
      child.kill(value);
    }
  };
  signal("SIGTERM");
  await Promise.race([
    new Promise((resolve) => child.once("close", resolve)),
    new Promise((resolve) => setTimeout(resolve, 15_000)),
  ]);
  if (child.exitCode === null && child.signalCode === null) {
    signal("SIGKILL");
    await new Promise((resolve) => child.once("close", resolve));
  }
};

const waitForReadiness = async (url, serviceEntry) => {
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    if (
      serviceEntry.spawnError !== undefined ||
      serviceEntry.child?.exitCode !== null ||
      serviceEntry.child?.signalCode !== null
    ) {
      throw new V1GateError(
        "api-start-failed",
        "The API exited before readiness; diagnostics are withheld from the report."
      );
    }
    try {
      const response = await fetch(`${url}/readyz`, {
        redirect: "error",
        signal: AbortSignal.timeout(2000),
      });
      if (response.status === 200) {
        return;
      }
    } catch {
      // The bounded readiness loop owns retries before any provider effect.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new V1GateError(
    "api-readiness-timeout",
    "The API did not become ready within 45 seconds."
  );
};

const requestJson = async (url, apiKey, options = {}) => {
  const response = await fetch(url, {
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    headers: {
      authorization: `Bearer ${apiKey}`,
      ...(options.body === undefined
        ? {}
        : { "content-type": "application/json" }),
    },
    method: options.method ?? "GET",
    redirect: "error",
    signal: AbortSignal.timeout(options.timeoutMs ?? 15_000),
  });
  const text = await response.text();
  let body;
  try {
    body = text.length === 0 ? null : JSON.parse(text);
  } catch (error) {
    throw new V1GateError(
      "http-output-invalid",
      `HTTP ${response.status} did not return a JSON document.`,
      { cause: error }
    );
  }
  return { body, status: response.status };
};

const assertHttpSuccess = (response, label) => {
  if (response.status < 200 || response.status >= 300) {
    const reason =
      typeof response.body?.code === "string"
        ? response.body.code
        : `http-${response.status}`;
    throw new V1GateError(
      "http-operation-failed",
      `${label} failed with ${reason}.`
    );
  }
  return response.body;
};

const runCli = async (arguments_, environment, label) => {
  const result = await runCommand(
    "npm",
    ["run", "--silent", "kurobara", "--", ...arguments_],
    { environment, label, sensitiveOutput: true, timeoutMs: 180_000 }
  );
  return jsonOutput(result, label);
};

const writePrivateFile = async (filePath, content, exclusive = true) => {
  await mkdir(path.dirname(filePath), { recursive: true });
  const handle = await open(filePath, exclusive ? "wx" : "w", 0o600);
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
};

const createLiveState = async () => {
  const stateDirectory = await mkdtemp(
    path.join(tmpdir(), "kurobara-v1-gate.")
  );
  await chmod(stateDirectory, 0o700);
  const identifier = randomBytes(6).toString("hex");
  const state = {
    api: {},
    apiPort: await freePort(),
    composeEnvFile: path.join(stateDirectory, "compose.env"),
    composeProject: `kurobara-v1-gate-${identifier}`,
    dashboardPort: await freePort(),
    databasePassword: `fixture_${randomBytes(18).toString("hex")}`,
    grpcPort: await freePort(),
    postgresPort: await freePort(),
    stateDirectory,
    worker: {},
  };
  await writePrivateFile(
    state.composeEnvFile,
    [
      `COMPOSE_PROJECT_NAME=${state.composeProject}`,
      `HATCHET_DASHBOARD_PORT=${state.dashboardPort}`,
      `HATCHET_GRPC_PORT=${state.grpcPort}`,
      `HATCHET_POSTGRES_PASSWORD=fixture_${randomBytes(18).toString("hex")}`,
      `KUROBARA_POSTGRES_PORT=${state.postgresPort}`,
      `KUROBARA_POSTGRES_PASSWORD=${state.databasePassword}`,
      "",
    ].join("\n")
  );
  return state;
};

const startApi = async (state, runtimeEnvironment, secrets) => {
  startService(
    state.api,
    "npm",
    ["run", "--silent", "start:api"],
    {
      ...runtimeEnvironment,
      KUROBARA_API_HOST: "127.0.0.1",
      KUROBARA_API_PORT: String(state.apiPort),
    },
    secrets
  );
  await assertServiceAlive(state.api, "API");
  await waitForReadiness(`http://127.0.0.1:${state.apiPort}`, state.api);
};

const startWorker = async (state, runtimeEnvironment, token, secrets) => {
  startService(
    state.worker,
    "npm",
    ["run", "--silent", "start:worker"],
    {
      ...runtimeEnvironment,
      HATCHET_CLIENT_API_URL: `http://127.0.0.1:${state.dashboardPort}`,
      HATCHET_CLIENT_HOST_PORT: `127.0.0.1:${state.grpcPort}`,
      HATCHET_CLIENT_NAMESPACE: "kurobara-v1-gate",
      HATCHET_CLIENT_TLS_STRATEGY: "none",
      HATCHET_CLIENT_TOKEN: token,
      KUROBARA_DISPATCHER_ID: "v1-gate-run-dispatcher",
      KUROBARA_LEAF_DISPATCHER_ID: "v1-gate-leaf-dispatcher",
      KUROBARA_LEAF_EFFECT_ADAPTER: "configured-providers",
      KUROBARA_LEAF_EFFECT_RECONCILER_ID: "v1-gate-effect-reconciler",
      KUROBARA_RECONCILER_ID: "v1-gate-run-reconciler",
      KUROBARA_ROUTE_SCHEDULER_ID: "v1-gate-route-scheduler",
      KUROBARA_WORKER_ID: "v1-gate-worker",
    },
    secrets
  );
  await assertServiceAlive(state.worker, "worker");
};

const bootstrap = async (state, providerEnvironment, secrets) => {
  const databaseUrl = `postgres://kurobara:${encodeURIComponent(state.databasePassword)}@127.0.0.1:${state.postgresPort}/kurobara`;
  secrets.add(state.databasePassword);
  secrets.add(databaseUrl);
  const runtimeEnvironment = {
    ...baseEnvironment(),
    ...providerEnvironment,
    KUROBARA_DATABASE_URL: databaseUrl,
    KUROBARA_PROVIDER_ORDER: "tavily,exa",
    NODE_ENV: "development",
  };
  await runCommand(
    "npm",
    [
      "run",
      "--silent",
      "bootstrap:planning",
      "-w",
      "@kurobara/api",
      "--",
      "--apply",
      "--file",
      path.join(REPOSITORY_ROOT, "examples/planning-bundle.v1.json"),
    ],
    {
      environment: runtimeEnvironment,
      label: "planning bootstrap",
      sensitiveOutput: true,
    }
  );
  const keyResult = await runCommand(
    "npm",
    ["run", "--silent", "bootstrap:api-key", "-w", "@kurobara/api"],
    {
      environment: {
        ...runtimeEnvironment,
        KUROBARA_BOOTSTRAP_ACTOR_ID: "actor_demo",
        KUROBARA_BOOTSTRAP_KEY_LABEL: "v1-gate-ephemeral",
        KUROBARA_BOOTSTRAP_PERMISSIONS:
          "capabilities:list,datasets:import,plans:quote,recipes:apply,recipes:export,recipes:read,recipes:register,runs:cancel,runs:create,runs:read",
        KUROBARA_BOOTSTRAP_WORKSPACE_ID: "workspace_demo",
      },
      label: "API key bootstrap",
      sensitiveOutput: true,
    }
  );
  const keyDocument = jsonOutput(keyResult, "API key bootstrap");
  if (
    typeof keyDocument.presented_key !== "string" ||
    keyDocument.presented_key.length === 0
  ) {
    throw new V1GateError(
      "bootstrap-output-invalid",
      "API key bootstrap did not return a presented key."
    );
  }
  secrets.add(keyDocument.presented_key);
  const apiKeyFile = path.join(state.stateDirectory, "api-key");
  await writePrivateFile(apiKeyFile, `${keyDocument.presented_key}\n`);
  return {
    apiKey: keyDocument.presented_key,
    apiKeyFile,
    runtimeEnvironment,
  };
};

const qualifyCancellation = async (
  apiUrl,
  apiKey,
  apiKeyFile,
  bundle,
  cliEnvironment
) => {
  const catalog = await readJson(
    "packages/contracts/catalog/generated/catalog-manifest.json"
  );
  const operationDeclared = catalog.members?.some(
    (member) => member.id === "operation:runs.cancel:1.0.0"
  );
  if (!operationDeclared) {
    return {
      reason_code: "cancel-contract-not-declared",
      status: "not-applicable",
    };
  }
  const [workflowEntry] = bundle.planning.workflows;
  const { workflow } = workflowEntry;
  const quote = assertHttpSuccess(
    await requestJson(`${apiUrl}/v1/plans`, apiKey, {
      body: {
        authority_envelope_id: "authority-demo",
        budget: { limit: 5, unit: "requests" },
        deadline_ms: 4_102_444_800_000,
        normalized_input_hash: `sha256:${"f".repeat(64)}`,
        workflow_content_hash: workflow.contentHash,
        workflow_revision: workflow.revision,
        workflow_spec_id: workflow.workflowSpecId,
        workspace_id: "workspace_demo",
      },
      method: "POST",
    }),
    "queued cancellation quote"
  );
  const created = assertHttpSuccess(
    await requestJson(`${apiUrl}/v1/runs`, apiKey, {
      body: {
        idempotency_key: `v1-gate-cancel-create-${randomUUID()}`,
        intention_hash: quote.plan_hash,
        run_plan_id: quote.run_plan_id,
      },
      method: "POST",
    }),
    "queued cancellation run creation"
  );
  const cancelKey = `v1-gate-cancel-${randomUUID()}`;
  const cancelArguments = [
    "run",
    "cancel",
    "--api-key-file",
    apiKeyFile,
    "--run-id",
    created.run_id,
    "--idempotency-key",
    cancelKey,
  ];
  const cancelled = await runCli(
    cancelArguments,
    cliEnvironment,
    "queued run cancel"
  );
  const replay = await runCli(
    cancelArguments,
    cliEnvironment,
    "queued run cancel replay"
  );
  if (
    cancelled.state !== "cancelled" ||
    cancelled.replayed !== false ||
    replay.state !== "cancelled" ||
    replay.replayed !== true ||
    replay.run_id !== cancelled.run_id ||
    replay.aggregate_version !== cancelled.aggregate_version ||
    replay.event_sequence !== cancelled.event_sequence
  ) {
    throw new V1GateError(
      "cancel-state-invalid",
      "A queued run cancellation and its exact replay did not preserve the canonical cancelled snapshot."
    );
  }
  return {
    first_replayed: cancelled.replayed,
    replay_replayed: replay.replayed,
    state: cancelled.state,
    status: "passed",
  };
};

const liveQualification = async (report, options) => {
  if (!options.confirmProviderCalls) {
    throw new V1GateError(
      "provider-call-confirmation-required",
      "Live mode requires --confirm-provider-calls because it can consume provider quota."
    );
  }
  const providerEnvironment = await readProviderEnvironmentFile(
    options.providerEnvFile
  );
  for (const variableName of ["TAVILY_API_KEY", "EXA_API_KEY"]) {
    if (providerEnvironment[variableName] === undefined) {
      throw new V1GateError(
        "provider-key-missing",
        `${variableName} is required by the live two-provider gate.`
      );
    }
  }
  assertExaDataRightsAttestation(providerEnvironment);
  authorizeLiveProviderCalls(report.proofs.provider_calls);
  const secrets = new Set([
    providerEnvironment.TAVILY_API_KEY,
    providerEnvironment.EXA_API_KEY,
  ]);
  const state = await createLiveState();
  const bundle = await readJson("examples/planning-bundle.v1.json");
  const keep = options.keepInfrastructure;
  let cleanupFailure;
  let qualificationFailure;
  try {
    await step(report, "infrastructure.start", async () => {
      await runCommand("docker", ["info"], {
        label: "Docker daemon check",
        timeoutMs: 30_000,
      });
      await runCommand(
        "docker",
        composeArguments(state, [
          "up",
          "--detach",
          "--wait",
          "--wait-timeout",
          "180",
          "hatchet",
          "kurobara-postgres",
        ]),
        { label: "isolated Hatchet and PostgreSQL startup", timeoutMs: 240_000 }
      );
      return { isolation: "unique-compose-project", loopback_only: true };
    });
    const tokenResult = await runCommand(
      "docker",
      composeArguments(state, [
        "exec",
        "-T",
        "hatchet",
        "cat",
        "/config/authdisabled-token",
      ]),
      { label: "Hatchet local token readback", sensitiveOutput: true }
    );
    const token = tokenResult.stdout.trim();
    if (token.length === 0 || token.length > 8192 || !token.includes(".")) {
      throw new V1GateError(
        "hatchet-token-invalid",
        "The local Hatchet fixture did not return a structurally valid token."
      );
    }
    secrets.add(token);
    let bootstrapped;
    await step(report, "runtime.bootstrap", async () => {
      bootstrapped = await bootstrap(state, providerEnvironment, secrets);
      return {
        api_key_transport: "private-temporary-file",
        planning_bundle: "applied",
        workspace_id: "workspace_demo",
      };
    });
    const apiUrl = `http://127.0.0.1:${state.apiPort}`;
    await step(report, "api.start", async () => {
      await startApi(state, bootstrapped.runtimeEnvironment, secrets);
      return { endpoint: apiUrl, transport: "loopback-http" };
    });
    await step(report, "api.capabilities", async () => {
      const response = assertHttpSuccess(
        await requestJson(
          `${apiUrl}/v1/capabilities?authority_envelope_id=authority-demo`,
          bootstrapped.apiKey
        ),
        "capability discovery"
      );
      if (
        !response.capabilities?.some(
          (capability) =>
            capability.capability_id === "organizations.website.resolve" &&
            capability.capability_version === "1.0.0"
        )
      ) {
        throw new V1GateError(
          "provider-capability-unavailable",
          "The API did not admit organizations.website.resolve@1.0.0."
        );
      }
      return { capability: "organizations.website.resolve@1.0.0" };
    });
    const cliEnvironment = {
      ...baseEnvironment(),
      KUROBARA_API_URL: apiUrl,
    };
    await step(report, "cli.dataset-import", async () => {
      const args = [
        "dataset",
        "import",
        "--api-key-file",
        bootstrapped.apiKeyFile,
        "--metadata",
        path.join(REPOSITORY_ROOT, "examples/dataset-import/metadata.json"),
        "--source",
        path.join(REPOSITORY_ROOT, "examples/dataset-import/source.jsonl"),
      ];
      const first = await runCli(args, cliEnvironment, "dataset import");
      const replay = await runCli(
        args,
        cliEnvironment,
        "dataset import replay"
      );
      if (first.state !== "completed" || replay.replayed !== true) {
        throw new V1GateError(
          "dataset-replay-invalid",
          "Dataset import and exact replay did not return their canonical states."
        );
      }
      return { record_count: first.record_count, replayed: replay.replayed };
    });
    await step(report, "api.queued-run-cancel", async () => {
      const result = await qualifyCancellation(
        apiUrl,
        bootstrapped.apiKey,
        bootstrapped.apiKeyFile,
        bundle,
        cliEnvironment
      );
      if (result.status === "not-applicable") {
        skipStep(report, "api.queued-run-cancel.contract", result.reason_code);
      }
      return result;
    });
    await step(report, "provider.exa-live-probe", async () => {
      recordPossibleProviderCalls(report.proofs.provider_calls, "exa");
      const probe = await runCommand(
        process.execPath,
        [
          "--conditions=kurobara-source",
          "--experimental-strip-types",
          "test/v1-gate/provider-live-probe.mjs",
          "exa",
        ],
        {
          environment: {
            ...baseEnvironment(),
            EXA_API_KEY: providerEnvironment.EXA_API_KEY,
          },
          label: "Exa live provider probe",
          sensitiveOutput: true,
          timeoutMs: 45_000,
        }
      );
      const result = jsonOutput(probe, "Exa live provider probe");
      if (
        result.status !== "succeeded" ||
        result.normalized_origin !== "https://example.com" ||
        result.usage?.amount !== 1 ||
        result.usage?.basis !== "exact" ||
        result.usage?.unit !== "requests"
      ) {
        throw new V1GateError(
          "provider-probe-invalid",
          "The Exa live probe did not normalize the public example.com fixture."
        );
      }
      confirmProviderCalls(report.proofs.provider_calls, "exa");
      return result;
    });
    await step(report, "worker.start", async () => {
      await startWorker(state, bootstrapped.runtimeEnvironment, token, secrets);
      return { provider_order: ["tavily", "exa"] };
    });
    const applyArguments = [
      "recipe",
      "apply",
      "--api-key-file",
      bootstrapped.apiKeyFile,
      "--request",
      path.join(REPOSITORY_ROOT, "examples/recipe-apply/request.example.json"),
    ];
    recordPossibleProviderCalls(report.proofs.provider_calls, "tavily");
    recordPossibleProviderCalls(report.proofs.provider_calls, "exa");
    await step(report, "cli.recipe-apply-replay", async () => {
      const first = await runCli(
        applyArguments,
        cliEnvironment,
        "recipe apply"
      );
      const replay = await runCli(
        applyArguments,
        cliEnvironment,
        "recipe apply replay"
      );
      if (
        first.created_run_count !== 1 ||
        replay.application_replayed !== true ||
        replay.recipe_replayed !== true
      ) {
        throw new V1GateError(
          "recipe-replay-invalid",
          "Recipe apply and exact replay did not preserve one durable run."
        );
      }
      return {
        application_id: first.application_id,
        created_run_count: first.created_run_count,
        replay_created_run_count: replay.created_run_count,
      };
    });
    await step(report, "cli.recipe-watch", async () => {
      const watched = await runCli(
        [
          "recipe",
          "watch",
          "--api-key-file",
          bootstrapped.apiKeyFile,
          "--application-id",
          "application_demo_org_website_v1",
          "--poll-interval-ms",
          "500",
          "--timeout-ms",
          "120000",
        ],
        cliEnvironment,
        "recipe watch"
      );
      if (watched.terminal !== true || watched.succeeded_cell_count !== 1) {
        throw new V1GateError(
          "recipe-result-invalid",
          "The live recipe application did not converge to one successful cell."
        );
      }
      return {
        failed_cell_count: watched.failed_cell_count,
        state: watched.state,
        succeeded_cell_count: watched.succeeded_cell_count,
      };
    });
    const liveRoutingProof = await step(
      report,
      "providers.live-routing-readback",
      () => readDurableLiveRoutingProof(state)
    );
    confirmProviderCalls(report.proofs.provider_calls, "tavily");
    confirmProviderCalls(report.proofs.provider_calls, "exa");
    report.proofs.live_fallback = liveRoutingProof;
    const firstExport = path.join(
      state.stateDirectory,
      "application-first.jsonl"
    );
    const secondExport = path.join(
      state.stateDirectory,
      "application-replay.jsonl"
    );
    const exportApplication = async (output) =>
      runCli(
        [
          "recipe",
          "export",
          "--api-key-file",
          bootstrapped.apiKeyFile,
          "--application-id",
          "application_demo_org_website_v1",
          "--format",
          "jsonl",
          "--output",
          output,
          "--timeout-ms",
          "30000",
        ],
        cliEnvironment,
        "recipe export"
      );
    const firstHash = await step(report, "cli.recipe-export", async () => {
      const receipt = await exportApplication(firstExport);
      const bytes = await readFile(firstExport);
      const text = bytes.toString("utf8");
      let exportedRecords;
      try {
        exportedRecords = text
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line));
      } catch {
        throw new V1GateError(
          "export-proof-invalid",
          "The export is not valid JSONL."
        );
      }
      const containsNormalizedPublicResult = exportedRecords.some(
        (record) =>
          record !== null &&
          typeof record === "object" &&
          Array.isArray(record.values) &&
          record.values.some(
            (field) =>
              field !== null &&
              typeof field === "object" &&
              field.field_id === "field_official_website_url" &&
              field.value === "https://example.com"
          )
      );
      if (
        !containsNormalizedPublicResult ||
        [...secrets].some((secret) => text.includes(secret))
      ) {
        throw new V1GateError(
          "export-proof-invalid",
          "The export does not contain the normalized public result or contains a secret."
        );
      }
      const contentHash = sha256(bytes);
      if (receipt.sha256 !== contentHash) {
        throw new V1GateError(
          "export-hash-mismatch",
          "The CLI export receipt does not match the downloaded bytes."
        );
      }
      return contentHash;
    });
    await step(report, "runtime.restart-replay", async () => {
      await stopService(state.worker);
      await stopService(state.api);
      state.worker = {};
      state.api = {};
      await startApi(state, bootstrapped.runtimeEnvironment, secrets);
      await startWorker(state, bootstrapped.runtimeEnvironment, token, secrets);
      const replay = await runCli(
        applyArguments,
        cliEnvironment,
        "recipe apply after restart"
      );
      const snapshot = await runCli(
        [
          "recipe",
          "watch",
          "--api-key-file",
          bootstrapped.apiKeyFile,
          "--application-id",
          "application_demo_org_website_v1",
          "--timeout-ms",
          "0",
        ],
        cliEnvironment,
        "recipe watch after restart"
      );
      await exportApplication(secondExport);
      const replayHash = sha256(await readFile(secondExport));
      if (
        replay.created_run_count !== 0 ||
        snapshot.terminal !== true ||
        replayHash !== firstHash
      ) {
        throw new V1GateError(
          "restart-replay-invalid",
          "Restart, exact replay, terminal readback, and deterministic export did not agree."
        );
      }
      return {
        deterministic_export_sha256: replayHash,
        replay_created_run_count: replay.created_run_count,
        terminal: snapshot.terminal,
      };
    });
    report.proofs.headless_vertical = true;
  } catch (error) {
    qualificationFailure = error;
  } finally {
    await stopService(state.worker).catch(() => undefined);
    await stopService(state.api).catch(() => undefined);
    const cleanupArguments = composeArguments(state, [
      "down",
      "--volumes",
      "--remove-orphans",
    ]);
    if (keep) {
      report.cleanup = {
        command_argv: ["docker", ...cleanupArguments],
        compose_project: state.composeProject,
        retained: true,
        state_directory: state.stateDirectory,
        status: "retained-by-request",
      };
    } else {
      try {
        await runCommand("docker", cleanupArguments, {
          label: "isolated infrastructure cleanup",
          timeoutMs: 120_000,
        });
        await rm(state.stateDirectory, { force: true, recursive: true });
        report.cleanup = { retained: false, status: "completed" };
      } catch (error) {
        cleanupFailure = error;
        report.cleanup = {
          command_argv: ["docker", ...cleanupArguments],
          compose_project: state.composeProject,
          reason_code:
            error instanceof V1GateError ? error.code : "unexpected-error",
          retained: true,
          state_directory: state.stateDirectory,
          status: "failed-recovery-required",
        };
      }
    }
  }
  if (cleanupFailure !== undefined) {
    throw new V1GateError(
      "infrastructure-cleanup-failed",
      "The isolated infrastructure cleanup failed; use the retained command argv and state directory for recovery.",
      { cause: cleanupFailure }
    );
  }
  if (qualificationFailure !== undefined) {
    throw qualificationFailure;
  }
};

const assertReportContainsNoSecrets = (report, secrets) => {
  const serialized = JSON.stringify(report);
  for (const secret of secrets) {
    if (secret.length > 0 && serialized.includes(secret)) {
      throw new V1GateError(
        "report-secret-detected",
        "The gate refused to persist a report containing a credential."
      );
    }
  }
};

const persistReport = async (report, reportPath) => {
  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  if (reportPath === undefined) {
    process.stdout.write(serialized);
    return;
  }
  await writePrivateFile(reportPath, serialized);
  process.stdout.write(
    `${JSON.stringify({ outcome: report.outcome, report: reportPath })}\n`
  );
};

export const runV1Gate = async (options) => {
  const report = {
    cleanup: { retained: false, status: "not-required" },
    finished_at: null,
    format_version: "1.0.0",
    mode: options.mode,
    operator_contract: {
      interactive_prompt: false,
      secret_transport:
        options.mode === "live" ? "private-files-and-child-env" : "none",
      stdin_required: false,
    },
    outcome: "failed",
    proofs: {
      clone_to_result: false,
      headless_vertical: false,
      provider_calls: createProviderCallAccounting(),
    },
    started_at: new Date().toISOString(),
    steps: [],
  };
  let failure;
  try {
    await localChecks(report, options);
    if (options.mode === "live") {
      await liveQualification(report, options);
      report.outcome = "live-qualified";
    } else {
      report.outcome = "fixture-dry-run-passed";
      skipStep(
        report,
        "runtime.clone-to-result",
        "live-provider-calls-not-authorized"
      );
    }
  } catch (error) {
    failure = error;
    report.failure = {
      message:
        error instanceof Error
          ? redactText(error.message)
          : "Unknown V1 gate failure.",
      reason_code:
        error instanceof V1GateError ? error.code : "unexpected-error",
    };
  }
  report.finished_at = new Date().toISOString();
  const providerSecrets =
    options.mode === "live"
      ? await readProviderEnvironmentFile(options.providerEnvFile)
          .then((environment) => [
            environment.TAVILY_API_KEY ?? "",
            environment.EXA_API_KEY ?? "",
          ])
          .catch(() => [])
      : [];
  assertReportContainsNoSecrets(report, providerSecrets);
  await persistReport(report, options.reportPath);
  if (failure !== undefined) {
    throw failure;
  }
  return report;
};

const isMainModule =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMainModule) {
  let options;
  try {
    options = parseArguments(process.argv.slice(2));
    if (options.help) {
      process.stdout.write(`${usage()}\n`);
    } else {
      await runV1Gate(options);
    }
  } catch (error) {
    if (options === undefined || options.help !== true) {
      const code =
        error instanceof V1GateError ? error.code : "unexpected-error";
      process.stderr.write(
        `${JSON.stringify({ code, message: "V1 gate failed; inspect the redacted report or rerun fixture mode." })}\n`
      );
      process.exitCode = 1;
    }
  }
}
