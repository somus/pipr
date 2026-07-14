import { lstat, mkdir, mkdtemp, readdir, rename, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import cliPackage from "../package.json" with { type: "json" };
import {
  type BundledSkill,
  type BundledSkillCatalog,
  type BundledSkillFile,
  bundledSkillName,
  containedSkillFilePath,
  readBundledSkillCatalog,
  singleBundledSkill,
} from "./skill-catalog.js";

declare const PIPR_EMBEDDED_SKILLS: string | undefined;

let skillPromise: Promise<BundledSkill> | undefined;

type SkillCatalogAttempt =
  | { catalog: BundledSkillCatalog; skillsRoot: string }
  | { error: string; skillsRoot: string };

export async function resolveBundledSkill(): Promise<BundledSkill> {
  skillPromise ??= loadBundledSkill();
  return await skillPromise;
}

export function formatBundledSkill(skill: BundledSkill): string {
  const files = [...skill.files].sort(compareSkillFiles);
  return [
    `# ${skill.name}`,
    "",
    skill.description,
    "",
    ...files.flatMap((file) => [
      `----- BEGIN SKILL FILE: ${file.path} -----`,
      file.contents.trimEnd(),
      `----- END SKILL FILE: ${file.path} -----`,
      "",
    ]),
  ].join("\n");
}

function compareSkillFiles(left: BundledSkillFile, right: BundledSkillFile): number {
  if (left.path === "SKILL.md") {
    return -1;
  }
  if (right.path === "SKILL.md") {
    return 1;
  }
  return left.path.localeCompare(right.path);
}

export async function materializeBundledSkill(): Promise<string> {
  const skill = await resolveBundledSkill();
  const versionDir = path.join(skillCacheRoot(), cliPackage.version);
  const skillDir = path.join(versionDir, skill.name);
  await mkdir(versionDir, { recursive: true });
  const stagingDir = await mkdtemp(path.join(versionDir, `${bundledSkillName}-`));
  try {
    for (const file of skill.files) {
      await writeSkillFile(stagingDir, file);
    }
    if (await skillDirectoryMatches(skillDir, skill.files)) {
      await rm(stagingDir, { recursive: true, force: true });
      return skillDir;
    }
    await rm(skillDir, { recursive: true, force: true });
    await renameSkillDirectory(stagingDir, skillDir, skill.files);
  } catch (error) {
    await rm(stagingDir, { recursive: true, force: true });
    throw error;
  }
  return skillDir;
}

async function loadBundledSkill(): Promise<BundledSkill> {
  const embedded = embeddedSkillCatalog();
  return singleBundledSkill(embedded ?? (await loadFilesystemSkillCatalog()));
}

async function loadFilesystemSkillCatalog(): Promise<BundledSkillCatalog> {
  const attempts = await Promise.all(skillRootCandidates().map(readSkillCatalogAttempt));
  const loaded = attempts.find(
    (attempt): attempt is Extract<SkillCatalogAttempt, { catalog: BundledSkillCatalog }> =>
      "catalog" in attempt,
  );
  if (loaded) {
    return loaded.catalog;
  }
  throw new Error(
    `Unable to load bundled Pipr skills.\n${attempts
      .map((attempt) => `${attempt.skillsRoot}: ${"error" in attempt ? attempt.error : "loaded"}`)
      .join("\n")}`,
  );
}

async function readSkillCatalogAttempt(skillsRoot: string): Promise<SkillCatalogAttempt> {
  try {
    return { skillsRoot, catalog: await readBundledSkillCatalog(skillsRoot) };
  } catch (error) {
    return { skillsRoot, error: error instanceof Error ? error.message : String(error) };
  }
}

function embeddedSkillCatalog(): BundledSkillCatalog | undefined {
  if (typeof PIPR_EMBEDDED_SKILLS !== "string" || PIPR_EMBEDDED_SKILLS.length === 0) {
    return undefined;
  }
  return JSON.parse(PIPR_EMBEDDED_SKILLS) as BundledSkillCatalog;
}

function skillRootCandidates(): string[] {
  const here = import.meta.dirname;
  return [path.join(here, "skills"), path.resolve(here, "../../../skills")];
}

async function writeSkillFile(skillDir: string, file: BundledSkillFile): Promise<void> {
  const target = containedSkillFilePath(skillDir, file.path);
  await mkdir(path.dirname(target), { recursive: true });
  await Bun.write(target, file.contents);
}

async function renameSkillDirectory(
  stagingDir: string,
  skillDir: string,
  files: BundledSkillFile[],
): Promise<void> {
  try {
    await rename(stagingDir, skillDir);
  } catch (error) {
    if (isExistingDirectoryError(error) && (await skillDirectoryMatches(skillDir, files))) {
      await rm(stagingDir, { recursive: true, force: true });
      return;
    }
    throw error;
  }
}

async function skillDirectoryMatches(
  skillDir: string,
  files: BundledSkillFile[],
): Promise<boolean> {
  try {
    return (
      (await skillDirectoryPathsMatch(skillDir, files)) &&
      (await skillDirectoryContentsMatch(skillDir, files))
    );
  } catch {
    return false;
  }
}

async function skillDirectoryPathsMatch(
  skillDir: string,
  files: BundledSkillFile[],
): Promise<boolean> {
  const actualPaths = await listSkillDirectoryEntries(skillDir);
  const expectedPaths = files.map((file) => file.path).sort();
  return (
    actualPaths.length === expectedPaths.length &&
    actualPaths.every((value, index) => value === expectedPaths[index])
  );
}

async function skillDirectoryContentsMatch(
  skillDir: string,
  files: BundledSkillFile[],
): Promise<boolean> {
  for (const file of files) {
    if (!(await skillFileMatches(skillDir, file))) {
      return false;
    }
  }
  return true;
}

async function skillFileMatches(skillDir: string, file: BundledSkillFile): Promise<boolean> {
  const target = containedSkillFilePath(skillDir, file.path);
  return (await lstat(target)).isFile() && (await Bun.file(target).text()) === file.contents;
}

async function listSkillDirectoryEntries(skillDir: string, prefix = ""): Promise<string[]> {
  const entries = await readdir(path.join(skillDir, prefix), { withFileTypes: true });
  const paths = await Promise.all(
    entries
      .filter((entry) => !entry.name.startsWith("."))
      .map(async (entry) => {
        const relativePath = prefix ? path.join(prefix, entry.name) : entry.name;
        if (entry.isDirectory()) {
          return await listSkillDirectoryEntries(skillDir, relativePath);
        }
        return [relativePath.split(path.sep).join("/")];
      }),
  );
  return paths.flat().sort();
}

const existingDirectoryErrorCodes = new Set(["EEXIST", "ENOTEMPTY"]);

function isExistingDirectoryError(error: unknown): boolean {
  return existingDirectoryErrorCodes.has((error as { code?: string } | undefined)?.code ?? "");
}

function skillCacheRoot(): string {
  const override = process.env.PIPR_SKILL_CACHE_DIR;
  if (override && override.trim().length > 0) {
    return path.resolve(override);
  }
  const cacheHome = process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache");
  return path.join(cacheHome, "pipr", "skills");
}
