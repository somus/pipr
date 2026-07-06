#!/usr/bin/env bun

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

const result = await runLocalReviewCommand({
  rootDir: input.rootDir,
  configDir: ".pipr",
  baseSha: input.baseSha,
  headSha: input.headSha,
  piExecutable: input.piExecutable,
  env: input.callsDir ? deterministicEnv(input.callsDir) : process.env,
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

function deterministicEnv(callsDir: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    DEEPSEEK_API_KEY: callsDir,
    PIPR_EVAL_PI_CALLS_DIR: callsDir,
  };
}
