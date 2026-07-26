import type { PluginProtocolMessage } from "@kurobara/contracts";
import pluginManifestSchema from "@kurobara/contracts/schemas/plugin-manifest.json" with {
  type: "json",
};
import pluginProtocolMessageSchema from "@kurobara/contracts/schemas/plugin-protocol-message.json" with {
  type: "json",
};
import Ajv2020 from "ajv/dist/2020.js";

import {
  type PluginJsonValidationReasonCode,
  validatePluginJson,
  validatePluginJsonWithLimits,
} from "./json.ts";

export const PLUGIN_PROTOCOL_API_VERSION =
  "dev.kurobara.plugin-protocol/v1" as const;
export const PLUGIN_PROTOCOL_ENVELOPE_MAX_DEPTH = 48;
export const PLUGIN_PROTOCOL_ENVELOPE_MAX_NODES = 16_384;
export const PLUGIN_PROTOCOL_ENVELOPE_MAX_UTF8_BYTES = 262_144;

export type PluginProtocolMethod = PluginProtocolMessage["method"];
export type PluginProtocolDirection = PluginProtocolMessage["direction"];

type MessageFor<
  Method extends PluginProtocolMethod,
  Direction extends PluginProtocolDirection,
> = Extract<
  PluginProtocolMessage,
  Readonly<{ direction: Direction; method: Method }>
>;

export type PluginProtocolRequest<Method extends PluginProtocolMethod> =
  MessageFor<Method, "request">["payload"];

export type PluginProtocolResult<Method extends PluginProtocolMethod> =
  MessageFor<Method, "result">["payload"];

export type PluginProtocolValidationReasonCode =
  | PluginJsonValidationReasonCode
  | "plugin-protocol-message-invalid"
  | "plugin-protocol-semantic-invalid";

export type PluginProtocolValidationResult =
  | Readonly<{
      message: PluginProtocolMessage;
      ok: true;
      validatorVersion: string;
    }>
  | Readonly<{
      ok: false;
      reasonCode: PluginProtocolValidationReasonCode;
      validatorVersion: string;
    }>;

export const PLUGIN_PROTOCOL_VALIDATOR_VERSION =
  "ajv-8.20.0-kurobara-plugin-protocol-v1";

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
const validateSchema = ajv.compile<PluginProtocolMessage>(
  pluginProtocolMessageSchema
);

type EmbeddedJson = Readonly<{
  expectedSizeBytes?: number;
  value: unknown;
}>;

const configurationValue = (
  context: PluginProtocolRequest<"health">["context"]
): EmbeddedJson => ({ value: context.configuration.value });

const inputValue = (
  input: PluginProtocolRequest<"estimate">["input"]
): EmbeddedJson => ({
  expectedSizeBytes: input.sizeBytes,
  value: input.value,
});

const unreachableMessage = (message: never): never => message;

const embeddedJsonValues = (
  message: PluginProtocolMessage
): readonly EmbeddedJson[] => {
  if (message.direction === "request") {
    switch (message.method) {
      case "classifyError":
      case "health":
      case "lookup":
        return [configurationValue(message.payload.context)];
      case "estimate":
      case "execute":
        return [
          configurationValue(message.payload.context),
          inputValue(message.payload.input),
        ];
      case "normalize":
        return [
          configurationValue(message.payload.context),
          { value: message.payload.providerPayload },
        ];
      case "validateConfig":
        return [{ value: message.payload.configuration.value }];
      case "describe":
        return [];
      default:
        return unreachableMessage(message);
    }
  }

  if (message.direction !== "result") {
    return [];
  }

  switch (message.method) {
    case "execute":
      return message.payload.status === "succeeded"
        ? [{ value: message.payload.providerPayload }]
        : [];
    case "lookup":
      return message.payload.status === "found" &&
        message.payload.outcome.status === "succeeded"
        ? [{ value: message.payload.outcome.providerPayload }]
        : [];
    case "normalize":
      return message.payload.status === "normalized"
        ? [{ value: message.payload.output }]
        : [];
    case "classifyError":
    case "describe":
    case "estimate":
    case "health":
    case "validateConfig":
      return [];
    default:
      return unreachableMessage(message);
  }
};

const validateEmbeddedJson = (
  message: PluginProtocolMessage
): PluginProtocolValidationReasonCode | undefined => {
  for (const embedded of embeddedJsonValues(message)) {
    const validated = validatePluginJson(embedded.value);
    if (!validated.ok) {
      return validated.reasonCode;
    }
    if (
      embedded.expectedSizeBytes !== undefined &&
      embedded.expectedSizeBytes !== validated.sizeBytes
    ) {
      return "plugin-protocol-semantic-invalid";
    }
  }
};

export const validatePluginProtocolMessage = (
  candidate: unknown
): PluginProtocolValidationResult => {
  const snapshot = validatePluginJsonWithLimits(candidate, {
    maxDepth: PLUGIN_PROTOCOL_ENVELOPE_MAX_DEPTH,
    maxNodes: PLUGIN_PROTOCOL_ENVELOPE_MAX_NODES,
    maxUtf8Bytes: PLUGIN_PROTOCOL_ENVELOPE_MAX_UTF8_BYTES,
  });
  if (!snapshot.ok) {
    return {
      ok: false,
      reasonCode: snapshot.reasonCode,
      validatorVersion: PLUGIN_PROTOCOL_VALIDATOR_VERSION,
    };
  }
  if (!validateSchema(snapshot.value)) {
    return {
      ok: false,
      reasonCode: "plugin-protocol-message-invalid",
      validatorVersion: PLUGIN_PROTOCOL_VALIDATOR_VERSION,
    };
  }
  const semanticError = validateEmbeddedJson(snapshot.value);
  if (semanticError !== undefined) {
    return {
      ok: false,
      reasonCode: semanticError,
      validatorVersion: PLUGIN_PROTOCOL_VALIDATOR_VERSION,
    };
  }
  return {
    message: snapshot.value,
    ok: true,
    validatorVersion: PLUGIN_PROTOCOL_VALIDATOR_VERSION,
  };
};

export const isPluginProtocolMessage = (
  candidate: unknown
): candidate is PluginProtocolMessage =>
  validatePluginProtocolMessage(candidate).ok;
