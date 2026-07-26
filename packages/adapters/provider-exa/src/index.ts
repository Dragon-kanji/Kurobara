import type { PluginAdapterV1 } from "@kurobara/plugin-sdk";
import {
  createSearchProviderAdapter,
  type SearchProviderOptions,
} from "@kurobara/provider-search-common";

const definition = Object.freeze({
  authMode: "api-key-header" as const,
  endpoint: "https://api.exa.ai/search" as const,
  hostname: "api.exa.ai",
  pluginId: "dev.kurobara.provider-exa",
  request: (domain: string) => ({
    category: "company",
    numResults: 1,
    query: `Find the official website for ${domain}`,
    type: "fast",
  }),
  requestIdKey: "requestId" as const,
});

export const createExaProviderAdapter = (
  options: SearchProviderOptions
): PluginAdapterV1 => createSearchProviderAdapter(definition, options);
