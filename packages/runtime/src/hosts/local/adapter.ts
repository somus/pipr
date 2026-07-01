import type { ChangeRequestEventContext } from "../../types.js";
import { parseChangeRequestEventContext } from "../../types.js";

export function createLocalChangeRequestEvent(options: {
  rootDir: string;
  baseSha: string;
  headSha: string;
}): ChangeRequestEventContext {
  return parseChangeRequestEventContext({
    eventName: "local",
    action: "updated",
    platform: { id: "local" },
    repository: { slug: "local/repository" },
    change: {
      number: 1,
      title: "Local change",
      description: "",
      base: { sha: options.baseSha },
      head: { sha: options.headSha },
    },
    workspace: options.rootDir,
  });
}
