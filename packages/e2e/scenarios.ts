import { dirname, join } from "node:path";

export type ScenarioName = "dry-run" | "full" | "condensed" | "orchestrator";
export type ScenarioAssertion = "full" | "condensed" | "orchestrator";

export type Scenario = {
  name: ScenarioName;
  title: string;
  workflowFile: string;
  eventFile: string;
  publicationFixture?: string;
  assertion?: ScenarioAssertion;
  config?: string;
  configPackage?: {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  baseSample?: string;
  headPath: string;
  headContent: string;
  telemetryDir?: string;
};

export type PreparedScenario = {
  scenario: Scenario;
  tmpRoot: string;
  worktree: string;
  baseSha: string;
  headSha: string;
  cleanup: () => void;
};

type PrepareScenarioOptions = {
  beforeBaseCommit?: (context: { scenario: Scenario; worktree: string }) => Promise<void> | void;
  forceAddBasePaths?: string[];
};

type TrackedChange = {
  status: string;
  firstPath: string;
  secondPath?: string;
};

export const scenarioNames = ["dry-run", "full", "condensed", "orchestrator"] as const;
const packageRootPath = "packages/e2e";
export const fixtureRootPath = `${packageRootPath}/fixtures/act`;
export const actionFixtureScript = `${packageRootPath}/action-fixture.ts`;
export const fakePiScript = `${packageRootPath}/fake-pi`;
export const sourceRoot = gitOutput(process.cwd(), ["rev-parse", "--show-toplevel"]).trim();

const fullConfig = `import { definePipr } from "@usepipr/sdk";

export default definePipr((pipr) => {
  const model = pipr.model({
    provider: "deepseek",
    model: "deepseek-v4-pro",
    apiKey: pipr.secret({ name: "DEEPSEEK_API_KEY" }),
    options: { thinking: "high" },
  });
  const reviewer = pipr.agent({
    name: "review",
    model,
    instructions: "Review the act fixture change.",
    output: pipr.schemas.review,
    tools: pipr.tools.readOnly,
    prompt: () => "Review this change.",
  });
  const sourcePaths = {
    include: ["packages/e2e/fixtures/act/project/**"],
    exclude: ["**/*.test.ts"],
  };
  const task = pipr.task({
    name: "pipr/review",
    async run(ctx) {
      const manifest = await ctx.change.diffManifest({ compressed: true, paths: sourcePaths });
      const [review, duplicate] = await Promise.all([
        ctx.pi.run(reviewer, { manifest }, { paths: sourcePaths }),
        ctx.pi.run(reviewer, { manifest }, { paths: sourcePaths }),
      ]);
      await ctx.comment({
        main: [
          "Full fixture secondary section",
          "",
          review.summary.body,
        ].join("\\n"),
        inlineFindings: [...review.inlineFindings, ...duplicate.inlineFindings],
      });
    },
  });
  pipr.on.changeRequest({ actions: ["opened"], task });
});
`;

const condensedConfig = `import { definePipr } from "@usepipr/sdk";

export default definePipr((pipr) => {
  const model = pipr.model({
    provider: "deepseek",
    model: "deepseek-v4-pro",
    apiKey: pipr.secret({ name: "DEEPSEEK_API_KEY" }),
    options: { thinking: "high" },
  });
  pipr.config({
    publication: { maxInlineComments: 5 },
    limits: {
      timeoutSeconds: 300,
      diffManifest: {
        fullMaxBytes: 1,
        fullMaxEstimatedTokens: 1,
        condensedMaxBytes: 262144,
        condensedMaxEstimatedTokens: 65536,
        toolResponseMaxBytes: 4096,
      },
    },
  });
  pipr.review({
    id: "review",
    model,
    instructions: "Review the condensed act fixture.",
  });
});
`;

const orchestratorConfig = `import { definePipr, z } from "@usepipr/sdk";

export default definePipr((pipr) => {
  const model = pipr.model({
    provider: "deepseek",
    model: "deepseek-v4-pro",
    apiKey: pipr.secret({ name: "DEEPSEEK_API_KEY" }),
    options: { thinking: "high" },
  });
  const specialistOutput = pipr.schema({
    id: "fixture/specialist-output",
    schema: z.strictObject({
      focus: z.enum(["correctness", "security", "tests"]),
      summary: z.string(),
    }),
  });
  const findingSchema = z.strictObject({
    body: z.string(),
    path: z.string(),
    rangeId: z.string(),
    side: z.enum(["RIGHT", "LEFT"]),
    startLine: z.number().int().positive(),
    endLine: z.number().int().positive(),
    severity: z.enum(["critical", "high", "medium", "low", "nit"]),
    suggestedFix: z.string().optional(),
  });
  const orchestratorOutput = pipr.schema({
    id: "fixture/orchestrator-output",
    schema: z.strictObject({
      summary: z.strictObject({
        title: z.string().optional(),
        body: z.string(),
      }),
      findings: z.array(findingSchema),
    }),
  });
  const specialist = pipr.agent({
    name: "specialist-reviewer",
    model,
    instructions: "Return a focused specialist review.",
    output: specialistOutput,
    prompt: (input) => pipr.prompt\`Focus: \${input.focus}\`,
  });
  const orchestrator = pipr.agent({
    name: "review-orchestrator",
    model,
    instructions: "Merge specialist reviews into one final review.",
    output: orchestratorOutput,
    prompt: (input) => pipr.prompt\`Manifest:\\n\${pipr.json(input.manifest)}\\n\\nSpecialist reviews:\\n\${pipr.json(input.reviews)}\`,
  });
  const task = pipr.task({
    name: "review",
    async run(ctx) {
      const manifest = await ctx.change.diffManifest({ compressed: true });
      const [correctness, security, tests] = await Promise.all([
        ctx.pi.run(specialist, { manifest, focus: "correctness" }),
        ctx.pi.run(specialist, { manifest, focus: "security" }),
        ctx.pi.run(specialist, { manifest, focus: "tests" }),
      ]);
      const result = await ctx.pi.run(orchestrator, {
        manifest,
        reviews: { correctness, security, tests },
      });
      const inlineFindings = result.findings.map(({ severity, ...finding }) => ({
        ...finding,
        body: \`Severity: \${severity}\\n\\n\${finding.body}\`,
      }));
      const grouped = Map.groupBy(result.findings, (finding) => finding.severity);
      const labels = result.findings.length === 0
        ? "No labeled findings."
        : ["critical", "high", "medium", "low", "nit"]
            .flatMap((severity) => {
              const findings = grouped.get(severity) ?? [];
              return findings.length === 0
                ? []
                : [\`### \${severity}\`, "", ...findings.map((finding) => \`- \${finding.body}\`), ""];
            })
            .join("\\n");
      await ctx.comment({
        main: \`\${result.summary.body}\\n\\n## Custom labels\\n\\n\${labels}\`,
        inlineFindings,
      });
    },
  });
  pipr.on.changeRequest({ actions: ["opened"], task });
});
`;

const dryRunConfig = `import { definePipr } from "@usepipr/sdk";
import { chunk } from "lodash-es";

export default definePipr((pipr) => {
  void chunk;
  const model = pipr.model({
    provider: "deepseek",
    model: "deepseek-v4-pro",
    apiKey: pipr.secret({ name: "DEEPSEEK_API_KEY" }),
  });
  pipr.review({
    id: "review",
    model,
    instructions: "Review the act fixture change.",
  });
});
`;

export const scenarios: Record<ScenarioName, Scenario> = {
  "dry-run": {
    name: "dry-run",
    title: "pipr local fixture",
    workflowFile: "pipr-local.yml",
    eventFile: `${fixtureRootPath}/pull_request.json`,
    config: dryRunConfig,
    configPackage: {
      dependencies: {
        "@usepipr/sdk": "0.1.3",
        "lodash-es": "4.17.23",
      },
      devDependencies: {
        "@types/bun": "1.3.14",
      },
    },
    baseSample: "dry-run base fixture\n",
    headPath: `${fixtureRootPath}/dry-run-head.txt`,
    headContent: "dry-run head fixture\n",
  },
  full: {
    name: "full",
    title: "pipr local full-flow fixture",
    workflowFile: "pipr-local-full.yml",
    eventFile: `${fixtureRootPath}/pull_request_full.json`,
    publicationFixture: "github-publication-full.json",
    assertion: "full",
    config: fullConfig,
    baseSample: `export function reviewTarget(value: string): string {
  return value.trim();
}
`,
    headPath: `${fixtureRootPath}/project/sample.ts`,
    headContent: `export function reviewTarget(value: string): string {
  const normalized = value.trim();
  return normalized || "fallback";
}
`,
    telemetryDir: "pi-calls-full",
  },
  condensed: {
    name: "condensed",
    title: "pipr local condensed-flow fixture",
    workflowFile: "pipr-local-condensed.yml",
    eventFile: `${fixtureRootPath}/pull_request_condensed.json`,
    publicationFixture: "github-publication-condensed.json",
    assertion: "condensed",
    config: condensedConfig,
    baseSample: `export function reviewTarget(value: string): string {
  const legacy = value.toLowerCase();
  return legacy.trim();
}
`,
    headPath: `${fixtureRootPath}/project/sample.ts`,
    headContent: `export function reviewTarget(value: string): string {
  const normalized = value.trim();
  return normalized || "fallback";
}
`,
  },
  orchestrator: {
    name: "orchestrator",
    title: "pipr local orchestrator fixture",
    workflowFile: "pipr-local-orchestrator.yml",
    eventFile: `${fixtureRootPath}/pull_request_orchestrator.json`,
    publicationFixture: "github-publication-orchestrator.json",
    assertion: "orchestrator",
    config: orchestratorConfig,
    baseSample: `export function reviewTarget(value: string): string {
  return value.trim();
}
`,
    headPath: `${fixtureRootPath}/project/sample.ts`,
    headContent: `export function reviewTarget(value: string): string {
  const normalized = value.trim();
  return normalized || "fallback";
}
`,
  },
};

export async function prepareScenarioWorktree(
  scenario: Scenario,
  options: PrepareScenarioOptions = {},
): Promise<PreparedScenario> {
  const tmpRoot = mktemp(`pipr-e2e-${scenario.name}`);
  const worktree = join(tmpRoot, "worktree");
  try {
    await initializeScenarioWorktree(worktree, scenario, options);
    const baseSha = await commitScenarioBase(worktree, scenario, options);
    const headSha = await commitScenarioHead(worktree, scenario);
    await writePullRequestEvent(worktree, scenario, baseSha, headSha);

    return {
      scenario,
      tmpRoot,
      worktree,
      baseSha,
      headSha,
      cleanup: () => removePath(tmpRoot),
    };
  } catch (error) {
    removePath(tmpRoot);
    throw error;
  }
}

async function initializeScenarioWorktree(
  worktree: string,
  scenario: Scenario,
  options: PrepareScenarioOptions,
): Promise<void> {
  run("git", ["clone", "--no-hardlinks", "--quiet", sourceRoot, worktree], sourceRoot);
  git(worktree, ["config", "user.email", "pipr-act@example.invalid"]);
  git(worktree, ["config", "user.name", "pipr act fixture"]);
  git(worktree, ["config", "commit.gpgsign", "false"]);
  git(worktree, ["config", "gc.auto", "0"]);
  git(worktree, ["config", "maintenance.auto", "false"]);
  await overlayTrackedChanges(worktree);
  await copySourcePath(worktree, packageRootPath);
  await options.beforeBaseCommit?.({ scenario, worktree });
  run("chmod", ["755", join(worktree, fakePiScript)], sourceRoot);
}

async function commitScenarioBase(
  worktree: string,
  scenario: Scenario,
  options: PrepareScenarioOptions,
): Promise<string> {
  await writeScenarioConfig(worktree, scenario);
  await writeScenarioBaseSample(worktree, scenario);
  forceAddBasePaths(worktree, options.forceAddBasePaths ?? []);
  git(worktree, ["add", "-A"]);
  git(worktree, ["commit", "-m", `test: prepare ${scenario.name} e2e fixture base`]);
  return gitOutput(worktree, ["rev-parse", "HEAD"]).trim();
}

async function writeScenarioConfig(worktree: string, scenario: Scenario): Promise<void> {
  if (scenario.config) {
    await writeWorktreeFile(worktree, ".pipr/config.ts", scenario.config);
  }
  if (scenario.configPackage) {
    await writeWorktreeFile(
      worktree,
      ".pipr/package.json",
      `${JSON.stringify({ private: true, ...scenario.configPackage }, null, 2)}\n`,
    );
    await writeWorktreeFile(worktree, ".pipr/tsconfig.json", `${starterTsconfig}\n`);
    const install = Bun.spawn(["bun", "install", "--ignore-scripts"], {
      cwd: join(worktree, ".pipr"),
      env: Bun.env,
      stdout: "pipe",
      stderr: "pipe",
    });
    const exitCode = await install.exited;
    if (exitCode !== 0) {
      throw new Error(
        `failed to install .pipr dependencies for ${scenario.name}: ${await new Response(install.stderr).text()}`,
      );
    }
  }
}

const starterTsconfig = `{
  "compilerOptions": {
    "strict": true,
    "noEmit": true,
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler"
  },
  "include": ["./**/*.ts"]
}`;

async function writeScenarioBaseSample(worktree: string, scenario: Scenario): Promise<void> {
  if (scenario.baseSample) {
    await writeWorktreeFile(worktree, scenario.headPath, scenario.baseSample);
  }
}

function forceAddBasePaths(worktree: string, paths: string[]): void {
  for (const path of paths) {
    git(worktree, ["add", "-f", path]);
  }
}

async function commitScenarioHead(worktree: string, scenario: Scenario): Promise<string> {
  await writeWorktreeFile(worktree, scenario.headPath, scenario.headContent);
  git(worktree, ["add", "-A"]);
  git(worktree, ["commit", "-m", `test: prepare ${scenario.name} e2e fixture head`]);
  return gitOutput(worktree, ["rev-parse", "HEAD"]).trim();
}

export function scenarioFromName(name: string | undefined): Scenario | undefined {
  return name && isScenarioName(name) ? scenarios[name] : undefined;
}

export function envValue(name: string): string | undefined {
  const value = Bun.env[name];
  return value ? value : undefined;
}

export async function writeWorktreeFile(
  worktree: string,
  relativePath: string,
  content: string,
): Promise<void> {
  const target = join(worktree, relativePath);
  run("mkdir", ["-p", dirname(target)], sourceRoot);
  await Bun.write(target, content);
}

export function run(command: string, args: string[], cwd: string): void {
  const result = Bun.spawnSync([command, ...args], {
    cwd,
    env: Bun.env,
    stderr: "inherit",
    stdout: "inherit",
  });
  if (result.exitCode !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed with exit ${result.exitCode}`);
  }
}

export function runOutput(
  command: string,
  args: string[],
  cwd: string,
): { stdout: string; stderr: string } {
  const result = Bun.spawnSync([command, ...args], {
    cwd,
    env: Bun.env,
    stderr: "pipe",
    stdout: "pipe",
  });
  const stdout = result.stdout.toString();
  const stderr = result.stderr.toString();
  if (result.exitCode !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed with exit ${result.exitCode}\n${stdout}${stderr}`,
    );
  }
  return { stdout, stderr };
}

function isScenarioName(name: string): name is ScenarioName {
  return scenarioNames.includes(name as ScenarioName);
}

async function overlayTrackedChanges(worktree: string): Promise<void> {
  for (const change of trackedChanges()) {
    await overlayTrackedChange(worktree, change);
  }
}

function trackedChanges(): TrackedChange[] {
  const changes = gitOutput(sourceRoot, ["diff", "--name-status", "HEAD", "--"]).trim();
  return changes ? changes.split("\n").map(parseTrackedChange) : [];
}

function parseTrackedChange(line: string): TrackedChange {
  const [status, firstPath, secondPath] = line.split("\t");
  if (!status || !firstPath) {
    throw new Error(`Unexpected git diff --name-status line '${line}'`);
  }
  return { status, firstPath, secondPath };
}

async function overlayTrackedChange(worktree: string, change: TrackedChange): Promise<void> {
  if (change.status === "D") {
    removePath(join(worktree, change.firstPath));
    return;
  }
  if (change.status.startsWith("R")) {
    removePath(join(worktree, change.firstPath));
    await copySourcePath(worktree, renamedPath(change));
    return;
  }
  await copySourcePath(worktree, change.firstPath);
}

function renamedPath(change: TrackedChange): string {
  if (!change.secondPath) {
    throw new Error(`Rename diff for '${change.firstPath}' is missing destination path`);
  }
  return change.secondPath;
}

async function copySourcePath(worktree: string, relativePath: string): Promise<void> {
  const source = join(sourceRoot, relativePath);
  if (!pathExists(source)) {
    return;
  }
  const target = join(worktree, relativePath);
  run("mkdir", ["-p", dirname(target)], sourceRoot);
  removePath(target);
  run("cp", ["-pR", source, target], sourceRoot);
}

async function writePullRequestEvent(
  worktree: string,
  scenario: Scenario,
  baseSha: string,
  headSha: string,
): Promise<void> {
  await writeWorktreeFile(
    worktree,
    scenario.eventFile,
    `${JSON.stringify(
      {
        action: "opened",
        number: 1,
        pull_request: {
          number: 1,
          base: { sha: baseSha, ref: "main", repo: { full_name: "local/pipr" } },
          head: { sha: headSha, ref: "feature", repo: { full_name: "local/pipr" } },
        },
        repository: { full_name: "local/pipr" },
      },
      null,
      2,
    )}\n`,
  );
}

function git(cwd: string, args: string[]): void {
  run("git", args, cwd);
}

function gitOutput(cwd: string, args: string[]): string {
  const result = Bun.spawnSync(["git", ...args], {
    cwd,
    stderr: "pipe",
    stdout: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed with exit ${result.exitCode}`);
  }
  return result.stdout.toString();
}

function removePath(targetPath: string): void {
  let failure = "";
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const result = Bun.spawnSync(["rm", "-rf", targetPath], {
      cwd: sourceRoot,
      env: Bun.env,
      stderr: "pipe",
      stdout: "pipe",
    });
    if (result.exitCode === 0 || !pathExists(targetPath)) {
      return;
    }
    failure = result.stderr.toString().trim() || result.stdout.toString().trim();
    sleepSync(50);
  }
  throw new Error(`rm -rf ${targetPath} failed${failure ? `: ${failure}` : ""}`);
}

function sleepSync(milliseconds: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function pathExists(path: string): boolean {
  return (
    Bun.spawnSync(["test", "-e", path], {
      stderr: "ignore",
      stdout: "ignore",
    }).exitCode === 0
  );
}

function mktemp(prefix: string): string {
  const result = Bun.spawnSync(["mktemp", "-d", `/tmp/${prefix}.XXXXXX`], {
    stderr: "pipe",
    stdout: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(`mktemp failed with exit ${result.exitCode}`);
  }
  return result.stdout.toString().trim();
}
