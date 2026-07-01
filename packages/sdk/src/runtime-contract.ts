import type {
  Agent,
  AgentTool,
  ChangeRequestAction,
  ChecksOptions,
  ModelProfile,
  PublicationOptions,
  RepositoryPermission,
  RuntimeLimits,
  Task,
} from "./index.js";

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
