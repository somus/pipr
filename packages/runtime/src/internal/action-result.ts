import type { HostRunCommandResult } from "../host-run/types.js";
import { mainCommentFooterHiddenMarker } from "../review/comment-branding.js";
import { parseGeneratedMainCommentEnvelope } from "../review/main-comment-envelope.js";
import type { PublicationError } from "../review/publication-result.js";

export type GitHubActionResultPresenter = {
  info(message: string): void | Promise<void>;
  warning(message: string): void | Promise<void>;
  setOutput(name: string, value: string): void | Promise<void>;
};

type ReviewResult = Extract<HostRunCommandResult, { kind: "review" }>;
type PublicFinding = ReviewResult["review"]["validated"]["validFindings"][number];
type DroppedFinding = ReviewResult["review"]["validated"]["droppedFindings"][number];
type TaskCheck = ReviewResult["review"]["taskChecks"][number];
type InlineCommentCounts = ReviewResult["publication"]["inlineComments"];

const genericFailureMessage = "Pipr failed; see the Action log for details.";
const publicationFailureMessage =
  "Pipr could not complete publication; see the Action log for details.";

type ReviewPublicationJsonV1 = {
  mainComment: { action: "created" | "updated" };
  inlineComments: InlineCommentCounts;
  inlinePublicationErrorCount: number;
  inlineResolutionErrorCount: number;
};

type PartialPublicationJsonV1 = {
  inlineComments: InlineCommentCounts;
  inlinePublicationErrorCount: number;
  inlineResolutionErrorCount: number;
};

export type GitHubActionJsonResultV1 =
  | { formatVersion: 1; kind: "ignored"; reason: string }
  | { formatVersion: 1; kind: "dry-run" }
  | { formatVersion: 1; kind: "error"; message: string }
  | { formatVersion: 1; kind: "command-help"; reason: string; mainComment: string }
  | {
      formatVersion: 1;
      kind: "command-response";
      mainComment: string;
      publication: { action: "created" | "updated" };
    }
  | {
      formatVersion: 1;
      kind: "verifier";
      publication: { inlineResolutionErrorCount: number };
    }
  | {
      formatVersion: 1;
      kind: "review";
      mainComment: string;
      inlineFindings: PublicFinding[];
      droppedFindings: DroppedFinding[];
      taskChecks: TaskCheck[];
      providerModels: string[];
      repairAttempted: boolean;
      publication: ReviewPublicationJsonV1;
    }
  | {
      formatVersion: 1;
      kind: "publication-error";
      message: string;
      publication?: PartialPublicationJsonV1;
    };

type GitHubActionJsonInput =
  | HostRunCommandResult
  | { kind: "error" }
  | {
      kind: "publication-error";
      publication: PublicationError["result"];
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
  await setResultOutput({ kind: "publication-error", publication: error.result }, presenter);
}

export async function presentGitHubActionError(
  presenter: GitHubActionResultPresenter,
): Promise<void> {
  await setResultOutput({ kind: "error" }, presenter);
}

function serializeGitHubActionJsonV1(input: GitHubActionJsonInput): GitHubActionJsonResultV1 {
  switch (input.kind) {
    case "ignored":
      return { formatVersion: 1, kind: "ignored", reason: input.reason };
    case "dry-run":
      return { formatVersion: 1, kind: "dry-run" };
    case "error":
      return { formatVersion: 1, kind: "error", message: genericFailureMessage };
    case "command-help":
      return {
        formatVersion: 1,
        kind: "command-help",
        reason: input.reason,
        mainComment: input.body,
      };
    case "command-response":
      return {
        formatVersion: 1,
        kind: "command-response",
        mainComment: input.response.body,
        publication: { action: input.publication.action },
      };
    case "verifier":
      return {
        formatVersion: 1,
        kind: "verifier",
        publication: { inlineResolutionErrorCount: input.errors.length },
      };
    case "review":
      return {
        formatVersion: 1,
        kind: "review",
        mainComment: stripPiprMainCommentMarkers(input.review.mainComment),
        inlineFindings: input.review.inlineCommentDrafts.map((draft) => draft.finding),
        droppedFindings: input.review.validated.droppedFindings,
        taskChecks: input.review.taskChecks,
        providerModels: publicProviderModels(input),
        repairAttempted: input.review.repairAttempted,
        publication: {
          mainComment: { action: input.publication.mainComment.action },
          inlineComments: input.publication.inlineComments,
          inlinePublicationErrorCount: input.publication.metadata.inlinePublicationErrors.length,
          inlineResolutionErrorCount: input.publication.metadata.inlineResolutionErrors.length,
        },
      };
    case "publication-error":
      return serializePublicationError(input);
    default:
      input satisfies never;
      throw new Error("Unsupported GitHub Action result");
  }
}

function publicProviderModels(result: ReviewResult): string[] {
  return result.review.publicationPlan.metadata.providerModels ?? [result.review.provider.model];
}

function serializePublicationError(
  input: Extract<GitHubActionJsonInput, { kind: "publication-error" }>,
): Extract<GitHubActionJsonResultV1, { kind: "publication-error" }> {
  if (!input.publication) {
    return {
      formatVersion: 1,
      kind: "publication-error",
      message: publicationFailureMessage,
    };
  }

  return {
    formatVersion: 1,
    kind: "publication-error",
    message: publicationFailureMessage,
    publication: {
      inlineComments: input.publication.inlineComments,
      inlinePublicationErrorCount: input.publication.metadata.inlinePublicationErrors.length,
      inlineResolutionErrorCount: input.publication.metadata.inlineResolutionErrors.length,
    },
  };
}

async function setResultOutput(
  input: GitHubActionJsonInput,
  presenter: GitHubActionResultPresenter,
): Promise<void> {
  await presenter.setOutput("result", JSON.stringify(serializeGitHubActionJsonV1(input)));
}

export function stripPiprMainCommentMarkers(mainComment: string): string {
  const lines = mainComment.split("\n");
  const envelope = parseGeneratedMainCommentEnvelope(lines);
  const generatedMarkerIndexes = new Set([
    envelope.mainMarkerIndex,
    envelope.headerMarkerIndex,
    envelope.statsMarkerIndex,
    envelope.statsRange?.start ?? -1,
    envelope.statsRange?.end ?? -1,
    lines[envelope.footerIndex] === mainCommentFooterHiddenMarker ? envelope.footerIndex : -1,
  ]);
  const visibleLines = lines.filter((_line, index) => !generatedMarkerIndexes.has(index));
  const firstContentLine = visibleLines.findIndex((line) => line !== "");
  return firstContentLine === -1 ? "" : visibleLines.slice(firstContentLine).join("\n");
}

async function warnInlineResolutionErrors(
  errors: readonly string[],
  presenter: GitHubActionResultPresenter,
): Promise<void> {
  for (const error of errors) {
    await presenter.warning(`pipr inline resolution failed: ${error}`);
  }
}
