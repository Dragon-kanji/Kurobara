import { pathToFileURL } from "node:url";

import { createTrustedPluginLeafEffect } from "@kurobara/adapter-effect-plugin";
import { createConfiguredOfficialProviderRoutes } from "@kurobara/adapter-provider-registry";
import {
  attemptId,
  contentHash,
  instant,
  operationKey,
  routingDecisionId,
  runId,
  stepRunId,
  workspaceId,
} from "@kurobara/kernel";
import { createExaProviderAdapter } from "@kurobara/provider-exa";
import {
  SEARCH_CAPABILITY,
  SEARCH_CONTRACTS,
} from "@kurobara/provider-search-common";
import { createTavilyProviderAdapter } from "@kurobara/provider-tavily";

const CLOCK_MS = 1000;
const CONFIGURATION_HASH = contentHash(`sha256:${"c".repeat(64)}`);
const OPERATION_KEY = operationKey("v1-gate-controlled-fallback");
const ROUTE_SNAPSHOT_HASH = contentHash(`sha256:${"e".repeat(64)}`);

const fail = (message) => {
  throw new Error(`Controlled fallback proof failed: ${message}.`);
};

const assert = (condition, message) => {
  if (!condition) {
    fail(message);
  }
};

const jsonResponse = (value) =>
  new Response(JSON.stringify(value), {
    headers: { "content-type": "application/json" },
    status: 200,
  });

const inputValue = Object.freeze({
  datasetId: "dataset_v1_gate_controlled_fallback",
  inputValues: Object.freeze([
    Object.freeze({
      fieldId: "field_domain",
      present: true,
      value: "example.com",
    }),
  ]),
  recipeId: "recipe_v1_gate_controlled_fallback",
  recipeRevision: "1.0.0",
  recordContentHash: `sha256:${"a".repeat(64)}`,
  recordId: "record_v1_gate_controlled_fallback",
  targetFieldId: "field_official_website_url",
  workflowContentHash: `sha256:${"b".repeat(64)}`,
  workflowRevision: "1.0.0",
  workflowSpecId: "workflow_v1_gate_controlled_fallback",
  workspaceId: "workspace_v1_gate_controlled_fallback",
});
const inputBytes = new TextEncoder().encode(JSON.stringify(inputValue));

const requestFor = (providerId, index) =>
  Object.freeze({
    attemptId: attemptId(`attempt-v1-gate-${providerId}`),
    operationKey: OPERATION_KEY,
    reservationUnit: "requests",
    reservedAmount: 1,
    routeSnapshotHash: ROUTE_SNAPSHOT_HASH,
    routingDecisionId: routingDecisionId(
      `routing-v1-gate-controlled-fallback-${index}`
    ),
    runId: runId("run-v1-gate-controlled-fallback"),
    runInput: Object.freeze({
      classification: "internal",
      contentHash: contentHash(`sha256:${"d".repeat(64)}`),
      contract: SEARCH_CONTRACTS.input,
      finalizedAt: instant(CLOCK_MS - 1),
      inputId: "input-v1-gate-controlled-fallback",
      mediaType: "application/json",
      sizeBytes: inputBytes.byteLength,
      validatedAt: instant(CLOCK_MS - 1),
      validatorVersion: "v1-gate-controlled-1",
      value: inputValue,
    }),
    stepRunId: stepRunId(`step-v1-gate-${providerId}`),
    workspaceId: workspaceId("workspace-v1-gate-controlled-fallback"),
  });

export const runControlledFallbackProof = async () => {
  const providerCalls = { exa: 0, tavily: 0 };
  const routes = createConfiguredOfficialProviderRoutes({
    EXA_API_KEY: "synthetic-exa-key",
    KUROBARA_EXA_DATA_RIGHTS_CONFIRMED: "true",
    KUROBARA_PROVIDER_ORDER: "tavily,exa",
    TAVILY_API_KEY: "synthetic-tavily-key",
  });
  assert(
    routes.map(({ providerId }) => providerId).join(",") ===
      "tavily-search,exa-search",
    "official registry order drifted"
  );

  const adapterFor = (providerId) => {
    if (providerId === "tavily-search") {
      return createTavilyProviderAdapter({
        apiKey: "synthetic-tavily-key",
        clock: { now: () => CLOCK_MS },
        fetch: (input) => {
          providerCalls.tavily += 1;
          assert(
            String(input) === "https://api.tavily.com/search",
            "Tavily endpoint drifted"
          );
          return Promise.resolve(
            new Response(null, {
              headers: { "retry-after": "1" },
              status: 429,
            })
          );
        },
      });
    }
    return createExaProviderAdapter({
      apiKey: "synthetic-exa-key",
      clock: { now: () => CLOCK_MS },
      fetch: (input) => {
        providerCalls.exa += 1;
        assert(
          String(input) === "https://api.exa.ai/search",
          "Exa endpoint drifted"
        );
        return Promise.resolve(
          jsonResponse({
            requestId: "exa-controlled-fallback-request",
            results: [{ score: 1, url: "https://example.com/company#about" }],
          })
        );
      },
    });
  };

  const outcomes = [];
  for (const [index, route] of routes.entries()) {
    const effect = await createTrustedPluginLeafEffect({
      adapter: adapterFor(route.providerId),
      adapterKey: route.effectAdapterKey,
      capability: SEARCH_CAPABILITY,
      clock: () => CLOCK_MS,
      configuration: { contentHash: CONFIGURATION_HASH, value: {} },
      deadlineAtMs: () => CLOCK_MS + 10_000,
      inputContract: SEARCH_CONTRACTS.input,
      outputContract: SEARCH_CONTRACTS.output,
    });
    const outcome = await effect.execute(requestFor(route.providerId, index));
    outcomes.push(outcome);
    if (outcome.status === "succeeded" || !outcome.retryable) {
      break;
    }
  }

  const [primary, secondary] = outcomes;
  assert(primary?.status === "failed", "primary was not a definite failure");
  assert(primary?.reason === "plugin-rate-limited", "primary reason drifted");
  assert(primary?.retryable === true, "primary was not retryable");
  assert(
    primary?.settlement.kind === "settle" &&
      primary.settlement.amount === 1 &&
      primary.settlement.unit === "requests",
    "primary usage was not settled exactly"
  );
  assert(secondary?.status === "succeeded", "secondary did not succeed");
  assert(
    secondary?.settlement.kind === "settle" &&
      secondary.settlement.amount === 1 &&
      secondary.settlement.unit === "requests",
    "secondary usage was not settled exactly"
  );
  assert(
    secondary?.output.value === "https://example.com",
    "secondary normalized output drifted"
  );
  assert(
    providerCalls.tavily === 1 && providerCalls.exa === 1,
    "controlled request count drifted"
  );

  return Object.freeze({
    components: Object.freeze([
      "official-provider-registry",
      "official-provider-adapters",
      "trusted-plugin-bridge",
    ]),
    kind: "controlled-component-no-network",
    operation_key_reused: true,
    primary: Object.freeze({
      outcome: "failed",
      provider: "tavily-search",
      reason: "plugin-rate-limited",
      retryable: true,
      settlement: "settle-exactly-one-request",
    }),
    provider_order: Object.freeze(["tavily-search", "exa-search"]),
    secondary: Object.freeze({
      normalized_origin: "https://example.com",
      outcome: "succeeded",
      provider: "exa-search",
      settlement: "settle-exactly-one-request",
    }),
    simulated_requests: Object.freeze({ exa: 1, tavily: 1 }),
  });
};

const isMainModule =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMainModule) {
  try {
    process.stdout.write(
      `${JSON.stringify(await runControlledFallbackProof())}\n`
    );
  } catch {
    process.stderr.write("Controlled provider fallback proof failed.\n");
    process.exitCode = 1;
  }
}
