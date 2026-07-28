import { describe, expect, it } from "bun:test";
import { readFile } from "node:fs/promises";
import { supportedOfficialInitRecipes } from "../../../../packages/runtime/src/config/recipes";
import { getLegacyDocRedirect } from "../../src/lib/docs-routes";
import { twoslashCompilerOptions } from "../../twoslash-config";

describe("docs source config", () => {
  it("keeps twoslash SDK aliases aligned with package exports", () => {
    expect(twoslashCompilerOptions.paths).toEqual({
      "@usepipr/sdk": ["packages/sdk/src/index.ts"],
      "@usepipr/sdk/internal": ["packages/sdk/src/internal.ts"],
    });
    expect(Object.keys(twoslashCompilerOptions.paths)).not.toContain("@usepipr/sdk/*");
  });

  it("keeps legacy documentation routes mapped to canonical pages", () => {
    expect(getLegacyDocRedirect(["guide", "concepts"])).toEqual({
      page: "/docs/concepts",
      markdown: "/docs/concepts.md",
      og: "/og/docs/concepts/image.webp",
    });
    expect(getLegacyDocRedirect(["reference", "architecture"])).toEqual({
      page: "/docs/concepts/runtime",
      markdown: "/docs/concepts/runtime.md",
      og: "/og/docs/concepts/runtime/image.webp",
    });
    expect(getLegacyDocRedirect(["project", "contributing"])).toEqual({
      page: "https://github.com/somus/pipr/blob/main/CONTRIBUTING.md",
      markdown: "https://raw.githubusercontent.com/somus/pipr/main/CONTRIBUTING.md",
      og: "/og/docs/image.webp",
    });
    expect(getLegacyDocRedirect(["project", "security"])).toEqual({
      page: "https://github.com/somus/pipr/blob/main/SECURITY.md",
      markdown: "https://raw.githubusercontent.com/somus/pipr/main/SECURITY.md",
      og: "/og/docs/image.webp",
    });
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
