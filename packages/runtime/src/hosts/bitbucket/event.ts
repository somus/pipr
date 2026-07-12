import { z } from "zod";
import { positiveIntegerHostEnv, requiredHostEnv } from "../env.js";
import type { CodeHostEvent, LoadedChangeRequest } from "../types.js";
import { bitbucketRepositorySchema } from "./schema.js";

const webhookSchema = z.looseObject({
  repository: bitbucketRepositorySchema,
  pullrequest: z.looseObject({ id: z.number().int().positive() }),
  comment: z
    .looseObject({
      id: z.union([z.number(), z.string()]).transform(String),
      content: z.looseObject({ raw: z.string().default("") }),
      user: z.looseObject({ nickname: z.string().min(1) }),
      parent: z.looseObject({ id: z.union([z.number(), z.string()]).transform(String) }).optional(),
      inline: z.unknown().optional(),
    })
    .optional(),
});

export async function parseBitbucketEvent(options: {
  eventPath?: string;
  env: NodeJS.ProcessEnv;
  workspace: string;
  loadChangeRequest: (ref: {
    workspace: string;
    repository: string;
    changeNumber: number;
  }) => Promise<LoadedChangeRequest>;
}): Promise<CodeHostEvent> {
  if (!options.eventPath) {
    const workspace = requiredHostEnv(options.env, "BITBUCKET_WORKSPACE", "Bitbucket");
    const repository = requiredHostEnv(options.env, "BITBUCKET_REPO_SLUG", "Bitbucket");
    const changeNumber = positiveIntegerHostEnv(options.env, "BITBUCKET_PR_ID", "Bitbucket");
    const loaded = await options.loadChangeRequest({ workspace, repository, changeNumber });
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
  const hook = webhookSchema.parse(await Bun.file(options.eventPath).json());
  const eventKey = requiredHostEnv(options.env, "BITBUCKET_EVENT_KEY", "Bitbucket");
  if (eventKey === "pullrequest:comment_created" && hook.comment) {
    const common = {
      eventName: eventKey,
      action: "created",
      rawAction: eventKey,
      repository: { slug: hook.repository.full_name, url: hook.repository.links.html.href },
      changeNumber: hook.pullrequest.id,
      commentId: hook.comment.id,
      body: hook.comment.content.raw,
      actor: hook.comment.user.nickname,
      workspace: options.workspace,
    };
    return hook.comment.parent || hook.comment.inline
      ? {
          kind: "review-comment-reply",
          reply: { ...common, parentCommentId: hook.comment.parent?.id },
        }
      : { kind: "command-comment", comment: { ...common, isChangeRequest: true } };
  }
  const action =
    eventKey === "pullrequest:created"
      ? "opened"
      : eventKey === "pullrequest:updated"
        ? "updated"
        : ["pullrequest:fulfilled", "pullrequest:rejected", "pullrequest:superseded"].includes(
              eventKey,
            )
          ? "closed"
          : undefined;
  if (!action) throw new Error(`Unsupported Bitbucket event: ${eventKey}`);
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
