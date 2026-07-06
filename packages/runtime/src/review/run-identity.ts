import type { CommandContext } from "@usepipr/sdk";
import type { ChangeRequestEventContext } from "../types.js";

export type RuntimeCommandInvocation = Pick<CommandContext, "name" | "line" | "arguments"> & {
  sourceCommentId?: number;
};

export function stableReviewRunId(options: {
  event: ChangeRequestEventContext;
  selectedTasks: string[];
  trustedConfigSha?: string;
  trustedConfigHash?: string;
  commandInvocation?: RuntimeCommandInvocation;
  verifierInvocation?: { mode: "user-reply"; commentId: number; parentCommentId: number };
}): string {
  const hash = new Bun.CryptoHasher("sha256")
    .update(
      JSON.stringify({
        platform: options.event.platform.id,
        repository: options.event.repository.slug,
        changeNumber: options.event.change.number,
        baseSha: options.event.change.base.sha,
        headSha: options.event.change.head.sha,
        trustedConfigHash: options.trustedConfigHash,
        trustedConfigSha: options.trustedConfigSha,
        selectedTasks: options.selectedTasks,
        command: options.commandInvocation
          ? {
              name: options.commandInvocation.name,
              line: options.commandInvocation.line,
              arguments: sortedCommandArguments(options.commandInvocation.arguments),
              sourceCommentId: options.commandInvocation.sourceCommentId,
            }
          : undefined,
        verifier: options.verifierInvocation,
      }),
    )
    .digest("hex")
    .slice(0, 24);
  return `pipr-${hash}`;
}

function sortedCommandArguments(arguments_: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(arguments_).sort(([left], [right]) => left.localeCompare(right)),
  );
}
