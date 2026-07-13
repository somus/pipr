import { Octokit } from "@octokit/rest";
import { githubApiVersion } from "../../shared/github.js";
import { retryCodeHostOperation } from "../retry.js";

export function createGitHubOctokit(env: NodeJS.ProcessEnv): Octokit {
  const octokit = new Octokit({
    auth: env.GITHUB_TOKEN,
    baseUrl: env.GITHUB_API_URL ?? "https://api.github.com",
    request: {
      headers: {
        "X-GitHub-Api-Version": githubApiVersion,
      },
    },
  });
  octokit.hook.wrap(
    "request",
    async (request, options) =>
      await retryCodeHostOperation({
        operation: async () => await request(options),
        idempotent: isIdempotentMethod(options.method),
      }),
  );
  return octokit;
}

function isIdempotentMethod(method: string | undefined): boolean {
  return ["GET", "HEAD", "PUT", "DELETE"].includes(method?.toUpperCase() ?? "GET");
}
