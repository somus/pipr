import { describe, expect, it } from "bun:test";
import { cp, mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { installConfigDependencies } from "../config-deps.js";
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

    await expect(loadTypescriptConfig({ rootDir, typecheck: true })).resolves.toMatchObject({
      source: path.join(rootDir, ".pipr", "config.ts"),
    });
  });

  it("typechecks default scaffold config that uses Bun APIs through local config deps", async () => {
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

  it("resolves default lib files from the declared local .pipr TypeScript package", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "pipr-config-deps-"));
    await initOfficialMinimalProject({ rootDir, adapters: [] });
    const configDir = path.join(rootDir, ".pipr");
    const localPackageDir = path.join(configDir, "typescript-local");
    await cp(path.join(configDir, "node_modules", "typescript"), localPackageDir, {
      recursive: true,
    });
    const packageJsonPath = path.join(configDir, "package.json");
    const packageJson = JSON.parse(await Bun.file(packageJsonPath).text());
    packageJson.devDependencies.typescript = "file:./typescript-local";
    await Bun.write(packageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`);
    const localLibPath = path.join(localPackageDir, "lib", "lib.es2022.full.d.ts");
    const localLib = await Bun.file(localLibPath).text();
    await Bun.write(
      localLibPath,
      `${localLib}\ndeclare const __piprLocalTypeScriptLibSentinel: string;\n`,
    );
    await installPiprConfigDependencies(configDir);
    await writePiprConfig(
      rootDir,
      `import { definePipr } from "@usepipr/sdk";

export default definePipr((pipr) => {
  type LocalTypescriptSentinel = typeof __piprLocalTypeScriptLibSentinel;
  const sentinel = "ok" satisfies LocalTypescriptSentinel;
  const model = pipr.model({
    provider: "deepseek",
    model: "deepseek-v4-pro",
    apiKey: pipr.secret({ name: "DEEPSEEK_API_KEY" }),
  });
  pipr.review({
    id: "review",
    model,
    instructions: \`Review this change. Local TS lib sentinel: \${sentinel}\`,
  });
});
`,
    );

    await expect(loadTypescriptConfig({ rootDir, typecheck: true })).resolves.toMatchObject({
      source: path.join(rootDir, ".pipr", "config.ts"),
    });
  });

  it("does not execute stale TypeScript from original .pipr/node_modules", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "pipr-config-deps-"));
    await initOfficialMinimalProject({ rootDir, adapters: [] });
    const staleTypescriptDir = path.join(rootDir, ".pipr", "node_modules", "typescript");
    await rm(staleTypescriptDir, { recursive: true, force: true });
    await mkdir(path.join(staleTypescriptDir, "lib"), { recursive: true });
    await Bun.write(
      path.join(staleTypescriptDir, "package.json"),
      `${JSON.stringify({ name: "typescript", version: "0.0.0-stale" }, null, 2)}\n`,
    );
    await Bun.write(
      path.join(staleTypescriptDir, "lib", "typescript.js"),
      'throw new Error("stale local TypeScript executed");\n',
    );
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

  it("loads scaffold config that imports TypeScript from declared config deps", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "pipr-config-deps-"));
    await initOfficialMinimalProject({ rootDir, adapters: [] });
    await writePiprConfig(
      rootDir,
      `import { definePipr } from "@usepipr/sdk";
import * as ts from "typescript";

export default definePipr((pipr) => {
  const model = pipr.model({
    provider: "deepseek",
    model: "deepseek-v4-pro",
    apiKey: pipr.secret({ name: "DEEPSEEK_API_KEY" }),
  });
  pipr.review({
    id: "review",
    model,
    instructions: \`Review this change. TS target: \${ts.ScriptTarget.Latest}\`,
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
  it("uses no-verify only for default scaffold TypeScript installs", async () => {
    const originalSpawn = Bun.spawn;
    const commands: string[][] = [];
    Bun.spawn = ((command: string[]) => {
      commands.push(command);
      return {
        exited: Promise.resolve(0),
        stdout: new Response("").body,
        stderr: new Response("").body,
      } as unknown as ReturnType<typeof Bun.spawn>;
    }) as typeof Bun.spawn;
    try {
      const defaultConfigDir = await writePackageForInstallTest({
        devDependencies: { typescript: "6.0.3" },
      });
      await installConfigDependencies(defaultConfigDir, { frozen: true });

      const customConfigDir = await writePackageForInstallTest({
        devDependencies: { typescript: "file:./typescript-local" },
      });
      await installConfigDependencies(customConfigDir, { frozen: true });
    } finally {
      Bun.spawn = originalSpawn;
    }

    const installCommands = commands.filter((command) => command[1] === "install");
    expect(installCommands).toHaveLength(2);
    expect(installCommands[0]).toContain("--no-verify");
    expect(installCommands[0]).toContain("typescript@6.0.3");
    expect(installCommands[1]).not.toContain("--no-verify");
    expect(installCommands[1]).toContain("typescript@file:./typescript-local");
  });

  it("writes a typed SDK stub without running install for runtime-provided deps", async () => {
    const configDir = await mkdtemp(path.join(os.tmpdir(), "pipr-config-stub-"));
    await Bun.write(
      path.join(configDir, "package.json"),
      `${JSON.stringify(
        {
          private: true,
          dependencies: { "@usepipr/sdk": "0.3.3" },
          devDependencies: { "@types/bun": "1.3.14" },
        },
        null,
        2,
      )}\n`,
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

async function installPiprConfigDependencies(configDir: string): Promise<void> {
  const install = Bun.spawn(["bun", "install", "--ignore-scripts"], {
    cwd: configDir,
    env: process.env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stderr] = await Promise.all([
    install.exited,
    new Response(install.stderr).text(),
  ]);
  if (exitCode !== 0) {
    throw new Error(stderr);
  }
}

async function writePackageForInstallTest(manifest: {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}): Promise<string> {
  const configDir = await mkdtemp(path.join(os.tmpdir(), "pipr-config-install-"));
  await Bun.write(
    path.join(configDir, "package.json"),
    `${JSON.stringify({ private: true, ...manifest }, null, 2)}\n`,
  );
  await Bun.write(path.join(configDir, "bun.lock"), "");
  return configDir;
}
