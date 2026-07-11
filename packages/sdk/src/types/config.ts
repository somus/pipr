import type { RuntimeLimits } from "./manifest.js";

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

/** Options for registering a model provider and model id. */
export type ModelOptions = {
  id?: string;
  provider: string;
  model: string;
  apiKey?: SecretRef;
  options?: Record<string, unknown>;
};

/** Registered model profile that can be used by reviewers and agents. */
export type ModelProfile = {
  readonly kind: "pipr.model";
  readonly id: string;
  readonly provider: string;
  readonly model: string;
  readonly apiKey?: SecretRef;
  readonly options?: Record<string, unknown>;
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
  autoResolve?: AutoResolveOptions;
  showHeader?: boolean;
  showFooter?: boolean;
  showStats?: boolean;
};

/** Top-level pipr config settings. */
export type PiprConfigOptions = {
  publication?: PublicationOptions;
  checks?: ChecksOptions;
  limits?: RuntimeLimits;
};
