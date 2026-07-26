import type { WorkerProcessConfig } from "./config.ts";
import { parseWorkerProcessConfig } from "./config.ts";
import {
  createWorkerProcessLifecycle,
  type WorkerProcessLifecycle,
  type WorkerProcessService,
} from "./lifecycle.ts";
import { createConfiguredWorkerService } from "./service.ts";

export type WorkerSignalHost = Readonly<{
  off: (
    signal: NodeJS.Signals,
    listener: (signal: NodeJS.Signals) => void
  ) => void;
  once: (
    signal: NodeJS.Signals,
    listener: (signal: NodeJS.Signals) => void
  ) => void;
}> & {
  exitCode?: NodeJS.Process["exitCode"];
};

export type WorkerShutdownOutcome = Readonly<{
  error?: unknown;
  signal?: NodeJS.Signals;
  status: "failed" | "stopped";
}>;

export type WorkerRunningProcess = Readonly<{
  config: WorkerProcessConfig;
  disposeSignalHandlers: () => void;
  lifecycle: WorkerProcessLifecycle;
  shutdown: Promise<WorkerShutdownOutcome>;
}>;

const installSignalHandlers = (
  signalHost: WorkerSignalHost,
  lifecycle: WorkerProcessLifecycle
): Pick<WorkerRunningProcess, "disposeSignalHandlers" | "shutdown"> => {
  let resolveShutdown: (outcome: WorkerShutdownOutcome) => void = () =>
    undefined;
  const shutdown = new Promise<WorkerShutdownOutcome>((resolve) => {
    resolveShutdown = resolve;
  });
  let shutdownSettled = false;
  const signals: readonly NodeJS.Signals[] = ["SIGINT", "SIGTERM"];

  const settleShutdown = (outcome: WorkerShutdownOutcome): void => {
    if (shutdownSettled) {
      return;
    }
    shutdownSettled = true;
    resolveShutdown(outcome);
  };

  const disposeSignalHandlers = (): void => {
    for (const signal of signals) {
      signalHost.off(signal, handleSignal);
    }
  };

  const handleSignal = (signal: NodeJS.Signals): void => {
    disposeSignalHandlers();
    lifecycle
      .stop(signal)
      .then(() => settleShutdown({ signal, status: "stopped" }))
      .catch((error: unknown) => {
        signalHost.exitCode = 1;
        settleShutdown({ error, signal, status: "failed" });
      });
  };

  for (const signal of signals) {
    signalHost.once(signal, handleSignal);
  }

  lifecycle.waitForFailure().catch((error: unknown) => {
    disposeSignalHandlers();
    signalHost.exitCode = 1;
    settleShutdown({ error, status: "failed" });
  });

  return { disposeSignalHandlers, shutdown };
};

export const startWorkerProcess = async (options: {
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly service?: WorkerProcessService;
  readonly signalHost?: WorkerSignalHost;
}): Promise<WorkerRunningProcess> => {
  const config = parseWorkerProcessConfig(options.environment);
  const service =
    options.service ??
    createConfiguredWorkerService(config, options.environment);

  const lifecycle = createWorkerProcessLifecycle(
    service,
    config.shutdownTimeoutMs
  );
  await lifecycle.start();
  const signalHandlers = installSignalHandlers(
    options.signalHost ?? process,
    lifecycle
  );

  return { config, lifecycle, ...signalHandlers };
};
