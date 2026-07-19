import { afterEach, describe, expect, it } from "bun:test";
import { cp, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "../../../..");
const temporaryDirectories = new Set<string>();

afterEach(async () => {
  await Promise.all(
    [...temporaryDirectories].map((directory) => rm(directory, { recursive: true, force: true })),
  );
  temporaryDirectories.clear();
});

describe("docs content checker", () => {
  it("reports broken routes, anchors, and image assets", async () => {
    const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), "pipr-docs-content-"));
    temporaryDirectories.add(fixtureRoot);
    const contentDir = path.join(fixtureRoot, "docs");
    await cp(path.join(repoRoot, "apps/docs/content/docs"), contentDir, { recursive: true });
    const indexPath = path.join(contentDir, "index.mdx");
    const source = await Bun.file(indexPath).text();
    await Bun.write(
      indexPath,
      `${source}\n[Missing route](/docs/does-not-exist)\n[Missing anchor](/docs#does-not-exist)\n<img src="/images/does-not-exist.png" alt="Missing fixture" />\n`,
    );

    const child = Bun.spawn(["bun", "apps/docs/scripts/check-content.ts"], {
      cwd: repoRoot,
      env: { ...process.env, PIPR_DOCS_CONTENT_DIR: contentDir },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);

    expect(exitCode).toBe(1);
    expect(stderr).toContain("broken docs route /docs/does-not-exist");
    expect(stderr).toContain("broken anchor /docs#does-not-exist");
    expect(stderr).toContain("missing image /images/does-not-exist.png");
  });

  it("rejects Markdown and inline code in frontmatter descriptions", async () => {
    const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), "pipr-docs-descriptions-"));
    temporaryDirectories.add(fixtureRoot);
    const contentDir = path.join(fixtureRoot, "docs");
    await cp(path.join(repoRoot, "apps/docs/content/docs"), contentDir, { recursive: true });
    const indexPath = path.join(contentDir, "index.mdx");
    const source = await Bun.file(indexPath).text();
    await Bun.write(
      indexPath,
      source.replace(
        /^description:.*$/m,
        "description: 'Read the [guide](/docs/guide) and run `pipr check`.'",
      ),
    );

    const child = Bun.spawn(["bun", "apps/docs/scripts/check-content.ts"], {
      cwd: repoRoot,
      env: { ...process.env, PIPR_DOCS_CONTENT_DIR: contentDir },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);

    expect(exitCode).toBe(1);
    expect(stderr).toContain("frontmatter description must be plain text");
  });
});
