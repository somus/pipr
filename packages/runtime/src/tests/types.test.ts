import { describe, expect, it } from "bun:test";
import type { PrReview, ReviewFinding } from "../types.js";
import {
  parseChangeRequestEventContext,
  parseDiffManifest,
  parsePiprConfig,
  parseRuntimeSettings,
  parseValidatedReview,
} from "../types.js";

const finding: ReviewFinding = {
  body: "This can fail.",
  path: "src/a.ts",
  rangeId: "range-1",
  side: "RIGHT",
  startLine: 10,
  endLine: 10,
};

const review: PrReview = {
  summary: { body: "Looks fine." },
  inlineFindings: [finding],
};

describe("runtime boundary schemas", () => {
  it("validates Pi provider config from zod-derived types", () => {
    const config = parsePiprConfig({
      defaultProvider: "deepseek",
      providers: [
        {
          id: "deepseek",
          provider: "deepseek",
          model: "deepseek-v4-pro",
          apiKeyEnv: "DEEPSEEK_API_KEY",
          thinking: "minimal",
        },
      ],
      publication: {
        maxInlineComments: 5,
        autoResolve: {
          enabled: true,
          model: "deepseek",
          synchronize: true,
          userReplies: {
            enabled: true,
            respondWhenStillValid: true,
            allowedActors: "author-or-write",
          },
        },
      },
    });

    expect(config.providers[0]?.thinking).toBe("minimal");
  });

  it("rejects invalid pipr config values", () => {
    expect(() =>
      parsePiprConfig({
        defaultProvider: "deepseek",
        providers: [
          {
            id: "deepseek",
            provider: "deepseek",
            model: "deepseek-v4-pro",
            apiKeyEnv: "DEEPSEEK_API_KEY",
          },
        ],
        publication: {
          maxInlineComments: 51,
        },
      }),
    ).toThrow();
  });

  it("rejects invalid change request event context", () => {
    expect(() =>
      parseChangeRequestEventContext({
        eventName: "pull_request",
        platform: { id: "github" },
        repository: { slug: "owner/repo" },
        change: {
          number: 0,
          base: { sha: "base" },
          head: { sha: "head" },
        },
        workspace: "/tmp/repo",
      }),
    ).toThrow();
  });

  it("rejects invalid diff manifest ranges", () => {
    expect(() =>
      parseDiffManifest({
        baseSha: "base",
        headSha: "head",
        mergeBaseSha: "base",
        files: [
          {
            path: "src/a.ts",
            status: "modified",
            additions: 1,
            deletions: 0,
            hunks: [
              {
                hunkIndex: 1,
                header: "@@ -1,0 +1,1 @@",
                oldStart: 1,
                oldLines: 0,
                newStart: 1,
                newLines: 1,
                contentHash: "deadbeefcafe",
              },
            ],
            commentableRanges: [
              {
                id: "range-1",
                path: "src/a.ts",
                side: "RIGHT",
                startLine: 0,
                endLine: 1,
                kind: "added",
                hunkIndex: 1,
                hunkHeader: "@@ -1,0 +1,1 @@",
                hunkContentHash: "deadbeefcafe",
              },
            ],
          },
        ],
      }),
    ).toThrow();
  });

  it("rejects invalid validated reviews", () => {
    expect(() =>
      parseValidatedReview({
        review,
        validFindings: [],
        droppedFindings: [{ finding, reason: "" }],
      }),
    ).toThrow();
  });

  it("rejects malformed runtime settings", () => {
    expect(() =>
      parseRuntimeSettings({
        source: ".pipr/config.ts",
        config: {
          defaultProvider: "deepseek",
          providers: [],
          publication: {
            maxInlineComments: 5,
          },
        },
        warnings: [],
      }),
    ).toThrow();
  });
});
