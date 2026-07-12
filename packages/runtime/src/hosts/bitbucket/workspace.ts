import type { ChangeRequestEventContext } from "../../types.js";
import { ensureCodeHostHeadCheckout } from "../git.js";

export function ensureBitbucketHeadCheckout(options: {
  rootDir: string;
  change: ChangeRequestEventContext;
}): void {
  const ref = options.change.change.head.ref;
  if (!ref) throw new Error("Bitbucket pull request source ref is required for checkout");
  ensureCodeHostHeadCheckout({
    rootDir: options.rootDir,
    headSha: options.change.change.head.sha,
    fetchRef: ref.startsWith("refs/") ? ref : `refs/heads/${ref}`,
    fetchRemote: options.change.change.isFork ? options.change.change.head.url : undefined,
  });
}
