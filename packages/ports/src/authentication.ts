import type { ActorId, Instant, WorkspaceId } from "@kurobara/kernel";

export type AuthenticateApiKeyInput = Readonly<{
  presentedKey: string;
  now: Instant;
}>;

export type VerifiedApiKey = Readonly<{
  credentialId: string;
  actorId: ActorId;
  workspaceId: WorkspaceId;
  permissions: readonly string[];
  authenticationMode: "api-key";
}>;

export interface ApiKeyAuthenticationPort {
  authenticate(
    input: AuthenticateApiKeyInput
  ): Promise<VerifiedApiKey | undefined>;
}
