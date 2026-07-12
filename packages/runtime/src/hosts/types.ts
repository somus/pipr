import type { PublicationPlan, ThreadAction } from "../review/comment.js";
import type { PriorReviewState } from "../review/prior-state.js";
import type { PublicationResult } from "../review/publication-result.js";
import type {
  ChangeRequestEventContext,
  ChangeRequestRef,
  CodeHostCoordinates,
  CommandPermissionLevel,
  RepositoryRef,
} from "../types.js";

export type HostEventParseOptions = {
  eventPath?: string;
  env: NodeJS.ProcessEnv;
  workspace: string;
};

export type NativeId = string;

export type CommandCommentEvent = {
  eventName: string;
  action?: string;
  rawAction?: string;
  repository: RepositoryRef;
  changeNumber: number;
  commentId: NativeId;
  isChangeRequest: boolean;
  body: string;
  actor: string;
  workspace: string;
};

export type CommandResponsePublicationResult = {
  action: "created" | "updated";
  id: NativeId;
};

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

export type ReviewCommentReplyEvent = {
  eventName: string;
  action?: string;
  rawAction?: string;
  repository: RepositoryRef;
  changeNumber: number;
  commentId: NativeId;
  parentCommentId?: NativeId;
  body: string;
  actor: string;
  workspace: string;
};

export type CodeHostEvent =
  | { kind: "ignored"; reason: string }
  | { kind: "change-request"; change: ChangeRequestEventContext }
  | { kind: "command-comment"; comment: CommandCommentEvent }
  | { kind: "review-comment-reply"; reply: ReviewCommentReplyEvent };

export type LoadedChangeRequest = {
  repository: RepositoryRef;
  coordinates: CodeHostCoordinates;
  change: ChangeRequestRef;
  eventName?: string;
  action?: string;
  rawAction?: string;
  workspace?: string;
};

export type RepositoryPermission = CommandPermissionLevel | "none";

export type CodeHostStatusState = "pending" | "success" | "failure" | "neutral";

export type CodeHostStatus = {
  id: NativeId;
  name: string;
};

export type CodeHostEvents = {
  parseEvent(options: HostEventParseOptions): Promise<CodeHostEvent>;
  loadChangeRequest(ref: {
    repository: RepositoryRef;
    changeNumber: number;
    workspace?: string;
    eventName?: string;
    action?: string;
    rawAction?: string;
  }): Promise<LoadedChangeRequest>;
};

export type CodeHostPermissions = {
  getRepositoryPermission(options: {
    change: ChangeRequestEventContext;
    actor: string;
  }): Promise<RepositoryPermission>;
};

export type CodeHostWorkspace = {
  ensureHeadCheckout(options: {
    rootDir: string;
    change: ChangeRequestEventContext;
  }): Promise<void>;
  ensureWorkspaceSafeDirectory?(options: { rootDir: string; env?: NodeJS.ProcessEnv }): void;
};

export type CodeHostPublication = {
  publish(options: {
    plan: PublicationPlan;
    change: ChangeRequestEventContext;
  }): Promise<PublicationResult>;
  publishCommandResponse?(options: {
    change: ChangeRequestEventContext;
    sourceCommentId: NativeId;
    commandName: string;
    body: string;
  }): Promise<CommandResponsePublicationResult>;
  publishThreadActions?(options: {
    change: ChangeRequestEventContext;
    actions: ThreadAction[];
    reviewedHeadSha: string;
  }): Promise<{ errors: string[] }>;
};

export type CodeHostComments = {
  loadPriorReviewState?(options: {
    change: ChangeRequestEventContext;
  }): Promise<PriorReviewState | undefined>;
  loadPriorMainComment?(options: {
    change: ChangeRequestEventContext;
  }): Promise<string | undefined>;
  loadInlineThreadContexts?(options: {
    change: ChangeRequestEventContext;
  }): Promise<InlineThreadContext[]>;
};

export type CodeHostStatuses = {
  isAvailable(change: ChangeRequestEventContext): boolean;
  upsert(options: {
    change: ChangeRequestEventContext;
    name: string;
    state: CodeHostStatusState;
    summary?: string;
    status?: CodeHostStatus;
  }): Promise<CodeHostStatus>;
};

export type CodeHostCapabilities = {
  commandComments: boolean;
  reviewCommentReplies: boolean;
  threadResolution: boolean;
  multilineInlineComments: boolean;
  suggestedChanges: boolean;
  statuses: boolean;
};

export type CodeHostAdapter = {
  id: string;
  capabilities: CodeHostCapabilities;
  events: CodeHostEvents;
  workspace: CodeHostWorkspace;
  permissions: CodeHostPermissions;
  publication?: CodeHostPublication;
  comments?: CodeHostComments;
  statuses?: CodeHostStatuses;
};
