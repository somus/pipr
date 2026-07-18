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

  it("presents command and verifier results through the same sink", async () => {
    const help = recordingPresenter();
    await presentGitHubActionResult(
      {
        ...loadedResultContext(),
        kind: "command-help",
        reason: "missing question",
        body: "usage body",
      } as HostRunCommandResult,
      help.sink,
    );
    expect(help.info.at(-1)).toBe("pipr command help: missing question");
    expect(help.output).toEqual([["main-comment", "usage body"]]);

    const response = recordingPresenter();
    await presentGitHubActionResult(
      {
        ...loadedResultContext(),
        kind: "command-response",
        command: "ask",
        response: { body: "answer body" },
        publication: { action: "created", id: "9" },
      } as HostRunCommandResult,
      response.sink,
    );
    expect(response.info.at(-1)).toBe("pipr command 'ask' published response comment (created)");
    expect(response.output).toEqual([
      ["main-comment", "answer body"],
      ["publication", '{"action":"created","id":"9"}'],
    ]);

    const verifier = recordingPresenter();
    await presentGitHubActionResult(
      {
        ...loadedResultContext(),
        kind: "verifier",
        errors: ["thread is stale"],
      } as HostRunCommandResult,
      verifier.sink,
    );
    expect(verifier.warning).toEqual(["pipr inline resolution failed: thread is stale"]);
    expect(verifier.output).toEqual([
      ["publication", '{"inlineResolutionErrors":["thread is stale"]}'],
    ]);
  });
});

function loadedResultContext() {
  return {
    event: {
      change: { number: 7 },
      repository: { slug: "somus/pipr" },
    },
    configSource: "/workspace/.pipr/config.ts",
  };
}

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
