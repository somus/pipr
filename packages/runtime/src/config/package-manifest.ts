export type PackageManifest = {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};

export function normalizePackageManifest(value: unknown): PackageManifest {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return value as PackageManifest;
}
