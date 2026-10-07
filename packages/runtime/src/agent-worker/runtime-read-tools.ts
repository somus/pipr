import path from "node:path";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ToolRegistration } from "@earendil-works/pi-durable";
import { z } from "zod";
import {
  assertNoSymlinkPath,
  assertSerializedToolResponseFits,
  astGrepSearchParams,
  type BaseDeclarationSnapshot,
  type BaseRangeSnapshot,
  boundedLineSlice,
  boundToolResponseContent,
  type ReadAtRefParams,
  type RuntimeToolData,
  readAtRefParams,
  readDeclarationParams,
  readDiffFromRuntimeData,
  readDiffParams,
  resolveAllowedPath,
  resolveDeclarationRequest,
  resolveReadAtRefRequest,
  runAstGrepSearch,
  unavailableReadAtRefResult,
} from "../pi/runtime-tools-core.js";
import { jsonToolResult } from "./tool-result.js";

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
const readableBaseDeclarationSnapshotSchema = z.looseObject({
  path: z.string(),
  ref: z.literal("base"),
  sourcePath: z.string(),
  rangeId: z.string(),
  declaration: z.looseObject({
    qualifiedName: z.string(),
    kind: z.string(),
    startLine: z.number(),
    endLine: z.number(),
  }),
  available: z.literal(true),
  relativePath: z.string(),
  bytes: z.number().optional(),
  truncated: z.boolean().optional(),
});

const rangeReadParameters = Type.Object(
  {
    path: Type.String(),
    ref: Type.Union([Type.Literal("base"), Type.Literal("head")]),
    rangeId: Type.String(),
  },
  { additionalProperties: false },
);

/**
 * Diff Manifest read tools over the runtime data file the supervisor prepared for this run. Results depend only on
 * that file and the run's workspace snapshot, so they replay safely.
 */
export async function createRuntimeReadTools(
  dataPath: string,
  cwd: string,
): Promise<ToolRegistration[]> {
  const dataRoot = path.dirname(dataPath);
  const data = (await Bun.file(dataPath).json()) as RuntimeToolData;
  const tools = [
    defineTool({
      name: "pipr_read_diff",
      description: "Read bounded full Diff Manifest data by path and/or range id.",
      replay: "safe",
      parameters: Type.Object(
        { path: Type.Optional(Type.String()), rangeId: Type.Optional(Type.String()) },
        { additionalProperties: false },
      ),
      execute: async (args) => jsonToolResult(readDiffFromRuntimeData(data, readDiffParams(args))),
    }),
    defineTool({
      name: "pipr_read_at_ref",
      description: "Read bounded file content for a Diff Manifest path at base or head.",
      replay: "safe",
      parameters: rangeReadParameters,
      execute: async (args) =>
        jsonToolResult(await readAtRef(dataRoot, data, readAtRefParams(args), cwd)),
    }),
  ];
  if (!data.structuralAnalysis) {
    return tools as unknown as ToolRegistration[];
  }
  return [
    ...tools,
    defineTool({
      name: "pipr_read_declaration",
      description:
        "Read bounded enclosing declaration context for one Diff Manifest path, ref, and range id.",
      replay: "safe",
      parameters: rangeReadParameters,
      execute: async (args) =>
        jsonToolResult(await readDeclaration(dataRoot, data, readDeclarationParams(args), cwd)),
    }),
    defineTool({
      name: "pipr_ast_grep",
      description: "Search syntax-specific patterns in explicit safe paths in the head workspace.",
      replay: "safe",
      parameters: Type.Object(
        {
          pattern: Type.String({ maxLength: 4096 }),
          language: Type.String(),
          paths: Type.Array(Type.String(), { minItems: 1, maxItems: 16 }),
        },
        { additionalProperties: false },
      ),
      execute: async (args) =>
        jsonToolResult(
          await runAstGrepSearch({
            cwd,
            params: astGrepSearchParams(args),
            maxBytes: data.toolResponseMaxBytes,
          }),
        ),
    }),
  ] as unknown as ToolRegistration[];
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

async function readDeclaration(
  dataRoot: string,
  data: RuntimeToolData,
  params: ReturnType<typeof readDeclarationParams>,
  cwd: string,
): Promise<unknown> {
  const request = resolveDeclarationRequest(data, params);
  if (!request.available) {
    return assertSerializedToolResponseFits(
      request,
      data.toolResponseMaxBytes,
      "pipr_read_declaration response limit is too small",
    );
  }
  if (params.ref === "base") {
    return await readBaseDeclarationSnapshot(
      dataRoot,
      data.baseDeclarations?.[params.rangeId],
      request,
      data.toolResponseMaxBytes,
    );
  }
  const target = resolveAllowedPath(cwd, request.sourcePath);
  await assertNoSymlinkPath(cwd, request.sourcePath);
  return boundToolResponseContent(
    {
      ...request,
      declaration: declarationResult(request.declaration),
      ...boundedLineSlice(
        await Bun.file(target).text(),
        {
          startLine: request.declaration.startLine,
          endLine: request.declaration.endLine,
        },
        data.toolResponseMaxBytes,
      ),
    },
    data.toolResponseMaxBytes,
    "pipr_read_declaration response limit is too small",
  );
}

async function readBaseDeclarationSnapshot(
  dataRoot: string,
  snapshot: BaseDeclarationSnapshot | undefined,
  request: Extract<ReturnType<typeof resolveDeclarationRequest>, { available: true }>,
  maxBytes: number,
): Promise<unknown> {
  const readable = readableBaseDeclarationSnapshotSchema.safeParse(snapshot);
  if (!readable.success) {
    const { declaration: _declaration, ...unavailable } = request;
    return assertSerializedToolResponseFits(
      { ...unavailable, available: false },
      maxBytes,
      "pipr_read_declaration response limit is too small",
    );
  }
  return boundToolResponseContent(
    {
      path: request.path,
      sourcePath: request.sourcePath,
      ref: request.ref,
      rangeId: request.rangeId,
      declaration: declarationResult(request.declaration),
      available: true,
      content: await Bun.file(path.join(dataRoot, readable.data.relativePath)).text(),
      bytes: readable.data.bytes,
      truncated: readable.data.truncated,
    },
    maxBytes,
    "pipr_read_declaration response limit is too small",
  );
}

function declarationResult(declaration: {
  qualifiedName: string;
  kind: string;
  startLine: number;
  endLine: number;
}) {
  return {
    qualifiedName: declaration.qualifiedName,
    kind: declaration.kind,
    startLine: declaration.startLine,
    endLine: declaration.endLine,
  };
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
