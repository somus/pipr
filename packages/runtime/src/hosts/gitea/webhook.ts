import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { CodeHostWebhookProtocol } from "../webhook.js";
import { parseWebhookJson } from "../webhook-shared.js";
import { createGiteaClient, type GiteaFamilyHost } from "./client.js";

const eventSchema = z.looseObject({
  repository: z.looseObject({
    id: z.number().int().positive(),
    full_name: z.string().min(1),
  }),
});

type ExpectedRepository = { id: number; fullName: string };

export function createGiteaWebhookProtocol(host: GiteaFamilyHost): CodeHostWebhookProtocol {
  return {
    host,
    async resolveExpectedRepository(env, repository) {
      const [owner, name] = repository.split("/");
      if (!owner || !name || repository.split("/").length !== 2) {
        throw new Error(`${displayName(host)} --repository must be OWNER/REPOSITORY`);
      }
      const resolved = await createGiteaClient({ host, env }).getRepository(owner, name);
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
  const supplied = Buffer.from(signature, "hex");
  const expected = createHmac("sha256", secret).update(payload).digest();
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

function isExpectedRepository(value: unknown): value is ExpectedRepository {
  return typeof value === "object" && value !== null && "id" in value && "fullName" in value;
}

function displayName(host: GiteaFamilyHost): string {
  return host === "gitea" ? "Gitea" : host === "forgejo" ? "Forgejo" : "Codeberg";
}
