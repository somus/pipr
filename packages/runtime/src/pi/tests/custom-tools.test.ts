import { describe, expect, it } from "bun:test";
import { callCustomTool, customToolSpecs } from "../custom-tools.js";

describe("custom config tools", () => {
  it("runs bridged calls with the task context and validated input", async () => {
    let observedContext: unknown;
    const request = {
      context: { run: { id: "run-1" } },
      tools: [
        {
          name: "plugin_echo",
          description: "Echo input.",
          input: summarySchema(),
          output: summarySchema(),
          async execute(context: unknown, input: unknown) {
            observedContext = context;
            return { body: `stored:${(input as { body: string }).body}` };
          },
        },
      ],
    };

    expect(customToolSpecs(request)).toEqual([
      {
        name: "plugin_echo",
        description: "Echo input.",
        parameters: { type: "object", additionalProperties: true },
      },
    ]);
    await expect(
      callCustomTool(request, { tool: "plugin_echo", args: { body: "memory" } }),
    ).resolves.toEqual({ body: "stored:memory" });
    expect(observedContext).toEqual({ run: { id: "run-1" } });
  });

  it("reports input, output, and unknown-tool errors", async () => {
    const request = {
      context: {},
      tools: [
        {
          name: "plugin_strict",
          input: summarySchema(),
          output: summarySchema(),
          async execute() {
            return { title: "missing body" };
          },
        },
      ],
    };

    await expect(
      callCustomTool(request, { tool: "plugin_strict", args: { title: "missing" } }),
    ).rejects.toThrow("summary.body is required");
    await expect(
      callCustomTool(request, { tool: "plugin_strict", args: { body: "ok" } }),
    ).rejects.toThrow("summary.body is required");
    await expect(callCustomTool(request, { tool: "plugin_other", args: {} })).rejects.toThrow(
      "Unknown custom tool 'plugin_other'",
    );
  });
});

function summarySchema() {
  return {
    parse(value: unknown) {
      if (
        typeof value === "object" &&
        value !== null &&
        typeof Reflect.get(value, "body") === "string"
      ) {
        return { body: Reflect.get(value, "body") as string };
      }
      throw new Error("summary.body is required");
    },
  };
}
