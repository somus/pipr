import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export function resolvedSdkModulePath(): string | undefined {
  try {
    return fileURLToPath(import.meta.resolve("@usepipr/sdk"));
  } catch {
    return undefined;
  }
}

export function resolvedSdkPackageRoot(): string | undefined {
  return sdkPackageRootFromResolvedModule(resolvedSdkModulePath());
}

export function sdkPackageRootFromResolvedModule(
  modulePath: string | undefined,
): string | undefined {
  if (!modulePath) {
    return undefined;
  }
  const moduleDir = path.dirname(modulePath);
  return path.basename(moduleDir) === "src" || path.basename(moduleDir) === "dist"
    ? path.dirname(moduleDir)
    : moduleDir;
}

export function sdkModuleStubSource(
  modulePath: string | undefined,
  embeddedModule: string | undefined,
): string {
  if (modulePath) {
    return `export * from ${JSON.stringify(pathToFileURL(modulePath).href)};\n`;
  }
  if (embeddedModule) {
    return embeddedModule;
  }
  throw new Error("Unable to locate @usepipr/sdk runtime module");
}
