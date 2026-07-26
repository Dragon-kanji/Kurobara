export type ApiProcessPhase =
  | "failed"
  | "idle"
  | "ready"
  | "starting"
  | "stopped"
  | "stopping";

export type ApiProcessService = Readonly<{
  forceStop?: (reason: string) => Promise<void>;
  start: () => Promise<void>;
  stop: (reason: string) => Promise<void>;
}>;

export type ApiProcessLifecycle = Readonly<{
  health: () => Readonly<{
    phase: ApiProcessPhase;
    status: "healthy" | "unhealthy";
  }>;
  readiness: () => Readonly<{
    phase: ApiProcessPhase;
    status: "not-ready" | "ready";
  }>;
  start: () => Promise<void>;
  stop: (reason: string) => Promise<void>;
}>;

const withTimeout = async (
  operation: Promise<void>,
  timeoutMs: number,
  forceStop?: () => Promise<void>
): Promise<void> =>
  new Promise((resolve, reject) => {
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      const timeoutError = new Error(`Shutdown exceeded ${timeoutMs}ms.`);
      if (forceStop === undefined) {
        reject(timeoutError);
        return;
      }
      forceStop().then(
        () => reject(timeoutError),
        (forceError: unknown) =>
          reject(
            new AggregateError(
              [timeoutError, forceError],
              "Timed-out API shutdown could not force resource cleanup."
            )
          )
      );
    }, timeoutMs);

    operation.then(
      () => {
        if (!settled) {
          settled = true;
          clearTimeout(timeout);
          resolve();
        }
      },
      (error: unknown) => {
        if (!settled) {
          settled = true;
          clearTimeout(timeout);
          reject(error);
        }
      }
    );
  });

export const createApiProcessLifecycle = (
  service: ApiProcessService,
  shutdownTimeoutMs: number
): ApiProcessLifecycle => {
  let phase: ApiProcessPhase = "idle";
  let stopPromise: Promise<void> | undefined;

  const start = async (): Promise<void> => {
    if (phase === "ready") {
      return;
    }
    if (phase !== "idle") {
      throw new Error(`API process cannot start from phase ${phase}.`);
    }
    phase = "starting";
    try {
      await service.start();
      phase = "ready";
    } catch (error) {
      phase = "failed";
      throw error;
    }
  };

  const stop = (reason: string): Promise<void> => {
    if (stopPromise !== undefined) {
      return stopPromise;
    }
    if (phase === "idle" || phase === "stopped") {
      phase = "stopped";
      return Promise.resolve();
    }

    phase = "stopping";
    stopPromise = withTimeout(
      service.stop(reason),
      shutdownTimeoutMs,
      service.forceStop === undefined
        ? undefined
        : () =>
            service.forceStop?.(`shutdown-timeout:${reason}`) ??
            Promise.resolve()
    )
      .then(() => {
        phase = "stopped";
      })
      .catch((error: unknown) => {
        phase = "failed";
        throw error;
      });
    return stopPromise;
  };

  return {
    health: () => ({
      phase,
      status: phase === "failed" ? "unhealthy" : "healthy",
    }),
    readiness: () => ({
      phase,
      status: phase === "ready" ? "ready" : "not-ready",
    }),
    start,
    stop,
  };
};
