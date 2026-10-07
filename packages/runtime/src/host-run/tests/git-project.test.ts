import { describe, expect, it } from "bun:test";
import { mkdir, symlink } from "node:fs/promises";
import path from "node:path";
import { writeThirdPartyPiprProject } from "../../config/tests/helpers/third-party-config.js";
import { runGit } from "../../diff/git.js";
import { loadRuntimeProjectFromGitCommit } from "../git-project.js";
import { commitGitProjectBase, initGitRepoRoot } from "./helpers/git-project.js";

describe("loadRuntimeProjectFromGitCommit", () => {
  it("loads trusted config with package.json and bun.lock from the base commit", async () => {
    const rootDir = await initGitRepoRoot();
    await writeThirdPartyPiprProject(rootDir);
    const baseSha = commitGitProjectBase(rootDir);

    const runtime = await loadRuntimeProjectFromGitCommit({
      rootDir,
      commitSha: baseSha,
    });

    expect(runtime.plan.agents[0]?.definition.instructions).toBe("Review with deps.");
  });

  it("reads the base commit with the injected environment", async () => {
    const rootDir = await initGitRepoRoot();
    await writeThirdPartyPiprProject(rootDir);
    const baseSha = commitGitProjectBase(rootDir);
    const env = { ...process.env, GIT_DIR: path.join(rootDir, "missing-git-dir") };

    await expect(
      loadRuntimeProjectFromGitCommit({ rootDir, commitSha: baseSha, env }),
    ).rejects.toThrow("git ls-tree");
  });

  it("loads trusted TypeScript config imports whose git paths contain tabs", async () => {
    const rootDir = await initGitRepoRoot();
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
        '  const deepseek = pipr.model("deepseek/deepseek-v4-pro", { apiKey: pipr.secret({ name: "DEEPSEEK_API_KEY" }), thinking: "high" });',
        "  pipr.review({",
        '    id: "review",',
        "    model: deepseek,",
        "    instructions: reviewerInstructions,",
        "    summary: { instructions: reviewerInstructions },",
        "  });",
        "});",
      ].join("\n"),
    );
    const baseSha = commitGitProjectBase(rootDir);

    const runtime = await loadRuntimeProjectFromGitCommit({
      rootDir,
      commitSha: baseSha,
    });

    expect(runtime.plan.agents.map((agent) => agent.definition.instructions)).toEqual([
      "Review copy.",
      "Review copy.",
    ]);
  });

  it("fails clearly when the base commit does not contain pipr config", async () => {
    const rootDir = await initGitRepoRoot();
    await Bun.write(path.join(rootDir, "README.md"), "# empty\n");
    const baseSha = commitGitProjectBase(rootDir);

    await expect(
      loadRuntimeProjectFromGitCommit({
        rootDir,
        commitSha: baseSha,
      }),
    ).rejects.toThrow("No Pipr config found at .pipr/config.ts in base commit");
  });

  it.each([
    [
      "a symlink",
      async (rootDir: string) => {
        await symlink("../README.md", path.join(rootDir, ".pipr", "x.ts"));
        commitGitProjectBase(rootDir);
      },
    ],
    [
      "a submodule",
      async (rootDir: string) => {
        const sha = runGit(["rev-parse", "HEAD"], rootDir).trim();
        runGit(["update-index", "--add", "--cacheinfo", `160000,${sha},.pipr/sub`], rootDir);
        runGit(["commit", "--no-verify", "-m", "submodule"], rootDir);
      },
    ],
  ])("rejects %s inside the trusted config directory", async (_kind, addEntry) => {
    const rootDir = await initGitRepoRoot();
    await writeThirdPartyPiprProject(rootDir);
    await Bun.write(path.join(rootDir, "README.md"), "# readme\n");
    commitGitProjectBase(rootDir);
    await addEntry(rootDir);
    const baseSha = runGit(["rev-parse", "HEAD"], rootDir).trim();

    await expect(loadRuntimeProjectFromGitCommit({ rootDir, commitSha: baseSha })).rejects.toThrow(
      `only regular config files are supported at ${baseSha}`,
    );
  });
});
