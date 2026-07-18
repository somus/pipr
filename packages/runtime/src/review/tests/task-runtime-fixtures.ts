import { expect } from "bun:test";
import { type Agent, definePipr, type ReviewResult, type TaskHandler } from "@usepipr/sdk";
import { buildPiprPlan } from "@usepipr/sdk/internal";
import { reviewTestManifest } from "../../tests/helpers/review-test-manifest.js";
import type { DiffManifest, PiprConfig, ProviderConfig, ReviewFinding } from "../../types.js";
import { priorReviewForTask } from "../task/task-output.js";
import {
  type PiRunner,
  type ReviewRuntimeResult,
  type RunTaskRuntimeOptions,
  runTaskRuntime,
} from "../task/task-runtime.js";

export const provider: ProviderConfig = {
  id: "deepseek/deepseek-v4-pro",
  provider: "deepseek",
  model: "deepseek-v4-pro",
  apiKeyEnv: "DEEPSEEK_API_KEY",
  thinking: "high",
};

const fallbackProvider: ProviderConfig = {
  id: "fallback",
  provider: "deepseek",
  model: "fallback-model",
  apiKeyEnv: "DEEPSEEK_API_KEY",
};

export const overrideProvider: ProviderConfig = {
  id: "override",
  provider: "deepseek",
  model: "override-model",
  apiKeyEnv: "DEEPSEEK_API_KEY",
};

export const config: PiprConfig = {
  defaultProvider: "deepseek/deepseek-v4-pro",
  providers: [provider],
  publication: {
    maxInlineComments: 5,
    maxStoredFindings: 50,
    showHeader: true,
    showFooter: true,
    showStats: true,
    autoResolve: {
      enabled: true,
      model: "deepseek/deepseek-v4-pro",
      synchronize: true,
      userReplies: {
        enabled: true,
        respondWhenStillValid: true,
        allowedActors: "author-or-write",
      },
    },
  },
};

export const fallbackConfig: PiprConfig = {
  ...config,
  providers: [provider, fallbackProvider],
};
export function eventContext(
  options: {
    action?: string;
    rawAction?: string;
    title?: string;
    description?: string;
    baseSha?: string;
    headSha?: string;
  } = {},
) {
  return {
    eventName: "pull_request",
    action: options.action ?? "opened",
    rawAction: options.rawAction,
    platform: { id: "github" },
    repository: { slug: "local/pipr" },
    change: {
      number: 1,
      title: options.title ?? "PR title",
      description: options.description ?? "PR body",
      base: { sha: options.baseSha ?? "base" },
      head: { sha: options.headSha ?? "head" },
    },
    workspace: process.cwd(),
  };
}

export type PiprApi = Parameters<Parameters<typeof definePipr>[0]>[0];
export type ReviewAgent = Agent<{ manifest: unknown }, ReviewResult>;
export type RunRuntimeOptions = Omit<
  RunTaskRuntimeOptions,
  "workspace" | "config" | "event" | "diffManifestBuilder"
> & {
  config?: PiprConfig;
  event?: RunTaskRuntimeOptions["event"];
  diffManifestBuilder?: RunTaskRuntimeOptions["diffManifestBuilder"];
};
export type ReviewOnlyRuntimeResult = Exclude<ReviewRuntimeResult, { kind: "command-response" }>;
export type CommandRunRuntimeOptions = RunRuntimeOptions & {
  commandInvocation: NonNullable<RunTaskRuntimeOptions["commandInvocation"]>;
};

export function testPlan(configure: (pipr: PiprApi) => void) {
  return buildPiprPlan(definePipr(configure));
}

export function singleTaskPlan(options: {
  name?: string;
  check?: Parameters<PiprApi["task"]>[0]["check"];
  run: TaskHandler<void>;
}) {
  return testPlan((pipr) => {
    const task = pipr.task({
      name: options.name ?? "review",
      check: options.check,
      run: options.run,
    });
    pipr.on.changeRequest({ actions: ["opened"], task });
  });
}

export function commandTaskPlan(run: Parameters<PiprApi["task"]>[0]["run"]) {
  return testPlan((pipr) => {
    const task = pipr.task({ name: "ask", run });
    pipr.command({ pattern: "@pipr ask <question...>", permission: "read", task });
  });
}

export function observingRunIdPlan(taskName: string) {
  return singleTaskPlan({
    name: taskName,
    async run(ctx) {
      await ctx.comment(ctx.run.id);
    },
  });
}

export function observingCommandRunIdPlan() {
  return commandTaskPlan(async (ctx) => {
    await ctx.comment(ctx.run.id);
  });
}

export function recordingCheckSink(outcomes: unknown[]): RunTaskRuntimeOptions["checkSink"] {
  return {
    setTaskResult(result) {
      outcomes.push(result);
    },
  };
}

export function deepseekModel(pipr: PiprApi, name = "deepseek", model = "deepseek-v4-pro") {
  return pipr.model({
    id: name === "deepseek" && model === "deepseek-v4-pro" ? undefined : name,
    provider: "deepseek",
    model,
    apiKey: pipr.secret({ name: "DEEPSEEK_API_KEY" }),
  });
}

export function defaultReviewAgent(
  pipr: PiprApi,
  options: Partial<Parameters<PiprApi["agent"]>[0]> = {},
) {
  return pipr.agent({
    name: "reviewer",
    model: options.model ?? deepseekModel(pipr),
    instructions: "Review.",
    output: pipr.schemas.review,
    prompt: () => "Review.",
    ...options,
  }) as ReviewAgent;
}

function customOkAgent<Input>(
  pipr: PiprApi,
  options: {
    name: string;
    instructions: string;
    outputId: string;
    prompt: () => string;
  },
) {
  return pipr.agent<Input, { ok: boolean }>({
    name: options.name,
    model: deepseekModel(pipr),
    instructions: options.instructions,
    output: {
      kind: "pipr.schema",
      id: options.outputId,
      parse(value) {
        return value as { ok: boolean };
      },
      safeParse(value) {
        return { success: true, data: value as { ok: boolean } };
      },
    },
    prompt: options.prompt,
  });
}

export function customOkTaskPlan<Input>(options: {
  taskName: string;
  agentName: string;
  instructions: string;
  outputId: string;
  input: Input;
}) {
  return testPlan((pipr) => {
    const agent = customOkAgent<Input>(pipr, {
      name: options.agentName,
      instructions: options.instructions,
      outputId: options.outputId,
      prompt: () => "Summarize.",
    });
    const task = pipr.task({
      name: options.taskName,
      async run(ctx) {
        const result = await ctx.pi.run(agent, options.input);
        await ctx.comment(JSON.stringify(result));
      },
    });
    pipr.on.changeRequest({ actions: ["opened"], task });
  });
}

export function defaultReviewPlan() {
  return testPlan((pipr) => {
    registerPiReviewTask(pipr, defaultReviewAgent(pipr));
  });
}

export function registerPiReviewTask(
  pipr: PiprApi,
  agent: ReviewAgent,
  runOptions?: Parameters<
    RunTaskRuntimeOptions["plan"]["tasks"][number]["handler"]
  >[0]["pi"]["run"] extends (...args: infer Args) => unknown
    ? Args[2]
    : never,
): void {
  const task = pipr.task({
    name: "review",
    async run(ctx) {
      const result = await ctx.pi.run(
        agent,
        { manifest: await ctx.change.diffManifest() },
        runOptions,
      );
      await ctx.comment({ main: result.summary.body, inlineFindings: result.inlineFindings });
    },
  });
  pipr.on.changeRequest({ actions: ["opened"], task });
}

export function fallbackReviewPlan(
  options: {
    agentModel?: "primary" | "fallback";
    agentPatch?: Partial<Parameters<PiprApi["agent"]>[0]>;
    runOverridesModel?: boolean;
  } = {},
) {
  return testPlan((pipr) => {
    const primary = deepseekModel(pipr);
    const fallback = deepseekModel(pipr, "fallback", "fallback-model");
    const agentModel = options.agentModel === "fallback" ? fallback : primary;
    const agent = defaultReviewAgent(pipr, {
      model: agentModel,
      fallbacks: [fallback],
      ...options.agentPatch,
    });
    registerPiReviewTask(
      pipr,
      agent,
      options.runOverridesModel ? { model: primary, fallbacks: [fallback] } : undefined,
    );
  });
}

export function registerCommentingAgentTask(
  pipr: PiprApi,
  taskName: string,
  agent: Agent<{ manifest: unknown }, unknown>,
): void {
  const task = pipr.task({
    name: taskName,
    async run(ctx) {
      const result = await ctx.pi.run(agent, { manifest: await ctx.change.diffManifest() });
      await ctx.comment(JSON.stringify(result));
    },
  });
  pipr.on.changeRequest({ actions: ["opened"], task });
}

export function scopedPiReviewPlan() {
  return testPlan((pipr) => {
    registerPiReviewTask(pipr, defaultReviewAgent(pipr), { paths: { include: ["src/**"] } });
  });
}

export async function runWithInsideOutsideFindings(plan: RunTaskRuntimeOptions["plan"]) {
  return await runRuntime({
    plan,
    piRunner: async () =>
      reviewPiResult([
        finding("inside", "range-1", 10),
        finding("outside", "range-1", 10, "docs/readme.md"),
      ]),
  });
}

export async function runCustomOkPlan(
  plan: RunTaskRuntimeOptions["plan"],
  observePrompt: (prompt: string) => void,
) {
  return await runRuntime({
    plan,
    piRunner: async (options) => {
      observePrompt(options.prompt);
      return { exitCode: 0, stdout: JSON.stringify({ ok: true }), stderr: "", durationMs: 1 };
    },
  });
}

export function expectOnlyInsideFinding(result: ReviewOnlyRuntimeResult) {
  expect(result.validated.validFindings.map((item) => item.body)).toEqual(["inside body"]);
  expectDroppedOutsideConfiguredPaths(result);
}

export function memoryTool(pipr: PiprApi) {
  return pipr.tool({
    name: "custom_tool",
    description: "Store reviewer memory.",
    input: pipr.schemas.summary,
    output: pipr.schemas.summary,
    async run({ input }) {
      return input;
    },
  });
}

export async function runRuntime(options: CommandRunRuntimeOptions): Promise<ReviewRuntimeResult>;
export async function runRuntime(options: RunRuntimeOptions): Promise<ReviewOnlyRuntimeResult>;
export async function runRuntime(options: RunRuntimeOptions): Promise<ReviewRuntimeResult> {
  const { config: runtimeConfig, event, diffManifestBuilder, ...rest } = options;
  return await runTaskRuntime({
    workspace: process.cwd(),
    config: runtimeConfig ?? config,
    event: event ?? eventContext(),
    diffManifestBuilder: diffManifestBuilder ?? manifestBuilder(),
    ...rest,
  });
}

export async function observeRunId(options: RunRuntimeOptions): Promise<string> {
  const result = await runRuntime(options);
  const runId = priorReviewForTask(result.mainComment, undefined).main;
  if (!runId) {
    throw new Error("test fixture missing run id comment");
  }
  return runId;
}

export function askCommandInvocation(): NonNullable<RunTaskRuntimeOptions["commandInvocation"]> {
  return {
    name: "ask",
    line: "@pipr ask what changed?",
    arguments: { question: "what changed?" },
    sourceCommentId: "123",
  };
}

export function expectedCodeUnitSortedCommandRunId(
  commandArguments: Record<string, string>,
): string {
  const event = eventContext();
  const command = askCommandInvocation();
  const hash = new Bun.CryptoHasher("sha256")
    .update(
      JSON.stringify({
        platform: event.platform.id,
        repository: event.repository.slug,
        changeNumber: event.change.number,
        baseSha: event.change.base.sha,
        headSha: event.change.head.sha,
        selectedTasks: ["ask"],
        command: {
          name: command.name,
          line: command.line,
          arguments: Object.fromEntries(
            Object.entries(commandArguments).sort(([left], [right]) =>
              left < right ? -1 : left > right ? 1 : 0,
            ),
          ),
          sourceCommentId: command.sourceCommentId,
        },
      }),
    )
    .digest("hex")
    .slice(0, 24);
  return `pipr-${hash}`;
}

export function manifestBuilder(manifest: DiffManifest = reviewTestManifest()) {
  return () => manifest;
}

export function replacingRedactor(detected: string) {
  return {
    addSecret() {},
    redact(value: string) {
      return {
        detected: value.includes(detected),
        value: value.replaceAll(detected, "[redacted secret]"),
      };
    },
  };
}

export function reviewTestManifestWithContext(): DiffManifest {
  const manifest = reviewTestManifest();
  return {
    ...manifest,
    files: manifest.files.map((file) => ({
      ...file,
      signals: ["tests"],
      changedSymbols: ["value"],
      commentableRanges: file.commentableRanges.map((range) => ({
        ...range,
        summary: "summary",
      })),
    })),
  };
}

export function reviewTestManifestWithDocs(): DiffManifest {
  const manifest = reviewTestManifest();
  return {
    ...manifest,
    files: [
      ...manifest.files,
      {
        path: "docs/readme.md",
        status: "modified",
        additions: 1,
        deletions: 0,
        hunks: [
          {
            hunkIndex: 1,
            header: "@@ -1,1 +1,1 @@",
            oldStart: 1,
            oldLines: 1,
            newStart: 1,
            newLines: 1,
            contentHash: "feedfacecafe",
          },
        ],
        commentableRanges: [
          {
            id: "docs-range-1",
            path: "docs/readme.md",
            side: "RIGHT",
            startLine: 1,
            endLine: 1,
            kind: "added",
            hunkIndex: 1,
            hunkHeader: "@@ -1,1 +1,1 @@",
            hunkContentHash: "feedfacecafe",
            preview: "Docs.",
          },
        ],
      },
    ],
  };
}

export function priorReviewStateForTasks(
  selectedTasks: string[],
): NonNullable<RunTaskRuntimeOptions["priorReviewState"]> {
  return {
    version: 1,
    reviewedHeadSha: "head",
    selectedTasks,
    findings: [
      {
        id: "fnd_existing",
        status: "open",
        path: "src/a.ts",
        rangeId: "range-1",
        side: "RIGHT",
        startLine: 10,
        endLine: 10,
        firstSeenHeadSha: "head",
        lastSeenHeadSha: "head",
        lastCommentedHeadSha: "head",
      },
    ],
  };
}

export function finding(
  title: string,
  rangeId: string,
  startLine: number,
  filePath = "src/a.ts",
): ReviewFinding {
  return {
    body: `${title} body`,
    path: filePath,
    rangeId,
    side: "RIGHT",
    startLine,
    endLine: startLine,
  };
}

function expectDroppedOutsideConfiguredPaths(result: ReviewOnlyRuntimeResult): void {
  expect(result.validated.droppedFindings).toEqual([
    {
      finding: expect.objectContaining({ body: "outside body" }),
      reason: "finding path is outside configured paths",
    },
  ]);
}

export function noFindingsPiRunner(): PiRunner {
  return async () => noFindingsPiResult();
}

export function providerFailurePiRunner(calls: string[]): PiRunner {
  return async (options) => {
    calls.push(options.provider.model);
    return options.provider.id === "deepseek/deepseek-v4-pro"
      ? { exitCode: 1, stdout: "", stderr: "temporary failure", durationMs: 1 }
      : noFindingsPiResult();
  };
}

export function noFindingsPiResult() {
  return reviewPiResult([]);
}

export function reviewPiResult(findings: ReviewFinding[]) {
  return {
    exitCode: 0,
    stdout: JSON.stringify({ summary: { body: "No findings." }, inlineFindings: findings }),
    stderr: "",
    durationMs: 1,
  };
}

export function countOccurrences(value: string, needle: string): number {
  return value.split(needle).length - 1;
}
