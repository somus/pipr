import { z } from "zod";

export { definePipr, definePlugin } from "./builder.js";
export type { FindingFacets, FindingFields, FindingSchema } from "./finding.js";
export type { MarkdownBuilder, MarkdownText } from "./markdown.js";
export { escapeMarkdown, md } from "./markdown.js";
export type {
  PiprDiffContextCoverage,
  PiprResult,
  PiprRunContext,
  PiprRunSummary,
  PiprRunTrigger,
} from "./result.js";
export { parsePiprResult, piprResultSchema } from "./result.js";
export type {
  ReviewFinding,
  ReviewFindingsResult,
  ReviewResult,
  ReviewSummary,
} from "./review-contract.js";
export {
  parseReviewFinding,
  parseReviewFindingsResult,
  parseReviewResult,
  parseReviewSummary,
  reviewFindingSchema,
  reviewFindingsResultSchema,
  reviewResultSchema,
  reviewSchemaExample,
  reviewSummarySchema,
} from "./review-contract.js";
export type {
  RunBundle,
  RunBundleArtifact,
  RunBundleEnvelope,
  RunBundleManifest,
  RunLogRecord,
  RunMetricsSnapshot,
  RunSpanRecord,
} from "./run-bundle.js";
export {
  parseRunBundle,
  parseRunBundleEnvelope,
  parseRunBundleManifest,
  runBundleArtifactSchema,
  runBundleEnvelopeSchema,
  runBundleManifestSchema,
  runBundleSchema,
  runLogRecordSchema,
  runMetricsSnapshotSchema,
  runSpanRecordSchema,
} from "./run-bundle.js";
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
  ModelApiKey,
  ModelOptions,
  ModelProfile,
  ModelRef,
  ModelThinkingLevel,
  PiprConfigOptions,
  PublicationOptions,
  RepositoryPermission,
  SecretOptions,
  SecretRef,
} from "./types/config.js";
export { modelThinkingLevels } from "./types/config.js";
export type {
  ChangedFile,
  CommentableRange,
  DiffContext,
  DiffHunk,
  DiffManifest,
  DiffManifestFile,
  DiffManifestLimits,
  DiffManifestOptions,
  DiffSummary,
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
  CheckGateOptions,
  CheckGateResult,
  CheckHandle,
  CommandContext,
  CommandOptions,
  CommandRegistrationOptions,
  CommandTrigger,
  CommentValue,
  DroppedReviewFinding,
  PiprBuilder,
  PiprPlugin,
  PiRunner,
  PiRunOptions,
  PiRunOutputs,
  PiRunRequest,
  PlatformInfo,
  PluginToolDefinition,
  PriorInlineFinding,
  PriorReview,
  RepositoryInfo,
  ReviewCommentContext,
  ReviewFindingsInput,
  ReviewOptions,
  ReviewRenderInput,
  ReviewSummaryInput,
  ReviewSummaryOptions,
  SelectedReviewFindings,
  SelectFindingsOptions,
  Task,
  TaskCheckOptions,
  TaskContext,
  TaskDefinition,
  TaskHandler,
  TaskTriggers,
  ToolRunOptions,
  ValidatedReviewFindings,
  ValidateFindingsOptions,
} from "./types/task.js";
export {
  defaultReviewActions,
  defaultReviewTriggers,
} from "./types/task.js";

export { z };
