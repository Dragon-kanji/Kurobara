import { appValue } from "../../apps/worker/index.ts";
import { adapterValue } from "../adapters/provider/index.ts";
import { applicationValue } from "../application/index.ts";
import { kernelValue } from "../kernel/index.ts";
import { portsValue } from "../ports/index.ts";

export const forbiddenRuntimeValues = [
  adapterValue,
  appValue,
  applicationValue,
  kernelValue,
  portsValue,
];
