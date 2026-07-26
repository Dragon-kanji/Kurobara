import type { ContentHash, ContractRef, Instant } from "@kurobara/kernel";

import type { NormalizedJsonValue } from "./normalized-json.ts";

export type ValidatedRunInput = Readonly<{
  classification: "internal";
  contentHash: ContentHash;
  contract: ContractRef;
  finalizedAt: Instant;
  inputId: string;
  mediaType: "application/json";
  sizeBytes: number;
  validatedAt: Instant;
  validatorVersion: string;
  value: NormalizedJsonValue;
}>;

export type InputContractValidationInput = Readonly<{
  contract: ContractRef;
  value: NormalizedJsonValue;
}>;

export type InputContractValidationResult =
  | Readonly<{ status: "accepted"; validatorVersion: string }>
  | Readonly<{ reason: string; status: "rejected" }>;

export interface InputContractValidatorPort {
  validate(
    input: InputContractValidationInput
  ): Promise<InputContractValidationResult>;
}
