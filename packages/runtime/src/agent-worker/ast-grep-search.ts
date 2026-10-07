import path from "node:path";
import { z } from "zod";
import { runBoundedProcess } from "../shared/bounded-process.js";
import { assertSerializedToolResponseFits, serializedToolResponseBytes } from "./tool-result.js";
import { assertNoSymlinkPath, resolveAllowedPath } from "./workspace-paths.js";

type AstGrepSearchParams = {
  pattern: string;
  language: string;
  paths: string[];
};

const astGrepSearchParamsSchema = z.strictObject({
  pattern: z.string().min(1).max(4096),
  language: z.string().min(1).max(64),
  paths: z.array(z.string()).min(1).max(16),
});
const astGrepMatchSchema = z.looseObject({
  text: z.string(),
  file: z.string(),
  range: z.object({
    start: z.object({
      line: z.number().int().nonnegative(),
      column: z.number().int().nonnegative(),
    }),
    end: z.object({
      line: z.number().int().nonnegative(),
      column: z.number().int().nonnegative(),
    }),
  }),
});
const astGrepMatchesSchema = z.array(astGrepMatchSchema);

export function astGrepSearchParams(params: unknown): AstGrepSearchParams {
  const parsed = astGrepSearchParamsSchema.parse(params);
  return {
    pattern: parsed.pattern,
    language: parsed.language,
    paths: parsed.paths.map(parseSearchPath),
  };
}

export async function runAstGrepSearch(options: {
  cwd: string;
  params: AstGrepSearchParams;
  maxBytes: number;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}): Promise<unknown> {
  for (const searchPath of options.params.paths) {
    if (searchPath !== ".") {
      resolveAllowedPath(options.cwd, searchPath);
      await assertNoSymlinkPath(options.cwd, searchPath);
    }
  }
  const result = await runAstGrepProcess(
    [
      "ast-grep",
      "run",
      "--pattern",
      options.params.pattern,
      "--lang",
      options.params.language,
      "--json=compact",
      "--color",
      "never",
      "--",
      ...options.params.paths,
    ],
    {
      cwd: options.cwd,
      env: options.env,
      timeoutMs: options.timeoutMs ?? 10_000,
    },
  );
  const output = result.stdout.trim();
  if (result.exitCode === 1 && (output === "" || output === "[]")) {
    return assertSerializedToolResponseFits(
      { available: true, matches: [], truncated: false },
      options.maxBytes,
      "pipr_ast_grep response limit is too small",
    );
  }
  if (result.exitCode !== 0) {
    throw new Error("pipr_ast_grep failed");
  }
  let json: unknown;
  try {
    json = JSON.parse(output);
  } catch {
    throw new Error("pipr_ast_grep returned invalid output");
  }
  const parsed = astGrepMatchesSchema.safeParse(json);
  if (!parsed.success) {
    throw new Error("pipr_ast_grep returned invalid output");
  }
  const matches: Array<{
    path: string;
    startLine: number;
    endLine: number;
    text: string;
  }> = [];
  let truncated = parsed.data.length > 100;
  for (const match of parsed.data.slice(0, 100)) {
    const normalized = {
      path: parseSearchResultPath(match.file),
      startLine: match.range.start.line + 1,
      endLine: match.range.end.line + 1,
      text: truncateUtf8(match.text, 2 * 1024),
    };
    const candidate = { available: true, matches: [...matches, normalized], truncated };
    if (serializedToolResponseBytes(candidate) > options.maxBytes) {
      truncated = true;
      break;
    }
    matches.push(normalized);
  }
  return assertSerializedToolResponseFits(
    { available: true, matches, truncated },
    options.maxBytes,
    "pipr_ast_grep response limit is too small",
  );
}

function parseSearchPath(value: string): string {
  if (value === ".") {
    return value;
  }
  if (
    value.includes("\\") ||
    /[*?[\]{}]/.test(value) ||
    path.isAbsolute(value) ||
    value.includes("\0") ||
    value.split("/").some((part) => part === "" || part === "." || part === ".." || part === ".git")
  ) {
    throw new Error(`Unsafe structural search path '${value}'`);
  }
  return value;
}

function parseSearchResultPath(value: string): string {
  try {
    return parseSearchPath(value);
  } catch {
    throw new Error("pipr_ast_grep returned an unsafe path");
  }
}

function truncateUtf8(value: string, maxBytes: number): string {
  const buffer = Buffer.from(value, "utf8");
  return buffer.byteLength <= maxBytes ? value : buffer.subarray(0, maxBytes).toString("utf8");
}

async function runAstGrepProcess(
  command: [string, ...string[]],
  options: {
    cwd: string;
    env?: NodeJS.ProcessEnv;
    timeoutMs: number;
  },
): Promise<{ stdout: string; exitCode: number }> {
  const result = await runBoundedProcess(command, {
    ...options,
    stdoutLimitBytes: 16 * 1024 * 1024,
    stderrLimitBytes: 1024 * 1024,
    errors: {
      spawn: () => new Error("pipr_ast_grep is unavailable"),
      timeout: () => new Error("pipr_ast_grep timed out"),
      outputLimit: () => new Error("pipr_ast_grep exceeded its output limit"),
    },
  });
  return { stdout: result.stdout, exitCode: result.exitCode };
}
