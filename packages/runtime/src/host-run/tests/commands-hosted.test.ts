import { describe, expect, it } from "bun:test";
import { access } from "node:fs/promises";
import path from "node:path";
import { validateRunBundlePackage } from "../../observability/protected-package.js";
import type { PublishedRunBundle } from "../../observability/run-bundle-publication.js";
import {
  createCommandWorkspace,
  expectPiNotCalled,
  failingGitHubPublishingClient,
  fakeGitHubPublicationClient,
  pullRequestEnv,
  removeWorkspace,
  runTestHostCommand,
  writePullRequestEvent,
} from "./commands-fixtures.js";

describe("runHostRunCommand run bundle publication", () => {
  it("packages a native-CI capture into the run store and names its artifact", async () => {
    const workspace = await createCommandWorkspace({ checkoutBaseBeforeRun: true });
    const runStore = path.join(workspace.rootDir, "runs");
    const finalizedDirectories: string[] = [];
    const published: PublishedRunBundle[] = [];
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
          PIPR_RUN_STORE_DIR: runStore,
        },
        githubPublicationClient: fakeGitHubPublicationClient(workspace),
        piProviderModule: workspace.pi.providerModule,
        onRunBundleFinalized(bundle) {
          finalizedDirectories.push(bundle.directory);
        },
        onRunBundlePublished(bundle) {
          published.push(bundle);
        },
      });

      const executionId = published[0]?.executionId ?? "";
      expect(executionId).toMatch(/^[a-f0-9]{32}$/);
      expect(published).toEqual([
        {
          executionId,
          bundlePath: path.join("runs", executionId),
          artifactName: `pipr-run-v1-metadata-pr-1-${executionId}`,
        },
      ]);
      await validateRunBundlePackage(path.join(runStore, executionId));
      const captureRoot = path.dirname(finalizedDirectories[0] ?? "");
      await expect(access(captureRoot)).rejects.toThrow();
    } finally {
      await removeWorkspace(workspace.rootDir);
    }
  });
});

describe("runHostRunCommand CI environment fallbacks", () => {
  it.each([
    { name: "a CI workspace variable", workspaceVariable: "GITHUB_WORKSPACE" },
    { name: "the working directory", workspaceVariable: undefined },
  ])(
    "resolves the workspace from $name and the event path from env",
    async ({ workspaceVariable }) => {
      const workspace = await createCommandWorkspace({ checkoutBaseBeforeRun: false });
      try {
        const eventPath = path.join(workspace.rootDir, "event.json");
        await writePullRequestEvent(eventPath, workspace);
        const {
          GITHUB_EVENT_PATH: _eventPath,
          GITHUB_WORKSPACE: _workspace,
          ...env
        } = pullRequestEnv(workspace.rootDir, eventPath);

        const result = await runTestHostCommand({
          cwd: workspaceVariable ? path.dirname(workspace.rootDir) : workspace.rootDir,
          configDir: ".pipr",
          dryRun: true,
          env: {
            ...env,
            ...(workspaceVariable ? { [workspaceVariable]: workspace.rootDir } : {}),
            PIPR_EVENT_PATH: workspaceVariable
              ? path.join(path.basename(workspace.rootDir), "event.json")
              : "event.json",
          },
          githubPublicationClient: failingGitHubPublishingClient(),
          piProviderModule: workspace.pi.providerModule,
        });

        expect(result).toMatchObject({ kind: "dry-run", event: { change: { number: 1 } } });
        await expectPiNotCalled(workspace);
      } finally {
        await removeWorkspace(workspace.rootDir);
      }
    },
  );
});
