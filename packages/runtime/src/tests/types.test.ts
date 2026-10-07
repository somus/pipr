import { describe, expect, it } from "bun:test";
import { ZodError } from "zod";
import type { ReviewFinding, ReviewResult } from "../types.js";
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

const review: ReviewResult = {
  summary: { body: "Looks fine." },
  inlineFindings: [finding],
};

function issuePaths(parse: () => unknown): string[] {
  try {
    parse();
  } catch (error) {
    if (error instanceof ZodError) {
      return error.issues.map((issue) => issue.path.join("."));
    }
    throw error;
  }
  throw new Error("expected the schema to reject the value");
}

const provider = {
  id: "deepseek",
  provider: "deepseek",
  model: "deepseek-v4-pro",
  apiKeyEnv: "DEEPSEEK_API_KEY",
};

describe("runtime boundary schemas", () => {
  it.each<[string, () => unknown, string]>([
    [
      "pipr config with too many inline comments",
      () =>
        parsePiprConfig({
          defaultProvider: "deepseek",
          providers: [provider],
          publication: { maxInlineComments: 51 },
        }),
      "publication.maxInlineComments",
    ],
    [
      "change request event with a zero change number",
      () =>
        parseChangeRequestEventContext({
          eventName: "pull_request",
          platform: { id: "github" },
          repository: { slug: "owner/repo" },
          change: { number: 0, base: { sha: "base" }, head: { sha: "head" } },
          workspace: "/tmp/repo",
        }),
      "change.number",
    ],
    [
      "diff manifest range starting at line zero",
      () =>
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
      "files.0.commentableRanges.0.startLine",
    ],
    [
      "validated review with an empty drop reason",
      () =>
        parseValidatedReview({
          review,
          validFindings: [],
          droppedFindings: [{ finding, reason: "" }],
        }),
      "droppedFindings.0.reason",
    ],
    [
      "runtime settings without providers",
      () =>
        parseRuntimeSettings({
          source: ".pipr/config.ts",
          config: { defaultProvider: "deepseek", providers: [], publication: {} },
          warnings: [],
        }),
      "config.providers",
    ],
  ])("rejects %s", (_name, parse, path) => {
    expect(issuePaths(parse)).toContain(path);
  });
});
