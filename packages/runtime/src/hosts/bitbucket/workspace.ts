import type { ChangeRequestEventContext } from "../../types.js";
import { ensureCodeHostHeadCheckout } from "../git.js";

export function ensureBitbucketHeadCheckout(options: {
  rootDir: string;
  change: ChangeRequestEventContext;
  env?: NodeJS.ProcessEnv;
}): void {
  const ref = options.change.change.head.ref;
  if (!ref) throw new Error("Bitbucket pull request source ref is required for checkout");
  const token = options.env?.BITBUCKET_API_TOKEN ?? process.env.BITBUCKET_API_TOKEN;
  const fetchEnv =
    options.change.change.isFork && token
      ? {
          ...options.env,
          GIT_CONFIG_COUNT: "1",
          GIT_CONFIG_KEY_0: "http.extraHeader",
          GIT_CONFIG_VALUE_0: `Authorization: Basic ${Buffer.from(`x-bitbucket-api-token-auth:${token}`).toString("base64")}`,
        }
      : options.env;
  ensureCodeHostHeadCheckout({
    rootDir: options.rootDir,
    headSha: options.change.change.head.sha,
    fetchRef: ref.startsWith("refs/") ? ref : `refs/heads/${ref}`,
    fetchRemote: options.change.change.isFork ? options.change.change.head.url : undefined,
    fetchEnv,
  });
}
