import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  createConfiguredOfficialProviderRoutes,
  createConfiguredSelectedContactProviderRoutes,
} from "@kurobara/adapter-provider-registry";
import {
  loadPlanningManifest,
  runPlanningOperator,
} from "../../apps/api/src/bootstrap-planning.ts";

const planningFile = fileURLToPath(
  new URL(
    "../../examples/planning-bundle.company-contact.v1.json",
    import.meta.url
  )
);

const capabilityKey = (
  capability: Readonly<{
    capabilityId: string;
    capabilityVersion: string;
  }>
): string => `${capability.capabilityId}@${capability.capabilityVersion}`;

test("admits the bounded B2B dogfood vertical on the current Hunter and Prospeo routes", async () => {
  const checked = await runPlanningOperator(
    ["--check", "--file", planningFile],
    {}
  );
  assert.deepEqual(checked.counts, {
    authorities: 1,
    policies: 1,
    pricing: 1,
    workflows: 0,
  });
  assert.equal(checked.status, "valid");
  assert.equal(checked.workspace_id, "workspace-b2b-dogfood");

  const { manifest } = await loadPlanningManifest(planningFile);
  const authority = manifest.planning.authorities[0];
  const policy = manifest.planning.policies[0]?.policy;
  const pricing = manifest.planning.pricing[0];
  assert.ok(authority);
  assert.ok(policy);
  assert.ok(pricing);
  assert.deepEqual(authority.capabilities.map(capabilityKey), [
    "organizations.discover@1.0.0",
    "contacts.discover@1.0.0",
    "contacts.identity.reveal@1.0.0",
    "contacts.work-email.resolve@1.0.0",
    "contacts.work-email.verify@1.0.0",
  ]);
  assert.deepEqual(authority.permissions, [
    "capabilities:list",
    "contacts:export",
    "contacts:discover",
    "contacts:enrich",
    "datasets:export",
    "datasets:generate",
    "datasets:read",
    "plans:quote",
    "steps:execute",
  ]);
  assert.deepEqual(authority.budgetLimit, {
    limit: 4,
    reserved: 0,
    spent: 0,
    unit: "requests",
  });
  assert.equal(policy.maxAttemptsPerStep, 1);
  assert.equal(policy.requiredPermission, "datasets:generate");
  assert.equal(pricing.guarantee, "hard");
  assert.equal(pricing.unit, "requests");
  assert.equal(pricing.upperBound, 1);

  const environment = {
    HUNTER_API_KEY: "synthetic-hunter-key",
    KUROBARA_CONTACT_PRIVACY_HMAC_SECRET:
      "synthetic-contact-privacy-hmac-secret-v1",
    KUROBARA_PROVIDER_ORDER: "prospeo,hunter",
    PROSPEO_API_KEY: "synthetic-prospeo-key",
  } as const;
  const routes = [
    ...createConfiguredOfficialProviderRoutes(environment),
    ...createConfiguredSelectedContactProviderRoutes(environment),
  ];
  assert.deepEqual(
    routes.map((route) => ({
      capability: capabilityKey(route.capability),
      effectAdapterKey: route.effectAdapterKey,
      providerIdentityNamespace: route.providerIdentityNamespace ?? null,
      routeKey: route.routeKey,
    })),
    [
      {
        capability: "contacts.discover@1.0.0",
        effectAdapterKey: "prospeo-person-search",
        providerIdentityNamespace: null,
        routeKey: "prospeo-person-search",
      },
      {
        capability: "organizations.discover@1.0.0",
        effectAdapterKey: "hunter-discover",
        providerIdentityNamespace: null,
        routeKey: "hunter-discover",
      },
      {
        capability: "contacts.identity.reveal@1.0.0",
        effectAdapterKey: "prospeo-person-enrichment",
        providerIdentityNamespace: "prospeo-person-search",
        routeKey: "prospeo-person-enrichment",
      },
      {
        capability: "contacts.work-email.resolve@1.0.0",
        effectAdapterKey: "prospeo-email-enrichment",
        providerIdentityNamespace: "prospeo-person-search",
        routeKey: "prospeo-email-enrichment",
      },
      {
        capability: "contacts.work-email.resolve@1.0.0",
        effectAdapterKey: "hunter-email-finder-prospeo",
        providerIdentityNamespace: "prospeo-person-search",
        routeKey: "hunter-email-finder-prospeo",
      },
      {
        capability: "contacts.work-email.verify@1.0.0",
        effectAdapterKey: "hunter-email-verifier-prospeo",
        providerIdentityNamespace: "prospeo-person-search",
        routeKey: "hunter-email-verifier-prospeo",
      },
    ]
  );
});
