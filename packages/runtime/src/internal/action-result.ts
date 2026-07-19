import type { HostRunCommandResult } from "../host-run/types.js";
import type { PublicationError } from "../review/publication-result.js";
import { stripPiprMainCommentMarkers, toPiprErrorResult, toPiprResult } from "./pipr-result.js";

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
    await setResultOutput(result, presenter);
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
      break;
    case "command-help":
      await presenter.info(`pipr command help: ${result.reason}`);
      await presenter.setOutput("main-comment", result.body);
      break;
    case "command-response":
      await presenter.info(
        `pipr command '${result.command}' published response comment (${result.publication.action})`,
      );
      await presenter.setOutput("main-comment", result.response.body);
      break;
    case "verifier":
      await presenter.info(
        `pipr verifier processed review comment reply with ${result.errors.length} publication error(s)`,
      );
      await warnInlineResolutionErrors(result.errors, presenter);
      break;
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
      await presenter.setOutput(
        "main-comment",
        stripPiprMainCommentMarkers(result.review.mainComment),
      );
      break;
    default:
      result satisfies never;
  }

  await setResultOutput(result, presenter);
}

export async function presentGitHubActionPublicationError(
  error: PublicationError,
  presenter: GitHubActionResultPresenter,
): Promise<void> {
  await presenter.setOutput(
    "result",
    JSON.stringify(
      toPiprResult({
        source: "host",
        result: { kind: "publication-error", publication: error.result },
      }),
    ),
  );
}

export async function presentGitHubActionError(
  presenter: GitHubActionResultPresenter,
): Promise<void> {
  await presenter.setOutput("result", JSON.stringify(toPiprErrorResult(undefined)));
}

async function setResultOutput(
  result: HostRunCommandResult,
  presenter: GitHubActionResultPresenter,
): Promise<void> {
  await presenter.setOutput("result", JSON.stringify(toPiprResult({ source: "host", result })));
}

async function warnInlineResolutionErrors(
  errors: readonly string[],
  presenter: GitHubActionResultPresenter,
): Promise<void> {
  for (const error of errors) {
    await presenter.warning(`pipr inline resolution failed: ${error}`);
  }
}
