import type { RuntimeLimits } from "./manifest.js";

export const defaultMaxStoredFindings = 50;
export const maxStoredFindingsLimit = 100;
export const modelThinkingLevels = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;
export type ModelThinkingLevel = (typeof modelThinkingLevels)[number];

/** Repository permission levels used to authorize pipr commands. */
export type RepositoryPermission = "read" | "triage" | "write" | "maintain" | "admin";

/** Pull request lifecycle actions that can trigger change-request tasks. */
export type ChangeRequestAction = "opened" | "updated" | "reopened" | "ready" | "closed";

/** Duration accepted by timeout options, either seconds as a number or a suffixed string. */
export type DurationInput = number | `${number}s` | `${number}m` | `${number}h`;

/** Reference to a secret that pipr resolves from the runtime environment. */
export type SecretRef = {
  readonly kind: "pipr.secret";
  readonly name: string;
};

/** Options for declaring a secret by environment variable name. */
export type SecretOptions = {
  name: string;
};

/** Model reference in `provider/model` form, for example `deepseek/deepseek-v4-pro`. */
export type ModelRef = `${string}/${string}`;

/**
 * API key source for a model. Omit to read the provider's standard environment variable (for
 * example `DEEPSEEK_API_KEY`), pass `pipr.secret(...)` to read another variable, or pass `"local"`
 * to use local Pi login credentials.
 */
export type ModelApiKey = SecretRef | "local";

/** Options for registering a model. */
export type ModelOptions = {
  id?: string;
  apiKey?: ModelApiKey;
  thinking?: ModelThinkingLevel;
};

/** Registered model profile that can be used by reviewers and agents. */
export type ModelProfile = {
  readonly kind: "pipr.model";
  readonly id: string;
  readonly provider: string;
  readonly model: string;
  readonly apiKey?: ModelApiKey;
  readonly thinking?: ModelThinkingLevel;
};

/** Aggregate check-run options for a Pipr review run. */
export type AggregateCheckOptions =
  | false
  | {
      enabled?: boolean;
      name?: string;
    };

/** Check-run settings for a pipr config. */
export type ChecksOptions = {
  aggregate?: AggregateCheckOptions;
};

/** Actor policy for auto-resolving inline review threads from user replies. */
export type AutoResolveAllowedActors = "author-or-write" | "write" | "any";

/** Options controlling auto-resolve behavior for user replies. */
export type AutoResolveUserRepliesOptions = {
  enabled?: boolean;
  respondWhenStillValid?: boolean;
  allowedActors?: AutoResolveAllowedActors;
};

/** Options controlling automatic stale-finding resolution. */
export type AutoResolveOptions =
  | false
  | {
      enabled?: boolean;
      model?: ModelProfile;
      instructions?: string;
      synchronize?: boolean;
      userReplies?: boolean | AutoResolveUserRepliesOptions;
    };

/** Review publication settings. */
export type PublicationOptions = {
  maxInlineComments?: number;
  maxStoredFindings?: number;
  autoResolve?: AutoResolveOptions;
  showHeader?: boolean;
  showFooter?: boolean;
  showStats?: boolean;
  showProgress?: boolean;
};

/** Top-level pipr config settings. */
export type PiprConfigOptions = {
  publication?: PublicationOptions;
  checks?: ChecksOptions;
  limits?: RuntimeLimits;
};
