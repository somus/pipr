import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { PiprEvalCase } from "./cases.js";

export type PiprEvalRunMode = "live" | "deterministic";

type PiprEvalRunOptions = {
  mode: PiprEvalRunMode;
  piExecutable?: string;
};

export type EvalInlineFinding = {
  body: string;
  path: string;
  rangeId: string;
  side: "RIGHT" | "LEFT";
  startLine: number;
  endLine: number;
  suggestedFix?: string;
};

export type EvalDiffRange = {
  path: string;
  rangeId: string;
  side: "RIGHT" | "LEFT";
  startLine: number;
  endLine: number;
  preview?: string;
};

export type EvalPiCall = {
  reviewPolicy: boolean;
  schemaOnlySystemPrompt: boolean;
  strictJsonSystemPrompt: boolean;
  secretHygieneSystemPrompt: boolean;
  systemPromptHasReviewPolicy: boolean;
  untrustedDataSystemPrompt: boolean;
  promptBytes: number;
};

export type EvalDroppedFinding = {
  reason: string;
  path: string;
  rangeId: string;
  side: "RIGHT" | "LEFT";
  startLine: number;
  endLine: number;
};

export type PiprEvalOutput = {
  ok: boolean;
  kind?: "review" | "skipped";
  fixturePath?: string;
  error?: string;
  mainComment?: string;
  inlineFindings: EvalInlineFinding[];
  droppedFindings: EvalDroppedFinding[];
  diffRanges: EvalDiffRange[];
  piCalls: EvalPiCall[];
};

const sourceDir = path.dirname(fileURLToPath(import.meta.url));
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
    return await failedEvalOutput(rootDir, callsDir, error);
  }
}

async function runPreparedFixture(
  rootDir: string,
  callsDir: string | undefined,
  testCase: PiprEvalCase,
  options: PiprEvalRunOptions,
): Promise<PiprEvalOutput> {
  assertRunOptions(options);
  const { baseSha, headSha } = await prepareFixture(rootDir, testCase);
  const result = runLocalReview(rootDir, baseSha, headSha, {
    callsDir,
    piExecutable: options.piExecutable ?? process.env.PIPR_EVAL_PI_EXECUTABLE,
  });
  const output = {
    ok: true,
    kind: result.kind,
    fixturePath: keepFixtures() ? rootDir : undefined,
    mainComment: result.mainComment,
    inlineFindings: result.inlineFindings.map((draft) => draft.finding),
    droppedFindings: result.validated.droppedFindings,
    diffRanges: result.diffRanges,
    piCalls: await readPiCalls(callsDir),
  } satisfies PiprEvalOutput;
  await cleanupFixture(rootDir);
  return output;
}

async function failedEvalOutput(
  rootDir: string,
  callsDir: string | undefined,
  error: unknown,
): Promise<PiprEvalOutput> {
  const output = {
    ok: false,
    fixturePath: keepFixtures() ? rootDir : undefined,
    error: error instanceof Error ? error.message : String(error),
    inlineFindings: [],
    droppedFindings: [],
    diffRanges: [],
    piCalls: await readPiCalls(callsDir),
  } satisfies PiprEvalOutput;
  await cleanupFixture(rootDir);
  return output;
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
  try {
    const files = await readdir(callsDir);
    return await Promise.all(
      files
        .filter((file) => file.endsWith(".json"))
        .sort()
        .map(
          async (file) =>
            JSON.parse(await readFile(path.join(callsDir, file), "utf8")) as EvalPiCall,
        ),
    );
  } catch {
    return [];
  }
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
    env: process.env,
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
  options: { piExecutable?: string; callsDir?: string },
): LocalReviewEvalJson {
  const helperPath = path.join(sourceDir, "run-local-review.ts");
  const output = run(
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
    rootDir,
  );
  return JSON.parse(output) as LocalReviewEvalJson;
}

function assertRunOptions(options: PiprEvalRunOptions): void {
  if (options.mode === "deterministic") {
    if (!options.piExecutable) {
      throw new Error("deterministic prompt evals require a fake Pi executable");
    }
    return;
  }
  if (!process.env.DEEPSEEK_API_KEY) {
    throw new Error("DEEPSEEK_API_KEY is required for live prompt evals");
  }
}

type LocalReviewEvalJson = {
  kind: "review" | "skipped";
  mainComment: string;
  inlineFindings: Array<{ finding: EvalInlineFinding }>;
  validated: {
    droppedFindings: EvalDroppedFinding[];
  };
  diffRanges: EvalDiffRange[];
};
