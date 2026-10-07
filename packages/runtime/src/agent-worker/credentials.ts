import { readFile, rename, writeFile } from "node:fs/promises";
import type { Credential, CredentialStore } from "@earendil-works/pi-ai";
import { z } from "zod";

const authFileSchema = z.record(z.string(), z.looseObject({ type: z.enum(["api_key", "oauth"]) }));

export type AgentWorkerCredentials = CredentialStore & {
  setApiKey(providerId: string, key: string): void;
};

/**
 * Credentials for one worker: API keys copied from the worker environment per provider, and, for local runs only, the
 * OAuth logins of a Pi `auth.json` file. Writes (OAuth refresh) go back to that file.
 */
export function createAgentWorkerCredentials(authFile?: string): AgentWorkerCredentials {
  const apiKeys = new Map<string, string>();
  let chain: Promise<unknown> = Promise.resolve();

  const readAuthFile = async (): Promise<Record<string, Credential>> => {
    if (!authFile) {
      return {};
    }
    let text: string;
    try {
      text = await readFile(authFile, "utf8");
    } catch (error) {
      if (Reflect.get(error as object, "code") === "ENOENT") {
        return {};
      }
      throw error;
    }
    return authFileSchema.parse(JSON.parse(text)) as Record<string, Credential>;
  };

  const writeAuthFile = async (file: string, credentials: Record<string, Credential>) => {
    const temporary = `${file}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(credentials, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, file);
  };

  const read = async (providerId: string): Promise<Credential | undefined> => {
    const key = apiKeys.get(providerId);
    if (key !== undefined) {
      return { type: "api_key", key };
    }
    return (await readAuthFile())[providerId];
  };

  const modify: CredentialStore["modify"] = (providerId, fn) => {
    const next = chain.then(async () => {
      const updated = await fn(await read(providerId));
      if (apiKeys.has(providerId) || !authFile) {
        if (updated?.type === "api_key" && updated.key !== undefined) {
          apiKeys.set(providerId, updated.key);
        }
        return updated;
      }
      const credentials = await readAuthFile();
      if (updated) {
        credentials[providerId] = updated;
      } else {
        delete credentials[providerId];
      }
      await writeAuthFile(authFile, credentials);
      return updated;
    });
    chain = next.catch(() => undefined);
    return next;
  };

  return {
    setApiKey(providerId, key) {
      apiKeys.set(providerId, key);
    },
    read,
    async list() {
      const fromFile = Object.entries(await readAuthFile()).map(([providerId, credential]) => ({
        providerId,
        type: credential.type,
      }));
      const fromEnv = [...apiKeys.keys()].map((providerId) => ({
        providerId,
        type: "api_key" as const,
      }));
      return [...fromEnv, ...fromFile.filter((info) => !apiKeys.has(info.providerId))];
    },
    modify,
    async delete(providerId) {
      await modify(providerId, async () => undefined);
    },
  };
}
