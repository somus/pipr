import type { PublicationPlan } from "../../review/comment.js";
import {
  type InlinePublicationLocation,
  inlinePublicationDecision,
} from "../../review/inline-publication-policy.js";
import { extractInlineFindingMarkerRecords } from "../../review/prior-state.js";
import { PublicationError, type PublicationResult } from "../../review/publication-result.js";
import type { ChangeRequestEventContext } from "../../types.js";
import { mapFindingToGithubReviewCommentLocation } from "./inline.js";
import type { GitHubPublicationClient, GitHubReviewComment } from "./publication-client.js";
import {
  assertCurrentHeadSha,
  findMainComment,
  listOwnedReviewComments,
} from "./publication-shared.js";
import { publishGitHubPublicationThreadActions } from "./publication-thread-actions.js";

export async function publishGitHubPublicationPlan(options: {
  client: GitHubPublicationClient;
  change: ChangeRequestEventContext;
  plan: PublicationPlan;
}): Promise<PublicationResult> {
  await assertCurrentHeadSha(options.client, options.change, options.plan.metadata.reviewedHeadSha);

  const ownerLogin = await options.client.getAuthenticatedUserLogin();
  const mainComment = await upsertMainComment({ ...options, ownerLogin });
  const existingReviewComments = await listOwnedReviewComments({ ...options, ownerLogin });
  const inline = await publishInlineComments({ ...options, ownerLogin, existingReviewComments });
  const threadActions = await publishGitHubPublicationThreadActions({
    ...options,
    existingReviewComments,
  });
  const result: PublicationResult = {
    mainComment,
    inlineComments: {
      posted: inline.posted,
      skipped: inline.skipped,
      failed: inline.errors.length,
    },
    metadata: {
      ...options.plan.metadata,
      inlinePublicationErrors: inline.errors,
      inlineResolutionErrors: threadActions.errors,
    },
  };
  if (inline.errors.length > 0) {
    throw new PublicationError("GitHub inline comment publication failed", {
      inlineComments: result.inlineComments,
      metadata: result.metadata,
    });
  }
  return result;
}

async function upsertMainComment(options: {
  client: GitHubPublicationClient;
  change: ChangeRequestEventContext;
  plan: PublicationPlan;
  ownerLogin: string;
}): Promise<PublicationResult["mainComment"]> {
  const existing = findMainComment(
    await options.client.listIssueComments({
      repo: options.change.repository.slug,
      issueNumber: options.change.change.number,
    }),
    options.plan.mainMarker,
    options.change.change.number,
    options.ownerLogin,
  );
  if (existing) {
    const updated = await options.client.updateIssueComment({
      repo: options.change.repository.slug,
      commentId: existing.id,
      body: options.plan.mainComment,
    });
    return { action: "updated", id: updated.id };
  }
  const created = await options.client.createIssueComment({
    repo: options.change.repository.slug,
    issueNumber: options.change.change.number,
    body: options.plan.mainComment,
  });
  return { action: "created", id: created.id };
}

async function publishInlineComments(options: {
  client: GitHubPublicationClient;
  change: ChangeRequestEventContext;
  plan: PublicationPlan;
  ownerLogin: string;
  existingReviewComments: GitHubReviewComment[];
}): Promise<{ posted: number; skipped: number; errors: string[] }> {
  const existing = existingInlineCommentState(options.existingReviewComments);
  let posted = 0;
  let skipped = 0;
  const errors: string[] = [];

  for (const item of options.plan.inlineItems) {
    const result = await publishInlineCommentItem({ ...options, existing, item });
    switch (result.status) {
      case "posted":
        posted += 1;
        break;
      case "skipped":
        skipped += 1;
        break;
      case "failed":
        errors.push(result.error);
        break;
    }
  }

  return { posted, skipped, errors };
}

type ExistingInlineCommentState = {
  markers: Set<string>;
  locations: InlinePublicationLocation[];
};

function existingInlineCommentState(comments: GitHubReviewComment[]): ExistingInlineCommentState {
  const state: ExistingInlineCommentState = { markers: new Set(), locations: [] };
  for (const comment of comments) {
    const markers = extractInlineFindingMarkerRecords([comment.body ?? ""]);
    if (markers.length === 0) {
      continue;
    }
    const location = inlinePublicationLocationFromComment(comment);
    if (location) {
      state.locations.push(location);
    }
    for (const marker of markers) {
      state.markers.add(marker.marker);
    }
  }
  return state;
}

async function publishInlineCommentItem(options: {
  client: GitHubPublicationClient;
  change: ChangeRequestEventContext;
  existing: ExistingInlineCommentState;
  item: PublicationPlan["inlineItems"][number];
}): Promise<{ status: "posted" | "skipped" } | { status: "failed"; error: string }> {
  let location: GitHubReviewCommentLocation;
  try {
    location = mapFindingToGithubReviewCommentLocation({
      finding: options.item.finding,
      range: options.item.range,
      headSha: options.item.reviewedHeadSha,
    });
  } catch (error) {
    return { status: "failed", error: error instanceof Error ? error.message : String(error) };
  }
  if (
    inlinePublicationDecision({
      marker: options.item.marker,
      location: inlinePublicationLocationFromGitHub(location),
      existing: options.existing,
    }) === "skip"
  ) {
    return { status: "skipped" };
  }
  try {
    await options.client.createReviewComment({
      repo: options.change.repository.slug,
      pullRequestNumber: options.change.change.number,
      body: options.item.body,
      ...location,
    });
    options.existing.markers.add(options.item.marker);
    return { status: "posted" };
  } catch (error) {
    return { status: "failed", error: error instanceof Error ? error.message : String(error) };
  }
}

type GitHubReviewCommentLocation = {
  path: string;
  commit_id: string;
  line: number;
  side: "RIGHT" | "LEFT";
  start_line?: number;
  start_side?: "RIGHT" | "LEFT";
};

function inlinePublicationLocationFromGitHub(
  location: GitHubReviewCommentLocation,
): InlinePublicationLocation {
  return {
    path: location.path,
    commitId: location.commit_id,
    side: location.side,
    startLine: location.start_line ?? location.line,
    endLine: location.line,
  };
}

function inlinePublicationLocationFromComment(
  comment: GitHubReviewComment,
): InlinePublicationLocation | undefined {
  if (
    comment.path === undefined ||
    comment.commitId === undefined ||
    comment.side === undefined ||
    comment.line === undefined
  ) {
    return undefined;
  }
  return {
    path: comment.path,
    commitId: comment.commitId,
    side: comment.side,
    startLine: comment.startLine ?? comment.line,
    endLine: comment.line,
  };
}
