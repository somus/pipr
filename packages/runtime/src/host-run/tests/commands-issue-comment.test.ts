import { describe, expect, it } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { memoryRuntimeLogSink } from "../../tests/helpers/runtime-log-sink.js";
import type { FakeCheckRuns } from "./commands-fixtures.js";
import {
  askConfigTs,
  commandResponsePayload,
  commandRunIdConfigTs,
  createCommandWorkspace,
  currentGitHead,
  expectPiNotCalled,
  expectReviewRanAtHead,
  failingGitHubClient,
  failingGitHubPublishingClient,
  githubAdapterWithCapabilities,
  issueCommentEnv,
  recordingCommandPublicationClient,
  removeWorkspace,
  reviewConfigTs,
  runIssueCommentCommand,
  runTestHostCommand,
  writeIssueCommentEvent,
  writePiExecutable,
} from "./commands-fixtures.js";

describe("runHostRunCommand issue_comment dispatch", () => {
  it("ignores command events when the adapter disables command comments", async () => {
    const workspace = await createCommandWorkspace();
    const eventPath = path.join(workspace.rootDir, "event.json");
    await writeIssueCommentEvent(eventPath, "@pipr review", "created", 123);
    try {
      const result = await runTestHostCommand({
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
        runTestHostCommand({
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
        runTestHostCommand({
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
        runTestHostCommand({
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
    const publication = recordingCommandPublicationClient(workspace);
    try {
      expect(currentGitHead(workspace.rootDir)).toBe(workspace.baseSha);
      const result = await runIssueCommentCommand(
        workspace,
        "@pipr review --scope full",
        "write",
        undefined,
        publication.client,
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
      expect(publication.writes.updated.at(-1)).toContain("state=completed");
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
        publication: { action: "updated", id: "10" },
      });
      expect(publication.writes.created).toHaveLength(1);
      expect(publication.writes.created[0]).toContain(
        "<!-- pipr:command-response change=1 source=123 command=ask -->",
      );
      expect(publication.writes.created[0]).toContain(
        `<!-- pipr:command-state state=accepted head=${workspace.headSha} -->`,
      );
      expect(publication.writes.updated).toHaveLength(2);
      expect(publication.writes.updated[0]).toContain("state=running");
      expect(publication.writes.updated[1]).toContain("The change updates command output.");
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

      const firstRunId = commandResponsePayload(firstPublication.writes.updated.at(-1));
      expect(commandResponsePayload(repeatedPublication.writes.updated.at(-1))).toBe(firstRunId);
      expect(commandResponsePayload(changedPublication.writes.updated.at(-1))).not.toBe(firstRunId);
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
      expect(publication.writes.updated).toHaveLength(3);
      expect(publication.writes.updated[0]).toContain("state=accepted");
      expect(publication.writes.updated[1]).toContain("state=running");
      expect(publication.writes.updated[2]).toContain("Updated answer.");
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

  it("publishes a generic failed status when command task execution fails", async () => {
    const workspace = await createCommandWorkspace({
      baseConfigTs: askConfigTs(),
      checkoutBaseBeforeRun: true,
    });
    const publication = recordingCommandPublicationClient(workspace);
    await writePiExecutable(workspace.piExecutable, "not valid json");
    try {
      await expect(
        runIssueCommentCommand(
          workspace,
          "@pipr ask what changed?",
          "read",
          undefined,
          publication.client,
        ),
      ).rejects.toThrow();
      expect(publication.writes.updated.at(-1)).toContain("state=failed");
      expect(publication.writes.updated.at(-1)).not.toContain("not valid json");
    } finally {
      await removeWorkspace(workspace.rootDir);
    }
  });

  it("publishes superseded after head drift and keeps the final model response guarded", async () => {
    const workspace = await createCommandWorkspace({
      baseConfigTs: askConfigTs(),
      checkoutBaseBeforeRun: true,
    });
    const publication = recordingCommandPublicationClient(workspace);
    await writePiExecutable(workspace.piExecutable, '{"body":"Head-specific answer."}');
    const update = publication.client.updateIssueComment;
    publication.client.updateIssueComment = async (options) => {
      const result = await update(options);
      if (options.body.includes("state=running")) workspace.headSha = "new-head";
      return result;
    };
    try {
      await expect(
        runIssueCommentCommand(
          workspace,
          "@pipr ask what changed?",
          "read",
          undefined,
          publication.client,
        ),
      ).rejects.toThrow(/head changed/i);
      expect(publication.writes.updated.at(-1)).toContain("state=superseded");
      expect(publication.writes.updated.join("\n")).not.toContain("Head-specific answer.");
    } finally {
      await removeWorkspace(workspace.rootDir);
    }
  });

  it("stops before Pi when accepted status publication fails", async () => {
    const workspace = await createCommandWorkspace({
      baseConfigTs: askConfigTs(),
      checkoutBaseBeforeRun: true,
    });
    const publication = recordingCommandPublicationClient(workspace);
    publication.client.createIssueComment = async () => {
      throw new Error("status denied");
    };
    try {
      await expect(
        runIssueCommentCommand(
          workspace,
          "@pipr ask what changed?",
          "read",
          undefined,
          publication.client,
        ),
      ).rejects.toThrow("status denied");
      await expectPiNotCalled(workspace);
    } finally {
      await removeWorkspace(workspace.rootDir);
    }
  });

  it("fails the host run when completed status publication fails", async () => {
    const workspace = await createCommandWorkspace({ checkoutBaseBeforeRun: true });
    const publication = recordingCommandPublicationClient(workspace);
    const update = publication.client.updateIssueComment;
    publication.client.updateIssueComment = async (options) => {
      if (options.body.includes("state=completed")) {
        throw new Error("terminal status denied");
      }
      return await update(options);
    };
    try {
      await expect(
        runIssueCommentCommand(
          workspace,
          "@pipr review --scope full",
          "write",
          undefined,
          publication.client,
        ),
      ).rejects.toThrow("terminal status denied");
      expect(publication.writes.updated.at(-1)).toContain("state=failed");
    } finally {
      await removeWorkspace(workspace.rootDir);
    }
  });
});
