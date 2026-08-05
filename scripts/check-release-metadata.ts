#!/usr/bin/env bun
import assert from "node:assert/strict";
import path from "node:path";
import { releaseSubcommands } from "./release.js";

type PackageJson = {
  name: string;
  version: string;
  catalog?: Record<string, string>;
  private?: boolean;
  publishConfig?: { access?: string };
  files?: string[];
  engines?: { bun?: string };
  bin?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  scripts?: Record<string, string>;
};

type ReleasePleaseConfig = {
  packages: Record<string, { "extra-files"?: Array<{ path: string; glob?: boolean }> }>;
};

type WorkflowStep = {
  id?: string;
  name?: string;
  env?: Record<string, string>;
  run?: string;
  uses?: string;
  with?: Record<string, unknown>;
};

type ReleaseWorkflow = {
  env?: Record<string, string>;
  jobs: Record<
    string,
    {
      env?: Record<string, string>;
      needs?: string | string[];
      permissions?: Record<string, string>;
      steps?: WorkflowStep[];
    }
  >;
};

const rootDir = path.resolve(import.meta.dirname, "..");
const rootPackage = await readJson<PackageJson>("package.json");
const releasePleaseConfig = await readText("release-please-config.json");
const parsedReleasePleaseConfig = JSON.parse(releasePleaseConfig) as ReleasePleaseConfig;
const ciWorkflow = await readText(".github/workflows/ci.yml");
const dockerImageWorkflow = await readText(".github/workflows/docker-image.yml");
const evalsWorkflow = await readText(".github/workflows/evals.yml");
const releaseWorkflow = await readText(".github/workflows/release.yml");
const parsedReleaseWorkflow = Bun.YAML.parse(releaseWorkflow) as ReleaseWorkflow;
const releasePleaseWorkflow = await readText(".github/workflows/release-please.yml");
const docsSources = await readGlob("apps/docs/content/docs/**/*.mdx");
const selfReviewWorkflow = await readText(".github/workflows/pipr.yml");
const actionMetadata = await readText("action.yml");
const webhookCompose = await readText("deploy/webhook/compose.yml");
const webhookEnvironment = await readText("deploy/webhook/.env.example");
const bunLock = await readText("bun.lock");
const releaseVersionExpression = githubExpression("steps.version.outputs.version");
const releasePushTokenExpression = githubExpression("secrets.PIPR_RELEASE_PLEASE_TOKEN");
const shaExpression = githubExpression("github.sha");
const resolveSteps = parsedReleaseWorkflow.jobs.resolve?.steps ?? [];
const publishSteps = parsedReleaseWorkflow.jobs.publish?.steps ?? [];
const dogfoodSteps = parsedReleaseWorkflow.jobs.dogfood?.steps ?? [];
const workflowSources = {
  ".github/workflows/ci.yml": ciWorkflow,
  ".github/workflows/docker-image.yml": dockerImageWorkflow,
  ".github/workflows/evals.yml": evalsWorkflow,
  ".github/workflows/release.yml": releaseWorkflow,
  ".github/workflows/release-please.yml": releasePleaseWorkflow,
  ".github/workflows/pipr.yml": selfReviewWorkflow,
};

for (const [file, source] of docsSources) {
  for (const [index, line] of source.split(/\r?\n/).entries()) {
    if (!line.includes("x-release-please-version")) continue;
    const versions = [...line.matchAll(/\bv?(\d+\.\d+\.\d+)\b/g)].map((match) => match[1]);
    assert(versions.length > 0, `${file}:${index + 1} release marker must include a version`);
    for (const version of versions) {
      assert.equal(
        version,
        rootPackage.version,
        `${file}:${index + 1} marked version must match root`,
      );
    }
  }
  assert(
    !/release\.published/.test(source),
    `${file} must not claim publishing runs directly from release.published`,
  );
}

for (const packageConfig of Object.values(parsedReleasePleaseConfig.packages)) {
  for (const extraFile of packageConfig["extra-files"] ?? []) {
    if (!extraFile.glob) {
      assert(
        await Bun.file(path.join(rootDir, extraFile.path)).exists(),
        `Release Please extra file does not exist: ${extraFile.path}`,
      );
    }
  }
}

for (const [workflowPath, workflow] of Object.entries(workflowSources)) {
  assertThirdPartyActionsPinned(workflowPath, workflow);
}

for (const packagePath of ["packages/sdk", "packages/runtime", "packages/cli"]) {
  const pkg = await readJson<PackageJson>(path.join(packagePath, "package.json"));
  assert.equal(pkg.version, rootPackage.version, `${pkg.name} version must match root`);
  assert.notEqual(pkg.private, true, `${pkg.name} must be publishable`);
  assert.equal(pkg.publishConfig?.access, "public", `${pkg.name} must publish publicly`);
  assert.deepEqual(pkg.files, ["dist", "LICENSE"], `${pkg.name} must publish dist and LICENSE`);
  assert.equal(
    await readText(path.join(packagePath, "LICENSE")),
    await readText("LICENSE"),
    `${pkg.name} LICENSE must match the root license`,
  );

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
const runtimePackage = await readJson<PackageJson>("packages/runtime/package.json");
const docsPackage = await readJson<PackageJson>("apps/docs/package.json");
const selfReviewPackage = await readJson<PackageJson>(".pipr/package.json");
const selfReviewSdkVersion = selfReviewPackage.dependencies?.["@usepipr/sdk"];
const selfReviewLock = await readText(".pipr/bun.lock");
assert.equal(cliPackage.bin?.pipr, "./dist/main.mjs", "@usepipr/cli bin must point at dist");
assert.equal(cliPackage.engines?.bun, ">=1.3.14", "@usepipr/cli must declare the Bun baseline");
assert.equal(
  runtimePackage.engines?.bun,
  ">=1.3.14",
  "@usepipr/runtime must declare the Bun baseline",
);
assert.equal(
  rootPackage.scripts?.["check:npm-tarballs"],
  "bun scripts/verify-npm-tarballs.ts",
  "root package scripts must expose npm tarball verification",
);
assert.equal(
  docsPackage.devDependencies?.["@usepipr/runtime"],
  "workspace:*",
  "private docs workspace must use the local @usepipr/runtime workspace package",
);
assert(
  selfReviewSdkVersion && /^\d+\.\d+\.\d+$/.test(selfReviewSdkVersion),
  ".pipr/package.json @usepipr/sdk dependency must pin a published stable version",
);
assert.equal(
  rootPackage.scripts?.["sync:release-lockfile"],
  "bun scripts/sync-release-lockfile.ts",
  "root package scripts must expose release lockfile sync",
);
assert.deepEqual(
  releaseSubcommands,
  ["resolve", "verify-tag", "dogfood"],
  "typed release workflow must expose exactly the supported subcommands",
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
  webhookCompose.includes(`image: \${PIPR_IMAGE:-ghcr.io/somus/pipr:v${rootPackage.version}}`),
  "webhook Compose deployment must pin the release image tag",
);
assert(
  webhookEnvironment.includes(`PIPR_IMAGE=ghcr.io/somus/pipr:v${rootPackage.version}`),
  "webhook environment template must pin the release image tag",
);
assert(
  releasePleaseConfig.includes('"path": "deploy/webhook/compose.yml"'),
  "Release Please must update the webhook Compose image tag",
);
assert(
  releasePleaseConfig.includes('"path": "deploy/webhook/.env.example"'),
  "Release Please must update the webhook environment image tag",
);
assert(
  selfReviewWorkflow.includes(`uses: somus/pipr@v${selfReviewSdkVersion}`),
  "Pipr self-review workflow must match the dogfood SDK version",
);
assert(
  releaseWorkflow.includes("id-token: write"),
  "release workflow must allow npm trusted publishing OIDC",
);
assert(
  releaseWorkflow.includes("pull-requests: write"),
  "release workflow must allow creating the post-publish dogfood update PR",
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
const resolveJob = parsedReleaseWorkflow.jobs.resolve;
assert.deepEqual(
  resolveJob?.permissions,
  { contents: "read" },
  "release tag resolution must run with read-only repository permissions",
);
for (const secretName of ["TURBO_API", "TURBO_REMOTE_CACHE_SIGNATURE_KEY", "TURBO_TOKEN"]) {
  assert.equal(
    parsedReleaseWorkflow.env?.[secretName] ??
      resolveJob?.env?.[secretName] ??
      resolveSteps.find((step) => step.env?.[secretName]),
    undefined,
    `release tag resolution must not receive ${secretName}`,
  );
  assert(
    parsedReleaseWorkflow.jobs.publish?.env?.[secretName],
    `release publish job requires ${secretName}`,
  );
}
const resolveStep = resolveSteps.find((step) => step.id === "release");
assert.equal(
  resolveStep?.run,
  "bun scripts/release.ts resolve",
  "release workflow must resolve release state through the typed release script",
);
assert.equal(
  resolveStep?.env?.GH_TOKEN,
  githubExpression("github.token"),
  "release tag resolution must use github.token through the environment",
);
for (const environmentName of [
  "PIPR_COMMIT_SUBJECT",
  "PIPR_EVENT_NAME",
  "PIPR_INPUT_TAG",
  "PIPR_WORKFLOW_RUN_SHA",
]) {
  assert(resolveStep?.env?.[environmentName], `release tag resolution requires ${environmentName}`);
}
const verifyTagStep = publishSteps.find((step) => step.id === "version");
assert.equal(
  verifyTagStep?.run,
  "bun scripts/release.ts verify-tag",
  "release workflow must verify tag metadata through the typed release script",
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
const verifyTagIndex = publishSteps.findIndex((step) => step.id === "version");
const releaseBuildIndex = publishSteps.findIndex(
  (step) => step.run === "bun run build:release:cli",
);
const releaseArtifactCheckIndex = publishSteps.findIndex(
  (step) => step.run === "bun run check:release-artifacts",
);
const npmTarballCheckIndex = publishSteps.findIndex(
  (step) => step.run === "bun run check:npm-tarballs",
);
const dockerVerificationIndex = publishSteps.findIndex((step) => step.run === "bun run docker:e2e");
const packagePublishIndices = ["sdk", "runtime", "cli"].map((packageName) =>
  publishSteps.findIndex(
    (step) =>
      step.run ===
      `npm publish "dist/npm/usepipr-${packageName}-${releaseVersionExpression}.tgz" --access public`,
  ),
);
const releaseUploadIndex = publishSteps.findIndex((step) =>
  step.run?.includes("gh release upload"),
);
const imagePublishIndex = publishSteps.findIndex(
  (step) => step.name === "Publish GHCR image" && step.with?.push === true,
);
const publicationOrder = [
  verifyTagIndex,
  releaseBuildIndex,
  releaseArtifactCheckIndex,
  npmTarballCheckIndex,
  dockerVerificationIndex,
  ...packagePublishIndices,
  releaseUploadIndex,
  imagePublishIndex,
];
assert(
  publicationOrder.every((index) => index >= 0) &&
    publicationOrder.every(
      (index, position) =>
        position === 0 || index > (publicationOrder[position - 1] ?? Number.POSITIVE_INFINITY),
    ),
  "release workflow must verify, publish packages, upload assets, and publish GHCR in exact order",
);
assert(
  !releaseWorkflow.includes("npm pack --dry-run"),
  "release workflow must not rely on npm pack dry runs",
);
assert(
  releaseWorkflow.includes("dist/release/SHA256SUMS"),
  "release workflow must upload SHA256SUMS",
);
for (const asset of [
  "pipr-linux-x64",
  "pipr-linux-arm64",
  "pipr-darwin-x64",
  "pipr-darwin-arm64",
]) {
  assert(
    releaseWorkflow.includes(`dist/release/${asset}`),
    `release workflow must upload exact asset ${asset}`,
  );
}
assert(
  !releaseWorkflow.includes("dist/release/pipr-*"),
  "release workflow must not upload release assets through a glob",
);
const dogfoodUpdateStep = dogfoodSteps.find((step) => step.name === "Open dogfood SDK update PR");
assert.equal(
  parsedReleaseWorkflow.jobs.dogfood?.needs,
  "publish",
  "release workflow must isolate the dogfood update in a post-publish job",
);
assert.equal(
  dogfoodUpdateStep?.run,
  "bun scripts/release.ts dogfood",
  "release workflow must invoke typed dogfood reconciliation after publish",
);
assert.equal(
  dogfoodUpdateStep?.env?.GH_TOKEN,
  releasePushTokenExpression,
  "release workflow dogfood update must use the release token for PR creation",
);
assert.equal(
  dogfoodUpdateStep?.env?.PIPR_RELEASE_VERSION,
  githubExpression("needs.publish.outputs.version"),
  "release workflow must pass the published version to the dogfood job",
);
const dogfoodCheckout = dogfoodSteps.find((step) => step.uses?.startsWith("actions/checkout@"));
assert.equal(
  dogfoodCheckout?.with?.token,
  releasePushTokenExpression,
  "release workflow dogfood checkout must use the release token for branch pushes",
);
assert(
  !releaseWorkflow.includes("PIPR_PUSH_TOKEN:"),
  "release workflow must let checkout configure Git authentication",
);
assert(
  !releaseWorkflow.includes("PIPR_RELEASE_PLEASE_TOKEN || github.token"),
  "release workflow dogfood update must not fall back to a token that cannot update workflows",
);
assert(
  !releaseWorkflow.includes("x-access-token:") && !releaseWorkflow.includes('"HEAD:main"'),
  "release workflow must not contain authenticated URL pushes or protected-main writes",
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
  /git -C "\$worktree" diff --quiet -- [^\n]*bun\.lock[^\n]*\.pipr\/bun\.lock[^\n]*action\.yml[^\n]*deploy\/webhook\/compose\.yml[^\n]*\.github\/workflows\/pipr\.yml/.test(
    releasePleaseWorkflow,
  ),
  "Release Please workflow must detect release metadata changes",
);
assert(
  /git -C "\$worktree" add [^\n]*bun\.lock[^\n]*\.pipr\/bun\.lock[^\n]*action\.yml[^\n]*deploy\/webhook\/compose\.yml[^\n]*\.github\/workflows\/pipr\.yml/.test(
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

async function readGlob(pattern: string): Promise<Array<[string, string]>> {
  const files: Array<[string, string]> = [];
  const glob = new Bun.Glob(pattern);
  for await (const relativePath of glob.scan({ cwd: rootDir, onlyFiles: true })) {
    files.push([relativePath, await readText(relativePath)]);
  }
  return files.sort(([left], [right]) => left.localeCompare(right));
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

function assertThirdPartyActionsPinned(workflowPath: string, workflow: string): void {
  const actionReferences = workflow.matchAll(/^\s*(?:-\s*)?uses:\s+([^@\s]+)@([^\s#]+)/gm);
  for (const reference of actionReferences) {
    const action = requiredCapture(reference, 1);
    if (isLocalAction(action)) continue;
    const ref = requiredCapture(reference, 2);
    assert(/^[0-9a-f]{40}$/.test(ref), `${workflowPath} must pin ${action} to a full commit SHA`);
  }
}

function isLocalAction(action: string): boolean {
  return action.startsWith("./") || action === "somus/pipr";
}

function requiredCapture(match: RegExpMatchArray, index: number): string {
  const value = match[index];
  assert(value);
  return value;
}
