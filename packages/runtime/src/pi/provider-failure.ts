import type { ProviderConfig } from "../types.js";

export type ProviderFailureRemediation = {
  category:
    | "billing-quota"
    | "authentication"
    | "rate-limit"
    | "model-unavailable"
    | "provider-unavailable";
  reason: string;
  nextStep: string;
};

export class ProviderExecutionError extends Error {
  constructor(
    message: string,
    readonly remediation?: ProviderFailureRemediation,
  ) {
    super(message);
    this.name = "ProviderExecutionError";
  }
}

export function providerFailureRemediation(error: unknown): ProviderFailureRemediation | undefined {
  return error instanceof ProviderExecutionError ? error.remediation : undefined;
}

const providerFailurePrecedence: ProviderFailureRemediation["category"][] = [
  "billing-quota",
  "authentication",
  "rate-limit",
  "model-unavailable",
  "provider-unavailable",
];

export function preferredProviderFailureRemediation(
  current: ProviderFailureRemediation | undefined,
  candidate: ProviderFailureRemediation | undefined,
): ProviderFailureRemediation | undefined {
  if (!current) return candidate;
  if (!candidate) return current;
  return providerFailurePrecedence.indexOf(candidate.category) <
    providerFailurePrecedence.indexOf(current.category)
    ? candidate
    : current;
}

const billingQuotaPattern =
  /\b(?:credits?error|freeusagelimiterror|insufficient(?:[_ ]quota| balance)|credit balance is too low|spending cap|payment required|quota(?:[_ ](?:exhausted|exceeded))|resource_exhausted)\b/i;
const authenticationPattern =
  /\b(?:invalid (?:api key|authentication|credentials)|unauthorized|forbidden|no auth credentials|authentication failed|oauth token expired|token expired)\b/i;
const rateLimitPattern = /\brate[_ ]limit(?:ed| exceeded)?\b/i;
const modelUnavailablePattern =
  /\b(?:providermodelnotfounderror|model (?:not found|unavailable|does not exist|unsupported))\b/i;
const providerUnavailablePattern =
  /\b(?:service unavailable|provider unavailable|internal server error)\b/i;
const authenticationStatusPattern = providerStatusPattern("401|403");
const rateLimitStatusPattern = providerStatusPattern("429");
const providerUnavailableStatusPattern = providerStatusPattern("500|502|503|504");

function providerStatusPattern(statuses: string): RegExp {
  return new RegExp(
    `\\b(?:api|http|provider)(?:\\s+(?:error|status|response|code))?\\s*(?:[:=#-]\\s*)?(?:${statuses})\\b`,
    "i",
  );
}

export function classifyProviderFailure(options: {
  provider: ProviderConfig;
  output: string;
}): ProviderFailureRemediation | undefined {
  const provider = options.provider.provider;
  if (billingQuotaPattern.test(options.output)) {
    return {
      category: "billing-quota",
      reason: `${provider} rejected the run because billing or quota is exhausted.`,
      nextStep: `Restore credit or quota in the ${provider} account, then rerun.`,
    };
  }
  if (
    authenticationPattern.test(options.output) ||
    authenticationStatusPattern.test(options.output)
  ) {
    return {
      category: "authentication",
      reason: `${provider} authentication failed.`,
      nextStep: options.provider.apiKeyEnv
        ? `Verify the configured ${options.provider.apiKeyEnv} secret or environment variable and ${provider} account access, then rerun.`
        : `Refresh the stored ${provider} subscription session credential, then rerun.`,
    };
  }
  if (rateLimitPattern.test(options.output) || rateLimitStatusPattern.test(options.output)) {
    return {
      category: "rate-limit",
      reason: `${provider} rate limit was reached.`,
      nextStep: "Wait for the provider rate limit to reset, then rerun.",
    };
  }
  if (modelUnavailablePattern.test(options.output)) {
    return {
      category: "model-unavailable",
      reason: `The configured ${provider} model is unavailable.`,
      nextStep: "Select an available model in .pipr/config.ts, then rerun.",
    };
  }
  if (
    providerUnavailablePattern.test(options.output) ||
    providerUnavailableStatusPattern.test(options.output)
  ) {
    return {
      category: "provider-unavailable",
      reason: `${provider} is temporarily unavailable.`,
      nextStep: "Wait for the provider to recover, then rerun.",
    };
  }
  return undefined;
}
