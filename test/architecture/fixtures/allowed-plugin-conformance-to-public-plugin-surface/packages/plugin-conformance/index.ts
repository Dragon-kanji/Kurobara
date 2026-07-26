import { contractSchema } from "@kurobara/contracts";
import { validatedFrame } from "@kurobara/plugin-host";
import { definePluginAdapter } from "@kurobara/plugin-sdk";

export const publicPluginSurface = definePluginAdapter({
  contractSchema,
  validatedFrame,
});
