/**
 * Leaf publication contract types shared by review core and host adapters.
 * Schema-backed types (`ReviewStats`, `PriorFindingRecord`, `PriorReviewState`)
 * are derived via `z.infer` in `./schemas.js` so they cannot drift from
 * runtime validation. This module may import from shared/ and external
 * packages only — never review/, hosts/, or host-run/.
 */
import type { CommentableRange, ReviewFinding, ReviewSide } from "@usepipr/sdk";
import type { PriorReviewState, ReviewStats } from "./schemas.js";

export type {
  PriorFindingRecord,
  PriorReviewState,
  ReviewStats,
} from "./schemas.js";

export type NativeId = string;

export type InlineThreadContext = {
  findingId: string;
  findingHeadSha: string;
  parentCommentId: NativeId;
  parentBody: string;
  threadId?: string;
  threadResolved: boolean;
  comments: Array<{
    id: NativeId;
    body: string;
    authorLogin?: string;
  }>;
};

export type ThreadAction = {
  kind: "resolve" | "reply";
  findingId: string;
  findingHeadSha: string;
  commentId: string;
  threadId?: string;
  body: string;
  responseKey: string;
};

export type PublicationMetadata = {
  runtimeVersion: string;
  configVersion?: string;
  trustedConfigSha?: string;
  trustedConfigHash?: string;
  reviewedHeadSha: string;
  providerModels?: string[];
  selectedTasks: string[];
  failedTasks: string[];
  validFindings: number;
  droppedFindings: number;
  cappedInlineFindings: number;
  stats?: ReviewStats;
  workflowUrl?: string;
};

export type InlinePublicationItem = {
  finding: ReviewFinding;
  range: CommentableRange;
  path: string;
  previousPath?: string;
  side: ReviewSide;
  startLine: number;
  endLine: number;
  body: string;
  marker: string;
  findingId: string;
  reviewedHeadSha: string;
};

export type PublicationPlan = {
  mainComment: string;
  mainMarker: string;
  changeNumber: number;
  inlineItems: InlinePublicationItem[];
  metadata: PublicationMetadata;
  reviewState: PriorReviewState;
  threadActions: ThreadAction[];
};

export type PublicationResult = {
  mainComment: {
    action: "created" | "updated";
    id: string;
  };
  inlineComments: {
    posted: number;
    skipped: number;
    failed: number;
  };
  metadata: PublicationMetadata & {
    inlinePublicationErrors: string[];
    inlineResolutionErrors: string[];
  };
};

export type ReviewProgressLease = {
  token: string;
  mainCommentId: string;
  mainCommentAction: "created" | "updated";
  reviewedHeadSha: string;
};
