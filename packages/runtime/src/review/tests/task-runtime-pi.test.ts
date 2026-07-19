import { describe, expect, it } from "bun:test";
import type { AgentTool } from "@usepipr/sdk";
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
  runRuntime,
  runWithInsideOutsideFindings,
  singleTaskPlan,
  testPlan,
} from "./task-runtime-fixtures.js";

describe("runTaskRuntime: Pi retries, fallbacks, tools, secrets, and publication limits", () => {
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
      config: fallbackConfig,
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
