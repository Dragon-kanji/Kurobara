const workspacePath = (workspace) => `(^|/)${workspace}/`;

const INTERNAL_MODULE = "(^|/)(apps|packages)/";
const EXTERNAL_RUNTIME_DEPENDENCIES = [
  "core",
  "npm",
  "npm-bundled",
  "npm-dev",
  "npm-optional",
  "npm-peer",
];

const PROVIDER_EXAMPLE = "packages/adapters/provider-example";
const PROVIDER_SEARCH_COMMON = "packages/adapters/provider-search-common";
const PROVIDER_TAVILY = "packages/adapters/provider-tavily";
const PROVIDER_EXA = "packages/adapters/provider-exa";
const PROVIDER_FIXTURE = "packages/adapters/provider-fixture";
const PROVIDER_HUNTER = "packages/adapters/provider-hunter";
const EFFECT_PLUGIN = "packages/adapters/effect-plugin";
const PLUGIN_CONFORMANCE = "packages/plugin-conformance";
const PLUGIN_HOST = "packages/plugin-host";

const TARGET_WORKSPACES = [
  "apps/api",
  "apps/worker",
  "packages/application",
  EFFECT_PLUGIN,
  PROVIDER_EXA,
  PROVIDER_EXAMPLE,
  PROVIDER_FIXTURE,
  PROVIDER_HUNTER,
  PROVIDER_SEARCH_COMMON,
  PROVIDER_TAVILY,
  "packages/cli",
  "packages/contracts",
  "packages/kernel",
  PLUGIN_CONFORMANCE,
  PLUGIN_HOST,
  "packages/plugin-sdk",
  "packages/policy-engine",
  "packages/ports",
  "packages/sdk-ts",
  "packages/workflow-engine",
];

const OUTBOUND_ADAPTERS = [
  "packages/adapters/dataset-codec",
  "packages/adapters/effect-deterministic",
  "packages/adapters/orchestration-fake",
  "packages/adapters/orchestration-hatchet",
  "packages/adapters/output-json-schema",
  "packages/adapters/postgres",
  "packages/adapters/provider-registry",
  "packages/adapters/system",
];

const boundaryRule = (name, source, allowedTargets, comment) => ({
  comment,
  from: { path: workspacePath(source) },
  name,
  severity: "error",
  to: {
    path: INTERNAL_MODULE,
    pathNot: allowedTargets.map(workspacePath),
  },
});

const noCrossWorkspaceRelativeImportRule = (workspace) => ({
  comment:
    "Cross-workspace imports must use a declared package export; relative paths and source-tree reach-throughs are forbidden.",
  from: { path: workspacePath(workspace) },
  name: `no-relative-import-outside-${workspace.replaceAll("/", "-")}`,
  severity: "error",
  to: {
    dependencyTypes: ["local"],
    dependencyTypesNot: ["aliased"],
    path: INTERNAL_MODULE,
    pathNot: workspacePath(workspace),
  },
});

const pureLayerExternalRule = (workspace) => ({
  comment:
    "Pure layers use language primitives and Kurobara ports only. Any pure third-party exception must be reviewed and encoded explicitly.",
  from: { path: `${workspacePath(workspace)}src/` },
  name: `no-external-runtime-in-${workspace.replaceAll("/", "-")}`,
  severity: "error",
  to: { dependencyTypes: EXTERNAL_RUNTIME_DEPENDENCIES },
});

const layerRules = [
  boundaryRule("kernel-dependencies", "packages/kernel", ["packages/kernel"]),
  boundaryRule("workflow-engine-dependencies", "packages/workflow-engine", [
    "packages/workflow-engine",
    "packages/kernel",
  ]),
  boundaryRule("policy-engine-dependencies", "packages/policy-engine", [
    "packages/policy-engine",
    "packages/kernel",
  ]),
  boundaryRule("ports-dependencies", "packages/ports", [
    "packages/ports",
    "packages/kernel",
  ]),
  boundaryRule("application-dependencies", "packages/application", [
    "packages/application",
    "packages/kernel",
    "packages/workflow-engine",
    "packages/policy-engine",
    "packages/ports",
  ]),
  boundaryRule("contracts-dependencies", "packages/contracts", [
    "packages/contracts",
  ]),
  boundaryRule("sdk-ts-dependencies", "packages/sdk-ts", [
    "packages/sdk-ts",
    "packages/contracts",
  ]),
  boundaryRule("cli-dependencies", "packages/cli", [
    "packages/cli",
    "packages/contracts",
    "packages/sdk-ts",
  ]),
  boundaryRule("plugin-sdk-dependencies", "packages/plugin-sdk", [
    "packages/plugin-sdk",
    "packages/contracts",
  ]),
  boundaryRule("plugin-host-dependencies", PLUGIN_HOST, [
    PLUGIN_HOST,
    "packages/plugin-sdk",
  ]),
  boundaryRule("plugin-conformance-dependencies", PLUGIN_CONFORMANCE, [
    PLUGIN_CONFORMANCE,
    "packages/contracts",
    PLUGIN_HOST,
    "packages/plugin-sdk",
  ]),
  boundaryRule("provider-example-dependencies", PROVIDER_EXAMPLE, [
    PROVIDER_EXAMPLE,
    "packages/plugin-sdk",
  ]),
  boundaryRule("provider-search-common-dependencies", PROVIDER_SEARCH_COMMON, [
    PROVIDER_SEARCH_COMMON,
    "packages/plugin-sdk",
  ]),
  boundaryRule("provider-fixture-dependencies", PROVIDER_FIXTURE, [
    PROVIDER_FIXTURE,
    "packages/kernel",
    "packages/ports",
  ]),
  boundaryRule("provider-hunter-dependencies", PROVIDER_HUNTER, [
    PROVIDER_HUNTER,
    "packages/kernel",
    "packages/plugin-sdk",
    "packages/ports",
  ]),
  boundaryRule("provider-tavily-dependencies", PROVIDER_TAVILY, [
    PROVIDER_TAVILY,
    PROVIDER_SEARCH_COMMON,
    "packages/plugin-sdk",
  ]),
  boundaryRule("provider-exa-dependencies", PROVIDER_EXA, [
    PROVIDER_EXA,
    PROVIDER_SEARCH_COMMON,
    "packages/plugin-sdk",
  ]),
  boundaryRule("effect-plugin-dependencies", EFFECT_PLUGIN, [
    EFFECT_PLUGIN,
    "packages/kernel",
    "packages/plugin-sdk",
    "packages/ports",
  ]),
  boundaryRule("http-adapter-dependencies", "packages/adapters/http", [
    "packages/adapters/http",
    "packages/contracts",
    "packages/application",
    "packages/kernel",
  ]),
  {
    comment:
      "The inbound HTTP adapter may use kernel types for mapping, but it may not take a runtime dependency on the kernel.",
    from: { path: workspacePath("packages/adapters/http") },
    name: "http-adapter-kernel-types-only",
    severity: "error",
    to: {
      dependencyTypesNot: ["type-only"],
      path: workspacePath("packages/kernel"),
    },
  },
  ...OUTBOUND_ADAPTERS.map((adapter) =>
    boundaryRule(`${adapter.replaceAll("/", "-")}-dependencies`, adapter, [
      adapter,
      "packages/ports",
      "packages/kernel",
      ...(adapter === "packages/adapters/provider-registry"
        ? ["packages/contracts"]
        : []),
    ])
  ),
  {
    comment:
      "The synthetic external-style provider may depend only on the public plugin SDK.",
    from: { path: `${workspacePath(PROVIDER_EXAMPLE)}src/` },
    name: "provider-example-external-runtime",
    severity: "error",
    to: {
      dependencyTypes: EXTERNAL_RUNTIME_DEPENDENCIES,
      pathNot: "(^|/)(packages/plugin-sdk|node_modules/@kurobara/plugin-sdk)/",
    },
  },
  {
    comment:
      "Official search adapters may use only the public plugin SDK and language or web platform primitives.",
    from: { path: `${workspacePath(PROVIDER_SEARCH_COMMON)}src/` },
    name: "provider-search-common-external-runtime",
    severity: "error",
    to: {
      dependencyTypes: EXTERNAL_RUNTIME_DEPENDENCIES,
      pathNot: "(^|/)(packages/plugin-sdk|node_modules/@kurobara/plugin-sdk)/",
    },
  },
  {
    comment:
      "The deterministic in-process fixture may use Node core primitives but no third-party runtime package.",
    from: { path: `${workspacePath(PROVIDER_FIXTURE)}src/` },
    name: "provider-fixture-external-runtime",
    severity: "error",
    to: {
      dependencyTypes: [
        "npm",
        "npm-bundled",
        "npm-dev",
        "npm-optional",
        "npm-peer",
      ],
    },
  },
  {
    comment:
      "The admitted Hunter adapter may use only the public plugin SDK and language or web platform primitives outside Kurobara ports.",
    from: { path: `${workspacePath(PROVIDER_HUNTER)}src/` },
    name: "provider-hunter-external-runtime",
    severity: "error",
    to: {
      dependencyTypes: EXTERNAL_RUNTIME_DEPENDENCIES,
      pathNot: "(^|/)(packages/plugin-sdk|node_modules/@kurobara/plugin-sdk)/",
    },
  },
  {
    comment:
      "The local conformance kit may use Node core modules and only the pinned JSON Schema validator outside Kurobara.",
    from: { path: `${workspacePath(PLUGIN_CONFORMANCE)}src/` },
    name: "plugin-conformance-external-runtime",
    severity: "error",
    to: {
      dependencyTypes: [
        "npm",
        "npm-bundled",
        "npm-dev",
        "npm-optional",
        "npm-peer",
      ],
      pathNot: "(^|/)node_modules/ajv/",
    },
  },
  {
    comment:
      "The local plugin host may use Node core modules and only the pinned strict JSON parser outside Kurobara.",
    from: { path: `${workspacePath(PLUGIN_HOST)}src/` },
    name: "plugin-host-external-runtime",
    severity: "error",
    to: {
      dependencyTypes: [
        "npm",
        "npm-bundled",
        "npm-dev",
        "npm-optional",
        "npm-peer",
      ],
      pathNot: "(^|/)node_modules/jsonc-parser/",
    },
  },
  boundaryRule("api-root-dependencies", "apps/api", [
    "apps/api",
    "packages/adapters/http",
    "packages/application",
    ...OUTBOUND_ADAPTERS,
  ]),
  boundaryRule("worker-root-dependencies", "apps/worker", [
    "apps/worker",
    "packages/application",
    "packages/contracts",
    EFFECT_PLUGIN,
    PROVIDER_EXA,
    PROVIDER_HUNTER,
    PROVIDER_SEARCH_COMMON,
    PROVIDER_TAVILY,
    ...OUTBOUND_ADAPTERS,
  ]),
];

const allWorkspaceRoots = [
  ...TARGET_WORKSPACES,
  "packages/adapters/http",
  ...OUTBOUND_ADAPTERS,
];

export default {
  forbidden: [
    {
      comment: "The source dependency graph must remain acyclic.",
      from: {},
      name: "no-circular",
      severity: "error",
      to: { circular: true },
    },
    {
      comment:
        "Every static dependency must resolve with the architecture TypeScript configuration and package exports.",
      from: {},
      name: "not-to-unresolvable",
      severity: "error",
      to: { couldNotResolve: true },
    },
    {
      comment:
        "Runtime npm dependencies must be declared by the closest workspace package.json.",
      from: {},
      name: "no-non-package-json",
      severity: "error",
      to: { dependencyTypes: ["npm-no-pkg", "npm-unknown"] },
    },
    ...layerRules,
    ...allWorkspaceRoots.map(noCrossWorkspaceRelativeImportRule),
    ...[
      "packages/application",
      "packages/contracts",
      "packages/kernel",
      "packages/policy-engine",
      "packages/ports",
      "packages/workflow-engine",
    ].map(pureLayerExternalRule),
    {
      comment:
        "The pure plugin SDK may use only the pinned JSON Schema validator at runtime.",
      from: { path: `${workspacePath("packages/plugin-sdk")}src/` },
      name: "plugin-sdk-external-runtime",
      severity: "error",
      to: {
        dependencyTypes: EXTERNAL_RUNTIME_DEPENDENCIES,
        pathNot: "(^|/)node_modules/ajv/",
      },
    },
    {
      comment:
        "No module outside a composition root may depend on an application or client composition root.",
      from: {
        pathNot: "(^|/)(apps/(api|worker)|packages/cli)/",
      },
      name: "composition-roots-are-leaves",
      severity: "error",
      to: {
        path: "(^|/)(apps/(api|worker)|packages/cli)/",
      },
    },
  ],
  options: {
    combinedDependencies: false,
    doNotFollow: { path: "node_modules" },
    exclude: { path: "(^|/)(coverage|dist|\\.next)/" },
    includeOnly: "^(apps|packages|node_modules)/",
    preserveSymlinks: false,
    reporterOptions: {
      mermaid: { minify: false },
    },
    tsConfig: { fileName: "tsconfig.architecture.json" },
    tsPreCompilationDeps: "specify",
  },
};
