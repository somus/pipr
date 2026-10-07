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

// Untrusted `<` and `&` travel as these noncharacters until their final context is known, so a value that is
// code in one template can still be escaped when an outer template turns it back into prose.
const untrustedLt = "\uFDD0";
const untrustedAmp = "\uFDD1";
const placeholderMark = "\uFDD2";
const reservedPattern = /[\uFDD0-\uFDD2]/g;

const markdownSources = new WeakMap<MarkdownText, string>();

function markdownText(source: string): MarkdownText {
  const value = source.replaceAll(untrustedLt, "<").replaceAll(untrustedAmp, "&");
  const text: MarkdownText = {
    kind: "pipr.markdown",
    value,
    [markdownTextBrand]: true,
    toString() {
      return value;
    },
  };
  markdownSources.set(text, source);
  return text;
}

/** Returns whether a value was produced by `md`. */
export function isMarkdownText(value: unknown): value is MarkdownText {
  return typeof value === "object" && value !== null && markdownTextBrand in value;
}

/** Converts comment or reply Markdown into a string. */
export function markdownString(value: Markdown): string {
  return typeof value === "string" ? value : value.value;
}

/**
 * Escapes HTML tag and comment openers outside Markdown code so model-authored text cannot inject
 * raw HTML or hidden Pipr markers. Markdown emphasis, lists, and code remain intact. Code detection
 * is conservative: anything Markdown might not render as code is escaped.
 */
export function escapeMarkdown(value: string): string {
  return finalize(untrusted(value)).value;
}

function untrusted(value: string): string {
  return value
    .replace(reservedPattern, "")
    .replaceAll("&", untrustedAmp)
    .replaceAll("<", untrustedLt);
}

function sourceOf(value: unknown): string {
  if (value === undefined || value === null || value === false) {
    return "";
  }
  if (isMarkdownText(value)) {
    return markdownSources.get(value) ?? value.value.replace(reservedPattern, "");
  }
  if (Array.isArray(value)) {
    return value.map(sourceOf).join("");
  }
  return untrusted(String(value));
}

function oneLine(value: unknown): string {
  return sourceOf(value).replace(/\s+/g, " ").trim();
}

function tableCell(value: unknown): string {
  return oneLine(value).replaceAll("|", "\\|");
}

const untrustedPattern = /[﷐﷑]/g;
const tagStartPattern = /[a-zA-Z/!?]/;
const entityPattern = /[#a-zA-Z0-9]+;/y;

/** Escapes untrusted `<` and `&` that are outside code in the assembled document. */
function finalize(source: string): MarkdownText {
  const decoded = source.replaceAll(untrustedLt, "<").replaceAll(untrustedAmp, "&");
  const code = codeMask(source);
  return markdownText(
    source.replace(untrustedPattern, (char, index: number) =>
      code[index] ? char : escapeUntrusted(char, decoded, index + 1),
    ),
  );
}

function escapeUntrusted(char: string, decoded: string, next: number): string {
  if (char === untrustedLt) {
    return tagStartPattern.test(decoded.charAt(next)) ? "&lt;" : char;
  }
  entityPattern.lastIndex = next;
  return entityPattern.test(decoded) ? "&amp;" : char;
}

type SourceLine = { start: number; text: string };
type Fence = { char: string; length: number };
type ScanState = { containerSeen: boolean; htmlEnd?: RegExp; region: SourceLine[] };

const blankLinePattern = /^[ \t\r]*$/;
const containerLinePattern = /^[ \t]*(?:>|[-+*](?:[ \t]|$)|\d{1,9}[.)](?:[ \t]|$))/;
const trustedHtmlPattern = /<[a-zA-Z/!?]/;
const htmlBlocks: ReadonlyArray<readonly [start: RegExp, end: RegExp]> = [
  [/^ {0,3}<(?:script|pre|style|textarea)(?:[\s>]|$)/i, /<\/(?:script|pre|style|textarea)>/i],
  [/^ {0,3}<!--/, /-->/],
  [/^ {0,3}<\?/, /\?>/],
  [/^ {0,3}<!\[CDATA\[/, /\]\]>/],
  [/^ {0,3}<![a-zA-Z]/, />/],
  [/^ {0,3}<[a-zA-Z/]/, blankLinePattern],
];

/**
 * Marks the characters Markdown renders as code. Only top-level fenced blocks closed by a matching
 * fence and single-line code spans count; trusted raw HTML blocks never contain code.
 */
function codeMask(source: string): Uint8Array {
  const mask = new Uint8Array(source.length);
  const lines = sourceLines(source);
  const state: ScanState = { containerSeen: false, region: [] };
  let index = 0;
  while (index < lines.length) {
    index = scanLine(lines, index, state, mask);
  }
  flushRegion(state, mask);
  return mask;
}

function sourceLines(source: string): SourceLine[] {
  let start = 0;
  return source.split("\n").map((text) => {
    const line = { start, text };
    start += text.length + 1;
    return line;
  });
}

/** Classifies one line and returns the index of the next unscanned line. */
function scanLine(
  lines: readonly SourceLine[],
  index: number,
  state: ScanState,
  mask: Uint8Array,
): number {
  const line = lines[index] as SourceLine;
  if (state.htmlEnd) {
    state.htmlEnd = state.htmlEnd.test(line.text) ? undefined : state.htmlEnd;
    return index + 1;
  }
  if (blankLinePattern.test(line.text)) {
    flushRegion(state, mask);
    return index + 1;
  }
  const fenceEnd = scanFencedBlock(lines, index, state, mask);
  if (fenceEnd !== undefined) {
    return fenceEnd;
  }
  if (!scanHtmlBlockStart(line, state, mask)) {
    state.containerSeen ||= containerLinePattern.test(line.text);
    state.region.push(line);
  }
  return index + 1;
}

function scanFencedBlock(
  lines: readonly SourceLine[],
  index: number,
  state: ScanState,
  mask: Uint8Array,
): number | undefined {
  const close = closedFenceEnd(lines, index, state.containerSeen);
  if (close === -1) {
    return undefined;
  }
  flushRegion(state, mask);
  const first = lines[index] as SourceLine;
  const last = lines[close] as SourceLine;
  mask.fill(1, first.start, last.start + last.text.length);
  return close + 1;
}

/** Starts a trusted raw HTML block when the line opens one. */
function scanHtmlBlockStart(line: SourceLine, state: ScanState, mask: Uint8Array): boolean {
  const htmlEnd = htmlBlocks.find(([start]) => start.test(line.text))?.[1];
  if (!htmlEnd) {
    return false;
  }
  flushRegion(state, mask);
  const closedOnStartLine = htmlEnd !== blankLinePattern && htmlEnd.test(line.text);
  state.htmlEnd = closedOnStartLine ? undefined : htmlEnd;
  return true;
}

function flushRegion(state: ScanState, mask: Uint8Array): void {
  for (const [from, to] of regionCodeSpans(state.region) ?? []) {
    mask.fill(1, from, to);
  }
  state.region = [];
}

/** Returns the closing line of a fenced block opened at `index`, or -1 when it is not code. */
function closedFenceEnd(
  lines: readonly SourceLine[],
  index: number,
  containerSeen: boolean,
): number {
  const fence = fenceOpener(lines[index]?.text ?? "", containerSeen);
  if (!fence) {
    return -1;
  }
  return lines.findIndex((line, candidate) => candidate > index && closesFence(line.text, fence));
}

function fenceOpener(text: string, containerSeen: boolean): Fence | undefined {
  const [, indent = "", fence = "", info = ""] = /^( {0,3})(`{3,}|~{3,})(.*)$/.exec(text) ?? [];
  const backtickInfo = fence.startsWith("`") && info.includes("`");
  if (!fence || backtickInfo || (indent.length > 0 && containerSeen)) {
    return undefined;
  }
  return { char: fence.charAt(0), length: fence.length };
}

function closesFence(text: string, fence: Fence): boolean {
  const run = /^ {0,3}(`{3,}|~{3,})[ \t\r]*$/.exec(text)?.[1] ?? "";
  return run.startsWith(fence.char) && run.length >= fence.length;
}

/**
 * Returns code spans only when every backtick run in the paragraph pairs within its own line, so
 * Markdown cannot pair them differently across lines. Escaped openers, pipes inside spans (table
 * cells split on them), and trusted inline HTML make the whole paragraph prose.
 */
function regionCodeSpans(region: readonly SourceLine[]): Array<[number, number]> | undefined {
  const spans: Array<[number, number]> = [];
  for (const line of region) {
    const lineSpans = trustedHtmlPattern.test(line.text) ? undefined : lineCodeSpans(line);
    if (!lineSpans) {
      return undefined;
    }
    spans.push(...lineSpans);
  }
  return spans;
}

function lineCodeSpans(line: SourceLine): Array<[number, number]> | undefined {
  const runs = [...line.text.matchAll(/`+/g)];
  const spans: Array<[number, number]> = [];
  let index = 0;
  while (index < runs.length) {
    const open = runs[index] as RegExpExecArray;
    const closeIndex = runs.findIndex(
      (run, candidate) => candidate > index && run[0].length === open[0].length,
    );
    const close = runs[closeIndex];
    const end = close ? close.index + close[0].length : 0;
    if (
      !close ||
      line.text[open.index - 1] === "\\" ||
      line.text.slice(open.index, end).includes("|")
    ) {
      return undefined;
    }
    spans.push([line.start + open.index, line.start + end]);
    index = closeIndex + 1;
  }
  return spans;
}

const placeholder = (index: number) => `${placeholderMark}${index}${placeholderMark}`;
const placeholderPattern = new RegExp(`${placeholderMark}(\\d+)${placeholderMark}`, "g");

/**
 * Indentation, blank-line, and edge whitespace cleanup applies to the template only: interpolated values stand in as
 * placeholders until it is done, so tabs, indented code, and blank lines inside model-authored text survive. Empty
 * values are dropped first so an omitted optional value does not leave a gap. Escaping runs on the assembled
 * document so code detection sees the template context.
 */
const tag = (strings: TemplateStringsArray, ...values: unknown[]): MarkdownText => {
  const rendered = values.map(sourceOf);
  let template = "";
  for (let index = 0; index < strings.length; index += 1) {
    template += (strings[index] ?? "").replace(reservedPattern, "");
    if (index < rendered.length && rendered[index]) {
      template += placeholder(index);
    }
  }
  const text = stripCommonIndent(template)
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .replace(placeholderPattern, (_match, index: string) => rendered[Number(index)] ?? "");
  return finalize(text);
};

/** Markdown template tag that escapes interpolated values, with structural helpers. */
export const md: MarkdownBuilder = Object.assign(tag, {
  raw(value: string) {
    return markdownText(value.replace(reservedPattern, ""));
  },
  line(value: unknown) {
    return finalize(oneLine(value));
  },
  label(value: string) {
    const words = value.replaceAll(/[-_]/g, " ").trim();
    return finalize(untrusted(words.charAt(0).toUpperCase() + words.slice(1)));
  },
  list(items: readonly unknown[], options?: { ordered?: boolean }) {
    return finalize(
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
    return finalize([header, divider, ...body].join("\n"));
  },
  details(summary: unknown, body: unknown) {
    const content = sourceOf(body).trim();
    if (!content) {
      return markdownText("");
    }
    return finalize(
      ["<details>", `<summary>${oneLine(summary)}</summary>`, "", content, "", "</details>"].join(
        "\n",
      ),
    );
  },
  callout(options: { icon?: string; title: unknown; body?: unknown }) {
    const icon = options.icon ? `${oneLine(options.icon)} ` : "";
    const title = `**${oneLine(options.title)}${options.body === undefined ? "" : ":"}**`;
    const body = options.body === undefined ? "" : ` ${oneLine(options.body)}`;
    return finalize(`> ${icon}${title}${body}`);
  },
  blocks(...blocks: unknown[]) {
    return finalize(
      blocks
        .map((block) => sourceOf(block).trim())
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
