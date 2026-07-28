import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

const REMOVE_REFUSAL_PATTERN = /Refusing to remove/u;
const REPLACE_REFUSAL_PATTERN = /Refusing to replace/u;
const repositoryRoot = path.resolve(import.meta.dirname, "../..");
const installer = path.join(repositoryRoot, "scripts", "install-cli.mjs");

const runInstaller = (command, prefix) =>
  spawnSync(process.execPath, [installer, command, "--prefix", prefix], {
    cwd: repositoryRoot,
    encoding: "utf8",
  });

test("installs, runs, upgrades, and uninstalls the source-preview CLI outside checkout", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "kurobara-cli-install-"));
  const prefix = path.join(root, "prefix");
  const first = runInstaller("install", prefix);
  assert.equal(first.status, 0, first.stderr);
  const binPath = path.join(prefix, "bin", "kurobara");
  assert.equal(JSON.parse(first.stdout).path, binPath);

  const commandLookup = spawnSync("sh", ["-c", "command -v kurobara"], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${path.dirname(binPath)}:${process.env.PATH}`,
    },
  });
  assert.equal(commandLookup.status, 0, commandLookup.stderr);
  assert.equal(commandLookup.stdout.trim(), binPath);

  const configRoot = path.join(root, "config");
  const help = spawnSync(binPath, ["--help", "--json"], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      KUROBARA_CONFIG_HOME: configRoot,
      KUROBARA_DATA_HOME: path.join(root, "data"),
      KUROBARA_SECRET_BACKEND: "file",
    },
  });
  assert.equal(help.status, 0, help.stderr);
  assert.equal(JSON.parse(help.stdout).command, "help");

  const installedLauncher = await readFile(binPath, "utf8");
  const upgrade = runInstaller("install", prefix);
  assert.equal(upgrade.status, 0, upgrade.stderr);
  assert.equal(await readFile(binPath, "utf8"), installedLauncher);

  const removed = runInstaller("uninstall", prefix);
  assert.equal(removed.status, 0, removed.stderr);
  assert.equal(JSON.parse(removed.stdout).removed, true);
});

test("never replaces or removes an unrelated executable", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "kurobara-cli-install-"));
  const prefix = path.join(root, "prefix");
  const binPath = path.join(prefix, "bin", "kurobara");
  await mkdir(path.dirname(binPath), { recursive: true });
  await writeFile(binPath, "#!/bin/sh\nexit 0\n", "utf8");
  await chmod(binPath, 0o755);

  const install = runInstaller("install", prefix);
  assert.notEqual(install.status, 0);
  assert.match(install.stderr, REPLACE_REFUSAL_PATTERN);
  assert.equal(await readFile(binPath, "utf8"), "#!/bin/sh\nexit 0\n");

  const uninstall = runInstaller("uninstall", prefix);
  assert.notEqual(uninstall.status, 0);
  assert.match(uninstall.stderr, REMOVE_REFUSAL_PATTERN);
});
