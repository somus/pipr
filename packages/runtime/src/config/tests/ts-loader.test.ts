import { describe, expect, it } from "bun:test";
import { cp, mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runtimeVersion } from "../../shared/version.js";
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

    const loaded = await loadTypescriptConfig({ rootDir, typecheck: true });

    expect(loaded).toMatchObject({
      source: path.join(rootDir, ".pipr", "config.ts"),
      versionCompatibility: {
        kind: "unknown",
        runtimeVersion,
      },
    });
  });

  it("captures a matching exact config SDK version without warning", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "pipr-config-deps-"));
    await initOfficialMinimalProject({ rootDir, adapters: [] });
    await writeSdkDependency(rootDir, runtimeVersion);

    const loaded = await loadTypescriptConfig({ rootDir, typecheck: false });

    expect(loaded.versionCompatibility).toEqual({
      kind: "matched",
      runtimeVersion,
      configVersion: runtimeVersion,
    });
  });

  it("warns when the config SDK pin is behind the runtime", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "pipr-config-deps-"));
    await initOfficialMinimalProject({ rootDir, adapters: [] });
    await writeSdkDependency(rootDir, "0.1.0");

    const loaded = await loadTypescriptConfig({ rootDir, typecheck: false });

    expect(loaded.versionCompatibility).toEqual({
      kind: "runtime-newer",
      runtimeVersion,
      configVersion: "0.1.0",
      warning: `.pipr/package.json pins @usepipr/sdk 0.1.0, but this Pipr runtime is ${runtimeVersion}. Run \`pipr init --force\` or update .pipr/package.json and .pipr/bun.lock when ready.`,
    });
  });

  it("treats non-object package manifests as unknown config versions", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "pipr-config-deps-"));
    await initOfficialMinimalProject({ rootDir, adapters: [] });
    await Bun.write(path.join(rootDir, ".pipr", "package.json"), "null\n");

    const loaded = await loadTypescriptConfig({ rootDir, typecheck: false });

    expect(loaded.versionCompatibility).toEqual({
      kind: "unknown",
      runtimeVersion,
    });
  });

  it("fails before config execution when the config SDK pin is newer than the runtime", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "pipr-config-deps-"));
    await initOfficialMinimalProject({ rootDir, adapters: [] });
    await writeSdkDependency(rootDir, "999.0.0");

    await expect(loadTypescriptConfig({ rootDir, typecheck: false })).rejects.toThrow(
      `.pipr/package.json pins @usepipr/sdk 999.0.0, but this Pipr runtime is ${runtimeVersion}. Upgrade Pipr before running this config.`,
    );
  });

  it("warns and skips comparison for non-exact config SDK specs", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "pipr-config-deps-"));
    await initOfficialMinimalProject({ rootDir, adapters: [] });
    await writeSdkDependency(rootDir, "^0.3.3");

    const loaded = await loadTypescriptConfig({ rootDir, typecheck: false });

    expect(loaded.versionCompatibility).toEqual({
      kind: "uncomparable",
      runtimeVersion,
      warning:
        '.pipr/package.json declares @usepipr/sdk as "^0.3.3"; use an exact version to enable Pipr config version checks.',
    });
  });

  it("escapes non-exact config SDK specs in version warnings", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "pipr-config-deps-"));
    await initOfficialMinimalProject({ rootDir, adapters: [] });
    await writeSdkDependency(rootDir, "^0.3.3\nerror: forged");

    const loaded = await loadTypescriptConfig({ rootDir, typecheck: false });

    expect(loaded.versionCompatibility.warning).toBe(
      '.pipr/package.json declares @usepipr/sdk as "^0.3.3\\nerror: forged"; use an exact version to enable Pipr config version checks.',
    );
  });

  it("uses the selected config directory in version mismatch remediation", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "pipr-config-deps-"));
    await initOfficialMinimalProject({ rootDir, adapters: [], configDir: "config/pipr" });
    await writeSdkDependency(rootDir, "0.1.0", "config/pipr");

    const loaded = await loadTypescriptConfig({
      rootDir,
      configDir: "config/pipr",
      typecheck: false,
    });

    expect(loaded.versionCompatibility).toEqual({
      kind: "runtime-newer",
      runtimeVersion,
      configVersion: "0.1.0",
      warning: `config/pipr/package.json pins @usepipr/sdk 0.1.0, but this Pipr runtime is ${runtimeVersion}. Run \`pipr init --force\` or update config/pipr/package.json and config/pipr/bun.lock when ready.`,
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

async function writeSdkDependency(
  rootDir: string,
  version: string,
  configDir = ".pipr",
): Promise<void> {
  const packageJsonPath = path.join(rootDir, configDir, "package.json");
  const manifest = (await Bun.file(packageJsonPath).json()) as {
    dependencies?: Record<string, string>;
  };
  manifest.dependencies ??= {};
  manifest.dependencies["@usepipr/sdk"] = version;
  await Bun.write(packageJsonPath, `${JSON.stringify(manifest, null, 2)}\n`);
}
