import { describe, expect, it } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runtimeVersion } from "../../shared/version.js";
import { installConfigDependencies } from "../config-deps.js";
import { initOfficialMinimalProject } from "../init.js";
import { defaultTypesBunVersion, defaultTypescriptVersion } from "../scaffold-versions.js";
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

  it("rejects malformed local TypeScript packages", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "pipr-config-deps-"));
    await initOfficialMinimalProject({ rootDir, adapters: [] });
    const configDir = path.join(rootDir, ".pipr");
    const invalidPackageDir = path.join(configDir, "typescript-invalid");
    await mkdir(path.join(invalidPackageDir, "lib"), { recursive: true });
    await Bun.write(
      path.join(invalidPackageDir, "package.json"),
      `${JSON.stringify({ name: "typescript", version: "0.0.0-invalid" }, null, 2)}\n`,
    );
    await Bun.write(path.join(invalidPackageDir, "lib", "typescript.js"), "export default {};\n");
    const packageJsonPath = path.join(configDir, "package.json");
    const packageJson = JSON.parse(await Bun.file(packageJsonPath).text());
    packageJson.devDependencies.typescript = "file:./typescript-invalid";
    await Bun.write(packageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`);
    await installPiprConfigDependencies(configDir);

    await expect(loadTypescriptConfig({ rootDir, typecheck: true })).rejects.toThrow(
      "TypeScript module does not expose createProgram",
    );
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
  it("installs from a frozen verified projection without resolving runtime-provided deps", async () => {
    const originalSpawn = Bun.spawn;
    const observedInstalls: Array<{ command: string[]; packageJson: string; bunLock: string }> = [];
    const projectedBunLock = [
      "{",
      '  "lockfileVersion": 1,',
      '  "configVersion": 1,',
      '  "workspaces": {',
      '    "": {',
      '      "devDependencies": {',
      '        "typescript": "6.0.3",',
      "      },",
      "    },",
      "  },",
      '  "packages": {',
      '    "node_modules/typescript": ["typescript@6.0.3", "", {}, "sha512-typescript"],',
      "  }",
      "}",
      "",
    ].join("\n");
    Bun.spawn = interceptProjectedConfigInstalls(originalSpawn, observedInstalls, projectedBunLock);
    try {
      const configDir = await writePackageForInstallTest({
        dependencies: { "@usepipr/sdk": "999.0.0" },
        devDependencies: {
          "@types/bun": defaultTypesBunVersion,
          typescript: defaultTypescriptVersion,
        },
      });
      const originalPackageJson = await readFile(path.join(configDir, "package.json"), "utf8");
      const bunLock = [
        "{",
        '  "lockfileVersion": 1,',
        '  "configVersion": 1,',
        '  "workspaces": {',
        '    "": {',
        '      "dependencies": {',
        '        "@usepipr/sdk": "999.0.0",',
        "      },",
        '      "devDependencies": {',
        '        "@types/bun": "1.3.14",',
        '        "typescript": "6.0.3",',
        "      },",
        "    },",
        "  },",
        '  "packages": {',
        '    "@types/bun": ["@types/bun@1.3.14", "", {}, "sha512-test"],',
        "",
        '    "@usepipr/sdk": ["@usepipr/sdk@999.0.0", "", { "dependencies": { "zod": "4.4.3" } }, "sha512-test"],',
        "",
        '    "zod": ["zod@4.4.3", "", {}, "sha512-zod"],',
        "",
        '    "typescript": ["typescript@6.0.3", "", {}, "sha512-typescript"],',
        "  }",
        "}",
        "",
      ].join("\n");
      await Bun.write(path.join(configDir, "bun.lock"), bunLock);

      await installConfigDependencies(configDir);

      expect(observedInstalls).toHaveLength(2);
      const [projectionInstall, frozenInstall] = requireTwoConfigInstalls(observedInstalls);
      expect(projectionInstall.command).toContain("--lockfile-only");
      expect(projectionInstall.packageJson).not.toContain("@usepipr/sdk");
      expect(projectionInstall.packageJson).not.toContain("@types/bun");
      expect(projectionInstall.packageJson).toContain('"typescript": "6.0.3"');
      expect(projectionInstall.bunLock).toContain("@usepipr/sdk");
      expect(projectionInstall.bunLock).toContain("@types/bun");
      expect(frozenInstall.command).toContain("--frozen-lockfile");
      expect(frozenInstall.command).toContain("--ignore-scripts");
      expect(frozenInstall.command).toContain("--no-save");
      expect(frozenInstall.command).not.toContain("--no-verify");
      expect(frozenInstall.bunLock).not.toContain("@usepipr/sdk");
      expect(frozenInstall.bunLock).not.toContain("@types/bun");
      expect(frozenInstall.bunLock).not.toContain("zod");
      expect(frozenInstall.bunLock).toContain('"typescript": "6.0.3"');
      expect(await readFile(path.join(configDir, "package.json"), "utf8")).toBe(
        originalPackageJson,
      );
      expect(await readFile(path.join(configDir, "bun.lock"), "utf8")).toBe(bunLock);
    } finally {
      Bun.spawn = originalSpawn;
    }
  });

  it("rejects metadata-only and tuple-only projection changes before installing", async () => {
    const originalSpawn = Bun.spawn;
    const commands: string[][] = [];
    let projectedBunLock = "";
    Bun.spawn = ((...args: Parameters<typeof Bun.spawn>): ReturnType<typeof Bun.spawn> => {
      const command = commandFromSpawnArgs(args);
      const cwd = cwdFromSpawnArgs(args);
      if (command !== undefined) {
        commands.push(command);
      }
      if (command?.[0] === "bun" && command[1] === "install" && cwd) {
        if (command.includes("--lockfile-only")) {
          writeFileSync(path.join(cwd, "bun.lock"), projectedBunLock);
        }
        return originalSpawn(["bun", "--version"], {
          env: process.env,
          stdout: "pipe",
          stderr: "pipe",
        });
      }
      return originalSpawn(...args);
    }) as typeof Bun.spawn;
    try {
      const bunLock = [
        "{",
        '  "lockfileVersion": 1,',
        '  "configVersion": 1,',
        '  "workspaces": {',
        '    "": {',
        '      "dependencies": {',
        '        "@usepipr/sdk": "999.0.0",',
        "      },",
        '      "devDependencies": {',
        '        "typescript": "6.0.3",',
        "      },",
        "    },",
        "  },",
        '  "packages": {',
        '    "@usepipr/sdk": ["@usepipr/sdk@999.0.0", "", {}, "sha512-sdk"],',
        "",
        '    "typescript": ["typescript@6.0.3", "", {}, "sha512-typescript"],',
        "  }",
        "}",
        "",
      ].join("\n");
      const projectedBunLocks = [
        [
          "{",
          '  "lockfileVersion": 1,',
          '  "workspaces": {',
          '    "": {',
          '      "devDependencies": {',
          '        "typescript": "6.0.3",',
          "      },",
          "    },",
          "  },",
          '  "packages": {',
          '    "typescript": ["typescript@6.0.3", "", {}, "sha512-typescript"],',
          "  }",
          "}",
          "",
        ].join("\n"),
        [
          "{",
          '  "lockfileVersion": 1,',
          '  "configVersion": 1,',
          '  "workspaces": {',
          '    "": {',
          '      "devDependencies": {',
          '        "typescript": "6.0.4",',
          "      },",
          "    },",
          "  },",
          '  "packages": {',
          '    "typescript": ["typescript@6.0.3", "", {}, "sha512-typescript"],',
          "  }",
          "}",
          "",
        ].join("\n"),
        [
          "{",
          '  "lockfileVersion": 1,',
          '  "configVersion": 1,',
          '  "workspaces": {',
          '    "": {',
          '      "devDependencies": {',
          '        "typescript": "6.0.3",',
          "      },",
          "    },",
          "  },",
          '  "packages": {',
          '    "typescript": ["typescript@6.0.4", "", {}, "sha512-changed"],',
          "  }",
          "}",
          "",
        ].join("\n"),
      ];

      for (const [index, projection] of projectedBunLocks.entries()) {
        projectedBunLock = projection;
        const configDir = await writePackageForInstallTest({
          dependencies: { "@usepipr/sdk": "999.0.0" },
          devDependencies: { typescript: defaultTypescriptVersion },
        });
        await Bun.write(path.join(configDir, "bun.lock"), bunLock);

        await expect(installConfigDependencies(configDir)).rejects.toThrow(
          "projected bun.lock changed committed dependency data",
        );

        expect(commands.filter((command) => command[1] === "install")).toHaveLength(index + 1);
        expect(await readFile(path.join(configDir, "bun.lock"), "utf8")).toBe(bunLock);
      }
    } finally {
      Bun.spawn = originalSpawn;
    }
  });

  it("keeps frozen lockfile and integrity verification for every install", async () => {
    const originalSpawn = Bun.spawn;
    const commands: string[][] = [];
    Bun.spawn = interceptSpawnCommands(originalSpawn, commands);
    try {
      const defaultConfigDir = await writePackageForInstallTest({
        devDependencies: { typescript: defaultTypescriptVersion },
      });
      await installConfigDependencies(defaultConfigDir);

      const customConfigDir = await writePackageForInstallTest({
        devDependencies: { typescript: "file:./typescript-local" },
      });
      await installConfigDependencies(customConfigDir);
    } finally {
      Bun.spawn = originalSpawn;
    }

    const installCommands = commands.filter((command) => command[1] === "install");
    expect(installCommands).toHaveLength(2);
    for (const command of installCommands) {
      expect(command).toContain("--frozen-lockfile");
      expect(command).not.toContain("--no-verify");
    }
  });

  it("writes a typed SDK stub without running install for runtime-provided deps", async () => {
    const configDir = await mkdtemp(path.join(os.tmpdir(), "pipr-config-stub-"));
    await Bun.write(
      path.join(configDir, "package.json"),
      `${JSON.stringify(
        {
          private: true,
          dependencies: { "@usepipr/sdk": "0.3.3" },
          devDependencies: { "@types/bun": defaultTypesBunVersion },
        },
        null,
        2,
      )}\n`,
    );

    await prepareConfigDirectory(configDir);

    expect(
      await Bun.file(
        path.join(configDir, "node_modules", "@usepipr", "sdk", "index.d.ts"),
      ).exists(),
    ).toBe(true);
    expect(
      await Bun.file(path.join(configDir, "node_modules", "@usepipr", "sdk", "index.mjs")).exists(),
    ).toBe(true);
  });

  it("ignores malformed dependency maps when deciding whether install is required", async () => {
    const configDir = await mkdtemp(path.join(os.tmpdir(), "pipr-config-stub-"));
    await Bun.write(
      path.join(configDir, "package.json"),
      `${JSON.stringify({
        dependencies: "lodash-es",
        devDependencies: {
          "@usepipr/sdk": runtimeVersion,
          "not-a-version": 1,
        },
      })}\n`,
    );

    await expect(prepareConfigDirectory(configDir)).resolves.toBeUndefined();
    expect(
      await Bun.file(path.join(configDir, "node_modules", "@usepipr", "sdk", "index.mjs")).exists(),
    ).toBe(true);
  });
});

type ObservedConfigInstall = {
  command: string[];
  packageJson: string;
  bunLock: string;
};

function requireTwoConfigInstalls(
  installs: ObservedConfigInstall[],
): [ObservedConfigInstall, ObservedConfigInstall] {
  const first = installs[0];
  const second = installs[1];
  if (installs.length !== 2 || first === undefined || second === undefined) {
    throw new Error(`expected two config installs, received ${installs.length}`);
  }
  return [first, second];
}

function interceptProjectedConfigInstalls(
  originalSpawn: typeof Bun.spawn,
  observedInstalls: ObservedConfigInstall[],
  projectedBunLock: string,
): typeof Bun.spawn {
  return ((...args: Parameters<typeof Bun.spawn>): ReturnType<typeof Bun.spawn> => {
    const command = commandFromSpawnArgs(args);
    const cwd = cwdFromSpawnArgs(args);
    if (command?.[0] !== "bun" || command[1] !== "install" || cwd === undefined) {
      return originalSpawn(...args);
    }
    observedInstalls.push({
      command,
      packageJson: readFileSync(path.join(cwd, "package.json"), "utf8"),
      bunLock: readFileSync(path.join(cwd, "bun.lock"), "utf8"),
    });
    if (command.includes("--lockfile-only")) {
      writeFileSync(path.join(cwd, "bun.lock"), projectedBunLock);
    }
    return originalSpawn(["bun", "--version"], {
      env: process.env,
      stdout: "pipe",
      stderr: "pipe",
    });
  }) as typeof Bun.spawn;
}

function interceptSpawnCommands(
  originalSpawn: typeof Bun.spawn,
  commands: string[][],
): typeof Bun.spawn {
  return ((...args: Parameters<typeof Bun.spawn>): ReturnType<typeof Bun.spawn> => {
    const command = commandFromSpawnArgs(args);
    if (command !== undefined) {
      commands.push(command);
      if (command[0] === "bun" && command[1] === "install") {
        return originalSpawn(["bun", "--version"], {
          env: process.env,
          stdout: "pipe",
          stderr: "pipe",
        });
      }
    }
    return originalSpawn(...args);
  }) as typeof Bun.spawn;
}

function commandFromSpawnArgs(args: Parameters<typeof Bun.spawn>): string[] | undefined {
  const firstArg = args[0];
  if (isStringArray(firstArg)) {
    return firstArg;
  }
  if (firstArg !== null && typeof firstArg === "object" && "cmd" in firstArg) {
    const command = (firstArg as { cmd?: unknown }).cmd;
    return isStringArray(command) ? command : undefined;
  }
  return undefined;
}

function cwdFromSpawnArgs(args: Parameters<typeof Bun.spawn>): string | undefined {
  const options = args[1];
  if (options !== null && typeof options === "object" && "cwd" in options) {
    const cwd = (options as { cwd?: unknown }).cwd;
    return typeof cwd === "string" ? cwd : undefined;
  }
  return undefined;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((part) => typeof part === "string");
}

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
    devDependencies?: Record<string, string>;
  };
  manifest.dependencies = { "@usepipr/sdk": version };
  delete manifest.devDependencies;
  await Bun.write(packageJsonPath, `${JSON.stringify(manifest, null, 2)}\n`);
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
