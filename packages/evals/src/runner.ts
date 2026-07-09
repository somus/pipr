import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as z from "zod";
import type { PiprEvalCase } from "./cases.js";
import { evalReviewEnv, evalSubprocessEnv } from "./env.js";

type PiprEvalRunMode = "live" | "deterministic";

type PiprEvalRunOptions = {
  mode: PiprEvalRunMode;
  piExecutable?: string;
};

const evalSideSchema = z.enum(["RIGHT", "LEFT"]);
const evalRangeKindSchema = z.enum(["added", "deleted", "context", "mixed"]);

const evalInlineFindingSchema = z.object({
  body: z.string(),
  path: z.string(),
  rangeId: z.string(),
  side: evalSideSchema,
  startLine: z.number().int(),
  endLine: z.number().int(),
  suggestedFix: z.string().optional(),
});

const evalDiffRangeSchema = z.object({
  path: z.string(),
  rangeId: z.string(),
  side: evalSideSchema,
  startLine: z.number().int(),
  endLine: z.number().int(),
  kind: evalRangeKindSchema,
  preview: z.string().optional(),
});

const evalPiCallSchema = z.object({
  inlineFindingBodyPolicy: z.boolean(),
  reviewPolicy: z.boolean(),
  schemaOnlySystemPrompt: z.boolean(),
  strictJsonSystemPrompt: z.boolean(),
  secretHygieneSystemPrompt: z.boolean(),
  systemPromptHasReviewPolicy: z.boolean(),
  untrustedDataSystemPrompt: z.boolean(),
  promptBytes: z.number().int(),
});

const evalDroppedFindingSchema = z.object({
  reason: z.string(),
  path: z.string(),
  rangeId: z.string(),
  side: evalSideSchema,
  startLine: z.number().int(),
  endLine: z.number().int(),
});

const localReviewEvalJsonSchema = z.object({
  kind: z.enum(["review", "skipped"]),
  reviewSummary: z.string(),
  mainComment: z.string(),
  inlineFindings: z.array(z.object({ finding: evalInlineFindingSchema })),
  validated: z.object({
    validFindings: z.array(evalInlineFindingSchema),
    droppedFindings: z.array(evalDroppedFindingSchema),
  }),
  diffRanges: z.array(evalDiffRangeSchema),
});

export type EvalInlineFinding = z.infer<typeof evalInlineFindingSchema>;
export type EvalDiffRange = z.infer<typeof evalDiffRangeSchema>;
export type EvalPiCall = z.infer<typeof evalPiCallSchema>;
export type EvalDroppedFinding = z.infer<typeof evalDroppedFindingSchema>;

export type PiprEvalOutput = {
  ok: boolean;
  kind?: "review" | "skipped";
  fixturePath?: string;
  error?: string;
  reviewSummary?: string;
  mainComment?: string;
  inlineFindings: EvalInlineFinding[];
  publicationInlineFindings: EvalInlineFinding[];
  droppedFindings: EvalDroppedFinding[];
  diffRanges: EvalDiffRange[];
  piCalls: EvalPiCall[];
};

type ForbiddenOutputSnapshot = Pick<
  PiprEvalOutput,
  "droppedFindings" | "error" | "inlineFindings" | "mainComment" | "reviewSummary"
>;

const sourceDir = path.dirname(fileURLToPath(import.meta.url));
const packagedFakePi = fileURLToPath(new URL("./fake-pi.ts", import.meta.url));
const forbiddenOutputSnapshotKey = Symbol("piprEvalForbiddenOutputSnapshot");
const textDecoder = new TextDecoder();

export async function runPiprEvalCase(
  testCase: PiprEvalCase,
  options: PiprEvalRunOptions,
): Promise<PiprEvalOutput> {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), `pipr-eval-${testCase.id}-`));
  const callsDir =
    options.mode === "deterministic" ? path.join(rootDir, ".pipr-eval-pi-calls") : undefined;
  try {
    return await runPreparedFixture(rootDir, callsDir, testCase, options);
  } catch (error) {
    return await failedEvalOutput(
      rootDir,
      callsDir,
      error,
      testCase.expected.forbiddenOutputSubstrings ?? [],
    );
  }
}

async function runPreparedFixture(
  rootDir: string,
  callsDir: string | undefined,
  testCase: PiprEvalCase,
  options: PiprEvalRunOptions,
): Promise<PiprEvalOutput> {
  const runOptions = evalRunOptions(options);
  assertRunOptions(runOptions);
  const { baseSha, headSha } = await prepareFixture(rootDir, testCase);
  const result = runLocalReview(rootDir, baseSha, headSha, {
    mode: runOptions.mode,
    callsDir,
    piExecutable: runOptions.piExecutable,
  });
  const output = await successfulEvalOutput(
    rootDir,
    callsDir,
    result,
    testCase.expected.forbiddenOutputSubstrings ?? [],
  );
  await cleanupFixture(rootDir);
  return output;
}

function evalRunOptions(options: PiprEvalRunOptions): PiprEvalRunOptions {
  if (options.mode === "live") {
    return options;
  }
  return {
    ...options,
    piExecutable: options.piExecutable ?? process.env.PIPR_EVAL_PI_EXECUTABLE ?? packagedFakePi,
  };
}

async function successfulEvalOutput(
  rootDir: string,
  callsDir: string | undefined,
  result: LocalReviewEvalJson,
  forbiddenOutputSubstrings: string[],
): Promise<PiprEvalOutput> {
  return withForbiddenOutputSnapshot(
    {
      reviewSummary: result.reviewSummary,
      mainComment: result.mainComment,
      inlineFindings: result.validated.validFindings,
      droppedFindings: result.validated.droppedFindings,
    },
    {
      ok: true,
      kind: result.kind,
      fixturePath: keepFixtures() ? rootDir : undefined,
      reviewSummary: sanitizeEvalText(result.reviewSummary, forbiddenOutputSubstrings),
      mainComment: sanitizeEvalText(result.mainComment, forbiddenOutputSubstrings),
      inlineFindings: sanitizeEvalInlineFindings(
        result.validated.validFindings,
        forbiddenOutputSubstrings,
      ),
      publicationInlineFindings: sanitizeEvalInlineFindings(
        result.inlineFindings.map((draft) => draft.finding),
        forbiddenOutputSubstrings,
      ),
      droppedFindings: result.validated.droppedFindings.map((finding) => ({
        ...finding,
        reason: sanitizeEvalText(finding.reason, forbiddenOutputSubstrings),
      })),
      diffRanges: result.diffRanges.map((range) => ({
        ...range,
        preview: range.preview
          ? sanitizeEvalText(range.preview, forbiddenOutputSubstrings)
          : undefined,
      })),
      piCalls: await readPiCalls(callsDir),
    } satisfies PiprEvalOutput,
  );
}

export function piprEvalForbiddenOutputText(output: PiprEvalOutput): string {
  const snapshot =
    (
      output as PiprEvalOutput & {
        [forbiddenOutputSnapshotKey]?: ForbiddenOutputSnapshot;
      }
    )[forbiddenOutputSnapshotKey] ?? output;
  return [
    snapshot.reviewSummary ?? "",
    snapshot.mainComment ?? "",
    snapshot.error ?? "",
    ...snapshot.inlineFindings.flatMap((finding) => [
      finding.body,
      finding.path,
      finding.rangeId,
      finding.suggestedFix ?? "",
    ]),
    ...snapshot.droppedFindings.flatMap((finding) => [
      finding.reason,
      finding.path,
      finding.rangeId,
    ]),
  ].join("\n");
}

function withForbiddenOutputSnapshot(
  snapshot: ForbiddenOutputSnapshot,
  output: PiprEvalOutput,
): PiprEvalOutput {
  Object.defineProperty(output, forbiddenOutputSnapshotKey, {
    enumerable: false,
    value: snapshot,
  });
  return output;
}

function sanitizeEvalInlineFindings(
  findings: EvalInlineFinding[],
  forbiddenOutputSubstrings: string[],
): EvalInlineFinding[] {
  return findings.map((finding) => ({
    ...finding,
    body: sanitizeEvalText(finding.body, forbiddenOutputSubstrings),
    ...(finding.suggestedFix
      ? { suggestedFix: sanitizeEvalText(finding.suggestedFix, forbiddenOutputSubstrings) }
      : {}),
  }));
}

function sanitizeEvalText(value: string, forbiddenOutputSubstrings: string[]): string {
  let sanitized = value;
  for (const forbidden of forbiddenOutputSubstrings) {
    if (forbidden.length === 0) {
      continue;
    }
    sanitized = sanitized.replace(
      new RegExp(escapeRegExp(forbidden), "gi"),
      "[redacted eval output]",
    );
  }
  return sanitized;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function failedEvalOutput(
  rootDir: string,
  callsDir: string | undefined,
  error: unknown,
  forbiddenOutputSubstrings: string[],
): Promise<PiprEvalOutput> {
  const piCallsResult = await readPiCallsAfterFailure(callsDir);
  const originalError = error instanceof Error ? error.message : String(error);
  const rawError = piCallsResult.error ? `${originalError}; ${piCallsResult.error}` : originalError;
  const output = withForbiddenOutputSnapshot(
    {
      error: rawError,
      inlineFindings: [],
      droppedFindings: [],
    },
    {
      ok: false,
      fixturePath: keepFixtures() ? rootDir : undefined,
      error: sanitizeEvalText(rawError, forbiddenOutputSubstrings),
      inlineFindings: [],
      publicationInlineFindings: [],
      droppedFindings: [],
      diffRanges: [],
      piCalls: piCallsResult.piCalls,
    } satisfies PiprEvalOutput,
  );
  await cleanupFixture(rootDir);
  return output;
}

async function readPiCallsAfterFailure(
  callsDir: string | undefined,
): Promise<{ piCalls: EvalPiCall[]; error?: string }> {
  try {
    return { piCalls: await readPiCalls(callsDir) };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { piCalls: [], error: `failed to read Pi call logs: ${detail}` };
  }
}

async function prepareFixture(
  rootDir: string,
  testCase: PiprEvalCase,
): Promise<{ baseSha: string; headSha: string }> {
  run("git", ["init", "--quiet"], rootDir);
  run("git", ["config", "user.email", "pipr-evals@example.invalid"], rootDir);
  run("git", ["config", "user.name", "Pipr Evals"], rootDir);
  await writeFiles(rootDir, { ".pipr/config.ts": configTs(), ...testCase.baseFiles });
  run("git", ["add", "."], rootDir);
  run("git", ["commit", "--quiet", "-m", "base"], rootDir);
  const baseSha = run("git", ["rev-parse", "HEAD"], rootDir).trim();

  await writeFiles(rootDir, testCase.headFiles);
  await removeFiles(rootDir, testCase.deletedFiles ?? []);
  run("git", ["add", "-A"], rootDir);
  run("git", ["commit", "--quiet", "-m", "head"], rootDir);
  const headSha = run("git", ["rev-parse", "HEAD"], rootDir).trim();
  return { baseSha, headSha };
}

async function removeFiles(rootDir: string, files: string[]): Promise<void> {
  for (const relativePath of files) {
    await rm(path.join(rootDir, relativePath), { recursive: true, force: true });
  }
}

async function writeFiles(rootDir: string, files: Record<string, string>): Promise<void> {
  for (const [relativePath, contents] of Object.entries(files)) {
    const absolutePath = path.join(rootDir, relativePath);
    await mkdir(path.dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, contents);
  }
}

function configTs(): string {
  return `import { definePipr } from "@usepipr/sdk";

export default definePipr((pipr) => {
  const model = pipr.model({
    provider: "deepseek",
    model: "deepseek-v4-pro",
    apiKey: pipr.secret({ name: "DEEPSEEK_API_KEY" }),
    options: { thinking: "high" },
  });

  pipr.config({ publication: { maxInlineComments: 3 } });

  pipr.review({
    id: "prompt-eval-review",
    model,
    paths: { include: ["src/**"] },
    instructions: \`
      Review the pull request diff for correctness, security, and test coverage.
      Return only actionable findings that target valid diff ranges.
    \`,
    timeout: "2m",
  });
});
`;
}

async function readPiCalls(callsDir: string | undefined): Promise<EvalPiCall[]> {
  if (!callsDir) {
    return [];
  }
  const files = await readdir(callsDir).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  });
  if (!files) {
    return [];
  }
  return await Promise.all(
    files
      .filter((file) => file.endsWith(".json"))
      .sort()
      .map(async (file) =>
        evalPiCallSchema.parse(JSON.parse(await readFile(path.join(callsDir, file), "utf8"))),
      ),
  );
}

async function cleanupFixture(rootDir: string): Promise<void> {
  if (keepFixtures()) {
    return;
  }
  await rm(rootDir, { recursive: true, force: true });
}

function keepFixtures(): boolean {
  return process.env.PIPR_EVAL_KEEP_FIXTURES === "1";
}

function run(command: string, args: string[], cwd: string): string {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "buffer",
    env: evalSubprocessEnv(),
  });
  if (result.status !== 0) {
    const stderr = textDecoder.decode(result.stderr).trim();
    throw new Error(`${command} ${args.join(" ")} failed with exit ${result.status}: ${stderr}`);
  }
  return textDecoder.decode(result.stdout);
}

function runLocalReview(
  rootDir: string,
  baseSha: string,
  headSha: string,
  options: { mode: PiprEvalRunMode; piExecutable?: string; callsDir?: string },
): LocalReviewEvalJson {
  const helperPath = path.join(sourceDir, "run-local-review.ts");
  const result = spawnSync(
    "bun",
    [
      helperPath,
      JSON.stringify({
        rootDir,
        baseSha,
        headSha,
        piExecutable: options.piExecutable,
        callsDir: options.callsDir,
      }),
    ],
    {
      cwd: rootDir,
      encoding: "buffer",
      env: evalReviewEnv({ mode: options.mode }),
    },
  );
  if (result.status !== 0) {
    const stderr = textDecoder.decode(result.stderr).trim();
    throw new Error(`bun ${helperPath} failed with exit ${result.status}: ${stderr}`);
  }
  const output = textDecoder.decode(result.stdout);
  return localReviewEvalJsonSchema.parse(JSON.parse(output));
}

function assertRunOptions(options: PiprEvalRunOptions): void {
  if (options.mode === "deterministic") {
    if (!options.piExecutable) {
      throw new Error("deterministic prompt evals require a fake Pi executable");
    }
    return;
  }
  if (options.piExecutable || process.env.PIPR_EVAL_PI_EXECUTABLE) {
    throw new Error("live prompt evals must not set Pi executable overrides");
  }
  if (!process.env.DEEPSEEK_API_KEY) {
    throw new Error("DEEPSEEK_API_KEY is required for live prompt evals");
  }
}

type LocalReviewEvalJson = z.infer<typeof localReviewEvalJsonSchema>;
