import { inspect } from "node:util";
import * as core from "@actions/core";
import {
  type RuntimeLogRecord,
  type RuntimeLogSink,
  runDryRunCommand,
  runHostRunCommand,
  runInitCommand,
  runInspectCommand,
  runLocalReviewCommand,
  runValidateCommand,
  supportedOfficialInitAdapters,
  supportedOfficialInitRecipes,
} from "@usepipr/runtime";
import { presentGitHubActionResult } from "@usepipr/runtime/internal/action-result";
import { Command, CommanderError } from "commander";
import cliPackage from "../package.json" with { type: "json" };
import { formatBundledSkill, materializeBundledSkill, resolveBundledSkill } from "./skills.js";
import {
  availablePiprUpdateNotice,
  resolveCurrentExecutablePath,
  runPiprUpdate,
} from "./update.js";

type CliOptions = {
  configDir: string;
  database?: string;
  host?: string;
  hostname?: string;
  port?: string;
  repository?: string;
  workspace?: string;
  event?: string;
  force?: boolean;
  adapters?: string;
  recipe?: string;
  minimal?: boolean;
  requireEnv?: boolean;
  base?: string;
  head?: string;
  piExecutable?: string;
  json?: boolean;
};

type MainOptions = {
  argv?: string[];
  env?: NodeJS.ProcessEnv;
  updateNoticeFetch?: typeof fetch;
  writeUpdateNotice?: (message: string) => void;
};

export async function runMain(options: MainOptions = {}): Promise<void> {
  const argv = options.argv ?? process.argv;
  const env = options.env ?? process.env;
  if (!isUpdateCommand(argv)) {
    await writeAvailableUpdateNotice(options);
  }
  const program = createProgram({ exitOverride: env.GITHUB_ACTIONS === "true" });
  try {
    if (argv.length <= 2) {
      program.outputHelp();
      return;
    }
    await program.parseAsync(argv);
  } catch (error) {
    if (error instanceof CommanderError && error.exitCode === 0) {
      return;
    }
    throw error;
  }
}

function createProgram(options: { exitOverride?: boolean } = {}): Command {
  const program = new Command();
  program.name("pipr").version(cliPackage.version).showHelpAfterError();
  if (options.exitOverride) {
    program.exitOverride();
  }
  program.addHelpText("after", agentHelpText);

  program
    .command("init")
    .description("Create editable TypeScript config")
    .option("--config-dir <dir>", "Config directory", ".pipr")
    .option(
      "--adapters <adapters>",
      `Adapters to initialize (${supportedOfficialInitAdapters.join(", ")}; use 'none' to skip adapter files)`,
    )
    .option("--recipe <recipe>", `Starter recipe (${supportedOfficialInitRecipes.join(", ")})`)
    .option("--minimal", "Scaffold a single-file .pipr/config.ts without package.json")
    .option("--force", "Overwrite existing pipr files")
    .action(runInit);

  program
    .command("host-run")
    .description("Run a change request event through a Code Host Adapter")
    .option("--host <host>", "Code host adapter")
    .option("--event <path>", "Native event payload path")
    .option("--config-dir <dir>", "Config directory", ".pipr")
    .action(runHostRun);

  const webhook = program.command("webhook").description("Run trusted webhook ingress");
  webhook
    .command("serve")
    .description("Serve one repository with a durable webhook queue")
    .requiredOption("--host <host>", "Code host adapter")
    .requiredOption("--workspace <path>", "Trusted repository workspace")
    .requiredOption("--repository <repository>", "Expected provider repository ID or path")
    .option("--database <path>", "SQLite delivery database", ".pipr/webhooks.sqlite")
    .option("--hostname <hostname>", "Listen hostname", "127.0.0.1")
    .option("--port <port>", "Listen port", "8787")
    .option("--config-dir <dir>", "Config directory", ".pipr")
    .action(runWebhookServe);

  program
    .command("check")
    .description("Type-load config and validate the runtime plan")
    .option("--config-dir <dir>", "Config directory", ".pipr")
    .option("--require-env", "Require configured provider env vars")
    .action(runCheck);

  program
    .command("dry-run")
    .description("Load config and event without publishing")
    .requiredOption("--event <path>", "Native event payload path")
    .option("--host <host>", "Code host adapter")
    .option("--config-dir <dir>", "Config directory", ".pipr")
    .action(runDryRun);

  program
    .command("inspect")
    .description("Print models, agents, tasks, commands, and tools")
    .option("--config-dir <dir>", "Config directory", ".pipr")
    .action(runInspect);

  program
    .command("review")
    .description("Run configured change-request review tasks locally without publishing")
    .requiredOption("--base <sha>", "Base commit SHA")
    .option("--head <sha>", "Head commit SHA or ref; omitted reviews the working tree")
    .option("--config-dir <dir>", "Config directory", ".pipr")
    .option("--pi-executable <path>", "Pi executable path")
    .option("--json", "Print structured JSON output")
    .action(runLocalReview);

  program.command("version").description("Print the CLI version").action(runVersion);

  program.command("update").description("Update a GitHub Release binary install").action(runUpdate);

  const skill = program
    .command("skill")
    .description("Print the bundled Pipr setup skill")
    .action(runSkillGet);
  skill
    .command("path")
    .description("Materialize the bundled Pipr setup skill and print its directory path")
    .action(runSkillPath);

  return program;
}

const agentHelpText = `

Start here (for AI agents):
  pipr skill

The Pipr setup skill ships with the CLI and is version-matched to this release.
Prefer it over guessing commands or config shape from memory.

  skill       Print the bundled setup skill and references
  skill path  Materialize the setup skill and print its directory path
`;

async function runHostRun(options: CliOptions): Promise<void> {
  const env = process.env;
  const isGitHubAction = env.GITHUB_ACTIONS === "true";
  const result = await runHostRunCommand({
    rootDir: hostRunRootDir(env),
    configDir: options.configDir,
    host: options.host,
    eventPath: options.event ?? env.PIPR_EVENT_PATH ?? env.GITHUB_EVENT_PATH,
    env,
    dryRun: env.PIPR_DRY_RUN === "1",
    logSink: isGitHubAction ? githubActionsLogSink : localConsoleLogSink,
  });
  if (isGitHubAction) {
    await presentGitHubActionResult(result, {
      info: core.info,
      warning: core.warning,
      setOutput(name, value) {
        core.setOutput(name, value);
      },
    });
    return;
  }
  if (result.kind === "ignored") {
    console.log(`ignored: ${result.reason}`);
    return;
  }
  console.log(`pipr ${result.kind} completed for change #${result.event.change.number}`);
}

function hostRunRootDir(env: NodeJS.ProcessEnv): string {
  return (
    env.GITHUB_WORKSPACE ??
    env.CI_PROJECT_DIR ??
    env.BITBUCKET_CLONE_DIR ??
    env.BUILD_SOURCESDIRECTORY ??
    process.cwd()
  );
}

async function runWebhookServe(options: CliOptions): Promise<void> {
  const { runWebhookServer } = await import("@usepipr/runtime");
  const secret = process.env.PIPR_WEBHOOK_SECRET;
  if (!secret) throw new Error("PIPR_WEBHOOK_SECRET is required");
  const host = webhookHost(options.host);
  const port = webhookPort(options.port);
  await runWebhookServer({
    host,
    workspace: options.workspace ?? process.cwd(),
    configDir: options.configDir,
    databasePath: options.database ?? ".pipr/webhooks.sqlite",
    expectedRepository: options.repository ?? "",
    secret,
    hostname: options.hostname,
    port,
    env: process.env,
  });
}

function webhookHost(value: string | undefined): "gitlab" | "azure-devops" | "bitbucket" {
  if (value === "gitlab" || value === "azure-devops" || value === "bitbucket") return value;
  throw new Error("webhook serve supports --host gitlab, azure-devops, or bitbucket");
}

function webhookPort(value: string | undefined): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("--port must be an integer from 1 to 65535");
  }
  return port;
}

const githubActionsLogSink: RuntimeLogSink = {
  log(record) {
    const line = JSON.stringify({
      level: record.level,
      event: record.event,
      ...record.fields,
    });
    githubActionLogWriters[record.level](
      record.text === undefined ? line : `${line}\n${record.text}`,
    );
  },
  async group(name, run) {
    return await core.group(name, run);
  },
};

const githubActionLogWriters = {
  info: core.info,
  notice: core.notice,
  warning: core.warning,
  error: core.error,
  debug: core.debug,
} satisfies Record<RuntimeLogRecord["level"], (message: string) => void>;

async function runInit(options: CliOptions): Promise<void> {
  const result = await runInitCommand({
    rootDir: process.cwd(),
    configDir: options.configDir,
    force: options.force === true,
    adapters: options.adapters?.split(",").map((adapter) => adapter.trim()),
    recipe: options.recipe,
    minimal: options.minimal === true,
  });
  console.log(
    `created ${result.created.length} file(s)` +
      (result.overwritten.length > 0 ? `; overwrote ${result.overwritten.length}` : ""),
  );
  if (options.minimal === true) {
    console.log(
      "For editor types, install @usepipr/sdk at the repo root: npm install -D @usepipr/sdk",
    );
  }
}

async function runCheck(options: CliOptions): Promise<void> {
  const settings = await runValidateCommand({
    rootDir: process.cwd(),
    configDir: options.configDir,
    env: process.env,
    requireProviderEnv: options.requireEnv === true,
  });
  console.log(`valid: ${settings.source}`);
  writeConfigWarnings(settings.warnings);
}

async function runInspect(options: CliOptions): Promise<void> {
  const result = await runInspectCommand({
    rootDir: process.cwd(),
    configDir: options.configDir,
    env: process.env,
  });
  const { warnings, ...plan } = result;
  writeConfigWarnings(warnings);
  console.log(inspect(plan, { depth: 8, colors: false }));
}

function writeConfigWarnings(warnings: readonly string[]): void {
  for (const warning of warnings) {
    console.log(`warning: ${warning}`);
  }
}

async function runSkillGet(): Promise<void> {
  console.log(formatBundledSkill(await resolveBundledSkill()));
}

async function runSkillPath(): Promise<void> {
  console.log(await materializeBundledSkill());
}

function runVersion(): void {
  console.log(cliPackage.version);
}

async function runUpdate(): Promise<void> {
  const result = await runPiprUpdate({
    currentVersion: cliPackage.version,
    executablePath: resolveCurrentExecutablePath(),
  });
  if (result.kind === "up-to-date") {
    console.log(`pipr ${result.version} is already up to date`);
    return;
  }
  console.log(`updated pipr from ${result.previousVersion} to ${result.version}`);
}

async function writeAvailableUpdateNotice(options: MainOptions): Promise<void> {
  const env = options.env ?? process.env;
  if (shouldSkipUpdateNotice(env)) {
    return;
  }
  try {
    const notice = await availablePiprUpdateNotice({
      currentVersion: cliPackage.version,
      fetch: options.updateNoticeFetch,
      timeoutMs: 750,
    });
    if (notice) {
      (options.writeUpdateNotice ?? console.error)(
        `pipr ${notice.latestVersion} is available (current ${notice.currentVersion}). ` +
          "Run `pipr update` for release binaries, or reinstall @usepipr/cli with npm/Bun.",
      );
    }
  } catch {
    return;
  }
}

function shouldSkipUpdateNotice(env: NodeJS.ProcessEnv): boolean {
  if (env.PIPR_UPDATE_NOTICE === "0") {
    return true;
  }
  if (env.PIPR_UPDATE_NOTICE === "1") {
    return false;
  }

  const ci = env.CI?.trim().toLowerCase();
  return (
    (ci !== undefined && ci !== "" && ci !== "0" && ci !== "false") ||
    env.GITHUB_ACTIONS !== undefined
  );
}

function isUpdateCommand(argv: string[]): boolean {
  const args = argv.slice(2);
  if (args[0] === "--") {
    return args[1] === "update";
  }
  return (
    args[0] === "update" ||
    (args.length >= 2 && args[0] === "help" && args[1] === "update") ||
    (args.length >= 2 && args[0] === "--help" && args[1] === "update")
  );
}

async function runLocalReview(options: CliOptions & { base: string }): Promise<void> {
  const result = await runLocalReviewCommand({
    rootDir: process.cwd(),
    configDir: options.configDir,
    env: process.env,
    baseSha: options.base,
    headSha: options.head,
    piExecutable: options.piExecutable,
    logSink: localConsoleLogSink,
    taskLog: stderrTaskLog,
  });
  writeLocalReviewResult(result, options.json === true);
}

type LocalReviewResult = Awaited<ReturnType<typeof runLocalReviewCommand>>;

const stderrTaskLog = {
  info(message: string) {
    console.error(`[info] ${message}`);
  },
  warn(message: string) {
    console.error(`[warn] ${message}`);
  },
  error(message: string) {
    console.error(`[error] ${message}`);
  },
};

const localConsoleLogSink: RuntimeLogSink = {
  log(record) {
    console.error(formatLocalLogRecord(record));
  },
  async group(_name, run) {
    return await run();
  },
};

function formatLocalLogRecord(record: RuntimeLogRecord): string {
  const fields = Object.entries(record.fields)
    .map(([key, value]) => formatLocalLogField(key, value))
    .filter((field): field is string => field !== undefined);
  const prefix = formatLocalLogPrefix(record);
  const formatted = [...prefix, ...fields].join(" ");
  return record.text === undefined ? formatted : `${formatted}\n${record.text}`;
}

function formatLocalLogPrefix(record: RuntimeLogRecord): string[] {
  return ["pipr", localLogPlainLevels.has(record.level) ? "" : record.level, record.event].filter(
    Boolean,
  );
}

const localLogNumberFields: Record<string, (value: number) => string> = {
  additions: (value) => `+${value}`,
  deletions: (value) => `-${value}`,
  durationMs: (value) =>
    `duration=${value < 1000 ? `${value}ms` : `${(value / 1000).toFixed(1)}s`}`,
  promptBytes: (value) => `prompt=${value}B`,
  stderrBytes: (value) => `stderr=${value}B`,
  stdoutBytes: (value) => `stdout=${value}B`,
};

const localLogPlainLevels = new Set(["info", "notice"]);

function formatLocalLogField(key: string, value: unknown): string | undefined {
  if (value == null) {
    return undefined;
  }

  return formatLocalLogFieldValue(key, value);
}

function formatLocalLogFieldValue(key: string, value: unknown): string {
  const formattedNumber =
    typeof value === "number" ? localLogNumberFields[key]?.(value) : undefined;
  return formattedNumber ?? `${key}=${formatLocalLogValue(value)}`;
}

const localLogValueFormatters: Record<string, (value: unknown) => string> = {
  boolean: String,
  number: String,
  object: (value) =>
    Array.isArray(value)
      ? value.length === 0
        ? "-"
        : value.map(formatLocalLogValue).join(",")
      : JSON.stringify(value),
  string: (value) => {
    const text = String(value);
    return /\s/.test(text) ? JSON.stringify(text) : text;
  },
};

function formatLocalLogValue(value: unknown): string {
  return (localLogValueFormatters[typeof value] ?? JSON.stringify)(value);
}

function writeLocalReviewResult(result: LocalReviewResult, json: boolean): void {
  if (json) {
    console.log(JSON.stringify(localReviewJson(result), null, 2));
    return;
  }
  if (result.kind === "skipped") {
    console.log(`skipped: ${result.skipReason ?? "no task matched"}`);
    return;
  }
  console.log(formatLocalReview(result));
}

function formatLocalReview(result: Extract<LocalReviewResult, { kind: "review" }>): string {
  const mainComment = result.mainComment
    .split("\n")
    .filter((line) => !line.startsWith("<!-- pipr:main-comment "))
    .join("\n")
    .trimStart();
  const inlineFindings = result.inlineCommentDrafts.map((draft, index) => {
    const range =
      draft.startLine === draft.endLine
        ? `${draft.path}:${draft.startLine}`
        : `${draft.path}:${draft.startLine}-${draft.endLine}`;
    return [
      `${index + 1}. ${range}`,
      `Range: ${draft.finding.rangeId ?? "-"}`,
      draft.finding.body,
    ].join("\n");
  });
  return inlineFindings.length === 0
    ? mainComment
    : [mainComment.trimEnd(), "", "## Inline Findings", "", inlineFindings.join("\n\n")].join("\n");
}

function localReviewJson(result: LocalReviewResult) {
  return {
    kind: result.kind,
    ...(result.kind === "skipped" ? { skipReason: result.skipReason } : {}),
    mainComment: result.mainComment,
    inlineFindings: result.inlineCommentDrafts,
    droppedFindings: result.validated.droppedFindings,
    taskChecks: result.taskChecks,
    provider: result.provider,
    providerModels: result.publicationPlan.metadata.providerModels ?? [result.provider.model],
    repairAttempted: result.repairAttempted,
  };
}

async function runDryRun(options: CliOptions): Promise<void> {
  if (!options.event) {
    throw new Error("dry-run requires --event <path>");
  }
  const result = await runDryRunCommand({
    rootDir: process.cwd(),
    configDir: options.configDir,
    host: options.host,
    env: process.env,
    eventPath: options.event,
  });
  writeConfigWarnings(result.warnings);
  console.log(
    inspect(
      {
        configSource: result.configSource,
        event: result.event,
      },
      { depth: 6, colors: false },
    ),
  );
}
