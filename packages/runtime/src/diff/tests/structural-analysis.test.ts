import { describe, expect, it } from "bun:test";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { reviewTestManifest } from "../../tests/helpers/review-test-manifest.js";
import {
  analyzeDiffStructure,
  createDiffStructuralAnalysisLoader,
} from "../structural-analysis.js";

describe("Diff structural analysis", () => {
  it("normalizes declarations, qualified members, imports, and one-based inclusive ranges", async () => {
    const executableDirectory = await mkdtemp(path.join(os.tmpdir(), "pipr-ast-grep-"));
    try {
      await writeFakeAstGrep(executableDirectory, [
        {
          path: "src/example.ts",
          language: "TypeScript",
          items: [
            {
              role: "item",
              symbolType: "module",
              name: '"./dependency.js"',
              range: sourceRange(0, 0),
              signature: 'import "./dependency.js";',
              astKind: "import_statement",
              isImport: true,
              isExported: false,
            },
            {
              role: "item",
              symbolType: "class",
              name: "Example",
              range: sourceRange(2, 8),
              signature: "export class Example {",
              astKind: "export_statement",
              isImport: false,
              isExported: true,
              members: [
                {
                  role: "member",
                  symbolType: "method",
                  name: "run",
                  range: sourceRange(4, 6),
                  signature: "run() {",
                  astKind: "method_definition",
                  isPublic: true,
                },
              ],
            },
          ],
        },
      ]);
      const seedFile = reviewTestManifest().files[0];
      if (!seedFile) {
        throw new Error("expected a changed file");
      }
      const manifest = {
        ...reviewTestManifest(),
        files: [
          {
            ...seedFile,
            path: "src/example.ts",
          },
        ],
      };

      const result = await analyzeDiffStructure({
        manifest,
        workspace: process.cwd(),
        env: pathWithExecutable(executableDirectory),
      });

      expect(result).toMatchObject({
        available: true,
        version: "0.44.1",
        headFiles: [
          {
            path: "src/example.ts",
            language: "TypeScript",
            imports: ["./dependency.js"],
            declarations: [
              {
                qualifiedName: "Example",
                kind: "class",
                startLine: 3,
                endLine: 9,
                isExported: true,
              },
              {
                qualifiedName: "Example.run",
                kind: "method",
                startLine: 5,
                endLine: 7,
                isExported: false,
              },
            ],
          },
        ],
        baseFiles: [],
      });
    } finally {
      await rm(executableDirectory, { recursive: true, force: true });
    }
  });

  it("returns a tagged unavailable result when ast-grep is missing", async () => {
    const result = await analyzeDiffStructure({
      manifest: reviewTestManifest(),
      workspace: process.cwd(),
      env: { ...process.env, PATH: "" },
    });

    expect(result).toMatchObject({
      available: false,
      reason: "missing-executable",
    });
  });

  it("returns tagged fallbacks for malformed output, timeouts, and output limits", async () => {
    const executableDirectory = await mkdtemp(path.join(os.tmpdir(), "pipr-ast-grep-"));
    try {
      const cases = [
        {
          body: 'process.stdout.write("not-json");',
          reason: "invalid-output",
          limits: {},
        },
        {
          body: "await Bun.sleep(100); process.stdout.write('[]');",
          reason: "timeout",
          limits: { timeoutMs: 10 },
        },
        {
          body: `process.stdout.write(${JSON.stringify("x".repeat(256))});`,
          reason: "output-limit",
          limits: { stdoutLimitBytes: 128 },
        },
      ] as const;
      for (const testCase of cases) {
        await writeFakeAstGrepBody(executableDirectory, testCase.body);
        const result = await analyzeDiffStructure({
          manifest: reviewTestManifest(),
          workspace: process.cwd(),
          env: pathWithExecutable(executableDirectory),
          executionLimits: testCase.limits,
        });
        expect(result).toMatchObject({
          available: false,
          reason: testCase.reason,
        });
      }
    } finally {
      await rm(executableDirectory, { recursive: true, force: true });
    }
  });

  it("memoizes one analysis promise for a Review Run", () => {
    const load = createDiffStructuralAnalysisLoader({
      manifest: reviewTestManifest(),
      workspace: process.cwd(),
      env: { ...process.env, PATH: "" },
    });

    expect(load()).toBe(load());
  });
});

function sourceRange(startLine: number, endLine: number) {
  return {
    byteOffset: { start: 0, end: 1 },
    start: { line: startLine, column: 0 },
    end: { line: endLine, column: 1 },
  };
}

async function writeFakeAstGrep(directory: string, outline: unknown): Promise<void> {
  await writeFakeAstGrepBody(
    directory,
    `process.stdout.write(${JSON.stringify(JSON.stringify(outline))});`,
  );
}

async function writeFakeAstGrepBody(directory: string, body: string): Promise<void> {
  const executable = path.join(directory, "ast-grep");
  await Bun.write(
    executable,
    [
      "#!/usr/bin/env bun",
      'if (process.argv.includes("--version")) {',
      '  process.stdout.write("ast-grep 0.44.1\\n");',
      "} else {",
      `  ${body}`,
      "}",
      "",
    ].join("\n"),
  );
  await chmod(executable, 0o755);
}

function pathWithExecutable(directory: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PATH: `${directory}:${process.env.PATH ?? ""}`,
  };
}
