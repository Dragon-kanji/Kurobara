import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { assertQualifiedRuntime, compile } from "./compiler.mjs";

const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);
assertQualifiedRuntime();
const { outputs } = await compile(packageRoot);
const drift = [];

for (const [relativeFile, expected] of outputs) {
  let actual;
  try {
    actual = await readFile(path.join(packageRoot, relativeFile), "utf8");
  } catch {
    drift.push(`${relativeFile}: missing`);
    continue;
  }
  if (actual !== expected) {
    drift.push(`${relativeFile}: differs from canonical sources`);
  }
}

if (drift.length > 0) {
  throw new Error(`Generated contract drift detected:\n${drift.join("\n")}`);
}
