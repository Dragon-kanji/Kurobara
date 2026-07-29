import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

const DIALECT = "https://json-schema.org/draft/2020-12/schema";
const LOCAL_SCHEMA_PREFIX = "https://schemas.kurobara.invalid/schemas/";
const LOCAL_SCHEMA_ID_PATTERN =
  /^https:\/\/schemas\.kurobara\.invalid\/schemas\/[a-z0-9-]+\/[a-z0-9-]+\/[0-9]+\.[0-9]+\.[0-9]+$/u;
const EVENT_TYPE_PATTERN =
  /^dev\.kurobara\.[a-z0-9-]+(?:\.[a-z0-9-]+)+\.v[0-9]+$/u;
const OPERATION_ID_PATTERN = /^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+$/u;
const PROBLEM_CODE_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)+$/u;
const SEMVER_PATTERN = /^[0-9]+\.[0-9]+\.[0-9]+$/u;
const FILE_EXTENSION_PATTERN = /^[a-z0-9]+$/u;
const DOWNLOAD_FILENAME_PATTERN = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/u;
const PROBLEM_SCHEMA_ID =
  "https://schemas.kurobara.invalid/schemas/problems/problem-details/1.0.0";
const CATALOG_VERSION = "0.13.0";
const HTTP_BEARER_AUTH_PROFILE = "http-bearer";
const QUALIFIED_NODE_VERSION = "24.14.0";
const MCP_AVAILABILITIES = new Set(["available", "deferred"]);
const MULTIPART_SOURCE_MEDIA_TYPES = new Set([
  "application/x-ndjson",
  "text/csv",
]);
const OUTPUT_STREAM_MEDIA_TYPES = new Set(["application/x-ndjson", "text/csv"]);
const GENERATOR = Object.freeze({
  name: "@kurobara/contracts-foundation",
  version: "0.1.0",
});

const isObject = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);

export const canonicalize = (value) => {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "string"
  ) {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error("Canonical JSON cannot contain a non-finite number.");
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(",")}]`;
  }
  if (isObject(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`)
      .join(",")}}`;
  }
  throw new Error(`Canonical JSON cannot contain ${typeof value}.`);
};

export const fingerprint = (value) =>
  `sha256:${createHash("sha256").update(canonicalize(value), "utf8").digest("hex")}`;

export const assertQualifiedRuntime = () => {
  if (process.versions.node !== QUALIFIED_NODE_VERSION) {
    throw new Error(
      `Contract generation requires Node ${QUALIFIED_NODE_VERSION}; received ${process.versions.node}.`
    );
  }
};

const walk = async (directory) => {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((left, right) =>
    left.name.localeCompare(right.name, "en")
  )) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walk(absolute)));
    } else if (entry.isFile()) {
      files.push(absolute);
    }
  }
  return files;
};

const readJson = async (file) => JSON.parse(await readFile(file, "utf8"));

const assertSchemaSource = (schema, file) => {
  if (schema.$schema !== DIALECT) {
    throw new Error(`${file}: expected JSON Schema Draft 2020-12.`);
  }
  if (
    typeof schema.$id !== "string" ||
    !schema.$id.startsWith(LOCAL_SCHEMA_PREFIX)
  ) {
    throw new Error(
      `${file}: schema identifiers must use the reserved local .invalid namespace.`
    );
  }
  if (!LOCAL_SCHEMA_ID_PATTERN.test(schema.$id)) {
    throw new Error(`${file}: schema identifier is not canonical.`);
  }
  if (schema["x-kurobara-publication-status"] !== "local-development-only") {
    throw new Error(`${file}: publication gate must remain explicit.`);
  }
  if (schema["x-kurobara-schema-version"] !== schema.$id.split("/").at(-1)) {
    throw new Error(`${file}: schema version and identifier disagree.`);
  }
  if (schema.additionalProperties !== false || schema.type !== "object") {
    throw new Error(`${file}: public root objects must be closed.`);
  }
};

const assertOperationSource = (operation, file) => {
  if (!OPERATION_ID_PATTERN.test(operation.operation_id)) {
    throw new Error(`${file}: operation_id is not canonical.`);
  }
  if (!SEMVER_PATTERN.test(operation.operation_version)) {
    throw new Error(`${file}: operation_version is not canonical SemVer.`);
  }
  if (operation.auth_profile !== HTTP_BEARER_AUTH_PROFILE) {
    throw new Error(
      `${file}: auth_profile must be the canonical ${HTTP_BEARER_AUTH_PROFILE} profile.`
    );
  }
  for (const surface of ["rest", "sdk_ts", "cli", "mcp"]) {
    if (!isObject(operation.projections?.[surface])) {
      throw new Error(`${file}: missing ${surface} projection.`);
    }
  }
  if (
    typeof operation.projections.cli.command !== "string" ||
    operation.projections.cli.command.trim().length === 0
  ) {
    throw new Error(`${file}: CLI command must be non-empty.`);
  }
  const mcpAvailability = operation.projections.mcp.availability ?? "available";
  if (!MCP_AVAILABILITIES.has(mcpAvailability)) {
    throw new Error(`${file}: MCP availability is not supported.`);
  }
  if (
    mcpAvailability === "available" &&
    (typeof operation.projections.mcp.tool !== "string" ||
      operation.projections.mcp.tool.trim().length === 0)
  ) {
    throw new Error(`${file}: an available MCP projection requires a tool.`);
  }
  if (
    mcpAvailability === "deferred" &&
    (Object.hasOwn(operation.projections.mcp, "tool") ||
      typeof operation.projections.mcp.reason !== "string" ||
      operation.projections.mcp.reason.trim().length === 0)
  ) {
    throw new Error(
      `${file}: a deferred MCP projection requires a reason and cannot declare a tool.`
    );
  }
  const hasOutputSchema = typeof operation.output_schema_id === "string";
  const hasOutputStream = isObject(operation.output_stream);
  if (hasOutputSchema === hasOutputStream) {
    throw new Error(
      `${file}: operation must declare exactly one output_schema_id or output_stream.`
    );
  }
  if (hasOutputStream && mcpAvailability !== "deferred") {
    throw new Error(
      `${file}: streamed output requires a deferred MCP projection.`
    );
  }
};

const assertEventSource = (event, file) => {
  if (!SEMVER_PATTERN.test(event.event_version)) {
    throw new Error(`${file}: event_version is not canonical SemVer.`);
  }
  if (!EVENT_TYPE_PATTERN.test(event.event_type)) {
    throw new Error(`${file}: event_type is not canonical.`);
  }
};

const assertProblemSource = (problem, file) => {
  if (!PROBLEM_CODE_PATTERN.test(problem.problem_code)) {
    throw new Error(`${file}: problem_code is not canonical.`);
  }
  if (!SEMVER_PATTERN.test(problem.problem_version)) {
    throw new Error(`${file}: problem_version is not canonical SemVer.`);
  }
  if (
    problem.type_uri !==
    `https://problems.kurobara.invalid/${problem.problem_code}`
  ) {
    throw new Error(`${file}: type_uri must use the reserved local namespace.`);
  }
  if (
    !Number.isInteger(problem.default_status) ||
    problem.default_status < 400 ||
    problem.default_status > 599
  ) {
    throw new Error(`${file}: default_status must be an HTTP error status.`);
  }
  if (
    typeof problem.retryable !== "boolean" ||
    problem.publication_status !== "local-development-only"
  ) {
    throw new Error(
      `${file}: retryability and publication status are required.`
    );
  }
};

const resolveJsonPointer = (root, reference) => {
  if (!reference.startsWith("#/")) {
    return;
  }
  return reference
    .slice(2)
    .split("/")
    .map((part) => part.replaceAll("~1", "/").replaceAll("~0", "~"))
    .reduce((current, part) => current?.[part], root);
};

const resolveSchemaRef = (root, reference, schemaById) => {
  if (reference.startsWith("#/")) {
    return { root, target: resolveJsonPointer(root, reference) };
  }
  const hashIndex = reference.indexOf("#");
  const schemaId = hashIndex === -1 ? reference : reference.slice(0, hashIndex);
  const fragment = hashIndex === -1 ? "" : reference.slice(hashIndex);
  const externalRoot = schemaById?.get(schemaId);
  if (externalRoot === undefined) {
    return;
  }
  if (fragment === "") {
    return { root: externalRoot, target: externalRoot };
  }
  return {
    root: externalRoot,
    target: resolveJsonPointer(externalRoot, fragment),
  };
};

const validateRequiredObjectProperties = (schema, value, location) => {
  const errors = [];
  for (const required of schema.required ?? []) {
    if (!Object.hasOwn(value, required)) {
      errors.push(`${location}.${required}: required property missing`);
    }
  }
  return errors;
};

const validateDependentObjectProperties = (schema, value, location) => {
  const errors = [];
  for (const [trigger, dependents] of Object.entries(
    schema.dependentRequired ?? {}
  )) {
    if (!Object.hasOwn(value, trigger)) {
      continue;
    }
    for (const dependent of dependents) {
      if (!Object.hasOwn(value, dependent)) {
        errors.push(
          `${location}.${dependent}: required when ${trigger} is present`
        );
      }
    }
  }
  return errors;
};

const validateAdditionalObjectProperties = (
  schema,
  value,
  properties,
  location
) => {
  const errors = [];
  if (schema.additionalProperties === false) {
    for (const key of Object.keys(value)) {
      if (!Object.hasOwn(properties, key)) {
        errors.push(`${location}.${key}: unknown property`);
      }
    }
  }
  return errors;
};

const validateDeclaredObjectProperties = (
  properties,
  value,
  root,
  location,
  schemaById
) => {
  const errors = [];
  for (const [key, childSchema] of Object.entries(properties)) {
    if (Object.hasOwn(value, key)) {
      errors.push(
        ...validate(
          childSchema,
          value[key],
          root,
          `${location}.${key}`,
          schemaById
        )
      );
    }
  }
  return errors;
};

const validateObject = (schema, value, root, location, schemaById) => {
  if (!isObject(value)) {
    return [`${location}: expected object`];
  }
  const properties = schema.properties ?? {};
  return [
    ...validateRequiredObjectProperties(schema, value, location),
    ...validateDependentObjectProperties(schema, value, location),
    ...validateAdditionalObjectProperties(schema, value, properties, location),
    ...validateDeclaredObjectProperties(
      properties,
      value,
      root,
      location,
      schemaById
    ),
  ];
};

const codePointLength = (value) => {
  let length = 0;
  for (const _character of value) {
    length += 1;
  }
  return length;
};

const validateString = (schema, value, location) => {
  if (typeof value !== "string") {
    return [`${location}: expected string`];
  }
  const errors = [];
  const length = codePointLength(value);
  if (schema.minLength !== undefined && length < schema.minLength) {
    errors.push(`${location}: shorter than ${schema.minLength}`);
  }
  if (schema.maxLength !== undefined && length > schema.maxLength) {
    errors.push(`${location}: longer than ${schema.maxLength}`);
  }
  if (schema.pattern && !new RegExp(schema.pattern, "u").test(value)) {
    errors.push(`${location}: pattern mismatch`);
  }
  return errors;
};

const validateNumber = (schema, value, location) => {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return [`${location}: expected finite number`];
  }
  if (schema.type === "integer" && !Number.isSafeInteger(value)) {
    return [`${location}: expected safe integer`];
  }
  const errors = [];
  if (schema.minimum !== undefined && value < schema.minimum) {
    errors.push(`${location}: below minimum ${schema.minimum}`);
  }
  if (schema.maximum !== undefined && value > schema.maximum) {
    errors.push(`${location}: above maximum ${schema.maximum}`);
  }
  return errors;
};

const validateArray = (schema, value, root, location, schemaById) => {
  if (!Array.isArray(value)) {
    return [`${location}: expected array`];
  }
  const errors = [];
  if (schema.minItems !== undefined && value.length < schema.minItems) {
    errors.push(`${location}: shorter than ${schema.minItems}`);
  }
  if (schema.maxItems !== undefined && value.length > schema.maxItems) {
    errors.push(`${location}: longer than ${schema.maxItems}`);
  }
  if (
    schema.uniqueItems === true &&
    new Set(value.map((item) => canonicalize(item))).size !== value.length
  ) {
    errors.push(`${location}: duplicate items`);
  }
  return errors.concat(
    value.flatMap((item, index) =>
      validate(schema.items, item, root, `${location}[${index}]`, schemaById)
    )
  );
};

const matchesType = (type, value) => {
  if (type === "null") {
    return value === null;
  }
  if (type === "object") {
    return isObject(value);
  }
  if (type === "array") {
    return Array.isArray(value);
  }
  if (type === "integer") {
    return typeof value === "number" && Number.isSafeInteger(value);
  }
  if (type === "number") {
    return typeof value === "number" && Number.isFinite(value);
  }
  return typeof value === type;
};

const validateOneOf = (schema, value, root, location, schemaById) => {
  if (!Array.isArray(schema.oneOf)) {
    return [];
  }
  const matchingBranches = schema.oneOf.filter(
    (branch) => validate(branch, value, root, location, schemaById).length === 0
  ).length;
  return matchingBranches === 1
    ? []
    : [
        `${location}: expected exactly one oneOf branch, received ${matchingBranches}`,
      ];
};

const validateByType = (schema, value, root, location, schemaById) => {
  if (Array.isArray(schema.type)) {
    const matchingType = schema.type.find((type) => matchesType(type, value));
    return matchingType
      ? validate(
          { ...schema, oneOf: undefined, type: matchingType },
          value,
          root,
          location,
          schemaById
        )
      : [`${location}: expected one of types ${schema.type.join(", ")}`];
  }
  if (schema.type === "object") {
    return validateObject(schema, value, root, location, schemaById);
  }
  if (schema.type === "string") {
    return validateString(schema, value, location);
  }
  if (schema.type === "integer" || schema.type === "number") {
    return validateNumber(schema, value, location);
  }
  if (schema.type === "boolean") {
    return typeof value === "boolean" ? [] : [`${location}: expected boolean`];
  }
  if (schema.type === "null") {
    return value === null ? [] : [`${location}: expected null`];
  }
  if (schema.type === "array") {
    return validateArray(schema, value, root, location, schemaById);
  }
  return [];
};

export const validate = (
  schema,
  value,
  root = schema,
  location = "$",
  schemaById = null
) => {
  if (schema === true) {
    return [];
  }
  if (schema === false) {
    return [`${location}: value is forbidden`];
  }
  if (schema.$ref) {
    const resolved = resolveSchemaRef(root, schema.$ref, schemaById);
    if (!resolved?.target) {
      return [`${location}: unresolved ${schema.$ref}`];
    }
    const { $ref: _reference, ...siblings } = schema;
    return [
      ...validate(resolved.target, value, resolved.root, location, schemaById),
      ...validate(siblings, value, root, location, schemaById),
    ];
  }
  const applicatorErrors = validateOneOf(
    schema,
    value,
    root,
    location,
    schemaById
  );
  if (Object.hasOwn(schema, "const")) {
    return value === schema.const
      ? applicatorErrors
      : [
          ...applicatorErrors,
          `${location}: expected constant ${JSON.stringify(schema.const)}`,
        ];
  }
  if (schema.enum) {
    return schema.enum.includes(value)
      ? applicatorErrors
      : [
          ...applicatorErrors,
          `${location}: expected one of ${schema.enum.join(", ")}`,
        ];
  }
  return [
    ...applicatorErrors,
    ...validateByType(schema, value, root, location, schemaById),
  ];
};

const pascalToKebab = (value) =>
  value.replace(/([a-z0-9])([A-Z])/gu, "$1-$2").toLowerCase();

const typeForReference = (reference, root, schemasById) => {
  const resolved = resolveSchemaRef(root, reference, schemasById);
  if (resolved?.target === undefined) {
    throw new Error(`Cannot render unresolved schema reference ${reference}.`);
  }
  if (!reference.startsWith("#/") && resolved.target === resolved.root) {
    return resolved.root.title;
  }
  return typeForSchema(resolved.target, resolved.root, schemasById);
};

const typeForSchema = (schema, root, schemasById) => {
  if (schema === false) {
    return "never";
  }
  if (schema === true) {
    return "unknown";
  }
  if (schema.$ref) {
    const referenceType = typeForReference(schema.$ref, root, schemasById);
    const { $ref: _reference, ...siblings } = schema;
    const siblingType = typeForSchema(siblings, root, schemasById);
    return siblingType === "unknown"
      ? referenceType
      : `(${referenceType}) & (${siblingType})`;
  }
  if (Object.hasOwn(schema, "const")) {
    return JSON.stringify(schema.const);
  }
  if (schema.enum) {
    return schema.enum.map((item) => JSON.stringify(item)).join(" | ");
  }
  if (Array.isArray(schema.type)) {
    return schema.type
      .map((type) => typeForSchema({ ...schema, type }, root, schemasById))
      .join(" | ");
  }
  if (schema.type === "null") {
    return "null";
  }
  if (schema.type === "string") {
    return "string";
  }
  if (schema.type === "integer" || schema.type === "number") {
    return "number";
  }
  if (schema.type === "boolean") {
    return "boolean";
  }
  if (schema.type === "array") {
    return `ReadonlyArray<${typeForSchema(schema.items, root, schemasById)}>`;
  }
  if (schema.type === "object") {
    const renderObject = (properties, requiredNames) => {
      const required = new Set(requiredNames);
      const fields = Object.entries(properties)
        .sort(([left], [right]) => left.localeCompare(right, "en"))
        .map(
          ([name, child]) =>
            `  readonly ${JSON.stringify(name)}${required.has(name) ? "" : "?"}: ${typeForSchema(child, root, schemasById)};`
        )
        .join("\n");
      return `{\n${fields}\n}`;
    };
    if (Array.isArray(schema.oneOf)) {
      return schema.oneOf
        .map((branch) =>
          renderObject({ ...schema.properties, ...branch.properties }, [
            ...new Set([
              ...(schema.required ?? []),
              ...(branch.required ?? []),
            ]),
          ])
        )
        .join(" | ");
    }
    return renderObject(schema.properties ?? {}, schema.required ?? []);
  }
  if (Array.isArray(schema.oneOf)) {
    return schema.oneOf
      .map((branch) => typeForSchema(branch, root, schemasById))
      .join(" | ");
  }
  return "unknown";
};

const renderTypes = (
  schemas,
  catalogFingerprint,
  operations,
  events,
  problems
) => {
  const schemasById = new Map(
    schemas.map(({ document }) => [document.$id, document])
  );
  const schemaIds = Object.fromEntries(
    schemas.map(({ document }) => [document.title, document.$id])
  );
  const schemaFingerprints = Object.fromEntries(
    schemas.map(({ document }) => [document.title, fingerprint(document)])
  );
  const operationIds = Object.fromEntries(
    operations.map(({ document }) => [
      document.operation_id.replaceAll(".", "_"),
      document.operation_id,
    ])
  );
  const eventTypes = Object.fromEntries(
    events.map(({ document }) => [document.source_fact, document.event_type])
  );
  const problemCodes = Object.fromEntries(
    problems.map(({ document }) => [
      document.problem_code.replaceAll("-", "_"),
      document.problem_code,
    ])
  );
  const aliases = schemas
    .map(
      ({ document }) =>
        `export type ${document.title} = Readonly<${typeForSchema(document, document, schemasById)}>;`
    )
    .join("\n\n");
  return `/**\n * Generated by ${GENERATOR.name}@${GENERATOR.version}.\n * Source catalog: ${catalogFingerprint}\n * Do not edit directly.\n */\n\nexport const catalogFingerprint = ${JSON.stringify(catalogFingerprint)} as const;\nexport const schemaIds = ${JSON.stringify(schemaIds, null, 2)} as const;\nexport const schemaFingerprints = ${JSON.stringify(schemaFingerprints, null, 2)} as const;\nexport const operationIds = ${JSON.stringify(operationIds, null, 2)} as const;\nexport const eventTypes = ${JSON.stringify(eventTypes, null, 2)} as const;\nexport const problemCodes = ${JSON.stringify(problemCodes, null, 2)} as const;\n\n${aliases}\n`;
};

const componentName = (schemaId, schemasById) =>
  schemasById.get(schemaId).title;

const projectOpenApiReference = (reference, schemaTitle, schemasById) => {
  if (reference.startsWith("#/$defs/")) {
    return `#/components/schemas/${schemaTitle}${reference.slice(1)}`;
  }
  if (reference.startsWith("#/")) {
    return reference;
  }
  const hashIndex = reference.indexOf("#");
  const schemaId = hashIndex === -1 ? reference : reference.slice(0, hashIndex);
  const fragment = hashIndex === -1 ? "" : reference.slice(hashIndex + 1);
  const target = schemasById.get(schemaId);
  if (target === undefined) {
    throw new Error(`Cannot project unresolved schema reference ${reference}.`);
  }
  return `#/components/schemas/${target.title}${fragment}`;
};

const openApiSchema = (schema, schemasById) => {
  const clone = structuredClone(schema);
  const visit = (value) => {
    if (Array.isArray(value)) {
      for (const item of value) {
        visit(item);
      }
      return;
    }
    if (!isObject(value)) {
      return;
    }
    if (typeof value.$ref === "string") {
      value.$ref = projectOpenApiReference(
        value.$ref,
        schema.title,
        schemasById
      );
    }
    for (const child of Object.values(value)) {
      visit(child);
    }
  };
  visit(clone);
  return clone;
};

const problemResponsesFor = (operation, problemsByCode) => {
  const groups = new Map();
  for (const code of operation.problem_codes) {
    const problem = problemsByCode.get(code);
    const codes = groups.get(problem.default_status) ?? [];
    codes.push(code);
    groups.set(problem.default_status, codes);
  }
  return Object.fromEntries(
    [...groups.entries()]
      .sort(([left], [right]) => left - right)
      .map(([status, codes]) => [
        String(status),
        {
          content: {
            "application/problem+json": {
              schema: {
                allOf: [
                  { $ref: "#/components/schemas/ProblemDetails" },
                  {
                    properties: {
                      code: { enum: codes, type: "string" },
                      status: { const: status },
                    },
                    required: ["status", "code"],
                    type: "object",
                  },
                ],
              },
            },
          },
          description: `Problem Details: ${codes.join(", ")}.`,
          "x-kurobara-problem-codes": codes,
        },
      ])
  );
};

const multipartRequestBody = (inputName, multipart) => ({
  content: {
    "multipart/form-data": {
      encoding: {
        [multipart.metadata_part]: {
          contentType: "application/json",
        },
        [multipart.source_part]: {
          contentType: multipart.source_media_types.join(", "),
          "x-kurobara-streaming": true,
        },
      },
      schema: {
        additionalProperties: false,
        properties: {
          [multipart.metadata_part]: {
            $ref: `#/components/schemas/${inputName}`,
          },
          [multipart.source_part]: {
            format: "binary",
            type: "string",
          },
        },
        required: [multipart.metadata_part, multipart.source_part],
        type: "object",
      },
    },
  },
  required: true,
});

const optionalDeliveryTrackingHeaders = (outputStream) =>
  outputStream.delivery_tracking === "optional-atomic"
    ? {
        "X-Kurobara-Delivery-Expires-At-Ms": {
          required: false,
          schema: {
            maximum: Number.MAX_SAFE_INTEGER,
            minimum: 0,
            type: "integer",
          },
        },
        "X-Kurobara-Delivery-ID": {
          required: false,
          schema: {
            maxLength: 255,
            minLength: 1,
            pattern: "\\S",
            type: "string",
          },
        },
        "X-Kurobara-Delivery-State": {
          required: false,
          schema: {
            enum: ["prepared", "delivered"],
            type: "string",
          },
        },
      }
    : {};

const streamingSuccessResponse = (outputStream) => ({
  content: Object.fromEntries(
    Object.values(outputStream.formats).map(({ media_type: mediaType }) => [
      mediaType,
      {
        schema: { format: "binary", type: "string" },
        "x-kurobara-streaming": true,
      },
    ])
  ),
  description: "Contractually valid streamed result.",
  headers: {
    "Cache-Control": {
      required: true,
      schema: { enum: ["private, no-store"], type: "string" },
    },
    "Content-Disposition": {
      required: true,
      schema: {
        enum: Object.values(outputStream.formats).map(
          ({ filename }) => `attachment; filename="${filename}"`
        ),
        type: "string",
      },
    },
    "Content-Length": {
      required: true,
      schema: { minimum: 0, type: "integer" },
    },
    "X-Content-Type-Options": {
      required: true,
      schema: { enum: ["nosniff"], type: "string" },
    },
    "X-Kurobara-Content-SHA256": {
      required: true,
      schema: {
        pattern: "^sha256:[0-9a-f]{64}$",
        type: "string",
      },
    },
    ...optionalDeliveryTrackingHeaders(outputStream),
  },
  ...(outputStream.delivery_tracking === "optional-atomic"
    ? {
        "x-kurobara-atomic-header-groups": [
          [
            "X-Kurobara-Delivery-ID",
            "X-Kurobara-Delivery-Expires-At-Ms",
            "X-Kurobara-Delivery-State",
          ],
        ],
      }
    : {}),
  "x-kurobara-format-media-types": Object.fromEntries(
    Object.entries(outputStream.formats).map(([format, descriptor]) => [
      format,
      descriptor.media_type,
    ])
  ),
});

const renderOpenApi = (
  schemas,
  operations,
  events,
  problems,
  catalogFingerprint
) => {
  const schemasById = new Map(
    schemas.map(({ document }) => [document.$id, document])
  );
  const problemsByCode = new Map(
    problems.map(({ document }) => [document.problem_code, document])
  );
  const paths = {};
  for (const { document: operation } of operations) {
    const projection = operation.projections.rest;
    const method = projection.method.toLowerCase();
    const inputName = componentName(operation.input_schema_id, schemasById);
    const outputName =
      operation.output_schema_id === undefined
        ? undefined
        : componentName(operation.output_schema_id, schemasById);
    const successResponse =
      operation.output_stream === undefined
        ? {
            content: {
              "application/json": {
                schema: { $ref: `#/components/schemas/${outputName}` },
              },
            },
            description: "Contractually valid result.",
          }
        : streamingSuccessResponse(operation.output_stream);
    const entry = {
      operationId: operation.operation_id,
      responses: {
        200: successResponse,
        ...problemResponsesFor(operation, problemsByCode),
      },
      security: [{ bearerAuth: [] }],
      "x-kurobara-idempotence": operation.idempotence,
      "x-kurobara-operation-version": operation.operation_version,
      "x-kurobara-problem-codes": operation.problem_codes,
    };
    const inputSchema = schemasById.get(operation.input_schema_id);
    const requiredProperties = new Set(inputSchema.required ?? []);
    const projectedParameterNames = new Set([
      ...(projection.path_parameters ?? []),
      ...(projection.query_parameters ?? []),
    ]);
    const parameters = [
      ...(projection.path_parameters ?? []).map((name) => ({
        in: "path",
        name,
        required: true,
        schema: inputSchema.properties[name],
      })),
      ...(projection.query_parameters ?? []).map((name) => ({
        in: "query",
        name,
        required: requiredProperties.has(name),
        schema: inputSchema.properties[name],
      })),
    ];
    if (parameters.length > 0) {
      entry.parameters = parameters;
    }
    if (method === "get") {
      // GET inputs are projected entirely to path and query parameters.
    } else if (projection.multipart === undefined) {
      const bodyProperties = Object.fromEntries(
        Object.entries(inputSchema.properties).filter(
          ([name]) => !projectedParameterNames.has(name)
        )
      );
      entry.requestBody = {
        content: {
          "application/json": {
            schema:
              projectedParameterNames.size === 0
                ? { $ref: `#/components/schemas/${inputName}` }
                : {
                    additionalProperties: false,
                    properties: bodyProperties,
                    required: [...requiredProperties].filter(
                      (name) => !projectedParameterNames.has(name)
                    ),
                    type: "object",
                  },
          },
        },
        required: true,
      };
    } else {
      entry.requestBody = multipartRequestBody(inputName, projection.multipart);
      entry["x-kurobara-request-transport"] = "streaming-multipart";
    }
    paths[projection.path] ??= {};
    paths[projection.path][method] = entry;
  }
  return {
    components: {
      schemas: Object.fromEntries(
        schemas.map(({ document }) => [
          document.title,
          openApiSchema(document, schemasById),
        ])
      ),
      securitySchemes: {
        bearerAuth: {
          scheme: "bearer",
          type: "http",
        },
      },
    },
    info: {
      description:
        "Generated projection. Publication is blocked until a canonical namespace is proven and approved.",
      title: "Kurobara V1 contract foundation (local development only)",
      version: CATALOG_VERSION,
    },
    jsonSchemaDialect: DIALECT,
    openapi: "3.1.1",
    paths,
    "x-kurobara-catalog-fingerprint": catalogFingerprint,
    "x-kurobara-event-types": events.map(({ document }) => document.event_type),
    "x-kurobara-publication-status": "local-development-only",
  };
};

const renderProblemRegistry = (problems, catalogFingerprint) => ({
  problems: problems.map(({ document: problem }) => ({
    code: problem.problem_code,
    retryable: problem.retryable,
    status: problem.default_status,
    title: problem.title,
    type: problem.type_uri,
  })),
  publication_status: "local-development-only",
  source_catalog_fingerprint: catalogFingerprint,
});

const cliExitCodeFor = (problem, projectionRule) => {
  const exitCode =
    projectionRule.problem_exit_codes[String(problem.default_status)];
  if (exitCode === undefined) {
    throw new Error(
      `No deterministic CLI exit code exists for HTTP status ${problem.default_status}.`
    );
  }
  return exitCode;
};

const renderCli = (
  operations,
  problems,
  catalogFingerprint,
  projectionRule
) => {
  const problemsByCode = new Map(
    problems.map(({ document }) => [document.problem_code, document])
  );
  return {
    commands: operations.map(({ document: operation }) => ({
      command: operation.projections.cli.command,
      idempotence: operation.idempotence,
      input_schema_id: operation.input_schema_id,
      operation_id: operation.operation_id,
      operation_version: operation.operation_version,
      required_permissions: operation.required_permissions,
      ...(operation.output_schema_id === undefined
        ? { output_stream: operation.output_stream }
        : { output_schema_id: operation.output_schema_id }),
      input_mode: operation.projections.cli.input_mode ?? "json",
      output_mode: operation.projections.cli.output_mode ?? "json",
      problems: operation.problem_codes.map((code) => {
        const problem = problemsByCode.get(code);
        return {
          code: problem.problem_code,
          exit_code: cliExitCodeFor(problem, projectionRule),
          retryable: problem.retryable,
          status: problem.default_status,
          type: problem.type_uri,
        };
      }),
      success_exit_code: projectionRule.success_exit_code,
    })),
    publication_status: "local-development-only",
    schema_version: projectionRule.metadata_schema_version,
    source_catalog_fingerprint: catalogFingerprint,
  };
};

const renderMcp = (schemas, operations, problems, catalogFingerprint) => {
  const schemasById = new Map(
    schemas.map(({ document }) => [document.$id, document])
  );
  const problemsByCode = new Map(
    problems.map(({ document }) => [document.problem_code, document])
  );
  return {
    protocol_version: "2025-11-25",
    publication_status: "local-development-only",
    source_catalog_fingerprint: catalogFingerprint,
    tools: operations
      .filter(
        ({ document: operation }) =>
          (operation.projections.mcp.availability ?? "available") ===
          "available"
      )
      .map(({ document: operation }) => ({
        idempotence: operation.idempotence,
        inputSchema: schemasById.get(operation.input_schema_id),
        name: operation.projections.mcp.tool,
        operation_id: operation.operation_id,
        operation_version: operation.operation_version,
        outputSchema: schemasById.get(operation.output_schema_id),
        problemCodes: operation.problem_codes,
        problems: operation.problem_codes.map((code) => {
          const problem = problemsByCode.get(code);
          return {
            code: problem.problem_code,
            retryable: problem.retryable,
            status: problem.default_status,
            type: problem.type_uri,
          };
        }),
        required_permissions: operation.required_permissions,
        structuredContent: true,
      })),
  };
};

const loadDocuments = async (packageRoot, relativeDirectory, suffix) => {
  const base = path.join(packageRoot, relativeDirectory);
  const files = (await walk(base)).filter((file) => file.endsWith(suffix));
  return Promise.all(
    files.map(async (file) => ({
      document: await readJson(file),
      relativePath: path.relative(packageRoot, file).split(path.sep).join("/"),
    }))
  );
};

const visitSchemaReferences = (value, visit) => {
  if (Array.isArray(value)) {
    for (const item of value) {
      visitSchemaReferences(item, visit);
    }
    return;
  }
  if (!isObject(value)) {
    return;
  }
  if (typeof value.$ref === "string") {
    visit(value.$ref);
  }
  for (const child of Object.values(value)) {
    visitSchemaReferences(child, visit);
  }
};

const assertSchemaReferences = (schemas, schemaById) => {
  for (const { document, relativePath } of schemas) {
    visitSchemaReferences(document, (reference) => {
      const resolved = resolveSchemaRef(document, reference, schemaById);
      if (resolved?.target === undefined) {
        throw new Error(
          `${relativePath}: schema reference ${reference} is not resolved by the local catalog.`
        );
      }
    });
  }
};

const assertProblems = (problems, schemaById) => {
  const problemsByCode = new Map();
  for (const { document, relativePath } of problems) {
    assertProblemSource(document, relativePath);
    if (problemsByCode.has(document.problem_code)) {
      throw new Error(`${relativePath}: duplicate problem code.`);
    }
    problemsByCode.set(document.problem_code, document);
  }
  const problemSchema = schemaById.get(PROBLEM_SCHEMA_ID);
  if (!problemSchema) {
    throw new Error("The canonical Problem Details schema is required.");
  }
  const schemaCodes = [...problemSchema.properties.code.enum].sort();
  const registryCodes = [...problemsByCode.keys()].sort();
  if (canonicalize(schemaCodes) !== canonicalize(registryCodes)) {
    throw new Error(
      "Problem Details code enum must exactly match the problem registry."
    );
  }
  return problemsByCode;
};

const assertProjectionParameterNames = (
  inputSchema,
  names,
  kind,
  relativePath
) => {
  if (
    !Array.isArray(names) ||
    names.some(
      (name) =>
        typeof name !== "string" ||
        !Object.hasOwn(inputSchema.properties ?? {}, name)
    ) ||
    new Set(names).size !== names.length
  ) {
    throw new Error(
      `${relativePath}: ${kind} parameters must uniquely reference input schema properties.`
    );
  }
};

const assertGetProjection = (inputSchema, projection, relativePath) => {
  if (projection.method.toLowerCase() !== "get") {
    return;
  }
  const pathParameters = projection.path_parameters ?? [];
  const queryParameters = projection.query_parameters ?? [];
  assertProjectionParameterNames(
    inputSchema,
    pathParameters,
    "path",
    relativePath
  );
  assertProjectionParameterNames(
    inputSchema,
    queryParameters,
    "query",
    relativePath
  );
  const declaredParameters = [...pathParameters, ...queryParameters];
  if (
    new Set(declaredParameters).size !== declaredParameters.length ||
    canonicalize([...declaredParameters].sort()) !==
      canonicalize(Object.keys(inputSchema.properties ?? {}).sort())
  ) {
    throw new Error(
      `${relativePath}: GET parameters must project every input property exactly once.`
    );
  }
  const pathPlaceholders = [...projection.path.matchAll(/\{([^{}]+)\}/gu)]
    .map((match) => match[1])
    .sort((left, right) => left.localeCompare(right, "en"));
  if (
    canonicalize(pathPlaceholders) !== canonicalize([...pathParameters].sort())
  ) {
    throw new Error(
      `${relativePath}: REST path placeholders and path_parameters disagree.`
    );
  }
};

const assertMultipartProjection = (projection, relativePath) => {
  if (projection.multipart === undefined) {
    return;
  }
  const multipart = projection.multipart;
  if (projection.method.toLowerCase() === "get") {
    throw new Error(`${relativePath}: GET cannot use multipart input.`);
  }
  if (
    !isObject(multipart) ||
    typeof multipart.metadata_part !== "string" ||
    multipart.metadata_part.trim().length === 0 ||
    typeof multipart.source_part !== "string" ||
    multipart.source_part.trim().length === 0 ||
    multipart.metadata_part === multipart.source_part ||
    !Array.isArray(multipart.source_media_types) ||
    multipart.source_media_types.length === 0 ||
    new Set(multipart.source_media_types).size !==
      multipart.source_media_types.length ||
    multipart.source_media_types.some(
      (mediaType) => !MULTIPART_SOURCE_MEDIA_TYPES.has(mediaType)
    )
  ) {
    throw new Error(
      `${relativePath}: multipart projection must declare distinct parts and supported unique source media types.`
    );
  }
};

const assertOutputStream = (operation, inputSchema, relativePath) => {
  const outputStream = operation.output_stream;
  if (outputStream === undefined) {
    return;
  }
  const formatProperty = outputStream.format_property;
  const formatSchema = inputSchema.properties?.[formatProperty];
  if (
    typeof formatProperty !== "string" ||
    formatProperty.length === 0 ||
    !Array.isArray(formatSchema?.enum) ||
    formatSchema.enum.length === 0 ||
    !isObject(outputStream.formats)
  ) {
    throw new Error(
      `${relativePath}: output_stream must reference one enumerated input format property.`
    );
  }
  const formats = Object.entries(outputStream.formats);
  if (
    outputStream.delivery_tracking !== undefined &&
    outputStream.delivery_tracking !== "optional-atomic"
  ) {
    throw new Error(
      `${relativePath}: output_stream delivery_tracking must use the optional-atomic contract.`
    );
  }
  if (
    canonicalize(formats.map(([format]) => format).sort()) !==
      canonicalize([...formatSchema.enum].sort()) ||
    formats.some(
      ([, descriptor]) =>
        !(
          isObject(descriptor) &&
          OUTPUT_STREAM_MEDIA_TYPES.has(descriptor.media_type)
        ) ||
        typeof descriptor.file_extension !== "string" ||
        !FILE_EXTENSION_PATTERN.test(descriptor.file_extension) ||
        typeof descriptor.filename !== "string" ||
        !DOWNLOAD_FILENAME_PATTERN.test(descriptor.filename) ||
        !descriptor.filename.endsWith(`.${descriptor.file_extension}`)
    ) ||
    new Set(formats.map(([, descriptor]) => descriptor.media_type)).size !==
      formats.length ||
    new Set(formats.map(([, descriptor]) => descriptor.filename)).size !==
      formats.length
  ) {
    throw new Error(
      `${relativePath}: output_stream formats must exactly match the input enum and use supported unique descriptors.`
    );
  }
};

const assertOperations = (operations, schemaById, problemsByCode) => {
  const operationIds = new Set();
  for (const { document, relativePath } of operations) {
    assertOperationSource(document, relativePath);
    const identity = `${document.operation_id}:${document.operation_version}`;
    if (operationIds.has(identity)) {
      throw new Error(`${relativePath}: duplicate operation identity.`);
    }
    operationIds.add(identity);
    if (!schemaById.has(document.input_schema_id)) {
      throw new Error(
        `${relativePath}: operation references an unknown input schema.`
      );
    }
    if (
      document.output_schema_id !== undefined &&
      !schemaById.has(document.output_schema_id)
    ) {
      throw new Error(
        `${relativePath}: operation references an unknown output schema.`
      );
    }
    const inputSchema = schemaById.get(document.input_schema_id);
    assertGetProjection(inputSchema, document.projections.rest, relativePath);
    assertMultipartProjection(document.projections.rest, relativePath);
    assertOutputStream(document, inputSchema, relativePath);
    for (const problemCode of document.problem_codes) {
      if (!problemsByCode.has(problemCode)) {
        throw new Error(
          `${relativePath}: operation references unknown problem ${problemCode}.`
        );
      }
    }
  }
};

const assertEvents = (events, schemaById) => {
  const eventTypeSet = new Set(
    events.map(({ document }) => document.event_type)
  );
  if (eventTypeSet.size !== events.length) {
    throw new Error("Event types must be unique in the foundation catalog.");
  }
  for (const { document, relativePath } of events) {
    assertEventSource(document, relativePath);
    if (!schemaById.has(document.data_schema_id)) {
      throw new Error(`${relativePath}: event references an unknown schema.`);
    }
  }
  return eventTypeSet;
};

export const loadCatalog = async (packageRoot) => {
  const [schemas, operations, problems, events, projectionRules] =
    await Promise.all([
      loadDocuments(packageRoot, "catalog/schemas", ".schema.json"),
      loadDocuments(packageRoot, "catalog/operations", ".operation.json"),
      loadDocuments(packageRoot, "catalog/problems", ".problem.json"),
      loadDocuments(packageRoot, "catalog/events", ".event.json"),
      loadDocuments(packageRoot, "catalog/projection-rules", ".json"),
    ]);
  const ids = new Set();
  const titles = new Set();
  for (const source of schemas) {
    assertSchemaSource(source.document, source.relativePath);
    if (ids.has(source.document.$id) || titles.has(source.document.title)) {
      throw new Error(`${source.relativePath}: duplicate schema identity.`);
    }
    ids.add(source.document.$id);
    titles.add(source.document.title);
  }
  const schemaById = new Map(
    schemas.map(({ document }) => [document.$id, document])
  );
  assertSchemaReferences(schemas, schemaById);
  const problemsByCode = assertProblems(problems, schemaById);
  assertOperations(operations, schemaById, problemsByCode);
  const eventTypeSet = assertEvents(events, schemaById);
  const projectionSurfaces = projectionRules.map(
    ({ document }) => document.surface
  );
  if (new Set(projectionSurfaces).size !== projectionSurfaces.length) {
    throw new Error("Projection rule surfaces must be unique.");
  }
  const cliProjectionRule = projectionRules.find(
    ({ document }) => document.surface === "cli"
  )?.document;
  if (
    cliProjectionRule === undefined ||
    cliProjectionRule.metadata_schema_version !== "1.0.0" ||
    !Number.isInteger(cliProjectionRule.success_exit_code) ||
    !isObject(cliProjectionRule.problem_exit_codes)
  ) {
    throw new Error("The canonical CLI projection rule is required.");
  }
  for (const { document, relativePath } of operations) {
    for (const eventType of document.emits_event_types ?? []) {
      if (!eventTypeSet.has(eventType)) {
        throw new Error(
          `${relativePath}: operation emits an unknown event type.`
        );
      }
    }
  }
  return { events, operations, problems, projectionRules, schemas };
};

export const compile = async (packageRoot) => {
  const catalog = await loadCatalog(packageRoot);
  const members = [
    ...catalog.schemas.map(({ document, relativePath }) => ({
      fingerprint: fingerprint(document),
      id: document.$id,
      media_type: "application/schema+json",
      role: "schema",
      source: relativePath,
      version: document["x-kurobara-schema-version"],
    })),
    ...catalog.operations.map(({ document, relativePath }) => ({
      fingerprint: fingerprint(document),
      id: `operation:${document.operation_id}:${document.operation_version}`,
      media_type: "application/json",
      role: "operation",
      source: relativePath,
      version: document.operation_version,
    })),
    ...catalog.problems.map(({ document, relativePath }) => ({
      fingerprint: fingerprint(document),
      id: `problem:${document.problem_code}:${document.problem_version}`,
      media_type: "application/problem+json",
      role: "problem",
      source: relativePath,
      version: document.problem_version,
    })),
    ...catalog.events.map(({ document, relativePath }) => ({
      fingerprint: fingerprint(document),
      id: `event:${document.event_type}:${document.event_version}`,
      media_type: "application/json",
      role: "event",
      source: relativePath,
      version: document.event_version,
    })),
    ...catalog.projectionRules.map(({ document, relativePath }) => ({
      fingerprint: fingerprint(document),
      id: `projection:${document.surface}:${document.version}`,
      media_type: "application/json",
      role: "projection-rule",
      source: relativePath,
      version: document.version,
    })),
  ].sort((left, right) => left.id.localeCompare(right.id, "en"));
  const manifestWithoutFingerprint = {
    canonical_namespace: "https://schemas.kurobara.invalid/",
    canonicalization: "RFC-8785",
    catalog_version: CATALOG_VERSION,
    hash_algorithm: "SHA-256",
    json_schema_dialect: DIALECT,
    members,
    publication_status: "local-development-only",
  };
  const catalogFingerprint = fingerprint(manifestWithoutFingerprint);
  const catalogManifest = {
    ...manifestWithoutFingerprint,
    catalog_fingerprint: catalogFingerprint,
  };
  const openApi = renderOpenApi(
    catalog.schemas,
    catalog.operations,
    catalog.events,
    catalog.problems,
    catalogFingerprint
  );
  const mcp = renderMcp(
    catalog.schemas,
    catalog.operations,
    catalog.problems,
    catalogFingerprint
  );
  const problemRegistry = renderProblemRegistry(
    catalog.problems,
    catalogFingerprint
  );
  const cli = renderCli(
    catalog.operations,
    catalog.problems,
    catalogFingerprint,
    catalog.projectionRules.find(({ document }) => document.surface === "cli")
      .document
  );
  const types = renderTypes(
    catalog.schemas,
    catalogFingerprint,
    catalog.operations,
    catalog.events,
    catalog.problems
  );
  const outputs = new Map([
    [
      "catalog/generated/catalog-manifest.json",
      `${JSON.stringify(catalogManifest, null, 2)}\n`,
    ],
    [
      "catalog/generated/openapi-3.1.1.json",
      `${JSON.stringify(openApi, null, 2)}\n`,
    ],
    ["catalog/generated/mcp-tools.json", `${JSON.stringify(mcp, null, 2)}\n`],
    [
      "catalog/generated/problem-registry.json",
      `${JSON.stringify(problemRegistry, null, 2)}\n`,
    ],
    [
      "catalog/generated/cli-commands.json",
      `${JSON.stringify(cli, null, 2)}\n`,
    ],
    ["src/generated/v1.ts", types],
  ]);
  const generationManifest = {
    generator: GENERATOR,
    network_access: "forbidden",
    outputs: [...outputs.entries()].map(([file, content]) => ({
      file,
      fingerprint: `sha256:${createHash("sha256").update(content, "utf8").digest("hex")}`,
    })),
    runtime: `node-${process.versions.node}`,
    source_catalog_fingerprint: catalogFingerprint,
  };
  outputs.set(
    "catalog/generated/generation-manifest.json",
    `${JSON.stringify(generationManifest, null, 2)}\n`
  );
  return { catalog, catalogFingerprint, outputs };
};

export const fixtureDirectoryFor = (schema) => pascalToKebab(schema.title);
