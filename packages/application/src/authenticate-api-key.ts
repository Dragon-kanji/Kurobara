import { type DomainResult, fail, succeed } from "@kurobara/kernel";
import type {
  ApiKeyAuthenticationPort,
  ClockPort,
  VerifiedApiKey,
} from "@kurobara/ports";

export type AuthenticateApiKeyCommand = Readonly<{
  presentedKey: string;
}>;

export type AuthenticateApiKeyFailure = Readonly<{
  code: "invalid-credential";
  message: string;
}>;

export type AuthenticateApiKeyDependencies = Readonly<{
  apiKeys: ApiKeyAuthenticationPort;
  clock: ClockPort;
}>;

export const makeAuthenticateApiKey =
  (dependencies: AuthenticateApiKeyDependencies) =>
  async (
    command: AuthenticateApiKeyCommand
  ): Promise<DomainResult<VerifiedApiKey, AuthenticateApiKeyFailure>> => {
    const now = await dependencies.clock.now();
    const verified = await dependencies.apiKeys.authenticate({
      now,
      presentedKey: command.presentedKey,
    });
    if (verified === undefined) {
      return fail({
        code: "invalid-credential",
        message: "The presented credential is invalid.",
      });
    }

    return succeed({
      actorId: verified.actorId,
      authenticationMode: "api-key",
      credentialId: verified.credentialId,
      permissions: [...verified.permissions],
      workspaceId: verified.workspaceId,
    });
  };
