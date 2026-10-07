import { describe, expect, it } from "bun:test";
import { mkdtemp, readdir, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseRunBundleManifest } from "@usepipr/sdk";
import { runGit as runGitCommand } from "../../diff/git.js";
import { createGitHubHostAdapter } from "../../hosts/github/adapter.js";
import { extractPriorReviewState } from "../../review/comment-markers.js";
import type { RuntimeLogSink } from "../../shared/logging.js";
import { runtimeVersion } from "../../shared/version.js";
import { memoryRuntimeLogSink } from "../../tests/helpers/runtime-log-sink.js";
import type { HostRunFindingEvents } from "../types.js";
import type { FakeCheckRuns } from "./commands-fixtures.js";
import {
  clearGitConfigEnv,
  createCommandWorkspace,
  currentGitHead,
  expectPiNotCalled,
  expectReviewRanAtHead,
  explicitModelIdConfigTs,
  failingGitHubPublishingClient,
  fakeGitHubClient,
  fakeGitHubPublicationClient,
  maliciousHeadConfigTs,
  multiTaskCheckConfigTs,
  priorMainCommentBody,
  pullRequestEnv,
  recordingCommandPublicationClient,
  removeWorkspace,
  restoreEnv,
  restoreGitConfigEnv,
  reviewCommentEnv,
  reviewConfigTs,
  runPullRequestAction,
  runTestHostCommand,
  snapshotGitConfigEnv,
  writeFailingPiOutput,
  writeProviderAuthenticationFailureOutput,
  writePullRequestEvent,
  writeReviewCommentEvent,
} from "./commands-fixtures.js";

const runBundleRecipient = "age1cy0su9fwf3gf9mw868g5yut09p6nytfmmnktexz2ya5uqg9vl9sss4euqm";

describe("runHostRunCommand pull_request dispatch", () => {
  it("captures content-free hosted metadata by default with provider and work identities", async () => {
    const workspace = await createCommandWorkspace({ checkoutBaseBeforeRun: true });
    const traceDirectory = path.join(workspace.rootDir, "traces");
    const finalized: Array<{ executionId: string; directory: string }> = [];
    try {
      const eventPath = path.join(workspace.rootDir, "event.json");
      await writePullRequestEvent(eventPath, workspace);
      const result = await runTestHostCommand({
        rootDir: workspace.rootDir,
        configDir: ".pipr",
        eventPath,
        dryRun: false,
        env: {
          ...pullRequestEnv(workspace.rootDir, eventPath),
          GITHUB_ACTIONS: "true",
          GITHUB_RUN_ID: "100",
          GITHUB_JOB: "review",
          GITHUB_SERVER_URL: "https://github.com",
          PIPR_RUN_STORE_DIR: traceDirectory,
        },
        githubPublicationClient: fakeGitHubPublicationClient(workspace),
        piProviderModule: workspace.pi.providerModule,
        onRunBundleFinalized(bundle) {
          finalized.push(bundle);
        },
      });
      if (result.kind !== "review") throw new Error(`Expected review, received ${result.kind}`);

      const executionId = finalized[0]?.executionId;
      const bundleDirectory = finalized[0]?.directory;
      if (!executionId || !bundleDirectory) throw new Error("Expected a finalized Run Bundle");
      const manifest = parseRunBundleManifest(
        JSON.parse(await readFile(path.join(bundleDirectory, "run.json"), "utf8")),
      );
      expect(manifest).toMatchObject({
        executionId,
        workId: result.review.run.id,
        kind: "review",
        outcome: "succeeded",
        repository: {
          host: "github",
          repository: "local/pipr",
          changeNumber: 1,
          baseSha: workspace.baseSha,
          headSha: workspace.headSha,
        },
        provider: { runId: "100", jobId: "review" },
        pipr: { configHash: expect.stringMatching(/^[a-f0-9]{64}$/) },
        capture: { mode: "metadata" },
        export: { externalUpload: "pending" },
      });
      expect(finalized).toEqual([
        expect.objectContaining({
          executionId,
          directory: bundleDirectory,
        }),
      ]);
      await expect(readdir(traceDirectory)).rejects.toThrow();
    } finally {
      await removeWorkspace(workspace.rootDir);
    }
  });

  it.each([
    {
      host: "gitea" as const,
      providerEnv: {
        GITEA_ACTIONS: "true",
        GITHUB_RUN_ID: "200",
        GITHUB_JOB: "review",
        GITHUB_SERVER_URL: "https://gitea.example.com",
      },
      expectedProvider: {
        runId: "200",
        jobId: "review",
        runUrl: "https://gitea.example.com/local/pipr/actions/runs/200",
      },
    },
    {
      host: "codeberg" as const,
      providerEnv: {
        FORGEJO_ACTIONS: "true",
        FORGEJO_RUN_ID: "201",
        FORGEJO_JOB: "review",
        FORGEJO_REPOSITORY: "local/pipr",
        FORGEJO_SERVER_URL: "https://codeberg.org",
      },
      expectedProvider: {
        runId: "201",
        jobId: "review",
        runUrl: "https://codeberg.org/local/pipr/actions/runs/201",
      },
    },
  ])("captures $host Actions provider metadata by default", async (testCase) => {
    const workspace = await createCommandWorkspace({ checkoutBaseBeforeRun: true });
    const traceDirectory = path.join(workspace.rootDir, "traces");
    const finalized: Array<{ executionId: string; directory: string }> = [];
    try {
      const eventPath = path.join(workspace.rootDir, "event.json");
      await writePullRequestEvent(eventPath, workspace);
      const result = await runTestHostCommand({
        rootDir: workspace.rootDir,
        configDir: ".pipr",
        eventPath,
        dryRun: false,
        env: {
          ...pullRequestEnv(workspace.rootDir, eventPath),
          ...testCase.providerEnv,
          PIPR_RUN_STORE_DIR: traceDirectory,
        },
        hostAdapter: {
          ...createGitHubHostAdapter({
            publicationClient: fakeGitHubPublicationClient(workspace),
          }),
          id: testCase.host,
        },
        piProviderModule: workspace.pi.providerModule,
        onRunBundleFinalized(bundle) {
          finalized.push(bundle);
        },
      });
      if (result.kind !== "review") throw new Error(`Expected review, received ${result.kind}`);

      const bundleDirectory = finalized[0]?.directory;
      if (!bundleDirectory) throw new Error("Expected a finalized Run Bundle");
      const manifest = parseRunBundleManifest(
        JSON.parse(await readFile(path.join(bundleDirectory, "run.json"), "utf8")),
      );
      expect(manifest).toMatchObject({
        repository: {
          host: testCase.host,
          repository: "local/pipr",
          changeNumber: 1,
        },
        provider: testCase.expectedProvider,
        capture: { mode: "metadata" },
      });
    } finally {
      await removeWorkspace(workspace.rootDir);
    }
  });

  it("disables hosted capture when PIPR_RUN_CAPTURE is off", async () => {
    const workspace = await createCommandWorkspace({ checkoutBaseBeforeRun: true });
    const traceDirectory = path.join(workspace.rootDir, "traces");
    try {
      const eventPath = path.join(workspace.rootDir, "event.json");
      await writePullRequestEvent(eventPath, workspace);
      await runTestHostCommand({
        rootDir: workspace.rootDir,
        configDir: ".pipr",
        eventPath,
        dryRun: false,
        env: {
          ...pullRequestEnv(workspace.rootDir, eventPath),
          PIPR_RUN_CAPTURE: "off",
          PIPR_RUN_STORE_DIR: traceDirectory,
        },
        githubPublicationClient: fakeGitHubPublicationClient(workspace),
        piProviderModule: workspace.pi.providerModule,
      });

      await expect(readdir(traceDirectory)).rejects.toThrow();
    } finally {
      await removeWorkspace(workspace.rootDir);
    }
  });

  it("downgrades native-CI diagnostic capture to metadata without age recipients", async () => {
    const workspace = await createCommandWorkspace({ checkoutBaseBeforeRun: true });
    const logs = memoryRuntimeLogSink();
    let bundleDirectory: string | undefined;
    try {
      const eventPath = path.join(workspace.rootDir, "event.json");
      await writePullRequestEvent(eventPath, workspace);
      await runTestHostCommand({
        rootDir: workspace.rootDir,
        configDir: ".pipr",
        eventPath,
        dryRun: false,
        env: {
          ...pullRequestEnv(workspace.rootDir, eventPath),
          GITHUB_ACTIONS: "true",
          PIPR_RUN_CAPTURE: "diagnostic",
        },
        githubPublicationClient: fakeGitHubPublicationClient(workspace),
        piProviderModule: workspace.pi.providerModule,
        logSink: logs.logSink,
        onRunBundleFinalized(bundle) {
          bundleDirectory = bundle.directory;
        },
      });

      if (!bundleDirectory) throw new Error("Expected a finalized Run Bundle");
      const manifest = parseRunBundleManifest(
        JSON.parse(await readFile(path.join(bundleDirectory, "run.json"), "utf8")),
      );
      expect(manifest.capture.mode).toBe("metadata");
      expect(
        manifest.artifacts.filter((artifact) => /prompt-|output-/.test(artifact.path)),
      ).toEqual([]);
      expect(logs.records).toContainEqual(
        expect.objectContaining({
          level: "warning",
          event: "run capture protection unavailable",
          fields: { status: "recipients-missing" },
        }),
      );
    } finally {
      await removeWorkspace(workspace.rootDir);
    }
  });

  it("rejects an unknown PIPR_RUN_CAPTURE mode", async () => {
    const workspace = await createCommandWorkspace({ checkoutBaseBeforeRun: true });
    try {
      const eventPath = path.join(workspace.rootDir, "event.json");
      await writePullRequestEvent(eventPath, workspace);
      await expect(
        runTestHostCommand({
          rootDir: workspace.rootDir,
          configDir: ".pipr",
          eventPath,
          dryRun: false,
          env: { ...pullRequestEnv(workspace.rootDir, eventPath), PIPR_RUN_CAPTURE: "bogus" },
          githubPublicationClient: fakeGitHubPublicationClient(workspace),
          piProviderModule: workspace.pi.providerModule,
        }),
      ).rejects.toThrow("PIPR_RUN_CAPTURE must be off, metadata, or diagnostic");
      await expectPiNotCalled(workspace);
    } finally {
      await removeWorkspace(workspace.rootDir);
    }
  });

  it("records nested lifecycle phases and model attempts as timed spans", async () => {
    const workspace = await createCommandWorkspace({ checkoutBaseBeforeRun: true });
    const traceDirectory = path.join(workspace.rootDir, "traces");
    let bundleDirectory: string | undefined;
    try {
      const eventPath = path.join(workspace.rootDir, "event.json");
      await writePullRequestEvent(eventPath, workspace);
      await runTestHostCommand({
        rootDir: workspace.rootDir,
        configDir: ".pipr",
        eventPath,
        dryRun: false,
        env: {
          ...pullRequestEnv(workspace.rootDir, eventPath),
          GITHUB_ACTIONS: "true",
          PIPR_RUN_AGE_RECIPIENTS: runBundleRecipient,
          PIPR_RUN_STORE_DIR: traceDirectory,
        },
        githubPublicationClient: fakeGitHubPublicationClient(workspace),
        piProviderModule: workspace.pi.providerModule,
        onRunBundleFinalized(bundle) {
          bundleDirectory = bundle.directory;
        },
      });

      if (!bundleDirectory) throw new Error("Expected a finalized Run Bundle");
      const spans = (await readFile(path.join(bundleDirectory, "spans.jsonl"), "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { name: string; durationMs?: number });
      expect(spans.map((span) => span.name)).toEqual(
        expect.arrayContaining([
          "pipr.workspace.prepare",
          "pipr.event.parse",
          "pipr.config.fetch_trusted_base",
          "pipr.config.load_trusted",
          "pipr.workspace.checkout_head",
          "pipr.diff.construct",
          "pipr.task",
          "pipr.review.validate",
          "pipr.publish.review_progress",
          "pipr.publish.review",
          "gen_ai.invoke_agent",
          "gen_ai.chat",
          "pipr.agent.attempt_resources",
          "pipr.run",
        ]),
      );
      expect(spans.every((span) => span.durationMs !== undefined && span.durationMs >= 0)).toBe(
        true,
      );
    } finally {
      await removeWorkspace(workspace.rootDir);
    }
  });

  it("stores each agent attempt prompt and visible output as diagnostic artifacts", async () => {
    const workspace = await createCommandWorkspace({ checkoutBaseBeforeRun: true });
    const traceDirectory = path.join(workspace.rootDir, "traces");
    let bundleDirectory: string | undefined;
    try {
      const eventPath = path.join(workspace.rootDir, "event.json");
      await writePullRequestEvent(eventPath, workspace);
      await runTestHostCommand({
        rootDir: workspace.rootDir,
        configDir: ".pipr",
        eventPath,
        dryRun: false,
        env: {
          ...pullRequestEnv(workspace.rootDir, eventPath),
          GITHUB_ACTIONS: "true",
          PIPR_RUN_AGE_RECIPIENTS: runBundleRecipient,
          PIPR_RUN_STORE_DIR: traceDirectory,
        },
        githubPublicationClient: fakeGitHubPublicationClient(workspace),
        piProviderModule: workspace.pi.providerModule,
        onRunBundleFinalized(bundle) {
          bundleDirectory = bundle.directory;
        },
      });

      if (!bundleDirectory) throw new Error("Expected a finalized Run Bundle");
      const manifest = parseRunBundleManifest(
        JSON.parse(await readFile(path.join(bundleDirectory, "run.json"), "utf8")),
      );
      const prompt = manifest.artifacts.find((artifact) =>
        artifact.path.endsWith("prompt-001-initial.md"),
      );
      const output = manifest.artifacts.find((artifact) =>
        artifact.path.endsWith("output-001-initial.txt"),
      );
      expect(prompt && (await readFile(path.join(bundleDirectory, prompt.path), "utf8"))).toContain(
        "Review scope: changed",
      );
      expect(output && (await readFile(path.join(bundleDirectory, output.path), "utf8"))).toBe(
        '{"summary":{"body":"No findings."},"inlineFindings":[]}',
      );
    } finally {
      await removeWorkspace(workspace.rootDir);
    }
  });

  it("records tool timing and first response, keeping Pi payloads only in the conversation", async () => {
    const workspace = await createCommandWorkspace({ checkoutBaseBeforeRun: true });
    const traceDirectory = path.join(workspace.rootDir, "traces");
    let bundleDirectory: string | undefined;
    try {
      await workspace.pi.script({
        responses: [
          { toolCalls: [{ name: "grep", args: { pattern: "do-not-store" } }] },
          { error: "503 service unavailable do-not-store" },
          { text: '{"summary":{"body":"No findings."},"inlineFindings":[]}' },
        ],
      });
      const eventPath = path.join(workspace.rootDir, "event.json");
      await writePullRequestEvent(eventPath, workspace);
      await runTestHostCommand({
        rootDir: workspace.rootDir,
        configDir: ".pipr",
        eventPath,
        dryRun: false,
        env: {
          ...pullRequestEnv(workspace.rootDir, eventPath),
          GITHUB_ACTIONS: "true",
          PIPR_RUN_AGE_RECIPIENTS: runBundleRecipient,
          PIPR_RUN_STORE_DIR: traceDirectory,
        },
        githubPublicationClient: fakeGitHubPublicationClient(workspace),
        piProviderModule: workspace.pi.providerModule,
        onRunBundleFinalized(bundle) {
          bundleDirectory = bundle.directory;
        },
      });

      if (!bundleDirectory) throw new Error("Expected a finalized Run Bundle");
      const spans = (await readFile(path.join(bundleDirectory, "spans.jsonl"), "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { name: string; attributes: Record<string, unknown> });
      expect(spans).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: "gen_ai.execute_tool",
            attributes: expect.objectContaining({
              "gen_ai.tool.name": "grep",
              "pipr.tool.input_bytes": expect.any(Number),
              "pipr.tool.input_hash": expect.stringMatching(/^[a-f0-9]{64}$/),
              "pipr.tool.output_bytes": expect.any(Number),
              "pipr.tool.output_hash": expect.stringMatching(/^[a-f0-9]{64}$/),
            }),
          }),
          expect.objectContaining({
            name: "pipr.agent.retry",
            attributes: expect.objectContaining({ "pipr.retry.backoff_ms": expect.any(Number) }),
          }),
          expect.objectContaining({ name: "gen_ai.time_to_first_token" }),
        ]),
      );
      const files = (await readdir(bundleDirectory, { recursive: true, withFileTypes: true }))
        .filter((entry) => entry.isFile())
        .map((entry) => path.join(entry.parentPath, entry.name));
      const conversations = files.filter((file) => path.basename(file).startsWith("conversation-"));
      const readAll = async (paths: string[]) =>
        (await Promise.all(paths.map((file) => readFile(file, "utf8")))).join("\n");
      expect(conversations.length).toBeGreaterThan(0);
      expect(await readAll(conversations)).toContain("do-not-store");
      expect(await readAll(files.filter((file) => !conversations.includes(file)))).not.toContain(
        "do-not-store",
      );
    } finally {
      await removeWorkspace(workspace.rootDir);
    }
  });

  it("marks the GitHub Action workspace as a git safe directory before trusted config reads", async () => {
    const workspace = await createCommandWorkspace();
    const gitConfigDir = await mkdtemp(path.join(os.tmpdir(), "pipr-host-run-gitconfig-"));
    const previousHome = process.env.HOME;
    const previousGitConfigEnv = snapshotGitConfigEnv();
    try {
      clearGitConfigEnv(previousGitConfigEnv);
      const eventPath = path.join(workspace.rootDir, "event.json");
      await writePullRequestEvent(eventPath, workspace);

      const result = await runTestHostCommand({
        rootDir: workspace.rootDir,
        configDir: ".pipr",
        eventPath,
        dryRun: true,
        env: {
          ...pullRequestEnv(workspace.rootDir, eventPath),
          GITHUB_ACTIONS: "true",
          HOME: path.join(gitConfigDir, "read-only-home"),
          RUNNER_TEMP: gitConfigDir,
        },
        githubPublicationClient: failingGitHubPublishingClient(),
        piProviderModule: workspace.pi.providerModule,
      });

      expect(result).toMatchObject({ kind: "dry-run" });
      expect(process.env.GIT_CONFIG_COUNT).toBe("1");
      expect(process.env.GIT_CONFIG_KEY_0).toBe("safe.directory");
      expect(process.env.GIT_CONFIG_VALUE_0).toBe(workspace.rootDir);
      expect(runGitCommand(["config", "--get-all", "safe.directory"], workspace.rootDir)).toContain(
        workspace.rootDir,
      );
      await expect(Bun.file(path.join(gitConfigDir, ".gitconfig")).text()).resolves.toContain(
        `directory = ${workspace.rootDir}`,
      );
    } finally {
      restoreEnv("HOME", previousHome);
      restoreGitConfigEnv(previousGitConfigEnv);
      await removeWorkspace(workspace.rootDir);
      await removeWorkspace(gitConfigDir);
    }
  });

  it("loads trusted base config in dry-run without executing PR-head config", async () => {
    const workspace = await createCommandWorkspace({
      headConfigTs: maliciousHeadConfigTs(),
      checkoutBaseBeforeRun: false,
    });
    const sideEffectPath = path.join(workspace.rootDir, "dry-run-side-effect");
    const previous = process.env.PIPR_DRY_RUN_SIDE_EFFECT_PATH;
    process.env.PIPR_DRY_RUN_SIDE_EFFECT_PATH = sideEffectPath;
    try {
      const eventPath = path.join(workspace.rootDir, "event.json");
      await writePullRequestEvent(eventPath, workspace);

      const result = await runTestHostCommand({
        rootDir: workspace.rootDir,
        configDir: ".pipr",
        eventPath,
        dryRun: true,
        env: pullRequestEnv(workspace.rootDir, eventPath),
        githubPublicationClient: failingGitHubPublishingClient(),
        piProviderModule: workspace.pi.providerModule,
      });

      expect(result).toMatchObject({ kind: "dry-run" });
      await expect(Bun.file(sideEffectPath).text()).rejects.toThrow();
      await expectPiNotCalled(workspace);
    } finally {
      if (previous === undefined) {
        delete process.env.PIPR_DRY_RUN_SIDE_EFFECT_PATH;
      } else {
        process.env.PIPR_DRY_RUN_SIDE_EFFECT_PATH = previous;
      }
      await removeWorkspace(workspace.rootDir);
    }
  });

  it("checks out the PR head before running the review task", async () => {
    const workspace = await createCommandWorkspace({ checkoutBaseBeforeRun: true });
    try {
      expect(currentGitHead(workspace.rootDir)).toBe(workspace.baseSha);
      const result = await runPullRequestAction(workspace);

      expect(result).toMatchObject({ kind: "review" });
      await expectReviewRanAtHead(result, workspace);
    } finally {
      await removeWorkspace(workspace.rootDir);
    }
  });

  it("publishes stage and review-work changes, then replaces progress with the review", async () => {
    const workspace = await createCommandWorkspace({ checkoutBaseBeforeRun: true });
    const publication = recordingCommandPublicationClient(workspace);
    try {
      await expect(
        runPullRequestAction(workspace, {
          githubPublicationClient: publication.client,
        }),
      ).resolves.toMatchObject({ kind: "review" });

      const bodies = [...publication.writes.created, ...publication.writes.updated];
      const stages = bodies
        .map((body) => body.match(/stage=([a-z-]+) state=running/)?.[1])
        .filter((stage): stage is string => stage !== undefined);
      expect(stages.filter((stage, index) => stage !== stages[index - 1])).toEqual([
        "preparing-workspace",
        "building-diff",
        "running-review-tasks",
        "validating-review",
        "publishing-review",
      ]);
      expect(
        bodies.some(
          (body) =>
            body.includes("<strong>Task:</strong> <code>review</code>") &&
            body.includes("<strong>Reviewer:</strong> <code>reviewer</code>"),
        ),
      ).toBe(true);
      expect(bodies.at(-1)).toContain("Review completed in ");
      expect(bodies.at(-1)).toContain("[Run 1](<https://github.com/local/pipr/actions/runs/123>)");
      expect(bodies.at(-1)).not.toContain("pipr:progress:start");
    } finally {
      await removeWorkspace(workspace.rootDir);
    }
  });

  it("does not let a delayed work update overwrite a later stage or completed review", async () => {
    const workspace = await createCommandWorkspace({ checkoutBaseBeforeRun: true });
    const issueComments: Array<{ id: number; body: string; authorLogin: string }> = [];
    const publication = recordingCommandPublicationClient(workspace, issueComments);
    const workUpdateStarted = Promise.withResolvers<void>();
    const releaseWorkUpdate = Promise.withResolvers<void>();
    const updateIssueComment = publication.client.updateIssueComment.bind(publication.client);
    let delayed = false;
    publication.client.updateIssueComment = async (options) => {
      if (!delayed && options.body.includes("<strong>Task:</strong> <code>review</code>")) {
        delayed = true;
        workUpdateStarted.resolve();
        await releaseWorkUpdate.promise;
      }
      return await updateIssueComment(options);
    };
    try {
      const run = runPullRequestAction(workspace, {
        githubPublicationClient: publication.client,
      });
      await workUpdateStarted.promise;
      await Bun.sleep(10);
      releaseWorkUpdate.resolve();
      await expect(run).resolves.toMatchObject({ kind: "review" });

      expect(issueComments).toHaveLength(1);
      expect(issueComments[0]?.body).toContain("Review completed in ");
      expect(issueComments[0]?.body).not.toContain("pipr:progress:start");
      expect(publication.writes.updated.at(-1)).toBe(issueComments[0]?.body);
    } finally {
      releaseWorkUpdate.resolve();
      await removeWorkspace(workspace.rootDir);
    }
  });

  it("ignores a superseded stage transition and neutralizes started checks", async () => {
    const workspace = await createCommandWorkspace({
      baseConfigTs: reviewConfigTs({ checks: true }),
      checkoutBaseBeforeRun: true,
    });
    const issueComments: Array<{ id: number; body: string; authorLogin: string }> = [];
    const checks: FakeCheckRuns = { created: [], updated: [] };
    const client = fakeGitHubPublicationClient(workspace, issueComments, checks);
    const createIssueComment = client.createIssueComment.bind(client);
    client.createIssueComment = async (options) => {
      const result = await createIssueComment(options);
      supersedeProgressComment(issueComments);
      return result;
    };
    try {
      await expect(
        runPullRequestAction(workspace, { githubPublicationClient: client }),
      ).resolves.toMatchObject({
        kind: "ignored",
        reason: "Review progress was superseded by a newer run",
      });

      expect(checks.updated).toEqual([
        {
          checkRunId: 4,
          name: "review",
          conclusion: "neutral",
          summary: "Pipr run was superseded.",
        },
        {
          checkRunId: 5,
          name: "all",
          conclusion: "neutral",
          summary: "Pipr run was superseded.",
        },
      ]);
      await expectPiNotCalled(workspace);

      const [executionId] = await readdir(path.join(workspace.rootDir, ".pipr-runs"));
      const manifest = parseRunBundleManifest(
        JSON.parse(
          await readFile(
            path.join(workspace.rootDir, ".pipr-runs", executionId ?? "", "run.json"),
            "utf8",
          ),
        ),
      );
      expect(manifest).toMatchObject({
        kind: "review",
        outcome: "partial",
        failureCategory: "stale-head",
      });
    } finally {
      await removeWorkspace(workspace.rootDir);
    }
  });

  it("prioritizes an asynchronous work supersession over a task failure", async () => {
    const workspace = await createCommandWorkspace({
      baseConfigTs: reviewConfigTs({ checks: true }),
      checkoutBaseBeforeRun: true,
    });
    const issueComments: Array<{ id: number; body: string; authorLogin: string }> = [];
    const checks: FakeCheckRuns = { created: [], updated: [] };
    const client = fakeGitHubPublicationClient(workspace, issueComments, checks);
    const updateIssueComment = client.updateIssueComment.bind(client);
    let superseded = false;
    client.updateIssueComment = async (options) => {
      const result = await updateIssueComment(options);
      if (
        !superseded &&
        options.body.includes("stage=running-review-tasks") &&
        !options.body.includes("Task:")
      ) {
        superseded = true;
        supersedeProgressComment(issueComments);
      }
      return result;
    };
    try {
      await writeFailingPiOutput(workspace);
      await expect(
        runPullRequestAction(workspace, { githubPublicationClient: client }),
      ).resolves.toMatchObject({
        kind: "ignored",
        reason: "Review progress was superseded by a newer run",
      });

      expect(checks.updated.map((check) => check.conclusion)).toEqual(["neutral", "neutral"]);
      expect(checks.updated.map((check) => check.summary)).toEqual([
        "Pipr run was superseded.",
        "Pipr run was superseded.",
      ]);
    } finally {
      await removeWorkspace(workspace.rootDir);
    }
  });

  it("retains the failed stage, redacted reason, and workflow URL", async () => {
    const workspace = await createCommandWorkspace({ checkoutBaseBeforeRun: true });
    const publication = recordingCommandPublicationClient(workspace);
    try {
      await writeFailingPiOutput(workspace);
      await expect(
        runPullRequestAction(workspace, {
          githubPublicationClient: publication.client,
        }),
      ).rejects.toThrow("Pi agent failed (model_error)");

      const failed = publication.writes.updated.at(-1) ?? publication.writes.created.at(-1) ?? "";
      expect(failed).toContain("state=failed");
      expect(failed).toContain("**Failed stage:** Running review tasks");
      expect(failed).toContain(
        "**Failed work:** Task <code>review</code> · Reviewer <code>reviewer</code>",
      );
      expect(failed).toContain(String.raw`Pi agent failed (model\_error)`);
      expect(failed).not.toContain("provider-key");
      expect(failed).toContain(
        "[Open workflow to rerun failed jobs](<https://github.com/local/pipr/actions/runs/123>)",
      );
      expect(failed).toContain("Pipr stopped while reviewing commit");
    } finally {
      await removeWorkspace(workspace.rootDir);
    }
  });

  it("publishes safe remediation for classified provider failures", async () => {
    const workspace = await createCommandWorkspace({ checkoutBaseBeforeRun: true });
    const publication = recordingCommandPublicationClient(workspace);
    try {
      await writeProviderAuthenticationFailureOutput(workspace);
      await expect(
        runPullRequestAction(workspace, {
          githubPublicationClient: publication.client,
        }),
      ).rejects.toThrow("Pi agent failed (model_error)");

      const failed = publication.writes.updated.at(-1) ?? publication.writes.created.at(-1) ?? "";
      expect(failed).toContain("**Reason:** deepseek authentication failed.");
      expect(failed).toContain(
        String.raw`**Next step:** Verify the configured DEEPSEEK\_API\_KEY secret or environment variable and deepseek account access, then rerun.`,
      );
      expect(failed).not.toContain("private-provider-detail");
      expect(failed).toContain(
        "[Open workflow to rerun failed jobs](<https://github.com/local/pipr/actions/runs/123>)",
      );
    } finally {
      await removeWorkspace(workspace.rootDir);
    }
  });

  it("does not create a progress placeholder when showProgress is disabled", async () => {
    const workspace = await createCommandWorkspace({
      baseConfigTs: reviewConfigTs({ showProgress: false }),
      checkoutBaseBeforeRun: true,
    });
    const publication = recordingCommandPublicationClient(workspace);
    try {
      await expect(
        runPullRequestAction(workspace, {
          githubPublicationClient: publication.client,
        }),
      ).resolves.toMatchObject({ kind: "review" });

      const bodies = [...publication.writes.created, ...publication.writes.updated];
      expect(bodies).toHaveLength(1);
      expect(bodies[0]).not.toContain("pipr:progress");
      expect(bodies[0]).toContain("Review completed in ");
    } finally {
      await removeWorkspace(workspace.rootDir);
    }
  });

  it("creates and finalizes pull_request check runs around review publication", async () => {
    const workspace = await createCommandWorkspace({
      baseConfigTs: reviewConfigTs({ checks: true }),
      checkoutBaseBeforeRun: true,
    });
    const checks: FakeCheckRuns = { created: [], updated: [] };
    try {
      const result = await runPullRequestAction(workspace, {
        githubPublicationClient: fakeGitHubPublicationClient(workspace, [], checks),
      });

      expect(result).toMatchObject({ kind: "review" });
      expect(checks.created.map((check) => check.name)).toEqual(["review", "all"]);
      expect(checks.created.map((check) => check.headSha)).toEqual([
        workspace.headSha,
        workspace.headSha,
      ]);
      expect(checks.updated.map((check) => check.conclusion)).toEqual(["success", "success"]);
    } finally {
      await removeWorkspace(workspace.rootDir);
    }
  });

  it("captures generic provider publication failures as publication evidence", async () => {
    const workspace = await createCommandWorkspace({
      baseConfigTs: reviewConfigTs({ showProgress: false }),
      checkoutBaseBeforeRun: true,
    });
    const traceDirectory = path.join(workspace.rootDir, "traces");
    try {
      const eventPath = path.join(workspace.rootDir, "event.json");
      await writePullRequestEvent(eventPath, workspace);
      const client = fakeGitHubPublicationClient(workspace);
      client.createIssueComment = async () => {
        throw new Error("provider publication failed");
      };

      await expect(
        runTestHostCommand({
          rootDir: workspace.rootDir,
          configDir: ".pipr",
          eventPath,
          dryRun: false,
          env: {
            ...pullRequestEnv(workspace.rootDir, eventPath),
            PIPR_RUN_STORE_DIR: traceDirectory,
          },
          githubPublicationClient: client,
          piProviderModule: workspace.pi.providerModule,
        }),
      ).rejects.toThrow("provider publication failed");

      const [executionId] = await readdir(traceDirectory);
      const bundleDirectory = path.join(traceDirectory, executionId ?? "");
      const manifest = parseRunBundleManifest(
        JSON.parse(await readFile(path.join(bundleDirectory, "run.json"), "utf8")),
      );
      expect(manifest).toMatchObject({
        outcome: "failed",
        failureCategory: "publication",
        capture: { completeness: "complete" },
      });
      expect(manifest.artifacts.map((artifact) => artifact.path)).toEqual(
        expect.arrayContaining([
          "artifacts/publication-plan.json",
          "artifacts/publication-error.json",
        ]),
      );
    } finally {
      await removeWorkspace(workspace.rootDir);
    }
  });

  it("classifies stale-head publication failures in the diagnostic bundle", async () => {
    const workspace = await createCommandWorkspace({ checkoutBaseBeforeRun: true });
    const traceDirectory = path.join(workspace.rootDir, "traces");
    try {
      const eventPath = path.join(workspace.rootDir, "event.json");
      await writePullRequestEvent(eventPath, workspace);
      const client = fakeGitHubPublicationClient(workspace);
      client.getPullRequestHeadSha = async () => "new-head";

      await expect(
        runTestHostCommand({
          rootDir: workspace.rootDir,
          configDir: ".pipr",
          eventPath,
          dryRun: false,
          env: {
            ...pullRequestEnv(workspace.rootDir, eventPath),
            PIPR_RUN_STORE_DIR: traceDirectory,
          },
          githubPublicationClient: client,
          piProviderModule: workspace.pi.providerModule,
        }),
      ).rejects.toThrow("change request head changed");

      const [executionId] = await readdir(traceDirectory);
      const manifest = parseRunBundleManifest(
        JSON.parse(
          await readFile(path.join(traceDirectory, executionId ?? "", "run.json"), "utf8"),
        ),
      );
      expect(manifest).toMatchObject({ outcome: "failed", failureCategory: "stale-head" });
    } finally {
      await removeWorkspace(workspace.rootDir);
    }
  });

  it("renders failed progress when status finalization fails", async () => {
    const workspace = await createCommandWorkspace({
      baseConfigTs: reviewConfigTs({ checks: true }),
      checkoutBaseBeforeRun: true,
    });
    const publication = recordingCommandPublicationClient(workspace);
    publication.client.updateCheckRun = async () => {
      throw new Error("status finalization failed");
    };
    try {
      await expect(
        runPullRequestAction(workspace, {
          githubPublicationClient: publication.client,
        }),
      ).rejects.toThrow("status finalization failed");

      const body = publication.writes.updated.at(-1) ?? publication.writes.created.at(-1) ?? "";
      expect(body).toContain("state=failed");
      expect(body).toContain("**Failed stage:** Validating review");
      expect(body).toContain("**Reason:** status finalization failed");
      expect(body).not.toContain("Review completed in ");
    } finally {
      await removeWorkspace(workspace.rootDir);
    }
  });

  it("uses the trusted base config model id for pull_request runs", async () => {
    const workspace = await createCommandWorkspace({
      baseConfigTs: explicitModelIdConfigTs(),
      checkoutBaseBeforeRun: true,
    });
    try {
      const result = await runPullRequestAction(workspace);

      expect(result).toMatchObject({ kind: "review" });
      expect(result.kind === "review" ? result.review.provider : undefined).toMatchObject({
        id: "fast",
        provider: "deepseek",
        model: "deepseek-reasoner",
        apiKeyEnv: "FAST_DEEPSEEK_API_KEY",
      });
    } finally {
      await removeWorkspace(workspace.rootDir);
    }
  });

  it("does not expose a local Pi agent directory to hosted subscription models", async () => {
    const workspace = await createCommandWorkspace({
      baseConfigTs: reviewConfigTs({ subscriptionModel: true }),
      checkoutBaseBeforeRun: true,
    });
    try {
      await expect(runPullRequestAction(workspace)).rejects.toThrow(
        "does not declare apiKey and requires a Pi auth file",
      );
      await expectPiNotCalled(workspace);
    } finally {
      await removeWorkspace(workspace.rootDir);
    }
  });

  it("does not publish GitHub statuses for non-pull_request change events", async () => {
    const workspace = await createCommandWorkspace({
      baseConfigTs: reviewConfigTs({ checks: true }),
      checkoutBaseBeforeRun: true,
    });
    const checks: FakeCheckRuns = { created: [], updated: [] };
    try {
      await runPullRequestAction(workspace, {
        eventName: "pull_request_target",
        githubPublicationClient: fakeGitHubPublicationClient(workspace, [], checks),
      });

      expect(checks).toEqual({ created: [], updated: [] });
    } finally {
      await removeWorkspace(workspace.rootDir);
    }
  });

  it("fails before Pi when code host status publication lacks permission", async () => {
    const workspace = await createCommandWorkspace({
      baseConfigTs: reviewConfigTs({ checks: true }),
      checkoutBaseBeforeRun: true,
    });
    try {
      const client = fakeGitHubPublicationClient(workspace);
      client.createCheckRun = async () => {
        throw new Error("Resource not accessible by integration");
      };

      await expect(
        runPullRequestAction(workspace, { githubPublicationClient: client }),
      ).rejects.toThrow("Check the adapter credential scopes");
      await expectPiNotCalled(workspace);
    } finally {
      await removeWorkspace(workspace.rootDir);
    }
  });

  it("ignores a superseded lease when check startup fails before review execution", async () => {
    const workspace = await createCommandWorkspace({
      baseConfigTs: reviewConfigTs({ checks: true }),
      checkoutBaseBeforeRun: true,
    });
    const issueComments: Array<{ id: number; body: string; authorLogin: string }> = [];
    const client = fakeGitHubPublicationClient(workspace, issueComments);
    client.createCheckRun = async () => {
      supersedeProgressComment(issueComments);
      throw new Error("Resource not accessible by integration");
    };
    try {
      await expect(
        runPullRequestAction(workspace, { githubPublicationClient: client }),
      ).resolves.toMatchObject({
        kind: "ignored",
        reason: "Review progress was superseded by a newer run",
      });
      await expectPiNotCalled(workspace);
    } finally {
      await removeWorkspace(workspace.rootDir);
    }
  });

  it("neutralizes partially started checks when later check startup is superseded", async () => {
    const workspace = await createCommandWorkspace({
      baseConfigTs: reviewConfigTs({ checks: true }),
      checkoutBaseBeforeRun: true,
    });
    const issueComments: Array<{ id: number; body: string; authorLogin: string }> = [];
    const checks: FakeCheckRuns = { created: [], updated: [] };
    const client = fakeGitHubPublicationClient(workspace, issueComments, checks);
    const createCheckRun = client.createCheckRun.bind(client);
    client.createCheckRun = async (options) => {
      if (options.name === "all") {
        supersedeProgressComment(issueComments);
        throw new Error("Resource not accessible by integration");
      }
      return await createCheckRun(options);
    };
    try {
      await expect(
        runPullRequestAction(workspace, { githubPublicationClient: client }),
      ).resolves.toMatchObject({
        kind: "ignored",
        reason: "Review progress was superseded by a newer run",
      });

      expect(checks.created.map((check) => check.name)).toEqual(["review"]);
      expect(checks.updated).toEqual([
        {
          checkRunId: 4,
          name: "review",
          conclusion: "neutral",
          summary: "Pipr run was superseded.",
        },
      ]);
      await expectPiNotCalled(workspace);
    } finally {
      await removeWorkspace(workspace.rootDir);
    }
  });

  it("preserves successful task check outcomes when another selected task throws", async () => {
    const workspace = await createCommandWorkspace({
      baseConfigTs: multiTaskCheckConfigTs(),
      checkoutBaseBeforeRun: true,
    });
    const checks: FakeCheckRuns = { created: [], updated: [] };
    try {
      await expect(
        runPullRequestAction(workspace, {
          githubPublicationClient: fakeGitHubPublicationClient(workspace, [], checks),
        }),
      ).rejects.toThrow("Sensitive task failure");

      expect(checks.updated).toEqual([
        {
          checkRunId: 4,
          name: "summary",
          conclusion: "success",
          summary: undefined,
        },
        {
          checkRunId: 5,
          name: "gate",
          conclusion: "failure",
          summary: "Task failed; see logs for details.",
        },
        {
          checkRunId: 6,
          name: "all",
          conclusion: "failure",
          summary: "pipr failed; see runner logs for details.",
        },
      ]);
    } finally {
      await removeWorkspace(workspace.rootDir);
    }
  });

  it("finalizes started check runs when later check creation fails", async () => {
    const workspace = await createCommandWorkspace({
      baseConfigTs: reviewConfigTs({ checks: true }),
      checkoutBaseBeforeRun: true,
    });
    const checks: FakeCheckRuns = { created: [], updated: [] };
    try {
      const client = fakeGitHubPublicationClient(workspace, [], checks);
      client.createCheckRun = async (options) => {
        if (options.name === "all") {
          throw new Error("Resource not accessible by integration");
        }
        return fakeGitHubPublicationClient(workspace, [], checks).createCheckRun(options);
      };

      await expect(
        runPullRequestAction(workspace, { githubPublicationClient: client }),
      ).rejects.toThrow("Check the adapter credential scopes");

      expect(checks.created.map((check) => check.name)).toEqual(["review"]);
      expect(checks.updated).toEqual([
        {
          checkRunId: 4,
          name: "review",
          conclusion: "failure",
          summary: "pipr failed; see runner logs for details.",
        },
      ]);
      await expectPiNotCalled(workspace);
    } finally {
      await removeWorkspace(workspace.rootDir);
    }
  });

  it("does not carry prior main comment body during pull_request publication", async () => {
    const workspace = await createCommandWorkspace({ checkoutBaseBeforeRun: true });
    try {
      const result = await runPullRequestAction(workspace, {
        githubPublicationClient: fakeGitHubPublicationClient(workspace, [
          {
            id: 10,
            body: priorMainCommentBody(),
            authorLogin: "github-actions[bot]",
          },
        ]),
      });

      expect(result).toMatchObject({ kind: "review" });
      expect(result.kind === "review" ? result.review.mainComment : "").not.toContain(
        "Prior preserved section.",
      );
    } finally {
      await removeWorkspace(workspace.rootDir);
    }
  });

  it("skips publication when no change request task is registered", async () => {
    const workspace = await createCommandWorkspace({
      baseConfigTs: reviewConfigTs({ event: false }),
      checkoutBaseBeforeRun: true,
    });
    try {
      const result = await runPullRequestAction(workspace, {
        githubPublicationClient: failingGitHubPublishingClient(),
      });

      expect(result).toMatchObject({ kind: "ignored" });
      expect(result.kind === "ignored" ? result.reason : "").toContain(
        "No tasks matched the change request event",
      );
      await expectPiNotCalled(workspace);
    } finally {
      await removeWorkspace(workspace.rootDir);
    }
  });

  it("logs the trusted config and publication result as notices", async () => {
    const workspace = await createCommandWorkspace({ checkoutBaseBeforeRun: true });
    const logs = memoryRuntimeLogSink();
    try {
      const result = await runPullRequestAction(workspace, { logSink: logs.logSink });

      expect(result).toMatchObject({ kind: "review" });
      expect(logs.records).toContainEqual(
        expect.objectContaining({
          level: "notice",
          event: "trusted config",
          fields: expect.objectContaining({
            source: ".pipr/config.ts",
            trustedConfigSha: workspace.baseSha.slice(0, 12),
          }),
        }),
      );
      expect(logs.notices.join("\n")).toContain('"event":"publication result"');
    } finally {
      await removeWorkspace(workspace.rootDir);
    }
  });

  it("logs config version warnings and publishes compatibility metadata for pull requests", async () => {
    const workspace = await createCommandWorkspace({
      checkoutBaseBeforeRun: true,
      sdkVersion: "0.1.0",
    });
    const logs = memoryRuntimeLogSink();
    try {
      const result = await runPullRequestAction(workspace, { logSink: logs.logSink });

      expect(result).toMatchObject({ kind: "review" });
      if (result.kind !== "review") {
        throw new Error(`Expected review result, received ${result.kind}`);
      }
      expect(logs.messages.join("\n")).toContain('"event":"config warning"');
      expect(logs.messages.join("\n")).toContain(".pipr/package.json pins @usepipr/sdk 0.1.0");
      expect(result.review.publicationPlan.metadata.configVersion).toBe("0.1.0");
      expect(result.review.mainComment).toContain(
        `Config SDK 0.1.0 is behind [Pipr ${runtimeVersion}](https://github.com/somus/pipr/releases/tag/v${runtimeVersion}).`,
      );
    } finally {
      await removeWorkspace(workspace.rootDir);
    }
  });

  it("fails pull request host runs before Pi when the config SDK pin is newer than Pipr", async () => {
    const workspace = await createCommandWorkspace({
      checkoutBaseBeforeRun: true,
      sdkVersion: "999.0.0",
    });
    try {
      await expect(runPullRequestAction(workspace)).rejects.toThrow(
        "Upgrade Pipr before running this config",
      );
      await expectPiNotCalled(workspace);
    } finally {
      await removeWorkspace(workspace.rootDir);
    }
  });

  it("fails pull request host runs before Pi when aggregate patch output exceeds 16 MiB", async () => {
    const workspace = await createCommandWorkspace({
      aggregatePatchOver16MiB: true,
      checkoutBaseBeforeRun: true,
    });
    try {
      await expect(runPullRequestAction(workspace)).rejects.toThrow(
        "Diff Manifest construction exceeded aggregate patch limit before parsing; limit=16777216 bytes",
      );
      await expectPiNotCalled(workspace);
    } finally {
      await removeWorkspace(workspace.rootDir);
    }
  });

  it("logs bounded Pi failure snippets without leaking secret env values", async () => {
    const workspace = await createCommandWorkspace({ checkoutBaseBeforeRun: true });
    const logs = memoryRuntimeLogSink();
    const secret = "super-secret-deepseek-key";
    const traceDirectory = path.join(workspace.rootDir, "traces");
    const finalized: Array<{ executionId: string; outcome: string }> = [];
    try {
      await writeFailingPiOutput(workspace);
      const eventPath = path.join(workspace.rootDir, "event.json");
      await writePullRequestEvent(eventPath, workspace);

      await expect(
        runTestHostCommand({
          rootDir: workspace.rootDir,
          configDir: ".pipr",
          eventPath,
          dryRun: false,
          env: {
            ...pullRequestEnv(workspace.rootDir, eventPath),
            DEEPSEEK_API_KEY: secret,
            PIPR_RUN_STORE_DIR: traceDirectory,
          },
          githubPublicationClient: fakeGitHubPublicationClient(workspace),
          piProviderModule: workspace.pi.providerModule,
          logSink: logs.logSink,
          onRunBundleFinalized(bundle) {
            finalized.push(bundle);
          },
        }),
      ).rejects.toThrow("Pi agent failed (model_error)");

      const output = logs.messages.join("\n");
      expect(output).toContain('"event":"pi failure"');
      expect(output).toContain("| ***");
      expect(output).toContain("| model exploded");
      expect(output).not.toContain(secret);
      expect(finalized).toEqual([
        expect.objectContaining({ outcome: "failed", executionId: expect.any(String) }),
      ]);
      const manifest = parseRunBundleManifest(
        JSON.parse(
          await readFile(
            path.join(traceDirectory, finalized[0]?.executionId ?? "", "run.json"),
            "utf8",
          ),
        ),
      );
      expect(manifest).toMatchObject({
        outcome: "failed",
        failureCategory: "agent-exit",
        capture: { completeness: "complete" },
      });
    } finally {
      await removeWorkspace(workspace.rootDir);
    }
  });

  it("keeps redacted Pi failure snippets in thrown errors when no log sink is installed", async () => {
    const workspace = await createCommandWorkspace({ checkoutBaseBeforeRun: true });
    const secret = "super-secret-deepseek-key";
    try {
      await writeFailingPiOutput(workspace);
      const eventPath = path.join(workspace.rootDir, "event.json");
      await writePullRequestEvent(eventPath, workspace);

      let thrown: unknown;
      try {
        await runTestHostCommand({
          rootDir: workspace.rootDir,
          configDir: ".pipr",
          eventPath,
          dryRun: false,
          env: { ...pullRequestEnv(workspace.rootDir, eventPath), DEEPSEEK_API_KEY: secret },
          githubPublicationClient: fakeGitHubPublicationClient(workspace),
          piProviderModule: workspace.pi.providerModule,
        });
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(Error);
      const message = thrown instanceof Error ? thrown.message : String(thrown);
      expect(message).toContain("Pi agent failed (model_error)");
      expect(message).toContain("| ***");
      expect(message).toContain("| model exploded");
      expect(message).not.toContain(secret);
    } finally {
      await removeWorkspace(workspace.rootDir);
    }
  });
});

describe("runHostRunCommand provider credentials", () => {
  const deepseekModel =
    'pipr.model("deepseek/deepseek-reasoner", { apiKey: pipr.secret({ name: "DEEPSEEK_API_KEY" }), thinking: "high" })';

  async function runWithProviderEnv(
    model: string,
    providerEnv: NodeJS.ProcessEnv,
    options: { failWith?: string; logSink?: RuntimeLogSink } = {},
  ) {
    const workspace = await createCommandWorkspace({
      baseConfigTs: reviewConfigTs().replace(deepseekModel, model),
      checkoutBaseBeforeRun: true,
    });
    await workspace.pi.script({
      models: ["amazon-bedrock/claude-test", "deepseek/deepseek-reasoner"],
      responses: [
        options.failWith
          ? { error: options.failWith }
          : { text: '{"summary":{"body":"No findings."},"inlineFindings":[]}' },
      ],
    });
    const eventPath = path.join(workspace.rootDir, "event.json");
    await writePullRequestEvent(eventPath, workspace);
    const {
      DEEPSEEK_API_KEY: _key,
      FAST_DEEPSEEK_API_KEY: _fast,
      ...hostEnv
    } = pullRequestEnv(workspace.rootDir, eventPath);
    const result = runTestHostCommand({
      rootDir: workspace.rootDir,
      configDir: ".pipr",
      eventPath,
      dryRun: false,
      env: { ...hostEnv, ...providerEnv },
      githubPublicationClient: fakeGitHubPublicationClient(workspace),
      piProviderModule: workspace.pi.providerModule,
      logSink: options.logSink,
    });
    return { workspace, result };
  }

  it("runs a Bedrock review with only AWS access keys", async () => {
    const { workspace, result } = await runWithProviderEnv(
      'pipr.model("amazon-bedrock/claude-test")',
      { AWS_ACCESS_KEY_ID: "access-key-id", AWS_SECRET_ACCESS_KEY: "secret-access-key" },
    );
    try {
      await expect(result).resolves.toMatchObject({ kind: "review" });
    } finally {
      await removeWorkspace(workspace.rootDir);
    }
  });

  it("treats empty fallback credentials as missing", async () => {
    const { workspace, result } = await runWithProviderEnv(
      'pipr.model("amazon-bedrock/claude-test")',
      { AWS_ACCESS_KEY_ID: "", AWS_SECRET_ACCESS_KEY: "" },
    );
    try {
      await expect(result).rejects.toThrow("Missing provider env vars: AWS_BEARER_TOKEN_BEDROCK");
      await expectPiNotCalled(workspace);
    } finally {
      await removeWorkspace(workspace.rootDir);
    }
  });

  it("redacts a custom-named provider apiKey from pull request logs", async () => {
    const secret = "custom-named-provider-secret";
    const logs = memoryRuntimeLogSink();
    const { workspace, result } = await runWithProviderEnv(
      'pipr.model("deepseek/deepseek-reasoner", { apiKey: pipr.secret({ name: "FOO" }) })',
      { FOO: secret },
      { failWith: `\${env:FOO}\nmodel exploded`, logSink: logs.logSink },
    );
    try {
      await expect(result).rejects.toThrow("Pi agent failed");
      const output = logs.messages.join("\n");
      expect(output).toContain("model exploded");
      expect(output).not.toContain(secret);
    } finally {
      await removeWorkspace(workspace.rootDir);
    }
  });
});

function supersedeProgressComment(
  issueComments: Array<{ id: number; body: string; authorLogin: string }>,
): void {
  const comment = issueComments[0];
  if (!comment) throw new Error("expected progress comment");
  comment.body = comment.body.replace(
    /token=[A-Za-z0-9-]+/,
    "token=00000000-0000-4000-8000-000000000000",
  );
}

describe("runHostRunCommand finding outcomes", () => {
  it("returns Finding Outcome events from an opened review and its synchronize follow-up", async () => {
    const workspace = await createCommandWorkspace({
      checkoutBaseBeforeRun: true,
      baseConfigTs: reviewConfigTs().replace(
        'changeRequest: ["opened"]',
        'changeRequest: ["opened", "updated"]',
      ),
    });
    const traceDirectory = path.join(workspace.rootDir, "traces");
    const github = statefulGitHubPublicationClient(workspace);
    const bundles: string[] = [];
    const run = async (action: "opened" | "synchronize") => {
      const eventPath = path.join(workspace.rootDir, `${action}.json`);
      await writeChangeRequestEvent(eventPath, workspace, action);
      const result = await runTestHostCommand({
        rootDir: workspace.rootDir,
        configDir: ".pipr",
        eventPath,
        dryRun: false,
        env: {
          ...pullRequestEnv(workspace.rootDir, eventPath),
          PIPR_RUN_STORE_DIR: traceDirectory,
        },
        githubPublicationClient: github.client,
        piProviderModule: workspace.pi.providerModule,
        onRunBundleFinalized(bundle) {
          bundles.push(bundle.directory);
        },
      });
      if (result.kind !== "review") throw new Error(`Expected review, received ${result.kind}`);
      return result;
    };
    try {
      await workspace.pi.answer(
        JSON.stringify({
          summary: { body: "One issue." },
          inlineFindings: [
            { ...changedLineFinding, body: "Unchecked value." },
            {
              ...changedLineFinding,
              path: "src/missing.ts",
              rangeId: "missing",
              body: "Phantom.",
            },
          ],
        }),
      );
      const opened = await run("opened");
      const publishedId = opened.publication.postedFindingIds[0];
      expect(opened.findingEvents.map((event) => [event.kind, event.reasonCode])).toEqual([
        ["proposed", undefined],
        ["proposed", undefined],
        ["dropped", "unknown-range"],
        ["published", undefined],
      ]);
      expect(opened.findingEvents.at(-1)).toMatchObject({
        findingId: publishedId,
        workId: opened.review.run.id,
        headSha: workspace.headSha,
        agent: "reviewer",
        configHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      });
      expect(github.reviewComments[0]?.body).toContain(`id=${publishedId}`);
      expect(JSON.stringify(opened.findingEvents)).not.toContain("src/missing.ts");
      const ledger = JSON.parse(
        await readFile(path.join(bundles[0] ?? "", "artifacts", "ledger.json"), "utf8"),
      );
      expect(ledger.events).toEqual(opened.findingEvents);
      expect(Object.values(ledger.evidence).map((item) => (item as { path: string }).path)).toEqual(
        ["src/a.ts", "src/missing.ts"],
      );

      runGitCommand(["checkout", "--detach", workspace.headSha], workspace.rootDir);
      await Bun.write(path.join(workspace.rootDir, "src", "a.ts"), "export const value = 3;\n");
      runGitCommand(["commit", "--no-verify", "-am", "fix"], workspace.rootDir);
      workspace.headSha = currentGitHead(workspace.rootDir);
      runGitCommand(["checkout", "--detach", workspace.baseSha], workspace.rootDir);
      await workspace.pi.script({
        responses: [{ text: '{"summary":{"body":"No findings."},"inlineFindings":[]}' }],
        rules: [
          {
            when: { promptIncludes: "currentHeadSha" },
            response: {
              text: JSON.stringify({ findings: [{ id: publishedId, status: "fixed" }] }),
            },
          },
        ],
      });
      const synchronized = await run("synchronize");

      expect(
        synchronized.findingEvents.map((event) => [event.kind, event.findingId, event.headSha]),
      ).toEqual([["fixed", publishedId, workspace.headSha]]);
      expect(synchronized.findingEvents[0]?.eventId).not.toBe(opened.findingEvents[0]?.eventId);
    } finally {
      await removeWorkspace(workspace.rootDir);
    }
  });
});

describe("runHostRunCommand finding outcomes after a failure", () => {
  it("reports the outcomes recorded before a partial publication failure", async () => {
    const workspace = await createCommandWorkspace({ checkoutBaseBeforeRun: true });
    const github = statefulGitHubPublicationClient(workspace);
    const createReviewComment = github.client.createReviewComment.bind(github.client);
    let inlineWrites = 0;
    github.client.createReviewComment = async (options) => {
      inlineWrites += 1;
      if (inlineWrites === 2) throw new Error("inline comment rejected");
      return await createReviewComment(options);
    };
    const reported: HostRunFindingEvents[] = [];
    const eventPath = path.join(workspace.rootDir, "opened.json");
    await writeChangeRequestEvent(eventPath, workspace, "opened");
    try {
      await workspace.pi.answer(
        JSON.stringify({
          summary: { body: "Two issues." },
          inlineFindings: [
            { ...changedLineFinding, body: "First issue." },
            {
              ...changedLineFinding,
              path: ".pipr/config.ts",
              startLine: 3,
              endLine: 3,
              body: "Second issue.",
            },
          ],
        }),
      );
      await expect(
        runTestHostCommand({
          rootDir: workspace.rootDir,
          configDir: ".pipr",
          eventPath,
          dryRun: false,
          env: pullRequestEnv(workspace.rootDir, eventPath),
          githubPublicationClient: github.client,
          piProviderModule: workspace.pi.providerModule,
          onFindingEvents(findings) {
            reported.push(findings);
          },
        }),
      ).rejects.toThrow("inline comment publication failed");

      expect(reported).toHaveLength(1);
      expect(reported[0]).toMatchObject({
        repository: "local/pipr",
        threadResolution: "available",
      });
      expect(reported[0]?.events.map((event) => event.kind)).toEqual([
        "proposed",
        "proposed",
        "published",
      ]);
    } finally {
      await removeWorkspace(workspace.rootDir);
    }
  });
});

describe("runHostRunCommand finding outcome history", () => {
  it("carries outcome history across opened, reply, and synchronize runs", async () => {
    const workspace = await createCommandWorkspace({
      checkoutBaseBeforeRun: true,
      baseConfigTs: reviewConfigTs().replace(
        'changeRequest: ["opened"]',
        'changeRequest: ["opened", "updated"]',
      ),
    });
    const traceDirectory = path.join(workspace.rootDir, "traces");
    const github = statefulGitHubPublicationClient(workspace);
    const bundles: string[] = [];
    const run = async (eventName: "pull_request" | "pull_request_review_comment") => {
      const eventPath = path.join(workspace.rootDir, `${eventName}.json`);
      const env =
        eventName === "pull_request"
          ? pullRequestEnv(workspace.rootDir, eventPath)
          : reviewCommentEnv(workspace.rootDir, eventPath);
      return await runTestHostCommand({
        rootDir: workspace.rootDir,
        configDir: ".pipr",
        eventPath,
        dryRun: false,
        env: { ...env, PIPR_RUN_STORE_DIR: traceDirectory },
        githubClient: fakeGitHubClient(workspace, "write"),
        githubPublicationClient: github.client,
        piProviderModule: workspace.pi.providerModule,
        onRunBundleFinalized(bundle) {
          bundles.push(bundle.directory);
        },
      });
    };
    const review = async (action: "opened" | "synchronize") => {
      await writeChangeRequestEvent(
        path.join(workspace.rootDir, "pull_request.json"),
        workspace,
        action,
      );
      const result = await run("pull_request");
      if (result.kind !== "review") throw new Error(`Expected review, received ${result.kind}`);
      return result;
    };
    const issueComments: string[] = [];
    const storedHistory = () =>
      extractPriorReviewState(issueComments.at(-1), 1)?.findings.map((record) => [
        record.id,
        record.h,
      ]);
    const createIssueComment = github.client.createIssueComment;
    github.client.createIssueComment = async (options) => {
      issueComments.push(options.body);
      return await createIssueComment(options);
    };
    const updateIssueComment = github.client.updateIssueComment;
    github.client.updateIssueComment = async (options) => {
      issueComments.push(options.body);
      return await updateIssueComment(options);
    };
    try {
      await workspace.pi.answer(
        JSON.stringify({
          summary: { body: "One issue." },
          inlineFindings: [{ ...changedLineFinding, body: "Unchecked value." }],
        }),
      );
      const opened = await review("opened");
      const findingId = opened.publication.postedFindingIds[0] ?? "";
      const head1 = workspace.headSha.slice(0, 12);
      expect(storedHistory()).toEqual([[findingId, [["p", head1]]]]);
      const openedLedger = JSON.parse(
        await readFile(path.join(bundles[0] ?? "", "artifacts", "ledger.json"), "utf8"),
      );
      expect(openedLedger.threadResolution).toBe("available");

      const parentId = github.reviewComments[0]?.id ?? 0;
      const replyId = github.humanReply(parentId, "The caller validates this earlier.");
      await writeReviewCommentEvent(
        path.join(workspace.rootDir, "pull_request_review_comment.json"),
        {
          commentId: replyId,
          parentCommentId: parentId,
        },
      );
      await workspace.pi.answer(
        JSON.stringify({
          findings: [{ id: findingId, status: "still-valid", response: "Still applies." }],
        }),
      );
      const replied = await run("pull_request_review_comment");
      if (replied.kind !== "verifier") throw new Error(`Expected verifier, got ${replied.kind}`);
      expect(replied.findingEvents.map((event) => [event.kind, event.actorPermission])).toEqual([
        ["replied", "write"],
        ["still-valid", undefined],
      ]);

      github.humanResolve(parentId);
      runGitCommand(["checkout", "--detach", workspace.headSha], workspace.rootDir);
      await Bun.write(path.join(workspace.rootDir, "src", "a.ts"), "export const value = 3;\n");
      runGitCommand(["commit", "--no-verify", "-am", "rename"], workspace.rootDir);
      workspace.headSha = currentGitHead(workspace.rootDir);
      runGitCommand(["checkout", "--detach", workspace.baseSha], workspace.rootDir);
      await workspace.pi.answer('{"summary":{"body":"No findings."},"inlineFindings":[]}');
      const synchronized = await review("synchronize");

      expect(
        synchronized.findingEvents.map((event) => [
          event.kind,
          event.findingId,
          event.actorPermission,
        ]),
      ).toEqual([
        ["replied", findingId, "unknown"],
        ["still-valid", findingId, undefined],
        ["resolved-by-human", findingId, undefined],
      ]);
      expect(synchronized.findingEvents.slice(0, 2).map((event) => event.eventId)).toEqual(
        replied.findingEvents.map((event) => event.eventId),
      );
      expect(synchronized.findingEvents[2]).toMatchObject({ agent: "reviewer" });
      expect(storedHistory()).toEqual([
        [
          findingId,
          [
            ["p", head1],
            ["r", head1],
            ["s", head1],
            ["h", head1],
          ],
        ],
      ]);

      await workspace.pi.answer('{"summary":{"body":"No findings."},"inlineFindings":[]}');
      const rerun = await review("synchronize");
      expect(rerun.findingEvents).toEqual([]);
    } finally {
      await removeWorkspace(workspace.rootDir);
    }
  });
});

const changedLineFinding = {
  path: "src/a.ts",
  rangeId: "unknown",
  side: "RIGHT",
  startLine: 1,
  endLine: 1,
} as const;

async function writeChangeRequestEvent(
  eventPath: string,
  workspace: Awaited<ReturnType<typeof createCommandWorkspace>>,
  action: "opened" | "synchronize",
): Promise<void> {
  await Bun.write(
    eventPath,
    JSON.stringify({
      action,
      number: 1,
      repository: { full_name: "local/pipr" },
      pull_request: {
        number: 1,
        title: "Test PR",
        body: "Test body",
        base: { sha: workspace.baseSha, repo: { full_name: "local/pipr" } },
        head: { sha: workspace.headSha },
      },
    }),
  );
}

/** A GitHub publication fake that keeps posted inline comments and threads across runs. */
function statefulGitHubPublicationClient(
  workspace: Awaited<ReturnType<typeof createCommandWorkspace>>,
) {
  const client = fakeGitHubPublicationClient(workspace);
  const reviewComments: Awaited<ReturnType<typeof client.listReviewComments>> = [];
  const threads: Array<{ id: string; isResolved: boolean; commentIds: number[] }> = [];
  const addComment = (body: string, authorLogin: string, inReplyTo?: number) => {
    const id = 100 + reviewComments.length;
    reviewComments.push({
      id,
      body,
      authorLogin,
      path: undefined,
      commitId: undefined,
      line: undefined,
      startLine: undefined,
      side: undefined,
      startSide: undefined,
    });
    const thread = threads.find((item) => inReplyTo && item.commentIds.includes(inReplyTo));
    if (thread) thread.commentIds.push(id);
    else threads.push({ id: `thread-${id}`, isResolved: false, commentIds: [id] });
    return id;
  };
  client.listReviewComments = async () => reviewComments;
  client.listReviewThreads = async () =>
    threads.map((thread) => ({ ...thread, viewerCanResolve: true }));
  client.createReviewComment = async (options) => {
    const id = addComment(options.body, "github-actions[bot]");
    Object.assign(reviewComments.at(-1) ?? {}, {
      path: options.path,
      commitId: options.commit_id,
      line: options.line,
      startLine: options.start_line,
      side: options.side,
      startSide: options.start_side,
    });
    return { id };
  };
  client.createReviewCommentReply = async (options) => ({
    id: addComment(options.body, "github-actions[bot]", options.commentId),
  });
  client.resolveReviewThread = async (options) => {
    const thread = threads.find((item) => item.id === options.threadId);
    if (thread) thread.isResolved = true;
  };
  return {
    client,
    reviewComments,
    /** A human reply in the thread of `commentId`. */
    humanReply: (commentId: number, body: string) => addComment(body, "somu", commentId),
    /** A human resolving the thread of `commentId` in the host UI. */
    humanResolve(commentId: number) {
      const thread = threads.find((item) => item.commentIds.includes(commentId));
      if (thread) thread.isResolved = true;
    },
  };
}
