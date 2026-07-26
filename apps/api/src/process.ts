import {
  createConfiguredDeterministicFixtureRoutes,
  createConfiguredOfficialProviderRoutes,
  createConfiguredSelectedContactProviderRoutes,
  parseConfiguredContactPrivacyHmacSecrets,
} from "@kurobara/adapter-provider-registry";

import type { ApiProcessConfig } from "./config.ts";
import {
  parseApiDatabaseUrl,
  parseApiProcessConfig,
  parseContactExportPolicyTemplate,
} from "./config.ts";
import {
  type ApiProcessLifecycle,
  type ApiProcessService,
  createApiProcessLifecycle,
} from "./lifecycle.ts";
import { createApiService } from "./service.ts";

export type ApiSignalHost = Readonly<{
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

export type ApiShutdownOutcome = Readonly<{
  error?: unknown;
  signal: NodeJS.Signals;
  status: "failed" | "stopped";
}>;

export type ApiRunningProcess = Readonly<{
  config: ApiProcessConfig;
  disposeSignalHandlers: () => void;
  lifecycle: ApiProcessLifecycle;
  shutdown: Promise<ApiShutdownOutcome>;
}>;

const installSignalHandlers = (
  signalHost: ApiSignalHost,
  lifecycle: ApiProcessLifecycle
): Pick<ApiRunningProcess, "disposeSignalHandlers" | "shutdown"> => {
  let resolveShutdown: (outcome: ApiShutdownOutcome) => void = () => undefined;
  const shutdown = new Promise<ApiShutdownOutcome>((resolve) => {
    resolveShutdown = resolve;
  });
  const signals: readonly NodeJS.Signals[] = ["SIGINT", "SIGTERM"];

  const disposeSignalHandlers = (): void => {
    for (const signal of signals) {
      signalHost.off(signal, handleSignal);
    }
  };

  const handleSignal = (signal: NodeJS.Signals): void => {
    disposeSignalHandlers();
    lifecycle
      .stop(signal)
      .then(() => resolveShutdown({ signal, status: "stopped" }))
      .catch((error: unknown) => {
        signalHost.exitCode = 1;
        resolveShutdown({ error, signal, status: "failed" });
      });
  };

  for (const signal of signals) {
    signalHost.once(signal, handleSignal);
  }

  return { disposeSignalHandlers, shutdown };
};

export const startApiProcess = async (options: {
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly signalHost?: ApiSignalHost;
  readonly transport?: ApiProcessService;
}): Promise<ApiRunningProcess> => {
  const config = parseApiProcessConfig(options.environment);
  const executionRoutes = [
    ...createConfiguredDeterministicFixtureRoutes(options.environment),
    ...createConfiguredOfficialProviderRoutes(options.environment),
    ...createConfiguredSelectedContactProviderRoutes(options.environment),
  ];
  const contactExportPolicy = parseContactExportPolicyTemplate(
    options.environment
  );
  const transport =
    options.transport ??
    createApiService({
      config,
      ...(contactExportPolicy === undefined ? {} : { contactExportPolicy }),
      contactPrivacyHmacSecrets: parseConfiguredContactPrivacyHmacSecrets(
        options.environment
      ),
      databaseUrl: parseApiDatabaseUrl(options.environment),
      executionRoutes,
    });

  const lifecycle = createApiProcessLifecycle(
    transport,
    config.shutdownTimeoutMs
  );
  await lifecycle.start();
  const signalHandlers = installSignalHandlers(
    options.signalHost ?? process,
    lifecycle
  );

  return { config, lifecycle, ...signalHandlers };
};
