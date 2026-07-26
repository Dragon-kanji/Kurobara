import type { PluginAdapterV1 } from "@kurobara/plugin-sdk";
import {
  createSearchProviderAdapter,
  type SearchProviderOptions,
} from "@kurobara/provider-search-common";

const definition = Object.freeze({
  authMode: "bearer-token" as const,
  endpoint: "https://api.tavily.com/search" as const,
  hostname: "api.tavily.com",
  pluginId: "dev.kurobara.provider-tavily",
  request: (domain: string) => ({
    auto_parameters: false,
    include_answer: false,
    include_images: false,
    include_raw_content: false,
    include_usage: true,
    max_results: 1,
    query: `Find the official website for ${domain}`,
    search_depth: "basic",
  }),
  requestIdKey: "request_id" as const,
});

export const createTavilyProviderAdapter = (
  options: SearchProviderOptions
): PluginAdapterV1 => createSearchProviderAdapter(definition, options);
