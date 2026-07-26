import assert from "node:assert/strict";
import test from "node:test";

import {
  datasetId,
  type InternalContactCandidate,
  idempotencyKey,
  instant,
  recordId,
  workspaceId,
} from "@kurobara/kernel";
import type {
  ContactIdentityPlanningPersistencePort,
  ContactIdentityProviderPort,
} from "@kurobara/ports";

import {
  makePlanContactIdentity,
  makeRevealSelectedContactIdentity,
} from "../src/contact-identity.ts";

const operation = {
  authorityEnvelopeId: "authority",
  budget: { limit: 1, unit: "requests" },
  contactDatasetId: datasetId("contacts"),
  contactRecordIds: [recordId("selected")],
  deadline: instant(2000),
  kind: "reveal" as const,
  operationId: "identity-1",
  state: "planned" as const,
  workspaceId: workspaceId("workspace"),
};

const contact = {
  candidate: {
    contactId: recordId("selected"),
    department: "sales",
    displayName: "Synthetic P.",
    identityCompleteness: "obfuscated" as const,
    jobTitle: "Director",
    observedAt: instant(900),
    organizationDomain: "synthetic.example",
    organizationId: "company-1",
    organizationName: "Synthetic Company",
    personCountryCode: "ES",
    profileUrl: null,
    seniority: "director" as const,
  },
  providerIdentity: {
    providerKey: "apollo-people-search",
    providerSubjectId: "subject-1",
  },
};

const privacy = {
  facts: {
    activeRestrictions: [],
    purposeRef: "sales-research",
    territory: "ES",
  },
  policy: {
    expiresAt: instant(3000),
    purposeRefs: ["sales-research"],
    rules: {
      "contact-identity": {
        allowedActions: ["enrich" as const],
        maxRetentionMilliseconds: 1000,
      },
      "professional-social-profile": {
        allowedActions: ["enrich" as const],
        maxRetentionMilliseconds: 1000,
      },
    },
    territories: ["ES"],
    version: "test",
  },
};

const allowedDecision = {
  allowed: true,
  deniedDataClasses: [],
  policyVersion: "test",
  reasonCodes: ["allowed" as const],
  retentionLimits: [],
  stopExternalEffects: false,
  stopFallback: false,
};

test("plans one immutable identity selection and replays it", async () => {
  const seen = new Map<
    string,
    Parameters<ContactIdentityPlanningPersistencePort["plan"]>[1]
  >();
  const persistence: ContactIdentityPlanningPersistencePort = {
    plan: (_scope, planned) => {
      const existing = seen.get(planned.operationId);
      if (existing !== undefined) {
        return Promise.resolve({
          operation: existing,
          replayed: true,
          status: "accepted",
        });
      }
      seen.set(planned.operationId, planned);
      return Promise.resolve({
        operation: planned,
        replayed: false,
        status: "accepted",
      });
    },
  };
  const plan = makePlanContactIdentity({
    now: () => Promise.resolve(instant(1000)),
    persistence,
  });
  const request = {
    actorPermissions: ["contacts:enrich"],
    authorityEnvelopeId: "authority",
    budget: { limit: 1, unit: "requests" },
    contactDatasetId: datasetId("contacts"),
    contactRecordIds: [recordId("selected")],
    deadline: instant(2000),
    operationId: idempotencyKey("identity-1"),
    workspaceId: workspaceId("workspace"),
  };

  const first = await plan(request);
  assert.equal(first.ok && first.value.replayed, false);
  const persisted = seen.get(request.operationId);
  assert.ok(persisted);
  seen.set(request.operationId, { ...persisted, state: "completed" });
  const replay = await plan(request);
  assert.equal(replay.ok && replay.value.replayed, true);
  assert.equal(replay.ok && replay.value.operation.state, "completed");

  const collision = await plan({
    ...request,
    budget: { limit: 2, unit: "requests" },
  });
  assert.equal(collision.ok, false);
  if (!collision.ok) {
    assert.equal(collision.error.code, "idempotency-key-reused");
  }
});

test("fails closed when the source returns another selected contact", async () => {
  let authorizationCalls = 0;
  let providerCalls = 0;
  const reveal = makeRevealSelectedContactIdentity({
    authorizeContactEffect: () => {
      authorizationCalls += 1;
      return Promise.resolve({
        ok: true,
        value: { decision: allowedDecision, matchedTombstoneIds: [] },
      });
    },
    now: () => Promise.resolve(instant(1000)),
    provider: {
      quote: () =>
        Promise.resolve({ guarantee: "hard", unit: "requests", upperBound: 1 }),
      reveal: () => {
        providerCalls += 1;
        throw new Error("Provider reveal must not run for another contact.");
      },
    },
    source: {
      load: () =>
        Promise.resolve({
          ...contact,
          candidate: {
            ...contact.candidate,
            contactId: recordId("another-contact"),
          },
        }),
    },
  });

  const result = await reveal({
    contactRecordId: recordId("selected"),
    operation,
    privacy,
  });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, "contact-selection-invalid");
  }
  assert.equal(authorizationCalls, 0);
  assert.equal(providerCalls, 0);
});

test("pins identity-only privacy facts immediately before the provider", async () => {
  let providerCalls = 0;
  const provider: ContactIdentityProviderPort = {
    quote: () =>
      Promise.resolve({ guarantee: "hard", unit: "requests", upperBound: 1 }),
    reveal: (request) => {
      providerCalls += 1;
      assert.deepEqual(request, {
        deadline: instant(2000),
        operationId: "identity-1",
        providerIdentity: contact.providerIdentity,
      });
      return Promise.resolve({
        usage: { amount: 1, basis: "exact", unit: "requests" },
        value: {
          displayName: "Synthetic Person",
          firstName: "Synthetic",
          identityCompleteness: "full",
          lastName: "Person",
          observedAt: instant(1100),
          profileUrl: "https://www.linkedin.com/in/synthetic-person",
        },
      });
    },
  };
  const reveal = makeRevealSelectedContactIdentity({
    authorizeContactEffect: (request) => {
      assert.deepEqual(request.facts, {
        action: "enrich",
        activeRestrictions: [],
        explicitlyEnabledDataClasses: [],
        purposeRef: "sales-research",
        requestedData: [
          { dataClass: "contact-identity" },
          { dataClass: "professional-social-profile" },
        ],
        territory: "ES",
      });
      assert.deepEqual(request.subject, {
        kind: "provider-subject",
        providerKey: "apollo-people-search",
        value: "subject-1",
      });
      return Promise.resolve({
        ok: true,
        value: { decision: allowedDecision, matchedTombstoneIds: [] },
      });
    },
    now: () => Promise.resolve(instant(1000)),
    provider,
    source: {
      load: (scope, contactDatasetId, contactRecordId) => {
        assert.deepEqual(scope, { workspaceId: workspaceId("workspace") });
        assert.equal(contactDatasetId, datasetId("contacts"));
        assert.equal(contactRecordId, recordId("selected"));
        return Promise.resolve(contact);
      },
    },
  });

  const result = await reveal({
    contactRecordId: recordId("selected"),
    operation,
    privacy,
  });
  assert.equal(result.ok, true);
  if (!result.ok || result.value.value === undefined) {
    assert.fail("Expected one revealed identity.");
  }
  assert.equal(result.value.value.candidate.displayName, "Synthetic Person");
  assert.equal(result.value.value.candidate.identityCompleteness, "full");
  assert.equal(result.value.value.candidate.jobTitle, "Director");
  assert.equal(result.value.value.candidate.observedAt, instant(900));
  assert.equal(result.value.value.identity.observedAt, instant(1100));
  assert.equal(providerCalls, 1);
});

test("blocks non-selected, already-full, expired, and privacy-denied effects", async () => {
  let authorizationCalls = 0;
  let clockCalls = 0;
  let loadedContact: InternalContactCandidate = contact;
  let providerCalls = 0;
  const dependencies = {
    authorizeContactEffect: () => {
      authorizationCalls += 1;
      return Promise.resolve({
        ok: true as const,
        value: {
          decision: { ...allowedDecision, allowed: false },
          matchedTombstoneIds: [],
        },
      });
    },
    now: () => {
      clockCalls += 1;
      return Promise.resolve(instant(1000));
    },
    provider: {
      quote: () =>
        Promise.resolve({
          guarantee: "hard" as const,
          unit: "requests",
          upperBound: 1,
        }),
      reveal: () => {
        providerCalls += 1;
        return Promise.resolve({
          usage: { amount: 0, basis: "exact" as const, unit: "requests" },
          value: undefined,
        });
      },
    },
    source: {
      load: () => Promise.resolve(loadedContact),
    },
  };
  const reveal = makeRevealSelectedContactIdentity(dependencies);

  const notSelected = await reveal({
    contactRecordId: recordId("other"),
    operation,
    privacy,
  });
  assert.equal(notSelected.ok, false);
  assert.equal(clockCalls, 0);

  loadedContact = {
    ...contact,
    candidate: {
      ...contact.candidate,
      displayName: "Synthetic Person",
      identityCompleteness: "full",
    },
  };
  const alreadyFull = await reveal({
    contactRecordId: recordId("selected"),
    operation,
    privacy,
  });
  assert.equal(alreadyFull.ok, false);

  loadedContact = contact;
  const expired = await reveal({
    contactRecordId: recordId("selected"),
    operation: { ...operation, deadline: instant(1000) },
    privacy,
  });
  assert.equal(expired.ok, false);
  assert.equal(authorizationCalls, 0);
  assert.equal(providerCalls, 0);

  const denied = await reveal({
    contactRecordId: recordId("selected"),
    operation,
    privacy,
  });
  assert.equal(denied.ok, false);
  assert.equal(authorizationCalls, 1);
  assert.equal(providerCalls, 0);
});

test("fails closed on hostile provider output and incoherent usage", async () => {
  const revealWith = (provider: ContactIdentityProviderPort) =>
    makeRevealSelectedContactIdentity({
      authorizeContactEffect: () =>
        Promise.resolve({
          ok: true,
          value: { decision: allowedDecision, matchedTombstoneIds: [] },
        }),
      now: () => Promise.resolve(instant(1000)),
      provider,
      source: {
        load: () => Promise.resolve(contact),
      },
    });
  const hostile = await revealWith({
    quote: () =>
      Promise.resolve({ guarantee: "hard", unit: "requests", upperBound: 1 }),
    reveal: () =>
      Promise.resolve({
        usage: { amount: 1, basis: "exact", unit: "requests" },
        value: {
          displayName: "Synthetic Person",
          email: "forbidden@example.invalid",
          firstName: "Synthetic",
          identityCompleteness: "full",
          lastName: "Person",
          observedAt: instant(1100),
          profileUrl: null,
        } as never,
      }),
  })({ contactRecordId: recordId("selected"), operation, privacy });
  assert.equal(hostile.ok, false);
  if (!hostile.ok) {
    assert.equal(hostile.error.code, "contact-provider-output-invalid");
  }

  const overBudget = await revealWith({
    quote: () =>
      Promise.resolve({ guarantee: "hard", unit: "requests", upperBound: 1 }),
    reveal: () =>
      Promise.resolve({
        usage: { amount: 2, basis: "exact", unit: "requests" },
        value: undefined,
      }),
  })({ contactRecordId: recordId("selected"), operation, privacy });
  assert.equal(overBudget.ok, false);
  if (!overBudget.ok) {
    assert.equal(overBudget.error.code, "contact-provider-usage-invalid");
  }
});

test("rejects an invalid hard quote before provider I/O", async () => {
  let providerCalls = 0;
  const reveal = makeRevealSelectedContactIdentity({
    authorizeContactEffect: () =>
      Promise.resolve({
        ok: true,
        value: { decision: allowedDecision, matchedTombstoneIds: [] },
      }),
    now: () => Promise.resolve(instant(1000)),
    provider: {
      quote: () =>
        Promise.resolve({
          guarantee: "hard",
          unit: "requests",
          upperBound: 2,
        }),
      reveal: () => {
        providerCalls += 1;
        throw new Error("Provider reveal must not run after an invalid quote.");
      },
    },
    source: { load: () => Promise.resolve(contact) },
  });

  const result = await reveal({
    contactRecordId: recordId("selected"),
    operation,
    privacy,
  });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, "contact-provider-quote-invalid");
  }
  assert.equal(providerCalls, 0);
});

test("rechecks the deadline after privacy and quote before provider I/O", async () => {
  let clockCalls = 0;
  let providerCalls = 0;
  const reveal = makeRevealSelectedContactIdentity({
    authorizeContactEffect: () =>
      Promise.resolve({
        ok: true,
        value: { decision: allowedDecision, matchedTombstoneIds: [] },
      }),
    now: () => {
      clockCalls += 1;
      return Promise.resolve(instant(clockCalls === 1 ? 1000 : 2000));
    },
    provider: {
      quote: () =>
        Promise.resolve({ guarantee: "hard", unit: "requests", upperBound: 1 }),
      reveal: () => {
        providerCalls += 1;
        throw new Error("Provider reveal must not run after the deadline.");
      },
    },
    source: { load: () => Promise.resolve(contact) },
  });

  const result = await reveal({
    contactRecordId: recordId("selected"),
    operation,
    privacy,
  });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, "deadline-elapsed");
  }
  assert.equal(providerCalls, 0);
});

test("rechecks privacy after quote before provider I/O", async () => {
  let authorizationCalls = 0;
  let providerCalls = 0;
  const reveal = makeRevealSelectedContactIdentity({
    authorizeContactEffect: () => {
      authorizationCalls += 1;
      return Promise.resolve({
        ok: true,
        value: {
          decision:
            authorizationCalls === 1
              ? allowedDecision
              : { ...allowedDecision, allowed: false },
          matchedTombstoneIds: [],
        },
      });
    },
    now: () => Promise.resolve(instant(1000)),
    provider: {
      quote: () =>
        Promise.resolve({ guarantee: "hard", unit: "requests", upperBound: 1 }),
      reveal: () => {
        providerCalls += 1;
        throw new Error("Provider reveal must not run after privacy changes.");
      },
    },
    source: { load: () => Promise.resolve(contact) },
  });

  const result = await reveal({
    contactRecordId: recordId("selected"),
    operation,
    privacy,
  });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, "contact-privacy-restricted");
  }
  assert.equal(authorizationCalls, 2);
  assert.equal(providerCalls, 0);
});

test("reconstructs provider usage without incidental fields", async () => {
  const reveal = makeRevealSelectedContactIdentity({
    authorizeContactEffect: () =>
      Promise.resolve({
        ok: true,
        value: { decision: allowedDecision, matchedTombstoneIds: [] },
      }),
    now: () => Promise.resolve(instant(1000)),
    provider: {
      quote: () =>
        Promise.resolve({ guarantee: "hard", unit: "requests", upperBound: 1 }),
      reveal: () =>
        Promise.resolve({
          usage: {
            amount: 1,
            basis: "exact",
            email: "forbidden@example.invalid",
            unit: "requests",
          } as never,
          value: undefined,
        }),
    },
    source: { load: () => Promise.resolve(contact) },
  });

  const result = await reveal({
    contactRecordId: recordId("selected"),
    operation,
    privacy,
  });
  assert.deepEqual(result, {
    ok: true,
    value: {
      usage: { amount: 1, basis: "exact", unit: "requests" },
      value: undefined,
    },
  });
  assert.equal(JSON.stringify(result).includes("forbidden"), false);
});
