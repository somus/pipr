import { z } from "zod";
import type { ReviewFindingsResult, ReviewResult, ReviewSummary } from "./review-contract.js";
import {
  reviewFindingsResultSchema as coreReviewFindingsResultSchema,
  reviewResultSchema as coreReviewResultSchema,
  reviewSummarySchema as coreReviewSummarySchema,
} from "./review-contract.js";
import type { BuiltinSchemaCatalog } from "./types/agent.js";
import type {
  JsonSchema,
  JsonSchemaDefinition,
  Schema,
  SchemaDefinition,
  ZodSchema,
} from "./types/schema.js";

/** Stable identifier for Pipr's built-in change request review output schema. */
export const reviewOutputSchemaId = "core/pr-review";

/** Defines a typed schema from a Zod schema. */
export function schema<T>(definition: SchemaDefinition<T>): Schema<T> {
  if (!definition || typeof definition.id !== "string") {
    throw new Error("pipr.schema requires { id, schema }");
  }
  assertUserSchemaId(definition.id);
  return createZodSchema(definition.id, definition.schema);
}

/** Defines a typed schema from JSON Schema. The generic type is caller supplied. */
export function jsonSchema<T>(definition: JsonSchemaDefinition): Schema<T> {
  if (!definition || typeof definition.id !== "string") {
    throw new Error("pipr.jsonSchema requires { id, schema }");
  }
  assertUserSchemaId(definition.id);
  const zodSchema = z.fromJSONSchema(definition.schema);
  return createSchema(definition.id, (value) => zodSchema.parse(value) as T, definition.schema);
}

/** Built-in schemas available as reusable agent output contracts. */
export const schemas: BuiltinSchemaCatalog = {
  inlineFindings: createZodSchema<ReviewFindingsResult>(
    "core/inline-findings",
    coreReviewFindingsResultSchema,
  ),
  review: createZodSchema<ReviewResult>(reviewOutputSchemaId, coreReviewResultSchema),
  summary: createZodSchema<ReviewSummary>("core/summary", coreReviewSummarySchema),
};

function createSchema<T>(
  id: string,
  parseValue: (value: unknown) => T,
  schemaJson?: JsonSchema,
): Schema<T> {
  return {
    kind: "pipr.schema",
    id,
    jsonSchema: schemaJson,
    parse(value) {
      return parseValue(value);
    },
    safeParse(value) {
      try {
        return { success: true, data: parseValue(value) };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error : new Error(String(error)),
        };
      }
    },
  };
}

/** Returns whether a value is a `pipr.schema` wrapper rather than a raw Zod schema. */
export function isSchema(value: unknown): value is Schema<unknown> {
  return (
    typeof value === "object" && value !== null && Reflect.get(value, "kind") === "pipr.schema"
  );
}

/** Wraps a Zod schema passed directly as agent output. */
export function zodOutputSchema<T>(id: string, zodSchema: ZodSchema<T>): Schema<T> {
  return createZodSchema(id, zodSchema);
}

function createZodSchema<T>(id: string, zodSchema: ZodSchema<T>): Schema<T> {
  return createSchema(id, (value) => zodSchema.parse(value), jsonSchemaFromZod(id, zodSchema));
}

function assertUserSchemaId(id: string): void {
  if (id.startsWith("core/")) {
    throw new Error(`Schema id '${id}' uses the reserved core/ namespace`);
  }
}

function jsonSchemaFromZod<T>(id: string, schemaDefinition: ZodSchema<T>): JsonSchema {
  try {
    return z.toJSONSchema(schemaDefinition) as JsonSchema;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Schema '${id}' could not be converted to JSON Schema. Use JSON-Schema-representable Zod or pipr.jsonSchema<T>(). ${detail}`,
    );
  }
}
