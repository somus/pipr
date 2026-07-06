#!/usr/bin/env bun

import { chmod, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { runLocalReviewCommand } from "@usepipr/runtime";

type HelperInput = {
  rootDir: string;
  baseSha: string;
  headSha: string;
  piExecutable?: string;
  callsDir?: string;
};

const input = readInput(process.argv[2]);

if (!input.rootDir || !input.baseSha || !input.headSha) {
  throw new Error("usage: run-local-review.ts <json options>");
}

const piExecutable = await evalPiExecutable(input);
const result = await runLocalReviewCommand({
  rootDir: input.rootDir,
  configDir: ".pipr",
  baseSha: input.baseSha,
  headSha: input.headSha,
  piExecutable,
  env: input.callsDir ? deterministicEnv() : process.env,
});

console.log(
  JSON.stringify({
    kind: result.kind,
    mainComment: result.mainComment,
    inlineFindings: result.inlineCommentDrafts,
    validated: {
      droppedFindings: result.validated.droppedFindings.map(({ reason, finding }) => ({
        reason,
        path: finding.path,
        rangeId: finding.rangeId,
        side: finding.side,
        startLine: finding.startLine,
        endLine: finding.endLine,
      })),
    },
    diffRanges: result.diffManifest.files.flatMap((file) =>
      file.commentableRanges.map((range) => ({
        path: range.path,
        rangeId: range.id,
        side: range.side,
        startLine: range.startLine,
        endLine: range.endLine,
        preview: range.preview,
      })),
    ),
  }),
);

function readInput(value: string | undefined): HelperInput {
  if (!value) {
    throw new Error("usage: run-local-review.ts <json options>");
  }
  return JSON.parse(value) as HelperInput;
}

async function evalPiExecutable(input: HelperInput): Promise<string | undefined> {
  if (!input.callsDir || !input.piExecutable) {
    return input.piExecutable;
  }
  const wrapperDir = path.join(input.rootDir, ".pipr", ".eval");
  await mkdir(wrapperDir, { recursive: true });
  const wrapperPath = path.join(wrapperDir, "fake-pi-wrapper");
  await writeFile(
    wrapperPath,
    `#!/usr/bin/env bun
Bun.env.PIPR_EVAL_PI_CALLS_DIR = ${JSON.stringify(input.callsDir)};
const proc = Bun.spawn([${JSON.stringify(input.piExecutable)}, ...Bun.argv.slice(2)], {
  stdin: "inherit",
  stdout: "inherit",
  stderr: "inherit",
  env: Bun.env,
});
process.exit(await proc.exited);
`,
  );
  await chmod(wrapperPath, 0o700);
  return wrapperPath;
}

function deterministicEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    DEEPSEEK_API_KEY: "pipr-eval-dummy-key",
  };
}
