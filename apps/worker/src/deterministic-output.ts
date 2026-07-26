import {
  createJsonSchemaOutputContractValidator,
  jsonSchemaContractRef,
} from "@kurobara/adapter-output-json-schema";
import { catalogFingerprint, schemaIds } from "@kurobara/contracts";
import catalogManifest from "@kurobara/contracts/catalog-manifest.json" with {
  type: "json",
};
import deterministicOutputSchema from "@kurobara/contracts/schemas/fixtures/deterministic-output.json" with {
  type: "json",
};

const contract = jsonSchemaContractRef({
  catalogFingerprint,
  catalogVersion: catalogManifest.catalog_version,
  schema: deterministicOutputSchema,
});

const catalogMember = catalogManifest.members.find(
  (member) => member.id === schemaIds.DeterministicOutputFixture
);

if (
  catalogMember === undefined ||
  catalogMember.role !== "schema" ||
  catalogMember.fingerprint !== contract.schemaFingerprint
) {
  throw new Error(
    "The deterministic output contract does not match the generated catalog manifest."
  );
}

export const deterministicOutputContract = Object.freeze(contract);

export const createDeterministicOutputValidator = () =>
  createJsonSchemaOutputContractValidator([
    {
      contract: deterministicOutputContract,
      schema: deterministicOutputSchema,
    },
  ]);
