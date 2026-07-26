import { validatePluginSidecarJsonRpcFrame } from "@kurobara/plugin-sdk";

export const validatedFrame = validatePluginSidecarJsonRpcFrame({
  id: "host-call-1",
  jsonrpc: "2.0",
});
