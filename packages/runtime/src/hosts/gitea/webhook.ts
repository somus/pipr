import { z } from "zod";
import { hmacSha256HexMatches, parseWebhookJson } from "../webhook-shared.js";
import type { CodeHostWebhookProtocol } from "../webhook-types.js";
import { createGiteaClient, type GiteaFamilyHost, giteaDisplayName } from "./client.js";

const eventSchema = z.looseObject({
  repository: z.looseObject({
    id: z.number().int().positive(),
    full_name: z.string().min(1),
  }),
});

type ExpectedRepository = { id: number; fullName: string };

export function createGiteaWebhookProtocol(
  host: GiteaFamilyHost,
  fetch: (
    input: string | URL | Request,
    init?: RequestInit,
  ) => Promise<Response> = globalThis.fetch,
): CodeHostWebhookProtocol {
  return {
    host,
    async resolveExpectedRepository(env, repository) {
      const [owner, name] = repository.split("/");
      if (!owner || !name || repository.split("/").length !== 2) {
        throw new Error(`${giteaDisplayName(host)} --repository must be OWNER/REPOSITORY`);
      }
      const resolved = await createGiteaClient({ host, env }, fetch).getRepository(owner, name);
      return { id: resolved.id, fullName: resolved.full_name };
    },
    verifySecret(headers, secret, payload) {
      const signature =
        host === "gitea"
          ? (headers.get("X-Gitea-Signature") ?? headers.get("X-Forgejo-Signature"))
          : (headers.get("X-Forgejo-Signature") ?? headers.get("X-Gitea-Signature"));
      return verifySignature(payload, signature, secret);
    },
    matchesExpectedRepository(payload, expected) {
      const event = eventSchema.safeParse(parseWebhookJson(payload));
      return (
        event.success &&
        isExpectedRepository(expected) &&
        event.data.repository.id === expected.id &&
        event.data.repository.full_name === expected.fullName
      );
    },
    deliveryId(headers) {
      const id =
        host === "gitea"
          ? (headers.get("X-Gitea-Delivery") ?? headers.get("X-Forgejo-Delivery"))
          : (headers.get("X-Forgejo-Delivery") ?? headers.get("X-Gitea-Delivery"));
      return id ? `${host}:${id}` : undefined;
    },
    eventName(headers) {
      return (
        headers.get("X-Gitea-Event-Type") ??
        headers.get("X-Forgejo-Event-Type") ??
        headers.get("X-Gitea-Event") ??
        headers.get("X-Forgejo-Event") ??
        undefined
      );
    },
    runtimeEnv(eventName) {
      return eventName ? { PIPR_GITEA_EVENT_NAME: eventName } : {};
    },
  };
}

function verifySignature(payload: string, signature: string | null, secret: string): boolean {
  if (!signature || !/^[a-fA-F0-9]{64}$/.test(signature)) return false;
  return hmacSha256HexMatches(payload, signature, secret);
}

function isExpectedRepository(value: unknown): value is ExpectedRepository {
  return typeof value === "object" && value !== null && "id" in value && "fullName" in value;
}
