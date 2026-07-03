#!/usr/bin/env bun
import assert from "node:assert/strict";
import path from "node:path";

type PackageJson = {
  scripts?: Record<string, string>;
};

const runtimeDir = path.resolve(import.meta.dirname, "..", "packages", "runtime");
const runtimePackage = (await Bun.file(
  path.join(runtimeDir, "package.json"),
).json()) as PackageJson;
const splitScripts = ["test:config-init", "test:config-loader", "test:core"];
const discoveredTests = await testFiles("src/**/*.test.ts");
const coveredTests = new Set<string>();

for (const scriptName of splitScripts) {
  const command = runtimePackage.scripts?.[scriptName];
  assert(command, `packages/runtime package.json must define ${scriptName}`);
  for (const target of commandTargets(command)) {
    for (const file of await filesForTarget(target)) {
      coveredTests.add(file);
    }
  }
}

const missing = discoveredTests.filter((file) => !coveredTests.has(file));
const stale = [...coveredTests].filter((file) => !discoveredTests.includes(file)).sort();

assert.deepEqual(stale, [], `runtime test split references missing tests:\n${stale.join("\n")}`);
assert.deepEqual(missing, [], `runtime test split omits tests:\n${missing.join("\n")}`);

console.log(`runtime test split covers ${discoveredTests.length} test files`);

async function testFiles(pattern: string): Promise<string[]> {
  const glob = new Bun.Glob(pattern);
  const files: string[] = [];
  for await (const file of glob.scan({ cwd: runtimeDir, onlyFiles: true })) {
    files.push(normalizePath(file));
  }
  return files.sort();
}

function commandTargets(command: string): string[] {
  const parts = command.split(/\s+/);
  const targets: string[] = [];
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    if (!part || part === "bun" || part === "test") {
      continue;
    }
    if (part === "--timeout") {
      index += 1;
      continue;
    }
    if (part.startsWith("--")) {
      continue;
    }
    if (part.startsWith("src/")) {
      targets.push(part);
    }
  }
  return targets;
}

async function filesForTarget(target: string): Promise<string[]> {
  const normalized = normalizePath(target);
  const absolute = path.join(runtimeDir, normalized);
  const file = Bun.file(absolute);
  if (await file.exists()) {
    return normalized.endsWith(".test.ts") ? [normalized] : [];
  }
  const glob = new Bun.Glob(`${normalized.replace(/\/$/, "")}/**/*.test.ts`);
  const files: string[] = [];
  for await (const item of glob.scan({ cwd: runtimeDir, onlyFiles: true })) {
    files.push(normalizePath(item));
  }
  return files.sort();
}

function normalizePath(value: string): string {
  return value.split(path.sep).join("/");
}
