import type { FindingFields, FindingSchema } from "../finding.js";
import type { PiprRunContext } from "../result.js";
import type { ReviewFinding, ReviewSummary } from "../review-contract.js";
import type {
  Agent,
  AgentDefinition,
  AgentTool,
  BuiltinSchemaCatalog,
  BuiltinToolCatalog,
} from "./agent.js";
import type {
  ChangeRequestAction,
  DurationInput,
  ModelOptions,
  ModelProfile,
  ModelRef,
  PiprConfigOptions,
  RepositoryPermission,
  SecretOptions,
  SecretRef,
} from "./config.js";
import type {
  ChangedFile,
  DiffContext,
  DiffManifestOptions,
  DiffSummary,
  PathFilter,
} from "./manifest.js";
import type {
  JsonPromptOptions,
  Markdown,
  PromptSource,
  PromptText,
  PromptValue,
} from "./prompt.js";
import type { JsonSchemaDefinition, Schema, SchemaDefinition, ZodSchema } from "./schema.js";

/** Final review comment value produced by a task or review recipe. */
export type CommentValue =
  | Markdown
  | {
      main: Markdown;
      inlineFindings?: readonly ReviewFinding[];
    }
  | {
      main?: never;
      inlineFindings: readonly ReviewFinding[];
    };

/** Prior inline finding persisted by earlier pipr review state. */
export type PriorInlineFinding = {
  id: string;
  status: "open" | "resolved";
  path: string;
  rangeId: string;
  side: "RIGHT" | "LEFT";
  startLine: number;
  endLine: number;
};

/** Prior pipr review state available to tasks through `ctx.review.prior()`. */
export type PriorReview = {
  main?: string;
  reviewedHeadSha?: string;
  inlineFindings: readonly PriorInlineFinding[];
};

/** Optional path scope applied while validating review findings. */
export type ValidateFindingsOptions = {
  paths?: PathFilter;
};

type ValidatedReviewFinding<T extends ReviewFinding> = T extends unknown
  ? Omit<T, "rangeId"> & Pick<ReviewFinding, "rangeId">
  : never;

/** One review finding rejected by runtime validation. */
export type DroppedReviewFinding<T extends ReviewFinding = ReviewFinding> = {
  finding: ValidatedReviewFinding<T>;
  reason: string;
};

/** Findings accepted and rejected by runtime validation. */
export type ValidatedReviewFindings<T extends ReviewFinding = ReviewFinding> = {
  validFindings: readonly ValidatedReviewFinding<T>[];
  droppedFindings: readonly DroppedReviewFinding<T>[];
};

/** Options for `ctx.review.select`. */
export type SelectFindingsOptions<T extends ReviewFinding> = {
  /** Finding schema from `pipr.finding`; its enum fields rank findings in declaration order. */
  finding?: ZodSchema<unknown>;
  /** Facet keys to rank by, highest priority first. Defaults to every enum field in order. */
  rank?: readonly string[];
  /** Custom ordering; replaces facet ranking. Earlier findings win duplicates and the cap. */
  compare?: (left: ValidatedReviewFinding<T>, right: ValidatedReviewFinding<T>) => number;
  /** Maximum findings to keep. Defaults to `publication.maxInlineComments`. */
  limit?: number;
  paths?: PathFilter;
  /** Drops findings whose `suggestedFix` is missing or cannot be published as an exact suggestion. */
  requireSuggestedFix?: boolean;
};

/** Findings kept by `ctx.review.select`, plus every dropped finding with its reason. */
export type SelectedReviewFindings<T extends ReviewFinding = ReviewFinding> = {
  findings: readonly ValidatedReviewFinding<T>[];
  dropped: readonly DroppedReviewFinding<T>[];
};

/** Options for `ctx.check.gate`. */
export type CheckGateOptions<T extends ReviewFinding> = {
  /** Facet values that block, such as `{ severity: ["critical", "high"] }`, or a predicate. */
  failOn: Readonly<Record<string, readonly string[]>> | ((finding: T) => boolean);
  /** Check summary; defaults to a count of blocking findings. */
  summary?: (blocking: readonly T[]) => string;
};

/** Result of `ctx.check.gate`. */
export type CheckGateResult<T extends ReviewFinding> = {
  passed: boolean;
  blocking: readonly T[];
};

/** Function run by a task entrypoint. */
export type TaskHandler<Input> = (context: TaskContext, input: Input) => void | Promise<void>;

/** Check-run publication options for one task. */
export type TaskCheckOptions =
  | false
  | {
      enabled?: boolean;
      name?: string;
      required?: boolean;
    };

/** Command trigger: a pattern such as `@pipr review`, or a pattern with options. */
export type CommandTrigger<Input> = string | (CommandOptions<Input> & { pattern: string });

/** Events that start a task. */
export type TaskTriggers<Input> = {
  /** Change request actions; `true` uses opened, updated, reopened, and ready. */
  changeRequest?: [Input] extends [void] ? readonly ChangeRequestAction[] | true : never;
  command?: CommandTrigger<Input>;
};

/** Definition used to register a task. */
export type TaskDefinition<Input> = {
  name: string;
  on?: TaskTriggers<Input>;
  check?: TaskCheckOptions;
  local?: false;
  run: TaskHandler<Input>;
};

declare const taskHandleBrand: unique symbol;

/** Opaque registered task handle selected by change-request and command entrypoints. */
export type Task<Input = void> = {
  readonly kind: "pipr.task";
  readonly name: string;
  readonly [taskHandleBrand]: (input: Input) => Input;
};

/** Options shared by command registrations. */
export type CommandOptions<Input> = {
  permission?: RepositoryPermission;
  description?: string;
  parse?: (arguments_: Record<string, string>) => Input;
};

/** Definition used to register an `@pipr` command. */
export type CommandRegistrationOptions<Input> = CommandOptions<Input> & {
  pattern: string;
  task: Task<Input>;
};

/** Default change-request actions for `on: { changeRequest: true }` and `pipr.review`. */
export const defaultReviewActions = [
  "opened",
  "updated",
  "reopened",
  "ready",
] as const satisfies readonly ChangeRequestAction[];

/** Default triggers used by `pipr.review`. */
export const defaultReviewTriggers = {
  changeRequest: defaultReviewActions,
  command: { pattern: "@pipr review", permission: "write" },
} as const satisfies TaskTriggers<void>;

/** Input passed to the findings agent created by `pipr.review`. */
export type ReviewFindingsInput = {
  diff: DiffContext;
  change: ChangeRequestInfo;
};

/** Input passed to a `pipr.review` summary agent. */
export type ReviewSummaryInput<Finding extends ReviewFinding = ReviewFinding> = {
  diff: DiffSummary;
  change: ChangeRequestInfo;
  findings: readonly Finding[];
};

/** Summary step for `pipr.review`: built-in agent instructions, or a custom agent. */
export type ReviewSummaryOptions<Finding extends ReviewFinding, Summary> =
  | { instructions: PromptSource; agent?: never }
  | { agent: Agent<ReviewSummaryInput<Finding>, Summary>; instructions?: never };

/** Values passed to a `pipr.review` renderer. */
export type ReviewRenderInput<Finding extends ReviewFinding, Summary> = {
  findings: readonly Finding[];
  dropped: readonly DroppedReviewFinding<Finding>[];
  summary?: Summary;
};

/** Options for `pipr.review`, a preset over `ctx.change.diff`, `ctx.pi.run`, `ctx.review.select`, and `ctx.comment`. */
export type ReviewOptions<
  Finding extends ReviewFinding = ReviewFinding,
  Summary = ReviewSummary,
> = {
  id: string;
  /** Defaults to change request opened, updated, reopened, ready, and `@pipr review`. */
  on?: TaskTriggers<void>;
  /** Defaults to the first registered model. */
  model?: ModelProfile;
  fallbacks?: readonly ModelProfile[];
  tools?: readonly AgentTool[];
  timeout?: DurationInput;
  check?: TaskCheckOptions;
  paths?: PathFilter;
  /** Finding schema from `pipr.finding`; enum fields rank findings and label comments. */
  finding?: ZodSchema<Finding>;
  /** Findings-agent policy. */
  instructions: PromptSource;
  summary?: ReviewSummaryOptions<Finding, Summary>;
  gate?: CheckGateOptions<Finding>;
  render?: (
    result: ReviewRenderInput<Finding, Summary>,
    context: ReviewCommentContext,
  ) => CommentValue | Promise<CommentValue>;
};

/** Context passed to a custom review comment renderer. */
export type ReviewCommentContext = {
  review: { id: string };
  run: PiprRunContext;
  repository: RepositoryInfo;
  change: ChangeRequestContext;
  platform: PlatformInfo;
};

/** Plugin installer returned by `definePlugin`. */
export type PiprPlugin<Handle> = {
  setup(builder: PiprBuilder): Handle;
};

/** Definition for a custom tool registered by config or plugins. */
export type PluginToolDefinition<Input, Output> = {
  name: string;
  description: string;
  input: Schema<Input>;
  output: Schema<Output>;
  run(options: ToolRunOptions<Input>): Output | Promise<Output>;
  toModelOutput?(output: Output): PromptValue;
};

/** Runtime input passed to a tool implementation. */
export type ToolRunOptions<Input> = {
  input: Input;
  ctx: TaskContext;
  signal?: AbortSignal;
};

/** Handle for reporting task check status from inside a task. */
export type CheckHandle = {
  pass(summary?: string): void;
  fail(summary?: string): void;
  neutral(summary?: string): void;
  /** Fails the check when any finding matches `failOn`, otherwise passes it. */
  gate<T extends ReviewFinding>(
    findings: readonly T[],
    options: CheckGateOptions<T>,
  ): CheckGateResult<T>;
};

/** Builder API available inside `definePipr`. */
export type PiprBuilder = {
  readonly tools: BuiltinToolCatalog;
  readonly schemas: BuiltinSchemaCatalog;
  secret(options: SecretOptions): SecretRef;
  model(ref: ModelRef, options?: ModelOptions): ModelProfile;
  /** Declares an inline finding schema; enum fields become rankable facets in declaration order. */
  finding<const Fields extends FindingFields>(fields: Fields): FindingSchema<Fields>;
  agent<Input, Output>(definition: AgentDefinition<Input, Output>): Agent<Input, Output>;
  task<Input = void>(definition: TaskDefinition<Input>): Task<Input>;
  review<Finding extends ReviewFinding = ReviewFinding, Summary = ReviewSummary>(
    options: ReviewOptions<Finding, Summary>,
  ): Task;
  config(options: PiprConfigOptions): void;
  command<Input = void>(options: CommandRegistrationOptions<Input>): void;
  use<Handle>(plugin: PiprPlugin<Handle>): Handle;
  tool<Input, Output>(definition: PluginToolDefinition<Input, Output>): AgentTool<Input, Output>;
  schema<T>(definition: SchemaDefinition<T>): Schema<T>;
  jsonSchema<T>(definition: JsonSchemaDefinition): Schema<T>;
  prompt(strings: TemplateStringsArray, ...values: PromptValue[]): PromptText;
  section(title: string, value: PromptValue): PromptText;
  json(value: unknown, options?: JsonPromptOptions): PromptText;
};

/** Repository metadata available to tasks and agents. */
export type RepositoryInfo = {
  root: string;
  owner?: string;
  name: string;
  defaultBranch?: string;
  remoteUrl?: string;
};

/** Pull request or change-request metadata available to tasks and agents. */
export type ChangeRequestInfo = {
  number?: number;
  title: string;
  description: string;
  url?: string;
  author?: { login: string };
  base: { ref?: string; sha: string };
  head: { ref?: string; sha: string };
  isFork?: boolean;
};

/** Code hosting platform metadata. */
export type PlatformInfo = {
  id: string;
};

/** Change-request context available inside tasks. */
export type ChangeRequestContext = ChangeRequestInfo & {
  /** Returns the change's Diff Manifest as agent-ready context. */
  diff(options?: DiffManifestOptions): Promise<DiffContext>;
  changedFiles(): Promise<readonly ChangedFile[]>;
};

/** Runner for invoking Pi agents from tasks. */
export type PiRunner = {
  run<Input, Output>(
    agent: Agent<Input, Output>,
    input: Input,
    options?: PiRunOptions,
  ): Promise<Output>;
  /**
   * Runs agents concurrently. The agent-run budget is reserved for every run before any starts,
   * and runs that share a `DiffContext` share its prompt prefix.
   */
  all<const Runs extends readonly PiRunRequest[]>(
    runs: Runs & CheckedPiRunRequests<Runs>,
  ): Promise<PiRunOutputs<Runs>>;
};

/** Per-call overrides for `ctx.pi.run` and `ctx.pi.all`. */
export type PiRunOptions = {
  model?: ModelProfile;
  fallbacks?: readonly ModelProfile[];
  instructions?: PromptSource;
  timeout?: DurationInput;
  paths?: PathFilter;
  maxShards?: number;
};

/** One run passed to `ctx.pi.all`. */
export type PiRunRequest = {
  agent: Agent<never, unknown>;
  input: unknown;
  options?: PiRunOptions;
};

type CheckedPiRunRequests<Runs extends readonly PiRunRequest[]> = {
  [Index in keyof Runs]: Runs[Index] extends { agent: Agent<infer Input, unknown> }
    ? { agent: Runs[Index]["agent"]; input: Input; options?: PiRunOptions }
    : Runs[Index];
};

/** Outputs of `ctx.pi.all`, in request order. */
export type PiRunOutputs<Runs extends readonly PiRunRequest[]> = {
  -readonly [Index in keyof Runs]: Runs[Index] extends { agent: Agent<never, infer Output> }
    ? Output
    : never;
};

/** Command context available inside command-triggered tasks. */
export type CommandContext = {
  readonly name: string;
  readonly line: string;
  readonly arguments: Record<string, string>;
  reply(markdown: Markdown): Promise<void>;
};

/** Context object passed to task handlers. */
export type TaskContext = {
  /** Stable identity and trigger for the selected Review Run, not the process attempt. */
  readonly run: PiprRunContext;
  readonly repository: RepositoryInfo;
  readonly change: ChangeRequestContext;
  readonly platform: PlatformInfo;
  readonly pi: PiRunner;
  readonly command?: CommandContext;
  secret(secret: SecretRef): string;
  readonly review: {
    prior(): Promise<PriorReview>;
    validateFindings<T extends ReviewFinding>(
      findings: readonly T[],
      options?: ValidateFindingsOptions,
    ): ValidatedReviewFindings<T>;
    /**
     * Validates findings against the Diff Manifest, drops duplicate locations, ranks, and caps
     * them. Accepts one list or one list per agent.
     */
    select<T extends ReviewFinding>(
      findings: readonly T[] | readonly (readonly T[])[],
      options?: SelectFindingsOptions<T>,
    ): SelectedReviewFindings<T>;
  };
  readonly check: CheckHandle;
  comment(value: CommentValue): Promise<void>;
  readonly log: {
    info(message: string): void;
    warn(message: string): void;
    error(message: string): void;
  };
};
