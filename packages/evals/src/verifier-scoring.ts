import type { PiprEvalScore } from "./scoring.js";
import type { VerifierEvalExpected } from "./verifier-cases.js";
import type { VerifierEvalOutput } from "./verifier-runner.js";

export function scoreVerifierEvalOutput(
  output: VerifierEvalOutput,
  expected: VerifierEvalExpected,
): PiprEvalScore[] {
  return [
    { name: "Run succeeded", score: output.ok ? 1 : 0 },
    { name: "Prior state status", score: Number(output.priorStatus === expected.priorStatus) },
    {
      name: "Thread action count",
      score: Number(output.threadActionCount === expected.threadActionCount),
    },
    {
      name: "Publication succeeded",
      score: Number(output.publicationErrors.length === 0),
    },
    {
      name: "Published reply body",
      score: scorePublishedReplyBody(output, expected),
    },
    {
      name: "Resolved thread IDs",
      score: scoreResolvedThreadIds(output, expected),
    },
    {
      name: "Pi call expectation",
      score: expected.requirePiCall
        ? Number(output.piCalls.length > 0)
        : Number(output.piCalls.length === 0),
    },
    {
      name: "Verifier prompt policy",
      score: scoreVerifierPromptPolicy(output, expected),
    },
  ];
}

function scorePublishedReplyBody(
  output: VerifierEvalOutput,
  expected: VerifierEvalExpected,
): number {
  const required = expected.replySubstrings ?? [];
  const forbidden = expected.forbiddenReplySubstrings ?? [];
  const body = output.publishedReplies.join("\n");
  if (required.length === 0 && forbidden.length === 0) {
    return Number(output.publishedReplies.length === 0);
  }
  return Number(
    required.every((value) => body.includes(value)) &&
      forbidden.every((value) => !body.includes(value)),
  );
}

function scoreResolvedThreadIds(
  output: VerifierEvalOutput,
  expected: VerifierEvalExpected,
): number {
  const actual = [...output.resolvedThreadIds].sort();
  const expectedIds = [...expected.resolvedThreadIds].sort();
  return Number(
    actual.length === expectedIds.length &&
      actual.every((threadId, index) => threadId === expectedIds[index]),
  );
}

function scoreVerifierPromptPolicy(
  output: VerifierEvalOutput,
  expected: VerifierEvalExpected,
): number {
  if (!expected.requirePiCall) {
    return Number(output.piCalls.length === 0);
  }
  return Number(
    output.piCalls.some((call) =>
      [
        call.userRepliesAreUntrusted,
        call.userReplyIsEvidence,
        call.repositoryToolsDisabled,
        call.siblingCommentExcluded,
      ].every(Boolean),
    ),
  );
}
