import {
  type CapabilityRef,
  type ContractRef,
  isAmount,
  usageEntryId,
} from "@kurobara/kernel";
import {
  definePluginAdapter,
  type PluginAdapterV1,
  type PluginContractRef,
  type PluginEstimateRequest,
  type PluginEstimateResult,
  type PluginExecuteResult,
  type PluginLookupResult,
  type PluginValidateConfigResult,
  validatePluginJson,
} from "@kurobara/plugin-sdk";
import type {
  ExecuteLeafEffectOutcome,
  LeafEffectFinalOutcome,
  LeafEffectPort,
  LeafEffectRequest,
  LeafEffectSettlement,
  LookupLeafEffectOutcome,
  NormalizedJsonValue,
} from "@kurobara/ports";

const MAX_REQUESTS_PER_EFFECT = 1;
const REQUEST_UNIT = "requests";
const CONTENT_HASH_PATTERN = /^sha256:[0-9a-f]{64}$/u;

type PluginConfiguration = PluginEstimateRequest["context"]["configuration"];
type PluginSafeError = Extract<
  PluginEstimateResult,
  { status: "unavailable" }
>["error"];
type PluginUsage = Exclude<
  PluginExecuteResult,
  { status: "outcome-unknown" }
>["usage"];

export type PluginLeafEffectConfigurationReason =
  | "adapter-key-invalid"
  | "capability-contract-mismatch"
  | "configuration-invalid"
  | "manifest-economics-unsupported"
  | "manifest-lookup-unsupported";

export class PluginLeafEffectConfigurationError extends Error {
  readonly reasonCode: PluginLeafEffectConfigurationReason;

  constructor(reasonCode: PluginLeafEffectConfigurationReason) {
    super(`Plugin leaf effect configuration rejected: ${reasonCode}.`);
    this.name = "PluginLeafEffectConfigurationError";
    this.reasonCode = reasonCode;
  }
}

export type TrustedPluginLeafEffectOptions = Readonly<{
  adapter: PluginAdapterV1;
  adapterKey: string;
  beforeExecute?: (
    request: LeafEffectRequest
  ) => Promise<LeafEffectFinalOutcome | undefined>;
  capability: CapabilityRef;
  clock?: () => number;
  configuration: PluginConfiguration;
  deadlineAtMs(request: LeafEffectRequest): number;
  inputContract: ContractRef;
  outputContract: ContractRef;
}>;

type PluginContext = PluginEstimateRequest["context"];
type TrustedPluginLeafEffectBinding = Readonly<{
  capability: CapabilityRef;
  deadlineAtMs(request: LeafEffectRequest): number;
  inputContract: ContractRef;
}>;

type DeadlineCall<Value> =
  | Readonly<{ status: "completed"; value: Value }>
  | Readonly<{ status: "deadline-exceeded" }>
  | Readonly<{ status: "rejected" }>;

const contractsMatch = (left: PluginContractRef, right: ContractRef): boolean =>
  left.catalogFingerprint === right.catalogFingerprint &&
  left.catalogVersion === right.catalogVersion &&
  left.schemaFingerprint === right.schemaFingerprint &&
  left.schemaId === right.schemaId &&
  left.schemaVersion === right.schemaVersion;

const callWithinDeadline = async <Value>(
  operation: () => Value | Promise<Value>,
  deadlineAtMs: number,
  clock: () => number
): Promise<DeadlineCall<Value>> => {
  const remainingMs = deadlineAtMs - clock();
  if (remainingMs <= 0) {
    return { status: "deadline-exceeded" };
  }

  return await new Promise((resolve) => {
    let completed = false;
    const timer = setTimeout(() => {
      if (!completed) {
        completed = true;
        resolve({ status: "deadline-exceeded" });
      }
    }, remainingMs);

    Promise.resolve()
      .then(operation)
      .then(
        (value) => {
          if (!completed) {
            completed = true;
            clearTimeout(timer);
            resolve({ status: "completed", value });
          }
        },
        () => {
          if (!completed) {
            completed = true;
            clearTimeout(timer);
            resolve({ status: "rejected" });
          }
        }
      );
  });
};

const fixedFailure = (
  reason: string,
  retryable: boolean,
  settlement: LeafEffectSettlement = { kind: "release" }
): LeafEffectFinalOutcome => ({
  reason,
  retryable,
  settlement,
  status: "failed",
});

const retryableError = (error: PluginSafeError): boolean =>
  error.reasonCode === "rate-limited" ||
  error.reasonCode === "transport-failed" ||
  error.reasonCode === "provider-unavailable";

const pluginFailure = (
  error: PluginSafeError,
  settlement: LeafEffectSettlement = { kind: "release" }
): LeafEffectFinalOutcome =>
  fixedFailure(`plugin-${error.reasonCode}`, retryableError(error), settlement);

const stableUsageEntryId = (adapterKey: string, request: LeafEffectRequest) =>
  usageEntryId(`usage:plugin:${adapterKey}:${request.attemptId}`);

const stableProofId = (adapterKey: string, request: LeafEffectRequest) =>
  `proof:plugin:${adapterKey}:${request.attemptId}`;

const settlementFor = (
  adapterKey: string,
  request: LeafEffectRequest,
  usage: PluginUsage
): LeafEffectSettlement | undefined => {
  if (usage.basis === "unavailable") {
    return { kind: "release" };
  }
  if (
    usage.basis !== "exact" ||
    usage.unit !== REQUEST_UNIT ||
    !isAmount(usage.amount) ||
    usage.amount > request.reservedAmount ||
    usage.amount > MAX_REQUESTS_PER_EFFECT
  ) {
    return;
  }
  return {
    amount: usage.amount,
    kind: "settle",
    unit: REQUEST_UNIT,
    usageEntryId: stableUsageEntryId(adapterKey, request),
  };
};

const successSettlementFor = (
  adapterKey: string,
  request: LeafEffectRequest,
  usage: PluginUsage
): Extract<LeafEffectSettlement, { kind: "settle" }> | undefined => {
  const settlement = settlementFor(adapterKey, request, usage);
  return settlement?.kind === "settle" ? settlement : undefined;
};

const requestFailure = (request: LeafEffectRequest): string | undefined => {
  if (
    request.reservationUnit !== REQUEST_UNIT ||
    !isAmount(request.reservedAmount) ||
    request.reservedAmount > MAX_REQUESTS_PER_EFFECT
  ) {
    return "plugin-budget-invalid";
  }
  if (request.runInput === undefined) {
    return "plugin-run-input-missing";
  }
};

const inputFor = (
  request: LeafEffectRequest
): PluginEstimateRequest["input"] | undefined => {
  const runInput = request.runInput;
  if (runInput === undefined) {
    return;
  }
  return {
    contentHash: runInput.contentHash,
    contract: runInput.contract,
    sizeBytes: runInput.sizeBytes,
    value: runInput.value,
  };
};

const validClockReading = (value: number): boolean =>
  Number.isSafeInteger(value) && value >= 0;

const contextFor = (
  binding: TrustedPluginLeafEffectBinding,
  request: LeafEffectRequest,
  configuration: PluginConfiguration,
  timeoutMs: number,
  clock: () => number
): PluginContext | undefined => {
  const now = clock();
  let requestedDeadline: number;
  try {
    requestedDeadline = binding.deadlineAtMs(request);
  } catch {
    return;
  }
  if (
    !(validClockReading(now) && validClockReading(requestedDeadline)) ||
    requestedDeadline <= now
  ) {
    return;
  }
  return Object.freeze({
    capability: binding.capability,
    configuration,
    deadlineAtMs: Math.min(requestedDeadline, now + timeoutMs),
  });
};

const quoteIsAuthorized = (
  quote: Extract<PluginEstimateResult, { status: "quoted" }>["quote"],
  request: LeafEffectRequest,
  context: PluginContext,
  clock: () => number
): boolean =>
  quote.guarantee === "hard" &&
  quote.unit === REQUEST_UNIT &&
  quote.upperBound !== undefined &&
  isAmount(quote.upperBound) &&
  quote.upperBound <= request.reservedAmount &&
  quote.upperBound <= MAX_REQUESTS_PER_EFFECT &&
  quote.expiresAtMs > clock() &&
  quote.expiresAtMs <= context.deadlineAtMs;

const normalizeSucceeded = async (
  adapter: PluginAdapterV1,
  context: PluginContext,
  operationKey: string,
  outputContract: ContractRef,
  providerPayload: unknown,
  clock: () => number
): Promise<
  | Readonly<{ output: NormalizedJsonValue; status: "normalized" }>
  | Readonly<{ status: "failed" }>
> => {
  const invocation = await callWithinDeadline(
    () =>
      adapter.normalize({
        context,
        operationKey,
        outputContract,
        providerPayload,
      }),
    context.deadlineAtMs,
    clock
  );
  if (
    invocation.status !== "completed" ||
    invocation.value.status !== "normalized"
  ) {
    return { status: "failed" };
  }
  const output = validatePluginJson(invocation.value.output);
  return output.ok
    ? { output: output.value, status: "normalized" }
    : { status: "failed" };
};

const mapExecuteFinalOutcome = async (options: {
  readonly adapter: PluginAdapterV1;
  readonly adapterKey: string;
  readonly clock: () => number;
  readonly context: PluginContext;
  readonly outputContract: ContractRef;
  readonly pluginOutcome: Exclude<
    PluginExecuteResult,
    { status: "outcome-unknown" }
  >;
  readonly request: LeafEffectRequest;
}): Promise<ExecuteLeafEffectOutcome> => {
  const { pluginOutcome, request } = options;
  const settlement = settlementFor(
    options.adapterKey,
    request,
    pluginOutcome.usage
  );
  if (settlement === undefined) {
    return {
      reason: "plugin-usage-incoherent",
      status: "outcome-unknown",
    };
  }
  if (pluginOutcome.status === "failed") {
    return pluginFailure(pluginOutcome.error, settlement);
  }
  const successSettlement = successSettlementFor(
    options.adapterKey,
    request,
    pluginOutcome.usage
  );
  if (successSettlement === undefined) {
    return {
      reason: "plugin-success-usage-unavailable",
      status: "outcome-unknown",
    };
  }
  const normalized = await normalizeSucceeded(
    options.adapter,
    options.context,
    request.operationKey,
    options.outputContract,
    pluginOutcome.providerPayload,
    options.clock
  );
  return normalized.status === "normalized"
    ? {
        output: normalized.output,
        settlement: successSettlement,
        status: "succeeded",
      }
    : fixedFailure("plugin-output-invalid", false, successSettlement);
};

const executeWithPlugin = async (options: {
  readonly adapter: PluginAdapterV1;
  readonly adapterKey: string;
  readonly beforeExecute?: TrustedPluginLeafEffectOptions["beforeExecute"];
  readonly clock: () => number;
  readonly configuration: PluginConfiguration;
  readonly binding: TrustedPluginLeafEffectBinding;
  readonly manifest: ReturnType<PluginAdapterV1["describe"]>["manifest"];
  readonly outputContract: ContractRef;
  readonly request: LeafEffectRequest;
}): Promise<ExecuteLeafEffectOutcome> => {
  const requestError = requestFailure(options.request);
  const input = inputFor(options.request);
  if (requestError !== undefined || input === undefined) {
    return fixedFailure(requestError ?? "plugin-run-input-missing", false);
  }
  if (!contractsMatch(input.contract, options.binding.inputContract)) {
    return fixedFailure("plugin-input-contract-mismatch", false);
  }
  const context = contextFor(
    options.binding,
    options.request,
    options.configuration,
    options.manifest.execution.timeouts.executeMs,
    options.clock
  );
  if (context === undefined) {
    return fixedFailure("plugin-deadline-invalid", false);
  }

  const estimate = await callWithinDeadline(
    () => options.adapter.estimate({ context, input }),
    context.deadlineAtMs,
    options.clock
  );
  if (estimate.status === "deadline-exceeded") {
    return fixedFailure("plugin-estimate-deadline-exceeded", false);
  }
  if (estimate.status === "rejected") {
    return fixedFailure("plugin-estimate-failed", true);
  }
  if (estimate.value.status === "unavailable") {
    return pluginFailure(estimate.value.error);
  }
  const quote = estimate.value.quote;
  if (!quoteIsAuthorized(quote, options.request, context, options.clock)) {
    return fixedFailure("plugin-quote-incoherent", false);
  }

  const authorizeEffect = options.beforeExecute;
  if (authorizeEffect !== undefined) {
    const authorization = await callWithinDeadline(
      () => authorizeEffect(options.request),
      context.deadlineAtMs,
      options.clock
    );
    if (authorization.status !== "completed") {
      return fixedFailure("plugin-effect-authorization-failed", false);
    }
    if (authorization.value !== undefined) {
      return authorization.value;
    }
  }

  const execution = await callWithinDeadline(
    () =>
      options.adapter.execute({
        context,
        costLimit: {
          amount: options.request.reservedAmount,
          unit: REQUEST_UNIT,
        },
        input,
        operationKey: options.request.operationKey,
        quote,
      }),
    context.deadlineAtMs,
    options.clock
  );
  if (execution.status !== "completed") {
    return {
      reason: "plugin-execution-outcome-unknown",
      status: "outcome-unknown",
    };
  }
  if (execution.value.status === "outcome-unknown") {
    return {
      reason: "plugin-execution-outcome-unknown",
      status: "outcome-unknown",
    };
  }
  return await mapExecuteFinalOutcome({
    adapter: options.adapter,
    adapterKey: options.adapterKey,
    clock: options.clock,
    context,
    outputContract: options.outputContract,
    pluginOutcome: execution.value,
    request: options.request,
  });
};

const lookupWithPlugin = async (options: {
  readonly adapter: PluginAdapterV1;
  readonly adapterKey: string;
  readonly clock: () => number;
  readonly configuration: PluginConfiguration;
  readonly binding: TrustedPluginLeafEffectBinding;
  readonly manifest: ReturnType<PluginAdapterV1["describe"]>["manifest"];
  readonly outputContract: ContractRef;
  readonly request: LeafEffectRequest;
}): Promise<LookupLeafEffectOutcome> => {
  const requestError = requestFailure(options.request);
  if (requestError !== undefined) {
    return { reason: requestError, status: "outcome-unknown" };
  }
  const context = contextFor(
    options.binding,
    options.request,
    options.configuration,
    options.manifest.execution.timeouts.lookupMs,
    options.clock
  );
  if (context === undefined) {
    return { reason: "plugin-deadline-invalid", status: "outcome-unknown" };
  }
  const lookup = await callWithinDeadline(
    () =>
      options.adapter.lookup({
        context,
        operationKey: options.request.operationKey,
      }),
    context.deadlineAtMs,
    options.clock
  );
  if (
    lookup.status !== "completed" ||
    lookup.value.status === "outcome-unknown"
  ) {
    return {
      reason: "plugin-lookup-outcome-unknown",
      status: "outcome-unknown",
    };
  }
  const proofId = stableProofId(options.adapterKey, options.request);
  if (lookup.value.status !== "found") {
    return { proofId, status: "not-found" };
  }
  const outcome = await mapLookupFoundOutcome({
    adapter: options.adapter,
    adapterKey: options.adapterKey,
    clock: options.clock,
    context,
    lookup: lookup.value,
    outputContract: options.outputContract,
    request: options.request,
  });
  return outcome === undefined
    ? { reason: "plugin-lookup-incoherent", status: "outcome-unknown" }
    : { outcome, proofId, status: "found" };
};

const mapLookupFoundOutcome = async (options: {
  readonly adapter: PluginAdapterV1;
  readonly adapterKey: string;
  readonly clock: () => number;
  readonly context: PluginContext;
  readonly lookup: Extract<PluginLookupResult, { status: "found" }>;
  readonly outputContract: ContractRef;
  readonly request: LeafEffectRequest;
}): Promise<LeafEffectFinalOutcome | undefined> => {
  const pluginOutcome = options.lookup.outcome;
  const settlement = settlementFor(
    options.adapterKey,
    options.request,
    pluginOutcome.usage
  );
  if (settlement === undefined) {
    return;
  }
  if (pluginOutcome.status === "failed") {
    return pluginFailure(pluginOutcome.error, settlement);
  }
  const successSettlement = successSettlementFor(
    options.adapterKey,
    options.request,
    pluginOutcome.usage
  );
  if (successSettlement === undefined) {
    return;
  }
  const normalized = await normalizeSucceeded(
    options.adapter,
    options.context,
    options.request.operationKey,
    options.outputContract,
    pluginOutcome.providerPayload,
    options.clock
  );
  return normalized.status === "normalized"
    ? {
        output: normalized.output,
        settlement: successSettlement,
        status: "succeeded",
      }
    : fixedFailure("plugin-output-invalid", false, successSettlement);
};

const validateFactoryBinding = (
  options: TrustedPluginLeafEffectOptions,
  adapter: PluginAdapterV1
): void => {
  if (
    options.adapterKey.length === 0 ||
    options.adapterKey.trim() !== options.adapterKey
  ) {
    throw new PluginLeafEffectConfigurationError("adapter-key-invalid");
  }
  const manifest = adapter.describe().manifest;
  const capability = manifest.capabilities.find(
    (candidate) =>
      candidate.capabilityId === options.capability.capabilityId &&
      candidate.capabilityVersion === options.capability.capabilityVersion
  );
  if (
    capability === undefined ||
    !contractsMatch(capability.inputContract, options.inputContract) ||
    !contractsMatch(capability.outputContract, options.outputContract)
  ) {
    throw new PluginLeafEffectConfigurationError(
      "capability-contract-mismatch"
    );
  }
  if (
    manifest.economics.unit !== REQUEST_UNIT ||
    manifest.economics.estimateGuarantee !== "hard" ||
    manifest.economics.usageReporting !== "exact"
  ) {
    throw new PluginLeafEffectConfigurationError(
      "manifest-economics-unsupported"
    );
  }
  if (manifest.execution.lookup.mode === "by-external-operation-id") {
    throw new PluginLeafEffectConfigurationError("manifest-lookup-unsupported");
  }
};

const configurationSnapshot = (
  configuration: PluginConfiguration
): PluginConfiguration => {
  const value = validatePluginJson(configuration.value);
  if (!(value.ok && CONTENT_HASH_PATTERN.test(configuration.contentHash))) {
    throw new PluginLeafEffectConfigurationError("configuration-invalid");
  }
  return Object.freeze({
    contentHash: configuration.contentHash,
    value: value.value,
  });
};

/**
 * Adapts one trusted in-process SDK adapter to the durable leaf-effect port.
 * Provider credentials remain owned by the adapter closure; this bridge only
 * snapshots explicitly non-secret configuration and never stores raw provider
 * payloads beyond normalization.
 */
export const createTrustedPluginLeafEffect = async (
  options: TrustedPluginLeafEffectOptions
): Promise<LeafEffectPort> => {
  const adapter = definePluginAdapter(options.adapter);
  validateFactoryBinding(options, adapter);
  const configuration = configurationSnapshot(options.configuration);
  let acceptedConfiguration: PluginValidateConfigResult;
  try {
    acceptedConfiguration = await adapter.validateConfig({
      capability: options.capability,
      configuration,
    });
  } catch {
    throw new PluginLeafEffectConfigurationError("configuration-invalid");
  }
  if (acceptedConfiguration.status !== "valid") {
    throw new PluginLeafEffectConfigurationError("configuration-invalid");
  }

  const manifest = adapter.describe().manifest;
  const clock = options.clock ?? Date.now;
  const adapterKey = options.adapterKey;
  const outputContract = Object.freeze({ ...options.outputContract });
  const binding: TrustedPluginLeafEffectBinding = Object.freeze({
    capability: Object.freeze({ ...options.capability }),
    deadlineAtMs: options.deadlineAtMs,
    inputContract: Object.freeze({ ...options.inputContract }),
  });
  const port: LeafEffectPort = Object.freeze({
    adapterKey,
    execute: (request: LeafEffectRequest) =>
      executeWithPlugin({
        adapter,
        adapterKey,
        ...(options.beforeExecute === undefined
          ? {}
          : { beforeExecute: options.beforeExecute }),
        binding,
        clock,
        configuration,
        manifest,
        outputContract,
        request,
      }),
    lookup: (request: LeafEffectRequest) =>
      lookupWithPlugin({
        adapter,
        adapterKey,
        binding,
        clock,
        configuration,
        manifest,
        outputContract,
        request,
      }),
  });
  return port;
};
