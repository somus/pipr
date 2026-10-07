import type { PriorReviewState, PublicationMetadata, ReviewStats } from "../publication/types.js";
import { compareStableSemver, stableSemverPattern } from "../shared/semver.js";
import type { ChangeRequestEventContext, ReviewFinding } from "../types.js";
import {
  mainCommentFooterHiddenMarker,
  mainCommentHeaderHiddenMarker,
  mainCommentTitle,
  piprRepositoryUrl,
  reviewResultEndMarker,
  reviewResultStartMarker,
  reviewStatsEndMarker,
  reviewStatsHiddenMarker,
  reviewStatsStartMarker,
} from "./comment-branding.js";
import {
  mainCommentMarker,
  renderInlineFindingMarker,
  renderMainCommentMarker,
} from "./prior-state.js";

export function renderMainComment(options: {
  event: Pick<ChangeRequestEventContext, "change">;
  reviewState: PriorReviewState;
  maxStoredFindings?: number;
  main: string;
  metadata: PublicationMetadata;
  showHeader: boolean;
  showFooter: boolean;
  showStats: boolean;
}): string {
  return [
    renderMainCommentMarker({
      marker: mainCommentMarker,
      changeNumber: options.event.change.number,
      reviewState: options.reviewState,
      maxStoredFindings: options.maxStoredFindings,
    }),
    "",
    ...(!options.showHeader ? [mainCommentHeaderHiddenMarker, ""] : []),
    ...(options.showHeader ? [mainCommentTitle, ""] : []),
    reviewResultStartMarker,
    renderReviewResult(options.metadata.validFindings),
    reviewResultEndMarker,
    "",
    options.main,
    "",
    ...(!options.showStats || !options.metadata.stats ? [reviewStatsHiddenMarker, ""] : []),
    ...(options.showStats && options.metadata.stats
      ? [
          renderReviewStats(
            options.metadata.stats,
            reviewWorkflowUrls(options.reviewState, options.metadata.workflowUrl),
          ),
          "",
        ]
      : []),
    ...(options.showFooter
      ? [renderMainCommentAttribution(options.metadata), ""]
      : [mainCommentFooterHiddenMarker, ""]),
  ].join("\n");
}

function reviewWorkflowUrls(
  reviewState: PriorReviewState,
  currentWorkflowUrl: string | undefined,
): string[] | undefined {
  if (reviewState.workflowUrls) {
    return reviewState.workflowUrls;
  }
  return currentWorkflowUrl ? [currentWorkflowUrl] : undefined;
}

function renderReviewResult(validFindings: number): string {
  if (validFindings === 0) {
    return "> ✅ **No actionable findings:** The review completed without actionable findings.";
  }
  const findingLabel = validFindings === 1 ? "finding was" : "findings were";
  return `> ⚠️ **Needs attention:** ${validFindings} actionable ${findingLabel} identified.`;
}

function renderReviewStats(stats: ReviewStats, workflowUrls?: string[]): string {
  const workflowRunCount = workflowUrls?.length ?? 0;
  const summary =
    workflowRunCount > 1
      ? `${workflowRunCount} workflow runs completed: ${formatReviewDuration(stats.durationMs)} combined`
      : `Review completed in ${formatReviewDuration(stats.durationMs)}`;
  return [
    reviewStatsStartMarker,
    "<details>",
    `<summary>📊 ${summary}</summary>`,
    "",
    ...renderReviewStatsTable(stats, workflowUrls),
    "",
    "</details>",
    reviewStatsEndMarker,
  ].join("\n");
}

export function renderReviewStatsTable(stats: ReviewStats, workflowUrls?: string[]): string[] {
  const durationLabel = workflowUrls && workflowUrls.length > 1 ? "Combined runtime" : "Elapsed";
  return [
    "| Metric | Total |",
    "| --- | ---: |",
    `| Models | ${stats.models.map(formatModel).join(", ")} |`,
    `| Agent runs | ${stats.agentRuns} |`,
    `| ${durationLabel} | ${formatReviewDuration(stats.durationMs)} |`,
    ...renderTokenUsageRows(stats),
    ...renderCacheUsageRows(stats),
    ...renderDiffContextCoverageRows(stats),
    renderCostUsageRow(stats),
    ...renderWorkflowRows(workflowUrls),
  ];
}

function renderTokenUsageRows(stats: ReviewStats): string[] {
  const suffix = stats.usageStatus === "partial" ? " (reported)" : "";
  const input = formattedUsageValue(stats.inputTokens, stats.usageStatus, suffix);
  const output = formattedUsageValue(stats.outputTokens, stats.usageStatus, suffix);
  return [`| Input tokens | ${input} |`, `| Output tokens | ${output} |`];
}

function renderCacheUsageRows(stats: ReviewStats): string[] {
  if (!stats.cacheUsageStatus) return [];
  const suffix = stats.cacheUsageStatus === "partial" ? " (reported)" : "";
  return [
    `| Cache read tokens | ${formattedUsageValue(stats.cacheReadTokens ?? 0, stats.cacheUsageStatus, suffix)} |`,
    `| Cache write tokens | ${formattedUsageValue(stats.cacheWriteTokens ?? 0, stats.cacheUsageStatus, suffix)} |`,
  ];
}

function formattedUsageValue(
  value: number,
  status: "complete" | "partial" | "unavailable",
  suffix: string,
): string {
  return status === "unavailable" ? "Unavailable" : `${formatInteger(value)}${suffix}`;
}

function renderDiffContextCoverageRows(stats: ReviewStats): string[] {
  const coverage = stats.diffContextCoverage;
  if (!coverage) return [];
  return [
    `| Current-run files with full context | ${formatInteger(coverage.files.covered)} / ${formatInteger(coverage.files.total)} |`,
    `| Current-run ranges with full context | ${formatInteger(coverage.ranges.covered)} / ${formatInteger(coverage.ranges.total)} |`,
  ];
}

function renderCostUsageRow(stats: ReviewStats): string {
  if (stats.usageStatus === "unavailable") return "| Cost (USD) | Unavailable |";
  const suffix = stats.usageStatus === "partial" ? " (reported)" : "";
  return `| Cost (USD) | ${formatCost(stats.costUsd)}${suffix} |`;
}

function renderWorkflowRows(workflowUrls: string[] | undefined): string[] {
  if (!workflowUrls?.length) return [];
  const links = workflowUrls
    .map((workflowUrl, index) => `[Run ${index + 1}](<${workflowUrl}>)`)
    .join(", ");
  return [`| Workflow runs | ${links} |`];
}

function formatModel(model: string): string {
  const escaped = model
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\|/g, "&#124;");
  return `<code>${escaped}</code>`;
}

function formatInteger(value: number): string {
  return value.toLocaleString("en-US");
}

export function formatReviewDuration(durationMs: number): string {
  if (durationMs < 1_000) {
    return `${durationMs}ms`;
  }
  const totalSeconds = durationMs / 1_000;
  if (totalSeconds < 60) {
    return `${formatTenths(totalSeconds)}s`;
  }
  const minutes = Math.floor(totalSeconds / 60);
  return `${minutes}m ${formatTenths(totalSeconds - minutes * 60)}s`;
}

function formatTenths(value: number): string {
  return value.toFixed(1).replace(/\.0$/, "");
}

function formatCost(costUsd: number): string {
  if (costUsd === 0) {
    return "$0.00";
  }
  if (costUsd < 0.0001) {
    return `$${costUsd.toFixed(6)}`;
  }
  if (costUsd < 0.01) {
    return `$${costUsd.toFixed(4)}`;
  }
  return `$${costUsd.toFixed(2)}`;
}

function renderMainCommentAttribution(metadata: PublicationMetadata): string {
  const configNotice = configVersionNotice(metadata);
  return `<sub>Review generated by [Pipr](${piprRepositoryUrl}) for commit \`${metadata.reviewedHeadSha.slice(
    0,
    7,
  )}\`.${configNotice}</sub>`;
}

function configVersionNotice(metadata: PublicationMetadata): string {
  if (
    !metadata.configVersion ||
    !stableSemverPattern.test(metadata.runtimeVersion) ||
    !stableSemverPattern.test(metadata.configVersion) ||
    compareStableSemver(metadata.runtimeVersion, metadata.configVersion) <= 0
  ) {
    return "";
  }
  const releaseUrl = `${piprRepositoryUrl}/releases/tag/v${metadata.runtimeVersion}`;
  return ` Config SDK ${metadata.configVersion} is behind [Pipr ${metadata.runtimeVersion}](${releaseUrl}).`;
}

export function renderInlineBody(
  finding: ReviewFinding,
  findingId: string,
  reviewedHeadSha: string,
): string {
  const findingBody = startsWithStructuredMarkdown(finding.body)
    ? finding.body
    : ["**Issue**", "", finding.body].join("\n");
  return [
    renderInlineFindingMarker(findingId, reviewedHeadSha),
    findingBody,
    finding.suggestedFix
      ? ["**Suggested change**", "", renderSuggestedChange(finding.suggestedFix)].join("\n")
      : "",
  ]
    .filter(Boolean)
    .join("\n");
}

function startsWithStructuredMarkdown(value: string): boolean {
  const body = value.trimStart();
  return (
    /^#{1,6}\s/.test(body) ||
    /^>/.test(body) ||
    /^(\d+[.)]|[-*+])\s/.test(body) ||
    /^\|/.test(body) ||
    /^(```|~~~)/.test(body) ||
    /^<\s*[a-z][\w:-]*(\s|>|\/>)/i.test(body) ||
    /^\*\*[^*\n]+\*\*/.test(body)
  );
}

export function renderSuggestedChange(suggestedFix: string, native = true): string {
  const longestBacktickRun = Math.max(
    0,
    ...[...suggestedFix.matchAll(/`+/g)].map((match) => match[0].length),
  );
  const fence = "`".repeat(Math.max(3, longestBacktickRun + 1));
  const closingPrefix = suggestedFix.endsWith("\n") ? "" : "\n";
  return `${fence}${native ? "suggestion" : ""}\n${suggestedFix}${closingPrefix}${fence}`;
}
