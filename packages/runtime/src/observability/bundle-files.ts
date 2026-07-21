import type { RunBundleManifest } from "@usepipr/sdk";

export function bundleFilePaths(manifest: RunBundleManifest): string[] {
  return [
    "run.json",
    manifest.signals.spans,
    manifest.signals.logs,
    manifest.signals.metrics,
    ...manifest.artifacts.filter((artifact) => !artifact.omitted).map((artifact) => artifact.path),
  ];
}
