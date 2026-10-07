import { describe, expect, it } from "bun:test";
import { access } from "node:fs/promises";
import path from "node:path";
import { validateRunBundlePackage } from "../../observability/protected-package.js";
import type { PublishedRunBundle } from "../../observability/run-bundle-publication.js";
import {
  createCommandWorkspace,
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
