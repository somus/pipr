import type { ReviewFinding, ReviewResult } from "../review-contract.js";
import type {
  Agent,
  AgentDefinition,
  AgentPromptContext,
  AgentTool,
  BuiltinSchemaCatalog,
  BuiltinToolCatalog,
} from "./agent.js";
import type {
  ChangeRequestAction,
  DurationInput,
  ModelOptions,
  ModelProfile,
  PiprConfigOptions,
  RepositoryPermission,
  SecretOptions,
  SecretRef,
} from "./config.js";
import type { ChangedFile, DiffManifest, DiffManifestOptions, PathFilter } from "./manifest.js";
import type {
  JsonPromptOptions,
  Markdown,
  PromptSource,
  PromptText,
  PromptValue,
} from "./prompt.js";
import type { JsonSchemaDefinition, Schema, SchemaDefinition } from "./schema.js";

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

/** Options for creating a reusable reviewer agent. */
export type ReviewerOptions = {
  name?: string;
  model: ModelProfile;
  fallbacks?: readonly ModelProfile[];
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
  changeRequest?: readonly ChangeRequestAction[] | false;
  command?:
    | string
    | false
    | {
        pattern?: string;
        permission?: RepositoryPermission;
        description?: string;
      };
};

/** Default change-request actions used by `pipr.review`. */
export const defaultReviewActions = [
  "opened",
  "updated",
  "reopened",
  "ready",
] as const satisfies readonly ChangeRequestAction[];

/** Default change-request and command entrypoints used by `pipr.review`. */
export const defaultReviewEntrypoints = {
  changeRequest: defaultReviewActions,
  command: { pattern: "@pipr review", permission: "write" },
} as const satisfies ReviewEntrypoints;

type ReviewRecipeEntrypointOptions = {
  id: string;
  entrypoints?: ReviewEntrypoints;
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
  run(options: ToolRunOptions<Input>): Output | Promise<Output>;
  toModelOutput?(output: Output): PromptValue;
};

/** Runtime input passed to a tool implementation. */
export type ToolRunOptions<Input> = {
  input: Input;
  ctx: TaskContext;
  signal?: AbortSignal;
};

/** Definition used to register an inputless task for change request actions. */
export type ChangeRequestRegistrationOptions = {
  actions: readonly ChangeRequestAction[];
  task: Task<void>;
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
    changeRequest(options: ChangeRequestRegistrationOptions): void;
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
  diffManifest(options?: DiffManifestOptions): Promise<DiffManifest>;
  changedFiles(): Promise<readonly ChangedFile[]>;
  currentHeadSha(): Promise<string>;
};

/** Runner for invoking Pi agents from tasks. */
export type PiRunner = {
  run<Input, Output>(
    agent: Agent<Input, Output>,
    input: Input,
    options?: {
      model?: ModelProfile;
      fallbacks?: readonly ModelProfile[];
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
  /** Stable id for the selected Review Run, not the process attempt. */
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
