import assert from "node:assert/strict";
import test from "node:test";

import type { PluginExecuteRequest } from "@kurobara/plugin-sdk";
import {
  SEARCH_CAPABILITY,
  SEARCH_CONTRACTS,
} from "@kurobara/provider-search-common";

import { createTavilyProviderAdapter } from "../src/index.ts";

const hash = (character: string): string => `sha256:${character.repeat(64)}`;
const value = {
  datasetId: "dataset",
  inputValues: [{ fieldId: "domain", present: true, value: "example.com" }],
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
  deadlineAtMs: 10_000,
};
const request = {
  context,
  costLimit: { amount: 1, unit: "requests" },
  input: {
    contentHash: hash("d"),
    contract: SEARCH_CONTRACTS.input,
    sizeBytes: new TextEncoder().encode(JSON.stringify(value)).byteLength,
    value,
  },
  operationKey: "operation",
  quote: {
    expiresAtMs: 10_000,
    guarantee: "hard",
    pricingVersion: "1.0.0",
    unit: "requests",
    upperBound: 1,
  },
} satisfies PluginExecuteRequest;

test("declares the one-shot Tavily boundary and emits one exact request", async () => {
  const secret = "synthetic-tavily-key";
  let capturedInput: string | undefined;
  let capturedInit: RequestInit | undefined;
  let calls = 0;
  const adapter = createTavilyProviderAdapter({
    apiKey: secret,
    clock: { now: () => 1000 },
    fetch: (input, init) => {
      calls += 1;
      capturedInput = input instanceof Request ? input.url : String(input);
      capturedInit = init;
      return Promise.resolve(
        new Response(
          JSON.stringify({
            request_id: "tavily-request",
            results: [
              { score: 0.91, url: "https://example.com/company#about" },
            ],
          }),
          { headers: { "content-type": "application/json" }, status: 200 }
        )
      );
    },
  });

  const { manifest } = adapter.describe();
  assert.equal(manifest.id, "dev.kurobara.provider-tavily");
  assert.deepEqual(manifest.auth.modes, ["bearer-token"]);
  assert.deepEqual(manifest.permissions.egress.hosts, ["api.tavily.com"]);
  assert.deepEqual(manifest.execution.idempotency, {
    keyScope: "operation",
    mode: "none",
  });
  assert.deepEqual(manifest.execution.lookup, {
    authoritativeNotFound: false,
    mode: "none",
  });
  assert.deepEqual(
    manifest.capabilities[0]?.inputContract,
    SEARCH_CONTRACTS.input
  );

  const result = await adapter.execute(request);
  assert.equal(calls, 1);
  assert.equal(capturedInput, "https://api.tavily.com/search");
  assert.equal(capturedInit?.method, "POST");
  assert.equal(capturedInit?.redirect, "error");
  assert.equal(capturedInit?.signal instanceof AbortSignal, true);
  assert.equal(capturedInit?.signal?.aborted, false);
  assert.equal(
    new Headers(capturedInit?.headers).get("authorization"),
    `Bearer ${secret}`
  );
  assert.equal(new Headers(capturedInit?.headers).get("x-api-key"), null);
  assert.equal(
    new Headers(capturedInit?.headers).get("accept"),
    "application/json"
  );
  assert.equal(
    new Headers(capturedInit?.headers).get("content-type"),
    "application/json"
  );
  assert.deepEqual(JSON.parse(String(capturedInit?.body)), {
    auto_parameters: false,
    include_answer: false,
    include_images: false,
    include_raw_content: false,
    include_usage: true,
    max_results: 1,
    query: "Find the official website for example.com",
    search_depth: "basic",
  });
  assert.equal(String(capturedInit?.body).includes(secret), false);
  assert.equal(JSON.stringify(result).includes(secret), false);
  assert.deepEqual(result, {
    externalOperationReference: "tavily-request",
    providerPayload: {
      confidence: 1,
      freshness: { observedAt: 1000 },
      provenance: { references: ["https://example.com/company"] },
      value: "https://example.com",
    },
    status: "succeeded",
    usage: {
      amount: 1,
      basis: "exact",
      receiptReference: "tavily-request",
      unit: "requests",
    },
  });
});
