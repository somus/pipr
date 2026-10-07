import { stripCommonIndent } from "./prompt.js";
import type { Markdown } from "./types/prompt.js";

const markdownTextBrand: unique symbol = Symbol("pipr.markdown");

/** Markdown produced by `md` whose interpolated values are already escaped. */
export type MarkdownText = {
  readonly kind: "pipr.markdown";
  readonly value: string;
  readonly [markdownTextBrand]: true;
  toString(): string;
};

type TableColumn<Row> = keyof Row & string;

/** Markdown template tag and helpers. Interpolated values are escaped unless they come from `md`. */
export type MarkdownBuilder = {
  (strings: TemplateStringsArray, ...values: unknown[]): MarkdownText;
  /** Marks trusted Markdown that must not be escaped. */
  raw(value: string): MarkdownText;
  /** Collapses whitespace to one escaped line. */
  line(value: unknown): MarkdownText;
  /** Formats an identifier such as `test-coverage` as `Test coverage`. */
  label(value: string): MarkdownText;
  /** Renders a bullet or numbered list, omitting empty input. */
  list(items: readonly unknown[], options?: { ordered?: boolean }): MarkdownText;
  /** Renders a table from objects; cells are escaped single lines. */
  table<Row extends Record<string, unknown>>(
    rows: readonly Row[],
    columns: readonly TableColumn<Row>[] | Readonly<Partial<Record<TableColumn<Row>, string>>>,
  ): MarkdownText;
  /** Renders a collapsed `<details>` block. */
  details(summary: unknown, body: unknown): MarkdownText;
  /** Renders a one-line blockquote callout. */
  callout(options: { icon?: string; title: unknown; body?: unknown }): MarkdownText;
  /** Joins blocks with blank lines, omitting empty blocks. */
  blocks(...blocks: unknown[]): MarkdownText;
};

function markdownText(value: string): MarkdownText {
  return {
    kind: "pipr.markdown",
    value,
    [markdownTextBrand]: true,
    toString() {
      return value;
    },
  };
}

/** Returns whether a value was produced by `md`. */
export function isMarkdownText(value: unknown): value is MarkdownText {
  return typeof value === "object" && value !== null && markdownTextBrand in value;
}

/** Converts comment or reply Markdown into a string. */
export function markdownString(value: Markdown): string {
  return typeof value === "string" ? value : value.value;
}

// Only closed fences count as code; an unclosed fence is escaped like prose.
const codeSegmentPattern = /(```[\s\S]*?```|`[^`\n]*`)/g;

/**
 * Escapes HTML tag and comment openers outside Markdown code so model-authored text cannot inject
 * raw HTML or hidden Pipr markers. Markdown emphasis, lists, and code remain intact.
 */
export function escapeMarkdown(value: string): string {
  return value
    .split(codeSegmentPattern)
    .map((segment, index) => (index % 2 === 1 ? segment : escapeHtmlOpeners(segment)))
    .join("");
}

function escapeHtmlOpeners(value: string): string {
  return value.replace(/&(?=[#a-zA-Z0-9]+;)/g, "&amp;").replace(/<(?=[a-zA-Z/!?])/g, "&lt;");
}

function interpolate(value: unknown): string {
  if (value === undefined || value === null || value === false) {
    return "";
  }
  if (isMarkdownText(value)) {
    return value.value;
  }
  if (Array.isArray(value)) {
    return value.map(interpolate).join("");
  }
  return escapeMarkdown(String(value));
}

function oneLine(value: unknown): string {
  return interpolate(value).replace(/\s+/g, " ").trim();
}

function tableCell(value: unknown): string {
  return oneLine(value).replaceAll("|", "\\|");
}

const tag = (strings: TemplateStringsArray, ...values: unknown[]): MarkdownText => {
  let text = "";
  for (let index = 0; index < strings.length; index += 1) {
    text += strings[index] ?? "";
    if (index < values.length) {
      text += interpolate(values[index]);
    }
  }
  return markdownText(
    stripCommonIndent(text)
      .replace(/\n{3,}/g, "\n\n")
      .trim(),
  );
};

/** Markdown template tag that escapes interpolated values, with structural helpers. */
export const md: MarkdownBuilder = Object.assign(tag, {
  raw(value: string) {
    return markdownText(value);
  },
  line(value: unknown) {
    return markdownText(oneLine(value));
  },
  label(value: string) {
    const words = value.replaceAll(/[-_]/g, " ").trim();
    return markdownText(escapeMarkdown(words.charAt(0).toUpperCase() + words.slice(1)));
  },
  list(items: readonly unknown[], options?: { ordered?: boolean }) {
    return markdownText(
      items
        .map((item, index) => `${options?.ordered ? `${index + 1}.` : "-"} ${oneLine(item)}`)
        .join("\n"),
    );
  },
  table<Row extends Record<string, unknown>>(
    rows: readonly Row[],
    columns: readonly TableColumn<Row>[] | Readonly<Partial<Record<TableColumn<Row>, string>>>,
  ) {
    if (rows.length === 0) {
      return markdownText("");
    }
    const entries: Array<[TableColumn<Row>, string]> = Array.isArray(columns)
      ? (columns as readonly TableColumn<Row>[]).map((column) => [column, column])
      : (Object.entries(columns) as Array<[TableColumn<Row>, string]>);
    const header = `| ${entries.map(([column, title]) => tableCell(headerLabel(column, title))).join(" | ")} |`;
    const divider = `| ${entries.map(() => "---").join(" | ")} |`;
    const body = rows.map(
      (row) => `| ${entries.map(([column]) => tableCell(row[column])).join(" | ")} |`,
    );
    return markdownText([header, divider, ...body].join("\n"));
  },
  details(summary: unknown, body: unknown) {
    const content = interpolate(body).trim();
    if (!content) {
      return markdownText("");
    }
    return markdownText(
      ["<details>", `<summary>${oneLine(summary)}</summary>`, "", content, "", "</details>"].join(
        "\n",
      ),
    );
  },
  callout(options: { icon?: string; title: unknown; body?: unknown }) {
    const title = `**${oneLine(options.title)}${options.body === undefined ? "" : ":"}**`;
    const body = options.body === undefined ? "" : ` ${oneLine(options.body)}`;
    return markdownText(`> ${options.icon ? `${options.icon} ` : ""}${title}${body}`);
  },
  blocks(...blocks: unknown[]) {
    return markdownText(
      blocks
        .map((block) => interpolate(block).trim())
        .filter(Boolean)
        .join("\n\n"),
    );
  },
});

function headerLabel(column: string, title: string): string {
  if (title !== column) {
    return title;
  }
  const words = column.replaceAll(/[-_]/g, " ").replaceAll(/([a-z])([A-Z])/g, "$1 $2");
  return words.charAt(0).toUpperCase() + words.slice(1).toLowerCase();
}
