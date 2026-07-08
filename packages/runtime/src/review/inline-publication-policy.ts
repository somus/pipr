export type InlinePublicationLocation = {
  path: string;
  commitId: string;
  side: "RIGHT" | "LEFT";
  startLine: number;
  endLine: number;
};

export type InlinePublicationPolicyState = {
  markers: Set<string>;
  locations: InlinePublicationLocation[];
};

export type SuggestedFixPublicationSelection = {
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

export function inlinePublicationDecision(options: {
  marker: string;
  location: InlinePublicationLocation;
  existing: InlinePublicationPolicyState;
}): "post" | "skip" {
  if (
    options.existing.markers.has(options.marker) ||
    hasExistingInlinePublicationLocation(options.existing.locations, options.location)
  ) {
    return "skip";
  }
  return "post";
}

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
  return Boolean(
    originalLines &&
      !changesStructuralSelectionEdge(originalLines, suggestedLines) &&
      !hasUnchangedSelectionEdge(originalLines, suggestedLines) &&
      !suggestionIncludesUnselectedContext(selection, selectedLineCount, suggestedLines),
  );
}

function hasExistingInlinePublicationLocation(
  existing: InlinePublicationLocation[],
  location: InlinePublicationLocation,
): boolean {
  return existing.some((comment) => {
    if (
      comment.path !== location.path ||
      comment.commitId !== location.commitId ||
      comment.side !== location.side
    ) {
      return false;
    }
    return comment.startLine <= location.endLine && location.startLine <= comment.endLine;
  });
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

function changesStructuralSelectionEdge(
  originalLines: string[],
  suggestedLines: string[],
): boolean {
  const firstOriginalEdge = structuralSelectionEdge(originalLines[0]);
  const lastOriginalEdge = structuralSelectionEdge(originalLines.at(-1));
  return (
    (firstOriginalEdge !== undefined &&
      firstOriginalEdge !== structuralSelectionEdge(suggestedLines[0])) ||
    (lastOriginalEdge !== undefined &&
      lastOriginalEdge !== structuralSelectionEdge(suggestedLines.at(-1)))
  );
}

function structuralSelectionEdge(line: string | undefined): string | undefined {
  return line?.trim().match(/^([})\]]+)[;,]?$/)?.[1];
}
