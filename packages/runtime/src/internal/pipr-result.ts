import { type PiprResult, type PiprRunSummary, parsePiprResult } from "@usepipr/sdk";
import type { HostRunCommandResult, LocalReviewCommandResult } from "../host-run/types.js";
import { mainCommentFooterHiddenMarker } from "../review/comment-branding.js";
import { parseGeneratedMainCommentEnvelope } from "../review/main-comment-envelope.js";
import type { PublicationError } from "../review/publication-result.js";

const genericFailureMessage = "Pipr failed; see the Action log for details.";
const publicationFailureMessage =
  "Pipr could not complete publication; see the Action log for details.";

type ResultInput =
  | { source: "host"; result: HostRunCommandResult }
  | { source: "local"; result: LocalReviewCommandResult }
  | {
      source: "host";
      result: { kind: "publication-error"; publication: PublicationError["result"] };
    };

export function toPiprResult(input: ResultInput): PiprResult {
  return parsePiprResult(
    input.source === "local" ? localResult(input.result) : hostResult(input.result),
  );
}

export function toPiprErrorResult(_error: unknown): Extract<PiprResult, { kind: "error" }> {
  const result = parsePiprResult({
    formatVersion: 2,
    kind: "error",
    message: genericFailureMessage,
  });
  if (result.kind !== "error") {
    throw new Error("Pipr error result schema returned an unexpected result kind");
  }
  return result;
}

function localResult(result: LocalReviewCommandResult): PiprResult {
  if (result.kind === "skipped") {
    return { formatVersion: 2, kind: "skipped", reason: result.skipReason };
  }
  return reviewResult(result, { state: "disabled" });
}

function hostResult(
  result:
    | HostRunCommandResult
    | { kind: "publication-error"; publication: PublicationError["result"] },
): PiprResult {
  switch (result.kind) {
    case "ignored":
      return { formatVersion: 2, kind: "ignored", reason: result.reason };
    case "dry-run":
      return { formatVersion: 2, kind: "dry-run" };
    case "command-help":
      return {
        formatVersion: 2,
        kind: "command-help",
        reason: result.reason,
        mainComment: result.body,
      };
    case "command-response":
      return {
        formatVersion: 2,
        kind: "command-response",
        run: publicRunSummary(result.run),
        mainComment: result.response.body,
        publication: { state: "completed", action: result.publication.action },
      };
    case "verifier":
      return {
        formatVersion: 2,
        kind: "verifier",
        run: publicRunSummary(result.run),
        publication: { state: "completed", inlineResolutionErrorCount: result.errors.length },
      };
    case "review":
      return reviewResult(result.review, {
        state: "completed",
        mainComment: { action: result.publication.mainComment.action },
        inlineComments: result.publication.inlineComments,
        inlinePublicationErrorCount: result.publication.metadata.inlinePublicationErrors.length,
        inlineResolutionErrorCount: result.publication.metadata.inlineResolutionErrors.length,
      });
    case "publication-error":
      return publicationErrorResult(result.publication);
  }
}

function reviewResult(
  review: Extract<LocalReviewCommandResult, { kind: "review" }>,
  publication: Extract<PiprResult, { kind: "review" }>["publication"],
): PiprResult {
  return {
    formatVersion: 2,
    kind: "review",
    run: publicRunSummary(review.run),
    mainComment: stripPiprMainCommentMarkers(review.mainComment),
    inlineFindings: review.inlineCommentDrafts.map((draft) => draft.finding),
    droppedFindings: review.validated.droppedFindings,
    taskChecks: review.taskChecks,
    repairAttempted: review.repairAttempted,
    publication,
  };
}

function publicRunSummary(run: PiprRunSummary): PiprRunSummary {
  const bounded = (value: string) => value.slice(0, 200);
  return {
    ...run,
    id: bounded(run.id),
    baseSha: bounded(run.baseSha),
    headSha: bounded(run.headSha),
    tasks: run.tasks.slice(0, 200).map(bounded),
    models: run.models.slice(0, 20).map(bounded),
  };
}

function publicationErrorResult(
  publication: PublicationError["result"],
): Extract<PiprResult, { kind: "publication-error" }> {
  return {
    formatVersion: 2,
    kind: "publication-error",
    message: publicationFailureMessage,
    ...(publication
      ? {
          publication: {
            inlineComments: publication.inlineComments,
            inlinePublicationErrorCount: publication.metadata.inlinePublicationErrors.length,
            inlineResolutionErrorCount: publication.metadata.inlineResolutionErrors.length,
          },
        }
      : {}),
  };
}

export function stripPiprMainCommentMarkers(mainComment: string): string {
  const lines = mainComment.split("\n");
  const envelope = parseGeneratedMainCommentEnvelope(lines);
  const generatedMarkerIndexes = new Set([
    envelope.mainMarkerIndex,
    envelope.headerMarkerIndex,
    envelope.statsMarkerIndex,
    envelope.statsRange?.start ?? -1,
    envelope.statsRange?.end ?? -1,
    lines[envelope.footerIndex] === mainCommentFooterHiddenMarker ? envelope.footerIndex : -1,
  ]);
  const visibleLines = lines.filter((_line, index) => !generatedMarkerIndexes.has(index));
  const firstContentLine = visibleLines.findIndex((line) => line !== "");
  return firstContentLine === -1 ? "" : visibleLines.slice(firstContentLine).join("\n");
}
