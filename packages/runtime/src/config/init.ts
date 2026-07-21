import { lstat, mkdir } from "node:fs/promises";
import path from "node:path";
import { assertBunAvailable } from "./config-deps.js";
import { renderOfficialGithubWorkflow } from "./official-github-workflow.js";
import { isPathContained, resolveContainedConfigDir } from "./paths.js";
import { loadRuntimeProject } from "./project.js";
import {
  officialInitRecipeConfigTs,
  officialInitRecipeFiles,
  officialInitRecipeWorkflowEnvSecrets,
} from "./recipes.js";
import { defaultTypesBunVersion, defaultTypescriptVersion } from "./scaffold-versions.js";
import { starterTsconfig } from "./starter-tsconfig.js";

export type InitOfficialMinimalProjectOptions = {
  rootDir: string;
  configDir?: string;
  force?: boolean;
  adapters?: readonly string[];
  recipe?: string;
  minimal?: boolean;
};

export type InitOfficialMinimalProjectResult = {
  configDir: string;
  created: string[];
  overwritten: string[];
};

export const supportedOfficialInitAdapters = [
  "github",
  "gitlab",
  "azure-devops",
  "bitbucket",
] as const;

export type OfficialInitAdapter = (typeof supportedOfficialInitAdapters)[number];

type StarterFile = {
  relativePath: string;
  contents: string;
};

const defaultGitLabImageRef = "ghcr.io/somus/pipr:v0.5.0"; // x-release-please-version
const defaultSdkVersion = "0.5.0"; // x-release-please-version

function resolveOfficialInitAdapters(adapters?: readonly string[]): OfficialInitAdapter[] {
  if (adapters === undefined) {
    return ["github"];
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
    if (!supportedOfficialInitAdapters.includes(adapter as OfficialInitAdapter)) {
      throw unsupportedAdapterError(adapter);
    }
    selected.add(adapter as OfficialInitAdapter);
  }
  return [...selected];
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
  const { configDir, relativeConfigDir, projectDir } = resolveContainedConfigDir(options);
  const adapters = resolveOfficialInitAdapters(options.adapters);
  const rootDir = path.resolve(options.rootDir);
  const minimal = options.minimal === true;
  const files = await starterFiles(relativeConfigDir, adapters, options.recipe, minimal);
  const targets = files.map((file) => ({
    ...file,
    absolutePath: path.join(rootDir, file.relativePath),
  }));
  await assertSafeTargetAncestors(targets, rootDir);
  const existing = await findExistingTargets(targets);
  if (existing.length > 0 && !options.force) {
    throw new Error(
      `Project already contains pipr files: ${existing.join(", ")}. ` +
        "Use --force to replace existing .pipr files.",
    );
  }

  const result = await writeTargets(targets, existing, { skipExisting: false });

  if (!minimal) {
    await assertBunAvailable();
    const install = Bun.spawn(initInstallCommand(), {
      cwd: projectDir,
      env: process.env,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stderr] = await Promise.all([
      install.exited,
      new Response(install.stderr).text(),
    ]);
    if (exitCode !== 0) {
      throw new Error(
        `${configDir}: bun install failed (exit ${exitCode}).` +
          (stderr.trim().length > 0 ? `\n${stderr.trim()}` : ""),
      );
    }
    if (await Bun.file(path.join(projectDir, "bun.lock")).exists()) {
      const lockRelative = path.join(relativeConfigDir, "bun.lock");
      if (!existing.includes(lockRelative) && !result.created.includes(lockRelative)) {
        result.created.push(lockRelative);
      }
    }
  }

  await loadRuntimeProject({ rootDir: options.rootDir, configDir });
  return { configDir, ...result };
}

function initInstallCommand(env: NodeJS.ProcessEnv = process.env): string[] {
  const command = ["bun", "install", "--ignore-scripts"];
  if (env.PIPR_INTERNAL_INIT_OFFLINE === "1") command.push("--offline");
  return command;
}

async function starterFiles(
  relativeConfigDir: string,
  adapters: readonly OfficialInitAdapter[],
  recipe?: string,
  minimal = false,
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
  if (!minimal) {
    files.push(
      {
        relativePath: path.join(relativeConfigDir, "package.json"),
        contents: starterPackageJson(),
      },
      {
        relativePath: path.join(relativeConfigDir, "tsconfig.json"),
        contents: starterTsconfig,
      },
      {
        relativePath: path.join(relativeConfigDir, ".gitignore"),
        contents: "node_modules\n",
      },
    );
  }
  if (adapters.includes("github")) {
    files.push({
      relativePath: path.join(".github", "workflows", "pipr.yml"),
      contents: renderOfficialGithubWorkflow({
        relativeConfigDir: relativeConfigDir.split(path.sep).join("/"),
        recipe,
        minimal,
      }),
    });
  }
  if (adapters.includes("gitlab")) {
    files.push({
      relativePath: ".gitlab-ci.yml",
      contents: starterGitLabPipeline(relativeConfigDir.split(path.sep).join("/"), recipe),
    });
  }
  if (adapters.includes("azure-devops")) {
    files.push(
      {
        relativePath: "azure-devops.pipr.env.example",
        contents: starterAzureDevOpsWebhookEnvironment(recipe),
      },
      {
        relativePath: "azure-pipelines.pipr.yml",
        contents: starterAzureDevOpsPipeline(relativeConfigDir.split(path.sep).join("/"), recipe),
      },
    );
  }
  if (adapters.includes("bitbucket")) {
    files.push(
      {
        relativePath: "bitbucket.pipr.env.example",
        contents: starterBitbucketWebhookEnvironment(recipe),
      },
      {
        relativePath: "bitbucket-pipelines.yml",
        contents: starterBitbucketPipeline(relativeConfigDir.split(path.sep).join("/"), recipe),
      },
    );
  }
  return files;
}

function starterGitLabPipeline(relativeConfigDir: string, recipe?: string): string {
  const lines = [
    "pipr:",
    "  image:",
    `    name: ${defaultGitLabImageRef}`,
    '    entrypoint: [""]',
    "  rules:",
    "    - if: '$CI_PIPELINE_SOURCE == \"merge_request_event\"'",
    "  variables:",
    '    GIT_DEPTH: "0"',
    '    PIPR_CODE_HOST: "gitlab"',
    "  script:",
    `    - pipr host-run --host gitlab --config-dir ${relativeConfigDir}`,
    "  artifacts:",
    "    when: always",
    "    expire_in: 14 days",
    '    name: "pipr-runs-pr-$CI_MERGE_REQUEST_IID-pipeline-$CI_PIPELINE_ID"',
    "    paths:",
    "      - .pipr-runs/",
  ];
  for (const secret of officialInitRecipeWorkflowEnvSecrets(recipe)) {
    lines.push(`    # Configure ${secret.env} as a masked GitLab CI/CD variable.`);
  }
  lines.push("");
  return lines.join("\n");
}

function starterAzureDevOpsWebhookEnvironment(recipe?: string): string {
  const lines = [
    "# Copy these names into the trusted webhook runner's secret store.",
    "AZURE_DEVOPS_ORGANIZATION=",
    "AZURE_DEVOPS_PROJECT=",
    "AZURE_DEVOPS_BEARER_TOKEN=",
    "PIPR_AZURE_SUBSCRIPTION_ID=",
    "PIPR_WEBHOOK_SECRET=",
  ];
  for (const secret of officialInitRecipeWorkflowEnvSecrets(recipe)) {
    lines.push(`${secret.env}=`);
  }
  lines.push("");
  return lines.join("\n");
}

function starterAzureDevOpsPipeline(relativeConfigDir: string, recipe?: string): string {
  const secrets = officialInitRecipeWorkflowEnvSecrets(recipe);
  const lines = [
    "# Use only when this pipeline definition is immutable to pull request authors.",
    "trigger: none",
    "pr:",
    "  branches:",
    "    include:",
    "      - '*'",
    "pool:",
    "  vmImage: ubuntu-latest",
    "steps:",
    "  - checkout: self",
    "    fetchDepth: 0",
    "  - bash: |",
    "      docker run --rm \\",
    '        --volume "$BUILD_SOURCESDIRECTORY:/workspace" \\',
    "        --env TF_BUILD=true \\",
    "        --env BUILD_SOURCESDIRECTORY=/workspace \\",
    "        --env BUILD_BUILDID \\",
    "        --env BUILD_REPOSITORY_ID \\",
    "        --env SYSTEM_COLLECTIONURI \\",
    "        --env SYSTEM_JOBID \\",
    "        --env SYSTEM_PULLREQUEST_PULLREQUESTID \\",
    "        --env SYSTEM_TEAMPROJECT \\",
    "        --env SYSTEM_ACCESSTOKEN \\",
  ];
  for (const secret of secrets) {
    lines.push(`        --env ${secret.env} \\`);
  }
  lines.push(
    `        ${defaultGitLabImageRef} \\`,
    `        host-run --host azure-devops --config-dir ${relativeConfigDir}`,
    "    displayName: Run Pipr",
    "    env:",
    "      SYSTEM_ACCESSTOKEN: $(System.AccessToken)",
  );
  for (const secret of secrets) {
    lines.push(`      ${secret.env}: $(${secret.env})`);
  }
  lines.push(
    "  - task: PublishPipelineArtifact@1",
    "    condition: and(always(), ne(variables['PIPR_RUN_BUNDLE_PATH'], ''))",
    "    inputs:",
    "      targetPath: $(PIPR_RUN_BUNDLE_PATH)",
    "      artifact: $(PIPR_RUN_ARTIFACT_NAME)",
  );
  lines.push("");
  return lines.join("\n");
}

function starterBitbucketWebhookEnvironment(recipe?: string): string {
  const lines = [
    "# Copy these names into the trusted webhook runner's secret store.",
    "BITBUCKET_WORKSPACE=",
    "BITBUCKET_REPO_SLUG=",
    "BITBUCKET_EMAIL=",
    "BITBUCKET_API_TOKEN=",
    "BITBUCKET_PERMISSION_EMAIL=",
    "BITBUCKET_PERMISSION_API_TOKEN=",
    "BITBUCKET_ARTIFACT_EMAIL=",
    "BITBUCKET_ARTIFACT_API_TOKEN=",
    "PIPR_WEBHOOK_SECRET=",
  ];
  for (const secret of officialInitRecipeWorkflowEnvSecrets(recipe)) lines.push(`${secret.env}=`);
  lines.push("");
  return lines.join("\n");
}

function starterBitbucketPipeline(relativeConfigDir: string, recipe?: string): string {
  const lines = [
    "# Use only when repository variables are not exposed to untrusted pipeline changes.",
    "clone:",
    "  depth: full",
    "pipelines:",
    "  pull-requests:",
    "    '**':",
    "      - step:",
    "          name: Pipr review (run bundle v1)",
    `          image: ${defaultGitLabImageRef}`,
    "          script:",
    `            - pipr host-run --host bitbucket --config-dir ${relativeConfigDir}`,
    "          artifacts:",
    "            upload:",
    "              - name: pipr-run-v1",
    "                type: scoped",
    "                paths:",
    "                  - .pipr-runs/**",
    "                capture-on: always",
  ];
  for (const secret of officialInitRecipeWorkflowEnvSecrets(recipe)) {
    lines.push(`          # Configure ${secret.env} as a secured repository variable.`);
  }
  lines.push("");
  return lines.join("\n");
}

export function officialInitPackageManifest(env: NodeJS.ProcessEnv = process.env): {
  private: true;
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
} {
  return {
    private: true,
    dependencies: {
      "@usepipr/sdk": env.PIPR_INTERNAL_INIT_SDK_VERSION ?? defaultSdkVersion,
    },
    devDependencies: {
      "@types/bun": env.PIPR_INTERNAL_INIT_TYPES_BUN_VERSION ?? defaultTypesBunVersion,
      typescript: env.PIPR_INTERNAL_INIT_TYPESCRIPT_VERSION ?? defaultTypescriptVersion,
    },
  };
}

function starterPackageJson(): string {
  return `${JSON.stringify(officialInitPackageManifest(), null, 2)}\n`;
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
