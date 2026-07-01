import { z } from "zod";
import type {
  BuiltinSchemaCatalog,
  JsonSchema,
  JsonSchemaDefinition,
  Schema,
  SchemaDefinition,
  ZodSchema,
} from "./index.js";
import type { ReviewResult, ReviewSummary } from "./review-contract.js";
import {
  reviewResultSchema as coreReviewResultSchema,
  reviewSummarySchema as coreReviewSummarySchema,
} from "./review-contract.js";

const coreReviewOutputSchemaId = "core/pr-review";

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
  review: createZodSchema<ReviewResult>(coreReviewOutputSchemaId, coreReviewResultSchema),
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
