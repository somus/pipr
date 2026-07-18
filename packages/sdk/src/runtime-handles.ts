import { renderPromptValue } from "./prompt-render.js";
import type {
  RuntimeAgent,
  RuntimeAgentDefinition,
  RuntimeAgentTool,
  RuntimeTask,
} from "./runtime-contract.js";
import type { Agent, AgentDefinition, AgentTool } from "./types/agent.js";
import type { PluginToolDefinition, Task, TaskDefinition } from "./types/task.js";

const taskRecords = new WeakMap<object, RuntimeTask>();
const agentRecords = new WeakMap<object, RuntimeAgent>();
const toolRecords = new WeakMap<object, RuntimeAgentTool>();

export function createTaskHandle<Input>(definition: TaskDefinition<Input>): {
  handle: Task<Input>;
  record: RuntimeTask;
} {
  const handle = { kind: "pipr.task", name: definition.name } as Task<Input>;
  const record: RuntimeTask = {
    name: definition.name,
    check: definition.check,
    ...(definition.local === false ? { local: false } : {}),
    handler: definition.run as RuntimeTask["handler"],
  };
  taskRecords.set(handle, record);
  return { handle, record };
}

export function runtimeTaskForHandle<Input>(task: Task<Input>): RuntimeTask {
  const record = taskRecords.get(task);
  if (!record) {
    throw new Error("Expected a task handle created by pipr.task");
  }
  return record;
}

export function createAgentHandle<Input, Output>(
  definition: AgentDefinition<Input, Output>,
): { handle: Agent<Input, Output>; record: RuntimeAgent } {
  const handle = {
    kind: "pipr.agent",
    name: definition.name,
    extend(patch) {
      return createAgentHandle({
        ...definition,
        ...patch,
        instructions:
          patch.instructions === undefined
            ? definition.instructions
            : {
                kind: "pipr.prompt",
                value:
                  `${renderPromptValue(definition.instructions)}\n\n${renderPromptValue(patch.instructions)}`.trim(),
              },
      }).handle;
    },
  } as Agent<Input, Output>;
  const record: RuntimeAgent = {
    name: definition.name,
    definition: runtimeAgentDefinition(definition),
  };
  agentRecords.set(handle, record);
  return { handle, record };
}

export function runtimeAgentForHandle<Input, Output>(agent: Agent<Input, Output>): RuntimeAgent {
  const record = agentRecords.get(agent);
  if (!record) {
    throw new Error("Expected an agent handle created by pipr.agent");
  }
  return record;
}

export function createToolHandle<Input, Output>(
  definition: PluginToolDefinition<Input, Output>,
): { handle: AgentTool<Input, Output>; record: RuntimeAgentTool } {
  const handle = { kind: "pipr.tool", name: definition.name } as AgentTool<Input, Output>;
  const record = {
    name: definition.name,
    description: definition.description,
    input: definition.input,
    output: definition.output,
    run: definition.run,
    toModelOutput: definition.toModelOutput,
  } as RuntimeAgentTool;
  toolRecords.set(handle, record);
  return { handle, record };
}

export function createBuiltinReadOnlyToolHandle(): {
  handle: AgentTool;
  record: RuntimeAgentTool;
} {
  const handle = { kind: "pipr.tool", name: "readOnly" } as AgentTool;
  const record = { name: "readOnly", builtinReadOnly: true } satisfies RuntimeAgentTool;
  toolRecords.set(handle, record);
  return { handle, record };
}

function runtimeToolForHandle(tool: AgentTool): RuntimeAgentTool {
  const record = toolRecords.get(tool);
  if (!record) {
    throw new Error("Expected a tool handle created by pipr.tool");
  }
  return record;
}

function runtimeAgentDefinition<Input, Output>(
  definition: AgentDefinition<Input, Output>,
): RuntimeAgentDefinition {
  return {
    ...definition,
    prompt: definition.prompt as RuntimeAgentDefinition["prompt"],
    output: definition.output as RuntimeAgentDefinition["output"],
    tools: definition.tools?.map(runtimeToolForHandle),
  };
}
