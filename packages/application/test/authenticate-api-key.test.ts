import assert from "node:assert/strict";
import test from "node:test";

import { actorId, instant, workspaceId } from "@kurobara/kernel";
import type {
  ApiKeyAuthenticationPort,
  AuthenticateApiKeyInput,
  VerifiedApiKey,
} from "@kurobara/ports";

import { makeAuthenticateApiKey } from "../src/index.ts";

const verifiedKey: VerifiedApiKey = {
  actorId: actorId("actor-test"),
  authenticationMode: "api-key",
  credentialId: "credential-test",
  permissions: ["runs:create", "runs:read"],
  workspaceId: workspaceId("workspace-test"),
};

test("returns only the verified actor context from the authentication port", async () => {
  const calls: AuthenticateApiKeyInput[] = [];
  const apiKeys: ApiKeyAuthenticationPort = {
    authenticate: (input) => {
      calls.push(input);
      return Promise.resolve({
        ...verifiedKey,
        presentedKey: "adapter-field-that-must-not-escape",
      });
    },
  };
  const authenticate = makeAuthenticateApiKey({
    apiKeys,
    clock: { now: async () => instant(1234) },
  });

  const result = await authenticate({
    presentedKey: "synthetic-presented-key",
  });

  assert.deepEqual(calls, [
    { now: instant(1234), presentedKey: "synthetic-presented-key" },
  ]);
  assert.deepEqual(result, { ok: true, value: verifiedKey });
  if (result.ok) {
    assert.equal("presentedKey" in result.value, false);
  }
});

test("returns the same generic failure when the adapter rejects a credential", async () => {
  const authenticate = makeAuthenticateApiKey({
    apiKeys: {
      authenticate: () => Promise.resolve(undefined),
    },
    clock: { now: async () => instant(1234) },
  });

  const result = await authenticate({
    presentedKey: "credential-not-returned",
  });

  assert.deepEqual(result, {
    error: {
      code: "invalid-credential",
      message: "The presented credential is invalid.",
    },
    ok: false,
  });
  assert.equal(
    JSON.stringify(result).includes("credential-not-returned"),
    false
  );
});
