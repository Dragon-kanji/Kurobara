import assert from "node:assert/strict";
import test from "node:test";

import {
  createConfiguredDeterministicFixtureRoutes,
  createConfiguredOfficialProviderRoutes,
  createConfiguredPdlContactDiscoveryRouteCandidate,
  createConfiguredSelectedContactProviderRoutes,
  ProviderRegistryConfigError,
  parseConfiguredContactPrivacyHmacSecrets,
} from "../src/index.ts";

const APOLLO_SECRET = "synthetic-apollo-secret";
const TAVILY_SECRET = "synthetic-tavily-secret";
const EXA_SECRET = "synthetic-exa-secret";
const HUNTER_SECRET = "synthetic-hunter-secret";
const PROSPEO_SECRET = "synthetic-prospeo-secret";
const PDL_SECRET = "synthetic-pdl-secret";
const PRIVACY_SECRET = "synthetic-contact-privacy-secret-32-bytes";

test("admits the deterministic fixture route only through an exact opt-in", () => {
  const disabled = createConfiguredDeterministicFixtureRoutes({});
  const enabled = createConfiguredDeterministicFixtureRoutes({
    KUROBARA_FIXTURE_MODE: "deterministic",
  });

  assert.deepEqual(disabled, []);
  assert.equal(Object.isFrozen(disabled), true);
  assert.deepEqual(enabled, [
    {
      capability: {
        capabilityId: "organizations.website.resolve",
        capabilityVersion: "1.0.0",
      },
      effectAdapterKey: "deterministic-local",
      reservableUpperBound: 1,
      reservationUnit: "requests",
      routeKey: "deterministic-local",
    },
  ]);
  assert.equal(Object.isFrozen(enabled), true);
  assert.equal(Object.isFrozen(enabled[0]), true);
});

test("rejects ambiguous deterministic fixture mode values", () => {
  for (const fixtureMode of ["", "true", "false", " deterministic"]) {
    assert.throws(
      () =>
        createConfiguredDeterministicFixtureRoutes({
          KUROBARA_FIXTURE_MODE: fixtureMode,
        }),
      ProviderRegistryConfigError
    );
  }
});

test("fails closed with an empty catalogue when no provider key is configured", () => {
  const routes = createConfiguredOfficialProviderRoutes({});

  assert.deepEqual(routes, []);
  assert.equal(Object.isFrozen(routes), true);
});

test("treats explicitly empty provider keys as unconfigured", () => {
  assert.deepEqual(
    createConfiguredOfficialProviderRoutes({
      APOLLO_API_KEY: "",
      EXA_API_KEY: "",
      PROSPEO_API_KEY: "",
      TAVILY_API_KEY: "",
    }),
    []
  );
});

test("admits selected-contact routes only with provider keys and a stable privacy secret", () => {
  assert.deepEqual(
    createConfiguredSelectedContactProviderRoutes({
      APOLLO_API_KEY: APOLLO_SECRET,
      HUNTER_API_KEY: HUNTER_SECRET,
    }),
    []
  );
  const routes = createConfiguredSelectedContactProviderRoutes({
    APOLLO_API_KEY: APOLLO_SECRET,
    HUNTER_API_KEY: HUNTER_SECRET,
    KUROBARA_CONTACT_PRIVACY_HMAC_SECRET: PRIVACY_SECRET,
    KUROBARA_PROVIDER_ORDER: "prospeo,apollo,hunter",
    PROSPEO_API_KEY: PROSPEO_SECRET,
  });
  assert.deepEqual(
    routes.map((route) => route.providerId),
    [
      "prospeo-person-enrichment",
      "prospeo-email-enrichment",
      "apollo-people-enrichment",
      "hunter-email-finder-prospeo",
      "hunter-email-finder",
      "hunter-email-verifier",
      "hunter-email-verifier-prospeo",
    ]
  );
  assert.deepEqual(
    routes.map((route) => route.providerIdentityNamespace),
    [
      "prospeo-person-search",
      "prospeo-person-search",
      "apollo-people-search",
      "prospeo-person-search",
      "apollo-people-search",
      "apollo-people-search",
      "prospeo-person-search",
    ]
  );
  assert.equal(JSON.stringify(routes).includes(PRIVACY_SECRET), false);
});

test("orders selected-contact routes by the explicit provider order", () => {
  const routes = createConfiguredSelectedContactProviderRoutes({
    HUNTER_API_KEY: HUNTER_SECRET,
    KUROBARA_CONTACT_PRIVACY_HMAC_SECRET: PRIVACY_SECRET,
    KUROBARA_PROVIDER_ORDER: "hunter,prospeo",
    PROSPEO_API_KEY: PROSPEO_SECRET,
  });

  assert.deepEqual(
    routes.map((route) => route.providerId),
    [
      "hunter-email-finder-prospeo",
      "hunter-email-verifier-prospeo",
      "prospeo-person-enrichment",
      "prospeo-email-enrichment",
    ]
  );
  assert.equal(
    routes.every(
      (route) => route.providerIdentityNamespace === "prospeo-person-search"
    ),
    true
  );
});

test("keeps Apollo selected-contact routes out of the default Prospeo path", () => {
  const routes = createConfiguredSelectedContactProviderRoutes({
    APOLLO_API_KEY: APOLLO_SECRET,
    HUNTER_API_KEY: HUNTER_SECRET,
    KUROBARA_CONTACT_PRIVACY_HMAC_SECRET: PRIVACY_SECRET,
    PROSPEO_API_KEY: PROSPEO_SECRET,
  });

  assert.deepEqual(
    routes.map((route) => route.providerId),
    [
      "prospeo-person-enrichment",
      "prospeo-email-enrichment",
      "hunter-email-finder-prospeo",
      "hunter-email-verifier-prospeo",
    ]
  );
});

test("rejects weak or malformed selected-contact privacy secrets", () => {
  for (const environment of [
    { KUROBARA_CONTACT_PRIVACY_HMAC_SECRET: "too-short" },
    {
      KUROBARA_CONTACT_PRIVACY_HMAC_SECRET: ` ${PRIVACY_SECRET}`,
    },
    {
      KUROBARA_CONTACT_PRIVACY_HMAC_SECRET: PRIVACY_SECRET,
      KUROBARA_CONTACT_PRIVACY_HMAC_SECRET_VERSION: "bad version",
    },
  ]) {
    assert.throws(
      () => createConfiguredSelectedContactProviderRoutes(environment),
      ProviderRegistryConfigError
    );
  }
});

test("parses a rotation keyring with one current and one retained HMAC key", () => {
  const secrets = parseConfiguredContactPrivacyHmacSecrets({
    KUROBARA_CONTACT_PRIVACY_HMAC_KEYRING_JSON: JSON.stringify([
      {
        current: false,
        secret: "synthetic-contact-privacy-previous-secret",
        version: "v1",
      },
      {
        current: true,
        secret: "synthetic-contact-privacy-current-secret-2",
        version: "v2",
      },
    ]),
  });

  assert.deepEqual(
    secrets?.map(({ current, keyMaterial, version }) => ({
      current,
      keyMaterial: new TextDecoder().decode(keyMaterial),
      version,
    })),
    [
      {
        current: false,
        keyMaterial: "synthetic-contact-privacy-previous-secret",
        version: "v1",
      },
      {
        current: true,
        keyMaterial: "synthetic-contact-privacy-current-secret-2",
        version: "v2",
      },
    ]
  );
});

test("rejects ambiguous or unsafe contact privacy HMAC keyrings", () => {
  for (const environment of [
    {
      KUROBARA_CONTACT_PRIVACY_HMAC_KEYRING_JSON: "[]",
    },
    {
      KUROBARA_CONTACT_PRIVACY_HMAC_KEYRING_JSON: JSON.stringify([
        {
          current: true,
          secret: PRIVACY_SECRET,
          version: "v1",
        },
        {
          current: true,
          secret: `${PRIVACY_SECRET}-two`,
          version: "v2",
        },
      ]),
    },
    {
      KUROBARA_CONTACT_PRIVACY_HMAC_KEYRING_JSON: JSON.stringify([
        {
          current: true,
          secret: PRIVACY_SECRET,
          version: "v1",
        },
        {
          current: false,
          secret: `${PRIVACY_SECRET}-two`,
          version: "v1",
        },
      ]),
    },
    {
      KUROBARA_CONTACT_PRIVACY_HMAC_KEYRING_JSON: JSON.stringify([
        {
          current: true,
          secret: PRIVACY_SECRET,
          version: "v1",
        },
      ]),
      KUROBARA_CONTACT_PRIVACY_HMAC_SECRET: PRIVACY_SECRET,
    },
  ]) {
    assert.throws(
      () => parseConfiguredContactPrivacyHmacSecrets(environment),
      ProviderRegistryConfigError
    );
  }
});

test("admits Prospeo as the default contact provider", () => {
  assert.deepEqual(
    createConfiguredOfficialProviderRoutes({
      PROSPEO_API_KEY: PROSPEO_SECRET,
    }),
    [
      {
        capability: {
          capabilityId: "contacts.discover",
          capabilityVersion: "1.0.0",
        },
        credentialEnvironmentVariable: "PROSPEO_API_KEY",
        effectAdapterKey: "prospeo-person-search",
        providerId: "prospeo-person-search",
        reservableUpperBound: 1,
        reservationUnit: "requests",
        routeKey: "prospeo-person-search",
      },
    ]
  );
});

test("keeps Apollo available only through an explicit operator order", () => {
  assert.deepEqual(
    createConfiguredOfficialProviderRoutes({ APOLLO_API_KEY: APOLLO_SECRET }),
    []
  );
  assert.deepEqual(
    createConfiguredOfficialProviderRoutes({
      APOLLO_API_KEY: APOLLO_SECRET,
      KUROBARA_PROVIDER_ORDER: "apollo",
    }),
    [
      {
        capability: {
          capabilityId: "contacts.discover",
          capabilityVersion: "1.0.0",
        },
        credentialEnvironmentVariable: "APOLLO_API_KEY",
        effectAdapterKey: "apollo-people-search",
        providerId: "apollo-people-search",
        reservableUpperBound: 1,
        reservationUnit: "requests",
        routeKey: "apollo-people-search",
      },
    ]
  );
});

test("requires explicit operator order for website providers", () => {
  assert.deepEqual(
    createConfiguredOfficialProviderRoutes({ TAVILY_API_KEY: TAVILY_SECRET }),
    []
  );

  assert.deepEqual(
    createConfiguredOfficialProviderRoutes({ EXA_API_KEY: EXA_SECRET }).map(
      (route) => route.providerId
    ),
    []
  );

  assert.deepEqual(
    createConfiguredOfficialProviderRoutes({ HUNTER_API_KEY: HUNTER_SECRET }),
    [
      {
        capability: {
          capabilityId: "organizations.discover",
          capabilityVersion: "1.0.0",
        },
        credentialEnvironmentVariable: "HUNTER_API_KEY",
        effectAdapterKey: "hunter-discover",
        providerId: "hunter-discover",
        reservableUpperBound: 1,
        reservationUnit: "requests",
        routeKey: "hunter-discover",
      },
    ]
  );

  assert.deepEqual(
    createConfiguredOfficialProviderRoutes({
      EXA_API_KEY: EXA_SECRET,
      KUROBARA_EXA_DATA_RIGHTS_CONFIRMED: "true",
      KUROBARA_PROVIDER_ORDER: "tavily,exa",
      TAVILY_API_KEY: TAVILY_SECRET,
    }).map((route) => route.providerId),
    ["tavily-search", "exa-search"]
  );
});

test("orders configured providers from the strict operator order", () => {
  const routes = createConfiguredOfficialProviderRoutes({
    APOLLO_API_KEY: APOLLO_SECRET,
    EXA_API_KEY: EXA_SECRET,
    HUNTER_API_KEY: HUNTER_SECRET,
    KUROBARA_EXA_DATA_RIGHTS_CONFIRMED: "true",
    KUROBARA_PROVIDER_ORDER: "prospeo,apollo,hunter,exa,tavily",
    PROSPEO_API_KEY: PROSPEO_SECRET,
    TAVILY_API_KEY: TAVILY_SECRET,
  });

  assert.deepEqual(
    routes.map((route) => route.providerId),
    [
      "prospeo-person-search",
      "apollo-people-search",
      "hunter-discover",
      "exa-search",
      "tavily-search",
    ]
  );
  assert.equal(Object.isFrozen(routes), true);
  assert.equal(Object.isFrozen(routes[0]), true);
  assert.equal(Object.isFrozen(routes[0]?.capability), true);
});

test("requires an exact Exa rights attestation after explicit opt-in", () => {
  for (const attestation of [undefined, "", "false"]) {
    assert.deepEqual(
      createConfiguredOfficialProviderRoutes({
        EXA_API_KEY: EXA_SECRET,
        KUROBARA_EXA_DATA_RIGHTS_CONFIRMED: attestation,
        KUROBARA_PROVIDER_ORDER: "exa",
      }),
      []
    );
  }
  for (const attestation of ["TRUE", "1", " true", "false "]) {
    assert.throws(
      () =>
        createConfiguredOfficialProviderRoutes({
          EXA_API_KEY: EXA_SECRET,
          KUROBARA_EXA_DATA_RIGHTS_CONFIRMED: attestation,
          KUROBARA_PROVIDER_ORDER: "exa",
        }),
      ProviderRegistryConfigError
    );
  }
});

test("allows an explicit subset while preserving fail-closed key admission", () => {
  assert.deepEqual(
    createConfiguredOfficialProviderRoutes({
      EXA_API_KEY: EXA_SECRET,
      KUROBARA_PROVIDER_ORDER: "tavily",
      TAVILY_API_KEY: TAVILY_SECRET,
    }).map((route) => route.providerId),
    ["tavily-search"]
  );
});

test("rejects unknown, duplicate, empty, or whitespace-bearing provider orders", () => {
  for (const providerOrder of [
    "unknown",
    "hunter,hunter",
    "tavily,tavily",
    "prospeo,prospeo",
    "",
    "tavily,",
    "tavily, exa",
    " tavily,exa",
  ]) {
    assert.throws(
      () =>
        createConfiguredOfficialProviderRoutes({
          KUROBARA_PROVIDER_ORDER: providerOrder,
        }),
      ProviderRegistryConfigError
    );
  }
});

test("rejects surrounding credential whitespace without exposing values", () => {
  for (const [variableName, environment] of [
    ["APOLLO_API_KEY", { APOLLO_API_KEY: ` ${APOLLO_SECRET}` }],
    ["TAVILY_API_KEY", { TAVILY_API_KEY: ` ${TAVILY_SECRET}` }],
    ["EXA_API_KEY", { EXA_API_KEY: `${EXA_SECRET} ` }],
    ["HUNTER_API_KEY", { HUNTER_API_KEY: `${HUNTER_SECRET} ` }],
    ["PROSPEO_API_KEY", { PROSPEO_API_KEY: `${PROSPEO_SECRET} ` }],
  ] as const) {
    assert.throws(
      () => createConfiguredOfficialProviderRoutes(environment),
      (error: unknown) => {
        assert.equal(error instanceof ProviderRegistryConfigError, true);
        const serialized = JSON.stringify(
          error,
          Object.getOwnPropertyNames(error)
        );
        assert.equal(serialized.includes(variableName), true);
        assert.equal(serialized.includes(APOLLO_SECRET), false);
        assert.equal(serialized.includes(TAVILY_SECRET), false);
        assert.equal(serialized.includes(EXA_SECRET), false);
        assert.equal(serialized.includes(HUNTER_SECRET), false);
        assert.equal(serialized.includes(PROSPEO_SECRET), false);
        return true;
      }
    );
  }
});

test("validates configured credentials even when operator order omits them", () => {
  for (const environment of [
    {
      APOLLO_API_KEY: ` ${APOLLO_SECRET}`,
      KUROBARA_PROVIDER_ORDER: "tavily",
    },
    {
      EXA_API_KEY: ` ${EXA_SECRET}`,
      KUROBARA_PROVIDER_ORDER: "tavily",
    },
    {
      KUROBARA_PROVIDER_ORDER: "tavily",
      PROSPEO_API_KEY: ` ${PROSPEO_SECRET}`,
    },
  ]) {
    assert.throws(
      () => createConfiguredOfficialProviderRoutes(environment),
      ProviderRegistryConfigError
    );
  }
});

test("never retains credential values in descriptors or serialization", () => {
  const routes = createConfiguredOfficialProviderRoutes({
    APOLLO_API_KEY: APOLLO_SECRET,
    EXA_API_KEY: EXA_SECRET,
    HUNTER_API_KEY: HUNTER_SECRET,
    PROSPEO_API_KEY: PROSPEO_SECRET,
    TAVILY_API_KEY: TAVILY_SECRET,
  });
  const serialized = JSON.stringify(routes);

  assert.deepEqual(
    routes.map((route) => route.providerId),
    ["prospeo-person-search", "hunter-discover"]
  );
  assert.equal(serialized.includes(APOLLO_SECRET), false);
  assert.equal(serialized.includes(TAVILY_SECRET), false);
  assert.equal(serialized.includes(EXA_SECRET), false);
  assert.equal(serialized.includes(HUNTER_SECRET), false);
  assert.equal(serialized.includes(PROSPEO_SECRET), false);
  assert.equal(serialized.includes("APOLLO_API_KEY"), false);
  assert.equal(serialized.includes("TAVILY_API_KEY"), false);
  assert.equal(serialized.includes("EXA_API_KEY"), false);
  assert.equal(serialized.includes("HUNTER_API_KEY"), true);
  assert.equal(serialized.includes("PROSPEO_API_KEY"), true);
});

test("keeps PDL absent from active official routes even after BYOK attestation", () => {
  const routes = createConfiguredOfficialProviderRoutes({
    KUROBARA_PDL_DATA_RIGHTS_CONFIRMED: "true",
    PDL_API_KEY: PDL_SECRET,
  });

  assert.equal(
    routes.some((route) => route.routeKey === "pdl-contact-search"),
    false
  );
  assert.deepEqual(routes, []);
});

test("fails the isolated PDL route candidate closed without both controls", () => {
  assert.equal(
    createConfiguredPdlContactDiscoveryRouteCandidate({}),
    undefined
  );
  assert.equal(
    createConfiguredPdlContactDiscoveryRouteCandidate({
      PDL_API_KEY: PDL_SECRET,
    }),
    undefined
  );
  assert.equal(
    createConfiguredPdlContactDiscoveryRouteCandidate({
      KUROBARA_PDL_DATA_RIGHTS_CONFIRMED: "true",
    }),
    undefined
  );
  assert.equal(
    createConfiguredPdlContactDiscoveryRouteCandidate({
      KUROBARA_PDL_DATA_RIGHTS_CONFIRMED: "false",
      PDL_API_KEY: PDL_SECRET,
    }),
    undefined
  );
});

test("builds a non-secret PDL candidate only with key and exact rights attestation", () => {
  const candidate = createConfiguredPdlContactDiscoveryRouteCandidate({
    KUROBARA_PDL_DATA_RIGHTS_CONFIRMED: "true",
    PDL_API_KEY: PDL_SECRET,
  });

  assert.deepEqual(candidate, {
    capability: {
      capabilityId: "contacts.discover",
      capabilityVersion: "1.0.0",
    },
    credentialEnvironmentVariable: "PDL_API_KEY",
    effectAdapterKey: "pdl-contact-search",
    providerId: "pdl-contact-search",
    reservableUpperBound: 12,
    reservationUnit: "records",
    rightsAttestationEnvironmentVariable: "KUROBARA_PDL_DATA_RIGHTS_CONFIRMED",
    routeKey: "pdl-contact-search",
  });
  assert.equal(Object.isFrozen(candidate), true);
  assert.equal(JSON.stringify(candidate).includes(PDL_SECRET), false);
});

test("rejects ambiguous PDL rights attestations and whitespace-bearing keys", () => {
  for (const attestation of ["TRUE", "1", " true", "false "]) {
    assert.throws(
      () =>
        createConfiguredPdlContactDiscoveryRouteCandidate({
          KUROBARA_PDL_DATA_RIGHTS_CONFIRMED: attestation,
          PDL_API_KEY: PDL_SECRET,
        }),
      ProviderRegistryConfigError
    );
  }
  assert.throws(
    () =>
      createConfiguredPdlContactDiscoveryRouteCandidate({
        KUROBARA_PDL_DATA_RIGHTS_CONFIRMED: "true",
        PDL_API_KEY: ` ${PDL_SECRET}`,
      }),
    (error: unknown) => {
      assert.equal(error instanceof ProviderRegistryConfigError, true);
      const serialized = JSON.stringify(
        error,
        Object.getOwnPropertyNames(error)
      );
      assert.equal(serialized.includes(PDL_SECRET), false);
      return true;
    }
  );
});
