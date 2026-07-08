import { cp, mkdir, mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { RuntimePlan } from "@usepipr/sdk/internal";
import { buildPiprPlan, isPiprConfigFactory } from "@usepipr/sdk/internal";
import { installConfigDependencies } from "./config-deps.js";
import { resolveContainedConfigDir } from "./paths.js";
import { installTypedSdkStub } from "./sdk-stub.js";
import { starterTsconfig } from "./starter-tsconfig.js";

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

type TypescriptApi = typeof import("typescript");

type TypescriptForConfig = {
  ts: TypescriptApi;
  packageRoot?: string;
};

type CompilerHostWithDefaultLibLocation = import("typescript").CompilerHost & {
  getDefaultLibLocation?: () => string;
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
    await copyConfigDirectory(projectDir, tempConfigDir);
    await prepareConfigDirectory(tempConfigDir, { frozen: true });

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

export async function prepareConfigDirectory(
  configDir: string,
  options: { frozen?: boolean } = {},
): Promise<void> {
  await installConfigDependencies(configDir, options);
  await installTypedSdkStub(configDir);
}

async function typecheckTypescriptConfig(
  rootDir: string,
  relativeConfigDir: string,
): Promise<void> {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "pipr-config-check-"));
  try {
    const tempProjectDir = path.join(tempRoot, "project");
    const tempConfigDir = path.join(tempProjectDir, relativeConfigDir);
    await cp(rootDir, tempProjectDir, {
      recursive: true,
      errorOnExist: false,
      force: true,
      filter: (source) => {
        const relative = path.relative(rootDir, source);
        const first = relative.split(path.sep)[0] ?? "";
        return !ignoredTypecheckRootEntries.has(first) && relative !== "bun.lock";
      },
    });
    await prepareConfigDirectory(tempConfigDir, { frozen: true });
    const tsconfigPath = path.join(tempConfigDir, "tsconfig.json");
    if (!(await fileExists(tsconfigPath))) {
      await mkdir(tempConfigDir, { recursive: true });
      await Bun.write(tsconfigPath, starterTsconfig);
    }
    await typecheckTypescriptConfigWithApi(tempConfigDir, tsconfigPath);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

async function typecheckTypescriptConfigWithApi(
  configDir: string,
  tsconfigPath: string,
): Promise<void> {
  // `typescript` and `@types/bun` are runtime dependencies: `pipr check`
  // typechecks user `.pipr/config.ts` files outside this package's build.
  const { ts, packageRoot } = await loadTypescriptForConfig(configDir);
  const config = ts.readConfigFile(tsconfigPath, ts.sys.readFile);
  if (config.error) {
    throw new Error(formatTypeScriptDiagnostics(ts, [config.error], configDir));
  }
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, configDir);
  const bundledTypeRoots: string[] = [];
  const hasInstalledBunTypes = await fileExists(
    path.join(configDir, "node_modules", "@types", "bun", "package.json"),
  );
  if (!hasInstalledBunTypes) {
    try {
      const require = createRequire(import.meta.url);
      bundledTypeRoots.push(path.dirname(path.dirname(require.resolve("@types/bun/package.json"))));
    } catch {
      // Released binaries may not have package-managed Bun types available.
    }
  }
  const configPath = path.join(configDir, "config.ts");
  const compilerOptions = {
    ...parsed.options,
    skipLibCheck: true,
    typeRoots: [...new Set([...(parsed.options.typeRoots ?? []), ...bundledTypeRoots])],
    types: [
      ...new Set([...(parsed.options.types ?? []), ...(bundledTypeRoots.length ? ["bun"] : [])]),
    ],
  };
  const compilerHost = await createTypescriptCompilerHost(ts, compilerOptions, packageRoot);
  const program = ts.createProgram(
    [configPath, ...parsed.fileNames],
    compilerOptions,
    compilerHost,
  );
  const diagnostics = [...parsed.errors, ...ts.getPreEmitDiagnostics(program)];
  if (diagnostics.length > 0) {
    throw new Error(
      `TypeScript config check failed for ${path.join(configDir, "config.ts")}:\n` +
        formatTypeScriptDiagnostics(ts, diagnostics, configDir),
    );
  }
}

async function loadTypescriptForConfig(configDir: string): Promise<TypescriptForConfig> {
  const localPackageRoot = path.join(configDir, "node_modules", "typescript");
  const localApiPath = path.join(localPackageRoot, "lib", "typescript.js");
  if (await fileExists(localApiPath)) {
    return {
      ts: typescriptApi(await import(pathToFileURL(localApiPath).href)),
      packageRoot: localPackageRoot,
    };
  }

  const ts = typescriptApi(await import("typescript"));
  return { ts, packageRoot: await runtimeTypescriptPackageRoot() };
}

function typescriptApi(module: unknown): TypescriptApi {
  const maybeModule = module as TypescriptApi & { default?: TypescriptApi };
  return typeof maybeModule.createProgram === "function"
    ? maybeModule
    : (maybeModule.default ?? maybeModule);
}

async function runtimeTypescriptPackageRoot(): Promise<string | undefined> {
  try {
    const require = createRequire(import.meta.url);
    const packageRoot = path.dirname(require.resolve("typescript/package.json"));
    return (await fileExists(path.join(packageRoot, "lib", "typescript.js")))
      ? packageRoot
      : undefined;
  } catch {
    return undefined;
  }
}

async function createTypescriptCompilerHost(
  ts: TypescriptApi,
  compilerOptions: import("typescript").CompilerOptions,
  packageRoot: string | undefined,
): Promise<import("typescript").CompilerHost> {
  const compilerHost = ts.createCompilerHost(compilerOptions, true);
  if (!packageRoot) {
    return compilerHost;
  }

  const libDir = path.join(packageRoot, "lib");
  const defaultLibPath = path.join(libDir, ts.getDefaultLibFileName(compilerOptions));
  if (!(await fileExists(defaultLibPath))) {
    return compilerHost;
  }

  compilerHost.getDefaultLibFileName = () => defaultLibPath;
  (compilerHost as CompilerHostWithDefaultLibLocation).getDefaultLibLocation = () => libDir;
  return compilerHost;
}

function formatTypeScriptDiagnostics(
  ts: TypescriptApi,
  diagnostics: import("typescript").Diagnostic[],
  configDir: string,
): string {
  return ts.formatDiagnostics(diagnostics, {
    getCanonicalFileName: (fileName) => fileName,
    getCurrentDirectory: () => configDir,
    getNewLine: () => "\n",
  });
}

async function copyConfigDirectory(sourceDir: string, targetDir: string): Promise<void> {
  await cp(sourceDir, targetDir, {
    recursive: true,
    errorOnExist: false,
    force: true,
    filter: (source) => !isIgnoredConfigCopyPath(source, sourceDir),
  });
}

function isIgnoredConfigCopyPath(source: string, configDir: string): boolean {
  const relative = path.relative(configDir, source);
  return relative === "node_modules" || relative.startsWith(`node_modules${path.sep}`);
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
