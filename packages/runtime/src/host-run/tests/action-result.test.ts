import { describe, expect, it } from "bun:test";
import {
  presentGitHubActionError,
  presentGitHubActionPublicationError,
  presentGitHubActionResult,
} from "../../internal/action-result.js";
import { PublicationError } from "../../review/publication-result.js";
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
const visibleStats = [
  "<details>",
  "<summary>Review stats</summary>",
  "",
  "| Metric | Total |",
  "| --- | ---: |",
  "| Models | <code>deepseek-v4-pro</code> |",
  "| Agent runs | 1 |",
  "| Elapsed | 1.3s |",
  "| Input tokens | 500 |",
  "| Output tokens | 50 |",
  "| Cost (USD) | $0.0010 |",
  "",
  "</details>",
].join("\n");

describe("presentGitHubActionResult", () => {
  it("presents review output and inline resolution warnings", async () => {
    const calls = recordingPresenter();
    await presentGitHubActionResult(reviewResult(), calls.sink);

    expect(calls.info).toContain("pipr loaded change #42 for somus/pipr");
    expect(calls.info).toContain("pipr repaired reviewer JSON once before validation");
    expect(calls.warning).toEqual([
      "pipr inline resolution failed: could not resolve fnd_private in thread PRRT_private",
    ]);
    expect(calls.output).toEqual([
      ["main-comment", `review body\n${visibleStats}`],
      [
        "result",
        JSON.stringify({
          formatVersion: 1,
          kind: "review",
          mainComment: `review body\n${visibleStats}`,
          inlineFindings: [finding],
          droppedFindings: [{ finding, reason: "outside range" }],
          taskChecks: [],
          providerModels: ["deepseek-v4-pro"],
          repairAttempted: true,
          publication: {
            mainComment: { action: "created" },
            inlineComments: { posted: 1, skipped: 1, failed: 0 },
            inlinePublicationErrorCount: 0,
            inlineResolutionErrorCount: 1,
          },
        }),
      ],
    ]);
    expect(calls.output.join("\n")).not.toMatch(
      /apiKeyEnv|findingId|marker|reviewedHeadSha|trustedConfig|fnd_private|PRRT_private|"range"|"id":"10"/,
    );
  });

  it("presents ignored results as versioned output", async () => {
    const calls = recordingPresenter();
    await presentGitHubActionResult(ignoredResult(), calls.sink);
    expect(calls.info).toEqual(["pipr ignored event: unsupported event"]);
    expect(calls.output).toEqual([
      ["result", '{"formatVersion":1,"kind":"ignored","reason":"unsupported event"}'],
    ]);
  });

  it("presents dry-run results as versioned output", async () => {
    const calls = recordingPresenter();
    await presentGitHubActionResult(dryRunResult(), calls.sink);
    expect(calls.info.at(-1)).toBe(
      "PIPR_DRY_RUN=1; stopping before review runtime, model, or GitHub publishing calls",
    );
    expect(calls.output).toEqual([["result", '{"formatVersion":1,"kind":"dry-run"}']]);
  });

  it("presents generic failures as versioned output", async () => {
    const calls = recordingPresenter();
    await presentGitHubActionError(calls.sink);

    expect(calls.output).toEqual([
      [
        "result",
        '{"formatVersion":1,"kind":"error","message":"Pipr failed; see the Action log for details."}',
      ],
    ]);
    expect(calls.output[0]?.[1]).not.toContain("provider-secret");
  });

  it("preserves leading Markdown indentation while removing control markers", async () => {
    const result = reviewResult();
    result.review.mainComment = [
      "<!-- pipr:main-comment state=hidden -->",
      "",
      "<!-- pipr:header:hidden -->",
      "",
      "    const reviewed = true;",
      "<!-- pipr:header:hidden -->",
      "Task-authored marker example.",
      "",
      "<!-- pipr:stats:hidden -->",
      "",
      "<!-- pipr:footer:hidden -->",
      "",
    ].join("\n");
    const calls = recordingPresenter();

    await presentGitHubActionResult(result, calls.sink);

    const expectedMainComment = [
      "    const reviewed = true;",
      "<!-- pipr:header:hidden -->",
      "Task-authored marker example.",
      "",
      "",
      "",
    ].join("\n");
    expect(calls.output[0]).toEqual(["main-comment", expectedMainComment]);
    expect(JSON.parse(calls.output[1]?.[1] ?? "null").mainComment).toBe(expectedMainComment);
  });

  it("presents command help", async () => {
    const calls = recordingPresenter();
    await presentGitHubActionResult(commandHelpResult(), calls.sink);
    expect(calls.info.at(-1)).toBe("pipr command help: missing question");
    expect(calls.output).toEqual([
      ["main-comment", "usage body"],
      [
        "result",
        '{"formatVersion":1,"kind":"command-help","reason":"missing question","mainComment":"usage body"}',
      ],
    ]);
  });

  it("presents command responses and publication metadata", async () => {
    const calls = recordingPresenter();
    await presentGitHubActionResult(commandResponseResult(), calls.sink);
    expect(calls.info.at(-1)).toBe("pipr command 'ask' published response comment (created)");
    expect(calls.output).toEqual([
      ["main-comment", "answer body"],
      [
        "result",
        '{"formatVersion":1,"kind":"command-response","mainComment":"answer body","publication":{"action":"created"}}',
      ],
    ]);
  });

  it("presents verifier failures as warnings", async () => {
    const calls = recordingPresenter();
    await presentGitHubActionResult(verifierResult(), calls.sink);
    expect(calls.warning).toEqual([
      "pipr inline resolution failed: fnd_private thread PRRT_private is stale",
    ]);
    expect(calls.output).toEqual([
      [
        "result",
        '{"formatVersion":1,"kind":"verifier","publication":{"inlineResolutionErrorCount":1}}',
      ],
    ]);
  });

  it("presents partial publication failures without internal metadata", async () => {
    const calls = recordingPresenter();
    await presentGitHubActionPublicationError(
      new PublicationError("inline publication failed", {
        inlineComments: { posted: 1, skipped: 0, failed: 1 },
        metadata: {
          ...metadata,
          trustedConfigSha: "trusted",
          trustedConfigHash: "hash",
          inlinePublicationErrors: ["request failed for fnd_private in PRRT_private"],
          inlineResolutionErrors: [],
        },
      }),
      calls.sink,
    );

    expect(calls.output).toEqual([
      [
        "result",
        JSON.stringify({
          formatVersion: 1,
          kind: "publication-error",
          message: "Pipr could not complete publication; see the Action log for details.",
          publication: {
            inlineComments: { posted: 1, skipped: 0, failed: 1 },
            inlinePublicationErrorCount: 1,
            inlineResolutionErrorCount: 0,
          },
        }),
      ],
    ]);
    expect(calls.output[0]?.[1]).not.toMatch(/trusted|fnd_private|PRRT_private/);
  });

  it("presents publication failures without partial metadata", async () => {
    const calls = recordingPresenter();
    await presentGitHubActionPublicationError(
      new PublicationError("head changed", undefined),
      calls.sink,
    );

    expect(calls.output).toEqual([
      [
        "result",
        '{"formatVersion":1,"kind":"publication-error","message":"Pipr could not complete publication; see the Action log for details."}',
      ],
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
    errors: ["fnd_private thread PRRT_private is stale"],
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
      mainComment: [
        "<!-- pipr:main-comment state=hidden -->",
        "<!-- pipr:header:hidden -->",
        "review body",
        "<!-- pipr:stats:start -->",
        visibleStats,
        "<!-- pipr:stats:end -->",
        "<!-- pipr:footer:hidden -->",
      ].join("\n"),
      inlineCommentDrafts: [inlineDraft],
    },
    publication: {
      mainComment: { action: "created", id: "10" },
      inlineComments: { posted: 1, skipped: 1, failed: 0 },
      metadata: {
        ...metadata,
        inlineResolutionErrors: ["could not resolve fnd_private in thread PRRT_private"],
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
