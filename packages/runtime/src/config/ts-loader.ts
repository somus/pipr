import { cp, mkdir, mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { RuntimePlan } from "@usepipr/sdk/internal";
import { buildPiprPlan, isPiprConfigFactory } from "@usepipr/sdk/internal";
import { resolveContainedConfigDir } from "./paths.js";
import { embeddedSdkAssets } from "./sdk-assets.js";
import { writeGeneratedTypeSupport } from "./type-support.js";

export type LoadTypescriptConfigOptions = {
  rootDir: string;
  configDir?: string;
  typecheck?: boolean;
};

export type LoadedTypescriptConfig = {
  plan: RuntimePlan;
  source: string;
  tempRoot: string;
};

export async function loadTypescriptConfig(
  options: LoadTypescriptConfigOptions,
): Promise<LoadedTypescriptConfig> {
  const { projectDir, relativeConfigDir, configDir } = resolveContainedConfigDir(options);
  const sourceConfigPath = path.join(projectDir, "config.ts");
  if (!(await fileExists(sourceConfigPath))) {
    throw new Error(`${configDir}/config.ts is required. Run pipr init to create it.`);
  }
  if (options.typecheck) {
    await typecheckTypescriptConfig(path.resolve(options.rootDir), relativeConfigDir);
  }

  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "pipr-config-"));
  try {
    const tempConfigDir = path.join(tempRoot, relativeConfigDir);
    await cp(projectDir, tempConfigDir, {
      recursive: true,
      errorOnExist: false,
      force: true,
      filter: (source) => !isIgnoredConfigCopyPath(source, projectDir),
    });
    await installSdkStub(tempConfigDir);

    const configPath = path.join(tempConfigDir, "config.ts");
    const imported = await import(`${pathToFileURL(configPath).href}?pipr=${Date.now()}`);
    const factory = imported.default as unknown;
    if (!isPiprConfigFactory(factory)) {
      throw new Error(`${sourceConfigPath}: default export must be created by definePipr()`);
    }
    return {
      plan: buildPiprPlan(factory),
      source: sourceConfigPath,
      tempRoot,
    };
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

async function installSdkStub(configDir: string): Promise<void> {
  const sdkRoot = path.join(configDir, "node_modules", "@usepipr", "sdk");
  await mkdir(sdkRoot, { recursive: true });
  await Bun.write(
    path.join(sdkRoot, "package.json"),
    JSON.stringify({
      type: "module",
      exports: {
        ".": "./index.mjs",
      },
    }),
  );
  await Bun.write(path.join(sdkRoot, "index.mjs"), await sdkStubSource());
}

async function typecheckTypescriptConfig(
  rootDir: string,
  relativeConfigDir: string,
): Promise<void> {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "pipr-config-check-"));
  try {
    const tempProjectDir = path.join(tempRoot, "project");
    const tempConfigDir = path.join(tempProjectDir, relativeConfigDir);
    const configTypesPath = path.join(relativeConfigDir, "types");
    await cp(rootDir, tempProjectDir, {
      recursive: true,
      errorOnExist: false,
      force: true,
      filter: (source) => {
        const relative = path.relative(rootDir, source);
        const first = relative.split(path.sep)[0] ?? "";
        return (
          !ignoredTypecheckRootEntries.has(first) &&
          relative !== "bun.lock" &&
          relative !== configTypesPath &&
          !relative.startsWith(`${configTypesPath}${path.sep}`)
        );
      },
    });
    const tsconfigPath = path.join(tempConfigDir, "tsconfig.json");
    await writeGeneratedTypeSupport(tempConfigDir, {
      tsconfig: !(await fileExists(tsconfigPath)),
    });
    await typecheckTypescriptConfigWithApi(tempConfigDir, tsconfigPath);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

async function typecheckTypescriptConfigWithApi(
  configDir: string,
  tsconfigPath: string,
): Promise<void> {
  const ts = await import("typescript");
  const config = ts.readConfigFile(tsconfigPath, ts.sys.readFile);
  if (config.error) {
    throw new Error(formatTypeScriptDiagnostics(ts, [config.error], configDir));
  }
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, configDir);
  const typeRoot = path.join(configDir, "types");
  const bundledTypeRoots: string[] = [];
  try {
    const require = createRequire(import.meta.url);
    bundledTypeRoots.push(path.dirname(path.dirname(require.resolve("@types/bun/package.json"))));
  } catch {
    // Released binaries may not have package-managed Bun types available.
  }
  const configPath = path.join(configDir, "config.ts");
  const fileNames = [
    configPath,
    ...parsed.fileNames.filter((fileName) => {
      const relative = path.relative(typeRoot, fileName);
      return relative.startsWith("..") || path.isAbsolute(relative);
    }),
  ];
  const program = ts.createProgram(fileNames, {
    ...parsed.options,
    typeRoots: [...new Set([typeRoot, ...bundledTypeRoots, ...(parsed.options.typeRoots ?? [])])],
    types: [
      ...new Set([
        ...(parsed.options.types ?? []),
        "pipr-sdk",
        ...(bundledTypeRoots.length ? ["bun"] : []),
      ]),
    ],
  });
  const diagnostics = [...parsed.errors, ...ts.getPreEmitDiagnostics(program)];
  if (diagnostics.length > 0) {
    throw new Error(
      `TypeScript config check failed for ${path.join(configDir, "config.ts")}:\n` +
        formatTypeScriptDiagnostics(ts, diagnostics, configDir),
    );
  }
}

function formatTypeScriptDiagnostics(
  ts: typeof import("typescript"),
  diagnostics: import("typescript").Diagnostic[],
  configDir: string,
): string {
  return ts.formatDiagnostics(diagnostics, {
    getCanonicalFileName: (fileName) => fileName,
    getCurrentDirectory: () => configDir,
    getNewLine: () => "\n",
  });
}

async function sdkStubSource(): Promise<string> {
  const sourcePath = await sdkSourcePath();
  if (sourcePath) {
    return `export * from ${JSON.stringify(pathToFileURL(sourcePath).href)};\n`;
  }
  const embedded = embeddedSdkAssets().module;
  if (embedded) {
    return embedded;
  }
  throw new Error("Unable to locate @usepipr/sdk runtime module");
}

async function sdkSourcePath(): Promise<string | undefined> {
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(moduleDir, "../../../sdk/src/index.ts"),
    path.resolve(moduleDir, "../../sdk/src/index.ts"),
    path.resolve(moduleDir, "../../../sdk/dist/index.mjs"),
    path.resolve(moduleDir, "../../sdk/dist/index.mjs"),
  ];
  for (const candidate of candidates) {
    if (await fileExists(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

function isIgnoredConfigCopyPath(source: string, configDir: string): boolean {
  const relative = path.relative(configDir, source);
  return (
    relative === "node_modules" ||
    relative.startsWith(`node_modules${path.sep}`) ||
    relative === "bun.lock"
  );
}

const ignoredTypecheckRootEntries = new Set([
  ".fallow",
  ".git",
  ".turbo",
  "coverage",
  "dist",
  "node_modules",
]);

async function fileExists(filePath: string): Promise<boolean> {
  return await Bun.file(filePath).exists();
}
