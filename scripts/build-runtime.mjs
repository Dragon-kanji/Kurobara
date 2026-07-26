import { realpathSync } from "node:fs";
import { chmod, copyFile, mkdir, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { build, version as esbuildVersion } from "esbuild";

const REPOSITORY_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);
const REQUIRED_NODE_VERSION = "v24.14.0";
const MIGRATION_FILENAME_PATTERN = /^\d{4}_[a-z0-9_]+\.sql$/u;
const ESM_COMPATIBILITY_PRELUDE = [
  'import { createRequire as __kurobaraCreateRequire } from "node:module";',
  'import { dirname as __kurobaraDirname } from "node:path";',
  'import { fileURLToPath as __kurobaraFileURLToPath } from "node:url";',
  "const require = __kurobaraCreateRequire(import.meta.url);",
  "const __filename = __kurobaraFileURLToPath(import.meta.url);",
  "const __dirname = __kurobaraDirname(__filename);",
].join("\n");
const BUNDLES = Object.freeze([
  {
    addShebang: false,
    executable: true,
    id: "cli",
    source: "packages/cli/src/index.ts",
    sourceManifest: "packages/cli/package.json",
  },
  {
    addShebang: false,
    executable: false,
    id: "api",
    source: "apps/api/src/index.ts",
    sourceManifest: "apps/api/package.json",
  },
  {
    addShebang: false,
    executable: false,
    format: "cjs",
    id: "worker-heartbeat",
    outputFilename: "heartbeat-worker.js",
    source:
      "packages/adapters/orchestration-hatchet/src/runtime-heartbeat-worker.ts",
    sourceManifest: "packages/adapters/orchestration-hatchet/package.json",
  },
  {
    addShebang: false,
    executable: false,
    id: "worker",
    source: "apps/worker/src/index.ts",
    sourceManifest: "apps/worker/package.json",
  },
  {
    addShebang: true,
    executable: true,
    id: "bootstrap-api-key",
    source: "apps/api/src/bootstrap-api-key.ts",
    sourceManifest: "apps/api/package.json",
  },
  {
    addShebang: true,
    executable: true,
    id: "bootstrap-planning",
    source: "apps/api/src/bootstrap-planning.ts",
    sourceManifest: "apps/api/package.json",
  },
]);

export class RuntimeBuildError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
    this.name = "RuntimeBuildError";
  }
}

const assertNodeVersion = () => {
  if (process.version !== REQUIRED_NODE_VERSION) {
    throw new RuntimeBuildError(
      "runtime-node-version-mismatch",
      `Runtime bundles require Node ${REQUIRED_NODE_VERSION.slice(1)}.`
    );
  }
};

const assertAbsoluteOutput = (outputDirectory) => {
  if (
    typeof outputDirectory !== "string" ||
    outputDirectory.length === 0 ||
    !path.isAbsolute(outputDirectory)
  ) {
    throw new RuntimeBuildError(
      "runtime-output-invalid",
      "The runtime output directory must be an absolute path."
    );
  }
  return path.normalize(outputDirectory);
};

const createFreshDirectory = async (outputDirectory) => {
  try {
    await mkdir(outputDirectory);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "EEXIST") {
      throw new RuntimeBuildError(
        "runtime-output-exists",
        "The runtime output directory already exists."
      );
    }
    throw error;
  }
};

const copyRuntimeAssets = async (outputDirectory) => {
  await Promise.all(
    ["LICENSE", "THIRD_PARTY_NOTICES.md"].map((name) =>
      copyFile(
        path.join(REPOSITORY_ROOT, name),
        path.join(outputDirectory, name)
      )
    )
  );

  const sourceMigrations = path.join(
    REPOSITORY_ROOT,
    "packages/adapters/postgres/migrations"
  );
  const outputMigrations = path.join(outputDirectory, "migrations");
  await mkdir(outputMigrations);
  const migrationNames = (await readdir(sourceMigrations))
    .filter((name) => MIGRATION_FILENAME_PATTERN.test(name))
    .sort();
  if (migrationNames.length === 0) {
    throw new RuntimeBuildError(
      "runtime-migrations-missing",
      "No PostgreSQL migration was selected for the runtime bundle."
    );
  }
  await Promise.all(
    migrationNames.map((name) =>
      copyFile(
        path.join(sourceMigrations, name),
        path.join(outputMigrations, name)
      )
    )
  );
  return migrationNames;
};

const bannerFor = (definition, format) => {
  if (format !== "esm") {
    return "";
  }
  if (definition.addShebang) {
    return `#!/usr/bin/env node\n${ESM_COMPATIBILITY_PRELUDE}`;
  }
  return ESM_COMPATIBILITY_PRELUDE;
};

const buildBundle = async (definition, outputDirectory) => {
  const outputFile = path.join(
    outputDirectory,
    "bin",
    definition.outputFilename ?? `${definition.id}.mjs`
  );
  const format = definition.format ?? "esm";
  const result = await build({
    absWorkingDir: REPOSITORY_ROOT,
    banner: {
      js: bannerFor(definition, format),
    },
    bundle: true,
    charset: "utf8",
    conditions: ["kurobara-source"],
    entryPoints: [definition.source],
    format,
    legalComments: "external",
    logLevel: "silent",
    mainFields: ["module", "main"],
    metafile: true,
    outfile: outputFile,
    platform: "node",
    sourcemap: false,
    target: "node24",
    treeShaking: true,
  });
  if (result.warnings.length > 0) {
    throw new RuntimeBuildError(
      "runtime-build-warning",
      `esbuild returned ${result.warnings.length} warning(s) for ${definition.id}.`
    );
  }
  if (definition.executable) {
    await chmod(outputFile, 0o755);
  }
  return {
    executable: definition.executable,
    id: definition.id,
    includedInputs: Object.keys(result.metafile.inputs).sort(),
    outputFile,
    source: definition.source,
    sourceManifest: definition.sourceManifest,
  };
};

export const buildRuntime = async ({ outputDirectory }) => {
  assertNodeVersion();
  const normalizedOutput = assertAbsoluteOutput(outputDirectory);
  await createFreshDirectory(normalizedOutput);
  await mkdir(path.join(normalizedOutput, "bin"));
  await writeFile(
    path.join(normalizedOutput, "bin", "package.json"),
    '{\n  "type": "commonjs"\n}\n',
    "utf8"
  );

  const bundles = [];
  for (const definition of BUNDLES) {
    bundles.push(await buildBundle(definition, normalizedOutput));
  }
  const migrationNames = await copyRuntimeAssets(normalizedOutput);
  return {
    bundles,
    esbuildVersion,
    migrationNames,
    nodeVersion: process.version.slice(1),
    outputDirectory: normalizedOutput,
  };
};

export const parseRuntimeArguments = (arguments_) => {
  if (
    arguments_.length !== 2 ||
    arguments_[0] !== "--output" ||
    arguments_[1] === undefined
  ) {
    throw new RuntimeBuildError(
      "runtime-invocation-invalid",
      "Usage: node scripts/build-runtime.mjs --output /absolute/new-directory"
    );
  }
  return { outputDirectory: arguments_[1] };
};

const isMainModule =
  process.argv[1] !== undefined &&
  realpathSync(process.argv[1]) ===
    realpathSync(fileURLToPath(import.meta.url));

if (isMainModule) {
  buildRuntime(parseRuntimeArguments(process.argv.slice(2)))
    .then((result) => {
      process.stdout.write(
        `${JSON.stringify({
          bundles: result.bundles.map((bundle) => ({
            executable: bundle.executable,
            id: bundle.id,
            included_inputs: bundle.includedInputs,
            output_file: path
              .relative(result.outputDirectory, bundle.outputFile)
              .split(path.sep)
              .join("/"),
            source: bundle.source,
            source_manifest: bundle.sourceManifest,
          })),
          esbuild_version: result.esbuildVersion,
          node_version: result.nodeVersion,
          status: "built",
        })}\n`
      );
    })
    .catch((error) => {
      const code =
        error instanceof RuntimeBuildError
          ? error.code
          : "runtime-build-failed";
      process.stderr.write(`${JSON.stringify({ code, status: "failed" })}\n`);
      process.exitCode = error instanceof RuntimeBuildError ? 2 : 1;
    });
}
