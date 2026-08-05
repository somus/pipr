import type { ChangeRequestEventContext } from "../../types.js";
import { ensureCodeHostHeadCheckout } from "../git.js";
import { trustedBitbucketDataCenterBaseUrl } from "./base-url.js";

const BITBUCKET_CLOUD_BASE_URL = "https://bitbucket.org/";

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
  const forkRemote = options.change.change.isFork
    ? trustedForkRemote(options.change.change.head.url, env.BITBUCKET_BASE_URL)
    : undefined;
  const fetchEnv =
    forkRemote && token
      ? {
          ...env,
          GIT_CONFIG_COUNT: "1",
          GIT_CONFIG_KEY_0: `http.${forkRemote.baseUrl}.extraHeader`,
          GIT_CONFIG_VALUE_0: dataCenter
            ? `Authorization: Bearer ${token}`
            : `Authorization: Basic ${Buffer.from(`x-bitbucket-api-token-auth:${token}`).toString("base64")}`,
        }
      : env;
  return ensureCodeHostHeadCheckout({
    rootDir: options.rootDir,
    headSha: options.change.change.head.sha,
    fetchRef: ref.startsWith("refs/") ? ref : `refs/heads/${ref}`,
    fetchRemote: forkRemote?.remote,
    fetchEnv,
  });
}

function trustedForkRemote(
  value: string | undefined,
  dataCenterBaseUrl: string | undefined,
): { baseUrl: string; remote: string } {
  const deployment = dataCenterBaseUrl ? "Data Center" : "Cloud";
  const remote = parseForkRemote(value, deployment);
  if (!isCredentialSafeHttpsUrl(remote)) throw untrustedForkRemote(deployment);

  const baseUrl = dataCenterBaseUrl
    ? trustedBitbucketDataCenterBaseUrl(dataCenterBaseUrl)
    : BITBUCKET_CLOUD_BASE_URL;
  if (!isWithinBaseUrl(remote, new URL(baseUrl))) throw untrustedForkRemote(deployment);
  return { baseUrl, remote: remote.href };
}

function parseForkRemote(value: string | undefined, deployment: string): URL {
  if (!value) throw untrustedForkRemote(deployment);
  try {
    return new URL(value);
  } catch {
    throw untrustedForkRemote(deployment);
  }
}

function isCredentialSafeHttpsUrl(url: URL): boolean {
  return [url.protocol === "https:", !url.username, !url.password, !url.search, !url.hash].every(
    Boolean,
  );
}

function isWithinBaseUrl(remote: URL, base: URL): boolean {
  if (remote.origin !== base.origin || !remote.pathname.startsWith(base.pathname)) return false;
  const relativePath = remote.pathname.slice(base.pathname.length);
  return relativePath.split("/").some(Boolean);
}

function untrustedForkRemote(deployment: string): Error {
  return new Error(`Bitbucket ${deployment} fork URL must stay inside its trusted base URL`);
}
