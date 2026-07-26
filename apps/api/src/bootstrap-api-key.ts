import { pathToFileURL } from "node:url";

import { createPostgresRuntime } from "@kurobara/adapter-postgres";

import { ApiConfigError, parseApiDatabaseUrl } from "./config.ts";

type BootstrapConfig = Readonly<{
  actorId: string;
  label: string;
  permissions: readonly string[];
  workspaceId: string;
}>;

const required = (
  environment: Readonly<Record<string, string | undefined>>,
  name: string
): string => {
  const value = environment[name];
  if (value === undefined || value.trim() !== value || value.length === 0) {
    throw new ApiConfigError(`${name} must be configured without whitespace.`);
  }
  return value;
};

export const parseBootstrapApiKeyConfig = (
  environment: Readonly<Record<string, string | undefined>>
): BootstrapConfig => {
  const permissions = required(environment, "KUROBARA_BOOTSTRAP_PERMISSIONS")
    .split(",")
    .map((permission) => permission.trim());
  if (permissions.some((permission) => permission.length === 0)) {
    throw new ApiConfigError(
      "KUROBARA_BOOTSTRAP_PERMISSIONS must be a comma-separated permission list."
    );
  }

  return {
    actorId: required(environment, "KUROBARA_BOOTSTRAP_ACTOR_ID"),
    label: environment.KUROBARA_BOOTSTRAP_KEY_LABEL ?? "local-bootstrap",
    permissions,
    workspaceId: required(environment, "KUROBARA_BOOTSTRAP_WORKSPACE_ID"),
  };
};

export const bootstrapApiKey = async (
  environment: Readonly<Record<string, string | undefined>>
) => {
  const databaseUrl = parseApiDatabaseUrl(environment);
  const config = parseBootstrapApiKeyConfig(environment);
  const database = createPostgresRuntime(databaseUrl);
  try {
    await database.migrate();
    return await database.bootstrapApiKey(config);
  } finally {
    await database.close();
  }
};

const isMainModule =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMainModule) {
  bootstrapApiKey(process.env)
    .then((credential) => {
      console.log(
        JSON.stringify({
          credential_id: credential.credentialId,
          presented_key: credential.presentedKey,
          warning: "Store this key now; Kurobara will not return it again.",
        })
      );
    })
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : "Unknown error";
      console.error(`Kurobara API key bootstrap failed: ${message}`);
      process.exitCode = 1;
    });
}
