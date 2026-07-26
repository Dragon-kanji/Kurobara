import { workerValue } from "../../../apps/worker/index.ts";
import { applicationValue } from "../../application/index.ts";
import { contractsValue } from "../../contracts/index.ts";
import { kernelValue } from "../../kernel/index.ts";
import { portsValue } from "../../ports/index.ts";
import { adapterValue } from "../other/index.ts";

export const forbiddenRuntimeValues = [
  adapterValue,
  applicationValue,
  contractsValue,
  kernelValue,
  portsValue,
  workerValue,
];
