import type { OfficialInitRecipe } from "./types.js";

export const fixSuggestionsRecipe = {
  id: "fix-suggestions",
  title: "Fix Suggestions",
  description: "Command-first exact suggested fixes for actionable review improvements.",
  sourceTools: ["Qodo Merge /improve", "GitHub Copilot code review", "Cursor Bugbot"],
  configTs: `import { definePipr, z } from "@usepipr/sdk";
import type { CommentableRange, DiffManifest, ReviewFinding } from "@usepipr/sdk";

export default definePipr((pipr) => {
  const model = pipr.model({
    provider: "deepseek",
    model: "deepseek-v4-pro",
    apiKey: pipr.secret({ name: "DEEPSEEK_API_KEY" }),
    options: { thinking: "high" },
  });

  pipr.config({ publication: { maxInlineComments: 6 } });

  const fixSuggestionSchema = z.strictObject({
    title: z.string(),
    category: z.enum(["correctness", "tests", "maintainability", "typing", "documentation"]),
    body: z.string(),
    path: z.string(),
    rangeId: z.string(),
    side: z.enum(["RIGHT", "LEFT"]),
    startLine: z.number().int().positive(),
    endLine: z.number().int().positive(),
    suggestedFix: z.string().min(1),
  });

  type FixSuggestion = z.infer<typeof fixSuggestionSchema>;

  const fixSuggestionOutput = pipr.schema({
    id: "review/fix-suggestions",
    schema: z.strictObject({
      summary: z.string(),
      suggestions: z.array(fixSuggestionSchema),
    }),
  });

  const fixer = pipr.agent({
    name: "fix-suggestions",
    model,
    instructions: \`
      Find exact suggested changes for this pull request. Return a suggestion only
      when suggestedFix is a precise replacement for the selected diff range and
      the reviewer can apply it directly. Prioritize correctness, missing tests,
      type safety, and small maintainability improvements. Do not report broad
      refactors, style preferences, or issues without an exact patch. Do not
      return suggestions that are identical to the selected lines, only remove a
      trailing blank line, or only change whitespace. The suggestion body must
      describe the defect that suggestedFix directly fixes. Omit suggestedFix
      for secrets, credentials, API keys, tokens, or config wiring unless the
      replacement uses an existing secret, environment variable, or config key
      already present in the surrounding code.
    \`,
    output: fixSuggestionOutput,
    tools: pipr.tools.readOnly,
    retry: { invalidOutput: 1, transientFailure: 1 },
    timeout: "7m",
    prompt: () => "Find exact suggested changes for this pull request.",
  });

  const task = pipr.task({
    name: "fix-suggestions",
    async run(ctx) {
      if (!ctx.command) {
        throw new Error("fix-suggestions is a command-only task");
      }
      const manifest = await ctx.change.diffManifest({ compressed: true });
      const result = await ctx.pi.run(fixer, { manifest });
      const publishableSuggestions = result.suggestions.filter(
        (suggestion) => isPublishableSuggestion(suggestion, manifest),
      );
      const inlineFindings: ReviewFinding[] = publishableSuggestions.map((suggestion) => {
        const category = suggestion.category
          .replaceAll("-", " ")
          .replace(/^./, (char) => char.toUpperCase());
        return {
          body: \`**\${category}:** \${suggestion.title}. \${suggestion.body}\`,
          path: suggestion.path,
          rangeId: suggestion.rangeId,
          side: suggestion.side,
          startLine: suggestion.startLine,
          endLine: suggestion.endLine,
          suggestedFix: suggestion.suggestedFix,
        };
      });
      await ctx.comment({
        main: [
          result.summary,
          "",
          "## Exact Suggested Changes",
          "",
          suggestionsTable(publishableSuggestions),
        ].join("\\n"),
        inlineFindings,
      });
    },
  });

  pipr.command({
    pattern: "@pipr improve",
    permission: "write",
    description: "Find exact suggested fixes for this pull request.",
    task,
  });
});

type FindingAnchor = Pick<ReviewFinding, "path" | "rangeId" | "side" | "startLine" | "endLine">;

function isPublishableSuggestion(suggestion: FixSuggestion, manifest: DiffManifest): boolean {
  if (suggestion.suggestedFix.trim().length === 0) {
    return false;
  }
  const range = commentableRangeForFinding(suggestion, manifest);
  return Boolean(
    range &&
      isPublishableSuggestedFixSelection({
        side: suggestion.side,
        kind: range.kind,
        rangeStartLine: range.startLine,
        startLine: suggestion.startLine,
        endLine: suggestion.endLine,
        preview: range.preview,
        suggestedFix: suggestion.suggestedFix,
      }),
  );
}

function commentableRangeForFinding(
  finding: FindingAnchor,
  manifest: DiffManifest,
): CommentableRange | undefined {
  for (const file of manifest.files) {
    const range = file.commentableRanges.find((candidate) => candidate.id === finding.rangeId);
    if (!range) {
      continue;
    }
    return finding.rangeId === range.id &&
      finding.path === range.path &&
      finding.side === range.side &&
      finding.startLine <= finding.endLine &&
      finding.startLine >= range.startLine &&
      finding.endLine <= range.endLine
      ? range
      : undefined;
  }
  return undefined;
}

function isPublishableSuggestedFixSelection(selection: {
  side: "RIGHT" | "LEFT";
  kind: "added" | "deleted" | "context" | "mixed";
  rangeStartLine: number;
  startLine: number;
  endLine: number;
  preview?: string;
  suggestedFix: string;
}): boolean {
  const suggestedLines = normalizedSuggestedFixLines(selection.suggestedFix);
  const selectedLineCount = selection.endLine - selection.startLine + 1;
  if (
    selection.side !== "RIGHT" ||
    selection.kind === "deleted" ||
    selectedLineCount > 12 ||
    suggestedLines.length > 20
  ) {
    return false;
  }

  const originalLines = selectedPreviewLines(selection, selectedLineCount);
  if (!originalLines) {
    return false;
  }
  const firstOriginalEdge = structuralEdgeToken(originalLines[0]);
  const firstSuggestedEdge = structuralEdgeToken(suggestedLines[0]);
  const lastOriginalEdge = structuralEdgeToken(originalLines.at(-1));
  const lastSuggestedEdge = structuralEdgeToken(suggestedLines.at(-1));
  const originalLinesWithoutTrailingBlanks = originalLines.slice(
    0,
    lastNonBlankLineIndex(originalLines) + 1,
  );
  const suggestedLinesWithoutTrailingBlanks = suggestedLines.slice(
    0,
    lastNonBlankLineIndex(suggestedLines) + 1,
  );
  const hasTextChange =
    originalLinesWithoutTrailingBlanks.length !== suggestedLinesWithoutTrailingBlanks.length ||
    originalLinesWithoutTrailingBlanks.some(
      (line, index) => line !== suggestedLinesWithoutTrailingBlanks[index],
    );
  return Boolean(
    hasTextChange &&
      !onlyChangesWhitespace(originalLinesWithoutTrailingBlanks, suggestedLinesWithoutTrailingBlanks) &&
      !suggestionIntroducesNewEnvironmentAccess(selection.preview, selection.suggestedFix) &&
      (firstOriginalEdge === undefined || firstOriginalEdge === firstSuggestedEdge) &&
      (lastOriginalEdge === undefined || lastOriginalEdge === lastSuggestedEdge) &&
      !hasUnchangedSelectionEdge(originalLines, suggestedLines) &&
      !suggestionIncludesUnselectedContext(selection, selectedLineCount, suggestedLines),
  );
}

function structuralEdgeToken(line: string | undefined): string | undefined {
  const token = line?.trim().replace(/[;,]$/, "");
  return token && Array.from(token).every((char) => "{}[]()<>".includes(char))
    ? token
    : undefined;
}

function normalizedSuggestedFixLines(value: string): string[] {
  const normalized = value.replace(/\\r\\n/g, "\\n").replace(/\\r/g, "\\n");
  const withoutFinalNewline = normalized.endsWith("\\n") ? normalized.slice(0, -1) : normalized;
  return withoutFinalNewline.length === 0 ? [] : withoutFinalNewline.split("\\n");
}

function selectedPreviewLines(
  selection: {
    rangeStartLine: number;
    startLine: number;
    preview?: string;
  },
  selectedLineCount: number,
): string[] | undefined {
  if (!selection.preview) {
    return undefined;
  }
  const offset = selection.startLine - selection.rangeStartLine;
  if (offset < 0) {
    return undefined;
  }
  const previewLines = selection.preview.replace(/\\r\\n/g, "\\n").replace(/\\r/g, "\\n").split("\\n");
  if (offset + selectedLineCount > previewLines.length) {
    return undefined;
  }
  return previewLines.slice(offset, offset + selectedLineCount);
}

function suggestionIncludesUnselectedContext(
  selection: {
    rangeStartLine: number;
    startLine: number;
    preview?: string;
  },
  selectedLineCount: number,
  suggestedLines: string[],
): boolean {
  if (!selection.preview || suggestedLines.length <= selectedLineCount) {
    return false;
  }
  const offset = selection.startLine - selection.rangeStartLine;
  if (offset < 0) {
    return false;
  }
  const previewLines = selection.preview.replace(/\\r\\n/g, "\\n").replace(/\\r/g, "\\n").split("\\n");
  const contextLines = [
    offset > 0 ? previewLines[offset - 1] : undefined,
    previewLines[offset + selectedLineCount],
  ].filter((line): line is string => Boolean(line?.trim()));
  return contextLines.some((line) => suggestedLines.includes(line));
}

function hasUnchangedSelectionEdge(originalLines: string[], suggestedLines: string[]): boolean {
  const firstLineUnchanged = originalLines[0] === suggestedLines[0];
  const lastLineUnchanged = originalLines.at(-1) === suggestedLines.at(-1);
  if (originalLines.length === suggestedLines.length || originalLines.length === 1) {
    return firstLineUnchanged || lastLineUnchanged;
  }
  return firstLineUnchanged && lastLineUnchanged;
}

function lastNonBlankLineIndex(lines: string[]): number {
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (lines[index]?.trim() !== "") {
      return index;
    }
  }
  return -1;
}

function onlyChangesWhitespace(originalLines: string[], suggestedLines: string[]): boolean {
  const original = originalLines.join("\\n");
  const suggested = suggestedLines.join("\\n");
  if (containsCommentSyntax(original) || containsCommentSyntax(suggested)) {
    return false;
  }
  return stripCodeWhitespace(original) === stripCodeWhitespace(suggested);
}

function containsCommentSyntax(value: string): boolean {
  return value.includes("//") || value.includes("/*");
}

function stripCodeWhitespace(value: string): string {
  let result = "";
  const state: CodeWhitespaceScanState = {
    literalDelimiter: undefined,
    escaped: false,
    regexCharacterClass: false,
    templateExpressionDepths: [],
  };

  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (!char) {
      continue;
    }
    if (advanceCodeLiteralScan(state, char, value[index + 1])) {
      result += char;
      continue;
    }
    if (/\\s/.test(char)) {
      const nextNonWhitespace = value.slice(index + 1).match(/\\S/)?.[0];
      if (requiresCodeTokenSeparator(result.at(-1), nextNonWhitespace)) {
        result += " ";
      }
      continue;
    }
    advanceTemplateExpressionScan(state, char);
    state.literalDelimiter ??= openingCodeLiteralDelimiter(char, value[index + 1], result);
    state.regexCharacterClass = false;
    result += char;
  }

  return result;
}

function requiresCodeTokenSeparator(
  previousChar: string | undefined,
  nextChar: string | undefined,
): boolean {
  if (!previousChar || !nextChar) {
    return false;
  }
  if (/[A-Za-z0-9_$]/.test(previousChar) && /[A-Za-z0-9_$]/.test(nextChar)) {
    return true;
  }
  return ["++", "--", "//", "/*", "**", "??", "?.", "=>", "==", "!=", "<=", ">=", "&&", "||", "<<", ">>"].includes(
    previousChar + nextChar,
  );
}

type CodeWhitespaceScanState = {
  literalDelimiter: string | undefined;
  escaped: boolean;
  regexCharacterClass: boolean;
  templateExpressionDepths: number[];
};

function advanceCodeLiteralScan(
  state: CodeWhitespaceScanState,
  char: string,
  nextChar: string | undefined,
): boolean {
  if (!state.literalDelimiter) {
    return false;
  }
  if (state.escaped) {
    state.escaped = false;
    return true;
  }
  if (char === "\\\\") {
    state.escaped = true;
    return true;
  }
  if (state.literalDelimiter.charCodeAt(0) === 96 && char === "$" && nextChar === "{") {
    state.templateExpressionDepths.push(0);
    state.literalDelimiter = undefined;
    return true;
  }
  if (state.literalDelimiter !== "/") {
    if (char === state.literalDelimiter) {
      state.literalDelimiter = undefined;
    }
    return true;
  }
  advanceRegexLiteralScan(state, char);
  return true;
}

function advanceTemplateExpressionScan(state: CodeWhitespaceScanState, char: string): void {
  const depthIndex = state.templateExpressionDepths.length - 1;
  const depth = state.templateExpressionDepths[depthIndex];
  if (depth === undefined) {
    return;
  }
  if (char === "{") {
    state.templateExpressionDepths[depthIndex] = depth + 1;
  } else if (char === "}") {
    if (depth <= 1) {
      state.templateExpressionDepths.pop();
      state.literalDelimiter = "\`";
    } else {
      state.templateExpressionDepths[depthIndex] = depth - 1;
    }
  }
}

function advanceRegexLiteralScan(state: CodeWhitespaceScanState, char: string): void {
  if (char === "[") {
    state.regexCharacterClass = true;
  } else if (char === "]") {
    state.regexCharacterClass = false;
  } else if (char === "/" && !state.regexCharacterClass) {
    state.literalDelimiter = undefined;
  }
}

function openingCodeLiteralDelimiter(
  char: string,
  nextChar: string | undefined,
  previousCode: string,
): string | undefined {
  if (char === '"' || char === "'" || char.charCodeAt(0) === 96) {
    return char;
  }
  return startsRegexLiteral(char, nextChar, previousCode) ? "/" : undefined;
}

function startsRegexLiteral(
  char: string,
  nextChar: string | undefined,
  previousCode: string,
): boolean {
  const previousChar = previousCode.at(-1);
  const previousWord = previousCode.split(/[^A-Za-z]+/).at(-1);
  const followsRegexKeyword = [
    "return",
    "throw",
    "case",
    "delete",
    "void",
    "typeof",
    "instanceof",
    "in",
    "of",
    "yield",
    "await",
  ].includes(previousWord ?? "");
  return (
    char === "/" &&
    nextChar !== "/" &&
    nextChar !== "*" &&
    (previousChar === undefined ||
      "([{:;,=!?&|+-*%^~<>)".includes(previousChar) ||
      followsRegexKeyword)
  );
}

function suggestionIntroducesNewEnvironmentAccess(
  preview: string | undefined,
  suggestedFix: string,
): boolean {
  const suggestedKeys = environmentAccessKeys(suggestedFix);
  if (suggestedKeys.size === 0) {
    return false;
  }
  const existingKeys = environmentAccessKeys(preview ?? "");
  return Array.from(suggestedKeys).some((key) => !existingKeys.has(key));
}

function environmentAccessKeys(value: string): Set<string> {
  const environmentKeyAccessPattern =
    /\\b(?:process|Bun|import\\.meta)(?:\\s*\\.|\\s*\\?\\.)\\s*env(?:\\s*(?:\\.|\\?\\.)\\s*([A-Za-z_][A-Za-z0-9_]*)|\\s*\\?\\.\\s*\\[\\s*["']([A-Za-z_][A-Za-z0-9_]*)["']\\s*\\]|\\s*\\[\\s*["']([A-Za-z_][A-Za-z0-9_]*)["']\\s*\\])|\\bDeno(?:\\s*\\.|\\s*\\?\\.)\\s*env(?:\\s*\\.|\\s*\\?\\.)\\s*get\\s*\\(\\s*["']([A-Za-z_][A-Za-z0-9_]*)["']\\s*\\)/g;
  const keys = new Set<string>();
  for (const match of value.matchAll(environmentKeyAccessPattern)) {
    const key = match[1] ?? match[2] ?? match[3] ?? match[4];
    if (key) {
      keys.add(key);
    }
  }
  const environmentDestructurePattern =
    /\\{([^{}]*)\\}\\s*=\\s*(?:process|Bun|import\\.meta)(?:\\s*\\.|\\s*\\?\\.)\\s*env\\b/g;
  for (const match of value.matchAll(environmentDestructurePattern)) {
    const bindings = match[1]?.split(",") ?? [];
    for (const binding of bindings) {
      const key = binding.split(/[:=]/, 1)[0]?.trim().replace(/^["']|["']$/g, "");
      if (key && /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) && !key.startsWith("...")) {
        keys.add(key);
      }
    }
  }
  return keys;
}

function suggestionsTable(suggestions: FixSuggestion[]): string {
  if (suggestions.length === 0) {
    return [
      "| Category | Title |",
      "| --- | --- |",
      "| - | No exact suggested fixes found. |",
    ].join("\\n");
  }
  return [
    "| Category | Title |",
    "| --- | --- |",
    ...suggestions.map((suggestion) => {
      const category = suggestion.category
        .replaceAll("-", " ")
        .replace(/^./, (char) => char.toUpperCase());
      const title = suggestion.title.replaceAll("\\n", " ").replaceAll("|", "\\\\|");
      return \`| \${category} | \${title} |\`;
    }),
  ].join("\\n");
}
`,
} as const satisfies OfficialInitRecipe;
