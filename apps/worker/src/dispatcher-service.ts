import {
  createPollingService,
  type PollingService,
} from "./polling-service.ts";

export type DispatchNextOutbox = () => Promise<Readonly<{ status: string }>>;

export type OutboxDispatcherService = PollingService;

export const createOutboxDispatcherService = (options: {
  readonly dispatchNext: DispatchNextOutbox;
  readonly pollIntervalMs: number;
}): OutboxDispatcherService =>
  createPollingService({
    cycle: async () => ({
      idle: (await options.dispatchNext()).status === "idle",
    }),
    pollIntervalMs: options.pollIntervalMs,
  });
