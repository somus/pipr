import { z } from "zod";
import { createDiffRangeIndex } from "../diff/ranges.js";
import { redactPotentialSecrets } from "../shared/redaction.js";
import { compareStableSemver, stableSemverPattern } from "../shared/semver.js";
import type {
  ChangeRequestEventContext,
  CommentableRange,
  DiffManifest,
  ReviewFinding,
} from "../types.js";
import { commentableRangeSchema, reviewSideSchema } from "../types.js";
import {
  mainCommentTitle,
  piprRepositoryUrl,
  reviewStatsEndMarker,
  reviewStatsStartMarker,
} from "./comment-branding.js";
import { reviewFindingSchema } from "./contract.js";
import {
  maxInlineFindingBodyCharacters,
  maxInlineFindingBodyLines,
} from "./inline-finding-limits.js";
import {
  buildPriorReviewState,
  findingIdFor,
  findingIdSchema,
  inlineFindingMarker,
  mainCommentMarker,
  matchFindingRecord,
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
};

const threadActionSchema = z.strictObject({
  kind: z.enum(["resolve", "reply"]),
  findingId: findingIdSchema,
  findingHeadSha: z.string().min(1),
  commentId: z.number().int().positive(),
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

export type BuildPublicationPlanOptions = {
  event: Pick<ChangeRequestEventContext, "change">;
  main: string;
  inlineItems: InlinePublicationItem[];
  metadata: Omit<PublicationMetadata, "cappedInlineFindings">;
  maxInlineComments?: number;
  reviewState?: PriorReviewState;
  threadActions?: ThreadAction[];
};

export function buildPublicationPlan(options: BuildPublicationPlanOptions): PublicationPlan {
  const reviewState =
    options.reviewState ??
    buildPriorReviewState({
      findings: options.inlineItems.map((item) => item.finding),
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
      main: options.main,
      metadata,
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
    const range = ranges.rangeById(finding.rangeId);
    if (!range) {
      throw new Error(`Validated finding range '${finding.rangeId}' is missing from Diff Manifest`);
    }
    const findingWithBody = findingWithPublishableBody(finding);
    if (!findingWithBody) {
      return [];
    }
    return [{ finding: findingWithPublishableSuggestedFix(findingWithBody, range), range }];
  });
}

export function prepareInlinePublicationItemsForPublishableFindings(options: {
  publishableFindings: PublishableInlineFinding[];
  reviewedHeadSha: string;
  reviewState?: PriorReviewState;
}): InlinePublicationItem[] {
  const seenFindingIds = new Set<string>();
  return inlinePublicationItemsSchema.parse(
    options.publishableFindings.flatMap(({ finding: publishableFinding, range }) => {
      const findingId = findingIdFor(publishableFinding, options.reviewState);
      const stateRecord = options.reviewState
        ? matchFindingRecord(options.reviewState, publishableFinding)
        : undefined;
      if (
        seenFindingIds.has(findingId) ||
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
          side: publishableFinding.side,
          startLine: publishableFinding.startLine,
          endLine: publishableFinding.endLine,
          marker,
          findingId,
          reviewedHeadSha: options.reviewedHeadSha,
          body: renderInlineBody(publishableFinding, findingId, options.reviewedHeadSha),
        }),
      ];
    }),
  );
}

function findingWithPublishableBody(finding: ReviewFinding): ReviewFinding | undefined {
  const body = conciseInlineFindingBody(finding.body);
  if (body.length === 0) {
    return undefined;
  }
  return body === finding.body ? finding : { ...finding, body };
}

function conciseInlineFindingBody(value: string): string {
  const firstParagraph = value
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .trim()
    .split(/\n{2,}/)[0];
  const visibleLines = (firstParagraph ?? value).split("\n").slice(0, maxInlineFindingBodyLines);
  const body = redactPotentialSecrets(visibleLines.join("\n").trim());
  if (body.length <= maxInlineFindingBodyCharacters) {
    return body;
  }
  return `${body.slice(0, maxInlineFindingBodyCharacters).trimEnd()}...`;
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

  return redactPotentialSecrets(finding.suggestedFix) === finding.suggestedFix
    ? finding
    : withoutSuggestedFix(finding);
}

function withoutSuggestedFix(finding: ReviewFinding): ReviewFinding {
  const next = { ...finding };
  delete next.suggestedFix;
  return next;
}

function renderMainComment(options: {
  event: Pick<ChangeRequestEventContext, "change">;
  reviewState: PriorReviewState;
  main: string;
  metadata: PublicationMetadata;
}): string {
  return [
    renderMainCommentMarker({
      marker: mainCommentMarker,
      changeNumber: options.event.change.number,
      reviewState: options.reviewState,
    }),
    "",
    mainCommentTitle,
    "",
    ...(options.metadata.validFindings > 0
      ? [`**Findings:** ${options.metadata.validFindings}`, ""]
      : []),
    redactPotentialSecrets(options.main),
    "",
    ...(options.metadata.stats ? [renderReviewStats(options.metadata.stats), ""] : []),
    renderMainCommentAttribution(options.metadata),
    "",
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

function renderSuggestedChange(suggestedFix: string): string {
  const longestBacktickRun = Math.max(
    0,
    ...[...suggestedFix.matchAll(/`+/g)].map((match) => match[0].length),
  );
  const fence = "`".repeat(Math.max(3, longestBacktickRun + 1));
  const closingPrefix = suggestedFix.endsWith("\n") ? "" : "\n";
  return `${fence}suggestion\n${suggestedFix}${closingPrefix}${fence}`;
}
