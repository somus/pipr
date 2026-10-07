import { readFile, rename, writeFile } from "node:fs/promises";
import type {
  AuthOperationOptions,
  Credential,
  CredentialInfo,
  CredentialStore,
} from "@earendil-works/pi-ai";
import { z } from "zod";

const authFileSchema = z.record(z.string(), z.looseObject({ type: z.enum(["api_key", "oauth"]) }));

/**
 * Credentials for one worker: API keys copied from the worker environment per provider, and, for local runs only, the
 * OAuth logins of a Pi `auth.json` file. Writes (OAuth refresh) go back to that file.
 */
export class AgentWorkerCredentials implements CredentialStore {
  private readonly apiKeys = new Map<string, string>();
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private readonly authFile?: string) {}

  setApiKey(providerId: string, key: string): void {
    this.apiKeys.set(providerId, key);
  }

  async read(providerId: string): Promise<Credential | undefined> {
    const key = this.apiKeys.get(providerId);
    if (key !== undefined) {
      return { type: "api_key", key };
    }
    return (await this.readAuthFile())[providerId];
  }

  async list(): Promise<readonly CredentialInfo[]> {
    const fromFile = Object.entries(await this.readAuthFile()).map(([providerId, credential]) => ({
      providerId,
      type: credential.type,
    }));
    const fromEnv = [...this.apiKeys.keys()].map((providerId) => ({
      providerId,
      type: "api_key" as const,
    }));
    return [...fromEnv, ...fromFile.filter((info) => !this.apiKeys.has(info.providerId))];
  }

  modify(
    providerId: string,
    fn: (current: Credential | undefined) => Promise<Credential | undefined>,
    _options?: AuthOperationOptions,
  ): Promise<Credential | undefined> {
    const next = this.chain.then(async () => {
      const current = await this.read(providerId);
      const updated = await fn(current);
      if (this.apiKeys.has(providerId) || !this.authFile) {
        if (updated?.type === "api_key" && updated.key !== undefined) {
          this.apiKeys.set(providerId, updated.key);
        }
        return updated;
      }
      const credentials = await this.readAuthFile();
      if (updated) {
        credentials[providerId] = updated;
      } else {
        delete credentials[providerId];
      }
      await this.writeAuthFile(credentials);
      return updated;
    });
    this.chain = next.catch(() => undefined);
    return next;
  }

  async delete(providerId: string): Promise<void> {
    await this.modify(providerId, async () => undefined);
  }

  private async readAuthFile(): Promise<Record<string, Credential>> {
    if (!this.authFile) {
      return {};
    }
    let text: string;
    try {
      text = await readFile(this.authFile, "utf8");
    } catch (error) {
      if (Reflect.get(error as object, "code") === "ENOENT") {
        return {};
      }
      throw error;
    }
    return authFileSchema.parse(JSON.parse(text)) as Record<string, Credential>;
  }

  private async writeAuthFile(credentials: Record<string, Credential>): Promise<void> {
    if (!this.authFile) {
      return;
    }
    const temporary = `${this.authFile}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(credentials, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, this.authFile);
  }
}
