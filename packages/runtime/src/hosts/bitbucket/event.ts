import { z } from "zod";
import { positiveIntegerHostEnv, requiredHostEnv } from "../env.js";
import type { CodeHostEvent, LoadedChangeRequest } from "../types.js";
import { bitbucketRepositorySchema } from "./schema.js";

const webhookSchema = z.looseObject({
  actor: z.looseObject({ nickname: z.string().min(1).optional() }),
  repository: bitbucketRepositorySchema,
  pullrequest: z.looseObject({
    id: z.number().int().positive(),
    draft: z.boolean().optional(),
  }),
  comment: z
    .looseObject({
      id: z.union([z.number(), z.string()]).transform(String),
      content: z.looseObject({ raw: z.string().default("") }),
      parent: z.looseObject({ id: z.union([z.number(), z.string()]).transform(String) }).optional(),
      inline: z.unknown().optional(),
    })
    .optional(),
});
const dataCenterWebhookSchema = z.looseObject({
  actor: z.looseObject({
    name: z.string().min(1).optional(),
    slug: z.string().min(1).optional(),
  }),
  repository: z.looseObject({
    id: z.union([z.number(), z.string()]).transform(String),
    slug: z.string().min(1),
    project: z.looseObject({ key: z.string().min(1) }),
  }),
  pullRequest: z.looseObject({
    id: z.number().int().positive(),
    draft: z.boolean().optional(),
  }),
  comment: z
    .looseObject({
      id: z.union([z.number(), z.string()]).transform(String),
      text: z.string().default(""),
      parent: z.looseObject({ id: z.union([z.number(), z.string()]).transform(String) }).optional(),
    })
    .optional(),
  commentParentId: z.union([z.number(), z.string()]).transform(String).optional(),
});
type BitbucketWebhook = z.infer<typeof webhookSchema>;
type BitbucketWebhookComment = NonNullable<BitbucketWebhook["comment"]>;

export type BitbucketEventParseOptions = {
  eventPath?: string;
  env: NodeJS.ProcessEnv;
  workspace: string;
  loadChangeRequest: (ref: {
    workspace: string;
    repository: string;
    changeNumber: number;
  }) => Promise<LoadedChangeRequest>;
};

export async function parseBitbucketEvent(
  options: BitbucketEventParseOptions,
): Promise<CodeHostEvent> {
  if (options.env.BITBUCKET_BASE_URL) return await dataCenterEvent(options);
  return options.eventPath ? await webhookEvent(options) : await pipelineEvent(options);
}

async function dataCenterEvent(options: BitbucketEventParseOptions): Promise<CodeHostEvent> {
  if (!options.eventPath) {
    throw new Error("Bitbucket Data Center requires a webhook event payload");
  }
  const hook = dataCenterWebhookSchema.parse(await Bun.file(options.eventPath).json());
  const eventKey = requiredHostEnv(options.env, "BITBUCKET_EVENT_KEY", "Bitbucket Data Center");
  const baseUrl = options.env.BITBUCKET_BASE_URL?.replace(/\/$/, "") ?? "";
  const repository = {
    slug: `${hook.repository.project.key}/${hook.repository.slug}`,
    url: `${baseUrl}/projects/${encodeURIComponent(hook.repository.project.key)}/repos/${encodeURIComponent(hook.repository.slug)}/browse`,
  };
  if (eventKey === "pr:comment:added") {
    return dataCenterCommentEvent(hook, repository, options.workspace, eventKey);
  }
  const action = dataCenterPullRequestAction(eventKey);
  if (hook.pullRequest.draft) return draftEvent();
  const loaded = await options.loadChangeRequest({
    workspace: hook.repository.project.key,
    repository: hook.repository.slug,
    changeNumber: hook.pullRequest.id,
  });
  return {
    kind: "change-request",
    change: {
      eventName: eventKey,
      action,
      rawAction: eventKey,
      platform: { id: "bitbucket", host: baseUrl },
      repository: loaded.repository,
      coordinates: loaded.coordinates,
      change: loaded.change,
      workspace: options.workspace,
    },
  };
}

function dataCenterCommentEvent(
  hook: z.infer<typeof dataCenterWebhookSchema>,
  repository: { slug: string; url: string },
  workspace: string,
  eventKey: string,
): CodeHostEvent {
  if (!hook.comment) {
    throw new Error("Bitbucket Data Center comment event payload is missing comment");
  }
  const actor = hook.actor.slug ?? hook.actor.name;
  if (!actor) throw new Error("Bitbucket Data Center comment event actor is missing a name");
  const common = {
    eventName: eventKey,
    action: "created",
    rawAction: eventKey,
    repository,
    changeNumber: hook.pullRequest.id,
    commentId: hook.comment.id,
    body: hook.comment.text,
    actor,
    workspace,
  };
  const parentCommentId = hook.comment.parent?.id ?? hook.commentParentId;
  return parentCommentId
    ? { kind: "review-comment-reply", reply: { ...common, parentCommentId } }
    : { kind: "command-comment", comment: { ...common, isChangeRequest: true } };
}

async function pipelineEvent(options: BitbucketEventParseOptions): Promise<CodeHostEvent> {
  const workspace = requiredHostEnv(options.env, "BITBUCKET_WORKSPACE", "Bitbucket");
  const repository = requiredHostEnv(options.env, "BITBUCKET_REPO_SLUG", "Bitbucket");
  const changeNumber = positiveIntegerHostEnv(options.env, "BITBUCKET_PR_ID", "Bitbucket");
  const loaded = await options.loadChangeRequest({ workspace, repository, changeNumber });
  if (loaded.change.isDraft) return draftEvent();
  return {
    kind: "change-request",
    change: {
      eventName: "bitbucket_pipeline",
      action: options.env.PIPR_CHANGE_ACTION ?? "updated",
      rawAction: options.env.PIPR_CHANGE_ACTION,
      platform: { id: "bitbucket", host: "https://bitbucket.org" },
      repository: loaded.repository,
      coordinates: loaded.coordinates,
      change: loaded.change,
      workspace: options.workspace,
    },
  };
}

async function webhookEvent(options: BitbucketEventParseOptions): Promise<CodeHostEvent> {
  const hook = webhookSchema.parse(await Bun.file(options.eventPath ?? "").json());
  const eventKey = requiredHostEnv(options.env, "BITBUCKET_EVENT_KEY", "Bitbucket");
  if (eventKey === "pullrequest:comment_created") {
    if (!hook.comment) throw new Error("Bitbucket comment event payload is missing comment");
    return commentEvent(hook, hook.comment, eventKey, options.workspace);
  }
  return await pullRequestEvent(options, hook, eventKey);
}

function commentEvent(
  hook: BitbucketWebhook,
  comment: BitbucketWebhookComment,
  eventKey: string,
  workspace: string,
): CodeHostEvent {
  if (!hook.actor.nickname) throw new Error("Bitbucket comment event actor is missing a nickname");
  const common = {
    eventName: eventKey,
    action: "created",
    rawAction: eventKey,
    repository: { slug: hook.repository.full_name, url: hook.repository.links.html.href },
    changeNumber: hook.pullrequest.id,
    commentId: comment.id,
    body: comment.content.raw,
    actor: hook.actor.nickname,
    workspace,
  };
  return comment.parent
    ? {
        kind: "review-comment-reply",
        reply: { ...common, parentCommentId: comment.parent.id },
      }
    : { kind: "command-comment", comment: { ...common, isChangeRequest: true } };
}

async function pullRequestEvent(
  options: BitbucketEventParseOptions,
  hook: BitbucketWebhook,
  eventKey: string,
): Promise<CodeHostEvent> {
  const action = pullRequestAction(eventKey);
  if (hook.pullrequest.draft) return draftEvent();
  const loaded = await options.loadChangeRequest({
    workspace: hook.repository.full_name.split("/")[0] ?? "",
    repository: hook.repository.slug,
    changeNumber: hook.pullrequest.id,
  });
  return {
    kind: "change-request",
    change: {
      eventName: eventKey,
      action,
      rawAction: eventKey,
      platform: { id: "bitbucket", host: "https://bitbucket.org" },
      repository: loaded.repository,
      coordinates: loaded.coordinates,
      change: loaded.change,
      workspace: options.workspace,
    },
  };
}

function pullRequestAction(eventKey: string): "opened" | "updated" | "closed" {
  if (eventKey === "pullrequest:created") return "opened";
  if (eventKey === "pullrequest:updated") return "updated";
  if (
    ["pullrequest:fulfilled", "pullrequest:rejected", "pullrequest:superseded"].includes(eventKey)
  )
    return "closed";
  throw new Error(`Unsupported Bitbucket event: ${eventKey}`);
}

function dataCenterPullRequestAction(eventKey: string): "opened" | "updated" | "closed" {
  if (eventKey === "pr:opened") return "opened";
  if (eventKey === "pr:from_ref_updated" || eventKey === "pr:modified") return "updated";
  if (eventKey === "pr:merged" || eventKey === "pr:declined" || eventKey === "pr:deleted") {
    return "closed";
  }
  throw new Error(`Unsupported Bitbucket Data Center event: ${eventKey}`);
}

function draftEvent(): CodeHostEvent {
  return { kind: "ignored", reason: "pull request is a draft" };
}
