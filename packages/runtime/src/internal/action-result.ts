import type { HostRunCommandResult } from "../host-run/types.js";

export type GitHubActionResultPresenter = {
  info(message: string): void | Promise<void>;
  warning(message: string): void | Promise<void>;
  setOutput(name: string, value: string): void | Promise<void>;
};

export async function presentGitHubActionResult(
  result: HostRunCommandResult,
  presenter: GitHubActionResultPresenter,
): Promise<void> {
  if (result.kind === "ignored") {
    await presenter.info(`pipr ignored event: ${result.reason}`);
    return;
  }

  await presenter.info(
    `pipr loaded change #${result.event.change.number} for ${result.event.repository.slug}`,
  );
  await presenter.info(`pipr config source: ${result.configSource}`);

  switch (result.kind) {
    case "dry-run":
      await presenter.info(
        "PIPR_DRY_RUN=1; stopping before review runtime, model, or GitHub publishing calls",
      );
      return;
    case "command-help":
      await presenter.info(`pipr command help: ${result.reason}`);
      await presenter.setOutput("main-comment", result.body);
      return;
    case "command-response":
      await presenter.info(
        `pipr command '${result.command}' published response comment (${result.publication.action})`,
      );
      await presenter.setOutput("main-comment", result.response.body);
      await presenter.setOutput("publication", JSON.stringify(result.publication));
      return;
    case "verifier":
      await presenter.info(
        `pipr verifier processed review comment reply with ${result.errors.length} publication error(s)`,
      );
      await warnInlineResolutionErrors(result.errors, presenter);
      await presenter.setOutput(
        "publication",
        JSON.stringify({ inlineResolutionErrors: result.errors }),
      );
      return;
    case "review":
      await presenter.info(
        `pipr review produced ${result.review.validated.validFindings.length} valid inline finding(s), ` +
          `${result.review.validated.droppedFindings.length} dropped finding(s)`,
      );
      await presenter.info(
        `pipr published main comment (${result.publication.mainComment.action}) and ` +
          `${result.publication.inlineComments.posted} inline comment(s); ` +
          `${result.publication.inlineComments.skipped} skipped`,
      );
      await warnInlineResolutionErrors(
        result.publication.metadata.inlineResolutionErrors,
        presenter,
      );
      if (result.review.repairAttempted) {
        await presenter.info("pipr repaired reviewer JSON once before validation");
      }
      await presenter.setOutput("main-comment", result.review.mainComment);
      await presenter.setOutput(
        "inline-comments",
        JSON.stringify(result.review.inlineCommentDrafts),
      );
      await presenter.setOutput(
        "dropped-findings",
        JSON.stringify(result.review.validated.droppedFindings),
      );
      await presenter.setOutput("publication", JSON.stringify(result.publication));
      return;
    default:
      result satisfies never;
  }
}

async function warnInlineResolutionErrors(
  errors: readonly string[],
  presenter: GitHubActionResultPresenter,
): Promise<void> {
  for (const error of errors) {
    await presenter.warning(`pipr inline resolution failed: ${error}`);
  }
}
