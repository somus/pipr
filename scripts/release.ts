#!/usr/bin/env bun
import {
  type CommandResult,
  dogfoodRelease,
  type ReleaseOperations,
  resolveRelease,
  verifyReleaseTag,
} from "./release/workflow.js";

class ProductionReleaseOperations implements ReleaseOperations {
  async run(
    command: string,
    args: readonly string[],
    options?: { cwd?: string },
  ): Promise<CommandResult> {
    const process = Bun.spawn([command, ...args], {
      cwd: options?.cwd,
      env: Bun.env,
      stderr: "pipe",
      stdout: "pipe",
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      process.exited,
      new Response(process.stdout).text(),
      new Response(process.stderr).text(),
    ]);
    return { exitCode, stderr, stdout };
  }

  async read(file: string): Promise<string> {
    return await Bun.file(file).text();
  }

  async write(file: string, contents: string): Promise<void> {
    await Bun.write(file, contents);
  }

  async sleep(milliseconds: number): Promise<void> {
    await Bun.sleep(milliseconds);
  }

  async output(name: string, value: string): Promise<void> {
    const outputPath = requiredEnv("GITHUB_OUTPUT");
    const output = Bun.file(outputPath);
    await Bun.write(output, `${await output.text()}${name}=${value}\n`);
  }
}

export async function main(args = process.argv.slice(2)): Promise<void> {
  const command = args[0];
  const operations = new ProductionReleaseOperations();
  const secretValues = [
    Bun.env.GH_TOKEN,
    Bun.env.TURBO_REMOTE_CACHE_SIGNATURE_KEY,
    Bun.env.TURBO_TOKEN,
  ].filter((value): value is string => Boolean(value));

  if (command === "resolve") {
    const eventName = requiredEnv("PIPR_EVENT_NAME");
    await resolveRelease(operations, {
      commitSubject: Bun.env.PIPR_COMMIT_SUBJECT?.split(/\r?\n/, 1)[0],
      eventMode: eventName === "workflow_dispatch" ? "manual" : "workflow-run",
      manualTag: Bun.env.PIPR_INPUT_TAG,
      repository: requiredEnv("GITHUB_REPOSITORY"),
      secretValues,
      workflowRunSha: Bun.env.PIPR_WORKFLOW_RUN_SHA,
    });
    return;
  }

  if (command === "verify-tag") {
    await verifyReleaseTag(operations, {
      secretValues,
      tag: requiredEnv("PIPR_RELEASE_TAG"),
    });
    return;
  }

  if (command === "dogfood") {
    await dogfoodRelease(operations, {
      secretValues,
      version: requiredEnv("PIPR_RELEASE_VERSION"),
    });
    return;
  }

  throw new Error(`usage: bun scripts/release.ts <resolve|verify-tag|dogfood>`);
}

function requiredEnv(name: string): string {
  const value = Bun.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

if (import.meta.main) {
  await main();
}
