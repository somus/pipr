import { mkdir } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { piRuntimeToolsExtensionPath } from "./runtime-tools.js";

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

export type PreparedPiCustomTools = {
  readonly extensionPath: string;
  readonly dataPath: string;
  readonly bridgeUrl: string;
  readonly bridgeToken: string;
  readonly toolNames: readonly string[];
  close(): Promise<void>;
};

const bridgePayloadSchema = z.object({
  tool: z.string({ error: "Custom tool bridge payload missing tool" }).min(1),
  params: z.unknown().optional(),
});

export async function preparePiCustomTools(options: {
  root: string;
  request: PiCustomToolRequest;
}): Promise<PreparedPiCustomTools> {
  const extensionPath = await piRuntimeToolsExtensionPath();
  const toolRoot = path.join(options.root, "custom-tools");
  await mkdir(toolRoot, { recursive: true });
  const dataPath = path.join(toolRoot, "data.json");
  await Bun.write(
    dataPath,
    JSON.stringify({
      tools: options.request.tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
      })),
    }),
  );

  const bridge = await startCustomToolBridge(options.request.tools, options.request.context);
  return {
    extensionPath,
    dataPath,
    bridgeUrl: bridge.url,
    bridgeToken: bridge.token,
    toolNames: options.request.tools.map((tool) => tool.name),
    close: bridge.close,
  };
}

async function startCustomToolBridge(
  tools: readonly PiCustomToolDefinition[],
  context: unknown,
): Promise<{ url: string; token: string; close(): Promise<void> }> {
  const token = randomTokenHex(24);
  const toolsByName = new Map(tools.map((tool) => [tool.name, tool]));
  let server: ReturnType<typeof Bun.serve> | undefined;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const port = 49152 + (crypto.getRandomValues(new Uint16Array(1))[0] % 16384);
    try {
      server = Bun.serve({
        hostname: "127.0.0.1",
        port,
        fetch: (request) => handleBridgeRequest(request, token, toolsByName, context),
      });
      break;
    } catch (error) {
      const code = error && typeof error === "object" ? Reflect.get(error, "code") : undefined;
      if (code !== "EADDRINUSE") {
        throw error;
      }
    }
  }
  if (!server) {
    throw new Error("Unable to start custom tool bridge");
  }
  return {
    url: `http://127.0.0.1:${server.port}`,
    token,
    close: async () => {
      server.stop(true);
    },
  };
}

async function handleBridgeRequest(
  request: Request,
  token: string,
  tools: Map<string, PiCustomToolDefinition>,
  context: unknown,
): Promise<Response> {
  try {
    if (request.method !== "POST" || new URL(request.url).pathname !== "/call") {
      return jsonResponse(404, { ok: false, error: "Unknown custom tool bridge route" });
    }
    if (request.headers.get("authorization") !== `Bearer ${token}`) {
      return jsonResponse(401, { ok: false, error: "Invalid custom tool bridge token" });
    }

    const body = await request.text();
    if (body.length > 1024 * 1024) {
      throw new Error("Custom tool bridge request is too large");
    }
    const payload = bridgePayloadSchema.parse(JSON.parse(body));
    const tool = tools.get(payload.tool);
    if (!tool) {
      return jsonResponse(404, { ok: false, error: `Unknown custom tool '${payload.tool}'` });
    }

    const input = tool.input.parse(payload.params);
    const output = await tool.execute(context, input);
    const result = tool.output.parse(output);
    return jsonResponse(200, { ok: true, result });
  } catch (error) {
    return jsonResponse(500, {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function jsonResponse(status: number, value: unknown): Response {
  return Response.json(value, { status });
}

function randomTokenHex(bytes: number): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (value) =>
    value.toString(16).padStart(2, "0"),
  ).join("");
}
