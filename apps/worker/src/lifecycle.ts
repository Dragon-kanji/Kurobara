export type WorkerProcessPhase =
  | "failed"
  | "idle"
  | "ready"
  | "starting"
  | "stopped"
  | "stopping";

export type WorkerProcessService = Readonly<{
  start: () => Promise<void>;
  stop: (reason: string) => Promise<void>;
  waitForFailure?: () => Promise<never>;
}>;

export type WorkerProcessLifecycle = Readonly<{
  health: () => Readonly<{
    phase: WorkerProcessPhase;
    status: "healthy" | "unhealthy";
  }>;
  readiness: () => Readonly<{
    phase: WorkerProcessPhase;
    status: "not-ready" | "ready";
  }>;
  start: () => Promise<void>;
  stop: (reason: string) => Promise<void>;
  waitForFailure: () => Promise<never>;
}>;

const withTimeout = async (
  operation: Promise<void>,
  timeoutMs: number
): Promise<void> => {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutFailure = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(
      () => reject(new Error(`Shutdown exceeded ${timeoutMs}ms.`)),
      timeoutMs
    );
  });

  try {
    await Promise.race([operation, timeoutFailure]);
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
  }
};

const monitorServiceFailure = async (
  failure: Promise<never>,
  handleFailure: (error: unknown) => Promise<void>
): Promise<void> => {
  try {
    await failure;
  } catch (error) {
    await handleFailure(error);
  }
};

export const createWorkerProcessLifecycle = (
  service: WorkerProcessService,
  shutdownTimeoutMs: number
): WorkerProcessLifecycle => {
  let phase: WorkerProcessPhase = "idle";
  let stopPromise: Promise<void> | undefined;
  let rejectFailure: (error: unknown) => void = () => undefined;
  const failurePromise = new Promise<never>((_resolve, reject) => {
    rejectFailure = reject;
  });
  failurePromise.catch(() => undefined);

  const handleLateFailure = async (error: unknown): Promise<void> => {
    if (phase !== "ready") {
      return;
    }
    phase = "failed";
    try {
      stopPromise = withTimeout(
        service.stop("runtime-failure"),
        shutdownTimeoutMs
      );
      await stopPromise;
      rejectFailure(error);
    } catch (cleanupError) {
      rejectFailure(
        new AggregateError(
          [error, cleanupError],
          "Worker runtime failure and cleanup failed."
        )
      );
    }
  };

  const start = async (): Promise<void> => {
    if (phase === "ready") {
      return;
    }
    if (phase !== "idle") {
      throw new Error(`Worker process cannot start from phase ${phase}.`);
    }
    phase = "starting";
    try {
      await service.start();
      phase = "ready";
      const serviceFailure = service.waitForFailure?.();
      if (serviceFailure !== undefined) {
        monitorServiceFailure(serviceFailure, handleLateFailure).catch(
          () => undefined
        );
      }
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
    stopPromise = withTimeout(service.stop(reason), shutdownTimeoutMs)
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
    waitForFailure: () => failurePromise,
  };
};
