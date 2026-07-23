import { describe, expect, it } from "bun:test";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AgentTool, DiffManifest } from "@usepipr/sdk";
import { createDiffRangeIndex } from "../../diff/ranges.js";
import { createRuntimeLog } from "../../shared/logging.js";
import { memoryRuntimeLogSink } from "../../tests/helpers/runtime-log-sink.js";
import { extractPriorReviewState } from "../prior-state.js";
import {
  config,
  deepseekModel,
  defaultReviewAgent,
  defaultReviewPlan,
  expectOnlyInsideFinding,
  fallbackConfig,
  fallbackReviewPlan,
  finding,
  memoryTool,
  noFindingsPiResult,
  noFindingsPiRunner,
  overrideProvider,
  provider,
  providerFailurePiRunner,
  registerPiReviewTask,
  reviewPiResult,
  reviewTestManifestWithDocs,
  runRuntime,
  runWithInsideOutsideFindings,
  singleTaskPlan,
  testPlan,
} from "./task-runtime-fixtures.js";

describe("runTaskRuntime: Pi retries, fallbacks, tools, secrets, and publication limits", () => {
  it("schedules oversized core reviews into bounded manifest units", async () => {
    const prompts: string[] = [];
    const result = await runRuntime({
      plan: testPlan((pipr) => {
        pipr.review({
          id: "review",
          model: deepseekModel(pipr),
          instructions: "Review.",
          entrypoints: { command: false },
        });
      }),
      config: {
        ...config,
        limits: {
          diffManifest: {
            fullMaxBytes: 1,
            fullMaxEstimatedTokens: 1,
            condensedMaxBytes: 1_200,
            condensedMaxEstimatedTokens: 10_000,
          },
        },
      },
      diffManifestBuilder: () => reviewTestManifestWithDocs(),
      piRunner: async (options) => {
        prompts.push(options.prompt);
        return options.prompt.includes('"path": "docs/readme.md"')
          ? reviewPiResult([finding("docs defect", "docs-range-1", 1, "docs/readme.md")])
          : reviewPiResult([finding("source defect", "range-1", 10)]);
      },
    });

    expect(prompts).toHaveLength(2);
    expect(
      prompts.every(
        (prompt) =>
          !prompt.includes('"path": "src/a.ts"') || !prompt.includes('"path": "docs/readme.md"'),
      ),
    ).toBe(true);
    expect(result.validated.validFindings.map((item) => item.body)).toEqual([
      "source defect body",
      "docs defect body",
    ]);
  });

  it("keeps changed importers with their dependencies when sharding", async () => {
    const executableDirectory = await mkdtemp(path.join(os.tmpdir(), "pipr-ast-grep-"));
    try {
      await writeFakeAstGrepOutline(executableDirectory, [
        outlineFile("src/caller.ts", [
          outlineItem("./dependency.js", {
            isImport: true,
            symbolType: "module",
          }),
          outlineItem("run"),
        ]),
        outlineFile("src/unrelated.ts", [outlineItem("unrelated")]),
        outlineFile("src/dependency.ts", [outlineItem("dependency")]),
      ]);
      const prompts: string[] = [];

      await runRuntime({
        plan: testPlan((pipr) => {
          pipr.review({
            id: "review",
            model: deepseekModel(pipr),
            instructions: "Review.",
            entrypoints: { command: false },
          });
        }),
        config: {
          ...config,
          limits: {
            diffManifest: {
              fullMaxBytes: 1,
              fullMaxEstimatedTokens: 1,
              condensedMaxBytes: 2_200,
              condensedMaxEstimatedTokens: 10_000,
            },
          },
        },
        diffManifestBuilder: semanticShardingManifest,
        env: {
          ...process.env,
          PATH: `${executableDirectory}:${process.env.PATH ?? ""}`,
        },
        piRunner: async (options) => {
          prompts.push(options.prompt);
          return noFindingsPiResult();
        },
      });

      expect(prompts).toHaveLength(2);
      expect(
        prompts.some(
          (prompt) =>
            prompt.includes('"path": "src/caller.ts"') &&
            prompt.includes('"path": "src/dependency.ts"') &&
            !prompt.includes('"path": "src/unrelated.ts"'),
        ),
      ).toBe(true);
    } finally {
      await rm(executableDirectory, { recursive: true, force: true });
    }
  });

  it("keeps ast-grep import relationships across supported language path styles", async () => {
    const executableDirectory = await mkdtemp(path.join(os.tmpdir(), "pipr-ast-grep-"));
    try {
      const cases = [
        {
          language: "Python",
          importer: "python/caller.py",
          dependency: "python/dependency.py",
          unrelated: "python/unrelated.py",
          importedName: ".dependency",
        },
        {
          language: "Rust",
          importer: "rust/caller.rs",
          dependency: "rust/dependency.rs",
          unrelated: "rust/unrelated.rs",
          importedName: "crate::dependency::run",
        },
        {
          language: "Go",
          importer: "go/cmd/caller.go",
          dependency: "go/dependency/run.go",
          unrelated: "go/unrelated/run.go",
          importedName: "example.com/project/dependency",
        },
        {
          language: "Java",
          importer: "java/com/example/Caller.java",
          dependency: "java/com/example/Dependency.java",
          unrelated: "java/com/example/Unrelated.java",
          importedName: "com.example.Dependency",
        },
        {
          language: "C",
          importer: "c/caller.c",
          dependency: "c/include/dependency.h",
          unrelated: "c/include/unrelated.h",
          importedName: '"dependency.h"',
        },
      ];

      for (const testCase of cases) {
        await writeFakeAstGrepOutline(executableDirectory, [
          outlineFile(
            testCase.importer,
            [outlineItem(testCase.importedName, { isImport: true, symbolType: "module" })],
            testCase.language,
          ),
          outlineFile(testCase.unrelated, [outlineItem("unrelated")], testCase.language),
          outlineFile(testCase.dependency, [outlineItem("dependency")], testCase.language),
        ]);
        const prompts: string[] = [];

        await runRuntime({
          plan: defaultReviewPlan(),
          config: {
            ...config,
            limits: {
              diffManifest: {
                fullMaxBytes: 1,
                fullMaxEstimatedTokens: 1,
                condensedMaxBytes: 2_200,
                condensedMaxEstimatedTokens: 10_000,
              },
            },
          },
          diffManifestBuilder: () =>
            semanticShardingManifestForPaths(
              testCase.importer,
              testCase.unrelated,
              testCase.dependency,
            ),
          env: {
            ...process.env,
            PATH: `${executableDirectory}:${process.env.PATH ?? ""}`,
          },
          piRunner: async (options) => {
            prompts.push(options.prompt);
            return noFindingsPiResult();
          },
        });

        expect(prompts).toHaveLength(2);
        expect(
          prompts.some(
            (prompt) =>
              prompt.includes(`"path": "${testCase.importer}"`) &&
              prompt.includes(`"path": "${testCase.dependency}"`) &&
              !prompt.includes(`"path": "${testCase.unrelated}"`),
          ),
        ).toBe(true);
      }
    } finally {
      await rm(executableDirectory, { recursive: true, force: true });
    }
  });

  it("shards every review agent in multi-agent orchestration only when needed", async () => {
    const executableDirectory = await mkdtemp(path.join(os.tmpdir(), "pipr-ast-grep-"));
    try {
      const largeManifest = manyFileShardingManifest();
      await writeFakeAstGrepOutline(
        executableDirectory,
        largeManifest.files.map((file) => outlineFile(file.path, [outlineItem(file.path)])),
      );
      const plan = multiAgentShardingPlan();
      const smallPrompts: string[] = [];
      await runRuntime({
        plan,
        diffManifestBuilder: () => manyFileShardingManifest(2),
        env: {
          ...process.env,
          PATH: `${executableDirectory}:${process.env.PATH ?? ""}`,
        },
        piRunner: async (options) => {
          smallPrompts.push(options.prompt);
          return noFindingsPiResult();
        },
      });
      const largePrompts: string[] = [];
      await runRuntime({
        plan,
        config: manifestShardConfig(),
        diffManifestBuilder: () => largeManifest,
        env: {
          ...process.env,
          PATH: `${executableDirectory}:${process.env.PATH ?? ""}`,
        },
        piRunner: async (options) => {
          largePrompts.push(options.prompt);
          return noFindingsPiResult();
        },
      });

      for (const marker of multiAgentShardingMarkers) {
        const smallAgentPrompts = smallPrompts.filter((prompt) => prompt.includes(marker));
        expect(smallAgentPrompts).toHaveLength(1);
        expectPromptCoverage(smallAgentPrompts, 2);

        const largeAgentPrompts = largePrompts.filter((prompt) => prompt.includes(marker));
        expect(largeAgentPrompts).toHaveLength(4);
        expectPromptCoverage(largeAgentPrompts, 8);
      }
      expect(smallPrompts).toHaveLength(4);
      expect(largePrompts).toHaveLength(16);
    } finally {
      await rm(executableDirectory, { recursive: true, force: true });
    }
  });

  it("defaults automatic Diff Manifest fan-out to four shards", async () => {
    const prompts: string[] = [];

    await runRuntime({
      plan: defaultReviewPlan(),
      config: manifestShardConfig(),
      diffManifestBuilder: () => manyFileShardingManifest(),
      env: { ...process.env, PATH: "" },
      piRunner: async (options) => {
        prompts.push(options.prompt);
        return noFindingsPiResult();
      },
    });

    expect(prompts).toHaveLength(4);
    expectPromptCoverage(prompts, 8);
  });

  it("runs one complete condensed manifest when maxShards is one", async () => {
    const prompts: string[] = [];

    await runRuntime({
      plan: defaultReviewPlan(),
      config: manifestShardConfig(1),
      diffManifestBuilder: () => manyFileShardingManifest(),
      env: { ...process.env, PATH: "" },
      piRunner: async (options) => {
        prompts.push(options.prompt);
        return noFindingsPiResult();
      },
    });

    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain('"mode": "condensed"');
    expectPromptCoverage(prompts, 8);
  });

  it("preserves files, hunks, and ranges under the same AST and fallback shard cap", async () => {
    const executableDirectory = await mkdtemp(path.join(os.tmpdir(), "pipr-ast-grep-"));
    try {
      const manifest = manyFileShardingManifest();
      await writeFakeAstGrepOutline(
        executableDirectory,
        manifest.files.map((file) => outlineFile(file.path, [outlineItem(file.path)])),
      );

      for (const pathValue of [executableDirectory, ""]) {
        const prompts: string[] = [];
        await runRuntime({
          plan: defaultReviewPlan(),
          config: manifestShardConfig(2),
          diffManifestBuilder: () => manifest,
          env: { ...process.env, PATH: pathValue },
          piRunner: async (options) => {
            prompts.push(options.prompt);
            return noFindingsPiResult();
          },
        });

        expect(prompts).toHaveLength(2);
        expectPromptCoverage(prompts, 8);
      }
    } finally {
      await rm(executableDirectory, { recursive: true, force: true });
    }
  });

  it("keeps every capped single-file slice readable through its manifest path", async () => {
    const rangeIds = new Set<string>();

    await runRuntime({
      plan: defaultReviewPlan(),
      config: {
        ...config,
        limits: {
          diffManifest: {
            maxShards: 2,
            fullMaxBytes: 1,
            fullMaxEstimatedTokens: 1,
            condensedMaxBytes: 900,
            condensedMaxEstimatedTokens: 10_000,
          },
        },
      },
      diffManifestBuilder: manyHunkSingleFileManifest,
      env: { ...process.env, PATH: "" },
      piRunner: async (options) => {
        const manifest = options.runtimeTools?.manifest;
        if (!manifest) {
          throw new Error("expected condensed Diff Manifest runtime tools");
        }
        const paths = manifest.files.map((file) => file.path);
        expect(new Set(paths).size).toBe(paths.length);

        const ranges = createDiffRangeIndex(manifest);
        for (const file of manifest.files) {
          for (const range of file.commentableRanges) {
            expect(() =>
              ranges.requireRangeInFile(ranges.requireFile(file.path), range.id),
            ).not.toThrow();
            rangeIds.add(range.id);
          }
        }
        return noFindingsPiResult();
      },
    });

    expect([...rangeIds].sort()).toEqual(
      Array.from({ length: 8 }, (_, index) => `single-range-${index}`).sort(),
    );
  });

  it("warns when the shard cap requires oversized condensed prompts", async () => {
    const logs = memoryRuntimeLogSink();

    await runRuntime({
      plan: defaultReviewPlan(),
      config: {
        ...config,
        limits: {
          diffManifest: {
            maxShards: 2,
            fullMaxBytes: 1,
            fullMaxEstimatedTokens: 1,
            condensedMaxBytes: 900,
            condensedMaxEstimatedTokens: 10_000,
          },
        },
      },
      diffManifestBuilder: manyHunkSingleFileManifest,
      env: { ...process.env, PATH: "" },
      log: createRuntimeLog({ logSink: logs.logSink }),
      piRunner: noFindingsPiRunner(),
    });

    expect(logs.records).toContainEqual({
      level: "warning",
      event: "diff manifest shard cap requires oversized condensed prompts",
      fields: {
        maxShards: 2,
        uncappedShards: 8,
        oversizedShards: 2,
      },
    });
  });

  it("runs one complete condensed review for an oversized empty manifest", async () => {
    let calls = 0;

    await runRuntime({
      plan: defaultReviewPlan(),
      config: {
        ...config,
        limits: {
          diffManifest: {
            fullMaxBytes: 1,
            fullMaxEstimatedTokens: 1,
            condensedMaxBytes: 1,
            condensedMaxEstimatedTokens: 1,
          },
        },
      },
      diffManifestBuilder: () => ({ ...reviewTestManifestWithDocs(), files: [] }),
      piRunner: async (options) => {
        calls += 1;
        expect(options.runtimeTools?.manifest.files).toEqual([]);
        return noFindingsPiResult();
      },
    });

    expect(calls).toBe(1);
  });

  it("rejects invalid runtime Review Run and Diff Manifest fan-out limits", async () => {
    for (const limits of [
      { maxAgentRuns: 0 },
      { maxAgentRuns: 1.5 },
      { diffManifest: { maxShards: 0 } },
      { diffManifest: { maxShards: 1.5 } },
    ]) {
      await expect(
        runRuntime({
          plan: defaultReviewPlan(),
          config: {
            ...config,
            limits,
          },
          piRunner: noFindingsPiRunner(),
        }),
      ).rejects.toThrow();
    }
  });

  it("does not accept the removed sharding compatibility alias", async () => {
    await expect(
      runRuntime({
        plan: testPlan((pipr) => {
          pipr.review({
            id: "review",
            model: deepseekModel(pipr),
            instructions: "Review.",
            entrypoints: { command: false },
          });
        }),
        config: {
          ...config,
          limits: {
            diffManifest: {
              sharding: false,
            },
          },
        } as unknown as typeof config,
        piRunner: noFindingsPiRunner(),
      }),
    ).rejects.toThrow();
  });

  it("deduplicates only exact same-anchor findings from scheduled review units", async () => {
    let calls = 0;
    const result = await runRuntime({
      plan: testPlan((pipr) => {
        pipr.review({
          id: "review",
          model: deepseekModel(pipr),
          instructions: "Review.",
          entrypoints: { command: false },
        });
      }),
      config: {
        ...config,
        limits: {
          diffManifest: {
            fullMaxBytes: 1,
            fullMaxEstimatedTokens: 1,
            condensedMaxBytes: 1_200,
            condensedMaxEstimatedTokens: 10_000,
          },
        },
      },
      diffManifestBuilder: () => reviewTestManifestWithDocs(),
      piRunner: async () => {
        calls += 1;
        return reviewPiResult(
          calls === 1
            ? [
                {
                  ...finding("discarded config", "range-1", 10),
                  body: "`config` is copied and `schedule_type` is replaced with its display value, but the return statement uses the original unmodified monitor config. The modified copy is discarded, so the integer is emitted instead of the display string.",
                },
                {
                  ...finding("wrong cleanup", "range-1", 10),
                  body: "The cleanup branch removes the active cache entry instead of the expired entry, so stale state remains reachable.",
                },
              ]
            : [
                {
                  ...finding("discarded config", "range-1", 10),
                  body: "`config` is copied and `schedule_type` is replaced with its display value, but the return statement uses the original unmodified monitor config. The modified copy is discarded, so the integer is emitted instead of the display string.",
                },
                {
                  ...finding("discarded config", "range-1", 10),
                  body: "`config` is copied and `schedule_type` is replaced with its display value, but the return dictionary uses the original monitor config instead of the modified copy. The integer reaches the issue event instead of the display string.",
                },
              ],
        );
      },
    });

    expect(result.validated.validFindings.map((item) => item.body)).toEqual([
      "`config` is copied and `schedule_type` is replaced with its display value, but the return statement uses the original unmodified monitor config. The modified copy is discarded, so the integer is emitted instead of the display string.",
      "The cleanup branch removes the active cache entry instead of the expired entry, so stale state remains reachable.",
      "`config` is copied and `schedule_type` is replaced with its display value, but the return dictionary uses the original monitor config instead of the modified copy. The integer reaches the issue event instead of the display string.",
    ]);
  });

  it("preserves a shared summary title across scheduled review units", async () => {
    let observedTitle: string | undefined;
    const plan = testPlan((pipr) => {
      const agent = defaultReviewAgent(pipr);
      const task = pipr.task({
        name: "review",
        async run(ctx) {
          const result = await ctx.pi.run(agent, { manifest: await ctx.change.diffManifest() });
          observedTitle = result.summary.title;
          await ctx.comment(result.summary.body);
        },
      });
      pipr.on.changeRequest({ actions: ["opened"], task });
    });

    await runRuntime({
      plan,
      config: {
        ...config,
        limits: {
          diffManifest: {
            fullMaxBytes: 1,
            fullMaxEstimatedTokens: 1,
            condensedMaxBytes: 1_200,
            condensedMaxEstimatedTokens: 10_000,
          },
        },
      },
      diffManifestBuilder: () => reviewTestManifestWithDocs(),
      piRunner: async () => ({
        ...noFindingsPiResult(),
        stdout: JSON.stringify({
          summary: { title: "Shared title", body: "No findings." },
          inlineFindings: [],
        }),
      }),
    });

    expect(observedTitle).toBe("Shared title");
  });

  it("keeps fitting core reviews on one Pi call", async () => {
    let calls = 0;
    await runRuntime({
      plan: testPlan((pipr) => {
        pipr.review({
          id: "review",
          model: deepseekModel(pipr),
          instructions: "Review.",
          entrypoints: { command: false },
        });
      }),
      diffManifestBuilder: () => reviewTestManifestWithDocs(),
      piRunner: async () => {
        calls += 1;
        return noFindingsPiResult();
      },
    });

    expect(calls).toBe(1);
  });

  it("preserves provider output when a core review schedules one manifest", async () => {
    let observedFindingCount = 0;
    const plan = testPlan((pipr) => {
      const agent = defaultReviewAgent(pipr);
      const task = pipr.task({
        name: "review",
        async run(ctx) {
          const result = await ctx.pi.run(agent, { manifest: await ctx.change.diffManifest() });
          observedFindingCount = result.inlineFindings.length;
          await ctx.comment(result.summary.body);
        },
      });
      pipr.on.changeRequest({ actions: ["opened"], task });
    });
    const duplicate = finding("same provider finding", "range-1", 10);

    await runRuntime({
      plan,
      diffManifestBuilder: () => reviewTestManifestWithDocs(),
      piRunner: async () => reviewPiResult([duplicate, duplicate]),
    });

    expect(observedFindingCount).toBe(2);
  });

  it("splits one oversized file across complete multi-hunk ranges", async () => {
    const prompts: string[] = [];
    const baseManifest = reviewTestManifestWithDocs();
    const source = baseManifest.files[0];
    if (!source) {
      throw new Error("expected a source file in the review test manifest");
    }
    const manifest = {
      ...baseManifest,
      files: [
        {
          ...source,
          hunks: [
            ...source.hunks,
            {
              hunkIndex: 2,
              header: "@@ -29,1 +30,1 @@",
              oldStart: 29,
              oldLines: 1,
              newStart: 30,
              newLines: 1,
              contentHash: "feedfacecafe",
            },
          ],
          commentableRanges: [
            ...source.commentableRanges,
            {
              id: "range-3",
              path: source.path,
              side: "RIGHT" as const,
              startLine: 30,
              endLine: 30,
              kind: "added" as const,
              hunkIndex: 2,
              hunkHeader: "@@ -29,1 +30,1 @@",
              hunkContentHash: "feedfacecafe",
              preview: "return updated;",
            },
          ],
        },
        ...baseManifest.files.slice(1),
      ],
    };
    await runRuntime({
      plan: defaultReviewPlan(),
      config: {
        ...config,
        limits: {
          diffManifest: {
            fullMaxBytes: 1,
            fullMaxEstimatedTokens: 1,
            condensedMaxBytes: 900,
            condensedMaxEstimatedTokens: 10_000,
          },
        },
      },
      diffManifestBuilder: () => manifest,
      piRunner: async (options) => {
        prompts.push(options.prompt);
        return noFindingsPiResult();
      },
    });

    expect(prompts).toHaveLength(4);
    expect(prompts.filter((prompt) => prompt.includes('"id": "range-1"'))).toHaveLength(1);
    expect(prompts.filter((prompt) => prompt.includes('"id": "range-2"'))).toHaveLength(1);
    expect(prompts.filter((prompt) => prompt.includes('"id": "range-3"'))).toHaveLength(1);
    expect(prompts.filter((prompt) => prompt.includes('"path": "docs/readme.md"'))).toHaveLength(1);
  });

  it("uses agent timeout when running Pi", async () => {
    let observedTimeout: number | undefined;
    const plan = testPlan((pipr) => {
      const agent = defaultReviewAgent(pipr, { timeout: "5m" });
      registerPiReviewTask(pipr, agent);
    });

    await runRuntime({
      plan,
      piRunner: async (options) => {
        observedTimeout = options.timeoutSeconds;
        return noFindingsPiResult();
      },
    });

    expect(observedTimeout).toBe(300);
  });

  it("retries once when Pi returns invalid review JSON", async () => {
    let calls = 0;

    const result = await runRuntime({
      plan: defaultReviewPlan(),
      piRunner: async () => {
        calls += 1;
        return calls === 1
          ? { exitCode: 0, stdout: "{", stderr: "", durationMs: 1 }
          : noFindingsPiResult();
      },
    });

    expect(calls).toBe(2);
    expect(result.repairAttempted).toBe(true);
  });

  it("accepts review JSON wrapped in a Markdown code fence", async () => {
    let calls = 0;

    const result = await runRuntime({
      plan: defaultReviewPlan(),
      piRunner: async () => {
        calls += 1;
        return {
          ...noFindingsPiResult(),
          stdout: `\`\`\`json\n${noFindingsPiResult().stdout}\n\`\`\``,
        };
      },
    });

    expect(calls).toBe(1);
    expect(result.repairAttempted).toBe(false);
  });

  it("rejects review JSON surrounded by provider prose", async () => {
    let calls = 0;

    await expect(
      runRuntime({
        plan: defaultReviewPlan(),
        piRunner: async () => {
          calls += 1;
          return {
            ...noFindingsPiResult(),
            stdout: `The review result is:\n${noFindingsPiResult().stdout}\nNo further comments.`,
          };
        },
      }),
    ).rejects.toThrow("Pi output failed schema validation");
    expect(calls).toBe(2);
  });

  it("rejects unsupported core review fields returned by Pi", async () => {
    let calls = 0;

    await expect(
      runRuntime({
        plan: defaultReviewPlan(),
        piRunner: async () => {
          calls += 1;
          return {
            exitCode: 0,
            stdout: JSON.stringify({
              summary: { body: "Review." },
              inlineFindings: [{ ...finding("unsupported id", "range-1", 10), id: "finding-1" }],
            }),
            stderr: "",
            durationMs: 1,
          };
        },
      }),
    ).rejects.toThrow("Pi output failed schema validation");
    expect(calls).toBe(2);
  });

  it("uses run model and fallbacks in order", async () => {
    const calls: string[] = [];
    const plan = fallbackReviewPlan({ agentModel: "fallback", runOverridesModel: true });

    await runRuntime({
      config: fallbackConfig,
      plan,
      piRunner: providerFailurePiRunner(calls),
    });

    expect(calls).toEqual(["deepseek-v4-pro", "fallback-model"]);
  });

  it("uses provider override without model fallback selection", async () => {
    const calls: string[] = [];
    const plan = fallbackReviewPlan();

    await runRuntime({
      config: fallbackConfig,
      plan,
      providerOverride: overrideProvider,
      piRunner: async (options) => {
        calls.push(options.provider.model);
        return noFindingsPiResult();
      },
    });

    expect(calls).toEqual(["override-model"]);
  });

  it("runs invalid-output repair attempts per model before falling back", async () => {
    const calls: string[] = [];
    const plan = fallbackReviewPlan();

    const result = await runRuntime({
      config: fallbackConfig,
      plan,
      piRunner: async (options) => {
        calls.push(options.provider.model);
        return options.provider.id === "deepseek/deepseek-v4-pro"
          ? { exitCode: 0, stdout: "{", stderr: "", durationMs: 1 }
          : noFindingsPiResult();
      },
    });

    expect(calls).toEqual(["deepseek-v4-pro", "deepseek-v4-pro", "fallback-model"]);
    expect(result.repairAttempted).toBe(true);
  });

  it("aggregates review stats across repair and fallback Pi runs", async () => {
    let call = 0;
    const result = await runRuntime({
      config: fallbackConfig,
      plan: fallbackReviewPlan(),
      piRunner: async () => {
        call += 1;
        const common = {
          stderr: "",
          durationMs: 60_000,
          models: [call < 3 ? "primary-response-model" : "fallback-response-model"],
          usage: {
            status: "complete" as const,
            inputTokens: call * 100,
            outputTokens: call * 10,
            costUsd: call * 0.001,
          },
        };
        return call < 3
          ? { ...common, exitCode: 0, stdout: "{" }
          : { ...common, ...noFindingsPiResult() };
      },
    });
    if (result.kind !== "review") {
      throw new Error(`expected review, received ${result.kind}`);
    }

    expect(result.publicationPlan.metadata.stats).toEqual({
      models: ["primary-response-model", "fallback-response-model"],
      agentRuns: 3,
      durationMs: expect.any(Number),
      inputTokens: 600,
      outputTokens: 60,
      costUsd: 0.006,
      usageStatus: "complete",
    });
    expect(result.run).toMatchObject({
      models: ["deepseek-v4-pro", "fallback-model"],
      agentRuns: 3,
      inputTokens: 600,
      outputTokens: 60,
      costUsd: 0.006,
      usageStatus: "complete",
    });
    expect(result.publicationPlan.metadata.stats?.durationMs).toBeLessThan(60_000);
    expect(result.mainComment).toContain("<summary>Review stats</summary>");
  });

  it("keeps aggregate usage safe when reported run totals overflow", async () => {
    let call = 0;
    const result = await runRuntime({
      config: fallbackConfig,
      plan: fallbackReviewPlan(),
      piRunner: async () => {
        call += 1;
        const telemetry = {
          stderr: "",
          durationMs: 1,
          models: ["reported-model"],
          usage: {
            status: "complete" as const,
            inputTokens: Number.MAX_SAFE_INTEGER,
            outputTokens: 1,
            costUsd: 0.001,
          },
        };
        return call < 3
          ? { ...telemetry, exitCode: 0, stdout: "{" }
          : { ...telemetry, ...noFindingsPiResult() };
      },
    });

    expect(result.publicationPlan.metadata.stats).toMatchObject({
      inputTokens: Number.MAX_SAFE_INTEGER,
      outputTokens: 3,
      costUsd: 0.003,
      usageStatus: "partial",
    });
  });

  it("bounds reported model telemetry before publication", async () => {
    const secretModel = "model-api_key-abcdefghijklmnop";
    const oversizedModel = "m".repeat(500);
    const result = await runRuntime({
      config: fallbackConfig,
      plan: fallbackReviewPlan(),
      piRunner: async () => ({
        ...noFindingsPiResult(),
        models: [
          secretModel,
          oversizedModel,
          ...Array.from({ length: 25 }, (_, index) => `model-${index}`),
        ],
      }),
    });

    const models = result.publicationPlan.metadata.stats?.models ?? [];
    expect(models).toHaveLength(20);
    expect(models[0]).toBe(secretModel);
    expect(models[1]).toBe("m".repeat(200));
    expect(result.mainComment).toContain(secretModel);
  });

  it("falls back to the requested model when reported models are blank", async () => {
    const result = await runRuntime({
      plan: fallbackReviewPlan(),
      config: fallbackConfig,
      piRunner: async () => ({ ...noFindingsPiResult(), models: ["   "] }),
    });

    expect(result.publicationPlan.metadata.stats?.models).toEqual(["deepseek-v4-pro"]);
  });

  it("aggregates Pi runs from parallel Review Tasks", async () => {
    const plan = testPlan((pipr) => {
      const agent = defaultReviewAgent(pipr);
      const first = pipr.task({
        name: "first",
        async run(ctx) {
          await ctx.pi.run(agent, { manifest: await ctx.change.diffManifest() });
        },
      });
      const second = pipr.task({
        name: "second",
        async run(ctx) {
          await ctx.pi.run(agent, { manifest: await ctx.change.diffManifest() });
          await ctx.comment("Parallel review complete.");
        },
      });
      pipr.on.changeRequest({ actions: ["opened"], task: first });
      pipr.on.changeRequest({ actions: ["opened"], task: second });
    });

    let call = 0;
    const result = await runRuntime({
      plan,
      piRunner: async () => {
        call += 1;
        if (call === 1) {
          await Bun.sleep(20);
          return { ...noFindingsPiResult(), models: ["first-task-model"] };
        }
        return { ...noFindingsPiResult(), models: ["second-task-model"] };
      },
    });

    expect(result.publicationPlan.metadata.stats).toMatchObject({
      models: ["second-task-model", "first-task-model"],
      agentRuns: 2,
      usageStatus: "unavailable",
    });
  });

  it("reserves maxAgentRuns atomically across parallel Review Tasks", async () => {
    const release = Promise.withResolvers<void>();
    let calls = 0;
    const plan = testPlan((pipr) => {
      const agent = defaultReviewAgent(pipr);
      const first = pipr.task({
        name: "first",
        async run(ctx) {
          await ctx.pi.run(agent, { manifest: await ctx.change.diffManifest() });
        },
      });
      const second = pipr.task({
        name: "second",
        async run(ctx) {
          await ctx.pi.run(agent, { manifest: await ctx.change.diffManifest() });
          await ctx.comment("Parallel review complete.");
        },
      });
      pipr.on.changeRequest({ actions: ["opened"], task: first });
      pipr.on.changeRequest({ actions: ["opened"], task: second });
    });

    const run = runRuntime({
      plan,
      config: { ...config, limits: { maxAgentRuns: 1 } },
      piRunner: async () => {
        calls += 1;
        await release.promise;
        return noFindingsPiResult();
      },
    });
    await Bun.sleep(20);
    const callsBeforeRelease = calls;
    release.resolve();

    await expect(run).rejects.toThrow(
      "Review Run agent-call budget exhausted after 1 provider invocations",
    );
    expect(callsBeforeRelease).toBe(1);
    expect(calls).toBe(1);
  });

  it("keeps provider invocations unlimited when maxAgentRuns is omitted", async () => {
    let calls = 0;
    const plan = testPlan((pipr) => {
      const agent = defaultReviewAgent(pipr);
      const task = pipr.task({
        name: "review",
        async run(ctx) {
          for (let index = 0; index < 5; index += 1) {
            await ctx.pi.run(agent, { manifest: await ctx.change.diffManifest() });
          }
          await ctx.comment("Unlimited review complete.");
        },
      });
      pipr.on.changeRequest({ actions: ["opened"], task });
    });

    const result = await runRuntime({
      plan,
      piRunner: async () => {
        calls += 1;
        return noFindingsPiResult();
      },
    });

    expect(calls).toBe(5);
    expect(result.publicationPlan.metadata.stats?.agentRuns).toBe(5);
  });

  it("accumulates review stats across reruns of the same Review Tasks", async () => {
    const first = await runRuntime({
      plan: defaultReviewPlan(),
      piRunner: async () => ({
        ...noFindingsPiResult(),
        models: ["first-run-model"],
        usage: {
          status: "complete" as const,
          inputTokens: 100,
          outputTokens: 10,
          costUsd: 0.001,
        },
      }),
    });
    const second = await runRuntime({
      plan: defaultReviewPlan(),
      config: {
        ...fallbackConfig,
        publication: { ...fallbackConfig.publication, showStats: false },
      },
      priorReviewState: extractPriorReviewState(first.mainComment, 1),
      piRunner: async () => ({
        ...noFindingsPiResult(),
        models: ["second-run-model"],
        usage: {
          status: "complete" as const,
          inputTokens: 200,
          outputTokens: 20,
          costUsd: 0.002,
        },
      }),
    });

    expect(second.publicationPlan.metadata.stats).toMatchObject({
      models: ["first-run-model", "second-run-model"],
      agentRuns: 2,
      inputTokens: 300,
      outputTokens: 30,
      costUsd: 0.003,
      usageStatus: "complete",
    });
    expect(second.publicationPlan.reviewState.stats).toEqual(second.publicationPlan.metadata.stats);
    expect(second.mainComment).not.toContain("<summary>Review stats</summary>");

    const third = await runRuntime({
      plan: defaultReviewPlan(),
      priorReviewState: extractPriorReviewState(second.mainComment, 1),
      piRunner: async () => ({
        ...noFindingsPiResult(),
        models: ["third-run-model"],
        usage: {
          status: "complete" as const,
          inputTokens: 300,
          outputTokens: 30,
          costUsd: 0.003,
        },
      }),
    });

    expect(third.publicationPlan.metadata.stats).toMatchObject({
      models: ["first-run-model", "second-run-model", "third-run-model"],
      agentRuns: 3,
      inputTokens: 600,
      outputTokens: 60,
      costUsd: 0.006,
      usageStatus: "complete",
    });
    expect(third.mainComment).toContain("<summary>Review stats</summary>");
  });

  it("marks cumulative usage partial when an earlier rerun did not report usage", async () => {
    const first = await runRuntime({
      plan: defaultReviewPlan(),
      piRunner: async () => ({ ...noFindingsPiResult(), models: ["unreported-model"] }),
    });
    const second = await runRuntime({
      plan: defaultReviewPlan(),
      priorReviewState: extractPriorReviewState(first.mainComment, 1),
      piRunner: async () => ({
        ...noFindingsPiResult(),
        models: ["reported-model"],
        usage: {
          status: "complete" as const,
          inputTokens: 200,
          outputTokens: 20,
          costUsd: 0.002,
        },
      }),
    });

    expect(second.publicationPlan.metadata.stats).toMatchObject({
      agentRuns: 2,
      inputTokens: 200,
      outputTokens: 20,
      costUsd: 0.002,
      usageStatus: "partial",
    });
  });

  it("counts rejected Pi attempts as partial usage before retrying", async () => {
    let call = 0;
    const result = await runRuntime({
      config: { ...fallbackConfig, limits: { maxAgentRuns: 2 } },
      plan: fallbackReviewPlan({ agentPatch: { retry: { transientFailure: 1 } } }),
      piRunner: async () => {
        call += 1;
        if (call === 1) {
          throw new Error("temporary failure");
        }
        return {
          ...noFindingsPiResult(),
          models: ["primary-response-model"],
          usage: {
            status: "complete" as const,
            inputTokens: 100,
            outputTokens: 10,
            costUsd: 0.001,
          },
        };
      },
    });

    expect(result.publicationPlan.metadata.stats).toMatchObject({
      models: ["deepseek-v4-pro", "primary-response-model"],
      agentRuns: 2,
      inputTokens: 100,
      outputTokens: 10,
      costUsd: 0.001,
      usageStatus: "partial",
    });
  });

  it("retries transient failures per model before falling back", async () => {
    const calls: string[] = [];
    const plan = fallbackReviewPlan({ agentPatch: { retry: { transientFailure: 1 } } });

    await runRuntime({
      config: fallbackConfig,
      plan,
      piRunner: providerFailurePiRunner(calls),
    });

    expect(calls).toEqual(["deepseek-v4-pro", "deepseek-v4-pro", "fallback-model"]);
  });

  it("counts shards, transient retries, repairs, and fallbacks against maxAgentRuns", async () => {
    let calls = 0;
    const limitedConfig = {
      ...manifestShardConfig(2),
      providers: fallbackConfig.providers,
      limits: {
        ...manifestShardConfig(2).limits,
        maxAgentRuns: 4,
      },
    };

    await expect(
      runRuntime({
        config: limitedConfig,
        plan: fallbackReviewPlan({
          agentPatch: { retry: { invalidOutput: 1, transientFailure: 1 } },
        }),
        diffManifestBuilder: () => manyFileShardingManifest(),
        env: { ...process.env, PATH: "" },
        piRunner: async () => {
          calls += 1;
          if (calls === 1) {
            throw new Error("temporary provider failure");
          }
          if (calls < 4) {
            return { ...noFindingsPiResult(), stdout: "{" };
          }
          return noFindingsPiResult();
        },
      }),
    ).rejects.toThrow("Review Run agent-call budget exhausted after 4 provider invocations");

    expect(calls).toBe(4);
  });

  it("does not fall back when the primary model returns a valid empty review", async () => {
    const calls: string[] = [];
    const plan = fallbackReviewPlan();

    await runRuntime({
      config: fallbackConfig,
      plan,
      piRunner: async (options) => {
        calls.push(options.provider.model);
        if (options.provider.id === "fallback") {
          throw new Error("fallback should not run");
        }
        return noFindingsPiResult();
      },
    });

    expect(calls).toEqual(["deepseek-v4-pro"]);
  });

  it("passes registered custom Pi tools to the runner", async () => {
    let observedToolNames: readonly string[] = [];
    let observedToolResult: unknown;
    const plan = testPlan((pipr) => {
      const customTool = memoryTool(pipr);
      registerPiReviewTask(
        pipr,
        defaultReviewAgent(pipr, { tools: [...pipr.tools.readOnly, customTool] }),
      );
    });

    await runRuntime({
      plan,
      piRunner: async (options) => {
        observedToolNames = options.customTools?.tools.map((tool) => tool.name) ?? [];
        observedToolResult = await options.customTools?.tools[0]?.execute(
          options.customTools.context,
          { body: "Remember this." },
        );
        return noFindingsPiResult();
      },
    });

    expect(observedToolNames).toEqual(["custom_tool"]);
    expect(observedToolResult).toEqual({ body: "Remember this." });
  });

  it("fails closed when a custom tool forges the readOnly name", () => {
    expect(() =>
      testPlan((pipr) => {
        registerPiReviewTask(
          pipr,
          defaultReviewAgent(pipr, {
            tools: [{ kind: "pipr.tool", name: "readOnly" } as AgentTool],
          }),
        );
      }),
    ).toThrow("Expected a tool handle created by pipr.tool");
  });

  it("fails closed when an agent copies a registered custom tool handle", () => {
    expect(() =>
      testPlan((pipr) => {
        const customTool = memoryTool(pipr);
        const copiedTool = { ...customTool } as AgentTool;
        registerPiReviewTask(pipr, defaultReviewAgent(pipr, { tools: [copiedTool] }));
      }),
    ).toThrow("Expected a tool handle created by pipr.tool");
  });

  it("renders custom task details through ctx.comment markdown", async () => {
    const plan = singleTaskPlan({
      name: "metadata",
      async run(ctx) {
        await ctx.comment(JSON.stringify({ status: "ok" }));
      },
    });

    const result = await runRuntime({
      plan,
    });

    expect(result.mainComment).toContain('"status":"ok"');
  });

  it("resolves declared task secrets from runtime env", async () => {
    let observedSecret: string | undefined;
    const plan = testPlan((pipr) => {
      const token = pipr.secret({ name: "CUSTOM_TOOL_TOKEN" });
      const task = pipr.task({
        name: "secret-task",
        async run(ctx) {
          observedSecret = ctx.secret(token);
          await ctx.comment("secret resolved");
        },
      });
      pipr.on.changeRequest({ actions: ["opened"], task });
    });

    await runRuntime({
      plan,
      env: { CUSTOM_TOOL_TOKEN: "resolved-token" },
    });

    expect(observedSecret).toBe("resolved-token");
  });

  it("fails when a declared task secret is missing", async () => {
    const plan = testPlan((pipr) => {
      const token = pipr.secret({ name: "CUSTOM_TOOL_TOKEN" });
      const task = pipr.task({
        name: "secret-task",
        async run(ctx) {
          ctx.secret(token);
          await ctx.comment("secret resolved");
        },
      });
      pipr.on.changeRequest({ actions: ["opened"], task });
    });

    await expect(runRuntime({ plan, env: {} })).rejects.toThrow(
      "Missing secret env var: CUSTOM_TOOL_TOKEN",
    );
  });

  it("rejects multiple selected review recipes that emit comments", async () => {
    const plan = testPlan((pipr) => {
      const model = deepseekModel(pipr);
      pipr.review({
        id: "correctness",
        model,
        instructions: "Review correctness.",
        entrypoints: { command: false },
      });
      pipr.review({
        id: "security",
        model,
        instructions: "Review security.",
        entrypoints: { command: false },
      });
    });

    await expect(runRuntime({ plan, piRunner: noFindingsPiRunner() })).rejects.toThrow(
      "ctx.comment(...) may be called once per selected run",
    );
  });

  it("skips scoped pipr.review Pi calls when no changed files match", async () => {
    const plan = testPlan((pipr) => {
      pipr.review({
        id: "review",
        model: deepseekModel(pipr),
        instructions: "Review docs.",
        paths: { include: ["docs/**"] },
        entrypoints: { command: false },
      });
    });

    const result = await runRuntime({
      plan,
      priorMainComment: [
        "<!-- pipr:main-comment change=1 version=1 state=bad -->",
        "",
        "# pipr Review",
        "",
        "Stale scoped review.",
      ].join("\n"),
      piRunner: async () => {
        throw new Error("Pi should not run when the scoped manifest is empty");
      },
    });

    expect(result.review.inlineFindings).toEqual([]);
    expect(result.mainComment).not.toContain("Stale scoped review.");
    expect(result.publicationPlan.metadata.providerModels).toEqual([provider.model]);
    expect(result.taskChecks).toEqual([
      {
        taskName: "review",
        conclusion: "neutral",
        summary: "No changed files matched this review's path scope.",
      },
    ]);
  });

  it("enforces pipr.review paths against model findings", async () => {
    const plan = testPlan((pipr) => {
      pipr.review({
        id: "review",
        model: deepseekModel(pipr),
        instructions: "Review source.",
        paths: { include: ["src/**"] },
        entrypoints: { command: false },
      });
    });

    const result = await runWithInsideOutsideFindings(plan);

    expectOnlyInsideFinding(result);
  });

  it("honors publication maxInlineComments 0 for default comments", async () => {
    const plan = testPlan((pipr) => {
      pipr.config({ publication: { maxInlineComments: 0 } });
      pipr.review({
        id: "review",
        model: deepseekModel(pipr),
        instructions: "Review source.",
        entrypoints: { command: false },
      });
    });

    const result = await runRuntime({
      plan,
      config: { ...config, publication: { ...config.publication, maxInlineComments: 0 } },
      piRunner: async () => reviewPiResult([finding("hidden", "range-1", 10)]),
    });

    expect(result.review.inlineFindings).toHaveLength(1);
    expect(result.inlineCommentDrafts).toEqual([]);
    expect(result.publicationPlan.inlineItems).toEqual([]);
    expect(result.publicationPlan.metadata.cappedInlineFindings).toBe(1);
    expect(result.mainComment).toContain("hidden");
  });

  it("honors publication maxStoredFindings 0 without hiding current findings", async () => {
    const plan = testPlan((pipr) => {
      pipr.config({ publication: { maxStoredFindings: 0 } });
      pipr.review({
        id: "review",
        model: deepseekModel(pipr),
        instructions: "Review source.",
        entrypoints: { command: false },
      });
    });

    const result = await runRuntime({
      plan,
      config: { ...config, publication: { ...config.publication, maxStoredFindings: 0 } },
      piRunner: async () => reviewPiResult([finding("retained for this run", "range-1", 10)]),
    });

    expect(result.review.inlineFindings).toHaveLength(1);
    expect(result.inlineCommentDrafts).toHaveLength(1);
    expect(extractPriorReviewState(result.mainComment, 1)?.findings).toEqual([]);
  });
});

function semanticShardingManifest(): DiffManifest {
  return semanticShardingManifestForPaths("src/caller.ts", "src/unrelated.ts", "src/dependency.ts");
}

const multiAgentShardingMarkers = [
  "SECURITY_MULTI_AGENT",
  "TESTS_MULTI_AGENT",
  "MAINTAINABILITY_MULTI_AGENT",
  "AGGREGATOR_MULTI_AGENT",
] as const;

function multiAgentShardingPlan() {
  return testPlan((pipr) => {
    const model = deepseekModel(pipr);
    const security = defaultReviewAgent(pipr, {
      name: "security-multi-agent",
      model,
      instructions: multiAgentShardingMarkers[0],
      prompt: () => multiAgentShardingMarkers[0],
    });
    const tests = defaultReviewAgent(pipr, {
      name: "tests-multi-agent",
      model,
      instructions: multiAgentShardingMarkers[1],
      prompt: () => multiAgentShardingMarkers[1],
    });
    const maintainability = defaultReviewAgent(pipr, {
      name: "maintainability-multi-agent",
      model,
      instructions: multiAgentShardingMarkers[2],
      prompt: () => multiAgentShardingMarkers[2],
    });
    const aggregator = pipr.agent({
      name: "aggregator-multi-agent",
      model,
      instructions: multiAgentShardingMarkers[3],
      output: pipr.schemas.review,
      prompt: (_input: { manifest: unknown; specialistResults: unknown }) =>
        multiAgentShardingMarkers[3],
    });
    const task = pipr.task({
      name: "multi-agent-sharding",
      async run(ctx) {
        const manifest = await ctx.change.diffManifest();
        const [securityResult, testResult, maintainabilityResult] = await Promise.all([
          ctx.pi.run(security, { manifest }),
          ctx.pi.run(tests, { manifest }),
          ctx.pi.run(maintainability, { manifest }),
        ]);
        const result = await ctx.pi.run(aggregator, {
          manifest,
          specialistResults: { securityResult, testResult, maintainabilityResult },
        });
        await ctx.comment({
          main: result.summary.body,
          inlineFindings: result.inlineFindings,
        });
      },
    });
    pipr.on.changeRequest({ actions: ["opened"], task });
  });
}

function semanticShardingManifestForPaths(
  importer: string,
  unrelated: string,
  dependency: string,
): DiffManifest {
  return {
    baseSha: "base",
    headSha: "head",
    mergeBaseSha: "base",
    files: [
      semanticShardingFile(importer, 1),
      semanticShardingFile(unrelated, 2),
      semanticShardingFile(dependency, 3),
    ],
  };
}

function semanticShardingFile(filePath: string, hunkIndex: number): DiffManifest["files"][number] {
  const contentHash = `00000000000${hunkIndex}`;
  const header = "@@ -1,1 +1,1 @@";
  return {
    path: filePath,
    status: "modified",
    additions: 1,
    deletions: 0,
    hunks: [
      {
        hunkIndex,
        header,
        oldStart: 1,
        oldLines: 1,
        newStart: 1,
        newLines: 1,
        contentHash,
      },
    ],
    commentableRanges: [
      {
        id: `range-${hunkIndex}`,
        path: filePath,
        side: "RIGHT",
        startLine: 1,
        endLine: 1,
        kind: "added",
        hunkIndex,
        hunkHeader: header,
        hunkContentHash: contentHash,
        preview: `changed ${filePath}`,
      },
    ],
  };
}

function outlineFile(filePath: string, items: unknown[], language = "TypeScript") {
  return { path: filePath, language, items };
}

function outlineItem(name: string, options: { isImport?: boolean; symbolType?: string } = {}) {
  return {
    role: "item",
    symbolType: options.symbolType ?? "function",
    name,
    range: {
      byteOffset: { start: 0, end: 10 },
      start: { line: 0, column: 0 },
      end: { line: 0, column: 10 },
    },
    signature: options.isImport ? `import "${name}";` : `function ${name}()`,
    astKind: options.isImport ? "import_statement" : "function_declaration",
    isImport: options.isImport ?? false,
    isExported: !options.isImport,
  };
}

async function writeFakeAstGrepOutline(directory: string, output: unknown): Promise<void> {
  const executable = path.join(directory, "ast-grep");
  await Bun.write(
    executable,
    `#!/usr/bin/env bun\nprocess.stdout.write(${JSON.stringify(JSON.stringify(output))});\n`,
  );
  await chmod(executable, 0o755);
}

function manifestShardConfig(maxShards?: number) {
  return {
    ...config,
    limits: {
      diffManifest: {
        ...(maxShards === undefined ? {} : { maxShards }),
        fullMaxBytes: 1,
        fullMaxEstimatedTokens: 1,
        condensedMaxBytes: 1_200,
        condensedMaxEstimatedTokens: 10_000,
      },
    },
  };
}

function manyFileShardingManifest(fileCount = 8): DiffManifest {
  const manifest = reviewTestManifestWithDocs();
  const seedFile = manifest.files[0];
  if (!seedFile) {
    throw new Error("expected a changed file");
  }
  return {
    ...manifest,
    files: Array.from({ length: fileCount }, (_, index) => {
      const filePath = `src/file-${index}.ts`;
      const contentHash = index.toString(16).padStart(12, "0");
      return {
        ...seedFile,
        path: filePath,
        hunks: seedFile.hunks.map((hunk) => ({ ...hunk, contentHash })),
        commentableRanges: seedFile.commentableRanges.map((range, rangeIndex) => ({
          ...range,
          id: `range-${index}-${rangeIndex}`,
          path: filePath,
          hunkContentHash: contentHash,
        })),
      };
    }),
  };
}

function manyHunkSingleFileManifest(): DiffManifest {
  const manifest = reviewTestManifestWithDocs();
  const seedFile = manifest.files[0];
  if (!seedFile) {
    throw new Error("expected a changed file");
  }
  return {
    ...manifest,
    files: [
      {
        ...seedFile,
        hunks: Array.from({ length: 8 }, (_, index) => {
          const line = index + 1;
          return {
            hunkIndex: line,
            header: `@@ -${line},1 +${line},1 @@`,
            oldStart: line,
            oldLines: 1,
            newStart: line,
            newLines: 1,
            contentHash: index.toString(16).padStart(12, "0"),
          };
        }),
        commentableRanges: Array.from({ length: 8 }, (_, index) => {
          const line = index + 1;
          const header = `@@ -${line},1 +${line},1 @@`;
          return {
            id: `single-range-${index}`,
            path: seedFile.path,
            side: "RIGHT" as const,
            startLine: line,
            endLine: line,
            kind: "added" as const,
            hunkIndex: line,
            hunkHeader: header,
            hunkContentHash: index.toString(16).padStart(12, "0"),
            preview: `changed line ${line}`,
          };
        }),
      },
    ],
  };
}

function expectPromptCoverage(prompts: readonly string[], fileCount: number): void {
  const combined = prompts.join("\n");
  for (let index = 0; index < fileCount; index += 1) {
    const contentHash = index.toString(16).padStart(12, "0");
    expect(combined).toContain(`"path": "src/file-${index}.ts"`);
    expect(combined).toContain(`"contentHash": "${contentHash}"`);
    expect(combined).toContain(`"id": "range-${index}-0"`);
    expect(combined).toContain(`"id": "range-${index}-1"`);
  }
}
