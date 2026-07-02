import { describe, expect, it } from "bun:test";
import { cp, mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { shouldSkipConfigInstall } from "../config-deps.js";
import { initOfficialMinimalProject } from "../init.js";
import { loadTypescriptConfig, prepareConfigDirectory } from "../ts-loader.js";
import { useLocalInitSdk } from "./helpers/local-init-sdk.js";
import {
  writeThirdPartyPackageManifest,
  writeThirdPartyPiprProject,
} from "./helpers/third-party-config.js";

useLocalInitSdk();

describe("loadTypescriptConfig installable deps", () => {
  it("loads config that imports a third-party dep from .pipr/package.json and bun.lock", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "pipr-config-deps-"));
    await writeThirdPartyPiprProject(rootDir, { instructions: "Review this change." });

    await expect(loadTypescriptConfig({ rootDir, typecheck: false })).resolves.toMatchObject({
      source: path.join(rootDir, ".pipr", "config.ts"),
    });
  });

  it("fails with an actionable error when bun.lock is missing for third-party deps", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "pipr-config-deps-"));
    await writeThirdPartyPackageManifest(rootDir);
    await Bun.write(
      path.join(rootDir, ".pipr", "config.ts"),
      `import { definePipr } from "@usepipr/sdk";
export default definePipr((pipr) => {
  pipr.model({
    provider: "deepseek",
    model: "deepseek-v4-pro",
    apiKey: pipr.secret({ name: "DEEPSEEK_API_KEY" }),
  });
});
`,
    );

    await expect(loadTypescriptConfig({ rootDir, typecheck: false })).rejects.toThrow(
      "bun.lock is required when .pipr/package.json declares dependencies",
    );
  });

  it("overrides @usepipr/sdk from user package.json with the runtime stub", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "pipr-config-deps-"));
    await initOfficialMinimalProject({ rootDir, adapters: [] });
    await writePiprConfig(
      rootDir,
      `import { definePipr } from "@usepipr/sdk";
import { reviewSchemaExample } from "@usepipr/sdk";

export default definePipr((pipr) => {
  const example = reviewSchemaExample();
  const model = pipr.model({
    provider: "deepseek",
    model: "deepseek-v4-pro",
    apiKey: pipr.secret({ name: "DEEPSEEK_API_KEY" }),
  });
  pipr.review({
    id: "review",
    model,
    instructions: \`Review. Example summary: \${example.summary.body}\`,
  });
});
`,
    );

    const loaded = await loadTypescriptConfig({ rootDir, typecheck: false });
    expect(loaded.plan.agents.length).toBeGreaterThan(0);
  });

  it("skips bun install when deps are only runtime-provided packages", async () => {
    expect(
      shouldSkipConfigInstall({
        dependencies: { "@usepipr/sdk": "0.1.3" },
        devDependencies: { "@types/bun": "1.3.14" },
      }),
    ).toBe(true);
    expect(
      shouldSkipConfigInstall({
        dependencies: { "@usepipr/sdk": "0.1.3", "lodash-es": "4.17.23" },
      }),
    ).toBe(false);
  });

  it("loads tier-1 single-file config without package.json unchanged", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "pipr-config-deps-"));
    await initOfficialMinimalProject({ rootDir, adapters: [], minimal: true });
    await writePiprConfig(
      rootDir,
      `import { definePipr } from "@usepipr/sdk";

export default definePipr((pipr) => {
  const model = pipr.model({
    provider: "deepseek",
    model: "deepseek-v4-pro",
    apiKey: pipr.secret({ name: "DEEPSEEK_API_KEY" }),
  });
  pipr.review({ id: "review", model, instructions: "Review this change." });
});
`,
    );

    await expect(loadTypescriptConfig({ rootDir, typecheck: true })).resolves.toMatchObject({
      source: path.join(rootDir, ".pipr", "config.ts"),
    });
  });

  it("typechecks default scaffold config that uses Bun APIs without installing @types/bun", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "pipr-config-deps-"));
    await initOfficialMinimalProject({ rootDir, adapters: [] });
    await writePiprConfig(
      rootDir,
      `import { definePipr } from "@usepipr/sdk";
import { file } from "bun";

export default definePipr((pipr) => {
  const model = pipr.model({
    provider: "deepseek",
    model: "deepseek-v4-pro",
    apiKey: pipr.secret({ name: "DEEPSEEK_API_KEY" }),
  });
  pipr.review({
    id: "review",
    model,
    instructions: \`Review this change. Bun version: \${Bun.version}. Config exists: \${file(".pipr/config.ts").exists()}\`,
  });
});
`,
    );

    await expect(loadTypescriptConfig({ rootDir, typecheck: true })).resolves.toMatchObject({
      source: path.join(rootDir, ".pipr", "config.ts"),
    });
  });

  it("typechecks against the runtime SDK stub declaration", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "pipr-config-deps-"));
    await initOfficialMinimalProject({ rootDir, adapters: [] });
    await writePiprConfig(
      rootDir,
      `import { definePipr } from "@usepipr/sdk";

export default definePipr((pipr) => {
  const model: string = pipr.model({
    provider: "deepseek",
    model: "deepseek-v4-pro",
    apiKey: pipr.secret({ name: "DEEPSEEK_API_KEY" }),
  });
  pipr.review({ id: "review", model, instructions: "Review this change." });
});
`,
    );

    await expect(loadTypescriptConfig({ rootDir, typecheck: true })).rejects.toThrow(
      "TypeScript config check failed",
    );
  });
});

describe("prepareConfigDirectory", () => {
  it("writes a typed SDK stub without running install for default scaffold deps", async () => {
    const configDir = await mkdtemp(path.join(os.tmpdir(), "pipr-config-stub-"));
    await cp(
      path.join(path.resolve(import.meta.dirname, "../../../../../.pipr"), "package.json"),
      path.join(configDir, "package.json"),
    );

    await prepareConfigDirectory(configDir, { frozen: true });

    expect(
      await Bun.file(
        path.join(configDir, "node_modules", "@usepipr", "sdk", "index.d.ts"),
      ).exists(),
    ).toBe(true);
    expect(
      await Bun.file(path.join(configDir, "node_modules", "@usepipr", "sdk", "index.mjs")).exists(),
    ).toBe(true);
  });
});

async function writePiprConfig(rootDir: string, contents: string): Promise<void> {
  await Bun.write(path.join(rootDir, ".pipr", "config.ts"), contents);
}
