import { lstat, mkdir } from "node:fs/promises";
import path from "node:path";
import { isPathContained, resolveContainedConfigDir } from "./paths.js";
import { loadRuntimeProject } from "./project.js";
import {
  officialInitRecipeConfigTs,
  officialInitRecipeFiles,
  officialInitRecipeWorkflowEnvSecrets,
} from "./recipes.js";
import { generatedTypeSupportFiles } from "./type-support.js";

export type InitTypeSupportMode = "include" | "skip" | "only";

export type InitOfficialMinimalProjectOptions = {
  rootDir: string;
  configDir?: string;
  force?: boolean;
  adapters?: readonly string[];
  recipe?: string;
  typeSupport?: InitTypeSupportMode;
};

export type InitOfficialMinimalProjectResult = {
  configDir: string;
  created: string[];
  overwritten: string[];
};

export const supportedOfficialInitAdapters = ["github"] as const;

export type OfficialInitAdapter = (typeof supportedOfficialInitAdapters)[number];

type StarterFile = {
  relativePath: string;
  contents: string;
};

const defaultWorkflowActionRef = "somus/pipr@v0.1.0"; // x-release-please-version

export function listOfficialMinimalFiles(adapters?: readonly string[]): string[] {
  return officialMinimalFilePaths(resolveOfficialInitAdapters(adapters));
}

function resolveOfficialInitAdapters(adapters?: readonly string[]): OfficialInitAdapter[] {
  if (adapters === undefined) {
    return [...supportedOfficialInitAdapters];
  }
  if (adapters.length === 0) {
    return [];
  }
  const selected = new Set<OfficialInitAdapter>();
  for (const adapter of adapters) {
    if (adapter === "") {
      throw unsupportedAdapterError(adapter);
    }
    if (adapter === "none") {
      if (adapters.length > 1) {
        throw new Error("Adapter 'none' cannot be mixed with other init adapters.");
      }
      return [];
    }
    if (adapter !== "github") {
      throw unsupportedAdapterError(adapter);
    }
    selected.add(adapter);
  }
  return [...selected];
}

function officialMinimalFilePaths(adapters: readonly OfficialInitAdapter[]): string[] {
  const files = [
    path.join(".pipr", "config.ts"),
    path.join(".pipr", "tsconfig.json"),
    path.join(".pipr", "types", "pipr-sdk.d.ts"),
  ];
  if (adapters.includes("github")) {
    files.push(path.join(".github", "workflows", "pipr.yml"));
  }
  return files;
}

function unsupportedAdapterError(adapter: string): Error {
  return new Error(
    `Unsupported pipr init adapter '${adapter}'. Supported adapters: ` +
      `${supportedOfficialInitAdapters.join(", ")}; use 'none' to skip adapter files.`,
  );
}

export async function initOfficialMinimalProject(
  options: InitOfficialMinimalProjectOptions,
): Promise<InitOfficialMinimalProjectResult> {
  const { configDir, relativeConfigDir } = resolveContainedConfigDir(options);
  const adapters = resolveOfficialInitAdapters(options.adapters);
  const rootDir = path.resolve(options.rootDir);
  const typeSupport = options.typeSupport ?? "include";
  const files =
    typeSupport === "only"
      ? await generatedTypeSupportFiles(relativeConfigDir)
      : await starterFiles(relativeConfigDir, adapters, options.recipe, typeSupport !== "skip");
  const targets = files.map((file) => ({
    ...file,
    absolutePath: path.join(rootDir, file.relativePath),
  }));
  await assertSafeTargetAncestors(targets, rootDir);
  const existing = await findExistingTargets(targets);
  if (existing.length > 0 && !options.force) {
    if (typeSupport === "only") {
      const result = await writeTargets(targets, existing, { skipExisting: true });
      return { configDir, ...result };
    }
    throw new Error(
      `Project already contains pipr files: ${existing.join(", ")}. ` +
        "Use --force to replace existing .pipr files.",
    );
  }

  const result = await writeTargets(targets, existing, { skipExisting: false });

  if (typeSupport !== "only") {
    await loadRuntimeProject({ rootDir: options.rootDir, configDir });
  }
  return { configDir, ...result };
}

async function starterFiles(
  relativeConfigDir: string,
  adapters: readonly OfficialInitAdapter[],
  recipe?: string,
  includeTypeSupport = true,
): Promise<StarterFile[]> {
  const files: StarterFile[] = [
    {
      relativePath: path.join(relativeConfigDir, "config.ts"),
      contents: officialInitRecipeConfigTs(recipe),
    },
    ...officialInitRecipeFiles(recipe).map((file) => ({
      relativePath: path.join(relativeConfigDir, file.relativePath),
      contents: file.contents,
    })),
  ];
  if (includeTypeSupport) {
    files.push(...(await generatedTypeSupportFiles(relativeConfigDir)));
  }
  if (adapters.includes("github")) {
    files.push({
      relativePath: path.join(".github", "workflows", "pipr.yml"),
      contents: starterWorkflow(relativeConfigDir.split(path.sep).join("/"), recipe),
    });
  }
  return files;
}

async function writeTargets(
  targets: Array<StarterFile & { absolutePath: string }>,
  existing: readonly string[],
  options: { skipExisting: boolean },
): Promise<{ created: string[]; overwritten: string[] }> {
  const created: string[] = [];
  const overwritten: string[] = [];
  for (const target of targets) {
    const existed = existing.includes(target.relativePath);
    if (existed && options.skipExisting) {
      continue;
    }
    await mkdir(path.dirname(target.absolutePath), { recursive: true });
    await Bun.write(target.absolutePath, target.contents);
    if (existed) {
      overwritten.push(target.relativePath);
    } else {
      created.push(target.relativePath);
    }
  }
  return { created, overwritten };
}

async function assertSafeTargetAncestors(
  targets: Array<StarterFile & { absolutePath: string }>,
  projectDir: string,
): Promise<void> {
  for (const target of targets) {
    await assertNoSymlinkAncestors(target.absolutePath, projectDir);
  }
}

async function assertNoSymlinkAncestors(filePath: string, projectDir: string): Promise<void> {
  const root = path.resolve(projectDir);
  let current = path.resolve(path.dirname(filePath));
  const ancestors: string[] = [];

  while (isPathContained(current, root)) {
    ancestors.push(current);
    if (current === root) {
      break;
    }
    current = path.dirname(current);
  }

  for (const ancestor of ancestors.reverse()) {
    const stats = await maybeLstat(ancestor);
    if (!stats) {
      continue;
    }
    if (stats.isSymbolicLink()) {
      throw new Error(`${ancestor}: symbolic links are not supported`);
    }
    if (!stats.isDirectory()) {
      throw new Error(`${ancestor}: expected a directory path`);
    }
  }
}

async function findExistingTargets(
  targets: Array<StarterFile & { absolutePath: string }>,
): Promise<string[]> {
  const existing: string[] = [];
  for (const target of targets) {
    const stats = await maybeLstat(target.absolutePath);
    if (!stats) {
      continue;
    }
    if (stats.isSymbolicLink()) {
      throw new Error(`${target.absolutePath}: symbolic links are not supported`);
    }
    if (!stats.isFile()) {
      throw new Error(`${target.absolutePath}: expected a file path`);
    }
    existing.push(target.relativePath);
  }
  return existing;
}

async function maybeLstat(
  filePath: string,
): Promise<Awaited<ReturnType<typeof lstat>> | undefined> {
  try {
    return await lstat(filePath);
  } catch {
    return undefined;
  }
}

function starterWorkflow(relativeConfigDir: string, recipe?: string): string {
  const lines = [
    "name: pipr",
    "",
    "on:",
    "  pull_request:",
    "  issue_comment:",
    "    types: [created]",
    "  pull_request_review_comment:",
    "    types: [created]",
    "",
    "permissions:",
    "  contents: write",
    "  pull-requests: write",
    "  issues: write",
    "  checks: write",
    "",
    "jobs:",
    "  review:",
    "    runs-on: ubuntu-latest",
    "    steps:",
    "      - uses: actions/checkout@v6",
    "        with:",
    "          fetch-depth: 0",
    `      - uses: ${defaultWorkflowActionRef}`,
    "        env:",
    `          DEEPSEEK_API_KEY: $${["{{ ", "secrets.DEEPSEEK_API_KEY", " }}"].join("")}`,
    `          GITHUB_TOKEN: $${["{{ ", "github.token", " }}"].join("")}`,
  ];
  for (const secret of officialInitRecipeWorkflowEnvSecrets(recipe)) {
    lines.push(`          ${secret.env}: $${["{{ ", `secrets.${secret.secret}`, " }}"].join("")}`);
  }
  if (relativeConfigDir !== ".pipr") {
    lines.push("        with:");
    lines.push(`          config-dir: ${relativeConfigDir}`);
  }
  lines.push("");
  return lines.join("\n");
}
