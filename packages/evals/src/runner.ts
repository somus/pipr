import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as z from "zod";
import type { PiprEvalCase } from "./cases.js";
import { evalReviewEnv, evalSubprocessEnv } from "./env.js";

type PiprEvalRunMode = "live" | "deterministic";

/** Module whose default export receives `config` and returns replacement model providers. */
type PiprEvalProviderModule = { path: string; config?: string };

type PiprEvalRunOptions = {
  mode: PiprEvalRunMode;
  /** Deterministic runs default to the packaged prompt eval provider; live runs must not set this. */
  providerModule?: PiprEvalProviderModule;
  reviewInstructions?: string;
};

const piprEvalModel = {
  provider: "deepseek",
  model: "deepseek-v4-pro",
} as const;

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
  customReviewSchema: z.boolean().optional(),
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
  body: z.string(),
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
  /** Whether raw (pre-sanitization) output contained an expected forbidden substring. */
  forbiddenOutputLeaked: boolean;
};

type RawEvalText = Pick<
  PiprEvalOutput,
  "droppedFindings" | "error" | "inlineFindings" | "mainComment" | "reviewSummary"
>;

const sourceDir = path.dirname(fileURLToPath(import.meta.url));
const packagedProviderModule = fileURLToPath(new URL("./scripted-provider.ts", import.meta.url));
const defaultReviewInstructions = [
  "Review the pull request diff for correctness, security, and test coverage.",
  "Return only actionable findings that target valid diff ranges.",
].join("\n");
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
  assertRunOptions(options);
  const env = evalReviewEnv({ mode: options.mode });
  const { baseSha, headSha } = await prepareFixture(rootDir, testCase, options.reviewInstructions);
  const runOptions = await evalRunOptions(rootDir, callsDir, options);
  const result = runLocalReview(rootDir, baseSha, headSha, env, runOptions.providerModule);
  const output = await successfulEvalOutput(
    rootDir,
    callsDir,
    result,
    testCase.expected.forbiddenOutputSubstrings ?? [],
  );
  await cleanupFixture(rootDir);
  return output;
}

async function evalRunOptions(
  rootDir: string,
  callsDir: string | undefined,
  options: PiprEvalRunOptions,
): Promise<PiprEvalRunOptions> {
  if (options.mode === "live" || options.providerModule) {
    return options;
  }
  const config = path.join(rootDir, ".pipr-eval-provider.json");
  await writeFile(
    config,
    JSON.stringify({
      provider: piprEvalModel.provider,
      models: [piprEvalModel.model],
      ...(callsDir ? { callsDir } : {}),
    }),
  );
  return { ...options, providerModule: { path: packagedProviderModule, config } };
}

async function successfulEvalOutput(
  rootDir: string,
  callsDir: string | undefined,
  result: LocalReviewEvalJson,
  forbiddenOutputSubstrings: string[],
): Promise<PiprEvalOutput> {
  return {
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
      body: sanitizeEvalText(finding.body, forbiddenOutputSubstrings),
      reason: sanitizeEvalText(finding.reason, forbiddenOutputSubstrings),
    })),
    diffRanges: result.diffRanges.map((range) => ({
      ...range,
      preview: range.preview
        ? sanitizeEvalText(range.preview, forbiddenOutputSubstrings)
        : undefined,
    })),
    piCalls: await readPiCalls(callsDir),
    forbiddenOutputLeaked: forbiddenOutputLeaked(
      {
        reviewSummary: result.reviewSummary,
        mainComment: result.mainComment,
        inlineFindings: result.validated.validFindings,
        droppedFindings: result.validated.droppedFindings,
      },
      forbiddenOutputSubstrings,
    ),
  };
}

function forbiddenOutputLeaked(raw: RawEvalText, forbidden: string[]): boolean {
  if (forbidden.length === 0) {
    return false;
  }
  const text = [
    raw.reviewSummary ?? "",
    raw.mainComment ?? "",
    raw.error ?? "",
    ...raw.inlineFindings.flatMap((finding) => [
      finding.body,
      finding.path,
      finding.rangeId,
      finding.suggestedFix ?? "",
    ]),
    ...raw.droppedFindings.flatMap((finding) => [
      finding.body,
      finding.reason,
      finding.path,
      finding.rangeId,
    ]),
  ]
    .join("\n")
    .toLowerCase();
  return forbidden.some((value) => text.includes(value.toLowerCase()));
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
  const output: PiprEvalOutput = {
    ok: false,
    fixturePath: keepFixtures() ? rootDir : undefined,
    error: sanitizeEvalText(rawError, forbiddenOutputSubstrings),
    inlineFindings: [],
    publicationInlineFindings: [],
    droppedFindings: [],
    diffRanges: [],
    piCalls: piCallsResult.piCalls,
    forbiddenOutputLeaked: forbiddenOutputLeaked(
      { error: rawError, inlineFindings: [], droppedFindings: [] },
      forbiddenOutputSubstrings,
    ),
  };
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
  reviewInstructions: string | undefined,
): Promise<{ baseSha: string; headSha: string }> {
  run("git", ["init", "--quiet"], rootDir);
  run("git", ["config", "user.email", "pipr-evals@example.invalid"], rootDir);
  run("git", ["config", "user.name", "Pipr Evals"], rootDir);
  await writeFiles(rootDir, {
    ".pipr/config.ts": configTs(testCase.reviewer, reviewInstructions),
    ...testCase.baseFiles,
  });
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

function configTs(
  reviewer: PiprEvalCase["reviewer"],
  reviewInstructions = defaultReviewInstructions,
): string {
  if (reviewer === "custom") {
    return customReviewConfigTs(reviewInstructions);
  }
  return `import { definePipr } from "@usepipr/sdk";

export default definePipr((pipr) => {
  const model = pipr.model(${JSON.stringify(`${piprEvalModel.provider}/${piprEvalModel.model}`)}, {
    thinking: "high",
  });

  pipr.config({ publication: { maxInlineComments: 3 } });

  pipr.review({
    id: "prompt-eval-review",
    model,
    paths: { include: ["src/**"] },
    instructions: ${JSON.stringify(reviewInstructions)},
    summary: { instructions: "Summarize changed behavior and risk using the merged findings." },
    timeout: "2m",
  });
});
`;
}

function customReviewConfigTs(reviewInstructions: string): string {
  return `import { definePipr, z } from "@usepipr/sdk";

export default definePipr((pipr) => {
  const model = pipr.model(${JSON.stringify(`${piprEvalModel.provider}/${piprEvalModel.model}`)}, {
    thinking: "high",
  });

  pipr.config({ publication: { maxInlineComments: 3 } });

  const finding = pipr.finding({
    title: z.string(),
    severity: z.enum(["high", "medium", "low"]),
    category: z.enum(["correctness", "security", "test-coverage"]),
    rationale: z.string(),
  });

  const reviewer = pipr.agent({
    name: "prompt-eval-reviewer",
    model,
    instructions: ${JSON.stringify(reviewInstructions)},
    output: pipr.schema({
      id: "eval/categorized-review",
      schema: z.strictObject({ summary: z.string(), findings: z.array(finding) }),
    }),
    tools: pipr.tools.readOnly,
    timeout: "2m",
    prompt: () => "Review this change with category metadata.",
  });

  pipr.task({
    name: "prompt-eval-review",
    on: { changeRequest: ["opened", "updated"] },
    async run(ctx) {
      const diff = await ctx.change.diff({
        compressed: true,
        paths: { include: ["src/**"] },
      });
      const result = await ctx.pi.run(reviewer, { diff });
      const { findings } = ctx.review.select(result.findings, { finding });
      await ctx.comment({ main: result.summary, inlineFindings: findings });
    },
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
  env: NodeJS.ProcessEnv,
  providerModule: PiprEvalProviderModule | undefined,
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
        providerModule,
      }),
    ],
    {
      cwd: rootDir,
      encoding: "buffer",
      env,
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
    return;
  }
  if (options.providerModule) {
    throw new Error("live prompt evals must not set a provider module override");
  }
}

type LocalReviewEvalJson = z.infer<typeof localReviewEvalJsonSchema>;
