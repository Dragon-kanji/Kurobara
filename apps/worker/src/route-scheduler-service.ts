import {
  createPollingService,
  type PollingService,
} from "./polling-service.ts";

export type RouteSchedulingStatus = Readonly<{
  status: "claimed" | "deferred" | "idle" | "rejected" | "stale";
}>;

export type RouteAndClaimNextReadyStep = () => Promise<RouteSchedulingStatus>;

export type RouteSchedulerService = PollingService &
  Readonly<{ schedulerId: string }>;

const schedulerId = (value: string): string => {
  if (value.length === 0 || value.trim() !== value) {
    throw new RangeError(
      "schedulerId must be non-empty without outer whitespace."
    );
  }
  return value;
};

export const createRouteSchedulerService = (options: {
  readonly pollIntervalMs: number;
  readonly routeAndClaimNext: RouteAndClaimNextReadyStep;
  readonly schedulerId: string;
}): RouteSchedulerService => {
  const service = createPollingService({
    cycle: async () => ({
      idle: (await options.routeAndClaimNext()).status !== "claimed",
    }),
    pollIntervalMs: options.pollIntervalMs,
  });
  return Object.assign(service, {
    schedulerId: schedulerId(options.schedulerId),
  });
};
