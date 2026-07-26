import type { PluginSidecarJsonRpcFrame as PluginSidecarJsonRpcFrameContract } from "@kurobara/contracts";
import pluginManifestSchema from "@kurobara/contracts/schemas/plugin-manifest.json" with {
  type: "json",
};
import pluginProtocolMessageSchema from "@kurobara/contracts/schemas/plugin-protocol-message.json" with {
  type: "json",
};
import pluginSidecarJsonRpcFrameSchema from "@kurobara/contracts/schemas/plugin-sidecar-json-rpc-frame.json" with {
  type: "json",
};
import Ajv2020 from "ajv/dist/2020.js";

import {
  type PluginJsonValidationReasonCode,
  validatePluginJsonWithLimits,
} from "./json.ts";
import {
  type PluginProtocolValidationReasonCode,
  validatePluginProtocolMessage,
} from "./protocol.ts";

export const PLUGIN_SIDECAR_JSON_RPC_FRAME_MAX_DEPTH = 50;
export const PLUGIN_SIDECAR_JSON_RPC_FRAME_MAX_NODES = 16_400;
export const PLUGIN_SIDECAR_JSON_RPC_FRAME_MAX_UTF8_BYTES = 263_168;

export type PluginSidecarJsonRpcFrame = PluginSidecarJsonRpcFrameContract;

export type PluginSidecarJsonRpcValidationReasonCode =
  | PluginJsonValidationReasonCode
  | PluginProtocolValidationReasonCode
  | "plugin-sidecar-json-rpc-frame-invalid"
  | "plugin-sidecar-json-rpc-semantic-invalid";

export type PluginSidecarJsonRpcValidationResult =
  | Readonly<{
      frame: PluginSidecarJsonRpcFrame;
      ok: true;
      validatorVersion: string;
    }>
  | Readonly<{
      ok: false;
      reasonCode: PluginSidecarJsonRpcValidationReasonCode;
      validatorVersion: string;
    }>;

export const PLUGIN_SIDECAR_JSON_RPC_VALIDATOR_VERSION =
  "ajv-8.20.0-kurobara-plugin-sidecar-json-rpc-v1";

const ajv = new Ajv2020({
  allErrors: true,
  strict: true,
  strictRequired: false,
  validateFormats: false,
});

for (const keyword of [
  "x-kurobara-data-classification",
  "x-kurobara-owner",
  "x-kurobara-publication-status",
  "x-kurobara-schema-version",
]) {
  ajv.addKeyword({ keyword, schemaType: "string", valid: true });
}

ajv.addSchema(pluginManifestSchema);
ajv.addSchema(pluginProtocolMessageSchema);
const validateSchema = ajv.compile<PluginSidecarJsonRpcFrame>(
  pluginSidecarJsonRpcFrameSchema
);

const innerMessage = (frame: PluginSidecarJsonRpcFrame): unknown =>
  "params" in frame ? frame.params : frame.result;

const externalMethodMatches = (
  frame: PluginSidecarJsonRpcFrame,
  method: string,
  direction: string
): boolean => {
  if ("params" in frame) {
    return direction === "request" && frame.method === `plugin.${method}`;
  }
  return direction === "result";
};

export const validatePluginSidecarJsonRpcFrame = (
  candidate: unknown
): PluginSidecarJsonRpcValidationResult => {
  const snapshot = validatePluginJsonWithLimits(candidate, {
    maxDepth: PLUGIN_SIDECAR_JSON_RPC_FRAME_MAX_DEPTH,
    maxNodes: PLUGIN_SIDECAR_JSON_RPC_FRAME_MAX_NODES,
    maxUtf8Bytes: PLUGIN_SIDECAR_JSON_RPC_FRAME_MAX_UTF8_BYTES,
  });
  if (!snapshot.ok) {
    return {
      ok: false,
      reasonCode: snapshot.reasonCode,
      validatorVersion: PLUGIN_SIDECAR_JSON_RPC_VALIDATOR_VERSION,
    };
  }
  if (!validateSchema(snapshot.value)) {
    return {
      ok: false,
      reasonCode: "plugin-sidecar-json-rpc-frame-invalid",
      validatorVersion: PLUGIN_SIDECAR_JSON_RPC_VALIDATOR_VERSION,
    };
  }

  const frame = snapshot.value;
  const validatedMessage = validatePluginProtocolMessage(innerMessage(frame));
  if (!validatedMessage.ok) {
    return {
      ok: false,
      reasonCode: validatedMessage.reasonCode,
      validatorVersion: PLUGIN_SIDECAR_JSON_RPC_VALIDATOR_VERSION,
    };
  }
  if (
    !externalMethodMatches(
      frame,
      validatedMessage.message.method,
      validatedMessage.message.direction
    )
  ) {
    return {
      ok: false,
      reasonCode: "plugin-sidecar-json-rpc-semantic-invalid",
      validatorVersion: PLUGIN_SIDECAR_JSON_RPC_VALIDATOR_VERSION,
    };
  }
  return {
    frame,
    ok: true,
    validatorVersion: PLUGIN_SIDECAR_JSON_RPC_VALIDATOR_VERSION,
  };
};

export const isPluginSidecarJsonRpcFrame = (
  candidate: unknown
): candidate is PluginSidecarJsonRpcFrame =>
  validatePluginSidecarJsonRpcFrame(candidate).ok;
