import { describe, expect, it } from "bun:test";
import {
  canonicalInlineFindingsMaxItems,
  schemaHasCanonicalInlineFindingsRoot,
} from "../review-schema.js";

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

  const findingFields = ["body", "path", "rangeId", "side", "startLine", "endLine"];
  const finding = {
    type: "object",
    properties: Object.fromEntries(findingFields.map((name) => [name, {}])),
    required: findingFields,
  };
  const closedRoot = (
    extraProperties: Record<string, unknown> = {},
    patch: Record<string, unknown> = {},
  ) => ({
    type: "object",
    properties: {
      inlineFindings: { type: "array", maxItems: 20, items: finding },
      ...extraProperties,
    },
    required: ["inlineFindings"],
    additionalProperties: false,
    ...patch,
  });
  const referencedItems = (definition: unknown) => ({
    ...closedRoot(),
    properties: {
      inlineFindings: { type: "array", maxItems: 20, items: { $ref: "#/$defs/Item" } },
    },
    $defs: { Item: definition },
  });

  it.each<[string, unknown]>([
    ["roots that allow additional metadata", closedRoot({}, { additionalProperties: true })],
    [
      "referenced nested finding wrappers",
      referencedItems({ type: "object", properties: { finding } }),
    ],
    ["referenced nested finding arrays", referencedItems({ type: "array", items: finding })],
    ["non-object roots with finding-shaped properties", { ...closedRoot(), type: "string" }],
    [
      "closed roots with additional declared metadata",
      closedRoot({ metadata: { type: "string" } }),
    ],
    [
      "closed roots whose patterns allow metadata",
      closedRoot({}, { patternProperties: { "^meta": {} } }),
    ],
    [
      "referenced roots with sibling metadata properties",
      { $ref: "#/$defs/Output", properties: { metadata: {} }, $defs: { Output: closedRoot() } },
    ],
  ])("does not shard %s", (_label, schema) => {
    expect(schemaHasCanonicalInlineFindingsRoot(schema)).toBe(false);
    expect(canonicalInlineFindingsMaxItems(schema)).toBeUndefined();
  });

  it("shards the closed canonical root those cases deviate from", () => {
    expect(schemaHasCanonicalInlineFindingsRoot(closedRoot())).toBe(true);
  });
});
