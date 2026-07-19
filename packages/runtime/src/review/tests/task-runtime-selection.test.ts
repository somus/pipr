import { describe, expect, it } from "bun:test";
import type { PiprRunContext } from "@usepipr/sdk";
import { reviewTestManifest } from "../../tests/helpers/review-test-manifest.js";
import {
  askCommandInvocation,
  defaultReviewAgent,
  eventContext,
  expectedCodeUnitSortedCommandRunId,
  manifestBuilder,
  noFindingsPiResult,
  observeRunId,
  observingCommandRunIdPlan,
  observingRunIdPlan,
  runRuntime,
  testPlan,
} from "./task-runtime-fixtures.js";

describe("runTaskRuntime: selection and identity", () => {
  it("skips cleanly when no task matches the change request action", async () => {
    const plan = testPlan((pipr) => {
      const task = pipr.task({ name: "review", run() {} });
      pipr.on.changeRequest({ actions: ["reopened"], task });
    });

    const result = await runRuntime({
      plan,
      event: eventContext({ action: "opened" }),
    });

    expect(result).toMatchObject({
      kind: "skipped",
      skipReason: "No tasks matched the change request event",
    });
  });

  it("selects tasks from normalized change request actions", async () => {
    const seen: string[] = [];
    const plan = testPlan((pipr) => {
      const updated = pipr.task({
        name: "updated",
        async run(ctx) {
          seen.push("updated");
          await ctx.comment("updated");
        },
      });
      const ready = pipr.task({
        name: "ready",
        async run(ctx) {
          seen.push("ready");
          await ctx.comment("ready");
        },
      });
      pipr.on.changeRequest({ actions: ["updated"], task: updated });
      pipr.on.changeRequest({ actions: ["ready"], task: ready });
    });

    await runRuntime({
      plan,
      event: eventContext({ action: "updated" }),
    });
    await runRuntime({
      plan,
      event: eventContext({ action: "edited" }),
    });
    await runRuntime({
      plan,
      event: eventContext({ action: "ready" }),
    });

    expect(seen).toEqual(["updated", "ready"]);
  });

  it("passes undefined to change-request tasks", async () => {
    let observedInput: unknown = "unset";
    const plan = testPlan((pipr) => {
      const task = pipr.task({
        name: "review",
        async run(ctx, input) {
          observedInput = input;
          await ctx.comment("Review complete.");
        },
      });
      pipr.on.changeRequest({ actions: ["opened"], task });
    });

    await runRuntime({ plan });

    expect(observedInput).toBeUndefined();
  });

  it("passes command task input to the selected task", async () => {
    let observedInput: unknown;
    const plan = testPlan((pipr) => {
      pipr.task({
        name: "explain",
        async run(ctx, input) {
          observedInput = input;
          await ctx.comment("explained");
        },
      });
    });

    await runRuntime({
      plan,
      taskName: "explain",
      taskInput: { finding: "FND-123" },
    });

    expect(observedInput).toEqual({ finding: "FND-123" });
  });

  it("uses one immutable run context for tasks, agent prompts, custom tools, and results", async () => {
    let taskRun: PiprRunContext | undefined;
    let promptRun: PiprRunContext | undefined;
    let toolRun: PiprRunContext | undefined;
    const plan = testPlan((pipr) => {
      const customTool = pipr.tool({
        name: "custom_tool",
        description: "Store reviewer memory.",
        input: pipr.schemas.summary,
        output: pipr.schemas.summary,
        async run({ ctx, input }) {
          toolRun = ctx.run;
          try {
            (ctx.run as { trigger: PiprRunContext["trigger"] }).trigger = "local";
          } catch {}
          return input;
        },
      });
      const agent = defaultReviewAgent(pipr, {
        tools: [customTool],
        prompt(_input, context) {
          promptRun = context.run;
          try {
            (context.run as { trigger: PiprRunContext["trigger"] }).trigger = "command";
          } catch {}
          return "Review.";
        },
      });
      const task = pipr.task({
        name: "review",
        async run(ctx) {
          taskRun = ctx.run;
          const result = await ctx.pi.run(agent, { manifest: await ctx.change.diffManifest() });
          await ctx.comment({ main: result.summary.body, inlineFindings: result.inlineFindings });
        },
      });
      pipr.on.changeRequest({ actions: ["opened"], task });
    });

    const result = await runRuntime({
      plan,
      piRunner: async (options) => {
        await options.customTools?.tools[0]?.execute(options.customTools.context, {
          body: "Remember this.",
        });
        return noFindingsPiResult();
      },
    });

    if (result.kind !== "review") {
      throw new Error(`Expected review result, received ${result.kind}`);
    }
    expect(taskRun).toEqual({ id: expect.any(String), trigger: "change-request" });
    expect(promptRun).toEqual(taskRun);
    expect(toolRun).toEqual(taskRun);
    expect(result.run).toMatchObject(taskRun as PiprRunContext);
    expect(Object.isFrozen(taskRun)).toBe(true);
  });

  it("exposes local and command triggers before their final results", async () => {
    const observed: string[] = [];
    const plan = testPlan((pipr) => {
      const task = pipr.task({
        name: "review",
        async run(ctx) {
          observed.push(ctx.run.trigger);
          await ctx.comment("Review complete.");
        },
      });
      pipr.on.changeRequest({ actions: ["opened"], task });
    });

    const local = await runRuntime({ plan, runTrigger: "local" });
    const command = await runRuntime({
      plan,
      taskName: "review",
      commandInvocation: {
        name: "review",
        line: "@pipr review",
        arguments: {},
        sourceCommentId: "comment-1",
      },
    });

    expect(observed).toEqual(["local", "command"]);
    expect(local.kind === "review" ? local.run.trigger : undefined).toBe("local");
    expect(command.kind === "review" ? command.run.trigger : undefined).toBe("command");
  });

  it("derives stable run id from review identity inputs", async () => {
    const plan = observingRunIdPlan("review");
    const first = await observeRunId({ plan });
    const second = await observeRunId({ plan });
    const changedHead = await observeRunId({
      plan,
      event: eventContext({ headSha: "new-head" }),
      diffManifestBuilder: manifestBuilder({ ...reviewTestManifest(), headSha: "new-head" }),
    });
    const changedBase = await observeRunId({
      plan,
      event: eventContext({ baseSha: "new-base" }),
      diffManifestBuilder: manifestBuilder({
        ...reviewTestManifest(),
        baseSha: "new-base",
        mergeBaseSha: "new-base",
      }),
    });
    const changedTask = await observeRunId({ plan: observingRunIdPlan("security") });
    const changedConfig = await observeRunId({ plan, trustedConfigHash: "new-config-hash" });
    const changedConfigSha = await observeRunId({ plan, trustedConfigSha: "new-config-sha" });
    const commandPlan = observingCommandRunIdPlan();
    const command = await observeRunId({
      plan: commandPlan,
      taskName: "ask",
      commandInvocation: askCommandInvocation(),
    });
    const changedCommand = await observeRunId({
      plan: commandPlan,
      taskName: "ask",
      commandInvocation: {
        ...askCommandInvocation(),
        line: "@pipr ask why?",
        arguments: { question: "why?" },
      },
    });
    const commandArguments = await observeRunId({
      plan: commandPlan,
      taskName: "ask",
      commandInvocation: {
        ...askCommandInvocation(),
        arguments: { beta: "2", alpha: "1" },
      },
    });
    const reorderedCommandArguments = await observeRunId({
      plan: commandPlan,
      taskName: "ask",
      commandInvocation: {
        ...askCommandInvocation(),
        arguments: { alpha: "1", beta: "2" },
      },
    });
    const localeSensitiveCommandArguments = await observeRunId({
      plan: commandPlan,
      taskName: "ask",
      commandInvocation: {
        ...askCommandInvocation(),
        arguments: { ä: "umlaut", z: "letter" },
      },
    });
    const changedCommandSource = await observeRunId({
      plan: commandPlan,
      taskName: "ask",
      commandInvocation: { ...askCommandInvocation(), sourceCommentId: "456" },
    });

    expect(first).toBe(second);
    expect(changedHead).not.toBe(first);
    expect(changedBase).not.toBe(first);
    expect(changedTask).not.toBe(first);
    expect(changedConfig).not.toBe(first);
    expect(changedConfigSha).not.toBe(first);
    expect(changedCommand).not.toBe(command);
    expect(commandArguments).toBe(reorderedCommandArguments);
    expect(localeSensitiveCommandArguments).toBe(
      expectedCodeUnitSortedCommandRunId({ z: "letter", ä: "umlaut" }),
    );
    expect(changedCommandSource).not.toBe(command);
  });
});
