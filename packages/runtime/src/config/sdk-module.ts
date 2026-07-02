import path from "node:path";
import { fileURLToPath } from "node:url";

export function resolvedSdkModulePath(): string | undefined {
  try {
    return fileURLToPath(import.meta.resolve("@usepipr/sdk"));
  } catch {
    return undefined;
  }
}

export function resolvedSdkPackageRoot(): string | undefined {
  const modulePath = resolvedSdkModulePath();
  if (!modulePath) {
    return undefined;
  }
  const moduleDir = path.dirname(modulePath);
  return path.basename(moduleDir) === "src" || path.basename(moduleDir) === "dist"
    ? path.dirname(moduleDir)
    : moduleDir;
}
