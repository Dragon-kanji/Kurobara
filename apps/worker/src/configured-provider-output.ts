import {
  createJsonSchemaOutputContractValidator,
  jsonSchemaContractRef,
} from "@kurobara/adapter-output-json-schema";
import { catalogFingerprint, schemaIds } from "@kurobara/contracts";
import catalogManifest from "@kurobara/contracts/catalog-manifest.json" with {
  type: "json",
};
import datasetGenerationPageInputSchema from "@kurobara/contracts/schemas/dataset-generation-page-input.json" with {
  type: "json",
};
import datasetGenerationPageOutputSchema from "@kurobara/contracts/schemas/dataset-generation-page-output.json" with {
  type: "json",
};
import recipeCellOutputSchema from "@kurobara/contracts/schemas/recipe-cell-output.json" with {
  type: "json",
};

const checkedContract = (
  schema: Parameters<typeof jsonSchemaContractRef>[0]["schema"],
  schemaId: string
) => {
  const contract = jsonSchemaContractRef({
    catalogFingerprint,
    catalogVersion: catalogManifest.catalog_version,
    schema,
  });
  const member = catalogManifest.members.find(
    (candidate) => candidate.id === schemaId
  );
  if (
    member === undefined ||
    member.role !== "schema" ||
    member.fingerprint !== contract.schemaFingerprint
  ) {
    throw new Error(
      "A configured provider contract does not match the generated catalog."
    );
  }
  return Object.freeze(contract);
};

export const datasetGenerationPageInputContract = checkedContract(
  datasetGenerationPageInputSchema,
  schemaIds.DatasetGenerationPageInput
);

export const datasetGenerationPageOutputContract = checkedContract(
  datasetGenerationPageOutputSchema,
  schemaIds.DatasetGenerationPageOutput
);

const entries = [
  {
    schema: recipeCellOutputSchema,
    schemaId: schemaIds.RecipeCellOutput,
  },
  {
    schema: datasetGenerationPageOutputSchema,
    schemaId: schemaIds.DatasetGenerationPageOutput,
  },
].map(({ schema, schemaId }) => ({
  contract:
    schemaId === schemaIds.DatasetGenerationPageOutput
      ? datasetGenerationPageOutputContract
      : checkedContract(schema, schemaId),
  schema,
}));

export const createConfiguredProviderOutputValidator = () =>
  createJsonSchemaOutputContractValidator(entries);
