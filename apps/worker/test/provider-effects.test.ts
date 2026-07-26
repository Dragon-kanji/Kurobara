import assert from "node:assert/strict";
import test from "node:test";

import {
  createContactPrivacyTombstoneGuard,
  createHmacContactPrivacySubjectKeyDeriver,
} from "@kurobara/application";

import { datasetGenerationPageInputContract } from "../src/configured-provider-output.ts";
import {
  authorizeSelectedContactEffect,
  createConfiguredLeafEffectRuntime,
  WorkerProviderConfigurationError,
} from "../src/provider-effects.ts";
import { recipeCellOutputContract } from "../src/recipe-cell-output.ts";

type ContactPrivacyGuardDependencies = Parameters<
  typeof createContactPrivacyTombstoneGuard
>[0];
type ContactPrivacyPersistencePort =
  ContactPrivacyGuardDependencies["persistence"];
type ContactPrivacySubjectKey = Parameters<
  ContactPrivacyPersistencePort["findBySubjectKeys"]
>[1][number];
type ContactPrivacyTombstone = Awaited<
  ReturnType<ContactPrivacyPersistencePort["findBySubjectKeys"]>
>[number];
type LeafEffectRequest = Parameters<typeof authorizeSelectedContactEffect>[0];
type NormalizedJsonValue = NonNullable<LeafEffectRequest["runInput"]>["value"];

const hash = (character: string) => `sha256:${character.repeat(64)}`;
const PRIVACY_SECRET = "synthetic-contact-privacy-secret-32-bytes";

const selectedContact = (
  suffix: string,
  includeEmail = false,
  providerKey:
    | "apollo-people-search"
    | "prospeo-person-search" = "apollo-people-search"
): Readonly<Record<string, NormalizedJsonValue>> => ({
  provider_identity: {
    provider_key: providerKey,
    provider_subject_id: `${providerKey === "prospeo-person-search" ? "prospeo" : "apollo"}_subject_${suffix}`,
  },
  source_record_id: `contact-${suffix}`,
  ...(includeEmail
    ? {
        work_email: {
          email: `synthetic-${suffix}@example.invalid`,
        },
      }
    : {}),
});

type SelectedProviderId = Parameters<typeof authorizeSelectedContactEffect>[1];

const capabilityFor = (providerId: SelectedProviderId): string => {
  if (
    providerId === "apollo-people-enrichment" ||
    providerId === "prospeo-person-enrichment"
  ) {
    return "contacts.identity.reveal";
  }
  if (
    providerId === "hunter-email-finder" ||
    providerId === "hunter-email-finder-prospeo" ||
    providerId === "prospeo-email-enrichment"
  ) {
    return "contacts.work-email.resolve";
  }
  return "contacts.work-email.verify";
};

const pageValue = (
  providerId: SelectedProviderId,
  selection: readonly Readonly<Record<string, NormalizedJsonValue>>[],
  pageSequence = 1,
  overrides: Readonly<Record<string, NormalizedJsonValue>> = {}
): NormalizedJsonValue => {
  return {
    capability: {
      capabilityId: capabilityFor(providerId),
      capabilityVersion: "1.0.0",
    },
    inputCursor: pageSequence === 1 ? null : `contact:${pageSequence - 1}`,
    normalizedQuery: {
      ...(providerId === "apollo-people-enrichment" ||
      providerId === "prospeo-person-enrichment"
        ? { result_kind: "contact_identity" }
        : {
            operation_kind:
              providerId === "hunter-email-finder" ||
              providerId === "hunter-email-finder-prospeo" ||
              providerId === "prospeo-email-enrichment"
                ? "resolve"
                : "verify",
            result_kind: "contact_work_email",
          }),
      selected_contacts: selection,
    },
    pageSequence,
    workspaceId: "workspace-worker-test",
    ...overrides,
  };
};

const requestFor = (value: NormalizedJsonValue): LeafEffectRequest =>
  ({
    attemptId: "attempt-worker-privacy",
    operationKey: "operation-worker-privacy",
    reservationUnit: "requests",
    reservedAmount: 1,
    routeSnapshotHash: hash("a"),
    routingDecisionId: "routing-worker-privacy",
    runId: "run-worker-privacy",
    runInput: {
      classification: "internal",
      contentHash: hash("b"),
      contract: datasetGenerationPageInputContract,
      finalizedAt: 1000,
      inputId: "input-worker-privacy",
      mediaType: "application/json",
      sizeBytes: 128,
      validatedAt: 1000,
      validatorVersion: "worker-privacy-test",
      value,
    },
    stepRunId: "step-worker-privacy",
    workspaceId: "workspace-worker-test",
  }) as LeafEffectRequest;

const privacyGuard = (
  find: (
    keys: readonly ContactPrivacySubjectKey[]
  ) => Promise<readonly ContactPrivacyTombstone[]>
) => {
  const persistence: ContactPrivacyPersistencePort = {
    findBySubjectKeys: (_scope, keys) => find(keys),
    register: () => Promise.resolve({ status: "idempotency-conflict" }),
  };
  return createContactPrivacyTombstoneGuard({
    persistence,
    subjectKeys: createHmacContactPrivacySubjectKeyDeriver([
      {
        current: true,
        keyMaterial: new TextEncoder().encode(PRIVACY_SECRET),
        version: "v1",
      },
    ]),
  });
};

test("keeps the deterministic local profile available", async () => {
  const runtime = await createConfiguredLeafEffectRuntime({
    adapterMode: "deterministic-local",
    environment: {},
  });

  assert.deepEqual(
    runtime.effects.map((effect) => effect.adapterKey),
    ["deterministic-local"]
  );
  assert.equal(
    (
      await runtime.outputValidator.validate({
        contract: recipeCellOutputContract,
        value: { value: "https://fixture.invalid/record-worker-test" },
      })
    ).status,
    "accepted"
  );
});

test("allows one selected identity effect and rechecks privacy on every execute", async () => {
  const expectedSubjectKeys = await createHmacContactPrivacySubjectKeyDeriver([
    {
      current: true,
      keyMaterial: new TextEncoder().encode(PRIVACY_SECRET),
      version: "v1",
    },
  ]).derive({
    kind: "provider-subject",
    providerKey: "apollo-people-search",
    value: "apollo_subject_second",
  });
  let privacyChecks = 0;
  const privacy = privacyGuard((keys) => {
    privacyChecks += 1;
    assert.equal(keys.length, 1);
    assert.equal(keys[0]?.identityKind, "provider-subject");
    assert.equal(keys[0]?.providerKey, "apollo-people-search");
    assert.equal(keys[0]?.digest, expectedSubjectKeys.current.digest);
    return Promise.resolve([]);
  });
  const selection = [selectedContact("first"), selectedContact("second")];
  const request = requestFor(
    pageValue("apollo-people-enrichment", selection, 2)
  );

  assert.equal(
    await authorizeSelectedContactEffect(
      request,
      "apollo-people-enrichment",
      privacy
    ),
    undefined
  );
  assert.equal(
    await authorizeSelectedContactEffect(
      request,
      "apollo-people-enrichment",
      privacy
    ),
    undefined
  );
  assert.equal(privacyChecks, 2);
});

test("denies a tombstoned work-email resolution at JIT authorization", async () => {
  const request = requestFor(
    pageValue("hunter-email-finder", [selectedContact("resolve")])
  );

  assert.deepEqual(
    await authorizeSelectedContactEffect(
      request,
      "hunter-email-finder",
      privacyGuard(() => Promise.resolve([{} as ContactPrivacyTombstone]))
    ),
    {
      reason: "contact-privacy-denied",
      retryable: false,
      settlement: { kind: "release" },
      status: "failed",
    }
  );
});

test("authorizes Prospeo selected effects only for the Prospeo namespace", async () => {
  const privacy = privacyGuard(() => Promise.resolve([]));
  const selected = selectedContact("selected", false, "prospeo-person-search");

  assert.equal(
    await authorizeSelectedContactEffect(
      requestFor(pageValue("prospeo-person-enrichment", [selected])),
      "prospeo-person-enrichment",
      privacy
    ),
    undefined
  );
  assert.equal(
    await authorizeSelectedContactEffect(
      requestFor(pageValue("prospeo-email-enrichment", [selected])),
      "prospeo-email-enrichment",
      privacy
    ),
    undefined
  );
  assert.equal(
    await authorizeSelectedContactEffect(
      requestFor(pageValue("hunter-email-finder-prospeo", [selected])),
      "hunter-email-finder-prospeo",
      privacy
    ),
    undefined
  );
  assert.deepEqual(
    await authorizeSelectedContactEffect(
      requestFor(
        pageValue("prospeo-person-enrichment", [selectedContact("wrong")])
      ),
      "prospeo-person-enrichment",
      privacy
    ),
    {
      reason: "contact-privacy-input-invalid",
      retryable: false,
      settlement: { kind: "release" },
      status: "failed",
    }
  );
});

test("rejects malformed selected-contact cursors before privacy or provider calls", async () => {
  let privacyChecks = 0;
  const privacy = privacyGuard(() => {
    privacyChecks += 1;
    return Promise.resolve([]);
  });
  const malformed = pageValue(
    "apollo-people-enrichment",
    [selectedContact("first"), selectedContact("second")],
    2,
    { inputCursor: "contact:2" }
  );

  assert.deepEqual(
    await authorizeSelectedContactEffect(
      requestFor(malformed),
      "apollo-people-enrichment",
      privacy
    ),
    {
      reason: "contact-privacy-input-invalid",
      retryable: false,
      settlement: { kind: "release" },
      status: "failed",
    }
  );
  assert.equal(privacyChecks, 0);
});

test("checks both provider subject and email before verification", async () => {
  let checkedKinds: readonly string[] = [];
  const privacy = privacyGuard((keys) => {
    checkedKinds = keys.map((key) => key.identityKind).sort();
    return Promise.resolve([]);
  });
  const request = requestFor(
    pageValue("hunter-email-verifier", [selectedContact("verify", true)])
  );

  assert.equal(
    await authorizeSelectedContactEffect(
      request,
      "hunter-email-verifier",
      privacy
    ),
    undefined
  );
  assert.deepEqual(checkedKinds, ["email", "provider-subject"]);
});

test("checks Prospeo lineage before Hunter verification", async () => {
  let checkedProvider: string | undefined;
  const privacy = privacyGuard((keys) => {
    checkedProvider = keys.find(
      (key) => key.identityKind === "provider-subject"
    )?.providerKey;
    return Promise.resolve([]);
  });
  const request = requestFor(
    pageValue("hunter-email-verifier-prospeo", [
      selectedContact("verify-prospeo", true, "prospeo-person-search"),
    ])
  );

  assert.equal(
    await authorizeSelectedContactEffect(
      request,
      "hunter-email-verifier-prospeo",
      privacy
    ),
    undefined
  );
  assert.equal(checkedProvider, "prospeo-person-search");
});

test("composes configured providers in explicit order without exposing keys", async () => {
  const environment = {
    EXA_API_KEY: "synthetic-exa-key",
    KUROBARA_EXA_DATA_RIGHTS_CONFIRMED: "true",
    KUROBARA_PROVIDER_ORDER: "exa,tavily",
    TAVILY_API_KEY: "synthetic-tavily-key",
  };
  const runtime = await createConfiguredLeafEffectRuntime({
    adapterMode: "configured-providers",
    environment,
    now: () => 1000,
  });

  assert.deepEqual(
    runtime.effects.map((effect) => effect.adapterKey),
    ["exa-search", "tavily-search"]
  );
  const serialized = JSON.stringify(runtime);
  assert.equal(serialized.includes(environment.EXA_API_KEY), false);
  assert.equal(serialized.includes(environment.TAVILY_API_KEY), false);
});

test("composes Hunter company discovery only when its owner key is configured", async () => {
  const environment = {
    HUNTER_API_KEY: "synthetic-hunter-key",
    KUROBARA_PROVIDER_ORDER: "hunter",
  };
  const runtime = await createConfiguredLeafEffectRuntime({
    adapterMode: "configured-providers",
    environment,
    now: () => 1000,
  });

  assert.deepEqual(
    runtime.effects.map((effect) => effect.adapterKey),
    ["hunter-discover"]
  );
  assert.equal(
    JSON.stringify(runtime).includes(environment.HUNTER_API_KEY),
    false
  );
});

test("composes Apollo contact discovery only when its owner key is configured", async () => {
  const environment = {
    APOLLO_API_KEY: "synthetic-apollo-key",
    KUROBARA_PROVIDER_ORDER: "apollo",
  };
  const runtime = await createConfiguredLeafEffectRuntime({
    adapterMode: "configured-providers",
    environment,
    now: () => 1000,
  });

  assert.deepEqual(
    runtime.effects.map((effect) => effect.adapterKey),
    ["apollo-people-search"]
  );
  assert.equal(
    JSON.stringify(runtime).includes(environment.APOLLO_API_KEY),
    false
  );
});

test("composes Prospeo as the default contact discovery owner", async () => {
  const environment = {
    PROSPEO_API_KEY: "synthetic-prospeo-key",
  };
  const runtime = await createConfiguredLeafEffectRuntime({
    adapterMode: "configured-providers",
    environment,
    now: () => 1000,
  });

  assert.deepEqual(
    runtime.effects.map((effect) => effect.adapterKey),
    ["prospeo-person-search"]
  );
  assert.equal(
    JSON.stringify(runtime).includes(environment.PROSPEO_API_KEY),
    false
  );
});

test("composes Prospeo selected identity and email routes with privacy", async () => {
  const persistence: ContactPrivacyPersistencePort = {
    findBySubjectKeys: () => Promise.resolve([]),
    register: () => Promise.resolve({ status: "idempotency-conflict" }),
  };
  const runtime = await createConfiguredLeafEffectRuntime({
    adapterMode: "configured-providers",
    contactPrivacy: persistence,
    environment: {
      KUROBARA_CONTACT_PRIVACY_HMAC_SECRET: PRIVACY_SECRET,
      PROSPEO_API_KEY: "synthetic-prospeo-key",
    },
    now: () => 1000,
  });

  assert.deepEqual(
    runtime.effects.map((effect) => effect.adapterKey),
    [
      "prospeo-person-search",
      "prospeo-person-enrichment",
      "prospeo-email-enrichment",
    ]
  );
});

test("does not compose selected-contact routes without the privacy secret", async () => {
  const runtime = await createConfiguredLeafEffectRuntime({
    adapterMode: "configured-providers",
    environment: {
      APOLLO_API_KEY: "synthetic-apollo-key",
      HUNTER_API_KEY: "synthetic-hunter-key",
      KUROBARA_PROVIDER_ORDER: "apollo,hunter",
    },
    now: () => 1000,
  });

  assert.deepEqual(
    runtime.effects.map((effect) => effect.adapterKey),
    ["apollo-people-search", "hunter-discover"]
  );
});

test("composes all selected-contact routes with privacy persistence", async () => {
  const persistence: ContactPrivacyPersistencePort = {
    findBySubjectKeys: () => Promise.resolve([]),
    register: () => Promise.resolve({ status: "idempotency-conflict" }),
  };
  const runtime = await createConfiguredLeafEffectRuntime({
    adapterMode: "configured-providers",
    contactPrivacy: persistence,
    environment: {
      APOLLO_API_KEY: "synthetic-apollo-key",
      HUNTER_API_KEY: "synthetic-hunter-key",
      KUROBARA_CONTACT_PRIVACY_HMAC_SECRET: PRIVACY_SECRET,
      KUROBARA_PROVIDER_ORDER: "apollo,hunter",
    },
    now: () => 1000,
  });

  assert.deepEqual(
    runtime.effects.map((effect) => effect.adapterKey),
    [
      "apollo-people-search",
      "hunter-discover",
      "apollo-people-enrichment",
      "hunter-email-finder",
      "hunter-email-verifier",
    ]
  );
  assert.equal(JSON.stringify(runtime).includes(PRIVACY_SECRET), false);
});

test("composes the Prospeo vertical with Hunter alternative resolution and verification", async () => {
  const persistence: ContactPrivacyPersistencePort = {
    findBySubjectKeys: () => Promise.resolve([]),
    register: () => Promise.resolve({ status: "idempotency-conflict" }),
  };
  const runtime = await createConfiguredLeafEffectRuntime({
    adapterMode: "configured-providers",
    contactPrivacy: persistence,
    environment: {
      HUNTER_API_KEY: "synthetic-hunter-key",
      KUROBARA_CONTACT_PRIVACY_HMAC_SECRET: PRIVACY_SECRET,
      PROSPEO_API_KEY: "synthetic-prospeo-key",
    },
    now: () => 1000,
  });

  assert.deepEqual(
    runtime.effects.map((effect) => effect.adapterKey),
    [
      "prospeo-person-search",
      "hunter-discover",
      "prospeo-person-enrichment",
      "prospeo-email-enrichment",
      "hunter-email-finder-prospeo",
      "hunter-email-verifier-prospeo",
    ]
  );
});

test("fails closed when the configured provider profile has no credential", async () => {
  await assert.rejects(
    createConfiguredLeafEffectRuntime({
      adapterMode: "configured-providers",
      environment: {},
    }),
    WorkerProviderConfigurationError
  );
});
