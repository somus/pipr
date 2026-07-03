import { readdir } from "node:fs/promises";
import path from "node:path";

export const bundledSkillName = "pipr-setup";
const bundledSkillFilePaths = new Set([
  "SKILL.md",
  "references/config-patterns.md",
  "references/recipes.md",
]);

export type BundledSkillFile = {
  path: string;
  contents: string;
};

export type BundledSkill = {
  name: string;
  description: string;
  files: BundledSkillFile[];
};

export type BundledSkillCatalog = {
  skills: BundledSkill[];
};

export function singleBundledSkill(catalog: BundledSkillCatalog): BundledSkill {
  const [skill] = catalog.skills;
  if (catalog.skills.length !== 1 || skill?.name !== bundledSkillName) {
    throw new Error(
      `Expected exactly one bundled skill named '${bundledSkillName}', found: ${catalog.skills
        .map((item) => item.name)
        .join(", ")}`,
    );
  }
  return skill;
}

export function containedSkillFilePath(root: string, relativePath: string): string {
  if (path.isAbsolute(relativePath)) {
    throw new Error(`Bundled skill file path must be relative: ${relativePath}`);
  }
  const resolvedRoot = path.resolve(root);
  const target = path.resolve(resolvedRoot, relativePath);
  if (target !== resolvedRoot && !target.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error(`Bundled skill file path escapes the skill directory: ${relativePath}`);
  }
  return target;
}

export async function readBundledSkillCatalog(skillsRoot: string): Promise<BundledSkillCatalog> {
  const entries = await readdir(skillsRoot, { withFileTypes: true });
  const skills = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map(async (entry) => {
        const skillDir = path.join(skillsRoot, entry.name);
        const files = await readSkillFiles(skillDir);
        validateBundledSkillFiles(entry.name, files);
        const skillMd = files.find((file) => file.path === "SKILL.md");
        if (!skillMd) {
          throw new Error(`${skillDir}: missing SKILL.md`);
        }
        return {
          name: entry.name,
          description: frontmatterDescription(skillMd.contents),
          files,
        };
      }),
  );
  const catalog = { skills: skills.sort((left, right) => left.name.localeCompare(right.name)) };
  singleBundledSkill(catalog);
  return catalog;
}

async function readSkillFiles(skillDir: string, prefix = ""): Promise<BundledSkillFile[]> {
  const entries = await readdir(path.join(skillDir, prefix), { withFileTypes: true });
  const files = await Promise.all(
    entries
      .filter((entry) => !entry.name.startsWith("."))
      .sort((left, right) => left.name.localeCompare(right.name))
      .map(async (entry) => {
        const relativePath = prefix ? path.join(prefix, entry.name) : entry.name;
        if (entry.isDirectory()) {
          return await readSkillFiles(skillDir, relativePath);
        }
        if (!entry.isFile()) {
          return [];
        }
        const contents = await Bun.file(path.join(skillDir, relativePath)).text();
        return [{ path: relativePath.split(path.sep).join("/"), contents }];
      }),
  );
  return files.flat();
}

function frontmatterDescription(contents: string): string {
  const frontmatter = contents.match(/^---\n(?<body>[\s\S]*?)\n---/u)?.groups?.body;
  const description = frontmatter
    ?.split("\n")
    .find((line) => line.startsWith("description:"))
    ?.replace(/^description:\s*/u, "")
    .trim()
    .replace(/^["']|["']$/gu, "");
  if (!description) {
    throw new Error("Bundled skill SKILL.md is missing a description");
  }
  return description;
}

function validateBundledSkillFiles(skillName: string, files: BundledSkillFile[]): void {
  if (skillName !== bundledSkillName) {
    return;
  }
  const found = new Set(files.map((file) => file.path));
  const unexpected = [...found].filter((filePath) => !bundledSkillFilePaths.has(filePath));
  const missing = [...bundledSkillFilePaths].filter((filePath) => !found.has(filePath));
  if (unexpected.length > 0 || missing.length > 0) {
    throw new Error(
      `${bundledSkillName} bundled files must match the release allowlist; ` +
        `unexpected: ${unexpected.join(", ") || "-"}; missing: ${missing.join(", ") || "-"}`,
    );
  }
}
