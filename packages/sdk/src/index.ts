import { z } from "zod";

export { definePipr, definePlugin } from "./builder.js";
export { md } from "./prompt.js";
export type {
  PiprResult,
  PiprRunContext,
  PiprRunSummary,
  PiprRunTrigger,
} from "./result.js";
export { parsePiprResult, piprResultSchema } from "./result.js";
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
export type {
  Agent,
  AgentDefinition,
  AgentExtension,
  AgentPromptContext,
  AgentTool,
  BuiltinSchemaCatalog,
  BuiltinToolCatalog,
} from "./types/agent.js";
export type {
  AggregateCheckOptions,
  AutoResolveAllowedActors,
  AutoResolveOptions,
  AutoResolveUserRepliesOptions,
  ChangeRequestAction,
  ChecksOptions,
  DurationInput,
  ModelOptions,
  ModelProfile,
  PiprConfigOptions,
  PublicationOptions,
  RepositoryPermission,
  SecretOptions,
  SecretRef,
} from "./types/config.js";
export type {
  ChangedFile,
  CommentableRange,
  DiffHunk,
  DiffManifest,
  DiffManifestFile,
  DiffManifestLimits,
  DiffManifestOptions,
  FileStatus,
  PathFilter,
  RangeKind,
  ReviewSide,
  RuntimeLimits,
} from "./types/manifest.js";
export type {
  JsonPromptOptions,
  Markdown,
  PromptSource,
  PromptText,
  PromptValue,
} from "./types/prompt.js";
export type {
  JsonObject,
  JsonPrimitive,
  JsonSchema,
  JsonSchemaDefinition,
  JsonValue,
  Schema,
  SchemaDefinition,
  SchemaParseResult,
  ZodSchema,
} from "./types/schema.js";
export type {
  ChangeRequestContext,
  ChangeRequestInfo,
  ChangeRequestRegistrationOptions,
  CheckHandle,
  CommandContext,
  CommandOptions,
  CommandRegistrationOptions,
  CommentValue,
  DefaultReviewInput,
  PiprBuilder,
  PiprPlugin,
  PiRunner,
  PlatformInfo,
  PluginToolDefinition,
  PriorInlineFinding,
  PriorReview,
  RepositoryInfo,
  ReviewCommentContext,
  ReviewEntrypoints,
  Reviewer,
  ReviewerOptions,
  ReviewRecipeOptions,
  Task,
  TaskCheckOptions,
  TaskContext,
  TaskDefinition,
  TaskHandler,
  ToolRunOptions,
} from "./types/task.js";
export { defaultReviewActions, defaultReviewEntrypoints } from "./types/task.js";

export { z };
