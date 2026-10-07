import type { DiffContext, DiffSummary } from "@usepipr/sdk";
import type { DiffManifest } from "../types.js";

const diffContexts = new WeakSet<object>();
const maxSummaryFileCharacters = 40_000;

/** Wraps a Diff Manifest as the branded context agents detect in their input. */
export function createDiffContext(manifest: DiffManifest): DiffContext {
  const context = {
    kind: "pipr.diff",
    manifest,
    summary: () => summarizeDiffManifest(manifest),
  } as unknown as DiffContext;
  diffContexts.add(context);
  return Object.freeze(context);
}

function isDiffContext(value: unknown): value is DiffContext {
  return typeof value === "object" && value !== null && diffContexts.has(value);
}

/** Finds the single `DiffContext` among an agent input's top-level values. */
export function findInputDiffContext(
  input: unknown,
): { key: string; context: DiffContext } | undefined {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return undefined;
  }
  const matches = Object.entries(input).filter(([, value]) => isDiffContext(value));
  if (matches.length > 1) {
    throw new Error(
      `Agent input may contain one ctx.change.diff() value; found ${matches.map(([key]) => key).join(", ")}`,
    );
  }
  const match = matches[0];
  return match ? { key: match[0], context: match[1] as DiffContext } : undefined;
}

/** Returns the input with its `DiffContext` replaced by one wrapping `manifest`. */
export function inputWithDiffManifest(input: unknown, manifest: DiffManifest): unknown {
  const match = findInputDiffContext(input);
  if (!match) {
    return input;
  }
  return { ...(input as Record<string, unknown>), [match.key]: createDiffContext(manifest) };
}

/** Bounded file-level projection of a Diff Manifest. */
function summarizeDiffManifest(manifest: DiffManifest): DiffSummary {
  const files: DiffSummary["files"][number][] = [];
  let serializedCharacters = 0;
  for (const file of manifest.files) {
    const projected = {
      path: file.path.slice(0, 1_000),
      ...(file.previousPath ? { previousPath: file.previousPath.slice(0, 1_000) } : {}),
      status: file.status,
      ...(file.language ? { language: file.language.slice(0, 100) } : {}),
      additions: file.additions,
      deletions: file.deletions,
      ...(file.changedSymbols?.length
        ? { changedSymbols: file.changedSymbols.slice(0, 20).map((symbol) => symbol.slice(0, 200)) }
        : {}),
      ...(file.excludedReason ? { excludedReason: file.excludedReason.slice(0, 500) } : {}),
    };
    const projectedCharacters = JSON.stringify(projected).length;
    if (serializedCharacters + projectedCharacters > maxSummaryFileCharacters) {
      continue;
    }
    files.push(projected);
    serializedCharacters += projectedCharacters;
  }
  return {
    baseSha: manifest.baseSha,
    headSha: manifest.headSha,
    mergeBaseSha: manifest.mergeBaseSha,
    fileCount: manifest.files.length,
    omittedFileCount: manifest.files.length - files.length,
    files,
  };
}
