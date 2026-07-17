import { z } from "zod";
import { createDiffRangeIndex } from "../diff/ranges.js";
import { compareStableSemver, stableSemverPattern } from "../shared/semver.js";
import type {
  ChangeRequestEventContext,
  CommentableRange,
  DiffManifest,
  ReviewFinding,
} from "../types.js";
import { commentableRangeSchema, reviewSideSchema } from "../types.js";
import {
  mainCommentFooterHiddenMarker,
  mainCommentHeaderHiddenMarker,
  mainCommentTitle,
  piprRepositoryUrl,
  reviewStatsEndMarker,
  reviewStatsHiddenMarker,
  reviewStatsStartMarker,
} from "./comment-branding.js";
import { reviewFindingSchema } from "./contract.js";
import {
  buildPriorReviewState,
  countFindingFingerprints,
  findingIdFor,
  findingIdSchema,
  inlineFindingMarker,
  mainCommentMarker,
  matchFindingRecord,
  matchResolvedFindingRecord,
  type PriorReviewState,
  priorReviewStateSchema,
  renderInlineFindingMarker,
  renderMainCommentMarker,
} from "./prior-state.js";
import { type ReviewStats, reviewStatsSchema } from "./review-stats.js";
import { isPublishableSuggestedFixSelection } from "./suggested-fix-publication-policy.js";

export { runtimeVersion } from "../shared/version.js";

const inlinePublicationItemSchema = z
  .strictObject({
    finding: reviewFindingSchema,
    range: commentableRangeSchema,
    path: z.string().min(1),
    previousPath: z.string().min(1).optional(),
    side: reviewSideSchema,
    startLine: z.number().int().positive(),
    endLine: z.number().int().positive(),
    body: z.string().min(1),
    marker: z.string().min(1),
    findingId: findingIdSchema,
    reviewedHeadSha: z.string().min(1),
  })
  .superRefine((item, context) => {
    if (item.path !== item.finding.path) {
      context.addIssue({ code: "custom", path: ["path"], message: "path must match finding.path" });
    }
    if (item.side !== item.finding.side) {
      context.addIssue({ code: "custom", path: ["side"], message: "side must match finding.side" });
    }
    if (item.startLine !== item.finding.startLine) {
      context.addIssue({
        code: "custom",
        path: ["startLine"],
        message: "startLine must match finding.startLine",
      });
    }
    if (item.endLine !== item.finding.endLine) {
      context.addIssue({
        code: "custom",
        path: ["endLine"],
        message: "endLine must match finding.endLine",
      });
    }
  });

const inlinePublicationItemsSchema = z.array(inlinePublicationItemSchema);

export type InlinePublicationItem = z.infer<typeof inlinePublicationItemSchema>;
export type InlineCommentDraft = InlinePublicationItem;
export type PublishableInlineFinding = {
  finding: ReviewFinding;
  range: CommentableRange;
  previousPath?: string;
  anchorFingerprint?: string;
};

const threadActionSchema = z.strictObject({
  kind: z.enum(["resolve", "reply"]),
  findingId: findingIdSchema,
  findingHeadSha: z.string().min(1),
  commentId: z.string().min(1),
  threadId: z.string().min(1).optional(),
  body: z.string().min(1),
  responseKey: z.string().min(1),
});

const threadActionsSchema = z.array(threadActionSchema);

export type ThreadAction = z.infer<typeof threadActionSchema>;

const publicationMetadataSchema = z.strictObject({
  runtimeVersion: z.string().min(1),
  configVersion: z.string().min(1).optional(),
  trustedConfigSha: z.string().min(1).optional(),
  trustedConfigHash: z.string().min(1).optional(),
  reviewedHeadSha: z.string().min(1),
  providerModels: z.array(z.string().min(1)).optional(),
  selectedTasks: z.array(z.string().min(1)),
  failedTasks: z.array(z.string().min(1)),
  validFindings: z.number().int().min(0),
  droppedFindings: z.number().int().min(0),
  cappedInlineFindings: z.number().int().min(0),
  stats: reviewStatsSchema.optional(),
});

export type PublicationMetadata = z.infer<typeof publicationMetadataSchema>;

const publicationPlanSchema = z.strictObject({
  mainComment: z.string().min(1),
  mainMarker: z.string().min(1),
  changeNumber: z.number().int().positive(),
  inlineItems: inlinePublicationItemsSchema,
  metadata: publicationMetadataSchema,
  reviewState: priorReviewStateSchema,
  threadActions: threadActionsSchema,
});

export type PublicationPlan = z.infer<typeof publicationPlanSchema>;

export function publicationPlanForHostCapabilities(
  plan: PublicationPlan,
  capabilities: { multilineInlineComments: boolean; suggestedChanges: boolean },
): PublicationPlan {
  return {
    ...plan,
    inlineItems: plan.inlineItems
      .filter((item) => capabilities.multilineInlineComments || item.startLine === item.endLine)
      .map((item) => {
        if (capabilities.suggestedChanges || !item.finding.suggestedFix) {
          return item;
        }
        const finding = withoutSuggestedFix(item.finding);
        return {
          ...item,
          finding,
          body: [
            renderInlineBody(finding, item.findingId, item.reviewedHeadSha),
            "**Suggested change**",
            "",
            renderSuggestedChange(item.finding.suggestedFix, false),
          ].join("\n"),
        };
      }),
  };
}

export type BuildPublicationPlanOptions = {
  event: Pick<ChangeRequestEventContext, "change">;
  main: string;
  inlineItems: InlinePublicationItem[];
  metadata: Omit<PublicationMetadata, "cappedInlineFindings">;
  maxInlineComments?: number;
  maxStoredFindings?: number;
  showHeader?: boolean;
  showFooter?: boolean;
  showStats?: boolean;
  reviewState?: PriorReviewState;
  threadActions?: ThreadAction[];
};

export function buildPublicationPlan(options: BuildPublicationPlanOptions): PublicationPlan {
  const reviewState =
    options.reviewState ??
    buildPriorReviewState({
      findings: options.inlineItems.map((item) => ({ finding: item.finding })),
      reviewedHeadSha: options.metadata.reviewedHeadSha,
      selectedTasks: options.metadata.selectedTasks,
    });
  const cappedInlineItems =
    options.maxInlineComments === undefined
      ? options.inlineItems
      : options.inlineItems.slice(0, options.maxInlineComments);
  const metadata = publicationMetadataSchema.parse({
    ...options.metadata,
    cappedInlineFindings: options.inlineItems.length - cappedInlineItems.length,
  });
  return publicationPlanSchema.parse({
    mainComment: renderMainComment({
      event: options.event,
      reviewState,
      maxStoredFindings: options.maxStoredFindings,
      main: options.main,
      metadata,
      showHeader: options.showHeader ?? true,
      showFooter: options.showFooter ?? true,
      showStats: options.showStats ?? true,
    }),
    mainMarker: mainCommentMarker,
    changeNumber: options.event.change.number,
    inlineItems: cappedInlineItems,
    metadata,
    reviewState,
    threadActions: options.threadActions ?? [],
  });
}

export function prepareInlinePublicationItems(options: {
  validated: {
    validFindings: ReviewFinding[];
  };
  manifest: DiffManifest;
  reviewedHeadSha: string;
  reviewState?: PriorReviewState;
}): InlinePublicationItem[] {
  return prepareInlinePublicationItemsForPublishableFindings({
    publishableFindings: preparePublishableInlineFindings({
      validated: options.validated,
      manifest: options.manifest,
    }),
    reviewedHeadSha: options.reviewedHeadSha,
    reviewState: options.reviewState,
  });
}

export function preparePublishableInlineFindings(options: {
  validated: {
    validFindings: ReviewFinding[];
  };
  manifest: DiffManifest;
}): PublishableInlineFinding[] {
  const ranges = createDiffRangeIndex(options.manifest);
  return options.validated.validFindings.flatMap((finding) => {
    const match = ranges.findRange(finding.rangeId);
    if (!match) {
      throw new Error(`Validated finding range '${finding.rangeId}' is missing from Diff Manifest`);
    }
    const { file, range } = match;
    const findingWithBody = findingWithPublishableBody(finding);
    if (!findingWithBody) {
      return [];
    }
    return [
      {
        finding: findingWithPublishableSuggestedFix(findingWithBody, range),
        range,
        previousPath: file.previousPath,
      },
    ];
  });
}

export function prepareInlinePublicationItemsForPublishableFindings(options: {
  publishableFindings: PublishableInlineFinding[];
  reviewedHeadSha: string;
  reviewState?: PriorReviewState;
}): InlinePublicationItem[] {
  const seenFindingIds = new Set<string>();
  const fingerprintCounts = countFindingFingerprints(options.publishableFindings);
  return inlinePublicationItemsSchema.parse(
    options.publishableFindings.flatMap(
      ({ finding: publishableFinding, range, previousPath, anchorFingerprint }) => {
        const findingId = findingIdFor(publishableFinding, options.reviewState);
        const stateRecord = options.reviewState
          ? matchFindingRecord(options.reviewState, publishableFinding)
          : undefined;
        const resolvedRecord = options.reviewState
          ? matchResolvedFindingRecord(
              options.reviewState.findings,
              publishableFinding,
              anchorFingerprint,
              fingerprintCounts,
              previousPath,
            )
          : undefined;
        if (
          seenFindingIds.has(findingId) ||
          resolvedRecord !== undefined ||
          stateRecord?.lastCommentedHeadSha === options.reviewedHeadSha
        ) {
          return [];
        }
        seenFindingIds.add(findingId);
        const marker = inlineFindingMarker(findingId, options.reviewedHeadSha);
        return [
          inlinePublicationItemSchema.parse({
            finding: publishableFinding,
            range,
            path: publishableFinding.path,
            previousPath,
            side: publishableFinding.side,
            startLine: publishableFinding.startLine,
            endLine: publishableFinding.endLine,
            marker,
            findingId,
            reviewedHeadSha: options.reviewedHeadSha,
            body: renderInlineBody(publishableFinding, findingId, options.reviewedHeadSha),
          }),
        ];
      },
    ),
  );
}

function findingWithPublishableBody(finding: ReviewFinding): ReviewFinding | undefined {
  const body = finding.body.trim();
  if (body.length === 0) {
    return undefined;
  }
  return body === finding.body ? finding : { ...finding, body };
}

function findingWithPublishableSuggestedFix(
  finding: ReviewFinding,
  range: CommentableRange,
): ReviewFinding {
  if (!finding.suggestedFix) {
    return finding;
  }
  if (
    !isPublishableSuggestedFixSelection({
      side: range.side,
      kind: range.kind,
      rangeStartLine: range.startLine,
      startLine: finding.startLine,
      endLine: finding.endLine,
      preview: range.preview,
      suggestedFix: finding.suggestedFix,
    })
  ) {
    return withoutSuggestedFix(finding);
  }

  return finding;
}

function withoutSuggestedFix(finding: ReviewFinding): ReviewFinding {
  const next = { ...finding };
  delete next.suggestedFix;
  return next;
}

function renderMainComment(options: {
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
    ...(options.metadata.validFindings > 0
      ? [`**Findings:** ${options.metadata.validFindings}`, ""]
      : []),
    options.main,
    "",
    ...(!options.showStats || !options.metadata.stats ? [reviewStatsHiddenMarker, ""] : []),
    ...(options.showStats && options.metadata.stats
      ? [renderReviewStats(options.metadata.stats), ""]
      : []),
    ...(options.showFooter
      ? [renderMainCommentAttribution(options.metadata), ""]
      : [mainCommentFooterHiddenMarker, ""]),
  ].join("\n");
}

function renderReviewStats(stats: ReviewStats): string {
  const usageSuffix = stats.usageStatus === "partial" ? " (reported)" : "";
  const usageUnavailable = stats.usageStatus === "unavailable";
  return [
    reviewStatsStartMarker,
    "<details>",
    "<summary>Review stats</summary>",
    "",
    "| Metric | Total |",
    "| --- | ---: |",
    `| Models | ${stats.models.map(formatModel).join(", ")} |`,
    `| Agent runs | ${stats.agentRuns} |`,
    `| Elapsed | ${formatDuration(stats.durationMs)} |`,
    `| Input tokens | ${usageUnavailable ? "Unavailable" : `${formatInteger(stats.inputTokens)}${usageSuffix}`} |`,
    `| Output tokens | ${usageUnavailable ? "Unavailable" : `${formatInteger(stats.outputTokens)}${usageSuffix}`} |`,
    `| Cost (USD) | ${usageUnavailable ? "Unavailable" : `${formatCost(stats.costUsd)}${usageSuffix}`} |`,
    "",
    "</details>",
    reviewStatsEndMarker,
  ].join("\n");
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

function formatDuration(durationMs: number): string {
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

function renderInlineBody(
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

function renderSuggestedChange(suggestedFix: string, native = true): string {
  const longestBacktickRun = Math.max(
    0,
    ...[...suggestedFix.matchAll(/`+/g)].map((match) => match[0].length),
  );
  const fence = "`".repeat(Math.max(3, longestBacktickRun + 1));
  const closingPrefix = suggestedFix.endsWith("\n") ? "" : "\n";
  return `${fence}${native ? "suggestion" : ""}\n${suggestedFix}${closingPrefix}${fence}`;
}
