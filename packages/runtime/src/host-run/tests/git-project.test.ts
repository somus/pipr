import { describe, expect, it } from "bun:test";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { writeThirdPartyPiprProject } from "../../config/tests/helpers/third-party-config.js";
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
    const baseSha = commitGitProjectBase(rootDir);

    const runtime = await loadRuntimeProjectFromGitCommit({
      rootDir,
      commitSha: baseSha,
    });

    expect(runtime.plan.agents[0]?.definition.instructions).toBe("Review copy.");
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
});
