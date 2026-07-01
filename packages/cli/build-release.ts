#!/usr/bin/env bun
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  embeddedSdkDeclaration,
  readSdkDeclarationModules,
} from "./src/release/sdk-declaration.js";

type ReleaseTarget = {
  target: string;
  outfile: string;
};

const sourceRoot = path.resolve(import.meta.dirname, "../..");
const releaseDir = path.join(sourceRoot, "dist", "release");
const cliEntrypoint = path.join(sourceRoot, "packages", "cli", "src", "main.ts");
const targets: ReleaseTarget[] = [
  { target: "bun-linux-x64-baseline", outfile: "pipr-linux-x64" },
  { target: "bun-linux-arm64", outfile: "pipr-linux-arm64" },
  { target: "bun-darwin-x64", outfile: "pipr-darwin-x64" },
  { target: "bun-darwin-arm64", outfile: "pipr-darwin-arm64" },
];
const hostTargets = new Map<string, ReleaseTarget>([
  ["linux/x64", targets[0] as ReleaseTarget],
  ["linux/arm64", targets[1] as ReleaseTarget],
  ["darwin/x64", targets[2] as ReleaseTarget],
  ["darwin/arm64", targets[3] as ReleaseTarget],
]);

const sdkRuntimeExports = [
  "definePipr",
  "definePlugin",
  "jsonSchema",
  "md",
  "parseReviewFinding",
  "parseReviewResult",
  "parseReviewSummary",
  "reviewFindingSchema",
  "reviewResultSchema",
  "reviewSchemaExample",
  "reviewSummarySchema",
  "schema",
  "schemas",
  "z",
];

await run("bun", ["run", "--cwd", "packages/sdk", "build"]);
await run("bun", ["run", "--cwd", "packages/runtime", "build"]);
await mkdir(releaseDir, { recursive: true });

const define = await embeddedSdkDefines();
for (const item of selectedTargets()) {
  await buildTarget(item, define);
}

function selectedTargets(): ReleaseTarget[] {
  if (process.argv.includes("--host")) {
    const target = hostTarget();
    return [{ ...target, outfile: optionValue("--outfile") ?? releaseOutfile(target) }];
  }
  return targets.map((item) => ({ ...item, outfile: releaseOutfile(item) }));
}

function hostTarget(): ReleaseTarget {
  const key = `${process.platform}/${process.arch}`;
  const target = hostTargets.get(key);
  if (!target) {
    throw new Error(`unsupported host platform for release binary: ${key}`);
  }
  return target;
}

function releaseOutfile(item: ReleaseTarget): string {
  return path.join(releaseDir, item.outfile);
}

async function embeddedSdkDefines(): Promise<Record<string, string>> {
  const [moduleSource, declarationSource] = await Promise.all([
    bundledSdkModule(),
    bundledSdkDeclaration(),
  ]);
  return {
    PIPR_EMBEDDED_SDK_MODULE: JSON.stringify(moduleSource),
    PIPR_EMBEDDED_SDK_DECLARATION: JSON.stringify(declarationSource),
  };
}

async function bundledSdkModule(): Promise<string> {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "pipr-sdk-bundle-"));
  try {
    const entrypoint = path.join(tempRoot, "entry.ts");
    const sdkSource = path.join(sourceRoot, "packages", "sdk", "src", "index.ts");
    await Bun.write(
      entrypoint,
      [
        `import * as sdk from ${JSON.stringify(sdkSource)};`,
        ...sdkRuntimeExports.map((name) => `export const ${name} = sdk.${name};`),
        "",
      ].join("\n"),
    );
    const result = await Bun.build({
      entrypoints: [entrypoint],
      format: "esm",
      target: "bun",
      packages: "bundle",
      write: false,
    });
    if (!result.success) {
      throw new Error(
        result.logs.map((log) => log.message).join("\n") || "embedded SDK build failed",
      );
    }
    const output = result.outputs[0];
    if (!output) {
      throw new Error("embedded SDK build produced no output");
    }
    return await output.text();
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

async function bundledSdkDeclaration(): Promise<string> {
  return embeddedSdkDeclaration(await readSdkDeclarationModules(sourceRoot));
}

async function buildTarget(item: ReleaseTarget, define: Record<string, string>): Promise<void> {
  const result = await Bun.build({
    entrypoints: [cliEntrypoint],
    compile: {
      target: item.target,
      outfile: item.outfile,
    },
    define,
  });
  if (!result.success) {
    throw new Error(
      result.logs.map((log) => log.message).join("\n") || `build failed for ${item.target}`,
    );
  }
  console.log(`built ${item.outfile}`);
}

function optionValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

async function run(command: string, args: string[]): Promise<void> {
  const process = Bun.spawn([command, ...args], {
    cwd: sourceRoot,
    env: Bun.env,
    stderr: "inherit",
    stdout: "inherit",
  });
  const exitCode = await process.exited;
  if (exitCode !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed with exit ${exitCode}`);
  }
}
