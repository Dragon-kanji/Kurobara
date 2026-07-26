import assert from "node:assert/strict";
import test from "node:test";

import {
  datasetId,
  fieldId,
  instant,
  recordId,
  workspaceId,
} from "@kurobara/kernel";

import {
  createDeterministicContactDiscoveryProvider,
  createDeterministicContactIdentityProvider,
  createDeterministicContactWorkEmailProvider,
} from "../src/index.ts";

test("creates a bounded contact shortlist without incidental contact details", async () => {
  const provider = createDeterministicContactDiscoveryProvider({
    now: () => 1000,
  });
  const page = await provider.discoverPage({
    companyHeadquartersCountryCodes: ["ES"],
    companyRecords: [
      {
        datasetId: datasetId("companies"),
        recordId: recordId("company-1"),
        values: [
          { fieldId: fieldId("company_name"), value: "Synthetic Company" },
          { fieldId: fieldId("company_domain"), value: "synthetic.example" },
        ],
        workspaceId: workspaceId("workspace"),
      },
    ],
    departments: ["sales"],
    inputCursor: null,
    maxContactsPerCompany: 2,
    maxContactsTotal: 12,
    personCountryCodes: ["ES"],
    seniorities: ["director"],
    titles: ["Sales Director"],
  });
  assert.equal(page.candidates.length, 2);
  assert.equal(page.candidates[0]?.candidate.identityCompleteness, "full");
  assert.equal(JSON.stringify(page).includes("@"), false);
  assert.equal(JSON.stringify(page).includes("phone"), false);
});

test("reveals a strict deterministic identity without coordinates", async () => {
  const provider = createDeterministicContactIdentityProvider({
    now: () => 1100,
  });
  const result = await provider.reveal({
    deadline: instant(2000),
    operationId: "identity-1",
    providerIdentity: {
      providerKey: "fixture",
      providerSubjectId: "fixture-subject-1",
    },
  });

  assert.deepEqual(result, {
    usage: { amount: 1, basis: "exact", unit: "fixture_credits" },
    value: {
      displayName: "Synthetic Person",
      firstName: "Synthetic",
      identityCompleteness: "full",
      lastName: "Person",
      observedAt: 1100,
      profileUrl: null,
    },
  });
  assert.equal(JSON.stringify(result).includes("email"), false);
  assert.equal(JSON.stringify(result).includes("phone"), false);
});

test("resolves and verifies only the supplied deterministic contact", async () => {
  const discovery = createDeterministicContactDiscoveryProvider({
    now: () => 1000,
  });
  const [contact] = (
    await discovery.discoverPage({
      companyHeadquartersCountryCodes: [],
      companyRecords: [
        {
          datasetId: datasetId("companies"),
          recordId: recordId("company-1"),
          values: [
            { fieldId: fieldId("company_name"), value: "Synthetic Company" },
            { fieldId: fieldId("company_domain"), value: "synthetic.example" },
          ],
          workspaceId: workspaceId("workspace"),
        },
      ],
      departments: [],
      inputCursor: null,
      maxContactsPerCompany: 1,
      maxContactsTotal: 1,
      personCountryCodes: [],
      seniorities: [],
      titles: [],
    })
  ).candidates;
  assert.ok(contact);
  const provider = createDeterministicContactWorkEmailProvider({
    now: () => 1000,
  });
  const resolution = await provider.resolve({
    contact,
    operationId: "resolve-1",
  });
  assert.equal(
    resolution.value?.email,
    "synthetic-contact-1@synthetic.example"
  );
  const verification = await provider.verify({
    email: resolution.value.email,
    operationId: "verify-1",
    providerIdentity: contact.providerIdentity,
  });
  assert.equal(verification.value.status, "valid");
});
