#!/usr/bin/env bun
import * as core from "@actions/core";
import { PublicationError } from "@usepipr/runtime";
import { runMain } from "./runner.js";
import { sanitizeTerminalMessage } from "./terminal-output.js";

runMain().catch(handleFatalError);

function handleFatalError(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  const sanitizedMessage = sanitizeTerminalMessage(message);
  if (!isGitHubActions()) {
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

function isGitHubActions(): boolean {
  return process.env.GITHUB_ACTIONS === "true";
}
