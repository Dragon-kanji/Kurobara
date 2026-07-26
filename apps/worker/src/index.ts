import { pathToFileURL } from "node:url";

import { WorkerConfigError } from "./config.ts";
import { startWorkerProcess } from "./process.ts";

const isMainModule =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMainModule) {
  startWorkerProcess({ environment: process.env }).catch((error: unknown) => {
    const message =
      error instanceof WorkerConfigError
        ? error.message
        : "Worker startup failed; inspect redacted diagnostics.";
    console.error(`Kurobara worker failed to start: ${message}`);
    process.exitCode = 1;
  });
}
