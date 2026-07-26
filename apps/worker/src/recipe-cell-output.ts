import {
  createJsonSchemaOutputContractValidator,
  jsonSchemaContractRef,
} from "@kurobara/adapter-output-json-schema";
import { catalogFingerprint, schemaIds } from "@kurobara/contracts";
import catalogManifest from "@kurobara/contracts/catalog-manifest.json" with {
  type: "json",
};
import recipeCellOutputSchema from "@kurobara/contracts/schemas/recipe-cell-output.json" with {
  type: "json",
};

const contract = jsonSchemaContractRef({
  catalogFingerprint,
  catalogVersion: catalogManifest.catalog_version,
  schema: recipeCellOutputSchema,
});

const catalogMember = catalogManifest.members.find(
  (member) => member.id === schemaIds.RecipeCellOutput
);

if (
  catalogMember === undefined ||
  catalogMember.role !== "schema" ||
  catalogMember.fingerprint !== contract.schemaFingerprint
) {
  throw new Error(
    "The recipe cell output contract does not match the generated catalog manifest."
  );
}

export const recipeCellOutputContract = Object.freeze(contract);

export const createRecipeCellOutputValidator = () =>
  createJsonSchemaOutputContractValidator([
    {
      contract: recipeCellOutputContract,
      schema: recipeCellOutputSchema,
    },
  ]);
