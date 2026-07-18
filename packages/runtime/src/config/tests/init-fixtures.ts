import { expect } from "bun:test";
import { mkdtemp as createTemporaryDirectory, mkdir, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { PiRunner, ReviewRuntimeResult } from "../../review/task/task-runtime.js";
import type { ChangeRequestEventContext } from "../../types.js";
import { loadRuntimeProject } from "../project.js";
import { officialInitRecipeFiles } from "../recipes.js";
import {
  initOfficialMinimalProjectWithLocalDependencies as initOfficialMinimalProject,
  useLocalInitSdk,
} from "./helpers/local-init-sdk.js";

const temporaryDirectories = new Set<string>();
export async function cleanupTemporaryDirectories(): Promise<void> {
  await Promise.all(
    [...temporaryDirectories].map((directory) => rm(directory, { recursive: true, force: true })),
  );
  temporaryDirectories.clear();
}

export { useLocalInitSdk };

export async function mkdtemp(prefix: string): Promise<string> {
  const directory = await createTemporaryDirectory(prefix);
  temporaryDirectories.add(directory);
  return directory;
}

export const configCoreInitFiles = [path.join(".pipr", "config.ts")];

export const packageInitFiles = [
  path.join(".pipr", "package.json"),
  path.join(".pipr", "tsconfig.json"),
  path.join(".pipr", ".gitignore"),
  path.join(".pipr", "bun.lock"),
];

export const defaultInitFiles = [
  ...configCoreInitFiles,
  ...packageInitFiles,
  path.join(".github", "workflows", "pipr.yml"),
];

export async function listFiles(rootDir: string, prefix = ""): Promise<string[]> {
  const files: string[] = [];
  const pending = [prefix];
  while (pending.length > 0) {
    const current = pending.pop() ?? "";
    for (const entry of await readdir(path.join(rootDir, current), { withFileTypes: true })) {
      const relativePath = current ? path.join(current, entry.name) : entry.name;
      if (entry.isDirectory()) {
        if (entry.name === "node_modules") {
          continue;
        }
        pending.push(relativePath);
      } else {
        files.push(relativePath.split(path.sep).join("/"));
      }
    }
  }
  return files.sort();
}

export async function initializedConfigOnlyProject(recipe?: string): Promise<{
  rootDir: string;
  result: Awaited<ReturnType<typeof initOfficialMinimalProject>>;
  project: Awaited<ReturnType<typeof loadRuntimeProject>>;
}> {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "pipr-init-"));
  const result = await initOfficialMinimalProject({ rootDir, adapters: [], recipe });
  const project = await loadRuntimeProject({ rootDir });
  return { rootDir, result, project };
}

export function expectConfigOnlyInitResult(
  result: Awaited<ReturnType<typeof initOfficialMinimalProject>>,
): void {
  expect(result.created).toEqual(expect.arrayContaining(configCoreInitFiles));
  expect(result.created).toEqual(expect.arrayContaining(packageInitFiles));
  expect(result.overwritten).toEqual([]);
}

export async function projectWithCustomConfig(): Promise<string> {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "pipr-init-"));
  await mkdir(path.join(rootDir, ".pipr"), { recursive: true });
  await Bun.write(path.join(rootDir, ".pipr", "config.ts"), "custom: true\n");
  return rootDir;
}

export function recipeConfigFiles(recipe?: string): string[] {
  return officialInitRecipeFiles(recipe).map((file) => path.join(".pipr", file.relativePath));
}

export function eventContext(): ChangeRequestEventContext {
  return {
    eventName: "pull_request",
    action: "opened",
    platform: { id: "github" },
    repository: { slug: "local/pipr" },
    change: {
      number: 1,
      title: "PR title",
      description: "PR body",
      base: { sha: "base" },
      head: { sha: "head" },
    },
    workspace: process.cwd(),
  };
}

export function jsonPiRunner(output: unknown): PiRunner {
  return async () => ({
    exitCode: 0,
    stdout: JSON.stringify(output),
    stderr: "",
    durationMs: 1,
  });
}

export function sequentialJsonPiRunner(outputs: unknown[], onCall?: () => void): PiRunner {
  let index = 0;
  return async () => {
    onCall?.();
    const output = outputs[index];
    index += 1;
    return {
      exitCode: 0,
      stdout: JSON.stringify(output ?? {}),
      stderr: "",
      durationMs: 1,
    };
  };
}

export function assertReviewResult(
  result: ReviewRuntimeResult,
): asserts result is Extract<ReviewRuntimeResult, { kind: "review" }> {
  expect(result.kind).toBe("review");
  if (result.kind !== "review") {
    throw new Error(`expected review runtime result, received ${result.kind}`);
  }
}

export async function fileExists(filePath: string): Promise<boolean> {
  return await Bun.file(filePath).exists();
}

export function githubExpression(expression: string): string {
  return `$${["{{ ", expression, " }}"].join("")}`;
}
