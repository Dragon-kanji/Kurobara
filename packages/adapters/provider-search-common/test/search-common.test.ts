import assert from "node:assert/strict";
import test from "node:test";

import type {
  PluginEstimateRequest,
  PluginExecuteRequest,
  PluginNormalizeRequest,
} from "@kurobara/plugin-sdk";

import {
  createSearchProviderAdapter,
  SEARCH_CAPABILITY,
  SEARCH_CATALOG_FINGERPRINT,
  SEARCH_CONTRACTS,
  SearchProviderConfigurationError,
} from "../src/index.ts";

const hash = (character: string): string => `sha256:${character.repeat(64)}`;

const cellInput = {
  datasetId: "dataset",
  inputValues: [
    { fieldId: "company", present: true, value: "Example Inc" },
    { fieldId: "domain", present: true, value: "example.com" },
  ],
  recipeId: "recipe",
  recipeRevision: "recipe-revision",
  recordContentHash: hash("a"),
  recordId: "record",
  targetFieldId: "website",
  workflowContentHash: hash("b"),
  workflowRevision: "workflow-revision",
  workflowSpecId: "workflow",
  workspaceId: "workspace",
};

const context = {
  capability: SEARCH_CAPABILITY,
  configuration: { contentHash: hash("c"), value: {} },
  deadlineAtMs: 11_000,
};

const input = {
  contentHash: hash("d"),
  contract: SEARCH_CONTRACTS.input,
  sizeBytes: new TextEncoder().encode(JSON.stringify(cellInput)).byteLength,
  value: cellInput,
};

const estimateRequest = { context, input } satisfies PluginEstimateRequest;

const executeRequest = {
  context,
  costLimit: { amount: 1, unit: "requests" },
  input,
  operationKey: "operation",
  quote: {
    expiresAtMs: 11_000,
    guarantee: "hard",
    pricingVersion: "1.0.0",
    unit: "requests",
    upperBound: 1,
  },
} satisfies PluginExecuteRequest;

const definition = {
  authMode: "api-key-header" as const,
  endpoint: "https://search.invalid/v1" as const,
  hostname: "search.invalid",
  pluginId: "dev.kurobara.provider-search-test",
  request: (domain: string) => ({ domain }),
  requestIdKey: "requestId" as const,
};

const jsonResponse = (body: string, status = 200): Response =>
  new Response(body, {
    headers: { "content-type": "application/json" },
    status,
  });

const invalidResponseResult = {
  error: {
    class: "response",
    reasonCode: "provider-response-invalid",
  },
  status: "outcome-unknown",
} as const;

test("pins the generated 0.13.0 recipe contract references", () => {
  assert.deepEqual(SEARCH_CONTRACTS, {
    input: {
      catalogFingerprint: SEARCH_CATALOG_FINGERPRINT,
      catalogVersion: "0.13.0",
      schemaFingerprint:
        "sha256:c40a6d60340e2fcc29415f4594b5b3f951da7a798d41a245bb63cecd1600eccd",
      schemaId:
        "https://schemas.kurobara.invalid/schemas/recipes/cell-input/1.0.0",
      schemaVersion: "1.0.0",
    },
    output: {
      catalogFingerprint: SEARCH_CATALOG_FINGERPRINT,
      catalogVersion: "0.13.0",
      schemaFingerprint:
        "sha256:a131ddf91ef2314dbaf7af91f3ba56eec4adf766d557a70185b0bbc320d13e9d",
      schemaId:
        "https://schemas.kurobara.invalid/schemas/recipes/cell-output/1.0.0",
      schemaVersion: "1.0.0",
    },
  });
});

test("rejects API keys containing control characters before composition", () => {
  for (const apiKey of [
    "synthetic\tkey",
    "synthetic\nkey",
    "synthetic\u007fkey",
    "synthetic\u0085key",
  ]) {
    assert.throws(
      () =>
        createSearchProviderAdapter(definition, {
          apiKey,
          fetch: () => Promise.resolve(jsonResponse("{}")),
        }),
      (error: unknown) => {
        assert.equal(error instanceof SearchProviderConfigurationError, true);
        assert.equal(String(error).includes(apiKey), false);
        return true;
      }
    );
  }
});

test("rejects invalid cell input without issuing a request", async () => {
  let calls = 0;
  const adapter = createSearchProviderAdapter(definition, {
    apiKey: "synthetic-key",
    clock: { now: () => 1000 },
    fetch: () => {
      calls += 1;
      return Promise.resolve(jsonResponse("{}"));
    },
  });
  const invalidCellInput = {
    ...cellInput,
    inputValues: [{ fieldId: "company", present: true, value: "Example Inc" }],
  };
  const invalidInput = {
    ...input,
    sizeBytes: new TextEncoder().encode(JSON.stringify(invalidCellInput))
      .byteLength,
    value: invalidCellInput,
  };

  assert.deepEqual(await adapter.estimate({ context, input: invalidInput }), {
    error: { class: "input", reasonCode: "input-invalid" },
    status: "unavailable",
  });
  assert.deepEqual(
    await adapter.execute({ ...executeRequest, input: invalidInput }),
    {
      error: { class: "input", reasonCode: "input-invalid" },
      status: "failed",
      usage: { amount: 0, basis: "exact", unit: "requests" },
    }
  );
  assert.equal(calls, 0);
});

test("maps definite 4xx and gateway failures with exact usage", async () => {
  const responses = [
    new Response(null, { status: 400 }),
    new Response(null, { status: 401 }),
    new Response(null, { status: 403 }),
    new Response(null, { headers: { "retry-after": "3" }, status: 429 }),
    new Response(null, { status: 502 }),
    new Response(null, { status: 503 }),
    new Response(null, { status: 504 }),
  ];
  const adapter = createSearchProviderAdapter(definition, {
    apiKey: "synthetic-key",
    clock: { now: () => 1000 },
    fetch: () =>
      Promise.resolve(responses.shift() ?? new Response(null, { status: 500 })),
  });

  assert.deepEqual(await adapter.execute(executeRequest), {
    error: { class: "provider", reasonCode: "provider-rejected" },
    status: "failed",
    usage: { amount: 1, basis: "exact", unit: "requests" },
  });
  assert.deepEqual(await adapter.execute(executeRequest), {
    error: { class: "authentication", reasonCode: "authentication-failed" },
    status: "failed",
    usage: { amount: 1, basis: "exact", unit: "requests" },
  });
  assert.deepEqual(await adapter.execute(executeRequest), {
    error: { class: "authorization", reasonCode: "authorization-failed" },
    status: "failed",
    usage: { amount: 1, basis: "exact", unit: "requests" },
  });
  assert.deepEqual(await adapter.execute(executeRequest), {
    error: {
      class: "rate-limit",
      reasonCode: "rate-limited",
      retryAfterMs: 3000,
    },
    status: "failed",
    usage: { amount: 1, basis: "exact", unit: "requests" },
  });
  assert.deepEqual(await adapter.execute(executeRequest), {
    error: { class: "provider", reasonCode: "provider-unavailable" },
    status: "failed",
    usage: { amount: 1, basis: "exact", unit: "requests" },
  });
  assert.deepEqual(await adapter.execute(executeRequest), {
    error: { class: "provider", reasonCode: "provider-unavailable" },
    status: "failed",
    usage: { amount: 1, basis: "exact", unit: "requests" },
  });
  assert.deepEqual(await adapter.execute(executeRequest), {
    error: { class: "provider", reasonCode: "provider-unavailable" },
    status: "failed",
    usage: { amount: 1, basis: "exact", unit: "requests" },
  });
});

test("keeps an unclassified HTTP response outcome-unknown", async () => {
  const adapter = createSearchProviderAdapter(definition, {
    apiKey: "synthetic-key",
    clock: { now: () => 1000 },
    fetch: () => Promise.resolve(new Response(null, { status: 500 })),
  });

  assert.deepEqual(await adapter.execute(executeRequest), {
    error: { class: "transport", reasonCode: "transport-failed" },
    status: "outcome-unknown",
  });
});

test("keeps transport rejection and timeout outcome-unknown", async () => {
  const rejected = createSearchProviderAdapter(definition, {
    apiKey: "synthetic-key",
    clock: { now: () => 1000 },
    fetch: () => Promise.reject(new Error("socket reset")),
  });
  assert.deepEqual(await rejected.execute(executeRequest), {
    error: { class: "transport", reasonCode: "transport-failed" },
    status: "outcome-unknown",
  });

  const timedOut = createSearchProviderAdapter(definition, {
    apiKey: "synthetic-key",
    clock: { now: () => 1000 },
    fetch: async (_input, init) =>
      await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(new Error("deadline"))
        );
      }),
  });
  assert.deepEqual(
    await timedOut.execute({
      ...executeRequest,
      context: { ...context, deadlineAtMs: 1005 },
      quote: { ...executeRequest.quote, expiresAtMs: 1005 },
    }),
    {
      error: { class: "deadline", reasonCode: "deadline-exceeded" },
      status: "outcome-unknown",
    }
  );
});

test("keeps the abort signal active until response-body completion", async () => {
  let observedAbort = false;
  let signal: AbortSignal | undefined;
  const adapter = createSearchProviderAdapter(definition, {
    apiKey: "synthetic-key",
    clock: { now: () => 1000 },
    fetch: (_input, init) => {
      signal = init?.signal ?? undefined;
      assert.ok(signal);
      signal.addEventListener(
        "abort",
        () => {
          observedAbort = true;
        },
        { once: true }
      );
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(
            new TextEncoder().encode('{"requestId":"request",')
          );
        },
      });
      return Promise.resolve(
        new Response(body, {
          headers: { "content-type": "application/json" },
          status: 200,
        })
      );
    },
  });

  assert.deepEqual(
    await adapter.execute({
      ...executeRequest,
      context: { ...context, deadlineAtMs: 1005 },
      quote: { ...executeRequest.quote, expiresAtMs: 1005 },
    }),
    {
      error: { class: "deadline", reasonCode: "deadline-exceeded" },
      status: "outcome-unknown",
    }
  );
  assert.equal(observedAbort, true);
  assert.equal(signal?.aborted, true);
});

test("maps a valid empty result to a definite failure with exact usage", async () => {
  const adapter = createSearchProviderAdapter(definition, {
    apiKey: "synthetic-key",
    clock: { now: () => 1000 },
    fetch: () =>
      Promise.resolve(
        jsonResponse('{"requestId":"empty-request","results":[]}')
      ),
  });

  assert.deepEqual(await adapter.execute(executeRequest), {
    error: { class: "provider", reasonCode: "provider-unavailable" },
    status: "failed",
    usage: {
      amount: 1,
      basis: "exact",
      receiptReference: "empty-request",
      unit: "requests",
    },
  });
});

test("maps an off-domain result to a definite failure with exact usage", async () => {
  const adapter = createSearchProviderAdapter(definition, {
    apiKey: "synthetic-key",
    clock: { now: () => 1000 },
    fetch: () =>
      Promise.resolve(
        jsonResponse(
          '{"requestId":"off-domain-request","results":[{"score":0.9,"url":"https://en.wikipedia.org/wiki/Example.com"}]}'
        )
      ),
  });

  assert.deepEqual(await adapter.execute(executeRequest), {
    error: { class: "provider", reasonCode: "provider-unavailable" },
    status: "failed",
    usage: {
      amount: 1,
      basis: "exact",
      receiptReference: "off-domain-request",
      unit: "requests",
    },
  });
});

test("rejects malformed and non-minimal success payloads as ambiguous", async () => {
  const responses = [
    new Response("{}", {
      headers: {
        "content-length": "262145",
        "content-type": "application/json",
      },
      status: 200,
    }),
    jsonResponse(
      '{"requestId":"first","requestId":"second","results":[{"url":"https://example.com"}]}'
    ),
    jsonResponse(
      '{"requestId":"request","results":[{"url":"http://example.com"}]}'
    ),
    jsonResponse(
      '{"requestId":"request","results":[{"url":"https://example.com"},{"url":"https://example.org"}]}'
    ),
    jsonResponse('{"results":[]}'),
    jsonResponse('{"results":[{"url":"https://example.com"}]}'),
    jsonResponse(
      '{"requestId":"request","results":[{"score":2,"url":"https://example.com"}]}'
    ),
    new Response(
      '{"requestId":"request","results":[{"url":"https://example.com"}]}',
      { headers: { "content-type": "text/json" }, status: 200 }
    ),
  ];
  const responseCount = responses.length;
  const adapter = createSearchProviderAdapter(definition, {
    apiKey: "synthetic-key",
    clock: { now: () => 1000 },
    fetch: () => Promise.resolve(responses.shift() ?? jsonResponse("{}")),
  });
  assert.deepEqual(
    await Promise.all(
      Array.from({ length: responseCount }, () =>
        adapter.execute(executeRequest)
      )
    ),
    Array.from({ length: responseCount }, () => invalidResponseResult)
  );
});

test("accepts only the four JSON whitespace code points", async () => {
  const responses = [
    jsonResponse(
      '\r\n{\t"requestId" : "request", "results" : [ { "url" : "https://example.com" } ] }\r\n'
    ),
    jsonResponse(
      '\u00a0{"requestId":"request","results":[{"url":"https://example.com"}]}'
    ),
  ];
  const adapter = createSearchProviderAdapter(definition, {
    apiKey: "synthetic-key",
    clock: { now: () => 1000 },
    fetch: () => Promise.resolve(responses.shift() ?? jsonResponse("{}")),
  });

  const accepted = await adapter.execute(executeRequest);
  assert.equal(accepted.status, "succeeded");
  assert.deepEqual(
    await adapter.execute(executeRequest),
    invalidResponseResult
  );
});

test("reduces success before normalization and never reflects secrets", async () => {
  const secret = "synthetic-secret-canary";
  const adapter = createSearchProviderAdapter(definition, {
    apiKey: secret,
    clock: { now: () => 1234 },
    fetch: () =>
      Promise.resolve(
        jsonResponse(
          `{"requestId":"safe-request","providerSecret":"${secret}","results":[{"content":"raw-private-content","score":0.3,"title":"raw-title","url":"https://example.com/contact?source=search#team"}]}`
        )
      ),
  });
  const executed = await adapter.execute(executeRequest);
  assert.deepEqual(executed, {
    externalOperationReference: "safe-request",
    providerPayload: {
      confidence: 1,
      freshness: { observedAt: 1234 },
      provenance: {
        references: ["https://example.com/contact?source=search"],
      },
      value: "https://example.com",
    },
    status: "succeeded",
    usage: {
      amount: 1,
      basis: "exact",
      receiptReference: "safe-request",
      unit: "requests",
    },
  });
  assert.equal(JSON.stringify(executed).includes(secret), false);
  assert.equal(JSON.stringify(executed).includes("raw-private-content"), false);
  assert.equal(JSON.stringify(executed).includes("raw-title"), false);

  assert.equal(executed.status, "succeeded");
  if (executed.status !== "succeeded") {
    return;
  }
  const normalizeRequest = {
    context,
    operationKey: "operation",
    outputContract: SEARCH_CONTRACTS.output,
    providerPayload: executed.providerPayload,
  } satisfies PluginNormalizeRequest;
  assert.deepEqual(await adapter.normalize(normalizeRequest), {
    normalizerVersion: "1.0.0",
    output: executed.providerPayload,
    status: "normalized",
  });
  assert.deepEqual(
    await adapter.lookup({ context, operationKey: "operation" }),
    {
      error: { class: "adapter", reasonCode: "adapter-fault" },
      status: "outcome-unknown",
    }
  );
});

test("quotes only validated domains", async () => {
  const adapter = createSearchProviderAdapter(definition, {
    apiKey: "synthetic-key",
    clock: { now: () => 1000 },
    fetch: () => Promise.resolve(jsonResponse("{}")),
  });
  assert.deepEqual(await adapter.estimate(estimateRequest), {
    quote: {
      expiresAtMs: 11_000,
      guarantee: "hard",
      pricingVersion: "1.0.0",
      unit: "requests",
      upperBound: 1,
    },
    status: "quoted",
  });
});
