import { describe, expect, it } from "bun:test";
import { mkdtemp, readdir, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseRunBundleManifest } from "@usepipr/sdk";
import { runGit as runGitCommand } from "../../diff/git.js";
import { runtimeVersion } from "../../shared/version.js";
import { memoryRuntimeLogSink } from "../../tests/helpers/runtime-log-sink.js";
import type { FakeCheckRuns } from "./commands-fixtures.js";
import {
  clearGitConfigEnv,
  createCommandWorkspace,
  currentGitHead,
  expectPiNotCalled,
  expectReviewRanAtHead,
  explicitModelIdConfigTs,
  failingGitHubPublishingClient,
  fakeGitHubPublicationClient,
  maliciousHeadConfigTs,
  multiTaskCheckConfigTs,
  priorMainCommentBody,
  pullRequestEnv,
  removeWorkspace,
  restoreEnv,
  restoreGitConfigEnv,
  reviewConfigTs,
  runPullRequestAction,
  runTestHostCommand,
  snapshotGitConfigEnv,
  writeFailingPiExecutable,
  writePiExecutable,
  writePullRequestEvent,
} from "./commands-fixtures.js";

describe("runHostRunCommand pull_request dispatch", () => {
  it("captures hosted reviews by default with provider and work identities", async () => {
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
        piExecutable: workspace.piExecutable,
        onRunBundleFinalized(bundle) {
          finalized.push(bundle);
        },
      });
      if (result.kind !== "review") throw new Error(`Expected review, received ${result.kind}`);

      const [executionId] = await readdir(traceDirectory);
      const manifest = parseRunBundleManifest(
        JSON.parse(
          await readFile(path.join(traceDirectory, executionId ?? "", "run.json"), "utf8"),
        ),
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
        export: { externalUpload: "pending" },
      });
      expect(finalized).toEqual([
        expect.objectContaining({
          executionId,
          directory: path.join(traceDirectory, executionId ?? ""),
        }),
      ]);
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
        piExecutable: workspace.piExecutable,
      });

      await expect(readdir(traceDirectory)).rejects.toThrow();
    } finally {
      await removeWorkspace(workspace.rootDir);
    }
  });

  it("records nested lifecycle phases and model attempts as timed spans", async () => {
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
          GITHUB_ACTIONS: "true",
          PIPR_RUN_STORE_DIR: traceDirectory,
        },
        githubPublicationClient: fakeGitHubPublicationClient(workspace),
        piExecutable: workspace.piExecutable,
      });

      const [executionId] = await readdir(traceDirectory);
      const spans = (
        await readFile(path.join(traceDirectory, executionId ?? "", "spans.jsonl"), "utf8")
      )
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
          "pipr.publish.review",
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
          PIPR_RUN_STORE_DIR: traceDirectory,
        },
        githubPublicationClient: fakeGitHubPublicationClient(workspace),
        piExecutable: workspace.piExecutable,
      });

      const [executionId] = await readdir(traceDirectory);
      const bundleDirectory = path.join(traceDirectory, executionId ?? "");
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
        '{"summary":{"body":"No findings."},"inlineFindings":[]}\n',
      );
    } finally {
      await removeWorkspace(workspace.rootDir);
    }
  });

  it("records tool timing and first response without retaining Pi event payloads", async () => {
    const workspace = await createCommandWorkspace({ checkoutBaseBeforeRun: true });
    const traceDirectory = path.join(workspace.rootDir, "traces");
    try {
      await writePiExecutable(
        workspace.piExecutable,
        [
          JSON.stringify({
            type: "tool_execution_start",
            toolCallId: "tool-1",
            toolName: "grep",
            args: { query: "do-not-store" },
          }),
          JSON.stringify({
            type: "tool_execution_end",
            toolCallId: "tool-1",
            toolName: "grep",
            result: "do-not-store",
          }),
          JSON.stringify({
            type: "message_end",
            message: {
              role: "assistant",
              model: "deepseek-reasoner",
              content: [
                {
                  type: "text",
                  text: '{"summary":{"body":"No findings."},"inlineFindings":[]}',
                },
              ],
              usage: { input: 10, output: 4, cost: { total: 0.001 } },
            },
          }),
        ].join("\n"),
      );
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
          PIPR_RUN_STORE_DIR: traceDirectory,
        },
        githubPublicationClient: fakeGitHubPublicationClient(workspace),
        piExecutable: workspace.piExecutable,
      });

      const [executionId] = await readdir(traceDirectory);
      const bundleDirectory = path.join(traceDirectory, executionId ?? "");
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
          expect.objectContaining({ name: "gen_ai.time_to_first_token" }),
        ]),
      );
      const bundleText = (
        await Promise.all(
          (
            await readdir(bundleDirectory, { recursive: true, withFileTypes: true })
          )
            .filter((entry) => entry.isFile())
            .map((entry) => readFile(path.join(entry.parentPath, entry.name), "utf8")),
        )
      ).join("\n");
      expect(bundleText).not.toContain("do-not-store");
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
        piExecutable: workspace.piExecutable,
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
        piExecutable: workspace.piExecutable,
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
    const workspace = await createCommandWorkspace({ checkoutBaseBeforeRun: true });
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
          piExecutable: workspace.piExecutable,
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
          piExecutable: workspace.piExecutable,
        }),
      ).rejects.toThrow("Change request head changed");

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

  it("logs host run, event, config, diff, task, Pi, and publication breadcrumbs", async () => {
    const workspace = await createCommandWorkspace({ checkoutBaseBeforeRun: true });
    const logs = memoryRuntimeLogSink();
    try {
      const result = await runPullRequestAction(workspace, { logSink: logs.logSink });

      expect(result).toMatchObject({ kind: "review" });
      const output = logs.messages.join("\n");
      expect(output).toContain('"event":"host run start"');
      expect(output).toContain('"eventName":"pull_request"');
      expect(output).toContain('"platform":"github"');
      expect(output).toContain('"event":"trusted config"');
      expect(output).toContain('"event":"diff manifest"');
      expect(output).toContain('"event":"task start"');
      expect(output).toContain('"task":"review"');
      expect(output).toContain('"event":"pi start"');
      expect(output).toContain('"event":"pi run"');
      expect(output).toContain('"event":"publication result"');
      expect(logs.notices.join("\n")).toContain('"event":"publication result"');
      expect(logs.groups).toContain("pipr host run");
      expect(logs.groups).toContain("publish review");
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
      await writeFailingPiExecutable(workspace.piExecutable);
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
          piExecutable: workspace.piExecutable,
          logSink: logs.logSink,
          onRunBundleFinalized(bundle) {
            finalized.push(bundle);
          },
        }),
      ).rejects.toThrow("Pi agent failed with exit 42");

      const output = logs.messages.join("\n");
      expect(output).toContain('"event":"pi stderr"');
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
      await writeFailingPiExecutable(workspace.piExecutable);
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
          piExecutable: workspace.piExecutable,
        });
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(Error);
      const message = thrown instanceof Error ? thrown.message : String(thrown);
      expect(message).toContain("Pi agent failed with exit 42");
      expect(message).toContain("| ***");
      expect(message).toContain("| model exploded");
      expect(message).not.toContain(secret);
    } finally {
      await removeWorkspace(workspace.rootDir);
    }
  });
});
