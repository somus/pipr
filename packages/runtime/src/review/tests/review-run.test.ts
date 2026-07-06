import { describe, expect, it } from "bun:test";
import { definePipr, type Schema } from "@usepipr/sdk";
import { buildPiprPlan } from "@usepipr/sdk/internal";
import type { ChangeRequestEventContext, PiprConfig, ProviderConfig } from "../../types.js";
import { runReviewAgent } from "../agent/review-run.js";

const provider: ProviderConfig = {
  id: "test-provider/test-model",
  provider: "test-provider",
  model: "test-model",
  apiKeyEnv: "TEST_PROVIDER_API_KEY",
};

const config: PiprConfig = {
  defaultProvider: provider.id,
  providers: [provider],
  publication: {
    autoResolve: {
      enabled: false,
      synchronize: false,
      userReplies: {
        enabled: false,
        respondWhenStillValid: false,
        allowedActors: "author-or-write",
      },
    },
  },
};

const outputSchema: Schema<unknown> = {
  kind: "pipr.schema",
  id: "test/output",
  parse(value) {
    return value;
  },
  safeParse(value) {
    return { success: true, data: value };
  },
};

describe("runReviewAgent", () => {
  it("fails closed when no stable run id is supplied", async () => {
    let piInvoked = false;
    const factory = definePipr((pipr) => {
      pipr.agent({
        name: "reviewer",
        instructions: "Review.",
        output: outputSchema,
        prompt: () => "Review.",
      });
    });
    const plan = buildPiprPlan(factory);
    const agent = plan.agents[0];
    if (!agent) {
      throw new Error("test fixture missing agent");
    }

    await expect(
      runReviewAgent({
        agent,
        input: {},
        runOptions: undefined,
        toolMode: "none",
        runtime: {
          workspace: process.cwd(),
          config,
          event: eventContext(),
          provider,
          plan,
          piRunner: async () => {
            piInvoked = true;
            return { exitCode: 0, stdout: "{}", stderr: "", durationMs: 1 };
          },
        },
      }),
    ).rejects.toThrow("runId is required for stable review run identity");
    expect(piInvoked).toBe(false);
  });
});

function eventContext(): ChangeRequestEventContext {
  return {
    eventName: "pull_request",
    action: "opened",
    platform: { id: "github" },
    repository: { slug: "local/pipr" },
    change: {
      number: 1,
      title: "PR title",
      description: "PR body",
      base: { sha: "base" },
      head: { sha: "head" },
    },
    workspace: process.cwd(),
  };
}
