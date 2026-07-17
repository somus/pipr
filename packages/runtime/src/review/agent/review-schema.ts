import { isRecord } from "../../shared/record.js";

const reviewFindingPropertyNames = [
  "body",
  "path",
  "rangeId",
  "side",
  "startLine",
  "endLine",
] as const;

const completeReviewFindingPropertyMask = (1 << reviewFindingPropertyNames.length) - 1;
const unresolvedSchemaReference = Symbol("unresolvedSchemaReference");

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
const alternativeSchemaKeywords = ["anyOf", "oneOf"] as const;

export function schemaContainsReviewFinding(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }
  return reachableSchemaContainsReviewFinding(value, value, new Set());
}

function reachableSchemaContainsReviewFinding(
  schema: unknown,
  rootSchema: Record<string, unknown>,
  visited: Set<unknown>,
): boolean {
  if (Array.isArray(schema)) {
    return schema.some((child) => reachableSchemaContainsReviewFinding(child, rootSchema, visited));
  }
  if (!isRecord(schema) || visited.has(schema)) {
    return false;
  }
  visited.add(schema);

  return (
    schemaObjectPropertyMasks(schema, rootSchema, new Set()).has(
      completeReviewFindingPropertyMask,
    ) ||
    reachableChildSchemas(schema, rootSchema).some((child) =>
      reachableSchemaContainsReviewFinding(child, rootSchema, visited),
    )
  );
}

function reachableChildSchemas(
  schema: Record<string, unknown>,
  rootSchema: Record<string, unknown>,
): unknown[] {
  const referencedSchema = resolveLocalSchemaReference(rootSchema, schema.$ref);
  return [
    ...(referencedSchema === undefined ? [] : [referencedSchema]),
    ...singleSchemaKeywords.map((keyword) => schema[keyword]),
    ...schemaArrayKeywords.flatMap((keyword) =>
      Array.isArray(schema[keyword]) ? schema[keyword] : [],
    ),
    ...schemaMapKeywords.flatMap((keyword) => {
      const children = schema[keyword];
      return isRecord(children) ? Object.values(children) : [];
    }),
  ];
}

function schemaObjectPropertyMasks(
  schema: unknown,
  rootSchema: Record<string, unknown>,
  visited: Set<unknown>,
): Set<number> {
  if (schema === true || visited.has(schema)) {
    return new Set([0]);
  }
  if (!isRecord(schema) || !schemaAllowsObject(schema, rootSchema, new Set())) {
    return new Set();
  }
  visited.add(schema);

  const conjunctiveMasks = conjunctiveSchemas(schema, rootSchema).reduce<Set<number>>(
    (masks, child) =>
      combinePropertyMasks(masks, schemaObjectPropertyMasks(child, rootSchema, new Set(visited))),
    new Set([reviewFindingPropertyMask(schema)]),
  );
  return alternativeSchemaGroups(schema).reduce<Set<number>>(
    (masks, alternatives) =>
      combinePropertyMasks(masks, alternativePropertyMasks(alternatives, rootSchema, visited)),
    conjunctiveMasks,
  );
}

function conjunctiveSchemas(
  schema: Record<string, unknown>,
  rootSchema: Record<string, unknown>,
): unknown[] {
  const referencedSchema = resolveLocalSchemaReference(rootSchema, schema.$ref);
  const allOf = Array.isArray(schema.allOf) ? schema.allOf : [];
  return referencedSchema === undefined ? allOf : [referencedSchema, ...allOf];
}

function alternativeSchemaGroups(schema: Record<string, unknown>): unknown[][] {
  return alternativeSchemaKeywords
    .map((keyword) => schema[keyword])
    .filter((alternatives): alternatives is unknown[] => Array.isArray(alternatives));
}

function alternativePropertyMasks(
  alternatives: unknown[],
  rootSchema: Record<string, unknown>,
  visited: Set<unknown>,
): Set<number> {
  return new Set(
    alternatives.flatMap((child) => [
      ...schemaObjectPropertyMasks(child, rootSchema, new Set(visited)),
    ]),
  );
}

function reviewFindingPropertyMask(schema: Record<string, unknown>): number {
  let mask = 0;
  const properties = isRecord(schema.properties) ? schema.properties : {};
  const required = new Set(
    Array.isArray(schema.required)
      ? schema.required.filter(
          (propertyName): propertyName is string => typeof propertyName === "string",
        )
      : [],
  );
  for (const [index, propertyName] of reviewFindingPropertyNames.entries()) {
    if (propertyName in properties || required.has(propertyName)) {
      mask |= 1 << index;
    }
  }
  return mask;
}

function combinePropertyMasks(left: Set<number>, right: Set<number>): Set<number> {
  const combined = new Set<number>();
  for (const leftMask of left) {
    for (const rightMask of right) {
      combined.add(leftMask | rightMask);
      if (combined.has(completeReviewFindingPropertyMask)) {
        return new Set([completeReviewFindingPropertyMask]);
      }
    }
  }
  return combined;
}

function schemaAllowsObject(
  schema: unknown,
  rootSchema: Record<string, unknown>,
  visited: Set<unknown>,
): boolean {
  if (schema === false) {
    return false;
  }
  if (schema === true || !isRecord(schema) || visited.has(schema)) {
    return true;
  }
  visited.add(schema);

  return (
    directSchemaAllowsObject(schema) &&
    conjunctiveSchemas(schema, rootSchema).every((child) =>
      schemaAllowsObject(child, rootSchema, new Set(visited)),
    ) &&
    alternativeSchemaGroups(schema).every((alternatives) =>
      alternatives.some((child) => schemaAllowsObject(child, rootSchema, new Set(visited))),
    )
  );
}

function directSchemaAllowsObject(schema: Record<string, unknown>): boolean {
  const type = schema.type;
  if (typeof type === "string") {
    return type === "object";
  }
  if (Array.isArray(type) && !type.includes("object")) {
    return false;
  }
  if ("const" in schema && !isRecord(schema.const)) {
    return false;
  }
  return !Array.isArray(schema.enum) || schema.enum.some(isRecord);
}

function resolveLocalSchemaReference(
  rootSchema: Record<string, unknown>,
  reference: unknown,
): unknown {
  if (reference === "#") {
    return rootSchema;
  }
  if (typeof reference !== "string" || !reference.startsWith("#/")) {
    return undefined;
  }

  let current: unknown = rootSchema;
  for (const encodedSegment of reference.slice(2).split("/")) {
    const segment = decodePointerSegment(encodedSegment);
    if (segment === undefined) {
      return undefined;
    }
    current = resolvePointerSegment(current, segment);
    if (current === unresolvedSchemaReference) {
      return undefined;
    }
  }
  return current;
}

function decodePointerSegment(encodedSegment: string): string | undefined {
  try {
    return decodeURIComponent(encodedSegment).replaceAll("~1", "/").replaceAll("~0", "~");
  } catch {
    return undefined;
  }
}

function resolvePointerSegment(current: unknown, segment: string): unknown {
  if (Array.isArray(current)) {
    return resolveArrayPointerSegment(current, segment);
  }
  if (!isRecord(current) || !(segment in current)) {
    return unresolvedSchemaReference;
  }
  return current[segment];
}

function resolveArrayPointerSegment(current: unknown[], segment: string): unknown {
  if (!/^(0|[1-9]\d*)$/.test(segment)) {
    return unresolvedSchemaReference;
  }
  const index = Number(segment);
  if (!Number.isSafeInteger(index) || index >= current.length) {
    return unresolvedSchemaReference;
  }
  return current[index];
}
