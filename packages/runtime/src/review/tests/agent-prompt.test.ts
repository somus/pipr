import { describe, expect, it } from "bun:test";
import type { Agent, Schema } from "@usepipr/sdk";
import { type AgentRunContext, renderAgentPrompt } from "../agent/agent-prompt.js";
import { maxInlineFindingBodyCharacters } from "../inline-finding-limits.js";
import { reviewResultSchemaId } from "../review.js";

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

const reviewSchema: Schema<unknown> = {
  ...unknownSchema,
  id: reviewResultSchemaId,
};

describe("renderAgentPrompt", () => {
  it("includes review policy for core review outputs", async () => {
    const prompt = await renderTestPrompt(reviewSchema);

    expect(prompt).toContain("Review Policy:");
    expect(prompt).toContain("Review only changed behavior.");
    expect(prompt).toContain("Report only actionable defects");
    expect(prompt).toContain("Do not leave actionable defects or test gaps only in the summary.");
    expect(prompt).toContain("Inline finding bodies are final code-review comments");
    expect(prompt).toContain(
      `at most two sentences, and at most ${maxInlineFindingBodyCharacters} characters.`,
    );
    expect(prompt).toContain(
      `Treat ${maxInlineFindingBodyCharacters} as a hard ceiling, not a target`,
    );
    expect(prompt).toContain("Do not include step-by-step reasoning, broad context");
    expect(prompt).toContain("one inline finding");
    expect(prompt).toContain("exact Diff Manifest commentable range");
    expect(prompt).toContain("smallest contiguous `startLine` to `endLine` span");
    expect(prompt).toContain("Do not select a larger enclosing block");
  });

  it("does not include review policy for non-review outputs", async () => {
    const prompt = await renderTestPrompt(unknownSchema);

    expect(prompt).not.toContain("Review Policy:");
    expect(prompt).not.toContain("Report only actionable defects");
  });

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

async function renderTestPrompt(output: Schema<unknown>): Promise<string> {
  const agent: Agent<unknown, unknown> = {
    kind: "pipr.agent",
    name: "reviewer",
    definition: {
      instructions: "Review.",
      output,
      prompt: () => "Review this change.",
    },
    extend() {
      throw new Error("unused");
    },
  };

  return await renderAgentPrompt({
    agent,
    input: {},
    agentTools: { customTools: [] },
    agentRunContext: {
      prompt: {
        runId: "run-1",
        repository: { root: "/repo", name: "pipr" },
        change: {
          number: 12,
          title: "Change title",
          description: "Change description",
          base: { sha: "base" },
          head: { sha: "head" },
        },
        platform: { id: "github" },
      },
      tools: {
        run: { id: "run-1" },
        repository: { root: "/repo", name: "pipr" },
        change: {
          number: 12,
          title: "Change title",
          description: "Change description",
          base: { sha: "base" },
          head: { sha: "head" },
        },
        platform: { id: "github" },
      },
    },
    runtime: {},
  });
}
