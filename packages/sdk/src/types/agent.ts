import type { ReviewResult, ReviewSummary } from "../review-contract.js";
import type { DurationInput, ModelProfile } from "./config.js";
import type { PromptSource } from "./prompt.js";
import type { Schema } from "./schema.js";
import type { ChangeRequestInfo, PlatformInfo, RepositoryInfo } from "./task.js";

/** Built-in tool catalog exposed on the pipr builder. */
export type BuiltinToolCatalog = {
  readonly readOnly: readonly AgentTool[];
};

/** Built-in schema catalog exposed on the pipr builder. */
export type BuiltinSchemaCatalog = {
  readonly review: Schema<ReviewResult>;
  readonly summary: Schema<ReviewSummary>;
};

declare const agentToolHandleBrand: unique symbol;

/** Opaque tool handle available to Pi agents. */
export type AgentTool<Input = unknown, Output = unknown> = {
  readonly kind: "pipr.tool";
  readonly name: string;
  readonly [agentToolHandleBrand]: readonly [Input, Output];
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
  fallbacks?: readonly ModelProfile[];
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

declare const agentHandleBrand: unique symbol;

/** Opaque registered Pi agent with typed input and output. */
export type Agent<Input = unknown, Output = unknown> = {
  readonly kind: "pipr.agent";
  readonly name?: string;
  readonly [agentHandleBrand]: (input: Input) => Output;
  extend(patch: AgentExtension<Input, Output>): Agent<Input, Output>;
};
