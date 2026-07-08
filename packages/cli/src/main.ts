#!/usr/bin/env bun
import * as core from "@actions/core";
import { PublicationError } from "@usepipr/runtime";
import { runMain } from "./runner.js";

runMain().catch(handleFatalError);

function handleFatalError(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  if (!isGitHubActions()) {
    console.error(`error: ${message}`);
    process.exitCode = 1;
    return;
  }
  writeGitHubActionsFailure(error, message);
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
