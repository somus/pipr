#!/usr/bin/env bun
import { mkdir, mkdtemp, rename, rm } from "node:fs/promises";
import path from "node:path";
import { containedSkillFilePath, readBundledSkillCatalog } from "../skill-catalog.js";

const sourceRoot = path.resolve(import.meta.dirname, "../../../..");
const source = path.join(sourceRoot, "skills");
const target = path.join(sourceRoot, "packages", "cli", "dist", "skills");

const catalog = await readBundledSkillCatalog(source);
const targetParent = path.dirname(target);
await mkdir(targetParent, { recursive: true });
const stagingDir = await mkdtemp(path.join(targetParent, "skills-"));
try {
  for (const skill of catalog.skills) {
    const skillDir = containedSkillFilePath(stagingDir, skill.name);
    for (const file of skill.files) {
      const targetFile = containedSkillFilePath(skillDir, file.path);
      await mkdir(path.dirname(targetFile), { recursive: true });
      await Bun.write(targetFile, file.contents);
    }
  }
  await rm(target, { recursive: true, force: true });
  await rename(stagingDir, target);
} catch (error) {
  await rm(stagingDir, { recursive: true, force: true });
  throw error;
}
