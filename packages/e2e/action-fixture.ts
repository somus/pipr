#!/usr/bin/env bun
import { chmod, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { PublicationError } from "@usepipr/runtime";
import {
  presentGitHubActionPublicationError,
  presentGitHubActionResult,
} from "@usepipr/runtime/internal/action-result";
import {
  createGitHubHostAdapter,
  createKnownSecretRedactor,
  type GitHubPublicationClient,
  runHostRunCommandWithDependencies,
} from "@usepipr/runtime/internal/testing";
import { parsePiprResult } from "@usepipr/sdk";
import { type ActAssertionMode, assertActFixture } from "./assertions.ts";

type FixtureReviewComment = Awaited<
  ReturnType<GitHubPublicationClient["listReviewComments"]>
>[number];
type FixtureReviewThread = Awaited<
  ReturnType<GitHubPublicationClient["listReviewThreads"]>
>[number];
type ActionFixtureOptions = Parameters<typeof runHostRunCommandWithDependencies>[0];
type ActionFixtureContext = {
  fixturePath: string;
  options: ActionFixtureOptions;
};

async function main(): Promise<void> {
  assertHostRunCommand(process.argv[2] ?? "host-run");
  const context = await actionFixtureContext();
  const result = await runHostRunCommandWithDependencies(context.options);
  await presentGitHubActionResult(result, {
    info,
    warning: info,
    setOutput,
  });
  if (result.kind === "review") {
    await recordDroppedFindings(context.fixturePath, result.review.validated.droppedFindings);
  }
  await assertConfiguredFixture(context.fixturePath);
}

function assertHostRunCommand(command: string): void {
  if (command !== "host-run") {
    throw new Error(`act fixture wrapper only supports 'host-run', got '${command}'`);
  }
}

async function actionFixtureContext(): Promise<ActionFixtureContext> {
  const fixturePath = requiredEnv("PIPR_ACT_GITHUB_FIXTURE_PATH");
  const rootDir = envValue("GITHUB_WORKSPACE") ?? process.cwd();
  return {
    fixturePath,
    options: {
      rootDir,
      configDir: envValue("INPUT_CONFIG-DIR") || ".pipr",
      env: Bun.env,
      eventPath: requiredEnv("GITHUB_EVENT_PATH"),
      dryRun: envValue("PIPR_DRY_RUN") === "1",
      piExecutable: await actionPiExecutable(requiredEnv("PIPR_ACT_PI_EXECUTABLE")),
      hostAdapter: createGitHubHostAdapter({
        publicationClient: fixturePublicationClient(fixturePath),
      }),
      secretRedactor: createKnownSecretRedactor({ env: Bun.env }),
    },
  };
}

async function actionPiExecutable(piExecutable: string): Promise<string> {
  const callsDir = envValue("PIPR_ACT_PI_CALL_DIR");
  if (!callsDir) {
    return piExecutable;
  }
  await mkdir(callsDir, { recursive: true });
  await chmod(callsDir, 0o777);
  const wrapperPath = path.join(callsDir, "fake-pi-wrapper");
  await writeFile(
    wrapperPath,
    `#!/usr/bin/env bun
import { chmod, rm, writeFile } from "node:fs/promises";
import path from "node:path";

if (process.getuid?.() !== 1000 || process.getgid?.() !== 1000) {
  throw new Error(
    \`fake Pi must run as 1000:1000, got \${process.getuid?.()}:\${process.getgid?.()}\`,
  );
}
const workspaceProbe = path.join(process.cwd(), ".pipr-isolation-probe");
await expectPermissionDenied(() => chmod(process.cwd(), 0o755));
await expectPermissionDenied(() => writeFile(workspaceProbe, "unexpected write"));
const tempProbe = path.join(Bun.env.TMPDIR ?? "", ".pipr-writable-probe");
await writeFile(tempProbe, "ok");
await rm(tempProbe);

Bun.env.PIPR_ACT_PI_CALL_DIR = ${JSON.stringify(callsDir)};
Bun.env.PIPR_ACT_INVALID_FIRST_OUTPUT = ${JSON.stringify(envValue("PIPR_ACT_INVALID_FIRST_OUTPUT") ?? "")};
Bun.env.PIPR_ACT_FAIL_PRIMARY_PROVIDER = ${JSON.stringify(envValue("PIPR_ACT_FAIL_PRIMARY_PROVIDER") ?? "")};
const proc = Bun.spawn([${JSON.stringify(piExecutable)}, ...Bun.argv.slice(2)], {
  stdin: "inherit",
  stdout: "inherit",
  stderr: "inherit",
  env: Bun.env,
});
process.exit(await proc.exited);

async function expectPermissionDenied(run: () => Promise<unknown>): Promise<void> {
  try {
    await run();
  } catch (error) {
    const code = error && typeof error === "object" ? Reflect.get(error, "code") : undefined;
    if (code === "EACCES" || code === "EPERM") return;
    throw error;
  }
  throw new Error("fake Pi unexpectedly modified its read-only workspace");
}
`,
  );
  await chmod(wrapperPath, 0o755);
  return wrapperPath;
}

function requiredEnv(name: string): string {
  const value = envValue(name);
  if (!value) {
    throw new Error(`${name} is required for pipr act fixture wrapper`);
  }
  return value;
}

function envValue(name: string): string | undefined {
  return Bun.env[name];
}

async function assertConfiguredFixture(fixturePath: string): Promise<void> {
  const mode = envValue("PIPR_ACT_ASSERTION") as ActAssertionMode | undefined;
  if (!mode) {
    return;
  }
  await assertActFixture({
    fixturePath,
    mode,
    telemetryPath: envValue("PIPR_ACT_TELEMETRY_PATH"),
  });
}

function fixturePublicationClient(fixturePath: string): GitHubPublicationClient {
  return {
    async getAuthenticatedUserLogin() {
      return (await readFixture(fixturePath)).ownerLogin;
    },
    async getPullRequestHeadSha() {
      return (await readFixture(fixturePath)).headSha;
    },
    async listIssueComments() {
      return (await readFixture(fixturePath)).issueComments;
    },
    async createIssueComment(options) {
      const fixture = await readFixture(fixturePath);
      const comment = {
        id: fixture.issueComments.length + 1,
        body: options.body,
        authorLogin: fixture.ownerLogin,
      };
      fixture.issueComments.push(comment);
      await writeFixture(fixturePath, fixture);
      return { id: comment.id };
    },
    async updateIssueComment(options) {
      const fixture = await readFixture(fixturePath);
      const comment = fixture.issueComments.find((item) => item.id === options.commentId);
      if (!comment) {
        throw new Error(`Fixture issue comment ${options.commentId} not found`);
      }
      comment.body = options.body;
      await writeFixture(fixturePath, fixture);
      return { id: comment.id };
    },
    async listReviewComments() {
      return (await readFixture(fixturePath)).reviewComments;
    },
    async listReviewThreads() {
      return (await readFixture(fixturePath)).reviewThreads ?? [];
    },
    async createReviewComment(options) {
      const fixture = await readFixture(fixturePath);
      if (fixture.failReviewComment) {
        throw new Error("fixture inline failed");
      }
      const comment = {
        id: fixture.reviewComments.length + 1,
        body: options.body,
        authorLogin: fixture.ownerLogin,
        path: options.path,
        commitId: options.commit_id,
        line: options.line,
        startLine: options.start_line,
        side: options.side,
        startSide: options.start_side,
      };
      fixture.reviewComments.push(comment);
      fixture.reviewCommentPayloads.push(options);
      await writeFixture(fixturePath, fixture);
      return { id: comment.id };
    },
    async createReviewCommentReply(options) {
      const fixture = await readFixture(fixturePath);
      const comment = {
        id: fixture.reviewComments.length + 1,
        body: options.body,
        authorLogin: fixture.ownerLogin,
        path: undefined,
        commitId: undefined,
        line: undefined,
        startLine: undefined,
        side: undefined,
        startSide: undefined,
      };
      fixture.reviewComments.push(comment);
      fixture.reviewReplies ??= [];
      fixture.reviewReplies.push({
        commentId: options.commentId,
        body: options.body,
      });
      await writeFixture(fixturePath, fixture);
      return { id: comment.id };
    },
    async resolveReviewThread(options) {
      const fixture = await readFixture(fixturePath);
      const thread = fixture.reviewThreads?.find((item) => item.id === options.threadId);
      if (!thread) {
        throw new Error(`Fixture review thread ${options.threadId} not found`);
      }
      thread.isResolved = true;
      fixture.resolvedThreadIds ??= [];
      fixture.resolvedThreadIds.push(options.threadId);
      await writeFixture(fixturePath, fixture);
    },
    async createCheckRun(options) {
      const fixture = await readFixture(fixturePath);
      fixture.checkRuns ??= [];
      const checkRun = {
        id: fixture.checkRuns.length + 1,
        name: options.name,
        headSha: options.headSha,
        summary: options.summary,
      };
      fixture.checkRuns.push(checkRun);
      await writeFixture(fixturePath, fixture);
      return { id: checkRun.id, name: checkRun.name };
    },
    async updateCheckRun(options) {
      const fixture = await readFixture(fixturePath);
      fixture.checkRunUpdates ??= [];
      fixture.checkRunUpdates.push({
        checkRunId: options.checkRunId,
        name: options.name,
        conclusion: options.conclusion,
        summary: options.summary,
      });
      await writeFixture(fixturePath, fixture);
    },
  };
}

type GitHubPublicationFixture = {
  ownerLogin: string;
  headSha: string;
  issueComments: Array<{ id: number; body: string; authorLogin: string | undefined }>;
  reviewComments: FixtureReviewComment[];
  reviewThreads?: FixtureReviewThread[];
  reviewCommentPayloads: unknown[];
  droppedFindings?: unknown[];
  reviewReplies?: Array<{ commentId: number; body: string }>;
  resolvedThreadIds?: string[];
  checkRuns?: Array<{ id: number; name: string; headSha: string; summary?: string }>;
  checkRunUpdates?: Array<{
    checkRunId: number;
    name: string;
    conclusion: string;
    summary?: string;
  }>;
  failReviewComment?: boolean;
};

async function recordDroppedFindings(
  fixturePath: string,
  droppedFindings: unknown[],
): Promise<void> {
  const fixture = await readFixture(fixturePath);
  fixture.droppedFindings = droppedFindings;
  await writeFixture(fixturePath, fixture);
}

async function readFixture(fixturePath: string): Promise<GitHubPublicationFixture> {
  return (await Bun.file(fixturePath).json()) as GitHubPublicationFixture;
}

async function writeFixture(fixturePath: string, fixture: GitHubPublicationFixture): Promise<void> {
  await Bun.write(fixturePath, JSON.stringify(fixture));
}

main().catch(async (error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof PublicationError) {
    await presentGitHubActionPublicationError(error, {
      info,
      warning: info,
      setOutput,
    });
  }
  setFailed(message);
  process.exitCode = 1;
});

function info(message: string): void {
  console.log(message);
}

function logError(message: string): void {
  console.error(message);
}

function setFailed(message: string): void {
  logError(message);
}

async function setOutput(name: string, value: string): Promise<void> {
  if (name === "result") {
    parsePiprResult(JSON.parse(value));
  }
  const outputPath = envValue("GITHUB_OUTPUT");
  if (!outputPath) {
    return;
  }
  const delimiter = `pipr_${crypto.randomUUID()}`;
  const output = Bun.file(outputPath);
  const existing = (await output.exists()) ? await output.text() : "";
  await Bun.write(outputPath, `${existing}${name}<<${delimiter}\n${value}\n${delimiter}\n`);
}
