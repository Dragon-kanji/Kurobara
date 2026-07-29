import assert from "node:assert/strict";
import test from "node:test";

import { organizationDiscoveryQueryContract } from "@kurobara/adapter-http";
import {
  createCompanyDiscoveryQueryNormalizer,
  toCapabilityId,
} from "@kurobara/adapter-system";

import { organizationDiscoveryQueryForPlay } from "../src/gtm-play-executor.ts";

const normalizer = createCompanyDiscoveryQueryNormalizer({
  contract: organizationDiscoveryQueryContract,
});
const capability = {
  capabilityId: toCapabilityId("organizations.discover"),
  capabilityVersion: "1.0.0",
} as const;

test("omits an empty optional keyword filter from a Play organization query", () => {
  const query = organizationDiscoveryQueryForPlay({
    countries: ["ES"],
    industries: ["software"],
    keywords: [],
    kind: "organization_search",
  });

  assert.ok(query !== null && typeof query === "object");
  assert.equal("keywords" in query, false);
  assert.equal(normalizer.normalize({ capability, query }).status, "accepted");
});

test("preserves non-empty Play organization keywords", () => {
  const query = organizationDiscoveryQueryForPlay({
    countries: ["ES"],
    industries: ["software"],
    keywords: ["revenue operations"],
    kind: "organization_search",
  });

  assert.deepEqual(query, {
    country_codes: ["ES"],
    country_scope: "headquarters",
    industry_codes: ["software"],
    industry_taxonomy: "kurobara-v1",
    keywords: ["revenue operations"],
    result_kind: "company",
  });
  assert.equal(normalizer.normalize({ capability, query }).status, "accepted");
});
