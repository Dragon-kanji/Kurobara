import {
  createPollingService,
  type PollingService,
} from "./polling-service.ts";

export type MaterializeNextDagRun = () => Promise<
  Readonly<{ status: "idle" | "processed" }>
>;

export type DagSchedulerService = PollingService;

export const createDagSchedulerService = (options: {
  readonly materializeNext: MaterializeNextDagRun;
  readonly pollIntervalMs: number;
}): DagSchedulerService =>
  createPollingService({
    cycle: async () => ({
      idle: (await options.materializeNext()).status === "idle",
    }),
    pollIntervalMs: options.pollIntervalMs,
  });
