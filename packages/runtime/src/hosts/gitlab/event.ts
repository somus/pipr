import { z } from "zod";
import { parseChangeRequestEventContext } from "../../types.js";
import type { CodeHostEvent, HostEventParseOptions, LoadedChangeRequest } from "../types.js";

const projectSchema = z.looseObject({
  id: z.union([z.number(), z.string()]),
  path_with_namespace: z.string().min(1),
  web_url: z.string().url().optional(),
});

const mergeRequestHookSchema = z.looseObject({
  object_kind: z.literal("merge_request"),
  project: projectSchema,
  object_attributes: z.looseObject({
    iid: z.number().int().positive(),
    action: z.string().optional(),
    draft: z.boolean().optional(),
  }),
  changes: z
    .looseObject({
      draft: z.looseObject({ previous: z.boolean(), current: z.boolean() }).optional(),
    })
    .optional(),
});

const noteHookSchema = z.looseObject({
  object_kind: z.literal("note"),
  project: projectSchema,
  merge_request: z.looseObject({ iid: z.number().int().positive() }),
  user: z.looseObject({ username: z.string().min(1) }),
  object_attributes: z.looseObject({
    id: z.union([z.number(), z.string()]),
    note: z.string(),
    action: z.string().optional(),
    noteable_type: z.string(),
    discussion_id: z.string().min(1).optional(),
  }),
});

export type GitLabEventParseOptions = HostEventParseOptions & {
  loadChangeRequest?: (ref: {
    projectId: string;
    projectPath: string;
    changeNumber: number;
  }) => Promise<LoadedChangeRequest>;
  resolveReplyParent?: (ref: {
    projectId: string;
    changeNumber: number;
    noteId: string;
    discussionId?: string;
  }) => Promise<string | undefined>;
};

export async function parseGitLabEvent(options: GitLabEventParseOptions): Promise<CodeHostEvent> {
  if (!options.eventPath) {
    return await pipelineEvent(options);
  }
  const payload: unknown = await Bun.file(options.eventPath).json();
  if (isObjectKind(payload, "merge_request")) {
    return await mergeRequestEvent(payload, options);
  }
  if (isObjectKind(payload, "note")) {
    return await noteEvent(payload, options);
  }
  throw new Error("Unsupported GitLab event payload");
}

async function pipelineEvent(options: GitLabEventParseOptions): Promise<CodeHostEvent> {
  const projectId = requiredEnv(options.env, "CI_PROJECT_ID");
  const projectPath = requiredEnv(options.env, "CI_PROJECT_PATH");
  const changeNumber = positiveIntegerEnv(options.env, "CI_MERGE_REQUEST_IID");
  const loaded = await loadChange(options, { projectId, projectPath, changeNumber });
  if (loaded.change.isDraft) {
    return { kind: "ignored", reason: "merge request is a draft" };
  }
  return {
    kind: "change-request",
    change: parseChangeRequestEventContext({
      eventName: "gitlab_pipeline",
      action: options.env.PIPR_CHANGE_ACTION ?? "updated",
      rawAction: options.env.PIPR_CHANGE_ACTION,
      platform: { id: "gitlab", host: options.env.CI_SERVER_URL ?? "https://gitlab.com" },
      repository: loaded.repository,
      coordinates: loaded.coordinates,
      change: loaded.change,
      workspace: options.workspace,
    }),
  };
}

async function mergeRequestEvent(
  payload: unknown,
  options: GitLabEventParseOptions,
): Promise<CodeHostEvent> {
  const hook = mergeRequestHookSchema.parse(payload);
  const becameReady =
    hook.changes?.draft?.previous === true && hook.changes.draft.current === false;
  if (hook.object_attributes.draft === true && !becameReady) {
    return { kind: "ignored", reason: "merge request is a draft" };
  }
  const loaded = await loadChange(options, {
    projectId: String(hook.project.id),
    projectPath: hook.project.path_with_namespace,
    changeNumber: hook.object_attributes.iid,
  });
  return {
    kind: "change-request",
    change: parseChangeRequestEventContext({
      eventName: "merge_request",
      action: normalizeMergeRequestAction(hook.object_attributes.action, hook.changes?.draft),
      rawAction: hook.object_attributes.action,
      platform: { id: "gitlab", host: gitLabHost(hook.project.web_url) },
      repository: loaded.repository,
      coordinates: loaded.coordinates,
      change: loaded.change,
      workspace: options.workspace,
    }),
  };
}

async function noteEvent(
  payload: unknown,
  options: GitLabEventParseOptions,
): Promise<CodeHostEvent> {
  const hook = noteHookSchema.parse(payload);
  if (hook.object_attributes.noteable_type !== "MergeRequest") {
    throw new Error("GitLab note did not target a merge request");
  }
  const common = {
    eventName: "note",
    action: hook.object_attributes.action === "create" ? "created" : hook.object_attributes.action,
    rawAction: hook.object_attributes.action,
    repository: { slug: hook.project.path_with_namespace, url: hook.project.web_url },
    changeNumber: hook.merge_request.iid,
    commentId: String(hook.object_attributes.id),
    body: hook.object_attributes.note,
    actor: hook.user.username,
    workspace: options.workspace,
  };
  const parentCommentId = await options.resolveReplyParent?.({
    projectId: String(hook.project.id),
    changeNumber: hook.merge_request.iid,
    noteId: String(hook.object_attributes.id),
    discussionId: hook.object_attributes.discussion_id,
  });
  return parentCommentId
    ? { kind: "review-comment-reply", reply: { ...common, parentCommentId } }
    : { kind: "command-comment", comment: { ...common, isChangeRequest: true } };
}

async function loadChange(
  options: GitLabEventParseOptions,
  ref: { projectId: string; projectPath: string; changeNumber: number },
): Promise<LoadedChangeRequest> {
  if (!options.loadChangeRequest) {
    throw new Error("GitLab merge request events require an API-backed change loader");
  }
  return await options.loadChangeRequest(ref);
}

function normalizeMergeRequestAction(
  action: string | undefined,
  draftChange?: { previous: boolean; current: boolean },
): string | undefined {
  if (action === "update" && draftChange?.previous === true && draftChange.current === false) {
    return "ready";
  }
  return action ? (gitLabMergeRequestActions[action] ?? action) : undefined;
}

const gitLabMergeRequestActions: Readonly<Record<string, string>> = {
  open: "opened",
  reopen: "reopened",
  update: "updated",
  approved: "updated",
  unapproved: "updated",
  close: "closed",
  merge: "closed",
};

function isObjectKind(value: unknown, kind: string): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    "object_kind" in value &&
    value.object_kind === kind
  );
}

function requiredEnv(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value) {
    throw new Error(`${name} is required for GitLab pipeline events`);
  }
  return value;
}

function positiveIntegerEnv(env: NodeJS.ProcessEnv, name: string): number {
  const value = Number(requiredEnv(env, name));
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

function gitLabHost(projectUrl: string | undefined): string {
  return projectUrl ? new URL(projectUrl).origin : "https://gitlab.com";
}
