import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ToolRegistration } from "@earendil-works/pi-durable";
import type { AgentRunRequest, AgentWorkerToolSpec, ToolCallResult } from "./protocol.js";
import { createRuntimeReadTools } from "./runtime-read-tools.js";
import { jsonToolResult } from "./tool-result.js";
import { createWorkspaceTools } from "./workspace-tools.js";

export type BridgedToolCaller = (
  call: { callId: string; tool: string; args: unknown },
  signal: AbortSignal | undefined,
) => Promise<ToolCallResult>;

export async function createRunTools(
  request: AgentRunRequest,
  callBridgedTool: BridgedToolCaller,
): Promise<ToolRegistration[]> {
  return [
    ...createWorkspaceTools(request.tools.workspace, request.cwd),
    ...(request.tools.runtimeDataPath
      ? await createRuntimeReadTools(request.tools.runtimeDataPath, request.cwd)
      : []),
    ...request.tools.bridged.map((spec) => bridgedTool(spec, callBridgedTool)),
  ];
}

/**
 * A plugin tool whose implementation runs in the supervisor; the worker only forwards arguments and results. Plugin
 * tools may have side effects, so a resumed run never replays them.
 */
function bridgedTool(
  spec: AgentWorkerToolSpec,
  callBridgedTool: BridgedToolCaller,
): ToolRegistration {
  return defineTool({
    name: spec.name,
    description: spec.description,
    replay: "unsafe",
    parameters: Type.Unsafe<Record<string, unknown>>(spec.parameters),
    execute: async (args, api, context) => {
      const result = await callBridgedTool(
        { callId: api.callId, tool: spec.name, args },
        context.abortSignal,
      );
      if (!result.ok) {
        throw new Error(result.error);
      }
      return jsonToolResult(result.value);
    },
  }) as unknown as ToolRegistration;
}
