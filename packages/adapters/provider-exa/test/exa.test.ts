import assert from "node:assert/strict";
import test from "node:test";

import type { PluginExecuteRequest } from "@kurobara/plugin-sdk";
import {
  SEARCH_CAPABILITY,
  SEARCH_CONTRACTS,
} from "@kurobara/provider-search-common";

import { createExaProviderAdapter } from "../src/index.ts";

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

test("declares the one-shot Exa boundary and emits one exact request", async () => {
  const secret = "synthetic-exa-key";
  let capturedInput: string | undefined;
  let capturedInit: RequestInit | undefined;
  let calls = 0;
  const adapter = createExaProviderAdapter({
    apiKey: secret,
    clock: { now: () => 1000 },
    fetch: (input, init) => {
      calls += 1;
      capturedInput = input instanceof Request ? input.url : String(input);
      capturedInit = init;
      return Promise.resolve(
        new Response(
          JSON.stringify({
            requestId: "exa-request",
            results: [
              { score: 0.82, url: "https://example.com/company#about" },
            ],
          }),
          { headers: { "content-type": "application/json" }, status: 200 }
        )
      );
    },
  });

  const { manifest } = adapter.describe();
  assert.equal(manifest.id, "dev.kurobara.provider-exa");
  assert.deepEqual(manifest.auth.modes, ["api-key-header"]);
  assert.deepEqual(manifest.permissions.egress.hosts, ["api.exa.ai"]);
  assert.deepEqual(manifest.execution.idempotency, {
    keyScope: "operation",
    mode: "none",
  });
  assert.deepEqual(manifest.execution.lookup, {
    authoritativeNotFound: false,
    mode: "none",
  });
  assert.deepEqual(
    manifest.capabilities[0]?.outputContract,
    SEARCH_CONTRACTS.output
  );

  const result = await adapter.execute(request);
  assert.equal(calls, 1);
  assert.equal(capturedInput, "https://api.exa.ai/search");
  assert.equal(capturedInit?.method, "POST");
  assert.equal(capturedInit?.redirect, "error");
  assert.equal(capturedInit?.signal instanceof AbortSignal, true);
  assert.equal(capturedInit?.signal?.aborted, false);
  assert.equal(new Headers(capturedInit?.headers).get("x-api-key"), secret);
  assert.equal(new Headers(capturedInit?.headers).get("authorization"), null);
  assert.equal(
    new Headers(capturedInit?.headers).get("accept"),
    "application/json"
  );
  assert.equal(
    new Headers(capturedInit?.headers).get("content-type"),
    "application/json"
  );
  assert.deepEqual(JSON.parse(String(capturedInit?.body)), {
    category: "company",
    numResults: 1,
    query: "Find the official website for example.com",
    type: "fast",
  });
  assert.equal(String(capturedInit?.body).includes(secret), false);
  assert.equal(JSON.stringify(result).includes(secret), false);
  assert.deepEqual(result, {
    externalOperationReference: "exa-request",
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
      receiptReference: "exa-request",
      unit: "requests",
    },
  });
});
