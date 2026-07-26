import { jsonSchemaContractRef } from "@kurobara/adapter-output-json-schema";
import { catalogFingerprint, schemaIds } from "@kurobara/contracts";
import catalogManifest from "@kurobara/contracts/catalog-manifest.json" with {
  type: "json",
};
import recipeCellInputSchema from "@kurobara/contracts/schemas/recipe-cell-input.json" with {
  type: "json",
};

const contract = jsonSchemaContractRef({
  catalogFingerprint,
  catalogVersion: catalogManifest.catalog_version,
  schema: recipeCellInputSchema,
});

const catalogMember = catalogManifest.members.find(
  (member) => member.id === schemaIds.RecipeCellInput
);

if (
  catalogMember === undefined ||
  catalogMember.role !== "schema" ||
  catalogMember.fingerprint !== contract.schemaFingerprint
) {
  throw new Error(
    "The recipe cell input contract does not match the generated catalog manifest."
  );
}

export const recipeCellInputContract = Object.freeze(contract);
