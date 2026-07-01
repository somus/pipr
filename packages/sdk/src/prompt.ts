import type { Markdown } from "./index.js";

/** Creates trimmed Markdown from a template literal with common indentation removed. */
export function md(strings: TemplateStringsArray, ...values: unknown[]): Markdown {
  let text = "";
  for (let index = 0; index < strings.length; index += 1) {
    text += strings[index] ?? "";
    if (index < values.length) {
      text += String(values[index] ?? "");
    }
  }
  return stripCommonIndent(text).trim();
}

/** Removes common leading indentation from multiline text. */
export function stripCommonIndent(value: string): string {
  const lines = value.replaceAll("\t", "  ").split(/\r?\n/);
  const nonEmpty = lines.filter((line) => line.trim().length > 0);
  const indent = Math.min(...nonEmpty.map((line) => line.match(/^ */)?.[0].length ?? 0));
  return lines.map((line) => line.slice(indent)).join("\n");
}
