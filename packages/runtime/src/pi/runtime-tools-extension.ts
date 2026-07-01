import { readFileSync } from "node:fs";
import path from "node:path";
import { compact } from "lodash-es";
import { z } from "zod";
import {
  assertNoSymlinkPath,
  type BaseRangeSnapshot,
  boundedLineSlice,
  type ReadAtRefParams,
  type RuntimeToolData,
  readAtRefParams,
  readDiffFromRuntimeData,
  readDiffParams,
  resolveAllowedPath,
  resolveReadAtRefRequest,
  unavailableReadAtRefResult,
} from "./runtime-tools-core.js";

type PiExtensionHost = {
  registerTool(tool: PiTool): void;
};

type PiTool = {
  name: string;
  label: string;
  description: string;
  parameters: Record<string, unknown>;
  execute: (
    toolCallId: string,
    params: unknown,
    signal?: unknown,
    onUpdate?: unknown,
    ctx?: { cwd?: unknown },
  ) => Promise<ToolResult>;
};

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  details: unknown;
};

const customToolDataSchema = z.strictObject({
  tools: z.array(
    z.strictObject({
      name: z.string().min(1),
      description: z.string().optional(),
    }),
  ),
});

const customToolBridgePayloadSchema = z.record(z.string(), z.unknown());
const readableBaseSnapshotSchema = z.looseObject({
  path: z.string(),
  ref: z.enum(["base", "head"]),
  sourcePath: z.string(),
  rangeId: z.string(),
  startLine: z.number(),
  endLine: z.number(),
  available: z.literal(true),
  relativePath: z.string(),
  bytes: z.number().optional(),
  truncated: z.boolean().optional(),
});

/** Registers pipr runtime read tools and config-defined custom tools with Pi. */
export default function piprRuntimeTools(pi: PiExtensionHost): void {
  const registrations = toolRegistrations();
  if (registrations.length === 0) {
    throw new Error("PIPR_RUNTIME_TOOLS_DATA or PIPR_CUSTOM_TOOLS_DATA is required");
  }
  for (const registration of registrations) {
    registration.register(pi, registration.dataPath);
  }
}

function toolRegistrations(): Array<{
  dataPath: string;
  register(pi: PiExtensionHost, dataPath: string): void;
}> {
  return compact([
    registration(runtimeDataPath(), registerRuntimeReadTools),
    registration(customToolsDataPath(), registerCustomTools),
  ]);
}

function registration(
  dataPath: string | undefined,
  register: (pi: PiExtensionHost, dataPath: string) => void,
) {
  return dataPath ? { dataPath, register } : undefined;
}

function registerRuntimeReadTools(pi: PiExtensionHost, dataPath: string): void {
  const dataRoot = path.dirname(dataPath);

  pi.registerTool({
    name: "pipr_read_diff",
    label: "Read pipr Diff Manifest",
    description: "Read bounded full Diff Manifest data by path and/or range id.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        path: { type: "string" },
        rangeId: { type: "string" },
      },
    },
    async execute(_toolCallId, params) {
      const data = (await Bun.file(dataPath).json()) as RuntimeToolData;
      const result = readDiffFromRuntimeData(data, readDiffParams(params));
      return textResult(result);
    },
  });

  pi.registerTool({
    name: "pipr_read_at_ref",
    label: "Read pipr file at ref",
    description: "Read bounded file content for a Diff Manifest path at base or head.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["path", "ref", "rangeId"],
      properties: {
        path: { type: "string" },
        ref: { type: "string", enum: ["base", "head"] },
        rangeId: { type: "string" },
      },
    },
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const cwd = typeof ctx?.cwd === "string" ? ctx.cwd : "";
      const data = (await Bun.file(dataPath).json()) as RuntimeToolData;
      const result = await readAtRef(dataRoot, data, readAtRefParams(params), cwd);
      return textResult(result);
    },
  });
}

function registerCustomTools(pi: PiExtensionHost, dataPath: string): void {
  const bridgeUrl = customToolBridgeUrl();
  const bridgeToken = customToolBridgeToken();
  const data = customToolDataSchema.parse(JSON.parse(readFileSync(dataPath, "utf8")));
  for (const tool of data.tools) {
    pi.registerTool({
      name: tool.name,
      label: tool.name,
      description: tool.description ?? "pipr custom config tool.",
      parameters: {
        type: "object",
        additionalProperties: true,
      },
      async execute(_toolCallId, params) {
        const result = await callCustomTool(bridgeUrl, bridgeToken, tool.name, params);
        return textResult(result);
      },
    });
  }
}

function runtimeDataPath(): string | undefined {
  const dataPath = process.env.PIPR_RUNTIME_TOOLS_DATA;
  if (!dataPath) {
    return undefined;
  }
  if (!path.isAbsolute(dataPath)) {
    throw new Error("PIPR_RUNTIME_TOOLS_DATA must be an absolute path");
  }
  return dataPath;
}

function customToolsDataPath(): string | undefined {
  const dataPath = process.env.PIPR_CUSTOM_TOOLS_DATA;
  if (!dataPath) {
    return undefined;
  }
  if (!path.isAbsolute(dataPath)) {
    throw new Error("PIPR_CUSTOM_TOOLS_DATA must be an absolute path");
  }
  return dataPath;
}

function customToolBridgeUrl(): string {
  const value = process.env.PIPR_CUSTOM_TOOLS_BRIDGE_URL;
  if (!value) {
    throw new Error("PIPR_CUSTOM_TOOLS_BRIDGE_URL is required for pipr custom tools");
  }
  return value;
}

function customToolBridgeToken(): string {
  const value = process.env.PIPR_CUSTOM_TOOLS_BRIDGE_TOKEN;
  if (!value) {
    throw new Error("PIPR_CUSTOM_TOOLS_BRIDGE_TOKEN is required for pipr custom tools");
  }
  return value;
}

async function callCustomTool(
  bridgeUrl: string,
  bridgeToken: string,
  tool: string,
  params: unknown,
): Promise<unknown> {
  const response = await fetch(`${bridgeUrl}/call`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${bridgeToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ tool, params }),
  });
  const payload = await parseCustomToolBridgePayload(response, tool);
  assertCustomToolBridgeOk(response, payload, tool);
  return Reflect.get(payload, "result");
}

async function parseCustomToolBridgePayload(
  response: Response,
  tool: string,
): Promise<Record<string, unknown>> {
  try {
    return customToolBridgePayloadSchema.parse(await response.json());
  } catch {
    throw new Error(`Custom tool '${tool}' returned invalid bridge response`);
  }
}

function assertCustomToolBridgeOk(
  response: Response,
  payload: Record<string, unknown>,
  tool: string,
): void {
  if (!response.ok || Reflect.get(payload, "ok") !== true) {
    const error = Reflect.get(payload, "error");
    throw new Error(typeof error === "string" ? error : `Custom tool '${tool}' failed`);
  }
}

function textResult(value: unknown): ToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
    details: value,
  };
}

async function readAtRef(
  dataRoot: string,
  data: RuntimeToolData,
  params: ReadAtRefParams,
  cwd: string,
): Promise<unknown> {
  const request = resolveReadAtRefRequest(data.manifest, params);
  if (!request.window) {
    return unavailableReadAtRefResult(request);
  }
  if (params.ref === "base") {
    return await readBaseSnapshot(dataRoot, data.baseRanges[params.rangeId], params, request);
  }
  return await readHeadWorkspaceFile(cwd, data.toolResponseMaxBytes, params, request);
}

async function readBaseSnapshot(
  dataRoot: string,
  snapshot: BaseRangeSnapshot | undefined,
  params: ReadAtRefParams,
  request: ReturnType<typeof resolveReadAtRefRequest>,
): Promise<unknown> {
  const readable = readableBaseSnapshotSchema.safeParse(snapshot);
  if (!readable.success) {
    return snapshot ?? unavailableReadAtRefResult(request);
  }
  const snapshotData = readable.data;
  return {
    path: params.path,
    ref: params.ref,
    sourcePath: request.sourcePath,
    rangeId: params.rangeId,
    startLine: snapshotData.startLine,
    endLine: snapshotData.endLine,
    available: true,
    content: await Bun.file(path.join(dataRoot, snapshotData.relativePath)).text(),
    bytes: snapshotData.bytes,
    truncated: snapshotData.truncated,
  };
}

async function readHeadWorkspaceFile(
  cwd: string,
  maxBytes: number,
  params: ReadAtRefParams,
  request: ReturnType<typeof resolveReadAtRefRequest>,
): Promise<unknown> {
  if (!request.window) {
    return unavailableReadAtRefResult(request);
  }
  const target = resolveAllowedPath(cwd, request.sourcePath);
  await assertNoSymlinkPath(cwd, request.sourcePath);
  return {
    path: params.path,
    ref: params.ref,
    sourcePath: request.sourcePath,
    rangeId: params.rangeId,
    startLine: request.window.startLine,
    endLine: request.window.endLine,
    ...boundedLineSlice(await Bun.file(target).text(), request.window, maxBytes),
  };
}
