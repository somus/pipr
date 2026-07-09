export type PackageManifest = {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};

export function normalizePackageManifest(value: unknown): PackageManifest {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  const manifest: PackageManifest = {};
  const rawManifest = value as Record<string, unknown>;
  for (const key of ["dependencies", "devDependencies"] as const) {
    const dependencyMap = rawManifest[key];
    if (
      dependencyMap === null ||
      typeof dependencyMap !== "object" ||
      Array.isArray(dependencyMap)
    ) {
      continue;
    }
    const entries = Object.entries(dependencyMap).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    );
    if (entries.length > 0) {
      manifest[key] = Object.fromEntries(entries);
    }
  }
  return manifest;
}
