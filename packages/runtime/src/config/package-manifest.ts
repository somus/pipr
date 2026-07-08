export type PackageManifest = {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};

export function normalizePackageManifest(value: unknown): PackageManifest {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return {
    dependencies: normalizeDependencyMap("dependencies" in value ? value.dependencies : undefined),
    devDependencies: normalizeDependencyMap(
      "devDependencies" in value ? value.devDependencies : undefined,
    ),
  };
}

function normalizeDependencyMap(value: unknown): Record<string, string> | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const entries = Object.entries(value).filter(
    (entry): entry is [string, string] => typeof entry[1] === "string",
  );
  return entries.length === 0 ? undefined : Object.fromEntries(entries);
}
