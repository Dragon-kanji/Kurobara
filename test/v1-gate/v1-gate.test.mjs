import assert from "node:assert/strict";
import test from "node:test";

import {
  assertExaDataRightsAttestation,
  assertLiveRoutingProof,
  authorizeLiveProviderCalls,
  confirmProviderCalls,
  createProviderCallAccounting,
  parseArguments,
  parseProviderEnvironment,
  recordPossibleProviderCalls,
  redactText,
  V1GateError,
  verifyTrackedFixtures,
} from "../../scripts/v1-gate.mjs";

const CONTENT_HASH_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const DUPLICATED_PATTERN = /duplicated/u;
const UNQUOTED_PATTERN = /unquoted/u;

test("parses fixture and live modes without accepting secret CLI arguments", () => {
  assert.deepEqual(parseArguments(["--mode", "fixture"]), {
    confirmProviderCalls: false,
    keepInfrastructure: false,
    mode: "fixture",
    providerEnvFile: new URL("../../.env.local", import.meta.url).pathname,
    reportPath: undefined,
    requireClean: false,
  });
  const live = parseArguments([
    "--mode",
    "live",
    "--provider-env-file",
    "/tmp/providers.env",
    "--confirm-provider-calls",
    "--require-clean",
  ]);
  assert.equal(live.mode, "live");
  assert.equal(live.providerEnvFile, "/tmp/providers.env");
  assert.equal(live.confirmProviderCalls, true);
  assert.equal(live.requireClean, true);
  assert.throws(
    () => parseArguments(["--mode", "live", "--api-key", "secret"]),
    V1GateError
  );
});

test("parses only allowlisted private provider configuration", () => {
  assert.deepEqual(
    parseProviderEnvironment(
      [
        "# private local file",
        "TAVILY_API_KEY=synthetic-tavily",
        "UNRELATED_SECRET=ignored",
        "EXA_API_KEY=synthetic-exa",
        "KUROBARA_EXA_DATA_RIGHTS_CONFIRMED=true",
        "",
      ].join("\n")
    ),
    {
      EXA_API_KEY: "synthetic-exa",
      KUROBARA_EXA_DATA_RIGHTS_CONFIRMED: "true",
      TAVILY_API_KEY: "synthetic-tavily",
    }
  );
  assert.throws(
    () => parseProviderEnvironment("EXA_API_KEY='synthetic'\n"),
    UNQUOTED_PATTERN
  );
  assert.throws(
    () => parseProviderEnvironment("EXA_API_KEY=one\nEXA_API_KEY=two\n"),
    DUPLICATED_PATTERN
  );
});

test("requires an exact Exa rights attestation before live qualification", () => {
  for (const attestation of [undefined, "", "false", "TRUE", "1"]) {
    assert.throws(
      () =>
        assertExaDataRightsAttestation({
          KUROBARA_EXA_DATA_RIGHTS_CONFIRMED: attestation,
        }),
      V1GateError
    );
  }
  assert.equal(
    assertExaDataRightsAttestation({
      KUROBARA_EXA_DATA_RIGHTS_CONFIRMED: "true",
    }),
    undefined
  );
});

test("redacts exact credentials, bearer values, bootstrap keys, and DSN passwords", () => {
  const secret = "synthetic-provider-key";
  const redacted = redactText(
    `value=${secret} Authorization: Bearer bearer-value {"presented_key":"bootstrap-value"} postgres://user:password@localhost/db`,
    [secret]
  );
  assert.equal(redacted.includes(secret), false);
  assert.equal(redacted.includes("bearer-value"), false);
  assert.equal(redacted.includes("bootstrap-value"), false);
  assert.equal(redacted.includes("password"), false);
});

test("tracked V1 examples remain aligned with generated contracts and source hash", async () => {
  const proof = await verifyTrackedFixtures();
  assert.match(proof.catalog_fingerprint, CONTENT_HASH_PATTERN);
  assert.match(proof.dataset_source_sha256, CONTENT_HASH_PATTERN);
});

const liveRoutingProof = () => ({
  attempt_count: 2,
  attempt_numbers: [1, 2],
  attempt_reasons: ["initial", "fallback"],
  attempt_states: ["failed_retryable", "succeeded"],
  effect_thresholds_started: true,
  exact_usage_settled: true,
  kind: "durable-live-worker-routing",
  operation_key_reused: true,
  provider_order: ["tavily-search", "exa-search"],
  routing_provenance_complete: true,
  target_run_count: 1,
});

test("accepts only the exact redacted durable live fallback proof", () => {
  const proof = liveRoutingProof();
  assert.equal(assertLiveRoutingProof(proof), proof);
  for (const invalid of [
    { ...proof, provider_order: ["exa-search", "tavily-search"] },
    { ...proof, operation_key_reused: false },
    { ...proof, effect_thresholds_started: false },
    { ...proof, provider_payload: "must-not-be-reported" },
  ]) {
    assert.throws(() => assertLiveRoutingProof(invalid), {
      code: "live-fallback-proof-invalid",
    });
  }
});

test("keeps conservative provider accounting after a probe succeeds and a later step fails", () => {
  const accounting = createProviderCallAccounting();
  assert.deepEqual(accounting, {
    exa_attempted_requests_upper_bound: 0,
    exa_confirmed_requests: 0,
    exa_max_requests: 0,
    tavily_attempted_requests_upper_bound: 0,
    tavily_confirmed_requests: 0,
    tavily_max_requests: 0,
  });

  authorizeLiveProviderCalls(accounting);
  recordPossibleProviderCalls(accounting, "exa");
  confirmProviderCalls(accounting, "exa");

  assert.deepEqual(accounting, {
    exa_attempted_requests_upper_bound: 1,
    exa_confirmed_requests: 1,
    exa_max_requests: 2,
    tavily_attempted_requests_upper_bound: 0,
    tavily_confirmed_requests: 0,
    tavily_max_requests: 1,
  });
});

test("records possible provider calls before confirmation and enforces authorization", () => {
  const accounting = createProviderCallAccounting();
  authorizeLiveProviderCalls(accounting);
  recordPossibleProviderCalls(accounting, "exa");

  assert.deepEqual(accounting, {
    exa_attempted_requests_upper_bound: 1,
    exa_confirmed_requests: 0,
    exa_max_requests: 2,
    tavily_attempted_requests_upper_bound: 0,
    tavily_confirmed_requests: 0,
    tavily_max_requests: 1,
  });
  assert.throws(
    () => confirmProviderCalls(createProviderCallAccounting(), "exa"),
    { code: "provider-call-accounting-invalid" }
  );
  recordPossibleProviderCalls(accounting, "exa");
  assert.throws(() => recordPossibleProviderCalls(accounting, "exa"), {
    code: "provider-call-accounting-invalid",
  });
});
