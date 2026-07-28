import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cp,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  canonicalize,
  compile,
  fingerprint,
  fixtureDirectoryFor,
  validate,
} from "../scripts/compiler.mjs";

const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);
const FORBIDDEN_DOMAIN_IMPORT = /@kurobara\/(?:kernel|application)/u;
const CAPABILITY_BOUND_ERROR = /longer than 256/u;
const EXCLUSIVE_OUTPUT_ERROR = /exactly one output_schema_id or output_stream/u;
const OUTPUT_FORMAT_ERROR = /formats must exactly match the input enum/u;
const STREAMED_MCP_ERROR =
  /streamed output requires a deferred MCP projection/u;
const CAPABILITIES_LIST_PROBLEM_CODES = [
  "authentication-required",
  "authority-permission-missing",
  "authority-subject-mismatch",
  "deadline-elapsed",
  "internal-error",
  "invalid-credential",
  "output-contract-violation",
  "request-invalid",
  "service-unavailable",
];
const DATASETS_IMPORT_PROBLEM_CODES = [
  "authentication-required",
  "authority-permission-missing",
  "authority-subject-mismatch",
  "dataset-import-conflict",
  "dataset-import-failed",
  "dataset-source-mismatch",
  "internal-error",
  "invalid-credential",
  "output-contract-violation",
  "payload-too-large",
  "request-invalid",
  "service-unavailable",
  "unsupported-media-type",
];
const DATASETS_EXPORT_PROBLEM_CODES = [
  "authentication-required",
  "authority-permission-missing",
  "export-too-large",
  "idempotency-key-reused",
  "internal-error",
  "invalid-credential",
  "output-contract-violation",
  "payload-too-large",
  "request-invalid",
  "service-unavailable",
  "unsupported-media-type",
];
const ORGANIZATIONS_CANDIDATES_LIST_PROBLEM_CODES = [
  "authentication-required",
  "authority-permission-missing",
  "dataset-generation-not-found",
  "internal-error",
  "invalid-credential",
  "output-contract-violation",
  "request-invalid",
  "service-unavailable",
];
const CONTACTS_CANDIDATES_LIST_PROBLEM_CODES =
  ORGANIZATIONS_CANDIDATES_LIST_PROBLEM_CODES;
const RECIPES_APPLY_PROBLEM_CODES = [
  "authentication-required",
  "authority-capability-missing",
  "authority-permission-missing",
  "authority-subject-mismatch",
  "deadline-elapsed",
  "domain-rejected",
  "idempotency-key-reused",
  "internal-error",
  "invalid-budget",
  "invalid-credential",
  "output-contract-violation",
  "payload-too-large",
  "quote-unit-mismatch",
  "request-invalid",
  "service-unavailable",
  "unsupported-media-type",
  "workspace-mismatch",
];
const RECIPE_APPLICATIONS_GET_PROBLEM_CODES = [
  "authentication-required",
  "authority-permission-missing",
  "internal-error",
  "invalid-credential",
  "output-contract-violation",
  "recipe-application-not-found",
  "request-invalid",
  "service-unavailable",
];
const RECIPE_APPLICATIONS_EXPORT_PROBLEM_CODES = [
  "authentication-required",
  "authority-permission-missing",
  "export-too-large",
  "internal-error",
  "invalid-credential",
  "output-contract-violation",
  "payload-too-large",
  "recipe-application-export-unavailable",
  "recipe-application-not-found",
  "request-invalid",
  "service-unavailable",
  "unsupported-media-type",
];
const PLANS_QUOTE_PROBLEM_CODES = [
  "authentication-required",
  "authority-capability-missing",
  "authority-permission-missing",
  "authority-subject-mismatch",
  "deadline-elapsed",
  "domain-rejected",
  "internal-error",
  "invalid-budget",
  "invalid-credential",
  "output-contract-violation",
  "payload-too-large",
  "quote-unit-mismatch",
  "request-invalid",
  "service-unavailable",
  "unsupported-media-type",
  "workspace-mismatch",
];
const RUN_CREATE_PROBLEM_CODES = [
  "authentication-required",
  "authority-capability-missing",
  "authority-permission-missing",
  "authority-subject-mismatch",
  "deadline-elapsed",
  "domain-rejected",
  "idempotency-key-reused",
  "intention-hash-mismatch",
  "internal-error",
  "invalid-budget",
  "invalid-credential",
  "output-contract-violation",
  "payload-too-large",
  "quote-expired",
  "quote-unit-mismatch",
  "request-invalid",
  "run-plan-already-consumed",
  "run-plan-not-found",
  "service-unavailable",
  "unsupported-media-type",
  "workspace-mismatch",
];
const PRODUCT_SCHEMA_TITLES = [
  "CellResult",
  "Dataset",
  "EnrichmentRecipe",
  "Field",
  "Record",
];
const REQUIRED_SCALAR_VALUE_TYPE =
  /readonly "value": string \| number \| boolean \| null;/u;
const OPTIONAL_SCALAR_VALUE_TYPE =
  /readonly "value"\?: string \| number \| boolean \| null;/u;
const OPTIONAL_NEVER_VALUE_TYPE = /readonly "value"\?: never;/u;
const CONTACT_DEPARTMENT_NULLABLE_TYPE =
  /readonly "department": null \| string;/u;
const COMPANY_EMPLOYEE_COUNT_NULLABLE_TYPE =
  /readonly "employee_count": null \| number;/u;
const NULLABLE_NEXT_AFTER_ORDINAL_TYPE =
  /readonly "next_after_ordinal": number \| null;/u;
const PLUGIN_DIAGNOSTIC_SAFE_TYPE =
  /readonly "diagnostic": \{\n {2}readonly "httpStatus": number;\n {2}readonly "kind": "http-status";/u;
const PLUGIN_OUTPUT_UNKNOWN_TYPE = /readonly "output": unknown;/u;
const PLUGIN_PROVIDER_PAYLOAD_UNKNOWN_TYPE =
  /readonly "providerPayload": unknown;/u;
const DATASET_REFERENCE_TYPE = /readonly "dataset": Dataset;/u;
const FIELD_ARRAY_REFERENCE_TYPE = /readonly "fields": ReadonlyArray<Field>;/u;
const PRODUCT_ID_BOUND_ERROR = /longer than 255/u;
const UNRESOLVED_DATASET_REFERENCE =
  /unresolved https:\/\/schemas\.kurobara\.invalid\/schemas\/product\/dataset\/1\.0\.0/u;
const generatedTypeBlock = (source, title) => {
  const start = source.indexOf(`export type ${title} =`);
  if (start === -1) {
    return;
  }
  const end = source.indexOf("\n}>;", start);
  return end === -1 ? undefined : source.slice(start, end + 4);
};
const SCHEMA_EXPORTS = [
  {
    load: () =>
      import(
        "@kurobara/contracts/schemas/contact-identity-execution-query.json",
        { with: { type: "json" } }
      ),
    schemaId:
      "https://schemas.kurobara.invalid/schemas/contacts/identity-execution-query/1.0.0",
  },
  {
    load: () =>
      import(
        "@kurobara/contracts/schemas/contact-discovery-execution-query.json",
        { with: { type: "json" } }
      ),
    schemaId:
      "https://schemas.kurobara.invalid/schemas/contacts/discovery-execution-query/1.0.0",
  },
  {
    load: () =>
      import(
        "@kurobara/contracts/schemas/contact-work-email-execution-query.json",
        { with: { type: "json" } }
      ),
    schemaId:
      "https://schemas.kurobara.invalid/schemas/contacts/work-email-execution-query/1.0.0",
  },
  {
    load: () =>
      import("@kurobara/contracts/schemas/cell-result.json", {
        with: { type: "json" },
      }),
    schemaId:
      "https://schemas.kurobara.invalid/schemas/product/cell-result/1.0.0",
  },
  {
    load: () =>
      import("@kurobara/contracts/schemas/dataset.json", {
        with: { type: "json" },
      }),
    schemaId: "https://schemas.kurobara.invalid/schemas/product/dataset/1.0.0",
  },
  {
    load: () =>
      import("@kurobara/contracts/schemas/datasets-export-request.json", {
        with: { type: "json" },
      }),
    schemaId:
      "https://schemas.kurobara.invalid/schemas/datasets/export-request/1.0.0",
  },
  {
    load: () =>
      import("@kurobara/contracts/schemas/datasets-import-request.json", {
        with: { type: "json" },
      }),
    schemaId:
      "https://schemas.kurobara.invalid/schemas/datasets/import-request/1.0.0",
  },
  {
    load: () =>
      import("@kurobara/contracts/schemas/datasets-import-response.json", {
        with: { type: "json" },
      }),
    schemaId:
      "https://schemas.kurobara.invalid/schemas/datasets/import-response/1.0.0",
  },
  {
    load: () =>
      import("@kurobara/contracts/schemas/enrichment-recipe.json", {
        with: { type: "json" },
      }),
    schemaId:
      "https://schemas.kurobara.invalid/schemas/product/enrichment-recipe/1.0.0",
  },
  {
    load: () =>
      import("@kurobara/contracts/schemas/field.json", {
        with: { type: "json" },
      }),
    schemaId: "https://schemas.kurobara.invalid/schemas/product/field/1.0.0",
  },
  {
    load: () =>
      import("@kurobara/contracts/schemas/fixtures/deterministic-output.json", {
        with: { type: "json" },
      }),
    schemaId:
      "https://schemas.kurobara.invalid/schemas/fixtures/deterministic-output/1.0.0",
  },
  {
    load: () =>
      import("@kurobara/contracts/schemas/capabilities-list-request.json", {
        with: { type: "json" },
      }),
    schemaId:
      "https://schemas.kurobara.invalid/schemas/capabilities/list-request/1.0.0",
  },
  {
    load: () =>
      import("@kurobara/contracts/schemas/capabilities-list-response.json", {
        with: { type: "json" },
      }),
    schemaId:
      "https://schemas.kurobara.invalid/schemas/capabilities/list-response/1.0.0",
  },
  {
    load: () =>
      import("@kurobara/contracts/schemas/plans-quote-request.json", {
        with: { type: "json" },
      }),
    schemaId:
      "https://schemas.kurobara.invalid/schemas/plans/quote-request/1.0.0",
  },
  {
    load: () =>
      import("@kurobara/contracts/schemas/plans-quote-response.json", {
        with: { type: "json" },
      }),
    schemaId:
      "https://schemas.kurobara.invalid/schemas/plans/quote-response/1.0.0",
  },
  {
    load: () =>
      import(
        "@kurobara/contracts/schemas/contacts-candidates-list-request.json",
        { with: { type: "json" } }
      ),
    schemaId:
      "https://schemas.kurobara.invalid/schemas/contacts/candidates-list-request/1.0.0",
  },
  {
    load: () =>
      import(
        "@kurobara/contracts/schemas/contacts-candidates-list-response.json",
        { with: { type: "json" } }
      ),
    schemaId:
      "https://schemas.kurobara.invalid/schemas/contacts/candidates-list-response/1.0.0",
  },
  {
    load: () =>
      import(
        "@kurobara/contracts/schemas/organizations-candidates-list-request.json",
        { with: { type: "json" } }
      ),
    schemaId:
      "https://schemas.kurobara.invalid/schemas/organizations/candidates-list-request/1.0.0",
  },
  {
    load: () =>
      import(
        "@kurobara/contracts/schemas/organizations-candidates-list-response.json",
        { with: { type: "json" } }
      ),
    schemaId:
      "https://schemas.kurobara.invalid/schemas/organizations/candidates-list-response/1.0.0",
  },
  {
    load: () =>
      import("@kurobara/contracts/schemas/plugin-manifest.json", {
        with: { type: "json" },
      }),
    schemaId: "https://schemas.kurobara.invalid/schemas/plugins/manifest/1.0.0",
  },
  {
    load: () =>
      import("@kurobara/contracts/schemas/plugin-conformance-report.json", {
        with: { type: "json" },
      }),
    schemaId:
      "https://schemas.kurobara.invalid/schemas/plugins/conformance-report/1.0.0",
  },
  {
    load: () =>
      import("@kurobara/contracts/schemas/plugin-protocol-message.json", {
        with: { type: "json" },
      }),
    schemaId:
      "https://schemas.kurobara.invalid/schemas/plugins/protocol-message/1.0.0",
  },
  {
    load: () =>
      import("@kurobara/contracts/schemas/plugin-sidecar-json-rpc-frame.json", {
        with: { type: "json" },
      }),
    schemaId:
      "https://schemas.kurobara.invalid/schemas/plugins/sidecar-json-rpc-frame/1.0.0",
  },
  {
    load: () =>
      import("@kurobara/contracts/schemas/record.json", {
        with: { type: "json" },
      }),
    schemaId: "https://schemas.kurobara.invalid/schemas/product/record/1.0.0",
  },
  {
    load: () =>
      import("@kurobara/contracts/schemas/recipe-cell-input.json", {
        with: { type: "json" },
      }),
    schemaId:
      "https://schemas.kurobara.invalid/schemas/recipes/cell-input/1.0.0",
  },
  {
    load: () =>
      import("@kurobara/contracts/schemas/recipe-cell-output.json", {
        with: { type: "json" },
      }),
    schemaId:
      "https://schemas.kurobara.invalid/schemas/recipes/cell-output/1.0.0",
  },
  {
    load: () =>
      import(
        "@kurobara/contracts/schemas/recipe-applications-export-request.json",
        { with: { type: "json" } }
      ),
    schemaId:
      "https://schemas.kurobara.invalid/schemas/recipe-applications/export-request/1.0.0",
  },
  {
    load: () =>
      import(
        "@kurobara/contracts/schemas/recipe-applications-get-request.json",
        { with: { type: "json" } }
      ),
    schemaId:
      "https://schemas.kurobara.invalid/schemas/recipe-applications/get-request/1.0.0",
  },
  {
    load: () =>
      import(
        "@kurobara/contracts/schemas/recipe-applications-get-response.json",
        { with: { type: "json" } }
      ),
    schemaId:
      "https://schemas.kurobara.invalid/schemas/recipe-applications/get-response/1.0.0",
  },
  {
    load: () =>
      import("@kurobara/contracts/schemas/recipes-apply-request.json", {
        with: { type: "json" },
      }),
    schemaId:
      "https://schemas.kurobara.invalid/schemas/recipes/apply-request/1.0.0",
  },
  {
    load: () =>
      import("@kurobara/contracts/schemas/recipes-apply-response.json", {
        with: { type: "json" },
      }),
    schemaId:
      "https://schemas.kurobara.invalid/schemas/recipes/apply-response/1.0.0",
  },
  {
    load: () =>
      import(
        "@kurobara/contracts/schemas/selected-contact-derived-dataset-request.json",
        { with: { type: "json" } }
      ),
    schemaId:
      "https://schemas.kurobara.invalid/schemas/contacts/selected-contact-derived-dataset-request/1.0.0",
  },
  {
    load: () =>
      import(
        "@kurobara/contracts/schemas/selected-contact-derived-dataset-response.json",
        { with: { type: "json" } }
      ),
    schemaId:
      "https://schemas.kurobara.invalid/schemas/contacts/selected-contact-derived-dataset-response/1.0.0",
  },
  {
    load: () =>
      import(
        "@kurobara/contracts/schemas/export-delivery-revoke-response.json",
        { with: { type: "json" } }
      ),
    schemaId:
      "https://schemas.kurobara.invalid/schemas/export-deliveries/revoke-response/1.0.0",
  },
  {
    load: () =>
      import("@kurobara/contracts/schemas/runs-create-request.json", {
        with: { type: "json" },
      }),
    schemaId:
      "https://schemas.kurobara.invalid/schemas/runs/create-request/1.0.0",
  },
  {
    load: () =>
      import("@kurobara/contracts/schemas/runs-create-response.json", {
        with: { type: "json" },
      }),
    schemaId:
      "https://schemas.kurobara.invalid/schemas/runs/create-response/1.0.0",
  },
  {
    load: () =>
      import("@kurobara/contracts/schemas/runs-get-request.json", {
        with: { type: "json" },
      }),
    schemaId: "https://schemas.kurobara.invalid/schemas/runs/get-request/1.0.0",
  },
  {
    load: () =>
      import("@kurobara/contracts/schemas/runs-get-response.json", {
        with: { type: "json" },
      }),
    schemaId:
      "https://schemas.kurobara.invalid/schemas/runs/get-response/1.0.0",
  },
];

test("exposes only canonical V1 contracts from the package root", async () => {
  const [
    packageRootExports,
    v1,
    packageManifest,
    catalogManifest,
    cli,
    openApiV1,
    mcp,
    problemRegistry,
    contactsCandidatesListOperation,
    organizationsCandidatesListOperation,
  ] = await Promise.all([
    import("@kurobara/contracts"),
    import("@kurobara/contracts/v1"),
    readFile(path.join(packageRoot, "package.json"), "utf8").then(JSON.parse),
    readFile(
      path.join(packageRoot, "catalog/generated/catalog-manifest.json"),
      "utf8"
    ).then(JSON.parse),
    import("@kurobara/contracts/cli-commands.json", {
      with: { type: "json" },
    }).then((module) => module.default),
    readFile(
      path.join(packageRoot, "catalog/generated/openapi-3.1.1.json"),
      "utf8"
    ).then(JSON.parse),
    readFile(
      path.join(packageRoot, "catalog/generated/mcp-tools.json"),
      "utf8"
    ).then(JSON.parse),
    import("@kurobara/contracts/problem-registry.json", {
      with: { type: "json" },
    }).then((module) => module.default),
    import("@kurobara/contracts/operations/contacts-candidates-list.json", {
      with: { type: "json" },
    }).then((module) => module.default),
    import(
      "@kurobara/contracts/operations/organizations-candidates-list.json",
      { with: { type: "json" } }
    ).then((module) => module.default),
  ]);

  for (const canonicalExport of [
    "catalogFingerprint",
    "eventTypes",
    "operationIds",
    "problemCodes",
    "schemaIds",
  ]) {
    assert.deepEqual(packageRootExports[canonicalExport], v1[canonicalExport]);
  }
  assert.equal(packageManifest.exports["."], "./src/generated/v1.ts");
  assert.equal(packageManifest.exports["./v1"], "./src/generated/v1.ts");
  assert.equal(packageManifest.exports["./openapi.json"], undefined);
  assert.equal(
    packageManifest.exports["./problem-registry.json"],
    "./catalog/generated/problem-registry.json"
  );
  assert.equal(
    packageManifest.exports["./cli-commands.json"],
    "./catalog/generated/cli-commands.json"
  );
  assert.equal(
    packageManifest.exports["./operations/recipe-applications-export.json"],
    "./catalog/operations/recipe-applications.export/1.0.0.operation.json"
  );
  assert.equal(
    packageManifest.exports["./operations/recipe-applications-get.json"],
    "./catalog/operations/recipe-applications.get/1.0.0.operation.json"
  );
  assert.equal(
    packageManifest.exports["./operations/recipes-apply.json"],
    "./catalog/operations/recipes.apply/1.0.0.operation.json"
  );
  assert.equal(
    packageManifest.exports["./operations/contacts-identity-reveal.json"],
    "./catalog/operations/contacts.identity.reveal/1.0.0.operation.json"
  );
  assert.equal(
    packageManifest.exports["./operations/datasets-export.json"],
    "./catalog/operations/datasets.export/1.0.0.operation.json"
  );
  assert.equal(
    packageManifest.exports["./operations/contacts-candidates-list.json"],
    "./catalog/operations/contacts.candidates.list/1.0.0.operation.json"
  );
  assert.equal(
    packageManifest.exports["./operations/organizations-candidates-list.json"],
    "./catalog/operations/organizations.candidates.list/1.0.0.operation.json"
  );
  assert.equal(
    packageManifest.exports["./operations/runs-cancel.json"],
    "./catalog/operations/runs.cancel/1.0.0.operation.json"
  );
  assert.equal(
    packageManifest.exports["./schemas/recipe-cell-input.json"],
    "./catalog/schemas/recipes/cell-input/1.0.0.schema.json"
  );
  assert.equal(
    packageManifest.exports["./schemas/recipe-cell-output.json"],
    "./catalog/schemas/recipes/cell-output/1.0.0.schema.json"
  );
  assert.equal(
    packageManifest.exports["./schemas/runs-cancel-request.json"],
    "./catalog/schemas/runs/cancel-request/1.0.0.schema.json"
  );
  assert.equal(
    packageManifest.exports["./schemas/runs-cancel-response.json"],
    "./catalog/schemas/runs/cancel-response/1.0.0.schema.json"
  );
  assert.equal(
    packageManifest.exports["./schemas/plugin-protocol-message.json"],
    "./catalog/schemas/plugins/protocol-message/1.0.0.schema.json"
  );
  assert.equal(
    packageManifest.exports["./schemas/plugin-conformance-report.json"],
    "./catalog/schemas/plugins/conformance-report/1.0.0.schema.json"
  );
  assert.equal(
    packageManifest.exports["./schemas/plugin-sidecar-json-rpc-frame.json"],
    "./catalog/schemas/plugins/sidecar-json-rpc-frame/1.0.0.schema.json"
  );
  assert.equal(
    packageManifest.exports["./schemas/contact-discovery-execution-query.json"],
    "./catalog/schemas/contacts/discovery-execution-query/1.0.0.schema.json"
  );
  assert.equal(
    packageManifest.exports["./schemas/contact-identity-execution-query.json"],
    "./catalog/schemas/contacts/identity-execution-query/1.0.0.schema.json"
  );
  assert.equal(
    packageManifest.exports[
      "./schemas/contact-work-email-execution-query.json"
    ],
    "./catalog/schemas/contacts/work-email-execution-query/1.0.0.schema.json"
  );
  assert.equal(
    packageManifest.exports[
      "./schemas/selected-contact-derived-dataset-request.json"
    ],
    "./catalog/schemas/contacts/selected-contact-derived-dataset-request/1.0.0.schema.json"
  );
  assert.equal(
    packageManifest.exports[
      "./schemas/selected-contact-derived-dataset-response.json"
    ],
    "./catalog/schemas/contacts/selected-contact-derived-dataset-response/1.0.0.schema.json"
  );
  assert.equal(
    packageManifest.exports["./schemas/datasets-export-request.json"],
    "./catalog/schemas/datasets/export-request/1.0.0.schema.json"
  );
  assert.equal(
    packageManifest.exports["./schemas/contacts-candidates-list-request.json"],
    "./catalog/schemas/contacts/candidates-list-request/1.0.0.schema.json"
  );
  assert.equal(
    packageManifest.exports["./schemas/contacts-candidates-list-response.json"],
    "./catalog/schemas/contacts/candidates-list-response/1.0.0.schema.json"
  );
  assert.equal(
    packageManifest.exports[
      "./schemas/organizations-candidates-list-request.json"
    ],
    "./catalog/schemas/organizations/candidates-list-request/1.0.0.schema.json"
  );
  assert.equal(
    packageManifest.exports[
      "./schemas/organizations-candidates-list-response.json"
    ],
    "./catalog/schemas/organizations/candidates-list-response/1.0.0.schema.json"
  );
  assert.equal(catalogManifest.catalog_version, "0.12.0");
  assert.equal(catalogManifest.members.length, 121);
  assert.deepEqual(
    Object.fromEntries(
      [...Map.groupBy(catalogManifest.members, (member) => member.role)].map(
        ([role, members]) => [role, members.length]
      )
    ),
    {
      event: 1,
      schema: 63,
      operation: 22,
      problem: 32,
      "projection-rule": 3,
    }
  );
  assert.equal(
    contactsCandidatesListOperation.operation_id,
    "contacts.candidates.list"
  );
  assert.equal(
    organizationsCandidatesListOperation.operation_id,
    "organizations.candidates.list"
  );
  assert.equal(v1.catalogFingerprint, catalogManifest.catalog_fingerprint);
  assert.equal(openApiV1.openapi, "3.1.1");
  assert.equal(
    v1.catalogFingerprint,
    openApiV1["x-kurobara-catalog-fingerprint"]
  );
  assert.equal(v1.catalogFingerprint, mcp.source_catalog_fingerprint);
  assert.equal(
    v1.catalogFingerprint,
    problemRegistry.source_catalog_fingerprint
  );
  assert.deepEqual(
    Object.values(v1.operationIds).sort(),
    cli.commands.map((command) => command.operation_id).sort()
  );
  assert.deepEqual(
    mcp.tools.map((tool) => tool.operation_id).sort(),
    Object.values(v1.operationIds)
      .filter(
        (operationId) =>
          operationId !== "dataset-generations.cancel" &&
          operationId !== "dataset-generations.get" &&
          operationId !== "datasets.import" &&
          operationId !== "contact-privacy.restrict" &&
          operationId !== "contacts.candidates.list" &&
          operationId !== "contacts.discover" &&
          operationId !== "contacts.identity.reveal" &&
          operationId !== "contacts.work-email.resolve" &&
          operationId !== "contacts.work-email.verify" &&
          operationId !== "datasets.export" &&
          operationId !== "export-deliveries.get" &&
          operationId !== "export-deliveries.revoke" &&
          operationId !== "organizations.candidates.list" &&
          operationId !== "organizations.discover" &&
          operationId !== "recipe-applications.export" &&
          operationId !== "recipe-applications.get" &&
          operationId !== "recipes.apply"
      )
      .sort()
  );
  assert.deepEqual(
    Object.values(v1.schemaIds).sort(),
    catalogManifest.members
      .filter((member) => member.role === "schema")
      .map((member) => member.id)
      .sort()
  );
  assert.deepEqual(
    Object.values(v1.eventTypes),
    openApiV1["x-kurobara-event-types"]
  );
  assert.deepEqual(
    Object.values(v1.problemCodes).sort(),
    catalogManifest.members
      .filter((member) => member.role === "problem")
      .map((member) => member.id.split(":")[1])
      .sort()
  );
});

test("validates every positive fixture and rejects every negative fixture", async () => {
  const { catalog } = await compile(packageRoot);
  const schemasById = new Map(
    catalog.schemas.map(({ document }) => [document.$id, document])
  );
  for (const { document: schema } of catalog.schemas) {
    const fixtureRoot = path.join(
      packageRoot,
      "catalog/fixtures",
      fixtureDirectoryFor(schema)
    );
    const validFiles = (await readdir(path.join(fixtureRoot, "valid"))).sort();
    const invalidFiles = (
      await readdir(path.join(fixtureRoot, "invalid"))
    ).sort();
    assert.ok(validFiles.length > 0, `${schema.title} needs a valid fixture`);
    assert.ok(
      invalidFiles.length > 0,
      `${schema.title} needs an invalid fixture`
    );
    for (const file of validFiles) {
      const fixture = JSON.parse(
        await readFile(path.join(fixtureRoot, "valid", file), "utf8")
      );
      assert.deepEqual(
        validate(schema, fixture, schema, "$", schemasById),
        [],
        `${schema.title}/${file} should be valid`
      );
    }
    for (const file of invalidFiles) {
      const fixture = JSON.parse(
        await readFile(path.join(fixtureRoot, "invalid", file), "utf8")
      );
      assert.notDeepEqual(
        validate(schema, fixture, schema, "$", schemasById),
        [],
        `${schema.title}/${file} should be invalid`
      );
    }
  }
});

test("keeps company candidate results ready-only, bounded, and provider-neutral", async () => {
  const { catalog, outputs } = await compile(packageRoot);
  const request = catalog.schemas.find(
    ({ document }) => document.title === "OrganizationsCandidatesListRequest"
  )?.document;
  const response = catalog.schemas.find(
    ({ document }) => document.title === "OrganizationsCandidatesListResponse"
  )?.document;
  assert.ok(request);
  assert.ok(response);

  assert.equal(request.additionalProperties, false);
  assert.deepEqual(request.required, ["generation_id", "limit"]);
  assert.equal(request.properties.generation_id.maxLength, 255);
  assert.equal(request.properties.after_ordinal.minimum, 0);
  assert.equal(
    request.properties.after_ordinal.maximum,
    Number.MAX_SAFE_INTEGER
  );
  assert.deepEqual(
    [request.properties.limit.minimum, request.properties.limit.maximum],
    [1, 100]
  );

  assert.equal(response.additionalProperties, false);
  assert.deepEqual(response.required, [
    "workspace_id",
    "generation_id",
    "dataset_id",
    "record_count",
    "provenance",
    "page",
    "items",
  ]);
  assert.equal(response.properties.items.maxItems, 100);
  assert.equal(
    response.properties.items.items.properties.candidate.$ref,
    "https://schemas.kurobara.invalid/schemas/organizations/company-candidate/1.0.0"
  );
  assert.deepEqual(
    response.properties.provenance.properties.coverage.properties.basis,
    { const: "locked_provider_route", type: "string" }
  );
  assert.deepEqual(
    response.properties.provenance.properties.coverage.properties.status.enum,
    ["bounded", "complete_for_declared_source"]
  );
  assert.deepEqual(
    response.properties.provenance.properties.completion_reason.enum,
    ["caps-reached", "source-completed"]
  );
  assert.match(
    outputs.get("src/generated/v1.ts"),
    NULLABLE_NEXT_AFTER_ORDINAL_TYPE
  );

  const collectPropertyNames = (schema) => [
    ...Object.entries(schema.properties ?? {}).flatMap(([name, child]) => [
      name,
      ...collectPropertyNames(child),
    ]),
    ...(schema.items ? collectPropertyNames(schema.items) : []),
    ...(schema.oneOf ?? []).flatMap(collectPropertyNames),
  ];
  const forbiddenPrivateLineageFields = new Set([
    "attempt_id",
    "cost_id",
    "provider_cursor",
    "provider_key",
    "provider_route_id",
    "route_id",
    "run_id",
  ]);
  assert.deepEqual(
    collectPropertyNames(response).filter((name) =>
      forbiddenPrivateLineageFields.has(name)
    ),
    []
  );
});

test("validates null schemas without accepting another oneOf branch", () => {
  assert.deepEqual(validate({ type: "null" }, null), []);
  for (const value of ["value", 0, false, [], {}]) {
    assert.notDeepEqual(validate({ type: "null" }, value), []);
  }
  const nullableString = {
    oneOf: [{ type: "string" }, { type: "null" }],
  };
  assert.deepEqual(validate(nullableString, "value"), []);
  assert.deepEqual(validate(nullableString, null), []);
  assert.notDeepEqual(validate(nullableString, 1), []);
});

test("renders nullable contact and company candidate fields as concrete unions", async () => {
  const { outputs } = await compile(packageRoot);
  const generatedTypes = outputs.get("src/generated/v1.ts");
  const contactCandidateType = generatedTypeBlock(
    generatedTypes,
    "ContactCandidate"
  );
  const companyCandidateType = generatedTypeBlock(
    generatedTypes,
    "CompanyCandidate"
  );
  assert.ok(contactCandidateType);
  assert.ok(companyCandidateType);
  for (const field of [
    "department",
    "display_name",
    "identity_completeness",
    "job_title",
    "organization_domain",
    "organization_id",
    "organization_name",
    "person_country_code",
    "seniority",
  ]) {
    assert.doesNotMatch(
      contactCandidateType,
      new RegExp(`readonly "${field}": unknown;`, "u")
    );
  }
  for (const field of [
    "country_code",
    "description",
    "employee_count",
    "industry",
    "name",
  ]) {
    assert.doesNotMatch(
      companyCandidateType,
      new RegExp(`readonly "${field}": unknown;`, "u")
    );
  }
  assert.match(contactCandidateType, CONTACT_DEPARTMENT_NULLABLE_TYPE);
  assert.match(companyCandidateType, COMPANY_EMPLOYEE_COUNT_NULLABLE_TYPE);
});

test("keeps plugin conformance statuses and reason codes correlated", async () => {
  const { catalog } = await compile(packageRoot);
  const schema = catalog.schemas.find(
    ({ document }) => document.title === "PluginConformanceReport"
  )?.document;
  assert.ok(schema);
  const validReport = JSON.parse(
    await readFile(
      path.join(
        packageRoot,
        "catalog/fixtures/plugin-conformance-report/valid/passed.json"
      ),
      "utf8"
    )
  );

  const failedWithoutReason = structuredClone(validReport);
  failedWithoutReason.guarantees[0].status = "failed";
  assert.notDeepEqual(validate(schema, failedWithoutReason), []);

  const notApplicableWithFailure = structuredClone(validReport);
  notApplicableWithFailure.guarantees[0].status = "not-applicable";
  notApplicableWithFailure.guarantees[0].reason_codes = ["behavior-mismatch"];
  assert.notDeepEqual(validate(schema, notApplicableWithFailure), []);

  const passedSummaryWithFailure = structuredClone(validReport);
  passedSummaryWithFailure.summary.failed = 1;
  assert.notDeepEqual(validate(schema, passedSummaryWithFailure), []);
});

test("rejects unresolved cross-document schema references", async () => {
  const { catalog } = await compile(packageRoot);
  const importSchema = catalog.schemas.find(
    ({ document }) => document.title === "DatasetsImportRequest"
  )?.document;
  assert.ok(importSchema);
  const fixture = JSON.parse(
    await readFile(
      path.join(
        packageRoot,
        "catalog/fixtures/datasets-import-request/valid/minimal.json"
      ),
      "utf8"
    )
  );
  assert.match(
    validate(importSchema, fixture).join("\n"),
    UNRESOLVED_DATASET_REFERENCE
  );
});

test("keeps product primitives bounded and linked to the canonical Run", async () => {
  const { catalog, outputs } = await compile(packageRoot);
  const productSchemas = catalog.schemas
    .map(({ document }) => document)
    .filter(({ title }) => PRODUCT_SCHEMA_TITLES.includes(title));
  assert.deepEqual(
    productSchemas.map(({ title }) => title).sort(),
    PRODUCT_SCHEMA_TITLES
  );

  const inspectBounds = (schema, location) => {
    if (schema.type === "object") {
      assert.equal(
        schema.additionalProperties,
        false,
        `${location} must be closed`
      );
    }
    if (schema.type === "array") {
      assert.ok(
        Number.isInteger(schema.maxItems),
        `${location} must bound its item count`
      );
    }
    if (
      (schema.type === "string" || schema.type?.includes?.("string")) &&
      !schema.enum &&
      !Object.hasOwn(schema, "const")
    ) {
      assert.ok(
        Number.isInteger(schema.maxLength),
        `${location} must bound string length`
      );
    }
    if (
      (schema.type === "number" ||
        schema.type === "integer" ||
        schema.type?.includes?.("number") ||
        schema.type?.includes?.("integer")) &&
      !schema.enum &&
      !Object.hasOwn(schema, "const")
    ) {
      assert.ok(
        Number.isFinite(schema.minimum) && Number.isFinite(schema.maximum),
        `${location} must bound numeric values`
      );
    }
    for (const [name, child] of Object.entries(schema.properties ?? {})) {
      inspectBounds(child, `${location}.${name}`);
    }
    if (schema.items) {
      inspectBounds(schema.items, `${location}[]`);
    }
  };

  for (const schema of productSchemas) {
    assert.equal(schema["x-kurobara-schema-version"], "1.0.0");
    inspectBounds(schema, schema.title);
  }

  const assertWhitespaceSemantics = (schema) => {
    for (const [name, child] of Object.entries(schema.properties ?? {})) {
      if (
        child.type === "string" &&
        (name.endsWith("_id") ||
          name.endsWith("_revision") ||
          name === "name" ||
          name === "label" ||
          name === "message")
      ) {
        assert.equal(child.pattern, "\\S", `${name} must reject whitespace`);
      }
      if (
        child.type === "array" &&
        (name.endsWith("_ids") || name === "references")
      ) {
        assert.equal(
          child.items.pattern,
          "\\S",
          `${name} items must reject whitespace`
        );
      }
      assertWhitespaceSemantics(child);
    }
    if (schema.items) {
      assertWhitespaceSemantics(schema.items);
    }
  };
  productSchemas.forEach(assertWhitespaceSemantics);

  const dataset = productSchemas.find(({ title }) => title === "Dataset");
  assert.deepEqual(
    validate(dataset, {
      dataset_id: "🌸".repeat(128),
      name: "Unicode identity",
      workspace_id: "workspace-synthetic",
    }),
    []
  );
  assert.match(
    validate(dataset, {
      dataset_id: "🌸".repeat(256),
      name: "Unicode identity",
      workspace_id: "workspace-synthetic",
    }).join("\n"),
    PRODUCT_ID_BOUND_ERROR
  );

  const forbiddenProductProperties = new Set([
    "llm",
    "model",
    "provider",
    "provider_id",
    "row_id",
  ]);
  const collectPropertyNames = (schema) => [
    ...Object.entries(schema.properties ?? {}).flatMap(([name, child]) => [
      name,
      ...collectPropertyNames(child),
    ]),
    ...(schema.items ? collectPropertyNames(schema.items) : []),
  ];
  assert.deepEqual(
    productSchemas
      .flatMap(collectPropertyNames)
      .filter((name) => forbiddenProductProperties.has(name)),
    []
  );

  const cellResult = productSchemas.find(({ title }) => title === "CellResult");
  const enrichmentRecipe = productSchemas.find(
    ({ title }) => title === "EnrichmentRecipe"
  );
  const record = productSchemas.find(({ title }) => title === "Record");
  assert.ok(enrichmentRecipe.required.includes("recipe_revision"));
  assert.ok(enrichmentRecipe.required.includes("workflow_content_hash"));
  assert.equal(
    enrichmentRecipe.properties.workflow_content_hash.pattern,
    "^sha256:[0-9a-f]{64}$"
  );
  assert.ok(cellResult.required.includes("recipe_revision"));
  assert.deepEqual(
    cellResult.properties.recipe_revision,
    enrichmentRecipe.properties.recipe_revision
  );
  assert.ok(cellResult.required.includes("run_id"));
  assert.equal(cellResult.properties.run, undefined);
  assert.equal(cellResult.properties.value.pattern, undefined);
  assert.equal(
    record.properties.values.items.properties.value.pattern,
    undefined
  );
  assert.equal(cellResult.oneOf.length, 3);
  assert.deepEqual(cellResult.properties.status.enum, [
    "pending",
    "running",
    "succeeded",
    "failed",
    "skipped",
  ]);
  for (const optionalMetadata of [
    "reason",
    "value",
    "provenance",
    "freshness",
    "confidence",
    "cost",
  ]) {
    assert.ok(!cellResult.required.includes(optionalMetadata));
  }

  const generatedTypes = outputs.get("src/generated/v1.ts");
  for (const title of PRODUCT_SCHEMA_TITLES) {
    assert.ok(generatedTypes.includes(`export type ${title} =`));
  }
  const datasetsImportRequestType = generatedTypeBlock(
    generatedTypes,
    "DatasetsImportRequest"
  );
  assert.ok(
    datasetsImportRequestType,
    "DatasetsImportRequest type block must be complete"
  );
  assert.match(datasetsImportRequestType, DATASET_REFERENCE_TYPE);
  assert.match(datasetsImportRequestType, FIELD_ARRAY_REFERENCE_TYPE);
  const recordType = generatedTypeBlock(generatedTypes, "Record");
  const cellResultType = generatedTypeBlock(generatedTypes, "CellResult");
  assert.ok(recordType, "Record type block must be complete");
  assert.ok(cellResultType, "CellResult type block must be complete");
  assert.equal(
    cellResultType.split('readonly "recipe_revision": string;').length - 1,
    3
  );
  assert.match(recordType, REQUIRED_SCALAR_VALUE_TYPE);
  assert.doesNotMatch(recordType, OPTIONAL_SCALAR_VALUE_TYPE);
  assert.match(cellResultType, REQUIRED_SCALAR_VALUE_TYPE);
  assert.doesNotMatch(cellResultType, OPTIONAL_SCALAR_VALUE_TYPE);
  assert.match(cellResultType, OPTIONAL_NEVER_VALUE_TYPE);
});

test("enforces the bounded capability array in the foundation validator", async () => {
  const { catalog } = await compile(packageRoot);
  const schema = catalog.schemas.find(
    ({ document }) => document.title === "CapabilitiesListResponse"
  ).document;
  const capabilities = Array.from({ length: 257 }, (_, index) => ({
    capability_id: `capability.${String(index).padStart(3, "0")}`,
    capability_version: "1.0.0",
  }));

  assert.match(
    validate(schema, {
      authority_envelope_id: "authority-synthetic",
      capabilities,
      workspace_id: "workspace-synthetic",
    }).join("\n"),
    CAPABILITY_BOUND_ERROR
  );
});

test("uses stable RFC 8785 ordering and SHA-256 fingerprints", () => {
  const left = { a: 1, b: 2 };
  const right = { a: 1, b: 2 };
  assert.equal(canonicalize(left), '{"a":1,"b":2}');
  assert.equal(fingerprint(left), fingerprint(right));
  assert.equal(
    fingerprint(left),
    "sha256:43258cff783fe7036d8a43033f830adfc60ec037382473548ac742b888292777"
  );
});

test("generates byte-identical artifacts repeatedly from one catalog", async () => {
  const first = await compile(packageRoot);
  const second = await compile(packageRoot);
  assert.equal(first.catalogFingerprint, second.catalogFingerprint);
  assert.equal(
    first.catalogFingerprint,
    "sha256:c3cb2220664b2b8a0357c2a51c2eb5db398994c746bf89fb23c83398703425f4"
  );
  assert.deepEqual([...first.outputs], [...second.outputs]);
  assert.equal(first.outputs.size, 7);
});

test("binds the deterministic output fixture to its generated canonical fingerprint", async () => {
  const { catalog, outputs } = await compile(packageRoot);
  const schema = catalog.schemas.find(
    ({ document }) => document.title === "DeterministicOutputFixture"
  )?.document;
  assert.ok(schema);
  const manifest = JSON.parse(
    outputs.get("catalog/generated/catalog-manifest.json")
  );
  const member = manifest.members.find(({ id }) => id === schema.$id);
  assert.ok(member);
  assert.equal(member.fingerprint, fingerprint(schema));
  assert.equal(
    member.fingerprint,
    "sha256:02f08ae5cb4775e420fcc1c4ce468943e497ef430da7e03d7be0b6a91e060d8e"
  );
});

test("binds RFC-0011 selected-contact contract fingerprints", async () => {
  const { catalog } = await compile(packageRoot);
  const expected = {
    ContactIdentityExecutionQuery:
      "sha256:0b4882dcaadf1db35718f376da0560d8f86da4a69559db9be00d58dbe60ac675",
    ContactWorkEmailExecutionQuery:
      "sha256:5141da3ba76178fc085d7be62173e7ab21d6cdd020fae7bef15e1e04b08d5750",
    DatasetGenerationPageInput:
      "sha256:40153b13ed33d9bf086dcfde537ce1e17946b0e82b6e0461683c42c24a382a55",
    DatasetGenerationPageOutput:
      "sha256:f61bef0f513210cf17c84fd53aad2c1624a6913a732e98597056a442bc589ab3",
    DatasetsExportRequest:
      "sha256:c297cd92f01686a2aa8fb4f4ec63682638a10e7f9e507b910428377ea23ccd90",
    SelectedContactDerivedDatasetRequest:
      "sha256:b82198ee518929ecce082853f27c83758e8168bb55dba3d233323989d9edb8d6",
    SelectedContactDerivedDatasetResponse:
      "sha256:c5503399a0be0bbf632e4a0d6f8b2939ff883aa44414fb948f2f48330881a681",
  };

  for (const [title, expectedFingerprint] of Object.entries(expected)) {
    const schema = catalog.schemas.find(
      ({ document }) => document.title === title
    )?.document;
    assert.ok(schema, `${title} must remain catalogued`);
    assert.equal(fingerprint(schema), expectedFingerprint);
  }
});

test("marks selected-contact page lineage as capability-bound", async () => {
  const { catalog } = await compile(packageRoot);
  const schema = catalog.schemas.find(
    ({ document }) => document.title === "DatasetGenerationPageOutput"
  )?.document;
  assert.ok(schema);
  const itemProperties = schema.properties.items.items.properties;
  assert.deepEqual(
    itemProperties.source["x-kurobara-required-for-capabilities"],
    [
      "contacts.identity.reveal@1.0.0",
      "contacts.work-email.resolve@1.0.0",
      "contacts.work-email.verify@1.0.0",
    ]
  );
  assert.deepEqual(
    itemProperties.providerIdentity["x-kurobara-admissible-for-capabilities"],
    [
      "contacts.discover@1.0.0",
      "contacts.identity.reveal@1.0.0",
      "contacts.work-email.resolve@1.0.0",
      "contacts.work-email.verify@1.0.0",
    ]
  );
});

test("keeps RFC 9457 problem registry, REST statuses, and MCP codes aligned", async () => {
  const { catalog, outputs } = await compile(packageRoot);
  const problemsByCode = new Map(
    catalog.problems.map(({ document }) => [document.problem_code, document])
  );
  assert.equal(problemsByCode.size, 32);

  const createOperation = catalog.operations.find(
    ({ document }) => document.operation_id === "runs.create"
  ).document;
  const capabilitiesOperation = catalog.operations.find(
    ({ document }) => document.operation_id === "capabilities.list"
  ).document;
  const quoteOperation = catalog.operations.find(
    ({ document }) => document.operation_id === "plans.quote"
  ).document;
  const datasetsImportOperation = catalog.operations.find(
    ({ document }) => document.operation_id === "datasets.import"
  ).document;
  const datasetsExportOperation = catalog.operations.find(
    ({ document }) => document.operation_id === "datasets.export"
  ).document;
  const contactsCandidatesListOperation = catalog.operations.find(
    ({ document }) => document.operation_id === "contacts.candidates.list"
  ).document;
  const organizationsCandidatesListOperation = catalog.operations.find(
    ({ document }) => document.operation_id === "organizations.candidates.list"
  ).document;
  const recipesApplyOperation = catalog.operations.find(
    ({ document }) => document.operation_id === "recipes.apply"
  ).document;
  const recipeApplicationsGetOperation = catalog.operations.find(
    ({ document }) => document.operation_id === "recipe-applications.get"
  ).document;
  const recipeApplicationsExportOperation = catalog.operations.find(
    ({ document }) => document.operation_id === "recipe-applications.export"
  ).document;
  assert.deepEqual(quoteOperation.problem_codes, PLANS_QUOTE_PROBLEM_CODES);
  assert.equal(quoteOperation.idempotence, "not-supported");
  assert.deepEqual(
    capabilitiesOperation.problem_codes,
    CAPABILITIES_LIST_PROBLEM_CODES
  );
  assert.equal(capabilitiesOperation.idempotence, "inherent");
  assert.deepEqual(createOperation.problem_codes, RUN_CREATE_PROBLEM_CODES);
  assert.deepEqual(
    datasetsImportOperation.problem_codes,
    DATASETS_IMPORT_PROBLEM_CODES
  );
  assert.equal(datasetsImportOperation.idempotence, "required");
  assert.deepEqual(
    datasetsExportOperation.problem_codes,
    DATASETS_EXPORT_PROBLEM_CODES
  );
  assert.equal(datasetsExportOperation.kind, "read");
  assert.equal(datasetsExportOperation.idempotence, "inherent");
  assert.deepEqual(datasetsExportOperation.required_permissions, [
    "datasets:export",
  ]);
  assert.equal(datasetsExportOperation.output_schema_id, undefined);
  assert.equal(
    datasetsExportOperation.output_stream.formats.csv.filename,
    "kurobara-dataset.csv"
  );
  assert.equal(
    datasetsExportOperation.output_stream.delivery_tracking,
    "optional-atomic"
  );
  assert.deepEqual(
    contactsCandidatesListOperation.problem_codes,
    CONTACTS_CANDIDATES_LIST_PROBLEM_CODES
  );
  assert.equal(contactsCandidatesListOperation.kind, "read");
  assert.equal(contactsCandidatesListOperation.idempotence, "inherent");
  assert.equal(
    contactsCandidatesListOperation.action_ref,
    "ListContactCandidates"
  );
  assert.deepEqual(contactsCandidatesListOperation.required_permissions, [
    "datasets:read",
  ]);
  assert.deepEqual(contactsCandidatesListOperation.required_capabilities, []);
  assert.equal(
    contactsCandidatesListOperation.projections.sdk_ts.method,
    "contacts.listCandidates"
  );
  assert.equal(
    contactsCandidatesListOperation.projections.mcp.availability,
    "deferred"
  );
  assert.deepEqual(
    organizationsCandidatesListOperation.problem_codes,
    ORGANIZATIONS_CANDIDATES_LIST_PROBLEM_CODES
  );
  assert.equal(organizationsCandidatesListOperation.kind, "read");
  assert.equal(organizationsCandidatesListOperation.idempotence, "inherent");
  assert.equal(
    organizationsCandidatesListOperation.action_ref,
    "ListOrganizationCandidates"
  );
  assert.deepEqual(organizationsCandidatesListOperation.required_permissions, [
    "datasets:read",
  ]);
  assert.deepEqual(
    organizationsCandidatesListOperation.required_capabilities,
    []
  );
  assert.equal(
    organizationsCandidatesListOperation.projections.sdk_ts.method,
    "organizations.listCandidates"
  );
  assert.equal(
    organizationsCandidatesListOperation.projections.mcp.availability,
    "deferred"
  );
  assert.deepEqual(
    recipesApplyOperation.problem_codes,
    RECIPES_APPLY_PROBLEM_CODES
  );
  assert.equal(recipesApplyOperation.idempotence, "required");
  assert.deepEqual(
    recipeApplicationsGetOperation.problem_codes,
    RECIPE_APPLICATIONS_GET_PROBLEM_CODES
  );
  assert.equal(
    recipeApplicationsGetOperation.action_ref,
    "GetRecipeApplicationStatus"
  );
  assert.equal(recipeApplicationsGetOperation.idempotence, "inherent");
  assert.deepEqual(recipeApplicationsGetOperation.required_permissions, [
    "recipes:read",
  ]);
  assert.equal(
    recipeApplicationsGetOperation.projections.mcp.availability,
    "deferred"
  );
  assert.equal(
    Object.hasOwn(recipeApplicationsGetOperation.projections.mcp, "tool"),
    false
  );
  assert.deepEqual(
    recipeApplicationsExportOperation.problem_codes,
    RECIPE_APPLICATIONS_EXPORT_PROBLEM_CODES
  );
  assert.equal(recipeApplicationsExportOperation.kind, "read");
  assert.equal(recipeApplicationsExportOperation.idempotence, "inherent");
  assert.equal(recipeApplicationsExportOperation.output_schema_id, undefined);
  assert.deepEqual(recipeApplicationsExportOperation.output_stream, {
    format_property: "format",
    formats: {
      csv: {
        file_extension: "csv",
        filename: "kurobara-recipe-application.csv",
        media_type: "text/csv",
      },
      jsonl: {
        file_extension: "jsonl",
        filename: "kurobara-recipe-application.jsonl",
        media_type: "application/x-ndjson",
      },
    },
  });
  assert.deepEqual(recipeApplicationsExportOperation.required_permissions, [
    "recipes:export",
  ]);
  assert.equal(
    recipeApplicationsExportOperation.projections.mcp.availability,
    "deferred"
  );
  for (const operation of catalog.operations) {
    for (const code of operation.document.problem_codes) {
      assert.ok(
        problemsByCode.has(code),
        `${operation.document.operation_id} references unknown problem ${code}`
      );
    }
  }

  const openApi = JSON.parse(
    outputs.get("catalog/generated/openapi-3.1.1.json")
  );
  const mcp = JSON.parse(outputs.get("catalog/generated/mcp-tools.json"));
  const cli = JSON.parse(outputs.get("catalog/generated/cli-commands.json"));
  const problemRegistry = JSON.parse(
    outputs.get("catalog/generated/problem-registry.json")
  );
  assert.equal(problemRegistry.publication_status, "local-development-only");
  assert.equal(
    problemRegistry.source_catalog_fingerprint,
    openApi["x-kurobara-catalog-fingerprint"]
  );
  assert.deepEqual(
    problemRegistry.problems,
    [...problemsByCode.values()].map((problem) => ({
      code: problem.problem_code,
      retryable: problem.retryable,
      status: problem.default_status,
      title: problem.title,
      type: problem.type_uri,
    }))
  );
  for (const { document: operation } of catalog.operations) {
    const restProjection = operation.projections.rest;
    const responses =
      openApi.paths[restProjection.path][restProjection.method.toLowerCase()]
        .responses;
    const expectedByStatus = Map.groupBy(operation.problem_codes, (code) =>
      String(problemsByCode.get(code).default_status)
    );
    for (const [status, codes] of expectedByStatus) {
      const response = responses[status];
      assert.deepEqual(response["x-kurobara-problem-codes"], codes);
      assert.ok(response.content["application/problem+json"]);
    }

    const command = cli.commands.find(
      (candidate) => candidate.operation_id === operation.operation_id
    );
    assert.equal(command.success_exit_code, 0);
    assert.deepEqual(
      command.problems,
      operation.problem_codes.map((code) => {
        const problem = problemsByCode.get(code);
        return {
          code,
          exit_code: {
            400: 2,
            401: 3,
            403: 3,
            404: 4,
            405: 2,
            409: 5,
            413: 2,
            415: 2,
            422: 6,
            500: 70,
            503: 75,
          }[problem.default_status],
          retryable: problem.retryable,
          status: problem.default_status,
          type: problem.type_uri,
        };
      })
    );

    const tool = mcp.tools.find(
      (candidate) => candidate.operation_id === operation.operation_id
    );
    if (operation.projections.mcp.availability === "deferred") {
      assert.equal(tool, undefined);
      continue;
    }
    assert.deepEqual(tool.problemCodes, operation.problem_codes);
    assert.deepEqual(
      tool.problems,
      operation.problem_codes.map((code) => {
        const problem = problemsByCode.get(code);
        return {
          code,
          retryable: problem.retryable,
          status: problem.default_status,
          type: problem.type_uri,
        };
      })
    );
  }

  for (const [code, problem] of problemsByCode) {
    assert.equal(problem.type_uri, `https://problems.kurobara.invalid/${code}`);
  }
  assert.equal(problemsByCode.get("service-unavailable").retryable, true);
  assert.equal(problemsByCode.get("internal-error").retryable, false);
  assert.equal(
    problemsByCode.get("recipe-application-not-found").default_status,
    404
  );
  assert.equal(
    problemsByCode.get("recipe-application-not-found").retryable,
    false
  );
});

test("resolves every explicitly exported canonical schema", async () => {
  for (const { load, schemaId } of SCHEMA_EXPORTS) {
    const module = await load();
    assert.equal(module.default.$id, schemaId);
    assert.equal(
      module.default.$schema,
      "https://json-schema.org/draft/2020-12/schema"
    );
  }
});

test("exposes the canonical plugin manifest schema through a typed module", async () => {
  const { pluginManifestSchema } = await import(
    "@kurobara/contracts/plugin-manifest-schema"
  );
  assert.equal(
    pluginManifestSchema.$id,
    "https://schemas.kurobara.invalid/schemas/plugins/manifest/1.0.0"
  );
  assert.equal(pluginManifestSchema.title, "PluginManifest");
});

test("exposes the canonical plugin conformance report through a typed module", async () => {
  const { pluginConformanceReportSchema } = await import(
    "@kurobara/contracts/plugin-conformance-report-schema"
  );
  assert.equal(
    pluginConformanceReportSchema.$id,
    "https://schemas.kurobara.invalid/schemas/plugins/conformance-report/1.0.0"
  );
  assert.equal(pluginConformanceReportSchema.title, "PluginConformanceReport");
  assert.equal(pluginConformanceReportSchema.additionalProperties, false);
  assert.equal(
    pluginConformanceReportSchema["x-kurobara-publication-status"],
    "local-development-only"
  );
  assert.deepEqual(
    pluginConformanceReportSchema.$defs.guarantee.properties.reason_codes.items
      .enum,
    [
      "compatibility-unsupported",
      "contract-rejected",
      "behavior-mismatch",
      "forbidden-observation",
      "profile-not-applicable",
    ]
  );
});

test("exposes the canonical plugin protocol schema through a typed module", async () => {
  const { pluginProtocolMessageSchema } = await import(
    "@kurobara/contracts/plugin-protocol-message-schema"
  );
  assert.equal(
    pluginProtocolMessageSchema.$id,
    "https://schemas.kurobara.invalid/schemas/plugins/protocol-message/1.0.0"
  );
  assert.equal(pluginProtocolMessageSchema.title, "PluginProtocolMessage");
  assert.equal(pluginProtocolMessageSchema.oneOf.length, 16);
  assert.equal(
    pluginProtocolMessageSchema["x-kurobara-publication-status"],
    "local-development-only"
  );
});

test("exposes the canonical plugin sidecar frame through a typed module", async () => {
  const { pluginSidecarJsonRpcFrameSchema } = await import(
    "@kurobara/contracts/plugin-sidecar-json-rpc-frame-schema"
  );
  assert.equal(
    pluginSidecarJsonRpcFrameSchema.$id,
    "https://schemas.kurobara.invalid/schemas/plugins/sidecar-json-rpc-frame/1.0.0"
  );
  assert.equal(
    pluginSidecarJsonRpcFrameSchema.title,
    "PluginSidecarJsonRpcFrame"
  );
  assert.equal(pluginSidecarJsonRpcFrameSchema.oneOf.length, 9);
  assert.equal(
    pluginSidecarJsonRpcFrameSchema["x-kurobara-publication-status"],
    "local-development-only"
  );
});

test("generates the complete discriminated plugin protocol union", async () => {
  const { outputs } = await compile(packageRoot);
  const generatedTypes = outputs.get("src/generated/v1.ts");
  const protocolType = generatedTypeBlock(
    generatedTypes,
    "PluginProtocolMessage"
  );
  assert.ok(protocolType, "PluginProtocolMessage type block must be complete");
  assert.equal(
    protocolType.split(
      'readonly "apiVersion": "dev.kurobara.plugin-protocol/v1";'
    ).length - 1,
    16
  );
  assert.equal(
    protocolType.split('readonly "direction": "request";').length - 1,
    8
  );
  assert.equal(
    protocolType.split('readonly "direction": "result";').length - 1,
    8
  );
  for (const method of [
    "describe",
    "validateConfig",
    "estimate",
    "execute",
    "lookup",
    "normalize",
    "health",
    "classifyError",
  ]) {
    assert.equal(
      protocolType.split(`readonly "method": "${method}";`).length - 1,
      2,
      `${method} must expose one request and one result branch`
    );
  }
  assert.match(protocolType, PLUGIN_DIAGNOSTIC_SAFE_TYPE);
  assert.match(protocolType, PLUGIN_PROVIDER_PAYLOAD_UNKNOWN_TYPE);
  assert.match(protocolType, PLUGIN_OUTPUT_UNKNOWN_TYPE);
});

test("generates the closed plugin sidecar request and result frame union", async () => {
  const { outputs } = await compile(packageRoot);
  const generatedTypes = outputs.get("src/generated/v1.ts");
  const frameType = generatedTypeBlock(
    generatedTypes,
    "PluginSidecarJsonRpcFrame"
  );
  assert.ok(frameType, "PluginSidecarJsonRpcFrame type block must be complete");
  assert.equal(frameType.split('readonly "jsonrpc": "2.0";').length - 1, 9);
  assert.equal(frameType.split('readonly "params":').length - 1, 8);
  assert.equal(frameType.split('readonly "result":').length - 1, 1);
  for (const method of [
    "describe",
    "validateConfig",
    "estimate",
    "execute",
    "lookup",
    "normalize",
    "health",
    "classifyError",
  ]) {
    assert.equal(
      frameType.split(`readonly "method": "plugin.${method}";`).length - 1,
      1,
      `${method} must expose exactly one request frame`
    );
  }
});

test("typechecks sidecar ref siblings as outer and inner frame constraints", async () => {
  const { outputs } = await compile(packageRoot);
  const temporaryRoot = await mkdtemp(
    path.join(tmpdir(), "kurobara-sidecar-types-")
  );
  try {
    await writeFile(
      path.join(temporaryRoot, "generated.ts"),
      outputs.get("src/generated/v1.ts"),
      "utf8"
    );
    await writeFile(
      path.join(temporaryRoot, "sidecar-frame.test.ts"),
      `import type { PluginSidecarJsonRpcFrame } from "./generated.ts";

const valid: PluginSidecarJsonRpcFrame = { jsonrpc: "2.0", id: "host-call-1", method: "plugin.describe", params: { apiVersion: "dev.kurobara.plugin-protocol/v1", direction: "request", method: "describe", payload: {} } };

// @ts-expect-error outer and inner methods must match
const mismatchedMethod: PluginSidecarJsonRpcFrame = { jsonrpc: "2.0", id: "host-call-2", method: "plugin.health", params: { apiVersion: "dev.kurobara.plugin-protocol/v1", direction: "request", method: "describe", payload: {} } };

// @ts-expect-error result frames must contain a result-direction message
const mismatchedDirection: PluginSidecarJsonRpcFrame = { jsonrpc: "2.0", id: "host-call-3", result: { apiVersion: "dev.kurobara.plugin-protocol/v1", direction: "request", method: "describe", payload: {} } };

void valid;
void mismatchedMethod;
void mismatchedDirection;
`,
      "utf8"
    );

    const tsc = path.resolve(
      packageRoot,
      "../../node_modules/typescript/bin/tsc"
    );
    const result = spawnSync(
      process.execPath,
      [
        tsc,
        "--allowImportingTsExtensions",
        "--module",
        "ESNext",
        "--moduleResolution",
        "Bundler",
        "--noEmit",
        "--skipLibCheck",
        "--strict",
        "--target",
        "ES2022",
        "sidecar-frame.test.ts",
      ],
      { cwd: temporaryRoot, encoding: "utf8" }
    );
    assert.equal(
      result.status,
      0,
      `Generated sidecar frame types failed their compile-time contract:\n${result.stdout}${result.stderr}`
    );
  } finally {
    await rm(temporaryRoot, { force: true, recursive: true });
  }
});

test("keeps operation, event, and projection identities aligned", async () => {
  const { catalog, outputs } = await compile(packageRoot);
  assert.deepEqual(
    catalog.operations.map(({ document }) => document.operation_id).sort(),
    [
      "capabilities.list",
      "contact-privacy.restrict",
      "contacts.candidates.list",
      "contacts.discover",
      "contacts.identity.reveal",
      "contacts.work-email.resolve",
      "contacts.work-email.verify",
      "dataset-generations.cancel",
      "dataset-generations.get",
      "datasets.export",
      "datasets.import",
      "export-deliveries.get",
      "export-deliveries.revoke",
      "organizations.candidates.list",
      "organizations.discover",
      "plans.quote",
      "recipe-applications.export",
      "recipe-applications.get",
      "recipes.apply",
      "runs.cancel",
      "runs.create",
      "runs.get",
    ]
  );
  assert.equal(
    catalog.events[0].document.event_type,
    "dev.kurobara.run.queued.v1"
  );
  const openApi = JSON.parse(
    outputs.get("catalog/generated/openapi-3.1.1.json")
  );
  assert.equal(openApi.openapi, "3.1.1");
  assert.deepEqual(openApi.components.securitySchemes, {
    bearerAuth: { scheme: "bearer", type: "http" },
  });
  for (const { document: operation } of catalog.operations) {
    assert.equal(operation.auth_profile, "http-bearer");
    const projection = operation.projections.rest;
    assert.deepEqual(
      openApi.paths[projection.path][projection.method.toLowerCase()].security,
      [{ bearerAuth: [] }]
    );
  }
  assert.equal(openApi.paths["/v1/runs"].post.operationId, "runs.create");
  const cancelOperation = openApi.paths["/v1/runs/{run_id}/cancel"].post;
  assert.equal(cancelOperation.operationId, "runs.cancel");
  assert.deepEqual(cancelOperation.parameters, [
    {
      in: "path",
      name: "run_id",
      required: true,
      schema: {
        maxLength: 255,
        minLength: 1,
        pattern: "\\S",
        type: "string",
      },
    },
  ]);
  assert.deepEqual(
    cancelOperation.requestBody.content["application/json"].schema,
    {
      additionalProperties: false,
      properties: {
        idempotency_key: {
          maxLength: 255,
          minLength: 1,
          pattern: "\\S",
          type: "string",
        },
      },
      required: ["idempotency_key"],
      type: "object",
    }
  );
  assert.equal(
    openApi.paths["/v1/recipe-applications"].post.operationId,
    "recipes.apply"
  );
  assert.equal(
    openApi.paths["/v1/recipe-applications"].post["x-kurobara-idempotence"],
    "required"
  );
  assert.equal(
    openApi.paths["/v1/recipe-application-exports"].post.operationId,
    "recipe-applications.export"
  );
  assert.equal(
    openApi.paths["/v1/contact-identity-reveals"].post.operationId,
    "contacts.identity.reveal"
  );
  assert.equal(
    openApi.paths["/v1/contact-identity-reveals"].post.requestBody.content[
      "application/json"
    ].schema.$ref,
    "#/components/schemas/SelectedContactDerivedDatasetRequest"
  );
  assert.equal(
    openApi.paths["/v1/contact-work-email-resolutions"].post.responses["200"]
      .content["application/json"].schema.$ref,
    "#/components/schemas/SelectedContactDerivedDatasetResponse"
  );
  assert.equal(
    openApi.paths["/v1/contact-work-email-verifications"].post.responses["200"]
      .content["application/json"].schema.$ref,
    "#/components/schemas/SelectedContactDerivedDatasetResponse"
  );
  assert.equal(
    openApi.paths["/v1/dataset-exports"].post.operationId,
    "datasets.export"
  );
  const datasetExportSuccess =
    openApi.paths["/v1/dataset-exports"].post.responses["200"];
  assert.deepEqual(datasetExportSuccess["x-kurobara-format-media-types"], {
    csv: "text/csv",
    jsonl: "application/x-ndjson",
  });
  assert.deepEqual(datasetExportSuccess["x-kurobara-atomic-header-groups"], [
    [
      "X-Kurobara-Delivery-ID",
      "X-Kurobara-Delivery-Expires-At-Ms",
      "X-Kurobara-Delivery-State",
    ],
  ]);
  assert.deepEqual(datasetExportSuccess.headers["X-Kurobara-Delivery-State"], {
    required: false,
    schema: {
      enum: ["prepared", "delivered"],
      type: "string",
    },
  });
  const exportSuccess =
    openApi.paths["/v1/recipe-application-exports"].post.responses["200"];
  assert.deepEqual(Object.keys(exportSuccess.content), [
    "text/csv",
    "application/x-ndjson",
  ]);
  assert.deepEqual(exportSuccess.content["text/csv"], {
    schema: { format: "binary", type: "string" },
    "x-kurobara-streaming": true,
  });
  assert.deepEqual(exportSuccess["x-kurobara-format-media-types"], {
    csv: "text/csv",
    jsonl: "application/x-ndjson",
  });
  assert.deepEqual(exportSuccess.headers["Content-Length"], {
    required: true,
    schema: { minimum: 0, type: "integer" },
  });
  assert.deepEqual(exportSuccess.headers["Cache-Control"], {
    required: true,
    schema: { enum: ["private, no-store"], type: "string" },
  });
  assert.deepEqual(exportSuccess.headers["Content-Disposition"], {
    required: true,
    schema: {
      enum: [
        'attachment; filename="kurobara-recipe-application.csv"',
        'attachment; filename="kurobara-recipe-application.jsonl"',
      ],
      type: "string",
    },
  });
  assert.deepEqual(exportSuccess.headers["X-Content-Type-Options"], {
    required: true,
    schema: { enum: ["nosniff"], type: "string" },
  });
  assert.equal(
    openApi.paths["/v1/recipe-application-exports"].post.requestBody.content[
      "application/json"
    ].schema.$ref,
    "#/components/schemas/RecipeApplicationsExportRequest"
  );
  assert.equal(
    openApi.paths["/v1/recipe-applications/{application_id}"].get.operationId,
    "recipe-applications.get"
  );
  assert.deepEqual(
    openApi.paths["/v1/recipe-applications/{application_id}"].get.parameters,
    [
      {
        in: "path",
        name: "application_id",
        required: true,
        schema: {
          maxLength: 255,
          minLength: 1,
          pattern: "\\S",
          type: "string",
        },
      },
    ]
  );
  assert.equal(
    openApi.paths["/v1/dataset-imports"].post.operationId,
    "datasets.import"
  );
  assert.equal(
    openApi.paths["/v1/dataset-imports"].post["x-kurobara-request-transport"],
    "streaming-multipart"
  );
  assert.deepEqual(
    openApi.paths["/v1/dataset-imports"].post.requestBody.content[
      "multipart/form-data"
    ],
    {
      encoding: {
        metadata: { contentType: "application/json" },
        source: {
          contentType: "application/x-ndjson, text/csv",
          "x-kurobara-streaming": true,
        },
      },
      schema: {
        additionalProperties: false,
        properties: {
          metadata: {
            $ref: "#/components/schemas/DatasetsImportRequest",
          },
          source: { format: "binary", type: "string" },
        },
        required: ["metadata", "source"],
        type: "object",
      },
    }
  );
  assert.equal(
    openApi.paths["/v1/capabilities"].get.operationId,
    "capabilities.list"
  );
  assert.deepEqual(openApi.paths["/v1/capabilities"].get.parameters, [
    {
      in: "query",
      name: "authority_envelope_id",
      required: true,
      schema: {
        maxLength: 255,
        minLength: 1,
        type: "string",
      },
    },
  ]);
  assert.equal(
    openApi.paths["/v1/plans"].post["x-kurobara-idempotence"],
    "not-supported"
  );
  const companyResultsOperation =
    openApi.paths["/v1/dataset-generations/{generation_id}/company-candidates"]
      .get;
  const contactResultsOperation =
    openApi.paths["/v1/dataset-generations/{generation_id}/contact-candidates"]
      .get;
  assert.equal(contactResultsOperation.operationId, "contacts.candidates.list");
  assert.equal(contactResultsOperation.requestBody, undefined);
  assert.equal(
    companyResultsOperation.operationId,
    "organizations.candidates.list"
  );
  assert.equal(companyResultsOperation.requestBody, undefined);
  assert.deepEqual(companyResultsOperation.parameters, [
    {
      in: "path",
      name: "generation_id",
      required: true,
      schema: {
        maxLength: 255,
        minLength: 1,
        pattern: "\\S",
        type: "string",
      },
    },
    {
      in: "query",
      name: "after_ordinal",
      required: false,
      schema: {
        maximum: 9_007_199_254_740_991,
        minimum: 0,
        type: "integer",
      },
    },
    {
      in: "query",
      name: "limit",
      required: true,
      schema: { maximum: 100, minimum: 1, type: "integer" },
    },
  ]);
  assert.deepEqual(
    contactResultsOperation.parameters,
    companyResultsOperation.parameters
  );
  assert.equal(openApi.paths["/v1/runs/{run_id}"].get.operationId, "runs.get");
  const mcp = JSON.parse(outputs.get("catalog/generated/mcp-tools.json"));
  assert.deepEqual(
    mcp.tools.map((tool) => tool.name),
    ["list_capabilities", "quote_run", "cancel_run", "create_run", "get_run"]
  );
  assert.equal(
    mcp.tools.find((tool) => tool.operation_id === "datasets.import"),
    undefined
  );
  assert.equal(
    mcp.tools.find((tool) => tool.operation_id === "datasets.export"),
    undefined
  );
  assert.equal(
    mcp.tools.find((tool) => tool.operation_id === "contacts.identity.reveal"),
    undefined
  );
  assert.equal(
    mcp.tools.find(
      (tool) => tool.operation_id === "recipe-applications.export"
    ),
    undefined
  );
  assert.equal(
    mcp.tools.find((tool) => tool.operation_id === "recipe-applications.get"),
    undefined
  );
  assert.equal(
    mcp.tools.find((tool) => tool.operation_id === "recipes.apply"),
    undefined
  );
  assert.equal(
    mcp.tools.find((tool) => tool.name === "create_run").inputSchema.$id,
    "https://schemas.kurobara.invalid/schemas/runs/create-request/1.0.0"
  );
  assert.equal(
    mcp.tools.find((tool) => tool.name === "quote_run").idempotence,
    "not-supported"
  );
  const cli = JSON.parse(outputs.get("catalog/generated/cli-commands.json"));
  assert.equal(cli.schema_version, "1.0.0");
  assert.deepEqual(
    cli.commands.map((command) => command.command),
    [
      "capabilities",
      "contact restrict",
      "contact results",
      "contact search",
      "contact reveal-identity",
      "contact enrich-email",
      "contact verify-email",
      "company cancel",
      "company watch",
      "dataset export",
      "dataset import",
      "dataset export-status",
      "dataset export-revoke",
      "company results",
      "company search",
      "quote",
      "recipe export",
      "recipe watch",
      "recipe apply",
      "run cancel",
      "run create",
      "run get",
    ]
  );
  const importCommand = cli.commands.find(
    (command) => command.operation_id === "datasets.import"
  );
  assert.equal(importCommand.input_mode, "metadata-and-file");
  assert.equal(importCommand.output_mode, "json");
  assert.equal(importCommand.success_exit_code, 0);
  assert.deepEqual(
    importCommand.problems
      .filter(({ code }) => code.startsWith("dataset-"))
      .map(({ code, exit_code: exitCode }) => [code, exitCode]),
    [
      ["dataset-import-conflict", 5],
      ["dataset-import-failed", 6],
      ["dataset-source-mismatch", 6],
    ]
  );
  const datasetExportCommand = cli.commands.find(
    (command) => command.operation_id === "datasets.export"
  );
  assert.equal(datasetExportCommand.command, "dataset export");
  assert.equal(datasetExportCommand.input_mode, "arguments");
  assert.equal(datasetExportCommand.output_mode, "file-and-json-receipt");
  assert.equal(datasetExportCommand.output_schema_id, undefined);
  assert.equal(datasetExportCommand.output_stream.format_property, "format");
  assert.deepEqual(datasetExportCommand.required_permissions, [
    "datasets:export",
  ]);
  const revealIdentityCommand = cli.commands.find(
    (command) => command.operation_id === "contacts.identity.reveal"
  );
  assert.equal(revealIdentityCommand.command, "contact reveal-identity");
  assert.equal(
    revealIdentityCommand.input_schema_id,
    "https://schemas.kurobara.invalid/schemas/contacts/selected-contact-derived-dataset-request/1.0.0"
  );
  assert.equal(
    revealIdentityCommand.output_schema_id,
    "https://schemas.kurobara.invalid/schemas/contacts/selected-contact-derived-dataset-response/1.0.0"
  );
  for (const operationId of [
    "contacts.identity.reveal",
    "contacts.work-email.resolve",
    "contacts.work-email.verify",
  ]) {
    const selectedContactCommand = cli.commands.find(
      (command) => command.operation_id === operationId
    );
    assert.deepEqual(selectedContactCommand.required_permissions, [
      "contacts:enrich",
      "plans:quote",
      "steps:execute",
    ]);
  }
  const applyCommand = cli.commands.find(
    (command) => command.operation_id === "recipes.apply"
  );
  assert.equal(applyCommand.input_mode, "json");
  assert.equal(applyCommand.output_mode, "json");
  assert.equal(applyCommand.success_exit_code, 0);
  assert.deepEqual(applyCommand.required_permissions, [
    "recipes:register",
    "recipes:apply",
    "plans:quote",
  ]);
  const cancelCommand = cli.commands.find(
    (command) => command.operation_id === "runs.cancel"
  );
  assert.equal(cancelCommand.command, "run cancel");
  assert.equal(cancelCommand.idempotence, "required");
  assert.deepEqual(cancelCommand.required_permissions, ["runs:cancel"]);
  const watchCommand = cli.commands.find(
    (command) => command.operation_id === "recipe-applications.get"
  );
  assert.equal(watchCommand.command, "recipe watch");
  assert.equal(watchCommand.input_mode, "json");
  assert.equal(watchCommand.output_mode, "json");
  assert.equal(watchCommand.success_exit_code, 0);
  assert.deepEqual(watchCommand.required_permissions, ["recipes:read"]);
  assert.deepEqual(
    watchCommand.problems
      .filter(({ code }) => code === "recipe-application-not-found")
      .map(({ status, retryable, exit_code: exitCode }) => [
        status,
        retryable,
        exitCode,
      ]),
    [[404, false, 4]]
  );
  const exportCommand = cli.commands.find(
    (command) => command.operation_id === "recipe-applications.export"
  );
  assert.equal(exportCommand.command, "recipe export");
  assert.equal(exportCommand.input_mode, "arguments");
  assert.equal(exportCommand.output_mode, "file-and-json-receipt");
  assert.equal(exportCommand.output_schema_id, undefined);
  assert.equal(exportCommand.output_stream.format_property, "format");
  assert.deepEqual(exportCommand.required_permissions, ["recipes:export"]);
  const companyResultsCommand = cli.commands.find(
    (command) => command.operation_id === "organizations.candidates.list"
  );
  assert.equal(companyResultsCommand.command, "company results");
  assert.equal(companyResultsCommand.input_mode, "arguments");
  assert.equal(companyResultsCommand.output_mode, "json");
  assert.deepEqual(companyResultsCommand.required_permissions, [
    "datasets:read",
  ]);
  const contactResultsCommand = cli.commands.find(
    (command) => command.operation_id === "contacts.candidates.list"
  );
  assert.equal(contactResultsCommand.command, "contact results");
  assert.equal(contactResultsCommand.input_mode, "arguments");
  assert.equal(contactResultsCommand.output_mode, "json");
  assert.deepEqual(contactResultsCommand.required_permissions, [
    "datasets:read",
  ]);
});

test("rejects malformed streamed-output operation descriptors", async () => {
  const temporaryRoot = await mkdtemp(
    path.join(tmpdir(), "kurobara-contract-stream-")
  );
  try {
    await cp(
      path.join(packageRoot, "catalog"),
      path.join(temporaryRoot, "catalog"),
      { recursive: true }
    );
    const operationPath = path.join(
      temporaryRoot,
      "catalog/operations/recipe-applications.export/1.0.0.operation.json"
    );
    const source = JSON.parse(await readFile(operationPath, "utf8"));

    await writeFile(
      operationPath,
      `${JSON.stringify({ ...source, output_schema_id: source.input_schema_id }, null, 2)}\n`
    );
    await assert.rejects(compile(temporaryRoot), EXCLUSIVE_OUTPUT_ERROR);

    const mismatched = structuredClone(source);
    Reflect.deleteProperty(mismatched.output_stream.formats, "jsonl");
    await writeFile(operationPath, `${JSON.stringify(mismatched, null, 2)}\n`);
    await assert.rejects(compile(temporaryRoot), OUTPUT_FORMAT_ERROR);

    const unsafeFilename = structuredClone(source);
    unsafeFilename.output_stream.formats.csv.filename = "../export.csv";
    await writeFile(
      operationPath,
      `${JSON.stringify(unsafeFilename, null, 2)}\n`
    );
    await assert.rejects(compile(temporaryRoot), OUTPUT_FORMAT_ERROR);

    const executableMcp = structuredClone(source);
    executableMcp.projections.mcp = { tool: "export_recipe_application" };
    await writeFile(
      operationPath,
      `${JSON.stringify(executableMcp, null, 2)}\n`
    );
    await assert.rejects(compile(temporaryRoot), STREAMED_MCP_ERROR);
  } finally {
    await rm(temporaryRoot, { force: true, recursive: true });
  }
});

test("does not couple public contracts to internal domain packages", async () => {
  const files = ["src/generated/v1.ts"];
  for (const file of files) {
    const source = await readFile(path.join(packageRoot, file), "utf8");
    assert.doesNotMatch(source, FORBIDDEN_DOMAIN_IMPORT);
  }
});

test("fingerprints generated bytes rather than filesystem metadata", async () => {
  const { outputs } = await compile(packageRoot);
  const generationManifest = JSON.parse(
    outputs.get("catalog/generated/generation-manifest.json")
  );
  for (const output of generationManifest.outputs) {
    const bytes = outputs.get(output.file);
    const actual = `sha256:${createHash("sha256").update(bytes, "utf8").digest("hex")}`;
    assert.equal(actual, output.fingerprint);
  }
});
