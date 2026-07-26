import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  isPluginManifestV1,
  PLUGIN_MANIFEST_API_VERSION,
  PLUGIN_MANIFEST_VALIDATOR_VERSION,
  validatePluginManifest,
} from "../src/manifest.ts";

const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);
const fixturesRoot = path.resolve(
  packageRoot,
  "../contracts/catalog/fixtures/plugin-manifest"
);

const readFixture = async (
  kind: "invalid" | "valid",
  file: string
): Promise<unknown> =>
  JSON.parse(await readFile(path.join(fixturesRoot, kind, file), "utf8"));

const validManifest = async () => {
  const result = validatePluginManifest(
    await readFixture("valid", "minimal.json")
  );
  if (!result.ok) {
    throw new Error("The canonical plugin fixture must be valid.");
  }
  return result.manifest;
};

test("returns an immutable snapshot of the canonical V1 manifest", async () => {
  const fixture = (await readFixture("valid", "minimal.json")) as {
    capabilities: Array<{ inputContract: { schemaId: string } }>;
    id: string;
    permissions: { egress: { hosts: string[] } };
  };
  const before = JSON.stringify(fixture);
  const result = validatePluginManifest(fixture);

  assert.equal(result.ok, true);
  assert.equal(JSON.stringify(fixture), before);
  assert.equal(result.validatorVersion, PLUGIN_MANIFEST_VALIDATOR_VERSION);
  if (result.ok) {
    assert.equal(result.manifest.apiVersion, PLUGIN_MANIFEST_API_VERSION);
    assert.equal(result.manifest.capabilities.length, 1);
    assert.equal(Object.isFrozen(result.manifest), true);
    assert.equal(Object.isFrozen(result.manifest.auth), true);
    assert.equal(Object.isFrozen(result.manifest.auth.modes), true);
    assert.equal(Object.isFrozen(result.manifest.capabilities), true);
    assert.equal(Object.isFrozen(result.manifest.capabilities[0]), true);
    assert.equal(
      Object.isFrozen(result.manifest.capabilities[0]?.inputContract),
      true
    );
    assert.equal(
      Object.isFrozen(result.manifest.permissions.egress.hosts),
      true
    );

    const acceptedId = result.manifest.id;
    const acceptedSchemaId =
      result.manifest.capabilities[0]?.inputContract.schemaId;
    const acceptedHosts = [...result.manifest.permissions.egress.hosts];
    const mutableCapability = fixture.capabilities[0];
    assert.ok(mutableCapability);
    fixture.id = "dev.example.changed";
    mutableCapability.inputContract.schemaId = "changed-after-validation";
    fixture.permissions.egress.hosts.push("api.changed.example");

    assert.equal(result.manifest.id, acceptedId);
    assert.equal(
      result.manifest.capabilities[0]?.inputContract.schemaId,
      acceptedSchemaId
    );
    assert.deepEqual(result.manifest.permissions.egress.hosts, acceptedHosts);
    assert.throws(() =>
      Object.defineProperty(result.manifest, "id", {
        value: "dev.example.mutation",
      })
    );
  }
  assert.equal(
    isPluginManifestV1(await readFixture("valid", "minimal.json")),
    true
  );
});

test("accepts a lookup-only adapter only with operation-key lookup", async () => {
  assert.equal(
    validatePluginManifest(await readFixture("valid", "lookup-only.json")).ok,
    true
  );
  const manifest = await validManifest();
  const result = validatePluginManifest({
    ...manifest,
    execution: {
      ...manifest.execution,
      idempotency: {
        ...manifest.execution.idempotency,
        mode: "lookup-only",
      },
      lookup: {
        ...manifest.execution.lookup,
        mode: "by-external-operation-id",
      },
    },
  });

  assert.deepEqual(result, {
    ok: false,
    reasonCodes: ["plugin-recovery-contract-unsafe"],
    validatorVersion: PLUGIN_MANIFEST_VALIDATOR_VERSION,
  });
});

test("rejects every canonical invalid fixture with stable redacted codes", async () => {
  const expected = new Map([
    ["dangerous-egress-host.json", "plugin-egress-host-dangerous"],
    ["duplicate-capability.json", "plugin-capability-duplicate"],
    ["unknown-field.json", "plugin-manifest-unknown-field"],
    ["unsupported-api-version.json", "plugin-api-version-unsupported"],
  ] as const);

  for (const [file, reason] of expected) {
    const result = validatePluginManifest(await readFixture("invalid", file));
    assert.equal(result.ok, false, file);
    if (!result.ok) {
      assert.ok(result.reasonCodes.includes(reason), file);
      assert.equal(JSON.stringify(result).includes("providerToken"), false);
      assert.equal(
        JSON.stringify(result).includes("must-never-be-declared"),
        false
      );
    }
  }
});

test("rejects empty capabilities and duplicate capability identities", async () => {
  const manifest = await validManifest();
  const empty = validatePluginManifest({ ...manifest, capabilities: [] });
  assert.deepEqual(empty, {
    ok: false,
    reasonCodes: ["plugin-manifest-schema-invalid"],
    validatorVersion: PLUGIN_MANIFEST_VALIDATOR_VERSION,
  });

  const first = manifest.capabilities[0];
  assert.ok(first);
  const duplicate = validatePluginManifest({
    ...manifest,
    capabilities: [
      first,
      {
        ...first,
        outputContract: {
          ...first.outputContract,
          schemaFingerprint: `sha256:${"d".repeat(64)}`,
        },
      },
    ],
  });
  assert.deepEqual(duplicate, {
    ok: false,
    reasonCodes: ["plugin-capability-duplicate"],
    validatorVersion: PLUGIN_MANIFEST_VALIDATOR_VERSION,
  });
});

test("rejects auth ambiguity and local egress targets", async () => {
  const manifest = await validManifest();
  const authConflict = validatePluginManifest({
    ...manifest,
    auth: { modes: ["none", "api-key-header"] },
  });
  assert.deepEqual(authConflict, {
    ok: false,
    reasonCodes: ["plugin-auth-mode-conflict"],
    validatorVersion: PLUGIN_MANIFEST_VALIDATOR_VERSION,
  });

  const localHost = validatePluginManifest({
    ...manifest,
    permissions: {
      egress: { hosts: ["metadata.service.internal"], tlsRequired: true },
    },
  });
  assert.deepEqual(localHost, {
    ok: false,
    reasonCodes: ["plugin-egress-host-dangerous"],
    validatorVersion: PLUGIN_MANIFEST_VALIDATOR_VERSION,
  });
});

test("rejects nested unknown fields without returning validator diagnostics", async () => {
  const manifest = await validManifest();
  const result = validatePluginManifest({
    ...manifest,
    execution: {
      ...manifest.execution,
      timeouts: {
        ...manifest.execution.timeouts,
        providerSecret: "synthetic-secret",
      },
    },
  });
  assert.deepEqual(result, {
    ok: false,
    reasonCodes: ["plugin-manifest-unknown-field"],
    validatorVersion: PLUGIN_MANIFEST_VALIDATOR_VERSION,
  });
  assert.equal(JSON.stringify(result).includes("synthetic-secret"), false);
});

test("does not reuse Ajv diagnostics for hostile non-JSON candidates", async () => {
  const manifest = await validManifest();
  const preloaded = validatePluginManifest({
    ...manifest,
    providerToken: "synthetic-preload-canary",
  });
  assert.deepEqual(preloaded, {
    ok: false,
    reasonCodes: ["plugin-manifest-unknown-field"],
    validatorVersion: PLUGIN_MANIFEST_VALIDATOR_VERSION,
  });

  const cyclic: { self?: unknown } = {};
  cyclic.self = cyclic;
  assert.deepEqual(validatePluginManifest(cyclic), {
    ok: false,
    reasonCodes: ["plugin-manifest-schema-invalid"],
    validatorVersion: PLUGIN_MANIFEST_VALIDATOR_VERSION,
  });

  let getterCalls = 0;
  const accessor = Object.defineProperty({}, "providerToken", {
    enumerable: true,
    get: () => {
      getterCalls += 1;
      return "synthetic-accessor-canary";
    },
  });
  const rejected = validatePluginManifest(accessor);
  assert.deepEqual(rejected, {
    ok: false,
    reasonCodes: ["plugin-manifest-schema-invalid"],
    validatorVersion: PLUGIN_MANIFEST_VALIDATOR_VERSION,
  });
  assert.equal(getterCalls, 0);
  assert.equal(JSON.stringify(rejected).includes("canary"), false);
});
