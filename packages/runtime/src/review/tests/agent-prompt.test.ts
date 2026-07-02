import { describe, expect, it } from "bun:test";
import type { Agent, Schema } from "@usepipr/sdk";
import { type AgentRunContext, renderAgentPrompt } from "../agent/agent-prompt.js";

const unknownSchema: Schema<unknown> = {
  kind: "pipr.schema",
  id: "test/unknown",
  parse(value) {
    return value;
  },
  safeParse(value) {
    return { success: true, data: value };
  },
};

describe("renderAgentPrompt", () => {
  it("isolates top-level prompt context mutations from the prepared run context", async () => {
    const promptContext: AgentRunContext["prompt"] = {
      runId: "run-1",
      repository: { root: "/repo", name: "pipr" },
      change: {
        number: 12,
        title: "Original title",
        description: "Original description",
        base: { sha: "base" },
        head: { sha: "head" },
      },
      platform: { id: "github" },
    };
    const originalPromptContext = structuredClone(promptContext);
    const agent: Agent<unknown, unknown> = {
      kind: "pipr.agent",
      name: "mutating-agent",
      definition: {
        instructions: "Review.",
        output: unknownSchema,
        prompt(_input, context) {
          context.runId = "mutated-run";
          context.repository = { root: "/mutated", name: "mutated" };
          context.change = {
            title: "Mutated title",
            description: "Mutated description",
            base: { sha: "mutated-base" },
            head: { sha: "mutated-head" },
          };
          context.platform = { id: "mutated" };
          return "Review.";
        },
      },
      extend() {
        throw new Error("unused");
      },
    };

    await renderAgentPrompt({
      agent,
      input: {},
      agentTools: { customTools: [] },
      agentRunContext: {
        prompt: promptContext,
        tools: {
          run: { id: promptContext.runId },
          repository: promptContext.repository,
          change: promptContext.change,
          platform: promptContext.platform,
        },
      },
      runtime: {},
    });

    expect(promptContext).toEqual(originalPromptContext);
  });
});
