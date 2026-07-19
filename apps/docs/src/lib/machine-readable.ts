import type { StringifyOptions } from "fumadocs-core/mdx-plugins";

type GeneratedDoc = {
  id: string;
  name: string;
  description?: string;
  entries: GeneratedDocEntry[];
};

type GeneratedDocEntry = {
  name: string;
  description: string;
  type: string;
  simplifiedType: string;
  tags: unknown[];
  required: boolean;
  deprecated: boolean;
};

export const machineReadableStringifyOptions = {
  filterElement(node) {
    if (node.type !== "mdxJsxFlowElement" && node.type !== "mdxJsxTextElement") return true;
    if (node.name === "RecipeFileExplorer" || node.name === "RecipeFilePane") {
      return "children-only";
    }
    if (["File", "TypeTable", "Callout", "Card"].includes(node.name ?? "")) return true;
    return "children-only";
  },
  stringify(node, _parent, state, info) {
    if (node.type !== "mdxJsxFlowElement" && node.type !== "mdxJsxTextElement") {
      return undefined;
    }
    if (node.name === "RecipeFileExplorer" || node.name === "RecipeFilePane") {
      return node.type === "mdxJsxTextElement"
        ? state.containerPhrasing(node, info)
        : state.containerFlow(node, info);
    }
    if (node.name !== "TypeTable") return undefined;

    const payload = readTypeTablePayload(node.attributes);
    const description = payload.description ? `\n${payload.description}\n` : "";
    const rows = payload.entries.map((entry) => {
      const deprecated = entry.deprecated ? "Deprecated. " : "";
      return `| ${inlineCode(entry.name)} | ${inlineCode(entry.type)} | ${entry.required ? "Yes" : "No"} | ${deprecated}${escapeTableCell(entry.description)} |`;
    });
    return [
      `### ${payload.name}`,
      description,
      "| Property | Type | Required | Description |",
      "| --- | --- | --- | --- |",
      ...rows,
      "",
    ].join("\n");
  },
} satisfies StringifyOptions;

function readTypeTablePayload(
  attributes: Array<{
    type: string;
    name?: string | null;
    value?: string | { value?: string } | null;
  }>,
): GeneratedDoc {
  const attribute = attributes.find((candidate) => candidate.name === "type");
  const raw =
    attribute && typeof attribute.value === "object" && attribute.value !== null
      ? attribute.value.value
      : undefined;
  let parsed: unknown;
  try {
    parsed = raw ? JSON.parse(raw) : undefined;
  } catch {
    throw new Error("malformed TypeTable payload: type is not valid JSON");
  }
  if (!isGeneratedDoc(parsed)) {
    throw new Error("malformed TypeTable payload: generated type information is incomplete");
  }
  return parsed;
}

function isGeneratedDoc(value: unknown): value is GeneratedDoc {
  if (!isRecord(value)) return false;
  if (
    typeof value.id !== "string" ||
    typeof value.name !== "string" ||
    (value.description !== undefined && typeof value.description !== "string") ||
    !Array.isArray(value.entries)
  ) {
    return false;
  }
  return value.entries.every(isGeneratedDocEntry);
}

function isGeneratedDocEntry(value: unknown): value is GeneratedDocEntry {
  return (
    isRecord(value) &&
    typeof value.name === "string" &&
    typeof value.description === "string" &&
    typeof value.type === "string" &&
    typeof value.simplifiedType === "string" &&
    Array.isArray(value.tags) &&
    typeof value.required === "boolean" &&
    typeof value.deprecated === "boolean"
  );
}

function inlineCode(value: string): string {
  const escaped = escapeTableCell(value);
  const longestRun = Math.max(0, ...[...escaped.matchAll(/`+/g)].map((match) => match[0].length));
  const fence = "`".repeat(longestRun + 1);
  return `${fence}${escaped}${fence}`;
}

function escapeTableCell(value: string): string {
  return value.replaceAll("|", "\\|").replace(/\r?\n/g, "<br>").trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
