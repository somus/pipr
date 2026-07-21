import path from "node:path";
import { inspect } from "node:util";
import * as core from "@actions/core";
import {
  type HostRunCommandOptions,
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
  uploadBitbucketRunBundle,
} from "@usepipr/runtime";
import { presentGitHubActionResult } from "@usepipr/runtime/internal/action-result";
import { stripPiprMainCommentMarkers, toPiprResult } from "@usepipr/runtime/internal/pipr-result";
import { Command, CommanderError } from "commander";
import cliPackage from "../package.json" with { type: "json" };
import {
  defaultLocalTraceStore,
  type RunsDownloadOptions,
  type RunsListOptions,
  type RunsShowOptions,
  runRunsDownload,
  runRunsList,
  runRunsShow,
} from "./runs.js";
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
  limit?: string;
  trace?: string | boolean;
  runStoreDir?: string;
  runRetentionDays?: string;
  runMaxBytes?: string;
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
  const program = createProgram({ exitOverride: env.GITHUB_ACTIONS === "true", env });
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

function createProgram(options: { exitOverride?: boolean; env?: NodeJS.ProcessEnv } = {}): Command {
  const program = new Command();
  const env = options.env ?? process.env;
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
    .option("--run-store-dir <path>", "Diagnostic run store")
    .option("--run-retention-days <days>", "Completed run retention")
    .option("--run-max-bytes <bytes>", "Maximum webhook run store bytes")
    .action(runWebhookServe);
  webhook
    .command("status")
    .description("Show recent webhook delivery outcomes")
    .option("--database <path>", "SQLite delivery database", ".pipr/webhooks.sqlite")
    .option("--limit <count>", "Maximum deliveries to show", "20")
    .option("--json", "Print versioned JSON")
    .action(runWebhookStatus);

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
    .option("--trace [path]", "Capture a diagnostic run bundle")
    .option("--json", "Print structured JSON output")
    .action(runLocalReview);

  const runs = program.command("runs").description("Inspect captured Pipr runs");
  runs
    .command("list")
    .description("List runs for a pull or merge request")
    .requiredOption("--pr <number|URL>", "Pull or merge request number or URL")
    .option("--host <host>", "Code host")
    .option("--repository <repository>", "Provider repository path")
    .option("--kind <kind>", "Run kind (review, command, verifier, startup, or all)", "all")
    .option("--status <status>", "Run outcome or artifact state")
    .option("--limit <count>", "Maximum runs", "20")
    .option("--json", "Print versioned JSON")
    .option("--store <path>", "Local run store")
    .action(async (runOptions: RunsListOptions) => {
      await runRunsList(runOptions, { env, cwd: process.cwd() });
    });
  runs
    .command("show")
    .description("Diagnose one captured run")
    .argument("[execution-id]", "Run execution ID")
    .option("--pr <number|URL>", "Select the latest completed run for a PR")
    .option("--host <host>", "Code host")
    .option("--repository <repository>", "Provider repository path")
    .option("--kind <kind>", "Run kind (review, command, verifier, startup, or all)")
    .option("--timeline", "Print the complete span timeline")
    .option("--json", "Print versioned JSON without prompt or output bodies")
    .option("--store <path>", "Local run store")
    .action(async (executionId: string | undefined, runOptions: RunsShowOptions) => {
      await runRunsShow(executionId, runOptions, { env, cwd: process.cwd() });
    });
  runs
    .command("download")
    .description("Download and validate a run bundle")
    .argument("<execution-id>", "Run execution ID")
    .option("--host <host>", "Code host")
    .option("--repository <repository>", "Provider repository path")
    .option("--output <path>", "Destination directory")
    .option("--archive", "Preserve the provider archive beside the unpacked bundle")
    .option("--store <path>", "Local run store")
    .action(async (executionId: string, runOptions: RunsDownloadOptions) => {
      await runRunsDownload(executionId, runOptions, { env, cwd: process.cwd() });
    });

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
  const rootDir = hostRunRootDir(env);
  const result = await runHostRunCommand({
    rootDir,
    configDir: options.configDir,
    host: options.host,
    eventPath: options.event ?? env.PIPR_EVENT_PATH ?? env.GITHUB_EVENT_PATH,
    env,
    dryRun: env.PIPR_DRY_RUN === "1",
    logSink: isGitHubAction ? githubActionsLogSink : localConsoleLogSink,
    onRunBundleFinalized: async (bundle) => {
      await publishRunBundleMetadata(bundle, { env, rootDir });
    },
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

export async function publishRunBundleMetadata(
  bundle: Parameters<NonNullable<HostRunCommandOptions["onRunBundleFinalized"]>>[0],
  options: { env: NodeJS.ProcessEnv; rootDir: string },
  dependencies: { upload: typeof uploadBitbucketRunBundle } = {
    upload: uploadBitbucketRunBundle,
  },
): Promise<void> {
  const relative = path.relative(options.rootDir, bundle.directory);
  const bundlePath = relative && !relative.startsWith("..") ? relative : bundle.directory;
  const changeNumber = bundle.repository?.changeNumber;
  const artifactName = changeNumber
    ? `pipr-run-v1-pr-${changeNumber}-${bundle.executionId}`
    : `pipr-run-v1-${bundle.executionId}`;
  publishGitHubRunMetadata(options.env, bundle.executionId, bundlePath, artifactName);
  publishAzureRunMetadata(options.env, bundle.executionId, bundlePath, artifactName);
  await publishBitbucketRunBundle(options.env, bundle, changeNumber, dependencies.upload);
}

function publishGitHubRunMetadata(
  env: NodeJS.ProcessEnv,
  executionId: string,
  bundlePath: string,
  artifactName: string,
): void {
  if (env.GITHUB_ACTIONS !== "true") return;
  core.setOutput("execution-id", executionId);
  core.setOutput("run-bundle-path", bundlePath);
  core.setOutput("run-artifact-name", artifactName);
}

function publishAzureRunMetadata(
  env: NodeJS.ProcessEnv,
  executionId: string,
  bundlePath: string,
  artifactName: string,
): void {
  if (env.TF_BUILD !== "True" && env.TF_BUILD !== "true") return;
  console.log(`##vso[task.setvariable variable=PIPR_EXECUTION_ID]${azureValue(executionId)}`);
  console.log(`##vso[task.setvariable variable=PIPR_RUN_BUNDLE_PATH]${azureValue(bundlePath)}`);
  console.log(`##vso[task.setvariable variable=PIPR_RUN_ARTIFACT_NAME]${azureValue(artifactName)}`);
}

async function publishBitbucketRunBundle(
  env: NodeJS.ProcessEnv,
  bundle: Parameters<NonNullable<HostRunCommandOptions["onRunBundleFinalized"]>>[0],
  changeNumber: number | undefined,
  upload: typeof uploadBitbucketRunBundle,
): Promise<void> {
  if (!env.BITBUCKET_BUILD_NUMBER) return;
  const result = await upload({
    directory: bundle.directory,
    repository: bundle.repository?.repository,
    changeNumber,
    executionId: bundle.executionId,
    email: env.BITBUCKET_ARTIFACT_EMAIL,
    token: env.BITBUCKET_ARTIFACT_API_TOKEN,
    readEmail: env.BITBUCKET_EMAIL,
    readToken: env.BITBUCKET_API_TOKEN,
  });
  if (result.status === "failed") {
    console.error(`pipr warning Bitbucket run upload failed: ${result.error}`);
  } else if (result.warning) {
    console.error(`pipr warning Bitbucket expired run cleanup failed: ${result.warning}`);
  }
}

function azureValue(value: string): string {
  return value
    .replaceAll("%", "%AZP25")
    .replaceAll("\r", "%0D")
    .replaceAll("\n", "%0A")
    .replaceAll(";", "%3B")
    .replaceAll("]", "%5D");
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
    runStoreDirectory: options.runStoreDir,
    runRetentionDays: positiveIntegerOption(options.runRetentionDays, "--run-retention-days"),
    runMaxBytes: positiveIntegerOption(options.runMaxBytes, "--run-max-bytes"),
  });
}

function positiveIntegerOption(value: string | undefined, name: string): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

async function runWebhookStatus(options: CliOptions): Promise<void> {
  const { readWebhookDeliveryStatus } = await import("@usepipr/runtime");
  const limit = Number(options.limit);
  const deliveries = readWebhookDeliveryStatus(options.database ?? ".pipr/webhooks.sqlite", limit);
  if (options.json) {
    console.log(JSON.stringify({ formatVersion: 1, deliveries }, null, 2));
    return;
  }
  if (deliveries.length === 0) {
    console.log("No webhook deliveries found.");
    return;
  }
  const rows = deliveries.map((delivery) => [
    shorten(delivery.id, 24),
    delivery.host,
    delivery.status,
    String(delivery.attempts),
    delivery.resultKind ?? "-",
    delivery.runId ? shorten(delivery.runId, 12) : "-",
    delivery.updatedAt,
  ]);
  console.log(
    [["DELIVERY", "HOST", "STATUS", "ATTEMPTS", "RESULT", "RUN", "UPDATED"], ...rows]
      .map((row) => row.join("\t"))
      .join("\n"),
  );
}

function shorten(value: string, length: number): string {
  return value.length <= length ? value : `${value.slice(0, length - 1)}…`;
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
  const traceDirectory =
    typeof options.trace === "string"
      ? path.resolve(process.cwd(), options.trace)
      : options.trace
        ? await defaultLocalTraceStore(process.cwd(), process.env)
        : undefined;
  const result = await runLocalReviewCommand({
    rootDir: process.cwd(),
    configDir: options.configDir,
    env: process.env,
    baseSha: options.base,
    headSha: options.head,
    piExecutable: options.piExecutable,
    traceDirectory,
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
    console.log(JSON.stringify(toPiprResult({ source: "local", result }), null, 2));
    return;
  }
  if (result.kind === "skipped") {
    console.log(`skipped: ${result.skipReason ?? "no task matched"}`);
    return;
  }
  console.log(formatLocalReview(result));
}

function formatLocalReview(result: Extract<LocalReviewResult, { kind: "review" }>): string {
  const mainComment = stripPiprMainCommentMarkers(result.mainComment);
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
