import type { PromptText, PromptValue } from "./index.js";

const promptJsonSerializationError = "Prompt value must be JSON-serializable";
const unsupportedJsonCollectionTypes = [Map, Set, WeakMap, WeakSet] as const;

/** Renders a prompt source/value into plain text for Pi prompts. */
export function renderPromptValue(value: PromptValue): string {
  if (value === undefined || value === null) {
    return "";
  }
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number") {
    assertJsonPrimitive(value);
    return String(value);
  }
  if (typeof value === "boolean") {
    return String(value);
  }
  if (typeof value === "object" && value !== null && Reflect.get(value, "kind") === "pipr.prompt") {
    return (value as PromptText).value;
  }
  return serializePromptJson(value, true);
}

/** Serializes one prompt JSON value without silently dropping unsupported data. */
export function serializePromptJson(value: unknown, pretty: boolean): string {
  try {
    assertJsonSerializable(value, new Set<object>());
    const rendered = JSON.stringify(value, strictJsonReplacer, pretty ? 2 : 0);
    if (rendered === undefined) {
      throw new Error(promptJsonSerializationError);
    }
    return rendered;
  } catch {
    throw new Error(promptJsonSerializationError);
  }
}

function assertJsonSerializable(value: unknown, ancestors: Set<object>): void {
  assertJsonPrimitive(value);
  if (typeof value !== "object" || value === null) {
    return;
  }
  if (ancestors.has(value)) {
    throw new Error(promptJsonSerializationError);
  }
  assertJsonObjectShape(value);
  ancestors.add(value);
  for (const key of Reflect.ownKeys(value)) {
    if (!Object.prototype.propertyIsEnumerable.call(value, key)) {
      continue;
    }
    if (typeof key === "symbol") {
      throw new Error(promptJsonSerializationError);
    }
    assertJsonSerializable(Reflect.get(value, key), ancestors);
  }
  ancestors.delete(value);
}

function assertJsonObjectShape(value: object): void {
  if (unsupportedJsonCollectionTypes.some((Collection) => value instanceof Collection)) {
    throw new Error(promptJsonSerializationError);
  }
  if (
    Array.isArray(value) &&
    Object.keys(value).some((key) => !isSerializedArrayIndex(value, key))
  ) {
    throw new Error(promptJsonSerializationError);
  }
}

function isSerializedArrayIndex(value: unknown[], key: string): boolean {
  const index = Number(key);
  return Number.isInteger(index) && index >= 0 && String(index) === key && index < value.length;
}

function strictJsonReplacer(_key: string, value: unknown): unknown {
  assertJsonPrimitive(value);
  if (typeof value === "object" && value !== null) {
    assertJsonObjectShape(value);
    if (
      Object.getOwnPropertySymbols(value).some((key) =>
        Object.prototype.propertyIsEnumerable.call(value, key),
      )
    ) {
      throw new Error(promptJsonSerializationError);
    }
  }
  return value;
}

function assertJsonPrimitive(value: unknown): void {
  const type = typeof value;
  if (type === "undefined" || type === "function" || type === "symbol" || type === "bigint") {
    throw new Error(promptJsonSerializationError);
  }
  if (type === "number" && !Number.isFinite(value)) {
    throw new Error(promptJsonSerializationError);
  }
}
