import assert from "node:assert/strict";
import test from "node:test";

import { instant } from "@kurobara/kernel";

import {
  evaluateSourcingBudgetPreflight,
  type SourcingBudgetPreflightFacts,
  type SourcingCardinalityLimits,
  type UnknownSourcingCostPolicy,
} from "../src/index.ts";

const now = instant(1000);
const limits: SourcingCardinalityLimits = {
  maxCalls: 40,
  maxCompanies: 10,
  maxContactsPerCompany: 3,
  maxContactsTotal: 25,
  maxEnrichments: 20,
  maxPages: 10,
  maxPhones: 5,
  maxResults: 100,
};

const facts = (
  overrides: Partial<SourcingBudgetPreflightFacts> = {}
): SourcingBudgetPreflightFacts => ({
  budget: { limit: 50, reserved: 3, spent: 2, unit: "credits" },
  deadline: instant(5000),
  limits,
  now,
  quote: {
    expiresAt: instant(4000),
    guarantee: "hard",
    pricingVersion: "synthetic-pricing-v1",
    quoteId: "synthetic-quote",
    unit: "credits",
    upperBound: 30,
  },
  unknownCostPolicy: { mode: "deny" },
  ...overrides,
});

test("allows an explicitly bounded hard quote and returns a detached snapshot", () => {
  const input = facts();
  const decision = evaluateSourcingBudgetPreflight(input);

  assert.deepEqual(decision, {
    allowed: true,
    reasonCodes: ["allowed"],
    snapshot: {
      budget: input.budget,
      deadline: input.deadline,
      hardExecutionCap: 30,
      limits,
      quote: input.quote,
    },
    stopExternalEffects: false,
    stopFallback: false,
  });
  assert.notEqual(decision.snapshot?.budget, input.budget);
  assert.notEqual(decision.snapshot?.quote, input.quote);
});

test("treats explicit zero caps as bounded category disablement", () => {
  const zeroLimits: SourcingCardinalityLimits = {
    maxCalls: 0,
    maxCompanies: 0,
    maxContactsPerCompany: 0,
    maxContactsTotal: 0,
    maxEnrichments: 0,
    maxPages: 0,
    maxPhones: 0,
    maxResults: 0,
  };
  const decision = evaluateSourcingBudgetPreflight(
    facts({
      budget: { limit: 0, reserved: 0, spent: 0, unit: "credits" },
      limits: zeroLimits,
      quote: { ...facts().quote, upperBound: 0 },
    })
  );

  assert.equal(decision.allowed, true);
  assert.deepEqual(decision.snapshot?.limits, zeroLimits);
  assert.equal(decision.snapshot?.hardExecutionCap, 0);
});

test("admits selected-contact enrichment without company discovery caps", () => {
  const selectedContactLimits: SourcingCardinalityLimits = {
    maxCalls: 1,
    maxCompanies: 0,
    maxContactsPerCompany: 0,
    maxContactsTotal: 1,
    maxEnrichments: 1,
    maxPages: 1,
    maxPhones: 0,
    maxResults: 1,
  };
  const decision = evaluateSourcingBudgetPreflight(
    facts({
      budget: { limit: 1, reserved: 0, spent: 0, unit: "requests" },
      limits: selectedContactLimits,
      quote: {
        ...facts().quote,
        unit: "requests",
        upperBound: 1,
      },
    })
  );

  assert.equal(decision.allowed, true);
  assert.deepEqual(decision.snapshot?.limits, selectedContactLimits);
});

test("admits company discovery with contact dimensions disabled", () => {
  const companyOnlyLimits: SourcingCardinalityLimits = {
    maxCalls: 1,
    maxCompanies: 1,
    maxContactsPerCompany: 0,
    maxContactsTotal: 0,
    maxEnrichments: 0,
    maxPages: 1,
    maxPhones: 0,
    maxResults: 1,
  };
  const decision = evaluateSourcingBudgetPreflight(
    facts({
      budget: { limit: 1, reserved: 0, spent: 0, unit: "requests" },
      limits: companyOnlyLimits,
      quote: {
        ...facts().quote,
        unit: "requests",
        upperBound: 1,
      },
    })
  );

  assert.equal(decision.allowed, true);
  assert.deepEqual(decision.snapshot?.limits, companyOnlyLimits);
});

test("fails closed for missing, unknown, or invalid limits", () => {
  const hostileLimits = { ...limits };
  Reflect.deleteProperty(hostileLimits, "maxCalls");
  Reflect.set(hostileLimits, "all", true);
  Reflect.set(hostileLimits, "maxPages", Number.POSITIVE_INFINITY);

  const decision = evaluateSourcingBudgetPreflight(
    facts({ limits: hostileLimits })
  );

  assert.deepEqual(decision.reasonCodes, [
    "limit-unknown",
    "limit-missing",
    "limit-invalid",
  ]);
  assert.equal(decision.snapshot, undefined);
  assert.equal(decision.stopExternalEffects, true);
  assert.equal(decision.stopFallback, true);
});

test("does not accept a required cap inherited from the prototype", () => {
  const inheritedLimits = { ...limits };
  Reflect.deleteProperty(inheritedLimits, "maxCalls");
  Object.setPrototypeOf(inheritedLimits, { maxCalls: 40 });

  const decision = evaluateSourcingBudgetPreflight(
    facts({ limits: inheritedLimits })
  );

  assert.deepEqual(decision.reasonCodes, ["limit-missing"]);
  assert.equal(decision.allowed, false);
});

test("turns malformed or accessor-backed facts into a closed input failure", () => {
  const malformedInputs = [
    (() => {
      const input = facts();
      Reflect.set(input, "limits", null);
      return input;
    })(),
    (() => {
      const input = facts();
      Reflect.set(input, "budget", null);
      return input;
    })(),
    (() => {
      const input = facts();
      Reflect.set(input.quote, "quoteId", 1);
      return input;
    })(),
    (() => {
      const input = facts();
      Reflect.set(input, "unknownCostPolicy", null);
      return input;
    })(),
    (() => {
      const input = facts();
      Object.defineProperty(input.quote, "quoteId", {
        get: () => {
          throw new Error("synthetic accessor must not run");
        },
      });
      return input;
    })(),
  ];

  for (const input of malformedInputs) {
    assert.deepEqual(evaluateSourcingBudgetPreflight(input), {
      allowed: false,
      reasonCodes: ["input-invalid"],
      stopExternalEffects: true,
      stopFallback: true,
    });
  }
});

test("evaluates a descriptor snapshot instead of rereading proxy values", () => {
  const proxyLimits = new Proxy(
    {
      maxCalls: 1,
      maxCompanies: 1,
      maxContactsPerCompany: 1,
      maxContactsTotal: 1,
      maxEnrichments: 1,
      maxPages: 1,
      maxPhones: 1,
      maxResults: 1,
    },
    {
      get: () => -1,
    }
  );

  const decision = evaluateSourcingBudgetPreflight(
    facts({ limits: proxyLimits })
  );

  assert.equal(decision.allowed, true);
  assert.deepEqual(decision.snapshot?.limits, {
    maxCalls: 1,
    maxCompanies: 1,
    maxContactsPerCompany: 1,
    maxContactsTotal: 1,
    maxEnrichments: 1,
    maxPages: 1,
    maxPhones: 1,
    maxResults: 1,
  });
});

test("does not execute or copy unrelated accessors into the budget snapshot", () => {
  let credentialReads = 0;
  const budget = {
    get credential(): string {
      credentialReads += 1;
      return "synthetic-secret";
    },
    limit: 50,
    reserved: 3,
    spent: 2,
    unit: "credits",
  };

  const decision = evaluateSourcingBudgetPreflight(facts({ budget }));

  assert.equal(decision.allowed, true);
  assert.equal(credentialReads, 0);
  assert.equal(
    Object.hasOwn(decision.snapshot?.budget ?? {}, "credential"),
    false
  );
});

test("rejects overflowing or mutually inconsistent cardinality caps", () => {
  const overflow = evaluateSourcingBudgetPreflight(
    facts({
      limits: {
        ...limits,
        maxCompanies: Number.MAX_SAFE_INTEGER,
        maxContactsPerCompany: 2,
      },
    })
  );
  const inconsistent = evaluateSourcingBudgetPreflight(
    facts({
      limits: {
        ...limits,
        maxCalls: 2,
        maxContactsTotal: 31,
        maxEnrichments: 30,
        maxPages: 3,
        maxPhones: 31,
      },
    })
  );
  const partialCompanyCapacity = evaluateSourcingBudgetPreflight(
    facts({
      limits: {
        ...limits,
        maxCompanies: 0,
      },
    })
  );
  const perCompanyCapacityWithoutCompanies = evaluateSourcingBudgetPreflight(
    facts({
      limits: {
        ...limits,
        maxCompanies: 0,
        maxContactsTotal: 0,
        maxEnrichments: 0,
        maxPhones: 0,
      },
    })
  );

  assert.deepEqual(overflow.reasonCodes, ["limit-overflow"]);
  assert.deepEqual(inconsistent.reasonCodes, ["limits-inconsistent"]);
  assert.deepEqual(partialCompanyCapacity.reasonCodes, ["limits-inconsistent"]);
  assert.deepEqual(perCompanyCapacityWithoutCompanies.reasonCodes, [
    "limits-inconsistent",
  ]);
});

test("rejects invalid and elapsed deadlines", () => {
  const invalidFacts = facts();
  Reflect.set(invalidFacts, "deadline", Number.NaN);

  assert.deepEqual(evaluateSourcingBudgetPreflight(invalidFacts).reasonCodes, [
    "deadline-invalid",
  ]);
  assert.deepEqual(
    evaluateSourcingBudgetPreflight(facts({ deadline: now })).reasonCodes,
    ["deadline-elapsed"]
  );
});

test("rejects invalid budget and quote structures", () => {
  const decision = evaluateSourcingBudgetPreflight(
    facts({
      budget: { limit: 10, reserved: 6, spent: 5, unit: "requests" },
      quote: {
        ...facts().quote,
        expiresAt: now,
        quoteId: "",
        unit: "credits",
      },
    })
  );

  assert.deepEqual(decision.reasonCodes, ["budget-invalid", "quote-invalid"]);
});

test("rejects an expired quote or a quote in another unit", () => {
  assert.deepEqual(
    evaluateSourcingBudgetPreflight(
      facts({ quote: { ...facts().quote, expiresAt: now } })
    ).reasonCodes,
    ["quote-expired"]
  );
  assert.deepEqual(
    evaluateSourcingBudgetPreflight(
      facts({ quote: { ...facts().quote, unit: "requests" } })
    ).reasonCodes,
    ["quote-unit-mismatch"]
  );
});

test("requires a finite worst-known cost for hard and estimated quotes", () => {
  for (const guarantee of ["hard", "estimated"] as const) {
    const quote = { ...facts().quote, guarantee };
    Reflect.deleteProperty(quote, "upperBound");

    assert.deepEqual(
      evaluateSourcingBudgetPreflight(facts({ quote })).reasonCodes,
      ["quote-upper-bound-required"]
    );
  }
});

test("does not accept a quote upper bound inherited from the prototype", () => {
  const quote = { ...facts().quote };
  Reflect.deleteProperty(quote, "upperBound");
  Object.setPrototypeOf(quote, { upperBound: 30 });

  const decision = evaluateSourcingBudgetPreflight(facts({ quote }));

  assert.deepEqual(decision.reasonCodes, ["quote-upper-bound-required"]);
  assert.equal(decision.snapshot, undefined);
});

test("keeps the remaining budget as the hard cap for an estimated quote", () => {
  const decision = evaluateSourcingBudgetPreflight(
    facts({ quote: { ...facts().quote, guarantee: "estimated" } })
  );

  assert.equal(decision.allowed, true);
  assert.equal(decision.snapshot?.hardExecutionCap, 45);
  assert.equal(decision.snapshot?.quote.upperBound, 30);
});

test("rejects a known quote above the remaining hard budget", () => {
  const decision = evaluateSourcingBudgetPreflight(
    facts({ quote: { ...facts().quote, upperBound: 46 } })
  );

  assert.deepEqual(decision.reasonCodes, ["quote-exceeds-budget"]);
});

test("fails unknown cost closed without explicit non-interactive authority", () => {
  const quote = { ...facts().quote, guarantee: "unknown" as const };
  Reflect.deleteProperty(quote, "upperBound");

  const decision = evaluateSourcingBudgetPreflight(facts({ quote }));

  assert.deepEqual(decision.reasonCodes, [
    "unknown-cost-authorization-required",
  ]);
  assert.equal(decision.stopExternalEffects, true);
});

test("requires a valid unknown-cost hard cap within the remaining budget", () => {
  const quote = { ...facts().quote, guarantee: "unknown" as const };
  Reflect.deleteProperty(quote, "upperBound");
  const missingCap: UnknownSourcingCostPolicy = {
    hardCap: 10,
    mode: "explicit-non-interactive",
  };
  Reflect.deleteProperty(missingCap, "hardCap");

  assert.deepEqual(
    evaluateSourcingBudgetPreflight(
      facts({ quote, unknownCostPolicy: missingCap })
    ).reasonCodes,
    ["unknown-cost-hard-cap-required"]
  );
  assert.deepEqual(
    evaluateSourcingBudgetPreflight(
      facts({
        quote,
        unknownCostPolicy: {
          hardCap: 46,
          mode: "explicit-non-interactive",
        },
      })
    ).reasonCodes,
    ["unknown-cost-hard-cap-invalid"]
  );
});

test("does not accept an unknown-cost hard cap inherited from the prototype", () => {
  const quote = { ...facts().quote, guarantee: "unknown" as const };
  Reflect.deleteProperty(quote, "upperBound");
  const inheritedCap: UnknownSourcingCostPolicy = {
    hardCap: 10,
    mode: "explicit-non-interactive",
  };
  Reflect.deleteProperty(inheritedCap, "hardCap");
  Object.setPrototypeOf(inheritedCap, { hardCap: 10 });

  const decision = evaluateSourcingBudgetPreflight(
    facts({ quote, unknownCostPolicy: inheritedCap })
  );

  assert.deepEqual(decision.reasonCodes, ["unknown-cost-hard-cap-required"]);
});

test("allows unknown cost only with an explicit executable hard cap", () => {
  const quote = { ...facts().quote, guarantee: "unknown" as const };
  Reflect.deleteProperty(quote, "upperBound");
  const decision = evaluateSourcingBudgetPreflight(
    facts({
      quote,
      unknownCostPolicy: {
        hardCap: 12,
        mode: "explicit-non-interactive",
      },
    })
  );

  assert.equal(decision.allowed, true);
  assert.equal(decision.snapshot?.hardExecutionCap, 12);
});

test("rejects a runtime-unknown quote guarantee", () => {
  const quote = { ...facts().quote };
  Reflect.set(quote, "guarantee", "certain-ish");

  const decision = evaluateSourcingBudgetPreflight(facts({ quote }));

  assert.deepEqual(decision.reasonCodes, ["quote-invalid"]);
  assert.equal(decision.allowed, false);
});
