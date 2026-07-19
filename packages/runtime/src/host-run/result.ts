import { type PiprResult, parsePiprResult } from "@usepipr/sdk";
import { mainCommentFooterHiddenMarker } from "../review/comment-branding.js";
import { parseGeneratedMainCommentEnvelope } from "../review/main-comment-envelope.js";
import type { PublicationError } from "../review/publication-result.js";
import type { HostRunCommandResult, LocalReviewCommandResult } from "./types.js";

const genericFailureMessage = "Pipr failed; see logs for details.";
const publicationFailureMessage = "Pipr could not complete publication; see logs for details.";

type PublicationErrorResult = {
  kind: "publication-error";
  publication: PublicationError["result"];
};

export type PiprResultConversionInput =
  | { source: "host"; result: HostRunCommandResult | PublicationErrorResult }
  | { source: "local"; result: LocalReviewCommandResult };

export function toPiprResult(input: PiprResultConversionInput): PiprResult {
  return parsePiprResult(
    input.source === "local" ? localPiprResult(input.result) : hostPiprResult(input.result),
  );
}

export function toPiprErrorResult(_error: unknown): PiprResult {
  return parsePiprResult({
    formatVersion: 2,
    kind: "error",
    message: genericFailureMessage,
  });
}

function localPiprResult(result: LocalReviewCommandResult): unknown {
  if (result.kind === "skipped") {
    return {
      formatVersion: 2,
      kind: "skipped",
      reason: result.skipReason,
    };
  }
  return reviewPiprResult(result, { state: "disabled" });
}

function hostPiprResult(result: HostRunCommandResult | PublicationErrorResult): unknown {
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
        run: result.run,
        mainComment: result.response.body,
        publication: { state: "completed", action: result.publication.action },
      };
    case "verifier":
      return {
        formatVersion: 2,
        kind: "verifier",
        run: result.run,
        publication: {
          state: "completed",
          inlineResolutionErrorCount: result.errors.length,
        },
      };
    case "review":
      return reviewPiprResult(result.review, {
        state: "completed",
        mainComment: { action: result.publication.mainComment.action },
        inlineComments: result.publication.inlineComments,
        inlinePublicationErrorCount: result.publication.metadata.inlinePublicationErrors.length,
        inlineResolutionErrorCount: result.publication.metadata.inlineResolutionErrors.length,
      });
    case "publication-error":
      return publicationErrorPiprResult(result.publication);
    default:
      result satisfies never;
      throw new Error("Unsupported Pipr host result");
  }
}

function reviewPiprResult(
  result: Extract<LocalReviewCommandResult, { kind: "review" }>,
  publication:
    | { state: "disabled" }
    | {
        state: "completed";
        mainComment: { action: "created" | "updated" };
        inlineComments: { posted: number; skipped: number; failed: number };
        inlinePublicationErrorCount: number;
        inlineResolutionErrorCount: number;
      },
): unknown {
  return {
    formatVersion: 2,
    kind: "review",
    run: result.run,
    mainComment: stripPiprMainCommentMarkers(result.mainComment),
    inlineFindings: result.inlineCommentDrafts.map((draft) => draft.finding),
    droppedFindings: result.validated.droppedFindings,
    taskChecks: result.taskChecks,
    repairAttempted: result.repairAttempted,
    publication,
  };
}

function publicationErrorPiprResult(publication: PublicationError["result"]): unknown {
  if (!publication) {
    return {
      formatVersion: 2,
      kind: "publication-error",
      message: publicationFailureMessage,
    };
  }
  return {
    formatVersion: 2,
    kind: "publication-error",
    message: publicationFailureMessage,
    publication: {
      inlineComments: publication.inlineComments,
      inlinePublicationErrorCount: publication.metadata.inlinePublicationErrors.length,
      inlineResolutionErrorCount: publication.metadata.inlineResolutionErrors.length,
    },
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
