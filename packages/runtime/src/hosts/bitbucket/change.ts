import type { LoadedChangeRequest } from "../types.js";
import type { BitbucketPullRequest } from "./client.js";

export function loadedBitbucketChange(
  pullRequest: BitbucketPullRequest,
  workspace: string,
  repository: string,
): LoadedChangeRequest {
  return {
    repository: {
      slug: pullRequest.destination.repository.full_name,
      url: pullRequest.destination.repository.links.html.href,
    },
    coordinates: {
      provider: "bitbucket",
      workspace,
      repository,
      repositoryUuid: pullRequest.destination.repository.uuid,
    },
    change: {
      number: pullRequest.id,
      isDraft: pullRequest.draft,
      title: pullRequest.title,
      description: pullRequest.description,
      url: pullRequest.links.html.href,
      author: pullRequest.author?.nickname ? { login: pullRequest.author.nickname } : undefined,
      base: {
        sha: pullRequest.destination.commit.hash,
        ref: pullRequest.destination.branch.name,
        url: pullRequest.destination.repository.links.html.href,
      },
      head: {
        sha: pullRequest.source.commit.hash,
        ref: pullRequest.source.branch.name,
        url: pullRequest.source.repository.links.html.href,
      },
      isFork: pullRequest.source.repository.uuid !== pullRequest.destination.repository.uuid,
    },
  };
}
