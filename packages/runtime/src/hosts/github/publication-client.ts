import { Octokit } from "@octokit/rest";
import { z } from "zod";
import { githubApiVersion, parseRepoSlug } from "../../shared/github.js";

const githubCommentFields = {
  id: z.number().int().positive(),
  body: z.string().nullable().optional(),
  user: z
    .looseObject({
      login: z.string().min(1),
    })
    .optional(),
};

const githubIssueCommentSchema = z.looseObject(githubCommentFields).transform((comment) => ({
  id: comment.id,
  body: comment.body,
  authorLogin: comment.user?.login,
}));

const githubReviewCommentSchema = z
  .looseObject({
    ...githubCommentFields,
    path: z.string().min(1).optional(),
    commit_id: z.string().min(1).optional(),
    line: z.number().int().positive().nullable().optional(),
    start_line: z.number().int().positive().nullable().optional(),
    side: z.enum(["RIGHT", "LEFT"]).optional(),
    start_side: z.enum(["RIGHT", "LEFT"]).nullable().optional(),
    user: z
      .looseObject({
        login: z.string().min(1),
      })
      .optional(),
  })
  .transform((comment) => ({
    id: comment.id,
    body: comment.body,
    authorLogin: comment.user?.login,
    path: comment.path,
    commitId: comment.commit_id,
    line: comment.line ?? undefined,
    startLine: comment.start_line ?? undefined,
    side: comment.side,
    startSide: comment.start_side ?? undefined,
  }));

const githubReviewThreadSchema = z.strictObject({
  id: z.string().min(1),
  isResolved: z.boolean(),
  commentIds: z.array(z.number().int().positive()),
});

const githubReviewThreadsPageSchema = z
  .looseObject({
    repository: z
      .looseObject({
        pullRequest: z
          .looseObject({
            reviewThreads: z.looseObject({
              pageInfo: z.looseObject({
                hasNextPage: z.boolean(),
                endCursor: z.string().nullable().optional(),
              }),
              nodes: z.array(
                z.looseObject({
                  id: z.string().min(1),
                  isResolved: z.boolean().optional(),
                  comments: z.looseObject({
                    nodes: z.array(
                      z.looseObject({
                        databaseId: z.number().int().positive().nullable().optional(),
                      }),
                    ),
                  }),
                }),
              ),
            }),
          })
          .nullable()
          .optional(),
      })
      .optional(),
  })
  .transform((page) => {
    const reviewThreads = page.repository?.pullRequest?.reviewThreads;
    if (!reviewThreads) {
      throw new Error("GitHub pull request review threads were not found");
    }
    return {
      pageInfo: {
        hasNextPage: reviewThreads.pageInfo.hasNextPage,
        endCursor: reviewThreads.pageInfo.endCursor ?? undefined,
      },
      threads: reviewThreads.nodes.map((thread) =>
        githubReviewThreadSchema.parse({
          id: thread.id,
          isResolved: thread.isResolved ?? false,
          commentIds: thread.comments.nodes.flatMap((comment) =>
            comment.databaseId === undefined || comment.databaseId === null
              ? []
              : [comment.databaseId],
          ),
        }),
      ),
    };
  });

const githubAuthenticatedUserSchema = z.looseObject({
  login: z.string().min(1),
});
const githubActionsBotLogin = "github-actions[bot]";

const pullRequestHeadSchema = z.looseObject({
  head: z.looseObject({
    sha: z.string().min(1),
  }),
});

const githubCheckRunSchema = z.looseObject({
  id: z.number().int().positive(),
  name: z.string().min(1),
});

export type GitHubIssueComment = z.infer<typeof githubIssueCommentSchema>;
export type GitHubReviewComment = z.infer<typeof githubReviewCommentSchema>;
export type GitHubReviewThread = z.infer<typeof githubReviewThreadSchema>;
export type GitHubCheckRun = z.infer<typeof githubCheckRunSchema>;

export type GitHubPublicationClient = {
  getAuthenticatedUserLogin(): Promise<string>;
  getPullRequestHeadSha(options: { repo: string; pullRequestNumber: number }): Promise<string>;
  listIssueComments(options: { repo: string; issueNumber: number }): Promise<GitHubIssueComment[]>;
  createIssueComment(options: {
    repo: string;
    issueNumber: number;
    body: string;
  }): Promise<{ id: number }>;
  updateIssueComment(options: {
    repo: string;
    commentId: number;
    body: string;
  }): Promise<{ id: number }>;
  listReviewComments(options: {
    repo: string;
    pullRequestNumber: number;
  }): Promise<GitHubReviewComment[]>;
  listReviewThreads(options: {
    repo: string;
    pullRequestNumber: number;
  }): Promise<GitHubReviewThread[]>;
  createReviewComment(options: {
    repo: string;
    pullRequestNumber: number;
    body: string;
    path: string;
    commit_id: string;
    line: number;
    side: "RIGHT" | "LEFT";
    start_line?: number;
    start_side?: "RIGHT" | "LEFT";
  }): Promise<{ id: number }>;
  createReviewCommentReply(options: {
    repo: string;
    pullRequestNumber: number;
    commentId: number;
    body: string;
  }): Promise<{ id: number }>;
  resolveReviewThread(options: { threadId: string }): Promise<void>;
  createCheckRun(options: {
    repo: string;
    name: string;
    headSha: string;
    summary?: string;
  }): Promise<GitHubCheckRun>;
  updateCheckRun(options: {
    repo: string;
    checkRunId: number;
    name: string;
    conclusion: "success" | "failure" | "neutral";
    summary?: string;
  }): Promise<void>;
};

export function createGitHubPublicationClient(
  env: NodeJS.ProcessEnv = process.env,
): GitHubPublicationClient {
  const authenticatedUserLogin = env.GITHUB_ACTIONS === "true" ? githubActionsBotLogin : undefined;
  const octokit = new Octokit({
    auth: env.GITHUB_TOKEN,
    baseUrl: env.GITHUB_API_URL ?? "https://api.github.com",
    request: {
      headers: {
        "X-GitHub-Api-Version": githubApiVersion,
      },
    },
  });
  return {
    async getAuthenticatedUserLogin() {
      if (authenticatedUserLogin) {
        return authenticatedUserLogin;
      }
      const { data } = await octokit.rest.users.getAuthenticated();
      return githubAuthenticatedUserSchema.parse(data).login;
    },
    async getPullRequestHeadSha(options) {
      const repo = parseRepoSlug(options.repo);
      const { data } = await octokit.rest.pulls.get({
        ...repo,
        pull_number: options.pullRequestNumber,
      });
      const value = pullRequestHeadSchema.parse(data);
      return value.head.sha;
    },
    async listIssueComments(options) {
      const repo = parseRepoSlug(options.repo);
      return z.array(githubIssueCommentSchema).parse(
        await octokit.paginate(octokit.rest.issues.listComments, {
          ...repo,
          issue_number: options.issueNumber,
          per_page: 100,
        }),
      );
    },
    async createIssueComment(options) {
      const repo = parseRepoSlug(options.repo);
      const { data } = await octokit.rest.issues.createComment({
        ...repo,
        issue_number: options.issueNumber,
        body: options.body,
      });
      return githubIssueCommentSchema.parse(data);
    },
    async updateIssueComment(options) {
      const repo = parseRepoSlug(options.repo);
      const { data } = await octokit.rest.issues.updateComment({
        ...repo,
        comment_id: options.commentId,
        body: options.body,
      });
      return githubIssueCommentSchema.parse(data);
    },
    async listReviewComments(options) {
      const repo = parseRepoSlug(options.repo);
      return z.array(githubReviewCommentSchema).parse(
        await octokit.paginate(octokit.rest.pulls.listReviewComments, {
          ...repo,
          pull_number: options.pullRequestNumber,
          per_page: 100,
        }),
      );
    },
    async createReviewComment(options) {
      const { repo: repoSlug, pullRequestNumber, ...body } = options;
      const repo = parseRepoSlug(repoSlug);
      const { data } = await octokit.rest.pulls.createReviewComment({
        ...repo,
        pull_number: pullRequestNumber,
        ...body,
      });
      return githubReviewCommentSchema.parse(data);
    },
    async listReviewThreads(options) {
      const repo = parseRepoSlug(options.repo);
      const threads: GitHubReviewThread[] = [];
      let after: string | undefined;
      for (;;) {
        const page = githubReviewThreadsPageSchema.parse(
          await octokit.graphql(githubReviewThreadsQuery, {
            owner: repo.owner,
            name: repo.repo,
            number: options.pullRequestNumber,
            after: after ?? null,
          }),
        );
        threads.push(...page.threads);
        if (!page.pageInfo.hasNextPage) {
          return threads;
        }
        after = page.pageInfo.endCursor;
      }
    },
    async createReviewCommentReply(options) {
      const repo = parseRepoSlug(options.repo);
      const { data } = await octokit.rest.pulls.createReplyForReviewComment({
        ...repo,
        pull_number: options.pullRequestNumber,
        comment_id: options.commentId,
        body: options.body,
      });
      return githubReviewCommentSchema.parse(data);
    },
    async resolveReviewThread(options) {
      await octokit.graphql(githubResolveReviewThreadMutation, {
        threadId: options.threadId,
      });
    },
    async createCheckRun(options) {
      const repo = parseRepoSlug(options.repo);
      const { data } = await octokit.rest.checks.create({
        ...repo,
        name: options.name,
        head_sha: options.headSha,
        status: "in_progress",
        output: {
          title: options.name,
          summary: options.summary ?? "pipr is running.",
        },
      });
      return githubCheckRunSchema.parse(data);
    },
    async updateCheckRun(options) {
      const repo = parseRepoSlug(options.repo);
      await octokit.rest.checks.update({
        ...repo,
        check_run_id: options.checkRunId,
        name: options.name,
        status: "completed",
        conclusion: options.conclusion,
        completed_at: new Date().toISOString(),
        output: {
          title: options.name,
          summary: options.summary ?? checkRunSummary(options.conclusion),
        },
      });
    },
  };
}

function checkRunSummary(conclusion: "success" | "failure" | "neutral"): string {
  switch (conclusion) {
    case "success":
      return "pipr completed successfully.";
    case "failure":
      return "pipr failed.";
    case "neutral":
      return "pipr skipped this check.";
  }
}

const githubReviewThreadsQuery = /* GraphQL */ `
  query PiprReviewThreads($owner: String!, $name: String!, $number: Int!, $after: String) {
    repository(owner: $owner, name: $name) {
      pullRequest(number: $number) {
        reviewThreads(first: 100, after: $after) {
          pageInfo {
            hasNextPage
            endCursor
          }
          nodes {
            id
            isResolved
            comments(first: 100) {
              nodes {
                databaseId
              }
            }
          }
        }
      }
    }
  }
`;

const githubResolveReviewThreadMutation = /* GraphQL */ `
  mutation PiprResolveReviewThread($threadId: ID!) {
    resolveReviewThread(input: { threadId: $threadId }) {
      thread {
        id
        isResolved
      }
    }
  }
`;
