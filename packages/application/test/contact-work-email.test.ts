import assert from "node:assert/strict";
import test from "node:test";

import {
  datasetId,
  idempotencyKey,
  instant,
  recordId,
  workspaceId,
} from "@kurobara/kernel";
import type {
  ContactWorkEmailPlanningPersistencePort,
  ContactWorkEmailProviderPort,
} from "@kurobara/ports";

import {
  makePlanContactWorkEmail,
  makeResolveSelectedContactWorkEmail,
} from "../src/contact-work-email.ts";

test("plans one immutable explicit selection and replays it", async () => {
  const seen = new Map<
    string,
    Parameters<ContactWorkEmailPlanningPersistencePort["plan"]>[1]
  >();
  const persistence: ContactWorkEmailPlanningPersistencePort = {
    plan: (_scope, operation) => {
      const existing = seen.get(operation.operationId);
      if (existing !== undefined) {
        return Promise.resolve({
          operation: existing,
          replayed: true,
          status: "accepted",
        });
      }
      seen.set(operation.operationId, operation);
      return Promise.resolve({
        operation,
        replayed: false,
        status: "accepted",
      });
    },
  };
  const plan = makePlanContactWorkEmail({
    now: () => Promise.resolve(instant(1000)),
    persistence,
  });
  const request = {
    actorPermissions: ["contacts:enrich"],
    authorityEnvelopeId: "authority",
    budget: { limit: 3, unit: "credits" },
    contactDatasetId: datasetId("contacts"),
    contactRecordIds: [recordId("contact-1")],
    deadline: instant(2000),
    kind: "resolve" as const,
    operationId: idempotencyKey("resolve-1"),
    workspaceId: workspaceId("workspace"),
  };
  assert.equal((await plan(request)).ok, true);
  const replay = await plan(request);
  assert.equal(replay.ok && replay.value.replayed, true);
});

test("checks exact selection and privacy immediately before the provider", async () => {
  let providerCalls = 0;
  const provider: ContactWorkEmailProviderPort = {
    resolve: () => {
      providerCalls += 1;
      return Promise.resolve({
        usage: { amount: 1, basis: "exact", unit: "credits" },
        value: undefined,
      });
    },
    verify: () =>
      Promise.resolve({
        usage: { amount: 1, basis: "exact", unit: "credits" },
        value: { observedAt: instant(1000), status: "valid" },
      }),
  };
  const execute = makeResolveSelectedContactWorkEmail({
    authorizeContactEffect: async () => ({
      ok: true,
      value: {
        decision: {
          allowed: true,
          deniedDataClasses: [],
          policyVersion: "test",
          reasonCodes: ["allowed"],
          retentionLimits: [],
          stopExternalEffects: false,
          stopFallback: false,
        },
        matchedTombstoneIds: [],
      },
    }),
    provider,
  });
  const operation = {
    budget: { limit: 1, unit: "credits" },
    contactDatasetId: datasetId("contacts"),
    contactRecordIds: [recordId("selected")],
    deadline: instant(2000),
    kind: "resolve" as const,
    operationId: "resolve-1",
    state: "planned" as const,
    workspaceId: workspaceId("workspace"),
  };
  const result = await execute({
    contact: {
      candidate: {
        contactId: recordId("not-selected"),
        department: null,
        displayName: "Synthetic Contact",
        identityCompleteness: "full",
        jobTitle: "Director",
        observedAt: instant(1000),
        organizationDomain: "synthetic.example",
        organizationId: "company-1",
        organizationName: "Synthetic Company",
        personCountryCode: null,
        profileUrl: null,
        seniority: "director",
      },
      providerIdentity: {
        providerKey: "fixture",
        providerSubjectId: "subject-1",
      },
    },
    operation,
    privacy: {} as never,
  });
  assert.equal(result.ok, false);
  assert.equal(providerCalls, 0);
});

test("rejects an obfuscated identity before privacy authorization or provider I/O", async () => {
  let authorizationCalls = 0;
  let providerCalls = 0;
  const execute = makeResolveSelectedContactWorkEmail({
    authorizeContactEffect: () => {
      authorizationCalls += 1;
      throw new Error("Authorization must not run for an incomplete identity.");
    },
    provider: {
      resolve: () => {
        providerCalls += 1;
        throw new Error(
          "Provider I/O must not run for an incomplete identity."
        );
      },
      verify: () => {
        throw new Error("Unexpected verification call.");
      },
    },
  });
  const result = await execute({
    contact: {
      candidate: {
        contactId: recordId("selected"),
        department: null,
        displayName: "Synthetic C.",
        identityCompleteness: "obfuscated",
        jobTitle: "Director",
        observedAt: instant(1000),
        organizationDomain: "synthetic.example",
        organizationId: "company-1",
        organizationName: "Synthetic Company",
        personCountryCode: null,
        profileUrl: null,
        seniority: "director",
      },
      providerIdentity: {
        providerKey: "apollo-people-search",
        providerSubjectId: "subject-1",
      },
    },
    operation: {
      budget: { limit: 1, unit: "credits" },
      contactDatasetId: datasetId("contacts"),
      contactRecordIds: [recordId("selected")],
      deadline: instant(2000),
      kind: "resolve",
      operationId: "resolve-2",
      state: "planned",
      workspaceId: workspaceId("workspace"),
    },
    privacy: {} as never,
  });

  assert.deepEqual(result, {
    error: {
      code: "contact-identity-insufficient",
      message: "Work-email resolution requires a complete contact identity.",
    },
    ok: false,
  });
  assert.equal(authorizationCalls, 0);
  assert.equal(providerCalls, 0);
});
