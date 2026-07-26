import { createHash, randomUUID } from "node:crypto";

import { createExaProviderAdapter } from "@kurobara/provider-exa";
import {
  SEARCH_CAPABILITY,
  SEARCH_CONTRACTS,
} from "@kurobara/provider-search-common";
import { createTavilyProviderAdapter } from "@kurobara/provider-tavily";

const PROVIDERS = Object.freeze({
  exa: {
    create: createExaProviderAdapter,
    environmentVariable: "EXA_API_KEY",
  },
  tavily: {
    create: createTavilyProviderAdapter,
    environmentVariable: "TAVILY_API_KEY",
  },
});

const [, , providerName] = process.argv;
const provider = PROVIDERS[providerName];
if (provider === undefined) {
  throw new Error("Provider probe expects tavily or exa.");
}
const apiKey = process.env[provider.environmentVariable];
if (apiKey === undefined || apiKey.length === 0 || apiKey.trim() !== apiKey) {
  throw new Error(
    `${provider.environmentVariable} must be configured without surrounding whitespace.`
  );
}

const adapter = provider.create({ apiKey });
const now = Date.now();
const inputValue = {
  datasetId: "dataset_v1_gate",
  inputValues: [
    { fieldId: "field_domain", present: true, value: "example.com" },
  ],
  recipeId: "recipe_v1_gate",
  recipeRevision: "1.0.0",
  recordContentHash: `sha256:${"a".repeat(64)}`,
  recordId: "record_v1_gate",
  targetFieldId: "field_official_website_url",
  workflowContentHash: `sha256:${"b".repeat(64)}`,
  workflowRevision: "1.0.0",
  workflowSpecId: "workflow_v1_gate",
  workspaceId: "workspace_v1_gate",
};
const inputBytes = new TextEncoder().encode(JSON.stringify(inputValue));
const result = await adapter.execute({
  context: {
    capability: SEARCH_CAPABILITY,
    configuration: {
      contentHash: `sha256:${"c".repeat(64)}`,
      value: {},
    },
    deadlineAtMs: now + 30_000,
  },
  costLimit: { amount: 1, unit: "requests" },
  input: {
    contentHash: `sha256:${createHash("sha256").update(inputBytes).digest("hex")}`,
    contract: SEARCH_CONTRACTS.input,
    sizeBytes: inputBytes.byteLength,
    value: inputValue,
  },
  operationKey: `v1-gate:${providerName}:${randomUUID()}`,
  quote: {
    expiresAtMs: now + 30_000,
    guarantee: "hard",
    pricingVersion: "1.0.0",
    unit: "requests",
    upperBound: 1,
  },
});

if (result.status === "succeeded") {
  const value = result.providerPayload;
  const normalizedUrl = new URL(String(value.value));
  console.log(
    JSON.stringify({
      confidence:
        typeof value.confidence === "number" ? value.confidence : null,
      normalized_origin: normalizedUrl.origin,
      provider: providerName,
      status: "succeeded",
      usage: {
        amount: result.usage.amount,
        basis: result.usage.basis,
        unit: result.usage.unit,
      },
    })
  );
} else {
  const reasonCode =
    "error" in result && typeof result.error?.reasonCode === "string"
      ? result.error.reasonCode
      : "provider-probe-not-succeeded";
  console.log(
    JSON.stringify({
      provider: providerName,
      reason_code: reasonCode,
      status: result.status,
    })
  );
  process.exitCode = 1;
}
