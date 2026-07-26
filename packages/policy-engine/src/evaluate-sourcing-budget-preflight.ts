import type { BudgetLimit, CostQuote, Instant } from "@kurobara/kernel";
import { instant, isAmount } from "@kurobara/kernel";

export const SOURCING_LIMIT_NAMES = [
  "maxCompanies",
  "maxContactsPerCompany",
  "maxContactsTotal",
  "maxEnrichments",
  "maxPhones",
  "maxResults",
  "maxPages",
  "maxCalls",
] as const;

export type SourcingLimitName = (typeof SOURCING_LIMIT_NAMES)[number];

export type SourcingCardinalityLimitInput = Readonly<
  Partial<Record<SourcingLimitName, number>>
>;

export type SourcingCardinalityLimits = Readonly<
  Record<SourcingLimitName, number>
>;

export type UnknownSourcingCostPolicy =
  | Readonly<{ mode: "deny" }>
  | Readonly<{
      hardCap: number;
      mode: "explicit-non-interactive";
    }>;

export type SourcingBudgetPreflightFacts = Readonly<{
  budget: BudgetLimit;
  deadline: Instant;
  limits: SourcingCardinalityLimitInput;
  now: Instant;
  quote: CostQuote;
  unknownCostPolicy: UnknownSourcingCostPolicy;
}>;

export type SourcingBudgetPreflightReasonCode =
  | "input-invalid"
  | "limit-unknown"
  | "limit-missing"
  | "limit-invalid"
  | "limit-overflow"
  | "limits-inconsistent"
  | "deadline-invalid"
  | "deadline-elapsed"
  | "budget-invalid"
  | "quote-invalid"
  | "quote-expired"
  | "quote-unit-mismatch"
  | "quote-upper-bound-required"
  | "quote-exceeds-budget"
  | "unknown-cost-authorization-required"
  | "unknown-cost-hard-cap-required"
  | "unknown-cost-hard-cap-invalid"
  | "allowed";

export type SourcingBudgetPreflightSnapshot = Readonly<{
  budget: BudgetLimit;
  deadline: Instant;
  hardExecutionCap: number;
  limits: SourcingCardinalityLimits;
  quote: CostQuote;
}>;

export type SourcingBudgetPreflightDecision = Readonly<{
  allowed: boolean;
  reasonCodes: readonly SourcingBudgetPreflightReasonCode[];
  snapshot?: SourcingBudgetPreflightSnapshot;
  stopExternalEffects: boolean;
  stopFallback: boolean;
}>;

const KNOWN_LIMIT_NAMES: ReadonlySet<string> = new Set(SOURCING_LIMIT_NAMES);

const isRecord = (value: unknown): value is Record<PropertyKey, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

type OwnValueRead =
  | Readonly<{ kind: "missing" }>
  | Readonly<{ kind: "accessor" }>
  | Readonly<{ kind: "value"; value: unknown }>;

const readOwnValue = (value: object, key: PropertyKey): OwnValueRead => {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (descriptor === undefined) {
    return { kind: "missing" };
  }
  return "value" in descriptor
    ? { kind: "value", value: descriptor.value }
    : { kind: "accessor" };
};

const ownValue = (value: object, key: PropertyKey): unknown => {
  const read = readOwnValue(value, key);
  return read.kind === "value" ? read.value : undefined;
};

type OptionalNumberRead =
  | Readonly<{ ok: false }>
  | Readonly<{ ok: true; value?: number }>;

const readOptionalNumber = (
  source: object,
  key: PropertyKey
): OptionalNumberRead => {
  const read = readOwnValue(source, key);
  if (read.kind === "missing") {
    return { ok: true };
  }
  return read.kind === "value" && typeof read.value === "number"
    ? { ok: true, value: read.value }
    : { ok: false };
};

type NormalizedLimitInput = Readonly<{
  hasUnknown: boolean;
  values: Readonly<Record<SourcingLimitName, unknown>>;
}>;

type NormalizedQuote = Readonly<{
  expiresAt: number;
  guarantee: string;
  pricingVersion: string;
  quoteId: string;
  unit: string;
  upperBound?: number;
}>;

type NormalizedUnknownCostPolicy = Readonly<{
  hardCap?: number;
  mode: "deny" | "explicit-non-interactive";
}>;

type NormalizedSourcingBudgetPreflightFacts = Readonly<{
  budget: BudgetLimit;
  deadline: number;
  limits: NormalizedLimitInput;
  now: number;
  quote: NormalizedQuote;
  unknownCostPolicy: NormalizedUnknownCostPolicy;
}>;

const normalizeLimits = (
  source: Record<PropertyKey, unknown>
): NormalizedLimitInput | undefined => {
  const reads = {
    maxCalls: readOwnValue(source, "maxCalls"),
    maxCompanies: readOwnValue(source, "maxCompanies"),
    maxContactsPerCompany: readOwnValue(source, "maxContactsPerCompany"),
    maxContactsTotal: readOwnValue(source, "maxContactsTotal"),
    maxEnrichments: readOwnValue(source, "maxEnrichments"),
    maxPages: readOwnValue(source, "maxPages"),
    maxPhones: readOwnValue(source, "maxPhones"),
    maxResults: readOwnValue(source, "maxResults"),
  };
  if (SOURCING_LIMIT_NAMES.some((name) => reads[name].kind === "accessor")) {
    return;
  }
  const limitValue = (name: SourcingLimitName): unknown => {
    const read = reads[name];
    return read.kind === "value" ? read.value : undefined;
  };
  return {
    hasUnknown: Reflect.ownKeys(source).some(
      (name) => typeof name !== "string" || !KNOWN_LIMIT_NAMES.has(name)
    ),
    values: {
      maxCalls: limitValue("maxCalls"),
      maxCompanies: limitValue("maxCompanies"),
      maxContactsPerCompany: limitValue("maxContactsPerCompany"),
      maxContactsTotal: limitValue("maxContactsTotal"),
      maxEnrichments: limitValue("maxEnrichments"),
      maxPages: limitValue("maxPages"),
      maxPhones: limitValue("maxPhones"),
      maxResults: limitValue("maxResults"),
    },
  };
};

const normalizeFacts = (
  value: unknown
): NormalizedSourcingBudgetPreflightFacts | undefined => {
  if (!isRecord(value)) {
    return;
  }

  const budgetSource = ownValue(value, "budget");
  const limitsSource = ownValue(value, "limits");
  const quoteSource = ownValue(value, "quote");
  const unknownCostPolicySource = ownValue(value, "unknownCostPolicy");
  const sourcesAreRecords =
    isRecord(budgetSource) &&
    isRecord(limitsSource) &&
    isRecord(quoteSource) &&
    isRecord(unknownCostPolicySource);
  if (!sourcesAreRecords) {
    return;
  }

  const deadline = ownValue(value, "deadline");
  const now = ownValue(value, "now");
  const budgetLimit = ownValue(budgetSource, "limit");
  const budgetReserved = ownValue(budgetSource, "reserved");
  const budgetSpent = ownValue(budgetSource, "spent");
  const budgetUnit = ownValue(budgetSource, "unit");
  const quoteExpiresAt = ownValue(quoteSource, "expiresAt");
  const quoteGuarantee = ownValue(quoteSource, "guarantee");
  const pricingVersion = ownValue(quoteSource, "pricingVersion");
  const quoteId = ownValue(quoteSource, "quoteId");
  const quoteUnit = ownValue(quoteSource, "unit");
  const unknownCostMode = ownValue(unknownCostPolicySource, "mode");
  if (
    typeof deadline !== "number" ||
    typeof now !== "number" ||
    typeof budgetLimit !== "number" ||
    typeof budgetReserved !== "number" ||
    typeof budgetSpent !== "number" ||
    typeof budgetUnit !== "string" ||
    typeof quoteExpiresAt !== "number" ||
    typeof quoteGuarantee !== "string" ||
    typeof pricingVersion !== "string" ||
    typeof quoteId !== "string" ||
    typeof quoteUnit !== "string" ||
    !(
      unknownCostMode === "deny" ||
      unknownCostMode === "explicit-non-interactive"
    )
  ) {
    return;
  }

  const upperBound = readOptionalNumber(quoteSource, "upperBound");
  const hardCap = readOptionalNumber(unknownCostPolicySource, "hardCap");
  const limits = normalizeLimits(limitsSource);
  if (!(upperBound.ok && hardCap.ok && limits)) {
    return;
  }
  if (unknownCostMode === "deny" && hardCap.value !== undefined) {
    return;
  }

  return {
    budget: {
      limit: budgetLimit,
      reserved: budgetReserved,
      spent: budgetSpent,
      unit: budgetUnit,
    },
    deadline,
    limits,
    now,
    quote: {
      expiresAt: quoteExpiresAt,
      guarantee: quoteGuarantee,
      pricingVersion,
      quoteId,
      unit: quoteUnit,
      ...(upperBound.value === undefined
        ? {}
        : { upperBound: upperBound.value }),
    },
    unknownCostPolicy: {
      mode: unknownCostMode,
      ...(hardCap.value === undefined ? {} : { hardCap: hardCap.value }),
    },
  };
};

const areValidLimits = (
  values: NormalizedLimitInput["values"]
): values is SourcingCardinalityLimits =>
  SOURCING_LIMIT_NAMES.every((name) => {
    const value = values[name];
    return (
      typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    );
  });

const readLimits = (
  input: NormalizedLimitInput,
  reasonCodes: SourcingBudgetPreflightReasonCode[]
): SourcingCardinalityLimits | undefined => {
  if (input.hasUnknown) {
    reasonCodes.push("limit-unknown");
  }

  const missing = SOURCING_LIMIT_NAMES.some(
    (name) => input.values[name] === undefined
  );
  if (missing) {
    reasonCodes.push("limit-missing");
  }

  const invalid = SOURCING_LIMIT_NAMES.some((name) => {
    const value = input.values[name];
    return (
      value !== undefined &&
      (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    );
  });
  if (invalid) {
    reasonCodes.push("limit-invalid");
  }

  if (missing || invalid || !areValidLimits(input.values)) {
    return;
  }

  const limits: SourcingCardinalityLimits = {
    maxCalls: input.values.maxCalls,
    maxCompanies: input.values.maxCompanies,
    maxContactsPerCompany: input.values.maxContactsPerCompany,
    maxContactsTotal: input.values.maxContactsTotal,
    maxEnrichments: input.values.maxEnrichments,
    maxPages: input.values.maxPages,
    maxPhones: input.values.maxPhones,
    maxResults: input.values.maxResults,
  };
  const contactCapacity = limits.maxCompanies * limits.maxContactsPerCompany;
  if (!Number.isSafeInteger(contactCapacity)) {
    reasonCodes.push("limit-overflow");
    return;
  }
  const hasCompanyContactCapacity =
    limits.maxCompanies > 0 && limits.maxContactsPerCompany > 0;
  const hasPartialCompanyContactCapacity =
    limits.maxCompanies > 0 !== limits.maxContactsPerCompany > 0;
  const hasPerCompanyCapacityWithoutCompanies =
    limits.maxCompanies === 0 && limits.maxContactsPerCompany > 0;
  if (
    hasPerCompanyCapacityWithoutCompanies ||
    (limits.maxContactsTotal > 0 && hasPartialCompanyContactCapacity) ||
    (hasCompanyContactCapacity && limits.maxContactsTotal > contactCapacity) ||
    limits.maxEnrichments > limits.maxContactsTotal ||
    limits.maxPhones > limits.maxEnrichments ||
    limits.maxPages > limits.maxCalls
  ) {
    reasonCodes.push("limits-inconsistent");
  }
  return limits;
};

const budgetRemaining = (
  budget: BudgetLimit,
  reasonCodes: SourcingBudgetPreflightReasonCode[]
): number | undefined => {
  const valid =
    budget.unit.trim().length > 0 &&
    isAmount(budget.limit) &&
    isAmount(budget.spent) &&
    isAmount(budget.reserved) &&
    budget.spent + budget.reserved <= budget.limit;
  if (!valid) {
    reasonCodes.push("budget-invalid");
    return;
  }
  return budget.limit - budget.spent - budget.reserved;
};

const quoteGuarantee = (value: string): CostQuote["guarantee"] | undefined => {
  if (value === "hard" || value === "estimated" || value === "unknown") {
    return value;
  }
};

type QuoteEvaluation = Readonly<{
  hardExecutionCap?: number;
  quote?: CostQuote;
}>;

const validatedQuote = (quote: NormalizedQuote): CostQuote | undefined => {
  const guarantee = quoteGuarantee(quote.guarantee);
  if (
    quote.quoteId.trim().length === 0 ||
    quote.unit.trim().length === 0 ||
    quote.pricingVersion.trim().length === 0 ||
    guarantee === undefined ||
    !Number.isSafeInteger(quote.expiresAt) ||
    quote.expiresAt < 0 ||
    (quote.upperBound !== undefined && !isAmount(quote.upperBound))
  ) {
    return;
  }
  return {
    expiresAt: instant(quote.expiresAt),
    guarantee,
    pricingVersion: quote.pricingVersion,
    quoteId: quote.quoteId,
    unit: quote.unit,
    ...(quote.upperBound === undefined ? {} : { upperBound: quote.upperBound }),
  };
};

const evaluateQuote = (
  facts: NormalizedSourcingBudgetPreflightFacts,
  remainingBudget: number | undefined,
  reasonCodes: SourcingBudgetPreflightReasonCode[]
): QuoteEvaluation => {
  const { quote } = facts;
  const normalizedQuote = validatedQuote(quote);
  if (normalizedQuote === undefined) {
    reasonCodes.push("quote-invalid");
    return {};
  }
  if (quote.expiresAt <= facts.now) {
    reasonCodes.push("quote-expired");
  }
  if (quote.unit !== facts.budget.unit) {
    reasonCodes.push("quote-unit-mismatch");
  }
  if (
    normalizedQuote.guarantee !== "unknown" &&
    quote.upperBound === undefined
  ) {
    reasonCodes.push("quote-upper-bound-required");
  }
  if (
    remainingBudget !== undefined &&
    quote.upperBound !== undefined &&
    quote.upperBound > remainingBudget
  ) {
    reasonCodes.push("quote-exceeds-budget");
  }

  if (normalizedQuote.guarantee === "unknown") {
    if (facts.unknownCostPolicy.mode !== "explicit-non-interactive") {
      reasonCodes.push("unknown-cost-authorization-required");
      return { quote: normalizedQuote };
    }
    const { hardCap } = facts.unknownCostPolicy;
    if (hardCap === undefined) {
      reasonCodes.push("unknown-cost-hard-cap-required");
      return { quote: normalizedQuote };
    }
    if (
      !isAmount(hardCap) ||
      (remainingBudget !== undefined && hardCap > remainingBudget)
    ) {
      reasonCodes.push("unknown-cost-hard-cap-invalid");
      return { quote: normalizedQuote };
    }
    return { hardExecutionCap: hardCap, quote: normalizedQuote };
  }

  if (quote.upperBound === undefined || remainingBudget === undefined) {
    return { quote: normalizedQuote };
  }
  return {
    hardExecutionCap:
      normalizedQuote.guarantee === "hard"
        ? Math.min(quote.upperBound, remainingBudget)
        : remainingBudget,
    quote: normalizedQuote,
  };
};

const evaluateSafeSourcingBudgetPreflight = (
  facts: NormalizedSourcingBudgetPreflightFacts
): SourcingBudgetPreflightDecision => {
  const reasonCodes: SourcingBudgetPreflightReasonCode[] = [];
  const limits = readLimits(facts.limits, reasonCodes);

  const instantsAreValid =
    Number.isSafeInteger(facts.now) &&
    facts.now >= 0 &&
    Number.isSafeInteger(facts.deadline) &&
    facts.deadline >= 0;
  if (!instantsAreValid) {
    reasonCodes.push("deadline-invalid");
  } else if (facts.deadline <= facts.now) {
    reasonCodes.push("deadline-elapsed");
  }

  const remainingBudget = budgetRemaining(facts.budget, reasonCodes);
  const quote = evaluateQuote(facts, remainingBudget, reasonCodes);
  const allowed = reasonCodes.length === 0;

  if (
    !(allowed && limits && quote.hardExecutionCap !== undefined && quote.quote)
  ) {
    return {
      allowed: false,
      reasonCodes,
      stopExternalEffects: true,
      stopFallback: true,
    };
  }

  return {
    allowed: true,
    reasonCodes: ["allowed"],
    snapshot: {
      budget: facts.budget,
      deadline: instant(facts.deadline),
      hardExecutionCap: quote.hardExecutionCap,
      limits,
      quote: quote.quote,
    },
    stopExternalEffects: false,
    stopFallback: false,
  };
};

const invalidInputDecision = (): SourcingBudgetPreflightDecision => ({
  allowed: false,
  reasonCodes: ["input-invalid"],
  stopExternalEffects: true,
  stopFallback: true,
});

export const evaluateSourcingBudgetPreflight = (
  facts: SourcingBudgetPreflightFacts
): SourcingBudgetPreflightDecision => {
  try {
    const normalized = normalizeFacts(facts);
    return normalized
      ? evaluateSafeSourcingBudgetPreflight(normalized)
      : invalidInputDecision();
  } catch {
    return invalidInputDecision();
  }
};
