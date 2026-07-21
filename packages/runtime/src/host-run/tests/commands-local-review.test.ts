import { describe, expect, it } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { parseRunBundleManifest } from "@usepipr/sdk";
import { memoryRuntimeLogSink } from "../../tests/helpers/runtime-log-sink.js";
import { runLocalReviewCommand } from "../commands.js";
import {
  createCommandWorkspace,
  expectPiNotCalled,
  localReviewSelectionConfigTs,
  removeWorkspace,
  reviewConfigTs,
  writeFailingPiExecutable,
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

  it("captures successful local review evidence without environment secrets", async () => {
    const workspace = await createCommandWorkspace({
      baseConfigTs: localReviewSelectionConfigTs(),
      headConfigTs: localReviewSelectionConfigTs(),
    });
    const traceDirectory = path.join(workspace.rootDir, "traces");
    try {
      const result = await runLocalReviewCommand({
        rootDir: workspace.rootDir,
        configDir: ".pipr",
        env: { DEEPSEEK_API_KEY: "provider-key" },
        baseSha: workspace.baseSha,
        headSha: workspace.headSha,
        piExecutable: workspace.piExecutable,
        traceDirectory,
      });
      if (result.kind !== "review") throw new Error(`Expected review, received ${result.kind}`);

      const [executionId] = await readdir(traceDirectory);
      const bundleDirectory = path.join(traceDirectory, executionId ?? "");
      const manifest = parseRunBundleManifest(
        JSON.parse(await readFile(path.join(bundleDirectory, "run.json"), "utf8")),
      );
      expect(manifest).toMatchObject({
        executionId,
        workId: result.run.id,
        kind: "review",
        outcome: "succeeded",
        capture: { completeness: "complete" },
      });
      expect(manifest.artifacts.map((artifact) => artifact.path)).toEqual([
        "artifacts/diff-manifest.json",
        "artifacts/publication-plan.json",
        "artifacts/review-output.json",
        "artifacts/validation.json",
      ]);
      const contents = await Promise.all(
        [
          "run.json",
          "spans.jsonl",
          "logs.jsonl",
          "metrics.json",
          ...manifest.artifacts.map((a) => a.path),
        ].map((file) => readFile(path.join(bundleDirectory, file), "utf8")),
      );
      expect(contents.join("\n")).not.toContain("provider-key");
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

  it("keeps a partial diagnostic bundle when local review fails before dispatch", async () => {
    const workspace = await createCommandWorkspace({
      baseConfigTs: localReviewSelectionConfigTs(),
      headConfigTs: localReviewSelectionConfigTs(),
      sdkVersion: "999.0.0",
    });
    const traceDirectory = path.join(workspace.rootDir, "traces");
    try {
      await expect(
        runLocalReviewCommand({
          rootDir: workspace.rootDir,
          configDir: ".pipr",
          env: { DEEPSEEK_API_KEY: "provider-key" },
          baseSha: workspace.baseSha,
          headSha: workspace.headSha,
          piExecutable: workspace.piExecutable,
          traceDirectory,
        }),
      ).rejects.toThrow("Upgrade Pipr before running this config");

      const [executionId] = await readdir(traceDirectory);
      const manifest = parseRunBundleManifest(
        JSON.parse(
          await readFile(path.join(traceDirectory, executionId ?? "", "run.json"), "utf8"),
        ),
      );
      expect(manifest).toMatchObject({
        executionId,
        kind: "startup",
        outcome: "failed",
        failureCategory: "trusted-config",
        capture: { mode: "diagnostic", completeness: "partial" },
      });
    } finally {
      await removeWorkspace(workspace.rootDir);
    }
  });

  it("classifies failed Pi execution as a local review failure", async () => {
    const workspace = await createCommandWorkspace({
      baseConfigTs: reviewConfigTs(),
      headConfigTs: reviewConfigTs(),
    });
    const traceDirectory = path.join(workspace.rootDir, "traces");
    await writeFailingPiExecutable(workspace.piExecutable);
    try {
      await expect(
        runLocalReviewCommand({
          rootDir: workspace.rootDir,
          configDir: ".pipr",
          env: { DEEPSEEK_API_KEY: "provider-key" },
          baseSha: workspace.baseSha,
          headSha: workspace.headSha,
          piExecutable: workspace.piExecutable,
          traceDirectory,
        }),
      ).rejects.toThrow("Pi agent failed with exit 42");

      const [executionId] = await readdir(traceDirectory);
      const manifest = parseRunBundleManifest(
        JSON.parse(
          await readFile(path.join(traceDirectory, executionId ?? "", "run.json"), "utf8"),
        ),
      );
      expect(manifest).toMatchObject({
        kind: "review",
        outcome: "failed",
        failureCategory: "agent-exit",
        repository: {
          host: "local",
          baseSha: workspace.baseSha,
          headSha: workspace.headSha,
        },
      });
    } finally {
      await removeWorkspace(workspace.rootDir);
    }
  });
});
