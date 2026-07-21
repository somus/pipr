import { expect } from "bun:test";
import { Buffer } from "node:buffer";
import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { runGit as runGitCommand } from "../../diff/git.js";
import { createGitHubHostAdapter } from "../../hosts/github/adapter.js";
import type { GitHubCommandClient } from "../../hosts/github/command.js";
import type { GitHubPublicationClient } from "../../hosts/github/publication.js";
import type {
  CodeHostAdapter,
  CodeHostCapabilities,
  RepositoryPermission,
} from "../../hosts/types.js";
import { renderInlineFindingMarker } from "../../review/prior-state.js";
import type { SecretRedactor } from "../../shared/secret-redaction.js";
import { writeAggregateReviewablePatchOver16MiB } from "../../tests/helpers/aggregate-reviewable-patch.js";
import {
  type RuntimeLogSink,
  runHostRunCommandWithDependencies as runHostRun,
} from "../commands.js";

export type TestHostRunOptions = Omit<Parameters<typeof runHostRun>[0], "hostAdapter"> & {
  hostAdapter?: CodeHostAdapter;
  githubClient?: GitHubCommandClient;
  githubPublicationClient?: GitHubPublicationClient;
};

export function runTestHostCommand(options: TestHostRunOptions) {
  const { githubClient, githubPublicationClient, ...hostRunOptions } = options;
  return runHostRun({
    ...hostRunOptions,
    hostAdapter:
      options.hostAdapter ??
      (githubClient || githubPublicationClient
        ? createGitHubHostAdapter({
            commandClient: githubClient,
            publicationClient: githubPublicationClient,
          })
        : undefined),
  });
}
export type CommandWorkspace = {
  rootDir: string;
  baseSha: string;
  headSha: string;
  piExecutable: string;
};

export type FakeCheckRuns = {
  created: Array<{ id: number; name: string; headSha: string; summary?: string }>;
  updated: Array<{ checkRunId: number; name: string; conclusion: string; summary?: string }>;
};

export async function writeFailingPiExecutable(piExecutable: string): Promise<void> {
  await Bun.write(
    piExecutable,
    [
      "#!/bin/sh",
      'printf "%s\\n" "$DEEPSEEK_API_KEY" >&2',
      'printf "%s\\n" "model exploded" >&2',
      "exit 42",
    ].join("\n"),
  );
  await chmod(piExecutable, 0o755);
}

export async function createCommandWorkspace(
  options: {
    aggregatePatchOver16MiB?: boolean;
    baseConfigTs?: string;
    checkoutBaseBeforeRun?: boolean;
    headConfigTs?: string;
    sdkVersion?: string;
  } = {},
): Promise<CommandWorkspace> {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "pipr-host-run-command-"));
  runGit(rootDir, ["init", "--initial-branch=main"]);
  runGit(rootDir, ["config", "user.name", "pipr test"]);
  runGit(rootDir, ["config", "user.email", "pipr@example.test"]);
  runGit(rootDir, ["config", "core.hooksPath", "/dev/null"]);
  runGit(rootDir, ["config", "commit.gpgsign", "false"]);
  await mkdir(path.join(rootDir, ".pipr"), { recursive: true });
  await Bun.write(
    path.join(rootDir, ".pipr", "config.ts"),
    options.baseConfigTs ?? reviewConfigTs(),
  );
  if (options.sdkVersion) {
    await Bun.write(
      path.join(rootDir, ".pipr", "package.json"),
      `${JSON.stringify(
        {
          dependencies: {
            "@usepipr/sdk": options.sdkVersion,
          },
        },
        null,
        2,
      )}\n`,
    );
  }
  await mkdir(path.join(rootDir, "src"));
  await Bun.write(path.join(rootDir, "src", "a.ts"), "export const value = 1;\n");
  runGit(rootDir, ["add", "."]);
  runGit(rootDir, ["commit", "--no-verify", "-m", "base"]);
  const baseSha = runGit(rootDir, ["rev-parse", "HEAD"]).trim();
  await Bun.write(
    path.join(rootDir, ".pipr", "config.ts"),
    options.headConfigTs ?? headOnlyConfigTs(),
  );
  await Bun.write(path.join(rootDir, "src", "a.ts"), "export const value = 2;\n");
  if (options.aggregatePatchOver16MiB) {
    await writeAggregateReviewablePatchOver16MiB(rootDir);
  }
  runGit(rootDir, ["add", "."]);
  runGit(rootDir, ["commit", "--no-verify", "-m", "head"]);
  const headSha = runGit(rootDir, ["rev-parse", "HEAD"]).trim();
  const piExecutable = path.join(rootDir, "fake-pi.sh");
  await Bun.write(
    piExecutable,
    piExecutableScript('{"summary":{"body":"No findings."},"inlineFindings":[]}'),
  );
  await chmod(piExecutable, 0o755);
  if (options.checkoutBaseBeforeRun) {
    runGit(rootDir, ["checkout", "--detach", baseSha]);
  }
  return { rootDir, baseSha, headSha, piExecutable };
}

export async function writePiExecutable(piExecutable: string, stdout: string): Promise<void> {
  await Bun.write(piExecutable, piExecutableScript(stdout));
  await chmod(piExecutable, 0o755);
}

function piExecutableScript(stdout: string): string {
  return ["#!/bin/sh", 'touch "$(dirname "$0")/pi-called"', `printf '%s\\n' '${stdout}'`].join(
    "\n",
  );
}

export async function runIssueCommentCommand(
  workspace: CommandWorkspace,
  body: string,
  permission: RepositoryPermission,
  checks?: FakeCheckRuns,
  githubPublicationClient?: GitHubPublicationClient,
  logSink?: RuntimeLogSink,
  commentId = 123,
) {
  const eventPath = path.join(workspace.rootDir, "event.json");
  await writeIssueCommentEvent(eventPath, body, "created", commentId);
  return await runTestHostCommand({
    rootDir: workspace.rootDir,
    configDir: ".pipr",
    eventPath,
    dryRun: false,
    env: issueCommentEnv(workspace.rootDir, eventPath),
    githubClient: fakeGitHubClient(workspace, permission),
    githubPublicationClient:
      githubPublicationClient ?? fakeGitHubPublicationClient(workspace, [], checks),
    piExecutable: workspace.piExecutable,
    logSink,
  });
}

export async function runPullRequestAction(
  workspace: CommandWorkspace,
  options: {
    eventName?: string;
    githubPublicationClient?: GitHubPublicationClient;
    logSink?: RuntimeLogSink;
  } = {},
) {
  const eventPath = path.join(workspace.rootDir, "event.json");
  await writePullRequestEvent(eventPath, workspace);
  return await runTestHostCommand({
    rootDir: workspace.rootDir,
    configDir: ".pipr",
    eventPath,
    dryRun: false,
    env: {
      ...pullRequestEnv(workspace.rootDir, eventPath),
      GITHUB_EVENT_NAME: options.eventName ?? "pull_request",
    },
    githubPublicationClient:
      options.githubPublicationClient ?? fakeGitHubPublicationClient(workspace),
    piExecutable: workspace.piExecutable,
    logSink: options.logSink,
  });
}

export async function runReviewCommentAction(
  workspace: CommandWorkspace,
  options: {
    dryRun?: boolean;
    githubClient: GitHubCommandClient;
    githubPublicationClient: GitHubPublicationClient;
    logSink?: RuntimeLogSink;
    secretRedactor?: SecretRedactor;
    env?: NodeJS.ProcessEnv;
  },
) {
  const eventPath = path.join(workspace.rootDir, "event.json");
  return await runTestHostCommand({
    rootDir: workspace.rootDir,
    configDir: ".pipr",
    eventPath,
    dryRun: options.dryRun ?? false,
    env: options.env ?? reviewCommentEnv(workspace.rootDir, eventPath),
    githubClient: options.githubClient,
    githubPublicationClient: options.githubPublicationClient,
    piExecutable: workspace.piExecutable,
    logSink: options.logSink,
    secretRedactor: options.secretRedactor,
  });
}

export function replacingSecretRedactor(detected: string): SecretRedactor {
  return {
    addSecret() {},
    redact(value) {
      return {
        detected: value.includes(detected),
        value: value.replaceAll(detected, "[redacted secret]"),
      };
    },
  };
}

export async function expectPiNotCalled(workspace: CommandWorkspace): Promise<void> {
  await expect(Bun.file(path.join(workspace.rootDir, "pi-called")).text()).rejects.toThrow();
}

async function expectPiCalled(workspace: CommandWorkspace): Promise<void> {
  await expect(Bun.file(path.join(workspace.rootDir, "pi-called")).text()).resolves.toBe("");
}

export async function expectReviewCommentIgnored(
  workspace: CommandWorkspace,
  options: {
    githubClient: GitHubCommandClient;
    reason: string;
    event?: Parameters<typeof writeReviewCommentEvent>[1];
  },
): Promise<void> {
  const eventPath = path.join(workspace.rootDir, "event.json");
  await writeReviewCommentEvent(eventPath, options.event);
  await expect(
    runReviewCommentAction(workspace, {
      githubClient: options.githubClient,
      githubPublicationClient: failingGitHubPublishingClient(),
    }),
  ).resolves.toMatchObject({ kind: "ignored", reason: options.reason });
  await expectPiNotCalled(workspace);
}

export async function writeStillValidVerifierOutput(
  workspace: CommandWorkspace,
  response = "This still applies.",
): Promise<void> {
  await writePiExecutable(
    workspace.piExecutable,
    JSON.stringify({
      findings: [{ id: "fnd_existing", status: "still-valid", response }],
    }),
  );
}

async function writePromptCapturingVerifierOutput(workspace: CommandWorkspace): Promise<void> {
  await rm(path.join(workspace.rootDir, "pi-prompt.md"), { force: true });
  await Bun.write(
    workspace.piExecutable,
    [
      "#!/bin/sh",
      'prompt_arg=""',
      'for arg do prompt_arg="$arg"; done',
      'prompt_path="$' + '{prompt_arg#@}"',
      'cp "$prompt_path" "$(dirname "$0")/pi-prompt.md"',
      'touch "$(dirname "$0")/pi-called"',
      'printf "%s\\n" \'{"findings":[{"id":"fnd_existing","status":"unknown"}]}\'',
    ].join("\n"),
  );
  await chmod(workspace.piExecutable, 0o755);
}

export async function expectVerifierReplyPublished(
  workspace: CommandWorkspace,
  publication: ReturnType<typeof verifierPublicationClient>,
  options: {
    githubClient: GitHubCommandClient;
    event?: Parameters<typeof writeReviewCommentEvent>[1];
    logSink?: RuntimeLogSink;
    secretRedactor?: SecretRedactor;
    env?: NodeJS.ProcessEnv;
  },
) {
  const eventPath = path.join(workspace.rootDir, "event.json");
  await writeReviewCommentEvent(eventPath, options.event);
  const result = await runReviewCommentAction(workspace, {
    githubClient: options.githubClient,
    githubPublicationClient: publication,
    logSink: options.logSink,
    secretRedactor: options.secretRedactor,
    env: options.env,
  });
  expect(result).toMatchObject({
    kind: "verifier",
    errors: [],
    event: { coordinates: { provider: "github", owner: "local", repository: "pipr" } },
  });
  if (result.kind !== "verifier") throw new Error("expected verifier result");
  expect(publication.reviewReplies).toHaveLength(1);
  await expectPiCalled(workspace);
  return result;
}

export async function verifierRunIdFromReplyAction(
  workspace: CommandWorkspace,
  options: {
    commentId: number;
    parentCommentId: number;
  },
): Promise<string> {
  const eventPath = path.join(workspace.rootDir, "event.json");
  await writeReviewCommentEvent(eventPath, options);
  await writePromptCapturingVerifierOutput(workspace);

  await expect(
    runReviewCommentAction(workspace, {
      githubClient: fakeGitHubClient(workspace, "write"),
      githubPublicationClient: verifierPublicationClient(workspace, {
        parentCommentId: options.parentCommentId,
        replyCommentId: options.commentId,
      }),
    }),
  ).resolves.toMatchObject({ kind: "verifier", errors: [] });

  const prompt = await Bun.file(path.join(workspace.rootDir, "pi-prompt.md")).text();
  const runId = prompt.match(/"runId": "([^"]+)"/)?.[1];
  if (!runId) {
    throw new Error("test fixture failed to capture verifier run id");
  }
  return runId;
}

export async function expectReviewRanAtHead(
  result: Awaited<ReturnType<typeof runTestHostCommand>>,
  workspace: CommandWorkspace,
): Promise<void> {
  expect(result).toMatchObject({ kind: "review" });
  await expectPiCalled(workspace);
  expect(currentGitHead(workspace.rootDir)).toBe(workspace.headSha);
}

export function reviewConfigTs(
  options: {
    command?: boolean;
    event?: boolean;
    parseSideEffect?: boolean;
    checks?: boolean;
    autoResolve?: false | "userRepliesDisabled" | "any";
  } = {},
): string {
  const template = "$";
  const autoResolveConfig =
    options.autoResolve === false
      ? "  pipr.config({ publication: { autoResolve: false } });"
      : options.autoResolve === "userRepliesDisabled"
        ? "  pipr.config({ publication: { autoResolve: { userReplies: { enabled: false } } } });"
        : options.autoResolve === "any"
          ? '  pipr.config({ publication: { autoResolve: { userReplies: { allowedActors: "any" } } } });'
          : "";
  return [
    'import { definePipr } from "@usepipr/sdk";',
    "",
    "export default definePipr((pipr) => {",
    "  const model = pipr.model({",
    '    provider: "deepseek",',
    '    model: "deepseek-reasoner",',
    '    apiKey: pipr.secret({ name: "DEEPSEEK_API_KEY" }),',
    '    options: { thinking: "high" },',
    "  });",
    "  const reviewer = pipr.agent({",
    '    name: "reviewer",',
    "    model,",
    '    instructions: "Review this change.",',
    "    output: pipr.schemas.review,",
    `    prompt: (input) => pipr.prompt\`Review scope: ${template}{input.scope}\`,`,
    "  });",
    "  const task = pipr.task({",
    "    name: 'review',",
    options.checks ? "    check: { enabled: true }," : "",
    "    async run(ctx, input = {}) {",
    "    const manifest = await ctx.change.diffManifest({ compressed: true });",
    "    const result = await ctx.pi.run(reviewer, { manifest, scope: input.scope ?? 'changed' });",
    "    await ctx.comment({ main: result.summary.body, inlineFindings: result.inlineFindings });",
    "    },",
    "  });",
    options.event === false ? "" : '  pipr.on.changeRequest({ actions: ["opened"], task });',
    options.checks ? "  pipr.config({ checks: { aggregate: { enabled: true } } });" : "",
    autoResolveConfig,
    options.command === false
      ? ""
      : [
          "  pipr.command({",
          '    pattern: "@pipr review [--scope <scope>]",',
          '    permission: "write",',
          "    task,",
          "    parse(args) {",
          options.parseSideEffect ? "      globalThis.__piprParseCalled = true;" : "",
          "      const scope = args.scope ?? 'changed';",
          "      if (scope !== 'changed' && scope !== 'full') {",
          "        throw new Error(\"Input 'scope' must be one of: changed, full\");",
          "      }",
          "      return { scope };",
          "    },",
          "  });",
        ].join("\n"),
    "});",
  ]
    .filter((line) => line !== "")
    .join("\n");
}

export function askConfigTs(): string {
  return [
    'import { definePipr } from "@usepipr/sdk";',
    "",
    "export default definePipr((pipr) => {",
    "  const model = pipr.model({",
    '    provider: "deepseek",',
    '    model: "deepseek-reasoner",',
    '    apiKey: pipr.secret({ name: "DEEPSEEK_API_KEY" }),',
    "  });",
    "  const askAgent = pipr.agent({",
    '    name: "ask",',
    "    model,",
    '    instructions: "Answer questions about this pull request.",',
    "    output: pipr.schemas.summary,",
    '    prompt: (input) => "Question: " + input.question,',
    "  });",
    "  const ask = pipr.task({",
    '    name: "ask",',
    "    async run(ctx, input) {",
    "      const manifest = await ctx.change.diffManifest({ compressed: true });",
    "      const prior = await ctx.review.prior();",
    "      const answer = await ctx.pi.run(askAgent, { question: input.question, manifest, prior });",
    "      await ctx.command?.reply(answer.body);",
    "    },",
    "  });",
    '  pipr.command({ pattern: "@pipr ask <question...>", permission: "read", task: ask });',
    "});",
  ].join("\n");
}

export function commandRunIdConfigTs(): string {
  return [
    'import { definePipr } from "@usepipr/sdk";',
    "",
    "export default definePipr((pipr) => {",
    "  const model = pipr.model({",
    '    provider: "deepseek",',
    '    model: "deepseek-reasoner",',
    '    apiKey: pipr.secret({ name: "DEEPSEEK_API_KEY" }),',
    "  });",
    "  const ask = pipr.task({",
    '    name: "ask",',
    "    async run(ctx) {",
    "      await ctx.command?.reply(ctx.run.id);",
    "    },",
    "  });",
    '  pipr.command({ pattern: "@pipr ask <question...>", permission: "read", task: ask });',
    "  void model;",
    "});",
  ].join("\n");
}

function headOnlyConfigTs(): string {
  return [
    'import { definePipr } from "@usepipr/sdk";',
    "",
    "export default definePipr((pipr) => {",
    "  const model = pipr.model({",
    '    provider: "deepseek",',
    '    model: "deepseek-reasoner",',
    '    apiKey: pipr.secret({ name: "DEEPSEEK_API_KEY" }),',
    "  });",
    "  const task = pipr.task({ name: 'head-only', async run() {} });",
    '  pipr.command({ pattern: "@pipr head-only", permission: "write", task });',
    "  void model;",
    "});",
  ].join("\n");
}

export function localReviewSelectionConfigTs(): string {
  return [
    'import { definePipr } from "@usepipr/sdk";',
    "",
    "export default definePipr((pipr) => {",
    "  const model = pipr.model({",
    '    provider: "deepseek",',
    '    model: "deepseek-reasoner",',
    '    apiKey: pipr.secret({ name: "DEEPSEEK_API_KEY" }),',
    "  });",
    "  const alpha = pipr.task({",
    '    name: "alpha",',
    "    async run(ctx) {",
    '      await Bun.write(ctx.repository.root + "/alpha-ran", "1\\n");',
    '      await ctx.comment("Alpha completed.");',
    "    },",
    "  });",
    "  const beta = pipr.task({",
    '    name: "beta",',
    "    async run(ctx) {",
    '      await Bun.write(ctx.repository.root + "/beta-ran", "1\\n");',
    "    },",
    "  });",
    "  const disabled = pipr.task({",
    '    name: "disabled",',
    "    local: false,",
    "    async run(ctx) {",
    '      await Bun.write(ctx.repository.root + "/disabled-ran", "1\\n");',
    "    },",
    "  });",
    '  pipr.on.changeRequest({ actions: ["opened"], task: alpha });',
    '  pipr.on.changeRequest({ actions: ["updated"], task: alpha });',
    '  pipr.on.changeRequest({ actions: ["ready"], task: beta });',
    '  pipr.on.changeRequest({ actions: ["opened"], task: disabled });',
    "  void model;",
    "});",
  ].join("\n");
}

export function multiTaskCheckConfigTs(): string {
  return [
    'import { definePipr } from "@usepipr/sdk";',
    "",
    "export default definePipr((pipr) => {",
    "  const model = pipr.model({",
    '    provider: "deepseek",',
    '    model: "deepseek-v4-pro",',
    '    apiKey: pipr.secret({ name: "DEEPSEEK_API_KEY" }),',
    "  });",
    "  const summary = pipr.task({",
    '    name: "summary",',
    "    check: { enabled: true },",
    "    async run(ctx) {",
    '      await ctx.comment("Summary completed.");',
    "    },",
    "  });",
    "  const gate = pipr.task({",
    '    name: "gate",',
    "    check: { enabled: true },",
    "    async run() {",
    '      throw new Error("Sensitive task failure");',
    "    },",
    "  });",
    '  pipr.on.changeRequest({ actions: ["opened"], task: summary });',
    '  pipr.on.changeRequest({ actions: ["opened"], task: gate });',
    "  pipr.config({ checks: { aggregate: { enabled: true } } });",
    "  void model;",
    "});",
  ].join("\n");
}

export function explicitModelIdConfigTs(): string {
  return [
    'import { definePipr } from "@usepipr/sdk";',
    "",
    "export default definePipr((pipr) => {",
    "  const model = pipr.model({",
    '    id: "fast",',
    '    provider: "deepseek",',
    '    model: "deepseek-reasoner",',
    '    apiKey: pipr.secret({ name: "FAST_DEEPSEEK_API_KEY" }),',
    '    options: { thinking: "high" },',
    "  });",
    "  const reviewer = pipr.agent({",
    '    name: "reviewer",',
    "    model,",
    '    instructions: "Review this change.",',
    "    output: pipr.schemas.review,",
    '    prompt: () => "Review.",',
    "  });",
    "  const task = pipr.task({",
    '    name: "review",',
    "    async run(ctx) {",
    "      const manifest = await ctx.change.diffManifest({ compressed: true });",
    "      const result = await ctx.pi.run(reviewer, { manifest });",
    "      await ctx.comment(result.summary.body);",
    "    },",
    "  });",
    '  pipr.on.changeRequest({ actions: ["opened"], task });',
    "});",
  ].join("\n");
}

export function maliciousHeadConfigTs(): string {
  return [
    'import { writeFileSync } from "node:fs";',
    'import { definePipr } from "@usepipr/sdk";',
    "",
    "if (process.env.PIPR_DRY_RUN_SIDE_EFFECT_PATH) {",
    '  writeFileSync(process.env.PIPR_DRY_RUN_SIDE_EFFECT_PATH, "executed");',
    "}",
    "",
    "export default definePipr((pipr) => {",
    "  const task = pipr.task({ name: 'head-only', async run() {} });",
    '  pipr.command({ pattern: "@pipr head-only", permission: "write", task });',
    "});",
  ].join("\n");
}

export async function writeIssueCommentEvent(
  eventPath: string,
  body: string,
  action = "created",
  commentId = 123,
): Promise<void> {
  await Bun.write(
    eventPath,
    JSON.stringify({
      action,
      repository: { full_name: "local/pipr" },
      issue: { number: 1, pull_request: {} },
      comment: { id: commentId, body, user: { login: "somu" } },
    }),
  );
}

export function commandResponsePayload(body: string | undefined): string {
  if (!body) {
    throw new Error("test fixture missing command response body");
  }
  return body
    .split("\n")
    .filter((line) => line.trim() !== "" && !line.startsWith("<!--"))
    .join("\n");
}

export async function writePullRequestEvent(
  eventPath: string,
  workspace: CommandWorkspace,
): Promise<void> {
  await Bun.write(
    eventPath,
    JSON.stringify({
      action: "opened",
      number: 1,
      repository: { full_name: "local/pipr" },
      pull_request: {
        number: 1,
        title: "Test PR",
        body: "Test body",
        base: {
          sha: workspace.baseSha,
          repo: { full_name: "local/pipr" },
        },
        head: { sha: workspace.headSha },
      },
    }),
  );
}

export async function writeReviewCommentEvent(
  eventPath: string,
  options: {
    action?: string;
    body?: string;
    actor?: string;
    commentId?: number;
    parentCommentId?: number | null;
  } = {},
): Promise<void> {
  await Bun.write(
    eventPath,
    JSON.stringify({
      action: options.action ?? "created",
      repository: { full_name: "local/pipr" },
      pull_request: { number: 1 },
      comment: {
        id: options.commentId ?? 11,
        in_reply_to_id: options.parentCommentId === undefined ? 10 : options.parentCommentId,
        body: options.body ?? "The caller validates this earlier.",
        user: { login: options.actor ?? "somu" },
      },
    }),
  );
}

export function fakeGitHubClient(
  workspace: CommandWorkspace,
  permission: RepositoryPermission,
  options: { author?: string; failPermission?: boolean } = {},
): GitHubCommandClient {
  return {
    async getPullRequest() {
      return {
        repository: { slug: "local/pipr" },
        change: {
          number: 1,
          title: "Test PR",
          description: "Test body",
          author: options.author ? { login: options.author } : undefined,
          base: { sha: workspace.baseSha },
          head: { sha: workspace.headSha },
        },
      };
    },
    async getRepositoryPermission() {
      if (options.failPermission) {
        throw new Error("repository permission should not be checked");
      }
      return permission;
    },
  };
}

export function failingGitHubClient(): GitHubCommandClient {
  return {
    async getPullRequest() {
      throw new Error("GitHub should not be called");
    },
    async getRepositoryPermission() {
      throw new Error("GitHub should not be called");
    },
  };
}

export function fakeGitHubPublicationClient(
  workspace: CommandWorkspace,
  issueComments: Awaited<ReturnType<GitHubPublicationClient["listIssueComments"]>> = [],
  checks?: FakeCheckRuns,
): GitHubPublicationClient {
  return {
    async getAuthenticatedUserLogin() {
      return "github-actions[bot]";
    },
    async getPullRequestHeadSha() {
      return workspace.headSha;
    },
    async listIssueComments() {
      return issueComments;
    },
    async createIssueComment() {
      return { id: 1 };
    },
    async updateIssueComment() {
      return { id: 1 };
    },
    async listReviewComments() {
      return [];
    },
    async listReviewThreads() {
      return [];
    },
    async createReviewComment() {
      return { id: 2 };
    },
    async createReviewCommentReply() {
      return { id: 3 };
    },
    async resolveReviewThread() {},
    async createCheckRun(options) {
      const checkRun = {
        id: (checks?.created.length ?? 0) + 4,
        name: options.name,
        headSha: options.headSha,
        summary: options.summary,
      };
      checks?.created.push(checkRun);
      return { id: checkRun.id, name: checkRun.name };
    },
    async updateCheckRun(options) {
      checks?.updated.push({
        checkRunId: options.checkRunId,
        name: options.name,
        conclusion: options.conclusion,
        summary: options.summary,
      });
    },
  };
}

export function recordingCommandPublicationClient(
  workspace: CommandWorkspace,
  issueComments: Awaited<ReturnType<GitHubPublicationClient["listIssueComments"]>> = [],
): {
  client: GitHubPublicationClient;
  writes: { created: string[]; updated: string[] };
} {
  const writes = { created: [] as string[], updated: [] as string[] };
  const client = fakeGitHubPublicationClient(workspace, issueComments);
  client.createIssueComment = async (options) => {
    writes.created.push(options.body);
    issueComments.push({ id: 10, body: options.body, authorLogin: "github-actions[bot]" });
    return { id: 10 };
  };
  client.updateIssueComment = async (options) => {
    writes.updated.push(options.body);
    const existing = issueComments.find((comment) => comment.id === options.commentId);
    if (existing) existing.body = options.body;
    return { id: options.commentId };
  };
  return { client, writes };
}

export function verifierPublicationClient(
  workspace: CommandWorkspace,
  options: { parentCommentId?: number; replyCommentId?: number } = {},
): GitHubPublicationClient & {
  reviewReplies: Array<{ commentId: number; body: string }>;
} {
  const reviewReplies: Array<{ commentId: number; body: string }> = [];
  const issueComments = [priorMainCommentWithFindingBody()];
  const parentCommentId = options.parentCommentId ?? 10;
  const replyCommentId = options.replyCommentId ?? 11;
  const reviewComments: Awaited<ReturnType<GitHubPublicationClient["listReviewComments"]>> = [
    {
      id: parentCommentId,
      body: `${renderInlineFindingMarker("fnd_existing", "old-head")}\n\nThis can fail.`,
      authorLogin: "github-actions[bot]",
      path: undefined,
      commitId: undefined,
      line: undefined,
      startLine: undefined,
      side: undefined,
      startSide: undefined,
    },
    {
      id: replyCommentId,
      body: "The caller validates this earlier.",
      authorLogin: "somu",
      path: undefined,
      commitId: undefined,
      line: undefined,
      startLine: undefined,
      side: undefined,
      startSide: undefined,
    },
  ];
  return {
    ...fakeGitHubPublicationClient(workspace),
    reviewReplies,
    async listIssueComments() {
      return issueComments.map((body, index) => ({
        id: index + 1,
        body,
        authorLogin: "github-actions[bot]",
      }));
    },
    async listReviewComments() {
      return reviewComments;
    },
    async listReviewThreads() {
      return [{ id: "thread-1", isResolved: false, commentIds: [parentCommentId, replyCommentId] }];
    },
    async createReviewCommentReply(options: { commentId: number; body: string }) {
      reviewReplies.push(options);
      reviewComments.push({
        id: reviewComments.length + 10,
        body: options.body,
        authorLogin: "github-actions[bot]",
        path: undefined,
        commitId: undefined,
        line: undefined,
        startLine: undefined,
        side: undefined,
        startSide: undefined,
      });
      return { id: reviewComments.length + 10 };
    },
  };
}

export function priorMainCommentBody(): string {
  const state = Buffer.from(
    JSON.stringify({
      version: 1,
      reviewedHeadSha: "old-head",
      selectedTasks: ["old-task"],
      findings: [],
    }),
  ).toString("base64url");
  return [
    `<!-- pipr:main-comment change=1 version=1 state=${state} -->`,
    "",
    "# pipr Review",
    "",
    "Prior preserved section.",
    "",
  ].join("\n");
}

function priorMainCommentWithFindingBody(): string {
  const state = Buffer.from(
    JSON.stringify({
      version: 1,
      reviewedHeadSha: "old-head",
      selectedTasks: ["review"],
      findings: [
        {
          id: "fnd_existing",
          status: "open",
          path: "src/a.ts",
          rangeId: "range-1",
          side: "RIGHT",
          startLine: 1,
          endLine: 1,
          firstSeenHeadSha: "old-head",
          lastSeenHeadSha: "old-head",
          lastCommentedHeadSha: "old-head",
        },
      ],
    }),
  ).toString("base64url");
  return [
    `<!-- pipr:main-comment change=1 version=1 state=${state} -->`,
    "",
    "# pipr Review",
    "",
    "Prior preserved section.",
    "",
  ].join("\n");
}

export function failingGitHubPublishingClient(): GitHubPublicationClient {
  return {
    async getAuthenticatedUserLogin() {
      throw new Error("GitHub publishing should not be called");
    },
    async getPullRequestHeadSha() {
      throw new Error("GitHub publishing should not be called");
    },
    async listIssueComments() {
      throw new Error("GitHub publishing should not be called");
    },
    async createIssueComment() {
      throw new Error("GitHub publishing should not be called");
    },
    async updateIssueComment() {
      throw new Error("GitHub publishing should not be called");
    },
    async listReviewComments() {
      throw new Error("GitHub publishing should not be called");
    },
    async listReviewThreads() {
      throw new Error("GitHub publishing should not be called");
    },
    async createReviewComment() {
      throw new Error("GitHub publishing should not be called");
    },
    async createReviewCommentReply() {
      throw new Error("GitHub publishing should not be called");
    },
    async resolveReviewThread() {
      throw new Error("GitHub publishing should not be called");
    },
    async createCheckRun() {
      throw new Error("GitHub publishing should not be called");
    },
    async updateCheckRun() {
      throw new Error("GitHub publishing should not be called");
    },
  };
}

export function issueCommentEnv(rootDir: string, eventPath: string): NodeJS.ProcessEnv {
  return {
    DEEPSEEK_API_KEY: "provider-key",
    GITHUB_EVENT_NAME: "issue_comment",
    GITHUB_EVENT_PATH: eventPath,
    GITHUB_WORKSPACE: rootDir,
  };
}

export function pullRequestEnv(rootDir: string, eventPath: string): NodeJS.ProcessEnv {
  return {
    DEEPSEEK_API_KEY: "provider-key",
    FAST_DEEPSEEK_API_KEY: "provider-key",
    GITHUB_EVENT_NAME: "pull_request",
    GITHUB_EVENT_PATH: eventPath,
    GITHUB_WORKSPACE: rootDir,
  };
}

export function reviewCommentEnv(rootDir: string, eventPath: string): NodeJS.ProcessEnv {
  return {
    DEEPSEEK_API_KEY: "provider-key",
    FAST_DEEPSEEK_API_KEY: "provider-key",
    GITHUB_EVENT_NAME: "pull_request_review_comment",
    GITHUB_EVENT_PATH: eventPath,
    GITHUB_WORKSPACE: rootDir,
  };
}

export function githubAdapterWithCapabilities(
  workspace: CommandWorkspace,
  overrides: Partial<CodeHostCapabilities>,
) {
  const adapter = createGitHubHostAdapter({
    commandClient: fakeGitHubClient(workspace, "write"),
    publicationClient: fakeGitHubPublicationClient(workspace),
  });
  return { ...adapter, capabilities: { ...adapter.capabilities, ...overrides } };
}

export function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
    delete Bun.env[key];
  } else {
    process.env[key] = value;
    Bun.env[key] = value;
  }
}

export function snapshotGitConfigEnv(): Map<string, string | undefined> {
  const count = Number.parseInt(process.env.GIT_CONFIG_COUNT ?? "0", 10);
  const limit = Number.isSafeInteger(count) && count >= 0 ? count : 0;
  const snapshot = new Map<string, string | undefined>([
    ["GIT_CONFIG_COUNT", process.env.GIT_CONFIG_COUNT],
  ]);
  for (let index = 0; index <= limit; index += 1) {
    snapshot.set(`GIT_CONFIG_KEY_${index}`, process.env[`GIT_CONFIG_KEY_${index}`]);
    snapshot.set(`GIT_CONFIG_VALUE_${index}`, process.env[`GIT_CONFIG_VALUE_${index}`]);
  }
  return snapshot;
}

export function clearGitConfigEnv(snapshot: Map<string, string | undefined>): void {
  for (const key of snapshot.keys()) {
    restoreEnv(key, undefined);
  }
}

export function restoreGitConfigEnv(snapshot: Map<string, string | undefined>): void {
  for (const [key, value] of snapshot) {
    restoreEnv(key, value);
  }
}

export async function removeWorkspace(rootDir: string): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      await rm(rootDir, { recursive: true, force: true });
      return;
    } catch (error) {
      if (attempt === 19) {
        throw error;
      }
      await delay(100);
    }
  }
}

function runGit(cwd: string, args: string[]): string {
  return runGitCommand(args, cwd);
}

export function currentGitHead(cwd: string): string {
  return runGit(cwd, ["rev-parse", "HEAD"]).trim();
}
