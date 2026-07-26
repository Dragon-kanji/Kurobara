import assert from "node:assert/strict";
import test from "node:test";

import { instant } from "@kurobara/kernel";

import {
  CONTACT_PRIVACY_RESTRICTIONS,
  type ContactPrivacyFacts,
  type ContactPrivacyPolicySnapshot,
  evaluateContactPrivacy,
} from "../src/index.ts";

const hour = 60 * 60 * 1000;
const now = instant(50 * hour);
const policy: ContactPrivacyPolicySnapshot = {
  expiresAt: instant(100 * hour),
  purposeRefs: ["synthetic-sales-research"],
  rules: {
    "contact-identity": {
      allowedActions: ["discover", "export"],
      maxRetentionMilliseconds: 24 * hour,
    },
    employment: {
      allowedActions: ["discover", "export"],
      maxRetentionMilliseconds: 24 * hour,
    },
    "personal-email": {
      allowedActions: ["enrich", "export"],
      maxRetentionMilliseconds: 2 * hour,
    },
    phone: {
      allowedActions: ["enrich", "export"],
      maxRetentionMilliseconds: 2 * hour,
    },
    "professional-email": {
      allowedActions: ["enrich", "export"],
      maxRetentionMilliseconds: 12 * hour,
    },
    "professional-social-profile": {
      allowedActions: ["discover", "export"],
      maxRetentionMilliseconds: 24 * hour,
    },
  },
  territories: ["ES", "FR"],
  version: "contact-privacy-test-v1",
};

const facts = (
  overrides: Partial<ContactPrivacyFacts> = {}
): ContactPrivacyFacts => ({
  action: "discover",
  activeRestrictions: [],
  explicitlyEnabledDataClasses: [],
  now,
  purposeRef: "synthetic-sales-research",
  requestedData: [{ dataClass: "employment" }],
  territory: "ES",
  ...overrides,
});

test("allows an explicitly configured class and returns its retention bound", () => {
  const decision = evaluateContactPrivacy(policy, facts());

  assert.deepEqual(decision, {
    allowed: true,
    deniedDataClasses: [],
    policyVersion: "contact-privacy-test-v1",
    reasonCodes: ["allowed"],
    retentionLimits: [
      {
        dataClass: "employment",
        expiresAt: policy.expiresAt,
        maxRetentionMilliseconds: 24 * hour,
      },
    ],
    stopExternalEffects: false,
    stopFallback: false,
  });
});

test("fails closed when a requested class is absent from the snapshot", () => {
  const decision = evaluateContactPrivacy(
    { ...policy, rules: { employment: policy.rules.employment } },
    facts({
      action: "enrich",
      requestedData: [{ dataClass: "professional-email" }],
    })
  );

  assert.equal(decision.allowed, false);
  assert.deepEqual(decision.reasonCodes, ["data-class-disabled"]);
  assert.deepEqual(decision.deniedDataClasses, ["professional-email"]);
  assert.equal(decision.stopExternalEffects, true);
  assert.equal(decision.stopFallback, true);
});

for (const dataClass of ["personal-email", "phone"] as const) {
  test(`requires an explicit opt-in for ${dataClass}`, () => {
    const decision = evaluateContactPrivacy(
      policy,
      facts({ action: "enrich", requestedData: [{ dataClass }] })
    );

    assert.equal(decision.allowed, false);
    assert.deepEqual(decision.reasonCodes, ["explicit-opt-in-required"]);
    assert.deepEqual(decision.deniedDataClasses, [dataClass]);
  });
}

test("allows a sensitive class only when the snapshot and facts opt in", () => {
  const decision = evaluateContactPrivacy(
    policy,
    facts({
      action: "enrich",
      explicitlyEnabledDataClasses: ["personal-email"],
      requestedData: [{ dataClass: "personal-email" }],
    })
  );

  assert.equal(decision.allowed, true);
  assert.deepEqual(decision.reasonCodes, ["allowed"]);
});

for (const restriction of CONTACT_PRIVACY_RESTRICTIONS) {
  test(`stops external effects and fallback for ${restriction}`, () => {
    const decision = evaluateContactPrivacy(
      policy,
      facts({ activeRestrictions: [restriction] })
    );

    assert.equal(decision.allowed, false);
    assert.deepEqual(decision.reasonCodes, [restriction]);
    assert.equal(decision.stopExternalEffects, true);
    assert.equal(decision.stopFallback, true);
  });
}

test("fails closed for unresolved or denied purpose and territory facts", () => {
  assert.deepEqual(
    evaluateContactPrivacy(policy, facts({ purposeRef: null, territory: null }))
      .reasonCodes,
    ["purpose-unresolved", "territory-unresolved"]
  );
  assert.deepEqual(
    evaluateContactPrivacy(
      policy,
      facts({ purposeRef: "different-purpose", territory: "US" })
    ).reasonCodes,
    ["purpose-denied", "territory-denied"]
  );
});

test("requires observation time for export and rejects expired values", () => {
  const missingObservation = evaluateContactPrivacy(
    policy,
    facts({ action: "export" })
  );
  const expired = evaluateContactPrivacy(
    policy,
    facts({
      action: "export",
      requestedData: [
        { dataClass: "employment", observedAt: instant(now - 24 * hour) },
      ],
    })
  );

  assert.deepEqual(missingObservation.reasonCodes, [
    "observation-time-missing",
  ]);
  assert.deepEqual(expired.reasonCodes, ["ttl-expired"]);
  assert.equal(expired.retentionLimits[0]?.expiresAt, now);
});

test("uses the policy expiry as the strictest retention boundary", () => {
  const shortPolicy = { ...policy, expiresAt: instant(now + hour) };
  const decision = evaluateContactPrivacy(
    shortPolicy,
    facts({
      action: "export",
      requestedData: [
        { dataClass: "employment", observedAt: instant(now - hour) },
      ],
    })
  );

  assert.equal(decision.allowed, true);
  assert.equal(decision.retentionLimits[0]?.expiresAt, shortPolicy.expiresAt);
});

test("refuses an expired snapshot and an empty data request", () => {
  const expiredPolicy = { ...policy, expiresAt: now };

  assert.deepEqual(evaluateContactPrivacy(expiredPolicy, facts()).reasonCodes, [
    "policy-expired",
  ]);
  assert.deepEqual(
    evaluateContactPrivacy(policy, facts({ requestedData: [] })).reasonCodes,
    ["data-class-missing"]
  );
});

test("rejects invalid retention and future observation times", () => {
  const invalidRetentionPolicy: ContactPrivacyPolicySnapshot = {
    ...policy,
    rules: {
      ...policy.rules,
      employment: {
        allowedActions: ["export"],
        maxRetentionMilliseconds: 0,
      },
    },
  };
  const exportFacts = facts({
    action: "export",
    requestedData: [
      { dataClass: "employment", observedAt: instant(now + hour) },
    ],
  });

  assert.deepEqual(
    evaluateContactPrivacy(invalidRetentionPolicy, exportFacts).reasonCodes,
    ["retention-limit-invalid"]
  );
  assert.deepEqual(evaluateContactPrivacy(policy, exportFacts).reasonCodes, [
    "observation-time-invalid",
  ]);
});

test("rejects duplicate and runtime-unknown data classes", () => {
  const unknownRequest = { dataClass: "employment" as const };
  Reflect.set(unknownRequest, "dataClass", "runtime-unknown-class");
  const unknownDecision = evaluateContactPrivacy(
    policy,
    facts({
      requestedData: [{ dataClass: "employment" }, unknownRequest],
    })
  );
  const duplicateDecision = evaluateContactPrivacy(
    policy,
    facts({
      action: "export",
      requestedData: [
        { dataClass: "employment", observedAt: now },
        { dataClass: "employment" },
      ],
    })
  );

  assert.deepEqual(unknownDecision.reasonCodes, ["data-class-unknown"]);
  assert.deepEqual(unknownDecision.deniedDataClasses, ["employment"]);
  assert.deepEqual(duplicateDecision.reasonCodes, ["data-class-duplicate"]);
  assert.equal(duplicateDecision.allowed, false);
});

test("rejects a runtime-unknown privacy restriction", () => {
  const hostileRestrictions = [...facts().activeRestrictions];
  Reflect.set(hostileRestrictions, 0, "runtime-unknown-restriction");

  const decision = evaluateContactPrivacy(
    policy,
    facts({ activeRestrictions: hostileRestrictions })
  );

  assert.deepEqual(decision.reasonCodes, ["restriction-unknown"]);
  assert.equal(decision.stopExternalEffects, true);
  assert.equal(decision.stopFallback, true);
});

test("returns canonical classes and restriction reasons", () => {
  const decision = evaluateContactPrivacy(
    policy,
    facts({
      activeRestrictions: ["territory-restriction", "provider-opt-out"],
      requestedData: [
        { dataClass: "phone" },
        { dataClass: "contact-identity" },
      ],
    })
  );

  assert.deepEqual(decision.reasonCodes, [
    "provider-opt-out",
    "territory-restriction",
    "explicit-opt-in-required",
    "action-denied",
  ]);
  assert.deepEqual(decision.deniedDataClasses, ["contact-identity", "phone"]);
});
