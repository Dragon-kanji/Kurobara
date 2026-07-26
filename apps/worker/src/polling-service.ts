import type { WorkerProcessService } from "./lifecycle.ts";

export type PollingCycle = () => Promise<Readonly<{ idle: boolean }>>;

export type PollingService = WorkerProcessService &
  Readonly<{
    failure: () => unknown;
    running: () => boolean;
    waitForFailure: () => Promise<never>;
  }>;

const waitForAbort = (signal: AbortSignal, delayMs: number): Promise<void> =>
  new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timeout = setTimeout(() => {
      signal.removeEventListener("abort", handleAbort);
      resolve();
    }, delayMs);
    const handleAbort = (): void => {
      clearTimeout(timeout);
      signal.removeEventListener("abort", handleAbort);
      resolve();
    };
    signal.addEventListener("abort", handleAbort, { once: true });
  });

export const createPollingService = (options: {
  readonly cycle: PollingCycle;
  readonly pollIntervalMs: number;
}): PollingService => {
  let abortController: AbortController | undefined;
  let cycleFailure: unknown;
  let loopActive = false;
  let loopPromise: Promise<void> | undefined;
  let rejectFailure: (error: unknown) => void = () => undefined;
  let stopPromise: Promise<void> | undefined;
  const failurePromise = new Promise<never>((_resolve, reject) => {
    rejectFailure = reject;
  });
  failurePromise.catch(() => undefined);

  const loop = async (signal: AbortSignal): Promise<void> => {
    while (!signal.aborted) {
      const result = await options.cycle();
      if (result.idle && !signal.aborted) {
        await waitForAbort(signal, options.pollIntervalMs);
      }
    }
  };

  const start = (): Promise<void> => {
    if (loopPromise !== undefined) {
      return Promise.resolve();
    }
    if (
      !Number.isSafeInteger(options.pollIntervalMs) ||
      options.pollIntervalMs <= 0
    ) {
      throw new RangeError("pollIntervalMs must be a positive safe integer.");
    }
    abortController = new AbortController();
    loopPromise = loop(abortController.signal);
    loopActive = true;
    loopPromise.then(
      () => {
        loopActive = false;
      },
      (error: unknown) => {
        loopActive = false;
        cycleFailure = error;
        rejectFailure(error);
      }
    );
    return Promise.resolve();
  };

  const stop = (_reason: string): Promise<void> => {
    if (stopPromise !== undefined) {
      return stopPromise;
    }
    abortController?.abort();
    const currentLoop = loopPromise;
    stopPromise = (currentLoop ?? Promise.resolve()).then(
      () => undefined,
      (error: unknown) => {
        cycleFailure = error;
        throw error;
      }
    );
    return stopPromise;
  };

  return {
    failure: () => cycleFailure,
    running: () => loopActive && !abortController?.signal.aborted,
    start,
    stop,
    waitForFailure: () => failurePromise,
  };
};
