import { z } from "zod";
import type { ReviewFinding, ReviewResult, ReviewSummary } from "./review-contract.js";

export { definePipr, definePlugin } from "./builder.js";
export { md } from "./prompt.js";
export type { ReviewFinding, ReviewResult, ReviewSummary } from "./review-contract.js";
export {
  parseReviewFinding,
  parseReviewResult,
  parseReviewSummary,
  reviewFindingSchema,
  reviewResultSchema,
  reviewSchemaExample,
  reviewSummarySchema,
} from "./review-contract.js";
export { jsonSchema, schema, schemas } from "./schema.js";

export { z };

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

/** Primitive JSON value supported by JSON Schema based configuration. */
export type JsonPrimitive = string | number | boolean | null;
/** JSON value accepted by pipr schema and prompt helpers. */
export type JsonValue = JsonPrimitive | JsonValue[] | JsonObject;
/** JSON object accepted by pipr schema and prompt helpers. */
export type JsonObject = { [key: string]: JsonValue };
/** JSON Schema document or boolean schema. */
export type JsonSchema = JsonObject | boolean;

/** Result returned by `Schema.safeParse`. */
export type SchemaParseResult<T> = { success: true; data: T } | { success: false; error: Error };

/** Runtime schema wrapper used by pipr agents, tools, and user config. */
export type Schema<T> = {
  readonly kind: "pipr.schema";
  readonly id: string;
  readonly jsonSchema?: JsonSchema;
  parse(value: unknown): T;
  safeParse(value: unknown): SchemaParseResult<T>;
};

/** Zod schema type accepted by `pipr.schema` and built-in schema exports. */
export type ZodSchema<T> = z.ZodType<T>;

/** Markdown text accepted by review comments and command replies. */
export type Markdown = string;

/** Final review comment value produced by a task or review recipe. */
export type CommentValue =
  | Markdown
  | {
      main?: Markdown;
      inlineFindings?: readonly ReviewFinding[];
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
  main?: Markdown;
  reviewedHeadSha?: string;
  inlineFindings: readonly PriorInlineFinding[];
};

/** Include/exclude path filter for scoped reviews and Diff Manifest projection. */
export type PathFilter = {
  include?: string[];
  exclude?: string[];
};
/** Prompt text accepted by agent instructions and prompt functions. */
export type PromptSource = string | PromptText;
/** Value accepted by prompt rendering helpers. */
export type PromptValue = unknown;

/** Structured prompt text produced by `pipr.prompt`, `pipr.section`, or `pipr.json`. */
export type PromptText = {
  readonly kind: "pipr.prompt";
  readonly value: string;
};

/** Options for rendering a value as JSON prompt text. */
export type JsonPromptOptions = {
  pretty?: boolean;
  maxCharacters?: number;
};

/** Built-in tool catalog exposed on the pipr builder. */
export type BuiltinToolCatalog = {
  readonly readOnly: readonly AgentTool[];
};

/** Built-in schema catalog exposed on the pipr builder. */
export type BuiltinSchemaCatalog = {
  readonly review: Schema<ReviewResult>;
  readonly summary: Schema<ReviewSummary>;
};

/** Tool definition available to Pi agents at runtime. */
export type AgentTool<Input = unknown, Output = unknown> = {
  readonly kind: "pipr.tool";
  readonly name: string;
  readonly description?: string;
  readonly input?: Schema<Input>;
  readonly output?: Schema<Output>;
  run?(options: ToolRunOptions<Input>): Output | Promise<Output>;
  toModelOutput?(output: Output): PromptValue;
};

/** Context passed to an agent prompt function. */
export type AgentPromptContext = {
  runId: string;
  repository: RepositoryInfo;
  change: ChangeRequestInfo;
  platform: PlatformInfo;
};

/** Full definition for an agent pipr can run through Pi. */
export type AgentDefinition<Input, Output> = {
  name?: string;
  model?: ModelProfile;
  fallbacks?: ModelProfile[];
  instructions: PromptSource;
  prompt(input: Input, context: AgentPromptContext): PromptSource | Promise<PromptSource>;
  output: Schema<Output>;
  tools?: readonly AgentTool[];
  retry?: {
    invalidOutput?: number;
    transientFailure?: number;
  };
  timeout?: DurationInput;
};

/** Partial patch accepted by `agent.extend`. */
export type AgentExtension<Input, Output> = Partial<AgentDefinition<Input, Output>> & {
  instructions?: PromptSource;
};

/** Registered Pi agent with typed input and output. */
export type Agent<Input = unknown, Output = unknown> = {
  readonly kind: "pipr.agent";
  readonly name?: string;
  readonly definition: AgentDefinition<Input, Output>;
  extend(patch: AgentExtension<Input, Output>): Agent<Input, Output>;
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

/** Definition used to register a task. */
export type TaskDefinition<Input> = {
  name: string;
  check?: TaskCheckOptions;
  local?: false;
  run: TaskHandler<Input>;
};

/** Registered task that can be selected by change-request and command entrypoints. */
export type Task<Input = void> = {
  readonly kind: "pipr.task";
  readonly name: string;
  readonly check?: TaskCheckOptions;
  readonly local?: false;
  readonly handler: TaskHandler<Input>;
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

/** Options for creating a reusable reviewer agent. */
export type ReviewerOptions = {
  name?: string;
  model: ModelProfile;
  fallbacks?: ModelProfile[];
  instructions: PromptSource;
  prompt?: (
    input: DefaultReviewInput,
    context: AgentPromptContext,
  ) => PromptSource | Promise<PromptSource>;
  tools?: readonly AgentTool[];
  timeout?: DurationInput;
};

/** Reviewer agent that emits pipr's core review result. */
export type Reviewer = Agent<DefaultReviewInput, ReviewResult>;

/** Entrypoints created by `pipr.review`. */
export type ReviewEntrypoints = {
  changeRequest?: ChangeRequestAction[] | false;
  command?:
    | string
    | false
    | {
        pattern?: string;
        permission?: RepositoryPermission;
        description?: string;
      };
};

type ReviewRecipeEntrypointOptions = {
  id: string;
  entrypoints?: ReviewEntrypoints;
  inlineComments?:
    | false
    | {
        max?: number;
      };
  comment?:
    | CommentValue
    | ((
        result: ReviewResult,
        context: ReviewCommentContext,
      ) => CommentValue | Promise<CommentValue>);
  check?: TaskCheckOptions;
  timeout?: DurationInput;
  paths?: PathFilter;
};

/** Options for `pipr.review`, pipr's default review recipe. */
export type ReviewRecipeOptions =
  | (ReviewRecipeEntrypointOptions & { reviewer: Reviewer })
  | (ReviewRecipeEntrypointOptions & ReviewerOptions & { reviewer?: undefined });

/** Default input passed to a reviewer created by `pipr.review`. */
export type DefaultReviewInput = {
  manifest: DiffManifest;
  change: ChangeRequestInfo;
};

/** Context passed to a custom review comment renderer. */
export type ReviewCommentContext = {
  review: { id: string };
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
  execute?(context: TaskContext, input: Input): Promise<Output>;
  run?(options: ToolRunOptions<Input>): Output | Promise<Output>;
  toModelOutput?(output: Output): PromptValue;
};

/** Runtime input passed to a tool implementation. */
export type ToolRunOptions<Input> = {
  input: Input;
  ctx: TaskContext;
  signal?: AbortSignal;
};

/** Definition used to register a task for pull request actions. */
export type ChangeRequestRegistrationOptions<Input> = {
  actions: ChangeRequestAction[];
  task: Task<Input>;
};

/** Zod-backed schema registration. */
export type SchemaDefinition<T> = {
  id: string;
  schema: ZodSchema<T>;
};

/** JSON Schema backed schema registration. */
export type JsonSchemaDefinition = {
  id: string;
  schema: JsonSchema;
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
};

/** Top-level pipr config settings. */
export type PiprConfigOptions = {
  publication?: PublicationOptions;
  checks?: ChecksOptions;
  limits?: RuntimeLimits;
};

/** Handle for reporting task check status from inside a task. */
export type CheckHandle = {
  pass(summary?: string): void;
  fail(summary?: string): void;
  neutral(summary?: string): void;
};

/** Builder API available inside `definePipr`. */
export type PiprBuilder = {
  readonly tools: BuiltinToolCatalog;
  readonly schemas: BuiltinSchemaCatalog;
  readonly on: {
    changeRequest<Input = void>(options: ChangeRequestRegistrationOptions<Input>): void;
  };
  secret(options: SecretOptions): SecretRef;
  model(options: ModelOptions): ModelProfile;
  agent<Input, Output>(definition: AgentDefinition<Input, Output>): Agent<Input, Output>;
  task<Input = void>(definition: TaskDefinition<Input>): Task<Input>;
  reviewer(options: ReviewerOptions): Reviewer;
  review(options: ReviewRecipeOptions): void;
  config(options: PiprConfigOptions): void;
  command<Input = void>(options: CommandRegistrationOptions<Input>): void;
  checks(options: ChecksOptions): void;
  limits(options: RuntimeLimits): void;
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

/** Diff Manifest exposed to reviewers and tasks. */
export type DiffManifest = {
  baseSha: string;
  headSha: string;
  mergeBaseSha: string;
  files: Array<{
    path: string;
    previousPath?: string;
    status: string;
    language?: string;
    additions: number;
    deletions: number;
    commentableRanges?: unknown[];
    ranges?: unknown[];
    preview?: string;
  }>;
};

/** Options for projecting a Diff Manifest for task or prompt use. */
export type DiffManifestOptions = {
  compressed?: boolean;
  includePreviews?: boolean;
  maxPreviewLines?: number;
  paths?: PathFilter;
};

/** Size limits for Diff Manifest prompt and runtime-tool payloads. */
export type DiffManifestLimits = {
  fullMaxBytes?: number;
  fullMaxEstimatedTokens?: number;
  condensedMaxBytes?: number;
  condensedMaxEstimatedTokens?: number;
  toolResponseMaxBytes?: number;
};

/** Runtime limits for a pipr config. */
export type RuntimeLimits = {
  timeoutSeconds?: number;
  diffManifest?: DiffManifestLimits;
};

/** Change-request context available inside tasks. */
export type ChangeRequestContext = ChangeRequestInfo & {
  diffManifest(options?: DiffManifestOptions): Promise<DiffManifest>;
  changedFiles(): Promise<Array<{ path: string; previousPath?: string; status: string }>>;
  currentHeadSha(): Promise<string>;
};

/** Runner for invoking Pi agents from tasks. */
export type PiRunner = {
  run<Input, Output>(
    agent: Agent<Input, Output>,
    input: Input,
    options?: {
      model?: ModelProfile;
      fallbacks?: ModelProfile[];
      instructions?: PromptSource;
      timeout?: DurationInput;
      paths?: PathFilter;
    },
  ): Promise<Output>;
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
  readonly run: { id: string };
  readonly repository: RepositoryInfo;
  readonly change: ChangeRequestContext;
  readonly platform: PlatformInfo;
  readonly pi: PiRunner;
  readonly command?: CommandContext;
  secret(secret: SecretRef): string;
  readonly review: {
    prior(): Promise<PriorReview>;
  };
  readonly check: CheckHandle;
  comment(value: CommentValue): Promise<void>;
  readonly log: {
    info(message: string): void;
    warn(message: string): void;
    error(message: string): void;
  };
};
