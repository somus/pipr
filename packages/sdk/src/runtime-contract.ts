import type { Agent, AgentTool } from "./types/agent.js";
import type {
  ChangeRequestAction,
  ChecksOptions,
  ModelProfile,
  PublicationOptions,
  RepositoryPermission,
} from "./types/config.js";
import type { RuntimeLimits } from "./types/manifest.js";
import type { Task } from "./types/task.js";

/** Runtime plan produced from user configuration. */
export type RuntimePlan = {
  models: ModelProfile[];
  agents: Agent[];
  tasks: Task<unknown>[];
  changeRequestTriggers: Array<{ actions: ChangeRequestAction[]; task: Task<unknown> }>;
  commands: Array<{
    pattern: string;
    permission: RepositoryPermission;
    description?: string;
    parse?: (arguments_: Record<string, string>) => unknown;
    task: Task<unknown>;
  }>;
  tools: AgentTool[];
  publication: PublicationOptions;
  checks?: ChecksOptions;
  limits?: RuntimeLimits;
};
