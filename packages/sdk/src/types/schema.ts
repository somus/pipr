import type { z } from "zod";

/** Primitive JSON value supported by JSON Schema based configuration. */
export type JsonPrimitive = string | number | boolean | null;
/** JSON value accepted by pipr schema and prompt helpers. */
export type JsonValue = JsonPrimitive | JsonValue[] | JsonObject;
/** JSON object accepted by pipr schema and prompt helpers. */
export type JsonObject = { [key: string]: JsonValue };
/** JSON Schema document or boolean schema. */
export type JsonSchema = JsonObject | boolean;

/** Result returned by `Schema.safeParse`. */
export type SchemaParseResult<T> = { success: true; data: T } | { success: false; error: Error };

/** Runtime schema wrapper used by pipr agents, tools, and user config. */
export type Schema<T> = {
  readonly kind: "pipr.schema";
  readonly id: string;
  readonly jsonSchema?: JsonSchema;
  parse(value: unknown): T;
  safeParse(value: unknown): SchemaParseResult<T>;
};

/** Zod schema type accepted by `pipr.schema` and built-in schema exports. */
export type ZodSchema<T> = z.ZodType<T>;

/** Zod-backed schema registration. */
export type SchemaDefinition<T> = {
  id: string;
  schema: ZodSchema<T>;
};

/** JSON Schema backed schema registration. */
export type JsonSchemaDefinition = {
  id: string;
  schema: JsonSchema;
};
