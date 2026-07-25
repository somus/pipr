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

  it("analyzes the requested head ref and renamed merge-base path", async () => {
    const repository = await mkdtemp(path.join(os.tmpdir(), "pipr-structural-repo-"));
    const executableDirectory = await mkdtemp(path.join(os.tmpdir(), "pipr-ast-grep-"));
    try {
      git(repository, ["init"]);
      git(repository, ["config", "user.email", "pipr@example.com"]);
      git(repository, ["config", "user.name", "Pipr Test"]);
      await Bun.write(
        path.join(repository, "old.ts"),
        "export function BaseDeclaration() { return 'base'; }\n",
      );
      git(repository, ["add", "old.ts"]);
      git(repository, ["commit", "-m", "base"]);
      const baseSha = git(repository, ["rev-parse", "HEAD"]).trim();
      git(repository, ["mv", "old.ts", "new.ts"]);
      await Bun.write(
        path.join(repository, "new.ts"),
        "export function RequestedHead() { return 'head'; }\n",
      );
      git(repository, ["add", "new.ts"]);
      git(repository, ["commit", "-m", "head"]);
      const headSha = git(repository, ["rev-parse", "HEAD"]).trim();
      git(repository, ["checkout", baseSha]);
      await writeContentAwareAstGrep(executableDirectory);

      const seed = reviewTestManifest();
      const file = seed.files[0];
      const range = file?.commentableRanges[0];
      if (!file || !range) {
        throw new Error("expected a changed file and range");
      }
      const manifest = {
        ...seed,
        baseSha,
        headSha,
        mergeBaseSha: baseSha,
        files: [
          {
            ...file,
            path: "new.ts",
            previousPath: "old.ts",
            status: "renamed" as const,
            commentableRanges: [
              { ...range, rangeId: "right", side: "RIGHT" as const },
              { ...range, rangeId: "left", side: "LEFT" as const },
            ],
          },
        ],
      };

      const result = await analyzeDiffStructure({
        manifest,
        workspace: repository,
        headRef: headSha,
        env: pathWithExecutable(executableDirectory),
      });

      expect(result).toMatchObject({
        available: true,
        headFiles: [
          {
            path: "new.ts",
            declarations: [{ qualifiedName: "RequestedHead" }],
          },
        ],
        baseFiles: [
          {
            path: "old.ts",
            declarations: [{ qualifiedName: "BaseDeclaration" }],
          },
        ],
      });

      const missingBase = await analyzeDiffStructure({
        manifest: { ...manifest, mergeBaseSha: "missing-ref" },
        workspace: repository,
        headRef: headSha,
        env: pathWithExecutable(executableDirectory),
      });
      expect(missingBase).toMatchObject({
        available: false,
        reason: "base-content-unavailable",
      });
    } finally {
      await rm(repository, { recursive: true, force: true });
      await rm(executableDirectory, { recursive: true, force: true });
    }
  });

  it("stops when ref snapshots exceed the aggregate output budget", async () => {
    const repository = await mkdtemp(path.join(os.tmpdir(), "pipr-structural-repo-"));
    const executableDirectory = await mkdtemp(path.join(os.tmpdir(), "pipr-ast-grep-"));
    try {
      git(repository, ["init"]);
      git(repository, ["config", "user.email", "pipr@example.com"]);
      git(repository, ["config", "user.name", "Pipr Test"]);
      await Bun.write(path.join(repository, "first.ts"), "a".repeat(64));
      await Bun.write(path.join(repository, "second.ts"), "b".repeat(64));
      git(repository, ["add", "first.ts", "second.ts"]);
      git(repository, ["commit", "-m", "base"]);
      const baseSha = git(repository, ["rev-parse", "HEAD"]).trim();
      await writeFakeAstGrep(executableDirectory, []);

      const seed = reviewTestManifest();
      const file = seed.files[0];
      const range = file?.commentableRanges[0];
      if (!file || !range) {
        throw new Error("expected a changed file and range");
      }
      const removedFile = (filePath: string) => ({
        ...file,
        path: filePath,
        status: "removed" as const,
        commentableRanges: [{ ...range, rangeId: filePath, side: "LEFT" as const }],
      });
      const manifest = {
        ...seed,
        baseSha,
        headSha: baseSha,
        mergeBaseSha: baseSha,
        files: [removedFile("first.ts"), removedFile("second.ts")],
      };

      const result = await analyzeDiffStructure({
        manifest,
        workspace: repository,
        env: pathWithExecutable(executableDirectory),
        executionLimits: { stdoutLimitBytes: 96 },
      });

      expect(result).toMatchObject({
        available: false,
        reason: "output-limit",
      });
    } finally {
      await rm(repository, { recursive: true, force: true });
      await rm(executableDirectory, { recursive: true, force: true });
    }
  });

  it("times out while reading a ref snapshot", async () => {
    const executableDirectory = await mkdtemp(path.join(os.tmpdir(), "pipr-ast-grep-"));
    try {
      await writeFakeAstGrep(executableDirectory, []);
      await writeSlowGit(executableDirectory);
      const seed = reviewTestManifest();
      const file = seed.files[0];
      const range = file?.commentableRanges[0];
      if (!file || !range) {
        throw new Error("expected a changed file and range");
      }
      const manifest = {
        ...seed,
        files: [
          {
            ...file,
            status: "removed" as const,
            commentableRanges: [{ ...range, side: "LEFT" as const }],
          },
        ],
      };

      const result = await analyzeDiffStructure({
        manifest,
        workspace: process.cwd(),
        env: pathWithExecutable(executableDirectory),
        executionLimits: { timeoutMs: 150 },
      });

      expect(result).toMatchObject({
        available: false,
        reason: "timeout",
      });
    } finally {
      await rm(executableDirectory, { recursive: true, force: true });
    }
  });

  it("stops before materializing more than the bounded snapshot file count", async () => {
    const executableDirectory = await mkdtemp(path.join(os.tmpdir(), "pipr-ast-grep-"));
    try {
      await writeFakeAstGrep(executableDirectory, []);
      const seed = reviewTestManifest();
      const file = seed.files[0];
      const range = file?.commentableRanges[0];
      if (!file || !range) {
        throw new Error("expected a changed file and range");
      }
      const manifest = {
        ...seed,
        files: Array.from({ length: 513 }, (_, index) => {
          const filePath = `src/removed-${index}.ts`;
          return {
            ...file,
            path: filePath,
            status: "removed" as const,
            commentableRanges: [{ ...range, rangeId: filePath, side: "LEFT" as const }],
          };
        }),
      };

      const result = await analyzeDiffStructure({
        manifest,
        workspace: process.cwd(),
        env: pathWithExecutable(executableDirectory),
      });

      expect(result).toMatchObject({
        available: false,
        reason: "output-limit",
      });
    } finally {
      await rm(executableDirectory, { recursive: true, force: true });
    }
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
        {
          body: 'process.stderr.write("x".repeat(256));',
          reason: "output-limit",
          limits: { stderrLimitBytes: 128 },
        },
        {
          body: "process.exit(2);",
          reason: "nonzero-exit",
          limits: {},
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

  it("executes structural analysis once across repeated Review Run loads", async () => {
    const executableDirectory = await mkdtemp(path.join(os.tmpdir(), "pipr-ast-grep-"));
    const callsPath = path.join(executableDirectory, "calls.txt");
    await writeCountingAstGrep(executableDirectory, callsPath);
    const load = createDiffStructuralAnalysisLoader({
      manifest: reviewTestManifest(),
      workspace: process.cwd(),
      env: pathWithExecutable(executableDirectory),
    });

    const first = load();
    const second = load();
    expect(first).toBe(second);
    await Promise.all([first, second]);
    expect((await Bun.file(callsPath).text()).trim().split("\n")).toHaveLength(2);
    await rm(executableDirectory, { recursive: true, force: true });
  });

  it("analyzes renamed LEFT ranges from the merge-base path", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "pipr-structure-repo-"));
    const executableDirectory = await mkdtemp(path.join(os.tmpdir(), "pipr-ast-grep-"));
    try {
      await Bun.write(path.join(workspace, "old.ts"), "function before() {\n  return 1;\n}\n");
      runGit(workspace, ["init", "-q"]);
      runGit(workspace, ["add", "old.ts"]);
      runGit(workspace, [
        "-c",
        "user.name=Pipr Tests",
        "-c",
        "user.email=pipr@example.test",
        "commit",
        "-qm",
        "base",
      ]);
      const mergeBaseSha = runGit(workspace, ["rev-parse", "HEAD"]).trim();
      await writeFakeAstGrep(executableDirectory, [
        {
          path: "old.ts",
          language: "TypeScript",
          items: [
            {
              role: "item",
              symbolType: "function",
              name: "before",
              range: sourceRange(0, 2),
              signature: "function before() {",
              astKind: "function_declaration",
              isImport: false,
              isExported: false,
            },
          ],
        },
      ]);
      const source = reviewTestManifest();
      const file = source.files[0];
      if (!file) {
        throw new Error("expected a changed file");
      }

      const result = await analyzeDiffStructure({
        manifest: {
          ...source,
          mergeBaseSha,
          files: [
            {
              ...file,
              path: "new.ts",
              previousPath: "old.ts",
              status: "renamed",
              commentableRanges: file.commentableRanges.map((range) => ({
                ...range,
                path: "new.ts",
                side: "LEFT",
                startLine: 1,
                endLine: 2,
              })),
            },
          ],
        },
        workspace,
        env: pathWithExecutable(executableDirectory),
      });

      expect(result).toMatchObject({
        available: true,
        baseFiles: [
          {
            path: "old.ts",
            declarations: [{ qualifiedName: "before", startLine: 1, endLine: 3 }],
          },
        ],
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(executableDirectory, { recursive: true, force: true });
    }
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

async function writeContentAwareAstGrep(directory: string): Promise<void> {
  await writeFakeAstGrepBody(
    directory,
    [
      'const filePath = process.argv.at(-1) ?? "";',
      "const source = await Bun.file(filePath).text();",
      'const name = source.includes("RequestedHead") ? "RequestedHead" : "BaseDeclaration";',
      "process.stdout.write(JSON.stringify([{",
      "  path: filePath,",
      '  language: "TypeScript",',
      "  items: [{",
      '    role: "item",',
      '    symbolType: "function",',
      "    name,",
      "    range: { start: { line: 0, column: 0 }, end: { line: 0, column: 1 } },",
      "    isImport: false,",
      "    isExported: true,",
      "  }],",
      "}]));",
    ].join("\n"),
  );
}

async function writeCountingAstGrep(directory: string, callsPath: string): Promise<void> {
  const executable = path.join(directory, "ast-grep");
  await Bun.write(
    executable,
    [
      "#!/usr/bin/env bun",
      'import { appendFileSync } from "node:fs";',
      `appendFileSync(${JSON.stringify(callsPath)}, "call\\n");`,
      'if (process.argv.includes("--version")) {',
      '  process.stdout.write("ast-grep 0.44.1\\n");',
      "} else {",
      '  process.stdout.write("[]");',
      "}",
      "",
    ].join("\n"),
  );
  await chmod(executable, 0o755);
}

async function writeSlowGit(directory: string): Promise<void> {
  const executable = path.join(directory, "git");
  await Bun.write(
    executable,
    [
      "#!/usr/bin/env bun",
      "await Bun.sleep(400);",
      'process.stdout.write("export const value = 1;\\n");',
      "",
    ].join("\n"),
  );
  await chmod(executable, 0o755);
}

function git(repository: string, args: string[]): string {
  const result = Bun.spawnSync(["git", ...args], {
    cwd: repository,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(result.stderr.toString());
  }
  return result.stdout.toString();
}

function pathWithExecutable(directory: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PATH: `${directory}:${process.env.PATH ?? ""}`,
  };
}

function runGit(cwd: string, args: string[]): string {
  const result = Bun.spawnSync(["git", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(result.stderr.toString());
  }
  return result.stdout.toString();
}
