import type {
  PluginCapability,
  PluginContractRef,
  PluginManifestV1,
} from "./manifest.ts";
import { validatePluginManifest } from "./manifest.ts";
import {
  PLUGIN_PROTOCOL_API_VERSION,
  type PluginProtocolMethod,
  type PluginProtocolRequest,
  type PluginProtocolResult,
  type PluginProtocolValidationReasonCode,
  validatePluginProtocolMessage,
} from "./protocol.ts";

export type PluginDescribeResult = PluginProtocolResult<"describe">;
export type PluginValidateConfigRequest =
  PluginProtocolRequest<"validateConfig">;
export type PluginValidateConfigResult = PluginProtocolResult<"validateConfig">;
export type PluginEstimateRequest = PluginProtocolRequest<"estimate">;
export type PluginEstimateResult = PluginProtocolResult<"estimate">;
export type PluginExecuteRequest = PluginProtocolRequest<"execute">;
export type PluginExecuteResult = PluginProtocolResult<"execute">;
export type PluginLookupRequest = PluginProtocolRequest<"lookup">;
export type PluginLookupResult = PluginProtocolResult<"lookup">;
export type PluginNormalizeRequest = PluginProtocolRequest<"normalize">;
export type PluginNormalizeResult = PluginProtocolResult<"normalize">;
export type PluginHealthRequest = PluginProtocolRequest<"health">;
export type PluginHealthResult = PluginProtocolResult<"health">;
export type PluginClassifyErrorRequest = PluginProtocolRequest<"classifyError">;
export type PluginClassifyErrorResult = PluginProtocolResult<"classifyError">;

export type PluginAdapterMethodResult<Result> = Result | Promise<Result>;

export interface PluginAdapterV1 {
  classifyError(
    request: PluginClassifyErrorRequest
  ): PluginAdapterMethodResult<PluginClassifyErrorResult>;
  describe(): PluginDescribeResult;
  estimate(
    request: PluginEstimateRequest
  ): PluginAdapterMethodResult<PluginEstimateResult>;
  execute(
    request: PluginExecuteRequest
  ): PluginAdapterMethodResult<PluginExecuteResult>;
  health(
    request: PluginHealthRequest
  ): PluginAdapterMethodResult<PluginHealthResult>;
  lookup(
    request: PluginLookupRequest
  ): PluginAdapterMethodResult<PluginLookupResult>;
  normalize(
    request: PluginNormalizeRequest
  ): PluginAdapterMethodResult<PluginNormalizeResult>;
  validateConfig(
    request: PluginValidateConfigRequest
  ): PluginAdapterMethodResult<PluginValidateConfigResult>;
}

const exactAdapterMethods = <
  const Methods extends readonly PluginProtocolMethod[],
>(
  methods: Methods &
    (Exclude<Methods[number], keyof PluginAdapterV1> extends never
      ? unknown
      : never) &
    (Exclude<PluginProtocolMethod, Methods[number]> extends never
      ? unknown
      : never) &
    (Exclude<keyof PluginAdapterV1, Methods[number]> extends never
      ? unknown
      : never)
): Methods => methods;

export const PLUGIN_ADAPTER_METHODS = exactAdapterMethods([
  "describe",
  "validateConfig",
  "estimate",
  "execute",
  "lookup",
  "normalize",
  "health",
  "classifyError",
] as const);

export type PluginAdapterDefinitionReasonCode =
  | "plugin-adapter-definition-invalid"
  | "plugin-adapter-describe-failed"
  | "plugin-adapter-manifest-invalid"
  | "plugin-adapter-surface-invalid";

export class PluginAdapterDefinitionError extends Error {
  readonly reasonCode: PluginAdapterDefinitionReasonCode;

  constructor(reasonCode: PluginAdapterDefinitionReasonCode) {
    super(`Plugin adapter definition rejected: ${reasonCode}.`);
    this.name = "PluginAdapterDefinitionError";
    this.reasonCode = reasonCode;
  }
}

export class PluginAdapterProtocolError extends Error {
  readonly method: PluginProtocolMethod;
  readonly reasonCode: PluginProtocolValidationReasonCode;

  constructor(
    method: PluginProtocolMethod,
    reasonCode: PluginProtocolValidationReasonCode
  ) {
    super(`Plugin adapter ${method} message rejected: ${reasonCode}.`);
    this.name = "PluginAdapterProtocolError";
    this.method = method;
    this.reasonCode = reasonCode;
  }
}

export class PluginAdapterInvocationError extends Error {
  readonly method: Exclude<PluginProtocolMethod, "describe">;
  readonly reasonCode = "plugin-adapter-invocation-failed" as const;

  constructor(method: Exclude<PluginProtocolMethod, "describe">) {
    super(`Plugin adapter ${method} invocation failed.`);
    this.name = "PluginAdapterInvocationError";
    this.method = method;
  }
}

type UnknownFunction = (...arguments_: never[]) => unknown;
const NATIVE_PROMISE_THEN = Promise.prototype.then;

const methodMap = (
  candidate: unknown
): Map<PluginProtocolMethod, UnknownFunction> => {
  if (candidate === null || typeof candidate !== "object") {
    throw new PluginAdapterDefinitionError("plugin-adapter-definition-invalid");
  }
  const prototype = Object.getPrototypeOf(candidate);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new PluginAdapterDefinitionError("plugin-adapter-definition-invalid");
  }
  if (Object.getOwnPropertySymbols(candidate).length > 0) {
    throw new PluginAdapterDefinitionError("plugin-adapter-surface-invalid");
  }

  const keys = Object.getOwnPropertyNames(candidate).sort();
  const expected = [...PLUGIN_ADAPTER_METHODS].sort();
  if (
    keys.length !== expected.length ||
    keys.some((key, index) => key !== expected[index])
  ) {
    throw new PluginAdapterDefinitionError("plugin-adapter-surface-invalid");
  }

  const methods = new Map<PluginProtocolMethod, UnknownFunction>();
  for (const method of PLUGIN_ADAPTER_METHODS) {
    const descriptor = Object.getOwnPropertyDescriptor(candidate, method);
    if (
      !(descriptor && "value" in descriptor && descriptor.enumerable) ||
      typeof descriptor.value !== "function"
    ) {
      throw new PluginAdapterDefinitionError("plugin-adapter-surface-invalid");
    }
    const implementation: unknown = descriptor.value;
    if (typeof implementation !== "function") {
      throw new PluginAdapterDefinitionError("plugin-adapter-surface-invalid");
    }
    methods.set(method, (...arguments_: never[]) =>
      Reflect.apply(implementation, undefined, arguments_)
    );
  }
  return methods;
};

const requiredMethod = (
  methods: ReadonlyMap<PluginProtocolMethod, UnknownFunction>,
  method: PluginProtocolMethod
): UnknownFunction => {
  const implementation = methods.get(method);
  if (!implementation) {
    throw new PluginAdapterDefinitionError("plugin-adapter-surface-invalid");
  }
  return implementation;
};

const invoke = (
  implementation: UnknownFunction,
  argument?: unknown
): unknown =>
  argument === undefined
    ? Reflect.apply(implementation, undefined, [])
    : Reflect.apply(implementation, undefined, [argument]);

const invokeMethod = async (
  method: Exclude<PluginProtocolMethod, "describe">,
  implementation: UnknownFunction,
  argument: unknown
): Promise<unknown> => {
  try {
    return await Promise.resolve(invoke(implementation, argument));
  } catch {
    throw new PluginAdapterInvocationError(method);
  }
};

type PostEffectInvocation =
  | Readonly<{ ok: false }>
  | Readonly<{ ok: true; value: unknown }>;

const invokePostEffectMethod = async (
  implementation: UnknownFunction,
  argument: unknown
): Promise<PostEffectInvocation> => {
  try {
    return {
      ok: true,
      value: await Promise.resolve(invoke(implementation, argument)),
    };
  } catch {
    return { ok: false };
  }
};

const consumeNativePromise = (candidate: unknown): boolean => {
  try {
    Reflect.apply(NATIVE_PROMISE_THEN, candidate, [
      () => undefined,
      () => undefined,
    ]);
    return true;
  } catch {
    return false;
  }
};

const manifestFromDescribe = (
  implementation: UnknownFunction
): PluginManifestV1 => {
  let candidate: unknown;
  try {
    candidate = invoke(implementation);
  } catch {
    throw new PluginAdapterDefinitionError("plugin-adapter-describe-failed");
  }
  if (consumeNativePromise(candidate)) {
    throw new PluginAdapterDefinitionError("plugin-adapter-describe-failed");
  }
  const envelope = validatePluginProtocolMessage({
    apiVersion: PLUGIN_PROTOCOL_API_VERSION,
    direction: "result",
    method: "describe",
    payload: candidate,
  });
  if (
    !envelope.ok ||
    envelope.message.direction !== "result" ||
    envelope.message.method !== "describe"
  ) {
    throw new PluginAdapterDefinitionError("plugin-adapter-manifest-invalid");
  }
  const manifest = validatePluginManifest(envelope.message.payload.manifest);
  if (!manifest.ok) {
    throw new PluginAdapterDefinitionError("plugin-adapter-manifest-invalid");
  }
  return manifest.manifest;
};

const invalidMessage = (
  method: PluginProtocolMethod,
  reasonCode: PluginProtocolValidationReasonCode
): never => {
  throw new PluginAdapterProtocolError(method, reasonCode);
};

type PluginCallContext = PluginHealthRequest["context"];
type PluginInput = PluginEstimateRequest["input"];
type PluginUsage = Exclude<
  PluginExecuteResult,
  Readonly<{ status: "outcome-unknown" }>
>["usage"];

const semanticInvalid = (method: PluginProtocolMethod): never =>
  invalidMessage(method, "plugin-protocol-semantic-invalid");

const ambiguousError = Object.freeze({
  class: "adapter",
  reasonCode: "adapter-fault",
} as const);

const EXECUTE_OUTCOME_UNKNOWN = Object.freeze({
  error: ambiguousError,
  status: "outcome-unknown",
} as const satisfies PluginExecuteResult);

const LOOKUP_OUTCOME_UNKNOWN = Object.freeze({
  error: ambiguousError,
  status: "outcome-unknown",
} as const satisfies PluginLookupResult);

const qualifiedExternalOperationReference = (
  candidate: unknown
): string | undefined => {
  try {
    if (candidate === null || typeof candidate !== "object") {
      return;
    }
    const prototype = Object.getPrototypeOf(candidate);
    if (prototype !== Object.prototype && prototype !== null) {
      return;
    }
    const descriptor = Object.getOwnPropertyDescriptor(
      candidate,
      "externalOperationReference"
    );
    if (!(descriptor && "value" in descriptor)) {
      return;
    }
    if (!descriptor.enumerable) {
      return;
    }
    if (typeof descriptor.value !== "string") {
      return;
    }
    const validated = validatePluginProtocolMessage({
      apiVersion: PLUGIN_PROTOCOL_API_VERSION,
      direction: "result",
      method: "execute",
      payload: {
        ...EXECUTE_OUTCOME_UNKNOWN,
        externalOperationReference: descriptor.value,
      },
    });
    return validated.ok &&
      validated.message.direction === "result" &&
      validated.message.method === "execute"
      ? validated.message.payload.externalOperationReference
      : undefined;
  } catch {
    // Hostile objects can throw from reflection; fail closed without surfacing them.
  }
};

const ambiguousExecuteResult = (candidate?: unknown): PluginExecuteResult => {
  const externalOperationReference =
    qualifiedExternalOperationReference(candidate);
  if (externalOperationReference === undefined) {
    return EXECUTE_OUTCOME_UNKNOWN;
  }
  const validated = validatePluginProtocolMessage({
    apiVersion: PLUGIN_PROTOCOL_API_VERSION,
    direction: "result",
    method: "execute",
    payload: {
      ...EXECUTE_OUTCOME_UNKNOWN,
      externalOperationReference,
    },
  });
  return validated.ok &&
    validated.message.direction === "result" &&
    validated.message.method === "execute"
    ? validated.message.payload
    : EXECUTE_OUTCOME_UNKNOWN;
};

const contractsMatch = (
  left: PluginContractRef,
  right: PluginContractRef
): boolean =>
  left.catalogFingerprint === right.catalogFingerprint &&
  left.catalogVersion === right.catalogVersion &&
  left.schemaFingerprint === right.schemaFingerprint &&
  left.schemaId === right.schemaId &&
  left.schemaVersion === right.schemaVersion;

const capabilityFor = (
  manifest: PluginManifestV1,
  context: PluginCallContext,
  method: PluginProtocolMethod
): PluginCapability => {
  const capability = manifest.capabilities.find(
    (candidate) =>
      candidate.capabilityId === context.capability.capabilityId &&
      candidate.capabilityVersion === context.capability.capabilityVersion
  );
  return capability ?? semanticInvalid(method);
};

const validateInputBinding = (
  capability: PluginCapability,
  input: PluginInput,
  method: "estimate" | "execute"
): void => {
  if (!contractsMatch(capability.inputContract, input.contract)) {
    semanticInvalid(method);
  }
};

const validateExecuteAuthority = (
  manifest: PluginManifestV1,
  request: PluginExecuteRequest
): void => {
  const capability = capabilityFor(manifest, request.context, "execute");
  validateInputBinding(capability, request.input, "execute");
  if (
    request.quote.unit !== request.costLimit.unit ||
    request.quote.unit !== manifest.economics.unit ||
    request.quote.guarantee !== manifest.economics.estimateGuarantee ||
    (request.quote.upperBound !== undefined &&
      request.quote.upperBound > request.costLimit.amount)
  ) {
    semanticInvalid("execute");
  }
};

const usageUnitMatches = (usage: PluginUsage, unit: string): boolean =>
  usage.unit === unit;

const validateLookupAuthority = (
  manifest: PluginManifestV1,
  request: PluginLookupRequest
): void => {
  capabilityFor(manifest, request.context, "lookup");
  if (
    manifest.execution.lookup.mode === "by-external-operation-id" &&
    request.externalOperationReference === undefined
  ) {
    semanticInvalid("lookup");
  }
};

const lookupResultMatchesManifest = (
  manifest: PluginManifestV1,
  request: PluginLookupRequest,
  result: PluginLookupResult
): boolean => {
  if (
    result.status === "authoritative-absent" &&
    !manifest.execution.lookup.authoritativeNotFound
  ) {
    return false;
  }
  if (result.status !== "found") {
    return true;
  }
  if (!usageUnitMatches(result.outcome.usage, manifest.economics.unit)) {
    return false;
  }
  if (manifest.execution.lookup.mode !== "by-external-operation-id") {
    return true;
  }
  return (
    result.outcome.status === "succeeded" &&
    result.outcome.externalOperationReference ===
      request.externalOperationReference
  );
};

type ExactAdapter<Adapter extends PluginAdapterV1> = Adapter &
  Record<Exclude<keyof Adapter, keyof PluginAdapterV1>, never>;

export function definePluginAdapter<Adapter extends PluginAdapterV1>(
  candidate: ExactAdapter<Adapter>
): PluginAdapterV1;
export function definePluginAdapter(candidate: unknown): PluginAdapterV1 {
  let methods: Map<PluginProtocolMethod, UnknownFunction>;
  try {
    methods = methodMap(candidate);
  } catch (error) {
    if (error instanceof PluginAdapterDefinitionError) {
      throw error;
    }
    throw new PluginAdapterDefinitionError("plugin-adapter-definition-invalid");
  }
  const manifest = manifestFromDescribe(requiredMethod(methods, "describe"));
  const describeResult = Object.freeze({ manifest });

  return Object.freeze({
    classifyError: async (request: PluginClassifyErrorRequest) => {
      const acceptedRequest = validatePluginProtocolMessage({
        apiVersion: PLUGIN_PROTOCOL_API_VERSION,
        direction: "request",
        method: "classifyError",
        payload: request,
      });
      if (
        !acceptedRequest.ok ||
        acceptedRequest.message.direction !== "request" ||
        acceptedRequest.message.method !== "classifyError"
      ) {
        return invalidMessage(
          "classifyError",
          acceptedRequest.ok
            ? "plugin-protocol-message-invalid"
            : acceptedRequest.reasonCode
        );
      }
      capabilityFor(
        manifest,
        acceptedRequest.message.payload.context,
        "classifyError"
      );
      const candidateResult = await invokeMethod(
        "classifyError",
        requiredMethod(methods, "classifyError"),
        acceptedRequest.message.payload
      );
      const acceptedResult = validatePluginProtocolMessage({
        apiVersion: PLUGIN_PROTOCOL_API_VERSION,
        direction: "result",
        method: "classifyError",
        payload: candidateResult,
      });
      if (
        !acceptedResult.ok ||
        acceptedResult.message.direction !== "result" ||
        acceptedResult.message.method !== "classifyError"
      ) {
        return invalidMessage(
          "classifyError",
          acceptedResult.ok
            ? "plugin-protocol-message-invalid"
            : acceptedResult.reasonCode
        );
      }
      return acceptedResult.message.payload;
    },
    describe: () => describeResult,
    estimate: async (request: PluginEstimateRequest) => {
      const acceptedRequest = validatePluginProtocolMessage({
        apiVersion: PLUGIN_PROTOCOL_API_VERSION,
        direction: "request",
        method: "estimate",
        payload: request,
      });
      if (
        !acceptedRequest.ok ||
        acceptedRequest.message.direction !== "request" ||
        acceptedRequest.message.method !== "estimate"
      ) {
        return invalidMessage(
          "estimate",
          acceptedRequest.ok
            ? "plugin-protocol-message-invalid"
            : acceptedRequest.reasonCode
        );
      }
      const capability = capabilityFor(
        manifest,
        acceptedRequest.message.payload.context,
        "estimate"
      );
      validateInputBinding(
        capability,
        acceptedRequest.message.payload.input,
        "estimate"
      );
      const candidateResult = await invokeMethod(
        "estimate",
        requiredMethod(methods, "estimate"),
        acceptedRequest.message.payload
      );
      const acceptedResult = validatePluginProtocolMessage({
        apiVersion: PLUGIN_PROTOCOL_API_VERSION,
        direction: "result",
        method: "estimate",
        payload: candidateResult,
      });
      if (
        !acceptedResult.ok ||
        acceptedResult.message.direction !== "result" ||
        acceptedResult.message.method !== "estimate"
      ) {
        return invalidMessage(
          "estimate",
          acceptedResult.ok
            ? "plugin-protocol-message-invalid"
            : acceptedResult.reasonCode
        );
      }
      if (
        acceptedResult.message.payload.status === "quoted" &&
        (acceptedResult.message.payload.quote.unit !==
          manifest.economics.unit ||
          acceptedResult.message.payload.quote.guarantee !==
            manifest.economics.estimateGuarantee)
      ) {
        semanticInvalid("estimate");
      }
      return acceptedResult.message.payload;
    },
    execute: async (request: PluginExecuteRequest) => {
      const acceptedRequest = validatePluginProtocolMessage({
        apiVersion: PLUGIN_PROTOCOL_API_VERSION,
        direction: "request",
        method: "execute",
        payload: request,
      });
      if (
        !acceptedRequest.ok ||
        acceptedRequest.message.direction !== "request" ||
        acceptedRequest.message.method !== "execute"
      ) {
        return invalidMessage(
          "execute",
          acceptedRequest.ok
            ? "plugin-protocol-message-invalid"
            : acceptedRequest.reasonCode
        );
      }
      validateExecuteAuthority(manifest, acceptedRequest.message.payload);
      const invocation = await invokePostEffectMethod(
        requiredMethod(methods, "execute"),
        acceptedRequest.message.payload
      );
      if (!invocation.ok) {
        return EXECUTE_OUTCOME_UNKNOWN;
      }
      const candidateResult = invocation.value;
      const acceptedResult = validatePluginProtocolMessage({
        apiVersion: PLUGIN_PROTOCOL_API_VERSION,
        direction: "result",
        method: "execute",
        payload: candidateResult,
      });
      if (
        !acceptedResult.ok ||
        acceptedResult.message.direction !== "result" ||
        acceptedResult.message.method !== "execute"
      ) {
        return ambiguousExecuteResult(candidateResult);
      }
      const result = acceptedResult.message.payload;
      if (
        result.status !== "outcome-unknown" &&
        !usageUnitMatches(
          result.usage,
          acceptedRequest.message.payload.costLimit.unit
        )
      ) {
        return ambiguousExecuteResult(result);
      }
      return result;
    },
    health: async (request: PluginHealthRequest) => {
      const acceptedRequest = validatePluginProtocolMessage({
        apiVersion: PLUGIN_PROTOCOL_API_VERSION,
        direction: "request",
        method: "health",
        payload: request,
      });
      if (
        !acceptedRequest.ok ||
        acceptedRequest.message.direction !== "request" ||
        acceptedRequest.message.method !== "health"
      ) {
        return invalidMessage(
          "health",
          acceptedRequest.ok
            ? "plugin-protocol-message-invalid"
            : acceptedRequest.reasonCode
        );
      }
      capabilityFor(
        manifest,
        acceptedRequest.message.payload.context,
        "health"
      );
      const candidateResult = await invokeMethod(
        "health",
        requiredMethod(methods, "health"),
        acceptedRequest.message.payload
      );
      const acceptedResult = validatePluginProtocolMessage({
        apiVersion: PLUGIN_PROTOCOL_API_VERSION,
        direction: "result",
        method: "health",
        payload: candidateResult,
      });
      if (
        !acceptedResult.ok ||
        acceptedResult.message.direction !== "result" ||
        acceptedResult.message.method !== "health"
      ) {
        return invalidMessage(
          "health",
          acceptedResult.ok
            ? "plugin-protocol-message-invalid"
            : acceptedResult.reasonCode
        );
      }
      if (
        acceptedResult.message.payload.validUntilMs <
        acceptedResult.message.payload.observedAtMs
      ) {
        semanticInvalid("health");
      }
      return acceptedResult.message.payload;
    },
    lookup: async (request: PluginLookupRequest) => {
      const acceptedRequest = validatePluginProtocolMessage({
        apiVersion: PLUGIN_PROTOCOL_API_VERSION,
        direction: "request",
        method: "lookup",
        payload: request,
      });
      if (
        !acceptedRequest.ok ||
        acceptedRequest.message.direction !== "request" ||
        acceptedRequest.message.method !== "lookup"
      ) {
        return invalidMessage(
          "lookup",
          acceptedRequest.ok
            ? "plugin-protocol-message-invalid"
            : acceptedRequest.reasonCode
        );
      }
      validateLookupAuthority(manifest, acceptedRequest.message.payload);
      if (manifest.execution.lookup.mode === "none") {
        return LOOKUP_OUTCOME_UNKNOWN;
      }
      const invocation = await invokePostEffectMethod(
        requiredMethod(methods, "lookup"),
        acceptedRequest.message.payload
      );
      if (!invocation.ok) {
        return LOOKUP_OUTCOME_UNKNOWN;
      }
      const candidateResult = invocation.value;
      const acceptedResult = validatePluginProtocolMessage({
        apiVersion: PLUGIN_PROTOCOL_API_VERSION,
        direction: "result",
        method: "lookup",
        payload: candidateResult,
      });
      if (
        !acceptedResult.ok ||
        acceptedResult.message.direction !== "result" ||
        acceptedResult.message.method !== "lookup"
      ) {
        return LOOKUP_OUTCOME_UNKNOWN;
      }
      if (
        !lookupResultMatchesManifest(
          manifest,
          acceptedRequest.message.payload,
          acceptedResult.message.payload
        )
      ) {
        return LOOKUP_OUTCOME_UNKNOWN;
      }
      return acceptedResult.message.payload;
    },
    normalize: async (request: PluginNormalizeRequest) => {
      const acceptedRequest = validatePluginProtocolMessage({
        apiVersion: PLUGIN_PROTOCOL_API_VERSION,
        direction: "request",
        method: "normalize",
        payload: request,
      });
      if (
        !acceptedRequest.ok ||
        acceptedRequest.message.direction !== "request" ||
        acceptedRequest.message.method !== "normalize"
      ) {
        return invalidMessage(
          "normalize",
          acceptedRequest.ok
            ? "plugin-protocol-message-invalid"
            : acceptedRequest.reasonCode
        );
      }
      const capability = capabilityFor(
        manifest,
        acceptedRequest.message.payload.context,
        "normalize"
      );
      if (
        !contractsMatch(
          capability.outputContract,
          acceptedRequest.message.payload.outputContract
        )
      ) {
        semanticInvalid("normalize");
      }
      const candidateResult = await invokeMethod(
        "normalize",
        requiredMethod(methods, "normalize"),
        acceptedRequest.message.payload
      );
      const acceptedResult = validatePluginProtocolMessage({
        apiVersion: PLUGIN_PROTOCOL_API_VERSION,
        direction: "result",
        method: "normalize",
        payload: candidateResult,
      });
      if (
        !acceptedResult.ok ||
        acceptedResult.message.direction !== "result" ||
        acceptedResult.message.method !== "normalize"
      ) {
        return invalidMessage(
          "normalize",
          acceptedResult.ok
            ? "plugin-protocol-message-invalid"
            : acceptedResult.reasonCode
        );
      }
      return acceptedResult.message.payload;
    },
    validateConfig: async (request: PluginValidateConfigRequest) => {
      const acceptedRequest = validatePluginProtocolMessage({
        apiVersion: PLUGIN_PROTOCOL_API_VERSION,
        direction: "request",
        method: "validateConfig",
        payload: request,
      });
      if (
        !acceptedRequest.ok ||
        acceptedRequest.message.direction !== "request" ||
        acceptedRequest.message.method !== "validateConfig"
      ) {
        return invalidMessage(
          "validateConfig",
          acceptedRequest.ok
            ? "plugin-protocol-message-invalid"
            : acceptedRequest.reasonCode
        );
      }
      capabilityFor(
        manifest,
        {
          capability: acceptedRequest.message.payload.capability,
          configuration: acceptedRequest.message.payload.configuration,
          deadlineAtMs: 0,
        },
        "validateConfig"
      );
      const candidateResult = await invokeMethod(
        "validateConfig",
        requiredMethod(methods, "validateConfig"),
        acceptedRequest.message.payload
      );
      const acceptedResult = validatePluginProtocolMessage({
        apiVersion: PLUGIN_PROTOCOL_API_VERSION,
        direction: "result",
        method: "validateConfig",
        payload: candidateResult,
      });
      if (
        !acceptedResult.ok ||
        acceptedResult.message.direction !== "result" ||
        acceptedResult.message.method !== "validateConfig"
      ) {
        return invalidMessage(
          "validateConfig",
          acceptedResult.ok
            ? "plugin-protocol-message-invalid"
            : acceptedResult.reasonCode
        );
      }
      if (
        acceptedResult.message.payload.status === "valid" &&
        acceptedResult.message.payload.configurationFingerprint !==
          acceptedRequest.message.payload.configuration.contentHash
      ) {
        semanticInvalid("validateConfig");
      }
      return acceptedResult.message.payload;
    },
  });
}
