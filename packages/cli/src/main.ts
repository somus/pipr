#!/usr/bin/env bun
import * as core from "@actions/core";
import { PublicationError } from "@usepipr/runtime";
import { runMain } from "./runner.js";

runMain().catch((error: unknown) => {
  if (error instanceof PublicationError && error.result) {
    core.setOutput("publication", JSON.stringify(error.result));
    core.error(`pipr publication metadata: ${JSON.stringify(error.result)}`);
  }
  const message = error instanceof Error ? error.message : String(error);
  core.setFailed(message);
  process.exitCode = 1;
});
