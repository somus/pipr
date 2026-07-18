import type { Agent, AgentDefinition } from "./types/agent.js";
import type {
  ChangeRequestAction,
  ChecksOptions,
  ModelProfile,
  PublicationOptions,
  RepositoryPermission,
} from "./types/config.js";
import type { RuntimeLimits } from "./types/manifest.js";
import type { PluginToolDefinition, TaskCheckOptions, TaskContext } from "./types/task.js";

/** Type-erased executable task stored in a runtime plan. */
export type RuntimeTask = {
  readonly name: string;
  readonly check?: TaskCheckOptions;
  readonly local?: false;
  readonly handler: (context: TaskContext, input: unknown) => void | Promise<void>;
};

/** Type-erased executable custom or built-in tool stored in a runtime plan. */
export type RuntimeAgentTool = {
  readonly name: string;
  readonly description?: string;
  readonly input?: PluginToolDefinition<unknown, unknown>["input"];
  readonly output?: PluginToolDefinition<unknown, unknown>["output"];
  readonly run?: PluginToolDefinition<unknown, unknown>["run"];
  readonly toModelOutput?: PluginToolDefinition<unknown, unknown>["toModelOutput"];
  readonly builtinReadOnly?: true;
};

/** Type-erased executable agent definition stored in a runtime plan. */
export type RuntimeAgentDefinition = Omit<AgentDefinition<unknown, unknown>, "tools"> & {
  tools?: readonly RuntimeAgentTool[];
};

/** Type-erased executable agent stored in a runtime plan. */
export type RuntimeAgent = {
  readonly name?: string;
  readonly definition: RuntimeAgentDefinition;
};

/** Runtime plan produced from user configuration. */
export type RuntimePlan = {
  resolveAgent<Input, Output>(agent: Agent<Input, Output>): RuntimeAgent;
  models: ModelProfile[];
  agents: RuntimeAgent[];
  tasks: RuntimeTask[];
  changeRequestTriggers: Array<{ actions: ChangeRequestAction[]; task: RuntimeTask }>;
  commands: Array<{
    pattern: string;
    permission: RepositoryPermission;
    description?: string;
    parse?: (arguments_: Record<string, string>) => unknown;
    task: RuntimeTask;
  }>;
  tools: RuntimeAgentTool[];
  publication: PublicationOptions;
  checks?: ChecksOptions;
  limits?: RuntimeLimits;
};
