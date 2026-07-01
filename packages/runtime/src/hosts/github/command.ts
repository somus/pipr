import { Octokit } from "@octokit/rest";
import { z } from "zod";
import { githubActor, githubApiVersion, parseRepoSlug } from "../../shared/github.js";
import type { ChangeRequestRef, CommandPermissionLevel, RepositoryRef } from "../../types.js";
import type { RepositoryPermission } from "../types.js";

const pullRequestDetailsSchema = z.looseObject({
  title: z.string().optional(),
  body: z.string().nullable().optional(),
  html_url: z.string().optional(),
  user: z
    .looseObject({
      login: z.string().min(1).optional(),
    })
    .optional(),
  base: z.looseObject({
    sha: z.string().min(1),
    ref: z.string().min(1).optional(),
    repo: z
      .looseObject({
        full_name: z.string().min(1).optional(),
        html_url: z.string().min(1).optional(),
      })
      .optional(),
  }),
  head: z.looseObject({
    sha: z.string().min(1),
    ref: z.string().min(1).optional(),
    repo: z
      .looseObject({
        full_name: z.string().min(1).optional(),
        html_url: z.string().min(1).optional(),
        fork: z.boolean().optional(),
      })
      .optional(),
    user: z
      .looseObject({
        login: z.string().min(1).optional(),
      })
      .optional(),
  }),
});

const githubRepositoryPermissionResponseSchema = z.looseObject({
  permission: z.string().min(1),
  role_name: z.string().min(1).optional(),
});

export type GitHubPullRequestDetails = {
  repository: RepositoryRef;
  change: ChangeRequestRef;
};

export type GitHubCommandClient = {
  getPullRequest(options: {
    repository: RepositoryRef;
    changeNumber: number;
  }): Promise<GitHubPullRequestDetails>;
  getRepositoryPermission(options: {
    repository: RepositoryRef;
    actor: string;
  }): Promise<RepositoryPermission>;
};

const permissionLevels = new Set<CommandPermissionLevel>([
  "read",
  "triage",
  "write",
  "maintain",
  "admin",
]);

export function createGitHubCommandClient(
  env: NodeJS.ProcessEnv = process.env,
): GitHubCommandClient {
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
    async getPullRequest(options) {
      const repo = parseRepoSlug(options.repository.slug);
      const { data } = await octokit.rest.pulls.get({
        ...repo,
        pull_number: options.changeNumber,
      });
      return githubPullRequestDetails({
        json: pullRequestDetailsSchema.parse(data),
        repository: options.repository,
        changeNumber: options.changeNumber,
      });
    },
    async getRepositoryPermission(options) {
      try {
        const repo = parseRepoSlug(options.repository.slug);
        const { data } = await octokit.rest.repos.getCollaboratorPermissionLevel({
          ...repo,
          username: options.actor,
        });
        return githubRepositoryPermission(githubRepositoryPermissionResponseSchema.parse(data));
      } catch (error) {
        if (typeof error === "object" && error !== null && Reflect.get(error, "status") === 404) {
          return "none";
        }
        throw error;
      }
    },
  };
}

function githubRepositoryPermission(
  response: z.infer<typeof githubRepositoryPermissionResponseSchema>,
): RepositoryPermission {
  if (response.role_name && permissionLevels.has(response.role_name as CommandPermissionLevel)) {
    return response.role_name as CommandPermissionLevel;
  }
  if (response.permission && permissionLevels.has(response.permission as CommandPermissionLevel)) {
    return response.permission as CommandPermissionLevel;
  }
  return "none";
}

function githubPullRequestDetails(options: {
  json: z.infer<typeof pullRequestDetailsSchema>;
  repository: RepositoryRef;
  changeNumber: number;
}): GitHubPullRequestDetails {
  const repository = githubPullRequestRepository(options.json, options.repository);
  return {
    repository,
    change: {
      number: options.changeNumber,
      title: options.json.title ?? "",
      description: options.json.body ?? "",
      url: options.json.html_url,
      author: githubActor(options.json.user?.login),
      base: {
        sha: options.json.base.sha,
        ref: options.json.base.ref,
        url: options.json.base.repo?.html_url,
      },
      head: {
        sha: options.json.head.sha,
        ref: options.json.head.ref,
        url: options.json.head.repo?.html_url,
        author: githubActor(options.json.head.user?.login),
        fork: options.json.head.repo?.fork,
      },
      isFork: githubHeadIsFork(options.json, repository.slug),
    },
  };
}

function githubPullRequestRepository(
  json: z.infer<typeof pullRequestDetailsSchema>,
  fallback: RepositoryRef,
): RepositoryRef {
  return {
    slug: json.base.repo?.full_name ?? fallback.slug,
    url: json.base.repo?.html_url ?? fallback.url,
  };
}

function githubHeadIsFork(
  json: z.infer<typeof pullRequestDetailsSchema>,
  repositorySlug: string,
): boolean {
  return json.head.repo?.full_name !== undefined && json.head.repo.full_name !== repositorySlug;
}
