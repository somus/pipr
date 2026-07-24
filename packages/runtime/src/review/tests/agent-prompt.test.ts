import { describe, expect, it } from "bun:test";
import type { JsonObject, Schema } from "@usepipr/sdk";
import type { RuntimeAgent } from "@usepipr/sdk/internal";
import { type AgentRunContext, renderAgentPrompt } from "../agent/agent-prompt.js";
import type { PreparedDiffManifestContext } from "../agent/diff-manifest-context.js";
import { maxInlineFindingBodyCharacters } from "../inline-finding-limits.js";
import type { PriorReviewState } from "../prior-state.js";
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

const customSuggestedFixSchema: Schema<unknown> = {
  ...unknownSchema,
  id: "test/custom-suggestions",
  jsonSchema: {
    type: "object",
    properties: {
      findings: {
        type: "array",
        items: {
          type: "object",
          properties: {
            suggestedFix: { type: "string" },
          },
        },
      },
    },
  },
};

const customReviewSchema: Schema<unknown> = {
  ...unknownSchema,
  id: "test/custom-review",
  jsonSchema: {
    type: "object",
    properties: {
      findings: {
        type: "array",
        items: {
          type: "object",
          properties: {
            body: { type: "string" },
            path: { type: "string" },
            rangeId: { type: "string" },
            side: { enum: ["RIGHT", "LEFT"] },
            startLine: { type: "number" },
            endLine: { type: "number" },
          },
        },
      },
    },
  },
};

const reviewFindingDefinition = {
  type: "object",
  properties: {
    title: { type: "string" },
    severity: { enum: ["high", "low"] },
    body: { type: "string" },
    path: { type: "string" },
    rangeId: { type: "string" },
    side: { enum: ["RIGHT", "LEFT"] },
    startLine: { type: "number" },
    endLine: { type: "number" },
  },
} satisfies JsonObject;

const referencedCustomReviewSchema: Schema<unknown> = {
  ...unknownSchema,
  id: "test/referenced-custom-review",
  jsonSchema: {
    $defs: {
      finding: reviewFindingDefinition,
    },
    type: "object",
    properties: {
      risks: {
        type: "array",
        items: { $ref: "#/$defs/finding" },
      },
    },
  },
};

const composedCustomReviewSchema: Schema<unknown> = {
  ...unknownSchema,
  id: "test/composed-custom-review",
  jsonSchema: {
    $defs: {
      content: {
        type: "object",
        properties: {
          body: { type: "string" },
        },
      },
      location: {
        type: "object",
        properties: {
          path: { type: "string" },
          rangeId: { type: "string" },
          side: { enum: ["RIGHT", "LEFT"] },
          startLine: { type: "number" },
          endLine: { type: "number" },
        },
      },
      finding: {
        allOf: [{ $ref: "#/$defs/content" }, { $ref: "#/$defs/location" }],
      },
    },
    type: "object",
    properties: {
      findings: {
        type: "array",
        items: { $ref: "#/$defs/finding" },
      },
    },
  },
};

const composedAlternativeCustomReviewSchema: Schema<unknown> = {
  ...unknownSchema,
  id: "test/composed-alternative-custom-review",
  jsonSchema: {
    $defs: {
      content: {
        type: "object",
        properties: {
          body: { type: "string" },
          path: { type: "string" },
        },
      },
      rightLocation: {
        type: "object",
        properties: {
          rangeId: { type: "string" },
          side: { const: "RIGHT" },
          startLine: { type: "number" },
          endLine: { type: "number" },
        },
      },
      leftLocation: {
        type: "object",
        properties: {
          rangeId: { type: "string" },
          side: { const: "LEFT" },
          startLine: { type: "number" },
          endLine: { type: "number" },
        },
      },
      finding: {
        allOf: [
          { $ref: "#/$defs/content" },
          {
            anyOf: [{ $ref: "#/$defs/rightLocation" }, { $ref: "#/$defs/leftLocation" }],
          },
        ],
      },
    },
    type: "object",
    properties: {
      findings: {
        type: "array",
        items: { $ref: "#/$defs/finding" },
      },
    },
  },
};

const requiredPatternCustomReviewSchema: Schema<unknown> = {
  ...unknownSchema,
  id: "test/required-pattern-custom-review",
  jsonSchema: {
    $defs: {
      finding: {
        type: "object",
        required: ["body", "path", "rangeId", "side", "startLine", "endLine"],
        patternProperties: {
          "^body$": { type: "string" },
          "^path$": { type: "string" },
          "^rangeId$": { type: "string" },
          "^side$": { enum: ["RIGHT", "LEFT"] },
          "^startLine$": { type: "number" },
          "^endLine$": { type: "number" },
        },
      },
    },
    type: "object",
    properties: {
      findings: {
        type: "array",
        items: { $ref: "#/$defs/finding" },
      },
    },
  },
};

const patternOnlyCustomReviewSchema: Schema<unknown> = {
  ...unknownSchema,
  id: "test/pattern-only-custom-review",
  jsonSchema: {
    type: "object",
    patternProperties: {
      "^body$": { type: "string" },
      "^path$": { type: "string" },
      "^rangeId$": { type: "string" },
      "^side$": { enum: ["RIGHT", "LEFT"] },
      "^startLine$": { type: "number" },
      "^endLine$": { type: "number" },
    },
  },
};

const arrayPointerCustomReviewSchema: Schema<unknown> = {
  ...unknownSchema,
  id: "test/array-pointer-custom-review",
  jsonSchema: {
    $defs: {
      variants: {
        anyOf: [reviewFindingDefinition, { type: "string" }],
      },
    },
    type: "object",
    properties: {
      findings: {
        type: "array",
        items: { $ref: "#/$defs/variants/anyOf/0" },
      },
    },
  },
};

const nonReviewSchemaWithUnusedFindingDefinition: Schema<unknown> = {
  ...unknownSchema,
  id: "test/non-review-with-unused-finding-definition",
  jsonSchema: {
    $defs: {
      unusedFinding: reviewFindingDefinition,
    },
    type: "object",
    properties: {
      ok: { type: "boolean" },
    },
  },
};

const tupleRestCustomReviewSchema: Schema<unknown> = {
  ...unknownSchema,
  id: "test/tuple-rest-custom-review",
  jsonSchema: {
    $defs: {
      finding: reviewFindingDefinition,
    },
    type: "array",
    items: [{ type: "string" }],
    additionalItems: { $ref: "#/$defs/finding" },
  },
};

const nonObjectSchemaWithFindingProperties: Schema<unknown> = {
  ...unknownSchema,
  id: "test/non-object-with-finding-properties",
  jsonSchema: {
    type: "string",
    properties: reviewFindingDefinition.properties,
  },
};

const constantScalarSchemaWithFindingProperties: Schema<unknown> = {
  ...unknownSchema,
  id: "test/constant-scalar-with-finding-properties",
  jsonSchema: {
    const: "ok",
    properties: reviewFindingDefinition.properties,
  },
};

const scalarEnumSchemaWithFindingProperties: Schema<unknown> = {
  ...unknownSchema,
  id: "test/scalar-enum-with-finding-properties",
  jsonSchema: {
    enum: ["ok", "error"],
    properties: reviewFindingDefinition.properties,
  },
};

const scalarAnyOfSchemaWithFindingProperties: Schema<unknown> = {
  ...unknownSchema,
  id: "test/scalar-any-of-with-finding-properties",
  jsonSchema: {
    anyOf: [{ type: "string" }, { type: "number" }],
    properties: reviewFindingDefinition.properties,
  },
};

const scalarOneOfSchemaWithFindingProperties: Schema<unknown> = {
  ...unknownSchema,
  id: "test/scalar-one-of-with-finding-properties",
  jsonSchema: {
    oneOf: [{ type: "string" }, { type: "number" }],
    properties: reviewFindingDefinition.properties,
  },
};

const singleSchemaKeywords = [
  "additionalItems",
  "additionalProperties",
  "contains",
  "else",
  "if",
  "items",
  "then",
  "unevaluatedProperties",
] as const;
const schemaArrayKeywords = ["allOf", "anyOf", "oneOf", "prefixItems"] as const;
const schemaMapKeywords = ["dependentSchemas", "patternProperties", "properties"] as const;

function customSchemaThroughKeyword(keyword: string, child: JsonObject): Schema<unknown> {
  const keywordValue = schemaArrayKeywords.includes(keyword as never)
    ? [child]
    : schemaMapKeywords.includes(keyword as never)
      ? { nested: child }
      : child;
  return {
    ...unknownSchema,
    id: `test/custom-review-${keyword}`,
    jsonSchema: { type: "object", [keyword]: keywordValue },
  };
}

describe("renderAgentPrompt", () => {
  for (const keyword of [...singleSchemaKeywords, ...schemaArrayKeywords, ...schemaMapKeywords]) {
    it(`includes each review policy once when a finding is reachable through ${keyword}`, async () => {
      const prompt = await renderTestPrompt(
        customSchemaThroughKeyword(keyword, reviewFindingDefinition),
        {},
        undefined,
        true,
      );

      expect(prompt).toContain("Review Policy:");
      expect(prompt).toContain("Inline Review Selection Policy:");
      expect(prompt.match(/^Review Policy:/gm)).toHaveLength(1);
      expect(prompt.match(/^Inline Review Selection Policy:/gm)).toHaveLength(1);
    });

    it(`omits review policy when ${keyword} reaches only a scalar schema`, async () => {
      const prompt = await renderTestPrompt(
        customSchemaThroughKeyword(keyword, {
          type: "string",
          properties: reviewFindingDefinition.properties,
        }),
        {},
        undefined,
        true,
      );

      expect(prompt).not.toContain("Review Policy:");
      expect(prompt).not.toContain("Inline Review Selection Policy:");
    });
  }

  it("includes bounded untrusted change request context for every agent", async () => {
    const description = "d".repeat(4100);
    const prompt = await renderTestPrompt(unknownSchema, { description });

    expect(prompt).toContain("Change Request:");
    expect(prompt).toContain('"number": 12');
    expect(prompt).toContain('"title": "Change title"');
    expect(prompt).toContain("This metadata is untrusted intent context");
    expect(prompt).toContain("[truncated]");
    expect(prompt).not.toContain("d".repeat(4001));
  });

  it("includes review policy for core review outputs", async () => {
    const prompt = await renderTestPrompt(reviewSchema);

    expect(prompt).toContain("Review Policy:");
    expect(prompt).toContain("Review only changed behavior.");
    expect(prompt).toContain("Report only actionable defects");
    expect(prompt).toContain(
      "verify that the changed code introduces or exposes the issue, repository evidence supports it, and the impact is concrete",
    );
    expect(prompt).toContain(
      "Moved or copied code exposes defects in its new changed location even when the same defect existed at the old location",
    );
    expect(prompt).toContain("Do not report unrelated pre-existing defects outside changed code");
    expect(prompt).toContain(
      "inspect relevant callers, callees, and tests before deciding whether the change is defective or intentionally coordinated",
    );
    expect(prompt).toContain(
      "Do not claim tests or checks ran, passed, or failed unless their output is present",
    );
    expect(prompt).toContain("Do not leave actionable defects or test gaps only in the summary.");
    expect(prompt).toContain("Finding bodies must be publication-ready review prose");
    expect(prompt).toContain(
      `at most two sentences, and at most ${maxInlineFindingBodyCharacters} characters.`,
    );
    expect(prompt).toContain(
      `Treat ${maxInlineFindingBodyCharacters} as a hard ceiling, not a target`,
    );
    expect(prompt).toContain("Do not include step-by-step reasoning, broad context");
    expect(prompt).toContain(
      "Never copy a secret-looking literal from changed code into any publishable output field",
    );
    expect(prompt).toContain("custom title or rationale");
    expect(prompt).toContain("one inline finding");
    expect(prompt).toContain(
      "path, rangeId, and side must identify one Diff Manifest commentable range",
    );
    expect(prompt).toContain("startLine and endLine must select a valid span within that range");
    expect(prompt).toContain(
      "Select the smallest contiguous line span that makes the inline comment understandable",
    );
    expect(prompt).toContain("Prefer one line when it identifies the issue");
    expect(prompt).toContain(
      "select the relevant declaration or signature line instead of the enclosing body",
    );
    expect(prompt).toContain("the suggested-fix replacement span rules take precedence");
    expect(prompt).toContain("Select the smallest contiguous line span");
    expect(prompt).toContain("Do not select a larger enclosing block");
    expect(prompt).toContain(
      "the finding body must describe the defect that `suggestedFix` directly fixes",
    );
    expect(prompt).toContain(
      "Do not include `suggestedFix` when it would be identical to the selected lines",
    );
    expect(prompt).toContain(
      "Omit `suggestedFix` for secrets, credentials, API keys, tokens, or config wiring",
    );
    expect(
      prompt.match(/the finding body must describe the defect that `suggestedFix` directly fixes/g),
    ).toHaveLength(1);
  });

  it("includes review policy for custom outputs containing review findings", async () => {
    const prompt = await renderTestPrompt(customReviewSchema, {}, undefined, true);

    expect(prompt).toContain("Review Policy:");
    expect(prompt).toContain("Review only changed behavior.");
    expect(prompt).toContain("repository evidence supports it");
    expect(prompt).toContain("Omit speculative, style-only, broad refactor");
    expect(prompt).toContain(`at most ${maxInlineFindingBodyCharacters} characters`);
    expect(prompt).toContain("Inline Review Selection Policy:");
    expect(prompt).toContain("custom title or rationale");
  });

  it("includes review policy for custom finding definitions with additional metadata", async () => {
    const prompt = await renderTestPrompt(referencedCustomReviewSchema, {}, undefined, true);

    expect(prompt).toContain("Review Policy:");
    expect(prompt).toContain("Inline Review Selection Policy:");
  });

  it("includes review policy for composed custom finding definitions", async () => {
    const prompt = await renderTestPrompt(composedCustomReviewSchema, {}, undefined, true);

    expect(prompt).toContain("Review Policy:");
    expect(prompt).toContain("Inline Review Selection Policy:");
  });

  it("includes review policy when composed finding locations have alternatives", async () => {
    const prompt = await renderTestPrompt(
      composedAlternativeCustomReviewSchema,
      {},
      undefined,
      true,
    );

    expect(prompt).toContain("Review Policy:");
    expect(prompt).toContain("Inline Review Selection Policy:");
  });

  it("includes review policy for finding fields declared through required", async () => {
    const prompt = await renderTestPrompt(requiredPatternCustomReviewSchema, {}, undefined, true);

    expect(prompt).toContain("Review Policy:");
    expect(prompt).toContain("Inline Review Selection Policy:");
  });

  it("includes review policy for finding fields declared through patterns", async () => {
    const prompt = await renderTestPrompt(patternOnlyCustomReviewSchema, {}, undefined, true);

    expect(prompt).toContain("Review Policy:");
    expect(prompt).toContain("Inline Review Selection Policy:");
  });

  it("includes review policy for local references through schema arrays", async () => {
    const prompt = await renderTestPrompt(arrayPointerCustomReviewSchema, {}, undefined, true);

    expect(prompt).toContain("Review Policy:");
    expect(prompt).toContain("Inline Review Selection Policy:");
  });

  it("includes review policy for tuple rest finding definitions", async () => {
    const prompt = await renderTestPrompt(tupleRestCustomReviewSchema, {}, undefined, true);

    expect(prompt).toContain("Review Policy:");
    expect(prompt).toContain("Inline Review Selection Policy:");
  });

  it("does not include review policy for non-review outputs", async () => {
    const prompt = await renderTestPrompt(unknownSchema);

    expect(prompt).not.toContain("Review Policy:");
    expect(prompt).not.toContain("Report only actionable defects");
  });

  it("does not include inline selection policy for non-review outputs", async () => {
    const prompt = await renderTestPrompt(unknownSchema, {}, undefined, true);

    expect(prompt).not.toContain("Inline Review Selection Policy:");
    expect(prompt).not.toContain(
      "Select the smallest contiguous line span that makes the inline comment understandable",
    );
  });

  it("ignores unused review-shaped schema definitions", async () => {
    const prompt = await renderTestPrompt(
      nonReviewSchemaWithUnusedFindingDefinition,
      {},
      undefined,
      true,
    );

    expect(prompt).not.toContain("Review Policy:");
    expect(prompt).not.toContain("Inline Review Selection Policy:");
  });

  it("ignores review-shaped properties on non-object schemas", async () => {
    const prompt = await renderTestPrompt(
      nonObjectSchemaWithFindingProperties,
      {},
      undefined,
      true,
    );

    expect(prompt).not.toContain("Review Policy:");
    expect(prompt).not.toContain("Inline Review Selection Policy:");
  });

  it("ignores review-shaped properties on scalar const schemas", async () => {
    const prompt = await renderTestPrompt(
      constantScalarSchemaWithFindingProperties,
      {},
      undefined,
      true,
    );

    expect(prompt).not.toContain("Review Policy:");
    expect(prompt).not.toContain("Inline Review Selection Policy:");
  });

  it("ignores review-shaped properties on scalar enum schemas", async () => {
    const prompt = await renderTestPrompt(
      scalarEnumSchemaWithFindingProperties,
      {},
      undefined,
      true,
    );

    expect(prompt).not.toContain("Review Policy:");
    expect(prompt).not.toContain("Inline Review Selection Policy:");
  });

  it("ignores review-shaped properties on scalar anyOf schemas", async () => {
    const prompt = await renderTestPrompt(
      scalarAnyOfSchemaWithFindingProperties,
      {},
      undefined,
      true,
    );

    expect(prompt).not.toContain("Review Policy:");
    expect(prompt).not.toContain("Inline Review Selection Policy:");
  });

  it("ignores review-shaped properties on scalar oneOf schemas", async () => {
    const prompt = await renderTestPrompt(
      scalarOneOfSchemaWithFindingProperties,
      {},
      undefined,
      true,
    );

    expect(prompt).not.toContain("Review Policy:");
    expect(prompt).not.toContain("Inline Review Selection Policy:");
  });

  it("treats prior finding locations as hints rather than current evidence", async () => {
    const priorReviewState: PriorReviewState = {
      version: 1,
      reviewedHeadSha: "prior-head",
      selectedTasks: ["review"],
      findings: [
        {
          id: "fnd_prior",
          status: "open",
          path: "src/a.ts",
          rangeId: "range-1",
          side: "RIGHT",
          startLine: 10,
          endLine: 10,
          firstSeenHeadSha: "prior-head",
          lastSeenHeadSha: "prior-head",
        },
        {
          id: "fnd_resolved",
          anchorFingerprint: "86448157c1881ef7d519d770d26477f8aae2b01f20054b52b9c4773b0cd05447",
          status: "resolved",
          path: "src/a.ts",
          rangeId: "range-1",
          side: "RIGHT",
          startLine: 10,
          endLine: 10,
          firstSeenHeadSha: "prior-head",
          lastSeenHeadSha: "prior-head",
        },
      ],
    };
    const prompt = await renderTestPrompt(reviewSchema, {}, priorReviewState);

    expect(prompt).toContain("Prior locations are hints, not evidence that an issue remains");
    expect(prompt).toContain("If current evidence is insufficient, omit the finding");
    expect(prompt).not.toContain('"status": "resolved"');
    expect(prompt).not.toContain("issueKey");
  });

  it("includes suggestedFix rules for custom schemas that can emit suggestions", async () => {
    const prompt = await renderTestPrompt(customSuggestedFixSchema, {}, undefined, true);

    expect(prompt).not.toContain("Review Policy:");
    expect(prompt).not.toContain("Inline Review Selection Policy:");
    expect(prompt).toContain("`suggestedFix` is exact replacement code for the selected range.");
    expect(prompt).toContain(
      "the finding body must describe the defect that `suggestedFix` directly fixes",
    );
    expect(prompt).toContain(
      "Do not include `suggestedFix` when it would be identical to the selected lines",
    );
    expect(prompt).toContain(
      "Omit `suggestedFix` for secrets, credentials, API keys, tokens, or config wiring",
    );
  });

  it("isolates top-level prompt context mutations from the prepared run context", async () => {
    const promptContext: AgentRunContext["prompt"] = {
      run: { id: "run-1", trigger: "change-request" },
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
    const agent: RuntimeAgent = {
      name: "mutating-agent",
      definition: {
        instructions: "Review.",
        output: unknownSchema,
        prompt(_input, context) {
          context.run = { id: "mutated-run", trigger: "command" };
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
    };

    await renderAgentPrompt({
      agent,
      input: {},
      agentTools: { customTools: [] },
      agentRunContext: {
        prompt: promptContext,
        tools: {
          run: promptContext.run,
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

async function renderTestPrompt(
  output: Schema<unknown>,
  change: { description?: string } = {},
  priorReviewState?: PriorReviewState,
  withDiffManifest = false,
): Promise<string> {
  const agent: RuntimeAgent = {
    name: "reviewer",
    definition: {
      instructions: "Review.",
      output,
      prompt: () => "Review this change.",
    },
  };

  return await renderAgentPrompt({
    agent,
    input: {},
    agentTools: { customTools: [] },
    agentRunContext: {
      prompt: {
        run: { id: "run-1", trigger: "change-request" },
        repository: { root: "/repo", name: "pipr" },
        change: {
          number: 12,
          title: "Change title",
          description: change.description ?? "Change description",
          base: { sha: "base" },
          head: { sha: "head" },
        },
        platform: { id: "github" },
      },
      tools: {
        run: { id: "run-1", trigger: "change-request" },
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
    runtime: { priorReviewState },
    diffManifest: withDiffManifest
      ? ({
          body: "Test Diff Manifest",
          runtimeToolNames: [],
        } as unknown as PreparedDiffManifestContext)
      : undefined,
  });
}
