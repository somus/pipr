import { describe, expect, it } from "bun:test";
import {
  canonicalInlineFindingsMaxItems,
  schemaHasCanonicalInlineFindingsRoot,
} from "../agent/review-schema.js";

describe("canonical inline findings schemas", () => {
  it("resolves item references against definitions on the root schema", () => {
    const schema = {
      type: "object",
      properties: {
        inlineFindings: {
          type: "array",
          maxItems: 20,
          items: { $ref: "#/$defs/Finding" },
        },
      },
      required: ["inlineFindings"],
      additionalProperties: false,
      $defs: {
        Finding: {
          type: "object",
          properties: Object.fromEntries(
            ["body", "path", "rangeId", "side", "startLine", "endLine"].map((name) => [name, {}]),
          ),
          required: ["body", "path", "rangeId", "side", "startLine", "endLine"],
        },
      },
    };

    expect(schemaHasCanonicalInlineFindingsRoot(schema)).toBe(true);
    expect(canonicalInlineFindingsMaxItems(schema)).toBe(20);
  });

  it("resolves a canonical root reference and its item references", () => {
    const schema = {
      $ref: "#/$defs/Output",
      $defs: {
        Output: {
          type: "object",
          properties: {
            inlineFindings: {
              type: "array",
              maxItems: 20,
              items: { $ref: "#/$defs/Finding" },
            },
          },
          required: ["inlineFindings"],
          additionalProperties: false,
        },
        Finding: {
          type: "object",
          properties: Object.fromEntries(
            ["body", "path", "rangeId", "side", "startLine", "endLine"].map((name) => [name, {}]),
          ),
          required: ["body", "path", "rangeId", "side", "startLine", "endLine"],
        },
      },
    };

    expect(schemaHasCanonicalInlineFindingsRoot(schema)).toBe(true);
    expect(canonicalInlineFindingsMaxItems(schema)).toBe(20);
  });

  it("does not shard schemas that allow additional root metadata", () => {
    const schema = {
      type: "object",
      properties: {
        inlineFindings: {
          type: "array",
          items: {
            type: "object",
            properties: Object.fromEntries(
              ["body", "path", "rangeId", "side", "startLine", "endLine"].map((name) => [name, {}]),
            ),
            required: ["body", "path", "rangeId", "side", "startLine", "endLine"],
          },
        },
      },
      required: ["inlineFindings"],
    };

    expect(schemaHasCanonicalInlineFindingsRoot(schema)).toBe(false);
    expect(canonicalInlineFindingsMaxItems(schema)).toBeUndefined();
  });

  it("does not shard closed roots whose patterns or references allow metadata", () => {
    const finding = {
      type: "object",
      properties: Object.fromEntries(
        ["body", "path", "rangeId", "side", "startLine", "endLine"].map((name) => [name, {}]),
      ),
      required: ["body", "path", "rangeId", "side", "startLine", "endLine"],
    };
    const output = {
      type: "object",
      properties: {
        inlineFindings: { type: "array", items: finding },
      },
      required: ["inlineFindings"],
      additionalProperties: false,
      patternProperties: { "^meta": {} },
    };

    expect(schemaHasCanonicalInlineFindingsRoot(output)).toBe(false);
    expect(
      schemaHasCanonicalInlineFindingsRoot({
        $ref: "#/$defs/Output",
        properties: { metadata: {} },
        $defs: {
          Output: { ...output, patternProperties: undefined },
        },
      }),
    ).toBe(false);
  });
});
