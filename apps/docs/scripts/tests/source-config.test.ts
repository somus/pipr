import { describe, expect, it } from "bun:test";
import { twoslashCompilerOptions } from "../../twoslash-config";

describe("docs source config", () => {
  it("keeps twoslash SDK aliases aligned with package exports", () => {
    expect(twoslashCompilerOptions.paths).toEqual({
      "@usepipr/sdk": ["packages/sdk/src/index.ts"],
      "@usepipr/sdk/internal": ["packages/sdk/src/internal.ts"],
    });
    expect(Object.keys(twoslashCompilerOptions.paths)).not.toContain("@usepipr/sdk/*");
  });
});
