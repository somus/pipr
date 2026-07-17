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

const defaultGitLabImageRef = "ghcr.io/somus/pipr:v0.4.2"; // x-release-please-version
const defaultSdkVersion = "0.4.2"; // x-release-please-version

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
    files.push({
      relativePath: "azure-devops.pipr.env.example",
      contents: starterAzureDevOpsWebhookEnvironment(recipe),
    });
  }
  if (adapters.includes("bitbucket")) {
    files.push({
      relativePath: "bitbucket.pipr.env.example",
      contents: starterBitbucketWebhookEnvironment(recipe),
    });
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

function starterBitbucketWebhookEnvironment(recipe?: string): string {
  const lines = [
    "# Copy these names into the trusted webhook runner's secret store.",
    "BITBUCKET_WORKSPACE=",
    "BITBUCKET_REPO_SLUG=",
    "BITBUCKET_EMAIL=",
    "BITBUCKET_API_TOKEN=",
    "BITBUCKET_PERMISSION_EMAIL=",
    "BITBUCKET_PERMISSION_API_TOKEN=",
    "PIPR_WEBHOOK_SECRET=",
  ];
  for (const secret of officialInitRecipeWorkflowEnvSecrets(recipe)) lines.push(`${secret.env}=`);
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
