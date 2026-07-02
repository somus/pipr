import { mkdir } from "node:fs/promises";
import path from "node:path";

export async function writeThirdPartyPackageManifest(rootDir: string): Promise<void> {
  await mkdir(path.join(rootDir, ".pipr"), { recursive: true });
  await Bun.write(
    path.join(rootDir, ".pipr", "package.json"),
    `${JSON.stringify(
      {
        private: true,
        dependencies: {
          "@usepipr/sdk": "0.1.3",
          "lodash-es": "4.17.23",
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
      'import { chunk } from "lodash-es";',
      "",
      "export default definePipr((pipr) => {",
      "  void chunk;",
      "  const model = pipr.model({",
      '    provider: "deepseek",',
      '    model: "deepseek-v4-pro",',
      '    apiKey: pipr.secret({ name: "DEEPSEEK_API_KEY" }),',
      "  });",
      "  pipr.review({",
      '    id: "review",',
      "    model,",
      `    instructions: ${JSON.stringify(options.instructions ?? "Review with deps.")},`,
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
