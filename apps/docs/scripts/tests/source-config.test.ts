import { describe, expect, it } from "bun:test";
import { readFile } from "node:fs/promises";
import { supportedOfficialInitRecipes } from "../../../../packages/runtime/src/config/recipes";
import { getLegacyDocRedirect } from "../../src/lib/docs-routes";
import type { docsSearchServer } from "../../src/routes/api/search";
import { twoslashCompilerOptions } from "../../twoslash-config";

type DocsSearchServer = typeof docsSearchServer;

describe("docs source config", () => {
  it("keeps twoslash SDK aliases aligned with package exports", () => {
    expect(twoslashCompilerOptions.paths).toEqual({
      "@usepipr/sdk": ["packages/sdk/src/index.ts"],
      "@usepipr/sdk/internal": ["packages/sdk/src/internal.ts"],
    });
    expect(Object.keys(twoslashCompilerOptions.paths)).not.toContain("@usepipr/sdk/*");
  });

  it("exposes the documentation search server for focused tests", () => {
    const searchMethod: keyof DocsSearchServer = "search";
    expect(searchMethod).toBe("search");
  });

  it("keeps legacy documentation routes mapped to canonical pages", () => {
    expect(getLegacyDocRedirect(["guide", "concepts"])).toBe("/docs/concepts");
    expect(getLegacyDocRedirect(["guide", "runtime"])).toBe("/docs/concepts/runtime");
    expect(getLegacyDocRedirect(["guide", "comments"])).toBe("/docs/concepts/comments");
    expect(getLegacyDocRedirect(["guide", "trust-security"])).toBe("/docs/concepts/trust-security");
    expect(getLegacyDocRedirect(["reference", "development"])).toBe("/docs/project/development");
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
