#!/usr/bin/env bun
import * as core from "@actions/core";
import { PublicationError } from "@usepipr/runtime";
import { runMain } from "./runner.js";
import { sanitizeTerminalMessage } from "./terminal-output.js";

const env = process.env;

runMain({ env }).catch((error) => handleFatalError(error, env));

function handleFatalError(error: unknown, env: NodeJS.ProcessEnv): void {
  const message = error instanceof Error ? error.message : String(error);
  const sanitizedMessage = sanitizeTerminalMessage(message);
  if (!isGitHubActions(env)) {
    console.error(`error: ${sanitizedMessage}`);
    process.exit(1);
  }
  writeGitHubActionsFailure(error, sanitizedMessage);
  process.exitCode = 1;
}

function writeGitHubActionsFailure(error: unknown, message: string): void {
  if (error instanceof PublicationError && error.result) {
    core.setOutput("publication", JSON.stringify(error.result));
    core.error(`pipr publication metadata: ${JSON.stringify(error.result)}`);
  }
  core.setFailed(message);
}

function isGitHubActions(env: NodeJS.ProcessEnv): boolean {
  return env.GITHUB_ACTIONS === "true";
}
