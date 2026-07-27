import type { ChangeRequestEventContext } from "../../types.js";
import { ensureCodeHostHeadCheckout } from "../git.js";

export function ensureGiteaHeadCheckout(options: {
  rootDir: string;
  change: ChangeRequestEventContext;
}): Promise<void> {
  return ensureCodeHostHeadCheckout({
    rootDir: options.rootDir,
    headSha: options.change.change.head.sha,
    fetchRef: `refs/pull/${options.change.change.number}/head`,
  });
}
