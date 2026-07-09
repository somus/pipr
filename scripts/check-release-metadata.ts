#!/usr/bin/env bun
import assert from "node:assert/strict";
import path from "node:path";

type PackageJson = {
  name: string;
  version: string;
  catalog?: Record<string, string>;
  private?: boolean;
  publishConfig?: { access?: string };
  files?: string[];
  bin?: Record<string, string>;
  dependencies?: Record<string, string>;
  scripts?: Record<string, string>;
};

const rootDir = path.resolve(import.meta.dirname, "..");
const rootPackage = await readJson<PackageJson>("package.json");
const releasePleaseConfig = await readText("release-please-config.json");
const ciWorkflow = await readText(".github/workflows/ci.yml");
const dockerImageWorkflow = await readText(".github/workflows/docker-image.yml");
const releaseWorkflow = await readText(".github/workflows/release.yml");
const releasePleaseWorkflow = await readText(".github/workflows/release-please.yml");
const selfReviewWorkflow = await readText(".github/workflows/pipr.yml");
const actionMetadata = await readText("action.yml");
const bunLock = await readText("bun.lock");
const releaseVersionExpression = githubExpression("steps.version.outputs.version");
const shaExpression = githubExpression("github.sha");
const workflowSources = {
  ".github/workflows/ci.yml": ciWorkflow,
  ".github/workflows/docker-image.yml": dockerImageWorkflow,
  ".github/workflows/release.yml": releaseWorkflow,
  ".github/workflows/release-please.yml": releasePleaseWorkflow,
  ".github/workflows/pipr.yml": selfReviewWorkflow,
};

for (const [workflowPath, workflow] of Object.entries(workflowSources)) {
  assertThirdPartyActionsPinned(workflowPath, workflow);
}

for (const packagePath of ["packages/sdk", "packages/runtime", "packages/cli"]) {
  const pkg = await readJson<PackageJson>(path.join(packagePath, "package.json"));
  assert.equal(pkg.version, rootPackage.version, `${pkg.name} version must match root`);
  assert.notEqual(pkg.private, true, `${pkg.name} must be publishable`);
  assert.equal(pkg.publishConfig?.access, "public", `${pkg.name} must publish publicly`);
  assert.deepEqual(pkg.files, ["dist"], `${pkg.name} must publish dist only`);

  for (const [name, range] of Object.entries(pkg.dependencies ?? {})) {
    assert(!range.startsWith("workspace:"), `${pkg.name} dependency ${name} uses ${range}`);
    assert(!range.startsWith("catalog:"), `${pkg.name} dependency ${name} uses ${range}`);
    if (rootPackage.catalog?.[name]) {
      assert.equal(
        range,
        rootPackage.catalog[name],
        `${pkg.name} dependency ${name} must match root catalog`,
      );
    }
  }
}

const cliPackage = await readJson<PackageJson>("packages/cli/package.json");
const selfReviewPackage = await readJson<PackageJson>(".pipr/package.json");
const selfReviewSdkVersion = selfReviewPackage.dependencies?.["@usepipr/sdk"];
const selfReviewLock = await readText(".pipr/bun.lock");
assert.equal(cliPackage.bin?.pipr, "./dist/main.mjs", "@usepipr/cli bin must point at dist");
assert(
  selfReviewSdkVersion && /^\d+\.\d+\.\d+$/.test(selfReviewSdkVersion),
  ".pipr/package.json @usepipr/sdk dependency must pin a published stable version",
);
assert.equal(
  rootPackage.scripts?.["sync:release-lockfile"],
  "bun scripts/sync-release-lockfile.ts",
  "root package scripts must expose release lockfile sync",
);

const cliLock = bunWorkspaceBlock(bunLock, "packages/cli", "packages/e2e");
assert(
  cliLock.includes(`"version": "${rootPackage.version}"`),
  "bun.lock @usepipr/cli version must match root",
);
assert(
  cliLock.includes('"pipr": "./dist/main.mjs"'),
  "bun.lock @usepipr/cli bin must point at dist",
);
assert(
  cliLock.includes(`"@usepipr/runtime": "${rootPackage.version}"`),
  "bun.lock @usepipr/cli runtime dependency must match root",
);
assert(
  cliLock.includes(`"@usepipr/sdk": "${rootPackage.version}"`),
  "bun.lock @usepipr/cli sdk dependency must match root",
);
assert(
  selfReviewLock.includes(`"@usepipr/sdk": "${selfReviewSdkVersion}"`),
  ".pipr/bun.lock @usepipr/sdk dependency must match .pipr/package.json",
);
assert(
  selfReviewLock.includes(`"@usepipr/sdk@${selfReviewSdkVersion}"`),
  ".pipr/bun.lock @usepipr/sdk package entry must match .pipr/package.json",
);

assert(
  actionMetadata.startsWith("name: Pipr Review\n"),
  "action.yml Marketplace name must be unique for GitHub Marketplace publishing",
);
assert(
  actionMetadata.includes(`docker://ghcr.io/somus/pipr:v${rootPackage.version}`),
  "action.yml must pin the release image tag",
);
assert(
  selfReviewWorkflow.includes(`uses: somus/pipr@v${rootPackage.version}`),
  "Pipr self-review workflow must pin the current release action",
);
assert(
  releaseWorkflow.includes("id-token: write"),
  "release workflow must allow npm trusted publishing OIDC",
);
assert(!releaseWorkflow.includes("NPM_TOKEN"), "release workflow must not require an npm token");
assert(
  !releaseWorkflow.includes("release:\n    types: [published]"),
  "release workflow must not publish directly from release.published before main CI passes",
);
assert(
  releaseWorkflow.includes("workflow_run:"),
  "release workflow must wait for the CI workflow before publishing",
);
assert(
  releaseWorkflow.includes("workflows: [CI]"),
  "release workflow must wait for the CI workflow by name",
);
assert(
  releaseWorkflow.includes("github.event.workflow_run.conclusion == 'success'"),
  "release workflow must publish only after successful CI",
);
assert(
  releaseWorkflow.includes("github.event.workflow_run.head_branch == 'main'"),
  "release workflow must publish only for main branch CI",
);
assert(
  releaseWorkflow.includes("gh release list"),
  "release workflow must resolve the published release tag after CI succeeds",
);
assert(
  releaseWorkflow.includes('"chore: release "*)'),
  "release workflow must accept Release Please release subjects without a branch scope",
);
assert(
  releaseWorkflow.includes("for attempt in {1..60}"),
  "release workflow must wait long enough for Release Please to publish the release",
);
assert(
  releaseWorkflow.includes("failing so publish is not silently lost"),
  "release workflow must fail release commits when no release is found after waiting",
);
assert(
  releaseWorkflow.includes(`type=raw,value=v${releaseVersionExpression}`),
  "release workflow must publish v-prefixed image tag",
);
assert(
  releaseWorkflow.includes(`type=raw,value=${releaseVersionExpression}`),
  "release workflow must publish plain version image tag",
);
assert(
  releaseWorkflow.includes("type=raw,value=latest"),
  "release workflow must publish latest tag",
);
assert(
  !releaseWorkflow.includes("type=raw,value=main"),
  "release workflow must not publish main tag",
);
assert(
  !releaseWorkflow.includes(`sha-${shaExpression}`),
  "release workflow must not publish sha tag",
);
for (const packagePath of ["packages/sdk", "packages/runtime", "packages/cli"]) {
  assertMatches(
    releaseWorkflow,
    workflowStepPattern("npm pack --dry-run --json", packagePath),
    `release workflow must dry-run pack ${packagePath}`,
  );
  assertMatches(
    releaseWorkflow,
    workflowStepPattern("npm publish --access public", packagePath),
    `release workflow must publish ${packagePath}`,
  );
}
assert(
  releaseWorkflow.includes("dist/release/SHA256SUMS"),
  "release workflow must upload SHA256SUMS",
);
assert(
  !releasePleaseConfig.includes('"path": "bun.lock"'),
  "Release Please must not use unsupported generic bun.lock updates",
);
assert(
  !releasePleaseConfig.includes('"path": ".pipr/package.json"'),
  "Release Please must not bump dogfood SDK before packages are published",
);
assert(
  !releasePleaseWorkflow.includes("bun install --lockfile-only"),
  "Release Please workflow must not run package installation on the release PR branch",
);
assert(
  releasePleaseWorkflow.includes("persist-credentials: false"),
  "Release Please workflow must not persist credentials into release PR branch steps",
);
assert(
  releasePleaseWorkflow.includes("secrets.PIPR_RELEASE_PLEASE_TOKEN || github.token"),
  "Release Please workflow must fall back to github.token when no release token secret is configured",
);
assert(
  releasePleaseWorkflow.includes("id: lockfile"),
  "Release Please workflow must expose lockfile sync outputs",
);
assert(
  releasePleaseWorkflow.includes('git worktree add -B "$branch" "$worktree" FETCH_HEAD'),
  "Release Please workflow must isolate the fetched release PR branch in a worktree",
);
assert(
  releasePleaseWorkflow.includes('bun run sync:release-lockfile -- --root "$worktree"'),
  "Release Please workflow must run the trusted lockfile sync script against the release worktree",
);
assert(
  /git -C "\$worktree" diff --quiet -- [^\n]*bun\.lock[^\n]*\.pipr\/bun\.lock[^\n]*action\.yml[^\n]*\.github\/workflows\/pipr\.yml/.test(
    releasePleaseWorkflow,
  ),
  "Release Please workflow must detect release metadata changes",
);
assert(
  /git -C "\$worktree" add [^\n]*bun\.lock[^\n]*\.pipr\/bun\.lock[^\n]*action\.yml[^\n]*\.github\/workflows\/pipr\.yml/.test(
    releasePleaseWorkflow,
  ),
  "Release Please workflow must commit release metadata changes",
);
assert(
  !releasePleaseWorkflow.includes("bun install --frozen-lockfile"),
  "Release Please workflow must not require a stale lockfile before sync",
);
assert(
  releasePleaseWorkflow.includes("steps.lockfile.outputs.changed == 'true'"),
  "Release Please workflow must push only after the tokenless lockfile sync step reports changes",
);
assert(
  releasePleaseWorkflow.includes("-c core.hooksPath=/dev/null push"),
  "Release Please workflow must disable git hooks for the authenticated push",
);

async function readJson<T>(relativePath: string): Promise<T> {
  return (await Bun.file(path.join(rootDir, relativePath)).json()) as T;
}

async function readText(relativePath: string): Promise<string> {
  return await Bun.file(path.join(rootDir, relativePath)).text();
}

function githubExpression(value: string): string {
  return ["${{ ", value, " }}"].join("");
}

function bunWorkspaceBlock(lockfile: string, workspace: string, nextWorkspace: string): string {
  const start = lockfile.indexOf(`    "${workspace}": {`);
  const end = lockfile.indexOf(`    "${nextWorkspace}": {`, start + 1);
  assert(start >= 0 && end > start, `bun.lock must contain ${workspace} workspace metadata`);
  return lockfile.slice(start, end);
}

function assertMatches(value: string, pattern: RegExp, message: string): void {
  assert(pattern.test(value), message);
}

function workflowStepPattern(command: string, workingDirectory: string): RegExp {
  return new RegExp(
    `-\\s+run:\\s+${escapeRegExp(command)}\\s+working-directory:\\s+${escapeRegExp(
      workingDirectory,
    )}`,
    "m",
  );
}

function assertThirdPartyActionsPinned(workflowPath: string, workflow: string): void {
  for (const line of workflow.split(/\r?\n/)) {
    const match = line.match(/^\s*(?:-\s*)?uses:\s+([^@\s]+)@([^\s#]+)/);
    if (!match) {
      continue;
    }
    const [, action, ref] = match;
    if (!action || action.startsWith("./") || action === "somus/pipr") {
      continue;
    }
    assert(
      /^[0-9a-f]{40}$/.test(ref ?? ""),
      `${workflowPath} must pin ${action} to a full commit SHA`,
    );
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
