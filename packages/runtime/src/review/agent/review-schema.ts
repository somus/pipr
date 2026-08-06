import { isRecord } from "../../shared/record.js";

const reviewFindingPropertyNames = [
  "body",
  "path",
  "rangeId",
  "side",
  "startLine",
  "endLine",
] as const;

const unresolvedSchemaReference = Symbol("unresolvedSchemaReference");

export function schemaContainsReviewFinding(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return reachableSchemaContainsReviewFinding(value, value, new Set());
}

export function schemaHasCanonicalInlineFindingsRoot(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const canonicalRoot = resolveCanonicalRootSchema(value);
  if (
    canonicalRoot?.type !== "object" ||
    canonicalRoot.additionalProperties !== false ||
    (isRecord(canonicalRoot.patternProperties) &&
      Object.keys(canonicalRoot.patternProperties).length > 0)
  ) {
    return false;
  }

  const properties = isRecord(canonicalRoot.properties) ? canonicalRoot.properties : undefined;
  if (!properties || Object.keys(properties).some((key) => key !== "inlineFindings")) return false;
  const required = Array.isArray(canonicalRoot.required) ? canonicalRoot.required : [];
  if (required.length !== 1 || required[0] !== "inlineFindings") return false;

  const collection = properties.inlineFindings;
  return (
    isRecord(collection) &&
    collection.type === "array" &&
    schemaResolvesToReviewFinding(collection.items, value, new Set())
  );
}

export function canonicalInlineFindingsMaxItems(value: unknown): number | undefined {
  if (!schemaHasCanonicalInlineFindingsRoot(value) || !isRecord(value)) return undefined;
  const canonicalRoot = resolveCanonicalRootSchema(value);
  const properties =
    canonicalRoot && isRecord(canonicalRoot.properties) ? canonicalRoot.properties : undefined;
  const collection = properties?.inlineFindings;
  if (!isRecord(collection)) return undefined;
  return typeof collection.maxItems === "number" &&
    Number.isInteger(collection.maxItems) &&
    collection.maxItems >= 0
    ? collection.maxItems
    : undefined;
}

function reachableSchemaContainsReviewFinding(
  schema: unknown,
  rootSchema: Record<string, unknown>,
  visited: Set<unknown>,
): boolean {
  if (!isRecord(schema) || visited.has(schema)) return false;
  visited.add(schema);

  if (schemaDeclaresReviewFinding(schema)) return true;

  const referenced = resolveLocalSchemaReference(rootSchema, schema.$ref);
  if (
    referenced !== undefined &&
    reachableSchemaContainsReviewFinding(referenced, rootSchema, visited)
  ) {
    return true;
  }
  if (reachableSchemaContainsReviewFinding(schema.items, rootSchema, visited)) return true;

  const properties = isRecord(schema.properties) ? Object.values(schema.properties) : [];
  return properties.some((child) =>
    reachableSchemaContainsReviewFinding(child, rootSchema, visited),
  );
}

function schemaResolvesToReviewFinding(
  schema: unknown,
  rootSchema: Record<string, unknown>,
  visited: Set<unknown>,
): boolean {
  if (!isRecord(schema) || visited.has(schema)) return false;
  if (schemaDeclaresReviewFinding(schema)) return true;
  visited.add(schema);
  const referenced = resolveLocalSchemaReference(rootSchema, schema.$ref);
  return referenced !== undefined && schemaResolvesToReviewFinding(referenced, rootSchema, visited);
}

function schemaDeclaresReviewFinding(schema: Record<string, unknown>): boolean {
  const properties = isRecord(schema.properties) ? schema.properties : undefined;
  return (
    schema.type === "object" &&
    properties !== undefined &&
    reviewFindingPropertyNames.every((propertyName) => propertyName in properties)
  );
}

function resolveCanonicalRootSchema(
  rootSchema: Record<string, unknown>,
): Record<string, unknown> | undefined {
  let current = rootSchema;
  const visited = new Set<unknown>();
  while (typeof current.$ref === "string") {
    if (visited.has(current) || schemaReferenceHasConstraints(current)) return undefined;
    visited.add(current);
    const referenced = resolveLocalSchemaReference(rootSchema, current.$ref);
    if (!isRecord(referenced)) return undefined;
    current = referenced;
  }
  return current;
}

function schemaReferenceHasConstraints(schema: Record<string, unknown>): boolean {
  const annotationKeywords = new Set([
    "$comment",
    "$defs",
    "$id",
    "$ref",
    "$schema",
    "definitions",
    "description",
    "examples",
    "title",
  ]);
  return Object.keys(schema).some((keyword) => !annotationKeywords.has(keyword));
}

function resolveLocalSchemaReference(
  rootSchema: Record<string, unknown>,
  reference: unknown,
): unknown {
  if (reference === "#") return rootSchema;
  if (typeof reference !== "string" || !reference.startsWith("#/")) return undefined;

  let current: unknown = rootSchema;
  for (const encodedSegment of reference.slice(2).split("/")) {
    const segment = decodePointerSegment(encodedSegment);
    if (segment === undefined) return undefined;
    current = resolvePointerSegment(current, segment);
    if (current === unresolvedSchemaReference) return undefined;
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
    if (!/^(0|[1-9]\d*)$/.test(segment)) return unresolvedSchemaReference;
    const index = Number(segment);
    return Number.isSafeInteger(index) && index < current.length
      ? current[index]
      : unresolvedSchemaReference;
  }
  if (!isRecord(current) || !(segment in current)) return unresolvedSchemaReference;
  return current[segment];
}
