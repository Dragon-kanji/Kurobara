import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import test from "node:test";

import { runCli } from "../src/cli.ts";

const TEST_ENDPOINT = "http://kurobara.test";
const CONTACT_SENSITIVE_FIELD_PATTERN =
  /email|phone|provider_(?:candidate_)?id|provider_cursor/u;

type FetchHandler = (request: Request) => Promise<Response> | Response;

const fetchFrom = (handler: FetchHandler): typeof fetch =>
  ((input: URL | RequestInfo, init?: RequestInit) =>
    handler(new Request(input, init))) as typeof fetch;

const jsonResponse = (
  body: unknown,
  status = 200,
  contentType = "application/json"
): Response =>
  new Response(JSON.stringify(body), {
    headers: { "content-type": contentType },
    status,
  });

const capture = (isTTY = false, columns = 96) => {
  const chunks: Uint8Array[] = [];
  return {
    target: {
      columns,
      isTTY,
      write: (chunk: string | Uint8Array) => {
        chunks.push(
          typeof chunk === "string" ? new TextEncoder().encode(chunk) : chunk
        );
      },
    },
    value: () => Buffer.concat(chunks).toString("utf8"),
  };
};

const validMetadata = {
  batch_limits: { max_bytes: 4096, max_items: 10 },
  dataset: {
    dataset_id: "dataset-cli-test",
    name: "Synthetic CLI test",
    workspace_id: "workspace-cli-test",
  },
  fields: [
    {
      dataset_id: "dataset-cli-test",
      field_id: "field-name",
      key: "name",
      label: "Name",
      value_type: "string",
      workspace_id: "workspace-cli-test",
    },
  ],
  format: "csv",
  import_id: "import-cli-test",
  max_record_bytes: 2048,
  source_content_hash: `sha256:${"a".repeat(64)}`,
} as const;

const validRecipeRequest = {
  aggregate_budget: { limit: 10, unit: "credits" },
  application_id: "application-cli-test",
  authority_envelope_id: "authority-cli-test",
  cell_budget: { limit: 5, unit: "credits" },
  deadline_ms: 20_000,
  max_cells: 10,
  recipe: {
    dataset_id: "dataset-cli-test",
    input_field_ids: ["field-domain"],
    name: "Resolve official website",
    recipe_id: "recipe-cli-test",
    recipe_revision: "1.0.0",
    target_field_id: "field-website",
    workflow_content_hash: `sha256:${"b".repeat(64)}`,
    workflow_revision: "1.0.0",
    workflow_spec_id: "workflow-cli-test",
    workspace_id: "workspace-cli-test",
  },
  record_ids: ["record-1", "record-2"],
} as const;

const recipeSuccessBody = {
  active_cell_count: 0,
  application_id: "application-cli-test",
  application_replayed: false,
  bound_cell_count: 0,
  cached_cell_count: 0,
  created_run_count: 2,
  dataset_id: "dataset-cli-test",
  recipe_id: "recipe-cli-test",
  recipe_replayed: false,
  recipe_revision: "1.0.0",
  total_cell_count: 2,
  workspace_id: "workspace-cli-test",
} as const;

const runningWatchBody = {
  application_id: "application-cli-test",
  bound_cell_count: 2,
  dataset_id: "dataset-cli-test",
  failed_cell_count: 0,
  pending_cell_count: 1,
  recipe_id: "recipe-cli-test",
  recipe_revision: "1.0.0",
  running_cell_count: 0,
  skipped_cell_count: 0,
  state: "running",
  succeeded_cell_count: 1,
  terminal: false,
  total_cell_count: 2,
  unbound_cell_count: 0,
  workspace_id: "workspace-cli-test",
} as const;

const succeededWatchBody = {
  ...runningWatchBody,
  pending_cell_count: 0,
  state: "succeeded",
  succeeded_cell_count: 2,
  terminal: true,
} as const;

const needsReplayWatchBody = {
  ...runningWatchBody,
  bound_cell_count: 1,
  pending_cell_count: 0,
  state: "needs_replay",
  succeeded_cell_count: 1,
  unbound_cell_count: 1,
} as const;

const invokeImport = async (
  metadataFile: string,
  sourceFile: string,
  endpoint: string,
  fetchImplementation?: typeof fetch
) => {
  const stdout = capture();
  const stderr = capture();
  const exitCode = await runCli({
    argv: [
      "dataset",
      "import",
      "--endpoint",
      endpoint,
      "--metadata",
      metadataFile,
      "--source",
      sourceFile,
    ],
    environment: { KUROBARA_API_KEY: "synthetic-api-key" },
    ...(fetchImplementation === undefined
      ? {}
      : { fetch: fetchImplementation }),
    stderr: stderr.target,
    stdin: Readable.from([]),
    stdout: stdout.target,
  });
  return { exitCode, stderr: stderr.value(), stdout: stdout.value() };
};

const invokeRecipeApply = async (
  requestFile: string,
  endpoint: string,
  environment: Readonly<Record<string, string | undefined>> = {
    KUROBARA_API_KEY: "synthetic-api-key",
  },
  fetchImplementation?: typeof fetch
) => {
  const stdout = capture();
  const stderr = capture();
  const exitCode = await runCli({
    argv: ["recipe", "apply", "--endpoint", endpoint, "--request", requestFile],
    environment,
    ...(fetchImplementation === undefined
      ? {}
      : { fetch: fetchImplementation }),
    stderr: stderr.target,
    stdin: Readable.from([]),
    stdout: stdout.target,
  });
  return { exitCode, stderr: stderr.value(), stdout: stdout.value() };
};

const invokeRunCancel = async (
  endpoint: string,
  options: Readonly<{
    fetch?: typeof fetch;
    idempotencyKey?: string;
    runId?: string;
  }> = {}
) => {
  const stdout = capture();
  const stderr = capture();
  const exitCode = await runCli({
    argv: [
      "run",
      "cancel",
      "--endpoint",
      endpoint,
      "--run-id",
      options.runId ?? "run-cli-test",
      "--idempotency-key",
      options.idempotencyKey ?? "cancel-cli-test",
    ],
    environment: { KUROBARA_API_KEY: "synthetic-api-key" },
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    stderr: stderr.target,
    stdin: Readable.from([]),
    stdout: stdout.target,
  });
  return { exitCode, stderr: stderr.value(), stdout: stdout.value() };
};

type WatchInvocationOptions = Readonly<{
  applicationId?: string;
  fetch?: typeof fetch;
  now?: () => number;
  pollIntervalMs?: number;
  signal?: AbortSignal;
  timeoutMs: number;
  wait?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
}>;

const invokeRecipeWatch = async (
  endpoint: string,
  options: WatchInvocationOptions
) => {
  const stdout = capture();
  const stderr = capture();
  const argv = [
    "recipe",
    "watch",
    "--endpoint",
    endpoint,
    "--application-id",
    options.applicationId ?? "application-cli-test",
    "--timeout-ms",
    String(options.timeoutMs),
  ];
  if (options.pollIntervalMs !== undefined) {
    argv.push("--poll-interval-ms", String(options.pollIntervalMs));
  }
  const exitCode = await runCli({
    argv,
    environment: { KUROBARA_API_KEY: "synthetic-api-key" },
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    stderr: stderr.target,
    stdin: Readable.from([]),
    stdout: stdout.target,
    ...(options.wait === undefined ? {} : { wait: options.wait }),
  });
  return { exitCode, stderr: stderr.value(), stdout: stdout.value() };
};

type ExportInvocationOptions = Readonly<{
  applicationId?: string;
  fetch?: typeof fetch;
  fieldIds?: readonly string[];
  format?: "csv" | "jsonl";
  maxBytes?: number;
  signal?: AbortSignal;
  timeoutMs?: number;
}>;

const invokeRecipeExport = async (
  endpoint: string,
  outputFile: string,
  options: ExportInvocationOptions = {}
) => {
  const stdout = capture();
  const stderr = capture();
  const argv = [
    "recipe",
    "export",
    "--endpoint",
    endpoint,
    "--application-id",
    options.applicationId ?? "application-cli-test",
    "--format",
    options.format ?? "jsonl",
    "--output",
    outputFile,
    "--timeout-ms",
    String(options.timeoutMs ?? 10_000),
  ];
  for (const fieldId of options.fieldIds ?? []) {
    argv.push("--field-id", fieldId);
  }
  if (options.maxBytes !== undefined) {
    argv.push("--max-bytes", String(options.maxBytes));
  }
  const exitCode = await runCli({
    argv,
    environment: { KUROBARA_API_KEY: "synthetic-api-key" },
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    stderr: stderr.target,
    stdin: Readable.from([]),
    stdout: stdout.target,
  });
  return { exitCode, stderr: stderr.value(), stdout: stdout.value() };
};

type DatasetExportInvocationOptions = Readonly<{
  datasetId?: string;
  fetch?: typeof fetch;
  fieldIds?: readonly string[];
  format?: "csv" | "jsonl";
  maxBytes?: number;
  outputFile?: string;
  receiptFile?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}>;

const invokeDatasetExport = async (
  endpoint: string,
  options: DatasetExportInvocationOptions = {}
) => {
  const stdout = capture();
  const stderr = capture();
  const argv = [
    "dataset",
    "export",
    "--endpoint",
    endpoint,
    "--dataset-id",
    options.datasetId ?? "dataset-cli-test",
    "--format",
    options.format ?? "jsonl",
  ];
  for (const fieldId of options.fieldIds ?? []) {
    argv.push("--field-id", fieldId);
  }
  if (options.maxBytes !== undefined) {
    argv.push("--max-bytes", String(options.maxBytes));
  }
  if (options.outputFile !== undefined) {
    argv.push("--output", options.outputFile);
  }
  if (options.receiptFile !== undefined) {
    argv.push("--receipt", options.receiptFile);
  }
  if (options.timeoutMs !== undefined) {
    argv.push("--timeout-ms", String(options.timeoutMs));
  }
  const exitCode = await runCli({
    argv,
    environment: { KUROBARA_API_KEY: "synthetic-api-key" },
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    stderr: stderr.target,
    stdin: Readable.from([]),
    stdout: stdout.target,
  });
  return { exitCode, stderr: stderr.value(), stdout: stdout.value() };
};

const exportHeaders = (
  bytes: Uint8Array,
  format: "csv" | "jsonl" = "jsonl",
  overrides: Readonly<Record<string, string>> = {}
): Readonly<Record<string, string>> => ({
  "cache-control": "private, no-store",
  "content-disposition": `attachment; filename="kurobara-recipe-application.${format}"`,
  "content-length": String(bytes.byteLength),
  "content-type": format === "csv" ? "text/csv" : "application/x-ndjson",
  "x-content-type-options": "nosniff",
  "x-kurobara-content-sha256": `sha256:${createHash("sha256")
    .update(bytes)
    .digest("hex")}`,
  ...overrides,
});

const streamingDatasetExportHeaders = (
  bytes: Uint8Array,
  format: "csv" | "jsonl",
  delivery = false
): Readonly<Record<string, string>> => ({
  "cache-control": "private, no-store",
  "content-disposition": `attachment; filename="kurobara-dataset.${format}"`,
  "content-length": String(bytes.byteLength),
  "content-type": format === "csv" ? "text/csv" : "application/x-ndjson",
  "x-content-type-options": "nosniff",
  "x-kurobara-content-sha256": `sha256:${createHash("sha256")
    .update(bytes)
    .digest("hex")}`,
  ...(delivery
    ? {
        "x-kurobara-delivery-expires-at-ms": "1752786400000",
        "x-kurobara-delivery-id": "delivery-cli-test",
        "x-kurobara-delivery-state": "prepared",
      }
    : {}),
});

const watchTransport = (
  responseForCall: (call: number) => unknown
): Readonly<{
  calls: () => number;
  fetch: typeof fetch;
  requests: readonly Readonly<{
    authorization?: string;
    method?: string;
    url?: string;
  }>[];
}> => {
  let calls = 0;
  const requests: {
    authorization?: string;
    method?: string;
    url?: string;
  }[] = [];
  const fetch = fetchFrom((request) => {
    calls += 1;
    requests.push({
      ...(request.headers.get("authorization") === null
        ? {}
        : { authorization: request.headers.get("authorization") ?? undefined }),
      method: request.method,
      url: new URL(request.url).pathname,
    });
    return jsonResponse(responseForCall(calls));
  });
  return { calls: () => calls, fetch, requests };
};

test("rejects incomplete commands as stable JSON without reading secrets", async () => {
  const stdout = capture();
  const stderr = capture();
  const exitCode = await runCli({
    argv: ["dataset", "import", "--metadata", "missing.json"],
    environment: { KUROBARA_API_KEY: "must-not-appear" },
    stderr: stderr.target,
    stdin: Readable.from([]),
    stdout: stdout.target,
  });

  assert.equal(exitCode, 2);
  assert.equal(stdout.value(), "");
  assert.deepEqual(JSON.parse(stderr.value()), {
    code: "cli-usage-error",
    retryable: false,
    status: 0,
    title: "Dataset import requires --metadata and --source.",
    type: "about:blank",
  });
  assert.equal(stderr.value().includes("must-not-appear"), false);
});

test("rejects incomplete and ambiguous recipe apply arguments", async () => {
  for (const argv of [
    ["recipe", "apply"],
    ["recipe", "apply", "--request", "first.json", "--request", "second.json"],
    ["recipe", "apply", "--metadata", "request.json"],
  ]) {
    const stdout = capture();
    const stderr = capture();
    const exitCode = await runCli({
      argv,
      environment: { KUROBARA_API_KEY: "must-not-appear" },
      stderr: stderr.target,
      stdin: Readable.from([]),
      stdout: stdout.target,
    });

    assert.equal(exitCode, 2);
    assert.equal(stdout.value(), "");
    assert.equal(
      Reflect.get(JSON.parse(stderr.value()) as object, "code"),
      "cli-usage-error"
    );
    assert.equal(stderr.value().includes("must-not-appear"), false);
  }
});

test("rejects incomplete and ambiguous run cancel arguments before reading credentials", async () => {
  for (const argv of [
    ["run", "cancel"],
    ["run", "cancel", "--run-id", "run-cli-test"],
    [
      "run",
      "cancel",
      "--run-id",
      "run-cli-test",
      "--idempotency-key",
      "first",
      "--idempotency-key",
      "second",
    ],
    ["run", "cancel", "--request", "cancel.json"],
  ]) {
    const stdout = capture();
    const stderr = capture();
    const exitCode = await runCli({
      argv,
      environment: { KUROBARA_API_KEY: "must-not-appear" },
      stderr: stderr.target,
      stdin: Readable.from([]),
      stdout: stdout.target,
    });

    assert.equal(exitCode, 2);
    assert.equal(stdout.value(), "");
    assert.equal(
      Reflect.get(JSON.parse(stderr.value()) as object, "code"),
      "cli-usage-error"
    );
    assert.equal(stderr.value().includes("must-not-appear"), false);
  }
});

test("runs a non-interactive cancellation with stable JSON output", async () => {
  const requests: Readonly<{
    authorization?: string;
    body: string;
    method?: string;
    url?: string;
  }>[] = [];
  const responseBody = {
    aggregate_version: 2,
    created_at_ms: 1_752_700_000_000,
    event_sequence: 3,
    replayed: false,
    result_completeness: "none",
    run_id: "run/cli test",
    run_plan_id: "plan-cli-test",
    state: "cancelled",
    workspace_id: "workspace-cli-test",
  } as const;
  const transport = fetchFrom(async (request) => {
    requests.push({
      authorization: request.headers.get("authorization") ?? undefined,
      body: await request.text(),
      method: request.method,
      url: new URL(request.url).pathname,
    });
    return jsonResponse(responseBody);
  });
  const result = await invokeRunCancel(TEST_ENDPOINT, {
    fetch: transport,
    runId: "run/cli test",
  });

  assert.equal(result.exitCode, 0);
  assert.equal(result.stderr, "");
  assert.deepEqual(JSON.parse(result.stdout), responseBody);
  assert.deepEqual(requests, [
    {
      authorization: "Bearer synthetic-api-key",
      body: JSON.stringify({ idempotency_key: "cancel-cli-test" }),
      method: "POST",
      url: "/v1/runs/run%2Fcli%20test/cancel",
    },
  ]);
});

test("maps a canonical cancellation idempotency conflict without retry", async () => {
  let calls = 0;
  const transport = fetchFrom(() => {
    calls += 1;
    return jsonResponse(
      {
        code: "idempotency-key-reused",
        retryable: false,
        status: 409,
        title: "Idempotency key reused",
        type: "https://problems.kurobara.invalid/idempotency-key-reused",
      },
      409,
      "application/problem+json"
    );
  });
  const result = await invokeRunCancel(TEST_ENDPOINT, { fetch: transport });

  assert.equal(result.exitCode, 5);
  assert.equal(result.stdout, "");
  assert.equal(
    Reflect.get(JSON.parse(result.stderr) as object, "code"),
    "idempotency-key-reused"
  );
  assert.equal(calls, 1);
});

test("rejects ambiguous credential sources before opening local files", async () => {
  const stdout = capture();
  const stderr = capture();
  const exitCode = await runCli({
    argv: [
      "dataset",
      "import",
      "--api-key-file",
      "key.txt",
      "--metadata",
      "metadata.json",
      "--source",
      "source.csv",
    ],
    environment: { KUROBARA_API_KEY: "synthetic-environment-key" },
    stderr: stderr.target,
    stdin: Readable.from([]),
    stdout: stdout.target,
  });

  assert.equal(exitCode, 2);
  assert.equal(stdout.value(), "");
  assert.equal(
    Reflect.get(JSON.parse(stderr.value()) as object, "code"),
    "cli-config-invalid"
  );
  assert.equal(stderr.value().includes("synthetic-environment-key"), false);
});

test("classifies a non-UTF-8 API key file as invalid configuration", async () => {
  const temporaryDirectory = await mkdtemp(
    path.join(tmpdir(), "kurobara-cli-key-")
  );
  const keyFile = path.join(temporaryDirectory, "key.txt");
  try {
    await writeFile(keyFile, new Uint8Array([0xff]), { mode: 0o600 });
    const stdout = capture();
    const stderr = capture();
    const exitCode = await runCli({
      argv: [
        "dataset",
        "import",
        "--api-key-file",
        keyFile,
        "--metadata",
        "metadata.json",
        "--source",
        "source.csv",
      ],
      environment: {},
      stderr: stderr.target,
      stdin: Readable.from([]),
      stdout: stdout.target,
    });

    assert.equal(exitCode, 2);
    assert.equal(stdout.value(), "");
    assert.equal(
      Reflect.get(JSON.parse(stderr.value()) as object, "code"),
      "cli-config-invalid"
    );
  } finally {
    await rm(temporaryDirectory, { force: true, recursive: true });
  }
});

test("maps config, input, network, and invalid-response failures deterministically", async () => {
  const temporaryDirectory = await mkdtemp(
    path.join(tmpdir(), "kurobara-cli-unit-")
  );
  const metadataFile = path.join(temporaryDirectory, "metadata.json");
  const sourceFile = path.join(temporaryDirectory, "source.csv");
  try {
    await Promise.all([
      writeFile(metadataFile, JSON.stringify(validMetadata), { mode: 0o600 }),
      writeFile(sourceFile, "record_id,name\nrecord-1,Synthetic\n", {
        mode: 0o600,
      }),
    ]);

    const invalidConfig = await invokeImport(
      metadataFile,
      sourceFile,
      "not-a-url"
    );
    assert.equal(invalidConfig.exitCode, 2);
    assert.equal(
      Reflect.get(JSON.parse(invalidConfig.stderr) as object, "code"),
      "cli-config-invalid"
    );

    await writeFile(
      metadataFile,
      JSON.stringify({ ...validMetadata, unexpected: "must-not-pass" }),
      { mode: 0o600 }
    );
    const invalidInput = await invokeImport(
      metadataFile,
      sourceFile,
      "http://127.0.0.1:1"
    );
    assert.equal(invalidInput.exitCode, 2);
    assert.equal(
      Reflect.get(JSON.parse(invalidInput.stderr) as object, "code"),
      "cli-input-invalid"
    );
    await writeFile(metadataFile, JSON.stringify(validMetadata), {
      mode: 0o600,
    });

    const network = await invokeImport(
      metadataFile,
      sourceFile,
      TEST_ENDPOINT,
      fetchFrom(() =>
        Promise.reject(new TypeError("synthetic network failure"))
      )
    );
    assert.equal(network.exitCode, 75);
    assert.deepEqual(JSON.parse(network.stderr), {
      code: "cli-transport-error",
      retryable: true,
      status: 0,
      title: "Kurobara API request failed.",
      type: "about:blank",
    });

    const invalidResponse = await invokeImport(
      metadataFile,
      sourceFile,
      TEST_ENDPOINT,
      fetchFrom(() =>
        jsonResponse({
          batch_count: 1,
          credential: "must-not-be-forwarded",
          dataset_id: "dataset-cli-test",
          error_count: 0,
          import_id: "import-cli-test",
          item_count: 1,
          record_count: 1,
          replayed: false,
          state: "completed",
          workspace_id: "workspace-cli-test",
        })
      )
    );
    assert.equal(invalidResponse.exitCode, 70);
    assert.equal(
      Reflect.get(JSON.parse(invalidResponse.stderr) as object, "code"),
      "cli-contract-error"
    );
    assert.equal(
      invalidResponse.stderr.includes("must-not-be-forwarded"),
      false
    );

    const problem = await invokeImport(
      metadataFile,
      sourceFile,
      TEST_ENDPOINT,
      fetchFrom(() =>
        jsonResponse(
          {
            code: "dataset-import-conflict",
            retryable: false,
            status: 409,
            title: "Dataset import conflict",
            type: "https://problems.kurobara.invalid/dataset-import-conflict",
          },
          409,
          "application/problem+json"
        )
      )
    );
    assert.equal(problem.exitCode, 5);
    assert.deepEqual(JSON.parse(problem.stderr), {
      code: "dataset-import-conflict",
      retryable: false,
      status: 409,
      title: "Dataset import conflict",
      type: "https://problems.kurobara.invalid/dataset-import-conflict",
    });
  } finally {
    await rm(temporaryDirectory, { force: true, recursive: true });
  }
});

test("applies one recipe request as strict JSON and prints canonical success", async () => {
  const temporaryDirectory = await mkdtemp(
    path.join(tmpdir(), "kurobara-cli-recipe-happy-")
  );
  const requestFile = path.join(temporaryDirectory, "request.json");
  await writeFile(requestFile, JSON.stringify(validRecipeRequest), {
    mode: 0o600,
  });
  const transport = fetchFrom(async (request) => {
    assert.equal(request.method, "POST");
    assert.equal(new URL(request.url).pathname, "/v1/recipe-applications");
    assert.equal(
      request.headers.get("authorization"),
      "Bearer synthetic-api-key"
    );
    assert.equal(request.headers.get("content-type"), "application/json");
    assert.deepEqual(JSON.parse(await request.text()), validRecipeRequest);
    return jsonResponse(recipeSuccessBody);
  });
  try {
    const result = await invokeRecipeApply(
      requestFile,
      TEST_ENDPOINT,
      undefined,
      transport
    );
    assert.equal(result.exitCode, 0);
    assert.equal(result.stderr, "");
    assert.deepEqual(JSON.parse(result.stdout), recipeSuccessBody);
  } finally {
    await rm(temporaryDirectory, { force: true, recursive: true });
  }
});

test("rejects unsafe, oversized, malformed, and noncanonical recipe files", async () => {
  const temporaryDirectory = await mkdtemp(
    path.join(tmpdir(), "kurobara-cli-recipe-input-")
  );
  const validFile = path.join(temporaryDirectory, "valid.json");
  const symlinkFile = path.join(temporaryDirectory, "linked.json");
  const malformedFile = path.join(temporaryDirectory, "malformed.json");
  const oversizedFile = path.join(temporaryDirectory, "oversized.json");
  const invalidFile = path.join(temporaryDirectory, "invalid.json");
  try {
    await Promise.all([
      writeFile(validFile, JSON.stringify(validRecipeRequest), { mode: 0o600 }),
      writeFile(malformedFile, new Uint8Array([0xff]), { mode: 0o600 }),
      writeFile(oversizedFile, "x".repeat(65_537), { mode: 0o600 }),
      writeFile(
        invalidFile,
        JSON.stringify({ ...validRecipeRequest, unexpected: "must-not-pass" }),
        { mode: 0o600 }
      ),
    ]);
    await symlink(validFile, symlinkFile);

    for (const requestFile of [
      symlinkFile,
      malformedFile,
      oversizedFile,
      invalidFile,
    ]) {
      const result = await invokeRecipeApply(requestFile, "http://127.0.0.1:1");
      assert.equal(result.exitCode, 2, requestFile);
      assert.equal(result.stdout, "", requestFile);
      assert.equal(
        Reflect.get(JSON.parse(result.stderr) as object, "code"),
        "cli-input-invalid",
        requestFile
      );
    }

    const missingCredential = await invokeRecipeApply(
      validFile,
      "http://127.0.0.1:1",
      {}
    );
    assert.equal(missingCredential.exitCode, 2);
    assert.equal(
      Reflect.get(JSON.parse(missingCredential.stderr) as object, "code"),
      "cli-config-invalid"
    );
    assert.equal(missingCredential.stderr.includes("synthetic-api-key"), false);
  } finally {
    await rm(temporaryDirectory, { force: true, recursive: true });
  }
});

test("maps recipe problems and invalid responses with generated exit metadata", async () => {
  const temporaryDirectory = await mkdtemp(
    path.join(tmpdir(), "kurobara-cli-recipe-response-")
  );
  const requestFile = path.join(temporaryDirectory, "request.json");
  await writeFile(requestFile, JSON.stringify(validRecipeRequest), {
    mode: 0o600,
  });
  const problem = {
    code: "idempotency-key-reused",
    retryable: false,
    status: 409,
    title: "Idempotency key reused",
    type: "https://problems.kurobara.invalid/idempotency-key-reused",
  } as const;
  let returnInvalidSuccess = false;
  const transport = fetchFrom(() => {
    if (returnInvalidSuccess) {
      return jsonResponse({
        ...recipeSuccessBody,
        credential: "must-not-pass",
      });
    }
    return jsonResponse(problem, 409, "application/problem+json");
  });
  try {
    const problemResult = await invokeRecipeApply(
      requestFile,
      TEST_ENDPOINT,
      undefined,
      transport
    );
    assert.equal(problemResult.exitCode, 5);
    assert.equal(problemResult.stdout, "");
    assert.deepEqual(JSON.parse(problemResult.stderr), problem);

    returnInvalidSuccess = true;
    const invalidResponse = await invokeRecipeApply(
      requestFile,
      TEST_ENDPOINT,
      undefined,
      transport
    );
    assert.equal(invalidResponse.exitCode, 70);
    assert.equal(invalidResponse.stdout, "");
    assert.equal(
      Reflect.get(JSON.parse(invalidResponse.stderr) as object, "code"),
      "cli-contract-error"
    );
    assert.equal(invalidResponse.stderr.includes("must-not-pass"), false);
  } finally {
    await rm(temporaryDirectory, { force: true, recursive: true });
  }
});

test("dataset export streams raw bytes to stdout by default", async () => {
  const bytes = new TextEncoder().encode(
    '{"record_id":"record-1","company_name":"Example"}\n'
  );
  let requestBody: unknown;
  const transport = fetchFrom(async (request) => {
    assert.equal(request.method, "POST");
    assert.equal(new URL(request.url).pathname, "/v1/dataset-exports");
    assert.equal(
      request.headers.get("authorization"),
      "Bearer synthetic-api-key"
    );
    assert.equal(request.headers.get("content-type"), "application/json");
    requestBody = JSON.parse(await request.text());
    return new Response(bytes, {
      headers: streamingDatasetExportHeaders(bytes, "jsonl"),
    });
  });

  const result = await invokeDatasetExport(TEST_ENDPOINT, {
    fetch: transport,
    fieldIds: ["field-name", "field-domain"],
  });

  assert.equal(result.exitCode, 0);
  assert.equal(result.stderr, "");
  assert.equal(result.stdout, new TextDecoder().decode(bytes));
  assert.deepEqual(requestBody, {
    dataset_id: "dataset-cli-test",
    field_ids: ["field-name", "field-domain"],
    format: "jsonl",
  });
});

test("dataset export refuses a tracked stdout stream without a receipt before consuming bytes", async () => {
  const bytes = new TextEncoder().encode(
    '{"record_id":"record-1","work_email":"private@example.invalid"}\n'
  );
  let cancelled = false;
  let pulls = 0;
  const body = new ReadableStream<Uint8Array>({
    cancel: () => {
      cancelled = true;
    },
    pull: () => {
      pulls += 1;
    },
  });
  const result = await invokeDatasetExport(TEST_ENDPOINT, {
    fetch: fetchFrom(
      () =>
        new Response(body, {
          headers: streamingDatasetExportHeaders(bytes, "jsonl", true),
        })
    ),
  });

  assert.equal(result.exitCode, 2);
  assert.equal(result.stdout, "");
  assert.equal(
    Reflect.get(JSON.parse(result.stderr) as object, "code"),
    "cli-usage-error"
  );
  assert.equal(
    Reflect.get(JSON.parse(result.stderr) as object, "title"),
    "Tracked dataset exports to stdout require --receipt PATH."
  );
  assert.equal(cancelled, true);
  assert.ok(pulls <= 1);
});

test("dataset export streams tracked bytes to stdout and publishes a private receipt", async () => {
  const temporaryDirectory = await mkdtemp(
    path.join(tmpdir(), "kurobara-cli-dataset-stdout-receipt-")
  );
  const receiptFile = path.join(temporaryDirectory, "delivery.json");
  const privateValue = "private@example.invalid";
  const bytes = new TextEncoder().encode(
    `{"record_id":"record-1","work_email":"${privateValue}"}\n`
  );
  const transport = fetchFrom((request) => {
    const pathname = new URL(request.url).pathname;
    if (pathname === "/v1/dataset-exports") {
      return new Response(bytes, {
        headers: streamingDatasetExportHeaders(bytes, "jsonl", true),
      });
    }
    assert.equal(pathname, "/v1/export-deliveries/delivery-cli-test");
    return jsonResponse({
      content_hash: `sha256:${createHash("sha256")
        .update(bytes)
        .digest("hex")}`,
      content_length: bytes.byteLength,
      dataset_id: "dataset-cli-test",
      delivered_at_ms: 1_752_700_001_000,
      delivery_id: "delivery-cli-test",
      expires_at_ms: 1_752_786_400_000,
      format: "jsonl",
      prepared_at_ms: 1_752_700_000_000,
      state: "delivered",
    });
  });
  try {
    const result = await invokeDatasetExport(TEST_ENDPOINT, {
      fetch: transport,
      receiptFile,
    });
    assert.equal(result.exitCode, 0);
    assert.equal(result.stderr, "");
    assert.equal(result.stdout, new TextDecoder().decode(bytes));
    const receiptContent = await readFile(receiptFile, "utf8");
    assert.equal(receiptContent.includes(privateValue), false);
    assert.deepEqual(JSON.parse(receiptContent), {
      byte_count: bytes.byteLength,
      dataset_id: "dataset-cli-test",
      delivery_id: "delivery-cli-test",
      delivery_state: "delivered",
      expires_at_ms: 1_752_786_400_000,
      format: "jsonl",
      sha256: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
    });
    assert.equal((await stat(receiptFile)).mode % 0o1000, 0o600);
    assert.deepEqual(await readdir(temporaryDirectory), ["delivery.json"]);
  } finally {
    await rm(temporaryDirectory, { force: true, recursive: true });
  }
});

test("dataset export keeps a private recovery receipt when delivery readback fails after stdout", async () => {
  const temporaryDirectory = await mkdtemp(
    path.join(tmpdir(), "kurobara-cli-dataset-stdout-recovery-")
  );
  const receiptFile = path.join(temporaryDirectory, "delivery.json");
  const privateValue = "private@example.invalid";
  const bytes = new TextEncoder().encode(
    `{"record_id":"record-1","work_email":"${privateValue}"}\n`
  );
  const expectedReceipt = {
    byte_count: bytes.byteLength,
    dataset_id: "dataset-cli-test",
    delivery_id: "delivery-cli-test",
    delivery_state: "prepared",
    expires_at_ms: 1_752_786_400_000,
    format: "jsonl",
    sha256: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
  };
  let receiptAtFirstBodyPull: unknown;
  const body = new ReadableStream<Uint8Array>(
    {
      pull: async (controller) => {
        receiptAtFirstBodyPull = JSON.parse(
          await readFile(receiptFile, "utf8")
        );
        controller.enqueue(bytes);
        controller.close();
      },
    },
    { highWaterMark: 0 }
  );
  const transport = fetchFrom((request) => {
    if (new URL(request.url).pathname === "/v1/dataset-exports") {
      return new Response(body, {
        headers: streamingDatasetExportHeaders(bytes, "jsonl", true),
      });
    }
    throw new Error("synthetic delivery lookup failure");
  });
  try {
    const result = await invokeDatasetExport(TEST_ENDPOINT, {
      fetch: transport,
      receiptFile,
    });
    assert.equal(result.exitCode, 75);
    assert.equal(result.stdout, new TextDecoder().decode(bytes));
    assert.equal(result.stderr.includes(privateValue), false);
    assert.equal(
      Reflect.get(JSON.parse(result.stderr) as object, "code"),
      "cli-transport-error"
    );
    assert.deepEqual(receiptAtFirstBodyPull, expectedReceipt);
    assert.deepEqual(
      JSON.parse(await readFile(receiptFile, "utf8")),
      expectedReceipt
    );
    assert.equal((await stat(receiptFile)).mode % 0o1000, 0o600);
    assert.deepEqual(await readdir(temporaryDirectory), ["delivery.json"]);
  } finally {
    await rm(temporaryDirectory, { force: true, recursive: true });
  }
});

test("dataset export preserves an existing stdout receipt without network or byte output", async () => {
  const temporaryDirectory = await mkdtemp(
    path.join(tmpdir(), "kurobara-cli-dataset-receipt-existing-")
  );
  const receiptFile = path.join(temporaryDirectory, "delivery.json");
  const sentinel = '{"owned":"elsewhere"}\n';
  await writeFile(receiptFile, sentinel, { mode: 0o600 });
  let calls = 0;
  try {
    const result = await invokeDatasetExport(TEST_ENDPOINT, {
      fetch: () => {
        calls += 1;
        return Promise.reject(new Error("must not execute"));
      },
      receiptFile,
    });
    assert.equal(result.exitCode, 74);
    assert.equal(result.stdout, "");
    assert.equal(calls, 0);
    assert.equal(await readFile(receiptFile, "utf8"), sentinel);
    assert.deepEqual(await readdir(temporaryDirectory), ["delivery.json"]);
  } finally {
    await rm(temporaryDirectory, { force: true, recursive: true });
  }
});

test("dataset export waits for stdout backpressure before completing", async () => {
  const bytes = new TextEncoder().encode("record_id,name\n1,Example\n");
  const stdoutChunks: Uint8Array[] = [];
  const stderr = capture();
  let drains = 0;
  const exitCode = await runCli({
    argv: [
      "dataset",
      "export",
      "--dataset-id",
      "dataset-cli-test",
      "--format",
      "csv",
    ],
    environment: { KUROBARA_API_KEY: "synthetic-api-key" },
    fetch: fetchFrom(
      () =>
        new Response(bytes, {
          headers: streamingDatasetExportHeaders(bytes, "csv"),
        })
    ),
    stderr: stderr.target,
    stdin: Readable.from([]),
    stdout: {
      off: () => undefined,
      once: (_event, listener) => {
        drains += 1;
        queueMicrotask(listener);
      },
      write: (chunk) => {
        assert.ok(chunk instanceof Uint8Array);
        stdoutChunks.push(chunk);
        return false;
      },
    },
  });
  assert.equal(exitCode, 0);
  assert.equal(stderr.value(), "");
  assert.equal(drains, 1);
  assert.deepEqual(Buffer.concat(stdoutChunks), Buffer.from(bytes));
});

test("dataset export atomically publishes an explicit output and prints one receipt", async () => {
  const temporaryDirectory = await mkdtemp(
    path.join(tmpdir(), "kurobara-cli-dataset-export-")
  );
  const outputFile = path.join(temporaryDirectory, "dataset.csv");
  const receiptFile = path.join(temporaryDirectory, "dataset.receipt.json");
  const bytes = new TextEncoder().encode("record_id,company_name\n1,Example\n");
  const transport = fetchFrom((request) => {
    const pathname = new URL(request.url).pathname;
    if (pathname === "/v1/dataset-exports") {
      return new Response(bytes, {
        headers: streamingDatasetExportHeaders(bytes, "csv", true),
      });
    }
    assert.equal(pathname, "/v1/export-deliveries/delivery-cli-test");
    assert.equal(request.method, "GET");
    return jsonResponse({
      content_hash: `sha256:${createHash("sha256")
        .update(bytes)
        .digest("hex")}`,
      content_length: bytes.byteLength,
      dataset_id: "dataset-cli-test",
      delivered_at_ms: 1_752_700_001_000,
      delivery_id: "delivery-cli-test",
      expires_at_ms: 1_752_786_400_000,
      format: "csv",
      prepared_at_ms: 1_752_700_000_000,
      state: "delivered",
    });
  });
  try {
    const result = await invokeDatasetExport(TEST_ENDPOINT, {
      fetch: transport,
      format: "csv",
      outputFile,
      receiptFile,
    });
    const expectedSha256 = `sha256:${createHash("sha256")
      .update(bytes)
      .digest("hex")}`;
    assert.equal(result.exitCode, 0);
    assert.equal(result.stderr, "");
    assert.deepEqual(JSON.parse(result.stdout), {
      byte_count: bytes.byteLength,
      dataset_id: "dataset-cli-test",
      delivery_id: "delivery-cli-test",
      delivery_state: "delivered",
      expires_at_ms: 1_752_786_400_000,
      format: "csv",
      sha256: expectedSha256,
    });
    assert.deepEqual(await readFile(outputFile), Buffer.from(bytes));
    assert.deepEqual(
      JSON.parse(await readFile(receiptFile, "utf8")),
      JSON.parse(result.stdout)
    );
    assert.equal((await stat(outputFile)).mode % 0o1000, 0o600);
    assert.equal((await stat(receiptFile)).mode % 0o1000, 0o600);
    assert.deepEqual((await readdir(temporaryDirectory)).sort(), [
      "dataset.csv",
      "dataset.receipt.json",
    ]);
  } finally {
    await rm(temporaryDirectory, { force: true, recursive: true });
  }
});

test("dataset export leaves no file or receipt when tracked delivery confirmation fails", async () => {
  const temporaryDirectory = await mkdtemp(
    path.join(tmpdir(), "kurobara-cli-dataset-export-failed-proof-")
  );
  const outputFile = path.join(temporaryDirectory, "dataset.csv");
  const receiptFile = path.join(temporaryDirectory, "dataset.receipt.json");
  const bytes = new TextEncoder().encode("record_id,company_name\n1,Example\n");
  const transport = fetchFrom((request) => {
    if (new URL(request.url).pathname === "/v1/dataset-exports") {
      return new Response(bytes, {
        headers: streamingDatasetExportHeaders(bytes, "csv", true),
      });
    }
    throw new Error("synthetic delivery lookup failure");
  });
  try {
    const result = await invokeDatasetExport(TEST_ENDPOINT, {
      fetch: transport,
      format: "csv",
      outputFile,
      receiptFile,
    });
    assert.equal(result.exitCode, 75);
    assert.equal(result.stdout, "");
    assert.equal(
      Reflect.get(JSON.parse(result.stderr) as object, "code"),
      "cli-transport-error"
    );
    await assert.rejects(readFile(outputFile));
    await assert.rejects(readFile(receiptFile));
    assert.deepEqual(await readdir(temporaryDirectory), []);
  } finally {
    await rm(temporaryDirectory, { force: true, recursive: true });
  }
});

test("dataset export rejects duplicate field selection before network I/O", async () => {
  let calls = 0;
  const result = await invokeDatasetExport(TEST_ENDPOINT, {
    fetch: () => {
      calls += 1;
      return Promise.reject(new Error("must not execute"));
    },
    fieldIds: ["field-name", "field-name"],
  });
  assert.equal(result.exitCode, 2);
  assert.equal(result.stdout, "");
  assert.equal(
    Reflect.get(JSON.parse(result.stderr) as object, "code"),
    "cli-usage-error"
  );
  assert.equal(calls, 0);
});

test("dataset export maps canonical problems with generated exit metadata", async () => {
  const problem = {
    code: "export-too-large",
    retryable: false,
    status: 413,
    title: "Export too large",
    type: "https://problems.kurobara.invalid/export-too-large",
  } as const;
  const result = await invokeDatasetExport(TEST_ENDPOINT, {
    fetch: fetchFrom(() =>
      jsonResponse(problem, 413, "application/problem+json")
    ),
  });
  assert.equal(result.exitCode, 2);
  assert.equal(result.stdout, "");
  assert.deepEqual(JSON.parse(result.stderr), problem);
});

test("reads and revokes export delivery state with lean dataset commands", async () => {
  const response = {
    content_hash: `sha256:${"a".repeat(64)}`,
    content_length: 42,
    dataset_id: "dataset-cli-test",
    delivery_id: "delivery-cli-test",
    expires_at_ms: 1_752_786_400_000,
    format: "jsonl",
    prepared_at_ms: 1_752_700_000_000,
    revoked_at_ms: 1_752_700_002_000,
    state: "revoked",
  } as const;
  const requests: { body: string; method: string; path: string }[] = [];
  const transport = fetchFrom(async (request) => {
    requests.push({
      body: await request.text(),
      method: request.method,
      path: new URL(request.url).pathname,
    });
    return jsonResponse(response);
  });

  for (const command of ["export-status", "export-revoke"] as const) {
    const stdout = capture();
    const stderr = capture();
    const exitCode = await runCli({
      argv: [
        "dataset",
        command,
        "--endpoint",
        TEST_ENDPOINT,
        "--delivery-id",
        "delivery-cli-test",
      ],
      environment: { KUROBARA_API_KEY: "synthetic-api-key" },
      fetch: transport,
      stderr: stderr.target,
      stdin: Readable.from([]),
      stdout: stdout.target,
    });
    assert.equal(exitCode, 0);
    assert.equal(stderr.value(), "");
    assert.deepEqual(JSON.parse(stdout.value()), response);
  }
  assert.deepEqual(requests, [
    {
      body: "",
      method: "GET",
      path: "/v1/export-deliveries/delivery-cli-test",
    },
    {
      body: "{}",
      method: "POST",
      path: "/v1/export-deliveries/delivery-cli-test/revoke",
    },
  ]);
});

test("registers a contact restriction from stdin without putting the raw subject in argv or output", async () => {
  const rawSubject = "privacy-subject@example.invalid";
  let calls = 0;
  const transport = fetchFrom(async (request) => {
    calls += 1;
    assert.deepEqual(JSON.parse(await request.text()), {
      idempotency_key: "privacy-cli-test",
      reason: "operator-subject-request",
      subject: { kind: "email", value: rawSubject },
    });
    return jsonResponse({
      affected_delivery_count: 2,
      newly_revoked_delivery_count: 1,
      reason: "operator-subject-request",
      registered_at_ms: 1_752_700_000_000,
      replayed: false,
      tombstone_id: "privacy-ts-cli-test",
    });
  });
  const stdout = capture();
  const stderr = capture();
  const argv = [
    "contact",
    "restrict",
    "--endpoint",
    TEST_ENDPOINT,
    "--kind",
    "email",
    "--value-file",
    "-",
    "--reason",
    "operator-subject-request",
    "--idempotency-key",
    "privacy-cli-test",
  ];
  assert.equal(argv.includes(rawSubject), false);
  const exitCode = await runCli({
    argv,
    environment: { KUROBARA_API_KEY: "synthetic-api-key" },
    fetch: transport,
    stderr: stderr.target,
    stdin: Readable.from([`${rawSubject}\n`]),
    stdout: stdout.target,
  });
  assert.equal(exitCode, 0);
  assert.equal(stderr.value(), "");
  assert.equal(stdout.value().includes(rawSubject), false);
  assert.equal(calls, 1);

  const invalidStdout = capture();
  const invalidStderr = capture();
  const invalidExitCode = await runCli({
    argv: [
      "contact",
      "restrict",
      "--kind",
      "email",
      "--value-file",
      "-",
      "--provider-key",
      "synthetic-provider",
      "--reason",
      "operator-subject-request",
      "--idempotency-key",
      "privacy-cli-test",
    ],
    environment: { KUROBARA_API_KEY: "synthetic-api-key" },
    fetch: transport,
    stderr: invalidStderr.target,
    stdin: Readable.from([rawSubject]),
    stdout: invalidStdout.target,
  });
  assert.equal(invalidExitCode, 2);
  assert.equal(invalidStdout.value(), "");
  assert.equal(invalidStderr.value().includes(rawSubject), false);
  assert.equal(calls, 1);
});

test("contact restriction guidance requires a file or stdin instead of a raw value flag", async () => {
  const stdout = capture();
  const stderr = capture();
  const exitCode = await runCli({
    argv: [
      "contact",
      "restrict",
      "--kind",
      "email",
      "--reason",
      "operator-subject-request",
      "--idempotency-key",
      "privacy-guidance-cli-test",
    ],
    environment: { KUROBARA_API_KEY: "synthetic-api-key" },
    fetch: () => Promise.reject(new Error("must not execute")),
    stderr: stderr.target,
    stdin: Readable.from([]),
    stdout: stdout.target,
  });
  assert.equal(exitCode, 2);
  assert.equal(stdout.value(), "");
  assert.equal(
    Reflect.get(JSON.parse(stderr.value()) as object, "title"),
    "Contact restrict requires --kind email|provider-subject, --value-file PATH|-, --reason and --idempotency-key; --provider-key is required only for provider-subject."
  );
});

test("registers a provider contact restriction from a bounded regular value file", async () => {
  const temporaryDirectory = await mkdtemp(
    path.join(tmpdir(), "kurobara-cli-contact-restrict-")
  );
  const valueFile = path.join(temporaryDirectory, "subject.txt");
  const rawSubject = "provider-subject-synthetic";
  await writeFile(valueFile, rawSubject, { mode: 0o600 });
  const stdout = capture();
  const stderr = capture();
  try {
    const exitCode = await runCli({
      argv: [
        "contact",
        "restrict",
        "--endpoint",
        TEST_ENDPOINT,
        "--kind",
        "provider-subject",
        "--provider-key",
        "synthetic-provider",
        "--value-file",
        valueFile,
        "--reason",
        "provider-deletion",
        "--idempotency-key",
        "privacy-provider-cli-test",
      ],
      environment: { KUROBARA_API_KEY: "synthetic-api-key" },
      fetch: fetchFrom(async (request) => {
        assert.deepEqual(JSON.parse(await request.text()), {
          idempotency_key: "privacy-provider-cli-test",
          reason: "provider-deletion",
          subject: {
            kind: "provider-subject",
            provider_key: "synthetic-provider",
            value: rawSubject,
          },
        });
        return jsonResponse({
          affected_delivery_count: 0,
          newly_revoked_delivery_count: 0,
          reason: "provider-deletion",
          registered_at_ms: 1_752_700_000_000,
          replayed: false,
          tombstone_id: "privacy-ts-provider-cli-test",
        });
      }),
      stderr: stderr.target,
      stdin: Readable.from([]),
      stdout: stdout.target,
    });
    assert.equal(exitCode, 0);
    assert.equal(stderr.value().includes(rawSubject), false);
    assert.equal(stdout.value().includes(rawSubject), false);
  } finally {
    await rm(temporaryDirectory, { force: true, recursive: true });
  }
});

test("contact restriction rejects symlinked and oversized value files without leaking their content", async () => {
  const temporaryDirectory = await mkdtemp(
    path.join(tmpdir(), "kurobara-cli-contact-restrict-invalid-")
  );
  const rawSubject = "private-subject@example.invalid";
  const valueFile = path.join(temporaryDirectory, "subject.txt");
  const linkedValueFile = path.join(temporaryDirectory, "subject-link.txt");
  const oversizedValueFile = path.join(temporaryDirectory, "oversized.txt");
  await writeFile(valueFile, rawSubject, { mode: 0o600 });
  await symlink(valueFile, linkedValueFile);
  await writeFile(oversizedValueFile, "x".repeat(4097), { mode: 0o600 });
  let calls = 0;
  try {
    for (const unsafeValueFile of [linkedValueFile, oversizedValueFile]) {
      const stdout = capture();
      const stderr = capture();
      const exitCode = await runCli({
        argv: [
          "contact",
          "restrict",
          "--kind",
          "email",
          "--value-file",
          unsafeValueFile,
          "--reason",
          "operator-subject-request",
          "--idempotency-key",
          "privacy-invalid-cli-test",
        ],
        environment: { KUROBARA_API_KEY: "synthetic-api-key" },
        fetch: () => {
          calls += 1;
          return Promise.reject(new Error("must not execute"));
        },
        stderr: stderr.target,
        stdin: Readable.from([]),
        stdout: stdout.target,
      });
      assert.equal(exitCode, 2);
      assert.equal(stdout.value(), "");
      assert.equal(stderr.value().includes(rawSubject), false);
    }
    assert.equal(calls, 0);
  } finally {
    await rm(temporaryDirectory, { force: true, recursive: true });
  }
});

test("recipe export streams to a private atomically published file and prints one receipt", async () => {
  const temporaryDirectory = await mkdtemp(
    path.join(tmpdir(), "kurobara-cli-export-happy-")
  );
  const outputFile = path.join(temporaryDirectory, "result.jsonl");
  const bytes = new TextEncoder().encode(
    '{"record_id":"record-1","website":"https://example.invalid"}\n'
  );
  let requestBody: unknown;
  const transport = fetchFrom(async (request) => {
    assert.equal(request.method, "POST");
    assert.equal(
      new URL(request.url).pathname,
      "/v1/recipe-application-exports"
    );
    assert.equal(
      request.headers.get("authorization"),
      "Bearer synthetic-api-key"
    );
    assert.equal(request.headers.get("content-type"), "application/json");
    requestBody = JSON.parse(await request.text());
    return new Response(bytes, { headers: exportHeaders(bytes) });
  });
  try {
    const result = await invokeRecipeExport(TEST_ENDPOINT, outputFile, {
      fetch: transport,
      fieldIds: ["field-domain", "field-website"],
    });
    const expectedSha256 = `sha256:${createHash("sha256")
      .update(bytes)
      .digest("hex")}`;
    assert.equal(result.exitCode, 0);
    assert.equal(result.stderr, "");
    assert.equal(result.stdout.trim().split("\n").length, 1);
    assert.deepEqual(JSON.parse(result.stdout), {
      application_id: "application-cli-test",
      byte_count: bytes.byteLength,
      format: "jsonl",
      sha256: expectedSha256,
    });
    assert.deepEqual(requestBody, {
      application_id: "application-cli-test",
      field_ids: ["field-domain", "field-website"],
      format: "jsonl",
    });
    assert.deepEqual(await readFile(outputFile), Buffer.from(bytes));
    assert.equal((await stat(outputFile)).mode % 0o1000, 0o600);
    assert.deepEqual(await readdir(temporaryDirectory), ["result.jsonl"]);
  } finally {
    await rm(temporaryDirectory, { force: true, recursive: true });
  }
});

test("recipe export rejects invalid flags and duplicate field selection before I/O", async () => {
  const candidates = [
    [
      "recipe",
      "export",
      "--application-id",
      "application-cli-test",
      "--format",
      "jsonl",
      "--output",
      "-",
      "--timeout-ms",
      "1000",
    ],
    [
      "recipe",
      "export",
      "--application-id",
      "application-cli-test",
      "--format",
      "jsonl",
      "--output",
      "result.jsonl",
      "--timeout-ms",
      "0",
    ],
    [
      "recipe",
      "export",
      "--application-id",
      "application-cli-test",
      "--format",
      "jsonl",
      "--output",
      "result.jsonl",
      "--timeout-ms",
      "1000",
      "--field-id",
      "field-domain",
      "--field-id",
      "field-domain",
    ],
    [
      "recipe",
      "export",
      "--application-id",
      "application-cli-test",
      "--format",
      "jsonl",
      "--output",
      "result.jsonl",
      "--timeout-ms",
      "1000",
      "--output",
      "other.jsonl",
    ],
  ];
  for (const argv of candidates) {
    const stdout = capture();
    const stderr = capture();
    const exitCode = await runCli({
      argv,
      environment: { KUROBARA_API_KEY: "must-not-appear" },
      stderr: stderr.target,
      stdin: Readable.from([]),
      stdout: stdout.target,
    });
    assert.equal(exitCode, 2);
    assert.equal(stdout.value(), "");
    assert.equal(
      Reflect.get(JSON.parse(stderr.value()) as object, "code"),
      "cli-usage-error"
    );
    assert.equal(stderr.value().includes("must-not-appear"), false);
  }
});

test("recipe export preserves an existing destination and cleans invalid downloads", async () => {
  const temporaryDirectory = await mkdtemp(
    path.join(tmpdir(), "kurobara-cli-export-safe-")
  );
  const existingFile = path.join(temporaryDirectory, "existing.jsonl");
  const existingDirectory = path.join(temporaryDirectory, "directory.jsonl");
  const rejectedFile = path.join(temporaryDirectory, "rejected.jsonl");
  const symlinkFile = path.join(temporaryDirectory, "symlink.jsonl");
  const bytes = new TextEncoder().encode('{"record_id":"record-1"}\n');
  await writeFile(existingFile, "keep-me", { mode: 0o640 });
  await mkdir(existingDirectory);
  await symlink(existingFile, symlinkFile);
  let invalidHash = false;
  const transport = fetchFrom(
    () =>
      new Response(bytes, {
        headers: exportHeaders(
          bytes,
          "jsonl",
          invalidHash
            ? { "x-kurobara-content-sha256": `sha256:${"0".repeat(64)}` }
            : {}
        ),
      })
  );
  try {
    const collision = await invokeRecipeExport(TEST_ENDPOINT, existingFile, {
      fetch: transport,
    });
    assert.equal(collision.exitCode, 74);
    assert.equal(collision.stdout, "");
    assert.equal(
      Reflect.get(JSON.parse(collision.stderr) as object, "code"),
      "cli-output-error"
    );
    assert.equal(await readFile(existingFile, "utf8"), "keep-me");
    assert.equal((await stat(existingFile)).mode % 0o1000, 0o640);
    for (const destination of [existingDirectory, symlinkFile]) {
      const protectedResult = await invokeRecipeExport(
        TEST_ENDPOINT,
        destination,
        { fetch: transport }
      );
      assert.equal(protectedResult.exitCode, 74);
      assert.equal(protectedResult.stdout, "");
    }
    assert.equal((await lstat(existingDirectory)).isDirectory(), true);
    assert.equal((await lstat(symlinkFile)).isSymbolicLink(), true);
    assert.equal(await readFile(symlinkFile, "utf8"), "keep-me");

    invalidHash = true;
    const mismatch = await invokeRecipeExport(TEST_ENDPOINT, rejectedFile, {
      fetch: transport,
    });
    assert.equal(mismatch.exitCode, 70);
    assert.equal(mismatch.stdout, "");
    assert.equal(
      Reflect.get(JSON.parse(mismatch.stderr) as object, "code"),
      "cli-contract-error"
    );
    await assert.rejects(stat(rejectedFile));
    assert.deepEqual((await readdir(temporaryDirectory)).sort(), [
      "directory.jsonl",
      "existing.jsonl",
      "symlink.jsonl",
    ]);
  } finally {
    await rm(temporaryDirectory, { force: true, recursive: true });
  }
});

test("recipe export cleans truncated, timed out, and aborted downloads", async () => {
  const temporaryDirectory = await mkdtemp(
    path.join(tmpdir(), "kurobara-cli-export-interrupted-")
  );
  const prefix = new TextEncoder().encode('{"record_id":');
  const declared = new Uint8Array(prefix.byteLength + 20);
  let truncate = true;
  const transport = fetchFrom((request) => {
    const stream = new ReadableStream<Uint8Array>({
      start: (controller) => {
        controller.enqueue(prefix);
        if (truncate) {
          controller.error(new TypeError("synthetic truncated response"));
          return;
        }
        request.signal.addEventListener(
          "abort",
          () => controller.error(new DOMException("Aborted", "AbortError")),
          { once: true }
        );
      },
    });
    return new Response(stream, { headers: exportHeaders(declared) });
  });
  try {
    const truncatedFile = path.join(temporaryDirectory, "truncated.jsonl");
    const truncated = await invokeRecipeExport(TEST_ENDPOINT, truncatedFile, {
      fetch: transport,
    });
    assert.equal(truncated.exitCode, 75);
    assert.equal(truncated.stdout, "");
    assert.equal(
      Reflect.get(JSON.parse(truncated.stderr) as object, "code"),
      "cli-transport-error"
    );
    await assert.rejects(stat(truncatedFile));

    truncate = false;
    const timeoutFile = path.join(temporaryDirectory, "timeout.jsonl");
    const timedOut = await invokeRecipeExport(TEST_ENDPOINT, timeoutFile, {
      fetch: transport,
      timeoutMs: 20,
    });
    assert.equal(timedOut.exitCode, 75);
    assert.equal(timedOut.stdout, "");
    assert.equal(
      Reflect.get(JSON.parse(timedOut.stderr) as object, "code"),
      "cli-export-timeout"
    );
    await assert.rejects(stat(timeoutFile));

    const abortedFile = path.join(temporaryDirectory, "aborted.jsonl");
    const controller = new AbortController();
    const abortTimer = setTimeout(() => controller.abort(), 20);
    const aborted = await invokeRecipeExport(TEST_ENDPOINT, abortedFile, {
      fetch: transport,
      signal: controller.signal,
      timeoutMs: 10_000,
    });
    clearTimeout(abortTimer);
    assert.equal(aborted.exitCode, 130);
    assert.equal(aborted.stdout, "");
    assert.equal(
      Reflect.get(JSON.parse(aborted.stderr) as object, "code"),
      "cli-export-aborted"
    );
    await assert.rejects(stat(abortedFile));
    assert.deepEqual(await readdir(temporaryDirectory), []);
  } finally {
    await rm(temporaryDirectory, { force: true, recursive: true });
  }
});

test("recipe watch polls to terminal state and prints only the final snapshot", async () => {
  const watched = watchTransport((call) =>
    call === 1 ? runningWatchBody : succeededWatchBody
  );
  let now = 0;
  const result = await invokeRecipeWatch(TEST_ENDPOINT, {
    fetch: watched.fetch,
    now: () => now,
    pollIntervalMs: 100,
    timeoutMs: 1000,
    wait: (milliseconds) => {
      now += milliseconds;
      return Promise.resolve();
    },
  });

  assert.equal(result.exitCode, 0);
  assert.equal(result.stderr, "");
  assert.equal(result.stdout.trim().split("\n").length, 1);
  assert.deepEqual(JSON.parse(result.stdout), succeededWatchBody);
  assert.equal(watched.calls(), 2);
  assert.deepEqual(watched.requests, [
    {
      authorization: "Bearer synthetic-api-key",
      method: "GET",
      url: "/v1/recipe-applications/application-cli-test",
    },
    {
      authorization: "Bearer synthetic-api-key",
      method: "GET",
      url: "/v1/recipe-applications/application-cli-test",
    },
  ]);
});

test("recipe watch reports a stable local timeout without a snapshot", async () => {
  const watched = watchTransport(() => runningWatchBody);
  let now = 0;
  const result = await invokeRecipeWatch(TEST_ENDPOINT, {
    fetch: watched.fetch,
    now: () => now,
    pollIntervalMs: 100,
    timeoutMs: 250,
    wait: (milliseconds) => {
      now += milliseconds;
      return Promise.resolve();
    },
  });

  assert.equal(result.exitCode, 75);
  assert.equal(result.stdout, "");
  assert.deepEqual(JSON.parse(result.stderr), {
    code: "cli-watch-timeout",
    retryable: false,
    status: 0,
    title: "Recipe application watch timed out.",
    type: "about:blank",
  });
  assert.equal(watched.calls(), 3);
});

test("recipe watch stops immediately when replay is required", async () => {
  const watched = watchTransport(() => needsReplayWatchBody);
  const result = await invokeRecipeWatch(TEST_ENDPOINT, {
    fetch: watched.fetch,
    timeoutMs: 1000,
    wait: () => {
      throw new Error("watch must not wait after needs_replay");
    },
  });

  assert.equal(result.exitCode, 0);
  assert.equal(result.stderr, "");
  assert.deepEqual(JSON.parse(result.stdout), needsReplayWatchBody);
  assert.equal(watched.calls(), 1);
});

test("recipe watch timeout zero performs exactly one snapshot", async () => {
  const watched = watchTransport(() => runningWatchBody);
  const result = await invokeRecipeWatch(TEST_ENDPOINT, {
    fetch: watched.fetch,
    timeoutMs: 0,
    wait: () => {
      throw new Error("snapshot mode must not wait");
    },
  });

  assert.equal(result.exitCode, 0);
  assert.equal(result.stderr, "");
  assert.deepEqual(JSON.parse(result.stdout), runningWatchBody);
  assert.equal(watched.calls(), 1);
});

test("recipe watch maps an injected abort to exit 130", async () => {
  const watched = watchTransport(() => runningWatchBody);
  const controller = new AbortController();
  const result = await invokeRecipeWatch(TEST_ENDPOINT, {
    fetch: watched.fetch,
    pollIntervalMs: 100,
    signal: controller.signal,
    timeoutMs: 1000,
    wait: () => {
      controller.abort();
      return Promise.resolve();
    },
  });

  assert.equal(result.exitCode, 130);
  assert.equal(result.stdout, "");
  assert.deepEqual(JSON.parse(result.stderr), {
    code: "cli-watch-aborted",
    retryable: false,
    status: 0,
    title: "Recipe application watch was aborted.",
    type: "about:blank",
  });
  assert.equal(watched.calls(), 1);
});

test("company search sends explicit provider-neutral bounds without a request file", async () => {
  const stdout = capture();
  const stderr = capture();
  const responseBody = {
    dataset_id: "dataset-cli-companies",
    generation_id: "generation-cli-companies",
    generation_plan_id: "generation-plan-cli-companies",
    mode: "start",
    plan_hash: `sha256:${"c".repeat(64)}`,
    query_hash: `sha256:${"d".repeat(64)}`,
    quote: {
      expires_at_ms: 1_752_700_030_000,
      guarantee: "hard",
      unit: "credits",
      upper_bound: 8,
    },
    replayed: false,
    state: "building",
    workspace_id: "workspace-cli-test",
  } as const;
  const exitCode = await runCli({
    argv: [
      "company",
      "search",
      "--authority-envelope-id",
      "authority-cli-test",
      "--budget-limit",
      "10",
      "--budget-unit",
      "credits",
      "--country",
      "FR",
      "--dataset-id",
      "dataset-cli-companies",
      "--dataset-name",
      "Synthetic companies",
      "--deadline-ms",
      "1752700060000",
      "--discovery-id",
      "discovery-cli-test",
      "--endpoint",
      TEST_ENDPOINT,
      "--industry",
      "software",
      "--max-calls",
      "2",
      "--max-companies",
      "50",
      "--max-pages",
      "2",
      "--mode",
      "start",
    ],
    environment: { KUROBARA_API_KEY: "synthetic-api-key" },
    fetch: fetchFrom(async (request) => {
      assert.equal(
        new URL(request.url).pathname,
        "/v1/organization-discoveries"
      );
      const body = await request.json();
      assert.deepEqual(Reflect.get(body as object, "query"), {
        country_codes: ["FR"],
        country_scope: "headquarters",
        industry_codes: ["software"],
        industry_taxonomy: "kurobara-v1",
        result_kind: "company",
      });
      assert.deepEqual(Reflect.get(body as object, "limits"), {
        max_calls: 2,
        max_companies: 50,
        max_pages: 2,
      });
      return jsonResponse(responseBody);
    }),
    stderr: stderr.target,
    stdin: Readable.from([]),
    stdout: stdout.target,
  });
  assert.equal(exitCode, 0);
  assert.equal(stderr.value(), "");
  assert.deepEqual(JSON.parse(stdout.value()), responseBody);
});

test("contact results prints one privacy-safe bounded candidate page as JSON", async () => {
  const stdout = capture();
  const stderr = capture();
  const responseBody = {
    dataset_id: "dataset-cli-contacts",
    generation_id: "generation-cli-contacts",
    items: [
      {
        candidate: {
          contact_id: "contact-cli-test",
          department: "sales",
          display_name: "Synthetic Contact",
          identity_completeness: "full",
          job_title: "Sales Director",
          observed_at_ms: 1_752_700_001_000,
          organization_domain: "example.invalid",
          organization_id: "company-cli-test",
          organization_name: "Synthetic Company",
          person_country_code: "ES",
          profile_url: "https://social.example/synthetic-contact",
          seniority: "director",
        },
        ordinal: 3,
      },
    ],
    page: {
      after_ordinal: 2,
      has_more: false,
      limit: 1,
      next_after_ordinal: null,
    },
    provenance: {
      capability_id: "contacts.discover",
      capability_version: "1.0.0",
      completed_at_ms: 1_752_700_002_000,
      completion_reason: "source-completed",
      coverage: {
        basis: "locked_provider_route",
        status: "complete_for_declared_source",
      },
      generation_plan_id: "generation-plan-cli-contacts",
      materialization_content_hash: `sha256:${"e".repeat(64)}`,
      materialization_id: "materialization-cli-contacts",
      materialization_revision: 1,
      plan_hash: `sha256:${"a".repeat(64)}`,
      query_hash: `sha256:${"b".repeat(64)}`,
      schema_hash: `sha256:${"c".repeat(64)}`,
    },
    record_count: 3,
    workspace_id: "workspace-cli-test",
  } as const;
  const exitCode = await runCli({
    argv: [
      "contact",
      "results",
      "--after-ordinal",
      "2",
      "--endpoint",
      TEST_ENDPOINT,
      "--generation-id",
      "generation-cli-contacts",
      "--limit",
      "1",
    ],
    environment: { KUROBARA_API_KEY: "synthetic-api-key" },
    fetch: fetchFrom((request) => {
      const url = new URL(request.url);
      assert.equal(
        url.pathname,
        "/v1/dataset-generations/generation-cli-contacts/contact-candidates"
      );
      assert.equal(url.searchParams.get("after_ordinal"), "2");
      assert.equal(url.searchParams.get("limit"), "1");
      return jsonResponse(responseBody);
    }),
    stderr: stderr.target,
    stdin: Readable.from([]),
    stdout: stdout.target,
  });
  assert.equal(exitCode, 0);
  assert.equal(stderr.value(), "");
  assert.deepEqual(JSON.parse(stdout.value()), responseBody);
  assert.doesNotMatch(stdout.value(), CONTACT_SENSITIVE_FIELD_PATTERN);
});

test("contact results rejects an invalid limit before network I/O", async () => {
  let calls = 0;
  const stderr = capture();
  const exitCode = await runCli({
    argv: [
      "contact",
      "results",
      "--generation-id",
      "generation",
      "--limit",
      "101",
    ],
    environment: { KUROBARA_API_KEY: "synthetic-api-key" },
    fetch: fetchFrom(() => {
      calls += 1;
      throw new Error("must not call network");
    }),
    stderr: stderr.target,
    stdin: Readable.from([]),
    stdout: capture().target,
  });
  assert.equal(exitCode, 2);
  assert.equal(calls, 0);
});

test("company results prints one exact bounded candidate page as JSON", async () => {
  const stdout = capture();
  const stderr = capture();
  const responseBody = {
    dataset_id: "dataset-cli-companies",
    generation_id: "generation-cli-companies",
    items: [
      {
        candidate: {
          company_id: "company-cli-test",
          country_code: "FR",
          domain: "example.invalid",
          employee_count: null,
          industry_code: "software",
          name: "Synthetic Company",
          observed_at_ms: 1_752_700_001_000,
        },
        ordinal: 3,
      },
    ],
    page: {
      after_ordinal: 2,
      has_more: false,
      limit: 1,
      next_after_ordinal: null,
    },
    provenance: {
      capability_id: "organizations.discover",
      capability_version: "1.0.0",
      completed_at_ms: 1_752_700_002_000,
      completion_reason: "source-completed",
      coverage: {
        basis: "locked_provider_route",
        status: "complete_for_declared_source",
      },
      generation_plan_id: "generation-plan-cli-companies",
      materialization_content_hash: `sha256:${"e".repeat(64)}`,
      materialization_id: "materialization-cli-companies",
      materialization_revision: 1,
      plan_hash: `sha256:${"a".repeat(64)}`,
      query_hash: `sha256:${"b".repeat(64)}`,
      schema_hash: `sha256:${"c".repeat(64)}`,
    },
    record_count: 3,
    workspace_id: "workspace-cli-test",
  } as const;
  const exitCode = await runCli({
    argv: [
      "company",
      "results",
      "--after-ordinal",
      "2",
      "--endpoint",
      TEST_ENDPOINT,
      "--generation-id",
      "generation-cli-companies",
      "--limit",
      "1",
    ],
    environment: { KUROBARA_API_KEY: "synthetic-api-key" },
    fetch: fetchFrom((request) => {
      const url = new URL(request.url);
      assert.equal(
        url.pathname,
        "/v1/dataset-generations/generation-cli-companies/company-candidates"
      );
      assert.equal(url.searchParams.get("after_ordinal"), "2");
      assert.equal(url.searchParams.get("limit"), "1");
      assert.equal(request.method, "GET");
      return jsonResponse(responseBody);
    }),
    stderr: stderr.target,
    stdin: Readable.from([]),
    stdout: stdout.target,
  });

  assert.equal(exitCode, 0);
  assert.equal(stderr.value(), "");
  assert.deepEqual(JSON.parse(stdout.value()), responseBody);
});

test("company results rejects an invalid limit before network I/O", async () => {
  const stdout = capture();
  const stderr = capture();
  let calls = 0;
  const exitCode = await runCli({
    argv: [
      "company",
      "results",
      "--generation-id",
      "generation-cli-companies",
      "--limit",
      "101",
    ],
    environment: { KUROBARA_API_KEY: "synthetic-api-key" },
    fetch: fetchFrom(() => {
      calls += 1;
      throw new Error("must not call network");
    }),
    stderr: stderr.target,
    stdin: Readable.from([]),
    stdout: stdout.target,
  });

  assert.equal(exitCode, 2);
  assert.equal(calls, 0);
  assert.equal(stdout.value(), "");
  assert.equal(JSON.parse(stderr.value()).code, "cli-usage-error");
});

test("company results maps canonical problems with generated exit metadata", async () => {
  const stdout = capture();
  const stderr = capture();
  const problem = {
    code: "dataset-generation-not-found",
    retryable: false,
    status: 404,
    title: "Dataset generation not found",
    type: "https://problems.kurobara.invalid/dataset-generation-not-found",
  } as const;
  const exitCode = await runCli({
    argv: [
      "company",
      "results",
      "--endpoint",
      TEST_ENDPOINT,
      "--generation-id",
      "generation-cli-missing",
    ],
    environment: { KUROBARA_API_KEY: "synthetic-api-key" },
    fetch: fetchFrom(() =>
      jsonResponse(problem, 404, "application/problem+json")
    ),
    stderr: stderr.target,
    stdin: Readable.from([]),
    stdout: stdout.target,
  });

  assert.equal(exitCode, 4);
  assert.equal(stdout.value(), "");
  assert.deepEqual(JSON.parse(stderr.value()), problem);
});

test("company results labels SDK input rejection with its own command", async () => {
  const stdout = capture();
  const stderr = capture();
  let calls = 0;
  const exitCode = await runCli({
    argv: ["company", "results", "--generation-id", "   "],
    environment: { KUROBARA_API_KEY: "synthetic-api-key" },
    fetch: fetchFrom(() => {
      calls += 1;
      throw new Error("must not call network");
    }),
    stderr: stderr.target,
    stdin: Readable.from([]),
    stdout: stdout.target,
  });

  assert.equal(exitCode, 2);
  assert.equal(calls, 0);
  assert.equal(stdout.value(), "");
  assert.deepEqual(JSON.parse(stderr.value()), {
    code: "cli-input-invalid",
    retryable: false,
    status: 0,
    title: "Company results input is invalid.",
    type: "about:blank",
  });
});

test("contact search sends lineage and strict shortlist caps", async () => {
  const stdout = capture();
  const stderr = capture();
  const responseBody = {
    dataset_id: "dataset-cli-contacts",
    generation_plan_id: "generation-plan-cli-contacts",
    mode: "dry-run",
    organization_generation_id: "generation-cli-companies",
    organization_source: {
      generation_id: "generation-cli-companies",
      kind: "generation",
    },
    plan_hash: `sha256:${"e".repeat(64)}`,
    query_hash: `sha256:${"f".repeat(64)}`,
    quote: {
      expires_at_ms: 1_752_700_030_000,
      guarantee: "hard",
      unit: "credits",
      upper_bound: 2,
    },
    replayed: false,
    state: "planned",
    workspace_id: "workspace-cli-test",
  } as const;
  const exitCode = await runCli({
    argv: [
      "contact",
      "search",
      "--authority-envelope-id",
      "authority-cli-test",
      "--budget-limit",
      "2",
      "--budget-unit",
      "credits",
      "--dataset-id",
      "dataset-cli-contacts",
      "--dataset-name",
      "Synthetic contacts",
      "--deadline-ms",
      "1752700060000",
      "--department",
      "sales",
      "--discovery-id",
      "contact-discovery-cli-test",
      "--endpoint",
      TEST_ENDPOINT,
      "--max-calls",
      "2",
      "--max-companies",
      "3",
      "--max-contacts-per-company",
      "2",
      "--max-contacts-total",
      "6",
      "--max-pages",
      "2",
      "--mode",
      "dry-run",
      "--organization-generation-id",
      "generation-cli-companies",
      "--seniority",
      "director",
    ],
    environment: { KUROBARA_API_KEY: "synthetic-api-key" },
    fetch: fetchFrom(async (request) => {
      assert.equal(new URL(request.url).pathname, "/v1/contact-discoveries");
      const body = await request.json();
      assert.deepEqual(Reflect.get(body as object, "limits"), {
        max_calls: 2,
        max_companies: 3,
        max_contacts_per_company: 2,
        max_contacts_total: 6,
        max_pages: 2,
      });
      assert.equal(
        Reflect.get(body as object, "organization_generation_id"),
        "generation-cli-companies"
      );
      return jsonResponse(responseBody);
    }),
    stderr: stderr.target,
    stdin: Readable.from([]),
    stdout: stdout.target,
  });
  assert.equal(exitCode, 0);
  assert.equal(stderr.value(), "");
  assert.deepEqual(JSON.parse(stdout.value()), responseBody);
});

test("contact search accepts an imported organization dataset mapping", async () => {
  const stdout = capture();
  const stderr = capture();
  const responseBody = {
    dataset_id: "dataset-cli-contacts",
    generation_plan_id: "generation-plan-cli-contacts",
    mode: "dry-run",
    organization_source: {
      accepted: 3,
      content_hash: `sha256:${"a".repeat(64)}`,
      dataset_id: "dataset-cli-companies",
      default_country_code: "FR",
      duplicates: 0,
      field_mapping: {
        domain: "website",
        name: "company_name",
      },
      inspected: 3,
      kind: "dataset",
      materialization_id: "materialization-cli-companies",
      rejected: 0,
      source_record_count: 3,
      truncated: false,
    },
    plan_hash: `sha256:${"e".repeat(64)}`,
    query_hash: `sha256:${"f".repeat(64)}`,
    quote: {
      expires_at_ms: 1_752_700_030_000,
      guarantee: "hard",
      unit: "credits",
      upper_bound: 2,
    },
    replayed: false,
    state: "planned",
    workspace_id: "workspace-cli-test",
  } as const;
  const exitCode = await runCli({
    argv: [
      "contact",
      "search",
      "--authority-envelope-id",
      "authority-cli-test",
      "--budget-limit",
      "2",
      "--budget-unit",
      "credits",
      "--dataset-id",
      "dataset-cli-contacts",
      "--dataset-name",
      "Synthetic contacts",
      "--deadline-ms",
      "1752700060000",
      "--default-company-country",
      "FR",
      "--department",
      "purchasing",
      "--discovery-id",
      "contact-discovery-cli-dataset",
      "--domain-field",
      "website",
      "--endpoint",
      TEST_ENDPOINT,
      "--max-calls",
      "2",
      "--max-companies",
      "3",
      "--max-contacts-per-company",
      "1",
      "--max-contacts-total",
      "3",
      "--max-pages",
      "2",
      "--mode",
      "dry-run",
      "--name-field",
      "company_name",
      "--organization-dataset-id",
      "dataset-cli-companies",
      "--seniority",
      "manager",
    ],
    environment: { KUROBARA_API_KEY: "synthetic-api-key" },
    fetch: fetchFrom(async (request) => {
      assert.equal(new URL(request.url).pathname, "/v1/contact-discoveries");
      const body = (await request.json()) as Record<string, unknown>;
      assert.deepEqual(body.organization_dataset, {
        dataset_id: "dataset-cli-companies",
        default_country_code: "FR",
        field_mapping: {
          domain: "website",
          name: "company_name",
        },
      });
      assert.equal("organization_generation_id" in body, false);
      return jsonResponse(responseBody);
    }),
    stderr: stderr.target,
    stdin: Readable.from([]),
    stdout: stdout.target,
  });

  assert.equal(exitCode, 0);
  assert.equal(stderr.value(), "");
  assert.deepEqual(JSON.parse(stdout.value()), responseBody);
});

test("contact enrich-email sends at most the exact selected IDs", async () => {
  const stdout = capture();
  const stderr = capture();
  const responseBody = {
    contact_dataset_id: "dataset-cli-contacts",
    contact_record_ids: ["contact-1", "contact-2"],
    generation_id: "work-email-generation-cli-test",
    generation_plan_id: "work-email-plan-cli-test",
    operation_id: "resolve-cli-test",
    replayed: false,
    result_dataset_id: "work-email-results-cli-test",
    state: "building",
    workspace_id: "workspace-cli-test",
  } as const;
  const exitCode = await runCli({
    argv: [
      "contact",
      "enrich-email",
      "--authority-envelope-id",
      "authority-cli-test",
      "--budget-limit",
      "2",
      "--budget-unit",
      "credits",
      "--contact-dataset-id",
      "dataset-cli-contacts",
      "--deadline-ms",
      "1752700060000",
      "--endpoint",
      TEST_ENDPOINT,
      "--operation-id",
      "resolve-cli-test",
      "--record-id",
      "contact-1",
      "--record-id",
      "contact-2",
    ],
    environment: { KUROBARA_API_KEY: "synthetic-api-key" },
    fetch: fetchFrom(async (request) => {
      assert.equal(
        new URL(request.url).pathname,
        "/v1/contact-work-email-resolutions"
      );
      const body = await request.json();
      assert.deepEqual(Reflect.get(body as object, "contact_record_ids"), [
        "contact-1",
        "contact-2",
      ]);
      return jsonResponse(responseBody);
    }),
    stderr: stderr.target,
    stdin: Readable.from([]),
    stdout: stdout.target,
  });
  assert.equal(exitCode, 0);
  assert.equal(stderr.value(), "");
  assert.deepEqual(JSON.parse(stdout.value()), responseBody);
});

test("contact reveal-identity sends one exact bounded selection and prints its receipt", async () => {
  const stdout = capture();
  const stderr = capture();
  const requestBody = {
    authority_envelope_id: "authority-cli-test",
    budget: { limit: 3, unit: "credits" },
    contact_dataset_id: "dataset-cli-contacts",
    contact_record_ids: ["contact-1", "contact-2", "contact-3"],
    deadline_ms: 1_752_700_060_000,
    operation_id: "identity-reveal-cli-test",
  } as const;
  const receipt = {
    contact_dataset_id: "dataset-cli-contacts",
    contact_record_ids: ["contact-1", "contact-2", "contact-3"],
    generation_id: "identity-generation-cli-test",
    generation_plan_id: "identity-plan-cli-test",
    operation_id: "identity-reveal-cli-test",
    replayed: false,
    result_dataset_id: "identity-results-cli-test",
    state: "building",
    workspace_id: "workspace-cli-test",
  } as const;
  let calls = 0;
  const exitCode = await runCli({
    argv: [
      "contact",
      "reveal-identity",
      "--authority-envelope-id",
      requestBody.authority_envelope_id,
      "--budget-limit",
      String(requestBody.budget.limit),
      "--budget-unit",
      requestBody.budget.unit,
      "--contact-dataset-id",
      requestBody.contact_dataset_id,
      "--deadline-ms",
      String(requestBody.deadline_ms),
      "--endpoint",
      TEST_ENDPOINT,
      "--operation-id",
      requestBody.operation_id,
      "--record-id",
      requestBody.contact_record_ids[0],
      "--record-id",
      requestBody.contact_record_ids[1],
      "--record-id",
      requestBody.contact_record_ids[2],
    ],
    environment: { KUROBARA_API_KEY: "synthetic-api-key" },
    fetch: fetchFrom(async (request) => {
      calls += 1;
      assert.equal(
        new URL(request.url).pathname,
        "/v1/contact-identity-reveals"
      );
      assert.deepEqual(await request.json(), requestBody);
      return jsonResponse(receipt);
    }),
    stderr: stderr.target,
    stdin: Readable.from([]),
    stdout: stdout.target,
  });

  assert.equal(exitCode, 0);
  assert.equal(calls, 1);
  assert.equal(stderr.value(), "");
  assert.deepEqual(JSON.parse(stdout.value()), receipt);
});

test("contact reveal-identity rejects missing, duplicate, and oversized selections", async () => {
  const baseArguments = [
    "contact",
    "reveal-identity",
    "--authority-envelope-id",
    "authority-cli-test",
    "--budget-limit",
    "3",
    "--budget-unit",
    "credits",
    "--contact-dataset-id",
    "dataset-cli-contacts",
    "--deadline-ms",
    "1752700060000",
    "--endpoint",
    TEST_ENDPOINT,
    "--operation-id",
    "identity-reveal-cli-test",
  ] as const;
  const selections = [
    [
      [],
      "Contact derivation commands require one to three unique record IDs plus explicit source dataset, authority, deadline and budget.",
    ],
    [["contact-1", "contact-1"], "Contact derivation arguments are invalid."],
    [
      ["contact-1", "contact-2", "contact-3", "contact-4"],
      "Contact derivation commands require one to three unique record IDs plus explicit source dataset, authority, deadline and budget.",
    ],
  ] as const;
  let calls = 0;

  for (const [selected, expectedTitle] of selections) {
    const stdout = capture();
    const stderr = capture();
    const argv: string[] = [...baseArguments];
    for (const recordId of selected) {
      argv.push("--record-id", recordId);
    }
    const exitCode = await runCli({
      argv,
      environment: { KUROBARA_API_KEY: "synthetic-api-key" },
      fetch: fetchFrom(() => {
        calls += 1;
        return jsonResponse({});
      }),
      stderr: stderr.target,
      stdin: Readable.from([]),
      stdout: stdout.target,
    });

    assert.equal(exitCode, 2);
    assert.equal(stdout.value(), "");
    assert.deepEqual(JSON.parse(stderr.value()), {
      code: "cli-usage-error",
      retryable: false,
      status: 0,
      title: expectedTitle,
      type: "about:blank",
    });
  }
  assert.equal(calls, 0);
});

test("contact reveal-identity maps its generated problem exit code", async () => {
  const stdout = capture();
  const stderr = capture();
  const problem = {
    code: "idempotency-key-reused",
    retryable: false,
    status: 409,
    title: "Idempotency key reused",
    type: "https://problems.kurobara.invalid/idempotency-key-reused",
  } as const;
  const exitCode = await runCli({
    argv: [
      "contact",
      "reveal-identity",
      "--authority-envelope-id",
      "authority-cli-test",
      "--budget-limit",
      "1",
      "--budget-unit",
      "credits",
      "--contact-dataset-id",
      "dataset-cli-contacts",
      "--deadline-ms",
      "1752700060000",
      "--endpoint",
      TEST_ENDPOINT,
      "--operation-id",
      "identity-reveal-cli-test",
      "--record-id",
      "contact-1",
    ],
    environment: { KUROBARA_API_KEY: "synthetic-api-key" },
    fetch: fetchFrom(() =>
      jsonResponse(problem, 409, "application/problem+json")
    ),
    stderr: stderr.target,
    stdin: Readable.from([]),
    stdout: stdout.target,
  });

  assert.equal(exitCode, 5);
  assert.equal(stdout.value(), "");
  assert.deepEqual(JSON.parse(stderr.value()), problem);
});

test("CLI command guidance includes contact reveal-identity", async () => {
  const stdout = capture();
  const stderr = capture();
  const exitCode = await runCli({
    argv: ["contact", "unknown"],
    environment: {},
    stderr: stderr.target,
    stdin: Readable.from([]),
    stdout: stdout.target,
  });

  assert.equal(exitCode, 2);
  assert.equal(stdout.value(), "");
  const failure = JSON.parse(stderr.value()) as { title: string };
  assert.equal(failure.title.includes("contact reveal-identity"), true);
});

test("company watch performs one bounded status read when timeout is zero", async () => {
  const stdout = capture();
  const stderr = capture();
  let calls = 0;
  const snapshot = {
    cost: { reserved: 2, spent: 1, unit: "credits" },
    counters: {
      accepted: 25,
      calls: 1,
      duplicates: 0,
      pages: 1,
      rejected: 0,
      returned: 25,
    },
    dataset_id: "dataset-cli-companies",
    generation_id: "generation-cli-companies",
    generation_plan_id: "generation-plan-cli-companies",
    materialization_id: "materialization-cli-companies",
    materialization_state: "building",
    record_count: 25,
    state: "running",
    terminal: false,
    workspace_id: "workspace-cli-test",
  } as const;
  const exitCode = await runCli({
    argv: [
      "company",
      "watch",
      "--endpoint",
      TEST_ENDPOINT,
      "--generation-id",
      "generation-cli-companies",
      "--timeout-ms",
      "0",
    ],
    environment: { KUROBARA_API_KEY: "synthetic-api-key" },
    fetch: fetchFrom((request) => {
      calls += 1;
      assert.equal(
        new URL(request.url).pathname,
        "/v1/dataset-generations/generation-cli-companies"
      );
      return jsonResponse(snapshot);
    }),
    stderr: stderr.target,
    stdin: Readable.from([]),
    stdout: stdout.target,
  });
  assert.equal(exitCode, 0);
  assert.equal(calls, 1);
  assert.equal(stderr.value(), "");
  assert.deepEqual(JSON.parse(stdout.value()), snapshot);
});

test("company cancel sends one non-interactive idempotent stop request", async () => {
  const stdout = capture();
  const stderr = capture();
  const response = {
    cost: { reserved: 0, spent: 0, unit: "credits" },
    counters: {
      accepted: 0,
      calls: 0,
      duplicates: 0,
      pages: 0,
      rejected: 0,
      returned: 0,
    },
    dataset_id: "dataset-cli-companies",
    generation_id: "generation-cli-companies",
    generation_plan_id: "generation-plan-cli-companies",
    materialization_id: "materialization-cli-companies",
    materialization_state: "cancelled",
    record_count: 0,
    replayed: false,
    state: "cancelled",
    stop_reason: "requested",
    stop_requested_at_ms: 1_752_700_001_000,
    terminal: true,
    workspace_id: "workspace-cli-test",
  } as const;
  const exitCode = await runCli({
    argv: [
      "company",
      "cancel",
      "--endpoint",
      TEST_ENDPOINT,
      "--generation-id",
      "generation-cli-companies",
      "--idempotency-key",
      "cancel-cli-companies",
    ],
    environment: { KUROBARA_API_KEY: "synthetic-api-key" },
    fetch: fetchFrom(async (request) => {
      assert.equal(
        new URL(request.url).pathname,
        "/v1/dataset-generations/generation-cli-companies/cancel"
      );
      assert.deepEqual(await request.json(), {
        idempotency_key: "cancel-cli-companies",
      });
      return jsonResponse(response);
    }),
    stderr: stderr.target,
    stdin: Readable.from([]),
    stdout: stdout.target,
  });
  assert.equal(exitCode, 0);
  assert.equal(stderr.value(), "");
  assert.deepEqual(JSON.parse(stdout.value()), response);
});

test("agent reads the canonical GTM questionnaire as stable JSON without prompting", async () => {
  const stdout = capture();
  const stderr = capture();
  const response = {
    profile: "agentic_outbound_play",
    questionnaire_version: "1.0.0",
    questions: [
      {
        answer_schema: { type: "string" },
        prompt: "What do you sell?",
        question_id: "offer.summary",
        required_for: ["agentic_outbound_play"],
        requires_human_confirmation: false,
        section: "offer",
        sensitivity: "business",
      },
      {
        answer_schema: { type: "boolean" },
        prompt: "Have provider rights been confirmed?",
        question_id: "policy.provider_rights_confirmed",
        required_for: ["agentic_outbound_play"],
        requires_human_confirmation: true,
        section: "policy",
        sensitivity: "policy",
      },
    ],
  } as const;
  const exitCode = await runCli({
    argv: [
      "context",
      "questions",
      "--profile",
      "agentic_outbound_play",
      "--endpoint",
      TEST_ENDPOINT,
      "--json",
    ],
    environment: { KUROBARA_API_KEY: "synthetic-api-key" },
    fetch: fetchFrom((request) => {
      assert.equal(
        new URL(request.url).pathname,
        "/v1/gtm-context-questionnaires/agentic_outbound_play"
      );
      return jsonResponse(response);
    }),
    stderr: stderr.target,
    stdin: Readable.from([]),
    stdout: stdout.target,
  });

  assert.equal(exitCode, 0);
  assert.equal(stderr.value(), "");
  assert.deepEqual(JSON.parse(stdout.value()), response);
});

test("workbook review aliases use the same versioned update contract", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "kurobara-workbook-"));
  const requestFile = path.join(root, "workbook-selection.json");
  const request = {
    annotations: [],
    approvals: [],
    column_order: ["domain"],
    dataset_id: "dataset-workbook",
    expected_revision: 0,
    filters: [],
    materialization_id: "materialization-workbook",
    name: "Synthetic Workbook",
    selection_reasons: [
      {
        reasons: ["company_match"],
        record_id: "record-1",
      },
    ],
    selected_record_ids: ["record-1"],
    workbook_id: "workbook-synthetic",
  } as const;
  const response = {
    view: {
      annotations: request.annotations,
      approvals: request.approvals,
      column_order: request.column_order,
      dataset_id: request.dataset_id,
      filters: request.filters,
      materialization_id: request.materialization_id,
      name: request.name,
      revision: 1,
      selection_reasons: request.selection_reasons,
      selected_record_ids: request.selected_record_ids,
      workbook_id: request.workbook_id,
      workspace_id: "workspace-cli-test",
    },
  };
  await writeFile(requestFile, JSON.stringify(request));
  for (const command of ["select", "approve", "reject"]) {
    const stdout = capture();
    const stderr = capture();
    const exitCode = await runCli({
      argv: [
        "workbook",
        command,
        "--endpoint",
        TEST_ENDPOINT,
        "--request",
        requestFile,
        "--json",
      ],
      environment: { KUROBARA_API_KEY: "synthetic-api-key" },
      fetch: fetchFrom(async (httpRequest) => {
        assert.equal(httpRequest.method, "PUT");
        assert.equal(
          new URL(httpRequest.url).pathname,
          "/v1/workbooks/workbook-synthetic"
        );
        assert.deepEqual(await httpRequest.json(), request);
        return jsonResponse(response);
      }),
      stderr: stderr.target,
      stdin: Readable.from([]),
      stdout: stdout.target,
    });
    assert.equal(exitCode, 0);
    assert.equal(stderr.value(), "");
    assert.deepEqual(JSON.parse(stdout.value()), response);
  }
});

test("workbook review aliases keep their action in human TTY receipts", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "kurobara-workbook-human-"));
  const requestFile = path.join(root, "workbook-selection.json");
  const request = {
    annotations: [],
    approvals: [],
    column_order: ["domain"],
    dataset_id: "dataset-workbook",
    expected_revision: 0,
    filters: [],
    materialization_id: "materialization-workbook",
    name: "Synthetic Workbook",
    selection_reasons: [],
    selected_record_ids: [],
    workbook_id: "workbook-synthetic",
  } as const;
  const response = {
    view: {
      annotations: request.annotations,
      approvals: request.approvals,
      column_order: request.column_order,
      dataset_id: request.dataset_id,
      filters: request.filters,
      materialization_id: request.materialization_id,
      name: request.name,
      revision: 1,
      selection_reasons: request.selection_reasons,
      selected_record_ids: request.selected_record_ids,
      workbook_id: request.workbook_id,
      workspace_id: "workspace-cli-test",
    },
  };
  const expectedTitles = new Map([
    ["select", "SELECTION SAVED"],
    ["approve", "APPROVAL SAVED"],
    ["reject", "REJECTION SAVED"],
  ]);
  await writeFile(requestFile, JSON.stringify(request));

  for (const [command, expectedTitle] of expectedTitles) {
    const stdout = capture(true);
    const stderr = capture();
    const exitCode = await runCli({
      argv: [
        "workbook",
        command,
        "--endpoint",
        TEST_ENDPOINT,
        "--no-color",
        "--request",
        requestFile,
      ],
      environment: { KUROBARA_API_KEY: "synthetic-api-key" },
      fetch: fetchFrom(() => jsonResponse(response)),
      stderr: stderr.target,
      stdin: Readable.from([]),
      stdout: stdout.target,
    });

    assert.equal(exitCode, 0);
    assert.equal(stderr.value(), "");
    assert.ok(stdout.value().includes(`KUROBARA ◆ ${expectedTitle}`));
    assert.ok(
      stdout.value().includes("✓ SAVED  Versioned review state persisted")
    );
  }
});

test("play run defaults to one durable resume read", async () => {
  const stdout = capture();
  const stderr = capture();
  const snapshot = JSON.parse(
    await readFile(
      new URL(
        "../../contracts/catalog/fixtures/play-run-get-response/valid/minimal.json",
        import.meta.url
      ),
      "utf8"
    )
  ) as { run: { run_id: string; state: string } };
  let calls = 0;
  const exitCode = await runCli({
    argv: [
      "play",
      "run",
      "--endpoint",
      TEST_ENDPOINT,
      "--run-id",
      snapshot.run.run_id,
      "--json",
    ],
    environment: { KUROBARA_API_KEY: "synthetic-api-key" },
    fetch: fetchFrom((request) => {
      calls += 1;
      assert.equal(
        new URL(request.url).pathname,
        `/v1/play-runs/${snapshot.run.run_id}`
      );
      return jsonResponse(snapshot);
    }),
    stderr: stderr.target,
    stdin: Readable.from([]),
    stdout: stdout.target,
  });

  assert.equal(exitCode, 0);
  assert.equal(calls, 1);
  assert.equal(stderr.value(), "");
  assert.deepEqual(JSON.parse(stdout.value()), snapshot);
});

test("play run polls until the run reaches a review boundary", async () => {
  const stdout = capture();
  const stderr = capture();
  const queued = JSON.parse(
    await readFile(
      new URL(
        "../../contracts/catalog/fixtures/play-run-get-response/valid/minimal.json",
        import.meta.url
      ),
      "utf8"
    )
  ) as { run: { run_id: string; state: string } };
  const completed = structuredClone(queued);
  completed.run.state = "completed";
  let calls = 0;
  let clock = 0;
  const exitCode = await runCli({
    argv: [
      "play",
      "run",
      "--endpoint",
      TEST_ENDPOINT,
      "--poll-interval-ms",
      "100",
      "--run-id",
      queued.run.run_id,
      "--timeout-ms",
      "1000",
      "--json",
    ],
    environment: { KUROBARA_API_KEY: "synthetic-api-key" },
    fetch: fetchFrom(() => {
      calls += 1;
      return jsonResponse(calls === 1 ? queued : completed);
    }),
    now: () => clock,
    stderr: stderr.target,
    stdin: Readable.from([]),
    stdout: stdout.target,
    wait: (milliseconds) => {
      clock += milliseconds;
      return Promise.resolve();
    },
  });

  assert.equal(exitCode, 0);
  assert.equal(calls, 2);
  assert.equal(stderr.value(), "");
  assert.deepEqual(JSON.parse(stdout.value()), completed);
});

test("human play run watch shows bounded progress before the final receipt", async () => {
  const stdout = capture(true, 100);
  const stderr = capture();
  const running = JSON.parse(
    await readFile(
      new URL(
        "../../contracts/catalog/fixtures/play-run-get-response/valid/minimal.json",
        import.meta.url
      ),
      "utf8"
    )
  ) as { run: { run_id: string; state: string } };
  running.run.state = "running";
  const completed = structuredClone(running);
  completed.run.state = "completed";
  let calls = 0;
  let clock = 0;

  const exitCode = await runCli({
    argv: [
      "play",
      "run",
      "--endpoint",
      TEST_ENDPOINT,
      "--no-color",
      "--poll-interval-ms",
      "100",
      "--run-id",
      running.run.run_id,
      "--timeout-ms",
      "1000",
    ],
    environment: { KUROBARA_API_KEY: "synthetic-api-key" },
    fetch: fetchFrom(() => {
      calls += 1;
      return jsonResponse(calls === 1 ? running : completed);
    }),
    now: () => clock,
    stderr: stderr.target,
    stdin: Readable.from([]),
    stdout: stdout.target,
    wait: (milliseconds) => {
      clock += milliseconds;
      return Promise.resolve();
    },
  });

  assert.equal(exitCode, 0);
  assert.equal(calls, 2);
  assert.equal(stderr.value(), "");
  assert.ok(stdout.value().includes("\r···●····●···  ● RUNNING  poll 1"));
  assert.ok(stdout.value().includes("KUROBARA ◆ PLAY RUN"));
  assert.ok(stdout.value().includes("✓ COMPLETED"));
  assert.ok(stdout.value().includes("EXECUTION PLAN  1 stage"));
});

test("human play run watch suppresses replaceable progress in CI", async () => {
  const stdout = capture(true, 100);
  const stderr = capture();
  const running = JSON.parse(
    await readFile(
      new URL(
        "../../contracts/catalog/fixtures/play-run-get-response/valid/minimal.json",
        import.meta.url
      ),
      "utf8"
    )
  ) as { run: { state: string } };
  running.run.state = "running";
  const completed = structuredClone(running);
  completed.run.state = "completed";
  let calls = 0;
  let clock = 0;

  const exitCode = await runCli({
    argv: [
      "play",
      "run",
      "--endpoint",
      TEST_ENDPOINT,
      "--no-color",
      "--poll-interval-ms",
      "100",
      "--run-id",
      "play-run-ci",
      "--timeout-ms",
      "1000",
    ],
    environment: {
      CI: "1",
      KUROBARA_API_KEY: "synthetic-api-key",
    },
    fetch: fetchFrom(() => {
      calls += 1;
      return jsonResponse(calls === 1 ? running : completed);
    }),
    now: () => clock,
    stderr: stderr.target,
    stdin: Readable.from([]),
    stdout: stdout.target,
    wait: (milliseconds) => {
      clock += milliseconds;
      return Promise.resolve();
    },
  });

  assert.equal(exitCode, 0);
  assert.equal(stderr.value(), "");
  assert.equal(stdout.value().includes("\r"), false);
  assert.ok(stdout.value().includes("KUROBARA ◆ PLAY RUN"));
});
