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
  if (typeof value === "object" && value !== null && Reflect.get(value, "kind") === "pipr.prompt") {
    return (value as PromptText).value;
  }
  return serializePromptJson(value, true);
}
