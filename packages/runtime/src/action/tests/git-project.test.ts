import { describe, expect, it } from "bun:test";
import { mkdir, mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runGit } from "../../diff/git.js";
import { loadRuntimeProjectFromGitCommit } from "../git-project.js";

describe("loadRuntimeProjectFromGitCommit", () => {
  it("loads trusted TypeScript config imports whose git paths contain tabs", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "pipr-git-project-"));
    await initGitRepo(rootDir);
    await mkdir(path.join(rootDir, ".pipr", "prompts"), { recursive: true });
    await Bun.write(
      path.join(rootDir, ".pipr", "prompts", "reviewer\tcopy.ts"),
      'export const reviewerInstructions = "Review copy."; \n',
    );
    await Bun.write(
      path.join(rootDir, ".pipr", "config.ts"),
      [
        'import { definePipr } from "@usepipr/sdk";',
        'import { reviewerInstructions } from "./prompts/reviewer\tcopy.ts";',
        "",
        "export default definePipr((pipr) => {",
        "  const deepseek = pipr.model({",
        '    provider: "deepseek",',
        '    model: "deepseek-v4-pro",',
        '    apiKey: pipr.secret({ name: "DEEPSEEK_API_KEY" }),',
        '    options: { thinking: "high" },',
        "  });",
        "  pipr.review({",
        '    id: "review",',
        "    model: deepseek,",
        "    instructions: reviewerInstructions,",
        "  });",
        "});",
      ].join("\n"),
    );
    runGit(["add", "."], rootDir);
    runGit(["commit", "--no-verify", "-m", "base"], rootDir);
    const baseSha = runGit(["rev-parse", "HEAD"], rootDir).trim();

    const runtime = await loadRuntimeProjectFromGitCommit({
      rootDir,
      commitSha: baseSha,
    });

    expect(runtime.plan.agents[0]?.definition.instructions).toBe("Review copy.");
  });

  it("fails clearly when the base commit does not contain pipr config", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "pipr-git-project-"));
    await initGitRepo(rootDir);
    await Bun.write(path.join(rootDir, "README.md"), "# empty\n");
    runGit(["add", "."], rootDir);
    runGit(["commit", "--no-verify", "-m", "base"], rootDir);
    const baseSha = runGit(["rev-parse", "HEAD"], rootDir).trim();

    await expect(
      loadRuntimeProjectFromGitCommit({
        rootDir,
        commitSha: baseSha,
      }),
    ).rejects.toThrow(".pipr/config.ts is required at base commit");
  });
});

async function initGitRepo(rootDir: string): Promise<void> {
  await mkdir(rootDir, { recursive: true });
  runGit(["init", "--initial-branch=main"], rootDir);
  runGit(["config", "user.name", "pipr test"], rootDir);
  runGit(["config", "user.email", "pipr@example.test"], rootDir);
  runGit(["config", "core.hooksPath", "/dev/null"], rootDir);
  runGit(["config", "commit.gpgsign", "false"], rootDir);
}
