import { readdir } from "node:fs/promises";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ToolRegistration } from "@earendil-works/pi-durable";
import {
  assertNoSymlinkPath,
  parseManifestPath,
  resolveAllowedPath,
} from "../pi/runtime-tools-core.js";
import { runBoundedProcess } from "../shared/bounded-process.js";
import type { AgentWorkspaceToolName } from "./protocol.js";

const maxReadLines = 2000;
const maxOutputBytes = 50 * 1024;
const searchTimeoutMs = 30_000;
const searchStdoutLimitBytes = 4 * 1024 * 1024;

type TextDetails = Record<string, string | number | boolean>;
type TextResult = { content: Array<{ type: "text"; text: string }>; details: TextDetails };

/** Read-only workspace tools; every path stays inside `cwd` and never crosses a symlink. */
export function createWorkspaceTools(
  names: readonly AgentWorkspaceToolName[],
  cwd: string,
): ToolRegistration[] {
  const factories: Record<AgentWorkspaceToolName, (cwd: string) => ToolRegistration> = {
    read: readTool,
    grep: grepTool,
    find: findTool,
    ls: lsTool,
  };
  return names.map((name) => factories[name](cwd));
}

function readTool(cwd: string): ToolRegistration {
  return defineTool({
    name: "read",
    description: `Read a text file in the workspace. Output is limited to ${maxReadLines} lines or ${maxOutputBytes / 1024}KB; use offset and limit to continue.`,
    replay: "safe",
    parameters: Type.Object({
      path: Type.String({ description: "Workspace-relative file path" }),
      offset: Type.Optional(
        Type.Integer({ minimum: 1, description: "1-indexed line to start from" }),
      ),
      limit: Type.Optional(
        Type.Integer({ minimum: 1, description: "Maximum number of lines to read" }),
      ),
    }),
    execute: async (args) => {
      const target = await workspaceTarget(cwd, args.path);
      const lines = (await Bun.file(target).text()).split("\n");
      const start = (args.offset ?? 1) - 1;
      if (start >= lines.length) {
        throw new Error(
          `Offset ${args.offset} is beyond end of file (${lines.length} lines total)`,
        );
      }
      const end = Math.min(
        lines.length,
        start + Math.min(args.limit ?? maxReadLines, maxReadLines),
      );
      const { text, shownLines } = boundLines(lines.slice(start, end));
      const lastShown = start + shownLines;
      const remark =
        lastShown < lines.length
          ? `\n\n[Showing lines ${start + 1}-${lastShown} of ${lines.length}. Use offset=${lastShown + 1} to continue.]`
          : "";
      return textResult(`${text}${remark}`, {
        path: args.path,
        startLine: start + 1,
        endLine: lastShown,
        totalLines: lines.length,
      });
    },
  }) as unknown as ToolRegistration;
}

function grepTool(cwd: string): ToolRegistration {
  return defineTool({
    name: "grep",
    description:
      "Search workspace file contents with a regular expression (ripgrep syntax). Respects .gitignore. Returns path:line:text matches.",
    replay: "safe",
    parameters: Type.Object({
      pattern: Type.String({
        description: "Regular expression, or a literal string with literal=true",
      }),
      path: Type.Optional(
        Type.String({ description: "Workspace-relative directory or file to search" }),
      ),
      glob: Type.Optional(Type.String({ description: "Only search files matching this glob" })),
      ignoreCase: Type.Optional(Type.Boolean()),
      literal: Type.Optional(Type.Boolean()),
      context: Type.Optional(Type.Integer({ minimum: 0, maximum: 10 })),
      limit: Type.Optional(
        Type.Integer({ minimum: 1, maximum: 500, description: "Maximum output lines" }),
      ),
    }),
    execute: async (args) => {
      const searchPath = await workspaceSearchPath(cwd, args.path);
      const output = await ripgrep(cwd, [
        "--line-number",
        "--no-heading",
        "--with-filename",
        "--max-columns",
        "500",
        ...(args.ignoreCase ? ["--ignore-case"] : []),
        ...(args.literal ? ["--fixed-strings"] : []),
        ...(args.context ? ["--context", String(args.context)] : []),
        ...(args.glob ? ["--glob", args.glob] : []),
        "--regexp",
        args.pattern,
        ...searchPath,
      ]);
      return limitedListResult(output, args.limit ?? 100, "No matches found");
    },
  }) as unknown as ToolRegistration;
}

function findTool(cwd: string): ToolRegistration {
  return defineTool({
    name: "find",
    description: "Find workspace files whose path matches a glob. Respects .gitignore.",
    replay: "safe",
    parameters: Type.Object({
      pattern: Type.String({ description: "Glob such as '**/*.ts' or 'src/**/config.*'" }),
      path: Type.Optional(Type.String({ description: "Workspace-relative directory to search" })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 1000 })),
    }),
    execute: async (args) => {
      const searchPath = await workspaceSearchPath(cwd, args.path);
      const output = await ripgrep(cwd, ["--files", "--glob", args.pattern, ...searchPath]);
      return limitedListResult(output, args.limit ?? 1000, "No files found");
    },
  }) as unknown as ToolRegistration;
}

function lsTool(cwd: string): ToolRegistration {
  return defineTool({
    name: "ls",
    description: "List a workspace directory. Directories end with '/'.",
    replay: "safe",
    parameters: Type.Object({
      path: Type.Optional(Type.String({ description: "Workspace-relative directory" })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 1000 })),
    }),
    execute: async (args) => {
      const target = args.path && args.path !== "." ? await workspaceTarget(cwd, args.path) : cwd;
      const entries = (await readdir(target, { withFileTypes: true }))
        .filter((entry) => entry.name !== ".git")
        .map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name))
        .sort((left, right) => left.localeCompare(right));
      return limitedListResult(entries.join("\n"), args.limit ?? 500, "(empty directory)");
    },
  }) as unknown as ToolRegistration;
}

async function workspaceTarget(cwd: string, filePath: string): Promise<string> {
  const relative = parseManifestPath(filePath.replace(/\/+$/, ""));
  const target = resolveAllowedPath(cwd, relative);
  await assertNoSymlinkPath(cwd, relative);
  return target;
}

/** The trailing `-- <path>` arguments; the workspace root is ripgrep's default so results stay unprefixed. */
async function workspaceSearchPath(cwd: string, filePath: string | undefined): Promise<string[]> {
  if (!filePath || filePath === ".") return [];
  await workspaceTarget(cwd, filePath);
  return ["--", filePath.replace(/\/+$/, "")];
}

async function ripgrep(cwd: string, args: string[]): Promise<string> {
  const result = await runBoundedProcess(
    [
      "rg",
      "--color",
      "never",
      "--sort",
      "path",
      "--hidden",
      "--glob",
      "!.git",
      "--no-follow",
      ...args,
    ],
    {
      cwd,
      timeoutMs: searchTimeoutMs,
      stdoutLimitBytes: searchStdoutLimitBytes,
      stderrLimitBytes: 64 * 1024,
      errors: {
        spawn: () => new Error("ripgrep is not available"),
        timeout: () => new Error("Search timed out; narrow the path or pattern"),
        outputLimit: () => new Error("Search produced too much output; narrow the path or pattern"),
      },
    },
  );
  if (result.exitCode === 1) return "";
  if (result.exitCode !== 0) {
    throw new Error(result.stderr.trim() || `ripgrep exited with code ${result.exitCode}`);
  }
  return result.stdout.replace(/\n$/, "");
}

function limitedListResult(output: string, limit: number, empty: string): TextResult {
  if (output === "") return textResult(empty, { count: 0, truncated: false });
  const lines = output.split("\n");
  const { text, shownLines } = boundLines(lines.slice(0, limit));
  const truncated = shownLines < lines.length;
  const remark = truncated
    ? `\n\n[Showing ${shownLines} of ${lines.length} lines. Narrow the search to see more.]`
    : "";
  return textResult(`${text}${remark}`, { count: lines.length, truncated });
}

function boundLines(lines: string[]): { text: string; shownLines: number } {
  let bytes = 0;
  let shownLines = 0;
  for (const line of lines) {
    const lineBytes = Buffer.byteLength(line, "utf8") + 1;
    if (bytes + lineBytes > maxOutputBytes && shownLines > 0) break;
    bytes += lineBytes;
    shownLines += 1;
  }
  const text = lines.slice(0, shownLines).join("\n");
  return {
    text: Buffer.from(text, "utf8").subarray(0, maxOutputBytes).toString("utf8"),
    shownLines,
  };
}

function textResult(text: string, details: TextDetails): TextResult {
  return { content: [{ type: "text", text }], details };
}
