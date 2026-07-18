import { describe, expect, it } from "bun:test";
import { docsBuildHasFatalPrerenderError } from "../build.js";

describe("docsBuildHasFatalPrerenderError", () => {
  it.each([
    "Invalid hook call",
    "Error in renderToReadableStream",
    "Cannot read properties of null (reading 'useSyncExternalStore')",
  ])("rejects %s", (message) => {
    expect(docsBuildHasFatalPrerenderError(`build output\n${message}\n`)).toBe(true);
  });

  it("accepts ordinary build warnings", () => {
    expect(docsBuildHasFatalPrerenderError("Some chunks are larger than 500 kB")).toBe(false);
  });
});
