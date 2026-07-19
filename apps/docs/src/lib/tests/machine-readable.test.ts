import { describe, expect, it } from "bun:test";
import { machineReadableStringifyOptions } from "../machine-readable";

type MachineReadableNode = Parameters<
  NonNullable<(typeof machineReadableStringifyOptions)["stringify"]>
>[0];

function typeTable(payload: unknown): MachineReadableNode {
  return {
    type: "mdxJsxFlowElement",
    name: "TypeTable",
    attributes: [
      { type: "mdxJsxAttribute", name: "id", value: "type-table-model-options" },
      {
        type: "mdxJsxAttribute",
        name: "type",
        value: {
          type: "mdxJsxAttributeValueExpression",
          value: JSON.stringify(payload),
        },
      },
    ],
    children: [],
  } as MachineReadableNode;
}

describe("machine-readable MDX", () => {
  it("converts generated type payloads into complete escaped Markdown tables", () => {
    const markdown = machineReadableStringifyOptions.stringify?.(
      typeTable({
        id: "model-options",
        name: "ModelOptions",
        entries: [
          {
            name: "thinking",
            description: "Use `high` | `low`.",
            type: '"high" | "low"',
            simplifiedType: "string",
            tags: [],
            required: false,
            deprecated: true,
          },
        ],
      }),
      undefined,
      {} as never,
      {} as never,
    );

    expect(markdown).toContain("### ModelOptions");
    expect(markdown).toContain("| Property | Type | Required | Description |");
    expect(markdown).toContain("thinking");
    expect(markdown).toContain('"high" \\| "low"');
    expect(markdown).not.toContain("string");
    expect(markdown).toContain("No");
    expect(markdown).toContain("Deprecated.");
    expect(markdown).toContain("Use `high` \\| `low`.");
  });

  it("flattens recipe wrappers while retaining their children", () => {
    for (const name of ["RecipeFileExplorer", "RecipeFilePane"]) {
      expect(
        machineReadableStringifyOptions.filterElement?.({
          type: "mdxJsxFlowElement",
          name,
          attributes: [],
          children: [],
        }),
      ).toBe("children-only");
    }

    const markdown = machineReadableStringifyOptions.stringify?.(
      {
        type: "mdxJsxFlowElement",
        name: "RecipeFilePane",
        attributes: [],
        children: [],
      },
      undefined,
      { containerFlow: () => "```ts\npipr.review({});\n```\n" } as never,
      {} as never,
    );
    expect(markdown).toContain("pipr.review({});");
    expect(markdown).not.toContain("RecipeFilePane");
  });

  it("fails on malformed generated type payloads", () => {
    expect(() =>
      machineReadableStringifyOptions.stringify?.(
        typeTable({ id: "broken", name: "Broken", entries: [{ name: "value" }] }),
        undefined,
        {} as never,
        {} as never,
      ),
    ).toThrow("malformed TypeTable payload");
  });
});
