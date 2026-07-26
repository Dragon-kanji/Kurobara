import { createHash } from "node:crypto";

import {
  createContactCandidate,
  createContactIdentityResolution,
  createContactWorkEmailResolution,
  type Instant,
  type InternalContactCandidate,
  recordId,
} from "@kurobara/kernel";
import type {
  ContactDiscoveryProviderPort,
  ContactIdentityProviderPort,
  ContactWorkEmailProviderPort,
} from "@kurobara/ports";

const slug = (value: string): string =>
  value
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-|-$/gu, "")
    .slice(0, 48) || "contact";

const digest = (value: string): string =>
  createHash("sha256").update(value, "utf8").digest("hex");

export type DeterministicContactFixtureOptions = Readonly<{
  now?: () => number;
}>;

const instant = (now: () => number): Instant => {
  const value = now();
  return (Number.isSafeInteger(value) && value >= 0 ? value : 0) as Instant;
};

export const createDeterministicContactDiscoveryProvider = (
  options: DeterministicContactFixtureOptions = {}
): ContactDiscoveryProviderPort => {
  const now = options.now ?? (() => 1000);
  return {
    // biome-ignore lint/suspicious/useAwait: the provider port requires an asynchronous boundary.
    discoverPage: async (request) => {
      if (request.inputCursor !== null) {
        return {
          candidates: [],
          hasMore: false,
          nextCursor: null,
          usage: { amount: 0, basis: "exact", unit: "fixture_calls" },
        };
      }
      const candidates: InternalContactCandidate[] = [];
      for (const company of request.companyRecords) {
        const values = new Map(
          company.values.map((entry) => [String(entry.fieldId), entry.value])
        );
        const organizationDomain = [...values.entries()].find(([key]) =>
          key.endsWith("domain")
        )?.[1];
        const organizationName = [...values.entries()].find(([key]) =>
          key.endsWith("name")
        )?.[1];
        if (
          typeof organizationDomain !== "string" ||
          typeof organizationName !== "string"
        ) {
          continue;
        }
        for (
          let position = 0;
          position < request.maxContactsPerCompany &&
          candidates.length < request.maxContactsTotal;
          position += 1
        ) {
          const providerSubjectId = `fixture_${digest(`${company.recordId}\0${position}`)}`;
          const contactId = recordId(`contact_${digest(providerSubjectId)}`);
          const created = createContactCandidate({
            contactId,
            department: request.departments[0] ?? "sales",
            displayName: `Synthetic Contact ${position + 1}`,
            identityCompleteness: "full",
            jobTitle: request.titles[0] ?? "Synthetic Director",
            observedAt: instant(now),
            organizationDomain,
            organizationId: company.recordId,
            organizationName,
            personCountryCode: request.personCountryCodes[0] ?? null,
            profileUrl: null,
            seniority: "director",
          });
          if (created.ok) {
            candidates.push({
              candidate: created.value,
              providerIdentity: {
                providerKey: "fixture",
                providerSubjectId,
              },
            });
          }
        }
      }
      return {
        candidates,
        hasMore: false,
        nextCursor: null,
        usage: { amount: 1, basis: "exact", unit: "fixture_calls" },
      };
    },
  };
};

export const createDeterministicContactWorkEmailProvider = (
  options: DeterministicContactFixtureOptions = {}
): ContactWorkEmailProviderPort => {
  const now = options.now ?? (() => 1000);
  return {
    // biome-ignore lint/suspicious/useAwait: the provider port requires an asynchronous boundary.
    resolve: async ({ contact }) => {
      const email = `${slug(contact.candidate.displayName)}@${contact.candidate.organizationDomain}`;
      const created = createContactWorkEmailResolution({
        confidence: 1,
        email,
        observedAt: instant(now),
        source: "inferred",
        verification: "valid",
      });
      if (!created.ok) {
        throw new Error("The deterministic contact fixture is invalid.");
      }
      return {
        usage: { amount: 1, basis: "exact", unit: "fixture_credits" },
        value: created.value,
      };
    },
    verify: async () => ({
      usage: { amount: 1, basis: "exact", unit: "fixture_credits" },
      value: { observedAt: instant(now), status: "valid" },
    }),
  };
};

export const createDeterministicContactIdentityProvider = (
  options: DeterministicContactFixtureOptions = {}
): ContactIdentityProviderPort => {
  const now = options.now ?? (() => 1000);
  return {
    quote: async ({ providerIdentity }) => ({
      guarantee: "hard",
      unit: "fixture_credits",
      upperBound: providerIdentity.providerKey === "fixture" ? 1 : 0,
    }),
    // biome-ignore lint/suspicious/useAwait: the provider port requires an asynchronous boundary.
    reveal: async ({ providerIdentity }) => {
      if (providerIdentity.providerKey !== "fixture") {
        return {
          usage: { amount: 0, basis: "exact", unit: "fixture_credits" },
          value: undefined,
        };
      }
      const created = createContactIdentityResolution({
        displayName: "Synthetic Person",
        firstName: "Synthetic",
        identityCompleteness: "full",
        lastName: "Person",
        observedAt: instant(now),
        profileUrl: null,
      });
      if (!created.ok) {
        throw new Error(
          "The deterministic contact identity fixture is invalid."
        );
      }
      return {
        usage: { amount: 1, basis: "exact", unit: "fixture_credits" },
        value: created.value,
      };
    },
  };
};
