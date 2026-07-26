import { createHash } from "node:crypto";

import { type ContractRef, contentHash } from "@kurobara/kernel";
import type {
  InputContractValidationInput,
  InputContractValidatorPort,
  NormalizedJsonValue,
  OutputContractValidationInput,
  OutputContractValidatorPort,
} from "@kurobara/ports";
import Ajv2020, { type ValidateFunction } from "ajv/dist/2020.js";

export const JSON_SCHEMA_OUTPUT_VALIDATOR_VERSION =
  "ajv-8.20.0-json-schema-2020-12";
export const JSON_SCHEMA_INPUT_VALIDATOR_VERSION =
  JSON_SCHEMA_OUTPUT_VALIDATOR_VERSION;

type JsonObject = Readonly<Record<string, unknown>>;

export type JsonSchemaContractSource = Readonly<{
  catalogFingerprint: string;
  catalogVersion: string;
  schema: JsonObject;
}>;

export type RegisteredJsonSchemaContract = Readonly<{
  contract: ContractRef;
  schema: JsonObject;
}>;

export class JsonSchemaOutputValidatorConfigurationError extends Error {
  readonly name = "JsonSchemaOutputValidatorConfigurationError";
}

const isObject = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const canonicalize = (value: unknown): string => {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "string"
  ) {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new JsonSchemaOutputValidatorConfigurationError(
        "A JSON Schema contract cannot contain a non-finite number."
      );
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(",")}]`;
  }
  if (isObject(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`)
      .join(",")}}`;
  }
  throw new JsonSchemaOutputValidatorConfigurationError(
    `A JSON Schema contract cannot contain ${typeof value}.`
  );
};

const schemaFingerprint = (
  schema: JsonObject
): ContractRef["schemaFingerprint"] =>
  contentHash(
    `sha256:${createHash("sha256").update(canonicalize(schema), "utf8").digest("hex")}`
  );

const nonEmpty = (value: unknown, field: string): string => {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new JsonSchemaOutputValidatorConfigurationError(
      `${field} must be a non-empty string.`
    );
  }
  return value;
};

export const jsonSchemaContractRef = (
  source: JsonSchemaContractSource
): ContractRef => {
  const schemaId = nonEmpty(source.schema.$id, "schema.$id");
  const schemaVersion = nonEmpty(
    source.schema["x-kurobara-schema-version"],
    "schema.x-kurobara-schema-version"
  );
  return {
    catalogFingerprint: contentHash(
      nonEmpty(source.catalogFingerprint, "catalogFingerprint")
    ),
    catalogVersion: nonEmpty(source.catalogVersion, "catalogVersion"),
    schemaFingerprint: schemaFingerprint(source.schema),
    schemaId,
    schemaVersion,
  };
};

const contractKey = (contract: ContractRef): string =>
  JSON.stringify([
    contract.catalogFingerprint,
    contract.catalogVersion,
    contract.schemaFingerprint,
    contract.schemaId,
    contract.schemaVersion,
  ]);

const addKurobaraMetadataKeywords = (ajv: Ajv2020): void => {
  const stringKeywords = [
    "x-kurobara-data-classification",
    "x-kurobara-owner",
    "x-kurobara-publication-status",
    "x-kurobara-schema-version",
  ] as const;
  for (const keyword of stringKeywords) {
    ajv.addKeyword({ keyword, schemaType: "string", valid: true });
  }
  const capabilityKeywords = [
    "x-kurobara-admissible-for-capabilities",
    "x-kurobara-required-for-capabilities",
  ] as const;
  for (const keyword of capabilityKeywords) {
    ajv.addKeyword({ keyword, schemaType: "array", valid: true });
  }
};

const compileValidators = (
  registrations: readonly RegisteredJsonSchemaContract[],
  contractKind: "input" | "output"
): ReadonlyMap<string, ValidateFunction<NormalizedJsonValue>> => {
  if (registrations.length === 0) {
    throw new JsonSchemaOutputValidatorConfigurationError(
      `At least one ${contractKind} contract must be registered.`
    );
  }
  const ajv = new Ajv2020({
    allErrors: true,
    strict: true,
    validateFormats: false,
  });
  addKurobaraMetadataKeywords(ajv);
  const validators = new Map<string, ValidateFunction<NormalizedJsonValue>>();
  for (const registration of registrations) {
    const derived = jsonSchemaContractRef({
      catalogFingerprint: registration.contract.catalogFingerprint,
      catalogVersion: registration.contract.catalogVersion,
      schema: registration.schema,
    });
    if (contractKey(derived) !== contractKey(registration.contract)) {
      throw new JsonSchemaOutputValidatorConfigurationError(
        "A registered ContractRef does not match its canonical JSON Schema."
      );
    }
    const key = contractKey(registration.contract);
    if (validators.has(key)) {
      throw new JsonSchemaOutputValidatorConfigurationError(
        "Output contracts must be registered exactly once."
      );
    }
    validators.set(key, ajv.compile<NormalizedJsonValue>(registration.schema));
  }

  return validators;
};

export const createJsonSchemaOutputContractValidator = (
  registrations: readonly RegisteredJsonSchemaContract[]
): OutputContractValidatorPort => {
  const validators = compileValidators(registrations, "output");
  return Object.freeze({
    validate: ({ contract, value }: OutputContractValidationInput) => {
      const validator = validators.get(contractKey(contract));
      if (validator === undefined) {
        return Promise.resolve({
          reason: "output-contract-not-registered" as const,
          status: "rejected" as const,
        });
      }
      return Promise.resolve(
        validator(value)
          ? {
              status: "accepted" as const,
              validatorVersion: JSON_SCHEMA_OUTPUT_VALIDATOR_VERSION,
            }
          : {
              reason: "output-schema-rejected" as const,
              status: "rejected" as const,
            }
      );
    },
  });
};

export const createJsonSchemaInputContractValidator = (
  registrations: readonly RegisteredJsonSchemaContract[]
): InputContractValidatorPort => {
  const validators = compileValidators(registrations, "input");
  return Object.freeze({
    validate: ({ contract, value }: InputContractValidationInput) => {
      const validator = validators.get(contractKey(contract));
      if (validator === undefined) {
        return Promise.resolve({
          reason: "input-contract-not-registered" as const,
          status: "rejected" as const,
        });
      }
      return Promise.resolve(
        validator(value)
          ? {
              status: "accepted" as const,
              validatorVersion: JSON_SCHEMA_INPUT_VALIDATOR_VERSION,
            }
          : {
              reason: "input-schema-rejected" as const,
              status: "rejected" as const,
            }
      );
    },
  });
};
