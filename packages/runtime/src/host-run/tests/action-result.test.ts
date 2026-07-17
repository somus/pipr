import { describe, expect, it } from "bun:test";
import { presentGitHubActionResult } from "../../internal/action-result.js";
import type { HostRunCommandResult } from "../types.js";

describe("presentGitHubActionResult", () => {
  it("presents review output and inline resolution warnings through one sink", async () => {
    const calls = recordingPresenter();
    const result = {
      kind: "review",
      event: {
        change: { number: 42 },
        repository: { slug: "somus/pipr" },
      },
      configSource: "/workspace/.pipr/config.ts",
      review: {
        validated: {
          validFindings: [{ body: "valid" }],
          droppedFindings: [{ reason: "outside range" }],
        },
        repairAttempted: true,
        mainComment: "review body",
        inlineCommentDrafts: [{ body: "valid" }],
      },
      publication: {
        mainComment: { action: "created", id: "10" },
        inlineComments: { posted: 1, skipped: 1, failed: 0 },
        metadata: {
          inlineResolutionErrors: ["could not resolve thread"],
          inlinePublicationErrors: [],
        },
      },
    } as unknown as HostRunCommandResult;

    await presentGitHubActionResult(result, calls.sink);

    expect(calls.info).toContain("pipr loaded change #42 for somus/pipr");
    expect(calls.info).toContain("pipr repaired reviewer JSON once before validation");
    expect(calls.warning).toEqual(["pipr inline resolution failed: could not resolve thread"]);
    expect(calls.output).toEqual(
      expect.arrayContaining([
        ["main-comment", "review body"],
        ["inline-comments", '[{"body":"valid"}]'],
        ["dropped-findings", '[{"reason":"outside range"}]'],
      ]),
    );
  });

  it("presents ignored and dry-run results without outputs", async () => {
    const ignored = recordingPresenter();
    await presentGitHubActionResult({ kind: "ignored", reason: "unsupported event" }, ignored.sink);
    expect(ignored.info).toEqual(["pipr ignored event: unsupported event"]);
    expect(ignored.output).toEqual([]);

    const dryRun = recordingPresenter();
    await presentGitHubActionResult(
      {
        kind: "dry-run",
        event: {
          change: { number: 7 },
          repository: { slug: "somus/pipr" },
        },
        configSource: "/workspace/.pipr/config.ts",
      } as HostRunCommandResult,
      dryRun.sink,
    );
    expect(dryRun.info.at(-1)).toBe(
      "PIPR_DRY_RUN=1; stopping before review runtime, model, or GitHub publishing calls",
    );
    expect(dryRun.output).toEqual([]);
  });
});

function recordingPresenter() {
  const info: string[] = [];
  const warning: string[] = [];
  const output: Array<[string, string]> = [];
  return {
    info,
    warning,
    output,
    sink: {
      info(message: string) {
        info.push(message);
      },
      warning(message: string) {
        warning.push(message);
      },
      setOutput(name: string, value: string) {
        output.push([name, value]);
      },
    },
  };
}
