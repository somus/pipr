import { afterAll, afterEach, describe, expect, it } from "bun:test";
import { access, mkdtemp as createTemporaryDirectory, mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { inspectRuntimePlan, loadRuntimeProject, validateProject } from "../project.js";
import { loadTypescriptConfig } from "../ts-loader.js";
import {
  initOfficialMinimalProjectWithLocalDependencies as initOfficialMinimalProject,
  useLocalInitSdk,
} from "./helpers/local-init-sdk.js";

const cleanupLocalInitSdk = await useLocalInitSdk();
afterAll(cleanupLocalInitSdk);
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

describe("loadRuntimeProject", () => {
  it("requires an initialized TypeScript config", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "pipr-config-"));

    await expect(loadRuntimeProject({ rootDir })).rejects.toThrow(
      `No Pipr config found at ${path.join(rootDir, ".pipr", "config.ts")}.`,
    );
  });

  it("rejects invalid TypeScript config exports", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "pipr-config-"));
    await mkdir(path.join(rootDir, ".pipr"));
    await Bun.write(path.join(rootDir, ".pipr", "config.ts"), "export default {};\n");

    await expect(loadRuntimeProject({ rootDir })).rejects.toThrow(
      "default export must be created by definePipr()",
    );
  });

  it("requires an explicit apiKey for providers without a standard key variable", async () => {
    const rootDir = await newConfigProject(
      minimalReviewConfig().replace(
        'pipr.model("deepseek/deepseek-v4-pro", { apiKey: pipr.secret({ name: "DEEPSEEK_API_KEY" }) })',
        'pipr.model("gateway/model")',
      ),
    );

    await expect(loadRuntimeProject({ rootDir })).rejects.toThrow(
      "model 'gateway/model' uses provider 'gateway', which has no standard API key environment variable",
    );
  });

  it("normalizes TypeScript model config for current runtime execution", async () => {
    const rootDir = await newInitializedProject();

    const settings = (await loadRuntimeProject({ rootDir })).settings;

    expect(settings.source).toContain(".pipr/config.ts");
    expect(settings.config.defaultProvider).toBe("deepseek/deepseek-v4-pro");
    expect(settings.config.providers[0]).toMatchObject({
      id: "deepseek/deepseek-v4-pro",
      provider: "deepseek",
      model: "deepseek-v4-pro",
      apiKeyEnv: "DEEPSEEK_API_KEY",
      thinking: "high",
    });
    expect(settings.config.publication.maxInlineComments).toBe(5);
    expect(settings.config.publication.maxStoredFindings).toBe(50);
    expect(settings.config.publication).toMatchObject({
      showHeader: true,
      showFooter: true,
      showStats: true,
      showProgress: true,
    });
  });

  it("normalizes the configured stored finding limit", async () => {
    const rootDir = await newInitializedProject();
    await writePiprConfig(rootDir, configWithPresentation("{ maxStoredFindings: 0 }"));

    const settings = (await loadRuntimeProject({ rootDir })).settings;

    expect(settings.config.publication.maxStoredFindings).toBe(0);
  });

  it("normalizes disabled main comment presentation settings", async () => {
    const rootDir = await newInitializedProject();
    await writePiprConfig(
      rootDir,
      configWithPresentation(
        "{ showHeader: false, showFooter: false, showStats: false, showProgress: false }",
      ),
    );

    const settings = (await loadRuntimeProject({ rootDir })).settings;

    expect(settings.config.publication).toMatchObject({
      showHeader: false,
      showFooter: false,
      showStats: false,
      showProgress: false,
    });
  });

  it("defaults publication autoResolve to verifier-enabled defaults", async () => {
    const rootDir = await newInitializedProject();

    const settings = (await loadRuntimeProject({ rootDir })).settings;

    expect(settings.config.publication.autoResolve).toEqual({
      enabled: true,
      model: "deepseek/deepseek-v4-pro",
      synchronize: true,
      userReplies: {
        enabled: true,
        respondWhenStillValid: true,
        allowedActors: "author-or-write",
      },
    });
  });

  it("normalizes disabled publication autoResolve", async () => {
    const rootDir = await newInitializedProject();
    await writePiprConfig(rootDir, configWithAutoResolve("false"));

    const settings = (await loadRuntimeProject({ rootDir })).settings;

    expect(settings.config.publication.autoResolve).toEqual({
      enabled: false,
      synchronize: false,
      userReplies: {
        enabled: false,
        respondWhenStillValid: true,
        allowedActors: "author-or-write",
      },
    });
  });

  it("normalizes partial publication autoResolve options and selected model", async () => {
    const rootDir = await newInitializedProject();
    await writePiprConfig(
      rootDir,
      configWithAutoResolve(`{
        model: fastModel,
        instructions: "If the user explains an intentional public API change, prefer resolving the finding.",
        synchronize: false,
        userReplies: {
          enabled: true,
          respondWhenStillValid: false,
          allowedActors: "write",
        },
      }`),
    );

    const settings = (await loadRuntimeProject({ rootDir })).settings;

    expect(settings.config.publication.autoResolve).toEqual({
      enabled: true,
      model: "fast-verifier",
      instructions:
        "If the user explains an intentional public API change, prefer resolving the finding.",
      synchronize: false,
      userReplies: {
        enabled: true,
        respondWhenStillValid: false,
        allowedActors: "write",
      },
    });
  });

  it("rejects publication autoResolve model when disabled", async () => {
    const rootDir = await newInitializedProject();
    await writePiprConfig(
      rootDir,
      configWithAutoResolve(`{
        enabled: false,
        model: fastModel,
      }`),
    );

    await expect(loadRuntimeProject({ rootDir })).rejects.toThrow(
      "publication.autoResolve.model cannot be set when autoResolve is disabled",
    );
  });

  it("checks provider env vars only when requested", async () => {
    const rootDir = await newInitializedProject();

    await expect(
      loadRuntimeProject({ rootDir, env: {}, requireProviderEnv: false }),
    ).resolves.toMatchObject({
      settings: {
        config: {
          defaultProvider: "deepseek/deepseek-v4-pro",
        },
      },
    });
    await expect(
      loadRuntimeProject({ rootDir, env: {}, requireProviderEnv: true }),
    ).rejects.toThrow("Missing provider env vars: DEEPSEEK_API_KEY");
  });

  it("accepts a provider's fallback credentials and keeps an explicit key required", async () => {
    const config = (apiKey: string) => `import { definePipr } from "@usepipr/sdk";

export default definePipr((pipr) => {
  pipr.review({
    id: "review",
    model: pipr.model("amazon-bedrock/claude"${apiKey}),
    instructions: "Review this change.",
  });
});
`;
    const defaultKey = await newConfigProject(config(""));
    const explicitKey = await newConfigProject(
      config(', { apiKey: pipr.secret({ name: "BEDROCK_TOKEN" }) }'),
    );
    const env = { AWS_ACCESS_KEY_ID: "id", AWS_SECRET_ACCESS_KEY: "secret" };

    const runtime = await loadRuntimeProject({
      rootDir: defaultKey,
      env,
      requireProviderEnv: true,
    });

    expect(runtime.settings.config.providers[0]).toMatchObject({
      apiKeyEnv: "AWS_BEARER_TOKEN_BEDROCK",
      providerEnv: expect.arrayContaining(["AWS_SECRET_ACCESS_KEY", "AWS_REGION"]),
      credentialEnv: expect.arrayContaining(["AWS_ACCESS_KEY_ID", "AWS_PROFILE"]),
    });
    await expect(
      loadRuntimeProject({ rootDir: explicitKey, env, requireProviderEnv: true }),
    ).rejects.toThrow("Missing provider env vars: BEDROCK_TOKEN");
  });

  it("allows a local Pi authenticated model alongside an API-key model", async () => {
    const rootDir = await newConfigProject(`import { definePipr } from "@usepipr/sdk";

export default definePipr((pipr) => {
  const localModel = pipr.model("openai-codex/gpt-5.5", { apiKey: "local" });
  const hostedModel = pipr.model("deepseek/deepseek-v4-pro", { apiKey: pipr.secret({ name: "DEEPSEEK_API_KEY" }) });
  pipr.review({
    id: "review",
    model: hostedModel,
    instructions: "Review this change.",
    summary: { instructions: "Summarize this change." },
  });
  void localModel;
});
`);

    const runtime = await loadRuntimeProject({
      rootDir,
      env: { DEEPSEEK_API_KEY: "hosted-key" },
      requireProviderEnv: true,
    });

    expect(runtime).toMatchObject({
      settings: {
        config: {
          providers: [
            {
              id: "openai-codex/gpt-5.5",
              provider: "openai-codex",
              model: "gpt-5.5",
            },
            {
              id: "deepseek/deepseek-v4-pro",
              apiKeyEnv: "DEEPSEEK_API_KEY",
            },
          ],
        },
      },
    });
    await expect(
      loadRuntimeProject({ rootDir, env: {}, requireProviderEnv: true }),
    ).rejects.toThrow("Missing provider env vars: DEEPSEEK_API_KEY");
  });

  it("type-checks .pipr/config.ts during validation", async () => {
    const rootDir = await newInitializedProject();
    await writePiprConfig(
      rootDir,
      `import { definePipr } from "@usepipr/sdk";

export default definePipr((pipr) => {
  const model: string = pipr.model("deepseek/deepseek-v4-pro", { apiKey: pipr.secret({ name: "DEEPSEEK_API_KEY" }) });

  pipr.review({
    id: "review",
    model,
    instructions: "Review this change.",
    summary: { instructions: "Summarize this change." },
  });
});
`,
    );

    await expect(validateProject({ rootDir })).rejects.toThrow("TypeScript config check failed");
  });

  it("can load a TypeScript config without type-checking it", async () => {
    const rootDir = await newInitializedProject();
    await writePiprConfig(
      rootDir,
      `import { definePipr } from "@usepipr/sdk";

export default definePipr((pipr) => {
  const model: string = pipr.model("deepseek/deepseek-v4-pro", { apiKey: pipr.secret({ name: "DEEPSEEK_API_KEY" }) });

  pipr.review({
    id: "review",
    model,
    instructions: "Review this change.",
    summary: { instructions: "Summarize this change." },
  });
});
`,
    );

    await expect(loadTypescriptConfig({ rootDir, typecheck: false })).resolves.toMatchObject({
      source: path.join(rootDir, ".pipr", "config.ts"),
    });
  });

  it("type-checks without committed tsconfig or generated type files", async () => {
    const rootDir = await newConfigProject(minimalReviewConfig({ bunS3: true }));

    await expect(loadTypescriptConfig({ rootDir, typecheck: true })).resolves.toMatchObject({
      source: path.join(rootDir, ".pipr", "config.ts"),
    });
  });

  it("type-checks config tsconfig files that extend repo-level config", async () => {
    const rootDir = await newConfigProject(minimalReviewConfig());
    await Bun.write(
      path.join(rootDir, "tsconfig.base.json"),
      JSON.stringify({
        compilerOptions: {
          strict: true,
          noEmit: true,
          target: "ES2022",
          module: "ESNext",
          moduleResolution: "Bundler",
        },
      }),
    );
    await Bun.write(
      path.join(rootDir, ".pipr", "tsconfig.json"),
      JSON.stringify({
        extends: "../tsconfig.base.json",
        include: ["./**/*.ts"],
      }),
    );

    await expect(loadTypescriptConfig({ rootDir, typecheck: true })).resolves.toMatchObject({
      source: path.join(rootDir, ".pipr", "config.ts"),
    });
  });

  it("type-checks user plugins and lists registered custom tools", async () => {
    const rootDir = await newInitializedProject();
    await writePiprConfig(
      rootDir,
      `import { definePipr, definePlugin } from "@usepipr/sdk";

export default definePipr((pipr) => {
  const memory = pipr.use(definePlugin((pluginPipr) => ({
    store: pluginPipr.tool({
      name: "pipr_store_memory",
      description: "Store reviewer memory.",
      input: pluginPipr.schemas.summary,
      output: pluginPipr.schemas.summary,
      run: async ({ input }) => input,
    }),
    search: pluginPipr.tool({
      name: "pipr_search_memories",
      description: "Search reviewer memories.",
      input: pluginPipr.schemas.summary,
      output: pluginPipr.schemas.summary,
      run: async ({ input }) => input,
    }),
  })));
  const model = pipr.model("deepseek/deepseek-v4-pro", { apiKey: pipr.secret({ name: "DEEPSEEK_API_KEY" }) });
  const agent = pipr.agent({
    name: "reviewer",
    model,
    instructions: "Review.",
    output: pipr.schemas.review,
    tools: [...pipr.tools.readOnly, memory.store, memory.search],
    prompt: (input: { diff: unknown }, context) => {
      void context.change.title;
      return pipr.prompt\`Review \${input.diff}\`;
    },
  });
  pipr.task({
    name: "review",
    on: {
      changeRequest: ["opened"],
      command: { pattern: "@pipr review", permission: "write" },
    },
    check: { enabled: true, name: "review-check", required: false },
    async run(ctx) {
    const diff = await ctx.change.diff({ compressed: true, maxPreviewLines: 1 });
    const result = await ctx.pi.run(agent, { diff });
    await ctx.comment({ main: ctx.change.title, inlineFindings: result.inlineFindings });
    },
  });
  pipr.config({
    publication: { maxInlineComments: 4 },
    checks: { aggregate: { enabled: true, name: "all-review" } },
    limits: { maxAgentRuns: 9 },
  });
  pipr.review({
    id: "default-review",
    model,
    instructions: "Review.",
    summary: { instructions: "Summarize." },
    on: {},
  });
});
`,
    );

    const loaded = await validateProject({ rootDir });
    const inspection = inspectRuntimePlan(loaded.plan, ".pipr/config.ts");
    expect(inspection.tools).toEqual(["pipr_store_memory", "pipr_search_memories"]);
    expect(inspection.schemas).toEqual(["core/pr-review", "core/inline-findings", "core/summary"]);
    expect(inspection.publication).toEqual({
      maxInlineComments: 4,
      showHeader: true,
      showFooter: true,
      showStats: true,
      showProgress: true,
      autoResolve: {
        enabled: true,
        model: "deepseek/deepseek-v4-pro",
        synchronize: true,
        userReplies: {
          enabled: true,
          respondWhenStillValid: true,
          allowedActors: "author-or-write",
        },
        hasCustomInstructions: false,
      },
    });
    expect(inspection.limits).toEqual({ maxAgentRuns: 9 });
    expect(inspection.checks).toEqual({
      aggregate: { enabled: true, name: "all-review" },
      tasks: [
        {
          task: "review",
          individual: true,
          aggregate: true,
          name: "review-check",
          required: false,
        },
        {
          task: "default-review",
          individual: false,
          aggregate: true,
          name: "default-review",
          required: true,
        },
      ],
    });
  });

  it("loads root SDK imports from the runtime stub", async () => {
    const rootDir = await newInitializedProject();
    await writePiprConfig(
      rootDir,
      `import { definePipr } from "@usepipr/sdk";
import { reviewSchemaExample } from "@usepipr/sdk";

export default definePipr((pipr) => {
  const example = reviewSchemaExample();
  const model = pipr.model("deepseek/deepseek-v4-pro", { apiKey: pipr.secret({ name: "DEEPSEEK_API_KEY" }) });
  const reviewer = pipr.agent({
    name: "reviewer",
    model,
    instructions: \`Review. Example summary: \${example.summary.body}\`,
    output: pipr.schemas.review,
    prompt: () => "Review.",
  });
  pipr.task({ name: "review", on: { changeRequest: ["opened"] }, async run() {} });
  void reviewer;
});
`,
    );

    const loaded = await loadRuntimeProject({ rootDir });

    expect(loaded.plan.agents.map((agent) => agent.name)).toEqual(["reviewer"]);
  });

  it("removes the temporary config copy after loading", async () => {
    const rootDir = await newInitializedProject();

    const loaded = await loadTypescriptConfig({ rootDir });

    await expect(access(loaded.tempRoot)).rejects.toThrow();
  });
});

async function newInitializedProject(): Promise<string> {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "pipr-config-"));
  await initOfficialMinimalProject({ rootDir });
  return rootDir;
}

async function newConfigProject(contents: string): Promise<string> {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "pipr-config-"));
  await mkdir(path.join(rootDir, ".pipr"));
  await writePiprConfig(rootDir, contents);
  return rootDir;
}

async function writePiprConfig(rootDir: string, contents: string): Promise<void> {
  await Bun.write(path.join(rootDir, ".pipr", "config.ts"), contents);
}

function minimalReviewConfig(options: { bunS3?: boolean } = {}): string {
  const bunImport = options.bunS3 ? 'import { S3Client } from "bun";\n' : "";
  const bunUsage = options.bunS3 ? "  void S3Client;\n" : "";
  return `${bunImport}import { definePipr } from "@usepipr/sdk";

export default definePipr((pipr) => {
${bunUsage}  const model = pipr.model("deepseek/deepseek-v4-pro", { apiKey: pipr.secret({ name: "DEEPSEEK_API_KEY" }) });
  pipr.review({
    id: "review",
    model,
    instructions: "Review this change.",
    summary: { instructions: "Summarize this change." },
  });
});
`;
}

function configWithAutoResolve(autoResolve: string): string {
  return `import { definePipr } from "@usepipr/sdk";

export default definePipr((pipr) => {
  const model = pipr.model("deepseek/deepseek-v4-pro", { id: "deepseek/deepseek-v4-pro", apiKey: pipr.secret({ name: "DEEPSEEK_API_KEY" }) });
  const fastModel = pipr.model("deepseek/deepseek-v4", { id: "fast-verifier", apiKey: pipr.secret({ name: "DEEPSEEK_API_KEY" }) });
  pipr.config({
    publication: {
      autoResolve: ${autoResolve},
    },
  });
  pipr.review({
    id: "review",
    model,
    instructions: "Review this change.",
    summary: { instructions: "Summarize this change." },
  });
  void fastModel;
});
`;
}

function configWithPresentation(publication: string): string {
  return `import { definePipr } from "@usepipr/sdk";

export default definePipr((pipr) => {
  const model = pipr.model("deepseek/deepseek-v4-pro", { apiKey: pipr.secret({ name: "DEEPSEEK_API_KEY" }) });
  pipr.config({ publication: ${publication} });
  pipr.review({
    id: "review",
    model,
    instructions: "Review this change.",
    summary: { instructions: "Summarize this change." },
  });
});
`;
}
