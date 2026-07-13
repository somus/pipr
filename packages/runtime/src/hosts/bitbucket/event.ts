import { z } from "zod";
import { positiveIntegerHostEnv, requiredHostEnv } from "../env.js";
import type { CodeHostEvent, LoadedChangeRequest } from "../types.js";
import { bitbucketRepositorySchema } from "./schema.js";

const webhookSchema = z.looseObject({
  actor: z.looseObject({ nickname: z.string().min(1) }),
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
  return options.eventPath ? await webhookEvent(options) : await pipelineEvent(options);
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
        reply: { ...common, parentCommentId: comment.parent?.id },
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

function draftEvent(): CodeHostEvent {
  return { kind: "ignored", reason: "pull request is a draft" };
}
