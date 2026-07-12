import type { ChangeRequestEventContext } from "../../types.js";
import { ensureCodeHostHeadCheckout } from "../git.js";

export function ensureGitLabHeadCheckout(options: {
  rootDir: string;
  change: ChangeRequestEventContext;
}): void {
  ensureCodeHostHeadCheckout({
    rootDir: options.rootDir,
    headSha: options.change.change.head.sha,
    fetchRef: `refs/merge-requests/${options.change.change.number}/head`,
  });
}
