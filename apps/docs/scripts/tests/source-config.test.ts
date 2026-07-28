import { describe, expect, it } from "bun:test";
import { readFile } from "node:fs/promises";
import { supportedOfficialInitRecipes } from "../../../../packages/runtime/src/config/recipes";
import { twoslashCompilerOptions } from "../../twoslash-config";

describe("docs source config", () => {
  it("keeps twoslash SDK aliases aligned with package exports", () => {
    expect(twoslashCompilerOptions.paths).toEqual({
      "@usepipr/sdk": ["packages/sdk/src/index.ts"],
      "@usepipr/sdk/internal": ["packages/sdk/src/internal.ts"],
    });
    expect(Object.keys(twoslashCompilerOptions.paths)).not.toContain("@usepipr/sdk/*");
  });

  it("gives every recipe screenshot descriptive alt text", async () => {
    for (const recipe of supportedOfficialInitRecipes) {
      const source = await readFile(
        new URL(`../../content/docs/recipes/${recipe}.mdx`, import.meta.url),
        "utf8",
      );

      expect(source).not.toContain("recipe output from Pipr");
      expect(source).toMatch(/alt="GitHub pull request showing [^.]+\. Pipr .+"/);
    }
  });
});
