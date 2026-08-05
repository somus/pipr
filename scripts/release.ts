#!/usr/bin/env bun
import {
  type CommandResult,
  dogfoodRelease,
  type ReleaseOperations,
  resolveRelease,
  verifyReleaseTag,
} from "./release/workflow.js";

export const releaseSubcommands = ["resolve", "verify-tag", "dogfood"] as const;

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

  async log(message: string): Promise<void> {
    console.log(message);
  }
}

type ReleaseSubcommand = (typeof releaseSubcommands)[number];
type ReleaseCommand = (
  operations: ReleaseOperations,
  secretValues: readonly string[],
) => Promise<void>;

const releaseCommands: Record<ReleaseSubcommand, ReleaseCommand> = {
  dogfood: runDogfood,
  resolve: runResolve,
  "verify-tag": runVerifyTag,
};

async function main(args = process.argv.slice(2)): Promise<void> {
  const command = args[0];
  if (!isReleaseSubcommand(command)) {
    throw new Error(`usage: bun scripts/release.ts <resolve|verify-tag|dogfood>`);
  }
  const operations = new ProductionReleaseOperations();
  const secretValues = [
    Bun.env.GH_TOKEN,
    Bun.env.TURBO_API,
    Bun.env.TURBO_REMOTE_CACHE_SIGNATURE_KEY,
    Bun.env.TURBO_TOKEN,
  ].filter((value): value is string => Boolean(value));
  await releaseCommands[command](operations, secretValues);
}

async function runResolve(
  operations: ReleaseOperations,
  secretValues: readonly string[],
): Promise<void> {
  const eventName = requiredEnv("PIPR_EVENT_NAME");
  await resolveRelease(operations, {
    commitSubject: Bun.env.PIPR_COMMIT_SUBJECT?.split(/\r?\n/, 1)[0],
    eventMode: eventName === "workflow_dispatch" ? "manual" : "workflow-run",
    manualTag: Bun.env.PIPR_INPUT_TAG,
    repository: requiredEnv("GITHUB_REPOSITORY"),
    secretValues,
    workflowRunSha: Bun.env.PIPR_WORKFLOW_RUN_SHA,
  });
}

async function runVerifyTag(
  operations: ReleaseOperations,
  secretValues: readonly string[],
): Promise<void> {
  await verifyReleaseTag(operations, {
    secretValues,
    tag: requiredEnv("PIPR_RELEASE_TAG"),
  });
}

async function runDogfood(
  operations: ReleaseOperations,
  secretValues: readonly string[],
): Promise<void> {
  await dogfoodRelease(operations, {
    secretValues,
    version: requiredEnv("PIPR_RELEASE_VERSION"),
  });
}

function isReleaseSubcommand(command: string | undefined): command is ReleaseSubcommand {
  return releaseSubcommands.some((candidate) => candidate === command);
}

function requiredEnv(name: string): string {
  const value = Bun.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

if (import.meta.main) {
  await main();
}
