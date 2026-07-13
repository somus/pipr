#!/usr/bin/env bun
import assert from "node:assert/strict";
import path from "node:path";

type PackageJson = {
  version: string;
  bin?: Record<string, string>;
  dependencies?: Record<string, string>;
};

const rootArgIndex = process.argv.indexOf("--root");
if (rootArgIndex >= 0 && !process.argv[rootArgIndex + 1]) {
  throw new Error("--root requires a path");
}
const rootDir =
  rootArgIndex >= 0
    ? path.resolve(process.argv[rootArgIndex + 1])
    : path.resolve(import.meta.dirname, "..");
const lockPath = path.join(rootDir, "bun.lock");
const selfReviewLockPath = path.join(rootDir, ".pipr/bun.lock");
const actionPath = path.join(rootDir, "action.yml");
const webhookComposePath = path.join(rootDir, "deploy/webhook/compose.yml");
const selfReviewWorkflowPath = path.join(rootDir, ".github/workflows/pipr.yml");

const rootPackage = await readPackageJson("package.json");
const cliPackage = await readPackageJson("packages/cli/package.json");
const runtimePackage = await readPackageJson("packages/runtime/package.json");
const sdkPackage = await readPackageJson("packages/sdk/package.json");
const selfReviewPackage = await readPackageJson(".pipr/package.json");
const selfReviewSdkVersion = requiredValue(
  selfReviewPackage.dependencies?.["@usepipr/sdk"],
  ".pipr/package.json dependency @usepipr/sdk",
);

assert.equal(cliPackage.version, rootPackage.version, "@usepipr/cli version must match root");
assert.equal(
  runtimePackage.version,
  rootPackage.version,
  "@usepipr/runtime version must match root",
);
assert.equal(sdkPackage.version, rootPackage.version, "@usepipr/sdk version must match root");

let lockfile = await Bun.file(lockPath).text();

lockfile = updateWorkspaceBlock(lockfile, "packages/cli", "packages/e2e", (block) =>
  updateQuotedValues(block, {
    version: cliPackage.version,
    pipr: requiredValue(cliPackage.bin?.pipr, "@usepipr/cli bin.pipr"),
    "@usepipr/runtime": requiredValue(
      cliPackage.dependencies?.["@usepipr/runtime"],
      "@usepipr/cli dependency @usepipr/runtime",
    ),
    "@usepipr/sdk": requiredValue(
      cliPackage.dependencies?.["@usepipr/sdk"],
      "@usepipr/cli dependency @usepipr/sdk",
    ),
  }),
);
lockfile = updateWorkspaceBlock(lockfile, "packages/runtime", "packages/sdk", (block) =>
  updateQuotedValues(block, {
    version: runtimePackage.version,
    "@usepipr/sdk": requiredValue(
      runtimePackage.dependencies?.["@usepipr/sdk"],
      "@usepipr/runtime dependency @usepipr/sdk",
    ),
  }),
);
lockfile = updateWorkspaceBlock(lockfile, "packages/sdk", '  },\n  "catalog": {', (block) =>
  updateQuotedValues(block, { version: sdkPackage.version }),
);

await Bun.write(lockPath, lockfile);

let selfReviewLockfile = await Bun.file(selfReviewLockPath).text();
selfReviewLockfile = updateQuotedValues(selfReviewLockfile, {
  "@usepipr/sdk": selfReviewSdkVersion,
});
selfReviewLockfile = selfReviewLockfile.replace(
  /@usepipr\/sdk@\d+\.\d+\.\d+/g,
  `@usepipr/sdk@${selfReviewSdkVersion}`,
);
await Bun.write(selfReviewLockPath, selfReviewLockfile);

let actionMetadata = await Bun.file(actionPath).text();
actionMetadata = actionMetadata.replace(
  /docker:\/\/ghcr\.io\/somus\/pipr:v[0-9]+\.[0-9]+\.[0-9]+/g,
  `docker://ghcr.io/somus/pipr:v${rootPackage.version}`,
);
await Bun.write(actionPath, actionMetadata);

let webhookCompose = await Bun.file(webhookComposePath).text();
webhookCompose = webhookCompose.replace(
  /ghcr\.io\/somus\/pipr:v[0-9]+\.[0-9]+\.[0-9]+/g,
  `ghcr.io/somus/pipr:v${rootPackage.version}`,
);
await Bun.write(webhookComposePath, webhookCompose);

let selfReviewWorkflow = await Bun.file(selfReviewWorkflowPath).text();
selfReviewWorkflow = selfReviewWorkflow.replace(
  /somus\/pipr@v[0-9]+\.[0-9]+\.[0-9]+/g,
  `somus/pipr@v${rootPackage.version}`,
);
await Bun.write(selfReviewWorkflowPath, selfReviewWorkflow);

async function readPackageJson(relativePath: string): Promise<PackageJson> {
  return (await Bun.file(path.join(rootDir, relativePath)).json()) as PackageJson;
}

function updateWorkspaceBlock(
  lockfile: string,
  workspace: string,
  nextMarker: string,
  update: (block: string) => string,
): string {
  const start = lockfile.indexOf(`    "${workspace}": {`);
  const end = lockfile.indexOf(
    nextMarker.startsWith("    ") ? `    "${nextMarker}": {` : nextMarker,
    start + 1,
  );
  assert(start >= 0 && end > start, `bun.lock must contain ${workspace} workspace metadata`);
  return lockfile.slice(0, start) + update(lockfile.slice(start, end)) + lockfile.slice(end);
}

function updateQuotedValues(block: string, values: Record<string, string>): string {
  let updated = block;
  for (const [key, value] of Object.entries(values)) {
    const pattern = new RegExp(`("${escapeRegExp(key)}":\\s*)"[^"]+"`);
    assert(pattern.test(updated), `bun.lock workspace block must contain ${key}`);
    updated = updated.replace(pattern, `$1"${value}"`);
  }
  return updated;
}

function requiredValue(value: string | undefined, name: string): string {
  assert(value, `${name} is required`);
  return value;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
