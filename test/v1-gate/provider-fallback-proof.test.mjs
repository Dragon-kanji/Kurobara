import assert from "node:assert/strict";
import test from "node:test";

import { runControlledFallbackProof } from "./provider-fallback-proof.mjs";

test("proves controlled Tavily to Exa fallback through production components", async () => {
  assert.deepEqual(await runControlledFallbackProof(), {
    components: [
      "official-provider-registry",
      "official-provider-adapters",
      "trusted-plugin-bridge",
    ],
    kind: "controlled-component-no-network",
    operation_key_reused: true,
    primary: {
      outcome: "failed",
      provider: "tavily-search",
      reason: "plugin-rate-limited",
      retryable: true,
      settlement: "settle-exactly-one-request",
    },
    provider_order: ["tavily-search", "exa-search"],
    secondary: {
      normalized_origin: "https://example.com",
      outcome: "succeeded",
      provider: "exa-search",
      settlement: "settle-exactly-one-request",
    },
    simulated_requests: { exa: 1, tavily: 1 },
  });
});
