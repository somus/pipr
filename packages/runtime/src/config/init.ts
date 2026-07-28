import { lstat, mkdir } from "node:fs/promises";
import { isIP } from "node:net";
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
  runtimeImage?: string;
  checkoutAction?: string;
  githubRunner?: string;
  githubEnterpriseServer?: boolean;
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
  "gitea",
  "forgejo",
  "codeberg",
] as const;

export type OfficialInitAdapter = (typeof supportedOfficialInitAdapters)[number];

type StarterFile = {
  relativePath: string;
  contents: string;
};

const defaultGitLabImageRef = "ghcr.io/somus/pipr:v0.7.0"; // x-release-please-version
const defaultSdkVersion = "0.7.0"; // x-release-please-version
const ociReferenceCharacters = /^[A-Za-z0-9[][A-Za-z0-9._/@:+\]-]*$/;
const ociRepositoryComponent = /^[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*$/;
const ociRegistryWithPort = /^[a-z0-9]+(?:[.-][a-z0-9]+)*:[0-9]+$/;
const ociTag = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/;

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
  assertRuntimeImageReference(options.runtimeImage);
  assertCheckoutActionReference(options.checkoutAction);
  assertGitHubRunnerLabel(options.githubRunner);
  const { configDir, relativeConfigDir, projectDir } = resolveContainedConfigDir(options);
  const adapters = resolveOfficialInitAdapters(options.adapters);
  assertDistinctAdapterTargets(adapters);
  const rootDir = path.resolve(options.rootDir);
  const minimal = options.minimal === true;
  const files = await starterFiles(relativeConfigDir, adapters, options.recipe, minimal, {
    runtimeImage: options.runtimeImage,
    checkoutAction: options.checkoutAction,
    githubRunner: options.githubRunner,
    githubEnterpriseServer: options.githubEnterpriseServer,
  });
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

  if (!minimal)
    await installStarterDependencies({
      configDir,
      projectDir,
      relativeConfigDir,
      existing,
      created: result.created,
    });

  await loadRuntimeProject({ rootDir: options.rootDir, configDir });
  return { configDir, ...result };
}

function assertDistinctAdapterTargets(adapters: readonly OfficialInitAdapter[]): void {
  if (adapters.includes("forgejo") && adapters.includes("codeberg")) {
    throw new Error("Adapters 'forgejo' and 'codeberg' target the same workflow path.");
  }
}

async function installStarterDependencies(options: {
  configDir: string;
  projectDir: string;
  relativeConfigDir: string;
  existing: string[];
  created: string[];
}): Promise<void> {
  await assertBunAvailable();
  const install = Bun.spawn(initInstallCommand(), {
    cwd: options.projectDir,
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
      `${options.configDir}: bun install failed (exit ${exitCode}).` +
        (stderr.trim().length > 0 ? `\n${stderr.trim()}` : ""),
    );
  }
  if (!(await Bun.file(path.join(options.projectDir, "bun.lock")).exists())) return;
  const lockRelative = path.join(options.relativeConfigDir, "bun.lock");
  if (!options.existing.includes(lockRelative) && !options.created.includes(lockRelative)) {
    options.created.push(lockRelative);
  }
}

function assertRuntimeImageReference(value: string | undefined): void {
  if (value === undefined) return;
  const { repository, tag, digest } = parseOciImageReference(value);
  if (
    !isValidOciRepository(repository) ||
    !isValidOciTag(tag) ||
    !isValidOptionalOciDigest(digest)
  ) {
    throw invalidRuntimeImageReference();
  }
}

function parseOciImageReference(value: string): {
  repository: string;
  tag: string | undefined;
  digest: string | undefined;
} {
  if (!ociReferenceCharacters.test(value) || value.includes("://")) {
    throw invalidRuntimeImageReference();
  }
  const [nameAndTag, digest, extra] = value.split("@");
  if (extra !== undefined) throw invalidRuntimeImageReference();
  const lastSlash = nameAndTag.lastIndexOf("/");
  const tagSeparator = nameAndTag.lastIndexOf(":");
  const repository = tagSeparator > lastSlash ? nameAndTag.slice(0, tagSeparator) : nameAndTag;
  const tag = tagSeparator > lastSlash ? nameAndTag.slice(tagSeparator + 1) : undefined;
  return { repository, tag, digest };
}

function invalidRuntimeImageReference(): Error {
  return new Error("The runtime image reference is not a valid OCI image reference.");
}

function assertCheckoutActionReference(value: string | undefined): void {
  if (value === undefined) return;
  const at = value.indexOf("@");
  const actionPath = value.slice(0, at);
  const actionRef = value.slice(at + 1);
  const pathComponents = actionPath.split("/");
  if (
    at <= 0 ||
    at !== value.lastIndexOf("@") ||
    pathComponents.length < 2 ||
    pathComponents.some(
      (component) =>
        component === "." || component === ".." || !/^[A-Za-z0-9_.-]+$/.test(component),
    ) ||
    !/^[A-Za-z0-9][A-Za-z0-9._/+-]*$/.test(actionRef) ||
    actionRef.includes("//") ||
    actionRef.endsWith("/")
  ) {
    throw new Error("The checkout action reference must use OWNER/REPOSITORY[/PATH]@REF.");
  }
}

function assertGitHubRunnerLabel(value: string | undefined): void {
  if (value === undefined) return;
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(value)) {
    throw new Error("The GitHub runner label contains unsupported characters.");
  }
}

function isBracketedIpv6Registry(component: string): boolean {
  const match = component.match(/^\[([0-9A-Fa-f:.]+)\](?::[0-9]+)?$/);
  return match !== null && isIP(match[1]) === 6;
}

function isValidOciRepository(repository: string): boolean {
  return repository.split("/").every((component, index) => {
    if (index === 0 && component.includes(":")) {
      return ociRegistryWithPort.test(component) || isBracketedIpv6Registry(component);
    }
    return ociRepositoryComponent.test(component);
  });
}

function isValidOciTag(tag: string | undefined): boolean {
  return tag === undefined || ociTag.test(tag);
}

function isValidOptionalOciDigest(digest: string | undefined): boolean {
  if (digest === undefined) return true;
  const match = digest.match(/^(sha256|sha384|sha512):([a-f0-9]+)$/);
  if (match === null) return false;
  const encodedLengths = { sha256: 64, sha384: 96, sha512: 128 } as const;
  return match[2].length === encodedLengths[match[1] as keyof typeof encodedLengths];
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
  setup: {
    runtimeImage?: string;
    checkoutAction?: string;
    githubRunner?: string;
    githubEnterpriseServer?: boolean;
  } = {},
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
  const workflowConfigDir = relativeConfigDir.split(path.sep).join("/");
  for (const adapter of adapters) {
    files.push(...starterAdapterFiles(adapter, workflowConfigDir, recipe, minimal, setup));
  }
  return files;
}

function starterAdapterFiles(
  adapter: OfficialInitAdapter,
  relativeConfigDir: string,
  recipe: string | undefined,
  minimal: boolean,
  setup: {
    runtimeImage?: string;
    checkoutAction?: string;
    githubRunner?: string;
    githubEnterpriseServer?: boolean;
  },
): StarterFile[] {
  switch (adapter) {
    case "github":
      return [
        {
          relativePath: path.join(".github", "workflows", "pipr.yml"),
          contents: renderOfficialGithubWorkflow({
            relativeConfigDir,
            recipe,
            minimal,
            runtimeImage: setup.runtimeImage,
            checkoutAction: setup.checkoutAction,
            githubRunner: setup.githubRunner,
            githubEnterpriseServer: setup.githubEnterpriseServer,
          }),
        },
      ];
    case "gitlab":
      return [
        {
          relativePath: "gitlab.pipr.env.example",
          contents: starterGitLabWebhookEnvironment(recipe),
        },
        {
          relativePath: ".gitlab-ci.yml",
          contents: starterGitLabPipeline(relativeConfigDir, recipe, setup.runtimeImage),
        },
      ];
    case "azure-devops":
      return [
        {
          relativePath: "azure-devops.pipr.env.example",
          contents: starterAzureDevOpsWebhookEnvironment(recipe),
        },
        {
          relativePath: "azure-pipelines.pipr.yml",
          contents: starterAzureDevOpsPipeline(relativeConfigDir, recipe, setup.runtimeImage),
        },
      ];
    case "bitbucket":
      return [
        {
          relativePath: "bitbucket.pipr.env.example",
          contents: starterBitbucketWebhookEnvironment(recipe),
        },
        {
          relativePath: "bitbucket-pipelines.yml",
          contents: starterBitbucketPipeline(relativeConfigDir, recipe, setup.runtimeImage),
        },
      ];
    case "gitea":
      return [
        {
          relativePath: "gitea.pipr.env.example",
          contents: starterGiteaWebhookEnvironment("gitea", recipe),
        },
        {
          relativePath: path.join(".gitea", "workflows", "pipr.yml"),
          contents: starterGiteaActionsWorkflow("gitea", relativeConfigDir, recipe, setup),
        },
      ];
    case "forgejo":
    case "codeberg":
      return [
        {
          relativePath: `${adapter}.pipr.env.example`,
          contents: starterGiteaWebhookEnvironment(adapter, recipe),
        },
        {
          relativePath: path.join(".forgejo", "workflows", "pipr.yml"),
          contents: starterGiteaActionsWorkflow(adapter, relativeConfigDir, recipe, setup),
        },
      ];
  }
}

function starterGiteaActionsWorkflow(
  adapter: "gitea" | "forgejo" | "codeberg",
  relativeConfigDir: string,
  recipe: string | undefined,
  setup: {
    runtimeImage?: string;
    checkoutAction?: string;
    githubRunner?: string;
    githubEnterpriseServer?: boolean;
  },
): string {
  const tokenEnv = adapter === "gitea" ? "GITEA_TOKEN" : "FORGEJO_TOKEN";
  const lines = [
    "name: pipr",
    "",
    "on:",
    "  pull_request_target:",
    "    types: [opened, synchronize, reopened, ready_for_review]",
    "  issue_comment:",
    "    types: [created]",
    "",
    "jobs:",
    "  review:",
    "    runs-on: docker",
    "    steps:",
    `      - uses: ${setup.checkoutAction ?? "actions/checkout@v6"}`,
    "        with:",
    "          fetch-depth: 0",
    `      - uses: docker://${setup.runtimeImage ?? defaultGitLabImageRef}`,
    "        with:",
    `          args: host-run --host ${adapter} --config-dir ${relativeConfigDir}`,
    "        env:",
    `          ${tokenEnv}: ${workflowExpression(`secrets.${tokenEnv}`)}`,
    `          ${adapter === "gitea" ? "GITEA_API_URL" : adapter === "forgejo" ? "FORGEJO_API_URL" : "CODEBERG_API_URL"}: ${workflowExpression(`${adapter === "gitea" ? "gitea" : "forgejo"}.api_url`)}`,
    `          PIPR_RUN_AGE_RECIPIENTS: ${workflowExpression("vars.PIPR_RUN_AGE_RECIPIENTS")}`,
  ];
  for (const secret of officialInitRecipeWorkflowEnvSecrets(recipe)) {
    lines.push(`          ${secret.env}: ${workflowExpression(`secrets.${secret.secret}`)}`);
  }
  lines.push("");
  return lines.join("\n");
}

function starterGiteaWebhookEnvironment(
  adapter: "gitea" | "forgejo" | "codeberg",
  recipe?: string,
): string {
  const lines =
    adapter === "gitea"
      ? [
          "# Copy these names into the trusted webhook runner's secret store.",
          "GITEA_SERVER_URL=",
          "GITEA_TOKEN=",
          "PIPR_WEBHOOK_SECRET=",
        ]
      : [
          "# Copy these names into the trusted webhook runner's secret store.",
          `FORGEJO_SERVER_URL=${adapter === "codeberg" ? "https://codeberg.org" : ""}`,
          `${adapter === "codeberg" ? "CODEBERG_TOKEN" : "FORGEJO_TOKEN"}=`,
          "PIPR_WEBHOOK_SECRET=",
        ];
  for (const secret of officialInitRecipeWorkflowEnvSecrets(recipe)) lines.push(`${secret.env}=`);
  lines.push("");
  return lines.join("\n");
}

function workflowExpression(value: string): string {
  return `$${["{{ ", value, " }}"].join("")}`;
}

function starterGitLabWebhookEnvironment(recipe?: string): string {
  const lines = [
    "# Copy these names into the trusted webhook runner's secret store.",
    "GITLAB_API_URL=",
    "GITLAB_TOKEN=",
    "PIPR_WEBHOOK_SECRET=",
  ];
  for (const secret of officialInitRecipeWorkflowEnvSecrets(recipe)) lines.push(`${secret.env}=`);
  lines.push("");
  return lines.join("\n");
}

function starterGitLabPipeline(
  relativeConfigDir: string,
  recipe?: string,
  runtimeImage = defaultGitLabImageRef,
): string {
  const lines = [
    "pipr:",
    "  image:",
    `    name: '${runtimeImage}'`,
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
    "AZURE_DEVOPS_COLLECTION_URL=",
    "AZURE_DEVOPS_API_VERSION=7.1",
    "AZURE_DEVOPS_PROJECT=",
    "AZURE_DEVOPS_BEARER_TOKEN=",
    "AZURE_DEVOPS_TOKEN=",
    "PIPR_AZURE_SUBSCRIPTION_ID=",
    "PIPR_WEBHOOK_SECRET=",
  ];
  for (const secret of officialInitRecipeWorkflowEnvSecrets(recipe)) {
    lines.push(`${secret.env}=`);
  }
  lines.push("");
  return lines.join("\n");
}

function starterAzureDevOpsPipeline(
  relativeConfigDir: string,
  recipe?: string,
  runtimeImage = defaultGitLabImageRef,
): string {
  const secrets = officialInitRecipeWorkflowEnvSecrets(recipe);
  const lines = [
    "# Use only when this pipeline definition is immutable to pull request authors.",
    "trigger: none",
    "pr:",
    "  branches:",
    "    include:",
    "      - '*'",
    "# Azure DevOps Server: replace this hosted image with your self-hosted pool.",
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
    "        --env AZURE_DEVOPS_API_VERSION \\",
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
    `        '${runtimeImage}' \\`,
    `        host-run --host azure-devops --config-dir ${relativeConfigDir}`,
    "    displayName: Run Pipr",
    "    env:",
    "      SYSTEM_ACCESSTOKEN: $(System.AccessToken)",
  );
  for (const secret of secrets) {
    lines.push(`      ${secret.env}: $(${secret.env})`);
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
    "# Bitbucket Data Center only:",
    "BITBUCKET_BASE_URL=",
    "BITBUCKET_PROJECT_KEY=",
    "BITBUCKET_TOKEN=",
    "BITBUCKET_USER=",
    "BITBUCKET_PERMISSION_TOKEN=",
    "PIPR_WEBHOOK_SECRET=",
  ];
  for (const secret of officialInitRecipeWorkflowEnvSecrets(recipe)) lines.push(`${secret.env}=`);
  lines.push("");
  return lines.join("\n");
}

function starterBitbucketPipeline(
  relativeConfigDir: string,
  recipe?: string,
  runtimeImage = defaultGitLabImageRef,
): string {
  const lines = [
    "# Use only when repository variables are not exposed to untrusted pipeline changes.",
    "clone:",
    "  depth: full",
    "pipelines:",
    "  pull-requests:",
    "    '**':",
    "      - step:",
    "          name: Pipr review",
    `          image: '${runtimeImage}'`,
    "          script:",
    `            - pipr host-run --host bitbucket --config-dir ${relativeConfigDir}`,
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
