import { z } from "zod";
import type { LoadedChangeRequest, RepositoryPermission } from "../types.js";
import { bitbucketRepositorySchema } from "./schema.js";

export const userSchema = z.looseObject({
  uuid: z.string().optional(),
  nickname: z.string().optional(),
  display_name: z.string().optional(),
});

const endpointSchema = z.looseObject({
  branch: z.looseObject({ name: z.string().min(1) }),
  commit: z.looseObject({ hash: z.string().min(1) }),
  repository: bitbucketRepositorySchema,
});

export const pullRequestBaseSchema = z.looseObject({
  id: z.number().int().positive(),
  draft: z.boolean().optional(),
  title: z.string(),
  description: z.string().default(""),
});

export const pullRequestSchema = pullRequestBaseSchema.extend({
  author: userSchema.optional(),
  source: endpointSchema,
  destination: endpointSchema,
  links: z.looseObject({ html: z.looseObject({ href: z.string().url() }) }),
});

const inlineSchema = z.looseObject({
  path: z.string().optional(),
  src_path: z.string().optional(),
  from: z.number().int().nullable().optional(),
  to: z.number().int().nullable().optional(),
  start_from: z.number().int().nullable().optional(),
  start_to: z.number().int().nullable().optional(),
});

export const commentSchema = z.looseObject({
  id: z.union([z.number(), z.string()]).transform(String),
  content: z.looseObject({ raw: z.string().default("") }),
  user: userSchema.optional(),
  parent: z.looseObject({ id: z.union([z.number(), z.string()]).transform(String) }).optional(),
  inline: inlineSchema.optional(),
  deleted: z.boolean().optional(),
  resolution: z.looseObject({}).optional(),
});

export type BitbucketPullRequest = z.infer<typeof pullRequestSchema>;
export type BitbucketComment = z.infer<typeof commentSchema>;

/** Inline anchor Pipr sends when creating a Bitbucket inline comment. */
export type BitbucketInlineRequest = {
  path: string;
  src_path?: string;
  from?: number;
  to?: number;
  start_from?: number;
  start_to?: number;
};

export type BitbucketCommentRequest = {
  content: { raw: string };
  inline?: BitbucketInlineRequest;
};

export function positiveCommentId(value: string): number {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw new Error("Bitbucket comment ID must be a positive integer");
  }
  return id;
}

export type BitbucketClient = {
  deployment: "cloud" | "data-center";
  workspace: string;
  repository: string;
  currentUser(): Promise<{ uuid?: string; nickname?: string; displayName?: string }>;
  getRepository(): Promise<{ uuid: string; slug: string; fullName: string; url: string }>;
  getRepositoryPermission(actor: string, repositoryUuid: string): Promise<RepositoryPermission>;
  getPullRequest(changeNumber: number): Promise<BitbucketPullRequest>;
  loadChange(options: {
    workspace: string;
    repository: string;
    changeNumber: number;
  }): Promise<LoadedChangeRequest>;
  listComments(changeNumber: number): Promise<BitbucketComment[]>;
  createComment(changeNumber: number, body: BitbucketCommentRequest): Promise<BitbucketComment>;
  updateComment(
    changeNumber: number,
    commentId: string,
    content: string,
  ): Promise<BitbucketComment>;
  replyToComment(
    changeNumber: number,
    commentId: string,
    content: string,
  ): Promise<BitbucketComment>;
  resolveComment(changeNumber: number, commentId: string): Promise<void>;
  setStatus(sha: string, key: string, body: Record<string, unknown>): Promise<string>;
};
