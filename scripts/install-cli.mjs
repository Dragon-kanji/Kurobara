#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MARKER = "# kurobara-source-preview:";
const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const entrypoint = path.join(
  repositoryRoot,
  "packages",
  "cli",
  "src",
  "index.ts"
);

const parseArguments = (argv) => {
  const command = argv[0];
  if (command !== "install" && command !== "uninstall") {
    throw new Error("Expected install or uninstall.");
  }
  let prefix = path.join(process.env.HOME ?? "", ".local");
  for (let index = 1; index < argv.length; index += 2) {
    if (argv[index] !== "--prefix" || argv[index + 1] === undefined) {
      throw new Error("Only --prefix <directory> is supported.");
    }
    prefix = argv[index + 1];
  }
  if (prefix.length === 0) {
    throw new Error("A non-empty install prefix is required.");
  }
  return { command, prefix: path.resolve(prefix) };
};

const launcherFor = () => `#!/bin/sh
set -eu
${MARKER} ${repositoryRoot}
exec node --experimental-strip-types '${entrypoint.replaceAll("'", "'\\''")}' "$@"
`;

const readExisting = async (filePath) => {
  try {
    const details = await lstat(filePath);
    if (!details.isFile() || details.isSymbolicLink()) {
      throw new Error(`Refusing to replace non-regular path: ${filePath}`);
    }
    return readFile(filePath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") {
      return;
    }
    throw error;
  }
};

const install = async (binPath) => {
  const existing = await readExisting(binPath);
  if (existing !== undefined && !existing.includes(MARKER)) {
    throw new Error(`Refusing to replace an unrelated executable: ${binPath}`);
  }
  const temporaryPath = `${binPath}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, launcherFor(), {
    encoding: "utf8",
    flag: "wx",
    mode: 0o755,
  });
  await rename(temporaryPath, binPath);
  await chmod(binPath, 0o755);
};

const uninstall = async (binPath) => {
  const existing = await readExisting(binPath);
  if (existing === undefined) {
    return false;
  }
  if (!existing.includes(MARKER)) {
    throw new Error(`Refusing to remove an unrelated executable: ${binPath}`);
  }
  await unlink(binPath);
  return true;
};

const main = async () => {
  const parsed = parseArguments(process.argv.slice(2));
  const binDirectory = path.join(parsed.prefix, "bin");
  await mkdir(binDirectory, { mode: 0o755, recursive: true });
  const binPath = path.join(binDirectory, "kurobara");
  let removed = false;
  if (parsed.command === "install") {
    await install(binPath);
  } else {
    removed = await uninstall(binPath);
  }
  process.stdout.write(
    `${JSON.stringify({
      command: parsed.command,
      installed: parsed.command === "install",
      path: binPath,
      removed,
      source_preview: true,
    })}\n`
  );
};

await main();
