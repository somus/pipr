import { describe, expect, it } from "bun:test";
import { PublicationError, StaleHeadError } from "../../review/publication-result.js";
import { classifyRunFailure } from "../commands-shared.js";

describe("classifyRunFailure", () => {
  it("classifies typed stale endpoint errors from every host as stale-head", () => {
    const errors = [
      new StaleHeadError({
        provider: "Bitbucket",
        endpoint: "head",
        expectedSha: "reviewed",
        currentSha: "moved",
      }),
      new StaleHeadError({
        provider: "Azure DevOps",
        endpoint: "base",
        expectedSha: "base",
        currentSha: "new-base",
      }),
    ];

    for (const error of errors) expect(classifyRunFailure(error, "unknown")).toBe("stale-head");
  });

  it("names the host, endpoint, and both commits in stale endpoint messages", () => {
    expect(
      new StaleHeadError({
        provider: "Azure DevOps",
        endpoint: "base",
        expectedSha: "base",
        currentSha: "new-base",
        stage: "status publication",
      }).message,
    ).toBe(
      "Azure DevOps change request base changed from 'base' to 'new-base' before status publication",
    );
  });

  it("does not infer stale-head from untyped error text", () => {
    expect(classifyRunFailure(new PublicationError("head changed", undefined), "unknown")).toBe(
      "publication",
    );
    expect(classifyRunFailure(new Error("head changed"), "unknown")).toBe("unknown");
  });
});
