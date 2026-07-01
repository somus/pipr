import path from "node:path";
import picomatch from "picomatch";
import type { DiffManifest, DiffManifestFile, PathFilter } from "../types.js";

const matcherOptions = {
  dot: true,
  nonegate: true,
  windows: false,
} as const;

type CompiledFilter = {
  include?: CompiledPattern[];
  exclude?: CompiledPattern[];
};

type CompiledPattern = {
  matches: picomatch.Matcher;
  matchBasename: boolean;
};

const compiledFilters = new WeakMap<PathFilter, CompiledFilter>();

export function diffManifestHasPathMatch(
  manifest: DiffManifest,
  filter: PathFilter | undefined,
): boolean {
  return manifest.files.some((file) => diffFileMatchesPathFilter(file, filter));
}

export function filterDiffManifestByPaths(
  manifest: DiffManifest,
  filter: PathFilter | undefined,
): DiffManifest {
  if (!filter) {
    return manifest;
  }
  return {
    ...manifest,
    files: manifest.files.filter((file) => diffFileMatchesPathFilter(file, filter)),
  };
}

export function diffFileMatchesPathFilter(
  file: Pick<DiffManifestFile, "path" | "previousPath">,
  filter: PathFilter | undefined,
): boolean {
  if (!filter) {
    return true;
  }
  const paths = [
    ...new Set([file.path, file.previousPath].filter((item) => item !== undefined)),
  ].map((item) => item.replaceAll("\\", "/").replace(/^\.\/+/, ""));
  const compiled = readCompiledFilter(filter);
  const include = compiled.include;
  const exclude = compiled.exclude;
  const included = include
    ? paths.some((filePath) =>
        include.some((pattern) =>
          pattern.matches(pattern.matchBasename ? path.posix.basename(filePath) : filePath),
        ),
      )
    : true;
  const excluded = exclude
    ? paths.some((filePath) =>
        exclude.some((pattern) =>
          pattern.matches(pattern.matchBasename ? path.posix.basename(filePath) : filePath),
        ),
      )
    : false;
  return included && !excluded;
}

export function pathMatchesFilter(filePath: string, filter: PathFilter | undefined): boolean {
  if (!filter) {
    return true;
  }
  const normalizedPath = filePath.replaceAll("\\", "/").replace(/^\.\/+/, "");
  const compiled = readCompiledFilter(filter);
  const included = compiled.include
    ? compiled.include.some((pattern) =>
        pattern.matches(
          pattern.matchBasename ? path.posix.basename(normalizedPath) : normalizedPath,
        ),
      )
    : true;
  if (!included) {
    return false;
  }
  return compiled.exclude
    ? !compiled.exclude.some((pattern) =>
        pattern.matches(
          pattern.matchBasename ? path.posix.basename(normalizedPath) : normalizedPath,
        ),
      )
    : true;
}

function readCompiledFilter(filter: PathFilter): CompiledFilter {
  const existing = compiledFilters.get(filter);
  if (existing) {
    return existing;
  }
  const compiled = {
    include: filter.include?.map(compilePattern),
    exclude: filter.exclude?.map(compilePattern),
  };
  compiledFilters.set(filter, compiled);
  return compiled;
}

function compilePattern(pattern: string): CompiledPattern {
  return {
    matches: picomatch(pattern, matcherOptions),
    matchBasename: !pattern.includes("/"),
  };
}
