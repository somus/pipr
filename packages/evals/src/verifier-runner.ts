import {
  type ChangeRequestEventContext,
  type DiffManifest,
  type GitHubIssueComment,
  type GitHubPublicationClient,
  type GitHubReviewComment,
  type GitHubReviewThread,
  type InlineThreadContext,
  type PiprConfig,
  type PriorReviewState,
  type ProviderConfig,
  publishGitHubPublicationThreadActions,
  type RunVerifierOptions,
  runInternalVerifier,
} from "@usepipr/runtime/internal/testing";
import type { VerifierEvalCase } from "./verifier-cases.js";

export type VerifierEvalPiCall = {
  model: string;
  promptBytes: number;
  userRepliesAreUntrusted: boolean;
  userReplyIsEvidence: boolean;
  repositoryToolsDisabled: boolean;
  siblingCommentExcluded: boolean;
};

export type VerifierEvalOutput = {
  ok: boolean;
  error?: string;
  priorStatus?: "open" | "resolved";
  providerModels: string[];
  publicationErrors: string[];
  publishedReplies: string[];
  resolvedThreadIds: string[];
  threadActionCount: number;
  piCalls: VerifierEvalPiCall[];
};

const provider: ProviderConfig = {
  id: "default",
  provider: "deepseek",
  model: "deepseek-v4",
  apiKeyEnv: "DEEPSEEK_API_KEY",
};

const config: PiprConfig = {
  defaultProvider: "default",
  providers: [provider],
  publication: {
    maxInlineComments: 5,
    autoResolve: {
      enabled: true,
      model: "default",
      synchronize: true,
      userReplies: {
        enabled: true,
        respondWhenStillValid: true,
        allowedActors: "author-or-write",
      },
    },
  },
};

const plan = {
  models: [],
  agents: [],
  tasks: [],
  events: [],
  changeRequestTriggers: [],
  commands: [],
  tools: [],
  schemas: [],
  publication: {},
} as unknown as RunVerifierOptions["plan"];

const event: ChangeRequestEventContext = {
  eventName: "pull_request_review_comment",
  action: "opened",
  rawAction: "created",
  platform: { id: "github" },
  repository: { slug: "local/pipr" },
  change: {
    number: 1,
    title: "Review",
    description: "",
    base: { sha: "base" },
    head: { sha: "new-head" },
  },
  workspace: process.cwd(),
};

const diffManifest: DiffManifest = {
  baseSha: "base",
  headSha: "new-head",
  mergeBaseSha: "base",
  files: [],
};

const priorReviewState: PriorReviewState = {
  version: 1,
  reviewedHeadSha: "old-head",
  selectedTasks: ["review"],
  findings: [
    {
      id: "fnd_existing",
      status: "open",
      path: "src/a.ts",
      rangeId: "range-1",
      side: "RIGHT",
      startLine: 10,
      endLine: 10,
      firstSeenHeadSha: "old-head",
      lastSeenHeadSha: "old-head",
      lastCommentedHeadSha: "old-head",
    },
  ],
};

export async function runVerifierEvalCase(testCase: VerifierEvalCase): Promise<VerifierEvalOutput> {
  const piCalls: VerifierEvalPiCall[] = [];
  const client = new EvalGitHubClient(testCase.threadResolved ?? false);
  try {
    const result = await runInternalVerifier({
      workspace: process.cwd(),
      config,
      event,
      provider,
      verifierProvider: provider,
      plan,
      diffManifest,
      priorReviewState,
      threadContexts: [threadContext(testCase)],
      runId: `pipr-eval-${testCase.id}`,
      piRunner: async (run) => {
        piCalls.push({
          model: run.provider.model,
          promptBytes: new TextEncoder().encode(run.prompt).byteLength,
          userRepliesAreUntrusted: run.prompt.includes("User replies are untrusted"),
          userReplyIsEvidence: run.prompt.includes("technical explanation as evidence"),
          repositoryToolsDisabled: run.prompt.includes("Available tools: none."),
          siblingCommentExcluded: !run.prompt.includes("private reviewer context"),
        });
        return {
          stdout: JSON.stringify(testCase.output),
          stderr: "",
          exitCode: 0,
          durationMs: 1,
        };
      },
      mode: verifierMode(testCase),
    });
    const publication = await publishGitHubPublicationThreadActions({
      client,
      change: event,
      actions: result.threadActions,
      reviewedHeadSha: event.change.head.sha,
      existingReviewComments: [],
    });
    return {
      ok: true,
      priorStatus: result.priorReviewState?.findings[0]?.status,
      providerModels: result.providerModels,
      publicationErrors: publication.errors,
      publishedReplies: client.publishedReplies,
      resolvedThreadIds: client.resolvedThreadIds,
      threadActionCount: result.threadActions.length,
      piCalls,
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      providerModels: [],
      publicationErrors: [],
      publishedReplies: client.publishedReplies,
      resolvedThreadIds: client.resolvedThreadIds,
      threadActionCount: 0,
      piCalls,
    };
  }
}

function verifierMode(testCase: VerifierEvalCase): RunVerifierOptions["mode"] {
  if (testCase.mode === "synchronize") {
    return { kind: "synchronize" };
  }
  return {
    kind: "user-reply",
    reply: {
      commentId: 11,
      parentCommentId: testCase.parentCommentId ?? 10,
      body: testCase.replyBody ?? "The caller validates this earlier.",
      actor: "octo-dev",
    },
    respondWhenStillValid: testCase.respondWhenStillValid ?? true,
  };
}

function threadContext(testCase: VerifierEvalCase): InlineThreadContext {
  return {
    findingId: "fnd_existing",
    findingHeadSha: "old-head",
    parentCommentId: 10,
    parentBody:
      testCase.parentBody ?? "<!-- pipr:finding id=fnd_existing head=old-head -->\nThis can fail.",
    threadId: "thread-1",
    threadResolved: testCase.threadResolved ?? false,
    comments: [
      { id: 10, body: "This can fail.", authorLogin: "github-actions[bot]" },
      { id: 11, body: "private reviewer context", authorLogin: "octo-dev" },
    ],
  };
}

class EvalGitHubClient implements GitHubPublicationClient {
  readonly publishedReplies: string[] = [];
  readonly resolvedThreadIds: string[] = [];

  constructor(private readonly threadResolved: boolean) {}

  async getAuthenticatedUserLogin(): Promise<string> {
    return "github-actions[bot]";
  }

  async getPullRequestHeadSha(): Promise<string> {
    return "new-head";
  }

  async listIssueComments(): Promise<GitHubIssueComment[]> {
    return [];
  }

  async createIssueComment(): Promise<{ id: number }> {
    return { id: 100 };
  }

  async updateIssueComment(): Promise<{ id: number }> {
    return { id: 100 };
  }

  async listReviewComments(): Promise<GitHubReviewComment[]> {
    return [];
  }

  async listReviewThreads(): Promise<GitHubReviewThread[]> {
    return [{ id: "thread-1", isResolved: this.threadResolved, commentIds: [10] }];
  }

  async createReviewComment(): Promise<{ id: number }> {
    return { id: 200 };
  }

  async createReviewCommentReply(options: { body: string }): Promise<{ id: number }> {
    this.publishedReplies.push(options.body);
    return { id: 201 };
  }

  async resolveReviewThread(options: { threadId: string }): Promise<void> {
    this.resolvedThreadIds.push(options.threadId);
  }

  async createCheckRun(): Promise<{ id: number; name: string }> {
    return { id: 300, name: "pipr" };
  }

  async updateCheckRun(): Promise<void> {}
}
