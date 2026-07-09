type SuggestedFixPublicationSelection = {
  side: "RIGHT" | "LEFT";
  kind: "added" | "deleted" | "context" | "mixed";
  rangeStartLine: number;
  startLine: number;
  endLine: number;
  preview?: string;
  suggestedFix: string;
};

const maxSuggestedFixSelectedLines = 12;
const maxSuggestedFixReplacementLines = 20;
const environmentKeyAccessPattern =
  /\b(?:process|Bun|import\.meta)(?:\s*\.|\s*\?\.)\s*env(?:\s*(?:\.|\?\.)\s*([A-Za-z_][A-Za-z0-9_]*)|\s*\?\.\s*\[\s*["']([A-Za-z_][A-Za-z0-9_]*)["']\s*\]|\s*\[\s*["']([A-Za-z_][A-Za-z0-9_]*)["']\s*\])|\bDeno(?:\s*\.|\s*\?\.)\s*env(?:\s*\.|\s*\?\.)\s*get\s*\(\s*["']([A-Za-z_][A-Za-z0-9_]*)["']\s*\)/g;
const environmentDestructurePattern =
  /\{([^{}]*)\}\s*=\s*(?:process|Bun|import\.meta)(?:\s*\.|\s*\?\.)\s*env\b/g;
const environmentKeyNamePattern = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function isPublishableSuggestedFixSelection(
  selection: SuggestedFixPublicationSelection,
): boolean {
  const suggestedLines = normalizedSuggestedFixLines(selection.suggestedFix);
  const selectedLineCount = selection.endLine - selection.startLine + 1;
  if (
    selection.side !== "RIGHT" ||
    selection.kind === "deleted" ||
    selectedLineCount > maxSuggestedFixSelectedLines ||
    suggestedLines.length > maxSuggestedFixReplacementLines
  ) {
    return false;
  }

  const originalLines = selectedPreviewLines(selection, selectedLineCount);
  if (!originalLines) {
    return false;
  }
  const structuralEdgePattern = /^([{}[\]()<>]+)[;,]?$/;
  const firstOriginalEdge = originalLines[0]?.trim().match(structuralEdgePattern)?.[1];
  const firstSuggestedEdge = suggestedLines[0]?.trim().match(structuralEdgePattern)?.[1];
  const lastOriginalEdge = originalLines.at(-1)?.trim().match(structuralEdgePattern)?.[1];
  const lastSuggestedEdge = suggestedLines.at(-1)?.trim().match(structuralEdgePattern)?.[1];
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
  return (
    hasTextChange &&
    !onlyChangesWhitespace(
      originalLinesWithoutTrailingBlanks,
      suggestedLinesWithoutTrailingBlanks,
    ) &&
    !suggestionIntroducesNewEnvironmentAccess(selection.preview, selection.suggestedFix) &&
    (firstOriginalEdge === undefined || firstOriginalEdge === firstSuggestedEdge) &&
    (lastOriginalEdge === undefined || lastOriginalEdge === lastSuggestedEdge) &&
    !hasUnchangedSelectionEdge(originalLines, suggestedLines) &&
    !suggestionIncludesUnselectedContext(selection, selectedLineCount, suggestedLines)
  );
}

function normalizedSuggestedFixLines(value: string): string[] {
  const normalized = value.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const withoutFinalNewline = normalized.endsWith("\n") ? normalized.slice(0, -1) : normalized;
  return withoutFinalNewline.length === 0 ? [] : withoutFinalNewline.split("\n");
}

function selectedPreviewLines(
  selection: SuggestedFixPublicationSelection,
  selectedLineCount: number,
): string[] | undefined {
  if (!selection.preview) {
    return undefined;
  }
  const offset = selection.startLine - selection.rangeStartLine;
  if (offset < 0) {
    return undefined;
  }
  const previewLines = selection.preview.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  if (offset + selectedLineCount > previewLines.length) {
    return undefined;
  }
  return previewLines.slice(offset, offset + selectedLineCount);
}

function suggestionIncludesUnselectedContext(
  selection: SuggestedFixPublicationSelection,
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
  const previewLines = selection.preview.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
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
  const original = originalLines.join("\n");
  const suggested = suggestedLines.join("\n");
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
    if (/\s/.test(char)) {
      const nextNonWhitespace = value.slice(index + 1).match(/\S/)?.[0];
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
  return [
    "++",
    "--",
    "//",
    "/*",
    "**",
    "??",
    "?.",
    "=>",
    "==",
    "!=",
    "<=",
    ">=",
    "&&",
    "||",
    "<<",
    ">>",
  ].includes(previousChar + nextChar);
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
  if (char === "\\") {
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
      state.literalDelimiter = "`";
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
  const keys = new Set<string>();
  for (const match of value.matchAll(environmentKeyAccessPattern)) {
    const key = match[1] ?? match[2] ?? match[3] ?? match[4];
    if (key) {
      keys.add(key);
    }
  }
  for (const match of value.matchAll(environmentDestructurePattern)) {
    addDestructuredEnvironmentKeys(keys, match[1] ?? "");
  }
  return keys;
}

function addDestructuredEnvironmentKeys(keys: Set<string>, bindings: string): void {
  for (const binding of bindings.split(",")) {
    const key = destructuredEnvironmentKey(binding);
    if (key) {
      keys.add(key);
    }
  }
}

function destructuredEnvironmentKey(binding: string): string | undefined {
  const key = binding
    .split(/[:=]/, 1)[0]
    ?.trim()
    .replace(/^["']|["']$/g, "");
  return key && !key.startsWith("...") && environmentKeyNamePattern.test(key) ? key : undefined;
}
