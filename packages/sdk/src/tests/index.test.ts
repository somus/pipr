import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp as createTemporaryDirectory, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const temporaryDirectories = new Set<string>();
afterEach(async () => {
  await Promise.all(
    [...temporaryDirectories].map((directory) => rm(directory, { recursive: true, force: true })),
  );
  temporaryDirectories.clear();
});

async function mkdtemp(prefix: string): Promise<string> {
  const directory = await createTemporaryDirectory(prefix);
  temporaryDirectories.add(directory);
  return directory;
}

import type {
  Agent,
  AgentTool,
  ChangedFile,
  DiffManifest,
  ModelProfile,
  PiprBuilder,
  PiprResult,
  PiprRunSummary,
  PromptText,
  Reviewer,
  Task,
  TaskContext,
} from "../index.js";
import {
  defaultReviewActions,
  defaultReviewEntrypoints,
  definePipr,
  definePlugin,
  jsonSchema,
  parsePiprResult,
  parseReviewFinding,
  parseReviewResult,
  piprResultSchema,
  reviewFindingSchema,
  reviewResultSchema,
  reviewSummarySchema,
  schema,
  schemas,
  z,
} from "../index.js";
import {
  buildPiprPlan,
  embeddedSdkDeclaration,
  readSdkDeclarationSourceWithChunk,
} from "../internal.js";

describe("Pipr Result", () => {
  it("exports a strict, schema-validated V2 review result", () => {
    const run = {
      id: "run-1",
      trigger: "local",
      baseSha: "base-sha",
      headSha: "head-sha",
      tasks: ["review"],
      durationMs: 125,
      models: ["openai/gpt-5"],
      agentRuns: 1,
      inputTokens: 100,
      outputTokens: 20,
      costUsd: 0.01,
      usageStatus: "complete",
    } satisfies PiprRunSummary;
    const result = {
      formatVersion: 2,
      kind: "review",
      run,
      mainComment: "Review complete.",
      inlineFindings: [],
      droppedFindings: [],
      taskChecks: [],
      repairAttempted: false,
      publication: { state: "disabled" },
    } satisfies PiprResult;

    expect(parsePiprResult(result)).toEqual(result);
    expect(piprResultSchema.safeParse({ ...result, internalMarker: "secret" }).success).toBe(false);
  });

  it("validates every V2 result discriminator and run-summary limits", () => {
    const run: PiprRunSummary = {
      id: "run-1",
      trigger: "command",
      baseSha: "base",
      headSha: "head",
      tasks: ["review"],
      durationMs: 1,
      models: ["model"],
      agentRuns: 1,
      inputTokens: 2,
      outputTokens: 1,
      costUsd: 0.01,
      usageStatus: "partial",
    };
    const results = [
      { formatVersion: 2, kind: "skipped", reason: "no task" },
      { formatVersion: 2, kind: "ignored", reason: "event" },
      { formatVersion: 2, kind: "dry-run" },
      { formatVersion: 2, kind: "command-help", reason: "input", mainComment: "help" },
      {
        formatVersion: 2,
        kind: "command-response",
        run,
        mainComment: "answer",
        publication: { state: "completed", action: "updated" },
      },
      {
        formatVersion: 2,
        kind: "verifier",
        run: { ...run, trigger: "verifier" },
        publication: { state: "completed", inlineResolutionErrorCount: 0 },
      },
      { formatVersion: 2, kind: "publication-error", message: "safe" },
      { formatVersion: 2, kind: "error", message: "safe" },
    ] satisfies PiprResult[];

    for (const result of results) {
      expect(parsePiprResult(result)).toEqual(result);
      expect(piprResultSchema.safeParse({ ...result, privateField: true }).success).toBe(false);
    }
    expect(
      piprResultSchema.safeParse({
        formatVersion: 2,
        kind: "command-response",
        run: { ...run, tasks: Array.from({ length: 201 }, (_, index) => `task-${index}`) },
        mainComment: "answer",
        publication: { state: "completed", action: "updated" },
      }).success,
    ).toBe(false);
  });
});

describe("ChangeRequestContext", () => {
  it("does not expose a misleading live-head lookup", async () => {
    const taskTypes = await readFile(
      path.join(import.meta.dirname, "..", "types", "task.ts"),
      "utf8",
    );
    expect(taskTypes).not.toContain("currentHeadSha");
  });
});

describe("definePipr", () => {
  it("registers models, agents, tasks, events, commands, and tools", () => {
    const factory = definePipr((pipr) => {
      const model = pipr.model({
        provider: "deepseek",
        model: "deepseek-v4-pro",
        apiKey: pipr.secret({ name: "DEEPSEEK_API_KEY" }),
      });
      const tool = pipr.tool({
        name: "custom_tool",
        description: "Custom tool.",
        input: pipr.schemas.summary,
        output: pipr.schemas.summary,
        async run({ input }) {
          return input;
        },
      });
      const agent = pipr.agent({
        name: "reviewer",
        model,
        instructions: "Review.",
        output: pipr.schemas.review,
        tools: [tool],
        prompt: () => "Prompt.",
      });
      const paths = { include: ["src/**"], exclude: ["**/*.test.ts"] };
      const task = pipr.task({
        name: "review",
        local: false,
        async run(context) {
          const manifest = await context.change.diffManifest({ paths });
          const result = await context.pi.run(agent, { manifest }, { paths });
          await context.comment({
            main: result.summary.body,
            inlineFindings: result.inlineFindings,
          });
        },
      });
      expect(pipr.on.changeRequest({ actions: ["opened"], task })).toBeUndefined();
      expect(pipr.command({ pattern: "@pipr review", permission: "write", task })).toBeUndefined();
      pipr.review({
        id: "scoped",
        model,
        instructions: "Review scoped files.",
        paths: { include: ["docs/**"] },
        entrypoints: { changeRequest: false, command: false },
      });
    });

    const plan = buildPiprPlan(factory);

    expect(plan.models.map((model) => model.id)).toEqual(["deepseek/deepseek-v4-pro"]);
    expect(plan.agents.map((agent) => agent.name)).toEqual(["reviewer", "scoped"]);
    expect(plan.tasks.map((task) => task.name)).toEqual(["review", "scoped"]);
    expect(plan.tasks[0]?.local).toBe(false);
    expect(plan.changeRequestTriggers[0]).toMatchObject({ actions: ["opened"] });
    expect(plan.commands[0]).toMatchObject({ pattern: "@pipr review", permission: "write" });
    expect(plan.tools[0]?.name).toBe("custom_tool");
  });

  it("keeps executable definitions off public handles", () => {
    let handles: { task?: Task; agent?: Agent; tool?: AgentTool } = {};
    const factory = definePipr((pipr) => {
      const tool = pipr.tool({
        name: "lookup",
        description: "Look up a value.",
        input: pipr.schemas.summary,
        output: pipr.schemas.summary,
        run: ({ input }) => input,
      });
      const agent = pipr.agent({
        name: "reviewer",
        instructions: "Review.",
        output: pipr.schemas.review,
        tools: [tool],
        prompt: () => "Review.",
      });
      const task = pipr.task({ name: "review", run() {} });
      handles = { task, agent, tool };
    });

    buildPiprPlan(factory);

    expect(Object.keys(handles.task ?? {})).toEqual(["kind", "name"]);
    expect(Object.keys(handles.agent ?? {})).toEqual(["kind", "name", "extend"]);
    expect(Object.keys(handles.tool ?? {})).toEqual(["kind", "name"]);
  });

  it("rejects copied task and agent handles", () => {
    expect(() =>
      buildPiprPlan(
        definePipr((pipr) => {
          const task = pipr.task({ name: "review", run() {} });
          pipr.on.changeRequest({ actions: ["opened"], task: { ...task } as Task });
        }),
      ),
    ).toThrow("Expected a task handle created by pipr.task");

    let copiedAgent: Agent | undefined;
    const plan = buildPiprPlan(
      definePipr((pipr) => {
        const agent = pipr.agent({
          name: "reviewer",
          instructions: "Review.",
          output: pipr.schemas.review,
          prompt: () => "Review.",
        });
        copiedAgent = { ...agent } as Agent;
      }),
    );

    expect(() => plan.resolveAgent(copiedAgent as Agent)).toThrow(
      "Expected an agent handle created by pipr.agent",
    );
  });

  it("resolves agents from a separately bundled SDK module", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "pipr-sdk-copy-"));
    const sdkSource = path.join(import.meta.dirname, "..", "index.ts");
    const entrypoint = path.join(directory, "entry.ts");
    await writeFile(entrypoint, `export * from ${JSON.stringify(sdkSource)};\n`);
    const result = await Bun.build({
      entrypoints: [entrypoint],
      format: "esm",
      target: "bun",
    });
    expect(result.success).toBe(true);
    const output = result.outputs[0];
    if (!output) {
      throw new Error("SDK test bundle produced no output");
    }
    const modulePath = path.join(directory, "sdk.mjs");
    await writeFile(modulePath, await output.text());
    const internalModule = pathToFileURL(path.join(import.meta.dirname, "..", "internal.ts")).href;
    const verificationPath = path.join(directory, "verify.mjs");
    await writeFile(
      verificationPath,
      [
        `import { buildPiprPlan } from ${JSON.stringify(internalModule)};`,
        'import * as sdk from "./sdk.mjs";',
        "let agent;",
        "const factory = sdk.definePipr((pipr) => {",
        "  agent = pipr.agent({",
        '    name: "foreign-reviewer",',
        '    instructions: "Review.",',
        "    output: pipr.schemas.review,",
        '    prompt: () => "Review.",',
        "  });",
        "});",
        "const plan = buildPiprPlan(factory);",
        'if (plan.resolveAgent(agent).name !== "foreign-reviewer") {',
        '  throw new Error("foreign agent did not resolve through its runtime plan");',
        "}",
      ].join("\n"),
    );
    const verification = Bun.spawn([process.execPath, verificationPath], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stderr] = await Promise.all([
      verification.exited,
      new Response(verification.stderr).text(),
    ]);

    expect(stderr).toBe("");
    expect(exitCode).toBe(0);
  });

  it("rejects async config callbacks", () => {
    const factory = definePipr(async () => {});

    expect(() => buildPiprPlan(factory)).toThrow(
      "definePipr configuration callback must be synchronous",
    );
  });

  it("rejects duplicate task and command names", () => {
    const factory = definePipr((pipr) => {
      const first = pipr.task({ name: "review", run() {} });
      const second = pipr.task({ name: "review", run() {} });
      pipr.command({ pattern: "@pipr review", task: first });
      pipr.command({ pattern: "@pipr review", task: second });
    });

    expect(() => buildPiprPlan(factory)).toThrow("Duplicate task 'review'");
  });

  it("rejects command patterns outside the pipr command grammar", () => {
    expect(() =>
      buildPiprPlan(
        definePipr((pipr) => {
          const task = pipr.task({ name: "review", run() {} });
          pipr.command({ pattern: "review", task });
        }),
      ),
    ).toThrow("must start with @pipr");
  });

  it("rejects rest command captures outside the final required position", () => {
    const error = "Rest capture '<question...>' must be the final required command pattern token";
    expect(() =>
      buildPiprPlan(
        definePipr((pipr) => {
          const task = pipr.task({ name: "ask", run() {} });
          pipr.command({ pattern: "@pipr ask [<question...>]", task });
        }),
      ),
    ).toThrow(error);

    expect(() =>
      buildPiprPlan(
        definePipr((pipr) => {
          const task = pipr.task({ name: "ask", run() {} });
          pipr.command({ pattern: "@pipr ask <question...> --json", task });
        }),
      ),
    ).toThrow(error);
  });

  it("rejects unsupported review option fields at runtime", () => {
    const factory = definePipr((pipr) => {
      const model = pipr.model({
        provider: "deepseek",
        model: "deepseek-v4-pro",
        apiKey: pipr.secret({ name: "DEEPSEEK_API_KEY" }),
      });
      expect(() =>
        pipr.review({
          id: "review",
          model,
          instructions: "Review.",
          command: false,
        } as never),
      ).toThrow("pipr.review received unsupported option fields: command");
      expect(() =>
        pipr.review({
          id: "review",
          model,
          instructions: "Review.",
          entrypoints: { local: false },
        } as never),
      ).toThrow("pipr.review entrypoints received unsupported fields: local");
    });

    buildPiprPlan(factory);
  });

  it("rejects custom tools that only define legacy execute", () => {
    expect(() =>
      buildPiprPlan(
        definePipr((pipr) => {
          pipr.tool({
            name: "legacy_tool",
            description: "Legacy tool.",
            input: pipr.schemas.summary,
            output: pipr.schemas.summary,
            async execute(_context: TaskContext, input: unknown) {
              return input;
            },
          } as never);
        }),
      ),
    ).toThrow("Tool 'legacy_tool' must define run");
  });

  it("rejects custom tools that collide with built-in read-only tools", () => {
    expect(() =>
      buildPiprPlan(
        definePipr((pipr) => {
          pipr.tool({
            name: "readOnly",
            description: "collision",
            input: pipr.schemas.summary,
            output: pipr.schemas.summary,
            async run({ input }) {
              return input;
            },
          });
        }),
      ),
    ).toThrow("reserved");
  });

  it("expands the review recipe into one runnable review plan", () => {
    const factory = definePipr((pipr) => {
      const model = pipr.model({
        provider: "deepseek",
        model: "deepseek-v4-pro",
        apiKey: pipr.secret({ name: "DEEPSEEK_API_KEY" }),
      });
      pipr.config({ publication: { maxInlineComments: 3 } });
      pipr.review({ id: "review", model, instructions: "Review." });
    });

    const plan = buildPiprPlan(factory);

    expect(plan.models).toHaveLength(1);
    expect(plan.agents.map((agent) => agent.name)).toEqual(["review"]);
    expect(plan.tasks.map((task) => task.name)).toEqual(["review"]);
    expect(plan.changeRequestTriggers[0]?.actions).toEqual([
      "opened",
      "updated",
      "reopened",
      "ready",
    ]);
    expect(plan.commands[0]).toMatchObject({ pattern: "@pipr review", permission: "write" });
    expect(plan.publication.maxInlineComments).toBe(3);
  });

  it("exports the default review entrypoint constants", () => {
    expect(defaultReviewActions).toEqual(["opened", "updated", "reopened", "ready"]);
    expect(defaultReviewEntrypoints).toEqual({
      changeRequest: defaultReviewActions,
      command: { pattern: "@pipr review", permission: "write" },
    });
  });

  it("accepts default review entrypoints explicitly", () => {
    const factory = definePipr((pipr) => {
      const model = pipr.model({
        provider: "deepseek",
        model: "deepseek-v4-pro",
        apiKey: pipr.secret({ name: "DEEPSEEK_API_KEY" }),
      });
      pipr.review({
        id: "review",
        model,
        instructions: "Review.",
        entrypoints: defaultReviewEntrypoints,
      });
    });

    const plan = buildPiprPlan(factory);

    expect(plan.changeRequestTriggers[0]?.actions).toEqual([...defaultReviewActions]);
    expect(plan.commands[0]).toMatchObject({ pattern: "@pipr review", permission: "write" });
  });

  it("accepts default review actions for direct change-request registration", () => {
    const factory = definePipr((pipr) => {
      const task = pipr.task({ name: "review", run() {} });
      pipr.on.changeRequest({ actions: defaultReviewActions, task });
    });

    const plan = buildPiprPlan(factory);

    expect(plan.changeRequestTriggers[0]?.actions).toEqual([...defaultReviewActions]);
  });

  it("reuses explicit reviewers and registers provider-neutral entrypoints", () => {
    const factory = definePipr((pipr) => {
      const model = pipr.model({
        provider: "deepseek",
        model: "deepseek-v4-pro",
        apiKey: pipr.secret({ name: "DEEPSEEK_API_KEY" }),
      });
      const reviewer = pipr.reviewer({
        name: "correctness-reviewer",
        model,
        instructions: "Review correctness.",
      });
      pipr.review({
        id: "correctness",
        reviewer,
        entrypoints: {
          changeRequest: false,
          command: {
            pattern: "@pipr correctness",
            permission: "triage",
            description: "Run correctness review.",
          },
        },
        comment: "Correctness review disabled.",
      });
    });

    const plan = buildPiprPlan(factory);

    expect(plan.agents.map((agent) => agent.name)).toEqual(["correctness-reviewer"]);
    expect(plan.tasks.map((task) => task.name)).toEqual(["correctness"]);
    expect(plan.changeRequestTriggers).toHaveLength(0);
    expect(plan.commands[0]).toMatchObject({
      pattern: "@pipr correctness",
      permission: "triage",
      description: "Run correctness review.",
    });
    expect(plan.publication.maxInlineComments).toBeUndefined();
  });

  it("passes review-level timeout when reusing an explicit reviewer", async () => {
    let runTimeout: unknown;
    const factory = definePipr((pipr) => {
      const model = pipr.model({
        provider: "deepseek",
        model: "deepseek-v4-pro",
        apiKey: pipr.secret({ name: "DEEPSEEK_API_KEY" }),
      });
      const reviewer = pipr.reviewer({
        model,
        instructions: "Review.",
      });
      pipr.review({
        id: "review",
        reviewer,
        timeout: "5m",
        entrypoints: {
          changeRequest: false,
          command: false,
        },
      });
    });

    const plan = buildPiprPlan(factory);
    const task = plan.tasks[0];
    expect(task).toBeDefined();
    await task?.handler(
      {
        run: { id: "test-run", trigger: "local" },
        repository: { root: "/tmp/repo", name: "repo" },
        platform: { id: "local" },
        change: {
          title: "Local change",
          description: "",
          base: { sha: "base" },
          head: { sha: "head" },
          async diffManifest() {
            return { baseSha: "base", headSha: "head", mergeBaseSha: "base", files: [] };
          },
          async changedFiles() {
            return [];
          },
        },
        pi: {
          async run(_agent, _input, options) {
            runTimeout = options?.timeout;
            return { summary: { body: "Done." }, inlineFindings: [] } as never;
          },
        },
        review: {
          async prior() {
            return { inlineFindings: [] };
          },
        },
        secret() {
          return "secret";
        },
        check: fakeCheck(),
        async comment() {},
        log: {
          info() {},
          warn() {},
          error() {},
        },
      },
      undefined,
    );

    expect(runTimeout).toBe("5m");
  });

  it("passes the Review Run context to custom review comment renderers", async () => {
    let observedRun: unknown;
    const factory = definePipr((pipr) => {
      const model = pipr.model({ provider: "deepseek", model: "deepseek-v4-pro" });
      pipr.review({
        id: "review",
        model,
        instructions: "Review.",
        entrypoints: { changeRequest: false, command: false },
        comment(_result, context) {
          observedRun = context.run;
          return "Review complete.";
        },
      });
    });

    const task = buildPiprPlan(factory).tasks[0];
    await task?.handler(
      {
        ...fakeTaskContext(),
        pi: {
          async run() {
            return { summary: { body: "Done." }, inlineFindings: [] } as never;
          },
        },
      },
      undefined,
    );

    expect(observedRun).toEqual({ id: "test-run", trigger: "local" });
  });

  it("normalizes plugin tools to Eve-style run inputs", async () => {
    const factory = definePipr((pipr) => {
      pipr.tool({
        name: "summarize",
        description: "Summarize input.",
        input: pipr.schemas.summary,
        output: pipr.schemas.summary,
        async run({ input }) {
          return input;
        },
        toModelOutput(output) {
          return output.body;
        },
      });
    });

    const plan = buildPiprPlan(factory);
    const tool = plan.tools[0];

    await expect(
      tool?.run?.({ input: { body: "Looks good." }, ctx: fakeTaskContext(), signal: undefined }),
    ).resolves.toEqual({ body: "Looks good." });
    expect(tool?.toModelOutput?.({ body: "Looks good." })).toBe("Looks good.");
  });

  it("rejects unsupported config option fields at runtime", () => {
    expect(() =>
      buildPiprPlan(
        definePipr((pipr) => {
          pipr.config({ typo: true } as never);
        }),
      ),
    ).toThrow("pipr.config received unsupported option fields: typo");
    expect(() =>
      buildPiprPlan(
        definePipr((pipr) => {
          pipr.config({ publication: { inlineComments: { max: 3 } } } as never);
        }),
      ),
    ).toThrow("pipr.config publication received unsupported option fields: inlineComments");
    expect(() =>
      buildPiprPlan(
        definePipr((pipr) => {
          pipr.config({ limits: { diffManifest: { fullMaxTokens: 1000 } } } as never);
        }),
      ),
    ).toThrow("pipr.config limits.diffManifest received unsupported option fields: fullMaxTokens");
    expect(() =>
      buildPiprPlan(
        definePipr((pipr) => {
          pipr.config({
            publication: { autoResolve: { userReplies: { extra: true } } },
          } as never);
        }),
      ),
    ).toThrow(
      "pipr.config publication.autoResolve.userReplies received unsupported option fields: extra",
    );
  });

  it("rejects invalid config option values at runtime", () => {
    expect(() =>
      buildPiprPlan(
        definePipr((pipr) => {
          pipr.config({ publication: { maxInlineComments: -1 } } as never);
        }),
      ),
    ).toThrow("pipr.config received invalid option value");
    expect(() =>
      buildPiprPlan(
        definePipr((pipr) => {
          pipr.config({ publication: { maxStoredFindings: 101 } } as never);
        }),
      ),
    ).toThrow("pipr.config received invalid option value");
    expect(() =>
      buildPiprPlan(
        definePipr((pipr) => {
          pipr.config({
            publication: { autoResolve: { userReplies: { allowedActors: "owner" } } },
          } as never);
        }),
      ),
    ).toThrow("pipr.config received invalid option value");
  });

  it("rejects conflicting global inline publication settings", () => {
    expect(() =>
      buildPiprPlan(
        definePipr((pipr) => {
          pipr.config({ publication: { maxInlineComments: 3 } });
          pipr.config({ publication: { maxInlineComments: 5 } });
        }),
      ),
    ).toThrow("publication.maxInlineComments conflicts");
  });

  it("registers the stored finding limit", () => {
    const plan = buildPiprPlan(
      definePipr((pipr) => {
        pipr.config({ publication: { maxStoredFindings: 100 } });
      }),
    );

    expect(plan.publication.maxStoredFindings).toBe(100);
  });

  it("rejects conflicting stored finding limits", () => {
    expect(() =>
      buildPiprPlan(
        definePipr((pipr) => {
          pipr.config({ publication: { maxStoredFindings: 50 } });
          pipr.config({ publication: { maxStoredFindings: 100 } });
        }),
      ),
    ).toThrow("publication.maxStoredFindings conflicts");
  });

  it("allows matching global inline publication settings", () => {
    const plan = buildPiprPlan(
      definePipr((pipr) => {
        pipr.config({ publication: { maxInlineComments: 3 } });
        pipr.config({ publication: { maxInlineComments: 3 } });
      }),
    );

    expect(plan.publication).toEqual({ maxInlineComments: 3 });
  });

  it("registers matching main comment presentation settings", () => {
    const plan = buildPiprPlan(
      definePipr((pipr) => {
        pipr.config({
          publication: { showHeader: false, showFooter: false, showStats: false },
        });
        pipr.config({
          publication: { showHeader: false, showFooter: false, showStats: false },
        });
      }),
    );

    expect(plan.publication).toEqual({
      showHeader: false,
      showFooter: false,
      showStats: false,
    });
  });

  it("rejects conflicting main comment presentation settings", () => {
    expect(() =>
      buildPiprPlan(
        definePipr((pipr) => {
          pipr.config({ publication: { showHeader: true } });
          pipr.config({ publication: { showHeader: false } });
        }),
      ),
    ).toThrow("publication.showHeader conflicts");
  });

  it("rejects non-boolean main comment presentation settings", () => {
    expect(() =>
      buildPiprPlan(
        definePipr((pipr) => {
          pipr.config({ publication: { showStats: "yes" } } as never);
        }),
      ),
    ).toThrow("pipr.config received invalid option value");
  });

  it("registers typed global config", () => {
    const factory = definePipr((pipr) => {
      const model = pipr.model({
        provider: "deepseek",
        model: "deepseek-v4-pro",
        apiKey: pipr.secret({ name: "DEEPSEEK_API_KEY" }),
      });
      const verifier = pipr.model({
        id: "verifier",
        provider: "deepseek",
        model: "deepseek-v4",
        apiKey: pipr.secret({ name: "DEEPSEEK_API_KEY" }),
      });
      pipr.config({
        publication: {
          maxInlineComments: 3,
          autoResolve: {
            model: verifier,
            synchronize: true,
            userReplies: {
              enabled: true,
              respondWhenStillValid: false,
              allowedActors: "write",
            },
          },
        },
        checks: { aggregate: { enabled: true } },
        limits: { timeoutSeconds: 300 },
      });
      pipr.review({ id: "review", model, instructions: "Review." });
    });

    const plan = buildPiprPlan(factory);

    expect(plan.publication).toMatchObject({
      maxInlineComments: 3,
      autoResolve: {
        model: expect.objectContaining({ id: "verifier" }),
        synchronize: true,
        userReplies: { respondWhenStillValid: false, allowedActors: "write" },
      },
    });
    expect(plan.checks).toEqual({ aggregate: { enabled: true } });
    expect(plan.limits).toEqual({ timeoutSeconds: 300 });
  });

  it("registers Review Run and Diff Manifest fan-out limits", () => {
    const plan = buildPiprPlan(
      definePipr((pipr) => {
        pipr.config({ limits: { maxAgentRuns: 16, diffManifest: { maxShards: 4 } } });
      }),
    );

    expect(plan.limits).toEqual({ maxAgentRuns: 16, diffManifest: { maxShards: 4 } });
  });

  it("rejects invalid Review Run and Diff Manifest fan-out limits", () => {
    for (const limits of [
      { maxAgentRuns: 0 },
      { maxAgentRuns: 1.5 },
      { diffManifest: { maxShards: 0 } },
      { diffManifest: { maxShards: 1.5 } },
    ]) {
      expect(() =>
        buildPiprPlan(
          definePipr((pipr) => {
            pipr.config({ limits });
          }),
        ),
      ).toThrow();
    }
  });

  it("rejects conflicting global config values", () => {
    expect(() =>
      buildPiprPlan(
        definePipr((pipr) => {
          pipr.config({ publication: { autoResolve: false } });
          pipr.config({ publication: { autoResolve: { synchronize: true } } });
        }),
      ),
    ).toThrow("publication.autoResolve conflicts");
  });

  it("lets explicit plugins install typed helpers without adding plan modules", () => {
    const factory = definePipr((pipr) => {
      const helper = pipr.use(
        definePlugin((pluginPipr) => ({
          createTask() {
            return pluginPipr.task({ name: "plugin-task", run() {} });
          },
        })),
      );
      helper.createTask();
    });

    const plan = buildPiprPlan(factory);

    expect(plan.tasks.map((task) => task.name)).toEqual(["plugin-task"]);
    expect("modules" in plan).toBe(false);
  });

  it("exports Zod and creates typed custom Zod schemas", () => {
    const resultSchema = schema({
      id: "custom/security-review",
      schema: z.strictObject({
        verdict: z.enum(["pass", "fail"]),
        findings: z.array(z.string()),
      }),
    });

    const parsed = resultSchema.parse({ verdict: "pass", findings: ["ok"] });
    const typed: { verdict: "pass" | "fail"; findings: string[] } = parsed;

    expect(typed).toEqual({ verdict: "pass", findings: ["ok"] });
    expect(resultSchema.jsonSchema).toMatchObject({
      type: "object",
      required: ["verdict", "findings"],
    });
    expect(() => resultSchema.parse({ verdict: "skip", findings: [] })).toThrow();
  });

  it("rejects custom Zod schemas that cannot be rendered as JSON Schema", () => {
    expect(() =>
      schema({
        id: "custom/transformed",
        schema: z.string().transform((value) => value.trim()),
      }),
    ).toThrow("could not be converted to JSON Schema");
  });

  it("reserves core schema IDs for built-ins", () => {
    expect(() =>
      schema({ id: "core/pr-review", schema: z.strictObject({ ok: z.boolean() }) }),
    ).toThrow("reserved core/ namespace");
    expect(() => jsonSchema({ id: "core/custom", schema: true })).toThrow(
      "reserved core/ namespace",
    );
    expect(schemas.review.id).toBe("core/pr-review");
    expect(schemas.summary.id).toBe("core/summary");
  });

  it("creates typed custom JSON Schemas with caller-supplied output types", () => {
    type SummaryRating = { summary: string; rating: "low" | "high" };
    const resultSchema = jsonSchema<SummaryRating>({
      id: "custom/summary-rating",
      schema: {
        type: "object",
        additionalProperties: false,
        required: ["summary", "rating"],
        properties: {
          summary: { type: "string" },
          rating: { enum: ["low", "high"] },
        },
      },
    });

    const parsed = resultSchema.parse({ summary: "Looks good.", rating: "low" });
    const typed: SummaryRating = parsed;

    expect(typed.rating).toBe("low");
    expect(resultSchema.safeParse({ summary: "Looks good.", rating: "medium" }).success).toBe(
      false,
    );
    expect(resultSchema.jsonSchema).toMatchObject({ type: "object" });
  });

  it("uses custom schemas as agent outputs", async () => {
    const factory = definePipr((pipr) => {
      const model = pipr.model({
        provider: "deepseek",
        model: "deepseek-v4-pro",
        apiKey: pipr.secret({ name: "DEEPSEEK_API_KEY" }),
      });
      const output = pipr.schema({
        id: "custom/security-summary",
        schema: z.strictObject({
          summary: z.string(),
          findings: z.array(z.string()),
        }),
      });
      const agent = pipr.agent({
        name: "security",
        model,
        instructions: "Review security.",
        output,
        prompt: () => "Review.",
      });
      const task = pipr.task({
        name: "security",
        async run(context) {
          const result = await context.pi.run(agent, {});
          await context.comment(JSON.stringify(result));
        },
      });
      pipr.on.changeRequest({ actions: ["opened"], task });
    });

    const plan = buildPiprPlan(factory);
    const task = plan.tasks[0];
    let commentValue: unknown;

    await task?.handler(
      {
        run: { id: "test-run", trigger: "local" },
        repository: { root: "/tmp/repo", name: "repo" },
        platform: { id: "local" },
        change: fakeChange(),
        pi: {
          async run(agent) {
            return plan.resolveAgent(agent).definition.output.parse({
              summary: "Done.",
              findings: ["A"],
            }) as never;
          },
        },
        review: {
          async prior() {
            return { inlineFindings: [] };
          },
        },
        secret() {
          return "secret";
        },
        check: fakeCheck(),
        async comment(value) {
          commentValue = value;
        },
        log: fakeLog(),
      },
      undefined,
    );

    expect(commentValue).toEqual('{"summary":"Done.","findings":["A"]}');
  });

  it("validates builtin schema values", () => {
    expect(schemas.review.jsonSchema).toMatchObject({
      type: "object",
      required: ["summary", "inlineFindings"],
    });
    expect(() => schemas.summary.parse({ body: "Looks good." })).not.toThrow();
    expect(() => schemas.summary.parse({ body: 123 })).toThrow("expected string");
    expect(() => schemas.summary.parse({ body: "Looks good.", risk: "low" })).toThrow("risk");
    expect(() =>
      schemas.review.parse({
        summary: { body: "Review." },
        inlineFindings: [{ ...validReviewFinding(), title: 123 }],
      }),
    ).toThrow("title");
    expect(() =>
      schemas.review.parse({
        summary: { body: "Review." },
        inlineFindings: [],
        nonInlineFindings: [],
      }),
    ).toThrow("nonInlineFindings");
    expect(() =>
      schemas.review.parse({
        summary: { body: "Review." },
        inlineFindings: [validReviewFinding({ id: "finding-1" })],
      }),
    ).toThrow("id");
    expect(
      schemas.review.parse({
        summary: { body: "Review." },
        inlineFindings: [validReviewFinding()],
      }),
    ).toMatchObject({
      inlineFindings: [{ body: "Finding body." }],
    });
    expect(() =>
      schemas.review.parse({
        summary: { body: "Review." },
        inlineFindings: [validReviewFinding({ data: { label: "correctness" } })],
      }),
    ).toThrow("data");
    expect(() =>
      schemas.review.parse({
        summary: { body: "Review." },
        inlineFindings: [validReviewFinding()],
        metadata: { source: "test" },
      }),
    ).toThrow("metadata");
  });

  it("uses provider/model as the default model id", () => {
    const factory = definePipr((pipr) => {
      pipr.model({
        provider: "deepseek",
        model: "deepseek-v4-pro",
        apiKey: pipr.secret({ name: "DEEPSEEK_API_KEY" }),
      });
    });

    expect(buildPiprPlan(factory).models[0]?.id).toBe("deepseek/deepseek-v4-pro");
  });

  it("rejects duplicate explicit model ids", () => {
    const factory = definePipr((pipr) => {
      pipr.model({
        id: "primary",
        provider: "deepseek",
        model: "deepseek-v4-pro",
        apiKey: pipr.secret({ name: "DEEPSEEK_API_KEY" }),
      });
      pipr.model({
        id: "primary",
        provider: "openai",
        model: "gpt-4.1",
        apiKey: pipr.secret({ name: "OPENAI_API_KEY" }),
      });
    });

    expect(() => buildPiprPlan(factory)).toThrow("Duplicate model id 'primary'");
  });

  it("rejects duplicate effective model configs", () => {
    const factory = definePipr((pipr) => {
      const apiKey = pipr.secret({ name: "DEEPSEEK_API_KEY" });
      pipr.model({
        id: "primary",
        provider: "deepseek",
        model: "deepseek-v4-pro",
        apiKey,
        options: { thinking: "high" },
      });
      pipr.model({
        id: "duplicate",
        provider: "deepseek",
        model: "deepseek-v4-pro",
        apiKey,
        options: { thinking: "high" },
      });
    });

    expect(() => buildPiprPlan(factory)).toThrow("Duplicate model config");
  });

  it("requires explicit model ids for repeated provider/model with different config", () => {
    const missingIdFactory = definePipr((pipr) => {
      const apiKey = pipr.secret({ name: "DEEPSEEK_API_KEY" });
      pipr.model({
        provider: "deepseek",
        model: "deepseek-v4-pro",
        apiKey,
      });
      pipr.model({
        provider: "deepseek",
        model: "deepseek-v4-pro",
        apiKey,
        options: { thinking: "high" },
      });
    });
    const explicitIdFactory = definePipr((pipr) => {
      const apiKey = pipr.secret({ name: "DEEPSEEK_API_KEY" });
      pipr.model({
        id: "deepseek-default",
        provider: "deepseek",
        model: "deepseek-v4-pro",
        apiKey,
      });
      pipr.model({
        id: "deepseek-thinking",
        provider: "deepseek",
        model: "deepseek-v4-pro",
        apiKey,
        options: { thinking: "high" },
      });
    });

    expect(() => buildPiprPlan(missingIdFactory)).toThrow("Add an explicit id");
    expect(buildPiprPlan(explicitIdFactory).models.map((model) => model.id)).toEqual([
      "deepseek-default",
      "deepseek-thinking",
    ]);
  });
});

describe("prompt rendering", () => {
  const serializationError = "Prompt value must be JSON-serializable";

  it("rejects unsupported JSON values consistently", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const symbolKey = Symbol("hidden");
    const transformedMap = Object.defineProperty({}, "toJSON", {
      value: () => new Map([["key", "value"]]),
    });
    const transformedArray = Object.defineProperty({}, "toJSON", {
      value: () => Object.assign(["value"], { metadata: "hidden" }),
    });
    const unsupported = [
      () => undefined,
      Symbol("value"),
      1n,
      circular,
      { nested: () => undefined },
      { nested: Symbol("value") },
      { nested: 1n },
      { nested: undefined },
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      { nested: Number.NaN },
      { nested: Number.POSITIVE_INFINITY },
      { nested: Number.NEGATIVE_INFINITY },
      Object.assign(["value"], { metadata: "hidden" }),
      new Map([["key", "value"]]),
      new Set(["value"]),
      { [symbolKey]: "hidden" },
      {
        toJSON() {
          throw new Error("custom serialization failure");
        },
      },
      transformedMap,
      transformedArray,
    ];

    for (const value of unsupported) {
      expect(() => renderPromptJson(value)).toThrow(serializationError);
      expect(() => interpolatePromptValue(value)).toThrow(serializationError);
    }
    expect(() => renderPromptJson(undefined)).toThrow(serializationError);
  });

  it("preserves supported prompt rendering and nullish interpolation", () => {
    const transformedValue = Object.defineProperty({}, "toJSON", {
      value: () => ({ ok: true }),
    });

    expect(interpolatePromptValue(undefined).value).toBe("");
    expect(interpolatePromptValue(null).value).toBe("");
    expect(interpolatePromptValue("raw").value).toBe("raw");
    expect(renderPromptJson(null).value).toBe("null");
    expect(renderPromptJson({ ok: true }).value).toBe('{\n  "ok": true\n}');
    expect(renderPromptJson(transformedValue).value).toBe('{\n  "ok": true\n}');
    expect(interpolatePromptValue(transformedValue).value).toBe('{\n  "ok": true\n}');
  });
});

describe("standalone SDK declarations", () => {
  it("keeps declaration utilities out of the public SDK root implementation", async () => {
    const builderSource = await readFile(
      path.join(import.meta.dirname, "..", "builder.ts"),
      "utf8",
    );

    expect(builderSource).not.toContain('from "./internal.js"');
    expect(builderSource).toContain('from "./prompt-render.js"');
  });

  it("embeds declarations with the local Zod shim", () => {
    const declaration = embeddedSdkDeclaration([
      {
        moduleName: "@usepipr/sdk",
        source: [
          'import { z } from "zod";',
          "export type Schema = z.ZodType<string>;",
          "export type ReviewFinding = { body: string };",
          'export type FromRoot = import("./index.mjs").Schema;',
          "//# sourceMappingURL=index.d.mts.map",
        ].join("\n"),
      },
    ]);

    expect(declaration).toContain('declare module "@usepipr/sdk"');
    expect(declaration).toContain("type ZodType<T = unknown");
    expect(declaration).toContain("export type Schema = ZodType<string>;");
    expect(declaration).toContain("export type ReviewFinding = { body: string };");
    expect(declaration).not.toContain('from "zod"');
    expect(declaration).not.toContain("z.ZodType");
    expect(declaration).not.toContain("sourceMappingURL");
  });

  it("stitches bundled declaration chunks into the SDK root declaration", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "pipr-sdk-declarations-"));
    const declarationPath = path.join(rootDir, "index.d.mts");
    await writeFile(declarationPath, 'export { RuntimePlan } from "./index-abc_123.mjs";');
    await writeFile(
      path.join(rootDir, "index-abc_123.d.mts"),
      "export type RuntimePlan = { tasks: string[] };\nexport { RuntimePlan };",
    );

    const source = await readSdkDeclarationSourceWithChunk(
      { moduleName: "@usepipr/sdk" },
      declarationPath,
    );

    expect(source).toContain("export type RuntimePlan = { tasks: string[] };");
    expect(source).toContain('export { RuntimePlan } from "./index-abc_123.mjs";');
    expect(source).not.toContain("export { RuntimePlan };\n");
  });
});

describe("review schema exports", () => {
  it("parse valid and invalid review contracts", () => {
    const summary = { body: "Looks good." };
    const finding = {
      body: "Issue.",
      path: "src/example.ts",
      rangeId: "rng_1",
      side: "RIGHT" as const,
      startLine: 1,
      endLine: 1,
    };
    const result = { summary, inlineFindings: [finding] };

    expect(reviewSummarySchema.parse(summary)).toEqual(summary);
    expect(parseReviewFinding(finding)).toEqual(finding);
    expect(parseReviewResult(result)).toEqual(result);
    expect(reviewFindingSchema.safeParse({ ...finding, startLine: 0 }).success).toBe(false);
    expect(reviewFindingSchema.safeParse({ ...finding, issueKey: "internal-only" }).success).toBe(
      false,
    );
    expect(
      reviewResultSchema.safeParse({ summary, inlineFindings: [{ ...finding, side: "BOTH" }] })
        .success,
    ).toBe(false);
    expect(reviewSummarySchema.safeParse({ body: "" }).success).toBe(false);
  });
});

function expectRemovedPublicApis(pipr: PiprBuilder): void {
  // @ts-expect-error compactManifest is not part of the TS-first SDK.
  pipr.compactManifest({ baseSha: "base", headSha: "head", mergeBaseSha: "base", files: [] });
  // @ts-expect-error reviewCandidates is not part of the MVP schema catalog.
  pipr.schemas.reviewCandidates;
  // @ts-expect-error consolidatedReview is not part of the MVP schema catalog.
  pipr.schemas.consolidatedReview;
}

void expectRemovedPublicApis;

function expectSchemaRequiresZod(pipr: PiprBuilder): void {
  // @ts-expect-error schema() requires real Zod, not a parse-only validator.
  pipr.schema({ id: "custom/parse-only", schema: { parse: (value: unknown) => String(value) } });
}

void expectSchemaRequiresZod;

function expectExplicitReviewerRejectsConstructionFields(
  pipr: PiprBuilder,
  reviewer: Reviewer,
  model: ModelProfile,
): void {
  // @ts-expect-error explicit reviewer recipes do not accept reviewer construction fields
  pipr.review({ reviewer, model, instructions: "Ignored." });
}

void expectExplicitReviewerRejectsConstructionFields;

function expectChangeRequestTasksRequireVoidInput(pipr: PiprBuilder): void {
  const changeRequestTask = pipr.task({ name: "review", run() {} });
  pipr.on.changeRequest({ actions: ["opened"], task: changeRequestTask });

  const commandTask = pipr.task<{ question: string }>({ name: "ask", run() {} });
  pipr.command({
    pattern: "@pipr ask <question...>",
    parse: (arguments_) => ({ question: arguments_.question ?? "" }),
    task: commandTask,
  });

  // @ts-expect-error change-request entrypoints do not provide task input.
  pipr.on.changeRequest({ actions: ["opened"], task: commandTask });
}

void expectChangeRequestTasksRequireVoidInput;

function expectOpaqueHandles(task: Task, agent: Agent, tool: AgentTool): void {
  task.name;
  agent.name;
  agent.extend({ instructions: "Additional instructions." });
  tool.name;

  // @ts-expect-error task execution is available only through the internal runtime seam.
  task.handler;
  // @ts-expect-error task runtime settings are not part of the public handle.
  task.check;
  // @ts-expect-error task runtime settings are not part of the public handle.
  task.local;
  // @ts-expect-error agent definitions are available only through the internal runtime seam.
  agent.definition;
  // @ts-expect-error tool definitions are available only through the internal runtime seam.
  tool.input;
  // @ts-expect-error tool definitions are available only through the internal runtime seam.
  tool.output;
  // @ts-expect-error tool callbacks are available only through the internal runtime seam.
  tool.run;
  // @ts-expect-error tool callbacks are available only through the internal runtime seam.
  tool.toModelOutput;
}

void expectOpaqueHandles;

function expectReadonlySdkCollections(
  pipr: PiprBuilder,
  model: ModelProfile,
  context: TaskContext,
  manifest: DiffManifest,
): void {
  const paths = { include: ["src/**"], exclude: ["**/*.test.ts"] } as const;
  const fallbacks = [model] as const;

  void context.change.diffManifest({ paths });
  pipr.reviewer({ model, fallbacks, instructions: "Review." });

  // @ts-expect-error Diff Manifest files are runtime-owned readonly collections.
  manifest.files.push();
  // @ts-expect-error Diff Manifest hunks are runtime-owned readonly collections.
  manifest.files[0]?.hunks.push();
  // @ts-expect-error Diff Manifest ranges are runtime-owned readonly collections.
  manifest.files[0]?.commentableRanges.push();
}

void expectReadonlySdkCollections;

async function expectNamedChangedFiles(context: TaskContext): Promise<void> {
  const files = await context.change.changedFiles();
  const first: ChangedFile | undefined = files[0];
  void first;

  // @ts-expect-error changed files are runtime-owned readonly collections.
  files.push({ path: "src/example.ts", status: "modified" });
  // @ts-expect-error changed file status must use FileStatus.
  const invalid: ChangedFile = { path: "src/example.ts", status: "changed" };
  void invalid;
}

void expectNamedChangedFiles;

function renderPromptJson(value: unknown): PromptText {
  return withPiprBuilder((pipr) => pipr.json(value));
}

function interpolatePromptValue(value: unknown): PromptText {
  return withPiprBuilder((pipr) => pipr.prompt`${value}`);
}

function withPiprBuilder<T>(callback: (pipr: PiprBuilder) => T): T {
  let result: T | undefined;
  buildPiprPlan(
    definePipr((pipr) => {
      result = callback(pipr);
    }),
  );
  return result as T;
}

const diffManifestContract: DiffManifest = {
  baseSha: "base",
  headSha: "head",
  mergeBaseSha: "merge",
  files: [
    {
      path: "src/example.ts",
      status: "modified",
      additions: 1,
      deletions: 0,
      hunks: [
        {
          hunkIndex: 1,
          header: "@@ -1 +1 @@",
          oldStart: 1,
          oldLines: 1,
          newStart: 1,
          newLines: 1,
          contentHash: "abcdef123456",
        },
      ],
      commentableRanges: [
        {
          id: "rng_example",
          path: "src/example.ts",
          side: "RIGHT",
          startLine: 1,
          endLine: 1,
          kind: "added",
          hunkIndex: 1,
          hunkHeader: "@@ -1 +1 @@",
          hunkContentHash: "abcdef123456",
        },
      ],
    },
  ],
};

void diffManifestContract;

function validReviewFinding(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    body: "Finding body.",
    path: "src/example.ts",
    rangeId: "rng_example",
    side: "RIGHT",
    startLine: 1,
    endLine: 1,
    ...overrides,
  };
}

function fakeChange() {
  return {
    title: "Local change",
    description: "",
    base: { sha: "base" },
    head: { sha: "head" },
    async diffManifest() {
      return { baseSha: "base", headSha: "head", mergeBaseSha: "base", files: [] };
    },
    async changedFiles() {
      return [];
    },
  };
}

function fakeLog() {
  return {
    info() {},
    warn() {},
    error() {},
  };
}

function fakeCheck() {
  return {
    pass() {},
    fail() {},
    neutral() {},
  };
}

function fakeTaskContext(): TaskContext {
  return {
    run: { id: "test-run", trigger: "local" },
    repository: { root: "/tmp/repo", name: "repo" },
    platform: { id: "local" },
    change: fakeChange(),
    pi: {
      async run() {
        throw new Error("fake task context cannot run agents");
      },
    },
    review: {
      async prior() {
        return { inlineFindings: [] };
      },
    },
    secret() {
      return "secret";
    },
    check: fakeCheck(),
    async comment() {},
    log: fakeLog(),
  };
}
