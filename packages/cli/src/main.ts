#!/usr/bin/env bun
import * as core from "@actions/core";
import { PublicationError } from "@usepipr/runtime";
import {
  presentGitHubActionError,
  presentGitHubActionPublicationError,
} from "@usepipr/runtime/internal/action-result";
import { runMain } from "./runner.js";
import { sanitizeTerminalMessage } from "./terminal-output.js";

const env = process.env;

runMain({ env }).catch((error) => handleFatalError(error, env));

async function handleFatalError(error: unknown, env: NodeJS.ProcessEnv): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  const sanitizedMessage = sanitizeTerminalMessage(message);
  if (env.GITHUB_ACTIONS !== "true") {
    console.error(`error: ${sanitizedMessage}`);
    process.exit(1);
  }
  await writeGitHubActionsFailure(error, sanitizedMessage);
  process.exitCode = 1;
}

async function writeGitHubActionsFailure(error: unknown, message: string): Promise<void> {
  const presenter = {
    info: core.info,
    warning: core.warning,
    setOutput: core.setOutput,
  };
  if (error instanceof PublicationError) {
    await presentGitHubActionPublicationError(error, presenter);
  } else {
    await presentGitHubActionError(presenter);
  }
  core.setFailed(message);
}
