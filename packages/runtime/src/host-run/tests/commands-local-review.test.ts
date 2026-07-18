import { describe, expect, it } from "bun:test";
import path from "node:path";
import { memoryRuntimeLogSink } from "../../tests/helpers/runtime-log-sink.js";
import { runLocalReviewCommand } from "../commands.js";
import {
  createCommandWorkspace,
  expectPiNotCalled,
  localReviewSelectionConfigTs,
  removeWorkspace,
} from "./commands-fixtures.js";

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
