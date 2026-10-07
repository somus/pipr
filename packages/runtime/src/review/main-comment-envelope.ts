import {
  mainCommentAttributionPattern,
  mainCommentFooterHiddenMarker,
  mainCommentHeaderHiddenMarker,
  reviewResultEndMarker,
  reviewResultStartMarker,
  reviewStatsEndMarker,
  reviewStatsHiddenMarker,
  reviewStatsStartMarker,
} from "./comment-branding.js";
import { reviewProgressRange } from "./progress.js";

/** A rendered stats table row: a metric label and its value, as produced by `renderReviewStatsTable`. */
const generatedReviewStatsRow = /^\| [^|]+ \| .+ \|$/;

export type GeneratedMainCommentEnvelope = {
  mainMarkerIndex: number;
  headerMarkerIndex: number;
  statsMarkerIndex: number;
  statsRange: { start: number; end: number } | undefined;
  progressRange: { start: number; end: number } | undefined;
  resultRange: { start: number; end: number } | undefined;
  footerIndex: number;
};

export function parseGeneratedMainCommentEnvelope(lines: string[]): GeneratedMainCommentEnvelope {
  const mainMarkerIndex = lines.findIndex((line) => line.startsWith("<!-- pipr:main-comment "));
  const headerCandidateOffset = lines.slice(mainMarkerIndex + 1).findIndex((line) => line !== "");
  const headerCandidateIndex = mainMarkerIndex + 1 + headerCandidateOffset;
  const headerMarkerIndex =
    mainMarkerIndex >= 0 &&
    headerCandidateOffset >= 0 &&
    lines[headerCandidateIndex] === mainCommentHeaderHiddenMarker
      ? headerCandidateIndex
      : -1;
  const lastLineIndex = lines.findLastIndex((line) => line !== "");
  const lastLine = lines[lastLineIndex] ?? "";
  const footerIndex =
    lastLine === mainCommentFooterHiddenMarker || mainCommentAttributionPattern.test(lastLine)
      ? lastLineIndex
      : -1;
  const lastContentIndex = lines
    .slice(0, footerIndex < 0 ? lines.length : footerIndex)
    .findLastIndex((line) => line !== "");
  const statsMarkerIndex =
    lines[lastContentIndex] === reviewStatsHiddenMarker ? lastContentIndex : -1;

  return {
    mainMarkerIndex,
    headerMarkerIndex,
    statsMarkerIndex,
    statsRange: generatedReviewStatsRange(lines, footerIndex),
    progressRange: reviewProgressRange(lines),
    resultRange: generatedReviewResultRange(lines),
    footerIndex,
  };
}

function generatedReviewResultRange(lines: string[]): { start: number; end: number } | undefined {
  const start = lines.indexOf(reviewResultStartMarker);
  if (
    start < 0 ||
    lines[start + 2] !== reviewResultEndMarker ||
    !/^> (?:✅ \*\*No actionable findings:\*\*|⚠️ \*\*Needs attention:\*\*) .+$/.test(
      lines[start + 1] ?? "",
    )
  ) {
    return undefined;
  }
  return { start, end: start + 2 };
}

function generatedReviewStatsRange(
  lines: string[],
  generatedFooterIndex: number,
): { start: number; end: number } | undefined {
  const end = lines
    .slice(0, generatedFooterIndex < 0 ? lines.length : generatedFooterIndex)
    .findLastIndex((line) => line !== "");
  if (end < 0 || lines[end] !== reviewStatsEndMarker || lines[end - 1] !== "</details>") {
    return undefined;
  }
  const start = lines.lastIndexOf(reviewStatsStartMarker, end - 2);
  if (!isGeneratedReviewStatsEnvelope(lines, start, end)) {
    return undefined;
  }
  return { start, end };
}

function isGeneratedReviewStatsEnvelope(lines: string[], start: number, end: number): boolean {
  return (
    start >= 0 &&
    lines[start + 1] === "<details>" &&
    /^<summary>(?:Review stats|(?:📊 )?(?:Review completed in .+|\d+ workflow runs completed: .+ combined))<\/summary>$/.test(
      lines[start + 2] ?? "",
    ) &&
    matchesGeneratedReviewStatsShape(lines, start, end)
  );
}

/** Blank line, metric table with at least one row, blank line, `</details>`, end marker. */
function matchesGeneratedReviewStatsShape(lines: string[], start: number, end: number): boolean {
  const body = lines.slice(start + 3, end + 1);
  const rows = body.slice(3, -3);
  return (
    body[0] === "" &&
    body[1] === "| Metric | Total |" &&
    body[2] === "| --- | ---: |" &&
    rows.length > 0 &&
    rows.every((row) => generatedReviewStatsRow.test(row)) &&
    body.at(-3) === "" &&
    body.at(-2) === "</details>" &&
    body.at(-1) === reviewStatsEndMarker
  );
}
