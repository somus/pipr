import type { ChangeRequestEventContext } from "../../types.js";
import { ensureCodeHostHeadCheckout } from "../git.js";

export function ensureBitbucketHeadCheckout(options: {
  rootDir: string;
  change: ChangeRequestEventContext;
  env?: NodeJS.ProcessEnv;
}): Promise<void> {
  const ref = options.change.change.head.ref;
  if (!ref) throw new Error("Bitbucket pull request source ref is required for checkout");
  const env = options.env ?? process.env;
  const dataCenter = Boolean(env.BITBUCKET_BASE_URL);
  const token = dataCenter ? env.BITBUCKET_TOKEN : env.BITBUCKET_API_TOKEN;
  const fetchEnv =
    options.change.change.isFork && token
      ? {
          ...env,
          GIT_CONFIG_COUNT: "1",
          GIT_CONFIG_KEY_0: "http.extraHeader",
          GIT_CONFIG_VALUE_0: dataCenter
            ? `Authorization: Bearer ${token}`
            : `Authorization: Basic ${Buffer.from(`x-bitbucket-api-token-auth:${token}`).toString("base64")}`,
        }
      : env;
  return ensureCodeHostHeadCheckout({
    rootDir: options.rootDir,
    headSha: options.change.change.head.sha,
    fetchRef: ref.startsWith("refs/") ? ref : `refs/heads/${ref}`,
    fetchRemote: options.change.change.isFork ? options.change.change.head.url : undefined,
    fetchEnv,
  });
}
