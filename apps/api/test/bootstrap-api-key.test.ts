import assert from "node:assert/strict";
import test from "node:test";
import { parseBootstrapApiKeyConfig } from "../src/bootstrap-api-key.ts";
import { ApiConfigError } from "../src/config.ts";

test("parses an explicit offline API key bootstrap configuration", () => {
  assert.deepEqual(
    parseBootstrapApiKeyConfig({
      KUROBARA_BOOTSTRAP_ACTOR_ID: "actor-local",
      KUROBARA_BOOTSTRAP_KEY_LABEL: "automation",
      KUROBARA_BOOTSTRAP_PERMISSIONS: "runs:create,runs:read",
      KUROBARA_BOOTSTRAP_WORKSPACE_ID: "workspace-local",
    }),
    {
      actorId: "actor-local",
      label: "automation",
      permissions: ["runs:create", "runs:read"],
      workspaceId: "workspace-local",
    }
  );
});

test("requires explicit actor, workspace and permissions", () => {
  assert.throws(() => parseBootstrapApiKeyConfig({}), ApiConfigError);
});
