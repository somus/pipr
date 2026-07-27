import { z } from "zod";
import { parseChangeRequestEventContext } from "../../types.js";
import type { CodeHostEvent, HostEventParseOptions, LoadedChangeRequest } from "../types.js";
import type { GiteaFamilyHost } from "./client.js";

const repositorySchema = z.looseObject({
  full_name: z.string().min(3),
  html_url: z.string().url(),
});
const pullRequestHookSchema = z.looseObject({
  action: z.string().min(1),
  number: z.number().int().positive(),
  pull_request: z.looseObject({ draft: z.boolean().optional() }),
  repository: repositorySchema,
  sender: z.looseObject({ login: z.string().min(1) }),
});
const issueCommentHookSchema = z.looseObject({
  action: z.string().min(1),
  issue: z.looseObject({
    number: z.number().int().positive(),
    pull_request: z.unknown().optional(),
  }),
  comment: z.looseObject({
    id: z.union([z.number(), z.string()]).transform(String),
    body: z.string(),
  }),
  repository: repositorySchema,
  sender: z.looseObject({ login: z.string().min(1) }),
});
export type GiteaEventParseOptions = HostEventParseOptions & {
  host: GiteaFamilyHost;
  loadChangeRequest: (ref: {
    owner: string;
    repository: string;
    changeNumber: number;
  }) => Promise<LoadedChangeRequest>;
};

export async function parseGiteaEvent(options: GiteaEventParseOptions): Promise<CodeHostEvent> {
  if (!options.eventPath) {
    throw new Error(`${displayName(options.host)} events require a native event payload`);
  }
  const payload: unknown = await Bun.file(options.eventPath).json();
  const eventName = giteaEventName(options);
  if (eventName === "issue_comment") {
    return issueCommentEvent(payload, options);
  }
  if (eventName === "pull_request_review_comment") {
    return { kind: "ignored", reason: "Gitea-compatible review replies are not supported" };
  }
  if (
    eventName &&
    eventName !== "pull_request" &&
    eventName !== "pull_request_sync" &&
    eventName !== "pull_request_target"
  ) {
    throw new Error(`Unsupported ${displayName(options.host)} event '${eventName}'`);
  }
  const hook = pullRequestHookSchema.parse(payload);
  if (hook.pull_request.draft === true) {
    return { kind: "ignored", reason: "pull request is a draft" };
  }
  const { owner, repository } = parseRepositorySlug(hook.repository.full_name);
  const loaded = await options.loadChangeRequest({
    owner,
    repository,
    changeNumber: hook.number,
  });
  return {
    kind: "change-request",
    change: parseChangeRequestEventContext({
      eventName: eventName === "pull_request_sync" ? "pull_request" : (eventName ?? "pull_request"),
      action: normalizeAction(hook.action),
      rawAction: hook.action,
      platform: { id: options.host, host: new URL(hook.repository.html_url).origin },
      repository: loaded.repository,
      coordinates: loaded.coordinates,
      change: loaded.change,
      workspace: options.workspace,
    }),
  };
}

function issueCommentEvent(payload: unknown, options: GiteaEventParseOptions): CodeHostEvent {
  const hook = issueCommentHookSchema.parse(payload);
  if (!hook.issue.pull_request) {
    throw new Error(`${displayName(options.host)} issue comment did not target a pull request`);
  }
  return {
    kind: "command-comment",
    comment: {
      eventName: "issue_comment",
      action: normalizeAction(hook.action),
      rawAction: hook.action,
      repository: {
        slug: hook.repository.full_name,
        url: hook.repository.html_url,
      },
      changeNumber: hook.issue.number,
      commentId: hook.comment.id,
      isChangeRequest: true,
      body: hook.comment.body,
      actor: hook.sender.login,
      workspace: options.workspace,
    },
  };
}

function giteaEventName(options: GiteaEventParseOptions): string | undefined {
  return (
    options.env.PIPR_GITEA_EVENT_NAME ??
    options.env.GITEA_EVENT_NAME ??
    options.env.FORGEJO_EVENT_NAME ??
    options.env.GITHUB_EVENT_NAME
  );
}

function normalizeAction(action: string): string {
  if (action === "open") return "opened";
  if (action === "reopen") return "reopened";
  if (action === "synchronize" || action === "synchronized") return "updated";
  return action;
}

function parseRepositorySlug(value: string): { owner: string; repository: string } {
  const parts = value.split("/");
  if (parts.length !== 2 || parts.some((part) => part.length === 0)) {
    throw new Error(`Invalid Gitea-compatible repository slug '${value}'`);
  }
  const [owner, repository] = parts;
  return { owner: owner ?? "", repository: repository ?? "" };
}

function displayName(host: GiteaFamilyHost): string {
  return host === "gitea" ? "Gitea" : host === "forgejo" ? "Forgejo" : "Codeberg";
}
