import type { AgentWorkerToolSpec } from "../agent-worker/protocol.js";

type SchemaLike<T = unknown> = {
  parse(value: unknown): T;
};

export type PiCustomToolDefinition = {
  readonly name: string;
  readonly description?: string;
  readonly input: SchemaLike;
  readonly output: SchemaLike;
  execute(context: unknown, input: unknown): Promise<unknown>;
};

export type PiCustomToolRequest = {
  readonly tools: readonly PiCustomToolDefinition[];
  readonly context: unknown;
};

/** Config-defined tools offered to the model; their arguments are validated in the supervisor, not the worker. */
export function customToolSpecs(request: PiCustomToolRequest | undefined): AgentWorkerToolSpec[] {
  return (request?.tools ?? []).map((tool) => ({
    name: tool.name,
    description: tool.description ?? "pipr custom config tool.",
    parameters: { type: "object", additionalProperties: true },
  }));
}

/** Runs one bridged tool call in the supervisor with the task context, validating input and output. */
export async function callCustomTool(
  request: PiCustomToolRequest | undefined,
  call: { tool: string; args: unknown },
): Promise<unknown> {
  const tool = request?.tools.find((candidate) => candidate.name === call.tool);
  if (!tool) {
    throw new Error(`Unknown custom tool '${call.tool}'`);
  }
  const input = tool.input.parse(call.args);
  return tool.output.parse(await tool.execute(request?.context, input));
}
