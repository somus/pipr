import { inspect } from "node:util";
import * as core from "@actions/core";
import {
  type ActionCommandResult,
  type ActionLogRecord,
  type ActionLogSink,
  runActionCommand,
  runDryRunCommand,
  runInitCommand,
  runInspectCommand,
  runLocalReviewCommand,
  runValidateCommand,
  supportedOfficialInitAdapters,
  supportedOfficialInitRecipes,
} from "@usepipr/runtime";
import { Command } from "commander";
import cliPackage from "../package.json" with { type: "json" };
import { formatBundledSkill, materializeBundledSkill, resolveBundledSkill } from "./skills.js";
import {
  availablePiprUpdateNotice,
  resolveCurrentExecutablePath,
  runPiprUpdate,
  type UpdateNotice,
} from "./update.js";

type ActionOptions = Parameters<typeof runActionCommand>[0];

type CliOptions = {
  configDir: string;
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
  if (!isUpdateCommand(argv)) {
    await writeAvailableUpdateNotice(options);
  }
  const program = createProgram();
  if (argv.length <= 2) {
    program.outputHelp();
    return;
  }
  await program.parseAsync(argv);
}

function createProgram(): Command {
  const program = new Command();
  program.name("pipr").version(cliPackage.version).showHelpAfterError();
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
    .command("action")
    .description("Run inside GitHub Docker Action")
    .option("--config-dir <dir>", "Config directory", ".pipr")
    .action(runAction);

  program
    .command("check")
    .description("Type-load config and validate the runtime plan")
    .option("--config-dir <dir>", "Config directory", ".pipr")
    .option("--require-env", "Require configured provider env vars")
    .action(runCheck);

  program
    .command("dry-run")
    .description("Load config and event without publishing")
    .requiredOption("--event <path>", "GitHub event JSON path")
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

async function runAction(options: CliOptions): Promise<void> {
  writeActionResult(await runActionCommand(actionOptions(options)));
}

function actionOptions(options: CliOptions): ActionOptions {
  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (!eventPath) {
    throw new Error("GITHUB_EVENT_PATH is required for pipr action");
  }
  return {
    rootDir: process.env.GITHUB_WORKSPACE ?? process.cwd(),
    configDir: process.env["INPUT_CONFIG-DIR"] || options.configDir,
    env: process.env,
    eventPath,
    dryRun: process.env.PIPR_DRY_RUN === "1",
    logSink: githubActionsLogSink,
  };
}

const githubActionsLogSink: ActionLogSink = {
  log(record) {
    githubActionLogWriters[record.level](formatGitHubActionLogRecord(record));
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
} satisfies Record<ActionLogRecord["level"], (message: string) => void>;

function formatGitHubActionLogRecord(record: ActionLogRecord): string {
  const line = JSON.stringify({
    level: record.level,
    event: record.event,
    ...record.fields,
  });
  return record.text === undefined ? line : `${line}\n${record.text}`;
}

function writeActionResult(result: ActionCommandResult): void {
  if (result.kind === "ignored") {
    core.info(`pipr ignored event: ${result.reason}`);
    return;
  }
  writeLoadedActionResult(result);
}

type LoadedActionResult = Exclude<ActionCommandResult, { kind: "ignored" }>;
type PublishedActionResult = Exclude<LoadedActionResult, { kind: "dry-run" }>;
type CommandActionResult = Extract<
  PublishedActionResult,
  { kind: "command-help" | "command-response" }
>;
type ReviewWorkflowActionResult = Exclude<PublishedActionResult, CommandActionResult>;

function writeLoadedActionResult(result: LoadedActionResult): void {
  core.info(
    `pipr loaded change #${result.event.change.number} for ${result.event.repository.slug}`,
  );
  core.info(`pipr config source: ${result.configSource}`);
  if (result.kind === "dry-run") {
    writeDryRunActionResult(result);
    return;
  }
  writePublishedActionResult(result);
}

function writePublishedActionResult(result: PublishedActionResult): void {
  if (result.kind === "command-help" || result.kind === "command-response") {
    writeCommandActionResult(result);
    return;
  }
  writeReviewWorkflowActionResult(result);
}

function writeCommandActionResult(result: CommandActionResult): void {
  switch (result.kind) {
    case "command-help":
      writeCommandHelpActionResult(result);
      break;
    case "command-response":
      writeCommandResponseActionResult(result);
      break;
    default:
      result satisfies never;
  }
}

function writeReviewWorkflowActionResult(result: ReviewWorkflowActionResult): void {
  switch (result.kind) {
    case "review":
      writeReviewActionResult(result);
      break;
    case "verifier":
      writeVerifierActionResult(result);
      break;
    default:
      result satisfies never;
  }
}

function writeDryRunActionResult(result: Extract<ActionCommandResult, { kind: "dry-run" }>): void {
  void result;
  core.info("PIPR_DRY_RUN=1; stopping before review runtime, model, or GitHub publishing calls");
}

function writeCommandHelpActionResult(
  result: Extract<ActionCommandResult, { kind: "command-help" }>,
): void {
  core.info(`pipr command help: ${result.reason}`);
  core.setOutput("main-comment", result.body);
}

function writeCommandResponseActionResult(
  result: Extract<ActionCommandResult, { kind: "command-response" }>,
): void {
  core.info(
    `pipr command '${result.command}' published response comment (${result.publication.action})`,
  );
  core.setOutput("main-comment", result.response.body);
  core.setOutput("publication", JSON.stringify(result.publication));
}

function writeVerifierActionResult(
  result: Extract<ActionCommandResult, { kind: "verifier" }>,
): void {
  core.info(
    `pipr verifier processed review comment reply with ${result.errors.length} publication error(s)`,
  );
  warnInlineResolutionErrors(result.errors);
  core.setOutput("publication", JSON.stringify({ inlineResolutionErrors: result.errors }));
}

function writeReviewActionResult(result: Extract<ActionCommandResult, { kind: "review" }>): void {
  core.info(
    `pipr review produced ${result.review.validated.validFindings.length} valid inline finding(s), ` +
      `${result.review.validated.droppedFindings.length} dropped finding(s)`,
  );
  core.info(
    `pipr published main comment (${result.publication.mainComment.action}) and ` +
      `${result.publication.inlineComments.posted} inline comment(s); ` +
      `${result.publication.inlineComments.skipped} skipped`,
  );
  warnInlineResolutionErrors(result.publication.metadata.inlineResolutionErrors);
  if (result.review.repairAttempted) {
    core.info("pipr repaired reviewer JSON once before validation");
  }
  core.setOutput("main-comment", result.review.mainComment);
  core.setOutput("inline-comments", JSON.stringify(result.review.inlineCommentDrafts));
  core.setOutput("dropped-findings", JSON.stringify(result.review.validated.droppedFindings));
  core.setOutput("publication", JSON.stringify(result.publication));
}

function warnInlineResolutionErrors(errors: string[]): void {
  for (const error of errors) {
    core.warning(`pipr inline resolution failed: ${error}`);
  }
}

async function runInit(options: CliOptions): Promise<void> {
  const result = await runInitCommand({
    rootDir: process.cwd(),
    configDir: options.configDir,
    force: options.force === true,
    adapters: parseInitAdapters(options.adapters),
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

function parseInitAdapters(adapters: string | undefined): string[] | undefined {
  return adapters?.split(",").map((adapter) => adapter.trim());
}

async function runCheck(options: CliOptions): Promise<void> {
  const settings = await runValidateCommand({
    rootDir: process.cwd(),
    configDir: options.configDir,
    env: process.env,
    requireProviderEnv: options.requireEnv === true,
  });
  console.log(`valid: ${settings.source}`);
  for (const warning of settings.warnings) {
    console.log(`warning: ${warning}`);
  }
}

async function runInspect(options: CliOptions): Promise<void> {
  const result = await runInspectCommand({
    rootDir: process.cwd(),
    configDir: options.configDir,
    env: process.env,
  });
  console.log(inspect(result, { depth: 8, colors: false }));
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
      (options.writeUpdateNotice ?? console.error)(formatUpdateNotice(notice));
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

function formatUpdateNotice(notice: UpdateNotice): string {
  return (
    `pipr ${notice.latestVersion} is available (current ${notice.currentVersion}). ` +
    "Run `pipr update` for release binaries, or reinstall @usepipr/cli with npm/Bun."
  );
}

function isUpdateCommand(argv: string[]): boolean {
  const args = argv.slice(2);
  return args[0] === "update" || (args[0] === "help" && args[1] === "update");
}

async function runLocalReview(options: CliOptions): Promise<void> {
  if (!options.base) {
    throw new Error("pipr review requires --base <sha>");
  }
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

const localConsoleLogSink: ActionLogSink = {
  log(record) {
    console.error(formatLocalLogRecord(record));
  },
  async group(_name, run) {
    return await run();
  },
};

function formatLocalLogRecord(record: ActionLogRecord): string {
  const fields = Object.entries(record.fields)
    .map(([key, value]) => formatLocalLogField(key, value))
    .filter((field): field is string => field !== undefined);
  const prefix = formatLocalLogPrefix(record);
  const formatted = [...prefix, ...fields].join(" ");
  return record.text === undefined ? formatted : `${formatted}\n${record.text}`;
}

function formatLocalLogPrefix(record: ActionLogRecord): string[] {
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
  const mainComment = stripMainCommentMarker(result.mainComment);
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

function stripMainCommentMarker(comment: string): string {
  return comment
    .split("\n")
    .filter((line) => !line.startsWith("<!-- pipr:main-comment "))
    .join("\n")
    .trimStart();
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
    env: process.env,
    eventPath: options.event,
  });
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
