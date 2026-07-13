import { describe, expect, it } from "bun:test";
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
import {
  renderInlineFindingMarker,
  renderResolvedFindingMarker,
  renderVerifierResponseMarker,
} from "../../review/prior-state.js";
import { runtimeVersion } from "../../shared/version.js";
import { memoryRuntimeLogSink } from "../../tests/helpers/runtime-log-sink.js";
import {
  type RuntimeLogSink,
  runHostRunCommandWithDependencies as runHostRun,
  runLocalReviewCommand,
} from "../commands.js";

type TestHostRunOptions = Omit<Parameters<typeof runHostRun>[0], "hostAdapter"> & {
  hostAdapter?: CodeHostAdapter;
  githubClient?: GitHubCommandClient;
  githubPublicationClient?: GitHubPublicationClient;
};

function runHostRunCommandWithDependencies(options: TestHostRunOptions) {
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

describe("runHostRunCommand issue_comment dispatch", () => {
  it("ignores command events when the adapter disables command comments", async () => {
    const workspace = await createCommandWorkspace();
    const eventPath = path.join(workspace.rootDir, "event.json");
    await writeIssueCommentEvent(eventPath, "@pipr review", "created", 123);
    try {
      const result = await runHostRunCommandWithDependencies({
        rootDir: workspace.rootDir,
        configDir: ".pipr",
        eventPath,
        dryRun: false,
        env: issueCommentEnv(workspace.rootDir, eventPath),
        hostAdapter: githubAdapterWithCapabilities(workspace, { commandComments: false }),
        piExecutable: workspace.piExecutable,
      });

      expect(result).toEqual({ kind: "ignored", reason: "host adapter does not support commands" });
      await expectPiNotCalled(workspace);
    } finally {
      await removeWorkspace(workspace.rootDir);
    }
  });

  it("ignores issue comments that are not pull request comments", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "pipr-host-run-command-"));
    try {
      const eventPath = path.join(rootDir, "event.json");
      await Bun.write(
        eventPath,
        JSON.stringify({
          action: "created",
          repository: { full_name: "local/pipr" },
          issue: { number: 1 },
          comment: { id: 123, body: "@pipr review", user: { login: "somu" } },
        }),
      );

      await expect(
        runHostRunCommandWithDependencies({
          rootDir,
          configDir: ".pipr",
          eventPath,
          dryRun: false,
          env: issueCommentEnv(rootDir, eventPath),
          githubClient: failingGitHubClient(),
        }),
      ).resolves.toMatchObject({
        kind: "ignored",
        reason: "issue_comment did not target a pull request",
      });
    } finally {
      await removeWorkspace(rootDir);
    }
  });

  it("returns command help for invalid arguments without running Pi", async () => {
    const workspace = await createCommandWorkspace();
    try {
      const result = await runIssueCommentCommand(workspace, "@pipr review --scope all", "write");

      expect(result).toMatchObject({
        kind: "command-help",
        reason: "Input 'scope' must be one of: changed, full",
      });
      expect(result.kind === "command-help" ? result.body : "").toContain("@pipr review");
      await expectPiNotCalled(workspace);
    } finally {
      await removeWorkspace(workspace.rootDir);
    }
  });

  it("returns command help for ask without a question without running Pi", async () => {
    const workspace = await createCommandWorkspace({ baseConfigTs: askConfigTs() });
    try {
      const result = await runIssueCommentCommand(workspace, "@pipr ask", "read");

      expect(result).toMatchObject({
        kind: "command-help",
        reason: "Expected '<question...>'",
      });
      await expectPiNotCalled(workspace);
    } finally {
      await removeWorkspace(workspace.rootDir);
    }
  });

  it("skips issue comment command dispatch in dry-run mode without calling GitHub", async () => {
    const workspace = await createCommandWorkspace();
    try {
      const eventPath = path.join(workspace.rootDir, "event.json");
      await writeIssueCommentEvent(eventPath, "@pipr review");

      await expect(
        runHostRunCommandWithDependencies({
          rootDir: workspace.rootDir,
          configDir: ".pipr",
          eventPath,
          dryRun: true,
          env: issueCommentEnv(workspace.rootDir, eventPath),
          githubClient: failingGitHubClient(),
          piExecutable: workspace.piExecutable,
        }),
      ).resolves.toMatchObject({
        kind: "ignored",
        reason: "PIPR_DRY_RUN=1; command dispatch skipped",
      });
      await expectPiNotCalled(workspace);
    } finally {
      await removeWorkspace(workspace.rootDir);
    }
  });

  it("ignores edited issue comments", async () => {
    const workspace = await createCommandWorkspace();
    try {
      const eventPath = path.join(workspace.rootDir, "event.json");
      await writeIssueCommentEvent(eventPath, "@pipr review", "edited");

      await expect(
        runHostRunCommandWithDependencies({
          rootDir: workspace.rootDir,
          configDir: ".pipr",
          eventPath,
          dryRun: false,
          env: issueCommentEnv(workspace.rootDir, eventPath),
          githubClient: failingGitHubClient(),
          githubPublicationClient: failingGitHubPublishingClient(),
          piExecutable: workspace.piExecutable,
        }),
      ).resolves.toMatchObject({
        kind: "ignored",
        reason: "issue_comment action 'edited' is not supported",
      });
    } finally {
      await removeWorkspace(workspace.rootDir);
    }
  });

  it("denies commands when commenter permission is below the task command requirement", async () => {
    const workspace = await createCommandWorkspace();
    try {
      const result = await runIssueCommentCommand(workspace, "@pipr review --scope full", "read");

      expect(result).toMatchObject({
        kind: "command-help",
        reason: "permission denied for '@pipr review --scope full'",
      });
      expect(result.kind === "command-help" ? result.body : "").toContain("requires write");
      await expectPiNotCalled(workspace);
    } finally {
      await removeWorkspace(workspace.rootDir);
    }
  });

  it("does not parse command arguments before permission passes", async () => {
    const workspace = await createCommandWorkspace({
      baseConfigTs: reviewConfigTs({ parseSideEffect: true }),
    });
    try {
      Reflect.set(globalThis, "__piprParseCalled", false);
      const result = await runIssueCommentCommand(workspace, "@pipr review --scope full", "read");

      expect(result).toMatchObject({ kind: "command-help" });
      expect(Reflect.get(globalThis, "__piprParseCalled")).toBe(false);
      await expectPiNotCalled(workspace);
    } finally {
      Reflect.deleteProperty(globalThis, "__piprParseCalled");
      await removeWorkspace(workspace.rootDir);
    }
  });

  it("returns help when a trusted base config does not register a command", async () => {
    const workspace = await createCommandWorkspace({
      baseConfigTs: reviewConfigTs({ command: false }),
      checkoutBaseBeforeRun: true,
    });
    try {
      const result = await runIssueCommentCommand(workspace, "@pipr review", "write");

      expect(result).toMatchObject({ kind: "command-help" });
      expect(result.kind === "command-help" ? result.reason : "").toContain("unknown pipr command");
      await expectPiNotCalled(workspace);
    } finally {
      await removeWorkspace(workspace.rootDir);
    }
  });

  it("executes commands from the base commit config instead of PR-head config", async () => {
    const workspace = await createCommandWorkspace({ checkoutBaseBeforeRun: true });
    const logs = memoryRuntimeLogSink();
    try {
      expect(currentGitHead(workspace.rootDir)).toBe(workspace.baseSha);
      const result = await runIssueCommentCommand(
        workspace,
        "@pipr review --scope full",
        "write",
        undefined,
        undefined,
        logs.logSink,
      );

      expect(result).toMatchObject({
        kind: "review",
        command: "review",
      });
      expect(result.kind === "review" ? result.review.validated.validFindings : []).toEqual([]);
      const output = logs.messages.join("\n");
      expect(output).toContain('"eventName":"issue_comment"');
      expect(output).toContain('"event":"parse event start"');
      expect(output).toContain('"event":"event dispatch","kind":"command-comment"');
      expect(output).toContain('"event":"command dispatch"');
      expect(output).toContain('"event":"publication result"');
      await expectReviewRanAtHead(result, workspace);
    } finally {
      await removeWorkspace(workspace.rootDir);
    }
  });

  it("publishes command replies from configured ask commands", async () => {
    const workspace = await createCommandWorkspace({
      baseConfigTs: askConfigTs(),
      checkoutBaseBeforeRun: true,
    });
    const publication = recordingCommandPublicationClient(workspace);
    await writePiExecutable(
      workspace.piExecutable,
      '{"body":"The change updates command output."}',
    );

    try {
      const result = await runIssueCommentCommand(
        workspace,
        "@pipr ask what changed?",
        "read",
        undefined,
        publication.client,
      );

      expect(result).toMatchObject({
        kind: "command-response",
        event: {
          coordinates: { provider: "github", owner: "local", repository: "pipr" },
        },
        command: "ask",
        response: {
          body: "The change updates command output.",
        },
        publication: { action: "created", id: "10" },
      });
      expect(publication.writes.created).toHaveLength(1);
      expect(publication.writes.created[0]).toContain(
        "<!-- pipr:command-response change=1 source=123 command=ask -->",
      );
      expect(publication.writes.created[0]).toContain("The change updates command output.");
      expect(publication.writes.updated).toEqual([]);
    } finally {
      await removeWorkspace(workspace.rootDir);
    }
  });

  it("keys command run ids to the source command comment", async () => {
    const workspace = await createCommandWorkspace({
      baseConfigTs: commandRunIdConfigTs(),
      checkoutBaseBeforeRun: true,
    });
    const firstPublication = recordingCommandPublicationClient(workspace);
    const repeatedPublication = recordingCommandPublicationClient(workspace);
    const changedPublication = recordingCommandPublicationClient(workspace);

    try {
      await runIssueCommentCommand(
        workspace,
        "@pipr ask what changed?",
        "read",
        undefined,
        firstPublication.client,
        undefined,
        123,
      );
      await runIssueCommentCommand(
        workspace,
        "@pipr ask what changed?",
        "read",
        undefined,
        repeatedPublication.client,
        undefined,
        123,
      );
      await runIssueCommentCommand(
        workspace,
        "@pipr ask what changed?",
        "read",
        undefined,
        changedPublication.client,
        undefined,
        456,
      );

      const firstRunId = commandResponsePayload(firstPublication.writes.created[0]);
      expect(commandResponsePayload(repeatedPublication.writes.created[0])).toBe(firstRunId);
      expect(commandResponsePayload(changedPublication.writes.created[0])).not.toBe(firstRunId);
    } finally {
      await removeWorkspace(workspace.rootDir);
    }
  });

  it("updates command replies for repeated source comments", async () => {
    const workspace = await createCommandWorkspace({
      baseConfigTs: askConfigTs(),
      checkoutBaseBeforeRun: true,
    });
    const publication = recordingCommandPublicationClient(workspace, [
      {
        id: 88,
        body: [
          "<!-- pipr:command-response change=1 source=123 command=ask -->",
          "",
          "Prior answer.",
        ].join("\n"),
        authorLogin: "github-actions[bot]",
      },
    ]);
    await writePiExecutable(workspace.piExecutable, '{"body":"Updated answer."}');

    try {
      const result = await runIssueCommentCommand(
        workspace,
        "@pipr ask what changed?",
        "read",
        undefined,
        publication.client,
      );

      expect(result).toMatchObject({
        kind: "command-response",
        publication: { action: "updated", id: "88" },
      });
      expect(publication.writes.created).toEqual([]);
      expect(publication.writes.updated).toHaveLength(1);
      expect(publication.writes.updated[0]).toContain("Updated answer.");
    } finally {
      await removeWorkspace(workspace.rootDir);
    }
  });

  it("does not create check runs for issue_comment command dispatch", async () => {
    const workspace = await createCommandWorkspace({
      baseConfigTs: reviewConfigTs({ checks: true }),
      checkoutBaseBeforeRun: true,
    });
    const checks: FakeCheckRuns = { created: [], updated: [] };
    try {
      const result = await runIssueCommentCommand(
        workspace,
        "@pipr review --scope full",
        "write",
        checks,
      );

      expect(result).toMatchObject({ kind: "review", command: "review" });
      expect(checks.created).toEqual([]);
      expect(checks.updated).toEqual([]);
    } finally {
      await removeWorkspace(workspace.rootDir);
    }
  });
});

describe("runLocalReviewCommand", () => {
  it("runs unique change-request tasks and skips local-disabled tasks", async () => {
    const workspace = await createCommandWorkspace({
      baseConfigTs: localReviewSelectionConfigTs(),
      headConfigTs: localReviewSelectionConfigTs(),
    });
    try {
      const result = await runLocalReviewCommand({
        rootDir: workspace.rootDir,
        configDir: ".pipr",
        env: { DEEPSEEK_API_KEY: "provider-key" },
        baseSha: workspace.baseSha,
        headSha: workspace.headSha,
        piExecutable: workspace.piExecutable,
      });

      expect(result.kind).toBe("review");
      if (result.kind !== "review") {
        throw new Error(`Expected local review result, received ${result.kind}`);
      }

      expect(result.mainComment).toContain("Alpha completed.");
      expect(result.publicationPlan.metadata.selectedTasks).toEqual(["alpha", "beta"]);
      expect(result.taskChecks.map((check) => check.taskName)).toEqual(["alpha", "beta"]);
      expect(await Bun.file(path.join(workspace.rootDir, "alpha-ran")).text()).toBe("1\n");
      expect(await Bun.file(path.join(workspace.rootDir, "beta-ran")).text()).toBe("1\n");
      expect(await Bun.file(path.join(workspace.rootDir, "disabled-ran")).exists()).toBe(false);
    } finally {
      await removeWorkspace(workspace.rootDir);
    }
  });

  it("logs config version warnings for local reviews", async () => {
    const workspace = await createCommandWorkspace({
      baseConfigTs: localReviewSelectionConfigTs(),
      headConfigTs: localReviewSelectionConfigTs(),
      sdkVersion: "0.1.0",
    });
    const logs = memoryRuntimeLogSink();
    try {
      const result = await runLocalReviewCommand({
        rootDir: workspace.rootDir,
        configDir: ".pipr",
        env: { DEEPSEEK_API_KEY: "provider-key" },
        baseSha: workspace.baseSha,
        headSha: workspace.headSha,
        piExecutable: workspace.piExecutable,
        logSink: logs.logSink,
      });

      expect(result.kind).toBe("review");
      expect(logs.messages.join("\n")).toContain('"event":"config warning"');
      expect(logs.messages.join("\n")).toContain(".pipr/package.json pins @usepipr/sdk 0.1.0");
    } finally {
      await removeWorkspace(workspace.rootDir);
    }
  });

  it("fails local reviews before Pi when the config SDK pin is newer than Pipr", async () => {
    const workspace = await createCommandWorkspace({
      baseConfigTs: localReviewSelectionConfigTs(),
      headConfigTs: localReviewSelectionConfigTs(),
      sdkVersion: "999.0.0",
    });
    try {
      await expect(
        runLocalReviewCommand({
          rootDir: workspace.rootDir,
          configDir: ".pipr",
          env: { DEEPSEEK_API_KEY: "provider-key" },
          baseSha: workspace.baseSha,
          headSha: workspace.headSha,
          piExecutable: workspace.piExecutable,
        }),
      ).rejects.toThrow("Upgrade Pipr before running this config");
      await expectPiNotCalled(workspace);
    } finally {
      await removeWorkspace(workspace.rootDir);
    }
  });
});

describe("runHostRunCommand pull_request dispatch", () => {
  it("marks the GitHub Action workspace as a git safe directory before trusted config reads", async () => {
    const workspace = await createCommandWorkspace();
    const gitConfigDir = await mkdtemp(path.join(os.tmpdir(), "pipr-host-run-gitconfig-"));
    const previousHome = process.env.HOME;
    const previousGitConfigEnv = snapshotGitConfigEnv();
    try {
      clearGitConfigEnv(previousGitConfigEnv);
      const eventPath = path.join(workspace.rootDir, "event.json");
      await writePullRequestEvent(eventPath, workspace);

      const result = await runHostRunCommandWithDependencies({
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

      const result = await runHostRunCommandWithDependencies({
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

  it("logs bounded Pi failure snippets without leaking secret env values", async () => {
    const workspace = await createCommandWorkspace({ checkoutBaseBeforeRun: true });
    const logs = memoryRuntimeLogSink();
    const secret = "super-secret-deepseek-key";
    try {
      await writeFailingPiExecutable(workspace.piExecutable);
      const eventPath = path.join(workspace.rootDir, "event.json");
      await writePullRequestEvent(eventPath, workspace);

      await expect(
        runHostRunCommandWithDependencies({
          rootDir: workspace.rootDir,
          configDir: ".pipr",
          eventPath,
          dryRun: false,
          env: { ...pullRequestEnv(workspace.rootDir, eventPath), DEEPSEEK_API_KEY: secret },
          githubPublicationClient: fakeGitHubPublicationClient(workspace),
          piExecutable: workspace.piExecutable,
          logSink: logs.logSink,
        }),
      ).rejects.toThrow("Pi agent failed with exit 42");

      const output = logs.messages.join("\n");
      expect(output).toContain('"event":"pi stderr"');
      expect(output).toContain("| ***");
      expect(output).toContain("| model exploded");
      expect(output).not.toContain(secret);
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
        await runHostRunCommandWithDependencies({
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

describe("runHostRunCommand pull_request_review_comment dispatch", () => {
  it("ignores reply events when the adapter disables reply verification", async () => {
    const workspace = await createCommandWorkspace();
    const eventPath = path.join(workspace.rootDir, "event.json");
    await writeReviewCommentEvent(eventPath);
    try {
      for (const capabilities of [{ reviewCommentReplies: false }, { threadResolution: false }]) {
        const result = await runHostRunCommandWithDependencies({
          rootDir: workspace.rootDir,
          configDir: ".pipr",
          eventPath,
          dryRun: false,
          env: reviewCommentEnv(workspace.rootDir, eventPath),
          hostAdapter: githubAdapterWithCapabilities(workspace, capabilities),
          piExecutable: workspace.piExecutable,
        });

        expect(result).toEqual({
          kind: "ignored",
          reason: "host adapter does not support verifier replies",
        });
      }
      await expectPiNotCalled(workspace);
    } finally {
      await removeWorkspace(workspace.rootDir);
    }
  });

  it("skips review comment verifier dispatch in dry-run mode without calling GitHub", async () => {
    const workspace = await createCommandWorkspace();
    try {
      const eventPath = path.join(workspace.rootDir, "event.json");
      await writeReviewCommentEvent(eventPath);

      await expect(
        runHostRunCommandWithDependencies({
          rootDir: workspace.rootDir,
          configDir: ".pipr",
          eventPath,
          dryRun: true,
          env: reviewCommentEnv(workspace.rootDir, eventPath),
          githubClient: failingGitHubClient(),
          githubPublicationClient: failingGitHubPublishingClient(),
          piExecutable: workspace.piExecutable,
        }),
      ).resolves.toMatchObject({
        kind: "ignored",
        reason: "PIPR_DRY_RUN=1; verifier dispatch skipped",
      });
      await expectPiNotCalled(workspace);
    } finally {
      await removeWorkspace(workspace.rootDir);
    }
  });

  it("ignores pipr-authored verifier replies by marker", async () => {
    const workspace = await createCommandWorkspace();
    try {
      const eventPath = path.join(workspace.rootDir, "event.json");
      await writeReviewCommentEvent(eventPath, {
        body: `${renderResolvedFindingMarker("fnd_existing", "old-head")}\n\nResolved.`,
        actor: "custom-pipr-app[bot]",
      });

      await expect(
        runReviewCommentAction(workspace, {
          githubClient: failingGitHubClient(),
          githubPublicationClient: failingGitHubPublishingClient(),
        }),
      ).resolves.toMatchObject({
        kind: "ignored",
        reason: "review comment reply was authored by pipr",
      });
      await expectPiNotCalled(workspace);
    } finally {
      await removeWorkspace(workspace.rootDir);
    }
  });

  it("ignores edited review comment replies without loading PR context", async () => {
    const workspace = await createCommandWorkspace();
    try {
      const eventPath = path.join(workspace.rootDir, "event.json");
      await writeReviewCommentEvent(eventPath, { action: "edited" });

      await expect(
        runReviewCommentAction(workspace, {
          githubClient: failingGitHubClient(),
          githubPublicationClient: failingGitHubPublishingClient(),
        }),
      ).resolves.toMatchObject({
        kind: "ignored",
        reason: "review comment action 'edited' is not supported",
      });
      await expectPiNotCalled(workspace);
    } finally {
      await removeWorkspace(workspace.rootDir);
    }
  });

  it("ignores review comments that are not replies without loading PR context", async () => {
    const workspace = await createCommandWorkspace();
    try {
      const eventPath = path.join(workspace.rootDir, "event.json");
      await writeReviewCommentEvent(eventPath, { parentCommentId: null });

      await expect(
        runReviewCommentAction(workspace, {
          githubClient: failingGitHubClient(),
          githubPublicationClient: failingGitHubPublishingClient(),
        }),
      ).resolves.toMatchObject({
        kind: "ignored",
        reason: "review comment was not a reply",
      });
      await expectPiNotCalled(workspace);
    } finally {
      await removeWorkspace(workspace.rootDir);
    }
  });

  it("skips user-reply verifier when autoResolve is disabled", async () => {
    const workspace = await createCommandWorkspace({
      baseConfigTs: reviewConfigTs({ autoResolve: false }),
    });
    try {
      await expectReviewCommentIgnored(workspace, {
        githubClient: fakeGitHubClient(workspace, "write"),
        reason: "publication.autoResolve is disabled",
      });
    } finally {
      await removeWorkspace(workspace.rootDir);
    }
  });

  it("skips user-reply verifier when user replies are disabled", async () => {
    const workspace = await createCommandWorkspace({
      baseConfigTs: reviewConfigTs({ autoResolve: "userRepliesDisabled" }),
    });
    try {
      await expectReviewCommentIgnored(workspace, {
        githubClient: fakeGitHubClient(workspace, "write"),
        reason: "publication.autoResolve.userReplies is disabled",
      });
    } finally {
      await removeWorkspace(workspace.rootDir);
    }
  });

  it("denies review comment verifier dispatch for unauthorized actors", async () => {
    const workspace = await createCommandWorkspace();
    try {
      const eventPath = path.join(workspace.rootDir, "event.json");
      await writeReviewCommentEvent(eventPath, { actor: "reader" });

      await expect(
        runReviewCommentAction(workspace, {
          githubClient: fakeGitHubClient(workspace, "read"),
          githubPublicationClient: verifierPublicationClient(workspace),
        }),
      ).resolves.toMatchObject({
        kind: "ignored",
        reason: "review comment reply actor is not allowed",
      });
      await expectPiNotCalled(workspace);
    } finally {
      await removeWorkspace(workspace.rootDir);
    }
  });

  it("allows the pull request author without checking repository permission", async () => {
    const workspace = await createCommandWorkspace({ checkoutBaseBeforeRun: true });
    const publication = verifierPublicationClient(workspace);
    try {
      await writeStillValidVerifierOutput(workspace);
      await expectVerifierReplyPublished(workspace, publication, {
        event: { actor: "somu" },
        githubClient: fakeGitHubClient(workspace, "read", {
          author: "somu",
          failPermission: true,
        }),
      });
    } finally {
      await removeWorkspace(workspace.rootDir);
    }
  });

  it("allows any actor without checking repository permission when configured", async () => {
    const workspace = await createCommandWorkspace({
      baseConfigTs: reviewConfigTs({ autoResolve: "any" }),
      checkoutBaseBeforeRun: true,
    });
    const publication = verifierPublicationClient(workspace);
    try {
      await writeStillValidVerifierOutput(workspace);
      await expectVerifierReplyPublished(workspace, publication, {
        event: { actor: "outsider" },
        githubClient: fakeGitHubClient(workspace, "read", { failPermission: true }),
      });
    } finally {
      await removeWorkspace(workspace.rootDir);
    }
  });

  it("runs user-reply verifier and publishes still-valid responses", async () => {
    const workspace = await createCommandWorkspace({ checkoutBaseBeforeRun: true });
    const publication = verifierPublicationClient(workspace);
    const logs = memoryRuntimeLogSink();
    try {
      await writeStillValidVerifierOutput(
        workspace,
        "This still applies because the unsafe path remains.",
      );
      await expectVerifierReplyPublished(workspace, publication, {
        githubClient: fakeGitHubClient(workspace, "write"),
        logSink: logs.logSink,
      });
      const output = logs.messages.join("\n");
      expect(output).toContain('"eventName":"pull_request_review_comment"');
      expect(output).toContain('"event":"parse event start"');
      expect(output).toContain('"event":"event dispatch","kind":"review-comment-reply"');
      expect(output).toContain('"event":"verifier start"');
      expect(output).toContain('"event":"verifier publication"');
      expect(publication.reviewReplies[0]?.body).toContain(
        renderVerifierResponseMarker("fnd_existing", "reply-11:still-valid:fnd_existing"),
      );
      expect(currentGitHead(workspace.rootDir)).toBe(workspace.headSha);
    } finally {
      await removeWorkspace(workspace.rootDir);
    }
  });

  it("keys user-reply verifier run ids to the source review reply", async () => {
    const workspace = await createCommandWorkspace({ checkoutBaseBeforeRun: true });
    try {
      const first = await verifierRunIdFromReplyAction(workspace, {
        commentId: 11,
        parentCommentId: 10,
      });
      const repeated = await verifierRunIdFromReplyAction(workspace, {
        commentId: 11,
        parentCommentId: 10,
      });
      const changedReply = await verifierRunIdFromReplyAction(workspace, {
        commentId: 12,
        parentCommentId: 10,
      });
      const changedParent = await verifierRunIdFromReplyAction(workspace, {
        commentId: 13,
        parentCommentId: 20,
      });

      expect(repeated).toBe(first);
      expect(changedReply).not.toBe(first);
      expect(changedParent).not.toBe(first);
    } finally {
      await removeWorkspace(workspace.rootDir);
    }
  });
});

type CommandWorkspace = {
  rootDir: string;
  baseSha: string;
  headSha: string;
  piExecutable: string;
};

type FakeCheckRuns = {
  created: Array<{ id: number; name: string; headSha: string; summary?: string }>;
  updated: Array<{ checkRunId: number; name: string; conclusion: string; summary?: string }>;
};

async function writeFailingPiExecutable(piExecutable: string): Promise<void> {
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

async function createCommandWorkspace(
  options: {
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

async function writePiExecutable(piExecutable: string, stdout: string): Promise<void> {
  await Bun.write(piExecutable, piExecutableScript(stdout));
  await chmod(piExecutable, 0o755);
}

function piExecutableScript(stdout: string): string {
  return ["#!/bin/sh", 'touch "$(dirname "$0")/pi-called"', `printf '%s\\n' '${stdout}'`].join(
    "\n",
  );
}

async function runIssueCommentCommand(
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
  return await runHostRunCommandWithDependencies({
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

async function runPullRequestAction(
  workspace: CommandWorkspace,
  options: {
    eventName?: string;
    githubPublicationClient?: GitHubPublicationClient;
    logSink?: RuntimeLogSink;
  } = {},
) {
  const eventPath = path.join(workspace.rootDir, "event.json");
  await writePullRequestEvent(eventPath, workspace);
  return await runHostRunCommandWithDependencies({
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

async function runReviewCommentAction(
  workspace: CommandWorkspace,
  options: {
    dryRun?: boolean;
    githubClient: GitHubCommandClient;
    githubPublicationClient: GitHubPublicationClient;
    logSink?: RuntimeLogSink;
  },
) {
  const eventPath = path.join(workspace.rootDir, "event.json");
  return await runHostRunCommandWithDependencies({
    rootDir: workspace.rootDir,
    configDir: ".pipr",
    eventPath,
    dryRun: options.dryRun ?? false,
    env: reviewCommentEnv(workspace.rootDir, eventPath),
    githubClient: options.githubClient,
    githubPublicationClient: options.githubPublicationClient,
    piExecutable: workspace.piExecutable,
    logSink: options.logSink,
  });
}

async function expectPiNotCalled(workspace: CommandWorkspace): Promise<void> {
  await expect(Bun.file(path.join(workspace.rootDir, "pi-called")).text()).rejects.toThrow();
}

async function expectPiCalled(workspace: CommandWorkspace): Promise<void> {
  await expect(Bun.file(path.join(workspace.rootDir, "pi-called")).text()).resolves.toBe("");
}

async function expectReviewCommentIgnored(
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

async function writeStillValidVerifierOutput(
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

async function expectVerifierReplyPublished(
  workspace: CommandWorkspace,
  publication: ReturnType<typeof verifierPublicationClient>,
  options: {
    githubClient: GitHubCommandClient;
    event?: Parameters<typeof writeReviewCommentEvent>[1];
    logSink?: RuntimeLogSink;
  },
): Promise<void> {
  const eventPath = path.join(workspace.rootDir, "event.json");
  await writeReviewCommentEvent(eventPath, options.event);
  const result = await runReviewCommentAction(workspace, {
    githubClient: options.githubClient,
    githubPublicationClient: publication,
    logSink: options.logSink,
  });
  expect(result).toMatchObject({
    kind: "verifier",
    errors: [],
    event: { coordinates: { provider: "github", owner: "local", repository: "pipr" } },
  });
  expect(publication.reviewReplies).toHaveLength(1);
  await expectPiCalled(workspace);
}

async function verifierRunIdFromReplyAction(
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

async function expectReviewRanAtHead(
  result: Awaited<ReturnType<typeof runHostRunCommandWithDependencies>>,
  workspace: CommandWorkspace,
): Promise<void> {
  expect(result).toMatchObject({ kind: "review" });
  await expectPiCalled(workspace);
  expect(currentGitHead(workspace.rootDir)).toBe(workspace.headSha);
}

function reviewConfigTs(
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

function askConfigTs(): string {
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

function commandRunIdConfigTs(): string {
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

function localReviewSelectionConfigTs(): string {
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

function multiTaskCheckConfigTs(): string {
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

function explicitModelIdConfigTs(): string {
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

function maliciousHeadConfigTs(): string {
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

async function writeIssueCommentEvent(
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

function commandResponsePayload(body: string | undefined): string {
  if (!body) {
    throw new Error("test fixture missing command response body");
  }
  return body
    .split("\n")
    .filter((line) => line.trim() !== "" && !line.startsWith("<!--"))
    .join("\n");
}

async function writePullRequestEvent(
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

async function writeReviewCommentEvent(
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

function fakeGitHubClient(
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

function failingGitHubClient(): GitHubCommandClient {
  return {
    async getPullRequest() {
      throw new Error("GitHub should not be called");
    },
    async getRepositoryPermission() {
      throw new Error("GitHub should not be called");
    },
  };
}

function fakeGitHubPublicationClient(
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

function recordingCommandPublicationClient(
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
    return { id: 10 };
  };
  client.updateIssueComment = async (options) => {
    writes.updated.push(options.body);
    return { id: options.commentId };
  };
  return { client, writes };
}

function verifierPublicationClient(
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

function priorMainCommentBody(): string {
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

function failingGitHubPublishingClient(): GitHubPublicationClient {
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

function issueCommentEnv(rootDir: string, eventPath: string): NodeJS.ProcessEnv {
  return {
    DEEPSEEK_API_KEY: "provider-key",
    GITHUB_EVENT_NAME: "issue_comment",
    GITHUB_EVENT_PATH: eventPath,
    GITHUB_WORKSPACE: rootDir,
  };
}

function pullRequestEnv(rootDir: string, eventPath: string): NodeJS.ProcessEnv {
  return {
    DEEPSEEK_API_KEY: "provider-key",
    FAST_DEEPSEEK_API_KEY: "provider-key",
    GITHUB_EVENT_NAME: "pull_request",
    GITHUB_EVENT_PATH: eventPath,
    GITHUB_WORKSPACE: rootDir,
  };
}

function reviewCommentEnv(rootDir: string, eventPath: string): NodeJS.ProcessEnv {
  return {
    DEEPSEEK_API_KEY: "provider-key",
    FAST_DEEPSEEK_API_KEY: "provider-key",
    GITHUB_EVENT_NAME: "pull_request_review_comment",
    GITHUB_EVENT_PATH: eventPath,
    GITHUB_WORKSPACE: rootDir,
  };
}

function githubAdapterWithCapabilities(
  workspace: CommandWorkspace,
  overrides: Partial<CodeHostCapabilities>,
) {
  const adapter = createGitHubHostAdapter({
    commandClient: fakeGitHubClient(workspace, "write"),
    publicationClient: fakeGitHubPublicationClient(workspace),
  });
  return { ...adapter, capabilities: { ...adapter.capabilities, ...overrides } };
}

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
    delete Bun.env[key];
  } else {
    process.env[key] = value;
    Bun.env[key] = value;
  }
}

function snapshotGitConfigEnv(): Map<string, string | undefined> {
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

function clearGitConfigEnv(snapshot: Map<string, string | undefined>): void {
  for (const key of snapshot.keys()) {
    restoreEnv(key, undefined);
  }
}

function restoreGitConfigEnv(snapshot: Map<string, string | undefined>): void {
  for (const [key, value] of snapshot) {
    restoreEnv(key, value);
  }
}

async function removeWorkspace(rootDir: string): Promise<void> {
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

function currentGitHead(cwd: string): string {
  return runGit(cwd, ["rev-parse", "HEAD"]).trim();
}
