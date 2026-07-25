import type { CommentableRange, DiffManifest, DiffManifestFile } from "../types.js";
import type { DiffStructuralAnalysis, StructuralDeclaration } from "./structural-analysis.js";

export type EnclosingDeclaration = {
  declaration: StructuralDeclaration;
  ref: "base" | "head";
  sourcePath: string;
};

const maxSymbolsPerFile = 32;
const maxSymbolCharacters = 120;
const maxSummaryCharacters = 200;
const maxDerivedMetadataBytes = 32 * 1024;

export function enrichDiffManifestWithStructure(
  manifest: DiffManifest,
  analysis: DiffStructuralAnalysis,
): DiffManifest {
  if (!analysis.available) {
    return manifest;
  }
  const budget = { remaining: maxDerivedMetadataBytes, exhausted: false };
  return {
    ...manifest,
    files: manifest.files.map((file) => enrichFile(file, analysis, budget)),
  };
}

export function findEnclosingDeclaration(
  file: DiffManifestFile,
  range: CommentableRange,
  analysis: DiffStructuralAnalysis,
): EnclosingDeclaration | undefined {
  if (!analysis.available) {
    return undefined;
  }
  const ref = range.side === "LEFT" ? "base" : "head";
  const sourcePath = ref === "base" ? (file.previousPath ?? file.path) : file.path;
  const structuralFile = (ref === "base" ? analysis.baseFiles : analysis.headFiles).find(
    (candidate) => candidate.path === sourcePath,
  );
  const declaration = structuralFile?.declarations
    .filter(
      (candidate) => candidate.startLine <= range.startLine && candidate.endLine >= range.endLine,
    )
    .sort(compareContainingDeclarations)[0];
  return declaration ? { declaration, ref, sourcePath } : undefined;
}

function enrichFile(
  file: DiffManifestFile,
  analysis: DiffStructuralAnalysis,
  budget: { remaining: number; exhausted: boolean },
): DiffManifestFile {
  const owners = new Map<string, StructuralDeclaration>();
  const commentableRanges = file.commentableRanges.map((range) => {
    const owner = findEnclosingDeclaration(file, range, analysis)?.declaration;
    if (owner) {
      owners.set(owner.qualifiedName, owner);
    }
    if (!owner || range.summary !== undefined || budget.exhausted) {
      return range;
    }
    const summary = truncate(
      `Enclosing declaration: ${owner.kind} ${owner.qualifiedName}`,
      maxSummaryCharacters,
    );
    return consumeDerivedMetadata(budget, summary) ? { ...range, summary } : range;
  });

  const existingSymbols = [...(file.changedSymbols ?? [])];
  const symbolSet = new Set(existingSymbols);
  const derivedSymbols: string[] = [];
  for (const owner of [...owners.values()].sort(compareSourceOrder)) {
    if (budget.exhausted || existingSymbols.length + derivedSymbols.length >= maxSymbolsPerFile) {
      break;
    }
    const symbol = truncate(owner.qualifiedName, maxSymbolCharacters);
    if (symbolSet.has(symbol)) {
      continue;
    }
    if (!consumeDerivedMetadata(budget, symbol)) {
      break;
    }
    symbolSet.add(symbol);
    derivedSymbols.push(symbol);
  }

  return {
    ...file,
    ...(existingSymbols.length > 0 || derivedSymbols.length > 0
      ? { changedSymbols: [...existingSymbols, ...derivedSymbols] }
      : {}),
    commentableRanges,
  };
}

function compareContainingDeclarations(
  left: StructuralDeclaration,
  right: StructuralDeclaration,
): number {
  return (
    left.endLine - left.startLine - (right.endLine - right.startLine) ||
    right.startLine - left.startLine ||
    left.qualifiedName.localeCompare(right.qualifiedName)
  );
}

function compareSourceOrder(left: StructuralDeclaration, right: StructuralDeclaration): number {
  return (
    left.startLine - right.startLine ||
    left.endLine - right.endLine ||
    left.qualifiedName.localeCompare(right.qualifiedName)
  );
}

function consumeDerivedMetadata(
  budget: { remaining: number; exhausted: boolean },
  value: string,
): boolean {
  const bytes = Buffer.byteLength(value, "utf8");
  if (bytes > budget.remaining) {
    budget.exhausted = true;
    return false;
  }
  budget.remaining -= bytes;
  return true;
}

function truncate(value: string, maxCharacters: number): string {
  return value.length <= maxCharacters ? value : value.slice(0, maxCharacters);
}
