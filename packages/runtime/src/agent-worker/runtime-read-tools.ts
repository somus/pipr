import path from "node:path";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ToolRegistration } from "@earendil-works/pi-durable";
import { z } from "zod";
import { findEnclosingDeclaration } from "../diff/manifest-structure.js";
import { createDiffRangeIndex } from "../diff/ranges.js";
import type { StructuralDeclaration } from "../diff/structural-analysis.js";
import { isRecord } from "../shared/record.js";
import type { DiffManifestFile } from "../types.js";
import { astGrepSearchParams, runAstGrepSearch } from "./ast-grep-search.js";
import {
  type BaseDeclarationSnapshot,
  type BaseRangeSnapshot,
  boundedLineSlice,
  parseManifestPath,
  type ReadAtRefParams,
  type RuntimeToolData,
  readRuntimeToolData,
  resolveReadAtRefRequest,
  unavailableReadAtRefResult,
} from "./runtime-tool-data.js";
import {
  assertSerializedToolResponseFits,
  boundToolResponseContent,
  jsonToolResult,
} from "./tool-result.js";
import { assertNoSymlinkPath, resolveAllowedPath } from "./workspace-paths.js";

const readDiffParamsSchema = z.preprocess(
  (params) => {
    const record = isRecord(params) ? params : {};
    return {
      path: typeof record.path === "string" ? record.path : undefined,
      rangeId: typeof record.rangeId === "string" ? record.rangeId : undefined,
    };
  },
  z.object({
    path: z.string().optional(),
    rangeId: z.string().optional(),
  }),
);

const readAtRefParamsSchema = z.preprocess(
  (params) => (isRecord(params) ? params : {}),
  z.object({
    path: z.unknown(),
    ref: z.enum(["base", "head"], {
      error: (issue) => `Unsupported ref '${String(issue.input)}'`,
    }),
    rangeId: z.string({ error: "rangeId must be a string" }),
  }),
);

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
  const data = await readRuntimeToolData(dataPath);
  const tools = [
    defineTool({
      name: "pipr_read_diff",
      description: "Read bounded full Diff Manifest data by path and/or range id.",
      replay: "safe",
      parameters: Type.Object(
        { path: Type.Optional(Type.String()), rangeId: Type.Optional(Type.String()) },
        { additionalProperties: false },
      ),
      execute: async (args) =>
        jsonToolResult(readDiffFromRuntimeData(data, readDiffParamsSchema.parse(args))),
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
        jsonToolResult(await readDeclaration(dataRoot, data, readAtRefParams(args), cwd)),
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

function readDiffFromRuntimeData(
  data: RuntimeToolData,
  params: z.infer<typeof readDiffParamsSchema>,
): unknown {
  const { rangeId } = params;
  const filePath = params.path === undefined ? undefined : parseManifestPath(params.path);
  const ranges = createDiffRangeIndex(data.manifest);
  if (filePath !== undefined) {
    ranges.requireFile(filePath);
  }
  if (rangeId !== undefined && !ranges.findRange(rangeId)) {
    throw new Error(`Unknown Diff Manifest range '${rangeId}'`);
  }
  const files = data.manifest.files
    .filter((file) => filePath === undefined || file.path === filePath)
    .map((file) => filterManifestFileRanges(file, rangeId))
    .filter((file) => rangeId === undefined || file.commentableRanges.length > 0);
  return boundedJson({ files }, data.toolResponseMaxBytes);
}

function boundedJson(value: unknown, maxBytes: number): unknown {
  const text = JSON.stringify(value, null, 2);
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes <= maxBytes) {
    return { truncated: false, bytes, value };
  }
  return {
    truncated: true,
    bytes,
    maxBytes,
    text: Buffer.from(text, "utf8").subarray(0, maxBytes).toString("utf8"),
  };
}

function filterManifestFileRanges(
  file: DiffManifestFile,
  rangeId: string | undefined,
): DiffManifestFile {
  if (rangeId === undefined) {
    return file;
  }
  return {
    ...file,
    commentableRanges: file.commentableRanges.filter((range) => range.id === rangeId),
  };
}

function readAtRefParams(params: unknown): ReadAtRefParams {
  const parsed = readAtRefParamsSchema.parse(params);
  return { path: parseManifestPath(parsed.path), ref: parsed.ref, rangeId: parsed.rangeId };
}

function resolveDeclarationRequest(
  data: RuntimeToolData,
  params: ReadAtRefParams,
):
  | {
      available: true;
      path: string;
      sourcePath: string;
      ref: "base" | "head";
      rangeId: string;
      declaration: StructuralDeclaration;
    }
  | {
      available: false;
      path: string;
      sourcePath: string;
      ref: "base" | "head";
      rangeId: string;
    } {
  const filePath = parseManifestPath(params.path);
  const ranges = createDiffRangeIndex(data.manifest);
  const file = ranges.requireFile(filePath);
  const range = ranges.requireRangeInFile(file, params.rangeId);
  const sourcePath = parseManifestPath(
    params.ref === "base" ? (file.previousPath ?? file.path) : file.path,
  );
  const expectedSide = params.ref === "base" ? "LEFT" : "RIGHT";
  if (!data.structuralAnalysis || range.side !== expectedSide) {
    return {
      available: false,
      path: file.path,
      sourcePath,
      ref: params.ref,
      rangeId: range.id,
    };
  }
  const owner = findEnclosingDeclaration(file, range, data.structuralAnalysis);
  if (!owner || owner.ref !== params.ref) {
    return {
      available: false,
      path: file.path,
      sourcePath,
      ref: params.ref,
      rangeId: range.id,
    };
  }
  return {
    available: true,
    path: file.path,
    sourcePath: owner.sourcePath,
    ref: params.ref,
    rangeId: range.id,
    declaration: owner.declaration,
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

async function readDeclaration(
  dataRoot: string,
  data: RuntimeToolData,
  params: ReadAtRefParams,
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
  if (!snapshot) {
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
      content: await Bun.file(path.join(dataRoot, snapshot.relativePath)).text(),
      bytes: snapshot.bytes,
      truncated: snapshot.truncated,
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
  if (!snapshot?.available) {
    return snapshot ?? unavailableReadAtRefResult(request);
  }
  return {
    path: params.path,
    ref: params.ref,
    sourcePath: request.sourcePath,
    rangeId: params.rangeId,
    startLine: snapshot.startLine,
    endLine: snapshot.endLine,
    available: true,
    content: await Bun.file(path.join(dataRoot, snapshot.relativePath)).text(),
    bytes: snapshot.bytes,
    truncated: snapshot.truncated,
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
