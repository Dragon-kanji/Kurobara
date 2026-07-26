import { pathToFileURL } from "node:url";

import { startApiProcess } from "./process.ts";

const isMainModule =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMainModule) {
  startApiProcess({ environment: process.env }).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Kurobara API failed to start: ${message}`);
    process.exitCode = 1;
  });
}
