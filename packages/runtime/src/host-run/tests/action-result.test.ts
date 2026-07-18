import { describe, expect, it } from "bun:test";
import { presentGitHubActionResult } from "../../internal/action-result.js";
import type { HostRunCommandResult } from "../types.js";

type ResultOf<Kind extends HostRunCommandResult["kind"]> = Extract<
  HostRunCommandResult,
  { kind: Kind }
>;

const event = {
  eventName: "pull_request",
  action: "updated",
  platform: { id: "github", host: "https://github.com" },
  repository: { slug: "somus/pipr" },
  change: {
    number: 42,
    title: "Change",
    description: "",
    base: { sha: "base", ref: "main" },
    head: { sha: "head", ref: "feature" },
  },
  workspace: "/workspace",
} satisfies ResultOf<"dry-run">["event"];

const finding = {
  body: "valid",
  path: "src/example.ts",
  rangeId: "range-1",
  side: "RIGHT",
  startLine: 1,
  endLine: 1,
} as const;
const range = {
  id: "range-1",
  path: "src/example.ts",
  side: "RIGHT",
  startLine: 1,
  endLine: 1,
  kind: "added",
  hunkIndex: 1,
  hunkHeader: "@@ -0,0 +1 @@",
  hunkContentHash: "abcdef123456",
} as const;
const review = {
  summary: { title: "Review", body: "review body" },
  inlineFindings: [finding],
};
const metadata = {
  runtimeVersion: "0.4.2",
  reviewedHeadSha: "head",
  selectedTasks: ["review"],
  failedTasks: [],
  validFindings: 1,
  droppedFindings: 1,
  cappedInlineFindings: 0,
};
const inlineDraft = {
  finding,
  range,
  path: finding.path,
  side: finding.side,
  startLine: finding.startLine,
  endLine: finding.endLine,
  body: finding.body,
  marker: "marker",
  findingId: "fnd_fixture",
  reviewedHeadSha: "head",
};

describe("presentGitHubActionResult", () => {
  it("presents review output and inline resolution warnings", async () => {
    const calls = recordingPresenter();
    await presentGitHubActionResult(reviewResult(), calls.sink);

    expect(calls.info).toContain("pipr loaded change #42 for somus/pipr");
    expect(calls.info).toContain("pipr repaired reviewer JSON once before validation");
    expect(calls.warning).toEqual(["pipr inline resolution failed: could not resolve thread"]);
    expect(calls.output).toEqual(
      expect.arrayContaining([
        ["main-comment", "review body"],
        ["inline-comments", JSON.stringify([inlineDraft])],
        ["dropped-findings", JSON.stringify([{ finding, reason: "outside range" }])],
      ]),
    );
  });

  it("presents ignored results without outputs", async () => {
    const calls = recordingPresenter();
    await presentGitHubActionResult(ignoredResult(), calls.sink);
    expect(calls.info).toEqual(["pipr ignored event: unsupported event"]);
    expect(calls.output).toEqual([]);
  });

  it("presents dry-run results without outputs", async () => {
    const calls = recordingPresenter();
    await presentGitHubActionResult(dryRunResult(), calls.sink);
    expect(calls.info.at(-1)).toBe(
      "PIPR_DRY_RUN=1; stopping before review runtime, model, or GitHub publishing calls",
    );
    expect(calls.output).toEqual([]);
  });

  it("presents command help", async () => {
    const calls = recordingPresenter();
    await presentGitHubActionResult(commandHelpResult(), calls.sink);
    expect(calls.info.at(-1)).toBe("pipr command help: missing question");
    expect(calls.output).toEqual([["main-comment", "usage body"]]);
  });

  it("presents command responses and publication metadata", async () => {
    const calls = recordingPresenter();
    await presentGitHubActionResult(commandResponseResult(), calls.sink);
    expect(calls.info.at(-1)).toBe("pipr command 'ask' published response comment (created)");
    expect(calls.output).toEqual([
      ["main-comment", "answer body"],
      ["publication", '{"action":"created","id":"9"}'],
    ]);
  });

  it("presents verifier failures as warnings", async () => {
    const calls = recordingPresenter();
    await presentGitHubActionResult(verifierResult(), calls.sink);
    expect(calls.warning).toEqual(["pipr inline resolution failed: thread is stale"]);
    expect(calls.output).toEqual([
      ["publication", '{"inlineResolutionErrors":["thread is stale"]}'],
    ]);
  });
});

function loadedContext() {
  return { event, configSource: "/workspace/.pipr/config.ts" };
}

function ignoredResult(overrides: Omit<Partial<ResultOf<"ignored">>, "kind"> = {}) {
  return {
    kind: "ignored",
    reason: "unsupported event",
    ...overrides,
  } satisfies ResultOf<"ignored">;
}

function dryRunResult(overrides: Omit<Partial<ResultOf<"dry-run">>, "kind"> = {}) {
  return { ...loadedContext(), kind: "dry-run", ...overrides } satisfies ResultOf<"dry-run">;
}

function commandHelpResult(overrides: Omit<Partial<ResultOf<"command-help">>, "kind"> = {}) {
  return {
    ...loadedContext(),
    kind: "command-help",
    reason: "missing question",
    body: "usage body",
    ...overrides,
  } satisfies ResultOf<"command-help">;
}

function commandResponseResult(
  overrides: Omit<Partial<ResultOf<"command-response">>, "kind"> = {},
) {
  return {
    ...loadedContext(),
    kind: "command-response",
    command: "ask",
    response: { body: "answer body" },
    publication: { action: "created", id: "9" },
    ...overrides,
  } satisfies ResultOf<"command-response">;
}

function verifierResult(overrides: Omit<Partial<ResultOf<"verifier">>, "kind"> = {}) {
  return {
    ...loadedContext(),
    kind: "verifier",
    errors: ["thread is stale"],
    ...overrides,
  } satisfies ResultOf<"verifier">;
}

function reviewResult(overrides: Omit<Partial<ResultOf<"review">>, "kind"> = {}) {
  return {
    ...loadedContext(),
    kind: "review",
    review: {
      kind: "review",
      provider: {
        id: "deepseek/deepseek-v4-pro",
        provider: "deepseek",
        model: "deepseek-v4-pro",
        apiKeyEnv: "DEEPSEEK_API_KEY",
      },
      diffManifest: { baseSha: "base", headSha: "head", mergeBaseSha: "base", files: [] },
      taskChecks: [],
      repairAttempted: true,
      review,
      validated: {
        review,
        validFindings: [finding],
        droppedFindings: [{ finding, reason: "outside range" }],
      },
      publicationPlan: {
        mainComment: "review body",
        mainMarker: "marker",
        changeNumber: 42,
        inlineItems: [inlineDraft],
        metadata,
        reviewState: {
          version: 1,
          reviewedHeadSha: "head",
          selectedTasks: ["review"],
          findings: [],
        },
        threadActions: [],
      },
      mainComment: "review body",
      inlineCommentDrafts: [inlineDraft],
    },
    publication: {
      mainComment: { action: "created", id: "10" },
      inlineComments: { posted: 1, skipped: 1, failed: 0 },
      metadata: {
        ...metadata,
        inlineResolutionErrors: ["could not resolve thread"],
        inlinePublicationErrors: [],
      },
    },
    ...overrides,
  } satisfies ResultOf<"review">;
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
