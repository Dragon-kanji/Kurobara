import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import architectureConfig from "../../.dependency-cruiser.mjs";

const repositoryRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../.."
);
const depcruise = join(
  repositoryRoot,
  "node_modules/dependency-cruiser/bin/dependency-cruise.mjs"
);
const computedImportCheck = join(
  repositoryRoot,
  "scripts/check-computed-imports.mjs"
);
const fixturesRoot = join(repositoryRoot, "test/architecture/fixtures");

const run = (args) =>
  spawnSync(process.execPath, args, {
    cwd: repositoryRoot,
    encoding: "utf8",
  });

const failures = [];

const dependencyMapMatches = (actual, expected) =>
  JSON.stringify(Object.entries(actual ?? {}).sort()) ===
  JSON.stringify(Object.entries(expected).sort());

const dependencyCases = [
  {
    expectedStatus: 0,
    fixture: "allowed-application-to-kernel",
  },
  {
    expectedStatus: 0,
    fixture: "allowed-plugin-sdk-to-contracts",
  },
  {
    expectedStatus: 0,
    fixture: "allowed-provider-example-to-plugin-sdk",
  },
  {
    expectedStatus: 0,
    fixture: "allowed-plugin-host-to-plugin-sdk",
  },
  {
    expectedStatus: 0,
    fixture: "allowed-plugin-conformance-to-public-plugin-surface",
  },
  {
    expectedRule: "kernel-dependencies",
    fixture: "forbidden-kernel-to-db",
  },
  {
    expectedRule: "ports-dependencies",
    fixture: "forbidden-ports-type-to-application",
  },
  {
    expectedFragments: [
      "apps/worker",
      "packages/adapters/provider",
      "packages/application",
      "packages/kernel",
      "packages/ports",
    ],
    expectedRule: "plugin-sdk-dependencies",
    fixture: "forbidden-plugin-sdk-to-runtime-layers",
  },
  {
    expectedFragments: [
      "apps/worker",
      "packages/adapters/other",
      "packages/application",
      "packages/contracts",
      "packages/kernel",
      "packages/ports",
    ],
    expectedRule: "provider-example-dependencies",
    fixture: "forbidden-provider-example-to-internals",
  },
  {
    expectedFragments: ["→ fs"],
    expectedRule: "provider-example-external-runtime",
    fixture: "forbidden-provider-example-to-node-fs",
  },
  {
    expectedFragments: [
      "apps/worker",
      "packages/adapters/provider",
      "packages/application",
      "packages/contracts",
      "packages/kernel",
      "packages/ports",
    ],
    expectedRule: "plugin-host-dependencies",
    fixture: "forbidden-plugin-host-to-internals",
  },
  {
    expectedFragments: [
      "apps/worker",
      "packages/adapters/provider",
      "packages/application",
      "packages/kernel",
      "packages/ports",
    ],
    expectedRule: "plugin-conformance-dependencies",
    fixture: "forbidden-plugin-conformance-to-internals",
  },
];

for (const testCase of dependencyCases) {
  const fixturePath = join(fixturesRoot, testCase.fixture);
  const result = run([
    depcruise,
    "--config",
    "test/architecture/dependency-cruiser.config.mjs",
    "--include-only",
    `(^${relative(repositoryRoot, fixturePath).replaceAll("\\", "/")}/|^node_modules/|^node:|^fs$)`,
    "--output-type",
    "err-long",
    fixturePath,
  ]);

  if (testCase.expectedStatus === 0 && result.status !== 0) {
    failures.push(
      `${testCase.fixture}: expected success\n${result.stdout}${result.stderr}`
    );
  }
  if (
    testCase.expectedRule &&
    (result.status === 0 ||
      !`${result.stdout}${result.stderr}`.includes(testCase.expectedRule))
  ) {
    failures.push(
      `${testCase.fixture}: expected ${testCase.expectedRule}\n${result.stdout}${result.stderr}`
    );
  }
  for (const fragment of testCase.expectedFragments ?? []) {
    if (!`${result.stdout}${result.stderr}`.includes(fragment)) {
      failures.push(
        `${testCase.fixture}: expected forbidden dependency ${fragment}\n${result.stdout}${result.stderr}`
      );
    }
  }
}

const computedCases = [
  { expectedStatus: 0, fixture: "allowed-literal-dynamic" },
  { expectedStatus: 1, fixture: "forbidden-computed-dynamic" },
  { expectedStatus: 1, fixture: "forbidden-computed-require" },
];

const kernelExternalRule = architectureConfig.forbidden.find(
  (rule) => rule.name === "no-external-runtime-in-packages-kernel"
);
const requiredExternalTypes = ["core", "npm", "npm-optional", "npm-peer"];
if (
  !kernelExternalRule ||
  requiredExternalTypes.some(
    (dependencyType) =>
      !kernelExternalRule.to?.dependencyTypes?.includes(dependencyType)
  )
) {
  failures.push(
    "architecture config: kernel external-runtime rule is missing or incomplete"
  );
}

const providerExamplePackage = JSON.parse(
  readFileSync(
    join(repositoryRoot, "packages/adapters/provider-example/package.json"),
    "utf8"
  )
);
if (
  providerExamplePackage.private !== true ||
  providerExamplePackage.engines?.node !== "24.14.0" ||
  providerExamplePackage.exports?.["."]?.["kurobara-source"] !==
    "./src/index.ts" ||
  providerExamplePackage.exports?.["."]?.types !== "./dist/index.d.ts" ||
  providerExamplePackage.exports?.["."]?.import !== "./dist/index.js" ||
  JSON.stringify(providerExamplePackage.files) !==
    JSON.stringify(["dist", "src"]) ||
  JSON.stringify(providerExamplePackage.dependencies) !==
    JSON.stringify({ "@kurobara/plugin-sdk": "0.1.0" })
) {
  failures.push(
    "provider-example package: expected one source condition, one distributable root and only the versioned plugin SDK at runtime"
  );
}

const pluginHostPackage = JSON.parse(
  readFileSync(
    join(repositoryRoot, "packages/plugin-host/package.json"),
    "utf8"
  )
);
if (
  pluginHostPackage.private !== true ||
  JSON.stringify(pluginHostPackage.dependencies) !==
    JSON.stringify({
      "@kurobara/plugin-sdk": "0.1.0",
      "jsonc-parser": "3.3.1",
    })
) {
  failures.push(
    "plugin-host package: expected a private local host with only the versioned plugin SDK and strict JSON parser at runtime"
  );
}

const pluginConformancePackage = JSON.parse(
  readFileSync(
    join(repositoryRoot, "packages/plugin-conformance/package.json"),
    "utf8"
  )
);
if (
  pluginConformancePackage.version !== "0.1.0" ||
  pluginConformancePackage.private !== true ||
  pluginConformancePackage.engines?.node !== "24.14.0" ||
  pluginConformancePackage.exports?.["."]?.["kurobara-source"]?.types !==
    "./src/index.ts" ||
  pluginConformancePackage.exports?.["."]?.types !== "./dist/index.d.ts" ||
  pluginConformancePackage.exports?.["."]?.import !== "./dist/index.js" ||
  pluginConformancePackage.exports?.["./compatibility-matrix.json"] !==
    "./compatibility-matrix.v1.json" ||
  JSON.stringify(pluginConformancePackage.files) !==
    JSON.stringify(["compatibility-matrix.v1.json", "dist", "src"]) ||
  JSON.stringify(pluginConformancePackage.dependencies) !==
    JSON.stringify({
      "@kurobara/contracts": "0.1.0",
      "@kurobara/plugin-host": "0.1.0",
      "@kurobara/plugin-sdk": "0.1.0",
      ajv: "8.20.0",
    })
) {
  failures.push(
    "plugin-conformance package: expected one local profile artifact, public plugin surfaces and pinned JSON Schema validation only"
  );
}

const providerRelativeRule = architectureConfig.forbidden.find(
  (rule) =>
    rule.name ===
    "no-relative-import-outside-packages-adapters-provider-example"
);
if (!providerRelativeRule) {
  failures.push(
    "architecture config: provider-example cross-workspace relative import rule is missing"
  );
}

const requiredProviderRules = [
  "provider-fixture-dependencies",
  "provider-fixture-external-runtime",
  "provider-hunter-dependencies",
  "provider-hunter-external-runtime",
  "no-relative-import-outside-packages-adapters-provider-fixture",
  "no-relative-import-outside-packages-adapters-provider-hunter",
];
for (const ruleName of requiredProviderRules) {
  if (!architectureConfig.forbidden.some((rule) => rule.name === ruleName)) {
    failures.push(`architecture config: ${ruleName} is missing`);
  }
}

const providerHunterPackage = JSON.parse(
  readFileSync(
    join(repositoryRoot, "packages/adapters/provider-hunter/package.json"),
    "utf8"
  )
);
if (
  !dependencyMapMatches(providerHunterPackage.dependencies, {
    "@kurobara/kernel": "0.1.0",
    "@kurobara/plugin-sdk": "0.1.0",
    "@kurobara/ports": "0.1.0",
  })
) {
  failures.push(
    "provider-hunter package: expected only public plugin and in-process contact port dependencies"
  );
}

const providerFixturePackage = JSON.parse(
  readFileSync(
    join(repositoryRoot, "packages/adapters/provider-fixture/package.json"),
    "utf8"
  )
);
if (
  !dependencyMapMatches(providerFixturePackage.dependencies, {
    "@kurobara/kernel": "0.1.0",
    "@kurobara/ports": "0.1.0",
  })
) {
  failures.push(
    "provider-fixture package: expected only in-process domain and port dependencies"
  );
}

const providerSearchCommonPackage = JSON.parse(
  readFileSync(
    join(
      repositoryRoot,
      "packages/adapters/provider-search-common/package.json"
    ),
    "utf8"
  )
);
if (
  !dependencyMapMatches(providerSearchCommonPackage.dependencies, {
    "@kurobara/plugin-sdk": "0.1.0",
  })
) {
  failures.push(
    "provider-search-common package: expected only the public plugin SDK at runtime"
  );
}

const architectureTypeScript = JSON.parse(
  readFileSync(join(repositoryRoot, "tsconfig.architecture.json"), "utf8")
);
for (const alias of [
  "@kurobara/provider-fixture",
  "@kurobara/provider-hunter",
]) {
  if (!architectureTypeScript.compilerOptions?.paths?.[alias]) {
    failures.push(`architecture TypeScript config: ${alias} path is missing`);
  }
}

for (const testCase of computedCases) {
  const result = run([
    computedImportCheck,
    join(fixturesRoot, testCase.fixture),
  ]);
  if (result.status !== testCase.expectedStatus) {
    failures.push(
      `${testCase.fixture}: expected status ${testCase.expectedStatus}, got ${result.status}\n${result.stdout}${result.stderr}`
    );
  }
}

if (failures.length > 0) {
  console.error(failures.join("\n\n"));
  process.exitCode = 1;
} else {
  console.log(
    `Architecture enforcement: ${dependencyCases.length + computedCases.length + 10} tests passed.`
  );
}
