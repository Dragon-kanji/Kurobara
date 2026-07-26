import { workerValue } from "../../apps/worker/index.ts";
import { providerValue } from "../adapters/provider/index.ts";
import { applicationValue } from "../application/index.ts";
import { contractsValue } from "../contracts/index.ts";
import { kernelValue } from "../kernel/index.ts";
import { portsValue } from "../ports/index.ts";

export const forbiddenRuntimeValues = [
  applicationValue,
  contractsValue,
  kernelValue,
  portsValue,
  providerValue,
  workerValue,
];
