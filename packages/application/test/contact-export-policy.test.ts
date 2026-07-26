import assert from "node:assert/strict";
import test from "node:test";

import { instant } from "@kurobara/kernel";

import { createContactExportPolicyResolver } from "../src/contact-export-policy.ts";

const resolver = createContactExportPolicyResolver({
  maxRetentionMilliseconds: {
    "contact-identity": 10_000,
    "professional-email": 5000,
  },
  policyTtlMilliseconds: 2000,
  policyVersion: "operator-policy-v1",
  providerRights: {
    prospeo: {
      mode: "operator-authorized-byok",
      ttlMilliseconds: 1000,
      version: "operator-rights-v1",
    },
  },
  purposeRef: "owner-controlled-business-research",
  territory: "ES",
});

test("resolves bounded server-owned Contact export policy snapshots", () => {
  const result = resolver({
    now: 1000,
    providerKeys: ["prospeo"],
    requestedData: [
      { dataClass: "contact-identity", observedAt: instant(500) },
      { dataClass: "professional-email", observedAt: instant(750) },
    ],
  });

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.value.privacy.policy.expiresAt, 3000);
    assert.equal(result.value.providerRights.expiresAt, 2000);
    assert.deepEqual(Object.keys(result.value.privacy.policy.rules).sort(), [
      "contact-identity",
      "professional-email",
    ]);
  }
});

test("fails closed for an unknown provider or unconfigured data class", () => {
  for (const request of [
    {
      now: 1000,
      providerKeys: ["unknown-provider"],
      requestedData: [
        { dataClass: "contact-identity" as const, observedAt: instant(500) },
      ],
    },
    {
      now: 1000,
      providerKeys: ["prospeo"],
      requestedData: [
        { dataClass: "phone" as const, observedAt: instant(500) },
      ],
    },
  ]) {
    const result = resolver(request);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error.code, "contact-export-policy-unavailable");
    }
  }
});
