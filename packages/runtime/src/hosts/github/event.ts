import { z } from "zod";
import { githubActor } from "../../shared/github.js";
import type { ChangeRequestEventContext } from "../../types.js";
import { parseChangeRequestEventContext } from "../../types.js";

const githubPullRequestPayloadSchema = z.looseObject({
  action: z.string().optional(),
  number: z.number().optional(),
  repository: z
    .looseObject({
      full_name: z.string().optional(),
      html_url: z.string().optional(),
    })
    .optional(),
  pull_request: z.looseObject(
    {
      number: z.number().optional(),
      title: z.string().optional(),
      body: z.string().nullable().optional(),
      html_url: z.string().optional(),
      user: z
        .looseObject({
          login: z.string().optional(),
        })
        .optional(),
      base: z
        .looseObject({
          sha: z.string().optional(),
          ref: z.string().optional(),
          repo: z
            .looseObject({
              full_name: z.string().optional(),
              html_url: z.string().optional(),
            })
            .optional(),
        })
        .optional(),
      head: z
        .looseObject({
          sha: z.string().optional(),
          ref: z.string().optional(),
          repo: z
            .looseObject({
              full_name: z.string().optional(),
              html_url: z.string().optional(),
              fork: z.boolean().optional(),
            })
            .optional(),
          user: z
            .looseObject({
              login: z.string().optional(),
            })
            .optional(),
        })
        .optional(),
    },
    { error: "GitHub event payload does not contain pull_request" },
  ),
});

const githubIssueCommentPayloadSchema = z.looseObject({
  action: z.string().optional(),
  repository: z
    .looseObject({
      full_name: z.string().optional(),
      html_url: z.string().optional(),
    })
    .optional(),
  issue: z
    .looseObject({
      number: z.number().optional(),
      pull_request: z.unknown().optional(),
    })
    .optional(),
  comment: z
    .looseObject({
      id: z.number().optional(),
      body: z.string().optional(),
      user: z
        .looseObject({
          login: z.string().optional(),
        })
        .optional(),
    })
    .optional(),
});

const githubReviewCommentPayloadSchema = z.looseObject({
  action: z.string().optional(),
  repository: z
    .looseObject({
      full_name: z.string().optional(),
      html_url: z.string().optional(),
    })
    .optional(),
  pull_request: z
    .looseObject({
      number: z.number().optional(),
    })
    .optional(),
  comment: z
    .looseObject({
      id: z.number().optional(),
      in_reply_to_id: z.number().nullable().optional(),
      body: z.string().optional(),
      user: z
        .looseObject({
          login: z.string().optional(),
        })
        .optional(),
    })
    .optional(),
});

const githubIssueCommentEventContextSchema = z.strictObject({
  eventName: z.literal("issue_comment"),
  action: z.string().optional(),
  rawAction: z.string().optional(),
  repository: z.strictObject({
    slug: z.string({ error: "GitHub issue comment event is missing repo" }).min(1),
    url: z.string().min(1).optional(),
  }),
  changeNumber: z
    .number({ error: "GitHub issue comment event is missing issue number" })
    .int()
    .positive(),
  commentId: z
    .number({ error: "GitHub issue comment event is missing comment id" })
    .int()
    .positive(),
  isChangeRequest: z.boolean(),
  body: z.string(),
  actor: z.string({ error: "GitHub issue comment event is missing comment user" }).min(1),
  workspace: z.string().min(1),
});

export type GitHubIssueCommentEventContext = z.infer<typeof githubIssueCommentEventContextSchema>;

const githubReviewCommentReplyEventSchema = z.strictObject({
  eventName: z.literal("pull_request_review_comment"),
  action: z.string().optional(),
  rawAction: z.string().optional(),
  repository: z.strictObject({
    slug: z.string({ error: "GitHub review comment event is missing repo" }).min(1),
    url: z.string().min(1).optional(),
  }),
  changeNumber: z
    .number({ error: "GitHub review comment event is missing pull request number" })
    .int()
    .positive(),
  commentId: z
    .number({ error: "GitHub review comment event is missing comment id" })
    .int()
    .positive(),
  parentCommentId: z.number().int().positive().optional(),
  body: z.string(),
  actor: z.string({ error: "GitHub review comment event is missing comment user" }).min(1),
  workspace: z.string().min(1),
});

export type GitHubReviewCommentReplyEvent = z.infer<typeof githubReviewCommentReplyEventSchema>;

export async function loadGitHubPullRequestEventContext(options: {
  eventPath: string;
  env: NodeJS.ProcessEnv;
  workspace: string;
}): Promise<ChangeRequestEventContext> {
  const payload = githubPullRequestPayloadSchema.parse(await Bun.file(options.eventPath).json());
  return parseChangeRequestEventContext(githubPullRequestEventInput(payload, options));
}

function githubPullRequestEventInput(
  payload: z.infer<typeof githubPullRequestPayloadSchema>,
  options: {
    env: NodeJS.ProcessEnv;
    workspace: string;
  },
) {
  const repository = githubEventRepository(payload, options.env);
  return {
    eventName: options.env.GITHUB_EVENT_NAME ?? "pull_request",
    action: normalizeGitHubPullRequestAction(payload.action),
    rawAction: payload.action,
    platform: { id: "github", host: options.env.GITHUB_SERVER_URL },
    repository,
    change: githubEventChange(payload, repository.slug),
    workspace: options.workspace,
  };
}

function githubEventRepository(
  payload: z.infer<typeof githubPullRequestPayloadSchema>,
  env: NodeJS.ProcessEnv,
) {
  const baseRepo = payload.pull_request.base?.repo;
  return {
    slug: [payload.repository?.full_name, baseRepo?.full_name, env.GITHUB_REPOSITORY].find(
      (value) => value !== undefined && value.length > 0,
    ),
    url: payload.repository?.html_url ?? baseRepo?.html_url,
  };
}

function githubEventChange(
  payload: z.infer<typeof githubPullRequestPayloadSchema>,
  repositorySlug: string | undefined,
) {
  const pullRequest = payload.pull_request;
  return {
    number: pullRequest.number ?? payload.number,
    title: pullRequest.title ?? "",
    description: pullRequest.body ?? "",
    url: pullRequest.html_url,
    author: githubActor(pullRequest.user?.login),
    base: githubBaseEndpoint(pullRequest),
    head: githubHeadEndpoint(pullRequest),
    isFork: githubEventHeadIsFork(pullRequest.head?.repo?.full_name, repositorySlug),
  };
}

function githubBaseEndpoint(
  pullRequest: z.infer<typeof githubPullRequestPayloadSchema>["pull_request"],
) {
  return {
    sha: pullRequest.base?.sha,
    ref: pullRequest.base?.ref,
    url: pullRequest.base?.repo?.html_url,
  };
}

function githubHeadEndpoint(
  pullRequest: z.infer<typeof githubPullRequestPayloadSchema>["pull_request"],
) {
  return {
    sha: pullRequest.head?.sha,
    ref: pullRequest.head?.ref,
    url: pullRequest.head?.repo?.html_url,
    author: githubActor(pullRequest.head?.user?.login),
    fork: pullRequest.head?.repo?.fork,
  };
}

function githubEventHeadIsFork(
  headRepoSlug: string | undefined,
  repositorySlug: string | undefined,
): boolean {
  return (
    headRepoSlug !== undefined && repositorySlug !== undefined && headRepoSlug !== repositorySlug
  );
}

export async function loadGitHubIssueCommentEventContext(options: {
  eventPath: string;
  env: NodeJS.ProcessEnv;
  workspace: string;
}): Promise<GitHubIssueCommentEventContext> {
  const payload = githubIssueCommentPayloadSchema.parse(await Bun.file(options.eventPath).json());
  return githubIssueCommentEventContextSchema.parse({
    eventName: "issue_comment",
    action: payload.action,
    rawAction: payload.action,
    repository: {
      slug: [payload.repository?.full_name, options.env.GITHUB_REPOSITORY].find(
        (value) => value !== undefined && value.length > 0,
      ),
      url: payload.repository?.html_url,
    },
    changeNumber: payload.issue?.number,
    commentId: payload.comment?.id,
    isChangeRequest: payload.issue?.pull_request !== undefined,
    body: payload.comment?.body ?? "",
    actor: payload.comment?.user?.login,
    workspace: options.workspace,
  });
}

export async function loadGitHubReviewCommentReplyEvent(options: {
  eventPath: string;
  env: NodeJS.ProcessEnv;
  workspace: string;
}): Promise<GitHubReviewCommentReplyEvent> {
  const payload = githubReviewCommentPayloadSchema.parse(await Bun.file(options.eventPath).json());
  return githubReviewCommentReplyEventSchema.parse({
    eventName: "pull_request_review_comment",
    action: payload.action,
    rawAction: payload.action,
    repository: {
      slug: [payload.repository?.full_name, options.env.GITHUB_REPOSITORY].find(
        (value) => value !== undefined && value.length > 0,
      ),
      url: payload.repository?.html_url,
    },
    changeNumber: payload.pull_request?.number,
    commentId: payload.comment?.id,
    parentCommentId: payload.comment?.in_reply_to_id ?? undefined,
    body: payload.comment?.body ?? "",
    actor: payload.comment?.user?.login,
    workspace: options.workspace,
  });
}

function normalizeGitHubPullRequestAction(action: string | undefined): string | undefined {
  if (action === "synchronize") {
    return "updated";
  }
  if (action === "ready_for_review") {
    return "ready";
  }
  return action;
}
