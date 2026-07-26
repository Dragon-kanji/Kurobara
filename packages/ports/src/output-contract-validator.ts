import type { ContractRef } from "@kurobara/kernel";
import type { NormalizedJsonValue } from "./normalized-json.ts";

export type OutputContractValidationInput = Readonly<{
  contract: ContractRef;
  value: NormalizedJsonValue;
}>;

export type OutputContractValidationResult =
  | Readonly<{ status: "accepted"; validatorVersion: string }>
  | Readonly<{ reason: string; status: "rejected" }>;

export interface OutputContractValidatorPort {
  validate(
    input: OutputContractValidationInput
  ): Promise<OutputContractValidationResult>;
}
