import type { ChangeRequestEventContext } from "../../types.js";
import { ensureCodeHostHeadCheckout } from "../git.js";

export function ensureAzureDevOpsHeadCheckout(options: {
  rootDir: string;
  change: ChangeRequestEventContext;
}): Promise<void> {
  const headRef = options.change.change.head.ref;
  if (!headRef) throw new Error("Azure DevOps pull request source ref is required for checkout");
  return ensureCodeHostHeadCheckout({
    rootDir: options.rootDir,
    headSha: options.change.change.head.sha,
    fetchRef: headRef.startsWith("refs/") ? headRef : `refs/heads/${headRef}`,
    fetchRemote: options.change.change.isFork ? options.change.change.head.url : undefined,
  });
}
