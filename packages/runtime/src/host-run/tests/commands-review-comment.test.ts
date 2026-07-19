import { describe, expect, it } from "bun:test";
import path from "node:path";
import {
  renderResolvedFindingMarker,
  renderVerifierResponseMarker,
} from "../../review/prior-state.js";
import { memoryRuntimeLogSink } from "../../tests/helpers/runtime-log-sink.js";
import {
  createCommandWorkspace,
  currentGitHead,
  expectPiNotCalled,
  expectReviewCommentIgnored,
  expectVerifierReplyPublished,
  failingGitHubClient,
  failingGitHubPublishingClient,
  fakeGitHubClient,
  githubAdapterWithCapabilities,
  removeWorkspace,
  replacingSecretRedactor,
  reviewCommentEnv,
  reviewConfigTs,
  runReviewCommentAction,
  runTestHostCommand,
  verifierPublicationClient,
  verifierRunIdFromReplyAction,
  writeReviewCommentEvent,
  writeStillValidVerifierOutput,
} from "./commands-fixtures.js";

describe("runHostRunCommand pull_request_review_comment dispatch", () => {
  it("ignores reply events when the adapter disables reply verification", async () => {
    const workspace = await createCommandWorkspace();
    const eventPath = path.join(workspace.rootDir, "event.json");
    await writeReviewCommentEvent(eventPath);
    try {
      for (const capabilities of [{ reviewCommentReplies: false }, { threadResolution: false }]) {
        const result = await runTestHostCommand({
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
        runTestHostCommand({
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
        { inputTokens: 50, outputTokens: 5, costUsd: 0.001 },
      );
      const result = await expectVerifierReplyPublished(workspace, publication, {
        githubClient: fakeGitHubClient(workspace, "write"),
        logSink: logs.logSink,
      });
      if (result.kind !== "verifier") {
        throw new Error(`expected verifier, received ${result.kind}`);
      }
      expect(result.run).toMatchObject({
        trigger: "verifier",
        baseSha: workspace.baseSha,
        headSha: workspace.headSha,
        tasks: ["pipr-internal-verifier"],
        models: ["verifier-model"],
        agentRuns: 1,
        inputTokens: 50,
        outputTokens: 5,
        costUsd: 0.001,
        usageStatus: "complete",
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

  it("redacts user-reply verifier responses before publication", async () => {
    const workspace = await createCommandWorkspace({ checkoutBaseBeforeRun: true });
    const publication = verifierPublicationClient(workspace);
    const detected = "registered-runtime-secret";
    try {
      await writeStillValidVerifierOutput(workspace, `Still applies because ${detected}.`);
      await expectVerifierReplyPublished(workspace, publication, {
        githubClient: fakeGitHubClient(workspace, "write"),
        secretRedactor: replacingSecretRedactor(detected),
      });

      expect(publication.reviewReplies[0]?.body).toContain(
        "Still applies because [redacted secret].",
      );
      expect(publication.reviewReplies[0]?.body).not.toContain(detected);
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
