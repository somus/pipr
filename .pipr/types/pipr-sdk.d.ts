// biome-ignore-all format: generated from @usepipr/sdk declarations
// biome-ignore-all assist/source/organizeImports: generated from @usepipr/sdk declarations
declare module "@usepipr/sdk" {
type ZodInfer<T> = T extends { parse(value: unknown): infer Output } ? Output : never;
type ZodType<T = unknown, Optional extends boolean = false> = {
  readonly _piprOptional: Optional;
  parse(value: unknown): T;
  optional(): ZodType<T | undefined, true>;
  min(value: number): ZodType<T, Optional>;
  max(value: number): ZodType<T, Optional>;
  int(): ZodType<T, Optional>;
  positive(): ZodType<T, Optional>;
  finite(): ZodType<T, Optional>;
};
type ZodAny = ZodType<unknown, boolean>;
type ZodOptionalKeys<T extends Record<string, ZodAny>> = { [K in keyof T]: T[K] extends ZodType<unknown, true> ? K : never }[keyof T];
type ZodObjectOutput<T extends Record<string, ZodAny>> = { [K in Exclude<keyof T, ZodOptionalKeys<T>>]: ZodInfer<T[K]> } & { [K in ZodOptionalKeys<T>]?: ZodInfer<T[K]> };
const z: {
  string(): ZodType<string>;
  number(): ZodType<number>;
  boolean(): ZodType<boolean>;
  null(): ZodType<null>;
  unknown(): ZodType<unknown>;
  any(): ZodType<unknown>;
  literal<T extends string | number | boolean | null>(value: T): ZodType<T>;
  enum<const T extends readonly [string, ...string[]]>(values: T): ZodType<T[number]>;
  array<T extends ZodAny>(schema: T): ZodType<Array<ZodInfer<T>>>;
  record<T extends ZodAny>(key: ZodType<string>, value: T): ZodType<Record<string, ZodInfer<T>>>;
  strictObject<T extends Record<string, ZodAny>>(shape: T): ZodType<ZodObjectOutput<T>>;
  object<T extends Record<string, ZodAny>>(shape: T): ZodType<ZodObjectOutput<T>>;
  looseObject<T extends Record<string, ZodAny>>(shape: T): ZodType<ZodObjectOutput<T> & Record<string, unknown>>;
  union<const T extends readonly [ZodAny, ZodAny, ...ZodAny[]]>(schemas: T): ZodType<ZodInfer<T[number]>>;
  json(): ZodType<JsonValue>;
  fromJSONSchema(schema: JsonSchema): ZodType<unknown>;
  toJSONSchema(schema: ZodAny): JsonSchema;
};

//#region src/types/schema.d.ts
/** Primitive JSON value supported by JSON Schema based configuration. */
type JsonPrimitive = string | number | boolean | null;
/** JSON value accepted by pipr schema and prompt helpers. */
type JsonValue = JsonPrimitive | JsonValue[] | JsonObject;
/** JSON object accepted by pipr schema and prompt helpers. */
type JsonObject = {
  [key: string]: JsonValue;
};
/** JSON Schema document or boolean schema. */
type JsonSchema = JsonObject | boolean;
/** Result returned by `Schema.safeParse`. */
type SchemaParseResult<T> = {
  success: true;
  data: T;
} | {
  success: false;
  error: Error;
};
/** Runtime schema wrapper used by pipr agents, tools, and user config. */
type Schema<T> = {
  readonly kind: "pipr.schema";
  readonly id: string;
  readonly jsonSchema?: JsonSchema;
  parse(value: unknown): T;
  safeParse(value: unknown): SchemaParseResult<T>;
};
/** Zod schema type accepted by `pipr.schema` and built-in schema exports. */
type ZodSchema<T> = ZodType<T>;
/** Zod-backed schema registration. */
type SchemaDefinition<T> = {
  id: string;
  schema: ZodSchema<T>;
};
/** JSON Schema backed schema registration. */
type JsonSchemaDefinition = {
  id: string;
  schema: JsonSchema;
};
//#endregion
//#region src/review-contract.d.ts
/** Markdown summary produced by a reviewer for the main review comment. */
type ReviewSummary = {
  title?: string;
  body: string;
};
/** One inline review finding targeting a Diff Manifest commentable range. */
type ReviewFinding = {
  body: string;
  path: string;
  rangeId: string;
  side: "RIGHT" | "LEFT";
  startLine: number;
  endLine: number;
  suggestedFix?: string;
};
/** Core structured review result accepted by pipr review publication. */
type ReviewResult = {
  summary: ReviewSummary;
  inlineFindings: ReviewFinding[];
};
/** Zod schema for a review summary. */
const reviewSummarySchema: ZodSchema<ReviewSummary>;
/** Zod schema for one inline review finding. */
const reviewFindingSchema: ZodSchema<ReviewFinding>;
/** Zod schema for pipr's core pull request review result. */
const reviewResultSchema: ZodSchema<ReviewResult>;
/** Parses model output for pipr's main pull request review schema. */
function parseReviewResult(value: unknown): ReviewResult;
/** Parses a review summary value. */
function parseReviewSummary(value: unknown): ReviewSummary;
/** Parses one inline review finding. */
function parseReviewFinding(value: unknown): ReviewFinding;
/** Returns a small valid example for the main pull request review schema. */
function reviewSchemaExample(): ReviewResult;
//#endregion
//#region src/types/manifest.d.ts
/** Include/exclude path filter for scoped reviews and Diff Manifest projection. */
type PathFilter = {
  include?: string[];
  exclude?: string[];
};
/** Side of a pull request diff that a commentable range belongs to. */
type ReviewSide = "RIGHT" | "LEFT";
/** Kind of line span represented by a Diff Manifest commentable range. */
type RangeKind = "added" | "deleted" | "context" | "mixed";
/** File lifecycle status in a Diff Manifest. */
type FileStatus = "added" | "modified" | "removed" | "renamed";
/** Commentable line range that can anchor an Inline Review Comment. */
type CommentableRange = {
  id: string;
  path: string;
  side: ReviewSide;
  startLine: number;
  endLine: number;
  kind: RangeKind;
  hunkIndex: number;
  hunkHeader: string;
  hunkContentHash: string;
  summary?: string;
  preview?: string;
};
/** Diff hunk metadata included in a Diff Manifest file entry. */
type DiffHunk = {
  hunkIndex: number;
  header: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  contentHash: string;
};
/** One changed file in a Diff Manifest. */
type DiffManifestFile = {
  path: string;
  previousPath?: string;
  status: FileStatus;
  language?: string;
  additions: number;
  deletions: number;
  hunks: DiffHunk[];
  commentableRanges: CommentableRange[];
  signals?: string[];
  changedSymbols?: string[];
  excludedReason?: string;
};
/** Diff Manifest exposed to reviewers and tasks. */
type DiffManifest = {
  baseSha: string;
  headSha: string;
  mergeBaseSha: string;
  files: DiffManifestFile[];
};
/** Options for projecting a Diff Manifest for task or prompt use. */
type DiffManifestOptions = {
  compressed?: boolean;
  includePreviews?: boolean;
  maxPreviewLines?: number;
  paths?: PathFilter;
};
/** Size limits for Diff Manifest prompt and runtime-tool payloads. */
type DiffManifestLimits = {
  fullMaxBytes?: number;
  fullMaxEstimatedTokens?: number;
  condensedMaxBytes?: number;
  condensedMaxEstimatedTokens?: number;
  toolResponseMaxBytes?: number;
};
/** Runtime limits for a pipr config. */
type RuntimeLimits = {
  timeoutSeconds?: number;
  diffManifest?: DiffManifestLimits;
};
//#endregion
//#region src/types/config.d.ts
/** Repository permission levels used to authorize pipr commands. */
type RepositoryPermission = "read" | "triage" | "write" | "maintain" | "admin";
/** Pull request lifecycle actions that can trigger change-request tasks. */
type ChangeRequestAction = "opened" | "updated" | "reopened" | "ready" | "closed";
/** Duration accepted by timeout options, either seconds as a number or a suffixed string. */
type DurationInput = number | `${number}s` | `${number}m` | `${number}h`;
/** Reference to a secret that pipr resolves from the runtime environment. */
type SecretRef = {
  readonly kind: "pipr.secret";
  readonly name: string;
};
/** Options for declaring a secret by environment variable name. */
type SecretOptions = {
  name: string;
};
/** Options for registering a model provider and model id. */
type ModelOptions = {
  id?: string;
  provider: string;
  model: string;
  apiKey?: SecretRef;
  options?: Record<string, unknown>;
};
/** Registered model profile that can be used by reviewers and agents. */
type ModelProfile = {
  readonly kind: "pipr.model";
  readonly id: string;
  readonly provider: string;
  readonly model: string;
  readonly apiKey?: SecretRef;
  readonly options?: Record<string, unknown>;
};
/** Aggregate check-run options for a Pipr review run. */
type AggregateCheckOptions = false | {
  enabled?: boolean;
  name?: string;
};
/** Check-run settings for a pipr config. */
type ChecksOptions = {
  aggregate?: AggregateCheckOptions;
};
/** Actor policy for auto-resolving inline review threads from user replies. */
type AutoResolveAllowedActors = "author-or-write" | "write" | "any";
/** Options controlling auto-resolve behavior for user replies. */
type AutoResolveUserRepliesOptions = {
  enabled?: boolean;
  respondWhenStillValid?: boolean;
  allowedActors?: AutoResolveAllowedActors;
};
/** Options controlling automatic stale-finding resolution. */
type AutoResolveOptions = false | {
  enabled?: boolean;
  model?: ModelProfile;
  instructions?: string;
  synchronize?: boolean;
  userReplies?: boolean | AutoResolveUserRepliesOptions;
};
/** Review publication settings. */
type PublicationOptions = {
  maxInlineComments?: number;
  autoResolve?: AutoResolveOptions;
};
/** Top-level pipr config settings. */
type PiprConfigOptions = {
  publication?: PublicationOptions;
  checks?: ChecksOptions;
  limits?: RuntimeLimits;
};
//#endregion
//#region src/types/prompt.d.ts
/** Markdown text accepted by review comments and command replies. */
type Markdown = string;
/** Prompt text accepted by agent instructions and prompt functions. */
type PromptSource = string | PromptText;
/** Value accepted by prompt rendering helpers. */
type PromptValue = unknown;
/** Structured prompt text produced by `pipr.prompt`, `pipr.section`, or `pipr.json`. */
type PromptText = {
  readonly kind: "pipr.prompt";
  readonly value: string;
};
/** Options for rendering a value as JSON prompt text. */
type JsonPromptOptions = {
  pretty?: boolean;
  maxCharacters?: number;
};
//#endregion
//#region src/types/agent.d.ts
/** Built-in tool catalog exposed on the pipr builder. */
type BuiltinToolCatalog = {
  readonly readOnly: readonly AgentTool[];
};
/** Built-in schema catalog exposed on the pipr builder. */
type BuiltinSchemaCatalog = {
  readonly review: Schema<ReviewResult>;
  readonly summary: Schema<ReviewSummary>;
};
/** Tool definition available to Pi agents at runtime. */
type AgentTool<Input = unknown, Output = unknown> = {
  readonly kind: "pipr.tool";
  readonly name: string;
  readonly description?: string;
  readonly input?: Schema<Input>;
  readonly output?: Schema<Output>;
  run?(options: ToolRunOptions<Input>): Output | Promise<Output>;
  toModelOutput?(output: Output): PromptValue;
};
/** Context passed to an agent prompt function. */
type AgentPromptContext = {
  runId: string;
  repository: RepositoryInfo;
  change: ChangeRequestInfo;
  platform: PlatformInfo;
};
/** Full definition for an agent pipr can run through Pi. */
type AgentDefinition<Input, Output> = {
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
type AgentExtension<Input, Output> = Partial<AgentDefinition<Input, Output>> & {
  instructions?: PromptSource;
};
/** Registered Pi agent with typed input and output. */
type Agent<Input = unknown, Output = unknown> = {
  readonly kind: "pipr.agent";
  readonly name?: string;
  readonly definition: AgentDefinition<Input, Output>;
  extend(patch: AgentExtension<Input, Output>): Agent<Input, Output>;
};
//#endregion
//#region src/types/task.d.ts
/** Final review comment value produced by a task or review recipe. */
type CommentValue = Markdown | {
  main?: Markdown;
  inlineFindings?: readonly ReviewFinding[];
};
/** Prior inline finding persisted by earlier pipr review state. */
type PriorInlineFinding = {
  id: string;
  status: "open" | "resolved";
  path: string;
  rangeId: string;
  side: "RIGHT" | "LEFT";
  startLine: number;
  endLine: number;
};
/** Prior pipr review state available to tasks through `ctx.review.prior()`. */
type PriorReview = {
  main?: Markdown;
  reviewedHeadSha?: string;
  inlineFindings: readonly PriorInlineFinding[];
};
/** Function run by a task entrypoint. */
type TaskHandler<Input> = (context: TaskContext, input: Input) => void | Promise<void>;
/** Check-run publication options for one task. */
type TaskCheckOptions = false | {
  enabled?: boolean;
  name?: string;
  required?: boolean;
};
/** Definition used to register a task. */
type TaskDefinition<Input> = {
  name: string;
  check?: TaskCheckOptions;
  local?: false;
  run: TaskHandler<Input>;
};
/** Registered task that can be selected by change-request and command entrypoints. */
type Task<Input = void> = {
  readonly kind: "pipr.task";
  readonly name: string;
  readonly check?: TaskCheckOptions;
  readonly local?: false;
  readonly handler: TaskHandler<Input>;
};
/** Options shared by command registrations. */
type CommandOptions<Input> = {
  permission?: RepositoryPermission;
  description?: string;
  parse?: (arguments_: Record<string, string>) => Input;
};
/** Definition used to register an `@pipr` command. */
type CommandRegistrationOptions<Input> = CommandOptions<Input> & {
  pattern: string;
  task: Task<Input>;
};
/** Options for creating a reusable reviewer agent. */
type ReviewerOptions = {
  name?: string;
  model: ModelProfile;
  fallbacks?: ModelProfile[];
  instructions: PromptSource;
  prompt?: (input: DefaultReviewInput, context: AgentPromptContext) => PromptSource | Promise<PromptSource>;
  tools?: readonly AgentTool[];
  timeout?: DurationInput;
};
/** Reviewer agent that emits pipr's core review result. */
type Reviewer = Agent<DefaultReviewInput, ReviewResult>;
/** Entrypoints created by `pipr.review`. */
type ReviewEntrypoints = {
  changeRequest?: ChangeRequestAction[] | false;
  command?: string | false | {
    pattern?: string;
    permission?: RepositoryPermission;
    description?: string;
  };
};
type ReviewRecipeEntrypointOptions = {
  id: string;
  entrypoints?: ReviewEntrypoints;
  comment?: CommentValue | ((result: ReviewResult, context: ReviewCommentContext) => CommentValue | Promise<CommentValue>);
  check?: TaskCheckOptions;
  timeout?: DurationInput;
  paths?: PathFilter;
};
/** Options for `pipr.review`, pipr's default review recipe. */
type ReviewRecipeOptions = (ReviewRecipeEntrypointOptions & {
  reviewer: Reviewer;
}) | (ReviewRecipeEntrypointOptions & ReviewerOptions & {
  reviewer?: undefined;
});
/** Default input passed to a reviewer created by `pipr.review`. */
type DefaultReviewInput = {
  manifest: DiffManifest;
  change: ChangeRequestInfo;
};
/** Context passed to a custom review comment renderer. */
type ReviewCommentContext = {
  review: {
    id: string;
  };
  repository: RepositoryInfo;
  change: ChangeRequestContext;
  platform: PlatformInfo;
};
/** Plugin installer returned by `definePlugin`. */
type PiprPlugin<Handle> = {
  setup(builder: PiprBuilder): Handle;
};
/** Definition for a custom tool registered by config or plugins. */
type PluginToolDefinition<Input, Output> = {
  name: string;
  description: string;
  input: Schema<Input>;
  output: Schema<Output>;
  execute?(context: TaskContext, input: Input): Promise<Output>;
  run?(options: ToolRunOptions<Input>): Output | Promise<Output>;
  toModelOutput?(output: Output): PromptValue;
};
/** Runtime input passed to a tool implementation. */
type ToolRunOptions<Input> = {
  input: Input;
  ctx: TaskContext;
  signal?: AbortSignal;
};
/** Definition used to register a task for pull request actions. */
type ChangeRequestRegistrationOptions<Input> = {
  actions: ChangeRequestAction[];
  task: Task<Input>;
};
/** Handle for reporting task check status from inside a task. */
type CheckHandle = {
  pass(summary?: string): void;
  fail(summary?: string): void;
  neutral(summary?: string): void;
};
/** Builder API available inside `definePipr`. */
type PiprBuilder = {
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
  use<Handle>(plugin: PiprPlugin<Handle>): Handle;
  tool<Input, Output>(definition: PluginToolDefinition<Input, Output>): AgentTool<Input, Output>;
  schema<T>(definition: SchemaDefinition<T>): Schema<T>;
  jsonSchema<T>(definition: JsonSchemaDefinition): Schema<T>;
  prompt(strings: TemplateStringsArray, ...values: PromptValue[]): PromptText;
  section(title: string, value: PromptValue): PromptText;
  json(value: unknown, options?: JsonPromptOptions): PromptText;
};
/** Repository metadata available to tasks and agents. */
type RepositoryInfo = {
  root: string;
  owner?: string;
  name: string;
  defaultBranch?: string;
  remoteUrl?: string;
};
/** Pull request or change-request metadata available to tasks and agents. */
type ChangeRequestInfo = {
  number?: number;
  title: string;
  description: string;
  url?: string;
  author?: {
    login: string;
  };
  base: {
    ref?: string;
    sha: string;
  };
  head: {
    ref?: string;
    sha: string;
  };
  isFork?: boolean;
};
/** Code hosting platform metadata. */
type PlatformInfo = {
  id: string;
};
/** Change-request context available inside tasks. */
type ChangeRequestContext = ChangeRequestInfo & {
  diffManifest(options?: DiffManifestOptions): Promise<DiffManifest>;
  changedFiles(): Promise<Array<{
    path: string;
    previousPath?: string;
    status: string;
  }>>;
  currentHeadSha(): Promise<string>;
};
/** Runner for invoking Pi agents from tasks. */
type PiRunner = {
  run<Input, Output>(agent: Agent<Input, Output>, input: Input, options?: {
    model?: ModelProfile;
    fallbacks?: ModelProfile[];
    instructions?: PromptSource;
    timeout?: DurationInput;
    paths?: PathFilter;
  }): Promise<Output>;
};
/** Command context available inside command-triggered tasks. */
type CommandContext = {
  readonly name: string;
  readonly line: string;
  readonly arguments: Record<string, string>;
  reply(markdown: Markdown): Promise<void>;
};
/** Context object passed to task handlers. */
type TaskContext = {
  readonly run: {
    id: string;
  };
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
//#endregion
//#region src/builder.d.ts
/** Defines a synchronous pipr configuration factory. */
function definePipr(configure: (pipr: PiprBuilder) => void): {
  readonly kind: "pipr.config-factory";
};
/** Defines a typed pipr plugin installer. */
function definePlugin<Handle>(setup: (builder: PiprBuilder) => Handle): PiprPlugin<Handle>;
//#endregion
//#region src/command-grammar.d.ts
function commandPatternParts(pattern: string): string[];
function tokenizeCommandPattern(value: string): string[];
function unsupportedCommandRestCaptureError(pattern: string): string | undefined;
function assertSupportedCommandRestCapture(pattern: string): void;
function isOptionalCommandPatternPart(value: string): boolean;
function isCommandCaptureToken(value: string): boolean;
function isCommandRestCaptureToken(value: string): boolean;
//#endregion
//#region src/prompt.d.ts
/** Creates trimmed Markdown from a template literal with common indentation removed. */
function md(strings: TemplateStringsArray, ...values: unknown[]): Markdown;
//#endregion
//#region src/schema.d.ts
/** Defines a typed schema from a Zod schema. */
function schema<T>(definition: SchemaDefinition<T>): Schema<T>;
/** Defines a typed schema from JSON Schema. The generic type is caller supplied. */
function jsonSchema<T>(definition: JsonSchemaDefinition): Schema<T>;
/** Built-in schemas available as reusable agent output contracts. */
const schemas: BuiltinSchemaCatalog;
//#endregion



export { type Agent, type AgentDefinition, type AgentExtension, type AgentPromptContext, type AgentTool, type AggregateCheckOptions, type AutoResolveAllowedActors, type AutoResolveOptions, type AutoResolveUserRepliesOptions, type BuiltinSchemaCatalog, type BuiltinToolCatalog, type ChangeRequestAction, type ChangeRequestContext, type ChangeRequestInfo, type ChangeRequestRegistrationOptions, type CheckHandle, type ChecksOptions, type CommandContext, type CommandOptions, type CommandRegistrationOptions, type CommentValue, type CommentableRange, type DefaultReviewInput, type DiffHunk, type DiffManifest, type DiffManifestFile, type DiffManifestLimits, type DiffManifestOptions, type DurationInput, type FileStatus, type JsonObject, type JsonPrimitive, type JsonPromptOptions, type JsonSchema, type JsonSchemaDefinition, type JsonValue, type Markdown, type ModelOptions, type ModelProfile, type PathFilter, type PiRunner, type PiprBuilder, type PiprConfigOptions, type PiprPlugin, type PlatformInfo, type PluginToolDefinition, type PriorInlineFinding, type PriorReview, type PromptSource, type PromptText, type PromptValue, type PublicationOptions, type RangeKind, type RepositoryInfo, type RepositoryPermission, type ReviewCommentContext, type ReviewEntrypoints, type ReviewFinding, type ReviewRecipeOptions, type ReviewResult, type ReviewSide, type ReviewSummary, type Reviewer, type ReviewerOptions, type RuntimeLimits, type Schema, type SchemaDefinition, type SchemaParseResult, type SecretOptions, type SecretRef, type Task, type TaskCheckOptions, type TaskContext, type TaskDefinition, type TaskHandler, type ToolRunOptions, type ZodSchema, assertSupportedCommandRestCapture, commandPatternParts, definePipr, definePlugin, isCommandCaptureToken, isCommandRestCaptureToken, isOptionalCommandPatternPart, jsonSchema, md, parseReviewFinding, parseReviewResult, parseReviewSummary, reviewFindingSchema, reviewResultSchema, reviewSchemaExample, reviewSummarySchema, schema, schemas, tokenizeCommandPattern, unsupportedCommandRestCaptureError, z };
}
