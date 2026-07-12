import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { CodeHostWebhookProtocol } from "../webhook.js";
import { parseWebhookJson } from "../webhook-shared.js";
import { createBitbucketClient } from "./client.js";

const eventSchema = z.looseObject({
  repository: z.looseObject({ uuid: z.string().min(1), full_name: z.string().min(1) }),
  pullrequest: z.looseObject({ id: z.number().int().positive() }),
});

export function createBitbucketWebhookProtocol(): CodeHostWebhookProtocol {
  return {
    host: "bitbucket",
    async resolveExpectedRepository(env, expectedRepository) {
      const client = createBitbucketClient(env);
      if (expectedRepository !== client.repository)
        throw new Error(
          `Bitbucket --repository '${expectedRepository}' does not match BITBUCKET_REPO_SLUG '${client.repository}'`,
        );
      const repository = await client.getRepository();
      return { uuid: repository.uuid, fullName: repository.fullName };
    },
    verifySecret(headers, secret, payload) {
      return verifyBitbucketSignature(payload, headers.get("X-Hub-Signature"), secret);
    },
    matchesExpectedRepository(payload, expected) {
      const event = eventSchema.safeParse(parseWebhookJson(payload));
      return (
        event.success &&
        typeof expected === "object" &&
        expected !== null &&
        "uuid" in expected &&
        "fullName" in expected &&
        event.data.repository.uuid === expected.uuid &&
        event.data.repository.full_name === expected.fullName
      );
    },
    deliveryId(headers, payload) {
      const request = headers.get("X-Request-UUID");
      const hook = headers.get("X-Hook-UUID");
      if (!request || !hook) return undefined;
      const digest = createHmac("sha256", hook).update(payload).digest("hex").slice(0, 16);
      return `bitbucket:${hook}:${request}:${digest}`;
    },
    eventName(headers) {
      return headers.get("X-Event-Key") ?? undefined;
    },
    runtimeEnv(eventName) {
      return eventName ? { BITBUCKET_EVENT_KEY: eventName } : {};
    },
  };
}

function verifyBitbucketSignature(payload: string, signature: string | null, secret: string) {
  if (!signature?.startsWith("sha256=")) return false;
  const supplied = Buffer.from(signature.slice(7), "hex");
  const expected = createHmac("sha256", secret).update(payload).digest();
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}
