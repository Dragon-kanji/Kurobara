import { randomUUID } from "node:crypto";

import {
  type AdvanceGtmPlayRunDependencies,
  makeAdvanceNextGtmPlayRun,
} from "@kurobara/application";

import {
  createPollingService,
  type PollingService,
} from "./polling-service.ts";

export type GtmPlaySchedulerService = PollingService;

export const createGtmPlaySchedulerService = (
  options: Omit<AdvanceGtmPlayRunDependencies, "nextClaimToken"> &
    Readonly<{
      nextClaimToken?: () => string;
      pollIntervalMs: number;
    }>
): GtmPlaySchedulerService => {
  const cycle = makeAdvanceNextGtmPlayRun({
    ...options,
    nextClaimToken: options.nextClaimToken ?? randomUUID,
  });
  return createPollingService({
    cycle: async () => ({ idle: (await cycle()).idle }),
    pollIntervalMs: options.pollIntervalMs,
  });
};
