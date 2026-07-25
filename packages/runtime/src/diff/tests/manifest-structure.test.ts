import { describe, expect, it } from "bun:test";
import { reviewTestManifest } from "../../tests/helpers/review-test-manifest.js";
import { enrichDiffManifestWithStructure } from "../manifest-structure.js";
import type { DiffStructuralAnalysis } from "../structural-analysis.js";

describe("Diff Manifest structural metadata", () => {
  it("maps renamed LEFT ranges to base declarations and RIGHT ranges to head declarations", () => {
    const manifest = reviewTestManifest();
    const sourceFile = manifest.files[0];
    const sourceRange = sourceFile?.commentableRanges[0];
    if (!sourceFile || !sourceRange) {
      throw new Error("expected a changed file and range");
    }
    const renamedManifest = {
      ...manifest,
      files: [
        {
          ...sourceFile,
          path: "src/new.ts",
          previousPath: "src/old.ts",
          commentableRanges: [
            {
              ...sourceRange,
              id: "left-range",
              path: "src/new.ts",
              side: "LEFT" as const,
              startLine: 4,
              endLine: 4,
              kind: "deleted" as const,
            },
            {
              ...sourceRange,
              id: "right-range",
              path: "src/new.ts",
              side: "RIGHT" as const,
              startLine: 8,
              endLine: 8,
              kind: "added" as const,
            },
          ],
        },
      ],
    };
    const analysis: DiffStructuralAnalysis = {
      available: true,
      version: "0.44.1",
      baseFiles: [structuralFile("src/old.ts", "oldDeclaration", 3, 6)],
      headFiles: [structuralFile("src/new.ts", "newDeclaration", 7, 10)],
      diagnostics: { durationMs: 1, fileCount: 2, declarationCount: 2 },
    };

    const enriched = enrichDiffManifestWithStructure(renamedManifest, analysis);

    expect(enriched.files[0]?.commentableRanges.map((range) => range.summary)).toEqual([
      "Enclosing declaration: function oldDeclaration",
      "Enclosing declaration: function newDeclaration",
    ]);
    expect(enriched.files[0]?.changedSymbols).toEqual(["oldDeclaration", "newDeclaration"]);
  });
});

function structuralFile(path: string, qualifiedName: string, startLine: number, endLine: number) {
  return {
    path,
    language: "TypeScript",
    imports: [],
    declarations: [
      {
        qualifiedName,
        kind: "function",
        startLine,
        endLine,
        isExported: false,
      },
    ],
  };
}
