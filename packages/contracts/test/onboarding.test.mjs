import assert from "node:assert/strict";
import test from "node:test";

import onboarding from "@kurobara/contracts/cli-onboarding.json" with {
  type: "json",
};
import providers from "@kurobara/contracts/provider-registry.json" with {
  type: "json",
};

test("publishes one versioned onboarding contract for human and agent projections", () => {
  assert.equal(onboarding.schema_version, "1.0.0");
  assert.deepEqual(onboarding.setup_phases, [
    "detect",
    "plan",
    "confirm",
    "apply",
    "verify",
  ]);
  assert.ok(onboarding.commands.includes("setup inspect"));
  assert.ok(onboarding.commands.includes("setup plan"));
  assert.ok(onboarding.commands.includes("setup apply"));
  assert.ok(onboarding.commands.includes("setup status"));
  assert.ok(onboarding.commands.includes("doctor"));
  assert.equal(onboarding.secret_rules.argv_values_forbidden, true);
  assert.equal(onboarding.secret_rules.provider_keys_server_side_only, true);
});

test("keeps the provider onboarding catalog unique, non-secret, and explicit", () => {
  assert.equal(providers.schema_version, "1.0.0");
  assert.deepEqual(
    providers.providers.map(({ key }) => key),
    ["prospeo", "hunter", "tavily", "exa", "apollo", "pdl"]
  );
  assert.equal(
    new Set(providers.providers.map(({ key }) => key)).size,
    providers.providers.length
  );
  assert.equal(
    providers.providers
      .filter(({ default_order }) => default_order !== null)
      .map(({ key }) => key)
      .join(","),
    "prospeo,hunter"
  );
  assert.equal(
    JSON.stringify(providers).includes("synthetic-provider-secret"),
    false
  );
  assert.equal(
    providers.providers.find(({ key }) => key === "exa")
      ?.rights_attestation_environment_variable,
    "KUROBARA_EXA_DATA_RIGHTS_CONFIRMED"
  );
  assert.equal(
    providers.providers.find(({ key }) => key === "pdl")?.admission,
    "candidate_rights_required"
  );
});
