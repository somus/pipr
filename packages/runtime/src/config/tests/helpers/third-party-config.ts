import { mkdir } from "node:fs/promises";
import path from "node:path";

export async function writeThirdPartyPackageManifest(rootDir: string): Promise<void> {
  const configDir = path.join(rootDir, ".pipr");
  const dependencyDir = path.join(configDir, "fixtures", "config-dependency");
  await mkdir(dependencyDir, { recursive: true });
  await Bun.write(
    path.join(dependencyDir, "package.json"),
    `${JSON.stringify(
      {
        name: "pipr-config-dependency",
        version: "1.0.0",
        type: "module",
        exports: { ".": { types: "./index.d.ts", default: "./index.js" } },
      },
      null,
      2,
    )}\n`,
  );
  await Bun.write(
    path.join(dependencyDir, "index.js"),
    "export const splitValues = (values) => values.map((value) => [value]);\n",
  );
  await Bun.write(
    path.join(dependencyDir, "index.d.ts"),
    "export declare const splitValues: <T>(values: T[]) => T[][];\n",
  );
  await Bun.write(
    path.join(configDir, "package.json"),
    `${JSON.stringify(
      {
        private: true,
        dependencies: {
          "pipr-config-dependency": "file:./fixtures/config-dependency",
        },
      },
      null,
      2,
    )}\n`,
  );
}

export async function writeThirdPartyPiprProject(
  rootDir: string,
  options: { instructions?: string } = {},
): Promise<void> {
  await writeThirdPartyPackageManifest(rootDir);
  await Bun.write(
    path.join(rootDir, ".pipr", "config.ts"),
    [
      'import { definePipr } from "@usepipr/sdk";',
      'import { splitValues } from "pipr-config-dependency";',
      "",
      "export default definePipr((pipr) => {",
      "  void splitValues;",
      "  const model = pipr.model({",
      '    provider: "deepseek",',
      '    model: "deepseek-v4-pro",',
      '    apiKey: pipr.secret({ name: "DEEPSEEK_API_KEY" }),',
      "  });",
      "  pipr.review({",
      '    id: "review",',
      "    model,",
      `    instructions: { findings: ${JSON.stringify(options.instructions ?? "Review with deps.")}, summary: "Summarize this change." },`,
      "  });",
      "});",
    ].join("\n"),
  );
  const install = Bun.spawn(["bun", "install", "--ignore-scripts"], {
    cwd: path.join(rootDir, ".pipr"),
    env: process.env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const exitCode = await install.exited;
  if (exitCode !== 0) {
    throw new Error(await new Response(install.stderr).text());
  }
}
