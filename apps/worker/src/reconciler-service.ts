import {
  createPollingService,
  type PollingService,
} from "./polling-service.ts";

export type ReconcileRunOrchestrations = () => Promise<
  Readonly<{ claimed: number }>
>;

export type RunOrchestrationReconcilerService = PollingService;
export type LeafEffectReconcilerService = PollingService;

export const createRunOrchestrationReconcilerService = (options: {
  readonly pollIntervalMs: number;
  readonly reconcile: ReconcileRunOrchestrations;
}): RunOrchestrationReconcilerService =>
  createPollingService({
    cycle: async () => {
      await options.reconcile();
      return { idle: true };
    },
    pollIntervalMs: options.pollIntervalMs,
  });

export const createLeafEffectReconcilerService = (options: {
  readonly pollIntervalMs: number;
  readonly reconcile: ReconcileRunOrchestrations;
}): LeafEffectReconcilerService =>
  createPollingService({
    cycle: async () => {
      await options.reconcile();
      return { idle: true };
    },
    pollIntervalMs: options.pollIntervalMs,
  });
