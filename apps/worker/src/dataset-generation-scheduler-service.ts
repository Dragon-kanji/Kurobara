import { randomUUID } from "node:crypto";

import {
  makeScheduleNextDatasetGeneration,
  type ScheduleDatasetGenerationDependencies,
} from "@kurobara/application";

import {
  createPollingService,
  type PollingService,
} from "./polling-service.ts";

export type DatasetGenerationSchedulerService = PollingService;

export const createDatasetGenerationSchedulerService = (options: {
  readonly authorize: ScheduleDatasetGenerationDependencies["authorize"];
  readonly checkpoint: ScheduleDatasetGenerationDependencies["checkpoint"];
  readonly claimLeaseMilliseconds: number;
  readonly clock: ScheduleDatasetGenerationDependencies["clock"];
  readonly nextLeaseToken?: () => string;
  readonly pollIntervalMs: number;
  readonly schedulerId: string;
  readonly work: ScheduleDatasetGenerationDependencies["work"];
}): DatasetGenerationSchedulerService => {
  const cycle = makeScheduleNextDatasetGeneration({
    ...options,
    nextLeaseToken: options.nextLeaseToken ?? randomUUID,
  });
  return createPollingService({
    cycle: async () => ({ idle: (await cycle()).idle }),
    pollIntervalMs: options.pollIntervalMs,
  });
};
