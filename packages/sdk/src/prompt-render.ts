import type { PromptText, PromptValue } from "./index.js";
import { serializePromptJson } from "./prompt-json.js";

/** Renders a prompt source/value into plain text for Pi prompts. */
export function renderPromptValue(value: PromptValue): string {
  if (value === undefined || value === null) {
    return "";
  }
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number") {
    return serializePromptJson(value, false);
  }
  if (typeof value === "boolean") {
    return String(value);
  }
  if (isPromptText(value)) {
    return value.value;
  }
  return serializePromptJson(value, true);
}

/** Returns whether a value is a `pipr.prompt` or `pipr.markdown` text node. */
export function isPromptText(value: unknown): value is PromptText {
  const kind = typeof value === "object" && value !== null ? Reflect.get(value, "kind") : undefined;
  return kind === "pipr.prompt" || kind === "pipr.markdown";
}
