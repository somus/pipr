#!/usr/bin/env bun
import { inspect } from "node:util";
import * as core from "@actions/core";
import {
  type ActionCommandResult,
  type ActionLogRecord,
  type ActionLogSink,
  PublicationError,
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

async function main(): Promise<void> {
  const program = createProgram();
  if (process.argv.length <= 2) {
    program.outputHelp();
    return;
  }
  await program.parseAsync(process.argv);
}

function createProgram(): Command {
  const program = new Command();
  program.name("pipr").showHelpAfterError();

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
    .option("--base <sha>", "Base commit SHA")
    .option("--head <sha>", "Head commit SHA or ref; omitted reviews the working tree")
    .option("--config-dir <dir>", "Config directory", ".pipr")
    .option("--pi-executable <path>", "Pi executable path")
    .option("--json", "Print structured JSON output")
    .action(runLocalReview);

  return program;
}

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

main().catch((error: unknown) => {
  if (error instanceof PublicationError && error.result) {
    core.setOutput("publication", JSON.stringify(error.result));
    core.error(`pipr publication metadata: ${JSON.stringify(error.result)}`);
  }
  const message = error instanceof Error ? error.message : String(error);
  core.setFailed(message);
  process.exitCode = 1;
});
