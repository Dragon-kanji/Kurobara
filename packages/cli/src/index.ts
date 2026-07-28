#!/usr/bin/env node

import { runCli } from "./cli.ts";

const argv = process.argv.slice(2);
const commandController =
  (argv[0] === "recipe" && (argv[1] === "export" || argv[1] === "watch")) ||
  (argv[0] === "dataset" && argv[1] === "export") ||
  argv[0] === "setup" ||
  argv[0] === "first-run" ||
  argv[0] === "runtime"
    ? new AbortController()
    : undefined;
const abortCommand = (): void => commandController?.abort();
if (commandController !== undefined) {
  process.once("SIGINT", abortCommand);
  process.once("SIGTERM", abortCommand);
}

try {
  process.exitCode = await runCli({
    argv,
    environment: process.env,
    ...(commandController === undefined
      ? {}
      : { signal: commandController.signal }),
    stderr: process.stderr,
    stdin: process.stdin,
    stdout: process.stdout,
  });
} finally {
  if (commandController !== undefined) {
    process.off("SIGINT", abortCommand);
    process.off("SIGTERM", abortCommand);
  }
}
