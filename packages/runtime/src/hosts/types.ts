import type { PublicationPlan, ThreadAction } from "../review/comment.js";
import type { PriorReviewState } from "../review/prior-state.js";
import type { PublicationResult } from "../review/publication-result.js";
import type {
  ChangeRequestEventContext,
  ChangeRequestRef,
  CommandPermissionLevel,
  RepositoryRef,
} from "../types.js";

export type HostEventParseOptions = {
  eventPath: string;
  env: NodeJS.ProcessEnv;
  workspace: string;
};

export type CommandCommentEvent = {
  eventName: string;
  action?: string;
  rawAction?: string;
  repository: RepositoryRef;
  changeNumber: number;
  commentId: number;
  isChangeRequest: boolean;
  body: string;
  actor: string;
  workspace: string;
};

export type CommandResponsePublicationResult = {
  action: "created" | "updated";
  id: number;
};

export type InlineThreadContext = {
  findingId: string;
  findingHeadSha: string;
  parentCommentId: number;
  parentBody: string;
  threadId?: string;
  threadResolved: boolean;
  comments: Array<{
    id: number;
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
  commentId: number;
  parentCommentId?: number;
  body: string;
  actor: string;
  workspace: string;
};

export type LoadedChangeRequest = {
  repository: RepositoryRef;
  change: ChangeRequestRef;
  eventName?: string;
  action?: string;
  rawAction?: string;
  workspace?: string;
};

export type RepositoryPermission = CommandPermissionLevel | "none";

export type CodeHostCheckConclusion = "success" | "failure" | "neutral";

export type CodeHostCheckRun = {
  id: number | string;
  name: string;
};

export type CodeHostEvents = {
  parseEvent(options: HostEventParseOptions): Promise<ChangeRequestEventContext>;
  loadChangeRequest(ref: {
    repository: RepositoryRef;
    changeNumber: number;
    workspace?: string;
    eventName?: string;
    action?: string;
    rawAction?: string;
  }): Promise<LoadedChangeRequest>;
  resolveCommandComment(options: HostEventParseOptions): Promise<CommandCommentEvent>;
  resolveReviewCommentReply?(options: HostEventParseOptions): Promise<ReviewCommentReplyEvent>;
};

export type CodeHostPermissions = {
  getRepositoryPermission(options: {
    repository: RepositoryRef;
    actor: string;
  }): Promise<RepositoryPermission>;
};

export type CodeHostWorkspace = {
  ensureHeadCheckout(options: { rootDir: string; change: ChangeRequestEventContext }): void;
  ensureWorkspaceSafeDirectory?(options: { rootDir: string; env?: NodeJS.ProcessEnv }): void;
};

export type CodeHostPublication = {
  publish(options: {
    plan: PublicationPlan;
    change: ChangeRequestEventContext;
  }): Promise<PublicationResult>;
  publishCommandResponse?(options: {
    change: ChangeRequestEventContext;
    sourceCommentId: number;
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

export type CodeHostChecks = {
  createCheckRun?(options: {
    change: ChangeRequestEventContext;
    name: string;
    summary?: string;
  }): Promise<CodeHostCheckRun>;
  updateCheckRun?(options: {
    change: ChangeRequestEventContext;
    checkRun: CodeHostCheckRun;
    conclusion: CodeHostCheckConclusion;
    summary?: string;
  }): Promise<void>;
};

export type CodeHostAdapter = {
  id: string;
  events: CodeHostEvents;
  workspace: CodeHostWorkspace;
  permissions: CodeHostPermissions;
  publication?: CodeHostPublication;
  comments?: CodeHostComments;
  checks?: CodeHostChecks;
};
