import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { assertQualifiedRuntime, compile } from "./compiler.mjs";

const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);
const outputRootIndex = process.argv.indexOf("--output-root");
const outputRoot =
  outputRootIndex === -1
    ? packageRoot
    : path.resolve(process.argv[outputRootIndex + 1]);
assertQualifiedRuntime();
const { outputs } = await compile(packageRoot);

for (const [relativeFile, content] of outputs) {
  const target = path.join(outputRoot, relativeFile);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, content, "utf8");
}
