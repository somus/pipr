import { z } from "zod";
import { reviewFindingShape } from "./review-contract.js";

/** Extra fields a review declares on top of the core inline finding fields. */
export type FindingFields = Record<string, z.ZodType>;

/** Zod schema for an inline finding extended with review-declared fields. */
export type FindingSchema<Fields extends FindingFields> = z.ZodObject<
  typeof reviewFindingShape & Fields,
  z.core.$strict
>;

/** Enum-valued finding fields in declaration order; earlier values rank first. */
export type FindingFacets = Readonly<Record<string, readonly string[]>>;

const findingFacets = new WeakMap<object, FindingFacets>();

/** Builds a finding schema; enum fields become facets for ranking and outcome analytics. */
export function createFindingSchema<const Fields extends FindingFields>(
  fields: Fields,
): FindingSchema<Fields> {
  for (const key of Object.keys(fields)) {
    if (key in reviewFindingShape) {
      throw new Error(`pipr.finding field '${key}' is a core finding field`);
    }
  }
  const schema = z.strictObject({ ...reviewFindingShape, ...fields });
  findingFacets.set(schema, collectFacets(fields));
  return schema;
}

/** Returns facets for a schema created by `pipr.finding`. */
export function facetsForFindingSchema(schema: unknown): FindingFacets | undefined {
  return typeof schema === "object" && schema !== null ? findingFacets.get(schema) : undefined;
}

function collectFacets(fields: FindingFields): FindingFacets {
  const facets: Record<string, readonly string[]> = {};
  for (const [key, field] of Object.entries(fields)) {
    const values = enumValues(field);
    if (values) {
      facets[key] = values;
    }
  }
  return facets;
}

function enumValues(field: z.ZodType): readonly string[] | undefined {
  if (field instanceof z.ZodEnum) {
    return field.options.filter((option): option is string => typeof option === "string");
  }
  if (field instanceof z.ZodOptional || field instanceof z.ZodNullable) {
    return enumValues(field.unwrap() as z.ZodType);
  }
  if (field instanceof z.ZodDefault) {
    return enumValues(field.removeDefault() as z.ZodType);
  }
  return undefined;
}
