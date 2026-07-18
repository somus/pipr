import {
  mainCommentAttributionPattern,
  mainCommentFooterHiddenMarker,
  mainCommentHeaderHiddenMarker,
  reviewStatsEndMarker,
  reviewStatsHiddenMarker,
  reviewStatsStartMarker,
} from "./comment-branding.js";

const generatedReviewStatsShape = [
  /^$/,
  /^\| Metric \| Total \|$/,
  /^\| --- \| ---: \|$/,
  /^\| Models \| .+ \|$/,
  /^\| Agent runs \| \d+ \|$/,
  /^\| Elapsed \| .+ \|$/,
  /^\| Input tokens \| (?:Unavailable|[\d,]+(?: \(reported\))?) \|$/,
  /^\| Output tokens \| (?:Unavailable|[\d,]+(?: \(reported\))?) \|$/,
  /^\| Cost \(USD\) \| (?:Unavailable|\$\d+(?:\.\d+)?(?:e[+-]?\d+)?(?: \(reported\))?) \|$/,
  /^$/,
  /^<\/details>$/,
  /^<!-- pipr:stats:end -->$/,
];

export type GeneratedMainCommentEnvelope = {
  mainMarkerIndex: number;
  headerMarkerIndex: number;
  statsMarkerIndex: number;
  statsRange: { start: number; end: number } | undefined;
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
    footerIndex,
  };
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
  if (
    start < 0 ||
    lines[start + 1] !== "<details>" ||
    lines[start + 2] !== "<summary>Review stats</summary>" ||
    !matchesGeneratedReviewStatsShape(lines, start, end)
  ) {
    return undefined;
  }
  return { start, end };
}

function matchesGeneratedReviewStatsShape(lines: string[], start: number, end: number): boolean {
  const generatedShape = lines.slice(start + 3, end + 1);
  return (
    generatedShape.length === generatedReviewStatsShape.length &&
    generatedReviewStatsShape.every((pattern, index) => pattern.test(generatedShape[index] ?? ""))
  );
}
